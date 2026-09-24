import { runProvider, providerCommand } from './runtime.ts'
import type { ProviderRunner } from './runtime.ts'
import { computerExecution } from './computer-policy.ts'
import { buildContext } from './context.ts'
import type { BuiltContext } from './context.ts'
import { publishResponseFiles } from './file-history.ts'
import { automaticMode, normalizeMode, supportedModes } from '@bunji/shared/runtimes'
import { errorMessage, fail } from '@bunji/shared/errors'
import type {
  Activity, Bot, BotsSnapshot, ChatRequest, Effort, ExecutionMode, MessageEdit, Provider, ProviderResult,
  RequestedMode, RewindResult, StartResult, TokenField, TokenUsage, UsageBreakdown,
} from '@bunji/shared/types'
import { attributeProviderUsage, combineUsageBreakdowns, createUsageBreakdown } from './usage-attribution.ts'
import { AUTO_CHAT_INSTRUCTION, parseAgentHandoff, routeAutoPrompt } from './mode-router.ts'
import { codexHistoryKey } from './codex-session-store.ts'
import type { CodexSessionStore } from './codex-session-store.ts'
import type { CodexSession } from './codex-app-server.ts'
import type { BotStore } from './bot-store.ts'
import type { ChatStore } from './chat-store.ts'
import type { FileStore } from './file-store.ts'
import type { MemoryStore } from './memory-store.ts'

const usageFields: TokenField[] = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningOutputTokens', 'totalTokens']
function combinedUsage(first: TokenUsage | null, second: TokenUsage | null): TokenUsage | null {
  if (!second) return first || null
  if (!first) return second
  const usage: TokenUsage = {}
  for (const field of usageFields) usage[field] = Number.isSafeInteger(first[field]) && Number.isSafeInteger(second[field]) ? (first[field] as number) + (second[field] as number) : null
  usage.source = `Auto Chat preflight + ${second.source || first.source || 'provider usage'}`
  return usage
}

const phaseActivity = (activity: Activity, phase: string): Activity => phase ? { ...activity, id: `${phase}-${activity.id}` } : activity

/** A message start request from a client. Validated by providerCommand and the chat store. */
interface StartBody {
  id?: string
  prompt?: string
  provider?: Provider
  model?: string
  effort?: Effort
  mode?: RequestedMode
}

export interface ChatServiceOptions {
  bots: Pick<BotStore, 'list' | 'remove'>
  chats: ChatStore
  /** Root of the memory vaults, passed to the memory MCP server. */
  memoryDirectory: string
  /** Required for deleteBot. */
  memory?: Pick<MemoryStore, 'retireBot'>
  files?: FileStore
  /** Persistent Codex continuity, when enabled. */
  sessions?: Pick<CodexSessionStore, 'set' | 'delete'> | null
  run?: ProviderRunner
}

/** Owns provider runs. Browsers and terminals observe them through the chat store. Errors carry an HTTP `status`. */
export interface ChatService {
  botFor(id: string): Bot
  /** Starts a run in the background and returns the saved request. Idempotent by request ID. */
  start(botId: string, body: unknown): StartResult
  cancel(id: string): { request: ChatRequest }
  /** `{ id, expectedPrompt }`: removes that turn and every later one. */
  rewind(botId: string, options: unknown): RewindResult
  editMessage(botId: string, id: string, edit: MessageEdit): ChatRequest
  /** `{ memoryAction, targetBotId?, expectedMemoryRevision }`, see DeleteBotOptions. */
  deleteBot(botId: string, options: unknown): Promise<BotsSnapshot & { cleanupWarning?: string }>
  /** Aborts every run and waits for them to settle. */
  close(): Promise<void>
}

interface ActiveRequest {
  botId: string
  controller: AbortController
  task: Promise<void>
}

interface Execution {
  response: ProviderResult
  breakdown: UsageBreakdown | null
  outputDirectory: string | null | undefined
  phase: string
  context: BuiltContext
  session: CodexSession | null
}

