// Process entry for the local API (npm run api). Everything else lives in app.ts.
import http from 'node:http'
import { acquireServiceLease } from '@bunji/core/service-lease'
import { allowedHostsFrom } from './http.ts'
import { createBunjiService } from './app.ts'

const PORT = Number(process.env.BUNJI_API_PORT || 4318)

// Coordinate by workspace, not only by port. Two service ports must not recover
// or run each other's in-flight work against the same SQLite database.
const serviceLease = acquireServiceLease()
process.once('exit', () => serviceLease.release())

const service = await createBunjiService({
  experimentalCodexAppServer: process.env.BUNJI_EXPERIMENTAL_CODEX_APP_SERVER === '1',
  allowedHosts: allowedHostsFrom(process.env.BUNJI_ALLOWED_HOSTS),
})
const server = http.createServer((request, response) => void service.handler(request, response))

server.listen(PORT, '127.0.0.1', () => {
  // Only the process which owns the port can recover runs from a prior crash.
  service.recoverInterrupted()
  console.log(`BunjiBox local API listening on http://127.0.0.1:${PORT}`)
})

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  server.close()
  await service.close()
  serviceLease.release()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
