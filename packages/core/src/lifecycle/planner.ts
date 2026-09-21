import type {
  BoundaryBinding,
  BoundaryItem,
  ControllerMode,
  DynamicPortState,
  ExtData,
  GraphDef,
  GraphViewState,
  GroupViewState,
  Json,
  JsonObject,
  NodeData,
  RegionContract,
  Vec2,
  WorkflowDocument,
} from '../format/document.js'
import { validateGraphDefShape, validateGraphViewShape } from '../format/validate.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import type { CommandInvocation } from '../commands/contract.js'
import { asGraphDefId, asNodeId, MAX_MEMBER_ORDINAL } from '../ids.js'
import {
  isPortEndpoint,
  isRerouteRef,
  isSelectorRef,
  isValueSourceRef,
  isWidgetTapRef,
  portRefKey,
  type LinkEndpoint,
  type PortRef,
  type WidgetTapRef,
} from '../ids.js'
import { canonicalJson, sha256Hex } from '../compile/hash.js'
import { subgraphDefIdOf } from '../invariants.js'
import { deriveBoundarySchema, memberHopsOf, resolveBoundaryRoute, type SchemaResolver } from '../schema/derive-boundary.js'
import { autogrowBounds, comboBranchValuePath, joinValuePath, type AutogrowSpec, type InputSpec, type InterfaceItem, type NodeSchema } from '../schema/model.js'
import { collectWire15MemberEvidence, DEFAULT_ELAB_BUDGET, elabKeyOf, valueKeyOf, type ElaboratedInput, type ElaboratedOrigin } from '../schema/elaborate.js'
import { effectiveWidgetDefault } from '../schema/widget-defaults.js'
import { decodeModePanelConfig, MODE_PANEL_TYPE } from '../surfaces/mode-panel.js'
import { matchBoundaryItem } from '../compile/crossing.js'
import { parseSelection, type SelectionTree } from '../schema/slot-selection.js'

export const LIFECYCLE_PLAN_VERSION = 'subgraph-lifecycle-plan-v2'

export type FlattenRouteKind = 'plain' | 'plainWidget' | 'widgetTap' | 'combo' | 'family' | 'specialized' | 'unresolved'

export interface FlattenBoundaryPlanEntry {
  readonly side: 'input' | 'output'
  readonly id: string
  readonly route: FlattenRouteKind
}

export interface FlattenSchemaPlan {
  readonly boundaryPlan: readonly FlattenBoundaryPlanEntry[]
  readonly statePlan: FlattenStatePlan
  /** Keyed by the authored document type, even when resolution returns a canonical alias target. */
  readonly schemaSnapshot: Readonly<Record<string, NodeSchema>>
  readonly schemaPlanDigest: string
}

export type FlattenStateRefusalCode =
  | 'subgraph.flatten.stateUnresolved'
  | 'subgraph.flatten.dormantStateUnsupported'
  | 'subgraph.flatten.nativeFamilyUnsupported'
  | 'subgraph.flatten.specializedSlotUnsupported'
  | 'subgraph.lifecycle.boundaryUnresolved'
  | 'subgraph.lifecycle.idExhausted'

export interface FlattenNodeStateSnapshot {
  readonly node: string
  readonly type: string
  readonly values: Readonly<Record<string, Json>>
  readonly controllers?: Readonly<Record<string, ControllerMode>>
  readonly dynamic?: Readonly<Record<string, DynamicPortState>>
}

export interface FlattenStateSource {
  readonly occurrence: FlattenNodeStateSnapshot
  readonly bodyNodes: readonly FlattenNodeStateSnapshot[]
}

export interface FlattenBoundaryStateRoute {
  readonly side: 'input' | 'output'
  readonly id: string
  readonly bindingCount: number
  readonly familyScopeIds: readonly string[]
  readonly addressIndexes: readonly number[]
}

export interface FlattenPortAddress {
  readonly port: string
  readonly members?: readonly string[]
}

export interface FlattenScopeStep {
  readonly construct: string
  readonly member: string
  readonly storage: 'memberState' | 'pathSegment'
}

export interface FlattenFamilyScopeRef {
  readonly construct: string
  readonly ancestors: readonly FlattenScopeStep[]
}

export interface FlattenFamilyScopeMap {
  readonly id: string
  readonly parent?: { readonly scope: string; readonly beforeMember: string; readonly afterMember: string }
  readonly source: FlattenFamilyScopeRef
  readonly target: FlattenFamilyScopeRef & { readonly node: string }
  readonly policy:
    | { readonly kind: 'ordinal'; readonly materialization: 'ordinary' | 'wire15'; readonly prefix: string; readonly min: number; readonly max: number }
    | { readonly kind: 'names'; readonly materialization: 'wire15'; readonly vocabulary: readonly string[]; readonly min: number; readonly max: number }
  readonly sourceMembers: readonly string[]
  readonly targetBefore: { readonly members: readonly string[]; readonly memberStateKeys: readonly string[]; readonly seq?: number }
  readonly members: readonly { readonly before: string; readonly after: string }[]
  readonly targetAfter: { readonly members: readonly string[]; readonly memberStateKeys: readonly string[]; readonly seq?: number }
}

export interface FlattenInputIdentity {
  readonly address: FlattenPortAddress
  readonly valueKey: string
  readonly origin: 'static' | 'member' | 'selector' | 'branch' | 'slot' | 'dependent'
}

export interface FlattenMappedTarget {
  readonly bindingIndex: number
  readonly binding: BoundaryBinding
  readonly input?: FlattenInputIdentity
}

export interface FlattenEnclosingBindingRewrite {
  readonly side: 'input' | 'output'
  readonly itemIndex: number
  readonly itemId: string
  readonly bindingIndex: number
  readonly before: BoundaryBinding
  readonly after: readonly BoundaryBinding[]
}

export interface FlattenAddressMapEntry {
  readonly side: 'input' | 'output'
  readonly boundaryId: string
  readonly before: FlattenPortAddress
  readonly uses: readonly ('endpoint' | 'value' | 'controller' | 'dynamic')[]
  readonly input?: FlattenInputIdentity
  readonly targets: readonly FlattenMappedTarget[]
}

export interface FlattenReadyStatePlan {
  readonly version: 'subgraph-flatten-state-plan-v1'
  readonly status: 'ready'
  readonly source: FlattenStateSource
  readonly nodes: readonly FlattenNodeStateSnapshot[]
  readonly familyScopes: readonly FlattenFamilyScopeMap[]
  readonly addresses: readonly FlattenAddressMapEntry[]
  readonly routes: readonly FlattenBoundaryStateRoute[]
  readonly enclosingRewrites: readonly FlattenEnclosingBindingRewrite[]
}

export interface FlattenRefusedStatePlan {
  readonly version: 'subgraph-flatten-state-plan-v1'
  readonly status: 'refused'
  readonly source: FlattenStateSource
  readonly refusal: {
    readonly code: FlattenStateRefusalCode
    readonly message: string
    readonly side?: 'input' | 'output'
    readonly boundaryId?: string
    readonly key?: string
    readonly address?: { readonly port: string; readonly members?: readonly string[] }
  }
}

export type FlattenStatePlan = FlattenReadyStatePlan | FlattenRefusedStatePlan

export interface FlattenStoredStateInventory {
  readonly valueKeys: readonly string[]
  readonly controllerKeys: readonly string[]
  readonly dynamicPaths: readonly string[]
  readonly portKeys: readonly string[]
}

export interface FlattenStoredPortEvidence {
  readonly key: string
  readonly side: 'input' | 'output'
  readonly use?: 'link' | 'net' | 'enclosing'
}

export type FlattenStoredStateWalk =
  | { readonly ok: true; readonly inventory: FlattenStoredStateInventory }
  | { readonly ok: false; readonly code: 'subgraph.flatten.stateUnresolved' | 'subgraph.flatten.nativeFamilyUnsupported'; readonly message: string }

/**
 * Inventories persisted state from schema declarations, including inactive
 * combo branches and every stored family member. It deliberately does not
 * call active interface elaboration.
 */
export function walkFlattenStoredState(
  node: Pick<NodeData, 'type' | 'values' | 'controllers' | 'dynamic'>,
  schema: NodeSchema,
  rawPortEvidence: readonly (string | FlattenStoredPortEvidence)[] = [],
  boundaryPlan?: readonly FlattenBoundaryPlanEntry[],
): FlattenStoredStateWalk {
  const portEvidence = rawPortEvidence.map((entry): FlattenStoredPortEvidence =>
    typeof entry === 'string' ? { key: entry, side: 'input' } : entry)
  const portKeys = portEvidence.map((entry) => entry.key)
  const valueKeys = Object.keys(node.values)
  const controllerKeys = Object.keys(node.controllers ?? {})
  const dynamicKeys = Object.keys(node.dynamic ?? {})
  const dynamicPaths: string[] = dynamicKeys.filter((key) => Object.keys(node.dynamic![key]!).length > 0)
  const allowedValues = new Set<string>()
  const allowedControllers = new Set<string>()
  const dynamicScopes = new WeakMap<object, Map<string, string>>()
  const allowedPorts = new Set<string>()
  const portRoutes = new Map<string, Set<string>>()
  const valueRoutes = new Map<string, Set<string>>()
  const routeIds = boundaryPlan === undefined ? undefined : new Set(boundaryPlan.map((route) => JSON.stringify([route.side, route.id])))
  let memberCount = 0
  let problem: string | undefined
  let problemCode: 'subgraph.flatten.stateUnresolved' | 'subgraph.flatten.nativeFamilyUnsupported' = 'subgraph.flatten.stateUnresolved'
  const fail = (message: string, code: typeof problemCode = 'subgraph.flatten.stateUnresolved'): void => {
    if (problem !== undefined) return
    problem = message
    problemCode = code
  }
  const visit = (
    entries: readonly InterfaceItem[],
    valuePrefix: string,
    memberIds: readonly string[],
    state: Readonly<Record<string, DynamicPortState>> | undefined,
    boundaryId?: string,
    boundarySide?: 'input' | 'output',
  ): void => {
    for (const entry of entries) {
      if (entry.kind === 'section') continue
      const path = joinValuePath(valuePrefix, entry.id)
      if (entry.dynamic === undefined) {
        const key = memberIds.length === 0 && valuePrefix === ''
          ? path
          : elabKeyOf({ port: path, ...(memberIds.length > 0 ? { members: memberIds as never } : {}) })
        if (allowedPorts.has(key)) fail(`${node.type}: schema address '${key}' is ambiguous`)
        allowedPorts.add(key)
        if (boundaryId !== undefined && boundarySide !== undefined) {
          const route = JSON.stringify([boundarySide, boundaryId])
          const owners = portRoutes.get(key) ?? new Set<string>()
          owners.add(route)
          portRoutes.set(key, owners)
          if (entry.kind === 'input') {
            const values = valueRoutes.get(key) ?? new Set<string>()
            values.add(route)
            valueRoutes.set(key, values)
          }
        }
        if (entry.kind === 'input') {
          allowedValues.add(key)
          if (entry.widget?.controller !== undefined) allowedControllers.add(key)
        }
        continue
      }
      const constructKey = memberIds.length === 0 ? path : elabKeyOf({ port: path, members: memberIds as never })
      if (state !== undefined) {
        const allowed = dynamicScopes.get(state as object) ?? new Map<string, string>()
        if (boundaryId !== undefined && boundarySide !== undefined) allowed.set(path, JSON.stringify([boundarySide, boundaryId]))
        dynamicScopes.set(state as object, allowed)
      }
      if (allowedPorts.has(constructKey)) fail(`${node.type}: schema address '${constructKey}' is ambiguous`)
      allowedPorts.add(constructKey)
      if (boundaryId !== undefined && boundarySide !== undefined) {
        const owners = portRoutes.get(constructKey) ?? new Set<string>()
        owners.add(JSON.stringify([boundarySide, boundaryId]))
        portRoutes.set(constructKey, owners)
      }
      const stored = state?.[path]
      if (entry.dynamic.kind === 'dynamicCombo') {
        if (stored?.members !== undefined || stored?.seq !== undefined || stored?.memberState !== undefined) {
          fail(`${node.type}.${path}: DynamicCombo state contains family-only fields`)
        }
        if (stored?.selected !== undefined && !entry.dynamic.options.some((option) => option.key === stored.selected)) {
          fail(`${node.type}.${path}: stored DynamicCombo selection '${stored.selected}' is not declared`)
        }
        for (const option of entry.dynamic.options) {
          visit(option.inputs, comboBranchValuePath(path, option.key), memberIds, state, boundaryId, boundarySide)
        }
        continue
      }
      if (entry.dynamic.kind === 'dynamicSlot') {
        if (stored?.members !== undefined || stored?.seq !== undefined || stored?.memberState !== undefined) {
          fail(`${node.type}.${path}: DynamicSlot state contains family-only fields`)
        }
        visit(entry.dynamic.inputs, path, memberIds, state, boundaryId, boundarySide)
        for (const variant of entry.dynamic.variants ?? []) {
          visit(variant.inputs, comboBranchValuePath(path, variant.key), memberIds, state, boundaryId, boundarySide)
        }
        continue
      }
      if (stored?.selected !== undefined) fail(`${node.type}.${path}: Autogrow state contains selection-only fields`)
      const storedMembers = stored?.members ?? []
      if (new Set(storedMembers).size !== storedMembers.length) fail(`${node.type}.${path}: stored family members collide`)
      const effectiveWire15 = boundarySide === 'input' && entry.dynamic.materialization === 'wire15'
      const members = effectiveWire15
        ? collectWire15MemberEvidence(path, storedMembers, valueKeys, portKeys, dynamicKeys)
        : storedMembers
      if (entry.dynamic.naming.kind === 'native' && (members.length > 0 || stored !== undefined)) {
        fail(`${node.type}.${path}: native free-suffix family state cannot be materialized`, 'subgraph.flatten.nativeFamilyUnsupported')
      }
      const { max } = autogrowBounds(entry.dynamic)
      if (storedMembers.length > max) fail(`${node.type}.${path}: stored family members exceed the family cap of ${max}`)
      memberCount += members.length
      if (memberCount > DEFAULT_ELAB_BUDGET.maxMembers) fail(`${node.type}: dynamic members exceed the ${DEFAULT_ELAB_BUDGET.maxMembers}-member budget`)
      for (const member of Object.keys(stored?.memberState ?? {})) {
        if (!storedMembers.includes(member as never)) fail(`${node.type}.${path}: memberState '${member}' is orphaned`)
      }
      for (const member of members) {
        if (effectiveWire15 && !/^[A-Za-z0-9_-]+$/.test(member)) {
          fail(`${node.type}.${path}: member suffix '${member}' is invalid`)
        }
        if (entry.dynamic.naming.kind === 'names' && !entry.dynamic.naming.names.includes(member)) {
          fail(`${node.type}.${path}: member suffix '${member}' is not in the declared names vocabulary`)
        }
        if (effectiveWire15) {
          const memberPath = joinValuePath(path, member)
          const singleLeaf = entry.dynamic.template.length === 1 && entry.dynamic.template[0]!.dynamic === undefined
          if (singleLeaf) {
            const key = memberPath
            if (allowedPorts.has(key)) fail(`${node.type}: schema address '${key}' is ambiguous`)
            allowedPorts.add(key)
            if (boundaryId !== undefined && boundarySide !== undefined) {
              const route = JSON.stringify([boundarySide, boundaryId])
              const owners = portRoutes.get(key) ?? new Set<string>()
              owners.add(route)
              portRoutes.set(key, owners)
              if (entry.kind === 'input') {
                const values = valueRoutes.get(key) ?? new Set<string>()
                values.add(route)
                valueRoutes.set(key, values)
              }
            }
            if (entry.kind === 'input') {
              allowedValues.add(key)
              if (entry.dynamic.template[0]!.widget?.controller !== undefined) allowedControllers.add(key)
            }
          } else {
            visit(entry.dynamic.template, memberPath, memberIds, node.dynamic, boundaryId, boundarySide)
          }
        } else {
          visit(entry.dynamic.template, path, [...memberIds, member], stored?.memberState?.[member], boundaryId, boundarySide)
        }
      }
    }
  }
  for (const entry of schema.items) {
    visit([entry], '', [], node.dynamic, entry.kind === 'section' ? undefined : entry.id,
      entry.kind === 'input' ? 'input' : entry.kind === 'output' ? 'output' : undefined)
  }
  const validateDynamic = (state: Readonly<Record<string, DynamicPortState>> | undefined, memberIds: readonly string[] = []): void => {
    for (const [key, record] of Object.entries(state ?? {})) {
      const route = dynamicScopes.get(state as object)?.get(key)
      if (route === undefined || routeIds !== undefined && !routeIds.has(route)) {
        fail(`${node.type}: dynamic state '${key}' has no schema-owned construct and boundary route in its stored scope`)
      }
      if (memberIds.length > 0 && Object.keys(record).length > 0) {
        dynamicPaths.push(elabKeyOf({ port: key, members: memberIds as never }))
      }
      for (const [member, nested] of Object.entries(record.memberState ?? {})) validateDynamic(nested, [...memberIds, member])
    }
  }
  for (const key of valueKeys) {
    if (!allowedValues.has(key)) fail(`${node.type}: stored value '${key}' has no schema-owned input`)
    const owners = valueRoutes.get(key)
    if (routeIds !== undefined && (owners?.size !== 1 || !routeIds.has([...owners][0]!))) fail(`${node.type}: stored value '${key}' has no unique boundary route`)
  }
  for (const key of controllerKeys) {
    if (!allowedValues.has(key) || !allowedControllers.has(key)) fail(`${node.type}: stored controller '${key}' has no controller-capable input`)
    const owners = valueRoutes.get(key)
    if (routeIds !== undefined && (owners?.size !== 1 || !routeIds.has([...owners][0]!))) fail(`${node.type}: stored controller '${key}' has no unique boundary route`)
  }
  for (const { key, side } of portEvidence) {
    if (!allowedPorts.has(key)) fail(`${node.type}: structural endpoint '${key}' has no schema-owned port`)
    const owners = portRoutes.get(key)
    if (routeIds !== undefined && (owners?.size !== 1 || !routeIds.has([...owners][0]!) || JSON.parse([...owners][0]!)[0] !== side)) {
      fail(`${node.type}: structural endpoint '${key}' has no unique boundary route`)
    }
  }
  if (allowedPorts.size > DEFAULT_ELAB_BUDGET.maxItems) fail(`${node.type}: schema descriptors exceed the ${DEFAULT_ELAB_BUDGET.maxItems}-item budget`)
  validateDynamic(node.dynamic)
  return problem === undefined
    ? { ok: true, inventory: { valueKeys, controllerKeys, dynamicPaths: [...new Set(dynamicPaths)], portKeys } }
    : { ok: false, code: problemCode, message: problem }
}

