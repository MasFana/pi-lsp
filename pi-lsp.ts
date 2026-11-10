/**
 * pi-lsp: Full Language Server Protocol integration for Pi Pocket.
 * Supports auto-detection, execution, tool integration, and web-based installation/management.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Host as PocketHost, Web as ExtensionWeb, WebRequest, ConversationWebRequest } from "./_pocket.d.ts";
import { createTooling } from "./pi-lsp/v1.3.1/tooling.ts";
import { canonicalFile } from "./pi-lsp/v1.3.1/proposals.ts";

export const pocketApi = 2;



export interface ServerConfig {
    command: string;
    args?: string[];
    fileTypes: string[];
    rootMarkers: string[];
    initOptions?: Record<string, unknown>;
    settings?: Record<string, unknown>;
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

export function workspaceScheme(cwd?: string): string | undefined {
    if (!cwd || typeof cwd !== "string") return undefined;
    return /^([a-z][a-z0-9+.-]+):\/\//i.exec(cwd)?.[1]?.toLowerCase();
}

function isObject(val: unknown): val is Record<string, unknown> {
    return typeof val === "object" && val !== null;
}

async function getSessionCwd(api: ToolExecutionApi, context: Context): Promise<string> {
    const cwd = api.env?.cwd ?? (await api.agent(context)).cwd;
    if (!cwd) throw new Error("No session workspace found");
    if (workspaceScheme(cwd)) throw new Error(`Remote workspaces are not supported: ${cwd}`);
    return realpathSync(resolve(cwd));
}

function isExecutableFile(candidate: string): boolean {
    try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function findExecutable(command: string, cwd: string): string | undefined {
    if (!command) return undefined;

    if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
        const direct = resolve(cwd, command);
        if (isExecutableFile(direct)) return direct;
        return undefined;
    }

    let cur = resolve(cwd);
    while (true) {
        const candidate = join(cur, "node_modules", ".bin", command);
        if (isExecutableFile(candidate)) return candidate;
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }

    const pathDirs = (process.env.PATH || "").split(delimiter);
    const pathext = process.platform === "win32"
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
        : [""];

    for (const dir of pathDirs) {
        if (!dir) continue;
        for (const ext of pathext) {
            const candidate = join(dir, command + ext);
            if (isExecutableFile(candidate)) return candidate;
        }
    }

    return undefined;
}

export function matchesMarkersOrExtensions(conf: ServerConfig, cwd: string): boolean {
    if (workspaceScheme(cwd)) return false;

    let cur = resolve(cwd);
    while (true) {
        try {
            if (conf.rootMarkers && conf.rootMarkers.length > 0) {
                for (const marker of conf.rootMarkers) {
                    if (!marker.startsWith("*.")) {
                        if (existsSync(join(cur, marker))) return true;
                    }
                }
                const wildcardMarkers = conf.rootMarkers.filter((m) => m.startsWith("*."));
                if (wildcardMarkers.length > 0) {
                    const entries = readdirSync(cur);
                    for (const marker of wildcardMarkers) {
                        const ext = marker.slice(1);
                        if (entries.some((e) => e.endsWith(ext))) return true;
                    }
                }
            }
        } catch {}
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }

    if (conf.fileTypes && conf.fileTypes.length > 0) {
        try {
            const entries = readdirSync(cwd, { withFileTypes: true });
            for (const dirent of entries) {
                if (dirent.isFile() && conf.fileTypes.some((ext) => dirent.name.endsWith(ext))) {
                    return true;
                }
            }
            for (const dirent of entries) {
                if (
                    dirent.isDirectory() &&
                    !dirent.name.startsWith(".") &&
                    dirent.name !== "node_modules" &&
                    dirent.name !== "dist" &&
                    dirent.name !== "build"
                ) {
                    try {
                        const sub = readdirSync(join(cwd, dirent.name));
                        if (sub.some((f) => conf.fileTypes.some((ext) => f.endsWith(ext)))) {
                            return true;
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    return false;
}

export interface PendingRequest {
    resolve: (res: unknown) => void;
    reject: (err: unknown) => void;
    timer: NodeJS.Timeout;
}

export interface DiagnosticWaiter {
    minVersion: number;
    resolve: (diags: unknown[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

export interface ActiveClient {
    id: string;
    config: ServerConfig;
    process: ChildProcess;
    workspaceRoot: string;
    reqId: number;
    pending: Map<number, PendingRequest>;
    diagnostics: Map<string, unknown[]>;
    diagnosticMeta: Map<string, { version?: number; stale: boolean }>;
    diagnosticWaiters: Map<string, Set<DiagnosticWaiter>>;
    serverCapabilities?: Record<string, unknown>;
    applyEditHandler?: (edit: unknown) => Promise<{ applied: boolean; failureReason?: string }>;
    buffer: Buffer;
    openFiles: Map<string, { version: number; text: string }>;
    running: boolean;
    stderrTail: string;
}

export const clients = new Map<string, ActiveClient>();
const starting = new Map<string, Promise<ActiveClient>>();
const serverStatusCache = new Map<string, Record<string, unknown>[]>();
let notifyChange: ((cwd: string) => void) | undefined;
const INCOMPLETE_TOOL_RESULTS: Record<string, true> = {
    blocked: true, invalid_arguments: true, aborted: true,
    interrupted: true, abandoned: true, restart_limit: true,
};

function rejectAllWaiters(client: ActiveClient, err: Error): void {
    for (const waiters of client.diagnosticWaiters.values()) {
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(err);
        }
        waiters.clear();
    }
    client.diagnosticWaiters.clear();
}
const HEADER_DELIM = Buffer.from("\r\n\r\n");

function cancellationError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("LSP request canceled");
}

function sendLsp(client: ActiveClient, method: string, params: unknown, timeoutMs = 10000, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(cancellationError(signal));
    if (!client.running && method !== "initialize" && method !== "shutdown") {
        return Promise.reject(new Error(`LSP server ${client.id} is not running`));
    }
    if (!client.process.stdin?.writable) return Promise.reject(new Error(`LSP server ${client.id} stdin is not writable`));
    const id = ++client.reqId;
    const content = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
    const header = Buffer.from(`Content-Length: ${content.length}\r\n\r\n`, "utf8");
    const { promise, resolve: complete, reject: fail } = Promise.withResolvers<unknown>();
    const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        client.pending.delete(id);
    };
    const reject = (error: unknown) => { cleanup(); fail(error); };
    const onAbort = () => {
        if (!client.pending.has(id)) return;
        reject(cancellationError(signal!));
        notifyLsp(client, "$/cancelRequest", { id });
    };
    const timer = setTimeout(() => reject(new Error(`LSP request ${method} (id ${id}) timed out after ${timeoutMs}ms`)), timeoutMs);
    client.pending.set(id, { resolve: (result) => { cleanup(); complete(result); }, reject, timer });
    signal?.addEventListener("abort", onAbort, { once: true });
    client.process.stdin.write(Buffer.concat([header, content]), (error) => { if (error) reject(error); });
    return promise;
}

function notifyLsp(client: ActiveClient, method: string, params: unknown): void {
    if (!client.process.stdin?.writable) return;
    try {
        const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
        const content = Buffer.from(msg, "utf8");
        const header = Buffer.from(`Content-Length: ${content.length}\r\n\r\n`, "utf8");
        client.process.stdin.write(Buffer.concat([header, content]));
    } catch {}
}

function sendLspResponse(client: ActiveClient, id: number | string, result: unknown, error?: unknown): void {
    if (!client.process.stdin?.writable) return;
    try {
        const payload: Record<string, unknown> = { jsonrpc: "2.0", id };
        if (error !== undefined) {
            payload.error = error;
        } else {
            payload.result = result;
        }
        const msg = JSON.stringify(payload);
        const content = Buffer.from(msg, "utf8");
        const header = Buffer.from(`Content-Length: ${content.length}\r\n\r\n`, "utf8");
        client.process.stdin.write(Buffer.concat([header, content]));
    } catch {}
}

function getRequestBody(req: WebRequest): Record<string, unknown> {
    return isObject(req.body) ? req.body : {};
}

function handleLspData(client: ActiveClient, chunk: Buffer) {
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (true) {
        const headerEnd = client.buffer.indexOf(HEADER_DELIM);
        if (headerEnd === -1) break;

        const headerStr = client.buffer.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
        if (!match) {
            client.buffer = client.buffer.subarray(headerEnd + 4);
            continue;
        }

        const len = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (client.buffer.length < bodyStart + len) break;

        const bodyBuf = client.buffer.subarray(bodyStart, bodyStart + len);
        client.buffer = client.buffer.subarray(bodyStart + len);

        try {
            const parsed = JSON.parse(bodyBuf.toString("utf8"));

            if (parsed.method === undefined && parsed.id !== undefined && client.pending.has(parsed.id)) {
                const req = client.pending.get(parsed.id)!;
                client.pending.delete(parsed.id);
                clearTimeout(req.timer);

                if (parsed.error !== undefined) {
                    const err = Object.assign(
                        new Error(parsed.error.message || `LSP RPC error ${parsed.error.code}`),
                        { rpcError: parsed.error },
                    );
                    req.reject(err);
                } else {
                    req.resolve(parsed.result ?? null);
                }
            } else if (parsed.method !== undefined && parsed.id !== undefined) {
                if (parsed.method === "workspace/configuration") {
                    const items = Array.isArray(parsed.params?.items) ? parsed.params.items : [];
                    const result = items.map((item: unknown) => {
                        const section = isObject(item) && typeof item.section === "string" ? item.section : undefined;
                        if (!section) return client.config.settings || {};
                        return client.config.settings?.[section] ?? {};
                    });
                    sendLspResponse(client, parsed.id, result);
                } else if (parsed.method === "workspace/workspaceFolders") {
                    sendLspResponse(client, parsed.id, [
                        { uri: pathToFileURL(client.workspaceRoot).href, name: basename(client.workspaceRoot) },
                    ]);
                } else if (parsed.method === "workspace/applyEdit") {
                    const requestId = parsed.id;
                    if (!client.applyEditHandler) sendLspResponse(client, requestId, { applied: false, failureReason: "No owner-authorized command is active" });
                    else Promise.resolve(client.applyEditHandler(parsed.params?.edit))
                        .then((result) => sendLspResponse(client, requestId, result))
                        .catch((error) => sendLspResponse(client, requestId, { applied: false, failureReason: error instanceof Error ? error.message : "Edit rejected" }));
                } else {
                    sendLspResponse(client, parsed.id, undefined, { code: -32601, message: `Unsupported method: ${parsed.method}` });
                }
            } else if (parsed.method === "textDocument/publishDiagnostics") {
                if (typeof parsed.params?.uri === "string" && Array.isArray(parsed.params.diagnostics)) {
                    if (parsed.params.version !== undefined && !Number.isInteger(parsed.params.version)) continue;
                    const uri = parsed.params.uri;
                    const diags = parsed.params.diagnostics;
                    const version = Number.isInteger(parsed.params.version) ? parsed.params.version : undefined;

                    const fileInfo = client.openFiles.get(uri);
                    if (fileInfo && version !== undefined && version !== fileInfo.version) {
                        // A report for another document version cannot validate the current text.
                    } else {
                        client.diagnostics.set(uri, diags);
                        client.diagnosticMeta.set(uri, { version, stale: false });

                        const waiters = client.diagnosticWaiters.get(uri);
                        if (waiters && waiters.size > 0) {
                            for (const waiter of waiters) {
                                if (version === undefined || version >= waiter.minVersion) waiter.resolve(diags);
                            }
                        }

                    }
                }
            }
        } catch {}
    }
}

export async function startServer(id: string, config: ServerConfig, cwd: string): Promise<ActiveClient> {
    if (workspaceScheme(cwd)) {
        throw new Error(`Remote workspaces are not supported: ${cwd}`);
    }
    const resolvedCwd = realpathSync(resolve(cwd));
    const key = `${id}:${resolvedCwd}`;

    const existing = clients.get(key);
    if (existing && existing.running) {
        return existing;
    }

    if (starting.has(key)) {
        return starting.get(key)!;
    }

    const startPromise = (async () => {
        const bin = findExecutable(config.command, resolvedCwd);
        if (!bin) {
            throw new Error(`Executable for ${config.command} not found in ${resolvedCwd}`);
        }

        const env = { ...process.env };
        const binDirs: string[] = [];
        let p = resolvedCwd;
        while (true) {
            const b = join(p, "node_modules", ".bin");
            if (existsSync(b)) binDirs.push(b);
            const up = dirname(p);
            if (up === p) break;
            p = up;
        }
        if (binDirs.length > 0) {
            env.PATH = `${binDirs.join(delimiter)}${delimiter}${env.PATH || ""}`;
        }

        const proc = spawn(bin, config.args ?? [], {
            cwd: resolvedCwd,
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });

        const client: ActiveClient = {
            id,
            config,
            process: proc,
            workspaceRoot: resolvedCwd,
            reqId: 0,
            pending: new Map(),
            diagnostics: new Map(),
            diagnosticMeta: new Map(),
            diagnosticWaiters: new Map(),
            buffer: Buffer.alloc(0),
            openFiles: new Map(),
            running: false,
            stderrTail: "",
        };
        clients.set(key, client);

        const { promise: earlySpawnError, reject: rejectEarlySpawn } = Promise.withResolvers<never>();

        const onEarlyError = (err: Error) => {
            cleanupEarly(err);
        };
        const onEarlyExit = (code: number | null, signal: string | null) => {
            cleanupEarly(new Error(`LSP server exited before initialization: code=${code}, signal=${signal}${client.stderrTail ? `\n${client.stderrTail}` : ""}`));
        };

        function cleanupEarly(err: Error) {
            client.running = false;
            if (clients.get(key) === client) clients.delete(key);
            for (const req of client.pending.values()) {
                clearTimeout(req.timer);
                req.reject(err);
            }
            client.pending.clear();
            rejectAllWaiters(client, err);
            rejectEarlySpawn(err);
        }

        proc.once("error", onEarlyError);
        proc.once("exit", onEarlyExit);
        const onStreamError = (err: Error) => {
            cleanupEarly(err);
            try {
                proc.kill("SIGKILL");
            } catch {}
        };
        proc.stdin?.on("error", onStreamError);
        proc.stdout?.on("error", onStreamError);
        proc.stderr?.on("error", onStreamError);

        proc.stdout?.on("data", (chunk: Buffer) => handleLspData(client, chunk));
        proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            client.stderrTail = (client.stderrTail + text).slice(-10000);
        });

        try {
            const initialized = await Promise.race([
                sendLsp(client, "initialize", {
                    processId: process.pid,
                    rootUri: pathToFileURL(resolvedCwd).href,
                    workspaceFolders: [
                        { uri: pathToFileURL(resolvedCwd).href, name: basename(resolvedCwd) },
                    ],
                    capabilities: {
                        general: { positionEncodings: ["utf-16"] },
                        textDocument: {
                            synchronization: {
                                dynamicRegistration: false,
                                willSave: false,
                                willSaveWaitUntil: false,
                                didSave: false,
                            },
                            definition: { dynamicRegistration: false, linkSupport: true },
                            publishDiagnostics: { relatedInformation: true, versionSupport: true },
                            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
                            references: { dynamicRegistration: false },
                            hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
                            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
                            implementation: { dynamicRegistration: false, linkSupport: true },
                            rename: { dynamicRegistration: false, prepareSupport: true },
                            formatting: { dynamicRegistration: false },
                            codeAction: { dynamicRegistration: false, codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] } }, dataSupport: true, disabledSupport: true, isPreferredSupport: true, resolveSupport: { properties: ["edit", "command"] } },
                        },
                        workspace: {
                            configuration: true,
                            workspaceFolders: true,
                            applyEdit: true,
                            workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: "abort" },
                            symbol: { dynamicRegistration: false },
                            executeCommand: { dynamicRegistration: false },
                        },
                    },
                    initializationOptions: config.initOptions || {},
                }),
                earlySpawnError,
            ]);
            if (!isObject(initialized) || !isObject(initialized.capabilities)) {
                throw new Error(`Invalid initialize response from ${id}`);
            }
            if (clients.get(key) !== client || proc.exitCode !== null) {
                throw new Error(`LSP server ${id} stopped during initialization`);
            }

            client.serverCapabilities = initialized.capabilities as Record<string, unknown>;
            if (client.serverCapabilities.positionEncoding !== undefined && client.serverCapabilities.positionEncoding !== "utf-16") throw new Error("Server selected an unadvertised position encoding; UTF-16 is required");
            client.running = true;
            proc.removeListener("error", onEarlyError);
            proc.removeListener("exit", onEarlyExit);

            proc.on("error", (err) => {
                client.running = false;
                if (clients.get(key) === client) {
                    clients.delete(key);
                }
                for (const req of client.pending.values()) {
                    clearTimeout(req.timer);
                    req.reject(err);
                }
                client.pending.clear();
                rejectAllWaiters(client, err);
                notifyChange?.(client.workspaceRoot);
            });

            proc.on("exit", (code, signal) => {
                client.running = false;
                if (clients.get(key) === client) {
                    clients.delete(key);
                }
                const err = new Error(`LSP server exited: code=${code}, signal=${signal}`);
                for (const req of client.pending.values()) {
                    clearTimeout(req.timer);
                    req.reject(err);
                }
                client.pending.clear();
                rejectAllWaiters(client, err);
                notifyChange?.(client.workspaceRoot);
            });

            notifyLsp(client, "initialized", {});

            if (config.settings) {
                notifyLsp(client, "workspace/didChangeConfiguration", {
                    settings: config.settings,
                });
            }

            notifyChange?.(resolvedCwd);
            return client;
        } catch (err) {
            cleanupEarly(err instanceof Error ? err : new Error(String(err)));
            try {
                proc.kill("SIGKILL");
            } catch {}
            throw err;
        }
    })();

    starting.set(key, startPromise);
    try {
        return await startPromise;
    } finally {
        starting.delete(key);
    }
}

export async function stopClient(key: string): Promise<void> {
    const client = clients.get(key);
    if (!client) return;
    clients.delete(key);
    const wasRunning = client.running;
    client.running = false;

    for (const req of client.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error("LSP client stopped"));
    }
    client.pending.clear();
    rejectAllWaiters(client, new Error("LSP client stopped"));
    notifyChange?.(client.workspaceRoot);
    const proc = client.process;
    if (proc.exitCode !== null || proc.killed) return;

    if (wasRunning) {
        await sendLsp(client, "shutdown", null, 1000).catch(() => {});
        notifyLsp(client, "exit", null);
    }

    if (proc.exitCode === null && !proc.killed) {
        const { promise, resolve: resolveWait } = Promise.withResolvers<void>();
        let settled = false;
        const onExit = () => {
            if (!settled) {
                settled = true;
                resolveWait();
            }
        };
        proc.once("exit", onExit);

        const termTimer = setTimeout(() => {
            try {
                proc.kill("SIGTERM");
            } catch {}
        }, 500);

        const killTimer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try {
                    proc.kill("SIGKILL");
                } catch {}
                resolveWait();
            }
        }, 1500);

        proc.once("exit", () => {
            clearTimeout(termTimer);
            clearTimeout(killTimer);
            onExit();
        });
        await promise;
    }
}

export async function stopAllClients(): Promise<void> {
    const allKeys = Array.from(clients.keys());
    await Promise.allSettled(allKeys.map((key) => stopClient(key)));
}

export async function getServersForCwd(cwd: string) {
    if (workspaceScheme(cwd)) {
        throw new Error(`Remote workspaces are not supported: ${cwd}`);
    }
    const resolvedCwd = realpathSync(resolve(cwd));
    const list = await Promise.all(
        Object.entries(LSP_SERVERS).map(async ([id, conf]) => {
            const available = findExecutable(conf.command, resolvedCwd) !== undefined;
            const matched = matchesMarkersOrExtensions(conf, resolvedCwd);
            const client = clients.get(`${id}:${resolvedCwd}`);
            const isRunning = client !== undefined && client.running === true;
            const instances = isRunning
                ? [
                      {
                          cwd: client.workspaceRoot,
                          diagnosticsCount: Array.from(client.diagnostics.values()).reduce(
                              (acc, cur) => acc + cur.length,
                              0,
                          ),
                      },
                  ]
                : [];
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
                checkedAt: Date.now(),
                running: isRunning,
                instances,
            };
        }),
    );
    serverStatusCache.set(resolvedCwd, list);
    return list;
}

function detectLanguageId(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
        case ".ts": return "typescript";
        case ".tsx": return "typescriptreact";
        case ".js":
        case ".mjs":
        case ".cjs": return "javascript";
        case ".jsx": return "javascriptreact";
        case ".json": return "json";
        case ".rs": return "rust";
        case ".go": return "go";
        case ".py": return "python";
        case ".c":
        case ".h": return "c";
        case ".cpp":
        case ".cc":
        case ".cxx":
        case ".hpp": return "cpp";
        case ".java": return "java";
        case ".html": return "html";
        case ".css": return "css";
        case ".scss": return "scss";
        case ".md": return "markdown";
        case ".toml": return "toml";
        case ".yaml":
        case ".yml": return "yaml";
        case ".sh":
        case ".bash": return "shellscript";
        default: return "plaintext";
    }
}

export function syncFileToClient(client: ActiveClient, absPath: string): { uri: string; version: number; changed: boolean } {
    const uri = pathToFileURL(absPath).href;
    const text = readFileSync(absPath, "utf8");
    const languageId = detectLanguageId(absPath);

    const previous = client.openFiles.get(uri);
    if (previous && previous.text === text) {
        return { uri, version: previous.version, changed: false };
    }

    const version = (previous?.version ?? 0) + 1;
    client.openFiles.set(uri, { version, text });
    client.diagnostics.delete(uri);
    client.diagnosticMeta.set(uri, { stale: true });
    const obsolete = client.diagnosticWaiters.get(uri);
    if (obsolete) for (const waiter of obsolete) waiter.reject(new Error("File changed during its diagnostic check"));

    if (!previous) {
        notifyLsp(client, "textDocument/didOpen", {
            textDocument: { uri, languageId, version, text },
        });
    } else {
        notifyLsp(client, "textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text }],
        });
    }
    return { uri, version, changed: true };
}

export async function waitForFreshDiagnostics(
    client: ActiveClient,
    uri: string,
    targetVersion: number,
    context?: Context,
    timeoutMs = 5000,
): Promise<unknown[]> {
    context?.abortSignal?.throwIfAborted();
    if (!client.running) throw new Error(`LSP client ${client.id} is not running`);
    if (client.openFiles.get(uri)?.version !== targetVersion) throw new Error("Diagnostic check was superseded by another file version");
    const meta = client.diagnosticMeta.get(uri);
    if (meta && !meta.stale && (meta.version === undefined || meta.version === targetVersion)) {
        return client.diagnostics.get(uri)!;
    }
    const provider = client.serverCapabilities?.diagnosticProvider;
    if (provider) {
        const report = await sendLsp(client, "textDocument/diagnostic", {
            textDocument: { uri },
            ...(isObject(provider) && typeof provider.identifier === "string" ? { identifier: provider.identifier } : {}),
        }, timeoutMs, context?.abortSignal);
        context?.abortSignal?.throwIfAborted();
        if (client.openFiles.get(uri)?.version !== targetVersion) throw new Error("Diagnostic check was superseded by another file version");
        if (!isObject(report) || report.kind !== "full" || !Array.isArray(report.items)) {
            throw new Error(`Invalid diagnostic report from ${client.id}; file not verified`);
        }
        client.diagnostics.set(uri, report.items);
        client.diagnosticMeta.set(uri, { version: targetVersion, stale: false });
        return report.items;
    }
    const { promise, resolve: complete, reject: fail } = Promise.withResolvers<unknown[]>();
    const signal = context?.abortSignal;
    const cleanup = () => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
        const pending = client.diagnosticWaiters.get(uri);
        pending?.delete(waiter);
        if (pending?.size === 0) client.diagnosticWaiters.delete(uri);
    };
    const onAbort = () => waiter.reject(cancellationError(signal!));
    const waiter: DiagnosticWaiter = {
        minVersion: targetVersion,
        resolve: (diagnostics) => { cleanup(); complete(diagnostics); },
        reject: (error) => { cleanup(); fail(error); },
        timer: setTimeout(() => waiter.reject(new Error(`No fresh diagnostics from ${client.id} within ${timeoutMs}ms; file not verified`)), timeoutMs),
    };
    let pending = client.diagnosticWaiters.get(uri);
    if (!pending) client.diagnosticWaiters.set(uri, pending = new Set());
    pending.add(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
}

export function findBestServerForExt(ext: string, cwd: string): { id: string; conf: ServerConfig } | undefined {
    let best: { id: string; conf: ServerConfig } | undefined;
    for (const [id, conf] of Object.entries(LSP_SERVERS)) {
        if (!conf.fileTypes.some((fileType) => fileType.toLowerCase() === ext)) {
            continue;
        }
        if (findExecutable(conf.command, cwd) === undefined) {
            continue;
        }
        if (!best) {
            best = { id, conf };
            if (!conf.isLinter) break;
        } else if (best.conf.isLinter && !conf.isLinter) {
            best = { id, conf };
            break;
        }
    }
    return best;
}

function isOwner(host: PocketHost, conversationId?: ConversationId): boolean {
    if (conversationId === undefined) return false;
    const requester = host.requesterOf(conversationId);
    return requester !== undefined && host.roleOf(requester) === "owner";
}

function assertOwner(host: PocketHost, conversationId?: ConversationId, action = "perform this action"): void {
    if (!isOwner(host, conversationId)) throw new Error(`Only the Pocket owner can ${action}`);
}

function diagnosticSummary(diagnostics: unknown[]): string {
    return diagnostics.slice(0, 10).map((diagnostic) => {
        if (!isObject(diagnostic)) return "Unstructured diagnostic";
        const start = isObject(diagnostic.range) && isObject(diagnostic.range.start) ? diagnostic.range.start : undefined;
        const line = typeof start?.line === "number" ? start.line + 1 : "?";
        const column = typeof start?.character === "number" ? start.character + 1 : "?";
        const severity = diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning"
            : diagnostic.severity === 3 ? "information" : diagnostic.severity === 4 ? "hint" : "diagnostic";
        const code = typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? ` ${diagnostic.code}` : "";
        const message = typeof diagnostic.message === "string" ? diagnostic.message.replace(/\s+/g, " ").slice(0, 500) : "Unstructured diagnostic";
        return `line ${line}:${column} [${severity}${code}] ${message}`;
    }).join("\n") + (diagnostics.length > 10 ? `\n...and ${diagnostics.length - 10} more` : "");
}

async function diagnoseFile(host: PocketHost, conversationId: ConversationId | undefined, cwd: string, file: string, context: Context, authority = () => assertOwner(host, conversationId, "synchronize files with language servers"), allowIncomplete = false) {
    authority();
    cwd = realpathSync(resolve(cwd));
    context.abortSignal?.throwIfAborted();
    if (!statSync(file).isFile()) throw new Error("Diagnostic target is not a source file");
    const ext = extname(file).toLowerCase();
    let matching = Array.from(clients.values()).filter((client) => client.running && client.workspaceRoot === cwd
        && client.config.fileTypes.some((fileType) => fileType.toLowerCase() === ext));
    if (matching.length === 0) {
        const candidate = findBestServerForExt(ext, cwd);
        if (!candidate) throw new Error(`No installed language server matches ${ext || "this filename"}; file not checked`);
        matching = [await startServer(candidate.id, candidate.conf, cwd)];
    }
    authority();
    context.abortSignal?.throwIfAborted();
    const synced = matching.map((client) => ({ client, ...syncFileToClient(client, file) }));
    const reports = await Promise.allSettled(synced.map(({ client, uri, version }) => waitForFreshDiagnostics(client, uri, version, context)));
    authority();
    context.abortSignal?.throwIfAborted();
    const diagnostics: unknown[] = [];
    const failures: string[] = [];
    reports.forEach((report, index) => {
        if (report.status === "fulfilled") diagnostics.push(...report.value);
        else failures.push(`${matching[index].id}: ${report.reason instanceof Error ? report.reason.message : "diagnostic request failed"}`);
    });
    if (failures.length && !allowIncomplete) throw new Error(`Incomplete LSP check; file not verified. ${failures.join("; ")}${diagnostics.length ? `\n${diagnosticSummary(diagnostics)}` : ""}`);
    notifyChange?.(cwd);
    return { uri: pathToFileURL(file).href, diagnostics, incomplete: failures.length > 0 };
}

export default function createPiLsp(host: PocketHost, web?: ExtensionWeb) {
    notifyChange = (cwd: string) => {
        try { web?.send("lsp-changed", { cwd }); }
        catch (error) { console.warn("LSP dashboard update failed", error); }
    };
    const tooling = createTooling(host, web, {
        findExecutable,
        request: (client, method, params, signal) => sendLsp(client, method, params, 10_000, signal),
        sync: syncFileToClient,
        async select(cwd, file, server, capability) {
            let id = server;
            if (id && !Object.hasOwn(LSP_SERVERS, id)) throw new Error(`Unknown server ${id}`);
            if (!id && file) id = findBestServerForExt(extname(file).toLowerCase(), cwd)?.id;
            if (!id) id = [...clients.values()].find((client) => client.running && client.workspaceRoot === cwd && client.serverCapabilities?.[capability])?.id;
            if (!id) throw new Error("No eligible server; specify an installed server for a workspace query");
            const conf = LSP_SERVERS[id]!;
            if (conf.disabled) throw new Error("This server is disabled");
            const client = await startServer(id, conf, cwd);
            if (!client.serverCapabilities?.[capability]) throw new Error(`${id} does not support ${capability}`);
            return client;
        },
        diagnose: (cwd, file, context, authority) => diagnoseFile(host, undefined, cwd, file, context, authority, true),
        async servers(cwd) {
            const cached = serverStatusCache.get(cwd);
            return (cached ?? Object.entries(LSP_SERVERS).map(([id, conf]) => ({ id, ...conf, available: null, matched: null }))).map((row) => {
                const client = clients.get(`${row.id}:${cwd}`);
                return { ...row, running: client?.running === true, capabilities: client?.serverCapabilities ?? {}, instances: client?.running ? [{ cwd, diagnosticsCount: [...client.diagnostics.values()].reduce((sum, values) => sum + values.length, 0) }] : [] };
            });
        },
        refreshServers: getServersForCwd,
        config: (server) => Object.hasOwn(LSP_SERVERS, server) ? LSP_SERVERS[server] : undefined,
        version: (cwd, file, server) => {
            const uri = pathToFileURL(file).href;
            if (server) return clients.get(`${server}:${cwd}`)?.openFiles.get(uri)?.version;
            for (const client of clients.values()) if (client.running && client.workspaceRoot === cwd && client.openFiles.has(uri)) return client.openFiles.get(uri)?.version;
            return undefined;
        },
    });

    if (web) {
        web.settings([{
            name: "autoCheck",
            type: "boolean",
            default: true,
            label: "Automatic post-edit diagnostics",
            description: "Start available servers and check local source files after successful owner edit/write calls. Never installs packages.",
        }]);
        web.client("pi-lsp.js", { access: "owner" });

        web.route(
            "GET",
            "servers",
            async (req: WebRequest) => {
                const cwd = (req.query.get("cwd") as string) || process.cwd();
                if (workspaceScheme(cwd)) throw web.error(400, "Remote workspaces are not supported");
                const list = await getServersForCwd(cwd);
                return { servers: list, cwd };
            },
            { access: "owner" },
        );

        web.conversationRoute(
            "GET",
            "c/:conversation/servers",
            async (req: ConversationWebRequest) => {
                const cwd = req.conversation.cwd;
                if (workspaceScheme(cwd)) throw web.error(400, "Remote workspaces are not supported");
                const list = await getServersForCwd(cwd);
                return { servers: list, cwd };
            },
            { conversation: "conversation", access: "owner" },
        );

        web.conversationRoute(
            "POST",
            "c/:conversation/start",
            async (req: ConversationWebRequest) => {
                const cwd = req.conversation.cwd;
                if (workspaceScheme(cwd)) throw web.error(400, "Remote workspaces are not supported");
                const body = getRequestBody(req);
                const serverId = typeof body.serverId === "string" ? body.serverId : "";
                const conf = LSP_SERVERS[serverId];
                if (!conf) throw web.error(404, `Unknown server ${serverId}`);
                await startServer(serverId, conf, cwd);
                return { ok: true };
            },
            { conversation: "conversation", access: "owner" },
        );

        web.conversationRoute(
            "POST",
            "c/:conversation/stop",
            async (req: ConversationWebRequest) => {
                const cwd = req.conversation.cwd;
                if (workspaceScheme(cwd)) throw web.error(400, "Remote workspaces are not supported");
                const body = getRequestBody(req);
                const serverId = typeof body.serverId === "string" ? body.serverId : "";
                const key = `${serverId}:${realpathSync(resolve(cwd))}`;
                await stopClient(key);
                return { ok: true };
            },
            { conversation: "conversation", access: "owner" },
        );

        web.route(
            "POST",
            "stop",
            async (req: WebRequest) => {
                const body = getRequestBody(req);
                const serverId = typeof body.serverId === "string" ? body.serverId : "";
                const cwd = typeof body.cwd === "string" ? body.cwd : process.cwd();
                if (workspaceScheme(cwd)) throw web.error(400, "Remote workspaces are not supported");
                const key = `${serverId}:${realpathSync(resolve(cwd))}`;
                await stopClient(key);
                return { ok: true };
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "start",
            async (req: WebRequest) => {
                const body = getRequestBody(req);
                const serverId = typeof body.serverId === "string" ? body.serverId : "";
                const cwd = typeof body.cwd === "string" ? body.cwd : process.cwd();
                if (workspaceScheme(cwd)) throw web.error(400, "Remote workspaces are not supported");
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
                const body = getRequestBody(req);
                const serverId = typeof body.serverId === "string" ? body.serverId : "";
                const conf = LSP_SERVERS[serverId];
                if (!conf?.installCmd) throw web.error(400, "No install command available");
                try {
                    const { stdout, stderr } = await tooling.runCommand(conf.installCmd, process.cwd(), req.signal, () => { if (host.roleOf(req.user.id) !== "owner") throw new Error("Owner permission required"); });
                    return { ok: true, output: stdout || stderr };
                } catch (err: unknown) {
                    throw web.error(500, err instanceof Error ? err.message : String(err));
                }
            },
            { access: "owner" },
        );

        web.route(
            "POST",
            "uninstall",
            async (req: WebRequest) => {
                const body = getRequestBody(req);
                const serverId = typeof body.serverId === "string" ? body.serverId : "";
                const conf = LSP_SERVERS[serverId];
                if (!conf?.uninstallCmd) throw web.error(400, "No uninstall command available");
                try {
                    const { stdout, stderr } = await tooling.runCommand(conf.uninstallCmd, process.cwd(), req.signal, () => { if (host.roleOf(req.user.id) !== "owner") throw new Error("Owner permission required"); });
                    return { ok: true, output: stdout || stderr };
                } catch (err: unknown) {
                    throw web.error(500, err instanceof Error ? err.message : String(err));
                }
            },
            { access: "owner" },
        );
        web.onDispose(async () => {
            const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<void>();
            const timer = setTimeout(resolveTimeout, 3000);
            await Promise.race([Promise.allSettled([stopAllClients(), tooling.dispose()]), timeoutPromise]);
            clearTimeout(timer);
        });
    }

    const lspStatusTool = defineTool({
        name: "lsp_status",
        description: "Check status of active and detected Language Servers (LSP) in workspace.",
        parameters: Type.Object({}),
        async execute(_args, api, context) {
            const resolvedCwd = await getSessionCwd(api, context);
            const active = Array.from(clients.values())
                .filter((c) => c.workspaceRoot === resolvedCwd && c.running)
                .map((c) => ({
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
                if (matchesMarkersOrExtensions(conf, resolvedCwd)) {
                    detected.push({
                        id,
                        command: conf.command,
                        available: findExecutable(conf.command, resolvedCwd) !== undefined,
                        installCmd: conf.installCmd,
                    });
                }
            }

            return {
                output: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({ active, detected, cwd: resolvedCwd }, null, 2),
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
        async execute(args, api, context) {
            if (args.file) assertOwner(host, api.conversationId, "request diagnostics for a file");
            const cwd = await getSessionCwd(api, context);
            if (args.file) {
                const report = await diagnoseFile(host, api.conversationId, cwd, resolve(cwd, args.file), context);
                return { output: [{ type: "text" as const, text: JSON.stringify({ [report.uri]: report.diagnostics }, null, 2) }] };
            }
            const results: Record<string, unknown[]> = {};
            for (const client of clients.values()) {
                if (!client.running || client.workspaceRoot !== cwd) continue;
                for (const [uri, diagnostics] of client.diagnostics) {
                    if (client.diagnosticMeta.get(uri)?.stale) continue;
                    if (results[uri]) results[uri].push(...diagnostics);
                    else results[uri] = [...diagnostics];
                }
            }
            return { output: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
        },
    });

    const lspDefinitionTool = defineTool({
        name: "lsp_definition",
        description: "Jump to definition of symbol at file, line, and column.",
        parameters: Type.Object({
            server: Type.Optional(Type.String({ description: "Language server id; selected from the file when omitted" })),
            file: Type.String({ description: "Path to file" }),
            line: Type.Number({ description: "0-based line number" }),
            character: Type.Number({ description: "0-based character offset" }),
        }),
        async execute(args, api, context) {
            assertOwner(host, api.conversationId, "jump to definition");
            const resolvedCwd = await getSessionCwd(api, context);
            assertOwner(host, api.conversationId, "jump to definition");
            context.abortSignal?.throwIfAborted();
            const absPath = await canonicalFile(resolvedCwd, args.file);
            const serverId = args.server ?? findBestServerForExt(extname(absPath).toLowerCase(), resolvedCwd)?.id;
            if (!serverId) throw new Error("No installed language server matches this file");
            let client = clients.get(`${serverId}:${resolvedCwd}`);
            if (!client || !client.running) {
                const conf = Object.hasOwn(LSP_SERVERS, serverId) ? LSP_SERVERS[serverId] : undefined;
                if (!conf) throw new Error(`Unknown server ${serverId}`);
                client = await startServer(serverId, conf, resolvedCwd);
                assertOwner(host, api.conversationId, "jump to definition");
                context.abortSignal?.throwIfAborted();
            }

            const { uri } = syncFileToClient(client, absPath);

            const res = await sendLsp(client, "textDocument/definition", {
                textDocument: { uri },
                position: { line: args.line, character: args.character },
            }, 10000, context.abortSignal);

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
        description: "Manage LSP servers and ast-grep/codegraph providers for the authorized task, including install, refresh and index create/sync/rebuild.",
        parameters: Type.Object({
            server: Type.String({ description: "LSP server id, ast-grep, or codegraph" }),
            action: Type.Union([
                Type.Literal("start"),
                Type.Literal("stop"),
                Type.Literal("install"),
                Type.Literal("uninstall"),
                Type.Literal("refresh"),
                Type.Literal("create"),
                Type.Literal("sync"),
                Type.Literal("rebuild"),
            ]),
        }),
        async execute(args, api, context) {
            assertOwner(host, api.conversationId, "manage language servers");
            const resolvedCwd = await getSessionCwd(api, context);
            assertOwner(host, api.conversationId, "manage language servers");
            context.abortSignal?.throwIfAborted();
            if (args.server === "ast-grep" || args.server === "codegraph") {
                const result = await tooling.manage({ provider: args.server === "ast-grep" ? "ast" : "graph", action: args.action }, api, context);
                return { isError: result.status === "failed" || result.status === "partial", output: [{ type: "text" as const, text: JSON.stringify(result) }] };
            }
            const conf = Object.hasOwn(LSP_SERVERS, args.server) ? LSP_SERVERS[args.server] : undefined;
            if (!conf) throw new Error(`Unsupported server ${args.server}`);
            switch (args.action) {
                case "stop":
                    await stopClient(`${args.server}:${resolvedCwd}`);
                    return { output: [{ type: "text" as const, text: `Stopped ${args.server}` }] };
                case "start":
                    await startServer(args.server, conf, resolvedCwd);
                    return { output: [{ type: "text" as const, text: `Started ${args.server} for ${resolvedCwd}` }] };
                case "install":
                case "uninstall": {
                    const command = args.action === "install" ? conf.installCmd : conf.uninstallCmd;
                    if (!command) throw new Error(`No ${args.action} command for ${args.server}`);
                    const { stdout, stderr } = await tooling.runCommand(command, resolvedCwd, context.abortSignal, () => assertOwner(host, api.conversationId, "manage language servers"));
                    return { output: [{ type: "text" as const, text: `${args.action === "install" ? "Installed" : "Uninstalled"}:\n${stdout || stderr}` }] };
                }
                default:
                    throw new Error("Unsupported language-server action");
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
            ...tooling.tools,
        ],
        sections: [
            ...tooling.sections,
            section("lsp_workflow", (input, _context) => {
                const hasTool = input.agent.tools.some((t) => t.name.startsWith("lsp_")) ||
                    input.agent.callable.some((t) => t.name.startsWith("lsp_") && t.callers?.includes("model") === false);
                if (!hasTool) return undefined;

                const owner = isOwner(host, input.conversationId);
                const autoCheck = web?.setting("autoCheck") !== false;

                if (owner) {
                    return [
                        "LSP Workflow:",
                        `- After successful source edits, fix issues in the automatic LSP report. ${autoCheck ? "Automatic checks are enabled for edit/write calls." : "Automatic checks are disabled; call lsp_diagnostics with the edited file."}`,
                        "- Use lsp_diagnostics with file to check saved external edits or when no automatic report was produced. Without file it returns received cache, not a full workspace check.",
                        "- Diagnostics aren't tests: LSP diagnostics report syntax and type issues, but do not replace executing test suites.",
                        "- Lazy startup: The best matching available compiler/linter server starts automatically on the first diagnostic or definition request for a file.",
                        "- Unsupported files: If no language server is available for a file type, diagnostics are skipped; do not assume the file is error-free.",
                        "- Definition offsets: lsp_definition takes 0-based line and UTF-16 character offsets.",
                        "- Owner capabilities: Managing language servers, jumping to definitions, and synchronizing files for diagnostics require the Pocket owner role.",
                        "- Task authorization covers necessary owner tooling operations. Use lsp_manage for supported local providers; do not ask for another extension confirmation or hand work back to the owner.",
                    ].join("\n");
                }

                return [
                    "LSP Workflow:",
                    "- Read-only diagnostics: You can inspect cached workspace status and diagnostics via lsp_status and lsp_diagnostics (without file parameter).",
                    "- Restricted actions: Managing language servers, file-synchronizing diagnostics, and jumping to definitions require the Pocket owner role.",
                    "- Diagnostics aren't tests: LSP diagnostics do not replace running test suites.",
                    "- Unsupported files: If no server is running for a file type, diagnostics are unavailable.",
                ].join("\n");
            }),
        ],
        hooks: [
            hook(ToolTask, {
                afterTool: async (call, result, api, context) => {
                    if ((call.name !== "edit" && call.name !== "write") || result.isError
                        || result.diagnostics?.some((diagnostic) => diagnostic.severity === "error"
                            || (typeof diagnostic.code === "string" && Object.hasOwn(INCOMPLETE_TOOL_RESULTS, diagnostic.code)))
                        || context.abortSignal?.aborted || !isOwner(host, api.conversationId)
                        || web?.setting("autoCheck") === false) return undefined;
                    const file = typeof call.arguments.path === "string" ? call.arguments.path : "";
                    if (!file) return undefined;
                    const cwd = host.cwdOf(api.conversationId);
                    if (workspaceScheme(cwd)) return undefined;
                    const resolvedCwd = resolve(cwd);
                    const absolute = resolve(resolvedCwd, file);
                    tooling.changed(resolvedCwd, [absolute]);
                    if (basename(absolute).startsWith(".env")) return undefined;
                    const ext = extname(absolute).toLowerCase();
                    if (!Object.values(LSP_SERVERS).some((config) => config.fileTypes.some((fileType) => fileType.toLowerCase() === ext))) return undefined;
                    let summary: string;
                    try {
                        const within = relative(realpathSync(resolvedCwd), realpathSync(absolute));
                        if (within === ".." || within.startsWith(`..${sep}`)) return undefined;
                        const report = await diagnoseFile(host, api.conversationId, resolvedCwd, absolute, context);
                        summary = report.diagnostics.length
                            ? `[LSP diagnostics for ${basename(absolute)}:\n${diagnosticSummary(report.diagnostics)}]`
                            : `[LSP: checked ${basename(absolute)}, no issues reported for this file]`;
                    } catch (error) {
                        if (!isOwner(host, api.conversationId) || context.abortSignal?.aborted) return undefined;
                        summary = `[LSP: ${basename(absolute)} not verified: ${error instanceof Error ? error.message : "diagnostic check failed"}]`;
                    }
                    return { ...result, output: [...(result.output ?? []), { type: "text" as const, text: summary }] };
                },
            }),
        ],
    });
}
