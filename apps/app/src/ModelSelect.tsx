import { ChevronDown } from 'lucide-react'
import { automaticMode, effortSteps, runtimes } from '@bunji/shared/runtimes'
import type { Bot, Provider } from '@bunji/shared/types'

interface ModelSelectProps {
  bot: Pick<Bot, 'provider' | 'model' | 'effort'>
  onChange: (changes: Pick<Bot, 'provider' | 'model' | 'effort' | 'mode'>) => void
  label?: string
  compact?: boolean
}

export default function ModelSelect({ bot, onChange, label = 'Model', compact = false }: ModelSelectProps) {
  return <label className={compact ? 'model-pill' : 'field'}>
    {compact ? null : <span>{label}</span>}
    <select aria-label={label} value={bot.provider + ':' + bot.model} onChange={event => {
      const separator = event.target.value.indexOf(':')
      // Option values are built from the runtimes catalog below.
      const provider = event.target.value.slice(0, separator) as Provider
      const model = event.target.value.slice(separator + 1)
      onChange({ provider, model, effort: effortSteps(provider, model).includes(bot.effort) ? bot.effort : 'medium', mode: automaticMode(provider) })
    }}>
      {Object.entries(runtimes).map(([provider, runtime]) => <optgroup key={provider} label={runtime.label}>
        {runtime.models.map(model => <option key={model.id} value={provider + ':' + model.id}>{model.label}</option>)}
      </optgroup>)}
    </select>
    {compact && <ChevronDown size={13} />}
  </label>
}
