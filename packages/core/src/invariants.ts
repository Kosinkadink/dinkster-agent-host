/**
 * Structural invariant checker. The test oracle for the whole system:
 * every command, migration, and importer must leave documents invariant-clean.
 *
 * Checked invariants:
 *  I1  root graph exists; every node `#def` reference resolves
 *  I2  no recursive subgraph definitions (instance graph is a DAG)
 *  I3  link endpoints reference existing nodes within the same graph def
 *  I4  named nets: source + all sinks reference existing nodes in the same
 *      graph def (nets never cross boundaries by construction of the format,
 *      but node references must still resolve)
 *  I5  at most one driver per input: no input is fed by more than one link or
 *      net sink, and not by both
 *  I6  IDs are unique within their graph def and below their allocation
 *      cursor (nextOrdinal for solo ids, actorCursors[actor] for
 *      actor-suffixed shared-session ids) - the never-reuse guarantee
 *  I7  subgraph boundary items bind to existing inner nodes
 *  I8  view state references only existing graph defs / nodes / reroutes
 *      (warning-level)
 *  I9  reroutes: link endpoints reference existing reroutes in the same graph
 *      def, at most one link drives each reroute, and reroute chains are
 *      acyclic (nets/boundaries cannot reference reroutes by construction)
 *  I10 value sources: key/id consistent, ids below the allocation cursor,
 *      every ValueSourceRef resolves in the same graph def, and no link may
 *      TARGET a value source (they produce, never consume; fan-out is fine)
 *  I11 selectors: key/id consistent, ids below the allocation cursor,
 *      candidate ids unique within their selector, a fixed policy names an
 *      existing candidate, every SelectorRef resolves (selector + candidate)
 *      in the same graph def, link SOURCES never name a candidate and link
 *      TARGETS always do (candidates consume, the output produces), at most
 *      one link drives each candidate, and reroute/selector driver chains
 *      (over ALL candidates, since policy can change) are acyclic
 *  I12 member-addressed link/net endpoints name persisted dynamic members;
 *      stale links cannot recreate sockets removed by explicit compaction
 */

import { diag, type Diagnostic } from './diagnostics.js'
import {
  boundaryBindingKey,
  isSubtreeBinding,
  regionContractShapeProblems,
  resolveDynamicAddress,
  type BoundaryRouteLeg,
  type GraphDef,
  type LinkData,
  type NodeData,
  type OccurrenceLinkEndpoint,
  type OccurrenceTopology,
  type ParentDeliveryIdentity,
  type RegionContract,
  type WorkflowDocument,
} from './format/document.js'
import {
  actorCursorOf,
  asNodeId,
  isPortEndpoint,
  isRerouteRef,
  isSelectorRef,
  isValueSourceRef,
  isWidgetTapRef,
  occurrenceKey,
  parseAllocatedId,
  portRefKey,
  sameOccurrenceRef,
  samePortRef,
  type LinkEndpoint,
  type NodeId,
  type OccurrenceRef,
  type PortRef,
} from './ids.js'
import { matchBoundaryItem, translateThroughCrossing } from './compile/crossing.js'
import { selectorCandidateKey } from './reroute.js'

const SUBGRAPH_PREFIX = '#'

export function subgraphDefIdOf(nodeType: string): string | undefined {
  return nodeType.startsWith(SUBGRAPH_PREFIX) ? nodeType.slice(1) : undefined
}

export function checkDocument(doc: WorkflowDocument): readonly Diagnostic[] {
  const diags: Diagnostic[] = []

  // I1: root exists
  if (!doc.graphs[doc.root]) {
    diags.push(diag('error', 'invariant', 'doc.root.missing', `root graph '${doc.root}' not found`))
    return diags // nothing else is meaningful
  }

  for (const [defId, def] of Object.entries(doc.graphs)) {
    checkGraphDef(doc, defId, def, diags)
  }

  checkNoRecursion(doc, diags)
  checkOccurrenceTopologies(doc, diags)
  checkViewState(doc, diags)
  return diags
}

/** Validate one derived graph with the same structural topology rules as a document graph. */
export function checkGraphTopology(doc: WorkflowDocument, def: GraphDef): readonly Diagnostic[] {
  const diags: Diagnostic[] = []
  checkGraphDef(doc, def.id, def, diags)
  return diags
}

interface ResolvedOccurrenceHop {
  readonly ref: OccurrenceRef
  readonly parentGraphId: string
  readonly bodyGraphId: string
  readonly node: NodeData
}

function resolveOccurrenceChain(
  doc: WorkflowDocument,
  owner: OccurrenceRef,
): readonly ResolvedOccurrenceHop[] | undefined {
  const segments = [...owner.instancePath, owner.node]
  const chain: ResolvedOccurrenceHop[] = []
  let graphId: string = doc.root
  for (let index = 0; index < segments.length; index++) {
    const graph = doc.graphs[graphId]
    const node = graph?.nodes[segments[index]!]
    const bodyGraphId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    if (node === undefined || bodyGraphId === undefined || doc.graphs[bodyGraphId] === undefined)
      return undefined
    chain.push({
      ref: {
        instancePath: segments.slice(0, index),
        node: segments[index]!,
      },
      parentGraphId: graphId,
      bodyGraphId,
      node,
    })
    graphId = bodyGraphId
  }
  return chain
}

const containsNul = (value: string): boolean => value.includes('\u0000')

