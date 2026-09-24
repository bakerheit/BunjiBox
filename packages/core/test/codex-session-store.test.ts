import test from 'node:test'
import assert from 'node:assert/strict'
import { openCodexSessionStore, codexHistoryKey } from '../src/codex-session-store.mjs'

test('Codex session mappings persist by bot and validate continuity hashes', () => {
  const store = openCodexSessionStore({ path: ':memory:' })
  try {
    assert.equal(store.get('chip'), null)
    const key = codexHistoryKey({ instructions: 'You are Chip.', computer: { scope: 'none' }, turns: [] })
    store.set('chip', { threadId: 'thread-1', historyKey: key })
    assert.deepEqual(store.get('chip'), { threadId: 'thread-1', historyKey: key, updatedAt: store.get('chip').updatedAt })
    assert.equal(store.delete('chip'), true)
    assert.equal(store.delete('chip'), false)
    assert.throws(() => store.set('chip', { threadId: '', historyKey: key }), /thread ID/)
    assert.throws(() => store.set('chip', { threadId: 'thread-1', historyKey: 'bad' }), /history key/)
  } finally { store.close() }
})

test('continuity hashes change for edits, rewinds, instructions and computer scope', () => {
  const turn = { id: 'one', status: 'complete', prompt: 'Hello', text: 'Hi', promptEditedAt: null, responseEditedAt: null }
  const base = { instructions: 'You are Chip.', computer: { scope: 'none' }, turns: [turn] }
  const key = codexHistoryKey(base)
  assert.notEqual(codexHistoryKey({ ...base, turns: [{ ...turn, prompt: 'Edited' }] }), key)
  assert.notEqual(codexHistoryKey({ ...base, turns: [] }), key)
  assert.notEqual(codexHistoryKey({ ...base, instructions: 'You are Chip 2.' }), key)
  assert.notEqual(codexHistoryKey({ ...base, computer: { scope: 'machine', level: 'auto' } }), key)
})
