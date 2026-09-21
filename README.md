# BunjiBox

BunjiBox is a local agent workbench for Claude, Codex, and a temporary Ollama endpoint. It uses the subscription-backed CLIs already signed in on the Mac, while Ollama can run on another trusted LAN device such as a Raspberry Pi.

## Repo layout

npm workspaces, one lockfile, no build graph tool. Every package is private.

```
apps/app       @bunji/app      workbench UI (Vite + React)
apps/site      @bunji/site     marketing site, same stack as the app
apps/server    @bunji/server   local-only HTTP bridge on 127.0.0.1:4318
apps/cli       @bunji/cli      the `bunji` terminal app
packages/core  @bunji/core     Node-only runtime and stores
packages/shared @bunji/shared  browser- and Node-safe bot shapes, clients, token math
packages/ui    @bunji/ui       design tokens shared by the app and the site
```

Dependencies only ever point downward: apps depend on packages, `core` depends
on `shared`, and `shared` depends on nothing. The root package owns the `bunji`
bin so `npm link` keeps working.

## Run it

### Terminal app

Requires Node.js 22.13 or newer and locally installed `codex` / `claude` CLIs.

```bash
npm install
npm link
bunji
```

Or run `npm run bunji` directly from this folder. The terminal app runs on its
own; it starts the shared Bunji API when needed and does not need Vite. It uses a full-screen buffer,
resizes with the terminal, and restores the shell when you exit.

`bunji --demo` previews the interface offline with clearly labeled sample
activity. `bunji --help` lists options, including `--provider`, `--model`,
`--effort`, `--cwd`, and `-p "prompt"` for scripts (`--json` streams events).

| Key | Action |
| --- | --- |
| Enter / Ctrl+J | Send / insert newline |
| Tab / Escape | Change pane / return to composer |
| Ctrl+K | Search commands |
| Ctrl+B / Ctrl+N | Switch / create bot |
| Ctrl+G / Ctrl+E | Model picker / effort slider |
| Ctrl+T / Ctrl+L | Expand tool activity / token log |
| Ctrl+U / Ctrl+O | Subscription usage / bot details |
| Ctrl+P | Markdown preview |
| PgUp / PgDn | Scroll chat or focused panel |
| Ctrl+X / Ctrl+C | Stop request / exit |

Use `/name`, `/description`, `/color`, and `/shape` to customize a bot. Bots and
avatars are shared with every browser connected to the same Mac, in
`~/.config/bunji/workspace.sqlite` (or `$XDG_CONFIG_HOME/bunji/workspace.sqlite`).
`BUNJI_DATA_DIR` overrides this directory; the web backend and CLI must use the
same value. Changes sync roughly every two seconds, without replacing other
devices' unrelated edits. Terminal avatars use a glyph/color fallback for images.

The old CLI config is imported once and retained. Old browser bots/avatars import
when that browser next connects; conflicting copies are kept as recovered bots.
Refresh old browser tabs and restart old CLI processes to load the new sync code.
The shared workspace is on this Mac, not in a cloud account; the Mac must be
reachable for a phone to connect. Other Macs do not automatically share this file.

New chat messages, tool activity, and token counts are **saved and shared** across
the web app and interactive CLI. Closing a client does not stop a running request.
Use Stop or Ctrl+X to cancel. The same bot keeps its history when you switch models.
Finished user messages and replies can be edited in the web app. Edits sync to
other devices and shape future context; earlier replies do not regenerate, and
their token counts remain those of the original provider run.
Recent completed exchanges are included within a 12,000-character application
prompt cap; the log reports omitted exchanges. Older messages stay on disk.
`bunji -p` is still a stateless one-shot command. Old in-memory-only chats are not
retroactively recovered. The shared service owns the working directory;
`--cwd` cannot silently change an already running service.

Provider runs have no wall-clock timeout. A long research or tool run can keep
going until it finishes or you stop it. Deployments that want an idle watchdog
can set `BUNJI_PROVIDER_STALL_TIMEOUT_MS`; provider output and diagnostics reset
that timer.

### Web app

```bash
npm run api
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173/` or the Mac's WiFi address on a phone.

The Vite server proxies `/api` to the local-only bridge on `127.0.0.1:4318`.

### Marketing site

```bash
npm run dev:site
```

Opens on `http://localhost:5174/`, so it can run alongside the workbench. It is
the same stack as the app — Vite, React, Tailwind v4, shadcn, lucide — and pulls
its colours from `@bunji/ui`, so the two cannot drift apart. `npm run build:site`
emits a static bundle to `apps/site/dist`.

