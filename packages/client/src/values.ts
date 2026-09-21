/**
 * GET /api/values client (Dinkster native peek, backend commit a58cdb6):
 * retrieve a completed job's output values and media renditions.
 *
 * Contract highlights this module encodes:
 * - Lookup identity is (clientId, jobId, nodeId, outputId) - the RUNTIME
 *   node id verbatim, region iteration paths like 'r[3]/node' included.
 *   Fingerprints identify content; ETags are opaque rendition variant tags.
 * - Values resolve from the run's own retained result/cache identity: a
 *   peek can only ever see the exact value that run saw, or a structured
 *   refusal - never a newer value. Refusals are data, not exceptions
 *   (unknown-job / not-retained / evicted / not-complete / no-rendition /
 *   bad-element / type-not-loadable...); the reason vocabulary is open,
 *   so unknown reasons pass through for generic display.
 * - Renditions are immutable for a normalized selector set and ETag. The
 *   LRU-capped cache keeps selector variants separate. Rendition kinds are
 *   registry-extensible - negotiate against the descriptor's declared
 *   "renditions" list, never hardcode png.
 * - Descriptors mirror job-result output descriptors: recursive for lists
 *   (per-level cap 64 with elementsTruncated; length is always the FULL
 *   count), inline "value" only for registered scalar types.
 */

import { parseAssetTypeId } from '@dinkster/core'
import type { FetchLike } from './connection.js'

// ---------------------------------------------------------------------------
// Wire shapes (decoded, normalized)
// ---------------------------------------------------------------------------

export interface ValueQuery {
  readonly jobId: string
  /** Runtime node id exactly as events reported it ('r[3]/node' ok). */
  readonly nodeId: string
  readonly outputId: string
  /** Nested-list indices, applied left to right (list<list<..>> descent). */
  readonly element?: readonly number[]
}

export interface ValuePeekOptions {
  readonly signal?: AbortSignal
}

export interface RenditionOptions {
  /** Tensor batch index, independent of ValueQuery.element list descent. */
  readonly batch?: number
  /** Advertised provider version, used only for local cache identity. */
  readonly rendererVersion?: string
  /** A zero-based frame index, or a timestamp such as "1.25s". */
  readonly frame?: number | `${number}s`
  readonly thumbs?: number
  readonly waveform?: { readonly width: number; readonly height: number }
  readonly window?: { readonly start: number; readonly duration: number }
  readonly signal?: AbortSignal
}

export interface ValueDescriptor {
  readonly typeId: string
  /** Immutable content identity; rendition ETags are opaque variant tags. */
  readonly fingerprint: string
  readonly meta?: Readonly<Record<string, unknown>>
  /** Inline scalar (same policy as event summaries): present iff registered. */
  readonly value?: string | number | boolean
  /** Full element count (lists only), even when elements are truncated. */
  readonly length?: number
  /** Recursive element descriptors, capped per level (64). */
  readonly elements?: readonly ValueDescriptor[]
  readonly elementsTruncated?: boolean
}

export interface RenditionInfo {
  readonly kind: string
  readonly mime: string
  /** Opaque immutable selector for this rendition implementation. */
  readonly cacheKey?: string
  readonly default?: boolean
  readonly version?: string
  /** Only explicitly advertised parameters are supported; absence grants none. */
  readonly parameters?: readonly string[]
  readonly defaults?: Readonly<Record<string, string>>
  readonly limits?: Readonly<Record<string, number>>
}

/** Structured refusal: expected outcomes, not errors. Vocabulary is open. */
export interface ValueRefusal {
  readonly available: false
  /** 'unknown-job' | 'unknown-output' | 'not-retained' | 'bad-element' |
   *  'not-complete' | 'evicted' | 'no-rendition' | 'type-not-loadable' |
   *  'malformed-response' | 'http-error' | future reasons. */
  readonly reason: string
  readonly status: number
  readonly error: string
  /** For 'no-rendition': the kinds that ARE available. */
  readonly renditions?: readonly RenditionInfo[]
  /** Kind-only refusal declarations, without inventing MIME or capabilities. */
  readonly renditionKinds?: readonly string[]
}

export type ValuePeekResult =
  | { readonly available: true; readonly descriptor: ValueDescriptor; readonly renditions: readonly RenditionInfo[] }
  | ValueRefusal

