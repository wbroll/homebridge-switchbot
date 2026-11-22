import type { ServerResponse } from 'node:http'

import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

export interface ClassicLockWebhookConfig {
  enabled?: boolean
  port?: number
  path?: string
  deviceIds?: string[]
}

type VerifyLock = (signal: AbortSignal, expiresAt: number) => Promise<void>

const BODY_LIMIT = 4096
const HTTP_TIMEOUT_MS = 2000
const HTTP_WINDOW_MS = 60_000
const HTTP_LIMIT = 60
const VERIFY_INTERVAL_MS = 5000
const VERIFY_TIMEOUT_MS = 5000
const VERIFY_DAILY_LIMIT = 240
const DAY_MS = 86_400_000

export function normalizeLockMac(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(?:[a-f\d]{12}|[a-f\d]{2}(?::[a-f\d]{2}){5}|[a-f\d]{2}(?:-[a-f\d]{2}){5})$/i.test(value)) {
    return value.replace(/[:-]/g, '').toUpperCase()
  }
}

export function parseClassicLockWebhookConfig(config?: ClassicLockWebhookConfig) {
  if (config?.enabled !== true) {
    return
  }
  const { path, port = 8787, deviceIds } = config
  if (typeof path !== 'string' || !/^\/[\w-]{43,128}$/.test(path)
    || !Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))
    || !Array.isArray(deviceIds) || deviceIds.length < 1 || deviceIds.length > 16) {
    return
  }
  const ids = new Set<string>()
  for (const id of deviceIds) {
    const mac = normalizeLockMac(id)
    if (!mac || ids.has(mac)) {
      return
    }
    ids.add(mac)
  }
  return { path, port, ids }
}

/** Accept only an already discovered API-only classic lock with the expected device ID. */
export function classicLockStatusReader(device: any, id: string): (() => Promise<unknown>) | undefined {
  const expected = normalizeLockMac(id)
  const info = device?.getInfo?.()
  if (expected && info?.deviceType === 'Smart Lock' && normalizeLockMac(info.id) === expected
    && (info.mac === undefined || normalizeLockMac(info.mac) === expected)
    && Array.isArray(info.connectionTypes) && info.connectionTypes.length === 1 && info.connectionTypes[0] === 'api'
    && device.hasAPI?.() === true && typeof device.getLockInfo === 'function') {
    return () => device.getLockInfo()
  }
}

/** The raw OpenAPI field is required. The SDK's generic getStatus can invent a default. */
export function decodeClassicLockStatus(status: unknown) {
  const value = (status as { lockState?: unknown } | null)?.lockState
  if (typeof value !== 'string') {
    return
  }
  const lockState = value.toLowerCase()
  if (lockState === 'locked' || lockState === 'unlocked' || lockState === 'jammed') {
    return { lockState }
  }
}

function decodeEvent(body: string) {
  const event = JSON.parse(body)
  const context = event?.context
  if (event?.eventType !== 'changeReport' || event.eventVersion !== '1' || context?.deviceType !== 'WoLock'
    || !['LOCKED', 'UNLOCKED', 'JAMMED'].includes(context.lockState)) {
    return
  }
  const id = normalizeLockMac(context.deviceMac)
  const sample = context.timeOfSample
  if (!id || !Number.isSafeInteger(sample) || sample < 1_000_000_000) {
    return
  }
  const time = sample < 10_000_000_000
    ? sample * 1000
    : sample
  const now = Date.now()
  if (time < now - 300_000 || time > now + 30_000) {
    return
  }
  return { id, time }
}

interface Verification {
  lastSample: number
  nextAt: number
  queued?: VerifyLock
  inFlight?: AbortController
  timer?: NodeJS.Timeout
}

