import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { ActiveClient } from "../../pi-lsp.ts";
import type { FileEdits, Position, PositionEncoding } from "./contracts.ts";
import { canonicalFile } from "./proposals.ts";

export interface LspBridge {
    findExecutable(command: string, cwd: string): string | undefined;
    select(cwd: string, file: string | undefined, server: string | undefined, capability: string): Promise<ActiveClient>;
    request(client: ActiveClient, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
    sync(client: ActiveClient, file: string): void;
    diagnose(cwd: string, file: string, context: Context, assertOwner: () => void): Promise<{ diagnostics: unknown[]; incomplete: boolean }>;
    servers(cwd: string): Promise<unknown[]>;
    config(server: string): { installCmd?: string; uninstallCmd?: string } | undefined;
}
export interface LspQuery {
    action: "references" | "hover" | "document_symbols" | "workspace_symbols" | "implementation" | "code_actions" | "rename_preview" | "format_preview";
    file?: string; server?: string; line?: number; character?: number;
    endLine?: number; endCharacter?: number; query?: string; newName?: string;
    includeDeclaration?: boolean; kinds?: string[]; tabSize?: number; insertSpaces?: boolean; maxResults?: number;
    offset?: number;
}
export interface LspQueryResult {
    status: "ok" | "empty" | "unsupported";
    items?: unknown[];
    total?: number;
    truncated?: boolean;
    server?: string;
    message?: string;
    offset?: number;
    nextOffset?: number;
    proposals?: { title: string; fileEdits: FileEdits[]; originalHashes: Record<string, string>; command?: { server: string; command: string; arguments?: unknown[] } }[];
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const CAPABILITY: Record<LspQuery["action"], string> = {
    references: "referencesProvider", hover: "hoverProvider", document_symbols: "documentSymbolProvider",
    workspace_symbols: "workspaceSymbolProvider", implementation: "implementationProvider",
    code_actions: "codeActionProvider", rename_preview: "renameProvider", format_preview: "documentFormattingProvider",
};
export function workspaceFileEdits(edit: unknown, cwd: string, client: ActiveClient): FileEdits[] {
    if (!object(edit)) throw new Error("Malformed WorkspaceEdit");
    const encoding = (client.serverCapabilities?.positionEncoding ?? "utf-16") as PositionEncoding;
    const rows: FileEdits[] = [];
    const append = (uri: unknown, edits: unknown, version?: unknown) => {
        if (typeof uri !== "string" || !uri.startsWith("file:") || !Array.isArray(edits)) throw new Error("Malformed document edit");
        if (version !== undefined && version !== null && !Number.isInteger(version)) throw new Error("Malformed document version");
        rows.push({ file: fileURLToPath(uri), encoding, version: version as number | null | undefined, edits: edits.map((item) => {
            if (!object(item) || !object(item.range) || typeof item.newText !== "string") throw new Error("Malformed text edit");
            if (item.annotationId !== undefined) throw new Error("Annotated edits are unsupported");
            return { range: item.range as unknown as { start: Position; end: Position }, newText: item.newText };
        }) });
    };
    if (Array.isArray(edit.documentChanges)) {
        for (const change of edit.documentChanges) {
            if (!object(change) || change.kind !== undefined || !object(change.textDocument)) throw new Error("Resource operations are unsupported; no changes applied");
            append(change.textDocument.uri, change.edits, change.textDocument.version);
        }
    } else if (object(edit.changes)) {
        for (const [uri, edits] of Object.entries(edit.changes)) append(uri, edits);
    } else if (edit.changes !== undefined || edit.documentChanges !== undefined) throw new Error("Malformed WorkspaceEdit");
    if (rows.length > 64) throw new Error("WorkspaceEdit exceeds the file limit");
    for (const row of rows) {
        const path = resolve(cwd, row.file);
        const info = statSync(path);
        if (!info.isFile()) throw new Error("WorkspaceEdit target is not a file");
    }
    return rows;
}
function position(args: LspQuery): Position {
    if (!Number.isInteger(args.line) || args.line! < 0 || !Number.isInteger(args.character) || args.character! < 0) throw new Error("This action requires nonnegative line and character");
    return { line: args.line!, character: args.character! };
}
function bounded(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return value.slice(0, 2000);
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (depth > 6) return "[nested data omitted]";
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => bounded(item, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, bounded(item, depth + 1)]));
    return null;
}
function locations(value: unknown): unknown[] {
    return (Array.isArray(value) ? value : value == null ? [] : [value]).map((item) => {
        if (!object(item)) throw new Error("Malformed location result");
        if (typeof item.targetUri === "string") return { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange, originSelectionRange: item.originSelectionRange ?? null };
        if (typeof item.uri !== "string" || !object(item.range)) throw new Error("Malformed location result");
        return { uri: item.uri, range: item.range };
    });
}
export async function executeLspQuery(bridge: LspBridge, cwd: string, args: LspQuery, context: Context, assertOwner: () => void): Promise<LspQueryResult> {
    assertOwner();
    const limit = args.maxResults ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("maxResults must be between 1 and 200");
    if (!Object.hasOwn(CAPABILITY, args.action)) throw new Error("Unsupported LSP query action");
    const file = args.file ? await canonicalFile(cwd, args.file) : undefined;
    if (!file && args.action !== "workspace_symbols") throw new Error("This action requires file");
    const cursor = ["references", "hover", "implementation", "rename_preview", "code_actions"].includes(args.action) ? position(args) : undefined;
    if (args.action === "rename_preview" && !args.newName?.trim()) throw new Error("Rename requires newName");
    const client = await bridge.select(cwd, file, args.server, CAPABILITY[args.action]);
    assertOwner();
    if (file) bridge.sync(client, file);
    const params = file ? { textDocument: { uri: pathToFileURL(file).href } } : {};
    const snapshotHashes: Record<string, string> = {};
    for (const [uri, opened] of client.openFiles) {
        try { snapshotHashes[fileURLToPath(uri)] = hash(opened.text); } catch {}
    }
    if (file) snapshotHashes[file] = hash(readFileSync(file, "utf8"));
    const requestStarted = Date.now();
    const rpc = async (method: string, payload: unknown) => {
        assertOwner();
        const value = await bridge.request(client, method, payload, context.abortSignal);
        assertOwner();
        return value;
    };
    const makeEdit = async (edit: unknown, title: string, command?: { server: string; command: string; arguments?: unknown[] }) => {
        const fileEdits = edit === undefined ? [] : workspaceFileEdits(edit, cwd, client);
        const originals: Record<string, string> = {};
        for (const row of fileEdits) {
            const path = await canonicalFile(cwd, row.file);
            row.file = path;
            if (snapshotHashes[path]) originals[path] = snapshotHashes[path];
            else {
                if (statSync(path).mtimeMs >= requestStarted) throw new Error("Closed file changed during LSP query; retry after synchronization");
                originals[path] = hash(readFileSync(path, "utf8"));
            }
        }
        return { title, fileEdits, originalHashes: originals, command };
    };
    let items: unknown[];
    switch (args.action) {
        case "references": items = locations(await rpc("textDocument/references", { ...params, position: cursor, context: { includeDeclaration: args.includeDeclaration ?? true } })); break;
        case "implementation": items = locations(await rpc("textDocument/implementation", { ...params, position: cursor })); break;
        case "hover": {
            const hover = await rpc("textDocument/hover", { ...params, position: cursor });
            items = hover == null ? [] : [hover]; break;
        }
        case "document_symbols": {
            const result = await rpc("textDocument/documentSymbol", params);
            if (result !== null && !Array.isArray(result)) throw new Error("Malformed symbol result");
            items = result ?? []; break;
        }
        case "workspace_symbols": {
            const result = await rpc("workspace/symbol", { query: args.query ?? "" });
            if (result !== null && !Array.isArray(result)) throw new Error("Malformed workspace symbol result");
            items = result ?? []; break;
        }
        case "rename_preview": {
            const rename = client.serverCapabilities?.renameProvider;
            if (object(rename) && rename.prepareProvider) {
                const prepared = await rpc("textDocument/prepareRename", { ...params, position: cursor });
                if (prepared == null) throw new Error("This symbol cannot be renamed");
            }
            const edit = await rpc("textDocument/rename", { ...params, position: cursor, newName: args.newName });
            if (edit == null) return { status: "empty", server: client.id, items: [] };
            const proposal = await makeEdit(edit, `Rename to ${args.newName}`);
            return { status: proposal.fileEdits.length ? "ok" : "empty", server: client.id, proposals: proposal.fileEdits.length ? [proposal] : [] };
        }
        case "format_preview": {
            if (args.tabSize !== undefined && (!Number.isInteger(args.tabSize) || args.tabSize < 1 || args.tabSize > 16)) throw new Error("tabSize must be between 1 and 16");
            const edits = await rpc("textDocument/formatting", { ...params, options: { tabSize: args.tabSize ?? 4, insertSpaces: args.insertSpaces ?? true } });
            if (edits == null || Array.isArray(edits) && edits.length === 0) return { status: "empty", server: client.id, items: [] };
            const proposal = await makeEdit({ changes: { [pathToFileURL(file!).href]: edits } }, "Format document");
            return { status: "ok", server: client.id, proposals: [proposal] };
        }
        case "code_actions": {
            const end = { line: args.endLine ?? cursor!.line, character: args.endCharacter ?? cursor!.character };
            if (!Number.isInteger(end.line) || !Number.isInteger(end.character) || end.line < cursor!.line || end.character < 0 || end.line === cursor!.line && end.character < cursor!.character) throw new Error("Invalid code-action range");
            let diagnostics: unknown[] = [];
            let incomplete = false;
            try { const report = await bridge.diagnose(cwd, file!, context, assertOwner); diagnostics = report.diagnostics; incomplete = report.incomplete; }
            catch (error) { context.abortSignal?.throwIfAborted(); assertOwner(); incomplete = true; }
            const actions = await rpc("textDocument/codeAction", { ...params, range: { start: cursor, end }, context: { diagnostics, only: args.kinds, triggerKind: 1 } });
            if (actions != null && !Array.isArray(actions)) throw new Error("Malformed code-action result");
            const proposals: NonNullable<LspQueryResult["proposals"]> = [];
            const offset = args.offset ?? 0, pageSize = Math.min(limit, 10);
            if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid code-action offset");
            const rows: unknown[] = [];
            for (const original of (actions ?? []).slice(offset, offset + pageSize)) {
                if (!object(original) || typeof original.title !== "string") throw new Error("Malformed code action");
                let action = original;
                if (action.disabled) { rows.push({ title: action.title, disabled: bounded(action.disabled) }); continue; }
                if (typeof action.command !== "string" && action.data !== undefined && object(client.serverCapabilities?.codeActionProvider) && client.serverCapabilities.codeActionProvider.resolveProvider) {
                    const resolved = await rpc("codeAction/resolve", action);
                    if (!object(resolved)) throw new Error("Malformed resolved code action");
                    action = resolved;
                }
                const rawCommand = typeof action.command === "string" ? action : action.command;
                const command = object(rawCommand) && typeof rawCommand.command === "string"
                    ? { server: client.id, command: rawCommand.command, arguments: Array.isArray(rawCommand.arguments) ? rawCommand.arguments : undefined } : undefined;
                if (!action.edit && !command) { rows.push({ title: action.title, unsupported: "No applicable edit or command" }); continue; }
                try {
                    const proposal = await makeEdit(action.edit, String(action.title), command);
                    if (!command && proposal.fileEdits.every((file) => file.edits.length === 0)) { rows.push({ title: action.title, noChanges: true }); continue; }
                    proposals.push(proposal);
                    rows.push({ title: action.title, proposalIndex: proposals.length - 1, requiresConsent: !!command });
                } catch (error) { rows.push({ title: action.title, unsupported: error instanceof Error ? error.message : "Unsupported edit" }); }
            }
            return { status: rows.length ? "ok" : "empty", server: client.id, items: rows, total: actions?.length ?? 0, offset, nextOffset: (actions?.length ?? 0) > offset + pageSize ? offset + pageSize : undefined, truncated: (actions?.length ?? 0) > offset + pageSize, proposals, message: incomplete ? "Diagnostic context incomplete; actions are not proof of a verified file" : undefined };
        }
    }
    return { status: items.length ? "ok" : "empty", server: client.id, items: items.slice(0, limit).map((item) => bounded(item)), total: items.length, truncated: items.length > limit };
}
