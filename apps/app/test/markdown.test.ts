import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('Markdown renders headings, lists, tables, code and safe links without HTML execution or image fetches', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  try {
    const { default: Markdown } = await vite.ssrLoadModule('/src/Markdown.tsx')
    const html = renderToStaticMarkup(createElement(Markdown, { text: '# Title\n\n**Bold** and *italic*.\n\n- item\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n\n[Safe](https://example.com)\n\n[Bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n![Image](https://example.com/tracker.png)' }))
    for (const tag of ['h1', 'strong', 'em', 'ul', 'table', 'pre', 'code']) assert.match(html, new RegExp(`<${tag}[ >]`))
    assert.match(html, /noopener noreferrer/)
    assert.match(html, /Copy code/)
    assert.doesNotMatch(html, /<img|onerror|javascript:/)
    assert.match(html, /\[Image: Image\]/)
    const { default: RunActivity } = await vite.ssrLoadModule('/src/RunActivity.tsx')
    const activity = renderToStaticMarkup(createElement(RunActivity, { status: 'complete', activities: [{ id: 'reason', kind: 'reasoning', title: 'Reasoning summary', status: 'complete', text: '**Checked** the inputs.' }, { id: 'tool', kind: 'tool', title: 'Run command', status: 'complete', input: 'printf OK', output: 'OK', exitCode: 0 }] }))
    assert.match(activity, /1 tool call · 1 reasoning summary/)
    assert.match(activity, /<strong>Checked<\/strong>/)
    assert.match(activity, /Exit code 0/)
    assert.equal((activity.match(/<details/g) || []).length, 3)
    assert.doesNotMatch(activity, /<details[^>]* open/)
  } finally { await vite.close() }
})
