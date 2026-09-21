import { diag, type Diagnostic } from '../diagnostics.js'
import {
  isForwardingBinding,
  boundaryBindingKey,
  boundaryRouteKey,
  suppressedDeliveryKey,
  type BoundaryBinding,
  type BoundaryItem,
  type BoundaryRouteLeg,
  type ExtData,
  type GraphDef,
  type OccurrenceLinkEndpoint,
  type ParentDeliveryIdentity,
  type WorkflowDocument,
} from '../format/document.js'
import {
  isOccurrenceAncestorOrSelf,
  isPortEndpoint,
  occurrenceKey,
  portAddressKey,
  portRefKey,
  samePortRef,
  type GraphDefId,
  type LinkEndpoint,
  type LinkId,
  type NetId,
  type NodeId,
  type OccurrenceRef,
  type PortRef,
} from '../ids.js'
import { checkGraphTopology, subgraphDefIdOf } from '../invariants.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { buildGraphConnectivity, elaborateInterface, elabInputsOf, elabOutputsOf, type Connectivity } from '../schema/elaborate.js'
import {
  buildBoundaryCrossings,
  crossingTargets,
  translateThroughCrossing,
} from './crossing.js'
import { documentNodeResolver } from './compile.js'
import { occurrenceDynamicView } from './occurrence-view.js'

export type EffectiveLinkIdentity =
  | { readonly kind: 'definition'; readonly graphId: GraphDefId; readonly linkId: LinkId }
  | { readonly kind: 'parent'; readonly graphId: GraphDefId; readonly linkId: LinkId }
  | { readonly kind: 'definitionNetSink'; readonly graphId: GraphDefId; readonly netId: NetId; readonly to: PortRef }
  | { readonly kind: 'parentNetSink'; readonly graphId: GraphDefId; readonly netId: NetId; readonly to: PortRef }
  | { readonly kind: 'parentLeg'; readonly delivery: ParentDeliveryIdentity; readonly route: readonly BoundaryRouteLeg[] }
  | { readonly kind: 'occurrence'; readonly owner: OccurrenceRef; readonly linkId: LinkId }

export interface ResolvedOccurrenceEndpoint {
  readonly graphId: GraphDefId
  readonly instancePath: readonly NodeId[]
  readonly endpoint: LinkEndpoint
  /** Persisted coordinate from which this derived endpoint was resolved. */
  readonly source:
    | { readonly kind: 'definition' | 'parent'; readonly endpoint: LinkEndpoint }
    | { readonly kind: 'occurrence'; readonly owner: OccurrenceRef; readonly endpoint: OccurrenceLinkEndpoint }
}

export interface EffectiveLink {
  readonly identity: EffectiveLinkIdentity
  readonly from: ResolvedOccurrenceEndpoint
  readonly to: ResolvedOccurrenceEndpoint
}

export interface EffectiveOccurrenceTopology {
  readonly bodyGraph: GraphDef
  readonly links: readonly EffectiveLink[]
  readonly projectedParentLinks: readonly EffectiveLink[]
  readonly diagnostics: readonly Diagnostic[]
}

export interface FlattenOccurrenceTopologyPlan {
  readonly version: 'subgraph-flatten-occurrence-plan-v1'
  readonly owner: OccurrenceRef
  readonly links: readonly {
    readonly identity: EffectiveLinkIdentity
    readonly from: LinkEndpoint
    readonly to: LinkEndpoint
    readonly ext?: ExtData
  }[]
  readonly projectedParentLinks: readonly {
    readonly identity: EffectiveLinkIdentity
    readonly fromGraphId: GraphDefId
    readonly from: LinkEndpoint
    readonly toGraphId: GraphDefId
    readonly to: LinkEndpoint
    readonly ext?: ExtData
  }[]
}

export function occurrenceEndpointReferencesDefinition(
  endpoint: OccurrenceLinkEndpoint,
  graphId: string,
  nodeId: string,
): boolean {
  if (endpoint.kind === 'body')
    return endpoint.endpoint && 'node' in endpoint.endpoint && endpoint.endpoint.node === nodeId
  return endpoint.route.some((leg) => leg.graph === graphId && leg.binding.node === nodeId)
}

