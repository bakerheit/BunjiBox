import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { workspacePath } from './bot-store.mjs'
import { validId } from '@bunji/shared/bots'
import { normalizeMode, runtimes, supportedModes } from '@bunji/shared/runtimes'
import { displayText } from './run-events.mjs'

const MAX_PROMPT = 12000, MAX_TEXT = 1000000, MAX_ACTIVITIES = 150
const terminal = new Set(['complete', 'failed', 'cancelled', 'interrupted'])
const activityKinds = new Set(['tool', 'reasoning', 'plan', 'notice'])
const activityStatuses = new Set(['running', 'complete', 'failed', 'unknown', 'cancelled', 'interrupted'])
const tokenFields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningOutputTokens', 'totalTokens']
const textMetricFields = ['characters', 'utf8Bytes', 'words', 'estimatedTokens']
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function identifier(value, label = 'request') {
  if (!validId(value)) throw fail(`Invalid ${label} ID.`)
  return value
}

function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw fail(`${label} must be text up to ${max} characters.`)
  return value
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail(`${label} must be a nonnegative safe integer.`)
  return value
}

function limitValue(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw fail('Limit must be an integer from 1 to 1000.')
  return value
}

function cursorValue(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) throw fail('Invalid history cursor.')
  return value
}

function startValue(value) {
  if (!object(value)) throw fail('Invalid chat request.')
  const { id, botId, prompt, provider, model, effort } = value
  identifier(id); identifier(botId, 'bot')
  text(prompt, MAX_PROMPT, 'Prompt')
  if (!prompt.trim()) throw fail('Prompt must not be empty.')
  if (!Object.hasOwn(runtimes, provider)) throw fail('Invalid provider.')
  // Runtime support belongs to the coordinator. Persist bounded metadata without
  // tying old request retries to a model catalog that can change over time.
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/.test(model)) throw fail('Invalid model.')
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw fail('Invalid effort.')
  if (value.requestedMode !== undefined && !supportedModes(provider).includes(value.requestedMode)) throw fail('That requested mode is not supported by this provider.')
  const mode = value.mode === undefined ? normalizeMode(provider) : value.mode
  if (!['chat', 'agent'].includes(mode)) throw fail('A request must resolve to Chat or Agent mode.')
  const requestedMode = value.requestedMode ?? mode
  const modeReason = value.modeReason === undefined || value.modeReason === null ? null : displayText(text(value.modeReason, 320, 'Mode reason'))
  const memoryWrite = value.memoryWrite === undefined ? false : value.memoryWrite
  if (typeof memoryWrite !== 'boolean') throw fail('Memory write must be a boolean.')
  return { id, botId, prompt, provider, model, effort, requestedMode, mode, modeReason, memoryWrite,
    contextTurns: count(value.contextTurns ?? 0, 'Context turns'),
    omittedTurns: count(value.omittedTurns ?? 0, 'Omitted turns') }
}

function textMetrics(value, label) {
  if (!object(value)) throw fail(`Invalid ${label}.`)
  return Object.fromEntries(textMetricFields.map(field => [field, count(value[field], `${label} ${field}`)]))
}

function usageBreakdownValue(value) {
  if (value === undefined || value === null) return null
  if (!object(value) || value.version !== 1 || !['role-messages', 'combined-prompt'].includes(value.payloadMode)
    || value.estimator !== 'utf8-bytes-divided-by-4') throw fail('Invalid usage breakdown.')
  const harness = value.providerHarnessUnknown
  if (!object(harness) || !['pending', 'estimated', 'unavailable'].includes(harness.status)) throw fail('Invalid provider harness attribution.')
  const estimatedTokens = harness.estimatedTokens === null ? null : count(harness.estimatedTokens, 'Provider harness estimatedTokens')
  if (harness.status === 'estimated' && estimatedTokens === null) throw fail('Estimated provider harness tokens are required.')
  if (harness.status !== 'estimated' && estimatedTokens !== null) throw fail('Unavailable provider harness tokens must be null.')
  const reason = harness.reason === null ? null : displayText(text(harness.reason, 256, 'Provider harness reason'))
  const bunjiContext = textMetrics(value.bunjiContext, 'Bunji context')
  bunjiContext.historyTurns = count(value.bunjiContext.historyTurns, 'Bunji context historyTurns')
  return { version: 1, estimator: value.estimator, payloadMode: value.payloadMode,
    userMessage: textMetrics(value.userMessage, 'User message'), bunjiContext,
    providerHarnessUnknown: { estimatedTokens, status: harness.status, reason } }
}

