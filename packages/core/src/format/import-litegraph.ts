/**
 * Legacy litegraph workflow importer: translate, never support.
 *
 * The old frontend's format is positional at its core: `widgets_values` is a
 * bare array whose meaning depends entirely on the schema the workflow was
 * saved under. This importer maps those positions onto ID-keyed values using
 * the CURRENT schema and surfaces every mismatch as a review diagnostic
 * instead of silently misassigning values (architecture section 16, risk 8).
 *
 * Translations, not features:
 * - node modes: 0/1 -> active (1 was ON_EVENT, unused), 2 -> muted, 4 -> bypassed
 * - seed-style controllers: `control_after_generate` widgets serialize as an
 *   EXTRA positional entry after their value; imported into node.controllers
 * - Reroute nodes: preserved as first-class reroutes (topology + position);
 *   chains fed by GetNodes collapse into net sinks since nets are port-only
 * - KJNodes SetNode/GetNode pairs: converted to named nets (first-class here)
 * - frontend PrimitiveNode: converted to a value source (value + controller
 *   from widgets_values; the effective spec derives from consumers, exactly
 *   how the legacy node adopted its widget - architecture 5b). Backend
 *   PrimitiveInt/Float/... are ordinary compute nodes and import as nodes.
 * - Note/MarkdownNote nodes: translated to frontend virtual nodes
 * - groups: imported as view groups
 * - node sizes are not imported for executable nodes; note geometry is
 *   presentation authored by the user and is preserved
 */

import { canonicalJson } from '../compile/hash.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import {
  comboBranchValuePath,
  effectiveComboOption,
  inputsOf,
  joinValuePath,
  outputsOf,
  type AutogrowSpec,
  type CountBoundOutputAutogrowSpec,
  type InputSpec,
  type InterfaceItem,
  type NodeSchema,
  type OutputSpec,
} from '../schema/model.js'
import { DEFAULT_ELAB_BUDGET, elaborateInterface, elabInputsOf } from '../schema/elaborate.js'
import type { ComfyGroupCatalog, ComfyGroupRecord } from '../schema/comfy-group.js'
import { normalizeComboOption, normalizedComboOptions } from '../schema/combo-options.js'
import {
  FORMAT_VERSION,
  type ControllerMode,
  type GroupViewState,
  type Json,
  type JsonObject,
  type NodeData,
  type NodeViewState,
  type WorkflowDocument,
} from './document.js'
import { ownJson } from './json.js'
import { validateDocumentShape } from './validate.js'
import { checkDocument } from '../invariants.js'
import { isSaveTargetValue } from '../schema/widget-defaults.js'
import { importLitegraphSubgraphs } from './import-litegraph-subgraphs.js'

// -- litegraph wire shapes (loose: this is foreign, hostile JSON) ------------

interface LgNode {
  readonly id: number
  readonly type: string
  readonly title?: string
  readonly flags?: JsonObject
  readonly pos?: readonly number[] | Readonly<Record<string, number>>
  readonly size?: readonly number[] | Readonly<Record<string, number>>
  readonly mode?: number
  readonly inputs?: ReadonlyArray<{
    readonly name?: string
    readonly type?: Json
    readonly link?: number | null
    readonly widget?: { readonly name?: string }
  }>
  readonly outputs?: ReadonlyArray<{
    readonly name?: string
    readonly type?: Json
    readonly links?: readonly number[] | null
  }>
  readonly widgets_values?: readonly Json[] | Readonly<Record<string, Json>>
  readonly properties?: JsonObject
  readonly color?: string
  readonly bgcolor?: string
}

/** [id, fromNode, fromSlot, toNode, toSlot, type] */
type LgLink = readonly [number, number, number, number, number, ...unknown[]]

interface LgWire {
  fromNode: number
  fromSlot: number
  toNode: number
  toSlot: number
  type?: Json
}

const CONTROLLER_MODES: ReadonlySet<string> = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const MAX_COMFY_GROUP_MATCH_STATES = 2048
const MAX_UE_LINKS = 1024

/** Frontend-only litegraph node types with dedicated translations. */
const REROUTE_TYPES = new Set(['Reroute'])
const NOTE_TYPES = new Set(['Note', 'MarkdownNote'])
const SET_TYPES = new Set(['SetNode'])
const GET_TYPES = new Set(['GetNode'])
const PRIMITIVE_TYPES = new Set(['PrimitiveNode'])
const UE_SEED_CONTROLLER_TYPE = 'Seed Everywhere'
const UE_CONTROLLER_TYPES = new Set([
  'Anything Everywhere', 'Anything Everywhere3', 'Anything Everywhere?',
  'Prompts Everywhere', UE_SEED_CONTROLLER_TYPE,
])
const UE_INPUT_CONTROLLER_TYPES = new Set(
  [...UE_CONTROLLER_TYPES].filter((type) => type !== UE_SEED_CONTROLLER_TYPE),
)
const isUeController = (node: LgNode): boolean =>
  UE_CONTROLLER_TYPES.has(node.type) || node.properties?.['ue_convert'] === true
const isUeBroadcastInput = (type: string, slot: number): boolean => {
  if (type === 'Anything Everywhere?') return slot === 0
  if (type === 'Anything Everywhere3') return slot <= 2
  if (type === 'Prompts Everywhere') return slot <= 1
  return type === 'Anything Everywhere'
}

interface UeLink {
  readonly downstream: number
  readonly downstreamSlot: number
  readonly upstream: number
  readonly upstreamSlot: number
  readonly controller: number
  readonly type: string
}

export interface ImportLitegraphResult {
  /** Present only when there are no error-level diagnostics. */
  readonly document?: WorkflowDocument
  readonly diagnostics: readonly Diagnostic[]
}

const imp = (severity: 'error' | 'warning' | 'info', code: string, message: string): Diagnostic =>
  diag(severity, 'import', code, message)

interface PositionalWidgetDecode {
  readonly values: Record<string, Json>
  readonly controllers: Record<string, ControllerMode>
  readonly dynamic: Record<string, Json>
  index: number
  stopped: boolean
}

interface AutogrowFamilyImport {
  readonly statePath: string
  readonly wirePath: string
  readonly spec: AutogrowSpec
}

interface AutogrowWireMatch {
  readonly family: AutogrowFamilyImport
  readonly memberKey: string
  readonly slot: InputSpec
}

interface DiscoveredAutogrowMembers {
  readonly order: ReadonlyMap<string, readonly string[]>
  readonly slots: ReadonlyMap<number, { readonly match: AutogrowWireMatch; readonly memberId: string }>
}

function normalizeLegacyWidgetValue(
  item: InputSpec,
  value: Json,
  key: string,
  nodeLabel: string,
  diags: Diagnostic[],
): Json {
  if (item.dynamic === undefined && item.widget?.widgetType === 'COMBO') {
    const options = normalizedComboOptions(item.widget)
    if (typeof value === 'number' && Number.isFinite(value)) {
      const text = String(value)
      if (!options.some((option) => option.value === value) && options.some((option) => option.value === text)) return text
    }
    if (typeof value === 'string' && !options.some((option) => option.value === value)) {
      const declared = item.widget.options['options']
      const structured = Array.isArray(declared) ? declared.flatMap((option) => {
        if (Array.isArray(option) || typeof option !== 'object' || option === null) return []
        const normalized = normalizeComboOption(option)
        return normalized === undefined ? [] : [normalized]
      }) : []
      const matches = [...new Set(structured.filter((option) => option.label === value).map((option) => option.value))]
      if (matches.length === 1) return matches[0]!
    }
  }
  if (typeof value !== 'string') return value
  if (item.widget?.widgetType === 'INT' || item.widget?.widgetType === 'FLOAT') {
    const numericText = value.trim()
    const numeric = Number(numericText)
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numericText)
    if (
      decimal &&
      Number.isFinite(numeric) &&
      (item.widget.widgetType === 'FLOAT' || Number.isSafeInteger(numeric))
    ) return numeric
    return value
  }
  if (item.widget?.widgetType !== 'SAVE_TARGET') return value
  const declared = item.widget.default
  if (isSaveTargetValue(declared)) {
    const migrated = { mount: declared.mount, prefix: value }
    if (isSaveTargetValue(migrated)) return migrated
  }
  diags.push(imp(
    'warning',
    'import.saveTarget.invalidLegacy',
    `${nodeLabel}: legacy save target '${key}' could not be safely migrated; raw string kept for review`,
  ))
  return value
}

function decodeKeyedWidgets(
  items: readonly InterfaceItem[] | readonly InputSpec[],
  raw: Readonly<Record<string, Json>>,
  state: PositionalWidgetDecode,
  statePrefix: string,
  wirePrefix: string,
  nodeLabel: string,
  diags: Diagnostic[],
  known: Set<string>,
  flatAutogrow = false,
): void {
  for (const item of items) {
    if (item.kind !== 'input') continue
    const stateKey = joinValuePath(statePrefix, item.id)
    const wireKey = joinValuePath(wirePrefix, item.id)
    if (item.dynamic?.kind === 'dynamicCombo') {
      const selected = raw[wireKey]
      const branch = typeof selected === 'string'
        ? item.dynamic.options.find((option) => option.key === selected)
        : undefined
      if (branch !== undefined) {
        known.add(wireKey)
        state.dynamic[stateKey] = { selected: branch.key }
        decodeKeyedWidgets(
          branch.inputs,
          raw,
          state,
          item.dynamic.materialization === 'wire15' ? stateKey : comboBranchValuePath(stateKey, branch.key),
          item.dynamic.materialization === 'wire15' ? wireKey : comboBranchValuePath(wireKey, branch.key),
          nodeLabel,
          diags,
          known,
          flatAutogrow,
        )
      }
      continue
    }
    if (item.dynamic?.kind === 'autogrow') {
      const members = (state.dynamic[stateKey] as { readonly members?: readonly string[] } | undefined)?.members ?? []
      for (const member of members) {
        for (const slot of item.dynamic.template) {
          if (slot.dynamic !== undefined || slot.widget === undefined || slot.forceInput === true) continue
          const stateMember = joinValuePath(stateKey, member)
          const wireMember = flatAutogrow ? member : joinValuePath(wireKey, member)
          const stateInput = item.dynamic.template.length === 1
            ? stateMember
            : joinValuePath(stateMember, slot.id)
          const wireInput = item.dynamic.template.length === 1
            ? wireMember
            : joinValuePath(wireMember, slot.id)
          if (!Object.prototype.hasOwnProperty.call(raw, wireInput)) continue
          known.add(wireInput)
          state.values[stateInput] = normalizeLegacyWidgetValue(slot, raw[wireInput]!, stateInput, nodeLabel, diags)
        }
      }
      continue
    }
    if (item.widget !== undefined && Object.prototype.hasOwnProperty.call(raw, wireKey)) {
      known.add(wireKey)
      state.values[stateKey] = normalizeLegacyWidgetValue(item, raw[wireKey]!, stateKey, nodeLabel, diags)
    }
  }
}

/** Active Autogrow families and their ComfyUI wire scopes. */
function activeAutogrowFamilies(
  items: readonly InterfaceItem[] | readonly InputSpec[],
  dynamic: Readonly<Record<string, Json>>,
  statePrefix = '',
  wirePrefix = '',
): AutogrowFamilyImport[] {
  const families: AutogrowFamilyImport[] = []
  for (const item of items) {
    if (item.kind !== 'input' || item.dynamic === undefined) continue
    const statePath = joinValuePath(statePrefix, item.id)
    const wirePath = joinValuePath(wirePrefix, item.id)
    if (item.dynamic.kind === 'autogrow') {
      if (item.dynamic.naming.kind !== 'native') families.push({ statePath, wirePath, spec: item.dynamic })
      continue
    }
    if (item.dynamic.kind !== 'dynamicCombo') continue
    const selected = (dynamic[statePath] as { readonly selected?: unknown } | undefined)?.selected
    const option = typeof selected === 'string'
      ? item.dynamic.options.find((candidate) => candidate.key === selected)
      : undefined
    if (option === undefined) continue
    families.push(...activeAutogrowFamilies(
      option.inputs,
      dynamic,
      item.dynamic.materialization === 'wire15' ? statePath : comboBranchValuePath(statePath, option.key),
      wirePath,
    ))
  }
  return families
}

