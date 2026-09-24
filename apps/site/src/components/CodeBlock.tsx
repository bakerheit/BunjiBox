import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

interface CodeBlockProps {
  lines: string[]
  label?: string
}

export default function CodeBlock({ lines, label }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const text = lines.join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard is unavailable over plain http on some hosts. The text is
      // selectable either way, so a failed copy is not worth an error state.
    }
  }

  return (
    <div className="group relative overflow-hidden rounded-xl border border-hairline bg-black/40 text-left">
      {label && (
        <div className="border-b border-hairline px-4 py-2 font-mono text-[11px] tracking-wide text-neutral-500">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-6 text-neutral-300">
        {lines.map(line => (
          <div key={line}>
            <span className="select-none text-brand/70">$ </span>
            {line}
          </div>
        ))}
      </pre>
      <button
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        className="absolute right-2 top-2 rounded-lg p-2 text-neutral-500 opacity-0 transition hover:bg-white/5 hover:text-neutral-200 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-4 w-4 text-brand-cyan" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  )
}
