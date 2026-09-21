/**
 * /object_info parser: the ONE place raw schema JSON is understood.
 *
 * The wire format is V1-shaped even for V3-authored nodes (see
 * ComfyUI comfy_api/latest/_io.py, Schema.get_v1_info). V3 data survives as:
 * - `input_order`: declaration order within required/optional groups
 * - `widgetType` in input options (MultiType widget inputs)
 * - dynamic constructs as inputs typed COMFY_AUTOGROW_V3 /
 *   COMFY_DYNAMICCOMBO_V3 / COMFY_DYNAMICSLOT_V3 with their config in options
 * - MultiType as comma-joined type string ('IMAGE,MASK') typed COMFY_MULTITYPED_V3
 *   semantics, MatchType as COMFY_MATCHTYPE_V3 with options.template
 * - combo `remote` options object
 * - output MatchType template ids in `output_matchtypes` (allowed_types LOST
 *   on the wire - flagged as backend co-evolution item)
 *
 * Everything V1-legacy-specific in here is quarantined for deletion once the
 * backend speaks V3 (or successor) natively.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type {
  DynamicSpec,
  InputSpec,
  InterfaceItem,
  NodeSchema,
  OutputSpec,
  RemoteSourceSpec,
  TypeExpr,
  WidgetSpec,
} from './model.js'

// Wire type markers (V3 constructs embedded in the V1 shape).
const T_AUTOGROW = 'COMFY_AUTOGROW_V3'
const T_DYNAMIC_COMBO = 'COMFY_DYNAMICCOMBO_V3'
const T_DYNAMIC_SLOT = 'COMFY_DYNAMICSLOT_V3'
const T_MATCHTYPE = 'COMFY_MATCHTYPE_V3'
const T_MULTITYPE = 'COMFY_MULTITYPED_V3'

/**
 * Keep discovery bounded by the same nesting limit as elaboration. This is a
 * separate guard because an attacker can make parsing recurse before an
 * elaborator ever sees the schema; relying on the later budget would protect
 * rendering while leaving node discovery vulnerable.
 */
const MAX_DYNAMIC_PARSE_DEPTH = 16
interface DynamicParseBudget { remaining: number; reported: boolean }

/** Widget-backed wire types: the type string implies a WidgetKind. */
const WIDGET_TYPES: Readonly<Record<string, string>> = {
  INT: 'INT',
  FLOAT: 'FLOAT',
  STRING: 'STRING',
  BOOLEAN: 'BOOLEAN',
  COMBO: 'COMBO',
  COLOR: 'COLOR',
  WEBCAM: 'WEBCAM',
}

type WireOptions = Record<string, unknown>
/** A wire input: [type, options?] where type is string or legacy combo array. */
type WireInput = readonly [string | readonly unknown[], WireOptions?] | readonly [string | readonly unknown[]]

export interface ObjectInfoEntry {
  readonly input?: {
    readonly required?: Record<string, WireInput>
    readonly optional?: Record<string, WireInput>
    readonly hidden?: Record<string, unknown>
  }
  readonly input_order?: { readonly required?: string[]; readonly optional?: string[] }
  readonly output?: readonly (string | readonly unknown[])[]
  readonly output_is_list?: readonly boolean[]
  readonly output_name?: readonly string[]
  readonly output_tooltips?: readonly (string | null)[]
  readonly output_matchtypes?: readonly (string | null)[] | null
  /** Serialized class INPUT_IS_LIST compatibility flag. */
  readonly is_input_list?: boolean
  readonly name?: string
  readonly display_name?: string
  readonly description?: string
  readonly category?: string
  readonly output_node?: boolean
  readonly deprecated?: boolean
  readonly experimental?: boolean
  readonly search_aliases?: readonly string[] | null
  readonly api_node?: boolean
}

export interface ParseResult {
  readonly schema: NodeSchema | undefined
  readonly diagnostics: readonly Diagnostic[]
}

