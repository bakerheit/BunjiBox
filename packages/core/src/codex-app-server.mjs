import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { createRunEvents } from './run-events.mjs'
import { bunjiCodexProfileArgs } from './codex-profile.mjs'

const MAX_LINE = 2 * 1024 * 1024

export class CodexAppServerError extends Error {
  constructor(message, { safeToFallback = false } = {}) {
    super(message)
    this.name = 'CodexAppServerError'
    this.safeToFallback = safeToFallback
  }
}

const oldUsage = value => value ? {
  input_tokens: value.inputTokens,
  output_tokens: value.outputTokens,
  cached_input_tokens: value.cachedInputTokens,
  cache_write_input_tokens: value.cacheWriteInputTokens,
  reasoning_output_tokens: value.reasoningOutputTokens,
  total_tokens: value.totalTokens,
} : null

const sandboxPolicy = (mode, network = 'off') => mode === 'danger-full-access'
  ? { type: 'dangerFullAccess' }
  : mode === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [], networkAccess: network === 'on' }
    : { type: 'readOnly', networkAccess: network === 'on' }

function normalizeItem(item = {}) {
  const types = {
    agentMessage: 'agent_message', reasoning: 'reasoning', commandExecution: 'command_execution',
    mcpToolCall: 'mcp_tool_call', webSearch: 'web_search', fileChange: 'file_change',
  }
  const normalized = { ...item, type: types[item.type] || item.type }
  if (item.type === 'reasoning') normalized.text = [...(item.summary || []), ...(item.content || [])].join('\n')
  if (item.type === 'commandExecution') {
    normalized.aggregated_output = item.aggregatedOutput
    normalized.exit_code = item.exitCode
  }
  if (item.type === 'fileChange') normalized.changes = (item.changes || []).map(change => ({ ...change, path: change.path }))
  return normalized
}

