import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createRunEvents } from './run-events.ts'
import type { RunEventsResult } from './run-events.ts'
import type { ProviderHooks } from './provider-types.ts'

const configuredStallTimeout = Number(process.env.BUNJI_PROVIDER_STALL_TIMEOUT_MS || 0)

/** Launches a provider process. Tests inject a fake with piped stdout/stderr. */
export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface RunStreamOptions extends Omit<ProviderHooks, 'messages'> {
  /** Selects the event format: 'codex' JSONL, anything else Claude stream-json. */
  provider?: string
  stallTimeoutMs?: number
  spawnProcess?: SpawnProcess
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type RunStreamResult = RunEventsResult & { error?: string }

export function runStream(command: string, args: string[], {
  provider,
  onActivity,
  onFile,
  signal,
  // Provider runs have no wall-clock deadline. A stall watchdog can be
  // enabled for deployments that want one, but output keeps extending it.
  stallTimeoutMs = Number.isFinite(configuredStallTimeout) && configuredStallTimeout > 0 ? configuredStallTimeout : 0,
  spawnProcess = spawn,
  cwd,
  env = process.env,
}: RunStreamOptions = {}): Promise<RunStreamResult> {
  return new Promise(resolve => {
    const tracker = createRunEvents(provider, onActivity, onFile)
    const child = spawnProcess(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
    const stdout = child.stdout!, stderr = child.stderr!
    let buffer = '', received = 0, settled = false
    let forceKill: NodeJS.Timeout | undefined, stallTimer: NodeJS.Timeout | undefined
    const finish = (error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', abort)
      const result = tracker.result()
      resolve({ ...result, failed: Boolean(error) || result.failed, error: error || (result.failed ? 'The provider did not complete this request. Check its connection and try again.' : undefined) })
    }
    const stop = (error: string) => {
      child.kill('SIGTERM')
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
      forceKill.unref?.()
      finish(error)
    }
    const abort = () => stop('The connection closed before the request finished.')
    const markActivity = () => {
      if (!stallTimeoutMs || settled) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stop(`The provider stalled for ${stallTimeoutMs / 1000}s without sending output.`), stallTimeoutMs)
    }
    markActivity()
    const parse = (line: string) => { try { tracker.consume(JSON.parse(line)) } catch { /* Non-JSON diagnostics stay server-side. */ } }
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      if (settled) return
      markActivity()
      received += chunk.length
      if (received > 64 * 1024 * 1024) { stop('Provider output exceeded the safety limit.'); return }
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) { parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (buffer.length > 2 * 1024 * 1024) stop('A provider event exceeded the safety limit.')
    })
    // Drain stderr without forwarding potentially sensitive provider diagnostics.
    stderr.on('data', markActivity)
    child.on('error', () => finish('Could not start the provider. Check that its CLI is installed.'))
    child.on('close', (code: number | null) => {
      clearTimeout(forceKill)
      if (settled) return
      if (buffer.trim()) parse(buffer)
      finish(code === 0 ? undefined : 'The provider exited with an error. Check its sign-in and model settings.')
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
