import { constants } from 'node:fs'
import { mkdir, realpath, stat, open, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { workspacePath } from './workspace.ts'
import { validId } from '@bunji/shared/bots'
import { errorCode, errorStatus, fail } from '@bunji/shared/errors'
import type { AgentFile, Bot, ComputerProfile, FileChange, FilePreview, FilePreviewKind } from '@bunji/shared/types'
import { openWorkspaceDatabase } from './sqlite.ts'

const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part) }
const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.sh', '.sql', '.log', '.svg', '.rs', '.go', '.java', '.c', '.h', '.cpp'])
const images: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }

export interface FileType {
  extension: string
  preview: FilePreviewKind
  mime: string
}

export function fileType(path: string): FileType {
  const extension = extname(path).toLowerCase()
  return { extension: extension.slice(1), preview: images[extension] ? 'image' : ['.md', '.markdown'].includes(extension) ? 'markdown' : textExtensions.has(extension) ? 'text' : 'none', mime: images[extension] || 'application/octet-stream' }
}

type FileRow = {
  id: string
  bot_id: string
  path: string
  source_id: string
  updated_at: number
  size: number
  change_kind: FileChange
}

const publicFile = (row: FileRow): AgentFile => ({ id: row.id, name: basename(row.path), path: row.path, sourceId: row.source_id, updatedAt: row.updated_at, size: row.size, change: row.change_kind, ...fileType(row.path) })

/** The saved-bot fields that decide where and whether files may be published. */
export type FileBot = Pick<Bot, 'id' | 'computer'>

export interface RegisterOptions {
  computer?: ComputerProfile | null
  /** Resolves relative paths. Without it, only absolute paths are accepted. */
  cwd?: string
  change?: FileChange
}

/**
 * Agent files per bot. File IDs are the only public handles; paths come from
 * trusted run hooks or the bot-scoped MCP tool. Errors carry an HTTP `status`.
 */
export interface FileStore {
  path: string
  /** The default output folder for a run, or null when the bot cannot write files. */
  outputDirectory(bot: FileBot, sourceId: string): string | null
  /** Creates the output folder after checking it stays inside a folder-scoped bot's workspace. */
  prepare(directory: string | null | undefined, computer: ComputerProfile): Promise<void>
  /** Records a file. Returns null for `change: 'deleted'`. */
  register(botId: string, sourceId: string, filePath: unknown, options?: RegisterOptions): Promise<AgentFile | null>
  list(botId: string): Promise<AgentFile[]>
  /** Opens a registered file without following symlinks. The caller must close `handle`. */
  open(botId: string, id: string): Promise<{ file: AgentFile; handle: FileHandle }>
  preview(botId: string, id: string): Promise<FilePreview>
  /** Registers every regular file under an output directory. */
  scan(bot: FileBot, sourceId: string, directory: string | null | undefined): Promise<void>
  close(): void
}

