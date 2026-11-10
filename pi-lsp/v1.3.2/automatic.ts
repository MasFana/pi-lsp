import { resolve } from "node:path";

export interface AutomaticDeps {
    isOwner: (personId: string) => boolean;
    probe: (cwd: string, personId: string, signal?: AbortSignal) => Promise<{ indexed: boolean }>;
    sync: (cwd: string, personId: string, signal?: AbortSignal) => Promise<void>;
    notify: (cwd: string) => void;
    canOperate: (cwd: string) => boolean;
    refreshMs?: number;
    debounceMs?: number;
}

export interface AutomaticProviders {
    ensure(cwd: string, personId: string): void;
    changed(cwd: string, personId: string, files?: string[]): void;
    prepareQuery(cwd: string, personId: string, signal?: AbortSignal): Promise<void>;
    dispose(): Promise<void>;
}

interface RootState {
    cwd: string;
    indexed?: boolean;
    lastAttempt?: number;
    dirty: number;
    synced: number;
    timer?: NodeJS.Timeout;
    wake?: () => void;
    inFlight?: { controller: AbortController; promise: Promise<void>; queryOwned: boolean };
    waiters: number;
}

export function createAutomaticProviders(deps: AutomaticDeps): AutomaticProviders {
    const refreshMs = deps.refreshMs ?? 300_000, debounceMs = deps.debounceMs ?? 300;
    const roots = new Map<string, RootState>();
    let disposed = false;
    const cancelTimer = (state: RootState) => { clearTimeout(state.timer); state.timer = undefined; state.wake?.(); state.wake = undefined; };
    const stateFor = (cwd: string) => {
        cwd = resolve(cwd);
        let state = roots.get(cwd);
        if (!state) {
            if (roots.size >= 8) {
                const idle = [...roots.values()].find((root) => !root.inFlight && !root.waiters);
                if (!idle) throw new Error("Automatic workspace limit reached; wait for a current operation");
                cancelTimer(idle); roots.delete(idle.cwd);
            }
            state = { cwd, dirty: 0, synced: 0, waiters: 0 }; roots.set(cwd, state);
        }
        return state;
    };
    const assertActive = (actor: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (disposed || !deps.isOwner(actor)) throw new Error("Automatic provider owner authority ended");
    };
    const schedule = (state: RootState, actor: string) => {
        cancelTimer(state);
        state.timer = setTimeout(() => { state.timer = undefined; void run(state, actor, false).catch(() => {}); }, debounceMs);
        state.timer.unref();
    };
    const run = (state: RootState, actor: string, queryOwned: boolean): Promise<void> => {
        if (state.inFlight) return state.inFlight.promise;
        cancelTimer(state);
        const controller = new AbortController();
        let success = false;
        // Assign single-flight state before entering provider code, including immediate failures.
        const promise = Promise.resolve().then(async () => {
            assertActive(actor, controller.signal);
            if (!deps.canOperate(state.cwd)) {
                await new Promise<void>((wake) => {
                    state.wake = wake;
                    state.timer = setTimeout(() => { state.timer = undefined; state.wake = undefined; wake(); }, Math.min(debounceMs, 500));
                });
                assertActive(actor, controller.signal);
                if (!deps.canOperate(state.cwd)) throw new Error(`Conflicting graph operation running in ${state.cwd}`);
            }
            const before = state.dirty, now = Date.now();
            const probe = state.indexed === undefined || state.indexed === false || now - (state.lastAttempt ?? 0) >= refreshMs;
            state.lastAttempt = now;
            if (probe) {
                state.indexed = (await deps.probe(state.cwd, actor, controller.signal)).indexed;
                assertActive(actor, controller.signal);
            }
            if (state.indexed) { await deps.sync(state.cwd, actor, controller.signal); assertActive(actor, controller.signal); }
            state.synced = before; success = true;
        }).finally(() => {
            state.inFlight = undefined;
            // Failed work stays dirty; retry only on a later edit, query or TTL cycle.
            if (success && !disposed && deps.isOwner(actor) && state.dirty !== state.synced) schedule(state, actor);
            deps.notify(state.cwd);
        });
        state.inFlight = { controller, promise, queryOwned };
        return promise;
    };
    return {
        ensure(cwd, actor) {
            if (disposed || !deps.isOwner(actor)) return;
            const state = stateFor(cwd);
            if (state.inFlight || state.timer || state.lastAttempt !== undefined && Date.now() - state.lastAttempt < refreshMs) return;
            void run(state, actor, false).catch(() => {});
        },
        changed(cwd, actor, files) {
            if (disposed || !deps.isOwner(actor) || !files?.length) return;
            const state = stateFor(cwd); state.dirty++;
            if (!state.inFlight) schedule(state, actor);
        },
        async prepareQuery(cwd, actor, signal) {
            if (disposed || !deps.isOwner(actor)) throw new Error("Automatic provider owner authority required");
            signal?.throwIfAborted();
            const state = stateFor(cwd); state.waiters++;
            let onAbort: (() => void) | undefined;
            const aborted = signal ? new Promise<never>((_resolve, reject) => {
                onAbort = () => {
                    if (state.waiters === 1 && state.inFlight?.queryOwned) state.inFlight.controller.abort(signal.reason);
                    reject(signal.reason);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }) : undefined;
            try {
                do {
                    signal?.throwIfAborted();
                    const work = state.inFlight?.promise ?? run(state, actor, !state.timer);
                    await (aborted ? Promise.race([work, aborted]) : work);
                } while (state.dirty !== state.synced);
                if (disposed || !deps.isOwner(actor)) throw new Error("Automatic provider owner authority ended");
            } finally { state.waiters--; if (onAbort) signal?.removeEventListener("abort", onAbort); }
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            const pending: Promise<void>[] = [];
            for (const state of roots.values()) {
                cancelTimer(state);
                if (state.inFlight) { state.inFlight.controller.abort(new Error("Automatic provider disposed")); pending.push(state.inFlight.promise); }
            }
            let timer: NodeJS.Timeout | undefined;
            try { await Promise.race([Promise.allSettled(pending), new Promise<void>((wake) => { timer = setTimeout(wake, 1500); })]); }
            finally { clearTimeout(timer); roots.clear(); }
        },
    };
}
