/**
 * Interface elaboration is stage 1 of the two-stage derived-state pipeline.
 *
 * A pure function from (NodeSchema, persisted node state, structural link
 * presence) to the node's EFFECTIVE ordered interface: autogrow members,
 * the active DynamicCombo branch, revealed DynamicSlot dependents - inputs
 * and outputs through the same code path.
 *
 * Load-bearing invariant (the anti-oscillation DAG): elaboration inputs are
 * restricted BY CONSTRUCTION to schema + stored values/dynamic state + link
 * EXISTENCE. Solved types never feed back into which ports exist. Any future
 * dynamic kind that would need type-dependent elaboration must be rejected
 * or given an explicit, documented stratification.
 *
 * Identity vs wire names (the split that keeps saved documents stable while
 * the backend wants positional names):
 * - Document identity: `PortAddress` - the value/link key (`PortRef.port`)
 *   plus, for family members, the generated member-id path (`PortRef.members`).
 *   A stamped family port is addressed '<family>.<slotId>' + member path -
 *   uniformly, even for single-slot templates, so a schema growing its
 *   template from one slot to a group never reshapes existing addresses.
 *   Wire-15 recursive families instead follow the co-pinned backend document
 *   contract: '<family>.<stableSuffix>' for one ordinary leaf and
 *   '<family>.<stableSuffix>.<leaf>' for grouped/recursive templates. The
 *   decoder marks that path explicitly; wire-14 families keep the prior form.
 *   Member ids are stable across regrowth and never depend on ordinal,
 *   label, or solved type.
 * - Wire identity: `apiName` - the dotted path the backend's dynamic-input
 *   expansion expects (`images.image0`, `mode.strength`, `clip.text`).
 *   Autogrow api names are POSITIONAL (member ordinal), computed here and
 *   consumed by the compiler; they are compiler output, never identity.
 *   Grouped templates derive provisional nested names ('items.item0.image')
 *   pending backend group naming - changing that derivation never migrates
 *   document identity.
 * - DynamicCombo branch values are BRANCH-LOCAL: the document value key
 *   includes the option key (`mode.[advanced].strength`) so switching
 *   branches preserves each branch's values; the option segment is stripped
 *   from the api name because the backend namespaces branch inputs by the
 *   construct id alone.
 *
 * Extensibility: each dynamic kind is a `DynamicKindHandler` in a registry
 * (injectable via ElaborateOptions). Downstream code switches on
 * `ElaboratedOrigin`, never on dynamic kind - adding a kind means adding a
 * handler, not editing compile/canvas. Unknown kinds elaborate to an inert
 * visible port plus a diagnostic - never silent state corruption.
 *
 * Complexity: O(interface items + persisted members + node links) per node;
 * connectivity facts are built once per graph definition (O(links + nets)).
 */

import { diag, type Diagnostic, type Severity } from '../diagnostics.js'
import { outputDescriptorAssetOf, outputDescriptorValueOf, parseOutputDescriptors } from './output-descriptors.js'
import type { DynamicPortState, GraphDef, Json, NodeData } from '../format/document.js'
import { asPortId, isExactWidgetTapRef, isPortEndpoint, MAX_MEMBER_ORDINAL, portAddressKey, type DynamicMemberId, type NodeId } from '../ids.js'
import {
  autogrowBounds,
  comboBranchValuePath,
  effectiveComboOption,
  joinValuePath,
  outputCountInputsOf,
  outputCountValueOf,
} from './model.js'
import type {
  AutogrowSpec,
  CountBoundOutputAutogrowSpec,
  DynamicComboSpec,
  DynamicSlotSpec,
  DynamicSpec,
  InputSpec,
  NodeSchema,
  OutputSpec,
  SectionSpec,
  TypeExpr,
  WidgetSpec,
} from './model.js'

// ---------------------------------------------------------------------------
// Connectivity facts (structural link presence - built once per graph)
// ---------------------------------------------------------------------------

/**
 * Structural connection facts for ONE node: "does a link or net endpoint
 * attach to this producer/consumer address?". Memberless output queries are
 * producer-kind agnostic (ordinary output or widget tap); member-addressed
 * outputs and every input query remain port-only. Link EXISTENCE only - reroute-driven links
 * still count (the consumer-side hop always targets the input directly), and
 * whether the chain is actually driven or type-compatible is irrelevant here
 * by design.
 */
export interface Connectivity {
  isInputConnected(port: string, members?: readonly string[]): boolean
  isOutputConnected(port: string, members?: readonly string[]): boolean
  /** Enumerable document port ids, used to discover wire-15 family members. */
  inputPorts?(): readonly string[]
}

export const EMPTY_CONNECTIVITY: Connectivity = {
  isInputConnected: () => false,
  isOutputConnected: () => false,
}

/**
 * Build per-node connectivity for a graph definition in one pass over links
 * and nets. Returns an accessor; nodes with no attachments share a constant.
 */
export function buildGraphConnectivity(def: GraphDef): (node: NodeId) => Connectivity {
  const inputs = new Map<NodeId, Set<string>>()
  const outputs = new Map<NodeId, Set<string>>()
  const inputPorts = new Map<NodeId, Set<string>>()
  const producerKey = (kind: 'port' | 'tap', port: string, members?: readonly string[]): string =>
    JSON.stringify([kind, port, members ?? []])
  const add = (map: Map<NodeId, Set<string>>, node: NodeId, key: string): void => {
    let set = map.get(node)
    if (!set) map.set(node, (set = new Set()))
    set.add(key)
  }
  for (const link of Object.values(def.links)) {
    if (isPortEndpoint(link.from))
      add(outputs, link.from.node, producerKey('port', link.from.port, link.from.members))
    else if (
      isExactWidgetTapRef(link.from) &&
      def.nodes[link.from.node] !== undefined
    )
      add(outputs, link.from.node, producerKey('tap', link.from.tap))
    if (isPortEndpoint(link.to)) {
      add(inputs, link.to.node, portAddressKey(link.to.port, link.to.members))
      if (link.to.members === undefined || link.to.members.length === 0) add(inputPorts, link.to.node, link.to.port)
    }
  }
  for (const net of Object.values(def.nets)) {
    add(outputs, net.source.node, producerKey('port', net.source.port, net.source.members))
    for (const sink of net.sinks) {
      add(inputs, sink.node, portAddressKey(sink.port, sink.members))
      if (sink.members === undefined || sink.members.length === 0) add(inputPorts, sink.node, sink.port)
    }
  }
  const cache = new Map<NodeId, Connectivity>()
  return (node) => {
    let c = cache.get(node)
    if (c) return c
    const ins = inputs.get(node)
    const outs = outputs.get(node)
    if (!ins && !outs) return EMPTY_CONNECTIVITY
    c = {
      isInputConnected: (port, members) => ins?.has(portAddressKey(port, members)) ?? false,
      isOutputConnected: (port, members) =>
        outs?.has(producerKey('port', port, members)) === true ||
        ((members === undefined || members.length === 0) && outs?.has(producerKey('tap', port)) === true),
      inputPorts: () => [...(inputPorts.get(node) ?? [])],
    }
    cache.set(node, c)
    return c
  }
}

// ---------------------------------------------------------------------------
// Elaborated interface model
// ---------------------------------------------------------------------------

/**
 * Document-identity address of an elaborated port: what PortRef stores.
 * `port` is the value/link key (a path for nested constructs); `members` is
 * the member-id path (outermost first), set for family members only.
 */
export interface PortAddress {
  readonly port: string
  readonly members?: readonly DynamicMemberId[]
}

/**
 * Unique string key of an elaborated port (map keys, layout row ids).
 *
 * Deliberately NOT the opaque NUL key from ids.ts: this string becomes the
 * elaborated `spec.id` and appears in diagnostics, so it stays human-readable
 * (one `#` segment per member-path element: `port#outer#inner`). Components
 * are minimally escaped ('%' then '#') so the packing stays injective even
 * for ids containing '#' - normal ids are untouched. It is derived, never
 * workflow identity - do not change the packing casually; elaboration
 * fixtures assert these strings.
 */
