import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { ensureChatService } from './service.mjs'

const exec = promisify(execFile)
const index = fileURLToPath(new URL('./index.mjs', import.meta.url))
const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))
const workspace = '/fixture/bunji-data', cwd = '/fixture/working-directory'
const health = changes => ({ service: 'bunji', continuity: 1, workspace: createHash('sha256').update(workspace).digest('hex'), cwd, ...changes })
const response = (body = health(), status = 200) => new Response(JSON.stringify(body), { status })
const absent = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
const options = { cwd, workspace, port: 4318, pollMs: 1, timeoutMs: 100 }
const noSpawn = () => { assert.fail('Must not spawn a service') }
function launcher() {
  const calls = []
  const spawnProcess = (...args) => {
    const child = new EventEmitter()
    child.unref = () => { child.unreferenced = true }
    child.kill = () => assert.fail('Must never kill a service')
    calls.push({ args, child }); return child
  }
  return { calls, spawnProcess }
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bunji-cli-service-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('verified running service is reused and actual cwd is reported', async () => {
  const requests = []
  const result = await ensureChatService({ ...options, fetcher: async (...args) => { requests.push(args); return response() }, spawnProcess: noSpawn })
  assert.deepEqual(result, { baseUrl: 'http://127.0.0.1:4318', cwd, notice: '', started: false })
  assert.equal(requests[0][0], 'http://127.0.0.1:4318/api/health')
  assert.equal(requests[0][1].redirect, 'error')
  const different = await ensureChatService({ ...options, fetcher: async () => response(health({ cwd: '/actual/service-cwd' })), spawnProcess: noSpawn })
  assert.equal(different.cwd, '/actual/service-cwd')
  assert.match(different.notice, /actual\/service-cwd/)
})

test('old, unknown, mismatched, malformed and unresponsive services never spawn or get replaced', async () => {
  for (const [fetcher, pattern] of [
    [async () => response({ error: 'Not found' }, 404), /Restart Bunji with npm run api/],
    [async () => response(health({ service: 'other' })), /unknown service/],
    [async () => response(health({ continuity: 0 })), /incompatible/],
    [async () => response(health({ workspace: 'wrong' })), /different workspace/],
    [async () => response(health({ cwd: 'relative-path' })), /incompatible/],
    [async () => new Response('<html>Other app</html>'), /not JSON/],
    [async () => response({}, 503), /HTTP 503/],
    [async () => { throw new Error('Timeout') }, /Cannot verify/],
  ]) await assert.rejects(ensureChatService({ ...options, fetcher, spawnProcess: noSpawn }), pattern)
  await assert.rejects(ensureChatService({ ...options, explicitCwd: true, fetcher: async () => response(health({ cwd: '/other/project' })), spawnProcess: noSpawn }), /--cwd requested.*running Bunji service works in \/other\/project/)
})

test('only connection refusal starts detached Node with an absolute entry and chosen cwd', async () => {
  const launch = launcher(); let probes = 0
  const result = await ensureChatService({ ...options, explicitCwd: true, port: '48231', spawnProcess: launch.spawnProcess,
    fetcher: async () => ++probes < 3 ? absent() : response() })
  assert.equal(result.started, true)
  assert.equal(launch.calls.length, 1)
  const { args, child } = launch.calls[0]
  assert.equal(args[0], process.execPath)
  assert.deepEqual(args[1], [entry])
  assert.equal(args[2].cwd, cwd)
  assert.equal(args[2].env.BUNJI_API_PORT, '48231')
  assert.equal(args[2].detached, true)
  assert.equal(args[2].stdio, 'ignore')
  assert.equal(args[2].shell, false)
  assert.equal(child.unreferenced, true)
})

test('simultaneous launchers accept the port winner without killing either child', async () => {
  const launch = launcher(); let probes = 0
  const fetcher = async () => ++probes <= 2 ? absent() : response()
  const results = await Promise.all([ensureChatService({ ...options, fetcher, spawnProcess: launch.spawnProcess }), ensureChatService({ ...options, fetcher, spawnProcess: launch.spawnProcess })])
  assert.equal(launch.calls.length, 2)
  assert.ok(results.every(result => result.cwd === cwd))
})

test('launcher reports startup errors and bounded timeouts without touching other processes', async () => {
  const launch = launcher()
  await assert.rejects(ensureChatService({ ...options, timeoutMs: 5, fetcher: async () => absent(), spawnProcess: launch.spawnProcess }), /did not become ready/)
  await assert.rejects(ensureChatService({ ...options, fetcher: async () => absent(), spawnProcess: (...args) => {
    const child = launch.spawnProcess(...args)
    queueMicrotask(() => child.emit('error', new Error('Cannot execute Node')))
    return child
  } }), /Could not start Bunji: Cannot execute Node/)
  for (const port of ['bad', '4318;echo', 0, -1, 1.5, 65536]) {
    await assert.rejects(ensureChatService({ ...options, port, fetcher: () => assert.fail('Must not probe'), spawnProcess: noSpawn }), /BUNJI_API_PORT/)
  }
})

test('real loopback health check verifies identity without starting the real app or opening its DB', async t => {
  const dir = await directory(t)
  const server = http.createServer((_request, reply) => { reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(health({ cwd: dir }))) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const result = await ensureChatService({ ...options, cwd: dir, explicitCwd: true, port: server.address().port, spawnProcess: noSpawn })
  assert.equal(result.cwd, dir)
  assert.equal(result.started, false)
})

test('CLI help and nonterminal errors do not start a service or create workspace data', async t => {
  const dir = await directory(t), data = join(dir, 'data')
  const env = { ...process.env, BUNJI_DATA_DIR: data, BUNJI_API_PORT: 'bad-port-must-not-be-read' }
  const { stdout } = await exec(process.execPath, [index, '--help'], { env })
  assert.match(stdout, /memory tools/i)
  assert.match(stdout, /Exit detaches/)
  await assert.rejects(exec(process.execPath, [index], { env }), error => /needs a terminal/.test(error.stderr))
  await assert.rejects(readFile(join(data, 'workspace.sqlite')), error => error.code === 'ENOENT')
})

test('stateless -p uses only a fake direct provider, honors --cwd and never calls shared chat', async t => {
  const dir = await directory(t), data = join(dir, 'data'), bin = join(dir, 'bin'), work = join(dir, 'project'), capture = join(dir, 'provider-call.json')
  await mkdir(bin); await mkdir(work)
  await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BUNJI_TEST_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FAKE_PROVIDER_ONLY' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }));
`, { mode: 0o700 })
  const { stdout } = await exec(process.execPath, [index, '--cwd', work, '-p', 'One stateless message'], {
    env: { ...process.env, PATH: bin + ':' + dirname(process.execPath) + ':' + process.env.PATH, BUNJI_DATA_DIR: data,
      BUNJI_API_PORT: 'bad-port-must-not-be-read', BUNJI_TEST_CAPTURE: capture }, timeout: 10000,
  })
  assert.match(stdout, /FAKE_PROVIDER_ONLY/)
  const called = JSON.parse(await readFile(capture, 'utf8'))
  assert.equal(called.cwd, await realpath(work))
  assert.equal(called.args.at(-1), 'One stateless message')
  const db = new DatabaseSync(join(data, 'workspace.sqlite'))
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='chat_requests'").get().count, 0) }
  finally { db.close() }
})
