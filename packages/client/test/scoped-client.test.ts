/**
 * ScopedClient: the only network surface widget/extension code gets.
 * Guards: same-origin route validation, request dedupe, TTL cache,
 * explicit refresh bypass, and failure-not-cached retry semantics.
 */
import { describe, expect, it } from 'vitest'
import { createScopedClient } from '../src/scoped-client.js'

interface Call {
  readonly url: string
}

interface RemoteChoicesClient {
  remoteChoices(
    route: string,
    options?: {
      readonly refresh?: boolean
      readonly signal?: AbortSignal
      readonly maxRetries?: number
      readonly timeoutMs?: number
      readonly refreshMs?: number
    },
  ): Promise<readonly string[]>
  setRemoteChoicePartition(partition: {
    readonly principalGeneration: number
    readonly schemaEpoch: number
  }): void
  remoteChoiceAuthority(): number
  dispose(): void
}

const remoteClient = (client: ReturnType<typeof createScopedClient>): RemoteChoicesClient =>
  client as unknown as RemoteChoicesClient

const choicesResponse = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

function harness(opts?: { ttlMs?: number; failFirst?: number; status?: number }) {
  const calls: Call[] = []
  let now = 0
  let failures = opts?.failFirst ?? 0
  const client = createScopedClient({
    baseUrl: 'http://backend',
    ttlMs: opts?.ttlMs ?? 1000,
    clock: () => now,
    fetchFn: async (url) => {
      calls.push({ url })
      if (failures > 0) {
        failures--
        throw new Error('network down')
      }
      const status = opts?.status ?? 200
      return new Response(JSON.stringify({ url, seq: calls.length }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { client, calls, advance: (ms: number) => (now += ms) }
}

describe('scoped client', () => {
  it('CL6 stale normal request cannot overwrite a fresher refresh', async () => {
    const resolvers: ((value: Response) => void)[] = []
    const client = createScopedClient({ baseUrl: '', fetchFn: () => new Promise((resolve) => resolvers.push(resolve)) })
    const stale = client.query('/r', {})
    const fresh = client.query('/r', {}, { refresh: true })
    resolvers[1]!(new Response(JSON.stringify('fresh')))
    await expect(fresh).resolves.toBe('fresh')
    resolvers[0]!(new Response(JSON.stringify('stale')))
    await expect(stale).resolves.toBe('stale')
    await expect(client.query('/r', {})).resolves.toBe('fresh')
    expect(resolvers).toHaveLength(2)
  })

  it('builds the url from base + route + params', async () => {
    const { client, calls } = harness()
    await client.query('/api/models', { folder: 'loras', page: 2 })
    expect(calls[0]!.url).toBe('http://backend/api/models?folder=loras&page=2')
  })

  it('deduplicates concurrent requests for the same route', async () => {
    const { client, calls } = harness()
    const [a, b] = await Promise.all([client.query('/r', {}), client.query('/r', {})])
    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('serves cache hits until the ttl expires', async () => {
    const { client, calls, advance } = harness({ ttlMs: 100 })
    await client.query('/r', {})
    advance(99)
    await client.query('/r', {})
    expect(calls).toHaveLength(1)
    advance(2)
    await client.query('/r', {})
    expect(calls).toHaveLength(2)
  })

  it('refresh bypasses the cache and re-fetches', async () => {
    const { client, calls } = harness()
    await client.query('/r', {})
    const refreshed = await client.query('/r', {}, { refresh: true })
    expect(calls).toHaveLength(2)
    expect((refreshed as { seq: number }).seq).toBe(2)
    // The refreshed value replaces the cached one.
    const cached = await client.query('/r', {})
    expect(calls).toHaveLength(2)
    expect((cached as { seq: number }).seq).toBe(2)
  })

  it('does not cache failures: the next query retries', async () => {
    const { client, calls } = harness({ failFirst: 1 })
    await expect(client.query('/r', {})).rejects.toThrow('network down')
    const ok = await client.query('/r', {})
    expect(calls).toHaveLength(2)
    expect((ok as { seq: number }).seq).toBe(2)
  })

  it('rejects non-OK responses without caching them', async () => {
    const { client, calls } = harness({ status: 500 })
    await expect(client.query('/r', {})).rejects.toThrow('HTTP 500')
    await expect(client.query('/r', {})).rejects.toThrow('HTTP 500')
    expect(calls).toHaveLength(2)
  })

  it('rejects routes that are not same-origin absolute paths', async () => {
    const { client, calls } = harness()
    await expect(client.query('relative', {})).rejects.toThrow('same-origin absolute path')
    // Protocol-relative urls ('//host/x') would escape the origin.
    await expect(client.query('//evil.example/x', {})).rejects.toThrow('same-origin absolute path')
    expect(() => client.mediaUrl('//evil.example/x', {})).toThrow('same-origin absolute path')
    expect(calls).toHaveLength(0)
  })

  it('mediaUrl resolves without fetching', () => {
    const { client, calls } = harness()
    const url = client.mediaUrl('/view', { filename: 'a.png', type: 'output' })
    expect(url).toBe('http://backend/view?filename=a.png&type=output')
    expect(calls).toHaveLength(0)
  })
})

describe('remote choice controller editing implementation policy', () => {
  it('uses the backend-owned fetch with redirect error and rejects unregistered routes before fetch', async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const client = remoteClient(createScopedClient({
      baseUrl: 'http://backend',
      fetchFn: async (url, init) => {
        calls.push({ url, init })
        return choicesResponse(['alpha'])
      },
    }))

    await expect(client.remoteChoices('https://evil.example/choices')).rejects.toThrow('registered remote choices route')
    await expect(client.remoteChoices('/api/other/not-choices')).rejects.toThrow('registered remote choices route')
    await expect(client.remoteChoices('/api/choices/models')).resolves.toEqual(['alpha'])
    expect(calls).toEqual([{
      url: 'http://backend/api/choices/models',
      init: expect.objectContaining({ redirect: 'error' }),
    }])
  })

  it.each([
    ['non-array JSON', { nope: true }, 'JSON array'],
    ['non-string entry', ['ok', 7], 'strings'],
    ['empty string', [''], 'nonempty'],
    ['duplicate string', ['same', 'same'], 'unique'],
    ['NUL', ['bad\u0000value'], 'NUL'],
    ['lone high surrogate', ['bad\ud800value'], 'surrogate'],
    ['lone low surrogate', ['bad\udfffvalue'], 'surrogate'],
    ['too many entries', Array.from({ length: 10_001 }, (_, index) => `v${index}`), '10000'],
    ['oversized entry', ['x'.repeat(4097)], '4096'],
  ])('permanently rejects %s', async (_name, body, message) => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return choicesResponse(body)
      },
    }))
    await expect(client.remoteChoices('/api/choices/test')).rejects.toThrow(message)
    expect(calls).toBe(1)
  })

  it('accepts an empty list and preserves provider order including multibyte UTF-8 strings', async () => {
    const accented = String.fromCodePoint(0xe9)
    const payloads: unknown[] = [[], ['zeta', `two bytes: ${accented}`, 'alpha']]
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => choicesResponse(payloads.shift()),
    }))
    await expect(client.remoteChoices('/api/choices/empty', { refresh: true })).resolves.toEqual([])
    await expect(client.remoteChoices('/api/choices/ordered', { refresh: true })).resolves.toEqual([
      'zeta',
      `two bytes: ${accented}`,
      'alpha',
    ])
  })

  it('accepts exactly 4096 UTF-8 bytes and rejects 4097 UTF-8 bytes', async () => {
    const exact = String.fromCodePoint(0xe9).repeat(2048)
    const tooLarge = `${exact}x`
    const payloads: unknown[] = [[exact], [tooLarge]]
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => choicesResponse(payloads.shift()),
    }))
    await expect(client.remoteChoices('/api/choices/exact', { refresh: true })).resolves.toEqual([exact])
    await expect(client.remoteChoices('/api/choices/large', { refresh: true })).rejects.toThrow('4096')
  })

  it('accepts exactly 2097152 body bytes and rejects a 2097153 byte body before JSON parsing', async () => {
    const exactBody = `["${'x'.repeat(2_097_148)}"]`
    const oversizedBody = `${exactBody} `
    const bodies = [exactBody, oversizedBody]
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => new Response(bodies.shift(), { status: 200 }),
    }))
    await expect(client.remoteChoices('/api/choices/exact-body', { refresh: true })).rejects.toThrow('4096')
    await expect(client.remoteChoices('/api/choices/large-body', { refresh: true })).rejects.toThrow('2097152')
  })

  it('cancels an unbounded response stream as soon as it exceeds the body limit', async () => {
    let calls = 0
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel() {
        cancelled = true
        return Promise.reject(new TypeError('transport cancel failed'))
      },
    })
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return new Response(stream, { status: 200 })
      },
    }))
    await expect(client.remoteChoices('/api/choices/stream-limit')).rejects.toThrow('2097152')
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThanOrEqual(4)
    expect(calls).toBe(1)
  })

  it('rejects streamed overflow without waiting for cancellation to settle', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel: () => new Promise<void>(() => {}),
    })
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => new Response(stream, { status: 200 }),
    }))
    await expect(client.remoteChoices('/api/choices/nonsettling-cancel')).rejects.toThrow('2097152')
  })

  it.each([
    ['invalid UTF-8', new Uint8Array([0xff]), 'UTF-8'],
    ['invalid JSON', new TextEncoder().encode('["unterminated"'), 'JSON'],
  ])('does not retry %s', async (_name, bytes, message) => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return new Response(bytes, { status: 200 })
      },
    }))
    await expect(client.remoteChoices('/api/choices/bad')).rejects.toThrow(message)
    expect(calls).toBe(1)
  })

  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i up to the named default cap', async (status) => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return calls < 3 ? new Response('', { status }) : choicesResponse(['ok'])
      },
      sleep: async () => {},
      random: () => 0,
    } as Parameters<typeof createScopedClient>[0]))
    await expect(client.remoteChoices('/api/choices/retry')).resolves.toEqual(['ok'])
    expect(calls).toBe(3)
  })

  it.each([400, 401, 403, 404, 409, 422, 501])('never retries permanent HTTP %i', async (status) => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return new Response('', { status })
      },
      sleep: async () => {},
    } as Parameters<typeof createScopedClient>[0]))
    await expect(client.remoteChoices('/api/choices/permanent')).rejects.toThrow(`HTTP ${status}`)
    expect(calls).toBe(1)
  })

  it('retries network failures with full-jitter exponential delays and honors bounded Retry-After', async () => {
    let calls = 0
    const delays: number[] = []
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        if (calls === 1) throw new TypeError('offline')
        if (calls === 2) return new Response('', { status: 429, headers: { 'retry-after': '99' } })
        return choicesResponse(['ok'])
      },
      sleep: async (ms: number) => { delays.push(ms) },
      random: () => 0.5,
    } as Parameters<typeof createScopedClient>[0]))
    await expect(client.remoteChoices('/api/choices/retry')).resolves.toEqual(['ok'])
    expect(delays).toEqual([125, 2000])
  })

  it('retries a network TypeError while consuming the response body', async () => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        if (calls === 1) {
          return new Response(new ReadableStream({
            pull(controller) {
              controller.error(new TypeError('body disconnected'))
            },
          }), { status: 200 })
        }
        return choicesResponse(['ok'])
      },
      sleep: async () => {},
      random: () => 0,
    }))
    await expect(client.remoteChoices('/api/choices/body-retry')).resolves.toEqual(['ok'])
    expect(calls).toBe(2)
  })

  it('uses a parameterized maxRetries without changing the default constant', async () => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        throw new TypeError('offline')
      },
      sleep: async () => {},
    } as Parameters<typeof createScopedClient>[0]))
    await expect(client.remoteChoices('/api/choices/no-retry', { maxRetries: 0 })).rejects.toThrow('offline')
    expect(calls).toBe(1)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('rejects invalid maxRetries %s before fetch', async (maxRetries) => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return choicesResponse(['unexpected'])
      },
    }))
    await expect(client.remoteChoices('/api/choices/retries', { maxRetries })).rejects.toThrow('nonnegative integer')
    expect(calls).toBe(0)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 60_001, 1.5])('rejects invalid timeoutMs %s before fetch', async (timeoutMs) => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        return choicesResponse(['unexpected'])
      },
    }))
    await expect(client.remoteChoices('/api/choices/timeout', { timeoutMs })).rejects.toThrow('timeoutMs')
    expect(calls).toBe(0)
  })

  it('retries per-attempt timeout without masking a caller abort', async () => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async (_url, init) => {
        calls += 1
        if (calls === 1) return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('normalized abort', 'AbortError')), { once: true })
        })
        return choicesResponse(['ok'])
      },
      sleep: async () => {},
      random: () => 0,
    }))
    await expect(client.remoteChoices('/api/choices/timeout-retry', { timeoutMs: 1, maxRetries: 1 })).resolves.toEqual(['ok'])
    expect(calls).toBe(2)

    const caller = new AbortController()
    const pending = client.remoteChoices('/api/choices/caller-abort', { timeoutMs: 60_000, signal: caller.signal })
    caller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('retries a timeout normalized to AbortError while consuming the response body', async () => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async (_url, init) => {
        calls += 1
        if (calls > 1) return choicesResponse(['ok'])
        let streamController!: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { streamController = controller },
        })
        init?.signal?.addEventListener('abort', () => {
          streamController.error(new DOMException('normalized body abort', 'AbortError'))
        }, { once: true })
        return new Response(stream, { status: 200 })
      },
      sleep: async () => {},
      random: () => 0,
    }))
    await expect(client.remoteChoices('/api/choices/body-timeout', { timeoutMs: 1, maxRetries: 1 })).resolves.toEqual(['ok'])
    expect(calls).toBe(2)
  })

  it('never retries abort and releases a shared inflight only when every consumer aborts', async () => {
    let calls = 0
    let sharedSignal: AbortSignal | undefined
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async (_url, init) => {
        calls += 1
        sharedSignal = init?.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => {
          sharedSignal?.addEventListener('abort', () => reject(sharedSignal?.reason), { once: true })
        })
      },
      sleep: async () => {},
    } as Parameters<typeof createScopedClient>[0]))
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = client.remoteChoices('/api/choices/shared', { signal: firstAbort.signal })
    const second = client.remoteChoices('/api/choices/shared', { signal: secondAbort.signal })
    firstAbort.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)
    secondAbort.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(true)
    expect(calls).toBe(1)
  })

  it('partitions cache by principal generation and schema epoch while persisting until invalidation', async () => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => choicesResponse([`call-${++calls}`]),
    }))
    expect(client.remoteChoiceAuthority()).toBe(0)
    client.setRemoteChoicePartition({ principalGeneration: 1, schemaEpoch: 10 })
    expect(client.remoteChoiceAuthority()).toBe(1)
    await expect(client.remoteChoices('/api/choices/models')).resolves.toEqual(['call-1'])
    await expect(client.remoteChoices('/api/choices/models')).resolves.toEqual(['call-1'])
    client.setRemoteChoicePartition({ principalGeneration: 2, schemaEpoch: 10 })
    await expect(client.remoteChoices('/api/choices/models')).resolves.toEqual(['call-2'])
    client.setRemoteChoicePartition({ principalGeneration: 2, schemaEpoch: 11 })
    await expect(client.remoteChoices('/api/choices/models')).resolves.toEqual(['call-3'])
    expect(calls).toBe(3)
    expect(client.remoteChoiceAuthority()).toBe(3)
  })

  it('expires a cached choice list only on the next positive-TTL demand', async () => {
    let now = 100
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '', clock: () => now,
      fetchFn: async () => choicesResponse([`call-${++calls}`]),
    }))
    await expect(client.remoteChoices('/api/choices/ttl', { refreshMs: 50 })).resolves.toEqual(['call-1'])
    now += 49
    await expect(client.remoteChoices('/api/choices/ttl', { refreshMs: 50 })).resolves.toEqual(['call-1'])
    now += 1
    await expect(client.remoteChoices('/api/choices/ttl', { refreshMs: 50 })).resolves.toEqual(['call-2'])
    await expect(client.remoteChoices('/api/choices/ttl', { refreshMs: 0 })).resolves.toEqual(['call-2'])
    expect(calls).toBe(2)
  })

  it('starts fresh immediately after the last consumer aborts shared inflight work', async () => {
    let calls = 0
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async (_url, init) => {
        calls += 1
        if (calls === 2) return choicesResponse(['fresh'])
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      },
    }))
    const abort = new AbortController()
    const abandoned = client.remoteChoices('/api/choices/rejoin', { signal: abort.signal })
    abort.abort()
    const fresh = client.remoteChoices('/api/choices/rejoin')
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    await expect(fresh).resolves.toEqual(['fresh'])
    expect(calls).toBe(2)
  })

  it('never publishes an abandoned response when transport ignores abort', async () => {
    let calls = 0
    let resolveOld!: (response: Response) => void
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => {
        calls += 1
        if (calls === 1) return await new Promise<Response>((resolve) => { resolveOld = resolve })
        return choicesResponse(['fresh'])
      },
    }))
    const abort = new AbortController()
    const abandoned = client.remoteChoices('/api/choices/ignored-abort', { signal: abort.signal })
    abort.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    resolveOld(choicesResponse(['abandoned']))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await expect(client.remoteChoices('/api/choices/ignored-abort')).resolves.toEqual(['fresh'])
    expect(calls).toBe(2)
  })

  it('manual refresh supersedes older generations and stale completion never replaces the fresh cache', async () => {
    const resolvers: ((response: Response) => void)[] = []
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async () => await new Promise<Response>((resolve) => resolvers.push(resolve)),
    }))
    const old = client.remoteChoices('/api/choices/models')
    const fresh = client.remoteChoices('/api/choices/models', { refresh: true })
    resolvers[1]!(choicesResponse(['fresh']))
    await expect(fresh).resolves.toEqual(['fresh'])
    resolvers[0]!(choicesResponse(['old']))
    await expect(old).rejects.toThrow('superseded')
    await expect(client.remoteChoices('/api/choices/models')).resolves.toEqual(['fresh'])
    expect(resolvers).toHaveLength(2)
  })

  it('clears and aborts all choice partitions on disposal', async () => {
    let signal: AbortSignal | undefined
    const client = remoteClient(createScopedClient({
      baseUrl: '',
      fetchFn: async (_url, init) => {
        signal = init?.signal ?? undefined
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
        })
      },
    }))
    const pending = client.remoteChoices('/api/choices/models')
    client.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
  })
})
