import { describe, expect, it } from 'vitest'
import type { GraphDef, Json, LinkData, NamedNetData, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, occurrenceKey, type LinkEndpoint, type PortRef } from '../src/ids.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { createLocalSession as createRawLocalSession } from '../src/commands/session.js'
import { checkDocument } from '../src/invariants.js'
import { compile } from '../src/compile/compile.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import {
  EMPTY_SUBGRAPH_DEFINITION,
  EMPTY_SUBGRAPH_VIEW,
  auditExtractionCuts,
  boundaryNameCandidates,
  canonicalizeLifecycleSelection,
  checkProspectiveDefinitionDag,
  checkProspectiveExtractionDag,
  checkProspectiveFlattenDag,
  expandLifecycleSelectionFromGroups,
  flattenRegistryMatchesSchemaPlan,
  flattenSchemaPlanDigest,
  flattenShellRefusal,
  flattenShellRefusalDiagnostic,
  hasSemanticLifecycleSelection,
  lifecycleCanonicalHash,
  lifecycleFlattenFingerprint,
  lifecycleSelectionFingerprint,
  lifecycleSelectionProjection,
  missingLifecycleEntities,
  planFreshSubgraphCreate,
  planBoundaryNames,
  planExtractedGeometry,
  planFlattenBoundaryRoutes,
  planFlattenedGeometry,
  validateLifecycleGeometry,
  validateFlattenGeometry,
  verifyLifecycleSelectionPlan,
  walkFlattenStoredState,
  type LifecycleSelectionInput,
} from '../src/lifecycle/planner.js'
import { effectiveOccurrenceTopology, planFlattenOccurrenceTopology } from '../src/compile/effective-topology.js'

type MutableDocument = Omit<WorkflowDocument, 'graphs' | 'view' | 'surfaces' | 'occurrenceTopologies'> & {
  graphs: Record<string, any>
  view: { graphs: Record<string, any> }
  surfaces?: Record<string, any>
  occurrenceTopologies?: Record<string, any>
}

const createLocalSession: typeof createRawLocalSession = (doc, commands, options) =>
  createRawLocalSession(doc, commands, {
    schemaResolverFor: () => flattenResolver,
    ...options,
  })

const port = (node: string, id: string, members?: readonly string[]): PortRef => ({
  node: node as never,
  port: id as never,
  ...(members !== undefined ? { members: members as never } : {}),
})

const link = (id: string, from: LinkEndpoint, to: LinkEndpoint): LinkData => ({ id: id as never, from, to })

const graph = (overrides: Partial<GraphDef> = {}): GraphDef => ({
  id: 'root' as never,
  name: 'Root',
  nodes: {
    outside: { id: 'outside' as never, type: 'Node', values: {} },
    inside: { id: 'inside' as never, type: 'Node', values: {} },
    inside2: { id: 'inside2' as never, type: 'Node', values: {} },
  },
  links: {},
  nets: {},
  reroutes: {},
  valueSources: { value: { id: 'value' as never, value: 1 } },
  selectors: {
    selector: {
      id: 'selector' as never,
      candidates: [{ id: 'candidate' as never }],
      policy: { kind: 'fixed', candidate: 'candidate' as never },
    },
  },
  nextOrdinal: 20,
  ...overrides,
})

const document = (root = graph()): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage' as never,
  root: 'root' as never,
  graphs: { root },
  view: {
    graphs: {
      root: {
        nodes: {
          inside: { position: { x: 10, y: 20 }, size: { width: 100, height: 50 } },
          inside2: { position: { x: 40, y: 80 } },
          outside: { position: { x: -10, y: -20 } },
        },
        reroutes: {},
        valueSources: { value: { position: { x: 4, y: 5 } } },
        selectors: { selector: { position: { x: 6, y: 7 } } },
        groups: { group: { id: 'group', title: 'Group', bounds: { x: 0, y: 0, width: 200, height: 100 } } },
      },
    },
  },
})

const extractInvocation = (
  doc: WorkflowDocument,
  graphId: string,
  nodeIds: readonly string[],
  instancePath: readonly string[] = [],
  name = 'Extracted',
) => ({
  command: 'subgraph.extract',
  params: {
    graphId,
    instancePath,
    selection: { nodeIds },
    selectionFingerprint: lifecycleSelectionFingerprint(doc, graphId, { nodeIds })!,
    specializedSlotRoots: [],
    widgetTapSources: [],
    placementCenter: { x: 0, y: 0 },
    resolvedGeometry: [...nodeIds].sort().map((id, index) => {
      const view = doc.view.graphs[graphId]?.nodes[id]
      return {
        id,
        kind: 'node',
        x: view?.position?.x ?? index * 160,
        y: view?.position?.y ?? 0,
        width: view?.size?.width ?? 140,
        height: view?.size?.height ?? 80,
      }
    }),
    name,
  },
})

const l4ExtractInvocation = (
  doc: WorkflowDocument,
  selection: LifecycleSelectionInput,
  resolvedGeometry: readonly Record<string, unknown>[],
  graphId = 'root',
  instancePath: readonly string[] = [],
) => ({
  command: 'subgraph.extract',
  params: {
    graphId,
    instancePath,
    selection,
    selectionFingerprint: lifecycleSelectionFingerprint(doc, graphId, selection)!,
    specializedSlotRoots: [],
    widgetTapSources: [],
    groupMemberships: (selection.groupIds ?? []).map((groupId) => ({
      groupId,
      nodeIds: selection.nodeIds ?? [],
      rerouteIds: selection.rerouteIds ?? [],
      valueSourceIds: selection.valueSourceIds ?? [],
      selectorIds: selection.selectorIds ?? [],
    })),
    placementCenter: { x: 900, y: 700 },
    resolvedGeometry,
    name: 'Extracted L4',
  } as unknown as Json,
})

describe('fresh subgraph create planner', () => {
  it('localizes one shared occurrence as one serializable undoable command', () => {
    const initial = document(graph({
      nodes: {
        first: { id: 'first' as never, type: '#shared', values: {} },
        second: { id: 'second' as never, type: '#shared', values: {} },
      },
    }))
    ;(initial as MutableDocument).view.graphs.root = { nodes: { first: { position: { x: 0, y: 0 } }, second: { position: { x: 200, y: 0 } } } }
    ;(initial as MutableDocument).graphs.shared = graph({
      id: 'shared' as never,
      name: 'Shared',
      nodes: {
        nested: { id: 'nested' as never, type: '#child', values: { value: 3 } },
        producer: { id: 'producer' as never, type: 'Node', values: {} },
      },
      links: { nestedIncoming: link('nestedIncoming', port('producer', 'out'), port('nested', 'aux')) },
      boundary: { inputs: [], outputs: [{ id: 'out', binds: { kind: 'port', node: 'nested' as never, port: 'out' as never } }] },
    })
    ;(initial as MutableDocument).graphs.child = graph({
      id: 'child' as never,
      name: 'Child',
      nodes: { deep: { id: 'deep' as never, type: 'Node', values: {} } },
      boundary: { inputs: [{ id: 'aux', binds: { kind: 'port', node: 'deep' as never, port: 'aux' as never } }], outputs: [] },
    })
    ;(initial as MutableDocument).view.graphs.shared = { nodes: { nested: { position: { x: 4, y: 5 } }, producer: {} } }
    ;(initial as MutableDocument).view.graphs.child = { nodes: { deep: {} } }
    const sharedOutputBinding = initial.graphs.shared!.boundary!.outputs[0]!.binds
    const childAuxBinding = initial.graphs.child!.boundary!.inputs[0]!.binds
    ;(initial as MutableDocument).occurrenceTopologies = {
      first: {
        owner: { instancePath: [], node: 'first' }, bodyGraph: 'shared', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: {
              kind: 'boundary', occurrence: { instancePath: [], node: 'first' }, address: { port: 'out' },
              route: [{ graph: 'shared', boundaryId: 'out', binding: sharedOutputBinding }],
            },
            to: { kind: 'body', endpoint: port('nested', 'out') },
          },
        },
      },
      'first.nested': {
        owner: { instancePath: ['first'], node: 'nested' }, bodyGraph: 'child', links: {}, nextOrdinal: 0,
        suppressedDeliveries: [{
          kind: 'projectedLeg',
          delivery: { kind: 'link', graph: 'shared', linkId: 'nestedIncoming' },
          route: [{ graph: 'child', boundaryId: 'aux', binding: childAuxBinding }],
        }],
      },
      second: { owner: { instancePath: [], node: 'second' }, bodyGraph: 'shared', links: {}, nextOrdinal: 0 },
    }
    expect(checkDocument(initial), JSON.stringify(checkDocument(initial))).toEqual([])
    const session = createLocalSession(initial, coreCommandRegistry())
    const invocation = { command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } } as const

    expect(JSON.parse(JSON.stringify(invocation))).toEqual(invocation)
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.graphs.root!.nodes.second!.type).toBe('#shared')
    expect(session.doc.graphs.g0).toMatchObject({ name: 'Shared (Unique)', nodes: { nested: { type: '#child' } } })
    expect(session.doc.graphs.g0).not.toBe(initial.graphs.shared)
    expect(session.doc.view.graphs.g0).toEqual(initial.view.graphs.shared)
    expect(session.doc.occurrenceTopologies?.first?.bodyGraph).toBe('g0')
    expect(session.doc.occurrenceTopologies?.first).toMatchObject({
      links: { l0: { from: { route: [{ graph: 'g0' }] } } },
    })
    expect(session.doc.occurrenceTopologies?.['first.nested']?.bodyGraph).toBe('child')
    expect(session.doc.occurrenceTopologies?.['first.nested']?.suppressedDeliveries?.[0]).toMatchObject({
      delivery: { graph: 'g0' },
      route: [{ graph: 'child' }],
    })
    expect(JSON.stringify(session.doc.occurrenceTopologies?.second)).toBe(JSON.stringify(initial.occurrenceTopologies?.second))
    expect(checkDocument(session.doc).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.occurrenceTopologies).toEqual({
      ...initial.occurrenceTopologies,
      first: session.doc.occurrenceTopologies?.first,
      'first.nested': session.doc.occurrenceTopologies?.['first.nested'],
    })
  })

  it('localizes an occurrence selected inside a nested definition', () => {
    const initial = document(graph({ nodes: {
      outer: { id: 'outer' as never, type: '#parent', values: {} },
      sibling: { id: 'sibling' as never, type: '#child', values: {} },
    } })) as MutableDocument
    initial.graphs.parent = graph({
      id: 'parent' as never,
      name: 'Parent',
      nodes: {
        nested: { id: 'nested' as never, type: '#child', values: {} },
        nestedSibling: { id: 'nestedSibling' as never, type: '#child', values: {} },
      },
    })
    initial.graphs.child = graph({ id: 'child' as never, name: 'Child' })
    initial.view.graphs.parent = { nodes: { nested: {}, nestedSibling: {} } }
    initial.view.graphs.child = { nodes: {} }
    initial.occurrenceTopologies = {
      'outer.nested': { owner: { instancePath: ['outer'], node: 'nested' }, bodyGraph: 'child', links: {}, nextOrdinal: 0 },
      sibling: { owner: { instancePath: [], node: 'sibling' }, bodyGraph: 'child', links: {}, nextOrdinal: 0 },
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'parent', nodeId: 'nested' } }).ok).toBe(true)
    expect(session.doc.graphs.parent!.nodes.nested!.type).toBe('#g0')
    expect(session.doc.occurrenceTopologies?.['outer.nested']?.bodyGraph).toBe('g0')
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(JSON.stringify(initial.occurrenceTopologies?.sibling))
    expect(checkDocument(session.doc).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.['outer.nested']?.bodyGraph).toBe('g0')
  })

  it('localize copies exposed parameters and App layout placements for the cloned definition', () => {
    const initial = document(graph({
      nodes: {
        first: { id: 'first' as never, type: '#shared', values: {} },
        second: { id: 'second' as never, type: '#shared', values: {} },
      },
    })) as MutableDocument
    initial.graphs.shared = graph({
      id: 'shared' as never,
      name: 'Shared',
      nodes: { inner: { id: 'inner' as never, type: 'demo.node', values: {} } },
    })
    initial.view.graphs.shared = { nodes: { inner: {} } }
    const malformed = { graphId: 'shared' }
    const foreign = { graphId: 'root', nodeId: 'first', inputId: 'text' }
    const exposed = { graphId: 'shared', nodeId: 'inner', inputId: 'text', label: 'Inner text' }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.exposed': [foreign, exposed, malformed],
      'dinkster.appLayout': {
        version: 1,
        desktop: { items: [
          { id: 'inner-control', kind: 'control', ref: { graphId: 'shared', nodeId: 'inner', inputId: 'text' } },
          { id: 'instructions', kind: 'text', role: 'body', text: 'Instructions' },
          { id: 'controls', kind: 'group', title: 'Controls', children: ['inner-control'] },
        ] },
        mobile: { customized: false, items: [] },
      },
    }
    const session = createLocalSession(initial, coreCommandRegistry())

    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.ext?.['dinkster.exposed']).toEqual([
      foreign,
      exposed,
      { ...exposed, graphId: 'g0' },
      malformed,
    ])
    expect(session.doc.ext?.['dinkster.appLayout']).toEqual({
      version: 1,
      desktop: { items: [
        { id: 'inner-control', kind: 'control', ref: { graphId: 'shared', nodeId: 'inner', inputId: 'text' } },
        { id: 'inner-control@g0', kind: 'control', ref: { graphId: 'g0', nodeId: 'inner', inputId: 'text' } },
        { id: 'instructions', kind: 'text', role: 'body', text: 'Instructions' },
        { id: 'controls', kind: 'group', title: 'Controls', children: ['inner-control', 'inner-control@g0'] },
      ] },
      mobile: { customized: false, items: [] },
    })
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(session.doc.ext?.['dinkster.exposed']).toEqual([
      foreign,
      exposed,
      { ...exposed, graphId: 'g0' },
      malformed,
    ])
  })

  it('localize duplicates net tag placements for the cloned definition', () => {
    const initial = document(graph({
      nodes: {
        first: { id: 'first' as never, type: '#shared', values: {} },
        second: { id: 'second' as never, type: '#shared', values: {} },
      },
    })) as MutableDocument
    initial.graphs.shared = graph({
      id: 'shared' as never,
      name: 'Shared',
      nodes: {
        producer: { id: 'producer' as never, type: 'demo.node', values: {} },
        consumer: { id: 'consumer' as never, type: 'demo.node', values: {} },
      },
      nets: { inner: { id: 'inner' as never, name: 'Inner', source: port('producer', 'out'), sinks: [port('consumer', 'in')] } },
    })
    initial.view.graphs.shared = { nodes: { producer: {}, consumer: {} } }
    const malformed = { graphId: 'shared', netId: 'inner' }
    const rootEntry = { graphId: 'root', netId: 'other', role: 'source', offset: { x: 1, y: 2 } }
    const sourceEntry = { graphId: 'shared', netId: 'inner', role: 'source', offset: { x: 12, y: -8 } }
    const sinkEntry = { graphId: 'shared', netId: 'inner', role: 'sink', to: { node: 'consumer', port: 'in' }, position: { x: 300, y: 40 } }
    ;(initial as unknown as { ext: Json }).ext = { 'dinkster.netViews': [rootEntry, sourceEntry, sinkEntry, malformed] }
    const session = createLocalSession(initial, coreCommandRegistry())

    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      rootEntry,
      sourceEntry,
      { ...sourceEntry, graphId: 'g0' },
      sinkEntry,
      { ...sinkEntry, graphId: 'g0' },
      malformed,
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([rootEntry, sourceEntry, sinkEntry, malformed])
  })

  it('creates the minimal invariant-clean definition and occurrence as one undoable batch', () => {
    const initial = document()
    const session = createLocalSession(initial, coreCommandRegistry())
    const plan = planFreshSubgraphCreate(session.doc, {
      parentGraphId: 'root',
      definition: EMPTY_SUBGRAPH_DEFINITION,
      view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 12, y: 34 } },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan).toMatchObject({ graphId: 'g0', name: 'New Subgraph' })
    expect(plan.invocation).toMatchObject({
      command: 'batch',
      params: {
        invocations: [
          { command: 'subgraph.import', params: { graphs: { g0: { id: 'g0', name: 'New Subgraph' } } } },
          { command: 'node.add', params: { graphId: 'root', type: '#g0', position: { x: 12, y: 34 }, values: {} } },
        ],
      },
    })
    expect(session.dispatch(plan.invocation).ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.doc.graphs.g0).toEqual({
      id: 'g0',
      name: 'New Subgraph',
      nodes: {},
      links: {},
      nets: {},
      reroutes: {},
      boundary: { inputs: [], outputs: [] },
      nextOrdinal: 0,
    })
    expect(session.doc.view.graphs.g0).toEqual({ nodes: {} })
    expect(session.doc.graphs.root!.nodes.n20).toMatchObject({ type: '#g0', values: {} })
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.g0).toBeUndefined()
    expect(session.doc.view.graphs.g0).toBeUndefined()
    expect(session.doc.graphs.root!.nodes.n20).toBeUndefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(21)
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.canUndo).toBe(false)
  })

  it('suffixes default names across all definitions while preserving a caller-supplied nonblank name', () => {
    const doc = document()
    ;(doc as MutableDocument).graphs.named = graph({ id: 'named' as never, name: 'New Subgraph' })
    ;(doc as MutableDocument).graphs.named2 = graph({ id: 'named2' as never, name: 'New Subgraph 2' })
    ;(doc as MutableDocument).view.graphs.named = { nodes: {} }
    ;(doc as MutableDocument).view.graphs.named2 = { nodes: {} }
    const defaultPlan = planFreshSubgraphCreate(doc, {
      parentGraphId: 'root', definition: EMPTY_SUBGRAPH_DEFINITION, view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 0, y: 0 } },
    })
    expect(defaultPlan.ok && defaultPlan.name).toBe('New Subgraph 3')
    const namedPlan = planFreshSubgraphCreate(doc, {
      parentGraphId: 'root', definition: EMPTY_SUBGRAPH_DEFINITION, view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 0, y: 0 } }, name: 'Reusable',
    })
    expect(namedPlan.ok && namedPlan.name).toBe('Reusable')
  })

  it('refuses a fixed definition-id collision atomically with graph.exists', () => {
    const initial = document()
    const plan = planFreshSubgraphCreate(initial, {
      parentGraphId: 'root', definition: EMPTY_SUBGRAPH_DEFINITION, view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 1, y: 2 } },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const raced = structuredClone(initial) as MutableDocument
    raced.graphs.g0 = graph({ id: 'g0' as never, name: 'Claimed' })
    raced.view.graphs.g0 = { nodes: {} }
    const session = createLocalSession(raced, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(plan.invocation)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('graph.exists')
    expect(session.doc).toBe(before)
    expect(session.revision).toBe(0)
  })

  it('passes a non-empty invariant-clean topology and region occurrence through the same planner', () => {
    const definition = {
      ...EMPTY_SUBGRAPH_DEFINITION,
      nodes: { starter: { id: 'starter', type: 'Starter', values: {} } },
      boundary: {
        inputs: [
          { id: 'item', binds: { kind: 'port', node: 'starter', port: 'item' } },
          { id: 'state', binds: { kind: 'port', node: 'starter', port: 'state' } },
        ],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'starter', port: 'result' } }],
      },
    } as unknown as typeof EMPTY_SUBGRAPH_DEFINITION
    const plan = planFreshSubgraphCreate(document(), {
      parentGraphId: 'root',
      definition,
      view: { nodes: { starter: { position: { x: 10, y: 20 } } } },
      occurrence: {
        position: { x: 30, y: 40 },
        values: { item: [], state: 0 },
        region: {
          kind: 'fold',
          elementPorts: ['item'],
          statePorts: ['state'],
          outputRoles: { result: { kind: 'state', statePort: 'state' } },
        },
      },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const session = createLocalSession(document(), coreCommandRegistry())
    expect(session.dispatch(plan.invocation).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes.starter).toEqual({ id: 'starter', type: 'Starter', values: {} })
    expect(session.doc.view.graphs.g0!.nodes.starter!.position).toEqual({ x: 10, y: 20 })
    expect(session.doc.graphs.root!.nodes.n20!.region).toEqual({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    expect(checkDocument(session.doc)).toEqual([])
  })
})

describe('occurrence topology lifecycle guards', () => {
  const topologyDocument = (): MutableDocument => {
    const initial = document(graph({
      nodes: {
        owner: { id: 'owner' as never, type: '#body', values: {}, dynamic: { items: { members: ['m0'], seq: 1 } } },
        selected: { id: 'selected' as never, type: 'Node', values: {} },
        outside: { id: 'outside' as never, type: 'Node', values: {} },
      },
    })) as MutableDocument
    initial.graphs.body = graph({
      id: 'body' as never, name: 'Body',
      nodes: {
        producer: { id: 'producer' as never, type: 'Source', values: {} },
        sink: { id: 'sink' as never, type: 'Consumer', values: {}, dynamic: { items: { members: ['m0'], seq: 1 } } },
      },
      links: { shared: link('shared', port('producer', 'out'), port('sink', 'in')) },
      nets: { sharedNet: { id: 'sharedNet' as never, name: 'shared', source: port('producer', 'out'), sinks: [port('sink', 'net')] } },
      boundary: { inputs: [], outputs: [] },
    })
    initial.view.graphs.body = { nodes: { producer: {}, sink: {} } }
    ;(initial as any).occurrenceTopologies = {
      owner: {
        owner: { instancePath: [], node: 'owner' }, bodyGraph: 'body', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: { kind: 'body', endpoint: port('producer', 'out') },
            to: { kind: 'body', endpoint: port('sink', 'in') },
          },
        },
        suppressedDeliveries: [
          { kind: 'link', linkId: 'shared' },
          { kind: 'netSink', netId: 'sharedNet', to: port('sink', 'net') },
        ],
      },
    }
    return initial
  }

  it.each([
    ['owner path hop', 'root', [] as string[], ['owner']],
    ['occurrence link endpoint', 'body', ['owner'], ['sink']],
    ['occurrence suppression target', 'body', ['owner'], ['sink']],
    ['occurrence dynamic member owner', 'root', [] as string[], ['owner']],
  ])('extract refuses a selection intersecting an %s', (_label, graphId, instancePath, nodeIds) => {
    const initial = topologyDocument()
    const session = createLocalSession(initial, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(extractInvocation(initial, graphId, nodeIds, instancePath))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.extract.occurrenceTopologyIntersect')
    expect(session.doc).toBe(before)
  })
})

