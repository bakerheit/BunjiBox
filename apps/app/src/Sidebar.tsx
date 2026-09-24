import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis, Gauge, Plus, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Bot } from '@bunji/shared/types'
import { Avatar } from './AvatarPicker'

interface SidebarProps {
  bots: Bot[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onCreate: () => void
  onClose?: () => void
  onDelete: (id: string) => void
  query: string
  setQuery: (query: string) => void
  page: 'chat' | 'usage'
  onUsage: () => void
}

export default function Sidebar({ bots, activeId, onSelect, onCreate, onClose, onDelete, query, setQuery, page, onUsage }: SidebarProps) {
  const [optionsId, setOptionsId] = useState<string | null>(null)
  const [optionsPosition, setOptionsPosition] = useState<{ left: number; top: number } | null>(null)
  const optionsRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
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
    const contains = (target: EventTarget | null) => menu?.contains(target as Node | null) || triggerRef.current?.contains(target as Node | null)
    const dismiss = (event: Event) => { if (!contains(event.target)) setOptionsId(null) }
    const escape = (event: KeyboardEvent) => {
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
    <div className="sidebar-heading"><span className="brand"><img src="/favicon.svg" width="20" height="20" alt="" />BunjiBox</span><Button variant="ghost" size="icon" aria-label="Create new bot" onClick={onCreate}><Plus /></Button>{onClose && <Button variant="ghost" size="icon" aria-label="Close menu" onClick={onClose}><X /></Button>}</div>
    <label className="sidebar-search"><Search size={15} /><input aria-label="Search bots" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="bot-list">{visibleBots.map(bot => <div key={bot.id} className={'bot-list-item ' + (page === 'chat' && activeId === bot.id ? 'selected' : '')}>
      <button aria-current={page === 'chat' && activeId === bot.id ? 'page' : undefined} className="bot-row" onClick={() => { setOptionsId(null); onSelect(bot.id) }}><Avatar tone={bot.id} /><span><strong>{bot.name || 'Untitled bot'}</strong><small>{bot.description || 'What can I take off your plate?'}</small></span></button>
      <button ref={optionsId === bot.id ? triggerRef : null} className="bot-options-trigger" aria-label={`Options for ${bot.name || 'Untitled bot'}`} aria-haspopup="menu" aria-expanded={optionsId === bot.id} onClick={() => setOptionsId(current => current === bot.id ? null : bot.id)}><Ellipsis size={18} aria-hidden="true" /></button>
    </div>)}{!visibleBots.length && <p className="quiet">No bots found.</p>}</div>
    <button className="sidebar-usage" aria-current={page === 'usage' ? 'page' : undefined} onClick={onUsage}><Gauge size={17} /><span>Usage</span></button>
    <div className="sidebar-foot"><span className="account-initials">B</span><span>Local workspace<small>Stored on this computer</small></span></div>
    {optionsId && bots.some(bot => bot.id === optionsId) && createPortal(<div className="bot-options-menu" role="menu" ref={optionsRef} style={{ ...optionsPosition, visibility: optionsPosition ? 'visible' : 'hidden' }}><button type="button" role="menuitem" disabled={bots.length < 2} onClick={() => { const id = optionsId; setOptionsId(null); onDelete(id) }}><Trash2 size={15} aria-hidden="true" />Delete agent</button>{bots.length < 2 && <span>Create another agent first.</span>}</div>, document.body)}
  </>
}
