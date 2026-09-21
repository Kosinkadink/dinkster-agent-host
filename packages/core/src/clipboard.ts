import { boundaryBindingKey, resolveDynamicAddress, type BoundaryRouteLeg, type GraphDef, type GraphViewState, type Json, type LinkData, type NodeData, type OccurrenceTopology, type ParentDeliveryIdentity, type WorkflowDocument } from './format/document.js'
import { validateClipboardRecords, validateDocumentShape, validateGraphDefShape, validateGraphViewShape, validateOccurrenceTopologyShape } from './format/validate.js'
import { groupAllocationFloor } from './group-alloc.js'
import { actorCursorOf, formatAllocatedId, isPortEndpoint, isRerouteRef, isValidActorId, isWidgetTapRef, occurrenceKey, sameOccurrenceRef, samePortRef, type LinkEndpoint, type OccurrenceRef, type PortRef } from './ids.js'
import { graphAllocator } from './commands/alloc.js'
import type { CommandDefinition, CommandInvocation, TransactionBuilder } from './commands/contract.js'
import { diag, type Diagnostic } from './diagnostics.js'
import { NET_VIEWS_EXT_KEY, netViewKey, netViewPositions, netViewToJson, parseNetViewPosition, updateNetViewPositions, type NetViewPosition } from './format/net-views.js'
import { subgraphDefIdOf } from './invariants.js'
import { canonicalJson } from './compile/hash.js'
import { matchBoundaryItem } from './compile/crossing.js'

export interface DinksterClipboardEnvelope {
  readonly format: 'dinkster-clipboard'
  readonly version: 1 | 2 | 3 | 4 | 5
  readonly nodes: readonly { readonly data: Json; readonly view: Json }[]
  readonly links: readonly Json[]
  readonly reroutes: readonly { readonly data: Json; readonly view: Json }[]
  readonly groups: readonly Json[]
  /** Versions 2+. Version 1 readers remain accepted and have no stubs. */
  readonly externalIncoming?: readonly ExternalIncomingStub[]
  readonly scope?: { readonly lineage: string; readonly graph: string; readonly token: string }
  /** Versions 3+. Closed occurrence-owner topology subtrees. */
  readonly occurrenceTopologies?: readonly Json[]
  /** Versions 4+. Named-net membership of the copied nodes. */
  readonly nets?: readonly Json[]
  /** Version 5 only. Complete transitive subgraph-definition closure. */
  readonly definitions?: {
    readonly graphs: Readonly<Record<string, Json>>
    readonly view: Readonly<Record<string, Json>>
    readonly netViews?: readonly Json[]
  }
}

/**
 * One copied net's membership: the sinks restrict to copied nodes at
 * serialize time, and `source.nodeType` lets paste decide whether a
 * same-name net in the destination graph is compatible without schema
 * access. `source.node` may name a node OUTSIDE the copy (sink-only copy);
 * paste then merges into the destination's same-name net when that net's
 * source has the same node type, port, and member path.
 *
 * `view` carries a manually placed tag's offset from its owning node's
 * top-left, so pasted tags keep their authored placement relative to the
 * pasted nodes.
 */
export interface ClipboardNetRecord {
  readonly name: string
  readonly source: {
    readonly node: string
    readonly port: string
    readonly members?: readonly string[]
    readonly nodeType: string
    readonly view?: { readonly x: number; readonly y: number }
  }
  readonly sinks: readonly {
    readonly node: string
    readonly port: string
    readonly members?: readonly string[]
    readonly view?: { readonly x: number; readonly y: number }
  }[]
}

