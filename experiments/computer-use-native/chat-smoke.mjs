// Subscription-backed integration test through the real shared chat service.
// Isolated in-memory bot/chat stores; only the disposable native fixture is used.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { openBotStore } from '../../packages/core/src/bot-store.ts'
import { openChatStore } from '../../packages/core/src/chat-store.ts'
import { createChatService } from '../../packages/core/src/chat-service.ts'

if (!process.argv.includes('--live')) throw new Error('Pass --live to use the signed-in subscription for a fixture-only test.')
const provider = process.argv.includes('--claude') ? 'claude' : 'codex'
const directory = await mkdtemp(join(tmpdir(), 'bunji-chat-native-'))
const bots = openBotStore({ path: ':memory:', workspaceRoot: directory })
const chats = openChatStore({ path: ':memory:' })
const service = createChatService({ bots, chats, memoryDirectory: join(directory, 'memory') })
const id = `native-chat-${Date.now()}`
try {
  bots.confirmMachine('bunjibox', { scope: 'machine', level: 'auto', network: 'off' })
  bots.patch('bunjibox', { provider, model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-luna', effort: 'low', nativeComputer: 'fixture' })
  service.start('bunjibox', { id, prompt: 'Use the native fixture only. Run native_status then native_focus and native_observe. Read the random BUNJI-#### visual code from the screenshot. Press the draft, observe, type that exact code, observe, press save, observe, then native_status to verify fixtureSavedMatchesVisualCode=true. Finally native_stop. Do not use shell, files, memory or any other apps. Never resume a paused session. Report the actual outcome.' })
  let last = 0
  while (chats.get(id)?.status === 'running') {
    await pause(1000)
    const row = chats.get(id)
    if (row.activities.length !== last) {
      last = row.activities.length
      console.log(`${provider}: ${last} activity records; ${row.status}`)
    }
  }
  const row = chats.get(id)
  console.log(JSON.stringify({ provider, status: row.status, text: row.text, error: row.error, usage: row.usage }, null, 2))
  assert.equal(row.status, 'complete')
  const evidence = row.activities.filter(a => /native_status/.test(a.title)).map(a => a.output || '').join('\n')
  assert.match(evidence, /fixtureSavedMatchesVisualCode.{0,10}true/, 'Native status must independently verify the saved visual code')
  assert.ok(row.activities.some(a => /native_stop/.test(a.title) && /stopped/.test(a.output || '')), 'The session must end through native_stop')
  console.log('PASS saved bot → automatic Agent routing → provider → native tools → persisted completion and verified native status.')
} finally { await service.close(); chats.close(); bots.close() }
