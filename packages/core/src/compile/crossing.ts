/**
 * Family crossings are the one address-translation abstraction for
 * whole-family forwarding through subgraph boundaries.
 *
 * Every lowering concern that crosses a forwarded boundary - dynamic state
 * overlays, link/value address translation, connectivity projection - goes
 * through the SAME FamilyCrossing object, built from the SAME structural
 * route resolution that schema derivation uses (`resolveBoundaryRoute`).
 * Do not independently reimplement what an outer address means inside.
 *
 * Identity model (hazard F1/F3):
 * - Definition-local members persist on the inner node in the definition;
 *   instance-appended members persist on the instance node in ITS parent.
 * - The concatenated list exists ONLY in derived per-occurrence state
 *   (`overlayNodeDynamic`), fed to the ordinary `elaborateInterface`.
 * - Instance member ids are REBASED (NUL-prefixed) when projected into the
 *   inner node's namespace so they can never collide with definition prefix
 *   ids. NUL is the established internal packing character (ids.ts); it is
 *   unmintable by commands and survives chained forwarding by accumulating
 *   one prefix per crossing. Rebased ids are derived compiler state - they
 *   never persist, and documents never contain them.
 * - Count-bound output members already have canonical numeric identity, so
 *   they map directly and carry occurrence values instead of dynamic state.
 */

import { isForwardingBinding, isSubtreeBinding, type BoundaryBinding, type BoundaryItem, type DynamicPortState, type GraphDef, type Json, type NodeData } from '../format/document.js'
import { asDynamicMemberId, asNodeId, asPortId, type NodeId, type PortRef } from '../ids.js'
import { memberHopsOf, resolveBoundaryRoute, type BoundaryRoute, type SchemaResolver } from '../schema/derive-boundary.js'
import { addressOfElabKey, elabKeyOf, DEFAULT_ELAB_BUDGET } from '../schema/elaborate.js'
import { autogrowBounds, outputSchemaInputsOf, outputCountValueOf, type CountBoundOutputAutogrowSpec, type NodeSchema } from '../schema/model.js'

/**
 * One forwarded family on one subgraph instance: how outer addresses under
 * `boundaryId` map to the inner target family.
 */
export interface FamilyCrossing {
  readonly boundaryId: string
  readonly side: 'input' | 'output'
  /** Inner node (in the child definition) the forwarded family lives on. */
  readonly targetNode: NodeId
  /** Concrete ancestor member ids crossed to reach the family (outermost first). */
  readonly hopMembers: readonly string[]
  /** Full construct paths of the crossed ancestor families, aligned with hopMembers. */
  readonly hopPaths: readonly string[]
  /** Inner construct path of the forwarded family ('images', 'items.sub'). */
  readonly familyPath: string
  /** Instance suffix member id -> rebased inner member id (insertion = display order). */
  readonly rebase: ReadonlyMap<string, string>
  /** Canonical count-bound members map directly instead of owning dynamic suffix state. */
  readonly countBound?: true
  /**
   * Slot-selective forwarding (hazard F10): the template slot paths the
   * boundary exposes (dotted entries narrow nested autogrow constructs);
   * undefined = the whole template. Outer addresses under an unexposed slot
   * fail translation loudly - a stale document must never silently write
   * through a hidden slot.
   */
  readonly slots?: ReadonlySet<string>
  /** Additional input targets in declared alsoBinds order. Outputs never carry these. */
  readonly alsoCrossings?: readonly FamilyCrossing[]
}

export interface SubtreeCrossing {
  readonly kind: 'subtree'
  readonly boundaryId: string
  readonly side: 'input'
  readonly targetNode: NodeId
  readonly hopMembers: readonly string[]
  readonly hopPaths: readonly string[]
  readonly constructPath: string
}

export type BoundaryCrossing = FamilyCrossing | SubtreeCrossing
export const isSubtreeCrossing = (crossing: BoundaryCrossing): crossing is SubtreeCrossing => 'kind' in crossing

export const crossingTargets = (crossing: BoundaryCrossing): readonly BoundaryCrossing[] =>
  isSubtreeCrossing(crossing) ? [crossing] : [crossing, ...(crossing.alsoCrossings ?? [])]

export interface CrossingProblem {
  readonly code: string
  readonly message: string
}

