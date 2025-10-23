import {
  cancelUserInput,
  startUserInput,
} from '@codebuff/agent-runtime/live-user-inputs'
import { calculateUsageAndBalance } from '@codebuff/billing'
import { trackEvent } from '@codebuff/common/analytics'
import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import db from '@codebuff/common/db/index'
import * as schema from '@codebuff/common/db/schema'
import { getErrorObject } from '@codebuff/common/util/error'
import { eq } from 'drizzle-orm'

import { protec } from './middleware'
import { sendActionWs } from '../client-wrapper'
import { getRequestContext } from './request-context'
import { withLoggerContext } from '../util/logger'

import type { ClientAction, UsageResponse } from '@codebuff/common/actions'
import type { GetUserInfoFromApiKeyFn } from '@codebuff/common/types/contracts/database'
import type { UserInputRecord } from '@codebuff/common/types/contracts/live-user-input'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ClientMessage } from '@codebuff/common/websockets/websocket-schema'
import type { WebSocket } from 'ws'
import { callMainPrompt } from '@codebuff/agent-runtime/main-prompt'

/**
 * Generates a usage response object for the client
 * @param fingerprintId - The fingerprint ID for the user/device
 * @param userId - user ID for authenticated users
 * @param clientSessionId - Optional session ID
 * @returns A UsageResponse object containing usage metrics and referral information
 */
export async function genUsageResponse(params: {
  fingerprintId: string
  userId: string
  clientSessionId?: string
  logger: Logger
}): Promise<UsageResponse> {
  const { fingerprintId, userId, clientSessionId, logger } = params
  const logContext = { fingerprintId, userId, sessionId: clientSessionId }
  const defaultResp = {
    type: 'usage-response' as const,
    usage: 0,
    remainingBalance: 0,
    next_quota_reset: null,
  } satisfies UsageResponse

  return withLoggerContext<UsageResponse>(logContext, async () => {
    const user = await db.query.user.findFirst({
      where: eq(schema.user.id, userId),
      columns: {
        next_quota_reset: true,
      },
    })

    if (!user) {
      return defaultResp
    }

    try {
      // Get the usage data
      const { balance: balanceDetails, usageThisCycle } =
        await calculateUsageAndBalance({
          userId,
          quotaResetDate: new Date(),
          logger,
        })

      return {
        type: 'usage-response' as const,
        usage: usageThisCycle,
        remainingBalance: balanceDetails.totalRemaining,
        balanceBreakdown: balanceDetails.breakdown,
        next_quota_reset: user.next_quota_reset,
      } satisfies UsageResponse
    } catch (error) {
      logger.error(
        { error, usage: defaultResp },
        'Error generating usage response, returning default',
      )
    }

    return defaultResp
  })
}

/**
 * Handles prompt actions from the client
 * @param action - The prompt action from the client
 * @param clientSessionId - The client's session ID
 * @param ws - The WebSocket connection
 */
const onPrompt = async (
  params: {
    action: ClientAction<'prompt'>
    ws: WebSocket
    getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
    liveUserInputRecord: UserInputRecord
    logger: Logger
  } & ParamsExcluding<
    typeof callMainPrompt,
    'userId' | 'promptId' | 'repoId' | 'repoUrl'
  >,
) => {
  const { action, ws, getUserInfoFromApiKey, logger } = params
  const { fingerprintId, authToken, promptId, prompt, costMode } = action

  await withLoggerContext(
    { fingerprintId, clientRequestId: promptId, costMode },
    async () => {
      const userId = authToken
        ? (
            await getUserInfoFromApiKey({
              apiKey: authToken,
              fields: ['id'],
              logger,
            })
          )?.id
        : null
      if (!userId) {
        throw new Error('User not found')
      }

      if (prompt) {
        logger.info({ prompt }, `USER INPUT: ${prompt.slice(0, 100)}`)
        trackEvent({
          event: AnalyticsEvent.USER_INPUT,
          userId,
          properties: {
            prompt,
            promptId,
          },
          logger,
        })
      }

      const requestContext = getRequestContext()
      const repoId = requestContext?.processedRepoId
      const repoUrl = requestContext?.processedRepoUrl

      startUserInput({ ...params, userId, userInputId: promptId })

      try {
        const result = await callMainPrompt({
          ...params,
          userId,
          promptId,
          repoUrl,
          repoId,
        })
        if (result.output.type === 'error') {
          throw new Error(result.output.message)
        }
      } catch (e) {
        logger.error({ error: getErrorObject(e) }, 'Error in mainPrompt')
        let response =
          e && typeof e === 'object' && 'message' in e ? `${e.message}` : `${e}`

        sendActionWs({
          ws,
          action: {
            type: 'prompt-error',
            userInputId: promptId,
            message: response,
          },
        })
      } finally {
        cancelUserInput({ ...params, userId, userInputId: promptId })
        const usageResponse = await genUsageResponse({
          fingerprintId,
          userId,
          logger,
        })
        sendActionWs({ ws, action: usageResponse })
      }
    },
  )
}

