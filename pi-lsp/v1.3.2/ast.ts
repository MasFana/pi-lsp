import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, opendir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AstQuery, ByteEdit, ExecutionResult, FileByteEdits, ProviderQueryResult, ProviderRuntime, ProviderStatus } from "./contracts.ts";

const FILE_BYTES = 1024 * 1024;
const SNAPSHOT_BYTES = 4 * FILE_BYTES;
const OUTPUT_BYTES = 2 * FILE_BYTES;
const ARGUMENT_BYTES = 24 * 1024;
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "coverage", "target"]);
const LANGUAGES: Record<string, string> = {
    bash: "Bash", c: "C", cc: "Cpp", "c++": "Cpp", cpp: "Cpp", cxx: "Cpp", cs: "CSharp", csharp: "CSharp",
    css: "Css", ex: "Elixir", elixir: "Elixir", go: "Go", golang: "Go", hs: "Haskell", haskell: "Haskell", hcl: "Hcl",
    html: "Html", java: "Java", javascript: "JavaScript", js: "JavaScript", jsx: "JavaScript", json: "Json",
    kotlin: "Kotlin", kt: "Kotlin", lua: "Lua", markdown: "Markdown", md: "Markdown", nix: "Nix", php: "Php",
    py: "Python", python: "Python", rb: "Ruby", ruby: "Ruby", rs: "Rust", rust: "Rust", scala: "Scala",
    solidity: "Solidity", sol: "Solidity", swift: "Swift", ts: "TypeScript", typescript: "TypeScript", tsx: "Tsx",
    yaml: "Yaml", yml: "Yaml", zig: "Zig",
};
const EXTENSIONS: Record<string, string> = {};
for (const [language, extensions] of Object.entries({
    Bash: "bash bats cgi command fcgi ksh sh tmux tool zsh", C: "c h", Cpp: "cc hpp cpp c++ hh cxx cu ino",
    CSharp: "cs", Css: "css", Elixir: "ex exs", Go: "go", Haskell: "hs", Hcl: "hcl", Html: "html htm xhtml",
    Java: "java", JavaScript: "cjs js mjs jsx", Json: "json", Kotlin: "kt ktm kts", Lua: "lua", Markdown: "markdown md",
    Nix: "nix", Php: "php", Python: "py py3 pyi bzl", Ruby: "rb rbw gemspec", Rust: "rs", Scala: "scala sc sbt",
    Solidity: "sol", Swift: "swift", TypeScript: "ts cts mts", Tsx: "tsx", Yaml: "yml yaml", Zig: "zig",
})) for (const extension of extensions.split(" ")) EXTENSIONS[`.${extension}`] = language;

