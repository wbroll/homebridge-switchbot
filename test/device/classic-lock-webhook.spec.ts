import type { AddressInfo } from 'node:net'

import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request } from 'node:http'
import { connect } from 'node:net'

import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseClassicLockWebhookConfig, startClassicLockWebhook } from '../../src/classicLockWebhook.js'
import { LockDevice } from '../../src/devices/genericDevice.js'
import { SwitchBotClient } from '../../src/switchbotClient.js'
import { SwitchBotHAPPlatform } from '../../src/SwitchBotHAPPlatform.js'

const ID = '112233AABBCC'
const OTHER = '112233AABBEE'
const { SECURED, UNSECURED, JAMMED } = Characteristic.LockCurrentState
const locked = { lockState: 'locked' }
const unlocked = { lockState: 'unlocked' }

function config() {
  return {
    enabled: true,
    port: 0,
    path: `/${randomBytes(32).toString('base64url')}`,
    deviceIds: [ID],
  }
}

function body(overrides = {}) {
  return JSON.stringify({
    eventType: 'changeReport',
    eventVersion: '1',
    context: {
      deviceMac: '11:22:33:aa:bb:cc',
      deviceType: 'WoLock',
      lockState: 'LOCKED',
      timeOfSample: Date.now(),
      ...overrides,
    },
  })
}

function send(port: number, path: string, chunks: string[], method = 'POST', contentType = 'application/json') {
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': contentType },
    }, (res) => {
      res.resume()
      res.once('end', () => resolve(res.statusCode!))
    })
    req.once('error', reject)
    for (const chunk of chunks) {
      req.write(chunk)
    }
    req.end()
  })
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map(close => close()))
  } finally {
    vi.unstubAllGlobals()
  }
})

async function receiver(resolve = vi.fn(() => vi.fn(async () => {}))) {
  const options = config()
  const debug = vi.fn()
  const listener = startClassicLockWebhook(parseClassicLockWebhookConfig(options)!, resolve, vi.fn(), debug)
  cleanups.push(() => listener.close())
  await once(listener.server, 'listening')
  const { address, port } = listener.server.address() as AddressInfo
  return {
    address,
    port,
    path: options.path,
    resolve,
    debug,
  }
}

