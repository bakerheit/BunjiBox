import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultBots } from './session.mjs'
import { normalizeRuntime } from '../core/runtime.mjs'
import { safeText } from './format.mjs'
import { cliBot, legacyBot } from '../shared/bots.js'

// Legacy file helpers retained for migration/recovery. Live clients now use
// core/bot-store.mjs; never save a live workspace through this old snapshot file.

export const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bunji', 'config.json')
export const colors = ['cyan', 'blue', 'magenta', 'green', 'yellow', 'red', 'white']
export const shapes = { hexagon: '⬡', circle: '●', square: '■', diamond: '◆', triangle: '▲' }

export async function loadBots(path = configPath()) {
  try {
    const config = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(config.bots) || !config.bots.length) throw new Error('No saved bots')
    const ids = new Set()
    return config.bots.slice(0, 100).map(bot => {
      if (!bot || typeof bot.id !== 'string' || !bot.id || ids.has(bot.id) || typeof bot.name !== 'string') throw new Error('Invalid bot settings')
      ids.add(bot.id)
      return cliBot(legacyBot({ ...bot, name: safeText(bot.name).slice(0, 60), description: safeText(bot.description).slice(0, 1800), ...normalizeRuntime(bot) }))
    })
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read ${path}. Fix or move this file before starting Bunji.`, { cause: error })
    return defaultBots()
  }
}

export async function saveBots(bots, path = configPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, bots }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}