function occurrencePortEvidence(parent: GraphDef, nodeId: string): FlattenStoredPortEvidence[] {
  const evidence: FlattenStoredPortEvidence[] = []
  const add = (ref: PortRef, side: 'input' | 'output', use: 'link' | 'net' | 'enclosing'): void => {
    if (ref.node !== nodeId) return
    evidence.push({ key: elabKeyOf({ port: ref.port, ...(ref.members !== undefined ? { members: ref.members } : {}) }), side, use })
  }
  for (const link of Object.values(parent.links).sort((a, b) => compareStrings(a.id, b.id))) {
    if (isPortEndpoint(link.from)) add(link.from, 'output', 'link')
    if (isWidgetTapRef(link.from) && link.from.node === nodeId) evidence.push({ key: link.from.tap, side: 'input' })
    if (isPortEndpoint(link.to)) add(link.to, 'input', 'link')
  }
  for (const net of Object.values(parent.nets).sort((a, b) => compareStrings(a.id, b.id))) {
    if (isPortEndpoint(net.source)) add(net.source, 'output', 'net')
    for (const sink of net.sinks) if (isPortEndpoint(sink)) add(sink, 'input', 'net')
  }
  for (const [side, items] of [['input', parent.boundary?.inputs ?? []], ['output', parent.boundary?.outputs ?? []]] as const) {
    for (const item of items) {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.node !== nodeId) continue
        if (binding.kind === 'widgetTap') continue
        add({ node: binding.node, port: binding.port, ...(binding.members !== undefined ? { members: binding.members } : {}) }, side, 'enclosing')
      }
    }
  }
  return evidence
}

type WholeSelection = SelectionTree | 'all'

const validateSelection = (template: readonly InputSpec[], selection: SelectionTree): boolean => {
  const byId = new Map(template.map((entry) => [entry.id, entry]))
  for (const [id, child] of selection) {
    const entry = byId.get(id)
    if (entry === undefined) return false
    if (child !== 'all' && (entry.dynamic?.kind !== 'autogrow' || !validateSelection(entry.dynamic.template, child))) return false
  }
  return true
}

const projectSelectionToDescendant = (
  root: AutogrowSpec,
  boundaryId: string,
  addressPort: string,
  selection: WholeSelection,
): WholeSelection | undefined => {
  const rest = addressPort === boundaryId
    ? []
    : addressPort.startsWith(`${boundaryId}.`)
      ? addressPort.slice(boundaryId.length + 1).split('.')
      : undefined
  if (rest === undefined) return undefined
  let spec = root
  let projected = selection
  let index = 0
  while (index < rest.length) {
    if (spec.materialization === 'wire15') index++
    const slotId = rest[index++]
    if (slotId === undefined) return undefined
    const slot = spec.template.find((entry) => entry.id === slotId)
    if (slot?.dynamic?.kind !== 'autogrow') return undefined
    if (projected !== 'all') {
      const next = projected.get(slotId)
      if (next === undefined) return undefined
      projected = next
    }
    spec = slot.dynamic
  }
  return projected
}

const fullTemplateSelection = (template: readonly InputSpec[]): SelectionTree =>
  new Map(template.map((entry) => [entry.id, 'all' as const]))

const intersectSelection = (left: WholeSelection, right: WholeSelection): WholeSelection | undefined => {
  if (left === 'all') return right
  if (right === 'all') return left
  const result: SelectionTree = new Map()
  for (const [id, leftChild] of left) {
    const rightChild = right.get(id)
    if (rightChild === undefined) continue
    const child = intersectSelection(leftChild, rightChild)
    if (child !== undefined && (child === 'all' || child.size > 0)) result.set(id, child)
  }
  return result.size > 0 ? result : undefined
}

const selectionEntriesInTemplateOrder = (template: readonly InputSpec[], selection: SelectionTree): string[] | undefined => {
  const result: string[] = []
  const visit = (entries: readonly InputSpec[], tree: SelectionTree, prefix: string): boolean => {
    for (const entry of entries) {
      const child = tree.get(entry.id)
      if (child === undefined) continue
      const path = prefix === '' ? entry.id : `${prefix}.${entry.id}`
      if (child === 'all') result.push(path)
      else if (entry.dynamic?.kind !== 'autogrow' || !visit(entry.dynamic.template, child, path)) return false
    }
    return true
  }
  return visit(template, selection, '') ? result : undefined
}

export function classifyFlattenBindingRoute(
  binding: BoundaryBinding,
  schema: NodeSchema | undefined,
  expectedSide?: 'input' | 'output',
): FlattenRouteKind {
  if (binding.kind === 'widgetTap') return expectedSide === 'output' ? 'widgetTap' : 'unresolved'
  if (binding.kind === 'family' || (binding.members?.length ?? 0) > 0) return 'family'
  if (schema === undefined) return 'unresolved'
  const resolved = resolveBoundaryRoute(schema, binding, expectedSide)
  if (!resolved.ok) return 'unresolved'
  if (resolved.route.terminal.kind === 'family' || resolved.route.hops.some((hop) => hop.kind === 'member')) return 'family'
  if (resolved.route.hops.some((hop) => hop.kind === 'slot' || hop.kind === 'slotVariant')) return 'specialized'
  if (resolved.route.hops.some((hop) => hop.kind === 'combo')) return 'combo'
  const slot = resolved.route.terminal.kind === 'port' ? resolved.route.terminal.slot : undefined
  if (slot?.dynamic?.kind === 'autogrow') return 'family'
  if (slot?.dynamic?.kind === 'dynamicSlot') return 'specialized'
  if (slot?.dynamic?.kind === 'dynamicCombo') return 'combo'
  return slot?.kind === 'input' && slot.widget !== undefined ? 'plainWidget' : 'plain'
}

export function classifyFlattenBoundaryRoute(
  body: GraphDef,
  item: BoundaryItem,
  resolveSchema: SchemaResolver,
  expectedSide?: 'input' | 'output',
): FlattenRouteKind {
  const routes = [item.binds, ...(item.alsoBinds ?? [])].map((binding) => {
    const node = body.nodes[binding.node]
    return classifyFlattenBindingRoute(binding, node === undefined ? undefined : resolveSchema(node.type), expectedSide)
  })
  return routes.includes('specialized') ? 'specialized'
    : routes.includes('family') ? 'family'
      : routes.includes('combo') ? 'combo'
        : routes.includes('unresolved') ? 'unresolved'
          : routes[0] ?? 'unresolved'
}

export function planFlattenBoundaryRoutes(
  body: GraphDef,
  resolveSchema: SchemaResolver,
  occurrence: NodeData,
  parent: GraphDef,
): FlattenSchemaPlan {
  const schemaSnapshot: Record<string, NodeSchema> = {}
  for (const node of Object.values(body.nodes)) {
    const schema = resolveSchema(node.type)
    if (schema !== undefined) schemaSnapshot[node.type] = schema
  }
  const items = [
    ...(body.boundary?.inputs ?? []).map((item) => ({ side: 'input' as const, item })),
    ...(body.boundary?.outputs ?? []).map((item) => ({ side: 'output' as const, item })),
  ]
  const boundaryPlan = items.map(({ side, item }) => {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      const node = body.nodes[binding.node]
      const schema = node === undefined ? undefined : resolveSchema(node.type)
      if (node !== undefined && schema !== undefined) schemaSnapshot[node.type] = schema
    }
    return { side, id: item.id, route: classifyFlattenBoundaryRoute(body, item, resolveSchema, side) }
  })
  const statePlan = planFlattenState(body, occurrence, parent, resolveSchema, schemaSnapshot, boundaryPlan, occurrencePortEvidence(parent, occurrence.id))
  return {
    boundaryPlan,
    statePlan,
    schemaSnapshot,
    schemaPlanDigest: flattenSchemaPlanDigest(schemaSnapshot, boundaryPlan, statePlan),
  }
}

const stateSnapshot = (node: Pick<NodeData, 'id' | 'type' | 'values' | 'controllers' | 'dynamic'>): FlattenNodeStateSnapshot => ({
  node: node.id as string,
  type: node.type,
  values: structuredClone(node.values),
  ...(node.controllers !== undefined && Object.keys(node.controllers).length > 0 ? { controllers: structuredClone(node.controllers) } : {}),
  ...(node.dynamic !== undefined && Object.keys(node.dynamic).length > 0 ? { dynamic: structuredClone(node.dynamic) } : {}),
})

type MutableFlattenSnapshot = {
  node: string
  type: string
  values: Record<string, Json>
  controllers?: Record<string, ControllerMode>
  dynamic?: Record<string, DynamicPortState>
}

