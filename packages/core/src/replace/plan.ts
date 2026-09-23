/**
 * Replacement planner: resolves a ReplacementRule against one node in a
 * document into an explicit, Json-serializable NodeReplacePlan - or
 * diagnostics.
 *
 * Split deliberately: PLANNING needs schema knowledge (target defaults, port
 * validation) and lives here as a pure function; APPLICATION is an ordinary
 * document command (`node.replace`) that takes the finished plan as params,
 * because commands are doc-level and schema-blind by contract. Ambiguous or
 * impossible ordinary mappings produce ERROR diagnostics and no plan. A
 * migration's authored universal fallback may instead choose its default and
 * archive displaced historical state. Other lossy-but-possible outcomes (a
 * connection no mapping consumes) produce WARNINGS: the plan exists but must
 * drop to review instead of auto-applying.
 *
 * Ordinary static mappings do not require the SOURCE schema: they read only
 * document state, so a rule can upgrade a missing-node placeholder. When a
 * source schema is available, locally-enumerated combo values are validated
 * before case selection so a malformed selector cannot fall into a rule's
 * fallback case. Count-bound output-family copies additionally require the
 * source schema because their exact member set must be elaborated.
 */

import type { Diagnostic } from '../diagnostics.js'
import { canonicalJson, fnv1a64 } from '../compile/hash.js'
import type { BoundaryBinding, DynamicPortState, GraphDef, Json, JsonObject, NodeData, WorkflowDocument } from '../format/document.js'
import { asNodeId, asPortId, isExactWidgetTapRef, isPortEndpoint, isWidgetTapRef, samePortRef, type PortRef } from '../ids.js'
import { normalizedComboOptions } from '../schema/combo-options.js'
import { canonicalCompatTypeIdOf } from '../schema/type-compatibility.js'
import {
  buildGraphConnectivity,
  collectWire15MemberEvidence,
  elabKeyOf,
  elabInputsOf,
  elabOutputsOf,
  elaborateInterface,
  EMPTY_CONNECTIVITY,
  valueKeyOf,
  type Connectivity,
  type ElaboratedInput,
} from '../schema/elaborate.js'
import {
  autogrowBounds,
  comboBranchValuePath,
  defaultValuesOf,
  effectiveComboOption,
  inputsOf,
  joinValuePath,
  outputCountInputsOf,
  outputsOf,
  type AutogrowSpec,
  type CountBoundOutputAutogrowSpec,
  type DynamicComboSpec,
  type DynamicSlotSpec,
  type InputSpec,
  type NodeSchema,
  type TypeExpr,
} from '../schema/model.js'
import type {
  InputFamilyMapping,
  MappingSource,
  ReplacementCase,
  ReplacementPredicate,
  ReplacementRule,
} from './model.js'

// ---------------------------------------------------------------------------
// Plan shape (command params for node.replace - plain Json by construction)
// ---------------------------------------------------------------------------

export const REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY = 'dinkster.replacementMigration'

export interface NodeReplacePlan {
  readonly graphId: string
  readonly nodeId: string
  /** Expected CURRENT type - the staleness guard at apply time. */
  readonly from: string
  readonly to: string
  readonly note?: string
  /** Which rule case matched (for review UI/diagnostics). */
  readonly caseIndex: number
  /** Complete explicit target values (defaults + mappings). */
  readonly values: Readonly<Record<string, Json>>
  /** Complete target dynamic state when a rule maps choices or input families. */
  readonly dynamic?: Readonly<Record<string, DynamicPortState>>
  /** Stored source count literals that copied output families depend on. */
  readonly sourceCountGuards?: Readonly<Record<string, Json>>
  /** Exact target schemas used to validate selected dynamic constructs. */
  readonly targetSchemaGuards?: ReadonlyArray<{
    readonly nodeId: string
    readonly type: string
    readonly schemaHash: string
  }>
  /** Carried controller modes keyed by TARGET input id. */
  readonly controllers?: Readonly<Record<string, string>>
  /** Recoverable source snapshot for best-effort same-type migrations. */
  readonly migrationArchive?: JsonObject
  /** An unmatched same-type migration case that must auto-apply best effort. */
  readonly migrationFallback?: true
  /** Links whose `to` moves to a target input id (same node). */
  readonly inputRewires: ReadonlyArray<{ readonly link: string; readonly port: string; readonly node?: string }>
  /** Historical per-input view choices that follow active migrated inputs. */
  readonly inputViewRewires?: ReadonlyArray<{ readonly fromInput: string; readonly input: string }>
  /** Historical per-input view choices with no active destination. */
  readonly dropInputViews?: readonly string[]
  /** Links whose `from` moves to a target output or output-family member. */
  readonly outputRewires: ReadonlyArray<{
    readonly link: string
    readonly port: string
    readonly node?: string
    readonly members?: readonly string[]
    readonly fromPort?: string
    readonly fromMembers?: readonly string[]
  }>
  /** Widget-tap sources whose target widget path or node changes. */
  readonly tapRewires?: ReadonlyArray<{
    readonly link: string
    readonly tap: string
    readonly fromTap?: string
    readonly node?: string
  }>
  /** Widget-tap sources captured at plan time and checked for exact staleness. */
  readonly tapGuards?: ReadonlyArray<{ readonly link: string; readonly tap: string }>
  /** Per-input view representations whose mapped widget path or node changes. */
  readonly viewRewires?: ReadonlyArray<{ readonly from: string; readonly to: string; readonly node?: string }>
  /** Connections no mapping consumes - removed explicitly (review-visible). */
  readonly dropLinks: readonly string[]
  /** Net source rewires, including output-family member identity. */
  readonly netSourceRewires: ReadonlyArray<{
    readonly net: string
    readonly port: string
    readonly node?: string
    readonly members?: readonly string[]
    readonly fromPort?: string
    readonly fromMembers?: readonly string[]
  }>
  /** Complete replacement sink arrays for nets whose sinks change. */
  readonly netSinks: ReadonlyArray<{ readonly net: string; readonly sinks: readonly PortRef[] }>
  /** Exact source-to-target sink edits used to compose independently planned nodes. */
  readonly netSinkEdits?: ReadonlyArray<{
    readonly net: string
    readonly from: PortRef
    readonly to?: PortRef
  }>
  /** Nets whose source this node feeds but no output mapping preserves. */
  readonly dropNets: readonly string[]
  /**
   * Subgraph boundary bindings on this node whose bound port id changes
   * (the binding follows the mapping, exactly like a link endpoint). Same
   * port id needs no rewire - the binding stays valid because the node id
   * survives replacement. `alsoIndex` addresses a fan-out entry in
   * `alsoBinds`; absent = the primary `binds`.
   */
  readonly boundaryRewires?: ReadonlyArray<{
    readonly item: string
    readonly side: 'input' | 'output'
    /** The port the binding held when the plan was computed (stale check). */
    readonly fromPort: string
    readonly port: string
    readonly alsoIndex?: number
  }>
  /**
   * EVERY static boundary binding on this node at plan time - including
   * identity-mapped ones that need no rewire - with the primary input
   * binding's promoted flag. The apply-time staleness guard compares this
   * against the CURRENT boundary exactly: a binding added, retargeted, or
   * (un)promoted since planning makes the plan stale, so a rewire list that
   * validated at plan time can never silently coexist with boundary state
   * the planner never saw.
   */
  readonly boundaryGuard?: ReadonlyArray<{
    readonly item: string
    readonly side: 'input' | 'output'
    readonly port: string
    readonly alsoIndex?: number
    readonly promoted?: boolean
  }>
  /**
   * Helper nodes inserted by this rule/case. Presence, including an empty
   * array, marks net sink rewrites as node-owned so independently planned
   * replacements compose.
   */
  readonly createdNodes?: ReadonlyArray<{
    readonly nodeId: string
    readonly localId: string
    readonly type: string
    readonly values: Readonly<Record<string, Json>>
    readonly dynamic?: Readonly<Record<string, DynamicPortState>>
    readonly controllers?: Readonly<Record<string, string>>
  }>
  /** Internal links created after the primary replacement and helper creation. */
  readonly links?: ReadonlyArray<{ readonly from: PortRef; readonly to: PortRef }>
}

export interface ReplacementPlanResult {
  /** Present unless an ERROR diagnostic made the mapping impossible. */
  readonly plan?: NodeReplacePlan
  /** Errors block apply entirely; warnings force review mode. */
  readonly diagnostics: readonly Diagnostic[]
}

export type ReplacementSchemaResolver = (
  type: string,
  role: 'source' | 'target',
) => NodeSchema | undefined

// ---------------------------------------------------------------------------
// Predicate evaluation (document state only)
// ---------------------------------------------------------------------------

const deepEquals = (a: Json | undefined, b: Json): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

interface SourceState {
  readonly node: NodeData
  /** Source input path -> link ids feeding its memberless endpoint. */
  readonly linksIn: ReadonlyMap<string, readonly string[]>
  /** Source input path -> nets with a memberless sink on it. */
  readonly netsIn: ReadonlyMap<string, readonly string[]>
  /** Source output id -> link ids whose `from` leaves it (static ports only). */
  readonly linksOut: ReadonlyMap<string, readonly string[]>
  /** Source tap id -> link ids whose `from` leaves it (static, memberless producers only). */
  readonly tapLinksOut: ReadonlyMap<string, readonly string[]>
  /** Tap-shaped sources with extra fields or empty identity; planning refuses them. */
  readonly invalidTapLinks: readonly string[]
  /** Source output id -> nets sourced from it (static ports only). */
  readonly netsOut: ReadonlyMap<string, readonly string[]>
  /** Top-level output-family endpoint -> outgoing link ids. */
  readonly memberLinksOut: ReadonlyMap<string, readonly string[]>
  /** Top-level output-family endpoint -> sourced net ids. */
  readonly memberNetsOut: ReadonlyMap<string, readonly string[]>
  /** Links entering a dynamic member remain unsupported. */
  readonly memberLinksIn: ReadonlySet<string>
  /** Every link using member endpoint ancestry, including unsupported nesting. */
  readonly memberLinks: readonly string[]
  /** Nets sourced from any member output of this node. */
  readonly memberNets: readonly string[]
  /** Nets with a member-addressed sink on this node - sink always dropped. */
  readonly memberSinkNets: readonly string[]
}

const memberOutputKey = (family: string, suffix: string): string => JSON.stringify([family, suffix])
const memberOutputAddress = (key: string): { family: string; suffix: string } => {
  const [family, suffix] = JSON.parse(key) as [string, string]
  return { family, suffix }
}