type JsonObject = Record<string, unknown>;
interface Snapshot { file: string; scratch: string; original: Buffer; current: Buffer; language: string }
class Unsupported extends Error {}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const contains = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;
const languageOf = (path: string) => path.endsWith(".sh.in") ? "Bash" : EXTENSIONS[extname(path).toLowerCase()];
const secret = (path: string) => basename(path).toLowerCase().startsWith(".env") || path.split(sep).some((part) => part === ".git");
function integer(value: unknown, fallback: number, upper: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > upper) throw new Error(`${name} must be an integer from 1 to ${upper}`);
    return value as number;
}
function text(value: unknown, name: string, empty = false): asserts value is string {
    if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || Buffer.byteLength(value) > 16 * 1024) throw new Error(`${name} must be ${empty ? "a" : "a nonempty"} string of at most 16384 UTF-8 bytes without NUL`);
}
function validate(args: AstQuery) {
    if (!args || !["search", "outline", "rewrite_preview"].includes(args.action)) throw new Error("Unsupported AST action");
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 64) throw new Error("Provide 1–64 explicit local paths");
    for (const path of args.paths) { text(path, "path"); if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) throw new Error("Only local filesystem paths are supported"); }
    if (args.lang !== undefined) { text(args.lang, "lang"); if (!LANGUAGES[args.lang.toLowerCase()]) throw new Unsupported(`Unsupported standard grammar: ${args.lang}; project configuration and native custom parsers are disabled`); }
    if (args.action === "search") {
        if ((args.pattern !== undefined) === (args.rule !== undefined)) throw new Error("Search requires exactly one of pattern or inline YAML rule");
        text(args.pattern ?? args.rule, "pattern/rule");
        if (args.ops !== undefined) throw new Error("Search does not accept rewrite operations");
    } else if (args.action === "rewrite_preview") {
        if (args.pattern !== undefined || args.rule !== undefined) throw new Error("Rewrite preview uses ops, not search pattern/rule");
        if (!Array.isArray(args.ops) || !args.ops.length || args.ops.length > 20) throw new Error("Rewrite preview requires 1–20 sequential operations");
        for (const op of args.ops) { if (!op) throw new Error("Invalid rewrite operation"); text(op.pat, "ops.pat"); text(op.out, "ops.out", true); }
    } else if (args.pattern !== undefined || args.rule !== undefined || args.ops !== undefined) throw new Error("Outline does not accept search or rewrite fields");
    return { maxFiles: integer(args.maxFiles, 32, 64, "maxFiles"), maxResults: integer(args.maxResults, 50, 200, "maxResults"), maxReplacements: integer(args.maxReplacements, 200, 5000, "maxReplacements") };
}
function objects(result: ExecutionResult): JsonObject[] {
    if (result.truncated) throw new Error("AST output is incomplete; no result or proposal was accepted");
    if (result.exitCode !== 0 && result.exitCode !== 1) {
        const message = result.stderr.trim() || `ast-grep exited with code ${result.exitCode}`;
        if (/unsupported language|invalid value .*lang|unknown language|not supported/i.test(message)) throw new Unsupported(message.slice(0, 2000));
        throw new Error(message.slice(0, 2000));
    }
    if (!result.stdout.trim()) {
        if (result.exitCode !== 0 || result.stderr.trim()) throw new Error(result.stderr.trim() || "AST process failed without structured output");
        return [];
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("AST returned invalid JSON; no partial output was accepted"); }
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("AST returned an unsupported JSON result shape");
    return parsed as JsonObject[];
}
function span(value: unknown, bytes: Buffer): { start: number; end: number } {
    const range = value as { start?: unknown; end?: unknown } | undefined;
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) throw new Error("AST returned invalid UTF-8 byte offsets");
    const start = range.start as number, end = range.end as number;
    if (start < 0 || end < start || end > bytes.length || continuation(bytes[start]) || continuation(bytes[end])) throw new Error("AST byte offsets exceed the snapshot or split a UTF-8 character");
    return { start, end };
}
function finalEdit(original: Buffer, current: Buffer): ByteEdit | undefined {
    if (original.equals(current)) return undefined;
    let start = 0;
    while (start < original.length && start < current.length && original[start] === current[start]) start++;
    while (start > 0 && (continuation(original[start]) || continuation(current[start]))) start--;
    let end = original.length, finalEnd = current.length;
    while (end > start && finalEnd > start && original[end - 1] === current[finalEnd - 1]) { end--; finalEnd--; }
    while (continuation(original[end]) || continuation(current[finalEnd])) { end++; finalEnd++; }
    return { start, end, replacement: current.subarray(start, finalEnd).toString("utf8") };
}

/** One verified CLI provider. It never loads project config, installs software, or writes project sources. */
export class AstProvider {
    private readonly statuses = new Map<string, ProviderStatus>();
    private readonly runtime: ProviderRuntime;
    constructor(runtime: ProviderRuntime) { this.runtime = runtime; }

    cachedStatus(cwd: string): ProviderStatus {
        const status = this.statuses.get(resolve(cwd));
        return status ? { ...status, actions: [...status.actions] } : { id: "ast-grep", available: false, actions: [], configuration: "disabled", parserPolicy: "bundled standard grammars only", error: "Provider detection is pending" };
    }