const highestCanonicalMemberSuffix = (ids: Iterable<string>): number => {
  let highest = -1
  for (const id of ids) {
    const match = /^m(\d{1,15})$/.exec(id)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

const addressKey = (address: FlattenPortAddress): string => elabKeyOf({
  port: address.port,
  ...(address.members !== undefined ? { members: address.members as never } : {}),
})

const inputIdentity = (
  address: FlattenPortAddress,
  spec: InputSpec,
  origin: FlattenInputIdentity['origin'],
): FlattenInputIdentity => {
  const elaboratedOrigin: ElaboratedOrigin = origin === 'static'
    ? { kind: 'static' }
    : origin === 'member'
      ? { kind: 'member', construct: address.port, ordinal: 0 }
      : origin === 'selector'
        ? { kind: 'selector', construct: address.port }
        : origin === 'branch'
          ? { kind: 'branch', construct: address.port, option: '' }
          : origin === 'slot'
            ? { kind: 'slot', construct: address.port }
            : { kind: 'dependent', construct: address.port }
  const elaborated: ElaboratedInput = {
    kind: 'input',
    address: { port: address.port as never, ...(address.members !== undefined ? { members: address.members as never } : {}) },
    spec: { ...spec, id: elabKeyOf({ port: address.port, ...(address.members !== undefined ? { members: address.members as never } : {}) }) },
    origin: elaboratedOrigin,
  }
  return { address, valueKey: valueKeyOf(elaborated), origin }
}

interface FamilyMaterializationContext {
  readonly boundaryId: string
  readonly side: 'input' | 'output'
  readonly targetNode: string
  readonly sourceNode: NodeData
  readonly target: MutableFlattenSnapshot
  readonly sourcePorts: readonly FlattenStoredPortEvidence[]
  readonly familyScopes: FlattenFamilyScopeMap[]
  readonly targetFamilySpecs: Map<string, AutogrowSpec>
  readonly entries: Map<string, FlattenAddressMapEntry>
  readonly binding: BoundaryBinding
  readonly bindingIndex: number
  readonly fail: (code: FlattenStateRefusalCode, message: string, address?: FlattenPortAddress) => void
  readonly budget: { memberCount: number; itemCount: number }
  readonly reservedValues: ReadonlySet<string>
  readonly reservedControllers: ReadonlySet<string>
  readonly reservedDynamic: ReadonlySet<string>
  readonly reservedEndpoints: ReadonlySet<string>
}

const destinationReserved = (ctx: FamilyMaterializationContext, address: FlattenPortAddress): boolean => {
  const key = addressKey(address)
  return ctx.reservedValues.has(key) || ctx.reservedControllers.has(key) ||
    ctx.reservedEndpoints.has(key) || ctx.reservedDynamic.has(key)
}

const storedFamilyBudget = (
  node: NodeData,
  schema: NodeSchema,
  endpointKeys: ReadonlySet<string>,
): { memberCount: number; itemCount: number } => {
  const budget = { memberCount: 0, itemCount: 0 }
  const visit = (
    entries: readonly InterfaceItem[],
    prefix: string,
    ancestors: readonly FlattenScopeStep[],
    side: 'input' | 'output',
  ): void => {
    for (const entry of entries) {
      if (entry.kind === 'section') continue
      budget.itemCount++
      const path = joinValuePath(prefix, entry.id)
      if (entry.dynamic?.kind === 'autogrow') {
        const state = scopeState(node.dynamic, ancestors, path)
        const effectiveWire15 = side === 'input' && entry.dynamic.materialization === 'wire15'
        const members = effectiveWire15
          ? collectWire15MemberEvidence(path, state?.members ?? [],
            [...Object.keys(node.values), ...Object.keys(node.controllers ?? {})].map((key) => key.split('#', 1)[0]!),
            [...endpointKeys].map((key) => key.split('#', 1)[0]!), Object.keys(node.dynamic ?? {}))
          : state?.members ?? []
        budget.memberCount += members.length
        for (const member of members) {
          const storage: FlattenScopeStep['storage'] = effectiveWire15 ? 'pathSegment' : 'memberState'
          visit(entry.dynamic.template, storage === 'pathSegment' ? joinValuePath(path, member) : path,
            [...ancestors, { construct: path, member, storage }], side)
        }
      } else if (entry.dynamic?.kind === 'dynamicCombo') {
        for (const option of entry.dynamic.options) visit(option.inputs, comboBranchValuePath(path, option.key), ancestors, side)
      } else if (entry.dynamic?.kind === 'dynamicSlot') {
        visit(entry.dynamic.inputs, path, ancestors, side)
        for (const variant of entry.dynamic.variants ?? []) visit(variant.inputs, comboBranchValuePath(path, variant.key), ancestors, side)
      }
    }
  }
  for (const entry of schema.items) {
    if (entry.kind !== 'section') visit([entry], '', [], entry.kind)
  }
  return budget
}

const dynamicIdentityInventory = (dynamic: Readonly<Record<string, DynamicPortState>> | undefined): Set<string> => {
  const result = new Set<string>()
  const visit = (scope: Readonly<Record<string, DynamicPortState>> | undefined, members: readonly string[]): void => {
    for (const [construct, state] of Object.entries(scope ?? {})) {
      result.add(addressKey({ port: construct, ...(members.length > 0 ? { members } : {}) }))
      for (const [member, nested] of Object.entries(state.memberState ?? {})) visit(nested, [...members, member])
    }
  }
  visit(dynamic, [])
  return result
}

const scopeState = (
  dynamic: Readonly<Record<string, DynamicPortState>> | undefined,
  ancestors: readonly FlattenScopeStep[],
  construct: string,
): DynamicPortState | undefined => {
  let scope = dynamic
  for (const step of ancestors) {
    scope = step.storage === 'pathSegment'
      ? dynamic
      : scope?.[step.construct]?.memberState?.[step.member]
  }
  return scope?.[construct]
}

const mutableScope = (
  dynamic: Record<string, DynamicPortState>,
  ancestors: readonly FlattenScopeStep[],
): Record<string, DynamicPortState> => {
  let scope = dynamic
  for (const step of ancestors) {
    if (step.storage === 'pathSegment') {
      scope = dynamic
      continue
    }
    const family = { ...(scope[step.construct] ?? {}) }
    const memberState = { ...(family.memberState ?? {}) }
    const child = { ...(memberState[step.member] ?? {}) }
    memberState[step.member] = child
    family.memberState = memberState
    scope[step.construct] = family
    scope = child
  }
  return scope
}

const addAddressTarget = (
  ctx: FamilyMaterializationContext,
  before: FlattenPortAddress,
  after: FlattenPortAddress,
  uses: readonly ('endpoint' | 'value' | 'controller' | 'dynamic')[],
  sourceInput?: FlattenInputIdentity,
  targetInput?: FlattenInputIdentity,
): void => {
  if (uses.length === 0) return
  const key = JSON.stringify([ctx.side, ctx.boundaryId, addressKey(before)])
  const target: FlattenMappedTarget = {
    bindingIndex: ctx.bindingIndex,
    binding: {
      kind: 'port',
      node: ctx.binding.node,
      port: after.port as never,
      ...(after.members !== undefined && after.members.length > 0 ? { members: after.members as never } : {}),
    },
    ...(targetInput !== undefined ? { input: targetInput } : {}),
  }
  const existing = ctx.entries.get(key)
  if (existing === undefined) {
    ctx.entries.set(key, {
      side: ctx.side,
      boundaryId: ctx.boundaryId,
      before,
      uses: [...new Set(uses)],
      ...(sourceInput !== undefined ? { input: sourceInput } : {}),
      targets: [target],
    })
    return
  }
  if (canonicalJson(existing.before) !== canonicalJson(before) ||
      canonicalJson(existing.input) !== canonicalJson(sourceInput) ||
      existing.targets.some((candidate) => candidate.bindingIndex === ctx.bindingIndex)) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' produces a colliding address map`, before)
    return
  }
  ctx.entries.set(key, {
    ...existing,
    uses: [...new Set([...existing.uses, ...uses])],
    targets: [...existing.targets, target],
  })
}

function materializeFamilyScope(
  ctx: FamilyMaterializationContext,
  sourceSpec: AutogrowSpec,
  targetSpec: AutogrowSpec,
  sourceRef: FlattenFamilyScopeRef,
  targetRef: FlattenFamilyScopeRef,
  sourceAddress: FlattenPortAddress,
  targetAddress: FlattenPortAddress,
  parent?: { scope: string; beforeMember: string; afterMember: string },
): void {
  const targetSpecKey = JSON.stringify([ctx.targetNode, addressKey(targetAddress)])
  const previousTargetSpec = ctx.targetFamilySpecs.get(targetSpecKey)
  if (previousTargetSpec !== undefined && canonicalJson(previousTargetSpec) !== canonicalJson(targetSpec)) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' has an ambiguous target family coordinate`, targetAddress)
    return
  }
  ctx.targetFamilySpecs.set(targetSpecKey, targetSpec)
  const sourceWire15 = ctx.side === 'input' && sourceSpec.materialization === 'wire15'
  const targetWire15 = ctx.side === 'input' && targetSpec.materialization === 'wire15'
  if (sourceRef.ancestors.length + 1 > 16 || targetRef.ancestors.length + 1 > 16) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' exceeds the dynamic-state depth cap`, sourceAddress)
    return
  }
  const sourceState = scopeState(ctx.sourceNode.dynamic, sourceRef.ancestors, sourceRef.construct)
  const sourceMembers = sourceWire15
    ? collectWire15MemberEvidence(
      sourceRef.construct,
      sourceState?.members ?? [],
      Object.keys(ctx.sourceNode.values),
      ctx.sourcePorts.map((entry) => entry.key),
      Object.keys(ctx.sourceNode.dynamic ?? {}),
    )
    : sourceState?.members ?? []
  const targetDynamic = ctx.target.dynamic ?? (ctx.target.dynamic = {})
  const targetScope = mutableScope(targetDynamic, targetRef.ancestors)
  const targetState = targetScope[targetRef.construct]
  const targetStoredMembers = targetState?.members ?? []
  const targetBeforeMembers = targetWire15
    ? collectWire15MemberEvidence(targetRef.construct, targetStoredMembers,
      [...Object.keys(ctx.target.values), ...Object.keys(ctx.target.controllers ?? {})].map((key) => key.split('#', 1)[0]!),
      [...ctx.reservedEndpoints].map((key) => key.split('#', 1)[0]!), Object.keys(ctx.target.dynamic ?? {}))
    : targetStoredMembers
  const targetMembers = [...targetBeforeMembers]
  const sourceStateKeys = Object.keys(sourceState?.memberState ?? {}).sort(compareStrings)
  const targetStateKeys = Object.keys(targetState?.memberState ?? {}).sort(compareStrings)
  const unique = (members: readonly string[]): boolean => new Set(members).size === members.length
  if ([...sourceMembers, ...sourceStateKeys, ...targetMembers, ...targetStateKeys].some((member) => member.includes(String.fromCharCode(0)))) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' contains a NUL family identity`, sourceAddress)
    return
  }
  if (parent !== undefined && destinationReserved(ctx, targetAddress)) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' collides with a definition-owned destination`, targetAddress)
    return
  }
  if (!unique(sourceMembers) || !unique(sourceStateKeys) || !unique(targetStoredMembers) || !unique(targetStateKeys) ||
      sourceStateKeys.some((member) => !sourceMembers.includes(member)) ||
      targetStateKeys.some((member) => !targetStoredMembers.includes(member))) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' has duplicate or orphan family state at '${sourceRef.construct}'`, sourceAddress)
    return
  }
  if (sourceSpec.naming.kind === 'native' || targetSpec.naming.kind === 'native') {
    if (sourceMembers.length > 0 || sourceState !== undefined) {
      ctx.fail('subgraph.flatten.nativeFamilyUnsupported', `boundary '${ctx.boundaryId}' uses native free-suffix family state`, sourceAddress)
    }
    return
  }
  const sourceBounds = autogrowBounds(sourceSpec)
  const targetBounds = autogrowBounds(targetSpec)
  if (sourceMembers.length > sourceBounds.max || targetBeforeMembers.length > targetBounds.max ||
      targetBeforeMembers.length + sourceMembers.length > targetBounds.max) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' exceeds a family member cap`, sourceAddress)
    return
  }
  ctx.budget.memberCount += sourceMembers.length
  if (ctx.budget.memberCount > DEFAULT_ELAB_BUDGET.maxMembers) {
    ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' exceeds the persisted member budget`, sourceAddress)
    return
  }
  const id = `family-${ctx.familyScopes.length}`
  const mappings: { before: string; after: string }[] = []
  let next = Math.max(targetState?.seq ?? 0, highestCanonicalMemberSuffix([...targetMembers, ...targetStateKeys]) + 1)
  for (const before of sourceMembers) {
    let after: string
    if (targetWire15 && targetSpec.naming.kind === 'names') {
      if (!targetSpec.naming.names.includes(before) || targetMembers.includes(before) || targetStateKeys.includes(before)) {
        ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' has an invalid or colliding names-family suffix '${before}'`, sourceAddress)
        return
      }
      after = before
    } else {
      if (next > MAX_MEMBER_ORDINAL) {
        ctx.fail('subgraph.lifecycle.idExhausted', `boundary '${ctx.boundaryId}' exhausted dynamic member identity space`, sourceAddress)
        return
      }
      after = `m${next++}`
      if (targetMembers.includes(after) || targetStateKeys.includes(after)) {
        ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' generated colliding member '${after}'`, sourceAddress)
        return
      }
    }
    mappings.push({ before, after })
    targetMembers.push(after)
  }
  const nextState: DynamicPortState = {
    ...(targetState ?? {}),
    members: targetMembers as never,
    ...(!(targetWire15 && targetSpec.naming.kind === 'names') ? { seq: next } : {}),
  }
  targetScope[targetRef.construct] = nextState
  const policy: FlattenFamilyScopeMap['policy'] = targetWire15 && targetSpec.naming.kind === 'names'
    ? { kind: 'names', materialization: 'wire15', vocabulary: [...targetSpec.naming.names], min: targetBounds.min, max: targetBounds.max }
    : {
        kind: 'ordinal',
        materialization: targetWire15 ? 'wire15' : 'ordinary',
        prefix: targetSpec.naming.kind === 'prefix' ? targetSpec.naming.prefix : '',
        min: targetBounds.min,
        max: targetBounds.max,
      }
  const scopeMap: FlattenFamilyScopeMap = {
    id,
    ...(parent !== undefined ? { parent } : {}),
    source: sourceRef,
    target: { ...targetRef, node: ctx.targetNode },
    policy,
    sourceMembers,
    targetBefore: {
      members: targetBeforeMembers,
      memberStateKeys: targetStateKeys,
      ...(targetState?.seq !== undefined ? { seq: targetState.seq } : {}),
    },
    members: mappings,
    targetAfter: {
      members: targetMembers,
      memberStateKeys: Object.keys(nextState.memberState ?? {}).sort(compareStrings),
      ...(nextState.seq !== undefined ? { seq: nextState.seq } : {}),
    },
  }
  ctx.familyScopes.push(scopeMap)
  addAddressTarget(ctx, sourceAddress, targetAddress, [
    'dynamic',
    ...(ctx.sourcePorts.some((entry) => entry.side === ctx.side && entry.key === addressKey(sourceAddress)) ? ['endpoint' as const] : []),
  ])

  const visitEntries = (
    sourceEntries: readonly InputSpec[],
    targetEntries: readonly InputSpec[],
    sourcePrefix: string,
    targetPrefix: string,
    sourceMembersPath: readonly string[],
    targetMembersPath: readonly string[],
    sourceAncestors: readonly FlattenScopeStep[],
    targetAncestors: readonly FlattenScopeStep[],
    origin: FlattenInputIdentity['origin'],
    collapseSourceLeaf = false,
    collapseTargetLeaf = false,
  ): void => {
    for (const sourceEntry of sourceEntries) {
      const targetEntry = targetEntries.find((entry) => entry.id === sourceEntry.id)
      if (targetEntry === undefined || sourceEntry.dynamic?.kind !== targetEntry.dynamic?.kind) {
        ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' family templates do not compose`, sourceAddress)
        return
      }
      ctx.budget.itemCount++
      if (ctx.budget.itemCount > DEFAULT_ELAB_BUDGET.maxItems) {
        ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' exceeds the persisted item budget`, sourceAddress)
        return
      }
      const sourcePath = collapseSourceLeaf && sourceEntries.length === 1 && sourceEntry.dynamic === undefined
        ? sourcePrefix
        : joinValuePath(sourcePrefix, sourceEntry.id)
      const targetPath = collapseTargetLeaf && targetEntries.length === 1 && targetEntry.dynamic === undefined
        ? targetPrefix
        : joinValuePath(targetPrefix, targetEntry.id)
      if (sourceEntry.dynamic?.kind === 'autogrow' && targetEntry.dynamic?.kind === 'autogrow') {
        materializeFamilyScope(
          ctx,
          sourceEntry.dynamic,
          targetEntry.dynamic,
          { construct: sourcePath, ancestors: sourceAncestors },
          { construct: targetPath, ancestors: targetAncestors },
          { port: sourcePath, ...(sourceMembersPath.length > 0 ? { members: sourceMembersPath } : {}) },
          { port: targetPath, ...(targetMembersPath.length > 0 ? { members: targetMembersPath } : {}) },
          { scope: id, beforeMember: sourceAncestors.at(-1)?.member ?? '', afterMember: targetAncestors.at(-1)?.member ?? '' },
        )
        continue
      }
      if (sourceEntry.dynamic?.kind === 'dynamicCombo' && targetEntry.dynamic?.kind === 'dynamicCombo') {
        const sourceSelection = scopeState(ctx.sourceNode.dynamic, sourceAncestors, sourcePath)?.selected
        if (sourceSelection !== undefined && !targetEntry.dynamic.options.some((option) => option.key === sourceSelection)) {
          ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' has an unknown nested combo selection`, { port: sourcePath })
          return
        }
        const targetDynamicAddress = { port: targetPath, ...(targetMembersPath.length > 0 ? { members: targetMembersPath } : {}) }
        if (destinationReserved(ctx, targetDynamicAddress)) {
          ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' collides with a definition-owned destination`, targetDynamicAddress)
          return
        }
        if (sourceSelection !== undefined) {
          const targetDynamicScope = mutableScope(targetDynamic, targetAncestors)
          targetDynamicScope[targetPath] = { ...(targetDynamicScope[targetPath] ?? {}), selected: sourceSelection }
          addAddressTarget(ctx, { port: sourcePath, ...(sourceMembersPath.length > 0 ? { members: sourceMembersPath } : {}) },
            { port: targetPath, ...(targetMembersPath.length > 0 ? { members: targetMembersPath } : {}) }, ['dynamic'])
        }
        for (const [optionIndex, sourceOption] of sourceEntry.dynamic.options.entries()) {
          const targetOption = targetEntry.dynamic.options[optionIndex]
          if (targetOption === undefined || sourceOption.key !== targetOption.key) {
            ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' combo templates do not compose`, { port: sourcePath })
            return
          }
          visitEntries(sourceOption.inputs, targetOption.inputs,
            comboBranchValuePath(sourcePath, sourceOption.key), comboBranchValuePath(targetPath, targetOption.key),
            sourceMembersPath, targetMembersPath, sourceAncestors, targetAncestors, 'branch')
        }
        continue
      }
      if (sourceEntry.dynamic?.kind === 'dynamicSlot' && targetEntry.dynamic?.kind === 'dynamicSlot') {
        const sourceSelection = scopeState(ctx.sourceNode.dynamic, sourceAncestors, sourcePath)?.selected
        const targetDynamicAddress = { port: targetPath, ...(targetMembersPath.length > 0 ? { members: targetMembersPath } : {}) }
        if (destinationReserved(ctx, targetDynamicAddress)) {
          ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' collides with a definition-owned destination`, targetDynamicAddress)
          return
        }
        if (sourceSelection !== undefined) {
          const targetDynamicScope = mutableScope(targetDynamic, targetAncestors)
          targetDynamicScope[targetPath] = { ...(targetDynamicScope[targetPath] ?? {}), selected: sourceSelection }
          addAddressTarget(ctx, { port: sourcePath, ...(sourceMembersPath.length > 0 ? { members: sourceMembersPath } : {}) },
            { port: targetPath, ...(targetMembersPath.length > 0 ? { members: targetMembersPath } : {}) }, ['dynamic'])
        }
        visitEntries(sourceEntry.dynamic.inputs, targetEntry.dynamic.inputs, sourcePath, targetPath,
          sourceMembersPath, targetMembersPath, sourceAncestors, targetAncestors, 'dependent')
        for (const [variantIndex, sourceVariant] of (sourceEntry.dynamic.variants ?? []).entries()) {
          const targetVariant = targetEntry.dynamic.variants?.[variantIndex]
          if (targetVariant === undefined || sourceVariant.key !== targetVariant.key) {
            ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' slot templates do not compose`, { port: sourcePath })
            return
          }
          visitEntries(sourceVariant.inputs, targetVariant.inputs,
            comboBranchValuePath(sourcePath, sourceVariant.key), comboBranchValuePath(targetPath, targetVariant.key),
            sourceMembersPath, targetMembersPath, sourceAncestors, targetAncestors, 'dependent')
        }
        continue
      }
      if (sourceEntry.dynamic !== undefined || targetEntry.dynamic !== undefined) {
        ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' family templates do not compose`, { port: sourcePath })
        return
      }
      const before = { port: sourcePath, ...(sourceMembersPath.length > 0 ? { members: sourceMembersPath } : {}) }
      const after = { port: targetPath, ...(targetMembersPath.length > 0 ? { members: targetMembersPath } : {}) }
      const sourceInput = ctx.side === 'input' ? inputIdentity(before, sourceEntry, origin) : undefined
      const targetInput = ctx.side === 'input' ? inputIdentity(after, targetEntry, origin) : undefined
      const uses: ('endpoint' | 'value' | 'controller')[] = []
      if (ctx.sourcePorts.some((entry) => entry.side === ctx.side && entry.key === addressKey(before))) uses.push('endpoint')
      if (sourceInput !== undefined && Object.hasOwn(ctx.sourceNode.values, sourceInput.valueKey)) uses.push('value')
      if (sourceInput !== undefined && Object.hasOwn(ctx.sourceNode.controllers ?? {}, sourceInput.valueKey)) uses.push('controller')
      addAddressTarget(ctx, before, after, uses, sourceInput, targetInput)
      if (destinationReserved(ctx, after) || targetInput !== undefined &&
          (ctx.reservedValues.has(targetInput.valueKey) || ctx.reservedControllers.has(targetInput.valueKey))) {
        ctx.fail('subgraph.flatten.stateUnresolved', `boundary '${ctx.boundaryId}' collides with a definition-owned destination`, after)
        return
      }
      if (sourceInput !== undefined && targetInput !== undefined) {
        if (Object.hasOwn(ctx.sourceNode.values, sourceInput.valueKey)) {
          ctx.target.values[targetInput.valueKey] = ctx.sourceNode.values[sourceInput.valueKey]!
        }
        if (Object.hasOwn(ctx.sourceNode.controllers ?? {}, sourceInput.valueKey)) {
          ctx.target.controllers = { ...(ctx.target.controllers ?? {}), [targetInput.valueKey]: ctx.sourceNode.controllers![sourceInput.valueKey]! }
        }
      }
    }
  }

  for (const mapping of mappings) {
    const sourceStorage: FlattenScopeStep['storage'] = sourceWire15 ? 'pathSegment' : 'memberState'
    const targetStorage: FlattenScopeStep['storage'] = targetWire15 ? 'pathSegment' : 'memberState'
    const sourceChildAncestors = [...sourceRef.ancestors, { construct: sourceRef.construct, member: mapping.before, storage: sourceStorage }]
    const targetChildAncestors = [...targetRef.ancestors, { construct: targetRef.construct, member: mapping.after, storage: targetStorage }]
    const sourceChildPrefix = sourceStorage === 'pathSegment' ? joinValuePath(sourceRef.construct, mapping.before) : sourceRef.construct
    const targetChildPrefix = targetStorage === 'pathSegment' ? joinValuePath(targetRef.construct, mapping.after) : targetRef.construct
    const sourceMemberPath = sourceStorage === 'memberState' ? [...(sourceAddress.members ?? []), mapping.before] : sourceAddress.members ?? []
    const targetMemberPath = targetStorage === 'memberState' ? [...(targetAddress.members ?? []), mapping.after] : targetAddress.members ?? []
    visitEntries(sourceSpec.template, targetSpec.template, sourceChildPrefix, targetChildPrefix,
      sourceMemberPath, targetMemberPath, sourceChildAncestors, targetChildAncestors, 'member', sourceWire15, targetWire15)
  }
  const scopeIndex = ctx.familyScopes.findIndex((entry) => entry.id === id)
  ctx.familyScopes[scopeIndex] = {
    ...scopeMap,
    targetAfter: {
      members: targetScope[targetRef.construct]?.members ?? [],
      memberStateKeys: Object.keys(targetScope[targetRef.construct]?.memberState ?? {}).sort(compareStrings),
      ...(targetScope[targetRef.construct]?.seq !== undefined ? { seq: targetScope[targetRef.construct]!.seq } : {}),
    },
  }
}

