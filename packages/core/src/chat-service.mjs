import { runProvider, providerCommand, computerExecution } from './runtime.mjs'
import { buildContext } from './context.mjs'
import { publishResponseFiles } from './file-history.mjs'
import { normalizeMode, supportedModes } from '@bunji/shared/runtimes'
import { attributeProviderUsage, combineUsageBreakdowns, createUsageBreakdown } from './usage-attribution.mjs'
import { AUTO_CHAT_INSTRUCTION, parseAgentHandoff, routeAutoPrompt } from './mode-router.mjs'
import { codexHistoryKey } from './codex-session-store.mjs'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

const usageFields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningOutputTokens', 'totalTokens']
function combinedUsage(first, second) {
  if (!second) return first || null
  if (!first) return second
  const usage = {}
  for (const field of usageFields) usage[field] = Number.isSafeInteger(first[field]) && Number.isSafeInteger(second[field]) ? first[field] + second[field] : null
  usage.source = `Auto Chat preflight + ${second.source || first.source || 'provider usage'}`
  return usage
}

const phaseActivity = (activity, phase) => phase ? { ...activity, id: `${phase}-${activity.id}` } : activity

// The service owns runs. Browsers and terminals are observers, not owners.
export function createChatService({ bots, chats, memoryDirectory, memory, files, sessions, run = runProvider }) {
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
      const preference = body?.mode === undefined && provider === bot.provider ? bot.mode : normalizeMode(provider, body?.mode ?? bot.mode)
      if (!supportedModes(provider).includes(preference)) throw fail('That mode is not supported by this provider.')
      const plan = preference === 'auto' ? routeAutoPrompt(provider, prompt) : { mode: preference, modelCheck: false,
        reason: preference === 'agent' ? 'Agent mode was selected.' : 'Chat mode was selected.' }
      let mode = plan.mode
      const initialAgentTools = mode === 'agent'
      const initialOutputDirectory = initialAgentTools ? files?.outputDirectory(bot, id) : null
      const history = chats.recentCompleted(botId, { limit: 20 })
      const completedCount = chats.completedCount(botId)
      const initialContext = buildContext(bot, history, prompt, { completedCount, filesDirectory: initialOutputDirectory, agentTools: initialAgentTools,
        routingInstruction: preference === 'auto' && plan.modelCheck ? AUTO_CHAT_INSTRUCTION : '' })
      const initialBreakdown = createUsageBreakdown({ provider, userMessage: prompt, prompt: initialContext.prompt, messages: initialContext.messages, historyTurns: initialContext.contextTurns })
      // Validation and idempotency happen before launching any process. Computer
      // scope is read from the saved bot, never from the request body.
      providerCommand({ provider, model, effort, prompt: initialContext.prompt, mode }, {
        computer: initialAgentTools ? bot.computer : undefined, messages: initialContext.messages,
      })
      const previous = chats.get(id)
      if (previous) return chats.start({ id, botId, prompt, provider, model, effort, requestedMode: previous.requestedMode, mode: previous.mode,
        modeReason: previous.modeReason, memoryWrite: previous.memoryWrite, contextTurns: previous.contextTurns,
        omittedTurns: previous.omittedTurns, usageBreakdown: previous.usageBreakdown })
      const result = chats.start({ id, botId, prompt, provider, model, effort, requestedMode: preference, mode, modeReason: plan.reason,
        memoryWrite: initialAgentTools, contextTurns: initialContext.contextTurns, omittedTurns: initialContext.omittedTurns, usageBreakdown: initialBreakdown })
      if (!result.created) return result
      chats.addActivity(id, { id: 'bunji-mode-route', kind: 'notice', title: preference === 'auto' ? `Auto → ${mode === 'agent' ? 'Agent' : 'Chat'}` : `${mode === 'agent' ? 'Agent' : 'Chat'} mode`,
        status: 'complete', text: `${plan.reason}${mode === 'chat' ? ' Bunji memory, files, and computer tools are off unless Auto hands this request to Agent.' : ''}` })
      const controller = new AbortController()
      const task = Promise.resolve().then(async () => {
        const startedAt = Date.now()
        let fileQueue = Promise.resolve(), scanTimer, trackedOutputDirectory = null
        const fileWork = action => { fileQueue = fileQueue.then(action).catch(error => {
          chats.addActivity(id, { id: 'file-index-warning', kind: 'notice', title: 'File browser', status: 'failed', text: `A file could not be indexed: ${error.message}` })
        }); return fileQueue }
        const finishFiles = async () => { clearInterval(scanTimer); if (trackedOutputDirectory) fileWork(() => files.scan(bot, id, trackedOutputDirectory)); await fileQueue }
        const execute = async (actualMode, { routingInstruction = '', phase = '' } = {}) => {
          const agentTools = actualMode === 'agent'
          const outputDirectory = agentTools ? files?.outputDirectory(bot, id) : null
          const cwd = agentTools ? computerExecution(bot.computer).cwd || process.cwd() : process.cwd()
          const context = buildContext(bot, history, prompt, { completedCount, filesDirectory: outputDirectory, agentTools, routingInstruction })
          const breakdown = createUsageBreakdown({ provider, userMessage: prompt, prompt: context.prompt, messages: context.messages, historyTurns: context.contextTurns })
          const session = provider === 'codex' && agentTools && sessions ? {
            botId, historyKey: codexHistoryKey({ instructions: context.instructions, computer: bot.computer, turns: history }),
            instructions: context.instructions, bootstrapPrompt: context.bootstrapPrompt, turnPrompt: context.turnPrompt,
          } : null
          if (outputDirectory && trackedOutputDirectory === null) {
            trackedOutputDirectory = outputDirectory
            await files.prepare(outputDirectory, bot.computer)
            let scanning = false
            scanTimer = setInterval(() => {
              if (!scanning) { scanning = true; void fileWork(() => files.scan(bot, id, outputDirectory)).finally(() => { scanning = false }) }
            }, 1800)
            scanTimer.unref?.()
          }
          const response = await run({ provider, model, effort, prompt: context.prompt, mode: actualMode }, {
            requestId: id, signal: controller.signal,
            ...(actualMode === 'chat' ? { messages: context.messages } : {}),
            ...(session ? { session } : {}),
            ...(agentTools ? { memory: { botId, sourceId: id, directory: memoryDirectory, allowWrites: true }, computer: bot.computer } : {}),
            ...(outputDirectory ? { files: { path: files.path, cwd }, onFile: file => fileWork(() => files.register(botId, id, file.path, { computer: bot.computer, cwd, change: file.change })) } : {}),
            onActivity: activity => chats.addActivity(id, phaseActivity(activity, phase)),
          })
          return { response, breakdown, outputDirectory, phase, context, session }
        }
        try {
          const first = await execute(mode, { routingInstruction: preference === 'auto' && plan.modelCheck ? AUTO_CHAT_INSTRUCTION : '', phase: preference === 'auto' ? `auto-${mode}` : '' })
          let final = first, usage = first.response.usage || null
          const handoffReason = preference === 'auto' && plan.modelCheck && first.response.ok && !controller.signal.aborted
            ? parseAgentHandoff(first.response.text) : null
          if (handoffReason) {
            mode = 'agent'
            chats.route(id, { mode, reason: `The selected model requested Agent mode: ${handoffReason}` })
            chats.addActivity(id, { id: 'bunji-mode-handoff', kind: 'notice', title: 'Auto → Agent', status: 'complete', text: handoffReason })
            final = await execute('agent', { phase: 'auto-agent' })
            usage = combinedUsage(usage, final.response.usage || null)
            final.breakdown = combineUsageBreakdowns(first.breakdown, final.breakdown)
          }
          if (final.outputDirectory) fileWork(() => publishResponseFiles({ bot, sourceId: id, text: final.response.text, files }))
          await finishFiles()
          const activities = (final.response.activities || []).map(activity => phaseActivity(activity, final.phase))
          const status = controller.signal.aborted ? 'cancelled' : final.response.ok ? 'complete' : 'failed'
          chats.finish(id, { text: final.response.text || '', usage, usageBreakdown: attributeProviderUsage(final.breakdown, usage), activities, durationMs: Date.now() - startedAt,
            status, error: controller.signal.aborted ? 'Request stopped.' : final.response.error || null })
          if (final.session) {
            if (status === 'complete' && final.response.session?.threadId) sessions.set(botId, { threadId: final.response.session.threadId,
              historyKey: codexHistoryKey({ instructions: final.context.instructions, computer: bot.computer, turns: chats.recentCompleted(botId, { limit: 20 }) }) })
            else sessions.delete(botId)
          }
        } catch (error) { await finishFiles(); chats.finish(id, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message,
          usageBreakdown: attributeProviderUsage(initialBreakdown, null) }); if (provider === 'codex' && sessions) sessions.delete(botId) }
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
    rewind(botId, options) {
      botFor(botId)
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['id', 'expectedPrompt'].includes(key))
        || typeof options.id !== 'string' || typeof options.expectedPrompt !== 'string') throw fail('Invalid rewind request.')
      if ([...active.values()].some(entry => entry.botId === botId) || chats.listRunning().some(request => request.botId === botId)) {
        throw fail('Wait for this bot’s request to finish before rewinding.', 409)
      }
      const result = chats.rewind(botId, options.id, { expectedPrompt: options.expectedPrompt })
      sessions?.delete(botId)
      return result
    },
    editMessage(botId, id, edit) {
      botFor(botId)
      const result = chats.editMessage(botId, id, edit)
      sessions?.delete(botId)
      return result
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
          expectedRevision: expectedMemoryRevision, commit: () => { const result = bots.remove(botId); sessions?.delete(botId); return result } })
      } finally { deleting.delete(botId); if (memoryAction === 'move') deleting.delete(targetBotId) }
    },
    async close() {
      closing = true
      for (const { controller } of active.values()) controller.abort()
      await Promise.all([...active.values()].map(item => item.task))
    },
  }
}
