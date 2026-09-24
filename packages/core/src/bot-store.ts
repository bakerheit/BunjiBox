import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { defaultBots, makeBot, patchBot, legacyBot, validId } from '@bunji/shared/bots'
import { errorCode, fail } from '@bunji/shared/errors'
import type { Bot, BotsSnapshot, ComputerProfile } from '@bunji/shared/types'
import { computerProfile, defaultComputerProfile, machineComputerProfile, storedComputerProfile } from './agent-permissions.ts'
import { openWorkspaceDatabase, transaction } from './sqlite.ts'

export const workspaceDirectory = (): string => process.env.BUNJI_DATA_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bunji')
export const workspacePath = (): string => join(workspaceDirectory(), 'workspace.sqlite')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const botFields = ['id', 'name', 'description', 'provider', 'model', 'effort', 'mode', 'avatar', 'computer', 'nativeComputer']
const patchFields = botFields.filter(field => field !== 'id')
const machineConfirmationRequired = (): never => { throw fail('Full-machine access must be enabled in Computer access settings.', 409) }
const folderConfirmationRequired = (): never => { throw fail('Folder access must be enabled in Computer access settings.', 409) }

export interface BotStoreOptions {
  path?: string
  /** The pre-SQLite config.json whose bots seed a new workspace. */
  legacyPath?: string
  /** Computer folders may not be this directory. */
  workspaceRoot?: string
}

/** A legacy import result: old browser IDs mapped to saved IDs. */
export type BotImportSnapshot = BotsSnapshot & { mapping: Record<string, string> }

/**
 * Saved bots. Every method is synchronous and returns a fresh snapshot; errors
 * carry an HTTP `status`. Inputs are validated here, so they are typed loosely.
 */
export interface BotStore {
  path: string
  list(): BotsSnapshot
  /** Null when `after` is already the current revision. */
  list(after?: number | null): BotsSnapshot | null
  create(value: unknown): BotsSnapshot
  patch(id: string, changes: unknown): BotsSnapshot
  remove(id: string): BotsSnapshot
  /** Grants full-machine access. Only confirmation routes may call this. */
  confirmMachine(id: string, computer: unknown): BotsSnapshot
  /** Grants folder access. Only confirmation routes may call this. */
  confirmFolder(id: string, computer: unknown): BotsSnapshot
  importLegacy(value: { source?: unknown; bots?: unknown }): BotImportSnapshot
  close(): void
}

type RecordRow = { record: string }
type SeededRecordRow = { record: string; seed: number }

