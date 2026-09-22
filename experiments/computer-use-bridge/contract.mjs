const sourceRoutes = Object.freeze({
  'codex-subscription': { adapter: 'mcp-stdio', screenshots: true, actions: true },
  'claude-subscription': { adapter: 'mcp-stdio', screenshots: true, actions: true },
  'openai-api': { adapter: 'responses-computer', screenshots: true, actions: true },
  'anthropic-api': { adapter: 'messages-computer-toolset', screenshots: true, actions: true },
  'typesafe-jev': { adapter: 'typed-decision-only', screenshots: false, actions: false },
})

const actionTypes = ['click', 'type', 'scroll', 'navigate']

const toolDefinitions = [
  {
    name: 'computer_observe',
    description: 'Return the current allowed-app screenshot and a bounded accessibility snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_act',
    description: 'Authorize one allowlisted action against the latest frame. A fresh observation is required after each action.',
    inputSchema: {
      type: 'object',
      properties: {
        frameId: { type: 'string', minLength: 1, maxLength: 128 },
        frameSequence: { type: 'integer', minimum: 1 },
        sequence: { type: 'integer', minimum: 1 },
        action: {
          oneOf: [
            { type: 'object', properties: { type: { const: 'click' }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['type', 'x', 'y'], additionalProperties: false },
            { type: 'object', properties: { type: { const: 'type' }, text: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['type', 'text'], additionalProperties: false },
            { type: 'object', properties: { type: { const: 'scroll' }, direction: { enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['type', 'direction', 'amount'], additionalProperties: false },
            { type: 'object', properties: { type: { const: 'navigate' }, url: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['type', 'url'], additionalProperties: false },
          ],
        },
      },
      required: ['frameId', 'frameSequence', 'sequence', 'action'],
      additionalProperties: false,
    },
  },
]

function fail(message) {
  throw new Error(message)
}

function normalizeOrigin(value) {
  let url
  try { url = new URL(value) } catch { return fail('Invalid site origin.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return fail('A site allowlist entry must be an exact HTTP(S) origin, with no path or credentials.')
  }
  return url.origin
}

function parseTargetUrl(value) {
  let url
  try { url = new URL(value) } catch { return fail('Invalid navigation URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('Only credential-free HTTP(S) navigation is allowed.')
  return url
}

function sourceRoute(source) {
  const route = sourceRoutes[source]
  if (!route) fail('Unknown computer-use source.')
  return route
}

function assertContext(state, context) {
  if (context?.requestId !== state.requestId || context?.source !== state.source) fail('Computer session source does not match this request.')
}

function assertAgentOwner(state, context) {
  if (state.status !== 'active' || state.owner.actor !== 'agent' || context?.actor !== 'agent' || context?.ownerEpoch !== state.owner.epoch) {
    fail('Agent no longer owns this computer session.')
  }
}

function assertFrameTarget(state, frame) {
  if (!state.policy.allowedApps.includes(frame.appId)) fail('App is outside the computer allowlist.')
  if (!state.policy.allowedOrigins.includes(normalizeOrigin(frame.origin))) fail('Site is outside the computer allowlist.')
}

function validateAction(action, state) {
  if (!action || !state.policy.allowedActions.includes(action.type)) fail('Action is not allowed by this computer policy.')
  switch (action.type) {
    case 'click':
      if (![action.x, action.y].every(value => Number.isFinite(value) && value >= 0 && value <= 8192)) fail('Click coordinates are invalid.')
      return { type: 'click', x: action.x, y: action.y }
    case 'type':
      if (typeof action.text !== 'string' || action.text.length < 1 || action.text.length > 1000) fail('Typed text is invalid.')
      return { type: 'type', text: action.text }
    case 'scroll':
      if (!['up', 'down', 'left', 'right'].includes(action.direction) || !Number.isInteger(action.amount) || action.amount < 1 || action.amount > 2000) fail('Scroll action is invalid.')
      return { type: 'scroll', direction: action.direction, amount: action.amount }
    case 'navigate': {
      const url = parseTargetUrl(action.url)
      if (!state.policy.allowedOrigins.includes(url.origin)) fail('Navigation target is outside the computer allowlist.')
      return { type: 'navigate', url: url.href }
    }
    default:
      return fail('Unknown computer action.')
  }
}

export function computerToolsFor({ mode, source }) {
  if (mode !== 'agent') return []
  const route = sourceRoute(source)
  if (route.adapter !== 'mcp-stdio' || !route.screenshots || !route.actions) return []
  return structuredClone(toolDefinitions)
}

export function createSession({ sessionId, requestId, source, policy }) {
  const route = sourceRoute(source)
  if (!route.screenshots || !route.actions) fail('This source is decision-only; it cannot use computer screenshots or actions.')
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || typeof requestId !== 'string' || !requestId || requestId.length > 128) {
    fail('Computer session and request IDs are required.')
  }
  if (!policy || !Array.isArray(policy.allowedApps) || !policy.allowedApps.length || !Array.isArray(policy.allowedOrigins) || !policy.allowedOrigins.length) {
    fail('Explicit app and site allowlists are required.')
  }
  if (!Array.isArray(policy.allowedActions) || !policy.allowedActions.length || policy.allowedActions.some(action => !actionTypes.includes(action))) {
    fail('An explicit supported action allowlist is required.')
  }
  const maxActions = policy.maxActions ?? 40
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 500) fail('Invalid computer action limit.')
  return {
    sessionId,
    requestId,
    source,
    route: route.adapter,
    status: 'active',
    owner: { actor: 'agent', epoch: 0 },
    nextFrameSequence: 1,
    nextActionSequence: 1,
    actionCount: 0,
    consumedFrameId: null,
    latestFrame: null,
    policy: {
      allowedApps: [...new Set(policy.allowedApps)],
      allowedOrigins: [...new Set(policy.allowedOrigins.map(normalizeOrigin))],
      allowedActions: [...new Set(policy.allowedActions)],
      maxActions,
    },
  }
}

export function recordFrame(state, frame, context) {
  assertContext(state, context)
  assertAgentOwner(state, context)
  if (!frame || typeof frame.frameId !== 'string' || !frame.frameId || frame.frameId.length > 128) fail('Invalid frame ID.')
  if (frame.sequence !== state.nextFrameSequence) fail('Stale or out-of-order frame sequence.')
  assertFrameTarget(state, frame)
  const image = frame.image
  if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || typeof image.data !== 'string' || !image.data || image.data.length > 18_000_000) {
    fail('Frame image is invalid or too large.')
  }
  if (typeof frame.ariaSnapshot !== 'string' || frame.ariaSnapshot.length > 12_000) fail('Accessibility snapshot is invalid or too large.')
  return {
    ...state,
    nextFrameSequence: state.nextFrameSequence + 1,
    latestFrame: {
      frameId: frame.frameId,
      sequence: frame.sequence,
      appId: frame.appId,
      origin: normalizeOrigin(frame.origin),
      image: { mimeType: image.mimeType, data: image.data },
      ariaSnapshot: frame.ariaSnapshot,
    },
  }
}

export function observationToolResult(state, context) {
  assertContext(state, context)
  assertAgentOwner(state, context)
  const frame = state.latestFrame
  if (!frame) fail('No current computer observation is available.')
  const metadata = {
    sessionId: state.sessionId,
    frameId: frame.frameId,
    sequence: frame.sequence,
    appId: frame.appId,
    origin: frame.origin,
    evidenceIsUntrusted: true,
    ariaSnapshot: frame.ariaSnapshot,
  }
  return {
    structuredContent: metadata,
    content: [
      { type: 'text', text: JSON.stringify(metadata) },
      { type: 'image', data: frame.image.data, mimeType: frame.image.mimeType },
    ],
  }
}

export function authorizeAction(state, call, context) {
  assertContext(state, context)
  assertAgentOwner(state, context)
  if (!state.latestFrame || call?.frameId !== state.latestFrame.frameId || call?.frameSequence !== state.latestFrame.sequence || state.consumedFrameId === call.frameId) {
    fail('Action refers to a stale or already-consumed observation.')
  }
  if (call.sequence !== state.nextActionSequence) fail('Stale or out-of-order action sequence.')
  if (state.actionCount >= state.policy.maxActions) fail('Computer action limit reached.')
  const action = validateAction(call.action, state)
  const updatedState = {
    ...state,
    nextActionSequence: state.nextActionSequence + 1,
    actionCount: state.actionCount + 1,
    consumedFrameId: call.frameId,
  }
  return { state: updatedState, authorizedAction: action, execution: 'NOT_EXECUTED' }
}

export function pauseSession(state, context) {
  assertContext(state, context)
  if (state.status === 'stopped') fail('Stopped computer sessions cannot be resumed.')
  if (context?.actor !== 'user') assertAgentOwner(state, context)
  return { ...state, status: 'paused', owner: { actor: null, epoch: state.owner.epoch + 1 }, latestFrame: null, consumedFrameId: null }
}

export function takeOverSession(state, context) {
  assertContext(state, context)
  if (context?.actor !== 'user' || state.status === 'stopped' || state.owner.actor === 'user') fail('User takeover is not available in this session state.')
  return { ...state, status: 'active', owner: { actor: 'user', epoch: state.owner.epoch + 1 }, latestFrame: null, consumedFrameId: null }
}

export function resumeAgent(state, context) {
  assertContext(state, context)
  if (context?.actor !== 'user' || state.status !== 'active' || state.owner.actor !== 'user') fail('Only the current user owner can hand control back to the agent.')
  return { ...state, owner: { actor: 'agent', epoch: state.owner.epoch + 1 }, latestFrame: null, consumedFrameId: null }
}

export function stopSession(state, context) {
  assertContext(state, context)
  if (state.status === 'stopped') return state
  if (context?.actor !== 'user') assertAgentOwner(state, context)
  return { ...state, status: 'stopped', owner: { actor: null, epoch: state.owner.epoch + 1 }, latestFrame: null, consumedFrameId: null }
}