async function writeScopeState({ memory, files, computer, cwd }) {
  const directory = join(dirname(memory.directory), 'codex-session-state')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${memory.botId}.json`)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const data = JSON.stringify({ sourceId: memory.sourceId, computer, cwd, files: files ? { path: files.path } : null })
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, path)
  return path
}

function mcpConfiguration({ memory, files, statePath }) {
  const tools = ['memory_search', 'memory_read', 'memory_write', 'memory_link', ...(files ? ['files_publish'] : [])]
  const command = process.execPath
  const args = [fileURLToPath(new URL('./memory-mcp.mjs', import.meta.url)), '--directory', memory.directory, '--bot', memory.botId,
    '--session-state', statePath, '--write', ...(files ? ['--files-db', files.path] : [])]
  return {
    model_reasoning_summary: 'detailed',
    mcp_servers: { bunji_memory: {
      command, args, required: true, startup_timeout_sec: 20, tool_timeout_sec: 45, enabled_tools: tools,
      tools: Object.fromEntries(tools.map(name => [name, { approval_mode: 'approve', output_token_limit: 4500 }])),
    } },
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function createCodexAppServer({ sessions, spawnProcess = spawn, startupTimeoutMs = 20000 } = {}) {
  if (!sessions) throw new Error('A Codex session store is required.')
  let child = null, lines = null, starting = null, ready = false, sequence = 0, closing = false
  const pending = new Map(), active = new Map(), loaded = new Set()

  const send = message => {
    if (!child?.stdin?.writable) throw new CodexAppServerError('Codex app-server connection is closed.', { safeToFallback: true })
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  const reply = (id, result, error) => send({ id, ...(error ? { error } : { result }) })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject, method })
    try { send({ id, method, ...(params === undefined ? {} : { params }) }) }
    catch (error) { pending.delete(id); reject(error) }
  })
  const notify = (method, params = {}) => send({ method, params })

  const failConnection = error => {
    const failure = error instanceof CodexAppServerError ? error : new CodexAppServerError('Codex app-server connection closed.')
    ready = false; starting = null; loaded.clear()
    for (const item of pending.values()) item.reject(failure)
    pending.clear()
    for (const run of active.values()) run.finish(failure)
    active.clear()
    lines?.close(); lines = null; child = null
  }

  const serverRequest = message => {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      reply(message.id, { decision: 'decline' }); return
    }
    if (message.method === 'item/tool/requestUserInput') { reply(message.id, { answers: {} }); return }
    reply(message.id, undefined, { code: -32601, message: 'BunjiBox does not support this app-server request.' })
  }

  const notification = message => {
    const params = message.params || {}, run = active.get(params.threadId)
    if (!run) return
    if (message.method === 'turn/started' && params.turn?.id) run.turnId = params.turn.id
    else if (message.method === 'thread/tokenUsage/updated' && (!run.turnId || params.turnId === run.turnId)) run.usage = params.tokenUsage?.last || null
    else if (message.method === 'item/agentMessage/delta' && (!run.turnId || params.turnId === run.turnId)) run.partial += params.delta || ''
    else if (['item/started', 'item/completed'].includes(message.method) && (!run.turnId || params.turnId === run.turnId)) {
      run.tracker.consume({ type: message.method.replace('/', '.'), item: normalizeItem(params.item) })
    } else if (message.method === 'turn/completed' && (!run.turnId || params.turn?.id === run.turnId)) {
      const failed = params.turn?.status === 'failed'
      run.tracker.consume({ type: failed ? 'turn.failed' : 'turn.completed', usage: oldUsage(run.usage) })
      run.finish(failed ? new Error(params.turn?.error?.message || 'Codex failed this turn.') : null, params.turn)
    }
  }

  const receive = line => {
    if (line.length > MAX_LINE) { child?.kill('SIGKILL'); failConnection(new CodexAppServerError('Codex app-server sent an oversized event.')); return }
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id !== undefined && !message.method) {
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      if (message.error) item.reject(new CodexAppServerError(message.error.message || `${item.method} failed.`, { safeToFallback: item.method !== 'turn/start' }))
      else item.resolve(message.result)
    } else if (message.id !== undefined && message.method) serverRequest(message)
    else if (message.method) notification(message)
  }

  const ensure = async () => {
    if (ready && child) return
    if (starting) return starting
    closing = false
    starting = (async () => {
      const serverProcess = spawnProcess('codex', ['app-server', ...bunjiCodexProfileArgs()], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      child = serverProcess
      lines = createInterface({ input: serverProcess.stdout })
      lines.on('line', receive)
      serverProcess.stderr.on('data', () => {})
      serverProcess.stdin.on('error', () => failConnection(new CodexAppServerError('Codex app-server input closed.')))
      serverProcess.on('error', () => failConnection(new CodexAppServerError('Could not start Codex app-server.', { safeToFallback: true })))
      serverProcess.on('exit', () => { if (!closing) failConnection(new CodexAppServerError('Codex app-server exited.')) })
      const timer = setTimeout(() => serverProcess.kill('SIGKILL'), startupTimeoutMs)
      try {
        await request('initialize', { clientInfo: { name: 'bunjibox', title: 'BunjiBox', version: '0.1.0' } })
        notify('initialized')
        ready = true
      } catch (error) {
        serverProcess.kill('SIGKILL')
        throw new CodexAppServerError(error.message || 'Could not initialize Codex app-server.', { safeToFallback: true })
      } finally { clearTimeout(timer) }
    })().finally(() => { starting = null })
    return starting
  }

  async function openThread(options, hooks, machine, statePath) {
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
          if (!/not found|does not exist|unknown thread|archived/i.test(error.message)) throw error
        }
      }
      if (loaded.has(saved.threadId)) return { threadId: saved.threadId, reused: true }
    }
    const result = await request('thread/start', {
      model: options.model, cwd: machine.cwd || process.cwd(), sandbox: machine.sandbox, approvalPolicy: 'never',
      developerInstructions: hooks.session.instructions, serviceName: 'bunjibox', ephemeral: false,
      config: mcpConfiguration({ memory: hooks.memory, files: hooks.files, statePath }),
    })
    const threadId = result?.thread?.id
    if (!threadId) throw new CodexAppServerError('Codex app-server did not return a thread ID.', { safeToFallback: true })
    loaded.add(threadId)
    return { threadId, reused: false }
  }

  async function run(options, hooks, machine) {
    await ensure()
    const startedAt = Date.now()
    const statePath = await writeScopeState({ memory: hooks.memory, files: hooks.files, computer: hooks.computer, cwd: machine.cwd || process.cwd() })
    const session = await openThread(options, hooks, machine, statePath)
    const tracker = createRunEvents('codex', hooks.onActivity, hooks.onFile)
    const done = deferred()
    const record = {
      tracker, usage: null, partial: '', turnId: null, settled: false,
      finish(error, turn) {
        if (record.settled) return
        record.settled = true
        hooks.signal?.removeEventListener('abort', abort)
        active.delete(session.threadId)
        const result = tracker.result()
        const text = result.text || record.partial
        done.resolve({ ...result, text, failed: Boolean(error) || result.failed, error: error?.message || (result.failed ? 'Codex did not complete this request.' : undefined),
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
      })
      record.turnId = turn?.turn?.id || record.turnId
      if (!record.turnId) throw new CodexAppServerError('Codex app-server did not return a turn ID.')
      if (hooks.signal?.aborted) interrupt()
    } catch (error) {
      record.finish(error)
      if (error.safeToFallback) throw error
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
      child.stdin.end()
      child.kill('SIGTERM')
    }
    child = null; lines = null; ready = false; loaded.clear()
  }

  async function deleteThread(threadId) {
    await ensure()
    await request('thread/delete', { threadId })
    loaded.delete(threadId)
  }

  return { run, close, deleteThread }
}

export async function readCodexSessionState(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
