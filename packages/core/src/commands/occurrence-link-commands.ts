import { effectiveOccurrenceTopology, resolveOccurrenceLinkEndpoint, type EffectiveLink, type EffectiveLinkIdentity, type ResolvedOccurrenceEndpoint } from '../compile/effective-topology.js'
import { documentNodeResolver } from '../compile/compile.js'
import { canonicalJson } from '../compile/hash.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import { suppressedDeliveryKey, type DynamicPortState, type Json, type JsonObject, type OccurrenceLinkData, type OccurrenceLinkEndpoint, type OccurrenceTopology, type SuppressedDelivery, type WorkflowDocument } from '../format/document.js'
import { actorCursorOf, asLinkId, formatAllocatedId, guardOrdinal, isPortEndpoint, occurrenceKey, sameEndpoint, type OccurrenceRef } from '../ids.js'
import { lifecycleCanonicalHash } from '../lifecycle/planner.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type { NodeSchema } from '../schema/model.js'
import { elaborateInterface, elabInputsOf, elabOutputsOf, materializeFramesOf, type MaterializeFrame } from '../schema/elaborate.js'
import { createTransactionBuilder, type CommandDefinition, type CommandInvocation, type TransactionBuilder } from './contract.js'

const PLAN_VERSION = 'occurrence-link-plan-v1'
const DIGEST_VERSION = 'occurrence-link-plan-digest-v1'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)
const isObj = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const compareStrings = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const exactKeys = (value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value).sort(compareStrings)
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
}
const nonEmptyString = (value: Json | undefined): value is string => typeof value === 'string' && value.length > 0
const stringArray = (value: Json | undefined, empty = true): value is readonly string[] =>
  Array.isArray(value) && (empty || value.length > 0) && value.every(nonEmptyString)

function validLinkEndpoint(value: Json | undefined): boolean {
  if (!isObj(value)) return false
  if (value.reroute !== undefined) return exactKeys(value, ['reroute']) && nonEmptyString(value.reroute)
  if (value.valueSource !== undefined) return exactKeys(value, ['valueSource']) && nonEmptyString(value.valueSource)
  if (value.selector !== undefined)
    return exactKeys(value, ['selector'], ['candidate']) && nonEmptyString(value.selector) &&
      (value.candidate === undefined || nonEmptyString(value.candidate))
  if (value.tap !== undefined) return exactKeys(value, ['node', 'tap']) && nonEmptyString(value.node) && nonEmptyString(value.tap)
  return exactKeys(value, ['node', 'port'], ['kind', 'members']) && (value.kind === undefined || value.kind === 'port') &&
    nonEmptyString(value.node) && nonEmptyString(value.port) &&
    (value.members === undefined || stringArray(value.members, false))
}

function validBinding(value: Json | undefined): boolean {
  return isObj(value) && exactKeys(value, ['kind', 'node', 'port'], ['members', 'slots']) &&
    (value.kind === 'port' || value.kind === 'family' || value.kind === 'slot' || value.kind === 'dynamicCombo') && nonEmptyString(value.node) && nonEmptyString(value.port) &&
    (value.members === undefined || stringArray(value.members, false)) &&
    (value.slots === undefined || value.kind === 'family' && stringArray(value.slots, false))
}

function validRoute(value: Json | undefined): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((leg) =>
    isObj(leg) && exactKeys(leg, ['graph', 'boundaryId', 'binding']) &&
    nonEmptyString(leg.graph) && nonEmptyString(leg.boundaryId) && validBinding(leg.binding))
}

function validOccurrenceEndpoint(value: Json | undefined): boolean {
  if (!isObj(value)) return false
  if (value.kind === 'body') return exactKeys(value, ['kind', 'endpoint']) && validLinkEndpoint(value.endpoint)
  return value.kind === 'boundary' && exactKeys(value, ['kind', 'occurrence', 'address', 'route']) &&
    ownerFromJson(value.occurrence) !== undefined && isObj(value.address) &&
    exactKeys(value.address, ['port'], ['members']) && nonEmptyString(value.address.port) &&
    (value.address.members === undefined || stringArray(value.address.members, false)) && validRoute(value.route)
}

function validParentDelivery(value: Json | undefined): boolean {
  if (!isObj(value)) return false
  if (value.kind === 'link')
    return exactKeys(value, ['kind', 'graph', 'linkId']) && nonEmptyString(value.graph) && nonEmptyString(value.linkId)
  return value.kind === 'netSink' && exactKeys(value, ['kind', 'graph', 'netId', 'to']) &&
    nonEmptyString(value.graph) && nonEmptyString(value.netId) && validLinkEndpoint(value.to)
}

