/**
 * Subgraph definition import: the write path for materializing prepackaged
 * subgraphs (pack blueprints, exported subgraphs) into a document.
 *
 * Schema-blind and deterministic like every core command: the caller
 * has already allocated fresh
 * definition ids and rewritten internal '#<id>' references; this command
 * validates STRUCTURE (fresh ids, key/id agreement, per-def shape) and
 * writes exactly the defs it was given. Referential integrity - subgraph
 * refs resolving, no recursion, ordinal cursors - is the invariant
 * checker's job and runs on the post-transaction document, so a bad import
 * rejects atomically.
 *
 * Import is COPY semantics by design: a materialized blueprint is a fresh
 * local definition with no link back to its source. Editing the local copy
 * never syncs anywhere, exactly like pasting.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { isForwardingBinding, MAX_DYNAMIC_STATE_DEPTH, type BoundaryBinding, type BoundaryItem, type BoundaryRouteLeg, type ControllerMode, type DynamicPortState, type GraphDef, type GraphViewState, type GroupViewState, type Json, type JsonObject, type LinkData, type NamedNetData, type NodeData, type OccurrenceLinkEndpoint, type OccurrenceTopology, type SelectorData, type SuppressedDelivery, type ValueSourceData, type WorkflowDocument } from '../format/document.js'
import { validateGraphDefShape, validateGraphViewShape } from '../format/validate.js'
import { actorCursorOf, asDynamicMemberId, asGraphDefId, asLinkId, asNetId, asNodeId, asPortId, asRerouteId, asSelectorCandidateId, asSelectorId, asValueSourceId, formatAllocatedId, isPortEndpoint, isRerouteRef, isSelectorRef, isValueSourceRef, isWidgetTapRef, occurrenceKey, portRefKey, sameEndpoint, type LinkEndpoint, type OccurrenceRef, type PortRef, type WidgetTapRef } from '../ids.js'
import { EXPOSED_EXT_KEY, parseExposedEntry } from '../format/exposed.js'
import { EXPOSED_PREVIEWS_EXT_KEY, parseExposedPreviewEntry } from '../format/exposed-previews.js'
import { APP_LAYOUT_EXT_KEY, localizeAppLayoutJson, removeAppLayoutGraphRefs } from '../format/app-layout.js'
import { checkDocument, subgraphDefIdOf } from '../invariants.js'
import {
  auditExtractionCuts,
  boundaryNameCandidates,
  canonicalizeLifecycleSelection,
  classifyFlattenBoundaryRoute,
  checkProspectiveExtractionDag,
  checkProspectiveFlattenDag,
  flattenShellRefusalDiagnostic,
  flattenRegistryMatchesSchemaPlan,
  hasSemanticLifecycleSelection,
  lifecycleCanonicalHash,
  missingLifecycleEntities,
  planBoundaryNames,
  planExtractedGeometry,
  planFlattenedGeometry,
  validateLifecycleGeometry,
  validateFlattenGeometry,
  verifyFlattenSchemaPlanDigest,
  verifyFlattenStatePlan,
  verifyLifecycleFlattenPlan,
  verifyLifecycleSelectionPlan,
  type BoundaryCut,
  type InputCutGroup,
  type LifecycleSelection,
  type FlattenRouteKind,
  type FlattenStatePlan,
  type ResolvedGeometryItem,
} from '../lifecycle/planner.js'
import { planFlattenOccurrenceTopology, type FlattenOccurrenceTopologyPlan } from '../compile/effective-topology.js'
import { matchBoundaryItem } from '../compile/crossing.js'
import { canonicalJson } from '../compile/hash.js'
import { resolveStaticWidgetTap } from '../schema/derive-boundary.js'
import { graphAllocator } from './alloc.js'
import type { CommandDefinition, CommandExecutionContext, TransactionBuilder } from './contract.js'
import { groupAllocationFloor } from '../group-alloc.js'
import { decodeModePanelConfig, MODE_PANEL_TYPE } from '../surfaces/mode-panel.js'
import { planSubgraphDefinitionCleanup } from '../lifecycle/definition-cleanup.js'
import { NET_VIEWS_EXT_KEY, netViewToJson, parseNetViewPosition, type NetViewGeometry } from '../format/net-views.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)
const warn = (code: string, message: string): Diagnostic => diag('warning', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const compareStrings = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

const lifecycleError = (
  code: string,
  message: string,
  graphId: string,
  instancePath: readonly string[],
  nodeId?: string,
  port?: PortRef,
): Diagnostic => diag('error', 'command', code, message, {
  refs: [{ graphId, ...(nodeId !== undefined ? { nodeId } : {}), ...(port !== undefined ? { portId: port.port } : {}) }],
  ...(nodeId !== undefined ? {
    anchor: {
      occurrence: { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) },
      ...(port !== undefined ? { port } : {}),
    },
  } : {}),
})

function contextResolves(doc: WorkflowDocument, graphId: string, instancePath: readonly string[]): boolean {
  let current = doc.graphs[doc.root]
  if (current === undefined) return false
  for (const nodeId of instancePath) {
    const node: NodeData | undefined = current.nodes[nodeId]
    const childId: string | undefined = node === undefined ? undefined : subgraphDefIdOf(node.type)
    current = childId === undefined ? undefined : doc.graphs[childId]
    if (current === undefined) return false
  }
  return current.id === graphId
}

function occurrenceRefIntersectsNodes(
  doc: WorkflowDocument,
  ref: { readonly instancePath: readonly string[]; readonly node: string },
  graphId: string,
  selectedNodes: ReadonlySet<string>,
): boolean {
  let graph = doc.graphs[doc.root]
  for (const hop of ref.instancePath) {
    if (graph?.id === graphId && selectedNodes.has(hop)) return true
    const node = graph?.nodes[hop]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    graph = childId === undefined ? undefined : doc.graphs[childId]
  }
  return graph?.id === graphId && selectedNodes.has(ref.node)
}

function occurrenceEndpointIntersectsSelection(
  endpoint: OccurrenceLinkEndpoint,
  topologyBody: string,
  graphId: string,
  selection: LifecycleSelection,
  doc: WorkflowDocument,
): boolean {
  const nodes = new Set(selection.nodeIds)
  const endpointSelected = (value: LinkEndpoint): boolean => {
    if (isPortEndpoint(value) || isWidgetTapRef(value)) return nodes.has(value.node)
    if (isRerouteRef(value)) return selection.rerouteIds.includes(value.reroute)
    if (isValueSourceRef(value)) return selection.valueSourceIds.includes(value.valueSource)
    return selection.selectorIds.includes(value.selector)
  }
  if (endpoint.kind === 'body') return topologyBody === graphId && endpointSelected(endpoint.endpoint)
  return occurrenceRefIntersectsNodes(doc, endpoint.occurrence, graphId, nodes) ||
    endpoint.route.some((leg) => leg.graph === graphId && nodes.has(leg.binding.node))
}

function extractionIntersectsOccurrenceTopology(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelection,
  excludedTopologyKey?: string,
): boolean {
  const selectedNodes = new Set(selection.nodeIds)
  for (const topology of Object.values(doc.occurrenceTopologies ?? {})) {
    if (occurrenceKey(topology.owner) === excludedTopologyKey) continue
    if (occurrenceRefIntersectsNodes(doc, topology.owner, graphId, selectedNodes)) return true
    for (const link of Object.values(topology.links)) {
      if (occurrenceEndpointIntersectsSelection(link.from, topology.bodyGraph, graphId, selection, doc) ||
          occurrenceEndpointIntersectsSelection(link.to, topology.bodyGraph, graphId, selection, doc)) return true
    }
    for (const suppression of topology.suppressedDeliveries ?? []) {
      if (suppression.kind === 'link' && topology.bodyGraph === graphId) {
        const link = doc.graphs[topology.bodyGraph]?.links[suppression.linkId]
        if (link !== undefined && (
          occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.from }, topology.bodyGraph, graphId, selection, doc) ||
          occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.to }, topology.bodyGraph, graphId, selection, doc)
        )) return true
      } else if (suppression.kind === 'netSink' && topology.bodyGraph === graphId) {
        const net = doc.graphs[topology.bodyGraph]?.nets[suppression.netId]
        if (selectedNodes.has(suppression.to.node) || (net !== undefined && selectedNodes.has(net.source.node))) return true
      } else if (suppression.kind === 'projectedLeg') {
        if (suppression.route.some((leg) => leg.graph === graphId && selectedNodes.has(leg.binding.node))) return true
        const deliveryGraph = doc.graphs[suppression.delivery.graph]
        if (deliveryGraph?.id !== graphId) continue
        if (suppression.delivery.kind === 'link') {
          const link = deliveryGraph.links[suppression.delivery.linkId]
          if (link !== undefined && (
            occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.from }, graphId, graphId, selection, doc) ||
            occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.to }, graphId, graphId, selection, doc)
          )) return true
        } else {
          const net = deliveryGraph.nets[suppression.delivery.netId]
          if (selectedNodes.has(suppression.delivery.to.node) || (net !== undefined && selectedNodes.has(net.source.node))) return true
        }
      }
    }
  }
  return false
}

function freshDefinitionId(doc: WorkflowDocument): string {
  let ordinal = 0
  while (Object.hasOwn(doc.graphs, `g${ordinal}`)) ordinal += 1
  return `g${ordinal}`
}

function freshDefinitionName(doc: WorkflowDocument): string {
  const names = new Set(Object.values(doc.graphs).map((graph) => graph.name))
  if (!names.has('New Subgraph')) return 'New Subgraph'
  let suffix = 2
  while (names.has(`New Subgraph ${suffix}`)) suffix += 1
  return `New Subgraph ${suffix}`
}

function remapPort(port: PortRef, nodeIds: ReadonlyMap<string, string>): PortRef {
  const node = nodeIds.get(port.node)
  if (node === undefined) throw new Error(`subgraph.extract: no node map for '${port.node}'`)
  return { ...port, node: asNodeId(node) }
}

interface ExtractIdMaps {
  readonly nodes: ReadonlyMap<string, string>
  readonly reroutes: ReadonlyMap<string, string>
  readonly valueSources: ReadonlyMap<string, string>
  readonly selectors: ReadonlyMap<string, string>
  readonly candidates: ReadonlyMap<string, string>
}

function remapEndpoint(endpoint: LinkEndpoint, ids: ExtractIdMaps): LinkEndpoint {
  const nodeIds = ids.nodes
  if (isPortEndpoint(endpoint)) return remapPort(endpoint, nodeIds)
  if (isWidgetTapRef(endpoint)) {
    const node = nodeIds.get(endpoint.node)
    if (node === undefined) throw new Error(`subgraph.extract: no node map for '${endpoint.node}'`)
    return { ...endpoint, node: asNodeId(node) }
  }
  if (isRerouteRef(endpoint)) {
    const reroute = ids.reroutes.get(endpoint.reroute)
    if (reroute === undefined) throw new Error(`subgraph.extract: no reroute map for '${endpoint.reroute}'`)
    return { reroute: asRerouteId(reroute) }
  }
  if (isValueSourceRef(endpoint)) {
    const valueSource = ids.valueSources.get(endpoint.valueSource)
    if (valueSource === undefined) throw new Error(`subgraph.extract: no value-source map for '${endpoint.valueSource}'`)
    return { valueSource: asValueSourceId(valueSource) }
  }
  const selector = ids.selectors.get(endpoint.selector)
  if (selector === undefined) throw new Error(`subgraph.extract: no selector map for '${endpoint.selector}'`)
  if (endpoint.candidate === undefined) return { selector: asSelectorId(selector) }
  const candidate = ids.candidates.get(JSON.stringify([endpoint.selector, endpoint.candidate]))
  if (candidate === undefined) throw new Error(`subgraph.extract: no selector candidate map for '${endpoint.candidate}'`)
  return { selector: asSelectorId(selector), candidate: asSelectorCandidateId(candidate) }
}

function remapBinding(binding: BoundaryBinding, nodeIds: ReadonlyMap<string, string>): BoundaryBinding {
  const node = nodeIds.get(binding.node)
  if (node === undefined) throw new Error(`subgraph.extract: no node map for '${binding.node}'`)
  return { ...binding, node: asNodeId(node) }
}

function bindingAsEndpoint(binding: BoundaryBinding): PortRef | Extract<LinkEndpoint, { readonly tap: string }> {
  return binding.kind === 'widgetTap'
    ? { node: binding.node, tap: binding.tap }
    : { node: binding.node, port: binding.port, ...(binding.members !== undefined ? { members: binding.members } : {}) }
}

function endpointKey(endpoint: LinkEndpoint): string {
  if (isRerouteRef(endpoint)) return canonicalJson(['reroute', endpoint.reroute])
  if (isValueSourceRef(endpoint)) return canonicalJson(['valueSource', endpoint.valueSource])
  if (isSelectorRef(endpoint)) return canonicalJson(['selector', endpoint.selector, endpoint.candidate ?? null])
  if (isWidgetTapRef(endpoint)) return canonicalJson(['tap', endpoint.node, endpoint.tap])
  return canonicalJson(['port', endpoint.node, endpoint.port, endpoint.members ?? []])
}

function parentPort(nodeId: string, port: string): PortRef {
  return { node: asNodeId(nodeId), port: port as PortRef['port'] }
}

function inputLinkForGroup(group: InputCutGroup, links: readonly LinkData[]): LinkData | undefined {
  if (group.source.kind !== 'link') return undefined
  const source = group.source
  if (source.linkId !== undefined) return links.find((link) => link.id === source.linkId)
  for (const target of group.targets) {
    const matching = links
      .filter((link) => sameEndpoint(link.from, source.endpoint))
      .filter((link) => isPortEndpoint(link.to) && portRefKey(link.to) === portRefKey(target))
      .sort((a, b) => compareStrings(a.id, b.id))[0]
    if (matching !== undefined) return matching
  }
  return undefined
}

function portRefFromJson(value: Json): PortRef | undefined {
  if (!isObj(value) || typeof value.node !== 'string' || typeof value.port !== 'string') return undefined
  if (value.members !== undefined && (!Array.isArray(value.members) || value.members.length === 0 ||
      !value.members.every((member) => typeof member === 'string' && member.length > 0))) return undefined
  return {
    node: asNodeId(value.node),
    port: value.port as PortRef['port'],
    ...(Array.isArray(value.members) ? { members: value.members.map((member) => asDynamicMemberId(member as string)) } : {}),
  }
}

function rewriteEnclosingInput(
  item: BoundaryItem,
  cut: BoundaryCut,
  occurrenceId: string,
  boundaryId: string,
): BoundaryItem {
  const moved = new Set(cut.movedBindings)
  const bindings = [item.binds, ...(item.alsoBinds ?? [])]
  const rewritten: BoundaryBinding[] = []
  let inserted = false
  for (const binding of bindings) {
    if (moved.has(binding)) {
      if (!inserted) {
        rewritten.push(isForwardingBinding(binding)
          ? {
              kind: binding.kind,
              node: asNodeId(occurrenceId),
              port: boundaryId as PortRef['port'],
              ...(binding.slots !== undefined ? { slots: binding.slots } : {}),
            }
          : { kind: 'port', node: asNodeId(occurrenceId), port: boundaryId as PortRef['port'] })
        inserted = true
      }
    } else {
      rewritten.push(binding)
    }
  }
  const { alsoBinds: _oldAlsoBinds, ...rest } = item
  return {
    ...rest,
    binds: rewritten[0]!,
    ...(rewritten.length > 1 ? { alsoBinds: rewritten.slice(1) } : {}),
  }
}

function makeInnerAllocator(actor: string | undefined): {
  mint(prefix: 'n' | 'v' | 's' | 'c' | 'r' | 'l' | 'net'): string
  cursor(): Pick<GraphDef, 'nextOrdinal' | 'actorCursors'>
} {
  let ordinal = 0
  return {
    mint(prefix) {
      return formatAllocatedId(prefix, ordinal++, actor)
    },
    cursor() {
      return actor === undefined
        ? { nextOrdinal: ordinal }
        : { nextOrdinal: 0, actorCursors: { [actor]: ordinal } }
    },
  }
}

function geometryItemsFromJson(value: Json | undefined): ResolvedGeometryItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: ResolvedGeometryItem[] = []
  for (const item of value) {
    if (!isObj(item) || typeof item.id !== 'string' ||
        !['node', 'reroute', 'valueSource', 'selector', 'group'].includes(String(item.kind)) ||
        !['x', 'y', 'width', 'height'].every((key) => typeof item[key] === 'number')) return undefined
    result.push({
      id: item.id,
      kind: item.kind as ResolvedGeometryItem['kind'],
      x: item.x as number,
      y: item.y as number,
      width: item.width as number,
      height: item.height as number,
    })
  }
  return result
}

function translatedPosition(
  geometry: ReadonlyMap<string, ResolvedGeometryItem>,
  kind: ResolvedGeometryItem['kind'],
  oldId: string,
): { x: number; y: number } {
  const item = geometry.get(`${kind}\u0000${oldId}`)
  if (item === undefined) throw new Error(`subgraph.extract: missing translated geometry for ${kind} '${oldId}'`)
  return { x: item.x, y: item.y }
}

function remapNestedItem(
  cut: BoundaryCut,
  nodeIds: ReadonlyMap<string, string>,
  id: string,
): BoundaryItem {
  const nested = cut.nestedItem
  if (nested === undefined) throw new Error(`subgraph.extract: boundary '${cut.itemId}' has no nested item`)
  return {
    id,
    binds: remapBinding(nested.binds, nodeIds),
    ...(nested.alsoBinds !== undefined ? { alsoBinds: nested.alsoBinds.map((binding) => remapBinding(binding, nodeIds)) } : {}),
    ...(nested.promoted === true ? { promoted: true } : {}),
    ...(nested.displayName !== undefined ? { displayName: nested.displayName } : {}),
  }
}

function validateGroupMemberships(value: Json | undefined, selection: LifecycleSelection): boolean {
  if (selection.groupIds.length === 0) return value === undefined || Array.isArray(value)
  if (!Array.isArray(value)) return false
  const byId = new Map<string, JsonObject>()
  for (const entry of value) {
    if (!isObj(entry) || typeof entry.groupId !== 'string' || byId.has(entry.groupId)) return false
    for (const field of ['nodeIds', 'rerouteIds', 'valueSourceIds', 'selectorIds']) {
      const ids = entry[field]
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return false
    }
    byId.set(entry.groupId, entry)
  }
  if (byId.size !== selection.groupIds.length) return false
  const selected = {
    nodeIds: new Set(selection.nodeIds),
    rerouteIds: new Set(selection.rerouteIds),
    valueSourceIds: new Set(selection.valueSourceIds),
    selectorIds: new Set(selection.selectorIds),
  }
  return selection.groupIds.every((groupId) => {
    const membership = byId.get(groupId)
    return membership !== undefined && Object.entries(selected).every(([field, ids]) =>
      (membership[field] as Json[]).every((id) => ids.has(id as string)))
  })
}

function hasSelectedModePanelBinding(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelection,
): boolean {
  const nodes = new Set(selection.nodeIds)
  const groups = new Set(selection.groupIds)
  for (const surface of Object.values(doc.surfaces ?? {})) {
    if (surface.type !== MODE_PANEL_TYPE) continue
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) continue
    if (decoded.config.bindings.some((binding) =>
      binding.kind !== 'unknown' && binding.graphId === graphId &&
      (binding.kind === 'node' ? nodes.has(binding.nodeId) : groups.has(binding.groupId)))) return true
  }
  return false
}

function pointInsideGroup(position: { readonly x: number; readonly y: number }, group: GroupViewState): boolean {
  return position.x >= group.bounds.x && position.x <= group.bounds.x + group.bounds.width &&
    position.y >= group.bounds.y && position.y <= group.bounds.y + group.bounds.height
}

function emptiedParentGroups(
  view: GraphViewState,
  selection: LifecycleSelection,
  resolvedGeometry: readonly ResolvedGeometryItem[],
): readonly string[] {
  const movedInside = (group: GroupViewState): boolean => resolvedGeometry.some((item) => {
    if (item.kind === 'group') return false
    return pointInsideGroup({ x: item.x + item.width / 2, y: item.y + item.height / 2 }, group)
  })
  const hasRetainedPositionable =
    Object.keys(view.nodes).some((id) => !selection.nodeIds.includes(id)) ||
    Object.keys(view.reroutes ?? {}).some((id) => !selection.rerouteIds.includes(id)) ||
    Object.keys(view.valueSources ?? {}).some((id) => !selection.valueSourceIds.includes(id)) ||
    Object.keys(view.selectors ?? {}).some((id) => !selection.selectorIds.includes(id))
  if (hasRetainedPositionable) return []
  return Object.values(view.groups ?? {})
    .filter((group) => !selection.groupIds.includes(group.id) && movedInside(group))
    .map((group) => group.id)
    .sort(compareStrings)
}

// ---------------------------------------------------------------------------
// subgraph.import {graphs: {defId: GraphDef}, view?: {defId: GraphViewState}}
// ---------------------------------------------------------------------------

const subgraphImport: CommandDefinition = {
  id: 'subgraph.import',
  run(doc, params, tx) {
    if (!isObj(params) || !isObj(params.graphs))
      return [err('params.invalid', 'subgraph.import: params must be {graphs: {defId: GraphDef}, view?}')]
    const entries = Object.entries(params.graphs)
    if (entries.length === 0)
      return [err('params.invalid', 'subgraph.import: graphs must not be empty')]

    const diags: Diagnostic[] = []
    for (const [defId, def] of entries) {
      if (doc.graphs[defId] !== undefined) {
        diags.push(err('graph.exists', `subgraph.import: definition '${defId}' already exists`))
        continue
      }
      const shape = validateGraphDefShape(def, `graphs.${defId}`)
      diags.push(...shape.map((d) => ({ ...d, message: `subgraph.import: ${d.message}` })))
      if (shape.length === 0 && (def as JsonObject).id !== defId)
        diags.push(err('params.invalid', `subgraph.import: def key '${defId}' != id '${String((def as JsonObject).id)}'`))
    }

    const view = params.view
    if (view !== undefined) {
      if (!isObj(view)) return [...diags, err('params.invalid', 'subgraph.import: view must be an object')]
      for (const [defId, gv] of Object.entries(view)) {
        if (params.graphs[defId] === undefined) {
          diags.push(err('params.invalid', `subgraph.import: view for '${defId}' has no matching graph`))
          continue
        }
        const shape = validateGraphViewShape(gv, `view.${defId}`)
        diags.push(...shape.map((d) => ({ ...d, message: `subgraph.import: ${d.message}` })))
      }
    }
    if (diags.some((d) => d.severity === 'error')) return diags

    for (const [defId, def] of entries) {
      tx.set(['graphs', defId], def)
      const gv = view !== undefined && isObj(view) ? view[defId] : undefined
      tx.set(['view', 'graphs', defId], gv ?? { nodes: {} })
    }
    return diags
  },
}

// ---------------------------------------------------------------------------
// subgraph.extract
//
// L3 owns node-only extraction plus plain links, named nets, and enclosing
// boundary rewrites. Structural/view constructs assigned to L4 refuse here
// instead of being silently omitted from the extracted definition.
// ---------------------------------------------------------------------------

const subgraphExtract: CommandDefinition = {
  id: 'subgraph.extract',
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !Array.isArray(params.instancePath) ||
        !params.instancePath.every((id) => typeof id === 'string') || !isObj(params.selection) ||
        typeof params.selectionFingerprint !== 'string') {
      return [err('params.invalid', 'subgraph.extract: params must include graphId, instancePath, selection, and selectionFingerprint')]
    }
    const graphId = params.graphId
    const instancePath = params.instancePath as string[]
    if (!contextResolves(doc, graphId, instancePath)) {
      return [lifecycleError('subgraph.lifecycle.contextInvalid', `subgraph.extract: instance path does not resolve to graph '${graphId}'`, graphId, instancePath)]
    }
    const selectionFields = ['nodeIds', 'rerouteIds', 'valueSourceIds', 'selectorIds', 'groupIds'] as const
    for (const field of selectionFields) {
      const value = params.selection[field]
      if (value !== undefined && (!Array.isArray(value) || !value.every((id) => typeof id === 'string'))) {
        return [err('params.invalid', `subgraph.extract: selection.${field} must be an array of strings`)]
      }
    }
    const selection = canonicalizeLifecycleSelection({
      nodeIds: (params.selection.nodeIds ?? []) as string[],
      rerouteIds: (params.selection.rerouteIds ?? []) as string[],
      valueSourceIds: (params.selection.valueSourceIds ?? []) as string[],
      selectorIds: (params.selection.selectorIds ?? []) as string[],
      groupIds: (params.selection.groupIds ?? []) as string[],
    })
    if (!hasSemanticLifecycleSelection(selection)) {
      return [lifecycleError('subgraph.extract.empty', 'subgraph.extract: at least one node, value source, or selector must be selected', graphId, instancePath)]
    }
    const missing = missingLifecycleEntities(doc, graphId, selection)
    if (missing.length > 0) {
      return missing.map((entity) => lifecycleError(
        'subgraph.lifecycle.selectionMissing',
        `subgraph.extract: selected ${entity.kind} entity '${entity.id}' is missing`,
        graphId,
        instancePath,
        entity.kind === 'nodeIds' ? entity.id : selection.nodeIds[0],
      ))
    }
    if (extractionIntersectsOccurrenceTopology(doc, graphId, selection)) {
      return [lifecycleError(
        'subgraph.extract.occurrenceTopologyIntersect',
        'subgraph.extract: selection intersects occurrence-owned topology; explicit remapping is not available',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }
    const freshness = verifyLifecycleSelectionPlan(doc, {
      graphId,
      selection,
      selectionFingerprint: params.selectionFingerprint,
    })
    if (freshness.stale) {
      return [lifecycleError('subgraph.lifecycle.stalePlan', 'subgraph.extract: selected entities or incident topology changed after planning', graphId, instancePath, selection.nodeIds[0])]
    }

    const resolvedGeometry = geometryItemsFromJson(params.resolvedGeometry)
    if (resolvedGeometry === undefined || !isObj(params.placementCenter) ||
        typeof params.placementCenter.x !== 'number' || typeof params.placementCenter.y !== 'number') {
      return [err('params.invalid', 'subgraph.extract: placementCenter and resolvedGeometry are required')]
    }
    const geometryCoverage = validateLifecycleGeometry(selection, resolvedGeometry)
    const geometryPlan = geometryCoverage.complete
      ? planExtractedGeometry(resolvedGeometry, { x: params.placementCenter.x, y: params.placementCenter.y })
      : undefined
    if (geometryPlan === undefined) {
      return [lifecycleError(
        'subgraph.lifecycle.boundaryUnresolved',
        'subgraph.extract: resolved geometry must be finite, complete, unique, and selection-exact',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }
    if (!validateGroupMemberships(params.groupMemberships, selection)) {
      return [lifecycleError(
        'subgraph.lifecycle.boundaryUnresolved',
        'subgraph.extract: selected group membership snapshot is missing or not fully selected',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }
    if (hasSelectedModePanelBinding(doc, graphId, selection)) {
      return [lifecycleError(
        'subgraph.lifecycle.boundaryUnresolved',
        'subgraph.extract: selected nodes or groups have durable mode-panel bindings that cannot be remapped',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }

    const parent = doc.graphs[graphId]!
    if (!Array.isArray(params.specializedSlotRoots) || !Array.isArray(params.widgetTapSources)) {
      return [err('params.invalid', 'subgraph.extract: specializedSlotRoots and widgetTapSources coverage are required and must be arrays')]
    }
    const specializedSlotRoots: PortRef[] = []
    for (const value of params.specializedSlotRoots) {
      const parsed = portRefFromJson(value)
      if (parsed === undefined) return [err('params.invalid', 'subgraph.extract: specializedSlotRoots contains an invalid port reference')]
      specializedSlotRoots.push(parsed)
    }
    const widgetTapSources: WidgetTapRef[] = []
    for (const value of params.widgetTapSources) {
      if (!isObj(value) || Object.keys(value).length !== 2 ||
          typeof value.node !== 'string' || value.node.length === 0 ||
          typeof value.tap !== 'string' || value.tap.length === 0) {
        return [err('params.invalid', 'subgraph.extract: widgetTapSources contains an invalid widget tap reference')]
      }
      widgetTapSources.push({ node: asNodeId(value.node), tap: asPortId(value.tap) })
    }
    const audit = auditExtractionCuts(parent, selection, { specializedSlotRoots, widgetTapSources })
    if (audit.refusals.length > 0) {
      return audit.refusals.map((refusal) => {
        const port = refusal.endpoint !== undefined && isPortEndpoint(refusal.endpoint) ? refusal.endpoint : undefined
        const nodeId = port?.node ?? selection.nodeIds[0]
        return lifecycleError(refusal.code, `subgraph.extract: ${refusal.source} '${refusal.id}' cannot cross this extraction boundary`, graphId, instancePath, nodeId, port)
      })
    }
    const crossingWidgetTaps = audit.outputs
      .map((cut) => cut.source)
      .filter((source): source is WidgetTapRef => isWidgetTapRef(source))
    if (crossingWidgetTaps.length > 0 && context.kind === 'initial') {
      if (context.schemaResolverFor === undefined) {
        return [err('subgraph.extract.schemaAuthorityUnavailable', 'subgraph.extract: trusted schema authority is unavailable for a widget output boundary')]
      }
      try {
        const resolve = context.schemaResolverFor(doc)
        for (const source of crossingWidgetTaps) {
          const node = parent.nodes[source.node]
          const schema = node === undefined ? undefined : resolve(node.type)
          if (schema === undefined || !resolveStaticWidgetTap(schema, source.tap).ok) {
            return [lifecycleError(
              'subgraph.extract.widgetTapSchemaStale',
              `subgraph.extract: widget tap '${source.node}/${source.tap}' is not one exact static widget-backed input`,
              graphId,
              instancePath,
              source.node,
            )]
          }
        }
      } catch {
        return [err('subgraph.extract.widgetTapSchemaStale', 'subgraph.extract: widget tap schema validation failed')]
      }
    }
    const parentView = doc.view.graphs[graphId]
    const collapsedNets = new Set(parentView?.collapsedNets ?? [])
    const guideNets = new Set(parentView?.guideNets ?? [])

    const freshGraphId = freshDefinitionId(doc)
    const dag = checkProspectiveExtractionDag(doc, graphId, freshGraphId, selection.nodeIds)
    if (!dag.ok) {
      return [lifecycleError(dag.code ?? 'subgraph.lifecycle.recursive', 'subgraph.extract: prospective definition references are recursive', graphId, instancePath, selection.nodeIds[0])]
    }

    const parentCursor = tx.actor === undefined ? parent.nextOrdinal : actorCursorOf(parent.actorCursors, tx.actor)
    if (parentCursor >= Number.MAX_SAFE_INTEGER) {
      return [lifecycleError('subgraph.lifecycle.idExhausted', 'subgraph.extract: parent graph id space is exhausted', graphId, instancePath, selection.nodeIds[0])]
    }
    const parentAllocator = graphAllocator(tx, graphId, parent)
    const occurrenceId = parentAllocator.mint('n')
    const innerAllocator = makeInnerAllocator(tx.actor)
    const nodeIds = new Map<string, string>()
    const innerNodes: Record<string, NodeData> = {}
    for (const oldId of selection.nodeIds) {
      const id = innerAllocator.mint('n')
      nodeIds.set(oldId, id)
      innerNodes[id] = { ...parent.nodes[oldId]!, id: asNodeId(id) }
    }
    const valueSourceIds = new Map<string, string>()
    const innerValueSources: Record<string, ValueSourceData> = {}
    for (const oldId of selection.valueSourceIds) {
      const id = innerAllocator.mint('v')
      valueSourceIds.set(oldId, id)
      innerValueSources[id] = { ...parent.valueSources![oldId]!, id: asValueSourceId(id) }
    }
    const selectorIds = new Map<string, string>()
    const candidateIds = new Map<string, string>()
    const innerSelectors: Record<string, SelectorData> = {}
    for (const oldId of selection.selectorIds) {
      const selector = parent.selectors![oldId]!
      const id = innerAllocator.mint('s')
      selectorIds.set(oldId, id)
      const candidates = selector.candidates.map((candidate) => {
        const candidateId = innerAllocator.mint('c')
        candidateIds.set(JSON.stringify([oldId, candidate.id]), candidateId)
        return { ...candidate, id: asSelectorCandidateId(candidateId) }
      })
      const fixed = selector.policy.kind === 'fixed'
        ? candidateIds.get(JSON.stringify([oldId, selector.policy.candidate]))
        : undefined
      if (selector.policy.kind === 'fixed' && fixed === undefined) {
        return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.extract: selector '${oldId}' has an unmapped fixed candidate`, graphId, instancePath, selection.nodeIds[0])]
      }
      innerSelectors[id] = {
        ...selector,
        id: asSelectorId(id),
        candidates,
        policy: selector.policy.kind === 'fixed'
          ? { kind: 'fixed', candidate: asSelectorCandidateId(fixed!) }
          : { kind: 'random' },
      }
    }
    const rerouteIds = new Map<string, string>()
    const innerReroutes: GraphDef['reroutes'] extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.rerouteIds) {
      const id = innerAllocator.mint('r')
      rerouteIds.set(oldId, id)
      innerReroutes[id] = { ...parent.reroutes[oldId]!, id: asRerouteId(id) }
    }
    const idMaps: ExtractIdMaps = {
      nodes: nodeIds,
      valueSources: valueSourceIds,
      selectors: selectorIds,
      candidates: candidateIds,
      reroutes: rerouteIds,
    }

    const candidates = planBoundaryNames(boundaryNameCandidates(audit))
    const enclosingInputs = audit.boundaries.filter((cut) => cut.kind === 'in-cut')
    const enclosingFamilyOutputs = audit.boundaries.filter((cut) =>
      cut.kind === 'out-cut' && cut.nestedItem?.binds.kind === 'family')
    const inputNames = candidates.slice(0, audit.inputs.length)
    const enclosingInputNames = candidates.slice(audit.inputs.length, audit.inputs.length + enclosingInputs.length)
    const outputStart = audit.inputs.length + enclosingInputs.length
    const outputNames = candidates.slice(outputStart, outputStart + audit.outputs.length)
    const enclosingOutputNames = candidates.slice(outputStart + audit.outputs.length)
    const inputIdByBoundary = new Map(enclosingInputs.map((cut, index) => [cut.itemId, enclosingInputNames[index]!.id]))
    const outputIdBySource = new Map(audit.outputs.map((cut, index) => [endpointKey(cut.source), outputNames[index]!.id]))
    const outputIdByBoundary = new Map(enclosingFamilyOutputs.map((cut, index) => [cut.itemId, enclosingOutputNames[index]!.id]))

    const innerBoundaryInputs: BoundaryItem[] = audit.inputs.map((cut, index) => ({
      id: inputNames[index]!.id,
      binds: { kind: 'port', ...remapPort(cut.targets[0]!, nodeIds) },
      ...(cut.targets.length > 1 ? {
        alsoBinds: cut.targets.slice(1).map((target) => ({ kind: 'port' as const, ...remapPort(target, nodeIds) })),
      } : {}),
    }))
    for (const cut of enclosingInputs) {
      const itemId = inputIdByBoundary.get(cut.itemId)!
      innerBoundaryInputs.push(remapNestedItem(cut, nodeIds, itemId))
    }
    const innerBoundaryOutputs: BoundaryItem[] = audit.outputs.map((cut, index) => ({
      id: outputNames[index]!.id,
      binds: isWidgetTapRef(cut.source)
        ? { kind: 'widgetTap', node: asNodeId(nodeIds.get(cut.source.node)!), tap: cut.source.tap }
        : { kind: 'port', ...remapPort(cut.source, nodeIds) },
    }))
    for (const cut of enclosingFamilyOutputs) {
      innerBoundaryOutputs.push(remapNestedItem(cut, nodeIds, outputIdByBoundary.get(cut.itemId)!))
    }

    const parentLinks: Record<string, LinkData> = { ...parent.links }
    const innerLinks: Record<string, LinkData> = {}
    for (const cut of audit.links) {
      if (cut.kind === 'internal') {
        delete parentLinks[cut.id]
        const id = innerAllocator.mint('l')
        innerLinks[id] = {
          ...parent.links[cut.id]!,
          id: asLinkId(id),
          from: remapEndpoint(cut.from, idMaps),
          to: remapEndpoint(cut.to, idMaps),
        }
      }
    }
    for (const [index, group] of audit.inputs.entries()) {
      if (group.source.kind !== 'link') continue
      const source = group.source
      const targetKeys = new Set(group.targets.map(portRefKey))
      const groupLinks = audit.links.filter((cut) => {
        if (cut.kind !== 'in-cut' || !sameEndpoint(cut.from, source.endpoint) || !isPortEndpoint(cut.to)) return false
        return targetKeys.has(portRefKey(cut.to))
      })
      const retained = inputLinkForGroup(group, groupLinks.map((cut) => parent.links[cut.id]!))
      if (retained === undefined) throw new Error('subgraph.extract: planned input link is missing')
      for (const cut of groupLinks) delete parentLinks[cut.id]
      parentLinks[retained.id] = { ...retained, to: parentPort(occurrenceId, inputNames[index]!.id) }
    }
    for (const cut of audit.outputs) {
      const boundaryId = outputIdBySource.get(endpointKey(cut.source))!
      for (const linkCut of audit.links) {
        if (linkCut.kind === 'out-cut' && endpointKey(linkCut.from) === endpointKey(cut.source)) {
          parentLinks[linkCut.id] = { ...parent.links[linkCut.id]!, from: parentPort(occurrenceId, boundaryId) }
        }
      }
    }

    const parentNets: Record<string, NamedNetData> = { ...parent.nets }
    const innerNets: Record<string, NamedNetData> = {}
    const innerNetIds = new Map<string, string>()
    for (const cut of audit.nets) {
      const net = parent.nets[cut.id]!
      if (cut.kind === 'internal') {
        delete parentNets[cut.id]
        const id = innerAllocator.mint('net')
        innerNetIds.set(cut.id, id)
        innerNets[id] = {
          ...net,
          id: asNetId(id),
          source: remapPort(net.source, nodeIds),
          sinks: net.sinks.map((sink) => remapPort(sink, nodeIds)),
        }
      } else if (cut.kind === 'in-cut') {
        const inputIndex = audit.inputs.findIndex((group) => group.source.kind === 'net' && group.source.netId === cut.id)
        parentNets[cut.id] = {
          ...net,
          sinks: [...cut.outsideSinks, parentPort(occurrenceId, inputNames[inputIndex]!.id)],
        }
      } else if (cut.kind === 'out-cut') {
        const boundaryId = outputIdBySource.get(endpointKey(net.source))!
        parentNets[cut.id] = {
          ...net,
          source: parentPort(occurrenceId, boundaryId),
          sinks: cut.outsideSinks,
        }
        if (cut.insideSinks.length > 0) {
          const id = innerAllocator.mint('net')
          innerNetIds.set(cut.id, id)
          innerNets[id] = {
            ...net,
            id: asNetId(id),
            source: remapPort(net.source, nodeIds),
            sinks: cut.insideSinks.map((sink) => remapPort(sink, nodeIds)),
          }
        }
      }
    }

    let parentBoundary = parent.boundary
    if (parentBoundary !== undefined) {
      const inputs = [...parentBoundary.inputs]
      const outputs = [...parentBoundary.outputs]
      for (const cut of audit.boundaries) {
        if (cut.kind === 'in-cut') {
          inputs[cut.itemIndex] = rewriteEnclosingInput(inputs[cut.itemIndex]!, cut, occurrenceId, inputIdByBoundary.get(cut.itemId)!)
        } else if (cut.kind === 'out-cut') {
          const original = outputs[cut.itemIndex]!
          const source = cut.movedBindings[0]!
          const id = source.kind === 'family'
            ? outputIdByBoundary.get(cut.itemId)!
            : outputIdBySource.get(endpointKey(bindingAsEndpoint(source)))!
          outputs[cut.itemIndex] = {
            ...original,
            binds: {
              kind: source.kind === 'family' ? 'family' : 'port',
              node: asNodeId(occurrenceId),
              port: id as PortRef['port'],
              ...(source.kind === 'family' && source.slots !== undefined ? { slots: source.slots } : {}),
            },
          }
        }
      }
      parentBoundary = { inputs, outputs }
    }

    const parentNodes: Record<string, NodeData> = { ...parent.nodes }
    for (const id of selection.nodeIds) delete parentNodes[id]
    parentNodes[occurrenceId] = { id: asNodeId(occurrenceId), type: `#${freshGraphId}`, values: {} }
    const parentValueSources = { ...(parent.valueSources ?? {}) }
    for (const id of selection.valueSourceIds) delete parentValueSources[id]
    const parentSelectors = { ...(parent.selectors ?? {}) }
    for (const id of selection.selectorIds) delete parentSelectors[id]
    const parentReroutes = { ...parent.reroutes }
    for (const id of selection.rerouteIds) delete parentReroutes[id]
    const innerCursor = innerAllocator.cursor()
    const freshDefinition: GraphDef = {
      id: asGraphDefId(freshGraphId),
      name: typeof params.name === 'string' && params.name.trim().length > 0 ? params.name : freshDefinitionName(doc),
      nodes: innerNodes,
      links: innerLinks,
      nets: innerNets,
      reroutes: innerReroutes,
      ...(selection.valueSourceIds.length > 0 ? { valueSources: innerValueSources } : {}),
      ...(selection.selectorIds.length > 0 ? { selectors: innerSelectors } : {}),
      boundary: { inputs: innerBoundaryInputs, outputs: innerBoundaryOutputs },
      nextOrdinal: innerCursor.nextOrdinal,
      ...(innerCursor.actorCursors !== undefined ? { actorCursors: innerCursor.actorCursors } : {}),
    }
    const parentViewState = doc.view.graphs[graphId] ?? { nodes: {} }
    const emptiedGroups = emptiedParentGroups(parentViewState, selection, resolvedGeometry)
    const parentViewNodes = { ...parentViewState.nodes }
    for (const id of selection.nodeIds) delete parentViewNodes[id]

    const translatedGeometry = new Map(geometryPlan.items.map((item) => [`${item.kind}\u0000${item.id}`, item]))
    const innerViewNodes: GraphViewState['nodes'] extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.nodeIds) {
      const oldView = parentViewState.nodes[oldId]
      innerViewNodes[nodeIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'node', oldId),
      }
    }
    const parentViewReroutes = { ...(parentViewState.reroutes ?? {}) }
    const innerViewReroutes: NonNullable<GraphViewState['reroutes']> extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.rerouteIds) {
      const oldView = parentViewState.reroutes?.[oldId]
      delete parentViewReroutes[oldId]
      innerViewReroutes[rerouteIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'reroute', oldId),
      }
    }
    const parentViewValueSources = { ...(parentViewState.valueSources ?? {}) }
    const innerViewValueSources: NonNullable<GraphViewState['valueSources']> extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.valueSourceIds) {
      const oldView = parentViewState.valueSources?.[oldId]
      delete parentViewValueSources[oldId]
      innerViewValueSources[valueSourceIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'valueSource', oldId),
      }
    }
    const parentViewSelectors = { ...(parentViewState.selectors ?? {}) }
    const innerViewSelectors: NonNullable<GraphViewState['selectors']> extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.selectorIds) {
      const oldView = parentViewState.selectors?.[oldId]
      delete parentViewSelectors[oldId]
      innerViewSelectors[selectorIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'selector', oldId),
      }
    }
    const parentGroups = { ...(parentViewState.groups ?? {}) }
    const innerGroups: Record<string, GroupViewState> = {}
    for (const [index, oldId] of selection.groupIds.entries()) {
      const group = parentViewState.groups![oldId]!
      const id = `grp${index}`
      delete parentGroups[oldId]
      const position = translatedPosition(translatedGeometry, 'group', oldId)
      innerGroups[id] = { ...group, id, bounds: { ...group.bounds, ...position } }
    }
    const parentCollapsedNets = (parentViewState.collapsedNets ?? [])
      .filter((id) => !innerNetIds.has(id) || Object.hasOwn(parentNets, id))
    const innerCollapsedNets = [...innerNetIds]
      .filter(([oldId]) => collapsedNets.has(oldId))
      .map(([, newId]) => newId)
    const parentGuideNets = (parentViewState.guideNets ?? [])
      .filter((id) => !innerNetIds.has(id) || Object.hasOwn(parentNets, id))
    const innerGuideNets = [...innerNetIds]
      .filter(([oldId]) => guideNets.has(oldId))
      .map(([, newId]) => newId)
    const freshView: GraphViewState = {
      nodes: innerViewNodes,
      ...(selection.rerouteIds.length > 0 ? { reroutes: innerViewReroutes } : {}),
      ...(selection.valueSourceIds.length > 0 ? { valueSources: innerViewValueSources } : {}),
      ...(selection.selectorIds.length > 0 ? { selectors: innerViewSelectors } : {}),
      ...(selection.groupIds.length > 0 ? { groups: innerGroups, groupSeq: selection.groupIds.length } : {}),
      ...(innerCollapsedNets.length > 0 ? { collapsedNets: innerCollapsedNets } : {}),
      ...(innerGuideNets.length > 0 ? { guideNets: innerGuideNets } : {}),
    }
    const occurrenceView = { position: { ...geometryPlan.center } }
    parentViewNodes[occurrenceId] = occurrenceView

    // Tag placements for nets that moved wholly into the extracted definition
    // move with them. Node-relative offsets stay valid after the id remap;
    // absolute placements are parent-graph world coordinates, so they drop.
    // Split nets (out-cut with outside sinks) keep their parent entries.
    const rawNetViews = doc.ext?.[NET_VIEWS_EXT_KEY]
    if (Array.isArray(rawNetViews)) {
      const next: Json[] = []
      let changed = false
      for (const raw of rawNetViews) {
        const entry = parseNetViewPosition(raw)
        const movedNetId = entry !== undefined && entry.graphId === graphId && !Object.hasOwn(parentNets, entry.netId)
          ? innerNetIds.get(entry.netId)
          : undefined
        if (entry === undefined || movedNetId === undefined) {
          next.push(raw)
          continue
        }
        changed = true
        if (entry.geometry.kind !== 'offset') continue
        if (entry.role === 'sink') {
          const node = nodeIds.get(entry.to.node)
          if (node === undefined) continue
          next.push(netViewToJson({ ...entry, graphId: freshGraphId, netId: movedNetId, to: { ...entry.to, node: asNodeId(node) } }))
        } else {
          next.push(netViewToJson({ ...entry, graphId: freshGraphId, netId: movedNetId }))
        }
      }
      if (changed) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    }

    tx.set(['graphs', freshGraphId], freshDefinition as unknown as Json)
    tx.set(['view', 'graphs', freshGraphId], freshView as unknown as Json)
    tx.set(['graphs', graphId, 'nodes'], parentNodes as unknown as Json)
    tx.set(['graphs', graphId, 'links'], parentLinks as unknown as Json)
    tx.set(['graphs', graphId, 'nets'], parentNets as unknown as Json)
    tx.set(['graphs', graphId, 'reroutes'], parentReroutes as unknown as Json)
    if (parent.valueSources !== undefined || selection.valueSourceIds.length > 0) {
      tx.set(['graphs', graphId, 'valueSources'], parentValueSources as unknown as Json)
    }
    if (parent.selectors !== undefined || selection.selectorIds.length > 0) {
      tx.set(['graphs', graphId, 'selectors'], parentSelectors as unknown as Json)
    }
    if (parentBoundary !== undefined) tx.set(['graphs', graphId, 'boundary'], parentBoundary as unknown as Json)
    if (doc.view.graphs[graphId] === undefined) {
      tx.set(['view', 'graphs', graphId], {
        nodes: parentViewNodes,
        ...(Object.keys(parentViewReroutes).length > 0 ? { reroutes: parentViewReroutes } : {}),
        ...(Object.keys(parentViewValueSources).length > 0 ? { valueSources: parentViewValueSources } : {}),
        ...(Object.keys(parentViewSelectors).length > 0 ? { selectors: parentViewSelectors } : {}),
        ...(Object.keys(parentGroups).length > 0 ? { groups: parentGroups } : {}),
        ...(parentCollapsedNets.length > 0 ? { collapsedNets: parentCollapsedNets } : {}),
        ...(parentGuideNets.length > 0 ? { guideNets: parentGuideNets } : {}),
      } as unknown as Json)
    } else {
      tx.set(['view', 'graphs', graphId, 'nodes'], parentViewNodes as unknown as Json)
      if (parentViewState.reroutes !== undefined) tx.set(['view', 'graphs', graphId, 'reroutes'], parentViewReroutes as unknown as Json)
      if (parentViewState.valueSources !== undefined) tx.set(['view', 'graphs', graphId, 'valueSources'], parentViewValueSources as unknown as Json)
      if (parentViewState.selectors !== undefined) tx.set(['view', 'graphs', graphId, 'selectors'], parentViewSelectors as unknown as Json)
      if (parentViewState.groups !== undefined) tx.set(['view', 'graphs', graphId, 'groups'], parentGroups as unknown as Json)
      if (selection.groupIds.length > 0) {
        tx.set(['view', 'graphs', graphId, 'groupSeq'], groupAllocationFloor(doc, graphId))
      }
      if (parentViewState.collapsedNets !== undefined || parentCollapsedNets.length > 0) {
        tx.set(['view', 'graphs', graphId, 'collapsedNets'], parentCollapsedNets as unknown as Json)
      }
      if (parentViewState.guideNets !== undefined || parentGuideNets.length > 0) {
        tx.set(['view', 'graphs', graphId, 'guideNets'], parentGuideNets as unknown as Json)
      }
    }
    parentAllocator.commit()
    return [
      ...(geometryPlan.usedPlacementFallback
        ? [warn('subgraph.extract.placementFallback', 'subgraph.extract: no moved geometry was available; used the planned placement center')]
        : []),
      ...emptiedGroups.map((id) => warn('subgraph.extract.groupEmptied', `subgraph.extract: parent group '${id}' became empty`)),
    ]
  },
}

function flattenBoundaryTargets(
  item: BoundaryItem,
  nodeIds: ReadonlyMap<string, string>,
): readonly BoundaryBinding[] | undefined {
  const bindings = [item.binds, ...(item.alsoBinds ?? [])]
  if (bindings.some((binding) => isForwardingBinding(binding) ||
    binding.kind === 'port' && (binding.members?.length ?? 0) > 0)) return undefined
  return bindings.map((binding) => remapBinding(binding, nodeIds))
}

function portFromBinding(binding: BoundaryBinding): PortRef {
  if (binding.kind === 'widgetTap') throw new Error('widget tap binding is not a port')
  return {
    node: binding.node,
    port: binding.port,
    ...(binding.members !== undefined ? { members: binding.members } : {}),
  }
}

function endpointFromBinding(binding: BoundaryBinding): LinkEndpoint {
  return binding.kind === 'widgetTap'
    ? { node: binding.node, tap: binding.tap }
    : portFromBinding(binding)
}

function flattenRoutePlanFromJson(
  value: Json | undefined,
  body: GraphDef,
): ReadonlyMap<string, FlattenRouteKind> | undefined {
  if (!Array.isArray(value) || body.boundary === undefined) return undefined
  const expected = [
    ...body.boundary.inputs.map((item) => ({ side: 'input', id: item.id, item })),
    ...body.boundary.outputs.map((item) => ({ side: 'output', id: item.id, item })),
  ]
  if (value.length !== expected.length) return undefined
  const result = new Map<string, FlattenRouteKind>()
  for (const [index, entry] of value.entries()) {
    const address = expected[index]!
    if (!isObj(entry) || Object.keys(entry).length !== 3 || !Object.hasOwn(entry, 'side') ||
        !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'route') ||
        entry.side !== address.side || entry.id !== address.id ||
        typeof entry.route !== 'string' ||
        !['plain', 'plainWidget', 'widgetTap', 'combo', 'family', 'specialized', 'unresolved'].includes(entry.route) ||
        (entry.side === 'output' && entry.route === 'plainWidget')) return undefined
    const key = JSON.stringify([entry.side, entry.id])
    if (result.has(key)) return undefined
    result.set(key, entry.route as FlattenRouteKind)
  }
  return result
}

function flattenStatePlanFromJson(
  value: Json | undefined,
  body: GraphDef,
): FlattenStatePlan | undefined {
  const exactKeys = (record: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean => {
    const allowed = new Set([...required, ...optional])
    return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key))
  }
  const controllerModes = new Set<ControllerMode>(['fixed', 'increment', 'decrement', 'randomize'])
  const dynamicState = (entry: Json | undefined, depth = 0): boolean => {
    if (!isObj(entry) || depth > MAX_DYNAMIC_STATE_DEPTH ||
        !exactKeys(entry, [], ['members', 'memberLabels', 'selected', 'seq', 'memberState'])) return false
    if (entry.members !== undefined && (!Array.isArray(entry.members) ||
        !entry.members.every((member) => typeof member === 'string' && member.length > 0) ||
        new Set(entry.members).size !== entry.members.length)) return false
    if (entry.selected !== undefined && typeof entry.selected !== 'string') return false
    if (entry.memberLabels !== undefined && (!isObj(entry.memberLabels) ||
        !Object.entries(entry.memberLabels).every(([member, label]) =>
          member.length > 0 && typeof label === 'string' && label.length > 0))) return false
    if (entry.seq !== undefined && (typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq < 0)) return false
    if (entry.memberState !== undefined) {
      if (!isObj(entry.memberState)) return false
      for (const [member, constructs] of Object.entries(entry.memberState)) {
        if (member.length === 0 || !isObj(constructs)) return false
        for (const nested of Object.values(constructs)) {
          if (!dynamicState(nested, depth + 1)) return false
        }
      }
    }
    return true
  }
  const dynamicScope = (entry: Json | undefined): boolean => isObj(entry) &&
    Object.values(entry).every((state) => dynamicState(state))
  const controllers = (entry: Json | undefined): boolean => isObj(entry) &&
    Object.values(entry).every((mode) => typeof mode === 'string' && controllerModes.has(mode as ControllerMode))
  const snapshot = (entry: Json | undefined): boolean => isObj(entry) &&
    exactKeys(entry, ['node', 'type', 'values'], ['controllers', 'dynamic']) &&
    typeof entry.node === 'string' && typeof entry.type === 'string' && isObj(entry.values) &&
    (entry.controllers === undefined || controllers(entry.controllers) && Object.keys(entry.controllers as JsonObject).length > 0) &&
    (entry.dynamic === undefined || dynamicScope(entry.dynamic) && Object.keys(entry.dynamic as JsonObject).length > 0)
  if (!isObj(value) || value.version !== 'subgraph-flatten-state-plan-v1' ||
      (value.status !== 'ready' && value.status !== 'refused') || !isObj(value.source) ||
      !exactKeys(value.source, ['occurrence', 'bodyNodes']) || !snapshot(value.source.occurrence) ||
      !Array.isArray(value.source.bodyNodes) || !value.source.bodyNodes.every(snapshot)) return undefined
  const nodeIds = Object.keys(body.nodes).sort(compareStrings)
  if (value.source.bodyNodes.length !== nodeIds.length) return undefined
  for (const [index, entry] of value.source.bodyNodes.entries()) {
    if (!isObj(entry) || entry.node !== nodeIds[index] || entry.type !== body.nodes[nodeIds[index]!]!.type) return undefined
  }
  const refusalCodes = new Set([
    'subgraph.flatten.stateUnresolved',
    'subgraph.flatten.dormantStateUnsupported',
    'subgraph.flatten.nativeFamilyUnsupported',
    'subgraph.flatten.specializedSlotUnsupported',
    'subgraph.lifecycle.boundaryUnresolved',
    'subgraph.lifecycle.idExhausted',
  ])
  if (value.status === 'refused') {
    if (!exactKeys(value, ['version', 'status', 'source', 'refusal']) || !isObj(value.refusal) ||
        !exactKeys(value.refusal, ['code', 'message'], ['side', 'boundaryId', 'key', 'address']) ||
        typeof value.refusal.code !== 'string' || !refusalCodes.has(value.refusal.code) ||
        typeof value.refusal.message !== 'string' ||
        (value.refusal.side !== undefined && value.refusal.side !== 'input' && value.refusal.side !== 'output') ||
        (value.refusal.boundaryId !== undefined && (typeof value.refusal.boundaryId !== 'string' || value.refusal.side === undefined)) ||
        (value.refusal.key !== undefined && typeof value.refusal.key !== 'string') ||
        (value.refusal.address !== undefined && (!isObj(value.refusal.address) ||
          !exactKeys(value.refusal.address, ['port'], ['members']) || typeof value.refusal.address.port !== 'string' || value.refusal.address.port.length === 0 ||
          (value.refusal.address.members !== undefined && (!Array.isArray(value.refusal.address.members) ||
            !value.refusal.address.members.every((member) => typeof member === 'string' && member.length > 0)))))) return undefined
    return value as unknown as FlattenStatePlan
  }
  if (!exactKeys(value, ['version', 'status', 'source', 'nodes', 'familyScopes', 'addresses', 'routes', 'enclosingRewrites']) ||
      !Array.isArray(value.nodes) || !Array.isArray(value.familyScopes) ||
      !Array.isArray(value.addresses) ||
      !Array.isArray(value.routes) || !Array.isArray(value.enclosingRewrites) ||
      value.nodes.length !== nodeIds.length) return undefined
  for (const [index, entry] of value.nodes.entries()) {
    if (!snapshot(entry) || !isObj(entry) || entry.node !== nodeIds[index] || entry.type !== body.nodes[nodeIds[index]!]!.type) return undefined
  }
  const strings = (entry: Json | undefined): entry is string[] => Array.isArray(entry) &&
    entry.every((item) => typeof item === 'string' && item.length > 0)
  const binding = (entry: Json | undefined): boolean => isObj(entry) && (
    entry.kind === 'widgetTap'
      ? exactKeys(entry, ['kind', 'node', 'tap']) && typeof entry.node === 'string' &&
        typeof entry.tap === 'string' && entry.tap.length > 0
      : exactKeys(entry, ['kind', 'node', 'port'], ['members', 'slots']) &&
        (entry.kind === 'port' || entry.kind === 'family') && typeof entry.node === 'string' &&
        typeof entry.port === 'string' && entry.port.length > 0 &&
        (entry.members === undefined || strings(entry.members)) &&
        (entry.slots === undefined || entry.kind === 'family' && strings(entry.slots))
  )
  const scopeStep = (entry: Json | undefined): boolean => isObj(entry) &&
    exactKeys(entry, ['construct', 'member', 'storage']) && typeof entry.construct === 'string' && entry.construct.length > 0 &&
    typeof entry.member === 'string' && entry.member.length > 0 &&
    (entry.storage === 'memberState' || entry.storage === 'pathSegment')
  const scopeRef = (entry: Json | undefined, target = false): boolean => isObj(entry) &&
    exactKeys(entry, target ? ['construct', 'ancestors', 'node'] : ['construct', 'ancestors']) &&
    typeof entry.construct === 'string' && entry.construct.length > 0 && Array.isArray(entry.ancestors) && entry.ancestors.every(scopeStep) &&
    (!target || typeof entry.node === 'string' && Object.hasOwn(body.nodes, entry.node))
  const beforeAfter = (entry: Json | undefined): boolean => isObj(entry) &&
    exactKeys(entry, ['members', 'memberStateKeys'], ['seq']) && strings(entry.members) && strings(entry.memberStateKeys) &&
    (entry.seq === undefined || typeof entry.seq === 'number' && Number.isSafeInteger(entry.seq) && entry.seq >= 0)
  const scopeIds = new Set<string>()
  for (const [index, scope] of value.familyScopes.entries()) {
    if (!isObj(scope) || !exactKeys(scope, ['id', 'source', 'target', 'policy', 'sourceMembers', 'targetBefore', 'members', 'targetAfter'], ['parent']) ||
        typeof scope.id !== 'string' || scope.id !== `family-${index}` || scopeIds.has(scope.id) ||
        !scopeRef(scope.source) || !scopeRef(scope.target, true) || !isObj(scope.policy) ||
        !strings(scope.sourceMembers) || !beforeAfter(scope.targetBefore) || !beforeAfter(scope.targetAfter) ||
        !Array.isArray(scope.members) || !scope.members.every((member) => isObj(member) &&
          exactKeys(member, ['before', 'after']) && typeof member.before === 'string' && member.before.length > 0 &&
          typeof member.after === 'string' && member.after.length > 0) ||
        scope.members.length !== scope.sourceMembers.length) return undefined
    if (scope.policy.kind === 'ordinal') {
      if (!exactKeys(scope.policy, ['kind', 'materialization', 'prefix', 'min', 'max']) ||
          (scope.policy.materialization !== 'ordinary' && scope.policy.materialization !== 'wire15') ||
          typeof scope.policy.prefix !== 'string') return undefined
    } else if (scope.policy.kind === 'names') {
      if (!exactKeys(scope.policy, ['kind', 'materialization', 'vocabulary', 'min', 'max']) ||
          scope.policy.materialization !== 'wire15' || !strings(scope.policy.vocabulary)) return undefined
    } else return undefined
    if (typeof scope.policy.min !== 'number' || !Number.isSafeInteger(scope.policy.min) || scope.policy.min < 0 ||
        typeof scope.policy.max !== 'number' || !Number.isSafeInteger(scope.policy.max) || scope.policy.max < scope.policy.min) return undefined
    if (scope.parent !== undefined && (!isObj(scope.parent) || !exactKeys(scope.parent, ['scope', 'beforeMember', 'afterMember']) ||
        typeof scope.parent.scope !== 'string' || !scopeIds.has(scope.parent.scope) ||
        typeof scope.parent.beforeMember !== 'string' || typeof scope.parent.afterMember !== 'string')) return undefined
    scopeIds.add(scope.id)
  }
  const portAddress = (entry: Json | undefined): boolean => isObj(entry) && exactKeys(entry, ['port'], ['members']) &&
    typeof entry.port === 'string' && entry.port.length > 0 && (entry.members === undefined || strings(entry.members))
  const inputIdentity = (entry: Json | undefined): boolean => isObj(entry) && exactKeys(entry, ['address', 'valueKey', 'origin']) &&
    portAddress(entry.address) && typeof entry.valueKey === 'string' && entry.valueKey.length > 0 &&
    ['static', 'member', 'selector', 'branch', 'slot', 'dependent'].includes(entry.origin as string)
  const addressKeys = new Set<string>()
  const serializedAddresses = value.addresses
  for (const address of serializedAddresses) {
    if (!isObj(address) || !exactKeys(address, ['side', 'boundaryId', 'before', 'uses', 'targets'], ['input']) ||
        (address.side !== 'input' && address.side !== 'output') || typeof address.boundaryId !== 'string' ||
        !portAddress(address.before) || !Array.isArray(address.uses) || address.uses.length === 0 ||
        !address.uses.every((use) => ['endpoint', 'value', 'controller', 'dynamic'].includes(use as string)) ||
        new Set(address.uses).size !== address.uses.length ||
        (address.input !== undefined && !inputIdentity(address.input)) || !Array.isArray(address.targets) || address.targets.length === 0) return undefined
    const key = JSON.stringify([address.side, address.boundaryId, address.before])
    if (addressKeys.has(key)) return undefined
    addressKeys.add(key)
    const bindingIndexes = new Set<number>()
    for (const target of address.targets) {
      if (!isObj(target) || !exactKeys(target, ['bindingIndex', 'binding'], ['input']) ||
          typeof target.bindingIndex !== 'number' || !Number.isSafeInteger(target.bindingIndex) || target.bindingIndex < 0 ||
          !isObj(target.binding) || target.binding.kind !== 'port' || typeof target.binding.node !== 'string' ||
          typeof target.binding.port !== 'string' || (target.binding.members !== undefined && !strings(target.binding.members)) ||
          (target.input !== undefined && !inputIdentity(target.input)) || bindingIndexes.has(target.bindingIndex)) return undefined
      bindingIndexes.add(target.bindingIndex)
    }
  }
  const expected = [
    ...(body.boundary?.inputs ?? []).map((item) => ({ side: 'input', item })),
    ...(body.boundary?.outputs ?? []).map((item) => ({ side: 'output', item })),
  ]
  if (value.routes.length !== expected.length) return undefined
  for (const [index, route] of value.routes.entries()) {
    const address = expected[index]!
    if (!isObj(route) || !exactKeys(route, ['side', 'id', 'bindingCount', 'familyScopeIds', 'addressIndexes']) ||
        route.side !== address.side || route.id !== address.item.id ||
        route.bindingCount !== 1 + (address.item.alsoBinds?.length ?? 0) ||
        !Array.isArray(route.familyScopeIds) || !route.familyScopeIds.every((id) => typeof id === 'string' && scopeIds.has(id)) ||
        !Array.isArray(route.addressIndexes) || !route.addressIndexes.every((entryIndex) => typeof entryIndex === 'number' &&
          Number.isSafeInteger(entryIndex) && entryIndex >= 0 && entryIndex < serializedAddresses.length &&
          isObj(serializedAddresses[entryIndex]) && serializedAddresses[entryIndex]!.side === route.side &&
          serializedAddresses[entryIndex]!.boundaryId === route.id)) return undefined
  }
  const rewriteKeys = new Set<string>()
  for (const rewrite of value.enclosingRewrites) {
    if (!isObj(rewrite) || !exactKeys(rewrite, ['side', 'itemIndex', 'itemId', 'bindingIndex', 'before', 'after']) ||
        (rewrite.side !== 'input' && rewrite.side !== 'output') ||
        typeof rewrite.itemIndex !== 'number' || !Number.isSafeInteger(rewrite.itemIndex) || rewrite.itemIndex < 0 ||
        typeof rewrite.itemId !== 'string' || rewrite.itemId.length === 0 ||
        typeof rewrite.bindingIndex !== 'number' || !Number.isSafeInteger(rewrite.bindingIndex) || rewrite.bindingIndex < 0 ||
        !binding(rewrite.before) || !Array.isArray(rewrite.after) || rewrite.after.length === 0 || !rewrite.after.every(binding) ||
        rewrite.side === 'output' && rewrite.after.length !== 1) return undefined
    const key = JSON.stringify([rewrite.side, rewrite.itemIndex, rewrite.bindingIndex])
    if (rewriteKeys.has(key)) return undefined
    rewriteKeys.add(key)
  }
  return value as unknown as FlattenStatePlan
}

function flattenBodySelection(body: GraphDef, view: GraphViewState | undefined): LifecycleSelection {
  return canonicalizeLifecycleSelection({
    nodeIds: Object.keys(body.nodes),
    rerouteIds: Object.keys(body.reroutes),
    valueSourceIds: Object.keys(body.valueSources ?? {}),
    selectorIds: Object.keys(body.selectors ?? {}),
    groupIds: Object.keys(view?.groups ?? {}),
  })
}

function flattenMaterializedIdentitiesContainNul(statePlan: Extract<FlattenStatePlan, { status: 'ready' }>): boolean {
  const hasNul = (value: string): boolean => value.includes(String.fromCharCode(0))
  for (const scope of statePlan.familyScopes) {
    if (scope.source.ancestors.some((step) => hasNul(step.member)) ||
        scope.target.ancestors.some((step) => hasNul(step.member)) ||
        scope.sourceMembers.some(hasNul) || scope.targetBefore.members.some(hasNul) ||
        scope.targetBefore.memberStateKeys.some(hasNul) || scope.targetAfter.members.some(hasNul) ||
        scope.targetAfter.memberStateKeys.some(hasNul) ||
        scope.members.some((member) => hasNul(member.before) || hasNul(member.after))) return true
  }
  for (const address of statePlan.addresses) {
    if (address.before.members?.some(hasNul) === true ||
        address.input?.address.members?.some(hasNul) === true ||
        address.targets.some((target) => target.binding.members?.some(hasNul) === true ||
          target.input?.address.members?.some(hasNul) === true)) return true
  }
  for (const rewrite of statePlan.enclosingRewrites) {
    if (rewrite.before.members?.some(hasNul) === true || rewrite.after.some((binding) => binding.members?.some(hasNul) === true)) return true
  }
  return false
}

function stagedFlattenIdentitiesContainNul(
  statePlan: Extract<FlattenStatePlan, { status: 'ready' }>,
  staged: GraphDef,
  body: GraphDef,
  nodeIds: ReadonlyMap<string, string>,
  clonedLinkIds: ReadonlySet<string>,
  clonedNetIds: ReadonlySet<string>,
): boolean {
  const hasNul = (value: string): boolean => value.includes(String.fromCharCode(0))
  const sourceNodes = new Map(statePlan.source.bodyNodes.map((node) => [node.node, node]))
  const changedDynamicHasNul = (
    before: Readonly<Record<string, DynamicPortState>> | undefined,
    after: Readonly<Record<string, DynamicPortState>> | undefined,
  ): boolean => {
    for (const construct of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      const beforeState = before?.[construct]
      const afterState = after?.[construct]
      const beforeMembers = new Set(beforeState?.members ?? [])
      const afterMembers = new Set(afterState?.members ?? [])
      if ([...beforeMembers].some((member) => !afterMembers.has(member) && hasNul(member)) ||
          [...afterMembers].some((member) => !beforeMembers.has(member) && hasNul(member))) return true
      const beforeNested = beforeState?.memberState
      const afterNested = afterState?.memberState
      for (const member of new Set([...Object.keys(beforeNested ?? {}), ...Object.keys(afterNested ?? {})])) {
        if ((!Object.hasOwn(beforeNested ?? {}, member) || !Object.hasOwn(afterNested ?? {}, member)) && hasNul(member)) return true
        if (changedDynamicHasNul(beforeNested?.[member], afterNested?.[member])) return true
      }
    }
    return false
  }
  for (const node of statePlan.nodes) {
    const source = sourceNodes.get(node.node)
    if (source === undefined) return true
    if (changedDynamicHasNul(source.dynamic, node.dynamic)) return true
    for (const key of new Set([...Object.keys(source.values), ...Object.keys(node.values)])) {
      if ((!Object.hasOwn(source.values, key) || !Object.hasOwn(node.values, key) ||
          canonicalJson(source.values[key]) !== canonicalJson(node.values[key])) && hasNul(key)) return true
    }
    for (const key of new Set([...Object.keys(source.controllers ?? {}), ...Object.keys(node.controllers ?? {})])) {
      if ((!Object.hasOwn(source.controllers ?? {}, key) || !Object.hasOwn(node.controllers ?? {}, key) ||
          source.controllers?.[key] !== node.controllers?.[key]) && hasNul(key)) return true
    }
  }
  const sourcePortKeys = new Set<string>()
  const rememberSourcePort = (ref: PortRef): void => {
    sourcePortKeys.add(JSON.stringify([ref.node, ref.port, ref.members ?? []]))
  }
  for (const link of Object.values(body.links)) {
    if (isPortEndpoint(link.from)) rememberSourcePort(link.from)
    if (isPortEndpoint(link.to)) rememberSourcePort(link.to)
  }
  for (const net of Object.values(body.nets)) {
    rememberSourcePort(net.source)
    for (const sink of net.sinks) rememberSourcePort(sink)
  }
  const sourceNodeByClone = new Map([...nodeIds].map(([source, clone]) => [clone, source]))
  const portHasNul = (ref: PortRef, allowSourceIdentity: boolean): boolean => {
    if (ref.members?.some(hasNul) !== true) return false
    const sourceNode = sourceNodeByClone.get(ref.node)
    return !allowSourceIdentity || sourceNode === undefined ||
      !sourcePortKeys.has(JSON.stringify([sourceNode, ref.port, ref.members]))
  }
  for (const [id, link] of Object.entries(staged.links)) {
    const allowSourceIdentity = clonedLinkIds.has(id)
    if (isPortEndpoint(link.from) && portHasNul(link.from, allowSourceIdentity) ||
        isPortEndpoint(link.to) && portHasNul(link.to, allowSourceIdentity)) return true
  }
  for (const [id, net] of Object.entries(staged.nets)) {
    const allowSourceIdentity = clonedNetIds.has(id)
    if (portHasNul(net.source, allowSourceIdentity) ||
        net.sinks.some((sink) => portHasNul(sink, allowSourceIdentity))) return true
  }
  for (const item of [...(staged.boundary?.inputs ?? []), ...(staged.boundary?.outputs ?? [])]) {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (sourceNodeByClone.has(binding.node) && binding.members?.some(hasNul) === true) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// subgraph.flatten
//
// Flatten consumes only the immutable route/schema plan supplied by the
// planner. It never consults the live schema registry, which is important for
// deterministic shared replay.
// ---------------------------------------------------------------------------

type OccurrenceTopologyOverlay = NonNullable<WorkflowDocument['occurrenceTopologies']>[string]

function flattenPlanNetExtension(doc: WorkflowDocument, plan: Json | undefined): boolean {
  if (!isObj(plan)) return false
  return [plan.links, plan.projectedParentLinks].some((group) => Array.isArray(group) && group.some((link) => {
    if (!isObj(link) || !isObj(link.identity)) return false
    const identity = link.identity
    const net = (identity.kind === 'definitionNetSink' || identity.kind === 'parentNetSink') &&
        typeof identity.graphId === 'string' && typeof identity.netId === 'string'
      ? doc.graphs[identity.graphId]?.nets[identity.netId as never]
      : identity.kind === 'parentLeg' && isObj(identity.delivery) && identity.delivery.kind === 'netSink' &&
          typeof identity.delivery.graph === 'string' && typeof identity.delivery.netId === 'string'
        ? doc.graphs[identity.delivery.graph]?.nets[identity.delivery.netId as never]
        : undefined
    return net?.ext !== undefined && Object.keys(net.ext).length > 0
  }))
}

/** One refusal sequence shared by validateDispatch and run so both paths
 * refuse identical inputs with identical diagnostics in identical order. */
