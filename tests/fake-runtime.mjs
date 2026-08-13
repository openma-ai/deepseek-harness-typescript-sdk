#!/usr/bin/env node
/**
 * Scripted stand-in for the DeepSeek Harness SDK runtime, driven entirely by
 * env vars — no model, no network. Speaks the runtime's newline-delimited
 * JSON-RPC protocol on stdio: answers `initialize`, `session/prompt`
 * (streaming scripted `session.event` notifications, then `session.status`
 * idle, then the response), and `shutdown`. Ported subset of the upstream
 * repo's fake runtime.
 *
 * Script vocabulary (all optional):
 * - `FAKE_TEXT`: assistant text for each turn (default `hello from fake runtime`).
 * - `FAKE_REASON_KIND`: the turn/end reason kind (default `completed`; `none` omits the reason member).
 * - `FAKE_NO_TURN_END`: do not emit a turn/end event at all.
 * - `FAKE_SUBAGENT`: emit a child session (`deep` adds a grandchild too).
 * - `FAKE_PRE_RECEIPT_EVENT`: emit a stray root session.event BEFORE the inbox receipt (gating probe).
 * - `FAKE_ECHO_CWD`: prefix the assistant text with the process cwd.
 * - `FAKE_ECHO_ENV`: comma-separated env names echoed as `name=value` lines in the assistant text.
 * - `FAKE_MALFORMED`: `initialize` returns `{}`; `prompt` returns `{}`.
 * - `FAKE_MALFORMED_PROMPT`: only `prompt` returns `{}` (no messageId).
 * - `FAKE_INIT_ERROR`: `initialize` answers a JSON-RPC error response with code 7.
 * - `FAKE_INIT_ERROR_ONCE_FILE`: fail `initialize` (code 7) only when this marker
 *   file does NOT exist yet, creating it (respawn-retry probe).
 * - `FAKE_MALFORMED_EVENT`: the turn's `session.event` carries a number as the event.
 * - `FAKE_MALFORMED_MESSAGE`: assistant/message content is not an array.
 * - `FAKE_EMPTY_MESSAGE`: assistant/message with an empty content array.
 * - `FAKE_HANG_PROMPT`: never answer `session/prompt` (timeout/dispose probe).
 * - `FAKE_IGNORE_EOF` + `FAKE_SIGTERM_FILE`: keep running after stdin EOF; touch the file on SIGTERM (ladder probe).
 * - `FAKE_TRAP_SIGTERM`: with `FAKE_IGNORE_EOF`, survive SIGTERM too (SIGKILL-rung probe).
 * - `FAKE_EXIT_BEFORE_INIT`: exit 3 immediately (spawn-then-die probe).
 * - `FAKE_STDERR`: write this line to stderr at boot (diagnostics-tail probe).
 * - `FAKE_RECORD_INIT`: append each `initialize` params JSON to this file (handshake probe).
 * - `FAKE_RECORD_PROMPT`: append each `session/prompt` params JSON to this file.
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'

const env = process.env

if (env.FAKE_STDERR !== undefined) process.stderr.write(`${env.FAKE_STDERR}\n`)
if (env.FAKE_EXIT_BEFORE_INIT !== undefined) process.exit(3)

if (env.FAKE_IGNORE_EOF !== undefined) {
  // Simulate a runtime that never quiesces from EOF so the dispose ladder
  // must escalate; record which rung fired.
  process.stdin.resume()
  process.stdin.on('end', () => { setInterval(() => {}, 1_000) })
  process.on('SIGTERM', () => {
    if (env.FAKE_SIGTERM_FILE !== undefined) writeFileSync(env.FAKE_SIGTERM_FILE, 'sigterm\n')
    if (env.FAKE_TRAP_SIGTERM === undefined) process.exit(0)
  })
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params })
}

let seq = 0
function event(sessionId, type, data) {
  notify('session.event', { sessionId, event: { type, seq: seq++, time: 0, data } })
}

function assistantText() {
  const parts = []
  if (env.FAKE_ECHO_CWD !== undefined) parts.push(`cwd=${process.cwd()}`)
  for (const name of (env.FAKE_ECHO_ENV ?? '').split(',').filter(entry => entry.length > 0)) {
    parts.push(`${name}=${env[name] ?? ''}`)
  }
  parts.push(env.FAKE_TEXT ?? 'hello from fake runtime')
  return parts.join('\n')
}

function runTurn(sessionId) {
  const text = assistantText()
  if (env.FAKE_MALFORMED_EVENT !== undefined) {
    notify('session.event', { sessionId, event: 42 })
    return
  }
  event(sessionId, 'turn/start', { turn: 0 })
  event(sessionId, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } })
  if (env.FAKE_MALFORMED_MESSAGE !== undefined) {
    event(sessionId, 'assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'fake-malformed-message',
        role: 'assistant',
        content: 'not-an-array',
        source: { kind: 'model', provider: 'fake', model: 'fake' },
      },
    })
    return
  }
  event(sessionId, 'assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: `fake-assistant-${seq}`,
      role: 'assistant',
      // Model the usage-only message recorded after a max-tokens step that
      // assembled no output blocks.
      content: env.FAKE_EMPTY_MESSAGE !== undefined ? [] : [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fake', model: 'fake' },
    },
  })
  if (env.FAKE_NO_TURN_END === undefined) {
    const reasonKind = env.FAKE_REASON_KIND ?? 'completed'
    const data = reasonKind === 'none' ? { turn: 0 } : { turn: 0, reason: { kind: reasonKind } }
    event(sessionId, 'turn/end', data)
  }
  if (env.FAKE_SUBAGENT !== undefined) {
    const childId = `${sessionId}-child`
    notify('subagent.started', { parentSessionId: sessionId, childSessionId: childId })
    event(childId, 'assistant/message', {
      turn: 0,
      step: 0,
      content: [{ type: 'text', text: 'child says hi' }],
      provenance: { provider: 'fake', model: 'fake' },
    })
    if (env.FAKE_SUBAGENT === 'deep') {
      const grandchildId = `${sessionId}-grandchild`
      notify('subagent.started', { parentSessionId: childId, childSessionId: grandchildId })
      event(grandchildId, 'assistant/message', {
        turn: 0,
        step: 0,
        content: [{ type: 'text', text: 'grandchild says hi' }],
        provenance: { provider: 'fake', model: 'fake' },
      })
      notify('subagent.finished', {
        provider: 'spawn',
        agentId: grandchildId,
        parentSessionId: childId,
        childSessionId: grandchildId,
        status: 'ok',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'grandchild says hi' }],
      })
    }
    notify('subagent.finished', {
      provider: 'spawn',
      agentId: childId,
      parentSessionId: sessionId,
      childSessionId: childId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'child says hi' }],
    })
  }
}

function sessionIdOf(params) {
  const value = params?.sessionId
  return typeof value === 'string' ? value : ''
}

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  if (line.trim().length === 0) return
  const frame = JSON.parse(line)
  if (frame.method === undefined || frame.id === undefined) return
  const respond = (result) => { write({ jsonrpc: '2.0', id: frame.id, result }) }
  switch (frame.method) {
    case 'initialize':
      if (env.FAKE_RECORD_INIT !== undefined) appendFileSync(env.FAKE_RECORD_INIT, `${JSON.stringify(frame.params)}\n`)
      if (env.FAKE_INIT_ERROR !== undefined) {
        write({ jsonrpc: '2.0', id: frame.id, error: { code: 7, message: 'scripted init failure', data: { hint: 'fake' } } })
        return
      }
      if (env.FAKE_INIT_ERROR_ONCE_FILE !== undefined && !existsSync(env.FAKE_INIT_ERROR_ONCE_FILE)) {
        writeFileSync(env.FAKE_INIT_ERROR_ONCE_FILE, 'failed-once\n')
        write({ jsonrpc: '2.0', id: frame.id, error: { code: 7, message: 'scripted first-boot failure' } })
        return
      }
      if (env.FAKE_MALFORMED !== undefined) {
        respond({})
        return
      }
      respond({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } })
      return
    case 'session/prompt': {
      if (env.FAKE_RECORD_PROMPT !== undefined) appendFileSync(env.FAKE_RECORD_PROMPT, `${JSON.stringify(frame.params)}\n`)
      const sessionId = sessionIdOf(frame.params)
      const messageId = `fake-user-${seq}`
      if (env.FAKE_PRE_RECEIPT_EVENT !== undefined) {
        event(sessionId, 'stray/event', { note: 'before the inbox receipt' })
      }
      event(sessionId, 'agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: messageId,
          role: 'user',
          content: [],
          source: { kind: 'user' },
        }],
      })
      notify('session.status', { sessionId, status: 'running' })
      if (env.FAKE_HANG_PROMPT !== undefined) return
      if (env.FAKE_MALFORMED !== undefined || env.FAKE_MALFORMED_PROMPT !== undefined) {
        respond({})
        return
      }
      runTurn(sessionId)
      notify('session.status', { sessionId, status: 'idle' })
      respond({ messageId })
      return
    }
    case 'shutdown':
      respond({})
      // An EOF-ignoring fake also refuses the protocol exit, so the client's
      // dispose ladder (not this cooperative path) must reap it.
      if (env.FAKE_IGNORE_EOF === undefined) setImmediate(() => process.exit(0))
      return
    default:
      write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: `unknown method: ${frame.method}` } })
  }
})