const escapeElabSeg = (s: string): string => s.replace(/%/g, '%25').replace(/#/g, '%23')

export const elabKeyOf = (a: PortAddress): string =>
  a.members === undefined || a.members.length === 0
    ? escapeElabSeg(a.port)
    : [a.port, ...a.members].map(escapeElabSeg).join('#')

/** Decode a canonical value key, optionally including memberless dynamic inputs. */
export const addressOfElabKey = (key: string, includeMemberless = false): PortAddress | undefined => {
  const unescape = (s: string): string => s.replace(/%23/g, '#').replace(/%25/g, '%')
  const parts = key.split('#').map(unescape)
  if (parts.length < 2 && !includeMemberless) return undefined
  const address: PortAddress = { port: parts[0]!, ...(parts.length > 1 ? { members: parts.slice(1) as DynamicMemberId[] } : {}) }
  return elabKeyOf(address) === key ? address : undefined
}

/**
 * Where an elaborated item came from. Downstream code branches on THIS
 * (roles), never on dynamic kind - that is what keeps future dynamic kinds
 * from spraying conditionals through compile/canvas.
 */
export type ElaboratedOrigin =
  | { readonly kind: 'static' }
  /** Autogrow family member. `ghost`: the trailing empty affordance, not yet persisted. */
  | {
      readonly kind: 'member'
      readonly construct: string
      readonly ordinal: number
      readonly ghost?: boolean
      readonly wire15Naming?: 'prefix' | 'names'
    }
  /** DynamicCombo's own selector widget (value = selected option key, stored in dynamic state). */
  | { readonly kind: 'selector'; readonly construct: string; readonly selected?: string }
  /** Input belonging to the active DynamicCombo branch. */
  | { readonly kind: 'branch'; readonly construct: string; readonly option: string }
  /** DynamicSlot's connectable slot itself. */
  | { readonly kind: 'slot'; readonly construct: string; readonly variants?: readonly { readonly key: string; readonly type: import('./model.js').TypeExpr }[]; readonly selected?: string; readonly typeTemplateId?: string }
  /** Dependent input revealed by a connected DynamicSlot. */
  | { readonly kind: 'dependent'; readonly construct: string; readonly variant?: string }
  /** Unknown dynamic kind: inert placeholder port (diagnostic emitted). */
  | { readonly kind: 'unknown'; readonly construct: string }

/**
 * One family crossing on the way to an elaborated item (hazard N4).
 * `ancestry` on an elaborated item aligns 1:1 with `address.members`
 * (outermost first) and is ORTHOGONAL to the leaf role in `origin`: a combo
 * selector nested inside an autogrow member keeps origin 'selector' while
 * its ancestry records the member it lives under. `ghost` marks the family's
 * trailing affordance member; at most one ancestor in any path is ghost.
 */
export interface DynamicAncestor {
  /** Family construct value key (path form, e.g. 'items' or 'items.sub'). */
  readonly construct: string
  readonly member: DynamicMemberId
  readonly ordinal: number
  readonly ghost?: boolean
  /**
   * The member id is SYNTHESIZED (min-fill or promoted ghost), not persisted
   * in document state. Synthetic members are part of the effective interface
   * (they occupy wire names/indexes) but a committed document must never
   * reference them as link endpoints - commands materialize on write
   * (hazard N3), so the compiler rejects such references as diagnostics.
   */
  readonly synthetic?: boolean
}

export interface ElaboratedInput {
  readonly kind: 'input'
  readonly address: PortAddress
  /**
   * Backend wire name (dotted path). Absent on ports that never reach the
   * prompt: ghost members (and everything beneath a ghost ancestor), members
   * beyond the family cap, unknown-kind placeholders.
   */
  readonly apiName?: string
  /**
   * Effective spec. `spec.id` is rewritten to elabKeyOf(address) - unique
   * within the node - NOT the raw schema id; use `address` for document
   * identity.
   */
  readonly spec: InputSpec
  readonly origin: ElaboratedOrigin
  /** Family crossings, aligned 1:1 with address.members. Absent when top-level. */
  readonly ancestry?: readonly DynamicAncestor[]
  /**
   * Value not stored in node.values (selector only: the selected option
   * key). Compile/canvas read this instead of node.values for such ports.
   */
  readonly derivedValue?: Json
  /** Submitted under document identity; backend owns compat projection. */
  readonly wire15Materialization?: true
  /** Direct wire-15 member state that must be persisted before writing this input. */
  readonly materialize?: readonly MaterializeFrame[]
}

export interface ElaboratedOutput {
  readonly kind: 'output'
  readonly address: PortAddress
  readonly spec: OutputSpec
  readonly origin: ElaboratedOrigin
  /** Canonical backend output id; differs from document identity for native family members. */
  readonly backendId?: string
  /** Family crossings, aligned 1:1 with address.members. Absent when top-level. */
  readonly ancestry?: readonly DynamicAncestor[]
  /**
   * False when this output never takes part in wiring: ghost subtree,
   * beyond the family cap, or an unknown-kind placeholder. The output-side
   * mirror of an input's absent apiName - wire indexes count only wireable
   * outputs. Set centrally by scoped emission, never by handlers.
   */
  readonly wireable?: false
  /** Direct wire-15 member state that must be persisted before wiring this output. */
  readonly materialize?: readonly MaterializeFrame[]
}

export interface ElaboratedSection {
  readonly kind: 'section'
  readonly spec: SectionSpec
}

/**
 * Explicit grow-family affordance: emitted IN PLACE OF a trailing ghost
 * whose member rendered zero items (a template of only min-0 nested
 * constructs - the inner ghost tree is suppressed beneath a ghost ancestor
 * by the single-ghost rule, hazard N3). Not a port: it has no address and
 * never compiles. The canvas renders it as a click-to-add row; activating
 * it dispatches `dynamic.materialize` with `frames`, after which the new
 * member's inner families elaborate (and ghost) normally.
 */
export interface ElaboratedGrowth {
  readonly kind: 'growth'
  /** Family construct value key (path form, e.g. 'items' or 'items.sub'). */
  readonly construct: string
  readonly side: 'input' | 'output'
  /** Presentation label (family display name, member-scoped when nested). */
  readonly label: string
  /** `dynamic.materialize` frames that persist the offered member. */
  readonly frames: readonly MaterializeFrame[]
  /** Section the family item belongs to (hides with it when collapsed). */
  readonly section?: string
}

export type ElaboratedItem = ElaboratedInput | ElaboratedOutput | ElaboratedSection | ElaboratedGrowth

export interface ElaboratedInterface {
  /** Ordered as the schema declares; dynamic members appear inline at their construct's position. */
  readonly items: readonly ElaboratedItem[]
  readonly chunkSafe?: Pick<NonNullable<NodeSchema['chunkSafe']>, 'inputs' | 'outputs'>
  /** Wire-15 selector values derived from explicit document choice state. */
  readonly submissionValues: readonly { readonly path: string; readonly apiPath: string; readonly value: Json }[]
  /** Canonical family suffixes submitted to the native graph. Omitted when empty. */
  readonly outputMembers?: Readonly<Record<string, readonly string[]>>
  readonly diagnostics: readonly Diagnostic[]
}

export const elabInputsOf = (e: ElaboratedInterface): readonly ElaboratedInput[] =>
  e.items.filter((i): i is ElaboratedInput => i.kind === 'input')
export const elabOutputsOf = (e: ElaboratedInterface): readonly ElaboratedOutput[] =>
  e.items.filter((i): i is ElaboratedOutput => i.kind === 'output')

/**
 * The node.values key an elaborated input's widget value persists under.
 * Top-level static inputs use the RAW schema port id (elab-key escaping may
 * differ); everything dynamic-derived uses elaborated identity (spec.id).
 * The ONE rule shared by compile (staging/prompt reads) and the canvas/app
 * (widget writes) - hazard N6: never re-derive this ad hoc.
 */
export const valueKeyOf = (i: ElaboratedInput): string =>
  i.origin.kind === 'static' && (i.address.members?.length ?? 0) === 0
    ? (i.address.port as string)
    : i.spec.id

// ---------------------------------------------------------------------------
// Dynamic kind handlers (the extension point)
// ---------------------------------------------------------------------------

/**
 * Path scope for nested elaboration. `valuePrefix` builds document value
 * keys (option segments as `[key]`); `apiPrefix` builds backend wire names
 * (option segments omitted - the backend namespaces branch inputs by the
 * construct id alone; `undefined` means nothing in this scope reaches the
 * prompt). Both are '' at node top level. `staticOrigin` is the origin
 * non-dynamic inputs elaborated in this scope receive (branch/dependent
 * tagging is explicit, never inferred from path strings).
 *
 * The member fields realize hazard N4: entering a family member appends to
 * `members`/`ancestry` and swaps `stateOf` to that member's nested state -
 * handlers NEVER resolve state by walking or parsing paths outward, and
 * emission binds `address.members` from the scope so a handler cannot emit
 * an address inconsistent with where it elaborates. Derive member scopes
 * via `ctx.memberScope`; extend prefix-only scopes by spreading (`...scope`)
 * so the member fields ride along untouched.
 */
export interface ElabScope {
  readonly valuePrefix: string
  /** Wire-name prefix; undefined = nothing in this scope reaches the prompt. */
  readonly apiPrefix: string | undefined
  readonly staticOrigin?: ElaboratedOrigin
  /** Member-id path of every family crossed to reach this scope (outermost first). */
  readonly members: readonly DynamicMemberId[]
  /** Family-crossing descriptors, aligned 1:1 with `members`. */
  readonly ancestry: readonly DynamicAncestor[]
  /** True when any ancestor is a ghost: emission strips api names centrally. */
  readonly ghost: boolean
  /** Scope-local dynamic state cursor, keyed by construct value key (hazard N4). */
  readonly stateOf: (construct: string) => DynamicPortState | undefined
  /** Display-name prefix composed across members ('items0'); presentation only. */
  readonly displayPrefix?: string
  /**
   * `dynamic.materialize` frames for the member chain of this scope (each
   * synthetic level carries its preceding synthetic siblings, matching
   * materializeFramesOf). Growth affordances append their own frame to
   * these; absent at node top level.
   */
  readonly frames?: readonly MaterializeFrame[]
  /** Direct-path wire-15 frames carried without changing PortAddress.members. */
  readonly wire15MaterializeFrames?: readonly MaterializeFrame[]
  /** This scope was entered through wire-15 document materialization. */
  readonly wire15Materialization?: true
}

/** Api-name join that propagates "never reaches the prompt" (undefined). */
const apiJoin = (prefix: string | undefined, seg: string): string | undefined =>
  prefix === undefined ? undefined : joinValuePath(prefix, seg)

/** Presentation-only join that avoids repeating an authored family stem. */
const displayJoin = (prefix: string | undefined, segment: string): string => {
  if (prefix === undefined) return segment
  const dot = prefix.lastIndexOf('.')
  const tail = prefix.slice(dot + 1)
  if (segment !== tail && !segment.startsWith(`${tail}_`)) return `${prefix}.${segment}`
  return dot >= 0 ? `${prefix.slice(0, dot)}.${segment}` : segment
}

/** Elaborated specs never carry `dynamic` - the construct is consumed here. */
const stripDynamic = <T extends InputSpec | OutputSpec>(item: T): T => {
  if (item.dynamic === undefined) return item
  const { dynamic: _dynamic, ...rest } = item
  return rest as T
}

/**
 * Re-key a spec to its elaborated address, keeping the AUTHORED short id as
 * the human label when no displayName was declared: a combo-branch 'mask'
 * must never render as 'mode.[a].mask'. Handlers that compute richer labels
 * (autogrow member naming) set displayName themselves and are unaffected.
 */
const rekey = <T extends InputSpec | OutputSpec>(item: T, id: string): T =>
  id === item.id
    ? item
    : { ...item, id, ...(item.displayName === undefined ? { displayName: item.id } : {}) }

/** Descriptor for deriving a member scope (the prefix frame the family picks). */
export interface MemberScopeFrame {
  readonly valuePrefix: string
  /** Wire-name prefix for the member's contents; undefined = never compiled. */
  readonly apiPrefix: string | undefined
  readonly staticOrigin?: ElaboratedOrigin
  readonly displayPrefix?: string
  /** Cumulative materialize frames for the member chain (see ElabScope.frames). */
  readonly frames?: readonly MaterializeFrame[]
}

/** Elaboration context handed to kind handlers. */
export interface ElabContext {
  readonly nodeType: string
  readonly connectivity: Connectivity
  readonly storedValues: Readonly<Record<string, Json>>
  readonly dynamicState: Readonly<Record<string, DynamicPortState>>
  readonly inputEvidence: readonly string[]
  readonly memberBudget: number
  /** See ElaborateOptions.promoteGhosts (view affordance; compiler: false). */
  readonly promoteGhosts: boolean
  /**
   * Emit one elaborated item. Emission is SCOPED (hazard N4): the item's
   * `address.members`, `ancestry`, and `spec.id` are bound from the scope
   * centrally, ghost scopes lose api names and become optional, and `dynamic`
   * is stripped from the spec - a handler cannot accidentally compile a
   * ghost descendant or emit an out-of-scope address.
   */
  emit(item: ElaboratedItem, scope: ElabScope): void
  /** Recursively elaborate nested input specs (template/branch/dependent inputs). */
  elaborateInputs(inputs: readonly InputSpec[], scope: ElabScope): void
  /** Recursively elaborate nested output specs (dynamic output templates). */
  elaborateOutputs(outputs: readonly OutputSpec[], scope: ElabScope): void
  /**
   * Derive the scope for elaborating INSIDE one family member: appends the
   * member to the path/ancestry, inherits ghostness, and roots the state
   * cursor at that member's nested state (ghost members expose NO state -
   * nothing beneath a ghost is persisted, hazard N3).
   */
  memberScope(parent: ElabScope, entry: DynamicAncestor, frame: MemberScopeFrame): ElabScope
  /**
   * Count one dynamic member against the elaboration budget (hazard N5).
   * Returns false once the budget is exhausted - the caller must stop; the
   * diagnostic is reported centrally, exactly once.
   */
  countMember(): boolean
  /**
   * Items emitted so far. Handlers compare before/after a member's emission
   * to detect a trailing ghost that rendered NOTHING (nested-only template)
   * and replace it with an explicit growth affordance.
   */
  itemCount(): number
  /** Record document-stored output-family members for graph submission. */
  recordOutputMembers(family: string, members: readonly string[]): void
  /** Record a non-port value the graph submission must carry. */
  submitValue(path: string, apiPath: string, value: Json): void
  report(severity: Severity, code: string, message: string, port?: string): void
}

/**
 * One dynamic kind's elaboration strategy. Handlers own EVERYTHING about
 * their kind: member identity, api naming, transition-friendly state reads.
 * They must obey the DAG invariant: consult `ctx.connectivity` (existence)
 * freely, solved types never.
 */
export interface DynamicKindHandler {
  readonly kind: string
  elaborateInput(ctx: ElabContext, item: InputSpec, dyn: DynamicSpec, scope: ElabScope): void
  /** Optional output-side elaboration (dynamic output families). */
  elaborateOutput?(ctx: ElabContext, item: OutputSpec, dyn: DynamicSpec, scope: ElabScope): void
}

// -- Autogrow ---------------------------------------------------------------

/**
 * Highest numeric suffix among `m<N>` member ids (-1 when none). Fresh ids
 * are formatted as canonical decimals, so only ids whose suffix parses
 * exactly can ever collide by string equality: suffixes past the safe-
 * integer range (16+ digits) are unreachable by the counter and skipped.
 */
const maxMemberSuffix = (ids: Iterable<string>): number => {
  let max = -1
  for (const m of ids) {
    const match = /^m(\d{1,15})$/.exec(m)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

/**
 * Fresh member ids continue from max(persisted seq, highest used suffix + 1)
 * so ids are never recycled even if the newest member was removed (`seq` is
 * command-maintained; the suffix scan keeps hand-written fixtures sane).
 * `memberState` keys count as used: an orphaned nested-state entry must
 * never be resurrected by a freshly minted ghost id (hazard N1).
 */
const nextMemberBase = (state: DynamicPortState | undefined): number =>
  Math.max(
    Math.min(state?.seq ?? 0, Number.MAX_SAFE_INTEGER),
    maxMemberSuffix([...(state?.members ?? []), ...Object.keys(state?.memberState ?? {})]) + 1,
  )

interface AutogrowNames {
  readonly nameOf: (ordinal: number) => string
  readonly min: number
  readonly max: number
}

const autogrowNames = (spec: AutogrowSpec): AutogrowNames => {
  const naming = spec.naming
  const { min, max } = autogrowBounds(spec)
  // ordinalOffset shifts prefix NUMBERING only (a derived boundary family
  // continues the definition prefix's count: 'item2' when the definition
  // owns item0/item1). Name lists are already sliced by derive, so their
  // local index is correct as-is. min/max stay LOCAL bounds.
  const offset = spec.ordinalOffset ?? 0
  if (naming.kind === 'names') {
    return { nameOf: (i) => naming.names[i]!, min, max }
  }
  if (naming.kind === 'native') {
    // Native suffix state is not materialized, so this arm has zero capacity.
    return { nameOf: () => '', min, max }
  }
  return { nameOf: (i) => `${naming.prefix}${i + offset}`, min, max }
}

/** Template InputSpec reshaped for the output side (family carries isList). */
const toOutputSpec = (slot: InputSpec, family: OutputSpec): OutputSpec => ({
  kind: 'output',
  id: slot.id,
  type: slot.type,
  ...(slot.displayName !== undefined ? { displayName: slot.displayName } : {}),
  ...(slot.section !== undefined ? { section: slot.section } : {}),
  ...(slot.tooltip !== undefined ? { tooltip: slot.tooltip } : {}),
  ...(family.isList !== undefined ? { isList: family.isList } : {}),
  ...(family.preview !== undefined ? { preview: family.preview } : {}),
  ...(slot.dynamic !== undefined ? { dynamic: slot.dynamic } : {}),
})

/** Wire-15 families use stable suffixes directly in dot-scoped document ids. */
export function collectWire15MemberEvidence(
  family: string,
  explicitMembers: readonly string[],
  valueKeys: readonly string[],
  inputPorts: readonly string[],
  dynamicKeys: readonly string[],
): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const add = (member: string): void => {
    if (member !== '' && !seen.has(member)) {
      seen.add(member)
      result.push(member)
    }
  }
  for (const member of explicitMembers) add(member)
  const prefix = `${family}.`
  for (const channel of [valueKeys, inputPorts, dynamicKeys]) {
    for (const key of channel) {
      if (key.startsWith(prefix)) add(key.slice(prefix.length).split('.', 1)[0]!)
    }
  }
  return result
}

function elaborateWire15Family(
  ctx: ElabContext,
  item: InputSpec,
  spec: AutogrowSpec,
  scope: ElabScope,
): void {
  if (spec.naming.kind === 'native') return
  const family = joinValuePath(scope.valuePrefix, item.id)
  const familyApi = apiJoin(scope.apiPrefix, item.id)
  const { min, max } = autogrowBounds(spec)
  const members: string[] = []
  const seen = new Set<string>()
  const examined = new Set<string>()
  let overLimit = false
  const add = (member: string): void => {
    if (member === '' || seen.has(member) || overLimit) return
    seen.add(member)
    members.push(member)
    if (members.length > max || members.length > ctx.memberBudget) overLimit = true
  }
  const state = scope.stateOf(family)
  const storedMembers = state?.members ?? []
  if (storedMembers.length > ctx.memberBudget) {
    ctx.report('error', 'elab.autogrow.overMax', `${ctx.nodeType}.${family}: stored member state exceeds the ${ctx.memberBudget}-member budget`, family)
    return
  }
  const evidenceMembers = collectWire15MemberEvidence(
    family,
    storedMembers,
    Object.keys(ctx.storedValues),
    ctx.connectivity.inputPorts?.() ?? [],
    Object.keys(ctx.dynamicState),
  )
  for (const member of evidenceMembers) {
    if (storedMembers.includes(member as never)) add(member)
    if (overLimit) break
  }
  if (overLimit) {
    ctx.report('error', 'elab.autogrow.overMax', `${ctx.nodeType}.${family}: members exceed the family cap of ${Math.min(max, ctx.memberBudget)}`, family)
    return
  }
  for (const member of evidenceMembers) {
    if (storedMembers.includes(member as never)) continue
    if (examined.has(member)) continue
    examined.add(member)
    const memberPath = joinValuePath(family, member)
    const singleLeaf = spec.template.length === 1 && spec.template[0]!.dynamic === undefined
    if (singleLeaf
      ? wire15HasStoredInput(memberPath, ctx)
      : wire15TemplateHasActiveState(spec.template, memberPath, ctx)) add(member)
    if (overLimit) {
      ctx.report('error', 'elab.autogrow.overMax', `${ctx.nodeType}.${family}: members exceed the family cap of ${Math.min(max, ctx.memberBudget)}`, family)
      return
    }
  }

  const synthetic = new Set<string>()
  let fresh = Math.max(nextMemberBase(state), maxMemberSuffix(members) + 1)
  const declaredNames = spec.naming.kind === 'names' ? spec.naming.names : undefined
  const namedSynthesisOrder = declaredNames !== undefined
    ? (() => {
        const highest = members.reduce(
          (index, member) => Math.max(index, declaredNames.indexOf(member)),
          -1,
        )
        return [...declaredNames.slice(highest + 1), ...declaredNames.slice(0, highest + 1)]
      })()
    : undefined
  while (ctx.promoteGhosts && members.length < min && members.length < max) {
    const member = spec.naming.kind === 'names'
      ? namedSynthesisOrder!.find((name) => !seen.has(name))
      : fresh <= MAX_MEMBER_ORDINAL ? `m${fresh++}` : undefined
    if (member === undefined) break
    add(member)
    synthetic.add(member)
  }
  if (members.length < min) {
    ctx.report('error', 'elab.autogrow.underMin', `${ctx.nodeType}.${family}: ${members.length} members are below the minimum of ${min}`, family)
    return
  }
  if (members.length > max || members.length > ctx.memberBudget) {
    ctx.report('error', 'elab.autogrow.overMax', `${ctx.nodeType}.${family}: ${members.length} members exceed the family cap of ${Math.min(max, ctx.memberBudget)}`, family)
    return
  }

  const grouped = spec.template.length !== 1 || spec.template[0]!.dynamic !== undefined
  const syntheticIds: string[] = []
  const emitMember = (member: string, ordinal: number, ghost: boolean, isSynthetic: boolean): boolean => {
    if (!WIRE15_MEMBER_SEGMENT.test(member)) {
      ctx.report('error', 'elab.autogrow.badMember', `${ctx.nodeType}.${family}: member suffix '${member}' must match [A-Za-z0-9_-]+`, family)
      return false
    }
    if (spec.naming.kind === 'names' && !spec.naming.names.includes(member)) {
      ctx.report('error', 'elab.autogrow.unknownName', `${ctx.nodeType}.${family}: member suffix '${member}' is not in the declared names vocabulary`, family)
      return false
    }
    if (!ctx.countMember()) return false
    if (isSynthetic) syntheticIds.push(member)
    const memberPath = joinValuePath(family, member)
    const apiSegment = spec.naming.kind === 'names' ? member : autogrowNames(spec).nameOf(ordinal)
    const memberApi = familyApi === undefined ? undefined : joinValuePath(familyApi, apiSegment)
    const materializeFrames = isSynthetic
      ? [
          ...(scope.wire15MaterializeFrames ?? []),
          { construct: family, members: [...syntheticIds] },
        ]
      : undefined
    const origin: ElaboratedOrigin = {
      kind: 'member',
      construct: family,
      ordinal,
      wire15Naming: spec.naming.kind === 'names' ? 'names' : 'prefix',
      ...(ghost ? { ghost: true } : {}),
    }
    const child: ElabScope = {
      ...scope,
      valuePrefix: memberPath,
      apiPrefix: memberApi,
      staticOrigin: origin,
      stateOf: (construct) => ctx.dynamicState[construct],
      ghost: scope.ghost || ghost,
      ...(materializeFrames !== undefined ? { wire15MaterializeFrames: materializeFrames } : {}),
      wire15Materialization: true,
    }
    if (!grouped) {
      const slot = spec.template[0]!
      ctx.emit({
        kind: 'input',
        address: { port: memberPath },
        ...(memberApi !== undefined ? { apiName: memberApi } : {}),
        spec: { ...slot, id: memberPath, displayName: apiSegment },
        origin,
      }, child)
    } else {
      ctx.elaborateInputs(spec.template, child)
    }
    return true
  }

  if (spec.naming.kind === 'names') {
    const names = spec.naming.names
    const unknownIndex = members.findIndex((member) => !names.includes(member))
    const validMembers = unknownIndex < 0 ? members : members.slice(0, unknownIndex)
    const lastMemberIndex = validMembers.reduce(
      (highest, member) => Math.max(highest, names.indexOf(member)),
      -1,
    )
    const ghost = unknownIndex < 0 && members.length < max && !scope.ghost
      ? names.slice(lastMemberIndex + 1).find((name) => !seen.has(name))
      : undefined
    const ordered = names.filter((name) => validMembers.includes(name) || name === ghost)
    for (const member of ordered) {
      const ordinal = names.indexOf(member)
      const isGhost = member === ghost
      const before = ctx.itemCount()
      if (!emitMember(member, ordinal, isGhost, synthetic.has(member) || isGhost)) return
      if (isGhost && ctx.itemCount() === before) {
        ctx.emit({
          kind: 'growth',
          construct: family,
          side: 'input',
          label: item.displayName ?? item.id,
          frames: [{ construct: family, members: [...syntheticIds] }],
          ...(item.section !== undefined ? { section: item.section } : {}),
        }, scope)
      }
    }
    if (unknownIndex >= 0) {
      const unknown = members[unknownIndex]!
      if (!emitMember(unknown, unknownIndex, false, synthetic.has(unknown))) return
    }
    return
  }

  for (const [ordinal, member] of members.entries()) {
    if (!emitMember(member, ordinal, false, synthetic.has(member))) return
  }

  if (members.length >= max || scope.ghost) return
  const ghost = fresh <= MAX_MEMBER_ORDINAL ? `m${fresh}` : undefined
  if (ghost === undefined) {
    if (spec.naming.kind === 'prefix' && fresh > MAX_MEMBER_ORDINAL) {
      ctx.report(
        'warning',
        'elab.autogrow.idsExhausted',
        `${ctx.nodeType}.${family}: member id space exhausted (next ordinal ${fresh}); family cannot grow further`,
        family,
      )
    }
    return
  }
  const before = ctx.itemCount()
  if (!emitMember(ghost, members.length, true, true)) return
  if (ctx.itemCount() === before) {
    ctx.emit({
      kind: 'growth',
      construct: family,
      side: 'input',
      label: item.displayName ?? item.id,
      frames: [{ construct: family, members: [...syntheticIds] }],
      ...(item.section !== undefined ? { section: item.section } : {}),
    }, scope)
  }
}

const WIRE15_MEMBER_SEGMENT = /^[A-Za-z0-9_-]+$/

/** Whether reachable nested document state establishes one wire-15 member. */
function wire15TemplateHasActiveState(
  entries: readonly InputSpec[],
  parent: string,
  ctx: ElabContext,
): boolean {
  for (const entry of entries) {
    const dynamic = entry.dynamic
    const path = joinValuePath(parent, entry.id)
    if (dynamic === undefined) {
      if (wire15HasStoredInput(path, ctx)) return true
      continue
    }
    if (dynamic.kind === 'autogrow') {
      if ((ctx.dynamicState[path]?.members?.length ?? 0) > 0) return true
      const prefix = `${path}.`
      const examined = new Set<string>()
      for (const key of ctx.inputEvidence) {
        if (!key.startsWith(prefix)) continue
        const member = key.slice(prefix.length).split('.', 1)[0]!
        if (examined.has(member)) continue
        examined.add(member)
        const memberPath = joinValuePath(path, member)
        const singleLeaf = dynamic.template.length === 1 && dynamic.template[0]!.dynamic === undefined
        if (singleLeaf
          ? wire15HasStoredInput(memberPath, ctx)
          : wire15TemplateHasActiveState(dynamic.template, memberPath, ctx)) return true
      }
      continue
    }
    if (dynamic.kind === 'dynamicCombo') {
      const state = ctx.dynamicState[path]
      if (state !== undefined && Object.prototype.hasOwnProperty.call(state, 'selected')) return true
      const selected = dynamic.options[0]?.key
      const option = dynamic.options.find((candidate) => candidate.key === selected)
      if (option !== undefined && wire15TemplateHasActiveState(option.inputs, path, ctx)) return true
      continue
    }
    if (dynamic.variants !== undefined) {
      const state = ctx.dynamicState[path]
      if (state !== undefined && Object.prototype.hasOwnProperty.call(state, 'selected')) return true
      continue
    }
    if (wire15HasStoredInput(path, ctx)) return true
    if (ctx.inputEvidence.some((key) => key.startsWith(`${path}.`))) return true
  }
  return false
}

const wire15HasStoredInput = (path: string, ctx: ElabContext): boolean =>
  Object.prototype.hasOwnProperty.call(ctx.storedValues, path) ||
  ctx.connectivity.isInputConnected(path)

function elaborateAutogrowFamily(
  ctx: ElabContext,
  item: InputSpec | OutputSpec,
  spec: AutogrowSpec,
  scope: ElabScope,
  side: 'input' | 'output',
): void {
  // Wire-15 decode/model foundation only. Native free-suffix families need
  // document suffix state that this materializer does not own yet; ignore
  // even hand-authored persisted members rather than inventing identities.
  if (spec.naming.kind === 'native') return
  if (side === 'input' && spec.materialization === 'wire15') {
    elaborateWire15Family(ctx, item as InputSpec, spec, scope)
    return
  }
  const family = joinValuePath(scope.valuePrefix, item.id)
  const familyApi = apiJoin(scope.apiPrefix, item.id)
  const names = autogrowNames(spec)
  const state = scope.stateOf(family)
  const persisted = state?.members ?? []
  const isConnected =
    side === 'input'
      ? (port: string, members: readonly string[]) => ctx.connectivity.isInputConnected(port, members)
      : (port: string, members: readonly string[]) => ctx.connectivity.isOutputConnected(port, members)

  if (spec.template.length === 0) {
    ctx.report(
      'warning',
      'elab.autogrow.emptyTemplate',
      `${ctx.nodeType}.${family}: autogrow template has no slots; family not elaborated`,
    )
    return
  }
  for (const slot of spec.template) {
    if (RESERVED_ID_CHARS.test(slot.id)) {
      ctx.report(
        'warning',
        'elab.id.reserved',
        `${ctx.nodeType}: autogrow template slot id '${slot.id}' contains reserved characters (safe set: letters, digits, '_', '-'); address/selector syntax may collide`,
      )
    }
  }

  if (persisted.length > names.max) {
    ctx.report(
      'warning',
      'elab.autogrow.overMax',
      `${ctx.nodeType}.${family}: ${persisted.length} members exceed the family cap of ${names.max}; extras will not compile`,
    )
  }

  // One member = one stamped group instance: every template slot is emitted
  // per member, sharing the member id and ordinal. Grouped templates get
  // per-slot display suffixes; single-slot families keep the bare name.
  const grouped = spec.template.length > 1

  const slotSpecOf = (slot: InputSpec, ordinal: number, ghost: boolean, base: string): InputSpec => ({
    ...slot,
    // A slot declared optional in the template stays optional even below
    // the member minimum (e.g. required image + optional mask per item).
    optional: ghost || ordinal >= names.min || slot.optional,
    displayName: grouped ? `${base}.${slot.displayName ?? slot.id}` : base,
    ...(item.section !== undefined ? { section: item.section } : {}),
    ...(item.tooltip !== undefined && slot.tooltip === undefined ? { tooltip: item.tooltip } : {}),
  })

  // Ancestry/origin ordinals report the MERGED position (local + offset) so
  // a forwarded family's instance members are truthfully numbered after the
  // definition prefix; min/max/cap checks stay local (hazard F2/F4).
  const ordinalOffset = spec.ordinalOffset ?? 0
  let ordinal = 0
  // Synthetic member ids emitted by THIS family occurrence, in order. Each
  // synthetic member's materialize frame carries all preceding synthetic
  // siblings (min-fill must persist with the ghost it precedes - the same
  // cumulation materializeFramesOf derives post-hoc for ports).
  const syntheticIds: string[] = []
  const outputMembers: string[] = []
  const emitMember = (memberId: string, ghost: boolean, synthetic: boolean): boolean => {
    if (!ctx.countMember()) return false
    const total = ordinal + ordinalOffset
    const generatedName = ordinal < names.max ? names.nameOf(ordinal) : `${item.id}[${total}]`
    const bare = !ghost && !synthetic ? state?.memberLabels?.[memberId] ?? generatedName : generatedName
    const base = displayJoin(scope.displayPrefix, bare)
    const memberApi =
      !ghost && ordinal < names.max && familyApi !== undefined ? joinValuePath(familyApi, names.nameOf(ordinal)) : undefined
    const origin: ElaboratedOrigin = { kind: 'member', construct: family, ordinal: total, ...(ghost ? { ghost: true } : {}) }
    const entry: DynamicAncestor = {
      construct: family,
      member: memberId as DynamicMemberId,
      ordinal: total,
      ...(ghost ? { ghost: true } : {}),
      ...(synthetic ? { synthetic: true } : {}),
    }
    // Everything a member stamps - static slots AND recursive constructs -
    // elaborates inside the member's scope: value keys stay family-rooted
    // ('items.sub'), the member id rides in scope.members, and nested state
    // resolves through the member's cursor (hazard N4).
    if (synthetic) syntheticIds.push(memberId)
    const child = ctx.memberScope(scope, entry, {
      valuePrefix: family,
      apiPrefix: memberApi,
      staticOrigin: origin,
      displayPrefix: base,
      frames: [
        ...(scope.frames ?? []),
        { construct: family, members: synthetic ? [...syntheticIds] : [memberId] },
      ],
    })
    for (const slot of spec.template) {
      const adjusted = slotSpecOf(slot, ordinal, ghost, base)
      if (slot.dynamic !== undefined) {
        // Recursive construct: route through the ordinary handler registry -
        // Autogrow-in-Autogrow is not a special case (hazard N4). Nested api
        // names are provisional ('items.item0.sub...') pending backend
        // support for nested dynamic naming.
        if (side === 'input') ctx.elaborateInputs([adjusted], child)
        else ctx.elaborateOutputs([toOutputSpec(adjusted, item as OutputSpec)], child)
        continue
      }
      // Static slot: the family owns its wire-name policy. Single-slot
      // families keep the backend's flat positional name ('images.image0');
      // grouped families use a provisional nested name ('items.item0.image')
      // until the backend finalizes group naming. Either way api names are
      // compiler output, never document identity.
      const port = joinValuePath(family, slot.id)
      const apiName = memberApi === undefined ? undefined : grouped ? joinValuePath(memberApi, slot.id) : memberApi
      if (side === 'input') {
        ctx.emit({ kind: 'input', address: { port }, ...(apiName !== undefined ? { apiName } : {}), spec: adjusted, origin }, child)
      } else {
        ctx.emit({
          kind: 'output', address: { port }, spec: toOutputSpec(adjusted, item as OutputSpec), origin,
          ...(spec.materialization === 'wire15' ? { backendId: `${family}.${memberId}` } : {}),
        }, child)
      }
    }
    if (side === 'output' && !ghost && !synthetic && ordinal < names.max && familyApi !== undefined) {
      outputMembers.push(memberId)
    }
    ordinal++
    return true
  }

  // Duplicate persisted ids are rejected at load (CO7); this guard keeps
  // elaboration deterministic even for state minted by a buggy command
  // (invariants do not re-validate dynamic state on every dispatch).
  const emitted = new Set<string>()
  for (const memberId of persisted) {
    if (emitted.has(memberId)) continue
    emitted.add(memberId)
    emitMember(memberId, false, false)
  }
  if (side === 'output') ctx.recordOutputMembers(family, outputMembers)

  // Synthesize deterministic members up to the declared minimum (fresh nodes
  // have no persisted state yet), then one trailing ghost while under cap.
  // Beneath a ghost ancestor the trailing affordance is suppressed: a ghost
  // outer member never emits an inner ghost tree, so every address has at
  // most ONE ghost ancestor and promotion is never ambiguous (hazard N3).
  // Synthesized members carry `synthetic` in their ancestry: they exist in
  // the interface but are not persisted, so documents must not link to them.
  // Exhaustion (CO7): the mintable member-ordinal space is bounded by what
  // the seq bump can SEE (15-digit suffixes). Offering an id above the cap
  // would let a persisted member and a later ghost share an address, so an
  // exhausted family stops growing instead.
  let fresh = nextMemberBase(state)
  const exhausted = (): boolean => {
    if (fresh <= MAX_MEMBER_ORDINAL) return false
    ctx.report(
      'warning',
      'elab.autogrow.idsExhausted',
      `${ctx.nodeType}.${family}: member id space exhausted (next ordinal ${fresh}); family cannot grow further`,
    )
    return true
  }
  while (ordinal < names.min && ordinal < names.max && fresh <= MAX_MEMBER_ORDINAL) emitMember(`m${fresh++}`, false, true)
  if (ordinal < names.max && !scope.ghost && !exhausted()) {
    const ghostId = `m${fresh}`
    // A connection on ANY slot of the ghost group promotes the whole group:
    // a connected "ghost" is persisted-in-waiting (command normalization
    // lags a frame at most); treat it as real so it never renders detached.
    // It stays `synthetic`: the compiler rejects the state if it is ever
    // committed instead of materialized (hazard N3). Promotion is a VIEW
    // affordance only - compile elaboration disables it (promoteGhosts:
    // false) so a dropped-at-lowering link can never conjure an api-visible
    // member.
    const promoted =
      ctx.promoteGhosts &&
      spec.template.some((slot) => isConnected(joinValuePath(family, slot.id), [...scope.members, ghostId]))
    const before = ctx.itemCount()
    const counted = emitMember(ghostId, !promoted, true)
    // A ghost that emitted NOTHING (template of only min-0 nested constructs:
    // no members, no min-fill, inner ghost suppressed beneath a ghost ancestor
    // by the single-ghost rule, hazard N3) would leave zero rows to interact
    // with. Replace it with an explicit growth affordance: activating it
    // materializes the offered member (with its min-fill siblings), after
    // which the member's inner families ghost normally.
    if (counted && ctx.itemCount() === before) {
      // Nested families arrive with displayName rewritten to the parent
      // member's base ('item0'); the authored slot id plus the member-scoped
      // prefix is the truthful label there ('item0.sub').
      const label =
        scope.displayPrefix === undefined ? (item.displayName ?? item.id) : `${scope.displayPrefix}.${item.id}`
      ctx.emit(
        {
          kind: 'growth',
          construct: family,
          side,
          label,
          frames: [...(scope.frames ?? []), { construct: family, members: [...syntheticIds] }],
          ...(item.section !== undefined ? { section: item.section } : {}),
        },
        scope,
      )
    }
  }
}

function elaborateCountBoundOutputFamily(
  ctx: ElabContext,
  item: OutputSpec,
  spec: CountBoundOutputAutogrowSpec,
  scope: ElabScope,
  outputMembers: Record<string, string[]>,
): void {
  const family = joinValuePath(scope.valuePrefix, item.id)
  if (spec.count.boundaryProjection?.fixed !== true && ctx.connectivity.isInputConnected(spec.count.input)) return
  const count = outputCountValueOf(spec, ctx.storedValues)
  const min = spec.naming.min ?? 0
  const max = spec.naming.kind === 'prefix' ? spec.naming.max ?? ctx.memberBudget : ctx.memberBudget
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    ctx.report('error', 'elab.outputFamily.badCount', `${ctx.nodeType}.${family}: count input '${spec.count.input}' must store a safe nonnegative integer`, family)
    return
  }
  if ((count as number) < min || (count as number) > max || (count as number) > ctx.memberBudget) {
    ctx.report('error', 'elab.outputFamily.countOutOfRange', `${ctx.nodeType}.${family}: count ${String(count)} is outside ${min}..${Math.min(max, ctx.memberBudget)}`, family)
    return
  }
  if (spec.template.length !== 1 || spec.template[0]!.dynamic !== undefined) {
    ctx.report('error', 'elab.outputFamily.badTemplate', `${ctx.nodeType}.${family}: count-bound output family must have one ordinary template slot`, family)
    return
  }
  const suffixes = Array.from({ length: count as number }, (_, index) => String(index))
  outputMembers[family] = suffixes
  for (const [ordinal, suffix] of suffixes.entries()) {
    if (!ctx.countMember()) return
    const slot = spec.template[0]!
    const member = suffix as DynamicMemberId
    const child: ElabScope = {
      ...scope,
      members: [...scope.members, member],
      ancestry: [...scope.ancestry, { construct: family, member, ordinal }],
      staticOrigin: { kind: 'member', construct: family, ordinal },
    }
    ctx.emit({
      kind: 'output',
      address: { port: family },
      spec: toOutputSpec({ ...slot, displayName: suffix }, item),
      origin: { kind: 'member', construct: family, ordinal },
      backendId: `${family}.${suffix}`,
    }, child)
  }
}

const autogrowHandler: DynamicKindHandler = {
  kind: 'autogrow',
  elaborateInput(ctx, item, dyn, scope) {
    elaborateAutogrowFamily(ctx, item, dyn as AutogrowSpec, scope, 'input')
  },
  elaborateOutput(ctx, item, dyn, scope) {
    // Symmetric with inputs for document-driven families: the template
    // contributes type/labels and persisted members become outputs.
    elaborateAutogrowFamily(ctx, item, dyn as AutogrowSpec, scope, 'output')
  },
}

// -- DynamicCombo -----------------------------------------------------------

const dynamicComboHandler: DynamicKindHandler = {
  kind: 'dynamicCombo',
  elaborateInput(ctx, item, dyn, scope) {
    const spec = dyn as DynamicComboSpec
    const construct = joinValuePath(scope.valuePrefix, item.id)
    const constructApi = apiJoin(scope.apiPrefix, item.id)
    const keys = spec.options.map((o) => o.key)

    if (spec.materialization === 'wire15') {
      const requested = scope.stateOf(construct)?.selected as unknown
      if (requested !== undefined && (typeof requested !== 'string' || !keys.includes(requested))) {
        ctx.report(
          'error',
          'prompt.bad_dynamic_choice',
          `${ctx.nodeType}.${construct}: dynamic choice must be one of ${keys.join(', ') || '(none)'}, received ${String(requested)}`,
          construct,
        )
        return
      }

      const selected = effectiveComboOption(spec, requested === undefined ? undefined : { selected: requested })
      const schemaDefault = effectiveComboOption(spec, undefined)
      const widget: WidgetSpec = {
        widgetType: 'COMBO',
        options: { options: keys },
        ...(schemaDefault !== undefined ? { default: schemaDefault } : {}),
      }
      ctx.emit(
        {
          kind: 'input',
          address: { port: construct },
          ...(constructApi !== undefined ? { apiName: constructApi } : {}),
          spec: { ...rekey(item, construct), widget },
          origin: {
            kind: 'selector',
            construct,
            ...(typeof requested === 'string' ? { selected: requested } : {}),
          },
          ...(selected !== undefined ? { derivedValue: selected } : {}),
        },
        { ...scope, wire15Materialization: true },
      )

      if (selected === undefined) return
      const active = spec.options.find((option) => option.key === selected)!
      ctx.elaborateInputs(active.inputs, {
        ...scope,
        valuePrefix: construct,
        apiPrefix: constructApi,
        staticOrigin: { kind: 'branch', construct, option: selected },
        stateOf: (path) => ctx.dynamicState[path],
        wire15Materialization: true,
      })
      return
    }

    if (keys.length === 0) {
      ctx.report('warning', 'elab.combo.empty', `${ctx.nodeType}.${construct}: DynamicCombo has no options`)
    }

    const state = scope.stateOf(construct)
    const requested = state?.selected
    const selected = effectiveComboOption(spec, state)
    if (requested !== undefined && !keys.includes(requested)) {
      ctx.report(
        'warning',
        'elab.combo.unknownOption',
        `${ctx.nodeType}.${construct}: selected option '${requested}' is not in the schema; falling back to '${selected ?? ''}'`,
      )
    }

    // The construct itself renders as a COMBO widget over the option keys.
    // Its value is dynamic state (state.selected), surfaced as derivedValue -
    // NEVER node.values - so branch switching stays a single-home state
    // transition commands own.
    // The widget's `default` is the STATE-FREE schema answer (defaultOption
    // or first key), never the current selection: "reset widget" must return
    // to the schema default, not freeze whatever happens to be selected.
    const schemaDefault = effectiveComboOption(spec, undefined)
    const widget: WidgetSpec = {
      widgetType: 'COMBO',
      options: { options: keys },
      ...(schemaDefault !== undefined ? { default: schemaDefault } : {}),
    }
    ctx.emit(
      {
        kind: 'input',
        address: { port: construct },
        ...(constructApi !== undefined ? { apiName: constructApi } : {}),
        spec: { ...rekey(item, construct), widget },
        origin: { kind: 'selector', construct },
        ...(selected !== undefined ? { derivedValue: selected } : {}),
      },
      scope,
    )

    const active = spec.options.find((o) => o.key === selected)
    if (!active) return
    // Branch-local scope: values keyed under `construct.[option].`, api names
    // under `construct.` (backend strips the option - it knows it from the
    // selector's value). Inactive branches elaborate to NOTHING but their
    // values stay in the document untouched - switching back restores them.
    // Spread: member path/cursor/ghostness ride along unchanged (hazard N4).
    ctx.elaborateInputs(active.inputs, {
      ...scope,
      valuePrefix: comboBranchValuePath(construct, active.key),
      apiPrefix: constructApi,
      staticOrigin: { kind: 'branch', construct, option: active.key },
    })
  },
}

// -- DynamicSlot ------------------------------------------------------------

const dynamicSlotHandler: DynamicKindHandler = {
  kind: 'dynamicSlot',
  elaborateInput(ctx, item, dyn, scope) {
    const spec = dyn as DynamicSlotSpec
    const construct = joinValuePath(scope.valuePrefix, item.id)
    const constructApi = apiJoin(scope.apiPrefix, item.id)
    const state = scope.stateOf(construct)
    const selectedVariant = spec.variants?.find((variant) => variant.key === state?.selected)

    if (spec.materialization === 'wire15') {
      if (spec.variants === undefined) {
        const wire15Scope: ElabScope = { ...scope, wire15Materialization: true }
        ctx.emit(
          {
            kind: 'input', address: { port: construct }, ...(constructApi !== undefined ? { apiName: constructApi } : {}),
            spec: { ...rekey(item, construct), type: spec.slotType, optional: true, ...(spec.forceInput ? { forceInput: true } : {}) },
            origin: { kind: 'slot', construct },
          },
          wire15Scope,
        )
        const active = Object.prototype.hasOwnProperty.call(ctx.storedValues, elabKeyOf({ port: construct, ...(scope.members.length > 0 ? { members: scope.members } : {}) })) ||
          ctx.connectivity.isInputConnected(construct, scope.members)
        if (active) {
          ctx.elaborateInputs(spec.inputs, {
            ...wire15Scope,
            valuePrefix: construct,
            apiPrefix: constructApi,
            staticOrigin: { kind: 'dependent', construct },
            stateOf: (path) => ctx.dynamicState[path],
          })
        } else if (ctx.inputEvidence.some((key) => key.startsWith(`${construct}.`))) {
          ctx.report(
            'error',
            'compile.value.unknownInput',
            `${ctx.nodeType}.${construct}: stored dependents exist beneath an inactive open slot`,
            construct,
          )
        }
        return
      }

      const requested = state?.selected as unknown
      if (requested === undefined) {
        if (item.optional === false) {
          ctx.report(
            'error',
            'prompt.bad_dynamic_choice',
            `${ctx.nodeType}.${construct}: required dynamic slot must name a declared variant`,
            construct,
          )
        }
        return
      }
      if (typeof requested !== 'string' || selectedVariant === undefined) {
        ctx.report(
          'error',
          'prompt.bad_dynamic_choice',
          `${ctx.nodeType}.${construct}: dynamic choice must name a declared variant, received ${String(requested)}`,
          construct,
        )
        return
      }
      ctx.emit(
        {
          kind: 'input', address: { port: construct }, ...(constructApi !== undefined ? { apiName: constructApi } : {}),
          spec: { ...rekey(item, construct), type: selectedVariant.type, optional: false },
          origin: {
            kind: 'slot', construct,
            variants: spec.variants.map(({ key, type }) => ({ key, type })),
            selected: requested,
            ...(spec.typeTemplateId !== undefined ? { typeTemplateId: spec.typeTemplateId } : {}),
          },
        },
        { ...scope, wire15Materialization: true },
      )
      ctx.elaborateInputs([...spec.inputs, ...selectedVariant.inputs], {
        ...scope,
        valuePrefix: construct,
        apiPrefix: constructApi,
        staticOrigin: { kind: 'dependent', construct, variant: requested },
        stateOf: (path) => ctx.dynamicState[path],
        wire15Materialization: true,
      })
      return
    }

    ctx.emit(
      {
        kind: 'input',
        address: { port: construct },
        ...(constructApi !== undefined ? { apiName: constructApi } : {}),
        spec: {
          ...rekey(item, construct),
          type: spec.slotType,
          // Native wire v6 slots carry required-ness; the compat parser
          // always builds them optional, so nothing changes there.
          optional: item.optional,
          ...(spec.forceInput ? { forceInput: true } : {}),
        },
        origin: {
          kind: 'slot',
          construct,
          ...(spec.variants ? { variants: spec.variants.map(({ key, type }) => ({ key, type })) } : {}),
          ...(spec.variants && state?.selected !== undefined ? { selected: state.selected } : {}),
          ...(spec.typeTemplateId !== undefined ? { typeTemplateId: spec.typeTemplateId } : {}),
        },
      },
      scope,
    )

    // Dependents exist while the slot is CONNECTED (link existence, not
    // type-checked drivenness). Disconnecting hides them - values and nested
    // dynamic state persist untouched, so reconnecting restores everything.
    // The slot's identity includes the member path it lives under.
    if (!ctx.connectivity.isInputConnected(construct, scope.members)) return
    ctx.elaborateInputs(spec.inputs, {
      ...scope,
      valuePrefix: construct,
      apiPrefix: constructApi,
      staticOrigin: { kind: 'dependent', construct },
    })
    if (spec.variants && state?.selected !== undefined && !selectedVariant) {
      ctx.report('warning', 'elab.slot.unknownVariant', `${ctx.nodeType}.${construct}: selected variant '${state.selected}' is not in the schema; using the base form`)
      return
    }
    if (!selectedVariant) return
    // Variant identities differ per side, per the SETTLED backend contract
    // (Dinkster c2ac572, schema wire v6): document value keys use the bracket
    // branch syntax ('slot.[key].x', like combo branches, so switching
    // variants never reinterprets stored values) but wire ids are
    // CONSTRUCT-LOCAL ('slot.x') - the choice does not travel per-input; it
    // travels once per node as the graph wire's 'slotVariants' object, and
    // only the active variant elaborates, so locals stay unique. The one
    // hazard is frontend-modeled shared dependents (the native wire has
    // none): a variant local reusing a shared dependent's id would collide
    // in api space, so it is skipped loudly instead of silently clobbering.
    const sharedIds = new Set(spec.inputs.map((shared) => shared.id))
    const variantInputs = selectedVariant.inputs.filter((dep) => {
      if (!sharedIds.has(dep.id)) return true
      ctx.report(
        'warning',
        'elab.slot.shadowedDependent',
        `${ctx.nodeType}.${construct}: variant '${selectedVariant.key}' input '${dep.id}' collides with a shared dependent under construct-local wire naming; variant input not elaborated`,
      )
      return false
    })
    ctx.elaborateInputs(variantInputs, {
      ...scope,
      valuePrefix: comboBranchValuePath(construct, selectedVariant.key),
      apiPrefix: constructApi,
      staticOrigin: { kind: 'dependent', construct, variant: selectedVariant.key },
    })
  },
}

/** Built-in handlers. Spread into a custom registry to extend. */
export const defaultDynamicHandlers: Readonly<Record<string, DynamicKindHandler>> = {
  autogrow: autogrowHandler,
  dynamicCombo: dynamicComboHandler,
  dynamicSlot: dynamicSlotHandler,
}

// ---------------------------------------------------------------------------
// Elaboration driver
// ---------------------------------------------------------------------------

/**
 * Hard elaboration budgets (hazard N5): nested family caps multiply
 * (10^depth), so the elaborator fails DETERMINISTICALLY - declared/member
 * order, one error, clean stop - instead of doing exponential work and
 * warning afterwards. Exhaustion is a schema/state bug, not a soft limit:
 * bump deliberately, never silently.
 */
export interface ElabBudget {
  /** Max dynamic-construct nesting depth (combo/slot/family levels). */
  readonly maxDepth: number
  /** Max emitted interface items (ports + sections). */
  readonly maxItems: number
  /** Max dynamic family members visited across the whole node. */
  readonly maxMembers: number
}

export const DEFAULT_ELAB_BUDGET: ElabBudget = {
  maxDepth: 16,
  maxItems: 1024,
  maxMembers: 512,
}

export interface ElaborateOptions {
  /** Dynamic-kind registry; defaults to the built-ins. */
  readonly handlers?: Readonly<Record<string, DynamicKindHandler>>
  /** Hard budget overrides (tests / pathological-schema tooling). */
  readonly budget?: Partial<ElabBudget>
  /**
   * Promote a connected trailing ghost to a real (but synthetic) member.
   * Defaults to true - the VIEW affordance: a just-connected ghost renders
   * attached while command normalization persists it (a frame at most).
   * The COMPILER passes false: a normalized document never depends on
   * promotion, and honoring it would let a persisted link whose lowering is
   * later dropped (muted endpoint, undriven reroute) conjure an api-visible
   * member that leaks values/defaults or shifts output wire indexes.
   */
  readonly promoteGhosts?: boolean
  /** Node identity for document-validation diagnostics. */
  readonly nodeId?: NodeId
}

/**
 * Reserved in structural ids (slot/family ids that appear inside address
 * paths and selector strings). In use today: '.' (path segments), '[', ']',
 * '#' (elaborated keys). The rest are reserved AHEAD of need so future
 * selector/address syntax never collides with shipped schemas: '*', '?',
 * '!' (globs/negation), ',', '|' (list separators/unions), ':'
 * (namespacing), '@' (references), '$', '{', '}' (substitution), '/',
 * '\\' (alternate separators/escape), quotes and backtick (quoting in any
 * future DSL), '<', '>' (type-constructor syntax in canonical runtime type
 * ids, e.g. Dinkster's list<core.int> - schema wire v2), and whitespace
 * (ambiguous everywhere). Ids matching [A-Za-z0-9_-]+ are guaranteed never
 * to collide with address syntax.
 */
const RESERVED_ID_CHARS = /[.[\]#*?!,|:@${}/\\"'`<>\s]/

/**
 * Elaborate one node's effective interface. Pure and deterministic over
 * (schema, node.values/node.dynamic, connectivity) - memoize on those.
 */
export function elaborateInterface(
  schema: NodeSchema,
  node: Pick<NodeData, 'values' | 'dynamic'>,
  connectivity: Connectivity = EMPTY_CONNECTIVITY,
  options: ElaborateOptions = {},
): ElaboratedInterface {
  const handlers = options.handlers ?? defaultDynamicHandlers
  const budget: ElabBudget = { ...DEFAULT_ELAB_BUDGET, ...options.budget }
  const items: ElaboratedItem[] = []
  const submissionValues: { path: string; apiPath: string; value: Json }[] = []
  const outputMembers: Record<string, string[]> = {}
  const diagnostics: Diagnostic[] = []
  let depth = 0
  let membersVisited = 0
  const emittedInputKeys = new Set<string>()
  const wire15InputKeys = new Set<string>()
  const emittedApiNames = new Set<string>()
  const wire15ApiNames = new Set<string>()
  const submittedPaths = new Set<string>()
  const submittedApiPaths = new Set<string>()
  /** Once a budget trips, elaboration stops emitting - one error, no partial recursion. */
  let halted = false
  const wire15Construct = schema.items.find((item): item is InputSpec =>
    item.kind === 'input' && item.dynamic?.materialization === 'wire15')
  const hasWire15 = wire15Construct !== undefined
  const inputEvidence = hasWire15 ? [
    ...Object.keys(node.values),
    ...(connectivity.inputPorts?.() ?? []),
    ...Object.keys(node.dynamic ?? {}),
  ] : []
  if (hasWire15 && inputEvidence.length > budget.maxItems) {
    diagnostics.push(diag('error', 'schema', 'elab.budget.items', `elaboration input evidence exceeds the ${budget.maxItems}-item budget`))
    halted = true
  }
  const exhaust = (code: string, message: string): void => {
    if (halted) return
    halted = true
    diagnostics.push(diag('error', 'schema', code, `${schema.type}: ${message}`))
  }

  const ctx: ElabContext = {
    nodeType: schema.type,
    storedValues: node.values,
    dynamicState: node.dynamic ?? {},
    inputEvidence,
    memberBudget: budget.maxMembers,
    connectivity,
    promoteGhosts: options.promoteGhosts ?? true,
    emit: (item, scope) => {
      if (halted) return
      if (items.length >= budget.maxItems) {
        exhaust('elab.budget.items', `elaborated interface exceeds ${budget.maxItems} items; elaboration stopped`)
        return
      }
      if (item.kind === 'section' || item.kind === 'growth') {
        items.push(item)
        return
      }
      // Central scoped emission (hazard N4): bind identity and ghost policy
      // here so no handler can emit an out-of-scope address or compile a
      // ghost descendant.
      const address: PortAddress =
        scope.members.length > 0 ? { port: item.address.port, members: scope.members } : { port: item.address.port }
      const id = elabKeyOf(address)
      const ancestry = scope.ancestry.length > 0 ? { ancestry: scope.ancestry } : {}
      // Fast path: an already-canonical spec (right id, no construct, not
      // ghosted) is emitted without cloning - top-level statics stay
      // allocation-free.
      const canonical = item.spec.id === id && item.spec.dynamic === undefined
      if (item.kind === 'input') {
        if (((scope.wire15Materialization || wire15InputKeys.has(id)) && emittedInputKeys.has(id)) || submittedPaths.has(id)) {
          exhaust('elab.projectedNamespaceCollision', `projected input namespace collision at '${id}'`)
          return
        }
        emittedInputKeys.add(id)
        if (scope.wire15Materialization) wire15InputKeys.add(id)
        const { apiName: _apiName, ...rest } = item
        const apiName = scope.ghost ? undefined : item.apiName
        if (apiName !== undefined) {
          if (((scope.wire15Materialization || wire15ApiNames.has(apiName)) && emittedApiNames.has(apiName)) || submittedApiPaths.has(apiName)) {
            exhaust('elab.projectedNamespaceCollision', `projected input API namespace collision at '${apiName}'`)
            return
          }
          emittedApiNames.add(apiName)
          if (scope.wire15Materialization) wire15ApiNames.add(apiName)
        }
        const spec =
          canonical && (!scope.ghost || item.spec.optional)
            ? item.spec
            : stripDynamic({ ...item.spec, id, ...(scope.ghost ? { optional: true } : {}) })
        items.push({
          ...rest,
          ...(apiName !== undefined ? { apiName } : {}),
          address,
          spec,
          ...ancestry,
          ...(scope.wire15MaterializeFrames !== undefined
            ? { materialize: scope.wire15MaterializeFrames }
            : {}),
          ...(scope.wire15Materialization ? { wire15Materialization: true as const } : {}),
        })
      } else {
        const spec = canonical ? item.spec : stripDynamic({ ...item.spec, id })
        // Output-side wireability mirrors the input apiName policy and is
        // decided HERE, from the scope, so no handler can leak a ghost/
        // over-cap/unknown output into wire indexing. Synthetic
        // minimum members remain a view affordance but never enter compile
        // indexes until a command persists them.
        const wireable =
          !scope.ghost &&
          (ctx.promoteGhosts || !scope.ancestry.some((entry) => entry.synthetic)) &&
          scope.apiPrefix !== undefined &&
          item.origin.kind !== 'unknown'
        items.push({
          ...item,
          address,
          spec,
          ...ancestry,
          ...(scope.wire15MaterializeFrames !== undefined
            ? { materialize: scope.wire15MaterializeFrames }
            : {}),
          ...(wireable ? {} : { wireable: false as const }),
        })
      }
    },
    elaborateInputs: (inputs, scope) => {
      if (halted) return
      depth++
      if (depth > budget.maxDepth) {
        exhaust('elab.budget.depth', `dynamic nesting exceeds ${budget.maxDepth} levels; elaboration stopped`)
      } else {
        for (const input of inputs) {
          if (halted) break
          elaborateInput(input, scope)
        }
      }
      depth--
    },
    elaborateOutputs: (outputs, scope) => {
      if (halted) return
      depth++
      if (depth > budget.maxDepth) {
        exhaust('elab.budget.depth', `dynamic nesting exceeds ${budget.maxDepth} levels; elaboration stopped`)
      } else {
        for (const out of outputs) {
          if (halted) break
          elaborateOutput(out, scope)
        }
      }
      depth--
    },
    memberScope: (parent, entry, frame) => {
      // Ghost members expose NO nested state: nothing beneath a ghost is
      // persisted (hazard N3) - a stray memberState entry under a ghost id
      // is unreachable by construction rather than half-honored.
      const nested = entry.ghost ? undefined : parent.stateOf(entry.construct)?.memberState?.[entry.member]
      return {
        valuePrefix: frame.valuePrefix,
        apiPrefix: frame.apiPrefix,
        ...(frame.staticOrigin !== undefined ? { staticOrigin: frame.staticOrigin } : {}),
        members: [...parent.members, entry.member],
        ancestry: [...parent.ancestry, entry],
        ghost: parent.ghost || entry.ghost === true,
        stateOf: (construct) => nested?.[construct],
        ...(frame.displayPrefix !== undefined ? { displayPrefix: frame.displayPrefix } : {}),
        ...(frame.frames !== undefined ? { frames: frame.frames } : {}),
      }
    },
    countMember: () => {
      if (halted) return false
      if (membersVisited >= budget.maxMembers) {
        exhaust('elab.budget.members', `dynamic members exceed ${budget.maxMembers}; elaboration stopped`)
        return false
      }
      membersVisited++
      return true
    },
    itemCount: () => items.length,
    recordOutputMembers: (family, members) => {
      outputMembers[family] = [...members]
    },
    submitValue: (path, apiPath, value) => {
      if (submittedPaths.has(path) || submittedApiPaths.has(apiPath) || emittedInputKeys.has(path) || emittedApiNames.has(apiPath)) {
        exhaust('elab.projectedNamespaceCollision', `projected selector namespace collision at '${path}'`)
        return
      }
      submittedPaths.add(path)
      submittedApiPaths.add(apiPath)
      submissionValues.push({ path, apiPath, value })
    },
    report: (severity, code, message, port) => {
      diagnostics.push(diag(severity, 'schema', code, message, {
        ...(options.nodeId !== undefined && port !== undefined
          ? { anchor: { port: { node: options.nodeId, port: asPortId(port) } } }
          : {}),
      }))
    },
  }

  const checkId = (id: string, where: string): void => {
    if (RESERVED_ID_CHARS.test(id)) {
      ctx.report('warning', 'elab.id.reserved', `${schema.type}: ${where} id '${id}' contains reserved characters (safe set: letters, digits, '_', '-'); address/selector syntax may collide`)
    }
  }

  const elaborateInput = (item: InputSpec, scope: ElabScope): void => {
    checkId(item.id, 'input')
    if (!item.dynamic) {
      const port = joinValuePath(scope.valuePrefix, item.id)
      const apiName = apiJoin(scope.apiPrefix, item.id)
      let effective = item
      const widget = item.widget
      const source = widget?.optionSource
      if (widget !== undefined && source !== undefined) {
        const family = joinValuePath(scope.valuePrefix, source.inputFamily)
        const familyState = scope.stateOf(family)
        const members = familyState?.members ?? []
        const labels = members.map((member) => familyState?.memberLabels?.[member] ?? member)
        const duplicateLabels = new Set(labels.filter((label, index) => labels.indexOf(label) !== index))
        const options = members.map((member, index) => ({
          value: member,
          label: duplicateLabels.has(labels[index]!) ? `${labels[index]} (${member})` : labels[index]!,
        }))
        effective = {
          ...item,
          widget: {
            ...widget,
            optionSource: { inputFamily: family },
            options: { ...widget.options, options },
          },
        }
      }
      ctx.emit(
        {
          kind: 'input',
          address: { port },
          ...(apiName !== undefined ? { apiName } : {}),
          spec: rekey(effective, port),
          origin: scope.staticOrigin ?? { kind: 'static' },
        },
        scope,
      )
      return
    }
    const handler = handlers[item.dynamic.kind]
    if (!handler) {
      emitUnknown(item, scope)
      return
    }
    handler.elaborateInput(ctx, item, item.dynamic, scope)
  }

  const elaborateOutput = (item: OutputSpec, scope: ElabScope): void => {
    checkId(item.id, 'output')
    if (item.outputDescriptors !== undefined) {
      const spec = item.outputDescriptors
      const sourceLinked = !spec.boundaryProjection?.fixed && connectivity.isInputConnected(spec.input)
      const assetLinked = spec.probe && !spec.boundaryProjection?.assetFixed && connectivity.isInputConnected(spec.probe.input)
      if (sourceLinked || assetLinked) {
        ctx.report('error', 'elab.outputDescriptors.linkedSource', 'Output descriptor sources must be stored literals, not links.', spec.input)
        return
      }
      const result = parseOutputDescriptors(spec, outputDescriptorValueOf(spec, node.values), outputDescriptorAssetOf(spec, node.values))
      if (!result.ok) {
        ctx.report('error', 'elab.outputDescriptors.invalid', result.error, spec.input)
        return
      }
      const entries = spec.selectedId === undefined ? result.document.entries : result.document.entries.filter((entry) => entry.id === spec.selectedId)
      if (spec.selectedId !== undefined && entries.length === 0) {
        ctx.report('error', 'elab.outputDescriptors.missingEntry', `Output '${spec.selectedId}' is absent from the current descriptors. Repair its boundary binding.`, spec.input)
      }
      const ids = entries.map((entry) => spec.selectedId === undefined ? entry.id : item.id)
      const collision = ids.find((id) => schema.items.some((other) => other.kind === 'output' && other !== item && other.id === id) ||
        items.some((other) => other.kind === 'output' && other.address.port === id))
      if (collision !== undefined) {
        ctx.report('error', 'elab.outputDescriptors.collision', `Output '${collision}' collides with another output or family.`, spec.input)
        return
      }
      for (const [index, entry] of entries.entries()) {
        if (!ctx.countMember()) return
        const choice = spec.choices.find((candidate) => candidate.id === entry.type)!
        const id = ids[index]!
        let type: TypeExpr = choice.type
        let projected = item.type
        while (spec.selectedId !== undefined && projected.kind === 'list') {
          type = { kind: 'list', element: type }
          projected = projected.element
        }
        ctx.emit({
          kind: 'output', address: { port: id }, backendId: id,
          spec: {
            kind: 'output', id, type, displayName: entry.name,
            ...(choice.optional !== undefined ? { optional: choice.optional } : {}),
            ...(choice.preview !== undefined ? { preview: choice.preview } : {}),
            ...(choice.doc !== undefined ? { tooltip: choice.doc } : {}),
            ...(choice.alphaPolicy !== undefined ? { alphaPolicy: choice.alphaPolicy } : {}),
            ...(choice.maskPolarity !== undefined ? { maskPolarity: choice.maskPolarity } : {}),
            ...(choice.maskSemantic !== undefined ? { maskSemantic: choice.maskSemantic } : {}),
          },
          origin: { kind: 'static' },
        }, scope)
      }
      return
    }
    if (!item.dynamic) {
      const port = joinValuePath(scope.valuePrefix, item.id)
      ctx.emit(
        {
          kind: 'output',
          address: { port },
          spec: rekey(item, port),
          origin: scope.staticOrigin ?? { kind: 'static' },
        },
        scope,
      )
      return
    }
    if (item.dynamic.kind === 'autogrow' && 'count' in item.dynamic) {
      elaborateCountBoundOutputFamily(ctx, item, item.dynamic, scope, outputMembers)
      return
    }
    const handler = handlers[item.dynamic.kind]
    if (!handler?.elaborateOutput) {
      ctx.report(
        'warning',
        'elab.dynamic.unsupportedOnOutput',
        `${schema.type}.${item.id}: dynamic kind '${item.dynamic.kind}' is not supported on outputs; port elaborated as inert`,
      )
      const construct = joinValuePath(scope.valuePrefix, item.id)
      ctx.emit(
        {
          kind: 'output',
          address: { port: construct },
          spec: rekey(item, construct),
          origin: { kind: 'unknown', construct },
        },
        scope,
      )
      return
    }
    handler.elaborateOutput(ctx, item, item.dynamic, scope)
  }

  const emitUnknown = (item: InputSpec, scope: ElabScope): void => {
    const construct = joinValuePath(scope.valuePrefix, item.id)
    ctx.report(
      'warning',
      'elab.dynamic.unknownKind',
      `${schema.type}.${construct}: unknown dynamic kind '${item.dynamic!.kind}'; port elaborated as inert`,
    )
    ctx.emit(
      {
        kind: 'input',
        address: { port: construct },
        spec: rekey(item, construct),
        origin: { kind: 'unknown', construct },
      },
      scope,
    )
  }

  const topScope: ElabScope = {
    valuePrefix: '',
    apiPrefix: '',
    members: [],
    ancestry: [],
    ghost: false,
    stateOf: (construct) => node.dynamic?.[construct],
  }
  for (const input of outputCountInputsOf(schema)) {
    if (connectivity.isInputConnected(input)) {
      ctx.report('error', 'elab.outputFamily.linkedCount', `${schema.type}: output count input '${input}' must be a stored literal, not a link`, input)
    }
  }
  for (const item of schema.items) {
    if (halted) break
    if (item.kind === 'section') {
      // Through emit so sections count against maxItems like everything else.
      ctx.emit({ kind: 'section', spec: item }, topScope)
      continue
    }
    if (item.kind === 'input') elaborateInput(item, topScope)
    else elaborateOutput(item, topScope)
  }

  const chunkSafe = schema.chunkSafe
  const covered = chunkSafe?.applies === undefined || Object.entries(chunkSafe.applies).every(([id, keys]) => {
    const combo = schema.items.find((item) => item.kind === 'input' && item.id === id)
    if (combo?.kind !== 'input' || combo.dynamic?.kind !== 'dynamicCombo') return false
    const selected = effectiveComboOption(combo.dynamic, node.dynamic?.[id])
    return selected !== undefined && keys.includes(selected)
  })
  if (chunkSafe && !covered) {
    for (const [index, item] of items.entries()) {
      if (item.kind !== 'input' || !chunkSafe.inputs.includes(item.address.port) || !item.spec.acceptsStream) continue
      const { acceptsStream: _, ...spec } = item.spec
      items[index] = { ...item, spec }
    }
  }
  return {
    items,
    submissionValues,
    ...(chunkSafe && covered ? { chunkSafe: {
      inputs: chunkSafe.inputs.filter((id) => items.some((item) => item.kind === 'input' && item.apiName === id)),
      outputs: chunkSafe.outputs,
    } } : {}),
    ...(Object.keys(outputMembers).length > 0 ? { outputMembers } : {}),
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Materialization frames (the bridge from an elaborated ghost to commands)
// ---------------------------------------------------------------------------

/** One level of a `dynamic.materialize` invocation's `frames` param. */
export interface MaterializeFrame {
  /** Family construct value key (path form), as persisted in NodeData.dynamic. */
  readonly construct: string
  /** Member ids to persist at this level, in interface order; the LAST one is the descent chain. */
  readonly members: readonly string[]
}

/** Scope key for grouping family occurrences: the (construct, member) chain above them. */
const scopeKeyOf = (ancestry: readonly DynamicAncestor[]): string =>
  ancestry.map((a) => `${escapeElabSeg(a.construct)}@${escapeElabSeg(a.member as string)}`).join('#')

/**
 * Derive the `dynamic.materialize` frames that make `target`'s address
 * persistable: every synthetic ancestor plus - at each synthetic level -
 * the synthetic SIBLINGS that elaborate before it in the same family
 * (min-fill members must persist with the ghost they precede, or their
 * ids/values would silently re-mint on the next elaboration). Returns
 * undefined when nothing on the path is synthetic (already persisted).
 *
 * Callers batch the resulting invocation with the action that grows the
 * family (link.connect, node.setValue, dynamic.selectOption) so
 * materialization is atomic with its cause - hazard N3's "commands
 * materialize on write". `items` must be the SAME elaborated interface the
 * target came from.
 */
export function materializeFramesOf(
  items: readonly ElaboratedItem[],
  target: ElaboratedInput | ElaboratedOutput,
): readonly MaterializeFrame[] | undefined {
  if (target.materialize !== undefined) return target.materialize
  const ancestry = target.ancestry
  if (ancestry === undefined || !ancestry.some((a) => a.synthetic)) return undefined

  // Synthetic member ids per family occurrence, in first-appearance
  // (= elaboration = family) order. Keyed by the full ancestor chain so two
  // families that happen to share member ids can never bleed together.
  const synthetics = new Map<string, string[]>()
  for (const it of items) {
    if (it.kind === 'section' || it.kind === 'growth' || it.ancestry === undefined) continue
    for (let k = 0; k < it.ancestry.length; k++) {
      const a = it.ancestry[k]!
      if (!a.synthetic) continue
      const key = `${scopeKeyOf(it.ancestry.slice(0, k))}|${a.construct}`
      let list = synthetics.get(key)
      if (!list) synthetics.set(key, (list = []))
      if (!list.includes(a.member as string)) list.push(a.member as string)
    }
  }

  return ancestry.map((a, k) => {
    if (!a.synthetic) return { construct: a.construct, members: [a.member as string] }
    const key = `${scopeKeyOf(ancestry.slice(0, k))}|${a.construct}`
    const list = synthetics.get(key) ?? [a.member as string]
    const idx = list.indexOf(a.member as string)
    return { construct: a.construct, members: list.slice(0, idx === -1 ? list.length : idx + 1) }
  })
}
