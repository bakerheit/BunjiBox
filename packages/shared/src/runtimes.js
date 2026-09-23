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
}

export function supportedModes(provider) {
  return runtimes[provider]?.modes || []
}

export function automaticMode(provider) {
  return supportedModes(provider).includes('auto') ? 'auto' : 'chat'
}

export function modeDisplay(requestedMode, resolvedMode = requestedMode) {
  const resolved = resolvedMode === 'agent' ? 'Agent' : 'Chat'
  return requestedMode === 'auto' ? `Auto → ${resolved}` : resolved
}

export function normalizeMode(provider, mode) {
  const supported = supportedModes(provider)
  if (!supported.length) return 'chat'
  if (mode === undefined || mode === null) return supported.includes('agent') ? 'agent' : supported[0]
  return supported.includes(mode) ? mode : supported[0]
}

export function effortSteps(provider, model) {
  if (provider === 'ollama') return ['low', 'medium']
  if (provider === 'openrouter') return ['low', 'medium', 'high']
  const steps = ['low', 'medium', 'high', 'xhigh']
  if (model !== 'gpt-5.5') steps.push('max')
  if (provider === 'codex' && ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'].includes(model)) steps.push('ultra')
  return steps
}

export function normalizeRuntime(value = {}) {
  const provider = Object.hasOwn(runtimes, value.provider) ? value.provider : 'codex'
  const model = runtimes[provider].models.some(item => item.id === value.model) ? value.model : runtimes[provider].models[0].id
  const effort = effortSteps(provider, model).includes(value.effort) ? value.effort : 'medium'
  return { provider, model, effort }
}
