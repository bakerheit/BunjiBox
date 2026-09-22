import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { openBotStore } from '../../../packages/core/src/bot-store.mjs'
import { createBotRoutes } from '../../server/src/bots.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))

test('Swift profile requests persist through the real bot API', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bunji-native-profile-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = openBotStore({ path: join(directory, 'workspace.sqlite') })
  t.after(() => store.close())
  store.create({ id: 'native-profile-check', name: 'Original name' })
  const route = createBotRoutes(store)
  const server = createServer((request, response) => void route(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const sources = ['Models.swift', 'BunjiAPI.swift', 'AvatarImageData.swift']
    .map(file => resolve(root, 'macos/Sources/BunjiBoxMac', file))
  const executable = join(directory, 'profile-checks')
  await execute('swiftc', ['-swift-version', '6', ...sources,
    resolve(root, 'macos/Checks/ProfileChecks.swift'), '-o', executable])
  const { stdout } = await execute(executable, [`http://127.0.0.1:${server.address().port}`,
    resolve(root, 'app/public/teal-bot.png')])
  assert.match(stdout, /checks passed/)
  assert.equal(store.list().bots.find(bot => bot.id === 'native-profile-check').avatar.image, null)
})