    async probe(cwd: string, signal?: AbortSignal): Promise<ProviderStatus> {
        this.runtime.assertOwner();
        signal?.throwIfAborted();
        const failures: string[] = [];
        for (const command of ["ast-grep", "sg"]) {
            const executable = this.runtime.findExecutable(command, cwd);
            if (!executable) continue;
            try {
                const versionResult = await this.runtime.run(executable, ["--version"], { cwd, signal, timeout: 5000, maxBytes: 16 * 1024 });
                const version = /^ast-grep (\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?\s*$/.exec(versionResult.stdout);
                if (versionResult.exitCode !== 0 || versionResult.truncated || !version) throw new Error(`${command} is not a verified ast-grep binary (Unix sg may be a group switcher)`);
                const compatible = Number(version[1]) > 0 || Number(version[2]) >= 44;
                if (!compatible) {
                    const status: ProviderStatus = { id: "ast-grep", available: true, compatible: false, executable, version: version[0].trim().slice(9), provenance: "verified CLI version identity", actions: [], checkedAt: Date.now(), configuration: "disabled", parserPolicy: "bundled standard grammars only", error: "ast-grep >=0.44.0 stable with outline support is required" };
                    this.statuses.set(resolve(cwd), status);
                    return this.cachedStatus(cwd);
                }
                for (const action of ["run", "scan", "outline"]) {
                    const help = await this.runtime.run(executable, [action, "--help"], { cwd, signal, timeout: 5000, maxBytes: 64 * 1024 });
                    if (help.exitCode !== 0 || help.truncated || !help.stdout.includes(` ${action} `) || !help.stdout.includes("--json") || !help.stdout.includes("--config") || (action === "scan" && !help.stdout.includes("--inline-rules"))) throw new Error(`Verified ast-grep does not support the required ${action} CLI contract`);
                }
                const status: ProviderStatus = { id: "ast-grep", available: true, compatible: true, executable, version: version[0].trim().slice(9), provenance: "verified CLI identity and action help", actions: ["search", "outline", "rewrite_preview"], checkedAt: Date.now(), configuration: "disabled", parserPolicy: "bundled standard grammars only" };
                this.statuses.set(resolve(cwd), status);
                return this.cachedStatus(cwd);
            } catch (error) { signal?.throwIfAborted(); failures.push(messageOf(error)); }
        }
        this.statuses.set(resolve(cwd), { id: "ast-grep", available: false, compatible: false, actions: [], checkedAt: Date.now(), configuration: "disabled", parserPolicy: "bundled standard grammars only", error: failures.join("; ") || "ast-grep executable not found; use lsp_manage to install it for the task" });
        return this.cachedStatus(cwd);
    }

    private async snapshots(cwd: string, paths: string[], scratch: string, maxFiles: number, signal?: AbortSignal): Promise<Snapshot[]> {
        const root = await realpath(resolve(cwd));
        if (!(await stat(root)).isDirectory()) throw new Error("Workspace must be a local directory");
        const files = new Set<string>(), directories = new Set<string>();
        let entries = 0, bytes = 0;
        const visit = async (input: string, depth: number, explicit: boolean): Promise<void> => {
            signal?.throwIfAborted();
            if (++entries > 4096 || depth > 16) throw new Error("AST path enumeration exceeded 4096 entries or depth 16; narrow explicit paths");
            if (!contains(root, input)) throw new Error(`Path escapes the authorized workspace: ${input}`);
            if (secret(input)) { if (explicit) throw new Error("Secret .env files and .git metadata are excluded"); return; }
            const canonical = await realpath(input);
            if (!contains(root, canonical)) throw new Error(`Symlink escapes the authorized workspace: ${input}`);
            if (secret(canonical)) { if (explicit) throw new Error("Secret .env files and .git metadata are excluded"); return; }
            const metadata = await stat(canonical);
            if (metadata.isDirectory()) {
                if (directories.has(canonical)) return;
                directories.add(canonical);
                if (directories.size > 512) throw new Error("AST directory limit exceeded; narrow explicit paths");
                const directory = await opendir(canonical);
                try {
                    for await (const entry of directory) {
                        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) { if (++entries > 4096) throw new Error("AST path enumeration limit exceeded"); continue; }
                        await visit(join(canonical, entry.name), depth + 1, false);
                    }
                } finally { await directory.close().catch(() => {}); }
            } else if (metadata.isFile()) {
                if (!languageOf(canonical)) { if (explicit) throw new Unsupported(`Not a supported standard-grammar source file: ${input}`); return; }
                files.add(canonical);
                if (files.size > maxFiles) throw new Error(`AST maxFiles ${maxFiles} exceeded; narrow explicit paths`);
            } else if (explicit) throw new Error("AST paths must identify regular source files or directories");
        };
        for (const path of paths) await visit(resolve(root, path), 0, true);
        const snapshots: Snapshot[] = [];
        for (const file of files) {
            signal?.throwIfAborted();
            const descriptor = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let original: Buffer;
            try {
                const metadata = await descriptor.stat();
                if (!metadata.isFile() || metadata.size > FILE_BYTES) throw new Error(`Source file exceeds ${FILE_BYTES} bytes or is not regular: ${file}`);
                if (await realpath(file) !== file) throw new Error("Source path changed during snapshot");
                original = await descriptor.readFile();
                if (await realpath(file) !== file) throw new Error("Source path changed during snapshot");
            } finally { await descriptor.close(); }
            bytes += original.length;
            if (original.length > FILE_BYTES || bytes > SNAPSHOT_BYTES) throw new Error("AST snapshot byte limit exceeded; narrow explicit paths");
            try { new TextDecoder("utf-8", { fatal: true }).decode(original); } catch { throw new Unsupported(`Source file is not valid UTF-8: ${file}`); }
            if (original.includes(0)) throw new Unsupported(`Binary source files are not supported: ${file}`);
            const target = join(scratch, `${snapshots.length}${file.endsWith(".sh.in") ? ".sh" : extname(file)}`);
            await writeFile(target, original, { mode: 0o600, flag: "wx" });
            snapshots.push({ file, scratch: target, original, current: original, language: languageOf(file)! });
        }
        return snapshots;
    }

