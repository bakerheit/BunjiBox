import { createHash } from 'node:crypto'
import { validId } from '@bunji/shared/bots'
import type { ChatRequest } from '@bunji/shared/types'
import { workspacePath } from './bot-store.ts'
import { openWorkspaceDatabase } from './sqlite.ts'

const HASH = /^[a-f0-9]{64}$/

/** A bot's durable Codex thread and the history hash it was built from. */
export interface CodexSessionRecord {
  threadId: string
  historyKey: string
  updatedAt: number
}

export interface CodexSessionStore {
  path: string
  get(botId: string): CodexSessionRecord | null
  /** Validates both fields; throws on an invalid bot ID, thread ID or history key. */
  set(botId: string, value: { threadId: unknown; historyKey: unknown } | null | undefined): CodexSessionRecord
  /** True when a mapping was removed. */
  delete(botId: string): boolean
  close(): void
}

type CodexSessionRow = {
  thread_id: string
  history_key: string
  updated_at: number
}

function botId(value: unknown): string {
  if (!validId(value)) throw new Error('Invalid Codex session bot ID.')
  return value
}

function threadId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /\p{Cc}/u.test(value)) throw new Error('Invalid Codex thread ID.')
  return value
}

function historyKey(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Invalid Codex session history key.')
  return value
}

/** The saved turn fields that feed the continuity hash. */
export type CodexHistoryTurn = Partial<Pick<ChatRequest, 'id' | 'status' | 'prompt' | 'text' | 'promptEditedAt' | 'responseEditedAt'>> | null

export function codexHistoryKey({ instructions, computer, turns }: { instructions: string; computer: unknown; turns: readonly CodexHistoryTurn[] | undefined }): string {
  const history = (Array.isArray(turns) ? turns : []).filter(turn => turn?.status === 'complete').map(turn => ({
    id: turn!.id,
    prompt: turn!.prompt,
    text: turn!.text,
    promptEditedAt: turn!.promptEditedAt ?? null,
    responseEditedAt: turn!.responseEditedAt ?? null,
  }))
  return createHash('sha256').update(JSON.stringify({ instructions, computer, history })).digest('hex')
}

export function openCodexSessionStore({ path = workspacePath() }: { path?: string } = {}): CodexSessionStore {
  const db = openWorkspaceDatabase(path, `CREATE TABLE IF NOT EXISTS codex_sessions (
        bot_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        history_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`)

  return {
    path,
    get(id) {
      const row = db.prepare('SELECT thread_id,history_key,updated_at FROM codex_sessions WHERE bot_id=?').get(botId(id)) as CodexSessionRow | undefined
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