describe('local classic Lock HTTP receiver', () => {
  it('requires opt-in and rejects an invalid path or duplicate normalized IDs', () => {
    expect(parseClassicLockWebhookConfig()).toBeUndefined()
    expect(parseClassicLockWebhookConfig({
      ...config(),
      enabled: false,
    })).toBeUndefined()
    expect(parseClassicLockWebhookConfig({
      ...config(),
      path: '/short',
    })).toBeUndefined()
    expect(parseClassicLockWebhookConfig({
      ...config(),
      deviceIds: [ID, '11:22:33:aa:bb:cc'],
    })).toBeUndefined()
  })

  it('binds IPv4 loopback and parses a body split into HTTP chunks', async () => {
    const { address, port, path, resolve } = await receiver()
    const event = body()
    expect(address).toBe('127.0.0.1')
    expect(await send(port, path, [
      event.slice(0, 37),
      event.slice(37),
    ])).toBe(202)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it('rejects malformed or unauthorized HTTP requests and unknown devices', async () => {
    const { port, path, resolve } = await receiver()
    expect(await send(port, `${path}x`, [
      body(),
    ])).toBe(404)
    expect(await send(port, path, [], 'GET')).toBe(405)
    expect(await send(port, path, [
      body(),
    ], 'POST', 'text/plain')).toBe(415)
    expect(await send(port, path, ['{bad'])).toBe(400)
    expect(await send(port, path, [
      body().replace('"changeReport"', '"sceneReport"'),
    ])).toBe(400)
    expect(await send(port, path, [
      body().replace('"eventVersion":"1"', '"eventVersion":"2"'),
    ])).toBe(400)
    expect(await send(port, path, [
      body({ deviceType: 'WoLockPro' }),
    ])).toBe(400)
    expect(await send(port, path, [
      body({ deviceMac: 'not-a-mac' }),
    ])).toBe(400)
    expect(await send(port, path, [
      body({ deviceMac: OTHER }),
    ])).toBe(404)
    expect(await send(port, path, [
      body({ timeOfSample: Date.now() - 600_000 }),
    ])).toBe(400)
    expect(await send(port, path, [
      'x'.repeat(4100),
    ])).toBe(413)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('closes an incomplete request on deadline without dispatching it', async () => {
    const { port, path, resolve } = await receiver()
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    const closed = once(socket, 'close')
    socket.resume()
    socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`)
    await closed
    expect(resolve).not.toHaveBeenCalled()
  }, 4500)

  it('drops duplicate, older and equal-time contradictory events', async () => {
    const verify = vi.fn(async () => {})
    const { port, path } = await receiver(vi.fn(() => verify))
    const now = Date.now()
    expect(await send(port, path, [
      body({ timeOfSample: now }),
    ])).toBe(202)
    expect(await send(port, path, [
      body({ timeOfSample: now }),
    ])).toBe(204)
    expect(await send(port, path, [
      body({ timeOfSample: now - 1 }),
    ])).toBe(204)
    expect(await send(port, path, [
      body({ timeOfSample: now, lockState: 'UNLOCKED' }),
    ])).toBe(204)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
  })

  it('bounds HTTP requests even when their paths are invalid', async () => {
    const { port, path, resolve } = await receiver()
    for (let i = 0; i < 60; i++) {
      expect(await send(port, '/wrong', [])).toBe(404)
    }
    expect(await send(port, path, [
      body(),
    ])).toBe(429)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('aborts a verification on deadline and then services only one queued event', async () => {
    const aborted = vi.fn()
    const verify = vi.fn(async (signal: AbortSignal) => {
      await once(signal, 'abort')
      aborted()
    })
    const { port, path, debug } = await receiver(vi.fn(() => verify))
    const now = Date.now()
    expect(await send(port, path, [
      body({ timeOfSample: now }),
    ])).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1), 1000)
    await vi.waitFor(() => expect(aborted).toHaveBeenCalledTimes(1), 6000)
    expect(debug).toHaveBeenCalledWith(debug.mock.calls[0][0], 'discarded: timeout')
    expect(await send(port, path, [
      body({ timeOfSample: now + 1 }),
    ])).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2), 1000)
  }, 8500)

  it('supersedes a verification and coalesces newer conflicting hints without parallel verification', async () => {
    let firstSignal: AbortSignal | undefined
    const first = Promise.withResolvers<void>()
    const verify = vi.fn(async (signal: AbortSignal) => {
      firstSignal = signal
      await first.promise
    })
    const { port, path, debug } = await receiver(vi.fn(() => verify))
    const now = Date.now()
    expect(await send(port, path, [
      body({ timeOfSample: now }),
    ])).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    expect(await send(port, path, [
      body({ timeOfSample: now + 1, lockState: 'UNLOCKED' }),
    ])).toBe(202)
    expect(await send(port, path, [
      body({ timeOfSample: now + 2, lockState: 'JAMMED' }),
    ])).toBe(202)
    const accepted = debug.mock.calls.filter(([, event]) => event === 'accepted; verification queued')
    expect(accepted).toHaveLength(3)
    expect(new Set(accepted.map(([id]) => id)).size).toBe(3)
    for (const [id] of accepted.slice(0, 2)) {
      expect(debug).toHaveBeenCalledWith(id, 'discarded: newer webhook event')
    }
    expect(firstSignal?.aborted).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)
    first.resolve()
  })
})

function discoveredLock(getLockInfo = vi.fn().mockResolvedValue(unlocked)) {
  return {
    getInfo: () => ({
      id: ID,
      deviceType: 'Smart Lock',
      connectionTypes: ['api'],
    }),
    hasAPI: () => true,
    getLockInfo,
  }
}

describe('read-only SwitchBot verification', () => {
  it('requires verified discovery and signs a cancellable HTTPS status GET', async () => {
    const sdk = {
      getConfig: vi.fn(() => ({ token: 'test-token', secret: 'test-secret' })),
      devices: {
        get: vi.fn(() => discoveredLock()),
      },
    }
    const client = Object.assign(Object.create(SwitchBotClient.prototype) as SwitchBotClient, { client: sdk })
    const fetchStatus = vi.fn().mockResolvedValue(Response.json({ statusCode: 100, body: locked }))
    vi.stubGlobal('fetch', fetchStatus)
    const signal = new AbortController().signal
    await expect(client.getClassicLockWebhookReader(ID)?.(signal)).resolves.toEqual(locked)
    const [url, options] = fetchStatus.mock.calls[0]
    expect(url).toBe(`https://api.switch-bot.com/v1.1/devices/${ID}/status`)
    expect(options.signal).toBe(signal)
    expect(options.redirect).toBe('error')
    expect(options.method ?? 'GET').toBe('GET')
    const { Authorization, t, nonce, sign } = options.headers
    expect(Authorization).toBe('test-token')
    expect(sign).toBe(createHmac('sha256', 'test-secret').update(Authorization + t + nonce).digest('base64'))
    expect(client.getClassicLockWebhookReader(OTHER)).toBeUndefined()
  })
})

async function hapSetup({ enabled = true, verified = true } = {}) {
  const options = {
    ...config(),
    enabled,
  }
  const getLockInfo = vi.fn().mockResolvedValue(locked)
  const verify = vi.fn().mockResolvedValue(unlocked)
  const setDeviceState = vi.fn().mockResolvedValue(true)
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const client = {
    getDevice: vi.fn(async () => discoveredLock(getLockInfo)),
    getClassicLockWebhookReader: vi.fn(() => verified ? verify : undefined),
    setDeviceState,
  }
  const cfg = {
    _client: client,
    log,
    enableBLE: false,
    openApiToken: 'test-token',
    openApiSecret: 'test-secret',
    classicLockWebhook: options,
  }
  const device = new LockDevice({ id: ID, type: 'lock', deviceType: 'Smart Lock' }, cfg)
  const accessory = new Accessory('Lock', uuid.generate(ID))
  const api = {
    hap: { Service, Characteristic, uuid },
    registerPlatformAccessories: vi.fn(),
  }
  const platform = Object.assign(Object.create(SwitchBotHAPPlatform.prototype), {
    api,
    log,
    config: cfg,
    accessories: new Map([
      [accessory.UUID, accessory],
    ]),
    hapPushTargets: new Map(),
  })
  await platform.registerHAPAccessories([
    {
      created: {
        instance: device,
        createAccessory: () => device.createHAPAccessory(api),
      },
      d: { id: ID, name: 'Lock' },
      type: 'lock',
    },
  ])
  platform.startWebhookListener()
  const listener = platform.webhookListener as ReturnType<typeof startClassicLockWebhook> | undefined
  if (listener) {
    cleanups.push(() => listener.close())
    await once(listener.server, 'listening')
  }
  const service = accessory.getService(Service.LockMechanism)!
  const current = service.getCharacteristic(Characteristic.LockCurrentState)
  const target = service.getCharacteristic(Characteristic.LockTargetState)
  const post = (overrides?: object) => send((listener!.server.address() as AddressInfo).port, options.path, [
    body(overrides),
  ])
  const poll = () => platform._pushDeviceState(ID)
  return {
    listener,
    current,
    target,
    getLockInfo,
    verify,
    setDeviceState,
    post,
    poll,
    platform,
    debug: log.debug,
    path: options.path,
  }
}

describe('verified classic Lock HAP publication', () => {
  it('keeps the listener disabled by default and refuses a lock without verified discovery', async () => {
    expect((await hapSetup({ enabled: false })).listener).toBeUndefined()
    const { post, verify } = await hapSetup({ verified: false })
    expect(await post()).toBe(404)
    expect(verify).not.toHaveBeenCalled()
  })

  it('uses the independently read status instead of the hinted value and never sends a command', async () => {
    const { post, current, target, setDeviceState, poll, debug, path, verify } = await hapSetup()
    await poll()
    expect(current.value).toBe(SECURED)
    expect(await post({ lockState: 'LOCKED' })).toBe(202)
    await vi.waitFor(() => expect(current.value).toBe(UNSECURED))
    expect(target.value).toBe(UNSECURED)
    expect(setDeviceState).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalledOnce()
    const lines = debug.mock.calls.map(([message]) => message).filter(message => message.startsWith('[Classic Lock webhook '))
    const prefix = lines[0].match(/^\[Classic Lock webhook [a-f0-9-]{36}\]/)?.[0]
    expect(prefix).toBeDefined()
    expect(lines).toEqual([
      `${prefix} accepted; verification queued`,
      `${prefix} OpenAPI status request started`,
      `${prefix} OpenAPI status request succeeded`,
      `${prefix} status confirmed`,
    ])
    for (const secret of [
      path,
      ID,
      'test-token',
      'test-secret',
      'deviceMac',
    ]) {
      expect(lines.join(' ')).not.toContain(secret)
    }
  })

  it('reports an unchanged status without an extra read', async () => {
    const { post, poll, verify, debug } = await hapSetup()
    await poll()
    verify.mockResolvedValue(locked)
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(expect.stringMatching(/status unchanged$/)))
    expect(verify).toHaveBeenCalledOnce()
  })

  it('logs a failed read without including the error detail', async () => {
    const { post, verify, debug } = await hapSetup()
    verify.mockRejectedValueOnce(new Error('private-transport-detail'))
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(expect.stringMatching(/OpenAPI status request failed$/)))
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private-transport-detail')
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each([
    {},
    { locked: true },
  ])('rejects raw status without an explicit state: %j', async (status) => {
    const { post, current, target, verify } = await hapSetup()
    verify.mockResolvedValue(status)
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
  })

  it('keeps the target binary when OpenAPI independently verifies JAMMED', async () => {
    const { post, current, target, verify, poll } = await hapSetup()
    await poll()
    verify.mockResolvedValue({ lockState: 'jammed' })
    expect(await post({ lockState: 'JAMMED' })).toBe(202)
    await vi.waitFor(() => expect(current.value).toBe(JAMMED))
    expect(await current.handleGetRequest()).toBe(JAMMED)
    expect(target.value).toBe(SECURED)
  })

  it('discards a poll that started before a newer verified observation', async () => {
    const { post, current, target, verify, poll, getLockInfo } = await hapSetup()
    const slowPoll = Promise.withResolvers<typeof unlocked>()
    getLockInfo.mockReturnValueOnce(slowPoll.promise)
    const older = poll()
    await vi.waitFor(() => expect(getLockInfo).toHaveBeenCalledOnce())
    verify.mockResolvedValue(locked)
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(current.value).toBe(SECURED))
    slowPoll.resolve(unlocked)
    await older
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
  })

  it('does not let a slow verification overwrite a poll that started later', async () => {
    const { post, current, target, verify, poll, getLockInfo } = await hapSetup()
    const slowVerification = Promise.withResolvers<typeof locked>()
    verify.mockReturnValueOnce(slowVerification.promise)
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
    getLockInfo.mockResolvedValueOnce(unlocked)
    await poll()
    slowVerification.resolve(locked)
    await new Promise(resolve => setImmediate(resolve))
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
  })

  it('invalidates a verification started before a newer counter-command', async () => {
    const { post, current, target, verify, poll, getLockInfo, setDeviceState, debug } = await hapSetup()
    await target.handleSetRequest(SECURED)
    const slowVerification = Promise.withResolvers<typeof locked>()
    verify.mockReturnValueOnce(slowVerification.promise)
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())

    await target.handleSetRequest(UNSECURED)
    slowVerification.resolve(locked)
    await new Promise(resolve => setImmediate(resolve))
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/discarded: newer HomeKit command$/))
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
    expect(setDeviceState.mock.calls.map(([, command]) => command.command)).toEqual(['lock', 'unlock'])
    getLockInfo.mockResolvedValueOnce(unlocked)
    await poll()
  })

  it('closes the listener on platform shutdown and aborts outstanding verification', async () => {
    const { listener, platform, post, verify } = await hapSetup()
    verify.mockImplementationOnce(async (signal: AbortSignal) => once(signal, 'abort'))
    expect(await post()).toBe(202)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce())
    const signal = verify.mock.calls[0][0] as AbortSignal
    const closed = once(listener!.server, 'close')
    platform.shutdown()
    await closed
    expect(signal.aborted).toBe(true)
    expect(listener!.server.listening).toBe(false)
  })
})
