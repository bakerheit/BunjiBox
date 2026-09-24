import { randomUUID } from 'node:crypto'
import type { Activity, ProviderResult, RunStreamEvent } from '@bunji/shared/types'
import { errorMessage, errorStatus } from '@bunji/shared/errors'
import { readJson, requestUrl, requireSameOrigin, sendJson } from '../http.ts'
import type { RouteHandler } from '../http.ts'

export interface RunRouteDependencies {
  /** Validates a stateless run request; throws a user-facing error. */
  validate(body: unknown): void
  run(body: unknown, hooks: { requestId: string; signal: AbortSignal; onActivity?: (activity: Activity) => void }): Promise<Omit<ProviderResult, 'ok' | 'requestId' | 'durationMs'> & Partial<ProviderResult>>
}

// Prompts are capped at 12,000 characters; allow multi-byte text plus fields.
const RUN_BODY_LIMIT = 64 * 1024
// Bound the queue if a phone loses connectivity or stops reading.
const MAX_BUFFERED = 1024 * 1024

/**
 * POST /api/run: a stateless, unsaved provider run. It never carries memory,
 * files or computer access; those only come from a saved bot in shared chat.
 * Answers JSON, or NDJSON when the client accepts application/x-ndjson.
 */
export function createRunRoutes({ validate, run }: RunRouteDependencies): RouteHandler {
  return async (request, response) => {
    if (request.method !== 'POST' || requestUrl(request).pathname !== '/api/run') return false
    const requestId = randomUUID()
    const startedAt = Date.now()
    try {
      // This route starts provider processes, so it gets the same CSRF guards as every write.
      requireSameOrigin(request, 'Cross-origin runs are not allowed.')
      const body = await readJson(request, RUN_BODY_LIMIT)
      validate(body)
      const streaming = request.headers.accept?.includes('application/x-ndjson') ?? false
      const controller = new AbortController()
      const disconnected = () => { if (!response.writableEnded) controller.abort() }
      response.on('close', disconnected)
      const emit = (event: RunStreamEvent) => {
        if (response.destroyed || response.writableEnded) return
        if (response.writableLength > MAX_BUFFERED) { controller.abort(); response.destroy(); return }
        response.write(JSON.stringify(event) + '\n')
      }
      if (streaming) {
        response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
        response.flushHeaders()
        emit({ type: 'start', requestId })
      }
      const result = await run(body, { requestId, signal: controller.signal, onActivity: streaming ? activity => emit({ type: 'activity', activity }) : undefined })
      response.off('close', disconnected)
      const payload = { ...result, ok: !result.failed, requestId, durationMs: Date.now() - startedAt }
      if (!response.destroyed) {
        if (streaming) { emit({ type: 'result', ...payload }); response.end() }
        else sendJson(response, result.failed ? 400 : 200, payload)
      }
    } catch (error) {
      if (!response.headersSent) {
        const status = errorStatus(error) ?? 400
        sendJson(response, status, { ok: false, error: errorMessage(error), usage: null, requestId, durationMs: Date.now() - startedAt })
      } else response.end()
    }
    return true
  }
}
