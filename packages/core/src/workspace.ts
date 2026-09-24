// Where the workspace lives. Kept free of node:sqlite so clients can resolve
// paths without loading the database driver.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const workspaceDirectory = (): string => process.env.BUNJI_DATA_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bunji')
export const workspacePath = (): string => join(workspaceDirectory(), 'workspace.sqlite')
