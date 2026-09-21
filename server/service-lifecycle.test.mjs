import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { openChatStore } from '../core/chat-store.mjs'
import { ensureChatService } from '../cli/service.mjs'

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))
const fingerprint = directory => createHash('sha256').update(directory).digest('hex')
const seed = (id, extra = {}) => ({ id, botId: 'bunjibox', prompt: 'A test-only message. No provider should run.', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', ...extra })

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function privatePort() {
  const reservation = net.createServer()
  const port = await listening(reservation)
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return port
}

function request(port, path, { method = 'GET', headers = {}, body, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, response => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { raw += chunk })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(raw) }) }
        catch { reject(new Error(`HTTP ${response.statusCode} returned non-JSON: ${raw.slice(0, 300)}`)) }
      })
    })
    req.setTimeout(2000, () => req.destroy(new Error('Test HTTP request timed out')))
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function waitForExit(process, timeoutMs = 5000) {
  let timer
  try {
    return await Promise.race([
      process.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Server did not exit within ${timeoutMs}ms. ${process.logs()}`)), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

async function fixture(t) {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'bunji-service-lifecycle-'))
  const workspace = join(temp, 'workspace'), emptyPath = join(temp, 'empty-bin')
  await Promise.all([mkdir(workspace), mkdir(emptyPath)])
  const processes = [], stores = new Set(), servers = new Set()
  t.after(async () => {
    // Only processes, sockets and files created by this fixture are cleaned up.
    for (const server of servers) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.() })
    }
    for (const process of processes) {
      if (!process.closed) process.child.kill('SIGTERM')
      try { await waitForExit(process, 1500) }
      catch { process.child.kill('SIGKILL'); await waitForExit(process) }
    }
    for (const store of stores) store.close()
    await rm(temp, { recursive: true, force: true })
  })

  function store(directory = workspace) {
    const opened = openChatStore({ path: join(directory, 'workspace.sqlite') })
    stores.add(opened)
    return opened
  }

  function launch(port, directory = workspace) {
    const child = spawn(process.execPath, [entry], {
      cwd: temp,
      // Real server, no provider stubs. Only health/history/run reads and memory
      // CRUD/cancel routes are used. Empty PATH also prevents a provider launch.
      env: { ...process.env, BUNJI_DATA_DIR: directory, BUNJI_API_PORT: String(port), PATH: emptyPath, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    const running = { child, port, closed: false, logs: () => stdout + '\n' + stderr }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000) })
    child.on('error', error => { stderr += error.message })
    running.exited = new Promise(resolve => child.once('close', (code, signal) => { running.closed = true; resolve({ code, signal }) }))
    processes.push(running)
    return running
  }

  async function ready(running) {
    const deadline = Date.now() + 7000
    while (Date.now() < deadline) {
      assert.equal(running.closed, false, `Server exited before becoming ready: ${running.logs()}`)
      if (running.logs().includes(`local API listening on http://127.0.0.1:${running.port}`)) {
        const health = await request(running.port, '/api/health')
        assert.equal(health.status, 200)
        return health.data
      }
      await delay(20)
    }
    assert.fail(`Server never became ready: ${running.logs()}`)
  }

  async function start(directory = workspace) {
    const running = launch(await privatePort(), directory)
    running.health = await ready(running)
    return running
  }

  async function stop(running) {
    assert.equal(running.child.kill('SIGTERM'), true)
    assert.deepEqual(await waitForExit(running), { code: 0, signal: null }, running.logs())
    assert.doesNotMatch(running.logs(), /ERR_INVALID_STATE|database is not open|unhandled rejection/i)
    await assert.rejects(request(running.port, '/api/health'), error => error.code === 'ECONNREFUSED')
  }

  return { temp, workspace, processes, servers, store, launch, ready, start, stop }
}

