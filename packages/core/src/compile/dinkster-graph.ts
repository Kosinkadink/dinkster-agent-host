/**
 * Native Dinkster graph wire (POST /api/jobs `graph`) with first-class regions.
 *
 * Grounded in Dinkster source (commit 6822752 "M6: add explicit graph regions",
 * node-id grammar closed at 95106fd). This module is the ONE place the
 * native graph wire shape is understood on our side - the same quarantine
 * rule as schema/dinkster-wire.ts for the schema wire. It owns:
 *
 * - The wire TYPES: a graph is {nodes: {id: entry}} where an entry is either
 *   a plain node ({nodeType, inputs}) or a region ({region: {...}}) carrying
 *   kind (map|fold|while), ports (TypeExpr wire), elementPorts/statePorts,
 *   binding (zip default | cross | broadcast), outer inputs, a nested BODY graph
 *   (recursion point - regions nest arbitrarily), outputs (gather|state|flatten),
 *   maxIterations, and continueSource. Body links read region ports through
 *   the reserved pseudo-node '$region'.
 * - The TypeExpr ENCODER (inverse of typeExprFromDinksterWire): region port
 *   declarations put type expressions ON the wire, so lowering needs
 *   model -> wire, not just wire -> model.
 * - A structural VALIDATOR mirroring the backend's document-time region
 *   checks (dinkster_graph.validate), code-for-code, so a bad graph is caught
 *   and anchored client-side BEFORE submit instead of bouncing off the
 *   server. Frontend codes are namespaced per house style
 *   ('dinksterGraph.regionShape' here vs 'region-shape' from the server); the
 *   server-reject path (rejectionDiagnostics) keeps its 'validation.*'
 *   prefix - both carry the same data.nodeId nested-path anchor.
 *
 * The validator always checks wire structure. Compile may additionally pass
 * occurrence-local elaborated interface facts so it can mirror the backend's
 * runtime-resolvability, plain-literal, and selector-in-region admission rules
 * without resolving generic backend types from the wire or trusting value
 * stamps as producer types.
 *
 * Runtime iteration ids ('r[3]/node') and diagnostic body paths ('r/add')
 * are the OTHER side of this contract, owned by events/dinkster.ts
 * (parseDinksterRuntimePath); the '/'-joined paths this validator anchors with
 * parse mechanically there because '/', '[' and ']' are banned in node ids -
 * enforced by the backend at wire decode and mirrored here as
 * 'dinksterGraph.invalidNodeId'.
 */

import { diag, type Diagnostic, type DiagnosticAnchor } from '../diagnostics.js'
import type { Json } from '../format/document.js'
import type { PortRef } from '../ids.js'
import { canonicalTypeIdOf, parseAssetTypeId, parseListTypeId, parseStreamTypeId, type TypeExpr } from '../schema/model.js'
import { DINKSTER_SCHEMA_WIRE_VERSION, typeExprFromDinksterWire } from '../schema/dinkster-wire.js'
import { isCanonicalUnsafeInteger } from '../schema/numeric-step.js'

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Reserved body pseudo-node: body links read region ports through it. */
export const DINKSTER_REGION_PSEUDO_NODE = '$region'

/** Characters banned in document node ids at every nesting level (95106fd). */
export const DINKSTER_NODE_ID_FORBIDDEN = /[/[\]]/

/** A link input value: {$link: {node, output}} by OUTPUT ID. */
export interface DinksterLinkWire {
  readonly $link: { readonly node: string; readonly output: string }
}

/**
 * A typed-literal input value: {$typed: {type, value}} - the second reserved
 * input marker beside $link (Dinkster ea6eca7). The stamp names the concrete
 * runtime type id (same vocabulary workers wrap with: 'core.int',
 * 'list<core.int>', ...) the engine wraps "value" with, so a literal can
 * feed a destination whose declared type does not resolve to a runtime id.
 * EMISSION RULE (joint contract, pinned 6382cf1; AMENDED 2026-07-26 for
 * typed assets): emit into non-concrete destinations, AND into concrete
 * destinations exactly when the value's runtime type is an asset source
 * (asset<T> / list<asset<T>>) that DIFFERS from the declared type - the
 * stamp is what routes the literal through the backend's coercion planner
 * (decode/lift/merge) instead of wrapping refs raw as the declared type.
 * Plain literals stay canonical everywhere else, so a pre-form server
 * (which passes unknown marker dicts through as plain literals) can never
 * silently accept a stamp as a value; asset stamps only arise from v12+
 * schemas, which imply typed-literal support.
 * A type alias, not an interface: staged prompt values are Json, and only
 * object-literal aliases satisfy JsonObject's index signature.
 */
