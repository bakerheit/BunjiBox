import Mark from './Mark.tsx'

const links = [
  { href: '#screenshots', label: 'Screenshots' },
  { href: '#surfaces', label: 'Surfaces' },
  { href: '#features', label: 'Features' },
  { href: '#memory', label: 'Memory' },
  { href: '#install', label: 'Install' },
]

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-surface/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-6">
        <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Mark className="h-6 w-6" />
          BunjiBox
        </a>
        <span className="ml-1 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand-soft">
          alpha
        </span>
        <div className="ml-auto hidden items-center gap-7 text-sm text-neutral-400 md:flex">
          {links.map(link => (
            <a key={link.href} href={link.href} className="transition hover:text-neutral-100">
              {link.label}
            </a>
          ))}
        </div>
        <a
          href="#install"
          className="ml-auto rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white transition hover:bg-brand-bright md:ml-7"
        >
          Get started
        </a>
      </nav>
    </header>
  )
}
