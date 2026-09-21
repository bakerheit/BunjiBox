// Fetch streaming works on LAN HTTP, unlike browser-only secure-context APIs.
export async function readRunResponse(response, onEvent) {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const result = await response.json()
    return { ...result, ok: response.ok && result.ok !== false }
  }
  if (!response.ok || !response.body) throw new Error('Could not open the provider event stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', result
  const parse = line => {
    if (!line.trim()) return
    const event = JSON.parse(line)
    if (event.type === 'result') result = event
    else onEvent(event)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Provider event was too large.')
      if (done) break
    }
    if (buffer.trim()) parse(buffer)
    if (!result) throw new Error('Connection ended before the provider finished. Usage may be unavailable.')
    return result
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
