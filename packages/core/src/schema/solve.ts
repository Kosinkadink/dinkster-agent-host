/**
 * Type constraint solving is stage 2 of the derived-state pipeline.
 *
 * Solves MatchType variables over one graph definition's ELABORATED
 * topology. Strictly advisory and strictly downstream: results color pins
 * and noodles, badge conflicts, and refine drop-target highlighting - they
 * are NEVER written back into the document or schema, and NEVER feed
 * elaboration (the anti-oscillation DAG: document -> elaboration -> solving
 * -> rendering). Conflicting links are marked, not auto-disconnected: a
 * stale document must stay loadable and fixable.
 *
 * Semantics (matching backend V3 validation):
 * - '*' (wildcard) imposes NO constraint. It is not a type variable; it
 *   never captures and never propagates ("no permanent wildcard capture").
 * - Concrete/union types check per edge by atom-set overlap. A union
 *   producer ('IMAGE,LATENT') can feed an IMAGE consumer and a LATENT
 *   consumer simultaneously - unions are never collapsed by solving.
 * - MatchType templates are variables freshened PER NODE OCCURRENCE:
 *   variable identity is (nodeId, templateId). Two instances of one
 *   (subgraph) schema resolve independently. derive-boundary namespaces
 *   inner templates per inner node ('n0:T'); prefixing the instance node id
 *   here compounds to per-occurrence freshness through nesting.
 * - A variable's domain starts at its declared allowedTypes (unrestricted
 *   when absent) and is intersected by every atom-typed edge or authoritative
 *   DynamicSlot selection; var-var edges merge variables (union-find) and
 *   intersect domains. Equality among ports sharing a templateId within one
 *   node is free: same variable.
 * - Resolution: 'resolved' (constrained to one atom), 'ambiguous'
 *   (constrained, several atoms remain - render as the union),
 *   'conflict' (empty domain - every contributing edge is marked and one
 *   diagnostic anchors to a contributing link), or 'unconstrained' (no
 *   concrete constraint touches it - render the declared expression).
 *   Conflict blame is the full contributing edge set, deterministically -
 *   never "whichever link happened to come last".
 *
 * Edges are the type-carrying adjacencies of the definition:
 * - links whose `to` is a node input, with `from` traced upstream through
 *   reroute chains to the real producer (structural feeds into reroutes
 *   carry no constraint themselves; undriven/cyclic chains constrain
 *   nothing);
 * - widget output taps use the widget input's declared type when its value is
 *   local, or trace through that input when another producer drives it;
 * - a selector OUTPUT expands to EVERY candidate branch's producer (policy
 *   can change at any time, so all branches must stay compatible); an
 *   unconsumed selector constrains nothing - it is a type-agnostic
 *   passthrough like a reroute, never a unifier of its own branches;
 * - named-net (source, sink) pairs;
 * - value-source feeds carry values, not types: no constraint.
 *
 * Complexity: O(nodes + elaborated ports + edges * alpha) per definition -
 * one elaboration pass per node, one union-find over edges.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { GraphDef, LinkData, NodeData } from '../format/document.js'
import { asPortId, isPortEndpoint, type LinkId, type NodeId, type PortRef } from '../ids.js'
import { buildRerouteIndex, traceEndpointAll } from '../reroute.js'
import { assetCoercible, atomNamesOf, canonicalCompatTypeIdOf, coercionTargetsOf, typesCompatible } from './compat.js'
import type { SchemaResolver } from './derive-boundary.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elabKeyOf,
  elabOutputsOf,
  elaborateInterface,
  type Connectivity,
  type ElaborateOptions,
} from './elaborate.js'
import { cardinalityOf, effectiveAbsentPolicy, parseAssetTypeId, parseListTypeId, parseStreamTypeId, typeExprFromTypeId, type TypeExpr } from './model.js'

/** Every variable occurring in `t`, including inside list/asset elements. */
function* nestedVariablesOf(t: TypeExpr): Generator<TypeExpr & { kind: 'variable' }> {
  if (t.kind === 'variable') yield t
  else if (t.kind === 'list' || t.kind === 'asset' || t.kind === 'stream') yield* nestedVariablesOf(t.element)
}

const substituteTypeBindings = (
  type: TypeExpr,
  bindings: ReadonlyMap<string, TypeExpr>,
): TypeExpr => {
  if (type.kind === 'variable') return bindings.get(type.templateId) ?? type
  if (type.kind !== 'list' && type.kind !== 'asset' && type.kind !== 'stream') return type
  const element = substituteTypeBindings(type.element, bindings)
  return element === type.element ? type : { kind: type.kind, element }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type VarResolution =
  /** No concrete constraint binds it; render the declared expression. */
  | { readonly kind: 'unconstrained' }
  | { readonly kind: 'resolved'; readonly name: string }
  /** Valid but not pinned to one atom; render as the union of `names`. */
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] }
  | { readonly kind: 'conflict' }