const portsOverlap = (a: string, b: string): boolean =>
  a === b || b.startsWith(`${a}.`) || a.startsWith(`${b}.`)

/**
 * Whether two member-path qualifications can address the same family row.
 * A missing/empty path means the whole family and stays conservative;
 * two explicit paths collide only when one is a prefix of the other.
 * Occurrence-allocated member ids never reuse definition-persisted ids,
 * so disjoint explicit paths are genuinely different rows.
 */
const memberPathsMayCollide = (
  a: readonly (string | undefined)[] | undefined,
  b: readonly (string | undefined)[] | undefined,
): boolean => {
  if (a === undefined || a.length === 0 || b === undefined || b.length === 0) return true
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return false
  return true
}

export function occurrenceBoundaryTargets(
  document: WorkflowDocument,
  endpoint: OccurrenceLinkEndpoint,
  graphId: string,
  target: PortRef,
): boolean {
  if (endpoint.kind === 'body') return false
  let parent = document.graphs[document.root]
  for (const hop of endpoint.occurrence.instancePath) {
    const node = parent?.nodes[hop]
    const childId = node && subgraphDefIdOf(node.type)
    parent = childId === undefined ? undefined : document.graphs[childId]
  }
  if (parent?.id === graphId && endpoint.occurrence.node === target.node &&
      portsOverlap(endpoint.address.port, target.port) &&
      memberPathsMayCollide(endpoint.address.members, target.members)) return true
  // Route legs address a nested row: crossing translation composes the leg's
  // binding member prefix with the occurrence suffix carried through the
  // route ([...hopMembers, rebased suffix]). Mirror that composition here so
  // a sibling definition row under the same prefix is not over-guarded.
  // 'port' bindings discard the suffix, exactly as translation does.
  let suffix: readonly (string | undefined)[] = endpoint.address.members ?? []
  for (const leg of endpoint.route) {
    if (leg.binding.kind === 'widgetTap') continue
    const composed = isForwardingBinding(leg.binding)
      ? [...(leg.binding.members ?? []), ...suffix]
      : [...(leg.binding.members ?? [])]
    if (leg.graph === graphId && leg.binding.node === target.node &&
        portsOverlap(leg.binding.port, target.port) &&
        memberPathsMayCollide(composed, target.members)) return true
    suffix = composed
  }
  return false
}

interface ProjectableLink {
  readonly link: EffectiveLink
  readonly delivery?: ParentDeliveryIdentity
  readonly route: readonly BoundaryRouteLeg[]
}

interface BuiltEffectiveOccurrenceTopology extends EffectiveOccurrenceTopology {
  readonly projectable: readonly ProjectableLink[]
}

interface ResolvedOwner {
  readonly parentGraph: GraphDef
  readonly parentPath: readonly NodeId[]
  readonly node: GraphDef['nodes'][string]
  readonly bodyGraph: GraphDef
  readonly bodyPath: readonly NodeId[]
}

function resolveOwner(document: WorkflowDocument, owner: OccurrenceRef): ResolvedOwner | undefined {
  let graph = document.graphs[document.root]
  const parentPath: NodeId[] = []
  for (const hop of owner.instancePath) {
    const node = graph?.nodes[hop]
    const childId = node && subgraphDefIdOf(node.type)
    const child = childId && document.graphs[childId]
    if (!node || !child) return undefined
    graph = child
    parentPath.push(hop)
  }
  const node = graph?.nodes[owner.node]
  const bodyId = node && subgraphDefIdOf(node.type)
  const bodyGraph = bodyId && document.graphs[bodyId]
  if (!graph || !node || !bodyGraph) return undefined
  return { parentGraph: graph, parentPath, node, bodyGraph, bodyPath: [...parentPath, owner.node] }
}

const resolved = (
  graphId: GraphDefId,
  instancePath: readonly NodeId[],
  endpoint: LinkEndpoint,
  source: ResolvedOccurrenceEndpoint['source'],
): ResolvedOccurrenceEndpoint => ({ graphId, instancePath, endpoint, source })

