import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { openBotStore } from '../src/bot-store.ts'
import { openChatStore } from '../src/chat-store.ts'
import { openCodexSessionStore } from '../src/codex-session-store.ts'
import { createChatService } from '../src/chat-service.ts'
import type { ProviderResult } from '@bunji/shared/types'

async function finished(chats, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const request = chats.get(id)
    if (request?.status !== 'running') return request
    await delay(5)
  }
  throw new Error('Chat did not finish.')
}

test('chat service commits durable Codex continuity and invalidates it after edits', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'bunji-chat-session-'))
  const path = join(directory, 'workspace.sqlite')
  const bots = openBotStore({ path }), chats = openChatStore({ path }), sessions = openCodexSessionStore({ path })
  const observed = []
  const service = createChatService({ bots, chats, sessions, memoryDirectory: join(directory, 'memory'),
    run: async (options, hooks) => { observed.push({ options, hooks }); return { ok: true, text: 'Hello from Chip.', session: { threadId: 'thread-chip' } } as ProviderResult } })
  t.after(async () => { await service.close(); sessions.close(); chats.close(); bots.close(); await rm(directory, { recursive: true, force: true }) })

  const settings = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', mode: 'agent' }
  service.start('bunjibox', { id: 'hello-one', prompt: 'Hi', ...settings })
  await finished(chats, 'hello-one')
  const first = sessions.get('bunjibox')
  assert.equal(first.threadId, 'thread-chip')
  assert.match(observed[0].hooks.session.bootstrapPrompt, /Current user message:\nHi/)

  service.start('bunjibox', { id: 'hello-two', prompt: 'Again', ...settings })
  await finished(chats, 'hello-two')
  assert.equal(observed[1].hooks.session.historyKey, first.historyKey)
  assert.equal(observed[1].hooks.session.turnPrompt, 'Again')

  service.editMessage('bunjibox', 'hello-one', { role: 'user', value: 'Edited hi', expectedText: 'Hi' })
  assert.equal(sessions.get('bunjibox'), null)
})
