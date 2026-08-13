/**
 * Types for the SDK client and high-level API: launch options, notification
 * shapes, and owned activity results.
 *
 * @module @openma/deepseek-harness-sdk/types
 */

import type { ContentBlock, SessionEvent } from './protocol.js'

/** One server-to-client notification as received off the wire. */
export interface HarnessNotification {
  /** The JSON-RPC notification method name. */
  method: string
  /** The raw params object; see `HarnessSdkNotificationMap` for the shapes per method. */
  params: Record<string, unknown>
}

/** Predicate deciding whether a subscription receives a notification. */
export type NotificationFilter = (notification: HarnessNotification) => boolean

/** Launch and timeout options for `HarnessClient`. */
export interface HarnessClientOptions {
  /**
   * The runtime executable (the `dsh-jsonrpc-agent` bin, a packaged exe, or
   * `node`). Omitted resolves a default launch: `DSH_RUNTIME_BIN`, then an
   * installed `@deepseek-ai/dsh-sdk-jsonrpc-demo` package — with its bundled
   * default Cordis config injected via `DSH_CORDIS_CONFIG` when the caller
   * set no non-empty config of their own.
   */
  command?: string
  /** Arguments passed to {@link command}. */
  args?: string[]
  /** Working directory for the runtime process itself. */
  cwd?: string
  /**
   * The complete child environment. `undefined` inherits the parent env
   * verbatim; passing an object replaces it entirely, so callers own
   * credential policy.
   */
  env?: NodeJS.ProcessEnv
  /** Extra directory to resolve the default runtime npm package from (test/embedding seam). */
  runtimeResolveBase?: string
  /** Per-request timeout (ms); `undefined` waits indefinitely (a turn can legitimately run long). */
  requestTimeoutMs?: number
  /** Bound (ms) on the protocol `shutdown` exchange inside `close()` (default 1000). */
  shutdownTimeoutMs?: number
  /** Grace (ms) for the runtime's stdin-EOF quiesce during `close()` (default 6000). */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms) after SIGTERM/SIGKILL during `close()` (default 3000). */
  disposeGraceMs?: number
}

/**
 * Options for the high-level `DeepSeekHarness` wrapper — the TypeScript
 * mirror of the Python SDK's `DeepSeekHarnessConfig`. The runtime subprocess
 * inherits this process's environment by default, so existing
 * `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` settings keep working; use
 * {@link env} to intentionally override or inject variables.
 */
export interface DeepSeekHarnessOptions {
  /** Provider route for SDK-created agents (default `deepseek-official`). */
  provider?: string
  /** Model for SDK-created agents (default `deepseek-v4-flash`). */
  model?: string
  /** Optional positive output-token cap for the root agent and its in-process descendants. */
  maxTokens?: number
  /** Agent workspace directory, resolved to an absolute path (default `process.cwd()`); sent as the wire `cwd` and `DSH_CWD`. */
  cwd?: string
  /** Working directory for the runtime process itself (default: {@link cwd}). */
  runtimeCwd?: string
  /** JSONL session directory, injected as `DSH_SESSION_ROOT`. */
  sessionRoot?: string
  /** Cordis composition path, injected as `DSH_CORDIS_CONFIG`. */
  cordis?: string
  /** Variables merged over the inherited parent environment. */
  env?: Record<string, string>
  /** Explicit runtime executable; disables default runtime resolution and config injection. */
  runtimeBin?: string
  /** Explicit full launch argv; wins over {@link runtimeBin}. */
  launchArgsOverride?: string[]
  /** Extra directory to resolve the default runtime npm package from (test/embedding seam). */
  runtimeResolveBase?: string
  /** Per-request timeout (ms); `undefined` waits indefinitely. */
  requestTimeoutMs?: number
  /** Bound (ms) on the protocol `shutdown` exchange inside `close()` (default 1000). */
  shutdownTimeoutMs?: number
  /** Grace (ms) for the runtime's stdin-EOF quiesce during `close()` (default 6000). */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms) after SIGTERM/SIGKILL during `close()` (default 3000). */
  disposeGraceMs?: number
  /** Injected as `DEEPSEEK_BASE_URL` for the runtime's model adapter. */
  baseUrl?: string
  /** Injected as `DEEPSEEK_API_KEY` for the runtime's model adapter. */
  apiKey?: string
}

/**
 * One owned session activity interval, from the prompt's durable inbox
 * receipt through the next whole-agent idle. Both `finalResponse` and
 * `finishReason` describe the owned interval rather than an output causally
 * assigned to the prompt: steering, injected context, and other queued work
 * may contribute before idle.
 */
export interface RunResult {
  /** The session the activity ran on. */
  sessionId: string
  /** Concatenated text of the interval's last root-session assistant message (empty when none). */
  finalResponse: string
  /**
   * The `kind` of the interval's last root-session `turn/end` — `completed`,
   * `max-tokens`, `error`, ... — or `undefined` when no turn ended.
   */
  finishReason: string | undefined
  /** Every `session.event` payload for the root session, in wire order. */
  events: SessionEvent[]
  /** Every notification for the root session and discovered descendants, in wire order. */
  notifications: HarnessNotification[]
  /** The `sessionRoot` this harness was configured with, when any. */
  sessionRoot?: string
}

/** Re-exported content-block alias so SDK callers need no extra import. */
export type { ContentBlock }
