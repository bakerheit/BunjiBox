import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Activity, ArrowUp, BookOpen, Bot, Check, ChevronDown, ChevronRight, Ellipsis, FolderOpen, Gauge, Laptop2, Menu, PanelRight, Pencil, Plus, RotateCcw, Search, Settings2, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import './App.css'
import { Avatar, AvatarEditor, AvatarProvider } from './AvatarPicker'
import { EffortPicker } from './EffortPicker'
import { automaticMode, effortSteps, normalizeRuntime, runtimes } from '@bunji/shared/runtimes'
import UsagePage from './UsagePage'
import TokenLog from './TokenLog'
import { summarizeRequests, tokenCount } from '@bunji/shared/token-usage'
import Markdown from './Markdown'
import { messageBubbleStyle } from './message-bubble'
import RunActivity from './RunActivity'
import MemoryPanel from './MemoryPanel'
import ComputerAccessPanel from './ComputerAccessPanel'
import FilesPanel from './FilesPanel'
import { ChatClient } from '@bunji/shared/chat-client'

import { createBrowserBotClient } from '@bunji/shared/bot-api'

function ModelSelect({ bot, onChange, label = 'Model', compact = false }) {
  return <label className={compact ? 'model-pill' : 'field'}>
    {compact ? null : <span>{label}</span>}
    <select aria-label={label} value={bot.provider + ':' + bot.model} onChange={event => {
      const separator = event.target.value.indexOf(':')
      const provider = event.target.value.slice(0, separator)
      const model = event.target.value.slice(separator + 1)
      onChange({ provider, model, effort: effortSteps(provider, model).includes(bot.effort) ? bot.effort : 'medium', mode: automaticMode(provider) })
    }}>
      {Object.entries(runtimes).map(([provider, runtime]) => <optgroup key={provider} label={runtime.label}>
        {runtime.models.map(model => <option key={model.id} value={provider + ':' + model.id}>{model.label}</option>)}
      </optgroup>)}
    </select>
    {compact && <ChevronDown size={13} />}
  </label>
}

