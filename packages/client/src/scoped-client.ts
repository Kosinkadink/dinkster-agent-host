/**
 * ScopedClient: the ONLY network access widget/preview/extension code gets.
 * Same-origin (relative to the connection base), GET-only, cached and
 * deduplicated so N nodes sharing one remote combo source cause one request.
 *
 * Caching: entries live for `ttlMs` (default 5 min); `refresh: true` bypasses
 * the cache (remote specs with refreshButton/refreshMs decide when). Failures
 * are NOT cached - the next query retries.
 */

import type { Json, ScopedClient } from '@dinkster/core'

export interface ScopedClientConfig {
  /** HTTP base, no trailing slash. '' = same origin (dev proxy). */
  readonly baseUrl: string
  readonly fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
  /** Cache lifetime for successful queries. */
  readonly ttlMs?: number
  readonly clock?: () => number
  /** Test seams for the remote-choice retry scheduler. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
}

interface CacheEntry {
  readonly value: unknown
  readonly at: number
}

const DEFAULT_TTL_MS = 5 * 60_000

export const REMOTE_CHOICES_DEFAULT_MAX_RETRIES = 2
export const REMOTE_CHOICES_DEFAULT_TIMEOUT_MS = 4096
const REMOTE_CHOICES_MAX_ENTRIES = 10_000
const REMOTE_CHOICES_MAX_STRING_BYTES = 4096
const REMOTE_CHOICES_MAX_BODY_BYTES = 2_097_152
const REMOTE_CHOICES_RETRY_BASE_MS = 250
const REMOTE_CHOICES_RETRY_CAP_MS = 2000
const RETRYABLE_REMOTE_CHOICES_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const REMOTE_CHOICES_ROUTE = /^\/api\/choices\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

export interface RemoteChoicePartition {
  readonly principalGeneration: number
  readonly schemaEpoch: number
}

export interface RemoteChoiceQueryOptions {
  readonly refresh?: boolean
  readonly signal?: AbortSignal
  readonly maxRetries?: number
  readonly timeoutMs?: number
  /** Demand-driven cache expiry. Zero/absent keeps the entry until invalidation. */
  readonly refreshMs?: number
}

interface RemoteChoiceInflight {
  readonly generation: number
  readonly controller: AbortController
  readonly promise: Promise<readonly string[]>
  refs: number
}

export interface RefreshableScopedClient extends ScopedClient {
  query(route: string, params: Readonly<Record<string, Json>>, opts?: { refresh?: boolean }): Promise<unknown>
  remoteChoices(route: string, options?: RemoteChoiceQueryOptions): Promise<readonly string[]>
  setRemoteChoicePartition(partition: RemoteChoicePartition): void
  remoteChoiceAuthority(): number
  dispose(): void
}

const abortError = (): DOMException => new DOMException('remote choices request aborted', 'AbortError')

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function validateRemoteChoices(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength > REMOTE_CHOICES_MAX_BODY_BYTES) {
    throw new Error(`remote choices body exceeds ${REMOTE_CHOICES_MAX_BODY_BYTES} bytes`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('remote choices body is not valid UTF-8')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('remote choices body is not valid JSON')
  }
  if (!Array.isArray(value)) throw new Error('remote choices response must be a JSON array')
  if (value.length > REMOTE_CHOICES_MAX_ENTRIES) {
    throw new Error(`remote choices response exceeds ${REMOTE_CHOICES_MAX_ENTRIES} entries`)
  }
  const encoder = new TextEncoder()
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('remote choices entries must be strings')
    if (entry.length === 0) throw new Error('remote choices entries must be nonempty')
    if (entry.includes('\0')) throw new Error('remote choices entries must not contain NUL')
    if (hasLoneSurrogate(entry)) throw new Error('remote choices entries must not contain a lone surrogate')
    if (encoder.encode(entry).byteLength > REMOTE_CHOICES_MAX_STRING_BYTES) {
      throw new Error(`remote choices entries must not exceed ${REMOTE_CHOICES_MAX_STRING_BYTES} UTF-8 bytes`)
    }
    if (seen.has(entry)) throw new Error('remote choices entries must be unique')
    seen.add(entry)
  }
  return value
}

