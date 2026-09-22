import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeAction,
  computerToolsFor,
  createSession,
  observationToolResult,
  pauseSession,
  recordFrame,
  resumeAgent,
  stopSession,
  takeOverSession,
} from './contract.mjs'

const policy = {
  allowedApps: ['bunji-browser'],
  allowedOrigins: ['https://example.test'],
  allowedActions: ['click', 'type', 'scroll', 'navigate'],
  maxActions: 4,
}

function session(source = 'codex-subscription') {
  return createSession({ sessionId: 'computer-1', requestId: 'run-1', source, policy })
}

function context(state, actor = 'agent') {
  return { requestId: state.requestId, source: state.source, actor, ownerEpoch: state.owner.epoch }
}

function frame(state, frameId = `frame-${state.nextFrameSequence}`, changes = {}) {
  return recordFrame(state, {
    frameId,
    sequence: state.nextFrameSequence,
    appId: 'bunji-browser',
    origin: 'https://example.test',
    image: { mimeType: 'image/png', data: 'ZmFrZS1pbWFnZQ==' },
    ariaSnapshot: '- button "Continue" [ref=button-1]',
    ...changes,
  }, context(state))
}

function click(state, changes = {}) {
  return authorizeAction(state, {
    frameId: state.latestFrame?.frameId || 'frame-1',
    frameSequence: state.latestFrame?.sequence || 1,
    sequence: state.nextActionSequence,
    action: { type: 'click', x: 20, y: 30 },
    ...changes,
  }, context(state))
}

test('computer tools appear only in Agent mode for visual MCP sources', () => {
  assert.deepEqual(computerToolsFor({ mode: 'chat', source: 'codex-subscription' }), [])
  assert.deepEqual(computerToolsFor({ mode: 'agent', source: 'typesafe-jev' }), [])
  assert.deepEqual(computerToolsFor({ mode: 'agent', source: 'openai-api' }), [])
  assert.deepEqual(computerToolsFor({ mode: 'agent', source: 'codex-subscription' }).map(tool => tool.name), ['computer_observe', 'computer_act'])
  assert.throws(() => session('typesafe-jev'), /decision-only/)
})

test('MCP observation bundles one frame, untrusted ARIA evidence, and its image', () => {
  const observed = frame(session())
  const result = observationToolResult(observed, context(observed))
  assert.equal(result.structuredContent.frameId, 'frame-1')
  assert.equal(result.structuredContent.evidenceIsUntrusted, true)
  assert.equal(JSON.parse(result.content[0].text).ariaSnapshot, observed.latestFrame.ariaSnapshot)
  assert.deepEqual(result.content[1], { type: 'image', data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' })
})

test('frame capture enforces app and exact origin allowlists', () => {
  const initial = session()
  assert.throws(() => frame(initial, 'frame-1', { appId: 'other-app' }), /App is outside/)
  assert.throws(() => frame(initial, 'frame-1', { origin: 'https://evil.test' }), /Site is outside/)
  assert.throws(() => frame(initial, 'frame-1', { origin: 'https://example.test/path' }), /exact HTTP\(S\) origin/)
  assert.throws(() => createSession({ sessionId: 'bad', requestId: 'run', source: 'codex-subscription', policy: { ...policy, allowedOrigins: ['*'] } }), /Invalid site origin/)
})

test('actions bind to a fresh frame and strict action sequence', () => {
  let current = frame(session())
  const accepted = click(current)
  assert.equal(accepted.execution, 'NOT_EXECUTED')
  assert.deepEqual(accepted.authorizedAction, { type: 'click', x: 20, y: 30 })
  current = accepted.state
  assert.throws(() => click(current), /already-consumed/)
  current = frame(current, 'frame-2')
  assert.throws(() => authorizeAction(current, { frameId: 'frame-1', frameSequence: 1, sequence: 2, action: { type: 'click', x: 1, y: 1 } }, context(current)), /stale/)
  assert.throws(() => authorizeAction(current, { frameId: 'frame-2', frameSequence: 2, sequence: 1, action: { type: 'click', x: 1, y: 1 } }, context(current)), /action sequence/)
  assert.throws(() => authorizeAction(current, { frameId: 'frame-2', frameSequence: 2, sequence: 2, action: { type: 'navigate', url: 'https://evil.test/' } }, context(current)), /Navigation target/)
  assert.equal(click(current).state.actionCount, 2)
})

test('source and request provenance are bound outside model tool arguments', () => {
  const observed = frame(session())
  assert.throws(() => observationToolResult(observed, { ...context(observed), requestId: 'other-run' }), /source does not match/)
  assert.throws(() => authorizeAction(observed, { frameId: 'frame-1', frameSequence: 1, sequence: 1, action: { type: 'click', x: 1, y: 1 } }, { ...context(observed), source: 'claude-subscription' }), /source does not match/)
})

test('pause, user takeover, handback, and stop enforce one writer', () => {
  const initial = frame(session())
  const paused = pauseSession(initial, context(initial))
  assert.equal(paused.status, 'paused')
  assert.throws(() => click(paused), /no longer owns/)

  const taken = takeOverSession(paused, context(paused, 'user'))
  assert.equal(taken.owner.actor, 'user')
  assert.throws(() => recordFrame(taken, { frameId: 'frame-2', sequence: 2 }, context(taken)), /no longer owns/)
  const handedBack = resumeAgent(taken, context(taken, 'user'))
  assert.ok(handedBack.owner.epoch > initial.owner.epoch)
  assert.throws(() => recordFrame(handedBack, { frameId: 'frame-3', sequence: 3 }, context(initial)), /no longer owns/)

  const stopped = stopSession(handedBack, context(handedBack, 'user'))
  assert.equal(stopped.status, 'stopped')
  assert.throws(() => takeOverSession(stopped, context(stopped, 'user')), /not available/)
  assert.throws(() => resumeAgent(stopped, context(stopped, 'user')), /hand control back/)
})
