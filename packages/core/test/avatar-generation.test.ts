import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { access } from 'node:fs/promises'
import { setImmediate as tick } from 'node:timers/promises'
import { avatarImageData, createAvatarGenerations, generateAvatar } from '../src/avatar-generation.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const image = `data:image/png;base64,${png}`
const id = n => `avatar-test-${String(n).padStart(8, '0')}`
const body = (n, prompt: unknown = 'A teal robot') => ({ id: id(n), prompt })

function jobs(t, options = {}) {
  const calls = []
  const service = createAvatarGenerations({ ...options, generate: (prompt, { signal }) => new Promise((resolve, reject) => {
    calls.push({ prompt, signal, resolve, reject })
  }) })
  t.after(async () => { for (const call of calls) call.resolve(image); await service.close() })
  return { service, calls }
}

test('avatar jobs reuse trimmed prompts and IDs, reject conflicts, and return detached snapshots', async t => {
  const { service, calls } = jobs(t)
  const initial = service.start(body(1, '  A teal robot  '))
  assert.deepEqual(initial, { id: id(1), status: 'running', image: null, error: null })
  assert.deepEqual(service.start(body(1)), initial)
  assert.throws(() => service.start(body(1, 'Different picture')), { status: 409 })
  initial.status = 'failed'
  assert.equal(service.get(id(1)).status, 'running')
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, 'A teal robot')
  calls[0].resolve(image)
  await tick()
  assert.deepEqual(service.start(body(1)), { id: id(1), status: 'complete', image, error: null })
  assert.equal(service.cancel(id(1)).status, 'complete')
  assert.equal(calls.length, 1)
})

test('cancellation aborts the signal and ignores both late success and late failure', async t => {
  for (const outcome of ['resolve', 'reject']) {
    const { service, calls } = jobs(t)
    service.start(body(1)); await tick()
    const cancelled = service.cancel(id(1))
    assert.deepEqual(cancelled, { id: id(1), status: 'cancelled', image: null, error: null })
    assert.equal(calls[0].signal.aborted, true)
    assert.deepEqual(service.cancel(id(1)), cancelled)
    calls[0][outcome](outcome === 'resolve' ? image : new Error('Late failure'))
    await tick()
    assert.deepEqual(service.get(id(1)), cancelled)
    assert.deepEqual(service.start(body(1)), cancelled)
    assert.equal(calls.length, 1)
  }
})

test('terminal failure is bounded and retrying its ID never starts another paid job', async t => {
  const { service, calls } = jobs(t)
  service.start(body(1)); await tick()
  calls[0].reject(new Error('x'.repeat(700))); await tick()
  assert.deepEqual(service.get(id(1)), { id: id(1), status: 'failed', image: null, error: 'x'.repeat(500) })
  assert.equal(service.start(body(1)).status, 'failed')
  assert.equal(service.cancel(id(1)).status, 'failed')
  assert.equal(calls.length, 1)
  assert.equal(service.start(body(2)).status, 'running')
  await tick()
})

test('two active jobs block a third but allow idempotent retries and replacement after cancel', async t => {
  const { service, calls } = jobs(t)
  service.start(body(1)); service.start(body(2)); await tick()
  assert.throws(() => service.start(body(3)), { status: 429 })
  assert.equal(service.start(body(1)).status, 'running')
  service.cancel(id(1)); calls[0].resolve(image); await tick()
  assert.equal(service.start(body(3)).status, 'running')
  await tick()
  assert.equal(calls.length, 3)
})

test('eight retained previews fill the cache; TTL expiry frees it without expiring active jobs', async t => {
  let now = 1000
  const { service, calls } = jobs(t, { now: () => now, retentionMs: 100 })
  for (let n = 0; n < 8; n++) {
    service.start(body(n)); await tick()
    calls[n].resolve(image); await tick()
  }
  assert.throws(() => service.start(body(8)), { status: 429 })
  now = 1100
  assert.equal(service.get(id(0)).status, 'complete', 'TTL is exclusive')
  now = 1101
  assert.throws(() => service.get(id(0)), { status: 404 })
  service.start(body(8)); await tick()
  now = 100000
  assert.equal(service.get(id(8)).status, 'running')
})

test('shutdown aborts all active jobs, waits for them, clears previews, and rejects new starts', async t => {
  const { service, calls } = jobs(t)
  service.start(body(1)); service.start(body(2)); await tick()
  let closed = false
  const closing = service.close().then(() => { closed = true })
  assert.ok(calls.every(call => call.signal.aborted))
  assert.throws(() => service.start(body(3)), { status: 503 })
  await tick(); assert.equal(closed, false)
  calls[0].resolve(image); calls[1].reject(new Error('Aborted'))
  await closing
  assert.throws(() => service.get(id(1)), { status: 404 })
  await service.close()
})

