import http from 'node:http'
import { createUsageReader, providerCommand, providerStatus, runProvider } from '@bunji/core/runtime'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { openBotStore, workspaceDirectory } from '@bunji/core/bot-store'
import { createBotRoutes } from './src/bots.mjs'
import { openChatStore } from '@bunji/core/chat-store'
import { openMemoryStore } from '@bunji/core/memory-store'
import { createChatService } from '@bunji/core/chat-service'
import { createContinuityRoutes } from './src/continuity.mjs'
import { acquireServiceLease } from '@bunji/core/service-lease'
import { openFileStore } from '@bunji/core/file-store'
import { createFileRoutes } from './src/files.mjs'
import { recoverFileHistory } from '@bunji/core/file-history'

const PORT = Number(process.env.BUNJI_API_PORT || 4318)
// Coordinate by workspace, not only by port. Two service ports must not recover
// or run each other's in-flight work against the same SQLite database.
const serviceLease = acquireServiceLease()
process.once('exit', () => serviceLease.release())
const readUsage = createUsageReader()
const botStore = openBotStore()
const chatStore = openChatStore()
const memoryDirectory = join(workspaceDirectory(), 'memory')
const memoryStore = openMemoryStore({ directory: memoryDirectory })
const fileStore = openFileStore()
const chatService = createChatService({ bots: botStore, chats: chatStore, memoryDirectory, memory: memoryStore, files: fileStore })
const handleFiles = createFileRoutes({ service: chatService, files: fileStore })
const handleBots = createBotRoutes(botStore, chatService)
const handleContinuity = createContinuityRoutes({ service: chatService, chats: chatStore, memory: memoryStore })
await Promise.all(botStore.list().bots.map(bot => recoverFileHistory({ bot, chats: chatStore, files: fileStore })))

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const server = http.createServer(async (request, response) => {
  if (await handleFiles(request, response)) return
  if (await handleContinuity(request, response)) return
  if (await handleBots(request, response)) return
  const url = new URL(request.url, `http://${request.headers.host}`)

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { service: 'bunji', continuity: 1, workspace: createHash('sha256').update(workspaceDirectory()).digest('hex'), cwd: process.cwd() })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/usage') {
    response.setHeader('Cache-Control', 'no-store')
    try { sendJson(response, 200, await readUsage({ refresh: url.searchParams.get('refresh') === '1' })) }
    catch { sendJson(response, 503, { error: 'Usage is temporarily unavailable. Try again shortly.' }) }
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/status') {
    const [claude, codex, ollama] = await Promise.all([providerStatus('claude'), providerStatus('codex'), providerStatus('ollama')])
    sendJson(response, 200, { claude, codex, ollama })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/run') {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 20000) request.destroy() })
    request.on('end', async () => {
      const requestId = randomUUID()
      const startedAt = Date.now()
      try {
        const body = JSON.parse(raw)
        providerCommand(body)
        const streaming = request.headers.accept?.includes('application/x-ndjson')
        const controller = new AbortController()
        const disconnected = () => { if (!response.writableEnded) controller.abort() }
        response.on('close', disconnected)
        const emit = event => {
          if (response.destroyed || response.writableEnded) return
          // Bound the queue if a phone loses connectivity or stops reading.
          if (response.writableLength > 1024 * 1024) { controller.abort(); response.destroy(); return }
          response.write(JSON.stringify(event) + '\n')
        }
        if (streaming) {
          response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
          response.flushHeaders()
          emit({ type: 'start', requestId })
        }
        const result = await runProvider(body, { requestId, signal: controller.signal, onActivity: streaming ? activity => emit({ type: 'activity', activity }) : undefined })
        response.off('close', disconnected)
        const payload = { ...result, ok: !result.failed, requestId, durationMs: Date.now() - startedAt }
        if (!response.destroyed) {
          if (streaming) { emit({ type: 'result', ...payload }); response.end() }
          else sendJson(response, result.failed ? 400 : 200, payload)
        }
      } catch (error) {
        if (!response.headersSent) sendJson(response, 400, { ok: false, error: error instanceof SyntaxError ? 'Invalid request JSON.' : error.message, usage: null, requestId, durationMs: Date.now() - startedAt })
        else response.end()
      }
    })
    return
  }

  sendJson(response, 404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  // Only the process which owns the port can recover runs from a prior crash.
  chatStore.recoverInterrupted()
  console.log(`BunjiBox local API listening on http://127.0.0.1:${PORT}`)
})

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  server.close()
  await chatService.close()
  fileStore.close(); chatStore.close(); botStore.close()
  serviceLease.release()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
