import { createHash } from 'node:crypto'
import { codexTokens, claudeTokens } from './run-output.mjs'

const MAX_DETAIL = 12000
const MAX_ACTIVITIES = 150

// Only selected, displayable fields cross the bridge. Never forward init/config,
// encrypted reasoning, signatures, images, or the raw provider event stream.
export function displayText(value) {
  const secret = /^(authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|signature|encrypted_content)$/i
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => secret.test(key) ? '[redacted]' : item, 2) || ''
  const clean = text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[redacted]')
  return clean.length > MAX_DETAIL ? clean.slice(0, MAX_DETAIL) + '\n… [display truncated]' : clean
}

const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : ''

export function createRunEvents(provider, onActivity = () => {}, onFile = () => {}) {
  const activities = new Map()
  const pendingFiles = new Map()
  let text = '', usage = null, finished = false, failed = false, limited = false
  const publish = (id, patch) => {
    if (!activities.has(id) && activities.size >= MAX_ACTIVITIES) { limited = true; return }
    const previous = activities.get(id)
    const next = { id, at: previous?.at || new Date().toISOString(), ...previous, ...patch }
    if (previous && Object.keys(patch).every(key => previous[key] === patch[key])) return
    activities.set(id, next)
    onActivity(next)
  }
  const consume = event => {
    if (!event || typeof event !== 'object') return
    if (provider === 'codex') {
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        usage = codexTokens(event.usage); finished = true; failed = event.type === 'turn.failed'
        return
      }
      if (!['item.started', 'item.updated', 'item.completed'].includes(event.type) || !event.item) return
      const item = event.item
      const id = item.id || 'event-' + activities.size
      const status = item.status === 'failed' || item.error || (Number.isInteger(item.exit_code) && item.exit_code !== 0) ? 'failed' : event.type === 'item.completed' ? 'complete' : 'running'
      if (item.type === 'agent_message') { if (event.type === 'item.completed') text = item.text || ''; return }
      if (item.type === 'reasoning') {
        if (item.text) publish(id, { kind: 'reasoning', title: 'Reasoning summary', status, text: displayText(item.text) })
      } else if (item.type === 'command_execution') {
        publish(id, { kind: 'tool', title: 'Run command', status, input: displayText(item.command), output: displayText(item.aggregated_output), exitCode: item.exit_code ?? null })
      } else if (item.type === 'mcp_tool_call') {
        publish(id, { kind: 'tool', title: displayText(`${item.server || 'MCP'} · ${item.tool || 'Tool'}`), status, input: displayText(item.arguments), output: displayText(item.error || contentText(item.result?.content) || item.result?.structuredContent) })
      } else if (item.type === 'web_search') {
        publish(id, { kind: 'tool', title: 'Web search', status, input: displayText(item.query || item.action), output: '' })
      } else if (item.type === 'file_change') {
        if (event.type === 'item.completed' && status === 'complete') for (const change of item.changes || []) {
          if (typeof change.path === 'string') onFile({ path: change.path, change: ['delete', 'deleted'].includes(change.kind) ? 'deleted' : ['add', 'added'].includes(change.kind) ? 'created' : 'updated' })
        }
        publish(id, { kind: 'tool', title: 'File changes', status, input: displayText(item.changes?.map(change => ({ path: change.path, kind: change.kind }))), output: '' })
      } else if (item.type === 'todo_list') {
        publish(id, { kind: 'plan', title: 'Plan', status, text: displayText(item.items?.map(todo => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n')) })
      } else if (item.type === 'error') {
        publish(id, { kind: 'notice', title: 'Provider notice', status: 'failed', text: displayText(item.message) })
      }
      return
    }
    if (event.type === 'result') {
      text = typeof event.result === 'string' ? event.result : text
      usage = claudeTokens(event.usage); finished = true; failed = event.is_error === true
      return
    }
    const content = event.message?.content
    if (!Array.isArray(content)) return
    const parent = event.parent_tool_use_id ? `${event.parent_tool_use_id}:` : ''
    for (const block of content) {
      if (event.type === 'assistant' && block.type === 'tool_use') {
        if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
          const path = block.input?.file_path || block.input?.notebook_path
          if (typeof path === 'string') pendingFiles.set(parent + block.id, { path, change: block.name === 'Write' ? 'created' : 'updated' })
        }
        publish(parent + block.id, { kind: 'tool', title: displayText(block.name || 'Tool'), status: 'running', input: displayText(block.input) })
      } else if (event.type === 'user' && block.type === 'tool_result') {
        const file = pendingFiles.get(parent + block.tool_use_id)
        if (file && !block.is_error) onFile(file)
        pendingFiles.delete(parent + block.tool_use_id)
        publish(parent + block.tool_use_id, { kind: 'tool', title: activities.get(parent + block.tool_use_id)?.title || 'Tool', status: block.is_error ? 'failed' : 'complete', output: displayText(contentText(block.content)) })
      } else if (event.type === 'assistant' && block.type === 'thinking' && block.thinking) {
        const id = parent + (event.message.id || event.uuid || '') + ':thinking:' + createHash('sha256').update(block.thinking).digest('hex').slice(0, 12)
        publish(id, { kind: 'reasoning', title: 'Thinking · provider summary', status: 'complete', text: displayText(block.thinking) })
      }
    }
  }
  const result = () => ({ text, usage, failed: failed || !finished, activities: [...activities.values()].map(item => item.status === 'running' ? { ...item, status: 'unknown' } : item), activityLimited: limited })
  return { consume, result }
}