export type CrossingsResult = {
  /** Boundary item id -> crossing for each forwarded family or subtree. */
  readonly crossings: ReadonlyMap<string, BoundaryCrossing>
  readonly problems: readonly CrossingProblem[]
}

/** Rebased inner id of an instance-appended member (see module header). */
const rebasedIdOf = (id: string): string => `\u0000${id}`

/** Project promoted output-schema literals onto their inner occurrence nodes. */
export function projectCountBoundValues(
  child: GraphDef,
  instanceValues: Readonly<Record<string, Json>>,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
): ReadonlyMap<NodeId, Readonly<Record<string, Json>>> {
  const projected = new Map<NodeId, Record<string, Json>>()
  const claimed = new Map<NodeId, Set<string>>()
  for (const item of child.boundary?.inputs ?? []) {
    if (item.promoted !== true || item.binds.kind !== 'port') continue
    const ownerNode = child.nodes[item.binds.node]
    const ownerSchema = ownerNode && resolveNode(ownerNode)
    const ownerRoute = ownerSchema && resolveBoundaryRoute(ownerSchema, item.binds, 'input')
    if (!ownerRoute?.ok || ownerRoute.route.terminal.kind !== 'port' || ownerRoute.route.terminal.slot.kind !== 'input' || ownerRoute.route.terminal.slot.widget === undefined) continue
    const value = instanceValues[item.id]
    if (value === undefined) continue
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (binding.kind !== 'port' || binding.members !== undefined) continue
      const target = child.nodes[binding.node]
      const schema = target && resolveNode(target)
      if (!target || !schema || !outputSchemaInputsOf(schema).includes(binding.port as string)) continue
      let keys = claimed.get(target.id)
      if (!keys) claimed.set(target.id, (keys = new Set()))
      if (keys.has(binding.port as string)) continue
      keys.add(binding.port as string)
      let values = projected.get(target.id)
      if (!values) projected.set(target.id, (values = { ...target.values }))
      values[binding.port as string] = value
    }
  }
  return projected
}

// ---------------------------------------------------------------------------
// Boundary item selection (the ONE interpreter of instance addresses)
// ---------------------------------------------------------------------------

export interface BoundaryAddr {
  readonly port: string
  readonly members?: readonly string[]
}

export type BoundaryMatch =
  | { readonly ok: true; readonly item: BoundaryItem }
  | { readonly ok: false; readonly code: 'missing' | 'ambiguous'; readonly message: string }

/**
 * Select THE boundary item an instance-side address refers to. Boundary ids
 * may legally contain '.', so first-segment shortcuts are banned - the same
 * rule `resolveBoundaryRoute` enforces structurally: enumerate every
 * candidate interpretation and require exactly one to fit.
 * - concrete item ('port' binding): the address is exactly its id, with no
 *   member path (the INSTANCE-side port is a plain static port even when its
 *   inner binding targets a dynamic member through `binds.members`)
 * - family item: exactly its id, or any dotted extension of it (stamped
 *   member addresses extend the family id with template slot paths)
 */
export function matchBoundaryItem(items: readonly BoundaryItem[], addr: BoundaryAddr): BoundaryMatch {
  const candidates = items.filter((i) =>
    isForwardingBinding(i.binds)
      ? addr.port === i.id || addr.port.startsWith(`${i.id}.`)
      : addr.port === i.id && addr.members === undefined,
  )
  if (candidates.length === 1) return { ok: true, item: candidates[0]! }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'missing',
      message: `no boundary item matches '${addr.port}'${addr.members ? ` member '${addr.members.join('.')}'` : ''}`,
    }
  }
  return {
    ok: false,
    code: 'ambiguous',
    message: `address '${addr.port}' matches ${candidates.length} boundary items (${candidates.map((c) => `'${c.id}'`).join(', ')}); dotted boundary ids collide`,
  }
}

/**
 * Build the crossings of one subgraph instance from its child definition's
 * boundary and the instance node's OCCURRENCE-LOCAL dynamic state (overlay
 * when the instance itself sits under forwarding, else its persisted state).
 * All members of that state are suffix members relative to the child - for
 * chained forwarding the already-rebased ids simply rebase again.
 */
