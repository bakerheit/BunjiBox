import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { errorCode, errorMessage, fail } from '@bunji/shared/errors'
import type { MemoryList, MemoryNote, MemoryNoteSummary } from '@bunji/shared/types'
import { workspaceDirectory } from './bot-store.ts'

const MAX_BODY = 12000, MAX_FILE_BYTES = 128 * 1024, MAX_NOTES = 5000, SNIPPET_LENGTH = 480
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const REVISION = /^sha256:[a-f0-9]{64}$/
const FIELDS = ['id', 'title', 'revision', 'sourceMessageIds', 'createdAt', 'updatedAt'] as const
const LOCK = '.memory-write.lock'
const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex')
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Options for retiring a bot's vault together with deleting the bot. */
export interface RetireBotOptions<T extends object> {
  /** Move the notes to this bot instead of deleting them. */
  targetId?: string
  /** The `revision` of the source vault the user reviewed. */
  expectedRevision: string
  /** Deletes the bot. Runs under the vault locks, after every note is verified. */
  commit: () => T
}

/**
 * The Markdown memory vaults. All methods are async and errors carry an HTTP
 * `status`. Tool and client input is validated here, so it is `unknown`.
 */
export interface MemoryStore {
  directory: string
  list(botId: string): Promise<MemoryList>
  retireBot<T extends object>(sourceId: string, options: RetireBotOptions<T>): Promise<T & { cleanupWarning?: string }>
  read(botId: string, id: string): Promise<MemoryNote>
  /** `{ query, limit? }`: up to 10 hits, each with a snippet. */
  search(botId: string, options?: unknown): Promise<MemoryList>
  /** `{ id?, title, body, expectedRevision?, sourceMessageIds? }`. */
  write(botId: string, value: unknown): Promise<MemoryNote>
  /** `{ id, targetId, expectedRevision }`. */
  link(botId: string, value: unknown): Promise<MemoryNote>
}

interface NoteContent {
  title: string
  body: string
  sourceMessageIds: string[]
}

/** A note about to be encoded. The revision is always recomputed from the content. */
type NoteDraft = NoteContent & { id: string; createdAt: string; updatedAt: string; revision?: string }

interface ChainEntry {
  path: string
  stat: Stats
}

interface Folder {
  path: string
  chain: ChainEntry[]
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw fail(`Invalid ${label}; use 1–128 letters, digits, underscores or hyphens.`)
  return value
}

function text(value: unknown, max: number, label: string, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || (!multiline && !value.trim())) throw fail(`${label} must be text up to ${max} characters.`)
  // oxlint-disable-next-line eslint/no-control-regex -- Reject controls without modifying the user's note.
  if ((multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value)) throw fail(`${label} contains control characters.`)
  if (!value.isWellFormed()) throw fail(`${label} contains invalid Unicode.`)
  return value
}

function provenance(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw fail('sourceMessageIds must be an array of at most 100 message IDs.')
  return [...new Set(value.map(item => text(item, 200, 'Source message ID')))]
}

function rejectCredentials(value: string) {
  const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/
  const token = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/
  const assignment = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?([^\s"'`,;]{8,})/ig
  const obviousPlaceholder = /^(?:<[^>]+>|\$\{[^}]+\}|\*+|x+|redacted|placeholder|your[_-].*|example[_-].*)$/i
  if (privateKey.test(value) || token.test(value) || /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i.test(value) || [...value.matchAll(assignment)].some(match => !obviousPlaceholder.test(match[1]))) {
    throw fail('Memory notes must not contain credentials or private keys. Remove the secret before saving.')
  }
}

function content(title: unknown, body: unknown, sourceMessageIds: unknown): NoteContent {
  const cleanTitle = text(title, 200, 'Title')
  const cleanBody = text(body, MAX_BODY, 'Body', true)
  const ids = provenance(sourceMessageIds)
  rejectCredentials([cleanTitle, cleanBody, ...ids].join('\n'))
  return { title: cleanTitle, body: cleanBody, sourceMessageIds: ids }
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail('Invalid memory timestamp in frontmatter.')
  return new Date(value).toISOString()
}

function statOrNull(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
}

// Inspect every ancestor, not just the final component. Callers should pass a
// physical path (e.g. realpath(tmpdir()) in tests); symlink aliases are rejected.
function directoryChain(path: string, create = false): ChainEntry[] | null {
  const root = parse(path).root, chain: ChainEntry[] = []
  let current = root
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat = statOrNull(current)
    if (!stat && create) {
      try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
      stat = statOrNull(current)
    }
    if (!stat) return null
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Memory directories must be real directories, without symlinks.')
    chain.push({ path: current, stat })
  }
  return chain
}

