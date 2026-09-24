#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { runProvider, providerCommand } from '@bunji/core/runtime'
import type { BotStore } from '@bunji/core/bot-store'
import { BunjiSession } from './session.ts'
import { BotClient } from '@bunji/shared/bot-client'
import { ChatClient } from '@bunji/shared/chat-client'
import { botTransport } from '@bunji/shared/bot-api'
import { cliBot } from '@bunji/shared/bots'
import { errorMessage } from '@bunji/shared/errors'
import { isProvider, normalizeMode, providers, runtimes, supportsModel } from '@bunji/shared/runtimes'
import type { Effort } from '@bunji/shared/types'
import { safeText } from './format.ts'
import { ensureChatService } from './service.ts'
import type { ChatServiceConnection } from './service.ts'
import { routeAutoPrompt } from '@bunji/shared/auto-mode'

const HELP = `bunji — the BunjiBox terminal workbench

Usage:
  bunji                           Open the full-screen app
  bunji --provider claude          Start with Claude
  bunji --model gpt-6-astra        Start with Astra
  bunji --effort high              Set reasoning effort
  bunji --cwd /path/to/project     Work in a chosen folder
  bunji -p "your prompt"           Print one response, then exit
  bunji -p "your prompt" --json    Stream structured activity and result
  bunji --demo                    Offline interface demo (no model calls)

Keyboard:
  Enter sends · Ctrl+J new line · Tab changes pane · Esc returns to chat
  Ctrl+K commands · Ctrl+B bots · Ctrl+G models · Ctrl+E effort
  Ctrl+T activity · Ctrl+L tokens · Ctrl+U usage · Ctrl+P Markdown preview
  Ctrl+X stop · Ctrl+C exit · PgUp/PgDn scroll

Claude and Codex use their existing local logins. Computer access comes from
the selected bot's shared Settings profile; it is never inferred from --cwd.
Shared chats always include this bot's memory tools.
Interactive chats are saved and shared with the web app.
Exit detaches; Ctrl+X or /stop cancels. The local service starts if needed.
/memory [query] lists notes · /recall ID reads one · /older loads history.
Ask the bot to remember a useful fact in any message. /remember still works as an alias.
The -p mode is a direct, stateless request; --demo stays offline.
`