function flattenOccurrenceTopologyRefusal(
  doc: WorkflowDocument,
  topology: OccurrenceTopologyOverlay | undefined,
  occurrencePlan: Json | undefined,
  graphId: string,
  instancePath: readonly string[],
  nodeId: string,
): Diagnostic | undefined {
  if (topology?.ext !== undefined && Object.keys(topology.ext).length > 0) {
    return lifecycleError(
      'subgraph.flatten.occurrenceTopologyExtensionUnsupported',
      'subgraph.flatten: occurrence topology extension state has no flattened owner',
      graphId,
      instancePath,
      nodeId,
    )
  }
  if (occurrencePlan === undefined) return undefined
  if (flattenPlanNetExtension(doc, occurrencePlan)) {
    return lifecycleError(
      'subgraph.flatten.netExtensionUnsupported',
      'subgraph.flatten: effective net extension state cannot be represented by ordinary links',
      graphId,
      instancePath,
      nodeId,
    )
  }
  if (graphId !== doc.root || instancePath.length !== 0) {
    return lifecycleError(
      'subgraph.flatten.occurrenceTopologyContextUnsupported',
      'subgraph.flatten: drilled occurrence topology requires definition specialization',
      graphId,
      instancePath,
      nodeId,
    )
  }
  return undefined
}

