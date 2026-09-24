import { nativeBridge, nativeTools, nativeInstructions } from './native-computer.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runtimes, effortSteps, normalizeMode, supportedModes } from '@bunji/shared/runtimes'
import { runStream } from './run-stream.mjs'
import { readOpenRouterCredential, runOpenRouter } from './openrouter.mjs'
import { bunjiCodexProfileArgs } from './codex-profile.mjs'
import { createCodexAppServer } from './codex-app-server.mjs'
import { openCodexSessionStore } from './codex-session-store.mjs'

const exec = promisify(execFile)
export { runtimes, effortSteps, normalizeMode, normalizeRuntime } from '@bunji/shared/runtimes'
export { createUsageReader } from './usage.mjs'
export const MAX_PROMPT_LENGTH = 12000
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

function ollamaUrl() {
  const value = process.env.BUNJI_OLLAMA_URL || DEFAULT_OLLAMA_URL
  let url
  try { url = new URL(value) } catch { throw new Error('BUNJI_OLLAMA_URL must be a valid HTTP URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('BUNJI_OLLAMA_URL must be a plain HTTP or HTTPS URL.')
  return url.toString().replace(/\/$/, '')
}

function ollamaUsage(final) {
  const inputTokens = Number.isSafeInteger(final?.prompt_eval_count) ? final.prompt_eval_count : null
  const outputTokens = Number.isSafeInteger(final?.eval_count) ? final.eval_count : null
  return { inputTokens, outputTokens, cachedInputTokens: null, cacheWriteTokens: null,
    reasoningOutputTokens: null, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    source: 'Ollama response' }
}

async function runOllama({ model, effort, prompt }, { signal, onActivity, messages } = {}) {
  const startedAt = Date.now()
  const activities = []
  const activity = { id: 'ollama-request', kind: 'notice', title: 'Ollama', status: 'running', text: 'Waiting for Ollama…' }
  activities.push(activity); onActivity?.(activity)
  let text = '', thinking = '', final = null
  try {
    const response = await fetch(ollamaUrl() + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: Array.isArray(messages) ? messages : [{ role: 'user', content: prompt }], stream: true, think: model.startsWith('qwen3:') && effort !== 'low', keep_alive: '10m' }),
      signal,
    })
    if (!response.ok) {
      let message = `Ollama returned HTTP ${response.status}.`
      try { message = (await response.json())?.error || message } catch { /* Keep the safe status message. */ }
      throw new Error(message)
    }
    if (!response.body) throw new Error('Ollama returned no response stream.')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const consume = line => {
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event.error) throw new Error(event.error)
      const message = event.message || {}
      if (typeof message.content === 'string') text += message.content
      if (typeof message.thinking === 'string') thinking += message.thinking
      if (event.done) final = event
    }
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Ollama returned an oversized response event.')
    }
    buffer += decoder.decode()
    consume(buffer)
    activity.status = 'complete'; activity.text = final ? 'Response received from Ollama.' : 'Ollama closed the response early.'
    onActivity?.({ ...activity })
    if (thinking) {
      const reasoning = { id: 'ollama-thinking', kind: 'reasoning', title: 'Model thinking', status: 'complete', text: thinking }
      activities.push(reasoning); onActivity?.(reasoning)
    }
    if (!final || !text) return { text, usage: ollamaUsage(final), failed: true, activities, error: 'Ollama returned an empty response.', durationMs: Date.now() - startedAt }
    return { text, usage: ollamaUsage(final), failed: false, activities, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = signal?.aborted ? 'The connection closed before Ollama finished.' : error.message
    const failedActivity = { ...activity, status: 'failed', text: message }
    activities[0] = failedActivity; onActivity?.(failedActivity)
    return { text, usage: ollamaUsage(final), failed: true, activities, error: message, durationMs: Date.now() - startedAt }
  }
}

