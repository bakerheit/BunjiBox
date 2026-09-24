// The provider runner the service uses. Kept apart from runtime.ts because the
// experimental Codex app-server path opens SQLite, and the CLI should not load
// node:sqlite (and print its experimental warning) just to run a provider.
import { createCodexAppServer } from './codex-app-server.ts'
import type { CodexAppServer } from './codex-app-server.ts'
import { openCodexSessionStore } from './codex-session-store.ts'
import type { CodexSessionStore } from './codex-session-store.ts'
import { runProvider } from './runtime.ts'
import type { ProviderRunner } from './runtime.ts'

export interface ProviderRunnerOptions {
  /** Enables the persistent Codex app-server for Codex Agent runs. */
  experimental?: boolean
  sessions?: CodexSessionStore
  appServer?: CodexAppServer
}

export interface ProviderRunnerHandle {
  /** The Codex session store in use, or null when persistent sessions are off. */
  sessions: CodexSessionStore | null
  run: ProviderRunner
  close(): Promise<void>
}

export function createProviderRunner({ experimental = false, sessions, appServer }: ProviderRunnerOptions = {}): ProviderRunnerHandle {
  if (!experimental) return { sessions: null, run: runProvider, async close() {} }
  const store = sessions || openCodexSessionStore()
  const server = appServer || createCodexAppServer({ sessions: store })
  let closed = false
  return {
    sessions: store,
    run(options, hooks = {}) { return runProvider(options, { ...hooks, codexAppServer: server }) },
    async close() {
      if (closed) return
      closed = true
      await server.close()
      store.close()
    },
  }
}