function endpointIdentityContainsNul(endpoint: LinkEndpoint): boolean {
  if (isRerouteRef(endpoint)) return containsNul(endpoint.reroute)
  if (isValueSourceRef(endpoint)) return containsNul(endpoint.valueSource)
  if (isSelectorRef(endpoint))
    return containsNul(endpoint.selector) ||
      (endpoint.candidate !== undefined && containsNul(endpoint.candidate))
  if (isWidgetTapRef(endpoint)) return containsNul(endpoint.node) || containsNul(endpoint.tap)
  return containsNul(endpoint.node) || containsNul(endpoint.port) ||
    endpoint.members?.some(containsNul) === true
}

function occurrenceRefContainsNul(ref: OccurrenceRef): boolean {
  return containsNul(ref.node) || ref.instancePath.some(containsNul)
}

function routeContainsNul(route: readonly BoundaryRouteLeg[]): boolean {
  return route.some((leg) =>
    containsNul(leg.graph) ||
    containsNul(leg.boundaryId) ||
    containsNul(leg.binding.node) ||
    (leg.binding.kind === 'widgetTap'
      ? containsNul(leg.binding.tap)
      : containsNul(leg.binding.port) ||
        leg.binding.members?.some(containsNul) === true ||
        leg.binding.slots?.some(containsNul) === true))
}

function occurrenceEndpointContainsNul(endpoint: OccurrenceLinkEndpoint): boolean {
  return endpoint.kind === 'body'
    ? endpointIdentityContainsNul(endpoint.endpoint)
    : occurrenceRefContainsNul(endpoint.occurrence) ||
      containsNul(endpoint.address.port) ||
      endpoint.address.members?.some(containsNul) === true ||
      routeContainsNul(endpoint.route)
}

function parentDeliveryContainsNul(delivery: ParentDeliveryIdentity): boolean {
  return containsNul(delivery.graph) ||
    (delivery.kind === 'link'
      ? containsNul(delivery.linkId)
      : containsNul(delivery.netId) || endpointIdentityContainsNul(delivery.to))
}

function topologyIdentityContainsNul(key: string, topology: OccurrenceTopology): boolean {
  if (containsNul(key) || occurrenceRefContainsNul(topology.owner) || containsNul(topology.bodyGraph))
    return true
  for (const [linkKey, link] of Object.entries(topology.links)) {
    if (containsNul(linkKey) || containsNul(link.id) ||
        occurrenceEndpointContainsNul(link.from) || occurrenceEndpointContainsNul(link.to))
      return true
  }
  return (topology.suppressedDeliveries ?? []).some((suppression) => {
    if (suppression.kind === 'link') return containsNul(suppression.linkId)
    if (suppression.kind === 'netSink')
      return containsNul(suppression.netId) || endpointIdentityContainsNul(suppression.to)
    return parentDeliveryContainsNul(suppression.delivery) || routeContainsNul(suppression.route)
  })
}

function routeMatchesOwnerChain(
  doc: WorkflowDocument,
  chain: readonly ResolvedOccurrenceHop[],
  startIndex: number,
  side: 'from' | 'to',
  initialAddress: { readonly port: string; readonly members?: readonly string[] },
  route: readonly BoundaryRouteLeg[],
): boolean {
  if (route.length !== chain.length - startIndex) return false
  let address = initialAddress
  for (let offset = 0; offset < route.length; offset++) {
    const ownerHop = chain[startIndex + offset]!
    const graph = doc.graphs[ownerHop.bodyGraphId]!
    const leg = route[offset]!
    if (leg.graph !== graph.id) return false
    const items = side === 'from' ? graph.boundary?.outputs : graph.boundary?.inputs
    const match = matchBoundaryItem(items ?? [], address)
    if (!match.ok || match.item.id !== leg.boundaryId) return false
    const item = match.item
    if (item.binds.kind === 'family' &&
        resolveDynamicAddress(address, ownerHop.node.dynamic).kind !== 'resolved')
      return false
    const bindings = [item.binds, ...(item.alsoBinds ?? [])]
    const bindingMatches = bindings.filter((binding) =>
      boundaryBindingKey(binding) === boundaryBindingKey(leg.binding))
    if (bindingMatches.length !== 1)
      return false
    const binding = bindingMatches[0]!
    const targetNode = graph.nodes[binding.node]
    if (targetNode === undefined ||
        binding.kind !== 'widgetTap' && resolveDynamicAddress(binding, targetNode.dynamic).kind === 'missing')
      return false
    if (offset + 1 < route.length) {
      const nextHop = chain[startIndex + offset + 1]!
      if (binding.kind === 'widgetTap' || binding.node !== nextHop.ref.node) return false
      if (isSubtreeBinding(binding)) {
        const translated = translateThroughCrossing({
          kind: 'subtree', boundaryId: item.id, side: 'input', targetNode: binding.node,
          constructPath: binding.port, hopMembers: binding.members ?? [], hopPaths: [],
        }, address)
        if (!translated.ok) return false
        address = translated.ref
      } else address = { port: binding.port, ...(binding.members ? { members: binding.members } : {}) }
    }
  }
  return true
}