const sourceStateOf = (def: GraphDef, node: NodeData): SourceState => {
  const linksIn = new Map<string, string[]>()
  const linksOut = new Map<string, string[]>()
  const tapLinksOut = new Map<string, string[]>()
  const invalidTapLinks: string[] = []
  const netsIn = new Map<string, string[]>()
  const netsOut = new Map<string, string[]>()
  const memberLinksOut = new Map<string, string[]>()
  const memberNetsOut = new Map<string, string[]>()
  const memberLinksIn = new Set<string>()
  const memberLinks: string[] = []
  const memberNets: string[] = []
  const memberSinkNets: string[] = []
  const push = (m: Map<string, string[]>, key: string, id: string): void => {
    const list = m.get(key)
    if (list) list.push(id)
    else m.set(key, [id])
  }
  for (const link of Object.values(def.links)) {
    if (isPortEndpoint(link.to) && link.to.node === node.id) {
      if (link.to.members !== undefined) {
        memberLinks.push(link.id)
        memberLinksIn.add(link.id)
      }
      else push(linksIn, link.to.port, link.id)
    }
    if (isPortEndpoint(link.from) && link.from.node === node.id) {
      if (link.from.members !== undefined) {
        if (!memberLinks.includes(link.id)) memberLinks.push(link.id)
        if (link.from.members.length === 1)
          push(memberLinksOut, memberOutputKey(link.from.port, link.from.members[0]!), link.id)
      } else push(linksOut, link.from.port, link.id)
    }
    if (isWidgetTapRef(link.from) && link.from.node === node.id) {
      if (isExactWidgetTapRef(link.from)) push(tapLinksOut, link.from.tap, link.id)
      else invalidTapLinks.push(link.id)
    }
  }
  for (const net of Object.values(def.nets)) {
    if (net.source.node === node.id) {
      if (net.source.members !== undefined) {
        memberNets.push(net.id)
        if (net.source.members.length === 1)
          push(memberNetsOut, memberOutputKey(net.source.port, net.source.members[0]!), net.id)
      }
      else push(netsOut, net.source.port, net.id)
    }
    for (const sink of net.sinks) {
      if (sink.node !== node.id) continue
      if (sink.members !== undefined) memberSinkNets.push(net.id)
      else push(netsIn, sink.port, net.id)
    }
  }
  return {
    node,
    linksIn,
    netsIn,
    linksOut,
    tapLinksOut,
    invalidTapLinks,
    netsOut,
    memberLinksOut,
    memberNetsOut,
    memberLinksIn,
    memberLinks,
    memberNets,
    memberSinkNets,
  }
}

const isConnected = (s: SourceState, input: string): boolean =>
  (s.linksIn.get(input)?.length ?? 0) > 0 || (s.netsIn.get(input)?.length ?? 0) > 0

const storedSourceValue = (s: SourceState, input: string): Json | undefined => {
  const value = s.node.values[input]
  return value === undefined ? s.node.dynamic?.[input]?.selected : value
}

export const evaluatePredicate = (p: ReplacementPredicate, s: SourceState): boolean => {
  switch (p.kind) {
    case 'always':
      return true
    case 'inputConnected':
      return isConnected(s, p.input)
    case 'valuePresent':
      return storedSourceValue(s, p.input) !== undefined
    case 'valueEquals':
      return deepEquals(storedSourceValue(s, p.input), p.value)
    case 'not':
      return !evaluatePredicate(p.of, s)
    case 'all':
      return p.of.every((x) => evaluatePredicate(x, s))
    case 'any':
      return p.of.some((x) => evaluatePredicate(x, s))
  }
}

