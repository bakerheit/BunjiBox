import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import CodeBlock from './CodeBlock.tsx'

export default function Install() {
  return (
    <section id="install" className="border-t border-hairline py-24">
      <div className="mx-auto max-w-6xl px-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-brand">Install</p>
        <h2 className="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-tight text-white">
          Node 22.18, a signed-in CLI, and about a minute.
        </h2>

        <div className="mt-12 grid gap-8 lg:grid-cols-3">
          <Step
            n="1"
            title="Connect a provider"
            body="Whichever you already have. BunjiBox reads live login status; nothing is hard-coded."
          >
            <CodeBlock lines={['codex login', 'claude auth login']} />
          </Step>

          <Step n="2" title="Run the terminal app" body="It starts the shared API itself when it needs one.">
            <CodeBlock lines={['git clone https://github.com/bakerheit/BunjiBox.git', 'cd BunjiBox', 'npm ci', 'npm link', 'bunji']} />
          </Step>

          <Step
            n="3"
            title="Or open the workbench"
            body="Then visit localhost:5173, or the host computer’s local address from a phone."
          >
            <CodeBlock lines={['npm run api', 'npm run dev']} />
          </Step>
        </div>

        <div className="mt-14 flex gap-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <h3 className="font-semibold text-amber-100">This is a LAN-only alpha</h3>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-amber-100/70">
              There is no account or device authentication. Anyone who can reach the web app
              on your network can grant a bot full access to the host computer and send it commands.
              Run it on a network you trust, and do not expose the dev server to the public
              internet.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

interface StepProps {
  n: string
  title: string
  body: string
  children: ReactNode
}

function Step({ n, title, body, children }: StepProps) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="grid h-7 w-7 place-items-center rounded-full border border-brand/40 bg-brand/10 font-mono text-xs text-brand-soft">
          {n}
        </span>
        <h3 className="font-semibold text-white">{title}</h3>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-neutral-400">{body}</p>
      <div className="mt-4">{children}</div>
    </div>
  )
}