export interface ExternalIncomingStub {
  readonly source: {
    readonly graph: string
    readonly lineage: string
    readonly node: string
    readonly nodeType: string
    readonly port: string
    readonly members?: readonly string[]
    readonly tap?: never
  } | {
    readonly graph: string
    readonly lineage: string
    readonly node: string
    readonly nodeType: string
    readonly tap: string
    readonly port?: never
    readonly members?: never
  }
  readonly target: {
    readonly node: string
    readonly nodeType: string
    readonly port: string
    readonly members?: readonly string[]
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function validEndpoint(value: unknown): value is LinkEndpoint {
  if (!object(value)) return false
  if (typeof value.reroute === 'string') return true
  if (typeof value.node !== 'string') return false
  if (typeof value.tap === 'string') return true
  return typeof value.port === 'string' &&
    (value.members === undefined || (Array.isArray(value.members) && value.members.length > 0 && value.members.every((member) => typeof member === 'string' && member.length > 0)))
}

const validMembers = (value: unknown): value is readonly string[] | undefined =>
  value === undefined || (Array.isArray(value) && value.length > 0 && value.every((member) => typeof member === 'string' && member.length > 0))

function validStub(value: unknown): value is ExternalIncomingStub {
  if (!object(value) || !object(value.source) || !object(value.target)) return false
  const portSource = typeof value.source.port === 'string' && value.source.tap === undefined && validMembers(value.source.members)
  const tapSource = typeof value.source.tap === 'string' && value.source.port === undefined && value.source.members === undefined
  return typeof value.source.graph === 'string' && typeof value.source.node === 'string' &&
    typeof value.source.lineage === 'string' && typeof value.source.nodeType === 'string' &&
    (portSource || tapSource) &&
    typeof value.target.node === 'string' && typeof value.target.nodeType === 'string' &&
    typeof value.target.port === 'string' && validMembers(value.target.members)
}

function validPositionedView(value: unknown): value is Record<string, unknown> {
  return object(value) && object(value.position) && finite(value.position.x) && finite(value.position.y)
}

const validNetEndpoint = (value: unknown): value is { node: string; port: string; members?: readonly string[] } =>
  object(value) && typeof value.node === 'string' && value.node.length > 0 &&
  typeof value.port === 'string' && value.port.length > 0 && validMembers(value.members) &&
  (value.view === undefined || (object(value.view) && finite(value.view.x) && finite(value.view.y)))

function validNetRecord(value: unknown): value is ClipboardNetRecord {
  if (!object(value) || typeof value.name !== 'string' || value.name.trim().length === 0) return false
  if (!validNetEndpoint(value.source)) return false
  const nodeType = (value.source as Record<string, unknown>).nodeType
  if (typeof nodeType !== 'string' || nodeType.length === 0) return false
  if (!Array.isArray(value.sinks) || !value.sinks.every(validNetEndpoint)) return false
  // A net never feeds its own source node (net.connectInput's self-loop
  // rule); a sink on the source node would materialize a state the
  // commands can never produce.
  return value.sinks.every((sink) => sink.node !== (value.source as { node: string }).node)
}

const netRecordsOf = (envelope: DinksterClipboardEnvelope): readonly ClipboardNetRecord[] =>
  (envelope.nets ?? []).map((raw) => raw as unknown as ClipboardNetRecord)

type ClipboardDefinitionClosure = NonNullable<DinksterClipboardEnvelope['definitions']>

function definitionOrder(
  graphs: Readonly<Record<string, GraphDef>>,
  roots: readonly string[],
): readonly string[] | undefined {
  const state = new Map<string, 'visiting' | 'visited'>()
  const order: string[] = []
  for (const root of roots) {
    const stack: { id: string; exit: boolean }[] = [{ id: root, exit: false }]
    while (stack.length > 0) {
      const frame = stack.pop()!
      const current = state.get(frame.id)
      if (frame.exit) {
        if (current === 'visiting') {
          state.set(frame.id, 'visited')
          order.push(frame.id)
        }
        continue
      }
      if (current === 'visited') continue
      if (current === 'visiting') return undefined
      const graph = Object.hasOwn(graphs, frame.id) ? graphs[frame.id] : undefined
      if (graph === undefined) return undefined
      state.set(frame.id, 'visiting')
      stack.push({ id: frame.id, exit: true })
      const children = Object.values(graph.nodes).flatMap((node) => {
        const child = subgraphDefIdOf(node.type)
        return child === undefined ? [] : [child]
      })
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({ id: children[index]!, exit: false })
    }
  }
  return order
}

function normalizeDefinitionClosure(
  value: unknown,
  nodes: readonly { readonly data: Json }[],
): ClipboardDefinitionClosure | undefined {
  if (!object(value) || !object(value.graphs) || !object(value.view)) return undefined
  const graphEntries = Object.entries(value.graphs)
  const viewEntries = Object.entries(value.view)
  if (graphEntries.length === 0 || graphEntries.length !== viewEntries.length) return undefined

  const graphs: Record<string, Json> = {}
  const view: Record<string, Json> = {}
  for (const [id, raw] of graphEntries) {
    if (id === '__proto__' || !object(raw) || raw.id !== id || validateGraphDefShape(raw, `definitions.graphs.${id}`).length > 0)
      return undefined
    if (!Object.hasOwn(value.view, id)) return undefined
    const rawView = value.view[id]
    if (rawView === undefined || validateGraphViewShape(rawView, `definitions.view.${id}`).length > 0) return undefined
    graphs[id] = raw as Json
    view[id] = rawView as Json
  }
  if (viewEntries.some(([id]) => !Object.hasOwn(graphs, id))) return undefined

  // The payload must contain exactly the definitions reached from copied
  // instances. Missing dependencies would paste unresolved instances, while
  // extras would let unrelated document content ride along invisibly.
  const roots = nodes.flatMap((item) => {
    const data = item.data as unknown as { readonly type: string }
    const root = subgraphDefIdOf(data.type)
    return root === undefined ? [] : [root]
  })
  const typedGraphs = graphs as unknown as Readonly<Record<string, GraphDef>>
  const order = definitionOrder(typedGraphs, roots)
  if (order === undefined || order.length !== graphEntries.length) return undefined
  const netViews: Json[] = []
  const netViewKeys = new Set<string>()
  if (value.netViews !== undefined) {
    if (!Array.isArray(value.netViews)) return undefined
    for (const raw of value.netViews) {
      const parsed = parseNetViewPosition(raw as Json)
      if (parsed === undefined || !Object.hasOwn(typedGraphs, parsed.graphId)) return undefined
      const net = typedGraphs[parsed.graphId]!.nets[parsed.netId]
      if (net === undefined || parsed.role === 'sink' && !net.sinks.some((sink) => samePortRef(sink, parsed.to))) return undefined
      const key = netViewKey(parsed)
      if (netViewKeys.has(key)) return undefined
      netViewKeys.add(key)
      netViews.push(netViewToJson(parsed))
    }
  }
  return { graphs, view, ...(netViews.length > 0 ? { netViews } : {}) }
}

function definitionOccurrenceReferencesClosed(
  definitions: ClipboardDefinitionClosure,
  topologies: readonly Json[],
  sourceGraphId: string,
  copiedNodes: readonly { readonly data: Json }[],
  copiedLinks: readonly Json[],
  copiedLinkIds: ReadonlySet<string>,
): boolean {
  const graphs = definitions.graphs as unknown as Readonly<Record<string, GraphDef>>
  const graphOf = (id: string): GraphDef | undefined => Object.hasOwn(graphs, id) ? graphs[id] : undefined
  const sourceNodes = new Map(copiedNodes.map((item) => {
    const node = item.data as unknown as NodeData
    return [node.id, node]
  }))
  const sourceLinks = new Map(copiedLinks.map((raw) => {
    const link = raw as unknown as LinkData
    return [link.id, link]
  }))
  type Hop = {
    readonly ref: OccurrenceRef
    readonly parentGraphId: string
    readonly bodyGraphId: string
    readonly node: NodeData
  }
  const chainOf = (owner: OccurrenceRef): readonly Hop[] | undefined => {
    const segments = [...owner.instancePath, owner.node]
    const chain: Hop[] = []
    let parentGraphId = sourceGraphId
    for (let index = 0; index < segments.length; index++) {
      const node = parentGraphId === sourceGraphId
        ? sourceNodes.get(segments[index]!)
        : graphOf(parentGraphId)?.nodes[segments[index]!]
      const bodyGraphId = node === undefined ? undefined : subgraphDefIdOf(node.type)
      if (node === undefined || bodyGraphId === undefined || graphOf(bodyGraphId) === undefined) return undefined
      chain.push({
        ref: { instancePath: segments.slice(0, index), node: segments[index]! },
        parentGraphId,
        bodyGraphId,
        node,
      })
      parentGraphId = bodyGraphId
    }
    return chain
  }
  const routeMatches = (
    chain: readonly Hop[],
    startIndex: number,
    side: 'from' | 'to',
    initialAddress: PortRef,
    route: readonly BoundaryRouteLeg[],
  ): boolean => {
    if (route.length !== chain.length - startIndex) return false
    let address = initialAddress
    for (let offset = 0; offset < route.length; offset++) {
      const hop = chain[startIndex + offset]!
      const graph = graphOf(hop.bodyGraphId)!
      const leg = route[offset]!
      if (leg.graph !== graph.id) return false
      const items = side === 'from' ? graph.boundary?.outputs : graph.boundary?.inputs
      const match = matchBoundaryItem(items ?? [], address)
      if (!match.ok || match.item.id !== leg.boundaryId) return false
      if (match.item.binds.kind === 'family' &&
          resolveDynamicAddress(address, hop.node.dynamic).kind !== 'resolved') return false
      const matchingBindings = [match.item.binds, ...(match.item.alsoBinds ?? [])].filter((binding) =>
        boundaryBindingKey(binding) === boundaryBindingKey(leg.binding))
      if (matchingBindings.length !== 1) return false
      const binding = matchingBindings[0]!
      const targetNode = graph.nodes[binding.node]
      if (targetNode === undefined ||
          binding.kind !== 'widgetTap' && resolveDynamicAddress(binding, targetNode.dynamic).kind === 'missing') return false
      if (offset + 1 < route.length) {
        const nextHop = chain[startIndex + offset + 1]!
        if (binding.kind === 'widgetTap' || binding.node !== nextHop.ref.node) return false
        address = { node: binding.node, port: binding.port, ...(binding.members ? { members: binding.members } : {}) }
      }
    }
    return true
  }
  const deliveryEndpoints = (
    delivery: ParentDeliveryIdentity,
  ): readonly { readonly side: 'from' | 'to'; readonly endpoint: PortRef }[] | undefined => {
    const graph = delivery.graph === sourceGraphId ? undefined : graphOf(delivery.graph)
    if (delivery.kind === 'link') {
      const link = graph === undefined
        ? copiedLinkIds.has(delivery.linkId) ? sourceLinks.get(delivery.linkId) : undefined
        : graph.links[delivery.linkId]
      if (link === undefined) return undefined
      const endpoints: { side: 'from' | 'to'; endpoint: PortRef }[] = []
      if (isPortEndpoint(link.from)) endpoints.push({ side: 'from', endpoint: link.from })
      if (isPortEndpoint(link.to)) endpoints.push({ side: 'to', endpoint: link.to })
      return endpoints
    }
    if (graph === undefined) return undefined
    const net = graph.nets[delivery.netId]
    if (net === undefined || !net.sinks.some((sink) => samePortRef(sink, delivery.to))) return undefined
    return [
      { side: 'from', endpoint: net.source },
      { side: 'to', endpoint: delivery.to },
    ]
  }
  return topologies.every((raw) => {
    const topology = raw as unknown as OccurrenceTopology
    const chain = chainOf(topology.owner)
    if (chain === undefined || chain.at(-1)?.bodyGraphId !== topology.bodyGraph) return false
    const body = graphOf(topology.bodyGraph)
    if (body === undefined) return false
    for (const link of Object.values(topology.links)) {
      for (const [side, endpoint] of [['from', link.from], ['to', link.to]] as const) {
        if (endpoint.kind !== 'boundary') continue
        const startIndex = chain.findIndex((hop) => sameOccurrenceRef(hop.ref, endpoint.occurrence))
        if (startIndex < 0 || !routeMatches(
          chain,
          startIndex,
          side,
          { node: endpoint.occurrence.node, ...endpoint.address },
          endpoint.route,
        )) return false
      }
    }
    for (const suppression of topology.suppressedDeliveries ?? []) {
      if (suppression.kind === 'netSink') {
        const net = body.nets[suppression.netId]
        if (net === undefined || !net.sinks.some((sink) => samePortRef(sink, suppression.to))) return false
      } else if (suppression.kind === 'projectedLeg') {
        const matches = deliveryEndpoints(suppression.delivery)?.filter(({ side, endpoint }) => {
          const startIndex = chain.findIndex((hop) =>
            hop.parentGraphId === suppression.delivery.graph && hop.ref.node === endpoint.node)
          return startIndex >= 0 && routeMatches(chain, startIndex, side, endpoint, suppression.route)
        }) ?? []
        if (matches.length !== 1) return false
      }
    }
    return true
  })
}

function normalizeEnvelope(value: unknown): DinksterClipboardEnvelope | undefined {
  if (!isDinksterClipboardEnvelope(value)) return undefined
  const nodes: { data: Json; view: Json }[] = []
  const links: Json[] = []
  const reroutes: { data: Json; view: Json }[] = []
  const groups: Json[] = []
  const externalIncoming: ExternalIncomingStub[] = []
  const occurrenceTopologies: Json[] = []

  // Duplicate source ids would silently rewire topology at materialize
  // time (the later record steals every link naming the shared id), so a
  // duplicated id rejects the envelope up front.
  const nodeIds = new Set<string>()
  const rerouteIds = new Set<string>()
  const linkIds = new Set<string>()
  for (const item of value.nodes) {
    if (!object(item) || !object(item.data) || typeof item.data.id !== 'string' ||
      typeof item.data.type !== 'string' || !object(item.data.values) || !validPositionedView(item.view)) return undefined
    if (nodeIds.has(item.data.id)) return undefined
    nodeIds.add(item.data.id)
    nodes.push({ data: item.data as Json, view: item.view as Json })
  }
  for (const raw of value.links) {
    if (!object(raw) || typeof raw.id !== 'string' || !validEndpoint(raw.from) || !validEndpoint(raw.to)) return undefined
    if (linkIds.has(raw.id)) return undefined
    linkIds.add(raw.id)
    links.push({
      ...raw,
      from: { ...(raw.from as unknown as Record<string, Json>) },
      to: { ...(raw.to as unknown as Record<string, Json>) },
    } as Json)
  }
  for (const item of value.reroutes) {
    if (!object(item) || !object(item.data) || typeof item.data.id !== 'string' || !validPositionedView(item.view)) return undefined
    if (rerouteIds.has(item.data.id)) return undefined
    rerouteIds.add(item.data.id)
    reroutes.push({ data: item.data as Json, view: item.view as Json })
  }
  for (const raw of value.groups) {
    if (!object(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !object(raw.bounds) ||
      !finite(raw.bounds.x) || !finite(raw.bounds.y) || !finite(raw.bounds.width) || !finite(raw.bounds.height)) return undefined
    groups.push(raw as Json)
  }
  if (value.version >= 2) {
    if (!Array.isArray(value.externalIncoming) || !value.externalIncoming.every(validStub) || !object(value.scope) ||
      typeof value.scope.lineage !== 'string' || typeof value.scope.graph !== 'string' || typeof value.scope.token !== 'string') return undefined
    externalIncoming.push(...value.externalIncoming)
  }
  const hasOccurrences = value.version === 3 ||
    ((value.version === 4 || value.version === 5) && value.occurrenceTopologies !== undefined)
  if (hasOccurrences) {
    if (!Array.isArray(value.occurrenceTopologies) ||
        !value.occurrenceTopologies.every((topology) => validateOccurrenceTopologyShape(topology).length === 0)) return undefined
    const owners = value.occurrenceTopologies.map((topology) => occurrenceKey((topology as unknown as OccurrenceTopology).owner))
    if (new Set(owners).size !== owners.length) return undefined
    occurrenceTopologies.push(...value.occurrenceTopologies)
  }
  const nets: Json[] = []
  if (value.version === 4 || value.version === 5) {
    if (!Array.isArray(value.nets) || !value.nets.every(validNetRecord)) return undefined
    // Net names are the user-facing address (unique per graph definition),
    // so a duplicated name would make paste's collision resolution
    // ambiguous; a duplicated sink ref would double-drive one input.
    const names = value.nets.map((record) => record.name.trim().toLowerCase())
    if (new Set(names).size !== names.length) return undefined
    for (const record of value.nets) {
      const refs = record.sinks.map((sink) => JSON.stringify([sink.node, sink.port, sink.members ?? []]))
      if (new Set(refs).size !== refs.length) return undefined
    }
    nets.push(...(value.nets as unknown as Json[]))
  }
  const definitions = value.version === 5
    ? normalizeDefinitionClosure(value.definitions, nodes)
    : undefined
  if (value.version === 5 && definitions === undefined) return undefined
  // Deep per-entity validation with the SAME shape checkers the document
  // loader uses (node mode/controllers/dynamic state, link endpoint
  // discriminators, view fields, group shapes). Without this, a paste
  // could commit fields that validateDocumentShape rejects - a document
  // that saves but never loads again.
  if (validateClipboardRecords({ nodes, links, reroutes, groups }).length > 0) return undefined
  if (value.version === 5 && !definitionOccurrenceReferencesClosed(
    definitions!,
    occurrenceTopologies,
    value.scope!.graph,
    nodes,
    links,
    new Set(links.map((raw) => (raw as unknown as LinkData).id)),
  )) return undefined
  return {
    format: 'dinkster-clipboard', version: value.version, nodes, links, reroutes, groups,
    ...(value.version >= 2 ? { externalIncoming, scope: { ...value.scope! } } : {}),
    ...(hasOccurrences ? { occurrenceTopologies } : {}),
    ...(value.version === 4 || value.version === 5 ? { nets } : {}),
    ...(definitions !== undefined ? { definitions } : {}),
  }
}

export function isDinksterClipboardEnvelope(value: unknown): value is DinksterClipboardEnvelope {
  return object(value) && value.format === 'dinkster-clipboard' &&
    (value.version === 1 || value.version === 2 || value.version === 3 || value.version === 4 || value.version === 5) &&
    Array.isArray(value.nodes) && Array.isArray(value.links) &&
    Array.isArray(value.reroutes) && Array.isArray(value.groups) &&
    (value.version === 1 || (Array.isArray(value.externalIncoming) && object(value.scope))) &&
    (value.version !== 3 || Array.isArray(value.occurrenceTopologies)) &&
    ((value.version !== 4 && value.version !== 5) || (Array.isArray(value.nets) &&
      (value.occurrenceTopologies === undefined || Array.isArray(value.occurrenceTopologies)))) &&
    (value.version !== 5 || object(value.definitions))
}

const endpointIncluded = (endpoint: LinkEndpoint, nodes: ReadonlySet<string>, reroutes: ReadonlySet<string>): boolean =>
  isRerouteRef(endpoint) ? reroutes.has(endpoint.reroute) : (isPortEndpoint(endpoint) || isWidgetTapRef(endpoint)) && nodes.has(endpoint.node)

function definitionClosureOf(
  doc: WorkflowDocument,
  graphId: string,
  nodes: ReadonlySet<string>,
): ClipboardDefinitionClosure | undefined {
  const source = doc.graphs[graphId]
  if (source === undefined) return undefined
  const roots = [...nodes].sort().flatMap((id) => {
    const root = subgraphDefIdOf(source.nodes[id]!.type)
    return root === undefined ? [] : [root]
  })
  const order = definitionOrder(doc.graphs, roots)
  if (order === undefined || order.includes(graphId)) return undefined
  const graphs: Record<string, Json> = {}
  const view: Record<string, Json> = {}
  const reached = new Set(order)
  for (const id of [...order].sort()) {
    graphs[id] = doc.graphs[id] as unknown as Json
    view[id] = (doc.view.graphs[id] ?? { nodes: {} }) as unknown as Json
  }
  const netViews = netViewPositions(doc)
    .filter((entry) => {
      if (!reached.has(entry.graphId)) return false
      const net = doc.graphs[entry.graphId]?.nets[entry.netId]
      return net !== undefined && (entry.role === 'source' || net.sinks.some((sink) => samePortRef(sink, entry.to)))
    })
    .map(netViewToJson)
  return { graphs, view, ...(netViews.length > 0 ? { netViews } : {}) }
}

/** Serialize only self-contained graph topology. Boundary pseudo-nodes are absent from GraphDef.nodes. */
export function serializeSelection(
  doc: WorkflowDocument,
  graphId: string,
  selection: { readonly nodes: Iterable<string>; readonly reroutes: Iterable<string>; readonly groups?: Iterable<string> },
  scopeToken = '',
): DinksterClipboardEnvelope | undefined {
  const graph = doc.graphs[graphId]
  const view = doc.view.graphs[graphId]
  if (!graph || !view) return undefined
  const nodes = new Set([...selection.nodes].filter((id) => graph.nodes[id] !== undefined))
  const reroutes = new Set([...selection.reroutes].filter((id) => graph.reroutes[id] !== undefined))
  const groups = new Set(selection.groups ?? [])
  if (nodes.size === 0 && reroutes.size === 0 && groups.size === 0) return undefined
  const definitions = definitionClosureOf(doc, graphId, nodes)
  if (definitions === undefined) return undefined
  const hasDefinitions = Object.keys(definitions.graphs).length > 0
  const occurrenceTopologies = graphId === doc.root ? Object.values(doc.occurrenceTopologies ?? {}).filter((topology) =>
    topology.owner.instancePath.length === 0
      ? nodes.has(topology.owner.node)
      : nodes.has(topology.owner.instancePath[0]!),
  ) : []
  // Net membership rides along with the copied NODES: a record is included
  // when the copied selection contains the net's source node or at least
  // one sink node, with sinks restricted to copied nodes. Paste resolves
  // collisions per docs/architecture.md section 5 (merge compatible sinks,
  // else deterministic `name_2` rename).
  // Manually placed tag offsets ride along so a pasted tag keeps its
  // placement relative to the pasted node. Absolute (retired) geometry is
  // world coordinates in the source graph and does not transfer.
  const tagOffsets = new Map<string, { x: number; y: number }>()
  for (const entry of netViewPositions(doc, graphId)) {
    if (entry.geometry.kind !== 'offset') continue
    const key = entry.role === 'source'
      ? JSON.stringify([entry.netId, 'source'])
      : JSON.stringify([entry.netId, 'sink', entry.to.node, entry.to.port, entry.to.members ?? []])
    tagOffsets.set(key, { x: entry.geometry.x, y: entry.geometry.y })
  }
  const netEndpoint = (netId: string, ref: PortRef): Json => {
    const view = tagOffsets.get(JSON.stringify([netId, 'sink', ref.node, ref.port, ref.members ?? []]))
    return {
      node: ref.node, port: ref.port,
      ...(ref.members !== undefined ? { members: [...ref.members] } : {}),
      ...(view !== undefined ? { view } : {}),
    }
  }
  const nets = Object.values(graph.nets).flatMap((net): Json[] => {
    const sinks = net.sinks.filter((sink) => nodes.has(sink.node))
    if (!nodes.has(net.source.node) && sinks.length === 0) return []
    const sourceNode = graph.nodes[net.source.node]
    if (!sourceNode) return []
    const sourceView = tagOffsets.get(JSON.stringify([net.id, 'source']))
    return [{
      name: net.name,
      source: {
        node: net.source.node, port: net.source.port,
        ...(net.source.members !== undefined ? { members: [...net.source.members] } : {}),
        nodeType: sourceNode.type,
        ...(sourceView !== undefined ? { view: sourceView } : {}),
      },
      sinks: sinks.map((sink) => netEndpoint(net.id, sink)),
    }]
  })
  return {
    format: 'dinkster-clipboard',
    version: hasDefinitions ? 5 : nets.length > 0 ? 4 : occurrenceTopologies.length > 0 ? 3 : 2,
    nodes: [...nodes].map((id) => ({ data: graph.nodes[id]! as unknown as Json, view: view.nodes[id]! as unknown as Json })),
    links: Object.values(graph.links)
      .filter((link) => endpointIncluded(link.from, nodes, reroutes) && endpointIncluded(link.to, nodes, reroutes))
      .map((link) => link as unknown as Json),
    reroutes: [...reroutes].map((id) => ({ data: graph.reroutes[id]! as unknown as Json, view: view.reroutes?.[id]! as unknown as Json })),
    groups: [...groups].flatMap((id) => view.groups?.[id] ? [view.groups[id] as unknown as Json] : []),
    scope: { lineage: doc.lineage, graph: graphId, token: scopeToken },
    externalIncoming: Object.values(graph.links).flatMap((link): ExternalIncomingStub[] => {
      if ((!isPortEndpoint(link.from) && !isWidgetTapRef(link.from)) || !isPortEndpoint(link.to) ||
        !nodes.has(link.to.node) || nodes.has(link.from.node)) return []
      const source = graph.nodes[link.from.node]
      const target = graph.nodes[link.to.node]
      if (!source || !target) return []
      return [{
        source: {
          graph: graphId, lineage: doc.lineage, node: link.from.node, nodeType: source.type,
          ...(isWidgetTapRef(link.from)
            ? { tap: link.from.tap }
            : { port: link.from.port, ...(link.from.members !== undefined ? { members: [...link.from.members] } : {}) }),
        },
        target: {
          node: link.to.node, nodeType: target.type, port: link.to.port,
          ...(link.to.members !== undefined ? { members: [...link.to.members] } : {}),
        },
      }]
    }),
    ...(occurrenceTopologies.length > 0 ? { occurrenceTopologies: occurrenceTopologies as unknown as readonly Json[] } : {}),
    ...(nets.length > 0 || hasDefinitions ? { nets } : {}),
    ...(hasDefinitions ? { definitions } : {}),
  }
}

/** Structural identity of member paths (undefined == empty == static). */
const membersEqual = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((member, i) => member === b![i])

interface DefinitionPastePlan {
  readonly ids: ReadonlyMap<string, string>
  readonly retainedOccurrenceOwners?: ReadonlySet<string>
  readonly imports: readonly {
    readonly id: string
    readonly graph: GraphDef
    readonly view: GraphViewState
    readonly netViews: readonly NetViewPosition[]
  }[]
}

const remapNodeType = (type: string, ids: ReadonlyMap<string, string>): string => {
  const source = subgraphDefIdOf(type)
  return source === undefined ? type : `#${ids.get(source) ?? source}`
}

function rewriteDefinition(
  graph: GraphDef,
  id: string,
  ids: ReadonlyMap<string, string>,
): GraphDef {
  return {
    ...graph,
    id: id as GraphDef['id'],
    nodes: Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, node]) => [
      nodeId,
      { ...node, type: remapNodeType(node.type, ids) },
    ])),
  }
}

