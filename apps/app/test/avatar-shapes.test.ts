import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { distinctAvatarShapes } from '../../../packages/shared/src/avatars.ts'

test('web renderer uses distinct geometry and apertures while retaining legacy eyes and images', async () => {
  const server = await createServer({ root: new URL('..', import.meta.url).pathname, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { BotAvatar, AvatarProvider, AvatarEditor } = await server.ssrLoadModule('/src/AvatarPicker.tsx')
    const picker = renderToStaticMarkup(createElement(AvatarProvider, {}, createElement(AvatarEditor)))
    for (const shape of distinctAvatarShapes) assert.ok(picker.includes(`aria-label="${shape.label} shape"`))
    for (const label of ['Avatar', 'Generate', 'Upload']) assert.ok(picker.includes(`>${label}</button>`))
    const render = value => renderToStaticMarkup(createElement(BotAvatar, { value }))
    for (const shape of distinctAvatarShapes) {
      const html = render({ shape: shape.name, color: '#00ad9c' })
      assert.ok(html.includes(shape.path), shape.name)
      assert.ok(html.includes(shape.label), shape.name)
      assert.equal((html.match(/<circle /g) || []).length, 3)
      assert.ok(!html.includes('<ellipse'))
    }
    for (const shape of ['diamond', 'circle', 'pebble', 'square', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']) {
      const html = render({ shape, color: '#8247e5' })
      assert.equal((html.match(/<ellipse /g) || []).length, 2, shape)
      assert.ok(html.includes('rotate(-18'))
    }
    const html = render({ shape: 'comet', color: '#00ad9c', image: 'data:image/png;base64,YQ==' })
    assert.ok(html.includes('<img'))
    assert.ok(!html.includes('<svg'))
  } finally { await server.close() }
})
