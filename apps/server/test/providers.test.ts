import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderRoutes } from '../src/routes/providers.ts'

async function serve(handler) {
  const server = http.createServer(async (request, response) => { if (!await handler(request, response)) { response.statusCode = 404; response.end() } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test('OpenRouter key route verifies before saving and never returns the secret', async t => {
  const calls = []
  const key = 'sk-or-v1-private1234567890abcdef'
  const app = await serve(createProviderRoutes({
    inspect: async value => { calls.push(['inspect', value]); return {} },
    save: async value => { calls.push(['save', value]) },
    usage: async () => ({ id: 'openrouter', status: 'ok', connected: true, windows: [] }),
  }))
  t.after(app.close)
  const response = await fetch(app.url + '/api/providers/openrouter/key', { method: 'POST', headers: { 'content-type': 'application/json', origin: app.url }, body: JSON.stringify({ key }) })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [['inspect', key], ['save', key]])
  assert.doesNotMatch(await response.text(), /private/)
})

test('OpenRouter key route rejects foreign origins and supports removal', async t => {
  let removed = false
  const app = await serve(createProviderRoutes({ remove: async () => { removed = true }, usage: async () => ({ id: 'openrouter', status: 'signed_out', connected: false, windows: [] }) }))
  t.after(app.close)
  const foreign = await fetch(app.url + '/api/providers/openrouter/key', { method: 'DELETE', headers: { origin: 'https://evil.example' } })
  assert.equal(foreign.status, 403)
  assert.equal(removed, false)
  const local = await fetch(app.url + '/api/providers/openrouter/key', { method: 'DELETE', headers: { origin: app.url } })
  assert.equal(local.status, 200)
  assert.equal(removed, true)
})