export type DinksterTypedLiteralWire = {
  readonly $typed: { readonly type: string; readonly value: Json }
}

/**
 * The stamped {type, value} when `v` is a typed-literal marker, else
 * undefined (the ONE parser, inverse of typedLiteralWire): re-lowering
 * paths (widget taps reading staged inputs) recover the value's true
 * runtime type from the stamp instead of double-wrapping.
 */
export const parseTypedLiteralWire = (v: Json): { readonly type: string; readonly value: Json } | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const t = (v as Record<string, unknown>)['$typed']
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return undefined
  const { type, value } = t as Record<string, unknown>
  return typeof type === 'string' && value !== undefined ? { type, value: value as Json } : undefined
}

/**
 * The /api/nodes dinkster.graphFeatures flag advertising typed-literal decode
 * support. Absent flag = the server does not decode $typed; HOLD the
 * lowering (feature detection is additive, no schema wire bump).
 */
export const DINKSTER_GRAPH_FEATURE_TYPED_LITERAL = 'typedLiteral'

/** The /api/nodes graph feature advertising lossless unsafe core.int literals. */
export const DINKSTER_GRAPH_FEATURE_DECIMAL_INT = 'decimalInt'

/** The /api/nodes graph feature advertising first-class region execution. */
export const DINKSTER_GRAPH_FEATURE_REGIONS = 'regions'

/** Build the canonical typed-literal marker (the ONE constructor). */
export const typedLiteralWire = (type: string, value: Json): DinksterTypedLiteralWire =>
  ({ $typed: { type, value } })

/** Lossless graph form for a core.int literal outside JavaScript's safe range. */
export type DinksterDecimalIntegerWire = {
  readonly $int: string
}

export const parseDecimalIntegerWire = (value: Json): string | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const object = value as Record<string, Json>
  const keys = Object.keys(object)
  return keys.length === 1 && keys[0] === '$int' && isCanonicalUnsafeInteger(object['$int'])
    ? object['$int'] as string
    : undefined
}

export const decimalIntegerWire = (value: string): DinksterDecimalIntegerWire => ({ $int: value })

/** An input value: a link, typed value, exact integer, or literal passed through verbatim. */
export type DinksterInputWire = DinksterLinkWire | DinksterTypedLiteralWire | DinksterDecimalIntegerWire | Json

export interface DinksterNodeEntryWire {
  readonly nodeType: string
  readonly inputs: Readonly<Record<string, DinksterInputWire>>
  readonly outputMembers?: Readonly<Record<string, readonly string[]>>
  /**
   * Stored DynamicCombo and DynamicSlot choices, sibling of inputs. Omitted
   * when empty; the backend elaborates the node's effective interface from
   * these choices alone (type-blind, deterministic).
   */
  readonly slotVariants?: Readonly<Record<string, string>>
}

export type DinksterRegionKind = 'map' | 'fold' | 'while'
export type DinksterRegionBinding = 'zip' | 'cross' | 'broadcast'
export type DinksterRegionOutputMode = 'gather' | 'compact' | 'state' | 'flatten'

export interface DinksterRegionOutputWire {
  readonly source: { readonly node: string; readonly output: string }
  /** Default 'gather' when omitted. */
  readonly mode?: DinksterRegionOutputMode
}

export interface DinksterRegionWire {
  readonly kind: DinksterRegionKind
  /** Port id -> TypeExpr wire (the same shape the schema wire uses). */
  readonly ports: Readonly<Record<string, Json>>
  /** Ports bound one element per iteration (outer side expects list<T>). Default []. */
  readonly elementPorts?: readonly string[]
  /** Ports chained iteration-to-iteration (fold/while). Default []. */
  readonly statePorts?: readonly string[]
  /** Element binding: zip, cross, or repeat-last broadcast. Omitted = 'zip'. */
  readonly binding?: DinksterRegionBinding
  /** Outer inputs, one per declared port: links or literals like node inputs. */
  readonly inputs: Readonly<Record<string, DinksterInputWire>>
  /** Nested body graph - the recursion point; bodies nest arbitrarily. */
  readonly body: DinksterGraphWire
  readonly outputs: Readonly<Record<string, DinksterRegionOutputWire>>
  /** Mandatory on while; caps binding count on map/fold. */
  readonly maxIterations?: number
  /** Body output that decides iteration N+1 (while only). */
  readonly continueSource?: { readonly node: string; readonly output: string }
}

