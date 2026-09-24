import { createHash } from 'node:crypto'
import type { Provider, ProviderStatus, ServiceHealth } from '@bunji/shared/types'
import { providers } from '@bunji/shared/runtimes'
import { requestUrl, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

export interface SystemRouteDependencies {
  /** The configured workspace directory; clients compare its hash, never the path. */
  workspace: string
  cwd?: string
  readUsage(options: { refresh: boolean }): Promise<unknown>
  providerStatus(provider: Provider): Promise<ProviderStatus>
}

/** Read-only service endpoints: health, subscription usage and provider sign-in status. */
export function createSystemRoutes({ workspace, cwd = process.cwd(), readUsage, providerStatus }: SystemRouteDependencies): RouteHandler {
  const workspaceHash = createHash('sha256').update(workspace).digest('hex')
  return async (request, response) => {
    if (request.method !== 'GET') return false
    const url = requestUrl(request)
    if (url.pathname === '/api/health') {
      const health: ServiceHealth = { service: 'bunji', continuity: 1, workspace: workspaceHash, cwd }
      sendJson(response, 200, health)
    } else if (url.pathname === '/api/usage') {
      try { sendJson(response, 200, await readUsage({ refresh: url.searchParams.get('refresh') === '1' })) }
      catch { sendJson(response, 503, { error: 'Usage is temporarily unavailable. Try again shortly.' }) }
    } else if (url.pathname === '/api/status') {
      const entries = await Promise.all(providers.map(async provider => [provider, await providerStatus(provider)] as const))
      sendJson(response, 200, Object.fromEntries(entries))
    } else return false
    return true
  }
}
