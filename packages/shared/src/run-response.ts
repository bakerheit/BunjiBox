import type { ProviderResult, RunStreamEvent } from './types.ts'

type StreamedResult = Partial<ProviderResult> & { type?: 'result'; ok: boolean }

// Fetch streaming works on LAN HTTP, unlike browser-only secure-context APIs.
export async function readRunResponse(response: Response, onEvent: (event: Exclude<RunStreamEvent, { type: 'result' }>) => void): Promise<StreamedResult> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const result = await response.json() as Partial<ProviderResult>
    return { ...result, ok: response.ok && result.ok !== false }
  }
  if (!response.ok || !response.body) throw new Error('Could not open the provider event stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', result: StreamedResult | undefined
  const parse = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as RunStreamEvent
    if (event.type === 'result') result = event as StreamedResult
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
