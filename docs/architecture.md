# Architecture

BunjiBox is one local service with three clients. The service owns every
provider run, stores, and permission decisions; clients only observe and send
requests. This page explains how the pieces fit, where the security
boundaries are, and what we know still needs work.

```text
 web app (Vite) ─┐
 phone on LAN ───┤  HTTP, /api/*       ┌─ Codex / Claude CLIs (child processes)
 bunji CLI ──────┼──────────────────▶  apps/server ─▶ @bunji/core ─┼─ OpenRouter / Ollama (HTTPS / HTTP)
 macOS app ──────┘  127.0.0.1:4318     │                             └─ memory MCP server (child process)
                                       └─ workspace: workspace.sqlite + memory/*.md + outputs/
```

## Packages

Dependencies only point down. `shared` depends on nothing, `core` depends on
`shared`, and apps depend on packages.

| Package | Runs in | Owns |
| --- | --- | --- |
| `packages/shared` | browser and Node | Domain model (`types.ts`), provider catalog, bot validation, sync clients (`BotClient`, `ChatClient`), auto-mode routing, error helpers. No Node-only APIs. |
| `packages/core` | Node | Provider execution, stores, the chat service, memory, files, usage meters. |
| `packages/ui` | CSS | Design tokens shared by both web apps. |
| `apps/server` | Node | The local API: HTTP guards, routes, composition root. |
| `apps/cli` | Node | The `bunji` terminal app (Ink). |
| `apps/app`, `apps/site` | browser | Workbench UI and marketing site (Vite + React). |
| `apps/macos` | macOS | Native SwiftUI client of the same API. |

`experiments/` holds research spikes. They stay JavaScript and are not part of
typechecking or CI.

## TypeScript without a build

Node 22.18+ strips TypeScript types natively, so the server, CLI, and packages
run from `.ts` source with no compile step. Package exports point straight at
source (`"./*": "./src/*.ts"`), and child processes such as the memory MCP
server are spawned by `.ts` path. `tsc` only typechecks (`npm run typecheck`).
The Vite apps are bundled by Vite as before.

Node refuses to strip types from files whose real path is inside
`node_modules`. Workspace packages are symlinks into the repo, and `npm link`
installs the `bunji` bin as a symlink too, so both work. A copied install
(`npm install -g` of a packed tarball) would not run. That's fine while the
packages are private, but publishing would need a compile step.

Consequences, enforced by `tsconfig.base.json`:

- Only erasable syntax: no `enum`, `namespace`, or constructor parameter
  properties.
- Relative imports in Node code carry the `.ts` extension; type-only imports
  use `import type`.
- Product code is `strict`. Tests use `tsconfig.test.json`, which keeps API
  checks but drops implicit-any and null checks for fixtures.

Types that cross the HTTP boundary live in `packages/shared/src/types.ts`.
Stores and services export their own interfaces from core (`BotStore`,
`ChatStore`, `ChatService`, `ProviderHooks`, ...).

## The local API

`apps/server/src` is split by responsibility:

- `main.ts` owns the process: service lease, port, signals.
- `app.ts` is the composition root. It opens the stores, wires the chat
  service and provider runner, and orders the routes.
- `http.ts` is the only HTTP toolkit: JSON responses, bounded JSON bodies,
  the Host and Origin guards, error-to-status mapping, and the router.
- `routes/*.ts` hold one route family each. Every route factory takes only
  the slice of a store or service it uses, which keeps tests small.

The API listens on `127.0.0.1` only. LAN devices reach it through the Vite dev
server's `/api` proxy, which preserves the browser's Host header.

## A shared chat message, end to end

1. A client `POST`s `/api/bots/:id/messages` with a client-generated request
   ID. Retries with the same ID are idempotent.
2. The chat service reads the bot's saved settings. Computer scope always
   comes from the saved bot, never from the request body.
3. Auto mode (`shared/auto-mode.ts`) routes obvious tool work to Agent.
   Otherwise it tries Chat and lets the model ask for an Agent handoff.
4. `core/context.ts` builds the prompt from recent completed turns within a
   12,000-character cap.
5. `core/runtime.ts` turns the request into a provider command. Codex and
   Claude run as child processes, OpenRouter and Ollama over HTTP. Agent runs
   also get the per-bot memory MCP server.
6. `run-events.ts` turns provider JSON events into display-safe activities,
   redacting secrets. The chat store saves them as they arrive.
7. Clients poll history (every 1.2 s in the web app) and render the saved
   request. Closing a client never cancels a run; only Stop does.

## Storage

Everything lives in the workspace directory (`BUNJI_DATA_DIR`, default
`~/.config/bunji`):

- `workspace.sqlite` (WAL): `bots`, `chat_requests`, `chat_revisions`,
  `agent_files`, `codex_sessions`. Each store opens its own connection through
  `core/sqlite.ts`, which sets the 0600 mode, the busy timeout, WAL, and the
  transaction helper. Revisions let clients skip unchanged reads.
- `memory/<bot-id>/*.md`: Markdown notes with frontmatter. The files are the
  source of truth, and writes replace a note atomically.
- `.service-lease.sqlite`: an exclusive SQLite lock held for the service's
  lifetime, so only one service runs per workspace.
