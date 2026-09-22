import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMemoryServer } from '../src/memory-mcp.mjs'
import { openMemoryStore } from '../src/memory-store.mjs'

test('persistent MCP tools read the current request scope for memory provenance', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'bunji-mcp-session-'))
  const store = openMemoryStore({ directory: join(directory, 'memory') })
  let sourceId = 'request-one'
  const server = createMemoryServer({ store, botId: 'chip', allowWrites: true,
    scope: async () => ({ sourceId, computer: { scope: 'none', level: 'read', network: 'off' }, cwd: directory }) })
  const client = new Client({ name: 'test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }) })

  const created = await client.callTool({ name: 'memory_write', arguments: { id: 'identity', title: 'Identity', body: 'Chip works at Bakerheit Labs.' } })
  const note = JSON.parse(created.content[0].text).data
  assert.deepEqual(note.sourceMessageIds, ['request-one'])
  sourceId = 'request-two'
  await client.callTool({ name: 'memory_write', arguments: { id: note.id, title: note.title, body: 'Chip2 works at Bakerheit Labs.', expectedRevision: note.revision } })
  assert.deepEqual((await store.read('chip', note.id)).sourceMessageIds, ['request-one', 'request-two'])
})