function Sidebar({ bots, activeId, onSelect, onCreate, onClose, onDelete, query, setQuery, page, onUsage }) {
  const [optionsId, setOptionsId] = useState(null)
  const [optionsPosition, setOptionsPosition] = useState(null)
  const optionsRef = useRef(null)
  const triggerRef = useRef(null)
  const visibleBots = bots.filter(bot => (bot.name + ' ' + bot.description).toLowerCase().includes(query.toLowerCase()))
  useLayoutEffect(() => {
    if (!optionsId) return
    const placeMenu = () => {
      const trigger = triggerRef.current, menu = optionsRef.current
      if (!trigger || !menu) return
      const anchor = trigger.getBoundingClientRect(), bounds = menu.getBoundingClientRect()
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft || 0) + 8
      const topEdge = (viewport?.offsetTop || 0) + 8
      const rightEdge = (viewport?.offsetLeft || 0) + (viewport?.width || document.documentElement.clientWidth) - 8
      const bottomEdge = (viewport?.offsetTop || 0) + (viewport?.height || document.documentElement.clientHeight) - 8
      const below = anchor.bottom + 5
      const next = {
        left: Math.max(leftEdge, Math.min(anchor.right - bounds.width, rightEdge - bounds.width)),
        top: Math.max(topEdge, below + bounds.height <= bottomEdge ? below : anchor.top - bounds.height - 5),
      }
      setOptionsPosition(previous => previous?.left === next.left && previous?.top === next.top ? previous : next)
    }
    placeMenu()
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    window.visualViewport?.addEventListener('resize', placeMenu)
    window.visualViewport?.addEventListener('scroll', placeMenu)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
      window.visualViewport?.removeEventListener('resize', placeMenu)
      window.visualViewport?.removeEventListener('scroll', placeMenu)
    }
  }, [optionsId])
  useEffect(() => {
    if (!optionsId) return
    const menu = optionsRef.current
    menu?.querySelector('button')?.focus()
    const contains = target => menu?.contains(target) || triggerRef.current?.contains(target)
    const dismiss = event => { if (!contains(event.target)) setOptionsId(null) }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      triggerRef.current?.focus({ preventScroll: true })
      setOptionsId(null)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('focusin', dismiss); document.removeEventListener('keydown', escape, true) }
  }, [optionsId])
  return <>
    <div className="sidebar-heading"><span className="brand"><Bot size={19} />BunjiBox</span><Button variant="ghost" size="icon" aria-label="Create new bot" onClick={onCreate}><Plus /></Button>{onClose && <Button variant="ghost" size="icon" aria-label="Close menu" onClick={onClose}><X /></Button>}</div>
    <label className="sidebar-search"><Search size={15} /><input aria-label="Search bots" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="bot-list">{visibleBots.map(bot => <div key={bot.id} className={'bot-list-item ' + (page === 'chat' && activeId === bot.id ? 'selected' : '')}>
      <button aria-current={page === 'chat' && activeId === bot.id ? 'page' : undefined} className="bot-row" onClick={() => { setOptionsId(null); onSelect(bot.id) }}><Avatar tone={bot.id} /><span><strong>{bot.name || 'Untitled bot'}</strong><small>{bot.description || 'What can I take off your plate?'}</small></span></button>
      <button ref={optionsId === bot.id ? triggerRef : null} className="bot-options-trigger" aria-label={`Options for ${bot.name || 'Untitled bot'}`} aria-haspopup="menu" aria-expanded={optionsId === bot.id} onClick={() => setOptionsId(current => current === bot.id ? null : bot.id)}><Ellipsis size={18} aria-hidden="true" /></button>
    </div>)}{!visibleBots.length && <p className="quiet">No bots found.</p>}</div>
    <button className="sidebar-usage" aria-current={page === 'usage' ? 'page' : undefined} onClick={onUsage}><Gauge size={17} /><span>Usage</span></button>
    <div className="sidebar-foot"><span className="account-initials">AB</span><span>Andrew Baker<small>Local workspace</small></span></div>
    {optionsId && bots.some(bot => bot.id === optionsId) && createPortal(<div className="bot-options-menu" role="menu" ref={optionsRef} style={{ ...optionsPosition, visibility: optionsPosition ? 'visible' : 'hidden' }}><button type="button" role="menuitem" disabled={bots.length < 2} onClick={() => { const id = optionsId; setOptionsId(null); onDelete(id) }}><Trash2 size={15} aria-hidden="true" />Delete agent</button>{bots.length < 2 && <span>Create another agent first.</span>}</div>, document.body)}
  </>
}

function computerSummary(bot) {
  const access = bot.computer || { scope: 'none' }
  if (access.scope === 'folder') return access.level === 'auto' ? 'Folder changes allowed' : access.level === 'ask' ? 'Folder access needs approval' : 'Folder read only'
  if (access.scope === 'machine') return 'This Mac · full access'
  return 'Computer not connected'
}