export async function providerStatus(provider) {
  try {
    if (provider === 'ollama') {
      const response = await fetch(ollamaUrl() + '/api/tags', { signal: AbortSignal.timeout(3000) })
      if (!response.ok) return { connected: false, plan: 'Ollama unavailable' }
      const data = await response.json()
      const models = Array.isArray(data?.models) ? data.models.map(item => item.name).filter(Boolean) : []
      return { connected: true, plan: 'Ollama', models }
    }
    if (provider === 'claude') {
      const { stdout } = await exec('claude', ['auth', 'status'], { timeout: 15000, maxBuffer: 65536 })
      const result = JSON.parse(stdout)
      return { connected: Boolean(result.loggedIn), plan: result.subscriptionType || 'Claude subscription' }
    }
    if (provider === 'openrouter') {
      const credential = await readOpenRouterCredential()
      return credential ? { connected: true, plan: credential.source === 'keychain' ? 'API key · macOS Keychain' : 'API key · environment' } : { connected: false, plan: 'Add an API key in Usage' }
    }
    await exec('codex', ['login', 'status'], { timeout: 15000, maxBuffer: 65536 })
    return { connected: true, plan: 'ChatGPT subscription' }
  } catch { return { connected: false, plan: 'Sign in on this computer' } }
}

// The browser never supplies this configuration for a run. It comes from the
// bot record after the server has validated the saved computer policy.
//
// Ask-before-changing remains blocked until Bunji can relay approvals. Full
// machine is a separate, explicitly confirmed, unrestricted policy.
export function computerExecution(computer) {
  const access = computer || { scope: 'none', level: 'read', folder: null, network: 'off' }
  if (access.scope === 'none') return { sandbox: 'read-only', cwd: null, machineAccess: false }
  if (access.scope === 'machine') {
    if (access.level !== 'auto') throw new Error('Reconfirm This Mac access in Settings to enable full access.')
    return { sandbox: 'danger-full-access', cwd: homedir(), machineAccess: true }
  }
  if (access.scope !== 'folder' || typeof access.folder !== 'string' || !access.folder) throw new Error('This bot has an invalid computer folder. Re-select the folder in Settings.')
  if (access.level === 'ask') throw new Error('The old Ask mode cannot run here. Select Read only or Allow changes for this folder in Settings.')
  if (access.level === 'read') return { sandbox: 'read-only', cwd: access.folder, machineAccess: true }
  if (access.level === 'auto') return { sandbox: 'workspace-write', cwd: access.folder, machineAccess: true }
  throw new Error('This bot has an invalid computer permission level.')
}

const chatDisabledFeatures = [
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'fast_mode', 'goals', 'hooks', 'image_generation', 'in_app_browser', 'in_app_chat', 'in_app_dictation',
  'in_app_local_automation', 'memories', 'multi_agent', 'plugin_sharing', 'plugins', 'realtime_conversation',
  'remote_plugin', 'shell_snapshot', 'shell_snapshot_v2', 'shell_tool', 'skill_search', 'sleep_tool',
  'tool_call_mcp_elicitation', 'tool_search_always_defer_mcp_tools', 'tool_suggest', 'unified_exec', 'view_image',
  'workspace_dependencies', 'worktrees',
]

function chatTranscript(messages, fallback) {
  if (!Array.isArray(messages)) return { system: '', prompt: fallback }
  const system = messages.filter(message => message?.role === 'system').map(message => message.content).join('\n\n')
  const conversation = messages.filter(message => message?.role !== 'system')
  if (conversation.length === 1 && conversation[0].role === 'user') return { system, prompt: conversation[0].content }
  const current = conversation.at(-1)
  const previous = conversation.slice(0, -1)
  return { system, prompt: `${previous.length ? `Previous conversation (JSON, oldest first):\n${JSON.stringify(previous)}\n\n` : ''}Current user message:\n${current?.content || fallback}` }
}

