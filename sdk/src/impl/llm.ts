import path from 'path'

import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible'
import { streamText, APICallError, generateText, generateObject } from 'ai'

import { PROFIT_MARGIN } from '../../../common/src/old-constants'
import { buildArray } from '../../../common/src/util/array'
import { getErrorObject } from '../../../common/src/util/error'
import { convertCbToModelMessages } from '../../../common/src/util/messages'
import { StopSequenceHandler } from '../../../common/src/util/stop-sequence'
import {
  checkLiveUserInput,
  getLiveUserInputIds,
} from '../../../packages/agent-runtime/src/live-user-inputs'
import { WEBSITE_URL } from '../constants'

import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredInput,
  PromptAiSdkStructuredOutput,
} from '../../../common/src/types/contracts/llm'
import type { ParamsOf } from '../../../common/src/types/function-params'
import type { LanguageModelV2 } from '@ai-sdk/provider'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { OpenRouterProviderOptions } from '@openrouter/ai-sdk-provider'
import type z from 'zod/v4'

// Forked from https://github.com/OpenRouterTeam/ai-sdk-provider/
type OpenRouterUsageAccounting = {
  cost: number | null
  costDetails: {
    upstreamInferenceCost: number | null
  }
}

function calculateUsedCredits(params: { costDollars: number }): number {
  const { costDollars } = params

  return Math.round(costDollars * (1 + PROFIT_MARGIN) * 100)
}

function getAiSdkModel(params: {
  apiKey: string
  model: string
  logger: Logger
}): LanguageModelV2 {
  const { apiKey, model, logger } = params

  const openrouterUsage: OpenRouterUsageAccounting = {
    cost: null,
    costDetails: {
      upstreamInferenceCost: null,
    },
  }

  const codebuffBackendModel = new OpenAICompatibleChatLanguageModel(model, {
    provider: 'codebuff.chat',
    url: ({ path: endpoint }) =>
      new URL(path.join('/api/v1', endpoint), WEBSITE_URL).toString(),
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'user-agent': `ai-sdk/codebuff/${process.env.NEXT_PUBLIC_NPM_APP_VERSION || 'unknown-version'}`,
    }),
    metadataExtractor: {
      extractMetadata: async (...inputs) => {
        console.log(inputs, 'extractMetadata')
        return undefined
      },
      createStreamExtractor: () => ({
        processChunk: (parsedChunk: any) => {
          if (typeof parsedChunk?.usage?.cost === 'number') {
            openrouterUsage.cost = parsedChunk.usage.cost
          }
          if (
            typeof parsedChunk?.usage?.cost_details?.upstream_inference_cost ===
            'number'
          ) {
            openrouterUsage.costDetails.upstreamInferenceCost =
              parsedChunk.usage.cost_details.upstream_inference_cost
          }
        },
        buildMetadata: () => {
          return { codebuff: { usage: openrouterUsage } }
        },
      }),
    },
    fetch: undefined,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
  return codebuffBackendModel
}