export type RenditionResult =
  | {
      readonly available: true
      readonly bytes: ArrayBuffer
      readonly mime: string
      readonly kind: string
      /** Exact X-Dinkster-Rendition header; absent stays absent for strict consumers. */
      readonly reportedKind?: string
      readonly fingerprint: string
      readonly typeId?: string
      readonly etag?: string
      /** Display-time transform metadata. Stored rendition bytes are unchanged. */
      readonly colorTransform?: string
      /** Raw response metadata; absent headers do not imply a conversion. */
      readonly sourceTransfer?: string
      readonly previewColorSpace?: string
      /** For example, 'sampled-peak'; not a claim of exhaustive peaks. */
      readonly waveform?: string
    }
  | ValueRefusal

// ---------------------------------------------------------------------------
// Decode (tolerant on optional fields, strict on identity)
// ---------------------------------------------------------------------------

const rec = (v: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

const scalar = (v: unknown): string | number | boolean | undefined =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined

/** Strict on typeId/fingerprint (identity), tolerant on the rest. */
function descriptorOf(v: unknown, depth = 0): ValueDescriptor | undefined {
  if (depth > 32) return undefined
  const d = rec(v)
  if (!d) return undefined
  const typeId = typeof d['typeId'] === 'string' ? d['typeId'] : undefined
  const fingerprint = typeof d['fingerprint'] === 'string' ? d['fingerprint'] : undefined
  if (typeId === undefined || fingerprint === undefined) return undefined
  const meta = rec(d['meta'])
  const value = scalar(d['value'])
  // length is the FULL list count; a negative/unsafe count or more inline
  // elements than the declared count is semantically impossible - reject the
  // descriptor rather than let consumers index past the declared list.
  if (d['length'] !== undefined &&
    (typeof d['length'] !== 'number' || !Number.isSafeInteger(d['length']) || d['length'] < 0)) {
    return undefined
  }
  const length = d['length'] as number | undefined
  let elements: ValueDescriptor[] | undefined
  if (Array.isArray(d['elements'])) {
    elements = []
    for (const raw of d['elements']) {
      const element = descriptorOf(raw, depth + 1)
      if (element === undefined) return undefined
      elements.push(element)
    }
    if (length !== undefined && elements.length > length) return undefined
  }
  return {
    typeId,
    fingerprint,
    ...(meta !== undefined ? { meta } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(elements !== undefined ? { elements } : {}),
    ...(d['elementsTruncated'] === true ? { elementsTruncated: true } : {}),
  }
}

function renditionsOf(v: unknown): RenditionInfo[] {
  if (!Array.isArray(v)) return []
  const out: RenditionInfo[] = []
  for (const raw of v) {
    const r = rec(raw)
    if (!r) continue
    const kind = typeof r['kind'] === 'string' ? r['kind'] : undefined
    const mime = typeof r['mime'] === 'string' ? r['mime'] : undefined
    if (kind === undefined || mime === undefined) continue
    const cacheKey = typeof r['cacheKey'] === 'string' && r['cacheKey'] !== '' ? r['cacheKey'] : undefined
    const version = typeof r['version'] === 'string' ? r['version'] : undefined
    const parameters = Array.isArray(r['parameters']) && r['parameters'].every((p) => typeof p === 'string')
      ? r['parameters'] as string[] : undefined
    const rawDefaults = rec(r['defaults'])
    const defaults = rawDefaults !== undefined && Object.values(rawDefaults).every((v) => typeof v === 'string')
      ? rawDefaults as Readonly<Record<string, string>> : undefined
    const rawLimits = rec(r['limits'])
    const limits = rawLimits !== undefined && Object.values(rawLimits).every((v) => typeof v === 'number' && Number.isFinite(v))
      ? rawLimits as Readonly<Record<string, number>> : undefined
    out.push({
      kind, mime,
      ...(cacheKey !== undefined ? { cacheKey } : {}),
      ...(r['default'] === true ? { default: true } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
      ...(defaults !== undefined ? { defaults } : {}),
      ...(limits !== undefined ? { limits } : {}),
    })
  }
  return out
}

function refusalOf(status: number, body: unknown): ValueRefusal {
  const b = rec(body)
  const reason = typeof b?.['reason'] === 'string'
    ? b['reason']
    : typeof b?.['error'] === 'string'
      ? b['error']
      : 'http-error'
  const error = typeof b?.['message'] === 'string'
    ? b['message']
    : typeof b?.['error'] === 'string'
      ? b['error']
      : `HTTP ${status}`
  const renditions = b?.['renditions'] !== undefined ? renditionsOf(b['renditions']) : undefined
  const rawKinds = b?.['renditions']
  const renditionKinds = Array.isArray(rawKinds) && rawKinds.every((kind) => typeof kind === 'string')
    ? rawKinds as string[] : undefined
  return {
    available: false,
    reason,
    status,
    error,
    ...(renditions !== undefined && renditions.length > 0 ? { renditions } : {}),
    ...(renditionKinds !== undefined ? { renditionKinds } : {}),
  }
}

const localRefusal = (reason: string, error: string): ValueRefusal => ({
  available: false,
  reason,
  status: 0,
  error,
})

const aborted = (): ValueRefusal => localRefusal('aborted', 'request aborted')

const signalAborted = (signal?: AbortSignal): boolean => signal?.aborted === true

const isAbort = (error: unknown, signal?: AbortSignal): boolean =>
  signalAborted(signal) || rec(error)?.['name'] === 'AbortError'

const transportRefusal = (error: unknown, signal?: AbortSignal): ValueRefusal =>
  isAbort(error, signal)
    ? aborted()
    : localRefusal('http-error', error instanceof Error ? error.message : String(error))

async function responseJson(
  response: Response,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly refusal: ValueRefusal }> {
  if (signalAborted(signal)) return { ok: false, refusal: aborted() }
  try {
    const text = await response.text()
    if (signalAborted(signal)) return { ok: false, refusal: aborted() }
    if (text === '') return { ok: true, body: undefined }
    try {
      return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
      return { ok: true, body: undefined }
    }
  } catch (error) {
    return { ok: false, refusal: transportRefusal(error, signal) }
  }
}

/** Pick the rendition to fetch: explicit default, else the first declared. */
export const defaultRenditionOf = (renditions: readonly RenditionInfo[]): RenditionInfo | undefined =>
  renditions.find((r) => r.default) ?? renditions[0]

// ---------------------------------------------------------------------------
// Asset references in output descriptors
// ---------------------------------------------------------------------------

/** One renderable asset an output descriptor references (CAS digest). */
export interface ImageAssetRef {
  /** blake3:<64 hex> content digest; bytes live at GET /api/assets/{digest}. */
  readonly digest: string
  /** image/* media type recorded on the asset. */
  readonly mediaType: string
  readonly name?: string
}

/** CAS digest shape the backend mints; anything else never keys a fetch. */
const CAS_DIGEST = /^blake3:[0-9a-f]{64}$/

/**
 * Image-bearing asset references in a native output descriptor. Job-result
 * outputs and /api/values descriptors share the shape; hydrated job outputs
 * are stored as raw JSON, so this walks tolerantly. An asset value whose
 * meta carries a well-formed CAS digest and an image/* mediaType renders by
 * fetching the bytes at GET /api/assets/{digest} - the canonical CAS read
 * for content-addressed outputs. (Renditions cover values that need a
 * server-side encode, e.g. comfy.IMAGE tensors; asset bytes need none.)
 * Descends into list elements iteratively with a visited guard, so cyclic
 * or absurdly deep in-memory descriptors cannot hang or overflow;
 * duplicates by digest collapse to the first occurrence.
 */
export function imageAssetRefsOf(descriptor: unknown): readonly ImageAssetRef[] {
  const out: ImageAssetRef[] = []
  const seen = new Set<string>()
  const visited = new WeakSet<object>()
  const stack: unknown[] = [descriptor]
  while (stack.length > 0) {
    const d = rec(stack.pop())
    if (!d) continue
    if (visited.has(d)) continue
    visited.add(d)
    // An asset envelope's typeId is the bare atom OR a typed-asset stamp
    // (asset<comfy.IMAGE> since the backend's declaration migration) - the
    // meta shape (digest/mediaType/name) is identical either way.
    const typeId = d['typeId']
    if (typeId === 'dinkster.asset' || (typeof typeId === 'string' && parseAssetTypeId(typeId) !== undefined)) {
      const meta = rec(d['meta'])
      const digest = typeof meta?.['digest'] === 'string' ? meta['digest'] : undefined
      const mediaType = typeof meta?.['mediaType'] === 'string' ? meta['mediaType'] : undefined
      if (
        digest !== undefined &&
        CAS_DIGEST.test(digest) &&
        mediaType?.startsWith('image/') === true &&
        !seen.has(digest)
      ) {
        seen.add(digest)
        const name = typeof meta?.['name'] === 'string' ? meta['name'] : undefined
        out.push({ digest, mediaType, ...(name !== undefined ? { name } : {}) })
      }
    }
    const elements = d['elements']
    // Reverse push keeps first-occurrence order depth-first left-to-right.
    if (Array.isArray(elements)) for (let i = elements.length - 1; i >= 0; i--) stack.push(elements[i])
  }
  return out
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** LRU cap for completed immutable rendition reads. */
const RENDITION_CACHE_MAX = 64
const RENDITION_CACHE_BYTES = 64 * 1024 * 1024

interface NormalizedRenditionOptions {
  readonly batch?: string
  readonly frame?: string
  readonly thumbs?: string
  readonly waveform?: string
  readonly window?: string
  readonly signal?: AbortSignal
}

type CachedRendition = Omit<Extract<RenditionResult, { available: true }>, 'available'>

export class DinksterValuesClient {
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly fetchFn: FetchLike
  /** Normalized selectors plus ETag (or advertised/legacy fallback) -> bytes. */
  private readonly renditionCache = new Map<string, CachedRendition>()
  /** Query URL and announced identity -> cache key for no-network repeats. */
  private readonly urlCacheKey = new Map<string, string>()
  private readonly peekIdentity = new Map<string, {
    identity: string
    sequence: number
    cacheKeys: ReadonlyMap<string, string>
    defaultCacheKey?: string
  }>()
  private peekSequence = 0
  private peekEpoch = 0

  constructor(opts: { baseUrl: string; clientId: string; fetchFn?: FetchLike }) {
    this.baseUrl = opts.baseUrl
    this.clientId = opts.clientId
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  }

  private url(query: ValueQuery, rendition?: string, options?: NormalizedRenditionOptions): string {
    const params = new URLSearchParams({
      clientId: this.clientId,
      jobId: query.jobId,
      nodeId: query.nodeId,
      outputId: query.outputId,
    })
    DinksterValuesClient.selectorParams(query, rendition, options).forEach((value, key) => params.set(key, value))
    return `${this.baseUrl}/api/values?${params.toString()}`
  }

  private static renditionOptions(options: RenditionOptions): NormalizedRenditionOptions | ValueRefusal {
    let batch: string | undefined
    if (options.batch !== undefined) {
      if (!Number.isSafeInteger(options.batch) || options.batch < 0) {
        return localRefusal('invalid-rendition', 'batch index must be a safe nonnegative integer')
      }
      batch = String(options.batch)
    }
    let frame: string | undefined
    if (typeof options.frame === 'number') {
      if (!Number.isSafeInteger(options.frame) || options.frame < 0) {
        return localRefusal('invalid-rendition', 'frame index must be a safe nonnegative integer')
      }
      frame = String(options.frame)
    } else if (options.frame !== undefined) {
      const value = options.frame.slice(0, -1)
      const seconds = Number(value)
      if (!options.frame.endsWith('s') || value.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
        return localRefusal('invalid-rendition', 'frame timestamp must be a finite nonnegative number followed by s')
      }
      frame = `${seconds}s`
    }

    let thumbs: string | undefined
    if (options.thumbs !== undefined) {
      if (!Number.isSafeInteger(options.thumbs) || options.thumbs <= 0) {
        return localRefusal('invalid-rendition', 'thumbs must be a safe positive integer')
      }
      thumbs = String(options.thumbs)
    }

    let waveform: string | undefined
    if (options.waveform !== undefined) {
      const { width, height } = options.waveform
      if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
        return localRefusal('invalid-rendition', 'waveform dimensions must be safe positive integers')
      }
      waveform = `${width}x${height}`
    }

    let window: string | undefined
    if (options.window !== undefined) {
      const { start, duration } = options.window
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) {
        return localRefusal('invalid-rendition', 'window start and duration must be finite, with start nonnegative and duration positive')
      }
      window = `${start},${duration}`
    }

    return {
      ...(batch !== undefined ? { batch } : {}),
      ...(frame !== undefined ? { frame } : {}),
      ...(thumbs !== undefined ? { thumbs } : {}),
      ...(waveform !== undefined ? { waveform } : {}),
      ...(window !== undefined ? { window } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }
  }

  private static selectorParams(
    query: ValueQuery,
    rendition?: string,
    options: NormalizedRenditionOptions = {},
  ): URLSearchParams {
    const params = new URLSearchParams()
    if (query.element !== undefined && query.element.length > 0) params.set('element', query.element.join(','))
    if (rendition !== undefined) params.set('rendition', rendition)
    if (options.batch !== undefined) params.set('batch', options.batch)
    if (options.frame !== undefined) params.set('frame', options.frame)
    if (options.thumbs !== undefined) params.set('thumbs', options.thumbs)
    if (options.waveform !== undefined) params.set('waveform', options.waveform)
    if (options.window !== undefined) params.set('window', options.window)
    return params
  }

  /** Client-side guard: element indices must be safe nonnegative integers. */
  private static badElement(query: ValueQuery): ValueRefusal | undefined {
    if (query.element === undefined) return undefined
    if (query.element.every((i) => Number.isSafeInteger(i) && i >= 0)) return undefined
    return {
      available: false,
      reason: 'bad-element',
      status: 0,
      error: `element indices must be safe nonnegative integers: ${query.element.join(',')}`,
    }
  }

  /** Descriptor + declared renditions for one output (or element) of a completed job. */
  async peek(query: ValueQuery, options: ValuePeekOptions = {}): Promise<ValuePeekResult> {
    if (options.signal?.aborted === true) return aborted()
    const bad = DinksterValuesClient.badElement(query)
    if (bad) return bad
    const queryUrl = this.url(query)
    const sequence = ++this.peekSequence
    const peekEpoch = this.peekEpoch
    let res: Response
    try {
      res = await this.fetchFn(queryUrl, options.signal === undefined ? undefined : { signal: options.signal })
    } catch (error) {
      return transportRefusal(error, options.signal)
    }
    const decoded = await responseJson(res, options.signal)
    if (!decoded.ok) return decoded.refusal
    const body = decoded.body
    if (!res.ok) return refusalOf(res.status, body)
    const b = rec(body)
    const descriptor = descriptorOf(b?.['descriptor'])
    if (b?.['available'] !== true || descriptor === undefined) {
      return { available: false, reason: 'malformed-response', status: res.status, error: 'unrecognized /api/values success payload' }
    }
    const renditions = renditionsOf(b['renditions'])
    const result: ValuePeekResult = { available: true, descriptor, renditions }
    const announced = this.peekIdentity.get(queryUrl)
    if (sequence < (announced?.sequence ?? 0)) return result
    if (announced === undefined && peekEpoch !== this.peekEpoch) {
      // Lost ordering cannot justify an announcement or retaining bytes after success.
      this.urlCacheKey.clear()
      this.peekEpoch++
      return result
    }
    this.peekIdentity.delete(queryUrl)
    const cacheKeys = new Map<string, string>()
    for (const rendition of renditions) {
      if (rendition.cacheKey !== undefined) cacheKeys.set(rendition.kind, rendition.cacheKey)
    }
    const defaultCacheKey = renditions.find((rendition) => rendition.default)?.cacheKey
    this.peekIdentity.set(queryUrl, {
      identity: JSON.stringify([
        descriptor.fingerprint,
        renditions.map((r) => [r.kind, r.cacheKey, r.version, r.default]),
      ]),
      sequence,
      cacheKeys,
      ...(defaultCacheKey !== undefined ? { defaultCacheKey } : {}),
    })
    if (this.peekIdentity.size > RENDITION_CACHE_MAX * 4) {
      this.peekIdentity.delete(this.peekIdentity.keys().next().value!)
      // Forget aliases too, so an evicted announcement cannot revive pre-peek bytes.
      this.urlCacheKey.clear()
      this.peekEpoch++
    }
    return result
  }

  /**
   * Raw rendition bytes. `kind` is a declared rendition kind or 'default'.
   * Completed reads are cached by normalized selectors and server identity.
   */
  async rendition(query: ValueQuery, kind: string, options: RenditionOptions = {}): Promise<RenditionResult> {
    if (options.signal?.aborted === true) return aborted()
    const bad = DinksterValuesClient.badElement(query)
    if (bad) return bad
    const normalized = DinksterValuesClient.renditionOptions(options)
    if ('available' in normalized) return normalized
    const queryUrl = this.url(query)
    const announcement = this.peekIdentity.get(queryUrl)
    const announcedIdentity = announcement?.identity
    const advertisedCacheKey = kind === 'default'
      ? announcement?.defaultCacheKey
      : announcement?.cacheKeys.get(kind)
    const selector = advertisedCacheKey ?? kind
    const peekEpoch = this.peekEpoch
    const url = this.url(query, selector, normalized)
    const requestKey = JSON.stringify([url, announcedIdentity, options.rendererVersion, peekEpoch])
    const cachedKey = this.urlCacheKey.get(requestKey)
    if (cachedKey !== undefined) {
      const hit = this.renditionCache.get(cachedKey)
      if (hit) {
        this.renditionCache.delete(cachedKey)
        this.renditionCache.set(cachedKey, hit)
        return { available: true, ...hit }
      }
    }
    let res: Response
    try {
      res = await this.fetchFn(url, normalized.signal === undefined ? undefined : { signal: normalized.signal })
    } catch (error) {
      return transportRefusal(error, normalized.signal)
    }
    if (!res.ok) {
      const decoded = await responseJson(res, normalized.signal)
      return decoded.ok ? refusalOf(res.status, decoded.body) : decoded.refusal
    }
    let bytes: ArrayBuffer
    try {
      if (signalAborted(normalized.signal)) return aborted()
      bytes = await res.arrayBuffer()
      if (signalAborted(normalized.signal)) return aborted()
    } catch (error) {
      return transportRefusal(error, normalized.signal)
    }
    const mime = res.headers.get('Content-Type') ?? 'application/octet-stream'
    const typeId = res.headers.get('X-Dinkster-Type-Id') ?? undefined
    const fingerprint = res.headers.get('X-Dinkster-Fingerprint') ?? ''
    const reportedKind = res.headers.get('X-Dinkster-Rendition') ?? undefined
    const servedKind = reportedKind ?? kind
    const etag = res.headers.get('ETag') ?? undefined
    const colorTransform = res.headers.get('X-Dinkster-Color-Transform') ?? undefined
    const sourceTransfer = res.headers.get('X-Dinkster-Source-Transfer') ?? undefined
    const previewColorSpace = res.headers.get('X-Dinkster-Preview-Color-Space') ?? undefined
    const waveform = res.headers.get('X-Dinkster-Waveform') ?? undefined
    const result: CachedRendition = {
      bytes,
      mime,
      kind: servedKind,
      ...(reportedKind !== undefined ? { reportedKind } : {}),
      fingerprint,
      ...(typeId !== undefined ? { typeId } : {}),
      ...(etag !== undefined ? { etag } : {}),
      ...(colorTransform !== undefined ? { colorTransform } : {}),
      ...(sourceTransfer !== undefined ? { sourceTransfer } : {}),
      ...(previewColorSpace !== undefined ? { previewColorSpace } : {}),
      ...(waveform !== undefined ? { waveform } : {}),
    }
    const identity = etag ?? advertisedCacheKey ??
      (fingerprint === '' ? undefined : JSON.stringify([fingerprint, servedKind]))
    if (identity !== undefined && bytes.byteLength <= RENDITION_CACHE_BYTES &&
      peekEpoch === this.peekEpoch && announcedIdentity === this.peekIdentity.get(queryUrl)?.identity) {
      const entryKey = JSON.stringify([requestKey, identity])
      this.renditionCache.delete(entryKey)
      this.renditionCache.set(entryKey, result)
      let retainedBytes = 0
      for (const entry of this.renditionCache.values()) retainedBytes += entry.bytes.byteLength
      while (this.renditionCache.size > RENDITION_CACHE_MAX || retainedBytes > RENDITION_CACHE_BYTES) {
        const oldest = this.renditionCache.keys().next().value as string
        retainedBytes -= this.renditionCache.get(oldest)!.bytes.byteLength
        this.renditionCache.delete(oldest)
      }
      this.urlCacheKey.set(requestKey, entryKey)
      while (this.urlCacheKey.size > RENDITION_CACHE_MAX * 4) {
        const oldest = this.urlCacheKey.keys().next().value as string
        this.urlCacheKey.delete(oldest)
      }
    }
    return { available: true, ...result }
  }
}