function usageValue(value) {
  if (value === null) return null
  if (!object(value)) throw fail('Invalid usage.')
  const usage = {}
  for (const field of tokenFields) {
    if (value[field] !== undefined) usage[field] = value[field] === null ? null : count(value[field], field)
  }
  if (value.source !== undefined) usage.source = displayText(text(value.source, 256, 'Usage source'))
  return usage
}

function activityValue(value, previous) {
  if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256 || /\p{Cc}/u.test(value.id)) throw fail('Invalid activity ID.')
  const next = previous ? { ...previous } : { id: value.id, at: Date.now(), kind: 'notice', title: 'Activity', status: 'running' }
  if (value.at !== undefined) {
    const at = typeof value.at === 'string' ? Date.parse(value.at) : value.at
    count(at, 'Activity timestamp')
    if (!previous) next.at = at
  }
  if (value.kind !== undefined) {
    if (!activityKinds.has(value.kind)) throw fail('Invalid activity kind.')
    next.kind = value.kind
  }
  if (value.status !== undefined) {
    if (!activityStatuses.has(value.status)) throw fail('Invalid activity status.')
    next.status = value.status
  }
  for (const field of ['title', 'text', 'input', 'output']) {
    if (value[field] !== undefined) {
      try { next[field] = displayText(value[field]) }
      catch { throw fail(`Invalid activity ${field}.`) }
    }
  }
  if (value.exitCode !== undefined) {
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) throw fail('Invalid activity exit code.')
    next.exitCode = value.exitCode
  }
  return next
}

function mergeActivity(activities, value) {
  const index = activities.findIndex(item => item.id === value?.id)
  const next = activityValue(value, index < 0 ? undefined : activities[index])
  if (index >= 0) activities[index] = next
  else if (activities.length < MAX_ACTIVITIES) activities.push(next)
}

const settleActivities = activities => activities.map(item => item.status === 'running' ? { ...item, status: 'unknown' } : item)
const settleUsageBreakdown = breakdown => breakdown?.providerHarnessUnknown?.status === 'pending' ? {
  ...breakdown,
  providerHarnessUnknown: { estimatedTokens: null, status: 'unavailable', reason: 'Provider input tokens were unavailable.' },
} : breakdown
const requestValue = row => ({
  id: row.id, prompt: row.prompt, provider: row.provider, model: row.model, effort: row.effort,
  requestedMode: row.requested_mode, mode: row.mode, modeReason: row.mode_reason,
  memoryWrite: row.memory_write === 1,
  startedAt: row.started_at, status: row.status, text: row.text,
  activities: JSON.parse(row.activities), usage: row.usage === null ? null : JSON.parse(row.usage),
  usageBreakdown: row.usage_breakdown === null ? null : JSON.parse(row.usage_breakdown),
  durationMs: row.duration_ms, error: row.error, contextTurns: row.context_turns, omittedTurns: row.omitted_turns,
  promptEditedAt: row.prompt_edited_at ?? null, responseEditedAt: row.response_edited_at ?? null,
})

