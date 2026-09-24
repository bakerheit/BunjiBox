import { BotClient } from './bot-client.ts'
import type { BotTransport } from './bot-client.ts'
import type { BotsSnapshot, LegacyBotImport } from './types.ts'

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export function botTransport(fetcher: Fetcher = fetch): BotTransport {
  const request = async <T = BotsSnapshot>(path = '', options: RequestInit = {}, timeoutMs = 10000): Promise<T | null> => {
    let response: Response
    try { response = await fetcher('/api/bots' + path, { cache: 'no-store', ...options, signal: AbortSignal.timeout(timeoutMs) }) }
    catch { throw new Error('Cannot reach BunjiBox. Check the connection to your Mac.') }
    if (response.status === 304) return null
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error || 'Could not save bot settings.')
    return result as T
  }
  // Only list() can answer 304; every write returns a fresh snapshot.
  const write = async (path: string, method: string, value: unknown, timeoutMs?: number) =>
    (await request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }, timeoutMs))!
  return {
    list: revision => request('', { headers: revision !== undefined && revision >= 0 ? { 'if-none-match': `"bots-${revision}"` } : {} }),
    create: bot => write('', 'POST', bot),
    patch: (id, changes) => write('/' + encodeURIComponent(id), 'PATCH', changes),
    remove: (id, options) => write('/' + encodeURIComponent(id), 'DELETE', options, 120000),
    importLegacy: data => write('/import', 'POST', data),
  }
}

// Read-only migration of old browser settings. Leave the old keys intact as a
// recovery copy; the server records import receipts to prevent repeat imports.
export function readLegacyBots(storage: Storage): LegacyBotImport | null {
  const raw = storage.getItem('bunjibox.bots')
  const avatars = JSON.parse(storage.getItem('bunjibox.avatars') || '{}') as Record<string, unknown>
  if (!raw && !Object.keys(avatars).length) return null
  let bots: unknown = raw ? JSON.parse(raw) : [
    { id: 'bunjibox', name: 'BunjiBox', description: '', tone: 'cyan' },
    { id: 'scout', name: 'Scout', description: 'Research and compare tools. Cite sources and keep findings concise.', tone: 'violet' },
  ]
  if (!Array.isArray(bots)) throw new Error('Old browser bot settings are invalid. They have not been removed.')
  let source = storage.getItem('bunjibox.import-source')
  if (!source) { source = 'browser-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); storage.setItem('bunjibox.import-source', source) }
  bots = bots.map((bot: Record<string, unknown>) => {
    const key = String(bot.tone || bot.id)
    return { ...bot, ...(avatars[key] ? { avatar: avatars[key] } : {}) }
  })
  return { source, bots: bots as unknown[] }
}

export function createBrowserBotClient(storage: Storage = localStorage): BotClient {
  let legacy = null, migrationError = ''
  try { legacy = readLegacyBots(storage) } catch { migrationError = 'Could not import old browser settings. They are still stored on this device.' }
  const client = new BotClient(botTransport(), { legacy })
  client.migrationError = migrationError
  return client
}