// ---------------------------------------------------------------------------
// Type expression parsing
// ---------------------------------------------------------------------------

function parseTypeExpr(wireType: string | readonly unknown[], options: WireOptions): TypeExpr {
  if (Array.isArray(wireType)) {
    // Legacy V1 combo: type IS the options array.
    return { kind: 'concrete', name: 'COMBO' }
  }
  const t = wireType as string
  if (t === '*') return { kind: 'wildcard' }
  if (t === T_MATCHTYPE) {
    const template = options['template'] as { template_id?: string; allowed_types?: string } | undefined
    const allowed = parseAllowedTypes(template?.allowed_types)
    return {
      kind: 'variable',
      templateId: template?.template_id ?? 'T',
      ...(allowed ? { allowedTypes: allowed } : {}),
    }
  }
  if (t.includes(',')) {
    // MultiType serializes as comma-joined names (with or without the marker type).
    return { kind: 'union', names: t.split(',').map((s) => s.trim()).filter(Boolean) }
  }
  if (t === T_MULTITYPE) {
    return { kind: 'wildcard' } // degenerate MultiType with no listed types
  }
  return { kind: 'concrete', name: t }
}

function parseAllowedTypes(allowed: string | undefined): readonly TypeExpr[] | undefined {
  if (!allowed) return undefined
  const names = allowed.split(',').map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) return undefined
  return names.map((name) => (name === '*' ? { kind: 'wildcard' as const } : { kind: 'concrete' as const, name }))
}

// ---------------------------------------------------------------------------
// Widget parsing
// ---------------------------------------------------------------------------

function parseWidget(
  wireType: string | readonly unknown[],
  options: WireOptions,
): WidgetSpec | undefined {
  // Legacy V1 combo: options array as the type slot.
  if (Array.isArray(wireType)) {
    const firstOption = wireType[0]
    const implicitDefault = Array.isArray(firstOption) ? firstOption[0] : firstOption
    return {
      widgetType: 'COMBO',
      options: { options: wireType },
      ...(options['default'] !== undefined
        ? { default: options['default'] }
        : implicitDefault !== undefined
          ? { default: implicitDefault }
          : {}),
      ...(options['control_after_generate'] ? { controller: 'after_generate' as const } : {}),
    }
  }
  const t = wireType as string
  // Explicit widgetType (V3 MultiType-with-widget, custom widget kinds).
  const explicit = typeof options['widgetType'] === 'string' ? (options['widgetType'] as string) : undefined
  const widgetType = explicit ?? WIDGET_TYPES[t]
  if (widgetType === undefined) return undefined
  if (options['forceInput'] === true && explicit === undefined) {
    // forceInput widget still carries widget config; keep the spec, flag handled by caller.
  }
  const { widgetType: _wt, forceInput: _fi, default: dflt, remote, control_after_generate, control_after_refresh: _controlAfterRefresh, ...rest } = options
  const parsedRemote = isRemote(remote) ? parseRemote(remote) : undefined
  const spec: WidgetSpec = {
    widgetType,
    options: rest,
    ...(dflt !== undefined ? { default: dflt } : widgetType === 'COLOR' ? { default: '#ffffff' } : {}),
    ...(control_after_generate ? { controller: 'after_generate' as const } : {}),
    ...(widgetType === 'COMBO' && parsedRemote?.controlAfterRefresh !== undefined
      ? { controller: 'after_refresh' as const }
      : {}),
    ...(parsedRemote ? { remote: parsedRemote } : {}),
  }
  return spec
}

function isRemote(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['route'] === 'string'
}

