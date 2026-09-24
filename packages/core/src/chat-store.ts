import type { DatabaseSync } from 'node:sqlite'
import { workspacePath } from './workspace.ts'
import { validId } from '@bunji/shared/bots'
import { fail } from '@bunji/shared/errors'
import { normalizeMode, runtimes, supportedModes } from '@bunji/shared/runtimes'
import type {
  Activity, ActivityKind, ActivityStatus, ChatRequest, Effort, ExecutionMode, HistoryPage, MessageEdit, Provider,
  RequestedMode, RequestStatus, RewindResult, StartResult, TextMetrics, TokenField, TokenUsage, UsageBreakdown,
} from '@bunji/shared/types'
import { displayText } from './run-events.ts'
import { openWorkspaceDatabase, transaction } from './sqlite.ts'

const MAX_PROMPT = 12000, MAX_TEXT = 1000000, MAX_ACTIVITIES = 150
const terminal = new Set(['complete', 'failed', 'cancelled', 'interrupted'])
const activityKinds = new Set(['tool', 'reasoning', 'plan', 'notice'])
const activityStatuses = new Set(['running', 'complete', 'failed', 'unknown', 'cancelled', 'interrupted'])
const tokenFields: TokenField[] = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningOutputTokens', 'totalTokens']
const textMetricFields: (keyof TextMetrics)[] = ['characters', 'utf8Bytes', 'words', 'estimatedTokens']
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A saved request read back with its bot. */
export type BotChatRequest = ChatRequest & { botId: string }

export interface ChatHistoryOptions {
  /** 1–1000, default 100. */
  limit?: number
  /** Exclusive cursor from a previous page's `nextBefore`. */
  before?: string | number | null
}

/**
 * Shared chat history in workspace.sqlite. All methods are synchronous and
 * errors carry an HTTP `status`. Values crossing from providers or clients
 * (start payloads, activities, finish patches) are validated here, so those
 * parameters are `unknown`.
 */
export interface ChatStore {
  path: string
  history(botId: string, options?: ChatHistoryOptions): HistoryPage
  /** Idempotent by request ID: a retry with the same payload returns the saved request. */
  start(value: unknown): StartResult
  addActivity(id: string, activity: unknown): ChatRequest
  /** Records Auto mode's resolved mode on a running request. */
  route(id: string, route: { mode: ExecutionMode; reason: string }): ChatRequest
  /** Settles a running request; terminal requests ignore late finishes. */
  finish(id: string, patch?: unknown): ChatRequest
  get(id: string): BotChatRequest | null
  editMessage(botId: string, id: string, edit: MessageEdit): ChatRequest
  rewind(botId: string, id: string, options?: { expectedPrompt?: string }): RewindResult
  /** Marks every running request interrupted. Returns how many there were. */
  recoverInterrupted(): number
  listRunning(): BotChatRequest[]
  recentCompleted(botId: string, options?: { limit?: number }): ChatRequest[]
  completedCount(botId: string): number
  close(): void
}

/** The immutable start payload saved with each request. Key order is part of the idempotency check. */
interface StartInput {
  id: string
  botId: string
  prompt: string
  provider: Provider
  model: string
  effort: Effort
  requestedMode: RequestedMode
  mode: ExecutionMode
  modeReason: string | null
  memoryWrite: boolean
  contextTurns: number
  omittedTurns: number
}

// A type alias (not an interface) so node:sqlite's loose rows cast to it directly.
type ChatRow = {
  seq: number
  id: string
  bot_id: string
  start_payload: string
  prompt: string
  provider: Provider
  model: string
  effort: Effort
  requested_mode: RequestedMode
  mode: ExecutionMode
  mode_reason: string | null
  memory_write: number
  started_at: number
  status: RequestStatus
  text: string
  activities: string
  usage: string | null
  usage_breakdown: string | null
  duration_ms: number | null
  error: string | null
  context_turns: number
  omitted_turns: number
  prompt_edited_at: number | null
  response_edited_at: number | null
}

function identifier(value: unknown, label = 'request'): string {
  if (!validId(value)) throw fail(`Invalid ${label} ID.`)
  return value
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) throw fail(`${label} must be text up to ${max} characters.`)
  return value
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw fail(`${label} must be a nonnegative safe integer.`)
  return value as number
}

function limitValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) throw fail('Limit must be an integer from 1 to 1000.')
  return value as number
}

function cursorValue(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw fail('Invalid history cursor.')
  return value as number
}

function startValue(value: unknown): StartInput {
  if (!object(value)) throw fail('Invalid chat request.')
  const { id, botId, prompt, provider, model, effort } = value
  identifier(id); identifier(botId, 'bot')
  text(prompt, MAX_PROMPT, 'Prompt')
  if (!(prompt as string).trim()) throw fail('Prompt must not be empty.')
  if (!Object.hasOwn(runtimes, provider as PropertyKey)) throw fail('Invalid provider.')
  // Runtime support belongs to the coordinator. Persist bounded metadata without
  // tying old request retries to a model catalog that can change over time.
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/.test(model)) throw fail('Invalid model.')
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort as string)) throw fail('Invalid effort.')
  if (value.requestedMode !== undefined && !supportedModes(provider).includes(value.requestedMode as RequestedMode)) throw fail('That requested mode is not supported by this provider.')
  const mode = value.mode === undefined ? normalizeMode(provider) : value.mode
  if (!['chat', 'agent'].includes(mode as string)) throw fail('A request must resolve to Chat or Agent mode.')
  const requestedMode = value.requestedMode ?? mode
  const modeReason = value.modeReason === undefined || value.modeReason === null ? null : displayText(text(value.modeReason, 320, 'Mode reason'))
  const memoryWrite = value.memoryWrite === undefined ? false : value.memoryWrite
  if (typeof memoryWrite !== 'boolean') throw fail('Memory write must be a boolean.')
  return { id: id as string, botId: botId as string, prompt: prompt as string, provider: provider as Provider, model, effort: effort as Effort,
    requestedMode: requestedMode as RequestedMode, mode: mode as ExecutionMode, modeReason, memoryWrite,
    contextTurns: count(value.contextTurns ?? 0, 'Context turns'),
    omittedTurns: count(value.omittedTurns ?? 0, 'Omitted turns') }
}

function textMetrics(value: unknown, label: string): TextMetrics {
  if (!object(value)) throw fail(`Invalid ${label}.`)
  return Object.fromEntries(textMetricFields.map(field => [field, count(value[field], `${label} ${field}`)])) as Record<keyof TextMetrics, number>
}

function usageBreakdownValue(value: unknown): UsageBreakdown | null {
  if (value === undefined || value === null) return null
  if (!object(value) || value.version !== 1 || !['role-messages', 'combined-prompt'].includes(value.payloadMode as string)
    || value.estimator !== 'utf8-bytes-divided-by-4') throw fail('Invalid usage breakdown.')
  const harness = value.providerHarnessUnknown
  if (!object(harness) || !['pending', 'estimated', 'unavailable'].includes(harness.status as string)) throw fail('Invalid provider harness attribution.')
  const estimatedTokens = harness.estimatedTokens === null ? null : count(harness.estimatedTokens, 'Provider harness estimatedTokens')
  if (harness.status === 'estimated' && estimatedTokens === null) throw fail('Estimated provider harness tokens are required.')
  if (harness.status !== 'estimated' && estimatedTokens !== null) throw fail('Unavailable provider harness tokens must be null.')
  const reason = harness.reason === null ? null : displayText(text(harness.reason, 256, 'Provider harness reason'))
  const bunjiContext: UsageBreakdown['bunjiContext'] = { ...textMetrics(value.bunjiContext, 'Bunji context'), historyTurns: 0 }
  bunjiContext.historyTurns = count((value.bunjiContext as Record<string, unknown>).historyTurns, 'Bunji context historyTurns')
  return { version: 1, estimator: value.estimator, payloadMode: value.payloadMode as UsageBreakdown['payloadMode'],
    userMessage: textMetrics(value.userMessage, 'User message'), bunjiContext,
    providerHarnessUnknown: { estimatedTokens, status: harness.status as UsageBreakdown['providerHarnessUnknown']['status'], reason } }
}

