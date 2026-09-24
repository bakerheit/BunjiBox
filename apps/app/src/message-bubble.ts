import type { CSSProperties } from 'react'
import type { Avatar } from '@bunji/shared/types'

export type MessageKind = 'user' | 'bot' | 'error'

// Keep human/error bubbles neutral; only an agent reply carries its identity.
export function messageBubbleStyle(kind: MessageKind, avatar?: Pick<Avatar, 'color'> | null): CSSProperties | undefined {
  if (kind !== 'bot') return undefined
  const color = avatar?.color
  const hex = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#777777'
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
  const tint = Math.min(...rgb) > 240 ? [122, 122, 122] : rgb
  const background = tint.map(channel => Math.round(31 * 0.85 + channel * 0.15))
  return { backgroundColor: `rgb(${background.join(', ')})` }
}
