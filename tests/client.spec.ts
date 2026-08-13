import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HarnessClient,
  JsonRpcResponseError,
  RequestTimeoutError,
  RuntimeResolutionError,
  SdkProtocolError,
  TransportClosedError,
  resolveDefaultLaunch,
} from '../src/index.js'
import { FAKE_LAUNCH, FAKE_RUNTIME, fakeEnv, tempDir } from './helpers.js'

const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function client(knobs: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof HarnessClient>[0]> = {}): HarnessClient {
  const instance = new HarnessClient({ ...FAKE_LAUNCH, env: fakeEnv(knobs), ...extra })
  cleanups.push(() => { void instance.close() })
  return instance
}

describe('HarnessClient', () => {
  it('performs the initialize handshake', async () => {
    const c = client()
    const result = await c.initialize({ cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(result.serverInfo.name).toBe('deepseek-harness-sdk-runtime')
    expect(result.serverInfo.version).toBe('0.0.1')
    await c.close()
  })

  it('raises SdkProtocolError on an initialize response without serverInfo', async () => {
    const c = client({ FAKE_MALFORMED: '1' })
    await expect(c.initialize({ cwd: '.', provider: 'p', model: 'm' })).rejects.toBeInstanceOf(SdkProtocolError)
  })

  it('surfaces a JSON-RPC initialize error with code and data', async () => {
    const c = client({ FAKE_INIT_ERROR: '1' })
    const failure = c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await expect(failure).rejects.toBeInstanceOf(JsonRpcResponseError)
    await expect(failure).rejects.toMatchObject({ code: 7, message: 'scripted init failure', data: { hint: 'fake' } })
  })

  it('returns the queued message id from prompt and rejects a malformed one', async () => {
    const c = client()
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    const messageId = await c.prompt('session-a', [{ type: 'text', text: 'hi' }])
    expect(messageId).toMatch(/^fake-user-/)
    await c.close()

    const malformed = client({ FAKE_MALFORMED_PROMPT: '1' })
    await malformed.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await expect(malformed.prompt('session-a', [{ type: 'text', text: 'hi' }])).rejects.toBeInstanceOf(SdkProtocolError)
  })

  it('times out a hung request with RequestTimeoutError', async () => {
    const c = client({ FAKE_HANG_PROMPT: '1' })
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await expect(c.request('session/prompt', { sessionId: 's', contentBlocks: [] }, 200))
      .rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it('reports exit code and stderr tail when the runtime dies before answering', async () => {
    const c = client({ FAKE_EXIT_BEFORE_INIT: '1', FAKE_STDERR: 'boom at boot' })
    const failure = c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await expect(failure).rejects.toBeInstanceOf(TransportClosedError)
    await expect(failure).rejects.toThrow(/exit code: 3/)
    await expect(failure).rejects.toThrow(/boom at boot/)
  })

  it('delivers notifications in wire order and honors subscription filters', async () => {
    const c = client()
    const everything = c.subscribe()
    const statusOnly = c.subscribe(notification => notification.method === 'session.status')
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await c.prompt('session-order', [{ type: 'text', text: 'hi' }])

    const first = await everything.next()
    expect(first.method).toBe('session.event')
    expect((first.params.event as { type: string }).type).toBe('agent/inbox/spliced')

    const status = await statusOnly.next()
    expect(status).toMatchObject({ method: 'session.status', params: { sessionId: 'session-order', status: 'running' } })
    const idle = await statusOnly.next()
    expect(idle.params.status).toBe('idle')
    everything.close()
    statusOnly.close()
    await c.close()
  })

  it('close() is idempotent, reaps the runtime, and later use fails closed', async () => {
    const c = client()
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await c.close()
    await c.close()
    expect(() => c.start()).toThrow(TransportClosedError)
    const born = c.subscribe()
    await expect(born.next()).rejects.toBeInstanceOf(TransportClosedError)
  })

  it('escalates to SIGTERM when the runtime ignores stdin EOF', async () => {
    const dir = tempDir(cleanups)
    const marker = join(dir, 'sigterm.txt')
    const c = client(
      { FAKE_IGNORE_EOF: '1', FAKE_SIGTERM_FILE: marker },
      { shutdownTimeoutMs: 200, disposeEofGraceMs: 200, disposeGraceMs: 2_000 },
    )
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await c.close()
    expect(existsSync(marker)).toBe(true)
  })

  it('escalates to SIGKILL when the runtime traps SIGTERM too', async () => {
    const dir = tempDir(cleanups)
    const marker = join(dir, 'sigterm.txt')
    const c = client(
      { FAKE_IGNORE_EOF: '1', FAKE_TRAP_SIGTERM: '1', FAKE_SIGTERM_FILE: marker },
      { shutdownTimeoutMs: 200, disposeEofGraceMs: 200, disposeGraceMs: 2_000 },
    )
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    await c.close()
    expect(existsSync(marker)).toBe(true)
  })
})

describe('default runtime resolution', () => {
  it('prefers DSH_RUNTIME_BIN and launches through it', async () => {
    const c = new HarnessClient({ env: fakeEnv({ DSH_RUNTIME_BIN: FAKE_RUNTIME }) })
    cleanups.push(() => { void c.close() })
    const result = await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    expect(result.serverInfo.name).toBe('deepseek-harness-sdk-runtime')
    await c.close()
  })

  it('raises RuntimeResolutionError when nothing resolves', () => {
    const env = { ...process.env }
    delete env.DSH_RUNTIME_BIN
    const dir = tempDir(cleanups)
    expect(() => resolveDefaultLaunch(env, dir)).toThrow(RuntimeResolutionError)
    const c = new HarnessClient({ env, runtimeResolveBase: dir, cwd: dir })
    expect(() => c.start()).toThrow(RuntimeResolutionError)
  })

  it('resolves the runtime npm package bin and injects its bundled default config', async () => {
    const dir = tempDir(cleanups)
    const packageDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo')
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    mkdirSync(join(packageDir, 'runtime'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-sdk-jsonrpc-demo',
      version: '0.0.0-test',
      bin: { 'dsh-jsonrpc-agent': 'lib/bin.js' },
      exports: { './package.json': './package.json' },
    }))
    // The "bin" is the fake runtime, re-exported so `node <bin.js>` works.
    writeFileSync(join(packageDir, 'lib', 'bin.js'), `import(${JSON.stringify(FAKE_RUNTIME)})\n`)
    writeFileSync(join(packageDir, 'runtime', 'cordis.yml'), '# bundled default composition\n')

    const resolved = resolveDefaultLaunch({ ...process.env, DSH_RUNTIME_BIN: '' }, dir)
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.args).toEqual([join(packageDir, 'lib', 'bin.js')])
    expect(resolved.defaultConfigPath).toBe(join(packageDir, 'runtime', 'cordis.yml'))

    // End to end: the client injects DSH_CORDIS_CONFIG and the runtime echoes it back.
    const env = fakeEnv({ FAKE_ECHO_ENV: 'DSH_CORDIS_CONFIG', FAKE_TEXT: 'done' })
    delete env.DSH_RUNTIME_BIN
    delete env.DSH_CORDIS_CONFIG
    const c = new HarnessClient({ env, runtimeResolveBase: dir })
    cleanups.push(() => { void c.close() })
    await c.initialize({ cwd: '.', provider: 'p', model: 'm' })
    const subscription = c.subscribe(notification =>
      notification.method === 'session.event'
      && (notification.params.event as { type?: string }).type === 'assistant/message')
    await c.prompt('session-config', [{ type: 'text', text: 'hi' }])
    const message = await subscription.next()
    const event = message.params.event as { data: { message: { content: { text: string }[] } } }
    expect(event.data.message.content[0]?.text).toContain(`DSH_CORDIS_CONFIG=${join(packageDir, 'runtime', 'cordis.yml')}`)
    await c.close()
  })
})
