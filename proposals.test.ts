import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { applyProposal, createProposal, type Proposal } from "./pi-lsp/v1.3.2/proposals.ts";

async function fixture(run: (root: string, file: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "fana-proposal-test-"));
    try { const file = join(root, "source.ts"); await writeFile(file, "const café = '🦀';\r\n"); await run(root, file); }
    finally { await rm(root, { recursive: true, force: true }); }
}
const options = (root: string) => ({ workspace: root, conversationId: "conversation", requesterId: "owner", provider: "ast" as const, action: "rewrite_preview", title: "Change source" });
const save = async (_proposal: Proposal) => {};

test("proposals preserve UTF-8/UTF-16 boundaries, CRLF and source mode", async () => fixture(async (root, file) => {
    const before = await readFile(file, "utf8");
    const mode = (await stat(file)).mode & 0o777;
    const proposal = await createProposal({ ...options(root), fileEdits: [{ file, encoding: "utf-16", edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "price" }] }] });
    assert.equal(await readFile(file, "utf8"), before);
    const result = await applyProposal(proposal, { assertOwner() {}, save });
    assert.equal(result.status, "applied");
    assert.equal(await readFile(file, "utf8"), "const price = '🦀';\r\n");
    assert.equal((await stat(file)).mode & 0o777, mode);
}));

test("byte edits can delete a Unicode node without splitting its code points", async () => fixture(async (root, file) => {
    const before = await readFile(file);
    const start = before.indexOf(Buffer.from("🦀"));
    const proposal = await createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start, end: start + 4, replacement: "" }] }] });
    await applyProposal(proposal, { assertOwner() {}, save });
    assert.equal(await readFile(file, "utf8"), "const café = '';\r\n");
    await assert.rejects(createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start: 10, end: 11, replacement: "x" }] }] }), /boundary/);
}));

test("snapshot drift and overlapping edits are rejected before writes", async () => fixture(async (root, file) => {
    const before = await readFile(file, "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    await writeFile(file, before + "// edited elsewhere\n");
    await assert.rejects(createProposal({ ...options(root), originalHashes: { [file]: hash }, byteEdits: [{ file, edits: [{ start: 0, end: 5, replacement: "let" }] }] }), /changed/);
    await assert.rejects(createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start: 0, end: 5, replacement: "let" }, { start: 2, end: 6, replacement: "x" }] }] }), /Overlapping/);
    assert.equal(await readFile(file, "utf8"), before + "// edited elsewhere\n");
}));

test("stale multi-file preflight leaves every file unchanged", async () => fixture(async (root, file) => {
    const other = join(root, "other.ts"); await writeFile(other, "const other = 1;\n");
    const proposal = await createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start: 0, end: 5, replacement: "let" }] }, { file: other, edits: [{ start: 0, end: 5, replacement: "let" }] }] });
    await writeFile(other, "const other = 2;\n");
    const result = await applyProposal(proposal, { assertOwner() {}, save });
    assert.equal(result.status, "stale");
    assert.deepEqual(result.changedFiles, []);
    assert.equal(await readFile(file, "utf8"), "const café = '🦀';\r\n");
    assert.equal(await readFile(other, "utf8"), "const other = 2;\n");
}));

test("workspace symlink escapes and environment files cannot become proposals", async () => fixture(async (root, file) => {
    const outside = await mkdtemp(join(tmpdir(), "fana-outside-"));
    try {
        const secret = join(outside, "private.ts"); await writeFile(secret, "secret\n");
        await symlink(secret, join(root, "alias.ts"));
        await assert.rejects(createProposal({ ...options(root), byteEdits: [{ file: join(root, "alias.ts"), edits: [{ start: 0, end: 6, replacement: "changed" }] }] }), /outside/);
        const env = join(root, ".env.local"); await writeFile(env, "TOKEN=value");
        await assert.rejects(createProposal({ ...options(root), byteEdits: [{ file: env, edits: [{ start: 0, end: 5, replacement: "OTHER" }] }] }), /Environment/);
        assert.equal(await readFile(secret, "utf8"), "secret\n");
    } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("interruption after durable intent is recoverable without repeating a completed write", async () => fixture(async (root, file) => {
    const proposal = await createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start: 0, end: 5, replacement: "let" }] }] });
    const abort = new AbortController(); let durable: Proposal | undefined;
    const result = await applyProposal(proposal, { assertOwner() {}, signal: abort.signal, save: async (value) => { durable = JSON.parse(JSON.stringify(value)); abort.abort(); } });
    assert.equal(result.status, "interrupted");
    assert.equal(await readFile(file, "utf8"), "const café = '🦀';\r\n");
    assert.ok(durable);
    const applied = await applyProposal(durable, { assertOwner() {}, save });
    assert.equal(applied.status, "applied");
    assert.equal(await readFile(file, "utf8"), "let café = '🦀';\r\n");
    const again = await applyProposal(durable, { assertOwner() {}, save });
    assert.equal(again.status, "already_applied");
}));

test("role and version changes block writes; limits reject oversized replacement", async () => fixture(async (root, file) => {
    const proposal = await createProposal({ ...options(root), fileEdits: [{ file, version: 2, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "let" }] }] });
    const stale = await applyProposal(proposal, { assertOwner() {}, save, getVersion: () => 3 });
    assert.equal(stale.status, "stale");
    let owner = true;
    const revoked = await applyProposal(proposal, { assertOwner() { if (!owner) throw new Error("Owner role revoked"); }, save: async () => { owner = false; }, getVersion: () => 2 });
    assert.equal(revoked.status, "failed");
    assert.equal(await readFile(file, "utf8"), "const café = '🦀';\r\n");
    await assert.rejects(createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start: 0, end: 0, replacement: "x".repeat(4 * 1024 * 1024 + 1) }] }] }), /byte limit/);
}));

test("receipt persistence failure cannot claim an already-written file was not applied", async () => fixture(async (root, file) => {
    const proposal = await createProposal({ ...options(root), byteEdits: [{ file, edits: [{ start: 0, end: 5, replacement: "let" }] }] });
    let saves = 0;
    const result = await applyProposal(proposal, { assertOwner() {}, save: async () => { if (++saves === 2) throw new Error("Storage unavailable after write"); } });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.changedFiles, [file]);
    assert.equal(result.files[0]?.status, "applied");
    assert.equal(await readFile(file, "utf8"), "let café = '🦀';\r\n");
}));