function planDefinitionPaste(
  doc: WorkflowDocument,
  envelope: DinksterClipboardEnvelope,
): DefinitionPastePlan | undefined {
  const closure = envelope.definitions
  if (closure === undefined) return { ids: new Map(), imports: [] }
  const graphs = closure.graphs as unknown as Readonly<Record<string, GraphDef>>
  const views = closure.view as unknown as Readonly<Record<string, GraphViewState>>
  if (envelope.scope?.lineage === doc.lineage &&
      Object.keys(graphs).every((id) => doc.graphs[id] !== undefined)) {
    const currentGraphs = Object.fromEntries(Object.keys(graphs).map((id) => [id, doc.graphs[id]!]))
    const sourceGraphId = envelope.scope.graph
    const currentClosure = { graphs: currentGraphs as unknown as Readonly<Record<string, Json>>, view: closure.view }
    const retainedOccurrenceOwners = new Set<string>()
    for (const topology of envelope.occurrenceTopologies ?? []) {
      if (definitionOccurrenceReferencesClosed(
        currentClosure,
        [topology],
        sourceGraphId,
        envelope.nodes,
        envelope.links,
        new Set(envelope.links.map((raw) => (raw as unknown as LinkData).id)),
      )) retainedOccurrenceOwners.add(occurrenceKey((topology as unknown as OccurrenceTopology).owner))
    }
    return {
      ids: new Map(Object.keys(graphs).map((id) => [id, id])),
      retainedOccurrenceOwners,
      imports: [],
    }
  }
  const roots = envelope.nodes.flatMap((item) => {
    const root = subgraphDefIdOf((item.data as unknown as { readonly type: string }).type)
    return root === undefined ? [] : [root]
  })
  const order = definitionOrder(graphs, roots)
  if (order === undefined) return undefined

  const closureNetViews = (closure.netViews ?? []).map((raw) => parseNetViewPosition(raw)!)
  const comparableNetViews = (entries: readonly NetViewPosition[]): Json => entries
    .map(netViewToJson)
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) as Json

  const reserved = new Set([...Object.keys(doc.graphs), ...Object.keys(graphs)])
  let nextGraphOrdinal = 0
  const freshId = (): string | undefined => {
    while (nextGraphOrdinal <= reserved.size) {
      const id = `g${nextGraphOrdinal++}`
      if (reserved.has(id)) continue
      reserved.add(id)
      return id
    }
    return undefined
  }
  const ids = new Map<string, string>()
  const imports: { id: string; graph: GraphDef; view: GraphViewState; netViews: readonly NetViewPosition[] }[] = []
  for (const sourceId of order) {
    const source = graphs[sourceId]!
    const sourceView = views[sourceId]!
    const sourceNetViews = closureNetViews.filter((entry) => entry.graphId === sourceId)
    const atSourceId = rewriteDefinition(source, sourceId, ids)
    const existing = doc.graphs[sourceId]
    if (existing !== undefined && canonicalJson(existing) === canonicalJson(atSourceId) &&
        canonicalJson(doc.view.graphs[sourceId] ?? { nodes: {} }) === canonicalJson(sourceView) &&
        canonicalJson(comparableNetViews(netViewPositions(doc, sourceId))) === canonicalJson(comparableNetViews(sourceNetViews))) {
      ids.set(sourceId, sourceId)
      continue
    }
    const id = existing === undefined ? sourceId : freshId()
    if (id === undefined) return undefined
    ids.set(sourceId, id)
    imports.push({
      id,
      graph: rewriteDefinition(source, id, ids),
      view: sourceView,
      netViews: sourceNetViews.map((entry) => ({ ...entry, graphId: id })),
    })
  }
  return { ids, imports }
}

