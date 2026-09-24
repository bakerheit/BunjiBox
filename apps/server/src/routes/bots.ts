import type { BotsSnapshot, DeleteBotOptions, LegacyBotImport } from '@bunji/shared/types'
import { fail } from '@bunji/shared/errors'
import { isReadOnly, isRecord, readJson, requestUrl, requireSameOrigin, sendError, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

/** The slice of the bot store these routes use. */
export interface BotRouteStore {
  list(after?: number): BotsSnapshot | null
  create(value: unknown): BotsSnapshot
  patch(id: string, changes: unknown): BotsSnapshot
  importLegacy(data: LegacyBotImport): BotsSnapshot
  confirmMachine(id: string, computer: unknown): BotsSnapshot
  confirmFolder(id: string, computer: unknown): BotsSnapshot
}

export interface BotRouteService {
  deleteBot(botId: string, options: DeleteBotOptions): Promise<BotsSnapshot>
}

const botPath = /^\/api\/bots\/([a-zA-Z0-9_-]+)$/
const computerPath = /^\/api\/bots\/([a-zA-Z0-9_-]+)\/computer\/enable-(full-machine|folder)$/
const tooLarge = 'Bot settings upload is too large.'

export function createBotRoutes(store: BotRouteStore, service?: BotRouteService): RouteHandler {
  return async (request, response) => {
    const path = requestUrl(request).pathname
    if (path !== '/api/bots' && !path.startsWith('/api/bots/')) return false
    try {
      if (!isReadOnly(request)) requireSameOrigin(request, 'Cross-origin bot changes are not allowed.')
      let result: BotsSnapshot | null
      let match: RegExpExecArray | null
      if (request.method === 'GET' && path === '/api/bots') {
        const cached = /^"bots-(\d+)"$/.exec(request.headers['if-none-match'] || '')
        result = store.list(cached ? Number(cached[1]) : undefined)
        if (!result) { sendJson(response, 304); return true }
      } else if (request.method === 'POST' && path === '/api/bots') result = store.create(await readJson(request, 512 * 1024, tooLarge))
      else if (request.method === 'POST' && path === '/api/bots/import') result = store.importLegacy(await readJson(request, 16 * 1024 * 1024, tooLarge) as LegacyBotImport)
      else if (request.method === 'POST' && (match = computerPath.exec(path))) {
        const settings = await readJson(request, 16 * 1024, tooLarge)
        if (!isRecord(settings) || Object.keys(settings).length !== 1 || !Object.hasOwn(settings, 'computer')) throw fail('Expected computer settings.')
        result = match[2] === 'full-machine' ? store.confirmMachine(match[1], settings.computer) : store.confirmFolder(match[1], settings.computer)
      } else if (request.method === 'PATCH' && (match = botPath.exec(path))) result = store.patch(match[1], await readJson(request, 512 * 1024, tooLarge))
      else if (request.method === 'DELETE' && service && (match = botPath.exec(path))) {
        result = await service.deleteBot(match[1], await readJson(request, 16 * 1024, tooLarge) as DeleteBotOptions)
      } else { sendJson(response, 405, { error: 'Unsupported bot operation.' }); return true }
      sendJson(response, 200, result, { etag: `"bots-${result.revision}"` })
    } catch (error) { sendError(response, error) }
    return true
  }
}
