import { BunjiSession, defaultBots } from './session.mjs'

// Explicit offline UI preview, never mixed with real subscription usage.
export function createDemoSession() {
  return new BunjiSession({
    bots: defaultBots(),
    status: async () => ({ connected: true, plan: 'Demo · no provider calls' }),
    usage: async () => ({ checkedAt: new Date().toISOString(), providers: Object.fromEntries(['codex', 'claude'].map(id => [id, { id, label: id + ' · DEMO', connected: true, plan: 'Sample data', windows: [{ label: 'Demo window', usedPercent: 25, remainingPercent: 75, resetsAt: null }] }])) }),
    run: async (_options, { signal, onActivity }) => {
      const activities = []
      const publish = item => { const i = activities.findIndex(value => value.id === item.id); if (i < 0) activities.push(item); else activities[i] = item; onActivity(item) }
      const wait = () => new Promise(resolve => { if (signal.aborted) { resolve(); return }; const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, 650); signal.addEventListener('abort', done, { once: true }) })
      publish({ id: 'thought', kind: 'reasoning', title: 'Sample reasoning summary', status: 'complete', text: 'This is a **demo** of an expandable provider summary.' })
      await wait()
      if (!signal.aborted) publish({ id: 'tool', kind: 'tool', title: 'Demo command', input: 'printf BUNJI_READY', status: 'running' })
      await wait()
      if (!signal.aborted) publish({ id: 'tool', kind: 'tool', title: 'Demo command', input: 'printf BUNJI_READY', output: 'BUNJI_READY', exitCode: 0, status: 'complete' })
      return { ok: !signal.aborted, text: signal.aborted ? '' : '## Welcome to Bunji\n\nYour terminal workbench is ready.\n\n- **Claude and Codex** model picker\n- Live tool activity and token logs\n- Markdown in both directions\n\n```js\nconst greet = name => `Hello, ${name}!`;\n```\n\n| View | Shortcut |\n| --- | --- |\n| Models | Ctrl+G |\n| Effort | Ctrl+E |\n\nThis is an **offline demo**. No model request was made.', activities, usage: null, durationMs: 1300 }
    },
  })
}
