// Keep human/error bubbles neutral; only an agent reply carries its identity.
export function messageBubbleStyle(kind, avatar) {
  if (kind !== 'bot') return undefined
  const hex = /^#[0-9a-f]{6}$/i.test(avatar?.color) ? avatar.color : '#777777'
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
  const tint = Math.min(...rgb) > 240 ? [122, 122, 122] : rgb
  const background = tint.map(channel => Math.round(31 * 0.85 + channel * 0.15))
  return { backgroundColor: `rgb(${background.join(', ')})` }
}
