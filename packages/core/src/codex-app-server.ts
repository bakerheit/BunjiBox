import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { errorMessage } from '@bunji/shared/errors'
import type { ComputerProfile } from '@bunji/shared/types'
import { createRunEvents } from './run-events.ts'
import type { RunEvents, RunEventsResult } from './run-events.ts'
import { bunjiCodexProfileArgs } from './codex-profile.ts'
import type { CodexSessionStore } from './codex-session-store.ts'
import type { CodexSandbox, ComputerExecution } from './computer-policy.ts'
import type { SpawnProcess } from './run-stream.ts'
import type { FilesScope, MemoryScope, ProviderHooks, ProviderRequest } from './provider-types.ts'

const MAX_LINE = 2 * 1024 * 1024

export class CodexAppServerError extends Error {
  /** True when nothing reached the model, so a one-shot run may replace this one. */
  safeToFallback: boolean

  constructor(message: string, { safeToFallback = false }: { safeToFallback?: boolean } = {}) {
    super(message)
    this.name = 'CodexAppServerError'
    this.safeToFallback = safeToFallback
  }
}

/** Whether a failed persistent run may be retried as a one-shot run. */
export const isSafeToFallback = (error: unknown): boolean => Boolean((error as { safeToFallback?: unknown } | null | undefined)?.safeToFallback)

/** A bot's durable Codex continuity for one request, built by the chat service. */
export interface CodexSession {
  botId: string
  /** Hash of instructions, computer scope and completed turns; see codexHistoryKey. */
  historyKey: string
  instructions: string
  /** First message of a new thread: saved history plus the current message. */
  bootstrapPrompt: string
  /** Message for a continued thread: the current message only. */
  turnPrompt: string
}

export interface CodexRunHooks extends Omit<ProviderHooks, 'messages'> {
  requestId: string
  memory: MemoryScope
  computer?: ComputerProfile | null
  files?: FilesScope | null
  session: CodexSession
}

export type CodexRunResult = RunEventsResult & {
  error?: string
  durationMs: number
  session: { threadId: string; reused: boolean }
}

export interface CodexAppServer {
  run(options: Pick<ProviderRequest, 'model' | 'effort'>, hooks: CodexRunHooks, machine: ComputerExecution): Promise<CodexRunResult>
  close(): Promise<void>
  deleteThread(threadId: string): Promise<void>
}

/** The live request scope the memory MCP server reads for a persistent thread. */
export interface CodexScopeState {
  sourceId: string
  computer: ComputerProfile | null | undefined
  cwd: string
  files: { path: string } | null
}

interface AppServerItem {
  type?: string
  summary?: string[]
  content?: string[]
  aggregatedOutput?: unknown
  exitCode?: unknown
  changes?: { path?: unknown }[]
}

interface AppServerTurn {
  id?: string
  status?: string
  error?: { message?: string }
  durationMs?: number
}

interface AppServerParams {
  threadId?: string
  turnId?: string
  turn?: AppServerTurn
  tokenUsage?: { last?: AppServerUsage | null }
  delta?: string
  item?: AppServerItem
}

interface AppServerUsage {
  inputTokens?: unknown
  outputTokens?: unknown
  cachedInputTokens?: unknown
  cacheWriteInputTokens?: unknown
  reasoningOutputTokens?: unknown
  totalTokens?: unknown
}

/** One JSON-RPC line: a response (id), a server request (id + method) or a notification (method). */
interface RpcMessage {
  id?: number | string
  method?: string
  params?: AppServerParams
  result?: unknown
  error?: { message?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  method: string
}

interface ActiveRun {
  tracker: RunEvents
  usage: AppServerUsage | null
  partial: string
  turnId: string | null
  settled: boolean
  finish(error: unknown, turn?: AppServerTurn): void
}

const oldUsage = (value: AppServerUsage | null) => value ? {
  input_tokens: value.inputTokens,
  output_tokens: value.outputTokens,
  cached_input_tokens: value.cachedInputTokens,
  cache_write_input_tokens: value.cacheWriteInputTokens,
  reasoning_output_tokens: value.reasoningOutputTokens,
  total_tokens: value.totalTokens,
} : null

// `network` is a saved ComputerNetwork ('off' | 'ask'); only 'on' would grant access.
const sandboxPolicy = (mode: CodexSandbox, network: string = 'off') => mode === 'danger-full-access'
  ? { type: 'dangerFullAccess' }
  : mode === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [], networkAccess: network === 'on' }
    : { type: 'readOnly', networkAccess: network === 'on' }

