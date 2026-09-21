export const runtimes = {
  claude: { label: 'Claude', models: [
    { id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' },
  ] },
  codex: { label: 'Codex', models: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ] },
  ollama: { label: 'Ollama · Pi', models: [
    { id: 'gemma3:1b', label: 'Gemma3 1B · Raspberry Pi' },
  ] },
}

export function effortSteps(provider, model) {
  if (provider === 'ollama') return ['low', 'medium']
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