/** Match only names derivable from the family's declared vocabulary/template. */
function matchAutogrowWire(
  name: string,
  family: AutogrowFamilyImport,
  flat = false,
): AutogrowWireMatch | undefined {
  const prefix = `${family.wirePath}.`
  if (!flat && !name.startsWith(prefix)) return undefined
  const relative = flat ? name : name.slice(prefix.length)
  const { naming, template } = family.spec
  if (naming.kind === 'native') return undefined

  if (naming.kind === 'names') {
    for (const member of naming.names) {
      if (template.length === 1 && relative === member) {
        return { family, memberKey: member, slot: template[0]! }
      }
      if (template.length > 1 && family.spec.materialization === 'wire15') {
        for (const slot of template) {
          if (relative === `${member}.${slot.id}`) return { family, memberKey: member, slot }
        }
      }
    }
    return undefined
  }

  const max = naming.max ?? 10
  const offset = family.spec.ordinalOffset ?? 0
  for (const slot of template) {
    const grouped = template.length > 1
      ? new RegExp(`^${escapeRegExp(naming.prefix)}([0-9]+)\\.${escapeRegExp(slot.id)}$`).exec(relative)
      : null
    const flat = template.length > 1
      ? new RegExp(`^${escapeRegExp(slot.id)}([0-9]+)$`).exec(relative)
      : new RegExp(`^${escapeRegExp(naming.prefix)}([0-9]+)$`).exec(relative)
    const ordinalText = grouped?.[1] ?? flat?.[1]
    if (ordinalText === undefined) continue
    const ordinal = Number(ordinalText)
    if (ordinalText !== String(ordinal) || !Number.isSafeInteger(ordinal) || ordinal < offset || ordinal >= offset + max) return undefined
    return { family, memberKey: `${naming.prefix}${ordinalText}`, slot }
  }
  return undefined
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const discoverAutogrowMembers = (
  inputs: readonly { readonly name?: string }[],
  families: readonly AutogrowFamilyImport[],
  preserveSuffixes: boolean,
): DiscoveredAutogrowMembers => {
  const allocated = new Map<string, Map<string, string>>()
  const order = new Map<string, string[]>()
  const slots = new Map<number, { match: AutogrowWireMatch; memberId: string }>()
  const allocate = (match: AutogrowWireMatch): string => {
    let familyMembers = allocated.get(match.family.statePath)
    if (familyMembers === undefined) {
      familyMembers = new Map()
      allocated.set(match.family.statePath, familyMembers)
      order.set(match.family.statePath, [])
    }
    const existing = familyMembers.get(match.memberKey)
    if (existing !== undefined) return existing
    const memberId = preserveSuffixes || match.family.spec.naming.kind === 'names'
      ? match.memberKey
      : `m${familyMembers.size}`
    familyMembers.set(match.memberKey, memberId)
    order.get(match.family.statePath)!.push(memberId)
    return memberId
  }
  for (const [slotIndex, input] of inputs.entries()) {
    if (typeof input.name !== 'string') continue
    const candidates = families
      .map((family) => matchAutogrowWire(input.name!, family, preserveSuffixes))
      .filter((candidate): candidate is AutogrowWireMatch => candidate !== undefined)
    if (candidates.length !== 1) continue
    const match = candidates[0]!
    slots.set(slotIndex, { match, memberId: allocate(match) })
  }
  for (const family of families) {
    let members = order.get(family.statePath)
    if (members === undefined) {
      members = []
      order.set(family.statePath, members)
    }
    const minimum = family.spec.naming.min ?? 0
    if (family.spec.naming.kind === 'names') {
      for (const name of family.spec.naming.names) {
        if (members.length >= minimum) break
        if (!members.includes(name)) members.push(name)
      }
    } else if (family.spec.naming.kind === 'prefix') {
      let ordinal = family.spec.ordinalOffset ?? 0
      while (members.length < minimum) {
        const member = preserveSuffixes ? `${family.spec.naming.prefix}${ordinal++}` : `m${members.length}`
        if (!members.includes(member)) members.push(member)
      }
    }
  }
  return { order, slots }
}

const decodePositionalFamilyWidgets = (
  family: AutogrowFamilyImport,
  members: readonly string[],
  raw: readonly Json[],
  state: PositionalWidgetDecode,
  nodeLabel: string,
  diags: Diagnostic[],
): void => {
  for (const member of members) {
    for (const item of family.spec.template) {
      if (item.dynamic !== undefined) {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.autogrowUnsupported', `${nodeLabel}: dynamic autogrow '${family.statePath}' has a nested dynamic template; remaining positional values kept for review`))
        return
      }
      if (item.widget === undefined || item.forceInput === true) continue
      const memberPath = joinValuePath(family.statePath, member)
      const key = family.spec.template.length === 1 ? memberPath : joinValuePath(memberPath, item.id)
      if (state.index >= raw.length) {
        diags.push(imp('warning', 'import.widgets.missing', `${nodeLabel}: no positional value for widget '${key}'; schema default applies`))
        continue
      }
      state.values[key] = normalizeLegacyWidgetValue(item, raw[state.index++] as Json, key, nodeLabel, diags)
      if (item.widget.controller !== undefined && state.index < raw.length) {
        const mode = raw[state.index]
        if (typeof mode === 'string' && CONTROLLER_MODES.has(mode)) {
          state.controllers[key] = mode as ControllerMode
          state.index++
        }
      }
    }
  }
}

/**
 * Decode ComfyUI's ordered widget stream without elaborating a partial node.
 * A DynamicCombo selector determines which schema subtree owns the following
 * positions. Top-level static Autogrow families consume the members already
 * reconstructed from the serialized LiteGraph input order.
 */
function decodePositionalWidgets(
  items: readonly InterfaceItem[] | readonly InputSpec[],
  raw: readonly Json[],
  state: PositionalWidgetDecode,
  prefix: string,
  nodeLabel: string,
  diags: Diagnostic[],
): void {
  for (const item of items) {
    if (state.stopped) return
    if (item.kind !== 'input') continue
    const key = joinValuePath(prefix, item.id)
    const dynamic = item.dynamic

    // DynamicCombo's widget describes its selector but does not own a second
    // positional value. Consume the selector once, before ordinary widgets.
    if (dynamic?.kind === 'dynamicCombo') {
      if (state.index >= raw.length) {
        diags.push(imp('warning', 'import.widgets.missing', `${nodeLabel}: no positional value for dynamic selector '${key}'; schema default applies`))
        const fallback = effectiveComboOption(dynamic, undefined)
        const branch = dynamic.options.find((option) => option.key === fallback)
        if (branch) {
          decodePositionalWidgets(
            branch.inputs,
            raw,
            state,
            dynamic.materialization === 'wire15' ? key : comboBranchValuePath(key, branch.key),
            nodeLabel,
            diags,
          )
        }
        continue
      }

      const selected = raw[state.index++]
      const branch = typeof selected === 'string'
        ? dynamic.options.find((option) => option.key === selected)
        : undefined
      if (branch === undefined) {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.unknownSelector', `${nodeLabel}: dynamic selector '${key}' has unknown option ${JSON.stringify(selected)}; schema default applies and remaining positional values were kept for review`))
        return
      }

      state.dynamic[key] = { selected: branch.key }
      decodePositionalWidgets(
        branch.inputs,
        raw,
        state,
        dynamic.materialization === 'wire15' ? key : comboBranchValuePath(key, branch.key),
        nodeLabel,
        diags,
      )
      continue
    }

    // Current ComfyUI does not materialize forceInput parameters as widgets,
    // so they consume no positional widgets_values entry. Older workflows
    // that serialized one remain loud as excess rather than shifting every
    // later widget onto the wrong semantic input.
    if (item.widget !== undefined && item.forceInput !== true) {
      if (state.index >= raw.length) {
        diags.push(imp('warning', 'import.widgets.missing', `${nodeLabel}: no positional value for widget '${key}'; schema default applies`))
      } else {
        state.values[key] = normalizeLegacyWidgetValue(item, raw[state.index++] as Json, key, nodeLabel, diags)
        if (item.widget.controller !== undefined && state.index < raw.length) {
          const mode = raw[state.index]
          if (typeof mode === 'string' && CONTROLLER_MODES.has(mode)) {
            state.controllers[key] = mode as ControllerMode
            state.index++
          }
          // Not a mode string: leave it for the next widget rather than
          // guessing, including for widgets nested under a combo branch.
        }
      }
    }

    if (dynamic === undefined) continue
    if (dynamic.kind === 'autogrow') {
      const members = (state.dynamic[key] as { readonly members?: readonly string[] } | undefined)?.members
      if (members === undefined || dynamic.materialization !== 'wire15' || dynamic.naming.kind === 'native') {
        state.stopped = true
        diags.push(imp('warning', 'import.dynamic.autogrowUnsupported', `${nodeLabel}: dynamic autogrow '${key}' cannot be reconstructed; remaining positional values kept for review`))
        return
      }
      decodePositionalFamilyWidgets({ statePath: key, wirePath: key, spec: dynamic }, members, raw, state, nodeLabel, diags)
    }
  }
}

interface StaticNodeDecode {
  readonly values: Readonly<Record<string, Json>>
  readonly controllers: Readonly<Record<string, ControllerMode>>
}

interface ComfyGroupMatch {
  readonly record: ComfyGroupRecord
  readonly assignment: ReadonlyMap<string, number>
  readonly decoded: ReadonlyMap<string, StaticNodeDecode>
}

interface ComfyGroupMatchSearch {
  readonly matches: readonly ComfyGroupMatch[]
  readonly capped: boolean
}

interface StrictNodeSurface {
  readonly inputs: ReadonlyMap<number, string>
  readonly outputs: ReadonlyMap<number, string>
}

interface ComfyGroupPreparation {
  readonly prepared: ReadonlyMap<number, StaticNodeDecode>
  readonly sourceSchemas: ReadonlyMap<number, NodeSchema>
}

const litegraphMode = (node: LgNode): 'active' | 'muted' | 'bypassed' | undefined => {
  if (node.mode === undefined || node.mode === 0 || node.mode === 1) return 'active'
  if (node.mode === 2) return 'muted'
  if (node.mode === 4) return 'bypassed'
  return undefined
}

const inputPortForSchema = (node: LgNode, slot: number, schema: NodeSchema): string | undefined => {
  const foreignInput = node.inputs?.[slot]
  if (foreignInput === undefined) return undefined
  const foreignName = foreignInput.name
  const widgetName = foreignInput.widget?.name
  const inputs = inputsOf(schema)
  const named = foreignInput.widget !== undefined
    ? inputs.find((input) => input.id === widgetName) ?? inputs.find((input) => input.id === foreignName)
    : inputs.find((input) => input.id === foreignName)
  if (named !== undefined) return named.id
  if (foreignInput.widget !== undefined) return widgetName ?? foreignName
  const sockets = inputs.filter((input) => input.widget === undefined || input.forceInput === true)
  const ordinal = (node.inputs ?? [])
    .slice(0, slot + 1)
    .filter((input) => input.widget === undefined).length - 1
  return sockets[ordinal]?.id ?? foreignName
}

const staticOutputPortForSchema = (
  node: LgNode,
  slot: number,
  schema: NodeSchema,
  allowPositional: boolean,
): string | undefined => {
  const foreignName = node.outputs?.[slot]?.name
  if (typeof foreignName !== 'string' || foreignName.length === 0) return undefined
  const occurrence = (node.outputs ?? [])
    .slice(0, slot)
    .filter((output) => output.name === foreignName).length
  const outputs = outputsOf(schema).filter((output) => output.dynamic === undefined)
  const exact = outputs.filter((output) => output.id === foreignName)
  if (exact.length > 0) return exact[occurrence]?.id
  const displayed = outputs.filter((output) => output.displayName === foreignName)
  if (displayed.length > 0) return displayed[occurrence]?.id
  const foldedName = foreignName.toLowerCase()
  const folded = outputs.filter((output) =>
    output.id.toLowerCase() === foldedName || output.displayName?.toLowerCase() === foldedName)
  if (folded.length > 0) return folded[occurrence]?.id
  if (!allowPositional || outputsOf(schema).some((output) => output.dynamic !== undefined)) return undefined
  const positional = outputsOf(schema)[slot]
  return positional?.id
}

const strictNodeSurfaceForSchema = (
  node: LgNode,
  schema: NodeSchema,
): StrictNodeSurface | undefined => {
  const expectedInputs = inputsOf(schema)
    .filter((input) => input.dynamic === undefined)
    .filter((input) => input.widget === undefined || input.forceInput === true)
  if (
    inputsOf(schema).some((input) => input.dynamic !== undefined) ||
    outputsOf(schema).some((output) => output.dynamic !== undefined) ||
    (node.inputs?.length ?? 0) !== expectedInputs.length ||
    (node.outputs?.length ?? 0) !== outputsOf(schema).length
  ) return undefined
  const inputIds = new Set(expectedInputs.map((input) => input.id))
  const inputs = new Map<number, string>()
  for (const [slot, input] of (node.inputs ?? []).entries()) {
    if (
      typeof input.name !== 'string' ||
      !inputIds.has(input.name) ||
      (input.widget?.name !== undefined && input.widget.name !== input.name) ||
      [...inputs.values()].includes(input.name)
    ) return undefined
    inputs.set(slot, input.name)
  }
  const outputs = new Map<number, string>()
  for (const [slot] of (node.outputs ?? []).entries()) {
    const port = staticOutputPortForSchema(node, slot, schema, false)
    if (port === undefined || [...outputs.values()].includes(port)) return undefined
    outputs.set(slot, port)
  }
  return { inputs, outputs }
}

const decodeStaticNode = (node: LgNode, schema: NodeSchema): StaticNodeDecode | undefined => {
  const inputs = inputsOf(schema)
  if (inputs.some((input) => input.dynamic !== undefined)) return undefined
  const values: Record<string, Json> = {}
  const controllers: Record<string, ControllerMode> = {}
  const widgets = inputs.filter((input) => input.widget !== undefined && input.forceInput !== true)
  const raw = node.widgets_values
  const assign = (input: InputSpec, value: Json): void => {
    values[input.id] = normalizeLegacyWidgetValue(input, value, input.id, `node ${node.id}`, [])
  }
  if (Array.isArray(raw)) {
    let index = 0
    for (const input of widgets) {
      if (index < raw.length) assign(input, raw[index++] as Json)
      else if (input.widget?.default !== undefined) assign(input, input.widget.default as Json)
      if (input.widget?.controller !== undefined && index < raw.length) {
        const controller = raw[index]
        if (typeof controller === 'string' && CONTROLLER_MODES.has(controller)) {
          controllers[input.id] = controller as ControllerMode
          index++
        }
      }
    }
    if (index !== raw.length) return undefined
  } else if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const keyed = raw as Readonly<Record<string, Json>>
    const known = new Set(widgets.map((input) => input.id))
    if (Object.keys(keyed).some((key) => !known.has(key))) return undefined
    for (const input of widgets) {
      if (Object.prototype.hasOwnProperty.call(keyed, input.id)) assign(input, keyed[input.id]!)
      else if (input.widget?.default !== undefined) assign(input, input.widget.default as Json)
    }
  } else {
    for (const input of widgets) {
      if (input.widget?.default !== undefined) assign(input, input.widget.default as Json)
    }
  }
  return { values, controllers }
}