test('real server recovers interrupted rows exactly once and persisted GETs survive a graceful restart', { timeout: 20000 }, async t => {
  const f = await fixture(t), chats = f.store()
  chats.start(seed('complete'))
  chats.finish('complete', { text: 'Saved answer 🍋\nA second line.', usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 }, durationMs: 120 })
  chats.start(seed('interrupted', { memoryWrite: true, contextTurns: 1, omittedTurns: 2 }))
  chats.addActivity('interrupted', { id: 'pending-tool', kind: 'tool', title: 'Test activity', status: 'running' })
  const before = chats.history('bunjibox'), completed = chats.get('complete')
  const first = await f.start()
  assert.deepEqual(first.health, { service: 'bunji', continuity: 1, workspace: fingerprint(f.workspace), cwd: f.temp })
  assert.equal(chats.history('bunjibox').revision, before.revision + 1)
  assert.deepEqual(chats.get('complete'), completed)
  const recovered = chats.get('interrupted')
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.activities[0].status, 'unknown')
  assert.match(recovered.error, /restart.*not retried/i)
  assert.equal(recovered.memoryWrite, true)
  assert.equal(recovered.contextTurns, 1)
  assert.equal(recovered.omittedTurns, 2)
  assert.ok(recovered.durationMs >= 0)
  const history = await request(first.port, '/api/bots/bunjibox/history')
  assert.equal(history.status, 200)
  assert.equal(history.headers['cache-control'], 'no-store')
  assert.deepEqual(history.data, chats.history('bunjibox'))
  const persisted = await request(first.port, '/api/runs/complete')
  assert.deepEqual(persisted.data, { request: completed })
  assert.deepEqual((await request(first.port, '/api/runs/interrupted')).data, { request: recovered })
  assert.equal((await request(first.port, '/api/runs/missing')).status, 404)
  await f.stop(first)

  const restart = f.launch(first.port)
  assert.deepEqual(await f.ready(restart), first.health)
  assert.deepEqual((await request(restart.port, '/api/bots/bunjibox/history')).data, history.data, 'restart does not recover already terminal rows or bump their revision')
  assert.deepEqual((await request(restart.port, '/api/runs/complete')).data, persisted.data)
  assert.deepEqual(chats.get('interrupted'), recovered)
  assert.deepEqual(chats.listRunning(), [])
  await f.stop(restart)
})

test('a second service on either the same or a different port cannot mutate the active workspace', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = await f.start(), chats = f.store()
  // Seed only after the live server has finished startup recovery. There is no
  // real provider here; this row represents work owned by the listening process.
  chats.start(seed('currently-running'))
  chats.addActivity('currently-running', { id: 'working', kind: 'notice', title: 'Keep running', status: 'running' })
  const row = chats.get('currently-running'), history = chats.history('bunjibox')
  for (const port of [first.port, await privatePort()]) {
    const second = f.launch(port)
    const failed = await waitForExit(second)
    assert.notEqual(failed.code, 0)
    assert.equal(failed.signal, null)
    assert.match(second.logs(), /BUNJI_WORKSPACE_IN_USE/)
    assert.doesNotMatch(second.logs(), /local API listening/)
  }
  assert.deepEqual(chats.get('currently-running'), row)
  assert.deepEqual(chats.history('bunjibox'), history, 'failed bind must not bump the chat revision')
  assert.deepEqual((await request(first.port, '/api/runs/currently-running')).data, { request: row })
  assert.deepEqual((await request(first.port, '/api/health')).data, first.health)
  assert.equal(first.child.exitCode, null)
  // Finish the simulated work through its owner (the test store).
  chats.finish(row.id, { text: 'Test owner completed the row.' })
  await f.stop(first)
})

test('a killed service releases the OS lease and the next owner recovers the interrupted run', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = await f.start(), chats = f.store()
  chats.start(seed('crashed-owner'))
  assert.equal(first.child.kill('SIGKILL'), true)
  assert.equal((await waitForExit(first)).signal, 'SIGKILL')
  const next = await f.start()
  assert.equal(chats.get('crashed-owner').status, 'interrupted')
  assert.match(chats.get('crashed-owner').error, /not retried/)
  await f.stop(next)
})

