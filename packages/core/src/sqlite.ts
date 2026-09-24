// Shared setup for the stores that live in workspace.sqlite. Each store keeps
// its own connection; this module only removes the repeated open/transaction
// boilerplate. The service lease uses a separate lock file and opens its own.
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Open a workspace SQLite file: a private (0700) parent directory, a 0600
 * database file, a 5s busy timeout and WAL journaling, then `schema`. The
 * optional `migrate` step runs after the schema. If any step throws, the
 * connection is closed before the error propagates. ':memory:' skips the
 * filesystem steps.
 */
export function openWorkspaceDatabase(path: string, schema: string, migrate?: (db: DatabaseSync) => void): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  try {
    if (path !== ':memory:') chmodSync(path, 0o600)
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
    db.exec(schema)
    migrate?.(db)
  } catch (error) { db.close(); throw error }
  return db
}

/**
 * Run `action` in one short transaction. Writers take the write lock up front
 * (BEGIN IMMEDIATE) so concurrent connections wait on busy_timeout instead of
 * failing on lock upgrade; readers use a deferred BEGIN for a consistent view.
 */
export function transaction<T>(db: DatabaseSync, action: () => T, { write = true }: { write?: boolean } = {}): T {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try { const result = action(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
