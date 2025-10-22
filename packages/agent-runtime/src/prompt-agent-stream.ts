import { globalStopSequence } from './constants'

import type { AgentTemplate } from './templates/types'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type { SendActionFn } from '@codebuff/common/types/contracts/client'
import type {
  SessionRecord,
  UserInputRecord,
} from '@codebuff/common/types/contracts/live-user-input'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsOf } from '@codebuff/common/types/function-params'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { OpenRouterProviderOptions } from '@codebuff/internal/openrouter-ai-sdk'

export const getAgentStreamFromTemplate = (params: {
  apiKey: string
  clientSessionId: string
  fingerprintId: string
  userInputId: string
  userId: string | undefined
  onCostCalculated?: (credits: number) => Promise<void>
  agentId?: string
  includeCacheControl?: boolean

  template: AgentTemplate
  logger: Logger
  sendAction: SendActionFn
  promptAiSdkStream: PromptAiSdkStreamFn
  liveUserInputRecord: UserInputRecord
  sessionConnections: SessionRecord
  trackEvent: TrackEventFn
}) => {
  const {
    apiKey,
    clientSessionId,
    fingerprintId,
    userInputId,
    userId,
    onCostCalculated,
    agentId,
    includeCacheControl,
    template,
    logger,
    sendAction,
    promptAiSdkStream,
    liveUserInputRecord,
    sessionConnections,
    trackEvent,
  } = params

  if (!template) {
    throw new Error('Agent template is null/undefined')
  }

  const { model } = template

  const getStream = (messages: Message[]) => {
    const aiSdkStreamParams: ParamsOf<PromptAiSdkStreamFn> = {
      apiKey,
      messages,
      model,
      stopSequences: [globalStopSequence],
      clientSessionId,
      fingerprintId,
      userInputId,
      userId,
      maxOutputTokens: 32_000,
      onCostCalculated,
      includeCacheControl,
      agentId,
      maxRetries: 3,
      sendAction,
      liveUserInputRecord,
      sessionConnections,
      logger,
      trackEvent,
    }

    // Add Gemini-specific options if needed
    const primaryModel = Array.isArray(model) ? model[0] : model

    if (!aiSdkStreamParams.providerOptions) {
      aiSdkStreamParams.providerOptions = {}
    }
    for (const provider of ['openrouter', 'codebuff'] as const) {
      if (!aiSdkStreamParams.providerOptions[provider]) {
        aiSdkStreamParams.providerOptions[provider] = {}
      }
      ;(
        aiSdkStreamParams.providerOptions[provider] as OpenRouterProviderOptions
      ).reasoning = template.reasoningOptions
    }

    return promptAiSdkStream(aiSdkStreamParams)
  }

  return { getStream }
}
