import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import wrapAnsi from 'wrap-ansi'
import { runtimes, effortSteps } from '@bunji/core/runtime'
import { colors, colorValues, shapes } from '@bunji/shared/bots'
import { count, fit, markdownLines, plainLines, safeText, statusLabel, tokenLines, transcriptLines, usageLines, viewport } from './format.mjs'

const h = React.createElement
const modelOptions = Object.entries(runtimes).flatMap(([provider, runtime]) => runtime.models.map(model => ({ ...model, provider, label: runtime.label + ' · ' + model.label })))
function computerDetails(bot, width) {
  const access = bot.computer || { scope: 'none', level: 'read', folder: null, network: 'off' }
  if (access.scope === 'folder') return ['Computer folder', ...plainLines(safeText(access.folder || 'Not selected'), Math.max(1, width)), `Mode · ${access.level === 'auto' ? 'allow changes' : access.level === 'ask' ? 'old Ask mode unavailable' : 'read only'}`]
  if (access.scope === 'machine') return ['Computer · This Mac', 'Full access · commands and changes run without individual approval.']
  return ['Computer · chat and memory only']
}
const commands = [
  ['model', 'Choose Claude or Codex and a model'], ['effort', 'Adjust the reasoning slider'],
  ['bots', 'Switch bots'], ['new', 'Create a bot'], ['name', 'Rename this bot'],
  ['description', 'Edit the bot purpose'], ['color', 'Pick an avatar color'], ['shape', 'Pick an avatar shape'],
  ['activity', 'Inspect tool calls and reasoning summaries'], ['tokens', 'Open the token log'],
  ['usage', 'View subscription meters'], ['details', 'View bot settings'], ['computer', 'View computer access'], ['preview', 'Preview Markdown draft'],
  ['memory', 'List or search this bot’s memory'], ['recall', 'Read a memory note by ID'],
  ['older', 'Load older shared messages'],
  ['stop', 'Stop the active request'], ['help', 'Keys and commands'], ['quit', 'Exit Bunji'],
]

function Pane({ title, width, height, active, color = 'cyan', children }) {
  return h(Box, { width, height, flexShrink: 0, flexDirection: 'column', borderStyle: 'round', borderColor: active ? color : 'gray', paddingX: 1, overflow: 'hidden' },
    h(Text, { bold: true, color: active ? color : 'gray', wrap: 'truncate' }, title), children)
}

function Lines({ lines, height, width, offset = 0, fromBottom = false }) {
  const view = viewport(lines, height, offset, fromBottom)
  return h(Box, { flexDirection: 'column', height, overflow: 'hidden' }, view.lines.map((line, index) => h(Text, { key: index, wrap: 'truncate' }, fit(line || ' ', width))))
}

function Editor({ draft, cursor, width, height, focused }) {
  const before = draft.slice(0, cursor)
  const char = [...draft.slice(cursor)][0] || ' '
  const display = before + (focused ? '\u001b[7m' + (char === '\n' ? ' ' : char) + '\u001b[27m' + (char === '\n' ? '\n' : '') : char) + draft.slice(cursor + (cursor < draft.length ? char.length : 0))
  // ANSI is generated locally only. User escape sequences are removed on input.
  const rows = plainLines(before, width).length
  const lines = markdownEditorLines(display, width)
  const start = Math.max(0, rows - height)
  return h(Box, { flexDirection: 'column', height, overflow: 'hidden' }, draft || focused
    ? lines.slice(start, start + height).map((line, i) => h(Text, { key: i, wrap: 'truncate' }, line))
    : h(Text, { dimColor: true }, 'Message your bot…'))
}

// Keep input Markdown literal; render a separate preview on request.
function markdownEditorLines(value, width) { return wrapAnsi(value, Math.max(1, width), { hard: true, trim: false }).split('\n') }

