import { Marked } from 'marked'
import type { MarkedExtension } from 'marked'
import { markedTerminal } from 'marked-terminal'
import type { TerminalRendererOptions } from 'marked-terminal'
import stripAnsi from 'strip-ansi'
import wrapAnsi from 'wrap-ansi'
import sliceAnsi from 'slice-ansi'
import type { Activity, TokenUsage } from '@bunji/shared/types'
import type { CliBot } from '@bunji/shared/bots'
import type { ProviderUsage, UsageWindow } from '@bunji/core/usage'

/** What the token log reads from a request: a saved shared-chat request or a direct run. */
export interface TokenLogRequest {
  status: string
  model: string
  effort: string
  provider?: string
  usage?: TokenUsage | null
  durationMs?: number | null
}

/** What the transcript reads from a request. */
export interface TranscriptRequest extends TokenLogRequest {
  prompt: string
  text?: string
  error?: string | null
  activities: readonly Pick<Activity, 'kind'>[]
  contextTurns?: number
  omittedTurns?: number
}

/** What the Usage panel reads. Core's UsageSnapshot satisfies it; the offline demo supplies only this. */
export interface UsageView {
  providers: Record<string, Pick<ProviderUsage, 'label'> & Partial<Pick<ProviderUsage, 'plan' | 'message' | 'connected' | 'loginCommand'>> & {
    windows: Pick<UsageWindow, 'label' | 'usedPercent' | 'remainingPercent' | 'resetsAt'>[]
  }>
}

// Model/tool output must not be allowed to move the cursor, rewrite the title,
// set the clipboard, or emit terminal control sequences.
export function safeText(value: unknown): string {
  // oxlint-disable-next-line eslint/no-control-regex -- Untrusted terminal output must not contain control characters.
  return stripAnsi(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\t/g, '  ')
}

// @types/marked-terminal lags the package: it omits the `image` option and
// types the result as a Renderer rather than the marked extension it returns.
const terminalOptions: TerminalRendererOptions & { image: (href: string, title: string, text: string) => string } = {
  reflowText: false, showSectionPrefix: false, emoji: false,
  image: (_href, _title, text) => `[Image: ${safeText(text)}]`,
}
const markdown = new Marked(markedTerminal(terminalOptions) as MarkedExtension)
// Plain links avoid OSC hyperlinks and make destinations visible in all terminals.
markdown.use({ renderer: {
  text(token) { return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : safeText(token.text) },
  link({ text, href }) { return `${safeText(text)} (${safeText(href)})` },
  html({ text }) { return safeText(text) },
  list(token) {
    return token.items.map((item, index) => {
      const bullet = item.task ? item.checked ? '[x] ' : '[ ] ' : token.ordered ? `${Number(token.start) + index}. ` : '• '
      return bullet + this.parser.parse(item.tokens).trim().replace(/\n/g, '\n  ')
    }).join('\n') + '\n\n'
  },
} })

export function markdownLines(text: string, width: number): string[] {
  let output
  try { output = markdown.parse(safeText(text), { async: false }).trimEnd() } catch { output = safeText(text) }
  return wrapAnsi(output, Math.max(1, width), { hard: true, trim: false }).split('\n')
}
export function plainLines(text: string, width: number): string[] { return wrapAnsi(safeText(text), Math.max(1, width), { hard: true, trim: false }).split('\n') }
export function fit(text: string, width: number): string { return sliceAnsi(text, 0, Math.max(0, width)) }
export function viewport(lines: readonly string[], height: number, offset = 0, fromBottom = false) {
  const max = Math.max(0, lines.length - height)
  const clamped = Math.max(0, Math.min(offset, max))
  const start = fromBottom ? max - clamped : clamped
  return { lines: lines.slice(start, start + height), start, max, end: Math.min(lines.length, start + height) }
}

export const count = (value: number | null | undefined): string => typeof value === 'number' && Number.isSafeInteger(value) ? value.toLocaleString('en-US') : '—'
const statusLabels: Record<string, string> = { running: 'RUNNING', complete: 'DONE', failed: 'FAILED', cancelled: 'STOPPED', unknown: 'UNCONFIRMED' }
export const statusLabel = (value: string): string => statusLabels[value] || value