const groupAddress = (value: string): { readonly node: string; readonly port: string } => {
  const split = value.indexOf(':')
  return { node: value.slice(0, split), port: value.slice(split + 1) }
}

const findGroupMatches = (
  record: ComfyGroupRecord,
  byId: ReadonlyMap<number, LgNode>,
  wires: ReadonlyMap<number, LgWire>,
  catalog: ComfyGroupCatalog,
): ComfyGroupMatchSearch => {
  const schemas = new Map<string, NodeSchema>()
  const candidates = new Map<string, readonly number[]>()
  for (const [localId, patternNode] of record.pattern.nodes) {
    const schema = catalog.sourceSchemas.get(patternNode.source.nodeType)
    if (schema === undefined) return { matches: [], capped: false }
    schemas.set(localId, schema)
    candidates.set(localId, [...byId.values()]
      .filter((node) =>
        node.type === patternNode.source.nodeClass &&
        litegraphMode(node) === patternNode.mode &&
        strictNodeSurfaceForSchema(node, schema) !== undefined)
      .map((node) => node.id)
      .sort((left, right) => left - right))
  }

  const edgeTouches = (edge: { readonly from: string; readonly to: string }, localId: string): boolean =>
    groupAddress(edge.from).node === localId || groupAddress(edge.to).node === localId
  const order = [record.pattern.anchor]
  const queued = new Set(order)
  while (order.length < record.pattern.nodes.size) {
    const next = [...record.pattern.nodes.keys()]
      .filter((localId) => !queued.has(localId))
      .filter((localId) => record.pattern.edges.some((edge) => {
        if (!edgeTouches(edge, localId)) return false
        const from = groupAddress(edge.from).node
        const to = groupAddress(edge.to).node
        return queued.has(from === localId ? to : from)
      }))
      .sort((left, right) => (candidates.get(left)!.length - candidates.get(right)!.length) || left.localeCompare(right))[0]
    if (next === undefined) return { matches: [], capped: false }
    queued.add(next)
    order.push(next)
  }

  const edgeExists = (
    edge: { readonly from: string; readonly to: string },
    assignment: ReadonlyMap<string, number>,
  ): boolean => {
    const from = groupAddress(edge.from)
    const to = groupAddress(edge.to)
    const fromId = assignment.get(from.node)
    const toId = assignment.get(to.node)
    if (fromId === undefined || toId === undefined) return true
    const fromSchema = schemas.get(from.node)!
    const toSchema = schemas.get(to.node)!
    const fromNode = byId.get(fromId)!
    const toNode = byId.get(toId)!
    const fromSurface = strictNodeSurfaceForSchema(fromNode, fromSchema)
    const toSurface = strictNodeSurfaceForSchema(toNode, toSchema)
    if (fromSurface === undefined || toSurface === undefined) return false
    return [...wires.values()].some((wire) =>
      wire.fromNode === fromId &&
      wire.toNode === toId &&
      fromSurface.outputs.get(wire.fromSlot) === from.port &&
      toSurface.inputs.get(wire.toSlot) === to.port)
  }

  const validate = (assignment: ReadonlyMap<string, number>): ComfyGroupMatch | undefined => {
    const localByNode = new Map([...assignment].map(([localId, nodeId]) => [nodeId, localId]))
    const decoded = new Map<string, StaticNodeDecode>()
    const surfaces = new Map<string, StrictNodeSurface>()
    for (const [localId, nodeId] of assignment) {
      const node = byId.get(nodeId)!
      const schema = schemas.get(localId)!
      const value = decodeStaticNode(node, schema)
      const surface = strictNodeSurfaceForSchema(node, schema)
      if (value === undefined || surface === undefined) return undefined
      decoded.set(localId, value)
      surfaces.set(localId, surface)
    }
    const expectedEdges = new Set(record.pattern.edges.map((edge) => `${edge.from}\0${edge.to}`))
    const actualEdges = new Set<string>()
    const inputCounts = new Map<string, number>()
    for (const wire of wires.values()) {
      const fromLocal = localByNode.get(wire.fromNode)
      const toLocal = localByNode.get(wire.toNode)
      if (toLocal !== undefined) {
        const port = surfaces.get(toLocal)!.inputs.get(wire.toSlot)
        if (port === undefined) return undefined
        const target = `${toLocal}:${port}`
        inputCounts.set(target, (inputCounts.get(target) ?? 0) + 1)
        if (fromLocal === undefined && ![...record.pattern.inputs.values()].includes(target)) return undefined
      }
      if (fromLocal !== undefined) {
        const port = surfaces.get(fromLocal)!.outputs.get(wire.fromSlot)
        if (port === undefined) return undefined
        const source = `${fromLocal}:${port}`
        if (toLocal === undefined && ![...record.pattern.outputs.values()].includes(source)) return undefined
        if (toLocal !== undefined) {
          const targetPort = surfaces.get(toLocal)!.inputs.get(wire.toSlot)
          const key = `${source}\0${toLocal}:${targetPort}`
          if (!expectedEdges.has(key) || actualEdges.has(key)) return undefined
          actualEdges.add(key)
        }
      }
    }
    if (actualEdges.size !== expectedEdges.size || [...inputCounts.values()].some((count) => count > 1)) {
      return undefined
    }
    for (const target of record.pattern.disconnected) {
      if (inputCounts.has(target)) return undefined
      const parsed = groupAddress(target)
      const node = byId.get(assignment.get(parsed.node)!)!
      const slot = [...surfaces.get(parsed.node)!.inputs].find(([, port]) => port === parsed.port)?.[0]
      if (slot === undefined) return undefined
      const declaredLink = node.inputs?.[slot]?.link
      if (declaredLink !== undefined && declaredLink !== null) return undefined
    }
    for (const [rawAddress, expected] of record.pattern.constants) {
      const parsed = groupAddress(rawAddress)
      const source = decoded.get(parsed.node)!
      const sourceValues = source.values
      if (!Object.prototype.hasOwnProperty.call(sourceValues, parsed.port)) return undefined
      const actual = sourceValues[parsed.port]
      if (canonicalJson(actual) !== canonicalJson(expected)) return undefined
      const sourceInput = inputsOf(schemas.get(parsed.node)!).find((input) => input.id === parsed.port)!
      if (sourceInput.widget?.controller !== undefined) {
        const controller = source.controllers[parsed.port] ?? sourceInput.widget.controllerInitial ?? 'randomize'
        if (controller !== 'fixed') return undefined
      }
    }
    return { record, assignment: new Map(assignment), decoded }
  }

  const matches: ComfyGroupMatch[] = []
  const assignment = new Map<string, number>()
  const used = new Set<number>()
  let visitedStates = 0
  let capped = false
  const search = (index: number): void => {
    if (capped) return
    if (index === order.length) {
      const matched = validate(assignment)
      if (matched !== undefined) matches.push(matched)
      return
    }
    const localId = order[index]!
    for (const nodeId of candidates.get(localId)!) {
      if (used.has(nodeId)) continue
      visitedStates++
      if (visitedStates > MAX_COMFY_GROUP_MATCH_STATES) {
        capped = true
        return
      }
      assignment.set(localId, nodeId)
      used.add(nodeId)
      if (record.pattern.edges.every((edge) => edgeExists(edge, assignment))) search(index + 1)
      used.delete(nodeId)
      assignment.delete(localId)
    }
  }
  search(0)
  return { matches: capped ? [] : matches, capped }
}

const collapseComfyGroups = (
  byId: Map<number, LgNode>,
  wires: Map<number, LgWire>,
  catalog: ComfyGroupCatalog,
  diags: Diagnostic[],
  shouldCollapse: (record: ComfyGroupRecord, anchorId: number) => boolean,
): ComfyGroupPreparation => {
  const candidates: ComfyGroupMatch[] = []
  for (const record of [...catalog.records].sort((left, right) => left.id.localeCompare(right.id))) {
    const result = findGroupMatches(record, byId, wires, catalog)
    candidates.push(...result.matches)
    if (result.capped) {
      diags.push(imp(
        'warning',
        'import.comfyGroup.searchLimit',
        `ComfyUI group '${record.id}' exceeded the bounded match search and was left unchanged for review`,
      ))
    }
  }
  const claims = new Map<number, ComfyGroupMatch[]>()
  for (const match of candidates) for (const nodeId of match.assignment.values()) {
    const holders = claims.get(nodeId) ?? []
    holders.push(match)
    claims.set(nodeId, holders)
  }
  const conflicted = new Set(candidates.filter((match) =>
    [...match.assignment.values()].some((nodeId) => claims.get(nodeId)!.length > 1)))
  if (conflicted.size > 0) {
    diags.push(imp(
      'warning',
      'import.comfyGroup.ambiguous',
      `${conflicted.size} overlapping or ambiguous ComfyUI group match(es) were left unchanged for review`,
    ))
  }
  const accepted = candidates.filter((match) => !conflicted.has(match))
  const sourceSchemas = new Map<number, NodeSchema>()
  for (const match of accepted) {
    for (const [localId, nodeId] of match.assignment) {
      const nodeType = match.record.pattern.nodes.get(localId)!.source.nodeType
      sourceSchemas.set(nodeId, catalog.sourceSchemas.get(nodeType)!)
    }
  }
  const selected = accepted.filter((match) => {
    const anchorId = match.assignment.get(match.record.pattern.anchor)!
    return shouldCollapse(match.record, anchorId)
  })
  const prepared = new Map<number, StaticNodeDecode>()
  for (const match of selected) {
    const { record } = match
    const anchorId = match.assignment.get(record.pattern.anchor)!
    const anchor = byId.get(anchorId)!
    const memberIds = new Set(match.assignment.values())
    const groupSchema = catalog.groupSchemas.get(record.pattern.groupType)!
    const groupInputs = inputsOf(groupSchema)
    const groupOutputs = outputsOf(groupSchema)
    const values: Record<string, Json> = {}
    const controllers: Record<string, ControllerMode> = {}
    for (const entries of [record.pattern.inputs, record.pattern.parameters]) {
      for (const [groupInput, rawAddress] of entries) {
        const parsed = groupAddress(rawAddress)
        const source = match.decoded.get(parsed.node)!
        if (Object.prototype.hasOwnProperty.call(source.values, parsed.port)) {
          values[groupInput] = source.values[parsed.port]!
        }
        if (Object.prototype.hasOwnProperty.call(source.controllers, parsed.port)) {
          controllers[groupInput] = source.controllers[parsed.port]!
        }
      }
    }
    const inputByAddress = new Map(
      [...record.pattern.inputs].map(([groupInput, rawAddress]) => [rawAddress, groupInput]),
    )
    const outputByAddress = new Map(
      [...record.pattern.outputs].map(([groupOutput, rawAddress]) => [rawAddress, groupOutput]),
    )
    const localByNode = new Map([...match.assignment].map(([localId, nodeId]) => [nodeId, localId]))
    for (const [linkId, wire] of [...wires]) {
      const fromLocal = localByNode.get(wire.fromNode)
      const toLocal = localByNode.get(wire.toNode)
      if (fromLocal !== undefined && toLocal !== undefined) {
        wires.delete(linkId)
        continue
      }
      if (toLocal !== undefined) {
        const sourceSchema = catalog.sourceSchemas.get(record.pattern.nodes.get(toLocal)!.source.nodeType)!
        const sourcePort = strictNodeSurfaceForSchema(byId.get(wire.toNode)!, sourceSchema)!.inputs.get(wire.toSlot)!
        const groupPort = inputByAddress.get(`${toLocal}:${sourcePort}`)!
        wire.toNode = anchorId
        wire.toSlot = groupInputs.findIndex((input) => input.id === groupPort)
      }
      if (fromLocal !== undefined) {
        const sourceSchema = catalog.sourceSchemas.get(record.pattern.nodes.get(fromLocal)!.source.nodeType)!
        const sourcePort = strictNodeSurfaceForSchema(byId.get(wire.fromNode)!, sourceSchema)!.outputs.get(wire.fromSlot)!
        const groupPort = outputByAddress.get(`${fromLocal}:${sourcePort}`)!
        wire.fromNode = anchorId
        wire.fromSlot = groupOutputs.findIndex((output) => output.id === groupPort)
      }
    }
    for (const nodeId of memberIds) byId.delete(nodeId)
    const mode = litegraphMode(anchor) === 'muted' ? 2 : litegraphMode(anchor) === 'bypassed' ? 4 : 0
    byId.set(anchorId, {
      id: anchorId,
      type: record.pattern.groupType,
      ...(anchor.title !== undefined ? { title: anchor.title } : {}),
      ...(anchor.pos !== undefined ? { pos: anchor.pos } : {}),
      mode,
      inputs: groupInputs.map((input) => ({ name: input.id })),
      outputs: groupOutputs.map((output) => ({ name: output.id })),
    })
    prepared.set(anchorId, { values, controllers })
  }
  if (selected.length > 0) {
    diags.push(imp(
      'info',
      'import.comfyGroup.collapsed',
      `${selected.length} maintained ComfyUI node group(s) collapsed for native replacement`,
    ))
  }
  return { prepared, sourceSchemas }
}

