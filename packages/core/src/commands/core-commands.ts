/**
 * Core command set. Every UI edit goes through one of these; extensions
 * register additional commands through the same registry.
 *
 * Design rules:
 * - Params are plain JSON, validated structurally here (bad params reject
 *   with diagnostics, never throw).
 * - Deterministic: new ids come from the graph def's allocation cursors
 *   (nextOrdinal solo, actorCursors[actor] in shared sessions - see
 *   alloc.ts), never from randomness or time.
 * - Commands are schema-blind except where schema controls document shape.
 *   Other commands enforce STRUCTURAL rules (endpoints exist, one driver per
 *   input). Type compatibility is advisory UI/diagnostic territory
 *   (schema/compat.ts) so documents never become uneditable when dynamic
 *   types drift.
 * - Each command records the minimal patch set; cascades (removing a node
 *   removes its links/net references/view state) are part of the same
 *   transaction so undo restores everything atomically.
 */

import { canonicalJson, fnv1a64, sha256Hex } from '../compile/hash.js'
import { compositorRecipeFingerprint, copyCompositorRecipe, isCompositorRecipe } from '../compositor.js'
import { parseMaskPaintRecipe } from '../mask-paint-recipe.js'
import { diag, type Diagnostic, type DiagnosticRef } from '../diagnostics.js'
import { PREVIEW_MODES, regionContractShapeProblems, type BoundaryItem, type ControllerMode, type GraphDef, type LinkData, type NodeData, type NodeMode, type PreviewMode, type RegionContract, type WorkflowDocument } from '../format/document.js'
import { NET_VIEWS_EXT_KEY, removeNetViewPositions, updateNetViewPositions, type NetViewGeometry, type NetViewPosition } from '../format/net-views.js'
import { canonicalTypeIdOf, inputsOf, isImageAssetInput, outputCountInputsOf, outputsOf, type CountBoundOutputAutogrowSpec, type NodeSchema } from '../schema/model.js'
import { buildGraphConnectivity, DEFAULT_ELAB_BUDGET, elabInputsOf, elaborateInterface, valueKeyOf } from '../schema/elaborate.js'
import type { Json, JsonObject } from '../format/document.js'
import { groupAllocationFloor } from '../group-alloc.js'
import { asDynamicMemberId, asNodeId, asPortId, asSelectorId, isPortEndpoint, isRerouteRef, isSelectorRef, isValueSourceRef, isWidgetTapRef, sameEndpoint, samePortRef, type LinkEndpoint, type PortRef } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { allocateOne, graphAllocator } from './alloc.js'
import { buildRerouteIndex, rerouteDriverOf, wouldCreateRerouteCycle, wouldCreateSelectorCycle, wouldCreateTapCycle } from '../reroute.js'
import { createTransactionBuilder, executeCommand, type CommandDefinition, type CommandExecutionContext, type TransactionBuilder } from './contract.js'
import { BOUNDARY_COMMANDS } from './boundary-commands.js'
import { SUBGRAPH_COMMANDS } from './subgraph-commands.js'
import { DYNAMIC_COMMANDS } from './dynamic-commands.js'
import { REPLACE_COMMANDS } from './replace-commands.js'
import { CLIPBOARD_COMMANDS } from '../clipboard.js'
import { SURFACE_COMMANDS } from './surface-commands.js'
import { EXPOSED_COMMANDS } from './exposed-commands.js'
import { EXPOSED_PREVIEW_COMMANDS } from './exposed-preview-commands.js'
import { APP_LAYOUT_COMMANDS } from './app-layout-commands.js'
import { OCCURRENCE_LINK_COMMANDS } from './occurrence-link-commands.js'
import { effectiveOccurrenceTopology, effectiveTopologyDrivesPort, occurrenceBoundaryTargets, occurrenceEndpointReferencesDefinition } from '../compile/effective-topology.js'
import { pruneNetDisplayState, removeAuthoredNetViews, removeNetDeliverySuppressions, removeProjectedLinkSuppressions } from './occurrence-cleanup.js'
import { spliceDiff, transformSplice } from './text-splice.js'
import { normalizedComboOptions } from '../schema/combo-options.js'
import {
  IMAGE_BLEND_MODES,
  IMAGE_MASK_COMBINE_MODES,
  IMAGE_OPACITY_MAX,
  MAX_IMAGE_CANVAS_DIMENSION,
  MAX_IMAGE_LINEAR_COMPONENT,
  MAX_IMAGE_TRANSLATION,
} from '../image-document/model.js'

const err = (code: string, message: string, refs?: readonly DiagnosticRef[]): Diagnostic =>
  diag('error', 'command', code, message, refs === undefined ? undefined : { refs })

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const hasExactKeys = (value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}

const safeIntegerBetween = (value: Json | undefined, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max

const validImageTransform = (value: Json | undefined): boolean => {
  if (!isObj(value) || !hasExactKeys(value, ['a', 'b', 'c', 'd', 'tx', 'ty'], ['components'])) return false
  if (!['a', 'b', 'c', 'd'].every((key) => safeIntegerBetween(value[key], -MAX_IMAGE_LINEAR_COMPONENT, MAX_IMAGE_LINEAR_COMPONENT)) ||
    !['tx', 'ty'].every((key) => safeIntegerBetween(value[key], -MAX_IMAGE_TRANSLATION, MAX_IMAGE_TRANSLATION))) return false
  if (value.components === undefined) return true
  const components = value.components
  if (!isObj(components) || !hasExactKeys(components, [
    'x', 'y', 'width', 'height', 'rotation', 'flipHorizontal', 'flipVertical', 'sourceWidth', 'sourceHeight',
  ])) return false
  if (!['x', 'y', 'rotation'].every((key) => typeof components[key] === 'number' && Number.isFinite(components[key])) ||
    !['width', 'height', 'sourceWidth', 'sourceHeight'].every((key) =>
      typeof components[key] === 'number' && Number.isFinite(components[key]) && Number(components[key]) > 0 &&
      Number(components[key]) <= MAX_IMAGE_CANVAS_DIMENSION)) return false
  return typeof components.flipHorizontal === 'boolean' && typeof components.flipVertical === 'boolean'
}

const validImageRecipeChanges = (operation: 'canvas' | 'layer' | 'mask', changes: Json | undefined): boolean => {
  if (!isObj(changes) || Object.keys(changes).length === 0) return false
  const validators: Record<string, (value: Json | undefined) => boolean> = operation === 'canvas' ? {
    width: (value) => safeIntegerBetween(value, 1, MAX_IMAGE_CANVAS_DIMENSION),
    height: (value) => safeIntegerBetween(value, 1, MAX_IMAGE_CANVAS_DIMENSION),
    compositing: (value) => value === 'premultiplied-alpha' || value === 'linear-premultiplied-alpha',
  } : operation === 'layer' ? {
    name: (value) => typeof value === 'string',
    visible: (value) => typeof value === 'boolean',
    opacity: (value) => safeIntegerBetween(value, 0, IMAGE_OPACITY_MAX),
    transform: validImageTransform,
    blendMode: (value) => typeof value === 'string' && (IMAGE_BLEND_MODES as readonly string[]).includes(value),
    clipping: (value) => value === 'none' || value === 'clip-to-previous',
    z_index: (value) => Number.isSafeInteger(value),
    isolation: (value) => value === 'isolated' || value === 'pass-through',
  } : {
    enabled: (value) => typeof value === 'boolean',
    invert: (value) => typeof value === 'boolean',
    opacity: (value) => safeIntegerBetween(value, 0, IMAGE_OPACITY_MAX),
    transform: validImageTransform,
    combineMode: (value) => typeof value === 'string' && (IMAGE_MASK_COMBINE_MODES as readonly string[]).includes(value),
    channel: (value) => value === 'alpha' || value === 'luminance',
  }
  return Object.entries(changes).every(([key, value]) => validators[key]?.(value) === true)
}

const validImageRecipeRow = (row: Json): boolean => {
  if (!isObj(row) || typeof row.op !== 'string') return false
  if (row.op === 'canvas') return hasExactKeys(row, ['op', 'changes']) && validImageRecipeChanges('canvas', row.changes)
  if (row.op === 'layer' || row.op === 'mask') {
    return hasExactKeys(row, ['op', 'id', 'changes']) && typeof row.id === 'string' && row.id.length > 0 &&
      validImageRecipeChanges(row.op, row.changes)
  }
  if (row.op === 'reorder') {
    return hasExactKeys(row, ['op', 'ids'], ['parent']) &&
      (row.parent === undefined || (typeof row.parent === 'string' && row.parent.length > 0)) &&
      Array.isArray(row.ids) && row.ids.length > 0 && row.ids.every((id) => typeof id === 'string' && id.length > 0) &&
      new Set(row.ids).size === row.ids.length
  }
  return false
}

const commandSchemaOf = (
  doc: WorkflowDocument,
  nodeType: string,
  context: CommandExecutionContext,
  resolve?: (type: string) => NodeSchema | undefined,
): NodeSchema | undefined => context.kind === 'initial'
  ? context.schemaResolverFor?.(doc)(nodeType) ?? resolve?.(nodeType)
  : resolve?.(nodeType)

export interface OutputCountSchemaPlan {
  readonly nodeType: string
  readonly schemaSnapshot: NodeSchema
  readonly schemaPlanDigest: string
}

const outputCountSchemaPlanDigest = (nodeType: string, schemaSnapshot: NodeSchema): string =>
  fnv1a64(canonicalJson({ nodeType, schemaSnapshot }))

/** Pin the validated schema needed to replay a count edit without live schema authority. */
export function planOutputCountSchema(nodeType: string, schemaSnapshot: NodeSchema): OutputCountSchemaPlan {
  return {
    nodeType,
    schemaSnapshot,
    schemaPlanDigest: outputCountSchemaPlanDigest(nodeType, schemaSnapshot),
  }
}

const outputCountSchemaPlanFrom = (value: Json | undefined): OutputCountSchemaPlan | undefined => {
  if (!isObj(value) || Object.keys(value).length !== 3 ||
      typeof value.nodeType !== 'string' || !isObj(value.schemaSnapshot) ||
      typeof value.schemaSnapshot.type !== 'string' || !Array.isArray(value.schemaSnapshot.items) ||
      typeof value.schemaPlanDigest !== 'string') return undefined
  const schemaSnapshot = value.schemaSnapshot as unknown as NodeSchema
  if (outputCountSchemaPlanDigest(value.nodeType, schemaSnapshot) !== value.schemaPlanDigest) return undefined
  return {
    nodeType: value.nodeType,
    schemaSnapshot,
    schemaPlanDigest: value.schemaPlanDigest,
  }
}

const isCompleteAssetRef = (value: Json | undefined): value is JsonObject & {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
} => {
  if (!isObj(value) || Object.keys(value).length !== 5) return false
  return /^blake3:[0-9a-f]{64}$/.test(typeof value.digest === 'string' ? value.digest : '') &&
    typeof value.name === 'string' &&
    typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 &&
    typeof value.mediaType === 'string' &&
    typeof value.virtualPath === 'string'
}

// Finite only (CO2): NaN/Infinity are not JSON and would poison geometry.
const isVec2 = (v: Json | undefined): v is JsonObject & { x: number; y: number } =>
  isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y)

interface PortRefJson extends JsonObject {
  readonly node: string
  readonly port: string
}
const isPortRef = (v: Json | undefined): v is PortRefJson =>
  isObj(v) &&
  typeof v.node === 'string' &&
  typeof v.port === 'string' &&
  (v.members === undefined ||
    (Array.isArray(v.members) && v.members.length > 0 && v.members.every((m) => typeof m === 'string' && m.length > 0)))

interface RerouteRefJson extends JsonObject {
  readonly reroute: string
}
const isRerouteRefJson = (v: Json | undefined): v is RerouteRefJson =>
  isObj(v) && typeof v.reroute === 'string'

interface ValueSourceRefJson extends JsonObject {
  readonly valueSource: string
}
const isValueSourceRefJson = (v: Json | undefined): v is ValueSourceRefJson =>
  isObj(v) && typeof v.valueSource === 'string'

interface SelectorRefJson extends JsonObject {
  readonly selector: string
  readonly candidate?: string
}
interface WidgetTapRefJson extends JsonObject {
  readonly node: string
  readonly tap: string
}
const isWidgetTapRefJson = (v: Json | undefined): v is WidgetTapRefJson =>
  isObj(v) && typeof v.node === 'string' && typeof v.tap === 'string'
const isSelectorRefJson = (v: Json | undefined): v is SelectorRefJson =>
  isObj(v) &&
  typeof v.selector === 'string' &&
  (v.candidate === undefined || typeof v.candidate === 'string')

type EndpointJson = PortRefJson | RerouteRefJson | ValueSourceRefJson | SelectorRefJson | WidgetTapRefJson

/** A link endpoint in params: a PortRef, `{reroute}`, `{valueSource}`, or `{selector}` reference. */
const isEndpoint = (v: Json | undefined): v is EndpointJson =>
  isRerouteRefJson(v) || isValueSourceRefJson(v) || isSelectorRefJson(v) || isWidgetTapRefJson(v) || isPortRef(v)

const endpointRefs = (
  graphId: string,
  e: LinkEndpoint | EndpointJson,
  direction: 'input' | 'output',
): readonly DiagnosticRef[] => {
  if ('node' in e && 'tap' in e && typeof e.node === 'string' && typeof e.tap === 'string') {
    return [{ graphId, nodeId: e.node, portId: e.tap, valueKey: e.tap, direction: 'output' }]
  }
  if ('node' in e && 'port' in e && typeof e.node === 'string' && typeof e.port === 'string') {
    return [{ graphId, nodeId: e.node, portId: e.port, direction }]
  }
  return []
}

/** Validate an endpoint against the graph; returns an error diagnostic or undefined. */
function endpointError(
  def: GraphDef,
  graphId: string,
  e: EndpointJson,
  direction: 'input' | 'output',
  what: string,
): Diagnostic | undefined {
  if (isRerouteRefJson(e)) {
    if (!def.reroutes[e.reroute]) return err('reroute.missing', `${what}: unknown reroute '${e.reroute}'`)
    return undefined
  }
  if (isValueSourceRefJson(e)) {
    if (!def.valueSources?.[e.valueSource])
      return err('valueSource.missing', `${what}: unknown value source '${e.valueSource}'`)
    return undefined
  }
  if (isSelectorRefJson(e)) {
    const selector = def.selectors?.[e.selector]
    if (!selector) return err('selector.missing', `${what}: unknown selector '${e.selector}'`)
    if (e.candidate !== undefined && !selector.candidates.some((c) => c.id === e.candidate))
      return err('selector.candidateMissing', `${what}: selector '${e.selector}' has no candidate '${e.candidate}'`)
    return undefined
  }
  if (isWidgetTapRefJson(e)) {
    if (!def.nodes[e.node]) return err('node.missing', `${what}: unknown node '${e.node}'`, endpointRefs(graphId, e, 'output'))
    return undefined
  }
  if (!def.nodes[e.node]) return err('node.missing', `${what}: unknown node '${e.node}'`, endpointRefs(graphId, e, direction))
  return undefined
}

/** Normalize a params port ref to the document shape (drops stray fields). */
const toPortRef = (e: PortRefJson): PortRef => ({
  node: asNodeId(e.node),
  port: asPortId(e.port),
  ...(Array.isArray(e.members) && e.members.length > 0
    ? { members: e.members.map((m) => asDynamicMemberId(m as string)) }
    : {}),
})

/** Normalize a params endpoint to the document shape (drops stray fields). */
function toEndpoint(e: EndpointJson): LinkEndpoint {
  if (isRerouteRefJson(e)) return { reroute: e.reroute } as LinkEndpoint
  if (isValueSourceRefJson(e)) return { valueSource: e.valueSource } as LinkEndpoint
  if (isSelectorRefJson(e))
    return {
      selector: e.selector,
      ...(e.candidate !== undefined ? { candidate: e.candidate } : {}),
    } as LinkEndpoint
  if (isWidgetTapRefJson(e)) return { node: asNodeId(e.node), tap: asPortId(e.tap) }
  return toPortRef(e)
}

function graphOf(doc: WorkflowDocument, graphId: Json | undefined): GraphDef | undefined {
  return typeof graphId === 'string' ? doc.graphs[graphId] : undefined
}

function removeDefinitionLink(graphId: string, linkId: string, tx: TransactionBuilder): void {
  removeProjectedLinkSuppressions(graphId, linkId, tx)
  tx.remove(['graphs', graphId, 'links', linkId])
}

/** Ensure view.graphs[graphId] exists before writing under it. */
function ensureViewGraph(tx: TransactionBuilder, graphId: string): void {
  const view = tx.current.view.graphs[graphId]
  if (!view) tx.set(['view', 'graphs', graphId], { nodes: {} })
}

function regionFromJson(value: Json | undefined): RegionContract | undefined {
  if (!isObj(value) || regionContractShapeProblems(value).length > 0) return undefined
  const region = value as unknown as RegionContract
  return {
    kind: region.kind,
    ...(region.elementPorts !== undefined ? { elementPorts: [...region.elementPorts] } : {}),
    ...(region.statePorts !== undefined ? { statePorts: [...region.statePorts] } : {}),
    ...(region.outputRoles !== undefined ? { outputRoles: structuredClone(region.outputRoles) } : {}),
    ...(region.continueOutput !== undefined ? { continueOutput: region.continueOutput } : {}),
    ...(region.binding !== undefined ? { binding: region.binding } : {}),
    ...(region.maxIterations !== undefined ? { maxIterations: region.maxIterations } : {}),
  }
}

function regionNode(doc: WorkflowDocument, params: JsonObject, command: string): { graphId: string; nodeId: string; region: RegionContract } | readonly Diagnostic[] {
  const def = graphOf(doc, params.graphId)
  if (!def) return [err('graph.missing', `${command}: unknown graph '${String(params.graphId)}'`)]
  if (typeof params.nodeId !== 'string') return [err('params.invalid', `${command}: nodeId must be a string`)]
  const node = def.nodes[params.nodeId]
  if (!node) return [err('node.missing', `${command}: unknown node '${params.nodeId}'`)]
  if (!node.region) return [err('region.missing', `${command}: node '${params.nodeId}' is not a region occurrence`)]
  return { graphId: params.graphId as string, nodeId: params.nodeId, region: node.region }
}

// ---------------------------------------------------------------------------
// node.add {graphId, type, position, values?, dynamic?, title?, region?, virtual?}
// ---------------------------------------------------------------------------

