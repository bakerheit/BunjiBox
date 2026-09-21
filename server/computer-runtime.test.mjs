import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { homedir } from 'node:os'
import { computerExecution, providerCommand, runProvider } from '../core/runtime.mjs'

const codex = { provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', prompt: 'List the files.' }

test('folder policies map to an explicit Codex sandbox and working directory', () => {
  const read = computerExecution({ scope: 'folder', level: 'read', folder: '/private/tmp/bunji-safe', network: 'off' })
  assert.deepEqual(read, { sandbox: 'read-only', cwd: '/private/tmp/bunji-safe', machineAccess: true })
  const policy = { scope: 'folder', level: 'auto', folder: '/private/tmp/bunji-safe', network: 'off' }
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
  const child = new EventEmitter()
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
