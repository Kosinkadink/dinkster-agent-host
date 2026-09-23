/**
 * Structured search filters: the `kind:` / `in:` / `out:` token grammar
 * shared by every node-shaped search surface (add-node palette, link-drop
 * search, and blueprint browsing later). Parsing lives in core so the
 * grammar behaves identically everywhere; the residual text ranks through
 * the shared scorer exactly as before.
 *
 * Port filters match by TYPE STRUCTURE, never by enumerating concrete
 * forms: a generic node declaring `variable T allowed {image, latent}` is
 * ONE entry that matches both `in:image` and `in:latent`, because the
 * variable's allowed set is consulted - the "many forms of one node"
 * problem is solved by the type grammar, not by search pollution. The
 * same walk covers dynamic interfaces (autogrow templates, dynamicCombo
 * option sets, dynamicSlot dependents), so inputs that only exist in some
 * elaborations still make the node findable.
 */

import { atomNamesOf, typesCompatible } from './schema/type-compatibility.js'
import { elaborateInterface, materializeFramesOf, type MaterializeFrame } from './schema/elaborate.js'
import {
  defaultValuesOf,
  initialDynamicStateOf,
  inputsOf,
  outputsOf,
  parseAssetTypeId,
  parseStreamTypeId,
  parseListTypeId,
  type DynamicSpec,
  type InputSpec,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from './schema/model.js'
import type { Json } from './format/document.js'

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/** Parsed structured filters plus the residual free-text query. */
export interface SearchFilters {
  /** The query with filter tokens removed; ranks through the shared scorer. */
  readonly text: string
  /** `kind:` tokens, lowercased and deduped. Undefined = no kind filter. */
  readonly kinds?: ReadonlySet<string>
  /** `in:` type tokens; EVERY one must be accepted by some input. */
  readonly inputs?: readonly string[]
  /** `out:` type tokens; EVERY one must be producible by some output. */
  readonly outputs?: readonly string[]
}

const FILTER_TOKEN = /^(kind|in|out):(.*)$/i

/**
 * Split a query into structured filter tokens and residual text. A filter
 * prefix with an EMPTY value (`in:` mid-typing) is ignored entirely - the
 * result set stays full while the user is still typing the type name.
 * Unknown prefixes stay in the text and rank as ordinary tokens.
 */
export function parseSearchFilters(query: string): SearchFilters {
  const kinds = new Set<string>()
  const inputs: string[] = []
  const outputs: string[] = []
  const text: string[] = []
  for (const token of query.trim().split(/\s+/).filter((t) => t.length > 0)) {
    const m = FILTER_TOKEN.exec(token)
    if (!m) {
      text.push(token)
      continue
    }
    const value = m[2]!.toLowerCase()
    if (value.length === 0) continue // incomplete filter: no-op, not a text token
    const prefix = m[1]!.toLowerCase()
    if (prefix === 'kind') kinds.add(value)
    else if (prefix === 'in') inputs.push(value)
    else outputs.push(value)
  }
  return {
    text: text.join(' '),
    ...(kinds.size > 0 ? { kinds } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(outputs.length > 0 ? { outputs } : {}),
  }
}

// ---------------------------------------------------------------------------
// Type-token matching
// ---------------------------------------------------------------------------

/**
 * A concrete atom name matches a token by full id or by its last
 * dot-segment, case-insensitively: 'image' hits both V1 'IMAGE' and Dinkster
 * 'core.image'; a fully-qualified 'core.image' hits only that atom.
 */
const nameMatchesToken = (name: string, token: string): boolean => {
  const n = name.toLowerCase()
  const t = token.toLowerCase()
  if (n === t) return true
  const lastSegment = n.slice(n.lastIndexOf('.') + 1)
  return lastSegment === t
}

/**
 * Whether a declared port type can be the token's type in SOME form.
 * Structural, mirroring the solver's stance: variables consult their
 * allowed set (unconstrained = anything), unions any member, wildcards
 * everything. A structured token remains exact about its wrappers, while a
 * base token also discovers that base recursively inside list/asset wrappers.
 * This is a discovery rule only; it does not weaken connection compatibility.
 */
export function typeMatchesToken(t: TypeExpr, token: string): boolean {
  const listInner = parseListTypeId(token)
  const assetInner = parseAssetTypeId(token)
  const streamInner = parseStreamTypeId(token)
  switch (t.kind) {
    case 'wildcard':
      return true
    case 'variable':
      return t.allowedTypes === undefined || t.allowedTypes.some((a) => typeMatchesToken(a, token))
    case 'concrete':
      return listInner === undefined && assetInner === undefined && streamInner === undefined && nameMatchesToken(t.name, token)
    case 'union':
      return listInner === undefined && assetInner === undefined && streamInner === undefined && t.names.some((n) => nameMatchesToken(n, token))
    case 'list':
      return listInner !== undefined
        ? typeMatchesToken(t.element, listInner)
        : assetInner === undefined && streamInner === undefined && typeMatchesToken(t.element, token)
    case 'asset':
      return assetInner !== undefined
        ? typeMatchesToken(t.element, assetInner)
        : listInner === undefined && streamInner === undefined && typeMatchesToken(t.element, token)
    case 'stream':
      return streamInner !== undefined
        ? typeMatchesToken(t.element, streamInner)
        : listInner === undefined && assetInner === undefined && typeMatchesToken(t.element, token)
  }
}

// ---------------------------------------------------------------------------
// Schema port matching
// ---------------------------------------------------------------------------

function* dynamicInputTypes(spec: DynamicSpec): Generator<TypeExpr> {
  switch (spec.kind) {
    case 'autogrow':
      for (const input of spec.template) yield* inputTypesOf(input)
      return
    case 'dynamicCombo':
      for (const option of spec.options) for (const input of option.inputs) yield* inputTypesOf(input)
      return
    case 'dynamicSlot':
      yield spec.slotType
      for (const input of spec.inputs) yield* inputTypesOf(input)
      return
  }
}

function* inputTypesOf(input: InputSpec): Generator<TypeExpr> {
  if (input.hidden === true) return
  yield input.type
  if (input.dynamic) yield* dynamicInputTypes(input.dynamic)
}

function* outputTypesOf(output: OutputSpec): Generator<TypeExpr> {
  yield output.type
  // A dynamic output family's template inputs remain inputs; only slot types
  // surface here.
  if (output.dynamic?.kind === 'dynamicSlot') yield output.dynamic.slotType
}

/** Every declared input type, including dynamic elaboration surfaces. */
export function* schemaInputTypes(schema: NodeSchema): Generator<TypeExpr> {
  for (const input of inputsOf(schema)) yield* inputTypesOf(input)
}

/** Every declared output type, including dynamic elaboration surfaces. */
export function* schemaOutputTypes(schema: NodeSchema): Generator<TypeExpr> {
  for (const output of outputsOf(schema)) yield* outputTypesOf(output)
}

/**
 * Whether declared type-id HINTS satisfy the port filters - the blueprint
 * path, where descriptors carry author-declared boundaryInputs/
 * boundaryOutputs strings instead of a schema. Hints are untrusted
 * declarations passed through verbatim by the backend, so matching is the
 * same tolerant name rule as concrete types (full id or last dot-segment,
 * case-insensitive). No hints declared = unknown interface = excluded
 * when a port filter is active (declaring hints is how a blueprint opts
 * into port search).
 */
export function hintsMatchPortFilters(
  hints: { readonly inputs?: readonly string[]; readonly outputs?: readonly string[] },
  filters: Pick<SearchFilters, 'inputs' | 'outputs'>,
): boolean {
  for (const token of filters.inputs ?? []) {
    if (!(hints.inputs ?? []).some((h) => nameMatchesToken(h, token))) return false
  }
  for (const token of filters.outputs ?? []) {
    if (!(hints.outputs ?? []).some((h) => nameMatchesToken(h, token))) return false
  }
  return true
}

/** Multi-select OR variant of hintsMatchPortFilters. */
export function hintsMatchAnyPortFilters(
  hints: { readonly inputs?: readonly string[]; readonly outputs?: readonly string[] },
  filters: Pick<SearchFilters, 'inputs' | 'outputs'>,
): boolean {
  if (filters.inputs?.length && !filters.inputs.some((token) => (hints.inputs ?? []).some((hint) => nameMatchesToken(hint, token)))) return false
  if (filters.outputs?.length && !filters.outputs.some((token) => (hints.outputs ?? []).some((hint) => nameMatchesToken(hint, token)))) return false
  return true
}

// ---------------------------------------------------------------------------
// Link-drop compatibility
// ---------------------------------------------------------------------------

/**
 * Link-drop insertion requires a proven ANCHOR type. The ordinary advisory
 * compatibility contract deliberately treats wildcards and unconstrained
 * variables as "possibly compatible" so stale documents remain editable.
 * A generic candidate input/output may intentionally accept that known
 * anchor, but an untyped dangling end cannot open an accept-all palette.
 */
export const hasKnownLinkDropAnchorType = (type: TypeExpr): boolean => {
  switch (type.kind) {
    case 'concrete':
      return type.name.length > 0
    case 'union':
      return type.names.length > 0 && type.names.every((name) => name.length > 0)
    case 'wildcard':
      return false
    case 'variable':
      return type.allowedTypes !== undefined &&
        type.allowedTypes.length > 0 &&
        type.allowedTypes.every(hasKnownLinkDropAnchorType)
    case 'list':
    case 'asset':
    case 'stream':
      return hasKnownLinkDropAnchorType(type.element)
  }
}

/**
 * Whether a schema can terminate a dangling noodle. The anchor is the
 * FIXED end's type; `seeking` is what the dragged end looks for, exactly
 * as the canvas drag gesture names it: seeking 'in' means the anchor is a
 * source and the schema must ACCEPT the anchor type at some input;
 * seeking 'out' means the anchor is an input and some output must FEED
 * it. The dangling anchor must prove a closed type domain. Matching then
 * resolves the same fresh elaborated surface used by target selection,
 * including initial autogrow members and active dynamic forms. Explicitly
 * generic candidate ports remain valid fallbacks, after any compatible
 * closed-domain port. The core.combo participates as an ordinary concrete
 * atom, so this function needs no widget-specific vocabulary or provenance
 * rules.
 */
export function schemaMatchesLinkDrop(
  schema: NodeSchema,
  anchorType: TypeExpr,
  seeking: 'in' | 'out',
): boolean {
  return autoConnectTarget(schema, anchorType, seeking) !== undefined
}

/**
 * The auto-connect target after a link-drop insertion, resolved against the
 * FRESH node's elaborated interface (default values, no dynamic state, no
 * connections) - the same surface the canvas will render the moment the
 * node lands. Closed-domain targets win over intentionally generic targets;
 * interface order wins within each class, mirroring canvas priority.
 * Dynamic surfaces are first-class: an autogrow family's min-fill/ghost
 * member is a legal target, carrying the `dynamic.materialize` frames the
 * connect must batch with (hazard N3), and a DynamicCombo's DEFAULT branch
 * inputs are real addressable ports. Selector rows (branch switching goes
 * through dynamic.selectOption, never link.connect) and unknown-kind
 * placeholders are never targets. Undefined = insert unconnected.
 */
export interface AutoConnectTarget {
  /** link.connect endpoint port (family slot path for dynamic members). */
  readonly port: string
  /** link.connect endpoint members, when the target is a family member. */
  readonly members?: readonly string[]
  /** dynamic.materialize frames the connect must batch with, when the target is synthetic. */
  readonly materialize?: readonly MaterializeFrame[]
}

export function autoConnectTarget(
  schema: NodeSchema,
  anchorType: TypeExpr,
  seeking: 'in' | 'out',
): AutoConnectTarget | undefined {
  if (!hasKnownLinkDropAnchorType(anchorType)) return undefined
  const values = defaultValuesOf(schema) as Record<string, Json>
  const { items, diagnostics } = elaborateInterface(schema, {
    values,
    dynamic: initialDynamicStateOf(schema),
  })
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return undefined
  let genericFallback: AutoConnectTarget | undefined
  for (const item of items) {
    if (item.kind === 'section' || item.kind === 'growth') continue
    if ((item.kind === 'input') !== (seeking === 'in')) continue
    if (item.kind === 'input' && item.spec.hidden === true) continue
    if (item.origin.kind === 'selector' || item.origin.kind === 'unknown') continue
    if (item.kind === 'output' && item.wireable === false) continue
    const ok =
      seeking === 'in'
        ? typesCompatible(anchorType, item.spec.type)
        : typesCompatible(item.spec.type, anchorType)
    if (!ok) continue
    const frames = materializeFramesOf(items, item)
    const target: AutoConnectTarget = {
      port: item.address.port,
      ...(item.address.members !== undefined ? { members: item.address.members } : {}),
      ...(frames !== undefined ? { materialize: frames } : {}),
    }
    if (hasKnownLinkDropAnchorType(item.spec.type)) return target
    genericFallback ??= target
  }
  return genericFallback
}

/** Case-insensitive full-id or last-dot-segment name equivalence. */
const lastSegment = (n: string): string => {
  const l = n.toLowerCase()
  return l.slice(l.lastIndexOf('.') + 1)
}

/**
 * Whether blueprint boundary HINTS can terminate a dangling noodle - the
 * descriptor path, where only author-declared type-id strings exist. The
 * anchor's atom set is
 * compared against the relevant hint list by the same tolerant name rule
 * as port filters: full id or last dot-segment, case-insensitive. No
 * hints on the seeking side = unknown interface = excluded, mirroring
 * hintsMatchPortFilters (declaring hints is how a blueprint opts into
 * port-constrained search).
 */
export function hintsMatchLinkDrop(
  hints: { readonly inputs?: readonly string[]; readonly outputs?: readonly string[] },
  anchorType: TypeExpr,
  seeking: 'in' | 'out',
): boolean {
  const declared = seeking === 'in' ? hints.inputs : hints.outputs
  if (declared === undefined || declared.length === 0) return false
  if (!hasKnownLinkDropAnchorType(anchorType)) return false
  const atoms = atomNamesOf(anchorType)
  if (atoms === undefined) return false
  return declared.some((h) =>
    atoms.some((a) => h.toLowerCase() === a.toLowerCase() || lastSegment(h) === lastSegment(a)),
  )
}

/**
 * Whether a schema satisfies the port filters: every `in:` token accepted
 * by some input in SOME form, every `out:` token producible by some
 * output. Kind filtering is the caller's concern (schemas don't know what
 * kind of palette entry carries them).
 */
export function schemaMatchesPortFilters(
  schema: NodeSchema,
  filters: Pick<SearchFilters, 'inputs' | 'outputs'>,
): boolean {
  for (const token of filters.inputs ?? []) {
    let hit = false
    for (const t of schemaInputTypes(schema)) {
      if (typeMatchesToken(t, token)) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  for (const token of filters.outputs ?? []) {
    let hit = false
    for (const t of schemaOutputTypes(schema)) {
      if (typeMatchesToken(t, token)) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

/**
 * Multi-select palette semantics: selections are ORed within each direction,
 * while an active input group and output group are both required.
 */
export function schemaMatchesAnyPortFilters(
  schema: NodeSchema,
  filters: Pick<SearchFilters, 'inputs' | 'outputs'>,
): boolean {
  const inputs = filters.inputs
  if (inputs !== undefined && inputs.length > 0 && !inputs.some((token) =>
    [...schemaInputTypes(schema)].some((type) => typeMatchesToken(type, token)),
  )) return false
  const outputs = filters.outputs
  if (outputs !== undefined && outputs.length > 0 && !outputs.some((token) =>
    [...schemaOutputTypes(schema)].some((type) => typeMatchesToken(type, token)),
  )) return false
  return true
}
