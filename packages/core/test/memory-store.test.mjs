import test from 'node:test'
import assert from 'node:assert/strict'
import { access, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { openMemoryStore } from '../src/memory-store.mjs'

const moduleURL = new URL('../src/memory-store.mjs', import.meta.url).href
const revision = raw => 'sha256:' + createHash('sha256').update(raw.replace(/^revision:[^\r\n]*/m, 'revision: ""')).digest('hex')
const status = code => error => error.status === code

async function fixture(t) {
  // macOS's /var and /tmp are symlink aliases; use the physical temp directory.
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'bunji-memory-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const directory = join(temp, 'memory'), store = openMemoryStore({ directory })
  return { temp, directory, store, file: (bot, id) => join(directory, bot, `${id}.md`) }
}

async function note(store, bot = 'bot-a', id = 'tea', extra = {}) {
  return store.write(bot, { id, title: 'Tea notes', body: 'Oolong tea after lunch.', ...extra })
}

test('opening and reading an empty vault are lazy; defaults respect the workspace directory', async t => {
  const { temp, directory, store } = await fixture(t)
  assert.deepEqual((await store.list('bot-a')).notes, [])
  assert.deepEqual((await store.search('bot-a', { query: 'tea' })).notes, [])
  await assert.rejects(store.read('bot-a', 'missing'), status(404))
  await assert.rejects(access(directory), { code: 'ENOENT' })
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {openMemoryStore} from ${JSON.stringify(moduleURL)};
    const store = openMemoryStore();
    console.log(store.directory);
    await store.write('default-bot', {title: 'Default vault', body: 'Workspace scoped.'});
  `], { env: { ...process.env, BUNJI_DATA_DIR: temp } })
  assert.equal(result.stdout.trim(), directory)
  assert.equal((await store.list('default-bot')).notes.length, 1)
})

test('notes round trip as editable Markdown with content revisions, provenance and private permissions', async t => {
  const { store, directory, file } = await fixture(t)
  const body = '# Tea\n\nKeep **this** text.\n\n---\nNot more frontmatter.\n'
  const saved = await store.write('bot-a', { title: 'Tea: "oolong" & 日本語', body, sourceMessageIds: ['message-1', 'message-1', 'thread:2/message:3'] })
  assert.match(saved.id, /^[a-f0-9-]{36}$/)
  assert.deepEqual(saved.sourceMessageIds, ['message-1', 'thread:2/message:3'])
  assert.equal(saved.body, body)
  assert.deepEqual(saved.links, [])
  assert.match(saved.createdAt, /^\d{4}-\d\d-\d\dT/)
  assert.equal(saved.createdAt, saved.updatedAt)
  const path = file('bot-a', saved.id), raw = await readFile(path, 'utf8')
  assert.match(raw, /^---\nid: "/)
  assert.ok(raw.includes(`revision: "${saved.revision}"`))
  assert.equal(saved.revision, revision(raw))
  assert.deepEqual(await openMemoryStore({ directory }).read('bot-a', saved.id), saved)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(directory, 'bot-a'))).mode & 0o777, 0o700)
  const listed = await store.list('bot-a')
  assert.equal(listed.notes.length, 1)
  assert.equal(listed.notes[0].body, undefined)
  assert.equal(listed.notes[0].revision, saved.revision)
  assert.deepEqual(await readdir(join(directory, 'bot-a')), [`${saved.id}.md`])
})

test('bot namespaces isolate IDs, lists, search, updates and link targets', async t => {
  const { store } = await fixture(t)
  const first = await note(store)
  const other = await note(store, 'bot-b', 'tea', { body: 'Completely separate coffee.' })
  await note(store, 'bot-b', 'only-other')
  assert.equal((await store.read('bot-a', 'tea')).body, first.body)
  assert.equal((await store.read('bot-b', 'tea')).body, other.body)
  assert.equal((await store.list('bot-a')).notes.length, 1)
  assert.equal((await store.list('bot-b')).notes.length, 2)
  assert.equal((await store.search('bot-a', { query: 'coffee' })).notes.length, 0)
  await assert.rejects(store.read('bot-a', 'only-other'), status(404))
  await assert.rejects(store.link('bot-a', { id: 'tea', targetId: 'only-other', expectedRevision: first.revision }), status(404))
  await assert.rejects(store.write('bot-b', { id: 'tea', title: first.title, body: 'Overwrite', expectedRevision: first.revision }), status(409))
  assert.deepEqual(await store.read('bot-b', 'tea'), other)
})

test('stable wikilinks retain human titles and survive renames without duplicating links', async t => {
  const { store } = await fixture(t)
  const source = await note(store, 'bot-a', 'tea', { sourceMessageIds: ['message-1'] })
  const target = await note(store, 'bot-a', 'lunch', { title: 'Lunch plans' })
  const linked = await store.link('bot-a', { id: source.id, targetId: target.id, expectedRevision: source.revision })
  assert.ok(linked.body.endsWith('[[lunch|Lunch plans]]'))
  assert.deepEqual(linked.links, ['lunch'])
  assert.deepEqual(linked.sourceMessageIds, ['message-1'])
  assert.notEqual(linked.revision, source.revision)
  assert.equal(linked.createdAt, source.createdAt)
  assert.deepEqual(await store.link('bot-a', { id: source.id, targetId: target.id, expectedRevision: linked.revision }), linked)
  await assert.rejects(store.link('bot-a', { id: source.id, targetId: target.id, expectedRevision: source.revision }), status(409))
  await assert.rejects(store.link('bot-a', { id: source.id, targetId: target.id }), status(409))
  await store.write('bot-a', { id: target.id, title: 'Dinner plans', body: target.body, expectedRevision: target.revision })
  assert.deepEqual((await store.read('bot-a', source.id)).links, ['lunch'])
  const manual = await note(store, 'bot-a', 'manual', { body: '[[lunch]] [[lunch.md|Meal]] [[tea#Heading|Tea]] [[unmade]] [[../outside]] [[bot-b/tea]]' })
  assert.deepEqual(manual.links, ['lunch', 'tea', 'unmade'])
})

test('existing notes require expectedRevision, no-op writes are stable, and provenance is explicit', async t => {
  const { store, file, directory } = await fixture(t)
  const first = await note(store, 'bot-a', 'tea', { sourceMessageIds: ['source-1'] })
  const input = { id: first.id, title: first.title, body: first.body }
  await assert.rejects(store.write('bot-a', input), status(409))
  const raw = await readFile(file('bot-a', first.id), 'utf8')
  const unchanged = await store.write('bot-a', { ...input, expectedRevision: first.revision })
  assert.deepEqual(unchanged, first)
  assert.equal(await readFile(file('bot-a', first.id), 'utf8'), raw)
  const second = await store.write('bot-a', { ...input, body: 'New facts.', expectedRevision: first.revision })
  assert.equal(second.createdAt, first.createdAt)
  assert.deepEqual(second.sourceMessageIds, ['source-1'])
  assert.notEqual(second.revision, first.revision)
  await assert.rejects(openMemoryStore({ directory }).write('bot-a', { ...input, expectedRevision: first.revision }), status(409))
  const third = await store.write('bot-a', { ...input, body: second.body, sourceMessageIds: ['source-2'], expectedRevision: second.revision })
  assert.deepEqual(third.sourceMessageIds, ['source-2'])
  assert.notEqual(third.revision, second.revision)
  await assert.rejects(store.write('bot-a', { ...input, id: 'deleted', expectedRevision: third.revision }), status(409))
})

test('read, list and search detect equal-size external edits even when the mtime is restored', async t => {
  const { store, directory, file } = await fixture(t)
  const saved = await note(store), path = file('bot-a', saved.id)
  const beforeList = await store.list('bot-a'), beforeStat = await stat(path)
  const raw = await readFile(path, 'utf8'), edited = raw.replace('Oolong', 'Jasmin')
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(raw))
  await writeFile(path, edited)
  await utimes(path, beforeStat.atime, beforeStat.mtime)
  const read = await store.read('bot-a', saved.id)
  const list = await store.list('bot-a'), search = await openMemoryStore({ directory }).search('bot-a', { query: 'jasmin' })
  assert.notEqual(read.revision, saved.revision)
  assert.equal(read.revision, revision(edited))
  assert.notEqual(list.revision, beforeList.revision)
  assert.equal(list.notes[0].revision, read.revision)
  assert.equal(search.notes[0].revision, read.revision)
  assert.match(search.notes[0].snippet, /Jasmin/)
  assert.equal((await store.search('bot-a', { query: 'oolong' })).notes.length, 0)
  await assert.rejects(store.write('bot-a', { id: saved.id, title: saved.title, body: 'Stale update', expectedRevision: saved.revision }), status(409))
  assert.equal(await readFile(path, 'utf8'), edited, 'reads and failed updates never rewrite human edits')
  const updated = await store.write('bot-a', { id: saved.id, title: saved.title, body: 'Reviewed Jasmine tea.', expectedRevision: read.revision })
  assert.equal(updated.revision, revision(await readFile(path, 'utf8')))
})

test('external metadata, provenance, additions, atomic editor saves and removals are authoritative', async t => {
  const { store, file, directory } = await fixture(t)
  const saved = await note(store), path = file('bot-a', saved.id), raw = await readFile(path, 'utf8')
  const replacement = raw.replace('title: "Tea notes"', 'title: Hand edited').replace('sourceMessageIds: []', "sourceMessageIds:\n  - 'human-source'\n  - \"another-source\"")
  const temporary = join(directory, 'bot-a', '.editor-save')
  await writeFile(temporary, replacement)
  await rename(temporary, path)
  const edited = await store.read('bot-a', saved.id)
  assert.equal(edited.title, 'Hand edited')
  assert.deepEqual(edited.sourceMessageIds, ['human-source', 'another-source'])
  assert.notEqual(edited.revision, saved.revision)
  await writeFile(file('bot-a', 'external'), raw.replace('id: "tea"', 'id: "external"'))
  assert.equal((await store.list('bot-a')).notes.length, 2)
  await rm(path)
  await assert.rejects(store.read('bot-a', saved.id), status(404))
  assert.deepEqual((await store.list('bot-a')).notes.map(item => item.id), ['external'])
})

test('search returns ranked, bounded snippets with default and hard result caps', async t => {
  const { store } = await fixture(t)
  for (let i = 0; i < 14; i++) await note(store, 'bot-a', `entry-${i}`, { title: i === 0 ? 'Rare tea' : `Note ${i}`, body: `${'Before '.repeat(150)}rare TEA ${'after '.repeat(180)}` })
  const defaults = await store.search('bot-a', { query: ' rare  tea ' })
  assert.equal(defaults.notes.length, 6)
  assert.equal(defaults.notes[0].id, 'entry-0')
  const capped = await store.search('bot-a', { query: 'RARE', limit: 1000 })
  assert.equal(capped.notes.length, 10)
  for (const hit of capped.notes) {
    assert.equal(hit.body, undefined)
    assert.ok(hit.snippet.length <= 480)
    assert.match(hit.snippet, /rare TEA/)
    assert.match(hit.revision, /^sha256:[a-f0-9]{64}$/)
  }
  assert.equal((await store.search('bot-a', { query: 'rare', limit: 1 })).notes.length, 1)
  assert.equal((await store.search('bot-a', { query: 'rare impossible' })).notes.length, 0)
  assert.equal((await store.search('bot-a', { query: '   ' })).notes.length, 0)
  for (const limit of [0, -1, 1.5, NaN, Infinity, '6', null]) await assert.rejects(store.search('bot-a', { query: 'tea', limit }), status(400))
  await assert.rejects(store.search('bot-a', { query: 'x'.repeat(501) }), status(400))
})

test('IDs reject traversal and arbitrary paths across every entry point', async t => {
  const { store, temp } = await fixture(t)
  const outside = join(temp, 'outside.md')
  await writeFile(outside, 'Keep me unchanged')
  for (const id of ['../outside', '..', '.', '/etc/passwd', 'a/b', 'a\\b', 'a.md', '%2e%2e', '', 'a\0b', 'x'.repeat(129)]) {
    await assert.rejects(store.list(id), status(400))
    await assert.rejects(store.search(id, { query: 'x' }), status(400))
    await assert.rejects(store.read('bot-a', id), status(400))
    await assert.rejects(store.write(id, { title: 'x', body: 'x' }), status(400))
    await assert.rejects(store.write('bot-a', { id, title: 'x', body: 'x' }), status(400))
    await assert.rejects(store.link('bot-a', { id: 'tea', targetId: id }), status(400))
  }
  assert.equal(await readFile(outside, 'utf8'), 'Keep me unchanged')
})

test('case collisions cannot cross bot or note namespaces on case-insensitive disks', async t => {
  const { store } = await fixture(t)
  const saved = await note(store, 'Bot', 'Tea')
  await assert.rejects(store.list('bot'), status(400))
  await assert.rejects(store.write('bot', { id: 'Tea', title: 'x', body: 'x' }), status(400))
  await assert.rejects(store.read('Bot', 'tea'), status(400))
  await assert.rejects(store.write('Bot', { id: 'tea', title: 'x', body: 'x' }), status(400))
  assert.deepEqual(await store.read('Bot', 'Tea'), saved)
})

test('symlinked vaults, ancestors, bot directories and replacements cannot escape the vault', async t => {
  const { store, temp, directory } = await fixture(t)
  const outside = join(temp, 'outside'), alias = join(temp, 'alias')
  await mkdir(outside)
  await symlink(outside, alias, 'dir')
  for (const path of [alias, join(alias, 'nested')]) {
    const unsafe = openMemoryStore({ directory: path })
    await assert.rejects(unsafe.list('bot-a'), status(400))
    await assert.rejects(note(unsafe), status(400))
  }
  await mkdir(directory)
  await symlink(outside, join(directory, 'bot-a'), 'dir')
  await assert.rejects(store.list('bot-a'), status(400))
  await assert.rejects(note(store), status(400))
  await rm(join(directory, 'bot-a'))
  await note(store)
  await rename(directory, join(temp, 'original-memory'))
  await symlink(outside, directory, 'dir')
  await assert.rejects(store.read('bot-a', 'tea'), status(400))
  await assert.rejects(note(store, 'bot-a', 'new'), status(400))
  assert.deepEqual(await readdir(outside), [])
})

test('note symlinks, dangling symlinks, hardlinks and non-regular files are rejected without changing targets', async t => {
  const { store, temp, directory, file } = await fixture(t)
  await note(store)
  const outside = join(temp, 'outside.md'), outsideRaw = await readFile(file('bot-a', 'tea'), 'utf8')
  await writeFile(outside, outsideRaw)
  for (const kind of ['symbolic', 'dangling', 'hard', 'directory']) {
    const path = file('bot-a', 'unsafe')
    if (kind === 'symbolic' || kind === 'dangling') await symlink(kind === 'symbolic' ? outside : join(temp, 'not-created'), path)
    else if (kind === 'hard') await link(outside, path)
    else await mkdir(path)
    await assert.rejects(store.read('bot-a', 'unsafe'), status(400))
    await assert.rejects(store.list('bot-a'), status(400))
    await assert.rejects(store.search('bot-a', { query: 'tea' }), status(400))
    await assert.rejects(note(store, 'bot-a', 'unsafe'), status(400))
    await rm(path, { recursive: true })
  }
  await symlink(outside, join(directory, 'bot-a', '.memory-write.lock'))
  await assert.rejects(note(store, 'bot-a', 'new'), status(400))
  assert.equal(await readFile(outside, 'utf8'), outsideRaw)
  await assert.rejects(access(join(temp, 'not-created')), { code: 'ENOENT' })
})

test('frontmatter is escaped and unsafe or corrupt external data fails closed', async t => {
  const { store, file } = await fixture(t)
  const saved = await note(store, 'bot-a', 'tea', { title: 'A: "quoted" title # heading', sourceMessageIds: ['id: "quoted"'] })
  const path = file('bot-a', saved.id), raw = await readFile(path, 'utf8')
  const corruptions = [
    raw.replace('title:', 'unknown:'),
    raw.replace('title:', '__proto__:'),
    raw.replace('title: "A:', 'id: "tea"\ntitle: "A:'),
    raw.replace(/^title:.*$/m, 'title: !!js/function >'),
    raw.replace(/^title:.*$/m, 'title: &anchor malicious'),
    raw.replace(/^title:.*$/m, 'title: *anchor'),
    raw.replace('id: "tea"', 'id: "../outside"'),
    raw.replace(/^revision:.*$/m, 'revision: "bad"'),
    raw.replace(/^sourceMessageIds:.*$/m, 'sourceMessageIds: {"__proto__": {}}'),
    raw.replace(/^createdAt:.*$/m, 'createdAt: "not a date"'),
    '---\nunclosed: true\n',
    raw + 'x'.repeat(12001),
    'x'.repeat(128 * 1024 + 1),
    Buffer.from([0xff, 0xfe, 0xfd]),
  ]
  for (const corrupted of corruptions) {
    await writeFile(path, corrupted)
    await assert.rejects(store.read('bot-a', saved.id), status(400))
  }
  await writeFile(path, raw)
  assert.deepEqual(await store.read('bot-a', saved.id), saved)
})

test('body, title, provenance and likely credentials are bounded and rejected before writes', async t => {
  const { store, directory } = await fixture(t)
  const invalid = [
    { body: 'x'.repeat(12001) }, { title: '' }, { title: 'x'.repeat(201) },
    { title: 'Injected\nrevision: fake' }, { body: 'bad\0body' }, { body: '\ud800' },
    { sourceMessageIds: ['bad\nsource'] }, { sourceMessageIds: ['x'.repeat(201)] },
    { sourceMessageIds: Array(101).fill('source') }, { sourceMessageIds: null },
    { sourceMessageIds: {} }, { revision: 'invented' },
    { body: '-----BEGIN RSA PRIVATE KEY-----\nabc' },
    { body: 'api_key=sk-proj-' + 'a'.repeat(32) },
    { body: 'github_pat_' + 'b'.repeat(40) },
    { body: 'Authorization: Bearer ' + 'c'.repeat(32) },
    { body: 'password=supersecret123' },
  ]
  for (const extra of invalid) await assert.rejects(note(store, 'bot-a', 'bad', extra), status(400))
  await assert.rejects(access(directory), { code: 'ENOENT' })
  await note(store, 'bot-a', 'discussion', { body: 'Use a password manager. api_key=YOUR_API_KEY\npassword=<redacted>' })
  const maximum = await note(store, 'bot-a', 'maximum', { body: 'x'.repeat(12000) })
  await assert.rejects(store.link('bot-a', { id: maximum.id, targetId: 'discussion', expectedRevision: maximum.revision }), status(400))
  assert.equal((await store.read('bot-a', maximum.id)).revision, maximum.revision)
})

async function writers(t, directory, saved, count = 4) {
  const workers = Array.from({ length: count }, (_, index) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {openMemoryStore} from ${JSON.stringify(moduleURL)};
      const store = openMemoryStore({directory: process.argv[1]});
      process.send('ready');
      process.once('message', async () => {
        try {
          const note = await store.write('bot-a', {id: 'tea', title: 'Tea notes', body: 'Worker ' + process.argv[2], expectedRevision: process.argv[3]});
          process.send({ok: true, revision: note.revision});
        } catch (error) { process.send({ok: false, status: error.status, message: error.message}); }
        process.disconnect();
      });
    `, directory, String(index), saved.revision], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let stderr = '', outcome
    child.stderr.on('data', chunk => { stderr += chunk })
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('message', message => message === 'ready' ? resolve() : reject(new Error('Worker did not become ready')))
      child.once('exit', code => { if (code) reject(new Error(stderr)) })
    })
    child.on('message', message => { if (typeof message === 'object') outcome = message })
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 && outcome ? resolve(outcome) : reject(new Error(`Worker failed: ${stderr}`)))
    })
    return { child, ready, done }
  })
  await Promise.all(workers.map(worker => worker.ready))
  for (const worker of workers) worker.child.send('go')
  return Promise.all(workers.map(worker => worker.done))
}

