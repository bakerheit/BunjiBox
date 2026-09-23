import { ArrowRight, Terminal } from 'lucide-react'
import CodeBlock from './CodeBlock.jsx'
import hero from '../assets/hero.png'

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="grid-backdrop pointer-events-none absolute inset-0" />
      <div className="brand-glow pointer-events-none absolute inset-x-0 top-0 h-[420px]" />

      <div className="relative mx-auto grid max-w-6xl gap-14 px-6 pb-24 pt-20 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:pt-28">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface-raised px-3 py-1.5 text-xs text-neutral-400">
            <Terminal className="h-3.5 w-3.5 text-brand-cyan" />
            Open source · local workspace · macOS alpha
          </div>

          <h1 className="mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-white lg:text-6xl">
            One agent workspace.
            <br />
            <span className="bg-gradient-to-r from-brand-cyan via-brand to-brand-bright bg-clip-text text-transparent">
              Terminal, browser, phone.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-neutral-400">
            BunjiBox connects to locally signed-in Claude and Codex CLIs, with optional
            OpenRouter and Ollama support. Bots, chats, memory and files share one
            workspace you can open in a terminal, browser, or phone on your local network.
          </p>

          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-500">
            <li>MIT licensed</li>
            <li className="before:mr-6 before:text-hairline before:content-['•']">Use existing CLI sign-ins</li>
            <li className="before:mr-6 before:text-hairline before:content-['•']">Local workspace</li>
          </ul>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="#install"
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-3 font-medium text-white transition hover:bg-brand-bright"
            >
              Install it
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="#surfaces"
              className="rounded-lg border border-hairline px-5 py-3 font-medium text-neutral-300 transition hover:border-neutral-600 hover:text-white"
            >
              See how it works
            </a>
          </div>

          <div className="mt-9 max-w-md">
            <CodeBlock lines={['npm ci', 'npm link', 'bunji']} />
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-sm lg:max-w-none">
          <div className="absolute inset-0 -z-10 scale-90 rounded-full bg-brand/25 blur-[90px]" />
          <img
            src={hero}
            alt="A translucent box splitting into two layers, lit from inside in purple"
            className="w-full drop-shadow-[0_24px_60px_rgba(0,0,0,0.6)]"
          />
        </div>
      </div>
    </section>
  )
}
