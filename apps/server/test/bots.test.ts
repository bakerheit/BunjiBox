import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openBotStore } from '@bunji/core/bot-store'
import { defaultBots, cliBot } from '@bunji/shared/bots'
import { BotClient } from '@bunji/shared/bot-client'
import { BunjiSession } from '@bunji/cli/session'
import { createBotRoutes } from '../src/routes/bots.ts'
import { botTransport, readLegacyBots } from '@bunji/shared/bot-api'
import { createServer as createViteServer } from 'vite'
import viteConfig from '@bunji/app/vite.config'

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bunji-shared-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function fixture(t) {
  const dir = await directory(t), path = join(dir, 'workspace.sqlite')
  const store = openBotStore({ path })
  t.after(() => store.close())
  return { dir, path, store }
}

test('migrates CLI bots once, including avatar/model settings, without changing the old file', async t => {
  const dir = await directory(t), path = join(dir, 'workspace.sqlite'), legacyPath = join(dir, 'config.json')
  const old = JSON.stringify({ bots: [{ id: 'lemon', name: 'Lemon', description: '', color: 'yellow', shape: '⬡', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' }] })
  await writeFile(legacyPath, old)
  let store = openBotStore({ path })
  assert.equal(store.list().bots[0].avatar.color, '#ff9c00')
  store.patch('lemon', { name: 'Shared Lemon' })
  store.close()
  store = openBotStore({ path }); t.after(() => store.close())
  assert.equal(store.list().bots[0].name, 'Shared Lemon')
  assert.equal(store.list().bots[0].model, 'gpt-5.6-luna')
  assert.equal(await readFile(legacyPath, 'utf8'), old)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('corrupt legacy settings stop migration instead of silently replacing bots', async t => {
  const dir = await directory(t)
  await writeFile(join(dir, 'config.json'), '{broken')
  assert.throws(() => openBotStore({ path: join(dir, 'workspace.sqlite') }), /original file has not been changed/)
  assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), '{broken')
})

test('browser imports are idempotent and conflicting customizations are recovered, not overwritten', async t => {
  const { store } = await fixture(t)
  const original = { ...defaultBots()[0], name: 'Desktop bot' }
  store.importLegacy({ source: 'desktop', bots: [original] })
  assert.equal(store.list().bots[0].name, 'Desktop bot')
  const phone = { ...original, name: 'Phone bot', avatar: { shape: 'drop', color: '#ee1734', image: 'data:image/png;base64,aGVsbG8=' } }
  const imported = store.importLegacy({ source: 'phone', bots: [phone] })
  const id = imported.mapping.bunjibox
  assert.notEqual(id, 'bunjibox')
  assert.equal(imported.bots.find(bot => bot.id === id).name, 'Phone bot (recovered)')
  assert.equal(imported.bots.find(bot => bot.id === id).avatar.image, phone.avatar.image)
  store.patch(id, { description: 'Keep newer edits' })
  store.importLegacy({ source: 'phone', bots: [phone] })
  store.importLegacy({ source: 'same-phone-copy', bots: [phone] })
  assert.equal(store.list().bots.length, 3)
  assert.equal(store.list().bots.find(bot => bot.id === id).description, 'Keep newer edits')
  store.importLegacy({ source: 'fresh-browser', bots: defaultBots() })
  assert.equal(store.list().bots[0].name, 'Desktop bot', 'untouched defaults never overwrite customized bots')
})

test('field edits and avatars merge across independent connections; invalid data never commits', async t => {
  const { store, path } = await fixture(t)
  const cli = openBotStore({ path }); t.after(() => cli.close())
  const revision = store.list().revision
  cli.patch('bunjibox', { name: 'One shared bot' })
  store.patch('bunjibox', { description: 'From phone', avatar: { shape: 'cloud' } })
  cli.patch('bunjibox', { avatar: { color: '#ff6a00' } })
  const bot = store.list().bots[0]
  assert.equal(bot.name, 'One shared bot')
  assert.equal(bot.description, 'From phone')
  assert.equal(bot.avatar.shape, 'cloud')
  assert.equal(bot.avatar.color, '#ff6a00')
  assert.ok(store.list().revision > revision)
  assert.equal(store.list(store.list().revision), null)
  assert.throws(() => store.patch('bunjibox', { avatar: { image: 'https://tracker.example/image' } }), /Avatar must/)
  assert.throws(() => store.patch('bunjibox', { id: 'replace-id' }), /Unknown/)
  assert.throws(() => store.patch('bunjibox', { provider: 'bad-provider' }), /provider/)
  assert.throws(() => store.patch('bunjibox', { name: 'x'.repeat(61) }), /Name/)
  assert.deepEqual(store.list().bots[0], bot)
})

test('simultaneous CLI processes keep every created bot', async t => {
  const { store, path } = await fixture(t)
  const module = import.meta.resolve('@bunji/core/bot-store')
  await Promise.all(Array.from({ length: 3 }, (_, worker) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import {openBotStore} from ${JSON.stringify(module)}; const s=openBotStore({path:process.argv[1]}); for(let i=0;i<5;i++)s.create({id:'worker-'+process.argv[2]+'-'+i,name:'Worker bot'}); s.close();`, path, String(worker)])))
  assert.equal(store.list().bots.length, 17)
})

test('optimistic edits survive a failed save and refresh, then retry only changed fields', async t => {
  const { store } = await fixture(t)
  let fail = true
  const client = new BotClient({ ...store, patch(id, value) { if (fail) throw new Error('Offline'); return store.patch(id, value) } }, { delay: 10000 })
  t.after(() => client.stop())
  await client.initialize()
  client.update('bunjibox', { name: 'Unsaved name' })
  await client.flush()
  assert.equal(client.getSnapshot().pending, true)
  assert.match(client.getSnapshot().error, /Not saved/)
  store.patch('bunjibox', { description: 'Changed from another device' })
  await client.sync()
  assert.equal(client.getSnapshot().bots[0].name, 'Unsaved name')
  assert.equal(client.getSnapshot().bots[0].description, 'Changed from another device')
  fail = false; await client.flush()
  assert.equal(client.getSnapshot().pending, false)
  assert.equal(store.list().bots[0].name, 'Unsaved name')
  assert.equal(store.list().bots[0].description, 'Changed from another device')
})

test('edits during a save are not lost; creation plus model changes normalize before saving', async t => {
  const { store } = await fixture(t)
  let release, calls = 0
  const client = new BotClient({ ...store, async patch(id, changes) { if (!calls++) await new Promise(resolve => { release = resolve }); return store.patch(id, changes) } }, { delay: 10000 })
  t.after(() => client.stop()); await client.initialize()
  client.update('bunjibox', { name: 'A' })
  const saving = client.flush()
  client.update('bunjibox', { name: 'AB' })
  release(); await saving
  assert.equal(store.list().bots[0].name, 'AB')
  client.create({ id: 'new-bot', name: 'New bot', effort: 'ultra' })
  client.update('new-bot', { provider: 'claude', model: 'haiku' })
  await client.flush()
  assert.equal(store.list().bots.at(-1).model, 'haiku')
  assert.equal(store.list().bots.at(-1).effort, 'medium')
})

test('HTTP browser clients and CLI share bots live while CLI chat state stays intact', async t => {
  const { store, path } = await fixture(t)
  const route = createBotRoutes(store)
  const server = http.createServer((request, response) => void route(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const transport = botTransport((url, init) => fetch(origin + url, init))
  const phone = new BotClient(transport, { delay: 10000 }), desktop = new BotClient(transport, { delay: 10000 })
  const local = openBotStore({ path }), cli = new BotClient(local, { delay: 10000 })
  t.after(() => { phone.stop(); desktop.stop(); cli.stop(); local.close() })
  await Promise.all([phone.initialize(), desktop.initialize(), cli.initialize()])
  const session = new BunjiSession({ bots: cli.getSnapshot().bots.map(cliBot), botClient: cli, run: async () => ({ ok: true, text: 'Remembered.' }) })
  t.after(() => session.unsubscribeBots())
  await session.send('keep this message')
  phone.update('bunjibox', { name: 'Shared agent', avatar: { shape: 'drop', color: '#e82692' } })
  await phone.flush(); await desktop.sync(); await cli.sync()
  assert.equal(desktop.getSnapshot().bots[0].name, 'Shared agent')
  assert.equal(session.bot.name, 'Shared agent')
  assert.equal(session.bot.color, '#e82692')
  assert.equal(session.requests[0].prompt, 'keep this message')
  session.addBot('Made in CLI'); await cli.flush(); await phone.sync()
  assert.equal(phone.getSnapshot().bots.at(-1).name, 'Made in CLI')
  session.update({ color: 'yellow', shape: '▲', model: 'gpt-5.6-luna', effort: 'low' })
  await cli.flush(); await desktop.sync()
  assert.equal(desktop.getSnapshot().bots.at(-1).avatar.shape, 'triangle')
  assert.equal(desktop.getSnapshot().bots.at(-1).avatar.color, '#ff9c00')
  const response = await fetch(origin + '/api/bots', { headers: { 'if-none-match': `"bots-${store.list().revision}"` } })
  assert.equal(response.status, 304)
  const rejected = await fetch(origin + '/api/bots', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(rejected.status, 403)
})

test('browser migration reads bots and uploaded avatars without destroying local backups', () => {
  const data = new Map([['bunjibox.bots', JSON.stringify([{ id: 'custom', name: 'Custom', tone: 'old-tone' }])], ['bunjibox.avatars', JSON.stringify({ 'old-tone': { shape: 'circle', color: '#ffffff', image: '/teal-bot.png' } })]])
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const old = data.get('bunjibox.bots')
  const first = readLegacyBots(storage), second = readLegacyBots(storage)
  assert.equal(first.source, second.source)
  assert.equal(first.bots[0].avatar.image, '/teal-bot.png')
  assert.equal(data.get('bunjibox.bots'), old)
})

test('Vite proxy preserves the browser host for same-origin saves and still rejects foreign origins', async t => {
  const { store } = await fixture(t)
  const route = createBotRoutes(store)
  const api = http.createServer((request, response) => void route(request, response))
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => api.close(resolve)))
  const target = `http://127.0.0.1:${api.address().port}`
  const vite = await createViteServer({ configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, proxy: { '/api': { ...viteConfig.server.proxy['/api'], target } } }, optimizeDeps: { noDiscovery: true, include: [] } })
  await vite.listen(); t.after(() => vite.close())
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  const write = from => fetch(origin + '/api/bots/bunjibox', { method: 'PATCH', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Saved through Vite' }) })
  assert.equal((await write(origin)).status, 200)
  assert.equal(store.list().bots[0].name, 'Saved through Vite')
  assert.equal((await write('https://untrusted.example')).status, 403)
})
