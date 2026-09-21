/**
 * DinksterValuesClient unit tests: /api/values query construction (runtime
 * region node ids, nested element descent, rendition negotiation),
 * recursive descriptor decode, structured refusal mapping (open reason
 * vocabulary), immutable rendition byte caching, and failure tolerance.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId } from '@dinkster/core'
import { defaultRenditionOf, DinksterConnection, DinksterValuesClient, imageAssetRefsOf, type FetchLike } from '../src/index.js'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function harness(respond: (url: string) => Response | undefined) {
  const urls: string[] = []
  const fetchFn: FetchLike = async (url) => {
    urls.push(url)
    const res = respond(url)
    if (!res) throw new Error(`unexpected fetch: ${url}`)
    return res
  }
  const client = new DinksterValuesClient({ baseUrl: 'http://test', clientId: 'client-1', fetchFn })
  return { client, urls }
}

const Q = { jobId: 'job-1', nodeId: 'n0', outputId: 'image' }

const OK_SCALAR = {
  available: true,
  descriptor: { typeId: 'core.int', fingerprint: 'fp-int', meta: {}, value: 42 },
  renditions: [],
}

describe('peek: query construction', () => {
  it('sends the four required params and no optional ones by default', async () => {
    const { client, urls } = harness(() => jsonResponse(200, OK_SCALAR))
    await client.peek(Q)
    expect(urls).toHaveLength(1)
    const u = new URL(urls[0]!)
    expect(u.pathname).toBe('/api/values')
    expect(u.searchParams.get('clientId')).toBe('client-1')
    expect(u.searchParams.get('jobId')).toBe('job-1')
    expect(u.searchParams.get('nodeId')).toBe('n0')
    expect(u.searchParams.get('outputId')).toBe('image')
    expect(u.searchParams.has('element')).toBe(false)
    expect(u.searchParams.has('rendition')).toBe(false)
  })

  it('passes runtime region iteration node ids verbatim (URL-encoded)', async () => {
    const { client, urls } = harness(() => jsonResponse(200, OK_SCALAR))
    await client.peek({ ...Q, nodeId: 'outer[0]/inner[2]/node' })
    const u = new URL(urls[0]!)
    expect(u.searchParams.get('nodeId')).toBe('outer[0]/inner[2]/node')
  })

  it('joins nested element indices with commas', async () => {
    const { client, urls } = harness(() => jsonResponse(200, OK_SCALAR))
    await client.peek({ ...Q, element: [0, 3] })
    expect(new URL(urls[0]!).searchParams.get('element')).toBe('0,3')
  })

  it('refuses bad element indices client-side without a network round trip', async () => {
    const { client, urls } = harness(() => undefined)
    for (const element of [[-1], [1.5], [Number.NaN]]) {
      const res = await client.peek({ ...Q, element })
      expect(res.available).toBe(false)
      if (!res.available) expect(res.reason).toBe('bad-element')
    }
    expect(urls).toHaveLength(0)
  })
})

describe('peek: descriptor decode', () => {
  it('decodes an inline scalar descriptor', async () => {
    const { client } = harness(() => jsonResponse(200, OK_SCALAR))
    const res = await client.peek(Q)
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.descriptor).toEqual({ typeId: 'core.int', fingerprint: 'fp-int', meta: {}, value: 42 })
      expect(res.renditions).toEqual([])
    }
  })

  it('decodes recursive list descriptors with truncation and full length', async () => {
    const body = {
      available: true,
      descriptor: {
        typeId: 'list<list<core.int>>',
        fingerprint: 'fp-outer',
        meta: {},
        length: 100,
        elementsTruncated: true,
        elements: [
          {
            typeId: 'list<core.int>',
            fingerprint: 'fp-inner',
            meta: {},
            length: 2,
            elements: [
              { typeId: 'core.int', fingerprint: 'fp-a', meta: {}, value: 1 },
              { typeId: 'core.int', fingerprint: 'fp-b', meta: {}, value: 2 },
            ],
          },
        ],
      },
      renditions: [],
    }
    const { client } = harness(() => jsonResponse(200, body))
    const res = await client.peek(Q)
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.descriptor.length).toBe(100)
      expect(res.descriptor.elementsTruncated).toBe(true)
      expect(res.descriptor.elements).toHaveLength(1)
      expect(res.descriptor.elements![0]!.elements![1]!.value).toBe(2)
    }
  })

  it('decodes declared renditions including pack-registered kinds', async () => {
    const body = {
      available: true,
      descriptor: { typeId: 'std.image', fingerprint: 'fp-img', meta: {} },
      renditions: [
        { kind: 'thumb', mime: 'image/webp' },
        { kind: 'png', mime: 'image/png', cacheKey: 'png/stored-v1', default: true },
      ],
    }
    const { client } = harness(() => jsonResponse(200, body))
    const res = await client.peek(Q)
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.renditions).toEqual([
        { kind: 'thumb', mime: 'image/webp' },
        { kind: 'png', mime: 'image/png', cacheKey: 'png/stored-v1', default: true },
      ])
      expect(defaultRenditionOf(res.renditions)?.kind).toBe('png')
    }
  })

  it('falls back to the first declared rendition when none is default', () => {
    expect(defaultRenditionOf([{ kind: 'a', mime: 'x' }, { kind: 'b', mime: 'y' }])?.kind).toBe('a')
    expect(defaultRenditionOf([])).toBeUndefined()
  })

  it('preserves provider capabilities and bounds without inferring them from the kind', async () => {
    const renditions = [
      { kind: 'png', mime: 'image/png' },
      { kind: 'png', mime: 'image/png', default: true, version: 'png-v2', parameters: ['batch'], defaults: { batch: '0' }, limits: { maxEdge: 1024 } },
      { kind: 'frame', mime: 'image/png', version: 'frame-v3', parameters: ['frame'], defaults: { frame: '0' }, limits: { maxEdge: 1024, maxOutputFrames: 1 } },
      { kind: 'thumbs', mime: 'image/png', parameters: ['thumbs'], defaults: { thumbs: '8' }, limits: { maxCount: 16, maxEdge: 128 } },
      { kind: 'pack-preview', mime: 'image/webp', parameters: ['custom'], defaults: { custom: 'small' }, limits: { customBound: 123.5 } },
    ]
    const { client } = harness(() => jsonResponse(200, { ...OK_SCALAR, renditions }))
    const result = await client.peek(Q)
    expect(result).toMatchObject({ available: true, renditions })
    if (result.available) {
      expect(result.renditions[0]).toEqual({ kind: 'png', mime: 'image/png' })
      expect(result.renditions[0]?.parameters?.includes('batch')).toBeUndefined()
    }
  })

  it.each([
    { cacheKey: 3, version: 3, parameters: 'batch', defaults: [], limits: [] },
    { cacheKey: '', version: null, parameters: ['batch', 3], defaults: { batch: 0 }, limits: { maxEdge: '1024' } },
    { cacheKey: null, version: {}, parameters: null, defaults: null, limits: { maxEdge: Number.POSITIVE_INFINITY } },
  ])('omits malformed optional capability fields without dropping the rendition: %j', async (metadata) => {
    const { client } = harness(() => jsonResponse(200, {
      ...OK_SCALAR, renditions: [{ kind: 'png', mime: 'image/png', ...metadata }],
    }))
    const result = await client.peek(Q)
    expect(result).toMatchObject({ available: true, renditions: [{ kind: 'png', mime: 'image/png' }] })
    if (result.available) expect(result.renditions).toEqual([{ kind: 'png', mime: 'image/png' }])
  })

  it('treats a malformed success payload as a structured refusal, not a throw', async () => {
    const { client } = harness(() => jsonResponse(200, { available: true, descriptor: { nope: 1 } }))
    const res = await client.peek(Q)
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('malformed-response')
  })

  it('CL9 rejects a list with a malformed element instead of shifting indices', async () => {
    const body = {
      available: true,
      descriptor: {
        typeId: 'list<core.int>',
        fingerprint: 'fp-list',
        meta: {},
        length: 2,
        elements: [
          { nope: 1 }, // malformed: missing typeId/fingerprint
          { typeId: 'core.int', fingerprint: 'fp-b', meta: {}, value: 2 },
        ],
      },
      renditions: [],
    }
    const { client } = harness(() => jsonResponse(200, body))
    const res = await client.peek(Q)
    // Silently dropping the malformed element would present server index 1
    // at UI index 0; the whole descriptor must be refused instead.
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('malformed-response')
  })

  it('CL9 rejects semantically impossible list counts', async () => {
    const descriptorWith = (extra: Record<string, unknown>): unknown => ({
      available: true,
      descriptor: { typeId: 'list<core.int>', fingerprint: 'fp', meta: {}, ...extra },
      renditions: [],
    })
    const element = { typeId: 'core.int', fingerprint: 'fp-a', meta: {}, value: 1 }
    for (const extra of [
      { length: -1 }, // negative count
      { length: 1.5 }, // fractional count
      { length: 1, elements: [element, element] }, // more inline than declared
    ]) {
      const { client } = harness(() => jsonResponse(200, descriptorWith(extra)))
      const res = await client.peek(Q)
      expect(res.available).toBe(false)
      if (!res.available) expect(res.reason).toBe('malformed-response')
    }
  })
})

describe('peek: refusals', () => {
  it.each([
    [404, 'unknown-job'],
    [404, 'unknown-output'],
    [404, 'not-retained'],
    [404, 'bad-element'],
    [409, 'not-complete'],
    [410, 'evicted'],
    [406, 'type-not-loadable'],
  ])('maps %i %s to structured data', async (status, reason) => {
    const { client } = harness(() => jsonResponse(status, { available: false, reason, error: `msg ${reason}` }))
    const res = await client.peek(Q)
    expect(res).toEqual({ available: false, reason, status, error: `msg ${reason}` })
  })

  it('keeps unknown future reasons available generically', async () => {
    const { client } = harness(() => jsonResponse(404, { available: false, reason: 'future-thing', error: 'x' }))
    const res = await client.peek(Q)
    expect(res.available).toBe(false)
    if (!res.available) expect(res.reason).toBe('future-thing')
  })

  it('preserves authorization codes and messages when the server omits a value reason', async () => {
    const { client } = harness(() => jsonResponse(403, {
      error: 'capability-required',
      message: 'scope shared requires jobs:read',
    }))
    await expect(client.peek(Q)).resolves.toEqual({
      available: false,
      reason: 'capability-required',
      status: 403,
      error: 'scope shared requires jobs:read',
    })
  })

  it('preserves the available rendition list on no-rendition', async () => {
    const body = {
      available: false,
      reason: 'no-rendition',
      error: 'no such kind',
      renditions: [{ kind: 'png', mime: 'image/png', default: true }],
    }
    const { client } = harness(() => jsonResponse(406, body))
    const res = await client.peek(Q)
    expect(res.available).toBe(false)
    if (!res.available) {
      expect(res.reason).toBe('no-rendition')
      expect(res.renditions).toEqual([{ kind: 'png', mime: 'image/png', default: true }])
    }
  })

  it('maps a non-JSON error body to http-error with the status', async () => {
    const { client } = harness(() => new Response('nope', { status: 500 }))
    const res = await client.peek(Q)
    expect(res).toEqual({ available: false, reason: 'http-error', status: 500, error: 'HTTP 500' })
  })

  it('maps network failure to a status-0 http-error refusal', async () => {
    const client = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        throw new Error('boom')
      },
    })
    const res = await client.peek(Q)
    expect(res).toEqual({ available: false, reason: 'http-error', status: 0, error: 'boom' })
  })

  it('supports cancellation before fetch and while reading the peek body', async () => {
    const preaborted = new AbortController()
    preaborted.abort()
    let calls = 0
    const preabortedClient = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        calls++
        return jsonResponse(200, OK_SCALAR)
      },
    })
    expect(await preabortedClient.peek(Q, { signal: preaborted.signal }))
      .toEqual({ available: false, reason: 'aborted', status: 0, error: 'request aborted' })
    expect(calls).toBe(0)

    const reading = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    const readingClient = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async (_url, init) => {
        receivedSignal = init?.signal
        const response = jsonResponse(200, OK_SCALAR)
        Object.defineProperty(response, 'text', { value: async () => {
          reading.abort()
          throw new DOMException('stopped', 'AbortError')
        } })
        return response
      },
    })
    expect(await readingClient.peek(Q, { signal: reading.signal }))
      .toMatchObject({ available: false, reason: 'aborted', status: 0 })
    expect(receivedSignal).toBe(reading.signal)
  })
})

describe('rendition: bytes and immutable cache', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const renditionResponse = (fingerprint: string, kind: string): Response =>
    new Response(PNG.slice().buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        ETag: `"${fingerprint}/${kind}"`,
        'X-Dinkster-Type-Id': 'std.image',
        'X-Dinkster-Fingerprint': fingerprint,
        'X-Dinkster-Rendition': kind,
      },
    })

  it('fetches raw bytes with rendition metadata from headers', async () => {
    const { client, urls } = harness(() => renditionResponse('fp-1', 'png'))
    const res = await client.rendition(Q, 'default')
    expect(new URL(urls[0]!).searchParams.get('rendition')).toBe('default')
    expect(res.available).toBe(true)
    if (res.available) {
      expect(new Uint8Array(res.bytes)).toEqual(PNG)
      expect(res.mime).toBe('image/png')
      expect(res.kind).toBe('png') // the SERVED kind, not the requested 'default'
      expect(res.reportedKind).toBe('png')
      expect(res.fingerprint).toBe('fp-1')
      expect(res.typeId).toBe('std.image')
      expect(res.etag).toBe('"fp-1/png"')
    }
  })

  it('retains an absent rendition header for strict identity consumers', async () => {
    const { client } = harness(() => new Response(PNG.slice().buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'X-Dinkster-Type-Id': 'std.image',
        'X-Dinkster-Fingerprint': 'fp-1',
      },
    }))
    const result = await client.rendition(Q, 'png')
    expect(result).toMatchObject({ available: true, kind: 'png' })
    if (result.available) expect(result.reportedKind).toBeUndefined()
  })

  it('encodes frame, thumbnail, waveform, and audio window selectors', async () => {
    const { client, urls } = harness(() => renditionResponse('fp-1', 'preview'))
    await client.rendition(Q, 'frame', { frame: 12 })
    await client.rendition(Q, 'frame', { frame: '1.250s' })
    await client.rendition(Q, 'thumbs', { thumbs: 8 })
    await client.rendition(Q, 'waveform', { waveform: { width: 512, height: 128 } })
    await client.rendition(Q, 'window', { window: { start: 1.25, duration: 3 } })

    expect(urls.map((url) => {
      const params = new URL(url).searchParams
      return {
        rendition: params.get('rendition'),
        frame: params.get('frame'),
        thumbs: params.get('thumbs'),
        waveform: params.get('waveform'),
        window: params.get('window'),
      }
    })).toEqual([
      { rendition: 'frame', frame: '12', thumbs: null, waveform: null, window: null },
      { rendition: 'frame', frame: '1.25s', thumbs: null, waveform: null, window: null },
      { rendition: 'thumbs', frame: null, thumbs: '8', waveform: null, window: null },
      { rendition: 'waveform', frame: null, thumbs: null, waveform: '512x128', window: null },
      { rendition: 'window', frame: null, thumbs: null, waveform: null, window: '1.25,3' },
    ])
  })

  it.each(['png', 'waveform', 'window'])('keeps %s tensor batch independent of nested list descent', async (kind) => {
    const { client, urls } = harness(() => renditionResponse('fp-1', kind))
    const query = { ...Q, element: [1, 2] }
    const first = await client.rendition(query, kind, { batch: 3 })
    const second = await client.rendition(query, kind, { batch: 3 })
    await client.rendition(query, kind, { batch: 0 })
    await client.rendition({ ...Q, element: [1, 2, 3] }, kind)
    expect(second).toEqual(first)
    expect(urls.map((url) => {
      const params = new URL(url).searchParams
      return [params.get('element'), params.get('batch')]
    })).toEqual([['1,2', '3'], ['1,2', '0'], ['1,2,3', null]])
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid batch %s without fetching', async (batch) => {
    const { client, urls } = harness(() => undefined)
    expect(await client.rendition(Q, 'png', { batch })).toMatchObject({ available: false, reason: 'invalid-rendition', status: 0 })
    expect(urls).toHaveLength(0)
  })

  it('refuses invalid selectors and unsafe element indices without fetching', async () => {
    const { client, urls } = harness(() => undefined)
    const requests = [
      client.rendition(Q, 'frame', { frame: -1 }),
      client.rendition(Q, 'frame', { frame: 'NaNs' as `${number}s` }),
      client.rendition(Q, 'thumbs', { thumbs: 0 }),
      client.rendition(Q, 'waveform', { waveform: { width: 512.5, height: 128 } }),
      client.rendition(Q, 'window', { window: { start: 0, duration: Number.POSITIVE_INFINITY } }),
      client.rendition({ ...Q, element: [Number.MAX_SAFE_INTEGER + 1] }, 'png'),
    ]
    const results = await Promise.all(requests)
    expect(results.slice(0, 5).every((result) => !result.available && result.reason === 'invalid-rendition')).toBe(true)
    expect(results[5]).toMatchObject({ available: false, reason: 'bad-element', status: 0 })
    expect(urls).toHaveLength(0)
  })

  it('serves a repeat query from the immutable cache without refetching', async () => {
    const { client, urls } = harness(() => renditionResponse('fp-1', 'png'))
    const first = await client.rendition(Q, 'png')
    const second = await client.rendition(Q, 'png')
    expect(urls).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it.each(['png', 'default'])('requests and rotates the advertised cacheKey for %s callers', async (kind) => {
    let cacheKey = 'png/stored-v1'
    let reads = 0
    const { client, urls } = harness((url) => {
      const selector = new URL(url).searchParams.get('rendition')
      if (selector === null) return jsonResponse(200, {
        available: true,
        descriptor: { typeId: 'std.image', fingerprint: 'fp-1' },
        renditions: [{ kind: 'png', mime: 'image/png', default: true, cacheKey }],
      })
      return new Response(new Uint8Array([++reads]).buffer, { headers: {
        ETag: `"fp-1/${selector}"`,
        'X-Dinkster-Fingerprint': 'fp-1',
        'X-Dinkster-Rendition': 'png',
      } })
    })
    await client.peek(Q)
    const first = await client.rendition(Q, kind)
    expect(await client.rendition(Q, kind)).toEqual(first)
    cacheKey = 'png/stored-v2'
    await client.peek(Q)
    const second = await client.rendition(Q, kind)
    expect(await client.rendition(Q, kind)).toEqual(second)
    expect(urls.filter((url) => new URL(url).searchParams.has('rendition')).map((url) =>
      new URL(url).searchParams.get('rendition'))).toEqual(['png/stored-v1', 'png/stored-v2'])
    expect(reads).toBe(2)
    if (!first.available || !second.available) expect.unreachable('both renditions should succeed')
    else {
      expect(first.kind).toBe('png')
      expect(new Uint8Array(first.bytes)).toEqual(new Uint8Array([1]))
      expect(new Uint8Array(second.bytes)).toEqual(new Uint8Array([2]))
    }
  })

  it('separates renderer versions before network lookup and treats ETags as opaque', async () => {
    let nextByte = 1
    const { client, urls } = harness(() => new Response(new Uint8Array([nextByte++]).buffer, {
      headers: { ETag: 'W/"opaque/variant;tag"', 'X-Dinkster-Fingerprint': 'fp-1', 'X-Dinkster-Rendition': 'png' },
    }))
    const first = await client.rendition(Q, 'png', { rendererVersion: 'v1', batch: 3 })
    const second = await client.rendition(Q, 'png', { rendererVersion: 'v2', batch: 3 })
    expect(await client.rendition(Q, 'png', { rendererVersion: 'v1', batch: 3 })).toEqual(first)
    expect(await client.rendition(Q, 'png', { rendererVersion: 'v2', batch: 3 })).toEqual(second)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe(urls[1])
    expect(new URL(urls[0]!).searchParams.has('rendererVersion')).toBe(false)
    if (!first.available || !second.available) expect.unreachable('both renderer versions should succeed')
    else {
      expect(new Uint8Array(first.bytes)).toEqual(new Uint8Array([1]))
      expect(new Uint8Array(second.bytes)).toEqual(new Uint8Array([2]))
      expect(second.etag).toBe('W/"opaque/variant;tag"')
    }
  })

  it.each(['png', 'default'])('registers peek identity changes for existing %s callers', async (kind) => {
    let version: string | undefined = 'v1'
    let fingerprint = 'fp-1'
    let reads = 0
    const { client } = harness((url) => new URL(url).searchParams.has('rendition')
      ? new Response(new Uint8Array([++reads]).buffer, { headers: { ETag: '"opaque"' } })
      : jsonResponse(200, {
        available: true, descriptor: { typeId: 'comfy.IMAGE', fingerprint },
        renditions: [{ kind: 'png', mime: 'image/png', default: true, version }],
      }))
    await client.rendition(Q, kind)
    await client.peek(Q)
    const old = await client.rendition(Q, kind)
    await client.peek(Q)
    expect(await client.rendition(Q, kind)).toEqual(old)
    expect(reads).toBe(2)
    version = 'v2'
    await client.peek(Q)
    const updated = await client.rendition(Q, kind)
    expect(await client.rendition(Q, kind)).toEqual(updated)
    expect(reads).toBe(3)
    fingerprint = 'fp-2'
    await client.peek(Q)
    await client.rendition(Q, kind)
    expect(reads).toBe(4)
    version = undefined
    await client.peek(Q)
    await client.rendition(Q, kind)
    expect(reads).toBe(5)
  })

  it('does not revive cached v1 bytes when an older peek finishes after a successful v2 peek', async () => {
    let version = 'v1'
    let peeks = 0
    let reads = 0
    let finishPeek!: () => void
    let beginPeek!: () => void
    const peekStarted = new Promise<void>((resolve) => { beginPeek = resolve })
    const { client } = harness((url) => {
      if (new URL(url).searchParams.has('rendition')) {
        reads++
        return new Response(version, { headers: { ETag: `"${version}"` } })
      }
      const response = jsonResponse(200, {
        ...OK_SCALAR, renditions: [{ kind: 'png', mime: 'image/png', version }],
      })
      if (++peeks === 2) {
        const readText = response.text.bind(response)
        response.text = async () => {
          const text = await readText()
          beginPeek()
          return new Promise((resolve) => { finishPeek = () => resolve(text) })
        }
      }
      return response
    })
    await client.peek(Q)
    expect(await client.rendition(Q, 'png')).toMatchObject({ available: true, etag: '"v1"' })
    const older = client.peek(Q)
    await peekStarted
    version = 'v2'
    await client.peek(Q)
    const current = await client.rendition(Q, 'png')
    expect(current).toMatchObject({ available: true, etag: '"v2"' })
    finishPeek()
    expect(await older).toMatchObject({ available: true, renditions: [{ version: 'v1' }] })
    expect(await client.rendition(Q, 'png')).toEqual(current)
    expect(reads).toBe(2)
  })

  it.each([
    ['retained', 'v1'], ['retained', 'v2'], ['evicted', 'v2'], ['unannounced', 'v2'],
  ] as const)('refreshes bytes after a successful peek across eviction with query %s and provider %s', async (announcement, nextVersion) => {
    let version = 'v1'
    let holdPeek = false
    let holdBody = true
    let reads = 0
    let finishPeek!: (response: Response) => void
    let finishBody!: () => void
    let beginBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { beginBody = resolve })
    const peekResponse = () => jsonResponse(200, {
      ...OK_SCALAR, renditions: [{ kind: 'png', mime: 'image/png', version }],
    })
    const client = new DinksterValuesClient({
      baseUrl: 'http://test', clientId: 'client-1',
      fetchFn: async (url) => {
        const params = new URL(url).searchParams
        if (params.has('rendition')) {
          reads++
          const response = new Response(version, { headers: { ETag: `"${version}"` } })
          if (params.get('rendition') === 'preview' && holdBody) {
            holdBody = false
            const readBody = response.arrayBuffer.bind(response)
            response.arrayBuffer = async () => {
              const bytes = await readBody()
              beginBody()
              return new Promise((resolve) => { finishBody = () => resolve(bytes) })
            }
          }
          return response
        }
        if (holdPeek && params.get('outputId') === Q.outputId) {
          return new Promise((resolve) => { finishPeek = resolve })
        }
        return peekResponse()
      },
    })
    if (announcement === 'evicted') await client.peek(Q)
    const others = announcement === 'unannounced' ? 256 : 255
    for (let i = 0; i < others; i++) await client.peek({ ...Q, outputId: `other-${i}` })
    if (announcement === 'retained') await client.peek(Q)
    holdPeek = true
    const pending = client.peek(Q)
    await client.peek({ ...Q, outputId: 'evicts-oldest' })
    expect(await client.rendition(Q, 'default')).toMatchObject({ available: true, etag: '"v1"' })
    expect(await client.rendition(Q, 'png', { batch: 3 })).toMatchObject({ available: true, etag: '"v1"' })
    const oldBody = client.rendition(Q, 'preview')
    await bodyStarted
    version = nextVersion
    finishPeek(peekResponse())
    expect(await pending).toMatchObject({ available: true, renditions: [{ version }] })
    const variants = [['default', {}], ['png', { batch: 3 }], ['preview', {}]] as const
    for (const [kind, options] of variants) {
      expect(await client.rendition(Q, kind, options)).toMatchObject({ available: true, etag: `"${version}"` })
    }
    finishBody()
    await oldBody
    for (const [kind, options] of variants) {
      expect(await client.rendition(Q, kind, options)).toMatchObject({ available: true, etag: `"${version}"` })
    }
    expect(reads).toBe(version === 'v1' ? 4 : 6)
  })

  it.each([false, true])('does not let an older in-flight body overwrite a new renderer (evict announcement: %s)', async (evictAnnouncement) => {
    let finishBody!: (bytes: ArrayBuffer) => void
    let beginBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { beginBody = resolve })
    let reads = 0
    const { client } = harness((url) => {
      if (!new URL(url).searchParams.has('rendition')) return jsonResponse(200, {
        ...OK_SCALAR, renditions: [{ kind: 'png', mime: 'image/png', version: 'v2' }],
      })
      const response = renditionResponse('fp-1', 'png')
      if (++reads === 1) response.arrayBuffer = () => {
        beginBody()
        return new Promise((resolve) => { finishBody = resolve })
      }
      return response
    })
    const old = client.rendition(Q, 'png')
    await bodyStarted
    await client.peek(Q)
    if (evictAnnouncement) {
      for (let i = 0; i < 256; i++) await client.peek({ ...Q, outputId: `other-${i}` })
    }
    const current = await client.rendition(Q, 'png')
    finishBody(new Uint8Array([1]).buffer)
    await old
    expect(await client.rendition(Q, 'png')).toEqual(current)
    expect(reads).toBe(2)
  })

  it('normalizes equivalent decimal frame selectors without parsing the ETag', async () => {
    const { client, urls } = harness(() => renditionResponse('fp-1', 'frame'))
    const first = await client.rendition(Q, 'frame', { frame: '1.250s' })
    expect(await client.rendition(Q, 'frame', { frame: '1.25s' })).toEqual(first)
    expect(urls).toHaveLength(1)
  })

  it('evicts least recently used bytes at 64 MiB before reaching the entry limit', async () => {
    const bytes = new ArrayBuffer(24 * 1024 * 1024)
    const { client, urls } = harness(() => {
      const response = renditionResponse('fp-1', 'frame')
      response.arrayBuffer = async () => bytes
      return response
    })
    await client.rendition(Q, 'frame', { frame: 0 })
    await client.rendition(Q, 'frame', { frame: 1 })
    await client.rendition(Q, 'frame', { frame: 0 })
    await client.rendition(Q, 'frame', { frame: 2 })
    await client.rendition(Q, 'frame', { frame: 0 })
    expect(urls).toHaveLength(3)
    await client.rendition(Q, 'frame', { frame: 1 })
    expect(urls).toHaveLength(4)
  })

  it('returns oversized renditions without retaining them or evicting smaller previews', async () => {
    const oversized = new ArrayBuffer(65 * 1024 * 1024)
    const { client, urls } = harness((url) => {
      const response = renditionResponse('fp-1', 'preview')
      response.arrayBuffer = async () => new URL(url).searchParams.get('frame') === '1' ? oversized : new ArrayBuffer(16)
      return response
    })
    await client.rendition(Q, 'preview', { frame: 0 })
    expect(await client.rendition(Q, 'preview', { frame: 1 })).toMatchObject({ available: true })
    await client.rendition(Q, 'preview', { frame: 0 })
    expect(urls).toHaveLength(2)
    await client.rendition(Q, 'preview', { frame: 1 })
    expect(urls).toHaveLength(3)
  })

  it('isolates element, frame, and window bytes with the same fingerprint and kind', async () => {
    let nextByte = 1
    const { client, urls } = harness(() => new Response(new Uint8Array([nextByte++]).buffer, {
      headers: {
        ETag: '"shared-etag"',
        'X-Dinkster-Fingerprint': 'same-fp',
        'X-Dinkster-Rendition': 'preview',
      },
    }))
    const element = await client.rendition({ ...Q, element: [1] }, 'preview')
    const frame = await client.rendition(Q, 'preview', { frame: 1 })
    const window = await client.rendition(Q, 'preview', { window: { start: 1, duration: 2 } })
    const elementAgain = await client.rendition({ ...Q, element: [1] }, 'preview')
    const frameAgain = await client.rendition(Q, 'preview', { frame: 1 })
    const windowAgain = await client.rendition(Q, 'preview', { window: { start: 1, duration: 2 } })

    expect(urls).toHaveLength(3)
    const byte = (result: Awaited<ReturnType<DinksterValuesClient['rendition']>>): number | undefined =>
      result.available ? new Uint8Array(result.bytes)[0] : undefined
    expect([element, frame, window].map(byte)).toEqual([1, 2, 3])
    expect([elementAgain, frameAgain, windowAgain].map(byte)).toEqual([1, 2, 3])
  })

  it('keeps distinct server ETags for distinct run queries with the same selectors', async () => {
    const { client, urls } = harness((url) => {
      const jobId = new URL(url).searchParams.get('jobId') ?? ''
      return new Response(new TextEncoder().encode(jobId).buffer, {
        headers: {
          ETag: `"etag-${jobId}"`,
          'X-Dinkster-Fingerprint': 'same-fp',
          'X-Dinkster-Rendition': 'png',
        },
      })
    })
    const first = await client.rendition({ ...Q, jobId: 'one' }, 'png')
    const second = await client.rendition({ ...Q, jobId: 'two' }, 'png')
    expect(urls).toHaveLength(2)
    expect(first).toMatchObject({ available: true, etag: '"etag-one"' })
    expect(second).toMatchObject({ available: true, etag: '"etag-two"' })
    if (first.available && second.available) expect(new Uint8Array(first.bytes)).not.toEqual(new Uint8Array(second.bytes))
  })

  it('preserves color transform metadata on reads and cache hits without changing bytes', async () => {
    const { client, urls } = harness(() => new Response(PNG.slice().buffer, {
      headers: {
        ETag: '"color-v1"',
        'X-Dinkster-Fingerprint': 'fp-color',
        'X-Dinkster-Rendition': 'png',
        'X-Dinkster-Color-Transform': 'linear-srgb-to-srgb',
      },
    }))
    const first = await client.rendition(Q, 'png')
    const second = await client.rendition(Q, 'png')
    expect(urls).toHaveLength(1)
    expect(second).toEqual(first)
    expect(second).toMatchObject({ available: true, etag: '"color-v1"', colorTransform: 'linear-srgb-to-srgb' })
    if (second.available) expect(new Uint8Array(second.bytes)).toEqual(PNG)
  })

  it('does not alias distinct jobs or outputs', async () => {
    const { client, urls } = harness((url) => {
      const u = new URL(url)
      return renditionResponse(`fp-${u.searchParams.get('jobId')}-${u.searchParams.get('outputId')}`, 'png')
    })
    const a = await client.rendition({ ...Q, jobId: 'job-a' }, 'png')
    const b = await client.rendition({ ...Q, jobId: 'job-b' }, 'png')
    const c = await client.rendition({ ...Q, jobId: 'job-a', outputId: 'mask' }, 'png')
    expect(urls).toHaveLength(3)
    if (a.available && b.available && c.available) {
      expect(a.fingerprint).toBe('fp-job-a-image')
      expect(b.fingerprint).toBe('fp-job-b-image')
      expect(c.fingerprint).toBe('fp-job-a-mask')
    } else {
      expect.unreachable('all three renditions should be available')
    }
  })

  it('preserves sampled waveform and color provenance verbatim on reads and cache hits', async () => {
    const colorTransform = 'PQ-to-sRGB; reinhard; reference-display,HLG-to-sRGB; reinhard; reference-display'
    const { client, urls } = harness(() => new Response(PNG.slice().buffer, {
      headers: {
        ETag: '"metadata"',
        'X-Dinkster-Color-Transform': colorTransform,
        'X-Dinkster-Source-Transfer': '16,18',
        'X-Dinkster-Preview-Color-Space': 'sRGB',
        'X-Dinkster-Waveform': 'sampled-peak',
      },
    }))
    const first = await client.rendition(Q, 'waveform')
    expect(await client.rendition(Q, 'waveform')).toEqual(first)
    expect(first).toMatchObject({ available: true, colorTransform, sourceTransfer: '16,18', previewColorSpace: 'sRGB', waveform: 'sampled-peak' })
    expect(urls).toHaveLength(1)
  })

  it('does not infer transforms or sampled waveform metadata from absent headers', async () => {
    const { client } = harness(() => renditionResponse('fp-1', 'png'))
    const result = await client.rendition(Q, 'png')
    for (const key of ['colorTransform', 'sourceTransfer', 'previewColorSpace', 'waveform']) expect(result).not.toHaveProperty(key)
  })

  it.each([[], ['png', 'waveform', 'pack-kind']])('preserves kind-only no-rendition refusals: %j', async (...kinds) => {
    const { client, urls } = harness(() => jsonResponse(406, {
      available: false, reason: 'no-rendition', error: 'unknown kind', renditions: kinds,
    }))
    const expected = { available: false, reason: 'no-rendition', status: 406, error: 'unknown kind', renditionKinds: kinds }
    expect(await client.peek(Q)).toEqual(expected)
    expect(await client.rendition(Q, 'missing')).toEqual(expected)
    expect(urls).toHaveLength(2)
  })

  it('returns structured refusals for rendition errors (no-rendition list preserved)', async () => {
    const body = {
      available: false,
      reason: 'no-rendition',
      error: 'unknown kind',
      renditions: [{ kind: 'png', mime: 'image/png', default: true }],
    }
    const { client } = harness(() => jsonResponse(406, body))
    const res = await client.rendition(Q, 'jpeg')
    expect(res.available).toBe(false)
    if (!res.available) {
      expect(res.reason).toBe('no-rendition')
      expect(res.renditions?.map((r) => r.kind)).toEqual(['png'])
    }
  })

  it.each([
    [400, 'invalid-rendition'],
    [406, 'unavailable-rendition'],
    [404, 'bad-element'],
  ])('preserves published rendition refusal %i %s', async (status, reason) => {
    const { client } = harness(() => jsonResponse(status, { available: false, reason, error: reason }))
    expect(await client.rendition(Q, 'pack-kind')).toEqual({ available: false, reason, status, error: reason })
  })

  it('never caches a response without a fingerprint header', async () => {
    const { client, urls } = harness(
      () => new Response(PNG.slice().buffer, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    )
    await client.rendition(Q, 'png')
    await client.rendition(Q, 'png')
    expect(urls).toHaveLength(2) // no fingerprint -> no immutable identity -> refetch
  })

  it('returns aborted before fetch and before a cache hit', async () => {
    const { client, urls } = harness(() => renditionResponse('fp-1', 'png'))
    const preaborted = new AbortController()
    preaborted.abort()
    expect(await client.rendition(Q, 'png', { signal: preaborted.signal }))
      .toEqual({ available: false, reason: 'aborted', status: 0, error: 'request aborted' })
    expect(urls).toHaveLength(0)

    await client.rendition(Q, 'png')
    expect(await client.rendition(Q, 'png', { signal: preaborted.signal }))
      .toEqual({ available: false, reason: 'aborted', status: 0, error: 'request aborted' })
    expect(urls).toHaveLength(1)
  })

  it('passes signals to fetch and structures fetch aborts and failures', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    const aborting = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async (_url, init) => {
        receivedSignal = init?.signal
        controller.abort()
        throw new DOMException('stopped', 'AbortError')
      },
    })
    expect(await aborting.rendition(Q, 'png', { signal: controller.signal }))
      .toMatchObject({ available: false, reason: 'aborted', status: 0 })
    expect(receivedSignal).toBe(controller.signal)

    const failing = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => { throw new Error('offline') },
    })
    expect(await failing.rendition(Q, 'png'))
      .toEqual({ available: false, reason: 'http-error', status: 0, error: 'offline' })
  })

  it('structures response body aborts and failures and never caches them', async () => {
    const controller = new AbortController()
    let calls = 0
    const client = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        calls++
        const response = renditionResponse('fp-1', 'png')
        if (calls === 1) {
          Object.defineProperty(response, 'arrayBuffer', { value: async () => {
            controller.abort()
            throw new DOMException('stopped', 'AbortError')
          } })
        }
        return response
      },
    })
    expect(await client.rendition(Q, 'png', { signal: controller.signal }))
      .toMatchObject({ available: false, reason: 'aborted', status: 0 })
    expect(await client.rendition(Q, 'png')).toMatchObject({ available: true })
    expect(calls).toBe(2)

    const failing = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        const response = renditionResponse('fp-1', 'png')
        Object.defineProperty(response, 'arrayBuffer', { value: async () => { throw new Error('stream reset') } })
        return response
      },
    })
    expect(await failing.rendition(Q, 'png'))
      .toEqual({ available: false, reason: 'http-error', status: 0, error: 'stream reset' })
  })
})

describe('DinksterConnection.values()', () => {
  it('shares the connection identity (baseUrl + clientId) and is a stable instance', async () => {
    const urls: string[] = []
    const fetchFn: FetchLike = async (url) => {
      urls.push(url)
      return jsonResponse(200, OK_SCALAR)
    }
    const conn = new DinksterConnection({
      id: asConnectionId('c0'),
      baseUrl: 'http://backend',
      clientId: 'session-7',
      fetchFn,
      webSocketFactory: () => {
        throw new Error('no ws in this test')
      },
    })
    expect(conn.values()).toBe(conn.values())
    await conn.values().peek(Q)
    const u = new URL(urls[0]!)
    expect(u.origin).toBe('http://backend')
    expect(u.pathname).toBe('/api/values')
    expect(u.searchParams.get('clientId')).toBe('session-7')
  })
})

describe('imageAssetRefsOf', () => {
  const digest = `blake3:${'d'.repeat(64)}`
  const asset = (over?: Record<string, unknown>) => ({
    typeId: 'dinkster.asset',
    fingerprint: digest,
    meta: { digest, mediaType: 'image/png', name: 'out.png', ...over },
  })

  it('extracts a single image asset with its name', () => {
    expect(imageAssetRefsOf(asset())).toEqual([{ digest, mediaType: 'image/png', name: 'out.png' }])
  })

  it('recognizes typed-asset stamps (asset<comfy.IMAGE>), incl. inside a typed list', () => {
    // Since the backend's declaration migration (72c0719), save_image
    // outputs stamp asset<comfy.IMAGE> instead of the bare atom - the
    // exact live job-result shape the outputs panel renders.
    expect(imageAssetRefsOf({ ...asset(), typeId: 'asset<comfy.IMAGE>' }))
      .toEqual([{ digest, mediaType: 'image/png', name: 'out.png' }])
    const list = {
      typeId: 'list<asset<comfy.IMAGE>>',
      fingerprint: 'fp-list',
      length: 1,
      elements: [{ ...asset(), typeId: 'asset<comfy.IMAGE>' }],
    }
    expect(imageAssetRefsOf(list).map((r) => r.digest)).toEqual([digest])
    // Malformed near-misses stay rejected: the atom grammar owns the check.
    expect(imageAssetRefsOf({ ...asset(), typeId: 'asset<comfy.IMAGE' })).toEqual([])
  })

  it('recurses into list elements and dedupes by digest', () => {
    const list = {
      typeId: 'list<dinkster.asset>',
      fingerprint: 'fp-list',
      length: 3,
      elements: [asset(), asset(), asset({ digest: `blake3:${'e'.repeat(64)}` })],
    }
    expect(imageAssetRefsOf(list).map((r) => r.digest)).toEqual([digest, `blake3:${'e'.repeat(64)}`])
  })

  it('skips non-image media types, missing digests, and non-asset types', () => {
    expect(imageAssetRefsOf(asset({ mediaType: 'application/json' }))).toEqual([])
    expect(imageAssetRefsOf({ typeId: 'dinkster.asset', fingerprint: 'x', meta: { mediaType: 'image/png' } })).toEqual([])
    expect(imageAssetRefsOf({ typeId: 'comfy.IMAGE', fingerprint: 'x', meta: { digest, mediaType: 'image/png' } })).toEqual([])
  })

  it('tolerates raw non-descriptor JSON', () => {
    expect(imageAssetRefsOf(undefined)).toEqual([])
    expect(imageAssetRefsOf('scalar')).toEqual([])
    expect(imageAssetRefsOf([1, 2])).toEqual([])
    expect(imageAssetRefsOf({ elements: 'nope' })).toEqual([])
  })

  it('rejects malformed digests (only blake3:<64 hex> keys a fetch)', () => {
    expect(imageAssetRefsOf(asset({ digest: 'blake3:short' }))).toEqual([])
    expect(imageAssetRefsOf(asset({ digest: `sha256:${'d'.repeat(64)}` }))).toEqual([])
    expect(imageAssetRefsOf(asset({ digest: `blake3:${'D'.repeat(64)}` }))).toEqual([])
    expect(imageAssetRefsOf(asset({ digest: `blake3:${'d'.repeat(64)}/../evil` }))).toEqual([])
  })

  it('terminates on cyclic in-memory descriptors', () => {
    const cyclic: Record<string, unknown> = { typeId: 'list<dinkster.asset>', elements: [asset()] }
    ;(cyclic['elements'] as unknown[]).push(cyclic)
    expect(imageAssetRefsOf(cyclic).map((r) => r.digest)).toEqual([digest])
  })

  it('handles absurdly deep nesting without overflowing', () => {
    let node: unknown = asset()
    for (let i = 0; i < 100_000; i++) node = { typeId: 'list<dinkster.asset>', elements: [node] }
    expect(imageAssetRefsOf(node).map((r) => r.digest)).toEqual([digest])
  })
})
