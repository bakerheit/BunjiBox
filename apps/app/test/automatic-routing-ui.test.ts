import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { automaticMode } from '@bunji/shared/runtimes'

test('routing stays automatic and out of the composer UI', async () => {
  assert.equal(automaticMode('codex'), 'auto')
  assert.equal(automaticMode('claude'), 'auto')
  assert.equal(automaticMode('openrouter'), 'chat')
  assert.equal(automaticMode('ollama'), 'chat')

  // App.tsx plus the components split out of it: together they are the former App.jsx.
  const files = ['App', 'ModelSelect', 'Sidebar', 'AgentInspector', 'DeleteBotDialog', 'RewindDialog']
  const source = (await Promise.all(files.map(name => readFile(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8')))).join('\n')
  assert.doesNotMatch(source, /ModePicker|Auto plans|auto-route-preview|composer-mode-note/)
  assert.match(source, /mode: automaticMode\(bot\.provider\)/)
})