    async query(cwd: string, args: AstQuery, signal?: AbortSignal): Promise<ProviderQueryResult> {
        this.runtime.assertOwner();
        signal?.throwIfAborted();
        let scratch: string | undefined;
        try {
            const limits = validate(args);
            const cached = this.cachedStatus(cwd);
            const status = cached.available && cached.compatible ? cached : await this.probe(cwd, signal);
            if (!status.available) return { status: "unavailable", message: status.error };
            if (!status.compatible || !status.actions.includes(args.action)) return { status: "unsupported", message: status.error ?? "AST action is unsupported" };
            scratch = await mkdtemp(join(tmpdir(), "pi-lsp-ast-"));
            const config = join(scratch, "sgconfig.yml");
            await writeFile(config, "ruleDirs: []\n", { mode: 0o600, flag: "wx" });
            const snapshots = await this.snapshots(cwd, args.paths, scratch, limits.maxFiles, signal);
            if (!snapshots.length) return { status: "empty", items: [], total: 0, byteEdits: args.action === "rewrite_preview" ? [] : undefined, message: "No supported source files in the explicit scope" };
            const invoke = async (action: string, extra: string[], snapshot: Snapshot): Promise<JsonObject[]> => {
                signal?.throwIfAborted();
                const commandArgs = [action, "--config", config, "--json=compact", "--color", "never", "--threads", "1", ...extra, "--", snapshot.scratch];
                if (commandArgs.reduce((total, value) => total + Buffer.byteLength(value) + 2 * value.length + 1, 0) > ARGUMENT_BYTES) throw new Error("AST CLI arguments exceed the cross-platform limit; shorten patterns or rules");
                return objects(await this.runtime.run(status.executable!, commandArgs, { cwd: scratch!, signal, timeout: 30_000, maxBytes: OUTPUT_BYTES }));
            };
            const lang = args.lang ? ["--lang", args.lang] : [];
            if (args.action === "rewrite_preview") {
                let replacements = 0, replacementBytes = 0;
                for (const op of args.ops!) {
                    for (const snapshot of snapshots) {
                        const matches = await invoke("run", ["--pattern", op.pat, "--rewrite", op.out, ...lang], snapshot);
                        replacements += matches.length;
                        if (replacements > limits.maxReplacements) throw new Error(`AST maxReplacements ${limits.maxReplacements} exceeded; no proposal was created`);
                        const edits = matches.map((match): ByteEdit => {
                            if (typeof match.replacement !== "string" || !match.replacementOffsets) throw new Error("AST rewrite omitted exact replacement text or byte offsets");
                            const range = span(match.replacementOffsets, snapshot.current);
                            replacementBytes += Buffer.byteLength(match.replacement);
                            if (replacementBytes > SNAPSHOT_BYTES) throw new Error("AST cumulative replacement byte limit exceeded");
                            return { ...range, replacement: match.replacement };
                        }).sort((a, b) => a.start - b.start || a.end - b.end);
                        for (let index = 1; index < edits.length; index++) {
                            if (edits[index].start < edits[index - 1].end || edits[index].start === edits[index - 1].start) throw new Error("Overlapping or ambiguous AST edits in the same snapshot are unsupported");
                        }
                        const parts: Buffer[] = [];
                        let cursor = 0, length = snapshot.current.length;
                        for (const edit of edits) { length += Buffer.byteLength(edit.replacement) - (edit.end - edit.start); }
                        if (length > FILE_BYTES || length < 0) throw new Error("Rewritten source exceeds the per-file byte limit");
                        for (const edit of edits) { parts.push(snapshot.current.subarray(cursor, edit.start), Buffer.from(edit.replacement)); cursor = edit.end; }
                        parts.push(snapshot.current.subarray(cursor));
                        if (edits.length) { snapshot.current = Buffer.concat(parts, length); await writeFile(snapshot.scratch, snapshot.current); }
                    }
                    if (snapshots.reduce((sum, snapshot) => sum + snapshot.current.length, 0) > SNAPSHOT_BYTES) throw new Error("Final AST snapshot byte limit exceeded");
                }
                const byteEdits: FileByteEdits[] = [], originalHashes: Record<string, string> = {};
                for (const snapshot of snapshots) {
                    const edit = finalEdit(snapshot.original, snapshot.current);
                    if (edit) { byteEdits.push({ file: snapshot.file, edits: [edit] }); originalHashes[snapshot.file] = hash(snapshot.original); }
                }
                return { status: byteEdits.length ? "ok" : "empty", byteEdits, originalHashes, total: replacements, filesChanged: byteEdits.length, snapshotSemantics: "sequential", version: status.version, configuration: "disabled" };
            }
            const items: unknown[] = [];
            let truncated = false;
            for (const snapshot of snapshots) {
                let matches: JsonObject[];
                if (args.action === "outline") matches = await invoke("outline", ["--items", "all", "--view", "signatures", ...lang], snapshot);
                else if (args.rule !== undefined) {
                    const hasId = /^id\s*:/m.test(args.rule), hasLanguage = /^language\s*:/m.test(args.rule), hasRule = /^rule\s*:/m.test(args.rule);
                    if ((hasId || hasLanguage) && !hasRule) throw new Error("Rule envelope requires a rule field");
                    const rule = `${hasId ? "" : "id: fana-query\n"}${hasLanguage ? "" : `language: ${args.lang ? LANGUAGES[args.lang.toLowerCase()] : snapshot.language}\n`}${hasRule ? args.rule : `rule:\n${args.rule.split("\n").map((line) => `  ${line}`).join("\n")}\n`}`;
                    matches = await invoke("scan", ["--inline-rules", rule, "--max-results", String(limits.maxResults - items.length + 1)], snapshot);
                } else matches = await invoke("run", ["--pattern", args.pattern!, ...lang], snapshot);
                if (args.action === "outline") {
                    for (const file of matches) {
                        if (!Array.isArray(file.items)) throw new Error("AST returned an unsupported outline shape");
                        for (const entry of file.items) {
                            if (!entry || typeof entry !== "object") throw new Error("AST returned an invalid outline entry");
                            const item = entry as JsonObject;
                            const range = item.range as JsonObject | undefined;
                            span(range?.byteOffset, snapshot.original);
                            if (items.length >= limits.maxResults) { truncated = true; break; }
                            items.push({ file: snapshot.file, language: file.language, symbolType: item.symbolType, name: String(item.name ?? "").slice(0, 200), signature: String(item.signature ?? "").slice(0, 800), range: item.range, isImport: item.isImport, isExported: item.isExported, astKind: item.astKind });
                        }
                        if (truncated) break;
                    }
                } else for (const match of matches) {
                    const range = match.range as JsonObject | undefined;
                    span(range?.byteOffset, snapshot.original);
                    if (items.length >= limits.maxResults) { truncated = true; break; }
                    items.push({ file: snapshot.file, language: match.language, text: String(match.text ?? "").slice(0, 800), range: match.range, ...(match.ruleId !== undefined ? { ruleId: String(match.ruleId).slice(0, 200) } : {}) });
                }
                if (truncated) break;
            }
            return { status: items.length ? "ok" : "empty", items, total: items.length, truncated, totalIsLowerBound: truncated, filesInScope: snapshots.length, configuration: "disabled" };
        } catch (error) {
            signal?.throwIfAborted();
            return { status: error instanceof Unsupported ? "unsupported" : "unavailable", message: messageOf(error) };
        } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    }
}