function itemForRoute(
  graph: GraphDef,
  side: 'from' | 'to',
  boundaryId: string,
): BoundaryItem | undefined {
  const items = side === 'from' ? graph.boundary?.outputs : graph.boundary?.inputs
  return items?.find((item) => item.id === boundaryId)
}

/** Resolve one persisted occurrence endpoint to the concrete body coordinate. */
function resolveOccurrenceEndpoint(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
  bodyGraph: GraphDef,
  endpoint: OccurrenceLinkEndpoint,
  side: 'from' | 'to',
  diagnostics: Diagnostic[],
): ResolvedOccurrenceEndpoint | undefined {
  const bodyPath = [...owner.instancePath, owner.node]
  const source = { kind: 'occurrence' as const, owner, endpoint }
  if (endpoint.kind === 'body') {
    if (isPortEndpoint(endpoint.endpoint) && endpoint.endpoint.node === '$region') {
      if (side !== 'from' || endpoint.endpoint.port !== 'index' || endpoint.endpoint.members !== undefined ||
          resolveOwner(document, owner)?.node.region === undefined) {
        diagnostics.push(diag('error', 'compile', 'occurrence.topology.regionIndex', "'$region.index' is a source only inside its immediate region occurrence"))
        return undefined
      }
    }
    return resolved(bodyGraph.id, bodyPath, endpoint.endpoint, source)
  }
  if (!isOccurrenceAncestorOrSelf(endpoint.occurrence, owner)) {
    diagnostics.push(diag('error', 'compile', 'occurrence.topology.routeOwner', `occurrence endpoint '${occurrenceKey(endpoint.occurrence)}' is not an ancestor of '${occurrenceKey(owner)}'`))
    return undefined
  }

  let occurrence = endpoint.occurrence
  let address = endpoint.address
  let finalGraph: GraphDef | undefined
  let finalPath: readonly NodeId[] = []
  let finalEndpoint: LinkEndpoint | undefined
  for (const [legIndex, leg] of endpoint.route.entries()) {
    const at = resolveOwner(document, occurrence)
    if (!at || at.bodyGraph.id !== leg.graph) {
      diagnostics.push(diag('error', 'compile', 'occurrence.topology.routeMissing', `route leg '${leg.boundaryId}' does not resolve graph '${leg.graph}' from occurrence '${occurrenceKey(occurrence)}'`))
      return undefined
    }
    const item = itemForRoute(at.bodyGraph, side, leg.boundaryId)
    if (!item) {
      diagnostics.push(diag('error', 'compile', 'occurrence.topology.routeMissing', `route leg '${leg.boundaryId}' is missing from graph '${leg.graph}'`))
      return undefined
    }
    const bindings = [item.binds, ...(item.alsoBinds ?? [])]
    const wanted = boundaryBindingKey(leg.binding)
    const matches = bindings.map((binding, index) => ({ binding, index })).filter(({ binding }) => boundaryBindingKey(binding) === wanted)
    if (matches.length !== 1) {
      diagnostics.push(diag(
        'error',
        'compile',
        matches.length === 0 ? 'occurrence.topology.routeMissing' : 'occurrence.topology.routeAmbiguous',
        `route leg '${leg.boundaryId}' in graph '${leg.graph}' matches ${matches.length} current bindings`,
      ))
      return undefined
    }
    const match = matches[0]!
    if (match.binding.kind === 'widgetTap') {
      if (side !== 'from' || legIndex !== endpoint.route.length - 1) {
        diagnostics.push(diag('error', 'compile', 'occurrence.topology.routeMissing', `widget tap route leg '${leg.boundaryId}' must terminate an output route`))
        return undefined
      }
      finalGraph = at.bodyGraph
      finalPath = at.bodyPath
      finalEndpoint = { node: match.binding.node, tap: match.binding.tap }
      continue
    }
    let ref: PortRef
    if (isForwardingBinding(match.binding)) {
      const view = occurrenceDynamicView(document, resolver, occurrence.instancePath)
      const instanceDynamic = view.dynamic.get(occurrence.node) ?? at.node.dynamic
      const instanceValues = view.values.get(occurrence.node) ?? at.node.values
      const resolveNode = documentNodeResolver(document, resolver)
      const built = buildBoundaryCrossings(at.bodyGraph, resolver, instanceDynamic, (node) => resolveNode(at.bodyGraph.id, node), instanceValues)
      const crossing = built.crossings.get(item.id)
      const target = crossing && crossingTargets(crossing)[match.index]
      if (!target || built.problems.length > 0) {
        diagnostics.push(diag('error', 'compile', 'occurrence.topology.routeMissing', `route leg '${leg.boundaryId}' in graph '${leg.graph}' has no current family crossing`))
        return undefined
      }
      const translated = translateThroughCrossing(target, address)
      if (!translated.ok) {
        diagnostics.push(diag('error', 'compile', translated.code, translated.message))
        return undefined
      }
      ref = translated.ref
    } else {
      ref = match.binding
    }
    finalGraph = at.bodyGraph
    finalPath = at.bodyPath
    finalEndpoint = ref
    occurrence = { instancePath: at.bodyPath, node: ref.node }
    address = { port: ref.port, ...(ref.members ? { members: ref.members } : {}) }
  }
  if (!finalGraph || finalGraph.id !== bodyGraph.id || !finalEndpoint) {
    diagnostics.push(diag('error', 'compile', 'occurrence.topology.routeMissing', `route for occurrence '${occurrenceKey(owner)}' does not terminate in body graph '${bodyGraph.id}'`))
    return undefined
  }
  return resolved(finalGraph.id, finalPath, finalEndpoint, source)
}

