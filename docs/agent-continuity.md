# One agent, one continuing conversation

Status: the first shared-history and linked-memory alpha is implemented.
No automatic memory extraction, semantic search, or summary generation runs.

## One service, several clients

Phone, desktop web, and the interactive Bunji terminal use the same Bunji HTTP
service. That service owns provider runs, saved chat in SQLite, and per-bot
Markdown memory vaults. The terminal can start it automatically; Vite is not
needed for terminal-only use. Bot settings continue to share the SQLite store.

One default timeline belongs to each stable bot ID. Changing Claude/Codex or a
model changes the responder, not the bot, its conversation, or its memories.
Closing a client stops observing, not execution. Use Stop or Ctrl+X to cancel.
Stable request IDs make retries idempotent. A second simultaneous send to the
same bot gets a conflict; different bots may run concurrently.

User messages, final responses, bounded sanitized activity, provider/model/effort,
memory permission, context counts, and reported token usage persist in SQLite.
Clients poll the live tail and load older pages with sequence cursors. When not
all history is loaded, token totals cover loaded requests only.

After a crash, unfinished requests become **interrupted** on the next successful
service startup; they are never silently rerun. Final text arrives on completion,
while tool activity appears during execution. A hard crash can lose response
text/usage the provider has not yet reported.

### API

- GET /api/health: identity, workspace fingerprint, working directory.
- GET /api/bots/:id/history?before=<cursor>&limit=100: saved request pages.
- POST /api/bots/:id/messages: {id,prompt,provider,model,effort,memoryWrite}. New clients send memoryWrite:true; the server enables memory tools for every new request, including requests from older clients.
  Returns 202 after persistence, or 200 for an existing identical retry.
- GET /api/runs/:id: current saved state.
- POST /api/runs/:id/cancel: explicit stop; accepts a JSON object.
- GET /api/bots/:id/memory[?q=...]: metadata or bounded search snippets.
- GET /api/bots/:id/memory/:noteId: full note.
- POST /api/bots/:id/memory: explicit manual note creation.
- PATCH /api/bots/:id/memory/:noteId: edit with expectedRevision.

Old /api/run remains stateless for compatibility. Interactive clients no longer
use it. bunji -p also remains stateless, without shared history or memory tools.

## Markdown is the memory source of truth

Default files:
- ~/.config/bunji/workspace.sqlite
- ~/.config/bunji/memory/<bot-id>/<note-id>.md
- ~/.config/bunji/.service-lease.sqlite: separate process-owner lock, not chat data.

BUNJI_DATA_DIR overrides the workspace; otherwise XDG_CONFIG_HOME/bunji is used
when set. Use the same directory for API and CLI. Keep SQLite on local disk,
not a network or cloud-synced filesystem. This is single-owner Mac-hosted
storage, not cloud-account sync. The Mac must remain running and reachable.

Each note has a stable ID, title, Markdown body, timestamps, hash revision, and
source request IDs. Links are [[note-id|Human title]], so renaming a title does
not break relationships. The panel displays outgoing links and backlinks.
Search is lexical over titles and bodies, not vector search.

The vault can be opened in a Markdown editor such as Obsidian. Preserve generated
frontmatter and stable filenames. Content hashes detect external edits; stale
saves return 409 instead of overwriting newer notes. Writes are atomic, with
short per-bot cross-process locks. Symlink/hardlink paths are rejected.
A crashed writer's lock is not stolen automatically: check the recorded PID
before manually removing a stale .memory-write.lock.

Limits: 5,000 notes per bot, 12,000 characters per body, at most 10 search hits,
480-character snippets. Whole-vault scans are sufficient for this small alpha.

## Memory is a tool, not an ever-growing prompt

A request-scoped MCP server exposes memory_search, memory_read, memory_write,
and memory_link. The process is bound to one bot and source request. Model
arguments cannot choose another directory, bot, source ID, or write permission.
Tool output is labeled as data, not higher-priority instructions. Notes are not
injected wholesale; agents retrieve relevant ones and cite their IDs.

Memory tools are available on every new shared chat request. Guidance asks the
agent to save durable, useful preferences, decisions, and facts when relevant,
without saving every message. Manual Create/Edit remains available in the
Memory panel. Old requests keep their original recorded memory permissions.

Known credential patterns are rejected, but this is best-effort, not a complete
secret detector. Do not save passwords, keys, sensitive records, or private
model reasoning. Notes are plaintext, and retrieved content goes to the chosen
provider. Activity logs retain sanitized excerpts of tool results.

Codex retains read-only sandboxing with a request-scoped allowlisted MCP server.
Claude uses dontAsk with only Read/Glob/Grep/WebFetch/WebSearch/ToolSearch and Bunji MCP tools.
No shell, built-in edits, subagents, or other MCP servers are available for that
turn. Only scoped memory tools are pre-approved. Global provider settings are
not changed. Managed provider policies can still deny a tool.

Adapters follow the official [Codex MCP configuration](https://developers.openai.com/codex/mcp)
and [Claude permission modes](https://code.claude.com/docs/en/permission-modes).

## Context and cost

Full history stays saved, but a new prompt includes only recent completed
exchanges, the bot purpose, memory instructions, and the current message within
a 12,000-character application budget. Debug logs show included/omitted exchange
counts. This is a character cap, not a token estimate or provider context size.

Provider instructions, installed tool schemas, and repeated model calls still
add usage. Memory retrieval avoids sending the entire vault; it does not remove
the underlying CLI's overhead. Counters use provider-reported usage and never
add cache-read tokens to input twice.

No automatic working summary exists yet. An older fact may be absent unless
saved in a note and retrieved. A continuing thread is not perfect recall.
Provider-native sessions remain ephemeral; continuity belongs to Bunji.

## Alpha limits and next decisions

- New messages persist from this build onward. Prior in-memory-only chat cannot
  be recovered once the old browser/terminal state has been lost.
- Trusted LAN only: no authentication, public hosting, multi-owner isolation,
  encrypted transport, or durable offline queue. Do not expose Vite publicly.
- A process-owner lease enforces one service per workspace, even across ports.
  The OS releases it on exit; never unlink the lease file while a service is live.
  The service has one working directory; connecting
  clients must not pretend a different --cwd silently took effect.
- Linked-note navigation is implemented, not a draggable graph canvas.
- Note deletion/forget, revision history, consistent backup/export, automatic
  summary suggestions, and cross-agent sharing need separate product decisions.
- External editors do not honor Bunji's lock. Hashes catch observed conflicts,
  but simultaneous external editing at the instant of a save has a race.

Tests cover restart recovery, idempotency, provider switching, cancellation,
concurrent writers, path/scope guards, revisions, MCP write gating, reconnects,
and UI behavior. server/provider-memory.smoke.mjs is opt-in and consumes real
provider usage against disposable notes only.
