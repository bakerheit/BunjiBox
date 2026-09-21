import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCodexUsage, normalizeClaudeUsage, readCodexUsage, readClaudeUsage, createUsageReader } from '../src/usage.mjs'

test('Codex uses the multi-limit map and labels durations, not assumed slot names', () => {
  const windows = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1790430020 }, secondary: null }, other: { limitName: 'Other model', primary: { usedPercent: 0, windowDurationMins: 300 } } } })
  assert.equal(windows.length, 2)
  assert.equal(windows[0].label, 'Weekly')
  assert.equal(windows[0].remainingPercent, 85)
  assert.equal(windows[0].resetsAt, '2026-09-26T13:40:20.000Z')
  assert.equal(windows[1].label, 'Other model · 5-hour window')
  assert.equal(windows[1].remainingPercent, 100)
})

test('Codex missing data is not zero, and invalid percentages are clamped', () => {
  assert.deepEqual(normalizeCodexUsage({}), [])
  const windows = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: null, resetsAt: null }, secondary: { usedPercent: 125, resetsAt: 'invalid' } } })
  assert.equal(windows[0].usedPercent, null)
  assert.equal(windows[0].remainingPercent, null)
  assert.equal(windows[0].resetsAt, null)
  assert.equal(windows[1].usedPercent, 100)
  assert.equal(windows[1].resetsAt, null)
})

test('Claude normalizes both classic and model-scoped limits without duplicates', () => {
  const windows = normalizeClaudeUsage({ five_hour: { utilization: 0, resets_at: '2026-09-20T22:00:00Z' }, seven_day: { utilization: 65.5 }, seven_day_sonnet: { utilization: 20 }, seven_day_opus: null, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Sonnet' } }, percent: 20 }, { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 41, resets_at: 1790430020 }] })
  assert.equal(windows.length, 4)
  assert.equal(windows[0].usedPercent, 0)
  assert.equal(windows[1].remainingPercent, 34.5)
  assert.equal(windows[3].label, 'Weekly · Fable')
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: '23' } })[0].usedPercent, null)
})

function codexClient(account, payload, fail = false) {
  const methods = []
  let closed = false
  return { methods, get closed() { return closed }, connect: () => ({ request: async method => { methods.push(method); if (method === 'initialize') return {}; if (method === 'account/read') return { account }; if (fail) throw new Error('RAW_PRIVATE_ERROR'); return payload }, notify: method => methods.push(method), close: () => { closed = true } }) }
}

test('Codex reads account-only methods and does not leak account identifiers', async () => {
  const mock = codexClient({ type: 'chatgpt', planType: 'pro', email: 'PRIVATE_EMAIL' }, { accountId: 'PRIVATE_ID', rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } })
  const result = await readCodexUsage(mock)
  assert.deepEqual(mock.methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
  assert.equal(mock.closed, true)
  assert.equal(result.status, 'ok')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
})

test('Codex signed-out and API-key sessions do not read subscription limits', async () => {
  for (const [account, status] of [[null, 'signed_out'], [{ type: 'apiKey' }, 'unsupported']]) {
    const mock = codexClient(account)
    assert.equal((await readCodexUsage(mock)).status, status)
    assert.equal(mock.methods.includes('account/rateLimits/read'), false)
    assert.equal(mock.closed, true)
  }
})

test('Codex failures close the process and redact provider errors', async () => {
  const mock = codexClient({ type: 'chatgpt' }, null, true)
  const result = await readCodexUsage(mock)
  assert.equal(result.status, 'unavailable')
  assert.equal(mock.closed, true)
  assert.doesNotMatch(JSON.stringify(result), /RAW_PRIVATE/)
})

const auth = async () => ({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })
const credential = async () => ({ accessToken: 'TEST_SECRET', expiresAt: Date.now() + 600000 })

test('Claude signed-out skips all credential and network access', async () => {
  const unexpected = () => { throw new Error('must not be called') }
  const result = await readClaudeUsage({ auth: async () => ({ loggedIn: false }), credential: unexpected, request: unexpected })
  assert.equal(result.status, 'signed_out')
  assert.deepEqual(result.windows, [])
})

test('Claude sends credentials only to the provider, disallows redirects, and strips them from response', async () => {
  const result = await readClaudeUsage({ auth, credential, request: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(options.headers.Authorization, 'Bearer TEST_SECRET')
    assert.equal(options.redirect, 'error')
    return { ok: true, json: async () => ({ five_hour: { utilization: 12 }, email: 'PRIVATE_EMAIL' }) }
  } })
  assert.equal(result.status, 'ok')
  assert.equal(result.plan, 'max')
  assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|PRIVATE_EMAIL/)
})

test('Claude expired credentials never make a usage request', async () => {
  let requested = false
  const result = await readClaudeUsage({ auth, credential: async () => ({ accessToken: 'TEST_SECRET', expiresAt: 1 }), request: async () => { requested = true } })
  assert.equal(result.status, 'unavailable')
  assert.equal(requested, false)
})

test('Claude auth failures, rate limits, malformed data, and network errors stay truthful', async () => {
  for (const status of [401, 403, 429, 500]) {
    const result = await readClaudeUsage({ auth, credential, request: async () => ({ ok: false, status }) })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.connected, true)
    assert.equal(result.windows.length, 0)
  }
  const malformed = await readClaudeUsage({ auth, credential, request: async () => ({ ok: true, json: async () => ({ unexpected: 0 }) }) })
  assert.equal(malformed.status, 'unavailable')
  const network = await readClaudeUsage({ auth, credential, request: async () => { throw new Error('PRIVATE_ERROR') } })
  assert.doesNotMatch(JSON.stringify(network), /PRIVATE_ERROR|TEST_SECRET/)
})

test('Usage cache coalesces callers, refreshes after TTL, and throttles forced refreshes', async () => {
  let time = 100000
  let calls = 0
  let resolve
  const first = new Promise(done => { resolve = done })
  const reader = createUsageReader({ now: () => time, codex: async () => { calls++; if (calls === 1) await first; return { status: 'ok' } }, claude: async () => ({ status: 'signed_out' }) })
  const a = reader()
  const b = reader({ refresh: true })
  resolve()
  assert.deepEqual(await a, await b)
  assert.equal(calls, 1)
  time += 5000
  await reader({ refresh: true })
  assert.equal(calls, 1)
  time += 5001
  await reader({ refresh: true })
  assert.equal(calls, 2)
  time += 59000
  await reader()
  assert.equal(calls, 2)
  time += 1001
  await reader()
  assert.equal(calls, 3)
})
