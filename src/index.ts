/**
 * TypeScript SDK for the DeepSeek Harness runtime: spawn a
 * `dsh-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * newline-delimited JSON-RPC stdio. {@link DeepSeekHarness} is the high-level
 * run API; {@link HarnessClient} is the lower-level protocol client. A pure
 * library — the runtime process it spawns is a complete harness configured by
 * its own `cordis.yml`.
 *
 * Standalone implementation referencing `deepseek-ai/deepseek-harness`
 * (`packages/sdk/{protocol,client}` and `python/sdk`).
 *
 * @module @openma/deepseek-harness-sdk
 */

export { DeepSeekHarness, HarnessSession, finalResponse, finishReason, normalizeInput } from './api.js'
export type { RunOptions } from './api.js'
export { HarnessClient, isRecord } from './client.js'
export type { NotificationSubscription } from './client.js'
export {
  HarnessError,
  JsonRpcResponseError,
  RequestTimeoutError,
  RuntimeResolutionError,
  SdkProtocolError,
  TransportClosedError,
} from './errors.js'
export { JsonRpcLineTransport } from './transport.js'
export type { JsonRpcTransportPeer } from './transport.js'
export { RUNTIME_BIN_ENV_VAR, RUNTIME_BIN_NAME, RUNTIME_PACKAGE, resolveDefaultLaunch } from './runtime.js'
export type { ResolvedLaunch } from './runtime.js'
export type {
  AssistantMessageEventData,
  ContentBlock,
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  ImageBlock,
  InboxSplicedEventData,
  InitializeParams,
  InitializeResult,
  JsonObject,
  JsonScalar,
  JsonValue,
  KnownContentBlock,
  ReasoningBlock,
  SdkRunStatus,
  SessionEvent,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
  SubagentStopReason,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  TurnEndEventData,
  TurnEndReason,
} from './protocol.js'
export type {
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.js'
