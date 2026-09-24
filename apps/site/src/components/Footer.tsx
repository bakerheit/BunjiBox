import Mark from './Mark.tsx'

export default function Footer() {
  return (
    <footer className="border-t border-hairline py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Mark className="h-5 w-5" />
          BunjiBox
        </div>
        <div className="flex flex-wrap gap-5 text-sm text-neutral-500 sm:ml-auto">
          <span>Local agent workbench · macOS alpha</span>
          <a className="hover:text-neutral-100" href="https://github.com/bakerheit/BunjiBox">GitHub</a>
          <a className="hover:text-neutral-100" href="https://github.com/bakerheit/BunjiBox/blob/main/CONTRIBUTING.md">Contribute</a>
          <a className="hover:text-neutral-100" href="https://github.com/bakerheit/BunjiBox/blob/main/LICENSE">MIT license</a>
        </div>
      </div>
    </footer>
  )
}