export function providerCommand({ provider, model, effort, prompt, mode: requestedMode }, { memory, computer, nativeComputer, files, messages } = {}) {
  if (!Object.hasOwn(runtimes, provider)) throw new Error('Unknown provider')
  if (!runtimes[provider].models.some(item => item.id === model)) throw new Error('Unsupported model')
  if (!effortSteps(provider, model).includes(effort)) throw new Error('Effort is not supported by this model')
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) throw new Error('Prompt is empty or too long')
  if (requestedMode !== undefined && !supportedModes(provider).includes(requestedMode)) throw new Error('That mode is not supported by this provider')
  const mode = normalizeMode(provider, requestedMode)
  if (mode === 'auto') throw new Error('Auto mode must be resolved to Chat or Agent before provider execution')
  if (mode === 'chat') {
    const chat = chatTranscript(messages, prompt)
    if (provider === 'ollama') return ['ollama-http', [model]]
    if (provider === 'openrouter') return ['openrouter-http', [model]]
    if (provider === 'claude') return ['claude', [
      '--print', chat.prompt, '--model', model, '--effort', effort,
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--safe-mode', '--disable-slash-commands', '--tools', '', '--strict-mcp-config',
      ...(chat.system ? ['--system-prompt', chat.system] : []),
    ]]
    return ['codex', [
      'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', tmpdir(),
      '--ignore-user-config', '--ignore-rules', '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
      ...chatDisabledFeatures.flatMap(feature => ['--disable', feature]),
      '--model', model, '-c', `model_reasoning_effort="${effort}"`, '-c', 'model_reasoning_summary="none"',
      '--color', 'never', '--json', prompt,
    ]]
  }
  const native = nativeBridge(nativeComputer, computer)
  if (native) prompt += nativeInstructions
  const bridge = memory ? {
    command: process.execPath,
    args: [fileURLToPath(new URL('./memory-mcp.mjs', import.meta.url)), '--directory', memory.directory, '--bot', memory.botId, '--source', memory.sourceId, ...(memory.allowWrites ? ['--write'] : []), ...(files ? ['--files-db', files.path, '--files-computer', JSON.stringify(computer), '--files-cwd', files.cwd] : [])],
  } : null
  const tools = ['memory_search', 'memory_read', ...(memory?.allowWrites ? ['memory_write', 'memory_link'] : []), ...(files ? ['files_publish'] : [])]
  const machine = computerExecution(computer)
  if (provider === 'ollama') return ['ollama-http', [model]]
  if (provider === 'openrouter') return ['openrouter-http', [model]]
  // Claude's CLI has permission modes but no OS sandbox equivalent to Codex's
  // workspace-write boundary. Do not misrepresent an advisory --add-dir as a
  // safe machine boundary. Bunji will add Claude computer access through its
  // own broker once that exists.
  if (provider === 'claude' && machine.machineAccess && computer?.scope !== 'machine') throw new Error('Scoped computer access is currently available through Codex. Claude stays chat and memory-only until Bunji’s sandboxed tool broker is ready.')
  if (provider === 'claude') return ['claude', [
    '--print', prompt, '--model', model, '--effort', effort,
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', computer?.scope === 'machine' ? 'bypassPermissions' : memory?.allowWrites ? 'dontAsk' : 'plan',
    ...(computer?.scope === 'machine' ? ['--dangerously-skip-permissions'] : []),
    // Plan mode instructs Claude not to execute writes, even explicitly allowed
    // memory tools. A write-enabled turn instead has a narrow tool surface:
    // no shell, edits, agents, or other MCP servers, and deny unapproved calls.
    ...(computer?.scope === 'machine' ? ['--tools', 'default', '--strict-mcp-config'] : memory?.allowWrites ? ['--tools', 'Read,Glob,Grep,WebFetch,WebSearch,ToolSearch', '--strict-mcp-config'] : []),
    ...(bridge || native ? ['--mcp-config', JSON.stringify({ mcpServers: { ...(bridge ? { bunji_memory: bridge } : {}), ...(native ? { bunji_native: native } : {}) } }), '--allowedTools', [...(bridge ? tools.map(name => `mcp__bunji_memory__${name}`) : []), ...(native ? nativeTools.map(name => `mcp__bunji_native__${name}`) : [])].join(',')] : []),
  ]]
  return ['codex', [
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', machine.sandbox,
    ...bunjiCodexProfileArgs(),
    ...(computer?.scope === 'machine' ? ['-c', 'approval_policy="never"'] : []),
    ...(machine.cwd ? ['--cd', machine.cwd] : []),
    '--model', model, '-c', `model_reasoning_effort="${effort}"`, '-c', 'model_reasoning_summary="detailed"',
    ...(bridge ? ['-c', `mcp_servers.bunji_memory.command=${JSON.stringify(bridge.command)}`,
      '-c', `mcp_servers.bunji_memory.args=${JSON.stringify(bridge.args)}`,
      '-c', 'mcp_servers.bunji_memory.required=true',
      '-c', 'mcp_servers.bunji_memory.startup_timeout_sec=20',
      '-c', 'mcp_servers.bunji_memory.tool_timeout_sec=45',
      '-c', `mcp_servers.bunji_memory.enabled_tools=${JSON.stringify(tools)}`,
      ...tools.flatMap(name => ['-c', `mcp_servers.bunji_memory.tools.${name}.approval_mode="approve"`, '-c', `mcp_servers.bunji_memory.tools.${name}.output_token_limit=4500`]),
    ] : []),
    ...(native ? ['-c', `mcp_servers.bunji_native.command=${JSON.stringify(native.command)}`, '-c', `mcp_servers.bunji_native.args=${JSON.stringify(native.args)}`, '-c', 'mcp_servers.bunji_native.env.BUNJI_NATIVE_EXPERIMENT="1"', '-c', 'mcp_servers.bunji_native.required=true', '-c', 'mcp_servers.bunji_native.startup_timeout_sec=20', '-c', `mcp_servers.bunji_native.enabled_tools=${JSON.stringify(nativeTools)}`, ...nativeTools.flatMap(name => ['-c', `mcp_servers.bunji_native.tools.${name}.approval_mode="approve"`])] : []),
    '--color', 'never', '--json', prompt,
  ]]
}