const retryAfterMs = (response: Response, now: number): number | undefined => {
  const raw = response.headers.get('retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Date.parse(raw) - now
  if (!Number.isFinite(delay) || delay < 0) return undefined
  return Math.min(REMOTE_CHOICES_RETRY_CAP_MS, delay)
}

async function readBoundedRemoteChoicesBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const declaredLength = Number(contentLength)
    if (Number.isFinite(declaredLength) && declaredLength > REMOTE_CHOICES_MAX_BODY_BYTES) {
      void response.body?.cancel().catch(() => {})
      throw new Error(`remote choices body exceeds ${REMOTE_CHOICES_MAX_BODY_BYTES} bytes`)
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > REMOTE_CHOICES_MAX_BODY_BYTES) {
      throw new Error(`remote choices body exceeds ${REMOTE_CHOICES_MAX_BODY_BYTES} bytes`)
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > REMOTE_CHOICES_MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {})
      throw new Error(`remote choices body exceeds ${REMOTE_CHOICES_MAX_BODY_BYTES} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function createScopedClient(config: ScopedClientConfig): RefreshableScopedClient {
  const fetchFn = config.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const ttl = config.ttlMs ?? DEFAULT_TTL_MS
  const clock = config.clock ?? Date.now
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = config.random ?? Math.random
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, { token: symbol; promise: Promise<unknown> }>()
  const remoteChoiceCache = new Map<string, { readonly value: readonly string[]; readonly at: number }>()
  const remoteChoiceInflight = new Map<string, RemoteChoiceInflight>()
  const remoteChoiceGenerations = new Map<string, number>()
  let remoteChoicePartition: RemoteChoicePartition = { principalGeneration: 0, schemaEpoch: 0 }
  let remoteChoiceAuthority = 0
  let disposed = false

  const urlFor = (route: string, params: Readonly<Record<string, string>>): string => {
    // Must be a single-slash-rooted path: '//host/x' is a protocol-relative
    // cross-origin URL, exactly what a scoped client exists to prevent.
    if (!route.startsWith('/') || route.startsWith('//')) {
      throw new Error(`scoped route must be a same-origin absolute path: '${route}'`)
    }
    const qs = new URLSearchParams(params).toString()
    return `${config.baseUrl}${route}${qs ? `?${qs}` : ''}`
  }

  const remoteChoiceKey = (route: string): string => {
    const match = REMOTE_CHOICES_ROUTE.exec(route)
    if (!match) throw new Error(`'${route}' is not a registered remote choices route`)
    return `${remoteChoicePartition.principalGeneration}:${remoteChoicePartition.schemaEpoch}:global:${match[1]}`
  }

  const waitForRetry = async (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw abortError()
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => reject(abortError())
      signal.addEventListener('abort', aborted, { once: true })
      sleep(ms).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    })
  }

  const fetchRemoteChoices = async (
    route: string,
    key: string,
    generation: number,
    controller: AbortController,
    maxRetries: number,
    timeoutMs: number,
  ): Promise<readonly string[]> => {
    for (let attempt = 0; ; attempt += 1) {
      if (controller.signal.aborted) throw abortError()
      const attemptController = new AbortController()
      let timedOut = false
      const abortAttempt = (): void => attemptController.abort(controller.signal.reason)
      controller.signal.addEventListener('abort', abortAttempt, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        attemptController.abort(new DOMException('remote choices request timed out', 'TimeoutError'))
      }, timeoutMs)
      const finishAttempt = (): void => {
        clearTimeout(timeout)
        controller.signal.removeEventListener('abort', abortAttempt)
      }
      let response: Response
      try {
        response = await fetchFn(`${config.baseUrl}${route}`, {
          redirect: 'error',
          signal: attemptController.signal,
        })
      } catch (error) {
        finishAttempt()
        if (controller.signal.aborted) throw abortError()
        if (timedOut) {
          if (attempt >= maxRetries) throw attemptController.signal.reason
        } else {
          if (error instanceof DOMException && error.name === 'AbortError') throw abortError()
          if (!(error instanceof TypeError) || attempt >= maxRetries) throw error
        }
        const jitter = Math.floor(random() * Math.min(
          REMOTE_CHOICES_RETRY_CAP_MS,
          REMOTE_CHOICES_RETRY_BASE_MS * (2 ** attempt),
        ))
        await waitForRetry(jitter, controller.signal)
        continue
      }
      if (!response.ok) {
        finishAttempt()
        const retryable = RETRYABLE_REMOTE_CHOICES_STATUSES.has(response.status)
        if (!retryable || attempt >= maxRetries) {
          throw new Error(`remote choices ${route}: HTTP ${response.status}`)
        }
        const jitter = Math.floor(random() * Math.min(
          REMOTE_CHOICES_RETRY_CAP_MS,
          REMOTE_CHOICES_RETRY_BASE_MS * (2 ** attempt),
        ))
        await waitForRetry(Math.max(jitter, retryAfterMs(response, clock()) ?? 0), controller.signal)
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = await readBoundedRemoteChoicesBody(response)
      } catch (error) {
        finishAttempt()
        if (controller.signal.aborted) throw abortError()
        if (timedOut) {
          if (attempt >= maxRetries) throw attemptController.signal.reason
        } else {
          if (error instanceof DOMException && error.name === 'AbortError') throw abortError()
          if (!(error instanceof TypeError) || attempt >= maxRetries) throw error
        }
        const jitter = Math.floor(random() * Math.min(
          REMOTE_CHOICES_RETRY_CAP_MS,
          REMOTE_CHOICES_RETRY_BASE_MS * (2 ** attempt),
        ))
        await waitForRetry(jitter, controller.signal)
        continue
      }
      finishAttempt()
      if (controller.signal.aborted) throw abortError()
      const choices = validateRemoteChoices(bytes)
      if (remoteChoiceGenerations.get(key) !== generation) {
        throw new Error('remote choices request was superseded')
      }
      if (controller.signal.aborted) throw abortError()
      remoteChoiceCache.set(key, { value: choices, at: clock() })
      return choices
    }
  }

  const joinRemoteChoiceInflight = (
    key: string,
    inflight: RemoteChoiceInflight,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> => {
    inflight.refs += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const release = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', aborted)
        inflight.refs -= 1
        if (inflight.refs === 0 && !inflight.controller.signal.aborted) {
          if (remoteChoiceInflight.get(key) === inflight) remoteChoiceInflight.delete(key)
          inflight.controller.abort(abortError())
        }
      }
      const aborted = (): void => {
        release()
        reject(abortError())
      }
      if (signal?.aborted) {
        aborted()
        return
      }
      signal?.addEventListener('abort', aborted, { once: true })
      inflight.promise.then(
        (value) => {
          if (settled) return
          release()
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          release()
          reject(error)
        },
      )
    })
  }

  const client: RefreshableScopedClient = {
    async query(route, params, opts) {
      const stringParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      const url = urlFor(route, stringParams)
      if (opts?.refresh !== true) {
        const hit = cache.get(url)
        if (hit && clock() - hit.at < ttl) return hit.value
        const pending = inFlight.get(url)
        if (pending) return pending.promise
      }
      const token = Symbol(url)
      const promise = (async () => {
        const res = await fetchFn(url)
        if (!res.ok) throw new Error(`query ${route}: HTTP ${res.status}`)
        const value: unknown = await res.json()
        if (inFlight.get(url)?.token === token) cache.set(url, { value, at: clock() })
        return value
      })()
      inFlight.set(url, { token, promise })
      try {
        return await promise
      } finally {
        if (inFlight.get(url)?.token === token) inFlight.delete(url)
      }
    },
    mediaUrl(route, params) {
      return urlFor(route, params)
    },
    remoteChoices(route, options) {
      if (disposed) return Promise.reject(new Error('scoped client is disposed'))
      let key: string
      try {
        key = remoteChoiceKey(route)
      } catch (error) {
        return Promise.reject(error)
      }
      if (options?.signal?.aborted) return Promise.reject(abortError())
      if (options?.refresh !== true) {
        const cached = remoteChoiceCache.get(key)
        const refreshMs = options?.refreshMs ?? 0
        if (cached && (refreshMs === 0 || clock() - cached.at < refreshMs)) return Promise.resolve(cached.value)
        const pending = remoteChoiceInflight.get(key)
        if (pending && !pending.controller.signal.aborted) {
          return joinRemoteChoiceInflight(key, pending, options?.signal)
        }
        if (pending) remoteChoiceInflight.delete(key)
      }
      const maxRetries = options?.maxRetries ?? REMOTE_CHOICES_DEFAULT_MAX_RETRIES
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
        return Promise.reject(new Error('remote choices maxRetries must be a nonnegative integer'))
      }
      const timeoutMs = options?.timeoutMs ?? REMOTE_CHOICES_DEFAULT_TIMEOUT_MS
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        return Promise.reject(new Error('remote choices timeoutMs must be an integer in 1..60000'))
      }
      const generation = (remoteChoiceGenerations.get(key) ?? 0) + 1
      remoteChoiceGenerations.set(key, generation)
      const controller = new AbortController()
      const inflight: RemoteChoiceInflight = {
        generation,
        controller,
        refs: 0,
        promise: fetchRemoteChoices(route, key, generation, controller, maxRetries, timeoutMs),
      }
      remoteChoiceInflight.set(key, inflight)
      void inflight.promise.finally(() => {
        if (remoteChoiceInflight.get(key) === inflight) remoteChoiceInflight.delete(key)
      }).catch(() => {})
      return joinRemoteChoiceInflight(key, inflight, options?.signal)
    },
    setRemoteChoicePartition(partition) {
      if (
        partition.principalGeneration === remoteChoicePartition.principalGeneration &&
        partition.schemaEpoch === remoteChoicePartition.schemaEpoch
      ) return
      remoteChoicePartition = partition
      remoteChoiceAuthority += 1
      remoteChoiceCache.clear()
      remoteChoiceGenerations.clear()
      for (const inflight of remoteChoiceInflight.values()) inflight.controller.abort(abortError())
      remoteChoiceInflight.clear()
    },
    remoteChoiceAuthority() {
      return remoteChoiceAuthority
    },
    dispose() {
      if (disposed) return
      disposed = true
      remoteChoiceCache.clear()
      remoteChoiceGenerations.clear()
      for (const inflight of remoteChoiceInflight.values()) inflight.controller.abort(abortError())
      remoteChoiceInflight.clear()
    },
  }
  return client
}
