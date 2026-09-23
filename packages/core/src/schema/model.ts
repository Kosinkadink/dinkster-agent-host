/**
 * Normalized NodeSchema model. V3 is the semantic target.
 *
 * Raw /object_info entries (V1-shaped, with V3 data embedded - see
 * object-info.ts) are parsed ONCE into this model; nothing downstream ever
 * touches raw schema JSON. Subgraph definition boundaries derive this exact
 * same model, which is what makes "anything that works on a node works on a
 * subgraph" true by construction.
 *
 * The interface is one ordered list of items (inputs, outputs, presentation
 * constructs) - any order the schema declares. Inputs and outputs are modeled
 * symmetrically, including dynamic families.
 */

import type { ReplacementRule } from '../replace/model.js'

export type SchemaSource = 'v3' | 'v1' | 'subgraph'

// ---------------------------------------------------------------------------
// Type expressions
// ---------------------------------------------------------------------------

/**
 * The type of a port. Kept small and closed on purpose: the type solver is
 * defined over exactly these forms.
 * - concrete: a single data type name ('IMAGE', 'LATENT', ...)
 * - union: MultiType (COMFY_MULTITYPED_V3) - any of the named types
 * - wildcard: '*' - matches anything, no propagation
 * - variable: MatchType (COMFY_MATCHTYPE_V3) - a type variable shared among
 *   ports with the same templateId, optionally constrained to allowedTypes.
 *   Freshened per node instance (and per subgraph instance) by the solver.
 * - list: structured (recursive) kind, mirroring Dinkster schema wire
 *   v2 (DESIGN 3.13). `list<T>` is ONE ordinary value on ONE edge - never
 *   implicit repeated execution; length is runtime data, never schema.
 *   There is no implicit coercion in either direction: list-vs-scalar
 *   cardinality mismatches are structural errors, unlike ordinary advisory
 *   atom mismatches.
 * - asset: the second structured kind (Dinkster schema wire v12, typed assets).
 *   `asset<T>` is a committed-asset REFERENCE whose decode target is T; the
 *   value is one AssetRef envelope regardless of T, so cardinality is
 *   SCALAR even for `asset<list<T>>`. The backend applies exactly one
 *   engine-side coercion step at input resolution (decode asset<T> -> T,
 *   lift list<asset<T>> -> list<T>, registry-gated merge
 *   list<asset<T>> -> T), which advisory compatibility mirrors.
 * - stream: recursive wire-41 media stream type with scalar cardinality.
 *   Stream transport and chunk execution remain backend-owned.
 */
export type TypeExpr =
  | { readonly kind: 'concrete'; readonly name: string }
  | { readonly kind: 'union'; readonly names: readonly string[] }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'variable'; readonly templateId: string; readonly allowedTypes?: readonly TypeExpr[] }
  | { readonly kind: 'list'; readonly element: TypeExpr }
  | { readonly kind: 'asset'; readonly element: TypeExpr }
  | { readonly kind: 'stream'; readonly element: TypeExpr }

/** COMBO is a concrete STRING-valued type at the wire level; we keep its own name. */
export const COMBO_TYPE = 'COMBO'

// ---------------------------------------------------------------------------
// Canonical parametric type ids ('list<...>', 'asset<...>', 'stream<...>')
// ---------------------------------------------------------------------------
//
// The canonical runtime identity of a closed structured type is the
// parametric string `list<element_type_id>` / `asset<element_type_id>`
// (nesting composes: `list<asset<comfy.IMAGE>>`), matching the backend's
// dinkster_values grammar exactly (its closed constructor set: atom | list<id>
// | asset<id> | stream<id>). These functions are the SINGLE owner of that grammar -
// nothing else string-matches parametric ids (the same rule the backend
// pins), and a structured type has exactly ONE schema representation:
// `{ kind: 'list' | 'asset' | 'stream' }`, never `concrete('list<...>')`.
// Structural slot/family ids already forbid '<'/'>' (elaborate.ts), so
// canonical type ids can never collide with structural ids.

const LIST_TYPE_PREFIX = 'list<'
const ASSET_TYPE_PREFIX = 'asset<'
const TYPE_SUFFIX = '>'

const parseParametricTypeId = (typeId: string, prefix: string): string | undefined =>
  typeId.startsWith(prefix) &&
  typeId.endsWith(TYPE_SUFFIX) &&
  typeId.length > prefix.length + TYPE_SUFFIX.length
    ? typeId.slice(prefix.length, -TYPE_SUFFIX.length)
    : undefined

/** The canonical type id of a list of `elementTypeId`. */
export const listTypeId = (elementTypeId: string): string =>
  `${LIST_TYPE_PREFIX}${elementTypeId}${TYPE_SUFFIX}`

/** The element type id if `typeId` is a canonical list id, else undefined. */
export const parseListTypeId = (typeId: string): string | undefined =>
  parseParametricTypeId(typeId, LIST_TYPE_PREFIX)

/** The canonical type id of an asset whose decode target is `elementTypeId`. */
export const assetTypeId = (elementTypeId: string): string =>
  `${ASSET_TYPE_PREFIX}${elementTypeId}${TYPE_SUFFIX}`

/** The decode-target type id if `typeId` is a canonical asset id, else undefined. */
export const parseAssetTypeId = (typeId: string): string | undefined =>
  parseParametricTypeId(typeId, ASSET_TYPE_PREFIX)

export const streamTypeId = (elementTypeId: string): string => `stream<${elementTypeId}>`
export const parseStreamTypeId = (typeId: string): string | undefined =>
  parseParametricTypeId(typeId, 'stream<')

/**
 * The canonical type id a recursively-closed expression denotes (concrete ->
 * its name, closed list -> 'list<...>', closed asset -> 'asset<...>'), else
 * undefined. The single bridge between the expression level and canonical
 * atom strings: solver domains and display labels use these ids for
 * structured-type identity.
 */
