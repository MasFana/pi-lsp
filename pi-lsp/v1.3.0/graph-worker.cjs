"use strict";
// Short-lived SDK worker. It never invokes the CLI, MCP, watchers or installers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort(new Error("CodeGraph operation cancelled")));
process.env.CODEGRAPH_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";
process.env.CODEGRAPH_DIR = ".codegraph";
const request = JSON.parse(process.argv[2]);
const errorText = (error) => error instanceof Error ? error.message : String(error);
function within(root, target) {
    const rel = path.relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function safeFile(root, value) {
    if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) throw new Error("Invalid indexed file path");
    const resolved = path.resolve(root, value);
    if (!within(root, resolved)) throw new Error("Indexed file escapes the workspace");
    let existing = resolved;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error("Cannot resolve indexed file containment");
        existing = parent;
    }
    if (!within(root, fs.realpathSync(existing))) throw new Error("Indexed file symlink escapes the workspace");
    return path.relative(root, resolved).split(path.sep).join("/");
}
function indexPaths(root, required) {
    const directory = path.join(root, ".codegraph"), db = path.join(directory, "codegraph.db");
    if (!fs.existsSync(directory)) {
        if (required) throw new Error("No CodeGraph index in this workspace; creation requires explicit owner action");
        return { directory, db, initialized: false };
    }
    const entry = fs.lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("CodeGraph index directory is not a canonical workspace-local directory");
    for (const name of fs.readdirSync(directory)) {
        if (fs.lstatSync(path.join(directory, name)).isSymbolicLink()) throw new Error("CodeGraph index contains a symlink; refusing borrowed/external index data");
    }
    if (!fs.existsSync(db)) {
        if (required) throw new Error("CodeGraph directory has no database; explicit rebuild is required");
        return { directory, db, initialized: false };
    }
    const stat = fs.lstatSync(db);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(db) !== db) throw new Error("CodeGraph database is not an exclusive workspace-local file");
    return { directory, db, initialized: true };
}
function generation(root, db, graph) {
    const stat = fs.statSync(db);
    const revision = graph.getIndexRevision(), build = graph.getIndexBuildInfo();
    // WAL checkpoints move bytes between files without changing indexed content.
    return crypto.createHash("sha256").update(JSON.stringify([root, stat.dev, stat.ino, stat.birthtimeMs, revision, build, graph.getIndexState()])).digest("hex");
}
function metadata(root, paths, graph) {
    const status = { indexRoot: root, indexPath: paths.db, initialized: paths.initialized, buildState: "unknown", engineCompatibility: "unknown", sourceFreshness: "unknown", coverage: "unknown", builtAt: null, buildVersion: null, extractionVersion: null };
    if (!graph) return status;
    const build = graph.getIndexBuildInfo();
    status.buildState = graph.getIndexState() ?? "unknown";
    status.builtAt = graph.getLastIndexedAt();
    status.buildVersion = build.version;
    status.extractionVersion = build.extractionVersion;
    status.engineCompatibility = status.builtAt === null ? "unknown" : graph.isIndexStale() ? "rebuild_recommended" : "current";
    status.coverage = status.buildState === "complete" ? "indexed_static_evidence" : "incomplete_or_unknown";
    status.generation = generation(root, paths.db, graph);
    return status;
}
function freshness(graph, status) {
    const changed = graph.getChangedFiles();
    const total = changed.added.length + changed.modified.length + changed.removed.length;
    status.sourceFreshness = total ? "known_changed" : "checked_current";
    status.sourceCheckedAt = Date.now();
    status.changedFileCount = total;
    status.changedFiles = [...changed.added.slice(0, 50), ...changed.modified.slice(0, 50), ...changed.removed.slice(0, 50)].slice(0, 50);
    status.changedFilesTruncated = total > 50;
}
function nodeValue(root, node, generationId) {
    return { id: String(node.id).slice(0, 256), generation: generationId, name: String(node.name).slice(0, 512), qualifiedName: String(node.qualifiedName).slice(0, 1024), kind: node.kind, file: safeFile(root, node.filePath), language: node.language, startLine: node.startLine, endLine: node.endLine, startColumn: node.startColumn, endColumn: node.endColumn, ...(node.signature ? { signature: String(node.signature).slice(0, 1024) } : {}) };
}
function edgeValue(edge) { return { source: edge.source, target: edge.target, kind: edge.kind }; }
function resolveSymbol(root, graph, args, generationId) {
    const direct = graph.getNode(args.symbol);
    const file = args.file ? safeFile(root, args.file) : undefined;
    if (direct) {
        if (!args.generation) return { result: { status: "unavailable", message: "An indexed symbol ID requires its returned generation; select a symbol from this index generation", generation: generationId } };
        if (file && safeFile(root, direct.filePath) !== file) return { result: { status: "empty", items: [], message: "The indexed ID does not belong to the requested file" } };
        return { node: direct };
    }
    // SQL search is capped. Do not silently select a first-name match or infer
    // uniqueness when a candidate page has reached its limit.
    const candidates = graph.searchNodes(args.symbol, { limit: 151, caseSensitive: true });
    const exact = candidates.filter(({ node }) => (node.name === args.symbol || node.qualifiedName === args.symbol) && (!file || safeFile(root, node.filePath) === file));
    if (exact.length === 1 && candidates.length < 151) return { node: exact[0].node };
    if (exact.length === 0 && candidates.length < 151) return { result: { status: "empty", items: [], message: "No exact indexed symbol; use explore to select a symbol ID and generation" } };
    return { result: { status: "ok", items: exact.slice(0, args.maxResults).map(({ node }) => nodeValue(root, node, generationId)), ambiguity: true, truncated: exact.length > args.maxResults || candidates.length === 151, message: "Symbol is ambiguous or candidate search exceeded its bound; select an indexed ID with its generation", generation: generationId } };
}
async function query(root, graph, args, status, packageRoot) {
    const limit = args.maxResults, depth = args.depth, id = status.generation;
    if (args.generation && args.generation !== id) return { status: "unavailable", message: "Index generation changed; explore again before reusing symbol IDs", generation: id };
    const evidence = { generation: id, coverage: status.coverage, engineCompatibility: status.engineCompatibility, sourceFreshness: status.sourceFreshness, evidence: "Indexed static relationships are not exhaustive and do not authorize edits" };
    let focal;
    if (args.symbol) {
        const selected = resolveSymbol(root, graph, args, id);
        if (selected.result) return { ...selected.result, ...evidence };
        focal = selected.node;
    }
    if (args.action === "affected_tests") {
        const file = focal ? safeFile(root, focal.filePath) : safeFile(root, args.file);
        const { isTestPath } = require(path.join(packageRoot, "dist", "search", "query-utils.js"));
        const visited = new Set([file]), tests = new Set(), queue = [{ file, depth: 0 }];
        let cursor = 0, truncated = false;
        while (cursor < queue.length) {
            if (controller.signal.aborted) throw controller.signal.reason;
            const current = queue[cursor++];
            if (isTestPath(current.file)) { tests.add(current.file); continue; }
            if (current.depth >= depth) continue;
            for (const dependent of graph.getFileDependents(current.file)) {
                const safe = safeFile(root, dependent);
                if (visited.has(safe)) continue;
                if (visited.size >= 1000 || tests.size >= limit + 1) { truncated = true; break; }
                visited.add(safe);
                if (isTestPath(safe)) tests.add(safe);
                else queue.push({ file: safe, depth: current.depth + 1 });
            }
            if (truncated) break;
        }
        return { ...evidence, status: tests.size ? "ok" : "empty", items: [...tests].sort().slice(0, limit).map((file) => ({ file, candidate: true })), total: tests.size, truncated: truncated || tests.size > limit, totalIsLowerBound: truncated, visitedFiles: visited.size, message: "Test candidates from indexed dependencies and CodeGraph's test-path classifier; no tests were run" };
    }
    let nodes = [], edges = [], boundedContext = false;
    if (args.action === "explore") {
        if (focal) {
            const subgraph = graph.traverse(focal.id, { maxDepth: depth });
            nodes = [...subgraph.nodes.values()];
            edges = subgraph.edges;
            if (!nodes.some((node) => node.id === focal.id)) nodes.unshift(focal);
        } else {
            const subgraph = await graph.findRelevantContext(args.query, { maxNodes: limit + 1, searchLimit: Math.min(limit + 1, 30), traversalDepth: depth });
            nodes = [...subgraph.nodes.values()];
            edges = subgraph.edges;
        }
        boundedContext = nodes.length >= limit + 1;
    } else if (args.action === "callers" || args.action === "callees") {
        const values = args.action === "callers" ? graph.getCallers(focal.id, depth) : graph.getCallees(focal.id, depth);
        nodes = values.map((value) => value.node);
        edges = values.map((value) => value.edge);
    } else if (args.action === "impact") {
        const subgraph = graph.getImpactRadius(focal.id, depth);
        nodes = [...subgraph.nodes.values()];
        edges = subgraph.edges;
    } else return { ...evidence, status: "unsupported", message: "Unsupported graph action" };
    const items = nodes.slice(0, limit).map((node) => nodeValue(root, node, id));
    const visible = new Set(items.map((node) => node.id));
    if (focal) visible.add(focal.id);
    const relevantEdges = edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
    return { ...evidence, status: items.length ? "ok" : "empty", items, total: nodes.length, totalIsLowerBound: boundedContext, truncated: nodes.length > limit || relevantEdges.length > limit * 4, edges: relevantEdges.slice(0, limit * 4).map(edgeValue), ...(focal ? { focal: nodeValue(root, focal, id) } : {}) };
}

