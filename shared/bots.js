import { normalizeRuntime, runtimes, effortSteps } from '../src/runtimes.js'

export const colors = ['cyan', 'blue', 'magenta', 'green', 'yellow', 'red', 'white']
export const colorValues = { cyan: '#00ad9c', blue: '#087ee7', magenta: '#8247e5', green: '#00a56a', yellow: '#ff9c00', red: '#ee1734', white: '#ffffff' }
export const shapes = { hexagon: '⬡', circle: '●', square: '■', diamond: '◆', triangle: '▲', pebble: '●', pill: '▬', cloud: '☁', drop: '♦' }
const fields = ['name', 'description', 'provider', 'model', 'effort', 'avatar', 'computer']
export const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be text up to ${max} characters.`)
  // oxlint-disable-next-line eslint/no-control-regex -- Remove control characters from persisted display text.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

export function avatarValue(value = {}) {
  if (!object(value)) throw new Error('Invalid avatar.')
  const avatar = { shape: value.shape ?? 'hexagon', color: value.color ?? '#777777', image: value.image ?? null }
  if (!Object.hasOwn(shapes, avatar.shape) || !/^#[0-9a-f]{6}$/i.test(avatar.color)) throw new Error('Invalid avatar shape or color.')
  if (avatar.image !== null && (typeof avatar.image !== 'string' || avatar.image.length > 350000 || (avatar.image !== '/teal-bot.png' && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar.image)))) throw new Error('Avatar must be a small PNG, JPG or WebP, or the built-in image.')
  return avatar
}

// Keep the browser's shared-bot snapshot faithful to the server profile. This
// is deliberately structural validation only: filesystem checks stay in the
// Node-only permission module on the server, never in the Vite bundle.
export function computerValue(value = { scope: 'none', level: 'read', network: 'off' }) {
  if (!object(value) || Object.keys(value).some(key => !['scope', 'level', 'folder', 'network'].includes(key))) throw new Error('Invalid computer settings.')
  const scope = value.scope ?? 'none', level = value.level ?? 'read', network = value.network ?? 'off'
  if (!['none', 'folder', 'machine'].includes(scope) || !['read', 'ask', 'auto'].includes(level) || !['off', 'ask'].includes(network)) throw new Error('Invalid computer settings.')
  if (scope === 'folder') {
    if (typeof value.folder !== 'string' || !value.folder.startsWith('/')) throw new Error('A computer folder must be an absolute path.')
    return { scope, level, folder: value.folder, network }
  }
  if (value.folder !== undefined) throw new Error('A computer folder is only valid for folder access.')
  return { scope, level, network }
}

export function makeBot(value) {
  if (!object(value) || !validId(value.id)) throw new Error('Invalid bot ID.')
  const runtime = normalizeRuntime(value)
  if (value.provider !== undefined && !Object.hasOwn(runtimes, value.provider)) throw new Error('Unknown provider.')
  if (value.model !== undefined && !runtimes[runtime.provider].models.some(model => model.id === value.model)) throw new Error('Unsupported model.')
  if (value.effort !== undefined && !effortSteps(runtime.provider, runtime.model).includes(value.effort)) throw new Error('Unsupported effort.')
  return { id: value.id, name: text(value.name ?? 'New bot', 60, 'Name').replace(/\n/g, ' '), description: text(value.description ?? '', 1800, 'Description'), ...runtime, avatar: avatarValue(value.avatar), computer: computerValue(value.computer) }
}

export function patchBot(bot, changes) {
  if (!object(changes) || Object.keys(changes).some(key => !fields.includes(key))) throw new Error('Unknown bot setting.')
  const next = { ...bot, ...changes, avatar: changes.avatar ? { ...bot.avatar, ...changes.avatar } : bot.avatar }
  if (changes.provider !== undefined || changes.model !== undefined) {
    // A provider/model switch can invalidate the previous model or effort.
    Object.assign(next, normalizeRuntime(next))
    if (changes.provider !== undefined && !Object.hasOwn(runtimes, changes.provider)) throw new Error('Unknown provider.')
    if (changes.model !== undefined && !runtimes[next.provider].models.some(model => model.id === changes.model)) throw new Error('Unsupported model.')
  }
  if (changes.effort !== undefined && !effortSteps(next.provider, next.model).includes(changes.effort)) throw new Error('Unsupported effort.')
  return makeBot(next)
}

export const defaultBots = () => [
  makeBot({ id: 'bunjibox', name: 'BunjiBox', avatar: { color: colorValues.cyan } }),
  makeBot({ id: 'scout', name: 'Scout', description: 'Research and compare tools. Cite sources and keep findings concise.', avatar: { shape: 'circle', color: colorValues.magenta } }),
]

export function legacyBot(value) {
  const fallback = defaultBots().find(bot => bot.id === value?.id)?.avatar
  const shape = Object.entries(shapes).find(([, glyph]) => glyph === value?.shape)?.[0]
  return makeBot({ ...value, ...normalizeRuntime(value), avatar: value.avatar || (value.color || shape ? { shape: shape || 'hexagon', color: colorValues[value.color] || '#777777' } : fallback) })
}

export const cliBot = bot => ({ ...bot, color: bot.avatar.color, shape: shapes[bot.avatar.shape] })
export function cliChanges(changes) {
  const { color, shape, ...rest } = changes
  if (color || shape) rest.avatar = { ...rest.avatar, ...(color ? { color: colorValues[color] || color, image: null } : {}), ...(shape ? { shape: Object.entries(shapes).find(([, glyph]) => glyph === shape)?.[0] || 'hexagon', image: null } : {}) }
  return Object.fromEntries(Object.entries(rest).filter(([key]) => fields.includes(key)))
}
