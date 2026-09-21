import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, RotateCcw, Zap } from 'lucide-react'
import './EffortPicker.css'

const effortLabels = { xhigh: 'Extra high' }
const labelFor = (value) => effortLabels[value] || String(value).replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase())

/** `steps` accepts effort strings or { value, label } objects. onChange receives the value. */
export function EffortPicker({ modelLabel, effort, steps, onChange, defaultEffort = 'medium' }) {
  const options = (steps || []).map((step) => typeof step === 'string' ? { value: step, label: labelFor(step) } : step)
  const fallbackIndex = Math.max(0, options.findIndex((option) => option.value === defaultEffort))
  const selectedIndex = options.findIndex((option) => option.value === effort)
  const index = selectedIndex < 0 ? fallbackIndex : selectedIndex
  const current = options[index]
  const fallback = options[fallbackIndex]
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const rangeRef = useRef(null)
  const resetRef = useRef(null)
  const id = useId()
  const expanded = open && options.length > 0
  const progress = options.length > 1 ? index / (options.length - 1) : 0

  // A portal keeps the panel above composers with clipping or scrolling parents.
  useLayoutEffect(() => {
    if (!expanded) return

    const placePanel = () => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (!trigger || !panel) return
      const anchor = trigger.getBoundingClientRect()
      const bounds = panel.getBoundingClientRect()
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft || 0) + 12
      const topEdge = (viewport?.offsetTop || 0) + 12
      const rightEdge = (viewport?.offsetLeft || 0) + (viewport?.width || document.documentElement.clientWidth) - 12
      const next = {
        left: Math.max(leftEdge, Math.min(anchor.right - bounds.width, rightEdge - bounds.width)),
        top: Math.max(topEdge, anchor.top - bounds.height - 10),
      }
      setPosition((previous) => previous?.left === next.left && previous?.top === next.top ? previous : next)
    }

    placePanel()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(placePanel)
    observer?.observe(triggerRef.current)
    observer?.observe(panelRef.current)
    window.addEventListener('resize', placePanel)
    window.addEventListener('scroll', placePanel, true)
    window.visualViewport?.addEventListener('resize', placePanel)
    window.visualViewport?.addEventListener('scroll', placePanel)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', placePanel)
      window.removeEventListener('scroll', placePanel, true)
      window.visualViewport?.removeEventListener('resize', placePanel)
      window.visualViewport?.removeEventListener('scroll', placePanel)
    }
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const contains = (target) => triggerRef.current?.contains(target) || panelRef.current?.contains(target)
    const dismissOutside = (event) => {
      if (!contains(event.target)) setOpen(false)
    }
    const dismissEscape = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    const control = rangeRef.current?.disabled ? resetRef.current : rangeRef.current
    control?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('focusin', dismissOutside)
    document.addEventListener('keydown', dismissEscape, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('focusin', dismissOutside)
      document.removeEventListener('keydown', dismissEscape, true)
    }
  }, [expanded])

  const handleTab = (event) => {
    if (event.key !== 'Tab') return
    const first = resetRef.current
    const last = rangeRef.current?.disabled ? first : rangeRef.current
    if ((event.shiftKey && event.target === first) || (!event.shiftKey && event.target === last)) {
      // Resume the composer's tab order when leaving the portalled panel.
      if (event.shiftKey) event.preventDefault()
      triggerRef.current?.focus({ preventScroll: true })
      setOpen(false)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="effort-picker__trigger"
        aria-label={`Reasoning effort: ${current?.label || 'unavailable'}`}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-panel` : undefined}
        disabled={!current}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Zap size={15} aria-hidden="true" />
        <span>{current?.label || 'Select effort'}</span>
        <ChevronDown className="effort-picker__chevron" size={15} aria-hidden="true" />
      </button>

      {expanded && createPortal(
        <div
          ref={panelRef}
          id={`${id}-panel`}
          className="effort-picker__popover"
          role="dialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={modelLabel ? `${id}-model` : undefined}
          style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
          onKeyDown={handleTab}
        >
          <span id={`${id}-title`} className="effort-picker__sr-only">Reasoning effort</span>
          <div className="effort-picker__header">
            <Zap className="effort-picker__lightning" size={22} strokeWidth={1.7} aria-hidden="true" />
            <div className="effort-picker__heading">
              <span className="effort-picker__current" aria-hidden="true">{current.label}</span>
              {modelLabel && <span id={`${id}-model`} className="effort-picker__model" title={modelLabel}>{modelLabel}</span>}
            </div>
            <button
              ref={resetRef}
              type="button"
              className="effort-picker__reset"
              aria-label={`Reset effort to ${fallback.label}`}
              title={`Reset to ${fallback.label}`}
              onClick={() => onChange(fallback.value)}
            >
              <RotateCcw size={21} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>

          <div className="effort-picker__slider" style={{ '--effort-position': `${progress * 100}%` }}>
            <input
              ref={rangeRef}
              className="effort-picker__range"
              type="range"
              min={0}
              max={Math.max(1, options.length - 1)}
              step={1}
              value={index}
              disabled={options.length < 2}
              aria-label="Reasoning effort"
              aria-valuetext={current.label}
              aria-describedby={`${id}-hint`}
              onChange={(event) => onChange(options[Number(event.target.value)].value)}
            />
            <div className="effort-picker__visual" aria-hidden="true">
              <span className="effort-picker__track" />
              <div className="effort-picker__rail">
                <span className="effort-picker__fill" />
                {options.map((option, stepIndex) => (
                  <span
                    key={option.value}
                    className={`effort-picker__dot${stepIndex <= index ? ' effort-picker__dot--filled' : ''}`}
                    style={{ left: `${options.length > 1 ? stepIndex / (options.length - 1) * 100 : 0}%` }}
                  />
                ))}
                <span className="effort-picker__thumb" />
              </div>
            </div>
          </div>
          <span id={`${id}-hint`} className="effort-picker__sr-only">
            {options.length > 1 ? 'Use arrow keys to change effort. Home selects the lowest effort; End selects the highest.' : 'This model supports one effort level.'} Press Escape to close.
          </span>
        </div>,
        document.body,
      )}
    </>
  )
}

export default EffortPicker
