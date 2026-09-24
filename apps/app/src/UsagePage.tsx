import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import { ArrowLeft, ArrowUpRight, Check, Clock3, Gauge, Info, KeyRound, Menu, RefreshCw, ShieldCheck, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@bunji/shared/errors'
import type { ProviderStatus } from '@bunji/shared/types'
import './UsagePage.css'

// /api/usage shapes. They come from the Node-only usage reader, so they are not
// in @bunji/shared/types.
interface UsageWindowData {
  readonly id: string
  readonly label: string
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly resetsAt: string | null
}

interface ProviderUsage {
  id: string
  status?: 'ok' | 'signed_out' | 'unsupported' | 'unavailable'
  connected?: boolean | null
  plan?: string | null
  message?: string | null
  windows?: UsageWindowData[]
  source?: string
  credentialSource?: string
}

interface UsageSnapshot {
  checkedAt: string
  providers: Record<string, ProviderUsage | undefined>
}

/** Provider connection state keyed by provider ID. A usage check may not report a plan. */
export type ConnectionStatus = Record<string, Omit<ProviderStatus, 'plan'> & { plan?: string | null }>

interface ProviderInfo {
  label: string
  subtitle: string
  symbol: string
  url: string
  login?: string
}

const providerInfo: Record<string, ProviderInfo> = {
  codex: { label: 'Codex', subtitle: 'ChatGPT subscription', symbol: 'C', url: 'https://chatgpt.com/codex/settings/usage', login: 'codex login' },
  claude: { label: 'Claude', subtitle: 'Claude subscription', symbol: '✳', url: 'https://claude.ai/settings/usage', login: 'claude auth login' },
  openrouter: { label: 'OpenRouter', subtitle: 'API key', symbol: 'OR', url: 'https://openrouter.ai/settings/keys' },
}
// remainingPercent is only null when usedPercent is, which callers check first.
const formatPercent = (value: number | null) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value!)
const planLabel = (plan: string | null | undefined) => ({ prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', max: 'Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' } as Record<string, string | undefined>)[plan as string] || (typeof plan === 'string' ? plan.replaceAll('_', ' ') : null)

function resetLabel(value: string | null, now: number) {
  if (!value) return 'Reset time not reported'
  const reset = Date.parse(value)
  if (!Number.isFinite(reset)) return 'Reset time not reported'
  const minutes = Math.ceil((reset - now) / 60000)
  if (minutes <= 0) return 'Reset time reached · refresh to check'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes % 1440 / 60)
  const mins = minutes % 60
  return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`}`
}

function UsageWindow({ window, provider, now }: { window: UsageWindowData; provider: string; now: number }) {
  const known = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
  const reset = window.resetsAt ? new Date(window.resetsAt) : null
  const expired = reset && Number.isFinite(reset.getTime()) && reset.getTime() <= now
  const level = window.usedPercent! >= 95 ? 'critical' : window.usedPercent! >= 80 ? 'warning' : 'normal'
  return <div className={`usage-window ${level}`}>
    <div className="usage-window-heading"><h3>{window.label}</h3><span>{known ? <><strong>{formatPercent(window.usedPercent)}%</strong> used</> : 'Not reported'}</span></div>
    {known ? <div className="usage-meter" role="progressbar" aria-label={`${provider} ${window.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-valuetext={`${formatPercent(window.usedPercent)}% used, ${formatPercent(window.remainingPercent)}% remaining${expired ? ', reset time reached; refresh needed' : ''}`}><span style={{ width: `${window.usedPercent}%` }} /></div> : <div className="usage-meter unknown" aria-hidden="true" />}
    <div className="usage-window-meta"><span>{known ? `${formatPercent(window.remainingPercent)}% remaining` : 'No usage figure available'}</span><span><Clock3 size={12} />{resetLabel(window.resetsAt, now)}</span></div>
    {reset && Number.isFinite(reset.getTime()) && <time className="usage-reset-date" dateTime={window.resetsAt!}>{reset.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</time>}
  </div>
}

function OpenRouterKey({ data, onChange }: { data: ProviderUsage | undefined; onChange: (provider: ProviderUsage) => void }) {
  const connected = data?.connected === true
  const environment = data?.credentialSource === 'environment'
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !key.trim()) return
    setBusy(true); setError('')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch('/api/providers/openrouter/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: key.trim() }), signal: controller.signal })
      const result = await response.json() as { error?: string; provider: ProviderUsage }
      if (!response.ok) throw new Error(result.error || 'Could not save the key.')
      setKey(''); setEditing(false); onChange(result.provider)
    } catch (next) { setError((next as Error).name === 'AbortError' ? 'Saving the key timed out. Try again.' : errorMessage(next)) }
    finally { clearTimeout(timeout); setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/providers/openrouter/key', { method: 'DELETE' })
      const result = await response.json() as { error?: string; provider: ProviderUsage }
      if (!response.ok) throw new Error(result.error || 'Could not remove the key.')
      setEditing(true); onChange(result.provider)
    } catch (next) { setError(errorMessage(next)) }
    finally { setBusy(false) }
  }
  if (connected && !editing) return <div className="openrouter-key connected"><div><KeyRound size={15} /><span><strong>API key connected</strong><small>{environment ? 'Set by OPENROUTER_API_KEY on this Mac' : 'Stored in macOS Keychain'}</small></span></div><div className="openrouter-key-actions">{!environment && <button type="button" onClick={() => setEditing(true)}>Replace</button>}{!environment && <button type="button" className="remove" onClick={remove} disabled={busy}><Trash2 size={13} />{busy ? 'Removing…' : 'Remove'}</button>}</div></div>
  return <form className="openrouter-key" onSubmit={save}><label htmlFor="openrouter-api-key"><KeyRound size={15} /><span><strong>{connected ? 'Replace API key' : 'Connect OpenRouter'}</strong><small>The key goes straight to your Mac and is stored in Keychain.</small></span></label><div className="openrouter-key-input"><input id="openrouter-api-key" type="password" autoComplete="new-password" spellCheck="false" value={key} onChange={event => setKey(event.target.value)} placeholder="sk-or-v1-…" aria-describedby={error ? 'openrouter-key-error' : undefined} /><button type="submit" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Save key'}</button></div>{connected && <button type="button" className="openrouter-key-cancel" onClick={() => { setEditing(false); setKey(''); setError('') }}>Cancel</button>}{error && <p id="openrouter-key-error" role="alert">{error}</p>}</form>
}

interface ProviderCardProps {
  id: string
  data: ProviderUsage | undefined
  loading: boolean
  now: number
  onProviderChange: (provider: ProviderUsage) => void
}

function ProviderCard({ id, data, loading, now, onProviderChange }: ProviderCardProps) {
  const info = providerInfo[id]
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const command = useRef<HTMLInputElement>(null)
  const state = !data ? (loading ? 'loading' : 'unavailable') : data.status
  const badge = ({ ok: 'Connected', signed_out: 'Not signed in', unsupported: 'No subscription meter', unavailable: 'Usage unavailable', loading: 'Checking…' } as Record<string, string | undefined>)[state as string] || 'Usage unavailable'
  const windows = Array.isArray(data?.windows) ? data.windows : []
  const copy = async () => {
    try { await navigator.clipboard.writeText(info.login!); setCopied(true); setCopyError(false) }
    catch { command.current?.focus(); command.current?.select(); setCopyError(true) }
  }
  return <article className={`usage-provider ${id}`} aria-labelledby={`usage-${id}-title`}>
    <header className="usage-provider-heading"><span className="usage-provider-icon" aria-hidden="true">{info.symbol}</span><div><h2 id={`usage-${id}-title`}>{info.label}</h2><p>{planLabel(data?.plan) ? `${planLabel(data!.plan)} subscription` : info.subtitle}</p></div><span className={`usage-badge ${state}`}><i />{badge}</span></header>
    {state === 'loading' ? <div className="usage-loading" role="status"><div /><div /><p>Reading limits from this Mac…</p></div> : <>
      {data?.message && <p className="usage-state-message">{data.message}</p>}
      {windows.length > 0 && <div className="usage-windows">{windows.map(window => <UsageWindow key={window.id} window={window} provider={info.label} now={now} />)}</div>}
      {!windows.length && state === 'ok' && <p className="usage-state-message">No usage windows were reported.</p>}
      {state === 'signed_out' && id !== 'openrouter' && <div className="usage-login"><div><Terminal size={15} /><span>Run this on your Mac</span></div><div className="usage-command"><input ref={command} readOnly aria-label={`${info.label} sign-in command`} value={info.login} onFocus={event => event.target.select()} /><button onClick={copy} type="button">{copied ? <><Check size={13} />Copied</> : 'Copy'}</button></div><p>{copyError ? 'The command is selected. Press and hold to copy it on your phone.' : 'Finish signing in there, then refresh this page.'}</p></div>}
      {id === 'openrouter' && <OpenRouterKey data={data} onChange={onProviderChange} />}
      {!data && state === 'unavailable' && <p className="usage-state-message">The local bridge did not return usage. Make sure it is running on your Mac.</p>}
    </>}
    <footer className="usage-provider-footer"><span>{data?.source || 'Local account connection'}</span><a href={info.url} target="_blank" rel="noreferrer">Provider usage <ArrowUpRight size={13} /></a></footer>
  </article>
}

interface UsagePageProps {
  onMenu: () => void
  onBack: () => void
  setConnectionStatus?: Dispatch<SetStateAction<ConnectionStatus>>
}

export default function UsagePage({ onMenu, onBack, setConnectionStatus }: UsagePageProps) {
  const [data, setData] = useState<UsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const requestRef = useRef<AbortController | null>(null)
  const updateProvider = useCallback((provider: ProviderUsage) => {
    setData(current => current ? { ...current, checkedAt: new Date().toISOString(), providers: { ...current.providers, [provider.id]: provider } } : { checkedAt: new Date().toISOString(), providers: { [provider.id]: provider } })
    if (typeof provider.connected === 'boolean') setConnectionStatus?.(current => ({ ...current, [provider.id]: { connected: provider.connected as boolean, plan: provider.plan } }))
  }, [setConnectionStatus])
  const refresh = useCallback(async (force = false) => {
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    const timeout = setTimeout(() => controller.abort(), 35000)
    try {
      const response = await fetch('/api/usage' + (force ? '?refresh=1' : ''), { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Usage request failed')
      const next = await response.json() as UsageSnapshot
      if (!next.providers || !next.checkedAt) throw new Error('Invalid usage response')
      if (requestRef.current !== controller) return
      setData(next); setError(''); setNow(Date.now())
      setConnectionStatus?.(current => ({ ...current, ...Object.fromEntries(Object.entries(next.providers).filter(([, provider]) => typeof provider!.connected === 'boolean').map(([id, provider]) => [id, { connected: provider!.connected as boolean, plan: provider!.plan }])) }))
    } catch {
      if (requestRef.current === controller) setError('Could not refresh usage. Check the connection to your Mac and try again. Any meters below are from the last successful check.')
    } finally {
      clearTimeout(timeout)
      if (requestRef.current === controller) { requestRef.current = null; setLoading(false) }
    }
  }, [setConnectionStatus])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Fetch synchronization; state updates occur only after the awaited request.
    refresh()
    const interval = setInterval(() => { setNow(Date.now()); if (!document.hidden) { setLoading(true); refresh() } }, 60000)
    const visible = () => { if (!document.hidden) { setLoading(true); refresh() } }
    document.addEventListener('visibilitychange', visible)
    return () => { const request = requestRef.current; requestRef.current = null; request?.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', visible) }
  }, [refresh])

  return <>
    <header className="chat-heading usage-page-heading"><Button className="mobile-menu" variant="ghost" size="icon" aria-label="Open menu" onClick={onMenu}><Menu /></Button><Button variant="ghost" size="icon" aria-label="Back to chat" onClick={onBack}><ArrowLeft /></Button><span>Usage</span></header>
    <div className="usage-scroll"><div className="usage-content">
      <div className="usage-title"><div><span className="usage-eyebrow"><Gauge size={14} />ACCOUNT USAGE</span><h1>A little headroom.</h1><p>Your model accounts and API limits, in one place.</p></div><Button variant="outline" className="usage-refresh" disabled={loading} onClick={() => { setLoading(true); refresh(true) }}><RefreshCw size={15} className={loading ? 'usage-spinning' : ''} />{loading ? 'Checking…' : 'Refresh'}</Button></div>
      <div className="usage-scope"><Info size={15} /><p>Account-wide usage, including activity outside BunjiBox. Subscription logins and API keys stay on your Mac.</p></div>
      {error && <p role="alert" className="usage-error">{error}</p>}
      <div className={`usage-provider-grid${error ? ' stale' : ''}`} aria-busy={loading}>{Object.keys(providerInfo).map(id => <ProviderCard key={id} id={id} data={data?.providers?.[id]} loading={loading} now={now} onProviderChange={updateProvider} />)}</div>
      <div className="usage-page-footer"><p><ShieldCheck size={14} />Login credentials stay on your Mac. Usage checks don’t send a model prompt.</p><p>{data?.checkedAt ? `Last checked ${new Date(data.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. ` : ''}Auto-refreshes every minute while this page is visible.</p><p>Only limits reported by each provider are shown. Missing data never counts as zero usage.</p></div>
    </div></div>
  </>
}
