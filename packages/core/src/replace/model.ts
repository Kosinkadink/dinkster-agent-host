/**
 * Deprecation + replacement rules (architecture section 2, extension API implementation): declarative,
 * serializable node-migration rules. A rule is DATA - a closed predicate and
 * transform vocabulary, never code - so rules ship inside schemas/packs, are
 * testable against golden corpora, and can never mutate a document outside
 * the command layer.
 *
 * Shape: one rule migrates one source node type. Its cases are evaluated
 * top-down against the source node's document state (connections + stored
 * values); the FIRST matching case wins and the last case must be
 * unconditional (the required fallback). "If an input is missing do X,
 * otherwise Y" is exactly one guard pair.
 *
 * The vocabulary is deliberately minimal and grows additively (like the
 * workflow format): merge/split widget transforms and programmatic migrators
 * are later additions, never reinterpretations of existing fields.
 */

import type { Json } from '../format/document.js'
import { ownJson } from '../format/json.js'

// ---------------------------------------------------------------------------
// Predicates (closed, serializable - evaluated against document state)
// ---------------------------------------------------------------------------

export type ReplacementPredicate =
  /** Always true - the required fallback case uses this (or omits `when`). */
  | { readonly kind: 'always' }
  /** A link or net sink targets this source input. */
  | { readonly kind: 'inputConnected'; readonly input: string }
  /** A stored value exists for this source input id. */
  | { readonly kind: 'valuePresent'; readonly input: string }
  /** Stored value deep-equals `value` (absent key never matches). */
  | { readonly kind: 'valueEquals'; readonly input: string; readonly value: Json }
  | { readonly kind: 'not'; readonly of: ReplacementPredicate }
  | { readonly kind: 'all'; readonly of: readonly ReplacementPredicate[] }
  | { readonly kind: 'any'; readonly of: readonly ReplacementPredicate[] }

// ---------------------------------------------------------------------------
// Value transforms (closed vocabulary)
// ---------------------------------------------------------------------------

export type ValueTransform =
  /** Enum option rename; a source value missing from the map is an ERROR. */
  | { readonly kind: 'enumRename'; readonly map: Readonly<Record<string, string>> }
  /** Numeric `value * factor + offset`; a non-number source is an ERROR. */
  | { readonly kind: 'scale'; readonly factor: number; readonly offset?: number }

// ---------------------------------------------------------------------------
// Mapping sources (what feeds one TARGET input)
// ---------------------------------------------------------------------------

export type MappingSource =
  /**
   * Move the incoming connection (if any) AND copy the stored value (if any)
   * from a source input. The workhorse mapping: byte-preserves whatever the
   * old node had.
   */
  | { readonly kind: 'copy'; readonly input: string }
  /** Copy ONLY the stored value, optionally transformed. Never moves links. */
  | { readonly kind: 'value'; readonly input: string; readonly transform?: ValueTransform }
  /** Move ONLY the incoming connection. Never copies values. */
  | { readonly kind: 'link'; readonly input: string }
  /** Write a constant. */
  | { readonly kind: 'constant'; readonly value: Json }

export interface InputFamilyMember {
  /** Exact persisted target member suffix. Array order is authored order. */
  readonly suffix: string
  /** Target template-local input id -> ordinary static source mapping. */
  readonly inputs: Readonly<Record<string, MappingSource>>
}

export type InputFamilyMapping =
  /** Preserve every source suffix and its authored order one-for-one. */
  | {
      readonly kind: 'copy'
      readonly sourceFamily: string
      /** Target template-local input id -> source template-local mapping. */
      readonly inputs: Readonly<Record<string, MappingSource>>
    }
  /** Populate an ordered target family from ordinary static source inputs. */
  | { readonly kind: 'members'; readonly members: readonly InputFamilyMember[] }

export interface OutputFamilyMember {
  /** Exact target member suffix. Array order is canonical member order. */
  readonly suffix: string
  /** Ordinary static source output id. */
  readonly output: string
}

export type OutputFamilyMapping =
  /** Preserve every source suffix and its authored order one-for-one. */
  | { readonly kind: 'copy'; readonly sourceFamily: string }
  /** Populate an ordered target family from ordinary static source outputs. */
  | { readonly kind: 'members'; readonly members: readonly OutputFamilyMember[] }

export interface ReplacementNode {
  readonly type: string
  /** Constant helper values, merged over schema defaults at plan time. */
  readonly values?: Readonly<Record<string, Json>>
}

