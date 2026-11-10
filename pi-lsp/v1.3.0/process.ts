import { spawn, type ChildProcess } from "node:child_process";
import type { ExecutionResult, ProviderRuntime } from "./contracts.ts";

export function createProcessRunner() {
    const active = new Set<ChildProcess>();
    let disposed = false;
    const run: ProviderRuntime["run"] = (executable, args, options) => new Promise<ExecutionResult>((resolve, reject) => {
        if (disposed) return reject(new Error("Tooling extension disposed"));
        if (options.signal?.aborted) return reject(options.signal.reason ?? new Error("Operation aborted"));
        if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
            return reject(new Error("Shell-only executable shim is unsupported; select a native executable or verified provider runtime"));
        }
        const child = spawn(executable, args, {
            cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...options.env }, windowsHide: true,
            detached: process.platform !== "win32",
        });
        active.add(child);
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        const limit = options.maxBytes ?? 2 * 1024 * 1024;
        let bytes = 0, settled = false, failure: Error | undefined;
        const kill = (signal: NodeJS.Signals) => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch {}
        };
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error) => {
            if (failure) return;
            failure = error;
            kill("SIGTERM");
            killTimer = setTimeout(() => kill("SIGKILL"), 500);
            killTimer.unref();
        };
        const abort = () => stop(new Error("Operation aborted", { cause: options.signal?.reason }));
        const timeout = setTimeout(() => stop(new Error("Provider operation timed out")), options.timeout ?? 30_000);
        const cleanup = () => {
            active.delete(child);
            clearTimeout(timeout);
            clearTimeout(killTimer);
            options.signal?.removeEventListener("abort", abort);
        };
        const finish = (error?: Error, code?: number | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error ?? failure) reject(error ?? failure);
            else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1, truncated: false });
        };
        const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > limit) stop(new Error("Provider output exceeded its limit; result incomplete"));
            else chunks.push(chunk);
        };
        child.stdout?.on("data", capture(stdout));
        child.stderr?.on("data", capture(stderr));
        child.once("error", (error) => finish(error));
        child.once("close", (code) => finish(undefined, code));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
    });
    async function dispose() {
        disposed = true;
        const children = [...active];
        const waiters = children.map((child) => new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("close", () => resolve());
        }));
        const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch {}
        };
        for (const child of children) kill(child, "SIGTERM");
        const timer = setTimeout(() => { for (const child of children) kill(child, "SIGKILL"); }, 500);
        const { promise: deadline, resolve: finish } = Promise.withResolvers<void>();
        const deadlineTimer = setTimeout(finish, 1500);
        try { await Promise.race([Promise.all(waiters), deadline]); }
        finally { clearTimeout(timer); clearTimeout(deadlineTimer); }
    }
    return { run, dispose };
}
