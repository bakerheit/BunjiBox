import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Activity, ArrowUp, FolderOpen, Menu, PanelRight, Pencil, RotateCcw, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import './App.css'
import { Avatar, AvatarProvider } from './AvatarPicker'
import { EffortPicker } from './EffortPicker'
import { automaticMode, effortSteps, normalizeRuntime, runtimes } from '@bunji/shared/runtimes'
import UsagePage from './UsagePage'
import type { ConnectionStatus } from './UsagePage'
import type { LoggedRequest } from './TokenLog'
import { summarizeRequests, tokenCount } from '@bunji/shared/token-usage'
import Markdown from './Markdown'
import { messageBubbleStyle } from './message-bubble'
import type { MessageKind } from './message-bubble'
import RunActivity from './RunActivity'
import ModelSelect from './ModelSelect'
import Sidebar from './Sidebar'
import AgentInspector from './AgentInspector'
import type { InspectorView } from './AgentInspector'
import DeleteBotDialog from './DeleteBotDialog'
import RewindDialog from './RewindDialog'
import { ChatClient } from '@bunji/shared/chat-client'
import { errorMessage } from '@bunji/shared/errors'
import type { Bot, BotChanges, DeleteBotOptions, MessageEdit } from '@bunji/shared/types'

import { createBrowserBotClient } from '@bunji/shared/bot-api'

// Until the workspace loads there is no saved bot, only a placeholder with a
// runtime selection, so the saved-only fields are optional here.
type DisplayBot = Pick<Bot, 'id' | 'name' | 'description' | 'provider' | 'model' | 'effort'> & Partial<Bot>

interface ThreadMessage {
  kind: MessageKind
  text: string
  requestId: string
  editedAt: number | null
  error?: string | null
  runtime?: string
}