const nodeAdd: CommandDefinition = {
  id: 'node.add',
  run(doc, params, tx) {
    if (!isObj(params)) return [err('params.invalid', 'node.add: params must be an object')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.add: unknown graph '${String(params.graphId)}'`)]
    if (typeof params.type !== 'string' || params.type.length === 0)
      return [err('params.invalid', 'node.add: type must be a non-empty string')]
    if (!isVec2(params.position)) return [err('params.invalid', 'node.add: position must be {x,y}')]
    if (params.type.startsWith('#') && !doc.graphs[params.type.slice(1)])
      return [err('subgraph.missing', `node.add: unknown subgraph definition '${params.type}'`)]
    const region = params.region === undefined ? undefined : regionFromJson(params.region)
    if (params.region !== undefined && region === undefined)
      return [err('params.invalid', 'node.add: region must be a structurally valid region contract')]

    const graphId = params.graphId as string
    const id = allocateOne(tx, graphId, def, 'n')
    tx.set(['graphs', graphId, 'nodes', id], {
      id,
      type: params.type,
      values: isObj(params.values) ? params.values : {},
      ...(isObj(params.dynamic) && Object.keys(params.dynamic).length > 0 ? { dynamic: params.dynamic } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(typeof params.title === 'string' ? { title: params.title } : {}),
      ...(params.virtual === true ? { virtual: true } : {}),
    } as unknown as Json)
    ensureViewGraph(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'nodes', id], {
      position: { x: params.position.x, y: params.position.y },
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// region occurrence contract edits
// ---------------------------------------------------------------------------

const regionSetPortRole: CommandDefinition = {
  id: 'region.setPortRole',
  run(doc, params, tx) {
    if (!isObj(params) || params.side !== 'input' || typeof params.portId !== 'string' || params.portId.length === 0)
      return [err('params.invalid', "region.setPortRole: params must be {graphId, nodeId, side:'input', portId, role}")]
    const found = regionNode(doc, params, 'region.setPortRole')
    if (Array.isArray(found)) return found
    const { graphId, nodeId, region } = found as { graphId: string; nodeId: string; region: RegionContract }
    if (params.role !== 'element' && params.role !== 'state' && params.role !== 'broadcast')
      return [err('params.invalid', "region.setPortRole: input role must be 'element', 'state', or 'broadcast'")]
    const elements = (region.elementPorts ?? []).filter((id) => id !== params.portId)
    const states = (region.statePorts ?? []).filter((id) => id !== params.portId)
    if (params.role === 'element') elements.push(params.portId)
    if (params.role === 'state') states.push(params.portId)
    const outputRoles = { ...(region.outputRoles ?? {}) }
    if (params.role !== 'state') {
      for (const [outputId, role] of Object.entries(outputRoles)) {
        if (role.kind === 'state' && role.statePort === params.portId) delete outputRoles[outputId]
      }
    }
    const next = {
      ...region,
      ...(elements.length > 0 ? { elementPorts: elements } : {}),
      ...(states.length > 0 ? { statePorts: states } : {}),
      ...(Object.keys(outputRoles).length > 0 ? { outputRoles } : {}),
    } as Record<string, unknown>
    if (elements.length === 0) delete next.elementPorts
    if (states.length === 0) delete next.statePorts
    if (Object.keys(outputRoles).length === 0) delete next.outputRoles
    tx.set(['graphs', graphId, 'nodes', nodeId, 'region'], next as Json)
    return []
  },
}

const regionSetOutputRole: CommandDefinition = {
  id: 'region.setOutputRole',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.outputId !== 'string' || params.outputId.length === 0 ||
        (params.role !== 'gather' && params.role !== 'compact' && params.role !== 'state' && params.role !== 'flatten')) {
      return [err('params.invalid', "region.setOutputRole: params must be {graphId, nodeId, outputId, role:'gather'|'compact'|'state'|'flatten', statePort?}")]
    }
    if (params.role === 'state' && (typeof params.statePort !== 'string' || params.statePort.length === 0)) {
      return [err('params.invalid', 'region.setOutputRole: state role requires a non-empty statePort')]
    }
    if (params.role !== 'state' && params.statePort !== undefined) {
      return [err('params.invalid', `region.setOutputRole: ${params.role} role does not accept statePort`)]
    }
    const found = regionNode(doc, params, 'region.setOutputRole')
    if (Array.isArray(found)) return found
    const { graphId, nodeId, region } = found as { graphId: string; nodeId: string; region: RegionContract }
    let outputRoles = { ...(region.outputRoles ?? {}) }
    delete outputRoles[params.outputId]
    if (params.role === 'state') {
      for (const [outputId, role] of Object.entries(outputRoles)) {
        if (role.kind === 'state' && role.statePort === params.statePort) delete outputRoles[outputId]
      }
      outputRoles = { ...outputRoles, [params.outputId]: { kind: 'state', statePort: params.statePort as string } }
    } else if (params.role === 'compact' || params.role === 'flatten') {
      outputRoles = { ...outputRoles, [params.outputId]: { kind: params.role } }
    }
    const next = { ...region } as Record<string, unknown>
    if (region.continueOutput === params.outputId) delete next.continueOutput
    if (Object.keys(outputRoles).length > 0) next.outputRoles = outputRoles
    else delete next.outputRoles
    tx.set(['graphs', graphId, 'nodes', nodeId, 'region'], next as Json)
    return []
  },
}

const regionSetContinueOutput: CommandDefinition = {
  id: 'region.setContinueOutput',
  run(doc, params, tx) {
    if (!isObj(params) || (params.outputId !== undefined && (typeof params.outputId !== 'string' || params.outputId.length === 0))) {
      return [err('params.invalid', 'region.setContinueOutput: params must be {graphId, nodeId, outputId?}')]
    }
    const found = regionNode(doc, params, 'region.setContinueOutput')
    if (Array.isArray(found)) return found
    const { graphId, nodeId, region } = found as { graphId: string; nodeId: string; region: RegionContract }
    const outputRoles = { ...(region.outputRoles ?? {}) }
    const next = { ...region } as Record<string, unknown>
    if (params.outputId === undefined) delete next.continueOutput
    else {
      delete outputRoles[params.outputId]
      next.continueOutput = params.outputId
    }
    if (Object.keys(outputRoles).length > 0) next.outputRoles = outputRoles
    else delete next.outputRoles
    tx.set(['graphs', graphId, 'nodes', nodeId, 'region'], next as Json)
    return []
  },
}

const regionSetBinding: CommandDefinition = {
  id: 'region.setBinding',
  run(doc, params, tx) {
    if (!isObj(params) || (params.binding !== 'zip' && params.binding !== 'cross' && params.binding !== 'broadcast'))
      return [err('params.invalid', "region.setBinding: params must be {graphId, nodeId, binding:'zip'|'cross'|'broadcast'}")]
    const found = regionNode(doc, params, 'region.setBinding')
    if (Array.isArray(found)) return found
    const { graphId, nodeId, region } = found as { graphId: string; nodeId: string; region: RegionContract }
    const next = { ...region } as Record<string, unknown>
    if (params.binding === 'zip') delete next.binding
    else next.binding = params.binding
    tx.set(['graphs', graphId, 'nodes', nodeId, 'region'], next as Json)
    return []
  },
}

const regionSetMaxIterations: CommandDefinition = {
  id: 'region.setMaxIterations',
  run(doc, params, tx) {
    if (!isObj(params) || (params.maxIterations !== null && (!Number.isSafeInteger(params.maxIterations) || (params.maxIterations as number) < 1)))
      return [err('params.invalid', 'region.setMaxIterations: maxIterations must be null or a safe integer >= 1')]
    const found = regionNode(doc, params, 'region.setMaxIterations')
    if (Array.isArray(found)) return found
    const { graphId, nodeId, region } = found as { graphId: string; nodeId: string; region: RegionContract }
    const next = { ...region } as Record<string, unknown>
    if (params.maxIterations === null) delete next.maxIterations
    else next.maxIterations = params.maxIterations
    tx.set(['graphs', graphId, 'nodes', nodeId, 'region'], next as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// node.remove {graphId, nodeIds: string[]}  (cascades links/nets/view/boundary)
// ---------------------------------------------------------------------------

/**
 * Shared cascade used by node.remove and graph.deleteItems. Callers validate
 * existence first; this records the patch set: explicit links, links touching
 * removed nodes, whole nets whose source node is removed, pruned net sinks
 * (explicit + on removed nodes), boundary bindings, then the nodes and their
 * view state. One transaction, so undo restores everything atomically.
 */
function deleteCascade(
  doc: WorkflowDocument,
  def: GraphDef,
  graphId: string,
  nodeIds: readonly string[],
  linkIds: readonly string[],
  netSinks: readonly PortRefJson[],
  rerouteIds: readonly string[],
  valueSourceIds: readonly string[],
  selectorIds: readonly string[],
  tx: TransactionBuilder,
): void {
  const removed = new Set(nodeIds)
  const removedReroutes = new Set(rerouteIds)
  const removedValueSources = new Set(valueSourceIds)
  const removedSelectors = new Set(selectorIds)

  // Links: explicitly requested + any with an endpoint on a removed
  // node/reroute/value source/selector.
  const touchesRemoved = (e: LinkEndpoint): boolean => {
    if (isRerouteRef(e)) return removedReroutes.has(e.reroute)
    if (isValueSourceRef(e)) return removedValueSources.has(e.valueSource)
    if (isSelectorRef(e)) return removedSelectors.has(e.selector)
    return removed.has(e.node)
  }
  const dropLinks = new Set(linkIds)
  for (const [linkId, link] of Object.entries(def.links)) {
    if (touchesRemoved(link.from) || touchesRemoved(link.to)) dropLinks.add(linkId)
  }
  for (const linkId of dropLinks) removeDefinitionLink(graphId, linkId, tx)

  // The reroutes themselves + their view state.
  for (const id of rerouteIds) {
    tx.remove(['graphs', graphId, 'reroutes', id])
    if (doc.view.graphs[graphId]?.reroutes?.[id]) {
      tx.remove(['view', 'graphs', graphId, 'reroutes', id])
    }
  }

  // The value sources themselves + their view state.
  for (const id of valueSourceIds) {
    tx.remove(['graphs', graphId, 'valueSources', id])
    if (doc.view.graphs[graphId]?.valueSources?.[id]) {
      tx.remove(['view', 'graphs', graphId, 'valueSources', id])
    }
  }

  // The selectors themselves + their view state.
  for (const id of selectorIds) {
    tx.remove(['graphs', graphId, 'selectors', id])
    if (doc.view.graphs[graphId]?.selectors?.[id]) {
      tx.remove(['view', 'graphs', graphId, 'selectors', id])
    }
  }

  // Nets: drop the whole net if its source is removed, else prune sinks.
  const sinkGone = (s: PortRef): boolean =>
    removed.has(s.node) || netSinks.some((p) => samePortRef(toPortRef(p), s))
  for (const [netId, net] of Object.entries(def.nets)) {
    if (removed.has(net.source.node)) {
      removeNetDeliverySuppressions(graphId, netId, undefined, tx)
      tx.remove(['graphs', graphId, 'nets', netId])
      removeAuthoredNetViews(tx, (position) =>
        position.graphId === graphId && position.netId === netId,
      )
      pruneNetDisplayState(graphId, netId, tx)
    } else {
      const kept = net.sinks.filter((s) => !sinkGone(s))
      if (kept.length !== net.sinks.length) {
        const removedSinks = net.sinks.filter((sink) => !kept.some((entry) => samePortRef(entry, sink)))
        removeNetDeliverySuppressions(graphId, netId, removedSinks, tx)
        tx.set(['graphs', graphId, 'nets', netId, 'sinks'], kept as unknown as Json)
        removeAuthoredNetViews(tx, (position) =>
          position.graphId === graphId && position.netId === netId && position.role === 'sink' &&
          removedSinks.some((sink) => samePortRef(position.to, sink)),
        )
      }
    }
  }
  // Boundary items binding to removed nodes (subgraph defs only). A removed
  // PRIMARY target drops the whole item; a removed FAN-OUT target drops just
  // that entry (canonical form: 'alsoBinds' is omitted when it would empty).
  if (def.boundary) {
    const prune = (items: readonly BoundaryItem[]): { kept: Json; changed: boolean } => {
      let changed = false
      const kept: BoundaryItem[] = []
      for (const item of items) {
        if (removed.has(item.binds.node)) {
          changed = true
          continue
        }
        const also = item.alsoBinds?.filter((a) => !removed.has(a.node))
        if (item.alsoBinds !== undefined && also !== undefined && also.length !== item.alsoBinds.length) {
          changed = true
          const { alsoBinds: _drop, ...rest } = item
          kept.push(also.length > 0 ? { ...rest, alsoBinds: also } : rest)
          continue
        }
        kept.push(item)
      }
      return { kept: kept as unknown as Json, changed }
    }
    const inputs = prune(def.boundary.inputs)
    const outputs = prune(def.boundary.outputs)
    if (inputs.changed) tx.set(['graphs', graphId, 'boundary', 'inputs'], inputs.kept)
    if (outputs.changed) tx.set(['graphs', graphId, 'boundary', 'outputs'], outputs.kept)
  }
  // The nodes themselves + their view state.
  for (const id of nodeIds) {
    tx.remove(['graphs', graphId, 'nodes', id])
    if (doc.view.graphs[graphId]?.nodes[id]) {
      tx.remove(['view', 'graphs', graphId, 'nodes', id])
    }
  }
}

function occurrenceDeletionConflict(
  doc: WorkflowDocument,
  graphId: string,
  nodeIds: ReadonlySet<string>,
  rerouteIds: ReadonlySet<string> = new Set(),
  valueSourceIds: ReadonlySet<string> = new Set(),
  selectorIds: ReadonlySet<string> = new Set(),
): boolean {
  return Object.values(doc.occurrenceTopologies ?? {}).some((topology) => {
    let parent = doc.graphs[doc.root]
    for (const hop of topology.owner.instancePath) {
      if (parent?.id === graphId && nodeIds.has(hop)) return true
      const node = parent?.nodes[hop]
      const childId = node && subgraphDefIdOf(node.type)
      parent = childId === undefined ? undefined : doc.graphs[childId]
    }
    if (parent?.id === graphId && nodeIds.has(topology.owner.node)) return true
    return Object.values(topology.links).some((link) => [link.from, link.to].some((endpoint) => {
      if (endpoint.kind === 'boundary')
        return [...nodeIds].some((nodeId) => occurrenceEndpointReferencesDefinition(endpoint, graphId, nodeId))
      if (topology.bodyGraph !== graphId) return false
      if (isRerouteRef(endpoint.endpoint)) return rerouteIds.has(endpoint.endpoint.reroute)
      if (isValueSourceRef(endpoint.endpoint)) return valueSourceIds.has(endpoint.endpoint.valueSource)
      if (isSelectorRef(endpoint.endpoint)) return selectorIds.has(endpoint.endpoint.selector)
      return nodeIds.has(endpoint.endpoint.node)
    }))
  })
}

const nodeRemove: CommandDefinition = {
  id: 'node.remove',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.nodeIds))
      return [err('params.invalid', 'node.remove: params must be {graphId, nodeIds[]}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.remove: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const ids = params.nodeIds.filter((n): n is string => typeof n === 'string')
    const missing = ids.filter((id) => !def.nodes[id])
    if (missing.length > 0)
      return [err('node.missing', `node.remove: unknown node(s) ${missing.join(', ')}`)]
    if (occurrenceDeletionConflict(doc, graphId, new Set(ids)))
      return [err('occurrence.topology.definitionReferenced', 'node.remove: an occurrence-local link references a selected node')]
    deleteCascade(doc, def, graphId, ids, [], [], [], [], [], tx)
    return []
  },
}

// ---------------------------------------------------------------------------
// graph.deleteItems {graphId, nodeIds?, linkIds?, netSinks?: PortRef[],
//                    rerouteIds?, valueSourceIds?, selectorIds?}
// Atomic mixed deletion: one undo step for a node+link+net-noodle+reroute+
// value-source selection. Reroute deletion here is plain (attached links
// drop with it); reroute.remove is the reconnecting "dissolve" gesture.
// ---------------------------------------------------------------------------

const graphDeleteItems: CommandDefinition = {
  id: 'graph.deleteItems',
  run(doc, params, tx) {
    if (!isObj(params))
      return [err('params.invalid', 'graph.deleteItems: params must be {graphId, nodeIds?, linkIds?, netSinks?, rerouteIds?, valueSourceIds?}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `graph.deleteItems: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string

    const nodeIds = Array.isArray(params.nodeIds)
      ? params.nodeIds.filter((n): n is string => typeof n === 'string')
      : []
    const linkIds = Array.isArray(params.linkIds)
      ? params.linkIds.filter((l): l is string => typeof l === 'string')
      : []
    const netSinks = Array.isArray(params.netSinks) ? params.netSinks.filter(isPortRef) : []
    const rerouteIds = Array.isArray(params.rerouteIds)
      ? params.rerouteIds.filter((r): r is string => typeof r === 'string')
      : []
    const valueSourceIds = Array.isArray(params.valueSourceIds)
      ? params.valueSourceIds.filter((v): v is string => typeof v === 'string')
      : []
    const selectorIds = Array.isArray(params.selectorIds)
      ? params.selectorIds.filter((s): s is string => typeof s === 'string')
      : []

    const missingReroutes = rerouteIds.filter((id) => !def.reroutes[id])
    if (missingReroutes.length > 0)
      return [err('reroute.missing', `graph.deleteItems: unknown reroute(s) ${missingReroutes.join(', ')}`)]
    const missingValueSources = valueSourceIds.filter((id) => !def.valueSources?.[id])
    if (missingValueSources.length > 0)
      return [err('valueSource.missing', `graph.deleteItems: unknown value source(s) ${missingValueSources.join(', ')}`)]
    const missingSelectors = selectorIds.filter((id) => !def.selectors?.[id])
    if (missingSelectors.length > 0)
      return [err('selector.missing', `graph.deleteItems: unknown selector(s) ${missingSelectors.join(', ')}`)]
    const missingNodes = nodeIds.filter((id) => !def.nodes[id])
    if (missingNodes.length > 0)
      return [err('node.missing', `graph.deleteItems: unknown node(s) ${missingNodes.join(', ')}`)]
    const missingLinks = linkIds.filter((id) => !def.links[id])
    if (missingLinks.length > 0)
      return [err('link.missing', `graph.deleteItems: unknown link(s) ${missingLinks.join(', ')}`)]
    const nets = Object.values(def.nets)
    const missingSinks = netSinks.filter(
      (p) => !nets.some((net) => net.sinks.some((s) => samePortRef(s, toPortRef(p)))),
    )
    if (missingSinks.length > 0)
      return [
        err(
          'net.sinkMissing',
          `graph.deleteItems: no net sink feeds ${missingSinks.map((p) => `${p.node}.${p.port}`).join(', ')}`,
        ),
      ]

    if (occurrenceDeletionConflict(
      doc,
      graphId,
      new Set(nodeIds),
      new Set(rerouteIds),
      new Set(valueSourceIds),
      new Set(selectorIds),
    )) return [err('occurrence.topology.definitionReferenced', 'graph.deleteItems: occurrence-local topology references a selected entity')]

    deleteCascade(doc, def, graphId, nodeIds, linkIds, netSinks, rerouteIds, valueSourceIds, selectorIds, tx)
    return []
  },
}

// ---------------------------------------------------------------------------
// node.move {graphId, positions: {nodeId: {x,y}}}  (multi-node: one undo step per drag)
// ---------------------------------------------------------------------------

const nodeMove: CommandDefinition = {
  id: 'node.move',
  run(doc, params, tx) {
    if (!isObj(params) || !isObj(params.positions))
      return [err('params.invalid', 'node.move: params must be {graphId, positions}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.move: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    ensureViewGraph(tx, graphId)
    for (const [nodeId, pos] of Object.entries(params.positions)) {
      if (!def.nodes[nodeId]) return [err('node.missing', `node.move: unknown node '${nodeId}'`)]
      if (!isVec2(pos)) return [err('params.invalid', `node.move: position for '${nodeId}' must be {x,y}`)]
      const existing = tx.current.view.graphs[graphId]?.nodes[nodeId]
      if (existing) {
        tx.set(['view', 'graphs', graphId, 'nodes', nodeId, 'position'], { x: pos.x, y: pos.y })
      } else {
        tx.set(['view', 'graphs', graphId, 'nodes', nodeId], { position: { x: pos.x, y: pos.y } })
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// selection.move {graphId, nodes?, reroutes?, valueSources?, selectors?, groups?, netViews?}
// ---------------------------------------------------------------------------

const selectionMove: CommandDefinition = {
  id: 'selection.move',
  run(doc, params, tx) {
    if (!isObj(params)) return [err('params.invalid', 'selection.move: params must be an object')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selection.move: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const kinds = ['nodes', 'reroutes', 'valueSources', 'selectors'] as const
    if (kinds.every((kind) => params[kind] === undefined) && params.boundary === undefined &&
        params.groups === undefined && params.netViews === undefined)
      return [err('params.invalid', 'selection.move: at least one positions map is required')]
    for (const kind of kinds) {
      const positions = params[kind]
      if (positions === undefined) continue
      if (!isObj(positions)) return [err('params.invalid', `selection.move: ${kind} must be a positions map`)]
      for (const [id, pos] of Object.entries(positions)) {
        const exists = kind === 'nodes'
            ? def.nodes[id]
            : kind === 'reroutes'
              ? def.reroutes[id]
              : kind === 'valueSources'
                ? def.valueSources?.[id]
                : def.selectors?.[id]
        if (!exists) return [err(`${kind.slice(0, -1)}.missing`, `selection.move: unknown ${kind.slice(0, -1)} '${id}'`)]
        if (!isVec2(pos)) return [err('params.invalid', `selection.move: position for '${id}' must be {x,y}`)]
      }
    }
    if (params.boundary !== undefined) {
      if (!isObj(params.boundary)) return [err('params.invalid', 'selection.move: boundary must be a positions map')]
      if (!def.boundary) return [err('boundary.missing', `selection.move: graph '${def.id}' has no boundary`)]
      for (const [side, pos] of Object.entries(params.boundary)) {
        if ((side !== 'inputs' && side !== 'outputs') || !isVec2(pos))
          return [err('params.invalid', `selection.move: boundary position '${side}' is invalid`)]
      }
    }
    if (params.groups !== undefined) {
      if (!isObj(params.groups)) return [err('params.invalid', 'selection.move: groups must be a positions map')]
      for (const [id, pos] of Object.entries(params.groups)) {
        if (!groupOf(doc, graphId, id)) return [err('group.missing', `selection.move: unknown group '${id}'`)]
        if (!isVec2(pos)) return [err('params.invalid', `selection.move: position for group '${id}' must be {x,y}`)]
      }
    }
    const netViews: NetViewPosition[] = []
    if (params.netViews !== undefined) {
      if (!Array.isArray(params.netViews) || params.netViews.length === 0)
        return [err('params.invalid', 'selection.move: netViews must be a non-empty array')]
      // Tag geometry persists relative to the owning node (its post-move
      // position when this same command moves it), so the tag follows every
      // later node move. A node without a stored view position cannot anchor
      // an offset; the tag keeps absolute geometry until one exists.
      const geometryFor = (ownerId: string, position: { x: number; y: number }): NetViewGeometry => {
        const movedTo = isObj(params.nodes) ? params.nodes[ownerId] : undefined
        const ownerPos = isVec2(movedTo) ? movedTo : doc.view.graphs[graphId]?.nodes[ownerId]?.position
        if (ownerPos === undefined) return { kind: 'absolute', x: position.x, y: position.y }
        const snap = (v: number): number => Math.round(v * 100) / 100
        return { kind: 'offset', x: snap(position.x - ownerPos.x), y: snap(position.y - ownerPos.y) }
      }
      for (const view of params.netViews) {
        if (!isObj(view) || typeof view.netId !== 'string' ||
            (view.role !== 'source' && view.role !== 'sink') || !isVec2(view.position))
          return [err('params.invalid', 'selection.move: invalid net view')]
        const net = def.nets[view.netId]
        if (!net) return [err('net.missing', `selection.move: unknown net '${view.netId}'`)]
        if (view.role === 'source') {
          netViews.push({ graphId, netId: view.netId, role: 'source', geometry: geometryFor(net.source.node, view.position) })
          continue
        }
        if (!isPortRef(view.to)) return [err('params.invalid', 'selection.move: sink net view requires a PortRef to')]
        const to = toPortRef(view.to)
        if (!net.sinks.some((sink) => samePortRef(sink, to)))
          return [err('net.sinkMissing', 'selection.move: sink net view must reference a current sink')]
        netViews.push({ graphId, netId: view.netId, role: 'sink', to, geometry: geometryFor(to.node, view.position) })
      }
    }
    if (params.nodes !== undefined) ensureViewGraph(tx, graphId)
    if (params.reroutes !== undefined) ensureViewReroutes(tx, graphId)
    if (params.valueSources !== undefined) ensureViewValueSources(tx, graphId)
    if (params.selectors !== undefined) ensureViewSelectors(tx, graphId)
    if (params.boundary !== undefined) ensureViewGraph(tx, graphId)
    if (params.groups !== undefined) ensureViewGraph(tx, graphId)
    if (netViews.length > 0) {
      if (tx.current.ext === undefined) tx.set(['ext'], {})
      tx.set(['ext', NET_VIEWS_EXT_KEY], updateNetViewPositions(tx.current, netViews))
    }
    const paths = {
      nodes: 'nodes',
      reroutes: 'reroutes',
      valueSources: 'valueSources',
      selectors: 'selectors',
    } as const
    for (const kind of kinds) {
      const positions = params[kind] as Record<string, { x: number; y: number }> | undefined
      if (!positions) continue
      for (const [id, pos] of Object.entries(positions)) {
        const path = paths[kind]
        const existing = tx.current.view.graphs[graphId]?.[path]?.[id]
        if (existing) tx.set(['view', 'graphs', graphId, path, id, 'position'], { x: pos.x, y: pos.y })
        else tx.set(['view', 'graphs', graphId, path, id], { position: { x: pos.x, y: pos.y } })
      }
    }
    if (params.boundary !== undefined) {
      const entries = Object.entries(params.boundary as Record<string, { x: number; y: number }>)
      if (!tx.current.view.graphs[graphId]?.boundary) {
        tx.set(['view', 'graphs', graphId, 'boundary'], Object.fromEntries(
          entries.map(([side, pos]) => [side, { position: { x: pos.x, y: pos.y } }]),
        ))
      } else for (const [side, pos] of entries) {
        const existing = tx.current.view.graphs[graphId]?.boundary?.[side as 'inputs' | 'outputs']
        if (existing) tx.set(['view', 'graphs', graphId, 'boundary', side, 'position'], { x: pos.x, y: pos.y })
        else tx.set(['view', 'graphs', graphId, 'boundary', side], { position: { x: pos.x, y: pos.y } })
      }
    }
    if (params.groups !== undefined) {
      for (const [id, pos] of Object.entries(params.groups as Record<string, { x: number; y: number }>)) {
        const group = tx.current.view.graphs[graphId]?.groups?.[id]
        if (group) tx.set(['view', 'graphs', graphId, 'groups', id, 'bounds'], { ...group.bounds, x: pos.x, y: pos.y })
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// node.setValue {graphId, nodeId, inputId, value}
// ---------------------------------------------------------------------------

function nodeSetValueOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'node.setValue',
    run(doc, params, tx, context) {
      if (!isObj(params) || typeof params.nodeId !== 'string' || typeof params.inputId !== 'string')
        return [err('params.invalid', 'node.setValue: params must be {graphId, nodeId, inputId, value}')]
      const def = graphOf(doc, params.graphId)
      if (!def) return [err('graph.missing', `node.setValue: unknown graph '${String(params.graphId)}'`)]
      const node = def.nodes[params.nodeId]
      if (!node) return [err('node.missing', `node.setValue: unknown node '${params.nodeId}'`)]
      if (params.value === undefined)
        return [err('params.invalid', 'node.setValue: value is required')]
      const schema = commandSchemaOf(doc, node.type, context, resolve)
      if (schema !== undefined && outputCountInputsOf(schema).includes(params.inputId)) {
        return [err(
          'outputCount.commandRequired',
          `node.setValue: output-family count input '${params.inputId}' requires node.setOutputCount`,
        )]
      }
      tx.set(
        ['graphs', params.graphId as string, 'nodes', params.nodeId, 'values', params.inputId],
        params.value,
      )
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// image.applyAsset {graphId, nodeId, inputId, expectedSourceDigest, asset}
// ---------------------------------------------------------------------------

function imageApplyAssetOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.applyAsset',
    run(doc, params, tx, context) {
      if (
        !isObj(params) ||
        Object.keys(params).length !== 5 ||
        typeof params.graphId !== 'string' ||
        typeof params.nodeId !== 'string' ||
        typeof params.inputId !== 'string' ||
        typeof params.expectedSourceDigest !== 'string' ||
        !/^blake3:[0-9a-f]{64}$/.test(params.expectedSourceDigest) ||
        !isCompleteAssetRef(params.asset)
      ) {
        return [err(
          'params.invalid',
          'image.applyAsset: params must be {graphId, nodeId, inputId, expectedSourceDigest, asset: AssetRef}',
        )]
      }
      const def = graphOf(doc, params.graphId)
      if (!def) return [err('graph.missing', `image.applyAsset: unknown graph '${params.graphId}'`)]
      const node = def.nodes[params.nodeId]
      if (!node) return [err('node.missing', `image.applyAsset: unknown node '${params.nodeId}'`)]
      const schema = context.kind === 'initial'
        ? context.schemaResolverFor?.(doc)(node.type) ?? resolve?.(node.type)
        : resolve?.(node.type)
      if (!schema) return [err('schema.missing', `image.applyAsset: no schema for '${node.type}'`)]
      const input = schema.items.find((item) => item.kind === 'input' && item.id === params.inputId)
      if (input?.kind !== 'input' || !isImageAssetInput(input)) {
        return [err(
          'image.inputInvalid',
          `image.applyAsset: '${params.inputId}' is not a writable image asset input`,
        )]
      }
      const driven = Object.values(def.links).some((link) =>
        'node' in link.to && 'port' in link.to && link.to.node === params.nodeId && link.to.port === params.inputId) ||
        Object.values(def.nets).some((net) => net.sinks.some((sink) =>
          sink.node === params.nodeId && sink.port === params.inputId))
      if (driven) return [err('image.inputDriven', `image.applyAsset: '${params.inputId}' is driven`)]
      const source = node.values[params.inputId]
      if (!isCompleteAssetRef(source) || !source.mediaType.startsWith('image/')) {
        return [err('image.sourceInvalid', `image.applyAsset: '${params.inputId}' has no complete image AssetRef`)]
      }
      if (source.digest !== params.expectedSourceDigest) {
        return [err('image.sourceChanged', `image.applyAsset: source '${params.inputId}' changed during editing`)]
      }
      if (!params.asset.mediaType.startsWith('image/')) {
        return [err('image.assetInvalid', 'image.applyAsset: replacement AssetRef must have an image media type')]
      }
      tx.set(
        ['graphs', params.graphId, 'nodes', params.nodeId, 'values', params.inputId],
        params.asset,
      )
      return []
    },
  }
}

export const MASK_PAINT_SOURCE_EXT_KEY = 'dinkster.imageEditor.maskPaintSource'

export function maskPaintSourceNodeId(node: NodeData): string | undefined {
  const marker = node.ext?.[MASK_PAINT_SOURCE_EXT_KEY]
  return isObj(marker) && Object.keys(marker).length === 2 && typeof marker.nodeId === 'string' &&
    marker.outputId === 'mask' ? marker.nodeId : undefined
}

const sameAssetRef = (left: Json | undefined, right: Json | undefined): boolean =>
  isCompleteAssetRef(left) && isCompleteAssetRef(right) &&
  left.digest === right.digest && left.name === right.name && left.size === right.size &&
  left.mediaType === right.mediaType && left.virtualPath === right.virtualPath

const sortedStringList = (value: Json | undefined): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length) return undefined
  return [...value].sort() as string[]
}

function maskPaintRecipeHeader(value: string): { readonly sourceDigest: string } | undefined {
  const recipe = parseMaskPaintRecipe(value)
  return recipe ? { sourceDigest: recipe.sourceDigest } : undefined
}

function imageApplyMaskPaintOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.applyMaskPaint',
    run(doc, params, tx, context) {
      if (!isObj(params) || Object.keys(params).length !== 9 || typeof params.graphId !== 'string' ||
          typeof params.loaderNodeId !== 'string' || params.inputId !== 'image' || !isCompleteAssetRef(params.expectedSource) ||
          typeof params.operations !== 'string' || (params.paintNodeId !== null && typeof params.paintNodeId !== 'string') ||
          (params.expectedPaintOperations !== null && typeof params.expectedPaintOperations !== 'string')) {
        return [err('params.invalid', 'image.applyMaskPaint: malformed guarded paint transaction')]
      }
      const expectedLinks = sortedStringList(params.expectedMaskLinkIds)
      const expectedNets = sortedStringList(params.expectedMaskNetIds)
      if (!expectedLinks || !expectedNets) return [err('params.invalid', 'image.applyMaskPaint: mask topology ids must be unique string arrays')]
      const graph = doc.graphs[params.graphId]
      const loader = graph?.nodes[params.loaderNodeId]
      if (!graph || !loader) return [err('image.maskTargetMissing', 'The mask source node no longer exists')]
      if (Object.values(doc.occurrenceTopologies ?? {}).some((topology) => topology.bodyGraph === params.graphId)) {
        return [err('image.maskOccurrenceUnsupported', 'Mask paint does not support occurrence-local topology')]
      }
      if (loader.type !== 'dinkster.load_image') return [err('image.maskTargetInvalid', 'Mask paint requires dinkster.load_image')]
      const loaderSchema = commandSchemaOf(doc, loader.type, context, resolve)
      const paintSchema = commandSchemaOf(doc, 'dinkster.mask.paint', context, resolve)
      const loaderImage = loaderSchema && inputsOf(loaderSchema).find((input) => input.id === 'image')
      const loaderOutputs = loaderSchema ? outputsOf(loaderSchema) : []
      const paintInputs = paintSchema ? inputsOf(paintSchema) : []
      const paintOutputs = paintSchema ? outputsOf(paintSchema) : []
      if (!loaderImage || canonicalTypeIdOf(loaderImage.type) !== 'asset<dinkster.image>' ||
          canonicalTypeIdOf(loaderOutputs.find((output) => output.id === 'image')?.type ?? { kind: 'wildcard' }) !== 'dinkster.image' ||
          canonicalTypeIdOf(loaderOutputs.find((output) => output.id === 'mask')?.type ?? { kind: 'wildcard' }) !== 'dinkster.mask' ||
          canonicalTypeIdOf(paintInputs.find((input) => input.id === 'source')?.type ?? { kind: 'wildcard' }) !== 'asset<dinkster.image>' ||
          canonicalTypeIdOf(paintInputs.find((input) => input.id === 'operations')?.type ?? { kind: 'wildcard' }) !== 'core.string' ||
          paintInputs.find((input) => input.id === 'operations')?.widget?.widgetType !== 'STRING' ||
          paintInputs.find((input) => input.id === 'operations')?.widget?.options.multiline !== true ||
          canonicalTypeIdOf(paintOutputs.find((output) => output.id === 'mask')?.type ?? { kind: 'wildcard' }) !== 'dinkster.mask') {
        return [err('image.maskSchemaMissing', 'The backend does not expose the required mask paint schemas')]
      }
      if (!sameAssetRef(loader.values.image, params.expectedSource)) return [err('image.sourceChanged', 'The loader source changed during editing')]
      const recipe = maskPaintRecipeHeader(params.operations)
      if (!recipe || recipe.sourceDigest !== params.expectedSource.digest) return [err('image.maskRecipeInvalid', 'Mask operations do not match the loader source')]
      const source = { node: asNodeId(params.loaderNodeId), port: asPortId('mask') }
      const currentLinks = Object.values(graph.links).filter((link) => sameEndpoint(link.from, source)).map((link) => link.id).sort()
      const currentNets = Object.values(graph.nets).filter((net) => samePortRef(net.source, source)).map((net) => net.id).sort()
      if (currentLinks.join('\0') !== expectedLinks.join('\0') || currentNets.join('\0') !== expectedNets.join('\0')) {
        return [err('image.maskTopologyChanged', 'The loader mask topology changed during editing')]
      }
      let paintNodeId = params.paintNodeId as string | null
      const associatedPaintIds = Object.values(graph.nodes).filter((node) =>
        node.type === 'dinkster.mask.paint' && maskPaintSourceNodeId(node) === params.loaderNodeId).map((node) => node.id)
      if ((paintNodeId === null && associatedPaintIds.length !== 0) ||
          (paintNodeId !== null && (associatedPaintIds.length !== 1 || associatedPaintIds[0] !== paintNodeId))) {
        return [err('image.maskPaintChanged', 'The associated mask paint topology changed during editing')]
      }
      if (paintNodeId === null) {
        paintNodeId = allocateOne(tx, params.graphId, graph, 'n')
        tx.set(['graphs', params.graphId, 'nodes', paintNodeId], {
          id: paintNodeId,
          type: 'dinkster.mask.paint',
          values: { source: params.expectedSource, operations: params.operations },
          ext: { [MASK_PAINT_SOURCE_EXT_KEY]: { nodeId: params.loaderNodeId, outputId: 'mask' } },
        })
        const position = doc.view.graphs[params.graphId]?.nodes?.[params.loaderNodeId]?.position ?? { x: 0, y: 0 }
        ensureViewGraph(tx, params.graphId)
        tx.set(['view', 'graphs', params.graphId, 'nodes', paintNodeId], { position: { x: position.x + 280, y: position.y + 120 } })
      } else {
        const paint = graph.nodes[paintNodeId]
        if (!paint || paint.type !== 'dinkster.mask.paint' || maskPaintSourceNodeId(paint) !== params.loaderNodeId ||
            !sameAssetRef(paint.values.source, params.expectedSource) || paint.values.operations !== params.expectedPaintOperations) {
          return [err('image.maskPaintChanged', 'The associated mask paint node changed during editing')]
        }
        tx.set(['graphs', params.graphId, 'nodes', paintNodeId, 'values', 'operations'], params.operations)
      }
      const replacement = { node: asNodeId(paintNodeId), port: asPortId('mask') }
      for (const linkId of expectedLinks) tx.set(['graphs', params.graphId, 'links', linkId, 'from'], replacement)
      for (const netId of expectedNets) tx.set(['graphs', params.graphId, 'nets', netId, 'source'], replacement)
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// image.documentExport
// ---------------------------------------------------------------------------

function imageDocumentExportOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.documentExport',
    run(doc, params, tx, context) {
      if (!isObj(params) || Object.keys(params).length !== 4 || typeof params.graphId !== 'string' ||
        typeof params.expectedGraphFingerprint !== 'string' || !isCompleteAssetRef(params.asset) ||
        params.asset.mediaType !== 'application/vnd.dinkster.image-document+json' || !isVec2(params.position)) {
        return [err('params.invalid', 'image.documentExport requires graphId, expectedGraphFingerprint, document asset and position')]
      }
      const graph = doc.graphs[params.graphId]
      if (!graph || sha256Hex(canonicalJson(graph)) !== params.expectedGraphFingerprint) {
        return [err('image.graphChanged', 'The export graph changed while the document was being uploaded')]
      }
      const load = commandSchemaOf(doc, 'dinkster.layers.load', context, resolve)
      const flatten = commandSchemaOf(doc, 'dinkster.layers.flatten', context, resolve)
      const input = load?.items.find((item) => item.kind === 'input' && item.id === 'document')
      const output = load?.items.find((item) => item.kind === 'output' && item.id === 'layers')
      const layers = flatten?.items.find((item) => item.kind === 'input' && item.id === 'layers')
      const selector = flatten?.items.find((item) => item.kind === 'input' && item.id === 'selector')
      if (input?.kind !== 'input' || input.widget?.widgetType !== 'ASSET' ||
        canonicalTypeIdOf(input.type) !== 'dinkster.asset' ||
        output?.kind !== 'output' || canonicalTypeIdOf(output.type) !== 'dinkster.layers' ||
        layers?.kind !== 'input' || canonicalTypeIdOf(layers.type) !== 'dinkster.layers' ||
        selector?.kind !== 'input' || canonicalTypeIdOf(selector.type) !== 'core.string') {
        return [err('image.exportUnavailable', 'The backend does not advertise compatible layer load and flatten nodes')]
      }
      const allocation = graphAllocator(tx, params.graphId, graph)
      const loaderId = allocation.mint('n')
      const flattenId = allocation.mint('n')
      const linkId = allocation.mint('l')
      allocation.commit()
      tx.set(['graphs', params.graphId, 'nodes', loaderId], {
        id: loaderId, type: load!.type, values: { document: params.asset },
      })
      tx.set(['graphs', params.graphId, 'nodes', flattenId], {
        id: flattenId, type: flatten!.type, values: { selector: 'composite' },
      })
      tx.set(['graphs', params.graphId, 'links', linkId], {
        id: linkId, from: { node: loaderId, port: 'layers' }, to: { node: flattenId, port: 'layers' },
      })
      ensureViewGraph(tx, params.graphId)
      tx.set(['view', 'graphs', params.graphId, 'nodes', loaderId], { position: params.position })
      tx.set(['view', 'graphs', params.graphId, 'nodes', flattenId], {
        position: { x: params.position.x + 320, y: params.position.y },
      })
      return []
    },
  }
}

function imageDocumentRecipeExportOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.documentRecipeExport',
    run(doc, params, tx, context) {
      if (!isObj(params) || Object.keys(params).length !== 7 || typeof params.graphId !== 'string' ||
        typeof params.expectedGraphFingerprint !== 'string' || typeof params.sourceNodeId !== 'string' ||
        typeof params.sourceOutputId !== 'string' || typeof params.commands !== 'string' ||
        typeof params.format !== 'string' || !Number.isSafeInteger(params.quality)) {
        return [err('params.invalid', 'image.documentRecipeExport requires a guarded layer source, commands and output policy')]
      }
      let commands: Json
      try {
        commands = JSON.parse(params.commands) as Json
      } catch {
        return [err('params.invalid', 'image.documentRecipeExport commands must be canonical JSON')]
      }
      if (!Array.isArray(commands) || canonicalJson(commands) !== params.commands || !commands.every(validImageRecipeRow)) {
        return [err('params.invalid', 'image.documentRecipeExport commands must be a canonical array')]
      }
      const graph = doc.graphs[params.graphId]
      if (!graph || sha256Hex(canonicalJson(graph)) !== params.expectedGraphFingerprint) {
        return [err('image.graphChanged', 'The recipe source graph changed after the image document was opened')]
      }
      const sourceNode = graph.nodes[params.sourceNodeId]
      const source = sourceNode === undefined
        ? undefined
        : commandSchemaOf(doc, sourceNode.type, context, resolve)?.items.find((item) =>
          item.kind === 'output' && item.id === params.sourceOutputId)
      const edit = commandSchemaOf(doc, 'dinkster.layers.edit', context, resolve)
      const flatten = commandSchemaOf(doc, 'dinkster.layers.flatten', context, resolve)
      const save = commandSchemaOf(doc, 'dinkster.save_image', context, resolve)
      const editLayers = edit?.items.find((item) => item.kind === 'input' && item.id === 'layers')
      const editCommands = edit?.items.find((item) => item.kind === 'input' && item.id === 'commands')
      const editOutput = edit?.items.find((item) => item.kind === 'output' && item.id === 'layers')
      const flattenLayers = flatten?.items.find((item) => item.kind === 'input' && item.id === 'layers')
      const flattenSelector = flatten?.items.find((item) => item.kind === 'input' && item.id === 'selector')
      const flattenImage = flatten?.items.find((item) => item.kind === 'output' && item.id === 'image')
      const saveImages = save?.items.find((item) => item.kind === 'input' && item.id === 'images')
      const saveFormat = save?.items.find((item) => item.kind === 'input' && item.id === 'format')
      const saveQuality = save?.items.find((item) => item.kind === 'input' && item.id === 'quality')
      if (source?.kind !== 'output' || canonicalTypeIdOf(source.type) !== 'dinkster.layers' ||
        editLayers?.kind !== 'input' || canonicalTypeIdOf(editLayers.type) !== 'dinkster.layers' ||
        editCommands?.kind !== 'input' || canonicalTypeIdOf(editCommands.type) !== 'core.string' ||
        editOutput?.kind !== 'output' || canonicalTypeIdOf(editOutput.type) !== 'dinkster.layers' ||
        flattenLayers?.kind !== 'input' || canonicalTypeIdOf(flattenLayers.type) !== 'dinkster.layers' ||
        flattenSelector?.kind !== 'input' || canonicalTypeIdOf(flattenSelector.type) !== 'core.string' ||
        flattenImage?.kind !== 'output' || canonicalTypeIdOf(flattenImage.type) !== 'dinkster.image' ||
        saveImages?.kind !== 'input' || canonicalTypeIdOf(saveImages.type) !== 'dinkster.image' ||
        saveFormat?.kind !== 'input' || canonicalTypeIdOf(saveFormat.type) !== 'core.combo' ||
        saveFormat.widget?.widgetType !== 'COMBO' ||
        !normalizedComboOptions(saveFormat.widget).some((option) => option.value === params.format) ||
        saveQuality?.kind !== 'input' || canonicalTypeIdOf(saveQuality.type) !== 'core.int' ||
        saveQuality.widget?.widgetType !== 'INT') {
        return [err('image.recipeExportUnavailable', 'The backend does not advertise compatible layer edit, flatten and image save nodes')]
      }
      const qualityMin = saveQuality.widget.options['min']
      const qualityMax = saveQuality.widget.options['max']
      const qualityStep = saveQuality.widget.options['step']
      if (!Number.isSafeInteger(qualityMin) || !Number.isSafeInteger(qualityMax) ||
        !Number.isSafeInteger(qualityStep) || Number(qualityStep) <= 0 || Number(qualityMin) > Number(qualityMax) ||
        Number(params.quality) < Number(qualityMin) || Number(params.quality) > Number(qualityMax) ||
        (Number(params.quality) - Number(qualityMin)) % Number(qualityStep) !== 0) {
        return [err('image.recipeExportUnavailable', 'The backend does not advertise a compatible image quality range')]
      }
      const allocation = graphAllocator(tx, params.graphId, graph)
      const editId = allocation.mint('n')
      const flattenId = allocation.mint('n')
      const saveId = allocation.mint('n')
      const sourceLinkId = allocation.mint('l')
      const flattenLinkId = allocation.mint('l')
      const saveLinkId = allocation.mint('l')
      allocation.commit()
      tx.set(['graphs', params.graphId, 'nodes', editId], {
        id: editId, type: edit!.type, values: { commands: params.commands },
      })
      tx.set(['graphs', params.graphId, 'nodes', flattenId], {
        id: flattenId, type: flatten!.type, values: { selector: 'composite' },
      })
      tx.set(['graphs', params.graphId, 'nodes', saveId], {
        id: saveId, type: save!.type,
        values: { format: params.format as string, quality: params.quality as number },
      })
      tx.set(['graphs', params.graphId, 'links', sourceLinkId], {
        id: sourceLinkId,
        from: { node: params.sourceNodeId, port: params.sourceOutputId },
        to: { node: editId, port: 'layers' },
      })
      tx.set(['graphs', params.graphId, 'links', flattenLinkId], {
        id: flattenLinkId, from: { node: editId, port: 'layers' }, to: { node: flattenId, port: 'layers' },
      })
      tx.set(['graphs', params.graphId, 'links', saveLinkId], {
        id: saveLinkId, from: { node: flattenId, port: 'image' }, to: { node: saveId, port: 'images' },
      })
      const sourcePosition = doc.view.graphs[params.graphId]?.nodes?.[params.sourceNodeId]?.position ?? { x: 80, y: 80 }
      ensureViewGraph(tx, params.graphId)
      tx.set(['view', 'graphs', params.graphId, 'nodes', editId], {
        position: { x: sourcePosition.x + 320, y: sourcePosition.y },
      })
      tx.set(['view', 'graphs', params.graphId, 'nodes', flattenId], {
        position: { x: sourcePosition.x + 640, y: sourcePosition.y },
      })
      tx.set(['view', 'graphs', params.graphId, 'nodes', saveId], {
        position: { x: sourcePosition.x + 960, y: sourcePosition.y },
      })
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// image.compositorApply
// ---------------------------------------------------------------------------

const contextResolves = (
  doc: WorkflowDocument,
  graphId: string,
  instancePath: readonly string[],
): boolean => {
  let graph: GraphDef | undefined = doc.graphs[doc.root]
  for (const nodeId of instancePath) {
    const node = graph?.nodes[nodeId]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    graph = childId === undefined ? undefined : doc.graphs[childId]
    if (graph === undefined) return false
  }
  return graph?.id === graphId
}

function imageCompositorApplyOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.compositorApply',
    run(doc, params, tx, context) {
      if (
        !isObj(params) ||
        Object.keys(params).length !== 6 ||
        typeof params.graphId !== 'string' ||
        typeof params.nodeId !== 'string' ||
        typeof params.inputId !== 'string' ||
        !Array.isArray(params.instancePath) ||
        !params.instancePath.every((nodeId) => typeof nodeId === 'string') ||
        typeof params.expectedRecipeFingerprint !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(params.expectedRecipeFingerprint) ||
        !isCompositorRecipe(params.recipe)
      ) {
        return [err(
          'params.invalid',
          'image.compositorApply: params must be {graphId,nodeId,inputId,instancePath,expectedRecipeFingerprint,recipe}',
        )]
      }
      if (!contextResolves(doc, params.graphId, params.instancePath)) {
        return [err(
          'image.compositorContextInvalid',
          `image.compositorApply: instance path does not resolve to graph '${params.graphId}'`,
        )]
      }
      const instancePath = params.instancePath as string[]
      const def = doc.graphs[params.graphId]
      const node = def?.nodes[params.nodeId]
      if (!def) return [err('graph.missing', `image.compositorApply: unknown graph '${params.graphId}'`)]
      if (!node) return [err('node.missing', `image.compositorApply: unknown node '${params.nodeId}'`)]
      if (subgraphDefIdOf(node.type) !== undefined) {
        return [err('image.compositorInputInvalid', 'image.compositorApply: promoted subgraph inputs are not writable compositor targets')]
      }
      const resolver = context.kind === 'initial'
        ? context.schemaResolverFor?.(doc) ?? resolve
        : resolve
      if (!resolver) return [err('schema.missing', `image.compositorApply: no schema resolver for '${node.type}'`)]
      const schema = resolver?.(node.type)
      if (!schema) return [err('schema.missing', `image.compositorApply: no schema for '${node.type}'`)]
      const input = schema.items.find((item) => item.kind === 'input' && item.id === params.inputId)
      if (input?.kind !== 'input' || input.widget?.widgetType !== 'COMPOSITOR' ||
          canonicalTypeIdOf(input.type) !== 'dinkster.compositor') {
        return [err(
          'image.compositorInputInvalid',
          `image.compositorApply: '${params.inputId}' is not a writable dinkster.compositor input`,
        )]
      }
      const endpoint = { node: asNodeId(params.nodeId), port: asPortId(params.inputId) }
      const definitionDriven = Object.values(def.links).some((link) => sameEndpoint(link.to, endpoint)) ||
        Object.values(def.nets).some((net) => net.sinks.some((sink) => samePortRef(sink, endpoint)))
      let occurrenceDriven = false
      if (instancePath.length > 0) {
        const owner = {
          instancePath: instancePath.slice(0, -1).map(asNodeId),
          node: asNodeId(instancePath.at(-1)!),
        }
        const effective = effectiveOccurrenceTopology(doc, resolver, owner)
        if (effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          return [err('image.compositorContextInvalid', 'image.compositorApply: selected occurrence topology is invalid')]
        }
        occurrenceDriven = effectiveTopologyDrivesPort(
          effective,
          def.id,
          instancePath.map(asNodeId),
          endpoint,
        )
      }
      if (definitionDriven || occurrenceDriven) {
        return [err('image.compositorInputDriven', `image.compositorApply: '${params.inputId}' is driven`)]
      }
      const current = node.values[params.inputId]
      const fingerprint = compositorRecipeFingerprint(current)
      if (fingerprint === undefined) {
        return [err('image.compositorRecipeInvalid', `image.compositorApply: '${params.inputId}' contains an invalid recipe`)]
      }
      if (fingerprint !== params.expectedRecipeFingerprint) {
        return [err('image.compositorRecipeChanged', `image.compositorApply: recipe '${params.inputId}' changed during editing`)]
      }
      tx.set(
        ['graphs', params.graphId, 'nodes', params.nodeId, 'values', params.inputId],
        copyCompositorRecipe(params.recipe) as unknown as Json,
      )
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// node.setOutputCount {graphId, nodeId, inputId, value, removedLinks:'preserve'}
// ---------------------------------------------------------------------------

/** Schema-aware count edit. Removed output members keep their links so the
 * edit is reversible without hidden data loss; validation surfaces those
 * links as missing-port problems until the count is restored or they are
 * explicitly disconnected. */
function nodeSetOutputCountOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'node.setOutputCount',
    prepareForSharedReplay(doc, params, context) {
      if (
        !isObj(params) ||
        typeof params.graphId !== 'string' ||
        typeof params.nodeId !== 'string' ||
        typeof params.inputId !== 'string' ||
        !Number.isSafeInteger(params.value) ||
        (params.value as number) < 0 ||
        params.removedLinks !== 'preserve'
      ) return undefined
      if (params.schemaPlan !== undefined) return { ok: true, params }
      const def = doc.graphs[params.graphId]
      if (def === undefined) {
        return { ok: false, diagnostics: [err(
          'graph.missing',
          `node.setOutputCount: unknown graph '${params.graphId}'`,
        )] }
      }
      const node = def.nodes[params.nodeId]
      if (node === undefined) {
        return { ok: false, diagnostics: [err(
          'node.missing',
          `node.setOutputCount: unknown node '${params.nodeId}'`,
        )] }
      }
      const schema = commandSchemaOf(doc, node.type, context, resolve)
      return schema === undefined
        ? { ok: false, diagnostics: [err(
            'schema.missing',
            `node.setOutputCount: no schema for '${node.type}'`,
          )] }
        : {
            ok: true,
            params: { ...params, schemaPlan: planOutputCountSchema(node.type, schema) as unknown as Json },
          }
    },
    run(doc, params, tx, context) {
      if (
        !isObj(params) ||
        typeof params.graphId !== 'string' ||
        typeof params.nodeId !== 'string' ||
        typeof params.inputId !== 'string' ||
        !Number.isSafeInteger(params.value) ||
        (params.value as number) < 0 ||
        params.removedLinks !== 'preserve'
      ) {
        return [err(
          'params.invalid',
          "node.setOutputCount: params must be {graphId, nodeId, inputId, value: safe nonnegative integer, removedLinks:'preserve'}",
        )]
      }
      const def = graphOf(doc, params.graphId)
      if (!def) return [err('graph.missing', `node.setOutputCount: unknown graph '${params.graphId}'`)]
      const node = def.nodes[params.nodeId]
      if (!node) return [err('node.missing', `node.setOutputCount: unknown node '${params.nodeId}'`)]
      const schemaPlan = params.schemaPlan === undefined ? undefined : outputCountSchemaPlanFrom(params.schemaPlan)
      if (params.schemaPlan !== undefined && schemaPlan === undefined) {
        return [err('params.invalid', 'node.setOutputCount: schema plan is malformed')]
      }
      if (schemaPlan !== undefined && schemaPlan.nodeType !== node.type) {
        return [err('outputCount.schemaPlanStale', 'node.setOutputCount: target node type changed after planning')]
      }
      const liveSchema = context.kind === 'shared-replay' && schemaPlan !== undefined
        ? undefined
        : commandSchemaOf(doc, node.type, context, resolve)
      if (context.kind === 'initial' && schemaPlan !== undefined &&
          (liveSchema === undefined || canonicalJson(liveSchema) !== canonicalJson(schemaPlan.schemaSnapshot))) {
        return [err('outputCount.schemaPlanStale', 'node.setOutputCount: live schema differs from the planned snapshot')]
      }
      const schema = schemaPlan?.schemaSnapshot ?? liveSchema
      if (!schema) return [err('schema.missing', `node.setOutputCount: no schema for '${node.type}'`)]
      if (!outputCountInputsOf(schema).includes(params.inputId)) {
        return [err(
          'outputCount.inputMissing',
          `node.setOutputCount: '${params.inputId}' is not an output-family count input of '${node.type}'`,
        )]
      }
      const families: CountBoundOutputAutogrowSpec[] = []
      for (const output of outputsOf(schema)) {
        const dynamic = output.dynamic
        if (dynamic?.kind !== 'autogrow' || !('count' in dynamic)) continue
        const counted = dynamic as CountBoundOutputAutogrowSpec
        if (counted.count.input === params.inputId) families.push(counted)
      }
      const minimum = Math.max(...families.map((family) => family.naming.min ?? 0))
      const maximum = Math.min(...families.map((family) =>
        family.naming.kind === 'prefix'
          ? family.naming.max ?? DEFAULT_ELAB_BUDGET.maxMembers
          : DEFAULT_ELAB_BUDGET.maxMembers))
      const value = params.value as number
      if (value < minimum || value > maximum || value > DEFAULT_ELAB_BUDGET.maxMembers) {
        return [err(
          'outputCount.outOfRange',
          `node.setOutputCount: count ${value} is outside ${minimum}..${Math.min(maximum, DEFAULT_ELAB_BUDGET.maxMembers)}`,
        )]
      }
      const countIsLinked = Object.values(def.links).some((link) =>
        isPortEndpoint(link.to) &&
        link.to.node === params.nodeId &&
        link.to.port === params.inputId) ||
        Object.values(def.nets).some((net) => net.sinks.some((sink) =>
          sink.node === params.nodeId && sink.port === params.inputId))
      if (countIsLinked) {
        return [err(
          'outputCount.linked',
          `node.setOutputCount: count input '${params.inputId}' is linked and cannot store the output-family arity`,
        )]
      }
      const proposed = {
        values: { ...node.values, [params.inputId]: value },
        ...(node.dynamic !== undefined ? { dynamic: node.dynamic } : {}),
      }
      const elaborated = elaborateInterface(
        schema,
        proposed,
        buildGraphConnectivity(def)(node.id),
        { promoteGhosts: false, nodeId: node.id },
      )
      const budgetDiagnostic = elaborated.diagnostics.find((diagnostic) => diagnostic.code.startsWith('elab.budget.'))
      if (budgetDiagnostic !== undefined) {
        const memberBudget = budgetDiagnostic.code === 'elab.budget.members'
        return [err(
          memberBudget ? 'outputCount.memberBudget' : 'outputCount.elaborationBudget',
          memberBudget
            ? `node.setOutputCount: count ${value} would exceed the shared ${DEFAULT_ELAB_BUDGET.maxMembers}-member budget`
            : `node.setOutputCount: count ${value} would exceed the interface elaboration budget`,
        )]
      }
      if (node.values[params.inputId] === value) return []
      tx.set(['graphs', params.graphId, 'nodes', params.nodeId, 'values', params.inputId], value)
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// text.splice {graphId, nodeId, inputId, offset, deleteCount, insert}
// ---------------------------------------------------------------------------

const textSplice: CommandDefinition = {
  id: 'text.splice',
  transformForRebase(params, oldDoc, newDoc) {
    if (!isObj(params)) return undefined
    const { graphId, nodeId, inputId, offset, deleteCount, insert } = params
    if (
      typeof graphId !== 'string' ||
      typeof nodeId !== 'string' ||
      typeof inputId !== 'string' ||
      typeof offset !== 'number' ||
      typeof deleteCount !== 'number' ||
      typeof insert !== 'string'
    ) return undefined
    const oldValue = oldDoc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
    const newValue = newDoc.graphs[graphId]?.nodes[nodeId]?.values[inputId]
    if (typeof oldValue !== 'string' || typeof newValue !== 'string' || oldValue === newValue) return undefined
    const foreign = spliceDiff(oldValue, newValue)
    if (!foreign) return undefined
    const transformed = transformSplice({ offset, deleteCount, insert }, foreign)
    const clampedOffset = Math.min(Math.max(0, transformed.offset), newValue.length)
    const clampedDeleteCount = Math.min(
      Math.max(0, transformed.deleteCount),
      newValue.length - clampedOffset,
    )
    return { ...params, offset: clampedOffset, deleteCount: clampedDeleteCount }
  },
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.graphId !== 'string' ||
      typeof params.nodeId !== 'string' ||
      typeof params.inputId !== 'string' ||
      !Number.isSafeInteger(params.offset) ||
      (params.offset as number) < 0 ||
      !Number.isSafeInteger(params.deleteCount) ||
      (params.deleteCount as number) < 0 ||
      typeof params.insert !== 'string'
    ) {
      return [err('params.invalid', 'text.splice: params must be {graphId, nodeId, inputId, offset, deleteCount, insert}')]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `text.splice: unknown graph '${params.graphId}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `text.splice: unknown node '${params.nodeId}'`)]
    const value = node.values[params.inputId]
    if (typeof value !== 'string') {
      return [err('text.notString', `text.splice: value '${params.inputId}' must exist and be a string`)]
    }
    const offset = params.offset as number
    const deleteCount = params.deleteCount as number
    if (offset > value.length || offset + deleteCount > value.length) {
      return [err('params.invalid', 'text.splice: range must be within the stored string')]
    }
    tx.set(
      ['graphs', params.graphId, 'nodes', params.nodeId, 'values', params.inputId],
      value.slice(0, offset) + params.insert + value.slice(offset + deleteCount),
    )
    return []
  },
}

const CONTROLLER_MODES = new Set<ControllerMode>(['fixed', 'increment', 'decrement', 'randomize'])

/** Schema-aware node controller command over the active elaborated interface. */
function nodeSetControllerOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'node.setController',
    run(doc, params, tx, context) {
      if (!isObj(params) || typeof params.nodeId !== 'string' || typeof params.inputId !== 'string' || params.mode === undefined)
        return [err('params.invalid', 'node.setController: params must be {graphId, nodeId, inputId, mode|null}')]
      const def = graphOf(doc, params.graphId)
      if (!def) return [err('graph.missing', `node.setController: unknown graph '${String(params.graphId)}'`)]
      const node = def.nodes[params.nodeId]
      if (!node) return [err('node.missing', `node.setController: unknown node '${params.nodeId}'`)]
      const schema = commandSchemaOf(doc, node.type, context, resolve)
      if (schema) {
        const input = elabInputsOf(elaborateInterface(
          schema,
          node,
          buildGraphConnectivity(def)(node.id),
          { promoteGhosts: false, nodeId: node.id },
        )).find((candidate) => valueKeyOf(candidate) === params.inputId)
        if (input?.spec.widget?.controller === undefined)
          return [err('params.invalid', `node.setController: '${params.inputId}' is not a controller-enabled widget input`)]
      }
      if (params.mode !== null && (typeof params.mode !== 'string' || !CONTROLLER_MODES.has(params.mode as ControllerMode)))
        return [err('params.invalid', `node.setController: mode must be one of ${[...CONTROLLER_MODES].join('|')} or null`)]
      const path = ['graphs', params.graphId as string, 'nodes', params.nodeId, 'controllers', params.inputId]
      if (params.mode === null) tx.remove(path)
      else {
        if (!node.controllers) tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'controllers'], {})
        tx.set(path, params.mode)
      }
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// node.setValues {graphId, nodeId, values: Record<string, Json>}
// ---------------------------------------------------------------------------

/**
 * Atomic multi-value write: one dispatch = one undo step. The schema-aware
 * caller computes WHAT to write. Entries whose stored value already equals
 * the new value (canonical JSON) are skipped, so a fully-matching dispatch is
 * a no-op success with no undo entry.
 */
function nodeSetValuesOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'node.setValues',
    run(doc, params, tx, context) {
      if (!isObj(params) || typeof params.nodeId !== 'string' || !isObj(params.values))
        return [err('params.invalid', 'node.setValues: params must be {graphId, nodeId, values}')]
      const def = graphOf(doc, params.graphId)
      if (!def) return [err('graph.missing', `node.setValues: unknown graph '${String(params.graphId)}'`)]
      const node = def.nodes[params.nodeId]
      if (!node) return [err('node.missing', `node.setValues: unknown node '${params.nodeId}'`)]
      const entries = Object.entries(params.values)
      for (const [key, value] of entries) {
        if (value === undefined)
          return [err('params.invalid', `node.setValues: value for '${key}' is required`)]
      }
      const schema = commandSchemaOf(doc, node.type, context, resolve)
      const countInputs = schema === undefined ? [] : outputCountInputsOf(schema)
      const countInput = entries.find(([key]) => countInputs.includes(key))?.[0]
      if (countInput !== undefined) {
        return [err(
          'outputCount.commandRequired',
          `node.setValues: output-family count input '${countInput}' requires node.setOutputCount`,
        )]
      }
      for (const [key, value] of entries) {
        const current = node.values[key]
        if (current !== undefined && canonicalJson(current) === canonicalJson(value)) continue
        tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'values', key], value)
      }
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// node.setMode {graphId, nodeIds, mode: 'active'|'muted'|'bypassed'}
// ---------------------------------------------------------------------------

const NODE_MODES: readonly NodeMode[] = ['active', 'muted', 'bypassed']

const nodeSetMode: CommandDefinition = {
  id: 'node.setMode',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.nodeIds))
      return [err('params.invalid', 'node.setMode: params must be {graphId, nodeIds[], mode}')]
    if (!NODE_MODES.includes(params.mode as NodeMode))
      return [err('params.invalid', `node.setMode: mode must be one of ${NODE_MODES.join('/')}`)]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.setMode: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const mode = params.mode as NodeMode
    for (const nodeId of params.nodeIds) {
      if (typeof nodeId !== 'string' || !def.nodes[nodeId])
        return [err('node.missing', `node.setMode: unknown node '${String(nodeId)}'`)]
      tx.set(['graphs', graphId, 'nodes', nodeId, 'mode'], mode)
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// node.setTitle {graphId, nodeId, title: string | null}
// ---------------------------------------------------------------------------

const nodeSetTitle: CommandDefinition = {
  id: 'node.setTitle',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string' || (typeof params.title !== 'string' && params.title !== null))
      return [err('params.invalid', 'node.setTitle: params must be {graphId, nodeId, title: string|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.setTitle: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node)
      return [err('node.missing', `node.setTitle: unknown node '${params.nodeId}'`)]
    const path = ['graphs', params.graphId as string, 'nodes', params.nodeId, 'title']
    if (params.title === null) {
      if (node.title !== undefined) tx.remove(path)
    }
    else tx.set(path, params.title)
    return []
  },
}

// ---------------------------------------------------------------------------
// node.setPreviews {graphId, nodeIds, previews: PreviewMode | null}
// ---------------------------------------------------------------------------

const nodeSetPreviews: CommandDefinition = {
  id: 'node.setPreviews',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.nodeIds))
      return [err('params.invalid', 'node.setPreviews: params must be {graphId, nodeIds[], previews: mode|null}')]
    if (params.previews !== null && !PREVIEW_MODES.includes(params.previews as PreviewMode))
      return [err('params.invalid', `node.setPreviews: previews must be null or one of ${PREVIEW_MODES.join('/')}`)]
    const previews = params.previews as PreviewMode | null
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.setPreviews: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const nodeIds = new Set<string>()
    for (const nodeId of params.nodeIds) {
      if (typeof nodeId !== 'string' || !def.nodes[nodeId])
        return [err('node.missing', `node.setPreviews: unknown node '${String(nodeId)}'`)]
      nodeIds.add(nodeId)
    }
    for (const nodeId of nodeIds) {
      const path = ['graphs', graphId, 'nodes', nodeId, 'previews']
      if (previews === null) {
        if (def.nodes[nodeId]!.previews !== undefined) tx.remove(path)
      }
      else tx.set(path, previews)
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// node.setMirrorPreviews {graphId, nodeIds, mirrorPreviews: boolean | null}
// ---------------------------------------------------------------------------

const nodeSetMirrorPreviews: CommandDefinition = {
  id: 'node.setMirrorPreviews',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.nodeIds))
      return [err('params.invalid', 'node.setMirrorPreviews: params must be {graphId, nodeIds[], mirrorPreviews: boolean|null}')]
    if (params.mirrorPreviews !== null && typeof params.mirrorPreviews !== 'boolean')
      return [err('params.invalid', 'node.setMirrorPreviews: mirrorPreviews must be null or a boolean')]
    const mirrorPreviews = params.mirrorPreviews as boolean | null
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `node.setMirrorPreviews: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const nodeIds = new Set<string>()
    for (const nodeId of params.nodeIds) {
      if (typeof nodeId !== 'string' || !def.nodes[nodeId])
        return [err('node.missing', `node.setMirrorPreviews: unknown node '${String(nodeId)}'`)]
      nodeIds.add(nodeId)
    }
    for (const nodeId of nodeIds) {
      const path = ['graphs', graphId, 'nodes', nodeId, 'mirrorPreviews']
      if (mirrorPreviews === null) {
        if (def.nodes[nodeId]!.mirrorPreviews !== undefined) tx.remove(path)
      }
      else if (def.nodes[nodeId]!.mirrorPreviews !== mirrorPreviews) tx.set(path, mirrorPreviews)
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// workflow.setPreviews {previews: PreviewMode | null}
// ---------------------------------------------------------------------------

const workflowSetPreviews: CommandDefinition = {
  id: 'workflow.setPreviews',
  run(doc, params, tx) {
    if (!isObj(params))
      return [err('params.invalid', 'workflow.setPreviews: params must be {previews: mode|null}')]
    if (params.previews !== null && !PREVIEW_MODES.includes(params.previews as PreviewMode))
      return [err('params.invalid', `workflow.setPreviews: previews must be null or one of ${PREVIEW_MODES.join('/')}`)]
    const previews = params.previews as PreviewMode | null
    if (previews === null) {
      if (doc.previews !== undefined) tx.remove(['previews'])
    }
    else tx.set(['previews'], previews)
    return []
  },
}

// ---------------------------------------------------------------------------
// link.connect {graphId, from: Endpoint, to: Endpoint}
// ---------------------------------------------------------------------------

/**
 * Remove whatever currently drives `to`: a link into the input/reroute, or a
 * net sink (inputs only; nets cannot feed reroutes). One driver each (I5/I9).
 */
function removeDriver(def: GraphDef, graphId: string, to: LinkEndpoint, tx: TransactionBuilder): void {
  for (const [linkId, link] of Object.entries(def.links)) {
    if (sameEndpoint(link.to, to)) {
      removeDefinitionLink(graphId, linkId, tx)
    }
  }
  if (!isPortEndpoint(to)) return // reroutes: no net sinks; value sources: never targets
  for (const [netId, net] of Object.entries(def.nets)) {
    const kept = net.sinks.filter((s) => !samePortRef(s, to))
    if (kept.length !== net.sinks.length) {
      removeNetDeliverySuppressions(graphId, netId, [to], tx)
      tx.set(['graphs', graphId, 'nets', netId, 'sinks'], kept as unknown as Json)
      removeAuthoredNetViews(tx, (position) =>
        position.graphId === graphId && position.netId === netId &&
        position.role === 'sink' && samePortRef(position.to, to),
      )
    }
  }
}

/** Shared definition edits never displace a driver owned by one occurrence. */
function occurrenceDriverConflict(doc: WorkflowDocument, graphId: string, to: LinkEndpoint): boolean {
  return Object.values(doc.occurrenceTopologies ?? {}).some((topology) =>
    Object.values(topology.links).some((link) =>
      link.to.kind === 'body'
        ? topology.bodyGraph === graphId && sameEndpoint(link.to.endpoint, to)
        : isPortEndpoint(to) && occurrenceBoundaryTargets(doc, link.to, graphId, to),
    ),
  )
}

/**
 * Shared structural validation for connecting `from` -> `to`. Returns an
 * error diagnostic or undefined. Schema-blind (type compat is advisory), but
 * rejects self-loops and reroute cycles so I9 can never break.
 */
function connectError(def: GraphDef, graphId: string, from: LinkEndpoint, to: LinkEndpoint, what: string): Diagnostic | undefined {
  const refs = [...endpointRefs(graphId, from, 'output'), ...endpointRefs(graphId, to, 'input')]
  if (isWidgetTapRef(to))
    return err('link.tapTarget', `${what}: widget taps produce, never consume (cannot be a link target)`, refs)
  if (isValueSourceRef(to))
    return err('link.valueSourceTarget', `${what}: value sources produce, never consume (cannot be a link target)`, refs)
  if (isSelectorRef(from) && from.candidate !== undefined)
    return err('link.selectorCandidateSource', `${what}: selector candidates consume, never produce (source must be the selector output)`, refs)
  if (isSelectorRef(to) && to.candidate === undefined)
    return err('link.selectorOutputTarget', `${what}: selector outputs produce, never consume (target must name a candidate)`, refs)
  if (isPortEndpoint(from) && isPortEndpoint(to) && from.node === to.node)
    return err('link.selfLoop', `${what}: cannot connect a node to itself`, refs)
  if (isWidgetTapRef(from) && isPortEndpoint(to) && from.node === to.node && from.tap === to.port)
    return err('link.selfLoop', `${what}: cannot connect a widget tap to its own input`, refs)
  if (isWidgetTapRef(from) && wouldCreateTapCycle(def, from, to))
    return err('link.tapCycle', `${what}: connection would create a widget tap cycle`, refs)
  if (isRerouteRef(to)) {
    if (isRerouteRef(from) && from.reroute === to.reroute)
      return err('link.selfLoop', `${what}: cannot connect a reroute to itself`, refs)
    if (wouldCreateRerouteCycle(def, from, to.reroute))
      return err('reroute.cycle', `${what}: connection would create a reroute cycle`, refs)
  }
  if (isSelectorRef(to)) {
    if (isSelectorRef(from) && from.selector === to.selector)
      return err('link.selfLoop', `${what}: cannot connect a selector to itself`, refs)
    if (wouldCreateSelectorCycle(def, from, asSelectorId(to.selector)))
      return err('selector.cycle', `${what}: connection would create a selector cycle`, refs)
  }
  return undefined
}

const linkConnect: CommandDefinition = {
  id: 'link.connect',
  run(doc, params, tx) {
    if (!isObj(params) || !isEndpoint(params.from) || !isEndpoint(params.to))
      return [err('params.invalid', 'link.connect: params must be {graphId, from: Endpoint, to: Endpoint}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `link.connect: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const fromErr = endpointError(def, graphId, params.from, 'output', 'link.connect')
    if (fromErr) return [fromErr]
    const toErr = endpointError(def, graphId, params.to, 'input', 'link.connect')
    if (toErr) return [toErr]
    const from = toEndpoint(params.from)
    const to = toEndpoint(params.to)
    const connErr = connectError(def, graphId, from, to, 'link.connect')
    if (connErr) return [connErr]
    if (occurrenceDriverConflict(doc, graphId, to))
      return [err('occurrence.topology.definitionReferenced', 'link.connect: an occurrence-local link already drives this input')]

    removeDriver(def, graphId, to, tx)
    const id = allocateOne(tx, graphId, def, 'l')
    const link: LinkData = { id: id as LinkData['id'], from, to }
    tx.set(['graphs', graphId, 'links', id], link as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// link.rewire {graphId, linkId, to: PortRef}
//
// Move an existing link's target end in ONE transaction (one undo step): the
// UI gesture "grab a connected input pin, drop it on another input". The
// displaced driver at the new target (if any) is removed atomically.
// ---------------------------------------------------------------------------

const linkRewire: CommandDefinition = {
  id: 'link.rewire',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.linkId !== 'string' || !isEndpoint(params.to))
      return [err('params.invalid', 'link.rewire: params must be {graphId, linkId, to: Endpoint}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `link.rewire: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const link = def.links[params.linkId]
    if (!link) return [err('link.missing', `link.rewire: unknown link '${params.linkId}'`)]
    const toErr = endpointError(def, graphId, params.to, 'input', 'link.rewire')
    if (toErr) return [toErr]
    const to = toEndpoint(params.to)
    if (sameEndpoint(link.to, to)) return [] // no-op
    const connErr = connectError(def, graphId, link.from, to, 'link.rewire')
    if (connErr) return [connErr]
    if (occurrenceDriverConflict(doc, graphId, to))
      return [err('occurrence.topology.definitionReferenced', 'link.rewire: an occurrence-local link already drives this input')]

    removeDriver(def, graphId, to, tx)
    tx.set(['graphs', graphId, 'links', params.linkId, 'to'], to as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// link.rewireSource {graphId, linkIds, from: Endpoint}
//
// Move the SOURCE end of one or more links in ONE transaction (one undo
// step): the UI gesture "Shift-grab a connected output pin, drop the whole
// fan-out on another output". Link identities survive, so selection/undo
// stay stable. All-or-nothing: any invalid pairing rejects the whole move.
// ---------------------------------------------------------------------------

const linkRewireSource: CommandDefinition = {
  id: 'link.rewireSource',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      !Array.isArray(params.linkIds) ||
      params.linkIds.length === 0 ||
      !params.linkIds.every((l) => typeof l === 'string') ||
      !isEndpoint(params.from)
    )
      return [err('params.invalid', 'link.rewireSource: params must be {graphId, linkIds: [string, ...], from: Endpoint}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `link.rewireSource: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const fromErr = endpointError(def, graphId, params.from, 'output', 'link.rewireSource')
    if (fromErr) return [fromErr]
    const from = toEndpoint(params.from)
    const linkIds = params.linkIds as readonly string[]
    for (const linkId of linkIds) {
      const link = def.links[linkId]
      if (!link) return [err('link.missing', `link.rewireSource: unknown link '${linkId}'`)]
      if (sameEndpoint(link.from, from)) continue // no-op member
      const connErr = connectError(def, graphId, from, link.to, 'link.rewireSource')
      if (connErr) return [connErr]
    }
    for (const linkId of linkIds) {
      const link = def.links[linkId]!
      if (sameEndpoint(link.from, from)) continue
      tx.set(['graphs', graphId, 'links', linkId, 'from'], from as unknown as Json)
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// link.disconnect {graphId, linkId}
// ---------------------------------------------------------------------------

const linkDisconnect: CommandDefinition = {
  id: 'link.disconnect',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.linkId !== 'string')
      return [err('params.invalid', 'link.disconnect: params must be {graphId, linkId}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `link.disconnect: unknown graph '${String(params.graphId)}'`)]
    if (!def.links[params.linkId])
      return [err('link.missing', `link.disconnect: unknown link '${params.linkId}'`)]
    removeDefinitionLink(params.graphId as string, params.linkId, tx)
    return []
  },
}

// ---------------------------------------------------------------------------
// net.disconnectInput {graphId, to: PortRef}  (detach one sink from its net)
// ---------------------------------------------------------------------------

const netDisconnectInput: CommandDefinition = {
  id: 'net.disconnectInput',
  run(doc, params, tx) {
    if (!isObj(params) || !isPortRef(params.to))
      return [err('params.invalid', 'net.disconnectInput: params must be {graphId, to: PortRef}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.disconnectInput: unknown graph '${String(params.graphId)}'`)]
    const target = toPortRef(params.to)
    const graphId = params.graphId as string
    let touched = false
    for (const [netId, net] of Object.entries(def.nets)) {
      const kept = net.sinks.filter((s) => !samePortRef(s, target))
      if (kept.length !== net.sinks.length) {
        removeNetDeliverySuppressions(graphId, netId, [target], tx)
        tx.set(['graphs', graphId, 'nets', netId, 'sinks'], kept as unknown as Json)
        removeAuthoredNetViews(tx, (position) =>
          position.graphId === graphId && position.netId === netId &&
          position.role === 'sink' && samePortRef(position.to, target),
        )
        touched = true
      }
    }
    if (!touched)
      return [err('net.sinkMissing', 'net.disconnectInput: no net sink feeds that input')]
    return []
  },
}

// ---------------------------------------------------------------------------
// net.create {graphId, name, source: PortRef}
//
// Promote an output port to a named net (the 'Set' half of get/set, without
// fake nodes: nets are first-class hyperedges). Sinks attach separately via
// net.connectInput. Scoped to ONE graph definition by construction.
// ---------------------------------------------------------------------------

/** Non-empty, unique within the graph def (name IS the user-facing address). */
function netNameError(def: GraphDef, name: unknown, exceptNetId?: string): string | undefined {
  if (typeof name !== 'string' || name.trim().length === 0) return 'name must be a non-empty string'
  const taken = Object.values(def.nets).some((n) => n.name === name && n.id !== exceptNetId)
  return taken ? `a net named '${name}' already exists in this graph` : undefined
}

const netCreate: CommandDefinition = {
  id: 'net.create',
  run(doc, params, tx) {
    if (!isObj(params) || !isPortRef(params.source))
      return [err('params.invalid', 'net.create: params must be {graphId, name, source: PortRef}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.create: unknown graph '${String(params.graphId)}'`)]
    const nameErr = netNameError(def, params.name)
    if (nameErr) return [err('net.name', `net.create: ${nameErr}`)]
    if (!def.nodes[params.source.node])
      return [err('node.missing', `net.create: unknown source node '${params.source.node}'`)]

    const graphId = params.graphId as string
    const id = allocateOne(tx, graphId, def, 'net')
    tx.set(['graphs', graphId, 'nets', id], {
      id,
      name: (params.name as string).trim(),
      source: toPortRef(params.source),
      sinks: [],
    } as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// net.connectInput {graphId, netId, to: PortRef}
//
// Attach an input as a sink (the 'Get' half). Replaces whatever currently
// drives the input (I5: one driver), like link.connect.
// ---------------------------------------------------------------------------

const netConnectInput: CommandDefinition = {
  id: 'net.connectInput',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string' || !isPortRef(params.to))
      return [err('params.invalid', 'net.connectInput: params must be {graphId, netId, to: PortRef}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.connectInput: unknown graph '${String(params.graphId)}'`)]
    const net = def.nets[params.netId]
    if (!net) return [err('net.missing', `net.connectInput: unknown net '${params.netId}'`)]
    if (!def.nodes[params.to.node])
      return [err('node.missing', `net.connectInput: unknown target node '${params.to.node}'`)]
    if (net.source.node === params.to.node)
      return [err('link.selfLoop', 'net.connectInput: cannot feed a node from its own net')]
    const target = toPortRef(params.to)
    if (net.sinks.some((s) => samePortRef(s, target))) return [] // already a sink: no-op

    const graphId = params.graphId as string
    if (occurrenceDriverConflict(doc, graphId, target))
      return [err('occurrence.topology.definitionReferenced', 'net.connectInput: an occurrence-local link already drives this input')]
    removeDriver(def, graphId, target, tx)
    // Re-read through the tx: removeDriver may have rewritten this net's sinks.
    const current = tx.current.graphs[graphId]!.nets[params.netId]!
    tx.set(
      ['graphs', graphId, 'nets', params.netId, 'sinks'],
      [...current.sinks, target] as unknown as Json,
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// net.setSource {graphId, netId, source: PortRef}
//
// Re-point the net's single source output (the UI gesture "Shift-grab the
// source pin, drop the whole fan-out on another output"). Sinks are
// untouched; one transaction, one undo step.
// ---------------------------------------------------------------------------

const netSetSource: CommandDefinition = {
  id: 'net.setSource',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string' || !isPortRef(params.source))
      return [err('params.invalid', 'net.setSource: params must be {graphId, netId, source: PortRef}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.setSource: unknown graph '${String(params.graphId)}'`)]
    const net = def.nets[params.netId]
    if (!net) return [err('net.missing', `net.setSource: unknown net '${params.netId}'`)]
    if (!def.nodes[params.source.node])
      return [err('node.missing', `net.setSource: unknown source node '${params.source.node}'`)]
    const source = toPortRef(params.source)
    if (samePortRef(net.source, source)) return [] // no-op
    if (net.sinks.some((s) => s.node === source.node))
      return [err('link.selfLoop', 'net.setSource: cannot source a net from a node it feeds')]
    tx.set(['graphs', params.graphId as string, 'nets', params.netId, 'source'], source as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// net.rename {graphId, netId, name}
// ---------------------------------------------------------------------------

const netRename: CommandDefinition = {
  id: 'net.rename',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string')
      return [err('params.invalid', 'net.rename: params must be {graphId, netId, name}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.rename: unknown graph '${String(params.graphId)}'`)]
    if (!def.nets[params.netId])
      return [err('net.missing', `net.rename: unknown net '${params.netId}'`)]
    const nameErr = netNameError(def, params.name, params.netId)
    if (nameErr) return [err('net.name', `net.rename: ${nameErr}`)]
    tx.set(['graphs', params.graphId as string, 'nets', params.netId, 'name'], (params.name as string).trim())
    return []
  },
}

// ---------------------------------------------------------------------------
// net.remove {graphId, netId}  (the whole net: source binding + every sink)
// ---------------------------------------------------------------------------

const netRemove: CommandDefinition = {
  id: 'net.remove',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string')
      return [err('params.invalid', 'net.remove: params must be {graphId, netId}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.remove: unknown graph '${String(params.graphId)}'`)]
    if (!def.nets[params.netId])
      return [err('net.missing', `net.remove: unknown net '${params.netId}'`)]
    const graphId = params.graphId as string
    removeNetDeliverySuppressions(graphId, params.netId, undefined, tx)
    tx.remove(['graphs', graphId, 'nets', params.netId])
    removeAuthoredNetViews(tx, (position) =>
      position.graphId === graphId && position.netId === params.netId,
    )
    pruneNetDisplayState(graphId, params.netId, tx)
    return []
  },
}

// ---------------------------------------------------------------------------
// net.resetView {graphId, netId, role, to?}
//
// Drops one endpoint tag's authored placement so the tag returns to its
// default spawn spot beside the owning pin. Undo restores the entry.
// ---------------------------------------------------------------------------

const netResetView: CommandDefinition = {
  id: 'net.resetView',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string' ||
        (params.role !== 'source' && params.role !== 'sink'))
      return [err('params.invalid', 'net.resetView: params must be {graphId, netId, role, to?}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `net.resetView: unknown graph '${String(params.graphId)}'`)]
    const net = def.nets[params.netId]
    if (!net) return [err('net.missing', `net.resetView: unknown net '${params.netId}'`)]
    const graphId = params.graphId as string
    const netId = params.netId
    let matches: (position: NetViewPosition) => boolean
    if (params.role === 'sink') {
      if (!isPortRef(params.to)) return [err('params.invalid', 'net.resetView: sink reset requires a PortRef to')]
      const to = toPortRef(params.to)
      if (!net.sinks.some((sink) => samePortRef(sink, to)))
        return [err('net.sinkMissing', 'net.resetView: to must reference a current sink')]
      matches = (position) => position.graphId === graphId && position.netId === netId &&
        position.role === 'sink' && samePortRef(position.to, to)
    } else {
      matches = (position) => position.graphId === graphId && position.netId === netId &&
        position.role === 'source'
    }
    const next = removeNetViewPositions(doc, matches)
    if (next === undefined)
      return [err('netView.missing', `net.resetView: net '${netId}' ${params.role} tag has no authored position`)]
    tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setNetCollapsed {graphId, netId, collapsed: boolean}
//
// Collapsed nets render as endpoint tags instead of full noodles. View-only:
// compile and the document graph are unaffected.
// ---------------------------------------------------------------------------

const viewSetNetCollapsed: CommandDefinition = {
  id: 'view.setNetCollapsed',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string' || typeof params.collapsed !== 'boolean')
      return [err('params.invalid', 'view.setNetCollapsed: params must be {graphId, netId, collapsed}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setNetCollapsed: unknown graph '${String(params.graphId)}'`)]
    if (!def.nets[params.netId])
      return [err('net.missing', `view.setNetCollapsed: unknown net '${params.netId}'`)]
    const graphId = params.graphId as string
    const view = doc.view.graphs[graphId]
    const current = view?.collapsedNets ?? []
    const guides = view?.guideNets ?? []
    if (current.includes(params.netId) === params.collapsed && (params.collapsed || !guides.includes(params.netId)))
      return [] // no-op
    const next = params.collapsed ? [...current, params.netId] : current.filter((n) => n !== params.netId)
    ensureViewGraph(tx, graphId)
    if (current.includes(params.netId) !== params.collapsed) {
      tx.set(['view', 'graphs', graphId, 'collapsedNets'], next)
    }
    // Expanding back to a noodle also leaves guide mode (guideNets is a
    // subset of collapsedNets by invariant).
    if (!params.collapsed && guides.includes(params.netId)) {
      tx.set(['view', 'graphs', graphId, 'guideNets'], guides.filter((n) => n !== params.netId))
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setNetDisplay {graphId, netId, mode: 'noodle'|'tags'|'guide'}
//
// One mutually exclusive display mode per net: noodle (full delivery
// noodles), tags (endpoint tags only), or guide (tags plus a dashed
// Set-to-Get guide curve). View-only; compile and the graph are unaffected.
// ---------------------------------------------------------------------------

const NET_DISPLAY_MODES = ['noodle', 'tags', 'guide'] as const
type NetDisplayMode = (typeof NET_DISPLAY_MODES)[number]

function isNetDisplayMode(value: unknown): value is NetDisplayMode {
  return (NET_DISPLAY_MODES as readonly unknown[]).includes(value)
}

const viewSetNetDisplay: CommandDefinition = {
  id: 'view.setNetDisplay',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.netId !== 'string' || !isNetDisplayMode(params.mode))
      return [err('params.invalid', "view.setNetDisplay: params must be {graphId, netId, mode: 'noodle'|'tags'|'guide'}")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setNetDisplay: unknown graph '${String(params.graphId)}'`)]
    if (!def.nets[params.netId])
      return [err('net.missing', `view.setNetDisplay: unknown net '${params.netId}'`)]
    const graphId = params.graphId as string
    const netId = params.netId
    const view = doc.view.graphs[graphId]
    const currentCollapsed = view?.collapsedNets ?? []
    const currentGuides = view?.guideNets ?? []
    const wantCollapsed = params.mode !== 'noodle'
    const wantGuide = params.mode === 'guide'
    const isCollapsed = currentCollapsed.includes(netId)
    const isGuide = currentGuides.includes(netId)
    if (isCollapsed === wantCollapsed && isGuide === wantGuide) return [] // no-op
    ensureViewGraph(tx, graphId)
    if (isCollapsed !== wantCollapsed) {
      tx.set(
        ['view', 'graphs', graphId, 'collapsedNets'],
        wantCollapsed ? [...currentCollapsed, netId] : currentCollapsed.filter((n) => n !== netId),
      )
    }
    if (isGuide !== wantGuide) {
      tx.set(
        ['view', 'graphs', graphId, 'guideNets'],
        wantGuide ? [...currentGuides, netId] : currentGuides.filter((n) => n !== netId),
      )
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setAllNetsDisplay {graphId, mode: 'noodle'|'tags'|'guide'}
//
// Sets every net in the graph to one display mode in a single undoable
// step. Replaces both lists wholesale, which also drops dangling entries.
// ---------------------------------------------------------------------------

const viewSetAllNetsDisplay: CommandDefinition = {
  id: 'view.setAllNetsDisplay',
  run(doc, params, tx) {
    if (!isObj(params) || !isNetDisplayMode(params.mode))
      return [err('params.invalid', "view.setAllNetsDisplay: params must be {graphId, mode: 'noodle'|'tags'|'guide'}")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setAllNetsDisplay: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const netIds = Object.keys(def.nets)
    const view = doc.view.graphs[graphId]
    const currentCollapsed = view?.collapsedNets ?? []
    const currentGuides = view?.guideNets ?? []
    const nextCollapsed = params.mode === 'noodle' ? [] : netIds
    const nextGuides = params.mode === 'guide' ? netIds : []
    const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
      if (a.length !== b.length) return false
      const set = new Set(a)
      return b.every((entry) => set.has(entry))
    }
    if (sameSet(currentCollapsed, nextCollapsed) && sameSet(currentGuides, nextGuides)) return [] // no-op
    ensureViewGraph(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'collapsedNets'], nextCollapsed)
    tx.set(['view', 'graphs', graphId, 'guideNets'], nextGuides)
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setNodeCollapsed {graphId, nodeIds, collapsed}
// ---------------------------------------------------------------------------

const viewSetNodeCollapsed: CommandDefinition = {
  id: 'view.setNodeCollapsed',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.graphId !== 'string' ||
      !Array.isArray(params.nodeIds) ||
      params.nodeIds.length === 0 ||
      !params.nodeIds.every((nodeId) => typeof nodeId === 'string') ||
      typeof params.collapsed !== 'boolean'
    ) {
      return [err(
        'params.invalid',
        'view.setNodeCollapsed: params must be {graphId, nodeIds: [string, ...], collapsed: boolean}',
      )]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setNodeCollapsed: unknown graph '${params.graphId}'`)]
    const nodeIds = [...new Set(params.nodeIds)]
    const missing = nodeIds.filter((nodeId) => !def.nodes[nodeId])
    if (missing.length > 0) {
      return [err('node.missing', `view.setNodeCollapsed: unknown node(s) ${missing.join(', ')}`)]
    }
    const graphId = params.graphId
    for (const nodeId of nodeIds) {
      const viewNode = doc.view.graphs[graphId]?.nodes[nodeId]
      if (params.collapsed) {
        if (viewNode?.collapsed === true) continue
        ensureViewGraph(tx, graphId)
        if (viewNode === undefined) {
          tx.set(['view', 'graphs', graphId, 'nodes', nodeId], { collapsed: true })
        } else {
          tx.set(['view', 'graphs', graphId, 'nodes', nodeId, 'collapsed'], true)
        }
      } else if (viewNode?.collapsed === true) {
        tx.remove(['view', 'graphs', graphId, 'nodes', nodeId, 'collapsed'])
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setNodeSize {graphId, nodeId, size: {width,height} | null, position?}
// ---------------------------------------------------------------------------

const viewSetNodeSize: CommandDefinition = {
  id: 'view.setNodeSize',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string')
      return [err('params.invalid', 'view.setNodeSize: params must be {graphId, nodeId, size|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setNodeSize: unknown graph '${String(params.graphId)}'`)]
    if (!def.nodes[params.nodeId])
      return [err('node.missing', `view.setNodeSize: unknown node '${params.nodeId}'`)]
    const graphId = params.graphId as string
    const viewNode = doc.view.graphs[graphId]?.nodes[params.nodeId]
    if (params.size === null) {
      if (viewNode && 'size' in viewNode)
        tx.remove(['view', 'graphs', graphId, 'nodes', params.nodeId, 'size'])
      return []
    }
    if (!isObj(params.size) || typeof params.size.width !== 'number' || typeof params.size.height !== 'number')
      return [err('params.invalid', 'view.setNodeSize: size must be {width,height} or null')]
    if (params.position !== undefined && !isVec2(params.position))
      return [err('params.invalid', 'view.setNodeSize: position must be {x,y}')]
    if (!viewNode) {
      // A semantic node can legally lack view state (the scene paints it at
      // a fallback position). A resize commit always carries the position it
      // painted, so materialize the entry - mirroring node.move - instead of
      // rejecting a gesture the user just completed. Without a position
      // there is nothing to anchor the entry to, so that still rejects.
      if (params.position === undefined)
        return [err('node.missing', `view.setNodeSize: node '${params.nodeId}' has no view state`)]
      ensureViewGraph(tx, graphId)
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId], {
        position: params.position,
        size: { width: params.size.width, height: params.size.height },
      })
      return []
    }
    tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'size'], {
      width: params.size.width,
      height: params.size.height,
    })
    if (params.position !== undefined)
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'position'], params.position)
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setNodeVideo {graphId, nodeId, video: {loop, muted, autoplay}}
// ---------------------------------------------------------------------------

const viewSetNodeVideo: CommandDefinition = {
  id: 'view.setNodeVideo',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string' || !isObj(params.video) ||
        typeof params.video.loop !== 'boolean' || typeof params.video.muted !== 'boolean' ||
        typeof params.video.autoplay !== 'boolean')
      return [err('params.invalid', 'view.setNodeVideo: expected nodeId and boolean loop/muted/autoplay preferences')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', 'view.setNodeVideo: unknown graph')]
    if (!def.nodes[params.nodeId]) return [err('node.missing', 'view.setNodeVideo: unknown node')]
    const graphId = params.graphId as string
    const video = { loop: params.video.loop, muted: params.video.muted, autoplay: params.video.autoplay }
    if (doc.view.graphs[graphId]?.nodes[params.nodeId]) {
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'video'], video)
    } else {
      ensureViewGraph(tx, graphId)
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId], { video })
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setNodeColor {graphId, nodeId, color: string | null}
// ---------------------------------------------------------------------------

const viewSetNodeColor: CommandDefinition = {
  id: 'view.setNodeColor',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      (typeof params.color !== 'string' && params.color !== null)
    )
      return [err('params.invalid', 'view.setNodeColor: params must be {graphId, nodeId, color: string|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setNodeColor: unknown graph '${String(params.graphId)}'`)]
    if (!def.nodes[params.nodeId])
      return [err('node.missing', `view.setNodeColor: unknown node '${params.nodeId}'`)]
    const graphId = params.graphId as string
    const viewNode = doc.view.graphs[graphId]?.nodes[params.nodeId]
    if (params.color === null) {
      if (viewNode && 'color' in viewNode)
        tx.remove(['view', 'graphs', graphId, 'nodes', params.nodeId, 'color'])
      return []
    }
    if (viewNode) {
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'color'], params.color)
    } else {
      // Position is independently optional: a semantic node without view
      // geometry already paints at the scene's deterministic fallback.
      ensureViewGraph(tx, graphId)
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId], { color: params.color })
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setWidgetRepresentation
// {graphId, nodeId, inputId, representation: string | null}
//
// Pure editor/view state. Commands are schema-blind, so the caller resolves
// switchability and declared representation ids; layout safely ignores a
// stale id until a later schema refresh makes it valid again.
// ---------------------------------------------------------------------------

const viewSetWidgetRepresentation: CommandDefinition = {
  id: 'view.setWidgetRepresentation',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      typeof params.inputId !== 'string' ||
      params.inputId.length === 0 ||
      (typeof params.representation !== 'string' && params.representation !== null) ||
      params.representation === ''
    ) {
      return [err(
        'params.invalid',
        'view.setWidgetRepresentation: params must be {graphId, nodeId, inputId, representation: string|null}',
      )]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setWidgetRepresentation: unknown graph '${String(params.graphId)}'`)]
    if (!def.nodes[params.nodeId]) {
      return [err('node.missing', `view.setWidgetRepresentation: unknown node '${params.nodeId}'`)]
    }
    const graphId = params.graphId as string
    const viewNode = doc.view.graphs[graphId]?.nodes[params.nodeId]
    if (params.representation === null) {
      const views = viewNode?.views
      if (!views || !(params.inputId in views)) return []
      if (Object.keys(views).length === 1) {
        tx.remove(['view', 'graphs', graphId, 'nodes', params.nodeId, 'views'])
      } else {
        tx.remove(['view', 'graphs', graphId, 'nodes', params.nodeId, 'views', params.inputId])
      }
      return []
    }
    ensureViewGraph(tx, graphId)
    if (!viewNode) {
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId], {
        views: { [params.inputId]: params.representation },
      })
    } else {
      if (!viewNode.views) tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'views'], {})
      tx.set(
        ['view', 'graphs', graphId, 'nodes', params.nodeId, 'views', params.inputId],
        params.representation,
      )
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.moveBoundaryNode {graphId, side: 'inputs'|'outputs', position: {x,y}}
//
// Positions a boundary pseudo-node (the node-like Inputs/Outputs panel shown
// while editing a subgraph definition). The panels themselves are DERIVED
// from GraphDef.boundary at scene-build time; only their geometry persists.
// ---------------------------------------------------------------------------

const viewMoveBoundaryNode: CommandDefinition = {
  id: 'view.moveBoundaryNode',
  run(doc, params, tx) {
    if (!isObj(params) || (params.side !== 'inputs' && params.side !== 'outputs') || !isVec2(params.position))
      return [err('params.invalid', "view.moveBoundaryNode: params must be {graphId, side: 'inputs'|'outputs', position: {x,y}}")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.moveBoundaryNode: unknown graph '${String(params.graphId)}'`)]
    if (!def.boundary)
      return [err('boundary.missing', `view.moveBoundaryNode: graph '${def.id}' has no boundary (not a subgraph definition)`)]
    const graphId = params.graphId as string
    ensureViewGraph(tx, graphId)
    const position = { x: params.position.x, y: params.position.y }
    if (tx.current.view.graphs[graphId]?.boundary?.[params.side]) {
      tx.set(['view', 'graphs', graphId, 'boundary', params.side, 'position'], position)
    } else if (tx.current.view.graphs[graphId]?.boundary) {
      tx.set(['view', 'graphs', graphId, 'boundary', params.side], { position })
    } else {
      tx.set(['view', 'graphs', graphId, 'boundary'], { [params.side]: { position } })
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setSectionCollapsed {graphId, nodeId, sectionId, collapsed: boolean | null}
//
// Sets (or with null, clears) the per-node collapse OVERRIDE for a schema
// section. Section ids live in schemas, which commands cannot resolve, so
// any non-empty id is accepted; layout simply ignores overrides that match
// no declared section.
// ---------------------------------------------------------------------------

const viewSetSectionCollapsed: CommandDefinition = {
  id: 'view.setSectionCollapsed',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      typeof params.sectionId !== 'string' ||
      params.sectionId.length === 0 ||
      (typeof params.collapsed !== 'boolean' && params.collapsed !== null)
    ) {
      return [
        err(
          'params.invalid',
          'view.setSectionCollapsed: params must be {graphId, nodeId, sectionId, collapsed: boolean|null}',
        ),
      ]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setSectionCollapsed: unknown graph '${String(params.graphId)}'`)]
    if (!def.nodes[params.nodeId])
      return [err('node.missing', `view.setSectionCollapsed: unknown node '${params.nodeId}'`)]
    const graphId = params.graphId as string
    const viewNode = doc.view.graphs[graphId]?.nodes[params.nodeId]
    if (params.collapsed === null) {
      const sections = viewNode?.sections
      if (!sections || !(params.sectionId in sections)) return [] // clearing an absent override is a no-op
      if (Object.keys(sections).length === 1) {
        tx.remove(['view', 'graphs', graphId, 'nodes', params.nodeId, 'sections'])
      } else {
        tx.remove(['view', 'graphs', graphId, 'nodes', params.nodeId, 'sections', params.sectionId])
      }
      return []
    }
    if (!viewNode)
      return [err('node.missing', `view.setSectionCollapsed: node '${params.nodeId}' has no view state`)]
    if (!viewNode.sections) {
      tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'sections'], {})
    }
    tx.set(['view', 'graphs', graphId, 'nodes', params.nodeId, 'sections', params.sectionId], {
      collapsed: params.collapsed,
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// Groups: pure view rectangles with NO stored membership (which nodes a
// group contains is derived spatially at interaction time). All group
// commands live entirely in the view tree - creating/moving/deleting a
// group never touches semantic state or the semantic hash.
// ---------------------------------------------------------------------------

const isBounds = (
  v: Json | undefined,
): v is JsonObject & { x: number; y: number; width: number; height: number } =>
  isObj(v) &&
  typeof v.x === 'number' &&
  typeof v.y === 'number' &&
  typeof v.width === 'number' &&
  typeof v.height === 'number'

const groupOf = (doc: WorkflowDocument, graphId: string, groupId: unknown) =>
  typeof groupId === 'string' ? doc.view.graphs[graphId]?.groups?.[groupId] : undefined

// ---------------------------------------------------------------------------
// view.createGroup {graphId, title, bounds, color?}
// ---------------------------------------------------------------------------

const viewCreateGroup: CommandDefinition = {
  id: 'view.createGroup',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.title !== 'string' || !isBounds(params.bounds))
      return [err('params.invalid', 'view.createGroup: params must be {graphId, title, bounds, color?}')]
    if (params.bounds.width <= 0 || params.bounds.height <= 0)
      return [err('params.invalid', 'view.createGroup: bounds must have positive width and height')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.createGroup: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string

    // Never-reuse ids (FR1): group ids outlive their groups in surface
    // bindings (a mode panel keeps a removed group's binding as visibly
    // broken), so a reminted id would silently retarget that binding onto
    // an unrelated group. groupAllocationFloor is the shared allocation
    // authority (persisted cursor + live keys + binding-referenced ids;
    // see group-alloc.ts) - clipboard paste allocates from the same floor.
    // The cursor path is allocation-monotonic in DocumentStore.replay
    // (structurally too: undoing the create that materialized the view
    // graph leaves a cursor skeleton), so undo never rewinds it.
    const existing = doc.view.graphs[graphId]?.groups ?? {}
    const n = groupAllocationFloor(doc, graphId)
    // Exhaustion guard (CO7/FR1): an unsafe cursor would stop incrementing
    // and turn tx.set's add-or-replace into silent group overwrites.
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(n + 1))
      return [err('group.exhausted', 'view.createGroup: group id cursor exhausted')]
    const id = `grp${n}`
    // Terminal collision (CO7): with grp<MAX-1> AND grp<MAX> both present,
    // the scan lands on the skipped key's exact id. tx.set would replace it
    // silently - reject instead; overwriting an existing group is never OK.
    if (Object.hasOwn(existing, id))
      return [err('group.exhausted', `view.createGroup: group id space exhausted ('${id}' already exists)`)]
    ensureViewGraph(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'groupSeq'], n + 1)
    if (!tx.current.view.graphs[graphId]?.groups) tx.set(['view', 'graphs', graphId, 'groups'], {})
    tx.set(['view', 'graphs', graphId, 'groups', id], {
      id,
      title: params.title,
      bounds: { ...params.bounds },
      ...(typeof params.color === 'string' ? { color: params.color } : {}),
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// view.moveGroup {graphId, groupId, bounds, positions, reroutes?, boundary?,
//                 valueSources?, selectors?}
//
// One undo step per group drag: the group's new origin plus the final
// positions of the nodes it carried (membership was derived at drag start).
// ---------------------------------------------------------------------------

const viewMoveGroup: CommandDefinition = {
  id: 'view.moveGroup',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.groupId !== 'string' || !isVec2(params.bounds) || !isObj(params.positions))
      return [err('params.invalid', 'view.moveGroup: params must be {graphId, groupId, bounds: {x,y}, positions}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.moveGroup: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const group = groupOf(doc, graphId, params.groupId)
    if (!group) return [err('group.missing', `view.moveGroup: unknown group '${params.groupId}'`)]

    tx.set(['view', 'graphs', graphId, 'groups', params.groupId, 'bounds'], {
      ...group.bounds,
      x: params.bounds.x,
      y: params.bounds.y,
    })
    for (const [nodeId, pos] of Object.entries(params.positions)) {
      if (!def.nodes[nodeId]) return [err('node.missing', `view.moveGroup: unknown node '${nodeId}'`)]
      if (!isVec2(pos)) return [err('params.invalid', `view.moveGroup: position for '${nodeId}' must be {x,y}`)]
      const existing = tx.current.view.graphs[graphId]?.nodes[nodeId]
      if (existing) {
        tx.set(['view', 'graphs', graphId, 'nodes', nodeId, 'position'], { x: pos.x, y: pos.y })
      } else {
        tx.set(['view', 'graphs', graphId, 'nodes', nodeId], { position: { x: pos.x, y: pos.y } })
      }
    }
    if (params.reroutes !== undefined) {
      if (!isObj(params.reroutes)) return [err('params.invalid', 'view.moveGroup: reroutes must be a positions map')]
      ensureViewReroutes(tx, graphId)
      for (const [id, pos] of Object.entries(params.reroutes)) {
        if (!def.reroutes[id]) return [err('reroute.missing', `view.moveGroup: unknown reroute '${id}'`)]
        if (!isVec2(pos)) return [err('params.invalid', `view.moveGroup: position for reroute '${id}' must be {x,y}`)]
        tx.set(['view', 'graphs', graphId, 'reroutes', id, 'position'], { x: pos.x, y: pos.y })
      }
    }
    if (params.boundary !== undefined) {
      if (!isObj(params.boundary)) return [err('params.invalid', 'view.moveGroup: boundary must be a positions map')]
      for (const [side, pos] of Object.entries(params.boundary)) {
        if ((side !== 'inputs' && side !== 'outputs') || !isVec2(pos))
          return [err('params.invalid', 'view.moveGroup: boundary positions must be inputs/outputs {x,y}')]
        tx.set(['view', 'graphs', graphId, 'boundary', side, 'position'], { x: pos.x, y: pos.y })
      }
    }
    if (params.valueSources !== undefined) {
      if (!isObj(params.valueSources)) return [err('params.invalid', 'view.moveGroup: valueSources must be a positions map')]
      ensureViewValueSources(tx, graphId)
      for (const [id, pos] of Object.entries(params.valueSources)) {
        if (!def.valueSources?.[id]) return [err('valueSource.missing', `view.moveGroup: unknown value source '${id}'`)]
        if (!isVec2(pos)) return [err('params.invalid', `view.moveGroup: position for value source '${id}' must be {x,y}`)]
        const existing = tx.current.view.graphs[graphId]?.valueSources?.[id]
        if (existing) {
          tx.set(['view', 'graphs', graphId, 'valueSources', id, 'position'], { x: pos.x, y: pos.y })
        } else {
          tx.set(['view', 'graphs', graphId, 'valueSources', id], { position: { x: pos.x, y: pos.y } })
        }
      }
    }
    if (params.selectors !== undefined) {
      if (!isObj(params.selectors)) return [err('params.invalid', 'view.moveGroup: selectors must be a positions map')]
      ensureViewSelectors(tx, graphId)
      for (const [id, pos] of Object.entries(params.selectors)) {
        if (!def.selectors?.[id]) return [err('selector.missing', `view.moveGroup: unknown selector '${id}'`)]
        if (!isVec2(pos)) return [err('params.invalid', `view.moveGroup: position for selector '${id}' must be {x,y}`)]
        const existing = tx.current.view.graphs[graphId]?.selectors?.[id]
        if (existing) {
          tx.set(['view', 'graphs', graphId, 'selectors', id, 'position'], { x: pos.x, y: pos.y })
        } else {
          tx.set(['view', 'graphs', graphId, 'selectors', id], { position: { x: pos.x, y: pos.y } })
        }
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setGroupBounds {graphId, groupId, bounds}  (resize)
// ---------------------------------------------------------------------------

const viewSetGroupBounds: CommandDefinition = {
  id: 'view.setGroupBounds',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.groupId !== 'string' || !isBounds(params.bounds))
      return [err('params.invalid', 'view.setGroupBounds: params must be {graphId, groupId, bounds}')]
    if (params.bounds.width <= 0 || params.bounds.height <= 0)
      return [err('params.invalid', 'view.setGroupBounds: bounds must have positive width and height')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setGroupBounds: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    if (!groupOf(doc, graphId, params.groupId))
      return [err('group.missing', `view.setGroupBounds: unknown group '${params.groupId}'`)]
    tx.set(['view', 'graphs', graphId, 'groups', params.groupId, 'bounds'], { ...params.bounds })
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setGroupTitle {graphId, groupId, title}
// ---------------------------------------------------------------------------

const viewSetGroupTitle: CommandDefinition = {
  id: 'view.setGroupTitle',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.groupId !== 'string' || typeof params.title !== 'string')
      return [err('params.invalid', 'view.setGroupTitle: params must be {graphId, groupId, title}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setGroupTitle: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    if (!groupOf(doc, graphId, params.groupId))
      return [err('group.missing', `view.setGroupTitle: unknown group '${params.groupId}'`)]
    tx.set(['view', 'graphs', graphId, 'groups', params.groupId, 'title'], params.title)
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setGroupColor {graphId, groupId, color: string | null}
// ---------------------------------------------------------------------------

const viewSetGroupColor: CommandDefinition = {
  id: 'view.setGroupColor',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.groupId !== 'string' ||
      (typeof params.color !== 'string' && params.color !== null)
    )
      return [err('params.invalid', 'view.setGroupColor: params must be {graphId, groupId, color: string|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.setGroupColor: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const group = groupOf(doc, graphId, params.groupId)
    if (!group) return [err('group.missing', `view.setGroupColor: unknown group '${params.groupId}'`)]
    if (params.color === null) {
      if ('color' in group) tx.remove(['view', 'graphs', graphId, 'groups', params.groupId, 'color'])
      return []
    }
    tx.set(['view', 'graphs', graphId, 'groups', params.groupId, 'color'], params.color)
    return []
  },
}

// ---------------------------------------------------------------------------
// view.removeGroup {graphId, groupId}  (nodes are untouched: no membership)
// ---------------------------------------------------------------------------

const viewRemoveGroup: CommandDefinition = {
  id: 'view.removeGroup',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.groupId !== 'string')
      return [err('params.invalid', 'view.removeGroup: params must be {graphId, groupId}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `view.removeGroup: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    if (!groupOf(doc, graphId, params.groupId))
      return [err('group.missing', `view.removeGroup: unknown group '${params.groupId}'`)]
    // FR1: persist the allocation high-water BEFORE removing - in a
    // pre-cursor document the removed key may be the only allocation
    // evidence, and without this a later create would remint its id onto
    // an unrelated group (silently retargeting any surface binding that
    // still names it). groupAllocationFloor is the ONE parser of grpN
    // evidence (the removed key is still live here, so it contributes);
    // a non-canonical key like 'grp00' contributes nothing - it can never
    // collide with a minted id.
    const floor = groupAllocationFloor(doc, graphId)
    const cur = doc.view.graphs[graphId]?.groupSeq
    if (floor > 0 && floor !== cur) tx.set(['view', 'graphs', graphId, 'groupSeq'], floor)
    tx.remove(['view', 'graphs', graphId, 'groups', params.groupId])
    return []
  },
}

// ---------------------------------------------------------------------------
// view.setBookmark {slot, graphStack, instancePath, view|viewport}
//
// RTS-style numbered camera shortcut. The whole navigation context is
// validated against the CURRENT document at save time: the stack must start
// at the root, every definition must exist, and each instancePath step must
// be a node of the enclosing graph instantiating the next definition - so a
// stored bookmark is coherent at birth. (Later edits can still orphan it;
// jump-time revalidation is the consumer's job.) Pure view state.
// ---------------------------------------------------------------------------

const isBookmarkSlot = (v: Json | undefined): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10

const viewSetBookmark: CommandDefinition = {
  id: 'view.setBookmark',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      !isBookmarkSlot(params.slot) ||
      !Array.isArray(params.graphStack) ||
      !Array.isArray(params.instancePath)
    )
      return [err('params.invalid', 'view.setBookmark: params must be {slot: 1..10, graphStack, instancePath, view|viewport}')]
    const rawView = params.view
    const rawViewport = params.viewport
    if ((rawView !== undefined) === (rawViewport !== undefined))
      return [err('params.invalid', 'view.setBookmark: exactly one of view or legacy viewport is required')]
    let camera: JsonObject
    if (rawView !== undefined) {
      if (!isObj(rawView) ||
        typeof rawView.x !== 'number' ||
        typeof rawView.y !== 'number' ||
        typeof rawView.width !== 'number' ||
        typeof rawView.height !== 'number' ||
        !Number.isFinite(rawView.x) ||
        !Number.isFinite(rawView.y) ||
        !Number.isFinite(rawView.width) ||
        !Number.isFinite(rawView.height) ||
        rawView.width <= 0 ||
        rawView.height <= 0
      ) return [err('params.invalid', 'view.setBookmark: view must be {x, y, width > 0, height > 0}')]
      camera = { view: { x: rawView.x, y: rawView.y, width: rawView.width, height: rawView.height } }
    } else {
      if (!isObj(rawViewport) ||
        typeof rawViewport.x !== 'number' ||
        typeof rawViewport.y !== 'number' ||
        typeof rawViewport.scale !== 'number' ||
        !Number.isFinite(rawViewport.x) ||
        !Number.isFinite(rawViewport.y) ||
        !Number.isFinite(rawViewport.scale) ||
        rawViewport.scale <= 0
      ) return [err('params.invalid', 'view.setBookmark: viewport must be {x, y, scale > 0}')]
      camera = { viewport: { x: rawViewport.x, y: rawViewport.y, scale: rawViewport.scale } }
    }
    const stack = params.graphStack
    const path = params.instancePath
    if (stack.length < 1 || stack.some((g) => typeof g !== 'string'))
      return [err('params.invalid', 'view.setBookmark: graphStack must be a nonempty string array')]
    if (path.length !== stack.length - 1 || path.some((n) => typeof n !== 'string'))
      return [err('params.invalid', 'view.setBookmark: instancePath must have one entry per graphStack step beyond the root')]
    if (stack[0] !== doc.root)
      return [err('bookmark.invalid', `view.setBookmark: graphStack must start at the root '${doc.root}'`)]
    for (let i = 0; i < stack.length; i++) {
      const gid = stack[i] as string
      const def = doc.graphs[gid]
      if (!def) return [err('graph.missing', `view.setBookmark: unknown graph '${gid}'`)]
      if (i < path.length) {
        const nodeId = path[i] as string
        const node = def.nodes[nodeId]
        if (!node)
          return [err('bookmark.invalid', `view.setBookmark: instancePath node '${nodeId}' not in graph '${gid}'`)]
        if (subgraphDefIdOf(node.type) !== stack[i + 1])
          return [
            err('bookmark.invalid', `view.setBookmark: node '${nodeId}' does not instantiate '${String(stack[i + 1])}'`),
          ]
      }
    }
    if (!tx.current.view.bookmarks) tx.set(['view', 'bookmarks'], {})
    tx.set(['view', 'bookmarks', String(params.slot)], {
      graphStack: [...stack],
      instancePath: [...path],
      ...camera,
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// view.clearBookmark {slot}
// ---------------------------------------------------------------------------

const viewClearBookmark: CommandDefinition = {
  id: 'view.clearBookmark',
  run(doc, params, tx) {
    if (!isObj(params) || !isBookmarkSlot(params.slot))
      return [err('params.invalid', 'view.clearBookmark: params must be {slot: 1..10}')]
    if (!doc.view.bookmarks?.[String(params.slot)])
      return [err('bookmark.missing', `view.clearBookmark: no bookmark in slot ${params.slot}`)]
    tx.remove(['view', 'bookmarks', String(params.slot)])
    return []
  },
}

// ---------------------------------------------------------------------------
// Reroutes: structural junction vertices (topology in graphs[*].reroutes,
// geometry in view.graphs[*].reroutes). All edits are atomic transactions.
// ---------------------------------------------------------------------------

/** Ensure view.graphs[graphId].reroutes exists before writing under it. */
function ensureViewReroutes(tx: TransactionBuilder, graphId: string): void {
  const view = tx.current.view.graphs[graphId]
  if (!view) tx.set(['view', 'graphs', graphId], { nodes: {}, reroutes: {} })
  else if (!view.reroutes) tx.set(['view', 'graphs', graphId, 'reroutes'], {})
}

// ---------------------------------------------------------------------------
// reroute.add {graphId, position}  (free-floating; connect by dragging)
// ---------------------------------------------------------------------------

const rerouteAdd: CommandDefinition = {
  id: 'reroute.add',
  run(doc, params, tx) {
    if (!isObj(params) || !isVec2(params.position))
      return [err('params.invalid', 'reroute.add: params must be {graphId, position}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `reroute.add: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const id = allocateOne(tx, graphId, def, 'r')
    tx.set(['graphs', graphId, 'reroutes', id], { id })
    ensureViewReroutes(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'reroutes', id], {
      position: { x: params.position.x, y: params.position.y },
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// reroute.insert {graphId, linkId, position}
//
// Split an existing link at a point: ONE undo step for the "double-click a
// noodle" gesture. The original link is replaced by upstream -> reroute ->
// downstream; the original ext rides the downstream (consumer-side) segment.
// Works on any link, including segments between reroutes (chains).
// ---------------------------------------------------------------------------

const rerouteInsert: CommandDefinition = {
  id: 'reroute.insert',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.linkId !== 'string' || !isVec2(params.position))
      return [err('params.invalid', 'reroute.insert: params must be {graphId, linkId, position}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `reroute.insert: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const link = def.links[params.linkId]
    if (!link) return [err('link.missing', `reroute.insert: unknown link '${params.linkId}'`)]

    const alloc = graphAllocator(tx, graphId, def)
    const rerouteId = alloc.mint('r')
    const upId = alloc.mint('l')
    const downId = alloc.mint('l')
    alloc.commit()
    removeDefinitionLink(graphId, params.linkId, tx)
    tx.set(['graphs', graphId, 'reroutes', rerouteId], { id: rerouteId })
    tx.set(['graphs', graphId, 'links', upId], {
      id: upId,
      from: link.from,
      to: { reroute: rerouteId },
    } as unknown as Json)
    tx.set(['graphs', graphId, 'links', downId], {
      id: downId,
      from: { reroute: rerouteId },
      to: link.to,
      ...(link.ext ? { ext: link.ext } : {}),
    } as unknown as Json)
    ensureViewReroutes(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'reroutes', rerouteId], {
      position: { x: params.position.x, y: params.position.y },
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// reroute.move {graphId, positions: {rerouteId: {x,y}}}  (one undo step per drag)
// ---------------------------------------------------------------------------

const rerouteMove: CommandDefinition = {
  id: 'reroute.move',
  run(doc, params, tx) {
    if (!isObj(params) || !isObj(params.positions))
      return [err('params.invalid', 'reroute.move: params must be {graphId, positions}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `reroute.move: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    ensureViewReroutes(tx, graphId)
    for (const [rerouteId, pos] of Object.entries(params.positions)) {
      if (!def.reroutes[rerouteId])
        return [err('reroute.missing', `reroute.move: unknown reroute '${rerouteId}'`)]
      if (!isVec2(pos)) return [err('params.invalid', `reroute.move: position for '${rerouteId}' must be {x,y}`)]
      const existing = tx.current.view.graphs[graphId]?.reroutes?.[rerouteId]
      if (existing) {
        tx.set(['view', 'graphs', graphId, 'reroutes', rerouteId, 'position'], { x: pos.x, y: pos.y })
      } else {
        tx.set(['view', 'graphs', graphId, 'reroutes', rerouteId], { position: { x: pos.x, y: pos.y } })
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// reroute.remove {graphId, rerouteIds[], reconnect? = true}
//
// Dissolve reroutes. With reconnect, every surviving consumer of a removed
// reroute is re-linked straight to the chain's surviving source (contracting
// the removed span), so deleting a junction never silently unwires the graph.
// With reconnect: false it behaves like graph.deleteItems.
// ---------------------------------------------------------------------------

const rerouteRemove: CommandDefinition = {
  id: 'reroute.remove',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.rerouteIds))
      return [err('params.invalid', 'reroute.remove: params must be {graphId, rerouteIds[], reconnect?}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `reroute.remove: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const ids = params.rerouteIds.filter((r): r is string => typeof r === 'string')
    const missing = ids.filter((id) => !def.reroutes[id])
    if (missing.length > 0)
      return [err('reroute.missing', `reroute.remove: unknown reroute(s) ${missing.join(', ')}`)]
    if (occurrenceDeletionConflict(doc, graphId, new Set(), new Set(ids)))
      return [err('occurrence.topology.definitionReferenced', 'reroute.remove: an occurrence-local link references a selected reroute')]
    const reconnect = params.reconnect !== false
    const removed = new Set(ids)
    const inRemoved = (e: LinkEndpoint): boolean => isRerouteRef(e) && removed.has(e.reroute)
    const rerouteIndex = buildRerouteIndex(def)

    // Trace upstream from a removed reroute to the first surviving endpoint.
    const survivingSource = (rerouteId: string): LinkEndpoint | undefined => {
      let current = rerouteId
      const visited = new Set<string>()
      for (;;) {
        if (visited.has(current)) return undefined // cycle inside removed set
        visited.add(current)
        const driver = rerouteDriverOf(def, current, rerouteIndex)
        if (!driver) return undefined // undriven chain
        if (!inRemoved(driver.from)) return driver.from
        current = (driver.from as { reroute: string }).reroute
      }
    }

    const alloc = graphAllocator(tx, graphId, def)
    for (const [linkId, link] of Object.entries(def.links)) {
      const fromRemoved = inRemoved(link.from)
      const toRemoved = inRemoved(link.to)
      if (!fromRemoved && !toRemoved) continue
      removeDefinitionLink(graphId, linkId, tx)
      if (reconnect && fromRemoved && !toRemoved) {
        const source = survivingSource((link.from as { reroute: string }).reroute)
        if (source) {
          const newId = alloc.mint('l')
          tx.set(['graphs', graphId, 'links', newId], {
            id: newId,
            from: source,
            to: link.to,
            ...(link.ext ? { ext: link.ext } : {}),
          } as unknown as Json)
        }
      }
    }
    alloc.commit()
    for (const id of ids) {
      tx.remove(['graphs', graphId, 'reroutes', id])
      if (doc.view.graphs[graphId]?.reroutes?.[id]) {
        tx.remove(['view', 'graphs', graphId, 'reroutes', id])
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// Value sources (architecture 5b, hazards P1-P5). Semantics: value + optional
// DECLARED partial spec + controller state live in the def; geometry in view
// state. The effective spec is always derived (value-source.ts), never stored
// or written by any command here (P1). No command ever resets the stored
// value as a consequence of spec/connection changes (P2).
// ---------------------------------------------------------------------------

function ensureViewValueSources(tx: TransactionBuilder, graphId: string): void {
  const view = tx.current.view.graphs[graphId]
  if (!view) tx.set(['view', 'graphs', graphId], { nodes: {}, valueSources: {} })
  else if (!view.valueSources) tx.set(['view', 'graphs', graphId, 'valueSources'], {})
}

/** GraphDef.valueSources is optional; materialize the container before setting into it. */
function ensureDefValueSources(tx: TransactionBuilder, graphId: string): void {
  if (!tx.current.graphs[graphId]?.valueSources) tx.set(['graphs', graphId, 'valueSources'], {})
}

const VS_CONTROLLER_MODES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const VS_CONTROLLER_SLOTS = new Set(['after_generate', 'after_refresh'])

/** Validate a DeclaredSpec params object; returns an error diagnostic or undefined. */
function declaredSpecError(v: JsonObject, what: string): Diagnostic | undefined {
  if (v.widgetType !== undefined && typeof v.widgetType !== 'string')
    return err('params.invalid', `${what}: spec.widgetType must be a string`)
  if (v.options !== undefined && !isObj(v.options))
    return err('params.invalid', `${what}: spec.options must be an object`)
  if (v.controller !== undefined && (typeof v.controller !== 'string' || !VS_CONTROLLER_SLOTS.has(v.controller)))
    return err('params.invalid', `${what}: spec.controller must be one of ${[...VS_CONTROLLER_SLOTS].join('|')}`)
  return undefined
}

/** The DeclaredSpec subset of a params object (drops stray fields). */
function toDeclaredSpec(v: JsonObject): JsonObject {
  return {
    ...(typeof v.widgetType === 'string' ? { widgetType: v.widgetType } : {}),
    ...(isObj(v.options) ? { options: v.options } : {}),
    ...(typeof v.controller === 'string' ? { controller: v.controller } : {}),
  }
}

// ---------------------------------------------------------------------------
// valueSource.add {graphId, position, value, spec?, title?}
// (`value` is required but may be null; connect by dragging, like reroutes)
// ---------------------------------------------------------------------------

const valueSourceAdd: CommandDefinition = {
  id: 'valueSource.add',
  run(doc, params, tx) {
    if (!isObj(params) || !isVec2(params.position) || params.value === undefined)
      return [err('params.invalid', 'valueSource.add: params must be {graphId, position, value, spec?, title?}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.add: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    if (params.spec !== undefined) {
      if (!isObj(params.spec)) return [err('params.invalid', 'valueSource.add: spec must be an object')]
      const specErr = declaredSpecError(params.spec, 'valueSource.add')
      if (specErr) return [specErr]
    }
    if (params.title !== undefined && typeof params.title !== 'string')
      return [err('params.invalid', 'valueSource.add: title must be a string')]
    const id = allocateOne(tx, graphId, def, 'v')
    ensureDefValueSources(tx, graphId)
    tx.set(['graphs', graphId, 'valueSources', id], {
      id,
      value: params.value,
      ...(isObj(params.spec) ? { spec: toDeclaredSpec(params.spec) } : {}),
      ...(typeof params.title === 'string' ? { title: params.title } : {}),
    })
    ensureViewValueSources(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'valueSources', id], {
      position: { x: params.position.x, y: params.position.y },
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// valueSource.remove {graphId, valueSourceIds[]}
// Plain deletion: outgoing links drop with the source (reroute chains they
// fed simply become undriven - legal, like disconnecting any driver).
// ---------------------------------------------------------------------------

const valueSourceRemove: CommandDefinition = {
  id: 'valueSource.remove',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.valueSourceIds))
      return [err('params.invalid', 'valueSource.remove: params must be {graphId, valueSourceIds[]}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.remove: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const ids = params.valueSourceIds.filter((v): v is string => typeof v === 'string')
    const missing = ids.filter((id) => !def.valueSources?.[id])
    if (missing.length > 0)
      return [err('valueSource.missing', `valueSource.remove: unknown value source(s) ${missing.join(', ')}`)]
    if (occurrenceDeletionConflict(doc, graphId, new Set(), new Set(), new Set(ids)))
      return [err('occurrence.topology.definitionReferenced', 'valueSource.remove: an occurrence-local link references a selected value source')]
    deleteCascade(doc, def, graphId, [], [], [], [], ids, [], tx)
    return []
  },
}

// ---------------------------------------------------------------------------
// valueSource.move {graphId, positions: {valueSourceId: {x,y}}}
// ---------------------------------------------------------------------------

const valueSourceMove: CommandDefinition = {
  id: 'valueSource.move',
  run(doc, params, tx) {
    if (!isObj(params) || !isObj(params.positions))
      return [err('params.invalid', 'valueSource.move: params must be {graphId, positions}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.move: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    ensureViewValueSources(tx, graphId)
    for (const [vsId, pos] of Object.entries(params.positions)) {
      if (!def.valueSources?.[vsId])
        return [err('valueSource.missing', `valueSource.move: unknown value source '${vsId}'`)]
      if (!isVec2(pos)) return [err('params.invalid', `valueSource.move: position for '${vsId}' must be {x,y}`)]
      const existing = tx.current.view.graphs[graphId]?.valueSources?.[vsId]
      if (existing) {
        tx.set(['view', 'graphs', graphId, 'valueSources', vsId, 'position'], { x: pos.x, y: pos.y })
      } else {
        tx.set(['view', 'graphs', graphId, 'valueSources', vsId], { position: { x: pos.x, y: pos.y } })
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// valueSource.setValue {graphId, valueSourceId, value}
// ---------------------------------------------------------------------------

const valueSourceSetValue: CommandDefinition = {
  id: 'valueSource.setValue',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.valueSourceId !== 'string' || params.value === undefined)
      return [err('params.invalid', 'valueSource.setValue: params must be {graphId, valueSourceId, value}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.setValue: unknown graph '${String(params.graphId)}'`)]
    if (!def.valueSources?.[params.valueSourceId])
      return [err('valueSource.missing', `valueSource.setValue: unknown value source '${params.valueSourceId}'`)]
    tx.set(['graphs', params.graphId as string, 'valueSources', params.valueSourceId, 'value'], params.value)
    return []
  },
}

// ---------------------------------------------------------------------------
// valueSource.setSpec {graphId, valueSourceId, spec: DeclaredSpec | null}
// Replaces the declared spec wholesale (null clears it back to fully
// derived). "Pin current spec" is this command fed with pinnedSpecOf(...).
// Never touches the stored value (P2).
// ---------------------------------------------------------------------------

const valueSourceSetSpec: CommandDefinition = {
  id: 'valueSource.setSpec',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.valueSourceId !== 'string' || params.spec === undefined)
      return [err('params.invalid', 'valueSource.setSpec: params must be {graphId, valueSourceId, spec|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.setSpec: unknown graph '${String(params.graphId)}'`)]
    if (!def.valueSources?.[params.valueSourceId])
      return [err('valueSource.missing', `valueSource.setSpec: unknown value source '${params.valueSourceId}'`)]
    const path = ['graphs', params.graphId as string, 'valueSources', params.valueSourceId, 'spec']
    if (params.spec === null) {
      tx.remove(path)
      return []
    }
    if (!isObj(params.spec)) return [err('params.invalid', 'valueSource.setSpec: spec must be an object or null')]
    const specErr = declaredSpecError(params.spec, 'valueSource.setSpec')
    if (specErr) return [specErr]
    tx.set(path, toDeclaredSpec(params.spec))
    return []
  },
}

// ---------------------------------------------------------------------------
// valueSource.setController {graphId, valueSourceId, mode: ControllerMode | null}
// ---------------------------------------------------------------------------

const valueSourceSetController: CommandDefinition = {
  id: 'valueSource.setController',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.valueSourceId !== 'string' || params.mode === undefined)
      return [err('params.invalid', 'valueSource.setController: params must be {graphId, valueSourceId, mode|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.setController: unknown graph '${String(params.graphId)}'`)]
    if (!def.valueSources?.[params.valueSourceId])
      return [err('valueSource.missing', `valueSource.setController: unknown value source '${params.valueSourceId}'`)]
    const path = ['graphs', params.graphId as string, 'valueSources', params.valueSourceId, 'controller']
    if (params.mode === null) {
      tx.remove(path)
      return []
    }
    if (typeof params.mode !== 'string' || !VS_CONTROLLER_MODES.has(params.mode))
      return [err('params.invalid', `valueSource.setController: mode must be one of ${[...VS_CONTROLLER_MODES].join('|')} or null`)]
    tx.set(path, params.mode)
    return []
  },
}

// ---------------------------------------------------------------------------
// valueSource.setTitle {graphId, valueSourceId, title}
// ---------------------------------------------------------------------------

const valueSourceSetTitle: CommandDefinition = {
  id: 'valueSource.setTitle',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.valueSourceId !== 'string' || typeof params.title !== 'string')
      return [err('params.invalid', 'valueSource.setTitle: params must be {graphId, valueSourceId, title}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `valueSource.setTitle: unknown graph '${String(params.graphId)}'`)]
    if (!def.valueSources?.[params.valueSourceId])
      return [err('valueSource.missing', `valueSource.setTitle: unknown value source '${params.valueSourceId}'`)]
    tx.set(['graphs', params.graphId as string, 'valueSources', params.valueSourceId, 'title'], params.title)
    return []
  },
}

// ---------------------------------------------------------------------------
// Selectors (architecture: structural N-to-1 branch junctions). Semantics
// (candidates, policy, titles) live in the def; geometry in view state. IDs
// come from the graph's monotonic cursor: selectors are 's<n>', candidates
// 'c<n>' - globally unique within the def, never reused, stable across
// reorder. All invariants (I11) hold atomically per command.
// ---------------------------------------------------------------------------

function ensureViewSelectors(tx: TransactionBuilder, graphId: string): void {
  const view = tx.current.view.graphs[graphId]
  if (!view) tx.set(['view', 'graphs', graphId], { nodes: {}, selectors: {} })
  else if (!view.selectors) tx.set(['view', 'graphs', graphId, 'selectors'], {})
}

/** GraphDef.selectors is optional; materialize the container before setting into it. */
function ensureDefSelectors(tx: TransactionBuilder, graphId: string): void {
  if (!tx.current.graphs[graphId]?.selectors) tx.set(['graphs', graphId, 'selectors'], {})
}

/** Validate a selector policy params object against a candidate list. */
function selectorPolicyError(
  policy: Json | undefined,
  candidates: readonly { readonly id: string }[],
  what: string,
): Diagnostic | undefined {
  if (!isObj(policy)) return err('params.invalid', `${what}: policy must be {kind:'fixed', candidate} or {kind:'random'}`)
  if (policy.kind === 'random') return undefined
  if (policy.kind === 'fixed') {
    if (typeof policy.candidate !== 'string')
      return err('params.invalid', `${what}: fixed policy must name a candidate`)
    if (!candidates.some((c) => c.id === policy.candidate))
      return err('selector.candidateMissing', `${what}: no candidate '${policy.candidate}'`)
    return undefined
  }
  return err('params.invalid', `${what}: policy kind must be 'fixed' or 'random'`)
}

// ---------------------------------------------------------------------------
// selector.add {graphId, position, candidates?: count, title?}
// Creates with `candidates` empty branches (default 2, min 1) and a fixed
// policy on the first - a selector is never candidate-less. Connect branches
// by dragging, like reroutes.
// ---------------------------------------------------------------------------

const MAX_SELECTOR_CANDIDATES = 64

const selectorAdd: CommandDefinition = {
  id: 'selector.add',
  run(doc, params, tx) {
    if (!isObj(params) || !isVec2(params.position))
      return [err('params.invalid', 'selector.add: params must be {graphId, position, candidates?, title?}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.add: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const count = params.candidates === undefined ? 2 : params.candidates
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_SELECTOR_CANDIDATES)
      return [err('params.invalid', `selector.add: candidates must be an integer in [1, ${MAX_SELECTOR_CANDIDATES}]`)]
    if (params.title !== undefined && typeof params.title !== 'string')
      return [err('params.invalid', 'selector.add: title must be a string')]
    const alloc = graphAllocator(tx, graphId, def)
    const id = alloc.mint('s')
    const candidates = Array.from({ length: count }, () => ({ id: alloc.mint('c') }))
    alloc.commit()
    ensureDefSelectors(tx, graphId)
    tx.set(['graphs', graphId, 'selectors', id], {
      id,
      candidates,
      policy: { kind: 'fixed', candidate: candidates[0]!.id },
      ...(typeof params.title === 'string' ? { title: params.title } : {}),
    } as unknown as Json)
    ensureViewSelectors(tx, graphId)
    tx.set(['view', 'graphs', graphId, 'selectors', id], {
      position: { x: params.position.x, y: params.position.y },
    })
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.remove {graphId, selectorIds[]}
// Cascades every link touching the selector (candidate feeds AND output
// fan-out) plus its view state, exactly like graph.deleteItems.
// ---------------------------------------------------------------------------

const selectorRemove: CommandDefinition = {
  id: 'selector.remove',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.selectorIds))
      return [err('params.invalid', 'selector.remove: params must be {graphId, selectorIds[]}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.remove: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    const ids = params.selectorIds.filter((v): v is string => typeof v === 'string')
    const missing = ids.filter((id) => !def.selectors?.[id])
    if (missing.length > 0)
      return [err('selector.missing', `selector.remove: unknown selector(s) ${missing.join(', ')}`)]
    if (occurrenceDeletionConflict(doc, graphId, new Set(), new Set(), new Set(), new Set(ids)))
      return [err('occurrence.topology.definitionReferenced', 'selector.remove: an occurrence-local link references a selected selector')]
    deleteCascade(doc, def, graphId, [], [], [], [], [], ids, tx)
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.setPolicy {graphId, selectorId, policy}
// ---------------------------------------------------------------------------

const selectorSetPolicy: CommandDefinition = {
  id: 'selector.setPolicy',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.selectorId !== 'string')
      return [err('params.invalid', 'selector.setPolicy: params must be {graphId, selectorId, policy}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.setPolicy: unknown graph '${String(params.graphId)}'`)]
    const sel = def.selectors?.[params.selectorId]
    if (!sel) return [err('selector.missing', `selector.setPolicy: unknown selector '${params.selectorId}'`)]
    const policyErr = selectorPolicyError(params.policy, sel.candidates, 'selector.setPolicy')
    if (policyErr) return [policyErr]
    const policy = params.policy as JsonObject
    tx.set(
      ['graphs', params.graphId as string, 'selectors', params.selectorId, 'policy'],
      policy.kind === 'random' ? { kind: 'random' } : { kind: 'fixed', candidate: policy.candidate as string },
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.addCandidate {graphId, selectorId, title?}
// Appends one empty branch (id from the graph cursor - stable forever).
// ---------------------------------------------------------------------------

const selectorAddCandidate: CommandDefinition = {
  id: 'selector.addCandidate',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.selectorId !== 'string')
      return [err('params.invalid', 'selector.addCandidate: params must be {graphId, selectorId, title?}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.addCandidate: unknown graph '${String(params.graphId)}'`)]
    const sel = def.selectors?.[params.selectorId]
    if (!sel) return [err('selector.missing', `selector.addCandidate: unknown selector '${params.selectorId}'`)]
    if (sel.candidates.length >= MAX_SELECTOR_CANDIDATES)
      return [err('selector.candidateLimit', `selector.addCandidate: selector already has ${MAX_SELECTOR_CANDIDATES} candidates`)]
    if (params.title !== undefined && typeof params.title !== 'string')
      return [err('params.invalid', 'selector.addCandidate: title must be a string')]
    const graphId = params.graphId as string
    const id = allocateOne(tx, graphId, def, 'c')
    tx.set(
      ['graphs', graphId, 'selectors', params.selectorId, 'candidates'],
      [...sel.candidates, { id, ...(typeof params.title === 'string' ? { title: params.title } : {}) }] as unknown as Json,
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.removeCandidate {graphId, selectorId, candidateId}
// One transaction: drops the candidate, cascades its incoming link, and
// repairs a fixed policy pointing at it (repoint to the first remaining
// candidate - deterministic, never silent-random). The LAST candidate cannot
// be removed: a selector is never candidate-less (delete the selector).
// ---------------------------------------------------------------------------

const selectorRemoveCandidate: CommandDefinition = {
  id: 'selector.removeCandidate',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.selectorId !== 'string' || typeof params.candidateId !== 'string')
      return [err('params.invalid', 'selector.removeCandidate: params must be {graphId, selectorId, candidateId}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.removeCandidate: unknown graph '${String(params.graphId)}'`)]
    const sel = def.selectors?.[params.selectorId]
    if (!sel) return [err('selector.missing', `selector.removeCandidate: unknown selector '${params.selectorId}'`)]
    if (!sel.candidates.some((c) => c.id === params.candidateId))
      return [err('selector.candidateMissing', `selector.removeCandidate: no candidate '${params.candidateId}'`)]
    if (sel.candidates.length === 1)
      return [err('selector.lastCandidate', 'selector.removeCandidate: cannot remove the last candidate (remove the selector instead)')]
    const graphId = params.graphId as string
    const kept = sel.candidates.filter((c) => c.id !== params.candidateId)
    tx.set(['graphs', graphId, 'selectors', params.selectorId, 'candidates'], kept as unknown as Json)
    if (sel.policy.kind === 'fixed' && sel.policy.candidate === params.candidateId) {
      tx.set(['graphs', graphId, 'selectors', params.selectorId, 'policy'], { kind: 'fixed', candidate: kept[0]!.id })
    }
    for (const [linkId, link] of Object.entries(def.links)) {
      if (isSelectorRef(link.to) && link.to.selector === params.selectorId && link.to.candidate === params.candidateId) {
        removeDefinitionLink(graphId, linkId, tx)
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.reorderCandidates {graphId, selectorId, order: candidateIds[]}
// `order` must be a permutation of the current ids. Order is semantic (it is
// the random-resolution domain and the display order); ids stay stable.
// ---------------------------------------------------------------------------

const selectorReorderCandidates: CommandDefinition = {
  id: 'selector.reorderCandidates',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.selectorId !== 'string' || !Array.isArray(params.order))
      return [err('params.invalid', 'selector.reorderCandidates: params must be {graphId, selectorId, order[]}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.reorderCandidates: unknown graph '${String(params.graphId)}'`)]
    const sel = def.selectors?.[params.selectorId]
    if (!sel) return [err('selector.missing', `selector.reorderCandidates: unknown selector '${params.selectorId}'`)]
    const order = params.order.filter((v): v is string => typeof v === 'string')
    const current = new Set<string>(sel.candidates.map((c) => c.id))
    if (order.length !== sel.candidates.length || new Set(order).size !== order.length || !order.every((id) => current.has(id)))
      return [err('params.invalid', 'selector.reorderCandidates: order must be a permutation of the current candidate ids')]
    const byId = new Map<string, (typeof sel.candidates)[number]>(sel.candidates.map((c) => [c.id, c]))
    tx.set(
      ['graphs', params.graphId as string, 'selectors', params.selectorId, 'candidates'],
      order.map((id) => byId.get(id)!) as unknown as Json,
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.setCandidateTitle {graphId, selectorId, candidateId, title}
// ---------------------------------------------------------------------------

const selectorSetCandidateTitle: CommandDefinition = {
  id: 'selector.setCandidateTitle',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.selectorId !== 'string' || typeof params.candidateId !== 'string' || typeof params.title !== 'string')
      return [err('params.invalid', 'selector.setCandidateTitle: params must be {graphId, selectorId, candidateId, title}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.setCandidateTitle: unknown graph '${String(params.graphId)}'`)]
    const sel = def.selectors?.[params.selectorId]
    if (!sel) return [err('selector.missing', `selector.setCandidateTitle: unknown selector '${params.selectorId}'`)]
    const idx = sel.candidates.findIndex((c) => c.id === params.candidateId)
    if (idx < 0)
      return [err('selector.candidateMissing', `selector.setCandidateTitle: no candidate '${params.candidateId}'`)]
    tx.set(
      ['graphs', params.graphId as string, 'selectors', params.selectorId, 'candidates'],
      sel.candidates.map((c) => (c.id === params.candidateId ? { ...c, title: params.title as string } : c)) as unknown as Json,
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.setTitle {graphId, selectorId, title}
// ---------------------------------------------------------------------------

const selectorSetTitle: CommandDefinition = {
  id: 'selector.setTitle',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.selectorId !== 'string' || typeof params.title !== 'string')
      return [err('params.invalid', 'selector.setTitle: params must be {graphId, selectorId, title}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.setTitle: unknown graph '${String(params.graphId)}'`)]
    if (!def.selectors?.[params.selectorId])
      return [err('selector.missing', `selector.setTitle: unknown selector '${params.selectorId}'`)]
    tx.set(['graphs', params.graphId as string, 'selectors', params.selectorId, 'title'], params.title)
    return []
  },
}

// ---------------------------------------------------------------------------
// selector.move {graphId, positions: {selectorId: {x,y}}}
// ---------------------------------------------------------------------------

const selectorMove: CommandDefinition = {
  id: 'selector.move',
  run(doc, params, tx) {
    if (!isObj(params) || !isObj(params.positions))
      return [err('params.invalid', 'selector.move: params must be {graphId, positions}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `selector.move: unknown graph '${String(params.graphId)}'`)]
    const graphId = params.graphId as string
    ensureViewSelectors(tx, graphId)
    for (const [selId, pos] of Object.entries(params.positions)) {
      if (!def.selectors?.[selId])
        return [err('selector.missing', `selector.move: unknown selector '${selId}'`)]
      if (!isVec2(pos)) return [err('params.invalid', `selector.move: position for '${selId}' must be {x,y}`)]
      const existing = tx.current.view.graphs[graphId]?.selectors?.[selId]
      if (existing) {
        tx.set(['view', 'graphs', graphId, 'selectors', selId, 'position'], { x: pos.x, y: pos.y })
      } else {
        tx.set(['view', 'graphs', graphId, 'selectors', selId], { position: { x: pos.x, y: pos.y } })
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CORE_COMMANDS: readonly CommandDefinition[] = [
  nodeAdd,
  regionSetPortRole,
  regionSetOutputRole,
  regionSetContinueOutput,
  regionSetBinding,
  regionSetMaxIterations,
  nodeRemove,
  graphDeleteItems,
  nodeMove,
  selectionMove,
  nodeSetValueOf(),
  imageApplyAssetOf(),
  imageApplyMaskPaintOf(),
  imageCompositorApplyOf(),
  imageDocumentExportOf(),
  imageDocumentRecipeExportOf(),
  nodeSetOutputCountOf(),
  textSplice,
  nodeSetControllerOf(),
  nodeSetValuesOf(),
  nodeSetMode,
  nodeSetPreviews,
  nodeSetMirrorPreviews,
  nodeSetTitle,
  workflowSetPreviews,
  linkConnect,
  linkRewire,
  linkRewireSource,
  linkDisconnect,
  rerouteAdd,
  rerouteInsert,
  rerouteMove,
  rerouteRemove,
  valueSourceAdd,
  valueSourceRemove,
  valueSourceMove,
  valueSourceSetValue,
  valueSourceSetSpec,
  valueSourceSetController,
  valueSourceSetTitle,
  selectorAdd,
  selectorRemove,
  selectorSetPolicy,
  selectorAddCandidate,
  selectorRemoveCandidate,
  selectorReorderCandidates,
  selectorSetCandidateTitle,
  selectorSetTitle,
  selectorMove,
  netCreate,
  netConnectInput,
  netSetSource,
  netRename,
  netRemove,
  netResetView,
  netDisconnectInput,
  viewMoveBoundaryNode,
  viewSetNetCollapsed,
  viewSetNetDisplay,
  viewSetAllNetsDisplay,
  viewSetNodeCollapsed,
  viewSetNodeSize,
  viewSetNodeColor,
  viewSetNodeVideo,
  viewSetWidgetRepresentation,
  viewSetSectionCollapsed,
  viewCreateGroup,
  viewMoveGroup,
  viewSetGroupBounds,
  viewSetGroupTitle,
  viewSetGroupColor,
  viewRemoveGroup,
  viewSetBookmark,
  viewClearBookmark,
  ...DYNAMIC_COMMANDS,
  ...BOUNDARY_COMMANDS,
  ...SUBGRAPH_COMMANDS,
  ...SURFACE_COMMANDS,
  ...REPLACE_COMMANDS,
  ...CLIPBOARD_COMMANDS,
  ...EXPOSED_COMMANDS,
  ...EXPOSED_PREVIEW_COMMANDS,
  ...APP_LAYOUT_COMMANDS,
  ...OCCURRENCE_LINK_COMMANDS,
]

// ---------------------------------------------------------------------------
// batch {invocations: [{command, params}...]}
//
// Runs sub-commands sequentially against ONE transaction, so a compound
// gesture (materialize a dynamic ghost + connect the link that caused it)
// commits atomically: one revision, one undo step, all-or-nothing when any
// sub-command errors or the invariant checker rejects the result. Plain
// data like every invocation - serializable across IPC and sync logs.
// Nested batches are rejected: composition happens at ONE level so a batch
// in a log is always a flat, bounded list of primitive commands.
// ---------------------------------------------------------------------------

function batchCommand(registry: ReadonlyMap<string, CommandDefinition>): CommandDefinition {
  return {
    id: 'batch',
    prepareForSharedReplay(doc, params, context, actor) {
      if (!isObj(params) || !Array.isArray(params.invocations)) return undefined
      const tx = createTransactionBuilder(doc, actor)
      const invocations: Json[] = []
      for (const invocation of params.invocations) {
        if (!isObj(invocation) || typeof invocation.command !== 'string') {
          return {
            ok: false,
            diagnostics: [err('params.invalid', 'batch: each invocation must be {command, params}')],
          }
        }
        if (invocation.command === 'batch') {
          return {
            ok: false,
            diagnostics: [err('batch.nested', 'batch: nested batches are not allowed')],
          }
        }
        const definition = registry.get(invocation.command)
        if (definition === undefined) {
          return {
            ok: false,
            diagnostics: [err('command.unknown', `batch: unknown command '${invocation.command}'`)],
          }
        }
        const prepared = definition.prepareForSharedReplay?.(
          tx.current,
          invocation.params as Json,
          context,
          actor,
        )
        if (prepared !== undefined && !prepared.ok) return prepared
        const effective = prepared === undefined ? invocation : { ...invocation, params: prepared.params }
        invocations.push(effective)
        const diagnostics = executeCommand(
          definition,
          tx.current,
          effective.params as Json,
          tx,
          context,
        )
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          return { ok: false, diagnostics }
        }
      }
      return { ok: true, params: { ...params, invocations } }
    },
    run(_doc, params, tx, context) {
      if (!isObj(params) || !Array.isArray(params.invocations) || params.invocations.length === 0)
        return [err('params.invalid', 'batch: params must be {invocations: [{command, params}, ...]}')]
      const collected: Diagnostic[] = []
      for (const inv of params.invocations) {
        if (!isObj(inv) || typeof inv.command !== 'string')
          return [err('params.invalid', 'batch: each invocation must be {command, params}')]
        if (inv.command === 'batch') return [err('batch.nested', 'batch: nested batches are not allowed')]
        const def = registry.get(inv.command)
        if (!def) return [err('command.unknown', `batch: unknown command '${inv.command}'`)]
        // Later sub-commands must see earlier writes: run against the
        // transaction's working copy, not the pre-batch document.
        const diags = executeCommand(def, tx.current, inv.params as Json, tx, context)
        collected.push(...diags)
        // Any error aborts the whole batch (dispatch rejects; nothing applies).
        if (diags.some((d) => d.severity === 'error')) return collected
      }
      return collected
    },
  }
}

export function coreCommandRegistry(
  extra: readonly CommandDefinition[] = [],
  resolve?: (type: string) => NodeSchema | undefined,
): ReadonlyMap<string, CommandDefinition> {
  const map = new Map<string, CommandDefinition>()
  for (const cmd of [
    ...CORE_COMMANDS.filter((candidate) =>
      candidate.id !== 'node.setController' &&
      candidate.id !== 'node.setOutputCount' &&
      candidate.id !== 'node.setValue' &&
      candidate.id !== 'node.setValues' &&
      candidate.id !== 'image.applyAsset' &&
      candidate.id !== 'image.applyMaskPaint' &&
      candidate.id !== 'image.compositorApply' &&
      candidate.id !== 'image.documentExport' &&
      candidate.id !== 'image.documentRecipeExport'),
    nodeSetControllerOf(resolve),
    nodeSetOutputCountOf(resolve),
    nodeSetValueOf(resolve),
    nodeSetValuesOf(resolve),
    imageApplyAssetOf(resolve),
    imageApplyMaskPaintOf(resolve),
    imageCompositorApplyOf(resolve),
    imageDocumentExportOf(resolve),
    imageDocumentRecipeExportOf(resolve),
    ...extra,
  ]) {
    if (map.has(cmd.id)) throw new Error(`duplicate command id '${cmd.id}'`)
    map.set(cmd.id, cmd)
  }
  map.set('batch', batchCommand(map))
  return map
}
