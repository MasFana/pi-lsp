# Pi LSP

Language Server Protocol (LSP) integration for [Pi Pocket](https://github.com/TannerMidd/pi-pocket): lazy server startup, post-edit diagnostics, prompt guidance, custom tool-call presentations, and an owner management dashboard. Published via the [OMP Registry](https://github.com/MasFana/OMP); source at [MasFana/pi-lsp](https://github.com/MasFana/pi-lsp).

Requires Pi Pocket `>= 0.28.0` (`pocketApi = 2`), Node `>= 22.19.0` (native TypeScript execution), and `Type` imported directly from `typebox`.

> **Runtime:** This is a Pocket drop-in, not a standalone npm package or executable. Pocket supplies runtime dependencies and the type-only `./_pocket.d.ts` link in its prepared `extensions/` folder. A local `node_modules` development symlink is optional and is not shipped. Bare `node pi-lsp.ts` is not the supported execution path; use Pocket's loader or the regression suite with a sibling Pocket checkout.

## Installation & Updates

### Extension Gallery (OMP)
1. In Pi Pocket, open **Menu → Extensions → Discover**.
2. In the bottom index input, enter `MasFana/OMP` (or raw `index.json` URL) and confirm.
3. Locate **Pi LSP** and click Install. Extensions install disabled; toggle the switch to enable.
4. Updates never apply automatically: review diffs and apply updates in the **Updates** tab.

### Manual Drop-in & Reload
Copy `pi-lsp.ts` and `pi-lsp.js` to Pi Pocket's data directory `extensions/`. Enable `pi-lsp.ts` in **Menu → Extensions**. When modifying either file, click **Reload**: Pocket captures browser assets per loaded revision, so replacing `pi-lsp.js` alone does not refresh active browser tabs.

## Architecture & Lifecycle

- **Workspace Authority**: CWD resolves from Durable context (`api.env.cwd` or `await api.agent(context).cwd`). Remote workspace schemes (`ssh://`, `docker://`, etc.) are explicitly rejected with an error.
- **Executable Lookup**: `findExecutable` checks relative paths against CWD, walks upward through ancestor `node_modules/.bin` directories to the root, then scans system `PATH` (incorporating `PATHEXT` on Windows). Projects detect via upward `rootMarkers` or source file extensions (`fileTypes`).
- **Stdio RPC Protocol**: Framed with JSON-RPC 2.0 over standard I/O using byte-length headers (`Content-Length: <bytes>\r\n\r\n`). Client and server request IDs are isolated; unhandled incoming server requests receive JSON-RPC `-32601`. Broken stdio pipes abort pending requests and cleanly tear down child processes.
- **Concurrency & shutdown:** One process per `${server}:${workspaceRoot}`; concurrent starts share an initialization promise. Initialization and ordinary requests time out after 10 seconds. Stop attempts `shutdown` RPC for at most 1 second, sends `exit`, then schedules `SIGTERM` after 500 ms and `SIGKILL` after 1,500 ms if needed. The worst-case kill request is about 2.5 seconds after stop, within Pocket's 3-second disposal window.
- **File Sync & Diagnostics**: Encoded file URIs handle Unicode, spaces and `#`. First sync sends `didOpen`; changed text sends versioned `didChange`, invalidates the old cache, and avoids re-sending unchanged text. File checks wait up to 5 seconds for a valid current report: push diagnostics or advertised pull diagnostics. Older versioned reports are discarded; malformed/unchanged pull reports and timeouts are errors, never an empty “clean” result. Unversioned push reports cannot prove an exact document version.

## Automatic Editing Workflow

- `lsp_workflow` is a model prompt section explaining diagnostics, owner-only actions, lazy startup, and using `lsp_diagnostics` after edits. It appears when LSP tools are offered to the model or available through codemode-only calls. Diagnostics do not replace tests, builds, or actual runtime verification.
- A `ToolTask.afterTool` hook checks successful **Pi `edit`/`write` calls**, including codemode calls. It appends actual diagnostics or an explicit not-verified report to the edit result without discarding the original output, diff/details, or control fields.
- Checks run only for the current Pocket owner, recognized source extensions, and real paths within the local session workspace. Failed/blocked/aborted edits, guest edits, remote/outside paths and `.env*` files do not trigger checks. There is no filesystem watcher: external-editor or shell writes require an explicit file check.
- If no matching server is active, start **one** installed executable matching the file extension, preferring a compiler over a linter; catalog order breaks ties. Existing matching active servers contribute combined diagnostics. No directory-wide startup, recursive source scan, or automatic package installation occurs.
- **Owner setting:** Menu → Extensions → Pi LSP → `Automatic post-edit diagnostics` (`autoCheck`, default `true`). Turning it off suppresses new post-edit checks; it does not stop running servers or disable explicit file diagnostics/definitions. Core persists this boolean; the extension does not directly read authentication/configuration files.
- An executable permission check is not a trust check. Auto-start can execute workspace `node_modules/.bin` code; language servers inherit the host environment (possibly credentials), receive synchronized file contents, and may independently read files or use the network. Enable automatic checks only for trusted workspaces/binaries.

## Agent Tools

| Tool | Parameters | Annotations | Behavior |
| :--- | :--- | :--- | :--- |
| `lsp_status` | None (`{}`) | `readOnlyHint: true` | Returns `{ active: [...], detected: [...], cwd }` for session workspace. |
| `lsp_diagnostics` | `file?: string` | `readOnlyHint: true` | With `file`: owner-only, lazily starts an eligible server, syncs and awaits current diagnostics `{ [uri]: Diagnostic[] }`. Without `file`: received, non-stale workspace cache only; no full-tree scan or startup. Incomplete checks fail rather than claiming clean. |
| `lsp_definition` | `server: string`, `file: string`, `line: number`, `character: number` | None | Owner-only. Absolute or session-relative file; 0-based UTF-16 positions. Starts an inactive selected server, synchronizes the file, and returns LSP location results. |
| `lsp_manage` | `server: string`, `action: "start" \| "stop" \| "install" \| "uninstall"` | None | All actions require the current Pocket owner. Unsupported servers/actions and lifecycle/package failures are tool errors. |

`readOnlyHint` classifies filesystem effects for Plan mode; it is not authorization or an OS sandbox. Status and cached no-file diagnostics remain inspectable by permitted session participants; starting/stopping or synchronizing file data does not.

## Web Endpoints & Dashboard

Paths below are relative to `/api/x/pi-lsp/`. Routes require the owner and `X-Pocket: 1` on every method, including GET; `pocket.api()` supplies the header. Raw `fetch()` without it receives 403. `web.onDispose` stops active clients.

- `GET servers?cwd=PATH` / `GET c/:conversation/servers`: Returns `{ servers, cwd }`; rows cover the entire catalog with availability, project-match, and workspace-running flags. Global CWD defaults to the Pocket server's directory; conversation CWD is authoritative.
- `POST c/:conversation/start` / `POST c/:conversation/stop`: Starts/stops server for conversation CWD (`{ serverId }`).
- `POST start` / `POST stop`: Starts/stops server for explicit CWD (`{ serverId, cwd }`).
- `POST install` / `POST uninstall`: Executes catalog package command (`{ serverId }`).

### Browser Dashboard UI
- **Panels & Launchers**: Slide-in sheet (`pocket.sheet`), menu item (`pocket.menu`), and Cmd/Ctrl+K launcher entry (`pocket.launcher`).
- **Filters**: `Detected` (matched markers/extensions), `Running` (active in current workspace), `All` (entire catalog).
- **Status Badge**: Header `${count} LSP active` / `${count} LSP`; refreshes on conversation change and `lsp-changed` events, with 15-second polling as a fallback. The sheet refreshes live too. Zero active servers or failed reads clear stale badges.
- **Resilience**: Navigation cancels in-flight requests; errors remain visible with Retry. Disposal clears intervals, requests, subscriptions, status and presentation handles.

### Tool-call presentations
The owner browser registers `pocket.toolCall` for all four tools: status/workspace, diagnostics/file, definition/file-and-1-based display position, and management/action-and-server. Calls have a code icon, readable subjects and deduplicated group summaries. Malformed historical arguments degrade safely. This API formats **call labels/subjects**, not arbitrary result bodies or inline IDE diagnostics; normal result JSON and edit diffs remain available.

## Server Catalog (54 Server Definitions)

Configured in `LSP_SERVERS` inside `pi-lsp.ts`. To register or modify servers, edit `LSP_SERVERS` directly (no external configuration file). Catalog contains 54 server definitions, not 54 verified distributions; only real TypeScript server behavior was exercised during testing. Executables must be installed separately.

- **JS / TS / Web**: `typescript-language-server`, `typescript-native`, `denols`, `biome`, `eslint`, `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server`, `tailwindcss`, `svelte`, `vue-language-server`, `astro`, `emmet-language-server`, `prismals`, `graphql`
- **Systems & Native**: `rust-analyzer`, `clangd`, `zls`, `ols`
- **Go**: `gopls`
- **Python**: `pyright`, `basedpyright`, `pylsp`, `ruff`, `ty`
- **JVM & Enterprise**: `jdtls`, `kotlin-lsp`, `metals`, `omnisharp`
- **Mobile & Apple**: `dartls`, `sourcekit-lsp`, `swiftlint`
- **Scripting**: `bashls`, `lua-language-server`, `solargraph`, `ruby-lsp`, `rubocop`, `intelephense`, `phpactor`, `vimls`
- **Functional**: `elixirls`, `erlangls`, `gleam`, `hls`, `ocamllsp`
- **Cloud & Infra**: `yamlls`, `dockerls`, `terraformls`, `helm-ls`, `nixd`, `nil`
- **Markup & Formal**: `marksman`, `texlab`, `tlaplus`

> **Security Warning**: `installCmd` and `uninstallCmd` execute unsandboxed shell commands under the host process user. Both npm and system package commands remain untested across platforms; external binary installation is recommended.

## Verification

Testing requires a sibling `pi-pocket` checkout with installed dependencies. Run from the parent directory:

```sh
node --test pi-lsp/pi-lsp.test.ts
```

Ten regressions cover Unicode framing/request-ID collisions, startup and RPC failures, lifecycle cleanup, workspace/executable resolution, owner enforcement, lazy file checks, stale/malformed diagnostic rejection, edit-hook suppression, and canceled/expired push/pull waits. A real Pocket/TypeScript smoke exercised write → error `2322` → edit → clean report, prompt injection, custom call rendering, guest denial, the automatic toggle, and failed/invalid calls. Package installers and every catalog distribution remain untested.

## Development and Publication

1. Verify tests pass, then commit and push source to [MasFana/pi-lsp](https://github.com/MasFana/pi-lsp).
2. In `OMP/entries/pi-lsp.json`:
   - Bump the human release version and set `minPocket` for the APIs actually used (editing workflow: `1.2.0`, Pocket `0.28.0`).
   - Set `"source.commit"` to the pushed git commit SHA.
   - Update `files` entries for `pi-lsp.ts` and `pi-lsp.js` with exact byte sizes and SHA-256 hashes.
   - Match all loaded declarations, including `sections: ["lsp_workflow"]`, `hooks: ["afterTool"]`, the four tools/two read-only hints, owner client/access and all eight routes.
3. From `OMP/`, fetch and validate the **published** files, then build the index:
   ```sh
   node scripts/validate.ts --pocket ../pi-pocket --only pi-lsp
   npm run build
   ```
   For a pre-publication working-tree check, use `--local ../pi-lsp --only pi-lsp` with a temporary manifest matching those exact local bytes; this does not prove remote publication.
4. Commit and push OMP's manifest and generated index together. Refresh the gallery and explicitly apply the update. Preserve earlier revocations; never pin new local hashes to an old commit.

## Troubleshooting

- **403 Forbidden:** Check the current loaded revision, owner/session access, and `X-Pocket: 1`. Use module-relative `pocket.api()` rather than a headerless request.
- **Stale Browser UI**: Browser cached previous JavaScript version. Click **Reload** under Menu → Extensions.
- **Unauthorized / Permission Denied**: Start/stop/install/uninstall, definitions and file-synchronizing diagnostics require the current requester to be the Pocket owner; an owner-only browser does not authorize guest tool calls.
- **Server not starting:** Check executable permissions and ancestor `node_modules/.bin`/`PATH`, required runtimes, stderr/startup errors, and LSP protocol support. An available executable is not proof of successful initialization.
- **No automatic report:** Check `autoCheck`, caller role, edit success/cancellation, local workspace containment and recognized extension. Shell/external-editor writes are not watched. For a supported file, request `lsp_diagnostics` explicitly; missing binaries, initialization failures and diagnostic timeouts mean **not verified**, not clean. Without `file`, diagnostics are cached received results only.