/** FNV-1a 32-bit hash, hex-encoded. Deterministic lineage for imports. */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Translate a legacy litegraph workflow into a v1 dinkster document. `resolve`
 * supplies the schemas used to decode each authored class. The optional alias
 * predicate identifies maintained ComfyUI source snapshots whose dynamic
 * member suffixes must survive for replacement planning. The optional group
 * catalog collapses exact connected patterns before node materialization.
 * Positional widget and port mapping is impossible without a schema, so
 * unresolved node types remain raw with their values parked under ext for
 * later review.
 */
export function importLitegraph(
  input: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
  isMaintainedAlias: (authoredType: string, schema: NodeSchema) => boolean = () => false,
  comfyGroups?: ComfyGroupCatalog,
  shouldCollapseComfyGroup: (record: ComfyGroupRecord, anchorId: number) => boolean = () => true,
): ImportLitegraphResult {
  const ingress = ownJson(input)
  if (!ingress.ok) return { diagnostics: [imp('error', 'import.notJson', `workflow rejected: ${ingress.reason}`)] }
  const result = importLitegraphSubgraphs(ingress.value as JsonObject, resolve, (graph, localResolve, definitions) =>
    importLitegraphGraph(graph, localResolve, isMaintainedAlias, comfyGroups, shouldCollapseComfyGroup, definitions))
  if (!result.document) return result
  return { ...result, document: Object.freeze({ ...result.document,
    lineage: `lg-${fnv1a(JSON.stringify(ingress.value))}` as WorkflowDocument['lineage'],
  }) }
}

