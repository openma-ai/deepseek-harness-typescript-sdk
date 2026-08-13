# DeepSeek Harness TypeScript SDK

English | [中文](README.zh.md)

[![CI](https://github.com/openma-ai/deepseek-harness-typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/openma-ai/deepseek-harness-typescript-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40openma%2Fdeepseek-harness-sdk.svg)](https://www.npmjs.com/package/@openma/deepseek-harness-sdk)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript / Node.js SDK for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), the open-source AI agent harness by DeepSeek: run coding-agent turns in a runtime subprocess over newline-delimited JSON-RPC stdio. A standalone implementation referencing the upstream `packages/sdk/{protocol,client}` packages and mirroring the official Python SDK's (`python/sdk`) API surface.

The runtime inherits normal DeepSeek Harness environment variables such as `DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`, so callers can use real model endpoints directly or point those variables at a local proxy.

## Install

```sh
npm install @openma/deepseek-harness-sdk
```

## Quick start

```ts
import { DeepSeekHarness } from '@openma/deepseek-harness-sdk'

await using harness = new DeepSeekHarness()
const result = await harness.run('Say hi.')
console.log(result.finalResponse)
```

`DeepSeekHarness` keeps its lazily started runtime subprocess for reuse across calls. Use it with `await using`, as above, or call `close()` explicitly when finished so the child is always reaped.

## Features

- **High-level turns API** — `DeepSeekHarness.run()` sends a prompt and resolves with the final assistant response, finish reason, and the full event/notification stream of the owned activity interval
- **Low-level protocol client** — `HarnessClient` for raw JSON-RPC requests, notification subscriptions, and session-tree scoping
- **Faithful to the official protocol** — a standalone mirror of the upstream wire types and run semantics, API-aligned with the official Python SDK (`deepseek-harness-sdk` on PyPI)
- **Robust process ownership** — lazy spawn, protocol `shutdown`, and an stdin-EOF → SIGTERM → SIGKILL teardown ladder with exit-code + stderr-tail diagnostics
- **Subagent aware** — descendant sessions discovered from `subagent.started` lineage are streamed alongside the root session, while root events stay authoritative
- **Zero runtime dependencies** — Node.js ≥ 20, ESM, strict TypeScript types throughout

## Runtime selection

The SDK spawns a DeepSeek Harness runtime process that serves the SDK protocol (the `@deepseek-ai/dsh-sdk-jsonrpc-server` plugin must be part of its composition). A launch resolves in this order:

1. `launchArgsOverride` — a full argv, verbatim.
2. `runtimeBin` — a single runtime executable (for example a packaged `dsh-jsonrpc-agent-pkg-<platform>-<arch>` exe).
3. The `DSH_RUNTIME_BIN` environment variable.
4. An installed [`@deepseek-ai/dsh-sdk-jsonrpc-demo`](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-jsonrpc-demo) package, launched as `node <bin.js>`. When that package ships a bundled default composition (`runtime/cordis.yml`), its path is injected via `DSH_CORDIS_CONFIG` for zero-config runs — only when you set no non-empty config of your own.

The runtime itself always demands an explicit Cordis composition and exits loudly without one, so with routes 1–3 (and route 4 without a bundled default) pass the config through the `cordis` option or `DSH_CORDIS_CONFIG`. The upstream [`jsonrpc-agent` example](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/jsonrpc-agent) owns a complete standalone composition.

```ts
import { DeepSeekHarness } from '@openma/deepseek-harness-sdk'

await using harness = new DeepSeekHarness({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxTokens: 49_152,
  cwd: '/absolute/path/to/workspace',
  sessionRoot: '/absolute/path/to/sessions',
  cordis: 'examples/jsonrpc-agent/cordis.yml',
  runtimeBin: '/path/to/dsh-jsonrpc-agent',
})
const result = await harness.run('Make the requested code change.', { sessionId: 'example-001' })
console.log(result.finalResponse, result.finishReason)
```

`provider` selects a provider route registered by the chosen Cordis composition; `model` is the model id resolved by that adapter. `maxTokens` is an optional positive per-request output-token cap for the root agent and its in-process descendants; omission leaves the provider default in control.

## Options

| Option | Effect |
|---|---|
| `provider` / `model` / `maxTokens` | The route sent in the `initialize` handshake (defaults `deepseek-official` / `deepseek-v4-flash`) |
| `cwd` | Agent workspace, resolved to an absolute path; sent as the wire `cwd` and injected as `DSH_CWD` |
| `runtimeCwd` | Working directory of the runtime process itself (default: `cwd`) |
| `sessionRoot` | Injected as `DSH_SESSION_ROOT` (JSONL session directory) |
| `cordis` | Injected as `DSH_CORDIS_CONFIG` (Cordis composition path) |
| `env` | Variables merged over the inherited parent environment |
| `baseUrl` / `apiKey` | Injected as `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` |
| `runtimeBin` / `launchArgsOverride` | Explicit runtime launch (disables default resolution and config injection) |
| `requestTimeoutMs` | Per-request timeout; `undefined` waits indefinitely (a turn can legitimately run long) |
| `shutdownTimeoutMs` | Bound on the protocol `shutdown` exchange inside `close()` (default 1000) |
| `disposeEofGraceMs` / `disposeGraceMs` | Grace windows of the stdin-EOF → SIGTERM → SIGKILL teardown ladder |

## Run semantics

`HarnessSession.run()` owns an activity interval from its prompt's durable inbox receipt through the next whole-agent idle and returns `RunResult { sessionId, finalResponse, finishReason, events, notifications, sessionRoot }`.

- `finalResponse` is the last committed root-session assistant text in the interval.
- `finishReason` is the `kind` of the last root-session `turn/end` in the interval — `completed`, `max-tokens`, `error`, ... — and `undefined` when no turn ended. A `turn/end` without a string `data.reason.kind` violates the runtime protocol and throws `SdkProtocolError`.
- `events` contains root-session events only, so descendant messages cannot replace the root response.
- `notifications` (and the `onNotification` observer) receive the root session and all known descendant notifications in wire order, including nested subagent lifecycle and session events.

Both result fields describe the owned interval rather than an output causally assigned to the prompt: steering, injected context, and other queued work may contribute before idle.

```ts
const session = harness.session('session-001')  // stable id; reused across runs
const first = await session.run('Inspect the repository.')
const second = await session.run('Now fix the failing tests.', {
  onNotification: (notification) => console.error(notification.method),
})
```

## Low-level client

`HarnessClient` is the lower-level JSON-RPC client underneath `DeepSeekHarness`: it owns the child process, speaks the wire protocol, and fans notifications out to subscriptions. The low-level `prompt()` returns the queued message id immediately; callers that bypass `run()` own any later activity boundary themselves.

```ts
import { HarnessClient } from '@openma/deepseek-harness-sdk'

const client = new HarnessClient({ command: '/path/to/dsh-jsonrpc-agent', env: { ...process.env, DSH_CORDIS_CONFIG: 'cordis.yml' } })
await client.initialize({ cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-v4-flash' })
const subscription = client.subscribeSessionTree('session-a')
const messageId = await client.prompt('session-a', [{ type: 'text', text: 'Say hi.' }])
for await (const notification of subscription) {
  console.log(notification.method)
  if (notification.method === 'session.status' && notification.params.status === 'idle') break
}
await client.close()
```

Errors all extend `HarnessError`: `TransportClosedError` (runtime gone, with exit code + stderr tail), `RequestTimeoutError`, `SdkProtocolError` (wire shape violations), `JsonRpcResponseError` (protocol error responses, preserving `code`/`data`), and `RuntimeResolutionError` (no runtime found).

## Wire protocol

Requests: `initialize` → `{ serverInfo }`, `session/prompt` → `{ messageId }`, `shutdown` → `{}`. Server notifications: `session.event`, `session.status`, `subagent.started`, `subagent.finished`. See `src/protocol.ts` for the named payload types; `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.

## Development

```sh
npm install
npm run typecheck
npm test        # runs against a scripted fake runtime; no network or model needed
npm run build
```

## License

[MIT](LICENSE)