export function buildBoundaryCrossings(
  child: GraphDef,
  resolve: SchemaResolver,
  instanceDynamic: Readonly<Record<string, DynamicPortState>> | undefined,
  resolveNode: (node: NodeData) => NodeSchema | undefined = (node) => resolve(node.type),
  instanceValues: Readonly<Record<string, Json>> = {},
): CrossingsResult {
  const crossings = new Map<string, BoundaryCrossing>()
  const problems: CrossingProblem[] = []
  if (!child.boundary) return { crossings, problems }
  const projectedCounts = projectCountBoundValues(child, instanceValues, resolveNode)
  const sides = [
    { items: child.boundary.inputs, side: 'input' as const },
    { items: child.boundary.outputs, side: 'output' as const },
  ]
  for (const { items, side } of sides) {
    for (const item of items) {
      if (side === 'output' && item.alsoBinds !== undefined) {
        problems.push({
          code: 'compile.boundary.forwardUnresolved',
          message: `boundary output '${item.id}' of '${child.id}' cannot fan out`,
        })
        continue
      }
      if (!isForwardingBinding(item.binds)) continue
      const crossingFor = (binding: BoundaryBinding): BoundaryCrossing | undefined => {
        const node = child.nodes[binding.node]
        const schema = node && resolveNode(node)
        if (!node || !schema) {
          problems.push({
            code: 'compile.boundary.forwardUnresolved',
            message: `boundary ${side} '${item.id}' of '${child.id}' forwards through missing/unresolvable node '${binding.node}'`,
          })
          return undefined
        }
        const result = resolveBoundaryRoute(schema, binding, side)
        if (!result.ok || (isSubtreeBinding(binding)
          ? side !== 'input' || result.route.terminal.kind !== 'port'
          : result.route.terminal.kind !== 'family')) {
          problems.push({
            code: 'compile.boundary.forwardUnresolved',
            message: `boundary ${side} '${item.id}' of '${child.id}': ${result.ok ? `'${binding.port}' is not a dynamic family` : result.message}`,
          })
          return undefined
        }
        const route = result.route
        // Every concrete ancestor member the route crosses must be
        // MATERIALIZED in the definition: present in that family's persisted
        // `members` list at the corresponding scope. `members` is the sole
        // membership/order source (hazard F3) - orphan `memberState` for a
        // removed member proves nothing, and silently deriving state beneath
        // an absent ancestor would make the instance suffix unreachable.
        let scope: Readonly<Record<string, DynamicPortState>> | undefined = child.nodes[binding.node]?.dynamic
        let missingHop: string | undefined
        for (const hop of memberHopsOf(route.hops)) {
          const st = scope?.[hop.familyPath]
          if (!st?.members?.includes(hop.member)) {
            missingHop = `member '${hop.member}' of family '${hop.familyPath}'`
            break
          }
          scope = st.memberState?.[hop.member]
        }
        if (missingHop !== undefined) {
          problems.push({
            code: 'compile.boundary.forwardAncestorMissing',
            message: `boundary ${side} '${item.id}' of '${child.id}' forwards through ${missingHop}, which is not materialized on node '${binding.node}'`,
          })
          return undefined
        }
        if (isSubtreeBinding(binding)) return {
          kind: 'subtree', boundaryId: item.id, side: 'input', targetNode: binding.node,
          constructPath: binding.port,
          hopMembers: memberHopsOf(route.hops).map((hop) => hop.member),
          hopPaths: memberHopsOf(route.hops).map((hop) => hop.familyPath),
        }
        const terminal = route.terminal as Extract<BoundaryRoute['terminal'], { kind: 'family' }>
        const countBound = side === 'output' && 'count' in terminal.spec
        const count = countBound
          ? outputCountValueOf(terminal.spec as CountBoundOutputAutogrowSpec, projectedCounts.get(node.id) ?? node.values)
          : undefined
        const countBounds = countBound ? autogrowBounds(terminal.spec) : undefined
        const countValid = countBounds !== undefined && Number.isSafeInteger(count) &&
          (count as number) >= countBounds.min &&
          (count as number) <= Math.min(countBounds.max, DEFAULT_ELAB_BUDGET.maxMembers)
        const suffix = countBound
          ? countValid
            ? Array.from({ length: count as number }, (_, index) => String(index))
            : []
          : instanceDynamic?.[item.id]?.members ?? []
        const rebase = new Map<string, string>()
        for (const m of suffix) rebase.set(m, countBound ? m : rebasedIdOf(m))
        return {
          boundaryId: item.id,
          side,
          targetNode: asNodeId(binding.node),
          hopMembers: memberHopsOf(route.hops).map((h) => h.member),
          hopPaths: memberHopsOf(route.hops).map((h) => h.familyPath),
          familyPath: terminal.familyPath,
          rebase,
          ...(countBound ? { countBound: true } : {}),
          ...(binding.slots !== undefined ? { slots: new Set(binding.slots) } : {}),
        }
      }
      const primary = crossingFor(item.binds)
      const additional = side === 'input' ? (item.alsoBinds ?? []).map(crossingFor) : []
      if (primary !== undefined && additional.every((crossing) => crossing !== undefined)) {
        crossings.set(item.id, {
          ...primary,
          ...(additional.length > 0 ? { alsoCrossings: additional as FamilyCrossing[] } : {}),
        })
      }
    }
  }
  return { crossings, problems }
}