export interface ReplacementLink {
  /** Output address: `port` for the primary, `localId:port` for a helper. */
  readonly from: string
  /** Input address: `port` for the primary, `localId:port` for a helper. */
  readonly to: string
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export interface ReplacementCase {
  /** Guard; omitted means 'always'. First matching case wins. */
  readonly when?: ReplacementPredicate
  /** Target node type. */
  readonly to: string
  /** Helper nodes keyed by case-local structural id. */
  readonly nodes?: Readonly<Record<string, ReplacementNode>>
  /** Literal DynamicCombo options and DynamicSlot variants by `[helperId:]construct.path`. */
  readonly slotVariants?: Readonly<Record<string, string>>
  /**
   * TARGET input id -> mapping source. Unmapped target inputs get the target
   * schema's declared defaults (written explicitly - reproducibility).
   */
  readonly inputs?: Readonly<Record<string, MappingSource>>
  /** Top-level dynamic input families addressed as `family` or `helperId:family`. */
  readonly inputFamilies?: Readonly<Record<string, InputFamilyMapping>>
  /** Acyclic internal wiring among the primary and helper nodes. */
  readonly links?: readonly ReplacementLink[]
  /**
   * TARGET output id -> SOURCE output id. Downstream links/nets on a mapped
   * source output move to the target output id. A source output referenced
   * by two entries is an ERROR (fan-in would duplicate links); a source
   * output with links that no entry consumes is a WARNING (dropped
   * connections force review).
   */
  readonly outputs?: Readonly<Record<string, string>>
  /** Top-level count-bound output families on the primary target node. */
  readonly outputFamilies?: Readonly<Record<string, OutputFamilyMapping>>
}

export interface ReplacementRule {
  /** Source node type this rule migrates away from. */
  readonly from: string
  /** Human note surfaced in diagnostics/review ('renamed in v0.4'). */
  readonly note?: string
  /** Marks a one-shot same-type migration from historical input or dynamic-choice paths. */
  readonly migration?: {
    readonly historicalInputs: readonly string[]
  }
  /** Evaluated top-down; the LAST case must be unconditional. */
  readonly cases: readonly ReplacementCase[]
}

/** Layer precedence for rule lookup: schema-shipped beats pack beats core. */
export type RuleLayer = 'schema' | 'pack' | 'core'

// ---------------------------------------------------------------------------
// Shape validation (rules arrive as Json from packs/schemas)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => {
  const expected = new Set(keys)
  return Object.keys(v).length === expected.size && Object.keys(v).every((key) => expected.has(key))
}

const isPredicate = (v: unknown): v is ReplacementPredicate => {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'always':
      return true
    case 'inputConnected':
    case 'valuePresent':
      return typeof v.input === 'string' && v.input.length > 0
    case 'valueEquals':
      return typeof v.input === 'string' && v.input.length > 0 && 'value' in v
    case 'not':
      return isPredicate(v.of)
    case 'all':
    case 'any':
      return Array.isArray(v.of) && v.of.every(isPredicate)
    default:
      return false
  }
}

const isTransform = (v: unknown): v is ValueTransform => {
  if (!isObj(v)) return false
  if (v.kind === 'enumRename')
    return isObj(v.map) && Object.values(v.map).every((x) => typeof x === 'string')
  if (v.kind === 'scale')
    return typeof v.factor === 'number' && (v.offset === undefined || typeof v.offset === 'number')
  return false
}

const isMapping = (v: unknown): v is MappingSource => {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'copy':
    case 'link':
      return typeof v.input === 'string' && v.input.length > 0
    case 'value':
      return (
        typeof v.input === 'string' &&
        v.input.length > 0 &&
        (v.transform === undefined || isTransform(v.transform))
      )
    case 'constant':
      return 'value' in v
    default:
      return false
  }
}

const STRUCTURAL_ID = /^[A-Za-z0-9_-]+$/
const isDynamicPath = (value: string): boolean =>
  value.split('.').every((segment) => STRUCTURAL_ID.test(segment))

const isInputFamilyMapping = (v: unknown): v is InputFamilyMapping => {
  if (!isObj(v)) return false
  if (v.kind === 'copy') {
    return (
      typeof v.sourceFamily === 'string' &&
      STRUCTURAL_ID.test(v.sourceFamily) &&
      isObj(v.inputs) &&
      Object.keys(v.inputs).length > 0 &&
      Object.entries(v.inputs).every(([id, mapping]) => STRUCTURAL_ID.test(id) && isMapping(mapping))
    )
  }
  if (v.kind === 'members') {
    if (!Array.isArray(v.members) || v.members.length === 0) return false
    const suffixes = new Set<string>()
    for (const member of v.members) {
      if (!isObj(member) || typeof member.suffix !== 'string' || !STRUCTURAL_ID.test(member.suffix))
        return false
      if (suffixes.has(member.suffix) || !isObj(member.inputs) || Object.keys(member.inputs).length === 0)
        return false
      suffixes.add(member.suffix)
      if (!Object.entries(member.inputs).every(([id, mapping]) => STRUCTURAL_ID.test(id) && isMapping(mapping)))
        return false
    }
    return true
  }
  return false
}

