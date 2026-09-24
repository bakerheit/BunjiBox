/* oxlint-disable react/only-export-components -- Keep testable helpers in this owned file; shared files are out of scope. */
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import type { FormEvent, Ref, RefObject } from 'react'
import { ArrowLeft, BookOpen, ChevronsRight, FileText, Link2, Pencil, Plus, RefreshCw, Save, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@bunji/shared/errors'
import type { MemoryNoteSummary } from '@bunji/shared/types'
import Markdown from './Markdown'
import './MemoryPanel.css'

/** A link to another note, normalized from a note ID or a link object. */
export interface NoteLink {
  id: string
  title: string
}

/**
 * A memory note as the panel holds it. The server sends links as note IDs and
 * string revisions; the panel also accepts link objects and integer revisions.
 * List entries have no body.
 */
export type PanelNote = Omit<MemoryNoteSummary, 'links' | 'revision'> & {
  links: NoteLink[]
  revision: string | number
  body?: string
}

/** A note read in full. */
export type FullNote = PanelNote & { body: string }

/** The note fields the editor keeps: identity, revision and text. */
export type EditableNote = Pick<PanelNote, 'id' | 'title' | 'revision' | 'updatedAt'> & { body: string }

export interface Draft {
  title: string
  body: string
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>

/** Any note-like value with links, normalized or as the server sent them. */
interface LinkedNote {
  id: string
  title?: string
  links?: unknown
}

function noteId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function linksOf(links: unknown): NoteLink[] {
  const unique = new Map<string, NoteLink>()
  for (const link of (Array.isArray(links) ? links : []) as ({ id?: unknown; noteId?: unknown; targetId?: unknown; title?: unknown } | string | null)[]) {
    const id = noteId(typeof link === 'string' ? link : link?.id ?? link?.noteId ?? link?.targetId)
    if (id && !unique.has(id)) unique.set(id, { id, title: typeof link !== 'string' && typeof link?.title === 'string' ? link.title : '' })
  }
  return [...unique.values()]
}

function readNote(value: unknown, full = false): PanelNote {
  const note = value as Record<string, unknown> | null | undefined
  const revision = note?.revision
  if (!noteId(note?.id) || typeof note!.title !== 'string'
    || !(typeof revision === 'string' && revision.length > 0 || Number.isInteger(revision) && (revision as number) >= 0)
    || full && typeof note!.body !== 'string') throw new Error('The server returned an incomplete memory note.')
  return { ...note, links: linksOf(note!.links), sourceMessageIds: Array.isArray(note!.sourceMessageIds) ? note!.sourceMessageIds.filter(id => typeof id === 'string') : [] } as PanelNote
}

// Keep the API boundary here so the parent can adjust the adapter without changing the UI.
export function createMemoryApi(botId: string, fetcher: Fetcher = (...args) => fetch(...args)) {
  const root = `/api/bots/${encodeURIComponent(botId)}/memory`
  async function request(id: string | null, method: string, payload: unknown, signal?: AbortSignal): Promise<PanelNote | PanelNote[]> {
    const write = method !== 'GET'
    let response: Response
    try {
      response = await fetcher(id == null ? root : `${root}/${encodeURIComponent(id)}`, {
        method, signal, headers: { Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) },
        ...(write ? { body: JSON.stringify(payload) } : {}),
      })
    } catch (error) {
      if (signal?.aborted || (error as Error).name === 'AbortError') throw error
      throw new Error(write ? 'Save not confirmed. Your draft is still here. Check your connection before trying again.' : 'Could not load memory. Check your connection and try again.')
    }
    const data = await response.json().catch(() => null) as { error?: unknown; notes?: unknown; note?: unknown } | null
    if (!response.ok) {
      const error: Error & { status?: number } = new Error(typeof data?.error === 'string' ? data.error : `Memory request failed (${response.status}).`)
      error.status = response.status
      throw error
    }
    try {
      if (method === 'GET' && id == null) {
        if (!Array.isArray(data?.notes)) throw new Error('The server returned an invalid memory list.')
        const notes = data.notes.map(note => readNote(note))
        if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error('The server returned duplicate note IDs.')
        return notes
      }
      const note = readNote(data?.note, true)
      if (id != null && note.id !== id) throw new Error('The server returned a different memory note.')
      return note
    } catch (error) {
      if (write) throw new Error('Save not confirmed: the server returned an incomplete note. Your draft is still here.')
      throw error
    }
  }
  return {
    list: (signal?: AbortSignal) => request(null, 'GET', undefined, signal) as Promise<PanelNote[]>,
    read: (id: string, signal?: AbortSignal) => request(id, 'GET', undefined, signal) as Promise<FullNote>,
    save: (base: Pick<PanelNote, 'id' | 'revision'> | null, draft: Draft, signal?: AbortSignal) => request(base?.id ?? null, base ? 'PATCH' : 'POST', {
      title: draft.title.trim(), body: draft.body, ...(base ? { expectedRevision: base.revision } : {}),
    }, signal) as Promise<FullNote>,
  }
}

export interface MemoryRelation {
  id: string
  title: string
  direction: 'Links to' | 'Linked from' | 'Linked both ways'
}

export function memoryRelations(note: LinkedNote, notes: LinkedNote[] = []): MemoryRelation[] {
  const indexed = new Map(notes.map(item => [item.id, item]))
  const related = new Map<string, MemoryRelation>()
  for (const link of linksOf(note.links)) {
    if (link.id !== note.id) related.set(link.id, { id: link.id, title: indexed.get(link.id)?.title || link.title || link.id, direction: 'Links to' })
  }
  for (const item of notes) {
    if (item.id !== note.id && linksOf(item.links).some(link => link.id === note.id)) {
      related.set(item.id, { id: item.id, title: item.title || item.id, direction: related.has(item.id) ? 'Linked both ways' : 'Linked from' })
    }
  }
  return [...related.values()]
}

export interface EditorState {
  mode: 'browse' | 'new' | 'edit'
  /** Set whenever mode is not 'browse'. */
  draft: Draft | null
  base: EditableNote | null
  status: 'idle' | 'saving' | 'error'
  error: string
  conflict: boolean
  latest: EditableNote | null
  latestStatus: 'idle' | 'loading' | 'ready' | 'error'
  latestError: string
}

export type EditorAction =
  | { type: 'reset' | 'new' | 'saving' | 'latest-loading' | 'rebase' }
  | { type: 'edit'; note: EditableNote }
  | { type: 'change'; field: keyof Draft; value: string }
  | { type: 'failed' | 'conflict' | 'latest-failed'; error: string }
  | { type: 'latest-loaded'; note: EditableNote }

const emptyEditor: EditorState = { mode: 'browse', draft: null, base: null, status: 'idle', error: '', conflict: false, latest: null, latestStatus: 'idle', latestError: '' }

export function memoryEditorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'reset': return emptyEditor
    case 'new': return { ...emptyEditor, mode: 'new', draft: { title: '', body: '' } }
    case 'edit': return { ...emptyEditor, mode: 'edit', base: action.note, draft: { title: action.note.title, body: action.note.body } }
    case 'change': return state.status === 'saving' ? state : { ...state, draft: { ...state.draft, [action.field]: action.value } as Draft, status: 'idle', error: '' }
    case 'saving': return state.conflict || !state.draft || state.status === 'saving' ? state : { ...state, status: 'saving', error: '' }
    case 'failed': return { ...state, status: 'error', error: action.error }
    case 'conflict': return { ...state, status: 'error', error: action.error, conflict: true, latest: null, latestStatus: 'idle', latestError: '' }
    case 'latest-loading': return { ...state, latestStatus: 'loading', latestError: '' }
    case 'latest-loaded': return { ...state, latestStatus: 'ready', latest: action.note, latestError: '' }
    case 'latest-failed': return { ...state, latestStatus: 'error', latestError: action.error }
    // Reviewing a newer revision never changes the draft or saves it implicitly.
    case 'rebase': return !state.latest ? state : { ...state, base: state.latest, conflict: false, latest: null, latestStatus: 'idle', status: 'idle', error: '' }
    default: return state
  }
}

