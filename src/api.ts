/**
 * High-level run API over {@link HarnessClient}: {@link DeepSeekHarness} owns
 * one runtime subprocess across many sessions; {@link HarnessSession.run}
 * sends a prompt and settles when the whole agent next becomes idle. Mirrors
 * the Python SDK's `DeepSeekHarness`/`Session` pair (including
 * `RunResult.finishReason` and environment injection) and the in-repo
 * TypeScript client's lifecycle semantics.
 *
 * @module @openma/deepseek-harness-sdk/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { HarnessClient, isRecord } from './client.js'
import { SdkProtocolError } from './errors.js'
import type { ContentBlock, SessionEvent } from './protocol.js'
import type { DeepSeekHarnessOptions, HarnessClientOptions, HarnessNotification, RunResult } from './types.js'

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 *
 * The runtime inherits this process's environment plus the explicit
 * injections derived from the options (`DSH_CWD`, and `DSH_SESSION_ROOT` /
 * `DSH_CORDIS_CONFIG` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` when set),
 * so real model endpoints and local proxies both work through the normal
 * DeepSeek Harness environment variables.
 */
export class DeepSeekHarness implements AsyncDisposable {
  /** The applied options (defaults filled, paths resolved). */
  readonly config: Readonly<DeepSeekHarnessOptions>
  private clientInstance: HarnessClient
  private readonly launch: HarnessClientOptions
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - runtime launch spec plus the session route (cwd/provider/model). */
  constructor(options: DeepSeekHarnessOptions = {}) {
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? process.cwd())
    const runtimeCwd = options.runtimeCwd === undefined ? this.cwd : resolve(options.runtimeCwd)
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxTokens = options.maxTokens
    this.config = Object.freeze({ ...options, cwd: this.cwd, runtimeCwd, provider: this.provider, model: this.model })

    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env }
    if (options.sessionRoot !== undefined) env.DSH_SESSION_ROOT = options.sessionRoot
    if (options.cordis !== undefined) env.DSH_CORDIS_CONFIG = options.cordis
    env.DSH_CWD = this.cwd
    if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = options.baseUrl
    if (options.apiKey !== undefined) env.DEEPSEEK_API_KEY = options.apiKey

    this.launch = {
      ...launchSpec(options),
      cwd: runtimeCwd,
      env,
      ...options.runtimeResolveBase === undefined ? {} : { runtimeResolveBase: options.runtimeResolveBase },
      ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
      ...options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
      ...options.disposeEofGraceMs === undefined ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
      ...options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs },
    }
    this.clientInstance = new HarnessClient(this.launch)
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake reaps its runtime and swaps in a fresh instance, so do not
   * cache this across a failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure the runtime is reaped and a fresh client replaces it
   * (`HarnessClient.close` is permanent), so a later call retries with a new
   * subprocess — unless {@link close} already ended this harness.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        })
      } catch (error) {
        this.initialized = undefined
        await this.clientInstance.close()
        if (!this.closed) this.clientInstance = new HarnessClient(this.launch)
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | ContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 *
 * {@link run} owns an activity interval from its prompt's durable inbox
 * receipt through the next whole-agent idle. Steering, injected context, and
 * other queued work may contribute before idle, so the result describes the
 * owned interval rather than an output causally assigned to the prompt.
 */
export class HarnessSession {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * `RunResult.notifications` (and `onNotification`) receive the root session
   * and all known descendant notifications in wire order; `RunResult.events`
   * contains root-session events only, so descendant messages cannot replace
   * the root response.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | ContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    const sessionRoot = this.harness.config.sessionRoot
    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      finishReason: finishReason(events),
      events,
      notifications,
      ...sessionRoot === undefined ? {} : { sessionRoot },
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | ContentBlock[]): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  return value as unknown as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's root-session events in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const data: Record<string, unknown> = isRecord(event.data) ? event.data : {}
    // The runtime nests the assembled message under `data.message`; tolerate
    // flat `data.content` for older/alternate producers (Python SDK parity).
    const contentOwner = isRecord(data.message) ? data.message : data
    const content = contentOwner.content
    if (!Array.isArray(content)) continue
    return content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
      .map(block => typeof block.text === 'string' ? block.text : '')
      .join('')
  }
  return ''
}

/**
 * Return the last turn-ending kind of one owned run interval.
 * @param events - the activity interval's root-session events in wire order.
 * @returns the last `turn/end` event's `data.reason.kind` (`completed`,
 * `max-tokens`, `error`, ...), or `undefined` when no turn ended.
 * @throws {@link SdkProtocolError} when the last `turn/end` has no string
 * reason kind — that violates the runtime protocol.
 */
export function finishReason(events: SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const data = isRecord(event.data) ? event.data : undefined
    const reason = data !== undefined && isRecord(data.reason) ? data.reason : undefined
    const kind = reason?.kind
    if (typeof kind !== 'string') {
      throw new SdkProtocolError('turn/end event requires a string data.reason.kind')
    }
    return kind
  }
  return undefined
}

/** Build the explicit launch spec out of the high-level options, when one was given. */
function launchSpec(options: DeepSeekHarnessOptions): Pick<HarnessClientOptions, 'command' | 'args'> {
  if (options.launchArgsOverride !== undefined) {
    const [command, ...args] = options.launchArgsOverride
    if (command === undefined) throw new TypeError('launchArgsOverride must not be empty')
    return { command, args }
  }
  if (options.runtimeBin !== undefined) return { command: options.runtimeBin, args: [] }
  return {}
}
