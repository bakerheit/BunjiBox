const ambiguousResponse = () => Object.assign(new Error('Bunji returned an unreadable response. Your run may still be running. Reconnect to check; retrying the same message is safe.'), { ambiguous: true })
const forBot = (error, botId) => Object.assign(new Error(`Bot "${botId}": ${error.message}`, { cause: error }), { status: error.status, ambiguous: error.ambiguous, botId })
const botError = (errors, botId) => Object.hasOwn(errors, botId) ? errors[botId] : ''
const acknowledged = (result, id) => result?.request?.id === id && typeof result.request.prompt === 'string' && typeof result.request.status === 'string'

function historyPage(page) {
  if (!Array.isArray(page?.requests) || !Number.isSafeInteger(page.revision) || page.revision < 0
    || typeof page.hasMore !== 'boolean' || (page.hasMore ? typeof page.nextBefore !== 'string' || !page.nextBefore : page.nextBefore !== null)
    || page.requests.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.prompt !== 'string')
    || new Set(page.requests.map(item => item.id)).size !== page.requests.length
    || page.hasMore && !page.requests.length) throw new Error('Bunji returned incomplete history. Reconnect to reload; your saved conversation has not been replaced.')
  return page
}

export class ChatClient {
  constructor({ baseUrl = '', fetcher = (...args) => fetch(...args), pollMs = 1200 } = {}) {
    this.baseUrl = baseUrl; this.fetcher = fetcher; this.pollMs = pollMs
    this.listeners = new Set(); this.state = { histories: {}, error: '', errors: {} }
    this.pending = new Map(); this.refreshing = new Map(); this.sending = new Map()
  }
  getSnapshot = () => this.state
  subscribe = callback => { this.listeners.add(callback); return () => this.listeners.delete(callback) }
  publish(patch) { this.state = { ...this.state, ...patch }; for (const callback of this.listeners) callback() }
  // Keep the legacy error string for consumers; it always belongs to the active bot.
  publishBot(botId, patch = {}, error = '') {
    const errors = { ...this.state.errors, [botId]: error }
    this.publish({ ...patch, errors, error: botError(errors, this.activeId || botId) })
  }
  async request(path, options = {}) {
    let response
    try { response = await this.fetcher(this.baseUrl + path, { cache: 'no-store', ...options, signal: AbortSignal.timeout(10000) }) }
    catch { throw new Error('Cannot reach Bunji. Your run may still be running on the Mac. Reconnect to check; retrying the same message is safe.') }
    let result
    try { result = await response.json() } catch { throw ambiguousResponse() }
    if (!response.ok) {
      const message = typeof result?.error === 'string' && result.error
      // A timeout, proxy/5xx failure, or malformed reply may follow a committed write.
      const rejected = Boolean(message) && response.status >= 400 && response.status < 500 && response.status !== 408
      throw Object.assign(new Error(`Bunji request failed: ${message || 'No readable error was returned.'}`), { status: response.status, ambiguous: !rejected })
    }
    return result
  }
  write(path, body) { return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  activate(botId) { this.activeId = botId; this.publish({ error: botError(this.state.errors, botId) }); if (botId) void this.refresh(botId); }
  start() {
    if (!this.timer) this.timer = setInterval(() => { if (this.activeId) void this.refresh(this.activeId) }, this.pollMs)
    if (this.activeId) void this.refresh(this.activeId)
    return () => this.stop()
  }
  // Disconnecting an observer must never cancel a server-owned run or pending send.
  stop() { clearInterval(this.timer); this.timer = null }
  async refresh(botId = this.activeId) {
    if (!botId) return
    if (this.refreshing.has(botId)) return this.refreshing.get(botId)
    const task = (async () => {
      try {
        const path = `/api/bots/${encodeURIComponent(botId)}/history`
        const page = historyPage(await this.request(path))
        let old = this.state.histories[botId]
        if (old?.ready && old.revision >= page.revision) { if (this.state.errors[botId]) this.publishBot(botId); return old }
        let tail = page.requests, boundary = page
        const cursors = new Set()
        // Refresh loaded older pages after a revision. If an older page is
        // already loading, bridge to its overlap and let that read finish.
        while ((old?.expanded || old?.loadingOlder) && old.requests.length && tail.length && boundary.hasMore
          && !(old.loadingOlder ? tail.some(item => old.requests.some(previous => previous.id === item.id))
            : tail.some(item => item.id === old.requests[0].id))) {
          if (cursors.has(boundary.nextBefore)) throw new Error('Bunji history pagination did not advance. Reconnect to try again.')
          cursors.add(boundary.nextBefore)
          boundary = historyPage(await this.request(`${path}?before=${encodeURIComponent(boundary.nextBefore)}`))
          const seen = new Set(tail.map(item => item.id))
          tail = [...boundary.requests.filter(item => !seen.has(item.id)), ...tail]
          old = this.state.histories[botId]
        }
        // Merge into the current snapshot: loadOlder may have completed during a read.
        old = this.state.histories[botId]
        const preserve = old?.expanded || old?.loadingOlder
        const oldestLoaded = preserve && tail.findIndex(item => item.id === old.requests[0]?.id)
        if (oldestLoaded > 0) tail = tail.slice(oldestLoaded)
        const seen = new Set(tail.map(item => item.id))
        const older = preserve ? old.requests.filter(item => !seen.has(item.id)) : []
        const history = { ...page, requests: [...older, ...tail], ready: true, expanded: old?.expanded || false, loadingOlder: old?.loadingOlder || false,
          ...(preserve ? { hasMore: old.hasMore, nextBefore: old.nextBefore } : {}) }
        this.publishBot(botId, { histories: { ...this.state.histories, [botId]: history } })
        return history
      } catch (error) { this.publishBot(botId, {}, error.message); return null }
    })()
    this.refreshing.set(botId, task)
    try { return await task } finally { this.refreshing.delete(botId) }
  }
  async loadOlder(botId = this.activeId) {
    const old = this.state.histories[botId]
    if (!old?.hasMore || old.loadingOlder) return
    this.publish({ histories: { ...this.state.histories, [botId]: { ...old, loadingOlder: true } } })
    try {
      const page = historyPage(await this.request(`/api/bots/${encodeURIComponent(botId)}/history?before=${encodeURIComponent(old.nextBefore)}`))
      const current = this.state.histories[botId]
      const seen = new Set(current.requests.map(item => item.id))
      this.publishBot(botId, { histories: { ...this.state.histories, [botId]: { ...current, requests: [...page.requests.filter(item => !seen.has(item.id)), ...current.requests], hasMore: page.hasMore, nextBefore: page.nextBefore, expanded: true, loadingOlder: false } } })
    } catch (error) { this.publishBot(botId, { histories: { ...this.state.histories, [botId]: { ...this.state.histories[botId], loadingOlder: false } } }, error.message) }
  }
  async send(botId, prompt, { provider, model, effort } = {}) {
    const payload = { prompt, provider, model, effort, memoryWrite: true }
    const key = JSON.stringify([botId, payload])
    if (this.sending.has(key)) return this.sending.get(key)
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
        if (error.status && error.ambiguous === false) this.pending.delete(key)
        throw forBot(error, botId)
      }
    })()
    this.sending.set(key, task)
    try { return await task } finally { this.sending.delete(key) }
  }
  async cancel(id) {
    let botId = Object.keys(this.state.histories).find(key => this.state.histories[key].requests.some(item => item.id === id)) || this.activeId
    try {
      const result = await this.write(`/api/runs/${encodeURIComponent(id)}/cancel`, {})
      if (!acknowledged(result, id)) throw ambiguousResponse()
      botId = result.request.botId || botId
      if (botId) { await this.refreshing.get(botId); await this.refresh(botId) }
      return result.request
    } catch (error) { throw botId ? forBot(error, botId) : error }
  }
  async editMessage(botId, id, role, value, expectedText) {
    try {
      const result = await this.request(`/api/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, value, expectedText }),
      })
      if (result?.request?.id !== id) throw ambiguousResponse()
      await this.refreshing.get(botId)
      await this.refresh(botId)
      return result.request
    } catch (error) { throw forBot(error, botId) }
  }
  async memoryList(botId, query = '') { return this.request(`/api/bots/${encodeURIComponent(botId)}/memory${query ? '?q=' + encodeURIComponent(query) : ''}`) }
  async memoryRead(botId, id) { return (await this.request(`/api/bots/${encodeURIComponent(botId)}/memory/${encodeURIComponent(id)}`)).note }
}
