import { readJson, requestUrl, requireSameOrigin, sendError, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

export interface AvatarGenerationService {
  start(value: unknown): unknown
  get(id: string): unknown
  cancel(id: string): unknown
}

const generationPath = /^\/api\/avatar-generations(?:\/([a-zA-Z0-9_-]+)(\/cancel)?)?$/

export function createAvatarGenerationRoutes(service: AvatarGenerationService): RouteHandler {
  return async (request, response) => {
    const match = generationPath.exec(requestUrl(request).pathname)
    if (!match) return false
    try {
      // Generated images are private to the host: polling is guarded too.
      requireSameOrigin(request, 'Cross-origin image requests are not allowed.')
      if (request.method === 'POST' && !match[1]) sendJson(response, 202, { generation: service.start(await readJson(request, 16384)) })
      else if (request.method === 'GET' && match[1] && !match[2]) sendJson(response, 200, { generation: service.get(match[1]) })
      else if (request.method === 'POST' && match[1] && match[2]) {
        await readJson(request, 1024)
        sendJson(response, 200, { generation: service.cancel(match[1]) })
      } else sendJson(response, 405, { error: 'Unsupported image generation operation.' })
    } catch (error) { sendError(response, error, { status: 500, message: 'Image generation failed.' }) }
    return true
  }
}
