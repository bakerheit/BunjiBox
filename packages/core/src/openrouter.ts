import { spawn } from 'node:child_process'

const API = 'https://openrouter.ai/api/v1'
const KEYCHAIN_ACCOUNT = 'bunji-openrouter'
const KEYCHAIN_SERVICE = 'com.bakerheit.bunjibox.openrouter'
const keyPattern = /^sk-or-[A-Za-z0-9_-]{16,}$/
const KEYCHAIN_TIMEOUT_MS = 8000
let credentialMutation = false

export function createSecurityRunner({ spawnProcess = spawn, timeoutMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  return (args, input = '') => new Promise((resolve, reject) => {
    // `security -w` uses /dev/tty when it inherits Bunji's controlling terminal,
    // ignoring the stdin pipe and waiting forever. A detached POSIX session has
    // no controlling terminal, so the password prompt correctly reads this pipe.
    const child = spawnProcess('security', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = '', stderr = '', settled = false, timer
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error); else resolve(value)
    }
    const append = (current, chunk) => (current + chunk).slice(-65536)
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    child.on('error', () => finish(Object.assign(new Error('macOS Keychain could not start.'), { status: 503 })))
    child.on('close', code => code === 0 ? finish(null, stdout) : finish(Object.assign(new Error('macOS Keychain operation failed.'), { code, detail: stderr, status: 503 })))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(Object.assign(new Error('macOS Keychain timed out. Try saving the key again.'), { code: 'BUNJI_KEYCHAIN_TIMEOUT', status: 503 }))
    }, timeoutMs)
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const security = createSecurityRunner()

async function mutateCredential(action) {
  if (credentialMutation) throw Object.assign(new Error('Another OpenRouter key update is still finishing. Try again in a moment.'), { status: 409 })
  credentialMutation = true
  try { return await action() }
  finally { credentialMutation = false }
}

export function validOpenRouterKey(value) {
  return typeof value === 'string' && value.length <= 512 && keyPattern.test(value)
}

export async function readOpenRouterCredential({ run = security, env = process.env } = {}) {
  if (process.platform === 'darwin') {
    try {
      const key = (await run(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'])).trim()
      if (validOpenRouterKey(key)) return { key, source: 'keychain' }
    } catch { /* Fall through to the environment variable. */ }
  }
  const key = env.OPENROUTER_API_KEY?.trim()
  return validOpenRouterKey(key) ? { key, source: 'environment' } : null
}

export async function saveOpenRouterCredential(key, { run = security } = {}) {
  const clean = typeof key === 'string' ? key.trim() : ''
  if (!validOpenRouterKey(clean)) throw Object.assign(new Error('Enter a valid OpenRouter API key.'), { status: 400 })
  if (process.platform !== 'darwin') throw Object.assign(new Error('Saving OpenRouter keys currently requires macOS Keychain. You can set OPENROUTER_API_KEY instead.'), { status: 501 })
  // Passing -w last makes `security` read the value from stdin, keeping the key
  // out of the process arguments. The command asks for the value twice.
  await mutateCredential(() => run(['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-l', 'BunjiBox OpenRouter API key', '-w'], `${clean}\n${clean}\n`))
}

export async function deleteOpenRouterCredential({ run = security } = {}) {
  if (process.platform !== 'darwin') throw Object.assign(new Error('Removing OpenRouter keys currently requires macOS Keychain.'), { status: 501 })
  try { await mutateCredential(() => run(['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE])) }
  catch (error) { if (error.code !== 44) throw error }
}

export async function inspectOpenRouterKey(key, { request = fetch, signal = AbortSignal.timeout(10000) } = {}) {
  const response = await request(`${API}/key`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error', signal,
  })
  if (!response.ok) {
    const message = response.status === 401 ? 'OpenRouter rejected that API key.'
      : response.status === 429 ? 'OpenRouter is rate-limiting account checks. Try again in a minute.'
        : 'OpenRouter could not verify that API key right now.'
    throw Object.assign(new Error(message), { status: response.status === 401 ? 400 : 503 })
  }
  const payload = await response.json()
  if (!payload?.data || typeof payload.data !== 'object') throw Object.assign(new Error('OpenRouter returned an invalid account response.'), { status: 502 })
  return payload.data
}

const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null
function usage(value = {}) {
  const inputTokens = tokenCount(value.prompt_tokens)
  const outputTokens = tokenCount(value.completion_tokens)
  const cachedInputTokens = tokenCount(value.prompt_tokens_details?.cached_tokens)
  const reasoningOutputTokens = tokenCount(value.completion_tokens_details?.reasoning_tokens)
  const totalTokens = tokenCount(value.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens: null, reasoningOutputTokens, totalTokens, source: 'OpenRouter response usage' }
}

const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : ''

export async function runOpenRouter({ model, effort, prompt }, { signal, onActivity, messages, request = fetch, credential = readOpenRouterCredential } = {}) {
  const startedAt = Date.now()
  const activity = { id: 'openrouter-api', kind: 'notice', title: 'OpenRouter API', status: 'running', text: 'Waiting for the selected model…' }
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
    const payload = await response.json()
    const text = contentText(payload?.choices?.[0]?.message?.content)
    if (!text) throw new Error('OpenRouter returned an empty response.')
    const complete = { ...activity, status: 'complete', text: `Response received from ${payload.model || model}.` }
    onActivity?.(complete)
    return { text, usage: usage(payload.usage), failed: false, activities: [complete], durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = signal?.aborted ? 'The request was stopped.' : error.message
    const failed = { ...activity, status: 'failed', text: message }
    onActivity?.(failed)
    return { text: '', usage: null, failed: true, error: message, activities: [failed], durationMs: Date.now() - startedAt }
  }
}
