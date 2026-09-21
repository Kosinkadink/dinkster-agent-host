import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json } from '../format/document.js'

export const HOST_UI_MAX_DEPTH = 8
export const HOST_UI_MAX_NODES = 128
export const HOST_UI_MAX_CHILDREN = 32
export const HOST_UI_MAX_VISIBLE_STRING_LENGTH = 2048
export const HOST_UI_MAX_ID_LENGTH = 128
export const HOST_UI_MAX_PAYLOAD_JSON_BYTES = 16 * 1024

export const HOST_UI_TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'] as const
export type HostUiToneV1 = (typeof HOST_UI_TONES)[number]

export interface HostUiGroupV1 {
  readonly kind: 'group'
  readonly key: string
  readonly direction: 'row' | 'column'
  readonly children: readonly HostUiNodeV1[]
}

export interface HostUiTextV1 {
  readonly kind: 'text'
  readonly key: string
  readonly text: string
  readonly tone?: HostUiToneV1
}

export interface HostUiStatusV1 {
  readonly kind: 'status'
  readonly key: string
  readonly text: string
  readonly tone: HostUiToneV1
  readonly live?: 'polite' | 'assertive'
}

export interface HostUiActionV1 {
  readonly kind: 'action'
  readonly key: string
  readonly label: string
  readonly command: string
  readonly payload?: Json
  readonly tone?: HostUiToneV1
  readonly disabled?: boolean
  readonly disabledReason?: string
}

export const ASSET_EDITOR_FIELD_KINDS = ['display'] as const
export type AssetEditorFieldKindV1 = (typeof ASSET_EDITOR_FIELD_KINDS)[number] | (string & {})
export const ASSET_EDITOR_CAPABILITY_KINDS = ['editable', 'read-only'] as const
export type AssetEditorCapabilityKindV1 = (typeof ASSET_EDITOR_CAPABILITY_KINDS)[number] | (string & {})
export const ASSET_EDITOR_VIEWPORT_STATES = ['absent', 'loading', 'ready', 'error'] as const
export type AssetEditorViewportStateV1 = (typeof ASSET_EDITOR_VIEWPORT_STATES)[number]
export const ASSET_EDITOR_FACT_STATES = ['absent', 'pending', 'ready', 'error'] as const
export type AssetEditorFactStateV1 = (typeof ASSET_EDITOR_FACT_STATES)[number]
export const ASSET_EDITOR_TOOL_STATES = ['absent', 'loading', 'ready', 'disabled', 'error'] as const
export type AssetEditorToolStateV1 = (typeof ASSET_EDITOR_TOOL_STATES)[number]
export const ASSET_EDITOR_ACTION_STATES = ['enabled', 'disabled', 'pending', 'failed'] as const
export type AssetEditorActionStateV1 = (typeof ASSET_EDITOR_ACTION_STATES)[number]
export const ASSET_EDITOR_MESSAGE_TONES = ['info', 'warning', 'error', 'status'] as const
export type AssetEditorMessageToneV1 = (typeof ASSET_EDITOR_MESSAGE_TONES)[number]

export interface AssetEditorMessageV1 {
  readonly key: string
  readonly tone: AssetEditorMessageToneV1
  readonly text: string
}

/** Display vocabulary authored upstream; it does not assign semantic origin identity. */
export interface AssetEditorOriginPresentationV1 {
  readonly label: string
  readonly detail?: string
  readonly tone?: HostUiToneV1
}

export interface AssetEditorActionV1 {
  readonly key: string
  readonly label: string
  readonly command: string
  readonly state: AssetEditorActionStateV1
  readonly detail?: string
  readonly disabledReason?: string
}

export interface AssetEditorFieldV1 {
  readonly key: string
  readonly kind: AssetEditorFieldKindV1
  readonly label: string
  readonly value: string
  readonly description?: string
  readonly origin?: AssetEditorOriginPresentationV1
  readonly capability: {
    readonly kind: AssetEditorCapabilityKindV1
    readonly label?: string
    readonly reason?: string
  }
  readonly validation?: AssetEditorMessageV1
  readonly action?: AssetEditorActionV1
}

