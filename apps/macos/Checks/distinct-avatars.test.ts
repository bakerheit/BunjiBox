import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distinctAvatarShapes } from '../../../packages/shared/src/avatars.ts'

test('compiled Swift silhouettes, labels and aperture positions match the shared web catalog', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bunji-avatar-check-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const execute = promisify(execFile)
  const binary = join(directory, 'avatar-check')
  await execute('swiftc', ['-swift-version', '6',
    fileURLToPath(new URL('../Sources/BunjiBoxMac/DistinctAvatarShapes.swift', import.meta.url)),
    fileURLToPath(new URL('./DistinctAvatarChecks.swift', import.meta.url)), '-o', binary])
  const { stdout } = await execute(binary)
  const expected = distinctAvatarShapes.map(({ name, label, cx, cy, path }) => ({
    name, label, cx, cy,
    commands: path.match(/[MLQCZ][^MLQCZ]*/g).map(command => {
      const [op, ...values] = command.trim().split(/\s+/)
      return [op, ...values.map(Number)]
    }),
  }))
  assert.deepEqual(JSON.parse(stdout), expected)
})
