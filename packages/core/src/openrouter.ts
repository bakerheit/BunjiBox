import { spawn } from 'node:child_process'
import type { Activity, TokenUsage } from '@bunji/shared/types'
import { errorMessage, fail } from '@bunji/shared/errors'
import type { SpawnProcess } from './run-stream.ts'
import type { ProviderHooks, ProviderOutcome, ProviderRequest } from './provider-types.ts'

const API = 'https://openrouter.ai/api/v1'
const KEYCHAIN_ACCOUNT = 'bunji-openrouter'
const KEYCHAIN_SERVICE = 'com.bakerheit.bunjibox.openrouter'
const keyPattern = /^sk-or-[A-Za-z0-9_-]{16,}$/
const KEYCHAIN_TIMEOUT_MS = 8000
let credentialMutation = false

/** Runs the macOS `security` tool with optional stdin and resolves its stdout. */
export type SecurityRunner = (args: string[], input?: string) => Promise<string>

export interface OpenRouterCredential {
  key: string
  source: 'keychain' | 'environment'
}

/** The subset of fetch the OpenRouter calls use; tests inject a fake. */
export type OpenRouterFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

/** A failed `security` run. `code` is the exit code (44: item not found). */
export type KeychainError = Error & { code: number | null; detail: string; status: number }

export function createSecurityRunner({ spawnProcess = spawn, timeoutMs = KEYCHAIN_TIMEOUT_MS }: { spawnProcess?: SpawnProcess; timeoutMs?: number } = {}): SecurityRunner {
  return (args, input = '') => new Promise((resolve, reject) => {
    // `security -w` uses /dev/tty when it inherits Bunji's controlling terminal,
    // ignoring the stdin pipe and waiting forever. A detached POSIX session has
    // no controlling terminal, so the password prompt correctly reads this pipe.
    const child = spawnProcess('security', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = '', stderr = '', settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (error: Error | null, value?: string) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error); else resolve(value as string)
    }
    const append = (current: string, chunk: Buffer | string) => (current + chunk).slice(-65536)
    child.stdout!.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr!.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on('error', () => finish(fail('macOS Keychain could not start.', 503)))
    child.on('close', (code: number | null) => code === 0 ? finish(null, stdout) : finish(Object.assign(new Error('macOS Keychain operation failed.'), { code, detail: stderr, status: 503 }) satisfies KeychainError))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(fail('macOS Keychain timed out. Try saving the key again.', 503, 'BUNJI_KEYCHAIN_TIMEOUT'))
    }, timeoutMs)
    child.stdin!.on('error', () => {})
    child.stdin!.end(input)
  })
}

const security = createSecurityRunner()

async function mutateCredential<T>(action: () => Promise<T>): Promise<T> {
  if (credentialMutation) throw fail('Another OpenRouter key update is still finishing. Try again in a moment.', 409)
  credentialMutation = true
  try { return await action() }
  finally { credentialMutation = false }
}

export function validOpenRouterKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && keyPattern.test(value)
}