export interface AssetEditorFactV1 {
  readonly key: string
  readonly label: string
  readonly state: AssetEditorFactStateV1
  readonly value?: string
  readonly detail?: string
}

export interface AssetEditorFactGroupV1 {
  readonly key: string
  readonly label: string
  readonly facts: readonly AssetEditorFactV1[]
}

export interface AssetEditorToolV1 {
  readonly key: string
  readonly label: string
  readonly state: AssetEditorToolStateV1
  readonly detail?: string
  readonly actions?: readonly AssetEditorActionV1[]
}

export interface AssetEditorPresentationV1 {
  readonly heading: string
  readonly description?: string
  readonly viewport: {
    readonly label: string
    readonly state: AssetEditorViewportStateV1
    readonly detail?: string
  }
  readonly fields: readonly AssetEditorFieldV1[]
  readonly messages?: readonly AssetEditorMessageV1[]
  readonly factGroups?: readonly AssetEditorFactGroupV1[]
  readonly tools?: readonly AssetEditorToolV1[]
  readonly actions?: readonly AssetEditorActionV1[]
}

export interface HostUiAssetEditorV1 {
  readonly kind: 'asset-editor'
  readonly key: string
  readonly presentation: AssetEditorPresentationV1
}

export type HostUiNodeV1 = HostUiGroupV1 | HostUiTextV1 | HostUiStatusV1 | HostUiActionV1 | HostUiAssetEditorV1

export interface HostUiContributionV1 {
  readonly version: 1
  readonly root: HostUiNodeV1
}

export type HostUiSurfaceV1 = 'status' | 'widget-editor' | 'preview-viewer' | 'editor' | 'panel' | 'toolbar'

export interface HostUiProviderContextV1 {
  readonly version: 1
  readonly surface: HostUiSurfaceV1
  readonly data: Json
}

export type HostUiProviderV1 = (context: HostUiProviderContextV1) => unknown

export interface HostUiDecodeResultV1 {
  readonly contribution?: HostUiContributionV1
  readonly diagnostics: readonly Diagnostic[]
}

const KEY = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const COMMAND = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const encoder = new TextEncoder()
const MAX_DIAGNOSTICS = 32

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable
  })
}

const isPlainArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  return keys.every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) return false
    if (key === 'length') return !descriptor.enumerable
    const index = Number(key)
    return Number.isSafeInteger(index) && index >= 0 && index < value.length && String(index) === key && descriptor.enumerable
  })
}

const freeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const problem = (path: string, detail: string): Diagnostic =>
  diag('error', 'extension', 'host-ui.invalid', `${path}: ${detail}`)

interface DecodeState {
  readonly seen: WeakSet<object>
  readonly keys: Set<string>
  readonly diagnostics: Diagnostic[]
  count: number
  limitExceeded: boolean
}

function issue(state: DecodeState, path: string, detail: string): void {
  if (state.diagnostics.length < MAX_DIAGNOSTICS) state.diagnostics.push(problem(path, detail))
}

function childPath(path: string, key: string): string {
  const bounded = key.slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, '?')
  return `${path}[${JSON.stringify(bounded)}${key.length > bounded.length ? '...' : ''}]`
}

function own(state: DecodeState, value: object, path: string): boolean {
  if (state.seen.has(value)) {
    issue(state, path, 'contains a cycle or shared object reference')
    return false
  }
  state.seen.add(value)
  return true
}

function exactKeys(state: DecodeState, value: Record<string, unknown>, allowed: readonly string[], path: string): boolean {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key)).sort()
  for (const key of extras) issue(state, childPath(path, key), 'is not an allowed property')
  for (const key of Object.keys(value).filter((key) => allowed.includes(key) && value[key] === undefined).sort()) {
    issue(state, childPath(path, key), 'must not be undefined')
  }
  return extras.length === 0
}

function requiredString(state: DecodeState, value: unknown, path: string, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    issue(state, path, 'must be a non-empty string')
    return undefined
  }
  if (value.length > limit) {
    issue(state, path, `exceeds the ${limit} character limit`)
    return undefined
  }
  return value
}

