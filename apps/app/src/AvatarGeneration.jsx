import { useEffect, useRef, useState } from 'react'
import { avatarGenerationRequest, cancelAvatarGeneration, normalizeAvatarImage } from './avatar-generation'

function waitForPoll(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1500)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  // getRandomValues also works on LAN HTTP origins without randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Mounted only for the current agent's Generate tab. All results stay local
// until the user explicitly applies a normalized picture.
export default function AvatarGeneration({ id, onUse }) {
  const [prompt, setPrompt] = useState('')
  const [attempt, setAttempt] = useState(null)
  const [state, setState] = useState({ phase: 'idle' })
  const active = useRef(null)
  const pendingJob = useRef(null)
  const creation = useRef(null)

  useEffect(() => () => {
    active.current?.abort()
    const job = pendingJob.current
    if (job) void cancelAvatarGeneration(job, creation.current).catch(() => {})
  }, [])

  useEffect(() => {
    if (!attempt) return
    const controller = new AbortController()
    active.current = controller
    const { signal } = controller
    const cancelling = attempt.action === 'cancel'
    let retryAction = attempt.action
    const run = async () => {
      try {
        let generation = attempt.action === 'start' ? await attempt.creation
          : cancelling ? await cancelAvatarGeneration(attempt.job, attempt.creation, signal)
            : await avatarGenerationRequest(attempt.job, 'poll', signal)
        while (!signal.aborted) {
          if (generation.status === 'running') {
            if (!cancelling) retryAction = 'poll'
            setState({ phase: cancelling ? 'cancelling' : 'running' })
            await waitForPoll(signal)
            generation = await avatarGenerationRequest(attempt.job, 'poll', signal)
            continue
          }
          pendingJob.current = null
          if (cancelling || generation.status === 'cancelled') {
            setState({ phase: 'cancelled', message: generation.status === 'complete' ? 'Generation finished before cancellation. Picture discarded.' : 'Generation cancelled.' })
          } else if (generation.status === 'failed') {
            setState({ phase: 'failed', error: typeof generation.error === 'string' ? generation.error.slice(0, 500) : 'ChatGPT could not generate this picture.' })
          } else {
            retryAction = 'poll'
            setState({ phase: 'resizing' })
            const image = await normalizeAvatarImage(generation.image)
            if (!signal.aborted) setState({ phase: 'complete', image })
          }
          return
        }
      } catch (error) {
        if (!signal.aborted) {
          if (cancelling && error.status === 404) {
            pendingJob.current = null
            setState({ phase: 'cancelled', message: 'This generation is no longer available. You can generate another picture.' })
            return
          }
          // An expired preview or rejected creation needs a new request, while
          // an ambiguous response must keep the original ID for retry.
          const rejected = !cancelling && (error.status === 404 || (retryAction === 'start' && [400, 401, 403, 409, 429].includes(error.status)))
          if (rejected) pendingJob.current = null
          setState({ phase: rejected ? 'failed' : 'error', error: error.message || 'Could not connect to avatar generation.', retryAction })
        }
      }
    }
    void run()
    return () => controller.abort()
  }, [attempt])

  const perform = (job, action) => {
    active.current?.abort()
    pendingJob.current = job
    if (action === 'start') {
      creation.current = avatarGenerationRequest(job, 'start')
      void creation.current.catch(() => {})
    }
    setState({ phase: action === 'cancel' ? 'cancelling' : 'running' })
    setAttempt({ job, action, creation: creation.current })
  }
  const generate = () => {
    const text = prompt.trim()
    if (!text || text.length > 2000) return
    try { perform({ id: newRequestId(), prompt: text }, 'start') }
    catch { setState({ phase: 'failed', error: 'Could not create a secure request ID. Reload the page and try again.' }) }
  }
  const busy = ['running', 'resizing', 'cancelling'].includes(state.phase)
  const unresolved = busy || state.phase === 'error'
  const usePicture = () => {
    if (state.phase !== 'complete' || active.current?.signal.aborted) return
    if (onUse(state.image)) setState({ phase: 'applied', image: state.image })
  }

  return <div className="bb-avatar-generation">
    <div className="bb-avatar-media-copy"><p className="bb-avatar-media-title">Make a picture with ChatGPT.</p><p>Uses your signed-in ChatGPT account. Generation may take a few minutes.</p></div>
    <label htmlFor={`${id}-prompt`}>Describe your avatar</label>
    <textarea id={`${id}-prompt`} rows={3} maxLength={2000} value={prompt} disabled={unresolved}
      placeholder="A tiny orange robot made of clay, on a soft blue background"
      aria-describedby={`${id}-generate-help`} onChange={event => setPrompt(event.target.value)} />
    <p id={`${id}-generate-help`} className="bb-avatar-upload-help">{prompt.length} / 2000 · Pictures are cropped to a square. Apply only when you’re happy with the result.</p>
    <p className="bb-avatar-generation-status" role="status" aria-live="polite">
      {state.phase === 'running' && 'Generating your picture… You can cancel at any time.'}
      {state.phase === 'resizing' && 'Resizing your picture…'}
      {state.phase === 'cancelling' && 'Cancelling generation…'}
      {state.phase === 'cancelled' && state.message}
      {state.phase === 'complete' && 'Your picture is ready to preview.'}
      {state.phase === 'applied' && 'Picture applied.'}
    </p>
    {state.image && <img className="bb-avatar-generated-preview" src={state.image} width="256" height="256" alt="Generated avatar preview" />}
    {state.error && <div className="bb-avatar-error" role="alert"><p>{state.error}</p><p>{state.phase === 'error' ? 'Check your connection and ChatGPT sign-in, then retry. Retrying reconnects to this request.' : 'Check your ChatGPT sign-in or edit the prompt, then try again.'}</p></div>}
    <div className="bb-avatar-generation-actions">
      {!unresolved && <button type="button" className="bb-avatar-generate-button" disabled={!prompt.trim()} onClick={generate}>{state.phase === 'idle' ? 'Generate' : state.phase === 'failed' || state.phase === 'cancelled' ? 'Try again' : 'Generate again'}</button>}
      {state.phase === 'error' && <button type="button" className="bb-avatar-generate-button" onClick={() => perform(attempt.job, state.retryAction)}>{state.retryAction === 'cancel' ? 'Retry cancellation' : 'Retry connection'}</button>}
      {unresolved && state.phase !== 'cancelling' && state.retryAction !== 'cancel' && <button type="button" className="bb-avatar-cancel-button" onClick={() => perform(attempt.job, 'cancel')}>Cancel</button>}
      {state.phase === 'complete' && <button type="button" className="bb-avatar-use-button" onClick={usePicture}>Use this picture</button>}
    </div>
    <p className="bb-avatar-upload-help">Leaving this tab discards the preview and requests cancellation of any pending generation.</p>
  </div>
}
