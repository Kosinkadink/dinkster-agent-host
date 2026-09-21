/**
 * SharedDocumentSession: the multiplayer DocumentSession over the
 * dinkster-collab v1 surface (platform-plan 2.3 tail; joint contract pinned
 * with the backend at protocolVersion 1).
 *
 * Driven through a deterministic in-memory fake of the collab server that
 * mirrors the real semantics: ops accepted only at their exact baseRevision
 * (409 stale-base otherwise), opId-keyed idempotent resubmission, WS
 * delivery of every accepted op, snapshot/ops catch-up, and presence
 * passthrough. The fake emits the WS echo BEFORE the POST response resolves
 * (like a real socket can), so the ack-race ordering is exercised by
 * default.
 */
import { describe, expect, it, vi } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import {
  COLLAB_PROTOCOL_VERSION,
  connectSharedSession,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type FetchOpsOutcome,
  type PostOpOutcome,
  type PutSnapshotOutcome,
  type SessionConflict,
  type SharedDocumentSession,
  type SharedSessionOptions,
} from '../src/commands/shared-session.js'
import { createLocalSession, type SessionOp, type WirePatchOp } from '../src/commands/session.js'
import { planClipboardPaste, serializeSelection, type DinksterClipboardEnvelope } from '../src/clipboard.js'
import { documentResolver } from '../src/compile/compile.js'
import { replayHistoryOps } from '../src/commands/store.js'
import { type PatchOp } from '../src/commands/patch.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, type PortRef } from '../src/ids.js'
import { lifecycleFlattenFingerprint, lifecycleSelectionFingerprint, planFlattenBoundaryRoutes } from '../src/lifecycle/planner.js'
import type { NodeSchema } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Document helpers (same shapes as session.test.ts)
// ---------------------------------------------------------------------------

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, type = 'X') => ({ id: asNodeId(id), type, values: {} })
const port = (nodeId: string, portId: string, members?: readonly string[]): PortRef => ({
  node: asNodeId(nodeId), port: portId as never, ...(members !== undefined ? { members: members as never } : {}),
})

// The peer's allocation cursor is seeded above its minted ordinals, exactly
// as a real peer's forward patches would leave it (the actor-cursor
// invariant rejects a foreign node id at or above its actor's cursor).
const baseDoc = () =>
  doc({
    g0: graph({
      id: 'g0',
      nodes: { n1: node('n1'), n2: node('n2') },
      actorCursors: { peer: 1000 },
    }),
  })

const addNode = { command: 'node.add', params: { graphId: 'g0', type: 'X', position: { x: 0, y: 0 } } }
const setTitle = (nodeId: string, title: string) => ({
  command: 'node.setTitle',
  params: { graphId: 'g0', nodeId, title },
})

/** A valid foreign patch: peer adds a node it allocated from its own cursor. */
const foreignAddNode = (id: string): WirePatchOp[] => [
  { op: 'add', path: ['graphs', 'g0', 'nodes', id], value: node(id) as unknown as Json },
]

const foreignRemoveNode = (id: string): WirePatchOp[] => [
  { op: 'remove', path: ['graphs', 'g0', 'nodes', id] },
]

const textDoc = (value = 'hello'): WorkflowDocument =>
  doc({
    g0: graph({
      id: 'g0',
      nodes: { n1: { ...node('n1'), values: { prompt: value } } },
    }),
  })