function Details({ bot, update, refreshBots, status, view, setView, onClose, onDelete, canDelete, saveError, saving, requests, hasMore }) {
  const navigation = useRef(null)
  const selectedTab = view === 'computer' ? 'settings' : view === 'details' ? 'files' : view
  const tabs = [{ id: 'files', title: 'Files', icon: FolderOpen }, { id: 'memory', title: 'Memory', icon: BookOpen }, { id: 'log', title: 'Activity', icon: Activity }, { id: 'settings', title: 'Settings', icon: Settings2 }]
  const changeTab = next => { if (view === 'memory' && navigation.current) navigation.current(() => setView(next)); else setView(next) }
  let content
  if (view === 'memory') content = <MemoryPanel key={bot.id} botId={bot.id} botName={bot.name || 'Bot'} onClose={onClose} navigationRef={navigation} compact />
  else if (view === 'log') content = <TokenLog requests={requests} hasMore={hasMore} botName={bot.name || 'Bot'} onClose={onClose} compact />
  else if (view === 'computer') content = <div className="inspector-computer"><ComputerAccessPanel bot={bot} onClose={onClose} onBack={() => setView('settings')} onSaved={() => { void refreshBots() }} /></div>
  else if (view === 'settings') content = <>
      <header className="panel-heading"><h2>Agent settings</h2><Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}><X /></Button></header>
      <div className="panel-scroll inspector-settings">
        <div className="inspector-connection"><span>{runtimes[bot.provider].label}</span><span className={status?.[bot.provider]?.connected ? 'connected' : 'quiet'}>{status?.[bot.provider]?.connected ? 'Connected' : status?.[bot.provider] ? 'Not connected' : 'Checking…'}</span></div>
        <button className="inspector-computer-link" onClick={() => setView('computer')}><Laptop2 size={18} /><span><strong>Computer access</strong><small>{computerSummary(bot)}</small></span><ChevronRight size={15} /></button>
        <details className="inspector-appearance"><summary><Avatar tone={bot.id} small /><span>Appearance</span><ChevronDown size={14} /></summary>
        <AvatarEditor key={bot.id} tone={bot.id} inline />
        </details>
        <div className="bot-fields">
          <label className="field"><span>Name</span><input aria-label="Bot name" maxLength={60} value={bot.name} onChange={event => update({ name: event.target.value })} placeholder="Name your bot" /></label>
          <label className="field"><span>Description</span><textarea aria-label="Bot description" maxLength={1800} rows={4} value={bot.description} onChange={event => update({ description: event.target.value })} placeholder="What this bot is for" /></label>
          <p className="field-note">This description guides your bot's replies.</p>
          <div className="settings-card"><ModelSelect bot={bot} onChange={update} label="Default model" /><div className="effort-setting"><span>Thinking effort</span><EffortPicker modelLabel={runtimes[bot.provider].models.find(m => m.id === bot.model)?.label} effort={bot.effort} steps={effortSteps(bot.provider, bot.model)} onChange={effort => update({ effort })} /></div></div>
          {saveError ? <p role="alert">{saveError}</p> : <p className="saved-note"><Check size={12} /> {saving ? 'Saving to workspace…' : 'Saved · shared across devices'}</p>}
          <button className="text-action delete-agent-link" onClick={onDelete} disabled={!canDelete}><Trash2 size={15} />Delete agent</button>
          {!canDelete && <p className="field-note">Create another agent before deleting the last one.</p>}
        </div>
      </div>
    </>
  else content = <FilesPanel key={bot.id} botId={bot.id} botName={bot.name || 'Your agent'} onClose={onClose} onSettings={() => setView('settings')} />
  return <>
    <nav className="inspector-tabs" aria-label="Agent sidebar">{tabs.map(({ id, title, icon: Icon }) => <button key={id} type="button" aria-current={selectedTab === id ? 'page' : undefined} onClick={() => changeTab(id)}><Icon size={17} /><span>{title}</span></button>)}</nav>
    {content}
  </>
}

