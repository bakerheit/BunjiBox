import { executionModes, supportedModes } from '@bunji/shared/runtimes'
import { modeNote } from './mode-copy'
import './ModePicker.css'

export default function ModePicker({ provider, mode, onChange, compact = false }) {
  const supported = supportedModes(provider)
  return <div className={'mode-picker-wrap' + (compact ? ' compact' : '')}>
    <div className="mode-picker" role="group" aria-label="Run mode">
      {Object.entries(executionModes).map(([id, option]) => {
        const available = supported.includes(id)
        return <button key={id} type="button" aria-pressed={mode === id} disabled={!available}
          title={available ? option.description : `${option.label} mode is not available for this provider.`}
          onClick={() => onChange(id)}>{option.label}</button>
      })}
    </div>
    {!compact && <p className="mode-picker-note">{modeNote(provider, mode)}</p>}
  </div>
}
