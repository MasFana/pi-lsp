// One cached Tooling dashboard; owner actions execute directly without plugin confirmation dialogs.
export const pocketApi = 2;

const CODE_ICON_PATH = "M16 18l6-6-6-6 M8 6l-6 6 6 6";
const safeStr = (value) => (typeof value === "string" ? value.trim() : "");
const shortStr = (value) => safeStr(value).slice(0, 240);
const parsePos = (value) => {
    if (Number.isInteger(value) && value >= 0) return value + 1;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        const n = parseInt(value.trim(), 10);
        return Number.isSafeInteger(n) && n >= 0 ? n + 1 : null;
    }
    return null;
};
const MANAGE_LABELS = {
    start: "start language server", stop: "stop language server",
    install: "install language server", uninstall: "uninstall language server",
};
const QUERY_LABELS = {
    references: "find references", hover: "inspect symbol",
    document_symbols: "outline document", workspace_symbols: "find workspace symbols",
    implementation: "find implementations", code_actions: "inspect code actions",
    rename_preview: "preview semantic rename", format_preview: "preview formatting",
};
const AST_LABELS = {
    status: "check AST status", search: "search syntax", outline: "outline syntax",
    rewrite_preview: "preview structural rewrite",
};
const GRAPH_LABELS = {
    status: "check cached graph status", explore: "explore indexed code",
    callers: "find indexed callers", callees: "find indexed callees",
    impact: "inspect indexed impact", affected_tests: "find test candidates",
};
const displayValue = (value, depth = 0) => {
    if (value === undefined || value === null || value === "") return "Unknown";
    if (typeof value === "string") return value.slice(0, 600);
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "number") return String(value);
    if (depth >= 2) return JSON.stringify(value).slice(0, 600);
    if (Array.isArray(value)) {
        const text = value.slice(0, 12).map((item) => displayValue(item, depth + 1)).join(", ");
        return `${text || "None"}${value.length > 12 ? " …" : ""}`.slice(0, 600);
    }
    if (typeof value === "object") {
        return Object.entries(value).slice(0, 12)
            .map(([key, item]) => `${key}: ${displayValue(item, depth + 1)}`).join("; ").slice(0, 600) || "None";
    }
    return "Unknown";
};
const operationOutcome = (result) => {
    const details = [result?.message ?? `${result?.action ?? "Operation"}: ${result?.status ?? "unknown"}`];
    if (result?.executable) details.push(`Executable: ${result.executable}`);
    if (result?.version) details.push(`Version: ${result.version}`);
    if (result?.installer) details.push(`Installer exit: ${result.installer.exitCode ?? "unknown"}${result.installer.stderr ? ` · ${result.installer.stderr}` : ""}`);
    const stats = result?.operationResult;
    if (stats) details.push(`Files: +${stats.filesAdded ?? 0} ~${stats.filesModified ?? stats.filesIndexed ?? 0} -${stats.filesRemoved ?? 0}; errors: ${stats.filesErrored ?? 0}`);
    return details.join("\n").slice(0, 4000);
};
const displayTime = (value) => {
    if (value === undefined || value === null) return "Not checked";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
};
const serverAvailability = (server) => typeof server.available === "boolean" ? server.available
    : typeof server.installed === "boolean" ? server.installed : null;
const cachedAvailability = (status) => status?.checkedAt === undefined && !status?.executable && !status?.version
    ? "Not checked" : status?.available;