export function transcriptLines(bot: Pick<CliBot, 'shape' | 'name' | 'description'>, requests: readonly TranscriptRequest[], width: number): string[] {
  if (!requests.length) return [
    '', `${safeText(bot.shape)}  ${safeText(bot.name)}`, '',
    'What can I take off your plate?', '',
    ...plainLines(bot.description || 'A little help, a fresh idea, or a task to get moving.', width), '',
    ...plainLines('Write a message below. Use /help for commands, or Ctrl+K for the command palette.', width), '',
    'Enter sends · Ctrl+J adds a line', 'Ctrl+G models · Ctrl+E effort',
  ]
  return requests.flatMap((request, index) => [
    `YOU  ·  ${index + 1}`, ...markdownLines(request.prompt, width), '',
    `${safeText(bot.name).toUpperCase()}  ·  ${safeText(request.model)}  ·  ${request.effort}`,
    ...(request.text ? markdownLines(request.text, width) : [request.status === 'running' ? 'Working…' : '']),
    ...(request.error ? plainLines(request.error, width) : []),
    `${request.activities.filter(item => item.kind === 'tool').length} tool calls · ${statusLabel(request.status)} · ${count(request.usage?.totalTokens)} tokens`,
    ...(request.omittedTurns ? [`Context: ${request.contextTurns} recent turns; ${request.omittedTurns} older turns omitted.`] : []),
    '', '─'.repeat(Math.max(1, width)), '',
  ])
}

export function tokenLines(requests: readonly TokenLogRequest[], width: number): string[] {
  const known = requests.filter(request => Number.isSafeInteger(request.usage?.totalTokens))
  const total = known.reduce((sum, request) => sum + (request.usage?.totalTokens ?? 0), 0)
  return [
    'CONVERSATION TOTAL', '', `${known.length && known.length < requests.length ? '≥ ' : ''}${count(known.length || !requests.length ? total : null)} tokens`,
    `${requests.length} requests · ${known.length} measured`, '',
    ...plainLines('Cumulative usage, not context size. Cache reads are already included in input.', width), '',
    ...[...requests].reverse().flatMap((request, index) => [
      `Request ${requests.length - index} · ${statusLabel(request.status)}`,
      ...plainLines(request.model + ' · ' + request.effort, width),
      `Input       ${count(request.usage?.inputTokens)}`,
      `Output      ${count(request.usage?.outputTokens)}`,
      `Cache read  ${count(request.usage?.cachedInputTokens)}`,
      ...(request.provider === 'claude' ? [`Cache write ${count(request.usage?.cacheWriteTokens)}`] : []),
      `Total       ${count(request.usage?.totalTokens)}`,
      `Duration    ${request.durationMs == null ? 'running' : (request.durationMs / 1000).toFixed(1) + 's'}`, '',
    ]),
  ]
}

export function usageLines(usage: UsageView | null, loading: boolean, width: number): string[] {
  if (!usage) return [loading ? 'Reading subscription usage…' : 'Press R to read subscription usage.']
  return [loading ? 'Refreshing…' : 'R to refresh', '', ...Object.values(usage.providers).flatMap(provider => [
    safeText(provider.label).toUpperCase() + (provider.plan ? ' · ' + safeText(provider.plan) : ''), '',
    ...plainLines(provider.message || '', width),
    ...provider.windows.flatMap(window => {
      const cells = Math.max(5, Math.min(22, width - 2))
      const filled = window.usedPercent == null ? 0 : Math.round(window.usedPercent / 100 * cells)
      return [safeText(window.label), '▰'.repeat(filled) + '▱'.repeat(cells - filled), window.usedPercent == null ? 'Usage unavailable' : `${window.usedPercent}% used · ${window.remainingPercent}% left`, window.resetsAt ? 'Resets ' + new Date(window.resetsAt).toLocaleString() : 'Reset time unavailable', '']
    }),
    // A missing login command renders as a blank line, as before.
    ...(provider.connected === false ? [provider.loginCommand ?? '', ''] : []), '',
  ])]
}
