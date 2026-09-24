// Ollama HTTP client: chat-mode runs against a local (or configured) server.
import type { Activity, ProviderStatus, TokenUsage } from '@bunji/shared/types'
import { errorMessage } from '@bunji/shared/errors'
import type { ProviderHooks, ProviderOutcome, ProviderRequest } from './provider-types.ts'

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

/** One NDJSON event from /api/chat. `done` marks the final event, which carries the token counts. */
interface OllamaChatEvent {
  error?: string
  message?: { content?: unknown; thinking?: unknown }
  done?: boolean
  prompt_eval_count?: unknown
  eval_count?: unknown
}

export function ollamaUrl(): string {
  const value = process.env.BUNJI_OLLAMA_URL || DEFAULT_OLLAMA_URL
  let url
  try { url = new URL(value) } catch { throw new Error('BUNJI_OLLAMA_URL must be a valid HTTP URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('BUNJI_OLLAMA_URL must be a plain HTTP or HTTPS URL.')
  return url.toString().replace(/\/$/, '')
}

export function ollamaUsage(final: OllamaChatEvent | null): TokenUsage {
  const inputTokens = Number.isSafeInteger(final?.prompt_eval_count) ? final!.prompt_eval_count as number : null
  const outputTokens = Number.isSafeInteger(final?.eval_count) ? final!.eval_count as number : null
  return { inputTokens, outputTokens, cachedInputTokens: null, cacheWriteTokens: null,
    reasoningOutputTokens: null, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    source: 'Ollama response' }
}

export async function runOllama({ model, effort, prompt }: Pick<ProviderRequest, 'model' | 'effort' | 'prompt'>, { signal, onActivity, messages }: ProviderHooks = {}): Promise<ProviderOutcome & { durationMs: number }> {
  const startedAt = Date.now()
  const activities: Activity[] = []
  const activity: Activity = { id: 'ollama-request', kind: 'notice', title: 'Ollama', status: 'running', text: 'Waiting for Ollama…' }
  activities.push(activity); onActivity?.(activity)
  let text = '', thinking = '', final: OllamaChatEvent | null = null
  try {
    const response = await fetch(ollamaUrl() + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: Array.isArray(messages) ? messages : [{ role: 'user', content: prompt }], stream: true, think: model.startsWith('qwen3:') && effort !== 'low', keep_alive: '10m' }),
      signal,
    })
    if (!response.ok) {
      let message = `Ollama returned HTTP ${response.status}.`
      try { message = (await response.json() as { error?: string } | null)?.error || message } catch { /* Keep the safe status message. */ }
      throw new Error(message)
    }
    if (!response.body) throw new Error('Ollama returned no response stream.')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const consume = (line: string) => {
      if (!line.trim()) return
      let event: OllamaChatEvent
      try { event = JSON.parse(line) as OllamaChatEvent } catch { return }
      if (event.error) throw new Error(event.error)
      const message = event.message || {}
      if (typeof message.content === 'string') text += message.content
      if (typeof message.thinking === 'string') thinking += message.thinking
      if (event.done) final = event
    }
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Ollama returned an oversized response event.')
    }
    buffer += decoder.decode()
    consume(buffer)
    activity.status = 'complete'; activity.text = final ? 'Response received from Ollama.' : 'Ollama closed the response early.'
    onActivity?.({ ...activity })
    if (thinking) {
      const reasoning: Activity = { id: 'ollama-thinking', kind: 'reasoning', title: 'Model thinking', status: 'complete', text: thinking }
      activities.push(reasoning); onActivity?.(reasoning)
    }
    if (!final || !text) return { text, usage: ollamaUsage(final), failed: true, activities, error: 'Ollama returned an empty response.', durationMs: Date.now() - startedAt }
    return { text, usage: ollamaUsage(final), failed: false, activities, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = signal?.aborted ? 'The connection closed before Ollama finished.' : errorMessage(error)
    const failedActivity: Activity = { ...activity, status: 'failed', text: message }
    activities[0] = failedActivity; onActivity?.(failedActivity)
    return { text, usage: ollamaUsage(final), failed: true, activities, error: message, durationMs: Date.now() - startedAt }
  }
}

/** Reachability and installed models. Throws when the configured URL is invalid; providerStatus maps that to disconnected. */
export async function ollamaStatus(): Promise<ProviderStatus> {
  const response = await fetch(ollamaUrl() + '/api/tags', { signal: AbortSignal.timeout(3000) })
  if (!response.ok) return { connected: false, plan: 'Ollama unavailable' }
  const data = await response.json() as { models?: unknown } | null
  const models = Array.isArray(data?.models) ? (data.models as { name?: string }[]).map(item => item.name).filter((name): name is string => Boolean(name)) : []
  return { connected: true, plan: 'Ollama', models }
}
