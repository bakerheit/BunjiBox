import { pipeline } from 'node:stream/promises'

export function createFileRoutes({ service, files }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const match = /^\/api\/bots\/([a-zA-Z0-9_-]+)\/files(?:\/([a-zA-Z0-9_-]+)(?:\/(preview|content|download))?)?$/.exec(url.pathname)
    if (!match) return false
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)) }
    try {
      const [, botId, id, action] = match
      service.botFor(botId)
      if (request.method !== 'GET') throw Object.assign(new Error('File browsing is read only.'), { status: 405 })
      if (!id) { json(200, { files: await files.list(botId) }); return true }
      if (!action || action === 'preview') { json(200, await files.preview(botId, id)); return true }
      const { file, handle } = await files.open(botId, id)
      const inline = action === 'content' && file.preview === 'image'
      response.writeHead(200, {
        'content-type': inline ? file.mime : 'application/octet-stream',
        'content-length': file.size, 'cache-control': 'no-store',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
        'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff',
      })
      try { await pipeline(handle.createReadStream(), response) } finally { await handle.close().catch(() => {}) }
    } catch (error) { if (!response.headersSent) json(error.status || 500, { error: error.status ? error.message : 'Could not load this file. Try again.' }); else response.destroy() }
    return true
  }
}
