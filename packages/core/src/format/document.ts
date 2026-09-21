/**
 * Workflow document format v1. THE authoritative serialized format.
 *
 * Design rules (from the architecture plan, section 16):
 * - One format. The API prompt is compiler *output*, never authored.
 * - Values are keyed by schema input id - never positional arrays.
 * - Semantic state (what executes) and view state (how it looks) are separate
 *   subtrees, so the execution-semantic hash covers exactly `graphs` + the
 *   semantic parts of nodes, and layout edits never dirty it.
 * - Subgraphs are definitions + instances by reference. Copies stay synced by
 *   sharing the definition; detach clones it.
 * - Named nets are first-class hyperedges scoped to one graph definition.
 * - Extensions get a namespaced escape hatch (`ext`) at every level; unknown
 *   data round-trips untouched.
 * - `formatVersion` + migration pipeline: old documents are migrated forward
 *   on load, one version step at a time.
 */

import type {
  ControlSurfaceId,
  DynamicMemberId,
  GraphDefId,
  LineageId,
  LinkEndpoint,
  LinkId,
  NetId,
  NodeId,
  OccurrenceRef,
  PortId,
  PortRef,
  RerouteId,
  SelectorCandidateId,
  SelectorId,
  ValueSourceId,
} from '../ids.js'

/** JSON-serializable value. The document contains nothing else. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject
export interface JsonObject {
  readonly [key: string]: Json
}

/** Namespaced extension data: key = extension id (e.g. 'vhs'). */
export type ExtData = Readonly<Record<string, Json>>

/**
 * Current document format version.
 *
 * Pre-release policy: v1 is UNSTABLE until the first public release; breaking
 * shape changes revise v1 in place (fixtures/tests updated) rather than
 * minting versions that only ever existed inside this repo. The migration
 * chain (migrate.ts) starts at the first released version; until then the
 * pipeline is kept honest by synthetic-step tests over the full load path.
 */
export const FORMAT_VERSION = 1

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Execution-affecting node mode. Plain document state, changed via commands. */
export type NodeMode = 'active' | 'muted' | 'bypassed'

/**
 * Live sampling preview spend (backend PR #407): off disables previews,
 * cheap uses the latent projection, quality uses a decoder model when one
 * is available, auto lets the server pick. Stored on documents and nodes
 * as an OVERRIDE (absent = inherit); the app's global setting is the
 * outermost default. Never part of execution semantics: preview modes
 * change what the run streams, not what it computes.
 */
export type PreviewMode = 'off' | 'cheap' | 'quality' | 'auto'
export const PREVIEW_MODES: readonly PreviewMode[] = ['off', 'cheap', 'quality', 'auto']

/**
 * Value-controller state (control_after_generate and kin). First-class
 * structured state keyed by input id - NEVER a phantom positional widget.
 */
export type ControllerMode = 'fixed' | 'increment' | 'decrement' | 'randomize'

/**
 * Hard nesting budget for member-scoped dynamic state: one level per family
 * crossed. Matches the elaborator's depth budget - state nested deeper than
 * the elaborator would ever read is malformed. Both the runtime validator
 * (validate.ts) and the published JSON Schema (schema.ts, via bounded
 * unrolling) enforce the same cap so the two never disagree on validity.
 */
export const MAX_DYNAMIC_STATE_DEPTH = 16

/**
 * Dynamic-interface state a node needs to persist so its elaborated interface
 * is reproducible: which members exist in each autogrow family (ids stable
 * across regrowth), which schema-authored dynamic choice is selected, etc.
 * Keyed by the schema port id of the dynamic construct.
 */
export interface DynamicPortState {
  /** Ordered member ids for an autogrow family. */
  readonly members?: readonly string[]
  /** Presentation-only labels keyed by stable member id. */
  readonly memberLabels?: Readonly<Record<string, string>>
  /**
   * Next fresh member ordinal for this family (command-maintained). Keeps
   * member ids from ever being recycled after removal - elaboration mints
   * fresh ids from max(seq, highest used suffix + 1).
   */
  readonly seq?: number
  /** Selected schema-authored choice (DynamicCombo option or DynamicSlot variant). */
  readonly selected?: string
  /**
   * Nested dynamic state scoped to ONE family member (hazard N1/N4): keyed
   * by member id, then by the nested construct's value key (the same key the
   * construct would use at node top level, e.g. 'items.sub'). Member-ID
   * keyed - never array-indexed - so reordering/removing members never moves
   * another member's nested state. Ghost members have no entry by
   * construction (nothing beneath a ghost is persisted, hazard N3).
   */
  readonly memberState?: Readonly<Record<string, Readonly<Record<string, DynamicPortState>>>>
}

export type DynamicAddressResolution =
  | { readonly kind: 'opaque' }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'resolved'
      readonly references: readonly { readonly port: string; readonly members: readonly string[] }[]
    }

