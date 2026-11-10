import { root, openApp, scriptedModel, cleanUp, context } from "../pi-pocket/test/helpers.ts";
import type { App } from "../pi-pocket/test/helpers.ts";
import type { Host } from "../pi-pocket/types/pocket.d.ts";
import type * as LspModule from "./pi-lsp.ts";
import type { Extension, ToolHooks } from "../pi-pocket/node_modules/@earendil-works/pi-durable/dist/index.d.ts";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getEventListeners, once } from "node:events";
import { after, before, test } from "node:test";

const data = join(root, "lsp-regression");
const dropIn = join(data, "extensions");
const workspace = join(root, "café # project");
const source = join(workspace, "source.ts");
const uri = pathToFileURL(source).href;
const fixture = join(root, "lsp-fixture.mjs");
const shutdownLog = join(root, "shutdown.log");
let app: App;
let lsp: typeof LspModule;
let extension: Extension;
let tools: NonNullable<Extension["tools"]>;
let hookCwd = workspace;
const settings = new Map<string, unknown>();
interface InstallerOutcome { ok?: boolean; status: string; available?: boolean; executable?: string; installer?: { exitCode: number }; error?: string; servers?: unknown }
interface RequestFixture { body: unknown; user: { id: string }; signal: AbortSignal; context: typeof context; snapshot(): Promise<undefined>; commit(change: (tx: { doc(): Promise<{ value: unknown }> }) => unknown): Promise<unknown> }
type RouteFixture = (request: RequestFixture) => Promise<InstallerOutcome>;
const routes = new Map<string, RouteFixture>();
let disposeManual: (() => Promise<void>) | undefined;
const api = { conversationId: 1, env: { cwd: workspace }, agent: async () => ({ cwd: workspace }) } as never;
const host: Pick<Host, "requesterOf" | "roleOf" | "cwdOf"> = {
    requesterOf: (id) => id === 1 ? "owner-person" : id === 2 ? "guest-person" : undefined,
    roleOf: (person) => person === "owner-person" ? "owner" : person === "guest-person" ? "guest" : undefined,
    cwdOf: () => hookCwd,
};