describe('subgraph.extract L3 command', () => {
  it('extracts nodes, plain links, and named nets into exact parent and definition topology', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        a: { id: 'a' as never, type: 'A', values: { keep: 1 } },
        b: { id: 'b' as never, type: 'B', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
      },
      links: {
        inA: link('inA', port('outside', 'out'), port('a', 'input')),
        inB: link('inB', port('outside', 'out'), port('b', 'other')),
        middle: link('middle', port('a', 'middle'), port('b', 'middle')),
        out: link('out', port('a', 'result'), port('consumer', 'input')),
      },
      nets: {
        internal: { id: 'internal' as never, name: 'Internal', source: port('a', 'net'), sinks: [port('b', 'net')] },
        incoming: { id: 'incoming' as never, name: 'Incoming', source: port('outside', 'net'), sinks: [port('a', 'netIn'), port('consumer', 'netIn')] },
        split: { id: 'split' as never, name: 'Split', source: port('b', 'netOut'), sinks: [port('a', 'inner'), port('consumer', 'outer')] },
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'root', ['b', 'a'])).ok).toBe(true)

    expect(session.doc.graphs.g0).toEqual({
      id: 'g0',
      name: 'Extracted',
      nodes: {
        n0: { id: 'n0', type: 'A', values: { keep: 1 } },
        n1: { id: 'n1', type: 'B', values: {} },
      },
      links: {
        l2: { id: 'l2', from: port('n0', 'middle'), to: port('n1', 'middle') },
      },
      nets: {
        net3: { id: 'net3', name: 'Internal', source: port('n0', 'net'), sinks: [port('n1', 'net')] },
        net4: { id: 'net4', name: 'Split', source: port('n1', 'netOut'), sinks: [port('n0', 'inner')] },
      },
      reroutes: {},
      boundary: {
        inputs: [
          { id: 'netIn', binds: { kind: 'port', ...port('n0', 'netIn') } },
          {
            id: 'input',
            binds: { kind: 'port', ...port('n0', 'input') },
            alsoBinds: [{ kind: 'port', ...port('n1', 'other') }],
          },
        ],
        outputs: [
          { id: 'result', binds: { kind: 'port', ...port('n0', 'result') } },
          { id: 'netOut', binds: { kind: 'port', ...port('n1', 'netOut') } },
        ],
      },
      nextOrdinal: 5,
    })
    expect(session.doc.graphs.root).toEqual({
      ...initial.graphs.root,
      nodes: {
        outside: initial.graphs.root!.nodes.outside,
        consumer: initial.graphs.root!.nodes.consumer,
        n20: { id: 'n20', type: '#g0', values: {} },
      },
      links: {
        inA: { id: 'inA', from: port('outside', 'out'), to: port('n20', 'input') },
        out: { id: 'out', from: port('n20', 'result'), to: port('consumer', 'input') },
      },
      nets: {
        incoming: {
          id: 'incoming', name: 'Incoming', source: port('outside', 'net'),
          sinks: [port('consumer', 'netIn'), port('n20', 'netIn')],
        },
        split: { id: 'split', name: 'Split', source: port('n20', 'netOut'), sinks: [port('consumer', 'outer')] },
      },
      nextOrdinal: 21,
    })
    expect(session.doc.view.graphs.g0).toEqual({
      nodes: {
        n0: { position: { x: -150, y: -40 } },
        n1: { position: { x: 10, y: -40 } },
      },
    })
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('extracts one widget output boundary from a multi-node selection for every outside fan-out consumer and round-trips undo', () => {
    const initial = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Int', values: { value: 7 } },
        spare: { id: 'spare' as never, type: 'Keep', values: {} },
        first: { id: 'first' as never, type: 'MathExpression', values: {} },
        second: { id: 'second' as never, type: 'MathExpression', values: {} },
      },
      links: {
        firstTap: link('firstTap', { node: 'inside' as never, tap: 'value' as never }, port('first', 'a')),
        secondTap: link('secondTap', { node: 'inside' as never, tap: 'value' as never }, port('second', 'b')),
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = { inside: {}, spare: {}, first: {}, second: {} }

    const refusedSession = createLocalSession(initial, coreCommandRegistry())
    const refusedBefore = refusedSession.doc
    const refused = refusedSession.dispatch(extractInvocation(initial, 'root', ['inside', 'spare']))
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(refusedSession.doc).toBe(refusedBefore)
    expect(refusedSession.canUndo).toBe(false)

    const widgetSchema: any = {
      type: 'Int', displayName: 'Int', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.int' }, optional: false,
        widget: { widgetType: 'INT', options: {} },
      }],
    }
    const session = createLocalSession(initial, coreCommandRegistry(), {
      schemaResolverFor: () => (type) => type === 'Int' ? widgetSchema : flattenResolver(type),
    })

    const planned = extractInvocation(initial, 'root', ['inside', 'spare'])
    const invocation = {
      ...planned,
      params: { ...planned.params, widgetTapSources: [{ node: 'inside', tap: 'value' }] },
    }
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(Object.values(session.doc.graphs.g0!.nodes).map((node) => node.type).sort()).toEqual(['Int', 'Keep'])
    expect(session.doc.graphs.g0!.boundary).toEqual({
      inputs: [],
      outputs: [{ id: 'value', binds: { kind: 'widgetTap', node: 'n0', tap: 'value' } }],
    })
    expect(session.doc.graphs.root!.links).toEqual({
      firstTap: { id: 'firstTap', from: port('n20', 'value'), to: port('first', 'a') },
      secondTap: { id: 'secondTap', from: port('n20', 'value'), to: port('second', 'b') },
    })
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual({
      ...initial,
      graphs: { ...initial.graphs, root: { ...initial.graphs.root!, nextOrdinal: 21 } },
    })
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.g0!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n0', tap: 'value' })
  })

  it('rejects forged widget output evidence without exact trusted schema support', () => {
    const initial = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Candidate', values: { value: 7 } },
        outside: { id: 'outside' as never, type: 'Consumer', values: {} },
      },
      links: {
        tap: link('tap', { node: 'inside' as never, tap: 'value' as never }, port('outside', 'input')),
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = { inside: {}, outside: {} }
    const planned = extractInvocation(initial, 'root', ['inside'])
    const invocation = {
      ...planned,
      params: { ...planned.params, widgetTapSources: [{ node: 'inside', tap: 'value' }] },
    }
    const input = (overrides: Record<string, unknown> = {}) => ({
      kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.int' }, optional: false,
      widget: { widgetType: 'INT', options: {} },
      ...overrides,
    })
    const schema = (items: readonly unknown[]): any => ({
      type: 'Candidate', displayName: 'Candidate', category: 'test', source: 'v3', isOutputNode: false, items,
    })
    const unsupported = [
      undefined,
      schema([]),
      schema([input({ widget: undefined })]),
      schema([input({ dynamic: { kind: 'dynamicCombo', options: [] } })]),
      schema([input(), input()]),
    ]

    for (const candidate of unsupported) {
      const session = createRawLocalSession(initial, coreCommandRegistry(), {
        schemaResolverFor: () => () => candidate,
      })
      const before = session.doc
      const outcome = session.dispatch(invocation)
      expect(outcome.ok).toBe(false)
      expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe('subgraph.extract.widgetTapSchemaStale')
      expect(session.doc).toBe(before)
      expect(session.canUndo).toBe(false)
    }

    const untrusted = createRawLocalSession(initial, coreCommandRegistry())
    const untrustedBefore = untrusted.doc
    const outcome = untrusted.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe('subgraph.extract.schemaAuthorityUnavailable')
    expect(untrusted.doc).toBe(untrustedBefore)
    expect(untrusted.canUndo).toBe(false)
  })

  it('moves tag offsets of fully extracted nets into the new definition and drops their absolute geometry', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        a: { id: 'a' as never, type: 'A', values: {} },
        b: { id: 'b' as never, type: 'B', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
      },
      links: {},
      nets: {
        internal: { id: 'internal' as never, name: 'Internal', source: port('a', 'net'), sinks: [port('b', 'net')] },
        split: { id: 'split' as never, name: 'Split', source: port('b', 'netOut'), sinks: [port('a', 'inner'), port('consumer', 'outer')] },
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const malformed = { future: true }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [
        { graphId: 'root', netId: 'internal', role: 'source', offset: { x: 30, y: -10 } },
        { graphId: 'root', netId: 'internal', role: 'sink', to: { node: 'b', port: 'net' }, offset: { x: -25, y: 40 } },
        // Absolute geometry is root-graph world coordinates: dropped on move.
        { graphId: 'root', netId: 'internal', role: 'source', position: { x: 9, y: 9 } },
        // The split net keeps a parent entry, so its tag stays put.
        { graphId: 'root', netId: 'split', role: 'source', offset: { x: 5, y: 6 } },
        malformed,
      ],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'root', ['b', 'a'])).ok).toBe(true)
    // Extraction remaps a -> n0, b -> n1, internal -> net2 inside g0.
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      { graphId: 'g0', netId: 'net2', role: 'source', offset: { x: 30, y: -10 } },
      { graphId: 'g0', netId: 'net2', role: 'sink', to: { node: 'n1', port: 'net' }, offset: { x: -25, y: 40 } },
      { graphId: 'root', netId: 'split', role: 'source', offset: { x: 5, y: 6 } },
      malformed,
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext).toEqual((initial as unknown as { ext: Json }).ext)
  })

  it('is one undo and redo while keeping both allocator high-water marks clean', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        inside: { id: 'inside' as never, type: 'Body', values: {} },
      },
      links: { crossing: link('crossing', port('outside', 'out'), port('inside', 'in')) },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'root', ['inside'])).ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.g0).toBeUndefined()
    expect(session.doc.graphs.root!.nodes.inside).toEqual(initial.graphs.root!.nodes.inside)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(21)
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.g0!.nextOrdinal).toBe(1)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(21)
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('rewrites the current enclosing boundary while extracting inside a nested definition', () => {
    const root = graph({
      nodes: { shell: { id: 'shell' as never, type: '#body', values: {} } },
      links: {}, nets: {}, nextOrdinal: 20,
    })
    const body = graph({
      id: 'body' as never,
      name: 'Body',
      nodes: {
        keep: { id: 'keep' as never, type: 'Keep', values: {} },
        move: { id: 'move' as never, type: 'Move', values: {} },
      },
      links: {}, nets: {}, nextOrdinal: 7,
      boundary: {
        inputs: [{
          id: 'fan',
          binds: { kind: 'port', node: 'keep' as never, port: 'a' as never },
          alsoBinds: [{ kind: 'port', node: 'move' as never, port: 'b' as never }],
        }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'move' as never, port: 'out' as never } }],
      },
    })
    const initial = document(root) as MutableDocument
    initial.view.graphs.root = { nodes: { shell: {} } }
    initial.graphs.body = body
    initial.view.graphs.body = { nodes: { keep: {}, move: {} } }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'body', ['move'], ['shell'])).ok).toBe(true)
    expect(session.doc.graphs.body!.boundary).toEqual({
      inputs: [{
        id: 'fan',
        binds: { kind: 'port', node: 'keep', port: 'a' },
        alsoBinds: [{ kind: 'port', node: 'n7', port: 'b' }],
      }],
      outputs: [{ id: 'result', binds: { kind: 'port', node: 'n7', port: 'out' } }],
    })
    expect(session.doc.graphs.g0!.boundary).toEqual({
      inputs: [{ id: 'b', binds: { kind: 'port', node: 'n0', port: 'b' } }],
      outputs: [{ id: 'out', binds: { kind: 'port', node: 'n0', port: 'out' } }],
    })
    expect(session.doc.graphs.root!.nodes.shell!.type).toBe('#body')
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('re-executes against unrelated changes and drops stale intentions loudly', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        inside: { id: 'inside' as never, type: 'Body', values: {} },
      },
      links: { crossing: link('crossing', port('outside', 'out'), port('inside', 'in')) },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const invocation = extractInvocation(initial, 'root', ['inside'])
    const unrelated = structuredClone(initial) as MutableDocument
    unrelated.graphs.g0 = graph({ id: 'g0' as never, name: 'Claimed', nodes: {}, nextOrdinal: 0 })
    unrelated.view.graphs.g0 = { nodes: {} }
    unrelated.graphs.root!.nodes.outside = { ...unrelated.graphs.root!.nodes.outside!, title: 'peer edit' }
    const rebased = createLocalSession(unrelated, coreCommandRegistry())
    expect(rebased.dispatch({ ...invocation, actor: 'actorA' }).ok).toBe(true)
    expect(rebased.doc.graphs.g1).toBeDefined()
    expect(rebased.doc.graphs.root!.nodes['n0-actorA']).toBeDefined()
    expect(rebased.doc.graphs.g1!.nodes['n0-actorA']).toBeDefined()

    const stale = structuredClone(initial) as MutableDocument
    stale.graphs.root!.links.crossing = { ...stale.graphs.root!.links.crossing!, to: port('inside', 'changed') }
    const dropped = createLocalSession(stale, coreCommandRegistry()).dispatch(invocation)
    expect(dropped.ok).toBe(false)
    if (!dropped.ok) expect(dropped.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.stalePlan')

  })

  it('gates specialized-slot roots and prospective multi-driver violations with named diagnostics', () => {
    const slotDoc = document(graph({
      links: { crossing: link('crossing', port('outside', 'out'), port('inside', 'slot')) },
    }))
    const slotInvocation = extractInvocation(slotDoc, 'root', ['inside'])
    const slot = createLocalSession(slotDoc, coreCommandRegistry()).dispatch({
      ...slotInvocation,
      params: { ...slotInvocation.params, specializedSlotRoots: [{ node: 'inside', port: 'slot' }] },
    })
    expect(slot.ok).toBe(false)
    if (!slot.ok) expect(slot.diagnostics[0]!.code).toBe('subgraph.extract.specializedSlotUnsupported')

    const driven = document(graph({
      links: { internal: link('internal', port('inside2', 'out'), port('inside', 'in')) },
      boundary: {
        inputs: [{ id: 'input', binds: { kind: 'port', node: 'inside' as never, port: 'in' as never } }],
        outputs: [],
      },
    }))
    const multiDriver = createLocalSession(driven, coreCommandRegistry())
      .dispatch(extractInvocation(driven, 'root', ['inside', 'inside2']))
    expect(multiDriver.ok).toBe(false)
    if (!multiDriver.ok) expect(multiDriver.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.lifecycle.multiDriver')
  })

  it('transfers view state and refuses malformed selections and exhausted allocation without mutation', () => {
    const viewed = document(graph({
      nodes: { inside: { id: 'inside' as never, type: 'Body', values: {} } },
      links: {}, nets: {}, nextOrdinal: 20,
    })) as MutableDocument
    viewed.view.graphs.root = { nodes: { inside: { position: { x: 1, y: 2 } } } }
    const viewedSession = createLocalSession(viewed, coreCommandRegistry())
    const viewOutcome = viewedSession.dispatch(extractInvocation(viewed, 'root', ['inside']))
    expect(viewOutcome.ok).toBe(true)
    expect(viewedSession.doc.view.graphs.g0!.nodes.n0!.position).toEqual({ x: -70, y: -40 })
    expect(viewedSession.doc.view.graphs.root!.nodes.n20!.position).toEqual({ x: 71, y: 42 })

    for (const split of [false, true]) {
      const collapsed = document(graph({
        nodes: {
          inside: { id: 'inside' as never, type: 'Inside', values: {} },
          inside2: { id: 'inside2' as never, type: 'Inside2', values: {} },
          outside: { id: 'outside' as never, type: 'Outside', values: {} },
        },
        links: {},
        nets: {
          net: {
            id: 'net' as never, name: 'Net', source: port('inside', 'out'),
            sinks: [port('inside2', 'inner'), ...(split ? [port('outside', 'outer')] : [])],
          },
        },
      })) as MutableDocument
      collapsed.view.graphs.root = { nodes: {}, collapsedNets: ['net'], guideNets: ['net'] }
      const collapsedSession = createLocalSession(collapsed, coreCommandRegistry())
      const outcome = collapsedSession.dispatch(extractInvocation(collapsed, 'root', ['inside', 'inside2']))
      expect(outcome.ok).toBe(true)
      expect(collapsedSession.doc.view.graphs.g0!.collapsedNets).toEqual(['net2'])
      expect(collapsedSession.doc.view.graphs.g0!.guideNets).toEqual(['net2'])
      expect(collapsedSession.doc.view.graphs.root!.collapsedNets).toEqual(split ? ['net'] : [])
      expect(collapsedSession.doc.view.graphs.root!.guideNets).toEqual(split ? ['net'] : [])
    }

    const missingCoverageDoc = document()
    const withCoverage = extractInvocation(missingCoverageDoc, 'root', ['inside'])
    const { specializedSlotRoots: _coverage, ...withoutCoverage } = withCoverage.params
    const missingCoverage = createLocalSession(missingCoverageDoc, coreCommandRegistry()).dispatch({
      ...withCoverage,
      params: withoutCoverage,
    })
    expect(missingCoverage.ok).toBe(false)
    if (!missingCoverage.ok) expect(missingCoverage.diagnostics[0]!.code).toBe('params.invalid')

    const malformed = createLocalSession(document(), coreCommandRegistry()).dispatch({
      command: 'subgraph.extract',
      params: {
        graphId: 'root', instancePath: [], selection: { nodeIds: ['inside', 1] },
        selectionFingerprint: 'sha256:not-used', specializedSlotRoots: [],
      },
    })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.diagnostics[0]!.code).toBe('params.invalid')

    const exhausted = document(graph({
      nodes: { inside: { id: 'inside' as never, type: 'Body', values: {} } },
      links: {}, nets: {}, nextOrdinal: Number.MAX_SAFE_INTEGER,
    })) as MutableDocument
    exhausted.view.graphs.root = { nodes: { inside: {} } }
    const exhaustedSession = createLocalSession(exhausted, coreCommandRegistry())
    const exhaustedBefore = exhaustedSession.doc
    const exhaustion = exhaustedSession.dispatch(extractInvocation(exhausted, 'root', ['inside']))
    expect(exhaustion.ok).toBe(false)
    if (!exhaustion.ok) expect(exhaustion.diagnostics[0]!.code).toBe('subgraph.lifecycle.idExhausted')
    expect(exhaustedSession.doc).toBe(exhaustedBefore)
  })

  it('collapses an all-moved enclosing input fan-out without retaining stale bindings', () => {
    const body = graph({
      id: 'body' as never,
      name: 'Body',
      nodes: {
        a: { id: 'a' as never, type: 'A', values: {} },
        b: { id: 'b' as never, type: 'B', values: {} },
        c: { id: 'c' as never, type: 'C', values: {} },
      },
      links: {}, nets: {}, nextOrdinal: 4,
      boundary: {
        inputs: [{
          id: 'fan',
          binds: { kind: 'port', node: 'a' as never, port: 'one' as never },
          alsoBinds: [
            { kind: 'port', node: 'b' as never, port: 'two' as never },
            { kind: 'port', node: 'c' as never, port: 'three' as never },
          ],
        }],
        outputs: [],
      },
    })
    const root = graph({ nodes: { shell: { id: 'shell' as never, type: '#body', values: {} } }, links: {}, nets: {} })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { shell: {} } }
    initial.view.graphs.body = { nodes: { a: {}, b: {}, c: {} } }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'body', ['a', 'b', 'c'], ['shell'])).ok).toBe(true)
    expect(session.doc.graphs.body!.boundary!.inputs).toEqual([
      { id: 'fan', binds: { kind: 'port', node: 'n4', port: 'one' } },
    ])
    expect(session.doc.graphs.g0!.boundary!.inputs).toEqual([{
      id: 'one',
      binds: { kind: 'port', node: 'n0', port: 'one' },
      alsoBinds: [
        { kind: 'port', node: 'n1', port: 'two' },
        { kind: 'port', node: 'n2', port: 'three' },
      ],
    }])
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('retains each semantic link extension and atomically refuses opaque split-net state', () => {
    const linksDoc = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        a: { id: 'a' as never, type: 'A', values: {} },
        b: { id: 'b' as never, type: 'B', values: {} },
      },
      links: {
        plain: link('plain', port('outside', 'out'), port('a', 'plain')),
        extA: { ...link('extA', port('outside', 'out'), port('a', 'ext')), ext: { owner: 'a' } },
        extB: { ...link('extB', port('outside', 'out'), port('b', 'ext')), ext: { owner: 'b' } },
      },
    })) as MutableDocument
    linksDoc.view.graphs.root = { nodes: {} }
    const linksSession = createLocalSession(linksDoc, coreCommandRegistry())
    expect(linksSession.dispatch(extractInvocation(linksDoc, 'root', ['a', 'b'])).ok).toBe(true)
    expect(linksSession.doc.graphs.root!.links).toEqual({
      extA: { id: 'extA', from: port('outside', 'out'), to: port('n20', 'ext'), ext: { owner: 'a' } },
      extB: { id: 'extB', from: port('outside', 'out'), to: port('n20', 'ext_2'), ext: { owner: 'b' } },
      plain: { id: 'plain', from: port('outside', 'out'), to: port('n20', 'plain') },
    })

    const netDoc = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Inside', values: {} },
        inside2: { id: 'inside2' as never, type: 'Inside2', values: {} },
        outside: { id: 'outside' as never, type: 'Outside', values: {} },
      },
      nets: {
        split: {
          id: 'split' as never, name: 'Split', source: port('inside', 'out'),
          sinks: [port('inside2', 'inner'), port('outside', 'outer')], ext: { opaque: true },
        },
      },
    })) as MutableDocument
    netDoc.view.graphs.root = { nodes: {} }
    const netSession = createLocalSession(netDoc, coreCommandRegistry())
    const before = netSession.doc
    const refusal = netSession.dispatch(extractInvocation(netDoc, 'root', ['inside', 'inside2']))
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(netSession.doc).toBe(before)
  })
})