const isFamilyState = (state: DynamicPortState): boolean =>
  state.members !== undefined || state.seq !== undefined || state.memberState !== undefined

/**
 * Resolve both canonical member arrays and wire-15 path-encoded member ids
 * against persisted dynamic state. Commands remain schema-blind: an endpoint
 * is opaque until a structurally matching family state claims it, after which
 * every member must resolve.
 */
export function resolveDynamicAddress(
  ref: { readonly port: string; readonly members?: readonly string[] },
  dynamic: Readonly<Record<string, DynamicPortState>> | undefined,
): DynamicAddressResolution {
  let scope = dynamic
  if (ref.members !== undefined) {
    for (let index = 0; index < ref.members.length; index++) {
      const member = ref.members[index]!
      const state = Object.entries(scope ?? {})
        .filter(([construct, candidate]) =>
          isFamilyState(candidate) && (ref.port === construct || ref.port.startsWith(`${construct}.`)))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1]
      if (state === undefined) return index === 0 ? { kind: 'opaque' } : { kind: 'missing' }
      if (!state.members?.includes(member)) return { kind: 'missing' }
      scope = state.memberState?.[member]
    }
    return { kind: 'resolved', references: [{ port: ref.port, members: ref.members }] }
  }

  // Wire-15 persists nested families as dot-scoped top-level keys whose
  // paths contain their ancestor member ids. Validate and retain every such
  // family scope, not merely the longest matching construct.
  const flatReferences: { port: string; members: readonly string[] }[] = []
  for (const [construct, state] of Object.entries(dynamic ?? {})
    .filter(([construct, state]) => isFamilyState(state) && ref.port.startsWith(`${construct}.`))
    .sort(([a], [b]) => a.length - b.length)) {
    const member = ref.port.slice(construct.length + 1).split('.')[0] ?? ''
    if (member.length === 0) continue
    if (!state.members?.includes(member)) return { kind: 'missing' }
    flatReferences.push({ port: construct, members: [member] })
  }

  // Canonical nested state uses memberState rather than flattened top-level
  // keys. Walk that representation too and produce the one full address that
  // compactScope expects for its ancestor path matching.
  let structuralPort = ref.port
  const members: string[] = []
  scope = dynamic
  while (true) {
    const candidate = Object.entries(scope ?? {})
      .filter(([construct, state]) => isFamilyState(state) && structuralPort.startsWith(`${construct}.`))
      .map(([construct, state]) => {
        const suffix = structuralPort.slice(construct.length + 1)
        return { construct, state, member: suffix.split('.')[0] ?? '' }
      })
      .filter(({ member }) => member.length > 0)
      .sort((a, b) => b.construct.length - a.construct.length)[0]
    if (candidate === undefined) {
      const references = [
        ...flatReferences,
        ...(members.length > 0 ? [{ port: structuralPort, members }] : []),
      ]
      return references.length === 0 ? { kind: 'opaque' } : { kind: 'resolved', references }
    }
    if (!candidate.state.members?.includes(candidate.member)) return { kind: 'missing' }
    members.push(candidate.member)
    structuralPort = `${candidate.construct}${structuralPort.slice(candidate.construct.length + candidate.member.length + 1)}`
    scope = candidate.state.memberState?.[candidate.member]
  }
}

/** Occurrence-local repetition contract for a subgraph instance. */
export interface RegionContract {
  readonly kind: 'map' | 'fold' | 'while'
  /** Boundary input ids receiving one list element per iteration. */
  readonly elementPorts?: readonly string[]
  /** Boundary input ids carrying loop state. */
  readonly statePorts?: readonly string[]
  /**
   * Boundary output roles. Omission is the canonical gather representation;
   * explicit gather entries are accepted for format compatibility.
   */
  readonly outputRoles?: Readonly<Record<string,
    | { readonly kind: 'gather' }
    | { readonly kind: 'compact' }
    | { readonly kind: 'flatten' }
    | { readonly kind: 'state'; readonly statePort: string }
  >>
  /** Boundary output consumed as the while continuation condition. */
  readonly continueOutput?: string
  readonly binding?: 'zip' | 'cross' | 'broadcast'
  readonly maxIterations?: number
}

export interface RegionShapeProblem {
  readonly field: string
  readonly message: string
}