export const canonicalTypeIdOf = (t: TypeExpr): string | undefined => {
  if (t.kind === 'concrete') return t.name
  if (t.kind === 'list' || t.kind === 'asset' || t.kind === 'stream') {
    const inner = canonicalTypeIdOf(t.element)
    return inner === undefined ? undefined : `${t.kind}<${inner}>`
  }
  return undefined
}

/**
 * Rebuild the structured expression a canonical type id denotes (inverse of
 * canonicalTypeIdOf). Keeps the one-representation invariant: code holding a
 * solved atom string must go through this instead of wrapping it in
 * `concrete` directly, so `concrete('list<...>')` never enters the system.
 */
export const typeExprFromTypeId = (typeId: string): TypeExpr => {
  const listInner = parseListTypeId(typeId)
  if (listInner !== undefined) return { kind: 'list', element: typeExprFromTypeId(listInner) }
  const assetInner = parseAssetTypeId(typeId)
  if (assetInner !== undefined) return { kind: 'asset', element: typeExprFromTypeId(assetInner) }
  const streamInner = parseStreamTypeId(typeId)
  if (streamInner !== undefined) return { kind: 'stream', element: typeExprFromTypeId(streamInner) }
  return { kind: 'concrete', name: typeId }
}

/**
 * True when a canonical type id is an ASSET-SOURCE form the backend's
 * coercion planner accepts on a concrete destination: `asset<T>` (decode
 * arm) or `list<asset<T>>` (lift/merge arms). The 2026-07-26 joint
 * emission-rule amendment keys on exactly these forms: a literal whose
 * runtime type is an asset source DIFFERING from the concrete declared
 * type must be $typed-stamped (the plain literal would be wrapped as the
 * declared type raw and never reach the planner). Bare `dinkster.asset` and
 * `list<dinkster.asset>` are NOT asset sources - the untyped atom has no
 * decode target, so a stamp would not make it coercible.
 */
export const isAssetSourceTypeId = (typeId: string): boolean => {
  if (parseAssetTypeId(typeId) !== undefined) return true
  const inner = parseListTypeId(typeId)
  return inner !== undefined && parseAssetTypeId(inner) !== undefined
}

/**
 * True when a canonical type id DECLARES an asset-reference destination:
 * bare `dinkster.asset`, `asset<...>`, or a list of either. Per the typed-assets
 * joint pins, such destinations receive AssetRef envelopes AS-IS - never
 * coerced - so an asset-source literal landing on one must stay a PLAIN
 * literal even when the source form differs from the declared form (e.g. an
 * `asset<comfy.IMAGE>` tap into a bare `dinkster.asset` input): a $typed stamp
 * would route it into the coercion planner, which has no asset-to-asset
 * vocabulary and would refuse a delivery the plain ref satisfies.
 */
export const isAssetRefDestinationTypeId = (typeId: string): boolean => {
  if (typeId === 'dinkster.asset' || parseAssetTypeId(typeId) !== undefined) return true
  const inner = parseListTypeId(typeId)
  return inner !== undefined && (inner === 'dinkster.asset' || parseAssetTypeId(inner) !== undefined)
}

/**
 * Multi-select gating for ASSET widgets (typed-assets joint pin (5),
 * Dinkster b56fa4f + caf1070 amendment). Two arms:
 *
 * - LIST-OUTER (schema-driven): the declared outer type is a LIST of
 *   asset references - `list<asset<T>>` or bare `list<dinkster.asset>` -
 *   because N selections lower to N descriptors in a list literal.
 * - SCALAR MERGE (registry-gated, backend 6dbbddd): the declared type is
 *   a scalar concrete atom T with a registered batch-merge provider
 *   (`mergeableTypes` from the /api/nodes dinkster envelope). N selections
 *   stage a `list<asset<T>>` literal the engine decodes-each-then-merges
 *   into ONE batched T; the widget tap exposes T (one batch), which is
 *   simply the declared input type. Absent list (older backend) = arm
 *   off; the backend planner enforces regardless, so staleness only
 *   under/over-offers the UI.
 *
 * `asset<list<T>>` stays single-pick: its multi-ness comes from the
 * DECODER (one file, many batches), not from selection. Bare scalar
 * `dinkster.asset` stays single-pick: the untyped atom has no decode target
 * to merge through (and the backend registry holds atoms like
 * comfy.IMAGE, never dinkster.asset).
 */
export const assetMultiSelect = (t: TypeExpr, mergeableTypes?: readonly string[]): boolean =>
  (t.kind === 'list' &&
    (t.element.kind === 'asset' ||
      (t.element.kind === 'concrete' && t.element.name === 'dinkster.asset'))) ||
  (t.kind === 'concrete' &&
    t.name !== 'dinkster.asset' &&
    parseListTypeId(t.name) === undefined &&
    parseAssetTypeId(t.name) === undefined &&
    mergeableTypes !== undefined &&
    mergeableTypes.includes(t.name))

/**
 * Structural shape of an expression. Cardinality is authoritative (unlike
 * atom compatibility, which is advisory): a definitely-list edge into a
 * definitely-scalar input is a document-time ERROR, while wildcard/variable
 * stay 'unknown' and never trigger structural rejection. Mirrors the
 * backend's TypeExpr.cardinality().
 */
export type Cardinality = 'scalar' | 'list' | 'unknown'

