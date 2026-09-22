import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatClient } from '../src/chat-client.js'

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const deferred = () => Promise.withResolvers()
const flush = () => new Promise(resolve => setImmediate(resolve))
const runtime = { provider: 'codex', model: 'test-model', effort: 'low', mode: 'agent' }

test('default fetch is called without the ChatClient receiver used by member calls', async t => {
  let receiver
  t.mock.method(globalThis, 'fetch', function () {
    receiver = this
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    return Promise.resolve(response({ requests: [], revision: 0, hasMore: false, nextBefore: null }))
  })
  const client = new ChatClient()
  const history = await client.refresh('a')
  assert.ok(history?.ready)
  assert.notEqual(receiver, client)
  assert.equal(client.getSnapshot().error, '')
})

// Models the existing durable, append-only API. No provider is started.
function server(pageSize = 2) {
  const bots = new Map(), calls = []
  let sequence = 0, executions = 0
  const bot = id => {
    if (!bots.has(id)) bots.set(id, { rows: [], revision: 0 })
    return bots.get(id)
  }
  function append(botId, value = {}) {
    const seq = ++sequence
    const request = { id: `saved-${seq}`, prompt: 'Hello', status: 'complete', text: 'Done', activities: [], ...runtime, ...value }
    bot(botId).rows.push({ seq, request }); bot(botId).revision++
    return request
  }
  function update(botId, id, patch) {
    Object.assign(bot(botId).rows.find(row => row.request.id === id).request, patch)
    bot(botId).revision++
  }
  function history(botId, before) {
    const state = bot(botId), rows = state.rows.filter(row => !before || row.seq < Number(before))
    const tail = rows.slice(-pageSize), hasMore = rows.length > tail.length
    return { requests: tail.map(row => row.request), revision: state.revision, hasMore, nextBefore: hasMore ? String(tail[0].seq) : null }
  }
  async function fetcher(path, options = {}) {
    const url = new URL(path, 'http://local.test')
    const parts = url.pathname.split('/').map(decodeURIComponent)
    calls.push({ path, options })
    if (parts[4] === 'history') return response(history(parts[3], url.searchParams.get('before')))
    if (parts[4] === 'messages') {
      const input = JSON.parse(options.body), existing = bot(parts[3]).rows.find(row => row.request.id === input.id)
      if (existing) return response({ request: existing.request, created: false })
      executions++
      return response({ request: append(parts[3], { ...input, status: 'running', text: '' }), created: true }, 202)
    }
    if (parts[2] === 'runs' && parts[4] === 'cancel') {
      for (const [botId, state] of bots) {
        const found = state.rows.find(row => row.request.id === parts[3])
        if (found) { update(botId, parts[3], { status: 'cancelled' }); return response({ request: { ...found.request, botId } }) }
      }
    }
    throw new Error(`Unexpected request ${options.method || 'GET'} ${path}`)
  }
  return { append, update, history, fetcher, calls, get executions() { return executions } }
}

test('full-Mac messages use the same request headers as regular messages', async () => {
  const api = server()
  const client = new ChatClient({ fetcher: api.fetcher })
  await client.send('a', 'Regular request', { ...runtime, computer: { scope: 'none' } })
  await client.send('a', 'Full access request', { ...runtime, computer: { scope: 'machine' } })
  const posts = api.calls.filter(call => call.path.endsWith('/messages'))
  assert.deepEqual(posts[0].options.headers, { 'content-type': 'application/json' })
  assert.deepEqual(posts[1].options.headers, { 'content-type': 'application/json' })
})

test('two clients and a reconnected client see identical persisted history and updates', async () => {
  const api = server(100), desktop = new ChatClient({ fetcher: api.fetcher }), phone = new ChatClient({ fetcher: api.fetcher })
  const note = api.append('a')
  await Promise.all([desktop.refresh('a'), phone.refresh('a')])
  assert.deepEqual(desktop.getSnapshot().histories, phone.getSnapshot().histories)
  phone.stop()
  api.update('a', note.id, { text: 'Changed on Mac', status: 'complete' })
  await desktop.send('a', 'New turn', runtime)
  const reconnected = new ChatClient({ fetcher: api.fetcher })
  await Promise.all([desktop.refresh('a'), phone.refresh('a'), reconnected.refresh('a')])
  assert.deepEqual(desktop.getSnapshot().histories, phone.getSnapshot().histories)
  assert.deepEqual(desktop.getSnapshot().histories, reconnected.getSnapshot().histories)
  assert.equal(api.executions, 1)
})