/** Strict shape check shared by load, command, and collaboration ingress. */
export function regionContractShapeProblems(value: unknown): readonly RegionShapeProblem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '', message: 'expected an object' }]
  }
  const region = value as Record<string, unknown>
  const problems: RegionShapeProblem[] = []
  const known = new Set(['kind', 'elementPorts', 'statePorts', 'outputRoles', 'continueOutput', 'binding', 'maxIterations'])
  for (const key of Object.keys(region)) {
    if (!known.has(key)) problems.push({ field: `.${key}`, message: 'unknown region property' })
  }
  if (region.kind !== 'map' && region.kind !== 'fold' && region.kind !== 'while') {
    problems.push({ field: '.kind', message: "expected one of 'map'|'fold'|'while'" })
  }
  for (const field of ['elementPorts', 'statePorts'] as const) {
    const ports = region[field]
    if (ports === undefined) continue
    if (!Array.isArray(ports)) {
      problems.push({ field: `.${field}`, message: 'expected an array' })
      continue
    }
    const seen = new Set<string>()
    ports.forEach((id, index) => {
      if (typeof id !== 'string' || id.length === 0) {
        problems.push({ field: `.${field}[${index}]`, message: 'expected a non-empty string' })
      } else if (seen.has(id)) {
        problems.push({ field: `.${field}[${index}]`, message: `duplicate port id '${id}'` })
      } else {
        seen.add(id)
      }
    })
  }
  if (region.outputRoles !== undefined) {
    if (typeof region.outputRoles !== 'object' || region.outputRoles === null || Array.isArray(region.outputRoles)) {
      problems.push({ field: '.outputRoles', message: 'expected an object' })
    } else {
      for (const [id, role] of Object.entries(region.outputRoles)) {
        if (id.length === 0) problems.push({ field: '.outputRoles', message: 'output ids must be non-empty' })
        if (typeof role !== 'object' || role === null || Array.isArray(role)) {
          problems.push({ field: `.outputRoles.${id}`, message: 'expected an output role object' })
          continue
        }
        const fields = Object.keys(role)
        const kind = (role as Record<string, unknown>).kind
        if (kind === 'gather' || kind === 'compact' || kind === 'flatten') {
          if (fields.some((field) => field !== 'kind')) {
            problems.push({ field: `.outputRoles.${id}`, message: `${kind} role accepts only 'kind'` })
          }
        } else if (kind === 'state') {
          if (fields.some((field) => field !== 'kind' && field !== 'statePort')) {
            problems.push({ field: `.outputRoles.${id}`, message: "state role accepts only 'kind' and 'statePort'" })
          }
          const statePort = (role as Record<string, unknown>).statePort
          if (typeof statePort !== 'string' || statePort.length === 0) {
            problems.push({ field: `.outputRoles.${id}.statePort`, message: 'expected a non-empty string' })
          }
        } else {
          problems.push({ field: `.outputRoles.${id}.kind`, message: "expected 'gather', 'compact', 'state', or 'flatten'" })
        }
      }
    }
  }
  if (region.continueOutput !== undefined && (typeof region.continueOutput !== 'string' || region.continueOutput.length === 0)) {
    problems.push({ field: '.continueOutput', message: 'expected a non-empty string' })
  }
  if (region.binding !== undefined && region.binding !== 'zip' && region.binding !== 'cross' && region.binding !== 'broadcast') {
    problems.push({ field: '.binding', message: "expected 'zip', 'cross', or 'broadcast'" })
  }
  if (region.maxIterations !== undefined &&
      (typeof region.maxIterations !== 'number' || !Number.isSafeInteger(region.maxIterations) || region.maxIterations < 0)) {
    problems.push({ field: '.maxIterations', message: 'expected a safe integer >= 0' })
  }
  return problems
}

export interface NodeData {
  readonly id: NodeId
  /**
   * Node type: a backend node id ('KSampler'), or a subgraph instance
   * ('#<GraphDefId>'). Subgraph instances behave exactly like nodes; their
   * schema is derived from the definition boundary.
   */
  readonly type: string
  /** Frontend-owned document node excluded from execution. */
  readonly virtual?: true
  /** Input values keyed by schema input id. Only present for widget-backed inputs. */
  readonly values: Readonly<Record<string, Json>>
  /** Controller modes keyed by input id (only inputs whose spec has a controller slot). */
  readonly controllers?: Readonly<Record<string, ControllerMode>>
  readonly mode?: NodeMode // default 'active'
  readonly dynamic?: Readonly<Record<string, DynamicPortState>>
  /** Present only on subgraph occurrences that execute as repetition regions. */
  readonly region?: RegionContract
  /** Node title override (semantic: appears in exports/diagnostics). */
  readonly title?: string
  /**
   * Live-preview override for this node (absent = inherit the workflow
   * override or global setting). On a subgraph instance it covers every
   * node the instance lowers to. Excluded from the semantic hash.
   */
  readonly previews?: PreviewMode
  /**
   * Mirror-estimate override for this node (absent = follow the app's
   * global mirror-previews setting). Display-only gating of locally
   * computed estimates; excluded from the semantic hash.
   */
  readonly mirrorPreviews?: boolean
  readonly ext?: ExtData
}

// ---------------------------------------------------------------------------
// Links and named nets
// ---------------------------------------------------------------------------