export interface DinksterRegionEntryWire {
  readonly region: DinksterRegionWire
}

export type DinksterGraphEntryWire = DinksterNodeEntryWire | DinksterRegionEntryWire

export interface DinksterGraphWire {
  readonly nodes: Readonly<Record<string, DinksterGraphEntryWire>>
}

export const isDinksterRegionEntry = (e: DinksterGraphEntryWire): e is DinksterRegionEntryWire =>
  'region' in e

/** Narrow an input value to a link. The one place '$link' is sniffed. */
export const asDinksterLink = (v: DinksterInputWire): DinksterLinkWire['$link'] | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const link = (v as { $link?: unknown }).$link
  if (typeof link !== 'object' || link === null) return undefined
  const l = link as { node?: unknown; output?: unknown }
  return typeof l.node === 'string' && typeof l.output === 'string'
    ? { node: l.node, output: l.output }
    : undefined
}

// ---------------------------------------------------------------------------
// TypeExpr encoder (inverse of typeExprFromDinksterWire)
// ---------------------------------------------------------------------------

/**
 * Encode a model TypeExpr as its wire shape. Returns undefined for
 * expressions the wire cannot carry: the backend bans list type ids inside
 * union members and variable allowlists (atoms only - constructor smuggling
 * is rejected at construction), so those encode to nothing rather than to a
 * wire the server would reject.
 */
export function typeExprToDinksterWire(t: TypeExpr, wireVersion = DINKSTER_SCHEMA_WIRE_VERSION): Json | undefined {
  switch (t.kind) {
    case 'concrete':
      // One-representation invariant: a structured type is {kind:'list'} /
      // {kind:'asset'}, never a concrete named 'list<...>'/'asset<...>'.
      // Refuse to smuggle one onto the wire.
      return parseListTypeId(t.name) === undefined && parseAssetTypeId(t.name) === undefined && parseStreamTypeId(t.name) === undefined
        ? { kind: 'concrete', types: [t.name] }
        : undefined
    case 'union':
      return t.names.length >= 2 &&
        t.names.every((n) => parseListTypeId(n) === undefined && parseAssetTypeId(n) === undefined && parseStreamTypeId(n) === undefined)
        ? { kind: 'union', types: [...t.names] }
        : undefined
    case 'wildcard':
      return { kind: 'wildcard' }
    case 'variable': {
      if (t.templateId === '') return undefined
      if (t.allowedTypes === undefined || t.allowedTypes.length === 0)
        return { kind: 'variable', templateId: t.templateId }
      const names: string[] = []
      for (const allowed of t.allowedTypes) {
        const name = canonicalTypeIdOf(allowed)
        // Allowlist entries must be ATOMS: closed non-parametric concrete names.
        if (name === undefined || allowed.kind !== 'concrete' || parseListTypeId(name) !== undefined || parseAssetTypeId(name) !== undefined || parseStreamTypeId(name) !== undefined)
          return undefined
        names.push(name)
      }
      return { kind: 'variable', templateId: t.templateId, types: names }
    }
    case 'list':
    case 'asset':
    case 'stream': {
      if (t.kind === 'stream' && wireVersion < 41) return undefined
      const element = typeExprToDinksterWire(t.element, wireVersion)
      return element === undefined ? undefined : { kind: t.kind, element }
    }
  }
}

// ---------------------------------------------------------------------------
// Structural validator
// ---------------------------------------------------------------------------

const REGION_KINDS: ReadonlySet<string> = new Set(['map', 'fold', 'while'])
const OUTPUT_MODES: ReadonlySet<string> = new Set(['gather', 'compact', 'state', 'flatten'])

export interface DinksterGraphValidationNode {
  readonly anchor: DiagnosticAnchor
  readonly inputTypes: Readonly<Record<string, TypeExpr>>
  readonly inputPorts: Readonly<Record<string, PortRef>>
  readonly outputTypes: Readonly<Record<string, TypeExpr>>
  readonly outputPorts: Readonly<Record<string, PortRef>>
  readonly selector?: true
}

