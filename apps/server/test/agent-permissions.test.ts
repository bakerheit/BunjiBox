import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBotStore } from '@bunji/core/bot-store'
import { createBotRoutes } from '../src/routes/bots.ts'

async function fixture(t, { legacy = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bunji-agent-permissions-')))
  const workspaceRoot = join(dir, 'workspace-root')
  const folder = join(dir, 'agent-folder')
  await Promise.all([mkdir(workspaceRoot), mkdir(folder)])
  const path = join(dir, 'workspace.sqlite')
  if (legacy) await writeFile(join(dir, 'config.json'), JSON.stringify({ bots: [{ id: 'legacy', name: 'Legacy' }] }))
  const store = openBotStore({ path, workspaceRoot })
  const route = createBotRoutes(store)
  const server = http.createServer((request, response) => void route(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    store.close()
    await rm(dir, { recursive: true, force: true })
  })
  const request = async (url, { method = 'PATCH', body, headers = {}, localOrigin = true } = {}) => {
    const requestHeaders = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
    if (localOrigin && !Object.hasOwn(headers, 'origin')) requestHeaders.origin = origin
    const response = await fetch(origin + url, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { response, json: response.status === 304 ? null : await response.json() }
  }
  return { dir, folder, origin, path, request, store, workspaceRoot }
}

test('old bots gain safe computer defaults and folder profiles persist across store reopen', async t => {
  const f = await fixture(t, { legacy: true })
  assert.deepEqual(f.store.list().bots[0].computer, { scope: 'none', level: 'read', network: 'off' })

  const profile = { scope: 'folder', level: 'auto', folder: f.folder, network: 'ask' }
  const direct = await f.request('/api/bots/legacy', { body: { computer: profile } })
  assert.equal(direct.response.status, 409)
  const saved = await f.request('/api/bots/legacy/computer/enable-folder', { method: 'POST', body: { computer: profile } })
  assert.equal(saved.response.status, 200)
  assert.deepEqual(saved.json.bots[0].computer, { scope: 'folder', level: 'auto', folder: f.folder, network: 'ask' })

  const reopened = openBotStore({ path: f.path, workspaceRoot: f.workspaceRoot })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.list().bots[0].computer, { scope: 'folder', level: 'auto', folder: f.folder, network: 'ask' })
})

test('folder and none PATCHes validate an explicit, narrow real directory and never infer machine access', async t => {
  const f = await fixture(t)
  const id = 'bunjibox'
  const target = join(f.dir, 'linked-folder')
  await symlink(f.folder, target)
  const reject = async (computer, { local = false } = {}) => {
    const result = local
      ? await f.request(`/api/bots/${id}/computer/enable-folder`, { method: 'POST', body: { computer } })
      : await f.request(`/api/bots/${id}`, { body: { computer } })
    assert.equal(result.response.status, 400)
    assert.deepEqual(f.store.list().bots[0].computer, { scope: 'none', level: 'read', network: 'off' })
  }

  await reject({ scope: 'folder', level: 'ask', network: 'off' }, { local: true })
  await reject({ scope: 'folder', level: 'ask', folder: join(f.dir, 'missing'), network: 'off' }, { local: true })
  await reject({ scope: 'folder', level: 'ask', folder: target, network: 'off' }, { local: true })
  await reject({ scope: 'folder', level: 'ask', folder: '/', network: 'off' }, { local: true })
  await reject({ scope: 'folder', level: 'ask', folder: homedir(), network: 'off' }, { local: true })
  await reject({ scope: 'folder', level: 'ask', folder: f.workspaceRoot, network: 'off' }, { local: true })
  await reject({ scope: 'none', level: 'read', network: 'off', folder: f.folder })
  await reject({ scope: 'none', level: 'read', network: 'off', credential: 'not-a-policy-field' })

  const patch = await f.request(`/api/bots/${id}`, { body: { computer: { level: 'ask' } } })
  assert.equal(patch.response.status, 200)
  assert.deepEqual(patch.json.bots[0].computer, { scope: 'none', level: 'ask', network: 'off' })
})

test('folder access enables without device pairing or an approval phrase', async t => {
  const f = await fixture(t)
  const id = 'bunjibox', endpoint = `/api/bots/${id}/computer/enable-folder`
  const profile = { scope: 'folder', level: 'read', folder: f.folder, network: 'off' }
  const badScope = await f.request(endpoint, { method: 'POST', body: { computer: { scope: 'none', level: 'read', network: 'off' } } })
  assert.equal(badScope.response.status, 400)
  const enabled = await f.request(endpoint, { method: 'POST', body: { computer: profile } })
  assert.equal(enabled.response.status, 200)
  assert.deepEqual(enabled.json.bots[0].computer, profile)
})

test('full machine access uses the dedicated validated settings route', async t => {
  const f = await fixture(t)
  const id = 'bunjibox'
  const endpoint = `/api/bots/${id}/computer/enable-full-machine`
  const machine = { scope: 'machine', level: 'auto', network: 'off' }

  const direct = await f.request(`/api/bots/${id}`, { body: { computer: machine } })
  assert.equal(direct.response.status, 409)
  assert.match(direct.json.error, /Computer access settings/)
  assert.deepEqual(f.store.list().bots[0].computer, { scope: 'none', level: 'read', network: 'off' })

  const directCreate = await f.request('/api/bots', { method: 'POST', body: { id: 'unconfirmed-machine', name: 'Nope', computer: machine } })
  assert.equal(directCreate.response.status, 409)
  assert.equal(f.store.list().bots.some(bot => bot.id === 'unconfirmed-machine'), false)

  const missingField = await f.request(endpoint, { method: 'POST', body: { computer: { scope: 'machine', network: 'off' } } })
  assert.equal(missingField.response.status, 400)
  const unsafeProfile = await f.request(endpoint, { method: 'POST', body: { computer: { ...machine, credential: 'nope' } } })
  assert.equal(unsafeProfile.response.status, 400)
  const unsupportedLevel = await f.request(endpoint, { method: 'POST', body: { computer: { ...machine, level: 'ask' } } })
  assert.equal(unsupportedLevel.response.status, 400)
  assert.deepEqual(f.store.list().bots[0].computer, { scope: 'none', level: 'read', network: 'off' })

  const oldEndpoint = await f.request(`/api/bots/${id}/computer/confirm-full-machine`, { method: 'POST', body: { confirmation: 'FULL MACHINE', computer: machine } })
  assert.equal(oldEndpoint.response.status, 405)
  const enabled = await f.request(endpoint, { method: 'POST', body: { computer: machine } })
  assert.equal(enabled.response.status, 200)
  assert.deepEqual(enabled.json.bots[0].computer, machine)
  const snapshot = await f.request('/api/bots', { method: 'GET' })
  assert.equal(snapshot.response.status, 200)
  assert.deepEqual(snapshot.json.bots[0].computer, machine)
})

test('any same-origin device can enable and edit a full-access bot without pairing', async t => {
  const f = await fixture(t)
  const path = '/api/bots/bunjibox/computer/enable-full-machine'
  const computer = { scope: 'machine', level: 'auto', network: 'off' }
  const enabled = await f.request(path, { method: 'POST', body: { computer } })
  assert.equal(enabled.response.status, 200)
  assert.deepEqual(enabled.json.bots[0].computer, computer)
  const edit = await f.request('/api/bots/bunjibox', { body: { description: 'Updated from another device' } })
  assert.equal(edit.response.status, 200)
})

test('cross-origin browser writes cannot enable full access', async t => {
  const f = await fixture(t)
  const endpoint = `/api/bots/bunjibox/computer/enable-full-machine`
  const response = await new Promise((resolve, reject) => {
    const request = http.request(f.origin + endpoint, {
      method: 'POST',
      headers: { host: '127.0.0.1:4318', origin: 'http://evil.example', 'content-type': 'application/json' },
    }, result => {
      let raw = ''
      result.on('data', chunk => { raw += chunk })
      result.on('end', () => resolve({ status: result.statusCode, body: JSON.parse(raw) }))
    })
    request.on('error', reject)
    request.end(JSON.stringify({ computer: { scope: 'machine', level: 'auto', network: 'off' } }))
  })
  assert.equal(response.status, 403)
  assert.match(response.body.error, /Cross-origin/)
  assert.deepEqual(f.store.list().bots[0].computer, { scope: 'none', level: 'read', network: 'off' })
})