export interface LinkData {
  readonly id: LinkId
  readonly from: LinkEndpoint // an output port or a reroute
  readonly to: LinkEndpoint // an input port or a reroute
  /**
   * Extension data is SEMANTIC only on consumer-delivering links (`to` is a
   * node input). On structural feeds into a reroute it is view-only: the
   * semantic hash ignores it and dissolving the reroute preserves only the
   * consumer segment's ext.
   */
  readonly ext?: ExtData
}

/**
 * Reroute: a structural junction vertex that links pass through. Pure
 * topology-with-geometry: topology here (so links can reference it),
 * position in view state, NO type/values/mode (its effective type is derived
 * by tracing to the real producing output; the compiler lowers reroutes away
 * entirely). At most one link may target a reroute (its driver); any number
 * may leave it (fan-out). Scoped to one graph definition like links, so
 * reroute paths never cross subgraph boundaries by construction.
 */
export interface RerouteData {
  readonly id: RerouteId
  readonly ext?: ExtData
}

/**
 * Declared (serialized) partial widget spec on a value source: the fields the
 * user pinned. Authoritative - the effective spec takes declared fields
 * verbatim and derives ONLY the rest from consumers (hazard P1). Plain JSON
 * by construction; never contains derived data.
 */
export interface DeclaredSpec {
  /** WidgetKind type ('int', 'float', 'combo', ...). */
  readonly widgetType?: string
  /** Kind-specific options (min/max/step/precision, options list, ...). */
  readonly options?: JsonObject
  /** Controller slot declared independent of consumers. */
  readonly controller?: 'after_generate' | 'after_refresh'
}

/**
 * Value source: a literal producer - the principled replacement for the
 * legacy frontend PrimitiveNode (architecture section 5b, hazards P1-P5).
 * A structural construct: real topology (links leave it via
 * `{valueSource}` endpoints; it never consumes), compiled away by baking
 * `value` into every consumer input it reaches. The document stores value +
 * optional declared spec + controller state; the effective widget spec is
 * DERIVED (declared fields verbatim, the rest unified from consumers) and
 * never stored. Scoped to one graph definition like all structural
 * constructs. Geometry lives in view state.
 */
export interface ValueSourceData {
  readonly id: ValueSourceId
  readonly value: Json
  readonly spec?: DeclaredSpec
  /** Controller state (advances only when a consumer is in the executed closure). */
  readonly controller?: ControllerMode
  /** Title override (semantic: appears in exports/diagnostics). */
  readonly title?: string
  readonly ext?: ExtData
}

/**
 * Selector policy: how the compiler picks ONE candidate branch. `fixed`
 * names a candidate id (never an index - reordering candidates must not
 * silently change the pick); `random` picks uniformly at compile time and
 * the exact resolution is recorded in the CompileArtifact, never written
 * back into the document.
 */
export type SelectorPolicy =
  | { readonly kind: 'fixed'; readonly candidate: SelectorCandidateId }
  | { readonly kind: 'random' }

/** One selectable branch input of a selector. Order is display + random-resolution order. */
export interface SelectorCandidateData {
  readonly id: SelectorCandidateId
  /** Optional user label ('high quality', 'draft', ...). */
  readonly title?: string
}

/**
 * Selector: a structural junction with N candidate inputs and ONE output;
 * the compiler resolves it to exactly one candidate per compile (policy
 * above) and traces through it like a reroute. Unchosen branches never
 * reach the prompt, so partial-execution closure and controller advancement
 * exclude them by construction. Type-agnostic like reroutes: the effective
 * type is derived by tracing, never stored.
 */
export interface SelectorData {
  readonly id: SelectorId
  /** Ordered candidates (ids stable; order is semantic for random resolution). */
  readonly candidates: readonly SelectorCandidateData[]
  readonly policy: SelectorPolicy
  /** Title override (semantic: appears in exports/diagnostics). */
  readonly title?: string
  readonly ext?: ExtData
}

/**
 * Named net: one source output feeding N sink inputs, addressed by name
 * instead of drawn point-to-point. Compiles to direct links. Scoped to its
 * graph definition; never crosses subgraph boundaries.
 */
export interface NamedNetData {
  readonly id: NetId
  readonly name: string
  readonly source: PortRef // an output
  readonly sinks: readonly PortRef[] // inputs
  readonly ext?: ExtData
}

// ---------------------------------------------------------------------------
// Graph definitions and subgraphs
// ---------------------------------------------------------------------------

/**
 * How a boundary item attaches to an inner node's interface. The `kind`
 * discriminant is REQUIRED and explicit - a binding's meaning must never
 * flip because an inner schema changed shape (hazard N2: one canonical
 * spelling per state):
 *
 * - 'port': a concrete endpoint. `port` is a schema port id or stamped slot
 *   path ('<family>.<slotId>', one segment chain per family crossed) and
 *   `members` carries one member id per family crossed (outermost first) -
 *   exactly PortRef semantics.
 * - 'family': whole-family forwarding. `port` is the dotted path OF an
 *   autogrow construct itself and `members` the concrete ancestor members
 *   crossed to REACH it (absent for a top-level family). The derived schema
 *   re-exposes the family: definition-local members form a fixed prefix and
 *   each instance appends its own member suffix (hazards F1-F5).
 * - 'slot' and 'dynamicCombo': forward one complete conditional subtree.
 *   Each occurrence owns its choices, dependent values and nested members.
 * - 'widgetTap': an output endpoint backed by one static inner widget input.
 *   `tap` is the input id. This remains distinct from a node output port so
 *   compilation can preserve linked-input and stored-value tap semantics.
 */
