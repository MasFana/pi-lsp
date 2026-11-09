// pi-lsp browser module: status indicators, detection, and package installer/uninstaller dashboard.
export const pocketApi = 2;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    function LspSection() {
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
            return html`<div style="padding: 1rem; color: var(--text-dim, #888);">Loading LSP status...</div>`;
        }

        const filtered = servers.filter((s) => {
            if (filter === "running") return s.running;
            if (filter === "detected") return s.matched || s.running;
            return true;
        });

        return html`
            <div style="padding: 0.75rem; font-family: inherit; font-size: 0.85rem;">
                <div style="margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
                    <div>
                        <div style="font-weight: 600;">LSP Servers</div>
                        <div style="font-size: 0.7rem; color: var(--text-dim, #888); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${cwd}
                        </div>
                    </div>
                    <div style="display: flex; gap: 4px;">
                        <button
                            onClick=${() => setFilter("detected")}
                            style="background: ${filter === "detected" ? "var(--border, #444)" : "transparent"}; border: 1px solid var(--border, #444); color: inherit; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; cursor: pointer;"
                        >
                            Detected
                        </button>
                        <button
                            onClick=${() => setFilter("running")}
                            style="background: ${filter === "running" ? "var(--border, #444)" : "transparent"}; border: 1px solid var(--border, #444); color: inherit; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; cursor: pointer;"
                        >
                            Running
                        </button>
                        <button
                            onClick=${() => setFilter("all")}
                            style="background: ${filter === "all" ? "var(--border, #444)" : "transparent"}; border: 1px solid var(--border, #444); color: inherit; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; cursor: pointer;"
                        >
                            All
                        </button>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 480px; overflow-y: auto;">
                    ${filtered.length === 0
                        ? html`<div style="color: var(--text-dim, #888); font-size: 0.8rem; padding: 0.5rem 0;">No matching language servers.</div>`
                        : filtered.map((s) => {
                              const isRunning = s.running;
                              const isBusy = busy[s.id];

                              return html`
                                  <div
                                      style="border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.5rem; background: var(--card-bg, rgba(255,255,255,0.02));"
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
                                          <span style="font-size: 0.7rem; color: var(--text-dim, #888);">${s.command}</span>
                                      </div>

                                      <div style="margin-top: 0.3rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem;">
                                          <span style="color: var(--text-dim, #888);">
                                              Types: ${s.fileTypes.slice(0, 3).join(", ")}${s.fileTypes.length > 3 ? "…" : ""}
                                          </span>
                                          <div style="display: flex; gap: 4px; align-items: center;">
                                              ${isRunning
                                                  ? html`
                                                        <button
                                                            disabled=${Boolean(isBusy)}
                                                            onClick=${() => runAction("stop", s.id)}
                                                            style="background: transparent; border: 1px solid var(--danger, #ef4444); color: var(--danger, #ef4444); border-radius: 3px; font-size: 0.65rem; padding: 1px 5px; cursor: pointer;"
                                                        >
                                                            ${isBusy === "stop" ? "..." : "Stop"}
                                                        </button>
                                                    `
                                                  : s.available
                                                    ? html`
                                                          <button
                                                              disabled=${Boolean(isBusy)}
                                                              onClick=${() => runAction("start", s.id)}
                                                              style="background: transparent; border: 1px solid var(--success, #22c55e); color: var(--success, #22c55e); border-radius: 3px; font-size: 0.65rem; padding: 1px 5px; cursor: pointer;"
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
                                                                        style="background: transparent; border: 1px solid var(--accent, #3b82f6); color: var(--accent, #3b82f6); border-radius: 3px; font-size: 0.65rem; padding: 1px 5px; cursor: pointer;"
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
                                                            style="background: transparent; border: 1px solid var(--border, #555); color: var(--text-dim, #888); border-radius: 3px; font-size: 0.65rem; padding: 1px 5px; cursor: pointer;"
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

    if (pocket.section) {
        pocket.section({
            id: "pi-lsp",
            title: "Language Servers",
            content: LspSection,
        });
    }
}
