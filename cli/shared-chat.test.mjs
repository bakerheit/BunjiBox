import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createElement } from 'react'
import { render } from 'ink'
import xterm from '@xterm/headless'
import { BunjiSession } from './session.mjs'
import { ChatClient } from '../shared/chat-client.js'
import App from './app.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const turn = (id, patch = {}) => ({ id, prompt: 'Saved question', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', memoryWrite: false,
  startedAt: 1000, status: 'complete', text: 'Saved answer', activities: [], usage: { totalTokens: 12 }, durationMs: 20, contextTurns: 0, omittedTurns: 0, ...patch })
async function until(check) {
  for (let index = 0; index < 200; index++) { if (check()) return; await delay(10) }
  assert.ok(check(), 'expected shared state did not arrive')
}

function serviceFixture() {
  const records = new Map(), revisions = new Map(), messages = [], cancelled = [], reads = [], older = new Map()
  const hooks = {}
  const put = (botId, requests) => { records.set(botId, requests); revisions.set(botId, (revisions.get(botId) || 0) + 1) }
  const finish = (botId, id, patch = {}) => put(botId, records.get(botId).map(item => item.id === id ? { ...item, status: 'complete', text: 'Finished', durationMs: 30, ...patch } : item))
  const fetcher = async (path, options = {}) => {
    const url = new URL(path, 'http://fixture.test'), [, , , botId, action, noteId] = url.pathname.split('/')
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname.startsWith('/api/runs/')) {
      const id = url.pathname.split('/')[3]; cancelled.push(id)
      if (hooks.cancel) return hooks.cancel(id)
      for (const [bot, requests] of records) if (requests.some(item => item.id === id)) finish(bot, id, { status: 'cancelled', error: 'Request stopped.' })
      return json({ request: [...records.values()].flat().find(item => item.id === id) })
    }
    if (action === 'history') {
      reads.push(botId)
      return json({ requests: url.searchParams.has('before') ? older.get(botId) || [] : records.get(botId) || [],
        revision: revisions.get(botId) || 0, hasMore: !url.searchParams.has('before') && older.has(botId), nextBefore: !url.searchParams.has('before') && older.has(botId) ? '2' : null })
    }
    if (action === 'messages') {
      const body = JSON.parse(options.body); messages.push({ botId, ...body })
      if (hooks.send) return hooks.send(botId, body)
      const request = turn(body.id, { ...body, status: 'running', text: '', usage: null, durationMs: null })
      put(botId, [...(records.get(botId) || []), request])
      return json({ request }, 202)
    }
    if (action === 'memory') {
      if (noteId) return json({ note: hooks.memoryRead ? await hooks.memoryRead(botId, noteId) : { id: noteId, title: botId + ' note', body: '**Saved fruit**', sourceMessageIds: [] } })
      return json(hooks.memoryList ? await hooks.memoryList(botId, url.searchParams.get('q') || '') : { notes: [{ id: 'fruit', title: botId + ' fruit', snippet: 'A saved preference' }] })
    }
    throw new Error('Unexpected fixture request: ' + path)
  }
  const client = () => new ChatClient({ fetcher, pollMs: 15 })
  return { records, messages, cancelled, reads, older, hooks, put, finish, client }
}

function sessionFixture(t, service = serviceFixture()) {
  const chatClient = service.client()
  const session = new BunjiSession({ chatClient, status: async () => ({ connected: true }), usage: async () => ({}), run: () => { throw new Error('Shared chats must not use the direct runner') } })
  t.after(() => session.dispose())
  return { session, chatClient, service }
}

test('connect loads saved history and follows external runs for the selected bot', async t => {
  const { session, service } = sessionFixture(t)
  service.put('bunjibox', [turn('saved')])
  service.put('scout', [turn('external', { status: 'running', text: '', usage: null })])
  await session.connect()
  assert.equal(session.history.ready, true)
  assert.equal(session.requests[0].id, 'saved')
  session.select('scout')
  await until(() => session.busy?.request.id === 'external')
  assert.equal(session.busy.botId, 'scout')
  await assert.rejects(session.send('Cannot overlap'), /already running/)
  service.finish('scout', 'external', { usage: { totalTokens: 44 } })
  await until(() => session.requests[0].status === 'complete')
  assert.equal(session.busy, null)
  assert.equal(session.requests[0].usage.totalTokens, 44)
  session.select('bunjibox')
  assert.equal(session.requests[0].id, 'saved')
})