// The shared service and stateless one-shot CLI use this same provider adapter.
// MCP scope is trusted server configuration, never accepted from public run JSON.
export async function runProvider(options, { requestId = randomUUID(), memory, computer, nativeComputer, files, ...hooks } = {}) {
  const mode = normalizeMode(options.provider, options.mode)
  if (options.mode !== undefined && !supportedModes(options.provider).includes(options.mode)) throw new Error('That mode is not supported by this provider')
  if (mode === 'auto') throw new Error('Auto mode must be resolved to Chat or Agent before provider execution')
  const machine = mode === 'agent' ? computerExecution(computer) : computerExecution()
  if (options.provider === 'ollama') {
    const startedAt = Date.now()
    const result = await runOllama(options, hooks)
    return { ...result, ok: !result.failed, requestId, durationMs: result.durationMs ?? Date.now() - startedAt }
  }
  if (options.provider === 'openrouter') {
    const startedAt = Date.now()
    const result = await runOpenRouter(options, hooks)
    return { ...result, ok: !result.failed, requestId, durationMs: result.durationMs ?? Date.now() - startedAt }
  }
  if (options.provider === 'codex' && mode === 'agent' && hooks.codexAppServer && hooks.session && (!nativeComputer || nativeComputer === 'off')) {
    try {
      const result = await hooks.codexAppServer.run(options, { requestId, memory, computer, files, ...hooks }, machine)
      return { ...result, ok: !result.failed, requestId, durationMs: result.durationMs }
    } catch (error) {
      if (!error?.safeToFallback) throw error
      hooks.onActivity?.({ id: 'codex-session-fallback', kind: 'notice', title: 'Codex session', status: 'failed', text: 'Experimental persistent session unavailable. Bunji used a one-shot Codex run for this message.' })
    }
  }
  const [command, args] = providerCommand(options, { memory, computer, nativeComputer, files, messages: hooks.messages })
  const startedAt = Date.now()
  const result = await runStream(command, args, { ...hooks, ...(mode === 'agent' && nativeComputer && nativeComputer !== 'off' && options.provider === 'claude' ? { env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } } : {}), provider: options.provider, cwd: mode === 'chat' ? tmpdir() : machine.cwd || undefined })
  return { ...result, ok: !result.failed, requestId, durationMs: Date.now() - startedAt }
}

export function createProviderRunner({ experimental = false, sessions, appServer } = {}) {
  if (!experimental) return { sessions: null, run: runProvider, async close() {} }
  const store = sessions || openCodexSessionStore()
  const server = appServer || createCodexAppServer({ sessions: store })
  let closed = false
  return {
    sessions: store,
    run(options, hooks = {}) { return runProvider(options, { ...hooks, codexAppServer: server }) },
    async close() {
      if (closed) return
      closed = true
      await server.close()
      store.close()
    },
  }
}
