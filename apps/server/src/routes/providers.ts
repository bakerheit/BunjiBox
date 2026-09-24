import { deleteOpenRouterCredential, inspectOpenRouterKey, saveOpenRouterCredential, validOpenRouterKey } from '@bunji/core/openrouter'
import { readOpenRouterUsage } from '@bunji/core/usage'
import { fail } from '@bunji/shared/errors'
import { isRecord, readJson, requestUrl, requireSameOrigin, sendError, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

export interface ProviderRouteOptions {
  save?: (key: string) => Promise<unknown>
  remove?: () => Promise<unknown>
  inspect?: (key: string) => Promise<unknown>
  usage?: () => Promise<unknown>
}

export function createProviderRoutes({ save = saveOpenRouterCredential, remove = deleteOpenRouterCredential, inspect = inspectOpenRouterKey, usage = readOpenRouterUsage }: ProviderRouteOptions = {}): RouteHandler {
  return async (request, response) => {
    if (requestUrl(request).pathname !== '/api/providers/openrouter/key') return false
    try {
      requireSameOrigin(request, 'Cross-origin credential changes are not allowed.')
      if (request.method === 'POST') {
        const body = await readJson(request, 2048)
        if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.key !== 'string') throw fail('Expected an OpenRouter API key.')
        const key = body.key.trim()
        if (!validOpenRouterKey(key)) throw fail('Enter a valid OpenRouter API key.')
        await inspect(key)
        await save(key)
        sendJson(response, 200, { provider: await usage() })
      } else if (request.method === 'DELETE') {
        await remove()
        sendJson(response, 200, { provider: await usage() })
      } else sendJson(response, 405, { error: 'Unsupported provider operation.' })
    } catch (error) { sendError(response, error, { status: 500, message: 'Could not update the OpenRouter key.' }) }
    return true
  }
}