test('send waits for the terminal result and enables memory for an ordinary prompt', async t => {
  const { session, service } = sessionFixture(t)
  await session.connect()
  let settled = false
  const pending = session.send('Remember\nmy fruit').then(value => { settled = true; return value })
  await until(() => session.requests.length === 1)
  assert.equal(settled, false)
  assert.equal(service.messages[0].prompt, 'Remember\nmy fruit')
  assert.equal(service.messages[0].memoryWrite, true)
  assert.equal(service.messages[0].model, session.bot.model)
  const id = service.messages[0].id
  service.finish('bunjibox', id, { status: 'failed', text: 'Partial result', usage: { totalTokens: 29 }, error: 'Provider failed', activities: [{ id: 'tool', kind: 'tool', title: 'Read', status: 'complete' }] })
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.equal(result.usage.totalTokens, 29)
  assert.equal(result.activities.length, 1)
  assert.equal(session.busy, null)
})

test('switching bots allows parallel sends and still settles the original bot; stop targets the selected run', async t => {
  const { session, service } = sessionFixture(t)
  await session.connect()
  const first = session.send('One')
  await until(() => session.requests.length === 1)
  const firstId = session.requests[0].id
  session.select('scout')
  assert.equal(session.busy, null)
  const second = session.send('Two')
  await until(() => session.requests.length === 1)
  const secondId = session.requests[0].id
  assert.equal(service.messages[1].memoryWrite, true)
  service.finish('bunjibox', firstId)
  assert.equal((await first).status, 'complete', 'inactive bot keeps polling while its send waits')
  await session.stop()
  assert.equal((await second).status, 'cancelled')
  assert.deepEqual(service.cancelled, [secondId])
  session.select('bunjibox')
  assert.equal(session.requests[0].id, firstId)
  assert.equal(session.requests[0].status, 'complete')
})

test('dispose detaches without cancelling; another CLI session attaches to the ongoing run', async t => {
  const { session, service, chatClient } = sessionFixture(t)
  await session.connect()
  const pending = session.send('Keep running')
  const rejection = assert.rejects(pending, error => error.code === 'BUNJI_DETACHED')
  await until(() => session.requests.length === 1)
  session.dispose()
  await rejection
  assert.deepEqual(service.cancelled, [])
  assert.equal(chatClient.timer, null)
  assert.equal(chatClient.listeners.size, 0)
  assert.equal(service.records.get('bunjibox')[0].status, 'running')
  const next = sessionFixture(t, service).session
  await next.connect()
  assert.equal(next.busy.request.id, service.records.get('bunjibox')[0].id)
  await next.stop()
  assert.equal(service.cancelled.length, 1)
})

test('memory responses are scoped to their bot and stale searches cannot replace newer notes', async t => {
  const { session, service } = sessionFixture(t)
  const old = deferred(), newer = deferred()
  service.hooks.memoryList = (botId, query) => botId === 'scout' ? { notes: [{ id: 'scout-only', title: 'Scout' }] } : query === 'old' ? old.promise : newer.promise
  const first = session.readMemory({ query: 'old' })
  const second = session.readMemory({ query: 'new' })
  newer.resolve({ notes: [{ id: 'fresh', title: 'Fresh result' }] }); await second
  old.resolve({ notes: [{ id: 'stale', title: 'Stale result' }] }); await first
  assert.equal(session.memory.notes[0].id, 'fresh')
  const read = deferred()
  service.hooks.memoryRead = () => read.promise
  const pending = session.readMemory({ id: 'a-note' })
  session.select('scout')
  assert.deepEqual(session.memory.notes, [])
  await session.readMemory()
  read.resolve({ id: 'a-note', title: 'Other bot secret', body: 'Only BunjiBox' }); await pending
  assert.equal(session.memory.note, null)
  assert.equal(session.memory.notes[0].id, 'scout-only')
  session.select('bunjibox')
  assert.equal(session.memory.note.id, 'a-note')
})

test('loadOlder preserves saved messages and direct demo sessions have no memory vault', async t => {
  const { session, service } = sessionFixture(t)
  service.put('bunjibox', [turn('latest')]); service.older.set('bunjibox', [turn('older')])
  await session.connect()
  assert.equal(session.history.hasMore, true)
  await session.loadOlder()
  assert.deepEqual(session.requests.map(item => item.id), ['older', 'latest'])
  assert.equal(session.history.hasMore, false)
  const direct = new BunjiSession({ run: async () => ({ ok: true, text: 'Hello' }) })
  assert.equal((await direct.send('Hello')).status, 'complete')
  await assert.rejects(direct.readMemory(), /shared chats/)
  direct.dispose()
})

