/**
 * Decode the current Dinkster schema wire contract.
 *
 * Optional fields are feature flags: their presence enables the corresponding
 * schema capability, and their absence preserves the default behavior. Before
 * public release the contract is revised in place as version 1.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { isReplacementRule, type ReplacementRule } from '../replace/model.js'
import { canonicalTypeIdOf } from './model.js'
import { isCanonicalUnsafeInteger } from './numeric-step.js'
import type {
  AbsentPolicy,
  AlphaPolicy,
  CountBoundOutputAutogrowSpec,
  ConditionalWidgetCondition,
  ConditionalWidgetGroup,
  DeprecationInfo,
  DynamicSlotSpec,
  DynamicSpec,
  InputSpec,
  InterfaceItem,
  MaskPolarity,
  MaskSemantic,
  MirrorSpec,
  MirrorTolerance,
  NodeSelectorSpec,
  NodeSchema,
  OutputKnownValue,
  OutputDescriptorsSpec,
  OutputRepresents,
  OutputSpec,
  PackAssetDescriptor,
  PackAssetSource,
  PackBlueprintDescriptor,
  PackIcon,
  PackInfo,
  SearchVisibility,
  SourceFilenameSpec,
  TextCompletionsSpec,
  TypeExpr,
  WidgetDescriptorSpec,
  WidgetRepresentationSpec,
  WidgetSpec,
} from './model.js'

/** The single schema wire contract decoded by this frontend. */
export const DINKSTER_SCHEMA_WIRE_VERSION = 1

/** Widget kinds implied by core primitive type ids (until the wire carries widget metadata). */
const PRIMITIVE_WIDGETS: Readonly<Record<string, string>> = {
  'core.int': 'INT',
  'core.float': 'FLOAT',
  'core.string': 'STRING',
  'core.boolean': 'BOOLEAN',
}

const ABSENT_POLICIES: ReadonlySet<string> = new Set(['skip', 'accept', 'fail', 'omit'])

interface WireEntry {
  readonly role?: unknown
  readonly id?: unknown
  readonly type?: unknown
  readonly required?: unknown
  readonly default?: unknown
  readonly doc?: unknown
  readonly onAbsent?: unknown
  readonly optional?: unknown
  readonly minMembers?: unknown
  readonly maxMembers?: unknown
  readonly count?: unknown
  readonly widget?: unknown
  /** Per-input display label; empty/absent falls back to the id. */
  readonly displayName?: unknown
  /** dynamicSlot role only: [{key, type, inputs, doc?}]. */
  readonly variants?: unknown
  /** Recursive dynamic-entry fields. */
  readonly template?: unknown
  readonly inputs?: unknown
  readonly options?: unknown
  readonly slotType?: unknown
  readonly typeTemplateId?: unknown
  readonly memberPrefix?: unknown
  readonly memberNames?: unknown
  readonly forceInput?: unknown
  /** Computation-semantic demand marker. */
  readonly lazy?: unknown
  /** Storage-backed execution marker. */
  readonly acceptsStorage?: unknown
  readonly acceptsStream?: unknown
  /** Source-filename execution binding. */
  readonly sourceFilename?: unknown
  /** Presentation/discovery marker. */
  readonly preview?: unknown
  /** Selected-asset output estimate declaration. */
  readonly represents?: unknown
  /** Typed primitive identity output declaration. */
  readonly knownValue?: unknown
  readonly advanced?: unknown
  /** Compatibility-only presentation marker. */
  readonly hidden?: unknown
  /** Execution-affecting media policies. */
  readonly alphaPolicy?: unknown
  readonly maskPolarity?: unknown
  readonly maskSemantic?: unknown
}

const ALPHA_POLICIES: ReadonlySet<string> = new Set(['preserve', 'require', 'create_if_missing', 'drop'])
const MASK_POLARITIES: ReadonlySet<string> = new Set(['coverage', 'transparency'])
const MASK_SEMANTICS: ReadonlySet<string> = new Set(['alpha', 'selection', 'other'])

function acceptsStorageOf(entry: { readonly role?: unknown; readonly acceptsStorage?: unknown }, where: string): Pick<InputSpec, 'acceptsStorage'> {
  if (entry.acceptsStorage === undefined) return {}
  if (entry.role !== 'input') throw new Error(`${where}.acceptsStorage is only valid on ordinary inputs`)
  if (typeof entry.acceptsStorage !== 'boolean') throw new Error(`${where}.acceptsStorage must be a boolean`)
  return entry.acceptsStorage ? { acceptsStorage: true } : {}
}

function acceptsStreamOf(entry: { readonly role?: unknown; readonly acceptsStream?: unknown }, where: string): Pick<InputSpec, 'acceptsStream'> {
  if (!Object.hasOwn(entry, 'acceptsStream')) return {}
  if (entry.role !== 'input') throw new Error(`${where}.acceptsStream is only valid on ordinary inputs`)
  if (typeof entry.acceptsStream !== 'boolean') throw new Error(`${where}.acceptsStream must be a boolean`)
  return entry.acceptsStream ? { acceptsStream: true } : {}
}

function mediaPolicyOf(
  entry: {
    readonly alphaPolicy?: unknown
    readonly maskPolarity?: unknown
    readonly maskSemantic?: unknown
  },
  where: string,
): Pick<InputSpec, 'alphaPolicy' | 'maskPolarity' | 'maskSemantic'> {
  const alphaPolicy = entry['alphaPolicy']
  const maskPolarity = entry['maskPolarity']
  const maskSemantic = entry['maskSemantic']
  if (alphaPolicy !== undefined && (typeof alphaPolicy !== 'string' || !ALPHA_POLICIES.has(alphaPolicy))) {
    throw new Error(`${where}.alphaPolicy must be one of ${[...ALPHA_POLICIES].join(', ')}`)
  }
  if (maskPolarity !== undefined && (typeof maskPolarity !== 'string' || !MASK_POLARITIES.has(maskPolarity))) {
    throw new Error(`${where}.maskPolarity must be one of ${[...MASK_POLARITIES].join(', ')}`)
  }
  if (maskSemantic !== undefined && (typeof maskSemantic !== 'string' || !MASK_SEMANTICS.has(maskSemantic))) {
    throw new Error(`${where}.maskSemantic must be one of ${[...MASK_SEMANTICS].join(', ')}`)
  }
  return {
    ...(alphaPolicy !== undefined ? { alphaPolicy: alphaPolicy as AlphaPolicy } : {}),
    ...(maskPolarity !== undefined ? { maskPolarity: maskPolarity as MaskPolarity } : {}),
    ...(maskSemantic !== undefined ? { maskSemantic: maskSemantic as MaskSemantic } : {}),
  }
}

export interface DinksterWireSchema {
  readonly schemaVersion?: unknown
  readonly nodeType?: unknown
  readonly version?: unknown
  readonly displayName?: unknown
  readonly category?: unknown
  readonly description?: unknown
  readonly editorRole?: unknown
  readonly idempotent?: unknown
  readonly interface?: unknown
  readonly occupies?: unknown
  readonly ioBound?: unknown
  readonly deprecation?: unknown
  readonly searchVisibility?: unknown
  readonly searchTerms?: unknown
  readonly replacements?: unknown
  /** Optional document-time branch selector. */
  readonly selector?: unknown
  /** Host-attached pack attribution (not part of the schema wire proper). */
  readonly pack?: unknown
  /** Interface signature (always present on backends serving env stamping). */
  readonly signature?: unknown
  /** Host-normalized execution implementations (not worker lane names). */
  readonly executionArms?: unknown
  /** Explicit default-target hint (true only, omitted when false). */
  readonly outputNode?: unknown
  /** Live-preview capability flag (true only, omitted when false). */
  readonly emitsPreviews?: unknown
  /** Full help page availability flag (true only, omitted when false). */
  readonly hasDocs?: unknown
  readonly widgetGroups?: unknown
  /** Frontend-renderable mirror declaration (presentation only). */
  readonly mirror?: unknown
  readonly chunkSafe?: unknown
  /** Legacy v1 class_type names this node also answers to (resolution only). */
  readonly aliases?: unknown
}

function decodeWireSelector(wire: unknown, inputs: ReadonlyMap<string, InputSpec>, outputs: readonly OutputSpec[]): NodeSelectorSpec | undefined {
  if (wire === undefined) return undefined
  const selector = wireObject(wire, 'selector')
  const selectorKeys = Object.keys(selector).sort()
  if (selectorKeys.length !== 2 || selectorKeys[0] !== 'branches' || selectorKeys[1] !== 'input') {
    throw new Error('selector must contain exactly input and branches')
  }
  if (typeof selector['input'] !== 'string') throw new Error('selector.input must be a string')
  const input = selector['input']
  const selectorInput = inputs.get(input)
  if (selectorInput === undefined) throw new Error(`selector.input names unknown input '${input}'`)
  if (selectorInput.dynamic !== undefined) throw new Error('selector.input must name a static input')
  if (JSON.stringify(selectorInput.type) !== JSON.stringify({ kind: 'concrete', name: 'core.boolean' })) {
    throw new Error('selector.input must have type core.boolean')
  }

  const branches = wireObject(selector['branches'], 'selector.branches')
  const branchKeys = Object.keys(branches).sort()
  if (branchKeys.length !== 2 || branchKeys[0] !== 'false' || branchKeys[1] !== 'true') {
    throw new Error('selector.branches must contain exactly false and true')
  }
  if (typeof branches['false'] !== 'string' || typeof branches['true'] !== 'string') {
    throw new Error('selector branch input ids must be strings')
  }
  const falseInput = branches['false']
  const trueInput = branches['true']
  if (falseInput === trueInput) throw new Error('selector branch input ids must be distinct')
  if (input === falseInput || input === trueInput) {
    throw new Error('selector.input must be distinct from both branch input ids')
  }
  const falseSpec = inputs.get(falseInput)
  const trueSpec = inputs.get(trueInput)
  if (falseSpec === undefined) throw new Error(`selector false branch names unknown input '${falseInput}'`)
  if (trueSpec === undefined) throw new Error(`selector true branch names unknown input '${trueInput}'`)
  if (falseSpec.dynamic !== undefined || trueSpec.dynamic !== undefined) {
    throw new Error('selector branches must name static inputs')
  }
  if (outputs.length !== 1) throw new Error('selector-bearing schema must declare exactly one output')
  if (outputs[0]!.dynamic !== undefined) throw new Error('selector output must be static')
  const outputType = JSON.stringify(outputs[0]!.type)
  if (JSON.stringify(falseSpec.type) !== outputType || JSON.stringify(trueSpec.type) !== outputType) {
    throw new Error('selector branch inputs must share the sole output type')
  }
  return { input, branches: { false: falseInput, true: trueInput } }
}

export interface DinksterNodesPayload {
  readonly schemaVersion?: unknown
  readonly nodes?: unknown
  /** Immutable frontend/backend extension generation paired with this table. */
  readonly extensionSnapshotDigest?: unknown
  /** packId -> presentation table (additive; absent on older backends). */
  readonly packs?: unknown
  /** Server identity header {version, schemaWire} (additive; absent on older backends). */
  readonly dinkster?: unknown
  /**
   * Schema surface generation, monotonic per engine process (additive;
   * absent on older backends). Distinct from schemaVersion (wire format).
   */
  readonly epoch?: unknown
  /**
   * Present (true) exactly while the backend is still announcing packs:
   * this table is real but not final. Omitted once composed - never false.
   */
  readonly composing?: unknown
}

// ---------------------------------------------------------------------------
// TypeExpr
// ---------------------------------------------------------------------------

/**
 * Decode a wire TypeExpr. Throws on malformed shapes; the per-node wrapper
 * turns that into a diagnostic + dropped node (the backend decoder raises on
 * unknown kinds too - strict beats silently-wrong on an unstable wire).
 */
export function typeExprFromDinksterWire(wire: unknown): TypeExpr {
  if (typeof wire !== 'object' || wire === null) throw new Error('type expression must be an object')
  const w = wire as {
    kind?: unknown
    types?: unknown
    templateId?: unknown
    element?: unknown
  }
  const types: string[] = Array.isArray(w.types) ? w.types.map((t) => String(t)) : []
  if (types.some((type) => type.startsWith('stream<'))) throw new Error('stream type requires a structured constructor')
  switch (w.kind) {
    case 'concrete': {
      if (types.length !== 1) throw new Error(`concrete type carries ${types.length} names, expected exactly 1`)
      return { kind: 'concrete', name: types[0]! }
    }
    case 'union': {
      if (types.length < 2) throw new Error('union type requires at least two names')
      return { kind: 'union', names: types }
    }
    case 'wildcard':
      return { kind: 'wildcard' }
    case 'variable': {
      const templateId = typeof w.templateId === 'string' ? w.templateId : ''
      if (templateId === '') throw new Error('variable type requires a templateId')
      return {
        kind: 'variable',
        templateId,
        ...(types.length > 0
          ? {
              allowedTypes: types.map((name): TypeExpr => ({ kind: 'concrete', name })),
            }
          : {}),
      }
    }
    case 'list':
    case 'asset':
    case 'stream':
      return { kind: w.kind, element: typeExprFromDinksterWire(w.element) }
    default:
      throw new Error(`unknown type expression kind: ${String(w.kind)}`)
  }
}

// ---------------------------------------------------------------------------
// Interface entries
// ---------------------------------------------------------------------------

/**
 * Decode explicit presentation first, then preserve primitive inference when
 * a descriptor is absent or not understood.
 */
const ASSET_KIND = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/

const CONTROL_AFTER_GENERATE_MODES: ReadonlySet<string> = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const NUMBER_DISPLAY_MODES: ReadonlySet<string> = new Set(['number', 'slider', 'knob', 'gradientslider'])

const WIDGET_REPRESENTATION_ID = /^[A-Za-z0-9_-]+$/

function rejectUnknownWidgetFields(descriptor: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(descriptor)
    .filter((key) => !allowed.includes(key))
    .sort()
  if (unknown.length > 0) throw new Error(`${where} has unknown fields: ${unknown.join(', ')}`)
}

