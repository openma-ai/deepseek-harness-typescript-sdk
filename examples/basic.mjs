#!/usr/bin/env node
/**
 * Minimal example: run one agent turn and print the final response.
 *
 * Prerequisites — a runtime and a composition, e.g.:
 *   export DSH_RUNTIME_BIN=/path/to/dsh-jsonrpc-agent   # or install @deepseek-ai/dsh-sdk-jsonrpc-demo
 *   export DSH_CORDIS_CONFIG=/path/to/cordis.yml        # or pass `cordis` below
 *   export DEEPSEEK_API_KEY=sk-...
 *   # export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
 *
 * Usage: node examples/basic.mjs "Say hi."
 */

import { DeepSeekHarness } from '../dist/index.js'

const prompt = process.argv[2] ?? 'Say hi.'

const harness = new DeepSeekHarness({
  provider: process.env.DSH_PROVIDER ?? 'deepseek-official',
  model: process.env.DSH_MODEL ?? 'deepseek-v4-flash',
})

try {
  const result = await harness.run(prompt, {
    onNotification: (notification) => {
      if (notification.method === 'session.event') {
        const event = notification.params.event
        if (event?.type === 'assistant/chunk') process.stderr.write(event.data?.chunk?.text ?? '')
      }
    },
  })
  process.stderr.write('\n')
  console.log(result.finalResponse)
  console.error(`[finish reason: ${result.finishReason ?? 'none'}, session: ${result.sessionId}]`)
} finally {
  await harness.close()
}