export interface PortBoundaryBinding {
  readonly kind: 'port' | 'family' | 'slot' | 'dynamicCombo'
  readonly node: NodeId
  readonly port: PortId
  readonly tap?: never
  readonly members?: readonly DynamicMemberId[]
  /**
   * Slot-selective forwarding ('family' bindings only, hazard F10): the
   * template slot paths the derived family exposes. Absent = the whole
   * template, tracking schema evolution; an explicit selection PINS
   * exposure (template slots added later stay hidden until selected), so a
   * full listing is NOT redundant with absence.
   *
   * Each entry is a dotted path over template slot ids. A bare id ('sub')
   * exposes that slot - for a nested autogrow construct, its WHOLE subtree,
   * tracking nested schema evolution. A dotted path ('sub.s') exposes the
   * nested construct NARROWED to the listed descendants (nested template
   * slots added later stay hidden); ancestor exposure is implied. Listing
   * both an entry and a strict extension of it ('sub' AND 'sub.s') is a
   * validation error - whole-subtree and narrowed selection are mutually
   * exclusive per construct. Paths split on '.'; template slot ids must not
   * contain dots (elaboration warns via elab.id.reserved).
   *
   * The derived template is filtered in TEMPLATE order regardless of
   * listing order. Selection never touches member identity, stored values,
   * or capacity arithmetic - adding, changing, or removing it only
   * re-derives the boundary schema.
   */
  readonly slots?: readonly string[]
}

export interface WidgetTapBoundaryBinding {
  readonly kind: 'widgetTap'
  readonly node: NodeId
  readonly tap: PortId
  readonly port?: never
  readonly members?: never
  readonly slots?: never
}

export type BoundaryBinding = PortBoundaryBinding | WidgetTapBoundaryBinding

export const isSubtreeBinding = (binding: BoundaryBinding): binding is PortBoundaryBinding & { readonly kind: 'slot' | 'dynamicCombo' } =>
  binding.kind === 'slot' || binding.kind === 'dynamicCombo'

export const isForwardingBinding = (binding: BoundaryBinding): binding is PortBoundaryBinding & { readonly kind: 'family' | 'slot' | 'dynamicCombo' } =>
  binding.kind === 'family' || isSubtreeBinding(binding)

/**
 * A subgraph definition's boundary: the ordered interface it exposes.
 * Boundary inputs bind to ports or whole dynamic families. Boundary outputs
 * may additionally bind to widget taps. This derives the instance NodeSchema.
 */
export interface BoundaryItem {
  /** Port id the instance exposes (unique within the boundary). */
  readonly id: string
  readonly displayName?: string
  /** Inner port or family this boundary item binds to. */
  readonly binds: BoundaryBinding
  /**
   * Fan-out: ADDITIONAL inner inputs this boundary input also drives.
   * Input-side only, and only when the primary `binds` is a 'port' binding;
   * every entry must itself be kind 'port' (family forwarding cannot split
   * across members, so it never fans out). The PRIMARY binding stays
   * authoritative for the derived type/widget; additional targets receive
   * the same connection or promoted value at compile. Canonical form: omit
   * when empty (never `[]`), and no target may repeat the primary or
   * another entry.
   */
  readonly alsoBinds?: readonly BoundaryBinding[]
  /**
   * For boundary inputs bound to widget-backed inner inputs: whether the
   * widget is promoted onto the instance (shown as the instance's own
   * widget). Only meaningful for 'port' bindings - a forwarded family's
   * template always carries its widgets (instance suffix members have no
   * inner stored value to fall back on), so `promoted` is invalid there.
   */
  readonly promoted?: boolean
  readonly ext?: ExtData
}

// ---------------------------------------------------------------------------
// Sparse occurrence-local topology overlays
// ---------------------------------------------------------------------------

/** One exact authored binding selected at a concrete boundary hop. */
export interface BoundaryRouteLeg {
  readonly graph: GraphDefId
  readonly boundaryId: string
  readonly binding: BoundaryBinding
}

/** Stable identity of a parent-owned delivery projected into an occurrence. */
export type ParentDeliveryIdentity =
  | { readonly kind: 'link'; readonly graph: GraphDefId; readonly linkId: LinkId }
  | {
      readonly kind: 'netSink'
      readonly graph: GraphDefId
      readonly netId: NetId
      readonly to: PortRef
    }

