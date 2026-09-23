/**
 * Protocol discovery tests: the probe priority (/supervisor/status ->
 * /api/nodes -> /system_stats), each conclusive match, the SPA-HTML routing
 * fallthrough case, and the unreachable/unrecognized split.
 */
import { describe, expect, it } from 'vitest'
import { discoverBackend, type FetchLike } from '../src/index.js'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const html = (): Response =>
  new Response('<!doctype html><html><body>app</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  })

/** Route fetches by path suffix; unrouted paths get `fallback` (or throw). */
const fakeFetch = (
  routes: Record<string, () => Response>,
  fallback?: () => Response,
): FetchLike => {
  return (url) => {
    const path = url.split('?')[0]!
    for (const [suffix, make] of Object.entries(routes)) {
      if (path.endsWith(suffix)) return Promise.resolve(make())
    }
    if (fallback) return Promise.resolve(fallback())
    return Promise.reject(new Error(`connect ECONNREFUSED (${url})`))
  }
}

const nativeNodes = () =>
  json(200, { schemaVersion: 1, nodes: {}, dinkster: { version: '0.1', schemaWire: 1 } })

describe('discoverBackend', () => {
  it('identifies a supervised Dinkster from /supervisor/status', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(200, { protocol: 1, state: 'starting' }),
    })
    expect(await discoverBackend('http://host:3639', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: true,
    })
  })

  it('identifies a standalone native engine from /api/nodes', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(404, { error: 'not found' }),
      '/api/nodes': nativeNodes,
    })
    expect(await discoverBackend('http://host:3639', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: false,
    })
  })

  it('does not request any v1 endpoint when legacy probing is disabled', async () => {
    const seen: string[] = []
    const fetchFn: FetchLike = (url) => {
      seen.push(url)
      return Promise.resolve(url.includes('/api/nodes') ? nativeNodes() : json(404, {}))
    }
    expect(await discoverBackend('', { fetchFn, probeV1: false })).toEqual({
      kind: 'dinkster',
      supervised: false,
    })
    expect(seen).toHaveLength(2)
    expect(seen.some((url) => url.includes('/system_stats'))).toBe(false)
  })

  it('requests the nodes catalog without version negotiation', async () => {
    let nodesUrl = ''
    const fetchFn: FetchLike = (url) => {
      if (url.includes('/api/nodes')) {
        nodesUrl = url
        return Promise.resolve(nativeNodes())
      }
      return Promise.resolve(json(404, {}))
    }
    await discoverBackend('http://host', { fetchFn })
    expect(nodesUrl).toBe('http://host/api/nodes')
  })

  it('treats the supervisor 503 engine-not-ready gate on /api/nodes as supervised Dinkster', async () => {
    const fetchFn = fakeFetch({
      // A supervisor whose /supervisor/status is briefly unreachable but
      // whose proxy gate answers: still conclusively Dinkster.
      '/api/nodes': () => json(503, { error: 'engine-not-ready', state: 'starting' }),
    })
    expect(await discoverBackend('http://host', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: true,
    })
  })

  it('identifies a ComfyUI server from /system_stats', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(404, {}),
      '/api/nodes': () => json(404, {}),
      '/system_stats': () =>
        json(200, { system: { os: 'posix', comfyui_version: '0.3.0' }, devices: [{ name: 'cuda' }] }),
    })
    expect(await discoverBackend('http://host:8188', { fetchFn })).toEqual({ kind: 'v1' })
  })

  it('rejects a bare JSON object on /system_stats (no system/devices shape)', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(404, {}),
      '/api/nodes': () => json(404, {}),
      '/system_stats': () => json(200, {}),
    })
    expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
  })

  it('FR-3 rejects array-valued nodes/dinkster/system sections (records only)', async () => {
    // typeof [] === 'object': an unrelated service answering arrays must not
    // be persisted as a Dinkster or v1 backend.
    const arrayNodes = fakeFetch({
      '/supervisor/status': () => json(404, {}),
      '/api/nodes': () => json(200, { nodes: [] }),
      '/system_stats': () => json(404, {}),
    })
    expect((await discoverBackend('http://host', { fetchFn: arrayNodes })).kind).toBe('unrecognized')
    const arraySystem = fakeFetch({
      '/supervisor/status': () => json(404, {}),
      '/api/nodes': () => json(404, {}),
      '/system_stats': () => json(200, { system: [], devices: [] }),
    })
    expect((await discoverBackend('http://host', { fetchFn: arraySystem })).kind).toBe('unrecognized')
  })

  it('rejects partial /system_stats shapes: BOTH system and devices are required', async () => {
    // v1 selection persists a backend, so the check must match the real
    // endpoint (which always emits both), not any JSON that happens to
    // carry one of the keys.
    for (const partial of [{ system: { os: 'posix' } }, { devices: [] }]) {
      const fetchFn = fakeFetch({
        '/supervisor/status': () => json(404, {}),
        '/api/nodes': () => json(404, {}),
        '/system_stats': () => json(200, partial),
      })
      expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
    }
  })

  it('calls out SPA-HTML routing fallthrough as unrecognized, not a protocol', async () => {
    // A dev server answering 200 text/html for every path must match
    // nothing - this is the :5199/api/* fallthrough bug's signature.
    const fetchFn = fakeFetch({}, html)
    const result = await discoverBackend('', { fetchFn })
    expect(result.kind).toBe('unrecognized')
    if (result.kind === 'unrecognized') expect(result.detail).toContain('HTML')
  })

  it('reports arbitrary JSON servers as unrecognized', async () => {
    const fetchFn = fakeFetch({}, () => json(200, { hello: 'world' }))
    expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
  })

  it('reports unreachable when nothing answers, carrying the error detail', async () => {
    const fetchFn = fakeFetch({})
    const result = await discoverBackend('http://down:1', { fetchFn })
    expect(result.kind).toBe('unreachable')
    if (result.kind === 'unreachable') expect(result.detail).toContain('ECONNREFUSED')
  })

  it('is unrecognized (not unreachable) when only some probes fail transport', async () => {
    const fetchFn = fakeFetch({ '/system_stats': () => json(200, [1, 2, 3]) })
    // system_stats answered (an array - wrong shape); others refused.
    expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
  })

  it('strips trailing slashes from the base url', async () => {
    const seen: string[] = []
    const fetchFn: FetchLike = (url) => {
      seen.push(url)
      return Promise.resolve(json(200, { protocol: 1, state: 'ready' }))
    }
    await discoverBackend('http://host:3639///', { fetchFn })
    expect(seen[0]).toBe('http://host:3639/supervisor/status')
  })
})