test('port binding failure releases the workspace lease without recovering its saved requests', { timeout: 20000 }, async t => {
  const f = await fixture(t), occupied = net.createServer(), port = await listening(occupied)
  f.servers.add(occupied)
  const chats = f.store()
  chats.start(seed('not-recovered-on-bind-failure'))
  const original = chats.history('bunjibox')
  const failed = f.launch(port)
  assert.notEqual((await waitForExit(failed)).code, 0)
  assert.match(failed.logs(), /EADDRINUSE/)
  assert.deepEqual(chats.history('bunjibox'), original)
  const next = await f.start()
  assert.equal(chats.get('not-recovered-on-bind-failure').status, 'interrupted')
  await f.stop(next)
})

test('workspace fingerprints reject a conflicting client without replacing the live service', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = await f.start()
  const foreign = join(f.temp, 'other-workspace')
  await mkdir(foreign)
  const foreignStore = f.store(foreign)
  foreignStore.start(seed('other-pending'))
  const original = foreignStore.history('bunjibox')
  let launches = 0
  const spawnProcess = () => { launches++; throw new Error('Must not launch over an existing service') }
  const options = { cwd: f.temp, port: first.port, spawnProcess, timeoutMs: 2000 }
  const connected = await ensureChatService({ ...options, workspace: f.workspace })
  assert.equal(connected.started, false)
  assert.equal(connected.baseUrl, `http://127.0.0.1:${first.port}`)
  await assert.rejects(ensureChatService({ ...options, workspace: foreign }), /different workspace/)
  await assert.rejects(ensureChatService({ ...options, workspace: f.workspace, cwd: foreign, explicitCwd: true }), /--cwd requested/)
  assert.equal(launches, 0)
  assert.deepEqual(foreignStore.history('bunjibox'), original)
  assert.deepEqual((await request(first.port, '/api/health')).data, first.health)
  await f.stop(first)
})

test('real continuity routes preserve the proxy host and reject foreign-origin mutations', { timeout: 20000 }, async t => {
  const f = await fixture(t), server = await f.start(), chats = f.store()
  const proxy = http.createServer((incoming, outgoing) => {
    const forwarded = http.request({ host: '127.0.0.1', port: server.port, method: incoming.method, path: incoming.url, headers: incoming.headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode, response.headers)
      response.pipe(outgoing)
    })
    forwarded.on('error', () => { outgoing.writeHead(502); outgoing.end() })
    incoming.pipe(forwarded)
  })
  f.servers.add(proxy)
  const proxyPort = await listening(proxy), origin = `http://127.0.0.1:${proxyPort}`
  const path = '/api/bots/bunjibox/memory'
  const accepted = await request(proxyPort, path, { method: 'POST', headers: { origin }, body: { title: 'Proxy note', body: 'Saved through the browser-facing host.' } })
  assert.equal(accepted.status, 200)
  const note = accepted.data.note
  const foreign = { origin: 'http://foreign.invalid', 'x-forwarded-host': `127.0.0.1:${proxyPort}` }
  assert.equal((await request(proxyPort, `${path}/${note.id}`, { method: 'PATCH', headers: foreign, body: { title: 'Bad change', body: 'Do not save', expectedRevision: note.revision } })).status, 403)
  assert.deepEqual((await request(proxyPort, `${path}/${note.id}`)).data, { note })
  chats.start(seed('cancel-via-proxy'))
  const before = chats.history('bunjibox')
  assert.equal((await request(proxyPort, '/api/runs/cancel-via-proxy/cancel', { method: 'POST', headers: foreign, body: {} })).status, 403)
  assert.deepEqual(chats.history('bunjibox'), before)
  const cancelled = await request(proxyPort, '/api/runs/cancel-via-proxy/cancel', { method: 'POST', headers: { origin }, body: {} })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.data.request.status, 'cancelled')
  await f.stop(server)
})

test('SIGTERM closes an idle keep-alive connection and releases the port cleanly', { timeout: 15000 }, async t => {
  const f = await fixture(t), server = await f.start()
  const agent = new http.Agent({ keepAlive: true })
  t.after(() => agent.destroy())
  assert.equal((await request(server.port, '/api/health', { agent })).status, 200)
  assert.ok(Object.values(agent.freeSockets).some(sockets => sockets.length > 0))
  await f.stop(server)
  const reservation = net.createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(server.port, '127.0.0.1', resolve)
  })
  await new Promise(resolve => reservation.close(resolve))
})