// The service owns runs. Browsers and terminals are observers, not owners.
export function createChatService({ bots, chats, memoryDirectory, memory, files, sessions, run = runProvider }: ChatServiceOptions): ChatService {
  const active = new Map<string, ActiveRequest>()
  const deleting = new Set<string>()
  let closing = false
  const botFor = (id: string): Bot => {
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
      const { id, prompt, provider = bot.provider, model = bot.model, effort = bot.effort } = (body || {}) as StartBody
      const preference = normalizeMode(provider, (body as StartBody | null | undefined)?.mode ?? automaticMode(provider))
      if (!supportedModes(provider).includes(preference)) throw fail('That mode is not supported by this provider.')
      const plan = preference === 'auto' ? routeAutoPrompt(provider, prompt) : { mode: preference as ExecutionMode, modelCheck: false,
        reason: preference === 'agent' ? 'Agent mode was selected.' : 'Chat mode was selected.' }
      let mode = plan.mode
      const initialAgentTools = mode === 'agent'
      const initialOutputDirectory = initialAgentTools ? files?.outputDirectory(bot, id as string) : null
      const history = chats.recentCompleted(botId, { limit: 20 })
      const completedCount = chats.completedCount(botId)
      const initialContext = buildContext(bot, history, prompt as string, { completedCount, filesDirectory: initialOutputDirectory, agentTools: initialAgentTools,
        routingInstruction: preference === 'auto' && plan.modelCheck ? AUTO_CHAT_INSTRUCTION : '' })
      const initialBreakdown = createUsageBreakdown({ provider, userMessage: prompt as string, prompt: initialContext.prompt, messages: initialContext.messages, historyTurns: initialContext.contextTurns })
      // Validation and idempotency happen before launching any process. Computer
      // scope is read from the saved bot, never from the request body.
      providerCommand({ provider, model, effort, prompt: initialContext.prompt, mode }, {
        computer: initialAgentTools ? bot.computer : undefined, nativeComputer: initialAgentTools ? bot.nativeComputer : undefined, messages: initialContext.messages,
      })
      const previous = chats.get(id as string)
      if (previous) return chats.start({ id, botId, prompt, provider, model, effort, requestedMode: previous.requestedMode, mode: previous.mode,
        modeReason: previous.modeReason, memoryWrite: previous.memoryWrite, contextTurns: previous.contextTurns,
        omittedTurns: previous.omittedTurns, usageBreakdown: previous.usageBreakdown })
      const result = chats.start({ id, botId, prompt, provider, model, effort, requestedMode: preference, mode, modeReason: plan.reason,
        memoryWrite: initialAgentTools, contextTurns: initialContext.contextTurns, omittedTurns: initialContext.omittedTurns, usageBreakdown: initialBreakdown })
      if (!result.created) return result
      // chats.start validated the request ID.
      const requestId = id as string
      chats.addActivity(requestId, { id: 'bunji-mode-route', kind: 'notice', title: preference === 'auto' ? `Auto → ${mode === 'agent' ? 'Agent' : 'Chat'}` : `${mode === 'agent' ? 'Agent' : 'Chat'} mode`,
        status: 'complete', text: `${plan.reason}${mode === 'chat' ? ' Bunji memory, files, and computer tools are off unless Auto hands this request to Agent.' : ''}` })
      const controller = new AbortController()
      const task = Promise.resolve().then(async () => {
        const startedAt = Date.now()
        let fileQueue: Promise<unknown> = Promise.resolve(), scanTimer: NodeJS.Timeout | undefined, trackedOutputDirectory: string | null = null
        const fileWork = (action: () => unknown) => { fileQueue = fileQueue.then(action).catch(error => {
          chats.addActivity(requestId, { id: 'file-index-warning', kind: 'notice', title: 'File browser', status: 'failed', text: `A file could not be indexed: ${errorMessage(error)}` })
        }); return fileQueue }
        const finishFiles = async () => { clearInterval(scanTimer); if (trackedOutputDirectory) fileWork(() => files!.scan(bot, requestId, trackedOutputDirectory)); await fileQueue }
        const execute = async (actualMode: ExecutionMode, { routingInstruction = '', phase = '' }: { routingInstruction?: string; phase?: string } = {}): Promise<Execution> => {
          const agentTools = actualMode === 'agent'
          const outputDirectory = agentTools ? files?.outputDirectory(bot, requestId) : null
          const cwd = agentTools ? computerExecution(bot.computer).cwd || process.cwd() : process.cwd()
          const context = buildContext(bot, history, prompt as string, { completedCount, filesDirectory: outputDirectory, agentTools, routingInstruction })
          const breakdown = createUsageBreakdown({ provider, userMessage: prompt as string, prompt: context.prompt, messages: context.messages, historyTurns: context.contextTurns })
          const session = provider === 'codex' && agentTools && sessions ? {
            botId, historyKey: codexHistoryKey({ instructions: context.instructions, computer: bot.computer, turns: history }),
            instructions: context.instructions, bootstrapPrompt: context.bootstrapPrompt, turnPrompt: context.turnPrompt,
          } : null
          if (outputDirectory && trackedOutputDirectory === null) {
            trackedOutputDirectory = outputDirectory
            await files!.prepare(outputDirectory, bot.computer)
            let scanning = false
            scanTimer = setInterval(() => {
              if (!scanning) { scanning = true; void fileWork(() => files!.scan(bot, requestId, outputDirectory)).finally(() => { scanning = false }) }
            }, 1800)
            scanTimer.unref?.()
          }
          const response = await run({ provider, model, effort, prompt: context.prompt, mode: actualMode }, {
            requestId, signal: controller.signal,
            ...(actualMode === 'chat' ? { messages: context.messages } : {}),
            ...(session ? { session } : {}),
            ...(agentTools ? { memory: { botId, sourceId: requestId, directory: memoryDirectory, allowWrites: true }, computer: bot.computer, nativeComputer: bot.nativeComputer } : {}),
            ...(outputDirectory ? { files: { path: files!.path, cwd }, onFile: file => fileWork(() => files!.register(botId, requestId, file.path, { computer: bot.computer, cwd, change: file.change })) } : {}),
            onActivity: activity => chats.addActivity(requestId, phaseActivity(activity, phase)),
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
            chats.route(requestId, { mode, reason: `The selected model requested Agent mode: ${handoffReason}` })
            chats.addActivity(requestId, { id: 'bunji-mode-handoff', kind: 'notice', title: 'Auto → Agent', status: 'complete', text: handoffReason })
            final = await execute('agent', { phase: 'auto-agent' })
            usage = combinedUsage(usage, final.response.usage || null)
            final.breakdown = combineUsageBreakdowns(first.breakdown, final.breakdown)
          }
          if (final.outputDirectory) fileWork(() => publishResponseFiles({ bot, sourceId: requestId, text: final.response.text, files: files! }))
          await finishFiles()
          const activities = (final.response.activities || []).map(activity => phaseActivity(activity, final.phase))
          const status = controller.signal.aborted ? 'cancelled' : final.response.ok ? 'complete' : 'failed'
          chats.finish(requestId, { text: final.response.text || '', usage, usageBreakdown: attributeProviderUsage(final.breakdown, usage), activities, durationMs: Date.now() - startedAt,
            status, error: controller.signal.aborted ? 'Request stopped.' : final.response.error || null })
          if (final.session) {
            if (status === 'complete' && final.response.session?.threadId) sessions!.set(botId, { threadId: final.response.session.threadId,
              historyKey: codexHistoryKey({ instructions: final.context.instructions, computer: bot.computer, turns: chats.recentCompleted(botId, { limit: 20 }) }) })
            else sessions!.delete(botId)
          }
        } catch (error) { await finishFiles(); chats.finish(requestId, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: errorMessage(error),
          usageBreakdown: attributeProviderUsage(initialBreakdown, null) }); if (provider === 'codex' && sessions) sessions.delete(botId) }
        finally { active.delete(requestId) }
      })
      active.set(requestId, { botId, controller, task })
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
        || typeof (options as { id?: unknown }).id !== 'string' || typeof (options as { expectedPrompt?: unknown }).expectedPrompt !== 'string') throw fail('Invalid rewind request.')
      const { id, expectedPrompt } = options as { id: string; expectedPrompt: string }
      if ([...active.values()].some(entry => entry.botId === botId) || chats.listRunning().some(request => request.botId === botId)) {
        throw fail('Wait for this bot’s request to finish before rewinding.', 409)
      }
      const result = chats.rewind(botId, id, { expectedPrompt })
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
      const { memoryAction, targetBotId, expectedMemoryRevision } = options as { memoryAction?: unknown; targetBotId?: string; expectedMemoryRevision?: unknown }
      if (!['delete', 'move'].includes(memoryAction as string) || typeof expectedMemoryRevision !== 'string') throw fail('Review this bot’s memories before deleting it.')
      if (memoryAction === 'move' && (targetBotId === botId || !bots.list().bots.some(bot => bot.id === targetBotId))) throw fail('Choose an existing, different bot for the memories.')
      if (memoryAction === 'move' && deleting.has(targetBotId as string)) throw fail('The destination bot is being deleted. Try again.', 409)
      if (memoryAction === 'delete' && targetBotId !== undefined) throw fail('A destination bot is only used when moving memories.')
      if (deleting.has(botId)) throw fail('This bot is already being deleted.', 409)
      if ([...active.values()].some(entry => entry.botId === botId) || chats.listRunning().some(request => request.botId === botId)) throw fail('Wait for this bot’s request to finish before deleting it.', 409)
      deleting.add(botId)
      if (memoryAction === 'move') deleting.add(targetBotId as string)
      try {
        return await memory.retireBot(botId, { targetId: memoryAction === 'move' ? targetBotId : undefined,
          expectedRevision: expectedMemoryRevision, commit: () => { const result = bots.remove(botId); sessions?.delete(botId); return result } })
      } finally { deleting.delete(botId); if (memoryAction === 'move') deleting.delete(targetBotId as string) }
    },
    async close() {
      closing = true
      for (const { controller } of active.values()) controller.abort()
      await Promise.all([...active.values()].map(item => item.task))
    },
  }
}
