// Drives only the helper's disposable AppKit fixture. Never captures another app.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const helper = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'experiments/computer-use-native/.build/lab/Bunji Native Lab.app/Contents/MacOS/BunjiNativeLab')
const screenshots = process.argv.includes('--screenshots') ? await mkdtemp(resolve(tmpdir(), 'bunji-native-fixture-')) : null
const child = spawn(helper, ['--stdio', '--target', 'fixture'], { env: { ...process.env, BUNJI_NATIVE_EXPERIMENT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
let counter = 0
const pending = new Map()
let stderr = ''
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
child.on('exit', () => { for (const item of pending.values()) item.reject(new Error(`Native helper exited: ${stderr}`)) })
const lines = createInterface({ input: child.stdout })
lines.on('line', async line => {
  const response = JSON.parse(line)
  const item = pending.get(response.id)
  if (!item) return
  pending.delete(response.id)
  if (response.result?.image && Buffer.from(response.result.image.data, 'base64').length < 4000) {
    item.reject(new Error('Native fixture screenshot is unexpectedly empty; inspect the capture path.'))
    return
  }
  if (screenshots && response.result?.image) {
    await writeFile(resolve(screenshots, `${response.id}.png`), Buffer.from(response.result.image.data, 'base64'))
  }
  if (response.error) item.reject(new Error(response.error)); else item.resolve(response.result)
})
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `smoke-${++counter}`
    const timeout = setTimeout(() => { reject(new Error(`Timed out: ${method}; ${stderr}`)); child.kill() }, 15000)
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result) }, reject: error => { clearTimeout(timeout); reject(error) } })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}
let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }
try {
  assert.equal((await request('status')).state, 'running'); pass('flag-enabled fixture helper starts')
  await request('focus')
  let frame = await request('observe')
  assert.equal(frame.capture, 'own-AppKit-view')
  assert.equal(frame.image.mimeType, 'image/png')
  assert.equal(Buffer.from(frame.image.data, 'base64').subarray(1, 4).toString(), 'PNG')
  assert.ok(frame.width > 100 && frame.height > 100); pass('real native view captured as PNG')
  await assert.rejects(request('act', { frameId: frame.frameId, action: { type: 'click', x: frame.width, y: 10 } }), /outside/); pass('actual image bounds enforced')
  await request('act', { frameId: frame.frameId, action: { type: 'press', elementId: 'draft' } })
  await assert.rejects(request('act', { frameId: frame.frameId, action: { type: 'type', text: 'replay' } }), /stale|consumed/); pass('consumed observation rejected')
  frame = await request('observe')
  await request('act', { frameId: frame.frameId, action: { type: 'type', text: 'Bunji native test ✓' } })
  frame = await request('observe')
  assert.equal(frame.elements.find(e => e.id === 'draft').value, 'Bunji native test ✓'); pass('native text editor receives Unicode text')
  await request('act', { frameId: frame.frameId, action: { type: 'press', elementId: 'save' } })
  frame = await request('observe')
  assert.equal(frame.elements.find(e => e.id === 'saved').value, 'Saved: Bunji native test ✓'); pass('native button dispatch and result observation')
  await assert.rejects(request('act', { frameId: frame.frameId, action: { type: 'key', key: 'command+q' } }), /Unsupported key/); pass('unlisted shortcuts rejected')
  assert.equal((await request('stop')).state, 'stopped')
  await assert.rejects(request('act', { frameId: frame.frameId, action: { type: 'press', elementId: 'save' } }), /paused|stopped/)
  await assert.rejects(request('focus'), /paused|stopped/)
  await assert.rejects(request('observe'), /paused|stopped/); pass('stop blocks action, focus and capture')
  console.log(`${checks} native fixture checks passed. No Apple Notes content accessed.`)
  if (screenshots) console.log(`Fixture screenshots: ${screenshots}`)
} finally {
  child.stdin.end()
  lines.close()
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
  kill.unref()
  child.once('exit', () => clearTimeout(kill))
}
