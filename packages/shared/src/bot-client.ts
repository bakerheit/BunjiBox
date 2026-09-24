import { makeBot, patchBot } from './bots.ts'
import { errorMessage, unrefTimer } from './errors.ts'
import type { Bot, BotsSnapshot, DeleteBotOptions, LegacyBotImport } from './types.ts'

/** Where bot changes go: HTTP in clients, the SQLite store in the one-shot CLI. */
export interface BotTransport {
  list(revision?: number): BotsSnapshot | null | Promise<BotsSnapshot | null>
  create(bot: Bot): BotsSnapshot | Promise<BotsSnapshot>
  patch(id: string, changes: Record<string, unknown>): BotsSnapshot | Promise<BotsSnapshot>
  remove(id: string, options: DeleteBotOptions): BotsSnapshot | Promise<BotsSnapshot>
  importLegacy(data: LegacyBotImport): BotsSnapshot | Promise<BotsSnapshot>
}

export interface BotClientState {
  bots: Bot[]
  ready: boolean
  pending: boolean
  error: string
}

type PendingOp =
  | { type: 'create'; id: string; value: Bot; sending?: boolean }
  | { type: 'patch'; id: string; value: Record<string, unknown> & { avatar?: object }; sending?: boolean }

// A small optimistic sync client shared by the browser and terminal. Pending
// field edits survive refreshes and failed requests; only server acknowledgments
// mark them saved. Updates never send a whole stale bot collection.
export class BotClient {
  transport: BotTransport
  delay: number
  interval: number
  legacy: LegacyBotImport | null
  base: { revision: number; bots: Bot[] } = { revision: -1, bots: [] }
  queue: PendingOp[] = []
  listeners = new Set<() => void>()
  state: BotClientState = { bots: [], ready: false, pending: false, error: '' }
  ready = false
  error = ''
  stopped = true
  /** Set by the browser factory when old localStorage bots could not be read. */
  migrationError = ''
  private initializing: Promise<void> | null = null
  private flushing: Promise<void> | null = null
  private syncing = false
  private timer: ReturnType<typeof setInterval> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(transport: BotTransport, { delay = 200, interval = 2000, legacy = null }: { delay?: number; interval?: number; legacy?: LegacyBotImport | null } = {}) {
    this.transport = transport; this.delay = delay; this.interval = interval; this.legacy = legacy
  }
  getSnapshot = (): BotClientState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  publish() {
    const bots = new Map(this.base.bots.map(bot => [bot.id, bot]))
    for (const op of this.queue) {
      if (op.type === 'create') bots.set(op.id, makeBot(op.value))
      else if (bots.has(op.id)) bots.set(op.id, patchBot(bots.get(op.id)!, op.value))
    }
    this.state = { bots: [...bots.values()], ready: this.ready, pending: this.queue.length > 0, error: this.error }
    for (const listener of this.listeners) listener()
  }
  accept(snapshot: BotsSnapshot | null | undefined) { if (snapshot && snapshot.revision >= this.base.revision) this.base = { revision: snapshot.revision, bots: snapshot.bots } }
  async initialize(): Promise<void> {
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      try {
        if (this.legacy) { this.accept(await this.transport.importLegacy(this.legacy)); this.legacy = null }
        this.accept(await this.transport.list(this.base.revision))
        this.ready = true; this.error = ''; this.publish()
      } catch (error) { this.error = errorMessage(error); this.publish(); throw error }
    })()
    try { await this.initializing } finally { this.initializing = null }
  }
  start() {
    this.stopped = false
    void this.sync()
    clearInterval(this.timer)
    this.timer = unrefTimer(setInterval(() => void this.sync(), this.interval))
    return () => this.stop()
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.saveTimer) }
  async sync() {
    if (this.syncing) return
    this.syncing = true
    try {
      if (!this.ready) await this.initialize()
      else { this.accept(await this.transport.list(this.base.revision)); if (!this.queue.length) this.error = ''; this.publish() }
      if (this.queue.length) await this.flush()
    } catch (error) { this.error = errorMessage(error); this.publish() }
    finally { this.syncing = false }
  }
  create(value: unknown): Bot {
    const bot = makeBot(value)
    if (this.state.bots.some(item => item.id === bot.id)) throw new Error('Bot already exists.')
    this.queue.push({ type: 'create', id: bot.id, value: bot }); this.schedule(); return bot
  }
  update(id: string, value: Record<string, unknown> & { avatar?: object }) {
    const current = this.state.bots.find(bot => bot.id === id)
    if (!current) throw new Error('Bot not found.')
    patchBot(current, value) // Validate before the optimistic update.
    const op = this.queue.findLast(item => item.id === id && !item.sending)
    if (op?.type === 'create') op.value = patchBot(op.value, value)
    else if (op) op.value = { ...op.value, ...value, ...(value.avatar ? { avatar: { ...op.value.avatar, ...value.avatar } } : {}) }
    else this.queue.push({ type: 'patch', id, value })
    this.schedule()
  }
  async remove(id: string, options: DeleteBotOptions): Promise<BotsSnapshot> {
    await this.flush()
    if (this.queue.length) throw new Error(this.error || 'Save pending bot settings before deleting this bot.')
    const snapshot = await this.transport.remove(id, options)
    this.accept(snapshot)
    this.error = snapshot.cleanupWarning || ''
    this.publish()
    return snapshot
  }
  schedule() {
    this.error = ''; this.publish(); clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), this.delay)
  }
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      while (this.queue.length) {
        const op = this.queue[0]; op.sending = true
        try {
          const snapshot = await (op.type === 'create' ? this.transport.create(op.value) : this.transport.patch(op.id, op.value))
          this.queue.shift(); this.accept(snapshot); this.error = ''; this.publish()
        } catch (error) { op.sending = false; this.error = `Not saved: ${errorMessage(error)}`; this.publish(); break }
      }
    })()
    try { await this.flushing } finally { this.flushing = null }
  }
}
