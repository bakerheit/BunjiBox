import { Buffer } from 'node:buffer'

const ESTIMATOR = 'utf8-bytes-divided-by-4'
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null

function words(value) {
  const clean = value.trim()
  return clean ? clean.split(/\s+/u).length : 0
}

export function measureText(value) {
  const text = typeof value === 'string' ? value : ''
  const utf8Bytes = Buffer.byteLength(text, 'utf8')
  return {
    characters: [...text].length,
    utf8Bytes,
    words: words(text),
    estimatedTokens: utf8Bytes ? Math.ceil(utf8Bytes / 4) : 0,
  }
}

function roleContext(messages) {
  if (!Array.isArray(messages) || !messages.length) return null
  const contents = messages.map(message => typeof message?.content === 'string' ? message.content : '')
  return contents.slice(0, -1).join('\n')
}

export function createUsageBreakdown({ provider, userMessage, prompt, messages, historyTurns = 0 }) {
  const current = typeof userMessage === 'string' ? userMessage : ''
  const combined = typeof prompt === 'string' ? prompt : ''
  const roleBased = ['openrouter', 'ollama'].includes(provider) ? roleContext(messages) : null
  const contextText = roleBased !== null ? roleBased
    : combined.endsWith(current) ? combined.slice(0, combined.length - current.length) : combined
  return {
    version: 1,
    calls: 1,
    estimator: ESTIMATOR,
    payloadMode: roleBased !== null ? 'role-messages' : 'combined-prompt',
    userMessage: measureText(current),
    bunjiContext: { ...measureText(contextText), historyTurns },
    providerHarnessUnknown: { estimatedTokens: null, status: 'pending', reason: null },
  }
}

const sumMeasurement = (first = {}, second = {}) => ({
  characters: (first.characters || 0) + (second.characters || 0),
  utf8Bytes: (first.utf8Bytes || 0) + (second.utf8Bytes || 0),
  words: (first.words || 0) + (second.words || 0),
  estimatedTokens: (first.estimatedTokens || 0) + (second.estimatedTokens || 0),
})

export function combineUsageBreakdowns(first, second) {
  if (!first) return second || null
  if (!second) return first
  return {
    version: 1,
    calls: (first.calls || 1) + (second.calls || 1),
    estimator: ESTIMATOR,
    payloadMode: first.payloadMode === second.payloadMode ? first.payloadMode : 'mixed',
    userMessage: sumMeasurement(first.userMessage, second.userMessage),
    bunjiContext: {
      ...sumMeasurement(first.bunjiContext, second.bunjiContext),
      historyTurns: (first.bunjiContext?.historyTurns || 0) + (second.bunjiContext?.historyTurns || 0),
    },
    providerHarnessUnknown: { estimatedTokens: null, status: 'pending', reason: null },
  }
}

export function attributeProviderUsage(breakdown, usage) {
  if (!breakdown) return null
  const inputTokens = tokenCount(usage?.inputTokens)
  const localEstimate = tokenCount(breakdown.userMessage?.estimatedTokens) !== null
    && tokenCount(breakdown.bunjiContext?.estimatedTokens) !== null
    ? breakdown.userMessage.estimatedTokens + breakdown.bunjiContext.estimatedTokens : null
  if (inputTokens === null) return {
    ...breakdown,
    providerHarnessUnknown: { estimatedTokens: null, status: 'unavailable', reason: 'Provider input tokens were unavailable.' },
  }
  if (localEstimate === null || localEstimate > inputTokens) return {
    ...breakdown,
    providerHarnessUnknown: { estimatedTokens: null, status: 'unavailable', reason: 'The local text estimate exceeded the provider input count.' },
  }
  return {
    ...breakdown,
    providerHarnessUnknown: { estimatedTokens: inputTokens - localEstimate, status: 'estimated', reason: 'Provider input minus the two local text estimates.' },
  }
}