// ---------------------------------------------------------------------------
// Address translation (outer instance address -> inner node address)
// ---------------------------------------------------------------------------

export type TranslateResult =
  | { readonly ok: true; readonly ref: PortRef }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Translate an address on the INSTANCE (`{port: '<boundaryId>[.rest]',
 * members: [suffixId, ...deeper]}`) to the inner node's address. The first
 * member id must be an instance-appended suffix member (the instance's
 * interface exposes ONLY those; definition prefix members are interior and
 * unaddressable from outside - hazard F1). Deeper member ids are wholly
 * instance-owned and copy verbatim.
 */
export function translateThroughCrossing(
  crossing: BoundaryCrossing,
  addr: { readonly port: string; readonly members?: readonly string[] },
): TranslateResult {
  const { boundaryId } = crossing
  const rest =
    addr.port === boundaryId
      ? ''
      : addr.port.startsWith(`${boundaryId}.`)
        ? addr.port.slice(boundaryId.length)
        : undefined
  if (rest === undefined) {
    return {
      ok: false,
      code: 'compile.boundary.forwardMismatch',
      message: `address '${addr.port}' does not belong to forwarded family '${boundaryId}'`,
    }
  }
  const members = addr.members ?? []
  if (isSubtreeCrossing(crossing)) return {
    ok: true,
    ref: { node: crossing.targetNode, port: asPortId(`${crossing.constructPath}${rest}`),
      ...((crossing.hopMembers.length || members.length) ? { members: [...crossing.hopMembers, ...members].map(asDynamicMemberId) } : {}),
    },
  }
  if (members.length === 0) {
    return {
      ok: false,
      code: 'compile.boundary.forwardMemberMissing',
      message: `address '${addr.port}' targets forwarded family '${boundaryId}' without a member id`,
    }
  }
  // Slot selection (hazard F10): the exposed interface contains only the
  // selected slot paths, so any address under an unexposed one is stale
  // state. Matched STRUCTURALLY against the selected entries (never by
  // splitting the address into ids - dotted entries are the FIELD's own
  // grammar; template slot ids never legally contain dots). An address is
  // exposed if it sits at/under a selected path, OR is an ANCESTOR construct
  // of one (selecting 'sub.s' keeps the nested family 'sub' itself
  // addressable - growth and member state target the construct).
  if (crossing.slots !== undefined && rest !== '') {
    const exposed = [...crossing.slots].some((s) => {
      const e = `.${s}`
      return rest === e || rest.startsWith(`${e}.`) || e.startsWith(`${rest}.`)
    })
    if (!exposed) {
      return {
        ok: false,
        code: 'compile.boundary.slotNotExposed',
        message: `address '${addr.port}' targets slot path '${rest.slice(1)}' of forwarded family '${boundaryId}', which is not among its selected slots`,
      }
    }
  }
  const rebased = crossing.rebase.get(members[0]!)
  if (rebased === undefined) {
    return {
      ok: false,
      code: 'compile.boundary.forwardUnknownMember',
      message: `member '${members[0]}' of forwarded family '${boundaryId}' is not an instance-appended member`,
    }
  }
  return {
    ok: true,
    ref: {
      node: crossing.targetNode,
      port: asPortId(`${crossing.familyPath}${rest}`),
      members: [...crossing.hopMembers, rebased, ...members.slice(1)].map(asDynamicMemberId),
    },
  }
}

// ---------------------------------------------------------------------------
// Occurrence-local dynamic-state overlay (hazard F1: derive, never persist)
// ---------------------------------------------------------------------------

