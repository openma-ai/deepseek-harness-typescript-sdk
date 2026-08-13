import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonRpcLineTransport, JsonRpcResponseError } from '../src/index.js'

/** A connected pair of line transports over in-memory streams. */
function transportPair(): { left: JsonRpcLineTransport; right: JsonRpcLineTransport } {
  const leftToRight = new PassThrough()
  const rightToLeft = new PassThrough()
  const left = new JsonRpcLineTransport(rightToLeft, leftToRight)
  const right = new JsonRpcLineTransport(leftToRight, rightToLeft)
  left.start()
  right.start()
  return { left, right }
}

describe('JsonRpcLineTransport', () => {
  it('round-trips a request/response pair', async () => {
    const { left, right } = transportPair()
    right.onRequest(async (method, params) => ({ echoedMethod: method, echoedParams: params }))
    const result = await left.request('do/thing', { a: 1 })
    expect(result).toEqual({ echoedMethod: 'do/thing', echoedParams: { a: 1 } })
  })

  it('reassembles frames split across chunks and packed into one chunk', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const notifications: unknown[] = []
    transport.onNotification((method, params) => notifications.push([method, params]))
    transport.start()

    const frame1 = `${JSON.stringify({ jsonrpc: '2.0', method: 'n1', params: { i: 1 } })}\n`
    const frame2 = `${JSON.stringify({ jsonrpc: '2.0', method: 'n2', params: { i: 2 } })}\n`
    // Two frames in one chunk, then one frame split at an awkward byte boundary.
    input.write(frame1 + frame2)
    const frame3 = `${JSON.stringify({ jsonrpc: '2.0', method: 'n3', params: { i: 3 } })}\n`
    input.write(frame3.slice(0, 7))
    input.write(frame3.slice(7))
    await new Promise(resolve => setImmediate(resolve))

    expect(notifications).toEqual([
      ['n1', { i: 1 }],
      ['n2', { i: 2 }],
      ['n3', { i: 3 }],
    ])
  })

  it('ignores malformed lines and non-object params', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const notifications: unknown[] = []
    transport.onNotification((method, params) => notifications.push([method, params]))
    transport.start()

    input.write('this is not json\n')
    input.write('42\n')
    input.write('"just a string"\n')
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ok', params: [1, 2] })}\n`)
    await new Promise(resolve => setImmediate(resolve))

    // Array params collapse to {}, malformed lines vanish.
    expect(notifications).toEqual([['ok', {}]])
  })

  it('rejects with JsonRpcResponseError preserving code and data', async () => {
    const { left, right } = transportPair()
    right.onRequest(async () => { throw new Error('handler exploded') })
    await expect(left.request('will/fail', {})).rejects.toMatchObject({
      name: 'JsonRpcResponseError',
      code: -32603,
      message: 'handler exploded',
    })
  })

  it('answers unhandled requests with -32601', async () => {
    const { left } = transportPair()
    // `right` installed no request handler.
    await expect(left.request('nobody/home', {})).rejects.toMatchObject({ code: -32601 })
    await expect(left.request('nobody/home', {})).rejects.toBeInstanceOf(JsonRpcResponseError)
  })

  it('abandons a request on abort and cleans its pending entry', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()

    const controller = new AbortController()
    const pending = transport.request('hangs/forever', {}, controller.signal)
    controller.abort(new Error('deliberate abandon'))
    await expect(pending).rejects.toThrow('deliberate abandon')
  })

  it('fails pending requests on close and on input end', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()
    const viaClose = transport.request('never/answered', {})
    transport.close()
    await expect(viaClose).rejects.toThrow('JSON-RPC transport closed')

    const transport2 = new JsonRpcLineTransport(input, output)
    transport2.start()
    const viaEnd = transport2.request('never/answered', {})
    input.end()
    await expect(viaEnd).rejects.toThrow('JSON-RPC input closed')
  })
})