test('input limits reject invalid bodies before invoking generation and accept exact boundaries', async t => {
  const { service, calls } = jobs(t)
  for (const value of [null, [], 'text', {}, { ...body(1), extra: true },
    body(1, ''), body(1, ' \n\t'), body(1, 123), body(1, 'x'.repeat(2001)),
    { ...body(1), id: 'x'.repeat(15) }, { ...body(1), id: 'x'.repeat(81) },
    { ...body(1), id: '../invalid/request' }]) {
    assert.throws(() => service.start(value), { status: 400 })
  }
  assert.throws(() => service.get(id(99)), { status: 404 })
  assert.throws(() => service.cancel(id(99)), { status: 404 })
  await tick(); assert.equal(calls.length, 0)
  service.start({ id: 'a'.repeat(16), prompt: 'x' })
  service.start({ id: 'b'.repeat(80), prompt: 'x'.repeat(2000) })
  await tick(); assert.equal(calls.length, 2)
})

test('image output accepts supported signatures and rejects paths, URLs, invalid/oversized data', () => {
  assert.equal(avatarImageData(png), image)
  assert.match(avatarImageData(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')), /^data:image\/jpeg;base64,/)
  assert.match(avatarImageData(Buffer.from('RIFF0000WEBP').toString('base64')), /^data:image\/webp;base64,/)
  for (const value of [null, '', '/tmp/picture.png', 'https://example.test/image.png',
    'data:image/png;base64,' + png, '<svg/>', Buffer.from('GIF89a').toString('base64'),
    'a'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 1)]) {
    assert.throws(() => avatarImageData(value), { status: 400 })
  }
})

function rpc({ account = 'chatgpt', onTurn, initializeError, silent = false, ignoreTerm = false }: {
  account?: string; onTurn?: (mock: { send: (message: unknown) => void; child: any }) => void; initializeError?: string; silent?: boolean; ignoreTerm?: boolean
} = {}) {
  const child: any = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.exitCode = null
  const messages = [], kills = []
  let spawnOptions, spawnArgs
  const ready = Promise.withResolvers<void>()
  const send = message => child.stdout.write(JSON.stringify(message) + '\n')
  child.kill = signal => {
    kills.push(signal)
    if (ignoreTerm && signal === 'SIGTERM') return true
    setImmediate(() => { child.exitCode = 0; child.emit('exit', 0) })
    return true
  }
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line); messages.push(message)
      queueMicrotask(() => {
        if (silent) return
        if (message.method === 'initialize') send(initializeError
          ? { id: message.id, error: { message: initializeError } } : { id: message.id, result: {} })
        else if (message.method === 'account/read') send({ id: message.id, result: { account: { type: account } } })
        else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'avatar-thread' } } })
        else if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'avatar-turn' } } })
          ready.resolve()
          onTurn?.({ send, child })
        }
      })
    }
  })
  return { child, messages, kills, ready: ready.promise, send,
    get cwd() { return spawnOptions.cwd }, get args() { return spawnArgs },
    spawnProcess(command, args, options) {
      assert.equal(command, 'codex'); spawnArgs = args; spawnOptions = options
      return child
    },
  }
}

test('mock Codex RPC initializes ChatGPT, isolates its thread, rejects tool RPCs, and accepts chunked native image output', async () => {
  const f = rpc({ onTurn: ({ send, child }) => {
    send({ id: 'forbidden-tool', method: 'item/commandExecution/requestApproval', params: {} })
    child.stdout.write('not json\n')
    const line = JSON.stringify({ method: 'item/completed', params: { item: { type: 'imageGeneration', status: 'completed', result: png } } }) + '\n'
    child.stdout.write(line.slice(0, 40)); child.stdout.write(line.slice(40))
  } })
  assert.equal(await generateAvatar('A teal robot', { spawnProcess: f.spawnProcess }), image)
  assert.deepEqual(f.messages.filter(m => m.method).map(m => m.method), ['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start'])
  const thread = f.messages.find(m => m.method === 'thread/start').params
  assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.approvalPolicy, 'never')
  assert.deepEqual(thread.config.mcp_servers, {})
  assert.equal(thread.config.project_doc_max_bytes, 0)
  assert.equal(thread.config.web_search, 'disabled')
  assert.ok(f.args.includes('image_generation') && f.args.includes('shell_tool'))
  assert.match(f.messages.find(m => m.method === 'turn/start').params.input[0].text, /A teal robot$/)
  assert.equal(f.messages.find(m => m.id === 'forbidden-tool').error.code, -32601)
  assert.deepEqual(f.kills, ['SIGTERM'])
  await assert.rejects(access(f.cwd), { code: 'ENOENT' })
})