const occurrenceTopologiesForPaste = (
  envelope: DinksterClipboardEnvelope,
  definitions: DefinitionPastePlan,
): readonly Json[] => (envelope.occurrenceTopologies ?? []).filter((raw) =>
  definitions.retainedOccurrenceOwners === undefined ||
  definitions.retainedOccurrenceOwners.has(occurrenceKey((raw as unknown as OccurrenceTopology).owner)),
)

type NetPasteAction =
  | { readonly kind: 'create'; readonly record: ClipboardNetRecord; readonly name: string; readonly sourceCopied: boolean }
  | { readonly kind: 'merge'; readonly record: ClipboardNetRecord; readonly netId: string }
  | { readonly kind: 'skip' }

/**
 * Decide each copied net record's paste outcome against the destination
 * graph. Deterministic and side-effect free so planClipboardPaste (ordinal
 * exhaustion counting) and materialize (the actual commit) agree exactly:
 *
 * - Source node copied: always create a net (an independently-sourced
 *   name collision auto-renames with the first free `name_2`, `name_3`, ...
 *   suffix, case-insensitive per docs/architecture.md).
 * - Sink-only copy: merge the copied sinks into the destination's same-name
 *   net when that net's source is compatible (same node type, port, and
 *   member path). Otherwise recreate from the recorded source when it still
 *   resolves in this graph (auto-renamed on a name collision); when it does
 *   not resolve, the membership is dropped and the nodes paste unconnected.
 */