function displayString(state: DecodeState, value: unknown, path: string): string | undefined {
  if (typeof value !== 'string') {
    issue(state, path, 'must be a string')
    return undefined
  }
  if (value.length > HOST_UI_MAX_VISIBLE_STRING_LENGTH) {
    issue(state, path, `exceeds the ${HOST_UI_MAX_VISIBLE_STRING_LENGTH} character limit`)
    return undefined
  }
  return value
}

function stableKey(state: DecodeState, value: unknown, path: string): string | undefined {
  const key = requiredString(state, value, path, HOST_UI_MAX_ID_LENGTH)
  if (key === undefined) return undefined
  if (!KEY.test(key)) {
    issue(state, path, 'must be a stable identifier')
    return undefined
  }
  if (state.keys.has(key)) {
    issue(state, path, 'duplicates another node or presentation key')
    return undefined
  }
  state.keys.add(key)
  return key
}

function decodeRecord(
  state: DecodeState,
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  state.count += 1
  if (state.count > HOST_UI_MAX_NODES) {
    if (!state.limitExceeded) issue(state, path, `exceeds the ${HOST_UI_MAX_NODES} node and presentation value limit`)
    state.limitExceeded = true
    return undefined
  }
  if (!isPlainObject(value)) {
    issue(state, path, 'must be a plain object')
    return undefined
  }
  if (!own(state, value, path)) return undefined
  exactKeys(state, value, allowed, path)
  return value
}

function decodeArray<T>(
  state: DecodeState,
  value: unknown,
  path: string,
  decode: (item: unknown, itemPath: string) => T | undefined,
): readonly T[] | undefined {
  if (!Array.isArray(value)) {
    issue(state, path, 'must be an array')
    return undefined
  }
  if (!isPlainArray(value)) {
    issue(state, path, 'must be a dense array without accessors or extra properties')
    return undefined
  }
  if (!own(state, value, path)) return undefined
  if (value.length > HOST_UI_MAX_CHILDREN) issue(state, path, `exceeds the ${HOST_UI_MAX_CHILDREN} item limit`)
  return value
    .slice(0, HOST_UI_MAX_CHILDREN)
    .map((item, index) => decode(item, `${path}[${index}]`))
    .filter((item): item is T => item !== undefined)
}

