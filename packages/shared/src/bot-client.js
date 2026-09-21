import { makeBot, patchBot } from './bots.js'

// A small optimistic sync client shared by the browser and terminal. Pending
// field edits survive refreshes and failed requests; only server acknowledgments
// mark them saved. Updates never send a whole stale bot collection.
export class BotClient {
  constructor(transport, { delay = 200, interval = 2000, legacy = null } = {}) {
    this.transport = transport; this.delay = delay; this.interval = interval; this.legacy = legacy
    this.base = { revision: -1, bots: [] }; this.queue = []; this.listeners = new Set()
    this.state = { bots: [], ready: false, pending: false, error: '' }
    this.ready = false; this.error = ''; this.stopped = true
  }
  getSnapshot = () => this.state
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  publish() {
    const bots = new Map(this.base.bots.map(bot => [bot.id, bot]))
    for (const op of this.queue) {
      if (op.type === 'create') bots.set(op.id, makeBot(op.value))
      else if (bots.has(op.id)) bots.set(op.id, patchBot(bots.get(op.id), op.value))
    }
    this.state = { bots: [...bots.values()], ready: this.ready, pending: this.queue.length > 0, error: this.error }
    for (const listener of this.listeners) listener()
  }
  accept(snapshot) { if (snapshot && snapshot.revision >= this.base.revision) this.base = { revision: snapshot.revision, bots: snapshot.bots } }
  async initialize() {
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      try {
        if (this.legacy) { this.accept(await this.transport.importLegacy(this.legacy)); this.legacy = null }
        this.accept(await this.transport.list(this.base.revision))
        this.ready = true; this.error = ''; this.publish()
      } catch (error) { this.error = error.message; this.publish(); throw error }
    })()
    try { await this.initializing } finally { this.initializing = null }
  }
  start() {
    this.stopped = false
    void this.sync()
    clearInterval(this.timer)
    this.timer = setInterval(() => void this.sync(), this.interval)
    this.timer.unref?.()
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
    } catch (error) { this.error = error.message; this.publish() }
    finally { this.syncing = false }
  }
  create(value) {
    const bot = makeBot(value)
    if (this.state.bots.some(item => item.id === bot.id)) throw new Error('Bot already exists.')
    this.queue.push({ type: 'create', id: bot.id, value: bot }); this.schedule(); return bot
  }
  update(id, value) {
    const current = this.state.bots.find(bot => bot.id === id)
    if (!current) throw new Error('Bot not found.')
    patchBot(current, value) // Validate before the optimistic update.
    const op = this.queue.findLast(item => item.id === id && !item.sending)
    if (op) op.value = op.type === 'create' ? patchBot(op.value, value) : { ...op.value, ...value, ...(value.avatar ? { avatar: { ...op.value.avatar, ...value.avatar } } : {}) }
    else this.queue.push({ type: 'patch', id, value })
    this.schedule()
  }
  async remove(id, options) {
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
  async flush() {
    clearTimeout(this.saveTimer)
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      while (this.queue.length) {
        const op = this.queue[0]; op.sending = true
        try {
          const snapshot = await (op.type === 'create' ? this.transport.create(op.value) : this.transport.patch(op.id, op.value))
          this.queue.shift(); this.accept(snapshot); this.error = ''; this.publish()
        } catch (error) { op.sending = false; this.error = `Not saved: ${error.message}`; this.publish(); break }
      }
    })()
    try { await this.flushing } finally { this.flushing = null }
  }
}
