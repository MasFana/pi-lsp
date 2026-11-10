import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileByteEdits, FileEdits, Position, PositionEncoding } from "./contracts.ts";

const MAX_FILES = 64, MAX_BYTES = 4 * 1024 * 1024, MAX_EDITS = 5000;
export interface ProposedFile {
    file: string; before: string; after: string; beforeHash: string; afterHash: string; mode: number; version?: number | null;
    receipt: { status: "pending" | "writing" | "applied"; updatedAt?: number; message?: string };
}
export interface Proposal {
    schema: 1; id: string; createdAt: number; expiresAt: number; workspace: string; conversationId: string; requesterId: string;
    provider: "lsp" | "ast"; action: string; title: string; files: ProposedFile[];
    server?: string;
    command?: { server: string; command: string; arguments?: unknown[] };
    commandReceipt?: { status: "pending" | "running" | "completed" | "interrupted"; message?: string };
}
export interface CreateProposalOptions {
    workspace: string; conversationId: string; requesterId: string; provider: "lsp" | "ast"; action: string; title: string;
    server?: string;
    fileEdits?: FileEdits[]; byteEdits?: FileByteEdits[]; originalHashes?: Record<string, string>;
    command?: Proposal["command"];
}
export interface ApplyResult {
    status: "applied" | "already_applied" | "partial" | "stale" | "interrupted" | "failed";
    changedFiles: string[];
    files: { file: string; status: string; message?: string }[];
    message?: string;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function contained(root: string, target: string) {
    const rel = relative(root, target);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel);
}
export async function canonicalFile(workspace: string, input: string): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(workspace)) throw new Error("Remote workspaces are unsupported");
    const root = realpathSync(resolve(workspace));
    const supplied = input.startsWith("file:") ? fileURLToPath(input) : input;
    if (!supplied || supplied.includes("\0")) throw new Error("Invalid source path");
    const lexical = resolve(root, supplied);
    if (!contained(root, lexical)) throw new Error("Source path is outside the workspace");
    const file = realpathSync(lexical);
    if (!contained(root, file)) throw new Error("Symlink target is outside the workspace");
    if (basename(file).toLowerCase().startsWith(".env") || basename(lexical).toLowerCase().startsWith(".env")) throw new Error("Environment files are excluded");
    if (!statSync(file).isFile()) throw new Error("Target is not a file");
    return file;
}
function source(file: string) {
    const data = readFileSync(file);
    if (data.length > MAX_BYTES) throw new Error("Source exceeds the proposal byte limit");
    const text = data.toString("utf8");
    if (!Buffer.from(text).equals(data)) throw new Error("Source must be valid UTF-8");
    return text;
}
function byteBoundary(data: Buffer, offset: number) {
    if (!Number.isInteger(offset) || offset < 0 || offset > data.length || offset < data.length && (data[offset]! & 0xc0) === 0x80) throw new Error("Invalid UTF-8 byte boundary");
}
function offset(text: string, position: Position, encoding: PositionEncoding): number {
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) throw new Error("Invalid edit position");
    let start = 0;
    for (let line = 0; line < position.line; line++) {
        const newline = text.indexOf("\n", start);
        if (newline < 0) throw new Error("Edit line is outside the file");
        start = newline + 1;
    }
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (end > start && text[end - 1] === "\r") end--;
    const line = text.slice(start, end);
    let units = position.character;
    if (encoding === "utf-8") {
        const bytes = Buffer.from(line);
        byteBoundary(bytes, units);
        units = bytes.subarray(0, units).toString("utf8").length;
    } else if (encoding === "utf-32") {
        let count = 0, index = 0;
        for (const char of line) { if (count === units) break; index += char.length; count++; }
        if (count !== units) throw new Error("Edit character is outside the line");
        units = index;
    } else if (encoding !== "utf-16") throw new Error("Unsupported position encoding");
    if (units > line.length || units > 0 && units < line.length && /[\uD800-\uDBFF]/.test(line[units - 1]!) && /[\uDC00-\uDFFF]/.test(line[units]!)) throw new Error("Edit character is not a valid boundary");
    return start + units;
}
function applyEdits(before: string, edits: { start: number; end: number; replacement: string }[]) {
    const sorted = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 0; index < sorted.length; index++) {
        const item = sorted[index]!;
        if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end < item.start || item.end > before.length || typeof item.replacement !== "string") throw new Error("Invalid edit range or replacement");
        if (Buffer.from(item.replacement).toString("utf8") !== item.replacement) throw new Error("Replacement must be valid Unicode");
        const previous = sorted[index - 1];
        if (previous && (item.start < previous.end || item.start === previous.start)) throw new Error("Overlapping or ambiguous edits");
    }
    let result = before;
    for (const item of sorted.toReversed()) result = result.slice(0, item.start) + item.replacement + result.slice(item.end);
    if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Replacement exceeds the proposal byte limit");
    return result;
}
export async function createProposal(options: CreateProposalOptions): Promise<Proposal> {
    const root = realpathSync(resolve(options.workspace));
    const grouped = new Map<string, { before: string; edits: { start: number; end: number; replacement: string }[]; version?: number | null }>();
    let count = 0, totalBytes = 0;
    const get = async (input: string, version?: number | null) => {
        const file = await canonicalFile(root, input);
        let row = grouped.get(file);
        if (!row) {
            const before = source(file);
            totalBytes += Buffer.byteLength(before);
            if (totalBytes > MAX_BYTES || grouped.size >= MAX_FILES) throw new Error("Proposal exceeds its file or byte limit");
            if (options.originalHashes?.[file] !== undefined && options.originalHashes[file] !== digest(before)) throw new Error("Source changed after provider preview");
            row = { before, edits: [], version };
            grouped.set(file, row);
        } else if (version !== undefined && row.version !== undefined && version !== row.version) throw new Error("Conflicting document versions");
        return row;
    };
    for (const entry of options.fileEdits ?? []) {
        const row = await get(entry.file, entry.version);
        for (const edit of entry.edits) {
            if (++count > MAX_EDITS) throw new Error("Proposal exceeds the edit limit");
            row.edits.push({ start: offset(row.before, edit.range.start, entry.encoding ?? "utf-16"), end: offset(row.before, edit.range.end, entry.encoding ?? "utf-16"), replacement: edit.newText });
        }
    }
    for (const entry of options.byteEdits ?? []) {
        const row = await get(entry.file);
        const bytes = Buffer.from(row.before);
        for (const edit of entry.edits) {
            if (++count > MAX_EDITS) throw new Error("Proposal exceeds the edit limit");
            byteBoundary(bytes, edit.start); byteBoundary(bytes, edit.end);
            row.edits.push({ start: bytes.subarray(0, edit.start).toString("utf8").length, end: bytes.subarray(0, edit.end).toString("utf8").length, replacement: edit.replacement });
        }
    }
    const files: ProposedFile[] = [];
    let afterBytes = 0;
    for (const [file, row] of grouped) {
        const after = applyEdits(row.before, row.edits);
        afterBytes += Buffer.byteLength(after);
        if (afterBytes > MAX_BYTES) throw new Error("Proposal exceeds the replacement byte limit");
        if (after !== row.before) files.push({ file, before: row.before, after, beforeHash: digest(row.before), afterHash: digest(after), mode: statSync(file).mode & 0o777, version: row.version, receipt: { status: "pending" } });
    }
    if (!files.length && !options.command) throw Object.assign(new Error("Proposal contains no changes"), { code: "NO_CHANGES" });
    const now = Date.now();
    return { schema: 1, id: randomUUID(), createdAt: now, expiresAt: now + 60 * 60 * 1000, workspace: root, conversationId: options.conversationId, requesterId: options.requesterId, provider: options.provider, action: options.action, title: options.title.slice(0, 300), server: options.server, files, command: options.command, commandReceipt: options.command ? { status: "pending" } : undefined };
}
const locks = new Map<string, Promise<void>>();
export async function applyProposal(proposal: Proposal, options: { assertOwner(): void; save(proposal: Proposal): Promise<void>; signal?: AbortSignal; getVersion?(file: string): number | undefined }): Promise<ApplyResult> {
    const root = proposal.workspace;
    const previous = locks.get(root) ?? Promise.resolve();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const own = previous.catch(() => {}).then(() => released);
    locks.set(root, own);
    await previous.catch(() => {});
    const changed = new Set<string>();
    const outcomes: ApplyResult["files"] = [];
    let writing = false;
    const check = () => { options.signal?.throwIfAborted(); options.assertOwner(); };
    const validate = async (file: ProposedFile) => {
        check();
        const canonical = await canonicalFile(root, file.file);
        check();
        if (canonical !== file.file) throw new Error("Proposal path changed");
        const current = digest(source(file.file));
        if (current === file.afterHash && file.receipt.status !== "pending") return "applied" as const;
        if (current !== file.beforeHash) throw new Error(`Stale content: ${basename(file.file)}`);
        const version = file.version != null ? options.getVersion?.(file.file) : undefined;
        if (file.version != null && version !== undefined && version !== file.version) throw new Error(`Stale document version: ${basename(file.file)}`);
        return "pending" as const;
    };
    try {
        check();
        if (proposal.schema !== 1 || proposal.files.length > MAX_FILES || Date.now() > proposal.expiresAt) throw new Error("Proposal is invalid or expired");
        if (proposal.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.before) + Buffer.byteLength(file.after), 0) > MAX_BYTES * 2) throw new Error("Proposal exceeds its stored byte limit");
        for (const file of proposal.files) if (digest(file.before) !== file.beforeHash || digest(file.after) !== file.afterHash) throw new Error("Proposal contents no longer match their hashes");
        if (realpathSync(root) !== root) throw new Error("Workspace path changed");
        for (const file of proposal.files) await validate(file);
        for (const file of proposal.files) {
            const state = await validate(file);
            if (state === "applied") { changed.add(file.file); outcomes.push({ file: file.file, status: "already_applied" }); continue; }
            file.receipt = { status: "writing", updatedAt: Date.now() };
            await options.save(proposal);
            check();
            await validate(file);
            check();
            const parent = dirname(file.file), parentIdentity = statSync(parent);
            const temporary = join(parent, `.${basename(file.file)}.pi-lsp-${randomUUID()}`);
            let fd: number | undefined;
            try {
                fd = openSync(temporary, "wx", file.mode);
                writeFileSync(fd, file.after, "utf8");
                fsyncSync(fd);
                chmodSync(temporary, file.mode);
                closeSync(fd); fd = undefined;
                check();
                if (realpathSync(file.file) !== file.file || lstatSync(file.file).isSymbolicLink() || digest(source(file.file)) !== file.beforeHash) throw new Error("Source changed immediately before apply");
                const currentParent = statSync(parent);
                if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) throw new Error("Source directory changed during apply");
                renameSync(temporary, file.file);
                writing = true;
                changed.add(file.file);
                outcomes.push({ file: file.file, status: "applied" });
            } finally {
                if (fd !== undefined) closeSync(fd);
                try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }
            file.receipt = { status: "applied", updatedAt: Date.now() };
            await options.save(proposal);
        }
        return { status: writing ? "applied" : "already_applied", changedFiles: [...changed], files: outcomes };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: changed.size ? "partial" : options.signal?.aborted ? "interrupted" : /[Ss]tale|changed|expired/.test(message) ? "stale" : "failed", changedFiles: [...changed], files: [...outcomes, ...proposal.files.filter((file) => !outcomes.some((item) => item.file === file.file)).map((file) => ({ file: file.file, status: "not_applied", message }))], message };
    } finally { release(); if (locks.get(root) === own) locks.delete(root); }
}
export function summarizeProposal(proposal: Proposal) {
    return { id: proposal.id, title: proposal.title, provider: proposal.provider, action: proposal.action, changedFiles: proposal.files.map((file) => file.file), hasCommand: !!proposal.command, command: proposal.command ? { server: proposal.command.server, command: proposal.command.command } : undefined, expiresAt: proposal.expiresAt,
        diffs: proposal.files.slice(0, 20).map((file) => {
            const before = file.before.split("\n"), after = file.after.split("\n");
            let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
            let oldEnd = before.length, newEnd = after.length;
            while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
            const removed = before.slice(Math.max(0, start - 2), Math.min(before.length, oldEnd + 2)).map((line) => `-${line}`);
            const added = after.slice(Math.max(0, start - 2), Math.min(after.length, newEnd + 2)).map((line) => `+${line}`);
            const diff = `@@ line ${start + 1} @@\n${[...removed, ...added].join("\n")}`;
            return { file: file.file, diff: diff.slice(0, 4000), truncated: diff.length > 4000 };
        }) };
}
