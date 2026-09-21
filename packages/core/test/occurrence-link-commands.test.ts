import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { effectiveOccurrenceTopology, occurrenceBoundaryTargets, type EffectiveLinkIdentity } from '../src/compile/effective-topology.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { createTransactionBuilder, executeCommand } from '../src/commands/contract.js'
import { occurrenceLinkPlanDigest, planOccurrenceLinkCommand } from '../src/commands/occurrence-link-commands.js'
import { planOccurrenceLinkMutation, type OccurrenceLinkIntention } from '../src/commands/occurrence-planner.js'
import { DocumentStore } from '../src/commands/store.js'
import type { BoundaryItem, Json, NodeData, OccurrenceLinkEndpoint, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asGraphDefId, asLineageId, asNodeId, asPortId, occurrenceKey, type OccurrenceRef } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'

const schema = (type: string, inputs: string[], outputs: string[]): NodeSchema => ({
  type, displayName: type, category: 'test', source: 'v3', isOutputNode: type === 'Sink',
  items: [
    ...inputs.map((id) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' }, optional: true })),
    ...outputs.map((id) => ({ kind: 'output' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' } })),
  ],
})
const schemas: Record<string, NodeSchema> = {
  Src: schema('Src', [], ['out']),
  Sink: schema('Sink', ['in', 'other'], []),
  FamilySink: {
    ...schema('FamilySink', [], []),
    items: [{
      kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'item', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    }],
  },
}
const resolve = (type: string) => schemas[type]
const owner = (node: string, instancePath: readonly string[] = []): OccurrenceRef => ({
  instancePath: instancePath.map(asNodeId), node: asNodeId(node),
})
const body = (endpoint: object): OccurrenceLinkEndpoint => ({ kind: 'body', endpoint: endpoint as never })
const binding = (node = 'producerTwo', port = 'out') => ({ kind: 'port' as const, node: asNodeId(node), port: asPortId(port) })

function document(nested = false): WorkflowDocument {
  const bodyGraph = {
    id: asGraphDefId('body'), name: 'body',
    nodes: {
      producerOne: { id: asNodeId('producerOne'), type: 'Src', values: {} },
      producerTwo: { id: asNodeId('producerTwo'), type: 'Src', values: {} },
      sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
    },
    links: {
      shared: {
        id: 'shared' as never,
        from: { node: asNodeId('producerOne'), port: asPortId('out') },
        to: { node: asNodeId('sink'), port: asPortId('in') },
      },
    },
    nets: {
      sharedNet: {
        id: 'sharedNet' as never, name: 'sharedNet',
        source: { node: asNodeId('producerOne'), port: asPortId('out') },
        sinks: [{ node: asNodeId('sink'), port: asPortId('other') }],
      },
    },
    reroutes: {}, nextOrdinal: 2,
    boundary: {
      inputs: [],
      outputs: [
        { id: 'feed' as never, binds: binding() },
        { id: 'feed1' as never, binds: binding('producerOne') },
      ],
    },
  }
  const graphs: WorkflowDocument['graphs'] = nested
    ? {
        root: {
          id: asGraphDefId('root'), name: 'root',
          nodes: { outer: { id: asNodeId('outer'), type: '#mid', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
        mid: {
          id: asGraphDefId('mid'), name: 'mid',
          nodes: { inner: { id: asNodeId('inner'), type: '#body', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: {
            inputs: [],
            outputs: [{ id: 'outerFeed' as never, binds: binding('inner', 'feed') }],
          },
        },
        body: bodyGraph,
      }
    : {
        root: {
          id: asGraphDefId('root'), name: 'root',
          nodes: {
            a: { id: asNodeId('a'), type: '#body', values: {} },
            b: { id: asNodeId('b'), type: '#body', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
        body: bodyGraph,
      }
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('occurrence-commands'),
    root: asGraphDefId('root'), graphs, view: { graphs: {} },
  }
}

function directBoundary(target: OccurrenceRef, boundaryId = 'feed'): OccurrenceLinkEndpoint {
  const routeBinding = boundaryId === 'feed1' ? binding('producerOne') : binding()
  return {
    kind: 'boundary', occurrence: target, address: { port: asPortId(boundaryId) },
    route: [{ graph: asGraphDefId('body'), boundaryId, binding: routeBinding }],
  }
}

function chainedBoundary(): OccurrenceLinkEndpoint {
  return {
    kind: 'boundary', occurrence: owner('outer'), address: { port: asPortId('outerFeed') },
    route: [
      { graph: asGraphDefId('mid'), boundaryId: 'outerFeed', binding: binding('inner', 'feed') },
      { graph: asGraphDefId('body'), boundaryId: 'feed', binding: binding() },
    ],
  }
}

function planned(doc: WorkflowDocument, intent: Parameters<typeof planOccurrenceLinkCommand>[2]) {
  const { command: _command, ...fields } = intent
  const intention = {
    kind: intent.command.slice('occurrence.link.'.length),
    ...fields,
  } as OccurrenceLinkIntention
  const result = planOccurrenceLinkMutation(doc, resolve, intention)
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics) : undefined).toBe(true)
  if (!result.ok) throw new Error('planner refused')
  return result
}

function localConnect(doc: WorkflowDocument, target: OccurrenceRef, from = directBoundary(target)) {
  return planned(doc, {
    command: 'occurrence.link.connect', owner: target, bodyGraph: 'body', from,
    to: body({ node: 'sink', port: 'in' }),
  })
}

describe('occurrence-local link commands', () => {
  it.each([
    'occurrence.link.connect',
    'occurrence.link.disconnect',
    'occurrence.link.rewire',
    'occurrence.link.rewireSource',
  ])('registers %s through the core command registry', (command) => {
    expect(coreCommandRegistry().has(command)).toBe(true)
  })

  it.each([
    ['root direct', document(), owner('a'), directBoundary(owner('a'))],
    ['nested direct', document(true), owner('inner', ['outer']), directBoundary(owner('inner', ['outer']))],
    ['nested chained forwarding', document(true), owner('inner', ['outer']), chainedBoundary()],
  ])('connects, disconnects, rewires, and deletes for %s occurrences', (_label, initial, target, from) => {
    const store = new DocumentStore(initial as WorkflowDocument, coreCommandRegistry())
    const connect = localConnect(store.doc, target as OccurrenceRef, from as OccurrenceLinkEndpoint)
    const connected = store.dispatch(connect.invocation)
    expect(connected.ok, JSON.stringify(connected.diagnostics)).toBe(true)
    const key = occurrenceKey(target as OccurrenceRef)
    const topology = store.doc.occurrenceTopologies![key]!
    expect(Object.keys(topology.links)).toEqual(['l0'])
    expect(topology.suppressedDeliveries).toEqual([{ kind: 'link', linkId: 'shared' }])

    const localIdentity: EffectiveLinkIdentity = { kind: 'occurrence', owner: target as OccurrenceRef, linkId: 'l0' as never }
    const rewire = planned(store.doc, {
      command: 'occurrence.link.rewire', owner: target as OccurrenceRef, bodyGraph: 'body', link: localIdentity,
      to: body({ node: 'sink', port: 'other' }),
    })
    expect(store.dispatch(rewire.invocation).ok).toBe(true)
    expect(store.doc.occurrenceTopologies![key]!.links.l0!.to).toEqual(body({ node: 'sink', port: 'other' }))

    const source = planned(store.doc, {
      command: 'occurrence.link.rewireSource', owner: target as OccurrenceRef, bodyGraph: 'body', links: [localIdentity],
      from: directBoundary(target as OccurrenceRef, 'feed1'),
    })
    expect(store.dispatch(source.invocation).ok).toBe(true)
    expect(store.doc.occurrenceTopologies![key]!.links.l0!.from).toEqual(directBoundary(target as OccurrenceRef, 'feed1'))

    const disconnect = planned(store.doc, {
      command: 'occurrence.link.disconnect', owner: target as OccurrenceRef, bodyGraph: 'body', link: localIdentity,
    })
    expect(store.dispatch(disconnect.invocation).ok).toBe(true)
    expect(store.doc.occurrenceTopologies![key]!.links).toEqual({})
    expect(store.doc.occurrenceTopologies![key]!.nextOrdinal).toBe(1)

    expect(store.undo()).toBe(true)
    expect(store.doc.occurrenceTopologies![key]!.links.l0).toBeDefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.occurrenceTopologies![key]!.links).toEqual({})
  })

  it('isolates sibling occurrences and keeps definition edits shared', () => {
    const initial = document()
    const store = new DocumentStore(initial, coreCommandRegistry())
    expect(store.dispatch(localConnect(store.doc, owner('a')).invocation).ok).toBe(true)
    expect(effectiveOccurrenceTopology(store.doc, resolve, owner('a')).links.map((link) => link.identity.kind)).toEqual(['definitionNetSink', 'occurrence'])
    expect(effectiveOccurrenceTopology(store.doc, resolve, owner('b')).links.map((link) => link.identity.kind)).toEqual(['definition', 'definitionNetSink'])
    expect(store.doc.graphs.body!.links).toEqual(initial.graphs.body!.links)
    expect(store.dispatch({
      command: 'link.connect', params: {
        graphId: 'body', from: { node: 'producerTwo', port: 'out' }, to: { node: 'sink', port: 'in' },
      },
    }).ok).toBe(false)
    expect(store.doc.occurrenceTopologies![occurrenceKey(owner('a'))]!.links.l0).toBeDefined()
  })

  it('suppresses shared link and net-sink deliveries without mutating definitions', () => {
    const initial = document()
    const store = new DocumentStore(initial, coreCommandRegistry())
    const shared: EffectiveLinkIdentity = { kind: 'definition', graphId: asGraphDefId('body'), linkId: 'shared' as never }
    const disconnect = planned(store.doc, { command: 'occurrence.link.disconnect', owner: owner('a'), bodyGraph: 'body', link: shared })
    expect(store.dispatch(disconnect.invocation).ok).toBe(true)
    expect(store.doc.graphs.body!.links.shared).toEqual(initial.graphs.body!.links.shared)
    const net: EffectiveLinkIdentity = {
      kind: 'definitionNetSink', graphId: asGraphDefId('body'), netId: 'sharedNet' as never,
      to: { node: asNodeId('sink'), port: asPortId('other') },
    }
    expect(store.dispatch(planned(store.doc, {
      command: 'occurrence.link.disconnect', owner: owner('a'), bodyGraph: 'body', link: net,
    }).invocation).ok).toBe(true)
    expect(store.doc.occurrenceTopologies!.a!.suppressedDeliveries).toEqual([
      { kind: 'link', linkId: 'shared' },
      { kind: 'netSink', netId: 'sharedNet', to: { node: 'sink', port: 'other' } },
    ])
  })

  it('suppresses one projected parent route without deleting its parent link', () => {
    const base = document()
    const projected: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            ...base.graphs.root!.nodes,
            rootProducer: { id: asNodeId('rootProducer'), type: 'Src', values: {} },
          },
          links: {
            parentLink: {
              id: 'parentLink' as never,
              from: { node: asNodeId('rootProducer'), port: asPortId('out') },
              to: { node: asNodeId('a'), port: asPortId('incoming') },
            },
          },
        },
        body: {
          ...base.graphs.body!,
          links: {},
          nets: {},
          boundary: {
            ...base.graphs.body!.boundary!,
            inputs: [{
              id: 'incoming' as never,
              binds: binding('sink', 'in'),
              alsoBinds: [binding('sink', 'other')],
            }],
          },
        },
      },
    }
    const identity = effectiveOccurrenceTopology(projected, resolve, owner('a')).projectedParentLinks[0]!.identity
    expect(identity.kind).toBe('parentLeg')
    const store = new DocumentStore(projected, coreCommandRegistry())
    expect(store.dispatch(planned(store.doc, {
      command: 'occurrence.link.disconnect', owner: owner('a'), bodyGraph: 'body', link: identity,
    }).invocation).ok).toBe(true)
    expect(store.doc.graphs.root!.links.parentLink).toBeDefined()
    expect(store.doc.occurrenceTopologies!.a!.suppressedDeliveries?.[0]?.kind).toBe('projectedLeg')
  })

  it('retains allocator cursors across one-step undo and never reuses local ids', () => {
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch(localConnect(store.doc, owner('a')).invocation).ok).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.occurrenceTopologies!.a!.nextOrdinal).toBe(1)
    expect(store.dispatch(localConnect(store.doc, owner('a')).invocation).ok).toBe(true)
    expect(Object.keys(store.doc.occurrenceTopologies!.a!.links)).toEqual(['l1'])
  })

  it('materializes a boundary ghost and creates its local link in one undo step', () => {
    const initial = document()
    const target = owner('a')
    const bodyGraph = initial.graphs.body!
    ;(bodyGraph.nodes as Record<string, NodeData>).sink = { id: asNodeId('sink'), type: 'FamilySink', values: {} }
    ;(bodyGraph as unknown as { links: Record<string, never>; nets: Record<string, never> }).links = {}
    ;(bodyGraph as unknown as { links: Record<string, never>; nets: Record<string, never> }).nets = {}
    const familyBinding = { kind: 'family' as const, node: asNodeId('sink'), port: asPortId('items') }
    ;(bodyGraph.boundary as unknown as { inputs: BoundaryItem[] }).inputs = [{ id: 'ingest' as never, binds: familyBinding }]
    const ghost = {
      kind: 'boundary' as const,
      occurrence: target,
      address: { port: asPortId('ingest.item'), members: ['m0' as never] },
      route: [{ graph: asGraphDefId('body'), boundaryId: 'ingest', binding: familyBinding }],
    } as OccurrenceLinkEndpoint
    const store = new DocumentStore(initial, coreCommandRegistry())
    const result = store.dispatch(planned(store.doc, {
      command: 'occurrence.link.connect', owner: target, bodyGraph: 'body',
      from: body({ node: 'producerOne', port: 'out' }), to: ghost,
    }).invocation)
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(store.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { members: ['m0'], seq: 1 } })
    expect(store.doc.occurrenceTopologies!.a!.links.l0).toBeDefined()
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { seq: 1 } })
    expect(store.doc.occurrenceTopologies!.a!.links).toEqual({})
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { members: ['m0'], seq: 1 } })
    expect(store.doc.occurrenceTopologies!.a!.links.l0).toBeDefined()

    const capped = structuredClone(initial) as WorkflowDocument
    ;(capped.graphs.root!.nodes as Record<string, NodeData>).a = {
      ...capped.graphs.root!.nodes.a!,
      dynamic: { ingest: { members: ['m0', 'm1', 'm2', 'm3'], seq: 4 } },
    }
    const unavailable = planOccurrenceLinkMutation(capped, resolve, {
      kind: 'connect', owner: target, bodyGraph: 'body',
      from: body({ node: 'producerOne', port: 'out' }),
      to: {
        ...(ghost as Extract<OccurrenceLinkEndpoint, { kind: 'boundary' }>),
        address: { ...(ghost as Extract<OccurrenceLinkEndpoint, { kind: 'boundary' }>).address, members: ['m4' as never] },
      },
    })
    expect(unavailable.ok).toBe(false)
  })

  it('allows ordinary edits to distinct members while occurrence and whole-family drivers stay guarded', () => {
    const initial = document()
    const target = owner('a')
    const bodyGraph = initial.graphs.body!
    ;(bodyGraph.nodes as Record<string, NodeData>).sink = {
      id: asNodeId('sink'), type: 'FamilySink', values: {},
      dynamic: { items: { members: ['d0' as never], seq: 1 } },
    }
    ;(bodyGraph as unknown as { links: Record<string, never>; nets: Record<string, never> }).links = {}
    ;(bodyGraph as unknown as { links: Record<string, never>; nets: Record<string, never> }).nets = {}
    const familyBinding = { kind: 'family' as const, node: asNodeId('sink'), port: asPortId('items') }
    ;(bodyGraph.boundary as unknown as { inputs: BoundaryItem[] }).inputs = [{ id: 'ingest' as never, binds: familyBinding }]
    ;(initial.graphs.root!.nodes as Record<string, NodeData>).p = { id: asNodeId('p'), type: 'Src', values: {} }
    const ghost = {
      kind: 'boundary' as const,
      occurrence: target,
      address: { port: asPortId('ingest.item'), members: ['m0' as never] },
      route: [{ graph: asGraphDefId('body'), boundaryId: 'ingest', binding: familyBinding }],
    } as OccurrenceLinkEndpoint
    const store = new DocumentStore(initial, coreCommandRegistry())
    const connected = store.dispatch(planned(store.doc, {
      command: 'occurrence.link.connect', owner: target, bodyGraph: 'body',
      from: body({ node: 'producerOne', port: 'out' }), to: ghost,
    }).invocation)
    expect(connected.ok, JSON.stringify(connected.diagnostics)).toBe(true)

    const distinct = store.dispatch({
      command: 'link.connect',
      params: {
        graphId: 'body',
        from: { node: 'producerTwo', port: 'out' },
        to: { node: 'sink', port: 'items.item', members: ['d0'] },
      },
    } as never)
    expect(distinct.ok, JSON.stringify(distinct.diagnostics)).toBe(true)
    expect(store.doc.occurrenceTopologies!.a!.links.l0).toBeDefined()
    expect(Object.values(store.doc.graphs.body!.links).some((link) =>
      'members' in link.to && (link.to as { members?: readonly string[] }).members?.[0] === 'd0',
    )).toBe(true)

    const whole = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'body', from: { node: 'producerTwo', port: 'out' }, to: { node: 'sink', port: 'items' } },
    } as never)
    expect(whole.ok).toBe(false)
    expect(whole.diagnostics[0]!.code).toBe('occurrence.topology.definitionReferenced')

    const sameMember = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'root', from: { node: 'p', port: 'out' }, to: { node: 'a', port: 'ingest.item', members: ['m0'] } },
    } as never)
    expect(sameMember.ok).toBe(false)
    expect(sameMember.diagnostics[0]!.code).toBe('occurrence.topology.definitionReferenced')
  })

  it('composes routed binding members with the occurrence suffix when guarding nested families', () => {
    const doc = document()
    const nested = {
      kind: 'boundary' as const,
      occurrence: owner('a'),
      address: { port: asPortId('ingest.item'), members: ['m0' as never] },
      route: [{
        graph: asGraphDefId('body'), boundaryId: 'ingest',
        binding: { kind: 'family' as const, node: asNodeId('sink'), port: asPortId('items.sub'), members: ['d0' as never] },
      }],
    } as OccurrenceLinkEndpoint
    const targets = (port: string, members?: readonly string[]) =>
      occurrenceBoundaryTargets(doc, nested, 'body', { node: asNodeId('sink'), port: asPortId(port), ...(members === undefined ? {} : { members: members as never }) })

    expect(targets('items.sub.item', ['d0', 'd1'])).toBe(false)
    expect(targets('items.sub.item', ['d0', 'm0'])).toBe(true)
    expect(targets('items.sub', ['d0'])).toBe(true)
    expect(targets('items.sub', ['d1'])).toBe(false)
    expect(targets('items.sub')).toBe(true)
  })

  it('refuses digest mismatch, snapshot coverage mismatch, and stale topology', () => {
    const initial = document()
    const connect = localConnect(initial, owner('a'))
    const registry = coreCommandRegistry()
    const badDigest = structuredClone(connect.invocation) as { command: string; params: Record<string, unknown> }
    badDigest.params.planDigest = 'sha256:bad'
    expect(new DocumentStore(initial, registry).dispatch(badDigest as never).diagnostics[0]!.code).toBe('occurrence.link.stalePlan')

    const extra = structuredClone(connect.invocation) as { command: string; params: Record<string, unknown> }
    ;(extra.params.schemaSnapshot as Record<string, unknown>).Extra = schema('Extra', [], [])
    const plan = extra.params.plan as Parameters<typeof occurrenceLinkPlanDigest>[1]
    extra.params.planDigest = occurrenceLinkPlanDigest(extra.params.schemaSnapshot as Record<string, NodeSchema>, plan, extra.params.expectedTopologyFingerprint as string)
    expect(new DocumentStore(initial, registry).dispatch(extra as never).diagnostics[0]!.code).toBe('occurrence.link.schemaCoverage')

    const changed = structuredClone(initial) as WorkflowDocument
    ;(changed.graphs.body!.links.shared as { from: { node: string; port: string } }).from = { node: 'producerTwo', port: 'out' }
    expect(new DocumentStore(changed, registry).dispatch(connect.invocation).diagnostics[0]!.code).toBe('occurrence.link.stalePlan')
    const definition = registry.get(connect.invocation.command)!
    const replay = createTransactionBuilder(changed)
    expect(executeCommand(definition, changed, connect.invocation.params, replay, { kind: 'shared-replay' })[0]!.code)
      .toBe('occurrence.link.stalePlan')
    const unrelated = structuredClone(initial) as WorkflowDocument
    ;(unrelated.graphs.body!.nodes.producerTwo!.values as Record<string, Json>).changed = true
    expect(new DocumentStore(unrelated, registry).dispatch(connect.invocation).ok).toBe(true)
  })

  it('executes the same immutable plan under initial and shared-replay contexts', () => {
    const initial = document()
    const invocation = localConnect(initial, owner('a')).invocation
    const definition = coreCommandRegistry().get(invocation.command)!
    const run = (kind: 'initial' | 'shared-replay') => {
      const tx = createTransactionBuilder(initial)
      const diagnostics = executeCommand(definition, initial, invocation.params, tx, { kind })
      expect(diagnostics).toEqual([])
      return tx.result().doc
    }
    expect(run('shared-replay')).toEqual(run('initial'))
  })

  it('returns planner diagnostics for unresolved endpoints and missing deliveries', () => {
    const initial = document()
    const badEndpoint = planOccurrenceLinkMutation(initial, resolve, {
      kind: 'connect', owner: owner('a'), bodyGraph: 'body',
      from: directBoundary(owner('missing')),
      to: body({ node: 'sink', port: 'in' }),
    })
    expect(badEndpoint.ok).toBe(false)
    if (!badEndpoint.ok) expect(badEndpoint.diagnostics[0]!.code).toBe('occurrence.link.planUnavailable')
    const missing = planOccurrenceLinkMutation(initial, resolve, {
      kind: 'disconnect', owner: owner('a'), bodyGraph: 'body',
      link: { kind: 'occurrence', owner: owner('a'), linkId: 'missing' as never },
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.diagnostics[0]!.code).toBe('occurrence.link.planUnavailable')
  })

  it('refuses prospective invalid ports and reversed endpoint directions', () => {
    const initial = document()
    const missing = planOccurrenceLinkMutation(initial, resolve, {
      kind: 'connect', owner: owner('a'), bodyGraph: 'body', from: directBoundary(owner('a')),
      to: body({ node: 'sink', port: 'missing' }),
    })
    expect(missing.ok).toBe(false)
    const reversed = planOccurrenceLinkMutation(initial, resolve, {
      kind: 'connect', owner: owner('a'), bodyGraph: 'body',
      from: body({ node: 'sink', port: 'in' }), to: directBoundary(owner('a')),
    })
    expect(reversed.ok).toBe(false)
  })

  it('rejects recomputed plans containing unknown nested endpoint fields', () => {
    const initial = document()
    const invocation = structuredClone(localConnect(initial, owner('a')).invocation) as {
      command: string
      params: Record<string, unknown>
    }
    const plan = invocation.params.plan as Parameters<typeof occurrenceLinkPlanDigest>[1] & {
      deliveries: Array<{ to: { authored: { endpoint: Record<string, unknown> } } }>
    }
    plan.deliveries[0]!.to.authored.endpoint.unknown = true
    invocation.params.planDigest = occurrenceLinkPlanDigest(
      invocation.params.schemaSnapshot as Record<string, NodeSchema>,
      plan,
      invocation.params.expectedTopologyFingerprint as string,
    )
    const result = new DocumentStore(initial, coreCommandRegistry()).dispatch(invocation as never)
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]!.code).toBe('params.invalid')
  })

  it('protects boundary-backed occurrence targets from shared driver edits', () => {
    const initial = document()
    ;(initial.graphs.body!.boundary as unknown as { inputs: BoundaryItem[] }).inputs = [{
      id: 'incoming' as never,
      binds: { kind: 'port', node: asNodeId('sink'), port: asPortId('in') },
    }]
    const target: OccurrenceLinkEndpoint = {
      kind: 'boundary', occurrence: owner('a'), address: { port: asPortId('incoming') },
      route: [{
        graph: asGraphDefId('body'), boundaryId: 'incoming',
        binding: { kind: 'port', node: asNodeId('sink'), port: asPortId('in') },
      }],
    }
    const store = new DocumentStore(initial, coreCommandRegistry())
    const invocation = planned(store.doc, {
      command: 'occurrence.link.connect', owner: owner('a'), bodyGraph: 'body',
      from: body({ node: 'producerTwo', port: 'out' }), to: target,
    }).invocation
    expect(store.dispatch(invocation).ok).toBe(true)
    const result = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'body', from: { node: 'producerOne', port: 'out' }, to: { node: 'sink', port: 'in' } },
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]!.code).toBe('occurrence.topology.definitionReferenced')
  })

  it('unsuppresses an unchanged shared delivery without allocating a local link', () => {
    const store = new DocumentStore(document(), coreCommandRegistry())
    const shared: EffectiveLinkIdentity = { kind: 'definition', graphId: asGraphDefId('body'), linkId: 'shared' as never }
    expect(store.dispatch(planned(store.doc, {
      command: 'occurrence.link.disconnect', owner: owner('a'), bodyGraph: 'body', link: shared,
    }).invocation).ok).toBe(true)
    expect(store.dispatch(planned(store.doc, {
      command: 'occurrence.link.connect', owner: owner('a'), bodyGraph: 'body',
      from: body({ node: 'producerOne', port: 'out' }), to: body({ node: 'sink', port: 'in' }),
    }).invocation).ok).toBe(true)
    expect(store.doc.occurrenceTopologies!.a!.suppressedDeliveries).toBeUndefined()
    expect(store.doc.occurrenceTopologies!.a!.links).toEqual({})
    expect(store.doc.occurrenceTopologies!.a!.nextOrdinal).toBe(0)
  })

  it('rejects definition deletion while a local endpoint references the node', () => {
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch(localConnect(store.doc, owner('a')).invocation).ok).toBe(true)
    const outcome = store.dispatch({ command: 'node.remove', params: { graphId: 'body', nodeIds: ['sink'] } })
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics[0]!.code).toBe('occurrence.topology.definitionReferenced')
    expect(store.doc.graphs.body!.nodes.sink).toBeDefined()
  })

  it('guards every occurrence-referenced definition entity deletion path', () => {
    const cases: Array<{
      command: string
      params: Record<string, Json>
      endpoint: object
      prepare: (doc: WorkflowDocument) => void
    }> = [
      {
        command: 'graph.deleteItems', params: { graphId: 'body', nodeIds: ['sink'] },
        endpoint: { node: 'sink', port: 'in' }, prepare: () => undefined,
      },
      {
        command: 'reroute.remove', params: { graphId: 'body', rerouteIds: ['r'] },
        endpoint: { reroute: 'r' },
        prepare: (doc) => { (doc.graphs.body!.reroutes as any).r = { id: 'r' } },
      },
      {
        command: 'valueSource.remove', params: { graphId: 'body', valueSourceIds: ['v'] },
        endpoint: { valueSource: 'v' },
        prepare: (doc) => { (doc.graphs.body as any).valueSources = { v: { id: 'v', value: 1 } } },
      },
      {
        command: 'selector.remove', params: { graphId: 'body', selectorIds: ['s'] },
        endpoint: { selector: 's' },
        prepare: (doc) => {
          (doc.graphs.body as any).selectors = {
            s: { id: 's', candidates: [{ id: 'c' }], policy: { kind: 'fixed', candidate: 'c' } },
          }
        },
      },
    ]

    for (const testCase of cases) {
      const initial = document()
      testCase.prepare(initial)
      ;(initial as any).occurrenceTopologies = {
        a: {
          owner: owner('a'), bodyGraph: 'body', nextOrdinal: 1,
          links: {
            l0: {
              id: 'l0', from: body(testCase.endpoint),
              to: body({ node: 'sink', port: 'other' }),
            },
          },
        },
      }
      const store = new DocumentStore(initial, coreCommandRegistry())
      const before = store.doc
      const outcome = store.dispatch({ command: testCase.command, params: testCase.params } as never)
      expect(outcome.ok, testCase.command).toBe(false)
      expect(outcome.diagnostics[0]!.code, testCase.command).toBe('occurrence.topology.definitionReferenced')
      expect(store.doc, testCase.command).toBe(before)
    }
  })

  it('rejects selector candidate removal while an occurrence endpoint references it', () => {
    const initial = document()
    ;(initial.graphs.body as any).selectors = {
      choice: {
        id: 'choice',
        candidates: [{ id: 'c1' }, { id: 'c2' }],
        policy: { kind: 'fixed', candidate: 'c1' },
      },
    }
    ;(initial.graphs.body!.links as any).candidateFeed = {
      id: 'candidateFeed',
      from: { node: 'producerOne', port: 'out' },
      to: { selector: 'choice', candidate: 'c1' },
    }
    ;(initial as any).occurrenceTopologies = {
      a: {
        owner: owner('a'), bodyGraph: 'body', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: body({ node: 'producerTwo', port: 'out' }),
            to: body({ selector: 'choice', candidate: 'c1' }),
          },
        },
      },
    }
    const store = new DocumentStore(initial, coreCommandRegistry())
    const before = store.doc
    const outcome = store.dispatch({
      command: 'selector.removeCandidate',
      params: { graphId: 'body', selectorId: 'choice', candidateId: 'c1' },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('doc.occurrenceTopology.endpointDangling')
    expect(store.revision).toBe(0)
    expect(store.doc).toBe(before)
    expect(store.doc.graphs.body!.selectors!.choice!.candidates.map((candidate) => candidate.id)).toEqual(['c1', 'c2'])
    expect(store.doc.graphs.body!.links.candidateFeed).toBeDefined()
  })

  it('guards replacement and every definition driver displacement path', () => {
    const replacement = new DocumentStore(document(), coreCommandRegistry())
    expect(replacement.dispatch(localConnect(replacement.doc, owner('a')).invocation).ok).toBe(true)
    const replaced = replacement.dispatch({
      command: 'node.replace',
      params: { plan: {
        graphId: 'body', nodeId: 'sink', from: 'Sink', to: 'Replacement', values: {},
        inputRewires: [], outputRewires: [], dropLinks: [], netSourceRewires: [], netSinks: [], dropNets: [],
      } },
    } as never)
    expect(replaced.ok).toBe(false)
    expect(replaced.diagnostics[0]!.code).toBe('occurrence.topology.definitionReferenced')

    const initial = document()
    delete (initial.graphs.body!.nets as Record<string, unknown>).sharedNet
    ;(initial.graphs.body!.links as any).movable = {
      id: 'movable', from: { node: 'producerOne', port: 'out' }, to: { node: 'sink', port: 'other' },
    }
    ;(initial.graphs.body!.nets as any).freshNet = {
      id: 'freshNet', name: 'fresh', source: { node: 'producerTwo', port: 'out' }, sinks: [],
    }
    const store = new DocumentStore(initial, coreCommandRegistry())
    expect(store.dispatch(localConnect(store.doc, owner('a')).invocation).ok).toBe(true)
    for (const invocation of [
      { command: 'link.rewire', params: { graphId: 'body', linkId: 'movable', to: { node: 'sink', port: 'in' } } },
      { command: 'net.connectInput', params: { graphId: 'body', netId: 'freshNet', to: { node: 'sink', port: 'in' } } },
    ]) {
      const outcome = store.dispatch(invocation as never)
      expect(outcome.ok, invocation.command).toBe(false)
      expect(outcome.diagnostics[0]!.code, invocation.command).toBe('occurrence.topology.definitionReferenced')
    }

    const topologyBefore = store.doc.occurrenceTopologies!.a
    const sourceRewire = store.dispatch({
      command: 'link.rewireSource',
      params: { graphId: 'body', linkIds: ['shared'], from: { node: 'producerTwo', port: 'out' } },
    })
    expect(sourceRewire.ok).toBe(true)
    expect(store.doc.occurrenceTopologies!.a).toEqual(topologyBefore)
    expect(store.doc.graphs.body!.links.shared!.from).toEqual({ node: 'producerTwo', port: 'out' })
  })

  it('removes only suppressions for definition deliveries removed by public commands', () => {
    const fixture = () => {
      const initial = document()
      const root = initial.graphs.root!
      ;(root.nodes as any).linkSource = { id: 'linkSource', type: 'Src', values: {} }
      ;(root.nodes as any).netSource = { id: 'netSource', type: 'Src', values: {} }
      ;(root.nodes as any).keptLinkSource = { id: 'keptLinkSource', type: 'Src', values: {} }
      ;(root.nodes as any).keptNetSource = { id: 'keptNetSource', type: 'Src', values: {} }
      ;(root.links as any).targetLink = {
        id: 'targetLink', from: { node: 'linkSource', port: 'out' }, to: { node: 'a', port: 'linkInput' },
      }
      ;(root.links as any).keptLink = {
        id: 'keptLink', from: { node: 'keptLinkSource', port: 'out' }, to: { node: 'a', port: 'keptLinkInput' },
      }
      ;(root.nets as any).targetNet = {
        id: 'targetNet', name: 'targetNet', source: { node: 'netSource', port: 'out' },
        sinks: [{ node: 'a', port: 'netInput' }],
      }
      ;(root.nets as any).keptNet = {
        id: 'keptNet', name: 'keptNet', source: { node: 'keptNetSource', port: 'out' },
        sinks: [{ node: 'a', port: 'keptNetInput' }],
      }
      ;(initial.graphs.body!.boundary as any).inputs = [
        { id: 'linkInput' as never, binds: binding('sink', 'linkInput') },
        { id: 'keptLinkInput' as never, binds: binding('sink', 'keptLinkInput') },
        { id: 'netInput' as never, binds: binding('sink', 'netInput') },
        { id: 'keptNetInput' as never, binds: binding('sink', 'keptNetInput') },
      ]
      const projected = (delivery: object, boundaryId: string) => ({
        kind: 'projectedLeg', delivery,
        route: [{ graph: 'body', boundaryId, binding: binding('sink', boundaryId) }],
      })
      ;(initial as any).occurrenceTopologies = {
        a: {
          owner: owner('a'), bodyGraph: 'body', links: {}, nextOrdinal: 0,
          suppressedDeliveries: [
            projected({ kind: 'link', graph: 'root', linkId: 'targetLink' }, 'linkInput'),
            projected({ kind: 'link', graph: 'root', linkId: 'keptLink' }, 'keptLinkInput'),
            projected({ kind: 'netSink', graph: 'root', netId: 'targetNet', to: { node: 'a', port: 'netInput' } }, 'netInput'),
            projected({ kind: 'netSink', graph: 'root', netId: 'keptNet', to: { node: 'a', port: 'keptNetInput' } }, 'keptNetInput'),
          ],
        },
      }
      return initial
    }
    const replacementPlan = (overrides: Record<string, Json>) => ({
      graphId: 'root', nodeId: 'linkSource', from: 'Src', to: 'Replacement', values: {},
      inputRewires: [], outputRewires: [], dropLinks: [], netSourceRewires: [], netSinks: [], dropNets: [],
      ...overrides,
    })
    const cases: Array<{
      name: string
      invocation: Record<string, Json>
      removed: 'targetLink' | 'targetNet'
    }> = [
      { name: 'link.disconnect', invocation: { command: 'link.disconnect', params: { graphId: 'root', linkId: 'targetLink' } }, removed: 'targetLink' },
      { name: 'reroute.insert', invocation: { command: 'reroute.insert', params: { graphId: 'root', linkId: 'targetLink', position: { x: 0, y: 0 } } }, removed: 'targetLink' },
      { name: 'graph.deleteItems link', invocation: { command: 'graph.deleteItems', params: { graphId: 'root', linkIds: ['targetLink'] } }, removed: 'targetLink' },
      { name: 'node.remove cascade', invocation: { command: 'node.remove', params: { graphId: 'root', nodeIds: ['linkSource'] } }, removed: 'targetLink' },
      { name: 'node.replace dropLinks', invocation: { command: 'node.replace', params: { plan: replacementPlan({ dropLinks: ['targetLink'] }) } }, removed: 'targetLink' },
      { name: 'net.disconnectInput', invocation: { command: 'net.disconnectInput', params: { graphId: 'root', to: { node: 'a', port: 'netInput' } } }, removed: 'targetNet' },
      { name: 'net.remove', invocation: { command: 'net.remove', params: { graphId: 'root', netId: 'targetNet' } }, removed: 'targetNet' },
      { name: 'graph.deleteItems net sink', invocation: { command: 'graph.deleteItems', params: { graphId: 'root', netSinks: [{ node: 'a', port: 'netInput' }] } }, removed: 'targetNet' },
      { name: 'node.replace netSinks', invocation: { command: 'node.replace', params: { plan: replacementPlan({ netSinks: [{ net: 'targetNet', sinks: [] }] }) } }, removed: 'targetNet' },
      { name: 'node.replace dropNets', invocation: { command: 'node.replace', params: { plan: replacementPlan({ dropNets: ['targetNet'] }) } }, removed: 'targetNet' },
    ]

    for (const testCase of cases) {
      const store = new DocumentStore(fixture(), coreCommandRegistry())
      const outcome = store.dispatch(testCase.invocation as never)
      expect(outcome.ok, `${testCase.name}: ${JSON.stringify(outcome.diagnostics)}`).toBe(true)
      const deliveries = store.doc.occurrenceTopologies!.a!.suppressedDeliveries!
      expect(deliveries.some((entry) => entry.kind === 'projectedLeg' &&
        (entry.delivery.kind === 'link' ? entry.delivery.linkId : entry.delivery.netId) === testCase.removed), testCase.name)
        .toBe(false)
      expect(deliveries.some((entry) => entry.kind === 'projectedLeg' && entry.delivery.kind === 'link' &&
        entry.delivery.linkId === 'keptLink'), testCase.name).toBe(true)
      expect(deliveries.some((entry) => entry.kind === 'projectedLeg' && entry.delivery.kind === 'netSink' &&
        entry.delivery.netId === 'keptNet'), testCase.name).toBe(true)
    }
  })

  it('keeps no-overlay save bytes and compiles an equivalent local replacement', () => {
    const initial = document()
    expect(JSON.stringify(JSON.parse(JSON.stringify(initial)))).toBe(JSON.stringify(initial))
    const store = new DocumentStore(initial, coreCommandRegistry())
    expect(store.dispatch(localConnect(store.doc, owner('a')).invocation).ok).toBe(true)
    const result = compile({
      document: store.doc, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('c'), schemaHash: 'schema',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['a.sink']!.inputs.in).toEqual(['a.producerTwo', 0])
  })

  it('keeps occurrence-referenced members during compaction and derives one trailing ghost', () => {
    const base = document()
    const target = owner('a')
    const initial: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        body: {
          ...base.graphs.body!,
          nodes: {
            ...base.graphs.body!.nodes,
            dynamicNode: {
              id: asNodeId('dynamicNode'), type: 'Sink', values: {},
              dynamic: { images: { members: ['m0', 'm1'], seq: 2 } },
            },
          },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(target)]: {
          owner: target, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            l0: {
              id: 'l0' as never,
              from: body({ node: 'producerTwo', port: 'out' }),
              to: body({ node: 'dynamicNode', port: 'images.value', members: ['m0'] }),
            },
          },
        },
      },
    }
    const store = new DocumentStore(initial, coreCommandRegistry())
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'body', nodeId: 'dynamicNode' } }).ok).toBe(true)
    expect(store.doc.graphs.body!.nodes.dynamicNode!.dynamic).toEqual({ images: { members: ['m0'], seq: 2 } })

    const autogrow: NodeSchema = {
      type: 'Grow', displayName: 'Grow', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images', type: { kind: 'concrete', name: 'IMAGE' }, optional: true,
        dynamic: {
          kind: 'autogrow', naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
          template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
        },
      }],
    }
    const elaborated = elaborateInterface(autogrow, { values: {}, dynamic: { images: { members: ['m0'], seq: 2 } } })
    expect(elabInputsOf(elaborated).filter((input) => input.origin.kind === 'member' && input.origin.ghost === true)).toHaveLength(1)
  })
})
