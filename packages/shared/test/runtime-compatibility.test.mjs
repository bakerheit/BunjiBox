import test from 'node:test'
import assert from 'node:assert/strict'
import { makeBot } from '../src/bots.js'
import { normalizeMode, normalizeRuntime, supportedModes } from '../src/runtimes.js'

test('changing the Ollama default preserves saved Qwen agents', () => {
  const saved = makeBot({ id: 'existing-pi-agent', provider: 'ollama', model: 'qwen3:1.7b', effort: 'low' })
  assert.equal(saved.model, 'qwen3:1.7b')
  assert.equal(saved.mode, 'chat')
  assert.equal(normalizeRuntime({ provider: 'ollama' }).model, 'gemma3:1b')
})

test('existing subscription bots keep Agent mode while direct providers stay truthful', () => {
  assert.equal(makeBot({ id: 'old-codex' }).mode, 'agent')
  assert.equal(makeBot({ id: 'old-openrouter', provider: 'openrouter', model: 'openrouter/free' }).mode, 'chat')
  assert.deepEqual(supportedModes('codex'), ['auto', 'chat', 'agent'])
  assert.deepEqual(supportedModes('openrouter'), ['chat'])
  assert.equal(normalizeMode('openrouter', 'agent'), 'chat')
  assert.throws(() => makeBot({ id: 'bad-mode', provider: 'openrouter', model: 'openrouter/free', mode: 'agent' }), /mode is not supported/)
})
