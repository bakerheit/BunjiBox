import type { ChatRequest, HistoryPage, MemoryList, MemoryNote, RewindResult } from './types.ts'
import { errorMessage } from './errors.ts'

/** A request error. `ambiguous` means the write may have committed anyway. */
export type ChatClientError = Error & { status?: number; ambiguous?: boolean; botId?: string }

/** A bot's loaded history, plus client-side paging state. */
export interface BotHistory extends HistoryPage {
  ready: boolean
  expanded: boolean
  loadingOlder: boolean
}

export interface ChatClientState {
  histories: Record<string, BotHistory>
  /** The active bot's error, kept for older consumers. */
  error: string
  errors: Record<string, string>
}

export interface SendOptions {
  provider?: string
  model?: string
  effort?: string
  mode?: string
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const ambiguousResponse = (): ChatClientError => Object.assign(new Error('Bunji returned an unreadable response. Your run may still be running. Reconnect to check; retrying the same message is safe.'), { ambiguous: true })
const forBot = (error: unknown, botId: string): ChatClientError => {
  const source = error as ChatClientError
  return Object.assign(new Error(`Bot "${botId}": ${errorMessage(error)}`, { cause: error }), { status: source?.status, ambiguous: source?.ambiguous, botId })
}
const botError = (errors: Record<string, string>, botId: string | undefined): string => botId !== undefined && Object.hasOwn(errors, botId) ? errors[botId] : ''
const acknowledged = (result: { request?: Partial<ChatRequest> } | null | undefined, id: string): result is { request: ChatRequest } =>
  result?.request?.id === id && typeof result.request.prompt === 'string' && typeof result.request.status === 'string'

function historyPage(value: unknown): HistoryPage {
  const page = value as HistoryPage | null | undefined
  if (!page || !Array.isArray(page.requests) || !Number.isSafeInteger(page.revision) || page.revision < 0
    || typeof page.hasMore !== 'boolean' || (page.hasMore ? typeof page.nextBefore !== 'string' || !page.nextBefore : page.nextBefore !== null)
    || page.requests.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.prompt !== 'string')
    || new Set(page.requests.map(item => item.id)).size !== page.requests.length
    || page.hasMore && !page.requests.length) throw new Error('Bunji returned incomplete history. Reconnect to reload; your saved conversation has not been replaced.')
  return page
}

export class ChatClient {
  baseUrl: string
  fetcher: Fetcher
  pollMs: number
  listeners = new Set<() => void>()
  state: ChatClientState = { histories: {}, error: '', errors: {} }
  activeId: string | undefined
  pending = new Map<string, string>()
  refreshing = new Map<string, Promise<BotHistory | null | undefined>>()
  sending = new Map<string, Promise<ChatRequest>>()
  timer: ReturnType<typeof setInterval> | null = null

