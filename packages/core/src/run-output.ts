const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const sum = values => values.every(value => value !== null) ? values.reduce((total, value) => total + value, 0) : null

export function codexTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = count(usage.input_tokens)
  const outputTokens = count(usage.output_tokens)
  const cachedInputTokens = count(usage.cached_input_tokens)
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens: null, reasoningOutputTokens: count(usage.reasoning_output_tokens), totalTokens: sum([inputTokens, outputTokens]), source: 'Codex turn usage' }
}

export function claudeTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  const uncached = count(usage.input_tokens)
  const cachedInputTokens = count(usage.cache_read_input_tokens)
  const cacheWriteTokens = count(usage.cache_creation_input_tokens)
  // Claude's input_tokens excludes cache reads/writes; Codex's includes them.
  // Missing cache fields remain unknown instead of silently becoming zero.
  const inputTokens = sum([uncached, cachedInputTokens, cacheWriteTokens])
  const outputTokens = count(usage.output_tokens)
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningOutputTokens: null, totalTokens: sum([inputTokens, outputTokens]), source: 'Claude result usage' }
}

export function parseRunOutput(provider, output = '') {
  if (provider === 'claude') {
    try {
      const result = JSON.parse(output)
      return { text: typeof result.result === 'string' ? result.result : typeof result.content === 'string' ? result.content : '', usage: claudeTokens(result.usage), failed: result.is_error === true }
    } catch { return { text: '', usage: null, failed: true } }
  }
  const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const message = events.findLast(event => event.item?.type === 'agent_message' || event.type === 'agent_message' || event.type === 'message')
  const payload = message?.item || message
  const final = events.findLast(event => ['turn.completed', 'turn.failed'].includes(event.type))
  return { text: typeof payload?.text === 'string' ? payload.text : typeof payload?.content === 'string' ? payload.content : '', usage: codexTokens(final?.usage), failed: final?.type === 'turn.failed' }
}