async function terminalApp(t, session) {
  const terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true, convertEol: true })
  const stdin = new PassThrough()
  stdin.isTTY = true; stdin.setRawMode = raw => { stdin.isRaw = raw }; stdin.ref = stdin.unref = () => stdin
  const stdout = new Writable({ write(chunk, _encoding, done) { terminal.write(chunk.toString(), done) } })
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 40 })
  const app = render(createElement(App, { session, cwd: '/fixture/service-cwd' }), { stdin, stdout, stderr: stdout, patchConsole: false, interactive: true,
    alternateScreen: true, incrementalRendering: true, exitOnCtrlC: false, maxFps: 60, kittyKeyboard: { mode: 'disabled' } })
  t.after(async () => { app.unmount(); await app.waitUntilExit(); app.cleanup(); terminal.dispose(); stdin.destroy(); stdout.destroy() })
  const flush = async () => { await delay(40); await app.waitUntilRenderFlush(); await new Promise(resolve => terminal.write('', resolve)) }
  const key = async value => { stdin.write(value); await flush() }
  const command = async value => { await key('\u001b'); await key('\u001b[200~' + value + '\u001b[201~'); await key('\r') }
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n')
  await flush()
  return { key, command, screen, flush, app }
}

test('terminal commands show memory, recall, older history and loaded token totals; exit keeps a run alive', async t => {
  const { session, service } = sessionFixture(t)
  service.put('bunjibox', [turn('saved')]); service.older.set('bunjibox', [turn('old')])
  const searches = []
  service.hooks.memoryList = (botId, query) => { searches.push({ botId, query }); return { notes: [{ id: 'fruit', title: botId + ' fruit' }] } }
  const ui = await terminalApp(t, session)
  await ui.command('/memory mango')
  assert.deepEqual(searches.at(-1), { botId: 'bunjibox', query: 'mango' })
  assert.match(ui.screen(), /bunjibox fruit/)
  await ui.command('/recall fruit')
  assert.match(ui.screen(), /Saved fruit/)
  await ui.command('/older')
  assert.equal(session.requests.length, 2)
  await ui.key('\u000c')
  assert.match(ui.screen(), /LOADED HISTORY TOTAL/)
  assert.match(ui.screen(), /24 tokens/)
  await ui.command('/details')
  assert.match(ui.screen(), /Memory tools are available in/)
  assert.match(ui.screen(), /fixture\/service-cwd/)
  await ui.command('/remember I like mango\nand lime')
  assert.equal(service.messages.at(-1).memoryWrite, true)
  assert.equal(service.messages.at(-1).prompt, 'I like mango\nand lime')
  assert.equal(session.busy.request.status, 'running')
  await ui.key('\u0003')
  await ui.app.waitUntilExit()
  assert.deepEqual(service.cancelled, [])
  assert.equal(service.records.get('bunjibox').at(-1).status, 'running')
})

test('terminal preserves failed drafts and newer edits under the original bot', async t => {
  const { session, service } = sessionFixture(t), failure = deferred()
  service.hooks.send = () => failure.promise
  const ui = await terminalApp(t, session)
  await ui.key('original draft'); await ui.key('\r')
  await ui.key('newer edit')
  session.select('scout'); await ui.flush()
  await ui.key('scout draft')
  failure.reject(new Error('Offline'))
  await ui.flush()
  assert.match(ui.screen(), /scout draft/)
  assert.doesNotMatch(ui.screen(), /original draft|newer edit/)
  session.select('bunjibox'); await ui.flush()
  assert.match(ui.screen(), /original draft/)
  assert.match(ui.screen(), /newer edit/)
  assert.doesNotMatch(ui.screen(), /scout draft/)
})

test('terminal switching clears other bot memory; /stop and Ctrl+X cancel explicitly', async t => {
  const { session, service } = sessionFixture(t)
  service.put('bunjibox', [turn('one', { status: 'running' })]); service.put('scout', [turn('two', { status: 'running' })])
  const ui = await terminalApp(t, session)
  await ui.command('/memory')
  assert.match(ui.screen(), /bunjibox fruit/)
  session.select('scout'); await ui.flush()
  assert.match(ui.screen(), /scout fruit/)
  assert.doesNotMatch(ui.screen(), /bunjibox fruit/)
  await ui.command('/stop')
  assert.deepEqual(service.cancelled, ['two'])
  session.select('bunjibox'); await ui.flush()
  await ui.key('\u0018')
  assert.deepEqual(service.cancelled, ['two', 'one'])
  await ui.command('/quit')
  await ui.app.waitUntilExit()
  assert.deepEqual(service.cancelled, ['two', 'one'])
})