function planFlattenState(
  body: GraphDef,
  occurrence: NodeData,
  parent: GraphDef,
  resolveSchema: SchemaResolver,
  schemaSnapshot: Record<string, NodeSchema>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  occurrencePorts: readonly FlattenStoredPortEvidence[],
): FlattenStatePlan {
  const bodyNodes = Object.values(body.nodes).sort((a, b) => compareStrings(a.id, b.id)).map(stateSnapshot)
  const source: FlattenStateSource = {
    occurrence: stateSnapshot(occurrence),
    bodyNodes,
  }
  const nodes = new Map(bodyNodes.map((node) => [node.node, structuredClone(node) as MutableFlattenSnapshot]))
  const routes: Array<{
    side: 'input' | 'output'
    id: string
    bindingCount: number
    familyScopeIds: string[]
    addressIndexes: number[]
  }> = []
  const familyScopes: FlattenFamilyScopeMap[] = []
  const targetFamilySpecs = new Map<string, AutogrowSpec>()
  const addressEntries = new Map<string, FlattenAddressMapEntry>()
  const familyBudgets = new Map<string, { memberCount: number; itemCount: number }>()
  const reservedEndpoints = new Map<string, Set<string>>()
  const reserveEndpoint = (ref: PortRef): void => {
    const endpoints = reservedEndpoints.get(ref.node) ?? new Set<string>()
    endpoints.add(addressKey({ port: ref.port, ...(ref.members !== undefined ? { members: ref.members } : {}) }))
    reservedEndpoints.set(ref.node, endpoints)
  }
  for (const link of Object.values(body.links)) {
    if (isPortEndpoint(link.from)) reserveEndpoint(link.from)
    if (isPortEndpoint(link.to)) reserveEndpoint(link.to)
  }
  for (const net of Object.values(body.nets)) {
    reserveEndpoint(net.source)
    for (const sink of net.sinks) reserveEndpoint(sink)
  }
  let refusal: FlattenRefusedStatePlan['refusal'] | undefined
  const items = [
    ...(body.boundary?.inputs ?? []).map((item) => ({ side: 'input' as const, item })),
    ...(body.boundary?.outputs ?? []).map((item) => ({ side: 'output' as const, item })),
  ]
  const fail = (code: FlattenStateRefusalCode, message: string, side?: 'input' | 'output', boundaryId?: string, key?: string, address?: FlattenPortAddress): void => {
    if (refusal === undefined) refusal = {
      code,
      message,
      ...(side !== undefined ? { side } : {}),
      ...(boundaryId !== undefined ? { boundaryId } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(address !== undefined ? { address } : {}),
    }
  }

  const occurrenceSchema = deriveBoundarySchema(body, resolveSchema)

  for (const [{ side, item }, routePlan] of items.map((item, index) => [item, boundaryPlan[index]!] as const)) {
    const stateRoute: {
      side: 'input' | 'output'
      id: string
      bindingCount: number
      familyScopeIds: string[]
      addressIndexes: number[]
    } = {
      side,
      id: item.id,
      bindingCount: 1 + (item.alsoBinds?.length ?? 0),
      familyScopeIds: [],
      addressIndexes: [],
    }
    routes.push(stateRoute)
    if (routePlan.route === 'widgetTap') continue
    if (routePlan.route === 'family') {
      const nativeTarget = [item.binds, ...(item.alsoBinds ?? [])].some((binding) => {
        const node = body.nodes[binding.node]
        const schema = node === undefined ? undefined : resolveSchema(node.type)
        const resolved = schema === undefined ? undefined : resolveBoundaryRoute(schema, binding, side)
        return resolved?.ok === true && resolved.route.terminal.kind === 'family' && resolved.route.terminal.spec.naming.kind === 'native'
      })
      const familyHasEvidence = Object.hasOwn(occurrence.dynamic ?? {}, item.id) ||
        Object.keys(occurrence.values).some((key) => key.startsWith(`${item.id}.`)) ||
        occurrencePorts.some((entry) => entry.key === item.id || entry.key.startsWith(`${item.id}.`) || entry.key.startsWith(`${item.id}#`))
      if (nativeTarget && familyHasEvidence) {
        fail('subgraph.flatten.nativeFamilyUnsupported', `boundary '${item.id}' uses native free-suffix family state`, side, item.id)
        continue
      }
      const sourceInterfaceItem = occurrenceSchema.schema?.items.find((entry) =>
        entry.kind !== 'section' && entry.id === item.id)
      const sourceItem = sourceInterfaceItem?.kind === 'section' ? undefined : sourceInterfaceItem
      if (sourceItem?.dynamic?.kind !== 'autogrow') {
        if (sourceItem === undefined) {
          fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has no derived source family`, side, item.id)
          continue
        }
        const before = { port: item.id }
        for (const [bindingIndex, binding] of [item.binds, ...(item.alsoBinds ?? [])].entries()) {
          const original = body.nodes[binding.node]
          const target = original === undefined ? undefined : nodes.get(original.id as string)
          const schema = original === undefined ? undefined : resolveSchema(original.type)
          const resolved = schema === undefined ? undefined : resolveBoundaryRoute(schema, binding, side)
          if (original === undefined || target === undefined || resolved?.ok !== true || resolved.route.terminal.kind !== 'port' ||
              memberHopsOf(resolved.route.hops).length === 0) {
            fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has an unresolved concrete member target`, side, item.id)
            continue
          }
          const targetAncestors: FlattenScopeStep[] = []
          let ancestorValid = true
          for (const hop of resolved.route.hops) {
            if (hop.kind !== 'member') continue
            const state = scopeState(original.dynamic, targetAncestors, hop.familyPath)
            if (!state?.members?.includes(hop.member)) {
              fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' names an absent target ancestor member`, side, item.id)
              ancestorValid = false
              break
            }
            targetAncestors.push({
              construct: hop.familyPath,
              member: hop.member,
              storage: side === 'input' && hop.spec.materialization === 'wire15' ? 'pathSegment' : 'memberState',
            })
          }
          if (!ancestorValid) continue
          const after = { port: binding.port as string, members: binding.members as readonly string[] }
          const sourceInput = side === 'input' && sourceItem.kind === 'input' ? inputIdentity(before, sourceItem, 'static') : undefined
          const targetInput = side === 'input' ? inputIdentity(after, resolved.route.terminal.slot as InputSpec, 'member') : undefined
          const uses: ('endpoint' | 'value' | 'controller')[] = []
          if (occurrencePorts.some((entry) => entry.side === side && entry.key === addressKey(before))) uses.push('endpoint')
          if (sourceInput !== undefined && Object.hasOwn(occurrence.values, sourceInput.valueKey)) uses.push('value')
          if (sourceInput !== undefined && Object.hasOwn(occurrence.controllers ?? {}, sourceInput.valueKey)) uses.push('controller')
          const endpointReservations = reservedEndpoints.get(original.id) ?? new Set<string>()
          if (uses.length > 0 && (targetInput !== undefined &&
              (Object.hasOwn(original.values, targetInput.valueKey) || Object.hasOwn(original.controllers ?? {}, targetInput.valueKey)) ||
              endpointReservations.has(addressKey(after)) || dynamicIdentityInventory(original.dynamic).has(addressKey(after)))) {
            fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' collides with a definition-owned destination`, side, item.id)
            continue
          }
          if (sourceInput !== undefined && targetInput !== undefined && uses.includes('value')) {
            target.values[targetInput.valueKey] = occurrence.values[sourceInput.valueKey]!
          }
          if (sourceInput !== undefined && targetInput !== undefined && uses.includes('controller')) {
            target.controllers = { ...(target.controllers ?? {}), [targetInput.valueKey]: occurrence.controllers![sourceInput.valueKey]! }
          }
          addAddressTarget({
            boundaryId: item.id, side, targetNode: original.id, sourceNode: occurrence, target,
            sourcePorts: occurrencePorts, familyScopes, targetFamilySpecs, entries: addressEntries, binding, bindingIndex,
            fail: (code, message, address) => fail(code, message, side, item.id, undefined, address),
            budget: { memberCount: 0, itemCount: 0 },
            reservedValues: new Set(), reservedControllers: new Set(), reservedDynamic: new Set(), reservedEndpoints: endpointReservations,
          }, before, after, uses, sourceInput, targetInput)
        }
        continue
      }
      for (const [bindingIndex, binding] of [item.binds, ...(item.alsoBinds ?? [])].entries()) {
        const original = body.nodes[binding.node]
        const target = original === undefined ? undefined : nodes.get(original.id as string)
        const schema = original === undefined ? undefined : resolveSchema(original.type)
        const resolved = schema === undefined ? undefined : resolveBoundaryRoute(schema, binding, side)
        if (original === undefined || target === undefined || schema === undefined || resolved?.ok !== true || resolved.route.terminal.kind !== 'family') {
          fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has an unresolved family target`, side, item.id)
          continue
        }
        if (resolved.route.hops.some((hop) => hop.kind === 'slot' || hop.kind === 'slotVariant')) {
          fail('subgraph.flatten.specializedSlotUnsupported', `boundary '${item.id}' uses direct specialized-slot forwarding`, side, item.id)
          continue
        }
        const targetAncestors: FlattenScopeStep[] = []
        let missingAncestor: string | undefined
        for (const hop of memberHopsOf(resolved.route.hops)) {
          const state = scopeState(original.dynamic, targetAncestors, hop.familyPath)
          if (!state?.members?.includes(hop.member)) {
            missingAncestor = hop.member
            break
          }
          targetAncestors.push({
            construct: hop.familyPath,
            member: hop.member,
            storage: side === 'input' && hop.spec.materialization === 'wire15' ? 'pathSegment' : 'memberState',
          })
        }
        if (missingAncestor !== undefined) {
          fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' targets missing ancestor member '${missingAncestor}'`, side, item.id)
          continue
        }
        schemaSnapshot[original.type] = schema
        const beforeScopeCount = familyScopes.length
        let budget = familyBudgets.get(original.id)
        if (budget === undefined) {
          budget = storedFamilyBudget(original, schema, reservedEndpoints.get(original.id) ?? new Set<string>())
          familyBudgets.set(original.id, budget)
        }
        if (budget.memberCount > DEFAULT_ELAB_BUDGET.maxMembers || budget.itemCount > DEFAULT_ELAB_BUDGET.maxItems) {
          fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' target exceeds persisted state budgets`, side, item.id)
          continue
        }
        materializeFamilyScope({
          boundaryId: item.id,
          side,
          targetNode: original.id,
          sourceNode: occurrence,
          target,
          sourcePorts: occurrencePorts,
          familyScopes,
          targetFamilySpecs,
          entries: addressEntries,
          binding,
          bindingIndex,
          fail: (code, message, address) => fail(code, message, side, item.id, undefined, address),
          budget,
          reservedValues: new Set(Object.keys(original.values)),
          reservedControllers: new Set(Object.keys(original.controllers ?? {})),
          reservedDynamic: dynamicIdentityInventory(original.dynamic),
          reservedEndpoints: reservedEndpoints.get(original.id) ?? new Set<string>(),
        }, sourceItem.dynamic, resolved.route.terminal.spec,
        { construct: item.id, ancestors: [] },
        {
          construct: resolved.route.terminal.familyPath,
          ancestors: targetAncestors,
        },
        { port: item.id },
        {
          port: resolved.route.terminal.familyPath,
          ...(binding.members !== undefined ? { members: binding.members } : {}),
        })
        stateRoute.familyScopeIds.push(...familyScopes.slice(beforeScopeCount).map((scope) => scope.id))
      }
      continue
    }
    if (routePlan.route === 'specialized') {
      fail('subgraph.flatten.specializedSlotUnsupported', `boundary '${item.id}' uses direct specialized-slot forwarding`, side, item.id)
      continue
    }
    if (routePlan.route === 'unresolved') {
      fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has no unique schema interpretation`, side, item.id)
      continue
    }
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      const original = body.nodes[binding.node]
      const schema = original === undefined ? undefined : resolveSchema(original.type)
      const target = original === undefined ? undefined : nodes.get(original.id as string)
      if (original === undefined || target === undefined || schema === undefined) {
        fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has an unresolved target`, side, item.id)
        continue
      }
      schemaSnapshot[original.type] = schema
      const resolved = resolveBoundaryRoute(schema, binding, side)
      if (!resolved.ok) {
        fail('subgraph.flatten.stateUnresolved', resolved.message, side, item.id)
        continue
      }
      if (resolved.route.hops.some((hop) => hop.kind === 'slot' || hop.kind === 'slotVariant') ||
          resolved.route.terminal.kind === 'port' && resolved.route.terminal.slot.dynamic?.kind === 'dynamicSlot') {
        fail('subgraph.flatten.specializedSlotUnsupported', `boundary '${item.id}' uses direct specialized-slot forwarding`, side, item.id)
      }
      const combo = resolved.route.terminal.kind === 'port' && resolved.route.terminal.slot.dynamic?.kind === 'dynamicCombo'
        ? resolved.route.terminal.slot.dynamic
        : undefined
      const selected = occurrence.dynamic?.[item.id]?.selected
      if (combo !== undefined && selected !== undefined) {
        if (!combo.options.some((option) => option.key === selected)) {
          fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' selects unknown DynamicCombo option '${selected}'`, side, item.id)
        } else {
          target.dynamic = { ...(target.dynamic ?? {}), [binding.port as string]: { ...(target.dynamic?.[binding.port as string] ?? {}), selected } }
        }
      }
    }
  }

  const inputItems = new Map((body.boundary?.inputs ?? []).map((item) => [item.id, item]))
  if (occurrenceSchema.schema !== undefined) {
    const walked = walkFlattenStoredState(occurrence, occurrenceSchema.schema, occurrencePorts, boundaryPlan)
    if (!walked.ok) {
      fail(walked.code, walked.message)
    } else {
      const mappedDynamicPaths = new Set([...addressEntries.values()]
        .filter((entry) => entry.uses.includes('dynamic'))
        .map((entry) => addressKey(entry.before)))
      for (const route of boundaryPlan) {
        if (route.route === 'combo' && occurrence.dynamic?.[route.id] !== undefined) {
          mappedDynamicPaths.add(route.id)
        }
      }
      for (const path of walked.inventory.dynamicPaths) {
        if (!mappedDynamicPaths.has(path)) {
          fail('subgraph.flatten.stateUnresolved', `occurrence dynamic state '${path}' has no eligible flattened owner`)
        }
      }
    }
  } else fail('subgraph.lifecycle.boundaryUnresolved', 'body boundary cannot be derived into one occurrence schema')

  const stateKeys = new Set([...Object.keys(occurrence.values), ...Object.keys(occurrence.controllers ?? {})])
  const mappedStateKeys = new Set([...addressEntries.values()].flatMap((entry) =>
    entry.input !== undefined && (entry.uses.includes('value') || entry.uses.includes('controller')) ? [entry.input.valueKey] : []))
  for (const key of stateKeys) {
    if (mappedStateKeys.has(key)) continue
    const item = inputItems.get(key)
    if (item === undefined || item.promoted !== true) {
      fail(item !== undefined && item.promoted !== true
        ? 'subgraph.flatten.dormantStateUnsupported'
        : 'subgraph.flatten.stateUnresolved', `occurrence state '${key}' has no eligible flattened owner`, 'input', item?.id, key)
    }
  }

  const familyInputIds = new Set(boundaryPlan.filter((route) => route.side === 'input' && route.route === 'family').map((route) => route.id))
  for (const item of body.boundary?.inputs ?? []) {
    if (item.promoted !== true || familyInputIds.has(item.id)) continue
    const targets = [item.binds, ...(item.alsoBinds ?? [])]
    const primaryBinding = targets[0]!
    const primaryNode = body.nodes[primaryBinding.node]
    const primarySchema = primaryNode === undefined ? undefined : resolveSchema(primaryNode.type)
    const primaryRoute = primarySchema === undefined ? undefined : resolveBoundaryRoute(primarySchema, primaryBinding, 'input')
    const primarySlot = primaryRoute?.ok === true && primaryRoute.route.terminal.kind === 'port' ? primaryRoute.route.terminal.slot : undefined
    const primaryState = nodes.get(primaryBinding.node as string)
    if (primarySlot?.kind !== 'input' || primaryState === undefined || primaryBinding.kind !== 'port') {
      fail('subgraph.flatten.stateUnresolved', `promoted boundary '${item.id}' has no plain primary widget`, 'input', item.id)
      continue
    }
    const primaryKey = primaryBinding.port as string
    const value = Object.hasOwn(occurrence.values, item.id)
      ? occurrence.values[item.id]
      : Object.hasOwn(primaryState.values, primaryKey)
        ? primaryState.values[primaryKey]
        : primarySlot.widget === undefined ? undefined : effectiveWidgetDefault(primarySlot.widget) as Json | undefined
    const controller = Object.hasOwn(occurrence.controllers ?? {}, item.id)
      ? occurrence.controllers![item.id]
      : Object.hasOwn(primaryState.controllers ?? {}, primaryKey)
        ? primaryState.controllers![primaryKey]
        : primarySlot.widget?.controllerInitial ?? (primarySlot.widget?.controller !== undefined ? 'randomize' : undefined)
    for (const binding of targets) {
      const target = nodes.get(binding.node as string)
      if (target === undefined || binding.kind !== 'port' || (binding.members?.length ?? 0) > 0) {
        fail('subgraph.flatten.stateUnresolved', `promoted boundary '${item.id}' cannot map to one plain target`, 'input', item.id)
        continue
      }
      const targetKey = binding.port as string
      const targetValues = { ...target.values }
      delete targetValues[targetKey]
      if (value !== undefined) targetValues[targetKey] = value
      const targetControllers = { ...(target.controllers ?? {}) }
      delete targetControllers[targetKey]
      if (controller !== undefined) targetControllers[targetKey] = controller
      target.values = targetValues
      if (Object.keys(targetControllers).length > 0) target.controllers = targetControllers
      else delete target.controllers
    }
  }

  const destinationOwners = new Map<string, string>()
  for (const [sourceKey, entry] of addressEntries) {
    for (const target of entry.targets) {
      const destinationKey = JSON.stringify([target.binding.node, target.binding.port, target.binding.members ?? []])
      const owner = destinationOwners.get(destinationKey)
      if (owner !== undefined && owner !== sourceKey) {
        fail('subgraph.flatten.stateUnresolved', `family materialization maps multiple source addresses to one destination`, entry.side, entry.boundaryId, undefined, entry.before)
      } else destinationOwners.set(destinationKey, sourceKey)
    }
  }

  const enclosingRewrites: FlattenEnclosingBindingRewrite[] = []
  const enclosingSides = [
    { side: 'input' as const, parentItems: parent.boundary?.inputs ?? [], childItems: body.boundary?.inputs ?? [] },
    { side: 'output' as const, parentItems: parent.boundary?.outputs ?? [], childItems: body.boundary?.outputs ?? [] },
  ]
  for (const { side, parentItems, childItems } of enclosingSides) {
    for (const [itemIndex, parentItem] of parentItems.entries()) {
      const bindings = [parentItem.binds, ...(parentItem.alsoBinds ?? [])]
      for (const [bindingIndex, binding] of bindings.entries()) {
        if (binding.node !== occurrence.id) continue
        if (binding.kind === 'widgetTap') {
          fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' widget tap cannot route through an occurrence`, side)
          continue
        }
        const childMatch = matchBoundaryItem(childItems, binding)
        if (!childMatch.ok) {
          fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has ${childMatch.code} descendant route`, side)
          continue
        }
        const childItem = childMatch.item
        const route = boundaryPlan.find((entry) => entry.side === side && entry.id === childItem.id)
        let after: BoundaryBinding[] | undefined
        if (route?.route === 'family') {
          const mapped = addressEntries.get(JSON.stringify([side, childItem.id, addressKey({
            port: binding.port as string,
            ...(binding.members !== undefined ? { members: binding.members } : {}),
          })]))
          if (mapped === undefined || !mapped.uses.includes('endpoint')) {
            fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has an unmapped descendant route`, side, childItem.id)
            continue
          }
          const mappedTargets = [...mapped.targets].sort((a, b) => a.bindingIndex - b.bindingIndex)
          after = mappedTargets.map((target) => target.binding)
          if (binding.kind === 'family') {
            if (side === 'output' && after.length !== 1) {
              fail('subgraph.lifecycle.boundaryUnresolved', `enclosing ${side} '${parentItem.id}' family route cannot fan out`, side, childItem.id)
              continue
            }
            const sourceRoute = occurrenceSchema.schema === undefined ? undefined : resolveBoundaryRoute(occurrenceSchema.schema, binding, side)
            const hasSpecializedHop = sourceRoute?.ok === true && sourceRoute.route.hops.some((hop) => hop.kind === 'slot' || hop.kind === 'slotVariant')
            if (sourceRoute?.ok !== true || sourceRoute.route.terminal.kind !== 'family' || hasSpecializedHop) {
              fail(hasSpecializedHop ? 'subgraph.flatten.specializedSlotUnsupported' : 'subgraph.flatten.stateUnresolved',
                `enclosing ${side} '${parentItem.id}' family target is unresolved`, side, childItem.id)
              continue
            }
            const sourceRoot = occurrenceSchema.schema?.items.find((entry) => entry.kind !== 'section' && entry.id === childItem.id)
            if (sourceRoot?.kind === 'section' || sourceRoot?.dynamic?.kind !== 'autogrow') {
              fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has no source family coordinate`, side, childItem.id)
              continue
            }
            let outerSelection: SelectionTree | undefined
            if (binding.slots !== undefined) {
              const parsed = parseSelection(binding.slots)
              if ('error' in parsed || !validateSelection(sourceRoute.route.terminal.spec.template, parsed.tree)) {
                fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has an ambiguous slot projection`, side, childItem.id)
                continue
              }
              outerSelection = parsed.tree
            }
            const childBindings = [childItem.binds, ...(childItem.alsoBinds ?? [])]
            const composed: BoundaryBinding[] = []
            for (const target of mappedTargets) {
              const targetBinding = childBindings[target.bindingIndex]
              const targetNode = targetBinding === undefined ? undefined : body.nodes[targetBinding.node]
              const targetSchema = targetNode === undefined ? undefined : resolveSchema(targetNode.type)
              const targetRoute = targetSchema === undefined || targetBinding === undefined
                ? undefined
                : resolveBoundaryRoute(targetSchema, targetBinding, side)
              const targetRoot = targetRoute?.ok === true && targetRoute.route.terminal.kind === 'family'
                ? targetRoute.route.terminal.spec
                : undefined
              const targetSpec = targetFamilySpecs.get(JSON.stringify([target.binding.node, addressKey({
                port: target.binding.port as string,
                ...(target.binding.members !== undefined ? { members: target.binding.members } : {}),
              })]))
              if (targetBinding === undefined || targetRoot === undefined || targetSpec === undefined) {
                fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' family target is unresolved`, side, childItem.id)
                continue
              }
              const childExplicit = targetBinding.slots !== undefined
              let childRootSelection: WholeSelection = 'all'
              if (targetBinding.slots !== undefined) {
                const parsed = parseSelection(targetBinding.slots)
                if ('error' in parsed || !validateSelection(targetRoot.template, parsed.tree)) {
                  fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has an invalid child slot selection`, side, childItem.id)
                  continue
                }
                childRootSelection = parsed.tree
              }
              const childSelection = projectSelectionToDescendant(
                targetRoot,
                childItem.id,
                binding.port as string,
                childRootSelection,
              )
              if (childSelection === undefined) {
                fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has an ambiguous slot projection`, side, childItem.id)
                continue
              }
              const intersection = intersectSelection(childSelection, outerSelection ?? 'all')
              if (intersection === undefined) {
                fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has an empty slot intersection`, side, childItem.id)
                continue
              }
              const serializedSelection = intersection === 'all' ? fullTemplateSelection(targetSpec.template) : intersection
              const slots = selectionEntriesInTemplateOrder(targetSpec.template, serializedSelection)
              if (slots === undefined || slots.length === 0) {
                fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has an unrepresentable slot intersection`, side, childItem.id)
                continue
              }
              if (target.binding.kind === 'widgetTap') {
                fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' family target is a widget tap`, side, childItem.id)
                continue
              }
              composed.push({
                ...target.binding,
                kind: 'family',
                ...(!childExplicit && binding.slots === undefined && intersection === 'all' ? {} : { slots }),
              })
            }
            after = composed
          }
        } else {
          after = [childItem.binds, ...(childItem.alsoBinds ?? [])]
        }
        if (after === undefined || after.length === 0 || side === 'output' && after.length !== 1) {
          fail('subgraph.lifecycle.boundaryUnresolved', `enclosing ${side} '${parentItem.id}' has no unique representable descendant`, side, childItem.id)
          continue
        }
        enclosingRewrites.push({ side, itemIndex, itemId: parentItem.id, bindingIndex, before: binding, after })
      }
    }
  }

  if (refusal !== undefined) return { version: 'subgraph-flatten-state-plan-v1', status: 'refused', source, refusal }
  const addresses = [...addressEntries.values()]
  for (const route of routes) {
    route.addressIndexes = addresses.flatMap((address, index) =>
      address.side === route.side && address.boundaryId === route.id ? [index] : [])
  }
  return {
    version: 'subgraph-flatten-state-plan-v1',
    status: 'ready',
    source,
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.node, b.node)),
    familyScopes,
    addresses,
    routes,
    enclosingRewrites,
  }
}