function UpdatedAt({ value }: { value?: string | number | null }) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime())
    ? <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
    : <span>Update time unavailable</span>
}

interface MemoryNoteProps {
  note: LinkedNote & Pick<EditableNote, 'title' | 'body' | 'revision'> & { updatedAt?: string | null; sourceMessageIds?: string[] }
  notes: LinkedNote[]
  onNavigate: (id: string) => void
  titleRef?: Ref<HTMLHeadingElement>
  listReady?: boolean
}

export function MemoryNote({ note, notes, onNavigate, titleRef, listReady = true }: MemoryNoteProps) {
  const relations = memoryRelations(note, notes)
  return <article className="memory-note" aria-label="Selected memory note">
    <h3 className="memory-note-title" tabIndex={-1} ref={titleRef}>{note.title || 'Untitled note'}</h3>
    <dl className="memory-metadata">
      <div><dt>Last updated</dt><dd><UpdatedAt value={note.updatedAt} /></dd></div>
      <div><dt>Revision</dt><dd>{note.revision}</dd></div>
      <div><dt>Note ID</dt><dd><code>{note.id}</code></dd></div>
    </dl>
    <div className="memory-note-body">{note.body ? <Markdown text={note.body} /> : <p className="memory-muted">This note has no body yet.</p>}</div>
    <section className="memory-relations" aria-label="Related notes">
      <h4><Link2 size={14} aria-hidden="true" />Related notes <span>{relations.length}</span></h4>
      {relations.length ? <ul>{relations.map(link => <li key={link.id}><button type="button" onClick={() => onNavigate(link.id)}><span>{link.title}</span><small>{link.direction}</small></button></li>)}</ul> : <p className="memory-muted">{listReady ? 'No linked notes yet.' : 'No outgoing links. Load the note list to check incoming links.'}</p>}
      {!listReady && relations.length > 0 && <p className="memory-muted">Incoming links may be incomplete until the note list loads.</p>}
    </section>
    <details className="memory-sources">
      <summary>Source message IDs <span>{note.sourceMessageIds?.length || 0}</span></summary>
      {note.sourceMessageIds?.length ? <ul>{note.sourceMessageIds.map((id, index) => <li key={`${id}-${index}`}><code>{id}</code></li>)}</ul> : <p className="memory-muted">No source messages recorded.</p>}
    </details>
  </article>
}