function parseRemote(r: Record<string, unknown>): RemoteSourceSpec {
  const controlAfterRefresh: RemoteSourceSpec['controlAfterRefresh'] = r['control_after_refresh'] === 'first' || r['control_after_refresh'] === 'last'
    ? r['control_after_refresh']
    : undefined
  return {
    route: r['route'] as string,
    ...(r['refresh_button'] !== undefined ? { refreshButton: Boolean(r['refresh_button']) } : {}),
    ...(controlAfterRefresh !== undefined ? { controlAfterRefresh } : {}),
    ...(typeof r['timeout'] === 'number' ? { timeoutMs: r['timeout'] as number } : {}),
    ...(typeof r['max_retries'] === 'number' ? { maxRetries: r['max_retries'] as number } : {}),
    ...(typeof r['refresh'] === 'number' ? { refreshMs: r['refresh'] as number } : {}),
  }
}

function parseMultiComboRemote(value: unknown, where: string): RemoteSourceSpec | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: multiselect remote must be an object`)
  }
  const remote = value as Record<string, unknown>
  const unknown = Object.keys(remote).filter((key) =>
    !['route', 'refresh_button', 'control_after_refresh', 'timeout', 'max_retries', 'refresh'].includes(key))
  if (unknown.length > 0) throw new Error(`${where}: unsupported multiselect remote field '${unknown.sort().join(', ')}'`)
  if (typeof remote['route'] !== 'string' || !/^\/api\/choices\/[A-Za-z0-9._-]+$/.test(remote['route'])) {
    throw new Error(`${where}: multiselect remote route must be /api/choices/{choice_id}`)
  }
  if (typeof remote['refresh_button'] !== 'boolean') {
    throw new Error(`${where}: multiselect remote refresh_button must be a boolean`)
  }
  const control = remote['control_after_refresh']
  if (control !== undefined && control !== 'first' && control !== 'last') {
    throw new Error(`${where}: multiselect remote control_after_refresh must be first or last`)
  }
  if (control !== undefined && remote['refresh_button'] !== true) {
    throw new Error(`${where}: multiselect remote control_after_refresh requires refresh_button true`)
  }
  for (const [field, low, high] of [
    ['timeout', 1, 60_000],
    ['max_retries', 0, 5],
    ['refresh', 0, 86_400_000],
  ] as const) {
    const fieldValue = remote[field]
    if (fieldValue !== undefined &&
      (typeof fieldValue !== 'number' || !Number.isSafeInteger(fieldValue) || fieldValue < low || fieldValue > high)) {
      throw new Error(`${where}: multiselect remote ${field} must be an integer in ${low}..${high}`)
    }
  }
  return {
    route: remote['route'],
    refreshButton: remote['refresh_button'],
    ...(control !== undefined ? { controlAfterRefresh: control } : {}),
    ...(remote['timeout'] !== undefined ? { timeoutMs: remote['timeout'] as number } : {}),
    ...(remote['max_retries'] !== undefined ? { maxRetries: remote['max_retries'] as number } : {}),
    ...(remote['refresh'] !== undefined ? { refreshMs: remote['refresh'] as number } : {}),
  }
}

// ---------------------------------------------------------------------------
// Dynamic construct parsing
// ---------------------------------------------------------------------------

function parseDynamic(
  nodeType: string,
  id: string,
  wireType: string,
  options: WireOptions,
  optional: boolean,
  diags: Diagnostic[],
  depth: number,
  budget: DynamicParseBudget,
): InputSpec | undefined {
  if (wireType !== T_AUTOGROW && wireType !== T_DYNAMIC_COMBO && wireType !== T_DYNAMIC_SLOT) return undefined
  const presentation = {
    ...(typeof options['display_name'] === 'string' ? { displayName: options['display_name'] as string } : {}),
    ...(typeof options['tooltip'] === 'string' ? { tooltip: options['tooltip'] as string } : {}),
  }
  if (depth >= MAX_DYNAMIC_PARSE_DEPTH) {
    diags.push(
      diag(
        'warning',
        'schema',
        'schema.dynamic.depth',
        `${nodeType}.${id}: dynamic nesting exceeds ${MAX_DYNAMIC_PARSE_DEPTH} levels; nested construct made inert`,
      ),
    )
    // Do not expose the reserved marker as a real socket type. A plain
    // wildcard keeps the malformed leaf visible and harmless, while omitting
    // `dynamic` guarantees no later recursive stage can expand it.
    return { kind: 'input', id, type: { kind: 'wildcard' }, optional, ...presentation }
  }
  if (wireType === T_AUTOGROW) {
    const template = options['template'] as Record<string, unknown> | undefined
    const templateInputs = template ? parseAutogrowTemplate(nodeType, template, diags, depth + 1, budget) : undefined
    if (!templateInputs) {
      diags.push(diag('warning', 'schema', 'schema.autogrow.badTemplate', `${nodeType}.${id}: unparseable autogrow template`))
      return undefined
    }
    const naming = parseAutogrowNaming(template!)
    const dynamic: DynamicSpec = { kind: 'autogrow', template: templateInputs, naming }
    return { kind: 'input', id, type: { kind: 'wildcard' }, optional, dynamic, ...presentation }
  }
  if (wireType === T_DYNAMIC_COMBO) {
    const rawOptions = options['options'] as readonly Record<string, unknown>[] | undefined
    const parsed = (rawOptions ?? []).map((o) => ({
      key: String(o['key'] ?? ''),
      inputs: parseInputMap(nodeType, (o['inputs'] as Record<string, Record<string, WireInput>>) ?? {}, diags, depth + 1, budget),
    }))
    const dynamic: DynamicSpec = { kind: 'dynamicCombo', options: parsed }
    return { kind: 'input', id, type: { kind: 'concrete', name: 'COMBO' }, optional, dynamic, ...presentation }
  }
  if (wireType === T_DYNAMIC_SLOT) {
    const slotType = parseTypeExpr(String(options['slotType'] ?? '*'), {})
    const inputs = parseInputMap(nodeType, (options['inputs'] as Record<string, Record<string, WireInput>>) ?? {}, diags, depth + 1, budget)
    const variants = []
    const keys = new Set<string>()
    for (const raw of (Array.isArray(options['variants']) ? options['variants'] : []) as Record<string, unknown>[]) {
      const key = String(raw['key'] ?? '')
      // Backend key grammar (settled contract, Dinkster c2ac572): [A-Za-z0-9_-]+,
      // enforced at schema construction. Dotless because the key rides the
      // bracket value-path syntax and the graph wire's slotVariants object
      // verbatim (dependents lower construct-local; keys are never wire id
      // segments).
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        diags.push(diag('warning', 'schema', 'schema.slot.badVariantKey', `${nodeType}.${id}: variant key '${key}' violates the backend key grammar ([A-Za-z0-9_-]+); variant dropped`))
        continue
      }
      if (keys.has(key)) {
        diags.push(diag('warning', 'schema', 'schema.slot.duplicateVariantKey', `${nodeType}.${id}: duplicate variant key '${key}'; variant dropped`))
        continue
      }
      keys.add(key)
      // A variant input may reuse a shared dependent's id in the DOCUMENT
      // (bracketed 'slot.[key].x' vs 'slot.x' never collide there), but under
      // the settled construct-local wire naming (c2ac572) both lower to
      // 'slot.x' - elaboration diagnoses that collision and skips the
      // variant input (elab.slot.shadowedDependent).
      const variantInputs = parseInputMap(nodeType, (raw['inputs'] as Record<string, Record<string, WireInput>>) ?? {}, diags, depth + 1, budget)
      variants.push({ key, type: parseTypeExpr(String(raw['type'] ?? '*'), {}), inputs: variantInputs })
    }
    const dynamic: DynamicSpec = {
      kind: 'dynamicSlot',
      slotType,
      inputs,
      ...(variants.length > 0 ? { variants } : {}),
      ...(options['forceInput'] === true ? { forceInput: true } : {}),
    }
    return { kind: 'input', id, type: slotType, optional: true, dynamic, ...presentation }
  }
  return undefined
}

/**
 * Parse an autogrow template's full input map, preserving declared order
 * (required before optional, insertion order within each). The current
 * backend only expands single-slot templates, but the wire format already
 * carries a full map - grouped templates are the modeled-ahead extension.
 * Nested dynamics (architecture section 3, hazards N1-N6) use the exact same
 * recursive input-map encoding. Running every slot through parseInput is
 * important: custom packs expect all ordinary widget/type normalization to
 * remain available at every depth, not just dynamic recognition.
 */
function parseAutogrowTemplate(
  nodeType: string,
  template: Record<string, unknown>,
  diags: Diagnostic[],
  depth: number,
  budget: DynamicParseBudget,
): readonly InputSpec[] | undefined {
  const inputMap = template['input'] as Record<string, Record<string, WireInput>> | undefined
  if (!inputMap) return undefined
  const inputs = parseInputMap(nodeType, inputMap, diags, depth, budget)
  return inputs.length > 0 ? inputs : undefined
}

function parseAutogrowNaming(template: Record<string, unknown>): NonNullable<Extract<DynamicSpec, { kind: 'autogrow' }>['naming']> {
  if (Array.isArray(template['names'])) {
    return {
      kind: 'names',
      names: (template['names'] as unknown[]).map(String),
      ...(typeof template['min'] === 'number' ? { min: template['min'] as number } : {}),
    }
  }
  return {
    kind: 'prefix',
    prefix: String(template['prefix'] ?? 'item'),
    ...(typeof template['min'] === 'number' ? { min: template['min'] as number } : {}),
    ...(typeof template['max'] === 'number' ? { max: template['max'] as number } : {}),
  }
}

/** Parse a nested V1 input map ({required: {...}, optional: {...}}) into InputSpecs. */
function parseInputMap(
  nodeType: string,
  map: Record<string, Record<string, WireInput>>,
  diags: Diagnostic[],
  depth: number,
  budget: DynamicParseBudget,
): readonly InputSpec[] {
  const out: InputSpec[] = []
  for (const group of ['required', 'optional'] as const) {
    for (const [id, wire] of Object.entries(map[group] ?? {})) {
      const spec = parseInput(nodeType, id, wire, group === 'optional', diags, depth, budget)
      if (spec) out.push(spec)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseInput(
  nodeType: string,
  id: string,
  wire: WireInput,
  optional: boolean,
  diags: Diagnostic[],
  depth = 0,
  budget: DynamicParseBudget = { remaining: 512, reported: false },
): InputSpec | undefined {
  if (depth > 0 && budget.remaining-- <= 0) {
    if (!budget.reported) {
      budget.reported = true
      diags.push(diag('warning', 'schema', 'schema.dynamic.budget', `${nodeType}: dynamic constructs exceed the 512 nested-input item budget; remaining inputs made inert`))
    }
    // Keeping the exhausted leaf visible as a wildcard matches depth-cap
    // degradation while preventing any more recursive expansion (hazard N5).
    return { kind: 'input', id, type: { kind: 'wildcard' }, optional }
  }
  if (!Array.isArray(wire) || (wire as readonly unknown[]).length === 0) {
    diags.push(diag('warning', 'schema', 'schema.input.malformed', `${nodeType}.${id}: malformed input tuple`))
    return undefined
  }
  const wireType = wire[0] as string | readonly unknown[]
  const options: WireOptions = (wire[1] as WireOptions) ?? {}

  const hasMultiSelect = (options['multiselect'] !== undefined && options['multiselect'] !== false) || 'multi_select' in options
  if (hasMultiSelect) {
    const declaredOptions = Array.isArray(wireType)
      ? wireType
      : wireType === 'COMBO' && Array.isArray(options['options'])
        ? options['options']
        : undefined
    if (declaredOptions === undefined || !declaredOptions.every((value) => typeof value === 'string' && value !== '')) {
      throw new Error(`${nodeType}.${id}: multiselect options must be strings`)
    }
    if (options['multiselect'] !== true) {
      throw new Error(`${nodeType}.${id}: multiselect must be true`)
    }
    const config = options['multi_select']
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`${nodeType}.${id}: multi_select config must be an object`)
    }
    const multi = config as Record<string, unknown>
    const unknown = Object.keys(multi).filter((key) => key !== 'placeholder' && key !== 'chip')
    if (unknown.length > 0) throw new Error(`${nodeType}.${id}: unsupported multi_select config '${unknown.sort().join(', ')}'`)
    if (multi['placeholder'] !== undefined && typeof multi['placeholder'] !== 'string') {
      throw new Error(`${nodeType}.${id}: multi_select placeholder must be a string`)
    }
    if (multi['chip'] !== undefined && typeof multi['chip'] !== 'boolean') {
      throw new Error(`${nodeType}.${id}: multi_select chip must be a boolean`)
    }
    if (options['default'] !== undefined &&
      (!Array.isArray(options['default']) || !options['default'].every((value) => typeof value === 'string'))) {
      throw new Error(`${nodeType}.${id}: multiselect default must be an array of strings`)
    }
    if (options['control_after_generate'] !== undefined && options['control_after_generate'] !== null) {
      throw new Error(`${nodeType}.${id}: multiselect control_after_generate is unsupported`)
    }
    const parsedRemote = parseMultiComboRemote(options['remote'], `${nodeType}.${id}`)
    if (declaredOptions.length === 0 && parsedRemote === undefined) {
      throw new Error(`${nodeType}.${id}: multiselect needs static options or a remote source`)
    }
    return {
      kind: 'input', id,
      type: { kind: 'list', element: { kind: 'concrete', name: 'core.combo' } },
      optional,
      widget: {
        widgetType: 'MULTI_COMBO',
        options: {
          ...(declaredOptions.length > 0 ? { options: [...declaredOptions] } : {}),
          ...(multi['placeholder'] !== undefined ? { placeholder: multi['placeholder'] } : {}),
          ...(multi['chip'] !== undefined ? { chip: multi['chip'] } : {}),
        },
        ...(options['default'] !== undefined ? { default: [...options['default']] } : {}),
        ...(parsedRemote !== undefined ? { remote: parsedRemote } : {}),
      },
      ...(options['forceInput'] === true ? { forceInput: true } : {}),
      ...(options['lazy'] === true ? { lazy: true } : {}),
      ...(options['advanced'] === true ? { advanced: true } : {}),
      ...(typeof options['display_name'] === 'string' ? { displayName: options['display_name'] as string } : {}),
      ...(typeof options['tooltip'] === 'string' ? { tooltip: options['tooltip'] as string } : {}),
    }
  }

  if (typeof wireType === 'string') {
    const dynamic = parseDynamic(nodeType, id, wireType, options, optional, diags, depth, budget)
    if (dynamic) return dynamic
  }

  const type = parseTypeExpr(wireType, options)
  const widget = parseWidget(wireType, options)
  return {
    kind: 'input',
    id,
    type,
    optional,
    ...(widget ? { widget } : {}),
    ...(options['forceInput'] === true ? { forceInput: true } : {}),
    ...(options['lazy'] === true ? { lazy: true } : {}),
    ...(options['advanced'] === true ? { advanced: true } : {}),
    ...(typeof options['display_name'] === 'string' ? { displayName: options['display_name'] as string } : {}),
    ...(typeof options['tooltip'] === 'string' ? { tooltip: options['tooltip'] as string } : {}),
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseObjectInfoEntry(nodeType: string, entry: ObjectInfoEntry): ParseResult {
  const diags: Diagnostic[] = []
  const items: InterfaceItem[] = []
  const dynamicBudget: DynamicParseBudget = { remaining: 512, reported: false }

  if (entry.is_input_list === true && ['required', 'optional'].some((group) =>
    Object.values(entry.input?.[group as 'required' | 'optional'] ?? {}).some((wire) => {
      const options = wire[1] as WireOptions | undefined
      return options !== undefined &&
        ((options['multiselect'] !== undefined && options['multiselect'] !== false) || 'multi_select' in options)
    }))) {
    throw new Error(`${nodeType}: multiselect conflicts with INPUT_IS_LIST`)
  }

  // Inputs, in declared order. input_order preserves order within each group;
  // true interleave across required/optional is not representable on the
  // current wire (backend co-evolution item) - we emit required then optional.
  for (const group of ['required', 'optional'] as const) {
    const groupMap = entry.input?.[group] ?? {}
    const order = entry.input_order?.[group] ?? Object.keys(groupMap)
    for (const id of order) {
      const wire = groupMap[id]
      if (!wire) {
        diags.push(diag('warning', 'schema', 'schema.inputOrder.dangling', `${nodeType}: input_order names missing input '${id}'`))
        continue
      }
      const spec = parseInput(nodeType, id, wire, group === 'optional', diags, 0, dynamicBudget)
      if (spec) items.push(spec)
    }
    // Inputs present in the map but missing from input_order still get parsed.
    for (const [id, wire] of Object.entries(groupMap)) {
      if (!order.includes(id)) {
        const spec = parseInput(nodeType, id, wire, group === 'optional', diags, 0, dynamicBudget)
        if (spec) items.push(spec)
      }
    }
  }

  // Outputs: V1 wire has no output ids; synthesize stable ids from index
  // ('out0', 'out1', ...). Documents key links on these; they are stable
  // because output order is append-only in practice (changes surface as
  // replacement-rule material, not silent remapping).
  const outputs = entry.output ?? []
  outputs.forEach((wireType, i) => {
    const matchTemplate = entry.output_matchtypes?.[i] ?? null
    const type: TypeExpr = matchTemplate
      ? { kind: 'variable', templateId: matchTemplate }
      : parseTypeExpr(wireType, {})
    const displayName = entry.output_name?.[i]
    const tooltip = entry.output_tooltips?.[i]
    const spec: OutputSpec = {
      kind: 'output',
      id: `out${i}`,
      type,
      ...(entry.output_is_list?.[i] ? { isList: true } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(tooltip != null ? { tooltip } : {}),
    }
    items.push(spec)
  })

  const schema: NodeSchema = {
    type: nodeType,
    displayName: entry.display_name ?? nodeType,
    category: entry.category ?? '',
    ...(entry.description ? { description: entry.description } : {}),
    source: 'v1', // this wire shape is V1
    items,
    isOutputNode: entry.output_node ?? false,
    ...(entry.deprecated ? { deprecated: true } : {}),
    ...(entry.experimental ? { experimental: true } : {}),
    ...(entry.search_aliases?.length ? { searchAliases: entry.search_aliases } : {}),
    ...(entry.input?.hidden ? { hidden: Object.keys(entry.input.hidden) } : {}),
  }
  return { schema, diagnostics: diags }
}

/** Parse a full /object_info response. */
export function parseObjectInfo(
  raw: Readonly<Record<string, ObjectInfoEntry>>,
): { schemas: ReadonlyMap<string, NodeSchema>; diagnostics: readonly Diagnostic[] } {
  const schemas = new Map<string, NodeSchema>()
  const diagnostics: Diagnostic[] = []
  for (const [type, entry] of Object.entries(raw)) {
    try {
      const { schema, diagnostics: d } = parseObjectInfoEntry(type, entry)
      diagnostics.push(...d)
      if (schema) schemas.set(type, schema)
    } catch (e) {
      diagnostics.push(
        diag('error', 'schema', 'schema.parse.threw', `${type}: schema parse threw: ${e instanceof Error ? e.message : String(e)}`),
      )
    }
  }
  return { schemas, diagnostics }
}