test('cross-process updates with the same revision have exactly one winner', { timeout: 15000 }, async t => {
  const { store, directory } = await fixture(t)
  const saved = await note(store)
  const results = await writers(t, directory, saved)
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.status), [409, 409, 409])
  assert.equal((await store.read('bot-a', 'tea')).revision, results.find(result => result.ok).revision)
  assert.deepEqual(await readdir(join(directory, 'bot-a')), ['tea.md'])
})

test('concurrent processes keep all distinct creations', { timeout: 15000 }, async t => {
  const { store, directory } = await fixture(t)
  await Promise.all(Array.from({ length: 3 }, (_, worker) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {openMemoryStore} from ${JSON.stringify(moduleURL)};
    const store = openMemoryStore({directory: process.argv[1]});
    for (let i = 0; i < 6; i++) await store.write('bot-a', {id: 'worker-' + process.argv[2] + '-' + i, title: 'Worker note', body: 'Complete content.'});
  `, directory, String(worker)])))
  assert.equal((await store.list('bot-a')).notes.length, 18)
  assert.equal((await readdir(join(directory, 'bot-a'))).length, 18)
})

test('writes atomically replace complete files while external readers observe them', { timeout: 15000 }, async t => {
  const { store, directory, file } = await fixture(t)
  const saved = await note(store), path = file('bot-a', saved.id), originalStat = await lstat(path)
  let complete = false, reads = 0
  const writing = promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import {openMemoryStore} from ${JSON.stringify(moduleURL)};
    const store = openMemoryStore({directory: process.argv[1]});
    let note = await store.read('bot-a', 'tea');
    for (let i = 0; i < 35; i++) note = await store.write('bot-a', {id: note.id, title: note.title, body: String(i).padStart(2, '0') + ':' + 'x'.repeat(11000), expectedRevision: note.revision});
  `, directory]).finally(() => { complete = true })
  while (!complete) {
    const raw = await readFile(path, 'utf8')
    assert.ok(raw.includes(`revision: "${revision(raw)}"`), 'each observed file has a hash for its complete content')
    assert.ok(raw.endsWith(saved.body) || /\n\d\d:x{11000}$/.test(raw))
    reads++
  }
  await writing
  assert.ok(reads > 1)
  assert.notEqual((await lstat(path)).ino, originalStat.ino)
  assert.ok((await store.read('bot-a', 'tea')).body.startsWith('34:'))
  assert.deepEqual(await readdir(join(directory, 'bot-a')), ['tea.md'])
})

