# DeepSeek Harness TypeScript SDK

[English](README.md) | 中文

[![CI](https://github.com/openma-ai/deepseek-harness-typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/openma-ai/deepseek-harness-typescript-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40openma%2Fdeepseek-harness-sdk.svg)](https://www.npmjs.com/package/@openma/deepseek-harness-sdk)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek 开源的 AI agent harness）的 TypeScript / Node.js SDK：以子进程方式驱动运行时，通过 stdio 上的换行分隔 JSON-RPC 运行 agent turn。这是一个独立实现，参考了上游仓库的 `packages/sdk/{protocol,client}`，并对齐官方 Python SDK（`python/sdk`）的 API 设计。

运行时会继承 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY` 等标准 DeepSeek Harness 环境变量，因此既可以直连真实模型端点，也可以把这些变量指向本地代理。

## 安装

```sh
npm install @openma/deepseek-harness-sdk
```

## 快速开始

```ts
import { DeepSeekHarness } from '@openma/deepseek-harness-sdk'

await using harness = new DeepSeekHarness()
const result = await harness.run('Say hi.')
console.log(result.finalResponse)
```

`DeepSeekHarness` 惰性启动运行时子进程并在多次调用间复用。像上面那样使用 `await using`，或在结束时显式调用 `close()`，确保子进程始终被回收。

## 特性

- **高层 turns API** —— `DeepSeekHarness.run()` 发送 prompt，返回最终 assistant 响应、结束原因和整段活动区间的事件/通知流
- **低层协议客户端** —— `HarnessClient` 提供原始 JSON-RPC 请求、通知订阅和 session 树过滤
- **忠实还原官方协议** —— 独立镜像上游 wire 类型与 run 语义，与官方 Python SDK（PyPI 的 `deepseek-harness-sdk`）API 对齐
- **健壮的进程所有权** —— 惰性启动、协议 `shutdown`、stdin-EOF → SIGTERM → SIGKILL 收尾阶梯，附退出码 + stderr 尾部诊断
- **Subagent 感知** —— 通过 `subagent.started` 谱系发现后代会话并随根会话一起流式输出，根事件保持权威
- **零运行时依赖** —— Node.js ≥ 20、ESM、全程严格 TypeScript 类型

## 运行时选择

SDK 会启动一个服务于 SDK 协议的 DeepSeek Harness 运行时进程（其插件组合中必须包含 `@deepseek-ai/dsh-sdk-jsonrpc-server`）。启动方式按以下顺序解析：

1. `launchArgsOverride` —— 完整 argv，原样使用。
2. `runtimeBin` —— 单个运行时可执行文件（例如打包好的 `dsh-jsonrpc-agent-pkg-<platform>-<arch>`）。
3. 环境变量 `DSH_RUNTIME_BIN`。
4. 已安装的 [`@deepseek-ai/dsh-sdk-jsonrpc-demo`](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-jsonrpc-demo) npm 包，以 `node <bin.js>` 方式启动。若该包附带默认组合（`runtime/cordis.yml`），且你没有设置任何非空配置，则其路径会通过 `DSH_CORDIS_CONFIG` 注入，实现零配置运行。

运行时本身始终要求显式的 Cordis 组合，没有配置会直接报错退出。因此使用路径 1–3（以及无内置默认配置的路径 4）时，请通过 `cordis` 选项或 `DSH_CORDIS_CONFIG` 传入配置。上游 [`jsonrpc-agent` 示例](https://github.com/deepseek-ai/deepseek-harness/tree/master/examples/jsonrpc-agent) 提供了完整的独立组合。

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

`provider` 选择所选 Cordis 组合注册的 provider 路由；`model` 是该适配器解析的模型 id。`maxTokens` 是可选的正整数单请求输出 token 上限，作用于根 agent 及其进程内后代；省略则由 provider 默认值控制。

## 选项

| 选项 | 作用 |
|---|---|
| `provider` / `model` / `maxTokens` | `initialize` 握手中发送的路由（默认 `deepseek-official` / `deepseek-v4-flash`） |
| `cwd` | Agent 工作区，解析为绝对路径；作为 wire `cwd` 发送并注入 `DSH_CWD` |
| `runtimeCwd` | 运行时进程自身的工作目录（默认与 `cwd` 相同） |
| `sessionRoot` | 注入 `DSH_SESSION_ROOT`（JSONL 会话目录） |
| `cordis` | 注入 `DSH_CORDIS_CONFIG`（Cordis 组合路径） |
| `env` | 合并到继承的父进程环境之上的变量 |
| `baseUrl` / `apiKey` | 注入 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` |
| `runtimeBin` / `launchArgsOverride` | 显式运行时启动（禁用默认解析与配置注入） |
| `requestTimeoutMs` | 单请求超时；`undefined` 表示无限等待（一个 turn 可能合理地长时间运行） |
| `shutdownTimeoutMs` | `close()` 内协议 `shutdown` 交换的时限（默认 1000） |
| `disposeEofGraceMs` / `disposeGraceMs` | stdin-EOF → SIGTERM → SIGKILL 收尾阶梯的宽限窗口 |

## 运行语义

`HarnessSession.run()` 拥有一段活动区间：从该 prompt 的持久化收件回执开始，到 agent 下一次整体空闲为止，返回 `RunResult { sessionId, finalResponse, finishReason, events, notifications, sessionRoot }`。

- `finalResponse` 是区间内根会话最后一条已提交的 assistant 文本。
- `finishReason` 是区间内根会话最后一条 `turn/end` 的 `kind`——`completed`、`max-tokens`、`error` 等；没有 turn 结束时为 `undefined`。`turn/end` 缺少字符串 `data.reason.kind` 属于协议违规，会抛出 `SdkProtocolError`。
- `events` 只包含根会话事件，后代消息不会顶替根会话的响应。
- `notifications`（以及 `onNotification` 观察者）按 wire 顺序接收根会话及所有已发现后代的通知，包括嵌套 subagent 生命周期与会话事件。

两个结果字段描述的是这段被拥有的区间，而非因果上归属于该 prompt 的输出：steering、注入的上下文和其他排队任务都可能在空闲前贡献内容。

```ts
const session = harness.session('session-001')  // 稳定 id，跨多次 run 复用
const first = await session.run('Inspect the repository.')
const second = await session.run('Now fix the failing tests.', {
  onNotification: (notification) => console.error(notification.method),
})
```

## 低层客户端

`HarnessClient` 是 `DeepSeekHarness` 之下的低层 JSON-RPC 客户端：拥有子进程、说 wire 协议、把通知扇出到各订阅。低层 `prompt()` 立即返回排队消息 id；绕过 `run()` 的调用方需要自己承担后续活动边界。

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

所有错误均继承自 `HarnessError`：`TransportClosedError`（运行时消失，附退出码与 stderr 尾部）、`RequestTimeoutError`、`SdkProtocolError`（wire 形状违规）、`JsonRpcResponseError`（协议错误响应，保留 `code`/`data`）、`RuntimeResolutionError`（找不到运行时）。

## Wire 协议

请求：`initialize` → `{ serverInfo }`、`session/prompt` → `{ messageId }`、`shutdown` → `{}`。服务端通知：`session.event`、`session.status`、`subagent.started`、`subagent.finished`。具名负载类型见 `src/protocol.ts`；`serverInfo.name` 保持 wire 稳定值 `deepseek-harness-sdk-runtime`。

## 开发

```sh
npm install
npm run typecheck
npm test        # 针对脚本化 fake runtime 运行；无需网络或模型
npm run build
```

## 发版

推送 `v*` tag 会触发 [release workflow](.github/workflows/release.yml)：校验 tag 与 `package.json` 版本一致、跑测试套件，然后带 provenance 发布到 npm：

```sh
npm version patch   # 或 minor / major —— 自动 commit 并打 vX.Y.Z tag
git push --follow-tags
```

## 许可证

[MIT](LICENSE)
