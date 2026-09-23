/**
 * CollabHttpConnection: transport mechanics only - route shapes, status-code
 * mapping (409 stale-base vs snapshot-required, 406, 410), WS frame shaping
 * (descriptor-first, op, presence, session_closed), reconnect surfacing, and
 * presence stamping. Envelope VALIDATION is deliberately absent here: the
 * session core owns the trust boundary (shared-session.test.ts), so this
 * suite proves malformed-but-typed frames are forwarded, not swallowed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CollabConnectionEvent } from '@dinkster/core'
import {
  CollabHttpConnection,
  closeCollabSession,
  createCollabSession,
  getCollabSession,
  listCollabSessions,
  type CollabHttpConnectionConfig,
  type FetchLike,
  type WebSocketLike,
} from '../src/index.js'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const descriptor = {
  protocolVersion: 1,
  sessionId: 's1',
  scope: 'local',
  documentId: 'd1',
  revision: 3,
  snapshotRevision: 0,
  createdAt: 123,
}

const serverOp = {
  protocolVersion: 1,
  sessionId: 's1',
  opId: 'op-1',
  actorId: 'alice',
  baseRevision: 3,
  revision: 4,
  patch: [{ op: 'replace', path: ['graphs', 'root', 'label'], value: 'x' }],
  timestamp: 1000,
}

class FakeWS implements WebSocketLike {
  binaryType = ''
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  sent: string[] = []
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
}

function harness(overrides: Partial<CollabHttpConnectionConfig> = {}) {
  const sockets: FakeWS[] = []
  const wsUrls: string[] = []
  const scheduled: (() => void)[] = []
  const events: CollabConnectionEvent[] = []
  const connection = new CollabHttpConnection({
    baseUrl: 'http://test:8765',
    sessionId: 's1',
    actorId: 'alice',
    fetchFn: async () => jsonResponse(500, { error: 'unexpected fetch' }),
    webSocketFactory: (url) => {
      wsUrls.push(url)
      const s = new FakeWS()
      sockets.push(s)
      return s
    },
    scheduleFn: (fn) => {
      scheduled.push(fn)
      return scheduled.length
    },
    cancelFn: () => {},
    ...overrides,
  })
  connection.onEvent((e) => events.push(e))
  return { connection, sockets, wsUrls, scheduled, events }
}

const frame = (ws: FakeWS, payload: unknown): void =>
  ws.onmessage?.({ data: JSON.stringify(payload) })

describe('delegation transport', () => {
  it.each([false, true])('shares one slow retry and resumes pending operations without re-minting (transport failure: %s)', async (transportFailure) => {
    let available = false
    let failProbe = false
    const timers: { run: () => void; delay: number }[] = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (failProbe) { failProbe = false; throw new Error('network unavailable') }
      if (!available) return jsonResponse(403, { error: 'user-session-required' })
      if (init?.method === 'POST') return jsonResponse(200, serverOp)
      if (url.includes('/ops?')) return jsonResponse(200, { ops: [] })
      if (url.endsWith('/snapshot')) return jsonResponse(200, { revision: 3, document: {} })
      return jsonResponse(200, descriptor)
    })
    const onDiagnostic = vi.fn()
    const { connection, events } = harness({ fetchFn, onDiagnostic, scheduleFn: (run, delay) => { const timer = { run, delay }; timers.push(timer); return timer } })
    try {
      const op = { protocolVersion: 1, actorId: 'alice', opId: 'op-1', baseRevision: 3, patch: [] }
      const posting = connection.postOp(op)
      await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledTimes(1))
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ version: 1, type: 'collab.denial', reason: 'user-session-required', retryAfterMs: 30_000 }))
      expect(connection.denial).toBeUndefined()
      const waiting = [connection.fetchSnapshot(), connection.fetchOps(3), connection.putSnapshot(3, {} as never), connection.fetchSession()]
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(timers.map((timer) => timer.delay)).toEqual([30_000])
      failProbe = transportFailure
      timers[0]!.run()
      await vi.waitFor(() => expect(timers).toHaveLength(2))
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(onDiagnostic).toHaveBeenCalledTimes(1)
      available = true
      expect(timers[1]!.delay).toBe(30_000)
      timers[1]!.run()
      await expect(posting).resolves.toEqual({ kind: 'accepted', op: serverOp })
      await Promise.all(waiting)
      expect(fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init?.body)).toEqual([JSON.stringify(op), JSON.stringify(op)])
      expect(events.filter((event) => event.kind === 'denial')).toHaveLength(1)
      expect(fetchFn.mock.calls.some(([url]) => url.includes('/delegations'))).toBe(false)
    } finally { connection.close() }
  })

  it('suspends immediately on the socket reason and close cancels the wait and stale callbacks', async () => {
    const timers: { run: () => void; delay: number }[] = []
    const fetchFn = vi.fn(async () => jsonResponse(200, descriptor))
    const cancelFn = vi.fn()
    const { connection, sockets, events } = harness({ fetchFn, cancelFn, scheduleFn: (run, delay) => { const timer = { run, delay }; timers.push(timer); return timer } })
    sockets[0]!.onopen?.({})
    sockets[0]!.onclose?.({ code: 1008, reason: 'user-session-required' })
    expect(events.map((event) => event.kind)).toEqual(['disconnected', 'denial'])
    expect(timers.map((timer) => timer.delay)).toEqual([30_000])
    expect(fetchFn).not.toHaveBeenCalled()
    const waiting = connection.fetchSnapshot()
    const rejected = expect(waiting).rejects.toThrow('connection closed')
    connection.close()
    await rejected
    expect(cancelFn).toHaveBeenCalledWith(timers[0])
    timers[0]!.run()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it.each([401, 403])('a definitive refusal during slow retry terminates the suspended wait (%s)', async (status) => {
    let refused = false
    const timers: (() => void)[] = []
    const fetchFn = vi.fn(async () => jsonResponse(refused ? status : 403, { error: refused ? 'capability-required' : 'user-session-required' }))
    const { connection, events } = harness({ fetchFn, scheduleFn: (run) => { timers.push(run); return run } })
    const waiting = connection.fetchSnapshot()
    const rejected = expect(waiting).rejects.toMatchObject({ diagnostic: { status, code: 'capability-required' } })
    await vi.waitFor(() => expect(timers).toHaveLength(1))
    refused = true
    timers[0]!()
    await rejected
    expect(connection.denial).toMatchObject({ status, code: 'capability-required' })
    expect(events.filter((event) => event.kind === 'denial')).toHaveLength(2)
    timers[0]!()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    connection.close()
  })
  it('allows a final checkpoint request to finish after an ordinary close', async () => {
    let finish!: (response: Response) => void
    const fetchFn = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve }))
    const { connection } = harness({ fetchFn })
    const checkpoint = connection.putSnapshot(1, {} as never)
    connection.close()
    expect(fetchFn.mock.calls[0]![1]?.signal?.aborted).toBe(false)
    finish(jsonResponse(200, {}))
    await expect(checkpoint).resolves.toEqual({ kind: 'ok' })
  })

  it.each([401, 403])('terminates refused WebSocket tickets (%s) before opening a socket', async (status) => {
    const fetchFn = vi.fn(async () => jsonResponse(status, { error: 'forbidden' }))
    const { connection, sockets, events, scheduled } = harness({ actorKind: 'agent', fetchFn })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ kind: 'denial', diagnostic: { version: 1, operation: 'ws-ticket', status } })
    expect(sockets).toHaveLength(0)
    expect(scheduled).toHaveLength(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    connection.close()
  })

  it('terminates revoked HTTP and socket credentials with the delegation identity', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(403, {
      error: 'delegation-revoked', delegationId: 'delegation-123',
    }))
    const http = harness({ fetchFn })
    await expect(http.connection.fetchSnapshot()).rejects.toMatchObject({
      diagnostic: {
        code: 'delegation-revoked', delegationId: 'delegation-123',
        message: 'Delegation delegation-123: delegation-revoked',
      },
    })
    expect(http.scheduled).toHaveLength(0)
    http.connection.close()

    const socket = harness()
    socket.sockets[0]!.onopen?.({})
    socket.sockets[0]!.onclose?.({ code: 1008, reason: 'delegation-revoked:delegation-456' })
    expect(socket.connection.denial).toMatchObject({
      code: 'delegation-revoked', delegationId: 'delegation-456', operation: 'events',
    })
    expect(socket.scheduled).toHaveLength(0)
    socket.connection.close()
  })

  it.each(['fetchSnapshot', 'fetchOps', 'putSnapshot'] as const)('terminates %s on read/write authorization refusal and retains the diagnostic', async (operation) => {
    const fetchFn = vi.fn(async () => jsonResponse(403, { error: 'capability-required' }))
    const cancelFn = vi.fn()
    const { connection, sockets, events, scheduled } = harness({ fetchFn, cancelFn })
    const call = () => operation === 'fetchSnapshot' ? connection.fetchSnapshot()
      : operation === 'fetchOps' ? connection.fetchOps(0) : connection.putSnapshot(0, {} as never)
    await expect(call()).rejects.toMatchObject({ diagnostic: { version: 1, type: 'collab.denial', status: 403, code: 'capability-required', actorId: 'alice', sessionId: 's1' } })
    expect(connection.denial).not.toHaveProperty('opId')
    expect(events).toEqual([{ kind: 'denial', diagnostic: connection.denial }])
    expect(sockets[0]!.closed).toBe(true)
    await expect(call()).rejects.toMatchObject({ diagnostic: connection.denial })
    for (const callback of scheduled.splice(0)) callback()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    connection.close()
  })

  it('stops a forbidden session probe even when both ticket requests succeed', async () => {
    let finishProbe!: (response: Response) => void
    let finishTicket!: (response: Response) => void
    let tickets = 0
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/ws-ticket')) {
        if (++tickets === 1) return jsonResponse(200, { ticket: 'first' })
        return new Promise<Response>((resolve) => { finishTicket = resolve })
      }
      return new Promise<Response>((resolve) => { finishProbe = resolve })
    })
    const { connection, sockets, events, scheduled } = harness({ actorKind: 'agent', fetchFn })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.onopen?.({})
    frame(sockets[0]!, { type: 'session', ...descriptor })
    sockets[0]!.onclose?.({})
    for (const callback of scheduled.splice(0)) callback()
    expect(tickets).toBe(2)
    finishProbe(jsonResponse(403, { error: 'capability-required' }))
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'denial')).toBe(true))
    finishTicket(jsonResponse(200, { ticket: 'second' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const callback of scheduled.splice(0)) callback()
    expect(events.map((event) => event.kind)).toEqual(['connected', 'disconnected', 'denial'])
    expect(connection.denial).toMatchObject({ status: 403, operation: 'session', version: 1 })
    expect(sockets).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(fetchFn.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true)
    await expect(connection.fetchOps(0)).rejects.toMatchObject({ diagnostic: connection.denial })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    connection.close()
  })

  it('cancels a sleeping probe and queued reconnect after a snapshot denial', async () => {
    const fetchFn = vi.fn(async (url: string) => jsonResponse(url.endsWith('/snapshot') ? 403 : 500, { error: 'forbidden' }))
    const cancelFn = vi.fn()
    const { connection, sockets, events, scheduled } = harness({ fetchFn, cancelFn })
    sockets[0]!.onopen?.({})
    sockets[0]!.onclose?.({})
    await vi.waitFor(() => expect(scheduled).toHaveLength(2))
    await expect(connection.fetchSnapshot()).rejects.toMatchObject({ diagnostic: { status: 403 } })
    expect(cancelFn).toHaveBeenCalledTimes(2)
    for (const callback of scheduled.splice(0)) callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'denial')).toHaveLength(1)
    connection.close()
  })

  it.each([[403, 'capability-required', 'forbidden'], [409, 'actor-principal-mismatch', 'actor-principal-mismatch'], [429, 'rate-limited', 'rate-limited']] as const)('maps HTTP %s to a versioned denial', async (status, code, kind) => {
    const { connection } = harness({ fetchFn: async () => jsonResponse(status, { error: code, retryAfterMs: 50 }) })
    const outcome = await connection.postOp({ protocolVersion: 1, actorId: 'agent', opId: 'op', baseRevision: 0, patch: [] })
    expect(outcome).toMatchObject({ kind, diagnostic: { version: 1, type: 'collab.denial', code, status, sessionId: 's1', actorId: 'agent', opId: 'op' } })
    connection.close()
  })

  it('sends a bearer on HTTP and redeems a fresh ticket on every WebSocket connection', async () => {
    let tickets = 0
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-delegation')
      expect(new Headers(init?.headers).get('X-Dinkster-Actor-Kind')).toBe('agent')
      expect(init?.redirect).toBe('error')
      return jsonResponse(200, url.endsWith('/ws-ticket') ? { ticket: `ticket-${++tickets}` } : { revision: 0, document: {} })
    })
    const { connection, sockets, wsUrls, scheduled } = harness({ token: 'fixture-delegation', actorKind: 'agent', fetchFn })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    expect(wsUrls[0]).toContain('ticket=ticket-1')
    expect(wsUrls[0]).not.toContain('fixture-delegation')
    sockets[0]!.onopen?.({})
    sockets[0]!.onclose?.({})
    for (const callback of scheduled.splice(0)) callback()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(wsUrls[1]).toContain('ticket=ticket-2')
    await connection.fetchSnapshot()
    connection.close()
  })

  it('does not reconnect after a refused ticket', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: 'authentication-required' }))
    const { connection, sockets, scheduled } = harness({ actorKind: 'agent', fetchFn })
    await connection.fetchSnapshot().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sockets).toHaveLength(0)
    expect(scheduled).toHaveLength(0)
    connection.close()
  })
})

describe('session management helpers', () => {
  it('createCollabSession posts {scope, documentId, snapshot} and returns the 201 descriptor', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, ...(init !== undefined && { init }) })
      return jsonResponse(201, descriptor)
    }
    const created = await createCollabSession(
      'http://test:8765',
      { scope: 'local', documentId: 'd1', snapshot: { v: 0 } },
      fetchFn,
    )
    expect(created).toEqual(descriptor)
    expect(calls[0]!.url).toBe('http://test:8765/api/sessions')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      scope: 'local',
      documentId: 'd1',
      snapshot: { v: 0 },
    })
  })

  it('createCollabSession throws with the server error string on refusal', async () => {
    await expect(
      createCollabSession('http://test:8765', { scope: '', documentId: 'd', snapshot: {} }, async () =>
        jsonResponse(400, { error: "'scope' is required (single-user: 'local')" }),
      ),
    ).rejects.toThrow(/'scope' is required/)
  })

  it('reports revoked delegation identity without retrying a management request', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(403, {
      error: 'delegation-revoked', delegationId: 'delegation-789',
    }))
    const onDiagnostic = vi.fn()
    await expect(listCollabSessions('http://test:8765', 'local', fetchFn, { onDiagnostic }))
      .rejects.toThrow(/delegation-revoked/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: 'delegation-revoked', delegationId: 'delegation-789',
      operation: 'list-sessions', message: 'Delegation delegation-789: delegation-revoked',
    }))
  })

  it('listCollabSessions encodes the scope and unwraps the sessions array', async () => {
    let seen = ''
    const sessions = await listCollabSessions('http://test:8765', 'a b', async (url) => {
      seen = url
      return jsonResponse(200, { sessions: [descriptor] })
    })
    expect(seen).toBe('http://test:8765/api/sessions?scope=a%20b')
    expect(sessions).toEqual([descriptor])
  })

  it('getCollabSession answers undefined for a gone session (404), throws on other failures', async () => {
    expect(
      await getCollabSession('http://test:8765', 's1', async () =>
        jsonResponse(404, { error: 'no such session' }),
      ),
    ).toBeUndefined()
    await expect(
      getCollabSession('http://test:8765', 's1', async () => jsonResponse(500, { error: 'boom' })),
    ).rejects.toThrow(/500/)
  })

  it('closeCollabSession issues DELETE and tolerates an already-gone session', async () => {
    let init: RequestInit | undefined
    await closeCollabSession('http://test:8765', 's1', async (_url, i) => {
      init = i
      return jsonResponse(200, { closed: true })
    })
    expect(init?.method).toBe('DELETE')
    await closeCollabSession('http://test:8765', 's1', async () =>
      jsonResponse(404, { error: 'no such session' }),
    )
    await expect(
      closeCollabSession('http://test:8765', 's1', async () => jsonResponse(500, { error: 'x' })),
    ).rejects.toThrow(/500/)
  })
})

describe('postOp status mapping', () => {
  it('maps an ok response to accepted with the raw envelope (validation is the session core)', async () => {
    const { connection } = harness({ fetchFn: async () => jsonResponse(200, serverOp) })
    const outcome = await connection.postOp({
      protocolVersion: 1,
      opId: 'op-1',
      actorId: 'alice',
      baseRevision: 3,
      patch: [],
    })
    expect(outcome).toEqual({ kind: 'accepted', op: serverOp })
  })

  it('posts the envelope to the ops route verbatim', async () => {
    let seen: { url: string; body: unknown } | undefined
    const { connection } = harness({
      fetchFn: async (url, init) => {
        seen = { url, body: JSON.parse(init?.body as string) }
        return jsonResponse(200, serverOp)
      },
    })
    const op = { protocolVersion: 1, opId: 'op-1', actorId: 'alice', baseRevision: 3, patch: [] }
    await connection.postOp(op)
    expect(seen?.url).toBe('http://test:8765/api/sessions/s1/ops')
    expect(seen?.body).toEqual(op)
  })

  it('maps 409 stale-base {revision} to a rebase signal', async () => {
    const { connection } = harness({
      fetchFn: async () => jsonResponse(409, { error: 'stale-base', revision: 9 }),
    })
    expect(
      await connection.postOp({ protocolVersion: 1, opId: 'o', actorId: 'a', baseRevision: 3, patch: [] }),
    ).toEqual({ kind: 'stale-base', revision: 9 })
  })

  it('maps 409 snapshot-required to the checkpoint signal (distinct from stale-base)', async () => {
    const { connection } = harness({
      fetchFn: async () =>
        jsonResponse(409, { error: 'snapshot-required', revision: 5000, snapshotRevision: 4 }),
    })
    expect(
      await connection.postOp({ protocolVersion: 1, opId: 'o', actorId: 'a', baseRevision: 3, patch: [] }),
    ).toEqual({ kind: 'snapshot-required' })
  })

  it('maps 406 to protocol-unsupported with the supported list (malformed list = empty)', async () => {
    const { connection } = harness({
      fetchFn: async () =>
        jsonResponse(406, { error: 'protocol-version-unsupported', requested: 2, supported: [1] }),
    })
    expect(
      await connection.postOp({ protocolVersion: 2, opId: 'o', actorId: 'a', baseRevision: 3, patch: [] }),
    ).toEqual({ kind: 'protocol-unsupported', supported: [1] })
    const malformed = harness({
      fetchFn: async () => jsonResponse(406, { error: 'protocol-version-unsupported' }),
    })
    expect(
      await malformed.connection.postOp({
        protocolVersion: 2,
        opId: 'o',
        actorId: 'a',
        baseRevision: 3,
        patch: [],
      }),
    ).toEqual({ kind: 'protocol-unsupported', supported: [] })
  })

  it('maps other refusals to error with the server message, and a thrown fetch to error (same-opId retry)', async () => {
    const { connection } = harness({
      fetchFn: async () => jsonResponse(400, { error: "'opId' must be a non-empty string" }),
    })
    expect(
      await connection.postOp({ protocolVersion: 1, opId: '', actorId: 'a', baseRevision: 3, patch: [] }),
    ).toEqual({ kind: 'error', message: "HTTP 400: 'opId' must be a non-empty string" })
    const network = harness({
      fetchFn: async () => {
        throw new Error('connection refused')
      },
    })
    expect(
      await network.connection.postOp({
        protocolVersion: 1,
        opId: 'o',
        actorId: 'a',
        baseRevision: 3,
        patch: [],
      }),
    ).toEqual({ kind: 'error', message: 'connection refused' })
  })
})

describe('snapshot and catch-up routes', () => {
  it('fetchSnapshot returns {revision, document} and throws on a malformed or failed response', async () => {
    const { connection } = harness({
      fetchFn: async () => jsonResponse(200, { revision: 7, document: { d: 1 } }),
    })
    expect(await connection.fetchSnapshot()).toEqual({ revision: 7, document: { d: 1 } })
    const bad = harness({ fetchFn: async () => jsonResponse(200, { document: {} }) })
    await expect(bad.connection.fetchSnapshot()).rejects.toThrow(/invalid revision/)
    const failed = harness({ fetchFn: async () => jsonResponse(500, { error: 'x' }) })
    await expect(failed.connection.fetchSnapshot()).rejects.toThrow(/500/)
  })

  it('fetchOps passes the after cursor and unwraps the ops page', async () => {
    let seen = ''
    const { connection } = harness({
      fetchFn: async (url) => {
        seen = url
        return jsonResponse(200, { protocolVersion: 1, sessionId: 's1', revision: 5, ops: [serverOp] })
      },
    })
    expect(await connection.fetchOps(3)).toEqual({ kind: 'ops', ops: [serverOp] })
    expect(seen).toBe('http://test:8765/api/sessions/s1/ops?after=3')
  })

  it('fetchOps maps 410 to resync-required with the snapshotRevision', async () => {
    const { connection } = harness({
      fetchFn: async () => jsonResponse(410, { error: 'resync-required', snapshotRevision: 12 }),
    })
    expect(await connection.fetchOps(3)).toEqual({ kind: 'resync-required', snapshotRevision: 12 })
  })

  it('fetchOps throws on a page missing the ops array', async () => {
    const { connection } = harness({ fetchFn: async () => jsonResponse(200, { revision: 5 }) })
    await expect(connection.fetchOps(3)).rejects.toThrow(/missing ops array/)
  })

  it('putSnapshot maps ok / 409 conflict / other failure', async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    const doc = { formatVersion: 1 } as never
    const { connection } = harness({
      fetchFn: async (url, init) => {
        seen = { url, ...(init !== undefined && { init }) }
        return jsonResponse(200, { snapshotRevision: 9, revision: 9 })
      },
    })
    expect(await connection.putSnapshot(9, doc)).toEqual({ kind: 'ok' })
    expect(seen?.url).toBe('http://test:8765/api/sessions/s1/snapshot')
    expect(seen?.init?.method).toBe('PUT')
    expect(JSON.parse(seen?.init?.body as string)).toEqual({ revision: 9, document: doc })
    const conflict = harness({
      fetchFn: async () => jsonResponse(409, { error: 'snapshot-invalid', message: 'behind' }),
    })
    expect(await conflict.connection.putSnapshot(2, doc)).toEqual({ kind: 'conflict' })
    const failed = harness({ fetchFn: async () => jsonResponse(500, { error: 'x' }) })
    await expect(failed.connection.putSnapshot(2, doc)).rejects.toThrow(/500/)
  })
})

describe('WS frame shaping', () => {
  it('connects to the events route derived from the base URL (ws scheme), honoring wsUrl override', () => {
    const { wsUrls } = harness()
    expect(wsUrls[0]).toBe('ws://test:8765/api/sessions/s1/events')
    const overridden = harness({ wsUrl: 'wss://elsewhere/api/sessions/s1/events' })
    expect(overridden.wsUrls[0]).toBe('wss://elsewhere/api/sessions/s1/events')
  })

  it('shapes the descriptor-first session frame into connected, then op frames in order', () => {
    const { sockets, events } = harness()
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor })
    frame(ws, { type: 'op', ...serverOp })
    expect(events).toEqual([
      { kind: 'connected', descriptor },
      { kind: 'op', op: serverOp },
    ])
  })

  it('replays frames that arrived before the first subscriber, in order, exactly once', () => {
    // The WS connects in the constructor, so the descriptor frame and any
    // replayed ops can land while the joiner is still awaiting the HTTP
    // snapshot. They must reach the (later) first subscriber or a rejoin
    // never catches up past the snapshot revision (found live 2026-07-27).
    const sockets: FakeWS[] = []
    const connection = new CollabHttpConnection({
      baseUrl: 'http://test:8765',
      sessionId: 's1',
      actorId: 'alice',
      fetchFn: async () => jsonResponse(500, { error: 'unexpected fetch' }),
      webSocketFactory: () => {
        const s = new FakeWS()
        sockets.push(s)
        return s
      },
      scheduleFn: () => 1,
      cancelFn: () => {},
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor })
    frame(ws, { type: 'op', ...serverOp })
    const events: CollabConnectionEvent[] = []
    connection.onEvent((e) => events.push(e))
    expect(events).toEqual([
      { kind: 'connected', descriptor },
      { kind: 'op', op: serverOp },
    ])
    // One-shot: a second subscriber starts from live frames only.
    const later: CollabConnectionEvent[] = []
    connection.onEvent((e) => later.push(e))
    expect(later).toEqual([])
    // Live frames now deliver directly to both.
    frame(ws, { type: 'op', ...serverOp, revision: 5, baseRevision: 4 })
    expect(events).toHaveLength(3)
    expect(later).toHaveLength(1)
    connection.close()
  })

  it('does not buffer presence or disconnected pre-subscription: a presence flood cannot evict the descriptor', () => {
    const sockets: FakeWS[] = []
    const connection = new CollabHttpConnection({
      baseUrl: 'http://test:8765',
      sessionId: 's1',
      actorId: 'alice',
      fetchFn: async () => jsonResponse(500, { error: 'unexpected fetch' }),
      webSocketFactory: () => {
        const s = new FakeWS()
        sockets.push(s)
        return s
      },
      scheduleFn: () => 1,
      cancelFn: () => {},
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor })
    // Well past the 4096 buffer cap: were presence buffered, the flood
    // would shift the sole descriptor (the catch-up baseline) out.
    for (let i = 0; i < 5000; i++) frame(ws, { type: 'presence', actorId: 'bob', payload: { i } })
    frame(ws, { type: 'op', ...serverOp })
    const events: CollabConnectionEvent[] = []
    connection.onEvent((e) => events.push(e))
    expect(events).toEqual([
      { kind: 'connected', descriptor },
      { kind: 'op', op: serverOp },
    ])
    connection.close()
  })

  it('a maximum-retention replay (descriptor + 4096 ops) never evicts the descriptor', () => {
    // A legal replay at the server's retention cap is one descriptor plus
    // 4096 ops - one more event than the buffer cap. Overflow must evict
    // the oldest OP, never the descriptor: gap detection repairs a missing
    // op, but a missing baseline strands catch-up entirely.
    const sockets: FakeWS[] = []
    const connection = new CollabHttpConnection({
      baseUrl: 'http://test:8765',
      sessionId: 's1',
      actorId: 'alice',
      fetchFn: async () => jsonResponse(500, { error: 'unexpected fetch' }),
      webSocketFactory: () => {
        const s = new FakeWS()
        sockets.push(s)
        return s
      },
      scheduleFn: () => 1,
      cancelFn: () => {},
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor, revision: 0 })
    for (let i = 1; i <= 4096; i++) {
      frame(ws, { type: 'op', ...serverOp, opId: `op-${i}`, baseRevision: i - 1, revision: i })
    }
    const events: CollabConnectionEvent[] = []
    connection.onEvent((e) => events.push(e))
    expect(events).toHaveLength(4096)
    expect(events[0]).toEqual({ kind: 'connected', descriptor: { ...descriptor, revision: 0 } })
    // The single overflow dropped the OLDEST op (revision 1), keeping the
    // newest; the session's ordered ingress repairs the gap.
    expect(events[1]).toMatchObject({ kind: 'op', op: { revision: 2 } })
    expect(events[4095]).toMatchObject({ kind: 'op', op: { revision: 4096 } })
    connection.close()
  })

  it('a frame arriving during the first-subscriber flush queues behind the older buffered events', () => {
    const sockets: FakeWS[] = []
    const connection = new CollabHttpConnection({
      baseUrl: 'http://test:8765',
      sessionId: 's1',
      actorId: 'alice',
      fetchFn: async () => jsonResponse(500, { error: 'unexpected fetch' }),
      webSocketFactory: () => {
        const s = new FakeWS()
        sockets.push(s)
        return s
      },
      scheduleFn: () => 1,
      cancelFn: () => {},
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor })
    frame(ws, { type: 'op', ...serverOp })
    const laterOp = { ...serverOp, revision: 5, baseRevision: 4 }
    const events: CollabConnectionEvent[] = []
    connection.onEvent((e) => {
      events.push(e)
      // Handling the FIRST buffered event synchronously provokes a new
      // frame (e.g. a reentrant dispatch): it must not overtake the older
      // buffered op still waiting in the drain queue.
      if (events.length === 1) frame(ws, { type: 'op', ...laterOp })
    })
    expect(events).toEqual([
      { kind: 'connected', descriptor },
      { kind: 'op', op: serverOp },
      { kind: 'op', op: laterOp },
    ])
    connection.close()
  })

  it('close before any subscriber drops the buffered frames', () => {
    const sockets: FakeWS[] = []
    const connection = new CollabHttpConnection({
      baseUrl: 'http://test:8765',
      sessionId: 's1',
      actorId: 'alice',
      fetchFn: async () => jsonResponse(500, { error: 'unexpected fetch' }),
      webSocketFactory: () => {
        const s = new FakeWS()
        sockets.push(s)
        return s
      },
      scheduleFn: () => 1,
      cancelFn: () => {},
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor })
    connection.close()
    const events: CollabConnectionEvent[] = []
    connection.onEvent((e) => events.push(e))
    expect(events).toEqual([])
  })

  it('relays presence frames (payload optional), dropping frames without a usable actorId', () => {
    const { sockets, events } = harness()
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'presence', actorId: 'bob', payload: { cursor: [1, 2] } })
    frame(ws, { type: 'presence', actorId: 'bob' })
    frame(ws, { type: 'presence', actorId: '' })
    frame(ws, { type: 'presence' })
    expect(events).toEqual([
      { kind: 'presence', actorId: 'bob', payload: { cursor: [1, 2] } },
      { kind: 'presence', actorId: 'bob' },
    ])
  })

  it('shapes session_closed and ignores unknown frames, non-JSON, and non-string data as noise', () => {
    const { sockets, events } = harness()
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'future-frame', anything: true })
    ws.onmessage?.({ data: 'not json' })
    ws.onmessage?.({ data: new ArrayBuffer(4) })
    frame(ws, ['array'])
    frame(ws, { type: 'session_closed' })
    expect(events).toEqual([{ kind: 'session-closed' }])
  })

  it('forwards a malformed-but-typed op frame: validation is the session core, not the transport', () => {
    const { sockets, events } = harness()
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'op', opId: 42 })
    expect(events).toEqual([{ kind: 'op', op: { opId: 42 } }])
  })

  it('surfaces a transport drop as disconnected once, then reconnects and shapes the fresh descriptor', () => {
    const { sockets, scheduled, events } = harness()
    const ws = sockets[0]!
    ws.onopen?.({})
    frame(ws, { type: 'session', ...descriptor })
    ws.onclose?.({}) // slow-subscriber close or network death
    expect(events).toEqual([{ kind: 'connected', descriptor }, { kind: 'disconnected' }])
    scheduled.shift()!() // reconnect backoff fires; socket B opens
    const wsB = sockets[1]!
    wsB.onopen?.({})
    frame(wsB, { type: 'session', ...descriptor, revision: 9 })
    expect(events[2]).toEqual({ kind: 'connected', descriptor: { ...descriptor, revision: 9 } })
  })

  it('close() tears down deliberately: no disconnected event, later frames ignored, unsubscribe works', () => {
    const { connection, sockets, events } = harness()
    const ws = sockets[0]!
    ws.onopen?.({})
    connection.close()
    frame(ws, { type: 'op', ...serverOp })
    expect(events).toEqual([])
    expect(ws.closed).toBe(true)
    const again = harness()
    const off = again.connection.onEvent(() => {
      throw new Error('unsubscribed listener must not fire')
    })
    off()
    again.sockets[0]!.onopen?.({})
    frame(again.sockets[0]!, { type: 'session_closed' })
    expect(again.events).toEqual([{ kind: 'session-closed' }])
  })
})

describe('gone-session probe', () => {
  it('resolves a dead reconnect loop against a deleted session into session-closed', async () => {
    // A deleted session refuses the WS upgrade forever (404 before the
    // socket exists) and the session_closed broadcast is best-effort - the
    // probe is the guaranteed path to a terminal state.
    const { sockets, events } = harness({
      fetchFn: async () => jsonResponse(404, { error: 'no such session' }),
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    ws.onclose?.({}) // unexpected drop; reconnect loop + probe start
    await vi.waitFor(() => {
      expect(events).toContainEqual({ kind: 'session-closed' })
    })
    expect(events).toEqual([{ kind: 'disconnected' }, { kind: 'session-closed' }])
  })

  it('keeps polling through unreachable-server probes and stands down when the socket reconnects', async () => {
    let calls = 0
    let reachable = false
    const { sockets, scheduled, events } = harness({
      fetchFn: async () => {
        calls += 1
        if (!reachable) throw new Error('connection refused')
        return jsonResponse(200, descriptor)
      },
    })
    const ws = sockets[0]!
    ws.onopen?.({})
    ws.onclose?.({})
    // unreachable: no verdict, keep polling (the probe parks on its delay)
    await vi.waitFor(() => expect(scheduled.length).toBe(2)) // [reconnect backoff, probe delay]
    expect(calls).toBe(1)
    expect(events).toEqual([{ kind: 'disconnected' }])
    reachable = true
    scheduled[1]!() // fire the probe delay
    await vi.waitFor(() => expect(calls).toBe(2)) // session exists: not gone, poll again
    expect(events).toEqual([{ kind: 'disconnected' }])
    await vi.waitFor(() => expect(scheduled.length).toBe(3)) // next probe delay parked
    scheduled[0]!() // reconnect backoff fires; socket B opens
    sockets[1]!.onopen?.({})
    scheduled[2]!() // the pending probe delay resolves after reconnection
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2) // probe stood down without another fetch
    expect(events).toEqual([{ kind: 'disconnected' }])
  })
})

describe('presence egress', () => {
  it('stamps the configured actorId on outbound presence and drops frames while disconnected', () => {
    const { connection, sockets } = harness()
    const ws = sockets[0]!
    connection.sendPresence({ cursor: [3, 4] }) // WS not open yet: dropped, never queued
    expect(ws.sent).toEqual([])
    ws.onopen?.({})
    connection.sendPresence({ cursor: [3, 4] })
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'presence', actorId: 'alice', payload: { cursor: [3, 4] } },
    ])
    ws.onclose?.({})
    connection.sendPresence({ cursor: [5, 6] }) // dropped during the gap
    expect(ws.sent).toHaveLength(1)
  })
})
