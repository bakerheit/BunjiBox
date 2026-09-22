import test from 'node:test'
import assert from 'node:assert/strict'
import { baseline, prepare, decide, createClient, metrics, usageOf, LIMITS, ENDPOINT } from './harness.mjs'
import { fixtures } from './fixtures.mjs'

const fixture = fixtures[0]
const prepared = prepare(fixture)
const answer = (choice = 'c0', confidence = 0.95, probabilities = { none: 0.02, c0: 0.96, c1: 0.02 }) => ({
  model: 'jev-1.13.0', answers: { target: { type: 'choice', choice, confidence, probabilities } },
  usage: { input_tokens: 123, output_tokens: 12 },
})
// This literal is synthetic, never an environment/account credential.
const env = { TYPESAFE_API_KEY: 'synthetic-test-only' }
const response = data => new Response(JSON.stringify(data))

test('baseline metrics are deterministic and expose semantic failures', () => {
  assert.deepEqual(metrics(fixtures.map(f => ({ expected: f.expected, decision: baseline(f) }))), {
    cases: 16, correct: 11, accuracy: 11 / 16, abstentions: 8, coverage: 0.5,
    selectedAccuracy: 5 / 8, unsafeSelections: 3,
  })
})
test('request is allowlisted; labels, expected labels, permissions and image cannot become instructions', () => {
  const p = prepare({ ...fixture, permissions: 'grant', image: 'private', expected: 'secret' })
  const body = JSON.parse(p.body)
  assert.deepEqual(Object.keys(body.state), ['objective', 'observedAXCandidates'])
  assert.deepEqual(Object.keys(body.questions.target.criteria), ['none', 'c0', 'c1'])
  assert.equal(p.body.includes('secret'), false)
  assert.equal(p.body.includes('private'), false)
})
test('bounded validation rejects missing, duplicate and oversized input', () => {
  for (const input of [null, { ...fixture, objective: '' }, { ...fixture, candidates: [fixture.candidates[0], fixture.candidates[0]] },
    { ...fixture, candidates: Array(21).fill(fixture.candidates[0]) }, { ...fixture, objective: 'x'.repeat(1001) },
    { ...fixture, candidates: [{ ...fixture.candidates[0], enabled: 'yes' }] },
    { ...fixture, candidates: Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, label: '😀'.repeat(128), role: '😀'.repeat(64), enabled: true })) }]) {
    assert.throws(() => prepare(input), /invalid_input/)
  }
})
test('valid response maps to original frame and native ID, ignoring extra action/permission fields', () => {
  assert.deepEqual(decide(prepared, { ...answer(), action: 'delete', permissions: 'all' }), {
    kind: 'candidate', frameId: fixture.frameId, elementId: 'save',
  })
})
test('none, disabled and uncertainty abstain', () => {
  assert.equal(decide(prepared, answer('none', 0.99, { none: 0.98, c0: 0.01, c1: 0.01 })).reason, 'model_abstained')
  assert.equal(decide(prepared, answer('c0', 0.79)).reason, 'uncertain')
  assert.equal(decide(prepared, answer('c0', 0.99, { none: 0.1, c0: 0.8, c1: 0.1 })).reason, 'uncertain')
  const p = prepare({ ...fixture, candidates: fixture.candidates.map(c => ({ ...c, enabled: false })) })
  assert.equal(decide(p, answer()).reason, 'disabled')
})
test('malformed distributions and invented IDs cannot produce a selection', () => {
  for (const a of [null, answer('invented'), answer('c0', NaN), answer('c0', 1, { c0: 1 }),
    answer('c0', 1, { none: 0, c0: 1, evil: 0 }), answer('c0', 1, { none: 0.9, c0: 0.1, c1: 0 }),
    answer('c0', 1, { none: 0, c0: 0.9, c1: 0 }), answer('c0', 1, { none: -0.1, c0: 1, c1: 0.1 })]) {
    assert.equal(decide(prepared, a).reason, 'invalid_response')
  }
})
test('default mode does not read env or call network', async () => {
  const client = createClient({ env: new Proxy({}, { get() { assert.fail('env read') } }), fetchImpl() { assert.fail('network') } })
  assert.equal((await client(fixture)).decision.reason, 'live_disabled')
})
test('live seam fixes endpoint, rejects redirects, bounds calls, reports separate tokens', async () => {
  let calls = 0
  const client = createClient({ live: true, env, fetchImpl: async (url, options) => {
    calls++
    assert.equal(url, ENDPOINT)
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    assert.ok(Buffer.byteLength(options.body) <= LIMITS.requestBytes)
    return response(answer())
  } })
  const result = await client(fixture)
  assert.equal(result.decision.kind, 'candidate')
  assert.equal(result.model, 'jev-1.13.0')
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 12, cacheReadTokens: null })
  assert.equal((await client(fixture)).decision.reason, 'request_budget')
  assert.equal(calls, 1)
})
test('missing key and invalid input send nothing; hard request cap cannot be raised', async () => {
  const client = createClient({ live: true, env: {}, fetchImpl() { assert.fail('network') } })
  assert.equal((await client(fixture)).decision.reason, 'missing_key')
  assert.equal((await client(null)).decision.reason, 'invalid_input')
  assert.throws(() => createClient({ maxRequests: 4 }))
  assert.throws(() => createClient({ timeoutMs: 5001 }))
})
test('HTTP failures including rate limits never retry or echo bodies', async () => {
  for (const status of [302, 401, 422, 429, 529]) {
    let calls = 0
    const client = createClient({ live: true, env, fetchImpl: async () => { calls++; return new Response('private server text', { status }) } })
    assert.equal((await client(fixture)).decision.reason, 'http_error')
    assert.equal((await client(fixture)).decision.reason, 'request_budget')
    assert.equal(calls, 1)
  }
})
test('transport/parse errors are redacted, and oversized responses are cancelled', async () => {
  for (const fetchImpl of [async () => { throw new Error('private server text') }, async () => new Response('private invalid JSON')]) {
    const result = await createClient({ live: true, env, fetchImpl })(fixture)
    assert.equal(result.decision.reason, 'transport_or_parse_error')
    assert.equal(JSON.stringify(result).includes('private'), false)
  }
  let cancelled = false
  const fetchImpl = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(LIMITS.responseBytes + 1)) }, cancel() { cancelled = true },
  }))
  assert.equal((await createClient({ live: true, env, fetchImpl })(fixture)).decision.reason, 'response_limit')
  assert.equal(cancelled, true)
})
test('deadline covers headers and stalled response body without retry', async () => {
  for (const bodyStall of [false, true]) {
    let calls = 0; let signal
    const fetchImpl = async (_, options) => {
      calls++; signal = options.signal
      if (bodyStall) return new Response(new ReadableStream({ start(c) {
        signal.addEventListener('abort', () => c.error(new Error('aborted')))
      } }))
      return new Promise(() => {})
    }
    const result = await createClient({ live: true, env, timeoutMs: 10, fetchImpl })(fixture)
    assert.equal(result.decision.reason, 'timeout')
    assert.equal(signal.aborted, true)
    assert.equal(calls, 1)
  }
})
test('unavailable usage is null, never fabricated zero; model text is constrained', async () => {
  assert.deepEqual(usageOf({ usage: { input_tokens: -1, output_tokens: '10' } }), { inputTokens: null, outputTokens: null, cacheReadTokens: null })
  const result = await createClient({ live: true, env, fetchImpl: async () => response({ ...answer(), model: 'private server text' }) })(fixture)
  assert.equal(result.model, null)
})
