import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { root, openApp, scriptedModel, newSession, owner, say, cleanUp } from "../pi-pocket/test/helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../pi-pocket/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { createHandler } from "../pi-pocket/src/server/http.ts";
import { test } from "node:test";

test("owner-confirmed edit-plus-command actions apply edits in order and reject unconfirmed/replayed tokens", async () => {
    const workspace = join(root, "command-workspace"), data = join(root, "command-data"), extensions = join(data, "extensions");
    mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true }); mkdirSync(extensions, { recursive: true });
    const file = join(workspace, "source.ts"), log = join(workspace, "command.log");
    writeFileSync(file, "export const value = 1;\n");
    writeFileSync(join(workspace, "package.json"), "{}");
    const serverScript = join(workspace, "node_modules", ".bin", "typescript-language-server");
    writeFileSync(serverScript, `#!/usr/bin/env node
const fs=require('node:fs');let buffer=Buffer.alloc(0),uri,version=1,pending;
function send(m){const b=Buffer.from(JSON.stringify(m));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]));}
const edit=(value)=>({changes:{[uri]:[{range:{start:{line:0,character:21},end:{line:0,character:22}},newText:String(value)}]}});
function diagnostics(){send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version,diagnostics:[]}});}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const len=Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+len)return;const m=JSON.parse(buffer.subarray(end+4,end+4+len));buffer=buffer.subarray(end+4+len);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{capabilities:{textDocumentSync:1,codeActionProvider:true,executeCommandProvider:{commands:['fixture.finish']}}}});
 else if(m.method==='textDocument/didOpen'){uri=m.params.textDocument.uri;version=m.params.textDocument.version;diagnostics();}
 else if(m.method==='textDocument/didChange'){version=m.params.textDocument.version;diagnostics();}
 else if(m.method==='textDocument/codeAction')send({jsonrpc:'2.0',id:m.id,result:[{title:'No source changes',edit:{changes:{[uri]:[]}}},{title:'Advance value with command',edit:edit(2),command:{title:'Finish',command:'fixture.finish'}}]});
 else if(m.method==='workspace/executeCommand'){const value=fs.readFileSync(${JSON.stringify(file)},'utf8');if(value!=='export const value = 2;\\n'){send({jsonrpc:'2.0',id:m.id,error:{code:-32001,message:'Primary edit did not precede command'}});continue;}fs.appendFileSync(${JSON.stringify(log)},'command-after-primary\\n');pending=m.id;send({jsonrpc:'2.0',id:'server-edit',method:'workspace/applyEdit',params:{edit:edit(3)}});}
 else if(!m.method&&m.id==='server-edit'){if(!m.result?.applied){send({jsonrpc:'2.0',id:pending,error:{code:-32002,message:'Server edit refused'}});continue;}fs.appendFileSync(${JSON.stringify(log)},'server-edit-approved\\n');send({jsonrpc:'2.0',id:pending,result:null});}
 else if(m.method==='shutdown')send({jsonrpc:'2.0',id:m.id,result:null});else if(m.method==='exit')process.exit(0);
}});
`);
    chmodSync(serverScript, 0o755);
    for (const name of ["pi-lsp.ts", "pi-lsp.js"]) cpSync(new URL(`./${name}`, import.meta.url), join(extensions, name));
    cpSync(new URL("./pi-lsp/", import.meta.url), join(extensions, "pi-lsp"), { recursive: true });
    let pending: { name: string; args: Record<string, unknown> } | undefined;
    const results: { name: string; text: string; data?: Record<string, any>; isError: boolean }[] = [], seen = new Set<string>();
    const model = scriptedModel((request) => {
        for (const message of request.messages) {
            if (message.role !== "toolResult" || seen.has(message.toolCallId)) continue;
            seen.add(message.toolCallId);
            const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            const match = /<tooling_data>\n([\s\S]*)\n<\/tooling_data>/.exec(text);
            results.push({ name: message.toolName, text, data: match ? JSON.parse(match[1]!) : undefined, isError: message.isError });
        }
        if (pending) { const call = pending; pending = undefined; return fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" }); }
        return fauxAssistantMessage([fauxText("Observed")]);
    });
    const app = await openApp(model, data);
    let http: ReturnType<typeof createServer> | undefined;
    try {
        await app.setExtensionEnabled(owner(app), "pi-lsp.ts", true);
        await app.setExtensionEnabled(owner(app), "codemode.ts", false);
        const id = await newSession(app, workspace);
        pending = { name: "lsp_query", args: { action: "code_actions", file: "source.ts", line: 0, character: 0 } };
        await say(app, id, "List code actions");
        const listed = results.findLast((row) => row.name === "lsp_query")!;
        assert.equal(listed.isError, false, listed.text);
        assert.equal(listed.data!.items[0].noChanges, true);
        const proposalId = listed.data!.proposals[0].id;
        assert.equal(readFileSync(file, "utf8"), "export const value = 1;\n");
        pending = { name: "fana_apply", args: { proposalId } }; await say(app, id, "Attempt unconfirmed command");
        const denied = results.findLast((row) => row.name === "fana_apply")!;
        assert.equal(denied.isError, true); assert.match(denied.text, /owner confirmation/);
        assert.equal(readFileSync(file, "utf8"), "export const value = 1;\n");
        http = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} }));
        http.listen(0, "127.0.0.1"); await once(http, "listening");
        const port = (http.address() as { port: number }).port;
        const request = async (name: string, body: unknown) => {
            const response = await fetch(`http://127.0.0.1:${port}/api/x/pi-lsp/c/${id}/tooling/${name}`, { method: "POST", headers: { "X-Pocket": "1", Authorization: `Bearer ${app.config.ownerToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
            return { status: response.status, data: await response.json() as Record<string, any> };
        };
        const prepared = await request("prepare", { provider: "lsp", action: "apply", proposalId });
        assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
        const unconfirmed = await request("execute", { token: prepared.data.token, confirmed: false });
        assert.equal(unconfirmed.status, 400);
        assert.equal(readFileSync(file, "utf8"), "export const value = 1;\n");
        const executed = await request("execute", { token: prepared.data.token, confirmed: true });
        assert.equal(executed.status, 200, JSON.stringify(executed.data));
        assert.equal(executed.data.command.status, "completed", JSON.stringify(executed.data));
        assert.equal(readFileSync(file, "utf8"), "export const value = 3;\n");
        assert.equal(readFileSync(log, "utf8"), "command-after-primary\nserver-edit-approved\n");
        const replay = await request("execute", { token: prepared.data.token, confirmed: true });
        assert.equal(replay.status, 400);
        assert.equal(readFileSync(file, "utf8"), "export const value = 3;\n");
        // Each confirmed command creates a primary and derived receipt. Cross the
        // 20-record retention boundary without turning completed work into a blocker.
        for (let iteration = 0; iteration < 10; iteration++) {
            pending = { name: "lsp_query", args: { action: "code_actions", file: "source.ts", line: 0, character: 0 } };
            await say(app, id, "Preview the next logical change");
            const next = results.findLast((row) => row.name === "lsp_query")!;
            assert.equal(next.isError, false, next.text);
            const plan = await request("prepare", { provider: "lsp", action: "apply", proposalId: next.data!.proposals[0].id });
            const applied = await request("execute", { token: plan.data.token, confirmed: true });
            assert.equal(applied.data.command.status, "completed", JSON.stringify(applied.data));
        }
        assert.equal(readFileSync(file, "utf8"), "export const value = 3;\n");
    } finally {
        if (http) { http.closeAllConnections(); await new Promise<void>((resolve) => http!.close(() => resolve())); }
        await app.close(); cleanUp();
    }
});