describe('subgraph.extract L4 structural and view completion', () => {
  it('coexists across nets, reroutes, taps, value sources, selectors, wire-15 members, nested occurrences, groups, modes, and view state', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Outside', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
        a: {
          id: 'a' as never,
          type: 'A',
          mode: 'muted',
          values: { dormant: 7 },
          dynamic: { family: { members: ['m9'], memberState: { m9: { nested: { members: ['name-a'] } } } } },
        },
        b: { id: 'b' as never, type: 'B', mode: 'bypassed', values: {} },
        nested: { id: 'nested' as never, type: '#child', values: { promoted: 3 } },
      },
      reroutes: { route: { id: 'route' as never, ext: { route: true } } },
      valueSources: { literal: { id: 'literal' as never, value: 42, title: 'Literal', ext: { keep: true } } },
      selectors: {
        choose: {
          id: 'choose' as never,
          candidates: [{ id: 'left' as never, title: 'Left' }, { id: 'right' as never }],
          policy: { kind: 'fixed', candidate: 'right' as never },
          ext: { keep: true },
        },
      },
      links: {
        tapIn: link('tapIn', { node: 'outside' as never, tap: 'widget' as never }, port('a', 'tapInput')),
        memberIn: link('memberIn', port('outside', 'member'), port('a', 'family.child.leaf', ['m9', 'name-a'])),
        valueFeed: link('valueFeed', { valueSource: 'literal' as never }, port('a', 'literal')),
        routeDriver: link('routeDriver', port('a', 'out'), { reroute: 'route' as never }),
        routeConsumer: link('routeConsumer', { reroute: 'route' as never }, port('b', 'in')),
        selectorFeed: link('selectorFeed', port('a', 'choice'), { selector: 'choose' as never, candidate: 'right' as never }),
        selectorOut: link('selectorOut', { selector: 'choose' as never }, port('b', 'choice')),
        nestedFeed: link('nestedFeed', port('b', 'nested'), port('nested', 'in')),
      },
      nets: {
        split: {
          id: 'split' as never,
          name: 'Split',
          source: port('b', 'netOut'),
          sinks: [port('a', 'netIn'), port('consumer', 'netIn')],
        },
      },
      nextOrdinal: 30,
    })) as MutableDocument
    initial.graphs.child = graph({ id: 'child' as never, name: 'Child', nodes: {}, valueSources: {}, selectors: {}, nextOrdinal: 0 })
    initial.view.graphs.child = { nodes: {} }
    initial.view.graphs.root = {
      nodes: {
        outside: { position: { x: -200, y: 0 } },
        consumer: { position: { x: 500, y: 0 } },
        a: { position: { x: 100, y: 100 }, size: { width: 120, height: 80 }, collapsed: true, color: '#123456' },
        b: { position: { x: 300, y: 100 }, sections: { advanced: { collapsed: true } } },
        nested: { position: { x: 500, y: 100 } },
      },
      reroutes: { route: { position: { x: 270, y: 180 }, ext: { view: true } } },
      valueSources: { literal: { position: { x: 100, y: 260 }, view: 'slider' } },
      selectors: { choose: { position: { x: 300, y: 260 }, ext: { view: true } } },
      groups: { grp4: { id: 'grp4', title: 'Body', bounds: { x: 50, y: 50, width: 600, height: 300 }, color: '#abcdef' } },
      collapsedNets: ['split'],
    }
    const selection = {
      nodeIds: ['a', 'b', 'nested'],
      rerouteIds: ['route'],
      valueSourceIds: ['literal'],
      selectorIds: ['choose'],
      groupIds: ['grp4'],
    }
    const geometry = [
      { id: 'a', kind: 'node', x: 100, y: 100, width: 120, height: 80 },
      { id: 'b', kind: 'node', x: 300, y: 100, width: 140, height: 80 },
      { id: 'nested', kind: 'node', x: 500, y: 100, width: 140, height: 80 },
      { id: 'route', kind: 'reroute', x: 270, y: 180, width: 0, height: 0 },
      { id: 'literal', kind: 'valueSource', x: 100, y: 260, width: 140, height: 80 },
      { id: 'choose', kind: 'selector', x: 300, y: 260, width: 140, height: 80 },
      { id: 'grp4', kind: 'group', x: 50, y: 50, width: 600, height: 300 },
    ]
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, selection, geometry))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.g0).toMatchObject({
      nodes: {
        n0: { mode: 'muted', values: { dormant: 7 }, dynamic: initial.graphs.root!.nodes.a!.dynamic },
        n1: { mode: 'bypassed' },
        n2: { type: '#child', values: { promoted: 3 } },
      },
      valueSources: { v3: { value: 42, title: 'Literal', ext: { keep: true } } },
      selectors: {
        s4: {
          candidates: [{ id: 'c5', title: 'Left' }, { id: 'c6' }],
          policy: { kind: 'fixed', candidate: 'c6' },
          ext: { keep: true },
        },
      },
      reroutes: { r7: { id: 'r7', ext: { route: true } } },
    })
    expect(Object.values(session.doc.graphs.g0!.links).map((edge) => edge.from)).toContainEqual({ valueSource: 'v3' })
    expect(Object.values(session.doc.graphs.g0!.links).map((edge) => edge.to)).toContainEqual({ selector: 's4', candidate: 'c6' })
    expect(session.doc.graphs.g0!.boundary!.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ binds: expect.objectContaining({ node: 'n0', port: 'family.child.leaf', members: ['m9', 'name-a'] }) }),
      expect.objectContaining({ binds: expect.objectContaining({ node: 'n0', port: 'tapInput' }) }),
    ]))
    expect(session.doc.view.graphs.g0).toMatchObject({
      nodes: { n0: { collapsed: true, color: '#123456' }, n1: { sections: { advanced: { collapsed: true } } } },
      reroutes: { r7: { ext: { view: true } } },
      valueSources: { v3: { view: 'slider' } },
      selectors: { s4: { ext: { view: true } } },
      groups: { grp0: { id: 'grp0', title: 'Body', color: '#abcdef' } },
      groupSeq: 1,
      collapsedNets: [expect.any(String)],
    })
    expect(session.doc.view.graphs.root!.collapsedNets).toEqual(['split'])
    expect(session.doc.view.graphs.root!.groupSeq).toBe(5)
    expect(session.doc.view.graphs.root!.nodes.n30!.position).toEqual({ x: 350, y: 200 })
    expect(checkDocument(session.doc).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc.view.graphs.root!.groups!.grp4).toBeDefined()
    expect(session.doc.view.graphs.root!.groupSeq).toBe(5)
  })

  it('keeps an unselected group in the parent and warns when extraction empties it', () => {
    const initial = document(graph({
      nodes: { only: { id: 'only' as never, type: 'Only', values: {} } },
      valueSources: {}, selectors: {}, links: {}, nets: {}, nextOrdinal: 20,
    })) as MutableDocument
    initial.view.graphs.root = {
      nodes: { only: { position: { x: 10, y: 10 } } },
      groups: { left: { id: 'left', title: 'Left behind', bounds: { x: 0, y: 0, width: 100, height: 100 } } },
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, { nodeIds: ['only'] }, [
      { id: 'only', kind: 'node', x: 10, y: 10, width: 40, height: 40 },
    ]))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.extract.groupEmptied')
    expect(session.doc.view.graphs.root!.groups!.left).toBeDefined()
    expect(session.doc.view.graphs.g0!.groups).toBeUndefined()
  })

  it('refuses incomplete geometry atomically', () => {
    const initial = document(graph({ nodes: { inside: { id: 'inside' as never, type: 'Inside', values: {} } }, links: {}, nets: {} }))
    const session = createLocalSession(initial, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(l4ExtractInvocation(initial, { nodeIds: ['inside'] }, []))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(session.doc).toBe(before)
  })

  it('forwards promoted and whole-family enclosing boundaries through the new occurrence', () => {
    const root = graph({ nodes: { shell: { id: 'shell' as never, type: '#body', values: {} } }, valueSources: {}, selectors: {}, links: {}, nets: {} })
    const body = graph({
      id: 'body' as never,
      name: 'Body',
      nodes: { move: { id: 'move' as never, type: 'Move', values: { widget: 9 } } },
      valueSources: {}, selectors: {}, links: {}, nets: {}, nextOrdinal: 4,
      boundary: {
        inputs: [
          { id: 'widget', displayName: 'Widget label', binds: { kind: 'port', node: 'move' as never, port: 'widget' as never }, promoted: true },
          { id: 'familyIn', binds: { kind: 'family', node: 'move' as never, port: 'familyIn' as never, members: ['m2' as never], slots: ['inputSlot'] } },
        ],
        outputs: [{ id: 'family', binds: { kind: 'family', node: 'move' as never, port: 'family' as never, members: ['m1' as never], slots: ['slot'] } }],
      },
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { shell: {} } }
    initial.view.graphs.body = { nodes: { move: { position: { x: 20, y: 30 } } } }
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, { nodeIds: ['move'] }, [
      { id: 'move', kind: 'node', x: 20, y: 30, width: 100, height: 60 },
    ], 'body', ['shell']))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.g0!.boundary).toEqual({
      inputs: [
        { id: 'widget', displayName: 'Widget label', binds: { kind: 'port', node: 'n0', port: 'widget' }, promoted: true },
        { id: 'familyIn', binds: { kind: 'family', node: 'n0', port: 'familyIn', members: ['m2'] } },
      ],
      outputs: [{ id: 'family', binds: { kind: 'family', node: 'n0', port: 'family', members: ['m1'] } }],
    })
    expect(session.doc.graphs.body!.boundary).toEqual({
      inputs: [
        { id: 'widget', displayName: 'Widget label', binds: { kind: 'port', node: 'n4', port: 'widget' }, promoted: true },
        { id: 'familyIn', binds: { kind: 'family', node: 'n4', port: 'familyIn', slots: ['inputSlot'] } },
      ],
      outputs: [{ id: 'family', binds: { kind: 'family', node: 'n4', port: 'family', slots: ['slot'] } }],
    })
    expect(session.doc.graphs.body!.nodes.n4!.values).toEqual({})
  })

  it('refuses incomplete selected-group snapshots, durable surface bindings, and opaque boundary metadata', () => {
    const grouped = document(graph({
      nodes: { inside: { id: 'inside' as never, type: 'Inside', values: {} }, hidden: { id: 'hidden' as never, type: 'Hidden', values: {} } },
      links: {}, nets: {}, valueSources: {}, selectors: {}, nextOrdinal: 20,
    })) as MutableDocument
    grouped.view.graphs.root = {
      nodes: { inside: { position: { x: 0, y: 0 } }, hidden: { position: { x: 20, y: 20 } } },
      groups: { grp0: { id: 'grp0', title: 'Group', bounds: { x: 0, y: 0, width: 100, height: 100 } } },
    }
    const incomplete = l4ExtractInvocation(grouped, { nodeIds: ['inside'], groupIds: ['grp0'] }, [
      { id: 'inside', kind: 'node', x: 0, y: 0, width: 10, height: 10 },
      { id: 'grp0', kind: 'group', x: 0, y: 0, width: 100, height: 100 },
    ])
    ;(incomplete.params as any).groupMemberships[0].nodeIds = ['inside', 'hidden']
    const incompleteOutcome = createLocalSession(grouped, coreCommandRegistry()).dispatch(incomplete)
    expect(incompleteOutcome.ok).toBe(false)
    if (!incompleteOutcome.ok) expect(incompleteOutcome.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')

    grouped.surfaces = {
      panel: {
        id: 'panel',
        type: 'core.modePanel',
        config: { bindings: [{ kind: 'group', graphId: 'root', groupId: 'grp0' }] },
      },
    }
    const boundOutcome = createLocalSession(grouped, coreCommandRegistry()).dispatch(l4ExtractInvocation(
      grouped,
      { nodeIds: ['inside', 'hidden'], groupIds: ['grp0'] },
      [
        { id: 'inside', kind: 'node', x: 0, y: 0, width: 10, height: 10 },
        { id: 'hidden', kind: 'node', x: 20, y: 20, width: 10, height: 10 },
        { id: 'grp0', kind: 'group', x: 0, y: 0, width: 100, height: 100 },
      ],
    ))
    expect(boundOutcome.ok).toBe(false)
    if (!boundOutcome.ok) expect(boundOutcome.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')

    const withBoundaryExt = structuredClone(grouped) as MutableDocument
    delete withBoundaryExt.surfaces
    withBoundaryExt.graphs.root!.boundary = {
      inputs: [{ id: 'input', binds: { kind: 'port', node: 'inside', port: 'in' }, ext: { opaque: true } }],
      outputs: [],
    }
    const extOutcome = createLocalSession(withBoundaryExt, coreCommandRegistry()).dispatch(l4ExtractInvocation(
      withBoundaryExt,
      { nodeIds: ['inside'] },
      [{ id: 'inside', kind: 'node', x: 0, y: 0, width: 10, height: 10 }],
    ))
    expect(extOutcome.ok).toBe(false)
    if (!extOutcome.ok) expect(extOutcome.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
  })

  it.each([
    {
      name: 'selected reroute crossing',
      selection: { nodeIds: ['inside'], rerouteIds: ['route'] },
      links: { crossing: link('crossing', port('outside', 'out'), { reroute: 'route' as never }) },
      reroutes: { route: { id: 'route' as never } },
      geometry: [
        { id: 'inside', kind: 'node', x: 0, y: 0, width: 100, height: 60 },
        { id: 'route', kind: 'reroute', x: 120, y: 20, width: 0, height: 0 },
      ],
      code: 'subgraph.extract.structuralCutUnsupported',
    },
    {
      name: 'selected selector candidate crossing',
      selection: { nodeIds: ['inside'], selectorIds: ['selector'] },
      links: { crossing: link('crossing', port('outside', 'out'), { selector: 'selector' as never, candidate: 'candidate' as never }) },
      reroutes: {},
      geometry: [
        { id: 'inside', kind: 'node', x: 0, y: 0, width: 100, height: 60 },
        { id: 'selector', kind: 'selector', x: 120, y: 0, width: 100, height: 60 },
      ],
      code: 'subgraph.extract.structuralCutUnsupported',
    },
    {
      name: 'selected value-source output',
      selection: { nodeIds: ['inside'], valueSourceIds: ['value'] },
      links: { crossing: link('crossing', { valueSource: 'value' as never }, port('outside', 'in')) },
      reroutes: {},
      geometry: [
        { id: 'inside', kind: 'node', x: 0, y: 0, width: 100, height: 60 },
        { id: 'value', kind: 'valueSource', x: 120, y: 0, width: 100, height: 60 },
      ],
      code: 'subgraph.extract.structuralOutputUnsupported',
    },
  ])('refuses the whole operation for $name', ({ selection, links, reroutes, geometry, code }) => {
    const initial = document(graph({ links, reroutes }))
    const session = createLocalSession(initial, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(l4ExtractInvocation(initial, selection, geometry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.diagnostics[0]!.code).toBe(code)
      expect(outcome.diagnostics[0]!.refs?.[0]?.graphId).toBe('root')
    }
    expect(session.doc).toBe(before)
  })
})

describe('subgraph lifecycle canonical selection and fingerprint', () => {
  it('canonicalizes, deduplicates, and validates every selection kind with own-key lookup', () => {
    const selection = canonicalizeLifecycleSelection({
      nodeIds: ['inside2', 'inside', 'inside2'],
      rerouteIds: [],
      valueSourceIds: ['value', 'value'],
      selectorIds: ['selector'],
      groupIds: ['group'],
    })
    expect(selection).toEqual({
      nodeIds: ['inside', 'inside2'],
      rerouteIds: [],
      valueSourceIds: ['value'],
      selectorIds: ['selector'],
      groupIds: ['group'],
    })
    expect(missingLifecycleEntities(document(), 'root', selection)).toEqual([])
    expect(missingLifecycleEntities(document(), 'root', canonicalizeLifecycleSelection({ nodeIds: ['constructor'] })))
      .toEqual([{ kind: 'nodeIds', id: 'constructor' }])
    expect(hasSemanticLifecycleSelection(selection)).toBe(true)
    expect(hasSemanticLifecycleSelection(canonicalizeLifecycleSelection({ rerouteIds: ['r'], groupIds: ['g'] }))).toBe(false)
  })

  it('pins the versioned canonical SHA-256 projection independent of selection and object insertion order', () => {
    const links = {
      z: link('z', port('outside', 'out'), port('inside', 'in')),
      a: link('a', { node: 'inside' as never, tap: 'widget' as never }, port('outside', 'in')),
    }
    const first = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Node', values: {}, dynamic: { family: { members: ['m1'] } } },
        outside: { id: 'outside' as never, type: 'Node', values: {} },
        inside2: { id: 'inside2' as never, type: 'Node', values: {} },
      },
      links,
      boundary: {
        inputs: [{
          id: 'input',
          binds: { kind: 'port', node: 'inside' as never, port: 'in' as never },
          alsoBinds: [{ kind: 'port', node: 'inside2' as never, port: 'in2' as never }],
        }],
        outputs: [],
      },
    }))
    const mutableFirst = first as MutableDocument
    mutableFirst.view.graphs.root = {
      ...mutableFirst.view.graphs.root!,
      collapsedNets: ['net-z', 'net-a'],
      guideNets: ['net-a', 'net-z'],
    }
    const second = structuredClone(first) as MutableDocument
    second.graphs.root = {
      ...second.graphs.root!,
      links: { a: second.graphs.root!.links.a!, z: second.graphs.root!.links.z! },
    } as never
    const a = lifecycleSelectionFingerprint(first, 'root', { nodeIds: ['inside2', 'inside', 'inside'] })
    const b = lifecycleSelectionFingerprint(second, 'root', { nodeIds: ['inside', 'inside2'] })
    expect(a).toBe(b)
    expect(a).toBe('sha256:561ab796ddc38682c929e6722b2e217e055764ed68758d57bf849b46404fdb92')
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(lifecycleCanonicalHash('abc')).toBe('sha256:6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25')
    expect(lifecycleSelectionProjection(first, 'root', { nodeIds: ['inside'] })?.version)
      .toBe('subgraph-lifecycle-plan-v2')
    const reorderedCollapsed = structuredClone(first) as MutableDocument
    reorderedCollapsed.view.graphs.root.collapsedNets = ['net-a', 'net-z']
    reorderedCollapsed.view.graphs.root.guideNets = ['net-z', 'net-a']
    expect(lifecycleSelectionFingerprint(reorderedCollapsed, 'root', { nodeIds: ['inside', 'inside2'] })).toBe(a)
  })

  it('detects topology, dynamic, view, boundary fan-out, tap, group, and collapsed-net staleness but ignores unrelated records', () => {
    const original = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Node', values: {}, dynamic: { family: { members: ['m1'] } } },
        inside2: { id: 'inside2' as never, type: 'Node', values: {} },
        outside: { id: 'outside' as never, type: 'Node', values: {} },
      },
      links: {
        tap: link('tap', { node: 'inside' as never, tap: 'widget' as never }, port('outside', 'sink')),
      },
      boundary: {
        inputs: [{
          id: 'fan',
          binds: { kind: 'port', node: 'inside' as never, port: 'a' as never },
          alsoBinds: [{ kind: 'port', node: 'inside2' as never, port: 'b' as never }],
        }],
        outputs: [],
      },
    }))
    const mutableOriginal = original as MutableDocument
    mutableOriginal.view.graphs.root = { ...mutableOriginal.view.graphs.root!, collapsedNets: ['n1'] }
    const selection = { nodeIds: ['inside'], groupIds: ['group'] }
    const selectionFingerprint = lifecycleSelectionFingerprint(original, 'root', selection)!
    const plan = { graphId: 'root', selection, selectionFingerprint }
    expect(verifyLifecycleSelectionPlan(original, plan)).toEqual({ stale: false, fingerprint: selectionFingerprint })

    const mutate = (change: (copy: MutableDocument) => void): void => {
      const copy = structuredClone(original) as MutableDocument
      change(copy)
      expect(verifyLifecycleSelectionPlan(copy, plan).stale).toBe(true)
    }
    mutate((copy) => { copy.graphs.root!.nodes.inside = { ...copy.graphs.root!.nodes.inside!, dynamic: { family: { members: ['m2'] } } } })
    mutate((copy) => { copy.graphs.root!.links.tap = { ...copy.graphs.root!.links.tap!, ext: { test: true } } })
    mutate((copy) => { copy.view.graphs.root!.nodes.inside = { position: { x: 999, y: 20 } } })
    mutate((copy) => { copy.graphs.root!.boundary!.inputs[0]!.alsoBinds = [] })
    mutate((copy) => { copy.view.graphs.root!.groups!.group = { ...copy.view.graphs.root!.groups!.group!, title: 'Changed' } })
    mutate((copy) => { copy.view.graphs.root!.collapsedNets = ['n2'] })
    mutate((copy) => { delete copy.graphs.root!.nodes.inside })

    const unrelated = structuredClone(original) as MutableDocument
    unrelated.graphs.root!.nodes.outside = { ...unrelated.graphs.root!.nodes.outside!, title: 'Unrelated' }
    expect(verifyLifecycleSelectionPlan(unrelated, plan).stale).toBe(false)
  })
})

