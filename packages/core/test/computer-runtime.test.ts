import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { homedir } from 'node:os'
import { computerExecution, providerCommand, runProvider } from '../src/runtime.ts'
import type { ChatMessage } from '@bunji/shared/types'

const codex = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', prompt: 'List the files.' } as const

test('folder policies map to an explicit Codex sandbox and working directory', () => {
  const read = computerExecution({ scope: 'folder', level: 'read', folder: '/private/tmp/bunji-safe', network: 'off' })
  assert.deepEqual(read, { sandbox: 'read-only', cwd: '/private/tmp/bunji-safe', machineAccess: true })
  const policy = { scope: 'folder', level: 'auto', folder: '/private/tmp/bunji-safe', network: 'off' } as const
  const write = computerExecution(policy)
  assert.deepEqual(write, { sandbox: 'workspace-write', cwd: '/private/tmp/bunji-safe', machineAccess: true })
  const [, args] = providerCommand(codex, { computer: policy })
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write')
  assert.equal(args[args.indexOf('--cd') + 1], '/private/tmp/bunji-safe')
  assert.ok(!args.includes('danger-full-access'))
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('ask stays blocked while confirmed full-Mac selects unrestricted provider modes', () => {
  assert.throws(() => computerExecution({ scope: 'folder', level: 'ask', folder: '/private/tmp/bunji-safe', network: 'ask' }), /old Ask mode/)
  assert.throws(() => computerExecution({ scope: 'machine', level: 'ask', network: 'off' }), /Reconfirm/)
  assert.deepEqual(computerExecution({ scope: 'machine', level: 'auto', network: 'off' }), { sandbox: 'danger-full-access', cwd: homedir(), machineAccess: true })
  const [, codexArgs] = providerCommand(codex, { computer: { scope: 'machine', level: 'auto', network: 'off' } })
  assert.equal(codexArgs[codexArgs.indexOf('--sandbox') + 1], 'danger-full-access')
  assert.ok(codexArgs.includes('approval_policy="never"'))
  const [, claudeArgs] = providerCommand({ ...codex, provider: 'claude', model: 'haiku' }, { computer: { scope: 'machine', level: 'auto', network: 'off' } })
  assert.ok(claudeArgs.includes('--dangerously-skip-permissions'))
  assert.equal(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1], 'bypassPermissions')
  assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], 'default')
  assert.throws(() => providerCommand({ ...codex, provider: 'claude', model: 'haiku' }, { computer: { scope: 'folder', level: 'read', folder: '/private/tmp/bunji-safe', network: 'off' } }), /currently available through Codex/)
})

test('the trusted folder is also the child process working directory', async () => {
  const child: any = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
  let launch
  const result = runProvider(codex, {
    computer: { scope: 'folder', level: 'auto', folder: '/private/tmp/bunji-safe', network: 'off' },
    spawnProcess(command, args, options) {
      launch = { command, args, options }
      queueMicrotask(() => { child.stdout.end(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n'); child.emit('close', 0) })
      return child
    },
  })
  assert.equal((await result).ok, true)
  assert.equal(launch.options.cwd, '/private/tmp/bunji-safe')
})

test('Chat mode removes Bunji and machine tools while Agent mode keeps the existing harness', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'You are Chip2.' }, { role: 'user', content: 'Hello' }]
  const [, codexChat] = providerCommand({ ...codex, mode: 'chat' }, { messages, computer: { scope: 'machine', level: 'auto', network: 'off' }, memory: { directory: '/tmp/nope', botId: 'chip2', sourceId: 'run', allowWrites: true } })
  assert.ok(codexChat.includes('--ignore-user-config'))
  assert.ok(codexChat.includes('--ignore-rules'))
  assert.ok(codexChat.includes('project_doc_max_bytes=0'))
  assert.ok(codexChat.includes('shell_tool'))
  assert.equal(codexChat[codexChat.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(!codexChat.some(value => String(value).includes('bunji_memory')))
  assert.ok(!codexChat.includes('danger-full-access'))

  const [, claudeChat] = providerCommand({ ...codex, provider: 'claude', model: 'haiku', mode: 'chat' }, { messages })
  assert.ok(claudeChat.includes('--safe-mode'))
  assert.ok(claudeChat.includes('--disable-slash-commands'))
  assert.equal(claudeChat[claudeChat.indexOf('--tools') + 1], '')
  assert.equal(claudeChat[claudeChat.indexOf('--system-prompt') + 1], 'You are Chip2.')
  assert.throws(() => providerCommand({ provider: 'openrouter', model: 'openrouter/free', effort: 'low', prompt: 'hello', mode: 'agent' }), /mode is not supported/)
})
