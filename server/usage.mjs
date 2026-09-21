import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const percent = value => finite(value) ? Math.max(0, Math.min(100, value)) : null
const date = value => {
  if (value == null || value === '') return null
  const timestamp = typeof value === 'number' ? value * 1000 : Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e15 ? new Date(timestamp).toISOString() : null
}

function windowLabel(minutes, fallback) {
  if (minutes === 10080) return 'Weekly'
  if (minutes === 1440) return 'Daily'
  if (finite(minutes) && minutes > 0) return minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`
  return fallback
}

function usageWindow(id, label, used, reset, minutes = null) {
  const usedPercent = percent(used)
  return { id, label, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetsAt: date(reset), windowMinutes: finite(minutes) ? minutes : null }
}

// Only these display fields leave the bridge. Never forward account objects,
// credential stores, provider error bodies, or CLI output to the browser.
export function normalizeCodexUsage(payload = {}) {
  const buckets = payload.rateLimitsByLimitId && Object.keys(payload.rateLimitsByLimitId).length
    ? Object.entries(payload.rateLimitsByLimitId)
    : payload.rateLimits ? [[payload.rateLimits.limitId || 'codex', payload.rateLimits]] : []
  return buckets.flatMap(([id, bucket]) => ['primary', 'secondary'].flatMap((slot, index) => {
    const window = bucket?.[slot]
    if (!window || typeof window !== 'object') return []
    const prefix = id === 'codex' ? '' : `${bucket.limitName || id} · `
    return [usageWindow(`${id}-${slot}`, prefix + windowLabel(window.windowDurationMins, index ? 'Secondary window' : 'Primary window'), window.usedPercent, window.resetsAt, window.windowDurationMins)]
  }))
}

export function normalizeClaudeUsage(payload = {}) {
  const fields = [
    ['five_hour', '5-hour window', 300], ['seven_day', 'Weekly · all models', 10080],
    ['seven_day_sonnet', 'Weekly · Sonnet', 10080], ['seven_day_opus', 'Weekly · Opus', 10080],
    ['seven_day_oauth_apps', 'Weekly · OAuth apps', 10080],
  ]
  const windows = fields.flatMap(([id, label, minutes]) => payload?.[id] && typeof payload[id] === 'object'
    ? [usageWindow(id, label, payload[id].utilization, payload[id].resets_at, minutes)] : [])
  for (const [index, limit] of (Array.isArray(payload?.limits) ? payload.limits : []).entries()) {
    if (limit?.kind !== 'weekly_scoped' || typeof limit.scope?.model?.display_name !== 'string') continue
    const label = `Weekly · ${limit.scope.model.display_name}`
    if (!windows.some(window => window.label.toLowerCase() === label.toLowerCase())) windows.push(usageWindow(`scoped-${index}`, label, limit.percent, limit.resets_at, 10080))
  }
  return windows
}

function state(id, status, extras = {}) {
  return { id, label: id === 'codex' ? 'Codex' : 'Claude', status, connected: status === 'signed_out' ? false : null, plan: null, windows: [], checkedAt: new Date().toISOString(), loginCommand: id === 'codex' ? 'codex login' : 'claude auth login', ...extras }
}

function openCodex() {
  // Account-only JSON-RPC. No thread, turn, model call, or reset-credit action.
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let sequence = 0
  let failure = null
  const fail = error => { failure = error; for (const item of pending.values()) item.reject(error); pending.clear() }
  const timer = setTimeout(() => { fail(new Error('Codex usage timed out')); child.kill('SIGKILL') }, 20000)
  child.on('error', () => fail(new Error('Codex could not start')))
  child.on('exit', () => fail(new Error('Codex usage connection closed')))
  child.stdin.on('error', () => fail(new Error('Codex usage connection closed')))
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(new Error('Codex did not return usage'))
    else item.resolve(message.result)
  })
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  return {
    request(method, params) {
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); send({ id, method, ...(params ? { params } : {}) }) })
    },
    notify: method => send({ method, params: {} }),
    close() { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); const hardStop = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 1000); hardStop.unref() },
  }
}

export async function readCodexUsage({ connect = openCodex } = {}) {
  let client
  let account
  try {
    client = connect()
    await client.request('initialize', { clientInfo: { name: 'bunjibox', title: 'BunjiBox Usage', version: '0.1.0' } })
    client.notify('initialized')
    ;({ account } = await client.request('account/read', { refreshToken: false }))
    if (!account) return state('codex', 'signed_out', { message: 'Sign in to Codex on this Mac to see your subscription limits.' })
    if (!['chatgpt', 'chatgptAuthTokens'].includes(account.type)) return state('codex', 'unsupported', { connected: true, message: 'This login is not a ChatGPT subscription. Subscription meters are not available for API-key or external-provider logins.' })
    const payload = await client.request('account/rateLimits/read')
    const windows = normalizeCodexUsage(payload)
    return state('codex', windows.some(window => window.usedPercent !== null) ? 'ok' : 'unavailable', { connected: true, plan: account.planType || null, windows, source: 'Codex app-server', message: windows.length ? null : 'Codex did not report usage windows for this account.' })
  } catch {
    return state('codex', 'unavailable', { connected: account ? true : null, message: 'Could not read Codex usage. Check that Codex is installed and signed in on this Mac, then refresh.' })
  } finally { client?.close() }
}

async function claudeAuth() {
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status'], { timeout: 10000, maxBuffer: 65536 })
    return JSON.parse(stdout)
  } catch (error) {
    // Claude exits non-zero when signed out, but still returns auth-status JSON.
    try { const status = JSON.parse(error.stdout); if (status.loggedIn === false) return status } catch { /* Not auth JSON. */ }
    throw new Error('Claude auth unavailable')
  }
}

async function claudeCredential() {
  // Match Claude Code's local secure-storage selection. Never scan other stores.
  const secureDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const customDir = secureDir !== undefined ? secureDir : process.env.CLAUDE_CONFIG_DIR
  const configDir = (customDir || join(homedir(), '.claude')).normalize('NFC')
  if (process.platform === 'darwin') {
    const suffix = customDir ? '-' + createHash('sha256').update(configDir).digest('hex').slice(0, 8) : ''
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-a', process.env.USER || userInfo().username, '-s', `Claude Code-credentials${suffix}`, '-w'], { timeout: 5000, maxBuffer: 65536 })
      const value = JSON.parse(stdout)?.claudeAiOauth
      if (value?.accessToken) return value
    } catch { /* Claude also supports a file fallback when Keychain is unavailable. */ }
  }
  try { return JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8'))?.claudeAiOauth || null } catch { return null }
}

export async function readClaudeUsage({ auth = claudeAuth, credential = claudeCredential, request = fetch } = {}) {
  let account
  try {
    account = await auth()
    if (!account.loggedIn) return state('claude', 'signed_out', { message: 'Sign in to Claude Code on this Mac, then refresh. Signing in to the Claude website alone does not connect BunjiBox.' })
    if (account.apiProvider !== 'firstParty' || account.authMethod === 'api_key') return state('claude', 'unsupported', { connected: true, message: 'Subscription usage needs a Claude subscription login, not an API key or external provider.' })
    const oauth = await credential()
    if (!oauth?.accessToken) return state('claude', 'unavailable', { connected: true, message: 'Claude is signed in, but its local subscription credential is unavailable. Open Claude Code on this Mac and sign in again if needed.' })
    if (finite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) return state('claude', 'unavailable', { connected: true, message: 'Claude’s saved login needs to be refreshed. Open Claude Code on this Mac, then try again.' })
    // This is the endpoint used by Claude Code /usage, not a public billing API.
    // Keep credentials server-side and refuse redirects to any other destination.
    const response = await request('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
      const message = [401, 403].includes(response.status) ? 'Claude could not authorize this usage check. Open Claude Code and sign in again, then refresh.' : response.status === 429 ? 'Claude is rate-limiting usage checks. Wait a minute, then refresh.' : 'Claude’s usage service is unavailable. Try again shortly.'
      return state('claude', 'unavailable', { connected: true, message })
    }
    const windows = normalizeClaudeUsage(await response.json())
    return state('claude', windows.some(window => window.usedPercent !== null) ? 'ok' : 'unavailable', { connected: true, plan: account.subscriptionType || oauth.subscriptionType || null, windows, source: 'Claude Code subscription usage', message: windows.length ? null : 'Claude did not report subscription usage windows. Try /usage in Claude Code.' })
  } catch {
    return state('claude', 'unavailable', { connected: account?.loggedIn ? true : null, message: 'Could not read Claude usage. Check the Claude Code login on this Mac and try again.' })
  }
}

export function createUsageReader({ codex = readCodexUsage, claude = readClaudeUsage, now = Date.now } = {}) {
  let cache
  let cachedAt = 0
  let pending
  return async ({ refresh = false } = {}) => {
    if (pending) return pending
    if (cache && now() - cachedAt < (refresh ? 10000 : 60000)) return cache
    pending = Promise.all([codex(), claude()]).then(([codex, claude]) => {
      cachedAt = now()
      cache = { checkedAt: new Date(cachedAt).toISOString(), refreshAfterSeconds: 60, providers: { codex, claude } }
      return cache
    }).finally(() => { pending = null })
    return pending
  }
}
