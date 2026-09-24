import type { Effort, ExecutionMode, Provider, RequestedMode, RuntimeInfo, RuntimeSelection } from './types.ts'

export const runtimes = {
  claude: { label: 'Claude', modes: ['auto', 'chat', 'agent'], models: [
    { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' },
  ] },
  codex: { label: 'Codex', modes: ['auto', 'chat', 'agent'], models: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ] },
  openrouter: { label: 'OpenRouter', modes: ['chat'], models: [
    { id: 'openrouter/free', label: 'Free Model Router' },
    { id: 'openrouter/auto', label: 'Auto Router' },
  ] },
  ollama: { label: 'Ollama', modes: ['chat'], models: [
    { id: 'gemma3:1b', label: 'Gemma3 1B' },
    // Keep existing agents readable when a new default model is introduced.
    { id: 'qwen3:1.7b', label: 'Qwen3 1.7B' },
  ] },
} as const satisfies Record<Provider, RuntimeInfo>

export const providers = Object.keys(runtimes) as Provider[]

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(runtimes, value)
}

export function supportsModel(provider: Provider, model: unknown): model is string {
  return (runtimes[provider].models as readonly { id: string }[]).some(item => item.id === model)
}

export const executionModes = {
  auto: {
    label: 'Auto',
    short: 'Bunji chooses Chat or Agent',
    description: 'Starts lean, uses clear request signals, and lets the selected model hand off to Agent when tools are needed. Saved permissions remain the hard limit.',
  },
  chat: {
    label: 'Chat',
    short: 'Fast replies without Bunji tools',
    description: 'Lean conversation mode. Bunji memory, files, and computer access are unavailable for this request.',
  },
  agent: {
    label: 'Agent',
    short: 'Full Bunji tool harness',
    description: 'Full agent mode with Bunji memory and any computer or file access enabled in settings.',
  },
} as const satisfies Record<RequestedMode, { label: string; short: string; description: string }>

export function supportedModes(provider: unknown): readonly RequestedMode[] {
  return isProvider(provider) ? runtimes[provider].modes : []
}

export function automaticMode(provider: unknown): RequestedMode {
  return supportedModes(provider).includes('auto') ? 'auto' : 'chat'
}

export function modeDisplay(requestedMode: RequestedMode, resolvedMode: RequestedMode = requestedMode): string {
  const resolved = resolvedMode === 'agent' ? 'Agent' : 'Chat'
  return requestedMode === 'auto' ? `Auto → ${resolved}` : resolved
}

export function normalizeMode(provider: unknown, mode?: unknown): RequestedMode {
  const supported = supportedModes(provider)
  if (!supported.length) return 'chat'
  if (mode === undefined || mode === null) return supported.includes('agent') ? 'agent' : supported[0]
  return supported.includes(mode as RequestedMode) ? mode as RequestedMode : supported[0]
}

export const isExecutionMode = (mode: unknown): mode is ExecutionMode => mode === 'chat' || mode === 'agent'

export function effortSteps(provider: unknown, model: unknown): Effort[] {
  if (provider === 'ollama') return ['low', 'medium']
  if (provider === 'openrouter') return ['low', 'medium', 'high']
  const steps: Effort[] = ['low', 'medium', 'high', 'xhigh']
  if (model !== 'gpt-5.5') steps.push('max')
  if (provider === 'codex' && typeof model === 'string' && ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'].includes(model)) steps.push('ultra')
  return steps
}

export function normalizeRuntime(value: { provider?: unknown; model?: unknown; effort?: unknown } = {}): RuntimeSelection {
  const provider: Provider = isProvider(value.provider) ? value.provider : 'codex'
  const model = supportsModel(provider, value.model) ? value.model : runtimes[provider].models[0].id
  const effort = effortSteps(provider, model).includes(value.effort as Effort) ? value.effort as Effort : 'medium'
  return { provider, model, effort }
}
