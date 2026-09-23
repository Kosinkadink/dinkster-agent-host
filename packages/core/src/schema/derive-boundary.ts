/**
 * Subgraph boundary -> NodeSchema derivation.
 *
 * A subgraph definition's boundary derives EXACTLY the same NodeSchema model
 * backend nodes parse into - this is what makes "anything that works on a
 * node works on a subgraph" true by construction (architecture section 6).
 * The instance node ('#<defId>') is then typed, connected, muted, promoted,
 * and compiled by code that never knows it is a subgraph.
 *
 * Key rules:
 * - Boundary bindings carry an explicit `kind` (hazard N2): 'port' binds one
 *   concrete endpoint (member paths of ANY depth resolve through nested
 *   autogrow templates); 'family' forwards a whole autogrow family.
 * - Widget promotion: a promoted boundary input carries the inner WidgetSpec,
 *   so the instance renders the widget and stores the value under the
 *   boundary id. A non-promoted widget-backed input derives a socket-only
 *   input (forceInput) that is OPTIONAL: unconnected means the inner node's
 *   stored value applies.
 * - Type variables (MatchType) are namespaced per inner node
 *   ('<nodeId>:<templateId>'): unrelated 'T's from different inner nodes stay
 *   distinct, while ports of one inner node sharing a template keep sharing
 *   it on the boundary. A variable bound by a selected DynamicSlot projects
 *   as that concrete type. Forwarded templates are freshened RECURSIVELY
 *   (nested constructs too).
 * - Family forwarding bakes split-forwarding capacity into the derived spec
 *   (hazard F4): the definition's persisted members at the bound scope form
 *   a fixed prefix of count P, so the derived family gets min-P/max-P bounds
 *   and an ordinalOffset of P (additive across chained forwarding). P > max
 *   is a derive error; P == max is legal (instances see max 0, no ghost).
 * - Route resolution is STRUCTURAL, shared with compilation via
 *   `resolveBoundaryRoute`: derive and lowering must never interpret the
 *   path grammar independently. Zero or multiple structural matches are
 *   diagnostics, never precedence picks.
 * - isOutputNode is true iff any inner node resolves to an output-node
 *   schema, and emitsPreviews iff any inner schema declares it; `resolve`
 *   must therefore also answer nested '#<defId>' types (registries resolve
 *   derived schemas recursively).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { generatedBoundaryLabel } from './boundary-labels.js'
import { isSubtreeBinding, type BoundaryBinding, type BoundaryItem, type DynamicPortState, type GraphDef, type NodeData, type RegionContract } from '../format/document.js'
import { isPortEndpoint, portAddressKey, type DynamicMemberId, type PortId } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { typesCompatible, typesDirectlyCompatible } from './type-compatibility.js'
import { DEFAULT_ELAB_BUDGET } from './elaborate.js'
import { outputDescriptorAssetOf, outputDescriptorValueOf, parseOutputDescriptors } from './output-descriptors.js'
import { autogrowBounds, canonicalTypeIdOf, effectiveComboOption, inputsOf, outputCountValueOf, outputSchemaInputsOf, typeExprFromTypeId } from './model.js'
import { parseSelection, type SelectionTree } from './slot-selection.js'
import type {
  AutogrowSpec,
  CountBoundOutputAutogrowSpec,
  DynamicComboSpec,
  DynamicSlotSpec,
  DynamicSpec,
  InputSpec,
  InterfaceItem,
  NodeSchema,
  OutputDescriptorsSpec,
  OutputSpec,
  TypeExpr,
} from './model.js'

/** Resolves node types and optional backend-declared editor roles. */
export interface SchemaResolver {
  (nodeType: string): NodeSchema | undefined
  readonly forEditorRole?: (role: string) => NodeSchema | undefined
}

export interface DeriveResult {
  /** Present unless an error-level diagnostic was produced. */
  readonly schema?: NodeSchema
  readonly diagnostics: readonly Diagnostic[]
}

export type StaticWidgetTapResolution =
  | { readonly ok: true; readonly input: InputSpec }
  | { readonly ok: false; readonly code: 'boundary.tapMissing' | 'boundary.tapAmbiguous' | 'boundary.tapUnsupported' }

/** Resolve one exact static widget-backed input that can serve as an output tap. */
export function resolveStaticWidgetTap(schema: NodeSchema, tap: string): StaticWidgetTapResolution {
  const matches = schema.items.filter((candidate): candidate is InputSpec =>
    candidate.kind === 'input' && candidate.id === tap)
  if (matches.length !== 1) {
    return { ok: false, code: matches.length === 0 ? 'boundary.tapMissing' : 'boundary.tapAmbiguous' }
  }
  const input = matches[0]!
  return input.dynamic === undefined && input.widget !== undefined
    ? { ok: true, input }
    : { ok: false, code: 'boundary.tapUnsupported' }
}

const mentionsCombo = (type: TypeExpr): boolean => {
  if (type.kind === 'concrete') return type.name === 'core.combo'
  if (type.kind === 'union') return type.names.includes('core.combo')
  if (type.kind === 'variable') return type.allowedTypes?.some(mentionsCombo) ?? false
  if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') return mentionsCombo(type.element)
  return false
}

const regionSourceMismatch = (source: TypeExpr, expected: TypeExpr): 'error' | 'warning' | undefined => {
  const runtimeType = canonicalTypeIdOf(source)
  if (runtimeType === undefined || typesDirectlyCompatible(typeExprFromTypeId(runtimeType), expected)) return undefined
  return mentionsCombo(source) || mentionsCombo(expected) ? 'error' : 'warning'
}

// ---------------------------------------------------------------------------
// Type freshening (per inner node, recursive through dynamic constructs)
// ---------------------------------------------------------------------------

const NO_TYPE_BINDINGS: ReadonlyMap<string, TypeExpr> = new Map()

/** Namespace a type expression's unbound variables by inner node id. */
function freshenType(
  type: TypeExpr,
  nodeId: string,
  bindings: ReadonlyMap<string, TypeExpr> = NO_TYPE_BINDINGS,
): TypeExpr {
  switch (type.kind) {
    case 'variable': {
      const bound = bindings.get(type.templateId)
      if (bound !== undefined) return bound
      return {
        kind: 'variable',
        templateId: `${nodeId}:${type.templateId}`,
        ...(type.allowedTypes
          ? { allowedTypes: type.allowedTypes.map((t) => freshenType(t, nodeId, bindings)) }
          : {}),
      }
    }
    case 'list':
    case 'asset':
    case 'stream':
      // Variables can nest inside structured elements ('list<T>',
      // 'asset<T>'): freshen through the constructor so per-occurrence
      // identity holds recursively.
      return { kind: type.kind, element: freshenType(type.element, nodeId, bindings) }
    default:
      return type
  }
}

/** Freshen an input spec recursively - nested dynamic constructs included. */
function freshenInputSpec(
  spec: InputSpec,
  nodeId: string,
  bindings: ReadonlyMap<string, TypeExpr> = NO_TYPE_BINDINGS,
): InputSpec {
  return {
    ...spec,
    type: freshenType(spec.type, nodeId, bindings),
    ...(spec.dynamic !== undefined ? { dynamic: freshenDynamicSpec(spec.dynamic, nodeId, bindings) } : {}),
  }
}