function verifyChain(chain: ChainEntry[]) {
  for (const entry of chain) {
    const current = statOrNull(entry.path)
    if (!current || !current.isDirectory() || current.isSymbolicLink() || !sameFile(current, entry.stat)) throw fail('Memory directory changed during the operation; retry.', 409)
  }
}

function exactName(directory: string, name: string) {
  // Keep bot identities distinct even on a case-insensitive filesystem.
  if (readdirSync(directory).some(entry => entry !== name && entry.toLowerCase() === name.toLowerCase())) throw fail('Memory ID differs only in case from an existing path.')
}

function regularFile(stat: Stats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('Memory files must be regular files, without symbolic or hard links.')
  if (stat.size > MAX_FILE_BYTES) throw fail('Memory file is too large.')
}

function readFile(path: string, chain: ChainEntry[], checkName = true): { raw: string; stat: Stats } | null {
  verifyChain(chain)
  if (checkName) exactName(dirname(path), basename(path))
  const before = statOrNull(path)
  if (!before) return null
  regularFile(before)
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    regularFile(opened)
    if (!sameFile(before, opened)) throw fail('Memory file changed while opening it; retry.', 409)
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0, count
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count
    if (size > MAX_FILE_BYTES) throw fail('Memory file is too large.')
    const after = fstatSync(fd), current = statOrNull(path)
    verifyChain(chain)
    if (!current || !sameFile(after, current) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw fail('Memory file changed while reading it; retry.', 409)
    let raw
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)) } catch { throw fail('Memory file must be UTF-8 Markdown.') }
    return { raw, stat: after }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ELOOP' || code === 'ENOTDIR') throw fail('Memory paths must not contain symlinks.')
    if (code === 'ENOENT') throw fail('Memory file changed while reading it; retry.', 409)
    throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

