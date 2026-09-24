import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildContext } from '../src/context.mjs'
import { createCodexAppServer } from '../src/codex-app-server.mjs'
import { codexHistoryKey, openCodexSessionStore } from '../src/codex-session-store.mjs'

const message = 'Hi, you are Chip2, you are an assistant for Bakerheit Labs'
const bot = { id: 'chip2-benchmark', name: 'Chip2', description: 'An assistant for Bakerheit Labs.', computer: { scope: 'none', level: 'read', folder: null, network: 'off' } }
const options = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', prompt: message }
const machine = { sandbox: 'read-only', cwd: null, machineAccess: false }
const directory = await mkdtemp(join(tmpdir(), 'bunji-codex-benchmark-'))
const sessions = openCodexSessionStore({ path: join(directory, 'workspace.sqlite') })
let appServer, threadId

async function turn(turns, requestId) {
  const context = buildContext(bot, turns, message, { completedCount: turns.length, agentTools: true })
  const historyKey = codexHistoryKey({ instructions: context.instructions, computer: bot.computer, turns })
  const started = performance.now()
  const result = await appServer.run(options, {
    requestId,
    memory: { botId: bot.id, sourceId: requestId, directory: join(directory, 'memory'), allowWrites: true },
    computer: bot.computer,
    session: { botId: bot.id, historyKey, instructions: context.instructions, bootstrapPrompt: context.bootstrapPrompt, turnPrompt: context.turnPrompt },
  }, machine)
  const wallMs = Math.round(performance.now() - started)
  threadId = result.session.threadId
  return { result, wallMs, historyKey }
}

try {
  appServer = createCodexAppServer({ sessions })
  const cold = await turn([], 'benchmark-cold')
  sessions.set(bot.id, { threadId, historyKey: codexHistoryKey({ instructions: buildContext(bot, [], message).instructions, computer: bot.computer,
    turns: [{ id: 'benchmark-cold', status: 'complete', prompt: message, text: cold.result.text }] }) })
  await appServer.close()

  appServer = createCodexAppServer({ sessions })
  const previous = [{ id: 'benchmark-cold', status: 'complete', prompt: message, text: cold.result.text }]
  const warm = await turn(previous, 'benchmark-resumed')
  console.log(JSON.stringify({
    message,
    cold: { wallMs: cold.wallMs, providerDurationMs: cold.result.durationMs, usage: cold.result.usage, reused: cold.result.session.reused, text: cold.result.text },
    resumed: { wallMs: warm.wallMs, providerDurationMs: warm.result.durationMs, usage: warm.result.usage, reused: warm.result.session.reused, text: warm.result.text },
  }, null, 2))
  await appServer.deleteThread(threadId)
} finally {
  await appServer?.close().catch(() => {})
  sessions.close()
  await rm(directory, { recursive: true, force: true })
}