// All methods are synchronous. Cursors are decimal sequence strings (exclusive
// `before`), never timestamps. History and recentCompleted return oldest first.
// start compares its immutable original payload, even after finish updates counts.
// finish defaults to complete; terminal requests ignore late finishes/events.
export function openChatStore({ path = workspacePath() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  try {
    if (path !== ':memory:') chmodSync(path, 0o600)
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
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
      CREATE TABLE IF NOT EXISTS chat_revisions (bot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);`)
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
  } catch (error) { db.close(); throw error }

  const transaction = (action, write = true) => {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const rowFor = id => db.prepare('SELECT * FROM chat_requests WHERE id=?').get(id)
  const requireRow = id => {
    const row = rowFor(identifier(id))
    if (!row) throw fail('Chat request not found.', 404)
    return row
  }
  const bump = botId => db.prepare('INSERT INTO chat_revisions(bot_id,revision) VALUES(?,1) ON CONFLICT(bot_id) DO UPDATE SET revision=revision+1').run(botId)
  const revision = botId => db.prepare('SELECT revision FROM chat_revisions WHERE bot_id=?').get(botId)?.revision ?? 0
  const save = (row, request) => {
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
      return transaction(() => {
        const rows = cursor === null
          ? db.prepare('SELECT * FROM chat_requests WHERE bot_id=? ORDER BY seq DESC LIMIT ?').all(botId, limit + 1)
          : db.prepare('SELECT * FROM chat_requests WHERE bot_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, cursor, limit + 1)
        const hasMore = rows.length > limit
        const page = rows.slice(0, limit).reverse()
        return { requests: page.map(requestValue), hasMore, nextBefore: hasMore ? String(page[0].seq) : null, revision: revision(botId) }
      }, false)
    },
    start(value) {
      const input = startValue(value), payload = JSON.stringify(input), usageBreakdown = usageBreakdownValue(value.usageBreakdown)
      return transaction(() => {
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
        return { request: requestValue(rowFor(input.id)), created: true }
      })
    },
    addActivity(id, activity) {
      return transaction(() => {
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
      return transaction(() => {
        const row = requireRow(id), request = requestValue(row)
        if (request.status !== 'running') return request
        return save(row, { ...request, mode, modeReason, memoryWrite: mode === 'agent' })
      })
    },
    finish(id, patch = {}) {
      if (!object(patch)) throw fail('Invalid finish patch.')
      return transaction(() => {
        const row = requireRow(id), request = requestValue(row)
        if (request.status !== 'running') return request
        const status = patch.status ?? 'complete'
        if (!terminal.has(status)) throw fail('Invalid final request status.')
        const next = { ...request, status, activities: [...request.activities] }
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
      return transaction(() => {
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
        return requestValue(rowFor(id))
      })
    },
    rewind(botId, id, { expectedPrompt } = {}) {
      identifier(botId, 'bot'); identifier(id)
      text(expectedPrompt, MAX_PROMPT, 'Expected prompt')
      if (!expectedPrompt?.trim()) throw fail('Expected prompt must not be empty.')
      return transaction(() => {
        const row = requireRow(id)
        if (row.bot_id !== botId) throw fail('Message not found for this bot.', 404)
        if (row.status === 'running' || db.prepare("SELECT 1 FROM chat_requests WHERE bot_id=? AND status='running'").get(botId)) {
          throw fail('Wait for this request to finish before rewinding.', 409)
        }
        if (row.prompt !== expectedPrompt) throw fail('Message changed on another device. Reload and review it before rewinding.', 409)
        const removed = db.prepare('SELECT COUNT(*) AS count FROM chat_requests WHERE bot_id=? AND seq>=?').get(botId, row.seq).count
        db.prepare('DELETE FROM chat_requests WHERE bot_id=? AND seq>=?').run(botId, row.seq)
        bump(botId)
        return { id, botId, prompt: row.prompt, removed }
      })
    },
    recoverInterrupted() {
      return transaction(() => {
        const rows = db.prepare("SELECT * FROM chat_requests WHERE status='running' ORDER BY seq").all()
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
      return db.prepare("SELECT * FROM chat_requests WHERE status='running' ORDER BY seq").all()
        .map(row => ({ ...requestValue(row), botId: row.bot_id }))
    },
    recentCompleted(botId, { limit = 20 } = {}) {
      identifier(botId, 'bot'); limitValue(limit)
      return db.prepare("SELECT * FROM chat_requests WHERE bot_id=? AND status='complete' ORDER BY seq DESC LIMIT ?")
        .all(botId, limit).reverse().map(requestValue)
    },
    completedCount(botId) {
      identifier(botId, 'bot')
      return db.prepare("SELECT COUNT(*) AS count FROM chat_requests WHERE bot_id=? AND status='complete'").get(botId).count
    },
    close: () => db.close(),
  }
}
