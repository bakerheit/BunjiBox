import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export const computerScopes = ['none', 'folder', 'machine']
export const computerLevels = ['read', 'ask', 'auto']
export const computerNetworks = ['off', 'ask']
export const defaultComputerProfile = Object.freeze({ scope: 'none', level: 'read', network: 'off' })

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const fail = message => { throw new Error(message) }

function protectedDirectories(workspaceRoot) {
  return new Set(['/', homedir(), workspaceRoot]
    .filter(Boolean)
    .flatMap(path => {
      const absolute = resolve(path)
      try { return [absolute, realpathSync.native(absolute)] }
      catch { return [absolute] }
    }))
}

function folderValue(folder, workspaceRoot) {
  if (typeof folder !== 'string' || !isAbsolute(folder) || folder !== resolve(folder)) fail('Computer folder must be an absolute local directory path.')
  let stat, actual
  try {
    stat = lstatSync(folder)
    actual = realpathSync.native(folder)
  } catch { fail('Computer folder must exist and be a real directory.') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || actual !== folder) fail('Computer folder must be a real directory path without symbolic links.')
  if (protectedDirectories(workspaceRoot).has(folder)) fail('Computer folder cannot be a broad root, home directory, or workspace root.')
  return folder
}

function profileInput(value, { complete }) {
  if (!object(value)) fail('Computer settings must be an object.')
  const allowed = ['scope', 'level', 'folder', 'network']
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Unknown computer setting.')
  if (complete && ['scope', 'level', 'network'].some(key => !own(value, key))) fail('Computer settings must include scope, level, and network.')
  return value
}

/**
 * Validates one durable computer-access profile. Folder changes can be partial
 * when `current` is supplied, but a folder can never be inferred from a missing
 * value and a non-folder profile never retains a folder.
 */
export function computerProfile(value, {
  current = defaultComputerProfile,
  complete = false,
  workspaceRoot = process.cwd(),
  machineLevel = 'auto',
} = {}) {
  const input = profileInput(value, { complete })
  const scope = input.scope ?? current.scope
  const candidate = { ...current, ...input }
  if (!computerScopes.includes(scope)) fail('Computer scope must be none, folder, or machine.')
  if (!computerLevels.includes(candidate.level)) fail('Computer level must be read, ask, or auto.')
  if (!computerNetworks.includes(candidate.network)) fail('Computer network must be off or ask.')
  if (scope === 'machine' && candidate.level !== machineLevel) fail(`Machine scope currently requires level ${JSON.stringify(machineLevel)}.`)

  if (scope !== 'folder') {
    if (own(input, 'folder')) fail('Computer folder is only allowed when scope is folder.')
    return { scope, level: candidate.level, network: candidate.network }
  }
  if (typeof candidate.folder !== 'string') fail('Folder scope requires an explicit computer folder.')
  return { scope, level: candidate.level, folder: folderValue(candidate.folder, workspaceRoot), network: candidate.network }
}

// Existing SQLite records predate computer access. Bad persisted data also
// resolves fail-closed, so a stale path can never become usable access.
export function storedComputerProfile(value, options) {
  if (value === undefined) return { ...defaultComputerProfile }
  try { return computerProfile(value, { ...options, complete: true }) }
  catch { return { ...defaultComputerProfile } }
}

export function machineComputerProfile(value, options) {
  const profile = computerProfile(value, { ...options, complete: true })
  if (profile.scope !== 'machine') fail('Full-machine access requires scope machine.')
  return profile
}
