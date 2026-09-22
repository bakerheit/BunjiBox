import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NativeChildClient, launchNativeClient } from '../child-client.mjs'
import { createNativeServer, parseLauncherArgs } from '../server.mjs'
import { requireDependency } from '../dependencies.mjs'
const { Client } = requireDependency('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = requireDependency('@modelcontextprotocol/sdk/inMemory.js')
const { StdioClientTransport } = requireDependency('@modelcontextprotocol/sdk/client/stdio.js')
const helper = fileURLToPath(new URL('./fake-helper.mjs', import.meta.url))
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url))

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.writes = []
  child.kills = []
  child.stdin = new Writable({ write(data, encoding, callback) { child.writes.push(JSON.parse(data)); callback() } })
  child.kill = signal => { child.kills.push(signal); if (signal === 'SIGKILL') child.emit('exit', null, signal); return true }
  child.reply = (id, result = {}) => child.stdout.write(JSON.stringify({ id, result }) + '\n')
  return child
}
function unit(t, options = {}) {
  const child = fakeChild()
  const client = new NativeChildClient(child, { killGraceMs: 5, ...options })
  t.after(() => client.close())
  return { child, client }
}
async function connected(t, mode, options = {}) {
  const native = launchNativeClient({ helper, target: 'fixture', env: { ...process.env, FAKE_NATIVE_MODE: mode ?? '' }, timeoutMs: 1000, killGraceMs: 20, ...options })
  t.after(() => native.close())
  const server = createNativeServer({ client: native })
  const client = new Client({ name: 'bridge-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  t.after(async () => { await client.close(); await server.close() })
  const call = (name, args = {}) => client.callTool({ name, arguments: args })
  return { native, server, client, call }
}

test('launcher requires exact parent opt-in; caller env cannot grant it', () => {
  const saved = process.env.BUNJI_NATIVE_EXPERIMENT
  try {
    for (const value of [undefined, '0', 'true']) {
      if (value === undefined) delete process.env.BUNJI_NATIVE_EXPERIMENT
      else process.env.BUNJI_NATIVE_EXPERIMENT = value
      assert.throws(() => launchNativeClient({ helper, env: { BUNJI_NATIVE_EXPERIMENT: '1' }, spawnImpl: () => assert.fail('must not spawn') }), /Parent must set/)
    }
  } finally {
    if (saved === undefined) delete process.env.BUNJI_NATIVE_EXPERIMENT
    else process.env.BUNJI_NATIVE_EXPERIMENT = saved
  }
})

test('launcher passes exact args, locked target and flag without a shell', t => {
  let actual
  const child = fakeChild()
  const client = launchNativeClient({ helper, target: 'fixture;no-shell', env: { BUNJI_NATIVE_EXPERIMENT: '0' },
    killGraceMs: 5, spawnImpl: (...args) => { actual = args; return child } })
  t.after(() => client.close())
  assert.equal(actual[0], helper)
  assert.deepEqual(actual[1], ['--stdio', '--target', 'fixture;no-shell'])
  assert.equal(actual[2].env.BUNJI_NATIVE_EXPERIMENT, '1')
  assert.equal(actual[2].shell, false)
  assert.throws(() => launchNativeClient({ helper: './relative' }), /absolute/)
  assert.throws(() => launchNativeClient({ helper, target: '' }), /target/)
  assert.deepEqual({ ...parseLauncherArgs(['--helper', helper]) }, { helper, target: 'fixture' })
  assert.throws(() => parseLauncherArgs(['--helper', helper, '--resume']), /Unknown option/)
})

test('NDJSON handles fragmented UTF-8, serial queue and helper errors', async t => {
  const { child, client } = unit(t)
  const first = client.request('status')
  const second = client.request('focus')
  assert.equal(child.writes.length, 1)
  const line = Buffer.from(JSON.stringify({ id: '1', result: { label: '🦊' } }) + '\n')
  for (const byte of line) child.stdout.write(Buffer.from([byte]))
  assert.deepEqual(await first, { label: '🦊' })
  assert.equal(child.writes.length, 2)
  child.stdout.write('{"id":"2","error":"denied"}\n')
  await assert.rejects(second, /denied/)
  const third = client.request('status')
  child.reply('3', { okay: true })
  assert.deepEqual(await third, { okay: true })
})

test('stop bypasses active work, cancels queued actions and reserves capacity', async t => {
  const { child, client } = unit(t, { maxInflight: 2 })
  const active = client.request('act', {})
  const queued = client.request('act', {})
  const rejected = assert.rejects(queued, /cancelled by stop/)
  const stop = client.request('stop')
  assert.deepEqual(child.writes.map(r => r.method), ['act', 'stop'])
  child.reply('3', { stopped: true })
  assert.deepEqual(await stop, { stopped: true })
  child.stdout.write('{"id":"1","error":"takeover"}\n')
  await assert.rejects(active, /takeover/)
  await rejected
  assert.equal(child.writes.length, 2)
  const other = unit(t, { maxInflight: 1 })
  const status = other.client.request('status')
  const stopAtLimit = other.client.request('stop')
  other.child.reply('2')
  other.child.reply('1')
  await Promise.all([status, stopAtLimit])
})

for (const [name, emit, pattern] of [
  ['unexpected ID', c => c.stdout.write('{"id":"x","result":{}}\n'), /unexpected/],
  ['unsent ID', c => c.stdout.write('{"id":"2","result":{}}\n'), /unexpected/],
  ['invalid JSON', c => c.stdout.write('nope\n'), /invalid JSON/],
  ['invalid UTF-8', c => c.stdout.write(Buffer.from([255, 10])), /UTF-8/],
  ['ambiguous envelope', c => c.stdout.write('{"id":"1","result":{},"error":"bad"}\n'), /envelope/],
  ['non-object result', c => c.stdout.write('{"id":"1","result":[]}\n'), /envelope/],
  ['oversize line', c => c.stdout.write('x'.repeat(513)), /byte limit/],
  ['EOF with partial line', c => { c.stdout.write('{'); c.stdout.end() }, /EOF/],
  ['exit', c => c.emit('exit', 1), /exited/],
  ['process error', c => c.emit('error', new Error('spawn')), /process error/],
  ['stdin error', c => c.stdin.emit('error', new Error('pipe')), /stdin error/],
]) test(`transport fails closed on ${name}`, async t => {
  const { child, client } = unit(t, { maxLineBytes: 512 })
  const p = client.request('status')
  const q = client.request('focus')
  const rejected = Promise.all([assert.rejects(p, pattern), assert.rejects(q, pattern)])
  emit(child)
  await rejected
  await assert.rejects(client.request('stop'), /transport failed/)
  if (name !== 'exit') assert.deepEqual(child.kills, ['SIGTERM'])
})

test('duplicate IDs in one chunk fail without dispatching queued work', async t => {
  const { child, client } = unit(t)
  const first = client.request('status')
  const second = client.request('focus')
  child.stdout.write('{"id":"1","result":{}}\n{"id":"1","result":{}}\n')
  await first
  await assert.rejects(second, /unexpected/)
  assert.equal(child.writes.length, 1)
})

test('inflight and outgoing byte limits fail closed', async t => {
  const { client } = unit(t, { maxInflight: 1 })
  const first = client.request('status')
  const second = client.request('focus')
  await Promise.all([assert.rejects(first, /inflight/), assert.rejects(second, /inflight/)])
  const other = unit(t, { maxLineBytes: 64 })
  await assert.rejects(other.client.request('act', { text: 'x'.repeat(100) }), /byte limit/)
})

test('deadline terminates unresponsive helper and escalates to SIGKILL', async t => {
  const { child, client } = unit(t, { timeoutMs: 15 })
  const killed = once(child, 'exit')
  await assert.rejects(client.request('act'), /response deadline/)
  await killed
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
})

test('actual SDK lists exact tools and returns image plus bounded untrusted metadata', async t => {
  const { client, call } = await connected(t)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['native_act', 'native_focus', 'native_observe', 'native_status', 'native_stop'])
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, ['native_status', 'native_observe'].includes(tool.name))
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.ok(!('target' in tool.inputSchema.properties))
  }
  const result = await call('native_observe')
  assert.equal(result.isError, undefined)
  assert.equal(result.content[1].type, 'image')
  assert.equal(result.content[1].mimeType, 'image/png')
  assert.ok(result.content[0].text.length < 24_200)
  assert.match(result.content[0].text, /^UNTRUSTED NATIVE DATA/)
  assert.ok(!result.content[0].text.includes('secretExtra'))
  assert.ok(!result.content[0].text.includes(result.content[1].data))
  const metadata = JSON.parse(result.content[0].text.split('\n').slice(1).join('\n'))
  assert.equal(metadata.elements.length, 50)
  assert.equal(metadata.elementsTruncated, true)
  assert.equal(metadata.frameId, 'frame-1')
  assert.equal((await call('native_status')).isError, undefined)
  assert.equal((await call('native_focus')).isError, undefined)
})

