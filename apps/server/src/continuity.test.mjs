import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { openBotStore } from '@bunji/core/bot-store'
import { openChatStore } from '@bunji/core/chat-store'
import { openMemoryStore } from '@bunji/core/memory-store'
import { createChatService } from '@bunji/core/chat-service'
import { createContinuityRoutes } from './continuity.mjs'
import { createBotRoutes } from './bots.mjs'
import { buildContext } from '@bunji/core/context'
import { createMemoryServer } from '@bunji/core/memory-mcp'
import { providerCommand } from '@bunji/core/runtime'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const settings = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' }
async function fixture(t, run) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'bunji-continuity-test-'))
  const path = join(dir, 'workspace.sqlite'), bots = openBotStore({ path }), chats = openChatStore({ path })
  const memory = openMemoryStore({ directory: join(dir, 'memory') })
  const service = createChatService({ bots, chats, memoryDirectory: memory.directory, memory, run })
  t.after(async () => { await service.close(); chats.close(); bots.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, path, bots, chats, memory, service }
}
test('full-Mac requests and memory writes work from any same-origin device', async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return { ok: true, text: 'done' } })
  f.bots.confirmMachine('bunjibox', { scope: 'machine', level: 'auto', network: 'off' })
  const route = createContinuityRoutes(f)
  const server = http.createServer((request, response) => void route(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}/api/bots/bunjibox/messages`
  const send = id => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, prompt: 'Run pwd', ...settings }) })
  const memoryEndpoint = `http://127.0.0.1:${server.address().port}/api/bots/bunjibox/memory`
  const memoryWrite = () => fetch(memoryEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Reminder', body: 'Use BunjiBox' }) })
  assert.equal((await memoryWrite()).status, 200)
  assert.equal((await send('device-one')).status, 202)
  assert.equal((await done(f.chats, 'device-one')).status, 'complete')
  assert.equal(calls, 1)
})
async function done(chats, id) {
  for (let i = 0; i < 100; i++) { const request = chats.get(id); if (request?.status !== 'running') return request; await delay(5) }
  throw new Error('Test run did not finish')
}
test('service persists before acknowledgement, owns disconnected runs, and retries never rerun', async t => {
  let release, calls = 0, observed
  const f = await fixture(t, async (options, hooks) => {
    calls++; observed = { options, hooks }
    assert.equal(f.chats.get('one').status, 'running')
    hooks.onActivity({ id: 'tool1', kind: 'tool', title: 'memory_search', status: 'running' })
    await new Promise(resolve => { release = resolve })
    return { ok: true, text: 'Saved reply', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, activities: [{ id: 'tool1', status: 'complete' }] }
  })
  const handler = createContinuityRoutes(f)
  const server = http.createServer((req, res) => void handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const body = { id: 'one', prompt: 'Remember my preferred tea', ...settings }
  const response = await fetch(base + '/api/bots/bunjibox/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(response.status, 202)
  assert.equal((await response.json()).request.prompt, body.prompt)
  assert.equal((await (await fetch(base + '/api/bots/bunjibox/history')).json()).requests[0].activities[0].title, 'memory_search')
  assert.equal(observed.hooks.signal.aborted, false, 'acknowledged response closing is not cancellation')
  assert.equal(observed.hooks.memory.allowWrites, true)
  assert.equal(observed.hooks.memory.botId, 'bunjibox')
  assert.equal(f.service.start('bunjibox', body).created, false)
  assert.throws(() => f.service.start('bunjibox', { ...body, id: 'two' }), error => error.status === 409)
  release(); assert.equal((await done(f.chats, 'one')).status, 'complete')
  assert.equal(f.service.start('bunjibox', body).created, false)
  assert.equal(calls, 1)
  assert.equal(f.chats.history('bunjibox').requests[0].usage.totalTokens, 12)
  const reopened = openChatStore({ path: f.path }); t.after(() => reopened.close())
  assert.equal(reopened.history('bunjibox').requests[0].text, 'Saved reply')
})
test('cancellation preserves reported usage, different providers share context, bot scopes stay separate', async t => {
  let seen
  const f = await fixture(t, async (options, hooks) => {
    seen = options
    if (hooks.requestId === 'cancel-me') {
      await new Promise(resolve => hooks.signal.addEventListener('abort', resolve, { once: true }))
      return { ok: false, text: 'partial', usage: { totalTokens: 9 } }
    }
    return { ok: true, text: 'Green tea is preferred.' }
  })
  f.service.start('bunjibox', { id: 'first', prompt: 'I like green tea', ...settings, memoryWrite: false }); await done(f.chats, 'first')
  assert.equal(f.chats.get('first').memoryWrite, true, 'older clients cannot disable normal memory access')
  f.service.start('bunjibox', { id: 'next', prompt: 'What tea?', provider: 'claude', model: 'haiku', effort: 'low' }); await done(f.chats, 'next')
  assert.match(seen.prompt, /Green tea is preferred/)
  assert.equal(f.chats.get('next').contextTurns, 1)
  assert.equal(f.chats.get('next').memoryWrite, true)
  f.service.start('scout', { id: 'isolated', prompt: 'Hello', ...settings }); await done(f.chats, 'isolated')
  assert.doesNotMatch(seen.prompt, /Green tea is preferred/)
  f.service.start('bunjibox', { id: 'cancel-me', prompt: 'Wait', ...settings }); await delay(5)
  f.service.cancel('cancel-me')
  const cancelled = await done(f.chats, 'cancel-me')
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.text, 'partial'); assert.equal(cancelled.usage.totalTokens, 9)
})
test('memory API rejects foreign writes and stale edits, preserves provenance on manual edits', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: 'ok' }))
  const route = createContinuityRoutes(f), server = http.createServer((req, res) => void route(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body, method = 'POST', origin) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  assert.equal((await post('/api/bots/bunjibox/memory', { title: 'No', body: 'no' }, 'POST', 'http://evil.test')).status, 403)
  const note = await f.memory.write('bunjibox', { title: 'Tea', body: 'Green tea', sourceMessageIds: ['source-one'] })
  const edit = await post('/api/bots/bunjibox/memory/' + note.id, { title: 'Tea updated', body: 'Green tea only', expectedRevision: note.revision }, 'PATCH')
  assert.equal(edit.status, 200); assert.deepEqual((await edit.json()).note.sourceMessageIds, ['source-one'])
  assert.equal((await post('/api/bots/bunjibox/memory/' + note.id, { title: 'Stale', body: 'Do not overwrite', expectedRevision: note.revision }, 'PATCH')).status, 409)
  assert.equal((await fetch(base + '/api/bots/scout/memory/' + note.id)).status, 404)
})

