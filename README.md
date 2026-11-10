# Pi Fana Tooling (`pi-lsp`)

Semantic LSP, structural AST and indexed CodeGraph tools for [Pi Pocket](https://github.com/TannerMidd/pi-pocket), with one verified proposal/apply engine and one owner Tooling panel. The installed module remains `pi-lsp`: existing tools, settings and eight legacy routes stay supported; the catalog now covers all 55 OMP registry server IDs. Published via [OMP](https://github.com/MasFana/OMP); source at [MasFana/pi-lsp](https://github.com/MasFana/pi-lsp). No model selector, native read/search wrappers, extra LSP lifecycle, global output hook or MCP registration. Owner-authorized handoff runs without extension confirmation dialogs.

Requires Pi Pocket `>= 0.28.0` (`pocketApi = 2`), Node `>= 22.19.0` (native TypeScript execution), and `Type` imported directly from `typebox`.

### Release 1.3.2

Automatically detects providers on owner workspace views and five-minute freshness cycles. A native source watcher and successful native/proposal edits debounce-sync **existing** CodeGraph indexes; graph queries await incremental sync, including missed external events. No automatic package installation, missing-index creation or Git hooks. Matches OMP 18.16.0's 55 server IDs, fills missing file types/root markers/settings, and fixes launch arguments. Go discovery includes toolchain bin directories and cached `go env` paths. Every installer entry point verifies the resulting executable; exit zero alone is not success. Operation outcomes show the selected path, version when checked, installer exit/errors and index counts instead of dumping the entire registry.

### Release 1.3.1

Removes all extension review/consent gates, permission dialogs and confirmation tokens. `fana_apply` executes task-authorized proposals and commands directly; the agent inspects previews itself. `lsp_manage` also manages `ast-grep` and `codegraph`, including index create/sync/rebuild, so handoff does not stop at a manual panel. Owner checks, stale-file guards, automatic diagnostics and uncertain-command recovery remain. Native Pocket Plan/approval policies are unchanged.

### Release 1.3.0

Adds semantic query/previews, one AST provider, read-only CodeGraph queries and explicit index operations, durable proposal/application receipts, and a single cached owner panel. Existing tools/routes/server definitions remain supported. No native tool/model/output replacements or automatic package/index actions.

> **Runtime:** This is a Pocket drop-in, not a standalone npm package or executable. Pocket supplies runtime dependencies and the type-only `./_pocket.d.ts` link in its prepared `extensions/` folder. A local `node_modules` development symlink is optional and is not shipped. Bare `node pi-lsp.ts` is not the supported execution path; use Pocket's loader or the regression suite with a sibling Pocket checkout.

## Installation & Updates

### Extension Gallery (OMP)
1. In Pi Pocket, open **Menu → Extensions → Discover**.
2. In the bottom index input, enter `MasFana/OMP` (or raw `index.json` URL) and confirm.
3. Locate **Pi Fana Tooling (`pi-lsp`)** and click Install. Extensions install disabled; toggle the switch to enable.
4. Updates never apply automatically: review diffs and apply updates in the **Updates** tab.

### Manual Drop-in & Reload
Copy `pi-lsp.ts`, `pi-lsp.js` and the entire `pi-lsp/v1.3.2/` helper directory into Pocket's `extensions/`. Do not copy dependencies, tests or linked `_pocket.d.ts`. Enable `pi-lsp.ts` in **Menu → Extensions**. Reload after replacing the bundle. Gallery releases change helper-directory versions to invalidate native import caches; editing an existing helper version manually requires a server restart.

## Architecture & Lifecycle

- **Workspace authority:** CWD comes from Durable execution context and is canonicalized. Remote workspaces are rejected. New provider queries and proposals enforce local containment, including symlink targets; graph queries never borrow an index from an unauthorized parent/worktree.
- **Executable Lookup:** CWD-relative paths, ancestor Node/Python/Ruby/Go bins, system `PATH`/Windows `PATHEXT`, then user toolchain directories. Go checks `GOBIN`, the first `GOPATH/bin`, default `~/go/bin`, and cached `go env` configuration discovered during owner refresh. PATH-selected and workspace-local executables retain precedence. Projects detect via upward `rootMarkers` or source extensions.
- **Stdio RPC:** JSON-RPC 2.0 uses UTF-8 byte-length framing and isolated client/server request IDs. Unsupported requests receive `-32601`; `workspace/applyEdit` is accepted during an owner-authorized command and passes through the proposal engine. Initialization advertises UTF-16 positions, text edits and no resource operations.
- **One lifecycle:** One LSP process per canonical `${server}:${workspaceRoot}`; concurrent starts share initialization. Requests time out after 10 seconds. Stop sends `shutdown`/`exit`, then escalates termination within about 2.5 seconds. LSP, CLI workers and legacy installers share a single disposal window; provider workers stop in parallel, not in a second sequential lifecycle.
- **File Sync & Diagnostics**: Encoded file URIs handle Unicode, spaces and `#`. First sync sends `didOpen`; changed text sends versioned `didChange`, invalidates the old cache, and avoids re-sending unchanged text. File checks wait up to 5 seconds for a valid current report: push diagnostics or advertised pull diagnostics. Older versioned reports are discarded; malformed/unchanged pull reports and timeouts are errors, never an empty “clean” result. Unversioned push reports cannot prove an exact document version.

## Automatic Editing Workflow

- `lsp_workflow` owns diagnostic guidance; `fana_routing` adds only available/callable cross-provider guidance. LSP for meaning, AST for syntax and CodeGraph for indexed relationships. Native file tools, text search, model selection, delegation and codemode remain Pocket's responsibility. Diagnostics do not replace tests or runtime verification.
- A `ToolTask.afterTool` hook checks successful **Pi `edit`/`write` calls**, including codemode calls. It appends actual diagnostics or an explicit not-verified report to the edit result without discarding the original output, diff/details, or control fields.
- LSP checks run only for the current Pocket owner, recognized source extensions and real paths within the local workspace. Failed/blocked/aborted edits, guest edits, remote/outside paths and `.env*` files do not trigger checks. External-editor or shell writes still need an explicit LSP file check; CodeGraph's source watcher does not start language servers.
- If no matching server is active, start **one** installed executable matching the file extension, preferring a compiler over a linter; catalog order breaks ties. Existing matching active servers contribute combined diagnostics. No directory-wide startup, recursive source scan, or automatic package installation occurs.
- **Owner setting:** Menu → Extensions → Pi LSP → `Automatic post-edit diagnostics` (`autoCheck`, default `true`). Turning it off suppresses new post-edit checks; it does not stop running servers or disable explicit file diagnostics/definitions. Core persists this boolean; the extension does not directly read authentication/configuration files.
- An executable permission check is not a trust check. Auto-start can execute workspace `node_modules/.bin` code; language servers inherit the host environment (possibly credentials), receive synchronized file contents, and may independently read files or use the network. Enable automatic checks only for trusted workspaces/binaries.
- `fana_apply` verifies actual changed files once after a batch, with at most four concurrent file checks. Disabling `autoCheck` suppresses automatic checks but not explicit diagnostics. Native edit/write results and diff/details/control fields are preserved.
- Successful native edits and `fana_apply` batches mark graph data dirty and debounce incremental sync by 300 ms, independently of `autoCheck`. Existing indexed owner workspaces get one native recursive watcher, bounded to eight workspaces; `.git`, `.codegraph`, dependencies/build caches and `.env*` events are ignored. External additions, edits and removals trigger the same single-flight sync. Edits during sync cause a follow-up; failures stay visible without a continuous retry loop. Queries await freshness and cover missed events. Missing indexes are never created automatically; no Git hooks or daemon are installed. All watchers/timers/workers are disposed with the extension.

## Agent Tools

| Tool | Parameters | Annotations | Behavior |
| :--- | :--- | :--- | :--- |
| `lsp_status` | None (`{}`) | `readOnlyHint: true` | Returns `{ active: [...], detected: [...], cwd }` for session workspace. |
| `lsp_diagnostics` | `file?: string` | `readOnlyHint: true` | With `file`: owner-only, lazily starts an eligible server, syncs and awaits current diagnostics `{ [uri]: Diagnostic[] }`. Without `file`: received, non-stale workspace cache only; no full-tree scan or startup. Incomplete checks fail rather than claiming clean. |
| `lsp_definition` | `server?: string`, `file`, `line`, `character` | None | Owner-only; auto-selects an installed server when omitted. Local contained source file and 0-based UTF-16 positions; existing location result shape is preserved. |
| `lsp_manage` | `server: string`, `action: "start" \| "stop" \| "install" \| "uninstall" \| "refresh" \| "create" \| "sync" \| "rebuild"` | None | Owner-only. Index actions apply to CodeGraph. Installers verify discovery and return concise observed outcomes; unsupported operations and failed/partial results are errors. |
| `lsp_query` | `action`, optional file/server/position/query/kinds/formatting options, `maxResults`, code-action `offset` | `readOnlyHint: true`, safe replay | Owner-only semantic queries and immutable rename/format/code-action previews. No source writes. |
| `fana_ast` | `action`, explicit `paths`, optional lang/pattern/rule/ops and limits | `readOnlyHint: true`, safe replay | Automatically detected status, structural search/outline or sequential rewrite preview. Every subprocess invocation requires owner authority. |
| `fana_graph` | `action`, query/symbol/file, bounded depth/results and generation | Safe replay; no read-only hint | Existing-index status/queries with automatic incremental sync. Never creates a missing index or writes project sources. The read-only hint is removed because synchronization writes index metadata; native Pocket policy remains authoritative. |
| `fana_apply` | `proposalId` | Unsafe replay | Immediately applies the authorized saved proposal, including commands. No separate human review/consent gate. Stale-file checks and per-file mutation/verification outcomes remain. |

`readOnlyHint` classifies filesystem effects for Plan mode; it is not authorization or an OS sandbox. Status and cached no-file diagnostics remain inspectable by permitted session participants; starting/stopping or synchronizing file data does not.

## Semantic, Structural and Graph Providers

`lsp_query` actions: `references`, `hover`, `document_symbols`, `workspace_symbols`, `implementation`, `code_actions`, `rename_preview`, `format_preview`. File queries lazily activate one installed server and validate capabilities. Fileless workspace-symbol queries select an eligible active server or require an explicit server. Locations, hierarchical symbols, hover variants, optional prepare-rename and code-action resolution are handled. Code actions return proposal IDs; pages contain at most ten actions, with `offset`/`nextOffset` for subsequent pages. References are useful impact evidence, not a mandatory receipt or a guarantee of every textual occurrence. Formatting is not claimed to be whitespace-only.

`fana_ast` requires stable ast-grep `>=0.44.0` with verified CLI features. `sg` is accepted only if it identifies as ast-grep; on many systems it is an unrelated Unix utility. Search accepts a pattern or native inline YAML rules, including a relational `rule:` body. Standard bundled grammars only: project configuration and native parser libraries are disabled. Explicit paths may include bounded directories; `.env*`, `.git`, outside symlinks and excessive scopes are rejected. Rewrite `ops: [{pat,out}]` run sequentially on private snapshots; empty `out` deletes a match. Project sources remain unchanged until `fana_apply`. Defaults: 32 files, 50 results, 200 replacements; hard limits 64 files, 200 results, 5,000 replacements, 1 MiB per AST source and 4 MiB total snapshots.

`fana_graph` uses the installed **CodeGraph 1.6.2 SDK** in short-lived read-only workers. Its Node runtime must support SQLite and be `>=22.5 <25`; Pocket's broader Node floor is not sufficient. Verified standalone installations use their bundled runtime; compatible npm installations can use a verified Node executable. No machine-specific home path is shipped. Actions: `explore`, `callers`, `callees`, `impact`, `affected_tests`. Test candidates are not passing tests. Defaults: depth 2 and 30 results; maxima 5 and 150. Use returned symbol IDs with their index generation; ambiguous names are not silently selected. Logical generations survive read-only opens/WAL checkpoints and change when the index changes.

Graph status separates installation, index existence/build state, engine compatibility and source freshness. Incremental sync is automatic for existing indexes; creation/rebuild remain explicit owner operations. Query workers open read-only only after freshness work finishes. SDK initialization avoids CLI installer Git-hook/watch offers; no daemon, MCP registration or global configuration edits occur. Indexed static relationships can be incomplete and never authorize source writes.

## Verified Proposals and Application

- Previews return an ID bound to requester, conversation, canonical workspace, provider/server, original hashes/versions, exact edits and limits. Apply does not regenerate patterns or rename requests.
- UTF-8 AST offsets and UTF-16 LSP positions are normalized, including Unicode and CRLF. Overlap, ambiguous edits, stale bytes, changed paths, `.env*` and outside destinations fail before writes.
- Files are replaced atomically where feasible, preserving modes. Cross-file transactional rollback is not claimed. Durable intent/receipts permit reconciliation of interrupted or partially applied proposals; a task memo is not a filesystem transaction.
- Resource operations and change annotations are explicitly unsupported, never silently dropped. The server is not advertised support for them.
- Code-action edits retain their exact server contract. Edit-plus-command actions apply the edit first; server follow-up edits use the same engine. Commands run under the owner task's authorization, without a permission popup. Unreported effects are not claimed verified; uncertain outcomes are not blindly repeated, and completed commands are not rerun.
- Storage uses versioned `x.pi-lsp.*` documents, with one-hour proposal expiry, a 20-record/16-MiB bound and retirement of older completed proposals when capacity is needed. Per-file applied outcomes remain truthful even if receipt persistence fails after writing.
- New tools preserve full bounded structured results for Durable nested callers. Model-facing JSON is fenced as untrusted data and has a 32-KiB display budget; larger displays return explicit truncation/count/proposal metadata rather than broken JSON. Immutable edit bytes are not clipped.

### Native codemode

Pocket's native `tools.<name>()` returns **text**, not Durable's `executeTool(...).structuredOutput`. Do not replace native tools to change that contract. Small new-tool results can be decoded inside an existing codemode script:

```js
const unpack = text => JSON.parse(text.match(/<tooling_data>\n([\s\S]*)\n<\/tooling_data>/)[1]);
const result = unpack(await tools.fana_graph({action: "explore", query: "request handler", maxResults: 10}));
if (result.truncated) return "Narrow the query before using omitted details";
return result.items;
```

Direct Durable nested calls use `api.executeTool(name, args, context)` and inspect `structuredOutput`, `isError` and diagnostics. Native Bash exit codes and edit UI details are not overwritten by this extension.

## Web Endpoints & Dashboard

Paths are relative to `/api/x/pi-lsp/`. Every method requires owner access and `X-Pocket: 1`; `pocket.api()` supplies it. Headerless requests receive 403. Existing eight routes remain supported; all installers now use the owned process executor and disposal budget.

- `GET servers?cwd=PATH` / `GET c/:conversation/servers`: Returns `{ servers, cwd }`; rows cover the entire catalog with availability, project-match, and workspace-running flags. Global CWD defaults to the Pocket server's directory; conversation CWD is authoritative.
- `POST c/:conversation/start` / `POST c/:conversation/stop`: Starts/stops server for conversation CWD (`{ serverId }`).
- `POST start` / `POST stop`: Starts/stops server for explicit CWD (`{ serverId, cwd }`).
- `POST install` / `POST uninstall`: Executes the catalog command (`{ serverId }`) and verifies executable discovery/removal. Returns `ok: false` on failed verification even if the command exited zero.
- `GET tooling/status` / `GET c/:conversation/tooling/status`: Immediate combined cached status and pending proposals; owner requests schedule initial/TTL detection and existing-index sync in the background. No automatic installs, server starts or missing-index creation.
- `POST tooling/execute` / `POST c/:conversation/tooling/execute`: Direct owner operation `{provider, action, serverId?, proposalId?}`. No token/confirmation round trip. Obsolete prepare routes are removed. Navigation/disconnection can cancel operations; partial/failed indexing stays explicit.

New provider installation is offered after detection finds it missing and a compatible package runtime exists. AST/CodeGraph uninstall requires a selected executable verified beneath the current `npm root -g`; system/standalone/workspace-local installations are not removed by guessing. Global provenance is rechecked before uninstall. Package effects are serialized against owned index builds. Go uninstall targets its configured installation bin, not `which gopls`. Installer commands and all 55 catalog distributions remain unverified across platforms.

### Browser Dashboard UI
- One owner sheet with **Overview / LSP / AST / CodeGraph** tabs, native menu and launcher registrations.
- LSP retains Detected / Running / All filters; unknown detection displays **Not checked**, not falsely missing.
- One combined badge refreshes on conversation changes and `lsp-changed`. Fifteen-second panel polling reads immediate snapshots; only the initial/five-minute cycle schedules provider detection. Refresh remains available without a permission dialog. Operation results display useful path/version/exit/error/count fields.
- Panel operations run immediately under the owner role. Requests are cancelled on navigation/workspace changes; all handles, listeners and timers are disposed. The agent can use `lsp_manage` for the same provider operations without opening the panel.

### Tool-call presentations
The owner browser registers `pocket.toolCall` for all eight tools, with bounded subjects, code icons, readable action labels and group summaries. Malformed historical arguments degrade safely. Displayed positions are human 1-based; LSP inputs stay 0-based UTF-16. These are call presentations, not a second editor, model selector or arbitrary result renderer.

## Server Catalog (55 Server Definitions)

Configured in `LSP_SERVERS` inside `pi-lsp.ts`. The catalog covers all IDs in `@oh-my-pi/pi-coding-agent@18.16.0/src/lsp/defaults.json`, while preserving existing installers and additional detection markers. This is catalog coverage, not parity with OMP's native single-tool API or 55 verified installations. Expert is discoverable; no unsupported installer is invented. Runtime checks exercised TypeScript and the installed `gopls` version, not every server/platform.

- **JS / TS / Web**: `typescript-language-server`, `typescript-native`, `denols`, `biome`, `eslint`, `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server`, `tailwindcss`, `svelte`, `vue-language-server`, `astro`, `emmet-language-server`, `prismals`, `graphql`
- **Systems & Native**: `rust-analyzer`, `clangd`, `zls`, `ols`
- **Go**: `gopls`
- **Python**: `pyright`, `basedpyright`, `pylsp`, `ruff`, `ty`
- **JVM & Enterprise**: `jdtls`, `kotlin-lsp`, `metals`, `omnisharp`
- **Mobile & Apple**: `dartls`, `sourcekit-lsp`, `swiftlint`
- **Scripting**: `bashls`, `lua-language-server`, `solargraph`, `ruby-lsp`, `rubocop`, `intelephense`, `phpactor`, `vimls`
- **Functional**: `elixirls`, `expert`, `erlangls`, `gleam`, `hls`, `ocamllsp`
- **Cloud & Infra**: `yamlls`, `dockerls`, `terraformls`, `helm-ls`, `nixd`, `nil`
- **Markup & Formal**: `marksman`, `texlab`, `tlaplus`

> **Security Warning**: `installCmd` and `uninstallCmd` execute unsandboxed shell commands under the host process user. Both npm and system package commands remain untested across platforms; external binary installation is recommended.

## Verification

Testing requires a sibling `pi-pocket` checkout with installed dependencies. Run from the parent directory:

```sh
rtk node --test pi-lsp/pi-lsp.test.ts pi-lsp/proposals.test.ts pi-lsp/ast.test.ts pi-lsp/graph.test.ts pi-lsp/tooling.test.ts pi-lsp/automatic.test.ts
```

The 36 behavioral regressions cover protocol/lifecycle compatibility, owner boundaries, Unicode/CRLF, stale/overlapping proposals, interrupted recovery, receipt failures, honest installer outcomes, debounce/abort/conflict/disposal transitions, real AST/CodeGraph operations and external source-watch synchronization. Actual Pocket smoke also proved native write → fresh graph query and detected `gopls v0.24.0` without reinstalling it. Guests remain denied. Real-provider tests require installed compatible CLIs; no test installs packages. Only Linux was exercised.


## Development and Publication

1. Verify tests pass, then commit and push source to [MasFana/pi-lsp](https://github.com/MasFana/pi-lsp).
2. In `OMP/entries/pi-lsp.json`:
   - Set the release version and minimum for APIs actually used (this release: `1.3.2`, Pocket `0.28.0`, API 2).
   - Pin the pushed full source commit; never pin working-tree bytes to the older release.
   - Hash/size both root files and all ten `pi-lsp/v1.3.2/` helper/worker files; the directory version is the native-cache-safe upgrade boundary.
   - Match eight tools/four read-only hints, two prompt sections, `afterTool`, owner client/access, eight legacy routes and four Tooling routes.
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
- **Provider installed but unavailable:** Check compatibility separately from installation. CodeGraph currently requires verified 1.6.2 and a compatible provider runtime; ast-grep requires verified stable CLI features. Missing indexes are not created by queries.
- **Stale/ambiguous graph:** The agent can refresh/sync/rebuild through `lsp_manage` with server `codegraph`, without human consent. Queries themselves remain read-only. Select symbol IDs with their generation; use the native session CWD to authorize the repository containing the index.
- **Proposal rejected:** Regenerate after changed bytes/versions/paths. Pending proposal capacity, expiry or a previously uncertain command outcome is explicit; do not blindly repeat commands.