// A keyed scope clears drafts and selections synchronously when the active bot changes.
/** Lets a parent run its own navigation through the panel's unsaved-draft guard. */
export type NavigationGuard = (leave: () => void) => void

interface MemoryPanelProps {
  botId?: string
  botName?: string
  onClose?: () => void
  onBack?: () => void
  navigationRef?: RefObject<NavigationGuard | null>
  compact?: boolean
}

type PanelAction =
  | { kind: 'panel'; leave: () => void }
  | { kind: 'close' | 'back' | 'new' | 'browse' | 'cancel' }
  | { kind: 'note'; id: string }

type RequestSlot = 'list' | 'detail' | 'save' | 'conflict'

export default function MemoryPanel(props: MemoryPanelProps) {
  return <MemoryPanelScope key={props.botId ?? 'no-bot'} {...props} />
}

function MemoryPanelScope({ botId, botName = 'Bot', onClose, onBack, navigationRef, compact = false }: MemoryPanelProps) {
  // Requests only run once a bot is selected.
  const api = useMemo(() => createMemoryApi(botId!), [botId])
  const [notes, setNotes] = useState<PanelNote[] | null>(null)
  const [listStatus, setListStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(botId ? 'loading' : 'idle')
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; note: FullNote | null; error: string }>({ status: 'idle', note: null, error: '' })
  const [editor, dispatch] = useReducer(memoryEditorReducer, emptyEditor)
  const [pendingAction, setPendingAction] = useState<PanelAction | null>(null)
  const [notice, setNotice] = useState('')
  const requests = useRef<Partial<Record<RequestSlot, AbortController | null>>>({})
  const titleRef = useRef<HTMLHeadingElement>(null)
  const draftTitleRef = useRef<HTMLInputElement>(null)
  const keepDraftRef = useRef<HTMLButtonElement>(null)
  const editorId = useId()
  const editing = editor.mode !== 'browse'
  const saving = editor.status === 'saving'
  const dirty = editing && (editor.draft!.title !== (editor.base?.title ?? '') || editor.draft!.body !== (editor.base?.body ?? ''))

  const startRequest = useCallback((slot: RequestSlot) => {
    requests.current[slot]?.abort()
    const controller = new AbortController()
    requests.current[slot] = controller
    return controller
  }, [])

  useEffect(() => () => {
    for (const controller of Object.values(requests.current)) controller?.abort()
  }, [])

  const loadList = useCallback(() => {
    if (!botId) return
    const controller = startRequest('list')
    return api.list(controller.signal).then(
      result => { if (!controller.signal.aborted) { setNotes(result); setListStatus('ready'); setListError('') } },
      (error: unknown) => { if (!controller.signal.aborted) { setListError(errorMessage(error)); setListStatus('error') } },
    )
  }, [api, botId, startRequest])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => {
    if (detail.status === 'ready' && !editing) titleRef.current?.focus()
  }, [detail, editing])
  useEffect(() => { if (editing) draftTitleRef.current?.focus() }, [editing, editor.mode])
  useEffect(() => { if (pendingAction) keepDraftRef.current?.focus() }, [pendingAction])
  useEffect(() => {
    if (!dirty && !saving) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, saving])

  function refreshList() {
    setListStatus('loading')
    setListError('')
    loadList()
  }

  async function loadNote(id: string) {
    const controller = startRequest('detail')
    setSelectedId(id)
    setDetail({ status: 'loading', note: null, error: '' })
    try {
      const note = await api.read(id, controller.signal)
      if (!controller.signal.aborted) setDetail({ status: 'ready', note, error: '' })
    } catch (error) {
      if (!controller.signal.aborted) setDetail({ status: 'error', note: null, error: errorMessage(error) })
    }
  }

  function applyAction(action: PanelAction) {
    requests.current.detail?.abort()
    requests.current.conflict?.abort()
    setPendingAction(null)
    setNotice('')
    if (action.kind === 'panel') { action.leave(); return }
    if (action.kind === 'close' || action.kind === 'back') {
      const leave = action.kind === 'close' ? onClose : onBack
      leave?.()
      return
    }
    if (action.kind === 'new') { dispatch({ type: 'new' }); return }
    dispatch({ type: 'reset' })
    if (action.kind === 'note') loadNote(action.id)
    else if (action.kind === 'cancel' && selectedId) loadNote(selectedId)
    else { setSelectedId(null); setDetail({ status: 'idle', note: null, error: '' }) }
  }

  function navigate(action: PanelAction) {
    if (saving || requests.current.save) return
    if (dirty) { setPendingAction(action); return }
    applyAction(action)
  }

  async function loadLatest(base: EditableNote) {
    const controller = startRequest('conflict')
    dispatch({ type: 'latest-loading' })
    try {
      const note = await api.read(base.id, controller.signal)
      if (!controller.signal.aborted) dispatch({ type: 'latest-loaded', note })
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: 'latest-failed', error: errorMessage(error) })
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!botId || !editor.draft?.title.trim() || !dirty || saving || editor.conflict || requests.current.save) return
    const controller = startRequest('save')
    dispatch({ type: 'saving' })
    setNotice('')
    try {
      const note = await api.save(editor.base, editor.draft, controller.signal)
      if (controller.signal.aborted) return
      // A list request started before the write must not replace the saved summary.
      requests.current.list?.abort()
      requests.current.detail?.abort()
      setNotes(current => current == null ? null : [note, ...current.filter(item => item.id !== note.id)])
      setSelectedId(note.id)
      setDetail({ status: 'ready', note, error: '' })
      dispatch({ type: 'reset' })
      setNotice('Saved to memory.')
      refreshList()
    } catch (error) {
      if (controller.signal.aborted) return
      if ((error as { status?: number }).status === 409 && editor.base) {
        dispatch({ type: 'conflict', error: errorMessage(error) })
        loadLatest(editor.base)
      } else dispatch({ type: 'failed', error: errorMessage(error) })
    } finally {
      // TS keeps the empty-slot narrowing from the guard above; startRequest has filled it since.
      if ((requests.current.save as AbortController | null | undefined) === controller) requests.current.save = null
    }
  }

  const search = query.trim().toLocaleLowerCase()
  useEffect(() => {
    if (!navigationRef) return
    navigationRef.current = leave => navigate({ kind: 'panel', leave })
    return () => { navigationRef.current = null }
  })
  const visibleNotes = (notes || []).filter(note => `${note.title} ${note.id}`.toLocaleLowerCase().includes(search))

  return <section className="memory-panel" aria-label={`${botName} memory`}>
    <header className="panel-heading memory-heading">
      {!compact && <Button variant="ghost" size="icon" aria-label="Back to bot details" disabled={saving || !onBack} onClick={() => navigate({ kind: 'back' })}><ArrowLeft aria-hidden="true" /></Button>}
      <h2>Memory</h2>
      <Button variant="ghost" size="icon" aria-label="Close memory" disabled={saving || !onClose} onClick={() => navigate({ kind: 'close' })}><ChevronsRight aria-hidden="true" /></Button>
    </header>
    <div className="panel-scroll memory-scroll">
      <div className="memory-intro"><span><BookOpen size={14} aria-hidden="true" />{botName}’s notes</span><p>Only explicit notes live here: relevant facts, not full transcripts. Memory tool calls stay visible in chat.</p></div>
      {!botId && <p className="memory-empty">Select a bot to browse its memory.</p>}
      <div className="memory-toolbar" role="group" aria-label="Memory actions">
        <button type="button" aria-pressed={!editing} disabled={!botId || saving} onClick={() => navigate({ kind: 'browse' })}><BookOpen size={14} aria-hidden="true" />Browse</button>
        <button type="button" aria-pressed={editor.mode === 'edit'} disabled={!botId || saving || detail.status !== 'ready' || editing} onClick={() => { setNotice(''); dispatch({ type: 'edit', note: detail.note! }) }}><Pencil size={14} aria-hidden="true" />Edit</button>
        <button type="button" aria-pressed={editor.mode === 'new'} disabled={!botId || saving || editor.mode === 'new'} onClick={() => navigate({ kind: 'new' })}><Plus size={14} aria-hidden="true" />New</button>
      </div>
      <p className="memory-status" role="status" aria-live="polite">{saving ? 'Saving… Keep this panel open until the save is confirmed.' : notice}</p>
      {pendingAction && <div className="memory-warning" role="alert">
        <p>Discard your unsaved changes? Your draft will be lost.</p>
        <div className="memory-actions"><button type="button" ref={keepDraftRef} onClick={() => { setPendingAction(null); draftTitleRef.current?.focus() }}>Keep editing</button><button type="button" onClick={() => applyAction(pendingAction)}>Discard changes</button></div>
      </div>}
      {editing ? <form className="memory-editor" onSubmit={save} aria-label={editor.mode === 'new' ? 'New memory note' : 'Edit memory note'} aria-busy={saving}>
        <h3>{editor.mode === 'new' ? 'New note' : 'Edit note'}</h3>
        <label className="memory-field" htmlFor={`${editorId}-title`}><span>Title</span><input ref={draftTitleRef} id={`${editorId}-title`} required value={editor.draft!.title} disabled={saving} onChange={event => dispatch({ type: 'change', field: 'title', value: event.target.value })} placeholder="A fact worth remembering" /></label>
        <label className="memory-field" htmlFor={`${editorId}-body`}><span>Body <small>Markdown</small></span><textarea id={`${editorId}-body`} aria-describedby={`${editorId}-help`} rows={12} value={editor.draft!.body} disabled={saving} onChange={event => dispatch({ type: 'change', field: 'body', value: event.target.value })} placeholder="Keep the useful facts and context here." /></label>
        <p className="memory-muted" id={`${editorId}-help`}>Keep notes focused. Save confirms the write; typing alone does not save.</p>
        <details className="memory-preview"><summary>Preview Markdown</summary><div>{editor.draft!.body ? <Markdown text={editor.draft!.body} /> : <p className="memory-muted">Nothing to preview yet.</p>}</div></details>
        {editor.error && !editor.conflict && <div className="memory-error" role="alert"><p>{editor.error}</p>{editor.mode === 'new' && <p>Your draft is kept. If the save reached the server, retrying may create a duplicate.</p>}</div>}
        {editor.conflict && <div className="memory-warning" role="alert">
          <h4>This note changed elsewhere.</h4><p>{editor.error}</p><p>Your draft is intact. Compare the latest note below and merge any changes into your draft. Then use its revision for your next save.</p>
          {editor.latestStatus === 'loading' && <p role="status">Loading the latest saved note…</p>}
          {editor.latestError && <p>{editor.latestError}</p>}
          {editor.latest && <div className="memory-conflict-note"><h4>{editor.latest.title || 'Untitled note'}</h4><p className="memory-muted">Saved revision {editor.latest.revision} · <UpdatedAt value={editor.latest.updatedAt} /></p><Markdown text={editor.latest.body} /></div>}
          <div className="memory-actions"><button type="button" disabled={editor.latestStatus === 'loading'} onClick={() => loadLatest(editor.base!)}><RefreshCw size={13} aria-hidden="true" />Check latest</button>{editor.latest && <button type="button" disabled={editor.latestStatus === 'loading'} onClick={() => { dispatch({ type: 'rebase' }); setNotice('Latest revision selected. Your draft is unchanged and has not been saved.') }}>Use latest revision</button>}</div>
        </div>}
        <div className="memory-save-row"><span className="memory-muted">{saving ? 'Saving…' : editor.conflict ? 'Resolve conflict to save' : dirty ? 'Unsaved changes' : editor.mode === 'new' ? 'Not saved yet' : 'No changes'}</span><div className="memory-actions"><button type="button" disabled={saving} onClick={() => navigate({ kind: 'cancel' })}>Cancel</button><button className="memory-primary" type="submit" disabled={!dirty || !editor.draft!.title.trim() || saving || editor.conflict || Boolean(pendingAction)}><Save size={13} aria-hidden="true" />{saving ? 'Saving…' : 'Save'}</button></div></div>
      </form> : botId && <>
        <div className="memory-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search memory titles or IDs" placeholder="Search titles or IDs" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="memory-list-heading"><h3>Saved notes{notes !== null ? ` · ${notes.length}` : ''}</h3><button type="button" aria-label="Refresh memory list" disabled={listStatus === 'loading'} onClick={refreshList}><RefreshCw size={14} aria-hidden="true" /></button></div>
        {listStatus === 'loading' && <p className="memory-muted" role="status">{notes === null ? 'Loading notes…' : 'Refreshing notes…'}</p>}
        {listError && <div className="memory-error" role="alert"><p>{listError}</p>{notes !== null && <p>Showing the last loaded list.</p>}<button type="button" onClick={refreshList}>Try again</button></div>}
        {notes !== null && <>
          {notes.length === 0 ? <div className="memory-empty"><FileText size={23} aria-hidden="true" /><h3>No saved notes yet</h3><p>Create a note to keep a useful fact for {botName}.</p><button type="button" onClick={() => navigate({ kind: 'new' })}><Plus size={14} aria-hidden="true" />Create a note</button></div>
            : visibleNotes.length === 0 ? <p className="memory-empty" role="status">No titles or IDs match “{query}”.</p>
              : <ul className="memory-list" aria-label="Saved memory notes">{visibleNotes.map(note => <li key={note.id}><button type="button" aria-current={note.id === selectedId ? 'true' : undefined} onClick={() => navigate({ kind: 'note', id: note.id })}><strong>{note.title || 'Untitled note'}</strong><span><UpdatedAt value={note.updatedAt} /><small><Link2 size={11} aria-hidden="true" />{note.links.length} link{note.links.length === 1 ? '' : 's'}</small></span></button></li>)}</ul>}
        </>}
        {detail.status === 'loading' && <p className="memory-loading-note" role="status">Loading note…</p>}
        {detail.status === 'error' && <div className="memory-error" role="alert"><p>{detail.error}</p><button type="button" onClick={() => loadNote(selectedId!)}>Retry note</button></div>}
        {detail.status === 'ready' && <MemoryNote note={detail.note!} notes={notes || []} listReady={listStatus === 'ready'} titleRef={titleRef} onNavigate={id => navigate({ kind: 'note', id })} />}
        {detail.status === 'idle' && Boolean(notes?.length) && <p className="memory-muted memory-pick-note">Choose a note to read it and follow its links.</p>}
      </>}
    </div>
  </section>
}