describe('subgraph lifecycle cut matrix', () => {
  const rows: readonly {
    readonly name: string
    readonly selection: LifecycleSelectionInput
    readonly edge: LinkData
    readonly kind: string
    readonly code?: string
  }[] = [
    { name: 'plain outside to selected node is an in-cut', selection: { nodeIds: ['inside'] }, edge: link('l', port('outside', 'out'), port('inside', 'in')), kind: 'in-cut' },
    { name: 'plain selected node to outside is an out-cut', selection: { nodeIds: ['inside'] }, edge: link('l', port('inside', 'out'), port('outside', 'in')), kind: 'out-cut' },
    { name: 'plain selected-to-selected link is internal', selection: { nodeIds: ['inside', 'inside2'] }, edge: link('l', port('inside', 'out'), port('inside2', 'in')), kind: 'internal' },
    { name: 'plain outside-to-outside link stays outside', selection: { nodeIds: ['inside'] }, edge: link('l', port('outside', 'out'), port('inside2', 'in')), kind: 'outside' },
    { name: 'unselected reroute remains a legal parent producer', selection: { nodeIds: ['inside'] }, edge: link('l', { reroute: 'reroute' as never }, port('inside', 'in')), kind: 'in-cut' },
    { name: 'selected reroute cannot be an in-cut consumer', selection: { rerouteIds: ['reroute'], nodeIds: ['inside'] }, edge: link('l', port('outside', 'out'), { reroute: 'reroute' as never }), kind: 'unrepresentable', code: 'subgraph.extract.structuralCutUnsupported' },
    { name: 'selected reroute cannot be an out-cut producer', selection: { rerouteIds: ['reroute'], nodeIds: ['inside'] }, edge: link('l', { reroute: 'reroute' as never }, port('outside', 'in')), kind: 'unrepresentable', code: 'subgraph.extract.structuralCutUnsupported' },
    { name: 'outer widget tap is a legal in-cut producer', selection: { nodeIds: ['inside'] }, edge: link('l', { node: 'outside' as never, tap: 'widget' as never }, port('inside', 'in')), kind: 'in-cut' },
    { name: 'inner widget tap produces an out-cut', selection: { nodeIds: ['inside'] }, edge: link('l', { node: 'inside' as never, tap: 'widget' as never }, port('outside', 'in')), kind: 'out-cut' },
    { name: 'outer value source is a legal in-cut producer', selection: { nodeIds: ['inside'] }, edge: link('l', { valueSource: 'value' as never }, port('inside', 'in')), kind: 'in-cut' },
    { name: 'selected value source and consumer move internally', selection: { nodeIds: ['inside'], valueSourceIds: ['value'] }, edge: link('l', { valueSource: 'value' as never }, port('inside', 'in')), kind: 'internal' },
    { name: 'inner value source cannot produce an out-cut', selection: { nodeIds: ['inside'], valueSourceIds: ['value'] }, edge: link('l', { valueSource: 'value' as never }, port('outside', 'in')), kind: 'unrepresentable', code: 'subgraph.extract.structuralOutputUnsupported' },
    { name: 'outer selector output is a legal in-cut producer', selection: { nodeIds: ['inside'] }, edge: link('l', { selector: 'selector' as never }, port('inside', 'in')), kind: 'in-cut' },
    { name: 'selected selector candidate feed moves internally', selection: { nodeIds: ['inside'], selectorIds: ['selector'] }, edge: link('l', port('inside', 'out'), { selector: 'selector' as never, candidate: 'candidate' as never }), kind: 'internal' },
    { name: 'selected selector candidate cannot cross inward', selection: { nodeIds: ['inside'], selectorIds: ['selector'] }, edge: link('l', port('outside', 'out'), { selector: 'selector' as never, candidate: 'candidate' as never }), kind: 'unrepresentable', code: 'subgraph.extract.structuralCutUnsupported' },
    { name: 'selected selector output cannot cross outward', selection: { nodeIds: ['inside'], selectorIds: ['selector'] }, edge: link('l', { selector: 'selector' as never }, port('outside', 'in')), kind: 'unrepresentable', code: 'subgraph.extract.structuralCutUnsupported' },
  ]

  it.each(rows)('$name', ({ selection, edge, kind, code }) => {
    const result = auditExtractionCuts(graph({
      links: { l: edge },
      reroutes: { reroute: { id: 'reroute' as never } },
    }), selection)
    expect(result.links[0]?.kind).toBe(kind)
    expect(result.links[0]?.refusal?.code).toBe(code)
  })

  it('groups every tap out-cut by exact widget endpoint', () => {
    const result = auditExtractionCuts(graph({
      links: {
        first: link('first', { node: 'inside' as never, tap: 'widget' as never }, port('outside', 'a')),
        second: link('second', { node: 'inside' as never, tap: 'widget' as never }, port('outside', 'b')),
      },
    }), { nodeIds: ['inside'] })

    expect(result.outputs).toEqual([{
      source: { node: 'inside', tap: 'widget' },
      consumers: [port('outside', 'a'), port('outside', 'b')],
      boundaryItems: [],
      netIds: [],
    }])
    expect(result.links.map((cut) => ({ id: cut.id, kind: cut.kind, code: cut.refusal?.code }))).toEqual([
      { id: 'first', kind: 'out-cut', code: undefined },
      { id: 'second', kind: 'out-cut', code: undefined },
    ])
    expect(result.refusals).toEqual([])
  })

  it('groups same-producer in-cuts as one primary plus ordered alsoBinds targets', () => {
    const result = auditExtractionCuts(graph({
      links: {
        b: link('b', port('outside', 'out'), port('inside2', 'z')),
        a: link('a', port('outside', 'out'), port('inside', 'a')),
      },
    }), { nodeIds: ['inside2', 'inside'] })
    expect(result.inputs).toHaveLength(1)
    expect(result.inputs[0]).toEqual({
      source: { kind: 'link', endpoint: port('outside', 'out') },
      targets: [port('inside', 'a'), port('inside2', 'z')],
    })
  })

  it('gives same-producer semantic-ext links separate inputs retaining each parent link ext', () => {
    const result = auditExtractionCuts(graph({
      links: {
        second: { ...link('second', port('outside', 'out'), port('inside2', 'in')), ext: { owner: 'second' } },
        first: { ...link('first', port('outside', 'out'), port('inside', 'in')), ext: { owner: 'first' } },
      },
    }), { nodeIds: ['inside', 'inside2'] })
    expect(result.inputs).toEqual([
      {
        source: { kind: 'link', endpoint: port('outside', 'out'), linkId: 'first', ext: { owner: 'first' } },
        targets: [port('inside', 'in')],
      },
      {
        source: { kind: 'link', endpoint: port('outside', 'out'), linkId: 'second', ext: { owner: 'second' } },
        targets: [port('inside2', 'in')],
      },
    ])
    expect(result.links.map((cut) => [cut.id, cut.ext])).toEqual([
      ['first', { owner: 'first' }],
      ['second', { owner: 'second' }],
    ])
  })

  it('partitions mixed plain and semantic-ext fan-out deterministically for naming', () => {
    const result = auditExtractionCuts(graph({
      nodes: {
        a: { id: 'a' as never, type: 'Node', values: {} },
        b: { id: 'b' as never, type: 'Node', values: {} },
        c: { id: 'c' as never, type: 'Node', values: {} },
        d: { id: 'd' as never, type: 'Node', values: {} },
        outside: { id: 'outside' as never, type: 'Node', values: {} },
      },
      links: {
        z: { ...link('z', port('outside', 'out'), port('a', 'in')), ext: { tag: 1 } },
        y: link('y', port('outside', 'out'), port('b', 'in')),
        x: { ...link('x', port('outside', 'out'), port('c', 'in')), ext: { tag: 1 } },
        w: link('w', port('outside', 'out'), port('d', 'in')),
      },
    }), { nodeIds: ['d', 'c', 'b', 'a'] })
    expect(result.inputs.map((cut) => ({
      linkId: cut.source.kind === 'link' ? cut.source.linkId : undefined,
      targets: cut.targets.map((target) => target.node),
    }))).toEqual([
      { linkId: 'z', targets: ['a'] },
      { linkId: undefined, targets: ['b', 'd'] },
      { linkId: 'x', targets: ['c'] },
    ])
    expect(planBoundaryNames(boundaryNameCandidates(result)).map((candidate) => candidate.id))
      .toEqual(['in', 'in_2', 'in_3'])
  })

  it('sorts input cuts by canonical producer across links and nets, then by primary consumer', () => {
    const result = auditExtractionCuts(graph({
      links: { z: link('z', port('outside', 'z'), port('inside', 'a')) },
      nets: {
        net: { id: 'net' as never, name: 'net', source: port('outside', 'a'), sinks: [port('inside2', 'b')] },
      },
    }), { nodeIds: ['inside', 'inside2'] })
    expect(result.inputs.map((cut) => cut.targets[0]?.port)).toEqual(['b', 'a'])
  })

  it('moves a selected reroute chain only when its producer and consumers are all inside', () => {
    const result = auditExtractionCuts(graph({
      reroutes: { reroute: { id: 'reroute' as never } },
      links: {
        driver: link('driver', port('inside', 'out'), { reroute: 'reroute' as never }),
        consumer: link('consumer', { reroute: 'reroute' as never }, port('inside2', 'in')),
      },
    }), { nodeIds: ['inside', 'inside2'], rerouteIds: ['reroute'] })
    expect(result.links.map((cut) => cut.kind)).toEqual(['internal', 'internal'])
  })

  it('treats a selected nested occurrence as an ordinary node', () => {
    const result = auditExtractionCuts(graph({
      nodes: {
        inside: { id: 'inside' as never, type: '#child', values: { promoted: 3 }, dynamic: { family: { members: ['m1'] } } },
        inside2: { id: 'inside2' as never, type: 'Node', values: {} },
        outside: { id: 'outside' as never, type: 'Node', values: {} },
      },
      links: { l: link('l', port('inside', 'out'), port('outside', 'in')) },
    }), { nodeIds: ['inside'] })
    expect(result.links[0]?.kind).toBe('out-cut')
    expect(result.refusals).toEqual([])
  })

  it('preserves recursive wire-15 member addresses as concrete port cuts', () => {
    const address = port('inside', 'family.child.leaf', ['m9', 'name-a'])
    const result = auditExtractionCuts(graph({ links: { l: link('l', port('outside', 'out'), address) } }), { nodeIds: ['inside'] })
    expect(result.links[0]?.kind).toBe('in-cut')
    expect(result.inputs[0]?.targets).toEqual([address])
  })

  it('refuses only direct specialized-slot roots while allowing elaborated dependents', () => {
    const root = port('inside', 'slot')
    const dependent = port('inside', 'slot.dependent')
    const result = auditExtractionCuts(graph({
      links: {
        root: link('root', port('outside', 'a'), root),
        dependent: link('dependent', port('outside', 'b'), dependent),
      },
    }), { nodeIds: ['inside'] }, { specializedSlotRoots: [root] })
    expect(result.links.map((cut) => [cut.id, cut.kind, cut.refusal?.code])).toEqual([
      ['dependent', 'in-cut', undefined],
      ['root', 'unrepresentable', 'subgraph.extract.specializedSlotUnsupported'],
    ])
  })

  const netRows: readonly {
    readonly name: string
    readonly sourceInside: boolean
    readonly sinks: readonly string[]
    readonly kind: string
    readonly split: boolean
  }[] = [
    { name: 'outside source with selected sink is an in-cut', sourceInside: false, sinks: ['inside', 'outside'], kind: 'in-cut', split: false },
    { name: 'inside source with only selected sinks is internal', sourceInside: true, sinks: ['inside2'], kind: 'internal', split: false },
    { name: 'inside source with only outside sinks is an out-cut', sourceInside: true, sinks: ['outside'], kind: 'out-cut', split: false },
    { name: 'inside source with selected and outside sinks splits', sourceInside: true, sinks: ['inside2', 'outside'], kind: 'out-cut', split: true },
    { name: 'fully outside net stays outside', sourceInside: false, sinks: ['outside'], kind: 'outside', split: false },
  ]

  it.each(netRows)('classifies named net: $name', ({ sourceInside, sinks, kind, split }) => {
    const source = sourceInside ? 'inside' : 'outside'
    const net: NamedNetData = { id: 'net' as never, name: 'net', source: port(source, 'out'), sinks: sinks.map((id) => port(id, 'in')) }
    const selected = sourceInside ? ['inside', 'inside2'] : ['inside']
    const result = auditExtractionCuts(graph({ nets: { net } }), { nodeIds: selected })
    expect(result.nets[0]?.kind).toBe(kind)
    expect(result.nets[0]?.split).toBe(split)
  })

  it('refuses a split named net with opaque ext rather than assigning or duplicating it', () => {
    const net: NamedNetData = {
      id: 'net' as never,
      name: 'net',
      source: port('inside', 'out'),
      sinks: [port('inside2', 'in'), port('outside', 'in')],
      ext: { opaque: true },
    }
    const result = auditExtractionCuts(graph({ nets: { net } }), { nodeIds: ['inside', 'inside2'] })
    expect(result.nets[0]?.kind).toBe('unrepresentable')
    expect(result.nets[0]?.refusal?.code).toBe('subgraph.lifecycle.boundaryUnresolved')
  })

  it('classifies enclosing input fan-out and output bindings with stable moved/retained order and promotion', () => {
    const result = auditExtractionCuts(graph({
      boundary: {
        inputs: [{
          id: 'fan',
          binds: { kind: 'port', node: 'outside' as never, port: 'first' as never },
          alsoBinds: [
            { kind: 'port', node: 'inside2' as never, port: 'second' as never },
            { kind: 'port', node: 'inside' as never, port: 'third' as never },
          ],
          promoted: true,
        }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'inside' as never, port: 'out' as never } }],
      },
    }), { nodeIds: ['inside', 'inside2'] })
    expect(result.boundaries.map((cut) => ({
      side: cut.side,
      kind: cut.kind,
      moved: cut.movedBindings.map((binding) => binding.port),
      retained: cut.retainedBindings.map((binding) => binding.port),
      primaryMoved: cut.primaryMoved,
      promoted: cut.promoted,
      replacementIndex: cut.replacementIndex,
      nestedItem: cut.nestedItem,
    }))).toEqual([
      {
        side: 'inputs', kind: 'in-cut', moved: ['second', 'third'], retained: ['first'], primaryMoved: false,
        promoted: true, replacementIndex: 1,
        nestedItem: {
          binds: { kind: 'port', node: 'inside2', port: 'second' },
          alsoBinds: [{ kind: 'port', node: 'inside', port: 'third' }],
          promoted: true,
        },
      },
      {
        side: 'outputs', kind: 'out-cut', moved: ['out'], retained: [], primaryMoved: true,
        promoted: false, replacementIndex: 0,
        nestedItem: { binds: { kind: 'port', node: 'inside', port: 'out' } },
      },
    ])
  })

  it('retains whole-family enclosing bindings and exact ancestor members', () => {
    const result = auditExtractionCuts(graph({
      boundary: {
        inputs: [{
          id: 'family',
          binds: { kind: 'family', node: 'inside' as never, port: 'outer.inner' as never, members: ['m3' as never], slots: ['x'] },
        }],
        outputs: [],
      },
    }), { nodeIds: ['inside'] })
    expect(result.boundaries[0]?.movedBindings[0]).toEqual({
      kind: 'family', node: 'inside', port: 'outer.inner', members: ['m3'], slots: ['x'],
    })
    expect(result.boundaries[0]?.nestedItem).toEqual({
      binds: { kind: 'family', node: 'inside', port: 'outer.inner', members: ['m3'] },
    })
  })

  it('refuses an enclosing input that already competes with an internal driver', () => {
    const target = port('inside', 'in')
    const result = auditExtractionCuts(graph({
      links: { l: link('l', port('inside2', 'out'), target) },
      boundary: { inputs: [{ id: 'input', binds: { kind: 'port', ...target } }], outputs: [] },
    }), { nodeIds: ['inside', 'inside2'] })
    expect(result.refusals.map((refusal) => refusal.code)).toContain('subgraph.lifecycle.multiDriver')
    expect(result.boundaries[0]?.kind).toBe('unrepresentable')
    expect(result.boundaries[0]?.nestedItem).toBeUndefined()
    expect(result.inputs).toEqual([])
    expect(boundaryNameCandidates(result)).toEqual([])
  })

  it('names boundaries globally in canonical cut order with exact ports, fallbacks, and collisions', () => {
    const planned = planBoundaryNames([
      { side: 'output', base: 'same', orderKey: 'b' },
      { side: 'input', base: '', orderKey: 'b' },
      { side: 'input', base: 'same', orderKey: 'a' },
      { side: 'output', base: '', orderKey: 'a' },
      { side: 'input', base: 'same', orderKey: 'c' },
    ])
    expect(planned.map((candidate) => candidate.id)).toEqual(['same_3', 'input', 'same', 'output', 'same_2'])
  })

  it('derives deterministic boundary names from canonical grouped cuts', () => {
    const audit = auditExtractionCuts(graph({
      links: {
        in: link('in', port('outside', 'out'), port('inside', 'shared')),
        out: link('out', port('inside', 'shared'), port('outside', 'sink')),
      },
    }), { nodeIds: ['inside'] })
    expect(planBoundaryNames(boundaryNameCandidates(audit)).map((candidate) => candidate.id)).toEqual(['shared', 'shared_2'])
  })
})

const flattenDocument = (): MutableDocument => {
  const root = graph({
    nodes: {
      source: { id: 'source' as never, type: 'Source', values: {} },
      occurrence: { id: 'occurrence' as never, type: '#body', values: {} },
      survivor: { id: 'survivor' as never, type: '#body', values: {} },
      consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
      outer: { id: 'outer' as never, type: 'Outer', values: {} },
    },
    links: {
      incoming: { ...link('incoming', port('source', 'out'), port('occurrence', 'input')), ext: { delivery: 1 } },
      outgoing: link('outgoing', port('occurrence', 'output'), port('consumer', 'in')),
      tap: link('tap', { node: 'occurrence' as never, tap: 'input' as never }, port('consumer', 'tap')),
    },
    nets: {
      incomingNet: {
        id: 'incomingNet' as never, name: 'Incoming', source: port('source', 'net'),
        sinks: [port('outer', 'net'), port('occurrence', 'netInput')],
      },
      outgoingNet: {
        id: 'outgoingNet' as never, name: 'Outgoing', source: port('occurrence', 'output'),
        sinks: [port('consumer', 'net')],
      },
    },
    boundary: {
      inputs: [
        {
          id: 'outerPrimary',
          binds: { kind: 'port', node: 'occurrence' as never, port: 'input' as never },
          alsoBinds: [{ kind: 'port', node: 'outer' as never, port: 'after' as never }],
        },
        {
          id: 'outerAdditional',
          binds: { kind: 'port', node: 'outer' as never, port: 'before' as never },
          alsoBinds: [
            { kind: 'port', node: 'occurrence' as never, port: 'input' as never },
            { kind: 'port', node: 'outer' as never, port: 'after2' as never },
          ],
        },
      ],
      outputs: [{ id: 'outerOutput', binds: { kind: 'port', node: 'occurrence' as never, port: 'output' as never } }],
    },
    nextOrdinal: 100,
  })
  const body = graph({
    id: 'body' as never,
    name: 'Body',
    nodes: {
      a: { id: 'a' as never, type: '#child', values: { keep: 1 }, ext: { node: true } },
      b: { id: 'b' as never, type: 'BodyNode', values: {} },
    },
    links: { internal: { ...link('internal', port('a', 'out'), port('b', 'mid')), ext: { inner: true } } },
    nets: { internalNet: { id: 'internalNet' as never, name: 'Inner', source: port('a', 'net'), sinks: [port('b', 'net')] } },
    reroutes: { reroute: { id: 'reroute' as never, ext: { r: 1 } } },
    valueSources: { value: { id: 'value' as never, value: 3, ext: { v: 1 } } },
    selectors: {
      selector: {
        id: 'selector' as never,
        candidates: [{ id: 'candidate' as never }],
        policy: { kind: 'fixed', candidate: 'candidate' as never },
        ext: { s: 1 },
      },
    },
    boundary: {
      inputs: [
        {
          id: 'input', promoted: true,
          binds: { kind: 'port', node: 'a' as never, port: 'in' as never },
          alsoBinds: [{ kind: 'port', node: 'b' as never, port: 'other' as never }],
        },
        {
          id: 'netInput', binds: { kind: 'port', node: 'a' as never, port: 'netIn' as never },
          alsoBinds: [{ kind: 'port', node: 'b' as never, port: 'netOther' as never }],
        },
      ],
      outputs: [{ id: 'output', binds: { kind: 'port', node: 'b' as never, port: 'out' as never } }],
    },
    nextOrdinal: 20,
  })
  const child = graph({ id: 'child' as never, name: 'Child', nodes: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 })
  const doc = document(root) as MutableDocument
  doc.graphs.body = body
  doc.graphs.child = child
  doc.view.graphs.root = {
    nodes: {
      source: { position: { x: 0, y: 0 } },
      occurrence: { position: { x: 450, y: 250 }, size: { width: 100, height: 100 }, collapsed: true, color: '#fff' },
      survivor: { position: { x: 800, y: 0 } }, consumer: {}, outer: {},
    },
    groups: { grp4: { id: 'grp4', title: 'Existing', bounds: { x: 0, y: 0, width: 10, height: 10 } } },
    groupSeq: 5,
    collapsedNets: ['incomingNet'],
  }
  doc.view.graphs.body = {
    nodes: {
      a: { position: { x: 0, y: 0 }, color: '#a' },
      b: { position: { x: 200, y: 100 }, collapsed: true },
    },
    reroutes: { reroute: { position: { x: 50, y: 20 }, ext: { view: true } } },
    valueSources: { value: { position: { x: 80, y: 30 }, view: 'slider' } },
    selectors: { selector: { position: { x: 120, y: 40 } } },
    groups: { innerGroup: { id: 'innerGroup', title: 'Inner', bounds: { x: -20, y: -20, width: 300, height: 200 }, ext: { group: true } } },
    groupSeq: 1,
    collapsedNets: ['internalNet'],
  }
  doc.view.graphs.child = { nodes: {} }
  return doc
}

const flattenSchema = (type: string, items: readonly any[]) => ({
    type, displayName: type, category: 'test', source: 'v3' as const, items, isOutputNode: false,
})
const flattenSchemas: Record<string, any> = {
    '#child': flattenSchema('#child', [
      { kind: 'input', id: 'in', type: { kind: 'concrete', name: 'X' }, optional: true, widget: { widgetType: 'INT', options: {}, controller: 'after_generate' } },
      { kind: 'input', id: 'netIn', type: { kind: 'concrete', name: 'X' }, optional: true },
      { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'X' } },
      { kind: 'output', id: 'net', type: { kind: 'concrete', name: 'X' } },
    ]),
    BodyNode: flattenSchema('BodyNode', [
      ...['in', 'netIn', 'other', 'netOther', 'mid', 'net', 'tapTarget'].map((id) => ({ kind: 'input', id, type: { kind: 'concrete', name: 'X' }, optional: true })),
      ...['out', 'net', 'driver'].map((id) => ({ kind: 'output', id, type: { kind: 'concrete', name: 'X' } })),
    ]),
}
const flattenResolver = (type: string) => {
  const schema = flattenSchemas[type]
  return schema === undefined ? undefined : structuredClone(schema)
}
const trustedFlattenSession = (doc: WorkflowDocument, resolver = flattenResolver) =>
  createRawLocalSession(doc, coreCommandRegistry(), { schemaResolverFor: () => resolver })

