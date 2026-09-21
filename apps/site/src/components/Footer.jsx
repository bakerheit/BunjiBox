import Mark from './Mark.jsx'

export default function Footer() {
  return (
    <footer className="border-t border-hairline py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Mark className="h-5 w-5" />
          BunjiBox
        </div>
        <p className="text-sm text-neutral-500 sm:ml-auto">
          Local agent workbench · alpha · runs on your Mac
        </p>
      </div>
    </footer>
  )
}
