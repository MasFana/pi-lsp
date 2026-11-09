// pi-lsp browser module: status indicators and dashboard for language servers.
export const pocketApi = 2;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    function LspSection() {
        const [servers, setServers] = useState([]);
        const [loading, setLoading] = useState(true);

        const fetchServers = async () => {
            try {
                const res = await fetch("/api/x/pi-lsp/servers");
                if (res.ok) {
                    const data = await res.json();
                    setServers(data.servers || []);
                }
            } catch (err) {
                console.error("Failed to fetch LSP servers", err);
            } finally {
                setLoading(false);
            }
        };

        useEffect(() => {
            fetchServers();
            const interval = setInterval(fetchServers, 8000);
            return () => clearInterval(interval);
        }, []);

        const stopServer = async (serverId, cwd) => {
            await fetch("/api/x/pi-lsp/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ serverId, cwd }),
            });
            fetchServers();
        };

        if (loading) {
            return html`<div style="padding: 1rem; color: var(--text-dim, #888);">Loading LSP status...</div>`;
        }

        return html`
            <div style="padding: 0.75rem; font-family: inherit; font-size: 0.85rem;">
                <div style="font-weight: 600; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
                    <span>Language Servers</span>
                    <button
                        onClick=${fetchServers}
                        style="background: transparent; border: 1px solid var(--border, #444); color: inherit; padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 0.75rem;"
                    >
                        Refresh
                    </button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    ${servers.map((s) => {
                        const isRunning = s.running;
                        return html`
                            <div
                                style="border: 1px solid var(--border, #333); border-radius: 6px; padding: 0.5rem; background: var(--card-bg, rgba(255,255,255,0.02));"
                            >
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <div style="display: flex; align-items: center; gap: 6px;">
                                        <span
                                            style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${isRunning
                                                ? "var(--success, #22c55e)"
                                                : "var(--text-dim, #666)"};"
                                        ></span>
                                        <strong>${s.name}</strong>
                                    </div>
                                    <span style="font-size: 0.7rem; color: var(--text-dim, #888);">${s.binary}</span>
                                </div>
                                ${isRunning && s.instances.length > 0
                                    ? html`
                                          <div style="margin-top: 0.4rem; padding-top: 0.4rem; border-top: 1px solid var(--border, #333);">
                                              ${s.instances.map(
                                                  (inst) => html`
                                                      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                                                          <span style="overflow: hidden; text-overflow: ellipsis; max-width: 180px; white-space: nowrap;">
                                                              ${inst.cwd}
                                                          </span>
                                                          <div style="display: flex; gap: 8px; align-items: center;">
                                                              <span style="color: var(--accent, #3b82f6);">${inst.diagnosticsCount} diags</span>
                                                              <button
                                                                  onClick=${() => stopServer(s.id, inst.cwd)}
                                                                  style="background: transparent; border: 1px solid var(--danger, #ef4444); color: var(--danger, #ef4444); border-radius: 3px; font-size: 0.65rem; padding: 1px 4px; cursor: pointer;"
                                                              >
                                                                  Stop
                                                              </button>
                                                          </div>
                                                      </div>
                                                  `,
                                              )}
                                          </div>
                                      `
                                    : html`
                                          <div style="margin-top: 0.25rem; font-size: 0.7rem; color: var(--text-dim, #777);">
                                              ${s.installCmd ? `Install: ${s.installCmd}` : "Inactive"}
                                          </div>
                                      `}
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
