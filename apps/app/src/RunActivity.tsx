import { Brain, ChevronRight, Terminal, ListChecks } from 'lucide-react'
import Markdown from './Markdown'
import './RunActivity.css'

export default function RunActivity({ activities = [], status, limited = false }) {
  const tools = activities.filter(item => item.kind === 'tool').length
  const thoughts = activities.filter(item => item.kind === 'reasoning').length
  const running = status === 'running'
  return <details className="run-activity">
    <summary><ChevronRight size={14} /><span>{running ? 'Working' : 'Activity'}{activities.length ? ` · ${tools} tool call${tools === 1 ? '' : 's'}${thoughts ? ` · ${thoughts} reasoning summar${thoughts === 1 ? 'y' : 'ies'}` : ''}` : ''}</span>{running && <span className="activity-pulse" />}</summary>
    <div className="activity-content">
      <p className="activity-note">Provider-exposed summaries and tool activity—not private internal thinking. Details can contain local file content.</p>
      {!activities.length && <p className="activity-empty">{running ? 'Waiting for provider activity…' : 'No tool calls or reasoning summaries were reported.'}</p>}
      {!running && activities.length > 0 && !thoughts && <p className="activity-note">No reasoning summary was provided for this run.</p>}
      {activities.map(item => <details className="activity-item" key={item.id}>
        <summary><ChevronRight size={12} />{item.kind === 'reasoning' ? <Brain size={14} /> : item.kind === 'plan' ? <ListChecks size={14} /> : <Terminal size={14} />}<span>{item.title}</span><small className={'activity-status ' + item.status}>{item.status === 'running' ? 'Running' : item.status === 'failed' ? 'Failed' : item.status === 'unknown' ? 'Unconfirmed' : 'Done'}</small></summary>
        <div className="activity-detail">
          {item.text && <Markdown text={item.text} />}
          {item.input && <><h4>Input</h4><pre tabIndex={0}>{item.input}</pre></>}
          {item.output && <><h4>Output</h4><pre tabIndex={0}>{item.output}</pre></>}
          {typeof item.exitCode === 'number' && <p className="activity-note">Exit code {item.exitCode}</p>}
          {!item.text && !item.input && !item.output && <p className="activity-note">No details were exposed by the provider.</p>}
        </div>
      </details>)}
      {limited && <p className="activity-note">Activity display limited to the first 150 items. Usage totals still include the full run.</p>}
    </div>
  </details>
}