function checkOccurrenceBodyEndpoint(
  def: GraphDef,
  endpoint: LinkEndpoint,
  side: 'from' | 'to',
  where: string,
  diags: Diagnostic[],
): void {
  const dangling = (message: string) =>
    diags.push(diag('error', 'invariant', 'doc.occurrenceTopology.endpointDangling', `${where}: ${message}`))
  if (isRerouteRef(endpoint)) {
    if (def.reroutes[endpoint.reroute] === undefined) dangling(`missing reroute '${endpoint.reroute}'`)
    return
  }
  if (isValueSourceRef(endpoint)) {
    if (def.valueSources?.[endpoint.valueSource] === undefined)
      dangling(`missing value source '${endpoint.valueSource}'`)
    else if (side === 'to') dangling(`value source '${endpoint.valueSource}' cannot consume`)
    return
  }
  if (isSelectorRef(endpoint)) {
    const selector = def.selectors?.[endpoint.selector]
    if (selector === undefined) {
      dangling(`missing selector '${endpoint.selector}'`)
    } else if (endpoint.candidate !== undefined &&
               !selector.candidates.some((candidate) => candidate.id === endpoint.candidate)) {
      dangling(`missing selector candidate '${endpoint.selector}/${endpoint.candidate}'`)
    } else if (side === 'from' && endpoint.candidate !== undefined) {
      dangling(`selector candidate '${endpoint.selector}/${endpoint.candidate}' cannot produce`)
    } else if (side === 'to' && endpoint.candidate === undefined) {
      dangling(`selector output '${endpoint.selector}' cannot consume`)
    }
    return
  }
  if (isWidgetTapRef(endpoint)) {
    if (def.nodes[endpoint.node] === undefined) dangling(`missing tap node '${endpoint.node}'`)
    else if (side === 'to') dangling(`widget tap '${endpoint.node}.${endpoint.tap}' cannot consume`)
    return
  }
  const node = def.nodes[endpoint.node]
  if (node === undefined) {
    dangling(`missing node '${endpoint.node}'`)
  } else if (resolveDynamicAddress(endpoint, node.dynamic).kind === 'missing') {
    diags.push(diag(
      'error',
      'invariant',
      'doc.dynamic.memberMissing',
      `${where}: references an unmaterialized dynamic member on '${endpoint.node}.${endpoint.port}'`,
    ))
  }
}

function projectedDeliveryEndpoints(
  doc: WorkflowDocument,
  delivery: ParentDeliveryIdentity,
): readonly { readonly side: 'from' | 'to'; readonly endpoint: PortRef }[] | undefined {
  const def = doc.graphs[delivery.graph]
  if (def === undefined) return undefined
  if (delivery.kind === 'link') {
    const link = def.links[delivery.linkId]
    if (link === undefined) return undefined
    const endpoints: { side: 'from' | 'to'; endpoint: PortRef }[] = []
    if (isPortEndpoint(link.from)) endpoints.push({ side: 'from', endpoint: link.from })
    if (isPortEndpoint(link.to)) endpoints.push({ side: 'to', endpoint: link.to })
    return endpoints
  }
  const net = def.nets[delivery.netId]
  if (net === undefined || !net.sinks.some((sink) => samePortRef(sink, delivery.to)))
    return undefined
  return [
    { side: 'from', endpoint: net.source },
    { side: 'to', endpoint: delivery.to },
  ]
}