const comparedPredicateInputs = (predicate: ReplacementPredicate): readonly string[] => {
  switch (predicate.kind) {
    case 'valueEquals':
      return [predicate.input]
    case 'not':
      return comparedPredicateInputs(predicate.of)
    case 'all':
    case 'any':
      return predicate.of.flatMap(comparedPredicateInputs)
    // Presence checks inspect document shape, not runtime selector values.
    case 'valuePresent':
    case 'always':
    case 'inputConnected':
      return []
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const diag = (severity: 'error' | 'warning' | 'info', code: string, message: string): Diagnostic => ({
  severity,
  origin: 'command',
  code,
  message,
})

type DynamicStateScope = Readonly<Record<string, DynamicPortState>>

/** Validate every persisted selector against the schema branch that owns it. */
const sourceDynamicSelectionProblem = (
  schema: NodeSchema,
  node: Pick<NodeData, 'values' | 'dynamic'>,
): string | undefined => {
  const activeChoices = new WeakMap<object, Map<string, Set<string>>>()
  const possibleChoices = new WeakMap<object, Map<string, Set<string>>>()
  const addChoices = (
    inventory: WeakMap<object, Map<string, Set<string>>>,
    state: DynamicStateScope | undefined,
    path: string,
    choices: readonly string[],
  ): void => {
    if (state === undefined) return
    let paths = inventory.get(state)
    if (paths === undefined) {
      paths = new Map()
      inventory.set(state, paths)
    }
    const allowed = paths.get(path) ?? new Set<string>()
    for (const choice of choices) allowed.add(choice)
    paths.set(path, allowed)
  }
  const visit = (
    entries: readonly InputSpec[],
    prefix: string,
    state: DynamicStateScope | undefined,
    active: boolean,
  ): void => {
    for (const entry of entries) {
      const path = joinValuePath(prefix, entry.id)
      const spec = entry.dynamic
      if (spec === undefined) continue
      const stored = state?.[path]
      if (spec.kind === 'dynamicCombo') {
        const choices = spec.options.map((option) => option.key)
        addChoices(possibleChoices, state, path, choices)
        if (active) addChoices(activeChoices, state, path, choices)
        const selected = effectiveComboOption(spec, stored)
        for (const option of spec.options) {
          visit(
            option.inputs,
            spec.materialization === 'wire15' ? path : comboBranchValuePath(path, option.key),
            state,
            active && option.key === selected,
          )
        }
        continue
      }
      if (spec.kind === 'dynamicSlot') {
        const choices = (spec.variants ?? []).map((variant) => variant.key)
        addChoices(possibleChoices, state, path, choices)
        if (active) addChoices(activeChoices, state, path, choices)
        visit(spec.inputs, path, state, active)
        for (const variant of spec.variants ?? []) {
          visit(
            variant.inputs,
            spec.materialization === 'wire15' ? path : comboBranchValuePath(path, variant.key),
            state,
            active && variant.key === stored?.selected,
          )
        }
        continue
      }
      const storedMembers = stored?.members ?? []
      const wire15 = spec.materialization === 'wire15'
      const members = wire15
        ? collectWire15MemberEvidence(
            path,
            storedMembers,
            Object.keys(node.values),
            [],
            Object.keys(node.dynamic ?? {}),
          )
        : storedMembers
      for (const member of members) {
        if (wire15) {
          visit(spec.template, joinValuePath(path, member), node.dynamic, active)
        } else {
          visit(spec.template, path, stored?.memberState?.[member], active)
        }
      }
    }
  }

  visit(inputsOf(schema), '', node.dynamic, true)

  let problem: string | undefined
  const inspect = (state: DynamicStateScope | undefined): void => {
    if (state === undefined || problem !== undefined) return
    for (const [path, stored] of Object.entries(state)) {
      if (stored.selected !== undefined) {
        const choices = activeChoices.get(state)?.get(path) ?? possibleChoices.get(state)?.get(path)
        if (choices === undefined || !choices.has(stored.selected)) {
          problem = `${schema.type}.${path}: stored dynamic choice '${stored.selected}' is not declared`
          return
        }
      }
      for (const memberState of Object.values(stored.memberState ?? {})) inspect(memberState)
    }
  }
  inspect(node.dynamic)
  return problem
}

/** Static (non-dynamic, non-stamped) port lookup on the target schema. */
const staticTargetInput = (schema: NodeSchema, id: string) =>
  inputsOf(schema).find((i) => i.id === id && i.dynamic === undefined)
const staticTargetOutput = (schema: NodeSchema, id: string) =>
  outputsOf(schema).find((o) => o.id === id && o.dynamic === undefined)

interface Wire15InputFamily {
  readonly id: string
  readonly spec: AutogrowSpec
  readonly template: readonly InputSpec[]
}

interface CountOutputFamily {
  readonly id: string
  readonly spec: CountBoundOutputAutogrowSpec
}

const countOutputFamily = (schema: NodeSchema, id: string): CountOutputFamily | undefined => {
  const item = outputsOf(schema).find((candidate) => candidate.id === id)
  const spec = item?.dynamic
  if (
    spec?.kind !== 'autogrow' ||
    !('count' in spec) ||
    spec.naming.kind === 'native' ||
    spec.template.length !== 1 ||
    spec.template[0]!.dynamic !== undefined
  ) return undefined
  return { id, spec }
}

const wire15InputFamily = (schema: NodeSchema, id: string): Wire15InputFamily | undefined => {
  const item = inputsOf(schema).find((candidate) => candidate.id === id)
  const spec = item?.dynamic
  if (
    spec?.kind !== 'autogrow' ||
    spec.materialization !== 'wire15' ||
    spec.naming.kind === 'native' ||
    spec.template.some((entry) => entry.dynamic !== undefined)
  )
    return undefined
  return { id, spec, template: spec.template }
}

const wire15FamilyInputPath = (
  family: Wire15InputFamily,
  suffix: string,
  input: string,
): string => {
  const member = joinValuePath(family.id, suffix)
  return family.template.length === 1 ? member : joinValuePath(member, input)
}

const WIRE15_MEMBER_ID = /^[A-Za-z0-9_-]+$/

const familyMembersAreAdmitted = (family: Wire15InputFamily, members: readonly string[]): boolean => {
  const { min, max } = autogrowBounds(family.spec)
  if (
    members.length < min ||
    members.length > max ||
    new Set(members).size !== members.length ||
    members.some((member) => !WIRE15_MEMBER_ID.test(member))
  )
    return false
  return (
    family.spec.naming.kind !== 'names' ||
    members.every((member) => family.spec.naming.kind === 'names' && family.spec.naming.names.includes(member))
  )
}

const familyDynamicState = (
  members: readonly string[],
  source?: DynamicPortState,
): DynamicPortState => {
  const suffixes = members
    .map((member) => /^m(\d{1,15})$/.exec(member)?.[1])
    .filter((suffix): suffix is string => suffix !== undefined)
    .map(Number)
  const seq = Math.max(source?.seq ?? 0, ...(suffixes.length > 0 ? suffixes.map((n) => n + 1) : [0]))
  return { members, ...(seq > 0 ? { seq } : {}) }
}

const staticWidgetTap = (
  schema: NodeSchema,
  state: Pick<NodeData, 'values' | 'dynamic'>,
  id: string,
) => {
  const matches = elabInputsOf(
    elaborateInterface(schema, state, EMPTY_CONNECTIVITY, { promoteGhosts: false }),
  ).filter((input) =>
    input.address.port === id &&
    input.address.members === undefined &&
    input.origin.kind === 'static' &&
    input.spec.widget !== undefined &&
    input.spec.forceInput !== true,
  )
  return matches.length === 1 ? matches[0] : undefined
}

interface TargetAddress {
  readonly localId?: string
  readonly nodeId: string
  readonly port: string
  readonly schema: NodeSchema
}

interface TargetOutputAddress extends TargetAddress {
  readonly members?: readonly string[]
}

type ChoiceSpec = DynamicComboSpec | (DynamicSlotSpec & { readonly variants: NonNullable<DynamicSlotSpec['variants']> })

const declaredChoiceSpecs = (
  schema: NodeSchema,
  path: string,
  selected: Readonly<Record<string, DynamicPortState>>,
): readonly ChoiceSpec[] => {
  const segments = path.split('.')
  const choices: ChoiceSpec[] = []
  const add = (spec: ChoiceSpec): void => {
    if (!choices.some((candidate) => canonicalJson(candidate) === canonicalJson(spec))) choices.push(spec)
  }
  const visit = (inputs: readonly InputSpec[], index: number, prefix: string): void => {
    if (index >= segments.length) return
    for (const input of inputs) {
      if (input.id !== segments[index]) continue
      const dynamic = input.dynamic
      if (dynamic === undefined) continue
      const construct = joinValuePath(prefix, input.id)
      if (dynamic.kind === 'dynamicCombo') {
        if (index === segments.length - 1) add(dynamic)
        else {
          const active = effectiveComboOption(dynamic, selected[construct])
          const option = dynamic.options.find((candidate) => candidate.key === active)
          if (option !== undefined) visit(option.inputs, index + 1, construct)
        }
      } else if (dynamic.kind === 'dynamicSlot') {
        if (index === segments.length - 1 && dynamic.variants !== undefined) add(dynamic as ChoiceSpec)
        else if (index < segments.length - 1) {
          visit(dynamic.inputs, index + 1, construct)
          const variant = dynamic.variants?.find((candidate) =>
            candidate.key === selected[construct]?.selected)
          if (variant !== undefined) visit(variant.inputs, index + 1, construct)
        }
      } else if (
        dynamic.materialization === 'wire15' &&
        dynamic.naming.kind !== 'native' &&
        index + 2 < segments.length
      ) {
        const member = segments[index + 1]!
        if (
          WIRE15_MEMBER_ID.test(member) &&
          (dynamic.naming.kind !== 'names' || dynamic.naming.names.includes(member))
        ) visit(dynamic.template, index + 2, joinValuePath(construct, member))
      }
    }
  }
  visit(inputsOf(schema), 0, '')
  return choices
}

const missingRequiredSlotChoices = (
  schema: NodeSchema,
  dynamic: Readonly<Record<string, DynamicPortState>>,
  connected: ReadonlySet<string>,
): readonly string[] => {
  const missing: string[] = []
  const visit = (inputs: readonly InputSpec[], prefix: string): void => {
    for (const input of inputs) {
      const spec = input.dynamic
      if (spec === undefined) continue
      const path = joinValuePath(prefix, input.id)
      const selected = dynamic[path]?.selected
      if (spec.kind === 'dynamicCombo') {
        const effective = effectiveComboOption(spec, selected === undefined ? undefined : { selected })
        const option = spec.options.find((candidate) => candidate.key === effective)
        if (option !== undefined) visit(option.inputs, path)
      } else if (spec.kind === 'dynamicSlot') {
        if (spec.variants !== undefined && selected === undefined &&
            (!input.optional || connected.has(path))) missing.push(path)
        const variant = spec.variants?.find((candidate) => candidate.key === selected)
        if (spec.materialization === 'wire15' || connected.has(path)) {
          visit(spec.inputs, path)
          if (variant !== undefined) visit(variant.inputs, path)
        }
      } else if (spec.materialization === 'wire15' && spec.naming.kind !== 'native') {
        const members = new Set(spec.naming.kind === 'names'
          ? (dynamic[path]?.members ?? []).filter((member) => spec.naming.kind === 'names' && spec.naming.names.includes(member))
          : dynamic[path]?.members ?? [])
        for (const channel of [Object.keys(dynamic), [...connected]]) {
          for (const key of channel) {
            if (!key.startsWith(`${path}.`)) continue
            const member = key.slice(path.length + 1).split('.', 1)[0]!
            if (
              WIRE15_MEMBER_ID.test(member) &&
              (spec.naming.kind !== 'names' || spec.naming.names.includes(member))
            ) members.add(member)
          }
        }
        for (const member of members) visit(spec.template, joinValuePath(path, member))
      }
    }
  }
  visit(inputsOf(schema), '')
  return missing
}

const dynamicStateHasSelection = (state: DynamicPortState): boolean =>
  state.selected !== undefined ||
  Object.values(state.memberState ?? {}).some((constructs) =>
    Object.values(constructs).some(dynamicStateHasSelection),
  )

const dynamicStatesHaveSelection = (
  dynamic: Readonly<Record<string, DynamicPortState>>,
): boolean => Object.values(dynamic).some(dynamicStateHasSelection)

/**
 * Resolve `rule` against one node. Pure: no mutation, no randomness. The
 * result's warnings force review; errors mean no plan at all.
 */
export function planReplacement(
  document: WorkflowDocument,
  graphId: string,
  nodeId: string,
  rule: ReplacementRule,
  resolve: ReplacementSchemaResolver,
): ReplacementPlanResult {
  const def = document.graphs[graphId]
  const node = def?.nodes[nodeId]
  if (!def || !node)
    return { diagnostics: [diag('error', 'replace.node.missing', `replace: no node '${nodeId}' in graph '${graphId}'`)] }
  if (node.type !== rule.from)
    return {
      diagnostics: [
        diag('error', 'replace.type.mismatch', `replace: node '${nodeId}' is '${node.type}', rule migrates '${rule.from}'`),
      ],
    }

  const state = sourceStateOf(def, node)
  const sourceSchema = rule.migration === undefined ? resolve(node.type, 'source') : undefined
  const migrationHistoricalInputs = new Set(rule.migration?.historicalInputs ?? [])
  const migrationInvalidTapLinks = state.invalidTapLinks.filter((id) => {
    const source = def.links[id]?.from
    return source !== undefined &&
      isWidgetTapRef(source) &&
      typeof source.tap === 'string' &&
      migrationHistoricalInputs.has(source.tap)
  })
  const invalidTapLinks = rule.migration === undefined
    ? state.invalidTapLinks
    : migrationInvalidTapLinks
  const migrationSelectorInputs = new Set<string>()
  const historicalViewInputs = rule.migration === undefined
    ? []
    : Object.keys(document.view.graphs[graphId]?.nodes[nodeId]?.views ?? {})
      .filter((input) => migrationHistoricalInputs.has(input))
  const historicalViews = document.view.graphs[graphId]?.nodes[nodeId]?.views ?? {}
  const boundaryHasHistoricalInput = (def.boundary?.inputs ?? []).some((item) =>
    [item.binds, ...(item.alsoBinds ?? [])].some((binding) =>
      binding.kind !== 'widgetTap' && binding.node === nodeId && migrationHistoricalInputs.has(binding.port),
    ),
  )
  const migrationEvidence = rule.migration?.historicalInputs.some((input) =>
    Object.hasOwn(node.values, input) ||
    node.dynamic?.[input]?.selected !== undefined ||
    Object.hasOwn(node.controllers ?? {}, input) ||
    (state.linksIn.get(input)?.length ?? 0) > 0 ||
    (state.netsIn.get(input)?.length ?? 0) > 0 ||
    (state.tapLinksOut.get(input)?.length ?? 0) > 0,
  ) === true || historicalViewInputs.length > 0 || boundaryHasHistoricalInput || migrationInvalidTapLinks.length > 0
  if (rule.migration !== undefined && !migrationEvidence) return { diagnostics: [] }

  let sourceElaboration: ReturnType<typeof elaborateInterface> | undefined
  if (rule.migration === undefined && sourceSchema !== undefined) {
    const dynamicProblem = sourceDynamicSelectionProblem(sourceSchema, node)
    if (dynamicProblem !== undefined) {
      return {
        diagnostics: [diag(
          'error',
          'replace.source.invalid',
          `replace: source '${node.type}' has invalid dynamic state: ${dynamicProblem}`,
        )],
      }
    }
    sourceElaboration = elaborateInterface(
      sourceSchema,
      node,
      buildGraphConnectivity(def)(node.id),
      { promoteGhosts: false },
    )
    const invalidElaboration = sourceElaboration.diagnostics.find((diagnostic) =>
      diagnostic.code === 'elab.combo.unknownOption' ||
      diagnostic.code === 'elab.slot.unknownVariant' ||
      diagnostic.code === 'prompt.bad_dynamic_choice',
    )
    if (invalidElaboration !== undefined) {
      return {
        diagnostics: [diag(
          'error',
          'replace.source.invalid',
          `replace: source '${node.type}' cannot be elaborated: ${invalidElaboration.message}`,
        )],
      }
    }
    for (const input of elabInputsOf(sourceElaboration)) {
      if (
        input.address.members !== undefined ||
        input.spec.widget?.widgetType !== 'COMBO' ||
        input.spec.widget.remote !== undefined
      ) continue
      const stored = node.values[valueKeyOf(input)]
      if (stored === undefined || !Array.isArray(input.spec.widget.options['options'])) continue
      const options = normalizedComboOptions(input.spec.widget)
      if (options.some((option) => option.value === stored)) continue
      return {
        diagnostics: [diag(
          'error',
          'replace.source.valueInvalid',
          `replace: source input '${input.address.port}' stores a value outside its schema choices`,
        )],
      }
    }
  }

  // First matching case wins; the final case is the universal fallback.
  let matched: ReplacementCase | undefined
  let caseIndex = -1
  for (let i = 0; i < rule.cases.length; i++) {
    const c = rule.cases[i]!
    if (c.when === undefined || evaluatePredicate(c.when, state)) {
      matched = c
      caseIndex = i
      break
    }
  }
  if (!matched)
    return { diagnostics: [diag('error', 'replace.case.none', `replace: no case of rule '${rule.from}' matched (missing fallback?)`)] }

  const migrationUsedFallback = rule.migration !== undefined &&
    (matched.when === undefined || matched.when.kind === 'always')
  const primaryConstructPaths = Object.keys(matched.slotVariants ?? {}).filter((path) => !path.includes(':'))
  if (rule.migration !== undefined) {
    const carriesTargetState = primaryConstructPaths.some((path) =>
      Object.keys(node.dynamic ?? {}).some((key) => key === path || key.startsWith(`${path}.`)) ||
      Object.keys(node.values).some((key) => key.startsWith(`${path}.`)),
    )
    if (carriesTargetState) return { diagnostics: [] }
  }

  if (matched.to.startsWith('#'))
    return { diagnostics: [diag('error', 'replace.target.subgraph', 'replace: rules cannot target subgraph instances')] }
  const target = resolve(matched.to, 'target')
  if (!target)
    return {
      diagnostics: [diag('error', 'replace.target.unknown', `replace: target type '${matched.to}' has no schema on this backend`)],
    }

  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  let migrationDisplacedState = false
  if (invalidTapLinks.length > 0) {
    errors.push(diag(
      'error',
      rule.migration === undefined ? 'replace.tap.invalid' : 'replace.migration.inactiveRuntime',
      `replace: ${invalidTapLinks.length} malformed widget-tap source(s) must be removed before replacement`,
    ))
  }

  const helperTargets = new Map<string, { nodeId: string; schema: NodeSchema; type: string }>()
  const graphHasId = (id: string): boolean =>
    def.nodes[id] !== undefined ||
    def.links[id] !== undefined ||
    def.nets[id] !== undefined ||
    def.reroutes[id] !== undefined ||
    def.valueSources?.[id] !== undefined ||
    def.selectors?.[id] !== undefined
  for (const [localId, helper] of Object.entries(matched.nodes ?? {})) {
    if (helper.type.startsWith('#')) {
      errors.push(diag('error', 'replace.target.subgraph', `replace: helper '${localId}' cannot target a subgraph instance`))
      continue
    }
    const schema = resolve(helper.type, 'target')
    if (!schema) {
      errors.push(
        diag('error', 'replace.target.unknown', `replace: helper '${localId}' type '${helper.type}' has no schema on this backend`),
      )
      continue
    }
    const helperId = `${nodeId}:${localId}`
    if (graphHasId(helperId)) {
      errors.push(
        diag('error', 'replace.helper.collision', `replace: helper node id '${helperId}' collides with an existing graph id`),
      )
    }
    helperTargets.set(localId, { nodeId: helperId, schema, type: helper.type })
  }

  const targetAddress = (address: string): TargetAddress | undefined => {
    if (matched.nodes === undefined)
      return address.length > 0 ? { nodeId, port: address, schema: target } : undefined
    const parts = address.split(':')
    if (parts.length === 1 && parts[0]!.length > 0)
      return { nodeId, port: parts[0]!, schema: target }
    if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) return undefined
    const helper = helperTargets.get(parts[0]!)
    if (!helper) return undefined
    return { localId: parts[0]!, nodeId: helper.nodeId, port: parts[1]!, schema: helper.schema }
  }

  // -- Values + input connections -------------------------------------------
  const values: Record<string, Json> = defaultValuesOf(target) as Record<string, Json>
  const dynamic: Record<string, DynamicPortState> = {}
  const controllers: Record<string, string> = {}
  const helperValues = new Map<string, Record<string, Json>>()
  const helperDynamic = new Map<string, Record<string, DynamicPortState>>()
  const helperControllers = new Map<string, Record<string, string>>()
  for (const [localId, helper] of helperTargets) {
    helperValues.set(localId, { ...(defaultValuesOf(helper.schema) as Record<string, Json>) })
    helperDynamic.set(localId, {})
    helperControllers.set(localId, {})
  }

  const choices: { address: TargetAddress; choice: string }[] = []
  const targetConnectedPorts = new Map<string, Set<string>>()
  const choiceTargetKey = (localId: string | undefined): string => localId ?? ''
  const markTargetConnected = (address: TargetAddress): void => {
    const key = choiceTargetKey(address.localId)
    const ports = targetConnectedPorts.get(key)
    if (ports === undefined) targetConnectedPorts.set(key, new Set([address.port]))
    else ports.add(address.port)
  }
  const choiceSpecs = (
    localId: string | undefined,
    path: string,
    selected: Readonly<Record<string, DynamicPortState>>,
  ): readonly ChoiceSpec[] =>
    declaredChoiceSpecs(
      localId === undefined ? target : helperTargets.get(localId)!.schema,
      path,
      selected,
    )
  if (rule.migration !== undefined) {
    const addMigrationSelector = (input: string): void => {
      if (migrationHistoricalInputs.has(input)) migrationSelectorInputs.add(input)
    }
    for (const candidate of rule.cases) {
      const candidateDynamic = Object.fromEntries(Object.entries(candidate.slotVariants ?? {})
        .filter(([path]) => !path.includes(':'))
        .map(([path, selected]) => [path, { selected }]))
      if (candidate.when !== undefined) {
        for (const input of comparedPredicateInputs(candidate.when)) addMigrationSelector(input)
      }
      for (const path of Object.keys(candidate.slotVariants ?? {})) {
        if (path.includes(':')) continue
        const specs = choiceSpecs(undefined, path, candidateDynamic)
        const spec = specs[0]
        if (specs.length !== 1 || spec?.kind !== 'dynamicCombo') continue
        addMigrationSelector(path.slice(path.lastIndexOf('.') + 1))
      }
    }
    const runtimeSelector = [...migrationSelectorInputs].find((input) =>
      (state.linksIn.get(input)?.length ?? 0) > 0 ||
      (state.netsIn.get(input)?.length ?? 0) > 0 ||
      Object.hasOwn(node.controllers ?? {}, input),
    )
    if (runtimeSelector !== undefined) {
      errors.push(diag(
        'error',
        'replace.migration.selectorRuntime',
        `replace: historical selector '${runtimeSelector}' is runtime-controlled and cannot choose target dynamic state`,
      ))
    }
  }
  const addressedChoices: { targetPath: string; address: TargetAddress; choice: string }[] = []
  for (const [targetPath, choice] of Object.entries(matched.slotVariants ?? {})) {
    const address = targetAddress(targetPath)
    if (address === undefined) {
      errors.push(diag('error', 'replace.target.address', `replace: dynamic target address '${targetPath}' is invalid`))
      continue
    }
    const targetDynamic = address.localId === undefined ? dynamic : helperDynamic.get(address.localId)!
    targetDynamic[address.port] = { ...targetDynamic[address.port], selected: choice }
    addressedChoices.push({ targetPath, address, choice })
  }
  for (const { targetPath, address, choice } of addressedChoices) {
    const targetDynamic = address.localId === undefined ? dynamic : helperDynamic.get(address.localId)!
    const specs = choiceSpecs(address.localId, address.port, targetDynamic)
    if (specs.length !== 1) {
      errors.push(diag(
        'error',
        specs.length === 0 ? 'replace.target.dynamicInactive' : 'replace.target.dynamicAmbiguous',
        specs.length === 0
          ? `replace: dynamic choice '${targetPath}' does not name a declared choice construct`
          : `replace: dynamic choice '${targetPath}' names multiple branch-local constructs`,
      ))
      continue
    }
    choices.push({ address, choice })
  }
  for (const [targetInput, mapping] of Object.entries(matched.inputs ?? {})) {
    if ((mapping.kind !== 'link' && mapping.kind !== 'copy') || !isConnected(state, mapping.input))
      continue
    const address = targetAddress(targetInput)
    if (address !== undefined) markTargetConnected(address)
  }
  for (const internal of matched.links ?? []) {
    const address = targetAddress(internal.to)
    if (address !== undefined) markTargetConnected(address)
  }
  const preparedInputFamilies = new Map<string, {
    targetAddress: TargetAddress
    targetFamily: Wire15InputFamily
    members: readonly string[]
    sourceFamily?: Wire15InputFamily
  }>()
  for (const [targetFamilyId, mapping] of Object.entries(matched.inputFamilies ?? {})) {
    const familyAddress = targetAddress(targetFamilyId)
    const targetFamily = familyAddress === undefined
      ? undefined
      : wire15InputFamily(familyAddress.schema, familyAddress.port)
    if (familyAddress === undefined || targetFamily === undefined) {
      errors.push(
        diag(
          'error',
          'replace.target.familyMissing',
          `replace: target input family address '${targetFamilyId}' is invalid or unsupported`,
        ),
      )
      continue
    }

    let members: readonly string[]
    let sourceFamily: Wire15InputFamily | undefined
    let sourceFamilyState: DynamicPortState | undefined
    if (mapping.kind === 'copy') {
      sourceFamily = sourceSchema === undefined
        ? undefined
        : wire15InputFamily(sourceSchema, mapping.sourceFamily)
      if (sourceFamily === undefined) {
        errors.push(
          diag(
            'error',
            'replace.source.familyMissing',
            `replace: source '${node.type}' has no supported top-level input family '${mapping.sourceFamily}'`,
          ),
        )
        continue
      }
      sourceFamilyState = node.dynamic?.[mapping.sourceFamily]
      if (sourceFamilyState?.memberState !== undefined) {
        errors.push(
          diag(
            'error',
            'replace.source.familyNested',
            `replace: source family '${mapping.sourceFamily}' carries nested member state`,
          ),
        )
        continue
      }
      members = sourceFamilyState?.members ?? []
    } else {
      members = mapping.members.map((member) => member.suffix)
    }

    if (!familyMembersAreAdmitted(targetFamily, members)) {
      errors.push(
        diag(
          'error',
          'replace.target.familyMembers',
          `replace: target family '${targetFamilyId}' does not admit the ordered members [${members.join(', ')}]`,
        ),
      )
      continue
    }
    const targetDynamic = familyAddress.localId === undefined
      ? dynamic
      : helperDynamic.get(familyAddress.localId)!
    targetDynamic[familyAddress.port] = {
      ...targetDynamic[familyAddress.port],
      ...familyDynamicState(members, sourceFamilyState),
    }
    preparedInputFamilies.set(targetFamilyId, {
      targetAddress: familyAddress,
      targetFamily,
      members,
      ...(sourceFamily !== undefined ? { sourceFamily } : {}),
    })
  }

  const activeInputs = new Map<string, ReadonlyMap<string, ElaboratedInput>>()
  const targetKey = (localId: string | undefined): string => localId ?? ''
  const choicesByTarget = new Map<string, typeof choices>()
  for (const choice of choices) {
    const key = targetKey(choice.address.localId)
    const grouped = choicesByTarget.get(key)
    if (grouped === undefined) choicesByTarget.set(key, [choice])
    else grouped.push(choice)
  }
  const targetSchemas = new Map<string, NodeSchema>([
    ['', target],
    ...[...helperTargets].map(([localId, helper]) => [localId, helper.schema] as const),
  ])
  const dynamicTargetKeys = ['', ...helperTargets.keys()].filter((key) => {
    if (choicesByTarget.has(key)) return true
    const schema = key === '' ? target : helperTargets.get(key)!.schema
    return inputsOf(schema).some((input) => input.dynamic !== undefined)
  })
  for (const key of dynamicTargetKeys) {
    const grouped = choicesByTarget.get(key) ?? []
    const localId = key === '' ? undefined : key
    const schema = targetSchemas.get(key)!
    const targetValues = localId === undefined ? values : helperValues.get(localId)!
    const targetDynamic = localId === undefined ? dynamic : helperDynamic.get(localId)!
    const connectedPorts = targetConnectedPorts.get(key) ?? new Set<string>()
    const connectivity: Connectivity = connectedPorts.size === 0
      ? EMPTY_CONNECTIVITY
      : {
          isInputConnected: (port, members) =>
            (members === undefined || members.length === 0) && connectedPorts.has(port),
          isOutputConnected: () => false,
          inputPorts: () => [...connectedPorts],
        }
    for (const path of missingRequiredSlotChoices(schema, targetDynamic, connectedPorts)) {
      errors.push(diag(
        'error',
        'replace.target.dynamicInvalid',
        `replace: ${schema.type}.${path} has no stored choice`,
      ))
    }
    const elaborated = elaborateInterface(
      schema,
      { values: targetValues, dynamic: targetDynamic },
      connectivity,
      { promoteGhosts: false },
    )
    for (const diagnostic of elaborated.diagnostics) {
      if (
        diagnostic.severity === 'error' ||
        diagnostic.code === 'elab.combo.unknownOption' ||
        diagnostic.code === 'elab.slot.unknownVariant'
      ) errors.push(diag('error', 'replace.target.dynamicInvalid', `replace: ${diagnostic.message}`))
    }
    const inputs = new Map<string, ElaboratedInput>()
    const activeChoices = new Set<string>()
    for (const input of elabInputsOf(elaborated)) {
      if (
        input.address.members === undefined &&
        input.apiName !== undefined
      ) inputs.set(input.wire15Materialization ? input.spec.id : input.apiName, input)
      if (
        input.origin.kind === 'selector' &&
        input.wire15Materialization &&
        input.spec.optional === false &&
        input.origin.selected === undefined
      ) {
        errors.push(diag(
          'error',
          'replace.target.dynamicInvalid',
          `replace: ${schema.type}.${input.origin.construct} has no stored choice`,
        ))
      }
      if (
        (input.ancestry?.length ?? 0) === 0 &&
        (input.origin.kind === 'selector' ||
          (input.origin.kind === 'slot' && input.origin.variants !== undefined))
      ) activeChoices.add(input.origin.construct)
      if (
        (input.origin.kind === 'branch' || input.origin.kind === 'dependent') &&
        input.spec.widget?.default !== undefined &&
        input.spec.forceInput !== true
      ) targetValues[valueKeyOf(input)] = input.spec.widget.default as Json
    }
    for (const choice of grouped) {
      if (!activeChoices.has(choice.address.port)) {
        errors.push(
          diag(
            'error',
            'replace.target.dynamicInactive',
            `replace: dynamic choice '${choice.address.port}' is unknown or inactive on target '${schema.type}'`,
          ),
        )
      }
    }
    activeInputs.set(key, inputs)
  }

  const activeTargetElaboratedInput = (address: TargetAddress): ElaboratedInput | undefined =>
    activeInputs.get(targetKey(address.localId))?.get(address.port)
  const familyOwnsTargetInput = (address: TargetAddress): boolean =>
    [...preparedInputFamilies.values()].some((prepared) =>
      prepared.targetAddress.localId === address.localId &&
      prepared.members.some((member) =>
        prepared.targetFamily.template.some((input) =>
          wire15FamilyInputPath(prepared.targetFamily, member, input.id) === address.port,
        ),
      ),
    )
  const activeTargetInput = (address: TargetAddress): InputSpec | undefined => {
    const elaborated = activeTargetElaboratedInput(address)
    if (elaborated !== undefined) return elaborated.origin.kind === 'selector' ? undefined : elaborated.spec
    if (activeInputs.has(targetKey(address.localId))) return undefined
    return staticTargetInput(address.schema, address.port)
  }
  const targetValueKey = (address: TargetAddress): string => {
    const elaborated = activeTargetElaboratedInput(address)
    return elaborated === undefined ? address.port : valueKeyOf(elaborated)
  }
  const targetGraphPort = (address: TargetAddress): string =>
    activeTargetElaboratedInput(address)?.address.port ?? address.port

  for (const [localId, helper] of helperTargets) {
    const complete = helperValues.get(localId)!
    for (const [inputId, value] of Object.entries(matched.nodes?.[localId]?.values ?? {})) {
      const address = { localId, nodeId: helper.nodeId, port: inputId, schema: helper.schema }
      const spec = activeTargetInput(address)
      if (!spec || familyOwnsTargetInput(address)) {
        errors.push(
          diag('error', 'replace.target.inputMissing', `replace: helper '${localId}' has no active input '${inputId}'`),
        )
      } else if (spec.widget === undefined) {
        errors.push(
          diag('error', 'replace.target.notWidget', `replace: helper input '${localId}:${inputId}' has no widget; cannot write a value`),
        )
      } else complete[targetValueKey(address)] = value
    }
  }
  const inputRewires: { link: string; port: string; node?: string }[] = []
  const netSinkMoves = new Map<string, { fromPort: string; to: TargetAddress }[]>()
  /** Source inputs whose CONNECTION a mapping consumed (moves are exclusive). */
  const consumedConnections = new Set<string>()
  /** Source controllers copied to at least one target widget. */
  const consumedControllers = new Set<string>()
  /** Where each source input's connection landed (same-port moves included). */
  const connectionMoves = new Map<string, TargetAddress>()
  /** Active target widgets reached by a source widget mapping. */
  const widgetMoves = new Map<string, TargetAddress[]>()

  const recordWidgetMove = (sourceInput: string, address: TargetAddress, spec: InputSpec): void => {
    if (spec.widget === undefined || spec.forceInput === true) return
    const moves = widgetMoves.get(sourceInput)
    if (moves === undefined) widgetMoves.set(sourceInput, [address])
    else moves.push(address)
  }

  const copyValueTo = (
    address: TargetAddress,
    mapping: Extract<MappingSource, { kind: 'value' | 'copy' }>,
    sourceInput = mapping.input,
    copyController: boolean,
  ): void => {
    const raw = storedSourceValue(state, sourceInput)
    const ctrl = copyController ? state.node.controllers?.[sourceInput] : undefined
    if (raw === undefined) {
      if (rule.migration !== undefined && ctrl !== undefined) {
        const targetControllers = address.localId === undefined ? controllers : helperControllers.get(address.localId)!
        targetControllers[targetValueKey(address)] = ctrl
        consumedControllers.add(sourceInput)
      }
      return // nothing stored; target keeps its default
    }
    let out: Json = raw
    if (mapping.kind === 'value' && mapping.transform) {
      const t = mapping.transform
      if (t.kind === 'enumRename') {
        if (typeof raw !== 'string' || t.map[raw] === undefined) {
          errors.push(
            diag('error', 'replace.transform.enum', `replace: value '${String(raw)}' of '${mapping.input}' has no rename mapping`),
          )
          return
        }
        out = t.map[raw]!
      } else {
        if (typeof raw !== 'number') {
          errors.push(diag('error', 'replace.transform.scale', `replace: '${mapping.input}' is not a number; cannot scale`))
          return
        }
        out = raw * t.factor + (t.offset ?? 0)
      }
    }
    const targetValues = address.localId === undefined ? values : helperValues.get(address.localId)!
    targetValues[targetValueKey(address)] = out
    if (ctrl !== undefined) {
      const targetControllers = address.localId === undefined ? controllers : helperControllers.get(address.localId)!
      targetControllers[targetValueKey(address)] = ctrl
      consumedControllers.add(sourceInput)
    }
  }

  const moveConnectionTo = (address: TargetAddress, sourceInput: string): void => {
    if (consumedConnections.has(sourceInput)) {
      errors.push(
        diag('error', 'replace.link.doubleConsume', `replace: two mappings both move the connection of '${sourceInput}'`),
      )
      return
    }
    consumedConnections.add(sourceInput)
    const graphAddress = { ...address, port: targetGraphPort(address) }
    connectionMoves.set(sourceInput, graphAddress)
    if (graphAddress.nodeId === nodeId && graphAddress.port === sourceInput) return // same port id: nothing moves
    for (const linkId of state.linksIn.get(sourceInput) ?? [])
      inputRewires.push({ link: linkId, port: graphAddress.port, ...(graphAddress.nodeId !== nodeId ? { node: graphAddress.nodeId } : {}) })
    for (const netId of state.netsIn.get(sourceInput) ?? []) {
      const moves = netSinkMoves.get(netId)
      const move = { fromPort: sourceInput, to: graphAddress }
      if (moves) moves.push(move)
      else netSinkMoves.set(netId, [move])
    }
  }

  for (const [targetInput, mapping] of Object.entries(matched.inputs ?? {})) {
    const address = targetAddress(targetInput)
    if (!address) {
      errors.push(diag('error', 'replace.target.address', `replace: target input address '${targetInput}' is invalid`))
      continue
    }
    if (
      !activeInputs.has(targetKey(address.localId)) &&
      (address.port.includes('.') || address.port.includes('#'))
    ) {
      errors.push(diag('error', 'replace.target.dynamicPath', `replace: target input '${targetInput}' is a dynamic member path; rules map static inputs only`))
      continue
    }
    const spec = activeTargetInput(address)
    if (!spec || familyOwnsTargetInput(address)) {
      errors.push(diag('error', 'replace.target.inputMissing', `replace: target '${matched.to}' has no active input '${targetInput}'`))
      continue
    }
    const storesCount = outputCountInputsOf(address.schema).includes(address.port)
    const writesValue = mapping.kind === 'constant' || mapping.kind === 'value' || mapping.kind === 'copy'
    if (writesValue && spec.widget === undefined && !storesCount && mapping.kind !== 'copy') {
      errors.push(diag('error', 'replace.target.notWidget', `replace: target input '${targetInput}' has no widget; cannot write a value`))
      continue
    }
    if (mapping.kind === 'value' || mapping.kind === 'copy') recordWidgetMove(mapping.input, address, spec)
    switch (mapping.kind) {
      case 'constant':
        ;(address.localId === undefined ? values : helperValues.get(address.localId)!)[targetValueKey(address)] = mapping.value
        break
      case 'value':
        copyValueTo(address, mapping, mapping.input, spec.widget?.controller !== undefined)
        break
      case 'link':
        if (storesCount) {
          errors.push(
            diag('error', 'replace.target.outputFamilyLinkedCount', `replace: output-family count input '${targetInput}' must store a literal`),
          )
          break
        }
        moveConnectionTo(address, mapping.input)
        break
      case 'copy':
        if (storesCount && isConnected(state, mapping.input)) {
          errors.push(
            diag('error', 'replace.target.outputFamilyLinkedCount', `replace: output-family count input '${targetInput}' cannot copy a connection`),
          )
          break
        }
        if (spec.widget !== undefined || storesCount)
          copyValueTo(address, mapping, mapping.input, spec.widget?.controller !== undefined)
        else if (state.node.values[mapping.input] !== undefined)
          warnings.push(
            diag('warning', 'replace.value.dropped', `replace: stored value of '${mapping.input}' is lost - target input '${targetInput}' has no widget`),
          )
        moveConnectionTo(address, mapping.input)
        break
    }
  }

  const applyFamilyMember = (
    familyAddress: TargetAddress,
    family: Wire15InputFamily,
    suffix: string,
    mappings: Readonly<Record<string, MappingSource>>,
    sourceInput: (mapping: Exclude<MappingSource, { kind: 'constant' }>) => string | undefined,
  ): void => {
    const targetValues = familyAddress.localId === undefined
      ? values
      : helperValues.get(familyAddress.localId)!
    for (const slot of family.template) {
      if (slot.widget?.default !== undefined)
        targetValues[wire15FamilyInputPath(family, suffix, slot.id)] = slot.widget.default as Json
    }
    for (const [targetInput, mapping] of Object.entries(mappings)) {
      const spec = family.template.find((candidate) => candidate.id === targetInput)
      if (spec === undefined) {
        errors.push(
          diag(
            'error',
            'replace.target.inputMissing',
            `replace: target family '${family.id}' has no template input '${targetInput}'`,
          ),
        )
        continue
      }
      const address: TargetAddress = {
        ...(familyAddress.localId !== undefined ? { localId: familyAddress.localId } : {}),
        nodeId: familyAddress.nodeId,
        port: wire15FamilyInputPath(family, suffix, targetInput),
        schema: familyAddress.schema,
      }
      if (mapping.kind === 'constant') {
        if (spec.widget === undefined) {
          errors.push(
            diag(
              'error',
              'replace.target.notWidget',
              `replace: target family input '${family.id}.${targetInput}' has no widget; cannot write a value`,
            ),
          )
        } else targetValues[address.port] = mapping.value
        continue
      }
      const source = sourceInput(mapping)
      if (source === undefined) continue
      if (mapping.kind === 'value') {
        if (spec.widget === undefined) {
          errors.push(
            diag(
              'error',
              'replace.target.notWidget',
              `replace: target family input '${family.id}.${targetInput}' has no widget; cannot write a value`,
            ),
          )
        } else copyValueTo(address, mapping, source, spec.widget.controller !== undefined)
      } else if (mapping.kind === 'link') {
        moveConnectionTo(address, source)
      } else {
        if (spec.widget !== undefined) copyValueTo(address, mapping, source, spec.widget.controller !== undefined)
        else if (state.node.values[source] !== undefined)
          warnings.push(
            diag(
              'warning',
              'replace.value.dropped',
              `replace: stored value of '${source}' is lost - target family input '${family.id}.${targetInput}' has no widget`,
            ),
          )
        moveConnectionTo(address, source)
      }
    }
  }

  for (const [targetFamilyId, mapping] of Object.entries(matched.inputFamilies ?? {})) {
    const prepared = preparedInputFamilies.get(targetFamilyId)
    if (prepared === undefined) continue
    const { targetAddress: familyAddress, targetFamily, members, sourceFamily } = prepared

    if (mapping.kind === 'copy') {
      const copied = mapping as Extract<InputFamilyMapping, { kind: 'copy' }>
      for (const member of members) {
        applyFamilyMember(familyAddress, targetFamily, member, copied.inputs, (source) => {
          const sourceSlot = sourceFamily!.template.find((candidate) => candidate.id === source.input)
          if (sourceSlot !== undefined)
            return wire15FamilyInputPath(sourceFamily!, member, source.input)
          errors.push(
            diag(
              'error',
              'replace.source.inputMissing',
              `replace: source family '${copied.sourceFamily}' has no template input '${source.input}'`,
            ),
          )
          return undefined
        })
      }
    } else {
      for (const member of mapping.members)
        applyFamilyMember(
          familyAddress,
          targetFamily,
          member.suffix,
          member.inputs,
          (source) => source.input,
        )
    }
  }

  if (rule.migration !== undefined) {
    for (const input of rule.migration.historicalInputs) {
      const hasConnection = (state.linksIn.get(input)?.length ?? 0) > 0 || (state.netsIn.get(input)?.length ?? 0) > 0
      const hasController = Object.hasOwn(node.controllers ?? {}, input)
      if ((hasConnection && !consumedConnections.has(input)) ||
          (hasController && !consumedControllers.has(input))) {
        errors.push(diag(
          'error',
          'replace.migration.inactiveRuntime',
          `replace: runtime state on inactive historical input '${input}' cannot be migrated`,
        ))
      }
    }
  } else {
    for (const input of Object.keys(state.node.controllers ?? {})) {
      if (consumedControllers.has(input)) continue
      warnings.push(
        diag('warning', 'replace.controller.dropped', `replace: controller on '${input}' has no widget mapping and will be removed`),
      )
    }
  }

  // Unconsumed incoming connections are dropped EXPLICITLY - and force review.
  const dropLinks: string[] = []
  if (rule.migration !== undefined) dropLinks.push(...migrationInvalidTapLinks)
  const droppedSinkPorts = new Set<string>()
  for (const [input, linkIds] of state.linksIn) {
    if (consumedConnections.has(input)) continue
    if (!migrationHistoricalInputs.has(input))
      warnings.push(
        diag('warning', 'replace.link.dropped', `replace: connection into '${input}' has no mapping and will be removed`),
      )
    dropLinks.push(...linkIds)
  }
  for (const [input] of state.netsIn) {
    if (consumedConnections.has(input)) continue
    if (!migrationHistoricalInputs.has(input))
      warnings.push(
        diag('warning', 'replace.net.sinkDropped', `replace: net sink on '${input}' has no mapping and will be removed`),
      )
    droppedSinkPorts.add(input)
  }

  // -- Outputs: preserve downstream links/nets via the (injective) map -------
  const sourceToTarget = new Map<string, TargetOutputAddress>()
  for (const [targetOutput, sourceOutput] of Object.entries(matched.outputs ?? {})) {
    const address = targetAddress(targetOutput)
    if (!address) {
      errors.push(diag('error', 'replace.target.address', `replace: target output address '${targetOutput}' is invalid`))
      continue
    }
    if (address.port.includes('.') || address.port.includes('#')) {
      errors.push(diag('error', 'replace.target.dynamicPath', `replace: target output '${targetOutput}' is a dynamic member path; rules map static outputs only`))
      continue
    }
    if (!staticTargetOutput(address.schema, address.port)) {
      errors.push(diag('error', 'replace.target.outputMissing', `replace: target '${matched.to}' has no static output '${targetOutput}'`))
      continue
    }
    if (sourceToTarget.has(sourceOutput)) {
      errors.push(
        diag('error', 'replace.output.doubleConsume', `replace: source output '${sourceOutput}' is mapped to two target outputs`),
      )
      continue
    }
    sourceToTarget.set(sourceOutput, address)
  }

  const sourceFamilyToTarget = new Map<string, {
    target: TargetOutputAddress
    members: ReadonlySet<string>
  }>()
  const expectedTargetFamilies = new Map<string, readonly string[]>()
  const sourceCountGuards: Record<string, Json> = {}
  const sourceInterface = (): ReturnType<typeof elaborateInterface> | undefined => {
    if (sourceSchema === undefined) return undefined
    if (sourceElaboration === undefined) {
      sourceElaboration = elaborateInterface(
        sourceSchema,
        node,
        buildGraphConnectivity(def)(node.id),
        { promoteGhosts: false },
      )
    }
    return sourceElaboration
  }
  for (const [targetFamilyId, mapping] of Object.entries(matched.outputFamilies ?? {})) {
    const targetFamily = countOutputFamily(target, targetFamilyId)
    if (targetFamily === undefined) {
      errors.push(
        diag(
          'error',
          'replace.target.outputFamilyMissing',
          `replace: target '${matched.to}' has no supported top-level count-bound output family '${targetFamilyId}'`,
        ),
      )
      continue
    }
    const targetCountInput = targetFamily.spec.count.input
    const countMapping = matched.inputs?.[targetCountInput]
    let members: readonly string[]
    if (mapping.kind === 'copy') {
      const sourceFamily = sourceSchema === undefined
        ? undefined
        : countOutputFamily(sourceSchema, mapping.sourceFamily)
      if (sourceFamily === undefined) {
        errors.push(
          diag(
            'error',
            'replace.source.outputFamilyMissing',
            `replace: source '${node.type}' has no supported top-level count-bound output family '${mapping.sourceFamily}'`,
          ),
        )
        continue
      }
      if (
        countMapping === undefined ||
        (countMapping.kind !== 'copy' && countMapping.kind !== 'value') ||
        countMapping.input !== sourceFamily.spec.count.input ||
        (countMapping.kind === 'value' && countMapping.transform !== undefined)
      ) {
        errors.push(
          diag(
            'error',
            'replace.outputFamily.countMapping',
            `replace: copied output family '${targetFamilyId}' must copy source count input '${sourceFamily.spec.count.input}' unchanged into '${targetCountInput}'`,
          ),
        )
        continue
      }
      const elaborated = sourceInterface()
      if (
        elaborated === undefined ||
        elaborated.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
        elaborated.outputMembers?.[mapping.sourceFamily] === undefined
      ) {
        errors.push(
          diag(
            'error',
            'replace.source.outputFamilyInvalid',
            `replace: source output family '${mapping.sourceFamily}' cannot be elaborated from its stored count`,
          ),
        )
        continue
      }
      members = elaborated.outputMembers[mapping.sourceFamily]!
      if (sourceFamilyToTarget.has(mapping.sourceFamily)) {
        errors.push(
          diag(
            'error',
            'replace.outputFamily.doubleConsume',
            `replace: source output family '${mapping.sourceFamily}' is mapped more than once`,
          ),
        )
        continue
      }
      sourceFamilyToTarget.set(mapping.sourceFamily, {
        target: { nodeId, port: targetFamilyId, schema: target },
        members: new Set(members),
      })
      sourceCountGuards[sourceFamily.spec.count.input] = node.values[sourceFamily.spec.count.input]!
    } else {
      members = mapping.members.map((member) => member.suffix)
      if (
        countMapping?.kind !== 'constant' ||
        countMapping.value !== members.length
      ) {
        errors.push(
          diag(
            'error',
            'replace.outputFamily.countMapping',
            `replace: explicit output family '${targetFamilyId}' requires constant count ${members.length} on '${targetCountInput}'`,
          ),
        )
        continue
      }
      for (const member of mapping.members) {
        if (sourceToTarget.has(member.output)) {
          errors.push(
            diag(
              'error',
              'replace.output.doubleConsume',
              `replace: source output '${member.output}' is mapped more than once`,
            ),
          )
          continue
        }
        sourceToTarget.set(member.output, {
          nodeId,
          port: targetFamilyId,
          members: [member.suffix],
          schema: target,
        })
      }
    }
    expectedTargetFamilies.set(targetFamilyId, members)
  }

  const internalLinks: { from: PortRef; to: PortRef }[] = []
  for (const internal of matched.links ?? []) {
    const from = targetAddress(internal.from)
    const to = targetAddress(internal.to)
    if (!from || !to) {
      errors.push(diag('error', 'replace.target.address', `replace: internal link '${internal.from}' -> '${internal.to}' has an invalid address`))
      continue
    }
    if (
      from.port.includes('.') ||
      from.port.includes('#') ||
      (!activeInputs.has(targetKey(to.localId)) && (to.port.includes('.') || to.port.includes('#')))
    ) {
      errors.push(diag('error', 'replace.target.dynamicPath', `replace: internal link '${internal.from}' -> '${internal.to}' uses a dynamic member path`))
      continue
    }
    if (!staticTargetOutput(from.schema, from.port)) {
      errors.push(diag('error', 'replace.target.outputMissing', `replace: internal link source '${internal.from}' is not a static output`))
      continue
    }
    if (!activeTargetInput(to)) {
      errors.push(diag('error', 'replace.target.inputMissing', `replace: internal link destination '${internal.to}' is not an active input`))
      continue
    }
    internalLinks.push({
      from: { node: asNodeId(from.nodeId), port: asPortId(from.port) },
      to: { node: asNodeId(to.nodeId), port: asPortId(targetGraphPort(to)) },
    })
  }

  const countOutputTargets = [
    { nodeId, schema: target, values, dynamic },
    ...[...helperTargets].map(([localId, helper]) => ({
      nodeId: helper.nodeId,
      schema: helper.schema,
      values: helperValues.get(localId)!,
      dynamic: helperDynamic.get(localId)!,
    })),
  ]
  for (const plannedTarget of countOutputTargets) {
    if (outputCountInputsOf(plannedTarget.schema).length === 0) continue
    const connectedInputs = new Set<string>()
    for (const [sourceInput, address] of connectionMoves) {
      if (address.nodeId === plannedTarget.nodeId && isConnected(state, sourceInput))
        connectedInputs.add(address.port)
    }
    for (const internal of internalLinks) {
      if (internal.to.node === plannedTarget.nodeId) connectedInputs.add(internal.to.port)
    }
    const connectivity: Connectivity = {
      isInputConnected: (port, members) =>
        (members === undefined || members.length === 0) && connectedInputs.has(port),
      isOutputConnected: () => false,
    }
    const elaborated = elaborateInterface(
      plannedTarget.schema,
      {
        values: plannedTarget.values,
        ...(Object.keys(plannedTarget.dynamic).length > 0 ? { dynamic: plannedTarget.dynamic } : {}),
      },
      connectivity,
      { promoteGhosts: false },
    )
    if (elaborated.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      errors.push(
        diag(
          'error',
          'replace.target.outputFamilyInvalid',
          `replace: target '${plannedTarget.schema.type}' output families cannot be elaborated from the planned count values and connections`,
        ),
      )
    }
    if (plannedTarget.nodeId !== nodeId) continue
    for (const [family, expected] of expectedTargetFamilies) {
      const actual = elaborated.outputMembers?.[family]
      if (
        actual === undefined ||
        actual.length !== expected.length ||
        actual.some((suffix, index) => suffix !== expected[index])
      ) {
        errors.push(
          diag(
            'error',
            'replace.target.outputFamilyMembers',
            `replace: target output family '${family}' does not elaborate the required members [${expected.join(', ')}]`,
          ),
        )
      }
    }
  }

  // -- Boundary bindings: follow the mapping exactly like link endpoints -----
  // The node id survives replacement, so a binding whose port is preserved
  // under the same id needs nothing. Family/member boundary bindings are not
  // represented by the replacement vocabulary, and a bound port the rule does
  // not map has no destination. Both are hard errors so a rule never silently
  // rewrites a subgraph's external interface.
  const boundaryRewires: { item: string; side: 'input' | 'output'; fromPort: string; port: string; alsoIndex?: number }[] = []
  const migrateBinding = (side: 'input' | 'output', itemId: string, b: BoundaryBinding, alsoIndex?: number): void => {
    if (b.node !== nodeId) return
    const label = alsoIndex === undefined ? `boundary ${side} '${itemId}'` : `boundary ${side} '${itemId}' alsoBinds[${alsoIndex}]`
    if (b.kind !== 'port' || b.members !== undefined) {
      errors.push(
        diag('error', 'replace.boundary.dynamic', `replace: ${label} binds a dynamic family/member of '${nodeId}'; replacement drops dynamic state, detach the binding first`),
      )
      return
    }
    const to = side === 'input' ? connectionMoves.get(b.port) : sourceToTarget.get(b.port)
    if (to === undefined) {
      errors.push(
        diag('error', 'replace.boundary.unmapped', `replace: ${label} binds '${nodeId}.${b.port}' but the rule has no ${side} mapping for that port; extend the rule or detach the binding`),
      )
      return
    }
    if (to.nodeId !== nodeId) {
      errors.push(
        diag('error', 'replace.boundary.helper', `replace: ${label} would move from the primary node to helper '${to.localId}'`),
      )
      return
    }
    if (side === 'output' && 'members' in to && to.members !== undefined) {
      errors.push(
        diag('error', 'replace.boundary.dynamicTarget', `replace: ${label} would move to a dynamic output member; detach the binding first`),
      )
      return
    }
    if (to.port !== b.port)
      boundaryRewires.push({ item: itemId, side, fromPort: b.port, port: to.port, ...(alsoIndex !== undefined ? { alsoIndex } : {}) })
  }
  for (const item of def.boundary?.inputs ?? []) {
    migrateBinding('input', item.id, item.binds)
    if (item.binds.node === nodeId && item.promoted === true) {
      const to = item.binds.kind === 'port' ? connectionMoves.get(item.binds.port) : undefined
      if (to !== undefined && to.nodeId === nodeId && activeTargetInput(to)?.widget === undefined)
        errors.push(
          diag('error', 'replace.boundary.promoted', `replace: boundary input '${item.id}' promotes a widget, but target input '${to.port}' has no widget`),
        )
    }
    item.alsoBinds?.forEach((a, i) => migrateBinding('input', item.id, a, i))
  }
  for (const item of def.boundary?.outputs ?? []) migrateBinding('output', item.id, item.binds)

  // The guard snapshot: every static binding of this node, rewired or not,
  // plus the primary input bindings' promoted flags. Dynamic bindings need
  // no entry - migrateBinding already made them plan-blocking errors.
  const boundaryGuard: { item: string; side: 'input' | 'output'; port: string; alsoIndex?: number; promoted?: boolean }[] = []
  for (const item of def.boundary?.inputs ?? []) {
    if (item.binds.node === nodeId && item.binds.kind === 'port' && item.binds.members === undefined) {
      boundaryGuard.push({ item: item.id, side: 'input', port: item.binds.port, ...(item.promoted === true ? { promoted: true } : {}) })
    }
    item.alsoBinds?.forEach((a, i) => {
      if (a.node === nodeId && a.kind === 'port' && a.members === undefined) {
        boundaryGuard.push({ item: item.id, side: 'input', port: a.port, alsoIndex: i })
      }
    })
  }
  for (const item of def.boundary?.outputs ?? []) {
    if (item.binds.node === nodeId && item.binds.kind === 'port' && item.binds.members === undefined) {
      boundaryGuard.push({ item: item.id, side: 'output', port: item.binds.port })
    }
  }

  const outputRewires: {
    link: string
    port: string
    node?: string
    members?: readonly string[]
    fromPort?: string
    fromMembers?: readonly string[]
  }[] = []
  const tapRewires: { link: string; tap: string; fromTap?: string; node?: string }[] = []
  const tapGuards: { link: string; tap: string }[] = []
  const netSourceRewires: {
    net: string
    port: string
    node?: string
    members?: readonly string[]
    fromPort?: string
    fromMembers?: readonly string[]
  }[] = []
  const dropNets: string[] = []
  for (const [output, linkIds] of state.linksOut) {
    const to = sourceToTarget.get(output)
    if (to === undefined) {
      warnings.push(
        diag('warning', 'replace.output.dropped', `replace: downstream connections of '${output}' have no mapping and will be removed`),
      )
      dropLinks.push(...linkIds)
      continue
    }
    if (to.nodeId !== nodeId || to.port !== output || to.members !== undefined)
      for (const linkId of linkIds)
        outputRewires.push({
          link: linkId,
          port: to.port,
          ...(to.nodeId !== nodeId ? { node: to.nodeId } : {}),
          ...(to.members !== undefined ? { members: to.members } : {}),
          ...(to.members !== undefined ? { fromPort: output } : {}),
        })
  }
  const preservedMemberLinks = new Set<string>()
  for (const [key, linkIds] of state.memberLinksOut) {
    const { family, suffix } = memberOutputAddress(key)
    const mapping = sourceFamilyToTarget.get(family)
    if (mapping === undefined) continue
    if (!mapping.members.has(suffix)) {
      errors.push(
        diag('error', 'replace.source.outputFamilyEndpoint', `replace: source output family '${family}' has no member '${suffix}'`),
      )
      continue
    }
    for (const linkId of linkIds) {
      if (state.memberLinksIn.has(linkId)) continue
      preservedMemberLinks.add(linkId)
      outputRewires.push({
        link: linkId,
        port: mapping.target.port,
        members: [suffix],
        fromPort: family,
        fromMembers: [suffix],
      })
    }
  }
  const droppedMemberLinks = state.memberLinks.filter((linkId) => !preservedMemberLinks.has(linkId))
  if (droppedMemberLinks.length > 0) {
    warnings.push(
      diag('warning', 'replace.dynamic.dropped', `replace: ${droppedMemberLinks.length} unsupported or unmapped dynamic-member connection(s) will be removed`),
    )
    dropLinks.push(...droppedMemberLinks)
  }
  // Tap links survive when the source and target tap types denote the same
  // values: closed types compare by canonical-compatible id (so the
  // interchangeable comfy-compat spellings, e.g. dinkster.mask/comfy.MASK,
  // match); open types keep the exact structural comparison. Deliberately
  // NOT typesCompatible - wildcards and coercions must not keep a tap alive.
  const sameTapType = (a: TypeExpr, b: TypeExpr): boolean => {
    const ca = canonicalCompatTypeIdOf(a)
    const cb = canonicalCompatTypeIdOf(b)
    if (ca !== undefined && cb !== undefined) return ca === cb
    return canonicalJson(a) === canonicalJson(b)
  }
  for (const [tap, linkIds] of state.tapLinksOut) {
    for (const linkId of linkIds) tapGuards.push({ link: linkId, tap })
    if (migrationHistoricalInputs.has(tap)) {
      const to = connectionMoves.get(tap)
      if (to !== undefined && activeTargetInput(to)?.widget !== undefined) {
        const targetTap = targetValueKey(to)
        if (to.nodeId !== nodeId || targetTap !== tap) {
          for (const linkId of linkIds) {
            tapRewires.push({
              link: linkId,
              fromTap: tap,
              tap: targetTap,
              ...(to.nodeId !== nodeId ? { node: to.nodeId } : {}),
            })
          }
        }
      } else {
        errors.push(diag(
          'error',
          'replace.migration.inactiveRuntime',
          `replace: widget tap on inactive historical input '${tap}' cannot be migrated`,
        ))
      }
      continue
    }
    const sourceInput = sourceSchema === undefined ? undefined : staticWidgetTap(sourceSchema, node, tap)
    const mappedTargets = widgetMoves.get(tap) ?? []
    const mappedTarget = mappedTargets.length === 1 ? mappedTargets[0] : undefined
    const mappedTargetSpec = mappedTarget === undefined ? undefined : activeTargetInput(mappedTarget)
    const targetInput = mappedTargets.length === 0
      ? staticWidgetTap(target, { values }, tap)
      : mappedTargetSpec === undefined ? undefined : { spec: mappedTargetSpec }
    if (sourceInput !== undefined && targetInput !== undefined &&
        sameTapType(sourceInput.spec.type, targetInput.spec.type)) {
      if (mappedTarget !== undefined && (mappedTarget.nodeId !== nodeId || mappedTarget.port !== tap)) {
        for (const linkId of linkIds) {
          tapRewires.push({
            link: linkId,
            tap: mappedTarget.port,
            ...(mappedTarget.nodeId !== nodeId ? { node: mappedTarget.nodeId } : {}),
          })
        }
      }
      continue
    }
    warnings.push(
      diag('warning', 'replace.output.dropped', `replace: downstream connections of widget tap '${tap}' are not supported by the target and will be removed`),
    )
    dropLinks.push(...linkIds)
  }

  const viewRewires: { from: string; to: string; node?: string }[] = []
  for (const sourceInput of Object.keys(document.view.graphs[graphId]?.nodes[nodeId]?.views ?? {})) {
    const moves = widgetMoves.get(sourceInput) ?? []
    if (moves.length !== 1) continue
    const to = moves[0]!
    if (to.nodeId === nodeId && to.port === sourceInput) continue
    viewRewires.push({
      from: sourceInput,
      to: to.port,
      ...(to.nodeId !== nodeId ? { node: to.nodeId } : {}),
    })
  }
  for (const [output, netIds] of state.netsOut) {
    const to = sourceToTarget.get(output)
    if (to === undefined) {
      warnings.push(
        diag('warning', 'replace.net.dropped', `replace: net(s) sourced from '${output}' have no mapping and will be removed`),
      )
      dropNets.push(...netIds)
      continue
    }
    if (to.nodeId !== nodeId || to.port !== output || to.members !== undefined)
      for (const netId of netIds)
        netSourceRewires.push({
          net: netId,
          port: to.port,
          ...(to.nodeId !== nodeId ? { node: to.nodeId } : {}),
          ...(to.members !== undefined ? { members: to.members } : {}),
          ...(to.members !== undefined ? { fromPort: output } : {}),
        })
  }
  const preservedMemberNets = new Set<string>()
  for (const [key, netIds] of state.memberNetsOut) {
    const { family, suffix } = memberOutputAddress(key)
    const mapping = sourceFamilyToTarget.get(family)
    if (mapping === undefined) continue
    if (!mapping.members.has(suffix)) {
      errors.push(
        diag('error', 'replace.source.outputFamilyEndpoint', `replace: source output family '${family}' has no member '${suffix}'`),
      )
      continue
    }
    for (const netId of netIds) {
      preservedMemberNets.add(netId)
      netSourceRewires.push({
        net: netId,
        port: mapping.target.port,
        members: [suffix],
        fromPort: family,
        fromMembers: [suffix],
      })
    }
  }
  const droppedMemberNets = state.memberNets.filter((netId) => !preservedMemberNets.has(netId))
  if (droppedMemberNets.length > 0) {
    warnings.push(
      diag('warning', 'replace.dynamic.dropped', `replace: ${droppedMemberNets.length} unsupported or unmapped net(s) sourced from dynamic members will be removed`),
    )
    dropNets.push(...droppedMemberNets)
  }

  const inputViewRewires: { fromInput: string; input: string }[] = []
  const dropInputViews: string[] = []
  for (const input of historicalViewInputs) {
    const moves = widgetMoves.get(input) ?? []
    const to = moves.length === 1 ? moves[0] : undefined
    if (to !== undefined && activeTargetInput(to)?.widget !== undefined) {
      if (to.nodeId !== nodeId) continue
      const inputKey = targetValueKey(to)
      if (inputKey !== input && Object.hasOwn(historicalViews, inputKey)) {
        migrationDisplacedState = true
        dropInputViews.push(input)
      } else if (inputKey !== input) inputViewRewires.push({ fromInput: input, input: inputKey })
    } else {
      migrationDisplacedState = true
      dropInputViews.push(input)
    }
  }

  // -- Net sink arrays: full replacements (move + drop in one pass) ----------
  const netSinks: { net: string; sinks: PortRef[] }[] = []
  const netSinkEdits: { net: string; from: PortRef; to?: PortRef }[] = []
  const touchedNets = new Set<string>([...netSinkMoves.keys()])
  for (const [input, netIds] of state.netsIn) {
    if (droppedSinkPorts.has(input)) for (const id of netIds) touchedNets.add(id)
  }
  if (state.memberSinkNets.length > 0) {
    warnings.push(
      diag('warning', 'replace.dynamic.dropped', `replace: ${state.memberSinkNets.length} net sink(s) on dynamic members will be removed`),
    )
    for (const id of state.memberSinkNets) touchedNets.add(id)
  }
  for (const netId of touchedNets) {
    const net = def.nets[netId]
    if (!net || dropNets.includes(netId)) continue
    const moves = netSinkMoves.get(netId) ?? []
    const sinks: PortRef[] = []
    const edits: { net: string; from: PortRef; to?: PortRef }[] = []
    for (const sink of net.sinks) {
      if (sink.node !== nodeId) {
        sinks.push(sink)
        continue
      }
      if (sink.members !== undefined) {
        edits.push({ net: netId, from: sink })
        continue // dynamic member sink: dropped
      }
      const move = moves.find((m) => m.fromPort === sink.port)
      if (move) {
        const to = { node: asNodeId(move.to.nodeId), port: asPortId(move.to.port) }
        sinks.push(to)
        edits.push({ net: netId, from: sink, to })
      } else if (!droppedSinkPorts.has(sink.port)) {
        sinks.push(sink)
        edits.push({ net: netId, from: sink, to: sink })
      } else edits.push({ net: netId, from: sink })
    }
    // Only record when something actually changed.
    const changed = sinks.length !== net.sinks.length || sinks.some((s, i) => !samePortRef(s, net.sinks[i]!))
    if (changed) {
      netSinks.push({ net: netId, sinks })
      netSinkEdits.push(...edits)
    }
  }

  const archivedLinkIds = new Set<string>()
  const archivedNetIds = new Set<string>()
  if (rule.migration !== undefined &&
      (migrationEvidence || historicalViewInputs.length > 0)) {
    for (const id of migrationInvalidTapLinks) archivedLinkIds.add(id)
    for (const input of rule.migration.historicalInputs) {
      for (const id of state.linksIn.get(input) ?? []) archivedLinkIds.add(id)
      for (const id of state.tapLinksOut.get(input) ?? []) archivedLinkIds.add(id)
      for (const id of state.netsIn.get(input) ?? []) archivedNetIds.add(id)
    }
    if (migrationUsedFallback) {
      for (const id of dropLinks) archivedLinkIds.add(id)
      for (const id of dropNets) archivedNetIds.add(id)
      for (const edit of netSinkEdits) {
        if (edit.to === undefined) archivedNetIds.add(edit.net)
      }
    }
  }
  const migrationArchive: JsonObject | undefined = rule.migration !== undefined &&
    (migrationEvidence || historicalViewInputs.length > 0)
    ? {
        version: 1,
        historicalInputs: [...rule.migration.historicalInputs],
        node: node as unknown as Json,
        links: Object.fromEntries([...archivedLinkIds].map((id) => [id, def.links[id]!])) as unknown as Json,
        nets: Object.fromEntries([...archivedNetIds].map((id) => [id, def.nets[id]!])) as unknown as Json,
        view: (document.view.graphs[graphId]?.nodes[nodeId] ?? null) as unknown as Json,
        boundary: (def.boundary ?? null) as unknown as Json,
      }
    : undefined
  const migrationInfo = errors.length === 0 && migrationArchive !== undefined &&
    (migrationUsedFallback || migrationDisplacedState)
    ? [diag(
        'info',
        'replace.migration.archived',
        migrationUsedFallback
          ? `replace: migrated '${nodeId}' with the default case and archived unmatched historical state in node ext`
          : `replace: migrated '${nodeId}' and archived displaced historical state in node ext`,
      )]
    : []
  const diagnostics = [...errors, ...warnings, ...migrationInfo]
  if (errors.length > 0) return { diagnostics }

  const createdNodes = [...helperTargets.entries()].map(([localId, helper]) => {
    const helperControllerValues = helperControllers.get(localId)!
    const helperDynamicState = helperDynamic.get(localId)!
    return {
      nodeId: helper.nodeId,
      localId,
      type: helper.type,
      values: helperValues.get(localId)!,
      ...(Object.keys(helperDynamicState).length > 0 ? { dynamic: helperDynamicState } : {}),
      ...(Object.keys(helperControllerValues).length > 0
        ? { controllers: helperControllerValues }
        : {}),
    }
  })
  const hasTargetChoiceState = dynamicStatesHaveSelection(dynamic) ||
    [...helperDynamic.values()].some(dynamicStatesHaveSelection)
  const targetSchemaGuards = [
    ...(dynamicStatesHaveSelection(dynamic)
      ? [{ nodeId, type: target.type, schemaHash: fnv1a64(canonicalJson(target)) }]
      : []),
    ...[...helperTargets.entries()].flatMap(([localId, helper]) =>
      dynamicStatesHaveSelection(helperDynamic.get(localId)!)
        ? [{ nodeId: helper.nodeId, type: helper.type, schemaHash: fnv1a64(canonicalJson(helper.schema)) }]
        : []),
  ]

  return {
    plan: {
      graphId,
      nodeId,
      from: rule.from,
      to: matched.to,
      ...(rule.note !== undefined ? { note: rule.note } : {}),
      caseIndex,
      values,
      ...(Object.keys(dynamic).length > 0 ? { dynamic } : {}),
      ...(Object.keys(sourceCountGuards).length > 0 ? { sourceCountGuards } : {}),
      ...(hasTargetChoiceState ? { targetSchemaGuards } : {}),
      ...(Object.keys(controllers).length > 0 ? { controllers } : {}),
      ...(migrationArchive !== undefined ? { migrationArchive } : {}),
      ...(migrationUsedFallback ? { migrationFallback: true as const } : {}),
      inputRewires,
      ...(tapRewires.length > 0 ? { tapRewires } : {}),
      ...(inputViewRewires.length > 0 ? { inputViewRewires } : {}),
      ...(dropInputViews.length > 0 ? { dropInputViews } : {}),
      outputRewires,
      ...(tapGuards.length > 0 ? { tapGuards } : {}),
      ...(viewRewires.length > 0 ? { viewRewires } : {}),
      dropLinks,
      netSourceRewires,
      netSinks,
      ...(netSinkEdits.length > 0 ? { netSinkEdits } : {}),
      dropNets,
      ...(boundaryRewires.length > 0 ? { boundaryRewires } : {}),
      ...(boundaryGuard.length > 0 ? { boundaryGuard } : {}),
      ...(matched.nodes !== undefined || rule.migration !== undefined ? { createdNodes } : {}),
      ...(matched.links !== undefined ? { links: internalLinks } : {}),
    },
    diagnostics,
  }
}