function usageValue(value: unknown): TokenUsage | null {
  if (value === null) return null
  if (!object(value)) throw fail('Invalid usage.')
  const usage: TokenUsage = {}
  for (const field of tokenFields) {
    if (value[field] !== undefined) usage[field] = value[field] === null ? null : count(value[field], field)
  }
  if (value.source !== undefined) usage.source = displayText(text(value.source, 256, 'Usage source'))
  return usage
}

function activityValue(value: unknown, previous: Activity | undefined): Activity {
  if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256 || /\p{Cc}/u.test(value.id)) throw fail('Invalid activity ID.')
  const next: Activity = previous ? { ...previous } : { id: value.id, at: Date.now(), kind: 'notice', title: 'Activity', status: 'running' }
  if (value.at !== undefined) {
    const at = typeof value.at === 'string' ? Date.parse(value.at) : value.at
    count(at, 'Activity timestamp')
    if (!previous) next.at = at as number
  }
  if (value.kind !== undefined) {
    if (!activityKinds.has(value.kind as string)) throw fail('Invalid activity kind.')
    next.kind = value.kind as ActivityKind
  }
  if (value.status !== undefined) {
    if (!activityStatuses.has(value.status as string)) throw fail('Invalid activity status.')
    next.status = value.status as ActivityStatus
  }
  for (const field of ['title', 'text', 'input', 'output'] as const) {
    if (value[field] !== undefined) {
      try { next[field] = displayText(value[field]) }
      catch { throw fail(`Invalid activity ${field}.`) }
    }
  }
  if (value.exitCode !== undefined) {
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) throw fail('Invalid activity exit code.')
    next.exitCode = value.exitCode as number | null
  }
  return next
}

function mergeActivity(activities: Activity[], value: unknown) {
  const index = activities.findIndex(item => item.id === (value as { id?: unknown } | null | undefined)?.id)
  const next = activityValue(value, index < 0 ? undefined : activities[index])
  if (index >= 0) activities[index] = next
  else if (activities.length < MAX_ACTIVITIES) activities.push(next)
}

const settleActivities = (activities: Activity[]): Activity[] => activities.map(item => item.status === 'running' ? { ...item, status: 'unknown' } : item)
const settleUsageBreakdown = (breakdown: UsageBreakdown | null): UsageBreakdown | null => breakdown?.providerHarnessUnknown?.status === 'pending' ? {
  ...breakdown,
  providerHarnessUnknown: { estimatedTokens: null, status: 'unavailable', reason: 'Provider input tokens were unavailable.' },
} : breakdown
const requestValue = (row: ChatRow): ChatRequest => ({
  id: row.id, prompt: row.prompt, provider: row.provider, model: row.model, effort: row.effort,
  requestedMode: row.requested_mode, mode: row.mode, modeReason: row.mode_reason,
  memoryWrite: row.memory_write === 1,
  startedAt: row.started_at, status: row.status, text: row.text,
  activities: JSON.parse(row.activities) as Activity[], usage: row.usage === null ? null : JSON.parse(row.usage) as TokenUsage,
  usageBreakdown: row.usage_breakdown === null ? null : JSON.parse(row.usage_breakdown) as UsageBreakdown,
  durationMs: row.duration_ms, error: row.error, contextTurns: row.context_turns, omittedTurns: row.omitted_turns,
  promptEditedAt: row.prompt_edited_at ?? null, responseEditedAt: row.response_edited_at ?? null,
})

// Older workspaces predate some columns. Add them in place, keeping history.
function migrate(db: DatabaseSync) {
  const columns = new Set(db.prepare('PRAGMA table_info(chat_requests)').all().map(column => column.name))
  if (!columns.has('mode')) {
    db.exec("ALTER TABLE chat_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'agent' CHECK(mode IN ('chat','agent'))")
    db.exec("UPDATE chat_requests SET mode='chat' WHERE provider IN ('openrouter','ollama')")
  }
  if (!columns.has('requested_mode')) {
    db.exec("ALTER TABLE chat_requests ADD COLUMN requested_mode TEXT NOT NULL DEFAULT 'agent' CHECK(requested_mode IN ('auto','chat','agent'))")
    db.exec('UPDATE chat_requests SET requested_mode=mode')
  }
  if (!columns.has('mode_reason')) db.exec('ALTER TABLE chat_requests ADD COLUMN mode_reason TEXT')
  if (!columns.has('prompt_edited_at')) db.exec('ALTER TABLE chat_requests ADD COLUMN prompt_edited_at INTEGER')
  if (!columns.has('response_edited_at')) db.exec('ALTER TABLE chat_requests ADD COLUMN response_edited_at INTEGER')
  if (!columns.has('usage_breakdown')) db.exec('ALTER TABLE chat_requests ADD COLUMN usage_breakdown TEXT')
}

