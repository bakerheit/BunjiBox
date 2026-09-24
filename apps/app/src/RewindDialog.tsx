import { useEffect, useRef } from 'react'

interface RewindDialogProps {
  /** The user message to rewind to. */
  message: { id: string; prompt: string }
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}

export default function RewindDialog({ message, busy, error, onClose, onConfirm }: RewindDialogProps) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.querySelector('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const items = [...element!.querySelectorAll<HTMLElement>('button:not([disabled])')]
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