const isOutputFamilyMapping = (v: unknown): v is OutputFamilyMapping => {
  if (!isObj(v)) return false
  if (v.kind === 'copy') {
    return hasExactKeys(v, ['kind', 'sourceFamily']) &&
      typeof v.sourceFamily === 'string' && STRUCTURAL_ID.test(v.sourceFamily)
  }
  if (v.kind === 'members') {
    if (!hasExactKeys(v, ['kind', 'members']) || !Array.isArray(v.members) || v.members.length === 0)
      return false
    const suffixes = new Set<string>()
    for (const member of v.members) {
      if (
        !isObj(member) ||
        !hasExactKeys(member, ['suffix', 'output']) ||
        typeof member.suffix !== 'string' ||
        !STRUCTURAL_ID.test(member.suffix) ||
        typeof member.output !== 'string' ||
        !STRUCTURAL_ID.test(member.output) ||
        suffixes.has(member.suffix)
      ) return false
      suffixes.add(member.suffix)
    }
    return true
  }
  return false
}

const addressLocalId = (
  address: string,
  localIds: ReadonlySet<string>,
  helpersEnabled: boolean,
): string | null | undefined => {
  if (!helpersEnabled) return address.length > 0 ? null : undefined
  const parts = address.split(':')
  if (parts.length === 1) return parts[0]!.length > 0 ? null : undefined
  if (
    parts.length !== 2 ||
    parts[0]!.length === 0 ||
    parts[1]!.length === 0 ||
    !STRUCTURAL_ID.test(parts[0]!) ||
    !localIds.has(parts[0]!)
  )
    return undefined
  return parts[0]!
}

const isSlotVariantAddress = (
  address: string,
  localIds: ReadonlySet<string>,
  helpersEnabled: boolean,
): boolean => {
  const parts = address.split(':')
  let path: string
  if (parts.length === 1) path = parts[0]!
  else if (
    helpersEnabled &&
    parts.length === 2 &&
    STRUCTURAL_ID.test(parts[0]!) &&
    localIds.has(parts[0]!)
  ) path = parts[1]!
  else return false
  return path.split('.').every((segment) => STRUCTURAL_ID.test(segment))
}

const isFamilyAddress = (
  address: string,
  localIds: ReadonlySet<string>,
  helpersEnabled: boolean,
): boolean => {
  const parts = address.split(':')
  if (parts.length === 1) return STRUCTURAL_ID.test(parts[0]!)
  return helpersEnabled &&
    parts.length === 2 &&
    STRUCTURAL_ID.test(parts[0]!) &&
    localIds.has(parts[0]!) &&
    STRUCTURAL_ID.test(parts[1]!)
}

const isReplacementNode = (v: unknown): v is ReplacementNode =>
  isObj(v) &&
  typeof v.type === 'string' &&
  v.type.length > 0 &&
  (v.values === undefined ||
    (isObj(v.values) && ownJson(v.values, { undefinedProps: 'reject' }).ok))

const isReplacementLink = (v: unknown): v is ReplacementLink =>
  isObj(v) && typeof v.from === 'string' && typeof v.to === 'string'