function checkOccurrenceTopologies(doc: WorkflowDocument, diags: Diagnostic[]): void {
  for (const [key, topology] of Object.entries(doc.occurrenceTopologies ?? {})) {
    const where = `[occurrence topology ${JSON.stringify(key)}]`
    if (occurrenceKey(topology.owner) !== key) {
      diags.push(diag(
        'error',
        'invariant',
        'doc.occurrenceTopology.keyMismatch',
        `${where} key does not equal occurrenceKey(owner)`,
      ))
    }
    const chain = resolveOccurrenceChain(doc, topology.owner)
    if (chain === undefined) {
      diags.push(diag(
        'error',
        'invariant',
        'doc.occurrenceTopology.ownerMissing',
        `${where} owner path does not resolve through subgraph occurrences`,
      ))
      continue
    }
    if (chain[chain.length - 1]!.bodyGraphId !== topology.bodyGraph) {
      diags.push(diag(
        'error',
        'invariant',
        'doc.occurrenceTopology.bodyMismatch',
        `${where} bodyGraph '${topology.bodyGraph}' does not match owner body '${chain[chain.length - 1]!.bodyGraphId}'`,
      ))
      continue
    }
    const body = doc.graphs[topology.bodyGraph]!
    if (topologyIdentityContainsNul(key, topology)) {
      diags.push(diag(
        'error',
        'invariant',
        'doc.occurrenceTopology.projectedId',
        `${where} persists a NUL-projected identity`,
      ))
    }

    const seenLinkIds = new Set<string>()
    for (const [linkKey, link] of Object.entries(topology.links)) {
      if (linkKey !== link.id) {
        diags.push(diag(
          'error',
          'invariant',
          'doc.occurrenceTopology.linkKeyMismatch',
          `${where} link key '${linkKey}' != id '${link.id}'`,
        ))
      }
      if (seenLinkIds.has(link.id)) {
        diags.push(diag(
          'error',
          'invariant',
          'doc.occurrenceTopology.linkDuplicate',
          `${where} duplicate local link id '${link.id}'`,
        ))
      }
      seenLinkIds.add(link.id)
      const parsed = parseAllocatedId(link.id)
      if (parsed !== undefined) {
        const cursor = parsed.actor === undefined
          ? topology.nextOrdinal
          : actorCursorOf(topology.actorCursors, parsed.actor)
        if (parsed.ordinal >= cursor) {
          diags.push(diag(
            'error',
            'invariant',
            'doc.occurrenceTopology.idAboveCursor',
            `${where} link id '${link.id}' is at or above its allocator cursor ${cursor}`,
          ))
        }
      }

      for (const [side, endpoint] of [['from', link.from], ['to', link.to]] as const) {
        if (endpoint.kind === 'body') {
          if (side === 'from' && isPortEndpoint(endpoint.endpoint) &&
              endpoint.endpoint.node === '$region' && endpoint.endpoint.port === 'index' &&
              endpoint.endpoint.members === undefined && chain[chain.length - 1]!.node.region !== undefined) continue
          checkOccurrenceBodyEndpoint(body, endpoint.endpoint, side, `${where} link '${link.id}' ${side}`, diags)
          continue
        }
        const startIndex = chain.findIndex((hop) => sameOccurrenceRef(hop.ref, endpoint.occurrence))
        if (startIndex < 0) {
          diags.push(diag(
            'error',
            'invariant',
            'doc.occurrenceTopology.boundaryOccurrence',
            `${where} link '${link.id}' ${side} boundary occurrence is not owner or ancestor`,
          ))
        } else if (!routeMatchesOwnerChain(doc, chain, startIndex, side, endpoint.address, endpoint.route)) {
          diags.push(diag(
            'error',
            'invariant',
            'doc.occurrenceTopology.routeInvalid',
            `${where} link '${link.id}' ${side} boundary route is stale or does not reach bodyGraph`,
          ))
        }
      }
    }

    for (const suppression of topology.suppressedDeliveries ?? []) {
      if (suppression.kind === 'link') {
        // Shared-link tombstones are intentionally valid after deletion:
        // graph link ids are never reused, so they cannot hide a new link.
        continue
      }
      if (suppression.kind === 'netSink') {
        const net = body.nets[suppression.netId]
        if (net === undefined || !net.sinks.some((sink) => samePortRef(sink, suppression.to))) {
          diags.push(diag(
            'error',
            'invariant',
            'doc.occurrenceTopology.suppressionDangling',
            `${where} net-sink suppression does not name a current body delivery`,
          ))
        }
        continue
      }
      const endpoints = projectedDeliveryEndpoints(doc, suppression.delivery)
      const matches = endpoints?.filter(({ side, endpoint }) => {
        const startIndex = chain.findIndex((hop) =>
          hop.parentGraphId === suppression.delivery.graph && hop.ref.node === endpoint.node)
        return startIndex >= 0 &&
          routeMatchesOwnerChain(doc, chain, startIndex, side, endpoint, suppression.route)
      }) ?? []
      if (matches.length !== 1) {
        diags.push(diag(
          'error',
          'invariant',
          endpoints === undefined
            ? 'doc.occurrenceTopology.suppressionDangling'
            : 'doc.occurrenceTopology.routeInvalid',
          `${where} projected-leg suppression does not identify one current parent delivery route`,
        ))
      }
    }
  }
}

