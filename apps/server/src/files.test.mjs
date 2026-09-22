import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { openFileStore } from '@bunji/core/file-store'
import { createFileRoutes } from './files.mjs'
import { createRunEvents } from '@bunji/core/run-events'
import { localFileLinks, recoverFileHistory } from '@bunji/core/file-history'
import { openBotStore } from '@bunji/core/bot-store'
import { openChatStore } from '@bunji/core/chat-store'
import { createChatService } from '@bunji/core/chat-service'
import { createMemoryServer } from '@bunji/core/memory-mcp'
import { openMemoryStore } from '@bunji/core/memory-store'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

async function fixture(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'bunji-files-test-'))
  const path = join(dir, 'data', 'workspace.sqlite'), files = openFileStore({ path })
  const folder = join(dir, 'work'); await mkdir(folder)
  const computer = { scope: 'folder', folder, level: 'auto', network: 'off' }
  t.after(async () => { files.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, path, files, folder, computer }
}

test('registered files persist, deduplicate and respect agent and folder boundaries', async t => {
  const f = await fixture(t)
  const path = join(f.folder, 'plan.md'); await writeFile(path, '# Plan\n\nHello.')
  const saved = await f.files.register('alpha', 'run-1', 'plan.md', { computer: f.computer, cwd: f.folder, change: 'created' })
  assert.equal(saved.preview, 'markdown')
  assert.equal((await f.files.register('alpha', 'run-1', path, { computer: f.computer })).id, saved.id)
  assert.equal((await f.files.list('alpha')).length, 1)
  assert.equal((await f.files.list('beta')).length, 0)
  await assert.rejects(f.files.preview('beta', saved.id), error => error.status === 404)
  await assert.rejects(f.files.register('alpha', 'run-1', path, { computer: { scope: 'none' } }), error => error.status === 403)
  const outside = join(f.dir, 'outside.txt'); await writeFile(outside, 'outside')
  await assert.rejects(f.files.register('alpha', 'run-1', outside, { computer: f.computer }), error => error.status === 403)
  await symlink(outside, join(f.folder, 'escape.txt'))
  await assert.rejects(f.files.register('alpha', 'run-1', join(f.folder, 'escape.txt'), { computer: f.computer }), error => error.status === 403)
  const reopened = openFileStore({ path: f.path })
  try { assert.equal((await reopened.preview('alpha', saved.id)).text, '# Plan\n\nHello.') } finally { reopened.close() }
  await rename(path, path + '.moved')
  assert.equal((await f.files.list('alpha'))[0].available, false)
  await symlink(outside, path)
  await assert.rejects(f.files.preview('alpha', saved.id), error => error.status === 404)
})