let workspaceStore: BotStore | undefined, sharedBots: BotClient | undefined, session: BunjiSession | undefined
try {
  const { values, positionals } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    cwd: { type: 'string' }, print: { type: 'string', short: 'p' }, json: { type: 'boolean' }, demo: { type: 'boolean' },
  }, allowPositionals: true })
  if (values.help || positionals[0] === 'help') { process.stdout.write(HELP); process.exit(0) }
  if (values.version) { process.stdout.write('bunji 0.1.0\n'); process.exit(0) }
  if (positionals.length) throw new Error('Use bunji -p "prompt" for a one-shot request, or bunji for the app.')
  if (values.json && values.print === undefined) throw new Error('--json requires -p "prompt".')
  if (values.demo && values.print !== undefined) throw new Error('--demo is an interactive preview. Run bunji --demo.')
  if (values.cwd) process.chdir(resolve(values.cwd))
  if (values.print === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('The full-screen app needs a terminal. Use bunji -p "prompt" in scripts.')
  let service: ChatServiceConnection | undefined
  if (values.demo) session = (await import('./demo.ts')).createDemoSession()
  else {
    let chatClient: ChatClient | undefined
    if (values.print === undefined) {
      service = await ensureChatService({ cwd: process.cwd(), explicitCwd: values.cwd !== undefined })
      const { baseUrl } = service
      if (service.notice) process.stderr.write(safeText(service.notice) + '\n')
      sharedBots = new BotClient(botTransport((path, options) => fetch(baseUrl + path, options)))
      chatClient = new ChatClient({ baseUrl })
    } else {
      const { openBotStore } = await import('@bunji/core/bot-store')
      workspaceStore = openBotStore()
      sharedBots = new BotClient(workspaceStore)
    }
    await sharedBots.initialize()
    session = new BunjiSession({ bots: sharedBots.getSnapshot().bots.map(cliBot), botClient: values.print === undefined ? sharedBots : null, chatClient })
  }
  const override = { ...session.bot }
  if (values.provider) {
    if (!isProvider(values.provider)) throw new Error('Unknown provider.')
    override.provider = values.provider; override.model = runtimes[values.provider].models[0].id
  }
  if (values.model) {
    const provider = providers.find(id => supportsModel(id, values.model))
    if (!provider || (values.provider && values.provider !== provider)) throw new Error('Model does not belong to the selected provider.')
    override.provider = provider; override.model = values.model
  }
  // providerCommand below rejects an effort the model does not support.
  if (values.effort) override.effort = values.effort as Effort
  override.mode = normalizeMode(override.provider, override.mode)
  // Validate exact CLI arguments before normalizeRuntime can fall back.
  const selected = { ...session.bot, ...override }
  const validationPrompt = values.print ?? 'validate settings'
  // An explicit --cwd means the caller intentionally selected a workspace.
  // Keep the historical one-shot behavior and resolve Auto to Agent there.
  const validationMode = selected.mode === 'auto'
    ? values.print !== undefined && values.cwd !== undefined ? 'agent' : routeAutoPrompt(selected.provider, validationPrompt).mode
    : selected.mode
  providerCommand({ ...selected, mode: validationMode, prompt: validationPrompt }, { computer: validationMode === 'agent' ? selected.computer : undefined })
  if (values.provider || values.model || values.effort) session.update(override)
  if (values.print !== undefined) {
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    const oneShotBot = { ...session.bot }
    const oneShotMode = oneShotBot.mode === 'auto'
      ? values.cwd !== undefined ? 'agent' : routeAutoPrompt(oneShotBot.provider, values.print).mode
      : oneShotBot.mode
    const result = await runProvider({ ...oneShotBot, mode: oneShotMode, prompt: values.print }, {
      signal: controller.signal,
      ...(oneShotMode === 'agent' ? { computer: oneShotBot.computer } : {}),
      onActivity: values.json ? activity => process.stdout.write(JSON.stringify({ type: 'activity', activity }) + '\n') : undefined,
    })
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    if (values.json) process.stdout.write(JSON.stringify({ type: 'result', ...result }) + '\n')
    else if (result.text) process.stdout.write(safeText(result.text) + '\n')
    if (!result.ok) { if (!values.json) process.stderr.write(safeText(result.error || 'Request failed.') + '\n'); process.exitCode = controller.signal.aborted ? 130 : 1 }
  } else {
    const [{ render }, { default: App }] = await Promise.all([import('ink'), import('./app.ts')])
    const interactive = session
    sharedBots?.start()
    // Outside the demo, the service connection was made above.
    const app = render(createElement(App, { session: interactive, ...(values.demo ? { persist: async () => {}, cwd: 'DEMO · no provider calls or saved settings' } : { cwd: service!.cwd }) }), {
      alternateScreen: true, incrementalRendering: true, maxFps: 24, exitOnCtrlC: false,
    })
    const stop = () => { interactive.dispose(); app.unmount() }
    process.once('SIGTERM', stop); process.once('SIGHUP', stop)
    try { await app.waitUntilExit() }
    finally { interactive.dispose(); process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop) }
  }
} catch (error) {
  process.stderr.write('bunji: ' + safeText(errorMessage(error)) + '\n')
  process.exitCode = 1
} finally {
  session?.dispose()
  sharedBots?.stop()
  await sharedBots?.flush()
  if (sharedBots?.getSnapshot().pending) { process.stderr.write(safeText(sharedBots.getSnapshot().error) + '\n'); process.exitCode = 1 }
  workspaceStore?.close()
}