/** Negative overlay entries for shared or projected deliveries. */
export type SuppressedDelivery =
  | { readonly kind: 'link'; readonly linkId: LinkId }
  | { readonly kind: 'netSink'; readonly netId: NetId; readonly to: PortRef }
  | {
      readonly kind: 'projectedLeg'
      readonly delivery: ParentDeliveryIdentity
      readonly route: readonly BoundaryRouteLeg[]
    }

/** Source-coordinate endpoint of one occurrence-owned link. */
export type OccurrenceLinkEndpoint =
  | {
      readonly kind: 'body'
      readonly endpoint: LinkEndpoint
    }
  | {
      readonly kind: 'boundary'
      readonly occurrence: OccurrenceRef
      readonly address: {
        readonly port: PortId
        readonly members?: readonly DynamicMemberId[]
      }
      /** Authored boundary fan-out hops, outermost first. */
      readonly route: readonly BoundaryRouteLeg[]
    }

/** One link whose identity is scoped to its occurrence topology owner. */
export interface OccurrenceLinkData {
  readonly id: LinkId
  readonly from: OccurrenceLinkEndpoint
  readonly to: OccurrenceLinkEndpoint
  readonly ext?: ExtData
}

/** Sparse topology owned by exactly one concrete subgraph occurrence. */
export interface OccurrenceTopology {
  readonly owner: OccurrenceRef
  readonly bodyGraph: GraphDefId
  readonly links: Readonly<Record<string, OccurrenceLinkData>>
  readonly suppressedDeliveries?: readonly SuppressedDelivery[]
  readonly nextOrdinal: number
  readonly actorCursors?: Readonly<Record<string, number>>
  readonly ext?: ExtData
}

const boundaryBindingIdentity = (binding: BoundaryBinding): readonly Json[] =>
  binding.kind === 'widgetTap'
    ? [binding.kind, binding.node, binding.tap]
    : [
        binding.kind,
        binding.node,
        binding.port,
        binding.members ?? [],
        binding.slots === undefined ? null : [...binding.slots].sort(),
      ]

/**
 * Canonical structural binding identity. Slot selections are sets; member
 * paths remain ordered. Every exposure-changing field participates.
 */
export const boundaryBindingKey = (binding: BoundaryBinding): string =>
  JSON.stringify(boundaryBindingIdentity(binding))

/** Canonical structural route identity, preserving outermost-first hop order. */
export const boundaryRouteKey = (route: readonly BoundaryRouteLeg[]): string =>
  JSON.stringify(route.map((leg) => [leg.graph, leg.boundaryId, boundaryBindingIdentity(leg.binding)]))

const portRefIdentity = (ref: PortRef): readonly Json[] => [ref.node, ref.port, ref.members ?? []]

/** Canonical key used to sort and deduplicate occurrence suppressions. */
export const suppressedDeliveryKey = (delivery: SuppressedDelivery): string => {
  if (delivery.kind === 'link') return JSON.stringify(['link', delivery.linkId])
  if (delivery.kind === 'netSink')
    return JSON.stringify(['netSink', delivery.netId, portRefIdentity(delivery.to)])
  const parent = delivery.delivery.kind === 'link'
    ? ['link', delivery.delivery.graph, delivery.delivery.linkId]
    : ['netSink', delivery.delivery.graph, delivery.delivery.netId, portRefIdentity(delivery.delivery.to)]
  return JSON.stringify(['projectedLeg', parent, JSON.parse(boundaryRouteKey(delivery.route)) as Json])
}

export interface GraphDef {
  readonly id: GraphDefId
  readonly name: string
  readonly nodes: Readonly<Record<string, NodeData>>
  readonly links: Readonly<Record<string, LinkData>>
  readonly nets: Readonly<Record<string, NamedNetData>>
  readonly reroutes: Readonly<Record<string, RerouteData>>
  /** Optional (absent = none) to keep existing v1 documents valid unchanged. */
  readonly valueSources?: Readonly<Record<string, ValueSourceData>>
  /** Optional (absent = none) to keep existing v1 documents valid unchanged. */
  readonly selectors?: Readonly<Record<string, SelectorData>>
  /** Present only on subgraph definitions (absent on the root graph). */
  readonly boundary?: {
    readonly inputs: readonly BoundaryItem[]
    readonly outputs: readonly BoundaryItem[]
  }
  /** Monotonic ID allocation cursor; IDs are never reused within a definition. */
  readonly nextOrdinal: number
  /**
   * Per-actor allocation cursors for shared sessions (ids mint as
   * `<prefix><ordinal>-<actorId>` from the actor's own cursor, so
   * concurrent actors can never collide; see commands/alloc.ts). Each
   * cursor is monotonic and never reused, like nextOrdinal. Optional
   * (absent = no shared-mode allocations yet) so existing documents stay
   * valid unchanged.
   */
  readonly actorCursors?: Readonly<Record<string, number>>
  readonly ext?: ExtData
}