function validIdentity(value: Json | undefined, marker = false): boolean {
  if (!isObj(value) || !nonEmptyString(value.kind)) return false
  if (marker && (value.kind === 'none' || value.kind === 'new')) return exactKeys(value, ['kind'])
  if (value.kind === 'definition' || value.kind === 'parent')
    return exactKeys(value, ['kind', 'graphId', 'linkId']) && nonEmptyString(value.graphId) && nonEmptyString(value.linkId)
  if (value.kind === 'definitionNetSink' || value.kind === 'parentNetSink')
    return exactKeys(value, ['kind', 'graphId', 'netId', 'to']) && nonEmptyString(value.graphId) &&
      nonEmptyString(value.netId) && validLinkEndpoint(value.to)
  if (value.kind === 'parentLeg')
    return exactKeys(value, ['kind', 'delivery', 'route']) && validParentDelivery(value.delivery) && validRoute(value.route)
  return value.kind === 'occurrence' && exactKeys(value, ['kind', 'owner', 'linkId']) &&
    ownerFromJson(value.owner) !== undefined && nonEmptyString(value.linkId)
}

function validDynamicState(value: Json | undefined, depth = 0): boolean {
  if (!isObj(value) || depth > 16 || !exactKeys(value, [], ['members', 'memberLabels', 'seq', 'selected', 'memberState'])) return false
  if (value.members !== undefined && !stringArray(value.members, false)) return false
  if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0)) return false
  if (value.selected !== undefined && !nonEmptyString(value.selected)) return false
  if (value.memberLabels !== undefined && (!isObj(value.memberLabels) ||
      !Object.entries(value.memberLabels).every(([member, label]) => member.length > 0 && nonEmptyString(label)))) return false
  if (value.memberState === undefined) return true
  return isObj(value.memberState) && Object.entries(value.memberState).every(([member, scope]) =>
    member.length > 0 && isObj(scope) && Object.values(scope).every((state) => validDynamicState(state, depth + 1)))
}

export interface OccurrenceLinkPlanEndpoint {
  readonly graphId: string
  readonly instancePath: readonly string[]
  readonly endpoint: ResolvedOccurrenceEndpoint['endpoint']
  readonly authored: OccurrenceLinkEndpoint
}

export interface OccurrenceLinkPlanDelivery {
  readonly identity: EffectiveLinkIdentity | { readonly kind: 'new' }
  readonly from: OccurrenceLinkPlanEndpoint
  readonly to: OccurrenceLinkPlanEndpoint
  readonly displacedDriver: EffectiveLinkIdentity | { readonly kind: 'none' }
}

export interface OccurrenceLinkPlan {
  readonly version: typeof PLAN_VERSION
  readonly deliveries: readonly OccurrenceLinkPlanDelivery[]
  readonly consultedDefinitionIds: readonly string[]
  readonly allocator: { readonly floor: number }
  readonly materializations: readonly OccurrenceLinkMaterialization[]
}

export interface OccurrenceLinkMaterialization {
  readonly graphId: string
  readonly nodeId: string
  readonly construct: string
  readonly state: DynamicPortState
}

export interface PlannedOccurrenceLinkInvocation {
  readonly invocation: CommandInvocation
  readonly schemaSnapshot: Readonly<Record<string, NodeSchema>>
  readonly plan: OccurrenceLinkPlan
  readonly expectedTopologyFingerprint: string
  readonly planDigest: string
}

type OccurrenceCommand = 'occurrence.link.connect' | 'occurrence.link.disconnect' | 'occurrence.link.rewire' | 'occurrence.link.rewireSource'

export interface OccurrenceLinkIntent {
  readonly command: OccurrenceCommand
  readonly owner: OccurrenceRef
  readonly bodyGraph: string
  readonly from?: OccurrenceLinkEndpoint
  readonly to?: OccurrenceLinkEndpoint
  readonly link?: EffectiveLinkIdentity
  readonly links?: readonly EffectiveLinkIdentity[]
}

const planEndpoint = (endpoint: ResolvedOccurrenceEndpoint): OccurrenceLinkPlanEndpoint => ({
  graphId: endpoint.graphId,
  instancePath: endpoint.instancePath,
  endpoint: endpoint.endpoint,
  authored: endpoint.source.kind === 'occurrence'
    ? endpoint.source.endpoint
    : { kind: 'body', endpoint: endpoint.source.endpoint },
})

const identityKey = (identity: EffectiveLinkIdentity): string => canonicalJson(identity)
const isRegionIndexSource = (endpoint: OccurrenceLinkEndpoint): boolean =>
  endpoint.kind === 'body' && isPortEndpoint(endpoint.endpoint) &&
  endpoint.endpoint.node === '$region' && endpoint.endpoint.port === 'index' && endpoint.endpoint.members === undefined
const identityOwnedBy = (identity: EffectiveLinkIdentity, owner: OccurrenceRef): boolean =>
  identity.kind !== 'occurrence' || occurrenceKey(identity.owner) === occurrenceKey(owner)

function topologyFor(doc: WorkflowDocument, owner: OccurrenceRef): OccurrenceTopology | undefined {
  return doc.occurrenceTopologies?.[occurrenceKey(owner)]
}

function allocatorFloor(doc: WorkflowDocument, owner: OccurrenceRef): number {
  return topologyFor(doc, owner)?.nextOrdinal ?? 0
}

