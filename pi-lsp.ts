/**
 * pi-lsp: Language Server Protocol integration for Pi Pocket.
 * Exposes LSP tools to Pi and provides a management web UI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";

export interface ServerDef {
    id: string;
    name: string;
    languages: string[];
    binary: string;
    args: string[];
    installCmd?: string;
}

const SUPPORTED_SERVERS: Record<string, ServerDef> = {
    typescript: {
        id: "typescript",
        name: "TypeScript/JavaScript",
        languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
        binary: "typescript-language-server",
        args: ["--stdio"],
        installCmd: "npm install -g typescript typescript-language-server",
    },
    python: {
        id: "python",
        name: "Python (Pyright)",
        languages: ["python"],
        binary: "pyright-langserver",
        args: ["--stdio"],
        installCmd: "npm install -g pyright",
    },
    rust: {
        id: "rust",
        name: "Rust Analyzer",
        languages: ["rust"],
        binary: "rust-analyzer",
        args: [],
        installCmd: "rustup component add rust-analyzer",
    },
    go: {
        id: "go",
        name: "Go (gopls)",
        languages: ["go"],
        binary: "gopls",
        args: [],
        installCmd: "go install golang.org/x/tools/gopls@latest",
    },
};

interface ActiveClient {
    def: ServerDef;
    process: ChildProcess;
    workspaceRoot: string;
    reqId: number;
    pending: Map<number, (res: any) => void>;
    diagnostics: Map<string, any[]>;
    buffer: string;
}

const clients = new Map<string, ActiveClient>();

function sendLsp(client: ActiveClient, method: string, params: any): Promise<any> {
    const id = ++client.reqId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const full = `Content-Length: ${Buffer.byteLength(msg, "utf8")}\r\n\r\n${msg}`;

    return new Promise((resolve, reject) => {
        client.pending.set(id, resolve);
        client.process.stdin?.write(full, (err) => {
            if (err) {
                client.pending.delete(id);
                reject(err);
            }
        });
        setTimeout(() => {
            if (client.pending.has(id)) {
                client.pending.delete(id);
                resolve({ error: "LSP request timeout" });
            }
        }, 10000);
    });
}

function notifyLsp(client: ActiveClient, method: string, params: any) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const full = `Content-Length: ${Buffer.byteLength(msg, "utf8")}\r\n\r\n${msg}`;
    client.process.stdin?.write(full);
}

function handleLspData(client: ActiveClient, chunk: string) {
    client.buffer += chunk;
    while (true) {
        const headerEnd = client.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const header = client.buffer.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
            client.buffer = client.buffer.slice(headerEnd + 4);
            continue;
        }

        const len = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (client.buffer.length < bodyStart + len) break;

        const bodyStr = client.buffer.slice(bodyStart, bodyStart + len);
        client.buffer = client.buffer.slice(bodyStart + len);

        try {
            const parsed = JSON.parse(bodyStr);
            if (parsed.id !== undefined && client.pending.has(parsed.id)) {
                client.pending.get(parsed.id)?.(parsed.result ?? parsed);
                client.pending.delete(parsed.id);
            } else if (parsed.method === "textDocument/publishDiagnostics") {
                client.diagnostics.set(parsed.params.uri, parsed.params.diagnostics || []);
            }
        } catch {
            // ignore parse errors
        }
    }
}

async function startServer(def: ServerDef, cwd: string): Promise<ActiveClient> {
    const proc = spawn(def.binary, def.args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
    });

    const client: ActiveClient = {
        def,
        process: proc,
        workspaceRoot: cwd,
        reqId: 0,
        pending: new Map(),
        diagnostics: new Map(),
        buffer: "",
    };

    proc.stdout?.on("data", (d) => handleLspData(client, d.toString()));
    proc.on("error", () => {
        clients.delete(`${def.id}:${cwd}`);
    });
    proc.on("exit", () => {
        clients.delete(`${def.id}:${cwd}`);
    });

    clients.set(`${def.id}:${cwd}`, client);

    await sendLsp(client, "initialize", {
        processId: process.pid,
        rootUri: `file://${cwd}`,
        capabilities: {},
    });
    notifyLsp(client, "initialized", {});

    return client;
}

function findClient(serverId: string, cwd: string): ActiveClient | undefined {
    return clients.get(`${serverId}:${cwd}`);
}

function stopClient(key: string) {
    const client = clients.get(key);
    if (client) {
        try {
            client.process.kill();
        } catch {}
        clients.delete(key);
    }
}

export default function createPiLsp(host: PocketHost, web?: ExtensionWeb) {
    if (web) {
        web.client("pi-lsp.js", { access: "owner" });

        web.route(
            "GET",
            "servers",
            async () => {
                const list = Object.values(SUPPORTED_SERVERS).map((s) => {
                    const running = Array.from(clients.entries())
                        .filter(([k]) => k.startsWith(`${s.id}:`))
                        .map(([k, c]) => ({
                            cwd: c.workspaceRoot,
                            diagnosticsCount: Array.from(c.diagnostics.values()).reduce(
                                (acc, cur) => acc + cur.length,
                                0,
                            ),
                        }));
                    return {
                        ...s,
                        running: running.length > 0,
                        instances: running,
                    };
                });
                return { servers: list };
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "stop",
            async (req: WebRequest) => {
                const { serverId, cwd } = (req.body as any) || {};
                const key = `${serverId}:${cwd}`;
                stopClient(key);
                return { ok: true };
            },
            { access: "owner" },
        );

        web.onDispose(() => {
            for (const key of clients.keys()) {
                stopClient(key);
            }
        });
    }

    const lspStatusTool = defineTool({
        name: "lsp_status",
        description: "Check status of active Language Servers (LSP) in current workspace.",
        parameters: Type.Object({}),
        async execute(_args, context) {
            const active = Array.from(clients.values()).map((c) => ({
                server: c.def.id,
                name: c.def.name,
                workspace: c.workspaceRoot,
                diagnostics: Object.fromEntries(c.diagnostics.entries()),
            }));

            return {
                output: [
                    {
                        type: "text" as const,
                        text:
                            active.length === 0
                                ? "No LSP servers running."
                                : JSON.stringify(active, null, 2),
                    },
                ],
            };
        },
    });

    const lspDiagnosticsTool = defineTool({
        name: "lsp_diagnostics",
        description: "Get compiler and linter diagnostics reported by LSP for the workspace.",
        parameters: Type.Object({
            file: Type.Optional(Type.String({ description: "Optional specific file path" })),
        }),
        async execute(args, context) {
            const cwd = process.cwd();
            const matching = Array.from(clients.values()).filter((c) => c.workspaceRoot === cwd);
            const results: Record<string, any> = {};

            for (const c of matching) {
                for (const [uri, diags] of c.diagnostics.entries()) {
                    if (!args.file || uri.endsWith(args.file)) {
                        results[uri] = diags;
                    }
                }
            }

            return {
                output: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(results, null, 2),
                    },
                ],
            };
        },
    });

    const lspDefinitionTool = defineTool({
        name: "lsp_definition",
        description: "Jump to definition of symbol at file, line, and column.",
        parameters: Type.Object({
            server: Type.String({ description: "Language server id (e.g. typescript, python, rust, go)" }),
            file: Type.String({ description: "Path to file" }),
            line: Type.Number({ description: "0-based line number" }),
            character: Type.Number({ description: "0-based character offset" }),
        }),
        async execute(args, context) {
            const cwd = process.cwd();
            let client = findClient(args.server, cwd);
            if (!client) {
                const def = SUPPORTED_SERVERS[args.server];
                if (!def) {
                    return {
                        output: [{ type: "text" as const, text: `Unknown server ${args.server}` }],
                    };
                }
                client = await startServer(def, cwd);
            }

            const absPath = args.file.startsWith("/") ? args.file : join(cwd, args.file);
            const res = await sendLsp(client, "textDocument/definition", {
                textDocument: { uri: `file://${absPath}` },
                position: { line: args.line, character: args.character },
            });

            return {
                output: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(res, null, 2),
                    },
                ],
            };
        },
    });

    const lspManageTool = defineTool({
        name: "lsp_manage",
        description: "Start, stop, or query language server for current workspace.",
        parameters: Type.Object({
            server: Type.String({ description: "Server id (typescript, python, rust, go)" }),
            action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
        }),
        async execute(args, context) {
            const cwd = process.cwd();
            const key = `${args.server}:${cwd}`;
            if (args.action === "stop") {
                stopClient(key);
                return { output: [{ type: "text" as const, text: `Stopped ${args.server}` }] };
            }

            const def = SUPPORTED_SERVERS[args.server];
            if (!def) {
                return { output: [{ type: "text" as const, text: `Unsupported server ${args.server}` }] };
            }

            try {
                await startServer(def, cwd);
                return {
                    output: [{ type: "text" as const, text: `Started ${def.name} for ${cwd}` }],
                };
            } catch (err: any) {
                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `Failed to start ${def.name}: ${err.message}. Binary might be missing. Install command: ${def.installCmd}`,
                        },
                    ],
                };
            }
        },
    });

    return defineExtension({
        name: "pi-lsp",
        tools: [
            Object.assign(lspStatusTool, { annotations: { readOnlyHint: true } }),
            Object.assign(lspDiagnosticsTool, { annotations: { readOnlyHint: true } }),
            lspDefinitionTool,
            lspManageTool,
        ],
    });
}