function validateComboOption(value: unknown, where: string): void {
  if (typeof value === 'string' && value !== '') return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a non-empty string or structured choice`)
  }
  const option = value as Record<string, unknown>
  rejectUnknownWidgetFields(option, ['value', 'label', 'info', 'folder'], where)
  if (typeof option['value'] !== 'string' || option['value'] === '') {
    throw new Error(`${where}.value must be a non-empty string`)
  }
  for (const field of ['label', 'info'] as const) {
    if (option[field] !== undefined && (typeof option[field] !== 'string' || option[field] === '')) {
      throw new Error(`${where}.${field} must be a non-empty string`)
    }
  }
  if (option['folder'] !== undefined) {
    if (typeof option['folder'] !== 'string' || option['folder'] === '' || option['folder'].includes('\\')) {
      throw new Error(`${where}.folder must be a relative /-separated path`)
    }
    const segments = option['folder'].split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`${where}.folder must contain non-empty segments other than '.' or '..'`)
    }
  }
}

function decodeTextCompletions(value: unknown, where: string): TextCompletionsSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  const raw = value as Record<string, unknown>
  rejectUnknownWidgetFields(raw, ['items', 'inputFamilies'], where)
  const rawItems = raw['items'] ?? []
  const rawFamilies = raw['inputFamilies'] ?? []
  if (!Array.isArray(rawItems)) throw new Error(`${where}.items must be an array`)
  if (!Array.isArray(rawFamilies) || !rawFamilies.every((family) => typeof family === 'string' && /^[A-Za-z0-9_-]+$/.test(family))) {
    throw new Error(`${where}.inputFamilies must be an array of structural ids`)
  }
  if (new Set(rawFamilies).size !== rawFamilies.length) throw new Error(`${where}.inputFamilies must be unique`)
  const items = rawItems.map((value, index) => {
    const itemWhere = `${where}.items[${index}]`
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${itemWhere} must be an object`)
    }
    const item = value as Record<string, unknown>
    rejectUnknownWidgetFields(item, ['value', 'label', 'insertText', 'detail', 'kind'], itemWhere)
    if (typeof item['value'] !== 'string' || item['value'] === '') {
      throw new Error(`${itemWhere}.value must be a non-empty string`)
    }
    for (const field of ['label', 'insertText', 'detail'] as const) {
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        throw new Error(`${itemWhere}.${field} must be a string`)
      }
    }
    if (item['kind'] !== undefined && item['kind'] !== 'identifier' && item['kind'] !== 'operator') {
      throw new Error(`${itemWhere}.kind must be identifier or operator`)
    }
    const label = item['label']
    const insertText = item['insertText']
    const detail = item['detail']
    const kind = item['kind']
    return {
      value: item['value'],
      label: typeof label === 'string' ? label : item['value'],
      insertText: typeof insertText === 'string' ? insertText : item['value'],
      detail: typeof detail === 'string' ? detail : '',
      kind: kind === 'operator' ? kind : 'identifier',
    } as const
  })
  if (items.length === 0 && rawFamilies.length === 0) throw new Error(`${where} must declare items or inputFamilies`)
  return { items, inputFamilies: rawFamilies as string[] }
}

function validateStrictWidgetDescriptor(descriptor: Record<string, unknown>, where: string): void {
  switch (descriptor['type']) {
    case 'ASSET':
      rejectUnknownWidgetFields(descriptor, ['type', 'accept', 'kind', 'allowUpload'], where)
      if (!Array.isArray(descriptor['accept']) || !descriptor['accept'].every((value) => typeof value === 'string' && value !== '')) {
        throw new Error(`${where}.accept must be an array of non-empty strings`)
      }
      if (descriptor['kind'] !== undefined && (typeof descriptor['kind'] !== 'string' || (descriptor['kind'] !== '' && !ASSET_KIND.test(descriptor['kind'])))) {
        throw new Error(`${where}.kind must be a valid asset kind`)
      }
      if (descriptor['allowUpload'] !== undefined && typeof descriptor['allowUpload'] !== 'boolean') {
        throw new Error(`${where}.allowUpload must be a boolean`)
      }
      return
    case 'SAVE_TARGET':
      rejectUnknownWidgetFields(descriptor, ['type', 'suffix'], where)
      if (descriptor['suffix'] !== undefined && typeof descriptor['suffix'] !== 'string') {
        throw new Error(`${where}.suffix must be a string`)
      }
      if (
        typeof descriptor['suffix'] === 'string' &&
        descriptor['suffix'] !== '' &&
        (!descriptor['suffix'].startsWith('.') || descriptor['suffix'].includes('/') || descriptor['suffix'].includes('\\'))
      ) {
        throw new Error(`${where}.suffix must be a bare extension`)
      }
      return
    case 'COMBO': {
      rejectUnknownWidgetFields(descriptor, ['type', 'options', 'remote', 'controlAfterGenerate', 'optionSource'], where)
      const options = descriptor['options']
      if (options !== undefined) {
        if (!Array.isArray(options)) throw new Error(`${where}.options must be an array`)
        options.forEach((value, index) => validateComboOption(value, `${where}.options[${index}]`))
      }
      const remote = descriptor['remote']
      if (remote !== undefined) {
        if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
          throw new Error(`${where}.remote must be an object`)
        }
        const remoteObject = remote as Record<string, unknown>
        rejectUnknownWidgetFields(remoteObject, ['route', 'refreshButton', 'controlAfterRefresh', 'timeoutMs', 'maxRetries', 'refreshMs'], `${where}.remote`)
        if (typeof remoteObject['route'] !== 'string' || !remoteObject['route'].startsWith('/')) {
          throw new Error(`${where}.remote.route must start with '/'`)
        }
        if (remoteObject['refreshButton'] !== undefined && typeof remoteObject['refreshButton'] !== 'boolean') {
          throw new Error(`${where}.remote.refreshButton must be a boolean`)
        }
      }
      const optionSource = descriptor['optionSource']
      if (optionSource !== undefined) {
        if (typeof optionSource !== 'object' || optionSource === null || Array.isArray(optionSource)) {
          throw new Error(`${where}.optionSource must be an object`)
        }
        const source = optionSource as Record<string, unknown>
        rejectUnknownWidgetFields(source, ['inputFamily'], `${where}.optionSource`)
        if (typeof source['inputFamily'] !== 'string' || source['inputFamily'] === '') {
          throw new Error(`${where}.optionSource.inputFamily must be a non-empty string`)
        }
      }
      if ((!Array.isArray(options) || options.length === 0) && remote === undefined && optionSource === undefined) {
        throw new Error(`${where} requires options, remote, or optionSource`)
      }
      return
    }
    case 'MULTI_COMBO': {
      rejectUnknownWidgetFields(descriptor, ['type', 'options', 'remote', 'placeholder', 'chip'], where)
      const options = descriptor['options']
      if (options !== undefined) {
        if (!Array.isArray(options)) throw new Error(`${where}.options must be an array`)
        options.forEach((value, index) => validateComboOption(value, `${where}.options[${index}]`))
      }
      const remote = descriptor['remote']
      if (remote !== undefined) {
        if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
          throw new Error(`${where}.remote must be an object`)
        }
        const r = remote as Record<string, unknown>
        rejectUnknownWidgetFields(r, ['route', 'refreshButton', 'controlAfterRefresh', 'timeoutMs', 'maxRetries', 'refreshMs'], `${where}.remote`)
        if (typeof r['route'] !== 'string' || !/^\/api\/choices\/[A-Za-z0-9._-]+$/.test(r['route'])) {
          throw new Error(`${where}.remote.route must be /api/choices/{choice_id}`)
        }
        if (r['refreshButton'] !== undefined && typeof r['refreshButton'] !== 'boolean') {
          throw new Error(`${where}.remote.refreshButton must be a boolean`)
        }
      }
      if ((!Array.isArray(options) || options.length === 0) && remote === undefined) {
        throw new Error(`${where} requires options or remote`)
      }
      return
    }
    case 'BOOLEAN':
      rejectUnknownWidgetFields(descriptor, ['type', 'labelOn', 'labelOff'], where)
      for (const key of ['labelOn', 'labelOff']) {
        if (descriptor[key] !== undefined && typeof descriptor[key] !== 'string') {
          throw new Error(`${where}.${key} must be a string`)
        }
      }
      if (!descriptor['labelOn'] && !descriptor['labelOff']) {
        throw new Error(`${where} requires at least one custom label`)
      }
      return
    case 'NUMBER':
      rejectUnknownWidgetFields(descriptor, ['type', 'min', 'max', 'step', 'controlAfterGenerate', 'display', 'round'], where)
      for (const key of ['min', 'max', 'step']) {
        const value = descriptor[key]
        const finiteNumber = typeof value === 'number' && Number.isFinite(value)
        const exactNumber = finiteNumber && (!Number.isInteger(value) || Number.isSafeInteger(value))
        const decimalInteger = isCanonicalUnsafeInteger(value)
        if (value !== undefined && !exactNumber && !decimalInteger) {
          throw new Error(`${where}.${key} must be a finite exact number`)
        }
      }
      if (descriptor['min'] !== undefined && descriptor['max'] !== undefined) {
        const min = descriptor['min']
        const max = descriptor['max']
        const minInteger = isCanonicalUnsafeInteger(min) ? BigInt(min) : Number.isSafeInteger(min) ? BigInt(min as number) : undefined
        const maxInteger = isCanonicalUnsafeInteger(max) ? BigInt(max) : Number.isSafeInteger(max) ? BigInt(max as number) : undefined
        if (
          (typeof min === 'number' && typeof max === 'number' && min > max) ||
          (minInteger !== undefined && maxInteger !== undefined && minInteger > maxInteger)
        ) {
          throw new Error(`${where}.min must not exceed max`)
        }
      }
      if (
        (typeof descriptor['step'] === 'number' && descriptor['step'] <= 0) ||
        (isCanonicalUnsafeInteger(descriptor['step']) && BigInt(descriptor['step']) <= 0n)
      ) {
        throw new Error(`${where}.step must be positive`)
      }
      if (
        descriptor['controlAfterGenerate'] !== undefined &&
        (typeof descriptor['controlAfterGenerate'] !== 'string' || !CONTROL_AFTER_GENERATE_MODES.has(descriptor['controlAfterGenerate']))
      ) {
        throw new Error(`${where}.controlAfterGenerate is invalid`)
      }
      if (['min', 'max', 'step', 'controlAfterGenerate', 'display', 'round'].every((key) => descriptor[key] === undefined)) {
        throw new Error(`${where} requires a constraint or controlAfterGenerate`)
      }
      return
    case 'STRING':
      rejectUnknownWidgetFields(descriptor, ['type', 'multiline', 'placeholder', 'dynamicPrompts', 'completions'], where)
      if (descriptor['multiline'] !== undefined && typeof descriptor['multiline'] !== 'boolean') {
        throw new Error(`${where}.multiline must be a boolean`)
      }
      if (descriptor['dynamicPrompts'] !== undefined && typeof descriptor['dynamicPrompts'] !== 'boolean') {
        throw new Error(`${where}.dynamicPrompts must be a boolean`)
      }
      if (descriptor['completions'] !== undefined) decodeTextCompletions(descriptor['completions'], `${where}.completions`)
      if (
        descriptor['multiline'] === undefined &&
        descriptor['placeholder'] === undefined &&
        descriptor['dynamicPrompts'] === undefined &&
        descriptor['completions'] === undefined
      )
        throw new Error(`${where} requires a presentation field`)
      return
    case 'COLOR':
      rejectUnknownWidgetFields(descriptor, ['type'], where)
      return
    case 'CURVE':
      rejectUnknownWidgetFields(descriptor, ['type'], where)
      return
    case 'COMPOSITOR':
      rejectUnknownWidgetFields(descriptor, ['type'], where)
      return
    default:
      if (typeof descriptor['type'] !== 'string' || descriptor['type'] === '') {
        throw new Error(`${where}.type must be a non-empty string`)
      }
      for (const [key, value] of Object.entries(descriptor)) {
        if (key !== 'type') cloneJsonValue(value, `${where}.${key}`)
      }
      return
  }
}

function cloneJsonValue(value: unknown, where: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => cloneJsonValue(item, `${where}[${index}]`))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneJsonValue(item, `${where}.${key}`)
    }
    return result
  }
  throw new Error(`${where} must be JSON-safe`)
}

function validateStrictWidgetBinding(descriptor: Record<string, unknown>, type: TypeExpr, where: string): void {
  const socket = type.kind === 'concrete' ? type.name : undefined
  switch (descriptor['type']) {
    case 'STRING':
    case 'COLOR':
      if (socket !== 'core.string') throw new Error(`${where} requires a concrete core.string input`)
      return
    case 'CURVE':
      if (socket !== 'dinkster.curve') throw new Error(`${where} requires a concrete dinkster.curve input`)
      return
    case 'COMPOSITOR':
      if (socket !== 'dinkster.compositor') throw new Error(`${where} requires a concrete dinkster.compositor input`)
      return
    case 'BOOLEAN':
      if (socket !== 'core.boolean') throw new Error(`${where} requires a concrete core.boolean input`)
      return
    case 'COMBO':
      if (socket !== 'core.combo') throw new Error(`${where} requires a concrete core.combo input`)
      return
    case 'MULTI_COMBO':
      if (type.kind !== 'list' || type.element.kind !== 'concrete' || type.element.name !== 'core.combo') {
        throw new Error(`${where} requires list<core.combo>`)
      }
      return
    case 'NUMBER':
      if (socket !== 'core.int' && socket !== 'core.float') {
        throw new Error(`${where} requires a concrete core.int or core.float input`)
      }
      if (socket === 'core.int') {
        for (const key of ['min', 'max', 'step']) {
          const value = descriptor[key]
          if (value !== undefined && !Number.isSafeInteger(value) && !isCanonicalUnsafeInteger(value)) {
            throw new Error(`${where}.${key} must be an exact integer on core.int`)
          }
        }
      } else if (['min', 'max', 'step'].some((key) => descriptor[key] !== undefined && typeof descriptor[key] !== 'number')) {
        throw new Error(`${where} decimal integer constraints require core.int`)
      }
      return
    case 'SAVE_TARGET':
      if (socket !== 'dinkster.save_target') throw new Error(`${where} requires a concrete dinkster.save_target input`)
      return
    case 'ASSET':
      if (type.kind === 'concrete') return
      if (descriptor['allowUpload'] === true && type.kind === 'list' && type.element.kind === 'concrete' && type.element.name === 'dinkster.asset') return
      if (type.kind === 'asset') {
        const isClosed = (candidate: TypeExpr): boolean =>
          candidate.kind === 'concrete' ||
          ((candidate.kind === 'list' || candidate.kind === 'asset' || candidate.kind === 'stream') && isClosed(candidate.element))
        if (isClosed(type.element)) return
      }
      throw new Error(`${where} requires a concrete scalar, dinkster.asset, or fully-concrete asset input`)
    default:
      return
  }
}