test('HTTP serves scoped IDs, bounded previews and exact downloads without executing HTML', async t => {
  const f = await fixture(t)
  const content = '<script>alert(1)</script>' + 'x'.repeat(140000)
  const path = join(f.folder, 'a report.html'); await writeFile(path, content)
  const saved = await f.files.register('alpha', 'run-1', path, { computer: f.computer })
  const handler = createFileRoutes({ files: f.files, service: { botFor: id => { if (!['alpha', 'beta'].includes(id)) throw Object.assign(new Error('Missing bot'), { status: 404 }) } } })
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/bots`
  const preview = await (await fetch(`${base}/alpha/files/${saved.id}/preview`)).json()
  assert.equal(preview.truncated, true); assert.equal(preview.text.length, 128 * 1024)
  const download = await fetch(`${base}/alpha/files/${saved.id}/download`)
  assert.equal(await download.text(), content)
  assert.match(download.headers.get('content-disposition'), /attachment.*a%20report.html/)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.match(download.headers.get('content-security-policy'), /sandbox/)
  assert.equal((await fetch(`${base}/beta/files/${saved.id}/preview`)).status, 404)
  assert.equal((await fetch(`${base}/alpha/files?path=${encodeURIComponent(path)}`)).status, 200)
  assert.equal((await fetch(`${base}/alpha/files/${saved.id}/content`)).headers.get('content-type'), 'application/octet-stream')
  assert.equal((await fetch(`${base}/alpha/files`, { method: 'POST' })).status, 405)
})

test('Codex and Claude publish successful file changes independently of tool display limits', () => {
  const changes = [], codex = createRunEvents('codex', undefined, file => changes.push(file))
  codex.consume({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/tmp/a.md', kind: 'add' }] } })
  codex.consume({ type: 'item.completed', item: { type: 'file_change', status: 'failed', changes: [{ path: '/tmp/fail.md', kind: 'add' }] } })
  const claude = createRunEvents('claude', undefined, file => changes.push(file))
  const call = (id, path) => claude.consume({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path, content: 'hello' } }] } })
  call('good', '/tmp/b.md'); call('bad', '/tmp/no.md')
  assert.equal(changes.length, 1)
  claude.consume({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'good', content: 'written' }, { type: 'tool_result', tool_use_id: 'bad', is_error: true, content: 'denied' }] } })
  assert.deepEqual(changes.map(file => file.path), ['/tmp/a.md', '/tmp/b.md'])
})

test('shared runs index shell outputs, native edits and MCP-published files', async t => {
  const f = await fixture(t), bots = openBotStore({ path: f.path }), chats = openChatStore({ path: f.path })
  const memory = openMemoryStore({ directory: join(f.dir, 'memory') })
  bots.confirmFolder('bunjibox', f.computer)
  let outputDirectory, observed
  const service = createChatService({ bots, chats, memoryDirectory: memory.directory, memory, files: f.files, run: async (options, hooks) => {
    observed = hooks
    outputDirectory = f.files.outputDirectory(bots.list().bots.find(bot => bot.id === 'bunjibox'), hooks.requestId)
    assert.ok(options.prompt.includes(outputDirectory)); assert.match(options.prompt, /files_publish/)
    await writeFile(join(outputDirectory, 'shell-output.csv'), 'a,b\n1,2')
    await writeFile(join(f.folder, 'edited.js'), 'export const hello = true')
    hooks.onFile({ path: 'edited.js', change: 'updated' })
    const bridge = createMemoryServer({ store: memory, botId: 'bunjibox', sourceId: hooks.requestId, allowWrites: true, files: f.files, computer: f.computer, cwd: f.folder })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'file-test', version: '1.0' })
    await bridge.connect(serverTransport); await client.connect(clientTransport)
    try {
      await writeFile(join(f.folder, 'generated.txt'), 'from a shell command elsewhere')
      const response = await client.callTool({ name: 'files_publish', arguments: { path: 'generated.txt' } })
      assert.ok(!response.isError)
    } finally { await client.close(); await bridge.close() }
    const linked = join(f.folder, 'linked output.txt'); await writeFile(linked, 'Linked shell output')
    return { ok: true, text: `Done. [Download](<${linked}>)` }
  } })
  t.after(async () => { await service.close(); chats.close(); bots.close() })
  service.start('bunjibox', { id: 'run-files', prompt: 'Create files', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low' })
  for (let i = 0; i < 100 && chats.get('run-files').status === 'running'; i++) await delay(10)
  assert.equal(chats.get('run-files').status, 'complete')
  assert.equal(observed.files.path, f.path)
  assert.deepEqual((await f.files.list('bunjibox')).map(file => file.name).sort(), ['edited.js', 'generated.txt', 'linked output.txt', 'shell-output.csv'])
  assert.equal(await readFile(join(outputDirectory, 'shell-output.csv'), 'utf8'), 'a,b\n1,2')
})

test('history recovery uses completed absolute write paths and output scans ignore symlinks', async t => {
  const f = await fixture(t), bot = { id: 'alpha', computer: f.computer }
  const path = join(f.folder, 'prior.md'); await writeFile(path, 'prior')
  const linked = join(f.folder, 'spreadsheet.csv'); await writeFile(linked, 'a,b')
  const chats = { history: () => ({ hasMore: false, requests: [{ id: 'old-run', text: `[Download](<${linked}>)`, activities: [{ status: 'complete', title: 'File changes', input: JSON.stringify([{ path, kind: 'add' }, { path: 'relative.md', kind: 'add' }]) }] }] }) }
  await recoverFileHistory({ bot, chats, files: f.files })
  assert.deepEqual((await f.files.list('alpha')).map(file => file.name).sort(), ['prior.md', 'spreadsheet.csv'])
  const output = f.files.outputDirectory(bot, 'new-run'); await f.files.prepare(output, f.computer)
  await symlink(path, join(output, 'link.md')); await writeFile(join(output, 'new.txt'), 'new')
  await f.files.scan(bot, 'new-run', output)
  assert.deepEqual((await f.files.list('alpha')).map(file => file.name).sort(), ['new.txt', 'prior.md', 'spreadsheet.csv'])
})

test('attachment recovery handles spaces and encoded paths but excludes remote and bare paths', () => {
  assert.deepEqual(localFileLinks('[one](</tmp/My report.xlsx>) [two](/tmp/encoded%20name.csv) [three](file:///tmp/plot.png) [web](https://example.com/a.pdf) [remote](//example.com/a.pdf) [relative](./a.txt) Bare /tmp/private.txt'), ['/tmp/My report.xlsx', '/tmp/encoded name.csv', '/tmp/plot.png'])
})
