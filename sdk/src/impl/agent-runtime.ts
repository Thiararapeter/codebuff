import {
  disableLiveUserInputCheck,
  disableSessionConnectionCheck,
} from '@codebuff/agent-runtime/live-user-inputs'
import { trackEvent } from '@codebuff/common/analytics'
import { success } from '@codebuff/common/util/error'

import {
  addAgentStep,
  fetchAgentFromDatabase,
  finishAgentRun,
  getUserInfoFromApiKey,
  startAgentRun,
} from './database'
import { promptAiSdk, promptAiSdkStream, promptAiSdkStructured } from './llm'

import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { DatabaseAgentCache } from '@codebuff/common/types/contracts/database'
import type {
  SessionRecord,
  UserInputRecord,
} from '@codebuff/common/types/contracts/live-user-input'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const databaseAgentCache: DatabaseAgentCache = new Map()
const liveUserInputRecord: UserInputRecord = {}
const sessionConnections: SessionRecord = {}
disableLiveUserInputCheck()
disableSessionConnectionCheck()

export function getAgentRuntimeImpl(
  params: {
    logger?: Logger
    apiKey: string
  } & Pick<
    AgentRuntimeScopedDeps,
    | 'handleStepsLogChunk'
    | 'requestToolCall'
    | 'requestMcpToolData'
    | 'requestFiles'
    | 'requestOptionalFile'
    | 'sendAction'
    | 'sendSubagentChunk'
  >,
): AgentRuntimeDeps & AgentRuntimeScopedDeps {
  const {
    logger,
    apiKey,
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestOptionalFile,
    sendAction,
    sendSubagentChunk,
  } = params

  return {
    // Database
    getUserInfoFromApiKey,
    fetchAgentFromDatabase,
    startAgentRun,
    finishAgentRun,
    addAgentStep,

    // Billing
    consumeCreditsWithFallback: async () =>
      success({
        chargedToOrganization: false,
      }),

    // LLM
    promptAiSdkStream,
    promptAiSdk,
    promptAiSdkStructured,

    // Mutable State
    databaseAgentCache,
    liveUserInputRecord,
    sessionConnections,

    // Analytics
    trackEvent,

    // Other
    logger: logger ?? {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    fetch: globalThis.fetch,

    // Client (WebSocket)
    handleStepsLogChunk,
    requestToolCall,
    requestMcpToolData,
    requestFiles,
    requestOptionalFile,
    sendAction,
    sendSubagentChunk,

    apiKey,
  }
}
