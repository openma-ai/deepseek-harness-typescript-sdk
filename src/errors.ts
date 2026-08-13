/**
 * Error hierarchy for the DeepSeek Harness TypeScript SDK. Every SDK-raised
 * failure extends {@link HarnessError}, mirroring the Python SDK's
 * `HarnessError` base so callers can catch one type for all SDK failures.
 *
 * @module @openma/deepseek-harness-sdk/errors
 */

/** Base error for SDK and runtime failures. */
export class HarnessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HarnessError'
  }
}

/**
 * The runtime subprocess is gone or unusable: it exited, its stdio closed, or
 * it was never launchable. The message carries the exit code and a stderr
 * tail when available.
 */
export class TransportClosedError extends HarnessError {
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/** A request exceeded its configured timeout. */
export class RequestTimeoutError extends HarnessError {
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * The runtime answered outside its documented protocol (for example an
 * `initialize` response without `serverInfo`, or a `turn/end` event without a
 * string `data.reason.kind`).
 */
export class SdkProtocolError extends HarnessError {
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

/** A JSON-RPC error response, preserving the wire `code` and optional `data`. */
export class JsonRpcResponseError extends HarnessError {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/**
 * No runtime executable could be located for a default launch. Provide an
 * explicit `runtimeBin`/`launchArgsOverride`, set `DSH_RUNTIME_BIN`, or
 * install a package that ships the `dsh-jsonrpc-agent` bin.
 */
export class RuntimeResolutionError extends HarnessError {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeResolutionError'
  }
}