function validateFlattenDispatch(
  doc: WorkflowDocument,
  params: Json,
  context: CommandExecutionContext,
): readonly Diagnostic[] {
  if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string' ||
      !Array.isArray(params.instancePath) || !params.instancePath.every((id) => typeof id === 'string') ||
      !Array.isArray(params.boundaryPlan) || !isObj(params.schemaSnapshot) ||
      !isObj(params.statePlan) || typeof params.schemaPlanDigest !== 'string' ||
      typeof params.selectionFingerprint !== 'string') {
    return [err('params.invalid', 'subgraph.flatten: malformed trusted plan')]
  }
  const parent = doc.graphs[params.graphId]
  const occurrence = parent?.nodes[params.nodeId]
  const bodyId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
  const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
  if (parent === undefined || occurrence === undefined || body?.boundary === undefined) return []
  const routes = flattenRoutePlanFromJson(params.boundaryPlan, body)
  const statePlan = flattenStatePlanFromJson(params.statePlan, body)
  if (routes === undefined || statePlan === undefined) return [err('params.invalid', 'subgraph.flatten: plan shape or coverage is invalid')]

  const snapshot = params.schemaSnapshot as unknown as Record<string, never>
  const boundAuthoredTypes = new Set(Object.values(body.nodes).map((node) => node.type))
  for (const item of [...body.boundary.inputs, ...body.boundary.outputs]) {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      const authoredType = body.nodes[binding.node]?.type
      if (authoredType !== undefined) boundAuthoredTypes.add(authoredType)
    }
  }
  for (const [authoredType, schema] of Object.entries(snapshot)) {
    if (!boundAuthoredTypes.has(authoredType) || !isObj(schema as unknown as Json) ||
        typeof (schema as unknown as JsonObject).type !== 'string' ||
        !Array.isArray((schema as unknown as JsonObject).items)) {
      return [err('params.invalid', 'subgraph.flatten: schema snapshot has invalid authored-type coverage')]
    }
  }
  const owner = { instancePath: params.instancePath as string[], node: params.nodeId }
  const topology = doc.occurrenceTopologies?.[occurrenceKey(owner as never)]
  const occurrencePlanValue = params.occurrenceTopologyPlan
  const occurrenceDigest = params.occurrenceTopologyPlanDigest
  if (topology === undefined && (occurrencePlanValue !== undefined || occurrenceDigest !== undefined)) {
    return [err('params.invalid', 'subgraph.flatten: occurrence topology plan is unexpected')]
  }
  const topologyRefusal = flattenOccurrenceTopologyRefusal(
    doc, topology, occurrencePlanValue, params.graphId, params.instancePath as string[], params.nodeId)
  if (topologyRefusal !== undefined) return [topologyRefusal]
  if (topology !== undefined) {
    if (!isObj(occurrencePlanValue) || occurrencePlanValue.version !== 'subgraph-flatten-occurrence-plan-v1' ||
        !Array.isArray(occurrencePlanValue.links) || !Array.isArray(occurrencePlanValue.projectedParentLinks) ||
        !occurrencePlanValue.projectedParentLinks.every((link) => isObj(link) && typeof link.fromGraphId === 'string' && typeof link.toGraphId === 'string') ||
        typeof occurrenceDigest !== 'string') {
      return [err('params.invalid', 'subgraph.flatten: occurrence topology plan is required and malformed')]
    }
    if (lifecycleCanonicalHash(occurrencePlanValue) !== occurrenceDigest) {
      return [err('params.invalid', 'subgraph.flatten: occurrence topology plan digest does not match')]
    }
    const recomputed = planFlattenOccurrenceTopology(doc, (type) => snapshot[type], owner as never)
    if (recomputed.plan === undefined || recomputed.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
        canonicalJson(recomputed.plan) !== canonicalJson(occurrencePlanValue)) {
      return [err('params.invalid', 'subgraph.flatten: occurrence topology plan does not match semantic recomputation')]
    }
  }
  const expected = [
    ...body.boundary.inputs.map((item) => ({ side: 'input', item } as const)),
    ...body.boundary.outputs.map((item) => ({ side: 'output', item } as const)),
  ]
  for (const { side, item } of expected) {
    const route = routes.get(JSON.stringify([side, item.id]))
    if (route === 'plain' || route === 'plainWidget' || route === 'combo' || route === 'specialized') {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        const authoredType = body.nodes[binding.node]?.type
        if (authoredType === undefined || !Object.hasOwn(snapshot, authoredType)) {
          return [err('params.invalid', 'subgraph.flatten: boundary route requires a missing authored schema')]
        }
      }
    }
    if (route !== classifyFlattenBoundaryRoute(body, item, (type) => snapshot[type], side)) {
      return [err('params.invalid', 'subgraph.flatten: boundary route does not match the snapshot')]
    }
  }
  if (!verifyFlattenSchemaPlanDigest(snapshot, params.schemaPlanDigest, params.boundaryPlan as never, statePlan)) {
    return [err('params.invalid', 'subgraph.flatten: schemaPlanDigest checksum does not match the snapshot and plans')]
  }
  if (!verifyFlattenStatePlan(body, occurrence, parent, snapshot, params.boundaryPlan as never, statePlan)) {
    return [err('params.invalid', 'subgraph.flatten: statePlan does not match semantic recomputation')]
  }
  const plannedRoutes = [...routes.entries()]
  const unsupportedRoutes = plannedRoutes.filter(([, route]) => route === 'specialized' || route === 'unresolved')
  if (statePlan.status === 'ready' && unsupportedRoutes.length > 0) {
    return [err('params.invalid', 'subgraph.flatten: ready statePlan cannot bypass a remainder refusal')]
  }
  if (statePlan.status === 'refused') {
    const refusalRoute = statePlan.refusal.side !== undefined && statePlan.refusal.boundaryId !== undefined
      ? routes.get(JSON.stringify([statePlan.refusal.side, statePlan.refusal.boundaryId]))
      : unsupportedRoutes[0]?.[1]
    const expectedRefusal = refusalRoute === 'specialized'
      ? 'subgraph.flatten.specializedSlotUnsupported'
      : refusalRoute === 'unresolved' ? 'subgraph.flatten.stateUnresolved' : undefined
    if (statePlan.refusal.boundaryId !== undefined && refusalRoute === undefined) {
      return [err('params.invalid', 'subgraph.flatten: planner refusal names no verified boundary route')]
    }
    const routeOnlyCode = statePlan.refusal.code === 'subgraph.flatten.nativeFamilyUnsupported' ||
      statePlan.refusal.code === 'subgraph.flatten.specializedSlotUnsupported'
    if (routeOnlyCode && expectedRefusal !== statePlan.refusal.code &&
        !(refusalRoute === 'family' && routeOnlyCode)) {
      return [err('params.invalid', 'subgraph.flatten: planner refusal code is incompatible with its verified boundary route')]
    }
    if (expectedRefusal !== undefined && statePlan.refusal.code !== expectedRefusal) {
      return [err('params.invalid', 'subgraph.flatten: planner refusal does not match the verified boundary routes')]
    }
  }
  const freshness = verifyLifecycleFlattenPlan(doc, params.graphId, params.nodeId, params.selectionFingerprint, {
    boundaryPlan: params.boundaryPlan,
    statePlan: params.statePlan,
    schemaPlanDigest: params.schemaPlanDigest,
    ...(occurrencePlanValue !== undefined ? {
      occurrenceTopologyPlan: occurrencePlanValue,
      occurrenceTopologyPlanDigest: occurrenceDigest,
    } : {}),
  })
  if (freshness.stale) {
    return [lifecycleError('subgraph.lifecycle.stalePlan', 'subgraph.flatten: document or trusted plan changed after planning', params.graphId, [], params.nodeId)]
  }
  if (context.kind === 'initial') {
    if (context.schemaResolverFor === undefined) {
      return [err('subgraph.flatten.schemaAuthorityUnavailable', 'subgraph.flatten: trusted schema authority is unavailable')]
    }
    let matches = false
    try {
      const liveResolver = context.schemaResolverFor(doc)
      const gainedSchemas = [...boundAuthoredTypes].some((authoredType) =>
        !Object.hasOwn(snapshot, authoredType) && liveResolver(authoredType) !== undefined)
      matches = flattenRegistryMatchesSchemaPlan(
        snapshot,
        params.schemaPlanDigest,
        liveResolver,
        params.boundaryPlan as never,
        statePlan,
      ) && !gainedSchemas
    } catch {
      matches = false
    }
    if (!matches) return [err('subgraph.flatten.schemaPlanStale', 'subgraph.flatten: live schema registry differs from the planned snapshot')]
  }
  return []
}

