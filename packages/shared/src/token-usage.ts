import type { ChatRequest, TokenField } from './types.ts'

export const isTokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

type SummaryField = Exclude<TokenField, 'reasoningOutputTokens'>
export interface RequestSummary {
  totals: Record<SummaryField, { value: number | null; partial: boolean }>
  count: number
  measured: number
  pending: number
  failed: number
}

export function summarizeRequests(requests: readonly Pick<ChatRequest, 'usage' | 'status'>[]): RequestSummary {
  const fields: SummaryField[] = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'totalTokens']
  const totals = Object.fromEntries(fields.map(field => {
    const known = requests.filter(request => isTokenCount(request.usage?.[field]))
    return [field, { value: known.length || !requests.length ? known.reduce((sum, request) => sum + (request.usage![field] as number), 0) : null, partial: known.length < requests.length }]
  })) as RequestSummary['totals']
  return { totals, count: requests.length, measured: requests.filter(request => isTokenCount(request.usage?.totalTokens)).length, pending: requests.filter(request => request.status === 'running').length, failed: requests.filter(request => request.status === 'failed').length }
}

export function tokenCount(value: unknown): string {
  return isTokenCount(value) ? value.toLocaleString() : '—'
}