// A deliberately small, non-executable YAML subset. JSON strings/arrays are
// valid YAML; plain/single-quoted strings and block string lists allow ordinary
// Obsidian property edits. Tags, anchors, objects and unknown keys are rejected.
function scalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') return parsed } catch { /* Report the same safe error below. */ }
    throw fail('Invalid quoted memory frontmatter value.')
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw fail('Invalid quoted memory frontmatter value.')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (!value || /^[!&*[{\]}>|%@`]/.test(value) || /(?:^|\s)#|:\s/.test(value)) throw fail('Unsupported memory frontmatter value; use a quoted string.')
  return value
}

function decode(raw: string, id: string, stat: Stats): MemoryNote {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match) throw fail(`Note ${id} needs simple YAML frontmatter.`)
  const metadata: Record<string, unknown> = Object.create(null), lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    const field = /^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*)$/.exec(line)
    if (!field || !(FIELDS as readonly string[]).includes(field[1]) || Object.hasOwn(metadata, field[1])) throw fail(`Note ${id} has unknown, duplicate or unsafe frontmatter.`)
    const [, key, value] = field
    if (key !== 'sourceMessageIds') metadata[key] = scalar(value)
    else if (value.trim()) {
      try { metadata[key] = JSON.parse(value) } catch { throw fail('sourceMessageIds must be a JSON array or YAML string list.') }
    } else {
      const items: string[] = []
      metadata[key] = items
      while (index + 1 < lines.length && /^[ \t]*- /.test(lines[index + 1])) items.push(scalar(lines[++index].replace(/^[ \t]*- /, '')))
    }
  }
  if (FIELDS.some(key => !Object.hasOwn(metadata, key)) || metadata.id !== id || !REVISION.test(metadata.revision as string)) throw fail(`Note ${id} has missing or invalid frontmatter; id must match its filename.`)
  const values = content(metadata.title, raw.slice(match[0].length), metadata.sourceMessageIds)
  const revision = fileRevision(raw)
  const createdAt = timestamp(metadata.createdAt), savedAt = timestamp(metadata.updatedAt)
  const updatedAt = revision === metadata.revision ? savedAt : new Date(Math.max(Date.parse(savedAt), stat.mtimeMs)).toISOString()
  return { id, ...values, revision, links: links(values.body), createdAt, updatedAt }
}

function fileRevision(raw: string): string {
  // Exclude only the self-referential revision property. Whitespace, metadata,
  // provenance and Markdown edits otherwise change the hash, even at equal mtime.
  return hash(raw.replace(/^revision:[^\r\n]*/m, 'revision: ""'))
}

function encode(note: NoteDraft): string {
  const raw = '---\n' + FIELDS.map(key => `${key}: ${JSON.stringify(key === 'revision' ? '' : note[key])}`).join('\n') + '\n---\n' + note.body
  return raw.replace('revision: ""', `revision: "${fileRevision(raw)}"`)
}

function links(body: string): string[] {
  return [...new Set([...body.matchAll(/\[\[([a-zA-Z0-9_-]{1,128})(?:\.md)?(?:#[^\]|\r\n]*)?(?:\|[^\]\r\n]*)?\]\]/g)].map(match => match[1]))]
}

function summary(note: MemoryNote): MemoryNoteSummary {
  const { body: _body, ...metadata } = note
  return metadata
}

function checkRevision(current: MemoryNote | null, expectedRevision: unknown) {
  if (!current) {
    if (expectedRevision !== undefined) throw fail('Memory note no longer exists; read it again before updating.', 409)
  } else if (expectedRevision !== current.revision) throw fail('Memory revision conflict. Read the note and retry with its current expectedRevision.', 409)
}

/**
 * Markdown-authoritative vault at directory/<botId>/<id>.md. Opening is lazy.
 * Note = { id, title, body, revision, links: string[], sourceMessageIds: string[],
 *          createdAt, updatedAt }. Dates are ISO UTC; revisions are sha256:<hex>.
 * list -> { notes: Omit<Note, 'body'>[], revision }; search -> the same envelope,
 * with a <=480-character `snippet` on each hit (default 6, hard maximum 10).
 * write requires expectedRevision for existing IDs, preserves omitted provenance,
 * and generates a UUID when id is omitted. link appends [[id|human title]].
 * Reads never rewrite files; an externally edited file's stored revision may be
 * stale until the next write. All methods are async and errors carry .status.
 * Locks serialize cooperating writers across processes. A crashed writer's
 * lock is deliberately not stolen: remove .memory-write.lock only after checking
 * its recorded PID is no longer running. External editors do not honor this lock;
 * writes recheck the source immediately before rename but cannot lock an editor.
 */
export function openMemoryStore({ directory = join(workspaceDirectory(), 'memory') }: { directory?: string } = {}): MemoryStore {
  if (typeof directory !== 'string' || !directory || directory.includes('\0') || directory.length > 4096) throw fail('Invalid memory directory.')
  const root = resolve(directory)

  function botDirectory(botId: string, create: true): Folder
  function botDirectory(botId: string, create?: boolean): Folder | null
  function botDirectory(botId: string, create = false): Folder | null {
    identifier(botId, 'bot ID')
    const parents = directoryChain(root, create)
    if (!parents) return null
    exactName(root, botId)
    const path = join(root, botId), chain = directoryChain(path, create)
    verifyChain(parents)
    if (!chain) return null
    exactName(root, botId)
    return { path, chain }
  }

  function get(folder: Folder, id: string, checkName = true): MemoryNote | null {
    const file = readFile(join(folder.path, `${id}.md`), folder.chain, checkName)
    return file ? decode(file.raw, id, file.stat) : null
  }

  function scan(botId: string): MemoryNote[] {
    const folder = botDirectory(botId)
    if (!folder) return []
    const names = readdirSync(folder.path).filter(name => !name.startsWith('.') && /\.md$/i.test(name))
    if (names.length > MAX_NOTES) throw fail(`Memory vault exceeds the ${MAX_NOTES}-note limit.`)
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw fail('Memory filenames differ only in case.')
    const notes: MemoryNote[] = []
    for (const name of names) {
      const id = identifier(name.slice(0, -3), 'note filename')
      if (!name.endsWith('.md')) throw fail('Memory note filenames must use the .md extension.')
      const note = get(folder, id, false)
      if (note) notes.push(note)
    }
    verifyChain(folder.chain)
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  const envelope = (notes: MemoryNote[]): MemoryList => ({ notes: notes.map(summary), revision: hash(JSON.stringify(notes.map(note => [note.id, note.revision]).sort((a, b) => a[0].localeCompare(b[0])))) })

  async function locked<T>(botId: string, action: (folder: Folder) => T | Promise<T>): Promise<T> {
    const folder = botDirectory(botId, true), path = join(folder.path, LOCK)
    const deadline = Date.now() + 2000
    let fd: number, owned: Stats
    for (;;) {
      verifyChain(folder.chain)
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        owned = fstatSync(fd)
        break
      } catch (error) {
        const code = errorCode(error)
        if (code !== 'EEXIST' && code !== 'ELOOP') throw error
        const existing = statOrNull(path)
        if (existing) regularFile(existing)
        if (Date.now() >= deadline) throw fail('Memory vault is busy. Retry after the writer releases .memory-write.lock.', 409)
        await delay(15 + Math.floor(Math.random() * 15))
      }
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() }) + '\n')
      fsyncSync(fd)
      return await action(folder)
    } finally {
      closeSync(fd)
      verifyChain(folder.chain)
      const current = statOrNull(path)
      if (current && sameFile(owned, current)) unlinkSync(path)
    }
  }

  function save(folder: Folder, note: NoteDraft, previous: MemoryNote | null): MemoryNote {
    const path = join(folder.path, `${note.id}.md`), raw = encode(note)
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw fail('Memory file is too large.')
    const temp = join(folder.path, `.memory-${randomUUID()}.tmp`)
    let fd: number | undefined, owned: Stats | undefined
    try {
      verifyChain(folder.chain)
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      owned = fstatSync(fd)
      writeFileSync(fd, raw, 'utf8')
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      // Check again after staging, so edits observed during a save are conflicts.
      checkRevision(get(folder, note.id), previous?.revision)
      verifyChain(folder.chain)
      renameSync(temp, path)
      const directoryFd = openSync(folder.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      return decode(raw, note.id, lstatSync(path))
    } finally {
      if (fd !== undefined) closeSync(fd)
      verifyChain(folder.chain)
      const remaining = statOrNull(temp)
      if (remaining && owned && sameFile(remaining, owned)) unlinkSync(temp)
    }
  }

  const withVaultLocks = <T>(sourceId: string, targetId: string | undefined, action: () => T | Promise<T>): Promise<T> => {
    if (!targetId) return locked(sourceId, action)
    const [first, second] = [sourceId, targetId].sort()
    return locked(first, () => locked(second, action))
  }
  function transferNotes(sourceId: string, targetId: string, source: MemoryNote[]) {
    const target = scan(targetId)
    const folder = botDirectory(targetId, true)
    const ids = new Map(source.map(note => [note.id, 'moved-' + createHash('sha256').update(`${sourceId}:${note.id}`).digest('hex').slice(0, 32)]))
    const desiredNotes: NoteDraft[] = source.map(note => {
      const id = ids.get(note.id)!
      const body = note.body.replace(/\[\[([a-zA-Z0-9_-]+)(\|[^\]]*)?\]\]/g, (match, linked: string, alias = '') => ids.has(linked) ? `[[${ids.get(linked)}${alias}]]` : match)
      return { id, title: note.title, body, sourceMessageIds: note.sourceMessageIds, createdAt: note.createdAt, updatedAt: note.updatedAt }
    })
    // Check all collisions before writing anything to the destination.
    const pending: NoteDraft[] = []
    for (const desired of desiredNotes) {
      const current = get(folder, desired.id)
      if (current) {
        if (current.title !== desired.title || current.body !== desired.body || JSON.stringify(current.sourceMessageIds) !== JSON.stringify(desired.sourceMessageIds)) throw fail('A transferred memory conflicts with an existing note. No source memories were removed.', 409)
        continue
      }
      if (Buffer.byteLength(encode(desired)) > MAX_FILE_BYTES) throw fail('A transferred memory is too large.', 409)
      pending.push(desired)
    }
    if (pending.length + target.length > MAX_NOTES) throw fail('The destination bot has too many memories for this transfer.', 409)
    for (const desired of pending) save(folder, desired, null)
  }

  return {
    directory: root,
    async list(botId) { return envelope(scan(botId)) },
    async retireBot(sourceId, { targetId, expectedRevision, commit }) {
      identifier(sourceId, 'source bot ID')
      if (targetId) identifier(targetId, 'target bot ID')
      if (targetId === sourceId) throw fail('Choose another bot for the memories.')
      if (typeof commit !== 'function') throw fail('Missing bot deletion action.')
      let committed = false, cleanupWarning: string | null = null
      const snapshot = await withVaultLocks(sourceId, targetId, async () => {
        const source = scan(sourceId)
        if (envelope(source).revision !== expectedRevision) throw fail('Memories changed. Review them again before deleting this bot.', 409)
        if (targetId && source.length) transferNotes(sourceId, targetId, source)
        const folder = botDirectory(sourceId, true)
        // Verify all source files before committing the bot deletion.
        for (const note of source) if (get(folder, note.id)?.revision !== note.revision) throw fail('A memory changed during deletion. Review it again.', 409)
        const result = commit()
        committed = true
        try {
          for (const note of source) { verifyChain(folder.chain); unlinkSync(join(folder.path, `${note.id}.md`)) }
        } catch (error) { cleanupWarning = `Old memory files could not be fully removed: ${errorMessage(error)}` }
        return result
      })
      if (committed) {
        try {
          const folder = botDirectory(sourceId)
          if (folder && readdirSync(folder.path).length === 0) rmdirSync(folder.path)
        } catch (error) { cleanupWarning = `Old memory folder could not be removed: ${errorMessage(error)}` }
      }
      return { ...snapshot, ...(cleanupWarning ? { cleanupWarning } : {}) }
    },
    async read(botId, id) {
      identifier(id, 'note ID')
      const folder = botDirectory(botId), note = folder && get(folder, id)
      if (!note) throw fail('Memory note not found.', 404)
      return note
    },
    async search(botId, options = {}) {
      if (!object(options)) throw fail('Search options must be an object.')
      const { query: rawQuery, limit = 6 } = options
      const query = text(rawQuery, 500, 'Search query', true)
      if (!Number.isInteger(limit) || (limit as number) < 1) throw fail('Search limit must be a positive integer.')
      const notes = scan(botId), result = envelope(notes), terms = [...new Set(query.toLowerCase().trim().split(/\s+/).filter(Boolean))]
      const hits = terms.length ? notes.map(note => {
        const title = note.title.toLowerCase(), body = note.body.toLowerCase()
        const score = terms.every(term => title.includes(term) || body.includes(term)) ? terms.reduce((total, term) => total + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0) : 0
        return { note, score }
      }).filter(hit => hit.score).sort((a, b) => b.score - a.score) : []
      result.notes = hits.slice(0, Math.min(10, limit as number)).map(({ note }) => {
        const positions = terms.map(term => note.body.toLowerCase().indexOf(term)).filter(position => position >= 0)
        const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 100)
        return { ...summary(note), snippet: note.body.slice(start, start + SNIPPET_LENGTH) }
      })
      return result
    },
    async write(botId, value) {
      if (!object(value) || Object.keys(value).some(key => !['id', 'title', 'body', 'expectedRevision', 'sourceMessageIds'].includes(key))) throw fail('Invalid memory write fields.')
      const id = value.id === undefined ? randomUUID() : identifier(value.id, 'note ID')
      // Reject invalid content before creating directories or acquiring a lock.
      const values = content(value.title, value.body, value.sourceMessageIds ?? [])
      if (value.sourceMessageIds === null) throw fail('sourceMessageIds must be an array.')
      if (value.expectedRevision !== undefined && (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision))) throw fail('Invalid expectedRevision.')
      return locked(botId, folder => {
        const current = get(folder, id)
        checkRevision(current, value.expectedRevision)
        if (!current && readdirSync(folder.path).filter(name => /\.md$/i.test(name)).length >= MAX_NOTES) throw fail(`Memory vault has reached its ${MAX_NOTES}-note limit.`)
        const next = { ...values, sourceMessageIds: value.sourceMessageIds === undefined && current ? current.sourceMessageIds : values.sourceMessageIds }
        if (current && current.title === next.title && current.body === next.body && JSON.stringify(current.sourceMessageIds) === JSON.stringify(next.sourceMessageIds)) return current
        const now = new Date().toISOString()
        return save(folder, { id, ...next, createdAt: current?.createdAt ?? now, updatedAt: now }, current)
      })
    },
    async link(botId, value) {
      if (!object(value) || Object.keys(value).some(key => !['id', 'targetId', 'expectedRevision'].includes(key))) throw fail('Invalid memory link fields.')
      const id = identifier(value.id, 'note ID'), targetId = identifier(value.targetId, 'target note ID')
      return locked(botId, folder => {
        const current = get(folder, id)
        if (!current) throw fail('Memory note not found.', 404)
        checkRevision(current, value.expectedRevision)
        const target = get(folder, targetId)
        if (!target) throw fail('Target memory note not found in this bot.', 404)
        if (current.links.includes(targetId)) return current
        const alias = target.title.replace(/[|[\]]/g, ' ').trim()
        const body = current.body + (current.body ? '\n\n' : '') + `[[${targetId}|${alias || targetId}]]`
        const next = content(current.title, body, current.sourceMessageIds)
        return save(folder, { ...current, ...next, updatedAt: new Date().toISOString() }, current)
      })
    },
  }
}
