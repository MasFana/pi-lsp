import { root, openApp, scriptedModel, cleanUp, context } from "../pi-pocket/test/helpers.ts";
import type { App } from "../pi-pocket/test/helpers.ts";
import type * as LspModule from "./pi-lsp.ts";
import type { Extension } from "../pi-pocket/node_modules/@earendil-works/pi-durable/dist/index.d.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { after, before, test } from "node:test";

const data = join(root, "lsp-regression");
const dropIn = join(data, "extensions");
const workspace = join(root, "café # project");
const source = join(workspace, "source.ts");
const fixture = join(root, "lsp-fixture.mjs");
const shutdownLog = join(root, "shutdown.log");
let app: App;
let lsp: typeof LspModule;
let tools: NonNullable<Extension["tools"]>;
const api = { env: { cwd: workspace }, agent: async () => ({ cwd: workspace }) } as never;

before(async () => {
    mkdirSync(dropIn, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(source, "const café = 42;\n");
    writeFileSync(join(workspace, "package.json"), "{}");
    writeFileSync(join(dropIn, "pi-lsp.ts"), readFileSync(new URL("./pi-lsp.ts", import.meta.url)));
    writeFileSync(join(dropIn, "pi-lsp.js"), readFileSync(new URL("./pi-lsp.js", import.meta.url)));
    writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
const mode = process.argv[2], log = process.argv[3];
let buffer = Buffer.alloc(0), opened = false, definition, configuration = false, unsupported = false;
let sending = Promise.resolve();
function send(message, split = false) {
    sending = sending.then(async () => {
        const body = Buffer.from(JSON.stringify(message));
        const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]);
        if (split) {
            const cut = frame.indexOf(Buffer.from('🦀')) + 1;
            process.stdout.write(frame.subarray(0, cut));
            const {promise, resolve} = Promise.withResolvers();
            setImmediate(resolve);
            await promise;
            process.stdout.write(frame.subarray(cut));
        } else process.stdout.write(frame);
    });
}
function complete() {
    if (!definition || !configuration || !unsupported) return;
    send({jsonrpc:'2.0',id:definition,result:{uri:'file:///fixture/caf%C3%A9.ts',range:{start:{line:4,character:2},end:{line:4,character:6}}}});
    definition = undefined;
}
process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const end = buffer.indexOf('\\r\\n\\r\\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,end).toString())[1]);
        if (buffer.length < end + 4 + length) return;
        const message = JSON.parse(buffer.subarray(end+4,end+4+length).toString());
        buffer = buffer.subarray(end+4+length);
        if (message.method === 'initialize') {
            if (mode === 'exit') { process.stderr.write('deliberate startup failure'); process.exit(7); }
            if (mode === 'reject') send({jsonrpc:'2.0',id:message.id,error:{code:-32002,message:'initialization rejected'}});
            else if (mode !== 'hung') send({jsonrpc:'2.0',id:message.id,result:{capabilities:{definitionProvider:true,textDocumentSync:1}}});
        } else if (message.method === 'textDocument/didOpen') {
            opened = message.params.textDocument.text.includes('café');
            send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:message.params.textDocument.uri,diagnostics:[{message:'café 🦀',severity:2,range:{start:{line:0,character:0},end:{line:0,character:1}}}]}}, true);
        } else if (message.method === 'textDocument/definition') {
            if (!opened) send({jsonrpc:'2.0',id:message.id,error:{code:-32002,message:'document not opened'}});
            else if (message.params.position.line === 99) send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'bad position'}});
            else {
                definition = message.id;
                send({jsonrpc:'2.0',id:message.id,method:'workspace/configuration',params:{items:[]}});
                send({jsonrpc:'2.0',id:'unsupported-request',method:'fixture/unsupported',params:{}});
            }
        } else if (message.method === 'shutdown') {
            appendFileSync(log, 'shutdown\\n');
            send({jsonrpc:'2.0',id:message.id,result:null});
        } else if (message.method === 'exit') {
            appendFileSync(log, 'exit\\n');
            process.exit(0);
        } else if (!message.method && message.id === definition) {
            configuration = Array.isArray(message.result) && message.result.length === 0;
            complete();
        } else if (!message.method && message.id === 'unsupported-request') {
            unsupported = message.error?.code === -32601;
            complete();
        }
    }
});
`);
    app = await openApp(scriptedModel(), data);
    // Runtime-selected drop-in gets Pocket's compatibility package links on open.
    lsp = await import(pathToFileURL(join(dropIn, "pi-lsp.ts")).href);
    const web = {
        client() {}, route() {}, conversationRoute() {}, onDispose() {},
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    };
    tools = lsp.default({} as never, web as never).tools!;
    lsp.LSP_SERVERS.fixture = { command: process.execPath, args: [fixture, "valid", shutdownLog], fileTypes: [".ts"], rootMarkers: ["package.json"] };
});

after(async () => { await lsp?.stopAllClients(); await app?.close(); cleanUp(); });

const tool = (name: string) => tools.find(item => item.name === name)!;

test("fragmented UTF-8, server request ID collisions, RPC errors, and graceful shutdown", async () => {
    const result = await tool("lsp_definition").execute({ server: "fixture", file: "source.ts", line: 0, character: 6 } as never, api, context);
    const output = result.output?.[0];
    assert.ok(output && output.type === "text");
    assert.deepEqual(JSON.parse(output.text), {
        uri: "file:///fixture/caf%C3%A9.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } },
    });
    const client = lsp.clients.get(`fixture:${workspace}`)!;
    const diagnostic = client.diagnostics.get(pathToFileURL(source).href)?.[0];
    assert.ok(diagnostic && typeof diagnostic === "object" && "message" in diagnostic);
    assert.equal(diagnostic.message, "café 🦀");
    await assert.rejects(tool("lsp_definition").execute({ server: "fixture", file: "source.ts", line: 99, character: 0 } as never, api, context), /bad position/);
    assert.equal(client.pending.size, 0);
    await lsp.stopClient(`fixture:${workspace}`);
    assert.equal(client.process.exitCode, 0);
    assert.equal(readFileSync(shutdownLog, "utf8"), "shutdown\nexit\n");
});

test("startup rejection and process exit never leave a running instance", async () => {
    for (const mode of ["reject", "exit"]) {
        const config = { ...lsp.LSP_SERVERS.fixture, args: [fixture, mode, shutdownLog] };
        await assert.rejects(lsp.startServer(mode, config, workspace), mode === "reject" ? /initialization rejected/ : /deliberate startup failure/);
        assert.equal(lsp.clients.has(`${mode}:${workspace}`), false);
    }
});

test("concurrent startup shares one process and disposal cancels pending initialization", async () => {
    const config = lsp.LSP_SERVERS.fixture;
    const [a, b] = await Promise.all([lsp.startServer("dedup", config, workspace), lsp.startServer("dedup", config, workspace)]);
    assert.equal(a, b);
    await lsp.stopClient(`dedup:${workspace}`);
    const starting = lsp.startServer("hung", { ...config, args: [fixture, "hung", shutdownLog] }, workspace);
    const rejected = assert.rejects(starting, /stopped|initialization/);
    await lsp.stopAllClients();
    await rejected;
    assert.equal(lsp.clients.size, 0);
    const broken = lsp.startServer("broken", { ...config, args: [fixture, "hung", shutdownLog] }, workspace);
    const brokenRejection = assert.rejects(broken, /broken stdio/);
    const client = lsp.clients.get(`broken:${workspace}`)!;
    const exited = once(client.process, "exit");
    client.process.stdin!.destroy(new Error("broken stdio"));
    await brokenRejection;
    await exited;
    assert.equal(client.pending.size, 0);
    assert.equal(lsp.clients.has(`broken:${workspace}`), false);
});

test("session context wins over process cwd, and executable lookup finds executable ancestor bins", async () => {
    const status = await tool("lsp_status").execute({} as never, { env: undefined, agent: async () => ({ cwd: workspace }) } as never, context);
    const output = status.output?.[0];
    assert.ok(output && output.type === "text");
    assert.equal(JSON.parse(output.text).cwd, workspace);
    await assert.rejects(tool("lsp_status").execute({} as never, { env: { cwd: "ssh://host/workspace" } } as never, context), /Remote workspaces/);
    const bin = join(workspace, "node_modules", ".bin");
    const sub = join(workspace, "nested");
    mkdirSync(bin, { recursive: true }); mkdirSync(sub);
    const candidate = join(bin, "fixture-executable");
    writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
    assert.equal(lsp.findExecutable("fixture-executable", sub), undefined);
    chmodSync(candidate, 0o755);
    assert.equal(lsp.findExecutable("fixture-executable", sub), candidate);
    assert.equal(lsp.matchesMarkersOrExtensions(lsp.LSP_SERVERS.fixture, sub), true);
    mkdirSync(join(bin, "directory-only"));
    assert.equal(lsp.findExecutable("directory-only", sub), undefined);
});

test("package installation and removal reject non-owner session requesters", async () => {
    const extension = lsp.default({ requesterOf: () => "guest", roleOf: () => "guest" } as never);
    const manage = extension.tools!.find(item => item.name === "lsp_manage")!;
    for (const action of ["install", "uninstall"]) {
        await assert.rejects(manage.execute({ server: "typescript-language-server", action } as never, api, context), /Only the owner/);
    }
});