const subgraphFlatten: CommandDefinition = {
  id: 'subgraph.flatten',
  validateDispatch(doc, params, context) {
    return validateFlattenDispatch(doc, params, context)
  },
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !Array.isArray(params.instancePath) ||
        !params.instancePath.every((id) => typeof id === 'string') || typeof params.nodeId !== 'string' ||
        typeof params.selectionFingerprint !== 'string' || !isObj(params.placementCenter) ||
        typeof params.placementCenter.x !== 'number' || typeof params.placementCenter.y !== 'number' ||
        !isObj(params.resolvedGeometry) || !Array.isArray(params.boundaryPlan) || !isObj(params.statePlan) ||
        !isObj(params.schemaSnapshot) || typeof params.schemaPlanDigest !== 'string') {
      return [err('params.invalid', 'subgraph.flatten: params must include graphId, instancePath, nodeId, placementCenter, resolvedGeometry, boundaryPlan, statePlan, schemaSnapshot, schemaPlanDigest, and selectionFingerprint')]
    }
    const graphId = params.graphId
    const instancePath = params.instancePath as string[]
    const nodeId = params.nodeId
    if (!contextResolves(doc, graphId, instancePath)) {
      return [lifecycleError('subgraph.lifecycle.contextInvalid', `subgraph.flatten: instance path does not resolve to graph '${graphId}'`, graphId, instancePath, nodeId)]
    }
    const parent = doc.graphs[graphId]!
    const occurrence = parent.nodes[nodeId]
    const bodyId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
    const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
    if (occurrence === undefined || bodyId === undefined || body === undefined || body.boundary === undefined) {
      return [lifecycleError('subgraph.flatten.notOccurrence', 'subgraph.flatten: target is not a resolvable subgraph occurrence', graphId, instancePath, nodeId)]
    }
    const topologyOwner = { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) }
    const topologyKey = occurrenceKey(topologyOwner)
    const occurrencePlan = params.occurrenceTopologyPlan as unknown as FlattenOccurrenceTopologyPlan | undefined
    const selectedTopology = doc.occurrenceTopologies?.[topologyKey]
    const topologyRefusal = flattenOccurrenceTopologyRefusal(
      doc, selectedTopology, params.occurrenceTopologyPlan, graphId, instancePath, nodeId)
    if (topologyRefusal !== undefined) return [topologyRefusal]
    const descendantPrefix = [...topologyOwner.instancePath, topologyOwner.node]
    const hasDescendantTopology = Object.values(doc.occurrenceTopologies ?? {}).some((topology) =>
      occurrenceKey(topology.owner) !== topologyKey &&
      descendantPrefix.every((hop, index) => topology.owner.instancePath[index] === hop))
    if (hasDescendantTopology) {
      return [lifecycleError(
        'subgraph.flatten.occurrenceTopologyDescendantUnsupported',
        'subgraph.flatten: nested occurrence topology requires an explicit owner remap',
        graphId,
        instancePath,
        nodeId,
      )]
    }
    if (extractionIntersectsOccurrenceTopology(doc, graphId, {
      nodeIds: [nodeId], rerouteIds: [], valueSourceIds: [], selectorIds: [], groupIds: [],
    }, topologyKey)) {
      return [lifecycleError(
        'subgraph.flatten.occurrenceTopologyIntersection',
        'subgraph.flatten: another occurrence topology references the transformed definition region',
        graphId,
        instancePath,
        nodeId,
      )]
    }
    const shellRefusal = flattenShellRefusalDiagnostic(occurrence, graphId, instancePath, nodeId)
    if (shellRefusal !== undefined) return [shellRefusal]
    if (occurrence.ext !== undefined && Object.keys(occurrence.ext).length > 0) {
      return [lifecycleError('subgraph.flatten.extensionStateUnsupported', 'subgraph.flatten: occurrence-owned extension state has no flattened owner', graphId, instancePath, nodeId)]
    }
    const boundaryInputs = new Map(body.boundary.inputs.map((item) => [item.id, item]))
    const boundaryOutputs = new Map(body.boundary.outputs.map((item) => [item.id, item]))
    if ([...body.boundary.inputs, ...body.boundary.outputs].some((item) =>
      item.ext !== undefined && Object.keys(item.ext).length > 0)) {
      return [lifecycleError('subgraph.flatten.boundaryExtensionUnsupported', 'subgraph.flatten: body boundary extension state has no flattened owner', graphId, instancePath, nodeId)]
    }
    const routePlan = flattenRoutePlanFromJson(params.boundaryPlan, body)
    if (routePlan === undefined) {
      return [err('params.invalid', 'subgraph.flatten: boundaryPlan and schema snapshot must have exact coverage and a valid schemaPlanDigest')]
    }
    const statePlan = flattenStatePlanFromJson(params.statePlan, body)
    if (statePlan === undefined) {
      return [err('params.invalid', 'subgraph.flatten: statePlan must have exact source, node, route, and target coverage')]
    }
    const planEvidence = {
      boundaryPlan: params.boundaryPlan,
      statePlan: params.statePlan,
      schemaPlanDigest: params.schemaPlanDigest,
      ...(occurrencePlan !== undefined ? {
        occurrenceTopologyPlan: params.occurrenceTopologyPlan,
        occurrenceTopologyPlanDigest: params.occurrenceTopologyPlanDigest,
      } : {}),
    }
    const freshness = verifyLifecycleFlattenPlan(doc, graphId, nodeId, params.selectionFingerprint, planEvidence)
    if (freshness.stale) {
      return [lifecycleError('subgraph.lifecycle.stalePlan', 'subgraph.flatten: occurrence, body, incident topology, or view changed after planning', graphId, instancePath, nodeId)]
    }
    const currentSource = {
      occurrence: {
        node: occurrence.id,
        type: occurrence.type,
        values: occurrence.values,
        ...(occurrence.controllers !== undefined && Object.keys(occurrence.controllers).length > 0 ? { controllers: occurrence.controllers } : {}),
        ...(occurrence.dynamic !== undefined && Object.keys(occurrence.dynamic).length > 0 ? { dynamic: occurrence.dynamic } : {}),
      },
      bodyNodes: Object.values(body.nodes).sort((a, b) => compareStrings(a.id, b.id)).map((node) => ({
        node: node.id,
        type: node.type,
        values: node.values,
        ...(node.controllers !== undefined && Object.keys(node.controllers).length > 0 ? { controllers: node.controllers } : {}),
        ...(node.dynamic !== undefined && Object.keys(node.dynamic).length > 0 ? { dynamic: node.dynamic } : {}),
      })),
    }
    if (canonicalJson(statePlan.source) !== canonicalJson(currentSource)) {
      return [err('params.invalid', 'subgraph.flatten: statePlan source must exactly match occurrence and body state')]
    }
    if (statePlan.status === 'refused') {
      return [lifecycleError(statePlan.refusal.code, `subgraph.flatten: ${statePlan.refusal.message}`, graphId, instancePath, nodeId)]
    }
    if (flattenMaterializedIdentitiesContainNul(statePlan)) {
      return [lifecycleError('subgraph.flatten.stateUnresolved', 'subgraph.flatten: persisted family materialization produced a NUL identity', graphId, instancePath, nodeId)]
    }
    if (hasSelectedModePanelBinding(doc, graphId, canonicalizeLifecycleSelection({ nodeIds: [nodeId] }))) {
      return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', 'subgraph.flatten: a durable mode-panel binding targets the occurrence', graphId, instancePath, nodeId)]
    }

    const bodyView = doc.view.graphs[bodyId]
    const bodySelection = flattenBodySelection(body, bodyView)
    const occurrenceItems = geometryItemsFromJson([params.resolvedGeometry.occurrence] as unknown as Json)
    const bodyItems = geometryItemsFromJson(params.resolvedGeometry.body)
    const occurrenceGeometry = occurrenceItems?.length === 1 && occurrenceItems[0]!.id === nodeId
      ? occurrenceItems[0]
      : undefined
    const geometryCoverage = bodyItems === undefined
      ? undefined
      : validateFlattenGeometry(occurrenceGeometry, bodySelection, bodyItems)
    const occurrenceCenter = occurrenceGeometry === undefined ? undefined : {
      x: occurrenceGeometry.x + occurrenceGeometry.width / 2,
      y: occurrenceGeometry.y + occurrenceGeometry.height / 2,
    }
    const placementMatchesOccurrence = occurrenceCenter !== undefined &&
      occurrenceCenter.x === params.placementCenter.x && occurrenceCenter.y === params.placementCenter.y
    const geometryPlan = geometryCoverage?.complete === true && placementMatchesOccurrence
      ? planFlattenedGeometry(bodyItems!, occurrenceCenter)
      : undefined
    if (geometryPlan === undefined) {
      return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', 'subgraph.flatten: resolved geometry must be finite, complete, unique, and body-exact', graphId, instancePath, nodeId)]
    }
    const dag = checkProspectiveFlattenDag(doc, graphId, nodeId)
    if (!dag.ok) {
      return [lifecycleError(dag.code ?? 'subgraph.lifecycle.recursive', 'subgraph.flatten: prospective definition references are recursive', graphId, instancePath, nodeId)]
    }

    for (const link of Object.values(parent.links)) {
      if (isPortEndpoint(link.to) && link.to.node === nodeId) {
        const match = matchBoundaryItem(body.boundary.inputs, link.to)
        if (!match.ok) return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: input '${link.to.port}' has no unique body boundary route`, graphId, instancePath, nodeId, link.to)]
      }
      if (isPortEndpoint(link.from) && link.from.node === nodeId) {
        const match = matchBoundaryItem(body.boundary.outputs, link.from)
        if (!match.ok) return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: output '${link.from.port}' has no unique body boundary route`, graphId, instancePath, nodeId, link.from)]
      }
      if (isWidgetTapRef(link.from) && link.from.node === nodeId) {
        const input = boundaryInputs.get(link.from.tap)
        const route = routePlan.get(JSON.stringify(['input', link.from.tap]))
        if (input === undefined || input.promoted !== true || route !== 'plainWidget' ||
            input.alsoBinds?.some((binding) => binding.kind !== 'port')) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: boundary tap '${link.from.tap}' is not one static promoted plain input`, graphId, instancePath, nodeId)]
        }
      }
    }
    for (const net of Object.values(parent.nets)) {
      if (net.source.node === nodeId && !matchBoundaryItem(body.boundary.outputs, net.source).ok) {
        return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: net source '${net.source.port}' has no unique body boundary route`, graphId, instancePath, nodeId, net.source)]
      }
      for (const sink of net.sinks) {
        if (sink.node === nodeId && !matchBoundaryItem(body.boundary.inputs, sink).ok) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: net sink '${sink.port}' has no unique body boundary route`, graphId, instancePath, nodeId, sink)]
        }
      }
    }

    const additionalDeliveries = occurrencePlan === undefined ? Object.values(parent.links).reduce((count, link) => {
      if (!isPortEndpoint(link.to) || link.to.node !== nodeId) return count
      const match = matchBoundaryItem(body.boundary!.inputs, link.to)
      return count + (match.ok ? Math.max(0, match.item.alsoBinds?.length ?? 0) : 0)
    }, 0) : 0
    const materializedDeliveryCount = occurrencePlan?.links.length ??
      (Object.keys(body.links).length + Object.keys(body.nets).length)
    const projectedDeliveryCount = occurrencePlan?.projectedParentLinks.length ?? 0
    const requiredIds = Object.keys(body.nodes).length + Object.keys(body.reroutes).length +
      Object.keys(body.valueSources ?? {}).length + Object.keys(body.selectors ?? {}).length +
      Object.values(body.selectors ?? {}).reduce((sum, selector) => sum + selector.candidates.length, 0) +
      materializedDeliveryCount + projectedDeliveryCount + additionalDeliveries
    const allocationStart = tx.actor === undefined ? parent.nextOrdinal : actorCursorOf(parent.actorCursors, tx.actor)
    if (!Number.isSafeInteger(allocationStart + requiredIds) || allocationStart + requiredIds > Number.MAX_SAFE_INTEGER) {
      return [lifecycleError('subgraph.lifecycle.idExhausted', 'subgraph.flatten: parent graph id space is exhausted', graphId, instancePath, nodeId)]
    }
    const groupFloor = groupAllocationFloor(doc, graphId)
    const groupCount = bodySelection.groupIds.length
    if (!Number.isSafeInteger(groupFloor + groupCount) || groupFloor + groupCount > Number.MAX_SAFE_INTEGER) {
      return [lifecycleError('subgraph.lifecycle.idExhausted', 'subgraph.flatten: parent group id space is exhausted', graphId, instancePath, nodeId)]
    }

    const allocator = graphAllocator(tx, graphId, parent)
    const nodeIds = new Map<string, string>()
    for (const id of bodySelection.nodeIds) nodeIds.set(id, allocator.mint('n'))
    const valueSourceIds = new Map<string, string>()
    for (const id of bodySelection.valueSourceIds) valueSourceIds.set(id, allocator.mint('v'))
    const selectorIds = new Map<string, string>()
    const candidateIds = new Map<string, string>()
    for (const id of bodySelection.selectorIds) {
      selectorIds.set(id, allocator.mint('s'))
      for (const candidate of [...body.selectors![id]!.candidates].sort((a, b) => compareStrings(a.id, b.id))) {
        candidateIds.set(JSON.stringify([id, candidate.id]), allocator.mint('c'))
      }
    }
    const rerouteIds = new Map<string, string>()
    for (const id of bodySelection.rerouteIds) rerouteIds.set(id, allocator.mint('r'))
    const bodyLinkIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const id of Object.keys(body.links).sort(compareStrings)) bodyLinkIds.set(id, allocator.mint('l'))
    }
    const bodyNetIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const id of Object.keys(body.nets).sort(compareStrings)) bodyNetIds.set(id, allocator.mint('net'))
    }
    const occurrenceLinkIds = occurrencePlan?.links.map(() => allocator.mint('l')) ?? []
    const projectedLinkIds = occurrencePlan?.projectedParentLinks.map(() => allocator.mint('l')) ?? []
    const deliveryIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const link of Object.values(parent.links).sort((a, b) => compareStrings(a.id, b.id))) {
        if (!isPortEndpoint(link.to) || link.to.node !== nodeId) continue
        const matched = matchBoundaryItem(body.boundary.inputs, link.to)
        const additions = matched.ok ? matched.item.alsoBinds?.length ?? 0 : 0
        for (let index = 0; index < additions; index++) {
          deliveryIds.set(JSON.stringify([link.id, index]), allocator.mint('l'))
        }
      }
    }
    const ids: ExtractIdMaps = { nodes: nodeIds, reroutes: rerouteIds, valueSources: valueSourceIds, selectors: selectorIds, candidates: candidateIds }
    const materializedAddresses = new Map(statePlan.addresses.map((entry) => [
      JSON.stringify([entry.side, entry.boundaryId, { port: entry.before.port, ...(entry.before.members !== undefined ? { members: entry.before.members } : {}) }]),
      entry,
    ]))
    const targetsFor = (
      side: 'input' | 'output',
      item: BoundaryItem,
      address: { readonly port: string; readonly members?: readonly string[] },
    ): readonly BoundaryBinding[] | undefined => {
      const route = routePlan.get(JSON.stringify([side, item.id]))
      if (route !== 'family') return flattenBoundaryTargets(item, nodeIds)
      const mapped = materializedAddresses.get(JSON.stringify([side, item.id, {
        port: address.port,
        ...(address.members !== undefined ? { members: address.members } : {}),
      }]))
      if (mapped === undefined || !mapped.uses.includes('endpoint')) return undefined
      const targets = [...mapped.targets].sort((a, b) => a.bindingIndex - b.bindingIndex)
      if (targets.length !== 1 + (item.alsoBinds?.length ?? 0)) return undefined
      return targets.map((target) => remapBinding(target.binding, nodeIds))
    }

    const nodes: Record<string, NodeData> = { ...parent.nodes }
    delete nodes[nodeId]
    const plannedNodes = new Map(statePlan.nodes.map((entry) => [entry.node, entry]))
    for (const [oldId, node] of Object.entries(body.nodes)) {
      const id = nodeIds.get(oldId)!
      const planned = plannedNodes.get(oldId)
      if (planned === undefined) {
        return [err('params.invalid', `subgraph.flatten: statePlan has no post-state for body node '${oldId}'`)]
      }
      const { controllers: _controllers, dynamic: _dynamic, ...nodeWithoutState } = node
      nodes[id] = {
        ...nodeWithoutState,
        id: asNodeId(id),
        values: planned.values,
        ...(planned.controllers !== undefined ? { controllers: planned.controllers } : {}),
        ...(planned.dynamic !== undefined ? { dynamic: planned.dynamic } : {}),
      }
    }
    const reroutes = { ...parent.reroutes }
    for (const [oldId, reroute] of Object.entries(body.reroutes)) {
      const id = rerouteIds.get(oldId)!
      reroutes[id] = { ...reroute, id: asRerouteId(id) }
    }
    const valueSources = { ...(parent.valueSources ?? {}) }
    for (const [oldId, source] of Object.entries(body.valueSources ?? {})) {
      const id = valueSourceIds.get(oldId)!
      valueSources[id] = { ...source, id: asValueSourceId(id) }
    }
    const selectors = { ...(parent.selectors ?? {}) }
    for (const [oldId, selector] of Object.entries(body.selectors ?? {})) {
      const id = selectorIds.get(oldId)!
      const candidates = selector.candidates.map((candidate) => ({
        ...candidate,
        id: asSelectorCandidateId(candidateIds.get(JSON.stringify([oldId, candidate.id]))!),
      }))
      const fixed = selector.policy.kind === 'fixed'
        ? candidateIds.get(JSON.stringify([oldId, selector.policy.candidate]))
        : undefined
      if (selector.policy.kind === 'fixed' && fixed === undefined) {
        return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: selector '${oldId}' has an unmapped fixed candidate`, graphId, instancePath, nodeId)]
      }
      selectors[id] = {
        ...selector,
        id: asSelectorId(id),
        candidates,
        policy: selector.policy.kind === 'fixed'
          ? { kind: 'fixed', candidate: asSelectorCandidateId(fixed!) }
          : { kind: 'random' },
      }
    }

    const links: Record<string, LinkData> = {}
    for (const [id, link] of Object.entries(parent.links)) {
      if (occurrencePlan !== undefined && (
        isPortEndpoint(link.from) && link.from.node === nodeId ||
        isPortEndpoint(link.to) && link.to.node === nodeId
      )) continue
      let from = link.from
      if (isPortEndpoint(from) && from.node === nodeId) {
        const match = matchBoundaryItem(body.boundary.outputs, from)
        const targets = match.ok ? targetsFor('output', match.item, from) : undefined
        if (targets === undefined) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: output '${from.port}' has an unmapped materialized route`, graphId, instancePath, nodeId, from)]
        }
        if (targets.length !== 1) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: output '${from.port}' has no unique inner producer`, graphId, instancePath, nodeId, from)]
        }
        from = endpointFromBinding(targets[0]!)
      } else if (isWidgetTapRef(from) && from.node === nodeId) {
        const target = targetsFor('input', boundaryInputs.get(from.tap)!, { port: from.tap })?.[0]
        if (target === undefined || target.kind === 'widgetTap') {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: tap '${from.tap}' has no materialized target`, graphId, instancePath, nodeId)]
        }
        from = { node: target.node, tap: target.port }
      }
      if (isPortEndpoint(link.to) && link.to.node === nodeId) {
        const match = matchBoundaryItem(body.boundary.inputs, link.to)
        const targets = match.ok ? targetsFor('input', match.item, link.to) : undefined
        if (targets === undefined || targets.length === 0) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: input '${link.to.port}' has no materialized target`, graphId, instancePath, nodeId, link.to)]
        }
        links[id] = { ...link, from, to: portFromBinding(targets[0]!) }
        for (const [index, target] of targets.slice(1).entries()) {
          const deliveryId = deliveryIds.get(JSON.stringify([link.id, index]))
          if (deliveryId === undefined) {
            return [lifecycleError('subgraph.lifecycle.idExhausted', `subgraph.flatten: input '${link.to.port}' has no allocated fan-out delivery`, graphId, instancePath, nodeId, link.to)]
          }
          links[deliveryId] = { ...link, id: asLinkId(deliveryId), from, to: portFromBinding(target) }
        }
      } else {
        links[id] = { ...link, from }
      }
    }
    if (occurrencePlan === undefined) {
      for (const link of Object.values(body.links).sort((a, b) => compareStrings(a.id, b.id))) {
        const id = bodyLinkIds.get(link.id)!
        links[id] = { ...link, id: asLinkId(id), from: remapEndpoint(link.from, ids), to: remapEndpoint(link.to, ids) }
      }
    } else {
      for (const [index, link] of occurrencePlan.links.entries()) {
        const id = occurrenceLinkIds[index]!
        links[id] = {
          id: asLinkId(id),
          from: remapEndpoint(link.from, ids),
          to: remapEndpoint(link.to, ids),
          ...(link.ext !== undefined ? { ext: link.ext } : {}),
        }
      }
      const remapProjectedEndpoint = (endpoint: LinkEndpoint, endpointGraphId: string): LinkEndpoint => {
        if (endpointGraphId !== body.id) return endpoint
        if ((isPortEndpoint(endpoint) || isWidgetTapRef(endpoint)) && nodeIds.has(endpoint.node)) return remapEndpoint(endpoint, ids)
        if (isRerouteRef(endpoint) && rerouteIds.has(endpoint.reroute)) return remapEndpoint(endpoint, ids)
        if (isValueSourceRef(endpoint) && valueSourceIds.has(endpoint.valueSource)) return remapEndpoint(endpoint, ids)
        if (isSelectorRef(endpoint) && selectorIds.has(endpoint.selector)) return remapEndpoint(endpoint, ids)
        return endpoint
      }
      for (const [index, link] of occurrencePlan.projectedParentLinks.entries()) {
        const id = projectedLinkIds[index]!
        links[id] = {
          id: asLinkId(id),
          from: remapProjectedEndpoint(link.from, link.fromGraphId),
          to: remapProjectedEndpoint(link.to, link.toGraphId),
          ...(link.ext !== undefined ? { ext: link.ext } : {}),
        }
      }
    }

    const nets: Record<string, NamedNetData> = {}
    const netSourceRemap = new Map<string, PortRef>()
    const netSinkRemap = new Map<string, readonly PortRef[]>()
    const occurrenceSinkKey = (netId: string, sink: { readonly port: string; readonly members?: readonly string[] }): string =>
      JSON.stringify([netId, sink.port, sink.members ?? []])
    for (const [id, net] of Object.entries(parent.nets)) {
      if (occurrencePlan !== undefined && net.source.node === nodeId) continue
      let source = net.source
      if (source.node === nodeId) {
        const match = matchBoundaryItem(body.boundary.outputs, source)
        const targets = match.ok ? targetsFor('output', match.item, source) : undefined
        if (targets === undefined) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: net source '${source.port}' has no materialized target`, graphId, instancePath, nodeId, source)]
        }
        if (targets.length !== 1) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: output '${source.port}' has no unique inner producer`, graphId, instancePath, nodeId, source)]
        }
        const target = targets[0]!
        if (target.kind === 'widgetTap') {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: net source '${source.port}' resolves to a widget tap, which named nets cannot represent`, graphId, instancePath, nodeId, source)]
        }
        source = portFromBinding(target)
        netSourceRemap.set(id, source)
      }
      const sinks: PortRef[] = []
      for (const sink of net.sinks) {
        if (sink.node !== nodeId) sinks.push(sink)
        else if (occurrencePlan !== undefined) continue
        else {
          const match = matchBoundaryItem(body.boundary.inputs, sink)
          const targets = match.ok ? targetsFor('input', match.item, sink) : undefined
          if (targets === undefined) {
            return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: net sink '${sink.port}' has no materialized target`, graphId, instancePath, nodeId, sink)]
          }
          const expanded = targets.map((target) => portFromBinding(target))
          sinks.push(...expanded)
          netSinkRemap.set(occurrenceSinkKey(id, sink), expanded)
        }
      }
      const sinkKeys = sinks.map(portRefKey)
      if (new Set(sinkKeys).size !== sinkKeys.length) {
        return [lifecycleError('subgraph.lifecycle.multiDriver', `subgraph.flatten: net '${id}' expansion repeats a sink`, graphId, instancePath, nodeId)]
      }
      if (sinks.length > 0) nets[id] = { ...net, source, sinks }
    }
    const removedParentNetIds = new Set(Object.keys(parent.nets).filter((id) => nets[id] === undefined))
    const clonedNetIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const [oldId, net] of Object.entries(body.nets).sort(([a], [b]) => compareStrings(a, b))) {
        const id = bodyNetIds.get(oldId)!
        clonedNetIds.set(oldId, id)
        nets[id] = {
          ...net,
          id: asNetId(id),
          source: remapPort(net.source, nodeIds),
          sinks: net.sinks.map((sink) => remapPort(sink, nodeIds)),
        }
      }
    }

    let boundary = parent.boundary
    if (boundary !== undefined) {
      const rewriteItem = (item: BoundaryItem, side: 'input' | 'output', itemIndex: number): BoundaryItem | undefined => {
        const oldTargets = [item.binds, ...(item.alsoBinds ?? [])]
        const expanded: BoundaryBinding[] = []
        for (const [bindingIndex, target] of oldTargets.entries()) {
          if (target.node !== nodeId) {
            expanded.push(target)
            continue
          }
          const rewrite = statePlan.enclosingRewrites.find((entry) =>
            entry.side === side && entry.itemIndex === itemIndex && entry.itemId === item.id &&
            entry.bindingIndex === bindingIndex && canonicalJson(entry.before) === canonicalJson(target))
          if (rewrite === undefined) return undefined
          expanded.push(...rewrite.after.map((binding) => remapBinding(binding, nodeIds)))
        }
        if (expanded.length === 0) return undefined
        const { alsoBinds: _oldAlsoBinds, ...rest } = item
        return { ...rest, binds: expanded[0]!, ...(expanded.length > 1 ? { alsoBinds: expanded.slice(1) } : {}) }
      }
      const inputs: BoundaryItem[] = []
      for (const [itemIndex, item] of boundary.inputs.entries()) {
        const rewritten = rewriteItem(item, 'input', itemIndex)
        if (rewritten === undefined) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: enclosing input '${item.id}' cannot expand through the occurrence`, graphId, instancePath, nodeId)]
        }
        inputs.push(rewritten)
      }
      const outputs: BoundaryItem[] = []
      for (const [itemIndex, item] of boundary.outputs.entries()) {
        const rewritten = rewriteItem(item, 'output', itemIndex)
        if (rewritten === undefined || rewritten.alsoBinds !== undefined) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: enclosing output '${item.id}' has no unique inner producer`, graphId, instancePath, nodeId)]
        }
        outputs.push(rewritten)
      }
      boundary = { inputs, outputs }
    }

    const parentView = doc.view.graphs[graphId] ?? { nodes: {} }
    const viewNodes = { ...parentView.nodes }
    delete viewNodes[nodeId]
    const translated = new Map(geometryPlan.items.map((item) => [`${item.kind}\u0000${item.id}`, item]))
    for (const oldId of bodySelection.nodeIds) {
      viewNodes[nodeIds.get(oldId)!] = {
        ...(bodyView?.nodes[oldId] ?? {}),
        position: translatedPosition(translated, 'node', oldId),
      }
    }
    const viewReroutes = { ...(parentView.reroutes ?? {}) }
    for (const oldId of bodySelection.rerouteIds) {
      viewReroutes[rerouteIds.get(oldId)!] = {
        ...(bodyView?.reroutes?.[oldId] ?? {}),
        position: translatedPosition(translated, 'reroute', oldId),
      }
    }
    const viewValueSources = { ...(parentView.valueSources ?? {}) }
    for (const oldId of bodySelection.valueSourceIds) {
      viewValueSources[valueSourceIds.get(oldId)!] = {
        ...(bodyView?.valueSources?.[oldId] ?? {}),
        position: translatedPosition(translated, 'valueSource', oldId),
      }
    }
    const viewSelectors = { ...(parentView.selectors ?? {}) }
    for (const oldId of bodySelection.selectorIds) {
      viewSelectors[selectorIds.get(oldId)!] = {
        ...(bodyView?.selectors?.[oldId] ?? {}),
        position: translatedPosition(translated, 'selector', oldId),
      }
    }
    const groups = { ...(parentView.groups ?? {}) }
    for (const [index, oldId] of bodySelection.groupIds.entries()) {
      const old = bodyView!.groups![oldId]!
      const id = `grp${groupFloor + index}`
      const position = translatedPosition(translated, 'group', oldId)
      groups[id] = { ...old, id, bounds: { ...old.bounds, ...position } }
    }
    const collapsedNets = [
      ...(parentView.collapsedNets ?? []).filter((id) => !removedParentNetIds.has(id)),
      ...(bodyView?.collapsedNets ?? []).map((id) => clonedNetIds.get(id)).filter((id): id is string => id !== undefined),
    ]
    const guideNets = [
      ...(parentView.guideNets ?? []).filter((id) => !removedParentNetIds.has(id)),
      ...(bodyView?.guideNets ?? []).map((id) => clonedNetIds.get(id)).filter((id): id is string => id !== undefined),
    ]
    const stagedView: GraphViewState = {
      ...parentView,
      nodes: viewNodes,
      ...(Object.keys(viewReroutes).length > 0 || parentView.reroutes !== undefined ? { reroutes: viewReroutes } : {}),
      ...(Object.keys(viewValueSources).length > 0 || parentView.valueSources !== undefined ? { valueSources: viewValueSources } : {}),
      ...(Object.keys(viewSelectors).length > 0 || parentView.selectors !== undefined ? { selectors: viewSelectors } : {}),
      ...(Object.keys(groups).length > 0 || parentView.groups !== undefined ? { groups } : {}),
      ...(groupCount > 0 ? { groupSeq: groupFloor + groupCount } : {}),
      ...(collapsedNets.length > 0 || parentView.collapsedNets !== undefined ? { collapsedNets } : {}),
      ...(guideNets.length > 0 || parentView.guideNets !== undefined ? { guideNets } : {}),
    }
    const endingCursor = allocationStart + requiredIds
    const stagedParent: GraphDef = {
      ...parent,
      nodes,
      links,
      nets,
      reroutes,
      ...(parent.valueSources !== undefined || body.valueSources !== undefined ? { valueSources } : {}),
      ...(parent.selectors !== undefined || body.selectors !== undefined ? { selectors } : {}),
      ...(boundary !== undefined ? { boundary } : {}),
      ...(tx.actor === undefined
        ? { nextOrdinal: endingCursor }
        : { actorCursors: { ...(parent.actorCursors ?? {}), [tx.actor]: endingCursor } }),
    }
    const remainingTopologies = occurrencePlan === undefined
      ? doc.occurrenceTopologies
      : Object.fromEntries(Object.entries(doc.occurrenceTopologies ?? {}).filter(([key]) => key !== topologyKey))
    const { occurrenceTopologies: _oldTopologies, ...docWithoutTopologies } = doc
    const staged: WorkflowDocument = {
      ...(occurrencePlan === undefined ? doc : docWithoutTopologies),
      graphs: { ...doc.graphs, [graphId]: stagedParent },
      view: { ...doc.view, graphs: { ...doc.view.graphs, [graphId]: stagedView } },
      ...(occurrencePlan !== undefined && Object.keys(remainingTopologies ?? {}).length > 0
        ? { occurrenceTopologies: remainingTopologies }
        : {}),
    }
    if (stagedFlattenIdentitiesContainNul(
      statePlan,
      stagedParent,
      body,
      nodeIds,
      new Set(bodyLinkIds.values()),
      new Set(clonedNetIds.values()),
    )) {
      return [lifecycleError('subgraph.flatten.stateUnresolved', 'subgraph.flatten: staged materialization produced a NUL identity', graphId, instancePath, nodeId)]
    }
    const stagedErrors = checkDocument(staged).filter((diagnostic) => diagnostic.severity === 'error')
    const multiDriver = stagedErrors.find((diagnostic) => diagnostic.code.includes('multiDriver'))
    if (multiDriver !== undefined) {
      return [lifecycleError('subgraph.lifecycle.multiDriver', `subgraph.flatten: staged topology has conflicting deliveries (${multiDriver.message})`, graphId, instancePath, nodeId)]
    }
    if (stagedErrors.length > 0) return stagedErrors

    tx.set(['graphs', graphId, 'nodes'], nodes as unknown as Json)
    tx.set(['graphs', graphId, 'links'], links as unknown as Json)
    tx.set(['graphs', graphId, 'nets'], nets as unknown as Json)
    tx.set(['graphs', graphId, 'reroutes'], reroutes as unknown as Json)
    if (parent.valueSources !== undefined || body.valueSources !== undefined) tx.set(['graphs', graphId, 'valueSources'], valueSources as unknown as Json)
    if (parent.selectors !== undefined || body.selectors !== undefined) tx.set(['graphs', graphId, 'selectors'], selectors as unknown as Json)
    if (boundary !== undefined) tx.set(['graphs', graphId, 'boundary'], boundary as unknown as Json)
    tx.set(['view', 'graphs', graphId], stagedView as unknown as Json)
    if (occurrencePlan !== undefined) {
      if (Object.keys(remainingTopologies ?? {}).length === 0) tx.remove(['occurrenceTopologies'])
      else tx.set(['occurrenceTopologies'], remainingTopologies as unknown as Json)
    }
    // Tag placements survive the flatten. Parent-graph entries anchored to
    // the removed occurrence move onto the expanded endpoints (duplicated for
    // fan-out sinks), re-anchoring offsets so the on-screen point holds when
    // stored positions allow it; entries of nets that vanish are dropped.
    // Body-graph placements ride along with the cloned nets: offsets are
    // node-relative, so remapping ids is enough, and the body definition may
    // still be shared, so its own entries stay untouched.
    const rawNetViews = doc.ext?.[NET_VIEWS_EXT_KEY]
    if (Array.isArray(rawNetViews)) {
      const occurrencePosition = parentView.nodes[nodeId]?.position
      const reanchored = (geometry: NetViewGeometry, anchorNode: string): NetViewGeometry => {
        if (geometry.kind !== 'offset') return geometry
        const anchor = viewNodes[anchorNode]?.position
        if (occurrencePosition === undefined || anchor === undefined) return geometry
        const x = Math.round((occurrencePosition.x + geometry.x - anchor.x) * 100) / 100
        const y = Math.round((occurrencePosition.y + geometry.y - anchor.y) * 100) / 100
        return Number.isFinite(x) && Number.isFinite(y) ? { kind: 'offset', x, y } : geometry
      }
      const next: Json[] = []
      let changed = false
      for (const raw of rawNetViews) {
        const entry = parseNetViewPosition(raw)
        if (entry !== undefined && entry.graphId === graphId) {
          if (removedParentNetIds.has(entry.netId)) {
            changed = true
            continue
          }
          if (entry.role === 'sink' && entry.to.node === nodeId) {
            const targets = netSinkRemap.get(occurrenceSinkKey(entry.netId, entry.to))
            changed = true
            if (targets === undefined) continue
            for (const target of targets) {
              next.push(netViewToJson({ ...entry, to: target, geometry: reanchored(entry.geometry, target.node) }))
            }
            continue
          }
          if (entry.role === 'source' && entry.geometry.kind === 'offset') {
            const source = netSourceRemap.get(entry.netId)
            if (source !== undefined) {
              next.push(netViewToJson({ ...entry, geometry: reanchored(entry.geometry, source.node) }))
              changed = true
              continue
            }
          }
        }
        next.push(raw)
      }
      for (const raw of rawNetViews) {
        const entry = parseNetViewPosition(raw)
        if (entry === undefined || entry.graphId !== body.id || entry.geometry.kind !== 'offset') continue
        const netId = clonedNetIds.get(entry.netId)
        if (netId === undefined) continue
        if (entry.role === 'sink') {
          const node = nodeIds.get(entry.to.node)
          if (node === undefined) continue
          next.push(netViewToJson({ ...entry, graphId, netId, to: { ...entry.to, node: asNodeId(node) } }))
        } else {
          next.push(netViewToJson({ ...entry, graphId, netId }))
        }
        changed = true
      }
      if (changed) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    }
    allocator.commit()
    return []
  },
}