function freshenDynamicSpec(
  spec: DynamicSpec,
  nodeId: string,
  bindings: ReadonlyMap<string, TypeExpr> = NO_TYPE_BINDINGS,
): DynamicSpec {
  switch (spec.kind) {
    case 'autogrow':
      return { ...spec, template: spec.template.map((s) => freshenInputSpec(s, nodeId, bindings)) }
    case 'dynamicCombo':
      return {
        ...spec,
        options: spec.options.map((o) => ({ ...o, inputs: o.inputs.map((s) => freshenInputSpec(s, nodeId, bindings)) })),
      }
    case 'dynamicSlot':
      return {
        ...spec,
        ...(spec.typeTemplateId !== undefined ? { typeTemplateId: `${nodeId}:${spec.typeTemplateId}` } : {}),
        slotType: freshenType(spec.slotType, nodeId, bindings),
        inputs: spec.inputs.map((s) => freshenInputSpec(s, nodeId, bindings)),
        ...(spec.variants ? { variants: spec.variants.map((variant) => ({
          ...variant,
          type: freshenType(variant.type, nodeId, bindings),
          inputs: variant.inputs.map((input) => freshenInputSpec(input, nodeId, bindings)),
        })) } : {}),
      }
  }
}

// ---------------------------------------------------------------------------
// Structural route resolution (shared by derivation AND compile lowering)
// ---------------------------------------------------------------------------

/** One autogrow family crossed on the way to a binding's target. */
export type RouteHop =
  | { readonly kind: 'member'; readonly familyPath: string; readonly spec: AutogrowSpec; readonly member: DynamicMemberId }
  | { readonly kind: 'combo'; readonly constructPath: string; readonly option: string; readonly spec: DynamicComboSpec }
  | { readonly kind: 'slot'; readonly constructPath: string; readonly spec: DynamicSlotSpec }
  | { readonly kind: 'slotVariant'; readonly constructPath: string; readonly key: string; readonly spec: DynamicSlotSpec }

export const memberHopsOf = (hops: readonly RouteHop[]): readonly Extract<RouteHop, { kind: 'member' }>[] =>
  hops.filter((h): h is Extract<RouteHop, { kind: 'member' }> => h.kind === 'member')

/** State cursor at a route scope; conditional hops deliberately do not shift it. */
export function scopeAt(node: Pick<NodeData, 'dynamic'>, hops: readonly RouteHop[]): Readonly<Record<string, DynamicPortState>> | undefined {
  let scope = node.dynamic
  for (const hop of memberHopsOf(hops)) scope = scope?.[hop.familyPath]?.memberState?.[hop.member]
  return scope
}

export type RouteTerminal =
  | {
      readonly kind: 'port'
      /** Terminal slot spec. Template slots are InputSpecs even on the output side. */
      readonly slot: InputSpec | OutputSpec
    }
  | {
      readonly kind: 'family'
      /** The spec item/slot declaring the family (carries type/display/optional). */
      readonly declaring: InputSpec | OutputSpec
      readonly spec: AutogrowSpec
      /** Dotted construct path of the family itself (== binding.port). */
      readonly familyPath: string
    }

export interface BoundaryRoute {
  readonly side: 'input' | 'output'
  /** Top-level schema item the route enters through (output isList lives here). */
  readonly topItem: InputSpec | OutputSpec
  readonly hops: readonly RouteHop[]
  readonly terminal: RouteTerminal
}

export type RouteResult =
  | { readonly ok: true; readonly route: BoundaryRoute }
  | { readonly ok: false; readonly code: string; readonly message: string }

interface RouteProblem {
  readonly code: string
  readonly message: string
}

/**
 * Resolve a binding's `{port, members}` against a schema STRUCTURALLY: walk
 * the interface items and nested autogrow templates, consuming exactly one
 * member id per family crossed. All candidate interpretations are
 * enumerated; exactly one structural match must exist ('longest prefix wins'
 * is banned - dotted ids must never silently change a binding's meaning).
 * The `kind` fit (port vs family terminal) is checked by the CALLER so kind
 * mismatches get precise diagnostics.
 */
export function resolveBoundaryRoute(
  schema: NodeSchema,
  binding: BoundaryBinding,
  expectedSide?: 'input' | 'output',
  values?: Readonly<Record<string, unknown>>,
): RouteResult {
  if (binding.kind === 'widgetTap') {
    return {
      ok: false,
      code: 'boundary.tapRoute',
      message: `widget tap '${binding.tap}' is not a port or family route`,
    }
  }
  const path = binding.port as string
  const members = binding.members ?? []
  const matches: BoundaryRoute[] = []
  const problems: RouteProblem[] = []

  const visit = (
    slots: readonly (InputSpec | OutputSpec)[],
    prefix: string,
    memberIdx: number,
    hops: readonly RouteHop[],
    side: 'input' | 'output',
    topItem: InputSpec | OutputSpec,
  ): void => {
    for (const slot of slots) {
      const full = prefix === '' ? slot.id : `${prefix}.${slot.id}`
      if (path === full) {
        if (slot.dynamic === undefined) {
          if (memberIdx !== members.length) {
            problems.push({
              code: 'boundary.memberPath',
              message: `port '${path}' crosses ${memberIdx} family level(s) but the binding carries ${members.length} member id(s)`,
            })
            continue
          }
          matches.push({ side, topItem, hops, terminal: { kind: 'port', slot } })
          continue
        }
        if (slot.dynamic.kind !== 'autogrow') {
          if (memberIdx !== members.length) {
            problems.push({ code: 'boundary.memberPath', message: `construct '${path}' sits under ${memberIdx} family level(s) but the binding carries ${members.length} member id(s)` })
            continue
          }
          matches.push({ side, topItem, hops, terminal: { kind: 'port', slot } })
          continue
        }
        if (memberIdx !== members.length) {
          problems.push({
            code: 'boundary.memberPath',
            message: `family '${path}' sits under ${memberIdx} family level(s) but the binding carries ${members.length} member id(s)`,
          })
          continue
        }
        matches.push({
          side,
          topItem,
          hops,
          terminal: { kind: 'family', declaring: slot, spec: slot.dynamic, familyPath: full },
        })
        continue
      }
      if (!path.startsWith(`${full}.`)) continue
      if (slot.dynamic === undefined) continue // static ids do not nest
      if (slot.dynamic.kind === 'dynamicCombo') {
        // Branch prefixes are composed from the schema option key itself.
        // Bracket parsing would make dotted/reserved ids an accidental second
        // address grammar and recreate hazard F7.
        for (const option of slot.dynamic.options) {
          const branch = `${full}.[${option.key}]`
          if (path.startsWith(`${branch}.`)) visit(option.inputs, branch, memberIdx, [...hops, { kind: 'combo', constructPath: full, option: option.key, spec: slot.dynamic }], side, topItem)
        }
        continue
      }
      if (slot.dynamic.kind === 'dynamicSlot') {
        visit(slot.dynamic.inputs, full, memberIdx, [...hops, { kind: 'slot', constructPath: full, spec: slot.dynamic }], side, topItem)
        // Variant descent is authored structurally from key fields. Never
        // recover keys by parsing bracket strings from a document path.
        for (const variant of slot.dynamic.variants ?? []) {
          const branch = `${full}.[${variant.key}]`
          if (path.startsWith(`${branch}.`)) visit(variant.inputs, branch, memberIdx, [...hops, { kind: 'slotVariant', constructPath: full, key: variant.key, spec: slot.dynamic }], side, topItem)
        }
        continue
      }
      if (memberIdx >= members.length) {
        problems.push({
          code: 'boundary.memberPath',
          message: `path '${path}' crosses family '${full}' but the binding carries only ${members.length} member id(s)`,
        })
        continue
      }
      const hop: RouteHop = { kind: 'member', familyPath: full, spec: slot.dynamic, member: members[memberIdx]! }
      visit(slot.dynamic.template, full, memberIdx + 1, [...hops, hop], side, topItem)
    }
  }

  for (const it of schema.items) {
    if (it.kind === 'section') continue
    if (it.kind === 'output' && it.outputDescriptors !== undefined && it.outputDescriptors.selectedId === undefined) {
      // The source document owns membership and type. This route retains the
      // descriptor contract so occurrence elaboration can validate both.
      const spec = it.outputDescriptors
      const result = values === undefined ? undefined : parseOutputDescriptors(spec, outputDescriptorValueOf(spec, values), outputDescriptorAssetOf(spec, values))
      const entry = result?.ok ? result.document.entries.find((entry) => entry.id === path) : undefined
      if (binding.kind === 'port' && members.length === 0 && /^[A-Za-z0-9_-]+$/.test(path) &&
          !schema.items.some((other) => other.kind === 'output' && other.outputDescriptors === undefined && other.id === path)) {
        const slot = { ...it, id: path, type: spec.choices.find((choice) => choice.id === entry?.type)?.type ?? it.type, outputDescriptors: { ...spec, selectedId: path } }
        matches.push({ side: 'output', topItem: it, hops: [], terminal: { kind: 'port', slot } })
      }
      continue
    }
    visit([it], '', 0, [], it.kind, it)
  }

  const sides = new Set(matches.map((match) => match.side))
  const eligibleMatches = expectedSide !== undefined && sides.size > 1
    ? matches.filter((match) => match.side === expectedSide)
    : matches
  const resolvedMatches = eligibleMatches.length > 0 ? eligibleMatches : matches
  if (resolvedMatches.length === 1) return { ok: true, route: resolvedMatches[0]! }
  if (resolvedMatches.length > 1) {
    return {
      ok: false,
      code: 'boundary.ambiguousBind',
      message: `port '${path}' matches ${resolvedMatches.length} structural targets on '${schema.type}' (dotted ids collide with stamped slot paths)`,
    }
  }
  if (problems.length > 0) return { ok: false, ...problems[0]! }
  return {
    ok: false,
    code: 'boundary.unknownPort',
    message: `no port '${path}'${members.length > 0 ? ` (member path '${members.join('.')}')` : ''} on '${schema.type}'`,
  }
}

