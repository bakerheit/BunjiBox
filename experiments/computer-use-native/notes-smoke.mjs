// Explicit live test: creates ONE new Apple Note. Never edits an existing note.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { setTimeout as settle } from 'node:timers/promises'
import { launchNativeClient } from '../computer-use-native-bridge/child-client.mjs'

if (!process.argv.includes('--create-test-note')) throw new Error('Pass --create-test-note to create one new Apple Note.')
const client = launchNativeClient({ helper: resolve('experiments/computer-use-native/.build/lab/Bunji Native Lab.app/Contents/MacOS/BunjiNativeLab'), target: 'com.apple.Notes' })
const text = `BunjiBox native test ${new Date().toISOString()} — created through native computer-use. Safe to delete.`
try {
  const status = await client.request('status')
  assert.ok(status.screenRecording && status.accessibility, 'macOS permissions must already be granted')
  await client.request('focus')
  await settle(400)
  let frame = await client.request('observe')
  assert.equal(frame.capture, 'ScreenCaptureKit')
  assert.ok(Buffer.from(frame.image.data, 'base64').length > 4000)
  await client.request('act', { frameId: frame.frameId, action: { type: 'key', key: 'command+n' } })
  await settle(500)
  frame = await client.request('observe')
  // Require exactly one blank editor after New Note. Never select-all/replace.
  const editors = frame.elements.filter(element => element.role === 'AXTextArea')
  assert.equal(editors.length, 1, `Expected one new editor; found ${editors.length}. No text was written.`)
  assert.equal(editors[0].value.trim(), '', 'Editor is not empty. No text was written.')
  await client.request('act', { frameId: frame.frameId, action: { type: 'type', text } })
  await settle(500)
  frame = await client.request('observe')
  assert.ok(frame.elements.some(element => element.role === 'AXTextArea' && element.value.includes(text)), 'Typed note must be independently read back through Accessibility')
  console.log('PASS real Apple Notes: ScreenCaptureKit image, new blank note, native typing, Accessibility read-back.')
  console.log(`Created test note: ${text}`)
  await client.request('stop')
} finally { client.close() }
