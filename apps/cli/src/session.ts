import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runProvider, providerStatus, createUsageReader, MAX_PROMPT_LENGTH } from '@bunji/core/runtime'
import type { ProviderRequest } from '@bunji/core/runtime'
import { normalizeMode, normalizeRuntime, providers } from '@bunji/shared/runtimes'
import { routeAutoPrompt } from '@bunji/shared/auto-mode'
import { defaultBots as sharedDefaults, cliBot, cliChanges, makeBot, patchBot } from '@bunji/shared/bots'
import type { CliBot, CliChanges } from '@bunji/shared/bots'
import type { BotClient } from '@bunji/shared/bot-client'
import type { BotHistory, ChatClient } from '@bunji/shared/chat-client'
import { errorMessage, unrefTimer } from '@bunji/shared/errors'
import type { Activity, ChatMessage, ChatRequest, ComputerProfile, Effort, ExecutionMode, MemoryList, MemoryNote, MemoryNoteSummary, Provider, ProviderResult, ProviderStatus, RequestedMode, TokenUsage } from '@bunji/shared/types'
import type { UsageView } from './format.ts'

export const defaultBots = (): CliBot[] => sharedDefaults().map(cliBot)

/** A run made in this process (offline demo, tests, or a session without shared chat). */
export interface DirectRequest {
  id: string
  prompt: string
  preview: string
  provider: Provider
  model: string
  effort: Effort
  requestedMode: RequestedMode
  mode: ExecutionMode
  modeReason: string
  startedAt: number
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  text: string
  activities: Activity[]
  activityLimited?: boolean
  usage: TokenUsage | null
  durationMs?: number
  error?: string | null
  contextTurns: number
  omittedTurns: number
}

/** One conversation turn: a saved shared-chat request or a direct run. */
export type Turn = (ChatRequest & { activityLimited?: boolean }) | DirectRequest

/** A shared message the service has not acknowledged yet, so it has no ID. */
export interface UnsentRequest {
  id?: undefined
  prompt: string
  status: 'running'
}

/** The request that keeps a bot busy. */
export interface Busy {
  botId: string
  request: Turn | UnsentRequest
}

interface DirectBusy extends Busy {
  request: DirectRequest
  controller: AbortController
}

/** Hooks a direct run receives. `runProvider` accepts them. */
export interface DirectRunHooks {
  signal: AbortSignal
  requestId: string
  computer?: ComputerProfile
  onActivity: (activity: Activity) => void
}

/** A direct run's result. Doubles may omit fields the terminal does not read. */
export type DirectRunResult = Pick<ProviderResult, 'ok'> & Partial<ProviderResult>
export type DirectRunner = (request: ProviderRequest, hooks: DirectRunHooks) => Promise<DirectRunResult>

/** A provider sign-in check. Doubles may report only `connected`. */
export type ConnectionStatus = Pick<ProviderStatus, 'connected'> & Partial<ProviderStatus>
export type ConnectionReader = (provider: Provider) => Promise<ConnectionStatus>
export type UsageViewReader = (options?: { refresh?: boolean }) => Promise<UsageView>

export interface MemoryState {
  botId?: string
  query?: string
  notes: MemoryNoteSummary[]
  note: MemoryNote | null
  revision?: string
  ready: boolean
  loading: boolean
  error: string
}

export type MemoryResult = { note: MemoryNote } | MemoryList

interface Waiter {
  botId: string
  resolve: (request: Turn) => void
  reject: (error: Error) => void
}

export interface BunjiSessionOptions {
  bots?: CliBot[]
  run?: DirectRunner
  status?: ConnectionReader
  usage?: UsageViewReader
  /** Shared bot settings. Without it, edits stay in this session. */
  botClient?: BotClient | null
  /** Shared, saved chat. Without it, runs are direct and in memory. */
  chatClient?: ChatClient | null
}

export function conversationPrompt(bot: Pick<CliBot, 'name' | 'description'>, turns: readonly { status: string; prompt: string; text: string }[], text: string) {
  const prefix = bot.description ? `Bot name: ${bot.name}\nBot purpose: ${bot.description}\n\n` : ''
  const completed = turns.filter(turn => turn.status === 'complete' && turn.text)
  let history: ChatMessage[] = []
  const format = () => prefix + (history.length ? 'Previous conversation (JSON, oldest first):\n' + JSON.stringify(history) + '\n\n' : '') + 'Current user message:\n' + text
  if (format().length > MAX_PROMPT_LENGTH) throw new Error('Message is too long. Shorten it or the bot description.')
  for (const turn of [...completed].reverse()) {
    const pair: ChatMessage[] = [{ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.text }]
    history = [...pair, ...history]
    if (format().length > MAX_PROMPT_LENGTH) { history = history.slice(2); break }
  }
  return { prompt: format(), contextTurns: history.length / 2, omittedTurns: completed.length - history.length / 2 }
}

const detached = (message: string) => Object.assign(new Error(message), { code: 'BUNJI_DETACHED' })