test('SDK rejects model target/resume injection and bad actions; native validates stale frames and pixel bounds', async t => {
  const { call } = await connected(t)
  for (const name of ['native_status', 'native_focus', 'native_observe', 'native_stop']) {
    assert.equal((await call(name, { target: 'other' })).isError, true)
    assert.equal((await call(name, { resume: true })).isError, true)
  }
  for (const action of [{ type: 'key', key: 'command+q' }, { type: 'click', x: -1, y: 0 }, { type: 'scroll', direction: 'up', amount: 1.5 }, { type: 'shell', command: 'whoami' }]) {
    assert.equal((await call('native_act', { frameId: 'frame-1', action })).isError, true)
  }
  const stale = await call('native_act', { frameId: 'old', action: { type: 'key', key: 'tab' } })
  assert.equal(stale.isError, true)
  assert.match(stale.content[0].text, /Stale frame/)
  const bounds = await call('native_act', { frameId: 'frame-1', action: { type: 'click', x: 100, y: 0 } })
  assert.match(bounds.content[0].text, /out of bounds/)
  for (const action of [{ type: 'click', x: 0, y: 0 }, { type: 'press', elementId: 'element-1' }, { type: 'type', text: 'hello' }, { type: 'key', key: 'command+n' }, { type: 'scroll', direction: 'down', amount: 2 }]) {
    assert.equal((await call('native_act', { frameId: 'frame-1', action })).isError, undefined)
  }
  await call('native_stop')
  assert.equal((await call('native_focus')).isError, true)
  assert.equal((await call('native_act', { frameId: 'frame-1', action: { type: 'key', key: 'return' } })).isError, true)
  assert.equal((await call('native_resume')).isError, true)
})