function importLitegraphGraph(
  input: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
  isMaintainedAlias: (authoredType: string, schema: NodeSchema) => boolean,
  comfyGroups: ComfyGroupCatalog | undefined,
  shouldCollapseComfyGroup: (record: ComfyGroupRecord, anchorId: number) => boolean,
  definitions: WorkflowDocument['graphs'],
): ImportLitegraphResult {
  // Ownership boundary (CO1/CO9): the workflow is foreign input. Owning it
  // up front rejects accessors/proxies/cycles/non-finite numbers (e.g. an
  // Infinity widgets_values entry) before ANY translation reads it, and
  // makes every read below safe and side-effect free.
  const ingress = ownJson(input)
  if (!ingress.ok) {
    return {
      diagnostics: [imp('error', 'import.notJson', `workflow rejected: ${ingress.reason}`)],
    }
  }
  const json = ingress.value as JsonObject
  const diags: Diagnostic[] = []
  if (json['occurrenceTopologies'] !== undefined) {
    return {
      diagnostics: [imp('error', 'import.occurrenceTopologies.unsupported', 'LiteGraph import cannot carry occurrence topology overlays; use the native Dinkster workflow format')],
    }
  }
  const rawNodes = Array.isArray(json['nodes']) ? (json['nodes'] as readonly LgNode[]) : []
  const rawLinks = Array.isArray(json['links']) ? (json['links'] as readonly LgLink[]) : []
  const isId = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const isFinitePair = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    if (value === null || typeof value !== 'object') return false
    const pair = value as Readonly<Record<string, unknown>>
    return Number.isFinite(pair['0']) && Number.isFinite(pair['1'])
  }
  const canonicalId = (value: unknown): number | undefined => {
    if (isId(value)) return value
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined
    const parsed = Number(value)
    return isId(parsed) ? parsed : undefined
  }

  const extra = json['extra']
  const extraObject = extra !== null && typeof extra === 'object' && !Array.isArray(extra)
    ? extra as JsonObject
    : undefined
  const presentLinkIds = new Set(
    rawLinks.filter(Array.isArray).map((link) => canonicalId(link[0])).filter((id): id is number => id !== undefined),
  )
  const temporaryLinks = new Set<number>()
  const marked = extraObject?.['links_added_by_ue']
  if (marked !== undefined) {
    if (!Array.isArray(marked) || marked.length > MAX_UE_LINKS) {
      diags.push(imp('error', 'import.ue.temporaryLinksInvalid', `extra.links_added_by_ue must be an array of at most ${MAX_UE_LINKS} link IDs`))
    } else {
      for (const raw of marked) {
        const id = canonicalId(raw)
        if (id === undefined || temporaryLinks.has(id)) {
          diags.push(imp('error', 'import.ue.temporaryLinksInvalid', 'extra.links_added_by_ue must contain unique safe non-negative integer link IDs'))
          continue
        }
        temporaryLinks.add(id)
      }
      for (const id of temporaryLinks) if (!presentLinkIds.has(id)) {
        diags.push(imp('error', 'import.ue.temporaryLinkMissing', `extra.links_added_by_ue references missing link ${id}`))
      }
    }
  }

  const ueLinks: UeLink[] = []
  const manifest = extraObject?.['ue_links']
  if (manifest !== undefined) {
    if (!Array.isArray(manifest) || manifest.length > MAX_UE_LINKS) {
      diags.push(imp('error', 'import.ue.manifestInvalid', `extra.ue_links must be an array of at most ${MAX_UE_LINKS} entries`))
    } else {
      for (const [index, raw] of manifest.entries()) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          diags.push(imp('error', 'import.ue.entryInvalid', `extra.ue_links entry ${index} is malformed`))
          continue
        }
        const entry = raw as JsonObject
        const keys = Object.keys(entry).sort()
        const expectedKeys = ['controller', 'downstream', 'downstream_slot', 'type', 'upstream', 'upstream_slot']
        const downstream = canonicalId(entry['downstream'])
        const upstream = canonicalId(entry['upstream'])
        const controller = canonicalId(entry['controller'])
        const downstreamSlot = entry['downstream_slot']
        const upstreamSlot = entry['upstream_slot']
        const type = entry['type']
        if (canonicalJson(keys) !== canonicalJson(expectedKeys) || downstream === undefined ||
          upstream === undefined || controller === undefined || !isId(downstreamSlot) ||
          !isId(upstreamSlot) || typeof type !== 'string' || type.trim().length === 0) {
          diags.push(imp('error', 'import.ue.entryInvalid', `extra.ue_links entry ${index} must contain exactly canonical node IDs, safe slot indices, and a non-empty type`))
          continue
        }
        ueLinks.push({ downstream, downstreamSlot, upstream, upstreamSlot, controller, type })
      }
    }
  }
  if (temporaryLinks.size > 0 && manifest === undefined) {
    diags.push(imp('error', 'import.ue.manifestMissing', 'extra.links_added_by_ue requires the authoritative extra.ue_links manifest'))
  }
  const ueEndpointKeys = new Set(
    ueLinks.map((entry) => `${entry.upstream}:${entry.upstreamSlot}:${entry.downstream}:${entry.downstreamSlot}`),
  )
  const ueEndpointTypes = new Map(
    ueLinks.map((entry) => [`${entry.upstream}:${entry.upstreamSlot}:${entry.downstream}:${entry.downstreamSlot}`, entry.type]),
  )

  // Link endpoints, keyed by litegraph link id.
  const wires = new Map<number, LgWire>()
  const seenLinkIds = new Set<number>()
  const claimedTemporaryLinks = new Set<number>()
  for (const l of rawLinks) {
    if (!Array.isArray(l) || l.length < 5) {
      diags.push(imp('warning', 'import.link.malformed', `skipping malformed link entry ${JSON.stringify(l)}`))
      continue
    }
    const linkId = l[0]
    const fromNode = canonicalId(l[1])
    const toNode = canonicalId(l[3])
    if (!isId(linkId) || fromNode === undefined || !isId(l[2]) || toNode === undefined || !isId(l[4])) {
      diags.push(imp('error', 'import.link.invalidId', `link entry ${JSON.stringify(l)} must use a safe integer link ID and slot indices, and canonical node IDs`))
      continue
    }
    if (seenLinkIds.has(linkId)) {
      diags.push(imp('error', 'import.link.duplicateId', `duplicate litegraph link ID ${linkId}`))
      continue
    }
    seenLinkIds.add(linkId)
    if (temporaryLinks.has(linkId)) {
      const endpointKey = `${fromNode}:${l[2]}:${toNode}:${l[4]}`
      if (ueEndpointKeys.has(endpointKey)) {
        claimedTemporaryLinks.add(linkId)
        const linkType = l[5]
        const manifestType = ueEndpointTypes.get(endpointKey)
        if (linkType !== undefined && (typeof linkType !== 'string' || (linkType !== '*' && linkType !== manifestType))) {
          diags.push(imp('error', 'import.ue.temporaryLinkTypeMismatch', `temporary Use Everywhere link ${linkId} has type '${String(linkType)}', not '${manifestType}'`))
        }
      }
      continue
    }
    wires.set(linkId, {
      fromNode,
      fromSlot: l[2],
      toNode,
      toSlot: l[4],
      ...(l[5] !== undefined ? { type: l[5] as Json } : {}),
    })
  }
  for (const id of temporaryLinks) {
    if (presentLinkIds.has(id) && !claimedTemporaryLinks.has(id)) {
      diags.push(imp('error', 'import.ue.temporaryLinkUnclaimed', `temporary Use Everywhere link ${id} does not match an extra.ue_links connection`))
    }
  }

  const byId = new Map<number, LgNode>()
  for (const n of rawNodes) {
    if (n?.id === undefined || typeof n?.type !== 'string') {
      diags.push(imp('warning', 'import.node.malformed', `skipping malformed node entry ${JSON.stringify(n).slice(0, 120)}`))
      continue
    }
    const nodeId = canonicalId(n.id)
    if (nodeId === undefined) {
      diags.push(imp('error', 'import.node.invalidId', `node ID ${String(n.id)} must be a safe non-negative integer`))
      continue
    }
    if (byId.has(nodeId)) {
      diags.push(imp('error', 'import.node.duplicateId', `duplicate litegraph node ID ${nodeId}`))
      continue
    }
    if ((n.pos !== undefined && !isFinitePair(n.pos)) || (n.size !== undefined && !isFinitePair(n.size))) {
      diags.push(imp('error', 'import.node.geometry', `node ${nodeId} ('${n.type}') has a non-finite or malformed position or size`))
      continue
    }
    byId.set(nodeId, nodeId === n.id ? n : { ...n, id: nodeId })
  }
  for (const node of byId.values()) {
    const ueConvert = node.properties?.['ue_convert']
    if (ueConvert !== undefined && typeof ueConvert !== 'boolean') {
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `node ${node.id} has non-boolean ue_convert state`))
    }
  }
  if (
    manifest === undefined &&
    temporaryLinks.size === 0 &&
    [...byId.values()].some(isUeController)
  ) {
    diags.push(imp('error', 'import.ue.manifestMissing', 'Use Everywhere broadcasters require the authoritative extra.ue_links manifest'))
  }

  const ueControllerIds = new Set<number>()
  const droppedUeControllerIds = new Set<number>()
  const authoredWires = [...wires.entries()]
  const invalidConvertedControllers = new Set<number>()
  for (const controller of byId.values()) {
    if (controller.properties?.['ue_convert'] !== true) continue
    const ueProperties = controller.properties?.['ue_properties']
    if (ueProperties !== undefined && (ueProperties === null || typeof ueProperties !== 'object' || Array.isArray(ueProperties))) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has malformed ue_properties`))
      continue
    }
    const disabled = (ueProperties as JsonObject | undefined)?.['output_not_broadcasting']
    if (disabled !== undefined && (disabled === null || typeof disabled !== 'object' || Array.isArray(disabled))) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has malformed output_not_broadcasting state`))
      continue
    }
    if (disabled !== undefined && Object.values(disabled as JsonObject).some((value) => typeof value !== 'boolean')) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has non-boolean output_not_broadcasting state`))
      continue
    }
    const outputNames = (controller.outputs ?? []).map((output) => output.name)
    if (disabled !== undefined && Object.keys(disabled as JsonObject).some((name) =>
      outputNames.filter((outputName) => outputName === name).length !== 1)) {
      invalidConvertedControllers.add(controller.id)
      diags.push(imp('error', 'import.ue.controllerStateInvalid', `converted broadcaster ${controller.id} has stale or ambiguous output_not_broadcasting keys`))
    }
  }
  if (Array.isArray(manifest)) {
    for (const node of byId.values()) {
      if (!UE_CONTROLLER_TYPES.has(node.type)) continue
      ueControllerIds.add(node.id)
      if (node.type !== UE_SEED_CONTROLLER_TYPE) droppedUeControllerIds.add(node.id)
    }
    for (const controller of byId.values()) {
      if (!UE_INPUT_CONTROLLER_TYPES.has(controller.type)) continue
      if ((controller.inputs ?? []).some((input, slot) =>
        input.link !== null && input.link !== undefined && !isUeBroadcastInput(controller.type, slot))) {
        diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Use Everywhere controller ${controller.id} has a serialized link on a non-broadcast input`))
      }
      for (const [linkId, wire] of authoredWires) {
        if (wire.toNode === controller.id && !isUeBroadcastInput(controller.type, wire.toSlot)) {
          diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Use Everywhere controller ${controller.id} has an incoming ordinary link ${linkId} on non-broadcast input ${wire.toSlot}`))
        }
      }
      const declaredWires = (controller.inputs ?? []).flatMap((input, slot) =>
        isUeBroadcastInput(controller.type, slot) && input.link !== null && input.link !== undefined
          ? [{ linkId: input.link, slot }]
          : [],
      )
      const actualWires = authoredWires.filter(([, wire]) =>
        wire.toNode === controller.id && isUeBroadcastInput(controller.type, wire.toSlot),
      )
      const consistent = declaredWires.length === actualWires.length && declaredWires.every((declared) =>
        isId(declared.linkId) && actualWires.some(([linkId, wire]) =>
          linkId === declared.linkId && wire.toSlot === declared.slot),
      )
      if (!consistent) {
        diags.push(imp('error', 'import.ue.controllerStateInvalid', `Use Everywhere controller ${controller.id} broadcast inputs do not match their authored links`))
      }
    }
    for (const [linkId, wire] of [...wires]) {
      const source = byId.get(wire.fromNode)
      const target = byId.get(wire.toNode)
      if (source !== undefined && UE_INPUT_CONTROLLER_TYPES.has(source.type)) {
        diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Use Everywhere controller ${source.id} has an unsupported outgoing ordinary link ${linkId}`))
      }
      if (target !== undefined && UE_INPUT_CONTROLLER_TYPES.has(target.type)) {
        wires.delete(linkId)
        continue
      }
      if (target?.type === UE_SEED_CONTROLLER_TYPE) {
        diags.push(imp('error', 'import.ue.controllerWireUnsupported', `Seed Everywhere controller ${target.id} has an unsupported incoming ordinary link ${linkId}`))
      }
    }
  }

  const ueTargets = new Map<string, UeLink>()
  const wiredTargets = new Set([...wires.values()].map((wire) => `${wire.toNode}:${wire.toSlot}`))
  for (const entry of ueLinks) {
    const upstream = byId.get(entry.upstream)
    const downstream = byId.get(entry.downstream)
    const controller = byId.get(entry.controller)
    if (upstream === undefined || downstream === undefined || controller === undefined) {
      diags.push(imp('error', 'import.ue.nodeMissing', 'extra.ue_links references a missing producer, consumer, or controller node'))
      continue
    }
    if (!isUeController(controller)) {
      diags.push(imp('error', 'import.ue.controllerInvalid', `extra.ue_links controller ${entry.controller} is not a supported Use Everywhere controller`))
      continue
    }
    if (entry.upstream === entry.downstream) {
      diags.push(imp('error', 'import.ue.selfConnection', `extra.ue_links cannot connect node ${entry.upstream} to itself`))
      continue
    }
    const sourceType = upstream.outputs?.[entry.upstreamSlot]?.type
    if (sourceType !== undefined && (typeof sourceType !== 'string' || (sourceType !== '*' && sourceType !== entry.type))) {
      diags.push(imp('error', 'import.ue.sourceTypeMismatch', `extra.ue_links source ${entry.upstream}:${entry.upstreamSlot} has type '${String(sourceType)}', not '${entry.type}'`))
      continue
    }
    const targetType = downstream.inputs?.[entry.downstreamSlot]?.type
    if (targetType !== undefined && (typeof targetType !== 'string' || (targetType !== '*' && targetType !== entry.type))) {
      diags.push(imp('error', 'import.ue.targetTypeMismatch', `extra.ue_links target ${entry.downstream}:${entry.downstreamSlot} has type '${String(targetType)}', not '${entry.type}'`))
      continue
    }
    if (controller.type === UE_SEED_CONTROLLER_TYPE) {
      if (entry.controller !== entry.upstream || entry.upstreamSlot !== 0 || entry.type !== 'INT') {
        diags.push(imp('error', 'import.ue.controllerSourceMismatch', `Seed Everywhere controller ${entry.controller} must broadcast its own INT output 0`))
        continue
      }
    } else if (UE_INPUT_CONTROLLER_TYPES.has(controller.type)) {
      const sourceMatches = authoredWires.filter(([, wire]) =>
        wire.toNode === controller.id && isUeBroadcastInput(controller.type, wire.toSlot) &&
        wire.fromNode === entry.upstream && wire.fromSlot === entry.upstreamSlot,
      )
      if (sourceMatches.length !== 1) {
        diags.push(imp('error', 'import.ue.controllerSourceMismatch', `Use Everywhere controller ${entry.controller} must have exactly one broadcast input connected to source ${entry.upstream}:${entry.upstreamSlot}`))
        continue
      }
      const controllerLinkType = sourceMatches[0]![1].type
      if (controllerLinkType !== undefined &&
        (typeof controllerLinkType !== 'string' || (controllerLinkType !== '*' && controllerLinkType !== entry.type))) {
        diags.push(imp('error', 'import.ue.sourceTypeMismatch', `Use Everywhere controller ${entry.controller} input link has type '${String(controllerLinkType)}', not '${entry.type}'`))
        continue
      }
    } else {
      if (invalidConvertedControllers.has(controller.id)) continue
      if (entry.controller !== entry.upstream) {
        diags.push(imp('error', 'import.ue.controllerSourceMismatch', `converted broadcaster ${entry.controller} can only broadcast its own outputs`))
        continue
      }
      const outputName = controller.outputs?.[entry.upstreamSlot]?.name
      const outputNames = (controller.outputs ?? []).map((output) => output.name)
      if (typeof outputName !== 'string' || outputName.trim().length === 0 ||
        outputNames.filter((name) => name === outputName).length !== 1) {
        diags.push(imp('error', 'import.ue.controllerOutputInvalid', `converted broadcaster ${entry.controller} has no named output ${entry.upstreamSlot}`))
        continue
      }
      const ueProperties = controller.properties?.['ue_properties']
      const disabled = (ueProperties as JsonObject | undefined)?.['output_not_broadcasting']
      if (Boolean((disabled as JsonObject | undefined)?.[outputName])) {
        diags.push(imp('error', 'import.ue.controllerOutputDisabled', `converted broadcaster ${entry.controller} output '${outputName}' is disabled`))
        continue
      }
    }
    const key = `${entry.downstream}:${entry.downstreamSlot}`
    if (ueTargets.has(key)) {
      diags.push(imp('error', 'import.ue.targetDuplicate', `extra.ue_links assigns target ${key} more than once`))
      continue
    }
    if (wiredTargets.has(key)) {
      diags.push(imp('error', 'import.ue.targetConflict', `extra.ue_links target ${key} already has an ordinary connection`))
      continue
    }
    ueTargets.set(key, entry)
  }
  const groupPreparation = comfyGroups === undefined
    ? { prepared: new Map<number, StaticNodeDecode>(), sourceSchemas: new Map<number, NodeSchema>() }
    : collapseComfyGroups(byId, wires, comfyGroups, diags, shouldCollapseComfyGroup)
  const preparedGroupNodes = groupPreparation.prepared
  const importedNodeType = (node: LgNode): string =>
    node.type === UE_SEED_CONTROLLER_TYPE && ueControllerIds.has(node.id) ? 'PrimitiveInt' : node.type
  const resolveImported = (node: LgNode): NodeSchema | undefined =>
    preparedGroupNodes.has(node.id)
      ? comfyGroups?.groupSchemas.get(node.type)
      : groupPreparation.sourceSchemas.get(node.id) ?? resolve(importedNodeType(node))

  // -- Upstream resolution (net sources only) -----------------------------------
  // Named nets are port-only: a net's source must be a real producing output.
  // Resolving a SetNode's input therefore skips over reroutes and SetNode
  // passthroughs until it reaches either a real output or a GetNode (which
  // chains nets). Ordinary links do NOT use this; they keep reroutes
  // first-class via resolveFeed below.
  type Upstream =
    | { kind: 'origin'; node: number; slot: number }
    | { kind: 'net'; name: string }
    | { kind: 'valueSource'; id: number }

  const netName = (n: LgNode): string | undefined => {
    const v = Array.isArray(n.widgets_values) ? n.widgets_values[0] : undefined
    return typeof v === 'string' && v.trim().length > 0 ? v : undefined
  }

  const resolveUpstream = (linkId: number, seen: Set<number> = new Set()): Upstream | undefined => {
    const wire = wires.get(linkId)
    if (!wire) return undefined
    const src = byId.get(wire.fromNode)
    if (!src) return undefined
    if (GET_TYPES.has(src.type)) {
      const name = getNames.get(src.id)
      if (name === undefined) return undefined
      return { kind: 'net', name }
    }
    if (PRIMITIVE_TYPES.has(src.type)) {
      return { kind: 'valueSource', id: src.id }
    }
    if (!REROUTE_TYPES.has(src.type) && !SET_TYPES.has(src.type)) {
      return { kind: 'origin', node: wire.fromNode, slot: wire.fromSlot }
    }
    // Reroute or SetNode passthrough: continue through its single input.
    if (seen.has(wire.fromNode)) {
      if (SET_TYPES.has(src.type)) {
        diags.push(imp('error', 'import.net.cycle', `SetNode passthrough cycle at litegraph node ${wire.fromNode}`))
      } else {
        diags.push(imp('warning', 'import.reroute.cycle', `reroute cycle at litegraph node ${wire.fromNode}; dropping the connection`))
      }
      return undefined
    }
    seen.add(wire.fromNode)
    const inLink = src.inputs?.[0]?.link
    if (inLink === null || inLink === undefined) return undefined // dangling
    return resolveUpstream(inLink, seen)
  }

  // -- Set/Get -> named nets --------------------------------------------------
  // SetNode: input link + widgets_values[0] = name (the net's source).
  // GetNode: widgets_values[0] = name; its output links are the net's sinks.
  // A Set fed by a Get chains nets; the chain collapses to the real origin.
  const outputLinksMatch = (node: LgNode): boolean => {
    const declared = node.outputs?.[0]?.links
    if (declared !== undefined && declared !== null &&
      (!Array.isArray(declared) || declared.some((id) => !isId(id)) || new Set(declared).size !== declared.length)) return false
    const declaredIds = declared ?? []
    const actualIds = [...wires.entries()]
      .filter(([, wire]) => wire.fromNode === node.id && wire.fromSlot === 0)
      .map(([id]) => id)
    return declaredIds.length === actualIds.length && declaredIds.every((id) => actualIds.includes(id))
  }
  const setInputs = new Map<string, number>() // name -> input link id
  const setNodes = new Map<string, LgNode>()
  for (const n of byId.values()) {
    if (!SET_TYPES.has(n.type)) continue
    if (n.inputs?.length !== 1 || n.outputs?.length !== 1) {
      diags.push(imp('error', 'import.net.nodeInvalid', `SetNode ${n.id} must have exactly one input and one output`))
      continue
    }
    const name = netName(n)
    const inLink = n.inputs?.[0]?.link
    if (name === undefined || inLink === null || inLink === undefined) {
      diags.push(imp('error', 'import.net.danglingSet', `SetNode ${n.id} has no ${name === undefined ? 'name' : 'input'}`))
      continue
    }
    const inputWire = wires.get(inLink)
    const inputWires = [...wires.entries()].filter(([, wire]) => wire.toNode === n.id && wire.toSlot === 0)
    if (inputWire === undefined || inputWire.toNode !== n.id || inputWire.toSlot !== 0 ||
      inputWires.length !== 1 || inputWires[0]![0] !== inLink || !outputLinksMatch(n)) {
      diags.push(imp('error', 'import.net.wireInvalid', `SetNode ${n.id} serialized links do not exactly match its input and passthrough output wires`))
      continue
    }
    if (setInputs.has(name)) {
      diags.push(imp('error', 'import.net.duplicateSet', `multiple SetNodes named '${name}' make the source ambiguous`))
      continue
    }
    setInputs.set(name, inLink)
    setNodes.set(name, n)
  }

  const getNames = new Map<number, string>()
  const getNodes = new Map<string, LgNode[]>()
  for (const n of byId.values()) {
    if (!GET_TYPES.has(n.type)) continue
    if ((n.inputs?.length ?? 0) !== 0 || n.outputs?.length !== 1) {
      diags.push(imp('error', 'import.net.nodeInvalid', `GetNode ${n.id} must have no inputs and exactly one output`))
      continue
    }
    if (!outputLinksMatch(n)) {
      diags.push(imp('error', 'import.net.wireInvalid', `GetNode ${n.id} serialized output links do not exactly match its outgoing wires`))
      continue
    }
    const name = netName(n)
    if (name === undefined) {
      diags.push(imp('error', 'import.net.danglingGet', `GetNode ${n.id} has no name`))
      continue
    }
    getNames.set(n.id, name)
    const namedGets = getNodes.get(name) ?? []
    namedGets.push(n)
    getNodes.set(name, namedGets)
    if (!setInputs.has(name)) {
      diags.push(imp('error', 'import.net.danglingGet', `GetNode ${n.id} names '${name}', but no matching SetNode exists`))
    }
  }

  for (const [linkId, wire] of wires) {
    const source = byId.get(wire.fromNode)
    const target = byId.get(wire.toNode)
    if ((SET_TYPES.has(source?.type ?? '') || GET_TYPES.has(source?.type ?? '')) && wire.fromSlot !== 0) {
      diags.push(imp('error', 'import.net.wireInvalid', `Set/Get link ${linkId} uses unsupported output slot ${wire.fromSlot}`))
    }
    if (GET_TYPES.has(target?.type ?? '') || (SET_TYPES.has(target?.type ?? '') && wire.toSlot !== 0)) {
      diags.push(imp('error', 'import.net.wireInvalid', `Set/Get link ${linkId} uses unsupported input slot ${wire.toSlot}`))
    }
  }

  const setSources = new Map<string, { node: number; slot: number }>()
  // Nets are port-only: a net fed by a PrimitiveNode instead collapses into
  // direct value-source links to every sink (same delivered value).
  const netPrimitiveSources = new Map<string, number>() // name -> lg primitive id
  const resolveNetSource = (name: string, chain: Set<string>): { node: number; slot: number } | undefined => {
    const cached = setSources.get(name)
    if (cached) return cached
    if (netPrimitiveSources.has(name)) return undefined
    const inLink = setInputs.get(name)
    if (inLink === undefined) return undefined
    const up = resolveUpstream(inLink)
    if (up === undefined) return undefined
    if (up.kind === 'net') {
      if (chain.has(up.name)) {
        diags.push(imp('error', 'import.net.cycle', `Set/Get cycle through net '${name}'`))
        return undefined
      }
      chain.add(name)
      const src = resolveNetSource(up.name, chain)
      if (src) setSources.set(name, src)
      else if (netPrimitiveSources.has(up.name)) netPrimitiveSources.set(name, netPrimitiveSources.get(up.name)!)
      return src
    }
    if (up.kind === 'valueSource') {
      netPrimitiveSources.set(name, up.id)
      return undefined
    }
    const src = { node: up.node, slot: up.slot }
    setSources.set(name, src)
    return src
  }
  for (const name of setInputs.keys()) resolveNetSource(name, new Set())

  const concreteType = (value: Json | undefined): string | undefined =>
    typeof value === 'string' && value !== '*' && value.trim().length > 0 ? value : undefined
  const wiresBySource = new Map<number, LgWire[]>()
  for (const wire of wires.values()) {
    const outgoing = wiresBySource.get(wire.fromNode) ?? []
    outgoing.push(wire)
    wiresBySource.set(wire.fromNode, outgoing)
  }
  for (const [name, setNode] of setNodes) {
    const types = new Set<string>()
    let malformedType = false
    const addType = (value: Json | undefined) => {
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        malformedType = true
        return
      }
      const type = concreteType(value)
      if (type !== undefined) types.add(type)
    }
    const addUpstreamTypes = (linkId: number, seen: Set<number>) => {
      if (seen.has(linkId)) return
      seen.add(linkId)
      const wire = wires.get(linkId)
      if (wire === undefined) return
      addType(wire.type)
      const source = byId.get(wire.fromNode)
      if (source !== undefined && (REROUTE_TYPES.has(source.type) || SET_TYPES.has(source.type))) {
        const inputLink = source.inputs?.[0]?.link
        if (inputLink !== null && inputLink !== undefined) addUpstreamTypes(inputLink, seen)
      }
    }
    const addDownstreamTypes = (sourceId: number, seen: Set<number>) => {
      if (seen.has(sourceId)) return
      seen.add(sourceId)
      for (const wire of wiresBySource.get(sourceId) ?? []) {
        const target = byId.get(wire.toNode)
        addType(wire.type)
        addType(target?.inputs?.[wire.toSlot]?.type)
        if (target !== undefined && REROUTE_TYPES.has(target.type)) {
          for (const output of target.outputs ?? []) addType(output.type)
          addDownstreamTypes(target.id, seen)
        }
      }
    }
    addType(setNode.inputs?.[0]?.type)
    addType(setNode.outputs?.[0]?.type)
    addUpstreamTypes(setInputs.get(name)!, new Set())
    addDownstreamTypes(setNode.id, new Set())
    for (const getNode of getNodes.get(name) ?? []) {
      addType(getNode.outputs?.[0]?.type)
      addDownstreamTypes(getNode.id, new Set())
    }
    const source = setSources.get(name)
    if (source !== undefined) addType(byId.get(source.node)?.outputs?.[source.slot]?.type)
    const primitive = netPrimitiveSources.get(name)
    if (primitive !== undefined) addType(byId.get(primitive)?.outputs?.[0]?.type)
    if (malformedType) {
      diags.push(imp('error', 'import.net.typeMismatch', `Set/Get net '${name}' has a malformed serialized type`))
    } else if (types.size > 1) {
      diags.push(imp('error', 'import.net.typeMismatch', `Set/Get net '${name}' has conflicting serialized types: ${[...types].join(', ')}`))
    }
  }

  // -- Reroute classification ---------------------------------------------------
  // Legacy Reroute nodes survive as first-class reroutes, EXCEPT chains that
  // are ultimately fed by a GetNode: nets deliver straight to sinks (port-only
  // model), so a net-fed reroute has nothing to drive it. Those collapse into
  // direct net sinks. Cycles among reroutes are broken by dropping the driver
  // link that closes the cycle.
  type Feed =
    | { kind: 'port'; node: number; slot: number }
    | { kind: 'reroute'; id: number }
    | { kind: 'net'; name: string }
    | { kind: 'valueSource'; id: number }

  const droppedCycleLinks = new Set<number>()
  const rerouteFeed = new Map<number, Feed | undefined>()
  const classifying = new Set<number>()

  /** What actually feeds a litegraph link, with kept reroutes first-class. */
  const resolveFeed = (linkId: number, seenSets: Set<number>): Feed | undefined => {
    if (droppedCycleLinks.has(linkId)) return undefined
    const wire = wires.get(linkId)
    if (!wire) return undefined
    const src = byId.get(wire.fromNode)
    if (!src) return undefined
    if (GET_TYPES.has(src.type)) {
      const name = getNames.get(src.id)
      if (name === undefined) return undefined
      return { kind: 'net', name }
    }
    if (PRIMITIVE_TYPES.has(src.type)) {
      return { kind: 'valueSource', id: src.id }
    }
    if (REROUTE_TYPES.has(src.type)) {
      const feed = classifyReroute(src.id)
      if (feed?.kind === 'net') return feed // collapsed with its chain
      return { kind: 'reroute', id: src.id }
    }
    if (SET_TYPES.has(src.type)) {
      // SetNode passthrough output: transparent, continue through its input.
      if (seenSets.has(src.id)) {
        diags.push(imp('error', 'import.net.cycle', `SetNode passthrough cycle at litegraph node ${src.id}`))
        return undefined
      }
      seenSets.add(src.id)
      const inLink = src.inputs?.[0]?.link
      if (inLink === null || inLink === undefined) return undefined
      return resolveFeed(inLink, seenSets)
    }
    return { kind: 'port', node: wire.fromNode, slot: wire.fromSlot }
  }

  /** A reroute's upstream feed; undefined = undriven (still kept). */
  function classifyReroute(id: number): Feed | undefined {
    if (rerouteFeed.has(id)) return rerouteFeed.get(id)
    const n = byId.get(id)
    const inLink = n?.inputs?.[0]?.link
    if (classifying.has(id)) {
      // Cycle: break it by dropping this reroute's driver link. The reroute
      // itself survives, undriven.
      if (inLink !== null && inLink !== undefined) {
        droppedCycleLinks.add(inLink)
        diags.push(imp('warning', 'import.reroute.cycle', `reroute cycle at litegraph node ${id}; dropped its incoming connection to break it`))
      }
      rerouteFeed.set(id, undefined)
      return undefined
    }
    classifying.add(id)
    const feed = inLink === null || inLink === undefined ? undefined : resolveFeed(inLink, new Set())
    classifying.delete(id)
    rerouteFeed.set(id, feed)
    return feed
  }
  for (const n of byId.values()) if (REROUTE_TYPES.has(n.type)) classifyReroute(n.id)

  // Reroutes whose entire fan-out feeds SetNodes are absorbed by net
  // resolution (the net delivers straight from the real producer), so
  // materializing them would invent dangling producer->reroute branches.
  // Transitive: a chain feeding only Sets drops entirely; ANY real consumer
  // (directly or through a kept downstream reroute) keeps the junction. A
  // reroute with no outgoing wires at all stays: it is a visible endpoint
  // dot the author placed, not net plumbing.
  const rerouteOut = new Map<number, { toNode: number }[]>()
  for (const wire of wires.values()) {
    const src = byId.get(wire.fromNode)
    if (!src || !REROUTE_TYPES.has(src.type)) continue
    const outs = rerouteOut.get(src.id) ?? []
    outs.push({ toNode: wire.toNode })
    rerouteOut.set(src.id, outs)
  }
  const realFanout = new Map<number, boolean>()
  const hasRealFanout = (id: number, visiting: Set<number>): boolean => {
    const cached = realFanout.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return false
    visiting.add(id)
    let real = false
    for (const out of rerouteOut.get(id) ?? []) {
      const target = byId.get(out.toNode)
      if (!target) continue
      if (SET_TYPES.has(target.type) || GET_TYPES.has(target.type) || NOTE_TYPES.has(target.type)) continue
      if (REROUTE_TYPES.has(target.type)) {
        if (rerouteFeed.get(target.id)?.kind === 'net') continue // collapsed chain
        if (hasRealFanout(target.id, visiting)) {
          real = true
          break
        }
        continue
      }
      real = true
      break
    }
    visiting.delete(id)
    realFanout.set(id, real)
    return real
  }
  const absorbedReroutes = new Set<number>()
  for (const n of byId.values()) {
    if (!REROUTE_TYPES.has(n.type)) continue
    if (rerouteFeed.get(n.id)?.kind === 'net') continue // already collapsing
    const outs = rerouteOut.get(n.id) ?? []
    if (outs.length > 0 && !hasRealFanout(n.id, new Set())) absorbedReroutes.add(n.id)
  }

  // -- Nodes ------------------------------------------------------------------
  const nodes: Record<string, Json> = {}
  const viewNodes: Record<string, NodeViewState> = {}
  const importedInputEndpoints = new Map<number, Map<number, JsonObject>>()
  const importedOutputEndpoints = new Map<number, Map<number, JsonObject>>()
  let maxOrdinal = 0

  const posOf = (n: LgNode): { x: number; y: number } => {
    if (Array.isArray(n.pos) && typeof n.pos[0] === 'number' && typeof n.pos[1] === 'number') {
      return { x: n.pos[0], y: n.pos[1] }
    }
    // Some serializations store pos as {"0": x, "1": y}.
    const o = n.pos as Readonly<Record<string, number>> | undefined
    if (o && typeof o['0'] === 'number' && typeof o['1'] === 'number') return { x: o['0'], y: o['1'] }
    return { x: 0, y: 0 }
  }

  for (const n of byId.values()) {
    maxOrdinal = Math.max(maxOrdinal, n.id)
    if (REROUTE_TYPES.has(n.type) || SET_TYPES.has(n.type) || GET_TYPES.has(n.type) || droppedUeControllerIds.has(n.id)) continue
    if (PRIMITIVE_TYPES.has(n.type)) continue // materialized as value sources below
    if (NOTE_TYPES.has(n.type)) {
      const text = Array.isArray(n.widgets_values) ? n.widgets_values[0] : undefined
      const id = `n${n.id}`
      nodes[id] = {
        id,
        type: n.type === 'MarkdownNote' ? 'dinkster.markdown_note' : 'dinkster.note',
        virtual: true,
        values: { text: typeof text === 'string' ? text : '' },
        ...(n.title !== undefined ? { title: n.title } : {}),
      }
      const size = n.size
      const sizeObject = size as Readonly<Record<string, number>> | undefined
      const width = Array.isArray(size) ? size[0] : sizeObject?.['0']
      const height = Array.isArray(size) ? size[1] : sizeObject?.['1']
      viewNodes[id] = {
        position: posOf(n),
        ...(typeof width === 'number' && typeof height === 'number' ? { size: { width, height } } : {}),
        ...(typeof n.color === 'string' || typeof n.bgcolor === 'string' ? { color: n.color ?? n.bgcolor } : {}),
      }
      continue
    }

    const id = `n${n.id}`
    const schema = resolveImported(n)
    const preparedGroup = preparedGroupNodes.get(n.id)
    const values: Record<string, Json> = { ...preparedGroup?.values }
    const controllers: Record<string, ControllerMode> = { ...preparedGroup?.controllers }
    const dynamic: Record<string, Json> = {}
    const ext: Record<string, Json> = {}
    const preserveAliasSuffixes = schema !== undefined && isMaintainedAlias(n.type, schema)

    if (schema !== undefined) {
      const families = activeAutogrowFamilies(schema.items, dynamic)
      const discovered = discoverAutogrowMembers(n.inputs ?? [], families, preserveAliasSuffixes)
      for (const [familyPath, members] of discovered.order) {
        const minted = members
          .map((member) => /^m(\d{1,15})$/.exec(member)?.[1])
          .filter((suffix): suffix is string => suffix !== undefined)
          .map(Number)
        dynamic[familyPath] = {
          members,
          ...(minted.length > 0 ? { seq: Math.max(...minted) + 1 } : {}),
        }
      }
    }

    if (schema === undefined) {
      diags.push(imp('warning', 'import.schema.missing', `node ${n.id} ('${n.type}'): no such node type is installed; widget values kept raw for review`))
      if (n.widgets_values !== undefined) ext['importer.rawWidgetValues'] = n.widgets_values as Json
    } else if (preparedGroup === undefined && Array.isArray(n.widgets_values)) {
      const raw = n.widgets_values
      const state: PositionalWidgetDecode = { values, controllers, dynamic, index: 0, stopped: false }
      decodePositionalWidgets(schema.items, raw, state, '', `node ${n.id} ('${n.type}')`, diags)
      if (state.index < raw.length) {
        diags.push(imp('warning', 'import.widgets.excess', `node ${n.id} ('${n.type}'): ${raw.length - state.index} positional widget value(s) beyond the current schema; kept raw for review`))
        ext['importer.excessWidgetValues'] = raw.slice(state.index) as Json
      }
    } else if (preparedGroup === undefined && n.widgets_values !== undefined) {
      // Object form (newer serializations): traverse the current schema so
      // active DynamicCombo branch widgets receive the same normalization as
      // positional values. Park every unrecognized key for review.
      const known = new Set<string>()
      const state: PositionalWidgetDecode = { values, controllers, dynamic, index: 0, stopped: false }
      const keyed = n.widgets_values as Readonly<Record<string, Json>>
      decodeKeyedWidgets(
        schema.items,
        keyed,
        state,
        '',
        '',
        `node ${n.id} ('${n.type}')`,
        diags,
        known,
        preserveAliasSuffixes,
      )
      const unknown: Record<string, Json> = {}
      for (const [k, v] of Object.entries(keyed)) {
        if (!known.has(k)) unknown[k] = v as Json
      }
      if (Object.keys(unknown).length > 0) {
        diags.push(imp('warning', 'import.widgets.unknownKeys', `node ${n.id} ('${n.type}'): widget values for unknown inputs ${Object.keys(unknown).join(', ')}; kept raw for review`))
        ext['importer.unknownWidgetValues'] = unknown
      }
    }

    if (schema !== undefined) {
      const families = activeAutogrowFamilies(schema.items, dynamic)
      const targetedSlots = new Set<number>()
      for (const wire of wires.values()) if (wire.toNode === n.id) targetedSlots.add(wire.toSlot)
      for (const entry of ueLinks) if (entry.downstream === n.id) targetedSlots.add(entry.downstreamSlot)
      const endpoints = new Map<number, JsonObject>()
      const discovered = discoverAutogrowMembers(n.inputs ?? [], families, preserveAliasSuffixes)

      // LiteGraph inputs are an ordered array. This first-observation walk is
      // the identity policy: sparse/out-of-order foreign ordinals are labels,
      // never sorting keys (image2 before image0 becomes m0 then m1).
      for (const [slotIndex, input] of (n.inputs ?? []).entries()) {
        if (!targetedSlots.has(slotIndex) || typeof input.name !== 'string') continue
        const found = discovered.slots.get(slotIndex)
        if (found === undefined) {
          const candidates = families
            .map((family) => matchAutogrowWire(input.name!, family, preserveAliasSuffixes))
            .filter((candidate): candidate is AutogrowWireMatch => candidate !== undefined)
          const staticInput = schema.items.some((item) =>
            item.kind === 'input' && item.dynamic === undefined && item.id === input.name)
          const scoped = !staticInput && (
            preserveAliasSuffixes || families.some((family) => input.name!.startsWith(`${family.wirePath}.`))
          )
          if (scoped) {
            diags.push(imp(
              'warning',
              candidates.length === 0 ? 'import.dynamic.autogrowWireUnknown' : 'import.dynamic.autogrowWireAmbiguous',
              `node ${n.id} ('${n.type}'): linked input '${input.name}' does not identify exactly one declared Autogrow member; endpoint left unresolved`,
            ))
          }
          continue
        }

        const { match, memberId } = found
        const grouped = match.family.spec.template.length !== 1 || match.family.spec.template[0]!.dynamic !== undefined
        endpoints.set(slotIndex, match.family.spec.materialization === 'wire15'
          ? {
              node: `n${n.id}`,
              port: grouped
                ? joinValuePath(joinValuePath(match.family.statePath, memberId), match.slot.id)
                : joinValuePath(match.family.statePath, memberId),
            }
          : { node: `n${n.id}`, port: joinValuePath(match.family.statePath, match.slot.id), members: [memberId] })
      }

      for (const [familyPath, observedMembers] of discovered.order) {
        const family = families.find((candidate) => candidate.statePath === familyPath)!
        let members = [...observedMembers]
        if (family.spec.naming.kind === 'names' && family.spec.materialization !== 'wire15') {
          // Legacy elaboration derives API names from member ordinal. Retain
          // the declaration prefix through the furthest observed name so an
          // out-of-order 'right' link cannot silently lower as 'left'.
          const furthest = Math.max(...observedMembers.map((member) => family.spec.naming.kind === 'names'
            ? family.spec.naming.names.indexOf(member)
            : -1))
          members = family.spec.naming.names.slice(0, furthest + 1)
        }
        // Prefix-family members use the same minted m<N> identity namespace
        // as native documents. Persist its high-water mark at import time:
        // after every imported link is disconnected and the user explicitly
        // compacts, the next ghost must not recycle an imported member id.
        const mintedSuffixes = members
          .map((member) => /^m(\d{1,15})$/.exec(member)?.[1])
          .filter((suffix): suffix is string => suffix !== undefined)
          .map(Number)
        dynamic[familyPath] = {
          members,
          ...(mintedSuffixes.length > 0 ? { seq: Math.max(...mintedSuffixes) + 1 } : {}),
        }
      }
      const elaborated = elabInputsOf(elaborateInterface(schema, { values, dynamic } as Pick<NodeData, 'values' | 'dynamic'>))
      for (const [slot, input] of (n.inputs ?? []).entries()) {
        if (endpoints.has(slot)) continue
        const matches = elaborated.filter((item) => item.origin.kind === 'branch' && item.apiName === input.name)
        if (matches.length === 1) endpoints.set(slot, { node: id, ...matches[0]!.address } as unknown as JsonObject)
      }
      if (endpoints.size > 0) importedInputEndpoints.set(n.id, endpoints)
    }

    const linkedOutputSlots = new Set<number>()
    for (const wire of wires.values()) if (wire.fromNode === n.id) linkedOutputSlots.add(wire.fromSlot)
    for (const entry of ueLinks) if (entry.upstream === n.id) linkedOutputSlots.add(entry.upstreamSlot)
    const outputEndpoints = new Map<number, JsonObject>()
    const countFamilies = schema === undefined
      ? []
      : outputsOf(schema).filter((output): output is OutputSpec & { readonly dynamic: CountBoundOutputAutogrowSpec } =>
          output.dynamic?.kind === 'autogrow' && 'count' in output.dynamic)
    const familyCounts = new Map<string, number>()
    let familyMembers = 0
    let validFamilyCounts = true
    for (const family of countFamilies) {
      const count = values[family.dynamic.count.input]
      const min = family.dynamic.naming.min ?? 0
      const max = family.dynamic.naming.kind === 'prefix'
        ? family.dynamic.naming.max ?? DEFAULT_ELAB_BUDGET.maxMembers
        : DEFAULT_ELAB_BUDGET.maxMembers
      const countIsLinked = [...wires.values()].some((wire) =>
        wire.toNode === n.id && inputPortForSchema(n, wire.toSlot, schema!) === family.dynamic.count.input)
      if (
        !Number.isSafeInteger(count) ||
        (count as number) < 0 ||
        (count as number) < min ||
        (count as number) > max ||
        (count as number) > DEFAULT_ELAB_BUDGET.maxMembers ||
        countIsLinked ||
        family.dynamic.template.length !== 1 ||
        family.dynamic.template[0]!.dynamic !== undefined
      ) {
        validFamilyCounts = false
        continue
      }
      familyCounts.set(family.id, count as number)
      familyMembers += count as number
      if (familyMembers > DEFAULT_ELAB_BUDGET.maxMembers) validFamilyCounts = false
    }
    for (const slot of linkedOutputSlots) {
      const foreignOutput = n.outputs?.[slot]
      const foreignName = foreignOutput?.name
      if (typeof foreignName !== 'string' || foreignName.length === 0) {
        diags.push(imp(
          'error',
          'import.link.outputSlot',
          `node ${n.id} ('${n.type}'): linked output slot ${slot} has no serialized non-empty name`,
        ))
        continue
      }
      if (schema === undefined) {
        const occurrences = (n.outputs ?? []).filter((output) => output.name === foreignName).length
        if (occurrences !== 1) {
          diags.push(imp(
            'error',
            'import.link.outputSlot',
            `node ${n.id} ('${n.type}'): linked output '${foreignName}' is ambiguous without a schema`,
          ))
          continue
        }
        outputEndpoints.set(slot, { node: id, port: foreignName })
        continue
      }
      const family = outputsOf(schema).find((output): output is OutputSpec & { readonly dynamic: CountBoundOutputAutogrowSpec } =>
        output.dynamic?.kind === 'autogrow' &&
        'count' in output.dynamic &&
        foreignName.startsWith(`${output.id}.`))
      if (family !== undefined) {
        const suffix = foreignName.slice(family.id.length + 1)
        const canonical = /^(0|[1-9][0-9]*)$/.test(suffix) && Number.isSafeInteger(Number(suffix))
        const count = familyCounts.get(family.id)
        if (
          !canonical ||
          !validFamilyCounts ||
          count === undefined ||
          Number(suffix) >= count
        ) {
          diags.push(imp(
            'error',
            'import.link.outputSlot',
            `node ${n.id} ('${n.type}'): linked output '${foreignName}' is not a current member of '${family.id}'`,
          ))
          continue
        }
        outputEndpoints.set(slot, { node: id, port: family.id, members: [suffix] })
        continue
      }
      const staticPort = staticOutputPortForSchema(n, slot, schema, true)
      if (staticPort === undefined) {
        diags.push(imp(
          'error',
          'import.link.outputSlot',
          `node ${n.id} ('${n.type}'): linked output slot ${slot} ('${foreignName}') does not identify a declared output`,
        ))
        continue
      }
      outputEndpoints.set(slot, { node: id, port: staticPort })
    }
    if (outputEndpoints.size > 0) importedOutputEndpoints.set(n.id, outputEndpoints)

    const mode = n.mode === 2 ? 'muted' : n.mode === 4 ? 'bypassed' : undefined
    if (n.mode !== undefined && n.mode !== 0 && n.mode !== 1 && mode === undefined) {
      diags.push(imp('warning', 'import.node.mode', `node ${n.id} ('${n.type}'): unknown litegraph mode ${n.mode}; imported as active`))
    }
    const title = typeof n.title === 'string' && n.title !== (schema?.displayName ?? n.type) ? n.title : undefined

    nodes[id] = {
      id,
      type: schema?.type ?? n.type,
      values,
      ...(Object.keys(controllers).length > 0 ? { controllers } : {}),
      ...(Object.keys(dynamic).length > 0 ? { dynamic } : {}),
      ...(mode ? { mode } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(Object.keys(ext).length > 0 ? { ext } : {}),
    }
    viewNodes[id] = {
      position: posOf(n),
      ...(n.flags?.collapsed === true ? { collapsed: true } : {}),
    }
  }

  // -- Reroutes -----------------------------------------------------------------
  // Kept reroutes become first-class junctions (r{lgId}); positions land in
  // view state. Net-fed chains collapse into direct net sinks below.
  const reroutes: Record<string, Json> = {}
  const viewReroutes: Record<string, Json> = {}
  let netFedReroutes = 0
  for (const n of byId.values()) {
    if (!REROUTE_TYPES.has(n.type)) continue
    if (rerouteFeed.get(n.id)?.kind === 'net') {
      netFedReroutes++
      continue
    }
    if (absorbedReroutes.has(n.id)) continue
    const id = `r${n.id}`
    reroutes[id] = { id }
    viewReroutes[id] = { position: posOf(n) }
  }
  if (Object.keys(reroutes).length > 0) {
    diags.push(imp('info', 'import.reroute.converted', `${Object.keys(reroutes).length} Reroute node(s) imported as first-class reroutes`))
  }
  if (netFedReroutes > 0) {
    diags.push(imp('warning', 'import.reroute.netFed', `${netFedReroutes} Reroute node(s) fed by GetNodes collapsed into direct net connections (nets deliver straight to inputs)`))
  }
  if (absorbedReroutes.size > 0) {
    diags.push(imp('warning', 'import.reroute.absorbed', `${absorbedReroutes.size} Reroute node(s) feeding only SetNodes absorbed into their nets (nets deliver straight from the producing output)`))
  }

  // -- Value sources (legacy frontend PrimitiveNode) ------------------------------
  // widgets_values = [value, controllerMode?] once a widget was adopted. The
  // declared spec stays empty: the effective spec derives from consumers,
  // which is exactly the legacy adoption semantics - minus the mutation.
  const valueSources: Record<string, Json> = {}
  const viewValueSources: Record<string, Json> = {}
  const wiredSources = new Set<number>()
  for (const w of wires.values()) wiredSources.add(w.fromNode)
  let droppedPrimitives = 0
  for (const n of byId.values()) {
    if (!PRIMITIVE_TYPES.has(n.type)) continue
    const raw = Array.isArray(n.widgets_values) ? n.widgets_values : []
    if (raw.length === 0 && !wiredSources.has(n.id)) {
      // Never adopted a widget and drives nothing: there is no value to keep.
      droppedPrimitives++
      continue
    }
    const id = `v${n.id}`
    const mode = raw[1]
    const controller = typeof mode === 'string' && CONTROLLER_MODES.has(mode) ? (mode as ControllerMode) : undefined
    const title = typeof n.title === 'string' && n.title !== n.type && n.title !== 'Primitive' ? n.title : undefined
    valueSources[id] = {
      id,
      value: (raw.length > 0 ? raw[0] : null) as Json,
      ...(controller ? { controller } : {}),
      ...(title !== undefined ? { title } : {}),
    }
    viewValueSources[id] = { position: posOf(n) }
  }
  if (Object.keys(valueSources).length > 0) {
    diags.push(imp('info', 'import.primitive.converted', `${Object.keys(valueSources).length} PrimitiveNode(s) imported as value sources`))
  }
  if (droppedPrimitives > 0) {
    diags.push(imp('warning', 'import.primitive.dropped', `${droppedPrimitives} never-connected PrimitiveNode(s) had no value to keep; dropped`))
  }

  // -- Links --------------------------------------------------------------------
  // LiteGraph endpoint indices select entries in the serialized actual slot
  // arrays. Schemas interpret those entries by name; they never invent source
  // outputs from a declaration whose runtime arity may differ.
  const inPortId = (node: LgNode, slot: number): string | undefined => {
    const schema = resolveImported(node)
    const foreignInput = node.inputs?.[slot]
    if (foreignInput === undefined) return undefined
    return schema === undefined ? foreignInput.name : inputPortForSchema(node, slot, schema)
  }

  // Net feeds are handled by callers before link emission ever gets here.
  const fromEndpoint = (feed: Exclude<Feed, { kind: 'net' }>): JsonObject | undefined =>
    feed.kind === 'reroute'
      ? { reroute: `r${feed.id}` }
      : feed.kind === 'valueSource'
        ? { valueSource: `v${feed.id}` }
        : importedOutputEndpoints.get(feed.node)?.get(feed.slot)

  const links: Record<string, Json> = {}
  const netSinks = new Map<string, JsonObject[]>()
  for (const [lgId, wire] of wires) {
    maxOrdinal = Math.max(maxOrdinal, lgId)
    if (droppedCycleLinks.has(lgId)) continue // diagnosed during classification
    const toNode = byId.get(wire.toNode)
    const fromNode = byId.get(wire.fromNode)
    if (!toNode || !fromNode) {
      diags.push(imp('warning', 'import.link.dangling', `link ${lgId} references a missing node; dropped`))
      continue
    }
    // Links INTO sets/gets are absorbed by net resolution; notes never carry
    // data; primitives never consume (their legacy node has no inputs).
    // Links into KEPT reroutes are emitted as the reroute's driver.
    if (SET_TYPES.has(toNode.type) || GET_TYPES.has(toNode.type) || NOTE_TYPES.has(toNode.type) || PRIMITIVE_TYPES.has(toNode.type)) continue
    if (NOTE_TYPES.has(fromNode.type)) continue

    if (REROUTE_TYPES.has(toNode.type)) {
      if (rerouteFeed.get(toNode.id)?.kind === 'net') continue // collapsed chain
      if (absorbedReroutes.has(toNode.id)) continue // absorbed into a net
      const feed = resolveFeed(lgId, new Set())
      if (feed === undefined || feed.kind === 'net') continue // dangling / absorbed
      const from = fromEndpoint(feed)
      if (from === undefined) continue
      const id = `l${lgId}`
      links[id] = { id, from, to: { reroute: `r${toNode.id}` } }
      continue
    }

    const feed = resolveFeed(lgId, new Set())
    const toPort = inPortId(toNode, wire.toSlot)
    if (toPort === undefined) {
      if (feed?.kind === 'net' || SET_TYPES.has(fromNode.type)) {
        diags.push(imp('error', 'import.net.endpointUnavailable', `translated Set/Get link ${lgId} targets missing input slot ${wire.toNode}:${wire.toSlot}`))
      } else {
        diags.push(imp('warning', 'import.link.slot', `link ${lgId}: node ${wire.toNode} has no input slot ${wire.toSlot}; dropped`))
      }
      continue
    }
    const toEndpoint = importedInputEndpoints.get(wire.toNode)?.get(wire.toSlot) ?? { node: `n${wire.toNode}`, port: toPort }

    if (feed === undefined) continue // dangling sugar chain: nothing to connect

    if (feed.kind === 'net') {
      // Primitive-sourced nets collapse into direct value-source links
      // (nets are port-only; the delivered value is identical).
      const prim = netPrimitiveSources.get(feed.name)
      if (prim !== undefined) {
        const id = `l${lgId}`
        links[id] = { id, from: { valueSource: `v${prim}` }, to: toEndpoint }
        continue
      }
      // A sink of the named net (if its Set half resolved).
      if (!setSources.has(feed.name)) {
        continue
      }
      const sinks = netSinks.get(feed.name) ?? []
      sinks.push(toEndpoint)
      netSinks.set(feed.name, sinks)
      continue
    }

    const from = fromEndpoint(feed)
    if (from === undefined) continue
    const id = `l${lgId}`
    links[id] = { id, from, to: toEndpoint }
  }

  // -- Materialize nets ---------------------------------------------------------
  const nets: Record<string, Json> = {}
  let netCount = 0
  for (const name of setInputs.keys()) {
    if (!setSources.has(name) && !netPrimitiveSources.has(name)) {
      diags.push(imp('error', 'import.net.unresolved', `net '${name}' has no resolvable source`))
    }
  }
  if (netPrimitiveSources.size > 0) {
    diags.push(imp('info', 'import.net.primitiveSource', `${netPrimitiveSources.size} PrimitiveNode-fed Set/Get net(s) collapsed into direct value-source connections (nets are port-only)`))
  }
  for (const [name, src] of setSources) {
    const source = importedOutputEndpoints.get(src.node)?.get(src.slot)
    if (source === undefined) {
      diags.push(imp('error', 'import.net.endpointUnavailable', `Set/Get net '${name}' resolves to missing output slot ${src.node}:${src.slot}`))
      continue
    }
    maxOrdinal += 1
    const id = `net${maxOrdinal}`
    nets[id] = {
      id,
      name,
      source,
      sinks: netSinks.get(name) ?? [],
    }
    netCount++
  }
  if (netCount > 0) diags.push(imp('info', 'import.net.converted', `${netCount} Set/Get pair(s) converted to named nets`))

  const usedNetNames = new Set(Object.values(nets).map((net) => (net as JsonObject)['name']).filter((name): name is string => typeof name === 'string'))
  const ueGroups = new Map<string, { source: JsonObject; sinks: JsonObject[] }>()
  for (const entry of ueTargets.values()) {
    const source = importedOutputEndpoints.get(entry.upstream)?.get(entry.upstreamSlot)
    const targetNode = byId.get(entry.downstream)
    if (targetNode === undefined) {
      diags.push(imp('error', 'import.ue.endpointUnavailable', `extra.ue_links endpoint ${entry.upstream}:${entry.upstreamSlot} -> ${entry.downstream}:${entry.downstreamSlot} is unavailable`))
      continue
    }
    const targetPort = inPortId(targetNode, entry.downstreamSlot)
    const sink = importedInputEndpoints.get(entry.downstream)?.get(entry.downstreamSlot) ??
      (targetPort === undefined ? undefined : { node: `n${entry.downstream}`, port: targetPort })
    if (source === undefined || sink === undefined) {
      diags.push(imp('error', 'import.ue.endpointUnavailable', `extra.ue_links endpoint ${entry.upstream}:${entry.upstreamSlot} -> ${entry.downstream}:${entry.downstreamSlot} is unavailable`))
      continue
    }
    const key = canonicalJson(source)
    const group = ueGroups.get(key) ?? { source, sinks: [] }
    group.sinks.push(sink)
    ueGroups.set(key, group)
  }
  let ueIndex = 0
  for (const group of ueGroups.values()) {
    let name = `use_everywhere_${ueIndex++}`
    while (usedNetNames.has(name)) name = `use_everywhere_${ueIndex++}`
    usedNetNames.add(name)
    maxOrdinal += 1
    const id = `net${maxOrdinal}`
    nets[id] = { id, name, source: group.source, sinks: group.sinks }
  }
  if (ueGroups.size > 0) diags.push(imp('info', 'import.ue.converted', `${ueLinks.length} Use Everywhere connection(s) converted to ${ueGroups.size} named net(s)`))

  // -- Groups -------------------------------------------------------------------
  const groups: Record<string, GroupViewState> = {}
  if (Array.isArray(json['groups'])) {
    for (const [i, g] of (json['groups'] as readonly JsonObject[]).entries()) {
      const b = g['bounding']
      if (!Array.isArray(b) || b.length < 4 || b.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        diags.push(imp('warning', 'import.group.malformed', `group ${i} has no numeric bounding box; dropped`))
        continue
      }
      const id = `grp${i}`
      groups[id] = {
        id,
        title: typeof g['title'] === 'string' ? g['title'] : '',
        bounds: { x: b[0] as number, y: b[1] as number, width: b[2] as number, height: b[3] as number },
        ...(typeof g['color'] === 'string' ? { color: g['color'] } : {}),
      }
    }
  }
  // Native (non-node) litegraph reroutes live in extra.reroutes as pure
  // geometry waypoints; the links themselves are still direct node-to-node,
  // so dropping them loses layout only, never topology.
  if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) {
    const nativeReroutes = (extra as JsonObject)['reroutes']
    if (Array.isArray(nativeReroutes) && nativeReroutes.length > 0) {
      diags.push(imp('warning', 'import.reroute.nativeDropped', `${nativeReroutes.length} native reroute waypoint(s) (extra.reroutes) not translated yet; connections stay intact, only the waypoint geometry is lost`))
    }
  }

  // Deterministic lineage: same legacy JSON -> same lineage, so re-importing
  // the same file lands on the same tab/execution lineage.
  const lineageHash = fnv1a(JSON.stringify(json))

  const document = {
    format: 'dinkster-workflow',
    formatVersion: FORMAT_VERSION,
    lineage: `lg-${lineageHash}`,
    root: 'g0',
    graphs: {
      ...definitions,
      g0: {
        id: 'g0',
        name: 'imported',
        nodes,
        links,
        nets,
        reroutes,
        ...(Object.keys(valueSources).length > 0 ? { valueSources } : {}),
        nextOrdinal: maxOrdinal + 1,
      },
    },
    view: {
      graphs: {
        g0: {
          nodes: viewNodes,
          ...(Object.keys(viewReroutes).length > 0 ? { reroutes: viewReroutes } : {}),
          ...(Object.keys(viewValueSources).length > 0 ? { valueSources: viewValueSources } : {}),
          ...(Object.keys(groups).length > 0 ? { groups } : {}),
        },
      },
    },
  } as unknown as JsonObject

  // Error-level import diagnostics (e.g. untranslatable subgraph definitions)
  // block the import outright: a partially-translated workflow is corruption.
  if (diags.some((d) => d.severity === 'error')) return { diagnostics: diags }

  // Same gate as loadDocument: the importer's output gets no special trust.
  const shapeDiags = validateDocumentShape(document)
  const all = [...diags, ...shapeDiags]
  if (shapeDiags.some((d) => d.severity === 'error')) return { diagnostics: all }
  const doc = document as unknown as WorkflowDocument
  const invariantDiags = checkDocument(doc)
  all.push(...invariantDiags)
  if (invariantDiags.some((d) => d.severity === 'error')) return { diagnostics: all }
  // Same ownership contract as loadDocument (CO1): the result is a deep-
  // frozen owned copy, so consumers (stores, blueprint caches) can share it
  // without freezing caller state or carrying mutable importer scratch.
  const ownedDoc = ownJson(document)
  if (!ownedDoc.ok) {
    // Unreachable after ingress ownership + shape validation; keep it a
    // diagnostic, never a throw.
    return { diagnostics: [...all, imp('error', 'import.notJson', `translated document rejected: ${ownedDoc.reason}`)] }
  }
  return { document: ownedDoc.value as unknown as WorkflowDocument, diagnostics: all }
}
