import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const native = fileURLToPath(new URL('../', import.meta.url))

test('native message Markdown preserves blocks/code, rejects unsafe links, and keeps avatar bubbles readable', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bunji-native-markdown-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sources = ['MessageMarkdown.swift', 'MessageBubbleColors.swift']
    .map(file => join(native, 'Sources/BunjiBoxMac', file))
  const executable = join(directory, 'message-formatting-checks')
  await execute('swiftc', ['-swift-version', '6', ...sources,
    join(native, 'Checks/MessageFormattingChecks.swift'), '-o', executable])
  const { stdout } = await execute(executable)
  assert.match(stdout, /checks passed/)
  assert.match(stdout, /Minimum tested body\/metadata contrast:/)
})
