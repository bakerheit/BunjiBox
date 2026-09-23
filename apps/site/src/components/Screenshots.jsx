import desktop from '../../../../docs/assets/web-desktop.png'
import mobile from '../../../../docs/assets/web-mobile.jpg'

export default function Screenshots() {
  return (
    <section id="screenshots" className="border-t border-hairline py-24">
      <div className="mx-auto max-w-6xl px-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-brand">Inside the workbench</p>
        <h2 className="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-tight text-white">
          The same workspace on your desk and in your pocket.
        </h2>
        <p className="mt-5 max-w-2xl text-pretty leading-relaxed text-neutral-400">
          Real captures from a disposable local workspace. Chats, agent settings, and files
          stay in sync across the web client’s desktop and phone layouts.
        </p>
        <div className="mt-12 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_250px]">
          <figure className="overflow-hidden rounded-2xl border border-hairline bg-surface-raised shadow-2xl shadow-black/30">
            <img className="block h-auto w-full" src={desktop} width="1440" height="900" alt="BunjiBox desktop chat with the agent list, Markdown reply, model controls, and files sidebar" loading="lazy" />
            <figcaption className="border-t border-hairline px-4 py-3 text-sm text-neutral-400">Desktop workbench</figcaption>
          </figure>
          <figure className="mx-auto w-full max-w-[250px] overflow-hidden rounded-2xl border border-hairline bg-surface-raised shadow-2xl shadow-black/30">
            <img className="block h-auto w-full" src={mobile} width="391" height="847" alt="BunjiBox phone chat showing the same Markdown reply and compact composer" loading="lazy" />
            <figcaption className="border-t border-hairline px-4 py-3 text-sm text-neutral-400">Phone view</figcaption>
          </figure>
        </div>
      </div>
    </section>
  )
}