export async function* promptAiSdkStream(
  params: ParamsOf<PromptAiSdkStreamFn>,
): ReturnType<PromptAiSdkStreamFn> {
  const { logger } = params
  const agentChunkMetadata =
    params.agentId != null ? { agentId: params.agentId } : undefined

  if (
    !checkLiveUserInput({ ...params, clientSessionId: params.clientSessionId })
  ) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
        liveUserInputId: getLiveUserInputIds(params),
      },
      'Skipping stream due to canceled user input',
    )
    return null
  }

  let aiSDKModel = getAiSdkModel(params)

  const response = streamText({
    ...params,
    prompt: undefined,
    model: aiSDKModel,
    messages: convertCbToModelMessages(params),
    providerOptions: {
      codebuff: {
        codebuff_metadata: {
          run_id: params.runId,
          client_id: params.clientSessionId,
        },
      },
    },
  })

  let content = ''
  const stopSequenceHandler = new StopSequenceHandler(params.stopSequences)

  for await (const chunk of response.fullStream) {
    if (chunk.type !== 'text-delta') {
      const flushed = stopSequenceHandler.flush()
      if (flushed) {
        content += flushed
        yield {
          type: 'text',
          text: flushed,
          ...(agentChunkMetadata ?? {}),
        }
      }
    }
    if (chunk.type === 'error') {
      logger.error(
        {
          chunk: { ...chunk, error: undefined },
          error: getErrorObject(chunk.error),
          model: params.model,
        },
        'Error from AI SDK',
      )

      const errorBody = APICallError.isInstance(chunk.error)
        ? chunk.error.responseBody
        : undefined
      const mainErrorMessage =
        chunk.error instanceof Error
          ? chunk.error.message
          : typeof chunk.error === 'string'
            ? chunk.error
            : JSON.stringify(chunk.error)
      const errorMessage = `Error from AI SDK (model ${params.model}): ${buildArray([mainErrorMessage, errorBody]).join('\n')}`
      yield {
        type: 'error',
        message: errorMessage,
      }

      return null
    }
    if (chunk.type === 'reasoning-delta') {
      for (const provider of ['openrouter', 'codebuff'] as const) {
        if (
          (
            params.providerOptions?.[provider] as
              | OpenRouterProviderOptions
              | undefined
          )?.reasoning?.exclude
        ) {
          continue
        }
      }
      yield {
        type: 'reasoning',
        text: chunk.text,
      }
    }
    if (chunk.type === 'text-delta') {
      if (!params.stopSequences) {
        content += chunk.text
        if (chunk.text) {
          yield {
            type: 'text',
            text: chunk.text,
            ...(agentChunkMetadata ?? {}),
          }
        }
        continue
      }

      const stopSequenceResult = stopSequenceHandler.process(chunk.text)
      if (stopSequenceResult.text) {
        content += stopSequenceResult.text
        yield {
          type: 'text',
          text: stopSequenceResult.text,
          ...(agentChunkMetadata ?? {}),
        }
      }
    }
  }
  const flushed = stopSequenceHandler.flush()
  if (flushed) {
    content += flushed
    yield {
      type: 'text',
      text: flushed,
      ...(agentChunkMetadata ?? {}),
    }
  }

  const providerMetadata = (await response.providerMetadata) ?? {}

  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  const messageId = (await response.response).id

  // Call the cost callback if provided
  if (params.onCostCalculated && costOverrideDollars) {
    await params.onCostCalculated(
      calculateUsedCredits({ costDollars: costOverrideDollars }),
    )
  }

  return messageId
}

export async function promptAiSdk(
  params: ParamsOf<PromptAiSdkFn>,
): ReturnType<PromptAiSdkFn> {
  const { logger } = params

  if (!checkLiveUserInput(params)) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
        liveUserInputId: getLiveUserInputIds(params),
      },
      'Skipping prompt due to canceled user input',
    )
    return ''
  }

  let aiSDKModel = getAiSdkModel(params)

  const response = await generateText({
    ...params,
    prompt: undefined,
    model: aiSDKModel,
    messages: convertCbToModelMessages(params),
    providerOptions: {
      codebuff: {
        codebuff_metadata: {
          run_id: params.runId,
          client_id: params.clientSessionId,
        },
      },
    },
  })
  const content = response.text

  const providerMetadata = response.providerMetadata ?? {}
  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  // Call the cost callback if provided
  if (params.onCostCalculated && costOverrideDollars) {
    await params.onCostCalculated(
      calculateUsedCredits({ costDollars: costOverrideDollars }),
    )
  }

  return content
}

export async function promptAiSdkStructured<T>(
  params: PromptAiSdkStructuredInput<T>,
): PromptAiSdkStructuredOutput<T> {
  const { logger } = params

  if (!checkLiveUserInput(params)) {
    logger.info(
      {
        userId: params.userId,
        userInputId: params.userInputId,
        liveUserInputId: getLiveUserInputIds(params),
      },
      'Skipping structured prompt due to canceled user input',
    )
    return {} as T
  }
  let aiSDKModel = getAiSdkModel(params)

  const response = await generateObject<z.ZodType<T>, 'object'>({
    ...params,
    prompt: undefined,
    model: aiSDKModel,
    output: 'object',
    messages: convertCbToModelMessages(params),
    providerOptions: {
      codebuff: {
        codebuff_metadata: {
          run_id: params.runId,
          client_id: params.clientSessionId,
        },
      },
    },
  })

  const content = response.object

  const providerMetadata = response.providerMetadata ?? {}
  let costOverrideDollars: number | undefined
  if (providerMetadata.codebuff) {
    if (providerMetadata.codebuff.usage) {
      const openrouterUsage = providerMetadata.codebuff
        .usage as OpenRouterUsageAccounting

      costOverrideDollars =
        (openrouterUsage.cost ?? 0) +
        (openrouterUsage.costDetails?.upstreamInferenceCost ?? 0)
    }
  }

  // Call the cost callback if provided
  if (params.onCostCalculated && costOverrideDollars) {
    await params.onCostCalculated(
      calculateUsedCredits({ costDollars: costOverrideDollars }),
    )
  }

  return content
}