function DeleteBotDialog({ bot, choices, client, onClose, onDeleted }) {
  const [state, setState] = useState({ loading: true, notes: [], revision: '', error: '' })
  const [action, setAction] = useState('move')
  const [targetId, setTargetId] = useState(choices[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const dialog = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    element?.querySelector('button')?.focus()
    const onKey = event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const items = [...element.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled])')]
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
      }
    }
    element?.addEventListener('keydown', onKey)
    return () => { element?.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [busy, onClose])
  useEffect(() => {
    let alive = true
    client.memoryList(bot.id).then(result => { if (alive) setState({ loading: false, notes: result.notes, revision: result.revision, error: '' }) })
      .catch(error => { if (alive) setState(current => ({ ...current, loading: false, error: error.message })) })
    return () => { alive = false }
  }, [bot.id, client])
  const remove = async () => {
    if (busy || state.loading || !state.revision) return
    setBusy(true); setState(current => ({ ...current, error: '' }))
    try {
      const move = state.notes.length > 0 && action === 'move'
      await onDeleted({ memoryAction: move ? 'move' : 'delete', ...(move ? { targetBotId: targetId } : {}), expectedMemoryRevision: state.revision })
    } catch (error) { setState(current => ({ ...current, error: error.message })) }
    finally { setBusy(false) }
  }
  return <div className="delete-agent-overlay"><section className="delete-agent-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="delete-agent-title">
    <h2 id="delete-agent-title">Delete {bot.name || 'this agent'}?</h2>
    <p>This removes the agent and its saved chat history from BunjiBox.</p>
    {state.loading ? <p role="status">Checking memories…</p> : state.notes.length ? <>
      <p>This agent has {state.notes.length} {state.notes.length === 1 ? 'memory' : 'memories'}. What should happen to them?</p>
      <label className="delete-agent-option"><input type="radio" name="memory-choice" checked={action === 'move'} onChange={() => setAction('move')} />Move them to another agent</label>
      {action === 'move' && <label className="field"><span>Destination agent</span><select value={targetId} onChange={event => setTargetId(event.target.value)}>{choices.map(item => <option key={item.id} value={item.id}>{item.name || 'Untitled bot'}</option>)}</select></label>}
      <label className="delete-agent-option"><input type="radio" name="memory-choice" checked={action === 'delete'} onChange={() => setAction('delete')} />Delete the memories too</label>
    </> : !state.loading && <p>No saved memories were found.</p>}
    {state.error && <p role="alert" className="delete-agent-error">{state.error}</p>}
    <div className="delete-agent-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="delete-agent-confirm" disabled={busy || state.loading || !state.revision || Boolean(state.notes.length && action === 'move' && !targetId)} onClick={remove}>{busy ? 'Deleting…' : 'Delete agent'}</button></div>
  </section></div>
}

function RewindDialog({ message, busy, error, onClose, onConfirm }) {
  const dialog = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    element?.querySelector('button')?.focus()
    const onKey = event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const items = [...element.querySelectorAll('button:not([disabled])')]
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
    }
    element?.addEventListener('keydown', onKey)
    return () => { element?.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [busy, onClose])
  return <div className="rewind-overlay"><section className="rewind-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="rewind-title">
    <h2 id="rewind-title">Rewind this message?</h2>
    <p>This removes this message and every message after it from the chat, then loads the prompt back into compose.</p>
    <blockquote>{message.prompt}</blockquote>
    <p className="rewind-note">Saved memories and files are not deleted or undone.</p>
    {error && <p role="alert" className="delete-agent-error">{error}</p>}
    <div className="delete-agent-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="rewind-confirm" onClick={onConfirm} disabled={busy}>{busy ? 'Rewinding…' : 'Rewind chat'}</button></div>
  </section></div>
}

