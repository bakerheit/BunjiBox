import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorMessage, fail } from '@bunji/shared/errors'
import { BUNJI_CODEX_DISABLED_FEATURES } from './codex-profile.ts'
import type { SpawnProcess } from './run-stream.ts'

const MAX_IMAGE = 20 * 1024 * 1024
const MAX_LINE = 32 * 1024 * 1024

export type AvatarJobStatus = 'running' | 'complete' | 'failed' | 'cancelled'

/** What clients see of a generation job. `image` is a data: URL once complete. */
export interface AvatarJobSnapshot {
  id: string
  status: AvatarJobStatus
  image: string | null
  error: string | null
}

/** Produces a data: URL for a picture description. */
export type AvatarGenerator = (prompt: string, options: { signal: AbortSignal }) => Promise<string>

/** Short-lived, in-memory generation jobs. Errors carry an HTTP `status`. */
export interface AvatarGenerations {
  /** `{ id, prompt }`. Idempotent by ID; a different prompt for the same ID conflicts. */
  start(body: unknown): AvatarJobSnapshot
  get(id: string): AvatarJobSnapshot
  cancel(id: string): AvatarJobSnapshot
  /** Cancels running jobs, waits for them, and clears every preview. */
  close(): Promise<void>
}

export interface GenerateAvatarOptions {
  signal?: AbortSignal
  spawnProcess?: SpawnProcess
  startupTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface RpcMessage {
  id?: number | string
  method?: string
  result?: unknown
  error?: { message?: unknown }
  params?: {
    item?: { type?: string; failure?: unknown; status?: string; result?: unknown }
    willRetry?: boolean
    error?: { message?: unknown }
  }
}

// Only native image-tool output is accepted, never a path or a URL from model text.
export function avatarImageData(result: unknown): string {
  if (typeof result !== 'string' || result.length > Math.ceil(MAX_IMAGE / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) throw fail('Codex did not return a supported image.')
  const bytes = Buffer.from(result, 'base64')
  if (bytes.length > MAX_IMAGE) throw fail('Generated image is too large.')
  const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null
  if (!mime) throw fail('Codex returned an unsupported image format.')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export async function generateAvatar(prompt: string, { signal, spawnProcess = spawn, startupTimeoutMs = 30000 }: GenerateAvatarOptions = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'bunji-avatar-'))
  let child: ChildProcess | undefined, childStopped: Promise<unknown> | undefined, startupTimer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined, settled = false
  const pending = new Map<number, PendingRequest>()
  let sequence = 0, buffer = '', total = 0
  const disabled = [...BUNJI_CODEX_DISABLED_FEATURES.filter(name => name !== 'image_generation'), 'shell_tool', 'unified_exec', 'view_image', 'shell_snapshot']
  const args = ['app-server', ...disabled.flatMap(name => ['--disable', name]), '--enable', 'image_generation',
    '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"']
  let abort: (() => void) | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error: unknown, image?: string) => {
        if (settled) return
        settled = true
        clearTimeout(startupTimer)
        for (const entry of pending.values()) entry.reject(error || new Error('Image generation finished.'))
        pending.clear()
        if (child && child.exitCode === null) {
          const running = child
          running.kill('SIGTERM')
          killTimer = setTimeout(() => running.kill('SIGKILL'), 2000)
          killTimer.unref()
        }
        if (error) reject(error)
        else resolve(image as string)
      }
      abort = () => finish(fail('Image generation cancelled.'))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      const codex = spawnProcess('codex', args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      child = codex
      childStopped = new Promise(resolve => { codex.once('exit', resolve); codex.once('error', resolve) })
      codex.on('error', () => finish(fail('Could not start Codex. Install it and sign in with ChatGPT.')))
      codex.on('exit', () => { clearTimeout(killTimer); finish(fail('Codex closed before returning an image. Please try again.')) })
      codex.stderr!.on('data', () => {})
      codex.stdin!.on('error', () => finish(fail('The Codex image connection closed.')))
      const send = (value: object) => { if (!settled) codex.stdin!.write(JSON.stringify(value) + '\n') }
      const request = (method: string, params: unknown) => new Promise<unknown>((yes, no) => {
        if (settled) { no(new Error('Image generation stopped.')); return }
        const id = ++sequence
        pending.set(id, { resolve: yes, reject: no })
        send({ id, method, params })
      })
      const receive = (line: string) => {
        let message: RpcMessage
        try { message = JSON.parse(line) as RpcMessage } catch { return }
        if (message.id !== undefined && !message.method) {
          const entry = pending.get(message.id as number)
          if (!entry) return
          pending.delete(message.id as number)
          if (message.error) entry.reject(fail(String(message.error.message || 'Codex image request failed.').slice(0, 500)))
          else entry.resolve(message.result)
        } else if (message.id !== undefined) {
          // This isolated generator has no reason to run commands, edit files, or request credentials.
          send({ id: message.id, error: { code: -32601, message: 'Only native image generation is supported.' } })
        } else if (message.method === 'item/completed' && message.params?.item?.type === 'imageGeneration') {
          const item = message.params.item
          if (item.failure || item.status === 'failed') finish(fail('ChatGPT could not generate that image. Try a different prompt or check your usage.'))
          else {
            try { finish(null, avatarImageData(item.result)) } catch (error) { finish(error) }
          }
        } else if (message.method === 'turn/completed') {
          finish(fail('Codex finished without returning an image. Try again or update Codex if image generation is unavailable.'))
        } else if (message.method === 'error' && !message.params?.willRetry) {
          finish(fail(String(message.params?.error?.message || 'Codex image generation failed.').slice(0, 500)))
        }
      }
      codex.stdout!.setEncoding('utf8')
      codex.stdout!.on('data', (chunk: string) => {
        if (settled) return
        total += chunk.length
        if (total > MAX_LINE * 3) { finish(fail('Codex image response was too large.')); return }
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
          if (newline > MAX_LINE) { finish(fail('Codex image response was too large.')); return }
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          receive(line)
        }
        if (buffer.length > MAX_LINE) finish(fail('Codex image response was too large.'))
      })
      startupTimer = setTimeout(() => finish(fail('Codex did not connect. Check that you are signed in and try again.')), startupTimeoutMs)
      ;(async () => {
        await request('initialize', { clientInfo: { name: 'bunji_avatar', title: 'BunjiBox avatars', version: '0.1.0' }, capabilities: { experimentalApi: true } })
        send({ method: 'initialized', params: {} })
        const account = await request('account/read', { refreshToken: false }) as { account?: { type?: string } }
        if (account.account?.type !== 'chatgpt') throw fail('Sign into Codex with your ChatGPT account to generate a profile picture.')
        const result = await request('thread/start', {
          model: 'gpt-5.5', cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
          baseInstructions: 'You generate profile pictures. Use the built-in image generation tool exactly once for the supplied description. Never use other tools. Never claim to generate an image without actually calling that tool. Make a square, centered picture without text unless requested.',
          config: { mcp_servers: {}, project_doc_max_bytes: 0, web_search: 'disabled' },
        }) as { thread: { id: string } }
        // Generation has no wall-clock timeout; a long-running image stays alive until cancelled.
        clearTimeout(startupTimer)
        await request('turn/start', { threadId: result.thread.id, effort: 'low', input: [{ type: 'text', text: `Generate a profile picture using the image generation tool. Picture description:\n${prompt}`, text_elements: [] }] })
      })().catch(error => finish(error))
    })
  } finally {
    clearTimeout(startupTimer)
    signal?.removeEventListener('abort', abort!)
    await childStopped
    await rm(cwd, { recursive: true, force: true })
  }
}