test('rapid identical sends coalesce through acceptance AND the follow-up history refresh', async () => {
  const api = server(), write = deferred(), read = deferred()
  let posts = 0
  const client = new ChatClient({ fetcher: async (path, options) => {
    if (options.method === 'POST') { posts++; await write.promise; return api.fetcher(path, options) }
    await read.promise; return api.fetcher(path, options)
  } })
  const first = client.send('a', 'One message', runtime), second = client.send('a', 'One message', runtime)
  assert.equal(posts, 1)
  write.resolve(); await flush()
  const third = client.send('a', 'One message', runtime)
  assert.equal(posts, 1, 'acknowledged sends still coalesce until the whole send settles')
  read.resolve()
  const results = await Promise.all([first, second, third])
  assert.ok(results.every(request => request.id === results[0].id))
  assert.equal(api.executions, 1)
  const deliberateRepeat = await client.send('a', 'One message', runtime)
  assert.notEqual(deliberateRepeat.id, results[0].id)
  assert.equal(api.executions, 2)
})

test('ambiguous responses keep the same run ID on retry, including malformed JSON and success bodies', async t => {
  const cases = {
    network: () => { throw new TypeError('Lost connection after commit') },
    'non-HTTP thrown status': () => { throw Object.assign(new Error('Local transport error'), { status: 400 }) },
    'truncated 202 JSON': () => new Response('{"request":', { status: 202 }),
    'HTML gateway error': () => new Response('<html>Gateway error</html>', { status: 502 }),
    'JSON 503 after commit': () => response({ error: 'Response failed after commit' }, 503),
    'HTTP timeout': () => response({ error: 'Timed out' }, 408),
    'missing acknowledgement': () => response({}, 202),
    'null acknowledgement': () => response(null, 202),
    'different request ID': () => response({ request: { id: 'wrong' } }, 202),
    'incomplete request': async accepted => response({ request: { id: (await accepted.json()).request.id } }, 202),
  }
  for (const [name, fail] of Object.entries(cases)) await t.test(name, async () => {
    const api = server(), ids = []
    const client = new ChatClient({ fetcher: async (path, options) => {
      if (options.method !== 'POST') return api.fetcher(path, options)
      ids.push(JSON.parse(options.body).id)
      const accepted = await api.fetcher(path, options)
      return ids.length === 1 ? fail(accepted) : accepted
    } })
    await assert.rejects(client.send('a', 'Retry me', runtime), /Bunji|confirm|response/i)
    const request = await client.send('a', 'Retry me', runtime)
    assert.equal(request.id, ids[0])
    assert.deepEqual(ids, [ids[0], ids[0]])
    assert.equal(api.executions, 1)
  })
})

test('a definite rejection releases the pending ID and labels the failing bot', async () => {
  const api = server(), ids = []
  const client = new ChatClient({ fetcher: async (path, options) => {
    if (options.method !== 'POST') return api.fetcher(path, options)
    ids.push(JSON.parse(options.body).id)
    return ids.length === 1 ? response({ error: 'Invalid model' }, 400) : api.fetcher(path, options)
  } })
  await assert.rejects(client.send('a', 'Try', runtime), error => error.status === 400 && error.botId === 'a' && /Invalid model/.test(error.message))
  await client.send('a', 'Try', runtime)
  assert.notEqual(ids[0], ids[1])
  assert.equal(api.executions, 1)
})

test('coalescing is per bot and full payload with memory enabled', async () => {
  const api = server(), wait = deferred()
  const client = new ChatClient({ fetcher: async (...args) => { await wait.promise; return api.fetcher(...args) } })
  const tasks = [client.send('a', 'Same', runtime), client.send('b', 'Same', runtime), client.send('a', 'Different', runtime)]
  wait.resolve()
  const requests = await Promise.all(tasks)
  assert.equal(new Set(requests.map(request => request.id)).size, 3)
  assert.equal(api.executions, 3)
  const bodies = api.calls.filter(call => call.path.endsWith('/messages')).map(call => JSON.parse(call.options.body))
  assert.ok(bodies.every(body => body.mode === 'agent' && body.memoryWrite === true))
})