export function verifyFlattenStatePlan(
  body: GraphDef,
  occurrence: NodeData,
  parent: GraphDef,
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): boolean {
  const expected = planFlattenState(
    body,
    occurrence,
    parent,
    (type) => schemaSnapshot[type],
    { ...schemaSnapshot },
    boundaryPlan,
    occurrencePortEvidence(parent, occurrence.id),
  )
  return canonicalJson(expected) === canonicalJson(statePlan)
}

const flattenSchemaPlanProjection = (
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): unknown => ({
  version: 'subgraph-flatten-schema-plan-v2',
  schemas: Object.keys(schemaSnapshot).sort(compareStrings).map((authoredType) => ({
    authoredType,
    schema: schemaSnapshot[authoredType],
  })),
  boundaryPlan,
  statePlan,
})

export function flattenSchemaPlanDigest(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): string {
  return lifecycleCanonicalHash(flattenSchemaPlanProjection(schemaSnapshot, boundaryPlan, statePlan))
}

export function verifyFlattenSchemaPlanDigest(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  schemaPlanDigest: string,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): boolean {
  return flattenSchemaPlanDigest(schemaSnapshot, boundaryPlan, statePlan) === schemaPlanDigest
}

/** Initial-dispatch guard. Shared re-execution deliberately does not call this. */
export function flattenRegistryMatchesSchemaPlan(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  schemaPlanDigest: string,
  resolveSchema: SchemaResolver,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): boolean {
  const current: Record<string, NodeSchema> = {}
  for (const authoredType of Object.keys(schemaSnapshot)) {
    const schema = resolveSchema(authoredType)
    if (schema === undefined) return false
    current[authoredType] = schema
  }
  return flattenSchemaPlanDigest(current, boundaryPlan, statePlan) === schemaPlanDigest
}

export type FreshDefinitionInitializer = Omit<GraphDef, 'id' | 'name'>

export interface FreshOccurrenceInitializer {
  readonly position: Vec2
  readonly values?: JsonObject
  readonly title?: string
  readonly region?: RegionContract
}

export interface FreshSubgraphCreateInput {
  readonly parentGraphId: string
  readonly definition: FreshDefinitionInitializer
  readonly view: GraphViewState
  readonly occurrence: FreshOccurrenceInitializer
  readonly name?: string
}

export interface FreshSubgraphCreatePlan {
  readonly ok: true
  readonly graphId: string
  readonly name: string
  readonly definition: GraphDef
  readonly view: GraphViewState
  readonly invocation: CommandInvocation
}

