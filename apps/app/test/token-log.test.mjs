import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

test('request details distinguish estimates, exact provider counts, unavailable values, and stack on mobile', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const vite = await createServer({
    configFile: false, root, plugins: [react()], resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  try {
    const { default: TokenLog } = await vite.ssrLoadModule('/src/TokenLog.jsx')
    const request = {
      id: 'codex-record', serverId: 'codex-record', provider: 'codex', modelLabel: 'GPT-5.6 Luna', effort: 'low',
      status: 'complete', startedAt: Date.now(), durationMs: 9727, preview: 'Hi, you are Chip2', activities: [], contextTurns: 0, omittedTurns: 0, memoryWrite: true,
      usage: { inputTokens: 21_513, outputTokens: 22, cachedInputTokens: 11_008, cacheWriteTokens: null, reasoningOutputTokens: null, totalTokens: 21_535, source: 'Codex turn usage' },
      usageBreakdown: {
        version: 1, estimator: 'utf8-bytes-divided-by-4', payloadMode: 'combined-prompt',
        userMessage: { characters: 58, utf8Bytes: 58, words: 11, estimatedTokens: 15 },
        bunjiContext: { characters: 1044, utf8Bytes: 1044, words: 161, estimatedTokens: 261, historyTurns: 0 },
        providerHarnessUnknown: { estimatedTokens: 21_237, status: 'estimated', reason: 'Provider input minus the two local text estimates.' },
      },
    }
    const html = renderToStaticMarkup(createElement(TokenLog, { requests: [request], botName: 'Chip2', compact: true, onClose() {} }))
    for (const label of ['Input attribution', 'Typed message', 'Bunji context &amp; history', 'Provider harness / unknown', 'Provider input', 'Provider output', 'Cache read', 'Cache write', 'Reasoning output', 'Provider total']) assert.ok(html.includes(label), label)
    assert.match(html, /~15 tokens/)
    assert.match(html, /~21,237 tokens/)
    assert.match(html, />Unavailable</)
    assert.match(html, /11,008/)
    assert.match(html, /Exact source: Codex turn usage/)
    const older = renderToStaticMarkup(createElement(TokenLog, { requests: [{ ...request, id: 'old', usageBreakdown: null }], botName: 'Chip2', compact: true, onClose() {} }))
    assert.match(older, /attribution is unavailable for this older request/i)
    const css = await readFile(new URL('../src/TokenLog.css', import.meta.url), 'utf8')
    assert.match(css, /@media \(max-width:640px\)[\s\S]*\.token-attribution-grid\s*\{\s*grid-template-columns:1fr;/)
  } finally { await vite.close() }
})
