import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

test('the landing page renders every section with accurate, linked content', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const vite = await createServer({
    configFile: false, root, plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  let html
  try {
    const { default: App } = await vite.ssrLoadModule('/src/App.jsx')
    html = renderToStaticMarkup(createElement(App))
  } finally {
    await vite.close()
  }

  await t.test('every section the nav points at exists', () => {
    for (const id of ['top', 'surfaces', 'features', 'memory', 'install']) {
      assert.match(html, new RegExp(`id="${id}"`), `missing section #${id}`)
    }
  })

  await t.test('the hero states the pitch and the install path', () => {
    assert.match(html, /One agent workspace/)
    assert.match(html, /Terminal, browser, phone/)
    assert.match(html, /npm install/)
    assert.match(html, /bunji/)
  })

  await t.test('the alpha security warning survives, since it is the honest part', () => {
    assert.match(html, /LAN-only alpha/)
    assert.match(html, /no account or device authentication/i)
  })

  await t.test('the memory sample renders as a note, not as [object Object]', () => {
    assert.match(html, /morning-routine/)
    assert.match(html, /Green tea, no sugar/)
    assert.doesNotMatch(html, /\[object Object\]/)
  })

  await t.test('the hero image has real alt text and the mark is decorative', () => {
    const images = html.match(/<img[^>]*>/g) || []
    assert.ok(images.length > 0, 'expected at least one image')
    for (const img of images) assert.match(img, /alt="[^"]+"/, `image without alt text: ${img}`)
    assert.match(html, /<svg[^>]*aria-hidden="true"/)
  })

  await t.test('claims about providers and paths match the README', async () => {
    const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8')
    for (const claim of ['~/.config/bunji/memory/', 'GPT-6 Astra', 'Gemma3 1B', 'BUNJI_OLLAMA_URL', 'files_publish']) {
      assert.ok(readme.includes(claim), `README no longer mentions ${claim}; the site still does`)
      assert.ok(html.includes(claim.replace(/</g, '&lt;').replace(/>/g, '&gt;')), `site dropped ${claim}`)
    }
  })
})
