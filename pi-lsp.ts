/**
 * pi-lsp: Full Language Server Protocol integration for Pi Pocket.
 * Supports auto-detection, execution, tool integration, and web-based installation/management.
 */
import { exec, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationWebRequest, ExtensionWeb, PocketHost, WebRequest } from "../host.ts";

const execAsync = promisify(exec);

export interface ServerConfig {
    command: string;
    args?: string[];
    fileTypes: string[];
    rootMarkers: string[];
    initOptions?: Record<string, any>;
    settings?: Record<string, any>;
    disabled?: boolean;
    isLinter?: boolean;
    installCmd?: string;
    uninstallCmd?: string;
}

export const LSP_SERVERS: Record<string, ServerConfig> = {
    "typescript-language-server": {
        command: "typescript-language-server",
        args: ["--stdio"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
        rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
        installCmd: "npm install -g typescript typescript-language-server",
        uninstallCmd: "npm uninstall -g typescript-language-server",
    },
    "typescript-native": {
        command: "tsc",
        args: ["--lsp", "--stdio"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
        rootMarkers: ["tsconfig.json", "package.json"],
        installCmd: "npm install -g typescript@next",
        uninstallCmd: "npm uninstall -g typescript",
    },
    "rust-analyzer": {
        command: "rust-analyzer",
        args: [],
        fileTypes: [".rs"],
        rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
        installCmd: "rustup component add rust-analyzer",
        uninstallCmd: "rustup component remove rust-analyzer",
    },
    gopls: {
        command: "gopls",
        args: ["serve"],
        fileTypes: [".go", ".mod", ".sum"],
        rootMarkers: ["go.mod", "go.work", "go.sum"],
        installCmd: "go install golang.org/x/tools/gopls@latest",
        uninstallCmd: "rm -f $(which gopls)",
    },
    pyright: {
        command: "pyright-langserver",
        args: ["--stdio"],
        fileTypes: [".py", ".pyi"],
        rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"],
        installCmd: "npm install -g pyright",
        uninstallCmd: "npm uninstall -g pyright",
    },
    basedpyright: {
        command: "basedpyright-langserver",
        args: ["--stdio"],
        fileTypes: [".py", ".pyi"],
        rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"],
        installCmd: "npm install -g basedpyright",
        uninstallCmd: "npm uninstall -g basedpyright",
    },
    pylsp: {
        command: "pylsp",
        args: [],
        fileTypes: [".py"],
        rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
        installCmd: "pip install 'python-lsp-server[all]'",
        uninstallCmd: "pip uninstall -y python-lsp-server",
    },
    ruff: {
        command: "ruff",
        args: ["server"],
        fileTypes: [".py", ".pyi"],
        rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
        isLinter: true,
        installCmd: "pip install ruff",
        uninstallCmd: "pip uninstall -y ruff",
    },
    ty: {
        command: "ty",
        args: ["server"],
        fileTypes: [".py", ".pyi"],
        rootMarkers: ["pyproject.toml", "ty.toml"],
        installCmd: "pip install ty",
        uninstallCmd: "pip uninstall -y ty",
    },
    clangd: {
        command: "clangd",
        args: ["--background-index", "--clang-tidy", "--header-insertion=iwyu"],
        fileTypes: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".cu", ".cuh", ".m", ".mm"],
        rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd", ".clang-format", "Makefile"],
        installCmd: "sudo apt-get install -y clangd || brew install llvm",
        uninstallCmd: "sudo apt-get remove -y clangd || brew uninstall llvm",
    },
    zls: {
        command: "zls",
        args: [],
        fileTypes: [".zig"],
        rootMarkers: ["build.zig", "build.zig.zon", "zls.json"],
        installCmd: "brew install zls",
        uninstallCmd: "brew uninstall zls",
    },
    denols: {
        command: "deno",
        args: ["lsp"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
        rootMarkers: ["deno.json", "deno.jsonc"],
        installCmd: "curl -fsSL https://deno.land/install.sh | sh",
    },
    biome: {
        command: "biome",
        args: ["lsp-proxy"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc", ".css"],
        rootMarkers: ["biome.json", "biome.jsonc"],
        isLinter: true,
        installCmd: "npm install -g @biomejs/biome",
        uninstallCmd: "npm uninstall -g @biomejs/biome",
    },
    eslint: {
        command: "vscode-eslint-language-server",
        args: ["--stdio"],
        fileTypes: [".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"],
        rootMarkers: [".eslintrc", ".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs"],
        isLinter: true,
        installCmd: "npm install -g vscode-langservers-extracted",
        uninstallCmd: "npm uninstall -g vscode-langservers-extracted",
    },
    "vscode-html-language-server": {
        command: "vscode-html-language-server",
        args: ["--stdio"],
        fileTypes: [".html", ".htm"],
        rootMarkers: ["package.json", ".git"],
        installCmd: "npm install -g vscode-langservers-extracted",
        uninstallCmd: "npm uninstall -g vscode-langservers-extracted",
    },
    "vscode-css-language-server": {
        command: "vscode-css-language-server",
        args: ["--stdio"],
        fileTypes: [".css", ".scss", ".less"],
        rootMarkers: ["package.json", ".git"],
        installCmd: "npm install -g vscode-langservers-extracted",
        uninstallCmd: "npm uninstall -g vscode-langservers-extracted",
    },
    "vscode-json-language-server": {
        command: "vscode-json-language-server",
        args: ["--stdio"],
        fileTypes: [".json", ".jsonc"],
        rootMarkers: ["package.json", ".git"],
        installCmd: "npm install -g vscode-langservers-extracted",
        uninstallCmd: "npm uninstall -g vscode-langservers-extracted",
    },
    tailwindcss: {
        command: "tailwindcss-language-server",
        args: ["--stdio"],
        fileTypes: [".html", ".css", ".scss", ".jsx", ".tsx", ".vue", ".svelte"],
        rootMarkers: ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.ts"],
        installCmd: "npm install -g @tailwindcss/language-server",
        uninstallCmd: "npm uninstall -g @tailwindcss/language-server",
    },
    svelte: {
        command: "svelteserver",
        args: ["--stdio"],
        fileTypes: [".svelte"],
        rootMarkers: ["svelte.config.js", "package.json"],
        installCmd: "npm install -g svelte-language-server",
        uninstallCmd: "npm uninstall -g svelte-language-server",
    },
    "vue-language-server": {
        command: "vue-language-server",
        args: ["--stdio"],
        fileTypes: [".vue"],
        rootMarkers: ["vite.config.ts", "vite.config.js", "package.json"],
        installCmd: "npm install -g @vue/language-server",
        uninstallCmd: "npm uninstall -g @vue/language-server",
    },
    astro: {
        command: "astro-ls",
        args: ["--stdio"],
        fileTypes: [".astro"],
        rootMarkers: ["astro.config.mjs", "astro.config.ts", "package.json"],
        installCmd: "npm install -g @astrojs/language-server",
        uninstallCmd: "npm uninstall -g @astrojs/language-server",
    },
    bashls: {
        command: "bash-language-server",
        args: ["start"],
        fileTypes: [".sh", ".bash", ".zsh"],
        rootMarkers: [".git", "Makefile"],
        installCmd: "npm install -g bash-language-server",
        uninstallCmd: "npm uninstall -g bash-language-server",
    },
    "lua-language-server": {
        command: "lua-language-server",
        args: [],
        fileTypes: [".lua"],
        rootMarkers: [".luarc.json", ".luacheckrc", ".git"],
        installCmd: "brew install lua-language-server",
        uninstallCmd: "brew uninstall lua-language-server",
    },
    yamlls: {
        command: "yaml-language-server",
        args: ["--stdio"],
        fileTypes: [".yaml", ".yml"],
        rootMarkers: [".git"],
        installCmd: "npm install -g yaml-language-server",
        uninstallCmd: "npm uninstall -g yaml-language-server",
    },
    dockerls: {
        command: "docker-langserver",
        args: ["--stdio"],
        fileTypes: ["Dockerfile", "dockerfile", ".dockerfile"],
        rootMarkers: ["Dockerfile", ".git"],
        installCmd: "npm install -g dockerfile-language-server-nodejs",
        uninstallCmd: "npm uninstall -g dockerfile-language-server-nodejs",
    },
    marksman: {
        command: "marksman",
        args: ["server"],
        fileTypes: [".md", ".markdown"],
        rootMarkers: [".marksman.toml", ".git"],
        installCmd: "brew install marksman",
        uninstallCmd: "brew uninstall marksman",
    },
    prismals: {
        command: "prisma-language-server",
        args: ["--stdio"],
        fileTypes: [".prisma"],
        rootMarkers: ["schema.prisma", "prisma/schema.prisma", "package.json"],
        installCmd: "npm install -g @prisma/language-server",
        uninstallCmd: "npm uninstall -g @prisma/language-server",
    },
    "emmet-language-server": {
        command: "emmet-language-server",
        args: ["--stdio"],
        fileTypes: [".html", ".css", ".jsx", ".tsx"],
        rootMarkers: ["package.json", ".git"],
        installCmd: "npm install -g @olrtg/emmet-language-server",
        uninstallCmd: "npm uninstall -g @olrtg/emmet-language-server",
    },
    intelephense: {
        command: "intelephense",
        args: ["--stdio"],
        fileTypes: [".php"],
        rootMarkers: ["composer.json", ".git"],
        installCmd: "npm install -g intelephense",
        uninstallCmd: "npm uninstall -g intelephense",
    },
    phpactor: {
        command: "phpactor",
        args: ["language-server"],
        fileTypes: [".php"],
        rootMarkers: ["composer.json", ".git"],
        installCmd: "composer global require phpactor/phpactor",
        uninstallCmd: "composer global remove phpactor/phpactor",
    },
    solargraph: {
        command: "solargraph",
        args: ["stdio"],
        fileTypes: [".rb"],
        rootMarkers: ["Gemfile", ".git"],
        installCmd: "gem install solargraph",
        uninstallCmd: "gem uninstall solargraph",
    },
    "ruby-lsp": {
        command: "ruby-lsp",
        args: [],
        fileTypes: [".rb"],
        rootMarkers: ["Gemfile", ".git"],
        installCmd: "gem install ruby-lsp",
        uninstallCmd: "gem uninstall ruby-lsp",
    },
    rubocop: {
        command: "rubocop",
        args: ["--lsp"],
        fileTypes: [".rb"],
        rootMarkers: [".rubocop.yml", "Gemfile", ".git"],
        isLinter: true,
        installCmd: "gem install rubocop",
        uninstallCmd: "gem uninstall rubocop",
    },
    elixirls: {
        command: "elixir-ls",
        args: [],
        fileTypes: [".ex", ".exs"],
        rootMarkers: ["mix.exs"],
        installCmd: "brew install elixir-ls",
        uninstallCmd: "brew uninstall elixir-ls",
    },
    erlangls: {
        command: "erlang_ls",
        args: [],
        fileTypes: [".erl", ".hrl"],
        rootMarkers: ["rebar.config"],
        installCmd: "brew install erlang-ls",
        uninstallCmd: "brew uninstall erlang-ls",
    },
    gleam: {
        command: "gleam",
        args: ["lsp"],
        fileTypes: [".gleam"],
        rootMarkers: ["gleam.toml"],
        installCmd: "brew install gleam",
        uninstallCmd: "brew uninstall gleam",
    },
    hls: {
        command: "haskell-language-server-wrapper",
        args: ["--lsp"],
        fileTypes: [".hs", ".lhs"],
        rootMarkers: ["cabal.project", "stack.yaml", "*.cabal"],
        installCmd: "ghcup install hls",
        uninstallCmd: "ghcup rm hls",
    },
    ocamllsp: {
        command: "ocamllsp",
        args: [],
        fileTypes: [".ml", ".mli"],
        rootMarkers: ["dune-project", "dune"],
        installCmd: "opam install ocaml-lsp-server",
        uninstallCmd: "opam remove ocaml-lsp-server",
    },
    jdtls: {
        command: "jdtls",
        args: [],
        fileTypes: [".java"],
        rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
        installCmd: "brew install jdtls",
        uninstallCmd: "brew uninstall jdtls",
    },
    "kotlin-lsp": {
        command: "kotlin-lsp",
        args: [],
        fileTypes: [".kt", ".kts"],
        rootMarkers: ["build.gradle.kts", "build.gradle", "pom.xml"],
        installCmd: "brew install kotlin-language-server",
        uninstallCmd: "brew uninstall kotlin-language-server",
    },
    metals: {
        command: "metals",
        args: [],
        fileTypes: [".scala", ".sbt"],
        rootMarkers: ["build.sbt", ".bloop"],
        installCmd: "brew install metals",
        uninstallCmd: "brew uninstall metals",
    },
    terraformls: {
        command: "terraform-ls",
        args: ["serve"],
        fileTypes: [".tf", ".tfvars"],
        rootMarkers: [".terraform", ".git"],
        installCmd: "brew install terraform-ls",
        uninstallCmd: "brew uninstall terraform-ls",
    },
    "helm-ls": {
        command: "helm_ls",
        args: ["serve"],
        fileTypes: [".yaml"],
        rootMarkers: ["Chart.yaml"],
        installCmd: "brew install helm-ls",
        uninstallCmd: "brew uninstall helm-ls",
    },
    nixd: {
        command: "nixd",
        args: [],
        fileTypes: [".nix"],
        rootMarkers: ["flake.nix", "default.nix"],
        installCmd: "nix-env -iA nixpkgs.nixd",
    },
    nil: {
        command: "nil",
        args: [],
        fileTypes: [".nix"],
        rootMarkers: ["flake.nix", "default.nix"],
        installCmd: "nix-env -iA nixpkgs.nil",
    },
    ols: {
        command: "ols",
        args: [],
        fileTypes: [".odin"],
        rootMarkers: ["ols.json", ".git"],
        installCmd: "brew install ols",
        uninstallCmd: "brew uninstall ols",
    },
    dartls: {
        command: "dart",
        args: ["language-server", "--client-id=pi-pocket"],
        fileTypes: [".dart"],
        rootMarkers: ["pubspec.yaml"],
        installCmd: "brew install dart",
        uninstallCmd: "brew uninstall dart",
    },
    texlab: {
        command: "texlab",
        args: [],
        fileTypes: [".tex", ".bib"],
        rootMarkers: [".latexmkrc", ".git"],
        installCmd: "brew install texlab",
        uninstallCmd: "brew uninstall texlab",
    },
    graphql: {
        command: "graphql-lsp",
        args: ["server", "-m", "stream"],
        fileTypes: [".graphql", ".gql"],
        rootMarkers: [".graphqlrc", ".graphqlrc.json", ".graphqlrc.yaml", ".git"],
        installCmd: "npm install -g graphql-language-service-cli",
        uninstallCmd: "npm uninstall -g graphql-language-service-cli",
    },
    vimls: {
        command: "vim-language-server",
        args: ["--stdio"],
        fileTypes: [".vim"],
        rootMarkers: [".git"],
        installCmd: "npm install -g vim-language-server",
        uninstallCmd: "npm uninstall -g vim-language-server",
    },
    omnisharp: {
        command: "omnisharp",
        args: ["-lsp"],
        fileTypes: [".cs"],
        rootMarkers: ["*.sln", "*.csproj"],
        installCmd: "brew install omnisharp",
        uninstallCmd: "brew uninstall omnisharp",
    },
    "sourcekit-lsp": {
        command: "sourcekit-lsp",
        args: [],
        fileTypes: [".swift"],
        rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
        installCmd: "xcode-select --install",
    },
    swiftlint: {
        command: "swiftlint",
        args: ["--lint"],
        fileTypes: [".swift"],
        rootMarkers: [".swiftlint.yml", "Package.swift"],
        isLinter: true,
        installCmd: "brew install swiftlint",
        uninstallCmd: "brew uninstall swiftlint",
    },
    tlaplus: {
        command: "tlapm_lsp",
        args: ["--stdio"],
        fileTypes: [".tla", ".tlaplus"],
        rootMarkers: ["*.tla"],
    },
};

interface ActiveClient {
    id: string;
    config: ServerConfig;
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
        } catch {}
    }
}

async function isBinaryAvailable(command: string, cwd: string): Promise<boolean> {
    const localBin = join(cwd, "node_modules", ".bin", command);
    if (existsSync(localBin)) return true;
    try {
        await execAsync(`which ${command}`);
        return true;
    } catch {
        return false;
    }
}

function matchesMarkers(rootMarkers: string[], cwd: string): boolean {
    try {
        const files = readdirSync(cwd);
        for (const marker of rootMarkers) {
            if (marker.startsWith("*.")) {
                const ext = marker.slice(1);
                if (files.some((f) => f.endsWith(ext))) return true;
            } else if (files.includes(marker)) {
                return true;
            }
        }
    } catch {}
    return false;
}

async function startServer(id: string, config: ServerConfig, cwd: string): Promise<ActiveClient> {
    const localBin = join(cwd, "node_modules", ".bin", config.command);
    const bin = existsSync(localBin) ? localBin : config.command;
    const proc = spawn(bin, config.args ?? [], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
    });

    const client: ActiveClient = {
        id,
        config,
        process: proc,
        workspaceRoot: cwd,
        reqId: 0,
        pending: new Map(),
        diagnostics: new Map(),
        buffer: "",
    };

    proc.stdout?.on("data", (d) => handleLspData(client, d.toString()));
    proc.on("error", () => {
        clients.delete(`${id}:${cwd}`);
    });
    proc.on("exit", () => {
        clients.delete(`${id}:${cwd}`);
    });

    clients.set(`${id}:${cwd}`, client);

    await sendLsp(client, "initialize", {
        processId: process.pid,
        rootUri: `file://${cwd}`,
        capabilities: {},
        initializationOptions: config.initOptions || {},
    });
    notifyLsp(client, "initialized", {});

    return client;
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

async function getServersForCwd(cwd: string) {
    return Promise.all(
        Object.entries(LSP_SERVERS).map(async ([id, conf]) => {
            const available = await isBinaryAvailable(conf.command, cwd);
            const matched = matchesMarkers(conf.rootMarkers, cwd);
            const running = Array.from(clients.entries())
                .filter(([k]) => k.startsWith(`${id}:`))
                .map(([, c]) => ({
                    cwd: c.workspaceRoot,
                    diagnosticsCount: Array.from(c.diagnostics.values()).reduce(
                        (acc, cur) => acc + cur.length,
                        0,
                    ),
                }));
            return {
                id,
                command: conf.command,
                fileTypes: conf.fileTypes,
                rootMarkers: conf.rootMarkers,
                isLinter: Boolean(conf.isLinter),
                installCmd: conf.installCmd,
                uninstallCmd: conf.uninstallCmd,
                available,
                matched,
                running: running.length > 0,
                instances: running,
            };
        }),
    );
}

export default function createPiLsp(host: PocketHost, web?: ExtensionWeb) {
    if (web) {
        web.client("pi-lsp.js", { access: "owner" });

        // Global fallback
        web.route(
            "GET",
            "servers",
            async (req: WebRequest) => {
                const cwd = (req.query.get("cwd") as string) || process.cwd();
                const list = await getServersForCwd(cwd);
                return { servers: list, cwd };
            },
            { access: "owner" },
        );

        // Per-conversation route
        web.conversationRoute(
            "GET",
            "c/:conversation/servers",
            async (req: ConversationWebRequest) => {
                const cwd = req.conversation.cwd;
                const list = await getServersForCwd(cwd);
                return { servers: list, cwd };
            },
            { conversation: "conversation", access: "owner" },
        );

        web.route(
            "POST",
            "stop",
            async (req: WebRequest) => {
                const { serverId, cwd } = (req.body as any) || {};
                const key = `${serverId}:${cwd || process.cwd()}`;
                stopClient(key);
                return { ok: true };
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "start",
            async (req: WebRequest) => {
                const { serverId, cwd = process.cwd() } = (req.body as any) || {};
                const conf = LSP_SERVERS[serverId];
                if (!conf) throw web.error(404, `Unknown server ${serverId}`);
                await startServer(serverId, conf, cwd);
                return { ok: true };
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "install",
            async (req: WebRequest) => {
                const { serverId } = (req.body as any) || {};
                const conf = LSP_SERVERS[serverId];
                if (!conf?.installCmd) throw web.error(400, "No install command available");
                try {
                    const { stdout, stderr } = await execAsync(conf.installCmd);
                    return { ok: true, output: stdout || stderr };
                } catch (err: any) {
                    throw web.error(500, err.message);
                }
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "uninstall",
            async (req: WebRequest) => {
                const { serverId } = (req.body as any) || {};
                const conf = LSP_SERVERS[serverId];
                if (!conf?.uninstallCmd) throw web.error(400, "No uninstall command available");
                try {
                    const { stdout, stderr } = await execAsync(conf.uninstallCmd);
                    return { ok: true, output: stdout || stderr };
                } catch (err: any) {
                    throw web.error(500, err.message);
                }
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
        description: "Check status of active and detected Language Servers (LSP) in workspace.",
        parameters: Type.Object({}),
        async execute(_args, context) {
            const cwd = process.cwd();
            const active = Array.from(clients.values()).map((c) => ({
                id: c.id,
                command: c.config.command,
                workspace: c.workspaceRoot,
                diagnosticsCount: Array.from(c.diagnostics.values()).reduce(
                    (acc, cur) => acc + cur.length,
                    0,
                ),
            }));

            const detected = [];
            for (const [id, conf] of Object.entries(LSP_SERVERS)) {
                if (matchesMarkers(conf.rootMarkers, cwd)) {
                    detected.push({
                        id,
                        command: conf.command,
                        available: await isBinaryAvailable(conf.command, cwd),
                        installCmd: conf.installCmd,
                    });
                }
            }

            return {
                output: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({ active, detected, cwd }, null, 2),
                    },
                ],
            };
        },
    });

    const lspDiagnosticsTool = defineTool({
        name: "lsp_diagnostics",
        description: "Get compiler and linter diagnostics reported by LSP for workspace.",
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
            server: Type.String({ description: "Language server id (e.g. rust-analyzer, gopls, pyright)" }),
            file: Type.String({ description: "Path to file" }),
            line: Type.Number({ description: "0-based line number" }),
            character: Type.Number({ description: "0-based character offset" }),
        }),
        async execute(args, context) {
            const cwd = process.cwd();
            let client = clients.get(`${args.server}:${cwd}`);
            if (!client) {
                const conf = LSP_SERVERS[args.server];
                if (!conf) {
                    return {
                        output: [{ type: "text" as const, text: `Unknown server ${args.server}` }],
                    };
                }
                client = await startServer(args.server, conf, cwd);
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
        description: "Start, stop, install, or uninstall language server.",
        parameters: Type.Object({
            server: Type.String({ description: "Server id" }),
            action: Type.Union([
                Type.Literal("start"),
                Type.Literal("stop"),
                Type.Literal("install"),
                Type.Literal("uninstall"),
            ]),
        }),
        async execute(args, context) {
            const cwd = process.cwd();
            const key = `${args.server}:${cwd}`;

            if (args.action === "stop") {
                stopClient(key);
                return { output: [{ type: "text" as const, text: `Stopped ${args.server}` }] };
            }

            const conf = LSP_SERVERS[args.server];
            if (!conf) {
                return { output: [{ type: "text" as const, text: `Unsupported server ${args.server}` }] };
            }

            if (args.action === "start") {
                try {
                    await startServer(args.server, conf, cwd);
                    return {
                        output: [{ type: "text" as const, text: `Started ${args.server} for ${cwd}` }],
                    };
                } catch (err: any) {
                    return {
                        output: [
                            {
                                type: "text" as const,
                                text: `Failed to start ${args.server}: ${err.message}. Install command: ${conf.installCmd || "none"}`,
                            },
                        ],
                    };
                }
            }

            if (args.action === "install") {
                if (!conf.installCmd) {
                    return { output: [{ type: "text" as const, text: `No install command for ${args.server}` }] };
                }
                try {
                    const { stdout, stderr } = await execAsync(conf.installCmd);
                    return { output: [{ type: "text" as const, text: `Installed:\n${stdout || stderr}` }] };
                } catch (err: any) {
                    return { output: [{ type: "text" as const, text: `Install failed: ${err.message}` }] };
                }
            }

            if (args.action === "uninstall") {
                if (!conf.uninstallCmd) {
                    return { output: [{ type: "text" as const, text: `No uninstall command for ${args.server}` }] };
                }
                try {
                    const { stdout, stderr } = await execAsync(conf.uninstallCmd);
                    return { output: [{ type: "text" as const, text: `Uninstalled:\n${stdout || stderr}` }] };
                } catch (err: any) {
                    return { output: [{ type: "text" as const, text: `Uninstall failed: ${err.message}` }] };
                }
            }

            return { output: [{ type: "text" as const, text: "Invalid action" }] };
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
