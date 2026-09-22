import { deleteOpenRouterCredential, inspectOpenRouterKey, saveOpenRouterCredential, validOpenRouterKey } from '@bunji/core/openrouter'
import { readOpenRouterUsage } from '@bunji/core/usage'
import { jsonBody } from './continuity.mjs'

const send = (response, status, data) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(data))
}

export function createProviderRoutes({ save = saveOpenRouterCredential, remove = deleteOpenRouterCredential, inspect = inspectOpenRouterKey, usage = readOpenRouterUsage } = {}) {
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path !== '/api/providers/openrouter/key') return false
    try {
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) throw Object.assign(new Error('Cross-origin credential changes are not allowed.'), { status: 403 })
      if (request.method === 'POST') {
        const body = await jsonBody(request, 2048)
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.key !== 'string') throw Object.assign(new Error('Expected an OpenRouter API key.'), { status: 400 })
        const key = body.key.trim()
        if (!validOpenRouterKey(key)) throw Object.assign(new Error('Enter a valid OpenRouter API key.'), { status: 400 })
        await inspect(key)
        await save(key)
        send(response, 200, { provider: await usage() })
      } else if (request.method === 'DELETE') {
        await remove()
        send(response, 200, { provider: await usage() })
      } else send(response, 405, { error: 'Unsupported provider operation.' })
    } catch (error) { send(response, error.status || 500, { error: error.message || 'Could not update the OpenRouter key.' }) }
    return true
  }
}