function materializedDocument(
  doc: WorkflowDocument,
  resolver: SchemaResolver,
  intent: OccurrenceLinkIntent,
): { readonly document: WorkflowDocument; readonly materializations: readonly OccurrenceLinkMaterialization[] } | undefined {
  const endpoints = [
    ...(intent.from === undefined ? [] : [{ endpoint: intent.from, side: 'from' as const }]),
    ...(intent.to === undefined ? [] : [{ endpoint: intent.to, side: 'to' as const }]),
  ]
  let current = doc
  const materializations: OccurrenceLinkMaterialization[] = []
  for (const { endpoint, side } of endpoints) {
    if (endpoint.kind !== 'boundary' || endpoint.address.members === undefined) continue
    let graph = current.graphs[current.root]
    for (const hop of endpoint.occurrence.instancePath) {
      const node = graph?.nodes[hop]
      const bodyId = node?.type.startsWith('#') ? node.type.slice(1) : undefined
      graph = bodyId === undefined ? undefined : current.graphs[bodyId]
    }
    const node = graph?.nodes[endpoint.occurrence.node]
    if (!graph || !node) return undefined
    const schema = documentNodeResolver(current, resolver)(graph.id, node)
    if (!schema) return undefined
    const elaborated = elaborateInterface(schema, node)
    const candidates = side === 'from' ? elabOutputsOf(elaborated) : elabInputsOf(elaborated)
    const offered = candidates.find((item) => item.address.port === endpoint.address.port &&
      canonicalJson(item.address.members ?? null) === canonicalJson(endpoint.address.members ?? null))
    const frames = offered && materializeFramesOf(elaborated.items, offered)
    if (!frames) continue
    const applied = applyMaterializeFrames(node.dynamic ?? {}, frames)
    if (!applied) return undefined
    const construct = frames[0]!.construct
    const nextState = applied[construct]
    if (!nextState) return undefined
    materializations.push({ graphId: graph.id, nodeId: node.id, construct, state: nextState })
    current = {
      ...current,
      graphs: {
        ...current.graphs,
        [graph.id]: {
          ...graph,
          nodes: {
            ...graph.nodes,
            [node.id]: {
              ...node,
              dynamic: applied,
            },
          },
        },
      },
    }
  }
  return { document: current, materializations }
}

function applyMaterializeFrames(
  dynamic: Readonly<Record<string, DynamicPortState>>,
  frames: readonly MaterializeFrame[],
): Readonly<Record<string, DynamicPortState>> | undefined {
  const apply = (scope: Readonly<Record<string, DynamicPortState>>, index: number): Readonly<Record<string, DynamicPortState>> | undefined => {
    const frame = frames[index]
    if (!frame || frame.members.length === 0) return undefined
    const state = scope[frame.construct] ?? {}
    const members = [...(state.members ?? [])]
    for (const member of frame.members) if (!members.includes(member)) members.push(member)
    const suffixes = members.map((member) => /^m(\d{1,15})$/.exec(member)?.[1]).filter((value): value is string => value !== undefined)
    let next: DynamicPortState = { ...state, members, seq: Math.max(state.seq ?? 0, 0, ...suffixes.map((value) => Number(value) + 1)) }
    if (index + 1 < frames.length) {
      const member = frame.members.at(-1)!
      const child = apply(state.memberState?.[member] ?? {}, index + 1)
      if (!child) return undefined
      next = { ...next, memberState: { ...(state.memberState ?? {}), [member]: child } }
    }
    return { ...scope, [frame.construct]: next }
  }
  return apply(dynamic, 0)
}

function driverOf(links: readonly EffectiveLink[], target: OccurrenceLinkPlanEndpoint, except?: EffectiveLinkIdentity): EffectiveLink | undefined {
  return links.find((link) =>
    (except === undefined || identityKey(link.identity) !== identityKey(except)) &&
    link.to.graphId === target.graphId &&
    canonicalJson(link.to.instancePath) === canonicalJson(target.instancePath) &&
    sameEndpoint(link.to.endpoint, target.endpoint),
  )
}

function occurrenceTopologyProjection(
  doc: WorkflowDocument,
  owner: OccurrenceRef,
  plan: OccurrenceLinkPlan,
): unknown | undefined {
  const ownerNodes: unknown[] = []
  let graph = doc.graphs[doc.root]
  const ownerSegments = [...owner.instancePath, owner.node]
  for (const [index, nodeId] of ownerSegments.entries()) {
    const node = graph?.nodes[nodeId]
    if (!graph || !node) return undefined
    ownerNodes.push({ graphId: graph.id, id: node.id, type: node.type, dynamic: node.dynamic ?? null })
    if (index < ownerSegments.length - 1) {
      const bodyId = node.type.startsWith('#') ? node.type.slice(1) : undefined
      graph = bodyId === undefined ? undefined : doc.graphs[bodyId]
    }
  }
  const boundaryItems = plan.deliveries.flatMap((delivery) =>
    [delivery.from.authored, delivery.to.authored].flatMap((endpoint) => endpoint.kind === 'boundary'
      ? endpoint.route.map((leg) => {
          const definition = doc.graphs[leg.graph]
          const item = [...(definition?.boundary?.inputs ?? []), ...(definition?.boundary?.outputs ?? [])]
            .find((candidate) => candidate.id === leg.boundaryId)
          return { graph: leg.graph, boundaryId: leg.boundaryId, item: item ?? null }
        })
      : []),
  )
  const definitions = plan.consultedDefinitionIds.map((graphId) => {
    const definition = doc.graphs[graphId]
    return definition === undefined ? null : {
      id: definition.id,
      nodes: Object.values(definition.nodes).map((node) => ({ id: node.id, type: node.type, dynamic: node.dynamic ?? null })),
      links: definition.links,
      nets: definition.nets,
      boundary: definition.boundary ?? null,
    }
  })
  return {
    version: PLAN_VERSION,
    owner,
    ownerNodes,
    deliveries: plan.deliveries,
    boundaryItems,
    definitions,
    allocator: plan.allocator,
    materializations: plan.materializations,
  }
}