Its test SSR-renders the page and cross-checks concrete claims (paths, model
names, env vars) against this README, so editing one without the other fails.

### Agent files and right sidebar

The right sidebar opens to **Files**, with compact tabs for **Memory**, **Activity**
(tool calls and tokens), and **Settings**. Computer access is in Settings;
appearance controls expand when needed. On phones, the folder icon opens the
same sidebar as a drawer.

Files use a large-icon grid or compact list, with search, type filters, and sorting.
Click a file for an image, Markdown, or text preview; download it to the device
you are using. Other formats can be downloaded and opened in their own apps.
Previews read up to 128 KB; downloads return the entire original file.

For shared web/interactive-CLI runs with computer writes enabled, Bunji indexes
successful Codex file changes and Claude Write/Edit calls. New standalone
deliverables default to `outputs/<bot-id>/<request-id>/` in the Bunji data
directory, or `.bunji/outputs/<bot-id>/<request-id>/` inside a selected folder.
These output folders are checked while the agent works and when it finishes.
Agents also get a `files_publish` tool to register files generated elsewhere,
including shell output. Shell-created files outside the output folder need that
tool call to appear; Bunji does not scan the whole machine.

The index persists in the shared workspace and syncs to connected devices.
Older completed file-write events with absolute paths are recovered when the
service starts; old relative paths or truncated logs cannot be recovered reliably.
The browser only serves registered file IDs. HTML and SVG are text previews,
not executable pages. Files moved or removed outside Bunji are marked unavailable.
Deleting an agent does not delete its created files from disk.

## Runtime controls

- Claude: Opus, Sonnet, or Haiku; low through max effort.
- Codex: GPT-6 Astra, GPT-5.6 Sol, Terra, Luna, or GPT-5.5; model-specific effort options.
- Ollama · Pi: Gemma3 1B; the temporary connector runs it in chat mode.
- Bot names, descriptions, avatars, provider, model, and effort persist in the
  shared workspace, not per-browser storage. Failed saves show a warning and retry.
- Settings or the sidebar’s three-dot menu can delete an agent and its chat history. If it has memory notes,
  choose another agent to receive them or delete the notes. Linked notes are
  remapped during transfer. A running request must finish or be stopped first.
- Shared chats always include Bunji's scoped memory tools. Codex keeps its
  computer sandbox; Claude uses a restricted built-in tool set without shell
  or edits while memory tools are available.
- Each bot can also keep a shared computer profile: no computer, a selected
  folder, or This Mac full access. Selecting full access shows a confirmation
  modal; no device pairing is required. Folder changes run through Codex's
  `workspace-write` sandbox; This Mac runs unrestricted through either provider.
  See [computer access
  design](docs/computer-access.md).

## Shared runtime and sign-in

The terminal and HTTP bridge share `packages/core/src/runtime.mjs`: provider
commands, model/effort validation, login checks, activity streams, and token
accounting. Subscription meters share `packages/core/src/usage.mjs`. The browser
model catalog is also used by the terminal. No second copy of the agent runner
is needed.

Run `codex login` or `claude auth login` to connect the corresponding provider.
The app checks current login status; no account state is hard-coded.

The temporary Ollama connector defaults to `http://192.168.68.78:11434`. Set
`BUNJI_OLLAMA_URL` before starting BunjiBox to point it at another Ollama host.
Keep that endpoint on a trusted network; BunjiBox does not add authentication to
the Ollama connection.

This is a LAN-only alpha. Do not expose the dev server to the public internet.
There is no account or device authentication: anyone who can reach the web app
on your network can enable full access and send commands through a bot. Use only
on a trusted network.

## Ongoing conversations and agent memory

Open the Memory tab in the agent sidebar to browse, create, edit, and follow linked Markdown
notes. Memory lives in `~/.config/bunji/memory/<bot-id>/` (or your configured data
directory), with stable `[[note-id|Title]]` links and source message IDs.

Agents can search, read, and save useful notes in every shared chat. Just ask
the agent to remember something, or let it capture a durable preference or
decision when relevant. In Bunji, `/memory [search]`, `/recall <note-id>`, and
`/older` help you browse history; `/remember <text>` still works as an alias.

Notes are not saved from every message. They are plaintext;
do not save secrets. Only relevant retrieved notes go to the selected provider.
See [the continuity design and alpha limits](docs/agent-continuity.md) for storage,
permissions, recovery, context budgeting, and what is not implemented yet.
