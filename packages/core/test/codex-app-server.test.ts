import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCodexAppServer } from '../src/codex-app-server.mjs'
import { openCodexSessionStore } from '../src/codex-session-store.mjs'

function fakeProcess({ threadId = 'thread-1', waitForInterrupt = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
  child.messages = []; child.killed = []
  child.kill = signal => { child.killed.push(signal); return true }
  let buffer = '', turn = 0
  const send = message => child.stdout.write(JSON.stringify(message) + '\n')
  const complete = (id, status = 'completed') => {
    send({ method: 'item/started', params: { threadId, turnId: id, item: { id: `command-${id}`, type: 'commandExecution', command: 'pwd', commandActions: [], cwd: '/tmp', status: 'inProgress' }, startedAtMs: 1 } })
    send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `command-${id}`, type: 'commandExecution', command: 'pwd', commandActions: [], cwd: '/tmp', status: 'completed', aggregatedOutput: '/tmp', exitCode: 0 }, completedAtMs: 2 } })
    send({ method: 'item/completed', params: { threadId, turnId: id, item: { id: `answer-${id}`, type: 'agentMessage', text: `reply-${turn}` }, completedAtMs: 3 } })
    send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: id, tokenUsage: { last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7, cacheWriteInputTokens: 0, reasoningOutputTokens: 1, totalTokens: 12 }, total: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7, cacheWriteInputTokens: 0, reasoningOutputTokens: 1, totalTokens: 12 }, modelContextWindow: 1000 } } })
    send({ method: 'turn/completed', params: { threadId, turn: { id, status, items: [], durationMs: 40 } } })
  }
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line); child.messages.push(message)
      queueMicrotask(() => {
        if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'test' } })
        else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: threadId } } })
        else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: threadId } } })
        else if (message.method === 'turn/start') {
          const id = `turn-${++turn}`
          send({ id: message.id, result: { turn: { id, status: 'inProgress', items: [] } } })
          send({ method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress', items: [] } } })
          if (!waitForInterrupt) complete(id)
        } else if (message.method === 'turn/interrupt') {
          send({ id: message.id, result: {} }); complete(message.params.turnId, 'interrupted')
        }
      })
    }
  })
  return child
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bunji-codex-session-'))
  const sessions = openCodexSessionStore({ path: join(directory, 'workspace.sqlite') })
  t.after(async () => { sessions.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, sessions }
}

const options = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', prompt: 'unused combined prompt' }
const machine = { sandbox: 'read-only', cwd: null, machineAccess: false }
function hooks(directory, overrides = {}) {
  return {
    requestId: overrides.requestId || 'request-1', signal: overrides.signal,
    memory: { botId: 'chip', sourceId: overrides.requestId || 'request-1', directory: join(directory, 'memory'), allowWrites: true },
    computer: { scope: 'none', level: 'read', folder: null, network: 'off' },
    session: { botId: 'chip', historyKey: overrides.historyKey || 'a'.repeat(64), instructions: 'You are Chip.', bootstrapPrompt: 'Previous chat and hello', turnPrompt: 'hello again' },
    onActivity: overrides.onActivity,
  }
}

test('one app-server process keeps a bot thread warm and preserves streamed usage', async t => {
  const f = await fixture(t), child = fakeProcess(), activities = []
  const server = createCodexAppServer({ sessions: f.sessions, spawnProcess: () => child })
  t.after(() => server.close())
  const first = await server.run(options, hooks(f.directory, { onActivity: activity => activities.push(activity) }), machine)
  assert.equal(first.text, 'reply-1')
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7, cacheWriteTokens: null, reasoningOutputTokens: 1, totalTokens: 12, source: 'Codex turn usage' })
  assert.equal(first.session.reused, false)
  assert.ok(activities.some(activity => activity.title === 'Run command' && activity.status === 'complete'))
  const started = child.messages.find(message => message.method === 'thread/start')
  const mcpArgs = started.params.config.mcp_servers.bunji_memory.args
  assert.ok(mcpArgs.includes('--session-state'))
  assert.ok(!mcpArgs.includes('request-1'), 'request provenance stays in the live scope file, not persisted thread config')
  f.sessions.set('chip', { threadId: first.session.threadId, historyKey: 'b'.repeat(64) })
  const second = await server.run(options, hooks(f.directory, { requestId: 'request-2', historyKey: 'b'.repeat(64) }), machine)
  assert.equal(second.session.reused, true)
  assert.equal(child.messages.filter(message => message.method === 'thread/start').length, 1)
  assert.equal(child.messages.filter(message => message.method === 'thread/resume').length, 0)
  assert.equal(child.messages.findLast(message => message.method === 'turn/start').params.input[0].text, 'hello again')
  const state = JSON.parse(await readFile(join(f.directory, 'codex-session-state', 'chip.json'), 'utf8'))
  assert.equal(state.sourceId, 'request-2')
})

test('a new app-server process resumes the durable thread after restart', async t => {
  const f = await fixture(t)
  f.sessions.set('chip', { threadId: 'thread-1', historyKey: 'a'.repeat(64) })
  const child = fakeProcess(), server = createCodexAppServer({ sessions: f.sessions, spawnProcess: () => child })
  t.after(() => server.close())
  const result = await server.run(options, hooks(f.directory), machine)
  assert.equal(result.session.reused, true)
  assert.equal(child.messages.filter(message => message.method === 'thread/resume').length, 1)
  assert.equal(child.messages.filter(message => message.method === 'thread/start').length, 0)
})

test('AbortSignal interrupts the active turn without killing the shared server', async t => {
  const f = await fixture(t), child = fakeProcess({ waitForInterrupt: true })
  const server = createCodexAppServer({ sessions: f.sessions, spawnProcess: () => child })
  t.after(() => server.close())
  const controller = new AbortController()
  const result = server.run(options, hooks(f.directory, { signal: controller.signal }), machine)
  while (!child.messages.some(message => message.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  const completed = await result
  assert.equal(completed.failed, false)
  assert.equal(child.messages.filter(message => message.method === 'turn/interrupt').length, 1)
  assert.deepEqual(child.killed, [])
})