export default function BunjiApp({ session, persist, cwd = process.cwd() }) {
  useSyncExternalStore(callback => { session.on('change', callback); return () => session.off('change', callback) }, () => session.revision)
  const { columns, rows } = useWindowSize()
  const { exit } = useApp()
  const [focus, setFocus] = useState('input')
  const [panel, setPanel] = useState('activity')
  const [panelOpen, setPanelOpen] = useState(true)
  const [drafts, setDrafts] = useState({})
  const [cursor, setCursor] = useState(0)
  const [scroll, setScroll] = useState({ chat: 0, panel: 0 })
  const [selectedActivity, setSelectedActivity] = useState(0)
  const [expanded, setExpanded] = useState(new Set())
  const [modal, setModal] = useState(null)
  const [notice, setNotice] = useState('Ready · /help for commands')
  const [tick, setTick] = useState(0)
  const saveQueue = useRef(Promise.resolve())
  const memoryBot = useRef(session.activeId)
  const bot = session.bot, requests = session.requests
  const draft = drafts[bot.id] || ''
  const activities = requests.flatMap((request, index) => request.activities.map(item => ({ ...item, key: request.id + ':' + item.id, requestNumber: index + 1 })))
  const width = Math.max(1, columns || 80), height = Math.max(1, rows || 24)
  const narrow = width < 108
  const showBots = width >= 92
  const sidebarWidth = showBots ? 22 : 0
  const panelWidth = !narrow && panelOpen ? Math.min(40, Math.floor(width * .29)) : 0
  const centerWidth = Math.max(1, width - sidebarWidth - panelWidth)
  const bodyHeight = Math.max(1, height - 3)
  const visibleBots = Math.max(1, Math.floor((bodyHeight - 5) / 3))
  const firstVisibleBot = Math.max(0, session.bots.indexOf(bot) - visibleBots + 1)
  const composeHeight = Math.min(7, Math.max(5, Math.floor(height * .23)))
  const chatHeight = Math.max(1, bodyHeight - composeHeight - 1)
  const contentWidth = Math.max(1, centerWidth - 4)
  const contentHeight = Math.max(1, chatHeight - 3)
  const panelOnly = narrow && focus === 'panel'

  useEffect(() => {
    session.connect().catch(() => setNotice('Connection check failed. Use /usage to check sign-in.'))
    return () => session.dispose()
  }, [session])
  useEffect(() => {
    const switched = memoryBot.current !== bot.id
    memoryBot.current = bot.id
    if (switched && panel === 'memory') session.readMemory().catch(() => {})
  }, [bot.id, panel, session])
  useEffect(() => {
    if (!session.busy) return
    const timer = setInterval(() => setTick(value => value + 1), 180)
    return () => clearInterval(timer)
  }, [session.busy])

  const save = () => {
    if (!persist) return // Production saves field edits through session.botClient.
    const bots = session.bots.map(item => ({ ...item }))
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => persist(bots)).catch(() => setNotice('Could not save bot settings. They still work for this session.'))
  }
  const update = changes => { session.update(changes); save() }
  const setDraft = value => setDrafts(current => ({ ...current, [bot.id]: value }))
  const insert = value => {
    const clean = safeText(value.replace(/\r\n?/g, '\n'))
    const available = Math.max(0, 9000 - draft.length)
    const addition = clean.slice(0, available)
    setDraft(draft.slice(0, cursor) + addition + draft.slice(cursor)); setCursor(cursor + addition.length)
    if (clean.length > available) setNotice('Draft limit: 9,000 characters.')
  }
  const selectBot = id => {
    session.select(id); setCursor((drafts[id] || '').length); setScroll({ chat: 0, panel: 0 }); setSelectedActivity(0); setFocus('input')
  }
  const openPanel = type => {
    setPanel(type); setPanelOpen(true); setFocus('panel'); setScroll(current => ({ ...current, panel: 0 }))
    setSelectedActivity(Math.max(0, activities.length - 1))
    if (type === 'usage') session.refreshUsage().catch(() => setNotice('Usage check failed. Press R to retry.'))
  }
  const openPicker = type => {
    const selected = type === 'model' ? modelOptions.findIndex(item => item.id === bot.model && item.provider === bot.provider)
      : type === 'effort' ? effortSteps(bot.provider, bot.model).indexOf(bot.effort)
        : type === 'bots' ? session.bots.findIndex(item => item.id === bot.id)
          : type === 'color' ? colors.findIndex(color => colorValues[color] === bot.color) : type === 'shape' ? Object.values(shapes).indexOf(bot.shape) : 0
    setModal({ type, selected: Math.max(0, selected), value: type === 'name' ? bot.name : type === 'description' ? bot.description : '' })
  }
  const execute = (command, argument = '') => {
    if (['model', 'effort', 'bots', 'color', 'shape', 'new', 'name', 'description'].includes(command)) {
      if (argument && command === 'new') { session.addBot(safeText(argument)); save(); setCursor(0); setScroll({ chat: 0, panel: 0 }); return }
      if (argument && ['name', 'description'].includes(command)) { update({ [command]: safeText(argument).slice(0, command === 'name' ? 60 : 1800) }); return }
      openPicker(command); return
    }
    if (['activity', 'tokens', 'usage', 'details', 'computer'].includes(command)) { openPanel(command === 'computer' ? 'details' : command); return }
    if (command === 'preview') { setModal({ type: 'preview', selected: 0, value: draft }); return }
    if (command === 'help') { setModal({ type: 'help', selected: 0, value: '' }); return }
    if (command === 'memory') { openPanel('memory'); return session.readMemory({ query: argument }) }
    if (command === 'recall') {
      if (!argument) { setDraft('/recall '); setCursor(8); setFocus('input'); return }
      openPanel('memory'); return session.readMemory({ id: argument.trim() })
    }
    if (command === 'older') return session.loadOlder().then(history => {
      if (session.activeId === bot.id && !session.disposed) { setFocus('chat'); setScroll(current => ({ ...current, chat: Number.MAX_SAFE_INTEGER })); setNotice(history?.hasMore ? 'Older messages loaded. Use /older for more.' : 'All saved messages loaded.') }
    })
    if (command === 'stop') { const result = session.stop(); setNotice('Stopping request…'); return result }
    if (command === 'quit') { session.dispose(); exit(); return }
    throw new Error('Unknown command. Use /help or Ctrl+K.')
  }
  const restoreDraft = (botId, text) => {
    if (session.disposed) return
    setDrafts(current => ({ ...current, [botId]: current[botId] ? text + '\n\n' + current[botId] : text }))
    if (session.activeId === botId) setCursor(text.length)
  }
  const invokeCommand = (command, argument = '', original = '') => {
    try {
      Promise.resolve(execute(command, argument)).catch(error => {
        if (original) restoreDraft(bot.id, original)
        if (!session.disposed && session.activeId === bot.id) setNotice(safeText(error.message))
      })
    } catch (error) { if (original) restoreDraft(bot.id, original); setNotice(safeText(error.message)) }
  }
  const send = () => {
    if (!draft.trim()) return
    let text = draft.trim()
    if (draft.startsWith('/')) {
      const [, command, argument = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(draft.trim()) || []
      if (command !== 'remember') { setDraft(''); setCursor(0); invokeCommand(command, argument, draft); return }
      if (!argument.trim()) { setNotice('Type what you want the bot to remember.'); return }
      text = argument.trim() // Keep /remember as an alias for old CLI habits.
    }
    if (session.busy) { setNotice('A request is running. Ctrl+X stops it.'); return }
    const original = draft, botId = bot.id
    setDraft(''); setCursor(0); setScroll(current => ({ ...current, chat: 0 })); setNotice('Sending…')
    session.send(text).then(result => {
      if (session.disposed || !result) return
      if (result.status !== 'complete') restoreDraft(botId, original)
      if (session.activeId !== botId) return
      setNotice(result.status === 'complete' ? `Done · ${count(result.usage?.totalTokens)} tokens · ${(result.durationMs / 1000).toFixed(1)}s` : safeText(result.error || 'Request failed.'))
      if (panel === 'memory') session.readMemory().catch(() => {})
    }).catch(error => {
      if (session.disposed || error.code === 'BUNJI_DETACHED') return
      restoreDraft(botId, original)
      if (session.activeId === botId) setNotice(safeText(error.message))
    })
  }

  let options = []
  if (modal?.type === 'model') options = modelOptions
  if (modal?.type === 'bots') options = session.bots.map(item => ({ id: item.id, label: `${item.shape} ${item.name}` }))
  if (modal?.type === 'effort') options = effortSteps(bot.provider, bot.model).map(value => ({ id: value, label: value }))
  if (modal?.type === 'color') options = colors.map(value => ({ id: value, label: value }))
  if (modal?.type === 'shape') options = Object.entries(shapes).map(([id, value]) => ({ id, label: `${value}  ${id}` }))
  if (modal?.type === 'commands') options = commands.map(([id, label]) => ({ id, label: `/${id}  ${label}` })).filter(item => item.label.toLowerCase().includes(modal.value.toLowerCase()))

  const chatLines = [
    ...(session.chatClient && !session.history?.ready ? ['Loading shared history…', ''] : []),
    ...(session.history?.hasMore ? ['Earlier messages saved · /older to load', ''] : []),
    ...transcriptLines(bot, requests, contentWidth),
  ]
  const sideWidth = (panelOnly ? centerWidth : panelWidth) - 4
  let sideLines = [], activityRow = 0
  if (panel === 'tokens') {
    sideLines = tokenLines(requests, Math.max(1, sideWidth))
    if (session.chatClient) sideLines[0] = 'LOADED HISTORY TOTAL'
  }
  if (panel === 'memory') {
    const memory = session.memory
    sideLines = [safeText(bot.name) + ' · MEMORY', '', '/memory [query] · /recall ID', 'Memory is available in every chat.', '',
      ...(memory.loading ? ['Loading memory…'] : memory.error ? plainLines(memory.error, Math.max(1, sideWidth))
        : memory.note ? [safeText(memory.note.title), 'ID · ' + safeText(memory.note.id), '', ...markdownLines(memory.note.body, Math.max(1, sideWidth))]
          : memory.ready ? [
            ...(memory.query ? plainLines('Search · ' + memory.query, Math.max(1, sideWidth)) : []),
            ...memory.notes.flatMap(note => [safeText(note.title), 'ID · ' + safeText(note.id), ...plainLines(note.snippet || '', Math.max(1, sideWidth)), '']),
            ...(!memory.notes.length ? ['No memory notes found.'] : []),
          ] : ['Use /memory to load notes.']),
    ]
  }
  if (panel === 'usage') sideLines = usageLines(session.usage, session.usageLoading, Math.max(1, sideWidth))
  if (panel === 'details') sideLines = [
    `${bot.shape} ${safeText(bot.name)}`, '', ...plainLines(bot.description || 'No description yet. Press E to edit.', Math.max(1, sideWidth)), '',
    runtimes[bot.provider].label, bot.model, 'Effort · ' + bot.effort, '',
    session.connections[bot.provider]?.connected ? '● Signed in on this Mac' : '○ Sign-in needed',
    bot.provider === 'codex' ? 'codex login' : bot.provider === 'claude' ? 'claude auth login' : 'BUNJI_OLLAMA_URL · Pi Ollama endpoint', '',
    ...plainLines('Memory tools are available in every chat.', Math.max(1, sideWidth)), '', ...computerDetails(bot, sideWidth), '', 'Service working directory', ...plainLines(cwd, Math.max(1, sideWidth)), '',
    '/name · /description', '/color · /shape · /computer', '', 'Bots shared with BunjiBox.', session.chatClient ? 'Chat saved on this Mac.' : 'Chat lasts for this session.',
  ]
  if (panel === 'activity') {
    sideLines = ['↑/↓ select · Enter expand', 'PgUp/PgDn scroll details', '', ...plainLines('Provider tool calls and exposed reasoning summaries.', Math.max(1, sideWidth)), '']
    activities.forEach((item, index) => {
      if (index === selectedActivity) activityRow = sideLines.length
      sideLines.push(`${index === selectedActivity ? '›' : ' '} ${expanded.has(item.key) ? '▾' : '▸'} ${safeText(item.title)}`, `   #${item.requestNumber} · ${statusLabel(item.status)}`)
      if (expanded.has(item.key)) {
        if (item.text) sideLines.push(...markdownLines(item.text, Math.max(1, sideWidth)))
        if (item.input) sideLines.push('INPUT', ...plainLines(item.input, Math.max(1, sideWidth)))
        if (item.output) sideLines.push('OUTPUT', ...plainLines(item.output, Math.max(1, sideWidth)))
        if (typeof item.exitCode === 'number') sideLines.push(`Exit code ${item.exitCode}`)
      }
      sideLines.push('')
    })
    if (!activities.length) sideLines.push(session.busy ? 'Waiting for activity…' : 'No activity yet.')
    if (requests.some(request => request.activityLimited)) sideLines.push('Some activity was truncated.')
  }
  const sideHeight = Math.max(1, (panelOnly ? chatHeight : bodyHeight) - 3)
  const sideOffset = panel === 'activity' ? Math.max(0, activityRow - 4) + scroll.panel : scroll.panel
  const total = requests.reduce((sum, request) => sum + (request.usage?.totalTokens || 0), 0)
  const measured = requests.some(request => Number.isSafeInteger(request.usage?.totalTokens))
  const pending = requests.some(request => !Number.isSafeInteger(request.usage?.totalTokens))
  const pulse = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][tick % 10]

  usePaste(text => {
    if (modal && ['new', 'name', 'description'].includes(modal.type)) setModal(current => ({ ...current, value: (current.value + safeText(text)).slice(0, current.type === 'description' ? 1800 : 60) }))
    else if (!modal && focus === 'input') insert(text)
  })
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.ctrl && input === 'c') { session.dispose(); exit(); return }
    if (key.ctrl && input === 'x') { invokeCommand('stop'); return }
    if (modal) {
      if (key.escape) { setModal(null); return }
      if (modal.type === 'preview' || modal.type === 'help') {
        if (key.return) { setModal(null); return }
        if (key.downArrow || key.pageDown) setModal(current => ({ ...current, selected: current.selected + (key.pageDown ? 10 : 1) }))
        if (key.upArrow || key.pageUp) setModal(current => ({ ...current, selected: Math.max(0, current.selected - (key.pageUp ? 10 : 1)) }))
        return
      }
      if (['new', 'name', 'description'].includes(modal.type)) {
        if (key.return) {
          if (modal.type === 'new') { session.addBot(modal.value.trim() || 'New bot'); setCursor(0); setScroll({ chat: 0, panel: 0 }) }
          else session.update({ [modal.type]: modal.value.trim() })
          save(); setModal(null); return
        }
        if (key.backspace || key.delete) setModal(current => ({ ...current, value: [...current.value].slice(0, -1).join('') }))
        else if (!key.ctrl && !key.meta && input) setModal(current => ({ ...current, value: (current.value + safeText(input)).slice(0, current.type === 'description' ? 1800 : 60) }))
        return
      }
      if (key.upArrow || key.leftArrow) setModal(current => ({ ...current, selected: Math.max(0, current.selected - 1) }))
      else if (key.downArrow || key.rightArrow) setModal(current => ({ ...current, selected: Math.min(options.length - 1, current.selected + 1) }))
      else if (key.return && options[modal.selected]) {
        const chosen = options[modal.selected]
        setModal(null)
        if (modal.type === 'commands') invokeCommand(chosen.id)
        if (modal.type === 'model') update({ provider: chosen.provider, model: chosen.id })
        if (modal.type === 'effort') update({ effort: chosen.id })
        if (modal.type === 'bots') selectBot(chosen.id)
        if (modal.type === 'color') update({ color: chosen.id })
        if (modal.type === 'shape') update({ avatar: { shape: chosen.id, image: null } })
      } else if (modal.type === 'commands') {
        if (key.backspace || key.delete) setModal(current => ({ ...current, value: current.value.slice(0, -1), selected: 0 }))
        else if (!key.ctrl && !key.meta && input) setModal(current => ({ ...current, value: current.value + safeText(input), selected: 0 }))
      }
      return
    }
    if (key.ctrl) {
      // Ctrl+M is indistinguishable from Enter in standard terminals.
      const shortcuts = { b: 'bots', g: 'model', e: 'effort', l: 'tokens', t: 'activity', u: 'usage', o: 'details', n: 'new', p: 'preview' }
      if (input === 'k') { openPicker('commands'); return }
      if (shortcuts[input]) { invokeCommand(shortcuts[input]); return }
    }
    if (key.escape) { setFocus('input'); if (narrow) setPanelOpen(false); return }
    if (key.tab) {
      const order = ['input', 'chat', ...(showBots ? ['bots'] : []), ...(panelOpen ? ['panel'] : [])]
      setFocus(order[(order.indexOf(focus) + (key.shift ? order.length - 1 : 1)) % order.length]); return
    }
    if (key.pageUp || key.pageDown) {
      const pane = focus === 'panel' ? 'panel' : 'chat'
      const direction = pane === 'chat' ? (key.pageUp ? 1 : -1) : (key.pageUp ? -1 : 1)
      const max = pane === 'chat' ? Math.max(0, chatLines.length - contentHeight) : Math.max(0, sideLines.length - sideHeight)
      setScroll(current => ({ ...current, [pane]: Math.max(0, Math.min(max, current[pane] + direction * Math.max(1, contentHeight - 2))) })); return
    }
    if (focus === 'bots') {
      const index = session.bots.findIndex(item => item.id === bot.id)
      if (key.upArrow || key.downArrow) { const id = session.bots[(index + (key.upArrow ? session.bots.length - 1 : 1)) % session.bots.length].id; session.select(id); setCursor((drafts[id] || '').length); setScroll({ chat: 0, panel: 0 }) }
      if (key.return) { setCursor(draft.length); setFocus('input') }
      return
    }
    if (focus === 'panel') {
      if (panel === 'usage' && input === 'r') session.refreshUsage().catch(() => setNotice('Could not refresh usage.'))
      if (panel === 'details' && input === 'e') openPicker('description')
      if (panel === 'activity') {
        if (key.upArrow || key.downArrow) setScroll(current => ({ ...current, panel: 0 }))
        if (key.upArrow) setSelectedActivity(value => Math.max(0, value - 1))
        if (key.downArrow) setSelectedActivity(value => Math.min(activities.length - 1, value + 1))
        if (key.return || input === ' ') {
          const item = activities[selectedActivity]
          if (item) setExpanded(current => { const next = new Set(current); if (next.has(item.key)) next.delete(item.key); else next.add(item.key); return next })
        }
      } else if (key.upArrow || key.downArrow) setScroll(current => ({ ...current, panel: Math.max(0, Math.min(Math.max(0, sideLines.length - sideHeight), current.panel + (key.upArrow ? -1 : 1))) }))
      return
    }
    if (focus === 'chat') {
      if (key.upArrow || key.downArrow) setScroll(current => ({ ...current, chat: Math.max(0, Math.min(Math.max(0, chatLines.length - contentHeight), current.chat + (key.upArrow ? 1 : -1))) }))
      if (key.end) setScroll(current => ({ ...current, chat: 0 }))
      return
    }
    if ((key.ctrl && input === 'j') || (key.return && (key.shift || key.meta))) { insert('\n'); return }
    if (key.return) { send(); return }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'f') { setCursor(draft.length); return }
    if (key.ctrl && input === 'w') { const before = draft.slice(0, cursor).replace(/\S+\s*$/, ''); setDraft(before + draft.slice(cursor)); setCursor(before.length); return }
    if (key.home) { setCursor(draft.slice(0, cursor).lastIndexOf('\n') + 1); return }
    if (key.end) { const end = draft.indexOf('\n', cursor); setCursor(end < 0 ? draft.length : end); return }
    if (key.leftArrow) { setCursor(value => value - ([...draft.slice(0, value)].at(-1)?.length || 0)); return }
    if (key.rightArrow) { setCursor(value => Math.min(draft.length, value + ([...draft.slice(value)][0]?.length || 0))); return }
    if (key.upArrow || key.downArrow) {
      const start = draft.lastIndexOf('\n', cursor - 1) + 1, column = cursor - start
      if (key.upArrow && start > 0) { const prev = draft.lastIndexOf('\n', start - 2) + 1; setCursor(Math.min(start - 1, prev + column)) }
      if (key.downArrow) { const next = draft.indexOf('\n', cursor); if (next >= 0) { const end = draft.indexOf('\n', next + 1); setCursor(Math.min(end < 0 ? draft.length : end, next + 1 + column)) } }
      return
    }
    if (key.delete) { setDraft(draft.slice(0, cursor) + draft.slice(cursor + ([...draft.slice(cursor)][0]?.length || 0))); return }
    if (key.backspace) {
      const size = [...draft.slice(0, cursor)].at(-1)?.length || 0
      setDraft(draft.slice(0, cursor - size) + draft.slice(cursor)); setCursor(cursor - size); return
    }
    if (!key.ctrl && !key.meta && input) insert(input)
  })


  if (width < 44 || height < 16) return h(Box, { width, height, flexDirection: 'column' }, h(Text, { color: 'cyan', bold: true }, 'bunji'), h(Text, null, 'Resize to at least 44 × 16.'), h(Text, { dimColor: true }, 'Ctrl+C exits.'))

  let modalContent
  if (modal) {
    const textEntry = ['new', 'name', 'description'].includes(modal.type)
    const modalWidth = Math.max(20, Math.min(74, width - 6))
    const help = ['BUNJI · YOUR TERMINAL WORKBENCH', '',
      'Enter          Send message', 'Ctrl+J         New line (or Shift+Enter)', 'Tab / Esc      Change pane / return to composer',
      'PgUp / PgDn    Scroll chat or panel', 'Ctrl+B         Bots', 'Ctrl+G         Model and provider', 'Ctrl+E         Effort slider',
      'Ctrl+T         Tool activity', 'Ctrl+L         Token log', 'Ctrl+U         Subscription usage', 'Ctrl+O         Bot details',
      'Ctrl+N         Create bot', 'Ctrl+P         Markdown preview', 'Ctrl+K         Command palette', 'Ctrl+X         Stop request', 'Ctrl+C         Exit', '',
      'SLASH COMMANDS', ...commands.map(([id, label]) => `/${id} · ${label}`), '',
      ...(session.chatClient ? ['Chats are saved and shared with the web app.', 'Exit detaches; runs keep going on this Mac.', '/stop or Ctrl+X explicitly cancels this bot’s run.', '/older loads history; tokens cover loaded messages.']
        : ['Chats stay in memory for this demo/session.']),
      'Recent completed turns are included in the next prompt.', '',
      'Memory tools are available in every chat.', '',
      'Bot settings sync with the shared workspace on this', 'Mac. The web app and CLI see the same bots.',
    ]
    modalContent = h(Box, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: bodyHeight, width },
      h(Pane, { title: modal.type === 'commands' ? 'Commands · type to filter' : modal.type.toUpperCase(), width: modalWidth, height: Math.min(bodyHeight, modal.type === 'effort' ? 11 : textEntry ? 10 : Math.max(12, options.length + 7)), active: true, color: bot.color },
        modal.type === 'effort' ? h(Box, { flexDirection: 'column', paddingY: 1 }, h(Text, { bold: true, color: 'blueBright' }, options[modal.selected]?.label.toUpperCase()), h(Text, { dimColor: true }, bot.model), h(Text, { color: 'blueBright' }, options.map((_, index) => index === modal.selected ? '●' : index < modal.selected ? '━' : '·').join('━━━━')), h(Text, { dimColor: true }, '← lower    higher →'))
          : textEntry ? h(Box, { flexDirection: 'column' }, h(Text, { dimColor: true }, modal.type === 'new' ? 'Give your new bot a name.' : `Edit ${modal.type}.`), h(Text, { wrap: 'wrap' }, fit(safeText(modal.value), (modalWidth - 4) * 4) + '▏'))
            : modal.type === 'help' || modal.type === 'preview' ? h(Lines, { lines: modal.type === 'help' ? help : markdownLines(modal.value || 'Nothing to preview yet.', modalWidth - 4), height: Math.min(bodyHeight, 12) - 5, width: modalWidth - 4, offset: modal.selected })
              : h(Box, { flexDirection: 'column', overflow: 'hidden', flexGrow: 1 },
                modal.type === 'commands' && h(Text, { dimColor: true }, '> ' + modal.value),
                options.slice(Math.max(0, modal.selected - Math.max(1, bodyHeight - 9)), Math.max(0, modal.selected - Math.max(1, bodyHeight - 9)) + Math.max(1, bodyHeight - 7)).map((item, index) => {
                  const original = Math.max(0, modal.selected - Math.max(1, bodyHeight - 9)) + index
                  return h(Text, { key: item.id, color: original === modal.selected ? bot.color : undefined, bold: original === modal.selected, wrap: 'truncate' }, (original === modal.selected ? '› ' : '  ') + safeText(item.label))
                }), !options.length && h(Text, { dimColor: true }, 'No matching commands.')),
        h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, 'Enter confirm · Esc back'))))
  }
  return h(Box, { width, height, flexDirection: 'column', overflow: 'hidden' },
    h(Box, { height: 1, flexShrink: 0, justifyContent: 'space-between' }, h(Text, { bold: true, color: bot.color }, ` ${bot.shape} bunji `), h(Text, { dimColor: true, wrap: 'truncate' }, fit(safeText(cwd), width - 22)), h(Text, { color: session.connections[bot.provider]?.connected ? 'green' : 'gray' }, session.connections[bot.provider] ? session.connections[bot.provider].connected ? ' ● connected ' : ' ○ sign in ' : ' ◌ checking ')),
    modal ? modalContent : h(Box, { height: bodyHeight, flexShrink: 0 },
      showBots && h(Pane, { title: 'BUNJIBOX', width: sidebarWidth, height: bodyHeight, active: focus === 'bots', color: bot.color },
        h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' }, session.bots.slice(firstVisibleBot, firstVisibleBot + visibleBots).map(item => h(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 }, h(Text, { color: item.color, bold: item.id === bot.id, wrap: 'truncate' }, `${item.id === bot.id ? '›' : ' '} ${item.shape} ${safeText(item.name)}`), h(Text, { dimColor: true, wrap: 'truncate' }, '    ' + item.provider)))),
        h(Text, { dimColor: true }, 'Ctrl+N New bot'), h(Text, { dimColor: true }, 'Ctrl+U Usage')),
      h(Box, { width: centerWidth, flexDirection: 'column' },
        h(Pane, { title: panelOnly ? panel.toUpperCase() : `${bot.shape} ${safeText(bot.name)}${session.busy?.botId === bot.id ? '  ' + pulse + ' working' : ''}`, width: centerWidth, height: chatHeight, active: focus === 'chat' || panelOnly, color: bot.color }, h(Lines, { lines: panelOnly ? sideLines : chatLines, height: contentHeight, width: contentWidth, offset: panelOnly ? sideOffset : scroll.chat, fromBottom: !panelOnly })),
        h(Box, { height: 1, justifyContent: 'space-between', paddingX: 1 }, h(Text, { color: bot.color, wrap: 'truncate' }, `${runtimes[bot.provider].models.find(model => model.id === bot.model)?.label} · ${bot.effort}`), h(Text, { dimColor: true, wrap: 'truncate' }, `${pending && measured ? '≥ ' : ''}${count(measured || !requests.length ? total : null)} tokens${session.chatClient ? ' (loaded)' : ''}`)),
        h(Pane, { title: 'MESSAGE  ·  Enter send  / commands', width: centerWidth, height: composeHeight, active: focus === 'input', color: bot.color }, h(Editor, { draft, cursor, width: contentWidth, height: composeHeight - 3, focused: focus === 'input' }))),
      panelWidth > 0 && h(Pane, { title: panel.toUpperCase() + ' · Tab to focus', width: panelWidth, height: bodyHeight, active: focus === 'panel', color: bot.color }, h(Lines, { lines: sideLines, height: sideHeight, width: sideWidth, offset: sideOffset }))),
    h(Text, { color: session.busy ? 'yellow' : 'gray', wrap: 'truncate' }, fit(' ' + (session.chatError ? safeText(session.chatError) : session.busy ? `${pulse} ${session.bots.find(item => item.id === session.busy.botId)?.name} working · Ctrl+X stop` : safeText(session.botClient?.getSnapshot().error || (session.botClient?.getSnapshot().pending ? 'Saving shared bot settings…' : notice))), width)),
    h(Text, { dimColor: true, wrap: 'truncate' }, fit(width < 90 ? ' ^K Commands  ^G Model  ^E Effort  ^T Activity  ^C Exit' : ' ^K Commands  ^B Bots  ^G Model  ^E Effort  ^T Activity  ^L Tokens  ^U Usage  ^C Exit', width)))
}
