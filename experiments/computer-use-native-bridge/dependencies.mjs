import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

// Worktrees can reuse an existing checkout's dependencies without installing.
const root = process.env.BUNJI_NATIVE_DEPENDENCY_ROOT
if (root && !isAbsolute(root)) throw new Error('BUNJI_NATIVE_DEPENDENCY_ROOT must be absolute.')
export const requireDependency = createRequire(root ? join(root, 'package.json') : import.meta.url)
export const { McpServer } = requireDependency('@modelcontextprotocol/sdk/server/mcp.js')
export const { StdioServerTransport } = requireDependency('@modelcontextprotocol/sdk/server/stdio.js')
export const { z } = requireDependency('zod')