export type DinksterGraphValidationContext = ReadonlyMap<string, DinksterGraphValidationNode>

/** '/'-joined nested path ('r/add') - the backend's diagnostic anchor shape. */
const joinPath = (prefix: string, id: string): string => (prefix === '' ? id : `${prefix}/${id}`)

const anchorData = (
  context: DinksterGraphValidationContext | undefined,
  nodeId: string,
  inputId?: string,
  side: 'input' | 'output' = 'input',
) => {
  const node = context?.get(nodeId)
  const port = inputId === undefined || node === undefined
    ? undefined
    : (side === 'input' ? node.inputPorts : node.outputPorts)[inputId]
  return {
    ...(node !== undefined ? { anchor: { ...node.anchor, ...(port !== undefined ? { port } : {}) } } : {}),
    data: { nodeId, ...(inputId !== undefined ? { inputId } : {}) },
  }
}

/**
 * Native graph validation mirroring the backend checks listed below (backend
 * code in parentheses). Schema-owned checks run only when compile supplies
 * occurrence-local validation context:
 *
 * - dinksterGraph.invalidNodeId  (invalid-node-id): empty id or '/[]' at any level
 * - dinksterGraph.reservedNodeId (reserved-node-id): a node named '$region'
 * - dinksterGraph.regionShape    (region-shape): profile violations - kind,
 *   element/state port counts, binding, continueSource/maxIterations rules,
 *   malformed port type expressions, element/state overlap
 * - dinksterGraph.undeclaredPort (undeclared-port): inputs/elementPorts/
 *   statePorts naming ports not declared, and body '$region' links to
 *   undeclared ports
 * - dinksterGraph.missingInput   (missing-input): a declared port with no outer input
 * - dinksterGraph.stateChain     (state-chain): state port without a same-id
 *   state-mode output, or state-mode output without a same-id state port
 * - dinksterGraph.gatherNonConcrete (gather-nonconcrete): gather element type
 *   is not runtime-resolvable
 * - dinksterGraph.flattenNonList (flatten-non-list): flatten source is scalar
 * - dinksterGraph.flattenNonConcrete (flatten-nonconcrete): flatten list type
 *   is not runtime-resolvable
 * - dinksterGraph.literalOnNonConcrete (literal-on-nonconcrete): a plain
 *   literal targets a non-runtime-resolvable input
 * - dinksterGraph.selectorInRegion (prompt.selector_in_region): a schema-marked
 *   selector node occurs in a region body
 * - dinksterGraph.danglingOutput (dangling-output): region output source or
 *   continueSource naming a missing body node (or, for a region source, an
 *   output the source region does not declare)
 * - dinksterGraph.cycle          (cycle): per-scope link cycle, body-aware
 *
 * Diagnostics carry data.nodeId = the '/'-joined nested path and data.inputId
 * where one anchors - the exact shape server validation rejects use, so UI
 * affordances key identically on both.
 */
export function validateDinksterGraph(
  graph: DinksterGraphWire,
  context?: DinksterGraphValidationContext,
): readonly Diagnostic[] {
  const out: Diagnostic[] = []
  validateScope(graph, '', undefined, context, out)
  return out
}

