import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const native = fileURLToPath(new URL('../', import.meta.url))

test('native avatar generation retries, cancellation, late results and image limits', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bunji-native-generation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const imagePath = join(native, 'Sources/BunjiBoxMac/Resources/teal-bot.png')
  const image = `data:image/png;base64,${(await readFile(imagePath)).toString('base64')}`
  const runs = new Map()
  const posts = new Map()
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.method === 'POST' && request.url === '/api/avatar-generations') {
      const payload = JSON.parse(body)
      assert.match(payload.id, /^run-[0-9a-f-]{36}$/)
      const prior = runs.get(payload.id)
      if (prior) assert.equal(prior.prompt, payload.prompt)
      const run = prior ?? { ...payload, gets: 0, cancels: 0 }
      runs.set(payload.id, run)
      const attempts = posts.get(payload.prompt) ?? []
      attempts.push(payload.id)
      posts.set(payload.prompt, attempts)
      if (payload.prompt === 'create-rejected') {
        send(400, { error: 'Please revise the prompt.' })
        return
      }
      if (payload.prompt === 'server-retry' && attempts.length === 1) {
        send(503, { error: 'Response lost after starting generation.' })
        return
      }
      if (payload.prompt === 'create-retry' && attempts.length === 1) {
        response.writeHead(202).end('{')
        return
      }
      if (payload.prompt === 'transport-retry' && attempts.length === 1) {
        response.destroy()
        return
      }
      if (['cancel-retry', 'dismiss-late-result', 'tab-change-late-result'].includes(payload.prompt)) {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      const status = payload.prompt === 'terminal-failure' && attempts.length === 1 ? 'failed'
        : ['dismiss-late-result', 'tab-change-late-result', 'invalid-image'].includes(payload.prompt) ? 'complete' : 'running'
      send(202, { generation: {
        id: payload.id, status,
        image: status === 'complete' ? (payload.prompt === 'invalid-image' ? 'data:image/png;base64,broken' : image) : null,
        error: status === 'failed' ? 'Please sign in to ChatGPT through Codex.' : null,
      } })
      return
    }
    const match = request.url.match(/^\/api\/avatar-generations\/([^/]+)(\/cancel)?$/)
    const run = match && runs.get(match[1])
    assert.ok(run, `Unexpected request ${request.method} ${request.url}`)
    if (match[2]) {
      assert.equal(request.method, 'POST')
      assert.deepEqual(JSON.parse(body), {})
      run.cancels++
      if (run.prompt === 'cancel-expired') {
        send(404, { error: 'Generation not found.' })
        return
      }
      if (run.prompt === 'cancel-retry' && run.cancels === 1) {
        send(503, { error: 'Temporary cancellation failure' })
        return
      }
      send(200, { generation: { id: run.id, status: 'cancelled', image: null, error: null } })
      return
    }
    assert.equal(request.method, 'GET')
    run.gets++
    const firstRun = posts.get(run.prompt)[0] === run.id
    if (firstRun && ['poll-expired', 'poll-expired-after-retry'].includes(run.prompt)) {
      if (run.prompt === 'poll-expired-after-retry' && run.gets === 1) {
        send(503, { error: 'Service restarting.' })
      } else {
        send(404, { error: 'Generation not found.' })
      }
      return
    }
    if (run.prompt === 'poll-retry' && run.gets === 1) {
      send(503, { error: 'Temporary polling failure' })
      return
    }
    const status = run.prompt === 'keep-polling' || (run.prompt === 'cancel-expired' && firstRun) ? 'running' : 'complete'
    send(200, { generation: { id: run.id, status, image: status === 'complete' ? image : null, error: null } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const sources = ['Models.swift', 'BunjiAPI.swift', 'AvatarImageData.swift', 'AvatarGenerationStore.swift']
    .map(file => join(native, 'Sources/BunjiBoxMac', file))
  const executable = join(directory, 'avatar-generation-checks')
  await execute('swiftc', ['-swift-version', '6', ...sources,
    join(native, 'Checks/AvatarGenerationChecks.swift'), '-o', executable])
  const { stdout } = await execute(executable, [`http://127.0.0.1:${(server.address() as AddressInfo).port}`, imagePath])
  assert.match(stdout, /checks passed/)
  for (const prompt of ['create-retry', 'transport-retry', 'server-retry']) {
    assert.ok(posts.get(prompt).length >= 2)
    assert.equal(new Set(posts.get(prompt)).size, 1, `${prompt} must reuse the original ID`)
  }
  assert.equal(posts.get('poll-retry').length, 1, 'A polling retry must not create another run')
  for (const prompt of ['poll-expired', 'poll-expired-after-retry', 'cancel-expired']) {
    assert.equal(posts.get(prompt).length, 2)
    assert.equal(new Set(posts.get(prompt)).size, 2, `${prompt} must allow a fresh ID`)
  }
  assert.equal([...runs.values()].find(run => run.prompt === 'poll-expired').gets, 1)
  assert.equal([...runs.values()].find(run => run.prompt === 'poll-expired-after-retry').gets, 2)
  assert.equal([...runs.values()].find(run => run.prompt === 'cancel-expired').cancels, 1)
  const rejected = runs.get(posts.get('create-rejected')[0])
  assert.equal(rejected.gets, 0, 'Rejected creation must not be polled')
  assert.equal(rejected.cancels, 0, 'Rejected creation must not need cancellation')
  assert.notEqual(posts.get('create-corrected')[0], rejected.id)
  assert.equal(new Set(posts.get('terminal-failure')).size, 2, 'A terminal failure allows a fresh generation')
  assert.equal([...runs.values()].find(run => run.prompt === 'cancel-retry').cancels, 2)
  assert.equal([...runs.values()].find(run => run.prompt === 'dismiss-late-result').cancels, 1)
  assert.equal(new Set(posts.get('tab-change-late-result')).size, 2, 'Returning to Generate must allow a fresh run')
  assert.deepEqual([...runs.values()].filter(run => run.prompt === 'tab-change-late-result').map(run => run.cancels), [1, 0])
  assert.ok([...runs.values()].find(run => run.prompt === 'keep-polling').gets >= 10)
})
