import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createElement } from 'react'
import { render } from 'ink'
import xterm from '@xterm/headless'
import App from './app.mjs'
import { BunjiSession } from './session.mjs'

async function terminalApp(t, columns = 120, rows = 36) {
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, convertEol: true })
  await new Promise(resolve => terminal.write('ORIGINAL_SHELL_PROMPT', resolve))
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = raw => { stdin.isRaw = raw }
  stdin.ref = stdin.unref = () => stdin
  let raw = ''
  const stdout = new Writable({ write(chunk, _encoding, done) { raw += chunk.toString(); terminal.write(chunk.toString(), done) } })
  Object.assign(stdout, { isTTY: true, columns, rows })
  const calls = [], saves = []
  const session = new BunjiSession({
    status: async () => ({ connected: true }),
    usage: async () => ({ providers: { codex: { label: 'Codex', windows: [{ label: 'Five-hour window', usedPercent: 25, remainingPercent: 75, resetsAt: null }] } } }),
    run: async (options, { onActivity }) => {
      calls.push(options)
      const activity = { id: 'cmd', kind: 'tool', title: 'Run command', status: 'running', input: 'printf TEST_TOOL_OK' }
      onActivity(activity)
      onActivity({ ...activity, status: 'complete', output: 'TEST_TOOL_OK', exitCode: 0 })
      return { ok: true, text: '## Hello\n\n- **Ready** to help', usage: { inputTokens: 100, outputTokens: 24, cachedInputTokens: 50, totalTokens: 124 }, durationMs: 20 }
    },
  })
  const app = render(createElement(App, { session, cwd: '/test/workspace', persist: async bots => saves.push(bots) }), { stdin, stdout, stderr: stdout, patchConsole: false, interactive: true, alternateScreen: true, incrementalRendering: true, exitOnCtrlC: false, maxFps: 60, kittyKeyboard: { mode: 'disabled' } })
  t.after(async () => { app.unmount(); await app.waitUntilExit(); app.cleanup(); terminal.dispose(); stdin.destroy(); stdout.destroy() })
  const flush = async () => { await delay(35); await app.waitUntilRenderFlush(); await new Promise(resolve => terminal.write('', resolve)) }
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n')
  const key = async value => { stdin.write(value); await flush() }
  const resize = async (cols, newRows) => { terminal.resize(cols, newRows); stdout.columns = cols; stdout.rows = newRows; stdout.emit('resize'); await flush() }
  await flush()
  return { terminal, session, app, stdin, screen, key, resize, calls, saves, raw: () => raw }
}

test('full-height terminal: send, model/effort, paste, panels, bots, resize and clean exit', async t => {
  const ui = await terminalApp(t)
  assert.equal(ui.terminal.buffer.active.type, 'alternate')
  assert.match(ui.screen(), /BUNJIBOX/)
  assert.match(ui.screen(), /ACTIVITY/)
  assert.match(ui.screen().split('\n').at(-1), /Commands/)
  assert.equal(ui.terminal.buffer.active.baseY, 0, 'the full-screen UI must not scroll past its terminal height')

  await ui.key('\u0005') // Ctrl+E: effort
  assert.match(ui.screen(), /MEDIUM/)
  await ui.key('\u001b[C')
  await ui.key('\r')
  assert.equal(ui.session.bot.effort, 'high')
  await ui.key('\u0007') // Ctrl+G: models (Ctrl+M is Enter)
  assert.match(ui.screen(), /GPT-6 Astra/)
  await ui.key('\u001b[A')
  await ui.key('\r')
  assert.equal(ui.session.bot.provider, 'claude')
  assert.equal(ui.session.bot.model, 'haiku')

  await ui.key('\u001b[200~first **line**\r\nsecond\u001b[201~')
  await ui.key('\n') // Ctrl+J
  await ui.key('third')
  await ui.key('\u0010') // Ctrl+P preview
  assert.match(ui.screen(), /PREVIEW/)
  assert.doesNotMatch(ui.screen(), /\*\*line\*\*/)
  await ui.key('\u001b')
  await ui.key('\r')
  assert.equal(ui.calls.length, 1)
  assert.match(ui.calls[0].prompt, /first \*\*line\*\*\nsecond\nthird/)
  assert.equal(ui.calls[0].model, 'haiku')
  assert.equal(ui.calls[0].effort, 'high')
  assert.match(ui.screen(), /Ready to help/)
  assert.doesNotMatch(ui.screen(), /\*\*Ready\*\*/)

  await ui.key('\u0014') // Ctrl+T
  await ui.key('\r')
  assert.match(ui.screen(), /TEST_TOOL_OK/)
  await ui.key('\u000c') // Ctrl+L
  assert.match(ui.screen(), /CONVERSATION TOTAL/)
  assert.match(ui.screen(), /124 tokens/)
  await ui.key('\u0015') // Ctrl+U
  assert.match(ui.screen(), /25% used/)

  await ui.resize(80, 24)
  assert.match(ui.screen(), /USAGE/)
  assert.doesNotMatch(ui.screen(), /BUNJIBOX/)
  assert.equal(ui.terminal.buffer.active.baseY, 0)
  await ui.key('\u001b')
  assert.match(ui.screen(), /MESSAGE/)
  await ui.key('\u000e') // Ctrl+N
  await ui.key('Helper')
  await ui.key('\r')
  assert.equal(ui.session.bot.name, 'Helper')
  assert.equal(ui.session.requests.length, 0)
  assert.ok(ui.saves.some(bots => bots.some(bot => bot.name === 'Helper')))

  await ui.resize(44, 16)
  assert.match(ui.screen(), /MESSAGE/)
  assert.equal(ui.terminal.buffer.active.baseY, 0)
  await ui.resize(30, 10)
  assert.match(ui.screen(), /Resize to at least/)
  await ui.resize(120, 36)
  await ui.key('\u0003')
  await ui.app.waitUntilExit()
  assert.equal(ui.stdin.isRaw, false)
  assert.equal(ui.terminal.buffer.active.type, 'normal')
  assert.match(ui.screen(), /ORIGINAL_SHELL_PROMPT/)
  assert.ok(ui.raw().includes('\u001b[?2004l'), 'bracketed paste is disabled on exit')
})