function resolveNetPastes(
  graph: GraphDef,
  envelope: DinksterClipboardEnvelope,
  copiedNodeIds: ReadonlySet<string>,
  definitionIds: ReadonlyMap<string, string> = new Map(),
): readonly NetPasteAction[] {
  const records = netRecordsOf(envelope)
  if (records.length === 0) return []
  const taken = new Set(Object.values(graph.nets).map((net) => net.name.toLowerCase()))
  const freeName = (base: string): string => {
    let name = base
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`
    taken.add(name.toLowerCase())
    return name
  }
  return records.map((record): NetPasteAction => {
    const base = record.name.trim()
    const sourceNodeType = remapNodeType(record.source.nodeType, definitionIds)
    const sinks = record.sinks.filter((sink) => copiedNodeIds.has(sink.node))
    const sourceCopied = copiedNodeIds.has(record.source.node)
    if (!sourceCopied && sinks.length === 0) return { kind: 'skip' }
    if (sourceCopied) return { kind: 'create', record, name: freeName(base), sourceCopied: true }
    const existing = Object.values(graph.nets).find((net) => net.name.toLowerCase() === base.toLowerCase())
    if (existing !== undefined) {
      const existingSourceNode = graph.nodes[existing.source.node]
      const compatible = existingSourceNode !== undefined &&
        existingSourceNode.type === sourceNodeType &&
        existing.source.port === record.source.port &&
        membersEqual(existing.source.members, record.source.members)
      if (compatible) return { kind: 'merge', record, netId: existing.id }
    }
    const recordedSource = graph.nodes[record.source.node]
    if (recordedSource !== undefined && recordedSource.type === sourceNodeType) {
      return { kind: 'create', record, name: freeName(base), sourceCopied: false }
    }
    return { kind: 'skip' }
  })
}

const addressKey = (node: string, port: string, members: readonly string[] | undefined): string =>
  JSON.stringify([node, port, members ?? []])

/**
 * Validate v2 incoming stubs against the current graph without materializing
 * or repairing anything. A reused node id with another type, a missing
 * dynamic member, a cross-graph source, or an ambiguous target is skipped.
 */
function validExternalIncoming(
  doc: WorkflowDocument,
  graphId: string,
  envelope: DinksterClipboardEnvelope,
  accept?: (stub: ExternalIncomingStub) => boolean,
): readonly ExternalIncomingStub[] {
  if (envelope.version < 2) return []
  const graph = doc.graphs[graphId]
  if (!graph) return []
  const copied = new Map(envelope.nodes.map((item) => {
    const data = item.data as Record<string, Json>
    return [data.id as string, data]
  }))
  const counts = new Map<string, number>()
  const occupied = new Set<string>()
  for (const raw of envelope.links) {
    const link = raw as unknown as LinkData
    if (isPortEndpoint(link.to) && copied.has(link.to.node)) occupied.add(addressKey(link.to.node, link.to.port, link.to.members))
  }
  for (const stub of envelope.externalIncoming ?? []) {
    const key = addressKey(stub.target.node, stub.target.port, stub.target.members)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return (envelope.externalIncoming ?? []).filter((stub) => {
    const targetKey = addressKey(stub.target.node, stub.target.port, stub.target.members)
    if (stub.source.graph !== graphId || stub.source.lineage !== doc.lineage || envelope.scope?.lineage !== doc.lineage ||
      envelope.scope.graph !== graphId || copied.has(stub.source.node) || occupied.has(targetKey) || accept?.(stub) === false) return false
    const source = graph.nodes[stub.source.node]
    const target = copied.get(stub.target.node)
    if (!source || source.type !== stub.source.nodeType || !target || target.type !== stub.target.nodeType) return false
    if (counts.get(targetKey) !== 1) return false
    const tapSource = 'tap' in stub.source
    const sourceAddress = tapSource ? undefined : resolveDynamicAddress(stub.source, source.dynamic)
    const targetAddress = resolveDynamicAddress(stub.target, target.dynamic as GraphDef['nodes'][string]['dynamic'])
    return (tapSource || sourceAddress?.kind !== 'missing') && targetAddress.kind !== 'missing' &&
      (tapSource || stub.source.members === undefined || sourceAddress?.kind === 'resolved') &&
      (stub.target.members === undefined || targetAddress.kind === 'resolved')
  })
}

function positionOf(value: unknown): { x: number; y: number } | undefined {
  if (!object(value) || !object(value.position) || typeof value.position.x !== 'number' || typeof value.position.y !== 'number') return undefined
  return { x: value.position.x, y: value.position.y }
}

export interface ClipboardPastePlan {
  readonly invocation: CommandInvocation
  readonly nodeIds: readonly string[]
  readonly rerouteIds: readonly string[]
}

/**
 * Build a deterministic one-command paste and predict its fresh IDs for
 * post-paste selection. `actor` is the shared-session allocation scope: when
 * set, predicted ids are actor-suffixed and allocated from that actor's
 * cursor, and the returned invocation carries the actor so dispatch mints
 * exactly the predicted ids. Absent = solo allocation, unchanged.
 */
export function planClipboardPaste(
  doc: WorkflowDocument,
  graphId: string,
  envelope: DinksterClipboardEnvelope,
  anchor?: { readonly x: number; readonly y: number },
  actor?: string,
  connectInputs = false,
  acceptExternal?: (stub: ExternalIncomingStub) => boolean,
): ClipboardPastePlan | undefined {
  const graph = doc.graphs[graphId]
  const normalized = normalizeEnvelope(envelope)
  if (!graph || !normalized || (normalized.nodes.length === 0 && normalized.reroutes.length === 0 && normalized.groups.length === 0)) return undefined
  const definitionPlan = planDefinitionPaste(doc, normalized)
  if (definitionPlan === undefined) return undefined
  // A returned plan must be dispatchable: an invalid actor id would be an
  // atomic dispatch rejection (command.actor.invalid).
  if (actor !== undefined && !isValidActorId(actor)) return undefined
  // A non-finite anchor would make dx/dy non-finite and the plan
  // undispatchable (the command rejects non-finite offsets).
  if (anchor && (!finite(anchor.x) || !finite(anchor.y))) return undefined
  const positions = [
    ...normalized.nodes.map((item) => positionOf(item.view)),
    ...normalized.reroutes.map((item) => positionOf(item.view)),
  ].filter((p): p is { x: number; y: number } => p !== undefined)
  const minX = positions.length ? Math.min(...positions.map((p) => p.x)) : 0
  const minY = positions.length ? Math.min(...positions.map((p) => p.y)) : 0
  const dx = anchor ? anchor.x - minX : 20
  const dy = anchor ? anchor.y - minY : 20
  // Finite inputs are not enough: MAX_VALUE - (-MAX_VALUE) overflows to
  // Infinity, and a finite offset can still overflow ANOTHER record's
  // translated coordinate. A returned plan must be dispatchable, so refuse
  // any paste whose offset or translated geometry leaves the finite range
  // (the command's shape backstop would reject it atomically anyway).
  if (!finite(dx) || !finite(dy)) return undefined
  const translates = (p: { x: number; y: number }): boolean => finite(p.x + dx) && finite(p.y + dy)
  for (const p of positions) if (!translates(p)) return undefined
  for (const raw of normalized.groups) {
    const b = (raw as Record<string, Json>).bounds as { x: number; y: number }
    if (!translates(b)) return undefined
  }
  // Exhaustion (CO7): predicted ids must match what dispatch would mint,
  // and a returned plan must be dispatchable. Count EVERY nextOrdinal
  // allocation the paste will make - nodes, reroutes, retained links (both
  // endpoints survive remapping onto copied items) - so the planner and
  // materialize agree at the exhaustion boundary. Groups are counted
  // separately below against THEIR cursor (groupSeq, FR1).
  const nodeIdsSrc = new Set(normalized.nodes.map((i) => (i.data as Record<string, Json>).id as string))
  const rerouteIdsSrc = new Set(normalized.reroutes.map((i) => (i.data as Record<string, Json>).id as string))
  const survives = (e: LinkEndpoint): boolean =>
    isRerouteRef(e)
      ? rerouteIdsSrc.has(e.reroute)
      : isWidgetTapRef(e) || isPortEndpoint(e)
        ? nodeIdsSrc.has(e.node)
        : false
  const retainedLinks = normalized.links.filter((raw) => {
    const link = raw as unknown as LinkData
    return survives(link.from) && survives(link.to)
  })
  const occurrenceTopologies = occurrenceTopologiesForPaste(normalized, definitionPlan)
  if (occurrenceTopologies.length > 0) {
    if (graphId !== doc.root) return undefined
    const retainedLinkIds = new Set(retainedLinks.map((raw) => (raw as unknown as LinkData).id))
    const occurrenceClosed = (ref: OccurrenceRef): boolean => ref.instancePath.length === 0
      ? nodeIdsSrc.has(ref.node)
      : nodeIdsSrc.has(ref.instancePath[0]!)
    for (const raw of occurrenceTopologies) {
      const topology = raw as unknown as OccurrenceTopology
      if (!occurrenceClosed(topology.owner)) return undefined
      for (const link of Object.values(topology.links)) {
        if (link.from.kind === 'boundary' && !occurrenceClosed(link.from.occurrence) ||
            link.to.kind === 'boundary' && !occurrenceClosed(link.to.occurrence)) return undefined
      }
      for (const suppression of topology.suppressedDeliveries ?? []) {
        if (suppression.kind !== 'projectedLeg') continue
        if (normalized.version === 5 && suppression.delivery.graph !== normalized.scope?.graph) continue
        if (suppression.delivery.kind !== 'link' || suppression.delivery.graph !== normalized.scope?.graph ||
            !retainedLinkIds.has(suppression.delivery.linkId)) return undefined
      }
    }
  }
  let ordinal = actor === undefined ? graph.nextOrdinal : actorCursorOf(graph.actorCursors, actor)
  const incoming = connectInputs ? validExternalIncoming(doc, graphId, normalized, acceptExternal) : []
  // Created nets mint from the same cursor (after nodes, reroutes, and
  // links, so the predicted node/reroute ids are unaffected); merges and
  // dropped memberships mint nothing.
  const createdNets = resolveNetPastes(graph, normalized, nodeIdsSrc, definitionPlan.ids).filter((action) => action.kind === 'create').length
  const count = normalized.nodes.length + normalized.reroutes.length + retainedLinks.length + incoming.length + createdNets
  if (!Number.isSafeInteger(ordinal) || count > Number.MAX_SAFE_INTEGER - ordinal) return undefined
  // Groups allocate from the per-graph group floor, NOT nextOrdinal (FR1):
  // the groups namespace is fed by view.createGroup's groupSeq cursor,
  // which does not consume nextOrdinal, so a nextOrdinal-minted grp<N>
  // could overwrite a live group or remint a removed group's id (silently
  // retargeting a surface binding that still names it). Same floor
  // (group-alloc.ts), same exhaustion boundary as materialize.
  const groupFloor = groupAllocationFloor(doc, graphId)
  if (normalized.groups.length > Number.MAX_SAFE_INTEGER - groupFloor) return undefined
  const nodeIds = normalized.nodes.map(() => formatAllocatedId('n', ordinal++, actor))
  const rerouteIds = normalized.reroutes.map(() => formatAllocatedId('r', ordinal++, actor))
  const pasteEnvelope = connectInputs && normalized.version >= 2
    ? { ...normalized, externalIncoming: incoming }
    : normalized
  const paste = {
      command: 'clipboard.paste',
      params: {
        graphId, envelope: pasteEnvelope, offset: { x: dx, y: dy },
        ...(connectInputs ? { connectInputs: true } : {}),
      } as unknown as Json,
    } as CommandInvocation
  const invocation: CommandInvocation = nodeIds.length > 0
    ? {
        command: 'batch',
        params: {
          invocations: [
            paste,
            ...nodeIds.map((nodeId) => ({ command: 'dynamic.compact', params: { graphId, nodeId } })),
          ],
        } as unknown as Json,
        ...(actor !== undefined ? { actor } : {}),
      }
    : { ...paste, ...(actor !== undefined ? { actor } : {}) }
  return {
    invocation,
    nodeIds,
    rerouteIds,
  }
}

const clipboardPaste: CommandDefinition = {
  id: 'clipboard.paste',
  run(doc, params, tx) {
    if (!object(params) || typeof params.graphId !== 'string' ||
      !object(params.offset) || !finite(params.offset.x) || !finite(params.offset.y))
      return [diag('error', 'command', 'params.invalid', 'clipboard.paste: invalid clipboard envelope')]
    const envelope = normalizeEnvelope(params.envelope)
    if (!envelope)
      return [diag('error', 'command', 'params.invalid', 'clipboard.paste: invalid clipboard envelope')]
    const graph = doc.graphs[params.graphId]
    if (!graph) return [diag('error', 'command', 'graph.missing', `clipboard.paste: unknown graph '${params.graphId}'`)]
    const failures = materialize(
      tx, params.graphId, graph, envelope, params.offset.x, params.offset.y,
      params.connectInputs === true ? validExternalIncoming(doc, params.graphId, envelope) : [],
    )
    if (failures.length > 0) return failures
    // Backstop (defense in depth behind normalizeEnvelope's per-record
    // validation): the staged document must still pass full shape
    // validation, so a paste can never commit a document loadDocument
    // would reject. Error diagnostics reject the dispatch atomically.
    return [...validateDocumentShape(tx.current as unknown)]
  },
}

function materialize(
  tx: TransactionBuilder,
  graphId: string,
  graph: GraphDef,
  envelope: DinksterClipboardEnvelope,
  dx: number,
  dy: number,
  externalIncoming: readonly ExternalIncomingStub[],
): Diagnostic[] {
  const definitions = planDefinitionPaste(tx.current, envelope)
  if (definitions === undefined) {
    return [diag('error', 'command', 'clipboard.definitionIdsExhausted', 'clipboard.paste: no definition id is available')]
  }
  for (const imported of definitions.imports) {
    tx.set(['graphs', imported.id], imported.graph as unknown as Json)
    tx.set(['view', 'graphs', imported.id], imported.view as unknown as Json)
  }
  const importedNetViews = definitions.imports.flatMap((imported) => imported.netViews)
  if (importedNetViews.length > 0) {
    if (tx.current.ext === undefined) tx.set(['ext'], {})
    tx.set(['ext', NET_VIEWS_EXT_KEY], updateNetViewPositions(tx.current, importedNetViews))
  }
  // Allocation scope comes from the invocation (tx.actor), so materialize
  // mints exactly the ids planClipboardPaste predicted for the same actor.
  const alloc = graphAllocator(tx, graphId, graph)
  const nodeMap = new Map<string, string>()
  const rerouteMap = new Map<string, string>()
  const linkMap = new Map<string, string>()
  for (const item of envelope.nodes) {
    const data = item.data as Record<string, Json>
    const view = item.view as Record<string, Json>
    const id = alloc.mint('n')
    nodeMap.set(data.id as string, id)
    const type = data.type as string
    tx.set(['graphs', graphId, 'nodes', id], { ...data, id, type: remapNodeType(type, definitions.ids) } as unknown as Json)
    const p = positionOf(view)!
    tx.set(['view', 'graphs', graphId, 'nodes', id], { ...view, position: { x: p.x + dx, y: p.y + dy } } as unknown as Json)
  }
  if (envelope.reroutes.length && !tx.current.view.graphs[graphId]!.reroutes) tx.set(['view', 'graphs', graphId, 'reroutes'], {})
  for (const item of envelope.reroutes) {
    const data = item.data as Record<string, Json>
    const view = item.view as Record<string, Json>
    const id = alloc.mint('r')
    rerouteMap.set(data.id as string, id)
    tx.set(['graphs', graphId, 'reroutes', id], { ...data, id } as unknown as Json)
    const p = positionOf(view)!
    tx.set(['view', 'graphs', graphId, 'reroutes', id], { ...view, position: { x: p.x + dx, y: p.y + dy } } as unknown as Json)
  }
  const remap = (endpoint: LinkEndpoint): LinkEndpoint | undefined => {
    if (isRerouteRef(endpoint)) return rerouteMap.has(endpoint.reroute) ? { reroute: rerouteMap.get(endpoint.reroute)! } as LinkEndpoint : undefined
    if (isWidgetTapRef(endpoint)) return nodeMap.has(endpoint.node) ? { ...endpoint, node: nodeMap.get(endpoint.node)! } as LinkEndpoint : undefined
    if (!isPortEndpoint(endpoint)) return undefined
    return nodeMap.has(endpoint.node) ? { ...endpoint, node: nodeMap.get(endpoint.node)! } as LinkEndpoint : undefined
  }
  // Inputs the pasted links drive: a net sink landing on the same input
  // would violate the one-driver invariant, so those sinks drop (the link
  // wins - a consistent source document never carries both, this only
  // guards hand-crafted envelopes).
  const drivenInputs = new Set<string>()
  for (const raw of envelope.links) {
    const link = raw as unknown as LinkData
    const from = remap(link.from), to = remap(link.to)
    if (!from || !to) continue
    const id = alloc.mint('l')
    linkMap.set(link.id, id)
    if (isPortEndpoint(to)) drivenInputs.add(addressKey(to.node, to.port, to.members))
    tx.set(['graphs', graphId, 'links', id], { ...link, id, from, to } as unknown as Json)
  }
  for (const stub of externalIncoming) {
    const target = nodeMap.get(stub.target.node)
    if (!target) continue
    const id = alloc.mint('l')
    const from = 'tap' in stub.source
      ? { node: stub.source.node, tap: stub.source.tap }
      : {
          node: stub.source.node, port: stub.source.port,
          ...(stub.source.members !== undefined ? { members: stub.source.members } : {}),
        }
    const to = {
      node: target, port: stub.target.port,
      ...(stub.target.members !== undefined ? { members: stub.target.members } : {}),
    }
    drivenInputs.add(addressKey(target, stub.target.port, stub.target.members))
    tx.set(['graphs', graphId, 'links', id], { id, from, to } as unknown as Json)
  }
  // Net membership: merge compatible sink-only collisions into the existing
  // net, create (auto-renamed) nets otherwise - see resolveNetPastes. Mint
  // order keeps nets AFTER nodes/reroutes/links so planClipboardPaste's
  // predicted node and reroute ids stay correct.
  const netActions = resolveNetPastes(graph, envelope, new Set(nodeMap.keys()), definitions.ids)
  const claimedInputs = new Set<string>()
  const tagPlacements: NetViewPosition[] = []
  for (const action of netActions) {
    if (action.kind === 'skip') continue
    const placedSinks = action.record.sinks.flatMap((sink): { ref: PortRef; view?: { x: number; y: number } }[] => {
      const node = nodeMap.get(sink.node)
      if (node === undefined) return []
      const key = addressKey(node, sink.port, sink.members)
      if (drivenInputs.has(key) || claimedInputs.has(key)) return []
      claimedInputs.add(key)
      return [{
        ref: {
          node, port: sink.port,
          ...(sink.members !== undefined ? { members: sink.members } : {}),
        } as unknown as PortRef,
        ...(sink.view !== undefined ? { view: sink.view } : {}),
      }]
    })
    const sinks = placedSinks.map((placed) => placed.ref)
    const placeSinkTags = (netId: string): void => {
      for (const placed of placedSinks) {
        if (placed.view === undefined) continue
        tagPlacements.push({ graphId, netId, role: 'sink', to: placed.ref, geometry: { kind: 'offset', ...placed.view } })
      }
    }
    if (action.kind === 'merge') {
      if (sinks.length === 0) continue
      const current = tx.current.graphs[graphId]!.nets[action.netId]
      if (current === undefined) continue
      tx.set(['graphs', graphId, 'nets', action.netId, 'sinks'], [...current.sinks, ...sinks] as unknown as Json)
      placeSinkTags(action.netId)
      continue
    }
    const id = alloc.mint('net')
    const sourceNode = action.sourceCopied ? nodeMap.get(action.record.source.node)! : action.record.source.node
    tx.set(['graphs', graphId, 'nets', id], {
      id,
      name: action.name,
      source: {
        node: sourceNode, port: action.record.source.port,
        ...(action.record.source.members !== undefined ? { members: action.record.source.members } : {}),
      },
      sinks,
    } as unknown as Json)
    placeSinkTags(id)
    if (action.sourceCopied && action.record.source.view !== undefined) {
      tagPlacements.push({ graphId, netId: id, role: 'source', geometry: { kind: 'offset', ...action.record.source.view } })
    }
  }
  if (tagPlacements.length > 0) {
    if (tx.current.ext === undefined) tx.set(['ext'], {})
    tx.set(['ext', NET_VIEWS_EXT_KEY], updateNetViewPositions(tx.current, tagPlacements))
  }
  if (envelope.groups.length) {
    // FR1: groups mint from the shared group floor (groupSeq cursor +
    // live keys + binding-referenced ids, see group-alloc.ts), never from
    // nextOrdinal - the two cursors move independently, so a
    // nextOrdinal-minted grp<N> could land on a live group (tx.set
    // overwrites silently) or remint a removed group's id. The planner
    // refuses at the same boundary, so a returned plan never reaches these
    // throws (dispatch converts a throw into an atomic rejection, like
    // guardOrdinal).
    const existing = tx.current.view.graphs[graphId]!.groups ?? {}
    let seq = groupAllocationFloor(tx.current, graphId)
    if (!tx.current.view.graphs[graphId]!.groups) tx.set(['view', 'graphs', graphId, 'groups'], {})
    for (const raw of envelope.groups) {
      const group = raw as Record<string, Json>
      if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(seq + 1))
        throw new Error(`group id space exhausted: cursor is at ${seq}`)
      const id = `grp${seq++}`
      if (Object.hasOwn(existing, id))
        throw new Error(`group id space exhausted: '${id}' already exists`)
      const b = group.bounds as Record<string, Json>
      tx.set(['view', 'graphs', graphId, 'groups', id], { ...group, id, bounds: { ...b, x: Number(b.x) + dx, y: Number(b.y) + dy } } as unknown as Json)
    }
    tx.set(['view', 'graphs', graphId, 'groupSeq'], seq)
  }
  const occurrenceTopologies = occurrenceTopologiesForPaste(envelope, definitions)
  if (occurrenceTopologies.length > 0) {
    if (graphId !== tx.current.root) {
      return [diag('error', 'command', 'clipboard.occurrenceTopology.contextUnsupported', 'clipboard.paste: occurrence topology owners require the root graph')]
    }
    const remapOccurrence = (ref: OccurrenceRef): OccurrenceRef | undefined => {
      if (ref.instancePath.length === 0) {
        const node = nodeMap.get(ref.node)
        return node === undefined ? undefined : { instancePath: [], node: node as never }
      }
      const first = nodeMap.get(ref.instancePath[0]!)
      return first === undefined ? undefined : {
        instancePath: [first, ...ref.instancePath.slice(1)] as never,
        node: ref.node,
      }
    }
    const copiedTopologies: Record<string, OccurrenceTopology> = { ...(tx.current.occurrenceTopologies ?? {}) }
    for (const raw of occurrenceTopologies) {
      const topology = raw as unknown as OccurrenceTopology
      const owner = remapOccurrence(topology.owner)
      if (owner === undefined) return [diag('error', 'command', 'clipboard.occurrenceTopology.ownerOutsideCopy', 'clipboard.paste: occurrence topology owner is outside the copied subtree')]
      const links: Record<string, unknown> = {}
      let ordinal = 0
      const remapRoute = (route: readonly BoundaryRouteLeg[]): BoundaryRouteLeg[] => route.map((leg) => ({
          ...leg,
          graph: (definitions.ids.get(leg.graph) ?? leg.graph) as BoundaryRouteLeg['graph'],
        }))
      const remapEndpoint = (endpoint: OccurrenceTopology['links'][string]['from']) => endpoint.kind === 'body'
        ? endpoint
        : {
            ...endpoint,
            occurrence: remapOccurrence(endpoint.occurrence),
            route: remapRoute(endpoint.route),
          }
      for (const link of Object.values(topology.links)) {
        const from = remapEndpoint(link.from)
        const to = remapEndpoint(link.to)
        if (from.kind === 'boundary' && from.occurrence === undefined || to.kind === 'boundary' && to.occurrence === undefined) {
          return [diag('error', 'command', 'clipboard.occurrenceTopology.endpointOutsideCopy', 'clipboard.paste: occurrence endpoint is outside the copied subtree')]
        }
        const id = `l${ordinal++}`
        links[id] = { ...link, id, from, to }
      }
      const suppressedDeliveries = topology.suppressedDeliveries?.map((delivery) => {
        if (delivery.kind !== 'projectedLeg') return delivery
        const route = remapRoute(delivery.route)
        if (delivery.delivery.graph !== envelope.scope?.graph) {
          return {
            ...delivery,
            delivery: {
              ...delivery.delivery,
              graph: (definitions.ids.get(delivery.delivery.graph) ?? delivery.delivery.graph) as never,
            },
            route,
          }
        }
        if (delivery.delivery.kind !== 'link') return undefined
        const linkId = linkMap.get(delivery.delivery.linkId)
        return linkId === undefined ? undefined : {
          ...delivery,
          delivery: { ...delivery.delivery, graph: graphId as never, linkId: linkId as never },
          route,
        }
      })
      if (suppressedDeliveries?.some((delivery) => delivery === undefined)) {
        return [diag('error', 'command', 'clipboard.occurrenceTopology.deliveryOutsideCopy', 'clipboard.paste: projected occurrence delivery is outside the copied topology')]
      }
      const { actorCursors: _actorCursors, ...topologyWithoutActorCursors } = topology
      const copied = {
        ...topologyWithoutActorCursors,
        owner,
        bodyGraph: (definitions.ids.get(topology.bodyGraph) ?? topology.bodyGraph) as never,
        links,
        nextOrdinal: ordinal === 0 && (topology.nextOrdinal > 0 || topology.actorCursors !== undefined) ? 1 : ordinal,
        ...(suppressedDeliveries !== undefined ? { suppressedDeliveries } : {}),
      }
      copiedTopologies[occurrenceKey(owner)] = copied as OccurrenceTopology
    }
    tx.set(['occurrenceTopologies'], copiedTopologies as unknown as Json)
  }
  alloc.commit()
  return []
}

export const CLIPBOARD_COMMANDS: readonly CommandDefinition[] = [clipboardPaste]
