import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRunEvents, displayText } from './run-events.mjs'
import { runStream } from './run-stream.mjs'
import { readRunResponse } from '../src/lib/run-response.js'
import { markdownUrl } from '../src/lib/markdown-url.js'

test('Codex tool lifecycle updates one item, keeps summaries and final usage', () => {
  const updates = []
  const tracker = createRunEvents('codex', item => updates.push(item))
  tracker.consume({ type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'pwd', status: 'in_progress' } })
  assert.equal(updates[0].status, 'running')
  tracker.consume({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'pwd', aggregated_output: '/project', exit_code: 0 } })
  tracker.consume({ type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'Checked the project folder.', encrypted_content: 'PRIVATE' } })
  tracker.consume({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '**Done**' } })
  tracker.consume({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 } })
  const result = tracker.result()
  assert.equal(result.activities.length, 2)
  assert.equal(result.activities[0].output, '/project')
  assert.equal(result.activities[0].status, 'complete')
  assert.equal(result.text, '**Done**')
  assert.equal(result.usage.totalTokens, 12)
  assert.equal(result.failed, false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})

test('Claude tools, exposed thinking and cache counts are not duplicated', () => {
  const tracker = createRunEvents('claude')
  tracker.consume({ type: 'system', subtype: 'init', apiKeySource: 'PRIVATE', mcp_servers: ['PRIVATE'] })
  const thinking = { type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Checked the input.', signature: 'PRIVATE' }, { type: 'redacted_thinking', data: 'PRIVATE' }] } }
  tracker.consume(thinking); tracker.consume(thinking)
  tracker.consume({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] } })
  tracker.consume({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Readme text' }, { type: 'image', data: 'PRIVATE' }] }] } })
  tracker.consume({ type: 'result', result: '# Done', usage: { input_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 1 } })
  const result = tracker.result()
  assert.equal(result.activities.length, 2)
  assert.equal(result.activities[1].output, 'Readme text')
  assert.equal(result.usage.totalTokens, 10)
  assert.equal(result.text, '# Done')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|signature|redacted_thinking/)
})

test('Tool failure, interrupted run, hidden thinking, unknown events and limits stay truthful', () => {
  const tracker = createRunEvents('codex')
  tracker.consume({ type: 'item.completed', item: { id: 'failed', type: 'command_execution', exit_code: 1, command: 'false' } })
  tracker.consume({ type: 'item.started', item: { id: 'pending', type: 'web_search', query: 'hello' } })
  tracker.consume({ type: 'item.completed', item: { id: 'hidden', type: 'reasoning', encrypted_content: 'SECRET' } })
  assert.equal(tracker.result().failed, true)
  assert.equal(tracker.result().activities[0].status, 'failed')
  assert.equal(tracker.result().activities[1].status, 'unknown')
  for (let i = 0; i < 200; i++) tracker.consume({ type: 'item.completed', item: { id: `event-${i}`, type: 'web_search', query: String(i) } })
  assert.equal(tracker.result().activities.length, 150)
  assert.equal(tracker.result().activityLimited, true)
})

test('Display details redact common credentials and cap oversized output', () => {
  assert.doesNotMatch(displayText({ access_token: 'PRIVATE', nested: { authorization: 'Bearer PRIVATE' }, command: 'api_key=PRIVATE' }), /PRIVATE/)
  assert.equal(displayText('Bearer abcdef'), 'Bearer [redacted]')
  assert.match(displayText('x'.repeat(13000)), /display truncated/)
  assert.equal(displayText(undefined), '')
})

function fakeProcess() {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.signals = []
  child.kill = signal => { child.signals.push(signal); return true }
  return child
}

test('Runner streams before completion, handles UTF-8 and final unterminated line', async () => {
  const child = fakeProcess(), updates = []
  const promise = runStream('fixture', [], { provider: 'codex', spawnProcess: () => child, onActivity: item => updates.push(item) })
  const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'Ready 🍋' } }) + '\n')
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
  assert.equal(updates[0].text, 'Ready 🍋')
  child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }))
  child.emit('close', 0)
  assert.equal((await promise).usage.totalTokens, 3)
})

test('Runner reports nonzero exits, stalls and disconnect without exposing stderr', async () => {
  const child = fakeProcess()
  const promise = runStream('fixture', [], { provider: 'claude', spawnProcess: () => child })
  child.stderr.write('PRIVATE_CREDENTIAL')
  child.emit('close', 1)
  const result = await promise
  assert.equal(result.failed, true)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CREDENTIAL/)
  const slow = fakeProcess()
  const timeout = await runStream('fixture', [], { provider: 'codex', spawnProcess: () => slow, stallTimeoutMs: 5 })
  assert.match(timeout.error, /stalled/)
  assert.deepEqual(slow.signals, ['SIGTERM'])
  slow.emit('close', null)
  const active = fakeProcess()
  const activeRun = runStream('fixture', [], { provider: 'codex', spawnProcess: () => active, stallTimeoutMs: 25 })
  await new Promise(resolve => setTimeout(resolve, 8))
  active.stdout.write('{}\n')
  await new Promise(resolve => setTimeout(resolve, 12))
  assert.deepEqual(active.signals, [])
  active.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))
  active.emit('close', 0)
  assert.equal((await activeRun).failed, false)
  const controller = new AbortController(), aborted = fakeProcess()
  const pending = runStream('fixture', [], { provider: 'codex', signal: controller.signal, spawnProcess: () => aborted })
  controller.abort()
  assert.match((await pending).error, /connection closed/)
  aborted.emit('close', null)
})

test('Client stream reader handles split frames and Unicode without double counting', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ type: 'activity', activity: { text: '🍋' } }) + '\n' + JSON.stringify({ type: 'result', ok: true, usage: { totalTokens: 5 } }))
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  const events = []
  const result = await readRunResponse(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), event => events.push(event))
  assert.equal(events.length, 1)
  assert.equal(events[0].activity.text, '🍋')
  assert.equal(result.usage.totalTokens, 5)
})

test('Client handles JSON validation errors and truncated streams', async () => {
  const result = await readRunResponse(new Response(JSON.stringify({ error: 'Bad model' }), { status: 400, headers: { 'content-type': 'application/json' } }), () => {})
  assert.equal(result.ok, false)
  await assert.rejects(readRunResponse(new Response('{"type":"start"}\n', { headers: { 'content-type': 'application/x-ndjson' } }), () => {}), /before the provider finished/)
})

test('Markdown URLs cannot execute code or open local files', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', 'file:///tmp/private', 'vbscript:foo', '//example.com']) assert.equal(markdownUrl(value), '')
  for (const value of ['https://example.com', 'http://example.com', 'mailto:test@example.com', '#heading']) assert.equal(markdownUrl(value), value)
})