export const cardinalityOf = (t: TypeExpr): Cardinality => {
  switch (t.kind) {
    case 'list':
      return 'list'
    case 'stream':
      return 'scalar'
    case 'asset':
      // One AssetRef envelope regardless of decode target - even
      // asset<list<T>> is a scalar on the edge (backend pin, typed assets).
      return 'scalar'
    case 'concrete':
      // Defensive: a canonical list id smuggled into `concrete` (adapters
      // must use typeExprFromTypeId) still reports its true shape.
      return parseListTypeId(t.name) === undefined ? 'scalar' : 'list'
    case 'union':
      return t.names.every((n) => parseListTypeId(n) === undefined)
        ? 'scalar'
        : t.names.every((n) => parseListTypeId(n) !== undefined)
          ? 'list'
          : 'unknown'
    default:
      return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * One closed widget descriptor. It owns presentation for one canonical value
 * domain; changing descriptors never changes the input's socket or value.
 */
export interface WidgetDescriptorSpec {
  readonly widgetType: string
  readonly options: Readonly<Record<string, unknown>>
  /** Open-vocabulary ASSET classification (wire v7; presentation only). */
  readonly kind?: string
  /** Source media inputs may acquire bytes through the bounded media ingest route. */
  readonly allowUpload?: true
  readonly default?: unknown
  /** Controller slot (control_after_generate / control_after_refresh). */
  readonly controller?: 'after_generate' | 'after_refresh'
  /**
   * Schema-declared INITIAL controller mode (native wire v11
   * controlAfterGenerate). Presentation seed only: live mode stays
   * client-owned document state (node.controllers); absent falls back to
   * the historical 'randomize' default.
   */
  readonly controllerInitial?: 'fixed' | 'increment' | 'decrement' | 'randomize'
  /** Declarative remote option source (combos and kin). */
  readonly remote?: RemoteSourceSpec
  /** Ordered options derived from one occurrence-local input family. */
  readonly optionSource?: InputFamilyOptionSourceSpec
  /** Schema-declared text completion vocabulary (wire 36). */
  readonly textCompletions?: TextCompletionsSpec
}

export interface InputFamilyOptionSourceSpec {
  /** Family construct path. Values are stable member suffixes. */
  readonly inputFamily: string
}

export interface TextCompletionItemSpec {
  readonly value: string
  readonly label: string
  readonly insertText: string
  readonly detail: string
  readonly kind: 'identifier' | 'operator'
}

export interface TextCompletionsSpec {
  readonly items: readonly TextCompletionItemSpec[]
  readonly inputFamilies: readonly string[]
}

/** One stable schema-authored name for one widget presentation. */
export interface WidgetRepresentationSpec {
  readonly id: string
  readonly displayName: string
  readonly widget: WidgetDescriptorSpec
}

/**
 * Finite presentation choices from schema wire 17. `default` is only the
 * initial choice; client selection lives in NodeViewState and is never part
 * of the canonical input value, TypeExpr, links, or execution identity.
 */
export interface WidgetRepresentationsSpec {
  readonly default: string
  readonly userSwitchable: boolean
  readonly representations: readonly WidgetRepresentationSpec[]
}

/**
 * WidgetSpec: the effective/default descriptor plus optional wire-17 named
 * alternatives. Existing consumers keep reading the descriptor fields; only
 * presentation selection needs to inspect `representations`.
 */
export interface WidgetSpec extends WidgetDescriptorSpec {
  readonly representations?: WidgetRepresentationsSpec
}

export interface ResolvedWidgetRepresentation {
  readonly spec: WidgetSpec
  readonly id?: string
}

/**
 * Every ordinary string supports the two value-compatible text views. An
 * explicit representation set takes authority, including a locked set with
 * userSwitchable false or only one representation.
 */
export function widgetRepresentationsOf(spec: WidgetSpec): WidgetRepresentationsSpec | undefined {
  if (spec.representations !== undefined) return spec.representations
  if (spec.widgetType !== 'STRING') return undefined
  const descriptor = (multiline: boolean): WidgetDescriptorSpec => ({
    ...spec,
    options: { ...spec.options, multiline },
  })
  return {
    default: spec.options['multiline'] === true ? 'multiline' : 'single-line',
    userSwitchable: true,
    representations: [
      { id: 'single-line', displayName: 'Single line', widget: descriptor(false) },
      { id: 'multiline', displayName: 'Multiline', widget: descriptor(true) },
    ],
  }
}

/**
 * Resolve a client-owned representation selection without mutating schema or
 * document state. An absent or stale selection uses the schema default; the
 * stale id remains stored so a later schema refresh can restore it.
 */
export function resolveWidgetRepresentation(
  spec: WidgetSpec,
  selected?: string,
): ResolvedWidgetRepresentation {
  const set = widgetRepresentationsOf(spec)
  if (set === undefined) return { spec }
  const representation = set.representations.find((candidate) => candidate.id === selected) ??
    set.representations.find((candidate) => candidate.id === set.default)
  if (representation === undefined) return { spec }
  return {
    id: representation.id,
    spec: {
      ...representation.widget,
      representations: set,
    },
  }
}

export interface RemoteSourceSpec {
  readonly route: string
  readonly refreshButton?: boolean
  readonly controlAfterRefresh?: 'first' | 'last'
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly refreshMs?: number
}

// ---------------------------------------------------------------------------
// Dynamic constructs
// ---------------------------------------------------------------------------

/**
 * Autogrow: a growable family of port GROUPS stamped from a template.
 *
 * `template` is the ordered list of slots each member stamps - most families
 * have exactly one slot, but a grouped template stamps ALL slots per member
 * and the member promotes/removes as a unit. Non-empty by construction
 * (parsers reject empty templates). Slot ids address stamped ports as
 * '<familyId>.<slotId>' regardless of slot count, so a schema growing from
 * one slot to a group never reshapes existing document addresses.
 */
export interface AutogrowSpec {
  readonly kind: 'autogrow'
  readonly template: readonly InputSpec[]
  /** Wire-15 document-driven materialization (absent keeps wire-14 identity). */
  readonly materialization?: 'wire15'
  readonly naming:
    | { readonly kind: 'prefix'; readonly prefix: string; readonly min?: number; readonly max?: number }
    | { readonly kind: 'names'; readonly names: readonly string[]; readonly min?: number }
    /**
     * Wire-15 native free-suffix vocabulary. The decoder retains its bounds,
     * but document materialization deliberately does not support this arm yet.
     */
    | { readonly kind: 'native'; readonly min?: number; readonly max?: number }
  /**
   * Display/api ordinal offset (derived boundary schemas only): a forwarded
   * family whose definition holds N prefix members numbers instance members
   * from N ('item2' when the definition owns item0/item1), and elaborated
   * ancestry ordinals report the merged position. Additive across chained
   * forwarding. NEVER identity - member ids stay the identity (hazard F3).
   */
  readonly ordinalOffset?: number
}

/** A top-level output family's fixed arity, read from an ordinary integer input. */
export interface CountBoundOutputAutogrowSpec extends AutogrowSpec {
  readonly count: {
    readonly input: string
    readonly suffix: 'index'
    /**
     * Derived boundary schemas retain a valid definition value as fallback.
     * A fixed projection has no editable instance count input.
     */
    readonly boundaryProjection?: { readonly fallback?: number; readonly fixed?: true }
  }
}

/** Effective count for a native or derived count-bound output family. */
export const outputCountValueOf = (
  spec: CountBoundOutputAutogrowSpec,
  values: Readonly<Record<string, unknown>>,
): unknown => spec.count.boundaryProjection?.fixed === true
  ? spec.count.boundaryProjection.fallback
  : Object.hasOwn(values, spec.count.input)
    ? values[spec.count.input]
    : spec.count.boundaryProjection?.fallback

/**
 * Effective LOCAL member bounds of an autogrow family (before any
 * ordinalOffset). Single source for the prefix-naming default cap - derive
 * and elaboration must never disagree on capacity (hazard F4).
 */
export const autogrowBounds = (spec: AutogrowSpec): { readonly min: number; readonly max: number } =>
  spec.naming.kind === 'native'
    // Wire-15 decode/model foundation only: until a document suffix source is
    // pinned, existing consumers must not invent ordinal members for a native
    // free-suffix family. The declaration remains intact on spec.naming.
    ? { min: 0, max: 0 }
    : spec.naming.kind === 'names'
    ? { min: spec.naming.min ?? 0, max: spec.naming.names.length }
    : { min: spec.naming.min ?? 0, max: spec.naming.max ?? 10 }

/** DynamicCombo: selecting an option swaps in that option's input set. */
export interface DynamicComboSpec {
  readonly kind: 'dynamicCombo'
  /** Wire-15 choices persist explicit state; absent legacy state displays the first option. */
  readonly materialization?: 'wire15'
  readonly options: readonly { readonly key: string; readonly inputs: readonly InputSpec[] }[]
  /** Schema-side fallback used when occurrence state has no valid selection. */
  readonly defaultOption?: string
}

/** Join one schema item onto its persisted value/dynamic-state path. */
export const joinValuePath = (prefix: string, item: string): string =>
  prefix === '' ? item : `${prefix}.${item}`

/** Persisted value-path prefix for one DynamicCombo branch. */
export const comboBranchValuePath = (construct: string, option: string): string =>
  `${construct}.[${option}]`

/**
 * The one selection rule used by elaboration and boundary projection. Keeping
 * this here prevents derived subgraph selectors from choosing a branch that
 * differs from the definition they forward.
 */
export const effectiveComboOption = (
  spec: DynamicComboSpec,
  state: { readonly selected?: string } | undefined,
): string | undefined => {
  const keys = spec.options.map((o) => o.key)
  if (state?.selected !== undefined && keys.includes(state.selected)) return state.selected
  if (spec.materialization === 'wire15') return keys[0]
  return spec.defaultOption !== undefined && keys.includes(spec.defaultOption)
    ? spec.defaultOption
    : keys[0]
}

export interface DynamicSlotVariant {
  /**
   * Schema-authored identity embedded verbatim in document value paths
   * ('slot.[key].x') and in the graph wire's per-node slotVariants object.
   * Keys never become wire id SEGMENTS (the settled contract, Dinkster c2ac572:
   * dependents lower construct-local as 'slot.x'), so the grammar is the
   * backend's construction-enforced [A-Za-z0-9_-]+ - dotless because the
   * bracket path syntax and the choice wire both carry it verbatim.
   */
  readonly key: string
  readonly type: TypeExpr
  /**
   * Per-variant nested inputs (each may carry its own widget - "per-type
   * widget specs"). Two variants of one slot may reuse the same local name
   * (mutually exclusive by construction), but under construct-local wire
   * naming a variant local must not reuse a frontend-modeled SHARED
   * dependent's id - elaboration skips such an input loudly.
   */
  readonly inputs: readonly InputSpec[]
  /** Variant documentation (wire 'doc'; presentation only, signature-excluded). */
  readonly tooltip?: string
}

/** DynamicSlot: connecting a typed slot reveals its dependent inputs. */
export interface DynamicSlotSpec {
  readonly kind: 'dynamicSlot'
  /** Wire-15 slots materialize from stored values/links or explicit choices. */
  readonly materialization?: 'wire15'
  readonly slotType: TypeExpr
  readonly inputs: readonly InputSpec[]
  readonly variants?: readonly DynamicSlotVariant[]
  /** Node-level MatchType variable bound by the selected closed-slot variant. */
  readonly typeTemplateId?: string
  // Deliberately no defaultVariant. Specialization is chosen by the connect
  // gesture from the CONNECTED type; a schema fallback would contradict that
  // contract and make an unresolved connection silently type-dependent.
  readonly forceInput?: boolean
}

export type DynamicSpec = AutogrowSpec | DynamicComboSpec | DynamicSlotSpec

// ---------------------------------------------------------------------------
// Interface items (ordered)
// ---------------------------------------------------------------------------

interface PortSpecBase {
  /** Schema port id - the key values/links use. Unique within the node. */
  readonly id: string
  readonly displayName?: string
  readonly tooltip?: string
  /** Alpha handling at this port; undefined is the default 'preserve'. */
  readonly alphaPolicy?: AlphaPolicy
  readonly maskPolarity?: MaskPolarity
  readonly maskSemantic?: MaskSemantic
  /** Presentation section this item belongs to (collapsible grouping). */
  readonly section?: string
  readonly ext?: Readonly<Record<string, unknown>>
}

export type AlphaPolicy = 'preserve' | 'require' | 'create_if_missing' | 'drop'
export type MaskPolarity = 'coverage' | 'transparency'
export type MaskSemantic = 'alpha' | 'selection' | 'other'

/**
 * What happens when a linked input's value arrives ABSENT at runtime (Dinkster
 * first-class absence, schema wire v3). Applied by the ENGINE before
 * invocation - never frontend behavior to emulate:
 * - 'skip': the node does not run; its outputs become absent with the ROOT
 *   origin's provenance (default for required inputs)
 * - 'omit': treated as unconnected (default for optional inputs; invalid on
 *   required ones - decoders must not produce that combination)
 * - 'accept': the node runs and receives an explicit no-value
 * - 'fail': the run fails loudly, naming the origin. An optional output
 *   feeding a 'fail' input is legal but warned (solve.maybeAbsent).
 */
export type AbsentPolicy = 'skip' | 'accept' | 'fail' | 'omit'

export interface InputSpec extends PortSpecBase {
  readonly kind: 'input'
  readonly type: TypeExpr
  readonly optional: boolean
  /** Derived boundary input forwarding an edit-time schema literal. */
  readonly outputSchemaSource?: true
  /** Descriptor editor contract projected independently of boundary outputs. */
  readonly outputDescriptors?: OutputDescriptorsSpec
  /** Declared absence policy; undefined = the required-ness default. */
  readonly onAbsent?: AbsentPolicy
  /** The execution accepts storage-backed values directly (wire 39); true or omitted. */
  readonly acceptsStorage?: true
  readonly acceptsStream?: true
  /** Widget backing; when present the input has a value unless connected. */
  readonly widget?: WidgetSpec
  /** Widget-backed input forced to render as a socket. */
  readonly forceInput?: boolean
  /** Backend computation-semantic demand marker (wire 16); true or omitted. */
  readonly lazy?: true
  /** Execution binding for a staged Comfy source filename (wire 22). */
  readonly sourceFilename?: SourceFilenameSpec
  readonly advanced?: boolean
  /** Compatibility-only input retained for compile and serialization, but omitted from authoring surfaces. */
  readonly hidden?: true
  readonly dynamic?: DynamicSpec
}

export interface SourceFilenameSpec {
  readonly kind: 'media/image' | 'media/audio' | 'media/video' | 'data/latent' | 'media/model3d'
  readonly category: 'input' | 'output' | 'temp'
}

/** The effective absence policy: the declaration, or the required-ness
 * default (skip for required inputs, omit for optional ones). */
export const effectiveAbsentPolicy = (spec: InputSpec): AbsentPolicy =>
  spec.onAbsent ?? (spec.optional ? 'omit' : 'skip')

/** One selected asset that can estimate an output before execution. */
export interface OutputRepresents {
  /** Top-level asset-widget input carrying the selected asset. */
  readonly input: string
  /** Client-side conversion from the selected asset to the output. */
  readonly rendition: string
  /** Required DynamicCombo selections for which the representation is sound. */
  readonly applies?: Readonly<Record<string, readonly string[]>>
}

/** True when this frontend can render the declared output rendition. */
export const supportsOutputRepresentation = (
  represents: OutputRepresents | undefined,
): represents is OutputRepresents => represents?.rendition === 'decoded-image'

/** An output equal to one same-typed primitive input before execution. */
export interface OutputKnownValue {
  /** Top-level input whose resolved value is the output value. */
  readonly input: string
}

/** Ordered output schema stored as JSON in an ordinary string input. */
export interface OutputDescriptorsSpec {
  readonly input: string
  readonly choices: readonly (Pick<OutputSpec, 'alphaPolicy' | 'maskPolarity' | 'maskSemantic'> & {
    readonly id: string
    readonly type: Extract<TypeExpr, { kind: 'concrete' }>
    readonly displayName?: string
    readonly optional?: boolean
    readonly preview?: true
    readonly doc?: string
  })[]
  readonly minEntries: number
  readonly maxEntries: number
  readonly fixedIds: boolean
  readonly probe?: { readonly input: string; readonly kind: 'model'; readonly revision: string }
  /** A direct boundary port selects one stable entry, never its position. */
  readonly selectedId?: string
  readonly boundaryProjection?: {
    readonly fallback?: unknown
    readonly fixed?: true
    readonly assetFallback?: unknown
    readonly assetFixed?: true
  }
}

export interface OutputSpec extends PortSpecBase {
  readonly kind: 'output'
  readonly type: TypeExpr
  readonly isList?: boolean
  /**
   * Presentation/discovery-only marker: this final output is offered as a
   * generic run-and-show candidate. It does not promise renderability,
   * retention, caching, liveness, editability, purity, preference, or any
   * runtime preview capability. Wire 16 normalizes this to true or omission.
   */
  readonly preview?: true
  /**
   * The producer may deliberately emit NO value at runtime (a loader with no
   * VAE, a detector with no match). Declared, so edges from it render
   * maybe-absent and validation warns when it feeds a fail-policy input.
   * Skipped is a normal downstream state, never an error.
   */
  readonly optional?: boolean
  /** Presentation-only pre-execution estimate sourced from a selected asset. */
  readonly represents?: OutputRepresents
  /** Exact pre-execution value sourced from a typed primitive identity input. */
  readonly knownValue?: OutputKnownValue
  readonly dynamic?: DynamicSpec | CountBoundOutputAutogrowSpec
  readonly outputDescriptors?: OutputDescriptorsSpec
}

/** Pure-presentation constructs may appear in the ordered interface too. */
export interface SectionSpec {
  readonly kind: 'section'
  readonly id: string
  readonly displayName?: string
  readonly collapsedByDefault?: boolean
}

export type InterfaceItem = InputSpec | OutputSpec | SectionSpec

// ---------------------------------------------------------------------------
// NodeSchema
// ---------------------------------------------------------------------------

/**
 * Structured deprecation (Dinkster schema wire v3 additive field). `message` is
 * required author prose; `replacement` is a cheap NAME-ONLY pointer to the
 * successor type - the *how* of migration lives in replacement rules
 * (replace/model.ts), never here. Pointers may CHAIN (A -> B -> C when B is
 * itself deprecated); resolve transitively with `resolveDeprecationPointer`,
 * never by a single hop.
 */
export interface DeprecationInfo {
  readonly message: string
  readonly since?: string
  readonly replacement?: string
}

/**
 * Search-listing demotion, fully orthogonal to deprecation and to validity:
 * any visibility validates, instantiates, and executes identically.
 * 'deprecated' = listed but demoted; 'hidden' = not listed at all (loading
 * old workflows still works). Omitted = normal.
 */
export type SearchVisibility = 'deprecated' | 'hidden'

export type PackAssetSource =
  | { readonly type: 'packaged'; readonly pack: string; readonly path: string }
  | { readonly type: 'remote'; readonly url: string }

/** Descriptor for immutable bytes declared by a pack; never the bytes themselves. */
export interface PackAssetDescriptor {
  readonly id: string
  readonly name: string
  /** Usually blake3:<64 hex>; kept prefix-tolerant for rolling digest upgrades. */
  readonly digest: string
  readonly kind?: string
  readonly size?: number
  readonly mediaType?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly sources?: readonly PackAssetSource[]
  /** Node types whose instantiation makes this asset a job requirement. */
  readonly nodes?: readonly string[]
}

/**
 * Pack presentation (Dinkster /api/nodes top-level "packs" table): author-
 * declared display identity for compact provenance badges. abbr/mark are
 * NOT identity and may collide across packs; the pack ID is the only
 * lookup key. All fields beyond displayName are optional - omission means
 * "not declared", and the backend never synthesizes fallbacks (deriving
 * initials/colors is a frontend concern). Presentation only: excluded
 * from schema signatures and cache identity on both ends.
 */
export interface PackInfo {
  readonly displayName: string
  /** Short ASCII (<= 8) for search/tooltips. */
  readonly abbr?: string
  /** Single-grapheme badge glyph (emoji allowed). */
  readonly mark?: string
  /** #rrggbb chip color. */
  readonly color?: string
  /**
   * Raster chip icon (64x64 static PNG/WebP), served at
   * GET /api/packs/{packId}/icon. The digest is the immutable content
   * identity (also the endpoint's ETag): bytes for a digest never change,
   * so decoded bitmaps cache forever. Presence here is the ONLY fetch
   * signal - never probe the endpoint blindly.
   */
  readonly icon?: PackIcon
  /**
   * Provenance (environment stamping): all omitted-when-unknown, never
   * null. version appears only for registry releases - unpublished
   * local/git installs have no release identity and the backend never
   * surfaces a fake pin. artifactDigest ('sha256:<hex>') is the real pin
   * for managed installs; source is 'registry' | 'git:<url>@<commit>' |
   * 'local:<path>'; publisher is 'local' for unpublished installs.
   * Records, never identity: nothing load-bearing reads these.
   */
  readonly version?: string
  readonly artifactDigest?: string
  readonly source?: string
  readonly publisher?: string
  /** Pack asset declarations, descriptors only; absent means none declared. */
  readonly assets?: readonly PackAssetDescriptor[]
  /**
   * Pack-shipped blueprints (premade subgraph documents): full descriptors
   * inline so search/browse never fetches bodies. The body rides
   * GET /api/packs/{packId}/blueprints/{id} (immutable, digest ETag).
   * Absent when the pack ships none.
   */
  readonly blueprints?: readonly PackBlueprintDescriptor[]
  /** Immutable pack locale catalogs: canonical locale tag -> exact content digest. */
  readonly locales?: Readonly<Record<string, string>>
  /** Pack declares a validated settings schema available from the pack settings endpoint. */
  readonly settings?: true
}

/** Descriptor for a pack's chip icon; bytes are fetched lazily by digest. */
export interface PackIcon {
  /** 'sha256:<hex>' content digest; the icon endpoint's ETag. */
  readonly digest: string
  /** 'image/png' | 'image/webp' (sniffed server-side from actual bytes). */
  readonly mediaType: string
}

/**
 * One pack-shipped blueprint, descriptor only - the graph document body is
 * fetched lazily and cached forever by digest (a changed blueprint is a
 * new digest). boundaryInputs/boundaryOutputs are author DECLARATIONS
 * passed through verbatim by the backend (never resolved or cross-checked
 * server-side): treat them as untrusted hints for in:/out: search, never
 * as verified interface truth.
 */
export interface PackBlueprintDescriptor {
  /** Blueprint id within the pack (closed name grammar, backend-validated). */
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly tags?: readonly string[]
  /** 'sha256:<hex>' over the exact body bytes; the body endpoint's ETag. */
  readonly digest: string
  /** Declared boundary input type ids (advisory, verbatim passthrough). */
  readonly boundaryInputs?: readonly string[]
  /** Declared boundary output type ids (advisory, verbatim passthrough). */
  readonly boundaryOutputs?: readonly string[]
}

/**
 * A backend-lowered document-time selector (schema wire 15). The document
 * stores one boolean under `input`; its value chooses exactly one of the two
 * branch inputs. This is schema/display fact only: submission still carries
 * the full graph for server-owned lowering.
 */
export interface NodeSelectorSpec {
  readonly input: string
  readonly branches: Readonly<{ false: string; true: string }>
}

export type SelectorBranchDisplay = 'active' | 'inactive' | 'neutral'

export type ExecutionArm = 'native' | 'comfyui'

export type ConditionalWidgetValue = null | string | boolean | number

export interface ConditionalWidgetCondition {
  readonly input: string
  readonly values: readonly ConditionalWidgetValue[]
}

export interface ConditionalWidgetGroup {
  readonly input: string
  readonly values: readonly ConditionalWidgetValue[]
  readonly members: readonly string[]
  readonly requires?: readonly ConditionalWidgetCondition[]
}

export type MirrorKind = 'expression' | 'glsl'

export type MirrorPrecision = 'exact' | 'bounded'

/** Declared accuracy bounds for a bounded mirror; at least one bound is present. */
export interface MirrorTolerance {
  readonly relative?: number
  readonly perChannel?: number
}

/**
 * Backend-declared recipe for locally recomputing a node's output for
 * display (wire 29). Presentation only: never part of interface signatures,
 * and the backend never executes it - the frontend may evaluate it to show
 * an estimate while the authoritative backend result is pending. An
 * 'expression' mirror names the shared expression grammar version and
 * carries no source; a 'glsl' mirror carries its shader source. 'exact'
 * mirrors reproduce the backend bit-for-bit and carry no tolerance;
 * 'bounded' mirrors declare their tolerance.
 */
export interface MirrorSpec {
  readonly kind: MirrorKind
  readonly precision: MirrorPrecision
  readonly tolerance?: MirrorTolerance
  readonly grammarVersion?: number
  readonly source?: string
  /**
   * Combo values the mirror covers (wire 30): each key names a declared
   * combo input and maps to the option keys the mirror can reproduce. An
   * estimate renders only when every named combo's resident value is in
   * its covered set - a mirror has no abstain channel of its own, so this
   * scope is what keeps a partially mirrorable node from producing wrong
   * estimates rather than missing ones. Absent means the mirror covers
   * the node's whole input space.
   */
  readonly applies?: Readonly<Record<string, readonly string[]>>
}

export interface NodeSchema {
  /** Node type id ('KSampler') or subgraph-derived id ('#<GraphDefId>'). */
  readonly type: string
  /** Frontend-owned node kind that is never sent to an execution backend. */
  readonly virtual?: true
  readonly displayName: string
  readonly category: string
  /** Backend-declared role used to bind rich editors without node-type knowledge. */
  readonly editorRole?: string
  /**
   * Owning pack id, host-attached by the backend at schema collection
   * (never self-claimed by the schema): 'core' for Dinkster std nodes, the
   * pack's id otherwise. Absent on non-Dinkster sources (ComfyUI V1,
   * subgraph-derived). Presentation/attribution only - never identity.
   */
  readonly pack?: string
  /**
   * Backend-computed content hash of the node's computational interface
   * (Dinkster native only; presentation/lifecycle/admission hints excluded -
   * same exclusions as cache identity). Opaque: compared for equality
   * only, never parsed. The precise drift key for environment stamps: a
   * pack version can change while a node's signature stays identical
   * (interface unchanged), or a dev pack's signature can change with no
   * version bump.
   */
  readonly signature?: string
  /** User-facing execution implementations available for this node type. */
  readonly executionArms?: readonly ExecutionArm[]
  readonly description?: string
  readonly source: SchemaSource
  /** Ordered as declared. Inputs, outputs, sections - any order. */
  readonly items: readonly InterfaceItem[]
  readonly isOutputNode: boolean
  /**
   * This node's execution emits live previews (sampling previews etc.).
   * Declarative capability from the backend schema (wire 24): gates the
   * per-node Live Previews affordances, and the backend skips preview
   * work entirely for unflagged types. On subgraph-derived schemas, true
   * iff any inner node's schema declares it. Absent means not capable
   * (older backends: absent everywhere, and consumers should keep the
   * affordances available rather than hide them all).
   */
  readonly emitsPreviews?: boolean
  /** Full help content is available from the paged docs catalog (wire 42). */
  readonly hasDocs?: boolean
  /**
   * Frontend-renderable mirror of this node's computation (wire 29).
   * Presentation only: excluded from interface signatures, never executed
   * by the backend, and absent on nodes without a declared mirror.
   */
  readonly mirror?: MirrorSpec
  readonly chunkSafe?: {
    readonly inputs: readonly string[]
    readonly outputs: readonly string[]
    readonly applies?: Readonly<Record<string, readonly string[]>>
  }
  /** Legacy V1 boolean flag; Dinkster backends use `deprecation` instead. */
  readonly deprecated?: boolean
  /** Structured deprecation (message/since/replacement pointer). */
  readonly deprecation?: DeprecationInfo
  /** Explicit search demotion; omitted = normal. See searchVisibilityOf. */
  readonly searchVisibility?: SearchVisibility
  readonly experimental?: boolean
  readonly searchAliases?: readonly string[]
  /** Frontend-only discoverability vocabulary (wire v8; never resolution or identity). */
  readonly searchTerms?: readonly string[]
  /**
   * Legacy type names this schema also answers to (e.g. the bare ComfyUI
   * class_type 'EmptyImage' for 'comfy.EmptyImage'). Resolution only, never
   * identity: documents keep whatever name they were authored with, and a
   * canonical type id always outranks an alias.
   */
  readonly aliases?: readonly string[]
  /**
   * Replacement rules this schema SHIPS (usually the successor describing
   * how to migrate its predecessors - each rule's `from` names the source
   * type, which need not be this schema). Registered at the 'schema' layer
   * of the replacement registry; see replace/model.ts.
   */
  readonly replacements?: readonly ReplacementRule[]
  /** Hidden inputs the compiler must inject (V1 wire names preserved). */
  readonly hidden?: readonly string[]
  /** Optional server-owned document-time branch selector (schema wire 15). */
  readonly selector?: NodeSelectorSpec
  /** Presentation-only visibility groups for top-level static widgets (wire 27). */
  readonly widgetGroups?: readonly ConditionalWidgetGroup[]
  readonly ext?: Readonly<Record<string, unknown>>
}

export function schemaForEditorRole(schemas: Iterable<NodeSchema>, role: string): NodeSchema | undefined {
  const matches = [...schemas].filter((schema) => schema.editorRole === role)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Derive display treatment from the STORED selector boolean. Missing or
 * malformed stored state is neutral: the server remains authoritative for
 * value validation, and the canvas must not guess which branch will run.
 */
export const selectorBranchDisplay = (
  schema: NodeSchema,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, SelectorBranchDisplay>> | undefined => {
  const selector = schema.selector
  if (selector === undefined) return undefined
  const selected = values[selector.input]
  if (typeof selected !== 'boolean') {
    return {
      [selector.branches.false]: 'neutral',
      [selector.branches.true]: 'neutral',
    }
  }
  const active = selector.branches[String(selected) as 'false' | 'true']
  const inactive = selector.branches[String(!selected) as 'false' | 'true']
  return { [active]: 'active', [inactive]: 'inactive' }
}

/**
 * Effective search listing for a schema. Explicit `searchVisibility` wins;
 * otherwise deprecation (structured or legacy boolean) infers a soft
 * demotion. This inference is deliberately FRONTEND-side: the backend never
 * auto-demotes. (The wire omits 'normal', so a deprecated node cannot
 * currently opt back into normal listing - acceptable until someone asks.)
 */
export const searchVisibilityOf = (s: NodeSchema): 'normal' | SearchVisibility =>
  s.searchVisibility ?? (isDeprecated(s) ? 'deprecated' : 'normal')

/** Deprecated via the structured field OR the legacy V1 boolean. */
export const isDeprecated = (s: NodeSchema): boolean =>
  s.deprecation !== undefined || s.deprecated === true

/** Convenience accessors (derive, don't store). */
export const inputsOf = (s: NodeSchema): readonly InputSpec[] =>
  s.items.filter((i): i is InputSpec => i.kind === 'input')
export const outputsOf = (s: NodeSchema): readonly OutputSpec[] =>
  s.items.filter((i): i is OutputSpec => i.kind === 'output')
export const hasPreviewSurface = (s: NodeSchema): boolean =>
  s.emitsPreviews === true || outputsOf(s).some((output) => output.preview === true)
export const outputCountInputsOf = (s: NodeSchema): readonly string[] =>
  [...new Set(outputsOf(s).flatMap((output) =>
    output.dynamic?.kind === 'autogrow' && 'count' in output.dynamic
      ? output.dynamic.count.boundaryProjection?.fixed === true ? [] : [output.dynamic.count.input]
      : []))]

/** Inputs whose literal values determine the edit-time output interface. */
export const outputSchemaInputsOf = (s: NodeSchema): readonly string[] =>
  [...new Set([...outputCountInputsOf(s), ...inputsOf(s).filter((input) => input.outputSchemaSource).map((input) => input.id), ...outputsOf(s).flatMap((output) => {
    const spec = output.outputDescriptors
    return spec === undefined ? [] : [
      ...(spec.boundaryProjection?.fixed ? [] : [spec.input]),
      ...(spec.probe === undefined || spec.boundaryProjection?.assetFixed ? [] : [spec.probe.input]),
    ]
  })])]

/** An input whose concrete core.combo value is edited by a combo dropdown. */
export const isComboWidgetInput = (spec: InputSpec): boolean =>
  spec.widget?.widgetType === 'COMBO'

export const isImageAssetInput = (spec: InputSpec): boolean => {
  const type = canonicalTypeIdOf(spec.type)
  return spec.hidden !== true && spec.widget?.widgetType === 'ASSET' &&
    (type === 'asset<comfy.IMAGE>' || type === 'asset<dinkster.image>')
}

/**
 * Materialize keyed widget defaults for a FRESH node instance. Visible defaults
 * are copied into the document at creation so a later schema change never
 * silently reinterprets a saved workflow (reproducibility beats derivation
 * here). Hidden compatibility inputs and inputs without a declared default are
 * absent.
 */
export const defaultValuesOf = (s: NodeSchema): Record<string, unknown> => {
  const values: Record<string, unknown> = {}
  for (const item of s.items) {
    if (item.kind === 'input' && item.hidden !== true && item.dynamic?.kind !== 'dynamicCombo' &&
        item.widget && item.widget.default !== undefined) {
      values[item.id] = item.widget.default
    }
  }
  return values
}

/**
 * Materialize required wire-15 family members and DynamicCombo selections for
 * a fresh node. Combo defaults do not participate; recurse only through the
 * active branch and members that exist at creation.
 */
export const initialDynamicStateOf = (
  s: NodeSchema,
): Record<string, {
  readonly selected?: string
  readonly members?: readonly string[]
  readonly seq?: number
}> => {
  const state: Record<string, {
    readonly selected?: string
    readonly members?: readonly string[]
    readonly seq?: number
  }> = {}
  const visit = (items: readonly InputSpec[], prefix: string): void => {
    for (const item of items) {
      const dynamic = item.dynamic
      const construct = joinValuePath(prefix, item.id)
      if (dynamic?.kind === 'autogrow' && dynamic.materialization === 'wire15') {
        const { min } = autogrowBounds(dynamic)
        if (min === 0 || dynamic.naming.kind === 'native') continue
        const members = dynamic.naming.kind === 'names'
          ? dynamic.naming.names.slice(0, min)
          : Array.from({ length: min }, (_, index) => `m${index}`)
        state[construct] = {
          members,
          ...(dynamic.naming.kind === 'prefix' ? { seq: min } : {}),
        }
        for (const member of members) visit(dynamic.template, joinValuePath(construct, member))
        continue
      }
      if (dynamic?.kind !== 'dynamicCombo' || dynamic.materialization !== 'wire15') continue
      const option = dynamic.options[0]
      if (option === undefined) continue
      state[construct] = { selected: option.key }
      visit(option.inputs, construct)
    }
  }
  visit(inputsOf(s), '')
  return state
}
