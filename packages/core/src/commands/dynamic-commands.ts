/**
 * Dynamic-state commands: the write path for `NodeData.dynamic`.
 *
 * Elaboration synthesizes min-fill members and one trailing ghost per family
 * as VIEW affordances; a committed document must never reference them as
 * link endpoints (hazard N3) - the compiler rejects such references. These
 * commands are how synthetic members become real:
 *
 * - `dynamic.materialize` persists family members (append-only, idempotent).
 *   The UI batches it with the action that grows the family (link.connect,
 *   node.setValue) so materialization is transactionally atomic with its
 *   cause - one undo step removes both.
 * - selection commands write a schema-authored dynamic choice (state.selected).
 *
 * Commands validate structure and copy inherited boundary state on write.
 * Shared replay carries a validated snapshot instead of consulting schemas.
 * The caller derives frames from the elaborated interface.
 *
 * Works identically for normal nodes and subgraph instances: an instance's
 * forwarded-family suffix state lives on the instance node in its parent
 * graph (keyed by the boundary item id), never on the definition - so
 * growing one instance can never leak into the shared definition or into
 * sibling instances (hazard F1/F5).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { DynamicPortState, GraphDef, Json, JsonObject, NodeData, WorkflowDocument } from '../format/document.js'
import { isSubtreeBinding, MAX_DYNAMIC_STATE_DEPTH, resolveDynamicAddress } from '../format/document.js'
import { validateGraphDefShape } from '../format/validate.js'
import type { CommandDefinition, CommandExecutionContext } from './contract.js'
import { isPortEndpoint, MAX_MEMBER_ORDINAL } from '../ids.js'
import { addressOfElabKey } from '../schema/elaborate.js'
import { checkDocument, subgraphDefIdOf } from '../invariants.js'
import { boundaryStateResolver } from '../compile/boundary-state.js'
import { documentNodeResolver } from '../compile/compile.js'
import { mergeDynamicScope } from '../compile/crossing.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function graphOf(doc: WorkflowDocument, graphId: Json | undefined): GraphDef | undefined {
  return typeof graphId === 'string' ? doc.graphs[graphId] : undefined
}

/** Snapshot inherited state for deterministic shared replay; authored fields still win. */
const prepareInheritedState: NonNullable<CommandDefinition['prepareForSharedReplay']> = (doc, params, context) => {
  if (!isObj(params) || typeof params.nodeId !== 'string') return undefined
  const graph = graphOf(doc, params.graphId)
  const node = graph?.nodes[params.nodeId]
  if (!graph || !node) return undefined
  const dynamic = inheritedState(doc, graph, node, params, context)
  const { inheritedDynamic: _ignored, ...authored } = params
  return { ok: true, params: { ...authored, ...(dynamic !== undefined ? { inheritedDynamic: dynamic as unknown as Json } : {}) } }
}

const validateInheritedState: NonNullable<CommandDefinition['validateDispatch']> = (doc, params, context) => {
  if (context.kind !== 'shared-replay' || !isObj(params) || params.inheritedDynamic === undefined) return []
  const graph = graphOf(doc, params.graphId)
  const node = typeof params.nodeId === 'string' ? graph?.nodes[params.nodeId] : undefined
  if (!graph || !node) return []
  const problems = validateGraphDefShape({ ...graph, nodes: { [node.id]: { ...node, dynamic: params.inheritedDynamic } } })
  return problems.length ? [err('dynamic.invalidInheritedState', 'inherited boundary state is malformed')] : []
}

function inheritedState(doc: WorkflowDocument, graph: GraphDef, node: NodeData, params: JsonObject, context: CommandExecutionContext): NodeData['dynamic'] {
  if (context.kind === 'shared-replay') return params.inheritedDynamic as NodeData['dynamic']
  const resolve = context.schemaResolverFor?.(doc)
  if (!resolve || subgraphDefIdOf(node.type) === undefined) return undefined
  return boundaryStateResolver(doc, documentNodeResolver(doc, resolve))(graph.id, node).dynamic
}