export interface FreshSubgraphCreateRejection {
  readonly ok: false
  readonly diagnostics: readonly Diagnostic[]
}

const freshDefinitionId = (doc: WorkflowDocument): string => {
  let ordinal = 0
  while (Object.hasOwn(doc.graphs, `g${ordinal}`)) ordinal += 1
  return `g${ordinal}`
}

const freshDefinitionName = (doc: WorkflowDocument): string => {
  const names = new Set(Object.values(doc.graphs).map((graph) => graph.name))
  if (!names.has('New Subgraph')) return 'New Subgraph'
  let suffix = 2
  while (names.has(`New Subgraph ${suffix}`)) suffix += 1
  return `New Subgraph ${suffix}`
}

/**
 * Owns the one create-new-definition allocation path. Callers provide an
 * id-less topology and occurrence fields, while this planner alone injects
 * the fresh definition id and matching occurrence type.
 */
export function planFreshSubgraphCreate(
  doc: WorkflowDocument,
  input: FreshSubgraphCreateInput,
): FreshSubgraphCreatePlan | FreshSubgraphCreateRejection {
  if (!Object.hasOwn(doc.graphs, input.parentGraphId)) {
    return {
      ok: false,
      diagnostics: [diag('error', 'command', 'graph.missing', `create subgraph: unknown graph '${input.parentGraphId}'`)],
    }
  }
  const graphId = freshDefinitionId(doc)
  const requestedName = input.name
  const name = requestedName !== undefined && requestedName.trim().length > 0 ? requestedName : freshDefinitionName(doc)
  const definition: GraphDef = { ...input.definition, id: asGraphDefId(graphId), name }
  const diagnostics = [
    ...validateGraphDefShape(definition, `graphs.${graphId}`),
    ...validateGraphViewShape(input.view, `view.${graphId}`),
  ]
  if (!Number.isFinite(input.occurrence.position.x) || !Number.isFinite(input.occurrence.position.y)) {
    diagnostics.push(diag('error', 'command', 'params.invalid', 'create subgraph: occurrence position must be finite'))
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { ok: false, diagnostics }

  const occurrenceParams = {
    graphId: input.parentGraphId,
    type: `#${graphId}`,
    position: { x: input.occurrence.position.x, y: input.occurrence.position.y },
    values: input.occurrence.values ?? {},
    ...(input.occurrence.title !== undefined ? { title: input.occurrence.title } : {}),
    ...(input.occurrence.region !== undefined ? { region: input.occurrence.region } : {}),
  } as unknown as JsonObject
  return {
    ok: true,
    graphId,
    name,
    definition,
    view: input.view,
    invocation: {
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'subgraph.import',
            params: { graphs: { [graphId]: definition }, view: { [graphId]: input.view } },
          },
          { command: 'node.add', params: occurrenceParams },
        ],
      } as unknown as Json,
    },
  }
}

export const EMPTY_SUBGRAPH_DEFINITION: FreshDefinitionInitializer = {
  nodes: {},
  links: {},
  nets: {},
  reroutes: {},
  boundary: { inputs: [], outputs: [] },
  nextOrdinal: 0,
}

export const EMPTY_SUBGRAPH_VIEW: GraphViewState = { nodes: {} }

export interface LifecycleSelectionInput {
  readonly nodeIds?: readonly string[]
  readonly rerouteIds?: readonly string[]
  readonly valueSourceIds?: readonly string[]
  readonly selectorIds?: readonly string[]
  readonly groupIds?: readonly string[]
}

export interface LifecycleSelection {
  readonly nodeIds: readonly string[]
  readonly rerouteIds: readonly string[]
  readonly valueSourceIds: readonly string[]
  readonly selectorIds: readonly string[]
  readonly groupIds: readonly string[]
}

export type LifecycleEntityKind = keyof LifecycleSelection

export interface MissingLifecycleEntity {
  readonly kind: LifecycleEntityKind
  readonly id: string
}

const sortedUnique = (values: readonly string[] | undefined): readonly string[] =>
  [...new Set(values ?? [])].sort(compareStrings)

export function canonicalizeLifecycleSelection(selection: LifecycleSelectionInput): LifecycleSelection {
  return {
    nodeIds: sortedUnique(selection.nodeIds),
    rerouteIds: sortedUnique(selection.rerouteIds),
    valueSourceIds: sortedUnique(selection.valueSourceIds),
    selectorIds: sortedUnique(selection.selectorIds),
    groupIds: sortedUnique(selection.groupIds),
  }
}

export function missingLifecycleEntities(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelection,
): readonly MissingLifecycleEntity[] {
  const graph = Object.hasOwn(doc.graphs, graphId) ? doc.graphs[graphId] : undefined
  const view = Object.hasOwn(doc.view.graphs, graphId) ? doc.view.graphs[graphId] : undefined
  const collections: Readonly<Record<LifecycleEntityKind, Readonly<Record<string, unknown>> | undefined>> = {
    nodeIds: graph?.nodes,
    rerouteIds: graph?.reroutes,
    valueSourceIds: graph?.valueSources,
    selectorIds: graph?.selectors,
    groupIds: view?.groups,
  }
  const missing: MissingLifecycleEntity[] = []
  for (const kind of Object.keys(selection) as LifecycleEntityKind[]) {
    const records = collections[kind]
    for (const id of selection[kind]) {
      if (records === undefined || !Object.hasOwn(records, id)) missing.push({ kind, id })
    }
  }
  return missing
}

export function hasSemanticLifecycleSelection(selection: LifecycleSelection): boolean {
  return selection.nodeIds.length > 0 || selection.valueSourceIds.length > 0 || selection.selectorIds.length > 0
}

interface FingerprintProjection {
  readonly version: typeof LIFECYCLE_PLAN_VERSION
  readonly graphId: string
  readonly selection: LifecycleSelection
  readonly entities: {
    readonly nodes: readonly unknown[]
    readonly reroutes: readonly unknown[]
    readonly valueSources: readonly unknown[]
    readonly selectors: readonly unknown[]
    readonly groups: readonly unknown[]
  }
  readonly links: readonly unknown[]
  readonly nets: readonly unknown[]
  readonly boundary: readonly unknown[]
  readonly collapsedNets: readonly string[]
  readonly guideNets: readonly string[]
}

const selectedSets = (selection: LifecycleSelection) => ({
  nodes: new Set(selection.nodeIds),
  reroutes: new Set(selection.rerouteIds),
  valueSources: new Set(selection.valueSourceIds),
  selectors: new Set(selection.selectorIds),
})

function endpointSelected(endpoint: LinkEndpoint, selection: ReturnType<typeof selectedSets>): boolean {
  if (isRerouteRef(endpoint)) return selection.reroutes.has(endpoint.reroute)
  if (isValueSourceRef(endpoint)) return selection.valueSources.has(endpoint.valueSource)
  if (isSelectorRef(endpoint)) return selection.selectors.has(endpoint.selector)
  return selection.nodes.has(endpoint.node)
}

function bindingSelected(binding: BoundaryBinding, selection: ReturnType<typeof selectedSets>): boolean {
  return selection.nodes.has(binding.node)
}

function recordProjection(
  ids: readonly string[],
  records: Readonly<Record<string, unknown>> | undefined,
  views: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] {
  return ids.map((id) => ({
    id,
    record: records?.[id],
    viewPresent: views !== undefined && Object.hasOwn(views, id),
    ...(views !== undefined && Object.hasOwn(views, id) ? { view: views[id] } : {}),
  }))
}

export function lifecycleSelectionProjection(
  doc: WorkflowDocument,
  graphId: string,
  selectionInput: LifecycleSelectionInput,
): FingerprintProjection | undefined {
  if (!Object.hasOwn(doc.graphs, graphId)) return undefined
  const graph = doc.graphs[graphId]!
  const graphView = Object.hasOwn(doc.view.graphs, graphId) ? doc.view.graphs[graphId] : undefined
  const selection = canonicalizeLifecycleSelection(selectionInput)
  if (missingLifecycleEntities(doc, graphId, selection).length > 0) return undefined
  const selected = selectedSets(selection)
  const links = Object.values(graph.links)
    .filter((link) => endpointSelected(link.from, selected) || endpointSelected(link.to, selected))
    .sort((a, b) => compareStrings(a.id, b.id))
  const nets = Object.values(graph.nets)
    .filter((net) => selected.nodes.has(net.source.node) || net.sinks.some((sink) => selected.nodes.has(sink.node)))
    .sort((a, b) => compareStrings(a.id, b.id))
  const boundary: unknown[] = []
  for (const side of ['inputs', 'outputs'] as const) {
    for (const [index, item] of (graph.boundary?.[side] ?? []).entries()) {
      if (bindingSelected(item.binds, selected) || item.alsoBinds?.some((binding) => bindingSelected(binding, selected))) {
        boundary.push({ side, index, item })
      }
    }
  }
  return {
    version: LIFECYCLE_PLAN_VERSION,
    graphId,
    selection,
    entities: {
      nodes: recordProjection(selection.nodeIds, graph.nodes, graphView?.nodes),
      reroutes: recordProjection(selection.rerouteIds, graph.reroutes, graphView?.reroutes),
      valueSources: recordProjection(selection.valueSourceIds, graph.valueSources, graphView?.valueSources),
      selectors: recordProjection(selection.selectorIds, graph.selectors, graphView?.selectors),
      groups: recordProjection(selection.groupIds, graphView?.groups, undefined),
    },
    links,
    nets,
    boundary,
    collapsedNets: sortedUnique(graphView?.collapsedNets),
    guideNets: sortedUnique(graphView?.guideNets),
  }
}

export function lifecycleCanonicalHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

export function lifecycleSelectionFingerprint(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelectionInput,
): string | undefined {
  const projection = lifecycleSelectionProjection(doc, graphId, selection)
  return projection === undefined ? undefined : lifecycleCanonicalHash(projection)
}

export interface LifecycleSelectionPlan {
  readonly graphId: string
  readonly selection: LifecycleSelectionInput
  readonly selectionFingerprint: string
}

export type LifecyclePlanFreshness =
  | { readonly stale: false; readonly fingerprint: string }
  | { readonly stale: true; readonly fingerprint?: string; readonly code: 'subgraph.lifecycle.stalePlan' }

export function verifyLifecycleSelectionPlan(
  doc: WorkflowDocument,
  plan: LifecycleSelectionPlan,
): LifecyclePlanFreshness {
  const fingerprint = lifecycleSelectionFingerprint(doc, plan.graphId, plan.selection)
  return fingerprint !== undefined && fingerprint === plan.selectionFingerprint
    ? { stale: false, fingerprint }
    : {
        stale: true,
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        code: 'subgraph.lifecycle.stalePlan',
      }
}

export function lifecycleFlattenProjection(
  doc: WorkflowDocument,
  graphId: string,
  occurrenceNodeId: string,
  boundaryRoutePlan?: unknown,
): unknown | undefined {
  const graph = doc.graphs[graphId]
  const occurrence = graph?.nodes[occurrenceNodeId]
  const bodyId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
  const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
  if (graph === undefined || occurrence === undefined || bodyId === undefined || body === undefined) return undefined
  const graphView = doc.view.graphs[graphId]
  const modePanelBindings = Object.values(doc.surfaces ?? {}).flatMap((surface) => {
    if (surface.type !== MODE_PANEL_TYPE) return []
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) return []
    const bindings = decoded.config.bindings.filter((binding) =>
      binding.kind === 'node' && binding.graphId === graphId && binding.nodeId === occurrenceNodeId)
    return bindings.length > 0 ? [{ surfaceId: surface.id, bindings }] : []
  }).sort((a, b) => compareStrings(a.surfaceId, b.surfaceId))
  return {
    version: LIFECYCLE_PLAN_VERSION,
    graphId,
    occurrence: {
      record: occurrence,
      viewPresent: graphView !== undefined && Object.hasOwn(graphView.nodes, occurrenceNodeId),
      ...(graphView !== undefined && Object.hasOwn(graphView.nodes, occurrenceNodeId)
        ? { view: graphView.nodes[occurrenceNodeId] }
        : {}),
    },
    body,
    bodyViewPresent: Object.hasOwn(doc.view.graphs, bodyId),
    ...(Object.hasOwn(doc.view.graphs, bodyId) ? { bodyView: doc.view.graphs[bodyId] } : {}),
    links: Object.values(graph.links)
      .filter((link) =>
        (isPortEndpoint(link.from) || isWidgetTapRef(link.from)) && link.from.node === occurrenceNodeId ||
        isPortEndpoint(link.to) && link.to.node === occurrenceNodeId)
      .sort((a, b) => compareStrings(a.id, b.id)),
    nets: Object.values(graph.nets)
      .filter((net) => net.source.node === occurrenceNodeId || net.sinks.some((sink) => sink.node === occurrenceNodeId))
      .sort((a, b) => compareStrings(a.id, b.id)),
    boundary: [
      ...['inputs', 'outputs'].flatMap((side) => (graph.boundary?.[side as 'inputs' | 'outputs'] ?? [])
        .map((item, index) => ({ side, index, item }))
        .filter(({ item }) => [item.binds, ...(item.alsoBinds ?? [])].some((binding) => binding.node === occurrenceNodeId))),
    ],
    boundaryRoutePlan,
    modePanelBindings,
    collapsedNets: sortedUnique(graphView?.collapsedNets),
    guideNets: sortedUnique(graphView?.guideNets),
  }
}

export function lifecycleFlattenFingerprint(
  doc: WorkflowDocument,
  graphId: string,
  occurrenceNodeId: string,
  boundaryRoutePlan?: unknown,
): string | undefined {
  const projection = lifecycleFlattenProjection(doc, graphId, occurrenceNodeId, boundaryRoutePlan)
  return projection === undefined ? undefined : lifecycleCanonicalHash(projection)
}

export function verifyLifecycleFlattenPlan(
  doc: WorkflowDocument,
  graphId: string,
  occurrenceNodeId: string,
  selectionFingerprint: string,
  boundaryRoutePlan?: unknown,
): LifecyclePlanFreshness {
  const fingerprint = lifecycleFlattenFingerprint(doc, graphId, occurrenceNodeId, boundaryRoutePlan)
  return fingerprint !== undefined && fingerprint === selectionFingerprint
    ? { stale: false, fingerprint }
    : {
        stale: true,
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        code: 'subgraph.lifecycle.stalePlan',
      }
}

export type CutKind = 'outside' | 'internal' | 'in-cut' | 'out-cut' | 'unrepresentable'

export type ExtractRefusalCode =
  | 'subgraph.extract.structuralCutUnsupported'
  | 'subgraph.extract.structuralOutputUnsupported'
  | 'subgraph.extract.specializedSlotUnsupported'
  | 'subgraph.lifecycle.boundaryUnresolved'
  | 'subgraph.lifecycle.multiDriver'

export interface CutRefusal {
  readonly code: ExtractRefusalCode
  readonly source: 'link' | 'net' | 'boundary'
  readonly id: string
  readonly endpoint?: LinkEndpoint | PortRef
}

export interface LinkCut {
  readonly id: string
  readonly kind: CutKind
  readonly from: LinkEndpoint
  readonly to: LinkEndpoint
  readonly ext?: ExtData
  readonly refusal?: CutRefusal
}

export interface NetCut {
  readonly id: string
  readonly kind: CutKind
  readonly sourceInside: boolean
  readonly insideSinks: readonly PortRef[]
  readonly outsideSinks: readonly PortRef[]
  readonly split: boolean
  readonly refusal?: CutRefusal
}

export interface BoundaryCut {
  readonly side: 'inputs' | 'outputs'
  readonly itemIndex: number
  readonly itemId: string
  readonly kind: 'outside' | 'in-cut' | 'out-cut' | 'unrepresentable'
  readonly movedBindings: readonly BoundaryBinding[]
  readonly retainedBindings: readonly BoundaryBinding[]
  readonly primaryMoved: boolean
  /** Index in [binds, ...alsoBinds] where the occurrence replaces moved targets. */
  readonly replacementIndex?: number
  /** Exact nested item shape. Whole-family slots remain on the enclosing item. */
  readonly nestedItem?: {
    readonly binds: BoundaryBinding
    readonly alsoBinds?: readonly BoundaryBinding[]
    readonly promoted?: true
    readonly displayName?: string
  }
  readonly promoted: boolean
  readonly refusal?: CutRefusal
}

