// pi-lsp browser module: status indicators, detection, and package installer/uninstaller dashboard.
export const pocketApi = 2;

const CODE_ICON_PATH = "M16 18l6-6-6-6 M8 6l-6 6 6 6";

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    function LspSheet() {
        const [servers, setServers] = useState([]);
        const [cwd, setCwd] = useState("");
        const [loading, setLoading] = useState(true);
        const [filter, setFilter] = useState("detected"); // detected | running | all
        const [busy, setBusy] = useState({});

        const fetchServers = async () => {
            try {
                const res = await fetch("/api/x/pi-lsp/servers");
                if (res.ok) {
                    const data = await res.json();
                    setServers(data.servers || []);
                    setCwd(data.cwd || "");
                }
            } catch (err) {
                console.error("Failed to fetch LSP servers", err);
            } finally {
                setLoading(false);
            }
        };

        useEffect(() => {
            fetchServers();
            const interval = setInterval(fetchServers, 10000);
            return () => clearInterval(interval);
        }, []);

        const runAction = async (action, serverId, payload = {}) => {
            setBusy((b) => ({ ...b, [serverId]: action }));
            try {
                await fetch(`/api/x/pi-lsp/${action}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ serverId, ...payload }),
                });
                await fetchServers();
            } catch (err) {
                alert(`Action ${action} failed: ${err.message}`);
            } finally {
                setBusy((b) => ({ ...b, [serverId]: null }));
            }
        };

        if (loading) {
            return html`<div style="padding: 1.5rem; color: var(--text-dim, #888);">Loading LSP status...</div>`;
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
                        <div style="font-weight: 600; font-size: 1rem;">Language Servers</div>
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

                <div style="display: flex; flex-direction: column; gap: 0.6rem; overflow-y: auto; flex: 1;">
                    ${filtered.length === 0
                        ? html`<div style="color: var(--text-dim, #888); font-size: 0.85rem; padding: 1rem 0;">No matching language servers.</div>`
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
    const updateStatus = async () => {
        if (typeof pocket.status !== "function") return;
        try {
            const res = await fetch("/api/x/pi-lsp/servers");
            if (res.ok) {
                const data = await res.json();
                const runningCount = (data.servers || []).filter((s) => s.running).length;
                if (runningCount > 0) {
                    const item = {
                        id: "lsp",
                        title: "Language Server Protocol",
                        label: `${runningCount} LSP active`,
                        sheet: "lsp",
                    };
                    if (!statusItem) statusItem = pocket.status(item);
                    else statusItem.update(item);
                } else if (statusItem) {
                    statusItem.remove();
                    statusItem = null;
                }
            }
        } catch {}
    };

    updateStatus();
    const statusInterval = setInterval(updateStatus, 15000);
    pocket.onDispose?.(() => clearInterval(statusInterval));
}
