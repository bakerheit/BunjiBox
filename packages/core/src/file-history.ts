import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export function localFileLinks(text = '') {
  if (typeof text !== 'string') return []
  const paths = new Set()
  // Accept explicit Markdown attachments, never bare paths in prose or prompts.
  for (const match of text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\.|[^\s()]|\([^()\n]*\))+)(?:\s+["'][^"'\n]*["'])?\s*\)/g)) {
    let path = match[1].replace(/^<|>$/g, '').replace(/\\([ ()])/g, '$1')
    try { path = path.startsWith('file://') ? fileURLToPath(path) : decodeURIComponent(path) } catch { continue }
    if (isAbsolute(path) && !path.startsWith('//')) paths.add(path)
  }
  return [...paths]
}

export async function publishResponseFiles({ bot, sourceId, text, files }) {
  for (const path of localFileLinks(text)) {
    // A reply can contain an outdated link; only existing, permitted files count.
    await files.register(bot.id, sourceId, path, { computer: bot.computer, change: 'shared' }).catch(() => {})
  }
}

// Recover paths that older Bunji versions kept in their tool log. Relative paths
// cannot be recovered safely because older runs did not save their working dir.
export async function recoverFileHistory({ bot, chats, files }) {
  if (bot.computer?.level !== 'auto' || !['folder', 'machine'].includes(bot.computer.scope)) return
  let before, requests = []
  do {
    const page = chats.history(bot.id, { limit: 1000, before })
    requests = [...page.requests, ...requests]
    before = page.hasMore ? page.nextBefore : null
  } while (before)
  for (const request of requests) {
    await publishResponseFiles({ bot, sourceId: request.id, text: request.text, files })
    for (const activity of request.activities || []) {
      if (activity.status !== 'complete') continue
      let candidates = []
      try {
        if (activity.title === 'File changes') candidates = JSON.parse(activity.input)
        else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(activity.title)) {
          const input = JSON.parse(activity.input)
          candidates = [{ path: input.file_path || input.notebook_path, kind: activity.title === 'Write' ? 'add' : 'update' }]
        }
        for (const candidate of Array.isArray(candidates) ? candidates : []) {
          if (typeof candidate.path !== 'string' || !isAbsolute(candidate.path)) continue
          await files.register(bot.id, request.id, candidate.path, { computer: bot.computer, change: ['delete', 'deleted'].includes(candidate.kind) ? 'deleted' : ['add', 'added'].includes(candidate.kind) ? 'created' : 'updated' }).catch(() => {})
        }
      } catch { /* Old display-only activity text can be truncated or redacted. */ }
    }
  }
}
