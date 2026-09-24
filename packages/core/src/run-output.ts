import type { TokenUsage } from '@bunji/shared/types'

/** The token counts a provider CLI prints in its final event. Field names are the provider's own. */
type RawUsage = Record<string, unknown>

/** The final-output fields parseRunOutput reads from a provider's JSON. */
interface OutputEvent {
  type?: string
  item?: { type?: string; text?: unknown; content?: unknown }
  text?: unknown
  content?: unknown
  result?: unknown
  usage?: unknown
  is_error?: unknown
}

export interface RunOutput {
  text: string
  usage: TokenUsage | null
  failed: boolean
}

const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
const sum = (values: (number | null)[]): number | null => values.every(value => value !== null) ? (values as number[]).reduce((total, value) => total + value, 0) : null

export function codexTokens(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null
  const raw = usage as RawUsage
  const inputTokens = count(raw.input_tokens)
  const outputTokens = count(raw.output_tokens)
  const cachedInputTokens = count(raw.cached_input_tokens)
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens: null, reasoningOutputTokens: count(raw.reasoning_output_tokens), totalTokens: sum([inputTokens, outputTokens]), source: 'Codex turn usage' }
}

export function claudeTokens(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null
  const raw = usage as RawUsage
  const uncached = count(raw.input_tokens)
  const cachedInputTokens = count(raw.cache_read_input_tokens)
  const cacheWriteTokens = count(raw.cache_creation_input_tokens)
  // Claude's input_tokens excludes cache reads/writes; Codex's includes them.
  // Missing cache fields remain unknown instead of silently becoming zero.
  const inputTokens = sum([uncached, cachedInputTokens, cacheWriteTokens])
  const outputTokens = count(raw.output_tokens)
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningOutputTokens: null, totalTokens: sum([inputTokens, outputTokens]), source: 'Claude result usage' }
}

export function parseRunOutput(provider: string, output = ''): RunOutput {
  if (provider === 'claude') {
    try {
      const result = JSON.parse(output) as OutputEvent
      return { text: typeof result.result === 'string' ? result.result : typeof result.content === 'string' ? result.content : '', usage: claudeTokens(result.usage), failed: result.is_error === true }
    } catch { return { text: '', usage: null, failed: true } }
  }
  const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line) as OutputEvent] } catch { return [] } })
  const message = events.findLast(event => event.item?.type === 'agent_message' || event.type === 'agent_message' || event.type === 'message')
  const payload = message?.item || message
  const final = events.findLast(event => ['turn.completed', 'turn.failed'].includes(event.type as string))
  return { text: typeof payload?.text === 'string' ? payload.text : typeof payload?.content === 'string' ? payload.content : '', usage: codexTokens(final?.usage), failed: final?.type === 'turn.failed' }
}
