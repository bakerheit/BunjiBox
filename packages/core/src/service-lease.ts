import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { errorCode, fail } from '@bunji/shared/errors'
import { workspaceDirectory } from './bot-store.ts'

const FILE = '.service-lease.sqlite'
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

/** The running service's exclusive hold on a workspace. */
export interface ServiceLease {
  /** The physical (symlink-resolved) workspace directory. */
  readonly directory: string
  /** The lease file. */
  readonly path: string
  /** Idempotent. */
  release(): void
}

function stat(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error }
}

function regularFile(path: string): Stats | null {
  const info = stat(path)
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) {
    throw fail('The service lease and its SQLite sidecars must be regular files without symbolic or hard links.', 400, 'BUNJI_UNSAFE_SERVICE_LEASE')
  }
  return info
}

/**
 * Acquire the workspace's single service-owner lease, independent of API port.
 * Synchronous; defaults to workspaceDirectory(). Returns a physical `directory`,
 * the lease-file `path`, and an idempotent `release()` method. Keep the returned
 * object alive for the entire service lifetime. A competing owner throws an Error
 * with status=409 and code='BUNJI_WORKSPACE_IN_USE', without waiting or recovering
 * any chat requests. The lease never opens or locks workspace.sqlite.
 *
 * Integration: acquire BEFORE opening stores/recovering interrupted requests;
 * release AFTER stopping HTTP, draining provider work and closing stores. Release
 * on startup failure as well. No signal handlers are installed by this module.
 * The OS releases ownership on process exit, including SIGKILL, without PID files,
 * expiry timers or stale-lock stealing. Never unlink/replace the lease file while
 * a service could be alive: its inode, not the filename, is the lock identity.
 */
export function acquireServiceLease({ directory = workspaceDirectory() }: { directory?: string } = {}): ServiceLease {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0') || directory.length > 4096) {
    throw fail('Invalid service workspace directory.', 400, 'BUNJI_INVALID_WORKSPACE')
  }
  mkdirSync(resolve(directory), { recursive: true, mode: 0o700 })
  // Aliases of the same workspace must contend for the same physical lock file.
  const physical = realpathSync(resolve(directory)), directoryStat = lstatSync(physical)
  const path = join(physical, FILE)
  for (const suffix of ['', '-journal', '-wal', '-shm']) regularFile(path + suffix)

  // Reserve a new file privately. Never open-and-close an EXISTING lock file
  // outside SQLite: closing an unrelated fd can release POSIX process locks.
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)) }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
  const original = regularFile(path)
  if (!original) throw fail('Service lease file changed during acquisition; retry.', 409, 'BUNJI_SERVICE_LEASE_CHANGED')

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path)
    // An exclusive transaction on this separate coordination file lasts for the
    // service lifetime. Competing SQLite connections/processes fail immediately;
    // normal bot/chat SQLite transactions use a different file and stay unlocked.
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
    const current = regularFile(path), currentDirectory = lstatSync(physical)
    if (!current || !sameFile(original, current) || !currentDirectory.isDirectory() || !sameFile(directoryStat, currentDirectory)) {
      throw fail('Service lease path changed during acquisition; retry.', 409, 'BUNJI_SERVICE_LEASE_CHANGED')
    }
    chmodSync(path, 0o600)
  } catch (error) {
    db?.close()
    // SQLITE_BUSY (5) or SQLITE_LOCKED (6), in the primary result code.
    const errcode = (error as { errcode?: unknown } | null)?.errcode
    if (typeof errcode === 'number' && [5, 6].includes(errcode & 0xff)) {
      throw fail('This workspace already has a running Bunji service. Use its API port or stop it before starting another.', 409, 'BUNJI_WORKSPACE_IN_USE')
    }
    throw error
  }

  let released = false
  return Object.freeze({
    directory: physical,
    path,
    release() {
      if (released) return
      db!.close() // Rolls back the lock-only transaction and releases the OS lock.
      released = true
    },
  })
}
