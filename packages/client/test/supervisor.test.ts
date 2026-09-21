/**
 * Supervisor status client tests: probe trichotomy (status/absent/
 * unreachable), strict-enough status parsing, restart outcomes, and the
 * 503 engine-not-ready gate surfacing as EngineNotReadyError from
 * DinksterConnection.fetchSchemas.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId } from '@dinkster/core'
import {
  DinksterConnection,
  EngineNotReadyError,
  parseSupervisorStatus,
  probeSupervisorStatus,
  restartSupervisorEngine,
  type FetchLike,
} from '../src/index.js'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('parseSupervisorStatus', () => {
  it('parses the full contract shape', () => {
    const status = parseSupervisorStatus({
      protocol: 1,
      state: 'ready',
      detail: 'engine healthy',
      engine: { pid: 42 },
      progress: { done: 2, total: 5, phase: 'loading packs' },
    })
    expect(status).toEqual({
      protocol: 1,
      state: 'ready',
      detail: 'engine healthy',
      engine: { pid: 42 },
      progress: { done: 2, total: 5, phase: 'loading packs' },
    })
  })

  it('omits optional fields rather than carrying undefined keys', () => {
    const status = parseSupervisorStatus({ protocol: 1, state: 'starting' })
    expect(status).toEqual({ protocol: 1, state: 'starting' })
    expect(status && 'detail' in status).toBe(false)
    expect(status && 'progress' in status).toBe(false)
  })

  it('rejects wrong shapes without throwing', () => {
    expect(parseSupervisorStatus(undefined)).toBeUndefined()
    expect(parseSupervisorStatus('ready')).toBeUndefined()
    expect(parseSupervisorStatus({ state: 'ready' })).toBeUndefined() // no protocol
    expect(parseSupervisorStatus({ protocol: 1, state: 'exploded' })).toBeUndefined()
  })

  it('drops a malformed progress block but keeps the status', () => {
    const status = parseSupervisorStatus({
      protocol: 1,
      state: 'ready',
      progress: { done: 'two', total: 5 },
    })
    expect(status).toEqual({ protocol: 1, state: 'ready' })
  })
})

describe('probeSupervisorStatus', () => {
  it('returns the status when a supervisor answers', async () => {
    const fetchFn: FetchLike = async (url) => {
      expect(url).toBe('http://test/supervisor/status')
      return jsonResponse(200, { protocol: 1, state: 'starting', detail: 'spawning engine' })
    }
    const probe = await probeSupervisorStatus('http://test', fetchFn)
    expect(probe).toEqual({
      kind: 'status',
      status: { protocol: 1, state: 'starting', detail: 'spawning engine' },
    })
  })

  it('reports absent on 404 (standalone dinkster-serve)', async () => {
    const probe = await probeSupervisorStatus('http://test', async () =>
      jsonResponse(404, { error: 'not found' }),
    )
    expect(probe).toEqual({ kind: 'absent' })
  })

  it('FR-1 a transient server failure is unreachable, never absent (the poll must not stop)', async () => {
    for (const status of [500, 503, 401]) {
      const probe = await probeSupervisorStatus('http://test', async () =>
        jsonResponse(status, { error: 'broken' }),
      )
      expect(probe).toEqual({
        kind: 'unreachable',
        error: `GET /supervisor/status failed: ${status}`,
      })
    }
  })

  it('reports absent on a malformed body', async () => {
    const probe = await probeSupervisorStatus('http://test', async () =>
      jsonResponse(200, { hello: 'world' }),
    )
    expect(probe).toEqual({ kind: 'absent' })
  })

  it('reports unreachable on a network failure', async () => {
    const probe = await probeSupervisorStatus('http://test', async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(probe).toEqual({ kind: 'unreachable', error: 'ECONNREFUSED' })
  })
})

describe('restartSupervisorEngine', () => {
  it('posts to /supervisor/engine/restart and reports ok', async () => {
    let posted: string | undefined
    const fetchFn: FetchLike = async (url, init) => {
      posted = `${init?.method} ${url}`
      return jsonResponse(200, {})
    }
    expect(await restartSupervisorEngine('http://test', fetchFn)).toEqual({ ok: true })
    expect(posted).toBe('POST http://test/supervisor/engine/restart')
  })

  it('maps the 409 restart-unavailable body to ok: false', async () => {
    const result = await restartSupervisorEngine('http://test', async () =>
      jsonResponse(409, { error: 'restart-unavailable' }),
    )
    expect(result).toEqual({ ok: false, error: 'restart-unavailable' })
  })

  it('maps transport failure to ok: false', async () => {
    const result = await restartSupervisorEngine('http://test', async () => {
      throw new Error('boom')
    })
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})

describe('fetchSchemas behind a pre-ready supervisor', () => {
  it('throws EngineNotReadyError on the 503 engine-not-ready gate', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(503, { error: 'engine-not-ready', state: 'starting', status: '/supervisor/status' })
    const conn = new DinksterConnection({
      id: asConnectionId('c0'),
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn,
    })
    const error = await conn.fetchSchemas().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EngineNotReadyError)
    expect((error as EngineNotReadyError).state).toBe('starting')
  })

  it('keeps a plain 503 (no gate body) as a generic fetch error', async () => {
    const conn = new DinksterConnection({
      id: asConnectionId('c0'),
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn: async () => new Response('overloaded', { status: 503 }),
    })
    const error = await conn.fetchSchemas().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(EngineNotReadyError)
    expect(String(error)).toContain('503')
  })
})
