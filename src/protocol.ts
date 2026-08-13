/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the three
 * request/result pairs and the four server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport.
 *
 * These are standalone structural mirrors of the in-repo
 * `@deepseek-ai/dsh-sdk-protocol` types (plus the content-block and
 * session-event shapes from `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-session`
 * that cross the wire). `serverInfo.name` stays the wire-stable
 * `deepseek-harness-sdk-runtime`.
 *
 * @module @openma/deepseek-harness-sdk/protocol
 */

/** JSON scalar values. */
export type JsonScalar = string | number | boolean | null
/** Any JSON value. */
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue }

// #region Content blocks

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** A durable raster image reference, valid in user or assistant content. */
export interface ImageBlock {
  type: 'image'
  /** Immutable bytes reference and intrinsic display metadata owned by the runtime's attachment service. */
  attachment: Record<string, unknown>
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: string
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

/** The content blocks this SDK names; the wire vocabulary is plugin-extensible. */
export type KnownContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

/**
 * Any content block. The runtime's vocabulary is merge-extensible, so
 * unrecognized `type` tags must pass through unharmed; switch on `type` and
 * fall through unknowns.
 */
export type ContentBlock = KnownContentBlock | { type: string; [key: string]: unknown }

// #endregion

// #region Session events

/**
 * One session-log event envelope. The runtime's event vocabulary is
 * merge-extensible (`turn/start`, `turn/end`, `step/start`, `step/end`,
 * `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`,
 * `tool/result`, `agent/inbox/spliced`, ...), so `type` stays an open string
 * and `data` an open record; helper types below name the payloads this SDK
 * reads.
 */
export interface SessionEvent {
  /** The event type tag, e.g. `assistant/message`. */
  type: string
  /** Monotonic sequence number within the session. */
  seq: number
  /** Unix epoch milliseconds. */
  time: number
  /** The event payload; shape is owned by `type`. */
  data?: Record<string, unknown>
  /** Marks an event a reader may safely skip when it does not recognize `type`. */
  ignorable?: true
  /** Seq numbers of earlier events that this event cites as sources. */
  sourceEventSeqs?: number[]
  /** How this event entered the model-visible surface; absent for non-surface events. */
  surfaceOp?: unknown
}

/** Why a turn ended; `kind` values include `completed`, `max-tokens`, and `error`. */
export interface TurnEndReason {
  kind: string
  [key: string]: unknown
}

/** Payload of a `turn/end` session event. */
export interface TurnEndEventData {
  turn: number
  reason: TurnEndReason
  [key: string]: unknown
}

/** Payload of an `assistant/message` session event. */
export interface AssistantMessageEventData {
  turn: number
  step: number
  /** The assembled assistant message; `content` carries the output blocks. */
  message: { content: ContentBlock[]; [key: string]: unknown }
  /** Token accounting for the step, when the adapter reported any. */
  usage?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Payload of an `agent/inbox/spliced` session event — the durable enqueue
 * receipt for queued user messages.
 */
export interface InboxSplicedEventData {
  inserted: { id: string; [key: string]: unknown }[]
  [key: string]: unknown
}

// #endregion

// #region Requests

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on. */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}

// #endregion

// #region Notifications

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** Provider-reported stop reason for a subagent run, e.g. `completed`, `max-tokens`, `error`. */
export type SubagentStopReason = string

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals `childSessionId` for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

// #endregion
