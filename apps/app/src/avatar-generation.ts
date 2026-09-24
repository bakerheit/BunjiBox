// The avatar generation API is app-only, so its shapes live here rather than
// in @bunji/shared/types.
export interface AvatarGenerationJob {
  id: string
  prompt: string
}

export type AvatarGenerationAction = 'start' | 'poll' | 'cancel'

/** What the server reports for one generation job. */
export interface AvatarGenerationStatus {
  id: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  image?: string | null
  error?: unknown
}

/** A failed request. `status` is the HTTP status when the server answered. */
export type AvatarRequestError = Error & { status?: number }

// This deadline covers one HTTP request (including its body), never the job.
export async function avatarGenerationRequest(job: AvatarGenerationJob, action: AvatarGenerationAction, signal?: AbortSignal): Promise<AvatarGenerationStatus> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 10_000)
  const suffix = action === 'start' ? '' : `/${encodeURIComponent(job.id)}${action === 'cancel' ? '/cancel' : ''}`
  try {
    const response = await fetch(`/api/avatar-generations${suffix}`, {
      method: action === 'poll' ? 'GET' : 'POST',
      headers: action === 'poll' ? undefined : { 'Content-Type': 'application/json' },
      body: action === 'poll' ? undefined : JSON.stringify(action === 'start' ? job : {}),
      signal: controller.signal,
      cache: 'no-store',
    })
    const data = await response.json() as { error?: unknown; generation?: AvatarGenerationStatus }
    if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : `Avatar request failed (${response.status}).`), { status: response.status })
    const generation = data.generation
    if (generation?.id !== job.id || !['running', 'complete', 'failed', 'cancelled'].includes(generation.status)) {
      throw new Error('The server returned an invalid generation status.')
    }
    return generation
  } catch (error) {
    if (signal?.aborted) throw error
    if (controller.signal.aborted) throw new Error('The connection took too long. Retry to check the same generation.')
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export async function cancelAvatarGeneration(job: AvatarGenerationJob, creation?: Promise<unknown> | null, signal?: AbortSignal): Promise<AvatarGenerationStatus> {
  // Creation has its own short HTTP deadline. Aborting it when leaving the UI
  // can send cancellation before the server has registered the job.
  await creation?.catch(() => {})
  signal?.throwIfAborted()
  return avatarGenerationRequest(job, 'cancel', signal)
}

export async function normalizeAvatarImage(source: Blob | string): Promise<string> {
  let blob: Blob
  if (typeof source === 'string') {
    // Never load a remote URL supplied as a generation result.
    if (!/^data:image\/(png|jpeg|webp);base64,/i.test(source)) throw new Error('The generated picture is not a supported image.')
    blob = await (await fetch(source)).blob()
  } else blob = source
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context || !bitmap.width || !bitmap.height) throw new Error('Image resizing is unavailable.')
    const edge = Math.min(bitmap.width, bitmap.height)
    context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 256, 256)
    const image = canvas.toDataURL('image/webp', 0.85)
    if (!image.startsWith('data:image/webp;base64,') || image.length > 350_000) throw new Error('Could not resize this picture. Try another image.')
    return image
  } finally {
    bitmap.close()
  }
}
