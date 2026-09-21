/**
 * Replacement application: `node.replace` executes a finished
 * NodeReplacePlan as ONE atomic, undoable document transaction.
 *
 * Schema-blind like every core command: PLANNING (schema defaults, port
 * validation, guard evaluation) happened in replace/plan.ts; this command
 * validates the plan against the CURRENT document and applies it verbatim.
 * A stale plan - node gone, type changed, a referenced link/net missing or
 * no longer touching this node - fails whole with diagnostics and applies
 * NOTHING (dispatch discards the transaction on any error). Never a partial
 * migration.
 *
 * What survives on the node: its id (links/nets/view/groups reference it),
 * position, size, title, mode, and ext. Migration plans may add a recoverable
 * source snapshot to ext. What is replaced: type, values
 * (complete explicit set from the plan), controllers, and planned dynamic
 * state. Unmapped dynamic state is dropped. Subgraph boundary
 * bindings on the node follow the plan's boundaryRewires in the same
 * transaction.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { canonicalJson, fnv1a64 } from '../compile/hash.js'
import { MAX_DYNAMIC_STATE_DEPTH, type ControllerMode, type GraphDef, type Json, type JsonObject, type WorkflowDocument } from '../format/document.js'
import { asPortId, isExactWidgetTapRef, isPortEndpoint, isWidgetTapRef, samePortRef, type PortRef } from '../ids.js'
import { graphAllocator } from './alloc.js'
import type { CommandDefinition, CommandInvocation } from './contract.js'
import {
  REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY,
  type NodeReplacePlan,
} from '../replace/plan.js'
import { occurrenceEndpointReferencesDefinition } from '../compile/effective-topology.js'
import { pruneNetDisplayState, removeAuthoredNetViews, removeNetDeliverySuppressions, removeProjectedLinkSuppressions } from './occurrence-cleanup.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const dynamicPortHasSelection = (value: Json): boolean => {
  if (!isObj(value)) return false
  if (typeof value.selected === 'string') return true
  if (!isObj(value.memberState)) return false
  return Object.values(value.memberState).some((constructs) =>
    isObj(constructs) && Object.values(constructs).some(dynamicPortHasSelection),
  )
}

const dynamicStateHasSelection = (value: Json | undefined): boolean =>
  isObj(value) && Object.values(value).some(dynamicPortHasSelection)

function graphOf(doc: WorkflowDocument, graphId: Json | undefined): GraphDef | undefined {
  return typeof graphId === 'string' ? doc.graphs[graphId] : undefined
}

const isRewire = (v: Json): v is JsonObject & { link: string; port: string; node?: string } =>
  isObj(v) && typeof v.link === 'string' && v.link.length > 0 &&
  typeof v.port === 'string' && v.port.length > 0 &&
  (v.node === undefined || (typeof v.node === 'string' && v.node.length > 0))
const STRUCTURAL_ID = /^[A-Za-z0-9_-]+$/
const isMemberPath = (v: Json | undefined): v is string[] =>
  Array.isArray(v) && v.length === 1 && v.every((member) => typeof member === 'string' && STRUCTURAL_ID.test(member))
const sameMembers = (actual: readonly string[] | undefined, expected: readonly string[] | undefined): boolean =>
  actual !== undefined && expected !== undefined &&
  actual.length === expected.length && actual.every((member, index) => member === expected[index])
const isOutputRewire = (v: Json): v is JsonObject & {
  link: string
  port: string
  node?: string
  members?: string[]
  fromPort?: string
  fromMembers?: string[]
} =>
  isRewire(v) &&
  (v.members === undefined || isMemberPath(v.members)) &&
  (v.fromPort === undefined || (typeof v.fromPort === 'string' && v.fromPort.length > 0)) &&
  (v.fromMembers === undefined || isMemberPath(v.fromMembers)) &&
  (v.fromMembers === undefined || v.fromPort !== undefined)
const isNetRewire = (v: Json): v is JsonObject & {
  net: string
  port: string
  node?: string
  members?: string[]
  fromPort?: string
  fromMembers?: string[]
} =>
  isObj(v) && typeof v.net === 'string' && v.net.length > 0 &&
  typeof v.port === 'string' && v.port.length > 0 &&
  (v.node === undefined || (typeof v.node === 'string' && v.node.length > 0)) &&
  (v.members === undefined || isMemberPath(v.members)) &&
  (v.fromPort === undefined || (typeof v.fromPort === 'string' && v.fromPort.length > 0)) &&
  (v.fromMembers === undefined || isMemberPath(v.fromMembers)) &&
  (v.fromMembers === undefined || v.fromPort !== undefined)
const isTapGuard = (v: Json): v is JsonObject & { link: string; tap: string } =>
  isObj(v) && typeof v.link === 'string' && v.link.length > 0 &&
  typeof v.tap === 'string' && v.tap.length > 0
const isTapRewire = (v: Json): v is JsonObject & { link: string; tap: string; fromTap?: string; node?: string } =>
  isTapGuard(v) &&
  (v.fromTap === undefined || (typeof v.fromTap === 'string' && v.fromTap.length > 0)) &&
  (v.node === undefined || (typeof v.node === 'string' && v.node.length > 0))
const isViewRewire = (v: Json): v is JsonObject & { from: string; to: string; node?: string } =>
  isObj(v) && typeof v.from === 'string' && v.from.length > 0 &&
  typeof v.to === 'string' && v.to.length > 0 &&
  (v.node === undefined || (typeof v.node === 'string' && v.node.length > 0))
const isInputViewRewire = (v: Json): v is JsonObject & { fromInput: string; input: string } =>
  isObj(v) && typeof v.fromInput === 'string' && v.fromInput.length > 0 &&
  typeof v.input === 'string' && v.input.length > 0
const isPortRefJson = (v: Json): v is JsonObject & { node: string; port: string } =>
  isObj(v) && typeof v.node === 'string' && typeof v.port === 'string'
const isNetSinks = (v: Json): v is JsonObject & { net: string; sinks: Json[] } =>
  isObj(v) && typeof v.net === 'string' && Array.isArray(v.sinks) && v.sinks.every(isPortRefJson)
const isNetSinkEdit = (v: Json): v is JsonObject & { net: string; from: JsonObject & { node: string; port: string }; to?: JsonObject & { node: string; port: string } } =>
  isObj(v) && typeof v.net === 'string' && v.net.length > 0 && v.from !== undefined && isPortRefJson(v.from) &&
  (v.to === undefined || isPortRefJson(v.to))
const isStringArray = (v: Json | undefined): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')
const isSourceCountGuards = (v: Json): v is JsonObject =>
  isObj(v) && Object.entries(v).every(([input, count]) =>
    STRUCTURAL_ID.test(input) && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
  )
const isTargetSchemaGuard = (v: Json): v is JsonObject & { nodeId: string; type: string; schemaHash: string } =>
  isObj(v) &&
  Object.keys(v).length === 3 &&
  typeof v.nodeId === 'string' && v.nodeId.length > 0 &&
  typeof v.type === 'string' && v.type.length > 0 && !v.type.startsWith('#') &&
  typeof v.schemaHash === 'string' && /^[0-9a-f]{16}$/.test(v.schemaHash)
const isBoundaryRewire = (v: Json): v is JsonObject & { item: string; side: 'input' | 'output'; fromPort: string; port: string; alsoIndex?: number } =>
  isObj(v) &&
  typeof v.item === 'string' &&
  (v.side === 'input' || v.side === 'output') &&
  typeof v.fromPort === 'string' &&
  typeof v.port === 'string' &&
  (v.alsoIndex === undefined || typeof v.alsoIndex === 'number')
const isBoundaryGuard = (v: Json): v is JsonObject & { item: string; side: 'input' | 'output'; port: string; alsoIndex?: number; promoted?: boolean } =>
  isObj(v) &&
  typeof v.item === 'string' &&
  (v.side === 'input' || v.side === 'output') &&
  typeof v.port === 'string' &&
  (v.alsoIndex === undefined || typeof v.alsoIndex === 'number') &&
  (v.promoted === undefined || typeof v.promoted === 'boolean')
const CONTROLLER_MODES = new Set<ControllerMode>(['fixed', 'increment', 'decrement', 'randomize'])
const DYNAMIC_STATE_KEYS = new Set(['members', 'memberLabels', 'seq', 'selected', 'memberState'])
const isDynamicPortState = (v: Json, depth = 0): boolean => {
  if (!isObj(v) || depth > MAX_DYNAMIC_STATE_DEPTH || Object.keys(v).some((key) => !DYNAMIC_STATE_KEYS.has(key)))
    return false
  if (v.members !== undefined && (
    !Array.isArray(v.members) ||
    !v.members.every((member) => typeof member === 'string' && member.length > 0) ||
    new Set(v.members).size !== v.members.length
  )) return false
  if (v.seq !== undefined && (typeof v.seq !== 'number' || !Number.isSafeInteger(v.seq) || v.seq < 0)) return false
  if (v.selected !== undefined && (typeof v.selected !== 'string' || v.selected.length === 0)) return false
  if (v.memberLabels !== undefined && (!isObj(v.memberLabels) ||
      !Object.entries(v.memberLabels).every(([member, label]) =>
        member.length > 0 && typeof label === 'string' && label.length > 0))) return false
  if (v.memberState === undefined) return true
  return isObj(v.memberState) && Object.entries(v.memberState).every(([member, scope]) =>
    member.length > 0 && isObj(scope) && Object.entries(scope).every(([construct, state]) =>
      construct.length > 0 && isDynamicPortState(state, depth + 1),
    ),
  )
}
const isDynamicScope = (v: Json): v is JsonObject =>
  isObj(v) && Object.entries(v).every(([construct, state]) =>
    construct.length > 0 && isDynamicPortState(state),
  )
const isCreatedNode = (v: Json): v is JsonObject & {
  nodeId: string
  localId: string
  type: string
  values: JsonObject
  dynamic?: JsonObject
  controllers?: JsonObject
} =>
  isObj(v) &&
  typeof v.nodeId === 'string' && v.nodeId.length > 0 &&
  typeof v.localId === 'string' && STRUCTURAL_ID.test(v.localId) &&
  typeof v.type === 'string' && v.type.length > 0 && !v.type.startsWith('#') &&
  isObj(v.values) &&
  (v.dynamic === undefined || isDynamicScope(v.dynamic)) &&
  (v.controllers === undefined ||
    (isObj(v.controllers) &&
      Object.values(v.controllers).every(
        (mode) => typeof mode === 'string' && CONTROLLER_MODES.has(mode as ControllerMode),
      )))
const isStaticEndpoint = (v: Json | undefined): v is JsonObject & { node: string; port: string } =>
  isObj(v) &&
  Object.keys(v).length === 2 &&
  typeof v.node === 'string' && v.node.length > 0 &&
  typeof v.port === 'string' && v.port.length > 0
const isInternalLink = (v: Json): v is JsonObject & { from: JsonObject & { node: string; port: string }; to: JsonObject & { node: string; port: string } } =>
  isObj(v) && Object.keys(v).length === 2 && isStaticEndpoint(v.from) && isStaticEndpoint(v.to)
const isMigrationArchive = (v: Json): v is JsonObject & {
  version: 1
  historicalInputs: string[]
  node: JsonObject
  links: JsonObject
  nets: JsonObject
  view: JsonObject | null
  boundary: JsonObject | null
} =>
  isObj(v) &&
  Object.keys(v).length === 7 &&
  v.version === 1 &&
  isStringArray(v.historicalInputs) && v.historicalInputs.length > 0 &&
  isObj(v.node) &&
  isObj(v.links) && Object.values(v.links).every(isObj) &&
  isObj(v.nets) && Object.values(v.nets).every(isObj) &&
  (v.view === null || isObj(v.view)) &&
  (v.boundary === null || isObj(v.boundary))

const migrationNetProjection = (net: Json | undefined, nodeId: string): Json => {
  if (!isObj(net) || !Array.isArray(net.sinks)) return net ?? null
  return {
    ...net,
    sinks: net.sinks.filter((sink) => isObj(sink) && sink.node === nodeId),
  }
}

// ---------------------------------------------------------------------------
// node.replace {plan: NodeReplacePlan}
// ---------------------------------------------------------------------------

const nodeReplace: CommandDefinition = {
  id: 'node.replace',
  run(doc, params, tx, context) {
    if (!isObj(params) || !isObj(params.plan))
      return [err('params.invalid', 'node.replace: params must be {plan: NodeReplacePlan}')]
    const p = params.plan
    const planHasDynamicSelection = dynamicStateHasSelection(p.dynamic) ||
      (Array.isArray(p.createdNodes) && p.createdNodes.some((created) =>
        isObj(created) && dynamicStateHasSelection(created.dynamic),
      ))
    const selectedTargetTypes = new Map<string, string>()
    if (dynamicStateHasSelection(p.dynamic) && typeof p.nodeId === 'string' && typeof p.to === 'string')
      selectedTargetTypes.set(p.nodeId, p.to)
    if (Array.isArray(p.createdNodes)) {
      for (const created of p.createdNodes) {
        if (
          isObj(created) &&
          dynamicStateHasSelection(created.dynamic) &&
          typeof created.nodeId === 'string' &&
          typeof created.type === 'string'
        ) selectedTargetTypes.set(created.nodeId, created.type)
      }
    }
    const targetSchemaGuards = Array.isArray(p.targetSchemaGuards) && p.targetSchemaGuards.every(isTargetSchemaGuard)
      ? p.targetSchemaGuards as readonly (JsonObject & { nodeId: string; type: string; schemaHash: string })[]
      : undefined
    const targetSchemaGuardsValid = targetSchemaGuards !== undefined &&
      targetSchemaGuards.length === selectedTargetTypes.size &&
      new Set(targetSchemaGuards.map((guard) => guard.nodeId)).size === targetSchemaGuards.length &&
      targetSchemaGuards.every((guard) => selectedTargetTypes.get(guard.nodeId) === guard.type)
    if (
      typeof p.graphId !== 'string' ||
      typeof p.nodeId !== 'string' ||
      typeof p.from !== 'string' ||
      typeof p.to !== 'string' ||
      !isObj(p.values) ||
      !Array.isArray(p.inputRewires) ||
      !p.inputRewires.every(isRewire) ||
      (p.tapRewires !== undefined && !(Array.isArray(p.tapRewires) && p.tapRewires.every(isTapRewire))) ||
      (p.inputViewRewires !== undefined && !(Array.isArray(p.inputViewRewires) && p.inputViewRewires.every(isInputViewRewire))) ||
      (p.dropInputViews !== undefined && !isStringArray(p.dropInputViews)) ||
      !Array.isArray(p.outputRewires) ||
      !p.outputRewires.every(isOutputRewire) ||
      (p.tapGuards !== undefined && !(Array.isArray(p.tapGuards) && p.tapGuards.every(isTapGuard))) ||
      (p.viewRewires !== undefined && !(Array.isArray(p.viewRewires) && p.viewRewires.every(isViewRewire))) ||
      !isStringArray(p.dropLinks) ||
      !Array.isArray(p.netSourceRewires) ||
      !p.netSourceRewires.every(isNetRewire) ||
      !Array.isArray(p.netSinks) ||
      !p.netSinks.every(isNetSinks) ||
      (p.netSinkEdits !== undefined && !(Array.isArray(p.netSinkEdits) && p.netSinkEdits.every(isNetSinkEdit))) ||
      !isStringArray(p.dropNets) ||
      (p.dynamic !== undefined && !isDynamicScope(p.dynamic)) ||
      (p.sourceCountGuards !== undefined && !isSourceCountGuards(p.sourceCountGuards)) ||
      (p.targetSchemaGuards !== undefined && !targetSchemaGuardsValid) ||
      (planHasDynamicSelection && p.targetSchemaGuards === undefined) ||
      (p.controllers !== undefined && !isObj(p.controllers)) ||
      (p.migrationArchive !== undefined && !isMigrationArchive(p.migrationArchive)) ||
      (p.migrationArchive !== undefined && p.createdNodes === undefined) ||
      (p.migrationFallback !== undefined && p.migrationFallback !== true) ||
      (p.migrationFallback === true && p.migrationArchive === undefined) ||
      (p.migrationArchive === undefined &&
        (p.inputViewRewires !== undefined || p.dropInputViews !== undefined)) ||
      (p.boundaryRewires !== undefined && !(Array.isArray(p.boundaryRewires) && p.boundaryRewires.every(isBoundaryRewire))) ||
      (p.boundaryGuard !== undefined && !(Array.isArray(p.boundaryGuard) && p.boundaryGuard.every(isBoundaryGuard))) ||
      (p.createdNodes !== undefined && !(Array.isArray(p.createdNodes) && p.createdNodes.every(isCreatedNode))) ||
      (p.links !== undefined && !(Array.isArray(p.links) && p.links.every(isInternalLink)))
    )
      return [err('params.invalid', 'node.replace: malformed plan')]

    const def = graphOf(doc, p.graphId)
    if (!def) return [err('graph.missing', `node.replace: unknown graph '${p.graphId}'`)]
    const node = def.nodes[p.nodeId]
    if (!node) return [err('node.missing', `node.replace: no node '${p.nodeId}' in '${p.graphId}'`)]
    const nodeId = p.nodeId
    if (Object.values(doc.occurrenceTopologies ?? {}).some((topology) =>
      topology.bodyGraph === p.graphId && Object.values(topology.links).some((link) =>
        [link.from, link.to].some((endpoint) => occurrenceEndpointReferencesDefinition(endpoint, p.graphId as string, p.nodeId as string)),
      ),
    )) return [err('occurrence.topology.definitionReferenced', `node.replace: occurrence-local topology references node '${p.nodeId}'`)]
    // THE staleness guard: the plan was computed against this exact type.
    if (node.type !== p.from)
      return [err('replace.stale', `node.replace: node '${p.nodeId}' is '${node.type}', plan expected '${p.from}'`)]

    if (targetSchemaGuards !== undefined) {
      if (context.kind === 'initial') {
        if (context.schemaResolverFor === undefined)
          return [err('replace.schemaAuthorityUnavailable', 'node.replace: trusted schema authority is unavailable for a dynamic replacement target')]
        const resolve = context.schemaResolverFor(doc)
        for (const guard of targetSchemaGuards) {
          const schema = resolve(guard.type)
          if (schema === undefined || fnv1a64(canonicalJson(schema)) !== guard.schemaHash)
            return [err('replace.stale', `node.replace: target schema for '${guard.nodeId}' changed since planning`)]
        }
      }
    }

    const migrationArchive = p.migrationArchive === undefined
      ? undefined
      : p.migrationArchive as JsonObject & {
          historicalInputs: string[]
          node: JsonObject
          links: JsonObject
          nets: JsonObject
          view: JsonObject | null
          boundary: JsonObject | null
        }
    if (migrationArchive !== undefined) {
      const currentLinks = Object.fromEntries(Object.keys(migrationArchive.links).map((id) => [id, def.links[id] ?? null]))
      const droppedNets = new Set(p.dropNets)
      const currentNets = Object.fromEntries(Object.keys(migrationArchive.nets).map((id) => [
        id,
        droppedNets.has(id)
          ? (def.nets[id] as unknown as Json | undefined) ?? null
          : migrationNetProjection(def.nets[id] as unknown as Json | undefined, nodeId),
      ]))
      const archivedNets = Object.fromEntries(Object.entries(migrationArchive.nets).map(([id, net]) => [
        id,
        droppedNets.has(id) ? net : migrationNetProjection(net, nodeId),
      ]))
      const historicalInputs = new Set(migrationArchive.historicalInputs)
      const newHistoricalLink = Object.values(def.links).some((link) =>
        !Object.hasOwn(migrationArchive.links, link.id) &&
        ((isPortEndpoint(link.to) && link.to.node === p.nodeId && historicalInputs.has(link.to.port)) ||
          (isWidgetTapRef(link.from) && link.from.node === p.nodeId && historicalInputs.has(link.from.tap))),
      )
      const newHistoricalNet = Object.values(def.nets).some((net) =>
        !Object.hasOwn(migrationArchive.nets, net.id) &&
        net.sinks.some((sink) => sink.node === p.nodeId && historicalInputs.has(sink.port)),
      )
      if (
        newHistoricalLink ||
        newHistoricalNet ||
        canonicalJson(node as unknown as Json) !== canonicalJson(migrationArchive.node) ||
        canonicalJson(currentLinks as unknown as Json) !== canonicalJson(migrationArchive.links) ||
        canonicalJson(currentNets as unknown as Json) !== canonicalJson(archivedNets as unknown as Json) ||
        canonicalJson((doc.view.graphs[p.graphId]?.nodes[p.nodeId] ?? null) as unknown as Json) !== canonicalJson(migrationArchive.view)
      ) return [err('replace.stale', `node.replace: archived migration state for '${p.nodeId}' changed since planning`)]
    }

    for (const [input, expected] of Object.entries(p.sourceCountGuards ?? {})) {
      const current = node.values[input]
      const connected = Object.values(def.links).some((link) =>
        isPortEndpoint(link.to) && link.to.node === p.nodeId && link.to.port === input,
      ) || Object.values(def.nets).some((net) => net.sinks.some((sink) =>
        isPortEndpoint(sink) && sink.node === p.nodeId && sink.port === input,
      ))
      if (current === undefined || canonicalJson(current) !== canonicalJson(expected) || connected)
        return [err('replace.stale', `node.replace: source count '${p.nodeId}.${input}' changed since planning`)]
    }

    const createdNodes = (p.createdNodes ?? []) as ReadonlyArray<{
      nodeId: string
      localId: string
      type: string
      values: JsonObject
      dynamic?: JsonObject
      controllers?: JsonObject
    }>
    const localIds = new Set<string>()
    const helperIds = new Set<string>()
    const graphHasId = (id: string): boolean =>
      def.nodes[id] !== undefined ||
      def.links[id] !== undefined ||
      def.nets[id] !== undefined ||
      def.reroutes[id] !== undefined ||
      def.valueSources?.[id] !== undefined ||
      def.selectors?.[id] !== undefined
    for (const created of createdNodes) {
      if (localIds.has(created.localId) || helperIds.has(created.nodeId))
        return [err('params.invalid', `node.replace: duplicate helper '${created.localId}'`)]
      localIds.add(created.localId)
      helperIds.add(created.nodeId)
      if (graphHasId(created.nodeId))
        return [err('replace.stale', `node.replace: helper node id '${created.nodeId}' is no longer available`)]
      if (created.nodeId !== `${p.nodeId}:${created.localId}`)
        return [err('params.invalid', `node.replace: helper node id '${created.nodeId}' is not derived from its local id`)]
    }
    const allowedNodes = new Set([p.nodeId, ...helperIds])
    for (const rewire of [
      ...p.inputRewires,
      ...p.outputRewires,
      ...p.netSourceRewires,
      ...(p.tapRewires ?? []),
      ...(p.viewRewires ?? []),
    ]) {
      if (rewire.node !== undefined && !allowedNodes.has(rewire.node))
        return [err('params.invalid', `node.replace: rewire destination '${rewire.node}' is not the primary or a planned helper`)]
    }
    for (const rewire of p.tapRewires ?? []) {
      if (!(p.tapGuards ?? []).some((guard) => guard.link === rewire.link))
        return [err('params.invalid', `node.replace: widget tap rewire '${rewire.link}' has no source guard`)]
    }
    const hasNetSinkEdits = p.netSinkEdits !== undefined
    const netSinkEdits = (p.netSinkEdits ?? []) as unknown as ReadonlyArray<{ net: string; from: PortRef; to?: PortRef }>
    const editsByNet = new Map<string, Array<{ net: string; from: PortRef; to?: PortRef }>>()
    for (const edit of netSinkEdits) {
      if (edit.from.node !== p.nodeId || (edit.to !== undefined && !allowedNodes.has(edit.to.node)))
        return [err('params.invalid', 'node.replace: net sink edit is not owned by the primary or a planned helper')]
      const update = (p.netSinks as unknown as ReadonlyArray<{ net: string }>).some(({ net }) => net === edit.net)
      if (!update) return [err('params.invalid', `node.replace: net sink edit references unplanned net '${edit.net}'`)]
      const edits = editsByNet.get(edit.net) ?? []
      edits.push(edit)
      editsByNet.set(edit.net, edits)
    }
    for (const update of p.netSinks as unknown as ReadonlyArray<{ net: string; sinks: PortRef[] }>) {
      if (!hasNetSinkEdits) continue
      const edits = editsByNet.get(update.net) ?? []
      const sources = def.nets[update.net]?.sinks.filter((sink) => sink.node === p.nodeId) ?? []
      if (sources.length !== edits.length || sources.some((sink, index) => !samePortRef(sink, edits[index]!.from)))
        return [err('replace.stale', `node.replace: net '${update.net}' no longer has the planned sinks of '${p.nodeId}'`)]
      const expected = update.sinks.filter((sink) => allowedNodes.has(sink.node))
      const actual = edits.filter((edit) => edit.to !== undefined).map((edit) => edit.to!)
      if (actual.length !== expected.length || actual.some((sink, index) => !samePortRef(sink, expected[index]!)))
        return [err('params.invalid', `node.replace: net sink edits disagree with planned net '${update.net}'`)]
    }
    const internalLinks = (p.links ?? []) as ReadonlyArray<{
      from: JsonObject & { node: string; port: string }
      to: JsonObject & { node: string; port: string }
    }>
    for (const internal of internalLinks) {
      if (!allowedNodes.has(internal.from.node) || !allowedNodes.has(internal.to.node))
        return [err('params.invalid', 'node.replace: internal link endpoint is not the primary or a planned helper')]
    }

    // Validate every referenced link/net still exists AND still touches this
    // node on the expected side - anything else means the plan is stale.
    // Rewires address memberless endpoints; setting `port` while a legacy
    // member ancestry remains would corrupt the endpoint.
    for (const r of p.inputRewires) {
      const link = def.links[r.link]
      if (!link || !isPortEndpoint(link.to) || link.to.node !== p.nodeId || link.to.members !== undefined)
        return [err('replace.stale', `node.replace: link '${r.link}' no longer feeds a memberless input of node '${p.nodeId}'`)]
    }
    for (const r of p.outputRewires) {
      const link = def.links[r.link]
      if (
        !link ||
        !isPortEndpoint(link.from) ||
        link.from.node !== p.nodeId ||
        (r.fromPort === undefined
          ? link.from.members !== undefined
          : link.from.port !== r.fromPort ||
            (r.fromMembers === undefined
              ? link.from.members !== undefined
              : !sameMembers(link.from.members, r.fromMembers)))
      )
        return [err('replace.stale', `node.replace: link '${r.link}' no longer leaves the planned output of node '${p.nodeId}'`)]
    }
    for (const r of p.tapRewires ?? []) {
      const link = def.links[r.link]
      if (
        !link ||
        !isExactWidgetTapRef(link.from) ||
        link.from.node !== p.nodeId ||
        (r.fromTap !== undefined && link.from.tap !== r.fromTap)
      ) return [err('replace.stale', `node.replace: link '${r.link}' no longer leaves the planned widget tap of node '${p.nodeId}'`)]
    }
    for (const guard of p.tapGuards ?? []) {
      const link = def.links[guard.link]
      if (!link || !isExactWidgetTapRef(link.from) || link.from.node !== p.nodeId || link.from.tap !== guard.tap)
        return [err('replace.stale', `node.replace: link '${guard.link}' no longer leaves widget tap '${p.nodeId}.${guard.tap}'`)]
    }
    for (const id of p.dropLinks) {
      if (!def.links[id]) return [err('replace.stale', `node.replace: link '${id}' is gone`)]
    }
    for (const r of p.netSourceRewires) {
      const net = def.nets[r.net]
      if (
        !net ||
        net.source.node !== p.nodeId ||
        (r.fromPort === undefined
          ? net.source.members !== undefined
          : net.source.port !== r.fromPort ||
            (r.fromMembers === undefined
              ? net.source.members !== undefined
              : !sameMembers(net.source.members, r.fromMembers)))
      )
        return [err('replace.stale', `node.replace: net '${r.net}' is no longer sourced from the planned output of '${p.nodeId}'`)]
    }
    const netSinkUpdates = p.netSinks as unknown as ReadonlyArray<{
      net: string
      sinks: PortRef[]
    }>
    const ownedSinkNodes = p.createdNodes === undefined
      ? undefined
      : new Set([nodeId, ...createdNodes.map((created) => created.nodeId)])
    for (const s of netSinkUpdates) {
      if (!def.nets[s.net]) return [err('replace.stale', `node.replace: net '${s.net}' is gone`)]
    }
    for (const id of p.dropNets) {
      if (!def.nets[id]) return [err('replace.stale', `node.replace: net '${id}' is gone`)]
    }
    // Boundary rewires: the addressed binding must still be a static 'port'
    // binding of THIS node AND still hold the exact port the plan was
    // computed from - anything else means the boundary changed since
    // planning and the plan is stale.
    const boundaryRewires = (p.boundaryRewires ?? []) as ReadonlyArray<{
      item: string
      side: 'input' | 'output'
      fromPort: string
      port: string
      alsoIndex?: number
    }>
    for (const r of boundaryRewires) {
      const items = r.side === 'input' ? def.boundary?.inputs : def.boundary?.outputs
      const item = items?.find((i) => i.id === r.item)
      const b = r.alsoIndex === undefined ? item?.binds : item?.alsoBinds?.[r.alsoIndex]
      if (!b || b.kind !== 'port' || b.node !== p.nodeId || b.members !== undefined)
        return [err('replace.stale', `node.replace: boundary ${r.side} '${r.item}' no longer binds a static port of '${p.nodeId}'`)]
      if (b.port !== r.fromPort)
        return [err('replace.stale', `node.replace: boundary ${r.side} '${r.item}' now binds '${p.nodeId}.${b.port}', not the planned '${p.nodeId}.${r.fromPort}'`)]
    }
    // Boundary guard: the CURRENT boundary must hold exactly the bindings of
    // this node the plan was computed from - including identity-mapped
    // bindings no rewire touches and the promoted flags. A binding added,
    // retargeted, or (un)promoted since planning invalidates the plan even
    // when every listed rewire still checks out above.
    {
      const guard = (p.boundaryGuard ?? []) as ReadonlyArray<{ item: string; side: 'input' | 'output'; port: string; alsoIndex?: number; promoted?: boolean }>
      // JSON tuple encoding: injective for ANY component strings (raw
      // separator chars in an id/port can never collide two entries).
      const guardKey = (g: { item: string; side: string; port: string; alsoIndex?: number; promoted?: boolean }): string =>
        JSON.stringify([g.side, g.item, g.alsoIndex ?? null, g.port, g.promoted === true])
      const stale = err('replace.stale', `node.replace: the subgraph boundary bindings of '${p.nodeId}' changed since planning`)
      const current: string[] = []
      for (const item of def.boundary?.inputs ?? []) {
        if (item.binds.node === p.nodeId) {
          if (item.binds.kind !== 'port' || item.binds.members !== undefined) return [stale]
          current.push(guardKey({ item: item.id, side: 'input', port: item.binds.port, ...(item.promoted === true ? { promoted: true } : {}) }))
        }
        for (const [i, a] of (item.alsoBinds ?? []).entries()) {
          if (a.node !== p.nodeId) continue
          if (a.kind !== 'port' || a.members !== undefined) return [stale]
          current.push(guardKey({ item: item.id, side: 'input', port: a.port, alsoIndex: i }))
        }
      }
      for (const item of def.boundary?.outputs ?? []) {
        if (item.binds.node === p.nodeId) {
          if (item.binds.kind !== 'port' || item.binds.members !== undefined) return [stale]
          current.push(guardKey({ item: item.id, side: 'output', port: item.binds.port }))
        }
      }
      // Sorted element-wise comparison keeps multiplicity: two snapshots
      // with the same key SET but different counts are still a mismatch.
      const expected = guard.map(guardKey).sort()
      const actual = current.sort()
      if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) return [stale]
    }

    const graphId = p.graphId

    // -- Created helpers -----------------------------------------------------
    // Geometry is intentionally executor-owned: helpers form a stable column
    // 320px right of the primary, spaced 180px in declaration order.
    const primaryPosition = doc.view.graphs[graphId]?.nodes[p.nodeId]?.position ?? { x: 0, y: 0 }
    if (createdNodes.length > 0 && doc.view.graphs[graphId] === undefined)
      tx.set(['view', 'graphs', graphId], { nodes: {} })
    createdNodes.forEach((created, index) => {
      tx.set(['graphs', graphId, 'nodes', created.nodeId], {
        id: created.nodeId,
        type: created.type,
        values: created.values,
        ...(created.dynamic !== undefined ? { dynamic: created.dynamic } : {}),
        ...(created.controllers !== undefined ? { controllers: created.controllers } : {}),
      })
      tx.set(['view', 'graphs', graphId, 'nodes', created.nodeId], {
        position: { x: primaryPosition.x + 320, y: primaryPosition.y + index * 180 },
      })
    })

    // -- The node itself ------------------------------------------------------
    tx.set(['graphs', graphId, 'nodes', p.nodeId, 'type'], p.to)
    tx.set(['graphs', graphId, 'nodes', p.nodeId, 'values'], p.values)
    if (p.dynamic !== undefined) {
      tx.set(['graphs', graphId, 'nodes', p.nodeId, 'dynamic'], p.dynamic)
    } else if (node.dynamic !== undefined) {
      tx.remove(['graphs', graphId, 'nodes', p.nodeId, 'dynamic'])
    }
    if (p.controllers !== undefined) {
      tx.set(['graphs', graphId, 'nodes', p.nodeId, 'controllers'], p.controllers)
    } else if (node.controllers !== undefined) {
      tx.remove(['graphs', graphId, 'nodes', p.nodeId, 'controllers'])
    }
    if (migrationArchive !== undefined) {
      tx.set(['graphs', graphId, 'nodes', p.nodeId, 'ext'], {
        ...(node.ext ?? {}),
        [REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY]: migrationArchive,
      })
    }

    // -- Connections ----------------------------------------------------------
    for (const r of p.inputRewires) {
      if (r.node !== undefined) tx.set(['graphs', graphId, 'links', r.link, 'to', 'node'], r.node)
      tx.set(['graphs', graphId, 'links', r.link, 'to', 'port'], r.port)
    }
    for (const r of p.outputRewires) {
      const currentFrom = def.links[r.link]!.from
      if (r.node !== undefined) tx.set(['graphs', graphId, 'links', r.link, 'from', 'node'], r.node)
      tx.set(['graphs', graphId, 'links', r.link, 'from', 'port'], r.port)
      if (r.members !== undefined) tx.set(['graphs', graphId, 'links', r.link, 'from', 'members'], r.members)
      else if (isPortEndpoint(currentFrom) && currentFrom.members !== undefined)
        tx.remove(['graphs', graphId, 'links', r.link, 'from', 'members'])
    }
    for (const r of p.tapRewires ?? []) {
      if (r.node !== undefined) tx.set(['graphs', graphId, 'links', r.link, 'from', 'node'], r.node)
      tx.set(['graphs', graphId, 'links', r.link, 'from', 'tap'], r.tap)
    }
    for (const id of new Set(p.dropLinks)) {
      removeProjectedLinkSuppressions(graphId, id, tx)
      tx.remove(['graphs', graphId, 'links', id])
    }
    for (const r of p.netSourceRewires) {
      if (r.node !== undefined) tx.set(['graphs', graphId, 'nets', r.net, 'source', 'node'], r.node)
      tx.set(['graphs', graphId, 'nets', r.net, 'source', 'port'], r.port)
      if (r.members !== undefined) tx.set(['graphs', graphId, 'nets', r.net, 'source', 'members'], r.members)
      else if (def.nets[r.net]!.source.members !== undefined)
        tx.remove(['graphs', graphId, 'nets', r.net, 'source', 'members'])
    }
    for (const s of netSinkUpdates) {
      const before = tx.current.graphs[graphId]!.nets[s.net]!.sinks
      let sinks = [...s.sinks]
      if (ownedSinkNodes !== undefined) {
        const edits = editsByNet.get(s.net) ?? []
        if (hasNetSinkEdits) {
          sinks = [...before]
          for (const edit of edits) {
            const index = sinks.findIndex((sink) => samePortRef(sink, edit.from))
            if (edit.to === undefined) sinks.splice(index, 1)
            else sinks[index] = edit.to
          }
        } else {
          const planned = s.sinks.filter((sink) => ownedSinkNodes.has(sink.node))
          let plannedIndex = 0
          sinks = before.flatMap((sink) => {
            if (!ownedSinkNodes.has(sink.node)) return [sink]
            const replacement = planned[plannedIndex++]
            return replacement === undefined ? [] : [replacement]
          })
          sinks.push(...planned.slice(plannedIndex))
        }
      }
      const removed = before.filter((sink) => !sinks.some((kept) => samePortRef(sink, kept as unknown as PortRef)))
      if (removed.length > 0) {
        removeNetDeliverySuppressions(graphId, s.net, removed, tx)
        removeAuthoredNetViews(tx, (position) =>
          position.graphId === graphId && position.netId === s.net && position.role === 'sink' &&
          removed.some((sink) => samePortRef(position.to, sink)),
        )
      }
      tx.set(['graphs', graphId, 'nets', s.net, 'sinks'], sinks as unknown as Json)
    }
    for (const id of new Set(p.dropNets)) {
      removeNetDeliverySuppressions(graphId, id, undefined, tx)
      tx.remove(['graphs', graphId, 'nets', id])
      removeAuthoredNetViews(tx, (position) =>
        position.graphId === graphId && position.netId === id,
      )
      pruneNetDisplayState(graphId, id, tx)
    }

    if ((p.inputViewRewires?.length ?? 0) > 0 || (p.dropInputViews?.length ?? 0) > 0) {
      const current = doc.view.graphs[graphId]?.nodes[p.nodeId]?.views ?? {}
      const next = { ...current }
      const moved = (p.inputViewRewires ?? []).map((rewire) => ({
        input: rewire.input,
        view: current[rewire.fromInput],
      }))
      for (const input of [...(p.inputViewRewires ?? []).map((rewire) => rewire.fromInput), ...(p.dropInputViews ?? [])]) {
        delete next[input]
      }
      for (const entry of moved) {
        if (entry.view !== undefined) next[entry.input] = entry.view
      }
      if (Object.keys(next).length > 0) tx.set(['view', 'graphs', graphId, 'nodes', p.nodeId, 'views'], next)
      else tx.remove(['view', 'graphs', graphId, 'nodes', p.nodeId, 'views'])
    }

    if (internalLinks.length > 0) {
      const allocator = graphAllocator(tx, graphId, def)
      for (const internal of internalLinks) {
        const id = allocator.mint('l')
        tx.set(['graphs', graphId, 'links', id], { id, from: internal.from, to: internal.to })
      }
      allocator.commit()
    }

    for (const r of p.viewRewires ?? []) {
      const representation = tx.current.view.graphs[graphId]?.nodes[p.nodeId]?.views?.[r.from]
      if (representation === undefined) continue
      const targetNode: string = r.node ?? p.nodeId
      const targetViews = tx.current.view.graphs[graphId]?.nodes[targetNode]?.views ?? {}
      tx.set(['view', 'graphs', graphId, 'nodes', targetNode, 'views'], {
        ...targetViews,
        [r.to]: representation,
      })
      if (targetNode !== p.nodeId || r.to !== r.from)
        tx.remove(['view', 'graphs', graphId, 'nodes', p.nodeId, 'views', r.from])
    }

    // -- Boundary bindings ------------------------------------------------------
    // Whole-array replacement per side (like net sinks): the transaction
    // records the old array, so undo restores every binding at once.
    for (const side of ['input', 'output'] as const) {
      const rewires = boundaryRewires.filter((r) => r.side === side)
      if (rewires.length === 0) continue
      const key = side === 'input' ? 'inputs' : 'outputs'
      const items = (side === 'input' ? def.boundary?.inputs : def.boundary?.outputs) ?? []
      const next = items.map((item) => {
        const mine = rewires.filter((r) => r.item === item.id)
        if (mine.length === 0) return item
        let binds = item.binds
        const alsoBinds = item.alsoBinds !== undefined ? [...item.alsoBinds] : undefined
        for (const r of mine) {
          if (r.alsoIndex === undefined && binds.kind !== 'widgetTap') binds = { ...binds, port: asPortId(r.port) }
          else if (r.alsoIndex !== undefined && alsoBinds?.[r.alsoIndex] !== undefined) {
            const current = alsoBinds[r.alsoIndex]!
            if (current.kind !== 'widgetTap') alsoBinds[r.alsoIndex] = { ...current, port: asPortId(r.port) }
          }
        }
        return { ...item, binds, ...(alsoBinds !== undefined ? { alsoBinds } : {}) }
      })
      tx.set(['graphs', graphId, 'boundary', key], next as unknown as Json)
    }

    return []
  },
}

const replaceComfyGroups: CommandDefinition = {
  id: 'import.replaceComfyGroups',
  run(doc, params, tx, context) {
    if (
      !isObj(params) ||
      typeof params.graphId !== 'string' ||
      !isObj(params.sourceGraph) ||
      !isObj(params.sourceView) ||
      !isObj(params.collapsedGraph) ||
      !isObj(params.collapsedView) ||
      !Array.isArray(params.plans) ||
      params.plans.length === 0 ||
      params.plans.length > 256 ||
      !params.plans.every((plan) =>
        isObj(plan) &&
        plan.graphId === params.graphId &&
        typeof plan.nodeId === 'string' &&
        typeof plan.from === 'string') ||
      !params.plans.some((plan) =>
        isObj(plan) &&
        typeof plan.from === 'string' &&
        plan.from.startsWith('comfy-group.'))
    ) return [err('params.invalid', 'import.replaceComfyGroups: malformed plan')]
    if (params.graphId !== doc.root) {
      return [err('params.invalid', 'import.replaceComfyGroups: only the imported root graph may change')]
    }
    const sourceGraph = doc.graphs[params.graphId]
    const sourceView = doc.view.graphs[params.graphId]
    if (
      sourceGraph === undefined ||
      sourceView === undefined ||
      canonicalJson(sourceGraph as unknown as Json) !== canonicalJson(params.sourceGraph) ||
      canonicalJson(sourceView as unknown as Json) !== canonicalJson(params.sourceView)
    ) return [err('replace.stale', 'import.replaceComfyGroups: imported source graph changed')]

    tx.set(['graphs', params.graphId], params.collapsedGraph)
    tx.set(['view', 'graphs', params.graphId], params.collapsedView)
    const diagnostics: Diagnostic[] = []
    for (const plan of params.plans) {
      const next = nodeReplace.run(
        tx.current,
        { plan } as unknown as Json,
        tx,
        context,
      )
      diagnostics.push(...next)
      if (next.some((item) => item.severity === 'error')) return diagnostics
    }
    return diagnostics
  },
}

export function comfyGroupReplacementInvocation(
  source: WorkflowDocument,
  collapsed: WorkflowDocument,
  plans: readonly NodeReplacePlan[],
): CommandInvocation | undefined {
  const graphId = source.root
  if (
    plans.length === 0 ||
    collapsed.root !== graphId ||
    source.graphs[graphId] === undefined ||
    source.view.graphs[graphId] === undefined ||
    collapsed.graphs[graphId] === undefined ||
    collapsed.view.graphs[graphId] === undefined
  ) return undefined
  return {
    command: 'import.replaceComfyGroups',
    params: {
      graphId,
      sourceGraph: source.graphs[graphId],
      sourceView: source.view.graphs[graphId],
      collapsedGraph: collapsed.graphs[graphId],
      collapsedView: collapsed.view.graphs[graphId],
      plans,
    } as unknown as Json,
  }
}

export const REPLACE_COMMANDS: readonly CommandDefinition[] = [nodeReplace, replaceComfyGroups]