/** One nesting scope: a top-level graph or one region body. */
function validateScope(
  graph: DinksterGraphWire,
  prefix: string,
  /** Ports of the ENCLOSING region when this scope is a body ($region targets). */
  regionPorts: ReadonlySet<string> | undefined,
  context: DinksterGraphValidationContext | undefined,
  out: Diagnostic[],
): void {
  const ids = Object.keys(graph.nodes)
  const present = new Set(ids)

  for (const id of ids) {
    const path = joinPath(prefix, id)
    if (id === '' || DINKSTER_NODE_ID_FORBIDDEN.test(id)) {
      out.push(
        diag('error', 'compile', 'dinksterGraph.invalidNodeId', `node id '${id}' at '${path}' is empty or contains a banned character ('/', '[' or ']')`, anchorData(context, path)),
      )
    }
    if (id === DINKSTER_REGION_PSEUDO_NODE) {
      out.push(
        diag('error', 'compile', 'dinksterGraph.reservedNodeId', `'${DINKSTER_REGION_PSEUDO_NODE}' is reserved for region port reads and cannot name a node ('${path}')`, anchorData(context, path)),
      )
    }
    const entry = graph.nodes[id]!
    if (isDinksterRegionEntry(entry)) validateRegion(entry.region, path, context, out)

    const nodeContext = context?.get(path)
    if (prefix !== '' && !isDinksterRegionEntry(entry) && nodeContext?.selector === true) {
      out.push(diag(
        'error',
        'compile',
        'dinksterGraph.selectorInRegion',
        `selector node '${path}' is inside a region body; selector nodes inside region bodies are not supported`,
        anchorData(context, path),
      ))
    }

    const inputs = isDinksterRegionEntry(entry) ? entry.region.inputs : entry.inputs
    for (const [inputId, value] of Object.entries(inputs)) {
      const expected = nodeContext?.inputTypes[inputId]
      if (expected === undefined || asDinksterLink(value) !== undefined ||
          parseTypedLiteralWire(value as Json) !== undefined || parseDecimalIntegerWire(value as Json) !== undefined) continue
      if (canonicalTypeIdOf(expected) === undefined) {
        out.push(diag(
          'error',
          'compile',
          'dinksterGraph.literalOnNonConcrete',
          `'${path}' input '${inputId}' is ${expected.kind}-typed; plain literals require a concrete runtime type (use a typed literal to stamp the type explicitly)`,
          anchorData(context, path, inputId),
        ))
      }
    }

    // Body links to '$region' must name a declared port of the enclosing region.
    if (regionPorts !== undefined) {
      for (const [inputId, value] of Object.entries(inputs)) {
        const link = asDinksterLink(value)
        if (link?.node === DINKSTER_REGION_PSEUDO_NODE && link.output !== 'index' && !regionPorts.has(link.output)) {
          out.push(
            diag('error', 'compile', 'dinksterGraph.undeclaredPort', `'${path}' input '${inputId}' reads region port '${link.output}', which the enclosing region does not declare`, anchorData(context, path, inputId)),
          )
        }
      }
    }
  }

  detectCycle(graph, prefix, present, context, out)
}

