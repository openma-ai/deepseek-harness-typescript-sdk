import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeepSeekHarness,
  SdkProtocolError,
  TransportClosedError,
  finalResponse,
  normalizeInput,
  type HarnessNotification,
  type SessionEvent,
} from '../src/index.js'
import { FAKE_RUNTIME, tempDir } from './helpers.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function harness(knobs: Record<string, string> = {}, options: ConstructorParameters<typeof DeepSeekHarness>[0] = {}): DeepSeekHarness {
  const instance = new DeepSeekHarness({
    launchArgsOverride: [process.execPath, FAKE_RUNTIME],
    env: knobs,
    ...options,
  })
  cleanups.push(() => { void instance.close() })
  return instance
}

describe('DeepSeekHarness.run', () => {
  it('returns the final response, finish reason, events, and notifications of the owned interval', async () => {
    const h = harness({ FAKE_TEXT: 'scripted final answer' })
    const result = await h.run('Say hi.')

    expect(result.sessionId).toMatch(/^session-[0-9a-f]{32}$/)
    expect(result.finalResponse).toBe('scripted final answer')
    expect(result.finishReason).toBe('completed')
    expect(result.sessionRoot).toBeUndefined()
    expect(result.events.map(event => event.type)).toEqual([
      'agent/inbox/spliced',
      'turn/start',
      'assistant/chunk',
      'assistant/message',
      'turn/end',
    ])
    // Notifications: the receipt event, running, the turn events, idle.
    expect(result.notifications[0]?.method).toBe('session.event')
    expect(result.notifications.at(-1)).toMatchObject({
      method: 'session.status',
      params: { sessionId: result.sessionId, status: 'idle' },
    })
    await h.close()
  })

  it('reports max-tokens finish reasons and empty assistant messages', async () => {
    const h = harness({ FAKE_REASON_KIND: 'max-tokens', FAKE_EMPTY_MESSAGE: '1' })
    const result = await h.run('truncate me')
    expect(result.finishReason).toBe('max-tokens')
    expect(result.finalResponse).toBe('')
  })

  it('returns an undefined finish reason when no turn ended', async () => {
    const h = harness({ FAKE_NO_TURN_END: '1' })
    const result = await h.run('no turn end')
    expect(result.finishReason).toBeUndefined()
    expect(result.finalResponse).toBe('hello from fake runtime')
  })

  it('raises SdkProtocolError when turn/end carries no string reason kind', async () => {
    const h = harness({ FAKE_REASON_KIND: 'none' })
    await expect(h.run('bad reason')).rejects.toBeInstanceOf(SdkProtocolError)
  })

  it('raises SdkProtocolError on a malformed event envelope and malformed assistant content', async () => {
    const malformedEvent = harness({ FAKE_MALFORMED_EVENT: '1' })
    await expect(malformedEvent.run('x')).rejects.toBeInstanceOf(SdkProtocolError)
    await malformedEvent.close()

    const malformedMessage = harness({ FAKE_MALFORMED_MESSAGE: '1' })
    await expect(malformedMessage.run('x')).rejects.toBeInstanceOf(SdkProtocolError)
  })

  it('gates collection on the durable inbox receipt', async () => {
    const h = harness({ FAKE_PRE_RECEIPT_EVENT: '1' })
    const result = await h.run('receipt gating')
    // The stray pre-receipt event is outside the owned interval.
    expect(result.events.some(event => event.type === 'stray/event')).toBe(false)
    expect(result.notifications.some(notification =>
      (notification.params.event as { type?: string } | undefined)?.type === 'stray/event')).toBe(false)
    expect(result.events[0]?.type).toBe('agent/inbox/spliced')
  })

  it('collects descendant notifications while keeping events root-only', async () => {
    const h = harness({ FAKE_SUBAGENT: 'deep', FAKE_TEXT: 'root answer' })
    const streamed: HarnessNotification[] = []
    const result = await h.run('spawn children', { onNotification: notification => streamed.push(notification) })

    expect(result.finalResponse).toBe('root answer')
    // Root events only — descendant assistant messages cannot replace the root response.
    expect(result.events.every(event => event.type !== 'stray/event')).toBe(true)
    const methods = result.notifications.map(notification => notification.method)
    expect(methods.filter(method => method === 'subagent.started')).toHaveLength(2)
    expect(methods.filter(method => method === 'subagent.finished')).toHaveLength(2)

    const eventSessions = result.notifications
      .filter(notification => notification.method === 'session.event')
      .map(notification => notification.params.sessionId)
    expect(eventSessions).toContain(`${result.sessionId}-child`)
    expect(eventSessions).toContain(`${result.sessionId}-grandchild`)

    // The streaming observer saw exactly the collected notifications, in order.
    expect(streamed).toEqual(result.notifications)
  })

  it('sends the handshake route and resolved workspace cwd, and injects the environment', async () => {
    const dir = tempDir(cleanups)
    const initLog = join(dir, 'init.jsonl')
    const promptLog = join(dir, 'prompt.jsonl')
    const h = harness(
      {
        FAKE_RECORD_INIT: initLog,
        FAKE_RECORD_PROMPT: promptLog,
        FAKE_ECHO_CWD: '1',
        FAKE_ECHO_ENV: 'DSH_CWD,DSH_SESSION_ROOT,DSH_CORDIS_CONFIG,DEEPSEEK_BASE_URL,DEEPSEEK_API_KEY',
        FAKE_TEXT: 'env probe',
      },
      {
        provider: 'custom-provider',
        model: 'custom-model',
        maxTokens: 1234,
        cwd: dir,
        runtimeCwd: dir,
        sessionRoot: join(dir, 'sessions'),
        cordis: join(dir, 'cordis.yml'),
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: 'sk-test-123',
      },
    )
    const result = await h.run([{ type: 'text', text: 'verbatim blocks' }, { type: 'custom', payload: 1 }])

    const init = JSON.parse(readFileSync(initLog, 'utf8').trim()) as Record<string, unknown>
    expect(init).toEqual({ cwd: dir, provider: 'custom-provider', model: 'custom-model', maxTokens: 1234 })

    const prompt = JSON.parse(readFileSync(promptLog, 'utf8').trim()) as Record<string, unknown>
    expect(prompt.contentBlocks).toEqual([{ type: 'text', text: 'verbatim blocks' }, { type: 'custom', payload: 1 }])

    expect(result.sessionRoot).toBe(join(dir, 'sessions'))
    const lines = result.finalResponse.split('\n')
    expect(lines).toContain(`cwd=${dir}`)
    expect(lines).toContain(`DSH_CWD=${dir}`)
    expect(lines).toContain(`DSH_SESSION_ROOT=${join(dir, 'sessions')}`)
    expect(lines).toContain(`DSH_CORDIS_CONFIG=${join(dir, 'cordis.yml')}`)
    expect(lines).toContain('DEEPSEEK_BASE_URL=http://127.0.0.1:9999/v1')
    expect(lines).toContain('DEEPSEEK_API_KEY=sk-test-123')
    await h.close()
  })

  it('reuses one runtime across sessions and keeps explicit session ids', async () => {
    const h = harness({ FAKE_TEXT: 'again' })
    const session = h.session('session-fixed')
    const first = await session.run('one')
    const second = await session.run('two')
    expect(first.sessionId).toBe('session-fixed')
    expect(second.sessionId).toBe('session-fixed')

    const viaOptions = await h.run('three', { sessionId: 'session-named' })
    expect(viaOptions.sessionId).toBe('session-named')
    await h.close()
  })

  it('retries a failed handshake with a fresh subprocess', async () => {
    const dir = tempDir(cleanups)
    const marker = join(dir, 'failed-once.txt')
    const h = harness({ FAKE_INIT_ERROR_ONCE_FILE: marker })
    await expect(h.run('first attempt')).rejects.toMatchObject({ code: 7 })
    const result = await h.run('second attempt')
    expect(result.finalResponse).toBe('hello from fake runtime')
    await h.close()
  })

  it('close() is terminal: no handshake retry afterwards', async () => {
    const h = harness()
    await h.run('warm up')
    await h.close()
    await expect(h.run('after close')).rejects.toBeInstanceOf(TransportClosedError)
  })

  it('supports await using disposal', async () => {
    let captured: DeepSeekHarness
    {
      await using h = harness()
      captured = h
      const result = await h.run('inside the block')
      expect(result.finalResponse).toBe('hello from fake runtime')
    }
    // Disposed on scope exit: further use fails closed.
    await expect(captured.run('outside')).rejects.toBeInstanceOf(TransportClosedError)
  })
})

describe('helpers', () => {
  it('normalizeInput wraps strings and passes blocks verbatim', () => {
    expect(normalizeInput('hi')).toEqual([{ type: 'text', text: 'hi' }])
    const blocks = [{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }]
    expect(normalizeInput(blocks)).toBe(blocks)
  })

  it('finalResponse tolerates flat data.content producers and skips non-text blocks', () => {
    const events = [
      { type: 'assistant/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'flat' }] } },
    ] as unknown as SessionEvent[]
    expect(finalResponse(events)).toBe('flat')

    const mixed = [
      {
        type: 'assistant/message',
        seq: 1,
        time: 0,
        data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
      },
    ] as unknown as SessionEvent[]
    expect(finalResponse(mixed)).toBe('ab')
    expect(finalResponse([])).toBe('')
  })
})