/**
 * Rewrite an instance-side member scope (construct keys rooted at the
 * boundary id, 'pics.sub') to inner construct paths ('images.sub'),
 * recursively through nested memberState. Non-matching keys copy verbatim:
 * they are unreachable dormant state either way (preserved-by-design, like
 * dormant values).
 */
const rewriteScope = (
  scope: Readonly<Record<string, DynamicPortState>>,
  from: string,
  to: string,
  subtreeOnly = false,
): Record<string, DynamicPortState> => {
  const out: Record<string, DynamicPortState> = {}
  for (const [key, state] of Object.entries(scope)) {
    if (subtreeOnly && key !== from && !key.startsWith(`${from}.`)) continue
    const rewritten = key === from ? to : key.startsWith(`${from}.`) ? `${to}${key.slice(from.length)}` : key
    out[rewritten] = rewriteState(state, from, to)
  }
  return out
}

const rewriteState = (state: DynamicPortState, from: string, to: string): DynamicPortState => {
  if (state.memberState === undefined) return state
  const memberState: Record<string, Record<string, DynamicPortState>> = {}
  for (const [member, scope] of Object.entries(state.memberState)) {
    memberState[member] = rewriteScope(scope, from, to)
  }
  return { ...state, memberState }
}

/** Field presence, not validity, controls inheritance; empty states mask defaults. */
export function mergeDynamicScope(
  inherited: Readonly<Record<string, DynamicPortState>> | undefined,
  authored: Readonly<Record<string, DynamicPortState>> | undefined,
): Record<string, DynamicPortState> {
  const result = { ...inherited }
  for (const [key, outer] of Object.entries(authored ?? {})) {
    const inner = inherited?.[key]
    if (!inner || Object.keys(outer).length === 0) {
      result[key] = outer
      continue
    }
    let memberState = inner.memberState
    if (outer.memberState !== undefined) {
      memberState = Object.keys(outer.memberState).length === 0 ? {} : { ...inner.memberState }
      for (const [member, scope] of Object.entries(outer.memberState)) {
        memberState = { ...memberState, [member]: Object.keys(scope).length === 0
          ? {} : mergeDynamicScope(inner.memberState?.[member], scope) }
      }
    }
    result[key] = { ...inner, ...outer, ...(memberState !== undefined ? { memberState } : {}) }
  }
  return result
}

/** Rekey values and controller modes using the canonical elaborated-address codec. */
export function rekeySubtreeValues<T>(
  values: Readonly<Record<string, T>> | undefined,
  crossing: SubtreeCrossing,
): Record<string, T> {
  const result: Record<string, T> = {}
  const from = crossing.constructPath
  const to = crossing.boundaryId
  for (const [key, value] of Object.entries(values ?? {})) {
    const address = addressOfElabKey(key, true)
    if (!address || (address.port !== from && !address.port.startsWith(`${from}.`))) continue
    const members = address.members ?? []
    if (crossing.hopMembers.some((member, index) => members[index] !== member)) continue
    const mapped = members.slice(crossing.hopMembers.length)
    result[elabKeyOf({ port: `${to}${address.port.slice(from.length)}`, ...(mapped.length ? { members: mapped.map(asDynamicMemberId) } : {}) })] = value
  }
  return result
}

/** Project persisted values/controllers through the same route as connections. */
export function projectCrossingValues<T>(values: Readonly<Record<string, T>> | undefined, crossing: BoundaryCrossing): Record<string, T> {
  const result: Record<string, T> = {}
  for (const [key, value] of Object.entries(values ?? {})) {
    const address = addressOfElabKey(key, true)
    if (!address) continue
    const translated = translateThroughCrossing(crossing, address)
    if (translated.ok) result[elabKeyOf(translated.ref)] = value
  }
  return result
}

export type BoundaryNodeState = Pick<NodeData, 'values' | 'controllers' | 'dynamic'>

/** Read one complete inner subtree in the instance's coordinate system. */
export function inheritSubtreeState(inner: BoundaryNodeState, crossing: SubtreeCrossing): BoundaryNodeState {
  let scope = inner.dynamic
  for (const [index, member] of crossing.hopMembers.entries()) scope = scope?.[crossing.hopPaths[index]!]?.memberState?.[member]
  return {
    dynamic: rewriteScope(scope ?? {}, crossing.constructPath, crossing.boundaryId, true),
    values: rekeySubtreeValues(inner.values, crossing),
    controllers: rekeySubtreeValues(inner.controllers, crossing),
  }
}

