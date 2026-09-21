function send(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(value === undefined ? undefined : JSON.stringify(value))
}
async function body(request, limit) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Use application/json.'), { status: 415 })
  const chunks = []; let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('Bot settings upload is too large.'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('Invalid JSON.') }
}

export function createBotRoutes(store, service) {
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path !== '/api/bots' && !path.startsWith('/api/bots/')) return false
    try {
      if (request.method !== 'GET' && request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        send(response, 403, { error: 'Cross-origin bot changes are not allowed.' }); return true
      }
      let result
      if (request.method === 'GET' && path === '/api/bots') {
        const match = /^"bots-(\d+)"$/.exec(request.headers['if-none-match'] || '')
        result = store.list(match ? Number(match[1]) : undefined)
        if (!result) { send(response, 304); return true }
      } else if (request.method === 'POST' && path === '/api/bots') result = store.create(await body(request, 512 * 1024))
      else if (request.method === 'POST' && path === '/api/bots/import') result = store.importLegacy(await body(request, 16 * 1024 * 1024))
      else if (request.method === 'POST' && /^\/api\/bots\/[a-zA-Z0-9_-]+\/computer\/enable-(full-machine|folder)$/.test(path)) {
        const settings = await body(request, 16 * 1024)
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length !== 1 || !Object.hasOwn(settings, 'computer')) throw Object.assign(new Error('Expected computer settings.'), { status: 400 })
        result = path.endsWith('/enable-full-machine')
          ? store.confirmMachine(path.split('/')[3], settings.computer)
          : store.confirmFolder(path.split('/')[3], settings.computer)
      }
      else if (request.method === 'PATCH' && /^\/api\/bots\/[a-zA-Z0-9_-]+$/.test(path)) {
        const id = path.split('/').at(-1)
        result = store.patch(id, await body(request, 512 * 1024))
      }
      else if (request.method === 'DELETE' && /^\/api\/bots\/[a-zA-Z0-9_-]+$/.test(path)) {
        result = await service.deleteBot(path.split('/').at(-1), await body(request, 16 * 1024))
      }
      else { send(response, 405, { error: 'Unsupported bot operation.' }); return true }
      send(response, 200, result, { etag: `"bots-${result.revision}"` })
    } catch (error) { send(response, error.status || (error.code?.startsWith('ERR_SQLITE') ? 503 : 400), { error: error.message }) }
    return true
  }
}