export function startClassicLockWebhook(
  config: NonNullable<ReturnType<typeof parseClassicLockWebhookConfig>>,
  resolve: (id: string) => VerifyLock | undefined,
  onError: () => void,
) {
  const pathDigest = createHash('sha256').update(config.path).digest()
  const devices = new Map<string, Verification>()
  const verificationTimes: number[] = []
  let stopped = false
  let requests = 0
  let windowStart = Date.now()

  const schedule = (lock: Verification) => {
    if (stopped || lock.inFlight || lock.timer || !lock.queued) {
      return
    }
    lock.timer = setTimeout(async () => {
      lock.timer = undefined
      const now = Date.now()
      const verify = lock.queued
      lock.queued = undefined
      while (verificationTimes.length && verificationTimes[0] <= now - DAY_MS) {
        verificationTimes.shift()
      }
      if (stopped || !verify || verificationTimes.length >= VERIFY_DAILY_LIMIT) {
        return
      }
      verificationTimes.push(now)
      lock.nextAt = now + VERIFY_INTERVAL_MS
      const controller = new AbortController()
      lock.inFlight = controller
      const deadline = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
      try {
        await verify(controller.signal, now + VERIFY_TIMEOUT_MS)
      } catch {
        // Neither transport errors nor request data belong in the listener logs.
      } finally {
        clearTimeout(deadline)
        lock.inFlight = undefined
        schedule(lock)
      }
    }, Math.max(0, lock.nextAt - Date.now()))
  }

  const respond = (res: ServerResponse, code: number) => {
    res.writeHead(code, { Connection: 'close' }).end()
  }
  const server = createServer({
    maxHeaderSize: 4096,
    headersTimeout: HTTP_TIMEOUT_MS,
    requestTimeout: HTTP_TIMEOUT_MS,
    connectionsCheckingInterval: 500,
  }, (req, res) => {
    const now = Date.now()
    if (now - windowStart >= HTTP_WINDOW_MS) {
      windowStart = now
      requests = 0
    }
    if (++requests > HTTP_LIMIT) {
      respond(res, 429)
      return
    }
    if (!timingSafeEqual(pathDigest, createHash('sha256').update(req.url ?? '').digest())) {
      respond(res, 404)
      return
    }
    if (req.method !== 'POST') {
      respond(res, 405)
      return
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      respond(res, 415)
      return
    }
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      respond(res, 413)
      return
    }

    let size = 0
    const chunks: Buffer[] = []
    const deadline = setTimeout(respond, HTTP_TIMEOUT_MS, res, 408)
    res.once('close', () => clearTimeout(deadline))
    req.on('error', () => res.destroy())
    req.on('data', (chunk: Buffer) => {
      if (res.writableEnded) {
        return
      }
      size += chunk.length
      if (size > BODY_LIMIT) {
        respond(res, 413)
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      clearTimeout(deadline)
      if (stopped || res.writableEnded) {
        return
      }
      let event: ReturnType<typeof decodeEvent>
      try {
        event = decodeEvent(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        respond(res, 400)
        return
      }
      if (!event) {
        respond(res, 400)
        return
      }
      let verify: VerifyLock | undefined
      try {
        verify = config.ids.has(event.id)
          ? resolve(event.id)
          : undefined
      } catch {
        respond(res, 503)
        return
      }
      if (!verify) {
        respond(res, 404)
        return
      }
      const lock = devices.get(event.id) ?? { lastSample: 0, nextAt: 0 }
      if (event.time <= lock.lastSample) {
        respond(res, 204)
        return
      }
      devices.set(event.id, lock)
      lock.lastSample = event.time
      lock.inFlight?.abort()
      lock.queued = verify
      schedule(lock)
      respond(res, 202)
    })
  })
  server.maxConnections = 8
  server.maxRequestsPerSocket = 1
  server.setTimeout(HTTP_TIMEOUT_MS, socket => socket.destroy())
  server.on('error', onError)
  server.listen(config.port, '127.0.0.1')

  return {
    server,
    async close() {
      stopped = true
      for (const lock of devices.values()) {
        clearTimeout(lock.timer)
        lock.inFlight?.abort()
        lock.queued = undefined
      }
      devices.clear()
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