// All methods are synchronous. Cursors are decimal sequence strings (exclusive
// `before`), never timestamps. History and recentCompleted return oldest first.
// start compares its immutable original payload, even after finish updates counts.
// finish defaults to complete; terminal requests ignore late finishes/events.
export function openChatStore({ path = workspacePath() }: { path?: string } = {}): ChatStore {
  const db = openWorkspaceDatabase(path, `
      CREATE TABLE IF NOT EXISTS chat_requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        start_payload TEXT NOT NULL,
        prompt TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        requested_mode TEXT NOT NULL DEFAULT 'agent' CHECK(requested_mode IN ('auto','chat','agent')),
        mode TEXT NOT NULL DEFAULT 'agent' CHECK(mode IN ('chat','agent')),
        mode_reason TEXT,
        memory_write INTEGER NOT NULL DEFAULT 0 CHECK(memory_write IN (0,1)),
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','complete','failed','cancelled','interrupted')),
        text TEXT NOT NULL DEFAULT '',
        activities TEXT NOT NULL DEFAULT '[]',
        usage TEXT,
        usage_breakdown TEXT,
        duration_ms INTEGER,
        error TEXT,
        context_turns INTEGER NOT NULL,
        omitted_turns INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_requests_history ON chat_requests(bot_id, seq);
      CREATE INDEX IF NOT EXISTS chat_requests_completed ON chat_requests(bot_id, seq) WHERE status='complete';
      CREATE UNIQUE INDEX IF NOT EXISTS chat_requests_running ON chat_requests(bot_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS chat_revisions (bot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);`, migrate)

  const rowFor = (id: string) => db.prepare('SELECT * FROM chat_requests WHERE id=?').get(id) as ChatRow | undefined
  const requireRow = (id: string) => {
    const row = rowFor(identifier(id))
    if (!row) throw fail('Chat request not found.', 404)
    return row
  }
  const bump = (botId: string) => db.prepare('INSERT INTO chat_revisions(bot_id,revision) VALUES(?,1) ON CONFLICT(bot_id) DO UPDATE SET revision=revision+1').run(botId)
  const revision = (botId: string) => (db.prepare('SELECT revision FROM chat_revisions WHERE bot_id=?').get(botId) as { revision: number } | undefined)?.revision ?? 0
  const save = (row: ChatRow, request: ChatRequest) => {
    db.prepare(`UPDATE chat_requests SET requested_mode=?,mode=?,mode_reason=?,memory_write=?,status=?,text=?,activities=?,usage=?,usage_breakdown=?,duration_ms=?,error=?,context_turns=?,omitted_turns=? WHERE id=?`)
      .run(request.requestedMode, request.mode, request.modeReason, request.memoryWrite ? 1 : 0, request.status, request.text, JSON.stringify(request.activities),
        request.usage === null ? null : JSON.stringify(request.usage), request.usageBreakdown === null ? null : JSON.stringify(request.usageBreakdown),
        request.durationMs, request.error, request.contextTurns, request.omittedTurns, row.id)
    bump(row.bot_id)
    return request
  }

  return {
    path,
    history(botId, { limit = 100, before } = {}) {
      identifier(botId, 'bot'); limitValue(limit)
      const cursor = cursorValue(before)
      return transaction(db, () => {
        const rows = (cursor === null
          ? db.prepare('SELECT * FROM chat_requests WHERE bot_id=? ORDER BY seq DESC LIMIT ?').all(botId, limit + 1)
          : db.prepare('SELECT * FROM chat_requests WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, cursor, limit + 1)) as ChatRow[]
        const hasMore = rows.length > limit
        const page = rows.slice(0, limit).reverse()
        return { requests: page.map(requestValue), hasMore, nextBefore: hasMore ? String(page[0].seq) : null, revision: revision(botId) }
      }, { write: false })
    },
    start(value) {
      const input = startValue(value), payload = JSON.stringify(input), usageBreakdown = usageBreakdownValue((value as { usageBreakdown?: unknown }).usageBreakdown)
      return transaction(db, () => {
        const existing = rowFor(input.id)
        if (existing) {
          let original = existing.start_payload
          if (original !== payload) {
            // Mode predates some saved requests. Normalize their immutable
            // payload on comparison so a safe retry after migration stays idempotent.
            try { original = JSON.stringify(startValue(JSON.parse(original))) } catch { /* Preserve the strict mismatch below. */ }
          }
          if (original !== payload) throw fail('That request ID is already in use with a different payload.', 409)
          return { request: requestValue(existing), created: false }
        }
        if (db.prepare("SELECT 1 FROM chat_requests WHERE bot_id=? AND status='running'").get(input.botId)) throw fail('A request is already running for this bot.', 409)
        db.prepare(`INSERT INTO chat_requests(id,bot_id,start_payload,prompt,provider,model,effort,requested_mode,mode,mode_reason,memory_write,started_at,status,context_turns,omitted_turns,usage_breakdown)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'running',?,?,?)`).run(input.id, input.botId, payload, input.prompt, input.provider, input.model, input.effort,
          input.requestedMode, input.mode, input.modeReason, input.memoryWrite ? 1 : 0, Date.now(), input.contextTurns, input.omittedTurns,
          usageBreakdown === null ? null : JSON.stringify(usageBreakdown))
        bump(input.botId)
        return { request: requestValue(rowFor(input.id)!), created: true }
      })
    },
    addActivity(id, activity) {
      return transaction(db, () => {
        const row = requireRow(id), request = requestValue(row)
        if (request.status !== 'running') return request
        const activities = [...request.activities]
        mergeActivity(activities, activity)
        if (same(activities, request.activities)) return request
        return save(row, { ...request, activities })
      })
    },
    route(id, { mode, reason }) {
      if (!['chat', 'agent'].includes(mode)) throw fail('Invalid resolved mode.')
      const modeReason = displayText(text(reason, 320, 'Mode reason'))
      return transaction(db, () => {
        const row = requireRow(id), request = requestValue(row)
        if (request.status !== 'running') return request
        return save(row, { ...request, mode, modeReason, memoryWrite: mode === 'agent' })
      })
    },
    finish(id, patch = {}) {
      if (!object(patch)) throw fail('Invalid finish patch.')
      return transaction(db, () => {
        const row = requireRow(id), request = requestValue(row)
        if (request.status !== 'running') return request
        const status = patch.status ?? 'complete'
        if (!terminal.has(status as string)) throw fail('Invalid final request status.')
        const next: ChatRequest = { ...request, status: status as RequestStatus, activities: [...request.activities] }
        if (patch.text !== undefined) next.text = text(patch.text, MAX_TEXT, 'Response')
        if (patch.usage !== undefined) next.usage = usageValue(patch.usage)
        if (patch.usageBreakdown !== undefined) next.usageBreakdown = usageBreakdownValue(patch.usageBreakdown)
        next.durationMs = patch.durationMs === undefined ? Math.max(0, Date.now() - request.startedAt) : count(patch.durationMs, 'Duration')
        if (patch.error !== undefined) next.error = patch.error === null ? null : displayText(text(patch.error, MAX_PROMPT, 'Error'))
        if (patch.contextTurns !== undefined) next.contextTurns = count(patch.contextTurns, 'Context turns')
        if (patch.omittedTurns !== undefined) next.omittedTurns = count(patch.omittedTurns, 'Omitted turns')
        if (patch.activities !== undefined) {
          if (!Array.isArray(patch.activities) || patch.activities.length > MAX_ACTIVITIES) throw fail('Invalid final activities (maximum 150).')
          for (const activity of patch.activities) mergeActivity(next.activities, activity)
        }
        if (status !== 'complete' && !next.error) next.error = status === 'cancelled' ? 'Request stopped.'
          : status === 'interrupted' ? 'Request was interrupted before completion.' : 'Provider request failed.'
        next.activities = settleActivities(next.activities)
        next.usageBreakdown = settleUsageBreakdown(next.usageBreakdown)
        // Explicit columns above are the only mutable fields. Runtime result
        // metadata (ok, failed, requestId, etc.) cannot alter request identity.
        return save(row, next)
      })
    },
    get(id) {
      const row = rowFor(identifier(id))
      return row ? { ...requestValue(row), botId: row.bot_id } : null
    },
    editMessage(botId, id, { role, value, expectedText }) {
      identifier(botId, 'bot'); identifier(id)
      if (role !== 'user' && role !== 'assistant') throw fail('Choose a user or assistant message.')
      const max = role === 'user' ? MAX_PROMPT : MAX_TEXT
      text(value, max, 'Message'); text(expectedText, max, 'Expected message')
      if (!value.trim()) throw fail('Message must not be empty.')
      return transaction(db, () => {
        const row = requireRow(id)
        if (row.bot_id !== botId) throw fail('Message not found for this bot.', 404)
        if (row.status === 'running') throw fail('Wait for this request to finish before editing.', 409)
        if (role === 'assistant' && row.status !== 'complete') throw fail('Only complete replies can be edited.', 409)
        const field = role === 'user' ? 'prompt' : 'text'
        if (row[field] !== expectedText) throw fail('Message changed on another device. Reload and review it before saving.', 409)
        if (row[field] === value) return requestValue(row)
        const editedField = role === 'user' ? 'prompt_edited_at' : 'response_edited_at'
        db.prepare(`UPDATE chat_requests SET ${field}=?, ${editedField}=? WHERE id=?`).run(value, Date.now(), id)
        bump(botId)
        return requestValue(rowFor(id)!)
      })
    },
    rewind(botId, id, { expectedPrompt } = {}) {
      identifier(botId, 'bot'); identifier(id)
      text(expectedPrompt, MAX_PROMPT, 'Expected prompt')
      if (!expectedPrompt?.trim()) throw fail('Expected prompt must not be empty.')
      return transaction(db, () => {
        const row = requireRow(id)
        if (row.bot_id !== botId) throw fail('Message not found for this bot.', 404)
        if (row.status === 'running' || db.prepare("SELECT 1 FROM chat_requests WHERE bot_id=? AND status='running'").get(botId)) {
          throw fail('Wait for this request to finish before rewinding.', 409)
        }
        if (row.prompt !== expectedPrompt) throw fail('Message changed on another device. Reload and review it before rewinding.', 409)
        const removed = (db.prepare('SELECT COUNT(*) AS count FROM chat_requests WHERE bot_id=? AND seq>=?').get(botId, row.seq) as { count: number }).count
        db.prepare('DELETE FROM chat_requests WHERE bot_id=? AND seq>=?').run(botId, row.seq)
        bump(botId)
        return { id, botId, prompt: row.prompt, removed }
      })
    },
    recoverInterrupted() {
      return transaction(db, () => {
        const rows = db.prepare("SELECT * FROM chat_requests WHERE status='running' ORDER BY seq").all() as ChatRow[]
        for (const row of rows) {
          const request = requestValue(row)
          save(row, { ...request, status: 'interrupted',
            error: 'Request was interrupted by a restart before completion. It was not retried.',
            durationMs: request.durationMs ?? Math.max(0, Date.now() - request.startedAt),
            activities: settleActivities(request.activities), usageBreakdown: settleUsageBreakdown(request.usageBreakdown) })
        }
        return rows.length
      })
    },
    listRunning() {
      return (db.prepare("SELECT * FROM chat_requests WHERE status='running' ORDER BY seq").all() as ChatRow[])
        .map(row => ({ ...requestValue(row), botId: row.bot_id }))
    },
    recentCompleted(botId, { limit = 20 } = {}) {
      identifier(botId, 'bot'); limitValue(limit)
      return (db.prepare("SELECT * FROM chat_requests WHERE bot_id=? AND status='complete' ORDER BY seq DESC LIMIT ?")
        .all(botId, limit) as ChatRow[]).reverse().map(requestValue)
    },
    completedCount(botId) {
      identifier(botId, 'bot')
      return (db.prepare("SELECT COUNT(*) AS count FROM chat_requests WHERE bot_id=? AND status='complete'").get(botId) as { count: number }).count
    },
    close: () => db.close(),
  }
}