const spliceText = (offset: number, deleteCount: number, insert: string) => ({
  command: 'text.splice',
  params: { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', offset, deleteCount, insert },
})

const replaceText = (value: string): WirePatchOp[] => [{
  op: 'replace',
  path: ['graphs', 'g0', 'nodes', 'n1', 'values', 'prompt'],
  value,
}]

const IMAGE_SOURCE = `blake3:${'a'.repeat(64)}`
const IMAGE_REPLACEMENT = `blake3:${'b'.repeat(64)}`
const IMAGE_FOREIGN = `blake3:${'c'.repeat(64)}`
const imageRef = (digest: string, name: string) => ({
  digest, name, size: 10, mediaType: 'image/png', virtualPath: '',
})
const imageDoc = (): WorkflowDocument => doc({
  g0: graph({
    id: 'g0',
    nodes: {
      image: { ...node('image', 'LoadImage'), values: { image: imageRef(IMAGE_SOURCE, 'source.png') } },
    },
  }),
})
const imageSchema = {
  type: 'LoadImage', displayName: 'Load Image', category: 'test', source: 'v3' as const, isOutputNode: false,
  items: [{
    kind: 'input' as const,
    id: 'image',
    type: { kind: 'asset' as const, element: { kind: 'concrete' as const, name: 'comfy.IMAGE' } },
    optional: false,
    widget: { widgetType: 'ASSET', options: {} },
  }],
}
const applyImage = {
  command: 'image.applyAsset',
  params: {
    graphId: 'g0', nodeId: 'image', inputId: 'image', expectedSourceDigest: IMAGE_SOURCE,
    asset: imageRef(IMAGE_REPLACEMENT, 'edited.png'),
  },
}

const countOutputSchema: NodeSchema = {
  type: 'CountOutput',
  displayName: 'Count output',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'count',
      type: { kind: 'concrete', name: 'core.int' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 1 },
    },
    {
      kind: 'output',
      id: 'items',
      type: { kind: 'concrete', name: 'comfy.IMAGE' },
      dynamic: {
        kind: 'autogrow',
        template: [{
          kind: 'input',
          id: 'item',
          type: { kind: 'concrete', name: 'comfy.IMAGE' },
          optional: false,
        }],
        naming: { kind: 'prefix', prefix: '', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ],
}

const derivedCountDoc = (): WorkflowDocument => doc({
  g0: graph({
    id: 'g0',
    nodes: {
      occurrence: { ...node('occurrence', '#body'), values: { amount: 1 } },
      unrelated: node('unrelated'),
    },
    actorCursors: { peer: 1000 },
  }),
  body: graph({
    id: 'body',
    nodes: {
      split: { ...node('split', 'CountOutput'), values: { count: 1 } },
    },
    boundary: {
      inputs: [{
        id: 'amount',
        binds: { kind: 'port', node: asNodeId('split'), port: 'count' as never },
        promoted: true,
      }],
      outputs: [{
        id: 'items',
        binds: { kind: 'family', node: asNodeId('split'), port: 'items' as never },
      }],
    },
  }),
})

// ---------------------------------------------------------------------------
// Fake collab server + connection
// ---------------------------------------------------------------------------

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

class FakeConnection implements CollabConnection {
  readonly sessionId = 'sess-1'
  revision: number
  readonly log: CollabServerOp[] = []
  private readonly seen = new Map<string, CollabServerOp>()
  snapshotDoc: unknown
  snapshotRevision: number
  private readonly listeners = new Set<(e: CollabConnectionEvent) => void>()

  /** Emit the WS echo of accepted ops (before the POST response resolves). */
  wsAuto = true
  /** One-shot hook awaited at the top of postOp (gating/fault injection). */
  postHook: ((op: CollabClientOp) => Promise<void> | void) | undefined
  /** Force the next post to answer 409 snapshot-required. */
  snapshotRequiredOnce = false
  /** Force every post to answer 406 protocol-unsupported. */
  protocolBroken = false
  /** Answer 410 resync-required for fetchOps with after < this value. */
  retentionFloor: number | undefined

  readonly postedOps: CollabClientOp[] = []
  readonly sentPresence: Json[] = []
  readonly putSnapshots: number[] = []
  readonly putSnapshotDocuments: WorkflowDocument[] = []
  closed = false

  constructor(document: unknown, revision = 0) {
    this.snapshotDoc = document
    this.snapshotRevision = revision
    this.revision = revision
  }

  emit(event: CollabConnectionEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  descriptor(): CollabSessionDescriptor {
    return {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      scope: 'local',
      documentId: 'doc-1',
      revision: this.revision,
      snapshotRevision: this.snapshotRevision,
    }
  }

  /** Another actor's op accepted server-side; optionally delivered over WS. */
  appendForeign(actorId: string, patch: readonly WirePatchOp[], deliver = true): CollabServerOp {
    const op: CollabServerOp = {
      opId: `${actorId}#${this.revision + 1}`,
      actorId,
      baseRevision: this.revision,
      revision: ++this.revision,
      patch,
      timestamp: 500,
    }
    this.log.push(op)
    if (deliver) this.emit({ kind: 'op', op })
    return op
  }

  async postOp(op: CollabClientOp): Promise<PostOpOutcome> {
    this.postedOps.push(op)
    if (this.postHook) await this.postHook(op)
    if (this.protocolBroken || op.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
      return { kind: 'protocol-unsupported', supported: [COLLAB_PROTOCOL_VERSION] }
    }
    const dup = this.seen.get(op.opId)
    if (dup) return { kind: 'accepted', op: { ...dup, replayed: true } }
    if (this.snapshotRequiredOnce) {
      this.snapshotRequiredOnce = false
      return { kind: 'snapshot-required' }
    }
    if (op.baseRevision !== this.revision) return { kind: 'stale-base', revision: this.revision }
    const server: CollabServerOp = {
      opId: op.opId,
      actorId: op.actorId,
      baseRevision: op.baseRevision,
      revision: ++this.revision,
      patch: op.patch,
      timestamp: 1000,
    }
    this.log.push(server)
    this.seen.set(op.opId, server)
    if (this.wsAuto) this.emit({ kind: 'op', op: server })
    return { kind: 'accepted', op: server }
  }

  async fetchSnapshot(): Promise<{ readonly revision: number; readonly document: unknown }> {
    return { revision: this.snapshotRevision, document: this.snapshotDoc }
  }

  async fetchOps(after: number): Promise<FetchOpsOutcome> {
    if (this.retentionFloor !== undefined && after < this.retentionFloor) {
      return { kind: 'resync-required', snapshotRevision: this.snapshotRevision }
    }
    return { kind: 'ops', ops: this.log.filter((o) => o.revision > after) }
  }

  async putSnapshot(revision: number, document: WorkflowDocument): Promise<PutSnapshotOutcome> {
    this.putSnapshots.push(revision)
    this.putSnapshotDocuments.push(document)
    this.snapshotDoc = document
    this.snapshotRevision = revision
    return { kind: 'ok' }
  }

  sendPresence(payload: Json): void {
    this.sentPresence.push(payload)
  }

  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
  }
}

interface Harness {
  conn: FakeConnection
  session: SharedDocumentSession
  ops: SessionOp[]
  conflicts: SessionConflict[]
  errors: string[]
}

async function makeShared(
  actorId = 'actorA',
  document = baseDoc(),
  schemaResolverFor?: SharedSessionOptions['schemaResolverFor'],
  commandResolve?: (type: string) => NodeSchema | undefined,
): Promise<Harness> {
  const conn = new FakeConnection(document)
  const conflicts: SessionConflict[] = []
  const errors: string[] = []
  const session = await connectSharedSession(conn, coreCommandRegistry([], commandResolve), {
    actorId,
    clock: () => 42,
    retryDelay: () => tick(),
    onConflict: (c) => conflicts.push(c),
    onError: (m) => errors.push(m),
    onListenerError: () => {}, // resyncs log through here; keep test output clean
    ...(schemaResolverFor !== undefined && { schemaResolverFor }),
  })
  const ops: SessionOp[] = []
  session.onOp((op) => ops.push(op))
  return { conn, session, ops, conflicts, errors }
}

async function makePublishingShared(
  options: { readonly clock?: () => number; readonly snapshotRandom?: () => number } = {},
): Promise<Harness> {
  const conn = new FakeConnection(baseDoc())
  const conflicts: SessionConflict[] = []
  const errors: string[] = []
  const session = await connectSharedSession(conn, coreCommandRegistry(), {
    actorId: 'actorA',
    retryDelay: () => tick(),
    snapshotRandom: options.snapshotRandom ?? (() => 0),
    ...(options.clock !== undefined && { clock: options.clock }),
    onConflict: (c) => conflicts.push(c),
    onError: (m) => errors.push(m),
    onListenerError: () => {},
  })
  const ops: SessionOp[] = []
  session.onOp((op) => ops.push(op))
  conn.emit({ kind: 'connected', descriptor: conn.descriptor() })
  return { conn, session, ops, conflicts, errors }
}

function appendForeignTitles(conn: FakeConnection, from: number, through: number): void {
  for (let revision = from; revision <= through; revision++) {
    conn.appendForeign('peer', [
      revision === 1
        ? { op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: `remote-${revision}` }
        : { op: 'replace', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: `remote-${revision}` },
    ])
  }
}

const nodeIds = (s: SharedDocumentSession): string[] => Object.keys(s.doc.graphs.g0!.nodes)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shared DocumentSession', () => {
  it('re-executes an extract after an unrelated foreign op and drops it after an incident foreign op', async () => {
    const invocation = (document: WorkflowDocument) => ({
      command: 'subgraph.extract',
      params: {
        graphId: 'g0',
        instancePath: [],
        selection: { nodeIds: ['n1'] },
        selectionFingerprint: lifecycleSelectionFingerprint(document, 'g0', { nodeIds: ['n1'] })!,
        specializedSlotRoots: [],
        widgetTapSources: [],
        placementCenter: { x: 0, y: 0 },
        resolvedGeometry: [{ id: 'n1', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        name: 'Extracted',
      },
    })

    const unrelated = await makeShared('actorA')
    const unrelatedGate = deferred()
    unrelated.conn.postHook = () => unrelatedGate.promise
    expect(unrelated.session.dispatch(invocation(unrelated.session.doc)).ok).toBe(true)
    await until(() => unrelated.conn.postedOps.length === 1, 'extract POST held')
    unrelated.conn.appendForeign('peer', [
      { op: 'add', path: ['graphs', 'g1'], value: graph({ id: 'g1', nextOrdinal: 0 }) as unknown as Json },
      { op: 'add', path: ['view', 'graphs', 'g1'], value: { nodes: {} } },
    ])
    unrelatedGate.resolve()
    await unrelated.session.settle()
    expect(unrelated.conflicts).toEqual([])
    expect(unrelated.session.doc.graphs.g2).toBeDefined()
    expect(unrelated.session.doc.graphs.g0!.nodes['n0-actorA']).toMatchObject({ type: '#g2' })
    expect(unrelated.session.doc.graphs.g2!.nodes['n0-actorA']).toMatchObject({ type: 'X' })
    expect(unrelated.conn.log).toHaveLength(2)
    expect(unrelated.conn.postedOps).toHaveLength(2)
    expect(unrelated.conn.postedOps[1]!.baseRevision).toBe(1)
    expect(unrelated.conn.postedOps[1]!.opId).not.toBe(unrelated.conn.postedOps[0]!.opId)

    const incident = await makeShared('actorA')
    const incidentGate = deferred()
    incident.conn.postHook = () => incidentGate.promise
    expect(incident.session.dispatch(invocation(incident.session.doc)).ok).toBe(true)
    await until(() => incident.conn.postedOps.length === 1, 'stale extract POST held')
    incident.conn.appendForeign('peer', [
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'incident edit' },
    ])
    incidentGate.resolve()
    await incident.session.settle()
    expect(incident.conflicts).toHaveLength(1)
    expect(incident.conflicts[0]!.during).toBe('rebase')
    expect(incident.conflicts[0]!.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.lifecycle.stalePlan')
    expect(incident.session.doc.graphs.g1).toBeUndefined()
    expect(incident.conn.log).toHaveLength(1)
  })

  it.each([
    { case: 'T13: authorized flatten replay succeeds after an unrelated foreign op' },
    { case: 'T14: unrelated flatten replay does not consult the live resolver', checkResolver: true },
    { case: 'T15: incident foreign ops drop the flatten with stalePlan and leave the occurrence unchanged' },
    { case: 'T16: replay still refuses a corrupted pending flatten plan', corruptPending: true },
    { case: 'T17: caller mutation cannot change the owned flatten replay invocation', mutateCaller: true },
    { case: 'T18: validateDispatch sees initial, shared-replay, then initial contexts', checkContexts: true },
  ])('$case', async ({ checkResolver, corruptPending, mutateCaller, checkContexts }) => {
    const innerSchema = {
      type: 'X', displayName: 'X', category: 'test', source: 'v3' as const, isOutputNode: false,
      items: [{
        kind: 'input' as const, id: 'items', type: { kind: 'concrete' as const, name: 'X' }, optional: true,
        dynamic: {
          kind: 'autogrow' as const, naming: { kind: 'prefix' as const, prefix: 'item', min: 0, max: 8 },
          template: [
            { kind: 'input' as const, id: 'value', type: { kind: 'concrete' as const, name: 'X' }, optional: true,
              widget: { widgetType: 'INT', options: {}, controller: 'after_generate' as const } },
            { kind: 'input' as const, id: 'mode', type: { kind: 'concrete' as const, name: 'X' }, optional: true,
              dynamic: { kind: 'dynamicCombo' as const, options: [
                { key: 'a', label: 'A', inputs: [] }, { key: 'b', label: 'B', inputs: [] },
              ] } },
          ],
        },
      }],
    }
    const liveResolver = (type: string) => type === 'X' ? innerSchema : undefined
    const flattenDoc = () => doc({
      g0: graph({
        id: 'g0',
        nodes: {
          occurrence: {
            ...node('occurrence', '#body'),
            values: { 'input.value#x': 7, 'input.value#y': 8 },
            controllers: { 'input.value#x': 'fixed' },
            dynamic: {
              input: {
                members: ['x', 'y'],
                memberState: { x: { 'input.mode': { selected: 'b' } } },
              },
            },
          },
          unrelated: node('unrelated'),
          source: node('source'),
        },
        links: {
          familyLink: { id: asLinkId('familyLink'), from: port('source', 'out'), to: port('occurrence', 'input.value', ['x']) },
        },
        nets: {
          familyNet: { id: 'familyNet' as never, name: 'Family', source: port('source', 'net'), sinks: [port('occurrence', 'input.value', ['y'])] },
        },
        boundary: {
          inputs: [
            { id: 'unrelatedBoundary', binds: { kind: 'port', node: asNodeId('unrelated'), port: 'in' as never } },
            { id: 'incidentBoundary', binds: { kind: 'family', node: asNodeId('occurrence'), port: 'input' as never, slots: ['mode', 'value'] } },
          ],
          outputs: [],
        },
        actorCursors: { peer: 1000 },
      }),
      body: graph({
        id: 'body',
        nodes: { innerPrimary: node('innerPrimary'), innerAdditional: node('innerAdditional') },
        boundary: {
          inputs: [{
            id: 'input',
            binds: { kind: 'family', node: asNodeId('innerPrimary'), port: 'items' as never },
            alsoBinds: [{ kind: 'family', node: asNodeId('innerAdditional'), port: 'items' as never }],
          }],
          outputs: [],
        },
        nextOrdinal: 1,
      }),
    })
    const invocation = (document: WorkflowDocument) => {
      const schemaPlan = planFlattenBoundaryRoutes(
        document.graphs.body!,
        liveResolver,
        document.graphs.g0!.nodes.occurrence!,
        document.graphs.g0!,
      )
      const planEvidence = {
        boundaryPlan: schemaPlan.boundaryPlan,
        statePlan: schemaPlan.statePlan,
        schemaPlanDigest: schemaPlan.schemaPlanDigest,
      }
      return {
        command: 'subgraph.flatten',
        params: {
        graphId: 'g0',
        instancePath: [],
        nodeId: 'occurrence',
        placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [
            { id: 'innerPrimary', kind: 'node', x: 0, y: 0, width: 140, height: 80 },
            { id: 'innerAdditional', kind: 'node', x: 180, y: 0, width: 140, height: 80 },
          ],
        },
          boundaryPlan: schemaPlan.boundaryPlan as unknown as Json,
          statePlan: schemaPlan.statePlan as unknown as Json,
          schemaSnapshot: schemaPlan.schemaSnapshot as unknown as Json,
          schemaPlanDigest: schemaPlan.schemaPlanDigest,
          selectionFingerprint: lifecycleFlattenFingerprint(document, 'g0', 'occurrence', planEvidence)!,
        },
      }
    }

    const contextKinds: string[] = []
    const definition = coreCommandRegistry().get('subgraph.flatten')!
    const originalValidate = definition.validateDispatch!
    const contextProbe = checkContexts
      ? vi.spyOn(definition as typeof definition & { validateDispatch: typeof originalValidate }, 'validateDispatch')
        .mockImplementation((document, params, context) => {
          contextKinds.push(context.kind)
          return originalValidate.call(definition, document, params, context)
        })
      : undefined

    let resolverFactoryCalls = 0
    let resolverMayRun = true
    const resolverFactory = () => {
      resolverFactoryCalls++
      if (!resolverMayRun) throw new Error('live resolver must not run during shared replay')
      return liveResolver
    }
    const unrelated = await makeShared('actorA', flattenDoc(), resolverFactory)
    const unrelatedGate = deferred()
    unrelated.conn.postHook = () => unrelatedGate.promise
    const callerInvocation = invocation(unrelated.session.doc)
    expect(unrelated.session.dispatch(callerInvocation).ok).toBe(true)
    expect(resolverFactoryCalls).toBeGreaterThan(0)
    await until(() => unrelated.conn.postedOps.length === 1, 'flatten POST held')
    if (mutateCaller) {
      callerInvocation.params.schemaPlanDigest = 'caller-mutated'
      callerInvocation.params.statePlan = { status: 'refused' } as unknown as Json
    }
    if (corruptPending) {
      const privateSession = unrelated.session as unknown as {
        pending: Array<{ invocation: ReturnType<typeof invocation> }>
      }
      const corruptInvocation = structuredClone(privateSession.pending[0]!.invocation)
      corruptInvocation.params.schemaPlanDigest = 'corrupt-pending-digest'
      privateSession.pending[0] = { ...privateSession.pending[0]!, invocation: corruptInvocation }
    }
    resolverMayRun = !checkResolver
    unrelated.conn.appendForeign('peer', [
      { op: 'add', path: ['graphs', 'g0', 'boundary', 'inputs', 0, 'displayName'], value: 'peer edit' },
    ])
    unrelatedGate.resolve()
    await unrelated.session.settle()
    if (corruptPending) {
      expect(unrelated.conflicts).toHaveLength(1)
      expect(unrelated.conflicts[0]!.during).toBe('rebase')
      expect(unrelated.conflicts[0]!.diagnostics.map((diagnostic) => diagnostic.code))
        .toContain('params.invalid')
      expect(unrelated.session.doc.graphs.g0!.nodes.occurrence).toBeDefined()
      expect(unrelated.conn.log).toHaveLength(1)
      return
    }
    expect(unrelated.conflicts).toEqual([])
    if (checkResolver) expect(resolverFactoryCalls).toBe(1)
    expect(unrelated.session.doc.graphs.g0!.nodes.occurrence).toBeUndefined()
    for (const id of ['n0-actorA', 'n1-actorA']) {
      expect(unrelated.session.doc.graphs.g0!.nodes[id]).toMatchObject({ type: 'X' })
      expect(unrelated.session.doc.graphs.g0!.nodes[id]!.values).toEqual({ 'items.value#m0': 7, 'items.value#m1': 8 })
      expect(unrelated.session.doc.graphs.g0!.nodes[id]!.controllers).toEqual({ 'items.value#m0': 'fixed' })
      expect(unrelated.session.doc.graphs.g0!.nodes[id]!.dynamic).toMatchObject({
        items: { members: ['m0', 'm1'] },
      })
    }
    expect(unrelated.session.doc.graphs.g0!.boundary!.inputs[1]!.binds).toEqual({
      kind: 'family', node: 'n1-actorA', port: 'items', slots: ['value', 'mode'],
    })
    expect(unrelated.session.doc.graphs.g0!.boundary!.inputs[1]!.alsoBinds).toEqual([{
      kind: 'family', node: 'n0-actorA', port: 'items', slots: ['value', 'mode'],
    }])
    expect(unrelated.session.doc.graphs.body).toBeDefined()
    expect(unrelated.conn.log).toHaveLength(2)
    expect(unrelated.conn.postedOps).toHaveLength(2)

    const incident = await makeShared('actorA', flattenDoc(), () => liveResolver)
    const incidentGate = deferred()
    incident.conn.postHook = () => incidentGate.promise
    expect(incident.session.dispatch(invocation(incident.session.doc)).ok).toBe(true)
    await until(() => incident.conn.postedOps.length === 1, 'stale flatten POST held')
    incident.conn.appendForeign('peer', [
      { op: 'add', path: ['surfaces'], value: {
        panel: {
          id: 'panel',
          type: 'core.modePanel',
          config: { bindings: [{ kind: 'node', graphId: 'g0', nodeId: 'occurrence' }] },
        },
      } },
    ])
    incidentGate.resolve()
    await incident.session.settle()
    expect(incident.conflicts).toHaveLength(1)
    expect(incident.conflicts[0]!.during).toBe('rebase')
    expect(incident.conflicts[0]!.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.lifecycle.stalePlan')
    expect(incident.session.doc.graphs.g0!.nodes.occurrence).toBeDefined()
    expect(incident.conn.log).toHaveLength(1)
    if (checkContexts) expect(contextKinds.slice(0, 3)).toEqual(['initial', 'shared-replay', 'initial'])
    contextProbe?.mockRestore()

    const surfaceIncident = await makeShared('actorA', flattenDoc(), () => liveResolver)
    const surfaceGate = deferred()
    surfaceIncident.conn.postHook = () => surfaceGate.promise
    expect(surfaceIncident.session.dispatch(invocation(surfaceIncident.session.doc)).ok).toBe(true)
    await until(() => surfaceIncident.conn.postedOps.length === 1, 'surface-stale flatten POST held')
    surfaceIncident.conn.appendForeign('peer', [{
      op: 'add',
      path: ['surfaces'],
      value: {
        panel: {
          id: 'panel',
          type: 'core.modePanel',
          config: { bindings: [{ kind: 'node', graphId: 'g0', nodeId: 'occurrence' }] },
        },
      },
    }])
    surfaceGate.resolve()
    await surfaceIncident.session.settle()
    expect(surfaceIncident.conflicts).toHaveLength(1)
    expect(surfaceIncident.conflicts[0]!.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.lifecycle.stalePlan')
    expect(surfaceIncident.session.doc.graphs.g0!.nodes.occurrence).toBeDefined()
    expect(surfaceIncident.conn.log).toHaveLength(1)
  })

  it.each([
    {
      case: 'direct count edit',
      invocation: {
        command: 'node.setOutputCount',
        params: {
          graphId: 'g0', nodeId: 'occurrence', inputId: 'amount', value: 3, removedLinks: 'preserve',
        },
      },
    },
    {
      case: 'count edit inside a batch',
      invocation: {
        command: 'batch',
        params: {
          invocations: [{
            command: 'node.setOutputCount',
            params: {
              graphId: 'g0', nodeId: 'occurrence', inputId: 'amount', value: 3, removedLinks: 'preserve',
            },
          }],
        },
      },
    },
  ])('retains a derived-schema $case across an unrelated shared-session rebase', async ({ invocation }) => {
    const resolve = (type: string): NodeSchema | undefined =>
      type === 'CountOutput' ? countOutputSchema : undefined
    const { conn, session, conflicts } = await makeShared(
      'actorA',
      derivedCountDoc(),
      (document) => documentResolver(document, resolve),
    )
    const postGate = deferred()
    conn.postHook = () => postGate.promise

    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes.occurrence!.values.amount).toBe(3)
    await until(() => conn.postedOps.length === 1, 'count edit POST held')
    conn.appendForeign('peer', [
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'unrelated', 'title'], value: 'peer edit' },
    ])
    postGate.resolve()
    await session.settle()

    expect(conflicts).toEqual([])
    expect(session.doc.graphs.g0!.nodes.occurrence!.values.amount).toBe(3)
    expect(conn.log).toHaveLength(2)
    expect(conn.postedOps).toHaveLength(2)
  })

  it.each([
    {
      case: 'direct count edit',
      invocation: {
        command: 'node.setOutputCount',
        params: {
          graphId: 'g0', nodeId: 'alias', inputId: 'count', value: 3, removedLinks: 'preserve',
        },
      },
    },
    {
      case: 'count edit inside a batch',
      invocation: {
        command: 'batch',
        params: {
          invocations: [{
            command: 'node.setOutputCount',
            params: {
              graphId: 'g0', nodeId: 'alias', inputId: 'count', value: 3, removedLinks: 'preserve',
            },
          }],
        },
      },
    },
  ])('retains an alias-authored shared $case across rebase', async ({ invocation }) => {
    let resolverEnabled = true
    let resolverCalls = 0
    const aliasSchema: NodeSchema = { ...countOutputSchema, aliases: ['LegacyCountOutput'] }
    const resolve = (type: string): NodeSchema | undefined => {
      resolverCalls++
      if (!resolverEnabled) throw new Error('mutable alias resolver must not run during shared replay')
      return type === 'LegacyCountOutput' ? aliasSchema : undefined
    }
    const document = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          alias: { ...node('alias', 'LegacyCountOutput'), values: { count: 1 } },
        },
      }),
    })
    const { conn, session, conflicts } = await makeShared('actorA', document, undefined, resolve)
    const postGate = deferred()
    conn.postHook = () => postGate.promise

    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes.alias!.type).toBe('LegacyCountOutput')
    expect(session.doc.graphs.g0!.nodes.alias!.values.count).toBe(3)
    const callsAfterInitialDispatch = resolverCalls
    resolverEnabled = false
    await until(() => conn.postedOps.length === 1, 'alias count POST held')
    conn.appendForeign('peer', [
      { op: 'replace', path: ['graphs', 'g0', 'name'], value: 'peer edit' },
    ])
    postGate.resolve()
    await session.settle()

    expect(conflicts).toEqual([])
    expect(resolverCalls).toBe(callsAfterInitialDispatch)
    expect(session.doc.graphs.g0!.nodes.alias!.type).toBe('LegacyCountOutput')
    expect(session.doc.graphs.g0!.nodes.alias!.values.count).toBe(3)
    expect(conn.log).toHaveLength(2)
    expect(conn.postedOps).toHaveLength(2)
  })

  it('prepares a count edit against earlier actor-scoped writes in the same batch', async () => {
    let resolverEnabled = true
    let resolverCalls = 0
    const resolve = (type: string): NodeSchema | undefined => {
      resolverCalls++
      if (!resolverEnabled) throw new Error('mutable registry resolver must not run during shared replay')
      return type === 'CountOutput' ? countOutputSchema : undefined
    }
    const { conn, session, conflicts } = await makeShared('actorA', baseDoc(), undefined, resolve)
    const postGate = deferred()
    conn.postHook = () => postGate.promise
    const invocation = {
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'node.add',
            params: { graphId: 'g0', type: 'CountOutput', position: { x: 0, y: 0 } },
          },
          {
            command: 'node.setOutputCount',
            params: {
              graphId: 'g0', nodeId: 'n0-actorA', inputId: 'count', value: 3, removedLinks: 'preserve',
            },
          },
        ],
      },
    }

    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes['n0-actorA']!.values.count).toBe(3)
    const callsAfterInitialDispatch = resolverCalls
    expect(callsAfterInitialDispatch).toBeGreaterThan(0)
    resolverEnabled = false
    await until(() => conn.postedOps.length === 1, 'sequential batch POST held')
    conn.appendForeign('peer', [
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'peer edit' },
    ])
    postGate.resolve()
    await session.settle()

    expect(conflicts).toEqual([])
    expect(resolverCalls).toBe(callsAfterInitialDispatch)
    expect(session.doc.graphs.g0!.nodes['n0-actorA']!.values.count).toBe(3)
    expect(conn.log).toHaveLength(2)
    expect(conn.postedOps).toHaveLength(2)
  })

  it('rejects an unpreparable schema-sensitive batch atomically and still rejects nested batches loudly', async () => {
    let resolverCalls = 0
    const resolve = (type: string): NodeSchema | undefined => {
      resolverCalls++
      return resolverCalls === 1 || type !== 'CountOutput' ? undefined : countOutputSchema
    }
    const { conn, session } = await makeShared('actorA', baseDoc(), undefined, resolve)
    const missingSchema = session.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'node.add',
            params: { graphId: 'g0', type: 'CountOutput', position: { x: 0, y: 0 } },
          },
          {
            command: 'node.setOutputCount',
            params: {
              graphId: 'g0', nodeId: 'n0-actorA', inputId: 'count', value: 3, removedLinks: 'preserve',
            },
          },
        ],
      },
    })
    expect(missingSchema.ok).toBe(false)
    if (!missingSchema.ok) expect(missingSchema.diagnostics.map((diagnostic) => diagnostic.code)).toContain('schema.missing')
    expect(session.doc.graphs.g0!.nodes['n0-actorA']).toBeUndefined()
    expect(conn.postedOps).toEqual([])
    expect(resolverCalls).toBe(1)

    const nested = session.dispatch({
      command: 'batch',
      params: { invocations: [{ command: 'batch', params: { invocations: [addNode] } }] },
    })
    expect(nested.ok).toBe(false)
    if (!nested.ok) expect(nested.diagnostics[0]!.code).toBe('batch.nested')
    expect(conn.postedOps).toEqual([])
  })

  it('predicts the first actor-scoped node id before an actor cursor exists', async () => {
    const { session } = await makeShared('actorA')
    const predicted = session.predictedNodeId('g0')
    expect(predicted).toBe('n0-actorA')
    expect(session.dispatch(addNode).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes[predicted!]).toBeDefined()
  })

  it('predicts from its own cursor when remote cursors and nextOrdinal diverge', async () => {
    const document = doc({
      g0: graph({
        id: 'g0',
        nextOrdinal: 700,
        nodes: { 'n39-peer': node('n39-peer') },
        actorCursors: { peer: 40, actorA: 7 },
      }),
    })
    const { session } = await makeShared('actorA', document)
    const predicted = session.predictedNodeId('g0')
    expect(predicted).toBe('n7-actorA')
    expect(session.dispatch(addNode).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes[predicted!]).toBeDefined()
    expect(session.predictedNodeId('missing')).toBeUndefined()
  })

  it('joins from the snapshot: document loaded, revision = snapshot revision', async () => {
    const { session } = await makeShared()
    expect(session.revision).toBe(0)
    expect(nodeIds(session)).toEqual(['n1', 'n2'])
    expect(session.document.get()).toBe(session.doc)
    expect(session.status.get()).toBe('live')
  })

  it('rejects a snapshot that fails document load', async () => {
    const conn = new FakeConnection({ format: 'nonsense' })
    await expect(connectSharedSession(conn, coreCommandRegistry())).rejects.toThrow(
      /snapshot failed to load/,
    )
  })

  it('dispatch is optimistic: document updates before the server answers', async () => {
    const { conn, session } = await makeShared()
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    const out = session.dispatch(addNode)
    expect(out.ok).toBe(true)
    expect(nodeIds(session)).toHaveLength(3)
    expect(session.revision).toBe(1) // optimistic: confirmed 0 + pending 1
    gate.resolve()
    await session.settle()
    expect(session.revision).toBe(1) // confirmed 1 + pending 0
  })

  it('synchronizes frontend virtual node data through the ordinary shared-session path', async () => {
    const { session } = await makeShared('actorA')
    expect(session.dispatch({
      command: 'node.add',
      params: {
        graphId: 'g0',
        type: 'dinkster.note',
        virtual: true,
        position: { x: 12, y: 34 },
        values: { text: 'Shared note' },
        title: 'Review',
      },
    }).ok).toBe(true)
    await session.settle()
    const added = Object.values(session.doc.graphs.g0!.nodes)
      .find((candidate) => candidate.type === 'dinkster.note')
    expect(added).toMatchObject({
      type: 'dinkster.note',
      virtual: true,
      title: 'Review',
      values: { text: 'Shared note' },
    })
    expect(session.doc.view.graphs.g0!.nodes[added!.id]?.position).toEqual({ x: 12, y: 34 })
  })

  it('stamps its actorId on every invocation: minted ids are actor-scoped', async () => {
    const { session } = await makeShared('actorA')
    session.dispatch(addNode)
    await session.settle()
    const minted = nodeIds(session).find((id) => !['n1', 'n2'].includes(id))
    expect(minted).toMatch(/-actorA$/)
  })

  it('exposes allocationActor so external planners mint the ids dispatch will allocate', async () => {
    const document = {
      ...baseDoc(),
      view: { graphs: { g0: { nodes: { n1: { position: { x: 0, y: 0 } }, n2: { position: { x: 50, y: 0 } } } } } },
    }
    const { session } = await makeShared('actorA', document)
    expect(session.allocationActor).toBe('actorA')
    const envelope = JSON.parse(JSON.stringify(
      serializeSelection(session.doc, 'g0', { nodes: ['n1'], reroutes: [] }),
    )) as DinksterClipboardEnvelope
    // Planned with the session's allocation scope, the plan's ids match the
    // dispatch allocation: the connected-paste batch's dynamic.compact steps
    // find their nodes and the batch commits.
    const plan = planClipboardPaste(session.doc, 'g0', envelope, { x: 5, y: 5 }, session.allocationActor, true)!
    expect(session.dispatch(plan.invocation).ok).toBe(true)
    await session.settle()
    expect(plan.nodeIds.every((id) => session.doc.graphs.g0!.nodes[id] !== undefined)).toBe(true)
    // Planned without the actor, the predicted plain ids diverge from the
    // actor-scoped allocation, so the batch's dynamic.compact steps name
    // nodes that never exist and the batch is refused atomically.
    const unscoped = planClipboardPaste(session.doc, 'g0', envelope, { x: 15, y: 15 }, undefined, true)!
    const docBefore = session.doc
    const revisionBefore = session.revision
    expect(session.dispatch(unscoped.invocation).ok).toBe(false)
    // The refusal is atomic: nothing from the batch landed.
    expect(session.doc).toBe(docBefore)
    expect(session.revision).toBe(revisionBefore)
  })

  it('acks through the WS echo arriving before the POST response, emitting once', async () => {
    const { conn, session, ops } = await makeShared('actorA')
    // wsAuto emits the echo synchronously inside postOp, before the response.
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ actorId: 'actorA', baseRevision: 0, revision: 1, origin: 'node.setTitle' })
    expect(conn.postedOps).toHaveLength(1)
    expect(session.revision).toBe(1)
  })

  it('acks through the POST response when the WS is silent', async () => {
    const { conn, session, ops } = await makeShared('actorA')
    conn.wsAuto = false
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(ops).toHaveLength(1)
    expect(session.revision).toBe(1)
    // Late WS echo of the same op is a duplicate: ignored, not re-applied.
    conn.emit({ kind: 'op', op: conn.log[0]! })
    expect(ops).toHaveLength(1)
    expect(session.revision).toBe(1)
  })

  it('applies a foreign op: document advances, feed emits origin remote', async () => {
    const { conn, session, ops } = await makeShared()
    conn.appendForeign('peer', foreignAddNode('n9-peer'))
    expect(nodeIds(session)).toContain('n9-peer')
    expect(session.revision).toBe(1)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ actorId: 'peer', revision: 1, origin: 'remote' })
  })

  it('catches up past the snapshot when the connected descriptor was buffered before subscription', async () => {
    // The real connection opens its WS in its constructor, so the
    // descriptor frame (catch-up baseline) can arrive while
    // connectSharedSession is still awaiting the HTTP snapshot; the
    // connection buffers it and replays it synchronously inside onEvent.
    // Found live 2026-07-27: without the replay, a rejoin whose session
    // already held ops above the snapshot revision never caught up.
    const conn = new FakeConnection(baseDoc())
    conn.appendForeign('peer', foreignAddNode('n9-peer'), false) // pre-join op; snapshot stays at 0
    const subscribe = conn.onEvent.bind(conn)
    const pending: CollabConnectionEvent[] = [{ kind: 'connected', descriptor: conn.descriptor() }]
    conn.onEvent = (listener) => {
      const off = subscribe(listener)
      for (const e of pending.splice(0)) listener(e)
      return off
    }
    const session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      onListenerError: () => {},
    })
    await until(() => session.revision === 1, 'catch-up to the pre-join op')
    expect(nodeIds(session)).toContain('n9-peer')
    session.close()
  })

  it('a session_closed replayed synchronously at subscription closes the session cleanly', async () => {
    const conn = new FakeConnection(baseDoc())
    const subscribe = conn.onEvent.bind(conn)
    let detached = 0
    conn.onEvent = (listener) => {
      const off = subscribe(listener)
      listener({ kind: 'session-closed' }) // delivered mid-constructor
      return () => {
        detached += 1
        off()
      }
    }
    const session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      onListenerError: () => {},
    })
    expect(session.status.get()).toBe('closed')
    expect(conn.closed).toBe(true)
    // The close ran BEFORE the constructor assigned the unsubscribe; the
    // constructor must detach the late-assigned listener itself, exactly
    // once (a repeated close is idempotent, not a double-detach).
    expect(detached).toBe(1)
    session.close()
    expect(detached).toBe(1)
  })

  it('rebases pending intentions over a foreign op and wins the stale-base race', async () => {
    const { conn, session, ops } = await makeShared('actorA')
    const gate = deferred()
    conn.postHook = (op) => {
      conn.postHook = undefined
      return gate.promise
    }
    session.dispatch(setTitle('n1', 'mine'))
    // Submission starts on a microtask (single-flight marker first), so wait
    // for the POST to actually be in flight before racing it.
    await until(() => conn.postedOps.length === 1, 'first POST in flight')
    // Foreign op lands while our POST is in flight: rebase re-executes the
    // pending intention; the in-flight POST answers 409 stale-base.
    conn.appendForeign('peer', foreignAddNode('n9-peer'))
    expect(nodeIds(session)).toContain('n9-peer') // rebase kept optimistic edit on top
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('mine')
    gate.resolve()
    await session.settle()
    expect(session.revision).toBe(2)
    expect(ops.map((o) => [o.revision, o.origin])).toEqual([
      [1, 'remote'],
      [2, 'node.setTitle'],
    ])
    // The resubmission used a FRESH opId (the rebase re-minted it): reusing
    // the old one would collide with the server's idempotent-resubmit dedup.
    expect(conn.postedOps).toHaveLength(2)
    expect(conn.postedOps[1]!.opId).not.toBe(conn.postedOps[0]!.opId)
    expect(conn.postedOps[1]!.baseRevision).toBe(1)
  })

  it('drops a pending intention the rebase can no longer execute and surfaces the conflict', async () => {
    const { conn, session, conflicts } = await makeShared('actorA')
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    session.dispatch(setTitle('n2', 'doomed'))
    conn.appendForeign('peer', foreignRemoveNode('n2'))
    gate.resolve()
    await session.settle()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.during).toBe('rebase')
    expect(conflicts[0]!.invocation.command).toBe('node.setTitle')
    expect(nodeIds(session)).toEqual(['n1'])
    expect(session.revision).toBe(1) // only the foreign op; nothing of ours shipped
  })

  it('drops image.applyAsset when a concurrent edit replaces its source AssetRef', async () => {
    const resolve = () => (type: string) => type === imageSchema.type ? imageSchema : undefined
    const { conn, session, conflicts } = await makeShared('actorA', imageDoc(), resolve, resolve())
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    expect(session.dispatch(applyImage).ok).toBe(true)
    await until(() => conn.postedOps.length === 1, 'image apply POST in flight')
    conn.appendForeign('actorB', [{
      op: 'replace',
      path: ['graphs', 'g0', 'nodes', 'image', 'values', 'image'],
      value: imageRef(IMAGE_FOREIGN, 'foreign.png'),
    }])
    gate.resolve()
    await session.settle()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.during).toBe('rebase')
    expect(conflicts[0]!.invocation.command).toBe('image.applyAsset')
    expect(conflicts[0]!.diagnostics.map((diagnostic) => diagnostic.code)).toContain('image.sourceChanged')
    expect(session.doc.graphs.g0!.nodes.image!.values.image).toEqual(imageRef(IMAGE_FOREIGN, 'foreign.png'))
    expect(session.revision).toBe(1)
  })

  it('keeps the pending FIFO across remote interleaving: both local ops land in order', async () => {
    const { conn, session, ops } = await makeShared('actorA')
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    session.dispatch(setTitle('n1', 'one'))
    session.dispatch(setTitle('n2', 'two'))
    conn.appendForeign('peer', foreignAddNode('n9-peer'))
    gate.resolve()
    await session.settle()
    expect(session.revision).toBe(3)
    expect(ops.map((o) => [o.revision, o.origin])).toEqual([
      [1, 'remote'],
      [2, 'node.setTitle'],
      [3, 'node.setTitle'],
    ])
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('one')
    expect((session.doc.graphs.g0!.nodes.n2 as { title?: string }).title).toBe('two')
  })

  it('transforms a pending text splice over a foreign splice to preserve both edits', async () => {
    const { conn, session } = await makeShared('actorA', textDoc())
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    expect(session.dispatch(spliceText(5, 0, '!')).ok).toBe(true)
    await until(() => conn.postedOps.length === 1, 'text splice POST in flight')
    conn.appendForeign('actorB', replaceText('Xhello'))
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('Xhello!')
    gate.resolve()
    await session.settle()
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('Xhello!')
    expect(conn.log).toHaveLength(2)
  })

  it('transforms a FIFO of pending typing intentions with an old-document cursor', async () => {
    const { conn, session } = await makeShared('actorA', textDoc('abc'))
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    expect(session.dispatch(spliceText(3, 0, '1')).ok).toBe(true)
    expect(session.dispatch(spliceText(4, 0, '2')).ok).toBe(true)
    expect(session.dispatch(spliceText(5, 0, '3')).ok).toBe(true)
    await until(() => conn.postedOps.length === 1, 'typing POST in flight')
    conn.appendForeign('actorB', replaceText('Xabc'))
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('Xabc123')
    gate.resolve()
    await session.settle()
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('Xabc123')
    expect(conn.log).toHaveLength(4)
  })

  it('drops a pending text splice when a foreign op deletes its node', async () => {
    const { conn, session, conflicts } = await makeShared('actorA', textDoc())
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    expect(session.dispatch(spliceText(5, 0, '!')).ok).toBe(true)
    await until(() => conn.postedOps.length === 1, 'text splice POST in flight')
    conn.appendForeign('actorB', foreignRemoveNode('n1'))
    gate.resolve()
    await session.settle()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.invocation.command).toBe('text.splice')
    expect(conflicts[0]!.during).toBe('rebase')
    expect(session.doc.graphs.g0!.nodes.n1).toBeUndefined()
  })

  it('keeps whole-value clobber semantics for node.setValue during rebase', async () => {
    const { conn, session } = await makeShared('actorA', textDoc())
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    expect(session.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', value: 'mine' },
    }).ok).toBe(true)
    await until(() => conn.postedOps.length === 1, 'setValue POST in flight')
    conn.appendForeign('actorB', replaceText('theirs'))
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('mine')
    gate.resolve()
    await session.settle()
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('mine')
  })

  it('transforms a pending text splice over a snapshot resync document', async () => {
    const { conn, session } = await makeShared('actorA', textDoc())
    expect(session.dispatch(spliceText(5, 0, '!')).ok).toBe(true)
    conn.snapshotDoc = textDoc('Xhello')
    conn.snapshotRevision = 1
    conn.revision = 1
    conn.emit({
      kind: 'op',
      op: {
        opId: 'actorB#bad',
        actorId: 'actorB',
        baseRevision: 0,
        revision: 1,
        patch: [{ op: 'move', path: ['x'], value: 1 } as unknown as WirePatchOp],
        timestamp: 1,
      },
    })
    await until(() => session.status.get() === 'live' && conn.log.length === 1, 'snapshot rebase and submit')
    await session.settle()
    expect(session.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('Xhello!')
    expect(session.revision).toBe(2)
  })

  it('retries a transport failure idempotently with the SAME opId', async () => {
    const { conn, session } = await makeShared('actorA')
    let failed = false
    conn.postHook = () => {
      if (!failed) {
        failed = true
        throw new Error('network down')
      }
      conn.postHook = undefined
    }
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(conn.postedOps).toHaveLength(2)
    expect(conn.postedOps[1]!.opId).toBe(conn.postedOps[0]!.opId)
    expect(session.revision).toBe(1)
  })

  it('repairs a WS gap through HTTP catch-up without loss or duplication', async () => {
    const { conn, session, ops } = await makeShared()
    conn.appendForeign('peer', foreignAddNode('n8-peer'), false) // missed (reconnect window)
    conn.appendForeign('peer', foreignAddNode('n9-peer')) // delivered: reveals the gap
    await until(() => session.revision === 2, 'catch-up to revision 2')
    expect(nodeIds(session)).toEqual(expect.arrayContaining(['n8-peer', 'n9-peer']))
    expect(ops.map((o) => o.revision)).toEqual([1, 2])
    expect(session.status.get()).toBe('live')
  })

  it('catches up from the reconnect descriptor baseline', async () => {
    const { conn, session } = await makeShared()
    conn.appendForeign('peer', foreignAddNode('n8-peer'), false)
    conn.appendForeign('peer', foreignAddNode('n9-peer'), false)
    conn.emit({ kind: 'disconnected' })
    conn.emit({ kind: 'connected', descriptor: conn.descriptor() })
    await until(() => session.revision === 2, 'catch-up to revision 2')
    expect(nodeIds(session)).toEqual(expect.arrayContaining(['n8-peer', 'n9-peer']))
  })

  it('resyncs from the snapshot when catch-up hits the retention floor (410)', async () => {
    const { conn, session } = await makeShared()
    // Server pruned the log: snapshot is ahead, old ops unavailable.
    conn.snapshotDoc = doc({
      g0: graph({
        id: 'g0',
        nodes: { 'n1': node('n1'), 'n7-peer': node('n7-peer') },
        actorCursors: { peer: 1000 },
      }),
    })
    conn.snapshotRevision = 7
    conn.revision = 7
    conn.retentionFloor = 7
    conn.emit({ kind: 'connected', descriptor: conn.descriptor() })
    await until(() => session.revision === 7, 'resync to revision 7')
    expect(nodeIds(session)).toEqual(['n1', 'n7-peer'])
    expect(session.status.get()).toBe('live')
  })

  it('rejects a malformed foreign op and resyncs instead of applying it', async () => {
    const { conn, session, ops } = await makeShared()
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 1
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#1',
        actorId: 'peer',
        baseRevision: 0,
        revision: 1,
        // Dangling-link garbage: applies as JSON but fails the invariant check.
        patch: [{ op: 'remove', path: ['graphs', 'g0'] }],
        timestamp: 1,
      },
    })
    await until(() => session.revision === 1 && session.status.get() === 'live', 'resync')
    expect(nodeIds(session)).toEqual(['n1', 'n2']) // snapshot state, not the bad op
    expect(ops.filter((o) => o.origin === 'remote')).toHaveLength(0)
  })

  it.each([
    ['unknown key', { kind: 'map', surprise: true }],
    ['legacy outputModes', { kind: 'map', outputModes: { items: 'gather' } }],
    ['wrong binding type', { kind: 'map', binding: 17 }],
    ['non-numeric maxIterations', { kind: 'map', maxIterations: 'unbounded' }],
    ['malformed output role', { kind: 'fold', statePorts: ['state'], outputRoles: { result: { kind: 'state' } } }],
  ])('rejects a foreign op with malformed region shape and resyncs: %s', async (_label, region) => {
    const { conn, session, ops } = await makeShared()
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 1
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#1',
        actorId: 'peer',
        baseRevision: 0,
        revision: 1,
        patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'region'], value: region as Json }],
        timestamp: 1,
      },
    })
    await until(() => session.revision === 1 && session.status.get() === 'live', 'region shape resync')
    expect(session.doc.graphs.g0!.nodes.n1!.region).toBeUndefined()
    expect(ops.filter((o) => o.origin === 'remote')).toHaveLength(0)
  })

  it('rejects a foreign boundary with duplicate input/output ids and resyncs', async () => {
    const { conn, session, ops } = await makeShared()
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 1
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#1',
        actorId: 'peer',
        baseRevision: 0,
        revision: 1,
        patch: [{
          op: 'add',
          path: ['graphs', 'g0', 'boundary'],
          value: {
            inputs: [{ id: 'state', binds: { kind: 'port', node: 'n1', port: 'in' } }],
            outputs: [{ id: 'state', binds: { kind: 'port', node: 'n2', port: 'out' } }],
          },
        }],
        timestamp: 1,
      },
    })
    await until(() => session.revision === 1 && session.status.get() === 'live', 'boundary duplicate resync')
    expect(session.doc.graphs.g0!.boundary).toBeUndefined()
    expect(ops.filter((o) => o.origin === 'remote')).toHaveLength(0)
  })

  it('checkpoints and resubmits on 409 snapshot-required', async () => {
    const { conn, session } = await makeShared()
    conn.snapshotRequiredOnce = true
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(conn.putSnapshots).toEqual([0]) // checkpoint at confirmed head
    expect(session.revision).toBe(1)
  })

  it('publishes revision 200 from confirmed state without optimistic pending contamination', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { conn, session } = await makePublishingShared()
    appendForeignTitles(conn, 1, 199)
    const postGate = deferred()
    conn.postHook = () => postGate.promise
    session.dispatch(setTitle('n2', 'optimistic-only'))
    await until(() => conn.postedOps.length === 1, 'pending local POST')
    appendForeignTitles(conn, 200, 200)
    await until(() => conn.putSnapshots.length === 1, 'periodic checkpoint')
    expect(conn.putSnapshots).toEqual([200])
    const published = conn.putSnapshotDocuments[0]!
    expect((published.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('remote-200')
    expect((published.graphs.g0!.nodes.n2 as { title?: string }).title).toBeUndefined()
    expect((session.doc.graphs.g0!.nodes.n2 as { title?: string }).title).toBe('optimistic-only')
    postGate.resolve()
    await session.settle()
    info.mockRestore()
  })

  it('keeps one snapshot PUT in flight while confirmed ops continue arriving', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { conn, session } = await makePublishingShared()
    const putGate = deferred()
    conn.putSnapshot = async (revision, document) => {
      conn.putSnapshots.push(revision)
      conn.putSnapshotDocuments.push(document)
      await putGate.promise
      conn.snapshotRevision = revision
      conn.snapshotDoc = document
      return { kind: 'ok' }
    }
    appendForeignTitles(conn, 1, 205)
    expect(conn.putSnapshots).toEqual([200])
    putGate.resolve()
    await until(() => conn.snapshotRevision === 200, 'checkpoint completion')
    expect(conn.putSnapshots).toHaveLength(1)
    session.close()
    info.mockRestore()
  })

  it('shares one in-flight PUT between periodic publication and snapshot-required backpressure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { conn, session } = await makePublishingShared()
    const putGate = deferred()
    conn.putSnapshot = async (revision, document) => {
      conn.putSnapshots.push(revision)
      await putGate.promise
      conn.snapshotRevision = revision
      conn.snapshotDoc = document
      return { kind: 'ok' }
    }
    appendForeignTitles(conn, 1, 200)
    expect(conn.putSnapshots).toEqual([200])
    conn.snapshotRequiredOnce = true
    session.dispatch(setTitle('n2', 'after-checkpoint'))
    await until(() => conn.postedOps.length === 1, 'snapshot-required response')
    putGate.resolve()
    await session.settle()
    expect(conn.putSnapshots).toEqual([200])
    expect(conn.postedOps).toHaveLength(2)
    expect(session.revision).toBe(201)
    info.mockRestore()
  })

  it('treats snapshot-invalid as a benign competing publish and resets to GET snapshot revision', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { conn, session } = await makePublishingShared()
    conn.putSnapshot = async (revision, document) => {
      conn.putSnapshots.push(revision)
      conn.snapshotRevision = revision
      conn.snapshotDoc = document
      return { kind: 'conflict' }
    }
    appendForeignTitles(conn, 1, 200)
    await until(() => conn.snapshotRevision === 200, 'competing checkpoint observation')
    appendForeignTitles(conn, 201, 399)
    await tick()
    expect(conn.putSnapshots).toEqual([200])
    session.close()
    info.mockRestore()
  })

  it('backs off when snapshot-invalid resolves to an older checkpoint', async () => {
    const { conn, session } = await makePublishingShared()
    conn.putSnapshot = async (revision) => {
      conn.putSnapshots.push(revision)
      return { kind: 'conflict' }
    }
    appendForeignTitles(conn, 1, 200)
    await tick()
    await tick()
    expect(conn.putSnapshots).toEqual([200])
    session.close()
  })

  it('never publishes while the collaboration transport is disconnected', async () => {
    const { conn, session } = await makePublishingShared()
    conn.emit({ kind: 'disconnected' })
    appendForeignTitles(conn, 1, 200)
    await tick()
    expect(conn.putSnapshots).toEqual([])
    session.close()
  })

  it('does not close-flush after the server has already deleted the session', async () => {
    const { conn, session } = await makePublishingShared({ snapshotRandom: () => 1 })
    appendForeignTitles(conn, 1, 200)
    conn.emit({ kind: 'session-closed' })
    expect(session.status.get()).toBe('closed')
    expect(conn.putSnapshots).toEqual([])
  })

  it('close performs a non-blocking confirmed-state flush only after the timed threshold is met', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const { conn, session } = await makePublishingShared({
        clock: Date.now,
        snapshotRandom: () => 1,
      })
      appendForeignTitles(conn, 1, 20)
      expect(conn.putSnapshots).toEqual([])
      vi.setSystemTime(60_000)
      session.close()
      expect(conn.putSnapshots).toEqual([20])
      expect(conn.closed).toBe(true)
    } finally {
      info.mockRestore()
      vi.useRealTimers()
    }
  })

  it('fails loudly on protocol mismatch: 406 is refusal, never negotiation', async () => {
    const { conn, session, errors } = await makeShared()
    conn.protocolBroken = true
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(session.status.get()).toBe('error')
    expect(errors[0]).toMatch(/protocol version 1 unsupported/)
    const out = session.dispatch(setTitle('n1', 'again'))
    expect(out.ok).toBe(false)
    expect(out.diagnostics[0]!.code).toBe('session.unavailable')
  })

  it('undo ships as an ordinary forward op and never rewinds allocation cursors', async () => {
    const { conn, session, ops } = await makeShared('actorA')
    session.dispatch(addNode)
    await session.settle()
    const minted = nodeIds(session).find((id) => !['n1', 'n2'].includes(id))!
    expect(session.undo()).toBe(true)
    await session.settle()
    expect(nodeIds(session)).toEqual(['n1', 'n2'])
    const undoOp = ops[1]!
    expect(undoOp.origin).toBe('session.undo')
    expect(undoOp.revision).toBe(2)
    // Forward-shaped wire ops only: no oldValue, no inverse semantics.
    for (const p of undoOp.patch) expect(p).not.toHaveProperty('oldValue')
    // CO3: the cursor keeps its high-water mark; the next add mints a NEW id.
    const cursorPaths = undoOp.patch.map((p) => p.path.join('/'))
    expect(cursorPaths.every((p) => !p.endsWith('nextOrdinal') && !p.includes('actorCursors'))).toBe(true)
    session.dispatch(addNode)
    await session.settle()
    const reminted = nodeIds(session).find((id) => !['n1', 'n2'].includes(id))!
    expect(reminted).not.toBe(minted)
    expect(session.canRedo).toBe(false) // new dispatch cleared the redo stack
  })

  it('redo replays the forward record as a new op', async () => {
    const { session, ops } = await makeShared('actorA')
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    session.undo()
    await session.settle()
    expect(session.canRedo).toBe(true)
    session.redo()
    await session.settle()
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('mine')
    expect(ops.map((o) => o.origin)).toEqual(['node.setTitle', 'session.undo', 'session.redo'])
    expect(ops.map((o) => o.revision)).toEqual([1, 2, 3])
  })

  it('drops a history record that no longer applies after a rebase and surfaces the conflict', async () => {
    const { conn, session, conflicts } = await makeShared('actorA')
    session.dispatch(setTitle('n2', 'mine'))
    await session.settle()
    // Peer removes n2: our undo record (un-title n2) can no longer apply.
    conn.appendForeign('peer', foreignRemoveNode('n2'))
    expect(session.canUndo).toBe(true)
    expect(session.undo()).toBe(false)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.during).toBe('undo')
    expect(session.canUndo).toBe(false) // consumed, not retried forever
  })

  it('adopts predecessor history across a same-document handoff: undo and redo replay', async () => {
    const local = createLocalSession(baseDoc(), coreCommandRegistry())
    expect(local.dispatch(setTitle('n1', 'first')).ok).toBe(true)
    expect(local.dispatch(setTitle('n2', 'second')).ok).toBe(true)
    expect(local.undo()).toBe(true) // 'second' now sits on the redo stack
    const { session, ops } = await makeShared('actorA', local.doc)
    session.adoptHistory(local.historySnapshot())
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(true)
    expect(session.redo()).toBe(true)
    await session.settle()
    expect((session.doc.graphs.g0!.nodes.n2 as { title?: string }).title).toBe('second')
    expect(session.undo()).toBe(true)
    expect(session.undo()).toBe(true)
    await session.settle()
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBeUndefined()
    expect((session.doc.graphs.g0!.nodes.n2 as { title?: string }).title).toBeUndefined()
    // Replays ship as ordinary forward ops, exactly like locally-authored history.
    expect(ops.map((o) => o.origin)).toEqual(['session.redo', 'session.undo', 'session.undo'])
    expect(session.canUndo).toBe(false)
  })

  it('preserves the predecessor revision across a same-document handoff', async () => {
    const local = createLocalSession(baseDoc(), coreCommandRegistry())
    expect(local.dispatch(setTitle('n1', 'first')).ok).toBe(true)
    expect(local.dispatch(setTitle('n2', 'second')).ok).toBe(true)
    const { session } = await makeShared('actorA', local.doc)

    session.adoptHistory(local.historySnapshot())

    expect(session.revision).toBe(2)
    expect(session.dispatch(setTitle('n1', 'third')).ok).toBe(true)
    expect(session.revision).toBe(3)
    await session.settle()
    expect(session.revision).toBe(3)
  })

  it('refuses history adoption once the session has intentions or history of its own', async () => {
    const { session } = await makeShared('actorA')
    session.dispatch(setTitle('n1', 'mine'))
    expect(() => session.adoptHistory({ revision: 0, undo: [], redo: [] })).toThrow(/already has/)
    await session.settle()
    expect(() => session.adoptHistory({ revision: 0, undo: [], redo: [] })).toThrow(/already has/)
  })

  it('drops adopted history on resync like any other history', async () => {
    const local = createLocalSession(baseDoc(), coreCommandRegistry())
    expect(local.dispatch(setTitle('n1', 'first')).ok).toBe(true)
    const { conn, session } = await makeShared('actorA', local.doc)
    session.adoptHistory(local.historySnapshot())
    expect(session.canUndo).toBe(true)
    // Server pruned the log: catch-up hits the retention floor and resyncs.
    conn.snapshotDoc = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), 'n7-peer': node('n7-peer') },
        actorCursors: { peer: 1000 },
      }),
    })
    conn.snapshotRevision = 7
    conn.revision = 7
    conn.retentionFloor = 7
    conn.emit({ kind: 'connected', descriptor: conn.descriptor() })
    await until(() => session.revision === local.revision + 7, 'resync while preserving the predecessor revision')
    // History records were computed against pre-resync documents.
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(false)
  })

  it('caps adopted history to maxUndo on both stacks', async () => {
    const conn = new FakeConnection(baseDoc())
    const session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      clock: () => 42,
      retryDelay: () => tick(),
      maxUndo: 2,
    })
    const record = { forward: [], inverse: [] }
    session.adoptHistory({ revision: 0, undo: [record, record, record], redo: [record, record, record] })
    expect(session.historySnapshot().undo).toHaveLength(2)
    expect(session.historySnapshot().redo).toHaveLength(2)
  })

  it('refuses external dispatch of the reserved session.patch command', async () => {
    const { session } = await makeShared()
    const out = session.dispatch({ command: 'session.patch', params: { ops: [] } })
    expect(out.ok).toBe(false)
    expect(out.diagnostics[0]!.code).toBe('command.reserved')
  })

  it('relays presence both ways without touching the document', async () => {
    const { conn, session } = await makeShared()
    const seen: [string, Json | undefined][] = []
    session.onPresence((actorId, payload) => seen.push([actorId, payload]))
    session.sendPresence({ cursor: { x: 1, y: 2 } })
    expect(conn.sentPresence).toEqual([{ cursor: { x: 1, y: 2 } }])
    conn.emit({ kind: 'presence', actorId: 'peer', payload: { hover: 'n1' } })
    expect(seen).toEqual([['peer', { hover: 'n1' }]])
    expect(session.revision).toBe(0)
  })

  it('closes on the session-closed broadcast and refuses further dispatch', async () => {
    const { conn, session } = await makeShared()
    conn.emit({ kind: 'session-closed' })
    expect(session.status.get()).toBe('closed')
    expect(conn.closed).toBe(true)
    const out = session.dispatch(addNode)
    expect(out.ok).toBe(false)
    expect(out.diagnostics[0]!.code).toBe('session.unavailable')
  })

  it('recovers from stale-base over HTTP when the WS never delivers the winner', async () => {
    const { conn, session } = await makeShared('actorA')
    conn.wsAuto = false
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    session.dispatch(setTitle('n1', 'mine'))
    await until(() => conn.postedOps.length === 1, 'first POST in flight')
    // The winning foreign op is NEVER delivered over the WS (dropped
    // subscriber): the 409 alone must trigger HTTP catch-up.
    conn.appendForeign('peer', foreignAddNode('n9-peer'), false)
    gate.resolve()
    await until(() => conn.log.length === 2 && session.status.get() === 'live', 'catch-up + resubmit')
    await session.settle()
    expect(session.revision).toBe(2)
    expect(nodeIds(session)).toEqual(expect.arrayContaining(['n1', 'n2', 'n9-peer']))
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('mine')
    expect(conn.postedOps).toHaveLength(2)
    expect(conn.postedOps[1]!.opId).not.toBe(conn.postedOps[0]!.opId)
    expect(conn.postedOps[1]!.baseRevision).toBe(1)
  })

  it('queues a resync requested while catch-up is already running', async () => {
    const { conn, session } = await makeShared()
    // Marker snapshot: only a resync can produce this document.
    conn.snapshotDoc = doc({
      g0: graph({ id: 'g0', nodes: { nSnap: node('nSnap') }, actorCursors: { peer: 1000 } }),
    })
    conn.snapshotRevision = 2
    const fetchGate = deferred()
    const origFetchOps = conn.fetchOps.bind(conn)
    conn.fetchOps = async (after) => {
      conn.fetchOps = origFetchOps
      await fetchGate.promise
      return origFetchOps(after)
    }
    conn.appendForeign('peer', foreignAddNode('n8-peer'), false) // missed
    conn.appendForeign('peer', foreignAddNode('n9-peer')) // gap: catch-up starts, blocks on fetchOps
    // Divergence lands MID catch-up: the request must be queued, not lost.
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#bad',
        actorId: 'peer',
        baseRevision: 2,
        revision: 3,
        patch: [{ op: 'move', path: ['x'], value: 1 } as unknown as WirePatchOp],
        timestamp: 1,
      },
    })
    fetchGate.resolve()
    await until(
      () => session.status.get() === 'live' && nodeIds(session).includes('nSnap'),
      'queued resync adopts the snapshot',
    )
    expect(session.revision).toBe(2)
    expect(nodeIds(session)).toEqual(['nSnap'])
  })

  it('rejects a malformed server envelope over the WS and resyncs', async () => {
    const { conn, session, ops } = await makeShared()
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 1
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#1',
        actorId: '__proto__', // reserved: never a valid actor id
        baseRevision: 0,
        revision: 1,
        patch: foreignAddNode('n9-peer'),
        timestamp: 1,
      },
    })
    await until(() => session.revision === 1 && session.status.get() === 'live', 'resync')
    expect(nodeIds(session)).toEqual(['n1', 'n2']) // snapshot state, nothing adopted
    expect(ops.filter((o) => o.origin === 'remote')).toHaveLength(0)
  })

  it('fails loudly on a descriptor protocol mismatch at reconnect', async () => {
    const { conn, session, errors } = await makeShared()
    conn.emit({
      kind: 'connected',
      descriptor: { ...conn.descriptor(), protocolVersion: 2 },
    })
    expect(session.status.get()).toBe('error')
    expect(errors[0]).toMatch(/protocol version 2 unsupported/)
  })

  it('resyncs when an HTTP acceptance does not match what was submitted', async () => {
    const { conn, session } = await makeShared('actorA')
    conn.wsAuto = false
    const origPostOp = conn.postOp.bind(conn)
    let tampered = false
    conn.postOp = async (op) => {
      conn.postedOps.push(op)
      if (!tampered) {
        tampered = true
        // Byzantine response: right op, impossible revision. Must never be
        // trusted into confirmed state.
        return {
          kind: 'accepted',
          op: { opId: op.opId, actorId: op.actorId, baseRevision: op.baseRevision, revision: 5, patch: op.patch, timestamp: 1 },
        }
      }
      conn.postOp = origPostOp
      return origPostOp(op)
    }
    session.dispatch(setTitle('n1', 'mine'))
    // Wait for the server to actually append the resubmission (session
    // .revision counts optimistic pending ops, so it is 1 immediately).
    await until(() => conn.log.length === 1 && session.status.get() === 'live', 'resync + resubmit')
    await session.settle()
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('mine')
    expect(session.revision).toBe(1)
    expect(conn.postedOps.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses an undo that would overwrite a foreign edit to the same value', async () => {
    const { conn, session, conflicts } = await makeShared('actorA')
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    // Peer rewrites the SAME title: our undo record's oldValue is stale.
    conn.appendForeign('peer', [
      { op: 'replace', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'theirs' },
    ])
    expect(session.undo()).toBe(false)
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('theirs')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.during).toBe('undo')
    expect(conflicts[0]!.diagnostics[0]!.code).toBe('session.history.stale')
    expect(session.canUndo).toBe(false) // dropped, not retried forever
  })

  it('mints distinct opIds across session instances of the same actor', async () => {
    const a = await makeShared('actorA')
    const b = await makeShared('actorA')
    a.session.dispatch(setTitle('n1', 'one'))
    b.session.dispatch(setTitle('n1', 'two'))
    await a.session.settle()
    await b.session.settle()
    // Same actor, same counter position, different instances: the server's
    // idempotency window must never confuse the two.
    expect(a.conn.postedOps[0]!.opId).not.toBe(b.conn.postedOps[0]!.opId)
  })

  it('drops presence carrying an invalid actor id', async () => {
    const { conn, session } = await makeShared()
    const seen: string[] = []
    session.onPresence((actorId) => seen.push(actorId))
    conn.emit({ kind: 'presence', actorId: '__proto__', payload: { hover: 'n1' } })
    conn.emit({ kind: 'presence', actorId: 'peer' })
    expect(seen).toEqual(['peer'])
  })

  it('rewrites a history record whose inverse changed in a rebase: undo restores the foreign value', async () => {
    const { conn, session } = await makeShared('actorA')
    const gate = deferred()
    conn.postHook = () => {
      conn.postHook = undefined
      return gate.promise
    }
    session.dispatch(setTitle('n1', 'mine')) // recorded inverse: REMOVE title (was absent)
    await until(() => conn.postedOps.length === 1, 'first POST in flight')
    // Foreign actor adds the same title first: after the rebase, the correct
    // inverse is replace mine -> theirs, NOT remove.
    conn.appendForeign('peer', [
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'theirs' },
    ])
    gate.resolve()
    await until(() => conn.log.length === 2, 'resubmission accepted')
    await session.settle()
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('mine')
    // Undo must restore the peer's value, never delete their edit.
    expect(session.undo()).toBe(true)
    await session.settle()
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('theirs')
  })

  it('removes the history record of a pending intention dropped in a rebase', async () => {
    const { conn, session, conflicts } = await makeShared('actorA')
    session.dispatch(setTitle('n2', 'mine'))
    expect(session.canUndo).toBe(true)
    // Peer removes n2 before our intention is even submitted: the rebase
    // drops it, and its undo record must go with it - a stale record would
    // undo state we never ended up authoring.
    conn.appendForeign('peer', foreignRemoveNode('n2'))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.during).toBe('rebase')
    expect(session.canUndo).toBe(false)
    await session.settle()
    expect(session.revision).toBe(1) // only the foreign op; nothing local survived
  })

  it('honors a connected descriptor baseline announced while a fetchOps page is in flight', async () => {
    const { conn, session } = await makeShared()
    const gate = deferred()
    const origFetchOps = conn.fetchOps.bind(conn)
    conn.fetchOps = async (after) => {
      conn.fetchOps = origFetchOps
      const page = await origFetchOps(after) // page captured BEFORE the new baseline
      await gate.promise
      return page
    }
    conn.appendForeign('peer', foreignAddNode('n7-peer'), false) // missed
    conn.appendForeign('peer', foreignAddNode('n8-peer')) // gap: sync starts, page in flight
    // Reconnect announces a NEWER baseline while the stale page is pending.
    conn.appendForeign('peer', foreignAddNode('n9-peer'), false)
    conn.emit({ kind: 'connected', descriptor: conn.descriptor() }) // revision 3
    gate.resolve()
    await until(() => session.revision === 3 && session.status.get() === 'live', 'sync to the raised target')
    expect(nodeIds(session)).toEqual(expect.arrayContaining(['n7-peer', 'n8-peer', 'n9-peer']))
  })

  it('fetches the retained tail after resyncing from a checkpoint snapshot behind the head', async () => {
    const { conn, session } = await makeShared()
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 5
    conn.revision = 5
    conn.retentionFloor = 5 // ops <= 5 pruned; 6+ retained
    conn.appendForeign('peer', foreignAddNode('n6-peer'), false)
    conn.appendForeign('peer', foreignAddNode('n7-peer'), false)
    conn.emit({ kind: 'connected', descriptor: conn.descriptor() }) // head 7
    await until(() => session.revision === 7 && session.status.get() === 'live', 'snapshot + tail')
    expect(nodeIds(session)).toEqual(expect.arrayContaining(['n6-peer', 'n7-peer']))
  })

  it('treats a noncontiguous catch-up page as divergence and converges through resync', async () => {
    const { conn, session } = await makeShared()
    const origFetchOps = conn.fetchOps.bind(conn)
    conn.fetchOps = async (after) => {
      conn.fetchOps = origFetchOps
      const page = await origFetchOps(after)
      // Server bug: revision 1 silently missing from the page.
      return page.kind === 'ops' ? { kind: 'ops' as const, ops: page.ops.filter((o) => o.revision !== 1) } : page
    }
    conn.appendForeign('peer', foreignAddNode('n7-peer'), false)
    conn.appendForeign('peer', foreignAddNode('n8-peer'), false)
    conn.appendForeign('peer', foreignAddNode('n9-peer')) // gap: sync starts
    await until(() => session.revision === 3 && session.status.get() === 'live', 'resync convergence')
    expect(nodeIds(session)).toEqual(expect.arrayContaining(['n7-peer', 'n8-peer', 'n9-peer']))
  })

  it('adopts an own op it no longer claims as an external edit instead of resyncing forever', async () => {
    const { conn, session, ops } = await makeShared('actorA')
    // A previous incarnation's op arrives: our actorId, an opId this
    // instance never minted. The log is authoritative - it must apply.
    conn.emit({
      kind: 'op',
      op: {
        opId: 'actorA#previous-incarnation#1',
        actorId: 'actorA',
        baseRevision: 0,
        revision: 1,
        patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'ghost' }],
        timestamp: 1,
      },
    })
    expect(session.revision).toBe(1)
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('ghost')
    expect(ops[0]).toMatchObject({ revision: 1, origin: 'remote' })
    expect(session.status.get()).toBe('live')
  })

  it('keeps a consistent session when onConflict reentrantly dispatches', async () => {
    const conn = new FakeConnection(baseDoc())
    const conflicts: SessionConflict[] = []
    let session!: SharedDocumentSession
    session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      retryDelay: () => tick(),
      onListenerError: () => {},
      onConflict: (c) => {
        conflicts.push(c)
        // Recovery dispatch from INSIDE the conflict callback: must land on
        // fully consistent post-rebase state, never corrupt the queue.
        session.dispatch(setTitle('n1', 'recovered'))
      },
    })
    session.dispatch(setTitle('n2', 'mine'))
    conn.appendForeign('peer', foreignRemoveNode('n2')) // drops the intention
    await session.settle()
    expect(conflicts).toHaveLength(1)
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('recovered')
    expect(session.revision).toBe(2) // foreign remove + recovery op, nothing else
    expect(session.status.get()).toBe('live')
  })

  it('survives a throwing onConflict without corrupting the rebase', async () => {
    const failures: unknown[] = []
    const conn = new FakeConnection(baseDoc())
    const session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      retryDelay: () => tick(),
      onListenerError: (e) => failures.push(e),
      onConflict: () => {
        throw new Error('observer bug')
      },
    })
    session.dispatch(setTitle('n2', 'mine'))
    conn.appendForeign('peer', foreignRemoveNode('n2'))
    await session.settle()
    expect(session.status.get()).toBe('live')
    expect(nodeIds(session)).toEqual(['n1'])
    expect(failures.length).toBeGreaterThan(0)
    // The session still works after the observer blew up.
    const out = session.dispatch(setTitle('n1', 'still alive'))
    expect(out.ok).toBe(true)
  })

  it('survives a throwing listener-error sink during resync', async () => {
    const conn = new FakeConnection(baseDoc())
    const session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      retryDelay: () => tick(),
      onListenerError: () => {
        throw new Error('sink bug')
      },
    })
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 1
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#1',
        actorId: '__proto__',
        baseRevision: 0,
        revision: 1,
        patch: foreignAddNode('n9-peer'),
        timestamp: 1,
      },
    })
    await until(() => session.revision === 1 && session.status.get() === 'live', 'resync despite throwing sink')
    expect(nodeIds(session)).toEqual(['n1', 'n2'])
  })

  it('ignores transport events entirely after a protocol failure', async () => {
    const { conn, session, ops } = await makeShared()
    conn.protocolBroken = true
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(session.status.get()).toBe('error')
    const revisionBefore = session.revision
    conn.appendForeign('peer', foreignAddNode('n9-peer'))
    conn.emit({ kind: 'connected', descriptor: conn.descriptor() })
    expect(session.status.get()).toBe('error') // nothing revives a terminal session
    expect(session.revision).toBe(revisionBefore)
    expect(nodeIds(session)).not.toContain('n9-peer')
    expect(ops.filter((o) => o.origin === 'remote')).toHaveLength(0)
  })

  it('never rests below already-confirmed state after resyncing from a stale checkpoint', async () => {
    const { conn, session } = await makeShared()
    conn.appendForeign('peer', foreignAddNode('n7-peer')) // confirmed 1 over WS; no sync ran
    expect(session.revision).toBe(1)
    // Divergence arrives while the retained checkpoint is OLDER than what
    // this client already confirmed: the resync must come back to 1.
    conn.snapshotDoc = baseDoc()
    conn.snapshotRevision = 0
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#bad',
        actorId: '__proto__',
        baseRevision: 1,
        revision: 2,
        patch: foreignAddNode('n8-peer'),
        timestamp: 1,
      },
    })
    await until(() => session.revision === 1 && session.status.get() === 'live', 'resync back to the confirmed head')
    expect(nodeIds(session)).toContain('n7-peer')
  })

  it('stays closed when an in-flight sync request rejects after close', async () => {
    const { conn, session } = await makeShared()
    const gate = deferred()
    conn.fetchSnapshot = async () => {
      await gate.promise
      throw new Error('socket torn down by close')
    }
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#bad',
        actorId: '__proto__',
        baseRevision: 0,
        revision: 1,
        patch: foreignAddNode('n9-peer'),
        timestamp: 1,
      },
    })
    expect(session.status.get()).toBe('catching-up')
    session.close()
    gate.resolve()
    await tick()
    await tick()
    expect(session.status.get()).toBe('closed') // NOT error
  })

  it('rejects an accepted response whose patch is not the submitted patch', async () => {
    const { conn, session } = await makeShared('actorA')
    conn.wsAuto = false // the HTTP response is the only ack path
    const orig = conn.postOp.bind(conn)
    conn.postOp = async (op) => {
      conn.postOp = orig
      const out = await orig(op) // commits the REAL op to the log
      if (out.kind !== 'accepted') return out
      return {
        kind: 'accepted',
        op: {
          ...out.op,
          patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'tampered' }],
        },
      }
    }
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(session.status.get()).toBe('live')
    // The tampered patch was never adopted; the real log wins via resync.
    expect((session.doc.graphs.g0!.nodes.n1 as { title?: string }).title).toBe('mine')
  })

  it('does not duplicate a committed non-idempotent intention across a resync', async () => {
    const { conn, session } = await makeShared('actorA')
    conn.wsAuto = false
    const orig = conn.postOp.bind(conn)
    conn.postOp = async (op) => {
      conn.postOp = orig
      const out = await orig(op) // the REAL node.add commits at revision 1
      if (out.kind !== 'accepted') return out
      // ...but the response lies about the patch, forcing a resync while
      // the commit's fate is ambiguous. The resync remints the pending
      // head - the committed original must still be recognized as OURS.
      return {
        kind: 'accepted',
        op: {
          ...out.op,
          patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'tampered' }],
        },
      }
    }
    session.dispatch(addNode)
    await until(() => session.status.get() === 'live' && session.revision === 1, 'converge on the single commit')
    await session.settle()
    expect(conn.log).toHaveLength(1) // committed exactly ONCE, never resubmitted
    expect(nodeIds(session)).toHaveLength(3)
    expect(session.revision).toBe(1)
  })

  it('drops an ambiguous submitted intention hidden by a checkpoint instead of duplicating it', async () => {
    const { conn, session, conflicts } = await makeShared('actorA')
    conn.wsAuto = false
    const orig = conn.postOp.bind(conn)
    conn.postOp = async (op) => {
      conn.postOp = orig
      const out = await orig(op) // the REAL node.add commits at revision 1
      if (out.kind !== 'accepted') return out
      // A checkpoint compacts the log past the commit BEFORE the resync
      // runs: the committed op's identity is gone. The client cannot tell
      // whether its intention is inside the snapshot - it must drop it
      // rather than re-execute and risk a duplicate.
      conn.snapshotDoc = session.doc // optimistic == confirmed + the commit
      conn.snapshotRevision = 1
      return {
        kind: 'accepted',
        op: {
          ...out.op,
          patch: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1', 'title'], value: 'tampered' }],
        },
      }
    }
    session.dispatch(addNode)
    await until(() => session.status.get() === 'live' && session.revision === 1, 'resync onto the checkpoint')
    await session.settle()
    expect(conn.log).toHaveLength(1) // never resubmitted
    expect(nodeIds(session)).toHaveLength(3) // the committed node exactly once
    expect(conflicts).toHaveLength(1) // the ambiguity is surfaced, not silent
    expect(conflicts[0]!.during).toBe('rebase')
  })

  it('does not mutate state when closed while a resync snapshot fetch is in flight', async () => {
    const { conn, session } = await makeShared()
    const gate = deferred()
    const origSnapshot = conn.fetchSnapshot.bind(conn)
    conn.fetchSnapshot = async () => {
      await gate.promise
      return origSnapshot()
    }
    conn.snapshotDoc = doc({ g0: graph({ id: 'g0', nodes: { nSnap: node('nSnap') } }) })
    conn.snapshotRevision = 5
    conn.emit({
      kind: 'op',
      op: {
        opId: 'peer#1',
        actorId: '__proto__',
        baseRevision: 0,
        revision: 1,
        patch: foreignAddNode('n9-peer'),
        timestamp: 1,
      },
    })
    expect(session.status.get()).toBe('catching-up')
    session.close()
    gate.resolve()
    await tick()
    await tick()
    expect(session.status.get()).toBe('closed')
    expect(session.revision).toBe(0) // the fetched snapshot was NOT adopted
    expect(nodeIds(session)).toEqual(['n1', 'n2'])
  })

  it('isolates op listener failures (CO10)', async () => {
    const failures: unknown[] = []
    const conn = new FakeConnection(baseDoc())
    const session = await connectSharedSession(conn, coreCommandRegistry(), {
      actorId: 'actorA',
      onListenerError: (e) => failures.push(e),
    })
    const seen: number[] = []
    session.onOp(() => {
      throw new Error('bad listener')
    })
    session.onOp((op) => seen.push(op.revision))
    session.dispatch(setTitle('n1', 'mine'))
    await session.settle()
    expect(seen).toEqual([1])
    expect(failures).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// requireRecordedValues on cursor-preserved subtrees (shared-mode replay)
// ---------------------------------------------------------------------------

describe('replayHistoryOps requireRecordedValues on cursor subtrees', () => {
  const withViewGraph = (graphView: Json): WorkflowDocument =>
    ({
      ...doc({ g0: graph({ id: 'g0' }) }),
      view: { graphs: { g0: graphView } },
    }) as unknown as WorkflowDocument

  it('refuses a whole view-graph replay when foreign semantic data appeared', () => {
    // Recorded (ensureViewGraph's inverse): remove the pristine view graph.
    const recorded: PatchOp = {
      op: 'remove',
      path: ['view', 'graphs', 'g0'],
      oldValue: { nodes: {}, groupSeq: 2 },
    }
    // A foreign actor added node-view data inside the subtree since.
    const cur = withViewGraph({ nodes: { nv1: { x: 1 } }, groupSeq: 2 })
    const out = replayHistoryOps(cur, [recorded], { requireRecordedValues: true })
    expect(out.stale).toBe(recorded)
    expect(out.applied).toHaveLength(0)
    expect(out.doc).toBe(cur) // untouched: the foreign edit survives
  })

  it('allows the replay when the subtree drifted ONLY by cursor advancement', () => {
    const recorded: PatchOp = {
      op: 'remove',
      path: ['view', 'graphs', 'g0'],
      oldValue: { nodes: {}, groupSeq: 2 },
    }
    // Same shape, but the cursor legitimately advanced (foreign allocations).
    const cur = withViewGraph({ nodes: {}, groupSeq: 5 })
    const out = replayHistoryOps(cur, [recorded], { requireRecordedValues: true })
    expect(out.stale).toBeUndefined()
    expect(out.applied).toHaveLength(1)
    // Clamped as ever: the remove becomes a skeleton keeping the high-water mark.
    expect((out.doc.view.graphs as unknown as Record<string, Json>).g0).toEqual({ nodes: {}, groupSeq: 5 })
  })
})