function validateRegion(
  region: DinksterRegionWire,
  path: string,
  context: DinksterGraphValidationContext | undefined,
  out: Diagnostic[],
): void {
  const shape = (message: string, inputId?: string, side: 'input' | 'output' = 'input'): void => {
    out.push(diag('error', 'compile', 'dinksterGraph.regionShape', `region '${path}': ${message}`, anchorData(context, path, inputId, side)))
  }

  if (!REGION_KINDS.has(region.kind)) shape(`unknown kind '${String(region.kind)}'`)

  // Port declarations: every port type must be a decodable TypeExpr wire.
  const ports = new Set(Object.keys(region.ports))
  for (const [portId, typeWire] of Object.entries(region.ports)) {
    try {
      typeExprFromDinksterWire(typeWire)
    } catch (e) {
      shape(`port '${portId}' declares a malformed type expression: ${e instanceof Error ? e.message : String(e)}`, portId)
    }
  }

  const undeclared = (portId: string, role: string, inputId?: string): void => {
    out.push(
      diag('error', 'compile', 'dinksterGraph.undeclaredPort', `region '${path}': ${role} names port '${portId}', which is not declared in ports`, anchorData(context, path, inputId ?? portId)),
    )
  }

  const elementPorts = region.elementPorts ?? []
  const statePorts = region.statePorts ?? []
  for (const p of elementPorts) if (!ports.has(p)) undeclared(p, 'elementPorts')
  for (const p of statePorts) if (!ports.has(p)) undeclared(p, 'statePorts')
  const stateSet = new Set(statePorts)
  for (const p of elementPorts)
    if (stateSet.has(p)) shape(`port '${p}' is declared both element and state`, p)

  // Outer inputs: one per declared port, none beyond.
  for (const inputId of Object.keys(region.inputs)) {
    if (!ports.has(inputId)) undeclared(inputId, 'inputs', inputId)
  }
  for (const portId of ports) {
    if (!(portId in region.inputs)) {
      out.push(
        diag('error', 'compile', 'dinksterGraph.missingInput', `region '${path}': declared port '${portId}' has no input`, anchorData(context, path, portId)),
      )
    }
  }

  // Profile rules (map / fold / while).
  if (region.binding !== undefined && region.binding !== 'zip' && region.binding !== 'cross' && region.binding !== 'broadcast')
    shape(`unknown binding '${String(region.binding)}'; expected zip, cross, or broadcast`)
  if (
    region.maxIterations !== undefined &&
    (!Number.isInteger(region.maxIterations) || region.maxIterations <= 0)
  )
    shape(`maxIterations must be a positive integer, got ${String(region.maxIterations)}`)

  switch (region.kind) {
    case 'map':
      if (elementPorts.length === 0) shape('map requires at least one element port')
      if (statePorts.length > 0) shape('map does not take state ports')
      if (region.continueSource !== undefined) shape('map does not take a continueSource')
      break
    case 'fold':
      if (elementPorts.length === 0) shape('fold requires at least one element port')
      if (statePorts.length === 0) shape('fold requires at least one state port')
      if (region.continueSource !== undefined) shape('fold does not take a continueSource')
      break
    case 'while':
      if (elementPorts.length > 0) shape('while does not take element ports')
      if (statePorts.length === 0) shape('while requires at least one state port')
      if (region.continueSource === undefined) shape('while requires a continueSource')
      if (region.maxIterations === undefined) shape('while requires maxIterations')
      if (region.binding === 'cross' || region.binding === 'broadcast')
        shape(`while rejects binding '${region.binding}'`)
      break
    default:
      break
  }

  // Outputs: existence in the body, mode/type validity, and state chaining.
  const bodyNodes = region.body.nodes
  const requireBodySource = (source: { node: string; output: string }, what: string, inputId?: string): void => {
    if (source.node === DINKSTER_REGION_PSEUDO_NODE) {
      if (!ports.has(source.output)) {
        out.push(
          diag('error', 'compile', 'dinksterGraph.danglingOutput', `region '${path}': ${what} references region port '${source.output}', which does not exist`, anchorData(context, path, inputId, 'output')),
        )
      }
      return
    }
    const producer = bodyNodes[source.node]
    if (producer === undefined) {
      out.push(
        diag('error', 'compile', 'dinksterGraph.danglingOutput', `region '${path}': ${what} references body node '${source.node}', which does not exist`, anchorData(context, path, inputId, 'output')),
      )
      return
    }
    // A region producer declares its outputs on the wire, so check those; a
    // plain node's outputs are schema-defined and out of structural scope.
    if (isDinksterRegionEntry(producer) && !(source.output in producer.region.outputs)) {
      out.push(
        diag('error', 'compile', 'dinksterGraph.danglingOutput', `region '${path}': ${what} references output '${source.output}' of body region '${source.node}', which it does not declare`, anchorData(context, path, inputId, 'output')),
      )
    }
  }

  const stateOutputs = new Set<string>()
  for (const [outputId, output] of Object.entries(region.outputs)) {
    if (output.mode !== undefined && !OUTPUT_MODES.has(output.mode))
      shape(`output '${outputId}' has unknown mode '${String(output.mode)}'; expected gather, compact, state, or flatten`, outputId, 'output')
    requireBodySource(output.source, `output '${outputId}'`, outputId)
    const sourceType = bodyOutputType(region, output.source, path, context)
    if (output.mode === undefined || output.mode === 'gather' || output.mode === 'compact') {
      if (sourceType !== undefined && canonicalTypeIdOf(sourceType) === undefined) {
        out.push(diag('error', 'compile', 'dinksterGraph.gatherNonConcrete', `region '${path}': output '${outputId}' gathers a ${sourceType.kind}-typed body output; gather requires a concrete runtime type`, anchorData(context, path, outputId, 'output')))
      }
    } else if (output.mode === 'flatten') {
      if (sourceType !== undefined && sourceType.kind !== 'list') {
        out.push(diag('error', 'compile', 'dinksterGraph.flattenNonList', `region '${path}': output '${outputId}' flattens a scalar body output; flatten requires a list-typed body output`, anchorData(context, path, outputId, 'output')))
      } else if (sourceType !== undefined && canonicalTypeIdOf(sourceType) === undefined) {
        out.push(diag('error', 'compile', 'dinksterGraph.flattenNonConcrete', `region '${path}': output '${outputId}' flattens a non-runtime-resolvable list type`, anchorData(context, path, outputId, 'output')))
      }
    }
    if (output.mode === 'state') {
      stateOutputs.add(outputId)
      if (!stateSet.has(outputId)) {
        out.push(
          diag('error', 'compile', 'dinksterGraph.stateChain', `region '${path}': state-mode output '${outputId}' has no matching state port of the same id`, anchorData(context, path, outputId, 'output')),
        )
      }
    }
  }
  for (const portId of stateSet) {
    if (!stateOutputs.has(portId)) {
      out.push(
        diag('error', 'compile', 'dinksterGraph.stateChain', `region '${path}': state port '${portId}' has no state-mode output of the same id to chain it forward`, anchorData(context, path, portId)),
      )
    }
  }

  if (region.continueSource !== undefined) requireBodySource(region.continueSource, 'continueSource')

  // The body is a full nested scope: recurse with this region's ports bound.
  validateScope(region.body, path, ports, context, out)
}

