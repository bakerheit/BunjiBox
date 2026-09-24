import type { Bot, ChatRequest, HistoryPage, MemoryList, MemoryNote, MessageEdit, RewindResult, StartResult } from '@bunji/shared/types'
import { fail } from '@bunji/shared/errors'
import { isReadOnly, isRecord, readJson, requestUrl, requireSameOrigin, sendError, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

/** The slices of the chat service and stores these routes use. */
export interface ContinuityDependencies {
  service: {
    botFor(botId: string): Bot
    start(botId: string, body: unknown): StartResult
    cancel(id: string): { request: ChatRequest | null }
    rewind(botId: string, options: unknown): RewindResult
    editMessage(botId: string, id: string, edit: MessageEdit): ChatRequest
  }
  chats: {
    get(id: string): ChatRequest | null
    history(botId: string, options: { limit?: number; before?: string }): HistoryPage
  }
  memory: {
    list(botId: string): Promise<MemoryList>
    search(botId: string, options: { query: string | null }): Promise<MemoryList>
    read(botId: string, id: string): Promise<MemoryNote>
    write(botId: string, value: Record<string, unknown>): Promise<MemoryNote>
  }
}

const botPath = /^\/api\/bots\/([a-zA-Z0-9_-]+)\/(history|messages|memory)(?:\/([a-zA-Z0-9_-]+))?$/
const rewindPath = /^\/api\/bots\/([a-zA-Z0-9_-]+)\/rewind$/
const runPath = /^\/api\/runs\/([a-zA-Z0-9_-]+)(\/cancel)?$/
const editFields = ['role', 'value', 'expectedText']

export function createContinuityRoutes({ service, chats, memory }: ContinuityDependencies): RouteHandler {
  return async (request, response) => {
    const url = requestUrl(request)
    const bot = botPath.exec(url.pathname)
    const rewind = rewindPath.exec(url.pathname)
    const run = runPath.exec(url.pathname)
    if (!bot && !rewind && !run) return false
    try {
      if (!isReadOnly(request)) requireSameOrigin(request)
      let result: unknown, status = 200
      if (run) {
        if (request.method === 'POST' && run[2]) { await readJson(request); result = service.cancel(run[1]) }
        else if (request.method === 'GET' && !run[2]) {
          const found = chats.get(run[1])
          if (!found) throw fail('Request not found.', 404)
          result = { request: found }
        } else throw fail('Unsupported run operation.', 405)
      } else if (rewind) {
        if (request.method !== 'POST') throw fail('Unsupported rewind operation.', 405)
        result = { rewind: service.rewind(rewind[1], await readJson(request)) }
      } else {
        const [, botId, action, noteId] = bot!
        service.botFor(botId)
        if (action === 'history' && !noteId && request.method === 'GET') {
          result = chats.history(botId, { limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100, before: url.searchParams.get('before') || undefined })
        } else if (action === 'messages' && !noteId && request.method === 'POST') {
          const started = service.start(botId, await readJson(request))
          result = started; status = started.created ? 202 : 200
        } else if (action === 'messages' && noteId && request.method === 'PATCH') {
          const edit = await readJson(request)
          if (!isRecord(edit) || Object.keys(edit).some(key => !editFields.includes(key))) throw fail('Invalid message edit.')
          result = { request: service.editMessage(botId, noteId, edit as unknown as MessageEdit) }
        } else if (action === 'memory') {
          if (request.method === 'GET') {
            result = noteId ? { note: await memory.read(botId, noteId) }
              : url.searchParams.has('q') ? await memory.search(botId, { query: url.searchParams.get('q') }) : await memory.list(botId)
          } else if (request.method === 'POST' && !noteId || request.method === 'PATCH' && noteId) {
            const body = await readJson(request)
            const note = isRecord(body) ? body : {}
            result = { note: await memory.write(botId, { ...(noteId ? { id: noteId, expectedRevision: note.expectedRevision } : {}), title: note.title, body: note.body }) }
          } else throw fail('Unsupported memory operation.', 405)
        } else throw fail('Unsupported chat operation.', 405)
      }
      sendJson(response, status, result)
    } catch (error) { sendError(response, error) }
    return true
  }
}