function checkGraphDef(doc: WorkflowDocument, defId: string, def: GraphDef, diags: Diagnostic[]) {
  const where = (msg: string) => `[${defId}] ${msg}`

  // I6: record ids and check allocation cursors. Canonical solo ids
  // (`n5`) check against nextOrdinal; canonical actor-suffixed ids
  // (`n5-<actor>`, shared sessions) check against that actor's own cursor
  // in actorCursors - an id at/above its cursor could be reminted.
  // Non-canonical lookalikes pass free: they were not allocator-minted and
  // cannot collide with minted ids (parseAllocatedId's discipline).
  const seen = new Set<string>()
  const checkId = (id: string, kind: string) => {
    if (seen.has(id)) {
      diags.push(diag('error', 'invariant', 'doc.id.duplicate', where(`duplicate ${kind} id '${id}'`)))
    }
    seen.add(id)
    checkCursor(id, kind)
  }
  // Allocation-cursor gate alone: for ids whose UNIQUENESS scope is narrower
  // than the graph (selector candidates are addressed as (selector,
  // candidate) pairs, and legitimate producers reuse candidate ids across
  // selectors), but which still mint from the graph allocator when created
  // by commands - so a canonical id at/above its cursor is corruption.
  const checkCursor = (id: string, kind: string) => {
    const parsed = parseAllocatedId(id)
    if (!parsed) return
    if (parsed.actor === undefined) {
      if (parsed.ordinal >= def.nextOrdinal) {
        diags.push(
          diag('error', 'invariant', 'doc.id.aboveCursor', where(`${kind} id '${id}' >= nextOrdinal ${def.nextOrdinal}`)),
        )
      }
    } else {
      const cursor = actorCursorOf(def.actorCursors, parsed.actor)
      if (parsed.ordinal >= cursor) {
        diags.push(
          diag('error', 'invariant', 'doc.id.aboveCursor', where(`${kind} id '${id}' >= actor cursor ${cursor} for actor '${parsed.actor}'`)),
        )
      }
    }
  }

  for (const [key, node] of Object.entries(def.nodes)) {
    if (key !== node.id) {
      diags.push(diag('error', 'invariant', 'doc.node.keyMismatch', where(`node key '${key}' != id '${node.id}'`)))
    }
    checkId(node.id, 'node')
    // I1: subgraph references resolve
    const ref = subgraphDefIdOf(node.type)
    if (ref !== undefined && !doc.graphs[ref]) {
      diags.push(
        diag('error', 'invariant', 'doc.subgraph.dangling', where(`node '${node.id}' references missing definition '${ref}'`), {
          anchor: { occurrence: { instancePath: [], node: asNodeId(node.id) } },
        }),
      )
    }
    if (node.region !== undefined) checkRegion(doc, defId, node, node.region, diags)
  }

  // I9: reroute key/id consistency + id allocation
  for (const [key, reroute] of Object.entries(def.reroutes)) {
    if (key !== reroute.id) {
      diags.push(diag('error', 'invariant', 'doc.reroute.keyMismatch', where(`reroute key '${key}' != id '${reroute.id}'`)))
    }
    checkId(reroute.id, 'reroute')
  }

  // I10: value source key/id consistency + id allocation
  for (const [key, vs] of Object.entries(def.valueSources ?? {})) {
    if (key !== vs.id) {
      diags.push(diag('error', 'invariant', 'doc.valueSource.keyMismatch', where(`value source key '${key}' != id '${vs.id}'`)))
    }
    checkId(vs.id, 'value source')
  }

  // I11: selector key/id consistency, id allocation, candidate ids, policy
  for (const [key, sel] of Object.entries(def.selectors ?? {})) {
    if (key !== sel.id) {
      diags.push(diag('error', 'invariant', 'doc.selector.keyMismatch', where(`selector key '${key}' != id '${sel.id}'`)))
    }
    checkId(sel.id, 'selector')
    const candidateIds = new Set<string>()
    for (const c of sel.candidates) {
      if (candidateIds.has(c.id)) {
        diags.push(diag('error', 'invariant', 'doc.selector.candidateDuplicate', where(`selector '${sel.id}' has duplicate candidate id '${c.id}'`)))
      }
      // Candidate identity is selector-scoped (selectorCandidateKey), so no
      // graph-wide duplicate check - but command-created candidates mint
      // from the graph allocator, so canonical ids still take the cursor
      // gate (solo nextOrdinal or actorCursors[actor]).
      checkCursor(c.id, 'selector candidate')
      candidateIds.add(c.id)
    }
    if (sel.policy.kind === 'fixed' && !candidateIds.has(sel.policy.candidate)) {
      diags.push(diag('error', 'invariant', 'doc.selector.policyDangling', where(`selector '${sel.id}' fixed policy names missing candidate '${sel.policy.candidate}'`)))
    }
  }

  const nodeExists = (n: NodeId) => def.nodes[n] !== undefined
  const drivenInputs = new Map<string, string>() // portRefKey -> driver description
  // rerouteId -> first driving link; doubles as the driver index for the
  // acyclicity walk below (one pass over links, never O(R x L) rescans).
  const drivenReroutes = new Map<string, LinkData>()
  // selectorCandidateKey -> first driving link (one driver per candidate).
  const drivenSelectorCandidates = new Map<string, LinkData>()
  // selectorId -> all candidate-driving links (drives the acyclicity walk:
  // a selector's output depends on every candidate because policy can change).
  const selectorDrivers = new Map<string, LinkData[]>()

  const checkEndpoint = (p: LinkEndpoint, what: string, code: string) => {
    if (isRerouteRef(p)) {
      if (!def.reroutes[p.reroute]) {
        diags.push(diag('error', 'invariant', code, where(`${what} references missing reroute '${p.reroute}'`)))
        return false
      }
      return true
    }
    if (isValueSourceRef(p)) {
      if (!def.valueSources?.[p.valueSource]) {
        diags.push(diag('error', 'invariant', code, where(`${what} references missing value source '${p.valueSource}'`)))
        return false
      }
      return true
    }
    if (isSelectorRef(p)) {
      const sel = def.selectors?.[p.selector]
      if (!sel) {
        diags.push(diag('error', 'invariant', code, where(`${what} references missing selector '${p.selector}'`)))
        return false
      }
      if (p.candidate !== undefined && !sel.candidates.some((c) => c.id === p.candidate)) {
        diags.push(diag('error', 'invariant', code, where(`${what} references missing candidate '${p.candidate}' of selector '${p.selector}'`)))
        return false
      }
      return true
    }
    if (isWidgetTapRef(p)) {
      if (!nodeExists(p.node)) {
        diags.push(diag('error', 'invariant', code, where(`${what} references missing node '${p.node}'`)))
        return false
      }
      return true
    }
    if (!nodeExists(p.node)) {
      diags.push(diag('error', 'invariant', code, where(`${what} references missing node '${p.node}'`)))
      return false
    }
    if (resolveDynamicAddress(p, def.nodes[p.node]?.dynamic).kind === 'missing') {
      diags.push(diag(
        'error',
        'invariant',
        'doc.dynamic.memberMissing',
        where(`${what} references an unmaterialized dynamic member on '${p.node}.${p.port}'`),
      ))
      return false
    }
    return true
  }

  const claimInput = (p: PortRef, driver: string) => {
    const key = portRefKey(p)
    const existing = drivenInputs.get(key)
    if (existing !== undefined) {
      diags.push(
        diag('error', 'invariant', 'doc.input.multiDriver', where(`input ${p.node}.${p.port} driven by both ${existing} and ${driver}`)),
      )
    } else {
      drivenInputs.set(key, driver)
    }
  }

  // I3 + I5 + I9: links
  for (const [key, link] of Object.entries(def.links)) {
    if (key !== link.id) {
      diags.push(diag('error', 'invariant', 'doc.link.keyMismatch', where(`link key '${key}' != id '${link.id}'`)))
    }
    checkId(link.id, 'link')
    if (checkEndpoint(link.from, `link '${link.id}' source`, 'doc.link.dangling')) {
      if (isSelectorRef(link.from) && link.from.candidate !== undefined) {
        // I11: candidate endpoints consume, never produce
        diags.push(
          diag('error', 'invariant', 'doc.link.selectorCandidateSource', where(`link '${link.id}' sources selector candidate '${link.from.selector}/${link.from.candidate}' (candidates cannot produce)`)),
        )
      }
    }
    if (checkEndpoint(link.to, `link '${link.id}' target`, 'doc.link.dangling')) {
      if (isValueSourceRef(link.to)) {
        // I10: value sources produce, never consume
        diags.push(
          diag('error', 'invariant', 'doc.link.valueSourceTarget', where(`link '${link.id}' targets value source '${link.to.valueSource}' (value sources cannot consume)`)),
        )
      } else if (isWidgetTapRef(link.to)) {
        diags.push(diag('error', 'invariant', 'doc.link.tapTarget', where(`link '${link.id}' targets widget tap '${link.to.node}.${link.to.tap}' (taps cannot consume)`)))
      } else if (isSelectorRef(link.to)) {
        if (link.to.candidate === undefined) {
          // I11: the selector output produces, never consumes
          diags.push(
            diag('error', 'invariant', 'doc.link.selectorOutputTarget', where(`link '${link.id}' targets selector '${link.to.selector}' output (outputs cannot consume)`)),
          )
        } else {
          // I11: at most one driver per candidate
          const key = selectorCandidateKey(link.to.selector, link.to.candidate)
          const existing = drivenSelectorCandidates.get(key)
          if (existing !== undefined) {
            diags.push(
              diag('error', 'invariant', 'doc.selector.multiDriver', where(`selector candidate '${link.to.selector}/${link.to.candidate}' driven by both link '${existing.id}' and link '${link.id}'`)),
            )
          } else {
            drivenSelectorCandidates.set(key, link)
            const list = selectorDrivers.get(link.to.selector)
            if (list) list.push(link)
            else selectorDrivers.set(link.to.selector, [link])
          }
        }
      } else if (isRerouteRef(link.to)) {
        // I9: at most one driver per reroute
        const existing = drivenReroutes.get(link.to.reroute)
        if (existing !== undefined) {
          diags.push(
            diag('error', 'invariant', 'doc.reroute.multiDriver', where(`reroute '${link.to.reroute}' driven by both link '${existing.id}' and link '${link.id}'`)),
          )
        } else {
          drivenReroutes.set(link.to.reroute, link)
        }
      } else {
        claimInput(link.to, `link '${link.id}'`)
      }
    }
  }

  // I9 + I11: reroute/selector driver chains are acyclic. A selector output
  // depends on every candidate (policy can change after the fact), and a tap
  // depends on its input driver, so the walk follows all persisted aliases.
  {
    const state = new Map<string, 'visiting' | 'done'>()
    const follow = (from: LinkEndpoint) => {
      if (isRerouteRef(from)) visit(`r:${from.reroute}`)
      else if (isSelectorRef(from) && from.candidate === undefined) visit(`s:${from.selector}`)
      else if (isWidgetTapRef(from)) visit(`t:${portRefKey({ node: from.node, port: from.tap })}`)
    }
    const visit = (key: string) => {
      const s = state.get(key)
      if (s === 'done') return
      if (s === 'visiting') {
        const [kind, id] = [key.slice(0, 1), key.slice(2)]
        diags.push(
          kind === 'r'
            ? diag('error', 'invariant', 'doc.reroute.cycle', where(`reroute chain through '${id}' forms a cycle`))
            : kind === 's'
              ? diag('error', 'invariant', 'doc.selector.cycle', where(`selector chain through '${id}' forms a cycle`))
              : diag('error', 'invariant', 'doc.tap.cycle', where(`widget tap chain through '${id}' forms a cycle`)),
        )
        state.set(key, 'done')
        return
      }
      state.set(key, 'visiting')
      if (key.startsWith('r:')) {
        const driver = drivenReroutes.get(key.slice(2))
        if (driver) follow(driver.from)
      } else if (key.startsWith('s:')) {
        for (const driver of selectorDrivers.get(key.slice(2)) ?? []) follow(driver.from)
      } else {
        const inputKey = key.slice(2)
        const link = Object.values(def.links).find((candidate) =>
          !isRerouteRef(candidate.to) && !isSelectorRef(candidate.to) &&
          !isValueSourceRef(candidate.to) && !isWidgetTapRef(candidate.to) &&
          portRefKey(candidate.to) === inputKey)
        if (link) follow(link.from)
        else {
          const net = Object.values(def.nets).find((candidate) =>
            candidate.sinks.some((sink) => portRefKey(sink) === inputKey))
          if (net) follow(net.source)
        }
      }
      if (state.get(key) === 'visiting') state.set(key, 'done')
    }
    for (const id of Object.keys(def.reroutes)) visit(`r:${id}`)
    for (const id of Object.keys(def.selectors ?? {})) visit(`s:${id}`)
    for (const link of Object.values(def.links)) if (isWidgetTapRef(link.from)) follow(link.from)
  }

  // I4 + I5: nets
  for (const [key, net] of Object.entries(def.nets)) {
    if (key !== net.id) {
      diags.push(diag('error', 'invariant', 'doc.net.keyMismatch', where(`net key '${key}' != id '${net.id}'`)))
    }
    checkId(net.id, 'net')
    checkEndpoint(net.source, `net '${net.name}' source`, 'doc.net.dangling')
    for (const sink of net.sinks) {
      if (checkEndpoint(sink, `net '${net.name}' sink`, 'doc.net.dangling')) {
        claimInput(sink, `net '${net.name}'`)
      }
    }
  }

  // I7: boundary bindings
  if (def.boundary) {
    const boundaryIds = new Set<string>()
    for (const side of ['inputs', 'outputs'] as const) {
      for (const item of def.boundary[side]) {
        if (boundaryIds.has(item.id)) {
          diags.push(diag('error', 'invariant', 'doc.boundary.duplicateId', where(`duplicate boundary id '${item.id}'`)))
        }
        boundaryIds.add(item.id)
        for (const b of [item.binds, ...(item.alsoBinds ?? [])]) {
          if (!nodeExists(b.node)) {
            diags.push(
              diag('error', 'invariant', 'doc.boundary.dangling', where(`boundary ${side.slice(0, -1)} '${item.id}' binds missing node '${b.node}'`)),
            )
          }
        }
      }
    }
  }
}