export class BunjiSession extends EventEmitter {
  bots: CliBot[]
  activeId: string
  turns: Map<string, Turn[]>
  run: DirectRunner
  status: ConnectionReader
  readUsage: UsageViewReader
  connections: Partial<Record<Provider, ConnectionStatus>>
  usage: UsageView | null
  usageLoading: boolean
  directBusy: DirectBusy | null
  /** Bumped on every change; the terminal re-renders from it. */
  revision: number
  chatClient: ChatClient | null
  waiters: Map<string, Waiter>
  sending: Map<string, Busy>
  memories: Map<string, MemoryState>
  memoryGeneration: Map<string, number>
  disposed: boolean
  botClient: BotClient | null
  chatConnected?: boolean
  unsubscribeBots?: () => void
  unsubscribeChats?: () => void
  stopChatPolling?: () => void
  backgroundPolling?: ReturnType<typeof setInterval>

  constructor({ bots = defaultBots(), run = runProvider, status = providerStatus, usage = createUsageReader(), botClient = null, chatClient = null }: BunjiSessionOptions = {}) {
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
      if (this.chatConnected && this.chatClient && this.chatClient.activeId !== this.activeId) this.chatClient.activate(this.activeId)
      this.changed()
    })
    if (chatClient) {
      this.unsubscribeChats = chatClient.subscribe(() => this.syncChats())
      this.syncChats()
    }
  }
  changed() { this.revision++; this.emit('change') }
  /** The selected bot. `activeId` always names one of `bots`. */
  get bot(): CliBot { return this.bots.find(bot => bot.id === this.activeId)! }
  get requests(): Turn[] { return this.turns.get(this.activeId) || [] }
  get history(): BotHistory | undefined { return this.chatClient?.getSnapshot().histories[this.activeId] }
  get chatError(): string { return this.chatClient?.getSnapshot().error || '' }
  get memory(): MemoryState { return this.memories.get(this.activeId) || { notes: [], note: null, ready: false, loading: false, error: '' } }
  get busy(): Busy | null {
    if (!this.chatClient) return this.directBusy
    const request = this.requests.find(item => item.status === 'running')
    return request ? { botId: this.activeId, request } : this.sending.get(this.activeId) || null
  }
  select(id: string) {
    if (!this.bots.some(bot => bot.id === id)) return
    this.activeId = id
    this.chatClient?.activate(id)
    this.changed()
  }
  syncChats() {
    if (this.disposed) return
    // Only a shared-chat session subscribes to chat changes.
    for (const [botId, history] of Object.entries(this.chatClient!.getSnapshot().histories)) this.turns.set(botId, history.requests)
    for (const [id, waiter] of this.waiters) {
      const request = this.turns.get(waiter.botId)?.find(item => item.id === id)
      if (request && request.status !== 'running') { this.waiters.delete(id); waiter.resolve(request) }
    }
    this.changed()
  }
  update(changes: CliChanges) {
    if (this.botClient) { this.botClient.update(this.activeId, cliChanges(changes)); return }
    Object.assign(this.bot, cliBot(patchBot(this.bot, cliChanges(changes))))
    this.changed()
  }
  addBot(name: string) {
    if (this.botClient) {
      const runtime = normalizeRuntime(this.bot)
      const bot = makeBot({ id: randomUUID(), name: name.slice(0, 60) || 'New bot', ...runtime, mode: normalizeMode(runtime.provider, 'auto') })
      this.activeId = bot.id; this.botClient.create(bot); return
    }
    const runtime = normalizeRuntime(this.bot)
    const bot = cliBot(makeBot({ id: randomUUID(), name: name.slice(0, 60) || 'New bot', ...runtime, mode: normalizeMode(runtime.provider, 'auto') }))
    this.bots.push(bot); this.turns.set(bot.id, []); this.activeId = bot.id; this.changed()
  }
  async connect() {
    if (this.disposed) return
    const chatClient = this.chatClient
    if (chatClient && !this.chatConnected) {
      this.chatConnected = true
      chatClient.activate(this.activeId)
      this.stopChatPolling = chatClient.start()
      this.backgroundPolling = unrefTimer(setInterval(() => {
        const bots = new Set([...this.waiters.values()].map(waiter => waiter.botId))
        for (const botId of bots) if (botId !== this.activeId) void chatClient.refresh(botId)
      }, chatClient.pollMs || 1200))
    }
    const [entries] = await Promise.all([
      Promise.all(providers.map(async (provider): Promise<[Provider, ConnectionStatus]> => [provider, await this.status(provider)])),
      chatClient?.refresh(this.activeId),
    ])
    if (this.disposed) return
    this.connections = Object.fromEntries(entries); this.changed()
  }
  async refreshUsage(): Promise<UsageView | undefined> {
    if (this.usageLoading) return
    this.usageLoading = true; this.changed()
    try { this.usage = await this.readUsage({ refresh: true }); return this.usage }
    finally { this.usageLoading = false; this.changed() }
  }
  stop(): Promise<ChatRequest> | undefined {
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
    for (const waiter of this.waiters.values()) waiter.reject(detached('Detached from shared chat. The run continues on the service.'))
    this.waiters.clear()
    if (!this.chatClient) this.directBusy?.controller.abort()
  }
  async sendShared(text: string): Promise<Turn> {
    const bot = { ...this.bot }, pending: Busy = { botId: bot.id, request: { prompt: text, status: 'running' } }
    this.sending.set(bot.id, pending); this.changed()
    try {
      await this.botClient?.flush()
      if (this.botClient?.getSnapshot().pending) throw new Error(this.botClient.getSnapshot().error || 'Bot settings have not been saved yet.')
      if (this.disposed) throw detached('Detached from shared chat.')
      // send() only routes here when this session has a chat client.
      const accepted = await this.chatClient!.send(bot.id, text, { provider: bot.provider, model: bot.model, effort: bot.effort, mode: normalizeMode(bot.provider, 'auto') })
      if (this.disposed) throw detached('Detached from shared chat. The run continues on the service.')
      pending.request = accepted
      const current = this.turns.get(bot.id) || []
      if (!current.some(item => item.id === accepted.id)) this.turns.set(bot.id, [...current, accepted])
      const latest = this.turns.get(bot.id)!.find(item => item.id === accepted.id)!
      this.changed()
      if (latest.status !== 'running') return latest
      if (accepted.status !== 'running') return accepted
      return await new Promise<Turn>((resolve, reject) => {
        this.waiters.set(accepted.id, { botId: bot.id, resolve, reject })
        this.syncChats()
      })
    } finally { this.sending.delete(bot.id); if (!this.disposed) this.changed() }
  }
  async loadOlder(): Promise<BotHistory | undefined> {
    if (!this.chatClient) throw new Error('Older history is available in shared chats.')
    const botId = this.activeId
    await this.chatClient.loadOlder(botId)
    const snapshot = this.chatClient.getSnapshot(), error = snapshot.errors?.[botId] ?? (this.activeId === botId ? snapshot.error : '')
    if (error) throw new Error(error)
    return snapshot.histories[botId]
  }
  async readMemory({ query = '', id }: { query?: string; id?: string } = {}): Promise<MemoryResult> {
    if (!this.chatClient) throw new Error('Memory is available in shared chats, outside the offline demo.')
    const botId = this.activeId, generation = (this.memoryGeneration.get(botId) || 0) + 1
    this.memoryGeneration.set(botId, generation)
    const state: MemoryState = { botId, query, notes: [], note: null, ready: false, loading: true, error: '' }
    this.memories.set(botId, state); this.changed()
    const publish = (patch: Partial<MemoryState>) => {
      if (!this.disposed && this.memoryGeneration.get(botId) === generation) { this.memories.set(botId, { ...state, ...patch, loading: false }); this.changed() }
    }
    try {
      const result: MemoryResult = id ? { note: await this.chatClient.memoryRead(botId, id) } : await this.chatClient.memoryList(botId, query)
      publish({ ...result, ready: true }); return result
    } catch (error) { publish({ error: errorMessage(error) }); throw error }
  }
  async send(text: string): Promise<Turn | undefined> {
    if (this.disposed) throw detached('This session is closed.')
    if (this.busy) throw new Error('A request is already running. Press Ctrl+X to stop it.')
    if (!text.trim()) return
    if (this.chatClient) return this.sendShared(text)
    const bot = { ...this.bot }, previous = this.turns.get(bot.id)!
    const requestedMode = normalizeMode(bot.provider, 'auto')
    const route = requestedMode === 'auto' ? routeAutoPrompt(bot.provider, text) : { mode: requestedMode, reason: 'This provider only supports chat.' }
    const resolvedBot = { ...bot, mode: route.mode }
    const context = conversationPrompt(bot, previous, text)
    const request: DirectRequest = { id: randomUUID(), prompt: text, preview: text.slice(0, 160), provider: bot.provider, model: bot.model, effort: bot.effort,
      requestedMode, mode: route.mode, modeReason: route.reason, startedAt: Date.now(), status: 'running', text: '', activities: [], usage: null,
      contextTurns: context.contextTurns, omittedTurns: context.omittedTurns }
    previous.push(request)
    const controller = new AbortController()
    this.directBusy = { botId: bot.id, request, controller }; this.changed()
    try {
      const result = await this.run({ ...resolvedBot, prompt: context.prompt }, { signal: controller.signal, requestId: request.id, ...(route.mode === 'agent' ? { computer: bot.computer } : {}), onActivity: activity => {
        const index = request.activities.findIndex(item => item.id === activity.id)
        if (index < 0) request.activities.push(activity)
        else request.activities[index] = activity
        this.changed()
      } })
      Object.assign(request, result, { status: controller.signal.aborted ? 'cancelled' : result.ok ? 'complete' : 'failed', error: controller.signal.aborted ? 'Request stopped.' : result.error })
    } catch (error) { Object.assign(request, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: errorMessage(error) }) }
    finally {
      request.durationMs ??= Date.now() - request.startedAt
      request.activities = request.activities.map(item => item.status === 'running' ? { ...item, status: 'unknown' } : item)
      this.directBusy = null; this.changed()
    }
    return request
  }
}
