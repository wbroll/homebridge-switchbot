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
    expect(getStatus).toHaveBeenCalledTimes(3)
  })

  it('stops after two unconfirmed reads and lets the next poll reconcile the target', async () => {
    const { current, target, getStatus, poll } = await setup()
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getStatus).toHaveBeenCalledTimes(2)

    await poll()
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
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

  it('lets polling recover after an unreadable confirmation', async () => {
    const { current, target, getStatus, poll } = await setup()
    getStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(locked)
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getStatus).toHaveBeenCalledTimes(1)

    await poll()
    expect(current.value).toBe(SECURED)
    expect(target.value).toBe(SECURED)
  })

  it('resumes polling after the confirmation deadline and ignores the late response', async () => {
    const { current, target, getStatus, poll } = await setup()
    const slowStatus = Promise.withResolvers<typeof locked>()
    getStatus.mockReturnValueOnce(slowStatus.promise)
    await target.handleSetRequest(SECURED)
    await vi.advanceTimersByTimeAsync(10_001)

    await poll()
    expect(target.value).toBe(UNSECURED)
    slowStatus.resolve(locked)
    await vi.advanceTimersByTimeAsync(0)
    expect(current.value).toBe(UNSECURED)
    expect(target.value).toBe(UNSECURED)
    expect(getStatus).toHaveBeenCalledTimes(2)
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