/**
 * Per-edge verdict. 'unknown' means the solver could not type an endpoint
 * (unresolvable schema, port not currently elaborated) - structurally the
 * validator's business, not a type mismatch.
 */
export type EdgeVerdict = 'ok' | 'mismatch' | 'unknown'

/** Key for a named-net sink's verdict: the net id plus sink ordinal. */
export const netSinkKey = (netId: string, sinkIndex: number): string => `${netId}[${sinkIndex}]`

export interface SolveResult {
  /** Resolution of variable `templateId` as it occurs on node `node`. */
  resolutionOf(node: NodeId, templateId: string): VarResolution
  /**
   * Display type of an elaborated port with solved variables substituted
   * (resolved -> concrete, ambiguous -> union, otherwise the declared
   * expression). Undefined when the node/port is not elaborated.
   */
  portTypeOf(node: NodeId, side: 'input' | 'output', elabKey: string): TypeExpr | undefined
  /** Verdicts for consumer-delivering links (structural feeds absent). */
  readonly linkVerdicts: ReadonlyMap<LinkId, EdgeVerdict>
  /** Verdicts per named-net sink, keyed by netSinkKey(). */
  readonly netSinkVerdicts: ReadonlyMap<string, EdgeVerdict>
  readonly diagnostics: readonly Diagnostic[]
}

// ---------------------------------------------------------------------------
// Variable store (union-find with domain intersection)
// ---------------------------------------------------------------------------

type EdgeSource =
  | { readonly kind: 'link'; readonly id: LinkId }
  | { readonly kind: 'net'; readonly id: string; readonly sinkIndex: number }
  | { readonly kind: 'projectedInput'; readonly index: number; readonly to: PortRef; readonly label?: string }
type SlotBindingSource = { readonly ref: PortRef; readonly variant: string }

type VarKey = string | symbol
type VarOwner =
  | { readonly kind: 'node'; readonly node: NodeId; readonly templateId: string }
  | { readonly kind: 'projected'; readonly to: PortRef; readonly templateId: string }

interface VarRecord {
  parent: VarKey
  readonly owner: VarOwner
  rank: number
  /** Remaining atom candidates; undefined = unrestricted. */
  domain?: ReadonlySet<string>
  /** True once an edge or persisted DynamicSlot selection constrained this class. */
  constrained: boolean
  /** Contributing edges, for deterministic conflict blame. */
  sources: EdgeSource[]
  /** Authoritative stored slot choices constraining this class. */
  slotBindings: SlotBindingSource[]
}

const varKeyOf = (node: NodeId, templateId: string): string => `${node.length}:${node}${templateId}`

class VarStore {
  private readonly vars = new Map<VarKey, VarRecord>()

  ensure(key: VarKey, declared: TypeExpr & { kind: 'variable' }, owner: VarOwner): void {
    const existing = this.vars.get(key)
    const declaredAtoms = atomNamesOf(declared)
    if (!existing) {
      this.vars.set(key, {
        parent: key,
        owner,
        rank: 0,
        ...(declaredAtoms !== undefined ? { domain: new Set(declaredAtoms) } : {}),
        constrained: false,
        sources: [],
        slotBindings: [],
      })
      return
    }
    // Multiple declarations of one template on one node must agree; if a
    // schema declares differing allowed sets, the variable honors all of
    // them (intersection) - declaration alone never marks it constrained.
    if (declaredAtoms !== undefined) {
      const root = this.find(key)
      root.domain = intersect(root.domain, declaredAtoms)
    }
  }

  find(key: VarKey): VarRecord {
    let rec = this.vars.get(key)
    if (!rec) throw new Error(`unregistered type variable '${String(key)}'`)
    // Path halving.
    while (rec.parent !== key) {
      const parent: VarRecord = this.vars.get(rec.parent)!
      rec.parent = parent.parent
      key = rec.parent
      rec = this.vars.get(key)!
    }
    return rec
  }

  constrain(key: VarKey, atoms: readonly string[], source: EdgeSource): void {
    const root = this.find(key)
    root.domain = intersect(root.domain, atoms)
    root.constrained = true
    root.sources.push(source)
  }

  bind(key: VarKey, atom: string, source: SlotBindingSource): void {
    const root = this.find(key)
    root.domain = intersect(root.domain, [atom])
    root.constrained = true
    root.slotBindings.push(source)
  }