  constructor({ baseUrl = '', fetcher = (input, init) => fetch(input, init), pollMs = 1200 }: { baseUrl?: string; fetcher?: Fetcher; pollMs?: number } = {}) {
    this.baseUrl = baseUrl; this.fetcher = fetcher; this.pollMs = pollMs
  }
  getSnapshot = (): ChatClientState => this.state
  subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  publish(patch: Partial<ChatClientState>) { this.state = { ...this.state, ...patch }; for (const callback of this.listeners) callback() }
  // Keep the legacy error string for consumers; it always belongs to the active bot.
  publishBot(botId: string, patch: Partial<ChatClientState> = {}, error = '') {
    const errors = { ...this.state.errors, [botId]: error }
    this.publish({ ...patch, errors, error: botError(errors, this.activeId || botId) })
  }
  // oxlint-disable-next-line typescript/no-explicit-any -- JSON responses are validated by each caller.
  async request(path: string, options: RequestInit = {}): Promise<any> {
    let response: Response
    try { response = await this.fetcher(this.baseUrl + path, { cache: 'no-store', ...options, signal: AbortSignal.timeout(10000) }) }
    catch { throw new Error('Cannot reach Bunji. Your run may still be running on the Mac. Reconnect to check; retrying the same message is safe.') }
    let result: { error?: unknown } | null
    try { result = await response.json() as { error?: unknown } | null } catch { throw ambiguousResponse() }
    if (!response.ok) {
      const message = typeof result?.error === 'string' && result.error
      // A timeout, proxy/5xx failure, or malformed reply may follow a committed write.
      const rejected = Boolean(message) && response.status >= 400 && response.status < 500 && response.status !== 408
      throw Object.assign(new Error(`Bunji request failed: ${message || 'No readable error was returned.'}`), { status: response.status, ambiguous: !rejected })
    }
    return result
  }
  write(path: string, body: unknown) { return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  activate(botId: string | undefined) { this.activeId = botId; this.publish({ error: botError(this.state.errors, botId) }); if (botId) void this.refresh(botId); }
  start() {
    if (!this.timer) this.timer = setInterval(() => { if (this.activeId) void this.refresh(this.activeId) }, this.pollMs)
    if (this.activeId) void this.refresh(this.activeId)
    return () => this.stop()
  }
  // Disconnecting an observer must never cancel a server-owned run or pending send.
  stop() { clearInterval(this.timer ?? undefined); this.timer = null }
  async refresh(botId = this.activeId): Promise<BotHistory | null | undefined> {
    if (!botId) return
    if (this.refreshing.has(botId)) return this.refreshing.get(botId)
    const task = (async (): Promise<BotHistory | null | undefined> => {
      try {
        const path = `/api/bots/${encodeURIComponent(botId)}/history`
        const page = historyPage(await this.request(path))
        let old = this.state.histories[botId]
        if (old?.ready && old.revision >= page.revision) { if (this.state.errors[botId]) this.publishBot(botId); return old }
        let tail = page.requests, boundary = page
        const cursors = new Set<string | null>()
        // Refresh loaded older pages after a revision. If an older page is
        // already loading, bridge to its overlap and let that read finish.
        while ((old?.expanded || old?.loadingOlder) && old.requests.length && tail.length && boundary.hasMore
          && !(old.loadingOlder ? tail.some(item => old!.requests.some(previous => previous.id === item.id))
            : tail.some(item => item.id === old.requests[0].id))) {
          if (cursors.has(boundary.nextBefore)) throw new Error('Bunji history pagination did not advance. Reconnect to try again.')
          cursors.add(boundary.nextBefore)
          boundary = historyPage(await this.request(`${path}?before=${encodeURIComponent(boundary.nextBefore!)}`))
          const seen = new Set(tail.map(item => item.id))
          tail = [...boundary.requests.filter(item => !seen.has(item.id)), ...tail]
          old = this.state.histories[botId]
        }
        // Merge into the current snapshot: loadOlder may have completed during a read.
        old = this.state.histories[botId]
        const preserve = old?.expanded || old?.loadingOlder
        const oldestLoaded = preserve ? tail.findIndex(item => item.id === old!.requests[0]?.id) : -1
        if (oldestLoaded > 0) tail = tail.slice(oldestLoaded)
        const seen = new Set(tail.map(item => item.id))
        const older = preserve ? old!.requests.filter(item => !seen.has(item.id)) : []
        const history: BotHistory = { ...page, requests: [...older, ...tail], ready: true, expanded: old?.expanded || false, loadingOlder: old?.loadingOlder || false,
          ...(preserve ? { hasMore: old!.hasMore, nextBefore: old!.nextBefore } : {}) }
        this.publishBot(botId, { histories: { ...this.state.histories, [botId]: history } })
        return history
      } catch (error) { this.publishBot(botId, {}, errorMessage(error)); return null }
    })()
    this.refreshing.set(botId, task)
    try { return await task } finally { this.refreshing.delete(botId) }
  }
  async loadOlder(botId = this.activeId) {
    if (!botId) return
    const old = this.state.histories[botId]
    if (!old?.hasMore || old.loadingOlder) return
    this.publish({ histories: { ...this.state.histories, [botId]: { ...old, loadingOlder: true } } })
    try {
      const page = historyPage(await this.request(`/api/bots/${encodeURIComponent(botId)}/history?before=${encodeURIComponent(old.nextBefore!)}`))
      const current = this.state.histories[botId]
      const seen = new Set(current.requests.map(item => item.id))
      this.publishBot(botId, { histories: { ...this.state.histories, [botId]: { ...current, requests: [...page.requests.filter(item => !seen.has(item.id)), ...current.requests], hasMore: page.hasMore, nextBefore: page.nextBefore, expanded: true, loadingOlder: false } } })
    } catch (error) { this.publishBot(botId, { histories: { ...this.state.histories, [botId]: { ...this.state.histories[botId], loadingOlder: false } } }, errorMessage(error)) }
  }
  async send(botId: string, prompt: string, { provider, model, effort, mode }: SendOptions = {}): Promise<ChatRequest> {
    const payload = { prompt, provider, model, effort, mode, memoryWrite: mode !== 'chat' }
    const key = JSON.stringify([botId, payload])
    const inflight = this.sending.get(key)
    if (inflight) return inflight
    // randomUUID requires HTTPS in browsers; LAN phones use plain HTTP in alpha.
    const id = this.pending.get(key) || 'run-' + [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    this.pending.set(key, id)
    const task = (async () => {
      try {
        const result = await this.write(`/api/bots/${encodeURIComponent(botId)}/messages`, { id, ...payload })
        if (!acknowledged(result, id)) throw ambiguousResponse()
        this.pending.delete(key)
        // Keep coalescing through reconciliation, not just until the POST resolves.
        await this.refreshing.get(botId)
        await this.refresh(botId)
        return result.request
      } catch (error) {
        const failure = error as ChatClientError
        if (failure.status && failure.ambiguous === false) this.pending.delete(key)
        throw forBot(error, botId)
      }
    })()
    this.sending.set(key, task)
    try { return await task } finally { this.sending.delete(key) }
  }
  async cancel(id: string): Promise<ChatRequest> {
    let botId: string | undefined = Object.keys(this.state.histories).find(key => this.state.histories[key].requests.some(item => item.id === id)) || this.activeId
    try {
      const result = await this.write(`/api/runs/${encodeURIComponent(id)}/cancel`, {})
      if (!acknowledged(result, id)) throw ambiguousResponse()
      botId = result.request.botId || botId
      if (botId) { await this.refreshing.get(botId); await this.refresh(botId) }
      return result.request
    } catch (error) { throw botId ? forBot(error, botId) : error }
  }
  async editMessage(botId: string, id: string, role: 'user' | 'assistant', value: string, expectedText: string): Promise<ChatRequest> {
    try {
      const result = await this.request(`/api/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, value, expectedText }),
      })
      if (result?.request?.id !== id) throw ambiguousResponse()
      await this.refreshing.get(botId)
      await this.refresh(botId)
      return result.request as ChatRequest
    } catch (error) { throw forBot(error, botId) }
  }
  async rewindMessage(botId: string, id: string, expectedPrompt: string): Promise<RewindResult> {
    try {
      const result = await this.write(`/api/bots/${encodeURIComponent(botId)}/rewind`, { id, expectedPrompt })
      if (result?.rewind?.id !== id || result.rewind.botId !== botId || typeof result.rewind.prompt !== 'string') throw ambiguousResponse()
      await this.refreshing.get(botId)
      await this.refresh(botId)
      return result.rewind
    } catch (error) { throw forBot(error, botId) }
  }
  async memoryList(botId: string, query = ''): Promise<MemoryList> { return this.request(`/api/bots/${encodeURIComponent(botId)}/memory${query ? '?q=' + encodeURIComponent(query) : ''}`) }
  async memoryRead(botId: string, id: string): Promise<MemoryNote> { return (await this.request(`/api/bots/${encodeURIComponent(botId)}/memory/${encodeURIComponent(id)}`)).note }
}
