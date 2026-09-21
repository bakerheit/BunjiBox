import { Bot, FolderOpen, Gauge, HardDrive, ShieldHalf, Sparkles } from 'lucide-react'

const features = [
  {
    icon: Bot,
    title: 'A bot per job',
    body: 'Name it, describe it, give it a colour and a shape. Each bot keeps its own provider, model, effort level and history — and keeps that history when you switch models mid-conversation.',
  },
  {
    icon: Sparkles,
    title: 'Providers you already pay for',
    body: 'Claude on Opus, Sonnet or Haiku with low-through-max effort. Codex on GPT-6 Astra, GPT-5.6 Sol, Terra, Luna or GPT-5.5. Sign in with codex login or claude auth login and that is the whole setup.',
  },
  {
    icon: HardDrive,
    title: 'Ollama on the side',
    body: 'Point BUNJI_OLLAMA_URL at a box on your LAN — a Raspberry Pi is plenty for Gemma3 1B — and run a local model next to the hosted ones.',
  },
  {
    icon: ShieldHalf,
    title: 'Computer access, scoped',
    body: 'Every bot gets one of three profiles: no computer, a folder you pick, or full access to this Mac. Folder work runs inside Codex’s workspace-write sandbox. Full access asks first.',
  },
  {
    icon: FolderOpen,
    title: 'Files that come back to you',
    body: 'Bunji indexes what an agent actually wrote — Codex edits, Claude Write/Edit calls, and anything it registers with files_publish. Preview images, Markdown and text in the sidebar, or download the original.',
  },
  {
    icon: Gauge,
    title: 'Know what it cost',
    body: 'Live tool activity, a per-request token log and subscription usage meters for both providers. Long runs have no wall-clock timeout; stop them yourself when you have seen enough.',
  },
]

export default function Features() {
  return (
    <section id="features" className="border-t border-hairline py-24">
      <div className="mx-auto max-w-6xl px-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-brand">What you get</p>
        <h2 className="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-tight text-white">
          A workbench, not a chat box.
        </h2>

        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <article key={title} className="bg-surface-raised p-7 transition hover:bg-surface-raised/40">
              <Icon className="h-5 w-5 text-brand" />
              <h3 className="mt-4 font-semibold text-white">{title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-neutral-400">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