(async () => {
    let graph, status, root, paths, operationResult;
    let sdkLoading = false, mutationStarted = false;
    try {
        root = fs.realpathSync(request.root);
        if (root !== path.resolve(request.root)) throw new Error("Worker root is not canonical");
        const packageRoot = fs.realpathSync(request.packageRoot), pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
        const sdk = fs.realpathSync(request.sdk);
        if (pkg.name !== "@colbymchenry/codegraph" || pkg.version !== "1.6.2" || sdk !== path.join(packageRoot, "dist", "index.js")) throw new Error("Unverified CodeGraph SDK identity");
        const [major, minor] = process.versions.node.split(".").map(Number);
        if (major < 22 || major >= 25 || (major === 22 && minor < 5)) throw new Error(`Incompatible CodeGraph worker runtime Node ${process.versions.node}`);
        paths = indexPaths(root, request.kind === "query" || (request.kind === "operate" && request.action === "sync"));
        status = metadata(root, paths);
        // A missing index read ends before importing or opening the SDK.
        if (!paths.initialized && request.kind !== "operate") {
            process.stdout.write(JSON.stringify({ status, ...(request.kind === "query" ? { result: { status: "unavailable", message: "No CodeGraph index in this workspace" } } : {}) }));
            return;
        }
        sdkLoading = true;
        const { CodeGraph, setLogger, silentLogger } = require(sdk);
        sdkLoading = false;
        if (setLogger && silentLogger) setLogger(silentLogger);
        if (request.kind === "operate" && request.action !== "refresh") {
            if (request.action === "create") {
                if (paths.initialized) throw new Error("CodeGraph index already exists; use an explicit sync or rebuild");
                mutationStarted = true;
                graph = await CodeGraph.init(root, { index: false });
                paths = indexPaths(root, true);
                operationResult = await graph.indexAll({ signal: controller.signal });
            } else if (request.action === "rebuild") {
                // The public SDK recreates only the explicitly selected index DB,
                // bypassing old-schema migrations before the full index run.
                mutationStarted = true;
                graph = paths.initialized ? await CodeGraph.recreate(root) : await CodeGraph.init(root, { index: false });
                paths = indexPaths(root, true);
                operationResult = await graph.indexAll({ signal: controller.signal });
            } else if (request.action === "sync") {
                graph = await CodeGraph.open(root, { readOnly: false, sync: false });
                mutationStarted = true;
                operationResult = await graph.sync({ signal: controller.signal });
            } else throw new Error("Unsupported graph operation");
            status = metadata(root, paths, graph);
            if (operationResult.success === false) status.buildState = "failed";
            else if (operationResult.filesErrored > 0 || operationResult.failedFilePaths?.length || (operationResult.filesDiscovered !== undefined && operationResult.filesDiscovered > operationResult.filesIndexed + operationResult.filesSkipped + operationResult.filesErrored)) status.buildState = "partial";
            status.coverage = status.buildState === "complete" ? "indexed_static_evidence" : "incomplete_or_unknown";
            freshness(graph, status);
            status.operationResult = {
                success: operationResult.success ?? !operationResult.failedFilePaths?.length,
                filesIndexed: operationResult.filesIndexed ?? null, filesDiscovered: operationResult.filesDiscovered ?? null,
                filesErrored: operationResult.filesErrored ?? operationResult.failedFilePaths?.length ?? 0,
                filesAdded: operationResult.filesAdded ?? null, filesModified: operationResult.filesModified ?? null, filesRemoved: operationResult.filesRemoved ?? null,
                durationMs: operationResult.durationMs, errors: [...(operationResult.errors ?? []).slice(0, 20).map((error) => ({ message: String(error.message ?? error).slice(0, 1000), ...(error.filePath ? { file: String(error.filePath).slice(0, 1000) } : {}) })), ...(operationResult.failedFilePaths ?? []).slice(0, 20).map((file) => ({ file: String(file).slice(0, 1000), message: "Sync could not extract this file" }))].slice(0, 20),
            };
            if (controller.signal.aborted) throw controller.signal.reason;
            process.stdout.write(JSON.stringify({ status }));
            return;
        }
        if (!paths.initialized) { process.stdout.write(JSON.stringify({ status })); return; }
        graph = await CodeGraph.open(root, { readOnly: true, sync: false });
        if (fs.realpathSync(graph.getProjectRoot()) !== root) throw new Error("CodeGraph opened a different workspace index");
        status = metadata(root, paths, graph);
        if (request.kind === "operate" && request.action === "refresh") freshness(graph, status);
        if (request.kind === "query") {
            const args = request.args;
            if (!Number.isInteger(args.depth) || args.depth < 0 || args.depth > 5 || !Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > 150) throw new Error("Invalid graph query bounds");
            const result = await query(root, graph, args, status, packageRoot);
            if (generation(root, paths.db, graph) !== status.generation) throw new Error("Index changed during query; result was discarded, retry against the new generation");
            process.stdout.write(JSON.stringify({ status, result }));
        } else process.stdout.write(JSON.stringify({ status }));
    } catch (error) {
        if (graph && root && paths) { try { status = metadata(root, paths, graph); } catch {} }
        const cancelled = controller.signal.aborted;
        if (mutationStarted && status) {
            status.sourceFreshness = "unknown";
            status.coverage = "incomplete_or_unknown";
            if (status.buildState === "complete") status.buildState = cancelled ? "partial" : "failed";
        }
        if (sdkLoading || /no such (?:table|column)|schema|incompatible.*runtime/i.test(errorText(error))) {
            status = { ...status, compatible: false, engineCompatibility: "incompatible" };
        }
        process.stdout.write(JSON.stringify({ status, error: errorText(error).slice(0, 2000), cancelled }));
        process.exitCode = 1;
    } finally {
        if (graph) { try { graph.close(); } catch (error) { process.stderr.write(`CodeGraph close failed: ${errorText(error)}\n`); process.exitCode = 1; } }
    }
})().catch((error) => { process.stderr.write(errorText(error)); process.exitCode = 1; });