for (const mode of ['wrong-target', 'bad-image']) test(`SDK rejects ${mode} and terminates helper`, async t => {
  const { native, call } = await connected(t, mode)
  assert.equal((await call('native_observe')).isError, true)
  assert.ok(native.failure)
  assert.equal((await call('native_status')).isError, true)
})

for (const mode of ['exit', 'eof', 'timeout', 'oversize', 'ignore-term']) test(`real child lifecycle: ${mode}`, async t => {
  const native = launchNativeClient({ helper, env: { ...process.env, FAKE_NATIVE_MODE: mode }, timeoutMs: 200, maxLineBytes: 4096, killGraceMs: 20 })
  t.after(() => native.close())
  const exit = once(native.child, 'exit')
  await assert.rejects(native.request('status'), /transport failed/)
  const [, signal] = await exit
  if (mode === 'ignore-term') assert.equal(signal, 'SIGKILL')
  assert.equal(native.exited, true)
})

test('real stdio MCP handshake, calls and EOF clean up the helper', async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [serverPath, '--helper', helper], env: { ...process.env, FAKE_NATIVE_MODE: '' }, stderr: 'pipe' })
  const client = new Client({ name: 'stdio-test', version: '1' })
  t.after(() => client.close())
  await client.connect(transport)
  assert.equal((await client.listTools()).tools.length, 5)
  const status = await client.callTool({ name: 'native_status', arguments: {} })
  const data = JSON.parse(status.content[0].text.split('\n').slice(1).join('\n'))
  assert.equal(data.target, 'fixture')
  assert.equal(data.enabled, '1')
  await client.close()
  // SDK closes bridge stdin first. Give the OS a bounded chance to reap native.
  for (let i = 0; i < 40; i++) {
    try { process.kill(data.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('helper survived MCP stdio close')
})

test('actual stdio launcher fails without parent opt-in', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [serverPath, '--helper', helper], {
    env: { ...process.env, BUNJI_NATIVE_EXPERIMENT: '0' }, timeout: 2000,
  }), error => error.code === 1 && /Parent must set/.test(error.stderr) && error.stdout === '')
})

test('missing helper and invalid transport options do not leak a child', async t => {
  assert.throws(() => launchNativeClient({ helper, timeoutMs: 0, spawnImpl: () => assert.fail('must not spawn') }), /Invalid timeoutMs/)
  const native = launchNativeClient({ helper: '/nonexistent-bunji-native-test-helper' })
  t.after(() => native.close())
  const closed = new Promise(resolve => native.child.once('close', resolve))
  await assert.rejects(native.request('status'), /process error/)
  await closed
  assert.equal(native.exited, true)
})

test('actual SDK reports transport deadline as tool error and does not restart', async t => {
  const { call, native } = await connected(t, 'timeout', { timeoutMs: 100 })
  const exit = once(native.child, 'exit')
  const result = await call('native_act', { frameId: 'frame-1', action: { type: 'key', key: 'tab' } })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /transport failed.*response deadline/)
  await exit
  assert.equal((await call('native_status')).isError, true)
})

test('actual SDK cancellation closes helper instead of leaving control running', async t => {
  const { client, native } = await connected(t, 'timeout')
  const controller = new AbortController()
  const result = client.callTool({ name: 'native_act', arguments: { frameId: 'frame-1', action: { type: 'key', key: 'tab' } } }, undefined, { signal: controller.signal })
  const rejected = assert.rejects(result)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(native.pending.size, 1)
  const exit = once(native.child, 'exit')
  controller.abort()
  await rejected
  await exit
  assert.ok(native.failure)
  assert.equal(native.exited, true)
})