/** Resolve an authored local-link endpoint through the same crossings as compile. */
export function resolveOccurrenceLinkEndpoint(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
  endpoint: OccurrenceLinkEndpoint,
  side: 'from' | 'to',
): { readonly endpoint?: ResolvedOccurrenceEndpoint; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const at = resolveOwner(document, owner)
  if (!at) {
    diagnostics.push(diag('error', 'compile', 'occurrence.topology.ownerMissing', `occurrence '${occurrenceKey(owner)}' does not resolve to a subgraph instance`))
    return { diagnostics }
  }
  const resolvedEndpoint = resolveOccurrenceEndpoint(document, resolver, owner, at.bodyGraph, endpoint, side, diagnostics)
  return { ...(resolvedEndpoint ? { endpoint: resolvedEndpoint } : {}), diagnostics }
}

function projectedEndpoints(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
  at: ResolvedOwner,
  endpoint: PortRef,
  side: 'from' | 'to',
  diagnostics: Diagnostic[],
): { readonly endpoint: ResolvedOccurrenceEndpoint; readonly route: readonly BoundaryRouteLeg[] }[] {
  const items = side === 'from' ? at.bodyGraph.boundary?.outputs : at.bodyGraph.boundary?.inputs
  const candidates = items?.filter((item) =>
    isForwardingBinding(item.binds)
      ? endpoint.port === item.id || endpoint.port.startsWith(`${item.id}.`)
      : endpoint.port === item.id && endpoint.members === undefined,
  ) ?? []
  if (candidates.length !== 1) return []
  const item = candidates[0]!
  const bindings = [item.binds, ...(item.alsoBinds ?? [])]
  const out: { endpoint: ResolvedOccurrenceEndpoint; route: readonly BoundaryRouteLeg[] }[] = []
  for (const binding of bindings) {
    const route = [{ graph: at.bodyGraph.id, boundaryId: item.id, binding }]
    const occurrenceEndpoint: OccurrenceLinkEndpoint = {
      kind: 'boundary', occurrence: owner,
      address: { port: endpoint.port, ...(endpoint.members ? { members: endpoint.members } : {}) },
      route,
    }
    const target = resolveOccurrenceEndpoint(document, resolver, owner, at.bodyGraph, occurrenceEndpoint, side, diagnostics)
    if (target) out.push({ endpoint: target, route })
  }
  return out
}

