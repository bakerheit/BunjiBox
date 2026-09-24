import test from 'node:test'
import assert from 'node:assert/strict'
import { attributeProviderUsage, combineUsageBreakdowns, createUsageBreakdown, measureText } from '../src/usage-attribution.mjs'

test('Codex attribution separates the typed message from Bunji-composed context', () => {
  const userMessage = 'Hi, you are Chip2, you are an assistant for Bakerheit Labs'
  const prompt = `System rules\nPrevious conversation\nCurrent user message:\n${userMessage}`
  const breakdown = createUsageBreakdown({ provider: 'codex', userMessage, prompt, historyTurns: 2 })
  assert.equal(breakdown.payloadMode, 'combined-prompt')
  assert.deepEqual(breakdown.userMessage, measureText(userMessage))
  assert.deepEqual(breakdown.bunjiContext, { ...measureText(prompt.slice(0, -userMessage.length)), historyTurns: 2 })
  const finished = attributeProviderUsage(breakdown, { inputTokens: 21_513 })
  assert.equal(finished.providerHarnessUnknown.status, 'estimated')
  assert.equal(finished.providerHarnessUnknown.estimatedTokens,
    21_513 - breakdown.userMessage.estimatedTokens - breakdown.bunjiContext.estimatedTokens)
  assert.match(finished.providerHarnessUnknown.reason, /Provider input minus/)
})

test('OpenRouter attribution measures role content and preserves unavailable provider counts', () => {
  const messages = [
    { role: 'system', content: 'You are Chip.' },
    { role: 'user', content: 'Earlier message' },
    { role: 'assistant', content: 'Earlier reply' },
    { role: 'user', content: 'Hello' },
  ]
  const breakdown = createUsageBreakdown({ provider: 'openrouter', userMessage: 'Hello', prompt: 'unused combined prompt', messages, historyTurns: 1 })
  assert.equal(breakdown.payloadMode, 'role-messages')
  assert.deepEqual(breakdown.bunjiContext, { ...measureText('You are Chip.\nEarlier message\nEarlier reply'), historyTurns: 1 })
  const unavailable = attributeProviderUsage(breakdown, { inputTokens: null })
  assert.equal(unavailable.providerHarnessUnknown.estimatedTokens, null)
  assert.equal(unavailable.providerHarnessUnknown.status, 'unavailable')
  const exactZero = attributeProviderUsage(createUsageBreakdown({ provider: 'openrouter', userMessage: '', prompt: '', messages: [{ role: 'user', content: '' }] }), { inputTokens: 0 })
  assert.equal(exactZero.providerHarnessUnknown.estimatedTokens, 0)
  assert.equal(exactZero.providerHarnessUnknown.status, 'estimated')
})

test('local estimates never become a negative harness value', () => {
  const breakdown = createUsageBreakdown({ provider: 'codex', userMessage: 'A long enough message', prompt: 'Some context A long enough message' })
  const result = attributeProviderUsage(breakdown, { inputTokens: 1 })
  assert.equal(result.providerHarnessUnknown.estimatedTokens, null)
  assert.equal(result.providerHarnessUnknown.status, 'unavailable')
  assert.match(result.providerHarnessUnknown.reason, /exceeded/)
})

test('Auto handoffs attribute both provider calls instead of hiding the Chat preflight', () => {
  const chat = createUsageBreakdown({ provider: 'codex', userMessage: 'Make it work', prompt: 'Chat rules\nMake it work', historyTurns: 1 })
  const agent = createUsageBreakdown({ provider: 'codex', userMessage: 'Make it work', prompt: 'Agent rules\nMake it work', historyTurns: 1 })
  const combined = combineUsageBreakdowns(chat, agent)
  assert.equal(combined.calls, 2)
  assert.equal(combined.userMessage.characters, measureText('Make it work').characters * 2)
  assert.equal(combined.bunjiContext.historyTurns, 2)
  const result = attributeProviderUsage(combined, { inputTokens: 100 })
  assert.equal(result.providerHarnessUnknown.estimatedTokens,
    100 - combined.userMessage.estimatedTokens - combined.bunjiContext.estimatedTokens)
})