export async function readOpenRouterCredential({ run = security, env = process.env }: { run?: SecurityRunner; env?: NodeJS.ProcessEnv } = {}): Promise<OpenRouterCredential | null> {
  if (process.platform === 'darwin') {
    try {
      const key = (await run(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'])).trim()
      if (validOpenRouterKey(key)) return { key, source: 'keychain' }
    } catch { /* Fall through to the environment variable. */ }
  }
  const key = env.OPENROUTER_API_KEY?.trim()
  return validOpenRouterKey(key) ? { key, source: 'environment' } : null
}

export async function saveOpenRouterCredential(key: unknown, { run = security }: { run?: SecurityRunner } = {}): Promise<void> {
  const clean = typeof key === 'string' ? key.trim() : ''
  if (!validOpenRouterKey(clean)) throw fail('Enter a valid OpenRouter API key.', 400)
  if (process.platform !== 'darwin') throw fail('Saving OpenRouter keys currently requires macOS Keychain. You can set OPENROUTER_API_KEY instead.', 501)
  // Passing -w last makes `security` read the value from stdin, keeping the key
  // out of the process arguments. The command asks for the value twice.
  await mutateCredential(() => run(['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-l', 'BunjiBox OpenRouter API key', '-w'], `${clean}\n${clean}\n`))
}

export async function deleteOpenRouterCredential({ run = security }: { run?: SecurityRunner } = {}): Promise<void> {
  if (process.platform !== 'darwin') throw fail('Removing OpenRouter keys currently requires macOS Keychain.', 501)
  try { await mutateCredential(() => run(['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE])) }
  catch (error) { if ((error as { code?: unknown } | null)?.code !== 44) throw error }
}

/** Account details from OpenRouter's /key endpoint. Only the fields Bunji reads are listed. */
export interface OpenRouterKeyInfo {
  usage?: unknown
  limit?: unknown
  limit_reset?: unknown
  is_free_tier?: unknown
  [field: string]: unknown
}

export async function inspectOpenRouterKey(key: string, { request = fetch, signal = AbortSignal.timeout(10000) }: { request?: OpenRouterFetch; signal?: AbortSignal } = {}): Promise<OpenRouterKeyInfo> {
  const response = await request(`${API}/key`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error', signal,
  })
  if (!response.ok) {
    const message = response.status === 401 ? 'OpenRouter rejected that API key.'
      : response.status === 429 ? 'OpenRouter is rate-limiting account checks. Try again in a minute.'
        : 'OpenRouter could not verify that API key right now.'
    throw fail(message, response.status === 401 ? 400 : 503)
  }
  const payload = await response.json() as { data?: unknown } | null
  if (!payload?.data || typeof payload.data !== 'object') throw fail('OpenRouter returned an invalid account response.', 502)
  return payload.data as OpenRouterKeyInfo
}

const tokenCount = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null

interface OpenRouterUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
  prompt_tokens_details?: { cached_tokens?: unknown }
  completion_tokens_details?: { reasoning_tokens?: unknown }
}

function usage(value: OpenRouterUsage = {}): TokenUsage {
  const inputTokens = tokenCount(value.prompt_tokens)
  const outputTokens = tokenCount(value.completion_tokens)
  const cachedInputTokens = tokenCount(value.prompt_tokens_details?.cached_tokens)
  const reasoningOutputTokens = tokenCount(value.completion_tokens_details?.reasoning_tokens)
  const totalTokens = tokenCount(value.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens: null, reasoningOutputTokens, totalTokens, source: 'OpenRouter response usage' }
}

const contentText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? (content as ({ type?: string; text?: unknown } | null)[]).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part!.text as string).join('\n') : ''

export interface OpenRouterRunOptions extends ProviderHooks {
  request?: OpenRouterFetch
  credential?: () => Promise<OpenRouterCredential | null>
}

interface ChatCompletion {
  model?: string
  choices?: { message?: { content?: unknown } }[]
  usage?: OpenRouterUsage
}

export async function runOpenRouter({ model, effort, prompt }: Pick<ProviderRequest, 'model' | 'effort' | 'prompt'>, { signal, onActivity, messages, request = fetch, credential = readOpenRouterCredential }: OpenRouterRunOptions = {}): Promise<ProviderOutcome & { durationMs: number }> {
  const startedAt = Date.now()
  const activity: Activity = { id: 'openrouter-api', kind: 'notice', title: 'OpenRouter API', status: 'running', text: 'Waiting for the selected model…' }
  onActivity?.(activity)
  let account
  try {
    account = await credential()
    if (!account?.key) throw new Error('Add an OpenRouter API key on the Usage page before sending a message.')
    const response = await request(`${API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.key}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'BunjiBox' },
      redirect: 'error', signal,
      body: JSON.stringify({ model, messages: Array.isArray(messages) ? messages : [{ role: 'user', content: prompt }], reasoning: { effort } }),
    })
    if (!response.ok) {
      const message = response.status === 401 ? 'OpenRouter rejected the saved API key. Replace it on the Usage page.'
        : response.status === 402 ? 'This OpenRouter request needs credits or a free model with capacity.'
          : response.status === 429 ? 'OpenRouter is rate-limiting this key. Try again shortly.'
            : `OpenRouter could not complete the request (HTTP ${response.status}).`
      throw new Error(message)
    }
    const payload = await response.json() as ChatCompletion | null
    const text = contentText(payload?.choices?.[0]?.message?.content)
    if (!text) throw new Error('OpenRouter returned an empty response.')
    const complete: Activity = { ...activity, status: 'complete', text: `Response received from ${payload!.model || model}.` }
    onActivity?.(complete)
    return { text, usage: usage(payload!.usage), failed: false, activities: [complete], durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = signal?.aborted ? 'The request was stopped.' : errorMessage(error)
    const failed: Activity = { ...activity, status: 'failed', text: message }
    onActivity?.(failed)
    return { text: '', usage: null, failed: true, error: message, activities: [failed], durationMs: Date.now() - startedAt }
  }
}
