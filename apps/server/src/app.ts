// Composition root for the local API: opens the workspace stores, wires the
// services, and returns one request handler. main.ts owns the process
// (service lease, port, signals); tests can build the same app in-process.
import { join } from 'node:path'
import { createProviderRunner, createUsageReader, providerCommand, providerStatus, runProvider } from '@bunji/core/runtime'
import { openBotStore, workspaceDirectory } from '@bunji/core/bot-store'
import { openChatStore } from '@bunji/core/chat-store'
import { openMemoryStore } from '@bunji/core/memory-store'
import { openFileStore } from '@bunji/core/file-store'
import { createChatService } from '@bunji/core/chat-service'
import { recoverFileHistory } from '@bunji/core/file-history'
import { createAvatarGenerations } from '@bunji/core/avatar-generation'
import { createRequestHandler } from './http.ts'
import type { RequestHandler } from './http.ts'
import { createAvatarGenerationRoutes } from './routes/avatar-generations.ts'
import { createBotRoutes } from './routes/bots.ts'
import { createContinuityRoutes } from './routes/continuity.ts'
import { createFileRoutes } from './routes/files.ts'
import { createProviderRoutes } from './routes/providers.ts'
import { createRunRoutes } from './routes/run.ts'
import { createSystemRoutes } from './routes/system.ts'

export interface BunjiServiceOptions {
  /** Enable durable Codex app-server threads (BUNJI_EXPERIMENTAL_CODEX_APP_SERVER=1). */
  experimentalCodexAppServer?: boolean
  allowedHosts?: readonly string[]
}

export interface BunjiService {
  handler: RequestHandler
  /** Mark runs left `running` by a crashed process as interrupted. Call once the port is owned. */
  recoverInterrupted(): number
  close(): Promise<void>
}

/** Open the workspace and build the API. The caller must hold the service lease. */
export async function createBunjiService({ experimentalCodexAppServer = false, allowedHosts = [] }: BunjiServiceOptions = {}): Promise<BunjiService> {
  const readUsage = createUsageReader()
  const botStore = openBotStore()
  const chatStore = openChatStore()
  const memoryDirectory = join(workspaceDirectory(), 'memory')
  const memoryStore = openMemoryStore({ directory: memoryDirectory })
  const fileStore = openFileStore()
  const providerRunner = createProviderRunner({ experimental: experimentalCodexAppServer })
  const chatService = createChatService({ bots: botStore, chats: chatStore, memoryDirectory, memory: memoryStore, files: fileStore,
    sessions: providerRunner.sessions, run: providerRunner.run })
  const avatarGenerations = createAvatarGenerations()
  await Promise.all(botStore.list()!.bots.map(bot => recoverFileHistory({ bot, chats: chatStore, files: fileStore })))

  // Order matters: specific /api/bots/:id/* routes run before the catch-all bot routes.
  const handler = createRequestHandler([
    createAvatarGenerationRoutes(avatarGenerations),
    createFileRoutes({ service: chatService, files: fileStore }),
    createContinuityRoutes({ service: chatService, chats: chatStore, memory: memoryStore }),
    createBotRoutes(botStore, chatService),
    createProviderRoutes(),
    createSystemRoutes({ workspace: workspaceDirectory(), readUsage, providerStatus }),
    // Stateless runs never receive memory, files or computer access.
    createRunRoutes({ validate: body => { providerCommand(body as Parameters<typeof providerCommand>[0]) }, run: (body, hooks) => runProvider(body as Parameters<typeof runProvider>[0], hooks) }),
  ], { allowedHosts })

  let closed = false
  return {
    handler,
    recoverInterrupted: () => chatStore.recoverInterrupted(),
    async close() {
      if (closed) return
      closed = true
      await chatService.close()
      await avatarGenerations.close()
      await providerRunner.close()
      fileStore.close(); chatStore.close(); botStore.close()
    },
  }
}
