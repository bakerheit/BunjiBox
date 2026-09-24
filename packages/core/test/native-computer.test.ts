import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { providerCommand, runProvider } from '../src/runtime.ts'
import { openBotStore } from '../src/bot-store.ts'
import { routeAutoPrompt } from '../src/mode-router.ts'
import type { ComputerProfile } from '@bunji/shared/types'
import type { CodexSession } from '../src/codex-app-server.ts'

const computer = { scope: 'machine', level: 'auto', network: 'off' } as const
const codex = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', mode: 'agent', prompt: 'Use the native fixture.' } as const
const built = process.platform === 'darwin' && existsSync(new URL('../../../experiments/computer-use-native/.build/lab/Bunji Native Lab.app/Contents/MacOS/BunjiNativeLab', import.meta.url))

test('native opt-in persists, defaults off and cannot grant machine access', () => {
  const store = openBotStore({ path: ':memory:' })
  try {
    assert.equal(store.list().bots.find(bot => bot.id === 'bunjibox').nativeComputer, 'off')
    assert.throws(() => store.patch('bunjibox', { nativeComputer: 'fixture' }), /full-machine/)
    store.confirmMachine('bunjibox', computer)
    store.patch('bunjibox', { nativeComputer: 'fixture' })
    assert.equal(store.list().bots.find(bot => bot.id === 'bunjibox').nativeComputer, 'fixture')
    assert.throws(() => store.patch('bunjibox', { nativeComputer: 'com.apple.Terminal' }), /Unsupported native/)
    store.patch('bunjibox', { computer: { scope: 'none', level: 'read', network: 'off' } })
    assert.throws(() => providerCommand(codex, { computer: store.list().bots.find(bot => bot.id === 'bunjibox').computer, nativeComputer: 'fixture' }), /confirmed full-machine/)
    store.patch('bunjibox', { nativeComputer: 'off' })
  } finally { store.close() }
})

test('native routing and explicit Chat preserve tool boundaries', () => {
  for (const provider of ['codex', 'claude']) {
    assert.equal(routeAutoPrompt(provider, 'Open Notes and write hello').mode, 'agent')
    assert.equal(routeAutoPrompt(provider, 'Use the native fixture').mode, 'agent')
  }
  const [, args] = providerCommand({ ...codex, mode: 'chat' }, { computer, nativeComputer: 'fixture' })
  assert.ok(!args.some(arg => arg.includes('bunji_native')))
  assert.throws(() => providerCommand(codex, { computer: { scope: 'folder', level: 'auto', folder: '/tmp' } as ComputerProfile, nativeComputer: 'fixture' }), /confirmed full-machine/)
})

test('both providers receive native MCP alongside memory', { skip: !built }, () => {
  const memory = { directory: '/tmp/native-test-memory', botId: 'test', sourceId: 'test', allowWrites: true }
  const [, args] = providerCommand(codex, { computer, nativeComputer: 'fixture', memory })
  assert.ok(args.includes('mcp_servers.bunji_native.required=true'))
  assert.ok(args.some(arg => arg.startsWith('mcp_servers.bunji_memory.command=')))
  const [, claude] = providerCommand({ ...codex, provider: 'claude', model: 'sonnet' }, { computer, nativeComputer: 'fixture', memory })
  const config = JSON.parse(claude[claude.indexOf('--mcp-config') + 1])
  assert.deepEqual(Object.keys(config.mcpServers), ['bunji_memory', 'bunji_native'])
  assert.equal(config.mcpServers.bunji_native.args.at(-1), 'fixture')
  assert.match(claude[claude.indexOf('--allowedTools') + 1], /mcp__bunji_native__native_act/)
})

test('native runs bypass persistent Codex and scope Claude initialization env', { skip: !built }, async () => {
  for (const provider of ['codex', 'claude'] as const) {
    let spawned
    const result = await runProvider({ ...codex, provider, model: provider === 'claude' ? 'sonnet' : codex.model }, {
      computer, nativeComputer: 'fixture', session: {} as CodexSession,
      codexAppServer: { run() { throw new Error('Must not use persistent session') } },
      spawnProcess(command, args, options) {
        spawned = options
        const child: any = new EventEmitter()
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
        queueMicrotask(() => child.emit('close', 0))
        return child
      },
    })
    assert.ok(result)
    assert.equal(spawned.env.ENABLE_TOOL_SEARCH, provider === 'claude' ? 'false' : process.env.ENABLE_TOOL_SEARCH)
  }
})
