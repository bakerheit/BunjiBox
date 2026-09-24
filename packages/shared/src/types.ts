// The BunjiBox domain model. These are the shapes that cross package and HTTP
// boundaries: the server returns them, the web app, CLI and native client read
// them. Keep this file type-only so it is free for every bundle.
//
// Validation still happens at runtime (makeBot, chat-store, etc.). A type here
// describes what a validator returns, not a promise about untrusted input.

export type Provider = 'claude' | 'codex' | 'openrouter' | 'ollama'
export type ExecutionMode = 'chat' | 'agent'
export type RequestedMode = 'auto' | ExecutionMode
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface ModelInfo {
  id: string
  label: string
}

export interface RuntimeInfo {
  label: string
  modes: readonly RequestedMode[]
  models: readonly ModelInfo[]
}

export interface RuntimeSelection {
  provider: Provider
  model: string
  effort: Effort
}

// ---------------------------------------------------------------------------
// Bots

export interface Avatar {
  shape: string
  color: string
  image: string | null
}

export type ComputerScope = 'none' | 'folder' | 'machine'
export type ComputerLevel = 'read' | 'ask' | 'auto'
export type ComputerNetwork = 'off' | 'ask'

/** A saved computer-access policy. Only folder scope carries a folder. */
export type ComputerProfile =
  | { scope: 'none' | 'machine'; level: ComputerLevel; network: ComputerNetwork; folder?: undefined }
  | { scope: 'folder'; level: ComputerLevel; network: ComputerNetwork; folder: string }

export type NativeComputerTarget = 'off' | 'fixture' | 'com.apple.Notes'

export interface Bot extends RuntimeSelection {
  id: string
  name: string
  description: string
  mode: RequestedMode
  nativeComputer: NativeComputerTarget
  avatar: Avatar
  computer: ComputerProfile
}

/** Writable bot fields. `computer` is only accepted through confirmation routes. */
export type BotChanges = Partial<Omit<Bot, 'id' | 'avatar' | 'computer'>> & {
  avatar?: Partial<Avatar>
  computer?: Partial<ComputerProfile>
}

export interface BotsSnapshot {
  revision: number
  bots: Bot[]
  /** Legacy import only: old browser IDs mapped to saved IDs. */
  mapping?: Record<string, string>
  /** Bot deletion only: memory cleanup that could not finish. */
  cleanupWarning?: string
}

export interface LegacyBotImport {
  source: string
  bots: unknown[]
}

export interface DeleteBotOptions {
  memoryAction: 'delete' | 'move'
  targetBotId?: string
  expectedMemoryRevision: string
}

// ---------------------------------------------------------------------------
// Runs, activity and usage

export type ActivityKind = 'tool' | 'reasoning' | 'plan' | 'notice'
export type ActivityStatus = 'running' | 'complete' | 'failed' | 'unknown' | 'cancelled' | 'interrupted'

export interface Activity {
  id: string
  /** ISO string from a live provider stream; epoch ms once persisted. */
  at?: string | number
  kind: ActivityKind
  title: string
  status: ActivityStatus
  text?: string
  input?: string
  output?: string
  exitCode?: number | null
}

export type TokenField = 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'reasoningOutputTokens' | 'totalTokens'

/** Provider-reported token counts. `null` means the provider did not report it. */
export type TokenUsage = { [Field in TokenField]?: number | null } & { source?: string }

export interface TextMetrics {
  characters: number
  utf8Bytes: number
  words: number
  estimatedTokens: number
}

export interface UsageBreakdown {
  version: 1
  calls?: number
  estimator: 'utf8-bytes-divided-by-4'
  payloadMode: 'role-messages' | 'combined-prompt' | 'mixed'
  userMessage: TextMetrics
  bunjiContext: TextMetrics & { historyTurns: number }
  providerHarnessUnknown: {
    estimatedTokens: number | null
    status: 'pending' | 'estimated' | 'unavailable'
    reason: string | null
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** What a provider adapter returns for one run. */
export interface ProviderResult {
  text: string
  usage: TokenUsage | null
  failed: boolean
  ok: boolean
  error?: string
  activities: Activity[]
  activityLimited?: boolean
  requestId: string
  durationMs: number
  /** Persistent Codex sessions only. `reused` means an existing thread continued. */
  session?: { threadId?: string; reused?: boolean }
}

/** One line of the /api/run NDJSON stream. */
export type RunStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'activity'; activity: Activity }
  | ({ type: 'result' } & Partial<ProviderResult>)

// ---------------------------------------------------------------------------
// Shared chat history

export type RequestStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted'

export interface ChatRequest {
  id: string
  /** Present on single-request reads (get, cancel, listRunning). */
  botId?: string
  prompt: string
  provider: Provider
  model: string
  effort: Effort
  requestedMode: RequestedMode
  mode: ExecutionMode
  modeReason: string | null
  memoryWrite: boolean
  startedAt: number
  status: RequestStatus
  text: string
  activities: Activity[]
  usage: TokenUsage | null
  usageBreakdown: UsageBreakdown | null
  durationMs: number | null
  error: string | null
  contextTurns: number
  omittedTurns: number
  promptEditedAt: number | null
  responseEditedAt: number | null
}

export interface HistoryPage {
  requests: ChatRequest[]
  hasMore: boolean
  nextBefore: string | null
  revision: number
}

export interface StartResult {
  request: ChatRequest
  created: boolean
}

export interface RewindResult {
  id: string
  botId: string
  prompt: string
  removed: number
}

export interface MessageEdit {
  role: 'user' | 'assistant'
  value: string
  expectedText: string
}

// ---------------------------------------------------------------------------
// Memory

export interface MemoryNote {
  id: string
  title: string
  body: string
  sourceMessageIds: string[]
  revision: string
  links: string[]
  createdAt: string
  updatedAt: string
}

export type MemoryNoteSummary = Omit<MemoryNote, 'body'> & { snippet?: string }

export interface MemoryList {
  notes: MemoryNoteSummary[]
  revision: string
}

// ---------------------------------------------------------------------------
// Agent files

export type FilePreviewKind = 'image' | 'markdown' | 'text' | 'none'
/** `shared`: a file the agent linked in its reply rather than one a tool changed. */
export type FileChange = 'created' | 'updated' | 'deleted' | 'shared'

export interface AgentFile {
  id: string
  name: string
  path: string
  sourceId: string
  updatedAt: number
  size: number
  change: FileChange
  extension: string
  preview: FilePreviewKind
  mime: string
  available?: boolean
}

export interface FilePreview {
  file: AgentFile
  text: string | null
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Service health and provider status

export interface ServiceHealth {
  service: 'bunji'
  continuity: 1
  workspace: string
  cwd: string
}

export interface ProviderStatus {
  connected: boolean
  plan: string
  models?: string[]
}
