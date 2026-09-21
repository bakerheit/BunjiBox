import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import './AvatarPicker.css'

const AvatarContext = createContext(null)
const DEFAULT_AVATAR = { shape: 'hexagon', color: '#777777', image: null }
const TABS = ['Bot', 'Generated', 'Upload']
const SHAPES = [
  { name: 'diamond', path: 'M 50 4 L 96 50 L 50 96 L 4 50 Z' },
  { name: 'circle', path: 'M 50 8 C 74 8 92 26 92 50 C 92 74 74 92 50 92 C 26 92 8 74 8 50 C 8 26 26 8 50 8 Z' },
  { name: 'pebble', path: 'M 57 11 C 75 11 86 26 91 46 C 98 68 82 89 58 90 C 34 92 10 79 8 58 C 6 36 30 11 57 11 Z' },
  { name: 'square', path: 'M 33 12 L 67 12 C 84 12 88 17 88 34 L 88 66 C 88 83 83 88 66 88 L 34 88 C 17 88 12 83 12 66 L 12 34 C 12 17 17 12 33 12 Z' },
  { name: 'pill', path: 'M 35 21 L 65 21 C 83 21 95 33 95 50 C 95 67 83 79 65 79 L 35 79 C 17 79 5 67 5 50 C 5 33 17 21 35 21 Z' },
  { name: 'triangle', path: 'M 41 15 Q 50 1 59 15 L 91 73 Q 102 92 80 92 L 20 92 Q -2 92 9 73 Z', eyeY: 57, eyeX: 70 },
  { name: 'hexagon', path: 'M 42 5 Q 50 0 58 5 L 85 21 Q 92 25 92 35 L 92 65 Q 92 75 85 79 L 58 95 Q 50 100 42 95 L 15 79 Q 8 75 8 65 L 8 35 Q 8 25 15 21 Z' },
  { name: 'cloud', path: 'M 19 40 C 13 19 34 8 49 18 C 69 8 86 21 84 39 C 103 49 97 76 78 79 C 65 91 49 90 40 82 C 22 91 3 78 5 60 C 5 50 10 43 19 40 Z' },
  { name: 'drop', path: 'M 46 7 Q 50 1 54 7 C 64 21 85 41 87 58 C 91 81 75 97 52 97 C 28 97 12 82 14 61 C 15 43 35 21 46 7 Z', eyeY: 54, eyeX: 73 },
]
const COLORS = [
  { name: 'White', value: '#ffffff' },
  { name: 'Brown', value: '#895e34' },
  { name: 'Red', value: '#ee1734' },
  { name: 'Orange', value: '#ff6a00' },
  { name: 'Amber', value: '#ff9c00' },
  { name: 'Green', value: '#00a56a' },
  { name: 'Teal', value: '#00ad9c' },
  { name: 'Blue', value: '#087ee7' },
  { name: 'Purple', value: '#8247e5' },
  { name: 'Pink', value: '#e82692' },
  { name: 'Gray', value: DEFAULT_AVATAR.color },
]

function avatarValue(value) {
  return {
    shape: SHAPES.some(shape => shape.name === value?.shape) ? value.shape : DEFAULT_AVATAR.shape,
    color: /^#[0-9a-f]{6}$/i.test(value?.color) ? value.color : DEFAULT_AVATAR.color,
    image: typeof value?.image === 'string' && value.image ? value.image : null,
  }
}

export function BotAvatar({ value = DEFAULT_AVATAR, small = false, selected = false }) {
  const avatar = avatarValue(value)
  const shape = SHAPES.find(item => item.name === avatar.shape)
  const eyeY = shape.eyeY || 43
  const eyeX = shape.eyeX || 77
  return <span className={`bot-avatar bb-bot-avatar${small ? ' small' : ''}`} role="img" aria-label={avatar.image ? 'Custom bot avatar' : `${avatar.shape} bot avatar`}>
    {avatar.image
      ? <img className="bb-bot-image" src={avatar.image} alt="" />
      : <svg className="bb-bot-art" viewBox="0 0 100 100" fill="none" aria-hidden="true">
        {selected && <path className="bb-bot-selection" d={shape.path} transform="translate(-5 -5) scale(1.1)" />}
        <path className="bb-bot-body" d={shape.path} fill={avatar.color} />
        <g fill="#090a0a">
          <ellipse cx="54" cy={eyeY} rx="4.1" ry="8.3" transform={`rotate(-18 54 ${eyeY})`} />
          <ellipse cx={eyeX} cy={eyeY - 4} rx="4.1" ry="8.3" transform={`rotate(-18 ${eyeX} ${eyeY - 4})`} />
        </g>
      </svg>}
  </span>
}