test('mock RPC rejects non-ChatGPT auth and initialization errors without starting a turn', async () => {
  for (const options of [{ account: 'apiKey' }, { initializeError: 'Mock RPC failure' }]) {
    const f = rpc(options)
    await assert.rejects(generateAvatar('robot', { spawnProcess: f.spawnProcess }), options.account ? /ChatGPT account/ : /Mock RPC failure/)
    assert.ok(!f.messages.some(m => m.method === 'turn/start'))
    await assert.rejects(access(f.cwd), { code: 'ENOENT' })
  }
})

test('mock RPC handles native failure, missing image, unsupported output, and provider errors', async () => {
  for (const [notification, pattern] of [
    [{ method: 'item/completed', params: { item: { type: 'imageGeneration', status: 'failed' } } }, /could not generate/],
    [{ method: 'turn/completed', params: {} }, /without returning an image/],
    [{ method: 'item/completed', params: { item: { type: 'imageGeneration', result: 'https://example.test/image' } } }, /supported image/],
    [{ method: 'error', params: { error: { message: 'Mock provider failure' }, willRetry: false } }, /Mock provider failure/],
  ]) {
    const f = rpc({ onTurn: ({ send }) => send(notification) })
    await assert.rejects(generateAvatar('robot', { spawnProcess: f.spawnProcess }), pattern)
    assert.deepEqual(f.kills, ['SIGTERM'])
  }
})

test('mock RPC cancellation stops active generation and an already aborted signal never spawns', async () => {
  const controller = new AbortController(), f = rpc()
  const result = generateAvatar('robot', { spawnProcess: f.spawnProcess, signal: controller.signal })
  const rejected = assert.rejects(result, /cancelled/)
  await f.ready; controller.abort(); await rejected
  assert.deepEqual(f.kills, ['SIGTERM'])
  await assert.rejects(access(f.cwd), { code: 'ENOENT' })
  let spawns = 0
  await assert.rejects(generateAvatar('robot', { signal: controller.signal, spawnProcess: () => { spawns++; throw new Error('Must not spawn') } }), /cancelled/)
  assert.equal(spawns, 0)
})

test('mock RPC startup timeout and early process exit fail cleanly', async () => {
  const f = rpc({ silent: true })
  await assert.rejects(generateAvatar('robot', { spawnProcess: f.spawnProcess, startupTimeoutMs: 10 }), /did not connect/)
  assert.deepEqual(f.kills, ['SIGTERM'])
  const exited = rpc({ onTurn: ({ child }) => { child.exitCode = 1; child.emit('exit', 1) } })
  await assert.rejects(generateAvatar('robot', { spawnProcess: exited.spawnProcess }), /closed before returning/)
  await assert.rejects(access(exited.cwd), { code: 'ENOENT' })
})

test('cancellation force-kills a mock child that ignores SIGTERM after the two-second grace period', { timeout: 5000 }, async t => {
  const controller = new AbortController(), f = rpc({ ignoreTerm: true })
  const result = generateAvatar('robot', { spawnProcess: f.spawnProcess, signal: controller.signal })
  const rejected = assert.rejects(result, /cancelled/)
  await f.ready
  // Advance only the shutdown timer; startup and RPC have already completed.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  controller.abort()
  assert.deepEqual(f.kills, ['SIGTERM'])
  assert.equal(f.child.exitCode, null, 'The mock is still alive after ignoring TERM')
  t.mock.timers.tick(1999)
  assert.deepEqual(f.kills, ['SIGTERM'], 'Do not escalate before the grace period')
  await tick()
  await access(f.cwd) // Keep the temporary workspace until the child actually exits.
  t.mock.timers.tick(1)
  assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL'], 'Cancellation keeps escalation armed until the child exits')
  await rejected
  await tick()
  assert.equal(f.child.exitCode, 0, 'The mock exits after KILL')
  t.mock.timers.tick(4000)
  assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL'], 'No repeated kill after exit')
  await assert.rejects(access(f.cwd), { code: 'ENOENT' })
})

test('cancellation clears the force-kill timer when the mock child exits on SIGTERM', { timeout: 5000 }, async t => {
  const controller = new AbortController(), f = rpc()
  const result = generateAvatar('robot', { spawnProcess: f.spawnProcess, signal: controller.signal })
  const rejected = assert.rejects(result, /cancelled/)
  await f.ready
  t.mock.timers.enable({ apis: ['setTimeout'] })
  controller.abort()
  await rejected
  await tick()
  assert.equal(f.child.exitCode, 0)
  t.mock.timers.tick(4000)
  assert.deepEqual(f.kills, ['SIGTERM'], 'An exited child must not receive SIGKILL')
})
