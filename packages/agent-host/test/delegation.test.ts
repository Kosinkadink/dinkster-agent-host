import { coreCommandRegistry, connectSharedSession, type CollabConnection, type CollabConnectionEvent, type PostOpOutcome } from '@dinkster/core'
import { describe, expect, it, vi } from 'vitest'
import { createAgentDocument, createAgentHandle } from '../src/api.js'
import { commandCatalog } from '../src/catalog.js'
import { parseArgs } from '../src/main.js'

describe('delegated agents', () => {
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