- `outputs/<bot-id>/<request-id>/`: default place for agent deliverables.

## Security boundaries

There is no account authentication in this alpha. Anyone on the network who
can reach the web app can use every bot. Within that model, these guards
hold:

- **Host allowlist.** The API only answers requests addressed to an IP
  literal, `localhost`, or `*.localhost` (Vite's default), plus
  `BUNJI_ALLOWED_HOSTS`. This stops DNS rebinding, where a web page's
  hostname re-resolves to 127.0.0.1 so its Origin matches the Host.
- **Same-origin writes.** Every state-changing request needs an Origin that
  matches the Host, or no Origin at all (CLI, native app). Opaque or
  malformed Origins are refused.
- **JSON only.** Bodies must be `application/json`. Browsers cannot send that
  cross-site without a CORS preflight, and the API never approves one.
- **Server-side permissions.** A run's computer scope comes from the saved,
  server-validated bot profile. Folder paths are checked against the real
  filesystem (`core/agent-permissions.ts`). Full-machine access has its own
  confirmation route.
- **Display redaction.** Only chosen fields of provider events are stored, and
  tokens and keys are redacted.
- **File handles.** The file browser serves registered file IDs only, never
  paths from a request, with a sandboxing CSP.

## Audit, September 2026

This section records the architecture review that came with the TypeScript
migration.

### What was already solid

- Clean downward layering and a single provider runtime shared by every
  client.
- The service owns runs; clients are observers with idempotent writes.
- Careful SQLite use: short transactions, revisions, and a lease that survives
  crashes without PID files.
- Permissions are derived from saved state, never from request bodies.
- Broad test coverage, including real HTTP servers, a Vite proxy, spawned
  services, and a headless terminal.

### Fixed in this pass

- **`POST /api/run` accepted cross-site requests.** It had no Origin or
  content-type check, so any web page could start provider runs with a
  `text/plain` form post. It now has the same guards as every other write.
- **DNS rebinding bypassed the Origin check.** A rebound hostname has a
  matching Origin and Host, which exposed every route, including full-machine
  access. Fixed with the Host allowlist.
- **Five copies of the HTTP plumbing** (JSON send, body reading, origin
  checks) behaved slightly differently: a malformed Origin gave 400 on one
  route and 500 on another. Now there is one toolkit and one router. A route
  bug answers 500 instead of crashing the process through an unhandled
  rejection.
- **`shared` imported `node:fs`.** The permission validator moved to core, so
  shared is browser-safe again.
- **Four stores repeated the SQLite setup and transaction code**, and eight
  modules each defined their own `fail()` helper. Both are consolidated.
- **`runtime` did everything.** The Ollama client and computer policy now have
  their own modules.
- **The 35 KB `App.jsx`** is split along its existing component boundaries.
- **The server was a top-level script.** It is now a composition root with a
  thin entry point.
- **The CLI loaded SQLite just to start.** Every `bunji` command printed
  Node's SQLite experimental warning because the provider runtime pulled in
  the Codex session store. Workspace paths now live in `core/workspace.ts` and
  the experimental runner in `core/provider-runner.ts`, so the CLI no longer
  loads the database driver. The CLI also takes the provider catalog from
  `shared` rather than core's re-exports.
- **Dead code and small bugs.** Removed the unused CLI config module and Vite
  template assets. Fixed a Computer access crash when choosing a folder, and
  a memory test that flaked on inode reuse.

### Recommended next steps

In priority order:

1. **Device authentication.** The biggest remaining risk is by design: any
   device on the Wi-Fi can enable full Mac access. A pairing token issued on
   the host and required for non-loopback clients would close it.
2. **Server push instead of polling.** Every client polls history every
   1.2 s and bots every 2 s. Server-sent events on the existing revisions
   would cut phone battery use and latency.
3. **One database connection with versioned migrations.** Stores still open
   separate connections, and migrations sniff columns. Also, `bot-store`
   deletes rows in the chat tables directly: it is atomic, but the coupling is
   hidden.
4. **Decide the fate of `POST /api/run`.** No client in this repo uses it.
   Remove it or document it as the scripting API.
5. **Stop product code depending on `experiments/`.** `core/native-computer.ts`
   spawns `experiments/computer-use-native-bridge/server.mjs` and a helper
   built under `experiments/`. Promote them into a package or keep the
   feature experimental.
6. **Generate the Swift models.** `apps/macos/.../Models.swift` duplicates
   `shared/types.ts` by hand. A JSON Schema generated from the TypeScript
   types would stop the two drifting apart.
7. **Split the terminal app.** `apps/cli/src/app.ts` is one large Ink
   component; splitting it needs hooks extracted first.
8. **Code-split the workbench.** The main chunk is 538 kB. Lazy-load the
   Usage page, the memory panel, and Markdown rendering.
9. **Latent bugs the types exposed.** All are low impact today:
   - `activityLimited` is never saved, so the "activity limited" note never
     shows for saved history.
   - `chat-store` drops `usageBreakdown.calls` and would reject
     `payloadMode: 'mixed'` from `combineUsageBreakdowns`. That path can't be
     reached yet.
   - `runProvider` assumes `memory` when a Codex session is set.
   - The Codex app server compares the network setting to `'on'`, which is
     not a valid value, so that branch is dead.