export type InputCutSource =
  | {
      readonly kind: 'link'
      readonly endpoint: LinkEndpoint
      /** Present only for a semantic-ext exemption from same-producer grouping. */
      readonly linkId?: string
      readonly ext?: ExtData
    }
  | { readonly kind: 'net'; readonly netId: string; readonly endpoint: PortRef }
  | { readonly kind: 'boundary'; readonly itemIndex: number; readonly itemId: string }

export interface InputCutGroup {
  readonly source: InputCutSource
  readonly targets: readonly PortRef[]
}

export interface OutputCutGroup {
  readonly source: PortRef | WidgetTapRef
  readonly consumers: readonly LinkEndpoint[]
  readonly netIds: readonly string[]
  readonly boundaryItems: readonly { readonly itemIndex: number; readonly itemId: string }[]
}

export interface ExtractionCutAudit {
  readonly links: readonly LinkCut[]
  readonly nets: readonly NetCut[]
  readonly boundaries: readonly BoundaryCut[]
  readonly inputs: readonly InputCutGroup[]
  readonly outputs: readonly OutputCutGroup[]
  readonly refusals: readonly CutRefusal[]
}

export interface ExtractionCutOptions {
  /** Schema-resolved direct DynamicSlot root addresses. Descendants are omitted. */
  readonly specializedSlotRoots?: readonly PortRef[]
  /** Schema-resolved static widget inputs that can truthfully back output taps. */
  readonly widgetTapSources?: readonly WidgetTapRef[]
}

function endpointKey(endpoint: LinkEndpoint): string {
  if (isRerouteRef(endpoint)) return canonicalJson(['reroute', endpoint.reroute])
  if (isValueSourceRef(endpoint)) return canonicalJson(['valueSource', endpoint.valueSource])
  if (isSelectorRef(endpoint)) return canonicalJson(['selector', endpoint.selector, endpoint.candidate ?? null])
  if (isWidgetTapRef(endpoint)) return canonicalJson(['tap', endpoint.node, endpoint.tap])
  return canonicalJson(['port', endpoint.node, endpoint.port, endpoint.members ?? []])
}

function refusalForLink(
  link: { readonly id: string; readonly from: LinkEndpoint; readonly to: LinkEndpoint },
  kind: 'in-cut' | 'out-cut',
  specializedSlots: ReadonlySet<string>,
  widgetTapSources?: ReadonlySet<string>,
): CutRefusal | undefined {
  const inner = kind === 'in-cut' ? link.to : link.from
  if (isPortEndpoint(inner)) {
    if (specializedSlots.has(portRefKey(inner))) {
      return { code: 'subgraph.extract.specializedSlotUnsupported', source: 'link', id: link.id, endpoint: inner }
    }
    return undefined
  }
  if (kind === 'out-cut' && isWidgetTapRef(inner)) {
    return widgetTapSources === undefined || widgetTapSources.has(endpointKey(inner))
      ? undefined
      : { code: 'subgraph.lifecycle.boundaryUnresolved', source: 'link', id: link.id, endpoint: inner }
  }
  const code = kind === 'out-cut' && isValueSourceRef(inner)
    ? 'subgraph.extract.structuralOutputUnsupported'
    : 'subgraph.extract.structuralCutUnsupported'
  return { code, source: 'link', id: link.id, endpoint: inner }
}

const bindingAsPort = (binding: Exclude<BoundaryBinding, { kind: 'widgetTap' }>): PortRef => ({
  node: binding.node,
  port: binding.port,
  ...(binding.members !== undefined ? { members: binding.members } : {}),
})

const bindingAsOutputEndpoint = (binding: BoundaryBinding): PortRef | WidgetTapRef =>
  binding.kind === 'widgetTap'
    ? { node: binding.node, tap: binding.tap }
    : bindingAsPort(binding)

export function auditExtractionCuts(
  graph: GraphDef,
  selectionInput: LifecycleSelectionInput,
  options: ExtractionCutOptions = {},
): ExtractionCutAudit {
  const selection = canonicalizeLifecycleSelection(selectionInput)
  const selected = selectedSets(selection)
  const specializedSlots = new Set((options.specializedSlotRoots ?? []).map(portRefKey))
  const widgetTapSources = options.widgetTapSources === undefined
    ? undefined
    : new Set(options.widgetTapSources.map(endpointKey))
  const refusals: CutRefusal[] = []
  const links: LinkCut[] = []
  const linkInputGroups = new Map<string, { source: InputCutSource; targets: PortRef[] }>()
  const outputGroups = new Map<string, { source: PortRef | WidgetTapRef; consumers: LinkEndpoint[]; netIds: string[]; boundaryItems: { itemIndex: number; itemId: string }[] }>()

  for (const link of Object.values(graph.links).sort((a, b) => compareStrings(a.id, b.id))) {
    const fromInside = endpointSelected(link.from, selected)
    const toInside = endpointSelected(link.to, selected)
    let kind: CutKind = fromInside === toInside ? (fromInside ? 'internal' : 'outside') : (toInside ? 'in-cut' : 'out-cut')
    const refusal = kind === 'in-cut' || kind === 'out-cut'
      ? refusalForLink(link, kind, specializedSlots, widgetTapSources)
      : undefined
    if (refusal !== undefined) {
      kind = 'unrepresentable'
      refusals.push(refusal)
    } else if (kind === 'in-cut' && isPortEndpoint(link.to)) {
      const semanticExt = link.ext !== undefined && Object.keys(link.ext).length > 0
      const key = semanticExt ? `${endpointKey(link.from)}\u0000${JSON.stringify(link.id)}` : endpointKey(link.from)
      let group = linkInputGroups.get(key)
      if (group === undefined) {
        group = {
          source: {
            kind: 'link',
            endpoint: link.from,
            ...(semanticExt ? { linkId: link.id, ext: link.ext } : {}),
          },
          targets: [],
        }
        linkInputGroups.set(key, group)
      }
      group.targets.push(link.to)
    } else if (kind === 'out-cut' && (isPortEndpoint(link.from) || isWidgetTapRef(link.from))) {
      const key = endpointKey(link.from)
      let group = outputGroups.get(key)
      if (group === undefined) {
        group = { source: link.from, consumers: [], netIds: [], boundaryItems: [] }
        outputGroups.set(key, group)
      }
      group.consumers.push(link.to)
    }
    links.push({
      id: link.id,
      kind,
      from: link.from,
      to: link.to,
      ...(link.ext !== undefined ? { ext: link.ext } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    })
  }

  const nets: NetCut[] = []
  const netInputGroups: InputCutGroup[] = []
  for (const net of Object.values(graph.nets).sort((a, b) => compareStrings(a.id, b.id))) {
    const sourceInside = selected.nodes.has(net.source.node)
    const insideSinks = net.sinks.filter((sink) => selected.nodes.has(sink.node))
    const outsideSinks = net.sinks.filter((sink) => !selected.nodes.has(sink.node))
    let kind: CutKind = sourceInside
      ? (outsideSinks.length === 0 ? 'internal' : 'out-cut')
      : (insideSinks.length === 0 ? 'outside' : 'in-cut')
    let refusal: CutRefusal | undefined
    const crossingPorts = kind === 'in-cut' ? insideSinks : kind === 'out-cut' ? [net.source] : []
    const specialized = crossingPorts.find((port) => specializedSlots.has(portRefKey(port)))
    if (specialized !== undefined) {
      refusal = { code: 'subgraph.extract.specializedSlotUnsupported', source: 'net', id: net.id, endpoint: specialized }
    } else if (sourceInside && insideSinks.length > 0 && outsideSinks.length > 0 && net.ext !== undefined && Object.keys(net.ext).length > 0) {
      refusal = { code: 'subgraph.lifecycle.boundaryUnresolved', source: 'net', id: net.id, endpoint: net.source }
    }
    if (refusal !== undefined) {
      kind = 'unrepresentable'
      refusals.push(refusal)
    } else if (kind === 'in-cut') {
      netInputGroups.push({
        source: { kind: 'net', netId: net.id, endpoint: net.source },
        targets: [...insideSinks].sort(comparePortRefs),
      })
    } else if (kind === 'out-cut') {
      const key = endpointKey(net.source)
      let group = outputGroups.get(key)
      if (group === undefined) {
        group = { source: net.source, consumers: [], netIds: [], boundaryItems: [] }
        outputGroups.set(key, group)
      }
      group.netIds.push(net.id)
    }
    nets.push({
      id: net.id,
      kind,
      sourceInside,
      insideSinks,
      outsideSinks,
      split: sourceInside && insideSinks.length > 0 && outsideSinks.length > 0,
      ...(refusal !== undefined ? { refusal } : {}),
    })
  }

  const boundaries: BoundaryCut[] = []
  for (const side of ['inputs', 'outputs'] as const) {
    for (const [itemIndex, item] of (graph.boundary?.[side] ?? []).entries()) {
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      const movedBindings = bindings.filter((binding) => selected.nodes.has(binding.node))
      const retainedBindings = bindings.filter((binding) => !selected.nodes.has(binding.node))
      if (movedBindings.length === 0) {
        boundaries.push({
          side,
          itemIndex,
          itemId: item.id,
          kind: 'outside',
          movedBindings,
          retainedBindings,
          primaryMoved: false,
          promoted: item.promoted === true,
        })
        continue
      }
      let refusal: CutRefusal | undefined
      const specialized = movedBindings
        .filter((binding): binding is Extract<BoundaryBinding, { kind: 'port' }> => binding.kind === 'port')
        .map(bindingAsPort)
        .find((port) => specializedSlots.has(portRefKey(port)))
      if (specialized !== undefined) {
        refusal = { code: 'subgraph.extract.specializedSlotUnsupported', source: 'boundary', id: item.id, endpoint: specialized }
        refusals.push(refusal)
      } else if (item.ext !== undefined && Object.keys(item.ext).length > 0) {
        refusal = { code: 'subgraph.lifecycle.boundaryUnresolved', source: 'boundary', id: item.id }
        refusals.push(refusal)
      }
      const kind = refusal !== undefined ? 'unrepresentable' : side === 'inputs' ? 'in-cut' : 'out-cut'
      const firstMovedIndex = bindings.findIndex((binding) => selected.nodes.has(binding.node))
      const nestedBindings = movedBindings.map((binding) => {
        if (binding.kind !== 'family') return binding
        const { slots: _slots, ...withoutSlots } = binding
        return withoutSlots
      })
      const nestedItem = refusal === undefined
        ? {
            binds: nestedBindings[0]!,
            ...(nestedBindings.length > 1 ? { alsoBinds: nestedBindings.slice(1) } : {}),
            ...(item.promoted === true ? { promoted: true as const } : {}),
            ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
          }
        : undefined
      boundaries.push({
        side,
        itemIndex,
        itemId: item.id,
        kind,
        movedBindings,
        retainedBindings,
        primaryMoved: selected.nodes.has(item.binds.node),
        replacementIndex: firstMovedIndex,
        ...(nestedItem !== undefined ? { nestedItem } : {}),
        promoted: item.promoted === true,
        ...(refusal !== undefined ? { refusal } : {}),
      })
      if (refusal !== undefined) continue
      if (side === 'outputs' && item.binds.kind !== 'family') {
        const source = bindingAsOutputEndpoint(item.binds)
        const key = endpointKey(source)
        let group = outputGroups.get(key)
        if (group === undefined) {
          group = { source, consumers: [], netIds: [], boundaryItems: [] }
          outputGroups.set(key, group)
        }
        group.boundaryItems.push({ itemIndex, itemId: item.id })
      }
    }
  }

  const ordinaryDrivenTargets = new Set<string>()
  for (const link of links) {
    if ((link.kind === 'internal' || link.kind === 'in-cut') && isPortEndpoint(link.to)) ordinaryDrivenTargets.add(portRefKey(link.to))
  }
  for (const net of nets) {
    if (net.kind === 'internal' || net.kind === 'in-cut') {
      for (const sink of net.insideSinks) ordinaryDrivenTargets.add(portRefKey(sink))
    }
  }
  for (const boundary of boundaries) {
    if (boundary.side !== 'inputs' || boundary.kind !== 'in-cut') continue
    for (const binding of boundary.movedBindings) {
      if (binding.kind !== 'port') continue
      const target = bindingAsPort(binding)
      if (!ordinaryDrivenTargets.has(portRefKey(target))) continue
      const refusal: CutRefusal = {
        code: 'subgraph.lifecycle.multiDriver',
        source: 'boundary',
        id: boundary.itemId,
        endpoint: target,
      }
      refusals.push(refusal)
      const index = boundaries.indexOf(boundary)
      if (index >= 0) {
        const { nestedItem: _nestedItem, ...rest } = boundary
        boundaries[index] = { ...rest, kind: 'unrepresentable', refusal }
      }
    }
  }

  const inputs = [
    ...[...linkInputGroups.values()].map((group) => ({
      source: group.source,
      targets: [...group.targets].sort(comparePortRefs),
    })),
    ...netInputGroups,
  ].sort(compareInputGroups)
  const outputs = [...outputGroups.values()]
    .map((group) => ({
      source: group.source,
      consumers: [...group.consumers].sort((a, b) => compareStrings(endpointKey(a), endpointKey(b))),
      netIds: [...group.netIds].sort(compareStrings),
      boundaryItems: [...group.boundaryItems].sort((a, b) => a.itemIndex - b.itemIndex),
    }))
    .sort((a, b) => {
      const source = compareStrings(endpointKey(a.source), endpointKey(b.source))
      if (source !== 0) return source
      return compareStrings(endpointKey(a.consumers[0] ?? a.source), endpointKey(b.consumers[0] ?? b.source))
    })
  return { links, nets, boundaries, inputs, outputs, refusals }
}

function compareInputGroups(a: InputCutGroup, b: InputCutGroup): number {
  const producer = compareStrings(inputProducerKey(a.source), inputProducerKey(b.source))
  if (producer !== 0) return producer
  const target = comparePortRefs(a.targets[0]!, b.targets[0]!)
  if (target !== 0) return target
  return compareStrings(inputSourceKey(a.source), inputSourceKey(b.source))
}

function inputSourceKey(source: InputCutSource): string {
  if (source.kind === 'link') {
    return `${endpointKey(source.endpoint)}\u0000link:${source.linkId === undefined ? '' : JSON.stringify(source.linkId)}`
  }
  if (source.kind === 'net') return `${endpointKey(source.endpoint)}\u0000net:${JSON.stringify(source.netId)}`
  return `${canonicalJson(['boundary', source.itemIndex, source.itemId])}\u0000boundary`
}

function inputProducerKey(source: InputCutSource): string {
  if (source.kind === 'link' || source.kind === 'net') return endpointKey(source.endpoint)
  return canonicalJson(['boundary', source.itemIndex, source.itemId])
}

export interface BoundaryNameCandidate {
  readonly side: 'input' | 'output'
  readonly base: string
  readonly orderKey: string
}

export interface PlannedBoundaryName extends BoundaryNameCandidate {
  readonly id: string
}

export function planBoundaryNames(candidates: readonly BoundaryNameCandidate[]): readonly PlannedBoundaryName[] {
  const ordered = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => {
    const side = a.candidate.side === b.candidate.side ? 0 : a.candidate.side === 'input' ? -1 : 1
    return side || compareStrings(a.candidate.orderKey, b.candidate.orderKey) || a.index - b.index
  })
  const used = new Set<string>()
  const planned = new Map<number, PlannedBoundaryName>()
  for (const { candidate, index } of ordered) {
    const fallback = candidate.side === 'input' ? 'input' : 'output'
    const base = candidate.base.length > 0 ? candidate.base : fallback
    let id = base
    let suffix = 2
    while (used.has(id)) id = `${base}_${suffix++}`
    used.add(id)
    planned.set(index, { ...candidate, id })
  }
  return candidates.map((_, index) => planned.get(index)!)
}

