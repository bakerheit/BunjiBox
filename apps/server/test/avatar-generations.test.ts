import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setImmediate as tick } from 'node:timers/promises'
import { createAvatarGenerations } from '@bunji/core/avatar-generation'
import { createAvatarGenerationRoutes } from '../src/routes/avatar-generations.ts'

const id = 'avatar-http-test-0001'
const basePath = '/api/avatar-generations'
const image = 'data:image/png;base64,mocked-preview'

type RequestOptions = { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> }

async function fixture(t) {
  const calls = []
  const service = createAvatarGenerations({ generate: (prompt, { signal }) => new Promise((resolve, reject) => {
    calls.push({ prompt, signal, resolve, reject })
  }) })
  const route = createAvatarGenerationRoutes(service)
  const server = createServer(async (request, response) => {
    if (!await route(request, response)) { response.writeHead(404); response.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const call of calls) call.resolve(image)
    await service.close()
    await new Promise(resolve => server.close(resolve))
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function request(path = basePath, { method = 'GET', body, raw, headers = {} }: RequestOptions = {}): Promise<{ status: number; headers: Headers; data: any }> {
    const response = await fetch(origin + path, {
      method, headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    })
    return { status: response.status, headers: response.headers, data: method === 'HEAD' ? null : await response.json() }
  }
  return { request, calls, origin, service }
}

test('real HTTP starts, retries, polls and cancels mocked jobs without any provider requests', async t => {
  const f = await fixture(t)
  const start = await f.request(basePath, { method: 'POST', body: { id, prompt: 'A robot' } })
  assert.equal(start.status, 202)
  assert.equal(start.headers.get('cache-control'), 'no-store')
  assert.match(start.headers.get('content-type'), /^application\/json/)
  assert.deepEqual(start.data, { generation: { id, status: 'running', image: null, error: null } })
  const retry = await f.request(basePath, { method: 'POST', body: { id, prompt: ' A robot ' }, headers: { origin: f.origin } })
  assert.deepEqual(retry.data, start.data)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.request(basePath, { method: 'POST', body: { id, prompt: 'A cat' } })).status, 409)
  assert.equal((await f.request(`${basePath}/${id}`)).data.generation.status, 'running')
  const cancelled = await f.request(`${basePath}/${id}/cancel`, { method: 'POST', body: {} })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.data.generation.status, 'cancelled')
  assert.equal(f.calls[0].signal.aborted, true)
  f.calls[0].resolve(image); await tick()
  assert.deepEqual((await f.request(`${basePath}/${id}`)).data, cancelled.data)
})

test('real HTTP returns completed previews, failed terminal states and unknown-job errors', async t => {
  const f = await fixture(t)
  for (const [suffix, outcome] of [['complete', 'resolve'], ['failed', 'reject']]) {
    const jobID = `${id}-${suffix}`
    await f.request(basePath, { method: 'POST', body: { id: jobID, prompt: 'A robot' } })
    f.calls.at(-1)[outcome](outcome === 'resolve' ? image : new Error('Mock failure'))
    await tick()
    const result = await f.request(`${basePath}/${jobID}`)
    assert.equal(result.status, 200)
    assert.deepEqual(result.data.generation, { id: jobID, status: suffix, image: suffix === 'complete' ? image : null, error: suffix === 'failed' ? 'Mock failure' : null })
  }
  assert.equal((await f.request(`${basePath}/missing-request`)).status, 404)
  assert.equal((await f.request(`${basePath}/missing-request/cancel`, { method: 'POST', body: {} })).status, 404)
})

test('real HTTP rejects foreign origins on creation, polling and cancellation without side effects', async t => {
  const f = await fixture(t)
  await f.request(basePath, { method: 'POST', body: { id, prompt: 'A robot' } })
  for (const [path, method, body] of [[basePath, 'POST', { id: `${id}-new`, prompt: 'A cat' }],
    [`${basePath}/${id}`, 'GET'], [`${basePath}/${id}/cancel`, 'POST', {}]] as [string, string, object?][]) {
    const response = await f.request(path, { method, body, headers: { origin: 'https://foreign.example' } })
    assert.equal(response.status, 403)
    assert.match(response.data.error, /Cross-origin/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].signal.aborted, false)
})

test('real HTTP rejects unsupported verbs and paths without starting jobs', async t => {
  const f = await fixture(t)
  for (const [path, methods] of [[basePath, ['GET', 'PUT', 'DELETE', 'OPTIONS']],
    [`${basePath}/${id}`, ['POST', 'PUT', 'DELETE']], [`${basePath}/${id}/cancel`, ['GET', 'DELETE']]] as [string, string[]][]) {
    for (const method of methods) assert.equal((await f.request(path, { method })).status, 405, `${method} ${path}`)
  }
  for (const path of ['/api/unrelated', `${basePath}/${id}/extra`, `${basePath}-extra`]) {
    assert.equal((await f.request(path)).status, 404)
  }
  assert.equal(f.calls.length, 0)
})

test('real HTTP enforces JSON, body size, prompt limits and cancellation body parsing', async t => {
  const f = await fixture(t)
  for (const [options, status] of [
    [{ raw: '{}', headers: { 'content-type': 'text/plain' } }, 415],
    [{ raw: '{broken' }, 400], [{ raw: '' }, 400], [{ body: null }, 400], [{ body: [] }, 400],
    [{ body: { id, prompt: 'x'.repeat(2001) } }, 400],
    [{ body: { id, prompt: 'A robot', extra: true } }, 400],
    [{ body: { id, prompt: 'x'.repeat(17000) } }, 413],
  ] as [RequestOptions, number][]) assert.equal((await f.request(basePath, { method: 'POST', ...options })).status, status)
  assert.equal(f.calls.length, 0)
  await f.request(basePath, { method: 'POST', body: { id, prompt: 'A robot' }, headers: { 'content-type': 'application/json; charset=utf-8' } })
  for (const [options, status] of [[{ raw: '{bad' }, 400], [{ raw: '{}', headers: { 'content-type': 'text/plain' } }, 415],
    [{ body: { padding: 'x'.repeat(1100) } }, 413]] as [RequestOptions, number][]) {
    assert.equal((await f.request(`${basePath}/${id}/cancel`, { method: 'POST', ...options })).status, status)
    assert.equal(f.calls[0].signal.aborted, false)
  }
})

test('real HTTP exposes active-job capacity and shutdown as 429 and 503', async t => {
  const f = await fixture(t)
  for (let n = 0; n < 2; n++) assert.equal((await f.request(basePath, { method: 'POST', body: { id: `${id}-${n}`, prompt: 'A robot' } })).status, 202)
  assert.equal((await f.request(basePath, { method: 'POST', body: { id: `${id}-third`, prompt: 'A robot' } })).status, 429)
  for (const call of f.calls) call.resolve(image)
  await f.service.close()
  assert.equal((await f.request(basePath, { method: 'POST', body: { id: `${id}-new`, prompt: 'A robot' } })).status, 503)
})

test('opaque or malformed browser origins must be rejected as client errors, not HTTP 500', async t => {
  const f = await fixture(t)
  for (const origin of ['null', 'not-a-url']) {
    const response = await f.request(basePath, { method: 'POST', body: { id, prompt: 'A robot' }, headers: { origin } })
    assert.equal(response.status, 403, `Origin: ${origin}`)
  }
  assert.equal(f.calls.length, 0)
})