// ---------------------------------------------------------------------------
// Control surfaces (mode panels, selectors) - serialized, not compiled
// ---------------------------------------------------------------------------

export interface ControlSurfaceData {
  readonly id: ControlSurfaceId
  /** Registered surface type (e.g. 'core.modePanel', 'core.selector'). */
  readonly type: string
  /** Declarative bindings: stable node/group ids or structural queries. */
  readonly config: JsonObject
  readonly ext?: ExtData
}

// ---------------------------------------------------------------------------
// View state (never part of the semantic hash)
// ---------------------------------------------------------------------------

export interface Vec2 {
  readonly x: number
  readonly y: number
}

export interface NodeViewState {
  /** Absent keeps the scene builder's deterministic fallback position. */
  readonly position?: Vec2
  /** Manual size override; absent = auto-sized from the row stack. */
  readonly size?: { readonly width: number; readonly height: number }
  readonly collapsed?: boolean
  /** Playback presentation only; absent preferences default to true. */
  readonly video?: { readonly loop: boolean; readonly muted: boolean; readonly autoplay: boolean }
  /** Chosen schema widget representation id per input/value key. */
  readonly views?: Readonly<Record<string, string>>
  /**
   * Per-section collapse OVERRIDES by section id. Absent = the schema's
   * collapsedByDefault. An override record (not a plain collapsed list) so a
   * default-collapsed section can also be explicitly expanded.
   */
  readonly sections?: Readonly<Record<string, { readonly collapsed: boolean }>>
  readonly color?: string
  readonly ext?: ExtData
}

/**
 * A visual grouping rectangle. Pure view state with NO stored membership:
 * which nodes a group contains is derived spatially (node center inside
 * bounds) at interaction time, so there is nothing to keep in sync.
 */
export interface GroupViewState {
  readonly id: string
  readonly title: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly color?: string
  readonly ext?: ExtData
}

/** Geometry of one reroute junction (topology lives in GraphDef.reroutes). */
export interface RerouteViewState {
  readonly position: Vec2
  readonly ext?: ExtData
}

/** Geometry/presentation of one value source (semantics live in GraphDef.valueSources). */
export interface ValueSourceViewState {
  readonly position: Vec2
  /** Chosen WidgetView (only when diverging from the effective spec's default). */
  readonly view?: string
  readonly ext?: ExtData
}

/** Geometry of one selector (semantics live in GraphDef.selectors). */
export interface SelectorViewState {
  readonly position: Vec2
  readonly ext?: ExtData
}

/** Which side of a subgraph definition's boundary a pseudo-node shows. */
export type BoundarySide = 'inputs' | 'outputs'

/**
 * Geometry of one boundary pseudo-node (the node-like Inputs/Outputs panels
 * shown while editing a subgraph definition). Pure view state: the panels
 * themselves are derived from `GraphDef.boundary` at scene-build time and
 * are never NodeData. Absent = a deterministic default position derived
 * from the graph's content bounds.
 */
export interface BoundaryNodeViewState {
  readonly position: Vec2
  readonly ext?: ExtData
}

/** Per-graph-definition view data. Key: graph def id. */
export interface GraphViewState {
  /** Key: node id. */
  readonly nodes: Readonly<Record<string, NodeViewState>>
  /** Key: reroute id. */
  readonly reroutes?: Readonly<Record<string, RerouteViewState>>
  /** Key: value source id. */
  readonly valueSources?: Readonly<Record<string, ValueSourceViewState>>
  /** Key: selector id. */
  readonly selectors?: Readonly<Record<string, SelectorViewState>>
  /** Key: group id. */
  readonly groups?: Readonly<Record<string, GroupViewState>>
  /**
   * Group id allocation cursor (never-reuse, like surfaceSeq): group ids
   * outlive their groups in surface bindings, so a removed group's id must
   * never be reminted onto an unrelated group. Monotonic across undo.
   */
  readonly groupSeq?: number
  /** Nets rendered collapsed (endpoint labels instead of full noodles). */
  readonly collapsedNets?: readonly string[]
  /**
   * Collapsed nets that also draw a dashed Set-to-Get guide curve. Always a
   * subset of collapsedNets: a net's display mode is exactly one of noodle
   * (not collapsed), tags (collapsed), or tags + guide (collapsed + here).
   */
  readonly guideNets?: readonly string[]
  /** Boundary pseudo-node positions (subgraph definitions only). */
  readonly boundary?: Readonly<Partial<Record<BoundarySide, BoundaryNodeViewState>>>
  readonly ext?: ExtData
}

/**
 * A saved camera: RTS-style numbered view shortcut. Captures WHERE the user
 * was looking - the subgraph drill-in context (definition stack + instance
 * path, so a bookmark inside one occurrence of a twice-instantiated def
 * restores THAT occurrence) and the viewport. Pure view state: jumping or
 * saving never touches semantic graph data.
 */