interface AvatarJob extends AvatarJobSnapshot {
  prompt: string
  controller: AbortController
  promise?: Promise<void>
  finishedAt?: number
}

export function createAvatarGenerations({ generate = generateAvatar, now = Date.now, retentionMs = 20 * 60 * 1000 }: { generate?: AvatarGenerator; now?: () => number; retentionMs?: number } = {}): AvatarGenerations {
  const jobs = new Map<string, AvatarJob>()
  let closed = false
  const snapshot = (job: AvatarJob): AvatarJobSnapshot => ({ id: job.id, status: job.status, image: job.image, error: job.error })
  const prune = () => { for (const [id, job] of jobs) if (job.status !== 'running' && now() - (job.finishedAt as number) > retentionMs) jobs.delete(id) }
  return {
    start(body) {
      prune()
      if (closed) throw fail('Image generation is shutting down.', 503)
      const value = body as Record<string, unknown> | null | undefined
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id', 'prompt'].includes(key)) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.id) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 2000) throw fail('Enter a picture description of 1–2,000 characters and a valid request ID.')
      const prompt = value.prompt.trim(), previous = jobs.get(value.id)
      if (previous) {
        if (previous.prompt !== prompt) throw fail('That image request ID already has a different prompt.', 409)
        return snapshot(previous)
      }
      if ([...jobs.values()].filter(job => job.status === 'running').length >= 2) throw fail('Two pictures are already generating. Wait or cancel one first.', 429)
      if (jobs.size >= 8) throw fail('The image preview cache is full. Try again in a few minutes.', 429)
      const controller = new AbortController()
      const job: AvatarJob = { id: value.id, prompt, status: 'running', image: null, error: null, controller }
      jobs.set(job.id, job)
      job.promise = Promise.resolve().then(() => generate(prompt, { signal: controller.signal })).then(image => {
        if (job.status === 'running') { job.image = image; job.status = 'complete' }
      }, error => {
        if (job.status === 'running') { job.status = 'failed'; job.error = String(errorMessage(error, '') || 'Image generation failed.').slice(0, 500) }
      }).finally(() => { job.finishedAt = now() })
      return snapshot(job)
    },
    get(id) {
      prune()
      const job = jobs.get(id)
      if (!job) throw fail('Image preview expired or Bunji restarted. Generate a new picture.', 404)
      return snapshot(job)
    },
    cancel(id) {
      const job = jobs.get(id)
      if (!job) throw fail('Image request not found.', 404)
      if (job.status === 'running') { job.status = 'cancelled'; job.finishedAt = now(); job.controller.abort() }
      return snapshot(job)
    },
    async close() {
      closed = true
      for (const job of jobs.values()) if (job.status === 'running') { job.status = 'cancelled'; job.controller.abort() }
      await Promise.all([...jobs.values()].map(job => job.promise))
      jobs.clear()
    },
  }
}