const messageOf = (failure) => shortStr(failure?.message) || "The request failed; status is unknown.";
const CARD_STYLE = "border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.75rem; margin-bottom: 0.65rem; overflow-wrap: anywhere;";
const ROW_STYLE = "display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;";

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    const toolingPath = (cid, action = "status") => cid === null
        ? `tooling/${action}` : `c/${cid}/tooling/${action}`;
    const registrations = [];
    const cleanups = new Set();
    const controllers = new Set();
    let disposed = false;
    const ownCleanup = (fn) => {
        let active = true;
        const cleanup = () => {
            if (!active) return;
            active = false;
            cleanups.delete(cleanup);
            fn();
        };
        cleanups.add(cleanup);
        return cleanup;
    };
    const newController = () => {
        const stop = new AbortController();
        controllers.add(stop);
        return stop;
    };
    const abortRequests = () => {
        for (const stop of controllers) stop.abort();
        controllers.clear();
    };
    const isOwner = () => pocket.me()?.role === "owner";

    function ToolingSheet() {
        const [snapshot, setSnapshot] = useState(null);
        const [loading, setLoading] = useState(true);
        const [tab, setTab] = useState("Overview");
        const [filter, setFilter] = useState("detected");
        const [busy, setBusy] = useState("");
        const [error, setError] = useState("");
        const [actionError, setActionError] = useState("");
        const [outcome, setOutcome] = useState("");
        const [conversationId, setConversationId] = useState(pocket.conversationId());
        const [refresh, setRefresh] = useState(0);
        const operation = useRef(null);
        const operationWorkspace = useRef("");
        const loadedFor = useRef(undefined);
        const owner = isOwner();
        const cwd = safeStr(snapshot?.cwd);

        useEffect(() => {
            const cancel = () => {
                operation.current?.abort();
                if (operation.current) controllers.delete(operation.current);
                operation.current = null;
                operationWorkspace.current = "";
                setBusy("");
            };
            const navigation = () => { cancel(); setRefresh((value) => value + 1); };
            const stopConversation = pocket.onConversation((cid) => {
                if (cid !== conversationId) cancel();
                setConversationId(cid);
            });
            window.addEventListener("pagehide", cancel);
            window.addEventListener("popstate", navigation);
            window.addEventListener("offline", cancel);
            window.addEventListener("pageshow", navigation);
            window.addEventListener("online", navigation);
            return ownCleanup(() => {
                stopConversation();
                window.removeEventListener("pagehide", cancel);
                window.removeEventListener("popstate", navigation);
                window.removeEventListener("offline", cancel);
                window.removeEventListener("pageshow", navigation);
                window.removeEventListener("online", navigation);
                cancel();
            });
        }, [conversationId]);

        useEffect(() => {
            if (!operation.current || operationWorkspace.current === cwd) return;
            operation.current?.abort();
            if (operation.current) controllers.delete(operation.current);
            operation.current = null;
            operationWorkspace.current = "";
            setBusy("");
            setActionError("Workspace changed; operation cancelled.");
        }, [cwd]);

        useEffect(() => {
            const changed = (evt) => {
                if (disposed) return;
                const eventCwd = safeStr(evt?.cwd);
                if (eventCwd && cwd && eventCwd !== cwd) return;
                setRefresh((value) => value + 1);
            };
            const stopLsp = pocket.on("lsp-changed", changed);
            return ownCleanup(stopLsp);
        }, [conversationId, cwd]);

        useEffect(() => {
            const stop = newController();
            let reading = false;
            if (loadedFor.current !== conversationId) {
                loadedFor.current = conversationId;
                setSnapshot(null);
                setActionError("");
                setOutcome("");
                setLoading(true);
            }
            const readCachedStatus = async () => {
                if (reading || stop.signal.aborted || disposed) return;
                reading = true;
                try {
                    const data = await pocket.api(toolingPath(conversationId), undefined, { signal: stop.signal });
                    if (!stop.signal.aborted && !disposed && pocket.conversationId() === conversationId) {
                        if (!data || typeof data.cwd !== "string" || !Array.isArray(data.servers)) {
                            throw new Error("Invalid cached Tooling status response.");
                        }
                        setSnapshot(data);
                        setError("");
                    }
                } catch (failure) {
                    if (!stop.signal.aborted && !disposed && pocket.conversationId() === conversationId) {
                        setError(messageOf(failure));
                    }
                } finally {
                    reading = false;
                    if (!stop.signal.aborted && !disposed && pocket.conversationId() === conversationId) setLoading(false);
                }
            };
            readCachedStatus();
            const interval = setInterval(readCachedStatus, 15000);
            return ownCleanup(() => {
                stop.abort();
                controllers.delete(stop);
                clearInterval(interval);
            });
        }, [conversationId, refresh]);


        const current = (stop) => !disposed && !stop.signal.aborted
            && pocket.conversationId() === conversationId && operation.current === stop;
        const locked = Boolean(busy || snapshot?.busy || error || loading);
        const startOperation = (label) => {
            if (!isOwner() || !cwd || error || operation.current || snapshot?.busy
                || pocket.conversationId() !== conversationId || disposed) return null;
            const stop = newController();
            operation.current = stop;
            operationWorkspace.current = cwd;
            setBusy(label);
            setActionError("");
            setOutcome("");
            return stop;
        };
        const finishOperation = (stop) => {
            controllers.delete(stop);
            if (operation.current === stop) {
                operation.current = null;
                if (!disposed && !stop.signal.aborted && pocket.conversationId() === conversationId) setBusy("");
            }
        };
        const failOperation = (stop, failure) => {
            if (!current(stop)) return;
            const message = messageOf(failure);
            setActionError(message);
            setRefresh((value) => value + 1);
            pocket.notify("error", `Tooling operation failed: ${message}`);
        };
        const runOperation = async (provider, action, extra = {}) => {
            const stop = startOperation(`${action} ${provider}`);
            if (!stop) return;
            try {
                const result = await pocket.api(toolingPath(conversationId, "execute"),
                    { provider, action, ...extra }, { signal: stop.signal });
                if (!current(stop)) return;
                if (action !== "refresh" || result?.status === "failed" || result?.status === "partial") setOutcome(operationOutcome(result));
                if (result?.status === "failed" || result?.status === "partial") setActionError(result?.error ?? result?.message ?? "Operation did not complete");
                setRefresh((value) => value + 1);
                updateStatus();
            } catch (failure) { failOperation(stop, failure); }
            finally { finishOperation(stop); }
        };
        const runLifecycle = async (action, serverId) => {
            const stop = startOperation(`${action} ${serverId}`);
            if (!stop) return;
            try {
                const bound = conversationId !== null;
                await pocket.api(bound ? `c/${conversationId}/${action}` : action,
                    bound ? { serverId } : { serverId, cwd }, { signal: stop.signal });
                if (current(stop)) {
                    setRefresh((value) => value + 1);
                    updateStatus();
                }
            } catch (failure) {
                failOperation(stop, failure);
            } finally {
                finishOperation(stop);
            }
        };
        const field = (label, value) => html`<div style="margin-top: 0.3rem;"><span class="muted">${label}: </span>${displayValue(value)}</div>`;
        const button = (label, run, disabled = false) => html`<button class="button" disabled=${!owner || locked || disabled} onClick=${run}>${label}</button>`;
        const providerCard = (provider, status) => html`<div style=${CARD_STYLE}>
            <strong>${provider === "ast" ? "AST · ast-grep" : "CodeGraph"}</strong>
            ${field("Installed / detected", cachedAvailability(status))}
            ${field("Version", status?.version)}
            ${field("Executable", status?.executable)}
            ${field("Provenance", status?.provenance)}
            ${field("Runtime", status?.runtime)}
            ${field("Runtime version", status?.runtimeVersion)}
            ${field("Runtime compatible", status?.compatible)}
            ${field("Capabilities", status?.actions)}
            ${field("Trust policy", status?.trustPolicy ?? status?.configPolicy ?? status?.configuration ?? status?.parserPolicy)}
            ${field("Provider checked at", displayTime(status?.checkedAt))}
            ${status?.error ? html`<div class="error-box" role="alert">${displayValue(status.error)}</div>` : ""}
            ${status?.automaticError ? html`<div class="error-box" role="alert">${status.automaticError}</div>` : ""}
            ${provider === "graph" ? field("Automatic sync", status?.automaticSync) : ""}
            <div style=${ROW_STYLE}>
                ${button("Refresh", () => runOperation(provider, "refresh"))}
                ${status?.canInstall || status?.installCmd ? button("Install", () => runOperation(provider, "install")) : ""}
                ${status?.canUninstall || status?.uninstallCmd ? button("Uninstall", () => runOperation(provider, "uninstall")) : ""}
            </div>
        </div>`;

        const servers = snapshot?.servers || [];
        const ast = snapshot?.ast;
        const graph = snapshot?.graph;
        const indexExists = graph?.checkedAt === undefined ? "Not checked" : graph?.initialized;
        const filtered = servers.filter((server) => filter === "running" ? server.running
            : filter === "detected" ? server.matched !== false || server.running : true);

        return html`<div style="padding: 1rem; font-size: 0.85rem; height: 100%; overflow-y: auto;">
            <div style="overflow-wrap: anywhere;"><strong>Tooling</strong>${field("Workspace", cwd || (loading ? "Loading" : "Unknown"))}</div>
            <p class="muted">Cached status only · polls every 15 seconds. Refresh is an explicit owner operation.</p>
            <div role="tablist" aria-label="Tooling providers" style=${ROW_STYLE}>
                ${["Overview", "LSP", "AST", "CodeGraph"].map((name) => html`<button class="button" role="tab"
                    aria-selected=${tab === name} onClick=${() => setTab(name)}>${name}</button>`)}
            </div>
            ${!owner ? html`<p class="muted">Owner permission is required to manage providers or apply proposals.</p>` : ""}
            ${loading ? html`<p class="muted">Loading cached Tooling status...</p>` : ""}
            ${error ? html`<div class="error-box" role="alert">${error}<br />Cached values may be out of date.
                <button class="button" onClick=${() => setRefresh((value) => value + 1)}>Retry cached status</button></div>` : ""}
            ${busy || snapshot?.busy ? html`<p role="status">${busy || displayValue(snapshot.busy)} · awaited operation; navigation cancels this request.</p>` : ""}
            ${actionError ? html`<div class="error-box" role="alert">${actionError}</div>` : ""}
            ${outcome ? html`<div style=${CARD_STYLE} role="status"><strong>Operation outcome</strong><div style="white-space: pre-wrap;">${outcome}</div></div>` : ""}
            ${snapshot && tab === "Overview" ? html`<div role="tabpanel" aria-label="Overview" style="margin-top: 0.8rem;">
                <div style=${CARD_STYLE}><strong>LSP</strong>${field("Active servers", servers.filter((server) => server.running).length)}
                    ${field("Detected project matches", servers.some((server) => server.matched === null || server.matched === undefined)
                        ? "Not checked for all servers" : servers.filter((server) => server.matched).length)}
                    ${button("Refresh LSP", () => runOperation("lsp", "refresh"))}</div>
                <div style=${CARD_STYLE}><strong>AST</strong>${field("Installed / detected", cachedAvailability(ast))}${field("Version", ast?.version)}
                    ${ast?.error ? html`<div class="error-box">${displayValue(ast.error)}</div>` : ""}</div>
                <div style=${CARD_STYLE}><strong>CodeGraph</strong>${field("Installed / detected", cachedAvailability(graph))}
                    ${field("Index exists", indexExists)}${field("Build state", graph?.buildState)}
                    ${field("Engine compatibility", graph?.engineCompatibility)}${field("Source freshness", graph?.sourceFreshness)}
                    ${graph?.error ? html`<div class="error-box">${displayValue(graph.error)}</div>` : ""}</div>
                <h3>Proposals</h3>
                ${(snapshot.proposals || []).length ? (snapshot.proposals || []).slice(0, 30).map((proposal) => html`<div style=${CARD_STYLE}>
                    <strong>${shortStr(proposal.title) || "Edit proposal"}</strong>${field("Proposal", proposal.id)}
                    ${field("Files", proposal.files)}${field("Includes server command", proposal.hasCommand)}
                    ${button("Apply", () => runOperation("lsp", "apply", { proposalId: proposal.id }))}
                </div>`) : html`<p class="muted">No pending proposals in this workspace.</p>`}
                ${(snapshot.proposals || []).length > 30 ? html`<p class="muted">Showing the first 30 proposals.</p>` : ""}
            </div>` : ""}
            ${snapshot && tab === "LSP" ? html`<div role="tabpanel" aria-label="LSP" style="margin-top: 0.8rem;">
                <div style=${ROW_STYLE}>${["detected", "running", "all"].map((value) => html`<button class="button"
                    aria-pressed=${filter === value} onClick=${() => setFilter(value)}>${value === "all" ? "All" : value === "running" ? "Running" : "Detected"}</button>`)}
                    ${button("Refresh", () => runOperation("lsp", "refresh"))}</div>
                ${filtered.length ? filtered.map((server) => html`<div style=${CARD_STYLE}>
                    <div style=${ROW_STYLE}><span style="width: 8px; height: 8px; border-radius: 50%; background: ${server.running
                        ? "var(--success, #22c55e)" : serverAvailability(server) === true ? "var(--accent, #3b82f6)" : "var(--text-dim, #555)"};"></span>
                        <strong>${server.id}</strong>${server.isLinter ? html`<span class="muted">linter</span>` : ""}</div>
                    ${field("Command", server.command)}${field("Types", server.fileTypes)}
                    ${field("Installed / detected", serverAvailability(server) === null ? "Not checked" : serverAvailability(server))}
                    ${field("Project match", server.matched === null || server.matched === undefined ? "Not checked" : server.matched)}${field("Running", server.running)}
                    ${field("Checked at", displayTime(server.checkedAt))}
                    ${field("Version", server.version)}${field("Provenance", server.provenance)}
                    ${field("Advertised capabilities", server.capabilities)}${field("Trust policy", server.trustPolicy)}
                    ${server.error || server.lastError ? html`<div class="error-box" role="alert">${displayValue(server.error || server.lastError)}</div>` : ""}
                    <div style=${ROW_STYLE}>
                        ${server.running ? button("Stop", () => runLifecycle("stop", server.id))
                            : serverAvailability(server) === true ? button("Start", () => runLifecycle("start", server.id))
                            : serverAvailability(server) === null ? html`<span class="muted">Not checked · use Refresh</span>`
                            : server.installCmd ? button("Install", () => runOperation("lsp", "install", { serverId: server.id }))
                            : html`<span class="muted">Not installed</span>`}
                        ${serverAvailability(server) === true && server.uninstallCmd && !server.running
                            ? button("Uninstall", () => runOperation("lsp", "uninstall", { serverId: server.id })) : ""}
                    </div>
                </div>`) : html`<p class="muted">${filter === "running" ? "No language servers running for this workspace."
                    : filter === "detected" ? `No project matches. Click All to browse ${servers.length} supported servers.` : "No language servers returned."}</p>`}
            </div>` : ""}
            ${snapshot && tab === "AST" ? html`<div role="tabpanel" aria-label="AST" style="margin-top: 0.8rem;">
                ${providerCard("ast", ast)}${field("Configuration policy", ast?.configPolicy ?? ast?.configuration)}
                ${field("Parser policy", ast?.parserPolicy)}
            </div>` : ""}
            ${snapshot && tab === "CodeGraph" ? html`<div role="tabpanel" aria-label="CodeGraph" style="margin-top: 0.8rem;">
                ${providerCard("graph", graph)}<div style=${CARD_STYLE}>
                    ${field("Project / index root", graph?.indexRoot)}${field("Index path", graph?.indexPath)}
                    ${field("Index exists", indexExists)}${field("Build state", graph?.buildState)}
                    ${field("Build version", graph?.buildVersion)}${field("Extraction version", graph?.extractionVersion)}
                    ${field("Built at", displayTime(graph?.builtAt))}${field("Index generation", graph?.generation)}
                    ${field("Engine compatibility", graph?.engineCompatibility)}${field("Source freshness", graph?.sourceFreshness)}
                    ${field("Freshness checked at", displayTime(graph?.sourceCheckedAt))}
                    ${field("Last operation", graph?.lastOperation)}
                    <p class="muted">Installation is not an index. Engine compatibility is distinct from source freshness; an unchecked timestamp does not prove current sources.</p>
                    <div style=${ROW_STYLE}>
                        ${button("Create index", () => runOperation("graph", "create"), !graph?.available || graph?.compatible === false || graph?.initialized !== false)}
                        ${button("Sync index", () => runOperation("graph", "sync"), !graph?.available || graph?.compatible === false || graph?.initialized !== true)}
                        ${button("Rebuild index", () => runOperation("graph", "rebuild"), !graph?.available || graph?.compatible === false || graph?.initialized !== true)}
                    </div>
                </div>
            </div>` : ""}
        </div>`;
    }

    registrations.push(pocket.sheet({ id: "lsp", title: "Tooling", component: ToolingSheet, wide: true }));
    registrations.push(pocket.menu({ id: "lsp", label: "Tooling", hint: "LSP · AST · CodeGraph", sheet: "lsp" }));
    registrations.push(pocket.launcher({
        id: "lsp", label: "Tooling", detail: "Language servers, structural AST, and indexed CodeGraph",
        iconPath: CODE_ICON_PATH, keywords: ["lsp", "ast", "codegraph", "code", "diagnostics", "definition", "server"], sheet: "lsp",
    }));
    // Preserve the original four call presentations and add provider-specific summaries.
    const toolCallHandles = [
        pocket.toolCall({
            tool: "lsp_status",
            iconPath: CODE_ICON_PATH,
            label: () => "check LSP status",
            subject: () => "current workspace",
            summary: () => ({ verb: "checked LSP status" }),
        }),
        pocket.toolCall({
            tool: "lsp_diagnostics",
            iconPath: CODE_ICON_PATH,
            label: (args) => safeStr(args?.file) ? "check file diagnostics" : "read cached diagnostics",
            subject: (args) => safeStr(args?.file) || "current workspace",
            summary: (args) => safeStr(args?.file)
                ? { verb: "checked", noun: "file", by: "file" }
                : { verb: "read cached diagnostics" },
        }),
        pocket.toolCall({
            tool: "lsp_definition",
            iconPath: CODE_ICON_PATH,
            label: () => "find definition",
            subject: (args) => {
                const file = safeStr(args?.file);
                const line = parsePos(args?.line);
                const col = parsePos(args?.character);
                const loc = file
                    ? line !== null && col !== null ? `${file}:${line}:${col}`
                        : line !== null ? `${file}:${line}` : file
                    : line !== null && col !== null ? `${line}:${col}` : "";
                return [loc, safeStr(args?.server)].filter(Boolean).join(" · ");
            },
            summary: (args) => safeStr(args?.file)
                ? { verb: "looked up", noun: "definition", by: "file" }
                : { verb: "looked up definitions" },
        }),
        pocket.toolCall({
            tool: "lsp_manage",
            iconPath: CODE_ICON_PATH,
            label: (args) => {
                const label = MANAGE_LABELS[safeStr(args?.action)];
                return typeof label === "string" ? label : "manage language server";
            },
            subject: (args) => safeStr(args?.server) || "language server",
            summary: (args) => {
                const action = safeStr(args?.action);
                if (action === "start") return { verb: "started", noun: "server", by: "server" };
                if (action === "stop") return { verb: "stopped", noun: "server", by: "server" };
                if (action === "install") return { verb: "installed", noun: "server", by: "server" };
                if (action === "uninstall") return { verb: "uninstalled", noun: "server", by: "server" };
                return { verb: "managed servers" };
            },
        }),
        pocket.toolCall({
            tool: "lsp_query", iconPath: CODE_ICON_PATH,
            label: (args) => typeof QUERY_LABELS[safeStr(args?.action)] === "string"
                ? QUERY_LABELS[safeStr(args?.action)] : "query language server",
            subject: (args) => shortStr(args?.file) || shortStr(args?.query) || "current workspace",
            summary: () => ({ verb: "queried semantic tooling" }),
        }),
        pocket.toolCall({
            tool: "fana_ast", iconPath: CODE_ICON_PATH,
            label: (args) => typeof AST_LABELS[safeStr(args?.action)] === "string"
                ? AST_LABELS[safeStr(args?.action)] : "query structural tooling",
            subject: (args) => Array.isArray(args?.paths)
                ? args.paths.slice(0, 3).map(shortStr).filter(Boolean).join(" · ") || "current workspace"
                : shortStr(args?.file) || "current workspace",
            summary: () => ({ verb: "queried structural tooling" }),
        }),
        pocket.toolCall({
            tool: "fana_graph", iconPath: CODE_ICON_PATH,
            label: (args) => typeof GRAPH_LABELS[safeStr(args?.action)] === "string"
                ? GRAPH_LABELS[safeStr(args?.action)] : "query indexed code",
            subject: (args) => shortStr(args?.symbol) || shortStr(args?.query) || shortStr(args?.file) || "current workspace",
            summary: () => ({ verb: "queried indexed evidence" }),
        }),
        pocket.toolCall({
            tool: "fana_apply", iconPath: CODE_ICON_PATH,
            label: () => "apply proposed operation",
            subject: (args) => shortStr(args?.proposalId) || "edit proposal",
            summary: () => ({ verb: "requested proposal application" }),
        }),
    ];

    // The badge also reads only cached metadata, never a provider status subprocess.
    let statusItem = null;
    let statusRequest = null;
    let lastCwd = "";
    const clearStatus = () => {
        statusItem?.remove();
        statusItem = null;
    };
    const updateStatus = async () => {
        if (disposed) return;
        statusRequest?.abort();
        const stop = newController();
        statusRequest = stop;
        const cid = pocket.conversationId();
        try {
            const data = await pocket.api(toolingPath(cid), undefined, { signal: stop.signal });
            if (stop.signal.aborted || disposed || pocket.conversationId() !== cid) return;
            if (!data || typeof data.cwd !== "string" || !Array.isArray(data.servers)) {
                throw new Error("Invalid cached Tooling status response.");
            }
            lastCwd = data.cwd;
            const runningCount = data.servers.filter((server) => server.running).length;
            const astState = cachedAvailability(data.ast) === "Not checked" ? "not checked"
                : data.ast?.available === true ? data.ast.compatible === false ? "incompatible" : data.ast.compatible === true ? "ready" : "detected"
                : data.ast?.available === false ? "missing" : "unknown";
            const graphState = cachedAvailability(data.graph) === "Not checked" ? "not checked"
                : data.graph?.available === false ? "missing"
                : data.graph?.compatible === false ? "incompatible"
                : data.graph?.initialized === false ? "no index"
                : data.graph?.initialized === true ? shortStr(data.graph.buildState) || "index present" : "unknown";
            const item = {
                id: "lsp", label: "Tooling", title: `Tooling · ${shortStr(data.cwd)} · cached provider status`,
                text: `${runningCount} LSP active · AST ${astState} · Graph ${graphState}`,
                short: `${runningCount} LSP · AST ${astState} · Graph ${graphState}`, sheet: "lsp",
                tone: data.ast?.error || data.graph?.error ? "error"
                    : data.graph?.engineCompatibility === "incompatible" || data.graph?.sourceFreshness === "known_changed" ? "warn" : undefined,
            };
            if (statusItem) statusItem.update(item);
            else statusItem = pocket.status(item);
        } catch {
            // An unreadable status must not leave stale provider claims in the badge.
            if (!stop.signal.aborted && !disposed && pocket.conversationId() === cid) clearStatus();
        } finally {
            controllers.delete(stop);
            if (statusRequest === stop) statusRequest = null;
        }
    };

    ownCleanup(pocket.onConversation(() => {
        abortRequests();
        lastCwd = "";
        clearStatus();
        updateStatus();
    }));
    const statusInterval = setInterval(updateStatus, 15000);
    ownCleanup(() => clearInterval(statusInterval));
    const changed = (evt) => {
        if (disposed) return;
        const eventCwd = safeStr(evt?.cwd);
        if (eventCwd && lastCwd && eventCwd !== lastCwd) return;
        updateStatus();
    };
    ownCleanup(pocket.on("lsp-changed", changed));
    window.addEventListener("pagehide", abortRequests);
    window.addEventListener("popstate", abortRequests);
    window.addEventListener("offline", abortRequests);
    window.addEventListener("online", updateStatus);
    window.addEventListener("pageshow", updateStatus);
    ownCleanup(() => {
        window.removeEventListener("pagehide", abortRequests);
        window.removeEventListener("popstate", abortRequests);
        window.removeEventListener("offline", abortRequests);
        window.removeEventListener("online", updateStatus);
        window.removeEventListener("pageshow", updateStatus);
    });
    pocket.onDispose(() => {
        disposed = true;
        abortRequests();
        for (const cleanup of [...cleanups]) cleanup();
        for (const handle of toolCallHandles) handle.remove();
        for (const handle of registrations) handle.remove();
        clearStatus();
    });
}
