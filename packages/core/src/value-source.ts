/**
 * Value sources (architecture section 5b, hazards P1-P5): literal producers -
 * the principled replacement for the legacy frontend PrimitiveNode.
 *
 * Document stores value + optional DECLARED partial spec + controller state.
 * The EFFECTIVE spec is derived here, on demand, and never stored (P1):
 * declared fields are taken verbatim; undeclared fields are unified from the
 * consumers the source reaches (through reroute chains - one tracing
 * implementation, R1/traceEndpoint, walked forward here). Conflicts are
 * diagnostics, never mutations (P5); the stored value is never reset by any
 * spec outcome (P2). Derivation consumes only schemas + link existence -
 * NEVER solved types - so the elaboration DAG invariant holds (P3).
 */

import { canonicalJson } from './compile/hash.js'
import { diag, type Diagnostic } from './diagnostics.js'
import type { GraphDef, Json, JsonObject, ValueSourceData } from './format/document.js'
import { isPortEndpoint, isRerouteRef, isSelectorRef, isValueSourceRef, type PortRef } from './ids.js'
import { rerouteSuccessorsOf, selectorSuccessorsOf, type RerouteIndex } from './reroute.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elabKeyOf,
  elaborateInterface,
} from './schema/elaborate.js'
import { atomNamesOf } from './schema/type-compatibility.js'
import { inputsOf, typeExprFromTypeId, type InputSpec, type NodeSchema, type TypeExpr, type WidgetSpec } from './schema/model.js'

type LinkDataOf = GraphDef['links'][string]

/** All links leaving `valueSourceId` (fan-out). */
export function valueSourceLinksOf(def: GraphDef, valueSourceId: string): LinkDataOf[] {
  return Object.values(def.links).filter(
    (l) => isValueSourceRef(l.from) && l.from.valueSource === valueSourceId,
  )
}

/**
 * The consumer input ports a value source reaches: direct links plus links
 * flowing on through reroute chains. Forward walk, cycle-safe, one
 * definition only (structural constructs never cross boundaries).
 */
export function valueSourceConsumersOf(
  def: GraphDef,
  valueSourceId: string,
  index?: RerouteIndex,
): PortRef[] {
  const consumers: PortRef[] = []
  const visitedReroutes = new Set<string>()
  const visitedSelectors = new Set<string>()
  const follow = (to: LinkDataOf['to']): void => {
    if (isRerouteRef(to)) {
      if (visitedReroutes.has(to.reroute)) return
      visitedReroutes.add(to.reroute)
      for (const next of rerouteSuccessorsOf(def, to.reroute, index)) follow(next.to)
      return
    }
    if (isSelectorRef(to)) {
      // Feeding a CANDIDATE means the value MAY reach the selector output's
      // consumers (policy can change any time), so spec derivation reasons
      // conservatively over them. A selector-output target is illegal (I11).
      if (to.candidate === undefined) return // defensive
      if (visitedSelectors.has(to.selector)) return
      visitedSelectors.add(to.selector)
      for (const next of selectorSuccessorsOf(def, to.selector, index)) follow(next.to)
      return
    }
    if (!isPortEndpoint(to)) return // illegal producer-only target; ignore defensively
    consumers.push(to)
  }
  for (const link of valueSourceLinksOf(def, valueSourceId)) follow(link.to)
  return consumers
}

// ---------------------------------------------------------------------------
// Effective spec derivation (P1: declared verbatim, derive the rest)
// ---------------------------------------------------------------------------

/**
 * Per-kind constraint merging (P5): closed, deterministic, defined here for
 * the core kinds; unknown kinds fall back to "specs must agree exactly"
 * (i.e. they opt out of derivation until they declare a merge rule).
 * Returns merged options or a conflict message.
 */
export type SpecMergeFn = (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
) => { readonly options: Record<string, unknown> } | { readonly conflict: string }

const asNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

const mergeNumeric: SpecMergeFn = (a, b) => {
  const options: Record<string, unknown> = { ...a }
  const aMin = asNum(a['min'])
  const bMin = asNum(b['min'])
  const aMax = asNum(a['max'])
  const bMax = asNum(b['max'])
  const min = aMin === undefined ? bMin : bMin === undefined ? aMin : Math.max(aMin, bMin)
  const max = aMax === undefined ? bMax : bMax === undefined ? aMax : Math.min(aMax, bMax)
  if (min !== undefined) options['min'] = min
  if (max !== undefined) options['max'] = max
  if (min !== undefined && max !== undefined && min > max) {
    return { conflict: `numeric ranges do not intersect (min ${min} > max ${max})` }
  }
  // Coarsest step wins (every consumer can accept multiples of it only if
  // steps divide; advisory, so pick the larger and let validate() warn).
  const aStep = asNum(a['step'])
  const bStep = asNum(b['step'])
  const step = aStep === undefined ? bStep : bStep === undefined ? aStep : Math.max(aStep, bStep)
  if (step !== undefined) options['step'] = step
  // Finest precision display-wise (FLOAT): smallest declared.
  const aPrec = asNum(a['precision'])
  const bPrec = asNum(b['precision'])
  const precision =
    aPrec === undefined ? bPrec : bPrec === undefined ? aPrec : Math.min(aPrec, bPrec)
  if (precision !== undefined) options['precision'] = precision
  return { options }
}

