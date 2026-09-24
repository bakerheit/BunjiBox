import type { ReactNode } from 'react'
import { Monitor, Smartphone, TerminalSquare } from 'lucide-react'

const surfaces = [
  {
    icon: TerminalSquare,
    name: 'Terminal',
    line: 'bunji',
    body: 'A full-screen buffer that resizes with the window and restores your shell on exit. It starts the shared API itself — no Vite, no second process to babysit.',
    detail: 'Ctrl+B switch bot · Ctrl+G model · Ctrl+T tool activity · Ctrl+U usage',
  },
  {
    icon: Monitor,
    name: 'Browser',
    line: 'localhost:5173',
    body: 'The workbench: sidebar of bots, transcript, and a right panel for files, memory, activity and settings. Edit a finished message and the edit syncs everywhere.',
    detail: 'Markdown previews · token log · subscription meters',
  },
  {
    icon: Smartphone,
    name: 'Phone',
    line: 'the host’s local address',
    body: 'The same web app over your LAN. Pick up a conversation from another device; the run keeps going on the host whether or not a client is watching.',
    detail: 'Folder icon opens the sidebar as a drawer',
  },
]

export default function Surfaces() {
  return (
    <section id="surfaces" className="border-t border-hairline py-24">
      <div className="mx-auto max-w-6xl px-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-brand">Three surfaces, one workspace</p>
        <h2 className="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-tight text-white">
          Not three apps that sync. One workspace with three front doors.
        </h2>
        <p className="mt-5 max-w-2xl text-pretty leading-relaxed text-neutral-400">
          Bots, avatars, chat history, tool activity and token counts all live in a single
          SQLite workspace at <Code>~/.config/bunji/workspace.sqlite</Code>. Clients pick up
          changes about every two seconds, and one device's edits never stomp another's.
        </p>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {surfaces.map(({ icon: Icon, name, line, body, detail }) => (
            <article
              key={name}
              className="flex flex-col rounded-2xl border border-hairline bg-surface-raised p-6 transition hover:border-brand/40"
            >
              <Icon className="h-5 w-5 text-brand-cyan" />
              <h3 className="mt-4 font-semibold text-white">{name}</h3>
              <p className="mt-1 font-mono text-[12px] text-brand-soft/60">{line}</p>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-neutral-400">{body}</p>
              <p className="mt-5 border-t border-hairline pt-4 font-mono text-[11px] leading-5 text-neutral-600">
                {detail}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[13px] text-neutral-300">{children}</code>
  )
}
