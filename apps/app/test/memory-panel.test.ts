import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

test('memory panel API, conflict drafts, relations and accessible SSR', async t => {
  const vite = await createServer({
    configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  try {
    const { default: MemoryPanel, MemoryNote, createMemoryApi, memoryEditorReducer: reduce, memoryRelations } = await vite.ssrLoadModule('/src/MemoryPanel.tsx')
    const saved = { id: 'note/one', title: 'Tea preference', body: '**Green tea**, no sugar.', revision: 2, updatedAt: '2026-09-20T12:30:00Z', links: ['note-two'], sourceMessageIds: ['message-one'] }
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

    await t.test('API scopes and encodes URLs, passes abort signals and sends the expected revision', async () => {
      const calls = []
      const controller = new AbortController()
      const api = createMemoryApi('bot/a b', async (url, options) => {
        calls.push({ url, ...options })
        return reply(options.method === 'GET' && url.endsWith('/memory') ? { notes: [saved] } : { note: saved })
      })
      const notes = await api.list(controller.signal)
      assert.equal(notes[0].title, saved.title)
      assert.deepEqual(notes[0].links, [{ id: 'note-two', title: '' }])
      assert.equal((await api.read(saved.id, controller.signal)).body, saved.body)
      await api.save(null, { title: '  New title  ', body: 'Keep\n\nMarkdown.' }, controller.signal)
      await api.save(saved, { title: 'Updated', body: 'Draft body' }, controller.signal)
      assert.deepEqual(calls.map(call => [call.method, call.url]), [
        ['GET', '/api/bots/bot%2Fa%20b/memory'],
        ['GET', '/api/bots/bot%2Fa%20b/memory/note%2Fone'],
        ['POST', '/api/bots/bot%2Fa%20b/memory'],
        ['PATCH', '/api/bots/bot%2Fa%20b/memory/note%2Fone'],
      ])
      assert.ok(calls.every(call => call.signal === controller.signal))
      assert.deepEqual(JSON.parse(calls[2].body), { title: 'New title', body: 'Keep\n\nMarkdown.' })
      assert.deepEqual(JSON.parse(calls[3].body), { title: 'Updated', body: 'Draft body', expectedRevision: 2 })
      assert.equal(calls[3].headers['Content-Type'], 'application/json')
    })

    await t.test('API exposes JSON conflicts, rejects incomplete responses and never fabricates empty results', async () => {
      const conflictApi = createMemoryApi('bot', async () => reply({ error: 'Revision changed' }, 409))
      await assert.rejects(conflictApi.save(saved, { title: 'Draft', body: 'Keep me' }), (error: Error & { status?: number }) => error.status === 409 && error.message === 'Revision changed')
      await assert.rejects(createMemoryApi('bot', async () => reply({})).list(), /invalid memory list/)
      await assert.rejects(createMemoryApi('bot', async () => reply({ notes: [saved, saved] })).list(), /duplicate note IDs/)
      await assert.rejects(createMemoryApi('bot', async () => reply({ note: { ...saved, body: undefined } })).read(saved.id), /incomplete memory note/)
      await assert.rejects(createMemoryApi('bot', async () => reply({ note: { ...saved, revision: undefined } })).read(saved.id), /incomplete memory note/)
      await assert.rejects(createMemoryApi('bot', async () => reply({ note: { ...saved, id: 'wrong-note' } })).read(saved.id), /different memory note/)
      await assert.rejects(createMemoryApi('bot', async () => reply({})).save(null, { title: 'Draft', body: 'Keep me' }), /Save not confirmed/)
      await assert.rejects(createMemoryApi('bot', async () => { throw new TypeError('offline') }).save(null, { title: 'Draft', body: '' }), /Save not confirmed/)
      assert.deepEqual(await createMemoryApi('bot', async () => reply({ notes: [] })).list(), [])
    })

    await t.test('abort stays distinguishable from a network error', async () => {
      const controller = new AbortController()
      controller.abort()
      const aborted = new DOMException('Aborted', 'AbortError')
      const api = createMemoryApi('bot', async () => { throw aborted })
      await assert.rejects(api.list(controller.signal), error => error === aborted)
    })

    await t.test('conflict keeps the draft and original revision until an explicit rebase', () => {
      let state = reduce(undefined, { type: 'edit', note: saved })
      state = reduce(state, { type: 'change', field: 'title', value: 'My draft title' })
      state = reduce(state, { type: 'change', field: 'body', value: 'My unsaved body' })
      const draft = state.draft
      state = reduce(state, { type: 'saving' })
      assert.equal(reduce(state, { type: 'change', field: 'body', value: 'Typing during save' }).draft, draft)
      state = reduce(state, { type: 'conflict', error: 'Revision changed' })
      state = reduce(state, { type: 'latest-loading' })
      state = reduce(state, { type: 'latest-loaded', note: { ...saved, revision: 3, body: 'Changed elsewhere' } })
      assert.equal(state.draft, draft)
      assert.equal(state.base.revision, 2)
      assert.equal(state.conflict, true)
      assert.equal(reduce(state, { type: 'saving' }), state)
      state = reduce(state, { type: 'rebase' })
      assert.equal(state.base.revision, 3)
      assert.equal(state.draft, draft)
      assert.equal(state.conflict, false)
      assert.equal(state.status, 'idle')
      state = reduce(state, { type: 'saving' })
      state = reduce(state, { type: 'failed', error: 'Offline' })
      assert.equal(state.draft, draft)
      assert.equal(state.status, 'error')
      assert.equal(reduce(state, { type: 'reset' }).draft, null)
    })

    await t.test('failed conflict reload leaves draft untouched and prevents implicit rebase', () => {
      let state = reduce(undefined, { type: 'edit', note: saved })
      state = reduce(state, { type: 'change', field: 'body', value: 'Do not lose this' })
      state = reduce(state, { type: 'conflict', error: 'Changed' })
      state = reduce(state, { type: 'latest-failed', error: 'Cannot read latest' })
      assert.equal(state.draft.body, 'Do not lose this')
      assert.equal(state.latestStatus, 'error')
      assert.equal(reduce(state, { type: 'rebase' }), state)
    })

    await t.test('relations support string and object links, incoming edges, deduplication and missing targets', () => {
      const note = { ...saved, links: ['note-two', { id: 'note-two' }, { noteId: 'not-listed', title: 'Archived fact' }, { targetId: 'outgoing', title: 'Outgoing fact' }, null, {}, saved.id] }
      const relations = memoryRelations(note, [saved, { id: 'note-two', title: 'Second note', links: [{ id: saved.id }] }, { id: 'incoming', title: 'Incoming note', links: [saved.id] }])
      assert.deepEqual(relations, [
        { id: 'note-two', title: 'Second note', direction: 'Linked both ways' },
        { id: 'not-listed', title: 'Archived fact', direction: 'Links to' },
        { id: 'outgoing', title: 'Outgoing fact', direction: 'Links to' },
        { id: 'incoming', title: 'Incoming note', direction: 'Linked from' },
      ])
    })

    await t.test('SSR begins with honest loading, no fake notes, and labeled controls', () => {
      const html = renderToStaticMarkup(createElement(MemoryPanel, { botId: 'bot-a', botName: 'Research', onBack() {}, onClose() {} }))
      assert.match(html, /aria-label="Research memory"/)
      assert.match(html, /Loading notes…/)
      assert.match(html, /Only explicit notes live here/)
      assert.match(html, /Memory tool calls stay visible in chat/)
      assert.match(html, /aria-label="Search memory titles or IDs"/)
      for (const label of ['Browse', 'Edit', 'New', 'Close memory', 'Back to bot details']) assert.ok(html.includes(label))
      assert.doesNotMatch(html, /No saved notes yet|Tea preference|Saved to memory/)
      const missingBot = renderToStaticMarkup(createElement(MemoryPanel, { botName: 'No bot' }))
      assert.match(missingBot, /Select a bot/)
      assert.doesNotMatch(missingBot, /Loading notes/)
    })

    await t.test('note view renders safe Markdown, provenance, update time, and navigable relations', () => {
      const html = renderToStaticMarkup(createElement(MemoryNote, {
        note: { ...saved, body: `${saved.body}\n\n<script>alert(1)</script>\n\n![Tracking](https://example.com/pixel)` },
        notes: [{ id: 'note-two', title: 'Related note', links: [] }], onNavigate() {},
      }))
      assert.match(html, /<strong>Green tea<\/strong>/)
      assert.match(html, /message-one/)
      assert.match(html, /dateTime="2026-09-20T12:30:00.000Z"/i)
      assert.match(html, /Last updated/)
      assert.match(html, /Related note/)
      assert.match(html, /Links to/)
      assert.match(html, /<button type="button"><span>Related note/)
      assert.doesNotMatch(html, /<script|<img/)
      const partial = renderToStaticMarkup(createElement(MemoryNote, { note: { ...saved, links: [], sourceMessageIds: [], updatedAt: null }, notes: [], listReady: false, onNavigate() {} }))
      assert.match(partial, /Update time unavailable/)
      assert.match(partial, /Load the note list to check incoming links/)
      assert.match(partial, /No source messages recorded/)
    })
  } finally { await vite.close() }
})