function checkRegion(
  doc: WorkflowDocument,
  graphId: string,
  node: NodeData,
  region: RegionContract,
  diags: Diagnostic[],
): void {
  const shapeProblems = regionContractShapeProblems(region)
  if (shapeProblems.length > 0) {
    for (const problem of shapeProblems) {
      diags.push(diag('error', 'invariant', 'doc.region.shapeInvalid', `[${graphId}] region '${node.id}'${problem.field}: ${problem.message}`, {
        refs: [{ graphId, nodeId: node.id as string }],
      }))
    }
    return
  }
  const ref = subgraphDefIdOf(node.type)
  const body = ref === undefined ? undefined : doc.graphs[ref]
  const report = (severity: 'error' | 'warning', code: string, message: string, portId?: string, direction?: 'input' | 'output') => {
    diags.push(diag(severity, 'invariant', code, `[${graphId}] region '${node.id}': ${message}`, {
      refs: [{ graphId, nodeId: node.id as string, ...(portId !== undefined && direction !== undefined ? { portId, direction } : {}) }],
    }))
  }

  if (ref === undefined) {
    report('error', 'doc.region.notSubgraph', `region contract requires a subgraph occurrence, got '${node.type}'`)
    return
  }
  if (!body?.boundary) {
    // The ordinary dangling-subgraph invariant reports a missing body. This
    // diagnostic covers a present definition without an instance boundary.
    if (body !== undefined) report('error', 'doc.region.boundaryMissing', `body definition '${ref}' has no boundary`)
    return
  }

  const inputIds = new Set(body.boundary.inputs.map((item) => item.id as string))
  const outputIds = new Set(body.boundary.outputs.map((item) => item.id as string))
  const elements = new Set(region.elementPorts ?? [])
  const states = new Set(region.statePorts ?? [])
  const outputRoles = region.outputRoles ?? {}
  const hasInput = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(node.values, id) ||
    Object.values(doc.graphs[graphId]!.links).some((link) =>
      !isRerouteRef(link.to) && !isValueSourceRef(link.to) && !isSelectorRef(link.to) && !isWidgetTapRef(link.to) &&
      link.to.node === node.id && link.to.port === id) ||
    Object.values(doc.graphs[graphId]!.nets).some((net) => net.sinks.some((sink) => sink.node === node.id && sink.port === id))

  for (const id of elements) {
    if (!inputIds.has(id)) report('error', 'doc.region.elementPortUndeclared', `element port '${id}' is not a boundary input`, id, 'input')
    if (states.has(id)) report('error', 'doc.region.portRoleOverlap', `input '${id}' is both an element and state port`, id, 'input')
    const boundary = body.boundary.inputs.find((item) => item.id === id)
    if (boundary?.promoted === true) {
      report('error', 'doc.region.elementPromoted', `element port '${id}' cannot promote a scalar widget`, id, 'input')
    }
    if (inputIds.has(id) && !hasInput(id)) report('error', 'doc.region.inputMissing', `element port '${id}' has no outer input`, id, 'input')
  }
  for (const id of states) {
    if (!inputIds.has(id)) report('error', 'doc.region.statePortUndeclared', `state port '${id}' is not a boundary input`, id, 'input')
    if (inputIds.has(id) && !hasInput(id)) report('error', 'doc.region.inputMissing', `state port '${id}' has no initial value`, id, 'input')
  }
  const stateTargets = new Map<string, string>()
  for (const [id, role] of Object.entries(outputRoles)) {
    const declaredOutput = outputIds.has(id)
    if (!declaredOutput) report('error', 'doc.region.outputUndeclared', `${role.kind} output '${id}' is not a boundary output`, id, 'output')
    if (id === region.continueOutput) {
      report('error', 'doc.region.outputContinueOverlap', `output '${id}' cannot have a role and be the continuation output`, id, 'output')
    }
    if (role.kind === 'state') {
      if (!states.has(role.statePort) || !inputIds.has(role.statePort)) {
        report('error', 'doc.region.statePortMissing', `state output '${id}' names undeclared state input '${role.statePort}'`, id, 'output')
      }
      if (declaredOutput) {
        const previous = stateTargets.get(role.statePort)
        if (previous !== undefined) {
          report('error', 'doc.region.stateOutputDuplicate', `state outputs '${previous}' and '${id}' both target state input '${role.statePort}'`, id, 'output')
        } else {
          stateTargets.set(role.statePort, id)
        }
      }
    }
  }
  for (const id of states) {
    if (!stateTargets.has(id)) {
      report('error', 'doc.region.stateOutputMissing', `state port '${id}' requires exactly one state-role output`, id, 'input')
    }
  }
  if (region.continueOutput !== undefined && !outputIds.has(region.continueOutput)) {
    report('error', 'doc.region.continueUndeclared', `continue output '${region.continueOutput}' is not a boundary output`, region.continueOutput, 'output')
  }
  if (![...outputIds].some((id) => id !== region.continueOutput)) {
    report('error', 'doc.region.outputRequired', 'region requires at least one exported boundary output')
  }
  if (region.maxIterations !== undefined && region.maxIterations < 1) {
    report('error', 'doc.region.maxIterations', 'maxIterations must be at least 1')
  }

  if (region.kind === 'map') {
    if (elements.size === 0) report('error', 'doc.region.mapElementRequired', 'map requires at least one element port')
    if (states.size > 0) report('error', 'doc.region.mapStateForbidden', 'map cannot declare state ports')
    if (region.continueOutput !== undefined) report('error', 'doc.region.continueForbidden', 'map cannot declare continueOutput')
  } else if (region.kind === 'fold') {
    if (elements.size === 0) report('error', 'doc.region.foldElementRequired', 'fold requires at least one element port')
    if (states.size === 0) report('error', 'doc.region.foldStateRequired', 'fold requires at least one state port')
    if (region.continueOutput !== undefined) report('error', 'doc.region.continueForbidden', 'fold cannot declare continueOutput')
  } else {
    if (elements.size > 0) report('error', 'doc.region.whileElementForbidden', 'while cannot declare element ports')
    if (states.size === 0) report('error', 'doc.region.whileStateRequired', 'while requires at least one state port')
    if (region.continueOutput === undefined) report('error', 'doc.region.whileContinueRequired', 'while requires continueOutput')
    if (region.maxIterations === undefined) report('error', 'doc.region.whileMaxIterationsRequired', 'while requires maxIterations')
    if (region.binding === 'cross') report('error', 'doc.region.whileCross', 'while cannot use cross binding')
    if (region.binding === 'broadcast') report('error', 'doc.region.whileBroadcast', 'while cannot use broadcast binding')
  }
}

