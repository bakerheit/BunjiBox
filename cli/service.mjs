import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { workspaceDirectory } from '../core/bot-store.mjs'

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))
const physical = path => { try { return realpathSync(path) } catch { return resolve(path) } }
const refused = error => error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED'

// Only a refused loopback connection permits a launch. A listener with an old,
// unknown or mismatched identity is never killed or replaced by the CLI.
export async function ensureChatService({
  cwd = process.cwd(), explicitCwd = false, port = process.env.BUNJI_API_PORT || 4318,
  workspace = workspaceDirectory(), fetcher = fetch, spawnProcess = spawn,
  timeoutMs = 10000, pollMs = 100,
} = {}) {
  if (!/^\d+$/.test(String(port)) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('BUNJI_API_PORT must be an integer from 1 to 65535.')
  port = Number(port)
  const baseUrl = `http://127.0.0.1:${port}`, expected = createHash('sha256').update(workspace).digest('hex')
  const restart = 'Restart Bunji with npm run api in the BunjiBox folder, then reconnect.'
  const probe = async () => {
    let response
    try { response = await fetcher(baseUrl + '/api/health', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(1500, timeoutMs))) }) }
    catch (error) {
      if (refused(error)) return null
      throw new Error(`Cannot verify the service on port ${port}. No service was replaced. ${error.message}`)
    }
    if (response.status === 404) throw new Error(`The service on port ${port} does not support shared chat. ${restart}`)
    if (!response.ok) throw new Error(`The service on port ${port} returned HTTP ${response.status}. ${restart}`)
    let health
    try { health = await response.json() } catch { throw new Error(`Unknown service on port ${port}; its health response is not JSON.`) }
    if (health?.service !== 'bunji') throw new Error(`Port ${port} belongs to an unknown service. Connect to your workspace's existing Bunji port, or use a separate BUNJI_DATA_DIR and BUNJI_API_PORT.`)
    if (health.continuity !== 1 || typeof health.cwd !== 'string' || !isAbsolute(health.cwd)) throw new Error(`The Bunji service on port ${port} is incompatible. ${restart}`)
    if (health.workspace !== expected) throw new Error(`The Bunji service on port ${port} uses a different workspace. Match BUNJI_DATA_DIR to that service or connect to the port already serving your intended workspace.`)
    const differs = physical(health.cwd) !== physical(cwd)
    if (explicitCwd && differs) throw new Error(`--cwd requested ${cwd}, but the running Bunji service works in ${health.cwd}. Restart the existing service in the intended working directory. A second service needs both a separate BUNJI_DATA_DIR and a different BUNJI_API_PORT.`)
    return { baseUrl, cwd: health.cwd, notice: differs ? `Using the existing Bunji service working directory: ${health.cwd}` : '' }
  }
  const existing = await probe()
  if (existing) return { ...existing, started: false }
  let launchError
  const child = spawnProcess(process.execPath, [entry], {
    cwd: resolve(cwd), env: { ...process.env, BUNJI_API_PORT: String(port) },
    detached: true, stdio: 'ignore', shell: false, windowsHide: true,
  })
  child.once('error', error => { launchError = error })
  child.unref()
  const deadline = Date.now() + timeoutMs
  do {
    const health = await probe()
    if (health) return { ...health, started: true }
    if (launchError) throw new Error(`Could not start Bunji: ${launchError.message}. ${restart}`)
    await delay(pollMs)
  } while (Date.now() < deadline)
  throw new Error(`Bunji did not become ready on port ${port}. ${restart}`)
}
