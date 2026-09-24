// Shapes shared by the provider adapters (CLI streams, Codex app-server,
// OpenRouter, Ollama) and the code that drives them. Type-only module.
import type { Activity, ChatMessage, Effort, FileChange, Provider, ProviderResult, RequestedMode } from '@bunji/shared/types'

/** One provider call: the runtime selection and the final prompt. */
export interface ProviderRequest {
  provider: Provider
  model: string
  effort: Effort
  prompt: string
  /** Must already be resolved to 'chat' or 'agent' before a provider runs. */
  mode?: RequestedMode
}

/** Bot-scoped access to the memory MCP server. Trusted server configuration. */
export interface MemoryScope {
  botId: string
  /** The chat request ID recorded as note provenance. */
  sourceId: string
  directory: string
  allowWrites?: boolean
}

/** Lets the memory MCP server publish files: the file-store database and the run's working directory. */
export interface FilesScope {
  path: string
  cwd: string
}

/** A file a provider reported changing during a run. */
export interface RunFile {
  path: string
  change: Exclude<FileChange, 'shared'>
}

/** Callbacks and inputs every provider adapter accepts. */
export interface ProviderHooks {
  signal?: AbortSignal
  onActivity?: (activity: Activity) => void
  onFile?: (file: RunFile) => void
  /** Role messages for chat-mode providers that accept them. */
  messages?: ChatMessage[]
}

/** What an adapter reports before runProvider adds `ok`, `requestId` and the final duration. */
export type ProviderOutcome = Omit<ProviderResult, 'ok' | 'requestId' | 'durationMs'> & { durationMs?: number }