function App() {
  const [page, setPage] = useState<'chat' | 'usage'>(() => window.location.hash === '#usage' ? 'usage' : 'chat')
  const [botClient] = useState(createBrowserBotClient)
  const { bots, ready, pending: saving, error: syncError } = useSyncExternalStore(botClient.subscribe, botClient.getSnapshot)
  const [selectedId, setActiveId] = useState<string | undefined>('bunjibox')
  const activeId = bots.some(bot => bot.id === selectedId) ? selectedId : bots[0]?.id
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [mobilePanel, setMobilePanel] = useState<'sidebar' | 'details' | null>(null)
  const [view, setView] = useState<InspectorView>('files')
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [previewDraft, setPreviewDraft] = useState(false)
  const [chatClient] = useState(() => new ChatClient())
  const chatState = useSyncExternalStore(chatClient.subscribe, chatClient.getSnapshot)
  const [sending, setSending] = useState<string | null>(null)
  const [sendError, setSendError] = useState('')
  const [editing, setEditing] = useState<(MessageEdit & { id: string }) | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [rewindTarget, setRewindTarget] = useState<{ id: string; prompt: string } | null>(null)
  const [rewindBusy, setRewindBusy] = useState(false)
  const [rewindError, setRewindError] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>({})
  const saveError = syncError || botClient.migrationError
  const transcript = useRef<HTMLDivElement>(null)
  const followTranscript = useRef(true)
  const bot: DisplayBot = bots.find(item => item.id === activeId) || { id: 'loading', name: 'Loading bots…', description: '', ...normalizeRuntime() }
  const draft = drafts[bot.id] || ''
  const history = chatState.histories[bot.id]
  const requests: LoggedRequest[] = (history?.requests || []).map(request => ({ ...request, preview: request.prompt.slice(0, 160), serverId: request.id, modelLabel: runtimes[request.provider]?.models.find(model => model.id === request.model)?.label || request.model }))
  const activeRequest = requests.find(request => request.status === 'running')
  const running = activeRequest ? bot.id : null
  const thread = requests.flatMap((request): ThreadMessage[] => [{ kind: 'user', text: request.prompt, requestId: request.id, editedAt: request.promptEditedAt }, {
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
  useEffect(() => { fetch('/api/status').then(res => res.json() as Promise<ConnectionStatus>).then(setStatus).catch(() => setStatus({})) }, [])
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
    const previous = document.activeElement as HTMLElement | null
    const panel = document.getElementById('mobile-panel')
    panel?.querySelector<HTMLElement>('button, input')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobilePanel(null)
      if (event.key === 'Tab') {
        const items = [...panel!.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, summary, a[href], [tabindex="0"]')].filter(element => element.getClientRects().length)
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
    const beforeUnload = (event: BeforeUnloadEvent) => { if (botClient.getSnapshot().pending) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('beforeunload', beforeUnload)
    return () => { stop(); void botClient.flush(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('beforeunload', beforeUnload) }
  }, [botClient])

  const update = (changes: BotChanges) => botClient.update(bot.id, changes)
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
  const selectBot = (id: string) => { setActiveId(id); setSendError(''); setEditing(null); setRewindTarget(null); setPreviewDraft(false); followTranscript.current = true; showChat() }
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
    } catch (error) { setSendError(errorMessage(error)) }
    finally { setSending(null) }
  }
  const saveMessageEdit = async () => {
    if (!editing || editBusy) return
    const value = editing.value.trim()
    if (!value) { setEditError('Message cannot be empty.'); return }
    setEditBusy(true); setEditError('')
    try { await chatClient.editMessage(bot.id, editing.id, editing.role, value, editing.expectedText); setEditing(null) }
    catch (error) { setEditError(errorMessage(error)) }
    finally { setEditBusy(false) }
  }
  const rewindMessage = async () => {
    if (!rewindTarget || rewindBusy) return
    setRewindBusy(true); setRewindError('')
    try {
      await chatClient.rewindMessage(bot.id, rewindTarget.id, rewindTarget.prompt)
      setDrafts(current => ({ ...current, [bot.id]: rewindTarget.prompt }))
      setRewindTarget(null); setPreviewDraft(false); setEditing(null); followTranscript.current = true
    } catch (error) { setRewindError(errorMessage(error)) }
    finally { setRewindBusy(false) }
  }
  const openDelete = (id: string) => { setDeleteId(id); setMobilePanel(null) }
  const deleteBot = async (options: DeleteBotOptions) => {
    const snapshot = await botClient.remove(deleteId!, options)
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
                  <label><span>Edit {message.kind === 'user' ? 'message' : 'reply'}</span><textarea value={editing.value} maxLength={message.kind === 'user' ? 12000 : 1000000} onChange={event => setEditing(current => ({ ...current!, value: event.target.value }))} /></label>
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
          {running === bot.id && <div className="working" role="status"><span />{bot.name || 'Your bot'} is thinking… <button onClick={() => chatClient.cancel(activeRequest!.id).catch((error: unknown) => setSendError(errorMessage(error)))}>Stop</button></div>}
        </div>
      </div>
      <div className="composer-wrap">
        {(sendError || chatState.error) && <p className="chat-sync-error" role="alert">{sendError || chatState.error} <button onClick={() => void chatClient.refresh(bot.id)}>Reconnect</button></p>}
        <div className="composer">
          <div className="composer-format"><span>Markdown supported</span><button type="button" aria-pressed={previewDraft} onClick={() => setPreviewDraft(value => !value)}>{previewDraft ? 'Edit message' : 'Preview'}</button></div>
          {previewDraft ? <div className="composer-preview" role="region" aria-label="Message preview">{draft.trim() ? <Markdown text={draft} /> : <p className="quiet">Nothing to preview yet.</p>}</div> : <textarea aria-label={'Message ' + (bot.name || 'bot')} placeholder={'Message ' + (bot.name || 'bot')} rows={2} maxLength={9000} value={draft} onChange={event => setDrafts(current => ({ ...current, [bot.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage() } }} />}
          <div className="composer-toolbar"><div className="composer-runtime"><ModelSelect compact bot={bot} onChange={update} label="Chat model" /></div><div className="composer-actions"><EffortPicker modelLabel={label} effort={bot.effort} steps={effortSteps(bot.provider, bot.model)} onChange={effort => update({ effort })} /><Button className="send-button" aria-label="Send message" size="icon" onClick={sendMessage} disabled={!draft.trim() || Boolean(running) || Boolean(sending) || !history?.ready}><ArrowUp /></Button></div></div>
        </div>
        <p className="composer-note">{runtimes[bot.provider].label} · {status?.[bot.provider]?.connected ? bot.provider === 'ollama' ? 'Ollama connected' : 'Connected on this computer' : 'Check connection in Settings'}</p>
        <div className="composer-debug"><button onClick={showLog}><Activity size={11} />{tokenSummary.totals.totalTokens.partial && tokenSummary.totals.totalTokens.value !== null ? '≥ ' : ''}{tokenCount(tokenSummary.totals.totalTokens.value)} {history?.hasMore ? 'loaded-history' : 'conversation'} tokens · View log</button></div>
        {saveError && <p role="alert">{saveError} <button onClick={() => void botClient.sync()}>Retry</button></p>}
        {!saveError && saving && <p className="composer-note" role="status">Saving bot settings…</p>}
      </div>
      </>}
    </section>
    {page === 'chat' && !narrow && detailsOpen && <aside className="desktop-details"><AgentInspector key={bot.id} {...detailsProps} /></aside>}
    {narrow && mobilePanel && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="Dismiss panel" onClick={() => setMobilePanel(null)} /><aside id="mobile-panel" role="dialog" aria-modal="true" aria-label={mobilePanel === 'sidebar' ? 'Bots' : 'Agent sidebar'} className={'mobile-drawer ' + mobilePanel}>{mobilePanel === 'sidebar' ? <Sidebar {...sidebarProps} onClose={() => setMobilePanel(null)} /> : <AgentInspector key={bot.id} {...detailsProps} />}</aside></div>}
    {deleteId && bots.some(item => item.id === deleteId) && <DeleteBotDialog key={deleteId} bot={bots.find(item => item.id === deleteId)!} choices={bots.filter(item => item.id !== deleteId)} client={chatClient} onClose={() => setDeleteId(null)} onDeleted={deleteBot} />}
    {rewindTarget && <RewindDialog key={rewindTarget.id} message={rewindTarget} busy={rewindBusy} error={rewindError} onClose={() => setRewindTarget(null)} onConfirm={rewindMessage} />}
  </main></AvatarProvider>
}
export default App
