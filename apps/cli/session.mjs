import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runProvider, providerStatus, createUsageReader, normalizeRuntime, MAX_PROMPT_LENGTH } from '@bunji/core/runtime'
import { defaultBots as sharedDefaults, cliBot, cliChanges, makeBot, patchBot } from '@bunji/shared/bots'

export const defaultBots = () => sharedDefaults().map(cliBot)

export function conversationPrompt(bot, turns, text) {
  const prefix = bot.description ? `Bot name: ${bot.name}\nBot purpose: ${bot.description}\n\n` : ''
  const completed = turns.filter(turn => turn.status === 'complete' && turn.text)
  let history = []
  const format = () => prefix + (history.length ? 'Previous conversation (JSON, oldest first):\n' + JSON.stringify(history) + '\n\n' : '') + 'Current user message:\n' + text
  if (format().length > MAX_PROMPT_LENGTH) throw new Error('Message is too long. Shorten it or the bot description.')
  for (const turn of [...completed].reverse()) {
    const pair = [{ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.text }]
    history = [...pair, ...history]
    if (format().length > MAX_PROMPT_LENGTH) { history = history.slice(2); break }
  }
  return { prompt: format(), contextTurns: history.length / 2, omittedTurns: completed.length - history.length / 2 }
}

export class BunjiSession extends EventEmitter {
  constructor({ bots = defaultBots(), run = runProvider, status = providerStatus, usage = createUsageReader(), botClient = null, chatClient = null } = {}) {
    super()
    this.bots = bots
    this.activeId = bots[0].id
    this.turns = new Map(bots.map(bot => [bot.id, []]))
    this.run = run; this.status = status; this.readUsage = usage
    this.connections = {}; this.usage = null; this.usageLoading = false
    this.directBusy = null; this.revision = 0
    this.chatClient = chatClient; this.waiters = new Map(); this.sending = new Map()
    this.memories = new Map(); this.memoryGeneration = new Map(); this.disposed = false
    this.botClient = botClient
    if (botClient) this.unsubscribeBots = botClient.subscribe(() => {
      this.bots = botClient.getSnapshot().bots.map(cliBot)
      for (const bot of this.bots) if (!this.turns.has(bot.id)) this.turns.set(bot.id, [])
      if (!this.bots.some(bot => bot.id === this.activeId)) this.activeId = this.bots[0].id
      if (this.chatConnected && this.chatClient.activeId !== this.activeId) this.chatClient.activate(this.activeId)
      this.changed()
    })
    if (chatClient) {
      this.unsubscribeChats = chatClient.subscribe(() => this.syncChats())
      this.syncChats()
    }
  }
  changed() { this.revision++; this.emit('change') }
  get bot() { return this.bots.find(bot => bot.id === this.activeId) }
  get requests() { return this.turns.get(this.activeId) || [] }
  get history() { return this.chatClient?.getSnapshot().histories[this.activeId] }
  get chatError() { return this.chatClient?.getSnapshot().error || '' }
  get memory() { return this.memories.get(this.activeId) || { notes: [], note: null, ready: false, loading: false, error: '' } }
  get busy() {
    if (!this.chatClient) return this.directBusy
    const request = this.requests.find(item => item.status === 'running')
    return request ? { botId: this.activeId, request } : this.sending.get(this.activeId) || null
  }
  select(id) {
    if (!this.bots.some(bot => bot.id === id)) return
    this.activeId = id
    this.chatClient?.activate(id)
    this.changed()
  }
  syncChats() {
    if (this.disposed) return
    for (const [botId, history] of Object.entries(this.chatClient.getSnapshot().histories)) this.turns.set(botId, history.requests)
    for (const [id, waiter] of this.waiters) {
      const request = this.turns.get(waiter.botId)?.find(item => item.id === id)
      if (request && request.status !== 'running') { this.waiters.delete(id); waiter.resolve(request) }
    }
    this.changed()
  }
  update(changes) {
    if (this.botClient) { this.botClient.update(this.activeId, cliChanges(changes)); return }
    Object.assign(this.bot, cliBot(patchBot(this.bot, cliChanges(changes))))
    this.changed()
  }
  addBot(name) {
    if (this.botClient) {
      const bot = makeBot({ id: randomUUID(), name: name.slice(0, 60) || 'New bot', ...normalizeRuntime(this.bot) })
      this.activeId = bot.id; this.botClient.create(bot); return
    }
    const bot = cliBot(makeBot({ id: randomUUID(), name: name.slice(0, 60) || 'New bot', ...normalizeRuntime(this.bot) }))
    this.bots.push(bot); this.turns.set(bot.id, []); this.activeId = bot.id; this.changed()
  }
  async connect() {
    if (this.disposed) return
    if (this.chatClient && !this.chatConnected) {
      this.chatConnected = true
      this.chatClient.activate(this.activeId)
      this.stopChatPolling = this.chatClient.start()
      this.backgroundPolling = setInterval(() => {
        const bots = new Set([...this.waiters.values()].map(waiter => waiter.botId))
        for (const botId of bots) if (botId !== this.activeId) void this.chatClient.refresh(botId)
      }, this.chatClient.pollMs || 1200)
      this.backgroundPolling.unref?.()
    }
    const [entries] = await Promise.all([
      Promise.all(['claude', 'codex', 'ollama'].map(async provider => [provider, await this.status(provider)])),
      this.chatClient?.refresh(this.activeId),
    ])
    if (this.disposed) return
    this.connections = Object.fromEntries(entries); this.changed()
  }
  async refreshUsage() {
    if (this.usageLoading) return
    this.usageLoading = true; this.changed()
    try { this.usage = await this.readUsage({ refresh: true }); return this.usage }
    finally { this.usageLoading = false; this.changed() }
  }
  stop() {
    if (!this.chatClient) { this.directBusy?.controller.abort(); return }
    const request = this.busy?.request
    if (request?.id) return this.chatClient.cancel(request.id)
    if (this.busy) throw new Error('Request is still being accepted. Try /stop again shortly.')
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopChatPolling?.(); this.chatClient?.stop(); clearInterval(this.backgroundPolling)
    this.unsubscribeChats?.(); this.unsubscribeBots?.()
    for (const waiter of this.waiters.values()) waiter.reject(Object.assign(new Error('Detached from shared chat. The run continues on the service.'), { code: 'BUNJI_DETACHED' }))
    this.waiters.clear()
    if (!this.chatClient) this.directBusy?.controller.abort()
  }
  async sendShared(text) {
    const bot = { ...this.bot }, pending = { botId: bot.id, request: { prompt: text, status: 'running' } }
    this.sending.set(bot.id, pending); this.changed()
    try {
      await this.botClient?.flush()
      if (this.botClient?.getSnapshot().pending) throw new Error(this.botClient.getSnapshot().error || 'Bot settings have not been saved yet.')
      if (this.disposed) throw Object.assign(new Error('Detached from shared chat.'), { code: 'BUNJI_DETACHED' })
      const accepted = await this.chatClient.send(bot.id, text, { provider: bot.provider, model: bot.model, effort: bot.effort })
      if (this.disposed) throw Object.assign(new Error('Detached from shared chat. The run continues on the service.'), { code: 'BUNJI_DETACHED' })
      pending.request = accepted
      const current = this.turns.get(bot.id) || []
      if (!current.some(item => item.id === accepted.id)) this.turns.set(bot.id, [...current, accepted])
      const latest = this.turns.get(bot.id).find(item => item.id === accepted.id)
      this.changed()
      if (latest.status !== 'running') return latest
      if (accepted.status !== 'running') return accepted
      return await new Promise((resolve, reject) => {
        this.waiters.set(accepted.id, { botId: bot.id, resolve, reject })
        this.syncChats()
      })
    } finally { this.sending.delete(bot.id); if (!this.disposed) this.changed() }
  }
  async loadOlder() {
    if (!this.chatClient) throw new Error('Older history is available in shared chats.')
    const botId = this.activeId
    await this.chatClient.loadOlder(botId)
    const snapshot = this.chatClient.getSnapshot(), error = snapshot.errors?.[botId] ?? (this.activeId === botId ? snapshot.error : '')
    if (error) throw new Error(error)
    return snapshot.histories[botId]
  }
  async readMemory({ query = '', id } = {}) {
    if (!this.chatClient) throw new Error('Memory is available in shared chats, outside the offline demo.')
    const botId = this.activeId, generation = (this.memoryGeneration.get(botId) || 0) + 1
    this.memoryGeneration.set(botId, generation)
    const state = { botId, query, notes: [], note: null, ready: false, loading: true, error: '' }
    this.memories.set(botId, state); this.changed()
    const publish = patch => {
      if (!this.disposed && this.memoryGeneration.get(botId) === generation) { this.memories.set(botId, { ...state, ...patch, loading: false }); this.changed() }
    }
    try {
      const result = id ? { note: await this.chatClient.memoryRead(botId, id) } : await this.chatClient.memoryList(botId, query)
      publish({ ...result, ready: true }); return result
    } catch (error) { publish({ error: error.message }); throw error }
  }
  async send(text, options = {}) {
    if (this.disposed) throw Object.assign(new Error('This session is closed.'), { code: 'BUNJI_DETACHED' })
    if (this.busy) throw new Error('A request is already running. Press Ctrl+X to stop it.')
    if (!text.trim()) return
    if (this.chatClient) return this.sendShared(text, options)
    const bot = { ...this.bot }, previous = this.turns.get(bot.id)
    const context = conversationPrompt(bot, previous, text)
    const request = { id: randomUUID(), prompt: text, preview: text.slice(0, 160), provider: bot.provider, model: bot.model, effort: bot.effort, startedAt: Date.now(), status: 'running', text: '', activities: [], usage: null, contextTurns: context.contextTurns, omittedTurns: context.omittedTurns }
    previous.push(request)
    const controller = new AbortController()
    this.directBusy = { botId: bot.id, request, controller }; this.changed()
    try {
      const result = await this.run({ ...bot, prompt: context.prompt }, { signal: controller.signal, requestId: request.id, computer: bot.computer, onActivity: activity => {
        const index = request.activities.findIndex(item => item.id === activity.id)
        if (index < 0) request.activities.push(activity)
        else request.activities[index] = activity
        this.changed()
      } })
      Object.assign(request, result, { status: controller.signal.aborted ? 'cancelled' : result.ok ? 'complete' : 'failed', error: controller.signal.aborted ? 'Request stopped.' : result.error })
    } catch (error) { Object.assign(request, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message }) }
    finally {
      request.durationMs ??= Date.now() - request.startedAt
      request.activities = request.activities.map(item => item.status === 'running' ? { ...item, status: 'unknown' } : item)
      this.directBusy = null; this.changed()
    }
    return request
  }
}