test('Chat mode is sent explicitly and cannot claim memory writes', async () => {
  const api = server(), client = new ChatClient({ fetcher: api.fetcher })
  await client.send('a', 'Lean greeting', { ...runtime, mode: 'chat' })
  const body = JSON.parse(api.calls.find(call => call.path.endsWith('/messages')).options.body)
  assert.equal(body.mode, 'chat')
  assert.equal(body.memoryWrite, false)
})

test('a read started before a send cannot hide the accepted request', async () => {
  const api = server(), oldRead = deferred()
  let firstRead = true
  const client = new ChatClient({ fetcher: async (path, options) => {
    const reply = await api.fetcher(path, options)
    if (options.method !== 'POST' && firstRead) { firstRead = false; await oldRead.promise }
    return reply
  } })
  const beforeSend = client.refresh('a')
  const send = client.send('a', 'Accepted after the old snapshot', runtime)
  await flush(); oldRead.resolve()
  const [, accepted] = await Promise.all([beforeSend, send])
  assert.equal(client.getSnapshot().histories.a.requests[0].id, accepted.id)
})

test('valid bot IDs that match Object properties have no inherited errors', async () => {
  const api = server(), client = new ChatClient({ fetcher: api.fetcher })
  client.activate('constructor')
  assert.equal(client.getSnapshot().error, '')
  await client.refresh('constructor')
  assert.equal(client.getSnapshot().histories.constructor.ready, true)
})

test('switching bots during reads or sends keeps histories and errors scoped', async () => {
  const api = server(), slowA = deferred()
  api.append('a', { id: 'a-saved' }); api.append('b', { id: 'b-saved' })
  let failA = true
  const client = new ChatClient({ fetcher: async (path, options) => {
    if (path.includes('/bots/a/history') && failA) { await slowA.promise; return response({ error: 'A is offline' }, 503) }
    return api.fetcher(path, options)
  } })
  client.activate('a'); client.activate('b')
  await client.refresh('b')
  slowA.resolve(); await client.refresh('a')
  assert.equal(client.getSnapshot().histories.b.requests[0].id, 'b-saved')
  assert.equal(client.getSnapshot().error, '')
  assert.match(client.getSnapshot().errors.a, /A is offline/)
  await client.refresh('b')
  assert.match(client.getSnapshot().errors.a, /A is offline/, 'success for B cannot clear A error')
  failA = false
  client.activate('a')
  assert.match(client.getSnapshot().error, /A is offline/)
  await client.refresh('a')
  assert.equal(client.getSnapshot().error, '')
  const send = client.send('a', 'For A', runtime)
  client.activate('b')
  const accepted = await send
  assert.ok(client.getSnapshot().histories.a.requests.some(request => request.id === accepted.id))
  assert.equal(client.getSnapshot().histories.b.requests[0].id, 'b-saved')
})

test('a late send failure identifies its original bot without leaking a global error to the active bot', async () => {
  const api = server(), waiting = deferred()
  const client = new ChatClient({ fetcher: async (path, options) => {
    if (options.method === 'POST') { await waiting.promise; throw new Error('offline') }
    return api.fetcher(path, options)
  } })
  client.activate('a'); await client.refresh('a')
  const send = client.send('a', 'For A', runtime)
  client.activate('b'); await client.refresh('b')
  waiting.resolve()
  await assert.rejects(send, error => error.botId === 'a' && /bot.*a/i.test(error.message))
  assert.equal(client.getSnapshot().error, '')
})

test('polling preserves older pages, their cursor, and fills a gap when the live tail no longer overlaps', async () => {
  const api = server(), client = new ChatClient({ fetcher: api.fetcher })
  for (let i = 1; i <= 6; i++) api.append('a', { id: `r${i}` })
  await client.refresh('a'); await client.loadOlder('a')
  const before = client.getSnapshot().histories.a.nextBefore
  for (let i = 7; i <= 11; i++) api.append('a', { id: `r${i}` })
  await client.refresh('a')
  let history = client.getSnapshot().histories.a
  assert.deepEqual(history.requests.map(request => request.id), Array.from({ length: 9 }, (_, i) => `r${i + 3}`))
  assert.equal(history.nextBefore, before)
  await client.loadOlder('a')
  api.append('a', { id: 'r12' }); await client.refresh('a')
  history = client.getSnapshot().histories.a
  assert.deepEqual(history.requests.map(request => request.id), Array.from({ length: 12 }, (_, i) => `r${i + 1}`))
  assert.equal(history.hasMore, false)
  assert.equal(history.nextBefore, null)
})

