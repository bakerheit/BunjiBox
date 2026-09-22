import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('mode picker is explicit about provider support and tool availability', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  try {
    const { default: ModePicker } = await vite.ssrLoadModule('/src/ModePicker.jsx')
    const codex = renderToStaticMarkup(createElement(ModePicker, { provider: 'codex', mode: 'auto', onChange() {} }))
    assert.match(codex, /aria-label="Run mode"/)
    assert.match(codex, /aria-pressed="true"[^>]*>Auto/)
    assert.match(codex, /lets the selected model hand off to Agent/)
    assert.match(codex, />Chat<\/button>/)
    assert.match(codex, />Agent<\/button>/)

    const codexChat = renderToStaticMarkup(createElement(ModePicker, { provider: 'codex', mode: 'chat', onChange() {} }))
    assert.match(codexChat, /signed-in Codex account—not ChatGPT consumer chat or an OpenAI API/)

    const openrouter = renderToStaticMarkup(createElement(ModePicker, { provider: 'openrouter', mode: 'chat', onChange() {} }))
    assert.match(openrouter, /Direct OpenRouter API chat/)
    assert.match(openrouter, /disabled=""[^>]*>Auto<\/button>/)
    assert.match(openrouter, /disabled=""[^>]*>Agent<\/button>/)
  } finally { await vite.close() }
})