function buildEffectiveOccurrenceTopology(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
): BuiltEffectiveOccurrenceTopology {
  const diagnostics: Diagnostic[] = []
  const at = resolveOwner(document, owner)
  const fallback = document.graphs[document.root]!
  if (!at) {
    diagnostics.push(diag('error', 'compile', 'occurrence.topology.ownerMissing', `occurrence '${occurrenceKey(owner)}' does not resolve to a subgraph instance`))
    return { bodyGraph: fallback, links: [], projectedParentLinks: [], diagnostics, projectable: [] }
  }
  const topology = document.occurrenceTopologies?.[occurrenceKey(owner)]
  if (topology && topology.bodyGraph !== at.bodyGraph.id) {
    diagnostics.push(diag('error', 'compile', 'occurrence.topology.bodyMismatch', `occurrence '${occurrenceKey(owner)}' records body '${topology.bodyGraph}', but resolves to '${at.bodyGraph.id}'`))
    return { bodyGraph: at.bodyGraph, links: [], projectedParentLinks: [], diagnostics, projectable: [] }
  }

  // Force dynamic projection through the same crossing/selector operation as
  // the drilled view. Endpoint translation below uses the same crossings.
  const dynamicView = occurrenceDynamicView(document, resolver, at.bodyPath)

  const suppressions = new Set((topology?.suppressedDeliveries ?? []).map(suppressedDeliveryKey))
  const links: EffectiveLink[] = []
  for (const link of Object.values(at.bodyGraph.links)) {
    if (suppressions.has(suppressedDeliveryKey({ kind: 'link', linkId: link.id }))) continue
    links.push({
      identity: { kind: 'definition', graphId: at.bodyGraph.id, linkId: link.id },
      from: resolved(at.bodyGraph.id, at.bodyPath, link.from, { kind: 'definition', endpoint: link.from }),
      to: resolved(at.bodyGraph.id, at.bodyPath, link.to, { kind: 'definition', endpoint: link.to }),
    })
  }
  for (const net of Object.values(at.bodyGraph.nets)) {
    for (const to of net.sinks) {
      if (suppressions.has(suppressedDeliveryKey({ kind: 'netSink', netId: net.id, to }))) continue
      links.push({
        identity: { kind: 'definitionNetSink', graphId: at.bodyGraph.id, netId: net.id, to },
        from: resolved(at.bodyGraph.id, at.bodyPath, net.source, { kind: 'definition', endpoint: net.source }),
        to: resolved(at.bodyGraph.id, at.bodyPath, to, { kind: 'definition', endpoint: to }),
      })
    }
  }
  for (const link of Object.values(topology?.links ?? {})) {
    const from = resolveOccurrenceEndpoint(document, resolver, owner, at.bodyGraph, link.from, 'from', diagnostics)
    const to = resolveOccurrenceEndpoint(document, resolver, owner, at.bodyGraph, link.to, 'to', diagnostics)
    if (!from || !to) continue
    links.push({ identity: { kind: 'occurrence', owner, linkId: link.id }, from, to })
  }

  const projectedParentLinks: EffectiveLink[] = []
  const projectedProjectable: ProjectableLink[] = []
  const project = (
    identity: EffectiveLinkIdentity,
    delivery: ParentDeliveryIdentity | undefined,
    from: ResolvedOccurrenceEndpoint,
    to: ResolvedOccurrenceEndpoint,
    inheritedRoute: readonly BoundaryRouteLeg[],
  ): void => {
    if (isPortEndpoint(from.endpoint) && from.endpoint.node === owner.node) {
      const targets = projectedEndpoints(document, resolver, owner, at, from.endpoint, 'from', diagnostics)
      for (const target of targets) {
        const route = [...inheritedRoute, ...target.route]
        if (delivery && suppressions.has(suppressedDeliveryKey({ kind: 'projectedLeg', delivery, route }))) continue
        const link = { identity: delivery ? { kind: 'parentLeg' as const, delivery, route } : identity, from: target.endpoint, to }
        projectedParentLinks.push(link)
        projectedProjectable.push({ link, ...(delivery ? { delivery } : {}), route })
      }
    }
    if (isPortEndpoint(to.endpoint) && to.endpoint.node === owner.node) {
      const targets = projectedEndpoints(document, resolver, owner, at, to.endpoint, 'to', diagnostics)
      for (const target of targets) {
        const route = [...inheritedRoute, ...target.route]
        if (delivery && suppressions.has(suppressedDeliveryKey({ kind: 'projectedLeg', delivery, route }))) continue
        const link = { identity: delivery ? { kind: 'parentLeg' as const, delivery, route } : identity, from, to: target.endpoint }
        projectedParentLinks.push(link)
        projectedProjectable.push({ link, ...(delivery ? { delivery } : {}), route })
      }
    }
  }
  if (at.parentPath.length === 0) {
    for (const link of Object.values(at.parentGraph.links)) {
      const from = resolved(at.parentGraph.id, at.parentPath, link.from, { kind: 'parent', endpoint: link.from })
      const to = resolved(at.parentGraph.id, at.parentPath, link.to, { kind: 'parent', endpoint: link.to })
      project(
        { kind: 'parent', graphId: at.parentGraph.id, linkId: link.id },
        { kind: 'link', graph: at.parentGraph.id, linkId: link.id },
        from, to, [],
      )
    }
    for (const net of Object.values(at.parentGraph.nets)) for (const sink of net.sinks) {
      const from = resolved(at.parentGraph.id, at.parentPath, net.source, { kind: 'parent', endpoint: net.source })
      const to = resolved(at.parentGraph.id, at.parentPath, sink, { kind: 'parent', endpoint: sink })
      project(
        { kind: 'parentNetSink', graphId: at.parentGraph.id, netId: net.id, to: sink },
        { kind: 'netSink', graph: at.parentGraph.id, netId: net.id, to: sink },
        from, to, [],
      )
    }
  } else {
    const parentOwner: OccurrenceRef = {
      instancePath: at.parentPath.slice(0, -1),
      node: at.parentPath[at.parentPath.length - 1]!,
    }
    const parent = buildEffectiveOccurrenceTopology(document, resolver, parentOwner)
    diagnostics.push(...parent.diagnostics)
    for (const projected of parent.projectable) {
      const link = projected.link
      const identity: EffectiveLinkIdentity = link.identity.kind === 'definition'
        ? { kind: 'parent', graphId: link.identity.graphId, linkId: link.identity.linkId }
        : link.identity.kind === 'definitionNetSink'
          ? { kind: 'parentNetSink', graphId: link.identity.graphId, netId: link.identity.netId, to: link.identity.to }
          : link.identity
      project(identity, projected.delivery, link.from, link.to, projected.route)
    }
  }

  const drivers = new Map<string, EffectiveLink>()
  const drivenLinks = document.occurrenceTopologies === undefined
    ? links
    : [...links, ...projectedParentLinks.filter((link) => link.to.graphId === at.bodyGraph.id)]
  for (const link of drivenLinks) {
    const key = isPortEndpoint(link.to.endpoint) ? portRefKey(link.to.endpoint) : JSON.stringify(link.to.endpoint)
    if (drivers.has(key)) diagnostics.push(diag('error', 'compile', 'occurrence.topology.multipleDrivers', `effective endpoint ${JSON.stringify(link.to.endpoint)} has multiple drivers`))
    else drivers.set(key, link)
  }
  if (topology) {
    const occupied = new Set([
      ...Object.keys(at.bodyGraph.nodes),
      ...Object.keys(at.bodyGraph.reroutes),
      ...Object.keys(at.bodyGraph.valueSources ?? {}),
      ...Object.keys(at.bodyGraph.selectors ?? {}),
    ])
    const validationLinks = Object.fromEntries(links.filter((link) =>
      !(isPortEndpoint(link.from.endpoint) && link.from.endpoint.node === '$region' &&
        link.from.endpoint.port === 'index' && link.from.endpoint.members === undefined),
    ).map((link, index) => {
      let id = `__effective_validation_${index}`
      while (occupied.has(id)) id += '_'
      occupied.add(id)
      return [id, { id: id as LinkId, from: link.from.endpoint, to: link.to.endpoint }]
    })) as GraphDef['links']
    const validationGraph: GraphDef = { ...at.bodyGraph, links: validationLinks, nets: {} }
    const effectiveValidationCodes = new Set([
      'doc.link.dangling',
      'doc.link.selectorCandidateSource',
      'doc.link.valueSourceTarget',
      'doc.link.tapTarget',
      'doc.link.selectorOutputTarget',
      'doc.reroute.cycle',
      'doc.selector.cycle',
      'doc.tap.cycle',
    ])
    diagnostics.push(...checkGraphTopology(document, validationGraph).filter((diagnostic) => effectiveValidationCodes.has(diagnostic.code)))

    const baseConnectivity = buildGraphConnectivity(validationGraph)
    const projectedInputs = new Map<NodeId, Set<string>>()
    const projectedInputPorts = new Map<NodeId, Set<string>>()
    const projectedOutputs = new Map<NodeId, Set<string>>()
    const recordProjected = (map: Map<NodeId, Set<string>>, ref: PortRef): void => {
      let addresses = map.get(ref.node)
      if (!addresses) map.set(ref.node, (addresses = new Set()))
      addresses.add(portAddressKey(ref.port, ref.members))
    }
    for (const link of projectedParentLinks) {
      if (link.from.graphId === at.bodyGraph.id && isPortEndpoint(link.from.endpoint)) recordProjected(projectedOutputs, link.from.endpoint)
      if (link.to.graphId === at.bodyGraph.id && isPortEndpoint(link.to.endpoint)) {
        recordProjected(projectedInputs, link.to.endpoint)
        if (link.to.endpoint.members === undefined || link.to.endpoint.members.length === 0) {
          let ports = projectedInputPorts.get(link.to.endpoint.node)
          if (!ports) projectedInputPorts.set(link.to.endpoint.node, (ports = new Set()))
          ports.add(link.to.endpoint.port)
        }
      }
    }
    const connectivity = (nodeId: NodeId): Connectivity => {
      const base = baseConnectivity(nodeId)
      const inputs = projectedInputs.get(nodeId)
      const outputs = projectedOutputs.get(nodeId)
      if (!inputs && !outputs) return base
      return {
        isInputConnected: (port, members) => inputs?.has(portAddressKey(port, members)) || base.isInputConnected(port, members),
        isOutputConnected: (port, members) => outputs?.has(portAddressKey(port, members)) || base.isOutputConnected(port, members),
        inputPorts: () => [...new Set([...(base.inputPorts?.() ?? []), ...(projectedInputPorts.get(nodeId) ?? [])])],
      }
    }
    const resolveNode = documentNodeResolver(document, resolver)
    const ports = new Map<NodeId, { readonly inputs: ReadonlySet<string>; readonly outputs: ReadonlySet<string> }>()
    const portsFor = (nodeId: NodeId) => {
      const cached = ports.get(nodeId)
      if (cached) return cached
      const node = at.bodyGraph.nodes[nodeId]
      const schema = node && resolveNode(at.bodyGraph.id, node)
      const dynamic = node && (dynamicView.dynamic.get(nodeId) ?? node.dynamic)
      const values = node && (dynamicView.values.get(nodeId) ?? node.values)
      const state = node && values && { values, ...(dynamic ? { dynamic } : {}) }
      const elaborated = schema && state && elaborateInterface(schema, state, connectivity(nodeId), { promoteGhosts: false, nodeId })
      const result = {
        inputs: new Set(elaborated ? elabInputsOf(elaborated).map((input) => portAddressKey(input.address.port, input.address.members)) : []),
        outputs: new Set(elaborated ? elabOutputsOf(elaborated).map((output) => portAddressKey(output.address.port, output.address.members)) : []),
      }
      ports.set(nodeId, result)
      return result
    }
    const validatePort = (endpoint: ResolvedOccurrenceEndpoint, side: 'source' | 'target'): void => {
      if (!isPortEndpoint(endpoint.endpoint) || endpoint.graphId !== at.bodyGraph.id) return
      if (side === 'source' && endpoint.endpoint.node === '$region' && endpoint.endpoint.port === 'index' && endpoint.endpoint.members === undefined) return
      const key = portAddressKey(endpoint.endpoint.port, endpoint.endpoint.members)
      const available = portsFor(endpoint.endpoint.node)
      const expected = side === 'source' ? available.outputs : available.inputs
      const opposite = side === 'source' ? available.inputs : available.outputs
      if (expected.has(key)) return
      diagnostics.push(diag(
        'error', 'compile',
        opposite.has(key) ? 'occurrence.topology.endpointDirection' : 'occurrence.topology.endpointMissing',
        `effective ${side} endpoint '${endpoint.endpoint.node}.${endpoint.endpoint.port}' is not a current ${side === 'source' ? 'output' : 'input'}`,
      ))
    }
    for (const link of [...links, ...projectedParentLinks]) {
      validatePort(link.from, 'source')
      validatePort(link.to, 'target')
    }
  }
  const localProjectable: ProjectableLink[] = links.map((link) => {
    const delivery: ParentDeliveryIdentity | undefined = link.identity.kind === 'definition'
      ? { kind: 'link', graph: link.identity.graphId, linkId: link.identity.linkId }
      : link.identity.kind === 'definitionNetSink'
        ? { kind: 'netSink', graph: link.identity.graphId, netId: link.identity.netId, to: link.identity.to }
        : undefined
    return { link, ...(delivery ? { delivery } : {}), route: [] }
  })
  return { bodyGraph: at.bodyGraph, links, projectedParentLinks, diagnostics, projectable: [...localProjectable, ...projectedProjectable] }
}

