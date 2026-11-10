import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { GraphProvider } from "./pi-lsp/v1.3.1/graph.ts";
import { createProcessRunner } from "./pi-lsp/v1.3.1/process.ts";
const find = (command: string) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command)).find((path) => existsSync(path));
const binary = find("codegraph");
async function fixture(run: (root: string, graph: GraphProvider, setOwner: (value: boolean) => void) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "fana-real-graph-"));
    const runner = createProcessRunner(); let owner = true;
    try {
        await writeFile(join(root, "math.ts"), "export function calculate(value: number) { return value * 2; }\n");
        await writeFile(join(root, "caller.ts"), "import { calculate } from './math';\nexport function callCalculate(value: number) { return calculate(value); }\n");
        await writeFile(join(root, "math.test.ts"), "import { calculate } from './math';\nexport function testCalculate() { return calculate(2) === 4; }\n");
        const graph = new GraphProvider({ run: runner.run, findExecutable: (name) => name === "codegraph" ? binary : find(name), assertOwner() { if (!owner) throw new Error("Owner authority required"); } });
        await run(root, graph, (value) => { owner = value; });
    } finally { await runner.dispose(); await rm(root, { recursive: true, force: true }); }
}
test("real graph queries never initialize a missing project index", { skip: !binary }, async () => fixture(async (root, graph, setOwner) => {
    const status = await graph.probe(root);
    assert.equal(status.available, true, status.error);
    assert.equal(status.initialized, false);
    const result = await graph.query(root, { action: "explore", query: "calculate" });
    assert.equal(result.status, "unavailable");
    assert.equal(existsSync(join(root, ".codegraph")), false);
    setOwner(false);
    await assert.rejects(graph.query(root, { action: "explore", query: "calculate" }), /Owner/);
}));
test("real explicit indexing, bounded queries, source freshness and sync stay distinct", { skip: !binary }, async () => fixture(async (root, graph) => {
    const built = await graph.operate(root, { action: "create" });
    assert.equal(built.initialized, true, built.error);
    assert.equal(built.buildState, "complete", built.error);
    assert.equal(built.sourceFreshness, "checked_current", built.error);
    const explored = await graph.query(root, { action: "explore", query: "calculate", maxResults: 10 });
    assert.equal(explored.status, "ok", explored.message);
    assert.match(JSON.stringify(explored.items), /calculate/);
    assert.equal(explored.generation, built.generation, "Read-only opens and WAL checkpoints do not change logical index identity");
    assert.equal(graph.cachedStatus(root).sourceFreshness, "checked_current");
    const symbol = (explored.items as { name: string; file: string; startColumn: number; endColumn: number }[]).find((item) => item.name === "calculate" && item.file === "math.ts");
    assert.ok(symbol);
    assert.equal(typeof symbol.startColumn, "number");
    assert.equal(typeof symbol.endColumn, "number");
    const callers = await graph.query(root, { action: "callers", symbol: "calculate", file: "math.ts" });
    assert.equal(callers.status, "ok", callers.message);
    assert.match(JSON.stringify(callers.items), /callCalculate|testCalculate/);
    await writeFile(join(root, "math.ts"), "export function calculate(value: number) { return value * 3; }\n");
    graph.markChanged(root, [join(root, "math.ts")]);
    assert.equal(graph.cachedStatus(root).sourceFreshness, "known_changed");
    const refreshed = await graph.operate(root, { action: "refresh" });
    assert.equal(refreshed.sourceFreshness, "known_changed", refreshed.error);
    assert.equal(refreshed.engineCompatibility, "current", refreshed.error);
    const synced = await graph.operate(root, { action: "sync" });
    assert.equal(synced.sourceFreshness, "checked_current", synced.error);
    assert.equal(existsSync(join(root, ".git", "hooks", "post-commit")), false);
    assert.equal(existsSync(join(root, ".codegraph", "daemon.pid")), false);
}));
test("real graph ambiguity and index generations cannot silently select another symbol", { skip: !binary }, async () => fixture(async (root, graph) => {
    await mkdir(join(root, "other")); await writeFile(join(root, "other", "math.ts"), "export function calculate(value: number) { return value + 1; }\n");
    const built = await graph.operate(root, { action: "create" }); assert.equal(built.buildState, "complete", built.error);
    const ambiguous = await graph.query(root, { action: "callers", symbol: "calculate" });
    assert.equal(ambiguous.ambiguity, true, ambiguous.message);
    const candidates = ambiguous.items as { id: string; file: string; generation: string }[];
    const selected = candidates.find((item) => item.file === "math.ts"); assert.ok(selected);
    const exact = await graph.query(root, { action: "callers", symbol: selected.id, generation: selected.generation });
    assert.equal(exact.status, "ok", exact.message);
    await writeFile(join(root, "math.ts"), "export function calculate(value: number) { return value * 5; }\n");
    await graph.operate(root, { action: "sync" });
    const stale = await graph.query(root, { action: "callers", symbol: selected.id, generation: selected.generation });
    assert.equal(stale.status, "unavailable"); assert.match(stale.message ?? "", /generation changed/);
}));

test("explicit graph rebuild recovers an uninitialized directory without deleting owner metadata", { skip: !binary }, async () => fixture(async (root, graph) => {
    const directory = join(root, ".codegraph");
    await mkdir(directory); await writeFile(join(directory, "owner.note"), "keep this metadata");
    const rebuilt = await graph.operate(root, { action: "rebuild" });
    assert.equal(rebuilt.initialized, true, rebuilt.error);
    assert.equal(rebuilt.buildState, "complete", rebuilt.error);
    assert.equal(await readFile(join(directory, "owner.note"), "utf8"), "keep this metadata");
}));