function localizedOccurrenceRelation(
  doc: WorkflowDocument,
  owner: OccurrenceRef,
  graphId: string,
  nodeId: string,
): { readonly affected: boolean; readonly direct: boolean } {
  let graph = doc.graphs[doc.root]
  const hops = [...owner.instancePath, owner.node]
  for (const [index, hop] of hops.entries()) {
    if (graph?.id === graphId && hop === nodeId) return { affected: true, direct: index === hops.length - 1 }
    const node = graph?.nodes[hop]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    graph = childId === undefined ? undefined : doc.graphs[childId]
  }
  return { affected: false, direct: false }
}

const remapRoute = (route: readonly BoundaryRouteLeg[], sourceId: string, freshId: string): BoundaryRouteLeg[] =>
  route.map((leg) => leg.graph === sourceId ? { ...leg, graph: asGraphDefId(freshId) } : leg)

function remapSuppression(delivery: SuppressedDelivery, sourceId: string, freshId: string): SuppressedDelivery {
  if (delivery.kind !== 'projectedLeg') return delivery
  return {
    ...delivery,
    delivery: delivery.delivery.graph === sourceId
      ? { ...delivery.delivery, graph: asGraphDefId(freshId) }
      : delivery.delivery,
    route: remapRoute(delivery.route, sourceId, freshId),
  }
}