export function Avatar({ tone = 'cyan', small = false }) {
  const context = useContext(AvatarContext)
  return <BotAvatar value={context?.values[tone] || DEFAULT_AVATAR} small={small} />
}

export function AvatarProvider({ children, values = {}, onChange }) {
  return <AvatarContext.Provider value={{ values, save: onChange }}>{children}</AvatarContext.Provider>
}

function moveChoice(event, index, count, select, columns = 1) {
  const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }
  let next
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  else if (event.key in moves) next = (index + moves[event.key] + count) % count
  else return
  event.preventDefault()
  const group = event.currentTarget.parentElement
  select(next)
  group.children[next]?.focus()
}

// Settings owns the surrounding heading and name/description fields.
// Pass inline={false} to use the compact launcher and modal instead.
export function AvatarEditor({ tone = 'cyan', inline = true }) {
  return <AvatarEditorControls key={tone} tone={tone} inline={inline} />
}

function AvatarEditorControls({ tone, inline }) {
  const { values, save } = useContext(AvatarContext)
  const id = useId()
  const dialog = useRef(null)
  const uploadRequest = useRef(0)
  const fileInput = useRef(null)
  const [expanded, setExpanded] = useState(true)
  const [tab, setTab] = useState('Bot')
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const value = avatarValue(values[tone])

  useEffect(() => () => { uploadRequest.current += 1 }, [])

  const update = (next) => {
    uploadRequest.current += 1
    setUploading(false)
    try {
      save(tone, next)
      setError('')
      return true
    } catch {
      setError('Could not save this avatar. Check the workspace connection or try a smaller image.')
      return false
    }
  }

  const upload = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const request = ++uploadRequest.current
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setUploading(false)
      setError('Choose a PNG, JPG, or WebP up to 5 MB.')
      return
    }
    setError('')
    setUploading(true)
    let bitmap
    try {
      bitmap = await createImageBitmap(file)
      if (request !== uploadRequest.current) return
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 256
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image resizing is unavailable')
      const edge = Math.min(bitmap.width, bitmap.height)
      context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 256, 256)
      update({ image: canvas.toDataURL('image/webp', 0.85) })
    } catch {
      if (request === uploadRequest.current) setError('This image could not be opened. Try another PNG, JPG, or WebP.')
    } finally {
      bitmap?.close()
      if (request === uploadRequest.current) setUploading(false)
    }
  }

  const selectShape = index => update({ shape: SHAPES[index].name, image: null })
  const selectColor = index => update({ color: COLORS[index].value, image: null })
  const activeShape = value.image ? -1 : SHAPES.findIndex(shape => shape.name === value.shape)
  const activeColor = value.image ? -1 : COLORS.findIndex(color => color.value.toLowerCase() === value.color.toLowerCase())

  const builder = <div className="bb-avatar-builder">
    <button className="bb-avatar-preview" type="button" aria-label={expanded ? 'Hide avatar controls' : 'Customize bot avatar'} aria-expanded={expanded} aria-controls={`${id}-card`} onClick={() => setExpanded(!expanded)}><BotAvatar value={value} /></button>
    <div className="bb-avatar-card" id={`${id}-card`} hidden={!expanded}>
      <div className="bb-avatar-toolbar">
        <div className="bb-avatar-tabs" role="tablist" aria-label="Avatar source">
          {TABS.map((name, index) => <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={event => moveChoice(event, index, TABS.length, next => setTab(TABS[next]))}
          >{name}</button>)}
        </div>
        <button className="bb-avatar-reset" type="button" aria-label="Reset avatar to gray hexagon" onClick={() => { if (update(DEFAULT_AVATAR)) setTab('Bot') }}>Reset</button>
      </div>

      <div className="bb-avatar-bot-panel" role="tabpanel" id={`${id}-panel-Bot`} aria-labelledby={`${id}-tab-Bot`} hidden={tab !== 'Bot'}>
        <div className="bb-avatar-shapes" role="radiogroup" aria-label="Bot shape">
          {SHAPES.map((shape, index) => <button
            key={shape.name}
            className="bb-avatar-shape"
            type="button"
            role="radio"
            aria-label={`${shape.name[0].toUpperCase()}${shape.name.slice(1)} shape`}
            aria-checked={activeShape === index}
            tabIndex={index === Math.max(0, activeShape) ? 0 : -1}
            onClick={() => selectShape(index)}
            onKeyDown={event => moveChoice(event, index, SHAPES.length, selectShape, 4)}
          ><BotAvatar value={{ shape: shape.name, color: value.color }} selected={activeShape === index} /></button>)}
        </div>
        <div className="bb-avatar-colors" role="radiogroup" aria-label="Bot color">
          {COLORS.map((color, index) => <button
            key={color.value}
            className="bb-avatar-color"
            type="button"
            role="radio"
            aria-label={`${color.name} color`}
            aria-checked={activeColor === index}
            tabIndex={index === Math.max(0, activeColor) ? 0 : -1}
            style={{ '--avatar-swatch': color.value }}
            onClick={() => selectColor(index)}
            onKeyDown={event => moveChoice(event, index, COLORS.length, selectColor)}
          ><span /></button>)}
        </div>
      </div>

      <div className="bb-avatar-media-panel" role="tabpanel" id={`${id}-panel-Generated`} aria-labelledby={`${id}-tab-Generated`} hidden={tab !== 'Generated'}>
        <button type="button" className="bb-avatar-generated" aria-label="Use generated teal ceramic bot" aria-pressed={value.image === '/teal-bot.png'} onClick={() => update({ image: '/teal-bot.png' })}>
          <img src="/teal-bot.png" alt="Teal ceramic bot with soft studio lighting" width="160" height="160" />
          <span>{value.image === '/teal-bot.png' ? 'Using this avatar' : 'Use this avatar'}<span aria-hidden="true">{value.image === '/teal-bot.png' ? '✓' : '↗'}</span></span>
        </button>
        <div className="bb-avatar-media-copy"><p className="bb-avatar-media-title">A little more personality.</p><p>Created with imagegen. Pick this starter, or ask Bingo to generate a custom image and upload it here.</p><p className="bb-avatar-limitation">In-app generation is not connected yet.</p></div>
      </div>

      <div className="bb-avatar-media-panel" role="tabpanel" id={`${id}-panel-Upload`} aria-labelledby={`${id}-tab-Upload`} hidden={tab !== 'Upload'}>
        <button className="bb-avatar-upload-button" type="button" onClick={() => fileInput.current?.click()} disabled={uploading} aria-describedby={`${id}-upload-help`}>
          <span className="bb-avatar-upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg></span>
          <span>{uploading ? 'Resizing your picture…' : 'Choose a picture'}</span>
          <span className="bb-avatar-upload-types">PNG, JPG or WebP · up to 5 MB</span>
        </button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload avatar" hidden onChange={upload} />
        <p id={`${id}-upload-help`} className="bb-avatar-upload-help">Center-cropped to a square and resized to 256 × 256. Shared across your devices.</p>
        <p className="bb-avatar-sr-only" role="status">{uploading ? 'Resizing your picture.' : ''}</p>
      </div>
      {error && <p className="bb-avatar-error" role="alert">{error}</p>}
    </div>
  </div>

  if (inline) return builder

  return <>
    <button type="button" className="bb-avatar-launcher" onClick={() => dialog.current?.showModal()} aria-haspopup="dialog" aria-label="Customize bot avatar">
      <BotAvatar value={value} /><span>Customize avatar</span><span className="bb-avatar-launcher-arrow" aria-hidden="true">↗</span>
    </button>
    <dialog ref={dialog} className="bb-avatar-dialog" aria-labelledby={`${id}-title`} onClick={event => { if (event.target === event.currentTarget) dialog.current.close() }}>
      <div className="bb-avatar-dialog-content">
        <header className="bb-avatar-dialog-header"><h2 id={`${id}-title`}>Make it yours</h2><button type="button" autoFocus aria-label="Close avatar settings" onClick={() => dialog.current.close()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></header>
        {builder}
      </div>
    </dialog>
  </>
}