interface ViewBookmarkBase {
  /** Graph definition drill-in path; first entry is the document root. */
  readonly graphStack: readonly string[]
  /** Instance node ids navigated through (one per stack entry beyond root). */
  readonly instancePath: readonly string[]
  readonly ext?: ExtData
}

/** Saved world rectangle (current format), or a legacy raw canvas transform. */
export type ViewBookmark = ViewBookmarkBase & (
  | {
      readonly view: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
      readonly viewport?: never
    }
  | {
      readonly viewport: { readonly x: number; readonly y: number; readonly scale: number }
      readonly view?: never
    }
)

export interface ViewState {
  readonly graphs: Readonly<Record<string, GraphViewState>>
  /** Control surface placement (panel positions etc.). */
  readonly surfaces?: Readonly<Record<string, JsonObject>>
  /** Numbered camera shortcuts. Key: slot "1".."10". */
  readonly bookmarks?: Readonly<Record<string, ViewBookmark>>
  readonly ext?: ExtData
}

// ---------------------------------------------------------------------------
// Environment stamp
// ---------------------------------------------------------------------------

/**
 * Provenance of one pack in the producing environment, mirrored 1:1 from
 * the backend's /api/nodes packs-table provenance fields. All optional:
 * omission means "not pinned" (dev --pack installs), never null.
 */
export interface EnvironmentPackStamp {
  /** Registry release semver; absent for unpublished local/git installs. */
  readonly version?: string
  /** 'sha256:<hex>' - the real pin for managed installs. */
  readonly artifactDigest?: string
  /** 'registry' | 'git:<url>@<commit>' | 'local:<path>'. */
  readonly source?: string
  readonly publisher?: string
}

/** One used node type's identity in the producing environment. */
export interface EnvironmentNodeStamp {
  /** Owning pack id at stamp time (host-attributed, never self-claimed). */
  readonly pack?: string
  /**
   * The backend's schema_signature content hash (computational interface
   * only). Opaque: compared for equality, never parsed.
   */
  readonly signature: string
}

/**
 * Record of the environment that produced this document, stamped from live
 * /api/nodes data at save time. A RECORD, never identity: loading and
 * execution never depend on it, absence is fully valid, and it is outside
 * the execution-semantic hash by construction (the hash covers exactly the
 * `graphs` subtree). Used-only: it names only packs and node types this
 * document actually instantiates. Powers load-time drift diagnostics and
 * (backend-side) environment reproduction.
 */
export interface EnvironmentStamp {
  /** Backend identity at stamp time (/api/nodes "dinkster" header). */
  readonly dinkster?: { readonly version: string; readonly schemaWire: number }
  /** Frontend build that performed the stamping. */
  readonly frontend?: { readonly version: string }
  /** Used packs only. Key: pack id. */
  readonly packs: Readonly<Record<string, EnvironmentPackStamp>>
  /** Used node types only. Key: node type id. */
  readonly nodes: Readonly<Record<string, EnvironmentNodeStamp>>
}

// ---------------------------------------------------------------------------
// Document root
// ---------------------------------------------------------------------------

export interface WorkflowDocument {
  /** Discriminator + version for the migration pipeline. */
  readonly format: 'dinkster-workflow'
  readonly formatVersion: number
  /** Stable across saves of the same logical workflow; used to match executions to tabs. */
  readonly lineage: LineageId
  /** The root graph definition id (must exist in `graphs`). */
  readonly root: GraphDefId
  /** All graph definitions: the root graph + subgraph definitions. Key: def id. */
  readonly graphs: Readonly<Record<string, GraphDef>>
  /**
   * Sparse occurrence-local link/suppression overlays. Keys are canonical
   * occurrenceKey(owner) values; validators regenerate rather than parse.
   */
  readonly occurrenceTopologies?: Readonly<Record<string, OccurrenceTopology>>
  readonly surfaces?: Readonly<Record<string, ControlSurfaceData>>
  /**
   * Surface id allocation cursor (never-reuse contract, mirrors each
   * graph's nextOrdinal). Optional: absent on pre-cursor documents, where
   * the key scan in surface.add is the floor.
   */
  readonly surfaceSeq?: number
  /** View state - excluded from the execution-semantic hash. */
  readonly view: ViewState
  /**
   * Producing-environment record (advisory; refreshed on save, sanitized
   * with warn-and-drop on load - a malformed stamp never blocks loading).
   */
  readonly environment?: EnvironmentStamp
  /**
   * Workflow-wide live-preview override (absent = follow the app's global
   * setting). Per-node `previews` overrides win over this. Excluded from
   * the semantic hash.
   */
  readonly previews?: PreviewMode
  readonly meta?: {
    readonly title?: string
    readonly description?: string
    readonly created?: string // ISO 8601
    readonly modified?: string
    readonly ext?: ExtData
  }
  readonly ext?: ExtData
}