function remapLocalizedTopology(
  topology: OccurrenceTopology,
  sourceId: string,
  freshId: string,
  direct: boolean,
): OccurrenceTopology {
  return {
    ...topology,
    ...(direct ? { bodyGraph: asGraphDefId(freshId) } : {}),
    links: Object.fromEntries(Object.entries(topology.links).map(([key, link]) => [key, {
      ...link,
      from: link.from.kind === 'boundary'
        ? { ...link.from, route: remapRoute(link.from.route, sourceId, freshId) }
        : link.from,
      to: link.to.kind === 'boundary'
        ? { ...link.to, route: remapRoute(link.to.route, sourceId, freshId) }
        : link.to,
    }])),
    ...(topology.suppressedDeliveries === undefined ? {} : {
      suppressedDeliveries: topology.suppressedDeliveries.map((delivery) =>
        remapSuppression(delivery, sourceId, freshId)),
    }),
  }
}

const occurrenceLocalize: CommandDefinition = {
  id: 'occurrence.localize',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string') {
      return [err('params.invalid', 'occurrence.localize: params must include graphId and nodeId')]
    }
    const parent = doc.graphs[params.graphId]
    const occurrence = parent?.nodes[params.nodeId]
    const sourceId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
    const source = sourceId === undefined ? undefined : doc.graphs[sourceId]
    if (parent === undefined || occurrence === undefined || sourceId === undefined || source === undefined) {
      return [err('subgraph.localize.notOccurrence', 'occurrence.localize: target is not a resolvable subgraph occurrence')]
    }
    const linkedCount = Object.values(doc.graphs).reduce((count, graph) =>
      count + Object.values(graph.nodes).filter((node) => subgraphDefIdOf(node.type) === sourceId).length, 0)
    if (linkedCount < 2) {
      return [err('subgraph.localize.notShared', 'occurrence.localize: definition has fewer than two occurrences')]
    }
    const freshId = freshDefinitionId(doc)
    tx.set(['graphs', freshId], {
      ...structuredClone(source),
      id: asGraphDefId(freshId),
      name: `${source.name} (Unique)`,
    } as unknown as Json)
    tx.set(['view', 'graphs', freshId], structuredClone(doc.view.graphs[sourceId] ?? { nodes: {} }) as unknown as Json)
    tx.set(['graphs', params.graphId, 'nodes', params.nodeId, 'type'], `#${freshId}`)
    // The clone keeps parity with its source: exposed parameters targeting
    // the source definition are duplicated onto the clone so the unique
    // occurrence keeps its app-view controls. Originals stay for the
    // occurrences still sharing the source; malformed entries pass through.
    const rawExposed = doc.ext?.[EXPOSED_EXT_KEY]
    if (Array.isArray(rawExposed)) {
      const next: Json[] = []
      let copied = false
      for (const raw of rawExposed) {
        next.push(raw)
        if (isObj(raw) && parseExposedEntry(raw)?.graphId === sourceId) {
          next.push({ ...raw, graphId: freshId })
          copied = true
        }
      }
      if (copied) tx.set(['ext', EXPOSED_EXT_KEY], next)
    }
    const rawExposedPreviews = doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]
    if (Array.isArray(rawExposedPreviews)) {
      const next: Json[] = []
      let copied = false
      for (const raw of rawExposedPreviews) {
        next.push(raw)
        if (isObj(raw) && parseExposedPreviewEntry(raw)?.graphId === sourceId) {
          next.push({ ...raw, graphId: freshId })
          copied = true
        }
      }
      if (copied) tx.set(['ext', EXPOSED_PREVIEWS_EXT_KEY], next)
    }
    const rawCloneNetViews = doc.ext?.[NET_VIEWS_EXT_KEY]
    if (Array.isArray(rawCloneNetViews)) {
      const next: Json[] = []
      let copied = false
      for (const raw of rawCloneNetViews) {
        next.push(raw)
        if (isObj(raw) && parseNetViewPosition(raw)?.graphId === sourceId) {
          next.push({ ...raw, graphId: freshId })
          copied = true
        }
      }
      if (copied) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    }
    const localizedLayout = localizeAppLayoutJson(doc.ext?.[APP_LAYOUT_EXT_KEY], sourceId, freshId)
    if (localizedLayout !== undefined) tx.set(['ext', APP_LAYOUT_EXT_KEY], localizedLayout)
    const topologies = Object.fromEntries(Object.entries(doc.occurrenceTopologies ?? {}).map(([key, topology]) => {
      const relation = localizedOccurrenceRelation(doc, topology.owner, params.graphId as string, params.nodeId as string)
      return [key, relation.affected
        ? remapLocalizedTopology(topology, sourceId, freshId, relation.direct)
        : topology]
    }))
    if (Object.values(topologies).some((topology, index) => topology !== Object.values(doc.occurrenceTopologies ?? {})[index])) {
      tx.set(['occurrenceTopologies'], topologies as unknown as Json)
    }
    return []
  },
}