/**
 * Merge the definition-local family state (prefix) with the instance's
 * family state (suffix) into ONE derived DynamicPortState: prefix members
 * first (hazard F2), suffix member ids rebased, suffix nested state rekeyed
 * to inner construct paths. Pure - neither source object is touched.
 */
const mergeFamilyState = (
  defState: DynamicPortState | undefined,
  instState: DynamicPortState | undefined,
  crossing: FamilyCrossing,
): DynamicPortState => {
  const suffix = instState?.members ?? []
  const members = [...(defState?.members ?? []), ...suffix.map((m) => crossing.rebase.get(m) ?? rebasedIdOf(m))]
  const memberLabels: Record<string, string> = { ...defState?.memberLabels }
  for (const [member, label] of Object.entries(instState?.memberLabels ?? {})) {
    const rebased = crossing.rebase.get(member)
    if (rebased !== undefined) memberLabels[rebased] = label
  }
  const memberState: Record<string, Record<string, DynamicPortState>> = { ...defState?.memberState }
  for (const [member, scope] of Object.entries(instState?.memberState ?? {})) {
    const rebased = crossing.rebase.get(member)
    // State for a member id that is not in the suffix list is dormant
    // (removed member) - it has no reachable inner identity; leave it behind.
    if (rebased === undefined) continue
    memberState[rebased] = rewriteScope(scope, crossing.boundaryId, crossing.familyPath)
  }
  return {
    ...defState,
    members,
    ...(Object.keys(memberLabels).length > 0 ? { memberLabels } : {}),
    ...(Object.keys(memberState).length > 0 ? { memberState } : {}),
  }
}

/**
 * Apply one crossing's suffix onto the inner node's dynamic state, at the
 * exact scope the route names (walking hop members through memberState).
 * Returns a NEW record; `base` (definition state or a previously applied
 * overlay for another crossing on the same node) is never mutated.
 */
export function overlayNodeDynamic(
  base: Readonly<Record<string, DynamicPortState>> | undefined,
  crossing: BoundaryCrossing,
  instanceDynamic: Readonly<Record<string, DynamicPortState>> | undefined,
): Readonly<Record<string, DynamicPortState>> {
  if (!isSubtreeCrossing(crossing) && crossing.countBound) return base ?? {}
  const apply = (
    scope: Readonly<Record<string, DynamicPortState>> | undefined,
    depth: number,
  ): Record<string, DynamicPortState> => {
    if (depth >= crossing.hopMembers.length) {
      if (isSubtreeCrossing(crossing)) return mergeDynamicScope(scope, rewriteScope(instanceDynamic ?? {}, crossing.boundaryId, crossing.constructPath, true))
      return {
        ...scope,
        [crossing.familyPath]: mergeFamilyState(scope?.[crossing.familyPath], instanceDynamic?.[crossing.boundaryId], crossing),
      }
    }
    const path = crossing.hopPaths[depth]!
    const member = crossing.hopMembers[depth]!
    const state = scope?.[path] ?? {}
    return {
      ...scope,
      [path]: {
        ...state,
        memberState: {
          ...state.memberState,
          [member]: apply(state.memberState?.[member], depth + 1),
        },
      },
    }
  }
  return apply(base, 0)
}

/**
 * Overlay one conditional selector at its exact member scope. Unlike family
 * merging this replaces only `selected`; siblings and nested member state are
 * copied so several projections onto one node compose in either order.
 */
export function overlaySelectorDynamic(
  base: Readonly<Record<string, DynamicPortState>> | undefined,
  route: BoundaryRoute,
  constructPath: string,
  selected: string,
): Readonly<Record<string, DynamicPortState>> {
  const members = memberHopsOf(route.hops)
  const apply = (scope: Readonly<Record<string, DynamicPortState>> | undefined, depth: number): Record<string, DynamicPortState> => {
    if (depth === members.length) return { ...scope, [constructPath]: { ...scope?.[constructPath], selected } }
    const hop = members[depth]!
    const state = scope?.[hop.familyPath] ?? {}
    return {
      ...scope,
      [hop.familyPath]: {
        ...state,
        memberState: { ...state.memberState, [hop.member]: apply(state.memberState?.[hop.member], depth + 1) },
      },
    }
  }
  return apply(base, 0)
}
