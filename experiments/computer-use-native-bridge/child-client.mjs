import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { TextDecoder } from 'node:util'

const methods = new Set(['status', 'focus', 'observe', 'act', 'stop'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function validateOptions({ timeoutMs = 15_000, maxLineBytes = 16 * 1024 * 1024, maxInflight = 16, killGraceMs = 250 } = {}) {
  const options = { timeoutMs, maxLineBytes, maxInflight, killGraceMs }
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`)
  }
  return options
}

export class NativeTransportError extends Error {
  constructor(message) { super(`Native transport failed: ${message}`); this.name = 'NativeTransportError' }
}

/** A bounded, fail-closed NDJSON transport. Exported for stream-based tests. */
export class NativeChildClient {
  constructor(child, options = {}) {
    this.child = child
    this.options = validateOptions(options)
    this.pending = new Map()
    this.queue = []
    this.serialId = null
    this.sequence = 0
    this.buffer = Buffer.alloc(0)
    this.bufferLength = 0
    this.failure = null
    this.exited = false
    this.killTimer = null
    child.stdout.on('data', data => this.receive(data))
    child.stdout.on('end', () => this.fail('helper stdout EOF'))
    child.stdout.on('close', () => this.fail('helper stdout closed'))
    child.stdout.on('error', () => this.fail('helper stdout error'))
    child.stdin.on('error', () => this.fail('helper stdin error'))
    child.stdin.on('close', () => this.fail('helper stdin closed'))
    // Drain without retaining or echoing potentially sensitive native diagnostics.
    child.stderr?.on('data', () => {})
    child.stderr?.on('error', () => this.fail('helper stderr error'))
    child.on('error', () => this.fail('helper process error'))
    child.on('exit', () => { this.exited = true; clearTimeout(this.killTimer); this.fail('helper exited') })
    child.on('close', () => { this.exited = true; clearTimeout(this.killTimer); this.fail('helper closed') })
  }

  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure)
    if (!methods.has(method) || !object(params)) return Promise.reject(new Error('Invalid native request'))
    // Stop jumps the serial queue and discards requests that have not reached native.
    if (method === 'stop') {
      for (const entry of this.queue.splice(0)) {
        this.pending.delete(entry.id)
        entry.reject(new Error('Native request cancelled by stop'))
      }
    }
    // One reserved slot lets stop interrupt even a completely full normal queue.
    const capacity = this.options.maxInflight + (method === 'stop' ? 1 : 0)
    if (this.pending.size >= capacity) {
      this.fail('too many inflight requests')
      return Promise.reject(this.failure)
    }
    const id = String(++this.sequence)
    let line
    try { line = Buffer.from(JSON.stringify({ id, method, params }) + '\n') }
    catch { return Promise.reject(new Error('Native params must be JSON serializable')) }
    if (line.length - 1 > this.options.maxLineBytes) {
      this.fail('request line exceeds byte limit')
      return Promise.reject(this.failure)
    }
    return new Promise((resolve, reject) => {
      const entry = { id, method, line, resolve, reject, timer: null, sent: false }
      this.pending.set(id, entry)
      if (method === 'stop') this.send(entry)
      else { this.queue.push(entry); this.pump() }
    })
  }

  pump() {
    if (this.failure || this.serialId !== null) return
    const entry = this.queue.shift()
    if (entry) { this.serialId = entry.id; this.send(entry) }
  }

  send(entry) {
    entry.sent = true
    // This is a per-wire-request transport deadline, not a user task deadline.
    entry.timer = setTimeout(() => this.fail('response deadline exceeded; helper terminated'), this.options.timeoutMs)
    try {
      this.child.stdin.write(entry.line, error => { if (error) this.fail('helper write error') })
    } catch { this.fail('helper write error') }
  }

  receive(data) {
    if (this.failure) return
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    let offset = 0
    while (offset < chunk.length && !this.failure) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      const required = this.bufferLength + part.length
      if (required > this.options.maxLineBytes) return this.fail('response line exceeds byte limit')
      if (required > this.buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.options.maxLineBytes, Math.max(required, this.buffer.length * 2, 4096)))
        this.buffer.copy(grown, 0, 0, this.bufferLength)
        this.buffer = grown
      }
      part.copy(this.buffer, this.bufferLength)
      this.bufferLength = required
      if (newline === -1) return
      const line = this.buffer.subarray(0, this.bufferLength)
      this.bufferLength = 0
      let response
      try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) }
      catch { return this.fail('invalid JSON or UTF-8 response') }
      const hasResult = object(response) && Object.hasOwn(response, 'result')
      const hasError = object(response) && Object.hasOwn(response, 'error')
      if (!object(response) || typeof response.id !== 'string' || hasResult === hasError ||
          (hasResult && !object(response.result)) || (hasError && typeof response.error !== 'string')) {
        return this.fail('invalid response envelope')
      }
      const entry = this.pending.get(response.id)
      if (!entry?.sent) return this.fail('unexpected response ID')
      clearTimeout(entry.timer)
      this.pending.delete(entry.id)
      if (entry.id === this.serialId) this.serialId = null
      if (hasError) entry.reject(new Error(`Native helper error (untrusted): ${response.error.slice(0, 2048)}`))
      else entry.resolve(response.result)
      queueMicrotask(() => this.pump())
      // Do not send queued work until all lines in this chunk pass validation.
      offset = newline + 1
    }
    this.pump()
  }

  fail(reason) {
    if (this.failure) return
    this.failure = reason instanceof NativeTransportError ? reason : new NativeTransportError(reason)
    this.buffer = Buffer.alloc(0)
    this.bufferLength = 0
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(this.failure) }
    this.pending.clear()
    this.queue = []
    this.serialId = null
    if (!this.exited) {
      try { this.child.kill('SIGTERM') } catch { /* Still attempt SIGKILL below. */ }
      this.killTimer = setTimeout(() => {
        if (!this.exited) { try { this.child.kill('SIGKILL') } catch { /* Already gone. */ } }
      }, this.options.killGraceMs)
    }
    this.child.stdin.destroy()
  }

  close() { this.fail('bridge closed') }
}

export function launchNativeClient({ helper, target = 'fixture', env = process.env, spawnImpl = spawn, ...options } = {}) {
  // Check the actual parent environment; a caller-supplied env cannot grant access.
  if (process.env.BUNJI_NATIVE_EXPERIMENT !== '1') throw new Error('Parent must set BUNJI_NATIVE_EXPERIMENT=1')
  if (typeof helper !== 'string' || !isAbsolute(helper) || helper.includes('\0')) throw new Error('--helper must be an absolute executable path')
  if (typeof target !== 'string' || !target || target.length > 512 || target.includes('\0')) throw new Error('Invalid launcher target')
  validateOptions(options)
  const child = spawnImpl(helper, ['--stdio', '--target', target], {
    env: { ...env, BUNJI_NATIVE_EXPERIMENT: '1' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  })
  return new NativeChildClient(child, options)
}