const comboKeyOf = (o: unknown): string =>
  Array.isArray(o) ? String(o[0]) : typeof o === 'object' && o !== null ? JSON.stringify(o) : String(o)

const mergeCombo: SpecMergeFn = (a, b) => {
  const aOpts = Array.isArray(a['options']) ? (a['options'] as unknown[]) : undefined
  const bOpts = Array.isArray(b['options']) ? (b['options'] as unknown[]) : undefined
  const options: Record<string, unknown> = { ...a, ...b }
  if (aOpts && bOpts) {
    const bKeys = new Set(bOpts.map(comboKeyOf))
    const merged = aOpts.filter((o) => bKeys.has(comboKeyOf(o)))
    if (merged.length === 0) return { conflict: 'combo option lists do not intersect' }
    options['options'] = merged
  } else if (aOpts ?? bOpts) {
    options['options'] = aOpts ?? bOpts
  }
  return { options }
}

const mergeString: SpecMergeFn = (a, b) => ({
  // multiline is a default-view hint, not a wall: any consumer wanting
  // multiline gets the richer default; the value shape is identical.
  options: { ...a, ...b, ...(a['multiline'] === true || b['multiline'] === true ? { multiline: true } : {}) },
})

const mergeTrivial: SpecMergeFn = (a, b) => ({ options: { ...a, ...b } })

const mergeExact: SpecMergeFn = (a, b) => {
  if (canonicalJson(a) !== canonicalJson(b)) {
    return { conflict: 'consumers disagree on widget options and this widget kind declares no merge rule' }
  }
  return { options: { ...a } }
}

const CORE_MERGES: Readonly<Record<string, SpecMergeFn>> = {
  INT: mergeNumeric,
  FLOAT: mergeNumeric,
  COMBO: mergeCombo,
  STRING: mergeString,
  BOOLEAN: mergeTrivial,
}

export const specMergeFor = (widgetType: string): SpecMergeFn => CORE_MERGES[widgetType] ?? mergeExact

// ---------------------------------------------------------------------------
// Effective spec
// ---------------------------------------------------------------------------

export interface EffectiveValueSourceSpec {
  /**
   * The effective widget spec, when one is determinable. Undefined when the
   * source is unconnected AND declares nothing - the raw-value fallback view
   * renders in that case (P2: the value itself is always retained).
   */
  readonly spec?: WidgetSpec
  /** Advisory display type (noodle/pin color); wildcard when unknown. */
  readonly type: TypeExpr
  /** Consumer input specs the derivation saw (for UI: "drives N inputs"). */
  readonly consumers: readonly PortRef[]
  /** Conflict/violation diagnostics. Advisory - never blocks, never mutates. */
  readonly diagnostics: readonly Diagnostic[]
}

const intersectTypes = (a: TypeExpr, b: TypeExpr): TypeExpr => {
  // Closed lists denote canonical 'list<...>' atoms, so they intersect by
  // exact identity like any atom; typeExprFromTypeId rebuilds the structured
  // form (never `concrete('list<...>')`). Open lists/variables/wildcards
  // yield undefined -> the other side wins (advisory display only).
  // atomNamesOf canonicalizes interchangeable comfy-compat spellings, so a
  // source driving both dinkster.mask and comfy.MASK intersects to one MASK
  // atom instead of collapsing to wildcard.
  const names = (t: TypeExpr): readonly string[] | undefined =>
    t.kind === 'concrete' || t.kind === 'union' || t.kind === 'list' || t.kind === 'asset' || t.kind === 'stream' ? atomNamesOf(t) : undefined
  const an = names(a)
  const bn = names(b)
  if (an === undefined) return b
  if (bn === undefined) return a
  const both = [...new Set(an)].filter((n) => bn.includes(n))
  if (both.length === 1) return typeExprFromTypeId(both[0]!)
  if (both.length > 1) return { kind: 'union', names: both }
  return { kind: 'wildcard' } // disjoint; compat layer will warn on the links
}

/**
 * Derive the effective spec of one value source (P1). Pure: consumes the
 * definition (link existence), consumer node schemas, and the source's
 * declared fields. No solved types, no stored output.
 */
