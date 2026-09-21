import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { openChatStore } from '../src/chat-store.mjs'
import { openBotStore, workspacePath } from '../src/bot-store.mjs'
import { createRunEvents, displayText } from '../src/run-events.mjs'

const exec = promisify(execFile)
const moduleUrl = new URL('../src/chat-store.mjs', import.meta.url).href
const input = (id = 'request-1', botId = 'bunjibox', changes = {}) => ({
  id, botId, prompt: 'Hello 🍋\nKeep the full message.', provider: 'codex', model: 'gpt-6-astra', effort: 'high', ...changes,
})
const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, cacheWriteTokens: null, reasoningOutputTokens: 2, totalTokens: 15, source: 'Codex turn usage' }
const isStatus = status => error => error.status === status

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bunji-chat-test-')), path = join(dir, 'workspace.sqlite'), stores = new Set()
  const open = () => { const store = openChatStore({ path }); stores.add(store); return store }
  const close = store => { store.close(); stores.delete(store) }
  t.after(() => {
    try { for (const store of stores) store.close() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  return { dir, path, open, close, store: open() }
}

async function child(path, body, value = null) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import { openChatStore } from ${JSON.stringify(moduleUrl)};
    const store = openChatStore({ path: process.argv[1] });
    const value = JSON.parse(process.argv[2]);
    ${body}
  `, path, JSON.stringify(value)], { timeout: 15000, maxBuffer: 4000000 })
  return stdout.trim() ? JSON.parse(stdout) : null
}

test('full requests survive reconnect and a fresh process; values returned are detached', async t => {
  const f = fixture(t), store = f.store
  assert.deepEqual(store.history('bunjibox'), { requests: [], hasMore: false, nextBefore: null, revision: 0 })
  const source = input('persist', 'bunjibox', { contextTurns: 2, omittedTurns: 3, memoryWrite: true })
  const started = store.start(source)
  assert.equal(started.created, true)
  assert.equal(started.request.status, 'running')
  assert.equal(typeof started.request.startedAt, 'number')
  assert.equal(started.request.durationMs, null)
  assert.equal(started.request.error, null)
  assert.equal(started.request.usage, null)
  assert.equal(started.request.memoryWrite, true)
  assert.equal(store.history('bunjibox').revision, 1)
  const event = { id: 'parent:command', at: '2026-09-20T10:11:12.000Z', kind: 'tool', title: 'Run command', status: 'complete', input: 'pwd', output: '/tmp/project', exitCode: 0 }
  store.addActivity('persist', event)
  const response = 'Complete answer 🍋\n'.repeat(2000)
  const done = store.finish('persist', { text: response, usage, durationMs: 1234 })
  assert.deepEqual(Object.keys(done).sort(), ['id', 'prompt', 'provider', 'model', 'effort', 'memoryWrite', 'startedAt', 'status', 'text', 'activities', 'usage', 'durationMs', 'error', 'contextTurns', 'omittedTurns', 'promptEditedAt', 'responseEditedAt'].sort())
  assert.equal(done.activities[0].at, Date.parse(event.at))
  assert.deepEqual(done.usage, usage)
  assert.equal(done.text, response)
  assert.equal(store.history('bunjibox').revision, 3)
  started.request.prompt = 'Client mutation'
  done.activities[0].output = 'Client mutation'
  done.usage.totalTokens = 999
  const expected = store.get('persist')
  assert.equal(expected.prompt, source.prompt)
  assert.equal(expected.activities[0].output, '/tmp/project')
  assert.equal(expected.usage.totalTokens, 15)
  f.close(store)
  const reopened = f.open()
  assert.deepEqual(reopened.get('persist'), expected)
  assert.deepEqual(await child(f.path, "console.log(JSON.stringify(store.get('persist'))); store.close();"), expected)
  assert.deepEqual(reopened.history('bunjibox').requests[0], { ...done, activities: expected.activities, usage })
  assert.equal(statSync(f.path).mode & 0o777, 0o600)
})

test('default path shares the workspace file and never changes bot data or bot revisions', t => {
  const f = fixture(t), previous = process.env.BUNJI_DATA_DIR
  process.env.BUNJI_DATA_DIR = f.dir
  try {
    assert.equal(workspacePath(), f.path)
    const bots = openBotStore({ path: f.path }), chat = openChatStore()
    try {
      bots.patch('bunjibox', { name: 'Keep this bot' })
      const snapshot = bots.list()
      chat.start(input())
      chat.finish('request-1', { text: 'Saved' })
      assert.deepEqual(bots.list(), snapshot)
      bots.patch('bunjibox', { description: 'Bot changes do not remove chat' })
      assert.equal(chat.get('request-1').text, 'Saved')
      assert.equal(chat.history('bunjibox').revision, 2)
    } finally { chat.close(); bots.close() }
  } finally {
    if (previous === undefined) delete process.env.BUNJI_DATA_DIR
    else process.env.BUNJI_DATA_DIR = previous
  }
})

test('opening a chat-only database creates separate tables and does not seed bots', t => {
  const { path } = fixture(t), db = new DatabaseSync(path)
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), ['chat_requests', 'chat_revisions'])
  } finally { db.close() }
})

test('stable IDs are globally idempotent; changes conflict and terminal retries never rerun', t => {
  const { store, open } = fixture(t), peer = open(), original = input()
  const first = store.start(original)
  assert.equal(first.request.memoryWrite, false)
  assert.deepEqual(peer.start({ ...original, contextTurns: 0, omittedTurns: 0, memoryWrite: false }), { request: first.request, created: false })
  for (const changes of [{ botId: 'scout' }, { prompt: 'Different' }, { provider: 'claude' }, { model: 'gpt-5.5' }, { effort: 'low' }, { contextTurns: 1 }, { omittedTurns: 1 }, { memoryWrite: true }]) {
    assert.throws(() => peer.start({ ...original, ...changes }), isStatus(409))
  }
  assert.equal(store.history('bunjibox').revision, 1)
  const finished = peer.finish(original.id, { status: 'complete', text: 'Done', contextTurns: 2, omittedTurns: 4 })
  store.start(input('second'))
  assert.deepEqual(peer.start(original), { request: finished, created: false }, 'retry uses original counts and succeeds even while another run is active')
  assert.equal(store.history('bunjibox').revision, 3)
  assert.equal(peer.history('scout').revision, 0)
})

test('message edits sync across stores, reject stale writes, and preserve measured usage', t => {
  const { store, open } = fixture(t), peer = open(), original = input('editable')
  store.start(original)
  assert.throws(() => store.editMessage('bunjibox', 'editable', { role: 'user', value: 'Too soon', expectedText: original.prompt }), isStatus(409))
  store.finish('editable', { text: 'Original reply', usage })
  const edited = peer.editMessage('bunjibox', 'editable', { role: 'user', value: 'Updated question', expectedText: original.prompt })
  assert.equal(edited.prompt, 'Updated question')
  assert.ok(edited.promptEditedAt)
  assert.equal(edited.usage.totalTokens, 15)
  assert.throws(() => store.editMessage('bunjibox', 'editable', { role: 'user', value: 'Stale', expectedText: original.prompt }), isStatus(409))
  const reply = store.editMessage('bunjibox', 'editable', { role: 'assistant', value: 'Corrected reply', expectedText: 'Original reply' })
  assert.ok(reply.responseEditedAt)
  assert.equal(peer.recentCompleted('bunjibox')[0].text, 'Corrected reply')
  assert.equal(peer.start(original).created, false, 'original request ID remains safe to retry')
})

test('memory permission is explicit, idempotent, and immutable while context counts can finish later', t => {
  const { store, close, open } = fixture(t), writable = input('write', 'bunjibox', { memoryWrite: true })
  const first = store.start(writable)
  assert.equal(first.request.memoryWrite, true)
  assert.equal(store.start(writable).created, false)
  assert.throws(() => store.start({ ...writable, memoryWrite: false }), isStatus(409))
  const done = store.finish('write', { text: 'Saved', memoryWrite: false, contextTurns: 4, omittedTurns: 80 })
  assert.equal(done.memoryWrite, true)
  assert.equal(done.contextTurns, 4)
  assert.equal(done.omittedTurns, 80)
  store.start(input('read'))
  assert.equal(store.finish('read', { memoryWrite: true }).memoryWrite, false, 'finish cannot grant write access')
  close(store)
  const reopened = open()
  assert.equal(reopened.get('write').memoryWrite, true)
  assert.equal(reopened.get('read').memoryWrite, false)
  assert.deepEqual(reopened.start(writable), { request: done, created: false })
})

test('one running request per bot is atomic across connections, while other bots can run', t => {
  const { store, open } = fixture(t), peer = open()
  store.start(input())
  assert.throws(() => peer.start(input('blocked')), isStatus(409))
  assert.equal(peer.get('blocked'), null)
  assert.equal(peer.start(input('other-bot', 'scout')).created, true)
  assert.deepEqual(peer.listRunning().map(item => [item.id, item.botId]), [['request-1', 'bunjibox'], ['other-bot', 'scout']])
  store.finish('request-1', { status: 'failed', error: 'Exit 1', usage })
  assert.equal(peer.start(input('unblocked')).created, true)
  assert.equal(store.history('scout').revision, 1)
  assert.equal(store.history('bunjibox').revision, 3)
})

test('simultaneous processes cannot create duplicate IDs or two live runs for one bot', async t => {
  const { path, store } = fixture(t)
  const attempt = value => child(path, `
    try { console.log(JSON.stringify(store.start(value))); }
    catch (error) { console.log(JSON.stringify({ status: error.status, message: error.message })); }
    finally { store.close(); }
  `, value)
  const duplicate = await Promise.all(Array.from({ length: 6 }, () => attempt(input('same'))))
  assert.equal(duplicate.filter(result => result.created).length, 1)
  assert.equal(duplicate.filter(result => result.created === false).length, 5)
  assert.equal(store.history('bunjibox').revision, 1)
  store.finish('same', { text: 'Done' })
  const conflicting = await Promise.all(Array.from({ length: 6 }, (_, index) => attempt(input(`race-${index}`))))
  assert.equal(conflicting.filter(result => result.created).length, 1)
  assert.equal(conflicting.filter(result => result.status === 409).length, 5)
  const otherBots = await Promise.all(Array.from({ length: 4 }, (_, index) => attempt(input(`parallel-${index}`, `bot-${index}`))))
  assert.ok(otherBots.every(result => result.created))
  assert.equal(store.listRunning().length, 5)
})

test('activity IDs upsert in place, redact details, drop raw fields and use numeric timestamps', t => {
  const { store } = fixture(t)
  store.start(input())
  const tracker = createRunEvents('codex', activity => store.addActivity('request-1', activity))
  tracker.consume({ type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'pwd' } })
  const originalAt = store.get('request-1').activities[0].at
  tracker.consume({ type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'pwd', aggregated_output: '/tmp', exit_code: 0 } })
  store.addActivity('request-1', { id: 'summary', kind: 'reasoning', text: 'Checked the files.', encrypted_content: 'PRIVATE', signature: 'PRIVATE', raw: { token: 'PRIVATE' } })
  store.addActivity('request-1', { id: 'command', status: 'failed', at: originalAt + 100, input: { access_token: 'PRIVATE', authorization: 'Bearer PRIVATE', nested: { password: 'PRIVATE' } }, output: 'password=PRIVATE', exitCode: 1, images: ['PRIVATE'] })
  const activities = store.get('request-1').activities
  assert.deepEqual(activities.map(item => item.id), ['command', 'summary'])
  assert.equal(activities[0].at, originalAt)
  assert.equal(typeof activities[1].at, 'number')
  assert.equal(activities[0].status, 'failed')
  assert.equal(activities[0].exitCode, 1)
  assert.doesNotMatch(JSON.stringify(activities), /PRIVATE|encrypted_content|signature|images/)
  const revision = store.history('bunjibox').revision
  store.addActivity('request-1', { id: 'command', status: 'failed' })
  assert.equal(store.history('bunjibox').revision, revision, 'duplicate event is a no-op')
})

test('150-event and display-detail caps keep old entries updateable without truncating messages', t => {
  const { store } = fixture(t)
  store.start(input('large', 'bunjibox', { prompt: 'p'.repeat(12000) }))
  for (let index = 0; index < 155; index++) store.addActivity('large', { id: `event-${index}`, kind: 'tool', input: 'i'.repeat(13000), output: 'o'.repeat(13000) })
  assert.equal(store.get('large').activities.length, 150)
  assert.equal(store.history('bunjibox').revision, 151)
  store.addActivity('large', { id: 'event-0', status: 'complete', output: 'Updated' })
  const done = store.finish('large', { text: 't'.repeat(1000000) })
  assert.equal(done.prompt.length, 12000)
  assert.equal(done.text.length, 1000000)
  assert.equal(done.activities[0].output, 'Updated')
  assert.equal(done.activities[0].input, displayText('i'.repeat(13000)))
  assert.equal(done.activities[1].output, displayText('o'.repeat(13000)))
  assert.equal(done.activities[1].status, 'unknown')
})

test('concurrent activity writers merge events instead of losing updates', async t => {
  const { store, path } = fixture(t)
  store.start(input())
  await Promise.all(Array.from({ length: 4 }, (_, writer) => child(path, `
    for (let index = 0; index < 10; index++) store.addActivity('request-1', { id: 'writer-' + value + '-' + index, kind: 'tool', text: 'Saved' });
    store.close();
  `, writer)))
  assert.equal(store.get('request-1').activities.length, 40)
  assert.equal(store.history('bunjibox').revision, 41)
})

test('failed and cancelled requests keep reported usage and partial text; only safe fields change', t => {
  const { store } = fixture(t), started = store.start(input()).request
  store.addActivity('request-1', { id: 'tool', kind: 'tool', input: 'Read file' })
  const done = store.finish('request-1', { status: 'failed', text: 'Partial result', usage: { ...usage, raw: 'PRIVATE' }, durationMs: 42, error: 'Provider exited with code 1.',
    id: 'other', botId: 'scout', prompt: 'Overwritten', provider: 'claude', model: 'other', effort: 'low', startedAt: 0,
    activities: [{ id: 'tool', output: 'Partial tool output' }], ok: false, requestId: 'other' })
  assert.equal(done.status, 'failed')
  assert.deepEqual(done.usage, usage)
  assert.equal(done.text, 'Partial result')
  assert.equal(done.error, 'Provider exited with code 1.')
  assert.equal(done.durationMs, 42)
  for (const field of ['id', 'prompt', 'provider', 'model', 'effort', 'startedAt']) assert.equal(done[field], started[field])
  assert.equal(store.get('request-1').botId, 'bunjibox')
  assert.equal(done.activities[0].status, 'unknown')
  assert.equal(done.activities[0].input, 'Read file')
  assert.equal(done.activities[0].output, 'Partial tool output')
  const revision = store.history('bunjibox').revision
  assert.deepEqual(store.finish('request-1', { text: 'Late success', status: 'complete' }), done)
  assert.deepEqual(store.addActivity('request-1', { id: 'late', kind: 'tool' }), done)
  assert.equal(store.history('bunjibox').revision, revision)
  store.start(input('cancel'))
  const cancelled = store.finish('cancel', { status: 'cancelled', usage: { inputTokens: null, totalTokens: 0 } })
  assert.deepEqual(cancelled.usage, { inputTokens: null, totalTokens: 0 })
  assert.equal(cancelled.error, 'Request stopped.')
  assert.ok(cancelled.durationMs >= 0)
  assert.deepEqual(store.recentCompleted('bunjibox'), [])
})

test('a process restart leaves runs alone until explicit recovery, which is durable and idempotent', async t => {
  const { store, path, open } = fixture(t)
  await child(path, `
    store.start(value);
    store.addActivity(value.id, { id: 'in-progress', kind: 'tool', input: 'Pending tool' });
    process.exit(0);
  `, input('abandoned'))
  store.start(input('other-abandoned', 'scout'))
  const peer = open()
  assert.equal(peer.get('abandoned').status, 'running', 'opening never recovers or cancels another connection')
  assert.equal(peer.listRunning().length, 2)
  assert.equal(peer.recoverInterrupted(), 2)
  const recovered = store.get('abandoned')
  assert.equal(recovered.status, 'interrupted')
  assert.match(recovered.error, /interrupted.*restart.*not retried/i)
  assert.equal(recovered.activities[0].status, 'unknown')
  assert.equal(recovered.activities[0].input, 'Pending tool')
  assert.equal(recovered.usage, null)
  assert.ok(recovered.durationMs >= 0)
  assert.equal(store.history('bunjibox').revision, 3)
  assert.equal(store.history('scout').revision, 2)
  assert.equal(peer.recoverInterrupted(), 0)
  assert.equal(store.history('bunjibox').revision, 3)
  assert.deepEqual(store.listRunning(), [])
  assert.deepEqual(await child(path, "console.log(JSON.stringify(store.get('abandoned'))); store.close();"), recovered)
  store.finish('abandoned', { status: 'complete', text: 'Late provider callback' })
  assert.deepEqual(store.get('abandoned'), recovered)
  assert.equal(store.start(input('next')).created, true)
})

test('recovery preserves any persisted partial text and known usage and never changes finished rows', t => {
  const { store, path } = fixture(t)
  store.start(input('finished'))
  const done = store.finish('finished', { status: 'failed', usage, text: 'Failed result' })
  store.start(input('partial'))
  // Simulate a checkpoint written before a crash without adding a checkpoint API.
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE chat_requests SET text=?,usage=?,duration_ms=? WHERE id=?').run('Partial output', JSON.stringify(usage), 100, 'partial') }
  finally { db.close() }
  assert.equal(store.recoverInterrupted(), 1)
  const partial = store.get('partial')
  assert.equal(partial.text, 'Partial output')
  assert.deepEqual(partial.usage, usage)
  assert.equal(partial.durationMs, 100)
  assert.deepEqual(store.history('bunjibox').requests[0], done)
})

test('sequence pagination is stable for identical timestamps and concurrent newer inserts', t => {
  const { store, open } = fixture(t)
  t.mock.method(Date, 'now', () => 1800000000000)
  for (let index = 0; index < 7; index++) {
    store.start(input(`page-${index}`))
    store.finish(`page-${index}`, { text: `Answer ${index}` })
  }
  store.start(input('unrelated', 'scout'))
  const latest = store.history('bunjibox', { limit: 3 })
  assert.deepEqual(latest.requests.map(item => item.id), ['page-4', 'page-5', 'page-6'])
  assert.ok(latest.requests.every(item => item.startedAt === 1800000000000))
  assert.equal(latest.hasMore, true)
  assert.equal(typeof latest.nextBefore, 'string')
  assert.equal(latest.revision, 14)
  const peer = open()
  peer.start(input('newest'))
  const middle = peer.history('bunjibox', { limit: 3, before: latest.nextBefore })
  assert.deepEqual(middle.requests.map(item => item.id), ['page-1', 'page-2', 'page-3'])
  assert.equal(middle.revision, 15)
  const oldest = store.history('bunjibox', { limit: 3, before: middle.nextBefore })
  assert.deepEqual(oldest.requests.map(item => item.id), ['page-0'])
  assert.equal(oldest.hasMore, false)
  assert.equal(oldest.nextBefore, null)
  assert.equal(store.history('bunjibox', { before: 1 }).requests.length, 0)
  assert.equal(store.history('bunjibox').requests.length, 8, 'pagination never deletes source messages')
})

test('history defaults to the latest 100; prompt history defaults to 20 completed turns in order', t => {
  const { store } = fixture(t)
  for (let index = 0; index < 105; index++) {
    store.start(input(`request-${index}`))
    store.finish(`request-${index}`, { status: index % 5 === 0 ? 'failed' : 'complete', text: `Answer ${index}` })
  }
  store.start(input('live'))
  const history = store.history('bunjibox')
  assert.equal(history.requests.length, 100)
  assert.equal(history.requests[0].id, 'request-6')
  assert.equal(history.requests.at(-1).id, 'live')
  assert.equal(store.history('bunjibox', { before: history.nextBefore }).requests.length, 6)
  const completed = store.recentCompleted('bunjibox')
  assert.equal(completed.length, 20)
  assert.ok(completed.every(item => item.status === 'complete'))
  assert.deepEqual(store.recentCompleted('bunjibox', { limit: 2 }).map(item => item.id), ['request-103', 'request-104'])
  assert.deepEqual(store.recentCompleted('scout'), [])
  assert.equal(store.completedCount('bunjibox'), 84, 'count includes all completed messages beyond the recent 20')
  assert.equal(store.completedCount('scout'), 0)
  assert.equal(store.completedCount('bunjibox') - completed.length, 64)
  store.finish('live', { status: 'interrupted' })
  assert.equal(store.completedCount('bunjibox'), 84)
  store.start(input('complete-on-scout', 'scout'))
  store.finish('complete-on-scout', { text: 'Other bot' })
  assert.equal(store.completedCount('bunjibox'), 84)
  assert.equal(store.completedCount('scout'), 1)
  assert.equal(store.history('bunjibox', { limit: 1000 }).requests.length, 106)
})

test('invalid IDs, metadata, counters, events and pagination never partly commit', t => {
  const { store } = fixture(t)
  for (const changes of [{ id: '' }, { id: 'a'.repeat(129) }, { botId: '../bot' }, { prompt: ' ' }, { prompt: 'x'.repeat(12001) }, { prompt: 3 },
    { provider: 'unknown' }, { model: 'line\nbreak' }, { model: 'x'.repeat(129) }, { effort: 'extreme' }, { contextTurns: -1 }, { omittedTurns: 0.5 },
    { memoryWrite: 'true' }, { memoryWrite: 1 }, { memoryWrite: null }]) {
    assert.throws(() => store.start(input('invalid', 'bunjibox', changes)), isStatus(400))
  }
  assert.equal(store.history('bunjibox').revision, 0)
  store.start(input())
  for (const patch of [{ status: 'running' }, { status: 'success' }, { text: 'x'.repeat(1000001) }, { usage: [] }, { usage: { totalTokens: -1 } }, { usage: { inputTokens: Infinity } },
    { durationMs: -1 }, { contextTurns: 1.1 }, { omittedTurns: -2 }, { activities: {} }, { activities: Array.from({ length: 151 }, (_, i) => ({ id: String(i) })) },
    { activities: [{ id: 'valid', text: 'Valid first' }, { id: 'bad', status: 'made-up' }] }]) {
    assert.throws(() => store.finish('request-1', patch), isStatus(400))
    assert.equal(store.get('request-1').status, 'running')
    assert.deepEqual(store.get('request-1').activities, [])
  }
  const cyclic = {}; cyclic.self = cyclic
  for (const activity of [null, {}, { id: '' }, { id: '\n' }, { id: 'bad', kind: 'image' }, { id: 'bad', status: 'made-up' }, { id: 'bad', at: 'yesterday' }, { id: 'bad', exitCode: NaN }, { id: 'bad', input: cyclic }]) {
    assert.throws(() => store.addActivity('request-1', activity), isStatus(400))
  }
  for (const limit of [0, -1, 0.5, '20', 1001, Infinity]) {
    assert.throws(() => store.history('bunjibox', { limit }), isStatus(400))
    assert.throws(() => store.recentCompleted('bunjibox', { limit }), isStatus(400))
  }
  for (const before of [0, -1, 1.1, 'nope', '1.5', '99999999999999999999', {}, Infinity]) assert.throws(() => store.history('bunjibox', { before }), isStatus(400))
  assert.throws(() => store.get('../bad'), isStatus(400))
  assert.throws(() => store.history(''), isStatus(400))
  assert.throws(() => store.completedCount('../bad'), isStatus(400))
  assert.throws(() => store.finish('missing', {}), isStatus(404))
  assert.throws(() => store.addActivity('missing', { id: 'event' }), isStatus(404))
  assert.equal(store.get('missing'), null)
  assert.equal(store.history('bunjibox').revision, 1)
})
