import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LockDevice } from '../../src/devices/genericDevice.js'
import { SwitchBotHAPPlatform } from '../../src/SwitchBotHAPPlatform.js'

const ID = 'classic-lock'
const SECURED = Characteristic.LockCurrentState.SECURED
const UNSECURED = Characteristic.LockCurrentState.UNSECURED
const locked = { lockState: 'locked', doorState: 'opened' }
const unlocked = { lockState: 'unlocked', doorState: 'opened' }

async function setup(deviceType = 'Smart Lock', enableBLE = false) {
  const getStatus = vi.fn().mockResolvedValue(unlocked)
  const setDeviceState = vi.fn().mockResolvedValue(true)
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const client = {
    getDevice: vi.fn(async () => ({ getStatus })),
    setDeviceState,
  }
  const device = new LockDevice({ id: ID, type: 'lock', deviceType }, {
    _client: client,
    log,
    enableBLE,
    blePollingEnabled: false,
  })
  const accessory = new Accessory('Lock', uuid.generate(ID))
  const api = {
    hap: { Service, Characteristic, uuid },
    registerPlatformAccessories: vi.fn(),
  }
  const platform = Object.assign(Object.create(SwitchBotHAPPlatform.prototype), {
    api,
    log,
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
  const service = accessory.getService(Service.LockMechanism)!
  const current = service.getCharacteristic(Characteristic.LockCurrentState)
  const target = service.getCharacteristic(Characteristic.LockTargetState)
  const poll = () => platform._pushDeviceState(ID)
  return {
    current,
    target,
    getStatus,
    setDeviceState,
    device,
    poll,
  }
}

describe('confirming classic Lock commands in HomeKit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('bypasses a warm cache and publishes both characteristics from one fresh response', async () => {
    const { current, target, getStatus, device } = await setup()
    await device.getState()
    getStatus.mockResolvedValue(locked)
    await target.handleSetRequest(SECURED)

    await vi.advanceTimersByTimeAsync(1999)
    expect(getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
    expect(await device.getState()).toEqual(locked)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the requested target through an old cloud response and confirms on the second attempt', async () => {
    const { current, target, getStatus, poll } = await setup()
    await poll()
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(2000)
    await poll()
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(SECURED)

    getStatus.mockResolvedValue(locked)
    await vi.advanceTimersByTimeAsync(4000)
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
    expect(getStatus).toHaveBeenCalledTimes(4)
  })

  it('protects the target until 20 seconds even if no read confirms it', async () => {
    const { current, target, getStatus, poll } = await setup()
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(getStatus).toHaveBeenCalledTimes(3)
    expect(target.value).toBe(SECURED)
    expect(current.value).toBe(UNSECURED)

    await vi.advanceTimersByTimeAsync(1)
    expect(target.value).toBe(UNSECURED)
    expect(current.value).toBe(UNSECURED)

    getStatus.mockResolvedValue(locked)
    await poll()
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
    expect(getStatus).toHaveBeenCalledTimes(4)
  })

  it.each([8000, 15_000])('confirms cloud availability at %i ms on the third read', async (availableAt) => {
    const { current, target, getStatus } = await setup()
    const startedAt = Date.now()
    getStatus.mockImplementation(async () => Date.now() - startedAt >= availableAt
      ? locked
      : unlocked)

    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(15_999)
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(SECURED)
    await vi.advanceTimersByTimeAsync(1)
    expect(getStatus).toHaveBeenCalledTimes(3)
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
  })

  it.each(['poll', 'HAP read'])('accepts a matching %s before the next scheduled read', async (source) => {
    const { current, target, getStatus, poll } = await setup()
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(8000)
    getStatus.mockResolvedValue(locked)

    if (source === 'poll') {
      await poll()
    } else {
      await expect(target.handleGetRequest()).resolves.toBe(SECURED)
    }
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getStatus).toHaveBeenCalledTimes(3)
  })

  it.each([
    false,
    { success: false },
  ])('skips the follow-up when the command returns %j', async (result) => {
    const { target, getStatus, setDeviceState, poll } = await setup()
    setDeviceState.mockResolvedValueOnce(result)
    await expect(target.handleSetRequest(SECURED)).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getStatus).not.toHaveBeenCalled()

    await poll()
    expect(target.value).toBe(UNSECURED)
  })

  it('keeps the target after an API error and accepts the next poll', async () => {
    const { current, target, getStatus, poll } = await setup()
    getStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(locked)
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(target.value).toBe(SECURED)

    await poll()
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('resumes polling after the deadline and ignores stalled responses', async () => {
    const { current, target, getStatus, poll } = await setup()
    const slowStatus = Promise.withResolvers<typeof locked>()
    getStatus.mockReturnValue(slowStatus.promise)
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(getStatus).toHaveBeenCalledTimes(3)

    getStatus.mockResolvedValue(unlocked)
    await poll()
    expect(target.value).toBe(UNSECURED)
    slowStatus.resolve(locked)
    await vi.advanceTimersByTimeAsync(0)
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
    expect(getStatus).toHaveBeenCalledTimes(4)
  })

  it('does not let a pre-command poll overwrite a confirmed state', async () => {
    const { current, target, getStatus, device, poll } = await setup()
    const previousStatus = Promise.withResolvers<typeof unlocked>()
    getStatus.mockReturnValueOnce(previousStatus.promise).mockResolvedValue(locked)
    const olderRead = poll()
    await vi.advanceTimersByTimeAsync(0)
    expect(getStatus).toHaveBeenCalledTimes(1)

    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(2000)
    expect(current.value).toBe(SECURED)
    previousStatus.resolve(unlocked)
    await olderRead
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
    expect(await device.getState()).toEqual(locked)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it.each(['poll', 'HAP read'])('publishes no old %s result after a confirmation', async (source) => {
    // Move the confirming response through the microtask turns between accepting
    // the old API result, calculating its value and applying it to HAP.
    for (let offset = 0; offset <= 20; offset++) {
      const { current, target, getStatus, poll } = await setup()
      const oldStatus = Promise.withResolvers<typeof unlocked>()
      const confirmation = Promise.withResolvers<typeof locked>()
      const currentChanges: number[] = []
      const targetChanges: number[] = []
      current.on('change', ({ oldValue, newValue }) => {
        if (oldValue !== newValue) {
          currentChanges.push(Number(newValue))
        }
      })
      target.on('change', ({ oldValue, newValue }) => {
        if (oldValue !== newValue) {
          targetChanges.push(Number(newValue))
        }
      })

      getStatus.mockReturnValueOnce(oldStatus.promise).mockReturnValueOnce(confirmation.promise)
      await target.handleSetRequest(SECURED)
      const reading = source === 'poll'
        ? Promise.all([
            poll(),
            poll(),
          ])
        : Promise.all([
            current.handleGetRequest(),
            target.handleGetRequest(),
          ])
      await vi.advanceTimersByTimeAsync(2000)
      expect(getStatus).toHaveBeenCalledTimes(2)

      oldStatus.resolve(unlocked)
      for (let turn = 0; turn < offset; turn++) {
        await Promise.resolve()
      }
      confirmation.resolve(locked)
      await reading
      await vi.advanceTimersByTimeAsync(0)
      expect(current.value, `microtask offset ${offset}`).toBe(SECURED)
      expect(target.value, `microtask offset ${offset}`).toBe(SECURED)
      expect(currentChanges, `microtask offset ${offset}`).toEqual([SECURED])
      expect(targetChanges, `microtask offset ${offset}`).toEqual([SECURED])

      await vi.advanceTimersByTimeAsync(16_000)
      await poll()
      expect(currentChanges).toEqual([SECURED, UNSECURED])
      expect(targetChanges).toEqual([SECURED, UNSECURED])
    }
  })

  it('ignores a late confirmation after a counter-command', async () => {
    const { current, target, getStatus, device } = await setup()
    const firstConfirmation = Promise.withResolvers<typeof locked>()
    getStatus.mockReturnValueOnce(firstConfirmation.promise)
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getStatus).toHaveBeenCalledTimes(1)

    await target.handleSetRequest(UNSECURED)
    await vi.advanceTimersByTimeAsync(2000)
    firstConfirmation.resolve(locked)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
    expect(await device.getState()).toEqual(unlocked)
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge an earlier write that completes after a counter-command', async () => {
    const { target, getStatus, setDeviceState } = await setup()
    const firstWrite = Promise.withResolvers<boolean>()
    setDeviceState.mockReturnValueOnce(firstWrite.promise)
    const earlierResult = expect(target.handleSetRequest(SECURED)).rejects.toBeDefined()

    await target.handleSetRequest(UNSECURED)
    await vi.advanceTimersByTimeAsync(2000)
    firstWrite.resolve(true)
    await earlierResult
    await vi.advanceTimersByTimeAsync(10_000)
    expect(target.value).toBe(UNSECURED)
    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Smart Lock Pro', false],
    ['Smart Lock', true],
  ])('leaves %s with BLE=%s on the existing command path', async (type, enableBLE) => {
    const { target, getStatus, setDeviceState } = await setup(type, enableBLE)
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setDeviceState).toHaveBeenCalledTimes(1)
    expect(getStatus).not.toHaveBeenCalled()
  })
})
