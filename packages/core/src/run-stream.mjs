import { spawn } from 'node:child_process'
import { createRunEvents } from './run-events.mjs'

const configuredStallTimeout = Number(process.env.BUNJI_PROVIDER_STALL_TIMEOUT_MS || 0)

export function runStream(command, args, {
  provider,
  onActivity,
  onFile,
  signal,
  // Provider runs have no wall-clock deadline. A stall watchdog can be
  // enabled for deployments that want one, but output keeps extending it.
  stallTimeoutMs = Number.isFinite(configuredStallTimeout) && configuredStallTimeout > 0 ? configuredStallTimeout : 0,
  spawnProcess = spawn,
  cwd,
} = {}) {
  return new Promise(resolve => {
    const tracker = createRunEvents(provider, onActivity, onFile)
    const child = spawnProcess(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) })
    let buffer = '', received = 0, settled = false, forceKill, stallTimer
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', abort)
      const result = tracker.result()
      resolve({ ...result, failed: Boolean(error) || result.failed, error: error || (result.failed ? 'The provider did not complete this request. Check its connection and try again.' : undefined) })
    }
    const stop = error => {
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
    const parse = line => { try { tracker.consume(JSON.parse(line)) } catch { /* Non-JSON diagnostics stay server-side. */ } }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
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
    child.stderr.on('data', markActivity)
    child.on('error', () => finish('Could not start the provider. Check that its CLI is installed.'))
    child.on('close', code => {
      clearTimeout(forceKill)
      if (settled) return
      if (buffer.trim()) parse(buffer)
      finish(code === 0 ? undefined : 'The provider exited with an error. Check its sign-in and model settings.')
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
