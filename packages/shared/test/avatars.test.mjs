import test from 'node:test'
import assert from 'node:assert/strict'
import { distinctAvatarShapes } from '../src/avatars.js'
import { avatarValue, shapes, makeBot, patchBot, cliBot, cliChanges } from '../src/bots.js'

test('six distinct avatars validate and round trip through CLI edits', () => {
  assert.equal(distinctAvatarShapes.length, 6)
  assert.equal(new Set(distinctAvatarShapes.map(shape => shape.path)).size, 6)
  for (const shape of distinctAvatarShapes) {
    const avatar = { shape: shape.name, color: '#00ad9c', image: null }
    const bot = makeBot({ id: 'shape-check', avatar })
    assert.deepEqual(avatarValue(avatar), avatar)
    assert.deepEqual(patchBot(bot, cliChanges({ shape: cliBot(bot).shape })).avatar, avatar)
    assert.ok(shape.label && shape.path && Number.isFinite(shape.cx) && Number.isFinite(shape.cy))
  }
})

test('legacy avatar defaults, IDs, images and unrelated profile edits remain intact', () => {
  const legacy = { hexagon: '⬡', circle: '●', square: '■', diamond: '◆', triangle: '▲', pebble: '●', pill: '▬', cloud: '☁', drop: '♦' }
  assert.deepEqual(avatarValue(), { shape: 'hexagon', color: '#777777', image: null })
  for (const [shape, glyph] of Object.entries(legacy)) {
    assert.equal(shapes[shape], glyph)
    for (const image of [null, '/teal-bot.png', 'data:image/png;base64,YQ==']) {
      const avatar = { shape, color: '#8247e5', image }
      const bot = makeBot({ id: 'legacy-check', avatar })
      assert.deepEqual(patchBot(bot, { name: 'Renamed' }).avatar, avatar)
      assert.deepEqual(bot.avatar, avatar)
    }
  }
})