function occurrenceTopologyFingerprint(
  doc: WorkflowDocument,
  owner: OccurrenceRef,
  plan: OccurrenceLinkPlan,
): string | undefined {
  const projection = occurrenceTopologyProjection(doc, owner, plan)
  return projection === undefined ? undefined : lifecycleCanonicalHash(projection)
}

export function occurrenceLinkPlanDigest(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  plan: OccurrenceLinkPlan,
  expectedTopologyFingerprint: string,
): string {
  return lifecycleCanonicalHash({
    version: DIGEST_VERSION,
    schemas: Object.keys(schemaSnapshot).sort(compareStrings).map((authoredType) => ({ authoredType, schema: schemaSnapshot[authoredType] })),
    plan,
    expectedTopologyFingerprint,
  })
}

function resolvePlannedEndpoint(
  doc: WorkflowDocument,
  resolver: SchemaResolver,
  owner: OccurrenceRef,
  endpoint: OccurrenceLinkEndpoint,
  side: 'from' | 'to',
): OccurrenceLinkPlanEndpoint | undefined {
  const result = resolveOccurrenceLinkEndpoint(doc, resolver, owner, endpoint, side)
  return result.endpoint === undefined || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? undefined
    : planEndpoint(result.endpoint)
}

function buildPlan(
  doc: WorkflowDocument,
  resolver: SchemaResolver,
  intent: OccurrenceLinkIntent,
): OccurrenceLinkPlan | undefined {
  const staged = materializedDocument(doc, resolver, intent)
  if (!staged) return undefined
  const effective = effectiveOccurrenceTopology(staged.document, resolver, intent.owner)
  if (effective.bodyGraph.id !== intent.bodyGraph || effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return undefined
  const allLinks = [...effective.links, ...effective.projectedParentLinks]
  const byIdentity = new Map(allLinks.map((link) => [identityKey(link.identity), link]))
  const requestedFrom = intent.from && resolvePlannedEndpoint(staged.document, resolver, intent.owner, intent.from, 'from')
  const requestedTo = intent.to && resolvePlannedEndpoint(staged.document, resolver, intent.owner, intent.to, 'to')
  const deliveries: OccurrenceLinkPlanDelivery[] = []
  if (intent.command === 'occurrence.link.connect') {
    if (!requestedFrom || !requestedTo) return undefined
    const displaced = driverOf(allLinks, requestedTo)
    if (displaced && !identityOwnedBy(displaced.identity, intent.owner)) return undefined
    if (displaced?.identity.kind === 'parent' || displaced?.identity.kind === 'parentNetSink') return undefined
    if (displaced?.identity.kind === 'parentLeg') {
      const delivery = displaced.identity.delivery
      const legCount = effective.projectedParentLinks.filter((link) =>
        link.identity.kind === 'parentLeg' && canonicalJson(link.identity.delivery) === canonicalJson(delivery),
      ).length
      if (legCount <= 1) return undefined
    }
    deliveries.push({
      identity: { kind: 'new' }, from: requestedFrom, to: requestedTo,
      displacedDriver: displaced?.identity ?? { kind: 'none' },
    })
  } else {
    const identities = intent.command === 'occurrence.link.rewireSource' ? intent.links : intent.link === undefined ? undefined : [intent.link]
    if (!identities || identities.length === 0) return undefined
    for (const identity of identities) {
      if (!identityOwnedBy(identity, intent.owner)) return undefined
      const current = byIdentity.get(identityKey(identity))
      if (!current) return undefined
      if (identity.kind === 'parent' || identity.kind === 'parentNetSink') return undefined
      if (identity.kind === 'parentLeg') {
        const legCount = effective.projectedParentLinks.filter((link) =>
          link.identity.kind === 'parentLeg' && canonicalJson(link.identity.delivery) === canonicalJson(identity.delivery),
        ).length
        if (legCount <= 1 || intent.command !== 'occurrence.link.disconnect') return undefined
      }
      if ((identity.kind === 'definition' || identity.kind === 'definitionNetSink') &&
          ((intent.command === 'occurrence.link.rewire' && intent.to?.kind === 'body') ||
           (intent.command === 'occurrence.link.rewireSource' && intent.from?.kind === 'body'))) return undefined
      const from = intent.command === 'occurrence.link.rewireSource' ? requestedFrom : planEndpoint(current.from)
      const to = intent.command === 'occurrence.link.rewire' ? requestedTo : planEndpoint(current.to)
      if (!from || !to) return undefined
      const displacedDriver = intent.command === 'occurrence.link.disconnect'
        ? { kind: 'none' as const }
        : driverOf(allLinks, to, identity)?.identity ?? { kind: 'none' as const }
      if (displacedDriver.kind !== 'none' && !identityOwnedBy(displacedDriver, intent.owner)) return undefined
      deliveries.push({
        identity,
        from,
        to,
        displacedDriver,
      })
    }
  }
  const consultedDefinitionIds = new Set<string>([effective.bodyGraph.id])
  for (const delivery of deliveries) {
    for (const endpoint of [delivery.from.authored, delivery.to.authored]) {
      if (endpoint.kind === 'boundary') for (const leg of endpoint.route) consultedDefinitionIds.add(leg.graph)
    }
  }
  const plan: OccurrenceLinkPlan = {
    version: PLAN_VERSION,
    deliveries,
    consultedDefinitionIds: [...consultedDefinitionIds].sort(compareStrings),
    allocator: { floor: allocatorFloor(doc, intent.owner) },
    materializations: staged.materializations,
  }
  const prospective = createTransactionBuilder(doc)
  const mutationFailure = executeMutation(intent.command, intent, plan, prospective)
  if (mutationFailure.length > 0) return undefined
  const checked = effectiveOccurrenceTopology(prospective.current, resolver, intent.owner)
  return checked.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? undefined : plan
}

/** Build the immutable snapshot-backed invocation consumed by all execution contexts. */
export function planOccurrenceLinkCommand(
  doc: WorkflowDocument,
  resolver: SchemaResolver,
  intent: OccurrenceLinkIntent,
): PlannedOccurrenceLinkInvocation | undefined {
  const schemaSnapshot: Record<string, NodeSchema> = {}
  const tracked: SchemaResolver = (type) => {
    const schema = resolver(type)
    if (schema !== undefined) schemaSnapshot[type] = schema
    return schema
  }
  const plan = buildPlan(doc, tracked, intent)
  const expectedTopologyFingerprint = plan && occurrenceTopologyFingerprint(doc, intent.owner, plan)
  if (!plan || !expectedTopologyFingerprint) return undefined
  const params = {
    owner: intent.owner,
    bodyGraph: intent.bodyGraph,
    ...(intent.from ? { from: intent.from } : {}),
    ...(intent.to ? { to: intent.to } : {}),
    ...(intent.link ? { link: intent.link } : {}),
    ...(intent.links ? { links: intent.links } : {}),
    expectedTopologyFingerprint,
    plan,
    schemaSnapshot,
    planDigest: occurrenceLinkPlanDigest(schemaSnapshot, plan, expectedTopologyFingerprint),
  }
  return { invocation: { command: intent.command, params: params as unknown as Json }, schemaSnapshot, plan, expectedTopologyFingerprint, planDigest: params.planDigest }
}

function ownerFromJson(value: Json | undefined): OccurrenceRef | undefined {
  if (!isObj(value) || !exactKeys(value, ['instancePath', 'node']) ||
      !Array.isArray(value.instancePath) || !value.instancePath.every((id) => typeof id === 'string' && id.length > 0) ||
      typeof value.node !== 'string' || value.node.length === 0) return undefined
  return value as unknown as OccurrenceRef
}

function intentFromParams(command: OccurrenceCommand, params: Json): OccurrenceLinkIntent | undefined {
  if (!isObj(params) || typeof params.bodyGraph !== 'string') return undefined
  const owner = ownerFromJson(params.owner)
  if (!owner) return undefined
  return {
    command, owner, bodyGraph: params.bodyGraph,
    ...(params.from !== undefined ? { from: params.from as unknown as OccurrenceLinkEndpoint } : {}),
    ...(params.to !== undefined ? { to: params.to as unknown as OccurrenceLinkEndpoint } : {}),
    ...(params.link !== undefined ? { link: params.link as unknown as EffectiveLinkIdentity } : {}),
    ...(Array.isArray(params.links) ? { links: params.links as unknown as readonly EffectiveLinkIdentity[] } : {}),
  }
}

function validateTrustedPlan(command: OccurrenceCommand, doc: WorkflowDocument, params: Json): readonly Diagnostic[] {
  if (!isObj(params) || !isObj(params.plan) || !isObj(params.schemaSnapshot) ||
      typeof params.expectedTopologyFingerprint !== 'string' || typeof params.planDigest !== 'string') {
    return [err('params.invalid', `${command}: malformed trusted plan`)]
  }
  const plan = params.plan as unknown as OccurrenceLinkPlan
  const commandKeys: Record<OccurrenceCommand, readonly string[]> = {
    'occurrence.link.connect': ['owner', 'bodyGraph', 'from', 'to'],
    'occurrence.link.disconnect': ['owner', 'bodyGraph', 'link'],
    'occurrence.link.rewire': ['owner', 'bodyGraph', 'link', 'to'],
    'occurrence.link.rewireSource': ['owner', 'bodyGraph', 'links', 'from'],
  }
  if (!exactKeys(params, [...commandKeys[command], 'expectedTopologyFingerprint', 'plan', 'schemaSnapshot', 'planDigest']))
    return [err('params.invalid', `${command}: malformed command intention`)]
  const planShape = exactKeys(params.plan, ['version', 'deliveries', 'consultedDefinitionIds', 'allocator', 'materializations']) &&
    plan.version === PLAN_VERSION && Array.isArray(plan.deliveries) &&
    plan.deliveries.every((delivery) => {
      const value = delivery as unknown as Json
      if (!isObj(value) || !exactKeys(value, ['identity', 'from', 'to', 'displacedDriver'])) return false
      if (!validIdentity(value.identity, true) || !validIdentity(value.displacedDriver, true)) return false
      return [value.from, value.to].every((endpoint) => isObj(endpoint) &&
        exactKeys(endpoint, ['graphId', 'instancePath', 'endpoint', 'authored']) &&
        nonEmptyString(endpoint.graphId) && stringArray(endpoint.instancePath) &&
        validLinkEndpoint(endpoint.endpoint) && validOccurrenceEndpoint(endpoint.authored))
    }) &&
    stringArray(plan.consultedDefinitionIds, false) && new Set(plan.consultedDefinitionIds).size === plan.consultedDefinitionIds.length &&
    Array.isArray(plan.materializations) && plan.materializations.every((entry) => {
      const value = entry as unknown as Json
      return isObj(value) && exactKeys(value, ['graphId', 'nodeId', 'construct', 'state']) &&
        nonEmptyString(value.graphId) && nonEmptyString(value.nodeId) &&
        nonEmptyString(value.construct) && validDynamicState(value.state)
    }) &&
    isObj(params.plan.allocator) && exactKeys(params.plan.allocator, ['floor']) &&
    Number.isSafeInteger(params.plan.allocator.floor) && Number(params.plan.allocator.floor) >= 0
  if (!planShape)
    return [err('params.invalid', `${command}: malformed trusted plan`)]
  const snapshot = params.schemaSnapshot as unknown as Record<string, NodeSchema>
  for (const [type, schema] of Object.entries(snapshot)) {
    if (!type || typeof schema !== 'object' || schema === null || schema.type !== type || !Array.isArray(schema.items))
      return [err('params.invalid', `${command}: schema snapshot is malformed`)]
  }
  if (occurrenceLinkPlanDigest(snapshot, plan, params.expectedTopologyFingerprint) !== params.planDigest)
    return [err('occurrence.link.stalePlan', `${command}: trusted plan digest does not match`)]
  const intent = intentFromParams(command, params)
  if (!intent) return [err('params.invalid', `${command}: malformed command intention`)]
  if ((intent.from !== undefined && !validOccurrenceEndpoint(params.from)) ||
      (intent.to !== undefined && !validOccurrenceEndpoint(params.to)) ||
      (intent.link !== undefined && !validIdentity(params.link)) ||
      (intent.links !== undefined && (!intent.links.every((_, index) => validIdentity((params.links as readonly Json[])[index])) ||
        new Set(intent.links.map(identityKey)).size !== intent.links.length)))
    return [err('params.invalid', `${command}: malformed command intention`)]
  const consulted = new Set<string>()
  const snapshotResolver: SchemaResolver = (type) => {
    consulted.add(type)
    return snapshot[type]
  }
  const rebuilt = buildPlan(doc, snapshotResolver, intent)
  const fingerprint = rebuilt && occurrenceTopologyFingerprint(doc, intent.owner, rebuilt)
  const exactCoverage = canonicalJson([...consulted].sort(compareStrings)) === canonicalJson(Object.keys(snapshot).sort(compareStrings))
  if (!exactCoverage)
    return [err('occurrence.link.schemaCoverage', `${command}: schema snapshot coverage is not exact`)]
  if (!rebuilt || !fingerprint || fingerprint !== params.expectedTopologyFingerprint || canonicalJson(rebuilt) !== canonicalJson(plan))
    return [err('occurrence.link.stalePlan', `${command}: occurrence topology changed after planning`)]
  return []
}

function topologyPath(owner: OccurrenceRef): readonly string[] {
  return ['occurrenceTopologies', occurrenceKey(owner)]
}

function ensureTopology(tx: TransactionBuilder, owner: OccurrenceRef, bodyGraph: string): OccurrenceTopology {
  const key = occurrenceKey(owner)
  const current = tx.current.occurrenceTopologies?.[key]
  if (current) return current
  if (tx.current.occurrenceTopologies === undefined) tx.set(['occurrenceTopologies'], {})
  const created: OccurrenceTopology = { owner, bodyGraph: bodyGraph as OccurrenceTopology['bodyGraph'], links: {}, nextOrdinal: 0 }
  tx.set(['occurrenceTopologies', key], created as unknown as Json)
  return created
}

function addSuppression(tx: TransactionBuilder, owner: OccurrenceRef, bodyGraph: string, suppression: SuppressedDelivery): void {
  const topology = ensureTopology(tx, owner, bodyGraph)
  const suppressions = [...(topology.suppressedDeliveries ?? []), suppression]
    .sort((a, b) => compareStrings(suppressedDeliveryKey(a), suppressedDeliveryKey(b)))
    .filter((value, index, all) => index === 0 || suppressedDeliveryKey(value) !== suppressedDeliveryKey(all[index - 1]!))
  tx.set([...topologyPath(owner), 'suppressedDeliveries'], suppressions as unknown as Json)
}

function removeSuppression(tx: TransactionBuilder, owner: OccurrenceRef, suppression: SuppressedDelivery): boolean {
  const topology = topologyFor(tx.current, owner)
  const wanted = suppressedDeliveryKey(suppression)
  const kept = (topology?.suppressedDeliveries ?? []).filter((entry) => suppressedDeliveryKey(entry) !== wanted)
  if (kept.length === (topology?.suppressedDeliveries?.length ?? 0)) return false
  if (kept.length === 0) tx.remove([...topologyPath(owner), 'suppressedDeliveries'])
  else tx.set([...topologyPath(owner), 'suppressedDeliveries'], kept as unknown as Json)
  return true
}

function unsuppressExactBodyDelivery(
  tx: TransactionBuilder,
  owner: OccurrenceRef,
  bodyGraph: string,
  from: OccurrenceLinkEndpoint,
  to: OccurrenceLinkEndpoint,
): boolean {
  if (from.kind !== 'body' || to.kind !== 'body') return false
  const graph = tx.current.graphs[bodyGraph]
  if (!graph) return false
  for (const link of Object.values(graph.links)) {
    if (sameEndpoint(link.from, from.endpoint) && sameEndpoint(link.to, to.endpoint) &&
        removeSuppression(tx, owner, { kind: 'link', linkId: link.id })) return true
  }
  if (!isPortEndpoint(from.endpoint) || !isPortEndpoint(to.endpoint)) return false
  for (const net of Object.values(graph.nets)) {
    if (sameEndpoint(net.source, from.endpoint) && net.sinks.some((sink) => sameEndpoint(sink, to.endpoint)) &&
        removeSuppression(tx, owner, { kind: 'netSink', netId: net.id, to: to.endpoint })) return true
  }
  return false
}

function suppressIdentity(tx: TransactionBuilder, owner: OccurrenceRef, bodyGraph: string, identity: EffectiveLinkIdentity): Diagnostic | undefined {
  if (identity.kind === 'definition') addSuppression(tx, owner, bodyGraph, { kind: 'link', linkId: identity.linkId })
  else if (identity.kind === 'definitionNetSink') addSuppression(tx, owner, bodyGraph, { kind: 'netSink', netId: identity.netId, to: identity.to })
  else if (identity.kind === 'parentLeg') addSuppression(tx, owner, bodyGraph, { kind: 'projectedLeg', delivery: identity.delivery, route: identity.route })
  else return err('occurrence.link.ownershipConversionUnsupported', 'occurrence link command: projected parent ownership conversion is unsupported')
  return undefined
}

function removeIdentity(tx: TransactionBuilder, owner: OccurrenceRef, bodyGraph: string, identity: EffectiveLinkIdentity): Diagnostic | undefined {
  if (identity.kind === 'occurrence') {
    if (!identityOwnedBy(identity, owner))
      return err('occurrence.link.ownerMismatch', 'occurrence link command: local link belongs to a different occurrence')
    const topology = topologyFor(tx.current, owner)
    if (!topology?.links[identity.linkId]) return err('link.missing', `occurrence link command: unknown local link '${identity.linkId}'`)
    tx.remove([...topologyPath(owner), 'links', identity.linkId])
    return undefined
  }
  return suppressIdentity(tx, owner, bodyGraph, identity)
}

function allocateLocalLink(tx: TransactionBuilder, owner: OccurrenceRef, bodyGraph: string): string {
  const topology = ensureTopology(tx, owner, bodyGraph)
  const actor = tx.actor
  const ordinal = actor === undefined ? topology.nextOrdinal : actorCursorOf(topology.actorCursors, actor)
  const id = formatAllocatedId('l', guardOrdinal(ordinal), actor)
  if (actor === undefined) tx.set([...topologyPath(owner), 'nextOrdinal'], ordinal + 1)
  else if (topology.actorCursors === undefined) tx.set([...topologyPath(owner), 'actorCursors'], { [actor]: ordinal + 1 })
  else tx.set([...topologyPath(owner), 'actorCursors', actor], ordinal + 1)
  return id
}

function addLocalLink(tx: TransactionBuilder, owner: OccurrenceRef, bodyGraph: string, from: OccurrenceLinkEndpoint, to: OccurrenceLinkEndpoint): void {
  const id = allocateLocalLink(tx, owner, bodyGraph)
  const link: OccurrenceLinkData = { id: asLinkId(id), from, to }
  tx.set([...topologyPath(owner), 'links', id], link as unknown as Json)
}

function endpointFromParams(params: JsonObject, key: 'from' | 'to'): OccurrenceLinkEndpoint | undefined {
  return isObj(params[key]) ? params[key] as unknown as OccurrenceLinkEndpoint : undefined
}

function executeMutation(
  command: OccurrenceCommand,
  raw: OccurrenceLinkIntent | JsonObject,
  plan: OccurrenceLinkPlan,
  tx: TransactionBuilder,
): readonly Diagnostic[] {
  const owner = raw.owner as OccurrenceRef
  const bodyGraph = raw.bodyGraph as string
  if (tx.actor === undefined && plan.allocator.floor !== allocatorFloor(tx.current, owner))
    return [err('occurrence.link.stalePlan', `${command}: allocator floor changed after planning`)]
  for (const materialization of plan.materializations) {
    const node = tx.current.graphs[materialization.graphId]?.nodes[materialization.nodeId]
    if (!node) return [err('occurrence.link.stalePlan', `${command}: materialization owner changed after planning`)]
    tx.set(
      ['graphs', materialization.graphId, 'nodes', materialization.nodeId, 'dynamic'],
      { ...(node.dynamic ?? {}), [materialization.construct]: materialization.state } as unknown as Json,
    )
  }
  if (command === 'occurrence.link.disconnect') {
    const identity = raw.link as EffectiveLinkIdentity
    const failure = removeIdentity(tx, owner, bodyGraph, identity)
    return failure ? [failure] : []
  }
  const from = raw.from as OccurrenceLinkEndpoint | undefined
  const to = raw.to as OccurrenceLinkEndpoint | undefined
  if (command === 'occurrence.link.connect') {
    if (!from || !to) return [err('params.invalid', `${command}: from and to are required`)]
    const displaced = plan.deliveries[0]?.displacedDriver
    if (displaced && displaced.kind !== 'none') {
      const failure = removeIdentity(tx, owner, bodyGraph, displaced)
      if (failure) return [failure]
    }
    if (unsuppressExactBodyDelivery(tx, owner, bodyGraph, from, to)) return []
    if (from.kind === 'body' && to.kind === 'body' && !isRegionIndexSource(from))
      return [err('occurrence.link.sharedDefinition', `${command}: definition-only connections use link.connect`)]
    addLocalLink(tx, owner, bodyGraph, from, to)
    return []
  }
  if (command === 'occurrence.link.rewire') {
    if (!to || !raw.link) return [err('params.invalid', `${command}: link and to are required`)]
    const identity = raw.link as EffectiveLinkIdentity
    const delivery = plan.deliveries[0]
    if (!delivery) return [err('params.invalid', `${command}: plan has no delivery`)]
    if (delivery.displacedDriver.kind !== 'none') {
      const failure = removeIdentity(tx, owner, bodyGraph, delivery.displacedDriver)
      if (failure) return [failure]
    }
    if (identity.kind === 'occurrence') {
      if (!identityOwnedBy(identity, owner))
        return [err('occurrence.link.ownerMismatch', `${command}: local link belongs to a different occurrence`)]
      tx.set([...topologyPath(owner), 'links', identity.linkId, 'to'], to as unknown as Json)
      return []
    }
    const failure = suppressIdentity(tx, owner, bodyGraph, identity)
    if (failure) return [failure]
    addLocalLink(tx, owner, bodyGraph, delivery.from.authored, to)
    return []
  }
  const links = raw.links as readonly EffectiveLinkIdentity[] | undefined
  if (!from || !links) return [err('params.invalid', `${command}: links and from are required`)]
  for (const [index, identity] of links.entries()) {
    const delivery = plan.deliveries[index]
    if (!delivery) return [err('params.invalid', `${command}: plan is missing a delivery`)]
    if (identity.kind === 'occurrence') {
      if (!identityOwnedBy(identity, owner))
        return [err('occurrence.link.ownerMismatch', `${command}: local link belongs to a different occurrence`)]
      tx.set([...topologyPath(owner), 'links', identity.linkId, 'from'], from as unknown as Json)
      continue
    }
    const failure = suppressIdentity(tx, owner, bodyGraph, identity)
    if (failure) return [failure]
    addLocalLink(tx, owner, bodyGraph, from, delivery.to.authored)
  }
  return []
}

function commandOf(command: OccurrenceCommand): CommandDefinition {
  return {
    id: command,
    validateDispatch(doc, params) {
      return validateTrustedPlan(command, doc, params)
    },
    run(_doc, raw, tx) {
      if (!isObj(raw) || !isObj(raw.plan) || !isObj(raw.plan.allocator)) return [err('params.invalid', `${command}: malformed trusted plan`)]
      const owner = ownerFromJson(raw.owner)
      if (!owner || typeof raw.bodyGraph !== 'string') return [err('params.invalid', `${command}: malformed owner`)]
      const plan = raw.plan as unknown as OccurrenceLinkPlan
      return executeMutation(command, raw, plan, tx)
    },
  }
}

export const OCCURRENCE_LINK_COMMANDS: readonly CommandDefinition[] = [
  commandOf('occurrence.link.connect'),
  commandOf('occurrence.link.disconnect'),
  commandOf('occurrence.link.rewire'),
  commandOf('occurrence.link.rewireSource'),
]