function widgetDomain(widget: WidgetDescriptorSpec): string {
  switch (widget.widgetType) {
    case 'ASSET':
      return 'asset'
    case 'SAVE_TARGET':
      return 'save-target'
    case 'COMBO':
      return 'combo'
    case 'BOOLEAN':
      return 'boolean'
    case 'INT':
    case 'FLOAT':
      return 'number'
    case 'STRING':
      return 'string'
    case 'COLOR':
      return 'string'
    case 'CURVE':
      return 'curve'
    case 'COMPOSITOR':
      return 'compositor'
    default:
      return widget.widgetType
  }
}

function widgetFor(
  nodeType: string,
  id: string,
  type: TypeExpr,
  dflt: unknown,
  wire: unknown,
  diags: Diagnostic[],
  representationsAllowed = true,
): WidgetSpec | undefined {
  if (typeof wire === 'object' && wire !== null) {
    const descriptor = wire as {
      type?: unknown
      accept?: unknown
      suffix?: unknown
      kind?: unknown
      allowUpload?: unknown
      options?: unknown
      remote?: unknown
      labelOn?: unknown
      labelOff?: unknown
      optionSource?: unknown
      min?: unknown
      max?: unknown
      step?: unknown
      controlAfterGenerate?: unknown
      display?: unknown
      round?: unknown
      multiline?: unknown
      placeholder?: unknown
      dynamicPrompts?: unknown
      completions?: unknown
      chip?: unknown
    }
    if (descriptor.type === 'REPRESENTATIONS') {
      if (!representationsAllowed) throw new Error(`${nodeType}.${id}: nested widget representations are forbidden`)
      const raw = wire as Record<string, unknown>
      rejectUnknownWidgetFields(raw, ['type', 'default', 'userSwitchable', 'representations'], `${nodeType}.${id} REPRESENTATIONS widget`)
      if (typeof raw['default'] !== 'string') throw new Error(`${nodeType}.${id}: representation default must be a string`)
      if (typeof raw['userSwitchable'] !== 'boolean') throw new Error(`${nodeType}.${id}: representation userSwitchable must be a boolean`)
      if (!Array.isArray(raw['representations']) || raw['representations'].length === 0) {
        throw new Error(`${nodeType}.${id}: representations must be a non-empty array`)
      }
      const representations: WidgetRepresentationSpec[] = []
      const ids = new Set<string>()
      for (const [index, value] of raw['representations'].entries()) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`${nodeType}.${id}: representation ${index} must be an object`)
        }
        const representation = value as Record<string, unknown>
        rejectUnknownWidgetFields(representation, ['id', 'displayName', 'widget'], `${nodeType}.${id} representation ${index}`)
        const representationId = representation['id']
        if (typeof representationId !== 'string' || !WIDGET_REPRESENTATION_ID.test(representationId)) {
          throw new Error(`${nodeType}.${id}: representation ${index} id must match [A-Za-z0-9_-]+`)
        }
        if (ids.has(representationId)) throw new Error(`${nodeType}.${id}: duplicate representation id '${representationId}'`)
        ids.add(representationId)
        const displayName = representation['displayName'] ?? ''
        if (typeof displayName !== 'string') throw new Error(`${nodeType}.${id}: representation ${index} displayName must be a string`)
        if (typeof representation['widget'] !== 'object' || representation['widget'] === null || Array.isArray(representation['widget'])) {
          throw new Error(`${nodeType}.${id}: representation ${index} widget must be an object`)
        }
        const nested = widgetFor(nodeType, id, type, dflt, representation['widget'], diags, false)
        if (nested === undefined || nested.representations !== undefined) {
          throw new Error(`${nodeType}.${id}: representation ${index} must contain one widget descriptor`)
        }
        representations.push({
          id: representationId,
          displayName,
          widget: nested,
        })
      }
      if (!ids.has(raw['default'])) throw new Error(`${nodeType}.${id}: representation default must name a declared representation`)
      const domains = new Set(representations.map((representation) => widgetDomain(representation.widget)))
      if (domains.size !== 1) throw new Error(`${nodeType}.${id}: representations must share one canonical value domain`)
      if (domains.has('asset')) {
        const kinds = new Set(representations.map((representation) => representation.widget.kind))
        if (kinds.size !== 1) throw new Error(`${nodeType}.${id}: asset representations must share one asset kind`)
      }
      const defaultWidget = representations.find((representation) => representation.id === raw['default'])!.widget
      return {
        ...defaultWidget,
        representations: {
          default: raw['default'],
          userSwitchable: raw['userSwitchable'],
          representations,
        },
      }
    }
    validateStrictWidgetDescriptor(wire as Record<string, unknown>, `${nodeType}.${id} widget`)
    validateStrictWidgetBinding(wire as Record<string, unknown>, type, `${nodeType}.${id} widget`)
    if (descriptor.type === 'ASSET' && Array.isArray(descriptor.accept) && descriptor.accept.every((v) => typeof v === 'string')) {
      let kind: string | undefined
      if (descriptor.kind !== undefined) {
        if (typeof descriptor.kind === 'string' && ASSET_KIND.test(descriptor.kind)) kind = descriptor.kind
        else if (descriptor.kind === '') kind = undefined
        else {
          diags.push(
            diag('warning', 'schema', 'schema.dinkster.badAssetKind', `${nodeType}.${id}: invalid ASSET kind '${String(descriptor.kind)}'; kind dropped`),
          )
        }
      }
      return {
        widgetType: 'ASSET',
        options: { accept: [...descriptor.accept] },
        ...(kind !== undefined ? { kind } : {}),
        ...(descriptor.allowUpload === true ? { allowUpload: true } : {}),
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // The wire omits a structured save target suffix when empty; the
    // decoder normalizes it to '' so every consumer reads ONE shape (the
    // suffix is display context owned by the node, never persisted data).
    if (descriptor.type === 'SAVE_TARGET' && (descriptor.suffix === undefined || typeof descriptor.suffix === 'string')) {
      return {
        widgetType: 'SAVE_TARGET',
        options: {
          suffix: typeof descriptor.suffix === 'string' ? descriptor.suffix : '',
        },
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // COMBO supports static options and/or a declarative remote source. Static
    // options render immediately; a successful remote fetch REPLACES them
    // (never merges). At least one of the two must survive validation. A
    // combo with neither source is invalid schema; keep the core.combo
    // socket visible but drop its unusable widget descriptor.
    if (descriptor.type === 'COMBO') {
      if (type.kind !== 'concrete' || type.name !== 'core.combo') {
        diags.push(
          diag('warning', 'schema', 'schema.dinkster.badComboSocket', `${nodeType}.${id}: COMBO descriptor on a non-core.combo input; descriptor dropped`),
        )
        return undefined
      }
      let options: unknown[] | undefined
      if (descriptor.options !== undefined) {
        if (Array.isArray(descriptor.options)) {
          if (descriptor.options.length > 0) options = [...descriptor.options]
        } else {
          diags.push(diag('warning', 'schema', 'schema.dinkster.badComboOptions', `${nodeType}.${id}: COMBO options are invalid; options dropped`))
        }
      }
      let remote: WidgetSpec['remote']
      if (descriptor.remote !== undefined) {
        const r = descriptor.remote as Record<string, unknown>
        if (typeof descriptor.remote === 'object' && descriptor.remote !== null && typeof r.route === 'string' && r.route.startsWith('/')) {
          remote = {
            route: r.route,
            ...(r.refreshButton === true ? { refreshButton: true } : {}),
          }
          const policyWarning = (field: string, requirement: string): void => {
            diags.push(
              diag('warning', 'schema', 'schema.dinkster.badComboRemotePolicy', `${nodeType}.${id}: COMBO remote ${field} ${requirement}; field dropped`),
            )
          }
          if (r.controlAfterRefresh !== undefined) {
            if (r.controlAfterRefresh === 'first' || r.controlAfterRefresh === 'last') {
              if (r.refreshButton === true)
                remote = {
                  ...remote,
                  controlAfterRefresh: r.controlAfterRefresh,
                }
              else policyWarning('controlAfterRefresh', 'requires refreshButton: true')
            } else policyWarning('controlAfterRefresh', "must be 'first' or 'last'")
          }
          for (const [field, lower, upper] of [
            ['timeoutMs', 1, 60_000],
            ['maxRetries', 0, 5],
            ['refreshMs', 0, 86_400_000],
          ] as const) {
            const value = r[field]
            if (value === undefined) continue
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= lower && value <= upper) {
              remote = { ...remote, [field]: value }
            } else policyWarning(field, `must be an integer in ${lower}..${upper}`)
          }
        } else {
          diags.push(diag('warning', 'schema', 'schema.dinkster.badComboRemote', `${nodeType}.${id}: COMBO remote must be {route: "/..."}; remote dropped`))
        }
      }
      let optionSource: WidgetSpec['optionSource']
      if (descriptor.optionSource !== undefined) {
        const source = descriptor.optionSource as Record<string, unknown>
        if (
          typeof descriptor.optionSource === 'object' &&
          descriptor.optionSource !== null &&
          typeof source['inputFamily'] === 'string' &&
          source['inputFamily'] !== ''
        ) {
          optionSource = { inputFamily: source['inputFamily'] }
        }
      }
      if (options === undefined && remote === undefined && optionSource === undefined) {
        diags.push(diag('warning', 'schema', 'schema.dinkster.badCombo', `${nodeType}.${id}: COMBO with neither options nor remote; descriptor dropped`))
      } else {
        let controllerInitial: WidgetSpec['controllerInitial']
        if (descriptor.controlAfterGenerate !== undefined) {
          if (typeof descriptor.controlAfterGenerate === 'string' && CONTROL_AFTER_GENERATE_MODES.has(descriptor.controlAfterGenerate)) {
            controllerInitial = descriptor.controlAfterGenerate as NonNullable<WidgetSpec['controllerInitial']>
          } else {
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badComboControlAfterGenerate',
                `${nodeType}.${id}: unknown COMBO controlAfterGenerate '${String(descriptor.controlAfterGenerate)}'; control dropped`,
              ),
            )
          }
        }
        return {
          widgetType: 'COMBO',
          options: options !== undefined ? { options } : {},
          ...(remote !== undefined ? { remote } : {}),
          ...(optionSource !== undefined ? { optionSource } : {}),
          ...(controllerInitial !== undefined ? { controller: 'after_generate' as const, controllerInitial } : {}),
          ...(dflt !== undefined ? { default: dflt } : {}),
        }
      }
    }
    if (descriptor.type === 'MULTI_COMBO') {
      if (!Array.isArray(dflt) && dflt !== undefined) throw new Error(`${nodeType}.${id}: MULTI_COMBO default must be string[]`)
      if (Array.isArray(dflt) && !dflt.every((value) => typeof value === 'string')) {
        throw new Error(`${nodeType}.${id}: MULTI_COMBO default must be string[]`)
      }
      const options = Array.isArray(descriptor.options) && descriptor.options.length > 0 ? [...descriptor.options] : undefined
      const outOptions: Record<string, unknown> = options ? { options } : {}
      if (descriptor.placeholder !== undefined) {
        if (typeof descriptor.placeholder === 'string') outOptions['placeholder'] = descriptor.placeholder
        else
          diags.push(
            diag('warning', 'schema', 'schema.dinkster.badMultiComboPlaceholder', `${nodeType}.${id}: MULTI_COMBO placeholder must be a string; field dropped`),
          )
      }
      if (descriptor.chip !== undefined) {
        if (typeof descriptor.chip === 'boolean') outOptions['chip'] = descriptor.chip
        else diags.push(diag('warning', 'schema', 'schema.dinkster.badMultiComboChip', `${nodeType}.${id}: MULTI_COMBO chip must be a boolean; field dropped`))
      }
      const r = descriptor.remote as Record<string, unknown> | undefined
      let remote: WidgetSpec['remote']
      if (r !== undefined) {
        remote = {
          route: r['route'] as string,
          ...(r['refreshButton'] === true ? { refreshButton: true } : {}),
        }
        const warn = (field: string) =>
          diags.push(
            diag('warning', 'schema', 'schema.dinkster.badMultiComboRemotePolicy', `${nodeType}.${id}: MULTI_COMBO remote ${field} is invalid; field dropped`),
          )
        if (r['controlAfterRefresh'] !== undefined) {
          if ((r['controlAfterRefresh'] === 'first' || r['controlAfterRefresh'] === 'last') && r['refreshButton'] === true)
            remote = {
              ...remote,
              controlAfterRefresh: r['controlAfterRefresh'],
            }
          else warn('controlAfterRefresh')
        }
        for (const [field, low, high] of [
          ['timeoutMs', 1, 60000],
          ['maxRetries', 0, 5],
          ['refreshMs', 0, 86400000],
        ] as const) {
          const value = r[field]
          if (value === undefined) continue
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high) remote = { ...remote, [field]: value }
          else warn(field)
        }
      }
      return {
        widgetType: 'MULTI_COMBO',
        options: outOptions,
        ...(remote ? { remote } : {}),
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // NUMBER carries presentation constraints on core.int/core.float inputs.
    // The SOCKET type is authoritative for integer-vs-float rendering and
    // validation (joint pin); the descriptor only carries constraints. Per
    // the BOOLEAN precedent, a malformed FIELD drops alone with a
    // warning and the input keeps a usable numeric widget - presentation
    // metadata never hides an editor. Integer sockets retain unsafe
    // constraints as canonical decimal strings; float sockets remain numbers.
    if (descriptor.type === 'NUMBER') {
      const numericKind = type.kind === 'concrete' ? PRIMITIVE_WIDGETS[type.name] : undefined
      if (numericKind !== 'INT' && numericKind !== 'FLOAT') {
        diags.push(
          diag('warning', 'schema', 'schema.dinkster.badNumberSocket', `${nodeType}.${id}: NUMBER descriptor on a non-numeric input; descriptor dropped`),
        )
      } else {
        const isInt = numericKind === 'INT'
        const options: Record<string, unknown> = {}
        for (const key of ['min', 'max', 'step'] as const) {
          const v = descriptor[key]
          if (v === undefined) continue
          const numeric = typeof v === 'number' && Number.isFinite(v)
          const exactInteger = (numeric && Number.isSafeInteger(v)) || isCanonicalUnsafeInteger(v)
          const positiveStep = key !== 'step' || (numeric && v > 0) || (isCanonicalUnsafeInteger(v) && BigInt(v) > 0n)
          if ((isInt ? exactInteger : numeric) && positiveStep) options[key] = v
          else {
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badNumberField',
                `${nodeType}.${id}: NUMBER ${key} '${String(v)}' is not an ${isInt ? 'exact integer' : 'finite number'}${key === 'step' ? ' > 0' : ''}; field dropped`,
              ),
            )
          }
        }
        const min = options['min']
        const max = options['max']
        const inverted =
          isInt && min !== undefined && max !== undefined
            ? BigInt(min as number | string) > BigInt(max as number | string)
            : typeof min === 'number' && typeof max === 'number' && min > max
        if (inverted) {
          diags.push(
            diag(
              'warning',
              'schema',
              'schema.dinkster.badNumberRange',
              `${nodeType}.${id}: NUMBER min ${String(options['min'])} > max ${String(options['max'])}; both dropped`,
            ),
          )
          delete options['min']
          delete options['max']
        }
        if (descriptor.display !== undefined) {
          if (typeof descriptor.display === 'string' && NUMBER_DISPLAY_MODES.has(descriptor.display)) {
            options['display'] = descriptor.display
          } else {
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badNumberDisplay',
                `${nodeType}.${id}: unknown NUMBER display '${String(descriptor.display)}'; display dropped`,
              ),
            )
          }
        }
        if (descriptor.round !== undefined) {
          if (numericKind === 'FLOAT' && typeof descriptor.round === 'number' && Number.isFinite(descriptor.round) && descriptor.round > 0) {
            options['round'] = descriptor.round
          } else {
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badNumberRound',
                `${nodeType}.${id}: NUMBER round '${String(descriptor.round)}' is not a finite positive float precision; field dropped`,
              ),
            )
          }
        }
        let controllerInitial: WidgetSpec['controllerInitial']
        if (descriptor.controlAfterGenerate !== undefined) {
          if (typeof descriptor.controlAfterGenerate === 'string' && CONTROL_AFTER_GENERATE_MODES.has(descriptor.controlAfterGenerate)) {
            controllerInitial = descriptor.controlAfterGenerate as NonNullable<WidgetSpec['controllerInitial']>
          } else {
            // The vocabulary is closed on the wire (the backend refuses
            // unknown modes at decode), so an unknown mode here is smuggled;
            // drop the CONTROL alone, never the numeric widget.
            diags.push(
              diag(
                'warning',
                'schema',
                'schema.dinkster.badControlAfterGenerate',
                `${nodeType}.${id}: unknown controlAfterGenerate '${String(descriptor.controlAfterGenerate)}'; control dropped`,
              ),
            )
          }
        }
        return {
          widgetType: numericKind,
          options,
          ...(controllerInitial !== undefined ? { controller: 'after_generate' as const, controllerInitial } : {}),
          ...(dflt !== undefined ? { default: dflt } : {}),
        }
      }
    }
    if (descriptor.type === 'STRING') {
      if (type.kind !== 'concrete' || type.name !== 'core.string') {
        diags.push(
          diag('warning', 'schema', 'schema.dinkster.badStringSocket', `${nodeType}.${id}: STRING descriptor on a non-string input; descriptor dropped`),
        )
      } else if (descriptor.multiline === true || descriptor.multiline === false || descriptor.multiline === undefined) {
        const options: Record<string, unknown> = {}
        if (descriptor.multiline !== undefined) options['multiline'] = descriptor.multiline
        if (descriptor.placeholder !== undefined) {
          if (typeof descriptor.placeholder === 'string') options['placeholder'] = descriptor.placeholder
          else
            diags.push(
              diag('warning', 'schema', 'schema.dinkster.badStringPlaceholder', `${nodeType}.${id}: STRING placeholder must be a string; field dropped`),
            )
        }
        if (descriptor.dynamicPrompts !== undefined) options['dynamicPrompts'] = descriptor.dynamicPrompts
        const textCompletions =
          descriptor.completions === undefined ? undefined : decodeTextCompletions(descriptor.completions, `${nodeType}.${id} widget.completions`)
        return {
          widgetType: 'STRING',
          options,
          ...(textCompletions === undefined ? {} : { textCompletions }),
          ...(dflt !== undefined ? { default: dflt } : {}),
        }
      } else {
        diags.push(
          diag(
            'warning',
            'schema',
            'schema.dinkster.badStringMultiline',
            `${nodeType}.${id}: STRING descriptor without multiline: true; falling back to the single-line widget`,
          ),
        )
      }
    }
    if (descriptor.type === 'COLOR') {
      return {
        widgetType: 'COLOR',
        options: {},
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    if (descriptor.type === 'CURVE') {
      return {
        widgetType: 'CURVE',
        options: {},
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    if (descriptor.type === 'COMPOSITOR') {
      return {
        widgetType: 'COMPOSITOR',
        options: {},
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    // BOOLEAN supports custom toggle labels. A label-less boolean carries no
    // descriptor at all (the core.boolean type alone implies the toggle);
    // empty strings are treated as absent per the omitted-when-empty wire
    // convention. A malformed label drops alone, never the widget.
    if (descriptor.type === 'BOOLEAN') {
      const labels: Record<string, string> = {}
      for (const key of ['labelOn', 'labelOff'] as const) {
        const v = descriptor[key]
        if (typeof v === 'string' && v !== '') labels[key] = v
        else if (v !== undefined && v !== '') {
          diags.push(diag('warning', 'schema', 'schema.dinkster.badBooleanLabel', `${nodeType}.${id}: BOOLEAN ${key} must be a string; label dropped`))
        }
      }
      return {
        widgetType: 'BOOLEAN',
        options: labels,
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    if (typeof descriptor.type === 'string' && descriptor.type !== '') {
      const options: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(descriptor)) {
        if (key !== 'type') options[key] = cloneJsonValue(value, `${nodeType}.${id}.widget.${key}`)
      }
      return {
        widgetType: descriptor.type,
        options,
        ...(dflt !== undefined ? { default: dflt } : {}),
      }
    }
    throw new Error(`${nodeType}.${id}: widget descriptor is incompatible with its input`)
  }
  if (type.kind !== 'concrete') return undefined
  const widgetType = PRIMITIVE_WIDGETS[type.name]
  if (widgetType === undefined) return undefined
  return {
    widgetType,
    options: {},
    ...(dflt !== undefined ? { default: dflt } : {}),
  }
}

function decodeInput(nodeType: string, entry: WireEntry, diags: Diagnostic[], normalizedType?: TypeExpr): InputSpec {
  const id = String(entry.id)
  const type = normalizedType ?? typeExprFromDinksterWire(entry.type)
  const required = entry.required !== false
  let onAbsent: AbsentPolicy | undefined
  if (entry.onAbsent !== undefined) {
    if (typeof entry.onAbsent === 'string' && ABSENT_POLICIES.has(entry.onAbsent)) {
      onAbsent = entry.onAbsent as AbsentPolicy
      if (onAbsent === 'omit' && required) {
        // The backend model rejects this combination at construction; a wire
        // that smuggles it is malformed. Fall back to the required default.
        diags.push(diag('warning', 'schema', 'schema.dinkster.badAbsentPolicy', `${nodeType}.${id}: onAbsent='omit' on a required input; using the default`))
        onAbsent = undefined
      }
    } else {
      diags.push(
        diag('warning', 'schema', 'schema.dinkster.badAbsentPolicy', `${nodeType}.${id}: unknown onAbsent '${String(entry.onAbsent)}'; using the default`),
      )
    }
  }
  const widget = widgetFor(nodeType, id, type, entry.default, entry.widget, diags)
  const representedUpload = widget?.representations?.representations.some((representation) => representation.widget.allowUpload === true) === true
  let sourceFilename: SourceFilenameSpec | undefined
  if (entry.sourceFilename !== undefined) {
    if (typeof entry.sourceFilename !== 'object' || entry.sourceFilename === null || Array.isArray(entry.sourceFilename)) {
      throw new Error(`${nodeType}.${id}.sourceFilename must be an object`)
    }
    const source = entry.sourceFilename as Record<string, unknown>
    rejectUnknownWidgetFields(source, ['kind', 'category'], `${nodeType}.${id}.sourceFilename`)
    if (
      source['kind'] !== 'media/image' &&
      source['kind'] !== 'media/audio' &&
      source['kind'] !== 'media/video' &&
      source['kind'] !== 'data/latent' &&
      source['kind'] !== 'media/model3d'
    ) {
      throw new Error(`${nodeType}.${id}.sourceFilename.kind is invalid`)
    }
    if (source['category'] !== 'input' && source['category'] !== 'output' && source['category'] !== 'temp') {
      throw new Error(`${nodeType}.${id}.sourceFilename.category is invalid`)
    }
    const isAssetExpr = (t: TypeExpr): boolean => (t.kind === 'concrete' && t.name === 'dinkster.asset') || t.kind === 'asset'
    const scalarAsset = isAssetExpr(type)
    const listedAsset = type.kind === 'list' && isAssetExpr(type.element)
    if (!scalarAsset && !listedAsset) {
      throw new Error(`${nodeType}.${id}.sourceFilename requires an asset-typed input (dinkster.asset, asset<T>, or a list of either)`)
    }
    if (widget?.representations !== undefined || widget?.widgetType !== 'ASSET' || widget.allowUpload !== true || widget.kind !== source['kind']) {
      throw new Error(`${nodeType}.${id}.sourceFilename requires a matching upload-enabled ASSET widget`)
    }
    sourceFilename = { kind: source['kind'], category: source['category'] }
  } else if (widget?.allowUpload === true || representedUpload) {
    throw new Error(`${nodeType}.${id} upload-enabled ASSET widget requires sourceFilename`)
  }
  // Per-input display label; empty is the wire's omitted-when-empty
  // convention, a non-string is smuggled - warn and fall back to the id.
  let displayName: string | undefined
  if (entry.displayName !== undefined && entry.displayName !== '') {
    if (typeof entry.displayName === 'string') displayName = entry.displayName
    else diags.push(diag('warning', 'schema', 'schema.dinkster.badDisplayName', `${nodeType}.${id}: displayName is not a string; using the id`))
  }
  return {
    kind: 'input',
    id,
    type,
    optional: !required,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(onAbsent !== undefined ? { onAbsent } : {}),
    ...(widget !== undefined ? { widget } : {}),
    ...(sourceFilename !== undefined ? { sourceFilename } : {}),
    ...(typeof entry.doc === 'string' && entry.doc !== '' ? { tooltip: entry.doc } : {}),
    // Preserve literal defaults on non-widget inputs even though they have
    // no editing surface, so translation remains lossless.
    ...(widget === undefined && entry.default !== undefined ? { ext: { default: entry.default } } : {}),
  }
}

/** A family's autogrow spec: one template slot typed as the member type. */
function familyDynamic(id: string, type: TypeExpr, entry: WireEntry): DynamicSpec {
  const min = typeof entry.minMembers === 'number' ? entry.minMembers : 0
  const max = typeof entry.maxMembers === 'number' ? entry.maxMembers : undefined
  return {
    kind: 'autogrow',
    ...(entry.role === 'outputFamily' ? { materialization: 'wire15' as const } : {}),
    template: [{ kind: 'input', id, type, optional: true }],
    naming: {
      kind: 'prefix',
      prefix: id,
      ...(min > 0 ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    },
  }
}

function decodeOutput(nodeType: string, entry: WireEntry, diags: Diagnostic[], normalizedType?: TypeExpr): OutputSpec {
  const id = String(entry.id)
  const type = normalizedType ?? typeExprFromDinksterWire(entry.type)

  const represents = decodeOutputRepresents(entry.represents)
  const knownValue = decodeOutputKnownValue(entry.knownValue)
  return {
    kind: 'output',
    id,
    type,
    ...(entry.optional === true ? { optional: true } : {}),
    ...(typeof entry.doc === 'string' && entry.doc !== '' ? { tooltip: entry.doc } : {}),
    ...(represents !== undefined ? { represents } : {}),
    ...(knownValue !== undefined ? { knownValue } : {}),
  }
}

function wirePreview(entry: Record<string, unknown>, where: string): { preview?: true } {
  if (entry['preview'] === undefined || entry['preview'] === false) return {}
  if (entry['preview'] !== true) throw new Error(`${where}.preview must be a boolean`)
  return { preview: true }
}

const WIRE_SEGMENT = /^[A-Za-z0-9_-]+$/
const WIRE_COMBO_OPTION_KEY = /^[!-~]+( [!-~]+)*$/
const MAX_DYNAMIC_DEPTH = 16
const MAX_DYNAMIC_ITEMS = 512

interface WireDecodeBudget {
  remaining: number
}

function wireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function wireSegment(value: unknown, where: string): string {
  if (typeof value !== 'string' || !WIRE_SEGMENT.test(value)) {
    throw new Error(`${where} must match [A-Za-z0-9_-]+`)
  }
  return value
}

function wireComboOptionKey(value: unknown, where: string): string {
  if (typeof value !== 'string' || WIRE_COMBO_OPTION_KEY.exec(value)?.[0] !== value) {
    throw new Error(`${where} must match [!-~]+( [!-~]+)*`)
  }
  return value
}

// The co-pinned [A-Za-z0-9_-]+ grammar covers STRUCTURAL segments only:
// construct ids, nested entry ids, template leaf ids, variant keys,
// memberPrefix, and memberNames entries. DynamicCombo option keys use
// [!-~]+( [!-~]+)*; they never join
// dot-scoped paths. Ordinary top-level input and output ids also never join a
// dot-joined construct path, so they keep the top-level leniency (any non-empty
// string; upstream emits ids like "input_blocks.0." and "Audio VAE").
function wireEntryId(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where} must be a non-empty string`)
  }
  return value
}

function wireBoolean(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`)
  return value
}

function wireOptionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value
}

function wireBound(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where} must be a safe non-negative integer`)
  }
  return value
}

function wireJson(value: unknown, where: string): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where} must be JSON`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => wireJson(item, `${where}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      wireJson(item, `${where}.${key}`)
    }
    return
  }
  throw new Error(`${where} must be JSON`)
}

function wireType(value: unknown, where: string): TypeExpr {
  const type = wireObject(value, where)
  const stringList = (raw: unknown, field: string, minimum: number): string[] => {
    if (!Array.isArray(raw) || raw.length < minimum || !raw.every((item) => typeof item === 'string' && item !== '')) {
      throw new Error(`${where}.${field} must contain at least ${minimum} non-empty string${minimum === 1 ? '' : 's'}`)
    }
    if (raw.some((item: string) => item.startsWith('stream<'))) throw new Error(`${where} stream type requires a structured constructor`)
    return [...raw] as string[]
  }
  switch (type['kind']) {
    case 'concrete': {
      const types = stringList(type['types'], 'types', 1)
      if (types.length !== 1) throw new Error(`${where}.types must contain exactly one string`)
      return { kind: 'concrete', name: types[0]! }
    }
    case 'union':
      return { kind: 'union', names: stringList(type['types'], 'types', 2) }
    case 'wildcard':
      return { kind: 'wildcard' }
    case 'variable': {
      if (typeof type['templateId'] !== 'string' || type['templateId'] === '') {
        throw new Error(`${where}.templateId must be a non-empty string`)
      }
      if (type['types'] !== undefined) throw new Error(`${where}.types is not a variable field; use allowed`)
      const allowed = type['allowed'] === undefined ? undefined : stringList(type['allowed'], 'allowed', 1)
      return {
        kind: 'variable',
        templateId: type['templateId'],
        ...(allowed !== undefined
          ? {
              allowedTypes: allowed.map((name): TypeExpr => ({ kind: 'concrete', name })),
            }
          : {}),
      }
    }
    case 'list':
    case 'asset':
    case 'stream':
      return {
        kind: type['kind'],
        element: wireType(type['element'], `${where}.element`),
      }
    default:
      throw new Error(`${where} has unknown type expression kind '${String(type['kind'])}'`)
  }
}

function wirePresentation(
  entry: Record<string, unknown>,
  where: string,
): {
  displayName?: string
  tooltip?: string
} {
  const displayName = wireOptionalString(entry['displayName'], `${where}.displayName`)
  const tooltip = wireOptionalString(entry['doc'], `${where}.doc`)
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(tooltip !== undefined ? { tooltip } : {}),
  }
}

function decodeWireOrdinary(nodeType: string, entry: Record<string, unknown>, where: string, diags: Diagnostic[], depth: number): InputSpec {
  // Nested ordinary entries are structural (they extend dot-joined construct
  // paths); top-level ordinary inputs are plain ids.
  const id = depth > 0 ? wireSegment(entry['id'], `${where}.id`) : wireEntryId(entry['id'], `${where}.id`)
  const required = wireBoolean(entry['required'], `${where}.required`, true)
  wireBoolean(entry['forceInput'], `${where}.forceInput`, false)
  wireBoolean(entry['advanced'], `${where}.advanced`, false)
  const hidden = wireBoolean(entry['hidden'], `${where}.hidden`, false)
  wireJson(entry['default'], `${where}.default`)
  if (entry['onAbsent'] !== undefined && (typeof entry['onAbsent'] !== 'string' || !ABSENT_POLICIES.has(entry['onAbsent']))) {
    throw new Error(`${where}.onAbsent is invalid`)
  }
  if (required && entry['onAbsent'] === 'omit') {
    throw new Error(`${where}.onAbsent cannot be 'omit' when required`)
  }
  const normalized = decodeInput(nodeType, entry as WireEntry, diags, wireType(entry['type'], `${where}.type`))
  return {
    ...normalized,
    id,
    ...(entry['forceInput'] === true ? { forceInput: true } : {}),
    ...(entry['advanced'] === true ? { advanced: true } : {}),
    ...(hidden ? { hidden: true } : {}),
  }
}

function decodeWireOrdinaryInput(nodeType: string, entry: Record<string, unknown>, where: string, diags: Diagnostic[], depth: number): InputSpec {
  const normalized = decodeWireOrdinary(nodeType, entry, where, diags, depth)
  const lazy = wireBoolean(entry['lazy'], `${where}.lazy`, false)
  return {
    ...normalized,
    ...(lazy ? { lazy: true } : {}),
  }
}

function decodeWireEntries(
  nodeType: string,
  value: unknown,
  where: string,
  diags: Diagnostic[],
  budget: WireDecodeBudget,
  depth: number,
  nonEmpty = false,
): readonly InputSpec[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  if (nonEmpty && value.length === 0) throw new Error(`${where} must be non-empty`)
  if (depth > MAX_DYNAMIC_DEPTH) {
    throw new Error(`${where} exceeds the ${MAX_DYNAMIC_DEPTH}-level dynamic nesting limit`)
  }
  const entries: InputSpec[] = []
  const ids = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (budget.remaining-- <= 0) {
      throw new Error(`${where} exceeds the ${MAX_DYNAMIC_ITEMS}-item dynamic-entry budget`)
    }
    const childWhere = `${where}[${index}]`
    const entry = wireObject(raw, childWhere)
    const id = wireSegment(entry['id'], `${childWhere}.id`)
    if (ids.has(id)) throw new Error(`${where} declares duplicate id '${id}'`)
    ids.add(id)
    entries.push(decodeWireEntry(nodeType, entry, childWhere, diags, budget, depth))
  }
  return entries
}

function decodeWireFamily(
  nodeType: string,
  entry: Record<string, unknown>,
  where: string,
  diags: Diagnostic[],
  budget: WireDecodeBudget,
  depth: number,
): InputSpec {
  const id = wireSegment(entry['id'], `${where}.id`)
  if (entry['template'] === undefined || entry['type'] !== undefined) {
    throw new Error(`${where} must carry template and must not carry legacy type`)
  }
  const decodedTemplate = decodeWireEntries(nodeType, entry['template'], `${where}.template`, diags, budget, depth + 1, true)
  const min = wireBound(entry['minMembers'], `${where}.minMembers`)
  const max = wireBound(entry['maxMembers'], `${where}.maxMembers`)
  const hasPrefix = Object.prototype.hasOwnProperty.call(entry, 'memberPrefix')
  const hasNames = Object.prototype.hasOwnProperty.call(entry, 'memberNames')
  if (hasPrefix && hasNames) throw new Error(`${where} cannot carry both memberPrefix and memberNames`)
  let naming: Extract<DynamicSpec, { kind: 'autogrow' }>['naming']
  if (hasNames) {
    if (max !== undefined) throw new Error(`${where}.maxMembers is forbidden with memberNames`)
    if (!Array.isArray(entry['memberNames'])) throw new Error(`${where}.memberNames must be an array`)
    const names = entry['memberNames'].map((name, index) => wireSegment(name, `${where}.memberNames[${index}]`))
    if (new Set(names).size !== names.length) throw new Error(`${where}.memberNames must be unique`)
    if ((min ?? 0) > names.length) throw new Error(`${where}.minMembers exceeds memberNames length`)
    naming = { kind: 'names', names, ...(min !== undefined ? { min } : {}) }
  } else if (hasPrefix) {
    const prefix = wireSegment(entry['memberPrefix'], `${where}.memberPrefix`)
    if (max !== undefined && (min ?? 0) > max) throw new Error(`${where}.minMembers exceeds maxMembers`)
    naming = {
      kind: 'prefix',
      prefix,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }
  } else {
    if (max !== undefined && (min ?? 0) > max) throw new Error(`${where}.minMembers exceeds maxMembers`)
    // No wire naming vocabulary: the backend elaborates any structural
    // suffix under the family id ('items.<suffix>'), so mint members with
    // the family id as the prefix - the same policy familyDynamic applies
    // to legacy and output families. Mapping to prefix naming here gives
    // these families the full prefix lifecycle (min-fill, ghost growth,
    // subgraph flatten) instead of the fenced native arm, which has no
    // document suffix source and renders zero members.
    naming = {
      kind: 'prefix',
      prefix: id,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    }
  }
  // The compatibility encoder synthesizes "value" only for a top-level
  // prefix family. Nested families and names vocabularies use dot-scoped
  // identities even when their authored leaf is named "value".
  const flatFamilyCompatible =
    depth === 0 && naming.kind === 'prefix' && decodedTemplate.length === 1 && decodedTemplate[0]!.dynamic === undefined && decodedTemplate[0]!.id === 'value'
  let template = decodedTemplate
  if (flatFamilyCompatible) {
    const { widget: _inferredWidget, ...compatLeaf } = decodedTemplate[0]!
    template = [{ ...compatLeaf, id }]
  }
  const required = wireBoolean(entry['required'], `${where}.required`, false)
  return {
    kind: 'input',
    id,
    type: { kind: 'wildcard' },
    optional: !required,
    ...wirePresentation(entry, where),
    dynamic: {
      kind: 'autogrow',
      template,
      naming,
      ...(!flatFamilyCompatible ? { materialization: 'wire15' as const } : {}),
    },
  }
}

function decodeWireCombo(
  nodeType: string,
  entry: Record<string, unknown>,
  where: string,
  diags: Diagnostic[],
  budget: WireDecodeBudget,
  depth: number,
): InputSpec {
  const id = wireSegment(entry['id'], `${where}.id`)
  if (!Array.isArray(entry['options'])) throw new Error(`${where}.options must be an array`)
  if (entry['widget'] !== undefined) throw new Error(`${where}.widget is forbidden; selector options are derived`)
  const optionKeys = new Set<string>()
  const options = entry['options'].map((raw, index) => {
    const optionWhere = `${where}.options[${index}]`
    const option = wireObject(raw, optionWhere)
    const key = wireComboOptionKey(option['key'], `${optionWhere}.key`)
    if (optionKeys.has(key)) throw new Error(`${where} declares duplicate option key '${key}'`)
    optionKeys.add(key)
    return {
      key,
      inputs: decodeWireEntries(nodeType, option['inputs'], `${optionWhere}.inputs`, diags, budget, depth + 1),
    }
  })
  for (const option of options) {
    const aliased = options.find((sibling) => sibling !== option && option.key.startsWith(`${sibling.key}]`))
    if (aliased !== undefined) {
      throw new Error(`${where} option key '${option.key}' aliases sibling key '${aliased.key}'`)
    }
  }
  if (entry['default'] !== undefined && (typeof entry['default'] !== 'string' || !optionKeys.has(entry['default']))) {
    throw new Error(`${where}.default must name an option`)
  }
  const required = wireBoolean(entry['required'], `${where}.required`, false)
  return {
    kind: 'input',
    id,
    type: { kind: 'concrete', name: 'core.combo' },
    optional: !required,
    ...wirePresentation(entry, where),
    widget: {
      widgetType: 'COMBO',
      options: { options: options.map((option) => option.key) },
      ...(entry['default'] !== undefined ? { default: entry['default'] } : {}),
    },
    // Retain the validated descriptor field for fidelity, but the
    // DynamicCombo lifecycle deliberately chooses the first option just as
    // stock Comfy does; effectiveComboOption treats this value as inert.
    dynamic: {
      kind: 'dynamicCombo',
      materialization: 'wire15',
      options,
      ...(typeof entry['default'] === 'string' ? { defaultOption: entry['default'] } : {}),
    },
  }
}

function wireSlotTypeFromVariants(variants: readonly { type: TypeExpr }[]): TypeExpr {
  if (variants.length === 1) return variants[0]!.type
  if (variants.length > 1 && variants.every((variant) => variant.type.kind === 'concrete')) {
    const names = [...new Set(variants.map((variant) => (variant.type as Extract<TypeExpr, { kind: 'concrete' }>).name))]
    return names.length === 1 ? { kind: 'concrete', name: names[0]! } : { kind: 'union', names }
  }
  return { kind: 'wildcard' }
}

function wireRecursivelyConcrete(type: TypeExpr): boolean {
  return type.kind === 'concrete' || ((type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') && wireRecursivelyConcrete(type.element))
}

function decodeWireSlot(
  nodeType: string,
  entry: Record<string, unknown>,
  where: string,
  diags: Diagnostic[],
  budget: WireDecodeBudget,
  depth: number,
): InputSpec {
  const id = wireSegment(entry['id'], `${where}.id`)
  const hasVariants = Object.prototype.hasOwnProperty.call(entry, 'variants')
  const hasSlotType = Object.prototype.hasOwnProperty.call(entry, 'slotType')
  if (hasVariants === hasSlotType) throw new Error(`${where} must carry exactly one of variants or slotType`)
  if (entry['typeTemplateId'] === '') {
    throw new Error(`${where}.typeTemplateId must be a non-empty string`)
  }
  const typeTemplateId = wireOptionalString(entry['typeTemplateId'], `${where}.typeTemplateId`)
  if (!Object.prototype.hasOwnProperty.call(entry, 'required')) throw new Error(`${where}.required is mandatory`)
  const required = wireBoolean(entry['required'], `${where}.required`, false)
  const shared = entry['inputs'] === undefined && hasVariants ? [] : decodeWireEntries(nodeType, entry['inputs'], `${where}.inputs`, diags, budget, depth + 1)
  let slotType: TypeExpr
  let variants:
    | {
        key: string
        type: TypeExpr
        inputs: readonly InputSpec[]
        tooltip?: string
      }[]
    | undefined
  let forceInput = false
  if (hasSlotType) {
    if (typeTemplateId !== undefined) throw new Error(`${where}.typeTemplateId is only legal on closed dynamicSlot`)
    if (required) throw new Error(`${where}.required must be false on open-form dynamicSlot`)
    slotType = wireType(entry['slotType'], `${where}.slotType`)
    if (slotType.kind === 'variable') throw new Error(`${where}.slotType cannot be a variable`)
    forceInput = wireBoolean(entry['forceInput'], `${where}.forceInput`, false)
  } else {
    if (typeTemplateId !== undefined && !required) throw new Error(`${where}.typeTemplateId requires a required dynamicSlot`)
    if (typeTemplateId !== undefined && depth !== 0) throw new Error(`${where}.typeTemplateId is only legal on a top-level dynamicSlot`)
    if (entry['forceInput'] !== undefined) throw new Error(`${where}.forceInput is only legal on open-form dynamicSlot`)
    if (!Array.isArray(entry['variants'])) throw new Error(`${where}.variants must be an array`)
    const keys = new Set<string>()
    variants = entry['variants'].map((raw, index) => {
      const variantWhere = `${where}.variants[${index}]`
      const variant = wireObject(raw, variantWhere)
      const key = wireSegment(variant['key'], `${variantWhere}.key`)
      if (keys.has(key)) throw new Error(`${where} declares duplicate variant key '${key}'`)
      keys.add(key)
      const inputs = variant['inputs'] === undefined ? [] : decodeWireEntries(nodeType, variant['inputs'], `${variantWhere}.inputs`, diags, budget, depth + 1)
      const sharedIds = new Set(shared.map((input) => input.id))
      const collision = inputs.find((input) => sharedIds.has(input.id))
      if (collision !== undefined) throw new Error(`${variantWhere}.inputs id '${collision.id}' collides with a shared dependent`)
      const tooltip = wireOptionalString(variant['doc'], `${variantWhere}.doc`)
      const type = wireType(variant['type'], `${variantWhere}.type`)
      if (!wireRecursivelyConcrete(type)) throw new Error(`${variantWhere}.type must be recursively concrete`)
      return {
        key,
        type,
        inputs,
        ...(tooltip !== undefined ? { tooltip } : {}),
      }
    })
    slotType = wireSlotTypeFromVariants(variants)
  }
  return {
    kind: 'input',
    id,
    type: slotType,
    optional: !required,
    ...wirePresentation(entry, where),
    ...(forceInput ? { forceInput: true } : {}),
    dynamic: {
      kind: 'dynamicSlot',
      materialization: 'wire15',
      slotType,
      inputs: shared,
      ...(variants !== undefined ? { variants } : {}),
      ...(typeTemplateId !== undefined ? { typeTemplateId } : {}),
      ...(forceInput ? { forceInput: true } : {}),
    },
  }
}

function* slotTypeBindingsOf(
  inputs: readonly InputSpec[],
  depth = 0,
): Generator<{
  readonly input: InputSpec
  readonly spec: DynamicSlotSpec
  readonly depth: number
}> {
  for (const input of inputs) {
    const dynamic = input.dynamic
    if (dynamic === undefined) continue
    if (dynamic.kind === 'autogrow') {
      yield* slotTypeBindingsOf(dynamic.template, depth + 1)
    } else if (dynamic.kind === 'dynamicCombo') {
      for (const option of dynamic.options) yield* slotTypeBindingsOf(option.inputs, depth + 1)
    } else {
      yield { input, spec: dynamic, depth }
      yield* slotTypeBindingsOf(dynamic.inputs, depth + 1)
      for (const variant of dynamic.variants ?? []) {
        yield* slotTypeBindingsOf(variant.inputs, depth + 1)
      }
    }
  }
}

function* typeVariablesOf(type: TypeExpr): Generator<TypeExpr & { readonly kind: 'variable' }> {
  if (type.kind === 'variable') yield type
  else if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') yield* typeVariablesOf(type.element)
}

function validateSlotTypeBindings(inputs: readonly InputSpec[], outputs: readonly OutputSpec[]): void {
  const outputVariables = outputs.flatMap((output) => [...typeVariablesOf(output.type)])
  const bindings = new Set<string>()
  for (const { input, spec, depth } of slotTypeBindingsOf(inputs)) {
    const templateId = spec.typeTemplateId
    if (templateId === undefined) continue
    if (depth !== 0) throw new Error(`dynamicSlot '${input.id}' typeTemplateId is only legal on a top-level slot`)
    if (input.optional) throw new Error(`dynamicSlot '${input.id}' typeTemplateId requires a required slot`)
    if (spec.variants === undefined) throw new Error(`dynamicSlot '${input.id}' typeTemplateId is only legal on a closed slot`)
    if (bindings.has(templateId)) throw new Error(`type variable '${templateId}' is bound by multiple dynamic slots`)
    bindings.add(templateId)
    const matchingOutputs = outputVariables.filter((variable) => variable.templateId === templateId)
    if (matchingOutputs.length === 0) {
      throw new Error(`dynamicSlot '${input.id}' binds type variable '${templateId}', but no output uses it`)
    }
    for (const variant of spec.variants) {
      const typeId = canonicalTypeIdOf(variant.type)
      if (typeId === undefined) throw new Error(`dynamicSlot '${input.id}' variant '${variant.key}' type must be recursively concrete`)
      if (
        matchingOutputs.some(
          (variable) => variable.allowedTypes !== undefined && !variable.allowedTypes.some((allowed) => canonicalTypeIdOf(allowed) === typeId),
        )
      ) {
        throw new Error(`dynamicSlot '${input.id}' variant '${variant.key}' type '${typeId}' is outside output variable '${templateId}' allowlist`)
      }
    }
  }
}

function decodeWireEntry(
  nodeType: string,
  entry: Record<string, unknown>,
  where: string,
  diags: Diagnostic[],
  budget: WireDecodeBudget,
  depth: number,
): InputSpec {
  const acceptsStorage = acceptsStorageOf(entry, where)
  const acceptsStream = acceptsStreamOf(entry, where)
  if (entry['role'] !== 'input' && depth >= MAX_DYNAMIC_DEPTH) {
    throw new Error(`${where} exceeds the ${MAX_DYNAMIC_DEPTH}-level dynamic nesting limit`)
  }
  let decoded: InputSpec
  switch (entry['role']) {
    case 'input':
      decoded = decodeWireOrdinaryInput(nodeType, entry, where, diags, depth)
      break
    case 'inputFamily':
      decoded = decodeWireFamily(nodeType, entry, where, diags, budget, depth)
      break
    case 'dynamicCombo':
      decoded = decodeWireCombo(nodeType, entry, where, diags, budget, depth)
      break
    case 'dynamicSlot':
      decoded = decodeWireSlot(nodeType, entry, where, diags, budget, depth)
      break
    default:
      throw new Error(`${where}.role has unknown structural kind '${String(entry['role'])}'`)
  }
  return {
    ...decoded,
    ...acceptsStorage,
    ...acceptsStream,
    ...mediaPolicyOf(entry, where),
  }
}

export function parseDinksterSchema(nodeType: string, wire: DinksterWireSchema): DinksterParseResult {
  const diags: Diagnostic[] = []
  try {
    if (wire.schemaVersion !== undefined && wire.schemaVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
      throw new Error(`expected schema wire version ${DINKSTER_SCHEMA_WIRE_VERSION}, received ${String(wire.schemaVersion)}`)
    }
    if (!Array.isArray(wire.interface)) throw new Error('interface must be an array')
    const items: InterfaceItem[] = []
    const inputIds = new Set<string>()
    const outputIds = new Set<string>()
    const budget: WireDecodeBudget = { remaining: MAX_DYNAMIC_ITEMS }
    for (const [index, raw] of wire.interface.entries()) {
      const where = `interface[${index}]`
      const entry = wireObject(raw, where)
      if (entry['role'] !== 'input') acceptsStorageOf(entry, where)
      if (entry['role'] !== 'input') acceptsStreamOf(entry, where)
      if (entry['count'] !== undefined && entry['role'] !== 'outputFamily') {
        throw new Error(`${where}.count is only valid on outputFamily`)
      }
      if (entry['role'] === 'outputDescriptors') {
        const descriptors = decodeOutputDescriptors(entry, where)
        if (outputIds.has(descriptors.input)) throw new Error(`duplicate output construct '${descriptors.input}'`)
        outputIds.add(descriptors.input)
        items.push({
          kind: 'output',
          id: descriptors.input,
          type: descriptors.choices[0]!.type,
          outputDescriptors: descriptors,
        })
        continue
      }
      if (entry['role'] === 'output' || entry['role'] === 'outputFamily') {
        // outputFamily ids are construct ids (structural); ordinary output
        // ids keep top-level leniency.
        const id = entry['role'] === 'outputFamily' ? wireSegment(entry['id'], `${where}.id`) : wireEntryId(entry['id'], `${where}.id`)
        if (outputIds.has(id)) throw new Error(`interface declares duplicate output id '${id}'`)
        outputIds.add(id)
        if (entry['role'] === 'output') {
          items.push({
            ...decodeOutput(nodeType, entry as WireEntry, diags, wireType(entry['type'], `${where}.type`)),
            ...wirePreview(entry, where),
            ...mediaPolicyOf(entry, where),
          })
        } else {
          const type = wireType(entry['type'], `${where}.type`)
          let count: { input: string; suffix: 'index' } | undefined
          if (entry['count'] !== undefined) {
            const rawCount = wireObject(entry['count'], `${where}.count`)
            const keys = Object.keys(rawCount).sort()
            if (keys.length !== 2 || keys[0] !== 'input' || keys[1] !== 'suffix') throw new Error(`${where}.count must contain exactly input and suffix`)
            const input = wireSegment(rawCount['input'], `${where}.count.input`)
            if (rawCount['suffix'] !== 'index') throw new Error(`${where}.count.suffix must be 'index'`)
            count = { input, suffix: 'index' }
          }
          items.push({
            kind: 'output',
            id,
            type,
            ...wirePreview(entry, where),
            ...mediaPolicyOf(entry, where),
            dynamic: {
              ...familyDynamic(id, type, entry as WireEntry),
              ...(count !== undefined ? { count } : {}),
            },
          })
        }
        continue
      }
      // Duplicate tracking only needs a well-formed string here; construct
      // decoders (inputFamily/dynamicCombo/dynamicSlot) enforce the strict
      // structural segment grammar on their own ids.
      const id = wireEntryId(entry['id'], `${where}.id`)
      if (inputIds.has(id)) throw new Error(`interface declares duplicate input id '${id}'`)
      inputIds.add(id)
      items.push(decodeWireEntry(nodeType, entry, where, diags, budget, 0))
    }
    const idempotent = wire.idempotent !== false
    const deprecation = decodeDeprecation(nodeType, wire.deprecation, diags)
    const searchVisibility = decodeSearchVisibility(nodeType, wire.searchVisibility, diags)
    const replacements = decodeReplacements(nodeType, wire.replacements, diags)
    const searchTerms = Array.isArray(wire.searchTerms) && wire.searchTerms.every((term) => typeof term === 'string') ? ([...wire.searchTerms] as string[]) : []
    const aliases = Array.isArray(wire.aliases) ? wire.aliases.filter((alias): alias is string => typeof alias === 'string' && alias !== '') : []
    const executionArms = Array.isArray(wire.executionArms)
      ? wire.executionArms.filter((arm): arm is 'native' | 'comfyui' => arm === 'native' || arm === 'comfyui')
      : []
    const baseSchema: NodeSchema = {
      type: nodeType,
      displayName: typeof wire.displayName === 'string' && wire.displayName !== '' ? wire.displayName : nodeType,
      category: typeof wire.category === 'string' ? wire.category : '',
      ...(typeof wire.editorRole === 'string' && wire.editorRole !== '' ? { editorRole: wire.editorRole } : {}),
      ...(typeof wire.pack === 'string' && wire.pack !== '' ? { pack: wire.pack } : {}),
      ...(typeof wire.signature === 'string' && wire.signature !== '' ? { signature: wire.signature } : {}),
      ...(executionArms.length > 0 ? { executionArms: [...new Set(executionArms)] } : {}),
      ...(typeof wire.description === 'string' && wire.description !== '' ? { description: wire.description } : {}),
      source: 'v3',
      items: [],
      isOutputNode: wire.outputNode === true || !idempotent,
      ...(wire.emitsPreviews === true ? { emitsPreviews: true } : {}),
      ...(wire.hasDocs === true ? { hasDocs: true } : {}),
      ...(deprecation !== undefined ? { deprecation } : {}),
      ...(searchVisibility !== undefined ? { searchVisibility } : {}),
      searchTerms,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(replacements !== undefined ? { replacements } : {}),
      ext: {
        dinkster: {
          version: typeof wire.version === 'number' ? wire.version : 1,
          idempotent,
          ...(Array.isArray(wire.occupies) && wire.occupies.length > 0 ? { occupies: wire.occupies.map(String) } : {}),
          ...(wire.ioBound === true ? { ioBound: true } : {}),
        },
      },
    }
    const decodedInputs = new Map(items.filter((item): item is InputSpec => item.kind === 'input').map((item) => [item.id, item]))
    const decodedOutputs = items.filter((item): item is OutputSpec => item.kind === 'output')
    if (decodedOutputs.filter((output) => output.outputDescriptors !== undefined).length > 1) {
      throw new Error('a schema may declare only one outputDescriptors construct')
    }
    for (const output of decodedOutputs) {
      const spec = output.outputDescriptors
      if (spec === undefined) continue
      const input = decodedInputs.get(spec.input)
      if (!input || input.dynamic || input.optional || input.type.kind !== 'concrete' || input.type.name !== 'core.string') {
        throw new Error(`output descriptors '${spec.input}' require an ordinary required core.string input`)
      }
      if (spec.probe) {
        const asset = decodedInputs.get(spec.probe.input)
        if (!spec.fixedIds || !asset || asset.dynamic || asset.optional || asset.type.kind !== 'concrete' || asset.type.name !== 'dinkster.asset') {
          throw new Error(`output descriptor probe requires fixedIds and an ordinary required dinkster.asset input`)
        }
      }
    }
    for (const output of decodedOutputs) {
      const knownValue = output.knownValue
      if (knownValue === undefined) continue
      const input = decodedInputs.get(knownValue.input)
      const primitive = output.type.kind === 'concrete' && PRIMITIVE_WIDGETS[output.type.name] !== undefined
      if (input === undefined || input.dynamic !== undefined || !primitive || input.type.kind !== 'concrete' || input.type.name !== output.type.name) {
        throw new Error(`output '${output.id}' knownValue must name an ordinary input with the same concrete primitive type`)
      }
    }
    for (const output of decodedOutputs) {
      const dynamic = output.dynamic
      if (dynamic?.kind !== 'autogrow' || !('count' in dynamic)) continue
      const count = (dynamic as CountBoundOutputAutogrowSpec).count
      const input = decodedInputs.get(count.input)
      if (input === undefined) throw new Error(`output family '${output.id}' count names unknown input '${count.input}'`)
      if (input.dynamic !== undefined || input.optional || input.type.kind !== 'concrete' || input.type.name !== 'core.int') {
        throw new Error(`output family '${output.id}' count input must be an ordinary required core.int input`)
      }
    }
    validateSlotTypeBindings([...decodedInputs.values()], decodedOutputs)
    const selector = decodeWireSelector(wire.selector, decodedInputs, decodedOutputs)
    const widgetGroups = decodeWidgetGroups(wire.widgetGroups, decodedInputs)
    const mirror = decodeMirror(wire.mirror)
    const chunkSafe = decodeChunkSafe(wire, decodedInputs, decodedOutputs)
    return {
      schema: {
        ...baseSchema,
        items,
        ...(selector !== undefined ? { selector } : {}),
        ...(widgetGroups !== undefined ? { widgetGroups } : {}),
        ...(mirror !== undefined ? { mirror } : {}),
        ...(chunkSafe !== undefined ? { chunkSafe } : {}),
      },
      diagnostics: diags,
    }
  } catch (error) {
    return {
      schema: undefined,
      diagnostics: [
        ...diags,
        diag('error', 'schema', 'schema.parse.threw', `${nodeType}: schema parse threw: ${error instanceof Error ? error.message : String(error)}`),
      ],
    }
  }
}

function decodeWidgetGroups(raw: unknown, inputs: ReadonlyMap<string, InputSpec>): readonly ConditionalWidgetGroup[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('widgetGroups must be a non-empty array')
  }
  const widgetInputs = new Map(
    [...inputs.values()].filter((input) => input.dynamic === undefined && input.widget !== undefined).map((input) => [input.id, input]),
  )
  const decodeCondition = (rawCondition: unknown, where: string): ConditionalWidgetCondition => {
    const condition = wireObject(rawCondition, where)
    if (Object.keys(condition).sort().join(',') !== 'input,values') {
      throw new Error(`${where} must contain exactly input and values`)
    }
    const input = condition['input']
    const values = condition['values']
    if (typeof input !== 'string' || input === '') {
      throw new Error(`${where}.input must be a non-empty string`)
    }
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      !values.every(
        (value) =>
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))),
      )
    ) {
      throw new Error(`${where}.values must be non-empty JSON scalars`)
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`${where}.values must be unique`)
    }
    if (!widgetInputs.has(input)) {
      throw new Error(`${where}.input must name a top-level widget input`)
    }
    return { input, values }
  }
  return raw.map((entry, index) => {
    const group = wireObject(entry, `widgetGroups[${index}]`)
    const keys = Object.keys(group).sort().join(',')
    if (keys !== 'input,members,values' && keys !== 'input,members,requires,values') {
      throw new Error(`widgetGroups[${index}] must contain input, values, members, and optional requires`)
    }
    const condition = decodeCondition({ input: group['input'], values: group['values'] }, `widgetGroups[${index}]`)
    const { input, values } = condition
    const members = group['members']
    if (
      !Array.isArray(members) ||
      members.length === 0 ||
      !members.every((member) => typeof member === 'string' && member !== '') ||
      new Set(members).size !== members.length
    )
      throw new Error(`widgetGroups[${index}].members must be unique non-empty strings`)
    const rawRequires = group['requires']
    if (rawRequires !== undefined && (!Array.isArray(rawRequires) || rawRequires.length === 0)) {
      throw new Error(`widgetGroups[${index}].requires must be a non-empty array`)
    }
    const requires =
      rawRequires === undefined
        ? []
        : rawRequires.map((required, requiredIndex) => decodeCondition(required, `widgetGroups[${index}].requires[${requiredIndex}]`))
    const drivers = [input, ...requires.map((required) => required.input)]
    if (new Set(drivers).size !== drivers.length) {
      throw new Error(`widgetGroups[${index}] condition inputs must be unique`)
    }
    for (const member of members) {
      if (!widgetInputs.has(member)) throw new Error(`widgetGroups[${index}].members must name top-level widget inputs`)
      if (drivers.includes(member)) throw new Error(`widgetGroups[${index}] conditions cannot control themselves`)
    }
    return {
      input,
      values,
      members,
      ...(requires.length > 0 ? { requires } : {}),
    } as ConditionalWidgetGroup
  })
}

const MIRROR_KINDS: ReadonlySet<string> = new Set(['expression', 'glsl'])
const MIRROR_PRECISIONS: ReadonlySet<string> = new Set(['exact', 'bounded'])
const MIRROR_FIELDS: ReadonlySet<string> = new Set(['kind', 'precision', 'tolerance', 'grammarVersion', 'source', 'applies'])
const MIRROR_TOLERANCE_FIELDS: ReadonlySet<string> = new Set(['relative', 'perChannel'])
/** Byte ceiling for glsl mirror source; matches the backend declaration limit. */
const MAX_MIRROR_SOURCE_BYTES = 16384

function decodeMirrorTolerance(raw: unknown): MirrorTolerance {
  const tolerance = wireObject(raw, 'mirror.tolerance')
  for (const key of Object.keys(tolerance)) {
    if (!MIRROR_TOLERANCE_FIELDS.has(key)) throw new Error(`mirror.tolerance has unknown field '${key}'`)
  }
  const relative = tolerance['relative']
  const perChannel = tolerance['perChannel']
  if (relative === undefined && perChannel === undefined) {
    throw new Error('mirror.tolerance must declare relative or perChannel')
  }
  for (const [name, value] of [
    ['relative', relative],
    ['perChannel', perChannel],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`mirror.tolerance.${name} must be a finite positive number`)
    }
  }
  return {
    ...(relative !== undefined ? { relative: relative as number } : {}),
    ...(perChannel !== undefined ? { perChannel: perChannel as number } : {}),
  }
}

/**
 * The mirror applies scope: combo id -> covered option keys. Strict like
 * every mirror field - the scope is a soundness boundary, so a malformed
 * scope fails the node rather than decoding into an over- or under-applied
 * mirror.
 */
function decodeApplies(raw: unknown, subject: string): Readonly<Record<string, readonly string[]>> {
  const entries = Object.entries(wireObject(raw, subject))
  if (entries.length === 0) throw new Error(`${subject} must not be empty`)
  const applies = new Map<string, readonly string[]>()
  for (const [comboId, rawValues] of entries) {
    if (comboId === '') throw new Error(`${subject} keys must be non-empty combo ids`)
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      throw new Error(`${subject}['${comboId}'] must cover at least one option`)
    }
    if (rawValues.some((value) => typeof value !== 'string' || value === '')) {
      throw new Error(`${subject}['${comboId}'] options must be non-empty strings`)
    }
    if (new Set(rawValues).size !== rawValues.length) {
      throw new Error(`${subject}['${comboId}'] has duplicate options`)
    }
    applies.set(comboId, rawValues as readonly string[])
  }
  return Object.fromEntries(applies)
}

const OUTPUT_REPRESENTS_FIELDS: ReadonlySet<string> = new Set(['input', 'rendition', 'applies'])

function decodeOutputRepresents(raw: unknown): OutputRepresents | undefined {
  if (raw === undefined) return undefined
  const represents = wireObject(raw, 'output.represents')
  for (const key of Object.keys(represents)) {
    if (!OUTPUT_REPRESENTS_FIELDS.has(key)) throw new Error(`output.represents has unknown field '${key}'`)
  }
  const input = represents['input']
  if (typeof input !== 'string' || input === '') {
    throw new Error('output.represents.input must be a non-empty string')
  }
  const rendition = represents['rendition']
  if (typeof rendition !== 'string' || rendition === '') {
    throw new Error('output.represents.rendition must be a non-empty string')
  }
  const applies = represents['applies'] === undefined ? undefined : decodeApplies(represents['applies'], 'output.represents.applies')
  return { input, rendition, ...(applies === undefined ? {} : { applies }) }
}

function decodeOutputKnownValue(raw: unknown): OutputKnownValue | undefined {
  if (raw === undefined) return undefined
  const knownValue = wireObject(raw, 'output.knownValue')
  for (const key of Object.keys(knownValue)) {
    if (key !== 'input') throw new Error(`output.knownValue has unknown field '${key}'`)
  }
  const input = knownValue['input']
  if (typeof input !== 'string' || input === '') {
    throw new Error('output.knownValue.input must be a non-empty string')
  }
  return { input }
}

function decodeMirror(raw: unknown): MirrorSpec | undefined {
  if (raw === undefined) return undefined
  const mirror = wireObject(raw, 'mirror')
  for (const key of Object.keys(mirror)) {
    if (!MIRROR_FIELDS.has(key)) throw new Error(`mirror has unknown field '${key}'`)
  }
  const kind = mirror['kind']
  if (typeof kind !== 'string' || !MIRROR_KINDS.has(kind)) {
    throw new Error(`mirror.kind must be one of ${[...MIRROR_KINDS].join(', ')}`)
  }
  const precision = mirror['precision']
  if (typeof precision !== 'string' || !MIRROR_PRECISIONS.has(precision)) {
    throw new Error(`mirror.precision must be one of ${[...MIRROR_PRECISIONS].join(', ')}`)
  }
  const tolerance = mirror['tolerance'] !== undefined ? decodeMirrorTolerance(mirror['tolerance']) : undefined
  if (precision === 'bounded' && tolerance === undefined) {
    throw new Error('bounded mirror requires a tolerance')
  }
  if (precision === 'exact' && tolerance !== undefined) {
    throw new Error('exact mirror must not declare a tolerance')
  }
  const grammarVersion = mirror['grammarVersion']
  const source = mirror['source']
  if (kind === 'expression') {
    if (typeof grammarVersion !== 'number' || !Number.isInteger(grammarVersion) || grammarVersion <= 0) {
      throw new Error('expression mirror requires a positive integer grammarVersion')
    }
    if (source !== undefined) throw new Error('expression mirror must not carry source')
  } else {
    if (grammarVersion !== undefined) throw new Error('glsl mirror must not carry grammarVersion')
    if (typeof source !== 'string' || source === '') {
      throw new Error('glsl mirror requires non-empty source')
    }
    if (new TextEncoder().encode(source).length > MAX_MIRROR_SOURCE_BYTES) {
      throw new Error(`glsl mirror source exceeds ${MAX_MIRROR_SOURCE_BYTES} bytes`)
    }
  }
  const applies = mirror['applies'] !== undefined ? decodeApplies(mirror['applies'], 'mirror.applies') : undefined
  return {
    kind: kind as MirrorSpec['kind'],
    precision: precision as MirrorSpec['precision'],
    ...(tolerance !== undefined ? { tolerance } : {}),
    ...(kind === 'expression' ? { grammarVersion: grammarVersion as number } : {}),
    ...(kind === 'glsl' ? { source: source as string } : {}),
    ...(applies !== undefined ? { applies } : {}),
  }
}

function decodeOutputDescriptors(entry: Record<string, unknown>, where: string): OutputDescriptorsSpec {
  const allowed = new Set(['role', 'input', 'choices', 'minEntries', 'maxEntries', 'fixedIds', 'probe'])
  if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error(`${where} has unknown output descriptor fields`)
  const input = wireSegment(entry['input'], `${where}.input`)
  const minEntries = entry['minEntries']
  const maxEntries = entry['maxEntries']
  if (
    typeof minEntries !== 'number' ||
    typeof maxEntries !== 'number' ||
    !Number.isInteger(minEntries) ||
    !Number.isInteger(maxEntries) ||
    minEntries < 0 ||
    maxEntries < minEntries ||
    maxEntries > 512
  ) {
    throw new Error(`${where} requires 0 <= minEntries <= maxEntries <= 512`)
  }
  if (typeof entry['fixedIds'] !== 'boolean') throw new Error(`${where}.fixedIds must be boolean`)
  const rawChoices = entry['choices']
  if (!Array.isArray(rawChoices) || rawChoices.length === 0 || rawChoices.length > 512) throw new Error(`${where}.choices must contain 1..512 concrete choices`)
  const ids = new Set<string>()
  const choices = rawChoices.map((raw, index) => {
    const choice = wireObject(raw, `${where}.choices[${index}]`)
    if (
      Object.keys(choice).some(
        (key) => !['id', 'type', 'displayName', 'optional', 'preview', 'doc', 'alphaPolicy', 'maskPolarity', 'maskSemantic'].includes(key),
      )
    )
      throw new Error(`${where}.choices has unknown fields`)
    const id = wireSegment(choice['id'], `${where}.choices.id`)
    if (ids.has(id)) throw new Error(`${where}.choices IDs must be unique`)
    ids.add(id)
    const type = wireType(choice['type'], `${where}.choices.type`)
    if (type.kind !== 'concrete') throw new Error(`${where}.choices types must be concrete`)
    for (const key of ['displayName', 'doc']) {
      if (choice[key] !== undefined && typeof choice[key] !== 'string') throw new Error(`${where}.choices.${key} must be a string`)
    }
    return {
      id,
      type,
      ...mediaPolicyOf(choice, `${where}.choices[${index}]`),
      ...(choice['displayName'] !== undefined ? { displayName: choice['displayName'] as string } : {}),
      ...(choice['doc'] !== undefined ? { doc: choice['doc'] as string } : {}),
      ...(wireBoolean(choice['optional'], `${where}.choices.optional`, false) ? { optional: true } : {}),
      ...(wireBoolean(choice['preview'], `${where}.choices.preview`, false) ? { preview: true as const } : {}),
    }
  })
  let probe: OutputDescriptorsSpec['probe']
  if (entry['probe'] !== undefined) {
    const raw = wireObject(entry['probe'], `${where}.probe`)
    if (Object.keys(raw).sort().join(',') !== 'input,kind,revision' || raw['kind'] !== 'model' || typeof raw['revision'] !== 'string' || raw['revision'] === '')
      throw new Error(`${where}.probe requires input, model kind, and revision`)
    probe = {
      input: wireSegment(raw['input'], `${where}.probe.input`),
      kind: 'model',
      revision: raw['revision'],
    }
  }
  return {
    input,
    choices,
    minEntries,
    maxEntries,
    fixedIds: entry['fixedIds'],
    ...(probe ? { probe } : {}),
  }
}

function decodeChunkSafe(wire: DinksterWireSchema, inputs: ReadonlyMap<string, InputSpec>, outputs: readonly OutputSpec[]): NodeSchema['chunkSafe'] {
  if (!Object.hasOwn(wire, 'chunkSafe')) return undefined
  const raw = wireObject(wire.chunkSafe, 'chunkSafe')
  if (Object.keys(raw).some((key) => !['inputs', 'outputs', 'applies'].includes(key))) throw new Error('chunkSafe has unknown fields')
  const ids = (field: 'inputs' | 'outputs'): readonly string[] => {
    const value = raw[field]
    if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === 'string' && id !== '') || new Set(value).size !== value.length) {
      throw new Error(`chunkSafe.${field} must contain unique non-empty strings`)
    }
    return value as string[]
  }
  const inputIds = ids('inputs')
  const outputIds = ids('outputs')
  for (const id of inputIds) {
    const input = inputs.get(id)
    if (!input || (input.dynamic !== undefined && input.dynamic.kind !== 'dynamicSlot')) throw new Error(`chunkSafe.inputs names invalid input '${id}'`)
  }
  for (const id of outputIds) {
    if (!outputs.some((output) => output.id === id && !output.dynamic && !output.outputDescriptors))
      throw new Error(`chunkSafe.outputs names invalid output '${id}'`)
  }
  const applies = Object.hasOwn(raw, 'applies') ? decodeApplies(raw['applies'], 'chunkSafe.applies') : undefined
  for (const [id, keys] of Object.entries(applies ?? {})) {
    const input = inputs.get(id)
    const combo = input?.dynamic
    if (input?.optional || combo?.kind !== 'dynamicCombo' || keys.some((key) => !combo.options.some((option) => option.key === key)))
      throw new Error(`chunkSafe.applies names invalid combo or option '${id}'`)
  }
  return {
    inputs: inputIds,
    outputs: outputIds,
    ...(applies !== undefined ? { applies } : {}),
  }
}

// ---------------------------------------------------------------------------
// Deprecation / search visibility
// ---------------------------------------------------------------------------

const SEARCH_VISIBILITIES: ReadonlySet<string> = new Set(['deprecated', 'hidden'])

/**
 * Decode the optional structured deprecation object. The backend rejects an
 * empty message and self-pointers at registration, so a wire carrying either
 * is malformed - warn and drop the field (the node stays usable) rather than
 * fail the node over presentation metadata.
 */
function decodeDeprecation(nodeType: string, wire: unknown, diags: Diagnostic[]): DeprecationInfo | undefined {
  if (wire === undefined) return undefined
  if (typeof wire !== 'object' || wire === null) {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badDeprecation', `${nodeType}: deprecation is not an object; ignoring`))
    return undefined
  }
  const w = wire as {
    message?: unknown
    since?: unknown
    replacement?: unknown
  }
  if (typeof w.message !== 'string' || w.message === '') {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badDeprecation', `${nodeType}: deprecation carries no message; ignoring`))
    return undefined
  }
  let replacement = typeof w.replacement === 'string' && w.replacement !== '' ? w.replacement : undefined
  if (replacement === nodeType) {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badDeprecation', `${nodeType}: deprecation replacement points at itself; dropping the pointer`))
    replacement = undefined
  }
  return {
    message: w.message,
    ...(typeof w.since === 'string' && w.since !== '' ? { since: w.since } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  }
}

/**
 * Decode the optional replacement-rule list. The backend mirrors our
 * ReplacementRule vocabulary field-for-field (commit 9a36a72) and validates
 * at registration, so a malformed entry here is a smuggled wire - warn and
 * skip that RULE (not the node, and not the whole list: migration advice is
 * additive metadata). isReplacementRule is the same validator the registry
 * itself applies, so nothing invalid can reach planning either way.
 */
function decodeReplacements(nodeType: string, wire: unknown, diags: Diagnostic[]): readonly ReplacementRule[] | undefined {
  if (wire === undefined) return undefined
  if (!Array.isArray(wire)) {
    diags.push(diag('warning', 'schema', 'schema.dinkster.badReplacements', `${nodeType}: replacements is not an array; ignoring`))
    return undefined
  }
  const rules: ReplacementRule[] = []
  for (const [i, rule] of wire.entries()) {
    if (isReplacementRule(rule)) rules.push(rule)
    else diags.push(diag('warning', 'schema', 'schema.dinkster.badReplacements', `${nodeType}: replacements[${i}] is malformed; skipping that rule`))
  }
  return rules.length > 0 ? rules : undefined
}

function replacementUsesSlotVariants(wire: unknown): boolean {
  if (!Array.isArray(wire)) return false
  return wire.some((rule) => {
    if (typeof rule !== 'object' || rule === null || !Array.isArray((rule as { cases?: unknown }).cases)) return false
    return (rule as { cases: unknown[] }).cases.some((candidate) => typeof candidate === 'object' && candidate !== null && 'slotVariants' in candidate)
  })
}

function replacementUsesMigration(wire: unknown): boolean {
  if (!Array.isArray(wire)) return false
  return wire.some((rule) => typeof rule === 'object' && rule !== null && 'migration' in rule)
}

/**
 * Decode the optional search-visibility demotion. The backend's vocabulary is
 * closed over normal|deprecated|hidden and it omits 'normal', but accept an
 * explicit 'normal' as omission for robustness. Unknown values warn and fall
 * back to normal - a listing hint must never cost a node.
 */
function decodeSearchVisibility(nodeType: string, wire: unknown, diags: Diagnostic[]): SearchVisibility | undefined {
  if (wire === undefined || wire === 'normal') return undefined
  if (typeof wire === 'string' && SEARCH_VISIBILITIES.has(wire)) return wire as SearchVisibility
  diags.push(diag('warning', 'schema', 'schema.dinkster.badSearchVisibility', `${nodeType}: unknown searchVisibility '${String(wire)}'; treating as normal`))
  return undefined
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface DinksterParseResult {
  readonly schema: NodeSchema | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/** Parse a full GET /api/nodes payload. */
export function parseDinksterNodes(payload: DinksterNodesPayload): {
  schemas: ReadonlyMap<string, NodeSchema>
  diagnostics: readonly Diagnostic[]
} {
  const schemas = new Map<string, NodeSchema>()
  const diagnostics: Diagnostic[] = []
  // Wire-format version: current backends carry it in the dinkster header
  // (schemaWire) and per node entry; TOP-LEVEL schemaVersion there is the
  // API surface version (1, a different axis). Payloads without the header
  // (older shape / fixtures) carried the wire version top-level instead.
  const wireVersion = serverInfoFromDinksterWire(payload)?.schemaWire ?? payload.schemaVersion
  if (wireVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
    diagnostics.push(
      diag(
        'error',
        'schema',
        'schema.dinkster.wireVersion',
        `unsupported Dinkster schema wire version ${String(wireVersion)}; this build speaks ${DINKSTER_SCHEMA_WIRE_VERSION}`,
      ),
    )
    return { schemas, diagnostics }
  }
  const nodes = typeof payload.nodes === 'object' && payload.nodes !== null ? (payload.nodes as Record<string, DinksterWireSchema>) : {}
  for (const [type, wire] of Object.entries(nodes)) {
    try {
      if (wire.schemaVersion !== undefined && wire.schemaVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
        diagnostics.push(
          diag(
            'error',
            'schema',
            'schema.dinkster.wireVersion',
            `${type}: unsupported schema wire version ${String(wire.schemaVersion)}; this build speaks ${DINKSTER_SCHEMA_WIRE_VERSION}`,
          ),
        )
        continue
      }
      if (wire.schemaVersion !== undefined && wire.schemaVersion !== wireVersion) {
        diagnostics.push(
          diag(
            'error',
            'schema',
            'schema.dinkster.wireVersion',
            `${type}: schema wire version ${String(wire.schemaVersion)} does not match payload version ${String(wireVersion)}`,
          ),
        )
        continue
      }
      const { schema, diagnostics: d } = parseDinksterSchema(type, wire)
      diagnostics.push(...d)
      if (schema) schemas.set(type, schema)
    } catch (e) {
      diagnostics.push(diag('error', 'schema', 'schema.parse.threw', `${type}: schema parse threw: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  return { schemas, diagnostics }
}

/**
 * Decode the top-level /api/nodes "packs" presentation table. Tolerant by
 * design: the backend already warn-and-drops malformed author declarations
 * at manifest load, so anything malformed HERE is a smuggled wire - drop
 * the field (or entry), never fail schema fetch over a bad emoji.
 * displayName falls back to the pack id (backend contract sends it always;
 * the fallback keeps the table total for badge/tooltip consumers).
 */
export function packsFromDinksterWire(payload: DinksterNodesPayload): ReadonlyMap<string, PackInfo> {
  const out = new Map<string, PackInfo>()
  const wireVersion = serverInfoFromDinksterWire(payload)?.schemaWire ?? payload.schemaVersion
  const table = typeof payload.packs === 'object' && payload.packs !== null && !Array.isArray(payload.packs) ? (payload.packs as Record<string, unknown>) : {}
  for (const [packId, raw] of Object.entries(table)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const e = raw as {
      displayName?: unknown
      abbr?: unknown
      mark?: unknown
      color?: unknown
      icon?: unknown
      version?: unknown
      artifactDigest?: unknown
      source?: unknown
      publisher?: unknown
      assets?: unknown
      blueprints?: unknown
      locales?: unknown
      settings?: unknown
    }
    const opt = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
    const abbr = opt(e.abbr)
    const mark = opt(e.mark)
    const color = opt(e.color)
    const version = opt(e.version)
    const artifactDigest = opt(e.artifactDigest)
    const source = opt(e.source)
    const publisher = opt(e.publisher)
    let locales: Readonly<Record<string, string>> | undefined
    if (typeof e.locales === 'object' && e.locales !== null && !Array.isArray(e.locales)) {
      const decoded = Object.entries(e.locales).filter(
        (entry): entry is [string, string] =>
          /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(entry[0]) && typeof entry[1] === 'string' && /^sha256:[0-9a-f]{64}$/.test(entry[1]),
      )
      if (decoded.length > 0) locales = Object.fromEntries(decoded)
    }
    const assets: PackAssetDescriptor[] = []
    if (Array.isArray(e.assets)) {
      for (const rawAsset of e.assets) {
        if (typeof rawAsset !== 'object' || rawAsset === null || Array.isArray(rawAsset)) continue
        const a = rawAsset as Record<string, unknown>
        const id = opt(a['id'])
        const name = opt(a['name'])
        const digest = opt(a['digest'])
        if (id === undefined || name === undefined || digest === undefined) continue
        const strings = (v: unknown): readonly string[] | undefined => {
          if (!Array.isArray(v)) return undefined
          const kept = v.filter((s): s is string => typeof s === 'string' && s !== '')
          return kept.length > 0 ? kept : undefined
        }
        const sources: PackAssetSource[] = []
        if (Array.isArray(a['sources'])) {
          for (const rawSource of a['sources']) {
            if (typeof rawSource !== 'object' || rawSource === null || Array.isArray(rawSource)) continue
            const source = rawSource as Record<string, unknown>
            if (source['type'] === 'packaged') {
              const pack = opt(source['pack'])
              const path = opt(source['path'])
              if (pack !== undefined && path !== undefined) sources.push({ type: 'packaged', pack, path })
            } else if (source['type'] === 'remote') {
              const url = opt(source['url'])
              if (url !== undefined) sources.push({ type: 'remote', url })
            }
          }
        }
        const kind = opt(a['kind'])
        const mediaType = opt(a['mediaType'])
        const size = typeof a['size'] === 'number' && Number.isInteger(a['size']) && a['size'] >= 0 ? a['size'] : undefined
        const metadata =
          typeof a['metadata'] === 'object' && a['metadata'] !== null && !Array.isArray(a['metadata']) ? (a['metadata'] as Record<string, unknown>) : undefined
        const nodes = strings(a['nodes'])
        assets.push({
          id,
          name,
          digest,
          ...(kind !== undefined ? { kind } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(sources.length > 0 ? { sources } : {}),
          ...(nodes !== undefined ? { nodes } : {}),
        })
      }
    }
    // Icon descriptor: digest + mediaType, both nonempty strings, or the
    // field drops whole - a half-formed descriptor must never trigger a
    // fetch keyed by a bogus digest.
    let icon: PackIcon | undefined
    if (typeof e.icon === 'object' && e.icon !== null && !Array.isArray(e.icon)) {
      const i = e.icon as { digest?: unknown; mediaType?: unknown }
      const digest = opt(i.digest)
      const mediaType = opt(i.mediaType)
      if (digest !== undefined && mediaType !== undefined) icon = { digest, mediaType }
    }
    // Blueprint descriptors: id + name + digest required, or the entry
    // drops alone (a descriptor without a digest can never key a body
    // fetch or a cache). Optional fields stay omitted, never synthesized;
    // boundary hints keep only well-formed string members - they are
    // author declarations the backend passes through verbatim.
    const blueprints: PackBlueprintDescriptor[] = []
    if (Array.isArray(e.blueprints)) {
      for (const rawBp of e.blueprints) {
        if (typeof rawBp !== 'object' || rawBp === null || Array.isArray(rawBp)) continue
        const b = rawBp as {
          id?: unknown
          name?: unknown
          description?: unknown
          tags?: unknown
          digest?: unknown
          boundaryInputs?: unknown
          boundaryOutputs?: unknown
        }
        const id = opt(b.id)
        const name = opt(b.name)
        const digest = opt(b.digest)
        if (id === undefined || name === undefined || digest === undefined) continue
        const strings = (v: unknown): readonly string[] | undefined => {
          if (!Array.isArray(v)) return undefined
          const kept = v.filter((s): s is string => typeof s === 'string' && s !== '')
          return kept.length > 0 ? kept : undefined
        }
        const description = opt(b.description)
        const tags = strings(b.tags)
        const boundaryInputs = strings(b.boundaryInputs)
        const boundaryOutputs = strings(b.boundaryOutputs)
        blueprints.push({
          id,
          name,
          digest,
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(boundaryInputs !== undefined ? { boundaryInputs } : {}),
          ...(boundaryOutputs !== undefined ? { boundaryOutputs } : {}),
        })
      }
    }
    out.set(packId, {
      displayName: opt(e.displayName) ?? packId,
      ...(abbr !== undefined ? { abbr } : {}),
      ...(mark !== undefined ? { mark } : {}),
      ...(color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color) ? { color } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(artifactDigest !== undefined ? { artifactDigest } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(publisher !== undefined ? { publisher } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      ...(blueprints.length > 0 ? { blueprints } : {}),
      ...(locales !== undefined ? { locales } : {}),
      ...(e.settings === true ? { settings: true as const } : {}),
    })
  }
  return out
}

/**
 * Decode the /api/nodes "dinkster" server-identity header. Absent or
 * malformed -> undefined (older backend); never a diagnostic - the header
 * only feeds advisory environment stamps.
 */
export function serverInfoFromDinksterWire(payload: DinksterNodesPayload): { readonly version: string; readonly schemaWire: number } | undefined {
  const d = payload.dinkster
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const h = d as { version?: unknown; schemaWire?: unknown }
  if (typeof h.version !== 'string' || h.version === '' || typeof h.schemaWire !== 'number') return undefined
  return { version: h.version, schemaWire: h.schemaWire }
}

/**
 * Decode the /api/nodes "dinkster" header's graphFeatures flags (additive
 * capability negotiation for the GRAPH document wire, decoupled from
 * schemaWire; Dinkster ea6eca7). Unlike the identity header this IS
 * load-bearing: it gates lowering forms the target server may not decode
 * (e.g. 'typedLiteral' - see DINKSTER_GRAPH_FEATURE_TYPED_LITERAL). Absent or
 * malformed -> undefined (older backend, emit none); non-string entries are
 * dropped, never a diagnostic - unknown future flags pass through unread.
 */
export function graphFeaturesFromDinksterWire(payload: DinksterNodesPayload): readonly string[] | undefined {
  const d = payload.dinkster
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const raw = (d as { graphFeatures?: unknown }).graphFeatures
  if (!Array.isArray(raw)) return undefined
  return raw.filter((f): f is string => typeof f === 'string')
}

/**
 * Decode the /api/nodes "dinkster" header's mergeableTypes list (additive,
 * joint contract 2026-07-26, Dinkster 6dbbddd): the sorted ATOM type ids with a
 * registered batch-merge provider (list<T> -> one batched T), derived from
 * the composed registry at envelope build time. PRESENTATION gating only -
 * the widget layer offers the multi-select merge arm on membership; the
 * backend coercion planner stays the enforcement point, so a stale list can
 * only under/over-OFFER multi-select until refetch, never execute anything
 * invalid. Absent or malformed -> undefined (older backend, merge arm off);
 * non-string entries are dropped silently, mirroring graphFeatures.
 */
export function mergeableTypesFromDinksterWire(payload: DinksterNodesPayload): readonly string[] | undefined {
  const d = payload.dinkster
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined
  const raw = (d as { mergeableTypes?: unknown }).mergeableTypes
  if (!Array.isArray(raw)) return undefined
  return raw.filter((f): f is string => typeof f === 'string')
}
