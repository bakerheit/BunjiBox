import { isProvider, normalizeMode, normalizeRuntime, supportsModel, effortSteps } from './runtimes.ts'
import { distinctAvatarShapes } from './avatars.ts'
import type { Avatar, Bot, ComputerProfile, Effort, NativeComputerTarget, RequestedMode } from './types.ts'

export const colors = ['cyan', 'blue', 'magenta', 'green', 'yellow', 'red', 'white'] as const
export type ColorName = typeof colors[number]
export const colorValues: Record<ColorName, string> = { cyan: '#00ad9c', blue: '#087ee7', magenta: '#8247e5', green: '#00a56a', yellow: '#ff9c00', red: '#ee1734', white: '#ffffff' }
export const shapes: Record<string, string> = { hexagon: '⬡', circle: '●', square: '■', diamond: '◆', triangle: '▲', pebble: '●', pill: '▬', cloud: '☁', drop: '♦', ...Object.fromEntries(distinctAvatarShapes.map(shape => [shape.name, shape.glyph])) }
const fields = ['name', 'description', 'provider', 'model', 'effort', 'mode', 'avatar', 'computer', 'nativeComputer']
const nativeTargets: readonly NativeComputerTarget[] = ['off', 'fixture', 'com.apple.Notes']
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be text up to ${max} characters.`)
  // oxlint-disable-next-line eslint/no-control-regex -- Remove control characters from persisted display text.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

export function avatarValue(value: unknown = {}): Avatar {
  if (!object(value)) throw new Error('Invalid avatar.')
  const avatar = { shape: value.shape ?? 'hexagon', color: value.color ?? '#777777', image: value.image ?? null }
  if (typeof avatar.shape !== 'string' || !Object.hasOwn(shapes, avatar.shape) || typeof avatar.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(avatar.color)) throw new Error('Invalid avatar shape or color.')
  if (avatar.image !== null && (typeof avatar.image !== 'string' || avatar.image.length > 350000 || (avatar.image !== '/teal-bot.png' && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar.image)))) throw new Error('Avatar must be a small PNG, JPG or WebP, or the built-in image.')
  return avatar as Avatar
}

// Keep the browser's shared-bot snapshot faithful to the server profile. This
// is deliberately structural validation only: filesystem checks stay in the
// Node-only permission module on the server, never in the Vite bundle.
export function computerValue(value: unknown = { scope: 'none', level: 'read', network: 'off' }): ComputerProfile {
  if (!object(value) || Object.keys(value).some(key => !['scope', 'level', 'folder', 'network'].includes(key))) throw new Error('Invalid computer settings.')
  const scope = value.scope ?? 'none', level = value.level ?? 'read', network = value.network ?? 'off'
  if (!['none', 'folder', 'machine'].includes(scope as string) || !['read', 'ask', 'auto'].includes(level as string) || !['off', 'ask'].includes(network as string)) throw new Error('Invalid computer settings.')
  if (scope === 'folder') {
    if (typeof value.folder !== 'string' || !value.folder.startsWith('/')) throw new Error('A computer folder must be an absolute path.')
    return { scope, level, folder: value.folder, network } as ComputerProfile
  }
  if (value.folder !== undefined) throw new Error('A computer folder is only valid for folder access.')
  return { scope, level, network } as ComputerProfile
}

export function makeBot(value: unknown): Bot {
  if (!object(value) || !validId(value.id)) throw new Error('Invalid bot ID.')
  if (value.nativeComputer !== undefined && !nativeTargets.includes(value.nativeComputer as NativeComputerTarget)) throw new Error('Unsupported native target.')
  const runtime = normalizeRuntime(value)
  if (value.provider !== undefined && !isProvider(value.provider)) throw new Error('Unknown provider.')
  if (value.model !== undefined && !supportsModel(runtime.provider, value.model)) throw new Error('Unsupported model.')
  if (value.effort !== undefined && !effortSteps(runtime.provider, runtime.model).includes(value.effort as Effort)) throw new Error('Unsupported effort.')
  if (value.mode !== undefined && normalizeMode(runtime.provider, value.mode) !== value.mode) throw new Error('That mode is not supported by this provider.')
  return { id: value.id, name: text(value.name ?? 'New bot', 60, 'Name').replace(/\n/g, ' '), description: text(value.description ?? '', 1800, 'Description'), ...runtime,
    mode: normalizeMode(runtime.provider, value.mode), nativeComputer: (value.nativeComputer ?? 'off') as NativeComputerTarget, avatar: avatarValue(value.avatar), computer: computerValue(value.computer) }
}

export function patchBot(bot: Bot, changes: unknown): Bot {
  if (!object(changes) || Object.keys(changes).some(key => !fields.includes(key))) throw new Error('Unknown bot setting.')
  const next: Record<string, unknown> = { ...bot, ...changes, avatar: changes.avatar ? { ...bot.avatar, ...changes.avatar as object } : bot.avatar }
  if (changes.provider !== undefined || changes.model !== undefined) {
    // A provider/model switch can invalidate the previous model or effort.
    Object.assign(next, normalizeRuntime(next))
    if (changes.provider !== undefined && !isProvider(changes.provider)) throw new Error('Unknown provider.')
    if (changes.model !== undefined && !supportsModel(next.provider as Bot['provider'], changes.model)) throw new Error('Unsupported model.')
    next.mode = normalizeMode(next.provider, next.mode)
  }
  if (changes.mode !== undefined && normalizeMode(next.provider, changes.mode) !== changes.mode) throw new Error('That mode is not supported by this provider.')
  if (changes.effort !== undefined && !effortSteps(next.provider, next.model).includes(changes.effort as Effort)) throw new Error('Unsupported effort.')
  return makeBot(next)
}

export const defaultBots = (): Bot[] => [
  makeBot({ id: 'bunjibox', name: 'BunjiBox', mode: 'auto', avatar: { color: colorValues.cyan } }),
  makeBot({ id: 'scout', name: 'Scout', mode: 'auto', description: 'Research and compare tools. Cite sources and keep findings concise.', avatar: { shape: 'circle', color: colorValues.magenta } }),
]

export function legacyBot(value: unknown): Bot {
  const legacy = (object(value) ? value : {}) as Record<string, unknown>
  const fallback = defaultBots().find(bot => bot.id === legacy.id)?.avatar
  const shape = Object.entries(shapes).find(([, glyph]) => glyph === legacy.shape)?.[0]
  const color = typeof legacy.color === 'string' ? legacy.color : undefined
  return makeBot({ ...legacy, ...normalizeRuntime(legacy), avatar: legacy.avatar || (color || shape ? { shape: shape || 'hexagon', color: (color && colorValues[color as ColorName]) || '#777777' } : fallback) })
}

/** A bot with the terminal's color/glyph fields added. */
export type CliBot = Bot & { color: string; shape: string | undefined }
export const cliBot = (bot: Bot): CliBot => ({ ...bot, color: bot.avatar.color, shape: shapes[bot.avatar.shape] })

export interface CliChanges {
  name?: string
  description?: string
  provider?: Bot['provider']
  model?: string
  effort?: Effort
  mode?: RequestedMode
  color?: string
  shape?: string
  avatar?: Partial<Avatar>
  [key: string]: unknown
}

export function cliChanges(changes: CliChanges): Record<string, unknown> {
  const { color, shape, ...rest } = changes
  if (color || shape) rest.avatar = { ...rest.avatar, ...(color ? { color: colorValues[color as ColorName] || color, image: null } : {}), ...(shape ? { shape: Object.entries(shapes).find(([, glyph]) => glyph === shape)?.[0] || 'hexagon', image: null } : {}) }
  return Object.fromEntries(Object.entries(rest).filter(([key]) => fields.includes(key)))
}
