import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { AstProvider } from "./pi-lsp/v1.3.0/ast.ts";
import { createProcessRunner } from "./pi-lsp/v1.3.0/process.ts";
import { createProposal, applyProposal } from "./pi-lsp/v1.3.0/proposals.ts";
const find = (command: string) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command)).find((path) => existsSync(path));
const binary = find("ast-grep");
async function fixture(run: (root: string, file: string, ast: AstProvider) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "fana-ast-test-"));
    const runner = createProcessRunner();
    try {
        const file = join(root, "sample.ts"); await writeFile(file, "// 🦀 café\nvar value = 1;\nconsole.log(value);\n");
        const ast = new AstProvider({ run: runner.run, findExecutable: (name) => name === "ast-grep" ? binary : undefined, assertOwner() {} });
        await run(root, file, ast);
    } finally { await runner.dispose(); await rm(root, { recursive: true, force: true }); }
}
test("real AST search and outline return bounded structural records", { skip: !binary }, async () => fixture(async (root, file, ast) => {
    const search = await ast.query(root, { action: "search", paths: [file], pattern: "console.log($ARG)", lang: "typescript" });
    assert.equal(search.status, "ok", search.message);
    assert.equal(search.items?.length, 1);
    assert.match(JSON.stringify(search.items), /console.log/);
    await writeFile(file, "export function add(value: number) { return value + 1; }\n");
    const outline = await ast.query(root, { action: "outline", paths: [file] });
    assert.equal(outline.status, "ok", outline.message);
    assert.match(JSON.stringify(outline.items), /add/);
}));
test("sequential AST preview supports empty deletion without touching project files", { skip: !binary }, async () => fixture(async (root, file, ast) => {
    const before = await readFile(file, "utf8");
    const preview = await ast.query(root, { action: "rewrite_preview", paths: [file], lang: "typescript", ops: [{ pat: "var $X", out: "" }] });
    assert.equal(preview.status, "ok", preview.message);
    assert.equal(await readFile(file, "utf8"), before);
    const proposal = await createProposal({ workspace: root, requesterId: "owner", conversationId: "source", provider: "ast", action: "rewrite_preview", title: "Delete declaration", byteEdits: preview.byteEdits, originalHashes: preview.originalHashes as Record<string, string> });
    const applied = await applyProposal(proposal, { assertOwner() {}, save: async () => {} });
    assert.equal(applied.status, "applied");
    assert.equal(await readFile(file, "utf8"), "// 🦀 café\n\nconsole.log(value);\n");
}));
test("AST scope, count limits and disabled project parser configuration are enforced", { skip: !binary }, async () => fixture(async (root, file, ast) => {
    await writeFile(join(root, "sgconfig.yml"), "customLanguages:\n  evil:\n    libraryPath: ./does-not-exist.so\n");
    const search = await ast.query(root, { action: "search", paths: [file], pattern: "console.log($ARG)" });
    assert.equal(search.status, "ok", search.message);
    const relational = await ast.query(root, { action: "search", paths: [file], lang: "typescript", rule: "rule:\n  pattern: console.log($ARG)\n  inside:\n    kind: expression_statement\n    stopBy: end\n" });
    assert.equal(relational.status, "ok", relational.message);
    assert.match(JSON.stringify(relational.items), /console.log/);
    const outside = await mkdtemp(join(tmpdir(), "fana-ast-outside-"));
    try {
        const target = join(outside, "secret.ts"); await writeFile(target, "const secret = 1;\n"); await symlink(target, join(root, "alias.ts"));
        const escaped = await ast.query(root, { action: "search", paths: [join(root, "alias.ts")], pattern: "$X" });
        assert.equal(escaped.status, "unavailable"); assert.match(escaped.message ?? "", /escapes/);
        await writeFile(file, "console.log(1); console.log(2);\n");
        const limited = await ast.query(root, { action: "rewrite_preview", paths: [file], ops: [{ pat: "console.log($X)", out: "log($X)" }], maxReplacements: 1 });
        assert.equal(limited.status, "unavailable"); assert.match(limited.message ?? "", /maxReplacements/);
        assert.equal(await readFile(file, "utf8"), "console.log(1); console.log(2);\n");
    } finally { await rm(outside, { recursive: true, force: true }); }
}));
