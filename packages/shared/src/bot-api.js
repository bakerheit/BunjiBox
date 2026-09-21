import { BotClient } from './bot-client.js'

export function botTransport(fetcher = fetch) {
  const request = async (path = '', options = {}, timeoutMs = 10000) => {
    let response
    try { response = await fetcher('/api/bots' + path, { cache: 'no-store', ...options, signal: AbortSignal.timeout(timeoutMs) }) }
    catch { throw new Error('Cannot reach BunjiBox. Check the connection to your Mac.') }
    if (response.status === 304) return null
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not save bot settings.')
    return result
  }
  const write = (path, method, value) => request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  return {
    list: revision => request('', { headers: revision >= 0 ? { 'if-none-match': `"bots-${revision}"` } : {} }),
    create: bot => write('', 'POST', bot),
    patch: (id, changes) => write('/' + encodeURIComponent(id), 'PATCH', changes),
    remove: (id, options) => request('/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) }, 120000),
    importLegacy: data => write('/import', 'POST', data),
  }
}

// Read-only migration of old browser settings. Leave the old keys intact as a
// recovery copy; the server records import receipts to prevent repeat imports.
export function readLegacyBots(storage) {
  const raw = storage.getItem('bunjibox.bots')
  const avatars = JSON.parse(storage.getItem('bunjibox.avatars') || '{}')
  if (!raw && !Object.keys(avatars).length) return null
  let bots = raw ? JSON.parse(raw) : [
    { id: 'bunjibox', name: 'BunjiBox', description: '', tone: 'cyan' },
    { id: 'scout', name: 'Scout', description: 'Research and compare tools. Cite sources and keep findings concise.', tone: 'violet' },
  ]
  if (!Array.isArray(bots)) throw new Error('Old browser bot settings are invalid. They have not been removed.')
  let source = storage.getItem('bunjibox.import-source')
  if (!source) { source = 'browser-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); storage.setItem('bunjibox.import-source', source) }
  bots = bots.map(bot => ({ ...bot, ...(avatars[bot.tone || bot.id] ? { avatar: avatars[bot.tone || bot.id] } : {}) }))
  return { source, bots }
}

export function createBrowserBotClient(storage = localStorage) {
  let legacy = null, migrationError = ''
  try { legacy = readLegacyBots(storage) } catch { migrationError = 'Could not import old browser settings. They are still stored on this device.' }
  const client = new BotClient(botTransport(), { legacy })
  client.migrationError = migrationError
  return client
}
