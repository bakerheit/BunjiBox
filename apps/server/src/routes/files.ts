import type { FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { AgentFile, FilePreview } from '@bunji/shared/types'
import { errorStatus, fail } from '@bunji/shared/errors'
import { requestUrl, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

export interface FileRouteDependencies {
  service: { botFor(botId: string): unknown }
  files: {
    list(botId: string): Promise<AgentFile[]>
    preview(botId: string, id: string): Promise<FilePreview>
    open(botId: string, id: string): Promise<{ file: AgentFile; handle: FileHandle }>
  }
}

const filePath = /^\/api\/bots\/([a-zA-Z0-9_-]+)\/files(?:\/([a-zA-Z0-9_-]+)(?:\/(preview|content|download))?)?$/
const hardened = { 'x-content-type-options': 'nosniff' }

export function createFileRoutes({ service, files }: FileRouteDependencies): RouteHandler {
  return async (request, response) => {
    const match = filePath.exec(requestUrl(request).pathname)
    if (!match) return false
    try {
      const [, botId, id, action] = match
      service.botFor(botId)
      if (request.method !== 'GET') throw fail('File browsing is read only.', 405)
      if (!id) { sendJson(response, 200, { files: await files.list(botId) }, hardened); return true }
      if (!action || action === 'preview') { sendJson(response, 200, await files.preview(botId, id), hardened); return true }
      const { file, handle } = await files.open(botId, id)
      const inline = action === 'content' && file.preview === 'image'
      response.writeHead(200, {
        'content-type': inline ? file.mime : 'application/octet-stream',
        'content-length': file.size, 'cache-control': 'no-store',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
        'content-security-policy': "sandbox; default-src 'none'", ...hardened,
      })
      try { await pipeline(handle.createReadStream(), response) } finally { await handle.close().catch(() => {}) }
    } catch (error) {
      // Unexpected failures can carry local paths; only deliberate errors reach the client.
      const status = errorStatus(error)
      if (!response.headersSent) sendJson(response, status ?? 500, { error: status ? (error as Error).message : 'Could not load this file. Try again.' }, hardened)
      else response.destroy()
    }
    return true
  }
}