function removeDefinitionSupportState(doc: WorkflowDocument, removed: ReadonlySet<string>, tx: TransactionBuilder): void {
  for (const graphId of removed) {
    tx.remove(['graphs', graphId])
    if (doc.view.graphs[graphId] !== undefined) tx.remove(['view', 'graphs', graphId])
  }

  const exposed = doc.ext?.[EXPOSED_EXT_KEY]
  if (Array.isArray(exposed)) {
    const kept = exposed.filter((raw) => {
      const entry = parseExposedEntry(raw)
      return entry === undefined || !removed.has(entry.graphId)
    })
    if (kept.length !== exposed.length) tx.set(['ext', EXPOSED_EXT_KEY], kept)
  }
  const exposedPreviews = doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]
  if (Array.isArray(exposedPreviews)) {
    const kept = exposedPreviews.filter((raw) => {
      const entry = parseExposedPreviewEntry(raw)
      return entry === undefined || !removed.has(entry.graphId)
    })
    if (kept.length !== exposedPreviews.length) tx.set(['ext', EXPOSED_PREVIEWS_EXT_KEY], kept)
  }
  const appLayout = removeAppLayoutGraphRefs(doc.ext?.[APP_LAYOUT_EXT_KEY], removed)
  if (appLayout !== undefined) tx.set(['ext', APP_LAYOUT_EXT_KEY], appLayout)
  const netViews = doc.ext?.[NET_VIEWS_EXT_KEY]
  if (Array.isArray(netViews)) {
    const kept = netViews.filter((raw) => {
      const entry = parseNetViewPosition(raw)
      return entry === undefined || !removed.has(entry.graphId)
    })
    if (kept.length !== netViews.length) tx.set(['ext', NET_VIEWS_EXT_KEY], kept)
  }
  for (const [surfaceId, surface] of Object.entries(doc.surfaces ?? {})) {
    if (surface.type !== MODE_PANEL_TYPE) continue
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) continue
    const rawBindings = surface.config.bindings as readonly Json[]
    const bindings = rawBindings.filter((_, index) => {
      const binding = decoded.config.bindings[index]!
      return binding.kind === 'unknown' || !removed.has(binding.graphId)
    })
    if (bindings.length !== rawBindings.length) {
      tx.set(['surfaces', surfaceId, 'config'], { ...surface.config, bindings })
    }
  }
  for (const [slot, bookmark] of Object.entries(doc.view.bookmarks ?? {})) {
    if (bookmark.graphStack.some((graphId) => removed.has(graphId))) tx.remove(['view', 'bookmarks', slot])
  }
}

