import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { allowedHostsFrom, createRequestHandler, hostAllowed, sameOrigin } from '../src/http.ts'
import type { RouteHandler } from '../src/http.ts'
import { createRunRoutes } from '../src/routes/run.ts'

async function serve(t, routes: RouteHandler[], allowedHosts: string[] = []) {
  const handler = createRequestHandler(routes, { allowedHosts })
  const server = http.createServer((request, response) => void handler(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = (server.address() as AddressInfo).port
  // node:http lets tests set Host and Origin exactly as a hostile browser would.
  const request = (path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, incoming => {
        let raw = ''
        incoming.setEncoding('utf8').on('data', chunk => { raw += chunk }).on('end', () => resolve({ status: incoming.statusCode, data: raw ? JSON.parse(raw) : null }))
      })
      outgoing.on('error', reject)
      outgoing.end(body)
    })
  return { port, request }
}

function runStub() {
  const calls = { validate: 0, run: 0 }
  const route = createRunRoutes({
    validate: body => { calls.validate++; if (!(body as { prompt?: string }).prompt) throw new Error('Prompt is empty or too long') },
    run: async () => { calls.run++; return { text: 'ok', usage: null, failed: false, activities: [] } },
  })
  return { calls, route }
}

test('the Host allowlist mirrors Vite: IP literals and localhost pass, other names need opting in', () => {
  for (const host of [undefined, '127.0.0.1:4318', '192.168.1.20:5173', '[::1]:4318', 'localhost:4318', 'LOCALHOST', 'bunji.localhost:5173']) {
    assert.equal(hostAllowed(host), true, String(host))
  }
  for (const host of ['attacker.example:4318', 'mac.local:5173', '', 'evil.example@127.0.0.1', '127.0.0.1/evil', '[not-ip]:1', 'a b']) {
    assert.equal(hostAllowed(host), false, host)
  }
  const allowed = allowedHostsFrom(' Studio.lan, .local ,')
  assert.deepEqual(allowed, ['studio.lan', '.local'])
  assert.equal(hostAllowed('studio.lan:5173', allowed), true)
  assert.equal(hostAllowed('mac.local:5173', allowed), true)
  assert.equal(hostAllowed('local', allowed), true)
  assert.equal(hostAllowed('notstudio.lan', allowed), false)
})

test('a DNS-rebound request is refused before any route runs, even with a matching Origin', async t => {
  let reached = false
  const app = await serve(t, [async () => { reached = true; return false }])
  const rebound = await app.request('/api/bots', { headers: { host: 'attacker.example:4318', origin: 'http://attacker.example:4318' } })
  assert.equal(rebound.status, 403)
  assert.match(rebound.data.error, /BUNJI_ALLOWED_HOSTS/)
  assert.equal(reached, false)
  assert.equal((await app.request('/missing')).status, 404)
})

test('opaque and malformed origins are foreign', () => {
  const request = (origin?: string) => ({ headers: { host: '127.0.0.1:4318', ...(origin === undefined ? {} : { origin }) } }) as http.IncomingMessage
  assert.equal(sameOrigin(request()), true)
  assert.equal(sameOrigin(request('http://127.0.0.1:4318')), true)
  for (const origin of ['null', 'not-a-url', 'file://127.0.0.1:4318', 'http://127.0.0.1:9999', 'https://evil.example']) {
    assert.equal(sameOrigin(request(origin)), false, origin)
  }
})

test('/api/run refuses cross-site form posts and foreign origins before validating or running', async t => {
  const { calls, route } = runStub()
  const app = await serve(t, [route])
  const body = JSON.stringify({ prompt: 'hi' })
  // A cross-site <form> or no-cors fetch can only send "simple" content types.
  const simple = await app.request('/api/run', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
  assert.equal(simple.status, 415)
  const foreign = await app.request('/api/run', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body })
  assert.equal(foreign.status, 403)
  assert.match(foreign.data.error, /Cross-origin/)
  assert.deepEqual(calls, { validate: 0, run: 0 })

  const oversized = await app.request('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x'.repeat(70000) }) })
  assert.equal(oversized.status, 413)
  const invalid = await app.request('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.data.ok, false)
  assert.match(invalid.data.error, /Prompt is empty/)
  assert.deepEqual(calls, { validate: 1, run: 0 })

  const local = await app.request('/api/run', { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${app.port}` }, body })
  assert.equal(local.status, 200)
  assert.equal(local.data.ok, true)
  assert.equal(local.data.text, 'ok')
  assert.equal(typeof local.data.requestId, 'string')
  assert.deepEqual(calls, { validate: 2, run: 1 })
})

test('a route that throws unexpectedly answers 500 instead of crashing the service', async t => {
  const app = await serve(t, [async () => { throw new Error('/Users/someone/private/path') }])
  const response = await app.request('/api/anything')
  assert.equal(response.status, 500)
  assert.doesNotMatch(response.data.error, /private/)
})
