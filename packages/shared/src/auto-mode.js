import { supportedModes } from './runtimes.js'

export const AUTO_AGENT_OPEN = '<bunji-agent-required>'
export const AUTO_AGENT_CLOSE = '</bunji-agent-required>'

export const AUTO_CHAT_INSTRUCTION = `BunjiBox is currently trying this request in lean Chat mode, without memory, web, files, shell, or computer tools. If you can fully answer without those tools, answer normally. If the request requires any unavailable tool or machine action, do not pretend to complete it. Respond only with ${AUTO_AGENT_OPEN}a short plain-language reason${AUTO_AGENT_CLOSE}. BunjiBox will then continue the same request in Agent mode within the user's saved permission limits.`

const agentSignals = [
  { pattern: /\b(open|use|control|click|type|write|read|show|inspect|create|save)\b.{0,60}\b(Notes|native|screen|window|fixture)\b/iu, reason: 'The request needs native computer tools.' },
  { pattern: /\b(create|edit|modify|patch|delete|remove|rename|move|copy|save|upload|download)\b.{0,50}\b(files?|folders?|director(?:y|ies)|repositor(?:y|ies)|projects?|spreadsheets?|workbooks?|documents?|pdfs?|images?|assets?|databases?)\b/iu, reason: 'The request asks to change or create files.' },
  { pattern: /\b(run|execute|install|uninstall|build|test|lint|deploy|launch|start|restart|stop)\b.{0,45}\b(command|script|server|app(?:lication)?|tests?|npm|pnpm|yarn|git|terminal|shell|service|process)\b/iu, reason: 'The request asks to run software or commands.' },
  { pattern: /\b(research|browse|search(?: the)? web|look up|find online|check online|latest|current price|today(?:'s)?)\b/iu, reason: 'The request needs live research or browsing.' },
  { pattern: /\b(on (?:my|this) (?:mac|machine|computer)|filesystem|file system|workspace folder|working directory)\b/iu, reason: 'The request refers to the local machine or workspace.' },
  { pattern: /\b(remember|save to memory|store this for later|update (?:your|the) memory)\b/iu, reason: 'The request asks to use persistent memory.' },
  { pattern: /\b(use|call|open)\b.{0,30}\b(tool|terminal|shell|browser|app|connector|mcp)\b/iu, reason: 'The request explicitly asks for a tool.' },
]

export function routeAutoPrompt(provider, prompt) {
  if (!supportedModes(provider).includes('agent')) return {
    mode: 'chat', modelCheck: false, reason: `${provider} is connected as a chat-only provider.`,
  }
  const text = typeof prompt === 'string' ? prompt : ''
  const signal = agentSignals.find(item => item.pattern.test(text))
  if (signal) return { mode: 'agent', modelCheck: false, reason: signal.reason }
  return { mode: 'chat', modelCheck: true, reason: 'No clear tool requirement was found; the selected model will verify that Chat mode is enough.' }
}

export function parseAgentHandoff(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text.startsWith(AUTO_AGENT_OPEN) || !text.endsWith(AUTO_AGENT_CLOSE)) return null
  const reason = text.slice(AUTO_AGENT_OPEN.length, -AUTO_AGENT_CLOSE.length).trim().replace(/\s+/gu, ' ')
  if (!reason || reason.length > 240) return null
  return reason
}

export function modeLabel(requestedMode, resolvedMode) {
  const resolved = resolvedMode === 'agent' ? 'Agent' : 'Chat'
  return requestedMode === 'auto' ? `Auto → ${resolved}` : resolved
}
