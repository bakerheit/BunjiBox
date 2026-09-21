const fail = (message, status = 400) => Object.assign(new Error(message), { status })
export async function jsonBody(request, limit = 65536) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw fail('Use application/json.', 415)
  let size = 0; const parts = []
  for await (const part of request) { size += part.length; if (size > limit) throw fail('Request is too large.', 413); parts.push(part) }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw fail('Invalid JSON.') }
}
const send = (response, status, data) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(data))
}
export function createContinuityRoutes({ service, chats, memory }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const bot = /^\/api\/bots\/([a-zA-Z0-9_-]+)\/(history|messages|memory)(?:\/([a-zA-Z0-9_-]+))?$/.exec(url.pathname)
    const run = /^\/api\/runs\/([a-zA-Z0-9_-]+)(\/cancel)?$/.exec(url.pathname)
    if (!bot && !run) return false
    try {
      if (request.method !== 'GET' && request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) throw fail('Cross-origin changes are not allowed.', 403)
      let result, status = 200
      if (run) {
        if (request.method === 'POST' && run[2]) { await jsonBody(request); result = service.cancel(run[1]) }
        else if (request.method === 'GET' && !run[2]) { result = { request: chats.get(run[1]) }; if (!result.request) throw fail('Request not found.', 404) }
        else throw fail('Unsupported run operation.', 405)
      } else {
        const [, botId, action, noteId] = bot
        service.botFor(botId)
        if (action === 'history' && !noteId && request.method === 'GET') result = chats.history(botId, { limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100, before: url.searchParams.get('before') || undefined })
        else if (action === 'messages' && !noteId && request.method === 'POST') { result = service.start(botId, await jsonBody(request)); status = result.created ? 202 : 200 }
        else if (action === 'messages' && noteId && request.method === 'PATCH') {
          const edit = await jsonBody(request)
          if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some(key => !['role', 'value', 'expectedText'].includes(key))) throw fail('Invalid message edit.')
          result = { request: chats.editMessage(botId, noteId, edit) }
        }
        else if (action === 'memory') {
          if (request.method === 'GET') result = noteId ? { note: await memory.read(botId, noteId) } : url.searchParams.has('q') ? await memory.search(botId, { query: url.searchParams.get('q') }) : await memory.list(botId)
          else if (request.method === 'POST' && !noteId || request.method === 'PATCH' && noteId) {
            const body = await jsonBody(request)
            result = { note: await memory.write(botId, { ...(noteId ? { id: noteId, expectedRevision: body.expectedRevision } : {}), title: body.title, body: body.body }) }
          } else throw fail('Unsupported memory operation.', 405)
        } else throw fail('Unsupported chat operation.', 405)
      }
      send(response, status, result)
    } catch (error) { send(response, error.status || 400, { error: error.message }) }
    return true
  }
}