const removeUnusedDefinitions: CommandDefinition = {
  id: 'subgraph.removeUnusedDefinitions',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.definitionIds) ||
        !params.definitionIds.every((id) => typeof id === 'string') ||
        typeof params.fingerprint !== 'string') {
      return [err('params.invalid', 'subgraph.removeUnusedDefinitions: params must include definitionIds and fingerprint')]
    }
    const plan = planSubgraphDefinitionCleanup(doc)
    const expected = plan.removable.map((entry) => entry.id)
    const supplied = params.definitionIds as readonly string[]
    if (params.fingerprint !== plan.fingerprint || supplied.length !== expected.length ||
        supplied.some((id, index) => id !== expected[index])) {
      return [err('subgraph.cleanup.stalePlan', 'subgraph.removeUnusedDefinitions: definition reachability changed after preview')]
    }
    if (expected.length === 0) return [err('subgraph.cleanup.noneUnused', 'subgraph.removeUnusedDefinitions: no unused definitions remain')]
    removeDefinitionSupportState(doc, new Set(expected), tx)
    return []
  },
}

const deleteDefinition: CommandDefinition = {
  id: 'subgraph.deleteDefinition',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.definitionId !== 'string' || typeof params.fingerprint !== 'string') {
      return [err('params.invalid', 'subgraph.deleteDefinition: params must include definitionId and fingerprint')]
    }
    const plan = planSubgraphDefinitionCleanup(doc)
    if (params.fingerprint !== plan.fingerprint) {
      return [err('subgraph.cleanup.stalePlan', 'subgraph.deleteDefinition: definition reachability changed after preview')]
    }
    const candidate = plan.removable.find((entry) => entry.id === params.definitionId)
    if (candidate === undefined) {
      return [err('subgraph.cleanup.definitionInUse', 'subgraph.deleteDefinition: definition is missing or reachable from root')]
    }
    const referencedByAnotherUnused = plan.removable.some((entry) =>
      entry.id !== candidate.id && entry.dependencies.includes(candidate.id))
    if (referencedByAnotherUnused) {
      return [err('subgraph.cleanup.definitionInUse', 'subgraph.deleteDefinition: another unused definition still references this definition')]
    }
    removeDefinitionSupportState(doc, new Set([candidate.id]), tx)
    return []
  },
}

export const SUBGRAPH_COMMANDS: readonly CommandDefinition[] = [
  subgraphImport,
  subgraphExtract,
  subgraphFlatten,
  occurrenceLocalize,
  deleteDefinition,
  removeUnusedDefinitions,
]
