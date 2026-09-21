import { runProvider, providerCommand, computerExecution } from './runtime.mjs'
import { buildContext } from './context.mjs'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

// The service owns runs. Browsers and terminals are observers, not owners.
export function createChatService({ bots, chats, memoryDirectory, memory, files, run = runProvider }) {
  const active = new Map()
  const deleting = new Set()
  let closing = false
  const botFor = id => {
    if (deleting.has(id)) throw fail('This bot is being updated. Try again shortly.', 409)
    const bot = bots.list().bots.find(bot => bot.id === id)
    if (!bot) throw fail('Bot not found.', 404)
    return bot
  }
  return {
    botFor,
    start(botId, body) {
      if (closing) throw fail('The service is shutting down. Try again shortly.', 503)
      if (deleting.has(botId)) throw fail('This bot is being deleted. Try another bot.', 409)
      const bot = botFor(botId)
      const { id, prompt, provider = bot.provider, model = bot.model, effort = bot.effort } = body || {}
      // Older clients may still send memoryWrite:false. Memory is now a normal
      // capability for every new conversation turn, regardless of that field.
      const memoryWrite = true
      // Validation and idempotency happen before launching any process.
      // Computer scope is read from the saved bot, never from the request body.
      providerCommand({ provider, model, effort, prompt }, { computer: bot.computer })
      const previous = chats.get(id)
      if (previous) return chats.start({ id, botId, prompt, provider, model, effort, memoryWrite: previous.memoryWrite, contextTurns: previous.contextTurns, omittedTurns: previous.omittedTurns })
      const outputDirectory = provider !== 'ollama' ? files?.outputDirectory(bot, id) : null
      const cwd = computerExecution(bot.computer).cwd || process.cwd()
      const context = buildContext(bot, chats.recentCompleted(botId, { limit: 20 }), prompt, { completedCount: chats.completedCount(botId), filesDirectory: outputDirectory })
      const result = chats.start({ id, botId, prompt, provider, model, effort, memoryWrite, contextTurns: context.contextTurns, omittedTurns: context.omittedTurns })
      if (!result.created) return result
      const controller = new AbortController()
      const task = Promise.resolve().then(async () => {
        let fileQueue = Promise.resolve(), scanTimer
        const fileWork = action => { fileQueue = fileQueue.then(action).catch(error => {
          chats.addActivity(id, { id: 'file-index-warning', kind: 'notice', title: 'File browser', status: 'failed', text: `A file could not be indexed: ${error.message}` })
        }); return fileQueue }
        const finishFiles = async () => { clearInterval(scanTimer); if (outputDirectory) fileWork(() => files.scan(bot, id, outputDirectory)); await fileQueue }
        try {
          if (outputDirectory) {
            await files.prepare(outputDirectory, bot.computer)
            let scanning = false
            scanTimer = setInterval(() => {
              if (!scanning) { scanning = true; void fileWork(() => files.scan(bot, id, outputDirectory)).finally(() => { scanning = false }) }
            }, 1800)
            scanTimer.unref?.()
          }
          const response = await run({ provider, model, effort, prompt: context.prompt }, {
            requestId: id, signal: controller.signal,
            memory: { botId, sourceId: id, directory: memoryDirectory, allowWrites: memoryWrite },
            computer: bot.computer,
            ...(outputDirectory ? { files: { path: files.path, cwd }, onFile: file => fileWork(() => files.register(botId, id, file.path, { computer: bot.computer, cwd, change: file.change })) } : {}),
            onActivity: activity => chats.addActivity(id, activity),
          })
          await finishFiles()
          chats.finish(id, { text: response.text || '', usage: response.usage || null, activities: response.activities || [], durationMs: response.durationMs,
            status: controller.signal.aborted ? 'cancelled' : response.ok ? 'complete' : 'failed', error: controller.signal.aborted ? 'Request stopped.' : response.error || null })
        } catch (error) { await finishFiles(); chats.finish(id, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message }) }
        finally { active.delete(id) }
      })
      active.set(id, { botId, controller, task })
      return result
    },
    cancel(id) {
      const request = chats.get(id)
      if (!request) throw fail('Request not found.', 404)
      const owned = active.get(id)
      owned?.controller.abort()
      // Let the runner return any reported usage and partial text before marking terminal.
      return { request: request.status === 'running' && !owned ? chats.finish(id, { status: 'cancelled', error: 'Request stopped.' }) : request }
    },
    async deleteBot(botId, options) {
      botFor(botId)
      if (!memory) throw fail('Memory storage is unavailable.', 503)
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['memoryAction', 'targetBotId', 'expectedMemoryRevision'].includes(key))) throw fail('Invalid delete options.')
      const { memoryAction, targetBotId, expectedMemoryRevision } = options
      if (!['delete', 'move'].includes(memoryAction) || typeof expectedMemoryRevision !== 'string') throw fail('Review this bot’s memories before deleting it.')
      if (memoryAction === 'move' && (targetBotId === botId || !bots.list().bots.some(bot => bot.id === targetBotId))) throw fail('Choose an existing, different bot for the memories.')
      if (memoryAction === 'move' && deleting.has(targetBotId)) throw fail('The destination bot is being deleted. Try again.', 409)
      if (memoryAction === 'delete' && targetBotId !== undefined) throw fail('A destination bot is only used when moving memories.')
      if (deleting.has(botId)) throw fail('This bot is already being deleted.', 409)
      if ([...active.values()].some(entry => entry.botId === botId) || chats.listRunning().some(request => request.botId === botId)) throw fail('Wait for this bot’s request to finish before deleting it.', 409)
      deleting.add(botId)
      if (memoryAction === 'move') deleting.add(targetBotId)
      try {
        return await memory.retireBot(botId, { targetId: memoryAction === 'move' ? targetBotId : undefined,
          expectedRevision: expectedMemoryRevision, commit: () => bots.remove(botId) })
      } finally { deleting.delete(botId); if (memoryAction === 'move') deleting.delete(targetBotId) }
    },
    async close() {
      closing = true
      for (const { controller } of active.values()) controller.abort()
      await Promise.all([...active.values()].map(item => item.task))
    },
  }
}