/** Resolve only types declared by nested regions; plain-node outputs are schema-owned. */
function bodyOutputType(
  region: DinksterRegionWire,
  source: { readonly node: string; readonly output: string },
  path: string,
  context: DinksterGraphValidationContext | undefined,
): TypeExpr | undefined {
  if (source.node === DINKSTER_REGION_PSEUDO_NODE) {
    const port = region.ports[source.output]
    if (port === undefined) return undefined
    try {
      return typeExprFromDinksterWire(port)
    } catch {
      return undefined
    }
  }
  const producer = region.body.nodes[source.node]
  if (producer === undefined) return undefined
  if (!isDinksterRegionEntry(producer)) return context?.get(joinPath(path, source.node))?.outputTypes[source.output]
  const output = producer.region.outputs[source.output]
  if (output === undefined) return undefined
  if (output.mode === 'state') {
    const port = producer.region.ports[source.output]
    if (port === undefined) return undefined
    try {
      return typeExprFromDinksterWire(port)
    } catch {
      return undefined
    }
  }
  if (output.mode !== undefined && output.mode !== 'gather' && output.mode !== 'compact' && output.mode !== 'flatten') return undefined
  const inner = bodyOutputType(producer.region, output.source, joinPath(path, source.node), context)
  if (inner === undefined) return undefined
  return output.mode === 'flatten' ? inner : { kind: 'list', element: inner }
}

/**
 * Per-scope cycle detection over $link edges (consumer -> producer).
 * '$region' reads and links to missing nodes contribute no edge; scopes are
 * independent (a body cannot link out, so no cross-scope cycles exist).
 */
function detectCycle(
  graph: DinksterGraphWire,
  prefix: string,
  present: ReadonlySet<string>,
  context: DinksterGraphValidationContext | undefined,
  out: Diagnostic[],
): void {
  const edges = new Map<string, string[]>()
  for (const [id, entry] of Object.entries(graph.nodes)) {
    const inputs = isDinksterRegionEntry(entry) ? entry.region.inputs : entry.inputs
    const producers: string[] = []
    for (const value of Object.values(inputs)) {
      const link = asDinksterLink(value)
      if (link !== undefined && link.node !== DINKSTER_REGION_PSEUDO_NODE && present.has(link.node))
        producers.push(link.node)
    }
    edges.set(id, producers)
  }

  // Iterative three-color DFS; report each cycle once, at its discovery node.
  const state = new Map<string, 'visiting' | 'done'>()
  for (const start of edges.keys()) {
    if (state.has(start)) continue
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }]
    state.set(start, 'visiting')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const producers = edges.get(frame.id) ?? []
      if (frame.next >= producers.length) {
        state.set(frame.id, 'done')
        stack.pop()
        continue
      }
      const producer = producers[frame.next]!
      frame.next += 1
      const s = state.get(producer)
      if (s === 'done') continue
      if (s === 'visiting') {
        const from = stack.findIndex((f) => f.id === producer)
        const members = stack.slice(from).map((f) => joinPath(prefix, f.id))
        out.push(
          diag('error', 'compile', 'dinksterGraph.cycle', `link cycle: ${members.join(' -> ')} -> ${joinPath(prefix, producer)}`, anchorData(context, joinPath(prefix, producer))),
        )
        continue
      }
      state.set(producer, 'visiting')
      stack.push({ id: producer, next: 0 })
    }
  }
}
