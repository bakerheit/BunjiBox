import { Activity, ArrowLeft, ChevronsRight, Clock3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { summarizeRequests, tokenCount } from '@bunji/shared/token-usage'
import './TokenLog.css'
import RunActivity from './RunActivity'

function Total({ label, metric }) {
  return <div><dt>{label}</dt><dd>{metric.partial && metric.value !== null ? '≥ ' : ''}{tokenCount(metric.value)}</dd></div>
}

export default function TokenLog({ requests, botName, onClose, onBack, hasMore = false, compact = false }) {
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
          <p className="token-runtime">{request.modelLabel} · {request.effort}</p>
          <p className="token-prompt" title={request.preview}>{request.preview}</p>
          {Number.isInteger(request.contextTurns) && <p className="token-missing">Context: {request.contextTurns} recent exchanges included · {request.omittedTurns} older exchanges omitted. Memory {request.memoryWrite ? 'writes enabled' : 'read-only'} for this request.</p>}
          <RunActivity activities={request.activities} status={request.status} limited={request.activityLimited} />
          <dl className="token-request-stats"><div><dt>Request input</dt><dd>{tokenCount(request.usage?.inputTokens)}</dd></div><div><dt>Response output</dt><dd>{tokenCount(request.usage?.outputTokens)}</dd></div><div><dt>Cache read <span>(in input)</span></dt><dd>{tokenCount(request.usage?.cachedInputTokens)}</dd></div>{request.provider === 'claude' && <div><dt>Cache write <span>(in input)</span></dt><dd>{tokenCount(request.usage?.cacheWriteTokens)}</dd></div>}<div className="token-request-total"><dt>Total tokens</dt><dd>{tokenCount(request.usage?.totalTokens)}</dd></div></dl>
          {!request.usage && <p className="token-missing">{request.status === 'running' ? 'Waiting for provider counts…' : 'The provider did not return token counts. This is not zero usage.'}</p>}
          {request.error && <p className="token-request-error">{request.error}</p>}
          <footer><span><Clock3 size={11} />{new Date(request.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span><span>{typeof request.durationMs === 'number' ? `${(request.durationMs / 1000).toFixed(1)}s` : 'In progress'}</span></footer>
          {request.serverId && <code className="token-request-id" title={request.serverId}>{request.serverId}</code>}
        </article>)}
      </div>
      <p className="token-footnote">Input includes provider/system instructions, bot description, recent chat, and tool context. Exact tokens for just the typed text are not separately reported. This log is saved on your Mac and shared across devices.</p>
    </div>
  </>
}