test('editing saved messages and deleting an agent transfers linked memories', async t => {
  const f = await fixture(t, async () => ({ ok: true, text: 'Original reply', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }))
  const continuity = createContinuityRoutes(f), botsRoute = createBotRoutes(f.bots, f.service)
  const server = http.createServer(async (request, response) => { if (await continuity(request, response)) return; await botsRoute(request, response) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (path, method, value) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  f.service.start('scout', { id: 'edit-and-delete', prompt: 'Old question', ...settings })
  await done(f.chats, 'edit-and-delete')
  const edited = await send('/api/bots/scout/messages/edit-and-delete', 'PATCH', { role: 'user', value: 'New question', expectedText: 'Old question' })
  assert.equal(edited.status, 200)
  assert.equal((await edited.json()).request.prompt, 'New question')
  assert.equal((await send('/api/bots/scout/messages/edit-and-delete', 'PATCH', { role: 'assistant', value: 'New reply', expectedText: 'Original reply' })).status, 200)
  assert.equal((await send('/api/bots/scout/messages/edit-and-delete', 'PATCH', { role: 'user', value: 'Stale', expectedText: 'Old question' })).status, 409)
  assert.equal(f.chats.get('edit-and-delete').usage.totalTokens, 15)
  await f.memory.write('bunjibox', { id: 'tea', title: 'Existing tea', body: 'Do not replace' })
  await f.memory.write('scout', { id: 'tea', title: 'Scout tea', body: 'Green tea', sourceMessageIds: ['edit-and-delete'] })
  await f.memory.write('scout', { id: 'related', title: 'Related', body: 'See [[tea|tea note]]' })
  const before = await f.memory.list('scout')
  assert.equal((await send('/api/bots/scout', 'DELETE', { memoryAction: 'move', targetBotId: 'bunjibox', expectedMemoryRevision: 'stale' })).status, 409)
  assert.ok(f.bots.list().bots.some(bot => bot.id === 'scout'))
  const removed = await send('/api/bots/scout', 'DELETE', { memoryAction: 'move', targetBotId: 'bunjibox', expectedMemoryRevision: before.revision })
  assert.equal(removed.status, 200)
  assert.ok(!(await removed.json()).bots.some(bot => bot.id === 'scout'))
  assert.equal(f.chats.history('scout').requests.length, 0)
  assert.equal((await f.memory.list('scout')).notes.length, 0)
  const target = (await f.memory.list('bunjibox')).notes
  assert.equal(target.length, 3)
  assert.equal((await f.memory.read('bunjibox', 'tea')).body, 'Do not replace')
  const movedTea = target.find(note => note.title === 'Scout tea')
  const related = await f.memory.read('bunjibox', target.find(note => note.title === 'Related').id)
  assert.deepEqual(movedTea.sourceMessageIds, ['edit-and-delete'])
  assert.ok(related.links.includes(movedTea.id))
  f.bots.create({ id: 'trash-bot', name: 'Trash', ...settings })
  await f.memory.write('trash-bot', { id: 'unwanted', title: 'Unwanted', body: 'Delete this note' })
  const trashRevision = (await f.memory.list('trash-bot')).revision
  assert.equal((await send('/api/bots/trash-bot', 'DELETE', { memoryAction: 'delete', expectedMemoryRevision: trashRevision })).status, 200)
  assert.equal((await f.memory.list('trash-bot')).notes.length, 0)
  assert.equal((await f.memory.list('bunjibox')).notes.length, 3)
})
test('context is bounded and explicitly reports omitted full exchanges', () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({ prompt: `Question ${index}`, text: 'answer '.repeat(500), status: 'complete' }))
  const result = buildContext({ name: 'Agent' }, turns, 'Continue', { completedCount: 45 })
  assert.ok(result.prompt.length <= 12000); assert.equal(result.omittedTurns, 45 - result.contextTurns)
  assert.match(result.prompt, /Question 19/); assert.match(result.prompt, /Memory writes are available in every chat/)
  assert.throws(() => buildContext({ name: 'Agent' }, [], 'x'.repeat(12000)), /too long/)
})
test('MCP protocol enforces bot and immutable write scope, exposes only bounded notes', async t => {
  const f = await fixture(t, async () => ({}))
  const note = await f.memory.write('bunjibox', { title: 'Tea', body: 'Green tea' })
  async function connect(allowWrites, botId = 'bunjibox') {
    const server = createMemoryServer({ store: f.memory, botId, sourceId: 'run-source', allowWrites })
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    t.after(async () => { await client.close(); await server.close() })
    return client
  }
  const reader = await connect(false)
  const found = await reader.callTool({ name: 'memory_search', arguments: { query: 'tea' } })
  assert.match(found.content[0].text, /Green tea/)
  const denied = await reader.callTool({ name: 'memory_write', arguments: { title: 'No', body: 'No', allowWrites: true } })
  assert.equal(denied.isError, true)
  assert.equal((await f.memory.list('bunjibox')).notes.length, 1)
  const other = await connect(false, 'scout')
  assert.equal((await other.callTool({ name: 'memory_read', arguments: { id: note.id } })).isError, true)
  const writer = await connect(true)
  const written = await writer.callTool({ name: 'memory_write', arguments: { title: 'New fact', body: 'Likes lime' } })
  assert.ok(!written.isError)
  const data = JSON.parse(written.content[0].text).data
  assert.deepEqual(data.sourceMessageIds, ['run-source'])
  const named = await writer.callTool({ name: 'memory_write', arguments: { id: 'named-note', title: 'Named fact', body: 'Lime rolls' } })
  assert.ok(!named.isError)
  const revised = await writer.callTool({ name: 'memory_write', arguments: { id: note.id, title: 'Tea revised', body: 'Green tea, no sugar', expectedRevision: note.revision } })
  assert.ok(!revised.isError)
  assert.deepEqual((await f.memory.read('bunjibox', note.id)).sourceMessageIds, ['run-source'])
})
test('provider adapters add only a request-scoped MCP bridge and retain normal safety modes', () => {
  const memory = { directory: '/private/tmp/test-vault', botId: 'bot', sourceId: 'run', allowWrites: false }
  const [, codex] = providerCommand({ ...settings, prompt: 'hi' }, { memory })
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(codex.some(value => value.includes('enabled_tools=["memory_search","memory_read"]')))
  assert.ok(!codex.some(value => value.includes('--write')))
  const [, claude] = providerCommand({ provider: 'claude', model: 'haiku', effort: 'low', prompt: 'hi' }, { memory: { ...memory, allowWrites: true } })
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Glob,Grep,WebFetch,WebSearch,ToolSearch')
  assert.ok(claude.includes('--strict-mcp-config'))
  assert.ok(claude[claude.indexOf('--allowedTools') + 1].includes('mcp__bunji_memory__memory_write'))
  assert.ok(!claude.includes('--dangerously-skip-permissions'))
})
