# Pi LSP

Language Server Protocol (LSP) integration for [Pi Pocket](https://github.com/TannerMidd/pi-pocket) with an owner management dashboard and agent tools (`lsp_status`, `lsp_diagnostics`, `lsp_definition`, `lsp_manage`). Published via the [OMP Registry](https://github.com/MasFana/OMP); source at [MasFana/pi-lsp](https://github.com/MasFana/pi-lsp).

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
- **File Sync & Diagnostics**: URIs are encoded via `pathToFileURL` (handles Unicode, spaces, and `#`). `syncFileToClient` compares content against an in-memory version cache: sends `textDocument/didOpen` on first load, `textDocument/didChange` (full sync) on edits, and avoids re-sending unchanged files to prevent resetting server diagnostic debounce timers. Diagnostics arrive asynchronously via `textDocument/publishDiagnostics` into an in-memory client cache.

## Agent Tools

| Tool | Parameters | Annotations | Behavior |
| :--- | :--- | :--- | :--- |
| `lsp_status` | None (`{}`) | `readOnlyHint: true` | Returns `{ active: [...], detected: [...], cwd }` for session workspace. |
| `lsp_diagnostics` | `file?: string` | `readOnlyHint: true` | Returns cached diagnostics `{ [uri]: Diagnostic[] }`. Providing `file` syncs document first. Does not perform full-tree disk walks or start servers. |
| `lsp_definition` | `server: string`, `file: string`, `line: number`, `character: number` | None | File is absolute or relative to session CWD; positions are 0-based UTF-16 offsets. Starts an inactive server, synchronizes the file, and returns LSP location results. |
| `lsp_manage` | `server: string`, `action: "start" \| "stop" \| "install" \| "uninstall"` | None | Controls server lifecycle. `install` and `uninstall` strictly require owner privileges (`host.roleOf(requester) === "owner"`). |

## Web Endpoints & Dashboard

Paths below are relative to `/api/x/pi-lsp/`. Routes require the owner and `X-Pocket: 1` on every method, including GET; `pocket.api()` supplies the header. Raw `fetch()` without it receives 403. `web.onDispose` stops active clients.

- `GET servers?cwd=PATH` / `GET c/:conversation/servers`: Returns `{ servers, cwd }`; rows cover the entire catalog with availability, project-match, and workspace-running flags. Global CWD defaults to the Pocket server's directory; conversation CWD is authoritative.
- `POST c/:conversation/start` / `POST c/:conversation/stop`: Starts/stops server for conversation CWD (`{ serverId }`).
- `POST start` / `POST stop`: Starts/stops server for explicit CWD (`{ serverId, cwd }`).
- `POST install` / `POST uninstall`: Executes catalog package command (`{ serverId }`).

### Browser Dashboard UI
- **Panels & Launchers**: Slide-in sheet (`pocket.sheet`), menu item (`pocket.menu`), and Cmd/Ctrl+K launcher entry (`pocket.launcher`).
- **Filters**: `Detected` (matched markers/extensions), `Running` (active in current workspace), `All` (entire catalog).
- **Status Badge**: Registers header badge (`${count} LSP active`, short `${count} LSP`) via `pocket.status`. Updates on conversation change, polls every 15s, and clears on 0 active servers or read failure.
- **Resilience**: `AbortController` cancels inflight requests on sheet navigation or conversation switch. Errors display inline with a Retry action. `pocket.onDispose` clears intervals, cancels active requests, and unregisters status badges.

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

The five regressions cover fragmented Unicode framing, server/client request-ID collisions, RPC rejection, graceful shutdown, startup failures/concurrent starts/pending-init disposal, broken stdio, session CWD/executable-file lookup, and non-owner package-management rejection. Package installers and every catalog distribution are not exercised.

## Development and Publication

1. Verify tests pass, then commit and push source to [MasFana/pi-lsp](https://github.com/MasFana/pi-lsp).
2. In `OMP/entries/pi-lsp.json`:
   - Bump the human release version and set `minPocket` for the APIs actually used (this correction: `1.1.3`, Pocket `0.28.0`).
   - Set `"source.commit"` to the pushed git commit SHA.
   - Update `files` entries for `pi-lsp.ts` and `pi-lsp.js` with exact byte sizes and SHA-256 hashes.
   - Ensure `"declares.routes"` includes `"POST c/:conversation/start"` and `"POST c/:conversation/stop"`.
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
- **Unauthorized / Permission Denied**: Installing/uninstalling language servers or invoking web routes requires the owner role.
- **Server not starting:** Check executable permissions and ancestor `node_modules/.bin`/`PATH`, required runtimes, stderr/startup errors, and LSP protocol support. An available executable is not proof of successful initialization.
- **Empty diagnostics:** Start the desired server with `lsp_manage`, then supply `file` to `lsp_diagnostics`. Results are asynchronous; an immediate call can precede publication. Without `file`, only the received cache is returned.
