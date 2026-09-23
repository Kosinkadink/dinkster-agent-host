import { coreCommandRegistry, connectSharedSession, type CollabConnection, type CollabConnectionEvent, type PostOpOutcome } from '@dinkster/core'
import { describe, expect, it, vi } from 'vitest'
import { beginConnect, createAgentDocument, createAgentHandle, createSession, listSessions } from '../src/api.js'
import { commandCatalog } from '../src/catalog.js'
import { parseArgs } from '../src/main.js'
import { createToolHandlers } from '../src/mcp.js'

describe('delegated agents', () => {
  it.each(['list', 'create'] as const)('pauses session %s before connection and resumes with the same credential', async (operation) => {
    vi.useFakeTimers()
    let fresh = false
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer durable-test')
      return new Response(JSON.stringify(fresh ? { sessionId: 's', sessions: [{ sessionId: 's' }] } : { error: 'user-session-required' }), { status: fresh ? 200 : 403 })
    })
    vi.stubGlobal('fetch', fetchFn)
    const onDiagnostic = vi.fn()
    const controller = new AbortController()
    const options = { onDiagnostic, signal: controller.signal, token: 'durable-test' }
    const pending = operation === 'list' ? listSessions('http://localhost', options.token, 'shared', options) : createSession('http://localhost', options)
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledTimes(1))
      expect(onDiagnostic).toHaveBeenCalledWith({ version: 1, type: 'collab.denial', code: 'user-session-required', reason: 'user-session-required', status: 403, message: 'Agent paused until the user signs in', retryAfterMs: 30_000, operation: operation === 'list' ? 'list-sessions' : 'create-session' })
      await vi.advanceTimersByTimeAsync(29_000)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      fresh = true
      await vi.advanceTimersByTimeAsync(1_000)
      await pending
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(onDiagnostic).toHaveBeenCalledTimes(1)
      expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(fetchFn.mock.calls[1]?.[1]?.body)
      expect(vi.getTimerCount()).toBe(0)
    } finally { controller.abort(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it.each(['network', 'server'] as const)('keeps discovery slow across %s failures while suspended', async (failure) => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('{"error":"user-session-required"}', { status: 403 }))
    if (failure === 'network') fetchFn.mockRejectedValueOnce(new Error('network down'))
    else fetchFn.mockResolvedValueOnce(new Response('', { status: 503 }))
    fetchFn.mockResolvedValue(new Response('{"sessions":[]}'))
    vi.stubGlobal('fetch', fetchFn)
    const onDiagnostic = vi.fn()
    const controller = new AbortController()
    const pending = listSessions('http://localhost', 'durable-test', 'shared', { onDiagnostic, signal: controller.signal })
    void pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(pending).resolves.toEqual([])
      expect(onDiagnostic).toHaveBeenCalledTimes(1)
      expect(fetchFn).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally { controller.abort(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it.each(['forbidden', 'network'] as const)('does not retry an ambiguous or definitively refused session create (%s)', async (failure) => {
    vi.useFakeTimers()
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('{"error":"user-session-required"}', { status: 403 }))
    if (failure === 'network') fetchFn.mockRejectedValue(new Error('connection lost after send'))
    else fetchFn.mockResolvedValue(new Response('{"error":"capability-required"}', { status: 403 }))
    vi.stubGlobal('fetch', fetchFn)
    const onDiagnostic = vi.fn()
    const controller = new AbortController()
    const pending = createSession('http://localhost', { token: 'durable-test', onDiagnostic, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow(failure === 'network' ? 'connection lost after send' : 'capability-required')
    try {
      await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(30_000)
      await rejected
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { controller.abort(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it('MCP shutdown cancels pre-session waits and prevents late requests', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => new Response('{"error":"user-session-required"}', { status: 403 }))
    vi.stubGlobal('fetch', fetchFn)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = createToolHandlers('http://localhost', undefined, undefined, { token: 'durable-test' })
    const pending = host.handlers.sessions_list()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await vi.waitFor(() => expect(stderr).toHaveBeenCalledTimes(1))
      expect(JSON.parse(stderr.mock.calls[0]![0])).toMatchObject({ reason: 'user-session-required', operation: 'list-sessions' })
      host.close()
      await rejected
      await expect(host.handlers.sessions_list()).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { host.close(); stderr.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  it('reports a revoked delegation as terminal with its identity', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      error: 'delegation-revoked', delegationId: 'delegation-revoked-test',
    }), { status: 403 }))
    vi.stubGlobal('fetch', fetchFn)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = createToolHandlers('http://localhost', undefined, undefined, { token: 'durable-test' })
    try {
      await expect(host.handlers.sessions_list()).rejects.toThrow('delegation-revoked')
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(stderr.mock.calls[0]![0])).toMatchObject({
        code: 'delegation-revoked', delegationId: 'delegation-revoked-test',
        operation: 'list-sessions',
      })
    } finally { host.close(); stderr.mockRestore(); vi.unstubAllGlobals() }
  })

  it('waits for the user at join and during settle, then resumes the same delegated handle', async () => {
    vi.useFakeTimers()
    let fresh = false
    let revision = 0
    const ops: Record<string, unknown>[] = []
    const descriptor = () => ({ protocolVersion: 1, sessionId: 's', scope: 'shared', documentId: 'd', revision, snapshotRevision: 0 })
    const document = createAgentDocument('d')
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer durable-test')
      if (!fresh) return response({ error: 'user-session-required' }, 403)
      if (url.endsWith('/ws-ticket')) return response({ ticket: 'single-use-test' })
      if (url.endsWith('/snapshot')) return response({ revision: 0, document })
      if (url.includes('/ops?')) return response({ ops: ops.filter((op) => Number(op['revision']) > Number(new URL(url).searchParams.get('after'))) })
      if (url.endsWith('/ops')) {
        const submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
        const replay = ops.find((op) => op['opId'] === submitted['opId'])
        if (replay) return response(replay)
        const op = { ...submitted, revision: ++revision, timestamp: Date.now() }
        ops.push(op)
        return response(op)
      }
      return response(descriptor())
    })
    class Socket {
      binaryType = ''
      onopen: ((event: unknown) => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: ((event: unknown) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      constructor() {
        void Promise.resolve().then(() => {
          this.onopen?.({})
          this.onmessage?.({ data: JSON.stringify({ type: 'session', ...descriptor() }) })
        })
      }
      send(): void {}
      close(): void {}
    }
    vi.stubGlobal('fetch', fetchFn)
    vi.stubGlobal('WebSocket', Socket)
    const onDiagnostic = vi.fn()
    const pending = beginConnect('http://localhost', 's', { token: 'durable-test', actorId: 'agent', onDiagnostic })
    try {
      await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledTimes(1))
      const requests = fetchFn.mock.calls.length
      await vi.advanceTimersByTimeAsync(29_000)
      expect(fetchFn).toHaveBeenCalledTimes(requests)
      fresh = true
      await vi.advanceTimersByTimeAsync(1_100)
      const handle = await pending.handle
      fresh = false
      expect(handle.dispatch('node.add', { graphId: 'g0', type: 'Test', position: { x: 0, y: 0 } }).ok).toBe(true)
      const settling = handle.settle()
      await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledTimes(2))
      const pausedRequests = fetchFn.mock.calls.length
      await vi.advanceTimersByTimeAsync(29_000)
      expect(fetchFn).toHaveBeenCalledTimes(pausedRequests)
      fresh = true
      await vi.advanceTimersByTimeAsync(1_100)
      await settling
      expect(Object.keys(handle.getDocument().graphs.g0!.nodes)).toHaveLength(1)
      expect(ops).toHaveLength(1)
      expect(onDiagnostic.mock.calls.every(([diagnostic]) => diagnostic.reason === 'user-session-required')).toBe(true)
      expect(fetchFn.mock.calls.some(([url]) => url.includes('/delegations'))).toBe(false)
    } finally {
      pending.close()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it.each(['forbidden', 'actor-principal-mismatch', 'rate-limited'] as const)('settle rejects %s once without retrying', async (kind) => {
    const diagnostic = { version: 1 as const, type: 'collab.denial' as const, code: kind, status: kind === 'forbidden' ? 403 : kind === 'rate-limited' ? 429 : 409, message: kind, actorId: 'agent', opId: 'op', sessionId: 's' }
    let receive: ((event: CollabConnectionEvent) => void) | undefined
    const postOp = vi.fn(async (): Promise<PostOpOutcome> => ({ kind, diagnostic }))
    const connection: CollabConnection = {
      sessionId: 's', postOp,
      fetchSnapshot: async () => ({ revision: 0, document: createAgentDocument() }),
      fetchOps: async () => ({ kind: 'ops', ops: [] }),
      putSnapshot: async () => ({ kind: 'ok' }), sendPresence: vi.fn(), close: vi.fn(),
      onEvent: (listener) => { receive = listener; return () => {} },
    }
    const onError = vi.fn()
    const session = await connectSharedSession(connection, coreCommandRegistry(), { actorId: 'agent', onError, onListenerError: () => {} })
    receive!({ kind: 'connected', descriptor: { protocolVersion: 1, sessionId: 's', scope: 'shared', documentId: 'd', revision: 0, snapshotRevision: 0 } })
    const handle = createAgentHandle(session, () => session.settle(), () => session.close(), {})
    expect(handle.dispatch('node.add', { graphId: 'g0', type: 'Test', position: { x: 0, y: 0 } }).ok).toBe(true)
    await expect(handle.settle()).rejects.toMatchObject({ diagnostic })
    await expect(handle.settle()).rejects.toMatchObject({ diagnostic, message: JSON.stringify(diagnostic) })
    expect(postOp).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(JSON.stringify(diagnostic))
    expect(connection.sendPresence).toHaveBeenLastCalledWith(expect.objectContaining({ activity: expect.objectContaining({ status: 'error' }) }))
    handle.close()
  })

  it('rejects an idle read denial through settle and the Problems sink without submitting an op', async () => {
    const diagnostic = { version: 1 as const, type: 'collab.denial' as const, code: 'capability-required', status: 403, message: 'HTTP 403: capability-required', actorId: 'agent', sessionId: 's', operation: 'session' }
    const postOp = vi.fn(async (): Promise<PostOpOutcome> => ({ kind: 'forbidden', diagnostic }))
    const connection: CollabConnection = {
      sessionId: 's', denial: diagnostic, postOp,
      fetchSnapshot: async () => ({ revision: 0, document: createAgentDocument() }),
      fetchOps: async () => ({ kind: 'ops', ops: [] }), putSnapshot: async () => ({ kind: 'ok' }),
      sendPresence: vi.fn(), close: vi.fn(), onEvent: () => () => {},
    }
    const onError = vi.fn()
    const session = await connectSharedSession(connection, coreCommandRegistry(), { actorId: 'agent', onError, onListenerError: () => {} })
    await expect(session.settle()).rejects.toMatchObject({ diagnostic })
    expect(session.status.get()).toBe('error')
    expect(onError).toHaveBeenCalledExactlyOnceWith(JSON.stringify(diagnostic))
    expect(postOp).not.toHaveBeenCalled()
    session.close()
  })

  it('catalog and dispatch share the full registry', () => {
    expect(commandCatalog.map((entry) => entry.id).sort()).toEqual([...coreCommandRegistry().keys()].sort())
    expect(commandCatalog.some((entry) => entry.id === 'text.splice')).toBe(true)
  })

  it('accepts a delegation flag and environment default', () => {
    vi.stubEnv('DINKSTER_AGENT_TOKEN', 'test-env-credential')
    try {
      expect(parseArgs(['--base-url', 'http://local', 'sessions', 'list']).token).toBe('test-env-credential')
      expect(parseArgs(['--token', 'test-flag-credential', '--base-url', 'http://local', 'sessions', 'list']).token).toBe('test-flag-credential')
    } finally { vi.unstubAllEnvs() }
  })
})
