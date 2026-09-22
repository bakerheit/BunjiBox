import { jsonBody } from './continuity.mjs'

export function createAvatarGenerationRoutes(service) {
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const match = /^\/api\/avatar-generations(?:\/([a-zA-Z0-9_-]+)(\/cancel)?)?$/.exec(path)
    if (!match) return false
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    try {
      if (request.headers.origin) {
        let allowed = false
        try {
          const origin = new URL(request.headers.origin)
          allowed = ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host
        } catch { /* Opaque and malformed origins are not same-origin callers. */ }
        if (!allowed) throw Object.assign(new Error('Cross-origin image requests are not allowed.'), { status: 403 })
      }
      if (request.method === 'POST' && !match[1]) send(202, { generation: service.start(await jsonBody(request, 16384)) })
      else if (request.method === 'GET' && match[1] && !match[2]) send(200, { generation: service.get(match[1]) })
      else if (request.method === 'POST' && match[1] && match[2]) {
        await jsonBody(request, 1024)
        send(200, { generation: service.cancel(match[1]) })
      } else send(405, { error: 'Unsupported image generation operation.' })
    } catch (error) { send(error.status || 500, { error: error.message || 'Image generation failed.' }) }
    return true
  }
}