// File IDs are the only public handles. Paths are registered by trusted run
// hooks or the bot-scoped MCP tool, never supplied to a download endpoint.
export function openFileStore({ path = workspacePath() }: { path?: string } = {}): FileStore {
  const db = openWorkspaceDatabase(path, `
    CREATE TABLE IF NOT EXISTS agent_files (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, path TEXT NOT NULL,
      source_id TEXT NOT NULL, updated_at INTEGER NOT NULL, size INTEGER NOT NULL,
      change_kind TEXT NOT NULL, UNIQUE(bot_id,path));
    CREATE INDEX IF NOT EXISTS agent_files_bot ON agent_files(bot_id,updated_at);`)
  const rowFor = (botId: string, id: string) => db.prepare('SELECT * FROM agent_files WHERE bot_id=? AND id=?').get(botId, id) as FileRow | undefined
  const store: FileStore = {
    path,
    outputDirectory(bot, sourceId) {
      if (!validId(bot.id) || !validId(sourceId)) throw fail('Invalid file scope.')
      if (bot.computer?.level !== 'auto' || !['folder', 'machine'].includes(bot.computer?.scope)) return null
      const root = bot.computer.scope === 'folder' ? join(bot.computer.folder, '.bunji', 'outputs') : join(dirname(path), 'outputs')
      return join(root, bot.id, sourceId)
    },
    async prepare(directory, computer) {
      if (!directory) return
      // Check existing ancestors before creating folders, including symlinks.
      if (computer.scope === 'folder') {
        const root = await realpath(computer.folder)
        let parent = directory
        while (true) {
          try { if (!inside(root, await realpath(parent))) throw fail('Output folder leaves the selected workspace.', 403); break }
          catch (error) { if (errorCode(error) !== 'ENOENT') throw error; parent = dirname(parent) }
        }
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
    },
    async register(botId, sourceId, filePath, { computer, cwd, change = 'updated' } = {}) {
      if (!validId(botId) || !validId(sourceId)) throw fail('Invalid file scope.')
      if (computer?.level !== 'auto' || !['machine', 'folder'].includes(computer?.scope)) throw fail('This agent cannot publish computer files with its current access.', 403)
      if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || /\p{Cc}/u.test(filePath)) throw fail('Invalid file path.')
      if (!isAbsolute(filePath) && !cwd) throw fail('Use an absolute file path.')
      const candidate = resolve(cwd || '.', filePath)
      if (change === 'deleted') { db.prepare('DELETE FROM agent_files WHERE bot_id=? AND path=?').run(botId, candidate); return null }
      const physical = await realpath(candidate)
      if (computer.scope === 'folder' && !inside(await realpath(computer.folder), physical)) throw fail('File is outside this agent’s folder.', 403)
      const info = await stat(physical)
      if (!info.isFile()) throw fail('Only regular files can be shown.')
      const previous = db.prepare('SELECT * FROM agent_files WHERE bot_id=? AND path=?').get(botId, physical) as FileRow | undefined
      // Polling a dedicated output directory must not shuffle unchanged files.
      if (previous && previous.size === info.size && previous.updated_at === Math.trunc(info.mtimeMs)) return publicFile(previous)
      const id = previous?.id || randomUUID()
      db.prepare(`INSERT INTO agent_files(id,bot_id,path,source_id,updated_at,size,change_kind) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(bot_id,path) DO UPDATE SET source_id=excluded.source_id,updated_at=excluded.updated_at,size=excluded.size,change_kind=excluded.change_kind`)
        .run(id, botId, physical, sourceId, Math.trunc(info.mtimeMs), info.size, change)
      return publicFile(rowFor(botId, id)!)
    },
    async list(botId) {
      const rows = db.prepare('SELECT * FROM agent_files WHERE bot_id=? ORDER BY updated_at DESC,id').all(botId) as FileRow[]
      return Promise.all(rows.map(async row => {
        try {
          const physical = await realpath(row.path), info = await stat(physical)
          const available = physical === row.path && info.isFile()
          return { ...publicFile(row), available, ...(available ? { size: info.size, updatedAt: Math.trunc(info.mtimeMs) } : {}) }
        } catch { return { ...publicFile(row), available: false } }
      }))
    },
    async open(botId, id) {
      const row = rowFor(botId, id)
      if (!row) throw fail('File not found for this agent.', 404)
      let handle: FileHandle | undefined
      try {
        if (await realpath(row.path) !== row.path) throw fail('File moved or is no longer available.', 404)
        handle = await open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const info = await handle.stat()
        const current = await stat(row.path)
        if (!info.isFile() || await realpath(row.path) !== row.path || current.ino !== info.ino || current.dev !== info.dev) throw fail('File is no longer available.', 404)
        return { file: { ...publicFile(row), size: info.size, updatedAt: Math.trunc(info.mtimeMs) }, handle }
      } catch (error) { await handle?.close(); throw errorStatus(error) ? error : fail('File moved or is no longer available.', 404) }
    },
    async preview(botId, id) {
      const { file, handle } = await store.open(botId, id)
      try {
        if (!['text', 'markdown'].includes(file.preview)) return { file, text: null, truncated: false }
        const buffer = Buffer.alloc(Math.min(file.size, 128 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const content = buffer.subarray(0, bytesRead)
        if (content.includes(0)) return { file: { ...file, preview: 'none' }, text: null, truncated: false }
        return { file, text: content.toString('utf8'), truncated: file.size > bytesRead }
      } finally { await handle.close() }
    },
    async scan(bot, sourceId, directory) {
      if (!directory) return
      const root = await realpath(directory)
      let seen = 0
      const walk = async (folder: string, depth = 0): Promise<void> => {
        if (depth > 16 || seen >= 5000) return
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (++seen > 5000) break
          const file = join(folder, entry.name)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) await walk(file, depth + 1)
          else if (entry.isFile()) {
            try {
              if (inside(root, await realpath(file))) await store.register(bot.id, sourceId, file, { computer: bot.computer, change: 'created' })
            } catch { /* A tool can rename or remove a file during a scan. */ }
          }
        }
      }
      await walk(root)
    },
    close() { db.close() },
  }
  return store
}