function normalizeItem(item: AppServerItem = {}): Record<string, unknown> {
  const types: Record<string, string> = {
    agentMessage: 'agent_message', reasoning: 'reasoning', commandExecution: 'command_execution',
    mcpToolCall: 'mcp_tool_call', webSearch: 'web_search', fileChange: 'file_change',
  }
  const normalized: Record<string, unknown> = { ...item, type: types[item.type as string] || item.type }
  if (item.type === 'reasoning') normalized.text = [...(item.summary || []), ...(item.content || [])].join('\n')
  if (item.type === 'commandExecution') {
    normalized.aggregated_output = item.aggregatedOutput
    normalized.exit_code = item.exitCode
  }
  if (item.type === 'fileChange') normalized.changes = (item.changes || []).map(change => ({ ...change, path: change.path }))
  return normalized
}

async function writeScopeState({ memory, files, computer, cwd }: { memory: MemoryScope; files: FilesScope | null | undefined; computer: ComputerProfile | null | undefined; cwd: string }): Promise<string> {
  const directory = join(dirname(memory.directory), 'codex-session-state')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${memory.botId}.json`)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const data = JSON.stringify({ sourceId: memory.sourceId, computer, cwd, files: files ? { path: files.path } : null } satisfies CodexScopeState)
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, path)
  return path
}

function mcpConfiguration({ memory, files, statePath }: { memory: MemoryScope; files: FilesScope | null | undefined; statePath: string }) {
  const tools = ['memory_search', 'memory_read', 'memory_write', 'memory_link', ...(files ? ['files_publish'] : [])]
  const command = process.execPath
  const args = [fileURLToPath(new URL('./memory-mcp.ts', import.meta.url)), '--directory', memory.directory, '--bot', memory.botId,
    '--session-state', statePath, '--write', ...(files ? ['--files-db', files.path] : [])]
  return {
    model_reasoning_summary: 'detailed',
    mcp_servers: { bunji_memory: {
      command, args, required: true, startup_timeout_sec: 20, tool_timeout_sec: 45, enabled_tools: tools,
      tools: Object.fromEntries(tools.map(name => [name, { approval_mode: 'approve', output_token_limit: 4500 }])),
    } },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export interface CodexAppServerOptions {
  sessions: Pick<CodexSessionStore, 'get' | 'delete'>
  spawnProcess?: SpawnProcess
  startupTimeoutMs?: number
}

export function createCodexAppServer({ sessions, spawnProcess = spawn, startupTimeoutMs = 20000 }: CodexAppServerOptions): CodexAppServer {
  if (!sessions) throw new Error('A Codex session store is required.')
  let child: ChildProcess | null = null, lines: Interface | null = null, starting: Promise<void> | null = null, ready = false, sequence = 0, closing = false
  const pending = new Map<number | string, PendingRequest>(), active = new Map<string, ActiveRun>(), loaded = new Set<string>()

  const send = (message: object) => {
    if (!child?.stdin?.writable) throw new CodexAppServerError('Codex app-server connection is closed.', { safeToFallback: true })
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  const reply = (id: number | string | undefined, result: unknown, error?: { code: number; message: string }) => send({ id, ...(error ? { error } : { result }) })
  const request = (method: string, params?: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject, method })
    try { send({ id, method, ...(params === undefined ? {} : { params }) }) }
    catch (error) { pending.delete(id); reject(error) }
  })
  const notify = (method: string, params = {}) => send({ method, params })

  const failConnection = (error: unknown) => {
    const failure = error instanceof CodexAppServerError ? error : new CodexAppServerError('Codex app-server connection closed.')
    ready = false; starting = null; loaded.clear()
    for (const item of pending.values()) item.reject(failure)
    pending.clear()
    for (const run of active.values()) run.finish(failure)
    active.clear()
    lines?.close(); lines = null; child = null
  }

  const serverRequest = (message: RpcMessage) => {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      reply(message.id, { decision: 'decline' }); return
    }
    if (message.method === 'item/tool/requestUserInput') { reply(message.id, { answers: {} }); return }
    reply(message.id, undefined, { code: -32601, message: 'BunjiBox does not support this app-server request.' })
  }

  const notification = (message: RpcMessage) => {
    const params = message.params || {}, run = active.get(params.threadId as string)
    if (!run) return
    if (message.method === 'turn/started' && params.turn?.id) run.turnId = params.turn.id
    else if (message.method === 'thread/tokenUsage/updated' && (!run.turnId || params.turnId === run.turnId)) run.usage = params.tokenUsage?.last || null
    else if (message.method === 'item/agentMessage/delta' && (!run.turnId || params.turnId === run.turnId)) run.partial += params.delta || ''
    else if (['item/started', 'item/completed'].includes(message.method as string) && (!run.turnId || params.turnId === run.turnId)) {
      run.tracker.consume({ type: (message.method as string).replace('/', '.'), item: normalizeItem(params.item) })
    } else if (message.method === 'turn/completed' && (!run.turnId || params.turn?.id === run.turnId)) {
      const failed = params.turn?.status === 'failed'
      run.tracker.consume({ type: failed ? 'turn.failed' : 'turn.completed', usage: oldUsage(run.usage) })
      run.finish(failed ? new Error(params.turn?.error?.message || 'Codex failed this turn.') : null, params.turn)
    }
  }

  const receive = (line: string) => {
    if (line.length > MAX_LINE) { child?.kill('SIGKILL'); failConnection(new CodexAppServerError('Codex app-server sent an oversized event.')); return }
    let message: RpcMessage
    try { message = JSON.parse(line) as RpcMessage } catch { return }
    if (message.id !== undefined && !message.method) {
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      if (message.error) item.reject(new CodexAppServerError(message.error.message || `${item.method} failed.`, { safeToFallback: item.method !== 'turn/start' }))
      else item.resolve(message.result)
    } else if (message.id !== undefined && message.method) serverRequest(message)
    else if (message.method) notification(message)
  }

  const ensure = async (): Promise<void> => {
    if (ready && child) return
    if (starting) return starting
    closing = false
    starting = (async () => {
      const serverProcess = spawnProcess('codex', ['app-server', ...bunjiCodexProfileArgs()], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      child = serverProcess
      lines = createInterface({ input: serverProcess.stdout! })
      lines.on('line', receive)
      serverProcess.stderr!.on('data', () => {})
      serverProcess.stdin!.on('error', () => failConnection(new CodexAppServerError('Codex app-server input closed.')))
      serverProcess.on('error', () => failConnection(new CodexAppServerError('Could not start Codex app-server.', { safeToFallback: true })))
      serverProcess.on('exit', () => { if (!closing) failConnection(new CodexAppServerError('Codex app-server exited.')) })
      const timer = setTimeout(() => serverProcess.kill('SIGKILL'), startupTimeoutMs)
      try {
        await request('initialize', { clientInfo: { name: 'bunjibox', title: 'BunjiBox', version: '0.1.0' } })
        notify('initialized')
        ready = true
      } catch (error) {
        serverProcess.kill('SIGKILL')
        throw new CodexAppServerError(errorMessage(error, '') || 'Could not initialize Codex app-server.', { safeToFallback: true })
      } finally { clearTimeout(timer) }
    })().finally(() => { starting = null })
    return starting
  }

  async function openThread(options: Pick<ProviderRequest, 'model'>, hooks: CodexRunHooks, machine: ComputerExecution, statePath: string): Promise<{ threadId: string; reused: boolean }> {
    const saved = sessions.get(hooks.session.botId)
    if (saved?.historyKey === hooks.session.historyKey) {
      if (!loaded.has(saved.threadId)) {
        try {
          await request('thread/resume', {
            threadId: saved.threadId, model: options.model, cwd: machine.cwd || process.cwd(), sandbox: machine.sandbox,
            approvalPolicy: 'never', developerInstructions: hooks.session.instructions,
            config: mcpConfiguration({ memory: hooks.memory, files: hooks.files, statePath }),
          })
          loaded.add(saved.threadId)
        } catch (error) {
          sessions.delete(hooks.session.botId)
          if (!/not found|does not exist|unknown thread|archived/i.test(errorMessage(error))) throw error
        }
      }
      if (loaded.has(saved.threadId)) return { threadId: saved.threadId, reused: true }
    }
    const result = await request('thread/start', {
      model: options.model, cwd: machine.cwd || process.cwd(), sandbox: machine.sandbox, approvalPolicy: 'never',
      developerInstructions: hooks.session.instructions, serviceName: 'bunjibox', ephemeral: false,
      config: mcpConfiguration({ memory: hooks.memory, files: hooks.files, statePath }),
    }) as { thread?: { id?: string } } | null
    const threadId = result?.thread?.id
    if (!threadId) throw new CodexAppServerError('Codex app-server did not return a thread ID.', { safeToFallback: true })
    loaded.add(threadId)
    return { threadId, reused: false }
  }

  async function run(options: Pick<ProviderRequest, 'model' | 'effort'>, hooks: CodexRunHooks, machine: ComputerExecution): Promise<CodexRunResult> {
    await ensure()
    const startedAt = Date.now()
    const statePath = await writeScopeState({ memory: hooks.memory, files: hooks.files, computer: hooks.computer, cwd: machine.cwd || process.cwd() })
    const session = await openThread(options, hooks, machine, statePath)
    const tracker = createRunEvents('codex', hooks.onActivity, hooks.onFile)
    const done = deferred<CodexRunResult>()
    const record: ActiveRun = {
      tracker, usage: null, partial: '', turnId: null, settled: false,
      finish(error, turn) {
        if (record.settled) return
        record.settled = true
        hooks.signal?.removeEventListener('abort', abort)
        active.delete(session.threadId)
        const result = tracker.result()
        const text = result.text || record.partial
        done.resolve({ ...result, text, failed: Boolean(error) || result.failed, error: errorMessage(error, '') || (result.failed ? 'Codex did not complete this request.' : undefined),
          durationMs: turn?.durationMs ?? Date.now() - startedAt, session: { threadId: session.threadId, reused: session.reused } })
      },
    }
    const interrupt = () => {
      if (!record.turnId || record.settled) return
      void request('turn/interrupt', { threadId: session.threadId, turnId: record.turnId }).catch(() => {})
    }
    const abort = () => interrupt()
    active.set(session.threadId, record)
    hooks.onActivity?.({ id: `codex-session-${session.threadId}`, kind: 'notice', title: 'Codex session', status: 'complete', text: session.reused ? 'Continued this agent’s Codex session.' : 'Started a durable Codex session for this agent.' })
    hooks.signal?.addEventListener('abort', abort, { once: true })
    try {
      const turn = await request('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: session.reused ? hooks.session.turnPrompt : hooks.session.bootstrapPrompt }],
        clientUserMessageId: hooks.requestId, model: options.model, effort: options.effort, summary: 'detailed',
        cwd: machine.cwd || process.cwd(), approvalPolicy: 'never', sandboxPolicy: sandboxPolicy(machine.sandbox, hooks.computer?.network),
      }) as { turn?: { id?: string } } | null
      record.turnId = turn?.turn?.id || record.turnId
      if (!record.turnId) throw new CodexAppServerError('Codex app-server did not return a turn ID.')
      if (hooks.signal?.aborted) interrupt()
    } catch (error) {
      record.finish(error)
      if (isSafeToFallback(error)) throw error
    }
    return done.promise
  }

  async function close() {
    closing = true
    for (const [threadId, run] of active) {
      if (run.turnId) void request('turn/interrupt', { threadId, turnId: run.turnId }).catch(() => {})
      run.finish(new Error('BunjiBox is shutting down.'))
    }
    active.clear()
    if (child) {
      lines?.close()
      child.stdin!.end()
      child.kill('SIGTERM')
    }
    child = null; lines = null; ready = false; loaded.clear()
  }

  async function deleteThread(threadId: string) {
    await ensure()
    await request('thread/delete', { threadId })
    loaded.delete(threadId)
  }

  return { run, close, deleteThread }
}

export async function readCodexSessionState(path: string): Promise<CodexScopeState> {
  return JSON.parse(await readFile(path, 'utf8')) as CodexScopeState
}
