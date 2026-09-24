import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_AGENT_CLOSE, AUTO_AGENT_OPEN, parseAgentHandoff, routeAutoPrompt } from '../src/mode-router.mjs'

test('Auto routes clear tool requests directly to Agent', () => {
  assert.equal(routeAutoPrompt('codex', 'Create a spreadsheet file in my workspace').mode, 'agent')
  assert.equal(routeAutoPrompt('claude', 'Run the test script').mode, 'agent')
  assert.equal(routeAutoPrompt('codex', 'Explain why the sky is blue').mode, 'chat')
  assert.equal(routeAutoPrompt('codex', 'Explain why the sky is blue').modelCheck, true)
})

test('chat-only providers never escalate and model handoffs must be exact', () => {
  assert.deepEqual(routeAutoPrompt('openrouter', 'Create a file'), { mode: 'chat', modelCheck: false, reason: 'openrouter is connected as a chat-only provider.' })
  assert.equal(parseAgentHandoff(`${AUTO_AGENT_OPEN}Needs the filesystem.${AUTO_AGENT_CLOSE}`), 'Needs the filesystem.')
  assert.equal(parseAgentHandoff(`Sure. ${AUTO_AGENT_OPEN}Needs tools.${AUTO_AGENT_CLOSE}`), null)
  assert.equal(parseAgentHandoff(`${AUTO_AGENT_OPEN}${'x'.repeat(241)}${AUTO_AGENT_CLOSE}`), null)
})
