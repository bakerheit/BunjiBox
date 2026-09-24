// Error helpers shared by every package. Messages on a BunjiError are written
// for people; `status` tells the HTTP layer how to answer.

export class BunjiError extends Error {
  status: number
  code?: string

  constructor(message: string, status = 400, options: { code?: string; cause?: unknown } = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.status = status
    if (options.code !== undefined) this.code = options.code
  }
}

/** Build (not throw) a user-facing error. Use as `throw fail('...', 404)`. */
export const fail = (message: string, status = 400, code?: string): BunjiError =>
  new BunjiError(message, status, code === undefined ? {} : { code })

/** The message of anything a `catch` can receive. */
export function errorMessage(error: unknown, fallback = 'Unknown error.'): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return fallback
}

/** A Node-style `code` (ENOENT, ERR_SQLITE_ERROR, ...) if the value carries one. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The HTTP status attached to an error, if any. */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Let a timer stop blocking process exit where the runtime supports it. Node
 * timers have `unref`; browser timers are plain numbers and are returned as is.
 */
export function unrefTimer<T>(timer: T): T {
  (timer as { unref?: () => void } | null)?.unref?.()
  return timer
}