// All writers (HTTP and local CLI) use short SQLite transactions. Never replace
// the whole collection from a client's stale snapshot.
export function openBotStore({ path = workspacePath(), legacyPath = join(dirname(path), 'config.json'), workspaceRoot = process.cwd() }: BotStoreOptions = {}): BotStore {
  const db = openWorkspaceDatabase(path, `
    CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, record TEXT NOT NULL, seed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (source TEXT NOT NULL, legacy_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY(source, legacy_id));
    INSERT OR IGNORE INTO meta VALUES ('revision', 0);`)
  const revision = () => (db.prepare("SELECT value FROM meta WHERE key='revision'").get() as { value: number }).value
  const bump = () => db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run()
  const savedBot = (record: Record<string, unknown>): Bot => {
    const bot = makeBot(record)
    return { ...bot, computer: storedComputerProfile(record.computer, { workspaceRoot }) }
  }
  const newBot = (value: unknown): Bot => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !botFields.includes(key))) throw fail('Unknown bot setting.')
    const { computer, ...details } = value as { computer?: Partial<ComputerProfile>; nativeComputer?: unknown }
    if (details.nativeComputer && details.nativeComputer !== 'off') throw fail('Enable native control after confirming full-machine access.', 409)
    if (computer?.scope === 'machine') machineConfirmationRequired()
    if (computer?.scope === 'folder') folderConfirmationRequired()
    return { ...makeBot(details), computer: computer === undefined ? { ...defaultComputerProfile } : computerProfile(computer, { workspaceRoot }) }
  }
  const editedBot = (bot: Bot, changes: unknown): Bot => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !patchFields.includes(key))) throw fail('Unknown bot setting.')
    const { computer, ...details } = changes as { computer?: Partial<ComputerProfile>; nativeComputer?: unknown; provider?: unknown }
    if (details.nativeComputer && details.nativeComputer !== 'off' &&
        (bot.computer.scope !== 'machine' || bot.computer.level !== 'auto' ||
         !['codex', 'claude'].includes((details.provider ?? bot.provider) as string) || computer)) {
      throw fail('Native control requires saved full-machine access and Codex or Claude.', 409)
    }
    if (computer?.scope === 'machine') machineConfirmationRequired()
    if (computer?.scope === 'folder') folderConfirmationRequired()
    return {
      ...patchBot(bot, details),
      computer: computer === undefined ? bot.computer : computerProfile(computer, { current: bot.computer, workspaceRoot }),
    }
  }
  const rows = () => (db.prepare('SELECT record FROM bots ORDER BY rowid').all() as RecordRow[]).map(row => savedBot(JSON.parse(row.record) as Record<string, unknown>))
  const snapshot = (): BotsSnapshot => ({ revision: revision(), bots: rows() })
  const put = (bot: Bot, seed = false) => db.prepare('INSERT INTO bots(id,record,seed) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record, seed=excluded.seed').run(bot.id, JSON.stringify(bot), seed ? 1 : 0)
  const recordFor = (id: string) => db.prepare('SELECT record FROM bots WHERE id=?').get(id) as RecordRow | undefined
  try {
    if (!db.prepare("SELECT 1 FROM meta WHERE key='initialized'").get()) {
      let legacy: Bot[] | null = null
      try {
        const saved = JSON.parse(readFileSync(legacyPath, 'utf8')) as { bots?: unknown }
        if (!Array.isArray(saved.bots) || !saved.bots.length) throw new Error('Invalid legacy bots')
        legacy = saved.bots.map(bot => ({ ...legacyBot(bot), computer: { ...defaultComputerProfile } }))
        if (new Set(legacy.map(bot => bot.id)).size !== legacy.length) throw new Error('Duplicate legacy bot IDs')
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new Error(`Could not migrate ${legacyPath}. The original file has not been changed.`, { cause: error })
      }
      transaction(db, () => {
        if (db.prepare("SELECT 1 FROM meta WHERE key='initialized'").get()) return
        const defaults = defaultBots().map(bot => ({ ...bot, computer: { ...defaultComputerProfile } }))
        for (const bot of legacy || defaults) put(bot, same(bot, defaults.find(item => item.id === bot.id)))
        db.prepare("INSERT INTO meta VALUES ('initialized', 1)").run()
        bump()
      })
    }
  } catch (error) { db.close(); throw error }

  function list(): BotsSnapshot
  function list(after?: number | null): BotsSnapshot | null
  function list(after?: number | null): BotsSnapshot | null {
    return transaction(db, () => after === revision() ? null : snapshot(), { write: false })
  }

  return {
    path,
    list,
    create(value) {
      const bot = newBot(value)
      return transaction(db, () => {
        const current = recordFor(bot.id)
        if (current) {
          if (same(JSON.parse(current.record), bot)) return snapshot() // Safe retry after a lost response.
          throw fail('That bot ID is already in use.', 409)
        }
        if (rows().length >= 500) throw fail('This workspace has reached its 500-bot limit.')
        put(bot); bump(); return snapshot()
      })
    },
    patch(id, changes) {
      if (!validId(id)) throw fail('Invalid bot ID.')
      return transaction(db, () => {
        const row = recordFor(id)
        if (!row) throw fail('Bot not found.', 404)
        const current = savedBot(JSON.parse(row.record) as Record<string, unknown>), next = editedBot(current, changes)
        if (!same(current, next)) { put(next); bump() }
        return snapshot()
      })
    },
    remove(id) {
      if (!validId(id)) throw fail('Invalid bot ID.')
      return transaction(db, () => {
        if (!db.prepare('SELECT 1 FROM bots WHERE id=?').get(id)) throw fail('Bot not found.', 404)
        if ((db.prepare('SELECT COUNT(*) AS count FROM bots').get() as { count: number }).count < 2) throw fail('Create another bot before deleting the last one.', 409)
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_requests'").get()) {
          if (db.prepare("SELECT 1 FROM chat_requests WHERE bot_id=? AND status='running'").get(id)) throw fail('Wait for this bot’s running request to finish before deleting it.', 409)
          db.prepare('DELETE FROM chat_requests WHERE bot_id=?').run(id)
          db.prepare('DELETE FROM chat_revisions WHERE bot_id=?').run(id)
        }
        // Keep import receipts as tombstones so an older browser's legacy
        // localStorage snapshot cannot bring a deleted bot back.
        db.prepare('DELETE FROM bots WHERE id=?').run(id)
        bump()
        return snapshot()
      })
    },
    confirmMachine(id, computer) {
      if (!validId(id)) throw fail('Invalid bot ID.')
      const profile = machineComputerProfile(computer, { workspaceRoot })
      return transaction(db, () => {
        const row = recordFor(id)
        if (!row) throw fail('Bot not found.', 404)
        const current = savedBot(JSON.parse(row.record) as Record<string, unknown>), next = { ...current, computer: profile }
        if (!same(current, next)) { put(next); bump() }
        return snapshot()
      })
    },
    confirmFolder(id, computer) {
      if (!validId(id)) throw fail('Invalid bot ID.')
      const profile = computerProfile(computer, { workspaceRoot, complete: true })
      if (profile.scope !== 'folder') throw fail('Folder confirmation requires folder scope.')
      return transaction(db, () => {
        const row = recordFor(id)
        if (!row) throw fail('Bot not found.', 404)
        const current = savedBot(JSON.parse(row.record) as Record<string, unknown>), next = { ...current, computer: profile }
        if (!same(current, next)) { put(next); bump() }
        return snapshot()
      })
    },
    importLegacy({ source, bots }) {
      if (!validId(source) || !Array.isArray(bots) || bots.length > 100) throw fail('Invalid legacy bot import.')
      const incoming = bots.map(bot => ({ ...legacyBot(bot), computer: { ...defaultComputerProfile } }))
      if (new Set(incoming.map(bot => bot.id)).size !== incoming.length) throw fail('Duplicate import IDs.')
      return transaction(db, () => {
        const mapping: Record<string, string> = {}, defaults = defaultBots().map(bot => ({ ...bot, computer: { ...defaultComputerProfile } }))
        for (const bot of incoming) {
          const imported = db.prepare('SELECT bot_id FROM imports WHERE source=? AND legacy_id=?').get(source, bot.id) as { bot_id: string } | undefined
          if (imported) { mapping[bot.id] = imported.bot_id; continue }
          const row = db.prepare('SELECT record,seed FROM bots WHERE id=?').get(bot.id) as SeededRecordRow | undefined
          let id = bot.id
          if (!row) { put(bot); bump() }
          else if (!same(bot, savedBot(JSON.parse(row.record) as Record<string, unknown>)) && !same(bot, defaults.find(item => item.id === id))) {
            if (row.seed) { put(bot); bump() }
            else {
              // Content-based recovery IDs deduplicate identical old copies from
              // different devices, without replacing a current bot's settings.
              id = 'recovered-' + createHash('sha256').update(JSON.stringify(bot)).digest('hex').slice(0, 32)
              if (!db.prepare('SELECT 1 FROM bots WHERE id=?').get(id)) { put({ ...bot, id, name: (bot.name.slice(0, 48) + ' (recovered)').slice(0, 60) }); bump() }
            }
          }
          mapping[bot.id] = id
          db.prepare('INSERT INTO imports VALUES(?,?,?)').run(source, bot.id, id)
        }
        if (rows().length > 500) throw fail('Too many imported bots.')
        return { ...snapshot(), mapping }
      })
    },
    close: () => db.close(),
  }
}
