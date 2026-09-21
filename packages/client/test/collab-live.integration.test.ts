/**
 * Live collab integration: two SharedDocumentSessions over real
 * CollabHttpConnections against a running Dinkster native server's collab
 * surface. Skipped unless DINKSTER_COLLAB_LIVE_URL is set (the shared server:
 * http://127.0.0.1:8765).
 *
 *   DINKSTER_COLLAB_LIVE_URL=http://127.0.0.1:8765 pnpm --filter @dinkster/client test
 *
 * Proves the transport end to end: session create/discover, snapshot join,
 * HTTP op submission, descriptor-first WS delivery, cross-client
 * convergence in both directions, client checkpoint publication and a join
 * from that checkpoint, presence relay (never echoed), and the session_closed
 * broadcast on DELETE.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asNodeId,
  coreCommandRegistry,
  connectSharedSession,
  type Json,
  type SharedDocumentSession,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  CollabHttpConnection,
  closeCollabSession,
  createCollabSession,
  getCollabSession,
  listCollabSessions,
  type WebSocketLike,
} from '../src/index.js'

const LIVE_URL = process.env['DINKSTER_COLLAB_LIVE_URL']

const node = (id: string) => ({ id: asNodeId(id), type: 'X', values: {} })

const snapshotDoc = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('live-collab-lineage'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'),
      name: 'g',
      nodes: { n1: node('n1'), n2: node('n2') },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 100,
    },
  },
  view: { graphs: {} },
})

async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const wsFactory = (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike

describe.skipIf(!LIVE_URL)('live collab loop (:8765)', () => {
  const base = LIVE_URL!
  const cleanups: (() => void | Promise<void>)[] = []
  afterAll(async () => {
    for (const fn of cleanups) await fn()
  })

  it('two clients converge, publish a checkpoint, join from it, relay presence, and see the close', async () => {
    const documentId = `live-collab-${Date.now()}`
    const created = await createCollabSession(base, {
      scope: 'local',
      documentId,
      snapshot: snapshotDoc(),
    })
    // Registered up front so a mid-test failure never orphans the session
    // on the shared server (closeCollabSession tolerates already-gone).
    cleanups.push(() => closeCollabSession(base, created.sessionId))
    expect(created.protocolVersion).toBe(1)
    expect(created.revision).toBe(0)

    // Discovery: the descriptor is listed under its scope and fetchable by id.
    const listed = await listCollabSessions(base, 'local')
    expect(listed.some((s) => s.sessionId === created.sessionId)).toBe(true)
    expect((await getCollabSession(base, created.sessionId))?.documentId).toBe(documentId)

    const connect = async (actorId: string): Promise<[CollabHttpConnection, SharedDocumentSession]> => {
      const connection = new CollabHttpConnection({
        baseUrl: base,
        sessionId: created.sessionId,
        actorId,
        webSocketFactory: wsFactory, // Node 22+ global WebSocket
      })
      cleanups.push(() => connection.close())
      const session = await connectSharedSession(connection, coreCommandRegistry(), { actorId })
      cleanups.push(() => session.close())
      return [connection, session]
    }
    const [connA, alice] = await connect('alice')
    const [, bob] = await connect('bob')
    await until(() => (alice.status.get() === 'live' ? true : undefined), 'alice live')
    await until(() => (bob.status.get() === 'live' ? true : undefined), 'bob live')

    // Alice -> server -> Bob.
    const a = alice.dispatch({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n1', title: 'from alice' },
    })
    expect(a.ok).toBe(true)
    await until(
      () => (bob.doc.graphs.g0!.nodes.n1!.title === 'from alice' ? true : undefined),
      "bob to see alice's title",
    )

    // Bob -> server -> Alice (the reverse direction, on top of revision 1).
    const b = bob.dispatch({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n2', title: 'from bob' },
    })
    expect(b.ok).toBe(true)
    await until(
      () => (alice.doc.graphs.g0!.nodes.n2!.title === 'from bob' ? true : undefined),
      "alice to see bob's title",
    )

    // Reach the hard checkpoint threshold. The publisher always sends its
    // confirmed document, and a subsequent client joins from that revision
    // rather than replaying the folded prefix.
    for (let i = 3; i <= 200; i++) {
      expect(
        alice.dispatch({
          command: 'node.setTitle',
          params: { graphId: 'g0', nodeId: 'n1', title: `checkpoint-${i}` },
        }).ok,
      ).toBe(true)
    }
    await alice.settle()
    await until(() => (bob.revision === 200 ? true : undefined), 'bob at revision 200')
    await until(async () => {
      const snapshot = await connA.fetchSnapshot()
      return snapshot.revision === 200 ? true : undefined
    }, 'client-published revision 200 checkpoint')
    const [, charlie] = await connect('charlie')
    await until(() => (charlie.revision === 200 ? true : undefined), 'charlie joined at checkpoint')
    expect(charlie.doc.graphs.g0!.nodes.n1!.title).toBe('checkpoint-200')

    // Presence: relayed to the OTHER subscriber, never echoed.
    const bobSaw: { actorId: string; payload?: Json }[] = []
    const aliceSaw: { actorId: string; payload?: Json }[] = []
    bob.onPresence((actorId, payload) =>
      bobSaw.push(payload === undefined ? { actorId } : { actorId, payload }),
    )
    alice.onPresence((actorId, payload) =>
      aliceSaw.push(payload === undefined ? { actorId } : { actorId, payload }),
    )
    connA.sendPresence({ cursor: [10, 20] })
    await until(() => (bobSaw.length > 0 ? true : undefined), 'presence relay to bob')
    expect(bobSaw[0]).toEqual({ actorId: 'alice', payload: { cursor: [10, 20] } })
    expect(aliceSaw).toHaveLength(0) // never echoed to the sender

    // DELETE broadcasts session_closed; both sessions settle terminal.
    await closeCollabSession(base, created.sessionId)
    await until(() => (alice.status.get() === 'closed' ? true : undefined), 'alice closed')
    await until(() => (bob.status.get() === 'closed' ? true : undefined), 'bob closed')
    expect(await getCollabSession(base, created.sessionId)).toBeUndefined()
  }, 45_000)
})