function decodeAssetEditorMessage(state: DecodeState, value: unknown, path: string): AssetEditorMessageV1 | undefined {
  const record = decodeRecord(state, value, path, ['key', 'tone', 'text'])
  if (record === undefined) return undefined
  const key = stableKey(state, record['key'], `${path}.key`)
  const tone = record['tone']
  const text = requiredString(state, record['text'], `${path}.text`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  if (!(ASSET_EDITOR_MESSAGE_TONES as readonly unknown[]).includes(tone)) issue(state, `${path}.tone`, 'is not an allowed message tone')
  return key !== undefined && text !== undefined && (ASSET_EDITOR_MESSAGE_TONES as readonly unknown[]).includes(tone)
    ? { key, tone: tone as AssetEditorMessageToneV1, text }
    : undefined
}

function decodeAssetEditorOrigin(state: DecodeState, value: unknown, path: string): AssetEditorOriginPresentationV1 | undefined {
  const record = decodeRecord(state, value, path, ['label', 'detail', 'tone'])
  if (record === undefined) return undefined
  const label = requiredString(state, record['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const detail = record['detail'] === undefined
    ? undefined
    : requiredString(state, record['detail'], `${path}.detail`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const tone = record['tone']
  if (tone !== undefined && !(HOST_UI_TONES as readonly unknown[]).includes(tone)) issue(state, `${path}.tone`, 'is not an allowed semantic tone')
  return label !== undefined && (record['detail'] === undefined || detail !== undefined) &&
    (tone === undefined || (HOST_UI_TONES as readonly unknown[]).includes(tone))
    ? { label, ...(detail === undefined ? {} : { detail }), ...(tone === undefined ? {} : { tone: tone as HostUiToneV1 }) }
    : undefined
}

function decodeAssetEditorAction(state: DecodeState, value: unknown, path: string): AssetEditorActionV1 | undefined {
  const record = decodeRecord(state, value, path, ['key', 'label', 'command', 'state', 'detail', 'disabledReason'])
  if (record === undefined) return undefined
  const key = stableKey(state, record['key'], `${path}.key`)
  const label = requiredString(state, record['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const command = requiredString(state, record['command'], `${path}.command`, HOST_UI_MAX_ID_LENGTH)
  if (command !== undefined && !COMMAND.test(command)) issue(state, `${path}.command`, 'must be a dotted command identifier')
  const actionState = record['state']
  if (!(ASSET_EDITOR_ACTION_STATES as readonly unknown[]).includes(actionState)) issue(state, `${path}.state`, 'is not an allowed action state')
  const detail = record['detail'] === undefined
    ? undefined
    : requiredString(state, record['detail'], `${path}.detail`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const disabledReason = record['disabledReason'] === undefined
    ? undefined
    : requiredString(state, record['disabledReason'], `${path}.disabledReason`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const valid = key !== undefined && label !== undefined && command !== undefined && COMMAND.test(command) &&
    (ASSET_EDITOR_ACTION_STATES as readonly unknown[]).includes(actionState) &&
    (record['detail'] === undefined || detail !== undefined) &&
    (record['disabledReason'] === undefined || disabledReason !== undefined)
  return valid ? {
    key,
    label,
    command,
    state: actionState as AssetEditorActionStateV1,
    ...(detail === undefined ? {} : { detail }),
    ...(disabledReason === undefined ? {} : { disabledReason }),
  } : undefined
}

function decodeAssetEditorField(state: DecodeState, value: unknown, path: string): AssetEditorFieldV1 | undefined {
  const record = decodeRecord(state, value, path, ['key', 'kind', 'label', 'value', 'description', 'origin', 'capability', 'validation', 'action'])
  if (record === undefined) return undefined
  const key = stableKey(state, record['key'], `${path}.key`)
  const kind = requiredString(state, record['kind'], `${path}.kind`, HOST_UI_MAX_ID_LENGTH)
  const label = requiredString(state, record['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const fieldValue = displayString(state, record['value'], `${path}.value`)
  const description = record['description'] === undefined
    ? undefined
    : requiredString(state, record['description'], `${path}.description`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const origin = record['origin'] === undefined ? undefined : decodeAssetEditorOrigin(state, record['origin'], `${path}.origin`)
  const capabilityRecord = decodeRecord(state, record['capability'], `${path}.capability`, ['kind', 'label', 'reason'])
  const capabilityKind = capabilityRecord === undefined
    ? undefined
    : requiredString(state, capabilityRecord['kind'], `${path}.capability.kind`, HOST_UI_MAX_ID_LENGTH)
  const capabilityLabel = capabilityRecord?.['label'] === undefined
    ? undefined
    : requiredString(state, capabilityRecord['label'], `${path}.capability.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const capabilityReason = capabilityRecord?.['reason'] === undefined
    ? undefined
    : requiredString(state, capabilityRecord['reason'], `${path}.capability.reason`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const validation = record['validation'] === undefined
    ? undefined
    : decodeAssetEditorMessage(state, record['validation'], `${path}.validation`)
  const action = record['action'] === undefined
    ? undefined
    : decodeAssetEditorAction(state, record['action'], `${path}.action`)
  const valid = key !== undefined && kind !== undefined && label !== undefined && fieldValue !== undefined &&
    (record['description'] === undefined || description !== undefined) &&
    (record['origin'] === undefined || origin !== undefined) && capabilityRecord !== undefined && capabilityKind !== undefined &&
    (capabilityRecord['label'] === undefined || capabilityLabel !== undefined) &&
    (capabilityRecord['reason'] === undefined || capabilityReason !== undefined) &&
    (record['validation'] === undefined || validation !== undefined) &&
    (record['action'] === undefined || action !== undefined)
  return valid ? {
    key,
    kind,
    label,
    value: fieldValue,
    ...(description === undefined ? {} : { description }),
    ...(origin === undefined ? {} : { origin }),
    capability: {
      kind: capabilityKind,
      ...(capabilityLabel === undefined ? {} : { label: capabilityLabel }),
      ...(capabilityReason === undefined ? {} : { reason: capabilityReason }),
    },
    ...(validation === undefined ? {} : { validation }),
    ...(action === undefined ? {} : { action }),
  } : undefined
}

function decodeAssetEditorFact(state: DecodeState, value: unknown, path: string): AssetEditorFactV1 | undefined {
  const record = decodeRecord(state, value, path, ['key', 'label', 'state', 'value', 'detail'])
  if (record === undefined) return undefined
  const key = stableKey(state, record['key'], `${path}.key`)
  const label = requiredString(state, record['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const factState = record['state']
  if (!(ASSET_EDITOR_FACT_STATES as readonly unknown[]).includes(factState)) issue(state, `${path}.state`, 'is not an allowed fact state')
  const factValue = record['value'] === undefined
    ? undefined
    : displayString(state, record['value'], `${path}.value`)
  const detail = record['detail'] === undefined
    ? undefined
    : requiredString(state, record['detail'], `${path}.detail`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const valid = key !== undefined && label !== undefined && (ASSET_EDITOR_FACT_STATES as readonly unknown[]).includes(factState) &&
    (record['value'] === undefined || factValue !== undefined) && (record['detail'] === undefined || detail !== undefined)
  return valid ? {
    key,
    label,
    state: factState as AssetEditorFactStateV1,
    ...(factValue === undefined ? {} : { value: factValue }),
    ...(detail === undefined ? {} : { detail }),
  } : undefined
}

function decodeAssetEditorFactGroup(state: DecodeState, value: unknown, path: string): AssetEditorFactGroupV1 | undefined {
  const record = decodeRecord(state, value, path, ['key', 'label', 'facts'])
  if (record === undefined) return undefined
  const key = stableKey(state, record['key'], `${path}.key`)
  const label = requiredString(state, record['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const facts = decodeArray(state, record['facts'], `${path}.facts`, (item, itemPath) => decodeAssetEditorFact(state, item, itemPath))
  return key !== undefined && label !== undefined && facts !== undefined ? { key, label, facts } : undefined
}

function decodeAssetEditorTool(state: DecodeState, value: unknown, path: string): AssetEditorToolV1 | undefined {
  const record = decodeRecord(state, value, path, ['key', 'label', 'state', 'detail', 'actions'])
  if (record === undefined) return undefined
  const key = stableKey(state, record['key'], `${path}.key`)
  const label = requiredString(state, record['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const toolState = record['state']
  if (!(ASSET_EDITOR_TOOL_STATES as readonly unknown[]).includes(toolState)) issue(state, `${path}.state`, 'is not an allowed tool state')
  const detail = record['detail'] === undefined
    ? undefined
    : requiredString(state, record['detail'], `${path}.detail`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const actions = record['actions'] === undefined
    ? undefined
    : decodeArray(state, record['actions'], `${path}.actions`, (item, itemPath) => decodeAssetEditorAction(state, item, itemPath))
  const valid = key !== undefined && label !== undefined && (ASSET_EDITOR_TOOL_STATES as readonly unknown[]).includes(toolState) &&
    (record['detail'] === undefined || detail !== undefined) && (record['actions'] === undefined || actions !== undefined)
  return valid ? {
    key,
    label,
    state: toolState as AssetEditorToolStateV1,
    ...(detail === undefined ? {} : { detail }),
    ...(actions === undefined ? {} : { actions }),
  } : undefined
}

function decodeAssetEditorPresentation(state: DecodeState, value: unknown, path: string): AssetEditorPresentationV1 | undefined {
  const record = decodeRecord(state, value, path, ['heading', 'description', 'viewport', 'fields', 'messages', 'factGroups', 'tools', 'actions'])
  if (record === undefined) return undefined
  const heading = requiredString(state, record['heading'], `${path}.heading`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const description = record['description'] === undefined
    ? undefined
    : requiredString(state, record['description'], `${path}.description`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const viewportRecord = decodeRecord(state, record['viewport'], `${path}.viewport`, ['label', 'state', 'detail'])
  const viewportLabel = viewportRecord === undefined
    ? undefined
    : requiredString(state, viewportRecord['label'], `${path}.viewport.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const viewportState = viewportRecord?.['state']
  if (viewportRecord !== undefined && !(ASSET_EDITOR_VIEWPORT_STATES as readonly unknown[]).includes(viewportState)) issue(state, `${path}.viewport.state`, 'is not an allowed viewport state')
  const viewportDetail = viewportRecord?.['detail'] === undefined
    ? undefined
    : requiredString(state, viewportRecord['detail'], `${path}.viewport.detail`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
  const fields = decodeArray(state, record['fields'], `${path}.fields`, (item, itemPath) => decodeAssetEditorField(state, item, itemPath))
  const messages = record['messages'] === undefined
    ? undefined
    : decodeArray(state, record['messages'], `${path}.messages`, (item, itemPath) => decodeAssetEditorMessage(state, item, itemPath))
  const factGroups = record['factGroups'] === undefined
    ? undefined
    : decodeArray(state, record['factGroups'], `${path}.factGroups`, (item, itemPath) => decodeAssetEditorFactGroup(state, item, itemPath))
  const tools = record['tools'] === undefined
    ? undefined
    : decodeArray(state, record['tools'], `${path}.tools`, (item, itemPath) => decodeAssetEditorTool(state, item, itemPath))
  const actions = record['actions'] === undefined
    ? undefined
    : decodeArray(state, record['actions'], `${path}.actions`, (item, itemPath) => decodeAssetEditorAction(state, item, itemPath))
  const valid = heading !== undefined && (record['description'] === undefined || description !== undefined) &&
    viewportRecord !== undefined && viewportLabel !== undefined && (ASSET_EDITOR_VIEWPORT_STATES as readonly unknown[]).includes(viewportState) &&
    (viewportRecord['detail'] === undefined || viewportDetail !== undefined) && fields !== undefined &&
    (record['messages'] === undefined || messages !== undefined) &&
    (record['factGroups'] === undefined || factGroups !== undefined) &&
    (record['tools'] === undefined || tools !== undefined) &&
    (record['actions'] === undefined || actions !== undefined)
  return valid ? {
    heading,
    ...(description === undefined ? {} : { description }),
    viewport: {
      label: viewportLabel,
      state: viewportState as AssetEditorViewportStateV1,
      ...(viewportDetail === undefined ? {} : { detail: viewportDetail }),
    },
    fields,
    ...(messages === undefined ? {} : { messages }),
    ...(factGroups === undefined ? {} : { factGroups }),
    ...(tools === undefined ? {} : { tools }),
    ...(actions === undefined ? {} : { actions }),
  } : undefined
}

function decodeJson(state: DecodeState, value: unknown, path: string, depth: number): Json | undefined {
  state.count += 1
  if (state.count > HOST_UI_MAX_NODES) {
    if (!state.limitExceeded) issue(state, path, `exceeds the ${HOST_UI_MAX_NODES} value limit`)
    state.limitExceeded = true
    return undefined
  }
  if (depth > HOST_UI_MAX_DEPTH) {
    issue(state, path, `exceeds the ${HOST_UI_MAX_DEPTH} level depth limit`)
    return undefined
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > HOST_UI_MAX_PAYLOAD_JSON_BYTES) {
      issue(state, path, `exceeds the ${HOST_UI_MAX_PAYLOAD_JSON_BYTES} character JSON preflight limit`)
      return undefined
    }
    return value
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    issue(state, path, 'must be a finite number')
    return undefined
  }
  if (Array.isArray(value)) {
    if (!isPlainArray(value)) {
      issue(state, path, 'must be a dense JSON array without accessors or extra properties')
      return undefined
    }
    if (!own(state, value, path)) return undefined
    const result: Json[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (state.limitExceeded) break
      const child = decodeJson(state, value[index], `${path}[${index}]`, depth + 1)
      if (child !== undefined) result.push(child)
    }
    return result
  }
  if (!isPlainObject(value)) {
    issue(state, path, 'must contain only JSON plain objects, arrays, and values')
    return undefined
  }
  if (!own(state, value, path)) return undefined
  const result: Record<string, Json> = Object.create(null) as Record<string, Json>
  for (const key of Object.keys(value).sort()) {
    if (state.limitExceeded) break
    if (key.length > HOST_UI_MAX_PAYLOAD_JSON_BYTES) {
      issue(state, childPath(path, key), `exceeds the ${HOST_UI_MAX_PAYLOAD_JSON_BYTES} character JSON key preflight limit`)
      continue
    }
    const child = decodeJson(state, value[key], childPath(path, key), depth + 1)
    if (child !== undefined) result[key] = child
  }
  return result
}

function decodeNode(state: DecodeState, value: unknown, path: string, depth: number): HostUiNodeV1 | undefined {
  state.count += 1
  if (state.count > HOST_UI_MAX_NODES) {
    if (!state.limitExceeded) issue(state, path, `exceeds the ${HOST_UI_MAX_NODES} node and value limit`)
    state.limitExceeded = true
    return undefined
  }
  if (depth > HOST_UI_MAX_DEPTH) {
    issue(state, path, `exceeds the ${HOST_UI_MAX_DEPTH} level depth limit`)
    return undefined
  }
  if (!isPlainObject(value)) {
    issue(state, path, 'must be a plain object')
    return undefined
  }
  if (!own(state, value, path)) return undefined
  const kind = value['kind']
  const key = stableKey(state, value['key'], `${path}.key`)

  if (kind === 'group') {
    exactKeys(state, value, ['kind', 'key', 'direction', 'children'], path)
    const direction = value['direction']
    if (direction !== 'row' && direction !== 'column') issue(state, `${path}.direction`, "must be 'row' or 'column'")
    const children = value['children']
    if (!Array.isArray(children)) {
      issue(state, `${path}.children`, 'must be an array')
      return undefined
    }
    if (!isPlainArray(children)) {
      issue(state, `${path}.children`, 'must be a dense JSON array without accessors or extra properties')
      return undefined
    }
    if (!own(state, children, `${path}.children`)) return undefined
    if (children.length > HOST_UI_MAX_CHILDREN) issue(state, `${path}.children`, `exceeds the ${HOST_UI_MAX_CHILDREN} child limit`)
    const decoded = children.slice(0, HOST_UI_MAX_CHILDREN).map((child, index) => decodeNode(state, child, `${path}.children[${index}]`, depth + 1)).filter((child): child is HostUiNodeV1 => child !== undefined)
    return key !== undefined && (direction === 'row' || direction === 'column') ? { kind, key, direction, children: decoded } : undefined
  }

  if (kind === 'text') {
    exactKeys(state, value, ['kind', 'key', 'text', 'tone'], path)
    const text = requiredString(state, value['text'], `${path}.text`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
    const tone = value['tone']
    if (tone !== undefined && !(HOST_UI_TONES as readonly unknown[]).includes(tone)) issue(state, `${path}.tone`, 'is not an allowed semantic tone')
    return key !== undefined && text !== undefined && (tone === undefined || (HOST_UI_TONES as readonly unknown[]).includes(tone)) ? { kind, key, text, ...(tone === undefined ? {} : { tone: tone as HostUiToneV1 }) } : undefined
  }

  if (kind === 'status') {
    exactKeys(state, value, ['kind', 'key', 'text', 'tone', 'live'], path)
    const text = requiredString(state, value['text'], `${path}.text`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
    const tone = value['tone']
    const live = value['live']
    if (!(HOST_UI_TONES as readonly unknown[]).includes(tone)) issue(state, `${path}.tone`, 'is not an allowed semantic tone')
    if (live !== undefined && live !== 'polite' && live !== 'assertive') issue(state, `${path}.live`, "must be 'polite' or 'assertive'")
    return key !== undefined && text !== undefined && (HOST_UI_TONES as readonly unknown[]).includes(tone) && (live === undefined || live === 'polite' || live === 'assertive') ? { kind, key, text, tone: tone as HostUiToneV1, ...(live === undefined ? {} : { live }) } : undefined
  }

  if (kind === 'action') {
    exactKeys(state, value, ['kind', 'key', 'label', 'command', 'payload', 'tone', 'disabled', 'disabledReason'], path)
    const label = requiredString(state, value['label'], `${path}.label`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
    const command = requiredString(state, value['command'], `${path}.command`, HOST_UI_MAX_ID_LENGTH)
    if (command !== undefined && !COMMAND.test(command)) issue(state, `${path}.command`, 'must be a dotted command identifier')
    const tone = value['tone']
    if (tone !== undefined && !(HOST_UI_TONES as readonly unknown[]).includes(tone)) issue(state, `${path}.tone`, 'is not an allowed semantic tone')
    if (value['disabled'] !== undefined && typeof value['disabled'] !== 'boolean') issue(state, `${path}.disabled`, 'must be a boolean')
    let disabledReason: string | undefined
    if (value['disabledReason'] !== undefined) disabledReason = requiredString(state, value['disabledReason'], `${path}.disabledReason`, HOST_UI_MAX_VISIBLE_STRING_LENGTH)
    const beforePayloadProblems = state.diagnostics.length
    const payload = value['payload'] === undefined ? undefined : decodeJson(state, value['payload'], `${path}.payload`, depth + 1)
    if (payload !== undefined && encoder.encode(JSON.stringify(payload)).byteLength > HOST_UI_MAX_PAYLOAD_JSON_BYTES) issue(state, `${path}.payload`, `exceeds the ${HOST_UI_MAX_PAYLOAD_JSON_BYTES} byte JSON limit`)
    const valid = key !== undefined && label !== undefined && command !== undefined && COMMAND.test(command) && (tone === undefined || (HOST_UI_TONES as readonly unknown[]).includes(tone)) && (value['disabled'] === undefined || typeof value['disabled'] === 'boolean') && (value['disabledReason'] === undefined || disabledReason !== undefined) && (value['payload'] === undefined || (payload !== undefined && state.diagnostics.length === beforePayloadProblems))
    return valid ? { kind, key, label, command, ...(payload === undefined ? {} : { payload }), ...(tone === undefined ? {} : { tone: tone as HostUiToneV1 }), ...(value['disabled'] === undefined ? {} : { disabled: value['disabled'] as boolean }), ...(disabledReason === undefined ? {} : { disabledReason }) } : undefined
  }

  if (kind === 'asset-editor') {
    exactKeys(state, value, ['kind', 'key', 'presentation'], path)
    if (depth !== 1) issue(state, path, 'asset-editor must be the root host UI node')
    const presentation = decodeAssetEditorPresentation(state, value['presentation'], `${path}.presentation`)
    return key !== undefined && depth === 1 && presentation !== undefined ? { kind, key, presentation } : undefined
  }

  issue(state, `${path}.kind`, 'must be group, text, status, action, or asset-editor')
  return undefined
}

function decodeContribution(value: unknown): HostUiDecodeResultV1 {
  const state: DecodeState = { seen: new WeakSet(), keys: new Set(), diagnostics: [], count: 0, limitExceeded: false }
  if (!isPlainObject(value)) return { diagnostics: [problem('$', 'must be a plain object')] }
  own(state, value, '$')
  exactKeys(state, value, ['version', 'root'], '$')
  if (value['version'] !== 1) issue(state, '$.version', 'must be 1')
  const root = decodeNode(state, value['root'], '$.root', 1)
  if (state.diagnostics.length > 0 || value['version'] !== 1 || root === undefined) return { diagnostics: state.diagnostics }
  return { contribution: freeze({ version: 1, root }), diagnostics: [] }
}

export function decodeHostUiContributionV1(value: unknown): HostUiDecodeResultV1 {
  try {
    const decoded = decodeContribution(value)
    if (!decoded.contribution) return decoded
    structuredClone(value)
    return decoded
  } catch {
    return { diagnostics: [problem('$', 'could not be safely inspected')] }
  }
}

export function createHostUiProviderContextV1(surface: HostUiSurfaceV1, data: Json): HostUiProviderContextV1 {
  const state: DecodeState = { seen: new WeakSet(), keys: new Set(), diagnostics: [], count: 0, limitExceeded: false }
  let owned: Json | undefined
  try {
    owned = decodeJson(state, data, '$.data', 0)
  } catch {
    throw new TypeError('$.data: could not be safely inspected')
  }
  if (state.diagnostics.length > 0 || owned === undefined) throw new TypeError(state.diagnostics[0]?.message ?? '$.data: invalid JSON')
  if (encoder.encode(JSON.stringify(owned)).byteLength > HOST_UI_MAX_PAYLOAD_JSON_BYTES) throw new TypeError(`$.data: exceeds the ${HOST_UI_MAX_PAYLOAD_JSON_BYTES} byte JSON limit`)
  try {
    structuredClone(data)
  } catch {
    throw new TypeError('$.data: could not be safely inspected')
  }
  return freeze({ version: 1, surface, data: owned })
}
