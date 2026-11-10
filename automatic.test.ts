import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutomaticProviders, type AutomaticDeps } from "./pi-lsp/v1.3.2/automatic.ts";

const settle = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
function fixture(overrides: Partial<AutomaticDeps> = {}) {
    let indexed = true, owner = true, busy = false, probes = 0, syncs = 0;
    const automatic = createAutomaticProviders({
        isOwner: () => owner, canOperate: () => !busy, notify() {},
        probe: async () => { probes++; return { indexed }; }, sync: async () => { syncs++; },
        ...overrides,
    });
    return { automatic, counts: () => ({ probes, syncs }), indexed: (value: boolean) => { indexed = value; }, owner: (value: boolean) => { owner = value; }, busy: (value: boolean) => { busy = value; } };
}

test("automatic detection respects owner, missing-index policy and TTL rather than panel polling", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture();
    try {
        f.owner(false); f.automatic.ensure("/workspace", "owner"); await settle();
        assert.deepEqual(f.counts(), { probes: 0, syncs: 0 });
        f.owner(true); f.indexed(false); f.automatic.ensure("/workspace", "owner"); await settle();
        assert.deepEqual(f.counts(), { probes: 1, syncs: 0 });
        t.mock.timers.tick(15_000); f.automatic.ensure("/workspace", "owner"); await settle();
        assert.deepEqual(f.counts(), { probes: 1, syncs: 0 });
        f.indexed(true); f.automatic.changed("/workspace", "owner", ["new.ts"]); t.mock.timers.tick(300); await settle();
        assert.deepEqual(f.counts(), { probes: 2, syncs: 1 });
        t.mock.timers.tick(300_001); f.automatic.ensure("/workspace", "owner"); await settle();
        assert.deepEqual(f.counts(), { probes: 3, syncs: 2 });
    } finally { await f.automatic.dispose(); t.mock.timers.reset(); }
});

test("source bursts debounce and status events cannot bypass the pending debounce", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture();
    try {
        await f.automatic.prepareQuery("/workspace", "owner");
        for (const file of ["a.ts", "b.ts", "c.ts"]) {
            f.automatic.changed("/workspace", "owner", [file]);
            f.automatic.ensure("/workspace", "owner"); t.mock.timers.tick(100); await settle();
        }
        assert.equal(f.counts().syncs, 1);
        t.mock.timers.tick(200); await settle();
        assert.equal(f.counts().syncs, 2);
    } finally { await f.automatic.dispose(); t.mock.timers.reset(); }
});

test("graph queries join owned busy work and await edits that arrive during sync", async () => {
    const gate = Promise.withResolvers<void>(); let syncs = 0, busy = false;
    const f = fixture({ canOperate: () => !busy, sync: async () => { syncs++; busy = true; if (syncs === 1) await gate.promise; busy = false; } });
    try {
        f.automatic.ensure("/workspace", "owner"); await settle();
        f.automatic.changed("/workspace", "owner", ["during.ts"]);
        let completed = false;
        const query = f.automatic.prepareQuery("/workspace", "owner").then(() => { completed = true; });
        await settle(); assert.equal(completed, false);
        gate.resolve(); await query;
        assert.equal(syncs, 2);
    } finally { gate.resolve(); await f.automatic.dispose(); }
});

test("queries sync even without watcher events; failed sync does not loop and retries remain possible", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let fail = false, syncs = 0;
    const f = fixture({ sync: async () => { syncs++; if (fail) throw new Error("disk failure"); } });
    try {
        await f.automatic.prepareQuery("/workspace", "owner");
        await f.automatic.prepareQuery("/workspace", "owner"); assert.equal(syncs, 2);
        fail = true; f.automatic.changed("/workspace", "owner", ["edited.ts"]);
        t.mock.timers.tick(300); await settle(); assert.equal(syncs, 3);
        t.mock.timers.tick(15_000); f.automatic.ensure("/workspace", "owner"); await settle(); assert.equal(syncs, 3);
        await assert.rejects(f.automatic.prepareQuery("/workspace", "owner"), /disk failure/);
        fail = false; await f.automatic.prepareQuery("/workspace", "owner"); assert.equal(syncs, 5);
    } finally { await f.automatic.dispose(); t.mock.timers.reset(); }
});

test("aborting one query cannot cancel owner edit work or another query sharing it", async () => {
    const gate = Promise.withResolvers<void>(); let aborted = false;
    const f = fixture({ sync: async (_cwd, _person, signal) => { signal?.addEventListener("abort", () => { aborted = true; }); await gate.promise; } });
    try {
        f.automatic.changed("/workspace", "owner", ["edited.ts"]);
        const stop = new AbortController();
        const first = f.automatic.prepareQuery("/workspace", "owner", stop.signal);
        const second = f.automatic.prepareQuery("/workspace", "owner");
        await settle(); stop.abort(new Error("caller cancelled"));
        await assert.rejects(first, /caller cancelled/); assert.equal(aborted, false);
        gate.resolve(); await second;
    } finally { gate.resolve(); await f.automatic.dispose(); }
});

test("unreleased conflicts fail after bounded deferral and disposal wakes deferred queries", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture();
    try {
        f.busy(true);
        const rejected = assert.rejects(f.automatic.prepareQuery("/workspace", "owner"), /Conflicting graph operation/);
        await settle(); t.mock.timers.tick(300); await rejected;
        const disposed = assert.rejects(f.automatic.prepareQuery("/workspace", "owner"), /disposed/);
        await settle(); await f.automatic.dispose(); await disposed;
    } finally { await f.automatic.dispose(); t.mock.timers.reset(); }
});

test("owner revocation stops dirty follow-up and disposal bounds a non-cooperating operation", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let aborted = false;
    const f = fixture({ sync: async (_cwd, _person, signal) => { signal?.addEventListener("abort", () => { aborted = true; }); await new Promise<void>(() => {}); } });
    try {
        f.automatic.ensure("/workspace", "owner"); await settle();
        f.owner(false);
        await assert.rejects(f.automatic.prepareQuery("/workspace", "owner"), /owner authority/);
        const closed = f.automatic.dispose(); t.mock.timers.tick(1500); await closed;
        assert.equal(aborted, true);
    } finally { await f.automatic.dispose(); t.mock.timers.reset(); }
});
