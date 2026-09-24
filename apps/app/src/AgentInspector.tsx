import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Activity, BookOpen, Check, ChevronDown, ChevronRight, FolderOpen, Laptop2, Settings2, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { effortSteps, runtimes } from '@bunji/shared/runtimes'
import type { Bot, BotChanges, ComputerProfile } from '@bunji/shared/types'
import { Avatar, AvatarEditor } from './AvatarPicker'
import { EffortPicker } from './EffortPicker'
import TokenLog from './TokenLog'
import type { LoggedRequest } from './TokenLog'
import MemoryPanel from './MemoryPanel'
import type { NavigationGuard } from './MemoryPanel'
import ComputerAccessPanel from './ComputerAccessPanel'
import FilesPanel from './FilesPanel'
import ModelSelect from './ModelSelect'
import type { ConnectionStatus } from './UsagePage'

/** The open inspector panel. 'details' is an older name for the files view. */
export type InspectorView = 'files' | 'memory' | 'log' | 'settings' | 'computer' | 'details'

type InspectorBot = Pick<Bot, 'id' | 'name' | 'description' | 'provider' | 'model' | 'effort'> & { computer?: ComputerProfile }

interface AgentInspectorProps {
  bot: InspectorBot
  update: (changes: BotChanges) => void
  refreshBots: () => Promise<void>
  status: ConnectionStatus
  view: InspectorView
  setView: (view: InspectorView) => void
  onClose: () => void
  onDelete: () => void
  canDelete: boolean
  saveError: string
  saving: boolean
  requests: LoggedRequest[]
  hasMore: boolean | undefined
}

function computerSummary(bot: { computer?: ComputerProfile }) {
  const access = bot.computer || { scope: 'none' as const }
  if (access.scope === 'folder') return access.level === 'auto' ? 'Folder changes allowed' : access.level === 'ask' ? 'Folder access needs approval' : 'Folder read only'
  if (access.scope === 'machine') return 'This Mac · full access'
  return 'Computer not connected'
}

export default function AgentInspector({ bot, update, refreshBots, status, view, setView, onClose, onDelete, canDelete, saveError, saving, requests, hasMore }: AgentInspectorProps) {
  const navigation = useRef<NavigationGuard | null>(null)
  const selectedTab = view === 'computer' ? 'settings' : view === 'details' ? 'files' : view
  const tabs: { id: InspectorView; title: string; icon: LucideIcon }[] = [{ id: 'files', title: 'Files', icon: FolderOpen }, { id: 'memory', title: 'Memory', icon: BookOpen }, { id: 'log', title: 'Activity', icon: Activity }, { id: 'settings', title: 'Settings', icon: Settings2 }]
  const changeTab = (next: InspectorView) => { if (view === 'memory' && navigation.current) navigation.current(() => setView(next)); else setView(next) }
  let content: ReactNode
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
