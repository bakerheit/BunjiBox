import { Activity, ArrowLeft, ChevronsRight, Clock3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { summarizeRequests, tokenCount } from '@bunji/shared/token-usage'
import { modeDisplay } from '@bunji/shared/runtimes'
import type { ChatRequest, UsageBreakdown } from '@bunji/shared/types'
import type { RequestSummary } from '@bunji/shared/token-usage'
import './TokenLog.css'
import RunActivity from './RunActivity'

/** A saved request as the chat view and token log show it. */
export type LoggedRequest = ChatRequest & {
  preview: string
  serverId: string
  modelLabel: string
  // Not part of the shared ChatRequest: only live run results carry it, so it
  // is usually absent from saved history.
  activityLimited?: boolean
}

function Total({ label, metric }: { label: string; metric: RequestSummary['totals']['totalTokens'] }) {
  return <div><dt>{label}</dt><dd>{metric.partial && metric.value !== null ? '≥ ' : ''}{tokenCount(metric.value)}</dd></div>
}

function EstimatedTokens({ value, pending = false }: { value: number | null | undefined; pending?: boolean }) {
  if (!Number.isSafeInteger(value)) return <strong>{pending ? 'Pending' : 'Unavailable'}</strong>
  return <strong>~{tokenCount(value)} tokens</strong>
}

const providerCount = (value: number | null | undefined) => Number.isSafeInteger(value) && (value as number) >= 0 ? tokenCount(value) : 'Unavailable'

export function InputAttribution({ breakdown }: { breakdown: UsageBreakdown | null | undefined }) {
  if (!breakdown) return <p className="token-missing">Input attribution is unavailable for this older request.</p>
  const user = breakdown.userMessage
  const context = breakdown.bunjiContext
  const harness = breakdown.providerHarnessUnknown
  const calls = Number.isSafeInteger(breakdown.calls) && breakdown.calls! > 0 ? breakdown.calls! : 1
  return <section className="token-attribution" aria-label="Input attribution">
    <div className="token-attribution-heading"><h3>Input attribution</h3><span>{calls > 1 ? `${calls} provider calls · ` : ''}~ means estimated</span></div>
    <div className="token-attribution-grid">
      <div><span>{calls > 1 ? 'Typed message payloads' : 'Typed message'}</span><EstimatedTokens value={user?.estimatedTokens} /><small>{tokenCount(user?.characters)} exact chars sent · {tokenCount(user?.words)} exact words sent</small></div>
      <div><span>Bunji context &amp; history</span><EstimatedTokens value={context?.estimatedTokens} /><small>{tokenCount(context?.characters)} exact chars · {tokenCount(context?.historyTurns)} saved exchanges</small></div>
      <div><span>Provider harness / unknown</span><EstimatedTokens value={harness?.estimatedTokens} pending={harness?.status === 'pending'} /><small>{harness?.reason || 'Waiting for exact provider input.'}</small></div>
    </div>
    <p>Local token sizes use UTF-8 bytes ÷ 4. Provider counts below are exact values reported by the provider.</p>
  </section>
}

interface TokenLogProps {
  requests: LoggedRequest[]
  botName: string
  onClose?: () => void
  onBack?: () => void
  hasMore?: boolean
  compact?: boolean
}

export default function TokenLog({ requests, botName, onClose, onBack, hasMore = false, compact = false }: TokenLogProps) {
  const { totals, count, measured, pending } = summarizeRequests(requests)
  return <>
    <header className="panel-heading">{!compact && <Button variant="ghost" size="icon" aria-label="Back to bot details" onClick={onBack}><ArrowLeft /></Button>}<h2>Activity & tokens</h2><Button variant="ghost" size="icon" aria-label="Close token log" onClick={onClose}><ChevronsRight /></Button></header>
    <div className="panel-scroll token-log" aria-label={`${botName} token log`}>
      <div className="token-summary"><span className="token-eyebrow"><Activity size={13} />CONVERSATION TOTAL</span><div className="token-total">{totals.totalTokens.partial && totals.totalTokens.value !== null ? '≥ ' : ''}{tokenCount(totals.totalTokens.value)}<span>tokens</span></div><p>{count} request{count === 1 ? '' : 's'} · {measured} measured{pending ? ` · ${pending} running` : ''}</p><dl className="token-stats"><Total label="Input" metric={totals.inputTokens} /><Total label="Output" metric={totals.outputTokens} /><Total label="Cache read" metric={totals.cachedInputTokens} /></dl></div>
      <p className="token-explainer">{hasMore ? 'Totals cover loaded messages only. Load older messages in chat to include more.' : 'Cumulative usage for this saved chat, not its context size.'} Cached tokens are included in input, not added again. Counts arrive when a request finishes.</p>
      {count > measured && <p className="token-partial">Some counts are pending or unavailable. Totals marked ≥ include only reported usage.</p>}
      <div className="token-log-list" aria-live="polite" aria-relevant="additions text">
        {!requests.length && <div className="token-empty"><Activity size={25} /><h3>No requests yet</h3><p>Send a message. Its input, output, and cache counts will appear here.</p></div>}
        {[...requests].reverse().map((request, index) => <article className="token-request" key={request.id}>
          <header><strong>Request {requests.length - index}</strong><span className={`token-request-status ${request.status}`}>{request.status === 'running' ? 'Running…' : request.status}</span></header>
          <p className="token-runtime">{request.modelLabel} · {request.effort} · {modeDisplay(request.requestedMode, request.mode)}</p>
          <p className="token-prompt" title={request.preview}>{request.preview}</p>
          {Number.isInteger(request.contextTurns) && <p className="token-missing">Context: {request.contextTurns} recent exchanges included · {request.omittedTurns} older exchanges omitted. {request.mode === 'chat' ? 'Memory and machine tools unavailable for this Chat request.' : 'Memory writes enabled for this Agent request.'}{request.modeReason ? ` ${request.modeReason}` : ''}</p>}
          <RunActivity activities={request.activities} status={request.status} limited={request.activityLimited} />
          <InputAttribution breakdown={request.usageBreakdown} />
          <dl className="token-request-stats"><div><dt>Provider input</dt><dd>{providerCount(request.usage?.inputTokens)}</dd></div><div><dt>Provider output</dt><dd>{providerCount(request.usage?.outputTokens)}</dd></div><div><dt>Cache read <span>(included in input)</span></dt><dd>{providerCount(request.usage?.cachedInputTokens)}</dd></div><div><dt>Cache write <span>(included in input)</span></dt><dd>{providerCount(request.usage?.cacheWriteTokens)}</dd></div><div><dt>Reasoning output <span>(included in output)</span></dt><dd>{providerCount(request.usage?.reasoningOutputTokens)}</dd></div><div className="token-request-total"><dt>Provider total</dt><dd>{providerCount(request.usage?.totalTokens)}</dd></div></dl>
          {request.usage?.source && <p className="token-provider-source">Exact source: {request.usage.source}</p>}
          {!request.usage && <p className="token-missing">{request.status === 'running' ? 'Waiting for provider counts…' : 'The provider did not return token counts. This is not zero usage.'}</p>}
          {request.error && <p className="token-request-error">{request.error}</p>}
          <footer><span><Clock3 size={11} />{new Date(request.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span><span>{typeof request.durationMs === 'number' ? `${(request.durationMs / 1000).toFixed(1)}s` : 'In progress'}</span></footer>
          {request.serverId && <code className="token-request-id" title={request.serverId}>{request.serverId}</code>}
        </article>)}
      </div>
      <p className="token-footnote">Provider input can include system instructions, model harnesses, tools, and cached context that Bunji cannot inspect. Local text estimates explain the visible payload without pretending the remainder is exact. This log is saved on your Mac and shared across devices.</p>
    </div>
  </>
}
