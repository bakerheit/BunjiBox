import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { defaultBots, makeBot, patchBot, legacyBot, validId } from '@bunji/shared/bots'
import { computerProfile, defaultComputerProfile, machineComputerProfile, storedComputerProfile } from '@bunji/shared/agent-permissions'

export const workspaceDirectory = () => process.env.BUNJI_DATA_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bunji')
export const workspacePath = () => join(workspaceDirectory(), 'workspace.sqlite')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const botFields = ['id', 'name', 'description', 'provider', 'model', 'effort', 'avatar', 'computer']
const patchFields = botFields.filter(field => field !== 'id')
const machineConfirmationRequired = () => { throw fail('Full-machine access must be enabled in Computer access settings.', 409) }
const folderConfirmationRequired = () => { throw fail('Folder access must be enabled in Computer access settings.', 409) }

// All writers (HTTP and local CLI) use short SQLite transactions. Never replace
// the whole collection from a client's stale snapshot.
export function openBotStore({ path = workspacePath(), legacyPath = join(dirname(path), 'config.json'), workspaceRoot = process.cwd() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, record TEXT NOT NULL, seed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS imports (source TEXT NOT NULL, legacy_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY(source, legacy_id));
    INSERT OR IGNORE INTO meta VALUES ('revision', 0);`)
  const revision = () => db.prepare("SELECT value FROM meta WHERE key='revision'").get().value
  const bump = () => db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run()
  const savedBot = record => {
    const bot = makeBot(record)
    return { ...bot, computer: storedComputerProfile(record.computer, { workspaceRoot }) }
  }
  const newBot = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !botFields.includes(key))) throw fail('Unknown bot setting.')
    const { computer, ...details } = value
    if (computer?.scope === 'machine') machineConfirmationRequired()
    if (computer?.scope === 'folder') folderConfirmationRequired()
    return { ...makeBot(details), computer: computer === undefined ? { ...defaultComputerProfile } : computerProfile(computer, { workspaceRoot }) }
  }
  const editedBot = (bot, changes) => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !patchFields.includes(key))) throw fail('Unknown bot setting.')
    const { computer, ...details } = changes
    if (computer?.scope === 'machine') machineConfirmationRequired()
    if (computer?.scope === 'folder') folderConfirmationRequired()
    return {
      ...patchBot(bot, details),
      computer: computer === undefined ? bot.computer : computerProfile(computer, { current: bot.computer, workspaceRoot }),
    }
  }
  const rows = () => db.prepare('SELECT record FROM bots ORDER BY rowid').all().map(row => savedBot(JSON.parse(row.record)))
  const snapshot = () => ({ revision: revision(), bots: rows() })
  const transaction = (action, write = true) => {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const put = (bot, seed = false) => db.prepare('INSERT INTO bots(id,record,seed) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record, seed=excluded.seed').run(bot.id, JSON.stringify(bot), seed ? 1 : 0)
  try {
    if (!db.prepare("SELECT 1 FROM meta WHERE key='initialized'").get()) {
      let legacy = null
      try {
        const saved = JSON.parse(readFileSync(legacyPath, 'utf8'))
        if (!Array.isArray(saved.bots) || !saved.bots.length) throw new Error('Invalid legacy bots')
        legacy = saved.bots.map(bot => ({ ...legacyBot(bot), computer: { ...defaultComputerProfile } }))
        if (new Set(legacy.map(bot => bot.id)).size !== legacy.length) throw new Error('Duplicate legacy bot IDs')
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Could not migrate ${legacyPath}. The original file has not been changed.`, { cause: error })
      }
      transaction(() => {
        if (db.prepare("SELECT 1 FROM meta WHERE key='initialized'").get()) return
        const defaults = defaultBots().map(bot => ({ ...bot, computer: { ...defaultComputerProfile } }))
        for (const bot of legacy || defaults) put(bot, same(bot, defaults.find(item => item.id === bot.id)))
        db.prepare("INSERT INTO meta VALUES ('initialized', 1)").run()
        bump()
      })
    }
  } catch (error) { db.close(); throw error }

  return {
    path,
    list: after => transaction(() => after === revision() ? null : snapshot(), false),
    create(value) {
      const bot = newBot(value)
      return transaction(() => {
        const current = db.prepare('SELECT record FROM bots WHERE id=?').get(bot.id)
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
      return transaction(() => {
        const row = db.prepare('SELECT record FROM bots WHERE id=?').get(id)
        if (!row) throw fail('Bot not found.', 404)
        const current = savedBot(JSON.parse(row.record)), next = editedBot(current, changes)
        if (!same(current, next)) { put(next); bump() }
        return snapshot()
      })
    },
    remove(id) {
      if (!validId(id)) throw fail('Invalid bot ID.')
      return transaction(() => {
        if (!db.prepare('SELECT 1 FROM bots WHERE id=?').get(id)) throw fail('Bot not found.', 404)
        if (db.prepare('SELECT COUNT(*) AS count FROM bots').get().count < 2) throw fail('Create another bot before deleting the last one.', 409)
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
      return transaction(() => {
        const row = db.prepare('SELECT record FROM bots WHERE id=?').get(id)
        if (!row) throw fail('Bot not found.', 404)
        const current = savedBot(JSON.parse(row.record)), next = { ...current, computer: profile }
        if (!same(current, next)) { put(next); bump() }
        return snapshot()
      })
    },
    confirmFolder(id, computer) {
      if (!validId(id)) throw fail('Invalid bot ID.')
      const profile = computerProfile(computer, { workspaceRoot, complete: true })
      if (profile.scope !== 'folder') throw fail('Folder confirmation requires folder scope.')
      return transaction(() => {
        const row = db.prepare('SELECT record FROM bots WHERE id=?').get(id)
        if (!row) throw fail('Bot not found.', 404)
        const current = savedBot(JSON.parse(row.record)), next = { ...current, computer: profile }
        if (!same(current, next)) { put(next); bump() }
        return snapshot()
      })
    },
    importLegacy({ source, bots }) {
      if (!validId(source) || !Array.isArray(bots) || bots.length > 100) throw fail('Invalid legacy bot import.')
      const incoming = bots.map(bot => ({ ...legacyBot(bot), computer: { ...defaultComputerProfile } }))
      if (new Set(incoming.map(bot => bot.id)).size !== incoming.length) throw fail('Duplicate import IDs.')
      return transaction(() => {
        const mapping = {}, defaults = defaultBots().map(bot => ({ ...bot, computer: { ...defaultComputerProfile } }))
        for (const bot of incoming) {
          const imported = db.prepare('SELECT bot_id FROM imports WHERE source=? AND legacy_id=?').get(source, bot.id)
          if (imported) { mapping[bot.id] = imported.bot_id; continue }
          const row = db.prepare('SELECT record,seed FROM bots WHERE id=?').get(bot.id)
          let id = bot.id
          if (!row) { put(bot); bump() }
          else if (!same(bot, savedBot(JSON.parse(row.record))) && !same(bot, defaults.find(item => item.id === id))) {
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
