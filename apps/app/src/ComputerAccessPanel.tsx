import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, Folder, X } from 'lucide-react'
import { errorMessage } from '@bunji/shared/errors'
import type { Bot, ComputerLevel, ComputerNetwork, ComputerScope } from '@bunji/shared/types'
import './ComputerAccessPanel.css'

/**
 * The panel's editable draft. Unlike the saved ComputerProfile, a folder draft
 * may still have an empty (or missing) path while the user types.
 */
export interface ComputerDraft {
  scope: ComputerScope
  level: ComputerLevel
  network: ComputerNetwork
  folder?: string
}

/** The bot fields this panel reads. `computer` may be a saved profile or an older shape. */
export interface ComputerPanelBot {
  id: string
  name?: string
  computer?: unknown
}

const DEFAULT_COMPUTER = Object.freeze({ scope: 'none', level: 'read', network: 'off' } as const)

function normalizeComputer(value: unknown): ComputerDraft {
  // Also accepts older field names (access, mode, permission) from earlier builds.
  const computer = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const rawScope = computer.scope || computer.access || computer.mode
  const scope = rawScope === 'folder' || rawScope === 'selected-folder' ? 'folder' : rawScope === 'machine' || rawScope === 'full' || rawScope === 'full-machine' || rawScope === 'mac' ? 'machine' : 'none'
  const rawLevel = computer.level || computer.permission || computer.permissions
  const level = rawLevel === 'ask' || rawLevel === 'ask-before-changes' ? 'ask' : rawLevel === 'auto' || rawLevel === 'work' || rawLevel === 'automatic' || rawLevel === 'work-automatically' ? 'auto' : 'read'
  const normalized: ComputerDraft = { ...DEFAULT_COMPUTER, scope, level, network: computer.network === 'ask' ? 'ask' : 'off' }
  if (scope === 'folder') normalized.folder = typeof computer.folder === 'string' ? computer.folder : ''
  return normalized
}

function isAbsoluteMacPath(path: string) {
  return path.startsWith('/')
}

interface SaveResult {
  error?: string
  bot?: Bot
  bots?: Bot[]
}

async function requestJson(path: string, { method, body }: { method?: string; body?: unknown } = {}): Promise<SaveResult> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new Error('Cannot reach BunjiBox on this Mac. Your changes are still here.')
  }

  const result = await response.json().catch(() => ({})) as SaveResult
  if (!response.ok) throw new Error(result.error || 'Could not save computer access.')
  return result
}

interface OptionProps {
  checked: boolean
  description: string
  id: string
  label: string
  name: string
  onChange: () => void
  value: string
}

function RadioOption({ checked, description, id, label, name, onChange, value, warning = false }: OptionProps & { warning?: boolean }) {
  return <label className={'computer-access-option' + (checked ? ' is-selected' : '') + (warning ? ' is-warning' : '')} htmlFor={id}>
    <input id={id} type="radio" name={name} value={value} checked={checked} onChange={onChange} />
    <span className="computer-access-option-copy"><strong>{label}</strong><small>{description}</small></span>
  </label>
}

function PermissionOption({ checked, description, id, label, name, onChange, value }: OptionProps) {
  return <label className={'computer-permission-option' + (checked ? ' is-selected' : '')} htmlFor={id}>
    <input id={id} type="radio" name={name} value={value} checked={checked} onChange={onChange} />
    <span><strong>{label}</strong><small>{description}</small></span>
  </label>
}

interface FullAccessDialogProps {
  botName: string
  error: string
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

function FullAccessDialog({ botName, error, pending, onCancel, onConfirm }: FullAccessDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const previous = document.activeElement
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onCancel()
      if (event.key !== 'Tab') return
      const buttons = [...dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []]
      if (!buttons.length) return
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)!.focus() }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [onCancel, pending])
  return <div className="computer-confirm-layer" role="presentation">
    <button className="computer-confirm-backdrop" type="button" aria-label="Cancel full access" disabled={pending} onClick={onCancel} />
    <section className="computer-confirm-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="computer-confirm-icon"><AlertTriangle aria-hidden="true" size={22} /></div>
      <h2 id={titleId}>Turn on full Mac access?</h2>
      <p id={descriptionId}><strong>{botName}</strong> can read and change files, run commands, and use the network across this Mac without asking for each action.</p>
      <p className="computer-confirm-phone-note">Anyone who can reach BunjiBox on your Wi‑Fi can send this bot full-access requests. Use it only on a trusted network.</p>
      {error && <p className="computer-panel-error" role="alert">{error}</p>}
      <div className="computer-confirm-actions">
        <button type="button" className="computer-secondary-button" onClick={onCancel} disabled={pending}>Cancel</button>
        <button ref={confirmRef} type="button" className="computer-danger-button" onClick={onConfirm} disabled={pending}>{pending ? 'Turning on…' : 'Turn on full access'}</button>
      </div>
    </section>
  </div>
}