/**
 * Handles initialization actions from the client
 * @param fileContext - The file context information
 * @param fingerprintId - The fingerprint ID for the user/device
 * @param authToken - The authentication token
 * @param clientSessionId - The client's session ID
 * @param ws - The WebSocket connection
 */
const onInit = async (params: {
  action: ClientAction<'init'>
  clientSessionId: string
  ws: WebSocket
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  logger: Logger
}) => {
  const { action, clientSessionId, ws, getUserInfoFromApiKey, logger } = params
  const { fileContext, fingerprintId, authToken } = action

  await withLoggerContext({ fingerprintId }, async () => {
    const userId = authToken
      ? (
          await getUserInfoFromApiKey({
            apiKey: authToken,
            fields: ['id'],
            logger,
          })
        )?.id
      : undefined

    if (!userId) {
      sendActionWs({
        ws,
        action: {
          usage: 0,
          remainingBalance: 0,
          next_quota_reset: null,
          type: 'init-response',
        },
      })
      return
    }

    // Send combined init and usage response
    const usageResponse = await genUsageResponse({
      fingerprintId,
      userId,
      clientSessionId,
      logger,
    })
    sendActionWs({
      ws,
      action: {
        ...usageResponse,
        type: 'init-response',
      },
    })
  })
}

const onCancelUserInput = async (params: {
  action: ClientAction<'cancel-user-input'>
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  liveUserInputRecord: UserInputRecord
  logger: Logger
}) => {
  const { action, getUserInfoFromApiKey, logger } = params
  const { authToken, promptId } = action

  const userId = (
    await getUserInfoFromApiKey({
      apiKey: authToken,
      fields: ['id'],
      logger,
    })
  )?.id
  if (!userId) {
    logger.error({ authToken }, 'User id not found for authToken')
    return
  }
  cancelUserInput({ ...params, userId, userInputId: promptId })
}

/**
 * Storage for action callbacks organized by action type
 */
const callbacksByAction = {} as Record<
  ClientAction['type'],
  ((action: ClientAction, clientSessionId: string, ws: WebSocket) => void)[]
>

/**
 * Subscribes a callback function to a specific action type
 * @param type - The action type to subscribe to
 * @param callback - The callback function to execute when the action is received
 * @returns A function to unsubscribe the callback
 */
export const subscribeToAction = <T extends ClientAction['type']>(
  type: T,
  callback: (
    action: ClientAction<T>,
    clientSessionId: string,
    ws: WebSocket,
  ) => void,
) => {
  callbacksByAction[type] = (callbacksByAction[type] ?? []).concat(
    callback as (
      action: ClientAction,
      clientSessionId: string,
      ws: WebSocket,
    ) => void,
  )
  return () => {
    callbacksByAction[type] = (callbacksByAction[type] ?? []).filter(
      (cb) => cb !== callback,
    )
  }
}

/**
 * Handles WebSocket action messages from clients
 * @param ws - The WebSocket connection
 * @param clientSessionId - The client's session ID
 * @param msg - The action message from the client
 */
export const onWebsocketAction = async (params: {
  ws: WebSocket
  clientSessionId: string
  msg: ClientMessage & { type: 'action' }
  logger: Logger
}) => {
  const { ws, clientSessionId, msg, logger } = params

  await withLoggerContext({ clientSessionId }, async () => {
    const callbacks = callbacksByAction[msg.data.type] ?? []
    try {
      await Promise.all(
        callbacks.map((cb) => cb(msg.data, clientSessionId, ws)),
      )
    } catch (e) {
      logger.error(
        {
          message: msg,
          error: e && typeof e === 'object' && 'message' in e ? e.message : e,
        },
        'Got error running subscribeToAction callback',
      )
    }
  })
}

// Register action handlers
subscribeToAction('prompt', protec.run({ baseAction: onPrompt }))
subscribeToAction('init', protec.run({ baseAction: onInit, silent: true }))
subscribeToAction(
  'cancel-user-input',
  protec.run({ baseAction: onCancelUserInput }),
)