const isCase = (v: unknown): v is ReplacementCase => {
  if (!isObj(v)) return false
  const allowed = new Set(['when', 'to', 'nodes', 'slotVariants', 'inputs', 'inputFamilies', 'links', 'outputs', 'outputFamilies'])
  if (Object.keys(v).some((key) => !allowed.has(key))) return false
  if (typeof v.to !== 'string' || v.to.length === 0) return false
  if (v.when !== undefined && !isPredicate(v.when)) return false
  if (
    v.nodes !== undefined &&
    !(
      isObj(v.nodes) &&
      Object.entries(v.nodes).every(([id, node]) => STRUCTURAL_ID.test(id) && isReplacementNode(node))
    )
  )
    return false
  const localIds = new Set(Object.keys((v.nodes as Record<string, unknown> | undefined) ?? {}))
  const helpersEnabled = v.nodes !== undefined
  if (
    v.slotVariants !== undefined &&
    !(
      isObj(v.slotVariants) &&
      Object.keys(v.slotVariants).length > 0 &&
      Object.entries(v.slotVariants).every(
        ([address, choice]) => isSlotVariantAddress(address, localIds, helpersEnabled) &&
          typeof choice === 'string' && choice.length > 0,
      )
    )
  )
    return false
  if (v.inputs !== undefined && !(isObj(v.inputs) && Object.values(v.inputs).every(isMapping)))
    return false
  if (
    v.inputFamilies !== undefined &&
    !(
      isObj(v.inputFamilies) &&
      Object.entries(v.inputFamilies).every(
        ([family, mapping]) =>
          isFamilyAddress(family, localIds, helpersEnabled) && isInputFamilyMapping(mapping),
      )
    )
  )
    return false
  if (
    v.inputs !== undefined &&
    Object.keys(v.inputs as Record<string, unknown>).some(
      (address) => addressLocalId(address, localIds, helpersEnabled) === undefined,
    )
  )
    return false
  if (v.links !== undefined && !(Array.isArray(v.links) && v.links.every(isReplacementLink))) return false
  const links = (v.links ?? []) as readonly ReplacementLink[]
  if (
    links.some(
      (link) =>
        addressLocalId(link.from, localIds, helpersEnabled) === undefined ||
        addressLocalId(link.to, localIds, helpersEnabled) === undefined,
    )
  )
    return false
  if (
    v.outputs !== undefined &&
    !(isObj(v.outputs) && Object.values(v.outputs).every((x) => typeof x === 'string'))
  )
    return false
  if (
    v.outputs !== undefined &&
    Object.keys(v.outputs as Record<string, unknown>).some(
      (address) => addressLocalId(address, localIds, helpersEnabled) === undefined,
    )
  )
    return false
  if (
    v.outputFamilies !== undefined &&
    !(
      isObj(v.outputFamilies) &&
      Object.entries(v.outputFamilies).every(
        ([family, mapping]) => STRUCTURAL_ID.test(family) && isOutputFamilyMapping(mapping),
      )
    )
  )
    return false

  // One feeder per target input, across both source mappings and internal links.
  const fed = new Set(Object.keys((v.inputs as Record<string, unknown> | undefined) ?? {}))
  for (const link of links) {
    if (fed.has(link.to)) return false
    fed.add(link.to)
  }
  // Existing output fan-in rule: a source output is consumed at most once.
  const sourceOutputs = new Set<string>()
  for (const sourceOutput of Object.values((v.outputs as Record<string, string> | undefined) ?? {})) {
    if (sourceOutputs.has(sourceOutput)) return false
    sourceOutputs.add(sourceOutput)
  }
  const sourceFamilies = new Set<string>()
  for (const family of Object.values(
    (v.outputFamilies as Record<string, OutputFamilyMapping> | undefined) ?? {},
  )) {
    if (family.kind === 'copy') {
      if (sourceFamilies.has(family.sourceFamily)) return false
      sourceFamilies.add(family.sourceFamily)
      continue
    }
    for (const member of family.members) {
      if (sourceOutputs.has(member.output)) return false
      sourceOutputs.add(member.output)
    }
  }

  // Internal node-level graph must be acyclic. Primary is represented by ''.
  const edges = new Map<string, Set<string>>()
  for (const link of links) {
    const from = addressLocalId(link.from, localIds, helpersEnabled) ?? ''
    const to = addressLocalId(link.to, localIds, helpersEnabled) ?? ''
    const outgoing = edges.get(from)
    if (outgoing) outgoing.add(to)
    else edges.set(from, new Set([to]))
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const cyclic = (node: string): boolean => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    for (const next of edges.get(node) ?? []) if (cyclic(next)) return true
    visiting.delete(node)
    visited.add(node)
    return false
  }
  for (const node of ['', ...localIds]) if (cyclic(node)) return false
  return true
}

/**
 * Structural validation of a rule that arrived as Json. Beyond field shapes
 * it enforces the fallback contract: the last case must be unconditional
 * ('always' or omitted `when`), so evaluation can never fall off the end.
 */
export const isReplacementRule = (v: unknown): v is ReplacementRule => {
  if (!isObj(v)) return false
  if (typeof v.from !== 'string' || v.from.length === 0) return false
  if (v.note !== undefined && typeof v.note !== 'string') return false
  if (v.migration !== undefined) {
    if (!isObj(v.migration) || !hasExactKeys(v.migration, ['historicalInputs'])) return false
    const historicalInputs = v.migration.historicalInputs
    if (
      !Array.isArray(historicalInputs) ||
      historicalInputs.length === 0 ||
      historicalInputs.some((input) => typeof input !== 'string' || !isDynamicPath(input)) ||
      new Set(historicalInputs).size !== historicalInputs.length
    ) return false
  }
  if (!Array.isArray(v.cases) || v.cases.length === 0 || !v.cases.every(isCase)) return false
  if (v.migration !== undefined && v.cases.some((candidate) => candidate.to !== v.from)) return false
  const last = v.cases[v.cases.length - 1] as ReplacementCase
  return last.when === undefined || last.when.kind === 'always'
}