before(async () => {
    mkdirSync(dropIn, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(source, "const café = 42;\n");
    writeFileSync(join(workspace, "package.json"), "{}");
    writeFileSync(join(dropIn, "pi-lsp.ts"), readFileSync(new URL("./pi-lsp.ts", import.meta.url)));
    writeFileSync(join(dropIn, "pi-lsp.js"), readFileSync(new URL("./pi-lsp.js", import.meta.url)));
    cpSync(new URL("./pi-lsp/", import.meta.url), join(dropIn, "pi-lsp"), { recursive: true });
    writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
const mode=process.argv[2], log=process.argv[3];
let buffer=Buffer.alloc(0), opened=false, definition, configuration=false, unsupported=false;
let sending=Promise.resolve();
function send(message, split=false) {
 sending=sending.then(async()=>{
  const body=Buffer.from(JSON.stringify(message));
  const frame=Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body]);
  if(split){
   const cut=frame.indexOf(Buffer.from('🦀'))+1;
   process.stdout.write(frame.subarray(0,cut));
   const {promise,resolve}=Promise.withResolvers(); setImmediate(resolve); await promise;
   process.stdout.write(frame.subarray(cut));
  } else process.stdout.write(frame);
 });
}
const issue=(code,message,severity=1)=>({code,message,severity,range:{start:{line:0,character:0},end:{line:0,character:1}}});
function complete(){
 if(!definition||!configuration||!unsupported)return;
 send({jsonrpc:'2.0',id:definition,result:{uri:'file:///fixture/caf%C3%A9.ts',range:{start:{line:4,character:2},end:{line:4,character:6}}}});
 definition=undefined;
}
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]);
 for(;;){
  const end=buffer.indexOf('\\r\\n\\r\\n'); if(end<0)return;
  const length=Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,end).toString())[1]);
  if(buffer.length<end+4+length)return;
  const message=JSON.parse(buffer.subarray(end+4,end+4+length).toString());
  buffer=buffer.subarray(end+4+length);
  if(message.method==='initialize'){
   if(mode==='exit'){process.stderr.write('deliberate startup failure');process.exit(7);}
   if(mode==='reject')send({jsonrpc:'2.0',id:message.id,error:{code:-32002,message:'initialization rejected'}});
   else if(mode!=='hung')send({jsonrpc:'2.0',id:message.id,result:{capabilities:{definitionProvider:true,textDocumentSync:1,...(mode.includes('pull')?{diagnosticProvider:{}}:{})}}});
  } else if(message.method==='textDocument/didOpen'){
   opened=message.params.textDocument.text.includes('café');
   if(mode==='valid')send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:message.params.textDocument.uri,version:message.params.textDocument.version,diagnostics:[issue(9000,'café 🦀',2)]}},true);
  } else if(message.method==='textDocument/didChange'){
   if(mode==='valid'){
    const {uri,version}=message.params.textDocument;
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version,diagnostics:{invalid:'not an array'}}});
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version:'invalid',diagnostics:[]}});
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version:version-1,diagnostics:[issue(9001,'obsolete report')]}});
    const diagnostics=message.params.contentChanges[0].text.includes('error')?[issue(9002,'current source error')]:[];
    send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version,diagnostics}});
   }
  } else if(message.method==='textDocument/diagnostic'){
   if(mode==='pull')send({jsonrpc:'2.0',id:message.id,result:{kind:'full',items:[issue(9010,'pull diagnostic')]}});
   if(mode==='badpull')send({jsonrpc:'2.0',id:message.id,result:{kind:'unchanged',resultId:'not-requested'}});
  } else if(message.method==='textDocument/definition'){
   if(!opened)send({jsonrpc:'2.0',id:message.id,error:{code:-32002,message:'document not opened'}});
   else if(message.params.position.line===99)send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'bad position'}});
   else{
    definition=message.id;
    send({jsonrpc:'2.0',id:message.id,method:'workspace/configuration',params:{items:[]}});
    send({jsonrpc:'2.0',id:'unsupported-request',method:'fixture/unsupported',params:{}});
   }
  } else if(message.method==='shutdown'){
   appendFileSync(log,'shutdown\\n');send({jsonrpc:'2.0',id:message.id,result:null});
  } else if(message.method==='exit'){
   appendFileSync(log,'exit\\n');process.exit(0);
  } else if(!message.method&&message.id===definition){configuration=Array.isArray(message.result)&&message.result.length===0;complete();}
  else if(!message.method&&message.id==='unsupported-request'){unsupported=message.error?.code===-32601;complete();}
 }
});
`);
    app = await openApp(scriptedModel(), data);
    // The runtime-selected copy gets Pocket's actual dependency links; static import cannot load this boundary first.
    lsp = await import(pathToFileURL(join(dropIn, "pi-lsp.ts")).href);
    for (const id of Object.keys(lsp.LSP_SERVERS)) delete lsp.LSP_SERVERS[id];
    lsp.LSP_SERVERS.fixture = { command: process.execPath, args: [fixture, "valid", shutdownLog], fileTypes: [".ts"], rootMarkers: ["package.json"] };
    const web = {
        client() {}, route(method: string, path: string, handler: RouteFixture) { routes.set(`${method} ${path}`, handler); }, conversationRoute() {}, onDispose(dispose: () => Promise<void>) { disposeManual = dispose; }, settings() {}, send() {},
        setting: (name: string) => settings.get(name),
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    };
    extension = lsp.default(host as never, web as never);
    tools = extension.tools!;
});

after(async () => { await disposeManual?.(); await lsp?.stopAllClients(); await app?.close(); cleanUp(); });
const tool = (name: string) => tools.find(item => item.name === name)!;
async function diagnostics(file = "source.ts") {
    const result = await tool("lsp_diagnostics").execute({ file } as never, api, context);
    const output = result.output?.[0];
    assert.ok(output?.type === "text");
    return JSON.parse(output.text) as Record<string, Array<{ code: number; severity: number }>>;
}

 test("fragmented Unicode, colliding server request IDs, RPC rejection and ordered shutdown", async () => {
    const result = await tool("lsp_definition").execute({ server: "fixture", file: "source.ts", line: 0, character: 6 } as never, api, context);
    const output = result.output?.[0];
    assert.ok(output?.type === "text");
    assert.deepEqual(JSON.parse(output.text), { uri: "file:///fixture/caf%C3%A9.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } } });
    const client = lsp.clients.get(`fixture:${workspace}`)!;
    assert.equal((client.diagnostics.get(uri)?.[0] as { message: string }).message, "café 🦀");
    await assert.rejects(tool("lsp_definition").execute({ server: "fixture", file: "source.ts", line: 99, character: 0 } as never, api, context));
    assert.equal(client.pending.size, 0);
    await lsp.stopClient(`fixture:${workspace}`);
    assert.equal(client.process.exitCode, 0);
    assert.equal(readFileSync(shutdownLog, "utf8"), "shutdown\nexit\n");
});

test("rejected initialize and early exit leave no running instance", async () => {
    for (const mode of ["reject", "exit"]) {
        await assert.rejects(lsp.startServer(mode, { ...lsp.LSP_SERVERS.fixture, args: [fixture, mode, shutdownLog] }, workspace));
        assert.equal(lsp.clients.has(`${mode}:${workspace}`), false);
    }
});

test("concurrent starts share one process; disposal and broken pipes reject pending startup", async () => {
    const config = lsp.LSP_SERVERS.fixture;
    const [a, b] = await Promise.all([lsp.startServer("dedup", config, workspace), lsp.startServer("dedup", config, workspace)]);
    assert.equal(a, b);
    await lsp.stopClient(`dedup:${workspace}`);
    const starting = lsp.startServer("hung", { ...config, args: [fixture, "hung", shutdownLog] }, workspace);
    const rejected = assert.rejects(starting);
    await lsp.stopAllClients(); await rejected;
    assert.equal(lsp.clients.size, 0);
    const broken = lsp.startServer("broken", { ...config, args: [fixture, "hung", shutdownLog] }, workspace);
    const brokenRejection = assert.rejects(broken);
    const client = lsp.clients.get(`broken:${workspace}`)!;
    const exited = once(client.process, "exit");
    client.process.stdin!.destroy(new Error("broken stdio"));
    await brokenRejection; await exited;
    assert.equal(client.pending.size, 0);
    assert.equal(lsp.clients.has(`broken:${workspace}`), false);
});

test("status is workspace-scoped and executable lookup honors ancestor bins and file permissions", async () => {
    await lsp.startServer("fixture", lsp.LSP_SERVERS.fixture, workspace);
    const result = await tool("lsp_status").execute({} as never, api, context);
    const output = result.output?.[0]; assert.ok(output?.type === "text");
    assert.deepEqual(JSON.parse(output.text).active.map((item: { id: string }) => item.id), ["fixture"]);
    const elsewhere = await tool("lsp_status").execute({} as never, { env: { cwd: root } } as never, context);
    assert.ok(elsewhere.output?.[0]?.type === "text");
    assert.deepEqual(JSON.parse(elsewhere.output[0].text).active, []);
    await assert.rejects(tool("lsp_status").execute({} as never, { env: { cwd: "ssh://host/workspace" } } as never, context));
    const bin = join(workspace, "node_modules", ".bin"), nested = join(workspace, "nested");
    mkdirSync(bin, { recursive: true }); mkdirSync(nested);
    const command = `fixture-${basename(root)}`, candidate = join(bin, command);
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    assert.equal(lsp.findExecutable(command, nested), undefined);
    chmodSync(candidate, 0o755);
    assert.equal(lsp.findExecutable(command, nested), candidate);
    mkdirSync(join(bin, "directory-only"));
    assert.equal(lsp.findExecutable("directory-only", nested), undefined);
    assert.equal(lsp.matchesMarkersOrExtensions(lsp.LSP_SERVERS.fixture, nested), true);
});

test("Go install bin discovery works without PATH and preserves workspace precedence", () => {
    const old = process.env.GOBIN, oldPath = process.env.PATH;
    const bin = join(root, "go tools"), local = join(workspace, "node_modules", ".bin", "gopls");
    mkdirSync(bin); const executable = join(bin, "gopls");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.GOBIN = bin;
    process.env.PATH = "";
    try {
        assert.equal(lsp.findExecutable("gopls", workspace), executable);
        writeFileSync(local, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        assert.equal(lsp.findExecutable("gopls", workspace), local);
    } finally {
        if (old === undefined) delete process.env.GOBIN; else process.env.GOBIN = old;
        if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
});

test("all installer routes verify discovery; failed updates retain availability without claiming success", async () => {
    const executable = join(root, "installer-server");
    const request = (body: unknown): RequestFixture => ({ body, user: { id: "owner-person" }, signal: new AbortController().signal, context, snapshot: async () => undefined, commit: async (change) => change({ doc: async () => ({ value: null }) }) });
    lsp.LSP_SERVERS.installFixture = { command: executable, fileTypes: [".fixture"], rootMarkers: [], installCmd: "true", uninstallCmd: "true" };
    try {
        const missing = await routes.get("POST install")!(request({ serverId: "installFixture" }));
        assert.equal(missing.ok, false); assert.equal(missing.status, "failed");
        assert.equal(missing.installer?.exitCode, 0); assert.match(missing.error ?? "", /no usable provider executable/);
        assert.equal(missing.servers, undefined, "Operation outcomes must not dump the whole registry");
        writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        lsp.LSP_SERVERS.installFixture.installCmd = "printf 'update failed' >&2; exit 7";
        const update = await routes.get("POST tooling/execute")!(request({ provider: "lsp", action: "install", serverId: "installFixture" }));
        assert.equal(update.status, "failed"); assert.equal(update.available, true);
        assert.equal(update.executable, executable); assert.equal(update.installer?.exitCode, 7);
        assert.match(update.error ?? "", /update failed/);
        const unchanged = await routes.get("POST uninstall")!(request({ serverId: "installFixture" }));
        assert.equal(unchanged.ok, false); assert.match(unchanged.error ?? "", /removal is not verified/);
        lsp.LSP_SERVERS.installFixture.installCmd = "true";
        const detected = await routes.get("POST install")!(request({ serverId: "installFixture" }));
        assert.equal(detected.ok, true); assert.equal(detected.executable, executable);
    } finally { delete lsp.LSP_SERVERS.installFixture; }
});

test("non-owners cannot stop an owner's client, start processes or synchronize files", async () => {
    const client = lsp.clients.get(`fixture:${workspace}`)!;
    const previousFiles = client.openFiles.size;
    for (const id of [2, 3]) {
        const denied = { conversationId: id, env: { cwd: workspace } } as never;
        for (const action of ["start", "stop", "install", "uninstall"]) await assert.rejects(tool("lsp_manage").execute({ server: "fixture", action } as never, denied, context));
        await assert.rejects(tool("lsp_definition").execute({ server: "fixture", file: "source.ts", line: 0, character: 0 } as never, denied, context));
        await assert.rejects(tool("lsp_diagnostics").execute({ file: "source.ts" } as never, denied, context));
    }
    assert.equal(client.running, true);
    assert.equal(lsp.clients.size, 1);
    assert.equal(client.openFiles.size, previousFiles);
});

test("first file check lazily activates one matching server and unsupported files never reach it", async () => {
    await lsp.stopClient(`fixture:${workspace}`);
    const checked = await diagnostics();
    assert.equal(checked[uri][0].code, 9000);
    assert.equal(lsp.clients.size, 1);
    const unsupported = join(workspace, "notes.xyz"); writeFileSync(unsupported, "private unrelated text");
    await assert.rejects(diagnostics("notes.xyz"));
    assert.equal(lsp.clients.get(`fixture:${workspace}`)!.openFiles.has(pathToFileURL(unsupported).href), false);
});

test("changed text discards malformed/stale reports and a fixed version clears earlier errors", async () => {
    writeFileSync(source, "const café = 'error';\n");
    assert.deepEqual((await diagnostics())[uri].map(item => item.code), [9002]);
    writeFileSync(source, "const café = 42;\n");
    assert.deepEqual((await diagnostics())[uri], []);
});

test("owner edit hooks synchronize current text; failed/disabled/guest/remote/outside edits do not", async () => {
    const afterTool = (extension.hooks![0].handlers as Partial<ToolHooks>).afterTool!;
    const call = { name: "edit", arguments: { path: "source.ts" }, id: "edit-check", type: "toolCall" } as never;
    const result = { output: [{ type: "text" as const, text: "edit completed" }] };
    writeFileSync(source, "const café = 'error';\n");
    await afterTool(call, result, { conversationId: 1 } as never, context);
    const client = lsp.clients.get(`fixture:${workspace}`)!;
    assert.equal((client.diagnostics.get(uri)![0] as { code: number }).code, 9002);
    const version = client.openFiles.get(uri)!.version;
    writeFileSync(source, "const café = 42;\n");
    await afterTool(call, { ...result, isError: true }, { conversationId: 1 } as never, context);
    await afterTool(call, { ...result, diagnostics: [{ code: "blocked", severity: "error", message: "blocked" }] }, { conversationId: 1 } as never, context);
    await afterTool(call, result, { conversationId: 2 } as never, context);
    settings.set("autoCheck", false);
    await afterTool(call, result, { conversationId: 1 } as never, context);
    settings.delete("autoCheck");
    hookCwd = "ssh://host/project";
    await afterTool(call, result, { conversationId: 1 } as never, context);
    hookCwd = workspace;
    const outside = join(root, "outside.ts"); writeFileSync(outside, "const café = 42;\n");
    const link = join(workspace, "outside-link.ts"); symlinkSync(outside, link);
    await afterTool({ ...call, arguments: { path: link } } as never, result, { conversationId: 1 } as never, context);
    assert.equal(client.openFiles.has(pathToFileURL(link).href), false);
    assert.equal(client.openFiles.get(uri)!.version, version);
});

test("expired, aborted and stopped diagnostic waits remove timers and abort listeners", async (t) => {
    const client = await lsp.startServer("silent", { ...lsp.LSP_SERVERS.fixture, args: [fixture, "silent", shutdownLog] }, workspace);
    const synced = lsp.syncFileToClient(client, source);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const expired = assert.rejects(lsp.waitForFreshDiagnostics(client, uri, synced.version, context, 500));
    t.mock.timers.tick(500); await expired; t.mock.timers.reset();
    assert.equal(client.diagnosticWaiters.size, 0);
    const controller = new AbortController();
    const cancelContext = { ...context, abortSignal: controller.signal };
    const canceled = assert.rejects(lsp.waitForFreshDiagnostics(client, uri, synced.version, cancelContext));
    controller.abort(); await canceled;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(client.diagnosticWaiters.size, 0);
    const stopped = assert.rejects(lsp.waitForFreshDiagnostics(client, uri, synced.version, context));
    await lsp.stopClient(`silent:${workspace}`); await stopped;
    assert.equal(client.diagnosticWaiters.size, 0);
});

test("pull diagnostics require full reports and canceled pulls do not retain RPC work", async () => {
    for (const mode of ["pull", "badpull", "holdpull"]) {
        const client = await lsp.startServer(mode, { ...lsp.LSP_SERVERS.fixture, args: [fixture, mode, shutdownLog] }, workspace);
        const synced = lsp.syncFileToClient(client, source);
        if (mode === "pull") {
            const result = await lsp.waitForFreshDiagnostics(client, uri, synced.version, context);
            assert.equal((result[0] as { code: number }).code, 9010);
        } else if (mode === "badpull") {
            await assert.rejects(lsp.waitForFreshDiagnostics(client, uri, synced.version, context));
            assert.equal(client.diagnostics.has(uri), false);
        } else {
            const controller = new AbortController();
            const canceled = assert.rejects(lsp.waitForFreshDiagnostics(client, uri, synced.version, { ...context, abortSignal: controller.signal }));
            controller.abort(); await canceled;
            assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        }
        assert.equal(client.pending.size, 0);
        await lsp.stopClient(`${mode}:${workspace}`);
    }
});