export function boundaryNameCandidates(audit: ExtractionCutAudit): readonly BoundaryNameCandidate[] {
  return [
    ...audit.inputs.map((cut) => ({
      side: 'input' as const,
      base: cut.targets[0]?.port ?? '',
      orderKey: `${inputProducerKey(cut.source)}:${cut.targets[0] === undefined ? '' : portRefKey(cut.targets[0])}:${inputSourceKey(cut.source)}`,
    })),
    ...audit.boundaries
      .filter((cut) => cut.kind === 'in-cut' && cut.nestedItem !== undefined && cut.nestedItem.binds.kind !== 'widgetTap')
      .map((cut) => ({
        side: 'input' as const,
        base: cut.nestedItem!.binds.port ?? '',
        orderKey: canonicalJson(['boundary', cut.itemIndex, cut.itemId]),
      })),
    ...audit.outputs.map((cut) => ({
      side: 'output' as const,
      base: isWidgetTapRef(cut.source) ? cut.source.tap : cut.source.port,
      orderKey: `${endpointKey(cut.source)}:${cut.consumers[0] === undefined ? '' : endpointKey(cut.consumers[0])}`,
    })),
    ...audit.boundaries
      .filter((cut) => cut.kind === 'out-cut' && cut.nestedItem !== undefined && cut.nestedItem.binds.kind === 'family')
      .map((cut) => ({
        side: 'output' as const,
        base: cut.nestedItem!.binds.port ?? '',
        orderKey: canonicalJson(['boundary', cut.itemIndex, cut.itemId]),
      })),
  ]
}

export interface ProspectiveDagResult {
  readonly ok: boolean
  readonly cycle?: readonly string[]
  readonly code?:
    | 'subgraph.lifecycle.recursive'
    | 'subgraph.lifecycle.contextInvalid'
    | 'subgraph.lifecycle.selectionMissing'
    | 'subgraph.flatten.notOccurrence'
    | 'graph.exists'
}

function definitionRefs(doc: WorkflowDocument): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>()
  for (const [id, graph] of Object.entries(doc.graphs)) {
    const targets = new Set<string>()
    for (const node of Object.values(graph.nodes)) {
      const target = subgraphDefIdOf(node.type)
      if (target !== undefined && Object.hasOwn(doc.graphs, target)) targets.add(target)
    }
    refs.set(id, targets)
  }
  return refs
}

export function checkProspectiveDefinitionDag(refs: ReadonlyMap<string, ReadonlySet<string>>): ProspectiveDagResult {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let cycle: readonly string[] | undefined
  const visit = (id: string): void => {
    if (cycle !== undefined || state.get(id) === 'done') return
    const stackIndex = stack.indexOf(id)
    if (state.get(id) === 'visiting') {
      cycle = [...stack.slice(stackIndex), id]
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of [...(refs.get(id) ?? [])].sort(compareStrings)) visit(next)
    stack.pop()
    state.set(id, 'done')
  }
  for (const id of [...refs.keys()].sort(compareStrings)) visit(id)
  return cycle === undefined ? { ok: true } : { ok: false, cycle, code: 'subgraph.lifecycle.recursive' }
}

export function checkProspectiveExtractionDag(
  doc: WorkflowDocument,
  parentGraphId: string,
  freshGraphId: string,
  movedNodeIds: readonly string[],
): ProspectiveDagResult {
  const refs = definitionRefs(doc)
  const parent = Object.hasOwn(doc.graphs, parentGraphId) ? doc.graphs[parentGraphId] : undefined
  if (parent === undefined) return { ok: false, code: 'subgraph.lifecycle.contextInvalid' }
  if (Object.hasOwn(doc.graphs, freshGraphId)) return { ok: false, code: 'graph.exists' }
  const moved = new Set(movedNodeIds)
  if ([...moved].some((id) => !Object.hasOwn(parent.nodes, id))) {
    return { ok: false, code: 'subgraph.lifecycle.selectionMissing' }
  }
  const parentRefs = new Set<string>()
  const freshRefs = new Set<string>()
  for (const node of Object.values(parent.nodes)) {
    const target = subgraphDefIdOf(node.type)
    if (target === undefined || !Object.hasOwn(doc.graphs, target)) continue
    if (moved.has(node.id)) freshRefs.add(target)
    else parentRefs.add(target)
  }
  parentRefs.add(freshGraphId)
  refs.set(parentGraphId, parentRefs)
  refs.set(freshGraphId, freshRefs)
  return checkProspectiveDefinitionDag(refs)
}

export function checkProspectiveFlattenDag(
  doc: WorkflowDocument,
  parentGraphId: string,
  occurrenceNodeId: string,
): ProspectiveDagResult {
  const refs = definitionRefs(doc)
  const parent = Object.hasOwn(doc.graphs, parentGraphId) ? doc.graphs[parentGraphId] : undefined
  const occurrence = parent !== undefined && Object.hasOwn(parent.nodes, occurrenceNodeId) ? parent.nodes[occurrenceNodeId] : undefined
  const flattenedId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
  const body = flattenedId !== undefined && Object.hasOwn(doc.graphs, flattenedId) ? doc.graphs[flattenedId] : undefined
  if (parent === undefined) return { ok: false, code: 'subgraph.lifecycle.contextInvalid' }
  if (occurrence === undefined || body === undefined) return { ok: false, code: 'subgraph.flatten.notOccurrence' }
  const parentRefs = new Set<string>()
  for (const node of Object.values(parent.nodes)) {
    if (node.id === occurrenceNodeId) continue
    const target = subgraphDefIdOf(node.type)
    if (target !== undefined && Object.hasOwn(doc.graphs, target)) parentRefs.add(target)
  }
  for (const node of Object.values(body.nodes)) {
    const target = subgraphDefIdOf(node.type)
    if (target !== undefined && Object.hasOwn(doc.graphs, target)) parentRefs.add(target)
  }
  refs.set(parentGraphId, parentRefs)
  return checkProspectiveDefinitionDag(refs)
}

export type FlattenShellRefusal =
  | 'subgraph.flatten.modeUnsupported'
  | 'subgraph.flatten.regionUnsupported'

export function flattenShellRefusal(node: Pick<NodeData, 'mode' | 'region'>): FlattenShellRefusal | undefined {
  if (node.region !== undefined) return 'subgraph.flatten.regionUnsupported'
  if (node.mode === 'muted' || node.mode === 'bypassed') return 'subgraph.flatten.modeUnsupported'
  return undefined
}

export function flattenShellRefusalDiagnostic(
  node: Pick<NodeData, 'mode' | 'region'>,
  graphId: string,
  instancePath: readonly string[],
  nodeId: string,
): Diagnostic | undefined {
  const code = flattenShellRefusal(node)
  return code === undefined ? undefined : diag(
    'error',
    'command',
    code,
    'subgraph.flatten: occurrence shell mode or region contract cannot be flattened',
    {
      refs: [{ graphId, nodeId }],
      anchor: { occurrence: { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) } },
    },
  )
}

export interface ResolvedGeometryItem {
  readonly id: string
  readonly kind: 'node' | 'reroute' | 'valueSource' | 'selector' | 'group'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GeometryPlan {
  readonly center: Vec2
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly usedPlacementFallback: boolean
  readonly items: readonly ResolvedGeometryItem[]
}

export interface GeometryCoverage {
  readonly complete: boolean
  readonly missing: readonly { readonly kind: ResolvedGeometryItem['kind']; readonly id: string }[]
  readonly duplicate: readonly { readonly kind: ResolvedGeometryItem['kind']; readonly id: string }[]
  readonly unexpected: readonly { readonly kind: ResolvedGeometryItem['kind']; readonly id: string }[]
}

export interface GroupSelectionMembership {
  readonly groupId: string
  readonly nodeIds: readonly string[]
  readonly rerouteIds: readonly string[]
  readonly valueSourceIds: readonly string[]
  readonly selectorIds: readonly string[]
}

export interface ExpandedLifecycleSelection {
  readonly selection: LifecycleSelection
  readonly groups: readonly GroupSelectionMembership[]
}

export function expandLifecycleSelectionFromGroups(
  selectionInput: LifecycleSelectionInput,
  geometry: readonly ResolvedGeometryItem[],
): ExpandedLifecycleSelection | undefined {
  const selection = canonicalizeLifecycleSelection(selectionInput)
  const byGroup = new Map<string, ResolvedGeometryItem>()
  for (const item of geometry) {
    if (!validGeometry(item)) return undefined
    if (item.kind === 'group') {
      if (byGroup.has(item.id)) return undefined
      byGroup.set(item.id, item)
    }
  }
  const memberships: GroupSelectionMembership[] = []
  const expanded: Record<'nodeIds' | 'rerouteIds' | 'valueSourceIds' | 'selectorIds', Set<string>> = {
    nodeIds: new Set(selection.nodeIds),
    rerouteIds: new Set(selection.rerouteIds),
    valueSourceIds: new Set(selection.valueSourceIds),
    selectorIds: new Set(selection.selectorIds),
  }
  for (const groupId of selection.groupIds) {
    const group = byGroup.get(groupId)
    if (group === undefined) return undefined
    const members: Record<keyof typeof expanded, string[]> = {
      nodeIds: [], rerouteIds: [], valueSourceIds: [], selectorIds: [],
    }
    for (const item of geometry) {
      const kind = selectionKindOfGeometry(item.kind)
      if (kind === undefined || !insideGroup(item, group)) continue
      members[kind].push(item.id)
      expanded[kind].add(item.id)
    }
    for (const ids of Object.values(members)) ids.sort(compareStrings)
    memberships.push({ groupId, ...members })
  }
  return {
    selection: canonicalizeLifecycleSelection({
      nodeIds: [...expanded.nodeIds],
      rerouteIds: [...expanded.rerouteIds],
      valueSourceIds: [...expanded.valueSourceIds],
      selectorIds: [...expanded.selectorIds],
      groupIds: selection.groupIds,
    }),
    groups: memberships,
  }
}

function selectionKindOfGeometry(
  kind: ResolvedGeometryItem['kind'],
): 'nodeIds' | 'rerouteIds' | 'valueSourceIds' | 'selectorIds' | undefined {
  if (kind === 'node') return 'nodeIds'
  if (kind === 'reroute') return 'rerouteIds'
  if (kind === 'valueSource') return 'valueSourceIds'
  if (kind === 'selector') return 'selectorIds'
  return undefined
}

function insideGroup(item: ResolvedGeometryItem, group: ResolvedGeometryItem): boolean {
  const centerX = item.x + item.width / 2
  const centerY = item.y + item.height / 2
  return centerX >= group.x && centerX <= group.x + group.width &&
    centerY >= group.y && centerY <= group.y + group.height
}

export function validateLifecycleGeometry(
  selectionInput: LifecycleSelectionInput,
  items: readonly ResolvedGeometryItem[],
): GeometryCoverage {
  const selection = canonicalizeLifecycleSelection(selectionInput)
  const expected = new Set<string>([
    ...selection.nodeIds.map((id) => geometryKey('node', id)),
    ...selection.rerouteIds.map((id) => geometryKey('reroute', id)),
    ...selection.valueSourceIds.map((id) => geometryKey('valueSource', id)),
    ...selection.selectorIds.map((id) => geometryKey('selector', id)),
    ...selection.groupIds.map((id) => geometryKey('group', id)),
  ])
  const seen = new Set<string>()
  const duplicate: { kind: ResolvedGeometryItem['kind']; id: string }[] = []
  const unexpected: { kind: ResolvedGeometryItem['kind']; id: string }[] = []
  for (const item of items) {
    const key = geometryKey(item.kind, item.id)
    if (seen.has(key)) duplicate.push({ kind: item.kind, id: item.id })
    else seen.add(key)
    if (!expected.has(key)) unexpected.push({ kind: item.kind, id: item.id })
  }
  const missing = [...expected]
    .filter((key) => !seen.has(key))
    .map(geometryAddressOf)
    .sort(compareGeometryAddresses)
  duplicate.sort(compareGeometryAddresses)
  unexpected.sort(compareGeometryAddresses)
  return {
    complete: missing.length === 0 && duplicate.length === 0 && unexpected.length === 0,
    missing,
    duplicate,
    unexpected,
  }
}

const geometryKey = (kind: ResolvedGeometryItem['kind'], id: string): string => canonicalJson([kind, id])

const geometryAddressOf = (key: string): { kind: ResolvedGeometryItem['kind']; id: string } => {
  const [kind, id] = JSON.parse(key) as [ResolvedGeometryItem['kind'], string]
  return { kind, id }
}

const compareGeometryAddresses = (
  a: { readonly kind: ResolvedGeometryItem['kind']; readonly id: string },
  b: { readonly kind: ResolvedGeometryItem['kind']; readonly id: string },
): number => compareStrings(geometryKey(a.kind, a.id), geometryKey(b.kind, b.id))

function validGeometry(item: ResolvedGeometryItem): boolean {
  return validBounds(item) && Number.isFinite(item.x + item.width) && Number.isFinite(item.y + item.height)
}

function validBounds(bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width >= 0 && bounds.height >= 0
}

export function planExtractedGeometry(
  items: readonly ResolvedGeometryItem[],
  placementCenter: Vec2,
): GeometryPlan | undefined {
  if (!Number.isFinite(placementCenter.x) || !Number.isFinite(placementCenter.y) || items.some((item) => !validGeometry(item))) {
    return undefined
  }
  const ordered = [...items].sort((a, b) => compareStrings(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`))
  if (ordered.length === 0) return { center: { ...placementCenter }, usedPlacementFallback: true, items: [] }
  const minX = Math.min(...ordered.map((item) => item.x))
  const minY = Math.min(...ordered.map((item) => item.y))
  const maxX = Math.max(...ordered.map((item) => item.x + item.width))
  const maxY = Math.max(...ordered.map((item) => item.y + item.height))
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return undefined
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  if (!validBounds(bounds)) return undefined
  const translated = ordered.map((item) => ({ ...item, x: item.x - center.x, y: item.y - center.y }))
  if (translated.some((item) => !validGeometry(item))) return undefined
  return {
    center,
    bounds,
    usedPlacementFallback: false,
    items: translated,
  }
}

export function planFlattenedGeometry(
  bodyItems: readonly ResolvedGeometryItem[],
  occurrenceCenter: Vec2,
): GeometryPlan | undefined {
  const inner = planExtractedGeometry(bodyItems, occurrenceCenter)
  if (inner === undefined) return undefined
  if (inner.usedPlacementFallback) return inner
  const offsetX = occurrenceCenter.x - inner.center.x
  const offsetY = occurrenceCenter.y - inner.center.y
  const bounds = inner.bounds === undefined ? undefined : {
    ...inner.bounds,
    x: inner.bounds.x + offsetX,
    y: inner.bounds.y + offsetY,
  }
  if (bounds !== undefined && !validBounds(bounds)) return undefined
  const translated = inner.items.map((item) => ({ ...item, x: item.x + occurrenceCenter.x, y: item.y + occurrenceCenter.y }))
  if (translated.some((item) => !validGeometry(item))) return undefined
  return {
    ...inner,
    center: { ...occurrenceCenter },
    ...(bounds !== undefined ? { bounds } : {}),
    items: translated,
  }
}

export function validateFlattenGeometry(
  occurrence: ResolvedGeometryItem | undefined,
  bodySelection: LifecycleSelectionInput,
  bodyItems: readonly ResolvedGeometryItem[],
): GeometryCoverage {
  const body = validateLifecycleGeometry(bodySelection, bodyItems)
  const occurrenceMissing = occurrence === undefined || occurrence.kind !== 'node' || !validGeometry(occurrence)
  return {
    complete: !occurrenceMissing && body.complete,
    missing: occurrenceMissing ? [{ kind: 'node', id: 'occurrence' }, ...body.missing] : body.missing,
    duplicate: body.duplicate,
    unexpected: body.unexpected,
  }
}

export function geometryOfGroup(group: GroupViewState): ResolvedGeometryItem {
  return { id: group.id, kind: 'group', ...group.bounds }
}

function comparePortRefs(a: PortRef, b: PortRef): number {
  return compareStrings(portRefKey(a), portRefKey(b))
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
