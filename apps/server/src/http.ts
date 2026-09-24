// The one HTTP toolkit every route uses: JSON responses, bounded JSON bodies,
// and the browser-facing guards (Host allowlist and same-origin writes).
//
// Threat model: the API listens on 127.0.0.1 and the Vite dev server proxies
// LAN devices to it. There is no account auth in this alpha, so two browser
// attacks matter:
// - Cross-site requests from any page the user visits. Writes must come from
//   the same origin and use application/json, which forces a CORS preflight
//   that this server never approves.
// - DNS rebinding, where an attacker's hostname re-resolves to 127.0.0.1 and
//   the Origin then matches the Host. Only hosts that cannot be rebound are
//   accepted: IP literals, localhost and *.localhost (the same default Vite
//   uses), plus names listed in BUNJI_ALLOWED_HOSTS.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { BunjiError, errorCode, errorMessage, errorStatus, fail } from '@bunji/shared/errors'

/** A route answers requests it owns and returns false for everything else. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>

const JSON_TYPE = 'application/json; charset=utf-8'

export function sendJson(response: ServerResponse, status: number, body?: unknown, headers: Record<string, string | number> = {}) {
  response.writeHead(status, { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...headers })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

/** Status for an error: its own, 503 for a busy/locked database, else the fallback. */
export function statusFor(error: unknown, fallback = 400): number {
  return errorStatus(error) ?? (errorCode(error)?.startsWith('ERR_SQLITE') ? 503 : fallback)
}

/** Answer with `{ error }`. `status`/`message` apply only when the error has none. */
export function sendError(response: ServerResponse, error: unknown, { status = 400, message = 'Request failed.' }: { status?: number; message?: string } = {}) {
  sendJson(response, statusFor(error, status), { error: errorMessage(error, message) || message })
}

/** The request path, parsed without trusting the Host header. */
export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url || '/', 'http://localhost')
}

/**
 * Read a JSON body of at most `limit` bytes. Requiring application/json is
 * part of the CSRF defense: browsers cannot send it cross-site without a
 * preflight.
 */
export async function readJson(request: IncomingMessage, limit = 65536, tooLarge = 'Request is too large.'): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw fail('Use application/json.', 415)
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request as AsyncIterable<Buffer>) {
    size += part.length
    if (size > limit) throw fail(tooLarge, 413)
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw fail('Invalid JSON.') }
}

/** Narrow a parsed body to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * True when the request carries no Origin (same-origin GETs, the CLI, the
 * native app) or an http(s) Origin whose host matches the Host header.
 * Opaque ("null") and malformed origins are foreign.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === request.headers.host
  } catch { return false }
}

export function requireSameOrigin(request: IncomingMessage, message = 'Cross-origin changes are not allowed.') {
  if (!sameOrigin(request)) throw new BunjiError(message, 403)
}

export const isReadOnly = (request: IncomingMessage) => request.method === 'GET' || request.method === 'HEAD'

/** Parse BUNJI_ALLOWED_HOSTS: comma-separated names; a leading dot allows subdomains. */
export function allowedHostsFrom(value: string | undefined): string[] {
  return (value || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)
}

/** Mirrors Vite's default host check so the API is never looser than the dev server. */
export function hostAllowed(hostHeader: string | undefined, allowedHosts: readonly string[] = []): boolean {
  if (hostHeader === undefined) return true
  // A Host header is only host[:port]; userinfo or a path could fool URL parsing.
  if (/[@/?#\\\s]/.test(hostHeader)) return false
  let hostname: string
  try { hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase() } catch { return false }
  if (hostname.startsWith('[') && hostname.endsWith(']')) return isIP(hostname.slice(1, -1)) === 6
  if (isIP(hostname)) return true
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  return allowedHosts.some(allowed => allowed === hostname
    || (allowed.startsWith('.') && (allowed.slice(1) === hostname || hostname.endsWith(allowed))))
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/**
 * Run routes in order until one claims the request. The Host check runs first
 * so no route is reachable through a rebound DNS name.
 */
export function createRequestHandler(routes: readonly RouteHandler[], { allowedHosts = [] }: { allowedHosts?: readonly string[] } = {}): RequestHandler {
  return async (request, response) => {
    try {
      if (!hostAllowed(request.headers.host, allowedHosts)) {
        sendJson(response, 403, { error: 'This host name is not allowed. Use an IP address or localhost, or add it to BUNJI_ALLOWED_HOSTS.' })
        return
      }
      for (const route of routes) if (await route(request, response)) return
      sendJson(response, 404, { error: 'Not found' })
    } catch {
      // Routes answer their own errors; this only stops a bug from crashing the service.
      if (!response.headersSent) sendJson(response, 500, { error: 'Unexpected server error.' })
      else response.destroy()
    }
  }
}
