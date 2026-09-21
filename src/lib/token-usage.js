export const isTokenCount = value => Number.isSafeInteger(value) && value >= 0

export function summarizeRequests(requests) {
  const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'totalTokens']
  const totals = Object.fromEntries(fields.map(field => {
    const known = requests.filter(request => isTokenCount(request.usage?.[field]))
    return [field, { value: known.length || !requests.length ? known.reduce((sum, request) => sum + request.usage[field], 0) : null, partial: known.length < requests.length }]
  }))
  return { totals, count: requests.length, measured: requests.filter(request => isTokenCount(request.usage?.totalTokens)).length, pending: requests.filter(request => request.status === 'running').length, failed: requests.filter(request => request.status === 'failed').length }
}

export function tokenCount(value) {
  return isTokenCount(value) ? value.toLocaleString() : '—'
}
