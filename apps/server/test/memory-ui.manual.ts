// Disposable UI workbench. No provider calls and no production data.
import http from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { openBotStore } from '@bunji/core/bot-store'
import { openChatStore } from '@bunji/core/chat-store'
import { openMemoryStore } from '@bunji/core/memory-store'
import { createChatService } from '@bunji/core/chat-service'
import { createContinuityRoutes } from '../src/routes/continuity.ts'
import { createBotRoutes } from '../src/routes/bots.ts'

const directory = await mkdtemp(join(await realpath(tmpdir()), 'bunji-memory-ui-'))
const path = join(directory, 'workspace.sqlite'), bots = openBotStore({ path }), chats = openChatStore({ path })
const memory = openMemoryStore({ directory: join(directory, 'memory') })
const tea = await memory.write('bunjibox', { id: 'tea', title: 'Tea preference', body: 'This is **disposable QA data**.\n\nPrefers green tea.', sourceMessageIds: ['qa-seed'] })
await memory.write('bunjibox', { id: 'project', title: 'Example project', body: 'A linked Markdown memory.\n\n[[tea|Tea preference]]' })
await memory.link('bunjibox', { id: tea.id, targetId: 'project', expectedRevision: tea.revision })
const service = createChatService({ bots, chats, memoryDirectory: memory.directory, run: async (options, hooks) => {
  hooks.onActivity({ id: 'qa-tool', kind: 'tool', title: 'Memory lookup (simulated)', status: 'running' })
  await new Promise(resolve => setTimeout(resolve, 500))
  hooks.onActivity({ id: 'qa-tool', kind: 'tool', title: 'Memory lookup (simulated)', status: 'complete', output: 'Disposable fixture, no model call.' })
  return { ok: true, text: '**Shared reply** from the disposable UI fixture.\n\n- Markdown works\n- History stays saved', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
} })
chats.start({ id: 'qa-seed', botId: 'bunjibox', prompt: 'A saved conversation', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' })
chats.finish('qa-seed', { text: 'This is a **saved reply**.', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } })
const routes = createContinuityRoutes({ service, chats, memory }), botRoutes = createBotRoutes(bots)
const server = http.createServer(async (request, response) => {
  if (await routes(request, response) || await botRoutes(request, response)) return
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ codex: { connected: true }, claude: { connected: true } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const root = fileURLToPath(new URL('../../app/', import.meta.url))
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${server.address().port}`, changeOrigin: false } } } })
await vite.listen()
console.log('Disposable memory UI at http://127.0.0.1:5174/ — no real provider calls')
let closing = false
async function close() {
  if (closing) return
  closing = true
  await vite.close(); server.close(); server.closeAllConnections(); await service.close()
  chats.close(); bots.close(); await rm(directory, { recursive: true, force: true })
}
process.once('SIGINT', close); process.once('SIGTERM', close)
