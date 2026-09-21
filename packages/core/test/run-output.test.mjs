import test from 'node:test'
import assert from 'node:assert/strict'
import { codexTokens, claudeTokens, parseRunOutput } from '../src/run-output.mjs'
import { summarizeRequests } from '@bunji/shared/token-usage'

test('Codex cached input is a subset, never added to total twice', () => {
  const usage = codexTokens({ input_tokens: 100, cached_input_tokens: 90, output_tokens: 20, reasoning_output_tokens: 5 })
  assert.equal(usage.totalTokens, 120)
  assert.equal(usage.cachedInputTokens, 90)
  assert.equal(usage.reasoningOutputTokens, 5)
})

test('Claude input includes fresh input, cache reads, and cache writes exactly once', () => {
  const usage = claudeTokens({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 300, output_tokens: 20 })
  assert.equal(usage.inputTokens, 1300)
  assert.equal(usage.totalTokens, 1320)
})

test('Missing counts remain unavailable, and actual zeros remain zeros', () => {
  assert.equal(codexTokens(undefined), null)
  assert.equal(codexTokens({ input_tokens: null, output_tokens: 12 }).totalTokens, null)
  assert.equal(claudeTokens({ input_tokens: 12, output_tokens: 5 }).inputTokens, null)
  assert.equal(codexTokens({ input_tokens: 0, output_tokens: 0 }).totalTokens, 0)
  assert.equal(codexTokens({ input_tokens: -1, output_tokens: 5 }).inputTokens, null)
})

test('Codex parsing keeps final text and final usage, never raw event streams', () => {
  const output = ['noise PRIVATE_SECRET', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0 } })].join('\n')
  const result = parseRunOutput('codex', output)
  assert.equal(result.text, 'Hello')
  assert.equal(result.usage.totalTokens, 10)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/)
})

test('Claude success and failure preserve measured usage', () => {
  const output = JSON.stringify({ result: 'Hello', is_error: true, usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 } })
  assert.equal(parseRunOutput('claude', output).failed, true)
  assert.equal(parseRunOutput('claude', output).usage.totalTokens, 9)
  assert.equal(parseRunOutput('claude', 'PRIVATE_RAW_FAILURE').text, '')
})

test('Conversation totals track known usage, pending and failed requests honestly', () => {
  const requests = [
    { status: 'complete', usage: codexTokens({ input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 }) },
    { status: 'complete', usage: claudeTokens({ input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 5 }) },
    { status: 'running', usage: null }, { status: 'failed', usage: null },
  ]
  const summary = summarizeRequests(requests)
  assert.equal(summary.totals.totalTokens.value, 185)
  assert.equal(summary.totals.totalTokens.partial, true)
  assert.equal(summary.totals.inputTokens.value, 160)
  assert.equal(summary.totals.cachedInputTokens.value, 80)
  assert.equal(summary.pending, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.measured, 2)
  assert.equal(summarizeRequests([{ status: 'failed' }]).totals.totalTokens.value, null)
  assert.equal(summarizeRequests([]).totals.totalTokens.value, 0)
})