export function effectiveValueSourceSpec(
  def: GraphDef,
  vs: ValueSourceData,
  resolve: (nodeType: string) => NodeSchema | undefined,
  index?: RerouteIndex,
): EffectiveValueSourceSpec {
  const diags: Diagnostic[] = []
  const consumers = valueSourceConsumersOf(def, vs.id, index)

  // Gather consumer input specs (widget-backed or not). Top-level static
  // inputs resolve straight off the schema; dynamic-derived consumers (family
  // members, combo-branch inputs, slot dependents) resolve through the
  // consumer's ELABORATED interface - same handlers, no parallel per-kind
  // walker to rot. Elaboration never consults value sources, so the
  // derivation DAG stays acyclic (P3). promoteGhosts: false - like compile,
  // derivation must not conjure specs from unpersisted members.
  let connectivityLazy: ReturnType<typeof buildGraphConnectivity> | undefined
  const elaboratedInputOf = (schema: NodeSchema, ref: PortRef): InputSpec | undefined => {
    const node = def.nodes[ref.node]
    if (!node) return undefined
    const connectivity = (connectivityLazy ??= buildGraphConnectivity(def))(node.id)
    const items = elaborateInterface(schema, node, connectivity, { promoteGhosts: false })
    const key = elabKeyOf({ port: ref.port, ...(ref.members !== undefined ? { members: ref.members } : {}) })
    return elabInputsOf(items).find((i) => i.spec.id === key)?.spec
  }
  const consumerInputs: { ref: PortRef; input: InputSpec }[] = []
  for (const ref of consumers) {
    const node = def.nodes[ref.node]
    const schema = node ? resolve(node.type) : undefined
    const input = schema
      ? (ref.members === undefined ? inputsOf(schema).find((i) => i.id === ref.port) : undefined) ??
        elaboratedInputOf(schema, ref)
      : undefined
    if (!input) continue // dangling/unknown: structural validation owns that report
    consumerInputs.push({ ref, input })
  }

  // Advisory type: intersection of consumer input types (wildcard when none).
  let type: TypeExpr = { kind: 'wildcard' }
  for (const { input } of consumerInputs) type = type.kind === 'wildcard' ? input.type : intersectTypes(type, input.type)

  // Widget type: declared verbatim, else unified from widget-backed consumers.
  const widgetSpecs = consumerInputs.filter((c) => c.input.widget).map((c) => c.input.widget!)
  let widgetType = vs.spec?.widgetType
  for (const w of widgetSpecs) {
    if (widgetType === undefined) {
      widgetType = w.widgetType
    } else if (w.widgetType !== widgetType) {
      diags.push(
        diag('warning', 'schema', 'valueSource.widgetType.conflict',
          `value source '${vs.id}' drives inputs of different widget kinds ('${widgetType}' vs '${w.widgetType}')`,
          { data: { valueSource: vs.id } }),
      )
      // Declared (or first) kind stands; the conflicting consumer is reported, not adopted.
    }
  }
  if (widgetType === undefined) {
    // Unconnected + undeclared: no spec. Raw-value fallback view renders (P2).
    return { type, consumers, diagnostics: diags }
  }

  // Options: unify same-kind consumer options, then overlay declared verbatim.
  const merge = specMergeFor(widgetType)
  let options: Record<string, unknown> = {}
  let controller: WidgetSpec['controller'] | undefined
  let remote: WidgetSpec['remote'] | undefined
  let first = true
  for (const w of widgetSpecs) {
    if (w.widgetType !== widgetType) continue
    if (w.controller && controller === undefined) controller = w.controller
    if (w.remote && remote === undefined) remote = w.remote
    if (first) {
      options = { ...w.options }
      first = false
      continue
    }
    const merged = merge(options, w.options)
    if ('conflict' in merged) {
      diags.push(
        diag('warning', 'schema', 'valueSource.options.conflict',
          `value source '${vs.id}': ${merged.conflict}`, { data: { valueSource: vs.id } }),
      )
      continue // previous merge result stands; conflict reported, never a reset (P2)
    }
    options = merged.options
  }
  if (vs.spec?.options) {
    // Declared fields are authoritative (P1) - overlay verbatim, then check
    // compatibility with the consumer-derived constraints (violations are
    // diagnostics, never mutations).
    const derived = options
    options = { ...options, ...vs.spec.options }
    const check = merge(derived, vs.spec.options as Record<string, unknown>)
    if ('conflict' in check) {
      diags.push(
        diag('warning', 'schema', 'valueSource.declared.incompatible',
          `value source '${vs.id}': declared spec conflicts with consumers: ${check.conflict}`,
          { data: { valueSource: vs.id } }),
      )
    }
  }
  if (vs.spec?.controller) controller = vs.spec.controller

  const spec: WidgetSpec = {
    widgetType,
    options,
    ...(controller ? { controller } : {}),
    ...(remote ? { remote } : {}),
  }
  return { spec, type, consumers, diagnostics: diags }
}

/**
 * Pin the CURRENT effective spec as the declared spec ("pin current spec"
 * command payload): returns the declared shape to store, JSON-safe. Widget
 * options coming from schemas are JSON in practice; non-JSON entries are
 * dropped defensively.
 */
export function pinnedSpecOf(effective: EffectiveValueSourceSpec): JsonObject | undefined {
  if (!effective.spec) return undefined
  const options: Record<string, Json> = {}
  for (const [k, v] of Object.entries(effective.spec.options)) {
    if (v === undefined) continue
    try {
      options[k] = JSON.parse(JSON.stringify(v)) as Json
    } catch {
      /* non-JSON option: skip */
    }
  }
  return {
    widgetType: effective.spec.widgetType,
    options,
    ...(effective.spec.controller ? { controller: effective.spec.controller } : {}),
  }
}

/** Baked value of a source (what the compiler writes into consumer inputs). */
export const valueSourceBakedValue = (vs: ValueSourceData): Json => vs.value