/** I2: the definition-reference graph must be acyclic. */
function checkNoRecursion(doc: WorkflowDocument, diags: Diagnostic[]) {
  const refs = new Map<string, readonly string[]>()
  for (const [defId, def] of Object.entries(doc.graphs)) {
    const out: string[] = []
    for (const node of Object.values(def.nodes)) {
      const ref = subgraphDefIdOf(node.type)
      if (ref !== undefined && doc.graphs[ref]) out.push(ref)
    }
    refs.set(defId, out)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: readonly string[]) => {
    const s = state.get(id)
    if (s === 'done') return
    if (s === 'visiting') {
      diags.push(
        diag('error', 'invariant', 'doc.subgraph.recursive', `recursive subgraph definitions: ${[...path, id].join(' -> ')}`),
      )
      return
    }
    state.set(id, 'visiting')
    for (const next of refs.get(id) ?? []) visit(next, [...path, id])
    state.set(id, 'done')
  }
  for (const id of refs.keys()) visit(id, [])
}

/** I8: view state must not reference unknown defs/nodes (warnings; view is non-semantic). */
function checkViewState(doc: WorkflowDocument, diags: Diagnostic[]) {
  for (const [defId, graphView] of Object.entries(doc.view.graphs)) {
    const def = doc.graphs[defId]
    if (!def) {
      diags.push(diag('warning', 'invariant', 'doc.view.danglingGraph', `view state for missing graph '${defId}'`))
      continue
    }
    for (const nodeId of Object.keys(graphView.nodes)) {
      if (!def.nodes[nodeId]) {
        diags.push(diag('warning', 'invariant', 'doc.view.danglingNode', `[${defId}] view state for missing node '${nodeId}'`))
      }
    }
    for (const rerouteId of Object.keys(graphView.reroutes ?? {})) {
      if (!def.reroutes[rerouteId]) {
        diags.push(diag('warning', 'invariant', 'doc.view.danglingReroute', `[${defId}] view state for missing reroute '${rerouteId}'`))
      }
    }
    for (const vsId of Object.keys(graphView.valueSources ?? {})) {
      if (!def.valueSources?.[vsId]) {
        diags.push(diag('warning', 'invariant', 'doc.view.danglingValueSource', `[${defId}] view state for missing value source '${vsId}'`))
      }
    }
    for (const selId of Object.keys(graphView.selectors ?? {})) {
      if (!def.selectors?.[selId]) {
        diags.push(diag('warning', 'invariant', 'doc.view.danglingSelector', `[${defId}] view state for missing selector '${selId}'`))
      }
    }
    for (const netId of graphView.collapsedNets ?? []) {
      if (!def.nets[netId]) {
        diags.push(diag('warning', 'invariant', 'doc.view.danglingNet', `[${defId}] collapsedNets references missing net '${netId}'`))
      }
    }
    const collapsedSet = new Set(graphView.collapsedNets ?? [])
    for (const netId of graphView.guideNets ?? []) {
      if (!def.nets[netId]) {
        diags.push(diag('warning', 'invariant', 'doc.view.danglingNet', `[${defId}] guideNets references missing net '${netId}'`))
      } else if (!collapsedSet.has(netId)) {
        diags.push(diag('warning', 'invariant', 'doc.view.guideNotCollapsed', `[${defId}] guideNets entry '${netId}' is not collapsed`))
      }
    }
  }
}
