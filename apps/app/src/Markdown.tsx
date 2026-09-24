import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { markdownUrl } from '@bunji/shared/markdown-url'
import './Markdown.css'

function CodeBlock({ children }) {
  const code = useRef(null)
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const language = children?.props?.className?.replace('language-', '') || 'code'
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(code.current.textContent)
      setCopied(true)
    } catch {
      const range = document.createRange()
      range.selectNodeContents(code.current)
      const selection = window.getSelection()
      selection.removeAllRanges(); selection.addRange(range)
      setManual(true)
    }
  }
  return <div className="markdown-code"><div className="markdown-code-bar"><span>{language}</span><button type="button" onClick={copy} aria-label="Copy code">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : manual ? 'Selected · copy manually' : 'Copy'}</button></div><pre ref={code} tabIndex={0}>{children}</pre></div>
}

const components = {
  pre: CodeBlock,
  a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  // Do not silently fetch remote tracking images embedded in a response.
  img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noopener noreferrer">[Image: {alt || 'open image'}]</a> : <span>[Image unavailable]</span>,
  table: ({ children }) => <div className="markdown-table" tabIndex={0}><table>{children}</table></div>,
}

export default function Markdown({ text }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={markdownUrl} components={components}>{text || ''}</ReactMarkdown></div>
}
