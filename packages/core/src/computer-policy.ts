import { homedir } from 'node:os'
import type { ComputerProfile } from '@bunji/shared/types'

/** The Codex sandbox modes Bunji selects. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/** How a saved computer policy runs: sandbox, working directory, and whether the machine is reachable at all. */
export interface ComputerExecution {
  sandbox: CodexSandbox
  cwd: string | null
  machineAccess: boolean
}

// The browser never supplies this configuration for a run. It comes from the
// bot record after the server has validated the saved computer policy.
//
// Ask-before-changing remains blocked until Bunji can relay approvals. Full
// machine is a separate, explicitly confirmed, unrestricted policy.
export function computerExecution(computer?: ComputerProfile | null): ComputerExecution {
  const access: ComputerProfile = computer || { scope: 'none', level: 'read', network: 'off' }
  if (access.scope === 'none') return { sandbox: 'read-only', cwd: null, machineAccess: false }
  if (access.scope === 'machine') {
    if (access.level !== 'auto') throw new Error('Reconfirm This Mac access in Settings to enable full access.')
    return { sandbox: 'danger-full-access', cwd: homedir(), machineAccess: true }
  }
  if (access.scope !== 'folder' || typeof access.folder !== 'string' || !access.folder) throw new Error('This bot has an invalid computer folder. Re-select the folder in Settings.')
  if (access.level === 'ask') throw new Error('The old Ask mode cannot run here. Select Read only or Allow changes for this folder in Settings.')
  if (access.level === 'read') return { sandbox: 'read-only', cwd: access.folder, machineAccess: true }
  if (access.level === 'auto') return { sandbox: 'workspace-write', cwd: access.folder, machineAccess: true }
  throw new Error('This bot has an invalid computer permission level.')
}