/**
 * Standalone bot settings panel. The parent decides where it is shown and can
 * merge the saved bot through onSaved without needing to own its draft state.
 */
interface ComputerAccessPanelProps {
  bot?: ComputerPanelBot | null
  onSaved?: (bot: ComputerPanelBot, computer: ComputerDraft) => void
  onClose?: () => void
  onBack?: () => void
}

export default function ComputerAccessPanel(props: ComputerAccessPanelProps) {
  return <ComputerAccessPanelDraft key={props.bot?.id || 'new-bot'} {...props} />
}

function ComputerAccessPanelDraft({ bot, onSaved, onClose, onBack }: ComputerAccessPanelProps) {
  const initialComputer = normalizeComputer(bot?.computer)
  const [computer, setComputer] = useState(initialComputer)
  const [savedComputer, setSavedComputer] = useState(initialComputer)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const isFolder = computer.scope === 'folder'
  const isFullMachine = computer.scope === 'machine'
  const isDirty = JSON.stringify(computer) !== JSON.stringify(savedComputer)

  const update = (changes: Partial<ComputerDraft>) => {
    setComputer(current => ({ ...current, ...changes }))
    setError('')
    setNotice('')
  }

  const chooseAccess = (scope: ComputerScope) => {
    setComputer(current => {
      const next: ComputerDraft = { ...current, scope, network: 'off', level: scope === 'machine' ? 'auto' : scope === 'folder' && current.scope === 'folder' ? current.level : 'read' }
      // A new folder draft starts empty so Save shows the path error instead of throwing.
      if (scope === 'folder') next.folder = current.folder ?? ''
      else delete next.folder
      return next
    })
    setError('')
    setNotice('')
    setConfirmOpen(scope === 'machine' && savedComputer.scope !== 'machine')
  }

  const browseFolder = () => {
    setNotice('Folder browsing is not available in a browser. Enter or paste an absolute path instead.')
    folderInputRef.current?.focus()
  }

  const save = async (confirmed = false) => {
    if (!bot?.id) { setError('This bot is not ready yet. Try again in a moment.'); return false }
    if (isFullMachine && savedComputer.scope !== 'machine' && !confirmed) { setConfirmOpen(true); return false }
    if (isFolder && !isAbsoluteMacPath((computer.folder ?? '').trim())) {
      setError('Enter an absolute folder path, such as /Users/you/Documents/project.')
      folderInputRef.current?.focus()
      return false
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await requestJson(isFullMachine ? `/api/bots/${encodeURIComponent(bot.id)}/computer/enable-full-machine` : isFolder ? `/api/bots/${encodeURIComponent(bot.id)}/computer/enable-folder` : `/api/bots/${encodeURIComponent(bot.id)}`, {
        method: isFullMachine || isFolder ? 'POST' : 'PATCH',
        body: { computer },
      })
      const savedBot: ComputerPanelBot = result?.bot || result?.bots?.find(item => item.id === bot.id) || { ...bot, computer }
      setSavedComputer(computer)
      setNotice(isFullMachine ? 'Full access is on. This bot can work across this Mac.' : 'Computer access saved.')
      onSaved?.(savedBot, computer)
      return true
    } catch (requestError) {
      setError(errorMessage(requestError))
      return false
    } finally {
      setSaving(false)
    }
  }

  return <section className="computer-access-panel" aria-labelledby={`${id}-title`}>
    <header className="computer-panel-heading">
      {onBack ? <button className="computer-icon-button" type="button" onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></button> : <span className="computer-heading-spacer" aria-hidden="true" />}
      <div><p className="computer-panel-eyebrow">Bot settings</p><h1 id={`${id}-title`}>Computer access</h1></div>
      {onClose ? <button className="computer-icon-button" type="button" onClick={onClose} aria-label="Close computer access"><X size={18} /></button> : <span className="computer-heading-spacer" aria-hidden="true" />}
    </header>

    <div className="computer-panel-content">
      <p className="computer-panel-intro">Choose what <strong>{bot?.name || 'this bot'}</strong> can reach. Full access asks for confirmation before it is saved.</p>

      <fieldset className="computer-access-fieldset">
        <legend>Computer access</legend>
        <RadioOption id={`${id}-none`} name={`${id}-access`} value="none" checked={computer.scope === 'none'} onChange={() => chooseAccess('none')} label="No computer access" description="The bot gets no selected work folder or computer tools." />
        <RadioOption id={`${id}-folder`} name={`${id}-access`} value="folder" checked={isFolder} onChange={() => chooseAccess('folder')} label="A selected folder" description="Keep work limited to one folder you choose." />
        <RadioOption id={`${id}-full`} name={`${id}-access`} value="machine" checked={isFullMachine} onChange={() => chooseAccess('machine')} label="This Mac (full access)" description="Read and change files, run commands, and use the network across this Mac." warning />
      </fieldset>

      {isFolder && <div className="computer-folder-setting">
        <label htmlFor={`${id}-folder-path`}>Selected folder</label>
        <div className="computer-folder-input-row">
          <input ref={folderInputRef} id={`${id}-folder-path`} value={computer.folder} onChange={event => update({ folder: event.target.value })} placeholder="/Users/you/Documents/project" aria-describedby={`${id}-folder-help`} autoCapitalize="none" autoComplete="off" spellCheck="false" />
          <button type="button" className="computer-secondary-button" onClick={browseFolder}><Folder size={15} />Browse folder</button>
        </div>
        <p id={`${id}-folder-help`}>Enter an absolute path on this Mac. This setting runs after you save it.</p>
      </div>}

      {isFullMachine && <div className="computer-full-machine-warning" role="alert">
        <AlertTriangle aria-hidden="true" size={20} />
        <div><strong>Full Mac access</strong><p>This bot can run commands, change files, and use the network without asking each time. Only use BunjiBox on a trusted Wi‑Fi network.</p></div>
      </div>}

      {isFolder && <fieldset className="computer-access-fieldset">
        <legend>Permission level</legend>
        <PermissionOption id={`${id}-read`} name={`${id}-permission`} value="read" checked={computer.level === 'read'} onChange={() => update({ level: 'read' })} label="Read only" description="The bot can inspect files but cannot change them." />
        <PermissionOption id={`${id}-work`} name={`${id}-permission`} value="auto" checked={computer.level === 'auto'} onChange={() => update({ level: 'auto' })} label="Work automatically in selected folder" description="Make changes without asking, but only in the selected folder." />
        {computer.level === 'ask' && <p className="computer-panel-error">The old Ask mode is unavailable. Pick Read only or Allow changes to start work.</p>}
      </fieldset>}

      <div className="computer-panel-footer">
        <div className="computer-panel-status" aria-live="polite">
          {error && <p className="computer-panel-error" role="alert">{error}</p>}
          {!error && notice && <p className="computer-panel-notice"><Check size={15} />{notice}</p>}
          {!error && !notice && isFullMachine && isDirty && <p>Full access is selected but not saved.</p>}
          {!error && !notice && isFolder && isDirty && <p>Folder access is selected but not saved.</p>}
          {!error && !notice && !isFullMachine && !isFolder && isDirty && <p>Unsaved changes.</p>}
        </div>
        <button type="button" className="computer-save-button" onClick={() => void save()} disabled={saving || !isDirty}>{saving ? 'Saving…' : 'Save access'}</button>
      </div>
    </div>
    {confirmOpen && <FullAccessDialog botName={bot?.name || 'This bot'} error={error} pending={saving} onCancel={() => { setConfirmOpen(false); setComputer(savedComputer); setError('') }} onConfirm={() => { void save(true).then(ok => { if (ok) setConfirmOpen(false) }) }} />}
  </section>
}
