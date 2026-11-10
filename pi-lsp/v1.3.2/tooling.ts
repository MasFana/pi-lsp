import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { defineDoc, defineDocFamily, defineTool, section } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { DocumentReader, JsonObject, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import type { Host, Web, WebRequest, ConversationWebRequest } from "../../_pocket.d.ts";
import { AstProvider } from "./ast.ts";
import { GraphProvider } from "./graph.ts";
import { createProcessRunner } from "./process.ts";
import { applyProposal, createProposal, summarizeProposal, type Proposal } from "./proposals.ts";
import { executeLspQuery, workspaceFileEdits, type LspBridge, type LspQuery } from "./queries.ts";
import type { AstQuery, GraphQuery, ProviderRuntime, ProviderStatus } from "./contracts.ts";
import { createAutomaticProviders } from "./automatic.ts";
import { createSourceWatchers } from "./watch.ts";

const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const ProposalDoc = defineDocFamily<{ value: JsonObject | null }, string>({ kind: "x.pi-lsp.proposal", scope: "session", family: true, version: 1, initial: () => ({ value: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20 });
const ProposalIndex = defineDoc<{ ids: string[] }>({ kind: "x.pi-lsp.proposals", scope: "session", version: 1, initial: () => ({ ids: [] }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20 });
const ToolingDoc = defineDocFamily<{ value: JsonObject | null }, string>({ kind: "x.pi-lsp.tooling", scope: "session", family: true, version: 1, initial: () => ({ value: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20 });
interface Scope {
    cwd: string; conversationId: string; requesterId: string; context: Context; signal?: AbortSignal;
    owner(): void; snapshot: DocumentReader["snapshot"];
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}
interface Operation {
    provider: "lsp" | "ast" | "graph"; action: string; serverId?: string; proposalId?: string; command: string;
    npmRoot?: string;
}
const resultSchema = Type.Object({ status: Type.String() }, { additionalProperties: true });
const indexKey = (cwd: string) => createHash("sha256").update(cwd).digest("hex");
const positive = (max: number) => Type.Optional(Type.Integer({ minimum: 1, maximum: max }));
const text = () => Type.Optional(Type.String());
const position = () => Type.Optional(Type.Integer({ minimum: 0 }));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function createTooling(host: Host, web: Web | undefined, bridge: LspBridge & { refreshServers(cwd: string, signal?: AbortSignal): Promise<unknown[]>; version(cwd: string, file: string, server?: string): number | undefined }) {
    const processes = createProcessRunner();
    const busy = new Map<string, { id: string; action: string }>();
    const managedExecutables = new Map<string, string>();
    const ownerFor = (id: string) => { if (host.roleOf(id) !== "owner") throw new Error("Only the Pocket owner can execute tooling operations"); };
    const astByOwner = new Map<string, AstProvider>(), graphByOwner = new Map<string, GraphProvider>();
    const providers = (scope: Pick<Scope, "requesterId">) => {
        const runtimeFor: ProviderRuntime = { findExecutable: bridge.findExecutable, run: processes.run, assertOwner: () => ownerFor(scope.requesterId) };
        let ast = astByOwner.get(scope.requesterId), graph = graphByOwner.get(scope.requesterId);
        if (!ast) { ast = new AstProvider(runtimeFor); astByOwner.set(scope.requesterId, ast); }
        if (!graph) { graph = new GraphProvider(runtimeFor); graphByOwner.set(scope.requesterId, graph); }
        // Providers retain person identity only, never a completed request's context or abort signal.
        return { ast, graph };
    };
    const automaticErrors = new Map<string, string>();
    const watcherErrors = new Map<string, string>();
    const notify = (cwd: string) => { try { web?.send("lsp-changed", { cwd }); } catch {} };
    const changed = (cwd: string, files: string[], personId?: string) => {
        for (const [person, graph] of graphByOwner) {
            if (personId && person !== personId || host.roleOf(person) !== "owner") continue;
            graph.markChanged(cwd, files);
            if (files.length) automatic.changed(cwd, person, files);
        }
        if (personId && files.length && !graphByOwner.has(personId)) automatic.changed(cwd, personId, files);
        notify(cwd);
    };
    const watchers = createSourceWatchers({ isOwner: (person) => host.roleOf(person) === "owner", changed: (cwd, person, files) => changed(cwd, files, person), failed: (cwd, error) => { if (error) watcherErrors.set(cwd, `Source watcher: ${error}`); else watcherErrors.delete(cwd); notify(cwd); } });
    const automatic = createAutomaticProviders({
        isOwner: (person) => host.roleOf(person) === "owner",
        canOperate: (cwd) => !busy.has(cwd) && !busy.has("<global-command>"),
        notify,
        async probe(cwd, person, signal) {
            ownerFor(person);
            const { ast, graph } = providers({ requesterId: person });
            await bridge.refreshServers(cwd, signal);
            const [, found] = await Promise.all([ast.probe(cwd, signal), graph.probe(cwd, signal)]);
            ownerFor(person); signal?.throwIfAborted();
            watchers.ensure(cwd, person, found.initialized === true && found.compatible === true);
            return { indexed: found.initialized === true && found.compatible === true };
        },
        async sync(cwd, person, signal) {
            ownerFor(person);
            if (busy.has(cwd) || busy.has("<global-command>")) throw new Error("A conflicting tooling/package operation is running; automatic sync deferred");
            busy.set(cwd, { id: randomUUID(), action: "sync" }); notify(cwd);
            try {
                const graph = providers({ requesterId: person }).graph;
                const result = await graph.operate(cwd, { action: "sync" }, signal);
                ownerFor(person); signal?.throwIfAborted();
                watchers.ensure(cwd, person, result.initialized === true && result.compatible === true);
                if (result.error || result.buildState === "failed" || result.buildState === "partial") throw new Error(result.error ?? `Automatic CodeGraph sync ${result.buildState}`);
                automaticErrors.delete(cwd);
            } catch (error) { automaticErrors.set(cwd, error instanceof Error ? error.message : String(error)); throw error; }
            finally { busy.delete(cwd); notify(cwd); }
        },
    });
    const toolScope = async (api: ToolExecutionApi, context: Context): Promise<Scope> => {
        const raw = api.env?.cwd ?? (await api.agent(context)).cwd;
        if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error("A local conversation workspace is required");
        const requesterId = host.requesterOf(api.conversationId) ?? "";
        const cwd = realpathSync(resolve(raw));
        return { cwd, conversationId: String(api.conversationId), requesterId, context, signal: context.abortSignal,
            owner: () => { if (host.requesterOf(api.conversationId) !== requesterId) throw new Error("Conversation requester changed"); ownerFor(requesterId); if (realpathSync(resolve(host.cwdOf(api.conversationId))) !== cwd) throw new Error("Conversation workspace changed"); },
            snapshot: api.snapshot.bind(api), commit: (change) => api.commit(change, context) };
    };
    const routeScope = (req: WebRequest | ConversationWebRequest): Scope => {
        const conversation = "conversation" in req ? req.conversation : undefined;
        const raw = conversation?.cwd ?? process.cwd();
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error("Remote workspaces are unsupported");
        const cwd = realpathSync(resolve(raw));
        return { cwd, conversationId: conversation ? String(conversation.id) : "", requesterId: req.user.id, context: req.context, signal: req.signal,
            owner: () => { ownerFor(req.user.id); if (conversation && realpathSync(resolve(host.cwdOf(conversation.id))) !== cwd) throw new Error("Conversation workspace changed"); req.signal.throwIfAborted(); },
            snapshot: req.snapshot, commit: (change) => req.commit(change) };
    };
    const save = async (scope: Scope, proposal: Proposal) => {
        scope.owner();
        await scope.commit(async (tx) => {
            scope.owner();
            const doc = await tx.doc(ProposalDoc, proposal.id, proposal.id);
            if (!doc.value) {
                const index = await tx.doc(ProposalIndex);
                const retained: { id: string; bytes: number; complete: boolean }[] = [];
                const proposalBytes = Buffer.byteLength(JSON.stringify(proposal));
                let bytes = proposalBytes;
                for (const id of index.ids) {
                    const old = await tx.doc(ProposalDoc, id, id);
                    if (!old.value || Number(old.value.expiresAt) < Date.now()) { await tx.retireDoc(ProposalDoc, id); continue; }
                    const value = old.value as unknown as Proposal;
                    const size = Buffer.byteLength(JSON.stringify(old.value));
                    retained.push({ id, bytes: size, complete: value.files.every((file) => file.receipt.status === "applied") && (!value.command || value.commandReceipt?.status === "completed") });
                    bytes += size;
                }
                while (retained.length >= 20 || bytes > 16 * 1024 * 1024) {
                    const removable = retained.findIndex((item) => item.complete);
                    if (removable < 0) throw new Error("Pending proposal storage limit reached; apply proposals or allow them to expire");
                    const [old] = retained.splice(removable, 1);
                    bytes -= old!.bytes; await tx.retireDoc(ProposalDoc, old!.id);
                }
                doc.value = json(proposal);
                index.ids = [...retained.map((item) => item.id), proposal.id];
            } else {
                const files = doc.value.files as unknown as Proposal["files"];
                if (files.length !== proposal.files.length) throw new Error("Proposal identity changed");
                for (let index = 0; index < files.length; index++) files[index]!.receipt = json(proposal.files[index]!.receipt) as unknown as Proposal["files"][number]["receipt"];
                if (proposal.commandReceipt) doc.value.commandReceipt = json(proposal.commandReceipt);
            }
        });
        scope.owner();
        changed(scope.cwd, []);
    };
    const read = async (scope: Scope, id: string) => {
        if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid proposal ID");
        const doc = await scope.snapshot(ProposalDoc, id, scope.context);
        if (!doc?.value) throw new Error("Proposal not found or expired");
        const proposal = JSON.parse(JSON.stringify(doc.value)) as Proposal;
        if (proposal.workspace !== scope.cwd || proposal.conversationId !== scope.conversationId || proposal.requesterId !== scope.requesterId) throw new Error("Proposal belongs to another requester or workspace");
        return proposal;
    };
    const list = async (scope: Scope) => {
        const index = await scope.snapshot(ProposalIndex, scope.context);
        const rows = [];
        for (const id of index?.ids ?? []) {
            const doc = await scope.snapshot(ProposalDoc, id, scope.context);
            const p = doc?.value as unknown as Proposal | undefined;
            if (p && p.expiresAt > Date.now() && p.workspace === scope.cwd && p.requesterId === scope.requesterId && p.conversationId === scope.conversationId && (p.files.some((f) => f.receipt.status !== "applied") || p.command && p.commandReceipt?.status !== "completed")) rows.push({ id: p.id, title: p.title, files: p.files.map((f) => f.file), hasCommand: !!p.command });
        }
        return rows;
    };
    const management = (status: ProviderStatus) => ({ ...status, provenance: status.executable && managedExecutables.has(status.executable) ? "npm-global" : status.provenance, canInstall: status.checkedAt !== undefined && !status.available && process.platform !== "win32" && (status.id !== "codegraph" || Number(process.versions.node.split(".")[0]) < 25), canUninstall: !!status.available && !!status.executable && managedExecutables.has(status.executable) });
    const status = async (scope: Scope) => {
        const { ast, graph } = providers(scope);
        automatic.ensure(scope.cwd, scope.requesterId);
        const persisted = await scope.snapshot(ToolingDoc, indexKey(scope.cwd), scope.context);
        const cached = (current: ProviderStatus, previous: unknown): ProviderStatus => current.checkedAt !== undefined || !object(previous) ? current : {
            ...current, previousSnapshot: previous, sourceFreshness: "unknown", error: "Provider status has not been refreshed in this process; previous snapshot is historical", actions: current.actions,
        };
        return { cwd: scope.cwd, servers: await bridge.servers(scope.cwd), ast: management(cached(ast.cachedStatus(scope.cwd), persisted?.value?.ast)), graph: { ...management(cached(graph.cachedStatus(scope.cwd), persisted?.value?.graph)), automaticSync: true, automaticError: watcherErrors.get(scope.cwd) ?? automaticErrors.get(scope.cwd) }, busy: busy.get(scope.cwd) ?? busy.get("<global-command>"), proposals: await list(scope) };
    };
    const inspectNpmOwnership = async (scope: Scope): Promise<string | undefined> => {
        scope.owner();
        const { ast, graph } = providers(scope);
        const statuses = [ast.cachedStatus(scope.cwd), graph.cachedStatus(scope.cwd)];
        for (const item of statuses) if (item.executable) managedExecutables.delete(item.executable);
        if (!statuses.some((item) => item.available && item.executable)) return undefined;
        const npm = bridge.findExecutable("npm", scope.cwd);
        if (!npm) return undefined;
        try {
            const reply = await processes.run(npm, ["root", "-g"], { cwd: scope.cwd, signal: scope.signal, timeout: 5000, maxBytes: 8192 });
            scope.owner();
            if (reply.exitCode !== 0 || !isAbsolute(reply.stdout.trim())) return undefined;
            const root = realpathSync(reply.stdout.trim());
            for (const item of statuses) {
                if (!item.available || !item.executable) continue;
                const path = relative(root, realpathSync(item.executable));
                if (path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) managedExecutables.set(item.executable, root);
            }
            return root;
        } catch (error) { scope.signal?.throwIfAborted(); scope.owner(); return undefined; }
    };
    const persistStatus = async (scope: Scope) => {
        const { ast, graph } = providers(scope);
        await scope.commit(async (tx) => { const doc = await tx.doc(ToolingDoc, indexKey(scope.cwd), indexKey(scope.cwd)); doc.value = json({ ast: ast.cachedStatus(scope.cwd), graph: graph.cachedStatus(scope.cwd), checkedAt: Date.now() }); });
        changed(scope.cwd, []);
    };
    const verify = async (scope: Scope, files: string[]) => {
        changed(scope.cwd, files, scope.requesterId);
        if (web?.setting("autoCheck") === false) return files.map((file) => ({ file, status: "not_verified", message: "Automatic diagnostics disabled" }));
        const results = [];
        for (let offset = 0; offset < files.length; offset += 4) {
            const batch = await Promise.all(files.slice(offset, offset + 4).map(async (file) => {
                scope.owner();
                try {
                    const report = await bridge.diagnose(scope.cwd, file, scope.context, scope.owner);
                    return { file, status: report.incomplete ? "not_verified" : report.diagnostics.length ? "diagnostics" : "checked", diagnostics: report.diagnostics.slice(0, 20) };
                } catch (error) { return { file, status: "not_verified", message: error instanceof Error ? error.message : "Diagnostic check failed" }; }
            }));
            results.push(...batch);
        }
        return results;
    };
    const apply = async (scope: Scope, id: string) => {
        scope.owner();
        const proposal = await read(scope, id);
        if (proposal.commandReceipt?.status === "completed") return { status: "already_applied", changedFiles: [], files: proposal.files.map((file) => ({ file: file.file, status: "already_applied" })), command: proposal.commandReceipt, verification: [], message: "Proposal and command already completed; no effects repeated" };
        if (proposal.commandReceipt?.status === "running" || proposal.commandReceipt?.status === "interrupted") throw new Error("Command outcome is uncertain; request a new action proposal before executing again");
        let client: Awaited<ReturnType<LspBridge["select"]>> | undefined;
        if (proposal.command) {
            client = await bridge.select(scope.cwd, proposal.files[0]?.file, proposal.command.server, "executeCommandProvider");
            const capability = client.serverCapabilities?.executeCommandProvider;
            const commands = object(capability) && Array.isArray(capability.commands) ? capability.commands : [];
            if (!commands.includes(proposal.command.command)) throw new Error("Server does not advertise this command");
        }
        const outcome = await applyProposal(proposal, { assertOwner: scope.owner, save: (p) => save(scope, p), signal: scope.signal, getVersion: (file) => bridge.version(scope.cwd, file, proposal.server) });
        const files = new Set(outcome.changedFiles);
        if (proposal.command && client && ["applied", "already_applied"].includes(outcome.status)) {
            scope.owner();
            for (const file of files) bridge.sync(client, file);
            proposal.commandReceipt = { status: "running" };
            await save(scope, proposal);
            client.applyEditHandler = async (edit: unknown) => {
                scope.owner();
                const derived = await createProposal({ workspace: scope.cwd, conversationId: scope.conversationId, requesterId: scope.requesterId, provider: "lsp", server: client!.id, action: "code_action", title: `${proposal.title}: server edit`, fileEdits: workspaceFileEdits(edit, scope.cwd, client!) });
                await save(scope, derived);
                const result = await applyProposal(derived, { assertOwner: scope.owner, save: (p) => save(scope, p), signal: scope.signal, getVersion: (file) => bridge.version(scope.cwd, file, client!.id) });
                for (const file of result.changedFiles) files.add(file);
                return { applied: ["applied", "already_applied"].includes(result.status), failureReason: result.message };
            };
            try {
                await bridge.request(client, "workspace/executeCommand", { command: proposal.command.command, arguments: proposal.command.arguments ?? [] }, scope.signal);
                scope.owner();
                proposal.commandReceipt = { status: "completed", message: "Command finished; only reported workspace edits are verified" };
            } catch (error) { proposal.commandReceipt = { status: "interrupted", message: error instanceof Error ? error.message : "Command failed" }; outcome.status = files.size ? "partial" : "failed"; outcome.message = proposal.commandReceipt.message; }
            finally { client.applyEditHandler = undefined; }
            await save(scope, proposal);
        }
        return { ...outcome, changedFiles: [...files], command: proposal.commandReceipt, verification: await verify(scope, [...files]) };
    };
    const modelResult = (value: unknown) => {
        const structuredOutput = json(value);
        let display = JSON.stringify(structuredOutput);
        if (Buffer.byteLength(display) > 32_000) {
            const shortProposal = (item: unknown) => object(item) ? { id: item.id, title: typeof item.title === "string" ? item.title.slice(0, 300) : undefined, hasCommand: item.hasCommand, changedFileCount: Array.isArray(item.changedFiles) ? item.changedFiles.length : undefined } : undefined;
            display = JSON.stringify({ status: structuredOutput.status, truncated: true, displayOnly: true, total: structuredOutput.total, message: "Display byte budget exceeded; narrow the query or preview fewer files. Full structured output and immutable proposal bytes are retained.", proposal: shortProposal(structuredOutput.proposal), proposals: Array.isArray(structuredOutput.proposals) ? structuredOutput.proposals.slice(0, 20).map(shortProposal) : undefined, changedFileCount: Array.isArray(structuredOutput.changedFiles) ? structuredOutput.changedFiles.length : undefined });
        }
        return { structuredOutput, output: [{ type: "text" as const, text: `<tooling_data>\n${host.text.defang(display)}\n</tooling_data>` }] };
    };
    const lspQuery = defineTool({ name: "lsp_query", description: "Semantic queries and rename/format/code-action previews. Apply returned IDs with fana_apply.", replay: "safe" as const,
        parameters: Type.Object({ action: Type.Union(["references", "hover", "document_symbols", "workspace_symbols", "implementation", "code_actions", "rename_preview", "format_preview"].map((action) => Type.Literal(action))), file: text(), server: text(), line: position(), character: position(), endLine: position(), endCharacter: position(), query: text(), newName: text(), includeDeclaration: Type.Optional(Type.Boolean()), kinds: Type.Optional(Type.Array(Type.String())), tabSize: positive(16), insertSpaces: Type.Optional(Type.Boolean()), maxResults: positive(200), offset: position() }, { additionalProperties: false }), structuredOutputSchema: resultSchema,
        async execute(args, api, context) {
            const scope = await toolScope(api, context); scope.owner();
            const result = await executeLspQuery(bridge, scope.cwd, args as LspQuery, context, scope.owner);
            const proposals = [];
            const proposalIds: (string | undefined)[] = [];
            for (const row of result.proposals ?? []) {
                try {
                    const proposal = await createProposal({ ...row, workspace: scope.cwd, conversationId: scope.conversationId, requesterId: scope.requesterId, provider: "lsp", server: result.server, action: args.action });
                    await save(scope, proposal); proposals.push(summarizeProposal(proposal)); proposalIds.push(proposal.id);
                } catch (error) { if (!object(error) || error.code !== "NO_CHANGES") throw error; proposalIds.push(undefined); }
            }
            for (const item of result.items ?? []) if (object(item) && typeof item.proposalIndex === "number") {
                const id = proposalIds[item.proposalIndex]; delete item.proposalIndex;
                if (id) item.proposalId = id; else item.noChanges = true;
            }
            return modelResult({ ...result, status: result.proposals?.length && !proposals.length && !result.items?.length ? "empty" : result.status, proposals });
        } });
    const fanaAst = defineTool({ name: "fana_ast", description: "Structural search, outline, or rewrite preview. Apply proposal IDs with fana_apply; no automatic installs.", replay: "safe" as const,
        parameters: Type.Object({ action: Type.Union(["status", "search", "outline", "rewrite_preview"].map((action) => Type.Literal(action))), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 64 })), lang: text(), pattern: text(), rule: text(), ops: Type.Optional(Type.Array(Type.Object({ pat: Type.String(), out: Type.String() }, { additionalProperties: false }), { maxItems: 20 })), maxResults: positive(200), maxFiles: positive(64), maxReplacements: positive(5000) }, { additionalProperties: false }), structuredOutputSchema: resultSchema,
        async execute(args, api, context) {
            const scope = await toolScope(api, context); const { ast } = providers(scope);
            const cached = ast.cachedStatus(scope.cwd);
            if (host.roleOf(scope.requesterId) === "owner" && (cached.checkedAt === undefined || Date.now() - cached.checkedAt >= 300_000)) await ast.probe(scope.cwd, scope.signal);
            if (args.action === "status") return modelResult({ status: "ok", ...management(ast.cachedStatus(scope.cwd)) });
            scope.owner();
            if (!args.paths?.length) throw new Error("Explicit paths are required");
            const result = await ast.query(scope.cwd, args as AstQuery, scope.signal); scope.owner();
            const { byteEdits, fileEdits, originalHashes, ...summary } = result;
            let proposal;
            if (byteEdits?.length || fileEdits?.length) {
                const stored = await createProposal({ workspace: scope.cwd, conversationId: scope.conversationId, requesterId: scope.requesterId, provider: "ast", action: args.action, title: "Structural rewrite", byteEdits, fileEdits, originalHashes: originalHashes as Record<string, string> | undefined });
                await save(scope, stored); proposal = summarizeProposal(stored);
            }
            changed(scope.cwd, []); return modelResult({ ...summary, proposal });
        } });
    const fanaGraph = defineTool({ name: "fana_graph", description: "Explore CodeGraph callers/callees, impact and test candidates. Automatically syncs existing indexes before reading; never creates missing indexes.", replay: "safe" as const,
        parameters: Type.Object({ action: Type.Union(["status", "explore", "callers", "callees", "impact", "affected_tests"].map((action) => Type.Literal(action))), query: text(), symbol: text(), file: text(), depth: positive(5), maxResults: positive(150), generation: text() }, { additionalProperties: false }), structuredOutputSchema: resultSchema,
        async execute(args, api, context) {
            const scope = await toolScope(api, context); const { graph } = providers(scope);
            automatic.ensure(scope.cwd, scope.requesterId);
            if (args.action === "status") return modelResult({ status: "ok", ...management(graph.cachedStatus(scope.cwd)) });
            scope.owner(); await automatic.prepareQuery(scope.cwd, scope.requesterId, scope.signal);
            const result = await graph.query(scope.cwd, args as GraphQuery, scope.signal); scope.owner(); changed(scope.cwd, []); return modelResult(result);
        } });
    const fanaApply = defineTool({ name: "fana_apply", description: "Immediately apply the exact saved proposal for the authorized task. No extra human review or consent; stale-file and recovery guards remain.", replay: "unsafe" as const,
        parameters: Type.Object({ proposalId: Type.String() }, { additionalProperties: false }), structuredOutputSchema: resultSchema,
        async execute(args, api, context) { const scope = await toolScope(api, context); return modelResult(await apply(scope, args.proposalId)); } });
    for (const tool of [lspQuery, fanaAst]) Object.assign(tool, { annotations: { readOnlyHint: true } });
    const shell = () => process.platform === "win32" ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] } : { executable: "/bin/sh", args: ["-c"] };
    const runCommand = async (command: string, cwd: string, signal: AbortSignal | undefined, authority: () => void) => {
        authority();
        if (busy.has("<global-command>") || [...busy.values()].some((item) => ["create", "sync", "rebuild"].includes(item.action))) throw new Error("A conflicting provider/package operation is running");
        busy.set("<global-command>", { id: randomUUID(), action: "package-operation" });
        changed(cwd, []);
        try {
            const launch = shell();
            const result = await processes.run(launch.executable, [...launch.args, command], { cwd, signal, timeout: 10 * 60_000, maxBytes: 2 * 1024 * 1024 });
            authority();
            if (result.exitCode !== 0) throw Object.assign(new Error(`Command exited ${result.exitCode}: ${result.stderr.slice(-2000)}`), { installer: { exitCode: result.exitCode, stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) } });
            return result;
        } finally { busy.delete("<global-command>"); changed(cwd, []); }
    };
    const resolveOperation = async (scope: Scope, body: Record<string, unknown>): Promise<Operation> => {
        scope.owner();
        const provider = body.provider;
        const action = typeof body.action === "string" ? body.action : "";
        if (!["lsp", "ast", "graph"].includes(String(provider)) || !["install", "uninstall", "refresh", "create", "sync", "rebuild", "apply"].includes(action)) throw new Error("Unsupported tooling operation");
        const serverId = typeof body.serverId === "string" ? body.serverId : undefined;
        const proposalId = typeof body.proposalId === "string" ? body.proposalId : undefined;
        const { ast, graph } = providers(scope);
        let command = "";
        if (action === "apply") { if (!proposalId) throw new Error("proposalId required"); await read(scope, proposalId); }
        else if (action === "refresh") { /* No command is needed for status refresh. */ }
        else if (["create", "sync", "rebuild"].includes(action)) { if (provider !== "graph") throw new Error("Index operations require CodeGraph"); }
        else if (provider === "lsp") {
            const conf = serverId ? bridge.config(serverId) : undefined;
            command = (action === "install" ? conf?.installCmd : conf?.uninstallCmd) ?? "";
            if (!command) throw new Error("No supported server command");
        } else {
            if (provider === "ast" && ast.cachedStatus(scope.cwd).checkedAt === undefined) await ast.probe(scope.cwd, scope.signal);
            if (provider === "graph" && graph.cachedStatus(scope.cwd).checkedAt === undefined) await graph.probe(scope.cwd, scope.signal);
            if (action === "uninstall") await inspectNpmOwnership(scope);
            const cached = provider === "ast" ? ast.cachedStatus(scope.cwd) : graph.cachedStatus(scope.cwd);
            const capabilities = management(cached);
            if (action === "uninstall" && !capabilities.canUninstall) throw new Error("Installation provenance is not extension-manageable");
            if (action === "install" && !capabilities.canInstall) throw new Error("No compatible package-install runtime is available");
            command = `npm ${action === "install" ? "install" : "uninstall"} -g ${provider === "ast" ? "@ast-grep/cli" : "@colbymchenry/codegraph"}${action === "install" && provider === "graph" ? "@1.6.2" : ""}`;
        }
        const selected = provider === "ast" ? ast.cachedStatus(scope.cwd) : graph.cachedStatus(scope.cwd);
        return { provider: provider as Operation["provider"], action, serverId, proposalId, command, npmRoot: action === "uninstall" && provider !== "lsp" && selected.executable ? managedExecutables.get(selected.executable) : undefined };
    };
    const execute = async (scope: Scope, body: Record<string, unknown>) => {
        scope.owner();
        const plan = await resolveOperation(scope, body);
        if (busy.has(scope.cwd) || busy.has("<global-command>")) throw new Error("Another tooling/package operation is running");
        busy.set(scope.cwd, { id: randomUUID(), action: plan.action }); changed(scope.cwd, []);
        const { ast, graph } = providers(scope);
        let providerOutcome: ProviderStatus | undefined;
        let installer: { exitCode: number | null; stdout: string; stderr: string } | undefined;
        let error: string | undefined;
        try {
            if (plan.action === "apply") return await apply(scope, plan.proposalId!);
            if (plan.action === "refresh") {
                if (plan.provider === "lsp") await bridge.refreshServers(scope.cwd, scope.signal);
                else if (plan.provider === "ast") providerOutcome = await ast.probe(scope.cwd, scope.signal);
                else providerOutcome = await graph.operate(scope.cwd, { action: "refresh" }, scope.signal);
            } else if (["create", "sync", "rebuild"].includes(plan.action)) providerOutcome = await graph.operate(scope.cwd, { action: plan.action as "create" | "sync" | "rebuild" }, scope.signal);
            else {
                if (plan.action === "uninstall" && plan.provider !== "lsp" && (!plan.npmRoot || await inspectNpmOwnership(scope) !== plan.npmRoot)) throw new Error("Global package provenance changed; refresh and retry");
                try { const result = await runCommand(plan.command, scope.cwd, scope.signal, scope.owner); installer = { exitCode: result.exitCode, stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) }; }
                catch (failure) { error = failure instanceof Error ? failure.message : String(failure); if (failure && typeof failure === "object" && "installer" in failure) installer = failure.installer as typeof installer; }
                scope.signal?.throwIfAborted(); scope.owner();
                if (plan.provider === "lsp") await bridge.refreshServers(scope.cwd, scope.signal);
                else if (plan.provider === "ast") providerOutcome = await ast.probe(scope.cwd, scope.signal);
                else providerOutcome = await graph.probe(scope.cwd, scope.signal);
            }
            scope.owner();
            if (plan.action === "refresh" || plan.action === "install" || plan.action === "uninstall") await inspectNpmOwnership(scope);
            await persistStatus(scope);
            let executable: string | undefined, version: string | undefined;
            let available: boolean | undefined;
            if (plan.provider === "lsp" && plan.serverId) {
                const config = bridge.config(plan.serverId)!;
                executable = bridge.findExecutable(config.command, scope.cwd);
                available = !!executable;
                if (executable && plan.serverId === "gopls") {
                    const reply = await processes.run(executable, ["version"], { cwd: scope.cwd, signal: scope.signal, timeout: 5000, maxBytes: 8192 });
                    if (reply.exitCode === 0 && reply.stdout.includes("golang.org/x/tools/gopls")) version = reply.stdout.trim();
                    else error ??= `Detected gopls could not be verified: ${reply.stderr.trim() || `exit ${reply.exitCode}`}`;
                }
            } else if (providerOutcome) { executable = providerOutcome.executable; version = providerOutcome.version; available = providerOutcome.available && providerOutcome.compatible !== false; }
            if (plan.action === "install" && !available) error ??= "Installer completed, but no usable provider executable was detected";
            if (plan.action === "uninstall" && available) error ??= `An executable remains available${executable ? ` at ${executable}` : ""}; removal is not verified`;
            error ??= providerOutcome?.error;
            const outcome = error || providerOutcome?.buildState === "failed" ? "failed" : providerOutcome?.buildState === "partial" ? "partial" : "ok";
            if (plan.provider === "graph") watchers.ensure(scope.cwd, scope.requesterId, providerOutcome?.initialized === true && providerOutcome?.compatible === true);
            const message = error ?? (plan.action === "install" ? `${plan.serverId ?? plan.provider}: executable detected${version ? ` (${version})` : "; language-server initialization not checked"}` : plan.action === "uninstall" ? `${plan.serverId ?? plan.provider}: executable removal verified` : `${plan.serverId ?? plan.provider}: ${plan.action} ${outcome}`);
            return { status: outcome, provider: plan.provider, action: plan.action, serverId: plan.serverId, cwd: scope.cwd, message, error, available, executable, version, installer,
                ...(providerOutcome ? { indexRoot: providerOutcome.indexRoot, initialized: providerOutcome.initialized, buildState: providerOutcome.buildState, sourceFreshness: providerOutcome.sourceFreshness, operationResult: providerOutcome.operationResult } : {}),
                ...(plan.provider === "lsp" && plan.action === "refresh" ? { detectedCount: (await bridge.servers(scope.cwd)).filter((row) => object(row) && row.available).length } : {}) };
        } finally { busy.delete(scope.cwd); changed(scope.cwd, []); }
    };
    if (web) {
        const body = (req: WebRequest) => object(req.body) ? req.body : {};
        const handle = (fn: (scope: Scope, body: Record<string, unknown>) => Promise<unknown>) => async (req: WebRequest | ConversationWebRequest) => {
            try { return await fn(routeScope(req), body(req)); }
            catch (error) { throw web.error(400, error instanceof Error ? error.message : "Tooling operation failed"); }
        };
        web.route("GET", "tooling/status", handle((scope) => status(scope)), { access: "owner" });
        web.conversationRoute("GET", "c/:conversation/tooling/status", handle((scope) => status(scope)), { conversation: "conversation", access: "owner" });
        web.route("POST", "tooling/execute", handle(execute), { access: "owner" });
        web.conversationRoute("POST", "c/:conversation/tooling/execute", handle(execute), { conversation: "conversation", access: "owner" });
    }
    return { tools: [lspQuery, fanaAst, fanaGraph, fanaApply], changed, runCommand, probeExecutable: (executable: string, args: string[], cwd: string, signal?: AbortSignal) => processes.run(executable, args, { cwd, signal, timeout: 5000, maxBytes: 8192 }), manage: async (body: Record<string, unknown>, api: ToolExecutionApi, context: Context) => execute(await toolScope(api, context), body), manageRoute: (body: Record<string, unknown>, req: WebRequest) => execute(routeScope(req), body), dispose: async () => { watchers.dispose(); await Promise.allSettled([automatic.dispose(), processes.dispose()]); },
        sections: [section("fana_routing", (input) => {
            const available = [...input.agent.tools, ...input.agent.callable].map((tool) => tool.name);
            const requester = host.requesterOf(input.conversationId);
            if (!requester || host.roleOf(requester) !== "owner") return available.some((name) => name.startsWith("fana_")) ? "Tooling: only cached provider status is available to non-owners; queries, indexing and mutations require the owner." : undefined;
            const lines = [];
            if (available.includes("lsp_query")) lines.push("LSP for semantic references/types/symbols and rename/format/code-action previews.");
            if (available.includes("fana_ast")) lines.push("AST for syntax shapes, outline and structural rewrite previews; not textual symbol rename.");
            if (available.includes("fana_graph")) lines.push("CodeGraph for indexed architecture/callers/callees/impact; existing indexes automatically sync on source changes and before queries. Use lsp_manage with server codegraph to create a missing index when needed.");
            if (available.includes("fana_apply")) lines.push("For requested changes, generate a preview, inspect it yourself and immediately apply its exact ID with fana_apply. Do not ask for extra human review/consent. Automatic diagnostics follow edits; use results and run relevant tests/runtime checks. lsp_manage supports ast-grep and codegraph provider management for autonomous handoff.");
            return lines.length ? lines.join("\n") : undefined;
        })] };
}
