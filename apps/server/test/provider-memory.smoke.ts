// Explicit opt-in: consumes a small real request on each locally signed-in provider.
// Uses disposable notes only. Never pointed at the user's actual memory vault.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openMemoryStore } from '@bunji/core/memory-store'
import { runProvider } from '@bunji/core/runtime'

if (process.env.BUNJI_PROVIDER_SMOKE !== '1') throw new Error('Set BUNJI_PROVIDER_SMOKE=1 to run real provider smoke checks.')
const directory = await mkdtemp(join(await realpath(tmpdir()), 'bunji-provider-memory-smoke-'))
try {
  const store = openMemoryStore({ directory })
  const providers = process.env.BUNJI_SMOKE_PROVIDER ? [process.env.BUNJI_SMOKE_PROVIDER] : ['codex', 'claude']
  for (const provider of providers) {
    const secret = 'citrus-' + randomUUID().slice(0, 8)
    await store.write(provider, { title: 'Smoke verification', body: `The smoke test code is ${secret}.` })
    const result = await runProvider({ provider, model: provider === 'codex' ? 'gpt-5.6-luna' : 'haiku', effort: 'low',
      prompt: 'This is an isolated Bunji memory integration test. Use only the bunji_memory MCP tools, no shell or other tools. First search memory for "Smoke verification", then read that note. Use memory_write to create a new note titled "Smoke receipt" with exactly the test code from the existing note as its body. You have explicit permission to save this disposable test note. Reply with only the test code.' }, {
      requestId: 'smoke-' + provider, memory: { botId: provider, sourceId: 'smoke-' + provider, directory, allowWrites: true },
      onActivity: item => { if (item.kind === 'tool') console.log(provider, item.title, item.status) },
    })
    console.log(JSON.stringify({ provider, ok: result.ok, error: result.error, tokens: result.usage?.totalTokens, text: result.text }))
    assert.equal(result.ok, true, provider + ' must finish')
    assert.ok(result.text.includes(secret), provider + ' must recall an unseen stored value')
    const receipt = (await store.list(provider)).notes.find(note => note.title === 'Smoke receipt')
    assert.ok(receipt, provider + ' must actually save the memory')
    assert.ok((await store.read(provider, receipt.id)).body.includes(secret), provider + ' must persist the recalled fact')
    console.log(provider + ': verified real memory search/read/write')
  }
} finally { await rm(directory, { recursive: true, force: true }) }