/**
 * Highest numeric suffix among `m<N>` member ids (-1 when none). Mirrors the
 * elaborator's scan (elaborate.ts) so `seq` stays "next fresh ordinal" even
 * when fixtures hand-write member ids.
 */
const maxMemberSuffix = (ids: Iterable<string>): number => {
  let max = -1
  for (const m of ids) {
    const match = /^m(\d{1,15})$/.exec(m)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

// ---------------------------------------------------------------------------
// dynamic.materialize {graphId, nodeId, frames: [{construct, members[]}...]}
// ---------------------------------------------------------------------------

interface MaterializeFrameJson extends JsonObject {
  readonly construct: string
  readonly members: readonly string[]
}

const isFrame = (v: Json | undefined): v is MaterializeFrameJson =>
  isObj(v) &&
  typeof v.construct === 'string' &&
  v.construct.length > 0 &&
  Array.isArray(v.members) &&
  v.members.length > 0 &&
  v.members.every((m) => typeof m === 'string' && m.length > 0) &&
  new Set(v.members).size === v.members.length

/**
 * Persist `frame.members` into one family scope (append missing, keep
 * order), bump `seq` past every suffix now in use, and recurse into the
 * LAST member's nested scope for the next frame. Appending preserves
 * elaboration order because synthetic members always elaborate AFTER
 * persisted ones - the caller lists them in interface order.
 */
function materializeScope(
  scope: Readonly<Record<string, DynamicPortState>> | undefined,
  frames: readonly MaterializeFrameJson[],
  inherited?: Readonly<Record<string, DynamicPortState>>,
): Record<string, DynamicPortState> {
  const frame = frames[0]!
  const rest = frames.slice(1)
  const state = mergeDynamicScope(inherited, scope)[frame.construct] ?? {}
  const members = [...(state.members ?? [])]
  let grew = false
  for (const m of frame.members) {
    if (members.includes(m)) continue
    // A minted-shaped id whose suffix exceeds the 15-digit parse window
    // would be invisible to the seq bump: the same address could then be
    // offered again as a ghost. Reject it (CO7); dispatch converts the
    // throw into an atomic rejection.
    if (/^m\d+$/.test(m) && !/^m\d{1,15}$/.test(m))
      throw new Error(`member id '${m}' is outside the mintable id space`)
    members.push(m)
    grew = true
  }
  // Exhausted family (seq beyond the mintable window, e.g. from a hostile
  // or corrupted document): growing it could collide a persisted member
  // with the next offered ghost, so growth is refused outright.
  if (grew && (state.seq ?? 0) > MAX_MEMBER_ORDINAL)
    throw new Error(`family '${frame.construct}' member id space exhausted (seq ${state.seq})`)
  const seq = Math.max(state.seq ?? 0, maxMemberSuffix(members) + 1)
  let memberState = state.memberState
  if (rest.length > 0) {
    const chain = frame.members[frame.members.length - 1]!
    memberState = { ...memberState, [chain]: materializeScope(scope?.[frame.construct]?.memberState?.[chain], rest, memberState?.[chain]) }
  }
  return {
    ...scope,
    [frame.construct]: {
      ...state,
      members,
      seq,
      ...(memberState !== undefined ? { memberState } : {}),
    },
  }
}

const dynamicMaterialize: CommandDefinition = {
  id: 'dynamic.materialize',
  prepareForSharedReplay: prepareInheritedState,
  validateDispatch: validateInheritedState,
  run(doc, params, tx, context) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      !Array.isArray(params.frames) ||
      params.frames.length === 0 ||
      !params.frames.every(isFrame)
    )
      return [
        err(
          'params.invalid',
          'dynamic.materialize: params must be {graphId, nodeId, frames: [{construct, members[]}, ...]}',
        ),
      ]
    if (params.frames.length > MAX_DYNAMIC_STATE_DEPTH)
      return [
        err(
          'dynamic.tooDeep',
          `dynamic.materialize: ${params.frames.length} frames exceed the nesting cap of ${MAX_DYNAMIC_STATE_DEPTH}`,
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.materialize: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.materialize: unknown node '${params.nodeId}'`)]

    const frames = params.frames as readonly MaterializeFrameJson[]
    const next = materializeScope(node.dynamic, frames, inheritedState(doc, def, node, params, context))
    // Idempotent: re-materializing persisted members records no transaction.
    if (JSON.stringify(next) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// dynamic.selectOption {graphId, nodeId, ancestors: [{construct, member}...],
//                       construct, option}
// ---------------------------------------------------------------------------

interface AncestorJson extends JsonObject {
  readonly construct: string
  readonly member: string
}

const isAncestor = (v: Json | undefined): v is AncestorJson =>
  isObj(v) &&
  typeof v.construct === 'string' &&
  v.construct.length > 0 &&
  typeof v.member === 'string' &&
  v.member.length > 0

type SelectResult =
  | { readonly ok: true; readonly scope: Record<string, DynamicPortState> }
  | { readonly ok: false; readonly diagnostic: Diagnostic }

/**
 * Set `selected` on the combo construct's state at the (possibly nested)
 * scope, creating missing containers beneath PERSISTED ancestors. Fails when
 * an ancestor member is not persisted: state must never exist beneath a
 * synthetic member (hazard N3) - batch dynamic.materialize first.
 */
function selectInScope(
  scope: Readonly<Record<string, DynamicPortState>> | undefined,
  ancestors: readonly AncestorJson[],
  construct: string,
  option: string | null,
  inherited?: Readonly<Record<string, DynamicPortState>>,
): SelectResult {
  if (ancestors.length === 0) {
    const state = scope?.[construct] ?? {}
    const next = { ...state }
    if (option === null) delete (next as { selected?: string }).selected
    else (next as { selected?: string }).selected = option
    return { ok: true, scope: { ...scope, [construct]: next } }
  }
  const a = ancestors[0]!
  const state = mergeDynamicScope(inherited, scope)[a.construct]
  if (!state?.members?.includes(a.member))
    return {
      ok: false,
      diagnostic: err(
        'dynamic.unmaterializedAncestor',
        `dynamic.selectOption: ancestor member '${a.member}' of family '${a.construct}' is not materialized; batch dynamic.materialize first`,
      ),
    }
  const inner = selectInScope(scope?.[a.construct]?.memberState?.[a.member], ancestors.slice(1), construct, option, state.memberState?.[a.member])
  if (!inner.ok) return inner
  return {
    ok: true,
    scope: {
      ...scope,
      [a.construct]: {
        ...state,
        memberState: { ...state.memberState, [a.member]: inner.scope },
      },
    },
  }
}

const dynamicSelectOption: CommandDefinition = {
  id: 'dynamic.selectOption',
  prepareForSharedReplay: prepareInheritedState,
  validateDispatch: validateInheritedState,
  run(doc, params, tx, context) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      typeof params.construct !== 'string' ||
      params.construct.length === 0 ||
      typeof params.option !== 'string' ||
      (params.ancestors !== undefined &&
        (!Array.isArray(params.ancestors) || !params.ancestors.every(isAncestor)))
    )
      return [
        err(
          'params.invalid',
          'dynamic.selectOption: params must be {graphId, nodeId, ancestors?: [{construct, member}...], construct, option}',
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.selectOption: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.selectOption: unknown node '${params.nodeId}'`)]

    const ancestors = (params.ancestors ?? []) as readonly AncestorJson[]
    if (ancestors.length + 1 > MAX_DYNAMIC_STATE_DEPTH)
      return [
        err(
          'dynamic.tooDeep',
          `dynamic.selectOption: nesting exceeds the cap of ${MAX_DYNAMIC_STATE_DEPTH}`,
        ),
      ]
    const next = selectInScope(node.dynamic, ancestors, params.construct, params.option, inheritedState(doc, def, node, params, context))
    if (!next.ok) return [next.diagnostic]
    // Idempotent: re-selecting the current option records no transaction.
    if (JSON.stringify(next.scope) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next.scope as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// dynamic.labelMember {graphId, nodeId, ancestors?, construct, member, label}
// ---------------------------------------------------------------------------

type LabelResult =
  | { readonly ok: true; readonly scope: Record<string, DynamicPortState> }
  | { readonly ok: false; readonly diagnostic: Diagnostic }

function labelInScope(
  scope: Readonly<Record<string, DynamicPortState>> | undefined,
  ancestors: readonly AncestorJson[],
  construct: string,
  updates: Readonly<Record<string, string | null>>,
  inherited?: Readonly<Record<string, DynamicPortState>>,
): LabelResult {
  if (ancestors.length > 0) {
    const ancestor = ancestors[0]!
    const state = mergeDynamicScope(inherited, scope)[ancestor.construct]
    if (!state?.members?.includes(ancestor.member)) {
      return { ok: false, diagnostic: err('dynamic.unmaterializedAncestor',
        `dynamic.labelMember: ancestor member '${ancestor.member}' of family '${ancestor.construct}' is not materialized`) }
    }
    const inner = labelInScope(scope?.[ancestor.construct]?.memberState?.[ancestor.member], ancestors.slice(1),
      construct, updates, state.memberState?.[ancestor.member])
    if (!inner.ok) return inner
    return { ok: true, scope: {
      ...scope,
      [ancestor.construct]: { ...state, memberState: { ...state.memberState, [ancestor.member]: inner.scope } },
    } }
  }
  const state = mergeDynamicScope(inherited, scope)[construct]
  if (state?.members === undefined) {
    return { ok: false, diagnostic: err('dynamic.unknownMember',
      `dynamic.labelMember: family '${construct}' is not materialized`) }
  }
  const members = state.members
  const unknownMember = Object.keys(updates).find((member) => !members.includes(member))
  if (unknownMember !== undefined) {
    return { ok: false, diagnostic: err('dynamic.unknownMember',
      `dynamic.labelMember: member '${unknownMember}' of family '${construct}' is not materialized`) }
  }
  const labels = { ...state.memberLabels }
  for (const [member, label] of Object.entries(updates)) {
    if (label === null || label === member) delete labels[member]
    else labels[member] = label
  }
  const effective = members.map((candidate) => labels[candidate] ?? candidate)
  if (new Set(effective).size !== effective.length) {
    return { ok: false, diagnostic: err('dynamic.duplicateMemberLabel',
      `dynamic.labelMember: labels for family '${construct}' must be unique`) }
  }
  const nextState: DynamicPortState = { ...state, ...(Object.keys(labels).length > 0 ? { memberLabels: labels } : {}) }
  if (Object.keys(labels).length === 0) delete (nextState as { memberLabels?: Readonly<Record<string, string>> }).memberLabels
  return { ok: true, scope: {
    ...scope,
    [construct]: nextState,
  } }
}

const dynamicLabelMember: CommandDefinition = {
  id: 'dynamic.labelMember',
  prepareForSharedReplay: prepareInheritedState,
  validateDispatch: validateInheritedState,
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.nodeId !== 'string' ||
        typeof params.construct !== 'string' || params.construct.length === 0 ||
        typeof params.member !== 'string' || params.member.length === 0 ||
        (params.label !== null && (typeof params.label !== 'string' || params.label.trim().length === 0)) ||
        (params.ancestors !== undefined && (!Array.isArray(params.ancestors) || !params.ancestors.every(isAncestor)))) {
      return [err('params.invalid', 'dynamic.labelMember: params must be {graphId, nodeId, ancestors?, construct, member, label: string|null}')]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.labelMember: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.labelMember: unknown node '${params.nodeId}'`)]
    const ancestors = (params.ancestors ?? []) as readonly AncestorJson[]
    const label = typeof params.label === 'string' ? params.label.trim() : null
    const next = labelInScope(node.dynamic, ancestors, params.construct, { [params.member]: label },
      inheritedState(doc, def, node, params, context))
    if (!next.ok) return [next.diagnostic]
    if (JSON.stringify(next.scope) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next.scope as unknown as Json)
    return []
  },
}

const dynamicLabelMembers: CommandDefinition = {
  id: 'dynamic.labelMembers',
  prepareForSharedReplay: prepareInheritedState,
  validateDispatch: validateInheritedState,
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.nodeId !== 'string' ||
        typeof params.construct !== 'string' || params.construct.length === 0 ||
        !isObj(params.labels) || Object.keys(params.labels).length === 0 ||
        !Object.entries(params.labels).every(([member, label]) => member.length > 0 &&
          (label === null || typeof label === 'string' && label.trim().length > 0)) ||
        (params.ancestors !== undefined && (!Array.isArray(params.ancestors) || !params.ancestors.every(isAncestor)))) {
      return [err('params.invalid', 'dynamic.labelMembers: params must be {graphId, nodeId, ancestors?, construct, labels: {member: string|null}}')]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.labelMembers: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.labelMembers: unknown node '${params.nodeId}'`)]
    const ancestors = (params.ancestors ?? []) as readonly AncestorJson[]
    const labels = Object.fromEntries(Object.entries(params.labels).map(([member, label]) => [
      member, typeof label === 'string' ? label.trim() : null,
    ]))
    const next = labelInScope(node.dynamic, ancestors, params.construct, labels,
      inheritedState(doc, def, node, params, context))
    if (!next.ok) return [next.diagnostic]
    if (JSON.stringify(next.scope) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next.scope as unknown as Json)
    return []
  },
}