const flattenInvocation = (doc: WorkflowDocument, instancePath: readonly string[] = []) => {
  const schemaPlan = planFlattenBoundaryRoutes(doc.graphs.body!, flattenResolver, doc.graphs.root!.nodes.occurrence!, doc.graphs.root!)
  const owner = { instancePath: instancePath as never, node: 'occurrence' as never }
  const occurrencePlan = planFlattenOccurrenceTopology(doc, flattenResolver, owner).plan
  const occurrenceTopologyPlanDigest = occurrencePlan === undefined ? undefined : lifecycleCanonicalHash(occurrencePlan)
  return {
    command: 'subgraph.flatten',
    params: {
    graphId: 'root',
    instancePath,
    nodeId: 'occurrence',
    placementCenter: { x: 500, y: 300 },
    resolvedGeometry: {
      occurrence: { id: 'occurrence', kind: 'node', x: 450, y: 250, width: 100, height: 100 },
      body: [
        { id: 'a', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
        { id: 'b', kind: 'node', x: 200, y: 100, width: 100, height: 80 },
        { id: 'reroute', kind: 'reroute', x: 50, y: 20, width: 0, height: 0 },
        { id: 'value', kind: 'valueSource', x: 80, y: 30, width: 120, height: 40 },
        { id: 'selector', kind: 'selector', x: 120, y: 40, width: 120, height: 80 },
        { id: 'innerGroup', kind: 'group', x: -20, y: -20, width: 300, height: 200 },
      ],
    },
      boundaryPlan: schemaPlan.boundaryPlan as unknown as Json,
      statePlan: schemaPlan.statePlan as unknown as Json,
      schemaSnapshot: schemaPlan.schemaSnapshot as unknown as Json,
      schemaPlanDigest: schemaPlan.schemaPlanDigest,
      selectionFingerprint: lifecycleFlattenFingerprint(doc, 'root', 'occurrence', {
        boundaryPlan: schemaPlan.boundaryPlan,
        statePlan: schemaPlan.statePlan,
        schemaPlanDigest: schemaPlan.schemaPlanDigest,
        ...(occurrencePlan !== undefined ? { occurrenceTopologyPlan: occurrencePlan, occurrenceTopologyPlanDigest } : {}),
      })!,
      ...(occurrencePlan !== undefined ? { occurrenceTopologyPlan: occurrencePlan, occurrenceTopologyPlanDigest } : {}),
    },
  } as any
}

const refreshFlattenFingerprint = (doc: WorkflowDocument, invocation: any): void => {
  invocation.params.selectionFingerprint = lifecycleFlattenFingerprint(
    doc,
    invocation.params.graphId,
    invocation.params.nodeId,
    invocation.params.statePlan === undefined
      ? invocation.params.boundaryPlan
      : {
          boundaryPlan: invocation.params.boundaryPlan,
          statePlan: invocation.params.statePlan,
          schemaPlanDigest: invocation.params.schemaPlanDigest,
        },
  )
}

const refreshFlattenSchemaDigest = (invocation: any): void => {
  invocation.params.schemaPlanDigest = flattenSchemaPlanDigest(
    invocation.params.schemaSnapshot,
    invocation.params.boundaryPlan,
    invocation.params.statePlan,
  )
}

describe('subgraph.flatten trusted-dispatch authorization', () => {
  it('T6 matching live success', () => {
    const initial = flattenDocument()
    const outcome = trustedFlattenSession(initial).dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
  })

  it('T7 missing resolver authority unavailable atomic', () => {
    const initial = flattenDocument()
    const session = createRawLocalSession(initial, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.schemaAuthorityUnavailable')
    expect(session.doc).toBe(before)
    expect(session.revision).toBe(0)
  })

  it('T8 drift stale', () => {
    const initial = flattenDocument()
    const invocation = flattenInvocation(initial)
    const drifted = (type: string) => {
      const schema = flattenResolver(type)
      return schema === undefined ? undefined : { ...schema, displayName: `${schema.displayName} drifted` }
    }
    const session = trustedFlattenSession(initial, drifted)
    const before = session.doc
    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.schemaPlanStale')
    expect(session.doc).toBe(before)
  })

  it('T8 rejects a bound authored type that becomes resolvable after planning', () => {
    const initial = flattenDocument()
    const unresolvedPlan = planFlattenBoundaryRoutes(
      initial.graphs.body,
      () => undefined,
      initial.graphs.root.nodes.occurrence,
      initial.graphs.root,
    )
    const invocation = flattenInvocation(initial) as any
    Object.assign(invocation.params, unresolvedPlan)
    refreshFlattenFingerprint(initial, invocation)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.schemaPlanStale')
    expect(session.doc).toBe(before)
    expect(session.revision).toBe(0)
  })

  it('T9 alias canonical success', () => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.type = 'AuthoredAlias'
    const canonical = { ...flattenResolver('#child')!, type: 'CanonicalTarget' }
    const resolver = (type: string) => type === 'AuthoredAlias' ? structuredClone(canonical) : flattenResolver(type)
    const plan = planFlattenBoundaryRoutes(initial.graphs.body, resolver, initial.graphs.root.nodes.occurrence, initial.graphs.root)
    const invocation = flattenInvocation(initial) as any
    Object.assign(invocation.params, plan)
    refreshFlattenFingerprint(initial, invocation)
    const outcome = trustedFlattenSession(initial, resolver).dispatch(invocation)
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
  })

  it('T10 fully self-consistent forged alternate snapshot+boundary+state+digest+fingerprint rejected by independent live registry', () => {
    const initial = flattenDocument()
    const alternateSchemas = structuredClone(flattenSchemas)
    alternateSchemas['#child'].displayName = 'Forged alternate registry'
    const alternateResolver = (type: string) => alternateSchemas[type] === undefined ? undefined : structuredClone(alternateSchemas[type])
    const alternate = planFlattenBoundaryRoutes(initial.graphs.body, alternateResolver, initial.graphs.root.nodes.occurrence, initial.graphs.root)
    const forged = flattenInvocation(initial) as any
    Object.assign(forged.params, alternate)
    refreshFlattenFingerprint(initial, forged)
    const session = trustedFlattenSession(initial, flattenResolver)
    const before = session.doc
    const outcome = session.dispatch(forged)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.schemaPlanStale')
    expect(session.doc).toBe(before)
  })

  it('T11 malicious state plan on real snapshot/recomputed digest rejected semantic recomputation', () => {
    const initial = flattenDocument()
    const malicious = flattenInvocation(initial) as any
    malicious.params.statePlan.nodes[0].values.in = 8675309
    refreshFlattenSchemaDigest(malicious)
    refreshFlattenFingerprint(initial, malicious)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const outcome = session.dispatch(malicious)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
    expect(session.doc).toBe(before)
  })

  it('T12 direct and batch identical authorization', () => {
    const initial = flattenDocument()
    const invocation = flattenInvocation(initial)
    const direct = createRawLocalSession(initial, coreCommandRegistry()).dispatch(invocation)
    const batched = createRawLocalSession(initial, coreCommandRegistry()).dispatch({
      command: 'batch', params: { invocations: [invocation] },
    })
    expect(direct.ok).toBe(false)
    expect(batched.ok).toBe(false)
    if (!direct.ok && !batched.ok) expect(batched.diagnostics).toEqual(direct.diagnostics)
  })
})

describe('subgraph.flatten L5-L6 core command', () => {
  it('flattens an output boundary back to the exact inner widget tap endpoint', () => {
    const initial = flattenDocument()
    initial.graphs.body!.boundary!.outputs = [{
      id: 'output',
      binds: { kind: 'widgetTap', node: 'a' as never, tap: 'in' as never },
    }]
    delete initial.graphs.root!.nets.outgoingNet
    const session = trustedFlattenSession(initial)

    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.links.outgoing!.from).toEqual({ node: 'n100', tap: 'in' })
    expect(session.doc.graphs.root!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n100', tap: 'in' })
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.body!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'a', tap: 'in' })
  })

  it('refuses atomically when flattening would make a named net source a widget tap', () => {
    const initial = flattenDocument()
    initial.graphs.body!.boundary!.outputs = [{
      id: 'output',
      binds: { kind: 'widgetTap', node: 'a' as never, tap: 'in' as never },
    }]
    const session = trustedFlattenSession(initial)
    const before = session.doc

    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(session.doc).toBe(before)
    expect(session.canUndo).toBe(false)
  })

  it('materializes the selected occurrence effective topology while preserving a sibling overlay', () => {
    const initial = flattenDocument()
    initial.graphs.root.nodes = {
      occurrence: initial.graphs.root.nodes.occurrence,
      sibling: { id: 'sibling' as never, type: '#body', values: {} },
    }
    initial.graphs.root.links = {}
    initial.graphs.root.nets = {}
    delete initial.graphs.root.boundary
    initial.view.graphs.root.nodes = {
      occurrence: initial.view.graphs.root.nodes.occurrence,
      sibling: { position: { x: 900, y: 300 } },
    }
    initial.graphs.body.nodes.a.type = 'BodyNode'
    initial.graphs.body.links = {
      shared: link('shared', port('a', 'out'), port('b', 'mid')),
    }
    initial.graphs.body.nets = {}
    ;(initial as any).occurrenceTopologies = {
      occurrence: {
        owner: { instancePath: [], node: 'occurrence' }, bodyGraph: 'body', nextOrdinal: 8,
        links: {
          l7: {
            id: 'l7',
            from: { kind: 'body', endpoint: port('b', 'driver') },
            to: { kind: 'body', endpoint: port('b', 'mid') },
            ext: { occurrence: true },
          },
        },
        suppressedDeliveries: [{ kind: 'link', linkId: 'shared' }],
      },
      sibling: {
        owner: { instancePath: [], node: 'sibling' }, bodyGraph: 'body', nextOrdinal: 4,
        links: {
          l3: {
            id: 'l3',
            from: { kind: 'body', endpoint: port('b', 'driver') },
            to: { kind: 'body', endpoint: port('b', 'mid') },
          },
        },
        suppressedDeliveries: [{ kind: 'link', linkId: 'shared' }],
      },
    }
    const siblingTopologyBytes = JSON.stringify(initial.occurrenceTopologies!.sibling)
    const before = compile({
      document: initial, revision: 1, resolve: flattenResolver, scope: { kind: 'full' },
      connection: asConnectionId('occurrence-flatten-before'), schemaHash: 'occurrence-flatten',
    })
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const session = trustedFlattenSession(initial)
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.occurrenceTopologies?.occurrence).toBeUndefined()
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(siblingTopologyBytes)
    expect(Object.values(session.doc.graphs.root!.links).find((candidate) =>
      'node' in candidate.from && 'port' in candidate.from && candidate.from.node === 'n101' && candidate.from.port === 'driver' &&
      'node' in candidate.to && 'port' in candidate.to && candidate.to.node === 'n101' && candidate.to.port === 'mid')?.ext).toEqual({ occurrence: true })
    expect(Object.values(session.doc.graphs.root!.links).some((candidate) =>
      'node' in candidate.from && candidate.from.node === 'n100' &&
      'node' in candidate.to && 'port' in candidate.to && candidate.to.node === 'n101' && candidate.to.port === 'mid')).toBe(false)
    const after = compile({
      document: session.doc, revision: 1, resolve: flattenResolver, scope: { kind: 'full' },
      connection: asConnectionId('occurrence-flatten-after'), schemaHash: 'occurrence-flatten',
    })
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(before.artifact.prompt['occurrence.b']!.inputs).toEqual({ mid: ['occurrence.b', 2] })
      expect(after.artifact.prompt.n101!.inputs).toEqual({ mid: ['n101', 2] })
    }
    expect(session.undo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.occurrence?.links.l7).toBeDefined()
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(siblingTopologyBytes)
    expect(session.redo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.occurrence).toBeUndefined()
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(siblingTopologyBytes)
  })

  it('applies projected parent link and net-sink suppressions during materialization', () => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.type = 'BodyNode'
    delete initial.graphs.root.links.tap
    ;(initial as any).occurrenceTopologies = {
      occurrence: {
        owner: { instancePath: [], node: 'occurrence' }, bodyGraph: 'body', links: {}, nextOrdinal: 1,
      },
    }
    const unsuppressed = effectiveOccurrenceTopology(initial, flattenResolver, { instancePath: [], node: 'occurrence' as never })
    const incomingLink = unsuppressed.projectedParentLinks.find((link) =>
      link.identity.kind === 'parentLeg' && link.identity.delivery.kind === 'link' && link.identity.delivery.linkId === 'incoming')!
    const incomingNet = unsuppressed.projectedParentLinks.find((link) =>
      link.identity.kind === 'parentLeg' && link.identity.delivery.kind === 'netSink' && link.identity.delivery.netId === 'incomingNet')!
    if (incomingLink.identity.kind !== 'parentLeg' || incomingNet.identity.kind !== 'parentLeg') throw new Error('expected projected parent legs')
    ;(initial as any).occurrenceTopologies.occurrence.suppressedDeliveries = [
      { kind: 'projectedLeg', delivery: incomingLink.identity.delivery, route: incomingLink.identity.route },
      { kind: 'projectedLeg', delivery: incomingNet.identity.delivery, route: incomingNet.identity.route },
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const planned = planFlattenOccurrenceTopology(initial, flattenResolver, { instancePath: [], node: 'occurrence' as never })
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(planned.plan).toBeDefined()
    const session = trustedFlattenSession(initial)
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(Object.values(session.doc.graphs.root!.links).some((candidate) =>
      'node' in candidate.from && candidate.from.node === 'source' &&
      'node' in candidate.to && candidate.to.node === 'n100')).toBe(false)
    expect(session.doc.graphs.root!.nets.incomingNet!.sinks).toEqual([port('outer', 'net')])
  })

  it('refuses unsupported occurrence overlay flatten contexts by name', () => {
    const extension = flattenDocument()
    ;(extension as any).occurrenceTopologies = {
      occurrence: {
        owner: { instancePath: [], node: 'occurrence' }, bodyGraph: 'body', links: {}, nextOrdinal: 1,
        ext: { pack: true },
      },
    }
    const extensionOutcome = trustedFlattenSession(extension).dispatch(flattenInvocation(extension))
    expect(extensionOutcome.ok).toBe(false)
    if (!extensionOutcome.ok) expect(extensionOutcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(extensionOutcome.diagnostics))
      .toContain('subgraph.flatten.occurrenceTopologyExtensionUnsupported')

    const definition = coreCommandRegistry().get('subgraph.flatten')!
    const validate = (
      doc: WorkflowDocument,
      invocation: ReturnType<typeof flattenInvocation>,
      expected: string,
    ) => {
      const stale = structuredClone(invocation.params) as Record<string, Json>
      stale.occurrenceTopologyPlan = { version: 'stale' }
      for (const context of [{ kind: 'initial' as const }, { kind: 'shared-replay' as const }]) {
        expect(definition.validateDispatch!(doc, stale as Json, context).map((diagnostic) => diagnostic.code))
          .toContain(expected)
      }
    }
    validate(extension, flattenInvocation(extension), 'subgraph.flatten.occurrenceTopologyExtensionUnsupported')

    const drilled = flattenDocument()
    const wrapper = graph({
      id: 'wrapper' as never,
      nodes: { outer: { id: 'outer' as never, type: '#root', values: {} } },
      boundary: { inputs: [], outputs: [] },
    })
    drilled.graphs.wrapper = wrapper
    drilled.view.graphs.wrapper = { nodes: { outer: { position: { x: 0, y: 0 } } } }
    ;(drilled as { root: string }).root = 'wrapper'
    const drilledOwner = { instancePath: ['outer' as never], node: 'occurrence' as never }
    ;(drilled as any).occurrenceTopologies = {
      [occurrenceKey(drilledOwner)]: {
        owner: drilledOwner, bodyGraph: 'body', links: {}, nextOrdinal: 1,
      },
    }
    const drilledInvocation = flattenInvocation(drilled, ['outer'])
    ;(drilledInvocation.params as Record<string, Json>).occurrenceTopologyPlan = { version: 'stale' }
    const drilledOutcome = trustedFlattenSession(drilled).dispatch(drilledInvocation)
    expect(drilledOutcome.ok).toBe(false)
    if (!drilledOutcome.ok) expect(drilledOutcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(drilledOutcome.diagnostics))
      .toContain('subgraph.flatten.occurrenceTopologyContextUnsupported')
    validate(drilled, flattenInvocation(drilled, ['outer']), 'subgraph.flatten.occurrenceTopologyContextUnsupported')

    const descendant = flattenDocument()
    const descendantOwner = { instancePath: ['occurrence' as never], node: 'a' as never }
    ;(descendant as any).occurrenceTopologies = {
      [occurrenceKey(descendantOwner)]: {
        owner: descendantOwner, bodyGraph: 'child', links: {}, nextOrdinal: 1,
      },
    }
    const descendantOutcome = trustedFlattenSession(descendant).dispatch(flattenInvocation(descendant))
    expect(descendantOutcome.ok).toBe(false)
    if (!descendantOutcome.ok) expect(descendantOutcome.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.flatten.occurrenceTopologyDescendantUnsupported')
  })

  it('orders occurrence overlay validation refusals like execution', () => {
    const definition = coreCommandRegistry().get('subgraph.flatten')!
    const contexts = [{ kind: 'initial' as const }, { kind: 'shared-replay' as const }]
    const drilled = flattenDocument()
    const wrapper = graph({
      id: 'wrapper' as never,
      nodes: { outer: { id: 'outer' as never, type: '#root', values: {} } },
      boundary: { inputs: [], outputs: [] },
    })
    drilled.graphs.wrapper = wrapper
    drilled.view.graphs.wrapper = { nodes: { outer: { position: { x: 0, y: 0 } } } }
    ;(drilled as { root: string }).root = 'wrapper'
    const drilledOwner = { instancePath: ['outer' as never], node: 'occurrence' as never }
    ;(drilled as any).occurrenceTopologies = {
      [occurrenceKey(drilledOwner)]: {
        owner: drilledOwner, bodyGraph: 'body', links: {}, nextOrdinal: 1,
      },
    }
    ;(drilled.graphs.body!.nets.internalNet as any).ext = { pack: true }
    const invocation = flattenInvocation(drilled, ['outer'])

    const withNetPlan = structuredClone(invocation.params) as Record<string, Json>
    withNetPlan.occurrenceTopologyPlan = {
      version: 'stale',
      links: [{ identity: { kind: 'definitionNetSink', graphId: 'body', netId: 'internalNet' } }],
      projectedParentLinks: [],
    }
    for (const context of contexts) {
      const codes = definition.validateDispatch!(drilled, withNetPlan as Json, context).map((diagnostic) => diagnostic.code)
      expect(codes).toContain('subgraph.flatten.netExtensionUnsupported')
      expect(codes).not.toContain('subgraph.flatten.occurrenceTopologyContextUnsupported')
    }

    const absentPlan = structuredClone(invocation.params) as Record<string, Json>
    delete absentPlan.occurrenceTopologyPlan
    delete absentPlan.occurrenceTopologyPlanDigest
    for (const context of contexts) {
      const diagnostics = definition.validateDispatch!(drilled, absentPlan as Json, context)
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['params.invalid'])
      expect(diagnostics[0]!.message).toContain('occurrence topology plan is required and malformed')
    }
  })

  it('clones every body construct, expands plain routes, retains nesting and definition, and places exact view state', () => {
    const initial = flattenDocument()
    initial.view.graphs.root = { ...initial.view.graphs.root!, guideNets: ['incomingNet'] }
    initial.view.graphs.body = { ...initial.view.graphs.body!, guideNets: ['internalNet'] }
    const immutableBody = structuredClone(initial.graphs.body)
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.body).toEqual(immutableBody)
    expect(session.doc.graphs.root!.nodes.occurrence).toBeUndefined()
    expect(session.doc.graphs.root!.nodes.survivor!.type).toBe('#body')
    expect(session.doc.graphs.root!.nodes.n100).toEqual({ id: 'n100', type: '#child', values: { keep: 1, in: 0 }, controllers: { in: 'randomize' }, ext: { node: true } })
    expect(session.doc.graphs.root!.nodes.n101).toMatchObject({ id: 'n101', type: 'BodyNode' })
    expect(session.doc.graphs.root!.links.incoming).toEqual({
      id: 'incoming', from: port('source', 'out'), to: port('n100', 'in'), ext: { delivery: 1 },
    })
    expect(Object.values(session.doc.graphs.root!.links)).toContainEqual({
      id: 'l108', from: port('source', 'out'), to: port('n101', 'other'), ext: { delivery: 1 },
    })
    expect(session.doc.graphs.root!.links.outgoing!.from).toEqual(port('n101', 'out'))
    expect(session.doc.graphs.root!.links.tap!.from).toEqual({ node: 'n100', tap: 'in' })
    expect(session.doc.graphs.root!.nets.incomingNet!.sinks).toEqual([
      port('outer', 'net'), port('n100', 'netIn'), port('n101', 'netOther'),
    ])
    expect(session.doc.graphs.root!.nets.outgoingNet!.source).toEqual(port('n101', 'out'))
    expect(session.doc.graphs.root!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', ...port('n100', 'in') })
    expect(session.doc.graphs.root!.boundary!.inputs[0]!.alsoBinds).toEqual([
      { kind: 'port', ...port('n101', 'other') }, { kind: 'port', ...port('outer', 'after') },
    ])
    expect(session.doc.graphs.root!.boundary!.inputs[1]!.alsoBinds).toEqual([
      { kind: 'port', ...port('n100', 'in') }, { kind: 'port', ...port('n101', 'other') },
      { kind: 'port', ...port('outer', 'after2') },
    ])
    expect(session.doc.graphs.root!.boundary!.outputs[0]!.binds).toEqual({ kind: 'port', ...port('n101', 'out') })
    expect(session.doc.view.graphs.root!.nodes.n100).toEqual({ position: { x: 360, y: 220 }, color: '#a' })
    expect(session.doc.view.graphs.root!.nodes.n101).toEqual({ position: { x: 560, y: 320 }, collapsed: true })
    expect(session.doc.view.graphs.root!.nodes.occurrence).toBeUndefined()
    expect(session.doc.view.graphs.root!.groups!.grp5).toEqual({
      id: 'grp5', title: 'Inner', bounds: { x: 340, y: 200, width: 300, height: 200 }, ext: { group: true },
    })
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.doc.view.graphs.root!.collapsedNets).toEqual(['incomingNet', 'net107'])
    expect(session.doc.view.graphs.root!.guideNets).toEqual(['incomingNet', 'net107'])
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('drops display entries for parent nets that vanish during flatten', () => {
    const initial = flattenDocument()
    initial.graphs.root!.nets.strayNet = {
      id: 'strayNet' as never, name: 'Stray', source: port('outer', 'netOut'), sinks: [],
    }
    initial.view.graphs.root = {
      ...initial.view.graphs.root!,
      collapsedNets: ['incomingNet', 'strayNet'],
      guideNets: ['strayNet'],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.root!.nets.strayNet).toBeUndefined()
    expect(session.doc.view.graphs.root!.collapsedNets).toEqual(['incomingNet', 'net107'])
    expect(session.doc.view.graphs.root!.guideNets).toEqual([])
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('copies body tag offsets onto the cloned nets while leaving the shared definition entries in place', () => {
    const initial = flattenDocument()
    const malformed = { graphId: 'body', netId: 'internalNet' }
    const sourceEntry = { graphId: 'body', netId: 'internalNet', role: 'source', offset: { x: 30, y: -10 } }
    const sinkEntry = { graphId: 'body', netId: 'internalNet', role: 'sink', to: { node: 'b', port: 'net' }, offset: { x: -25, y: 40 } }
    // Absolute geometry is body-graph world coordinates: meaningless in the
    // parent, so it is not copied.
    const absoluteEntry = { graphId: 'body', netId: 'internalNet', role: 'source', position: { x: 9, y: 9 } }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [sourceEntry, sinkEntry, absoluteEntry, malformed],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    // Body ids remap a -> n100, b -> n101, internalNet -> net107.
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      sourceEntry,
      sinkEntry,
      absoluteEntry,
      malformed,
      { graphId: 'root', netId: 'net107', role: 'source', offset: { x: 30, y: -10 } },
      { graphId: 'root', netId: 'net107', role: 'sink', to: { node: 'n101', port: 'net' }, offset: { x: -25, y: 40 } },
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([sourceEntry, sinkEntry, absoluteEntry, malformed])
  })

  it('moves parent tags anchored to the flattened occurrence onto the expanded endpoints', () => {
    const initial = flattenDocument()
    // The occurrence sits at (450,250); the expansion places a -> n100 at
    // (360,220) and b -> n101 at (560,320).
    const survivorSink = { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'outer', port: 'net' }, offset: { x: 1, y: 2 } }
    const occurrenceSink = { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'occurrence', port: 'netInput' }, offset: { x: 10, y: 20 } }
    const occurrenceSource = { graphId: 'root', netId: 'outgoingNet', role: 'source', offset: { x: -15, y: 5 } }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [survivorSink, occurrenceSink, occurrenceSource],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    // The occurrence sink fans out to n100.netIn and n101.netOther; each copy
    // re-anchors so the tag keeps its on-screen point (460,270). The source
    // tag re-anchors to outgoingNet's new source n101 the same way (435,255).
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      survivorSink,
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n100', port: 'netIn' }, offset: { x: 100, y: 50 } },
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n101', port: 'netOther' }, offset: { x: -100, y: -50 } },
      { graphId: 'root', netId: 'outgoingNet', role: 'source', offset: { x: -125, y: -65 } },
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([survivorSink, occurrenceSink, occurrenceSource])
  })

  it('remaps an absolute parent tag on the flattened occurrence without moving it', () => {
    const initial = flattenDocument()
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [
        { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'occurrence', port: 'netInput' }, position: { x: 500, y: 300 } },
      ],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n100', port: 'netIn' }, position: { x: 500, y: 300 } },
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n101', port: 'netOther' }, position: { x: 500, y: 300 } },
    ])
  })

  it('is one undo and redo with materialized state, clean allocator high-water marks, and retained orphan definition', () => {
    const initial = flattenDocument()
    initial.graphs.root!.nodes.occurrence!.values.input = 41
    delete initial.graphs.root!.nodes.survivor
    delete initial.view.graphs.root!.nodes.survivor
    const invocation = flattenInvocation(initial)
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.doc.graphs.body).toBeDefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(109)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.occurrence).toBeDefined()
    expect(session.doc.graphs.body).toBeDefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(109)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.occurrence).toBeUndefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(109)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.canRedo).toBe(false)
  })

  it('allocates canonically across permuted record insertion order', () => {
    const first = flattenDocument()
    const second = flattenDocument()
    second.graphs.body.nodes = Object.fromEntries(Object.entries(second.graphs.body.nodes).reverse())
    second.graphs.body.links = Object.fromEntries(Object.entries(second.graphs.body.links).reverse())
    second.graphs.body.nets = Object.fromEntries(Object.entries(second.graphs.body.nets).reverse())
    second.graphs.root.links = Object.fromEntries(Object.entries(second.graphs.root.links).reverse())
    const firstSession = trustedFlattenSession(first)
    const secondSession = trustedFlattenSession(second)
    expect(firstSession.dispatch(flattenInvocation(first)).ok).toBe(true)
    expect(secondSession.dispatch(flattenInvocation(second)).ok).toBe(true)
    expect(secondSession.doc.graphs.root).toEqual(firstSession.doc.graphs.root)
    expect(secondSession.doc.view.graphs.root).toEqual(firstSession.doc.view.graphs.root)
  })

  it('keys schema plans by authored aliases and exposes the initial-dispatch registry digest guard', () => {
    const initial = flattenDocument()
    initial.graphs.body!.nodes.a!.type = 'AuthoredAlias'
    const schema = (type: string, items: readonly any[]) => ({
      type, displayName: type, category: 'test', source: 'v3' as const, items, isOutputNode: false,
    })
    const aliasTarget = schema('CanonicalTarget', [
      { kind: 'input', id: 'in', type: { kind: 'concrete', name: 'X' }, optional: true, widget: { widgetType: 'INT', options: {} } },
      { kind: 'input', id: 'netIn', type: { kind: 'concrete', name: 'X' }, optional: true },
    ])
    const bodySchema = schema('BodyNode', [
      ...['other', 'netOther'].map((id) => ({ kind: 'input', id, type: { kind: 'concrete', name: 'X' }, optional: true })),
      ...['out', 'net'].map((id) => ({ kind: 'output', id, type: { kind: 'concrete', name: 'X' } })),
    ])
    const resolve = (type: string) => type === 'AuthoredAlias' ? aliasTarget : type === 'BodyNode' ? bodySchema : undefined
    const schemaPlan = planFlattenBoundaryRoutes(initial.graphs.body!, resolve, initial.graphs.root!.nodes.occurrence!, initial.graphs.root!)
    expect(Object.keys(schemaPlan.schemaSnapshot).sort()).toEqual(['AuthoredAlias', 'BodyNode'])
    expect(schemaPlan.schemaSnapshot.AuthoredAlias!.type).toBe('CanonicalTarget')
    expect(flattenRegistryMatchesSchemaPlan(
      schemaPlan.schemaSnapshot, schemaPlan.schemaPlanDigest, resolve, schemaPlan.boundaryPlan, schemaPlan.statePlan,
    )).toBe(true)
    expect(flattenRegistryMatchesSchemaPlan(schemaPlan.schemaSnapshot, schemaPlan.schemaPlanDigest, (type) => {
      const resolved = resolve(type)
      return resolved === undefined ? undefined : { ...resolved, displayName: `${resolved.displayName} changed` }
    }, schemaPlan.boundaryPlan, schemaPlan.statePlan)).toBe(false)

    const invocation = flattenInvocation(initial) as any
    invocation.params.boundaryPlan = schemaPlan.boundaryPlan
    invocation.params.schemaSnapshot = schemaPlan.schemaSnapshot
    invocation.params.statePlan = schemaPlan.statePlan
    invocation.params.schemaPlanDigest = schemaPlan.schemaPlanDigest
    refreshFlattenFingerprint(initial, invocation)
    const session = trustedFlattenSession(initial, resolve)
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.n100!.type).toBe('AuthoredAlias')
  })

  it('materializes one effective promoted value and controller onto primary and alsoBinds targets', () => {
    const initial = flattenDocument()
    initial.graphs.body!.nodes.a!.values.in = 7
    initial.graphs.body!.nodes.b!.values.other = 9
    initial.graphs.root!.nodes.occurrence!.values.input = 33
    initial.graphs.root!.nodes.occurrence!.controllers = { input: 'randomize' }
    const session = trustedFlattenSession(initial)

    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.n100!.values.in).toBe(33)
    expect(session.doc.graphs.root!.nodes.n101!.values.other).toBe(33)
    expect(session.doc.graphs.root!.nodes.n100!.controllers?.in).toBe('randomize')
    expect(session.doc.graphs.root!.nodes.n101!.controllers?.other).toBe('randomize')
  })

  it('resolves promoted value and controller ownership independently with explicit null authoritative', () => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.values.in = 7
    initial.graphs.body.nodes.a.controllers = { in: 'fixed' }
    initial.graphs.body.nodes.b.values.other = 9
    initial.graphs.body.nodes.b.controllers = { other: 'decrement' }
    initial.graphs.root.nodes.occurrence.values.input = null
    const session = trustedFlattenSession(initial)

    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.n100!.values.in).toBeNull()
    expect(session.doc.graphs.root!.nodes.n101!.values.other).toBeNull()
    expect(session.doc.graphs.root!.nodes.n100!.controllers?.in).toBe('fixed')
    expect(session.doc.graphs.root!.nodes.n101!.controllers?.other).toBe('fixed')
  })

  it('checksums every top-level v2 plan field and rejects refusal codes outside the closed union', () => {
    const digestDoc = flattenDocument()
    const digestInvocation = flattenInvocation(digestDoc) as any
    const digestMutations = [
      (invocation: any) => { invocation.params.schemaSnapshot['#child'].displayName = 'tampered' },
      (invocation: any) => { invocation.params.boundaryPlan[0].side = 'output' },
      (invocation: any) => { invocation.params.boundaryPlan[0].id = 'tampered' },
      (invocation: any) => { invocation.params.boundaryPlan[0].route = 'combo' },
      (invocation: any) => { invocation.params.statePlan.version = 'tampered' },
      (invocation: any) => { invocation.params.statePlan.status = 'refused' },
      (invocation: any) => { invocation.params.statePlan.source.occurrence.type = 'tampered' },
      (invocation: any) => { invocation.params.statePlan.nodes[0].values = { tampered: true } },
      (invocation: any) => { invocation.params.statePlan.familyScopes.push({ tampered: true }) },
      (invocation: any) => { invocation.params.statePlan.addresses.push({ tampered: true }) },
      (invocation: any) => { invocation.params.statePlan.routes[0].id = 'tampered' },
      (invocation: any) => { invocation.params.statePlan.enclosingRewrites[0].after[0].port = 'tampered' },
      (invocation: any) => { invocation.params.statePlan.enclosingRewrites[0].after[1].port = 'tampered-additional' },
    ]
    for (const mutate of digestMutations) {
      const tampered = structuredClone(digestInvocation)
      mutate(tampered)
      expect(flattenSchemaPlanDigest(
        tampered.params.schemaSnapshot,
        tampered.params.boundaryPlan,
        tampered.params.statePlan,
      )).not.toBe(digestInvocation.params.schemaPlanDigest)
    }

    const mutations = [
      (invocation: any) => { invocation.params.schemaSnapshot['#child'].displayName = 'tampered' },
      (invocation: any) => { invocation.params.boundaryPlan[0].id = 'tampered' },
      (invocation: any) => { invocation.params.statePlan.nodes[0].values = { tampered: true } },
      (invocation: any) => { invocation.params.statePlan.enclosingRewrites[0].after[0].port = 'tampered' },
      (invocation: any) => { invocation.params.statePlan.enclosingRewrites[0].after[1].port = 'tampered-additional' },
    ]
    for (const mutate of mutations) {
      const initial = flattenDocument()
      const invocation = flattenInvocation(initial) as any
      mutate(invocation)
      const session = trustedFlattenSession(initial)
      const before = session.doc
      const outcome = session.dispatch(invocation)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
      expect(session.doc).toBe(before)
    }

    const initial = flattenDocument()
    const invocation = flattenInvocation(initial) as any
    invocation.params.statePlan = {
      version: 'subgraph-flatten-state-plan-v1',
      status: 'refused',
      source: invocation.params.statePlan.source,
      refusal: { code: 'subgraph.flatten.forged', message: 'forged' },
    }
    refreshFlattenSchemaDigest(invocation)
    refreshFlattenFingerprint(initial, invocation)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
    expect(session.doc).toBe(before)

    const malformedDoc = flattenDocument()
    const malformed = flattenInvocation(malformedDoc) as any
    malformed.params.statePlan.nodes[0].controllers = { in: 'invalid' }
    refreshFlattenSchemaDigest(malformed)
    refreshFlattenFingerprint(malformedDoc, malformed)
    const malformedSession = trustedFlattenSession(malformedDoc)
    const malformedBefore = malformedSession.doc
    const malformedOutcome = malformedSession.dispatch(malformed)
    expect(malformedOutcome.ok).toBe(false)
    if (!malformedOutcome.ok) expect(malformedOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
    expect(malformedSession.doc).toBe(malformedBefore)

    for (const mutate of [
      (forged: any) => { forged.params.statePlan.nodes[0].values.in = 999 },
      (forged: any) => {
        forged.params.statePlan = {
          version: 'subgraph-flatten-state-plan-v1', status: 'refused',
          source: forged.params.statePlan.source,
          refusal: { code: 'subgraph.flatten.stateUnresolved', message: 'forged state refusal' },
        }
      },
    ]) {
      const forgedDoc = flattenDocument()
      const forged = flattenInvocation(forgedDoc) as any
      mutate(forged)
      refreshFlattenSchemaDigest(forged)
      refreshFlattenFingerprint(forgedDoc, forged)
      const forgedSession = trustedFlattenSession(forgedDoc)
      const forgedBefore = forgedSession.doc
      const forgedOutcome = forgedSession.dispatch(forged)
      expect(forgedOutcome.ok).toBe(false)
      if (!forgedOutcome.ok) expect(forgedOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
      expect(forgedSession.doc).toBe(forgedBefore)
    }

    for (const refusal of [
      { code: 'subgraph.flatten.familyUnsupported', message: 'forged', side: 'input', boundaryId: 'input' },
      { code: 'subgraph.flatten.stateUnresolved', message: 'malformed', address: { port: '', members: [''] } },
    ]) {
      const forgedDoc = flattenDocument()
      const forged = flattenInvocation(forgedDoc) as any
      forged.params.statePlan = {
        version: 'subgraph-flatten-state-plan-v1', status: 'refused',
        source: forged.params.statePlan.source, refusal,
      }
      refreshFlattenSchemaDigest(forged)
      refreshFlattenFingerprint(forgedDoc, forged)
      const forgedSession = trustedFlattenSession(forgedDoc)
      const forgedBefore = forgedSession.doc
      const forgedOutcome = forgedSession.dispatch(forged)
      expect(forgedOutcome.ok).toBe(false)
      if (!forgedOutcome.ok) expect(forgedOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
      expect(forgedSession.doc).toBe(forgedBefore)
    }

    const familyDoc = flattenDocument()
    familyDoc.graphs.body.boundary.inputs[0].binds.kind = 'family'
    const forgedFamily = flattenInvocation(familyDoc) as any
    const ready = flattenInvocation(flattenDocument()) as any
    forgedFamily.params.boundaryPlan[0].route = 'plain'
    forgedFamily.params.statePlan = ready.params.statePlan
    refreshFlattenSchemaDigest(forgedFamily)
    refreshFlattenFingerprint(familyDoc, forgedFamily)
    const familySession = trustedFlattenSession(familyDoc)
    const familyBefore = familySession.doc
    const familyOutcome = familySession.dispatch(forgedFamily)
    expect(familyOutcome.ok).toBe(false)
    if (!familyOutcome.ok) expect(familyOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
    expect(familySession.doc).toBe(familyBefore)

    const specializedDoc = flattenDocument()
    const forgedSpecialized = flattenInvocation(specializedDoc) as any
    forgedSpecialized.params.schemaSnapshot['#child'].items[0].dynamic = {
      kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'X' }, inputs: [],
    }
    refreshFlattenSchemaDigest(forgedSpecialized)
    refreshFlattenFingerprint(specializedDoc, forgedSpecialized)
    const specializedSession = trustedFlattenSession(specializedDoc)
    const specializedBefore = specializedSession.doc
    const specializedOutcome = specializedSession.dispatch(forgedSpecialized)
    expect(specializedOutcome.ok).toBe(false)
    if (!specializedOutcome.ok) expect(specializedOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
    expect(specializedSession.doc).toBe(specializedBefore)
  })

  it('checks freshness and exact source before honoring a planner-carried refusal', () => {
    const refusedDoc = flattenDocument()
    refusedDoc.graphs.root.nodes.occurrence.values.netInput = 3
    const staleInvocation = flattenInvocation(refusedDoc) as any
    expect(staleInvocation.params.statePlan.status).toBe('refused')
    refusedDoc.graphs.body.nodes.a.title = 'peer edit'
    const staleSession = trustedFlattenSession(refusedDoc)
    const staleBefore = staleSession.doc
    const staleOutcome = staleSession.dispatch(staleInvocation)
    expect(staleOutcome.ok).toBe(false)
    if (!staleOutcome.ok) expect(staleOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.stalePlan')
    expect(staleSession.doc).toBe(staleBefore)

    const sourceDoc = flattenDocument()
    sourceDoc.graphs.root.nodes.occurrence.values.netInput = 3
    const sourceInvocation = flattenInvocation(sourceDoc) as any
    sourceDoc.graphs.root.nodes.occurrence.values.netInput = 4
    refreshFlattenFingerprint(sourceDoc, sourceInvocation)
    const sourceSession = trustedFlattenSession(sourceDoc)
    const sourceBefore = sourceSession.doc
    const sourceOutcome = sourceSession.dispatch(sourceInvocation)
    expect(sourceOutcome.ok).toBe(false)
    if (!sourceOutcome.ok) expect(sourceOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('params.invalid')
    expect(sourceSession.doc).toBe(sourceBefore)
  })

  it('materializes prefix-family members in occurrence order and rewrites member endpoints', () => {
    const familyInput = {
      kind: 'input' as const, id: 'items', type: { kind: 'concrete' as const, name: 'X' }, optional: true,
      dynamic: {
        kind: 'autogrow' as const, naming: { kind: 'prefix' as const, prefix: 'item', min: 0, max: 8 },
        template: [{
          kind: 'input' as const, id: 'value', type: { kind: 'concrete' as const, name: 'X' }, optional: true,
          widget: { widgetType: 'INT', options: {}, controller: 'after_generate' },
        }],
      },
    }
    const schema: any = {
      type: 'FamilyNode', displayName: 'FamilyNode', category: 'test', source: 'v3', isOutputNode: false,
      items: [familyInput, { ...familyInput, kind: 'output', id: 'outputs' }, { ...familyInput, kind: 'output', id: 'unrelated' }],
    }
    const root = graph({
      nodes: {
        source: { id: 'source' as never, type: 'Source', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
        occurrence: {
          id: 'occurrence' as never, type: '#body', values: { 'family.value#z': 7, 'family.value#a': 9 },
          controllers: { 'family.value#z': 'fixed' },
          dynamic: { family: { members: ['z', 'a'] }, outFamily: { members: ['q'] } },
        },
      },
      links: {
        first: link('first', port('source', 'out'), port('occurrence', 'family.value', ['z'])),
        outgoing: link('outgoing', port('occurrence', 'outFamily.value', ['q']), port('consumer', 'in')),
      },
      nets: {
        incoming: { id: 'incoming' as never, name: 'incoming', source: port('source', 'out3'), sinks: [port('occurrence', 'family.value', ['a'])] },
        outputNet: { id: 'outputNet' as never, name: 'outgoing', source: port('occurrence', 'outFamily.value', ['q']), sinks: [port('consumer', 'net')] },
      },
      nextOrdinal: 40,
    })
    const body = graph({
      id: 'body' as never, name: 'Body',
      nodes: {
        inner: {
          id: 'inner' as never, type: 'FamilyNode', values: {},
          dynamic: {
            items: { members: ['m4'], seq: 8 },
            outputs: { members: [], seq: 2 },
            unrelated: { members: [`kept${String.fromCharCode(0)}identity`] },
          },
        },
        bodyConsumer: { id: 'bodyConsumer' as never, type: 'Consumer', values: {} },
      },
      links: {
        unrelatedBody: link(
          'unrelatedBody',
          port('inner', 'unrelated.value', [`kept${String.fromCharCode(0)}identity`]),
          port('bodyConsumer', 'in'),
        ),
      },
      boundary: {
        inputs: [{ id: 'family', binds: { kind: 'family', node: 'inner' as never, port: 'items' as never } }],
        outputs: [{ id: 'outFamily', binds: { kind: 'family', node: 'inner' as never, port: 'outputs' as never } }],
      },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { source: {}, consumer: {}, occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = {
      nodes: { inner: { position: { x: 0, y: 0 } }, bodyConsumer: { position: { x: 200, y: 0 } } },
    }
    const resolve = (type: string) => type === 'FamilyNode' ? schema : undefined
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status, JSON.stringify(plan.statePlan)).toBe('ready')
    if (plan.statePlan.status === 'ready') {
      expect(plan.statePlan.familyScopes[0]).toMatchObject({
        sourceMembers: ['z', 'a'],
        targetBefore: { members: ['m4'], seq: 8 },
        members: [{ before: 'z', after: 'm8' }, { before: 'a', after: 'm9' }],
      })
    }
    const enclosing = structuredClone(initial) as MutableDocument
    enclosing.graphs.root.boundary = {
      inputs: [{ id: 'outerFamily', binds: { kind: 'port', node: 'occurrence' as never, port: 'family.value' as never, members: ['z' as never] } }],
      outputs: [],
    }
    const enclosingPlan = planFlattenBoundaryRoutes(body, resolve, enclosing.graphs.root.nodes.occurrence!, enclosing.graphs.root)
    expect(enclosingPlan.statePlan).toMatchObject({
      status: 'ready',
      enclosingRewrites: [{
        side: 'input', itemIndex: 0, itemId: 'outerFamily', bindingIndex: 0,
        before: { kind: 'port', node: 'occurrence', port: 'family.value', members: ['z'] },
        after: [{ kind: 'port', node: 'inner', port: 'items.value', members: ['m8'] }],
      }],
    })
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [
            { id: 'bodyConsumer', kind: 'node', x: 200, y: 0, width: 140, height: 80 },
            { id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 },
          ],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.nodes.n41!.dynamic!.items).toMatchObject({ members: ['m4', 'm8', 'm9'], seq: 10 })
    expect(session.doc.graphs.root!.nodes.n41!.dynamic!.outputs).toMatchObject({ members: ['m2'], seq: 3 })
    expect(session.doc.graphs.root!.nodes.n41!.dynamic!.unrelated).toEqual({
      members: [`kept${String.fromCharCode(0)}identity`],
    })
    expect(session.doc.graphs.root!.nodes.n41!.values).toMatchObject({ 'items.value#m8': 7, 'items.value#m9': 9 })
    expect(session.doc.graphs.root!.nodes.n41!.controllers).toMatchObject({ 'items.value#m8': 'fixed' })
    expect(session.doc.graphs.root!.links.first!.to).toEqual(port('n41', 'items.value', ['m8']))
    expect(session.doc.graphs.root!.links.outgoing!.from).toEqual(port('n41', 'outputs.value', ['m2']))
    expect(Object.values(session.doc.graphs.root!.links)).toContainEqual(expect.objectContaining({
      from: port('n41', 'unrelated.value', [`kept${String.fromCharCode(0)}identity`]),
      to: port('n40', 'in'),
    }))
    expect(session.doc.graphs.root!.nets.incoming!.sinks).toEqual([port('n41', 'items.value', ['m9'])])
    expect(session.doc.graphs.root!.nets.outputNet!.source).toEqual(port('n41', 'outputs.value', ['m2']))
  })

  it('fans out enclosing descendant family inputs in primary-additional order and preserves the compiled prompt', () => {
    const leaf = (id: string): any => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'core.int' }, optional: true,
      widget: { widgetType: 'INT', options: {} },
    })
    const nested: any = {
      kind: 'input', id: 'nested', type: { kind: 'concrete', name: 'core.int' }, optional: true,
      dynamic: {
        kind: 'autogrow', naming: { kind: 'prefix', prefix: 'nested', min: 0, max: 8 },
        template: [leaf('keep'), leaf('drop')],
      },
    }
    const family: any = {
      kind: 'input', id: 'items', type: { kind: 'concrete', name: 'core.int' }, optional: true,
      dynamic: {
        kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
        template: [leaf('first'), leaf('second'), nested],
      },
    }
    const schema: any = {
      type: 'SelectedFamily', displayName: 'SelectedFamily', category: 'test', source: 'v3',
      isOutputNode: true, items: [family],
    }
    const additionalSchema: any = {
      ...schema,
      type: 'SelectedFamilyAdditional',
      displayName: 'SelectedFamilyAdditional',
      items: [{ ...family, dynamic: { ...family.dynamic, template: [...family.dynamic.template, leaf('extra')] } }],
    }
    const root = graph({
      nodes: {
        occurrence: {
          id: 'occurrence' as never, type: '#body', values: { 'family.first#x': 5 },
          dynamic: { family: { members: ['x'] } },
        },
      },
      boundary: {
        inputs: [{
          id: 'outer',
          binds: { kind: 'family', node: 'occurrence' as never, port: 'family' as never, slots: ['nested.keep'] },
        }],
        outputs: [],
      },
      valueSources: {}, selectors: {}, nextOrdinal: 20,
    })
    const body = graph({
      id: 'body' as never, name: 'Body',
      nodes: {
        innerPrimary: { id: 'innerPrimary' as never, type: 'SelectedFamily', values: {} },
        innerAdditional: { id: 'innerAdditional' as never, type: 'SelectedFamilyAdditional', values: {} },
      },
      boundary: {
        inputs: [{
          id: 'family',
          binds: { kind: 'family', node: 'innerPrimary' as never, port: 'items' as never, slots: ['nested.keep', 'first'] },
          alsoBinds: [{ kind: 'family', node: 'innerAdditional' as never, port: 'items' as never, slots: ['extra', 'nested.keep', 'first'] }],
        }],
        outputs: [],
      },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = {
      nodes: {
        innerPrimary: { position: { x: 0, y: 0 } },
        innerAdditional: { position: { x: 180, y: 0 } },
      },
    }
    const resolve = (type: string) => type === 'SelectedFamily'
      ? schema
      : type === 'SelectedFamilyAdditional' ? additionalSchema : undefined
    const compileDoc = (doc: WorkflowDocument) => compile({
      document: doc, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('enclosing-family'), schemaHash: 'enclosing-family',
    })
    const before = compileDoc(initial)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status, JSON.stringify(plan.statePlan)).toBe('ready')
    if (plan.statePlan.status !== 'ready') return
    expect(plan.statePlan.enclosingRewrites).toEqual([{
      side: 'input', itemIndex: 0, itemId: 'outer', bindingIndex: 0,
      before: { kind: 'family', node: 'occurrence', port: 'family', slots: ['nested.keep'] },
      after: [
        { kind: 'family', node: 'innerPrimary', port: 'items', slots: ['nested.keep'] },
        { kind: 'family', node: 'innerAdditional', port: 'items', slots: ['nested.keep'] },
      ],
    }])
    const absent = structuredClone(initial) as MutableDocument
    delete absent.graphs.body.boundary.inputs[0].binds.slots
    delete absent.graphs.body.boundary.inputs[0].alsoBinds[0].slots
    delete absent.graphs.root.boundary.inputs[0].binds.slots
    expect(planFlattenBoundaryRoutes(absent.graphs.body, resolve, absent.graphs.root.nodes.occurrence, absent.graphs.root).statePlan).toMatchObject({
      status: 'ready', enclosingRewrites: [{ after: [
        { kind: 'family', node: 'innerPrimary', port: 'items' },
        { kind: 'family', node: 'innerAdditional', port: 'items' },
      ] }],
    })
    const explicitFull = structuredClone(initial) as MutableDocument
    explicitFull.graphs.body.boundary.inputs[0].binds.slots = ['nested', 'second', 'first']
    delete explicitFull.graphs.root.boundary.inputs[0].binds.slots
    expect(planFlattenBoundaryRoutes(explicitFull.graphs.body, resolve, explicitFull.graphs.root.nodes.occurrence, explicitFull.graphs.root).statePlan).toMatchObject({
      status: 'ready', enclosingRewrites: [{ after: [
        { slots: ['first', 'second', 'nested'] },
        { slots: ['first', 'nested.keep', 'extra'] },
      ] }],
    })
    const narrowedFull = structuredClone(initial) as MutableDocument
    narrowedFull.graphs.body.boundary.inputs[0].binds.slots = ['nested.drop', 'first', 'nested.keep']
    delete narrowedFull.graphs.root.boundary.inputs[0].binds.slots
    const narrowedFullPlan = planFlattenBoundaryRoutes(narrowedFull.graphs.body, resolve, narrowedFull.graphs.root.nodes.occurrence, narrowedFull.graphs.root)
    expect(narrowedFullPlan.statePlan, JSON.stringify(narrowedFullPlan.statePlan)).toMatchObject({
      status: 'ready', enclosingRewrites: [{ after: [
        { slots: ['first', 'nested.keep', 'nested.drop'] },
        { slots: ['first', 'nested.keep', 'extra'] },
      ] }],
    })
    const unknownAdditionalSlot = structuredClone(initial) as MutableDocument
    unknownAdditionalSlot.graphs.body.boundary.inputs[0].alsoBinds[0].slots = ['ghost']
    expect(planFlattenBoundaryRoutes(
      unknownAdditionalSlot.graphs.body,
      resolve,
      unknownAdditionalSlot.graphs.root.nodes.occurrence,
      unknownAdditionalSlot.graphs.root,
    ).statePlan).toMatchObject({ status: 'refused' })
    const disjoint = structuredClone(initial) as MutableDocument
    disjoint.graphs.body.boundary.inputs[0].binds.slots = ['first']
    disjoint.graphs.root.boundary.inputs[0].binds.slots = ['second']
    const disjointPlan = planFlattenBoundaryRoutes(disjoint.graphs.body, resolve, disjoint.graphs.root.nodes.occurrence, disjoint.graphs.root)
    expect(disjointPlan.statePlan).toMatchObject({
      status: 'refused', refusal: { code: 'subgraph.flatten.stateUnresolved' },
    })
    const disjointEvidence = {
      boundaryPlan: disjointPlan.boundaryPlan,
      statePlan: disjointPlan.statePlan,
      schemaPlanDigest: disjointPlan.schemaPlanDigest,
    }
    const disjointSession = trustedFlattenSession(disjoint, resolve)
    const disjointBefore = disjointSession.doc
    const disjointBytes = JSON.stringify(disjointBefore)
    const disjointOrdinal = disjointBefore.graphs.root!.nextOrdinal
    const disjointActorCursors = disjointBefore.graphs.root!.actorCursors
    const disjointGroupSeq = disjointBefore.view.graphs.root!.groupSeq
    const disjointOutcome = disjointSession.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [
            { id: 'innerPrimary', kind: 'node', x: 0, y: 0, width: 140, height: 80 },
            { id: 'innerAdditional', kind: 'node', x: 180, y: 0, width: 140, height: 80 },
          ],
        },
        boundaryPlan: disjointPlan.boundaryPlan as unknown as Json,
        statePlan: disjointPlan.statePlan as unknown as Json,
        schemaSnapshot: disjointPlan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: disjointPlan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(disjoint, 'root', 'occurrence', disjointEvidence)!,
      },
    })
    expect(disjointOutcome.ok).toBe(false)
    if (!disjointOutcome.ok) expect(disjointOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.stateUnresolved')
    expect(disjointSession.doc).toBe(disjointBefore)
    expect(JSON.stringify(disjointSession.doc)).toBe(disjointBytes)
    expect(disjointSession.doc.graphs.root!.nextOrdinal).toBe(disjointOrdinal)
    expect(disjointSession.doc.graphs.root!.actorCursors).toEqual(disjointActorCursors)
    expect(disjointSession.doc.view.graphs.root!.groupSeq).toBe(disjointGroupSeq)
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [
            { id: 'innerPrimary', kind: 'node', x: 0, y: 0, width: 140, height: 80 },
            { id: 'innerAdditional', kind: 'node', x: 180, y: 0, width: 140, height: 80 },
          ],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.boundary!.inputs[0]!.binds).toEqual({
      kind: 'family', node: 'n21', port: 'items', slots: ['nested.keep'],
    })
    expect(session.doc.graphs.root!.boundary!.inputs[0]!.alsoBinds).toEqual([{
      kind: 'family', node: 'n20', port: 'items', slots: ['nested.keep'],
    }])
    const after = compileDoc(session.doc)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(after.artifact.prompt).map((node) => node.inputs)).toEqual(
        Object.values(before.artifact.prompt).map((node) => node.inputs),
      )
    }
  })

  it('keeps enclosing output unique-producer refusal named and byte-cursor atomic', () => {
    const initial = flattenDocument()
    initial.graphs.body.boundary.outputs[0].alsoBinds = [
      { kind: 'port', node: 'a', port: 'out' },
    ]
    const invocation = flattenInvocation(initial)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const beforeBytes = JSON.stringify(before)
    const beforeOrdinal = before.graphs.root!.nextOrdinal
    const beforeActorCursors = before.graphs.root!.actorCursors
    const beforeGroupSeq = before.view.graphs.root!.groupSeq

    const outcome = session.dispatch(invocation)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(outcome.diagnostics)).toContain('subgraph.lifecycle.boundaryUnresolved')
    expect(session.doc).toBe(before)
    expect(JSON.stringify(session.doc)).toBe(beforeBytes)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(beforeOrdinal)
    expect(session.doc.graphs.root!.actorCursors).toEqual(beforeActorCursors)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(beforeGroupSeq)
  })

  it('materializes a concrete port beneath ancestor family members', () => {
    const family = (id: string, template: readonly any[]): any => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'X' }, optional: true,
      dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: id, min: 0, max: 8 }, template },
    })
    const schema: any = {
      type: 'ConcreteMember', displayName: 'ConcreteMember', category: 'test', source: 'v3', isOutputNode: false,
      items: [family('outer', [family('inner', [
        { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'X' }, optional: true },
      ])])],
    }
    const root = graph({
      nodes: {
        source: { id: 'source' as never, type: 'Source', values: {} },
        occurrence: {
          id: 'occurrence' as never, type: '#body', values: { selected: 17 },
        },
      },
      links: { selected: link('selected', port('source', 'out'), port('occurrence', 'selected')) },
      nextOrdinal: 30,
    })
    const body = graph({
      id: 'body' as never, name: 'Body',
      nodes: {
        inner: {
          id: 'inner' as never, type: 'ConcreteMember', values: {},
          dynamic: { outer: { members: ['m4'], memberState: { m4: { 'outer.inner': { members: ['m2'] } } } } },
        },
      },
      boundary: {
        inputs: [{
          id: 'selected', promoted: true,
          binds: { kind: 'port', node: 'inner' as never, port: 'outer.inner.value' as never, members: ['m4' as never, 'm2' as never] },
        }],
        outputs: [],
      },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { source: {}, occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    const resolve = (type: string) => type === 'ConcreteMember' ? schema : undefined
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status, JSON.stringify(plan.statePlan)).toBe('ready')
    if (plan.statePlan.status !== 'ready') return
    expect(plan.statePlan.familyScopes).toHaveLength(0)
    expect(plan.statePlan.addresses).toContainEqual(expect.objectContaining({
      before: { port: 'selected' },
      uses: ['endpoint', 'value'],
      targets: [expect.objectContaining({
        binding: expect.objectContaining({ port: 'outer.inner.value', members: ['m4', 'm2'] }),
      })],
    }))
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.nodes.n30!.values).toEqual({ 'outer.inner.value#m4#m2': 17 })
    expect(session.doc.graphs.root!.links.selected!.to).toEqual(port('n30', 'outer.inner.value', ['m4', 'm2']))
  })

  it('materializes recursive family scopes independently and preserves the compiled prompt', () => {
    const leaf: any = {
      kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.int' }, optional: false,
      widget: { widgetType: 'INT', options: {} },
    }
    const family = (id: string, template: readonly any[]) => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'core.int' }, optional: true,
      dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: id, min: 0, max: 8 }, template },
    })
    const schema: any = {
      type: 'RecursiveFamily', displayName: 'RecursiveFamily', category: 'test', source: 'v3', isOutputNode: true,
      items: [family('outer', [family('inner', [leaf])])],
    }
    const root = graph({
      nodes: {
        occurrence: {
          id: 'occurrence' as never, type: '#body', values: { 'family.inner.value#o#i': 12 },
          dynamic: {
            family: { members: ['o'], seq: 7, memberState: { o: { 'family.inner': { members: ['i'], seq: 3 } } } },
          },
        },
      },
      valueSources: {}, selectors: {}, nextOrdinal: 20,
    })
    const body = graph({
      id: 'body' as never, name: 'Body',
      nodes: { inner: { id: 'inner' as never, type: 'RecursiveFamily', values: {} } },
      boundary: { inputs: [{ id: 'family', binds: { kind: 'family', node: 'inner' as never, port: 'outer' as never } }], outputs: [] },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    const resolve = (type: string) => type === 'RecursiveFamily' ? schema : undefined
    const compileDoc = (doc: WorkflowDocument) => compile({
      document: doc, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('recursive-family'), schemaHash: 'recursive-family',
    })
    const before = compileDoc(initial)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status, JSON.stringify(plan.statePlan)).toBe('ready')
    if (plan.statePlan.status === 'ready') {
      expect(plan.statePlan.familyScopes).toHaveLength(2)
      expect(plan.statePlan.familyScopes.map((scope) => scope.members)).toEqual([
        [{ before: 'o', after: 'm0' }],
        [{ before: 'i', after: 'm0' }],
      ])
      expect(plan.statePlan.familyScopes[1]!.parent).toEqual({ scope: 'family-0', beforeMember: 'o', afterMember: 'm0' })
    }
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.nodes.n20!.values).toEqual({ 'outer.inner.value#m0#m0': 12 })
    const after = compileDoc(session.doc)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual(Object.values(before.artifact.prompt)[0]!.inputs)
    }
  })

  it('flattens a realistic nested-subgraph workflow with three family scopes and exact compile equivalence', () => {
    const leaf: any = {
      kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.int' }, optional: false,
      widget: { widgetType: 'INT', options: {}, controller: 'after_generate' },
    }
    const family = (id: string, template: readonly any[]): any => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'core.int' }, optional: true,
      dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: id, min: 0, max: 8 }, template },
    })
    const leafSchema: any = {
      type: 'NestedFamilyOutput', displayName: 'NestedFamilyOutput', category: 'test', source: 'v3', isOutputNode: true,
      items: [family('outer', [family('middle', [family('inner', [leaf])])])],
    }
    const child = graph({
      id: 'child' as never, name: 'Imported child definition',
      nodes: { leaf: { id: 'leaf' as never, type: 'NestedFamilyOutput', values: {} } },
      boundary: { inputs: [{ id: 'family', binds: { kind: 'family', node: 'leaf' as never, port: 'outer' as never } }], outputs: [] },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const body = graph({
      id: 'body' as never, name: 'Imported wrapper definition',
      nodes: { nested: { id: 'nested' as never, type: '#child', values: {} } },
      boundary: { inputs: [{ id: 'family', binds: { kind: 'family', node: 'nested' as never, port: 'family' as never } }], outputs: [] },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const root = graph({
      nodes: {
        occurrence: {
          id: 'occurrence' as never, type: '#body',
          values: { 'family.middle.inner.value#outer-user#middle-user#inner-user': 42 },
          controllers: { 'family.middle.inner.value#outer-user#middle-user#inner-user': 'fixed' },
          dynamic: {
            family: {
              members: ['outer-user'],
              memberState: {
                'outer-user': {
                  'family.middle': {
                    members: ['middle-user'],
                    memberState: {
                      'middle-user': {
                        'family.middle.inner': { members: ['inner-user'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      valueSources: {}, selectors: {}, nextOrdinal: 20,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.graphs.child = child
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { nested: { position: { x: 0, y: 0 } } } }
    initial.view.graphs.child = { nodes: { leaf: { position: { x: 0, y: 0 } } } }
    const resolve = (type: string): any => {
      if (type === 'NestedFamilyOutput') return leafSchema
      if (type === '#child') return deriveBoundarySchema(child, resolve).schema
      if (type === '#body') return deriveBoundarySchema(body, resolve).schema
      return undefined
    }
    const compileDoc = (doc: WorkflowDocument) => compile({
      document: doc, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('nested-family-import-audit'), schemaHash: 'nested-family-import-audit',
    })
    const before = compileDoc(initial)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status, JSON.stringify(plan.statePlan)).toBe('ready')
    if (plan.statePlan.status !== 'ready') return
    expect(plan.statePlan.familyScopes).toHaveLength(3)
    expect(plan.statePlan.familyScopes.map((scope) => scope.members)).toEqual([
      [{ before: 'outer-user', after: 'm0' }],
      [{ before: 'middle-user', after: 'm0' }],
      [{ before: 'inner-user', after: 'm0' }],
    ])
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'nested', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.nodes.n20).toEqual({
      id: 'n20', type: '#child',
      values: { 'family.middle.inner.value#m0#m0#m0': 42 },
      controllers: { 'family.middle.inner.value#m0#m0#m0': 'fixed' },
      dynamic: {
        family: {
          members: ['m0'], seq: 1,
          memberState: {
            m0: {
              'family.middle': {
                members: ['m0'], seq: 1,
                memberState: { m0: { 'family.middle.inner': { members: ['m0'], seq: 1 } } },
              },
            },
          },
        },
      },
    })
    const after = compileDoc(session.doc)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(before.artifact.prompt)).toHaveLength(1)
      expect(Object.values(after.artifact.prompt)).toHaveLength(1)
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual(Object.values(before.artifact.prompt)[0]!.inputs)
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual({
        'outer.outer0.middle.middle0.inner.inner0': 42,
      })
    }

    const nul = structuredClone(initial) as MutableDocument
    const nulId = `inner${String.fromCharCode(0)}user`
    const occurrence = nul.graphs.root.nodes.occurrence
    occurrence.values = { [`family.middle.inner.value#outer-user#middle-user#${nulId}`]: 42 }
    occurrence.controllers = { [`family.middle.inner.value#outer-user#middle-user#${nulId}`]: 'fixed' }
    occurrence.dynamic.family.memberState['outer-user']['family.middle'].memberState['middle-user']['family.middle.inner'].members = [nulId]
    const nulPlan = planFlattenBoundaryRoutes(nul.graphs.body, resolve, occurrence, nul.graphs.root)
    expect(nulPlan.statePlan).toMatchObject({ status: 'refused', refusal: { code: 'subgraph.flatten.stateUnresolved' } })
    const nulEvidence = {
      boundaryPlan: nulPlan.boundaryPlan, statePlan: nulPlan.statePlan, schemaPlanDigest: nulPlan.schemaPlanDigest,
    }
    const nulSession = trustedFlattenSession(nul, resolve)
    const nulBefore = nulSession.doc
    const nulBytes = JSON.stringify(nulBefore)
    const nulOutcome = nulSession.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'nested', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: nulPlan.boundaryPlan as unknown as Json,
        statePlan: nulPlan.statePlan as unknown as Json,
        schemaSnapshot: nulPlan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: nulPlan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(nul, 'root', 'occurrence', nulEvidence)!,
      },
    })
    expect(nulOutcome.ok).toBe(false)
    if (!nulOutcome.ok) expect(nulOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.stateUnresolved')
    expect(nulSession.doc).toBe(nulBefore)
    expect(JSON.stringify(nulSession.doc)).toBe(nulBytes)
  })

  it('preserves wire-15 names suffixes and refuses stale names and ordinal exhaustion', () => {
    const schemaFor = (naming: any): any => ({
      type: 'WireFamily', displayName: 'WireFamily', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'items', type: { kind: 'concrete', name: 'X' }, optional: true,
        dynamic: {
          kind: 'autogrow', materialization: 'wire15', naming,
          template: [{
            kind: 'input', id: 'value', type: { kind: 'concrete', name: 'X' }, optional: true,
            widget: { widgetType: 'INT', options: {}, controller: 'after_generate' },
          }],
        },
      }],
    })
    const makePlan = (members: string[], naming: any, targetDynamic: any = {}) => {
      const schema = schemaFor(naming)
      const body = graph({
        id: 'body' as never,
        nodes: { inner: { id: 'inner' as never, type: 'WireFamily', values: {}, dynamic: targetDynamic } },
        boundary: { inputs: [{ id: 'family', binds: { kind: 'family', node: 'inner' as never, port: 'items' as never } }], outputs: [] },
      })
      const occurrence: any = { id: 'occurrence', type: '#body', values: {}, dynamic: { family: { members } } }
      return planFlattenBoundaryRoutes(body, () => schema, occurrence, graph({ nodes: { occurrence } }))
    }
    const names = makePlan(['green', 'red'], { kind: 'names', names: ['red', 'green'] })
    expect(names.statePlan.status, JSON.stringify(names.statePlan)).toBe('ready')
    if (names.statePlan.status === 'ready') {
      expect(names.statePlan.familyScopes[0]!.members).toEqual([
        { before: 'green', after: 'green' }, { before: 'red', after: 'red' },
      ])
      expect(names.statePlan.nodes[0]!.dynamic!.items!.members).toEqual(['green', 'red'])
    }
    const wireSchema = schemaFor({ kind: 'names', names: ['red', 'green'] })
    const wireBody = graph({
      id: 'body' as never,
      nodes: { inner: { id: 'inner' as never, type: 'WireFamily', values: {} } },
      boundary: { inputs: [{ id: 'family', binds: { kind: 'family', node: 'inner' as never, port: 'items' as never } }], outputs: [] },
    })
    const wireOccurrence: any = {
      id: 'occurrence', type: '#body', values: { 'family.value#green': 4 },
      controllers: { 'family.value#green': 'fixed' }, dynamic: { family: { members: ['green'] } },
    }
    const wireRoot = graph({
      nodes: { source: { id: 'source' as never, type: 'Source', values: {} }, occurrence: wireOccurrence },
      links: { wire: link('wire', port('source', 'out'), port('occurrence', 'family.value', ['green'])) },
    })
    const wirePlan = planFlattenBoundaryRoutes(wireBody, () => wireSchema, wireOccurrence, wireRoot)
    expect(wirePlan.statePlan.status, JSON.stringify(wirePlan.statePlan)).toBe('ready')
    if (wirePlan.statePlan.status === 'ready') {
      expect(wirePlan.statePlan.addresses).toContainEqual(expect.objectContaining({
        before: { port: 'family.value', members: ['green'] }, uses: ['endpoint', 'value', 'controller'],
        targets: [expect.objectContaining({ binding: expect.objectContaining({ port: 'items.green' }) })],
      }))
      expect(wirePlan.statePlan.nodes[0]!.values).toEqual({ 'items.green': 4 })
      expect(wirePlan.statePlan.nodes[0]!.controllers).toEqual({ 'items.green': 'fixed' })
    }
    const nestedFamily = {
      kind: 'input' as const, id: 'sub', type: { kind: 'concrete' as const, name: 'X' }, optional: true,
      dynamic: {
        kind: 'autogrow' as const, materialization: 'wire15' as const,
        naming: { kind: 'names' as const, names: ['child'] },
        template: [{ kind: 'input' as const, id: 'value', type: { kind: 'concrete' as const, name: 'X' }, optional: true }],
      },
    }
    const mixedSchema = schemaFor({ kind: 'prefix', prefix: 'item', min: 0, max: 8 })
    delete mixedSchema.items[0].dynamic.materialization
    mixedSchema.items[0].dynamic.template = [nestedFamily]
    const mixedBody = graph({
      id: 'body' as never,
      nodes: { inner: { id: 'inner' as never, type: 'WireFamily', values: {} } },
      boundary: { inputs: [{ id: 'family', binds: { kind: 'family', node: 'inner' as never, port: 'items' as never } }], outputs: [] },
      valueSources: {}, selectors: {},
    })
    const mixedOccurrence: any = {
      id: 'occurrence', type: '#body', values: {},
      dynamic: { family: { members: ['outer'] } },
    }
    const mixedRoot = graph({
      nodes: { occurrence: mixedOccurrence },
      boundary: {
        inputs: [{
          id: 'nested',
          binds: { kind: 'family', node: 'occurrence' as never, port: 'family.sub' as never, members: ['outer' as never] },
        }],
        outputs: [],
      },
    })
    const mixedPlan = planFlattenBoundaryRoutes(mixedBody, () => mixedSchema, mixedOccurrence, mixedRoot)
    expect(mixedPlan.statePlan, JSON.stringify(mixedPlan.statePlan)).toMatchObject({
      status: 'ready',
      enclosingRewrites: [{
        before: { kind: 'family', node: 'occurrence', port: 'family.sub', members: ['outer'] },
        after: [{ kind: 'family', node: 'inner', port: 'items.sub', members: ['m0'] }],
      }],
    })
    const mixedDoc = document(mixedRoot) as MutableDocument
    mixedDoc.graphs.body = mixedBody
    mixedDoc.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    mixedDoc.view.graphs.body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    const mixedEvidence = {
      boundaryPlan: mixedPlan.boundaryPlan, statePlan: mixedPlan.statePlan, schemaPlanDigest: mixedPlan.schemaPlanDigest,
    }
    const mixedSession = trustedFlattenSession(mixedDoc, () => mixedSchema)
    const mixedOutcome = mixedSession.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: mixedPlan.boundaryPlan as unknown as Json,
        statePlan: mixedPlan.statePlan as unknown as Json,
        schemaSnapshot: mixedPlan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: mixedPlan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(mixedDoc, 'root', 'occurrence', mixedEvidence)!,
      },
    })
    expect(mixedOutcome.ok, JSON.stringify(!mixedOutcome.ok && mixedOutcome.diagnostics)).toBe(true)
    expect(mixedSession.doc.graphs.root!.boundary!.inputs[0]!.binds).toEqual({
      kind: 'family', node: 'n20', port: 'items.sub', members: ['m0'],
    })
    expect(makePlan(['blue'], { kind: 'names', names: ['red'] }).statePlan).toMatchObject({
      status: 'refused', refusal: { code: 'subgraph.flatten.stateUnresolved' },
    })
    expect(makePlan(['source'], { kind: 'prefix', prefix: 'item', max: 8 }, {
      items: { members: [], seq: 1_000_000_000_000_000 },
    }).statePlan).toMatchObject({
      status: 'refused', refusal: { code: 'subgraph.lifecycle.idExhausted' },
    })
    expect(makePlan([`bad${String.fromCharCode(0)}member`], { kind: 'prefix', prefix: 'item', max: 8 }).statePlan).toMatchObject({
      status: 'refused', refusal: { code: 'subgraph.flatten.stateUnresolved' },
    })
  })

  it('walks inactive combo branches, combo-hop output families, and refuses orphan or colliding family state', () => {
    const input = (id: string, dynamic?: any) => ({
      kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'X' }, optional: true,
      ...(dynamic === undefined ? {} : { dynamic }),
    })
    const family = {
      kind: 'autogrow' as const,
      materialization: 'wire15' as const,
      naming: { kind: 'names' as const, names: ['red'] },
      template: [input('value')],
    }
    const schema: any = {
      type: 'StoredState', displayName: 'StoredState', category: 'test', source: 'v3', isOutputNode: false,
      items: [input('choice', {
        kind: 'dynamicCombo',
        options: [
          { key: 'a', inputs: [input('active')] },
          { key: 'b', inputs: [input('hidden'), input('ins', family), { ...input('outs', family), kind: 'output' }] },
        ],
      })],
    }
    const walked = walkFlattenStoredState({
      type: 'StoredState',
      values: { 'choice.[b].hidden': 2, 'choice.[b].ins.red': 3 },
      dynamic: {
        choice: { selected: 'a' },
        'choice.[b].outs': { members: ['red'] },
      },
    }, schema, ['choice.[b].outs.red'])
    expect(walked).toMatchObject({ ok: true })
    if (walked.ok) {
      expect(walked.inventory.valueKeys).toContain('choice.[b].hidden')
      expect(walked.inventory.valueKeys).toContain('choice.[b].ins.red')
      expect(walked.inventory.dynamicPaths).toContain('choice.[b].outs')
      expect(walked.inventory.portKeys).toEqual(['choice.[b].outs.red'])
    }

    expect(walkFlattenStoredState({
      type: 'StoredState', values: {}, dynamic: { choice: { selected: 'a' }, 'choice.[b].outs': { members: ['red'], memberState: { orphan: {} } } },
    }, schema)).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
    expect(walkFlattenStoredState({
      type: 'StoredState', values: { 'choice.[b].outs.red': 1 }, dynamic: { choice: { selected: 'a' }, 'choice.[b].outs': { members: [], memberState: { red: {} } } },
    }, schema)).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
    expect(walkFlattenStoredState({
      type: 'StoredState', values: {}, dynamic: { choice: { selected: 'a' }, 'choice.[b].outs': { members: ['red', 'red'] } },
    }, schema)).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
    expect(walkFlattenStoredState({
      type: 'StoredState', values: {}, controllers: { 'choice.[b].ins.red': 'fixed' }, dynamic: { choice: { selected: 'a' } },
    }, schema)).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
    expect(walkFlattenStoredState({
      type: 'StoredState', values: { absent: 1 }, dynamic: { choice: { selected: 'a' } },
    }, schema)).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
    const outputSchema: any = {
      type: 'Output', displayName: 'Output', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'X' } }],
    }
    expect(walkFlattenStoredState(
      { type: 'Output', values: {} }, outputSchema, [{ key: 'out', side: 'input' }],
      [{ side: 'output', id: 'out', route: 'plain' }],
    )).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
    const ordinarySchema: any = {
      type: 'Ordinary', displayName: 'Ordinary', category: 'test', source: 'v3', isOutputNode: false,
      items: [input('family', {
        kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', max: 2 },
        template: [input('choice', { kind: 'dynamicCombo', options: [{ key: 'x', inputs: [input('leaf')] }] })],
      })],
    }
    expect(walkFlattenStoredState({
      type: 'Ordinary', values: {}, dynamic: {
        family: {
          members: ['a', 'b'],
          memberState: {
            a: { 'family.choice': { selected: 'x' } },
            b: { 'family.choice': { selected: 'x' } },
          },
        },
      },
    }, ordinarySchema)).toMatchObject({ ok: true })
    expect(walkFlattenStoredState({
      type: 'Ordinary', values: {}, dynamic: { family: { members: [], selected: 'silently-lost' } },
    }, ordinarySchema)).toMatchObject({ ok: false, code: 'subgraph.flatten.stateUnresolved' })
  })

  it('preserves the compiled prompt across promoted value materialization', () => {
    const widgetSchema: any = {
      type: 'WidgetNode', displayName: 'WidgetNode', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.int' }, optional: false,
        widget: { widgetType: 'INT', options: {} },
      }],
    }
    const root = graph({
      nodes: { occurrence: { id: 'occurrence' as never, type: '#body', values: { input: 33 } } },
      valueSources: {}, selectors: {}, nextOrdinal: 20,
    })
    const body = graph({
      id: 'body' as never,
      nodes: { inner: { id: 'inner' as never, type: 'WidgetNode', values: {} } },
      boundary: {
        inputs: [{ id: 'input', promoted: true, binds: { kind: 'port', node: 'inner' as never, port: 'value' as never } }],
        outputs: [],
      },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    const resolve = (type: string) => type === 'WidgetNode' ? widgetSchema : undefined
    const compileDoc = (doc: WorkflowDocument) => compile({
      document: doc,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'l6-equivalence',
    })
    const before = compileDoc(initial)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    const after = compileDoc(session.doc)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual(Object.values(before.artifact.prompt)[0]!.inputs)
      expect(Object.values(after.artifact.prompt)[0]!.inputs.value).toBe(33)
    }
  })

  it('preserves nested definition-owned promoted fallback when the outer occurrence is absent', () => {
    const widgetSchema: any = {
      type: 'WidgetNode', displayName: 'WidgetNode', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.int' }, optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
      }],
    }
    const child = graph({
      id: 'child' as never, name: 'Child',
      nodes: { leaf: { id: 'leaf' as never, type: 'WidgetNode', values: { value: 7 }, controllers: { value: 'fixed' } } },
      boundary: { inputs: [{ id: 'input', promoted: true, binds: { kind: 'port', node: 'leaf' as never, port: 'value' as never } }], outputs: [] },
      valueSources: {}, selectors: {},
    })
    const body = graph({
      id: 'body' as never, name: 'Body',
      nodes: { nested: { id: 'nested' as never, type: '#child', values: {} } },
      boundary: { inputs: [{ id: 'input', promoted: true, binds: { kind: 'port', node: 'nested' as never, port: 'input' as never } }], outputs: [] },
      valueSources: {}, selectors: {},
    })
    const root = graph({
      nodes: { occurrence: { id: 'occurrence' as never, type: '#body', values: {} } },
      valueSources: {}, selectors: {}, nextOrdinal: 20,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.graphs.child = child
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { nested: { position: { x: 0, y: 0 } } } }
    initial.view.graphs.child = { nodes: { leaf: {} } }
    const resolve = (type: string): any => {
      if (type === 'WidgetNode') return widgetSchema
      if (type === '#child') return deriveBoundarySchema(child, resolve).schema
      if (type === '#body') return deriveBoundarySchema(body, resolve).schema
      return undefined
    }
    const before = compile({
      document: initial, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('nested-before'), schemaHash: 'nested-fallback',
    })
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status).toBe('ready')
    if (plan.statePlan.status === 'ready') {
      expect(plan.statePlan.nodes[0]).toMatchObject({ values: { input: 7 }, controllers: { input: 'fixed' } })
    }
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'nested', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.nodes.n20).toMatchObject({ values: { input: 7 }, controllers: { input: 'fixed' } })
    const after = compile({
      document: session.doc, revision: 2, resolve, scope: { kind: 'full' },
      connection: asConnectionId('nested-after'), schemaHash: 'nested-fallback',
    })
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual(Object.values(before.artifact.prompt)[0]!.inputs)
    }
  })

  it('materializes an explicit DynamicCombo selection into the planned clone state', () => {
    const input = (id: string, dynamic?: any) => ({
      kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'X' }, optional: true,
      ...(dynamic === undefined ? {} : { dynamic }),
    })
    const schema: any = {
      type: 'ComboNode', displayName: 'ComboNode', category: 'test', source: 'v3', isOutputNode: false,
      items: [input('choice', {
        kind: 'dynamicCombo',
        options: [{ key: 'a', inputs: [input('x')] }, { key: 'b', inputs: [input('y')] }],
        defaultOption: 'a',
      })],
    }
    const body = graph({
      nodes: { inner: { id: 'inner' as never, type: 'ComboNode', values: {}, dynamic: { choice: { selected: 'a' } } } },
      boundary: { inputs: [{ id: 'combo', binds: { kind: 'port', node: 'inner' as never, port: 'choice' as never } }], outputs: [] },
      valueSources: {}, selectors: {},
    })
    const occurrence: any = { id: 'occurrence', type: '#body', values: {}, dynamic: { combo: { selected: 'b' } } }
    const parent = graph({
      nodes: { occurrence, source: { id: 'source' as never, type: 'Source', values: {} } },
      links: { linked: { id: 'linked' as never, from: port('source', 'out'), to: port('occurrence', 'combo') } },
      nets: { netted: { id: 'netted' as never, name: 'netted', source: port('source', 'out'), sinks: [port('occurrence', 'combo')] } },
      boundary: { inputs: [{ id: 'outer', binds: { kind: 'port', node: 'occurrence' as never, port: 'combo' as never } }], outputs: [] },
      valueSources: {}, selectors: {},
    })
    const plan = planFlattenBoundaryRoutes(body, () => schema, occurrence, parent)
    expect(plan.boundaryPlan).toEqual([{ side: 'input', id: 'combo', route: 'combo' }])
    expect(plan.statePlan.status).toBe('ready')
    if (plan.statePlan.status === 'ready') expect(plan.statePlan.nodes[0]!.dynamic).toEqual({ choice: { selected: 'b' } })

    const staleOccurrence = { id: 'occurrence', type: '#body', values: {}, dynamic: { combo: { selected: 'missing' } } } as any
    const stale = planFlattenBoundaryRoutes(body, () => schema, staleOccurrence, graph({ nodes: { occurrence: staleOccurrence } }))
    expect(stale.statePlan.status).toBe('refused')
    if (stale.statePlan.status === 'refused') expect(stale.statePlan.refusal).toMatchObject({ code: 'subgraph.flatten.stateUnresolved' })

    const wrongShapeOccurrence = {
      id: 'occurrence', type: '#body', values: {},
      dynamic: { combo: { selected: 'a', members: ['silently-lost'], seq: 7 } },
    } as any
    expect(planFlattenBoundaryRoutes(body, () => schema, wrongShapeOccurrence, graph({
      nodes: { occurrence: wrongShapeOccurrence },
    })).statePlan).toMatchObject({ status: 'refused', refusal: { code: 'subgraph.flatten.stateUnresolved' } })

    const inactiveBody = structuredClone(body) as any
    inactiveBody.boundary.inputs[0].binds.port = 'choice.[b].y'
    const inactive = planFlattenBoundaryRoutes(inactiveBody, () => schema, occurrence, parent)
    expect(inactive.statePlan).toMatchObject({
      status: 'refused', refusal: { code: 'subgraph.lifecycle.boundaryUnresolved' },
    })

    const fannedBody = structuredClone(body) as any
    fannedBody.boundary.inputs[0].binds.port = 'choice.[a].x'
    fannedBody.boundary.inputs[0].alsoBinds = [{ kind: 'port', node: 'inner', port: 'choice.[b].y' }]
    const fanned = planFlattenBoundaryRoutes(fannedBody, () => schema, occurrence, parent)
    expect(fanned.statePlan).toMatchObject({
      status: 'refused', refusal: { code: 'subgraph.lifecycle.boundaryUnresolved' },
    })
  })

  it('refuses inventoried inactive combo descendant state instead of silently dropping it', () => {
    const input = (id: string, dynamic?: any) => ({
      kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'X' }, optional: true,
      ...(dynamic === undefined ? {} : { dynamic }),
    })
    const hiddenFamily = {
      kind: 'autogrow' as const,
      naming: { kind: 'prefix' as const, prefix: 'item', min: 0, max: 8 },
      template: [input('value')],
    }
    const schema: any = {
      type: 'ComboNode', displayName: 'ComboNode', category: 'test', source: 'v3', isOutputNode: false,
      items: [input('choice', {
        kind: 'dynamicCombo',
        options: [
          { key: 'a', inputs: [input('active')] },
          { key: 'b', inputs: [input('hidden', hiddenFamily)] },
        ],
        defaultOption: 'a',
      })],
    }
    const body = graph({
      id: 'body' as never,
      nodes: { inner: { id: 'inner' as never, type: 'ComboNode', values: {}, dynamic: { choice: { selected: 'a' } } } },
      boundary: { inputs: [{ id: 'combo', binds: { kind: 'port', node: 'inner' as never, port: 'choice' as never } }], outputs: [] },
      valueSources: {}, selectors: {}, nextOrdinal: 1,
    })
    const root = graph({
      nodes: {
        occurrence: {
          id: 'occurrence' as never, type: '#body', values: {},
          dynamic: {
            combo: { selected: 'a' },
            'combo.[b].hidden': { members: ['dormant'] },
          },
        },
      },
      valueSources: {}, selectors: {}, nextOrdinal: 20,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    const plan = planFlattenBoundaryRoutes(body, () => schema, root.nodes.occurrence!, root)
    expect(plan.statePlan).toMatchObject({
      status: 'refused',
      refusal: { code: 'subgraph.flatten.stateUnresolved' },
    })
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, () => schema)
    const before = session.doc
    const beforeBytes = JSON.stringify(before)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.stateUnresolved')
    expect(session.doc).toBe(before)
    expect(JSON.stringify(session.doc)).toBe(beforeBytes)
  })

  it('plans family roots, combo descendants, and slot descendants as L6-owned routes', () => {
    const dynamicBody = graph({
      nodes: { inside: { id: 'inside' as never, type: 'Dynamic', values: {} } },
      boundary: {
        inputs: [
          { id: 'family', binds: { kind: 'port', node: 'inside' as never, port: 'family' as never } },
          { id: 'combo', binds: { kind: 'port', node: 'inside' as never, port: 'combo.[a].leaf' as never } },
          { id: 'slot', binds: { kind: 'port', node: 'inside' as never, port: 'slot.leaf' as never } },
        ],
        outputs: [],
      },
    })
    const input = (id: string, dynamic?: any) => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'X' }, optional: true, ...(dynamic === undefined ? {} : { dynamic }),
    })
    const dynamicSchema: any = {
      type: 'Dynamic', displayName: 'Dynamic', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        input('family', { kind: 'autogrow', materialization: 'wire15', naming: { kind: 'prefix', prefix: 'item' }, template: [input('leaf')] }),
        input('combo', { kind: 'dynamicCombo', options: [{ key: 'a', label: 'A', inputs: [input('leaf')] }] }),
        input('slot', { kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'X' }, inputs: [input('leaf')] }),
      ],
    }
    const occurrence = { id: 'occurrence', type: '#dynamic', values: {} } as any
    expect(planFlattenBoundaryRoutes(dynamicBody, () => dynamicSchema, occurrence, graph({ nodes: { occurrence } })).boundaryPlan).toEqual([
      { side: 'input', id: 'family', route: 'family' },
      { side: 'input', id: 'combo', route: 'combo' },
      { side: 'input', id: 'slot', route: 'specialized' },
    ])

    ;(dynamicBody.boundary as any).inputs = [dynamicBody.boundary!.inputs[2]!, dynamicBody.boundary!.inputs[0]!]
    const mixed = planFlattenBoundaryRoutes(dynamicBody, () => dynamicSchema, occurrence, graph({ nodes: { occurrence } }))
    expect(mixed.statePlan).toMatchObject({
      status: 'refused',
      refusal: { code: 'subgraph.flatten.specializedSlotUnsupported', side: 'input', boundaryId: 'slot' },
    })

    const nativeSchema: any = {
      ...dynamicSchema,
      items: [input('native', { kind: 'autogrow', materialization: 'wire15', naming: { kind: 'native' }, template: [input('leaf')] })],
    }
    const nativeBody = graph({
      nodes: { inside: { id: 'inside' as never, type: 'Dynamic', values: {} } },
      boundary: { inputs: [{ id: 'native', binds: { kind: 'port', node: 'inside' as never, port: 'native' as never } }], outputs: [] },
    })
    const nativeOccurrence = { id: 'occurrence', type: '#native', values: {}, dynamic: { native: { members: ['free'] } } } as any
    const native = planFlattenBoundaryRoutes(nativeBody, () => nativeSchema, nativeOccurrence, graph({ nodes: { occurrence: nativeOccurrence } }))
    expect(native.statePlan).toMatchObject({ status: 'refused', refusal: { code: 'subgraph.flatten.nativeFamilyUnsupported' } })
  })

  it('rewrites both ends of a promoted occurrence tap delivery before staged cycle checks', () => {
    const initial = flattenDocument()
    initial.graphs.body.boundary.inputs.push({
      id: 'tapTarget', binds: { kind: 'port', node: 'b', port: 'tapTarget' },
    })
    initial.graphs.root.links.crossTap = link(
      'crossTap',
      { node: 'occurrence' as never, tap: 'input' as never },
      port('occurrence', 'tapTarget'),
    )
    const invocation = flattenInvocation(initial)
    const session = trustedFlattenSession(initial)
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.root!.links.crossTap).toEqual({
      id: 'crossTap', from: { node: 'n100', tap: 'in' }, to: port('n101', 'tapTarget'),
    })

    const cyclic = flattenDocument()
    delete cyclic.graphs.root.links.incoming
    cyclic.graphs.root.links.tapCycle = link(
      'tapCycle',
      { node: 'occurrence' as never, tap: 'input' as never },
      port('occurrence', 'input'),
    )
    const cyclicSession = trustedFlattenSession(cyclic)
    const before = cyclicSession.doc
    const outcome = cyclicSession.dispatch(flattenInvocation(cyclic))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('doc.tap.cycle')
    expect(cyclicSession.doc).toBe(before)
  })

  it.each([
    { name: 'nonempty occurrence ext', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.ext = { pack: 1 }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.extensionStateUnsupported' },
    { name: 'body boundary ext', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.body.boundary.inputs[0].ext = { pack: 1 }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.boundaryExtensionUnsupported' },
    { name: 'muted shell', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.mode = 'muted'; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.modeUnsupported' },
    { name: 'bypassed shell', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.mode = 'bypassed'; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.modeUnsupported' },
    { name: 'region shell', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.region = { kind: 'map', elementPorts: ['input'] }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.regionUnsupported' },
    { name: 'missing required state plan with dormant state', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.values.netInput = 3; delete invocation.params.statePlan; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'missing required state plan with dynamic state', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.dynamic = { choice: { selected: 'x' } }; delete invocation.params.statePlan; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'family route missing required state plan', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.body.boundary.inputs[0].binds.kind = 'family'; invocation.params.boundaryPlan[0].route = 'family'; delete invocation.params.statePlan; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'family-member route missing required state plan', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.body.boundary.inputs[0].binds.members = ['m0']; invocation.params.boundaryPlan[0].route = 'family'; delete invocation.params.statePlan; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'ready state plan paired with specialized route', mutate: (doc: MutableDocument, invocation: any) => { invocation.params.schemaSnapshot['#child'].items[0].dynamic = { kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'X' }, inputs: [] }; invocation.params.boundaryPlan[0].route = 'specialized'; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'ready state plan paired with unresolved route', mutate: (doc: MutableDocument, invocation: any) => { invocation.params.schemaSnapshot['#child'].items[0].dynamic = { kind: 'dynamicCombo', options: [] }; invocation.params.boundaryPlan[0].route = 'unresolved'; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'schema snapshot digest mismatch', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.schemaSnapshot['#child'].items[0].tooltip = 'changed' }, code: 'params.invalid' },
    { name: 'malformed state plan coverage', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.statePlan.source.bodyNodes.pop() }, code: 'params.invalid' },
    { name: 'array-shaped route assertion', mutate: (doc: MutableDocument, invocation: any) => { invocation.params.boundaryPlan[0].route = ['plainWidget']; refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'unpromoted boundary tap', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.body.boundary.inputs[0].promoted = false; Object.assign(invocation.params, (flattenInvocation(doc) as any).params) }, code: 'subgraph.flatten.stateUnresolved' },
    { name: 'durable mode-panel binding', mutate: (doc: MutableDocument, invocation: any) => { doc.surfaces = { panel: { id: 'panel', type: 'core.modePanel', config: { bindings: [{ kind: 'node', graphId: 'root', nodeId: 'occurrence' }] } } }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.lifecycle.boundaryUnresolved' },
    { name: 'placement center mismatches occurrence geometry', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.placementCenter = { x: 999, y: 999 } }, code: 'subgraph.lifecycle.boundaryUnresolved' },
    { name: 'output without an inner producer', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.links.outgoing.from.port = 'missing'; Object.assign(invocation.params, (flattenInvocation(doc) as any).params) }, code: 'subgraph.flatten.stateUnresolved' },
    { name: 'non-occurrence target', mutate: (doc: MutableDocument) => { doc.graphs.root.nodes.occurrence.type = 'Plain' }, code: 'subgraph.flatten.notOccurrence' },
    { name: 'stale fingerprint', mutate: (doc: MutableDocument) => { doc.graphs.body.nodes.a.title = 'peer edit' }, code: 'subgraph.lifecycle.stalePlan' },
    { name: 'incomplete geometry', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.resolvedGeometry.body.pop() }, code: 'subgraph.lifecycle.boundaryUnresolved' },
    { name: 'exhausted ids', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nextOrdinal = Number.MAX_SAFE_INTEGER; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.lifecycle.idExhausted' },
  ])('refuses $name atomically as $code', ({ mutate, code }) => {
    const initial = flattenDocument()
    const invocation = flattenInvocation(initial) as any
    mutate(initial, invocation)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const beforeBytes = JSON.stringify(before)
    const beforeOrdinal = before.graphs.root?.nextOrdinal
    const beforeActorCursors = before.graphs.root?.actorCursors
    const beforeGroupSeq = before.view.graphs.root?.groupSeq
    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(outcome.diagnostics)).toContain(code)
    expect(session.doc).toBe(before)
    expect(JSON.stringify(session.doc)).toBe(beforeBytes)
    expect(session.doc.graphs.root?.nextOrdinal).toBe(beforeOrdinal)
    expect(session.doc.graphs.root?.actorCursors).toEqual(beforeActorCursors)
    expect(session.doc.view.graphs.root?.groupSeq).toBe(beforeGroupSeq)
  })

  it('refuses post-allocation duplicate drivers and repeated net sinks without changing bytes or allocator cursors', () => {
    const driven = flattenDocument()
    driven.graphs.body.links.driver = link('driver', port('b', 'driver'), port('a', 'in'))
    const drivenInvocation = flattenInvocation(driven)
    const drivenSession = trustedFlattenSession(driven)
    const drivenBefore = drivenSession.doc
    const drivenOutcome = drivenSession.dispatch(drivenInvocation)
    expect(drivenOutcome.ok).toBe(false)
    if (!drivenOutcome.ok) expect(drivenOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.multiDriver')
    expect(drivenSession.doc).toBe(drivenBefore)

    const repeated = flattenDocument()
    repeated.graphs.root.nets.incomingNet.sinks.push(port('occurrence', 'netInput'))
    const repeatedInvocation = flattenInvocation(repeated)
    const repeatedSession = trustedFlattenSession(repeated)
    const repeatedBefore = repeatedSession.doc
    const repeatedBytes = JSON.stringify(repeatedBefore)
    const repeatedOrdinal = repeatedBefore.graphs.root!.nextOrdinal
    const repeatedGroupSeq = repeatedBefore.view.graphs.root!.groupSeq
    const repeatedOutcome = repeatedSession.dispatch(repeatedInvocation)
    expect(repeatedOutcome.ok).toBe(false)
    if (!repeatedOutcome.ok) expect(repeatedOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.multiDriver')
    expect(repeatedSession.doc).toBe(repeatedBefore)
    expect(JSON.stringify(repeatedSession.doc)).toBe(repeatedBytes)
    expect(repeatedSession.doc.graphs.root!.nextOrdinal).toBe(repeatedOrdinal)
    expect(repeatedSession.doc.view.graphs.root!.groupSeq).toBe(repeatedGroupSeq)
  })
})

describe('subgraph lifecycle prospective DAG and shell refusals', () => {
  const def = (id: string, nodes: GraphDef['nodes'] = {}): GraphDef => ({
    id: id as never, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
  })

  it('detects direct and transitive prospective cycles deterministically', () => {
    expect(checkProspectiveDefinitionDag(new Map([
      ['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['a'])],
    ]))).toEqual({ ok: false, cycle: ['a', 'b', 'c', 'a'], code: 'subgraph.lifecycle.recursive' })
    expect(checkProspectiveDefinitionDag(new Map([
      ['a', new Set(['b'])], ['b', new Set<string>()],
    ]))).toEqual({ ok: true })
  })

  it('checks extraction against moved nested occurrences and flatten against immediate nested refs', () => {
    const doc: WorkflowDocument = {
      ...document(def('root', {
        move: { id: 'move' as never, type: '#child', values: {} },
        stay: { id: 'stay' as never, type: '#other', values: {} },
      })),
      graphs: {
        root: def('root', {
          move: { id: 'move' as never, type: '#child', values: {} },
          stay: { id: 'stay' as never, type: '#other', values: {} },
        }),
        child: def('child', { nested: { id: 'nested' as never, type: '#leaf', values: {} } }),
        other: def('other'),
        leaf: def('leaf'),
      },
    }
    expect(checkProspectiveExtractionDag(doc, 'root', 'fresh', ['move'])).toEqual({ ok: true })
    expect(checkProspectiveFlattenDag(doc, 'root', 'move')).toEqual({ ok: true })

    const dirty = structuredClone(doc) as MutableDocument
    dirty.graphs.leaf!.nodes.back = { id: 'back' as never, type: '#root', values: {} }
    expect(checkProspectiveFlattenDag(dirty, 'root', 'move')).toMatchObject({
      ok: false, code: 'subgraph.lifecycle.recursive',
    })
  })

  it('reports missing contexts, selections, occurrences, bodies, and fresh-id collisions without calling them recursion', () => {
    const doc: WorkflowDocument = {
      ...document(),
      graphs: {
        root: def('root', { occurrence: { id: 'occurrence' as never, type: '#body', values: {} } }),
        body: def('body'),
      },
    }
    expect(checkProspectiveExtractionDag(doc, 'missing', 'fresh', [])).toEqual({
      ok: false, code: 'subgraph.lifecycle.contextInvalid',
    })
    expect(checkProspectiveExtractionDag(doc, 'root', 'body', [])).toEqual({ ok: false, code: 'graph.exists' })
    expect(checkProspectiveExtractionDag(doc, 'root', 'fresh', ['missing'])).toEqual({
      ok: false, code: 'subgraph.lifecycle.selectionMissing',
    })
    expect(checkProspectiveFlattenDag(doc, 'missing', 'occurrence')).toEqual({
      ok: false, code: 'subgraph.lifecycle.contextInvalid',
    })
    expect(checkProspectiveFlattenDag(doc, 'root', 'missing')).toEqual({ ok: false, code: 'subgraph.flatten.notOccurrence' })
    const dangling = structuredClone(doc) as MutableDocument
    delete dangling.graphs.body
    expect(checkProspectiveFlattenDag(dangling, 'root', 'occurrence')).toEqual({
      ok: false, code: 'subgraph.flatten.notOccurrence',
    })
  })

  it('keeps a surviving occurrence reference when flattening a sibling occurrence', () => {
    const doc: WorkflowDocument = {
      ...document(),
      graphs: {
        root: def('root', {
          flatten: { id: 'flatten' as never, type: '#body', values: {} },
          survivor: { id: 'survivor' as never, type: '#body', values: {} },
        }),
        body: def('body'),
      },
    }
    expect(checkProspectiveFlattenDag(doc, 'root', 'flatten')).toEqual({ ok: true })
  })

  it.each([
    { name: 'active shell', node: { mode: 'active' as const }, code: undefined },
    { name: 'muted shell', node: { mode: 'muted' as const }, code: 'subgraph.flatten.modeUnsupported' },
    { name: 'bypassed shell', node: { mode: 'bypassed' as const }, code: 'subgraph.flatten.modeUnsupported' },
    { name: 'region-bearing shell', node: { region: { kind: 'map' as const, elementPorts: ['in'] } }, code: 'subgraph.flatten.regionUnsupported' },
  ])('classifies $name', ({ node, code }) => {
    expect(flattenShellRefusal(node)).toBe(code)
  })

  it('builds the canonical shell refusal with a nested occurrence anchor', () => {
    expect(flattenShellRefusalDiagnostic(
      { region: { kind: 'map', elementPorts: ['in'] } },
      'nestedBody',
      ['outer', 'middle'],
      'region',
    )).toMatchObject({
      code: 'subgraph.flatten.regionUnsupported',
      message: 'subgraph.flatten: occurrence shell mode or region contract cannot be flattened',
      refs: [{ graphId: 'nestedBody', nodeId: 'region' }],
      anchor: { occurrence: { instancePath: ['outer', 'middle'], node: 'region' } },
    })
  })
})

describe('subgraph lifecycle deterministic geometry', () => {
  const items = [
    { id: 'b', kind: 'node' as const, x: 100, y: 50, width: 40, height: 20 },
    { id: 'a', kind: 'reroute' as const, x: 20, y: 10, width: 0, height: 0 },
    { id: 'group', kind: 'group' as const, x: 0, y: 0, width: 200, height: 100 },
  ]

  it('centers extracted bodies over complete bounds and subtracts the center without mutating input', () => {
    const before = structuredClone(items)
    const plan = planExtractedGeometry(items, { x: 999, y: 999 })
    expect(plan).toEqual({
      center: { x: 100, y: 50 },
      bounds: { x: 0, y: 0, width: 200, height: 100 },
      usedPlacementFallback: false,
      items: [
        { id: 'group', kind: 'group', x: -100, y: -50, width: 200, height: 100 },
        { id: 'b', kind: 'node', x: 0, y: 0, width: 40, height: 20 },
        { id: 'a', kind: 'reroute', x: -80, y: -40, width: 0, height: 0 },
      ],
    })
    expect(items).toEqual(before)
  })

  it('places flattened bodies around the occurrence center with the same body-center rule', () => {
    const plan = planFlattenedGeometry(items, { x: 500, y: 300 })
    expect(plan?.center).toEqual({ x: 500, y: 300 })
    expect(plan?.items.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 'group', x: 400, y: 250 },
      { id: 'b', x: 500, y: 300 },
      { id: 'a', x: 420, y: 260 },
    ])
  })

  it('uses the finite invocation center only for empty geometry and rejects incomplete numeric plans', () => {
    expect(planExtractedGeometry([], { x: 7, y: 9 })).toEqual({
      center: { x: 7, y: 9 }, usedPlacementFallback: true, items: [],
    })
    expect(planExtractedGeometry([{ id: 'n', kind: 'node', x: Number.NaN, y: 0, width: 1, height: 1 }], { x: 0, y: 0 }))
      .toBeUndefined()
    expect(planExtractedGeometry([], { x: Number.POSITIVE_INFINITY, y: 0 })).toBeUndefined()
    expect(planExtractedGeometry([
      { id: 'n', kind: 'node', x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
    ], { x: 0, y: 0 })).toBeUndefined()
  })

  it('expands selected groups with the pinned center-inside rule and records explicit membership', () => {
    const result = expandLifecycleSelectionFromGroups({ groupIds: ['g'], nodeIds: ['preselected'] }, [
      { id: 'g', kind: 'group', x: 0, y: 0, width: 100, height: 100 },
      { id: 'n', kind: 'node', x: 90, y: 90, width: 20, height: 20 },
      { id: 'outside', kind: 'node', x: 101, y: 101, width: 0, height: 0 },
      { id: 'r', kind: 'reroute', x: 0, y: 0, width: 0, height: 0 },
      { id: 'v', kind: 'valueSource', x: 40, y: 40, width: 20, height: 20 },
      { id: 's', kind: 'selector', x: 95, y: 0, width: 10, height: 10 },
    ])
    expect(result).toEqual({
      selection: {
        nodeIds: ['n', 'preselected'], rerouteIds: ['r'], valueSourceIds: ['v'], selectorIds: ['s'], groupIds: ['g'],
      },
      groups: [{ groupId: 'g', nodeIds: ['n'], rerouteIds: ['r'], valueSourceIds: ['v'], selectorIds: ['s'] }],
    })
    expect(expandLifecycleSelectionFromGroups({ groupIds: ['empty'] }, [
      { id: 'empty', kind: 'group', x: 0, y: 0, width: 1, height: 1 },
    ])?.groups[0]).toEqual({
      groupId: 'empty', nodeIds: [], rerouteIds: [], valueSourceIds: [], selectorIds: [],
    })
  })

  it('requires exactly one geometry record for every selected positionable', () => {
    expect(validateLifecycleGeometry({
      nodeIds: ['n'], rerouteIds: ['r'], valueSourceIds: ['v'], selectorIds: ['s'], groupIds: ['g'],
    }, [
      { id: 'n', kind: 'node', x: 0, y: 0, width: 1, height: 1 },
      { id: 'r', kind: 'reroute', x: 0, y: 0, width: 0, height: 0 },
      { id: 'v', kind: 'valueSource', x: 0, y: 0, width: 1, height: 1 },
      { id: 's', kind: 'selector', x: 0, y: 0, width: 1, height: 1 },
      { id: 'g', kind: 'group', x: 0, y: 0, width: 1, height: 1 },
    ])).toEqual({ complete: true, missing: [], duplicate: [], unexpected: [] })
    expect(validateLifecycleGeometry({ nodeIds: ['n'], rerouteIds: ['r'] }, [
      { id: 'n', kind: 'node', x: 0, y: 0, width: 1, height: 1 },
      { id: 'n', kind: 'node', x: 1, y: 1, width: 1, height: 1 },
      { id: 'x', kind: 'selector', x: 0, y: 0, width: 1, height: 1 },
    ])).toEqual({
      complete: false,
      missing: [{ kind: 'reroute', id: 'r' }],
      duplicate: [{ kind: 'node', id: 'n' }],
      unexpected: [{ kind: 'selector', id: 'x' }],
    })
  })

  it('validates parent occurrence and body geometry in separate graph scopes', () => {
    const occurrence = { id: 'same', kind: 'node' as const, x: 0, y: 0, width: 20, height: 10 }
    const body = [{ id: 'same', kind: 'node' as const, x: 5, y: 5, width: 10, height: 10 }]
    expect(validateFlattenGeometry(occurrence, { nodeIds: ['same'] }, body)).toEqual({
      complete: true, missing: [], duplicate: [], unexpected: [],
    })
    expect(validateFlattenGeometry(undefined, { nodeIds: ['same'] }, body)).toEqual({
      complete: false,
      missing: [{ kind: 'node', id: 'occurrence' }],
      duplicate: [],
      unexpected: [],
    })
    expect(planFlattenedGeometry(items, { x: 500, y: 300 })?.bounds).toEqual({
      x: 400, y: 250, width: 200, height: 100,
    })
  })
})
