import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { validId } from '@bunji/shared/bots'
import { workspacePath } from './bot-store.mjs'

const HASH = /^[a-f0-9]{64}$/

function botId(value) {
  if (!validId(value)) throw new Error('Invalid Codex session bot ID.')
  return value
}

function threadId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /\p{Cc}/u.test(value)) throw new Error('Invalid Codex thread ID.')
  return value
}

function historyKey(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Invalid Codex session history key.')
  return value
}

export function codexHistoryKey({ instructions, computer, turns }) {
  const history = (Array.isArray(turns) ? turns : []).filter(turn => turn?.status === 'complete').map(turn => ({
    id: turn.id,
    prompt: turn.prompt,
    text: turn.text,
    promptEditedAt: turn.promptEditedAt ?? null,
    responseEditedAt: turn.responseEditedAt ?? null,
  }))
  return createHash('sha256').update(JSON.stringify({ instructions, computer, history })).digest('hex')
}

export function openCodexSessionStore({ path = workspacePath() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  try {
    if (path !== ':memory:') chmodSync(path, 0o600)
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS codex_sessions (
        bot_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        history_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`)
  } catch (error) { db.close(); throw error }

  return {
    path,
    get(id) {
      const row = db.prepare('SELECT thread_id,history_key,updated_at FROM codex_sessions WHERE bot_id=?').get(botId(id))
      return row ? { threadId: row.thread_id, historyKey: row.history_key, updatedAt: row.updated_at } : null
    },
    set(id, value) {
      const record = { threadId: threadId(value?.threadId), historyKey: historyKey(value?.historyKey), updatedAt: Date.now() }
      db.prepare(`INSERT INTO codex_sessions(bot_id,thread_id,history_key,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET thread_id=excluded.thread_id,history_key=excluded.history_key,updated_at=excluded.updated_at`)
        .run(botId(id), record.threadId, record.historyKey, record.updatedAt)
      return record
    },
    delete(id) { return db.prepare('DELETE FROM codex_sessions WHERE bot_id=?').run(botId(id)).changes > 0 },
    close() { db.close() },
  }
}