test('an edit on another device refreshes an already loaded older message', async () => {
  const api = server(), client = new ChatClient({ fetcher: api.fetcher })
  for (let i = 1; i <= 6; i++) api.append('a', { id: `r${i}` })
  await client.refresh('a'); await client.loadOlder('a')
  api.update('a', 'r3', { prompt: 'Edited from phone' })
  await client.refresh('a')
  assert.equal(client.getSnapshot().histories.a.requests.find(item => item.id === 'r3').prompt, 'Edited from phone')
})

test('polling while an older page loads preserves the loading guard and merges either completion order', async t => {
  for (const olderFirst of [true, false]) await t.test(olderFirst ? 'older first' : 'poll first', async () => {
    const api = server(), olderGate = deferred(), pollGate = deferred()
    let hold = false
    const client = new ChatClient({ fetcher: async (path, options) => {
      const result = await api.fetcher(path, options)
      if (path.includes('?before=')) await olderGate.promise
      else if (hold) await pollGate.promise
      return result
    } })
    for (let i = 1; i <= 6; i++) api.append('a', { id: `r${i}` })
    await client.refresh('a')
    const older = client.loadOlder('a')
    api.append('a', { id: 'r7' }); hold = true
    const poll = client.refresh('a')
    if (olderFirst) { olderGate.resolve(); await older; pollGate.resolve(); await poll }
    else {
      pollGate.resolve(); await poll
      assert.equal(client.getSnapshot().histories.a.loadingOlder, true)
      await client.loadOlder('a')
      assert.equal(api.calls.filter(call => call.path.includes('?before=')).length, 1)
      olderGate.resolve(); await older
    }
    assert.deepEqual(client.getSnapshot().histories.a.requests.map(request => request.id), ['r3', 'r4', 'r5', 'r6', 'r7'])
    assert.equal(client.getSnapshot().histories.a.loadingOlder, false)
  })
})

test('malformed history cannot replace an already loaded transcript and exposes an actionable error', async () => {
  const api = server(); api.append('a')
  let broken = false
  const client = new ChatClient({ fetcher: (...args) => broken ? Promise.resolve(response({ revision: 9, requests: [] })) : api.fetcher(...args) })
  await client.refresh('a')
  const previous = client.getSnapshot().histories.a
  broken = true; await client.refresh('a')
  assert.equal(client.getSnapshot().histories.a, previous)
  assert.match(client.getSnapshot().error, /history|response/i)
})

test('stop clears only polling: no cancel request, no write abort, and accepted work still reconciles', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const api = server(), gate = deferred()
  let writeSignal
  const client = new ChatClient({ pollMs: 50, fetcher: async (path, options) => {
    if (options.method === 'POST') { writeSignal = options.signal; await gate.promise }
    return api.fetcher(path, options)
  } })
  t.after(() => client.stop())
  client.activate('a'); const stop = client.start(); await client.refresh('a')
  t.mock.timers.tick(50); await client.refresh('a')
  const count = api.calls.length
  const send = client.send('a', 'Keep running', runtime)
  stop(); t.mock.timers.tick(500)
  assert.equal(api.calls.length, count)
  assert.equal(writeSignal.aborted, false)
  gate.resolve(); const accepted = await send
  assert.equal(accepted.status, 'running')
  assert.ok(client.getSnapshot().histories.a.requests.some(request => request.id === accepted.id))
  assert.ok(api.calls.every(call => !call.path.endsWith('/cancel')))
})

test('explicit cancel refreshes the original bot even after the active bot changes', async () => {
  const api = server(), gate = deferred()
  api.append('a', { id: 'active-a', status: 'running' }); api.append('b', { id: 'saved-b' })
  const client = new ChatClient({ fetcher: async (path, options) => {
    if (path.endsWith('/cancel')) await gate.promise
    return api.fetcher(path, options)
  } })
  client.activate('a'); await client.refresh('a')
  const cancellation = client.cancel('active-a')
  client.activate('b'); await client.refresh('b')
  gate.resolve(); await cancellation
  assert.equal(client.getSnapshot().histories.a.requests[0].status, 'cancelled')
  assert.equal(client.getSnapshot().histories.b.requests[0].id, 'saved-b')
})