// Slot specialization deliberately shares the combo scope walker: selected
// has one persisted home, and ancestor/idempotence semantics must not drift.
// Like every core command this remains schema-blind; elaboration diagnoses an
// unknown key rather than commands coupling document edits to schema lookup.
const dynamicSpecializeSlot: CommandDefinition = {
  id: 'dynamic.specializeSlot',
  prepareForSharedReplay: prepareInheritedState,
  validateDispatch: validateInheritedState,
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.nodeId !== 'string' || typeof params.construct !== 'string' ||
      params.construct.length === 0 || (params.variant !== null && typeof params.variant !== 'string') ||
      (params.ancestors !== undefined && (!Array.isArray(params.ancestors) || !params.ancestors.every(isAncestor))))
      return [err('params.invalid', 'dynamic.specializeSlot: params must be {graphId, nodeId, ancestors?: [{construct, member}...], construct, variant: string|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.specializeSlot: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.specializeSlot: unknown node '${params.nodeId}'`)]
    const ancestors = (params.ancestors ?? []) as readonly AncestorJson[]
    if (ancestors.length + 1 > MAX_DYNAMIC_STATE_DEPTH)
      return [err('dynamic.tooDeep', `dynamic.specializeSlot: nesting exceeds the cap of ${MAX_DYNAMIC_STATE_DEPTH}`)]
    const next = selectInScope(node.dynamic, ancestors, params.construct, params.variant as string | null, inheritedState(doc, def, node, params, context))
    if (!next.ok) return [next.diagnostic]
    if (JSON.stringify(next.scope) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next.scope as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// dynamic.compact {graphId, nodeId}
// ---------------------------------------------------------------------------

interface Address {
  readonly port: string
  readonly members: readonly string[]
}

const pathStartsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((member, i) => path[i] === member)

const portIsWithin = (port: string, construct: string): boolean =>
  port === construct || port.startsWith(`${construct}.`)

function compactScope(
  scope: Readonly<Record<string, DynamicPortState>>,
  ancestors: readonly string[],
  references: readonly Address[],
  exempt: (construct: string, ancestors: readonly string[]) => boolean,
): Record<string, DynamicPortState> {
  const result: Record<string, DynamicPortState> = {}
  for (const [construct, state] of Object.entries(scope)) {
    if (state.members === undefined || exempt(construct, ancestors)) {
      result[construct] = state
      continue
    }

    const members: string[] = []
    const memberState: Record<string, Readonly<Record<string, DynamicPortState>>> = {}
    const memberLabels: Record<string, string> = {}
    for (const member of state.members) {
      const path = [...ancestors, member]
      const nested = state.memberState?.[member]
      const compacted = nested === undefined ? undefined : compactScope(nested, path, references, exempt)
      const directlyReferenced = references.some(
        (ref) => portIsWithin(ref.port, construct) && pathStartsWith(ref.members, path),
      )
      // selected is user state; members surviving below are references to
      // this member. Seq-only family state is allocation metadata, not data.
      const nestedReferenced =
        compacted !== undefined &&
        Object.values(compacted).some(
          (child) => child.selected !== undefined || (child.members?.length ?? 0) > 0,
        )
      if (!directlyReferenced && !nestedReferenced) continue
      members.push(member)
      if (state.memberLabels?.[member] !== undefined) memberLabels[member] = state.memberLabels[member]!
      if (compacted !== undefined && Object.keys(compacted).length > 0) memberState[member] = compacted
    }

    // Keep seq even when the family empties: member ids must never be reused.
    // Empty members/memberState containers are omitted as canonical form.
    const { members: _members, memberLabels: _memberLabels, memberState: _memberState, ...rest } = state
    const inferredSeq = Math.max(
      state.seq ?? 0,
      maxMemberSuffix([...(state.members ?? []), ...Object.keys(state.memberState ?? {})]) + 1,
    )
    result[construct] = {
      ...rest,
      seq: inferredSeq,
      ...(members.length > 0 ? { members } : {}),
      ...(Object.keys(memberLabels).length > 0 ? { memberLabels } : {}),
      ...(Object.keys(memberState).length > 0 ? { memberState } : {}),
    }
  }
  return result
}

const dynamicCompact: CommandDefinition = {
  id: 'dynamic.compact',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string')
      return [err('params.invalid', 'dynamic.compact: params must be {graphId, nodeId}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.compact: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.compact: unknown node '${params.nodeId}'`)]
    if (node.dynamic === undefined) return []
    if (checkDocument(doc).some((diagnostic) =>
      diagnostic.code.startsWith('doc.occurrenceTopology.') || diagnostic.code === 'doc.dynamic.memberMissing')) return []

    const references: Address[] = []
    const add = (ref: { readonly node: string; readonly port: string; readonly members?: readonly string[] }): boolean => {
      if (ref.node !== params.nodeId) return true
      const resolved = resolveDynamicAddress(ref, node.dynamic)
      if (resolved.kind === 'resolved') references.push(...resolved.references)
      return resolved.kind === 'resolved' || ref.members === undefined
    }
    for (const link of Object.values(def.links)) {
      if (isPortEndpoint(link.from)) add(link.from)
      if (isPortEndpoint(link.to)) add(link.to)
    }
    for (const net of Object.values(def.nets)) {
      add(net.source)
      for (const sink of net.sinks) add(sink)
    }

    // Occurrence-local links can retain definition-owned members directly or
    // occurrence-owned members through a boundary source coordinate. Resolve
    // owner paths structurally; malformed paths fail safe by retaining state.
    let unresolvedOverlay = false
    for (const topology of Object.values(doc.occurrenceTopologies ?? {})) {
      let parent = doc.graphs[doc.root]
      for (const hop of topology.owner.instancePath) {
        const occurrence = parent?.nodes[hop]
        const childId = occurrence && subgraphDefIdOf(occurrence.type)
        parent = childId === undefined ? undefined : doc.graphs[childId]
      }
      const ownerNode = parent?.nodes[topology.owner.node]
      if (!parent || !ownerNode || subgraphDefIdOf(ownerNode.type) !== topology.bodyGraph) {
        unresolvedOverlay = true
        continue
      }
      for (const link of Object.values(topology.links)) {
        for (const endpoint of [link.from, link.to]) {
          if (endpoint.kind === 'body') {
            if (topology.bodyGraph === params.graphId && isPortEndpoint(endpoint.endpoint) && !add(endpoint.endpoint))
              unresolvedOverlay = true
            continue
          }
          let endpointParent = doc.graphs[doc.root]
          for (const hop of endpoint.occurrence.instancePath) {
            const occurrence = endpointParent?.nodes[hop]
            const childId = occurrence && subgraphDefIdOf(occurrence.type)
            endpointParent = childId === undefined ? undefined : doc.graphs[childId]
          }
          if (!endpointParent || !endpointParent.nodes[endpoint.occurrence.node]) {
            unresolvedOverlay = true
            continue
          }
          if (endpoint.route.length === 0 || endpoint.route[endpoint.route.length - 1]!.graph !== topology.bodyGraph) {
            unresolvedOverlay = true
            continue
          }
          if (endpointParent.id === params.graphId && endpoint.occurrence.node === params.nodeId) {
            if (!add({
              node: endpoint.occurrence.node,
              port: endpoint.address.port,
              ...(endpoint.address.members ? { members: endpoint.address.members } : {}),
            })) unresolvedOverlay = true
          }
        }
      }
    }
    if (unresolvedOverlay) return []

    const familyBindings: Address[] = []
    const subtreeBindings: Address[] = []
    for (const item of [...(def.boundary?.inputs ?? []), ...(def.boundary?.outputs ?? [])]) {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.node !== params.nodeId) continue
        if (binding.kind === 'family')
          familyBindings.push({ port: binding.port, members: binding.members ?? [] })
        else if (isSubtreeBinding(binding))
          subtreeBindings.push({ port: binding.port, members: binding.members ?? [] })
        else if (binding.kind === 'port') add(binding)
      }
    }
    for (const key of Object.keys(node.values)) {
      const address = addressOfElabKey(key)
      if (address?.members !== undefined) {
        references.push({ port: address.port, members: address.members })
      } else {
        const resolved = resolveDynamicAddress({ port: key }, node.dynamic)
        if (resolved.kind === 'resolved') references.push(...resolved.references)
      }
    }
    // Wire-15 persists nested selector/slot state in flattened dot-scoped
    // keys. That state is member-owned evidence even when no link/value is
    // present, so retain every ancestor family it addresses.
    for (const [key, state] of Object.entries(node.dynamic)) {
      if (state.selected === undefined) continue
      const resolved = resolveDynamicAddress({ port: key }, node.dynamic)
      if (resolved.kind === 'resolved') references.push(...resolved.references)
    }

    // A family-forwarded construct may have instance suffix state elsewhere,
    // so compacting it cannot be proven safe without schema/instance data.
    const exempt = (construct: string, ancestors: readonly string[]): boolean =>
      familyBindings.some(
        (binding) => binding.port === construct && pathStartsWith(ancestors, binding.members) && ancestors.length === binding.members.length,
      ) || subtreeBindings.some(
        (binding) => (construct === binding.port || construct.startsWith(`${binding.port}.`)) && pathStartsWith(ancestors, binding.members),
      )
    const next = compactScope(node.dynamic, [], references, exempt)
    if (JSON.stringify(next) === JSON.stringify(node.dynamic)) return []
    tx.set(['graphs', params.graphId, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

export const DYNAMIC_COMMANDS: readonly CommandDefinition[] = [
  dynamicMaterialize,
  dynamicSelectOption,
  dynamicLabelMember,
  dynamicLabelMembers,
  dynamicSpecializeSlot,
  dynamicCompact,
]
