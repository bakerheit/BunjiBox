import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { openBotStore } from '../../../packages/core/src/bot-store.mjs'
import { createBotRoutes } from '../../server/src/bots.mjs'

test('native API confirms full-machine access through the dedicated route', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bunji-native-access-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = openBotStore({ path: join(directory, 'workspace.sqlite') })
  t.after(() => store.close())
  store.create({ id: 'native-access-check', name: 'Native access test' })
  const route = createBotRoutes(store)
  const confirmations = []
  const server = createServer((request, response) => {
    if (request.url.endsWith('/computer/enable-full-machine')) confirmations.push(request.method)
    void route(request, response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const execute = promisify(execFile)
  const sources = ['../Sources/BunjiBoxMac/Models.swift', '../Sources/BunjiBoxMac/BunjiAPI.swift', 'NativeAccessChecks.swift']
    .map(file => fileURLToPath(new URL(file, import.meta.url)))
  const binary = join(directory, 'native-access-checks')
  await execute('swiftc', ['-swift-version', '6', ...sources, '-o', binary])
  const { stdout } = await execute(binary, [`http://127.0.0.1:${server.address().port}`])
  assert.match(stdout, /checks passed/)
  assert.deepEqual(confirmations, ['POST', 'POST'])
  assert.equal(store.list().bots.find(bot => bot.id === 'native-access-check').nativeComputer, 'com.apple.Notes')
})
