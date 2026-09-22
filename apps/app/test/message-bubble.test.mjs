import test from 'node:test'
import assert from 'node:assert/strict'
import { messageBubbleStyle } from '../src/message-bubble.js'

test('only assistant bubbles use avatar color; malformed and white colors stay neutral', () => {
  for (const color of ['#ee1734', '#087ee7', '#ffffff', 'invalid']) {
    assert.equal(messageBubbleStyle('user', { color }), undefined)
    assert.equal(messageBubbleStyle('error', { color }), undefined)
  }
  assert.notDeepEqual(messageBubbleStyle('bot', { color: '#ee1734' }), messageBubbleStyle('bot', { color: '#087ee7' }))
  assert.deepEqual(messageBubbleStyle('bot', { color: '#ffffff' }), { backgroundColor: 'rgb(45, 45, 45)' })
  assert.deepEqual(messageBubbleStyle('bot', { color: 'url(secret)' }), messageBubbleStyle('bot', null))
})