function App() {
  const [page, setPage] = useState(() => window.location.hash === '#usage' ? 'usage' : 'chat')
  const [botClient] = useState(createBrowserBotClient)
  const { bots, ready, pending: saving, error: syncError } = useSyncExternalStore(botClient.subscribe, botClient.getSnapshot)
  const [selectedId, setActiveId] = useState('bunjibox')
  const activeId = bots.some(bot => bot.id === selectedId) ? selectedId : bots[0]?.id
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [mobilePanel, setMobilePanel] = useState(null)
  const [view, setView] = useState('files')
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState({})
  const [previewDraft, setPreviewDraft] = useState(false)
  const [chatClient] = useState(() => new ChatClient())
  const chatState = useSyncExternalStore(chatClient.subscribe, chatClient.getSnapshot)
  const [sending, setSending] = useState(null)
  const [sendError, setSendError] = useState('')
  const [editing, setEditing] = useState(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [rewindTarget, setRewindTarget] = useState(null)
  const [rewindBusy, setRewindBusy] = useState(false)
  const [rewindError, setRewindError] = useState('')
  const [deleteId, setDeleteId] = useState(null)
  const [status, setStatus] = useState({})
  const saveError = syncError || botClient.migrationError
  const transcript = useRef(null)
  const followTranscript = useRef(true)
  const bot = bots.find(item => item.id === activeId) || { id: 'loading', name: 'Loading bots…', description: '', ...normalizeRuntime() }
  const draft = drafts[bot.id] || ''
  const history = chatState.histories[bot.id]
  const requests = (history?.requests || []).map(request => ({ ...request, preview: request.prompt.slice(0, 160), serverId: request.id, modelLabel: runtimes[request.provider]?.models.find(model => model.id === request.model)?.label || request.model }))
  const activeRequest = requests.find(request => request.status === 'running')
  const running = activeRequest ? bot.id : null
  const thread = requests.flatMap(request => [{ kind: 'user', text: request.prompt, requestId: request.id, editedAt: request.promptEditedAt }, {
    kind: ['failed', 'cancelled', 'interrupted'].includes(request.status) ? 'error' : 'bot',
    text: request.text || request.error || '', error: request.text ? request.error : null,
    runtime: request.modelLabel + ' · ' + request.effort, requestId: request.id, editedAt: request.responseEditedAt,
  }])
  const tokenSummary = summarizeRequests(requests)
  const label = runtimes[bot.provider].models.find(model => model.id === bot.model)?.label
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1023px)').matches)

  useEffect(() => {
    window.localStorage.removeItem('bunji.machine-key')
    const media = window.matchMedia('(max-width: 1023px)')
    const resize = () => { setNarrow(media.matches); setMobilePanel(null) }
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])
  useEffect(() => { fetch('/api/status').then(res => res.json()).then(setStatus).catch(() => setStatus({})) }, [])
  useEffect(() => {
    const navigate = () => { setPage(window.location.hash === '#usage' ? 'usage' : 'chat') }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  useEffect(() => { if (transcript.current && followTranscript.current) transcript.current.scrollTop = transcript.current.scrollHeight }, [chatState, activeId])
  useEffect(() => chatClient.start(), [chatClient])
  useEffect(() => { chatClient.activate(activeId) }, [chatClient, activeId])
  useEffect(() => {
    if (!mobilePanel) return
    const previous = document.activeElement
    const panel = document.getElementById('mobile-panel')
    panel?.querySelector('button, input')?.focus()
    const handleKey = event => {
      if (event.key === 'Escape') setMobilePanel(null)
      if (event.key === 'Tab') {
        const items = [...panel.querySelectorAll('button:not([disabled]), input, select, textarea, summary, a[href], [tabindex="0"]')].filter(element => element.getClientRects().length)
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
      }
    }
    panel?.addEventListener('keydown', handleKey)
    return () => { panel?.removeEventListener('keydown', handleKey); if (previous?.isConnected) previous.focus() }
  }, [mobilePanel])

  useEffect(() => {
    const stop = botClient.start()
    const refresh = () => { if (!document.hidden) void botClient.sync() }
    const beforeUnload = event => { if (botClient.getSnapshot().pending) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('beforeunload', beforeUnload)
    return () => { stop(); void botClient.flush(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('beforeunload', beforeUnload) }
  }, [botClient])

  const update = changes => botClient.update(bot.id, changes)
  const showChat = () => { setPage('chat'); window.location.assign('#'); setMobilePanel(null) }
  const showUsage = () => { setPage('usage'); window.location.assign('#usage'); setMobilePanel(null) }
  const showSettings = () => { setView('settings'); if (narrow) setMobilePanel('details'); else setDetailsOpen(true) }
  const showLog = () => { setView('log'); if (narrow) setMobilePanel('details'); else setDetailsOpen(true) }
  const showFiles = () => { setView('files'); if (narrow) setMobilePanel('details'); else setDetailsOpen(true) }
  const createBot = () => {
    showChat()
    const id = 'bot-' + [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    botClient.create({ id, name: 'New bot', description: '', ...normalizeRuntime(bot), mode: automaticMode(bot.provider) })
    setActiveId(id); setSendError(''); setQuery(''); setView('settings')
    if (narrow) setMobilePanel('details'); else setDetailsOpen(true)
  }
  const selectBot = id => { setActiveId(id); setSendError(''); setEditing(null); setRewindTarget(null); setPreviewDraft(false); followTranscript.current = true; showChat() }
  const toggleDetails = () => { if (narrow) setMobilePanel('details'); else setDetailsOpen(open => !open) }
  const closeDetails = () => { setDetailsOpen(false); setMobilePanel(null) }
  const sendMessage = async () => {
    const text = draft.trim()
    if (!text || running || sending || !history?.ready) return
    const chosen = { ...bot, mode: automaticMode(bot.provider) }
    setSending(chosen.id); setSendError('')
    followTranscript.current = true
    try {
      await chatClient.send(chosen.id, text, chosen)
      setDrafts(current => ({ ...current, [chosen.id]: current[chosen.id]?.trim() === text ? '' : current[chosen.id] }))
      setPreviewDraft(false)
    } catch (error) { setSendError(error.message) }
    finally { setSending(null) }
  }
  const saveMessageEdit = async () => {
    if (!editing || editBusy) return
    const value = editing.value.trim()
    if (!value) { setEditError('Message cannot be empty.'); return }
    setEditBusy(true); setEditError('')
    try { await chatClient.editMessage(bot.id, editing.id, editing.role, value, editing.expectedText); setEditing(null) }
    catch (error) { setEditError(error.message) }
    finally { setEditBusy(false) }
  }
  const rewindMessage = async () => {
    if (!rewindTarget || rewindBusy) return
    setRewindBusy(true); setRewindError('')
    try {
      await chatClient.rewindMessage(bot.id, rewindTarget.id, rewindTarget.prompt)
      setDrafts(current => ({ ...current, [bot.id]: rewindTarget.prompt }))
      setRewindTarget(null); setPreviewDraft(false); setEditing(null); followTranscript.current = true
    } catch (error) { setRewindError(error.message) }
    finally { setRewindBusy(false) }
  }
  const openDelete = id => { setDeleteId(id); setMobilePanel(null) }
  const deleteBot = async options => {
    const snapshot = await botClient.remove(deleteId, options)
    if (activeId === deleteId) setActiveId(snapshot.bots.find(item => item.id !== deleteId)?.id)
    if (snapshot.cleanupWarning) setSendError(snapshot.cleanupWarning)
    setEditing(null); setDeleteId(null)
    if (activeId === deleteId) { setView('details'); closeDetails() }
    return snapshot
  }
  const sidebarProps = { bots, activeId, onSelect: selectBot, onCreate: createBot, onDelete: openDelete, query, setQuery, page, onUsage: showUsage }
  const detailsProps = { bot, update, refreshBots: () => botClient.sync(), status, view, setView, onClose: closeDetails, onDelete: () => openDelete(bot.id), canDelete: bots.length > 1 && !running, saveError, saving, requests, hasMore: history?.hasMore }

  if (!ready) return <main className="app-shell dark workspace-loading"><h1>BunjiBox</h1><p role="status">{saveError || 'Connecting to your shared workspace…'}</p>{saveError && <button onClick={() => void botClient.sync()}>Retry connection</button>}</main>

  return <AvatarProvider values={Object.fromEntries(bots.map(bot => [bot.id, bot.avatar]))} onChange={(id, avatar) => botClient.update(id, { avatar })}><main className="app-shell dark">
    <aside className="desktop-sidebar"><Sidebar {...sidebarProps} /></aside>
    <section className="conversation">
      {page === 'usage' ? <UsagePage onMenu={() => setMobilePanel('sidebar')} onBack={showChat} setConnectionStatus={setStatus} /> : <>
      <header className="chat-heading"><Button className="mobile-menu" variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMobilePanel('sidebar')}><Menu /></Button><button className="chat-identity" onClick={showSettings} aria-label="Edit bot settings"><Avatar tone={bot.id} small /><span>{bot.name || 'Untitled bot'}</span></button><Button variant="ghost" size="icon" aria-label="Open agent files" title="Agent files" onClick={showFiles}><FolderOpen /></Button><Button variant="ghost" size="icon" aria-label="Toggle agent sidebar" title="Agent sidebar" onClick={toggleDetails}><PanelRight /></Button></header>
      <div className="transcript" ref={transcript} onScroll={event => { const element = event.currentTarget; followTranscript.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90 }}>
        <div className="transcript-inner">
          {!history?.ready && <p role="status">Loading saved conversation…</p>}
          {history?.hasMore && <button className="history-older" disabled={history.loadingOlder} onClick={() => { followTranscript.current = false; void chatClient.loadOlder(bot.id) }}>{history.loadingOlder ? 'Loading…' : 'Load older messages'}</button>}
          {history?.ready && !thread.length && <div className="welcome"><Avatar tone={bot.id} /><h1>What can I take off your plate?</h1><p>{bot.description || 'A little help, a fresh idea, or a task to get moving.'}</p><button className="welcome-customize" onClick={showSettings}><Settings2 size={14} /> Make this bot yours</button></div>}
          {thread.map((message, index) => {
            const request = requests.find(request => request.id === message.requestId)
            return <div key={index} className="message-turn">
              {message.kind !== 'user' && request && <RunActivity activities={request.activities} status={request.status} limited={request.activityLimited} />}
              {message.text && <div className={'message ' + message.kind} style={messageBubbleStyle(message.kind, bot.avatar)}>
                {message.kind !== 'user' && <small>{message.kind === 'error' ? 'Could not complete request' : message.runtime}</small>}
                {editing?.id === message.requestId && editing.role === (message.kind === 'user' ? 'user' : 'assistant') ? <div className="message-edit">
                  <label><span>Edit {message.kind === 'user' ? 'message' : 'reply'}</span><textarea value={editing.value} maxLength={message.kind === 'user' ? 12000 : 1000000} onChange={event => setEditing(current => ({ ...current, value: event.target.value }))} /></label>
                  <p>Saved edits shape future chat context. Earlier replies and token counts stay as recorded.</p>
                  {editError && <p role="alert" className="delete-agent-error">{editError}</p>}
                  <div className="message-edit-actions"><button disabled={editBusy} onClick={() => { setEditing(null); setEditError('') }}>Cancel</button><button disabled={editBusy || !editing.value.trim()} onClick={saveMessageEdit}>{editBusy ? 'Saving…' : 'Save edit'}</button></div>
                </div> : <Markdown text={message.text} />}
                {message.editedAt && <span className="message-edited">Edited</span>}
                {message.error && <p>{message.error}</p>}
                {request && message.kind !== 'error' && <div className="message-foot"><button className="message-token-note" onClick={showLog} title="Provider-reported counts from the original run. Request input includes system and tool context.">{request.status === 'running' ? 'Token counts pending…' : message.kind === 'user' ? `${tokenCount(request.usage?.inputTokens)} request input tokens` : `${tokenCount(request.usage?.outputTokens)} output tokens · ${tokenCount(request.usage?.totalTokens)} total`}</button><span className="message-actions">{request.status !== 'running' && (message.kind === 'user' || request.status === 'complete') && <button className="message-edit-button" aria-label={`Edit ${message.kind === 'user' ? 'message' : 'reply'}`} onClick={() => { setEditing({ id: message.requestId, role: message.kind === 'user' ? 'user' : 'assistant', value: message.text, expectedText: message.text }); setEditError('') }}><Pencil size={13} /> Edit</button>}{request.status !== 'running' && message.kind === 'user' && <button className="message-edit-button" aria-label="Rewind to this message" onClick={() => { setRewindTarget({ id: message.requestId, prompt: message.text }); setRewindError('') }}><RotateCcw size={13} /> Rewind</button>}</span></div>}
              </div>}
            </div>
          })}
          {running === bot.id && <div className="working" role="status"><span />{bot.name || 'Your bot'} is thinking… <button onClick={() => chatClient.cancel(activeRequest.id).catch(error => setSendError(error.message))}>Stop</button></div>}
        </div>
      </div>
      <div className="composer-wrap">
        {(sendError || chatState.error) && <p className="chat-sync-error" role="alert">{sendError || chatState.error} <button onClick={() => void chatClient.refresh(bot.id)}>Reconnect</button></p>}
        <div className="composer">
          <div className="composer-format"><span>Markdown supported</span><button type="button" aria-pressed={previewDraft} onClick={() => setPreviewDraft(value => !value)}>{previewDraft ? 'Edit message' : 'Preview'}</button></div>
          {previewDraft ? <div className="composer-preview" role="region" aria-label="Message preview">{draft.trim() ? <Markdown text={draft} /> : <p className="quiet">Nothing to preview yet.</p>}</div> : <textarea aria-label={'Message ' + (bot.name || 'bot')} placeholder={'Message ' + (bot.name || 'bot')} rows={2} maxLength={9000} value={draft} onChange={event => setDrafts(current => ({ ...current, [bot.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage() } }} />}
          <div className="composer-toolbar"><div className="composer-runtime"><ModelSelect compact bot={bot} onChange={update} label="Chat model" /></div><div className="composer-actions"><EffortPicker modelLabel={label} effort={bot.effort} steps={effortSteps(bot.provider, bot.model)} onChange={effort => update({ effort })} /><Button className="send-button" aria-label="Send message" size="icon" onClick={sendMessage} disabled={!draft.trim() || Boolean(running) || Boolean(sending) || !history?.ready}><ArrowUp /></Button></div></div>
        </div>
        <p className="composer-note">{runtimes[bot.provider].label} · {status?.[bot.provider]?.connected ? bot.provider === 'ollama' ? 'Connected to the Pi' : 'Connected on this Mac' : 'Check connection in Settings'}</p>
        <div className="composer-debug"><button onClick={showLog}><Activity size={11} />{tokenSummary.totals.totalTokens.partial && tokenSummary.totals.totalTokens.value !== null ? '≥ ' : ''}{tokenCount(tokenSummary.totals.totalTokens.value)} {history?.hasMore ? 'loaded-history' : 'conversation'} tokens · View log</button></div>
        {saveError && <p role="alert">{saveError} <button onClick={() => void botClient.sync()}>Retry</button></p>}
        {!saveError && saving && <p className="composer-note" role="status">Saving bot settings…</p>}
      </div>
      </>}
    </section>
    {page === 'chat' && !narrow && detailsOpen && <aside className="desktop-details"><Details key={bot.id} {...detailsProps} /></aside>}
    {narrow && mobilePanel && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="Dismiss panel" onClick={() => setMobilePanel(null)} /><aside id="mobile-panel" role="dialog" aria-modal="true" aria-label={mobilePanel === 'sidebar' ? 'Bots' : 'Agent sidebar'} className={'mobile-drawer ' + mobilePanel}>{mobilePanel === 'sidebar' ? <Sidebar {...sidebarProps} onClose={() => setMobilePanel(null)} /> : <Details key={bot.id} {...detailsProps} />}</aside></div>}
    {deleteId && bots.some(item => item.id === deleteId) && <DeleteBotDialog key={deleteId} bot={bots.find(item => item.id === deleteId)} choices={bots.filter(item => item.id !== deleteId)} client={chatClient} onClose={() => setDeleteId(null)} onDeleted={deleteBot} />}
    {rewindTarget && <RewindDialog key={rewindTarget.id} message={rewindTarget} busy={rewindBusy} error={rewindError} onClose={() => setRewindTarget(null)} onConfirm={rewindMessage} />}
  </main></AvatarProvider>
}
export default App
