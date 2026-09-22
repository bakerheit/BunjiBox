import { executionModes } from '@bunji/shared/runtimes'

export function modeNote(provider, mode) {
  if (mode === 'auto') return executionModes.auto.description
  if (mode === 'agent') return executionModes.agent.description
  if (provider === 'codex') return 'Lean Codex CLI request using the signed-in Codex account—not ChatGPT consumer chat or an OpenAI API. Bunji tools are off.'
  if (provider === 'claude') return 'Lean Claude Code request using the signed-in account, with customizations and tools disabled. Bunji tools are off.'
  if (provider === 'openrouter') return 'Direct OpenRouter API chat. Bunji memory, files, and computer tools are off.'
  return 'Direct local-model chat. Bunji memory, files, and computer tools are off.'
}
