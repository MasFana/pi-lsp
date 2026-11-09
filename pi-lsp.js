// pi-lsp browser module: status indicators, detection, and package installer/uninstaller dashboard.
export const pocketApi = 2;

const CODE_ICON_PATH = "M16 18l6-6-6-6 M8 6l-6 6 6 6";

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    const serverPath = (cid) => cid === null ? "servers" : `c/${cid}/servers`;

    function LspSheet() {
        const [servers, setServers] = useState([]);
        const [cwd, setCwd] = useState("");
        const [loading, setLoading] = useState(true);
        const [filter, setFilter] = useState("detected"); // detected | running | all
        const [busy, setBusy] = useState({});
        const [error, setError] = useState("");
        const [actionError, setActionError] = useState("");
        const [conversationId, setConversationId] = useState(pocket.conversationId());
        const [refresh, setRefresh] = useState(0);
        const actions = useRef(new Map());
        const loadedFor = useRef(undefined);

        useEffect(() => pocket.onConversation(setConversationId), []);

        useEffect(() => {
            const stop = new AbortController();
            let reading = false;
            if (loadedFor.current !== conversationId) {
                loadedFor.current = conversationId;
                setServers([]);
                setCwd("");
                setActionError("");
                setLoading(true);
            }
            setError("");
            const fetchServers = async () => {
                if (reading) return;
                reading = true;
                try {
                    const data = await pocket.api(serverPath(conversationId), undefined, { signal: stop.signal });
                    if (!stop.signal.aborted && pocket.conversationId() === conversationId) {
                        setServers(data.servers);
                        setCwd(data.cwd);
                        setError("");
                    }
                } catch (failure) {
                    if (!stop.signal.aborted && pocket.conversationId() === conversationId) {
                        setError(failure.message);
                    }
                } finally {
                    reading = false;
                    if (!stop.signal.aborted && pocket.conversationId() === conversationId) setLoading(false);
                }
            };
            fetchServers();
            const interval = setInterval(fetchServers, 8000);
            return () => {
                stop.abort();
                clearInterval(interval);
            };
        }, [conversationId, refresh]);

        useEffect(() => {
            setBusy({});
            return () => {
                for (const stop of actions.current.values()) stop.abort();
                actions.current.clear();
            };
        }, [conversationId]);

        const runAction = async (action, serverId) => {
            if (!cwd || pocket.conversationId() !== conversationId || actions.current.has(serverId)) return;
            const stop = new AbortController();
            actions.current.set(serverId, stop);
            setBusy((b) => ({ ...b, [serverId]: action }));
            setActionError("");
            const bound = conversationId !== null && (action === "start" || action === "stop");
            try {
                await pocket.api(bound ? `c/${conversationId}/${action}` : action,
                    bound ? { serverId } : { serverId, cwd }, { signal: stop.signal });
                if (!stop.signal.aborted && pocket.conversationId() === conversationId) {
                    setRefresh((value) => value + 1);
                    updateStatus();
                }
            } catch (failure) {
                if (!stop.signal.aborted && pocket.conversationId() === conversationId) {
                    setActionError(failure.message);
                    pocket.notify("error", `LSP ${action} failed: ${failure.message}`);
                }
            } finally {
                if (actions.current.get(serverId) === stop) actions.current.delete(serverId);
                if (!stop.signal.aborted && pocket.conversationId() === conversationId) {
                    setBusy((b) => ({ ...b, [serverId]: null }));
                }
            }
        };

        if (loading) {
            return html`<div style="padding: 1.5rem; color: var(--text-dim, #888);">Loading LSP status...</div>`;
        }

        if (error) {
            return html`<div style="padding: 1rem;">
                <div class="error-box" role="alert">${error}</div>
                <button class="button" onClick=${() => setRefresh((value) => value + 1)}>Retry LSP status</button>
            </div>`;
        }

        const filtered = servers.filter((s) => {
            if (filter === "running") return s.running;
            if (filter === "detected") return s.matched || s.running;
            return true;
        });

        return html`
            <div style="padding: 1rem; font-family: inherit; font-size: 0.85rem; height: 100%; display: flex; flex-direction: column;">
                <div style="margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between;">
                    <div>
                        <div style="font-size: 0.75rem; color: var(--text-dim, #888); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${cwd}
                        </div>
                    </div>
                    <div style="display: flex; gap: 4px;">
                        <button
                            onClick=${() => setFilter("detected")}
                            style="background: ${filter === "detected" ? "var(--border, #444)" : "transparent"}; border: 1px solid var(--border, #444); color: inherit; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;"
                        >
                            Detected
                        </button>
                        <button
                            onClick=${() => setFilter("running")}
                            style="background: ${filter === "running" ? "var(--border, #444)" : "transparent"}; border: 1px solid var(--border, #444); color: inherit; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;"
                        >
                            Running
                        </button>
                        <button
                            onClick=${() => setFilter("all")}
                            style="background: ${filter === "all" ? "var(--border, #444)" : "transparent"}; border: 1px solid var(--border, #444); color: inherit; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer;"
                        >
                            All
                        </button>
                    </div>
                </div>

                ${actionError ? html`<div class="error-box" role="alert">${actionError}</div>` : ""}
                <div style="display: flex; flex-direction: column; gap: 0.6rem; overflow-y: auto; flex: 1;">
                    ${filtered.length === 0
                        ? html`<div class="muted" style="font-size: 0.85rem; padding: 1rem 0;">${filter === "running"
                            ? "No language servers running for this workspace."
                            : filter === "detected"
                              ? `No project matches in this workspace. Click All to browse ${servers.length} supported servers.`
                              : "No language servers returned."}</div>`
                        : filtered.map((s) => {
                              const isRunning = s.running;
                              const isBusy = busy[s.id];

                              return html`
                                  <div
                                      style="border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.65rem; background: var(--card-bg, rgba(255,255,255,0.02));"
                                  >
                                      <div style="display: flex; justify-content: space-between; align-items: center;">
                                          <div style="display: flex; align-items: center; gap: 6px;">
                                              <span
                                                  style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${isRunning
                                                      ? "var(--success, #22c55e)"
                                                      : s.available
                                                        ? "var(--accent, #3b82f6)"
                                                        : "var(--text-dim, #555)"};"
                                              ></span>
                                              <strong>${s.id}</strong>
                                              ${s.isLinter ? html`<span style="font-size: 0.65rem; color: var(--accent, #3b82f6); border: 1px solid var(--border, #444); border-radius: 3px; padding: 0 3px;">linter</span>` : ""}
                                          </div>
                                          <span style="font-size: 0.75rem; color: var(--text-dim, #888);">${s.command}</span>
                                      </div>

                                      <div style="margin-top: 0.4rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                                          <span style="color: var(--text-dim, #888);">
                                              Types: ${s.fileTypes.slice(0, 3).join(", ")}${s.fileTypes.length > 3 ? "…" : ""}
                                          </span>
                                          <div style="display: flex; gap: 6px; align-items: center;">
                                              ${isRunning
                                                  ? html`
                                                        <button
                                                            disabled=${Boolean(isBusy)}
                                                            onClick=${() => runAction("stop", s.id)}
                                                            style="background: transparent; border: 1px solid var(--danger, #ef4444); color: var(--danger, #ef4444); border-radius: 3px; font-size: 0.7rem; padding: 2px 6px; cursor: pointer;"
                                                        >
                                                            ${isBusy === "stop" ? "..." : "Stop"}
                                                        </button>
                                                    `
                                                  : s.available
                                                    ? html`
                                                          <button
                                                              disabled=${Boolean(isBusy)}
                                                              onClick=${() => runAction("start", s.id)}
                                                              style="background: transparent; border: 1px solid var(--success, #22c55e); color: var(--success, #22c55e); border-radius: 3px; font-size: 0.7rem; padding: 2px 6px; cursor: pointer;"
                                                          >
                                                              ${isBusy === "start" ? "..." : "Start"}
                                                          </button>
                                                      `
                                                    : html`
                                                          ${s.installCmd
                                                              ? html`
                                                                    <button
                                                                        disabled=${Boolean(isBusy)}
                                                                        onClick=${() => runAction("install", s.id)}
                                                                        style="background: transparent; border: 1px solid var(--accent, #3b82f6); color: var(--accent, #3b82f6); border-radius: 3px; font-size: 0.7rem; padding: 2px 6px; cursor: pointer;"
                                                                    >
                                                                        ${isBusy === "install" ? "Installing..." : "Install"}
                                                                    </button>
                                                                `
                                                              : html`<span style="color: var(--text-dim, #666);">Not installed</span>`}
                                                      `}
                                              ${s.available && s.uninstallCmd && !isRunning
                                                  ? html`
                                                        <button
                                                            disabled=${Boolean(isBusy)}
                                                            onClick=${() => runAction("uninstall", s.id)}
                                                            style="background: transparent; border: 1px solid var(--border, #555); color: var(--text-dim, #888); border-radius: 3px; font-size: 0.7rem; padding: 2px 6px; cursor: pointer;"
                                                        >
                                                            ${isBusy === "uninstall" ? "..." : "Uninstall"}
                                                        </button>
                                                    `
                                                  : ""}
                                          </div>
                                      </div>
                                  </div>
                              `;
                          })}
                </div>
            </div>
        `;
    }

    // Register slide-in sheet
    if (typeof pocket.sheet === "function") {
        pocket.sheet({
            id: "lsp",
            title: "Language Servers",
            component: LspSheet,
        });
    }

    // Register top / hamburger menu
    if (typeof pocket.menu === "function") {
        pocket.menu({
            id: "lsp",
            label: "Language Servers",
            hint: "Manage active and detected language servers",
            sheet: "lsp",
        });
    }

    // Register launcher entry (Cmd/Ctrl + K)
    if (typeof pocket.launcher === "function") {
        pocket.launcher({
            id: "lsp",
            label: "Language Servers",
            detail: "Diagnostics, LSP tools, and installed servers",
            iconPath: CODE_ICON_PATH,
            keywords: ["lsp", "code", "diagnostics", "definition", "server"],
            sheet: "lsp",
        });
    }

    // Register header status badge
    let statusItem = null;
    let statusRequest = null;
    let disposed = false;
    const clearStatus = () => {
        statusItem?.remove();
        statusItem = null;
    };
    const updateStatus = async () => {
        if (disposed) return;
        statusRequest?.abort();
        const stop = new AbortController();
        statusRequest = stop;
        const cid = pocket.conversationId();
        try {
            const data = await pocket.api(serverPath(cid), undefined, { signal: stop.signal });
            if (stop.signal.aborted || disposed || pocket.conversationId() !== cid) return;
            const runningCount = data.servers.filter((s) => s.running).length;
            if (runningCount > 0) {
                const item = {
                    id: "lsp",
                    title: "Language Server Protocol",
                    text: `${runningCount} LSP active`,
                    short: `${runningCount} LSP`,
                    sheet: "lsp",
                };
                if (statusItem) statusItem.update(item);
                else statusItem = pocket.status(item);
            } else clearStatus();
        } catch {
            // An unreadable status must not leave a stale active badge.
            if (!stop.signal.aborted && !disposed && pocket.conversationId() === cid) clearStatus();
        }
    };

    const stopConversation = pocket.onConversation(() => {
        clearStatus();
        updateStatus();
    });
    updateStatus();
    const statusInterval = setInterval(updateStatus, 15000);
    pocket.onDispose(() => {
        disposed = true;
        statusRequest?.abort();
        clearInterval(statusInterval);
        stopConversation();
        clearStatus();
    });
}
