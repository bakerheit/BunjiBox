const note = [
  '---',
  'id: "tea"',
  'title: "Tea preference"',
  'links: ["morning-routine"]',
  '---',
  '',
  'Green tea, no sugar. Switches to coffee after 3pm.',
  'See [[morning-routine|the morning routine]].',
]

// Just enough colour to read as a file. A real highlighter would be more code
// than the eight lines it renders.
function highlight(line) {
  if (line === '---') return <span className="text-neutral-600">{line}</span>
  const colon = line.indexOf(':')
  if (colon > 0 && !line.includes('[[')) {
    return (
      <>
        <span className="text-brand-cyan">{line.slice(0, colon)}</span>
        <span className="text-neutral-400">{line.slice(colon)}</span>
      </>
    )
  }
  return <span className="text-neutral-300">{line || ' '}</span>
}

function Code({ children }) {
  return (
    <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[13px] text-neutral-300">{children}</code>
  )
}

export default function Memory() {
  return (
    <section id="memory" className="border-t border-hairline py-24">
      <div className="mx-auto grid max-w-6xl gap-14 px-6 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-brand">Memory</p>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-tight text-white">
            Agents that remember, in files you can read.
          </h2>
          <p className="mt-5 text-pretty leading-relaxed text-neutral-400">
            Every bot can search, read and write scoped Markdown notes — in the web app,
            in the terminal, and from inside a run. Ask it to remember something, or let
            it save a decision when one actually lands.
          </p>
          <p className="mt-4 text-pretty leading-relaxed text-neutral-400">
            Notes are plain Markdown on disk in <Code>~/.config/bunji/memory/&lt;bot-id&gt;/</Code>,
            with stable <Code>[[note-id|Title]]</Code> links back to the message that
            produced them. Grep them. Edit them in your own editor. Delete them. It is a
            folder.
          </p>
          <p className="mt-6 text-sm leading-relaxed text-neutral-500">
            Only relevant retrieved notes are sent to the provider, and not every message
            becomes a note. They are plaintext — don’t put secrets in them.
          </p>
        </div>

        <div className="rounded-2xl border border-hairline bg-black/40 p-1.5">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
            <span className="ml-2 font-mono text-[11px] text-neutral-600">memory/bunjibox/tea.md</span>
          </div>
          <pre className="overflow-x-auto rounded-xl bg-surface-raised px-5 py-4 font-mono text-[13px] leading-6">
            {note.map((line, index) => (
              <div key={index}>{highlight(line)}</div>
            ))}
          </pre>
        </div>
      </div>
    </section>
  )
}
