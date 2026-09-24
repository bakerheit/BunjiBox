import test from 'node:test'
import assert from 'node:assert/strict'
import { BUNJI_CODEX_DISABLED_FEATURES, bunjiCodexProfileArgs } from '../src/codex-profile.ts'

test('Bunji Codex profile isolates host configuration using stable CLI controls', () => {
  const args = bunjiCodexProfileArgs()
  assert.equal(args[0], '--ignore-user-config')
  assert.deepEqual(args.slice(1), BUNJI_CODEX_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]))
  assert.ok(BUNJI_CODEX_DISABLED_FEATURES.includes('plugins'))
  assert.ok(BUNJI_CODEX_DISABLED_FEATURES.includes('memories'))
  assert.ok(!args.includes('skip_host_skill_discovery'))
  assert.ok(!args.includes('--profile'))
})

test('each call returns a fresh argument list', () => {
  const first = bunjiCodexProfileArgs()
  first.push('--bad-flag')
  assert.ok(!bunjiCodexProfileArgs().includes('--bad-flag'))
})