  merge(a: VarKey, b: VarKey, source: EdgeSource): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) {
      ra.sources.push(source)
      return
    }
    const [winner, loser] = ra.rank >= rb.rank ? [ra, rb] : [rb, ra]
    if (winner.rank === loser.rank) winner.rank++
    loser.parent = winner.parent
    if (loser.domain !== undefined) winner.domain = intersect(winner.domain, [...loser.domain])
    winner.constrained = winner.constrained || loser.constrained
    winner.sources.push(...loser.sources, source)
    winner.slotBindings.push(...loser.slotBindings)
  }

  roots(): IterableIterator<VarRecord> {
    const seen = new Set<VarRecord>()
    for (const key of this.vars.keys()) seen.add(this.find(key))
    return seen.values()
  }

  resolutionOf(key: VarKey): VarResolution {
    if (!this.vars.has(key)) return { kind: 'unconstrained' }
    return resolutionOfRoot(this.find(key))
  }
}

const intersect = (
  domain: ReadonlySet<string> | undefined,
  atoms: readonly string[],
): ReadonlySet<string> => {
  if (domain === undefined) return new Set(atoms)
  return new Set(atoms.filter((a) => domain.has(a)))
}

const resolutionOfRoot = (root: VarRecord): VarResolution => {
  if (root.domain !== undefined && root.domain.size === 0) return { kind: 'conflict' }
  if (!root.constrained) return { kind: 'unconstrained' }
  const names = [...(root.domain ?? [])]
  if (names.length === 1) return { kind: 'resolved', name: names[0]! }
  if (names.length > 1) return { kind: 'ambiguous', names }
  // A constrained class without a finite domain cannot resolve to an atom.
  return { kind: 'unconstrained' }
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export interface SolveOptions extends ElaborateOptions {
  /** Optional occurrence-aware connectivity used by scene projections. */
  readonly connectivityOf?: (nodeId: NodeId) => Connectivity
  /** Producer types projected through a parent occurrence input. */
  readonly projectedInputs?: readonly {
    readonly type: TypeExpr
    readonly to: PortRef
    readonly label?: string
    /** Shared identity for multiple edges from one projected producer node. */
    readonly variableSource?: symbol
  }[]
}

interface PortTypes {
  readonly inputs: ReadonlyMap<string, TypeExpr>
  readonly outputs: ReadonlyMap<string, TypeExpr>
}

/**
 * Solve one graph definition's types. Pure and deterministic; elaboration
 * diagnostics produced internally are NOT re-reported (callers elaborate for
 * rendering anyway) - only solver diagnostics come back.
 */
export function solveGraphTypes(
  def: GraphDef,
  resolve: SchemaResolver,
  options: SolveOptions = {},
): SolveResult {
  const diagnostics: Diagnostic[] = []
  const linkVerdicts = new Map<LinkId, EdgeVerdict>()
  const netSinkVerdicts = new Map<string, EdgeVerdict>()
  const vars = new VarStore()

  // -- 1. Elaborate every resolvable node once; index port types by elabKey.
  // Absence metadata rides along: which outputs may deliberately emit no
  // value, and which inputs declare on_absent='fail' - the edge walk below
  // warns where they meet (legal, but worth surfacing: solve.maybeAbsent).
  const connectivityOf = options.connectivityOf ?? buildGraphConnectivity(def)
  const portTypes = new Map<NodeId, PortTypes>()
  const specializedSlots: { node: NodeId; ref: PortRef; selectedType: TypeExpr }[] = []
  const optionalOutputs = new Map<NodeId, Set<string>>()
  const failInputs = new Map<NodeId, Set<string>>()
  for (const node of Object.values(def.nodes) as NodeData[]) {
    const schema = resolve(node.type)
    if (!schema) continue // structural validators own "unresolvable type"
    const e = elaborateInterface(schema, node, connectivityOf(node.id), options)
    const inputs = new Map<string, TypeExpr>()
    const outputs = new Map<string, TypeExpr>()
    const slotBindings: {
      readonly templateId: string
      readonly type: TypeExpr
      readonly source: SlotBindingSource
    }[] = []
    for (const item of elabInputsOf(e)) {
      const key = elabKeyOf(item.address)
      inputs.set(key, item.spec.type)
      if (item.origin.kind === 'slot' && item.origin.selected !== undefined) {
        const selected = item.origin.selected
        const variant = item.origin.variants?.find((candidate) => candidate.key === selected)
        if (variant) {
          const ref = { node: node.id, port: asPortId(item.address.port), ...(item.address.members ? { members: item.address.members } : {}) }
          specializedSlots.push({ node: node.id, ref, selectedType: variant.type })
          if (item.origin.typeTemplateId !== undefined) {
            slotBindings.push({
              templateId: item.origin.typeTemplateId,
              type: variant.type,
              source: { ref, variant: selected },
            })
          }
        }
      }
      if (effectiveAbsentPolicy(item.spec) === 'fail') {
        let set = failInputs.get(node.id)
        if (!set) failInputs.set(node.id, (set = new Set()))
        set.add(key)
      }
    }
    for (const item of elabOutputsOf(e)) {
      const key = elabKeyOf(item.address)
      outputs.set(key, item.spec.type)
      if (item.spec.optional) {
        let set = optionalOutputs.get(node.id)
        if (!set) optionalOutputs.set(node.id, (set = new Set()))
        set.add(key)
      }
    }
    // Register every variable occurrence (including variables nested inside
    // list elements) so unlinked variables still answer resolutionOf, and
    // multi-declaration domains intersect up front.
    for (const type of [...inputs.values(), ...outputs.values()]) {
      for (const v of nestedVariablesOf(type)) {
        vars.ensure(varKeyOf(node.id, v.templateId), v, { kind: 'node', node: node.id, templateId: v.templateId })
      }
    }
    for (const binding of slotBindings) {
      const key = varKeyOf(node.id, binding.templateId)
      // A count-bound output family may currently have zero members, leaving
      // no elaborated variable occurrence even though the slot still binds it.
      vars.ensure(key, { kind: 'variable', templateId: binding.templateId }, {
        kind: 'node', node: node.id, templateId: binding.templateId,
      })
      const typeId = canonicalCompatTypeIdOf(binding.type)
      if (typeId !== undefined) vars.bind(key, typeId, binding.source)
    }
    if (slotBindings.length > 0) {
      const bindings = new Map(slotBindings.map(({ templateId, type }) => [templateId, type]))
      for (const [key, type] of inputs) inputs.set(key, substituteTypeBindings(type, bindings))
      for (const [key, type] of outputs) outputs.set(key, substituteTypeBindings(type, bindings))
    }
    portTypes.set(node.id, { inputs, outputs })
  }

  const typeAt = (ref: PortRef, side: 'input' | 'output'): TypeExpr | undefined => {
    const entry = portTypes.get(ref.node)
    if (!entry) return undefined
    const key = elabKeyOf({ port: ref.port, ...(ref.members !== undefined ? { members: ref.members } : {}) })
    return (side === 'input' ? entry.inputs : entry.outputs).get(key)
  }

  // -- 2. Process type-carrying edges.
  //
  // One source may be constrained SEVERAL times (a link fed by a selector
  // output checks against every candidate branch), so verdicts are
  // sticky-worst: mismatch > unknown > ok. Single-constraint sources behave
  // exactly as before.
  const verdictRank: Record<EdgeVerdict, number> = { ok: 0, unknown: 1, mismatch: 2 }
  const setVerdict = (source: EdgeSource, verdict: EdgeVerdict): void => {
    if (source.kind === 'link') {
      const prev = linkVerdicts.get(source.id)
      if (prev === undefined || verdictRank[verdict] > verdictRank[prev]) linkVerdicts.set(source.id, verdict)
    } else if (source.kind === 'net') {
      const key = netSinkKey(source.id, source.sinkIndex)
      const prev = netSinkVerdicts.get(key)
      if (prev === undefined || verdictRank[verdict] > verdictRank[prev]) netSinkVerdicts.set(key, verdict)
    }
  }

  const constrain = (
    from: PortRef,
    to: PortRef,
    source: EdgeSource,
    fromSide: 'input' | 'output' = 'output',
  ): void => {
    const fromType = typeAt(from, fromSide)
    const toType = typeAt(to, 'input')
    if (fromType === undefined || toType === undefined) {
      setVerdict(source, 'unknown')
      const missing = fromType === undefined ? from : to
      if (portTypes.has(missing.node)) {
        // The node elaborated but this port does not currently exist
        // (inactive branch, removed member, renamed schema port).
        diagnostics.push(
          diag('info', 'schema', 'solve.portMissing', `[${def.id}] ${sourceLabel(source)} references port '${missing.port}'${missing.members !== undefined ? ` member '${missing.members.join('.')}'` : ''} on node '${missing.node}', which is not currently elaborated`, {
            anchor: source.kind === 'link' ? { link: source.id, port: missing } : { port: missing },
          }),
        )
      }
      return
    }

    // Absence advisory (schema wire v3): a maybe-absent producer feeding a
    // fail-policy input is LEGAL - the type verdict is untouched - but worth
    // surfacing before the run fails at runtime. Keyed to the traced REAL
    // producer, so the warning survives reroute chains.
    const fromKey = elabKeyOf({ port: from.port, ...(from.members !== undefined ? { members: from.members } : {}) })
    const toKey = elabKeyOf({ port: to.port, ...(to.members !== undefined ? { members: to.members } : {}) })
    if (fromSide === 'output' && optionalOutputs.get(from.node)?.has(fromKey) && failInputs.get(to.node)?.has(toKey)) {
      diagnostics.push(
        diag('warning', 'schema', 'solve.maybeAbsent', `[${def.id}] ${sourceLabel(source)}: input '${to.port}' on node '${to.node}' declares onAbsent='fail' but is driven by optional output '${from.port}' of node '${from.node}', which may produce no value at runtime`, {
          anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
        }),
      )
    }

    unify(fromType, toType, from, to, source)
  }

  /**
   * Structural unification of one edge's endpoint types. Constructor-aware
   * and recursive: closed lists are ordinary atoms (canonical 'list<...>'
   * ids), so atom-set arithmetic handles them with exact identity; recursion
   * happens only when a list carries a variable/wildcard below it (peel the
   * constructor, unify elements). Cardinality is checked STRUCTURALLY first:
   * a definitely-list edge into a definitely-scalar input is an error
   * (mirrors backend 'list-into-scalar'/'scalar-into-list' - no implicit
   * coercion), unlike advisory atom mismatches which stay warnings.
   *
   * Known, deliberate under-constraint: an edge between an OPEN list
   * (`list<V>`) and a bare variable `U` records no domain relation (`U =
   * list<V>` is not representable in flat atom domains). The solver is
   * advisory, so under-constraining is sound - the edge just stays 'ok'.
   *
   * `allowCoercion` is the single-step budget of the engine-side asset
   * coercion (typed assets, wire v12): true on the outer edge call, and set
   * FALSE by every recursion that consumes the step (decode/lift/merge
   * peels), so asset<asset<T>> chains never pass. Peeling a SHARED
   * constructor (list-vs-list, asset-vs-asset) is free and inherits the
   * budget - that is how the elementwise lift works.
   */
  const unify = (
    fromType: TypeExpr,
    toType: TypeExpr,
    from: PortRef,
    to: PortRef,
    source: EdgeSource,
    allowCoercion = true,
    fromVariableKeys?: ReadonlyMap<string, VarKey>,
  ): void => {
    if (fromType.kind === 'wildcard' || toType.kind === 'wildcard') {
      setVerdict(source, 'ok') // no constraint, no capture
      return
    }

    // Structural cardinality gate (variables/wildcards are 'unknown' and pass).
    // The ONE engine-side asset coercion step can legally cross cardinality
    // (decode asset<list<T>> -> list<T>; registry-gated merge
    // list<asset<T>> -> T), so a coercible edge passes the gate. Open
    // structured forms peel structurally with the step consumed; closed
    // forms resolve through the atom vocabulary.
    const cf = cardinalityOf(fromType)
    const ct = cardinalityOf(toType)
    if (cf !== 'unknown' && ct !== 'unknown' && cf !== ct) {
      if (allowCoercion) {
        if (fromType.kind === 'asset') {
          // decode asset<X> -> X (only asset<list<...>> can reach a list
          // destination); recursion is NON-coercing: the step is spent.
          unify(fromType.element, toType, from, to, source, false, fromVariableKeys)
          return
        }
        if (fromType.kind === 'list' && fromType.element.kind === 'asset') {
          // registry-gated merge list<asset<X>> -> scalar X. Maybe-legal
          // here: the merge-provider registry is server-side, so 'ok' means
          // "no frontend-known mismatch" and backend document validation
          // owns the final refusal.
          unify(fromType.element.element, toType, from, to, source, false, fromVariableKeys)
          return
        }
        if (assetCoercible(fromType, toType)) {
          setVerdict(source, 'ok') // closed coercion target is exact; no domain capture needed
          return
        }
      }
      setVerdict(source, 'mismatch')
      const [code, msg] =
        cf === 'list'
          ? ['solve.listIntoScalar', `expects one value but is driven by a list; apply the node per element with a Map region, reduce the list, or pick one element explicitly`]
          : ['solve.scalarIntoList', `expects a list but is driven by one value; collect values into a list explicitly`]
      diagnostics.push(
        diag('error', 'schema', code, `[${def.id}] ${sourceLabel(source)}: input '${to.port}' on node '${to.node}' ${msg}`, {
          anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
        }),
      )
      return
    }

    const fromVar = fromType.kind === 'variable'
      ? fromVariableKeys?.get(fromType.templateId) ?? varKeyOf(from.node, fromType.templateId)
      : undefined
    const toVar = toType.kind === 'variable' ? varKeyOf(to.node, toType.templateId) : undefined

    if (fromVar !== undefined && toVar !== undefined) {
      if (source.kind === 'projectedInput' && fromVariableKeys !== undefined) vars.merge(toVar, fromVar, source)
      else vars.merge(fromVar, toVar, source)
      setVerdict(source, 'ok') // downgraded to 'mismatch' if the class conflicts
      return
    }
    if (fromVar !== undefined || toVar !== undefined) {
      const varKey = (fromVar ?? toVar)!
      let atoms = atomNamesOf(fromVar !== undefined ? toType : fromType)
      if (atoms === undefined) {
        // Unrestricted (or open-list) other side: no constraint, no capture.
        setVerdict(source, 'ok')
        return
      }
      if (toVar !== undefined && allowCoercion) {
        // Exact-first (backend parity): a MATCHING variable destination
        // receives the AssetRef unchanged, so the incoming type itself binds
        // the variable - an asset<X> edge next to a plain X edge on one bare
        // variable is a genuine conflict, never a silent decode. Only when
        // the variable's DECLARED allowlist cannot accept the incoming type
        // directly does the one coercion step apply: the input then resolves
        // to a coercion target and the engine decodes/lifts/merges at input
        // resolution.
        const declared = atomNamesOf(toType)
        if (declared !== undefined && !atoms.some((n) => declared.includes(n))) {
          const coerced = atoms.flatMap((n) => coercionTargetsOf(n))
          if (coerced.some((n) => declared.includes(n))) atoms = coerced
        }
      }
      vars.constrain(varKey, atoms, source)
      setVerdict(source, 'ok') // downgraded on conflict
      return
    }

    // Structured-vs-structured of the SAME constructor (list or asset) where
    // at least one side is OPEN (closed structures denote atoms and fall
    // through to atom arithmetic below): peel the shared constructor and
    // unify the elements on the same edge source - this is how "asset<T>
    // binds T" works, mirroring the backend's unification through the
    // constructor.
    if (fromType.kind === toType.kind && (fromType.kind === 'list' || fromType.kind === 'asset' || fromType.kind === 'stream')) {
      const a = atomNamesOf(fromType)
      const b = atomNamesOf(toType)
      if (a === undefined || b === undefined) {
        // Shared-constructor peel is free: the coercion budget is inherited
        // (that is the elementwise lift when a list element then decodes).
        unify(fromType.element, (toType as TypeExpr & { kind: 'list' | 'asset' | 'stream' }).element, from, to, source, allowCoercion, fromVariableKeys)
        return
      }
      // Both closed: exact canonical-id overlap, handled below.
    } else if (fromType.kind === 'list' || fromType.kind === 'asset' || fromType.kind === 'stream' || toType.kind === 'list' || toType.kind === 'asset' || toType.kind === 'stream') {
      // Open structured side against a concrete/union side (closed
      // structures fell through the gate only when the other side has
      // matching atoms too): peel by parsing the atom side's parametric ids
      // and unify elements. Mixed constructors never meet here - the
      // cardinality gate already resolved list-vs-asset edges.
      const structuredIsFrom = fromType.kind === 'list' || fromType.kind === 'asset' || fromType.kind === 'stream'
      const structured = (structuredIsFrom ? fromType : toType) as TypeExpr & { kind: 'list' | 'asset' | 'stream' }
      const other = structuredIsFrom ? toType : fromType
      if (atomNamesOf(structured) === undefined) {
        const parse = structured.kind === 'list' ? parseListTypeId : structured.kind === 'asset' ? parseAssetTypeId : parseStreamTypeId
        const elems = (atomNamesOf(other) ?? []).map(parse).filter((n): n is string => n !== undefined)
        if (elems.length === 0) {
          // An open ASSET producer can still feed a concrete input through
          // the one decode step (asset<V> -> V): bind the element against
          // the input's atoms instead of reporting a mismatch. The step is
          // spent - the recursion is non-coercing, so asset<asset<V>> never
          // chains through.
          if (allowCoercion && structuredIsFrom && structured.kind === 'asset') {
            unify(structured.element, toType, from, to, source, false, fromVariableKeys)
            return
          }
          // Mixed-cardinality union with no matching members left: mismatch.
          setVerdict(source, 'mismatch')
          diagnostics.push(
            diag('warning', 'schema', 'solve.linkMismatch', `[${def.id}] ${sourceLabel(source)}: no ${structured.kind}-typed candidate can feed input '${to.port}' on node '${to.node}'`, {
              anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
            }),
          )
          return
        }
        const elemExpr: TypeExpr = elems.length === 1 ? typeExprFromTypeId(elems[0]!) : { kind: 'union', names: elems }
        if (structuredIsFrom) unify(structured.element, elemExpr, from, to, source, allowCoercion, fromVariableKeys)
        else unify(elemExpr, structured.element, from, to, source, allowCoercion, fromVariableKeys)
        return
      }
    }

    // Atom-vs-atom: per-edge overlap; unions never collapse. Closed lists
    // and assets compare here by exact canonical id, plus the one asset
    // coercion step (decode asset<T> -> T and kin) counts as overlap.
    const a = atomNamesOf(fromType)
    const b = atomNamesOf(toType)
    if (a === undefined || b === undefined || a.some((n) => b.includes(n)) || (allowCoercion && assetCoercible(fromType, toType))) {
      setVerdict(source, 'ok')
      return
    }
    setVerdict(source, 'mismatch')
    diagnostics.push(
      diag('warning', 'schema', 'solve.linkMismatch', `[${def.id}] ${sourceLabel(source)}: output type '${a.join(',')}' cannot feed input type '${b.join(',')}' ('${to.port}' on node '${to.node}')`, {
        anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
      }),
    )
  }

  const rerouteIndex = buildRerouteIndex(def)
  for (const link of Object.values(def.links) as LinkData[]) {
    if (!isPortEndpoint(link.to)) continue // structural feed into a reroute/selector
    // A consumer fed by a selector OUTPUT constrains against EVERY candidate
    // branch's producer - policy can change at any moment, so editing-time
    // compatibility must hold for all of them (a selector is a type-agnostic
    // passthrough, never a type variable). Non-selector chains yield exactly
    // one trace, preserving prior behavior. Value sources carry values, not
    // types; undriven/cyclic branches constrain nothing.
    for (const trace of traceEndpointAll(def, link.from, rerouteIndex)) {
      if (trace.kind === 'output') {
        constrain(trace.ref, link.to, { kind: 'link', id: link.id })
      } else if (trace.kind === 'tapValue') {
        constrain(
          { node: trace.node, port: trace.input },
          link.to,
          { kind: 'link', id: link.id },
          'input',
        )
      }
    }
  }
  for (const net of Object.values(def.nets)) {
    net.sinks.forEach((sink, i) => {
      constrain(net.source, sink, { kind: 'net', id: net.id, sinkIndex: i })
    })
  }
  const projectedVariablesBySource = new Map<symbol, Map<string, VarKey>>()
  for (const [index, projected] of (options.projectedInputs ?? []).entries()) {
    const toType = typeAt(projected.to, 'input')
    if (toType === undefined) {
      if (portTypes.has(projected.to.node)) {
        const source: EdgeSource = {
          kind: 'projectedInput',
          index,
          to: projected.to,
          ...(projected.label === undefined ? {} : { label: projected.label }),
        }
        diagnostics.push(
          diag('info', 'schema', 'solve.portMissing', `[${def.id}] ${sourceLabel(source)} references port '${projected.to.port}'${projected.to.members !== undefined ? ` member '${projected.to.members.join('.')}'` : ''} on node '${projected.to.node}', which is not currently elaborated`, {
            anchor: { port: projected.to },
          }),
        )
      }
      continue
    }
    const externalRef: PortRef = { node: projected.to.node, port: projected.to.port }
    let projectedVariableKeys: Map<string, VarKey>
    if (projected.variableSource === undefined) {
      projectedVariableKeys = new Map()
    } else {
      projectedVariableKeys = projectedVariablesBySource.get(projected.variableSource) ?? new Map()
      projectedVariablesBySource.set(projected.variableSource, projectedVariableKeys)
    }
    for (const variable of nestedVariablesOf(projected.type)) {
      let key = projectedVariableKeys.get(variable.templateId)
      if (key === undefined) {
        key = Symbol(`projected-input:${index}:${variable.templateId}`)
        projectedVariableKeys.set(variable.templateId, key)
      }
      vars.ensure(key, variable, { kind: 'projected', to: projected.to, templateId: variable.templateId })
    }
    unify(projected.type, toType, externalRef, projected.to, {
      kind: 'projectedInput',
      index,
      to: projected.to,
      ...(projected.label === undefined ? {} : { label: projected.label }),
    }, true, projectedVariableKeys)
  }

  // -- 3. Conflicted classes: mark every contributing edge, one diagnostic each.
  for (const root of vars.roots()) {
    if (root.domain === undefined || root.domain.size > 0) continue
    for (const source of root.sources) setVerdict(source, 'mismatch')
    const firstLink = root.sources.find((s): s is Extract<EdgeSource, { kind: 'link' }> => s.kind === 'link')
    const firstProjected = root.sources.find((s): s is Extract<EdgeSource, { kind: 'projectedInput' }> => s.kind === 'projectedInput')
    const firstSlotBinding = root.slotBindings[0]
    const subject = root.owner.kind === 'node'
      ? `type variable '${root.owner.templateId}' on node '${root.owner.node}'`
      : `projected variable '${root.owner.templateId}' at input '${root.owner.to.port}' on node '${root.owner.to.node}'`
    const message = firstSlotBinding !== undefined
      ? `[${def.id}] ${subject} conflicts with stored DynamicSlot '${firstSlotBinding.ref.port}' variant '${firstSlotBinding.variant}'${root.sources.length > 0 ? ` and ${root.sources.length} connection(s); conflicting links are marked` : ''}`
      : firstProjected === undefined
      ? `[${def.id}] ${subject} has no type satisfying all ${root.sources.length} connections; conflicting links are marked`
      : `[${def.id}] ${subject} has no type satisfying all ${root.sources.length} constraints at input '${firstProjected.to.port}' on node '${firstProjected.to.node}' from ${sourceLabel(firstProjected)}`
    diagnostics.push(
      diag('warning', 'schema', 'solve.varConflict', message, {
        ...(firstLink ? { anchor: { link: firstLink.id } } : firstProjected ? { anchor: { port: firstProjected.to } } : firstSlotBinding ? { anchor: { port: firstSlotBinding.ref } } : {}),
        data: {
          edges: root.sources.map(sourceLabel),
          ...(root.slotBindings.length > 0
            ? { slotSelections: root.slotBindings.map(({ ref, variant }) => `${ref.node}/${ref.port}=${variant}`) }
            : {}),
        },
      }),
    )
  }

  // -- 4. Result surface.
  const substitute = (type: TypeExpr, node: NodeId): TypeExpr => {
    if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') {
      const element = substitute(type.element, node)
      return element === type.element ? type : { kind: type.kind, element }
    }
    if (type.kind !== 'variable') return type
    const res = vars.resolutionOf(varKeyOf(node, type.templateId))
    // Resolved atoms may be canonical list ids; rebuild structure so
    // `concrete('list<...>')` never leaves the solver.
    if (res.kind === 'resolved') return typeExprFromTypeId(res.name)
    if (res.kind === 'ambiguous') return { kind: 'union', names: res.names }
    return type // unconstrained/conflict: the declared expression
  }

  // Specialization is a persisted choice, so solving only advises when a
  // later topology/type change makes that choice stale. Reuse the exact
  // topology tracing policy used by edge checks, including all selector
  // candidates, and abstain for generic or wildcard producers.
  const isKnown = (type: TypeExpr): boolean =>
    type.kind === 'concrete' || type.kind === 'union' || ((type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') && isKnown(type.element))
  const reroutes = buildRerouteIndex(def)
  const checkProducer = (slot: typeof specializedSlots[number], from: Parameters<typeof traceEndpointAll>[1]): void => {
    for (const trace of traceEndpointAll(def, from, reroutes)) {
      if (trace.kind !== 'output') continue
      const declared = typeAt(trace.ref, 'output')
      if (declared === undefined) continue
      const solved = substitute(declared, trace.ref.node)
      if (!isKnown(solved) || typesCompatible(solved, slot.selectedType)) continue
      diagnostics.push(diag('warning', 'schema', 'solve.slot.staleSpecialization', `[${def.id}] DynamicSlot '${slot.ref.port}' on node '${slot.node}' has a selected variant incompatible with producer '${trace.ref.port}' on node '${trace.ref.node}'`, {
        anchor: { port: slot.ref },
      }))
    }
  }
  for (const slot of specializedSlots) {
    const slotKey = elabKeyOf(slot.ref)
    for (const link of Object.values(def.links) as LinkData[]) {
      if (isPortEndpoint(link.to) && link.to.node === slot.node && elabKeyOf(link.to) === slotKey) checkProducer(slot, link.from)
    }
    for (const net of Object.values(def.nets)) {
      if (net.sinks.some((sink) => sink.node === slot.node && elabKeyOf(sink) === slotKey)) checkProducer(slot, net.source)
    }
  }

  return {
    resolutionOf: (node, templateId) => vars.resolutionOf(varKeyOf(node, templateId)),
    portTypeOf: (node, side, elabKey) => {
      const entry = portTypes.get(node)
      const declared = entry ? (side === 'input' ? entry.inputs : entry.outputs).get(elabKey) : undefined
      return declared === undefined ? undefined : substitute(declared, node)
    },
    linkVerdicts,
    netSinkVerdicts,
    diagnostics,
  }
}

const sourceLabel = (s: EdgeSource): string =>
  s.kind === 'link'
    ? `link '${s.id}'`
    : s.kind === 'net'
      ? `net '${s.id}' sink ${s.sinkIndex}`
      : s.label ?? `projected input ${s.index}`