export function effectiveOccurrenceTopology(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
): EffectiveOccurrenceTopology {
  const { projectable: _projectable, ...effective } = buildEffectiveOccurrenceTopology(document, resolver, owner)
  return effective
}

/** Whether the resolved occurrence topology drives one exact input coordinate. */
export function effectiveTopologyDrivesPort(
  topology: EffectiveOccurrenceTopology,
  graphId: GraphDefId,
  instancePath: readonly NodeId[],
  target: PortRef,
): boolean {
  return [...topology.links, ...topology.projectedParentLinks].some((link) =>
    link.to.graphId === graphId &&
    link.to.instancePath.length === instancePath.length &&
    link.to.instancePath.every((nodeId, index) => nodeId === instancePath[index]) &&
    isPortEndpoint(link.to.endpoint) && samePortRef(link.to.endpoint, target))
}

export function planFlattenOccurrenceTopology(
  document: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
): { readonly plan?: FlattenOccurrenceTopologyPlan; readonly diagnostics: readonly Diagnostic[] } {
  if (document.occurrenceTopologies?.[occurrenceKey(owner)] === undefined) return { diagnostics: [] }
  const effective = effectiveOccurrenceTopology(document, resolver, owner)
  if (effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { diagnostics: effective.diagnostics }
  }
  const extension = (identity: EffectiveLinkIdentity): ExtData | undefined => {
    if (identity.kind === 'definition' || identity.kind === 'parent') {
      return document.graphs[identity.graphId]?.links[identity.linkId]?.ext
    }
    if (identity.kind === 'occurrence') {
      return document.occurrenceTopologies?.[occurrenceKey(identity.owner)]?.links[identity.linkId]?.ext
    }
    if (identity.kind === 'parentLeg' && identity.delivery.kind === 'link') {
      return document.graphs[identity.delivery.graph]?.links[identity.delivery.linkId]?.ext
    }
    return undefined
  }
  const project = (link: EffectiveLink) => {
    const ext = extension(link.identity)
    return {
      identity: link.identity,
      from: link.from.endpoint,
      to: link.to.endpoint,
      ...(ext !== undefined ? { ext } : {}),
    }
  }
  return {
    plan: {
      version: 'subgraph-flatten-occurrence-plan-v1',
      owner,
      links: effective.links.map(project),
      projectedParentLinks: effective.projectedParentLinks.map((link) => {
        const ext = extension(link.identity)
        return {
          identity: link.identity,
          fromGraphId: link.from.graphId,
          from: link.from.endpoint,
          toGraphId: link.to.graphId,
          to: link.to.endpoint,
          ...(ext !== undefined ? { ext } : {}),
        }
      }),
    },
    diagnostics: effective.diagnostics,
  }
}

/** Exact route identity used by compile's projected-leg filter. */
export const effectiveRouteKey = (route: readonly BoundaryRouteLeg[]): string => boundaryRouteKey(route)