test('an existing lock fails with a bounded conflict, is not stolen, and only blocks its bot', { timeout: 6000 }, async t => {
  const { store, directory } = await fixture(t)
  const saved = await note(store), lock = join(directory, 'bot-a', '.memory-write.lock')
  const owner = JSON.stringify({ pid: process.pid, token: 'other-writer' })
  await writeFile(lock, owner)
  assert.deepEqual(await store.read('bot-a', saved.id), saved)
  await note(store, 'bot-b')
  await assert.rejects(store.write('bot-a', { id: saved.id, title: saved.title, body: 'Blocked', expectedRevision: saved.revision }), status(409))
  assert.equal(await readFile(lock, 'utf8'), owner)
  assert.deepEqual(await store.read('bot-a', saved.id), saved)
})

test('a failed atomic rename preserves the original and cleans up its own temporary file and lock', async t => {
  const { store, directory, file } = await fixture(t)
  const saved = await note(store), path = file('bot-a', saved.id), raw = await readFile(path, 'utf8')
  const original = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path) throw Object.assign(new Error('Injected rename failure'), { code: 'EIO' })
    return original(from, to)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(store.write('bot-a', { id: saved.id, title: saved.title, body: 'Must not commit', expectedRevision: saved.revision }), { code: 'EIO' })
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  assert.equal(await readFile(path, 'utf8'), raw)
  assert.deepEqual(await store.read('bot-a', saved.id), saved)
  assert.deepEqual(await readdir(join(directory, 'bot-a')), ['tea.md'])
})

test('an external edit during staging is detected before commit and preserved', async t => {
  const { store, directory, file } = await fixture(t)
  const saved = await note(store), path = file('bot-a', saved.id), raw = await readFile(path, 'utf8')
  const edited = raw.replace('Oolong tea after lunch.', 'A human changed this while the save was staged.')
  const original = fs.fsyncSync
  let calls = 0
  const mock = t.mock.method(fs, 'fsyncSync', fd => {
    original(fd)
    if (++calls === 2) fs.writeFileSync(path, edited) // Lock flush, then staged-note flush.
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(store.write('bot-a', { id: saved.id, title: saved.title, body: 'Stale replacement', expectedRevision: saved.revision }), status(409))
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
  assert.ok(calls >= 2)
  assert.equal(await readFile(path, 'utf8'), edited)
  assert.notEqual((await store.read('bot-a', saved.id)).revision, saved.revision)
  assert.deepEqual(await readdir(join(directory, 'bot-a')), ['tea.md'])
})