/**
 * The definition-local dynamic state of a route's target family: walk the
 * node's member-scoped state cursor along the hops (hazard N4 - state is
 * looked up by scope, never by parsing packed keys).
 */
export function familyStateAt(
  node: Pick<NodeData, 'dynamic'>,
  hops: readonly RouteHop[],
  familyPath: string,
): DynamicPortState | undefined {
  return scopeAt(node, hops)?.[familyPath]
}

// ---------------------------------------------------------------------------
// Boundary -> NodeSchema derivation
// ---------------------------------------------------------------------------

/**
 * Derive the NodeSchema of a subgraph definition's boundary. Returns
 * diagnostics for every unresolvable binding; the schema is produced only if
 * no error occurred (partial schemas would let bad instances propagate).
 */
export function deriveBoundarySchema(
  def: GraphDef,
  resolve: SchemaResolver,
  region?: RegionContract,
  resolveNode: (node: NodeData) => NodeSchema | undefined = (node) => resolve(node.type),
): DeriveResult {
  const diags: Diagnostic[] = []
  const fail = (code: string, msg: string): void => {
    diags.push(diag('error', 'schema', code, `[${def.id}] ${msg}`))
  }

  if (!def.boundary) {
    fail('boundary.missing', `graph definition has no boundary (root graphs cannot be instanced)`)
    return { diagnostics: diags }
  }

  const items: InterfaceItem[] = []
  const seenIds = new Set<string>()
  const routeCache = new WeakMap<object, Partial<Record<'input' | 'output', { node: NodeData; route: BoundaryRoute }>>>()
  /** One suffix owner per target family (hazard F1): route identity -> boundary id. */
  const forwardedFamilies = new Map<string, string>()
  const slotTypeBindings = new WeakMap<NodeData, ReadonlyMap<string, TypeExpr>>()

  const typeBindingsFor = (node: NodeData): ReadonlyMap<string, TypeExpr> => {
    const cached = slotTypeBindings.get(node)
    if (cached !== undefined) return cached
    const bindings = new Map<string, TypeExpr>()
    const schema = resolveNode(node)
    if (schema !== undefined) {
      for (const input of inputsOf(schema)) {
        const dynamic = input.dynamic
        if (
          dynamic?.kind !== 'dynamicSlot' ||
          dynamic.typeTemplateId === undefined ||
          dynamic.variants === undefined
        ) continue
        if (def.boundary?.inputs.some((item) => item.binds.kind === 'slot' && item.binds.node === node.id && item.binds.port === input.id)) continue
        const selected = node.dynamic?.[input.id]?.selected
        const variant = dynamic.variants.find((candidate) => candidate.key === selected)
        if (variant !== undefined) bindings.set(dynamic.typeTemplateId, variant.type)
      }
    }
    slotTypeBindings.set(node, bindings)
    return bindings
  }

  const checkId = (item: BoundaryItem): boolean => {
    if (seenIds.has(item.id)) {
      fail('boundary.duplicateId', `duplicate boundary id '${item.id}'`)
      return false
    }
    seenIds.add(item.id)
    return true
  }

  /**
   * Resolve schema + route for one binding; undefined = failed. Diagnostics
   * are emitted only when NOT silent: the ownership prepass resolves every
   * binding silently (it only needs successes to classify owners), and the
   * main derivation loop then diagnoses each failure exactly once with its
   * proper item-scoped description. Successes are cached by binding identity
   * so the double resolution costs one pass, not two.
   */
  const routeForBinding = (
    binds: BoundaryBinding,
    describe: string,
    expectedSide: 'input' | 'output',
    silent = false,
  ): { node: NodeData; route: BoundaryRoute } | undefined => {
    const cached = routeCache.get(binds)?.[expectedSide]
    if (cached != null) return cached
    const emit = silent ? () => {} : fail
    const node = def.nodes[binds.node]
    if (!node) {
      emit('boundary.danglingNode', `${describe} binds missing node '${binds.node}'`)
      return undefined
    }
    const schema = resolveNode(node)
    if (!schema) {
      emit('boundary.unresolvedSchema', `${describe} binds node '${node.id}' of unresolvable type '${node.type}'`)
      return undefined
    }
    if (binds.kind === 'widgetTap') {
      emit('boundary.tapSide', `${describe} uses an output-only widget tap binding`)
      return undefined
    }
    const result = resolveBoundaryRoute(schema, binds, expectedSide, node.values)
    if (!result.ok) {
      emit(result.code, `${describe}: ${result.message}`)
      return undefined
    }
    const route = result.route
    for (const [hopIndex, hop] of route.hops.entries()) {
      if (hop.kind !== 'combo' && hop.kind !== 'slotVariant') continue
      const state = scopeAt(node, route.hops.slice(0, hopIndex))?.[hop.constructPath]
      const active = hop.kind === 'combo' ? effectiveComboOption(hop.spec, state) : state?.selected
      const expected = hop.kind === 'combo' ? hop.option : hop.key
      if (active !== expected) {
        emit('boundary.branchInactive', `${describe}: branch '${expected}' of '${hop.constructPath}' is inactive; active branch is '${active ?? ''}'`)
        return undefined
      }
    }
    if (binds.kind === 'port' && route.terminal.kind === 'family') {
      emit('boundary.familyBind', `${describe} binds dynamic family '${binds.port}' with kind 'port'; whole-family forwarding requires kind 'family'`)
      return undefined
    }
    if (binds.kind === 'family' && route.terminal.kind === 'port') {
      emit('boundary.notAFamily', `${describe} forwards '${binds.port}' with kind 'family' but it is a concrete port`)
      return undefined
    }
    if (binds.kind !== 'family' && binds.slots !== undefined) {
      emit('boundary.slotsOnPort', `${describe}: 'slots' is invalid on a 'port' binding (slot selection applies to family forwarding only)`)
      return undefined
    }
    if (isSubtreeBinding(binds) && (expectedSide !== 'input' || route.terminal.kind !== 'port' ||
      route.terminal.slot.dynamic?.kind !== (binds.kind === 'slot' ? 'dynamicSlot' : 'dynamicCombo'))) {
      emit('boundary.constructKind', `${describe}: '${binds.kind}' must forward an input ${binds.kind === 'slot' ? 'DynamicSlot' : 'DynamicCombo'} construct`)
      return undefined
    }
    const resolved = { node, route }
    routeCache.set(binds, { ...routeCache.get(binds), [expectedSide]: resolved })
    return resolved
  }

  /** Resolve schema + route for one item's PRIMARY binding. */
  const routeFor = (item: BoundaryItem, side: 'input' | 'output'): { node: NodeData; route: BoundaryRoute } | undefined =>
    routeForBinding(item.binds, `boundary ${side} '${item.id}'`, side)

  /** Fan-out duplicate key: full target address (node, port, member path). */
  const targetKeyOf = (b: Exclude<BoundaryBinding, { kind: 'widgetTap' }>): string => JSON.stringify([b.node, b.port, b.members ?? []])

  // Ownership is checked before item derivation so declaration order cannot
  // decide whether forwarding a conditional construct wins over exposing a
  // target beneath it. Scope identity uses member ids, never display ordinal.
  const owners = new Map<string, { item: string; kind: 'combo' | 'slot' }>()
  const descendants: { key: string; item: string; kind: 'combo' | 'slot' }[] = []
  const allBoundaryItems = [
    ...def.boundary.inputs.map((item) => ({ item, side: 'input' as const })),
    ...def.boundary.outputs.map((item) => ({ item, side: 'output' as const })),
  ]
  for (const { item, side } of allBoundaryItems) {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (binding.kind === 'widgetTap') continue
      const resolved = routeForBinding(binding, `boundary item '${item.id}' ownership target`, side, true)
      if (!resolved) continue
      const scopedKey = (path: string, hops: readonly RouteHop[]): string =>
        JSON.stringify([binding.node, memberHopsOf(hops).map((h) => [h.familyPath, h.member]), path])
      if (resolved.route.terminal.kind === 'port') {
        const dynamic = resolved.route.terminal.slot.dynamic
        if (dynamic?.kind === 'dynamicCombo' || dynamic?.kind === 'dynamicSlot') {
          const kind = dynamic.kind === 'dynamicCombo' ? 'combo' : 'slot'
          const key = scopedKey(binding.port as string, resolved.route.hops)
          const previous = owners.get(key)
          if (previous) fail(kind === 'combo' ? 'boundary.selectorConflict' : 'boundary.slotConditional', `boundary item '${item.id}' and '${previous.item}' both own conditional construct '${binding.port}'`)
          else owners.set(key, { item: item.id, kind })
        }
      }
      for (const hop of resolved.route.hops) {
        if (hop.kind === 'member') continue
        descendants.push({ key: scopedKey(hop.constructPath, resolved.route.hops.slice(0, resolved.route.hops.indexOf(hop))), item: item.id, kind: hop.kind === 'combo' ? 'combo' : 'slot' })
      }
    }
  }
  for (const descendant of descendants) {
    const owner = owners.get(descendant.key)
    if (!owner || owner.item === descendant.item) continue
    fail(owner.kind === 'combo' ? 'boundary.selectorConflict' : 'boundary.slotConditional', `boundary item '${descendant.item}' targets beneath conditional construct owned by '${owner.item}'`)
  }

  /** Link existence is scoped by node plus the exact structural member path. */
  const isInternallyConnected = (b: Exclude<BoundaryBinding, { kind: 'widgetTap' }>, constructPath: string): boolean => {
    const key = portAddressKey(constructPath, b.members)
    for (const link of Object.values(def.links)) {
      if (isPortEndpoint(link.to) && link.to.node === b.node && portAddressKey(link.to.port, link.to.members) === key) return true
    }
    for (const net of Object.values(def.nets)) {
      if (net.sinks.some((s) => s.node === b.node && portAddressKey(s.port, s.members) === key)) return true
    }
    return false
  }

  /**
   * First slot in an omitted template subtree that a FRESH instance-appended
   * member could not satisfy (hazard F10): a required socket-only slot,
   * either static or inside a min-filled nested autogrow (min-0 nested
   * families materialize nothing; conditional constructs reveal on demand
   * and their declaring slots carry widgets/defaults). Returns its dotted
   * path for the diagnostic.
   */
  const findStarvedSlot = (slot: InputSpec, prefixPath: string): string | undefined => {
    const path = prefixPath === '' ? slot.id : `${prefixPath}.${slot.id}`
    if (slot.dynamic !== undefined) {
      if (slot.dynamic.kind !== 'autogrow') return undefined
      if (autogrowBounds(slot.dynamic).min === 0) return undefined
      for (const t of slot.dynamic.template) {
        const found = findStarvedSlot(t, path)
        if (found !== undefined) return found
      }
      return undefined
    }
    return !slot.optional && slot.widget === undefined ? path : undefined
  }

  /**
   * Filter a template by a selection tree (hazard F10), in TEMPLATE order.
   * Narrowed entries recurse into autogrow constructs only - descending
   * into a concrete slot or a non-autogrow construct is an error, as is an
   * unknown segment.
   */
  const applySelection = (
    template: readonly InputSpec[],
    sel: SelectionTree,
    prefixPath: string,
  ): { ok: true; template: InputSpec[] } | { ok: false; code: string; detail: string } => {
    const byId = new Map(template.map((s) => [s.id, s]))
    for (const [seg, sub] of sel) {
      const slot = byId.get(seg)
      const path = prefixPath === '' ? seg : `${prefixPath}.${seg}`
      if (slot === undefined) {
        return { ok: false, code: 'boundary.slotUnknown', detail: `selected slot path '${path}' does not exist in the template` }
      }
      if (sub !== 'all' && slot.dynamic?.kind !== 'autogrow') {
        return {
          ok: false,
          code: 'boundary.slotNotNestable',
          detail: `selected slot path narrows '${path}', which is ${slot.dynamic === undefined ? 'a concrete slot' : `a '${slot.dynamic.kind}' construct`}; only autogrow constructs support nested selection`,
        }
      }
    }
    const out: InputSpec[] = []
    for (const s of template) {
      const sub = sel.get(s.id)
      if (sub === undefined) continue
      if (sub === 'all') {
        out.push(s)
        continue
      }
      const d = s.dynamic as AutogrowSpec
      const inner = applySelection(d.template, sub, prefixPath === '' ? s.id : `${prefixPath}.${s.id}`)
      if (!inner.ok) return inner
      out.push({ ...s, dynamic: { ...d, template: inner.template } })
    }
    return { ok: true, template: out }
  }

  /**
   * Selection-aware starvation (hazard F10). A fully hidden subtree starves
   * per findStarvedSlot (min-0 hidden families materialize nothing). A
   * NARROWED nested construct is different: it is exposed and growable from
   * the instance, so members can exist REGARDLESS of its min - every hidden
   * slot within must be satisfiable for freshly appended members.
   */
  const findSelectionStarved = (template: readonly InputSpec[], sel: SelectionTree, prefixPath: string): string | undefined => {
    for (const s of template) {
      const sub = sel.get(s.id)
      if (sub === undefined) {
        const starved = findStarvedSlot(s, prefixPath)
        if (starved !== undefined) return starved
      } else if (sub !== 'all') {
        const d = s.dynamic as AutogrowSpec
        if (autogrowBounds(d).max > 0) {
          const starved = findSelectionStarved(d.template, sub, prefixPath === '' ? s.id : `${prefixPath}.${s.id}`)
          if (starved !== undefined) return starved
        }
      }
    }
    return undefined
  }

  /**
   * Derived autogrow spec for a forwarded family (hazard F4): capacity minus
   * the definition-local prefix count, ordinal offset accumulated for
   * chained forwarding, template freshened recursively. Slot selection
   * (hazard F10) filters the derived template - in TEMPLATE order - without
   * touching capacity, ordinals, or member identity.
   */
  const deriveFamilySpec = (
    item: BoundaryItem,
    side: string,
    node: NodeData,
    route: BoundaryRoute,
    binding: Exclude<BoundaryBinding, { kind: 'widgetTap' }> = item.binds as Exclude<BoundaryBinding, { kind: 'widgetTap' }>,
  ): AutogrowSpec | undefined => {
    const terminal = route.terminal as Extract<RouteTerminal, { kind: 'family' }>
    const spec = terminal.spec
    const { min, max } = autogrowBounds(spec)
    const prefix = 'count' in spec
      ? 0
      : familyStateAt(node, route.hops, terminal.familyPath)?.members?.length ?? 0
    if (prefix > max) {
      fail('boundary.familyOverCap', `boundary ${side} '${item.id}': definition holds ${prefix} members of '${terminal.familyPath}' but the family caps at ${max}`)
      return undefined
    }
    let template = spec.template
    const selection = binding.slots
    if (selection !== undefined) {
      const parsed = parseSelection(selection)
      if ('error' in parsed) {
        fail('boundary.slotConflict', `boundary ${side} '${item.id}': ${parsed.error} (family '${terminal.familyPath}')`)
        return undefined
      }
      const applied = applySelection(spec.template, parsed.tree, '')
      if (!applied.ok) {
        fail(applied.code, `boundary ${side} '${item.id}': ${applied.detail} (family '${terminal.familyPath}')`)
        return undefined
      }
      // Instance-appended members stamp the FULL template on the inner node;
      // an unexposed required socket-only slot would starve every appended
      // member at compile. Fail at configuration time - unless the derived
      // family cannot grow at all (prefix == max), where no member can ever
      // be appended.
      if (side === 'input' && max - prefix > 0) {
        const starved = findSelectionStarved(spec.template, parsed.tree, '')
        if (starved !== undefined) {
          fail('boundary.slotStarved', `boundary ${side} '${item.id}': unexposed slot '${starved}' of family '${terminal.familyPath}' is required and socket-only; instance-appended members could never satisfy it`)
          return undefined
        }
      }
      template = applied.template
    }
    const derivedMin = Math.max(0, min - prefix)
    const naming: AutogrowSpec['naming'] =
      spec.naming.kind === 'names'
        ? { kind: 'names', names: spec.naming.names.slice(prefix), ...(derivedMin > 0 ? { min: derivedMin } : {}) }
        : spec.naming.kind === 'native'
          ? { kind: 'native', ...(spec.naming.min !== undefined ? { min: spec.naming.min } : {}), ...(spec.naming.max !== undefined ? { max: spec.naming.max } : {}) }
        : {
            kind: 'prefix',
            prefix: spec.naming.prefix,
            ...(derivedMin > 0 ? { min: derivedMin } : {}),
            max: max - prefix,
          }
    const offset = (spec.ordinalOffset ?? 0) + prefix
    return {
      kind: 'autogrow',
      template: template.map((s) => freshenInputSpec(s, binding.node, typeBindingsFor(node))),
      naming,
      ...(offset > 0 ? { ordinalOffset: offset } : {}),
    }
  }

  /** Reject a second forwarding route to the same target family (hazard F1). */
  const checkForwardUnique = (
    item: BoundaryItem,
    side: string,
    route: BoundaryRoute,
    binding: BoundaryBinding = item.binds,
  ): boolean => {
    const terminal = route.terminal as Extract<RouteTerminal, { kind: 'family' }>
    const key = JSON.stringify([binding.node, memberHopsOf(route.hops).map((h) => [h.familyPath, h.member]), terminal.familyPath])
    const owner = forwardedFamilies.get(key)
    if (owner !== undefined) {
      fail('boundary.duplicateForward', `boundary ${side} '${item.id}' forwards family '${terminal.familyPath}' on '${binding.node}' already forwarded by '${owner}'; a family has ONE suffix owner`)
      return false
    }
    forwardedFamilies.set(key, item.id)
    return true
  }

  const generatedNameCounts = {
    input: new Map<string, number>(),
    output: new Map<string, number>(),
  }
  const displayNameOf = (
    item: BoundaryItem,
    inner: InputSpec | OutputSpec,
    side: 'input' | 'output',
  ): { displayName: string } => {
    const schemaName = inner.displayName?.trim()
    const generated = schemaName === undefined
      ? generatedBoundaryLabel(item)
      : /^[A-Z0-9 _.-]+$/.test(schemaName) || /[ _-](?:m)?\d+$/i.test(schemaName) || /[_-]/.test(schemaName)
        ? generatedBoundaryLabel(item, schemaName)
        : schemaName
    const key = generated.toLowerCase()
    const ordinal = (generatedNameCounts[side].get(key) ?? 0) + 1
    generatedNameCounts[side].set(key, ordinal)
    return {
      displayName: item.displayName ?? (ordinal === 1 ? generated : `${generated} ${ordinal}`),
    }
  }

  const projectOutputCount = (
    boundaryOutput: BoundaryItem,
    node: NodeData,
    spec: CountBoundOutputAutogrowSpec,
  ): CountBoundOutputAutogrowSpec['count'] | undefined => {
    const countBinding: BoundaryBinding = {
      kind: 'port',
      node: boundaryOutput.binds.node,
      port: spec.count.input as PortId,
    }
    if (isInternallyConnected(countBinding, spec.count.input)) {
      diags.push(diag(
        'warning',
        'schema',
        'boundary.countBoundOutputInvalid',
        `[${def.id}] boundary output '${boundaryOutput.id}' cannot project count-bound family '${boundaryOutput.binds.port}': count input '${spec.count.input}' is linked inside the definition; this output item is omitted`,
      ))
      return undefined
    }
    const fallback = outputCountValueOf(spec, node.values)
    const { min, max } = autogrowBounds(spec)
    const effectiveMax = Math.min(max, DEFAULT_ELAB_BUDGET.maxMembers)
    const fallbackValid = Number.isSafeInteger(fallback) && (fallback as number) >= min && (fallback as number) <= effectiveMax
    const promoted = def.boundary!.inputs.find((candidate) =>
      candidate.promoted === true &&
      items.some((derived) => derived.kind === 'input' && derived.id === candidate.id && derived.widget !== undefined) &&
      [candidate.binds, ...(candidate.alsoBinds ?? [])].some((binding) =>
        binding.kind === 'port' &&
        binding.node === boundaryOutput.binds.node &&
        binding.port === spec.count.input &&
        binding.members === undefined),
    )
    if (!fallbackValid) {
      diags.push(diag(
        'warning',
        'schema',
        'boundary.countBoundOutputInvalid',
        promoted === undefined
          ? `[${def.id}] boundary output '${boundaryOutput.id}' cannot project count-bound family '${boundaryOutput.binds.port}': count input '${spec.count.input}' must hold a safe integer in ${min}..${effectiveMax}; this output item is omitted`
          : `[${def.id}] boundary output '${boundaryOutput.id}' has no valid definition fallback for count-bound family '${boundaryOutput.binds.port}': promoted input '${promoted.id}' must hold a safe integer in ${min}..${effectiveMax} on each instance`,
      ))
      if (promoted === undefined) return undefined
    }
    return {
      input: promoted?.id ?? spec.count.input,
      suffix: 'index',
      boundaryProjection: {
        ...(fallbackValid ? { fallback: fallback as number } : {}),
        ...(promoted === undefined ? { fixed: true } : {}),
      },
    }
  }

  for (const item of def.boundary.inputs) {
    if (!checkId(item)) continue
    if (item.binds.kind === 'widgetTap') {
      fail('boundary.tapSide', `boundary input '${item.id}' uses an output-only widget tap binding`)
      continue
    }
    const resolved = routeFor(item, 'input')
    if (!resolved) continue
    const { node, route } = resolved
    if (route.side !== 'input') {
      fail('boundary.sideMismatch', `boundary input '${item.id}' binds an OUTPUT port '${item.binds.port}'`)
      continue
    }
    if (route.terminal.kind === 'family') {
      if (item.promoted !== undefined) {
        fail('boundary.familyPromoted', `boundary input '${item.id}': 'promoted' is invalid on whole-family forwarding (the forwarded template carries its widgets)`)
        continue
      }
      if (!checkForwardUnique(item, 'input', route)) continue
      let fanoutOk = true
      const seenTargets = new Set<string>([targetKeyOf(item.binds)])
      for (const [index, binding] of (item.alsoBinds ?? []).entries()) {
        const describe = `boundary input '${item.id}' family fan-out target [${index}]`
        if (binding.kind !== 'family') {
          fail('boundary.fanoutKind', `${describe} must be kind 'family'`)
          fanoutOk = false
          continue
        }
        const key = targetKeyOf(binding)
        if (seenTargets.has(key)) {
          fail('boundary.duplicateBind', `${describe} repeats target '${binding.node}/${binding.port}'${binding.members ? ` member '${binding.members.join('.')}'` : ''}`)
          fanoutOk = false
          continue
        }
        seenTargets.add(key)
        const additional = routeForBinding(binding, describe, 'input')
        if (additional === undefined) {
          fanoutOk = false
          continue
        }
        if (additional.route.side !== 'input') {
          fail('boundary.sideMismatch', `${describe} binds an OUTPUT port '${binding.port}'`)
          fanoutOk = false
          continue
        }
        if (additional.route.terminal.kind !== 'family') {
          fail('boundary.fanoutKind', `${describe} must bind a whole family`)
          fanoutOk = false
          continue
        }
        if (!checkForwardUnique(item, 'input', additional.route, binding)) fanoutOk = false
        if (deriveFamilySpec(item, 'input', additional.node, additional.route, binding) === undefined) fanoutOk = false
      }
      if (!fanoutOk) continue
      const derived = deriveFamilySpec(item, 'input', node, route)
      if (!derived) continue
      const declaring = route.terminal.declaring as InputSpec
      items.push({
        kind: 'input',
        id: item.id,
        ...displayNameOf(item, declaring, 'input'),
        ...(declaring.tooltip !== undefined ? { tooltip: declaring.tooltip } : {}),
        type: freshenType(declaring.type, item.binds.node, typeBindingsFor(node)),
        optional: declaring.optional,
        dynamic: derived,
      })
      continue
    }
    const inner = route.terminal.slot as InputSpec
    // Every dynamicSlot crossed on the way to the target must be connected
    // INSIDE the definition: dependents (including nested constructs) only
    // exist while their slot is linked. Checked before the terminal-kind
    // branches so a selector or slot nested under a disconnected slot is
    // rejected too. Each slot hop is addressed with only the member ids
    // consumed BEFORE it - binding.members spans the whole route and may
    // include members of families nested inside the slot's dependents.
    {
      let dangling: string | undefined
      const consumed: DynamicMemberId[] = []
      for (const hop of route.hops) {
        if (hop.kind === 'member') {
          consumed.push(hop.member)
          continue
        }
        if (hop.kind !== 'slot' && hop.kind !== 'slotVariant') continue
        // isInternallyConnected addresses by (node, constructPath, members);
        // the binding's own port field is not consulted.
        const slotBinding: Exclude<BoundaryBinding, { kind: 'widgetTap' }> = {
          kind: item.binds.kind,
          node: item.binds.node,
          port: item.binds.port,
          ...(consumed.length > 0 ? { members: [...consumed] } : {}),
        }
        if (!isInternallyConnected(slotBinding, hop.constructPath)) {
          dangling = hop.constructPath
          break
        }
      }
      if (dangling !== undefined) {
        fail('boundary.slotDisconnected', `boundary input '${item.id}' binds '${item.binds.port}' beneath slot '${dangling}', which is not connected inside the definition`)
        continue
      }
    }
    if (isSubtreeBinding(item.binds)) {
      if (item.promoted !== undefined || item.alsoBinds !== undefined) {
        fail('boundary.constructOwnership', `boundary input '${item.id}': a forwarded construct cannot be promoted or fan out`)
        continue
      }
      if (isInternallyConnected(item.binds, item.binds.port)) {
        fail('boundary.constructConnected', `boundary input '${item.id}': '${item.binds.port}' is already driven inside the definition`)
        continue
      }
      items.push({ ...freshenInputSpec(inner, item.binds.node, typeBindingsFor(node)), id: item.id, ...displayNameOf(item, inner, 'input') })
      continue
    }
    if (inner.dynamic?.kind === 'dynamicCombo') {
      if (item.promoted !== undefined) {
        fail('boundary.selectorPromoted', `boundary input '${item.id}': a forwarded selector cannot be promoted`)
        continue
      }
      if (item.alsoBinds !== undefined) {
        fail('boundary.selectorFanout', `boundary input '${item.id}': a forwarded selector cannot fan out`)
        continue
      }
      const selected = effectiveComboOption(inner.dynamic, scopeAt(node, route.hops)?.[item.binds.port as string])
      items.push({
        kind: 'input', id: item.id, ...displayNameOf(item, inner, 'input'), type: freshenType(inner.type, item.binds.node, typeBindingsFor(node)), optional: true,
        dynamic: {
          kind: 'dynamicCombo',
          options: inner.dynamic.options.map((o) => ({ key: o.key, inputs: [] })),
          ...(selected !== undefined ? { defaultOption: selected } : {}),
        },
      })
      diags.push(diag('warning', 'schema', 'boundary.selectorOnly', `[${def.id}] boundary input '${item.id}' forwards only the selector; branch inputs stay definition-owned. Upgrade to full-branch forwarding to edit them per instance.`))
      continue
    }
    if (inner.dynamic?.kind === 'dynamicSlot') {
      if (inner.dynamic.variants?.length) {
        // Flattening a specialized slot would erase its variants and move
        // selection from each occurrence onto the shared definition schema.
        fail('boundary.specializedSlotUnsupported', `boundary input '${item.id}' directly forwards specialized slot '${item.binds.port}'; occurrence-local forwarding design is pending`)
        continue
      }
      items.push({
        kind: 'input', id: item.id, ...displayNameOf(item, inner, 'input'), type: freshenType(inner.dynamic.slotType, item.binds.node, typeBindingsFor(node)), optional: true, forceInput: true,
      })
      continue
    }
    const promoted = item.promoted === true && inner.widget !== undefined
    const primaryType = freshenType(inner.type, item.binds.node, typeBindingsFor(node))
    // Fan-out: the PRIMARY binding stays authoritative for type and widget;
    // each additional target must resolve structurally (errors skip the
    // item) and should accept the derived type (advisory warning only -
    // documents are never rejected on type grounds). The boundary input is
    // satisfiable without a connection only when EVERY target is (each
    // falls back to its own stored value or optionality).
    let satisfiable = inner.optional || inner.widget !== undefined
    let fanoutOk = true
    if (item.alsoBinds !== undefined) {
      const seenTargets = new Set<string>([targetKeyOf(item.binds)])
      for (const [i, b] of item.alsoBinds.entries()) {
        const describe = `boundary input '${item.id}' fan-out target [${i}]`
        if (b.kind !== 'port') {
          fail('boundary.fanoutKind', `${describe} must be kind 'port' (family forwarding cannot fan out)`)
          fanoutOk = false
          continue
        }
        const key = targetKeyOf(b)
        if (seenTargets.has(key)) {
          fail('boundary.duplicateBind', `${describe} repeats target '${b.node}/${b.port}'${b.members ? ` member '${b.members.join('.')}'` : ''}`)
          fanoutOk = false
          continue
        }
        seenTargets.add(key)
        const r = routeForBinding(b, describe, 'input')
        if (!r) {
          fanoutOk = false
          continue
        }
        if (r.route.side !== 'input') {
          fail('boundary.sideMismatch', `${describe} binds an OUTPUT port '${b.port}'`)
          fanoutOk = false
          continue
        }
        // Unreachable: routeForBinding rejects family terminals on a 'port'
        // binding; narrows the type.
        if (r.route.terminal.kind !== 'port') continue
        const targetSlot = r.route.terminal.slot as InputSpec
        if (targetSlot.dynamic?.kind === 'dynamicCombo') {
          fail('boundary.selectorFanout', `${describe} targets a selector; selectors must be owned by their own boundary item`)
          fanoutOk = false
          continue
        }
        if (!typesCompatible(primaryType, freshenType(targetSlot.type, b.node, typeBindingsFor(r.node)))) {
          diags.push(diag('warning', 'schema', 'boundary.fanoutTypeMismatch', `[${def.id}] boundary input '${item.id}' fan-out target '${b.node}/${b.port}' does not accept the boundary type`))
        }
        if (!(targetSlot.optional || targetSlot.widget !== undefined)) satisfiable = false
      }
    }
    if (!fanoutOk) continue
    const promotedWidget = promoted ? {
      ...inner.widget!,
      ...(Object.hasOwn(node.values, item.binds.port as string)
        ? { default: node.values[item.binds.port as string] }
        : {}),
      ...(Object.hasOwn(node.controllers ?? {}, item.binds.port as string)
        ? { controllerInitial: node.controllers![item.binds.port as string] }
        : {}),
    } : undefined
    items.push({
      kind: 'input',
      id: item.id,
      ...displayNameOf(item, inner, 'input'),
      ...(inner.tooltip !== undefined ? { tooltip: inner.tooltip } : {}),
      type: primaryType,
      // A widget-backed inner input has a stored value, so the boundary
      // input is satisfiable without a connection.
      optional: satisfiable,
      ...([item.binds, ...(item.alsoBinds ?? [])].some((binding) => {
        const target = def.nodes[binding.node]
        const schema = target && resolveNode(target)
        return binding.kind === 'port' && schema !== undefined && outputSchemaInputsOf(schema).includes(binding.port as string)
      }) ? { outputSchemaSource: true as const } : {}),
      ...(promotedWidget !== undefined
        ? { widget: promotedWidget }
        : inner.widget !== undefined
          ? { forceInput: true }
          : {}),
      ...(inner.lazy !== undefined ? { lazy: inner.lazy } : {}),
    })
  }

  const projectDescriptors = (descriptors: OutputDescriptorsSpec, node: NodeData, subject: string): OutputDescriptorsSpec | undefined => {
    const promotedInput = (input: string): string | undefined => def.boundary!.inputs.find((candidate) =>
      candidate.promoted === true && items.some((derived) => derived.kind === 'input' && derived.id === candidate.id && derived.widget !== undefined) &&
      [candidate.binds, ...(candidate.alsoBinds ?? [])].some((binding) => binding.kind === 'port' && binding.node === node.id && binding.port === input && binding.members === undefined))?.id
    const source = descriptors.boundaryProjection?.fixed ? undefined : promotedInput(descriptors.input)
    const asset = descriptors.probe === undefined || descriptors.boundaryProjection?.assetFixed ? undefined : promotedInput(descriptors.probe.input)
    const linked = (!descriptors.boundaryProjection?.fixed && isInternallyConnected({ kind: 'port', node: node.id, port: descriptors.input as PortId }, descriptors.input)) ||
      (descriptors.probe !== undefined && !descriptors.boundaryProjection?.assetFixed && isInternallyConnected({ kind: 'port', node: node.id, port: descriptors.probe.input as PortId }, descriptors.probe.input))
    if (linked) {
      fail('boundary.outputDescriptors.linkedSource', `${subject} has a linked descriptor source`)
      return undefined
    }
    return {
      ...descriptors,
      input: source ?? descriptors.input,
      ...(descriptors.probe ? { probe: { ...descriptors.probe, input: asset ?? descriptors.probe.input } } : {}),
      boundaryProjection: {
        fallback: outputDescriptorValueOf(descriptors, node.values),
        ...(source === undefined ? { fixed: true as const } : {}),
        assetFallback: outputDescriptorAssetOf(descriptors, node.values),
        ...(asset === undefined ? { assetFixed: true as const } : {}),
      },
    }
  }
  for (const [index, input] of items.entries()) {
    if (input.kind !== 'input' || input.widget === undefined) continue
    const boundary = def.boundary.inputs.find((candidate) => candidate.id === input.id)
    if (!boundary?.promoted) continue
    const contracts = [boundary.binds, ...(boundary.alsoBinds ?? [])].flatMap((binding) => {
      const target = routeForBinding(binding, `boundary input '${input.id}'`, 'input', true)
      if (!target || target.route.terminal.kind !== 'port' || target.route.terminal.slot.kind !== 'input') return []
      const slot = target.route.terminal.slot
      const descriptors = slot.outputDescriptors ?? resolveNode(target.node)?.items.flatMap((item) =>
        item.kind === 'output' && item.outputDescriptors?.input === slot.id ? [item.outputDescriptors] : [])[0]
      return descriptors === undefined ? [] : [{ descriptors, node: target.node }]
    })
    const contract = contracts.find(({ descriptors }) => descriptors.probe !== undefined) ?? contracts[0]
    if (contract === undefined) continue
    const descriptors = projectDescriptors(contract.descriptors, contract.node, `boundary input '${input.id}'`)
    if (descriptors !== undefined) items[index] = { ...input, outputDescriptors: descriptors }
  }

  for (const item of def.boundary.outputs) {
    if (!checkId(item)) continue
    if (item.alsoBinds !== undefined) {
      fail('boundary.fanoutOnOutput', `boundary output '${item.id}': 'alsoBinds' is invalid on outputs (an output has exactly one source)`)
      continue
    }
    if (item.binds.kind === 'widgetTap') {
      const binding = item.binds
      const node = def.nodes[binding.node]
      if (node === undefined) {
        fail('boundary.danglingNode', `boundary output '${item.id}' binds missing node '${binding.node}'`)
        continue
      }
      const schema = resolveNode(node)
      if (schema === undefined) {
        fail('boundary.unresolvedSchema', `boundary output '${item.id}' binds node '${node.id}' of unresolvable type '${node.type}'`)
        continue
      }
      const resolvedTap = resolveStaticWidgetTap(schema, binding.tap)
      if (!resolvedTap.ok) {
        fail(
          resolvedTap.code,
          resolvedTap.code === 'boundary.tapUnsupported'
            ? `boundary output '${item.id}' must bind one static widget-backed input`
            : `boundary output '${item.id}' widget tap '${binding.tap}' resolves to ${resolvedTap.code === 'boundary.tapMissing' ? 0 : 'multiple'} static inputs`,
        )
        continue
      }
      const inner = resolvedTap.input
      items.push({
        kind: 'output',
        id: item.id,
        ...displayNameOf(item, inner, 'output'),
        ...(inner.tooltip !== undefined ? { tooltip: inner.tooltip } : {}),
        type: freshenType(inner.type, binding.node, typeBindingsFor(node)),
      })
      continue
    }
    const resolved = routeFor(item, 'output')
    if (!resolved) continue
    const { node, route } = resolved
    if (route.side !== 'output') {
      fail('boundary.sideMismatch', `boundary output '${item.id}' binds an INPUT port '${item.binds.port}'`)
      continue
    }
    // Output-family template slots are InputSpecs; the top-level family item
    // owns isList (mirrors elaboration's toOutputSpec reshaping).
    const isList = (route.topItem as OutputSpec).isList
    const preview = (route.topItem as OutputSpec).preview
    if (route.terminal.kind === 'family') {
      if (item.promoted !== undefined) {
        fail('boundary.familyPromoted', `boundary output '${item.id}': 'promoted' is invalid on whole-family forwarding`)
        continue
      }
      if (!checkForwardUnique(item, 'output', route)) continue
      const baseDerived = deriveFamilySpec(item, 'output', node, route)
      if (!baseDerived) continue
      const terminalSpec = route.terminal.spec
      const count = 'count' in terminalSpec
        ? projectOutputCount(item, node, terminalSpec as CountBoundOutputAutogrowSpec)
        : undefined
      if ('count' in terminalSpec && count === undefined) continue
      const derived = count === undefined ? baseDerived : { ...baseDerived, count }
      const declaring = route.terminal.declaring
      items.push({
        kind: 'output',
        id: item.id,
        ...displayNameOf(item, declaring, 'output'),
        ...(declaring.tooltip !== undefined ? { tooltip: declaring.tooltip } : {}),
        type: freshenType(declaring.type, item.binds.node, typeBindingsFor(node)),
        ...(isList !== undefined ? { isList } : {}),
        ...(preview !== undefined ? { preview } : {}),
        dynamic: derived,
      })
      continue
    }
    const inner = route.terminal.slot
    const descriptors = inner.kind === 'output' ? inner.outputDescriptors : undefined
    const projectedDescriptors = descriptors === undefined ? undefined : projectDescriptors(descriptors, node, `boundary output '${item.id}'`)
    if (descriptors !== undefined && projectedDescriptors === undefined) continue
    items.push({
      kind: 'output',
      id: item.id,
      ...displayNameOf(item, inner, 'output'),
      ...(inner.tooltip !== undefined ? { tooltip: inner.tooltip } : {}),
      type: freshenType(inner.type, item.binds.node, typeBindingsFor(node)),
      ...(isList !== undefined ? { isList } : {}),
      ...(preview !== undefined ? { preview } : {}),
      ...(projectedDescriptors !== undefined ? { outputDescriptors: projectedDescriptors } : {}),
    })
  }

  // Output-node status: any inner node whose schema is an output node makes
  // the instance one (partial-execution scoping descends through instances).
  // Preview capability aggregates the same way: an instance emits previews
  // iff any inner node's schema does (nested subgraphs compose because inner
  // instances resolve to derived schemas).
  let isOutputNode = false
  let emitsPreviews = false
  for (const node of Object.values(def.nodes)) {
    const schema = resolveNode(node)
    if (schema?.isOutputNode) isOutputNode = true
    if (schema?.emitsPreviews) emitsPreviews = true
    if (isOutputNode && emitsPreviews) break
    if (!schema && subgraphDefIdOf(node.type) === undefined) {
      diags.push(
        diag('warning', 'schema', 'boundary.innerUnresolved', `[${def.id}] inner node '${node.id}' type '${node.type}' is unresolvable; derived capabilities may be understated`),
      )
    }
  }

  let derivedItems = items
  if (region !== undefined) {
    const elements = new Set(region.elementPorts ?? [])
    const state = new Set(region.statePorts ?? [])
    const outputRoles = region.outputRoles ?? {}
    const stateInputTypes = new Map(
      items.flatMap((item) => item.kind === 'input' && state.has(item.id) ? [[item.id, item.type] as const] : []),
    )
    const projected: InterfaceItem[] = []
    for (const item of items) {
      if (item.kind === 'input') {
        if (elements.has(item.id)) {
          if (item.widget !== undefined) {
            fail('doc.region.elementPromoted', `region element input '${item.id}' cannot promote a scalar widget`)
          }
          projected.push({ ...item, type: { kind: 'list', element: item.type } })
        } else {
          // State and broadcast ports retain the ordinary boundary contract.
          projected.push(item)
        }
        continue
      }
      if (item.kind === 'section') {
        projected.push(item)
        continue
      }
      const sourceType: TypeExpr = item.isList === true ? { kind: 'list', element: item.type } : item.type
      if (item.id === region.continueOutput) {
        const severity = regionSourceMismatch(sourceType, { kind: 'concrete', name: 'core.boolean' })
        if (severity !== undefined) {
          diags.push(diag(severity, 'schema', 'doc.region.continueNotBoolean', `[${def.id}] region continue output '${item.id}' is not statically core.boolean`))
        }
        continue
      }
      const role = Object.hasOwn(outputRoles, item.id) ? outputRoles[item.id] : undefined
      if (role === undefined || role.kind === 'gather' || role.kind === 'compact') {
        if (canonicalTypeIdOf(sourceType) === undefined) {
          const roleName = role?.kind ?? 'gather'
          diags.push(diag('warning', 'schema', 'doc.region.gatherNonConcrete', `[${def.id}] region ${roleName} output '${item.id}' is not statically runtime-resolvable`))
        }
        const { isList: _isList, ...withoutLegacyList } = item
        projected.push({ ...withoutLegacyList, type: { kind: 'list', element: sourceType } })
      } else if (role.kind === 'flatten') {
        if (sourceType.kind !== 'list') {
          fail('doc.region.flattenNonList', `region flatten output '${item.id}' requires a list-typed body output`)
        } else {
          if (canonicalTypeIdOf(sourceType) === undefined) {
            diags.push(diag('warning', 'schema', 'doc.region.flattenNonConcrete', `[${def.id}] region flatten output '${item.id}' is not statically runtime-resolvable`))
          }
          const { isList: _isList, ...withoutLegacyList } = item
          projected.push({ ...withoutLegacyList, type: sourceType })
        }
      } else {
        const carriedType = stateInputTypes.get(role.statePort)
        const severity = carriedType === undefined ? undefined : regionSourceMismatch(sourceType, carriedType)
        if (severity !== undefined) {
          const message = `[${def.id}] region state output '${item.id}' does not produce a value compatible with state input '${role.statePort}'`
          diags.push(diag(severity, 'schema', 'doc.region.stateTypeMismatch', message))
        }
        const { isList: _isList, ...withoutLegacyList } = item
        projected.push({ ...withoutLegacyList, type: carriedType ?? sourceType })
      }
    }
    derivedItems = projected
  }

  if (diags.some((d) => d.severity === 'error')) return { diagnostics: diags }

  return {
    schema: {
      type: `#${def.id}`,
      displayName: def.name,
      category: 'subgraph',
      source: 'subgraph',
      items: derivedItems,
      isOutputNode,
      ...(emitsPreviews ? { emitsPreviews: true } : {}),
    },
    diagnostics: diags,
  }
}
