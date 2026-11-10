import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphOperation, GraphQuery, ProviderQueryResult, ProviderRuntime, ProviderStatus } from "./contracts.ts";

const actions = ["explore", "callers", "callees", "impact", "affected_tests"];
const childEnv = { CODEGRAPH_TELEMETRY: "0", DO_NOT_TRACK: "1", CODEGRAPH_DIR: ".codegraph", CODEGRAPH_HOST_PPID: undefined };
interface Installation { executable: string; packageRoot: string; sdk: string; runtime: string; runtimeVersion: string; version: string; provenance: string }
interface WorkerReply { status?: Record<string, unknown>; result?: ProviderQueryResult; error?: string; cancelled?: boolean }
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
function within(root: string, path: string) { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function snapshot(status: ProviderStatus): ProviderStatus { return structuredClone(status); }
function initial(cwd: string): ProviderStatus {
    return { id: "codegraph", available: false, actions: [...actions], indexRoot: resolve(cwd), initialized: false, buildState: "unknown", engineCompatibility: "unknown", sourceFreshness: "unknown", coverage: "unknown", trustPolicy: "Verified CodeGraph 1.6.2 SDK; explicit owner operations only; no watchers, hooks, daemon or automatic indexing", error: "CodeGraph has not been explicitly probed" };
}

/** CodeGraph is isolated from Pocket's runtime; cached panel reads never perform I/O. */
export class GraphProvider {
    private statuses = new Map<string, ProviderStatus>();
    private installations = new Map<string, Installation>();
    private changes = new Map<string, number>();
    private operations = new Map<string, { action: GraphOperation["action"]; promise: Promise<ProviderStatus> }>();
    private runtime: ProviderRuntime;
    constructor(runtime: ProviderRuntime) { this.runtime = runtime; }

    cachedStatus(cwd: string): ProviderStatus { return snapshot(this.statuses.get(resolve(cwd)) ?? initial(cwd)); }

    private store(key: string, status: ProviderStatus): ProviderStatus {
        this.statuses.set(key, status);
        return snapshot(status);
    }

    private async detect(cwd: string, signal?: AbortSignal): Promise<Installation> {
        this.statuses.set(resolve(cwd), { ...this.cachedStatus(cwd), available: false });
        this.installations.delete(resolve(cwd));
        const found = this.runtime.findExecutable("codegraph", cwd);
        if (!found) throw new Error("CodeGraph is not installed; installation is an explicit owner action");
        const executable = realpathSync(found);
        let packageRoot: string | undefined;
        let cursor = dirname(executable);
        for (let depth = 0; depth < 7; depth++) {
            for (const candidate of [cursor, join(cursor, "lib")]) {
                const manifest = join(candidate, "package.json");
                if (!existsSync(manifest)) continue;
                const pkg = JSON.parse(readFileSync(manifest, "utf8"));
                if (pkg.name === "@colbymchenry/codegraph") { packageRoot = realpathSync(candidate); break; }
            }
            if (packageRoot) break;
            const parent = dirname(cursor);
            if (parent === cursor) break;
            cursor = parent;
        }
        if (!packageRoot) throw new Error("Executable does not resolve to a verified @colbymchenry/codegraph installation");
        const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
        this.statuses.set(resolve(cwd), { ...this.cachedStatus(cwd), available: true, executable, version: typeof pkg.version === "string" ? pkg.version : undefined, compatible: false, checkedAt: Date.now() });
        if (pkg.version !== "1.6.2" || pkg.main !== "dist/index.js" || !/^>=20(?:\.0(?:\.0)?)?\s+<25(?:\.0(?:\.0)?)?$/.test(pkg.engines?.node ?? "")) {
            throw new Error(`Unsupported CodeGraph package/runtime contract: ${pkg.version ?? "unknown"}, Node ${pkg.engines?.node ?? "unknown"}; verified adapter requires 1.6.2`);
        }
        const sdk = realpathSync(join(packageRoot, pkg.main));
        const bin = realpathSync(join(packageRoot, typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.codegraph ?? "dist/bin/codegraph.js"));
        if (!within(packageRoot, sdk) || !within(packageRoot, bin)) throw new Error("CodeGraph SDK/bin escapes the verified package");
        const bundle = dirname(packageRoot);
        const standalone = executable !== bin && within(bundle, executable);
        let bundledRuntime: string | undefined;
        if (executable !== bin && !standalone) throw new Error("Unverified CodeGraph executable wrapper; use the package binary or trusted standalone distribution");
        if (standalone) {
            const wrapper = readFileSync(executable, "utf8");
            const runtimeName = /exec\s+"\$DIR\/(node(?:\d+\.\d+\.\d+)?)"/.exec(wrapper)?.[1];
            if (!runtimeName || !wrapper.includes('"$DIR/lib/dist/bin/codegraph.js"')) throw new Error("Unsupported standalone launcher/runtime layout");
            bundledRuntime = join(bundle, runtimeName);
            if (!existsSync(bundledRuntime)) throw new Error("Standalone CodeGraph bundled runtime is missing");
        }
        const candidates = standalone ? [bundledRuntime] : [this.runtime.findExecutable("node", cwd), process.execPath];
        const failures: string[] = [];
        for (const candidate of [...new Set(candidates.filter((path): path is string => !!path))]) {
            try {
                const node = realpathSync(candidate);
                const probe = await this.runtime.run(node, ["--no-warnings", "-e", 'require("node:sqlite");process.stdout.write(JSON.stringify({version:process.versions.node}))'], { cwd, signal, timeout: 10_000, maxBytes: 16_384, env: childEnv });
                if (probe.exitCode !== 0 || probe.truncated) throw new Error(probe.stderr.trim() || "Node runtime probe failed");
                const version: unknown = JSON.parse(probe.stdout).version;
                if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid CodeGraph Node runtime version response");
                const [major, minor] = version.split(".").map(Number);
                if (!Number.isInteger(major) || major < 22 || major >= 25 || (major === 22 && minor < 5)) throw new Error(`Node ${version} is incompatible; CodeGraph 1.6.2 requires Node >=22.5 <25 with node:sqlite`);
                return { executable, packageRoot, sdk, runtime: node, runtimeVersion: version, version: pkg.version, provenance: standalone ? "standalone" : "npm" };
            } catch (error) {
                if (signal?.aborted) throw error;
                failures.push(messageOf(error));
            }
        }
        throw new Error(`No compatible CodeGraph runtime: ${failures.join("; ")}`);
    }

    private async worker(cwd: string, install: Installation, request: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerReply> {
        const worker = fileURLToPath(new URL("./graph-worker.cjs", import.meta.url));
        const output = await this.runtime.run(install.runtime, ["--no-warnings", "--liftoff-only", worker, JSON.stringify({ root: cwd, packageRoot: install.packageRoot, sdk: install.sdk, ...request })], {
            cwd, signal, timeout: request.kind === "operate" && request.action !== "refresh" ? 30 * 60_000 : 30_000,
            maxBytes: 2 * 1024 * 1024, env: childEnv,
        });
        if (output.truncated) throw new Error("CodeGraph output was truncated; result incomplete");
        let reply: WorkerReply;
        try {
            const parsed: unknown = JSON.parse(output.stdout);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid worker reply");
            if (("error" in parsed && parsed.error !== undefined && typeof parsed.error !== "string") || ("status" in parsed && parsed.status !== undefined && (!parsed.status || typeof parsed.status !== "object" || Array.isArray(parsed.status))) || ("result" in parsed && parsed.result !== undefined && (!parsed.result || typeof parsed.result !== "object" || !("status" in parsed.result) || !["ok", "empty", "unsupported", "unavailable"].includes(String(parsed.result.status))))) throw new Error("Invalid worker reply shape");
            // All optional boundary members were checked above; worker results
            // are produced by the owned versioned adapter, not arbitrary stdout.
            reply = parsed as WorkerReply;
        } catch { throw new Error(`CodeGraph worker returned invalid output: ${output.stderr.slice(0, 2000) || `exit ${output.exitCode}`}`); }
        if (output.exitCode !== 0 && !reply.error) throw new Error(output.stderr.slice(0, 2000) || `CodeGraph worker exited ${output.exitCode}`);
        return reply;
    }

    private merged(key: string, installation: Installation, reply: WorkerReply, changeVersion: number, freshnessCheck = false): ProviderStatus {
        const previous = this.statuses.get(key);
        const status: ProviderStatus = { ...initial(key), executable: installation.executable, version: installation.version, compatible: true, provenance: installation.provenance, runtime: installation.runtime, runtimeVersion: installation.runtimeVersion, checkedAt: Date.now(), ...reply.status, available: true, error: reply.error };
        if (!reply.error) delete status.error;
        if (reply.error && !reply.status) status.engineCompatibility = "incompatible";
        if (!freshnessCheck && status.generation === previous?.generation) {
            status.sourceFreshness = previous?.sourceFreshness ?? "unknown";
            if (previous?.sourceCheckedAt !== undefined) status.sourceCheckedAt = previous.sourceCheckedAt;
        }
        if ((this.changes.get(key) ?? 0) !== changeVersion) { status.sourceFreshness = "known_changed"; delete status.sourceCheckedAt; }
        if (previous?.lastOperation) status.lastOperation = previous.lastOperation;
        return status;
    }

    async probe(cwd: string, signal?: AbortSignal): Promise<ProviderStatus> {
        this.runtime.assertOwner();
        const key = resolve(cwd);
        if (this.operations.has(key)) return this.cachedStatus(key);
        const changeVersion = this.changes.get(key) ?? 0;
        let installation: Installation | undefined;
        try {
            const root = realpathSync(key);
            installation = await this.detect(root, signal);
            this.installations.set(key, installation);
            const reply = await this.worker(root, installation, { kind: "probe" }, signal);
            if (this.operations.has(key)) return this.cachedStatus(key);
            return this.store(key, this.merged(key, installation, reply, changeVersion));
        } catch (error) {
            if (this.operations.has(key)) return this.cachedStatus(key);
            return this.store(key, { ...this.cachedStatus(key), ...(installation ? { available: true, executable: installation.executable, version: installation.version, runtime: installation.runtime, runtimeVersion: installation.runtimeVersion } : {}), compatible: false, checkedAt: Date.now(), error: messageOf(error) });
        }
    }

    async query(cwd: string, args: GraphQuery, signal?: AbortSignal): Promise<ProviderQueryResult> {
        this.runtime.assertOwner();
        const key = resolve(cwd);
        if (!actions.includes(args.action)) return { status: "unsupported", message: "Unsupported CodeGraph action" };
        if (!Number.isInteger(args.depth ?? 2) || (args.depth ?? 2) < 0 || (args.depth ?? 2) > 5 || !Number.isInteger(args.maxResults ?? 30) || (args.maxResults ?? 30) < 1 || (args.maxResults ?? 30) > 150) throw new Error("Graph depth must be 0–5 and maxResults 1–150");
        for (const value of [args.query, args.symbol, args.file, args.generation]) if (value !== undefined && (typeof value !== "string" || value.length > 4096 || value.includes("\0"))) throw new Error("Invalid or excessive CodeGraph query field");
        if (args.action === "explore" && !args.query?.trim() && !args.symbol?.trim()) throw new Error("Explore requires a query or symbol");
        if (args.action !== "explore" && !(args.action === "affected_tests" && args.file) && !args.symbol) throw new Error(`${args.action} requires a symbol (or a file for affected_tests)`);
        if (this.operations.has(key)) return { status: "unavailable", message: "A conflicting graph operation is running", provider: this.cachedStatus(key) };
        let status = this.cachedStatus(key);
        if (!this.installations.has(key) || !status.available) status = await this.probe(key, signal);
        if (this.operations.has(key)) return { status: "unavailable", message: "A conflicting graph operation is running", provider: this.cachedStatus(key) };
        const install = this.installations.get(key);
        if (!install || !status.available || status.compatible !== true) return { status: "unavailable", message: status.error ?? "CodeGraph unavailable or incompatible", provider: status };
        if (!status.initialized) return { status: "unavailable", message: "No CodeGraph index in this workspace; creation requires explicit owner action", provider: status };
        const changeVersion = this.changes.get(key) ?? 0;
        try {
            const root = realpathSync(key);
            const reply = await this.worker(root, install, { kind: "query", args: { ...args, depth: args.depth ?? 2, maxResults: args.maxResults ?? 30 } }, signal);
            if (this.operations.has(key)) return { status: "unavailable", message: "A conflicting graph operation started during query; result discarded", provider: this.cachedStatus(key) };
            const current = this.store(key, this.merged(key, install, reply, changeVersion));
            return { ...(reply.result ?? { status: "unavailable", message: reply.error ?? "CodeGraph returned no query result" }), sourceFreshness: current.sourceFreshness, ...(current.sourceCheckedAt !== undefined ? { sourceCheckedAt: current.sourceCheckedAt } : {}), provider: current };
        } catch (error) {
            const current = this.store(key, { ...this.cachedStatus(key), error: messageOf(error) });
            return { status: "unavailable", message: messageOf(error), cancelled: signal?.aborted ?? false, provider: current };
        }
    }

    operate(cwd: string, operation: GraphOperation, signal?: AbortSignal): Promise<ProviderStatus> {
        this.runtime.assertOwner();
        if (!["create", "sync", "rebuild", "refresh"].includes(operation.action)) throw new Error("Unsupported graph operation");
        const key = resolve(cwd), running = this.operations.get(key);
        if (running) {
            if (running.action === operation.action) return running.promise.then(snapshot);
            return Promise.resolve({ ...this.cachedStatus(key), error: "A conflicting graph operation is already running" });
        }
        const startedAt = Date.now(), changeVersion = this.changes.get(key) ?? 0;
        this.store(key, { ...this.cachedStatus(key), lastOperation: { action: operation.action, state: "running", startedAt }, ...(operation.action === "refresh" ? {} : { buildState: "indexing", coverage: "unknown" }) });
        const promise = Promise.resolve().then(async () => {
            let installation: Installation | undefined;
            try {
                const root = realpathSync(key);
                installation = await this.detect(root, signal);
                this.installations.set(key, installation);
                const reply = await this.worker(root, installation, { kind: "operate", action: operation.action }, signal);
                const status = this.merged(key, installation, reply, changeVersion, true);
                const state = reply.cancelled ? "cancelled" : reply.error ? "failed" : status.buildState === "partial" || status.buildState === "failed" ? status.buildState : "complete";
                status.lastOperation = { action: operation.action, state, startedAt, completedAt: Date.now(), ...(reply.error ? { error: reply.error } : {}) };
                return this.store(key, status);
            } catch (error) {
                const cancelled = signal?.aborted ?? false;
                return this.store(key, { ...this.cachedStatus(key), ...(installation ? { executable: installation.executable, version: installation.version, runtime: installation.runtime, runtimeVersion: installation.runtimeVersion } : { available: false, compatible: false }), ...(operation.action !== "refresh" ? { buildState: "unknown", coverage: "unknown", sourceFreshness: "unknown" } : {}), error: messageOf(error), lastOperation: { action: operation.action, state: cancelled ? "cancelled" : "failed", startedAt, completedAt: Date.now(), error: messageOf(error) } });
            } finally { this.operations.delete(key); }
        });
        this.operations.set(key, { action: operation.action, promise });
        return promise;
    }

    markChanged(cwd: string, files: string[]): void {
        const key = resolve(cwd), status = this.statuses.get(key);
        if (!files.some((file) => within(key, resolve(key, file)))) return;
        this.changes.set(key, (this.changes.get(key) ?? 0) + 1);
        if (status) {
            const changed: ProviderStatus = { ...status, sourceFreshness: "known_changed" };
            delete changed.sourceCheckedAt;
            this.statuses.set(key, changed);
        }
    }
}
