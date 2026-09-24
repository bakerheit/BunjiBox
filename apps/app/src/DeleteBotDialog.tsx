import { useEffect, useRef, useState } from 'react'
import type { ChatClient } from '@bunji/shared/chat-client'
import { errorMessage } from '@bunji/shared/errors'
import type { Bot, BotsSnapshot, DeleteBotOptions, MemoryNoteSummary } from '@bunji/shared/types'

interface DeleteBotDialogProps {
  bot: Pick<Bot, 'id' | 'name'>
  choices: Pick<Bot, 'id' | 'name'>[]
  client: ChatClient
  onClose: () => void
  onDeleted: (options: DeleteBotOptions) => Promise<BotsSnapshot>
}

interface MemoryCheck {
  loading: boolean
  notes: MemoryNoteSummary[]
  revision: string
  error: string
}

export default function DeleteBotDialog({ bot, choices, client, onClose, onDeleted }: DeleteBotDialogProps) {
  const [state, setState] = useState<MemoryCheck>({ loading: true, notes: [], revision: '', error: '' })
  const [action, setAction] = useState<'move' | 'delete'>('move')
  const [targetId, setTargetId] = useState(choices[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.querySelector('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const items = [...element!.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled])')]
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
      .catch((error: unknown) => { if (alive) setState(current => ({ ...current, loading: false, error: errorMessage(error) })) })
    return () => { alive = false }
  }, [bot.id, client])
  const remove = async () => {
    if (busy || state.loading || !state.revision) return
    setBusy(true); setState(current => ({ ...current, error: '' }))
    try {
      const move = state.notes.length > 0 && action === 'move'
      await onDeleted({ memoryAction: move ? 'move' : 'delete', ...(move ? { targetBotId: targetId } : {}), expectedMemoryRevision: state.revision })
    } catch (error) { setState(current => ({ ...current, error: errorMessage(error) })) }
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
