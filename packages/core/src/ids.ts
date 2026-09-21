/**
 * Identity scheme.
 *
 * Every entity in a Dinkster document has a stable, generated, never-reused ID.
 * IDs are opaque strings branded at the type level so they cannot be mixed up.
 *
 * Key identity rules from the architecture plan:
 * - Node/link/net/definition IDs are unique within their owning graph definition
 *   and never recycled (monotonic allocation recorded in the document).
 * - Ports are identified by their schema-declared input/output id (string) plus,
 *   for dynamic members, a generated member id that is stable across regrowth.
 * - An *occurrence* identifies a node within the fully-elaborated instance tree:
 *   the path of subgraph-instance node IDs from the root, plus the local node id.
 * - Executions are identified by (connectionId, promptId) - never promptId alone,
 *   because multiple backends may be connected.
 */

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** ID of a node within one graph definition. */
export type NodeId = Brand<string, 'NodeId'>
/** ID of a link within one graph definition. */
export type LinkId = Brand<string, 'LinkId'>
/** ID of a named net within one graph definition. */
export type NetId = Brand<string, 'NetId'>
/** ID of a reroute (structural junction vertex) within one graph definition. */
export type RerouteId = Brand<string, 'RerouteId'>
/** ID of a value source (literal producer) within one graph definition. */
export type ValueSourceId = Brand<string, 'ValueSourceId'>
/** ID of a selector (compile-time branch chooser) within one graph definition. */
export type SelectorId = Brand<string, 'SelectorId'>
/** ID of one selector candidate, unique within its owning selector. */
export type SelectorCandidateId = Brand<string, 'SelectorCandidateId'>
/** ID of a graph definition (the root graph or a subgraph definition). */
export type GraphDefId = Brand<string, 'GraphDefId'>
/** Schema-declared id of an input or output (V3 input/output id string). */
export type PortId = Brand<string, 'PortId'>
/** Generated id for one member of a dynamic port family (stable across regrowth). */
export type DynamicMemberId = Brand<string, 'DynamicMemberId'>
/** ID of a control surface within a document. */
export type ControlSurfaceId = Brand<string, 'ControlSurfaceId'>
/** Identity of a workflow lineage (stable across saves of "the same" workflow). */
export type LineageId = Brand<string, 'LineageId'>
/** Identity of a backend connection. */
export type ConnectionId = Brand<string, 'ConnectionId'>
/** Server-assigned prompt id. */
export type PromptId = Brand<string, 'PromptId'>

export const asNodeId = (s: string): NodeId => s as NodeId
export const asLinkId = (s: string): LinkId => s as LinkId
export const asNetId = (s: string): NetId => s as NetId
export const asRerouteId = (s: string): RerouteId => s as RerouteId
export const asValueSourceId = (s: string): ValueSourceId => s as ValueSourceId
export const asSelectorId = (s: string): SelectorId => s as SelectorId
export const asSelectorCandidateId = (s: string): SelectorCandidateId => s as SelectorCandidateId
export const asGraphDefId = (s: string): GraphDefId => s as GraphDefId
export const asPortId = (s: string): PortId => s as PortId
export const asDynamicMemberId = (s: string): DynamicMemberId => s as DynamicMemberId
export const asControlSurfaceId = (s: string): ControlSurfaceId => s as ControlSurfaceId
export const asLineageId = (s: string): LineageId => s as LineageId
export const asConnectionId = (s: string): ConnectionId => s as ConnectionId
export const asPromptId = (s: string): PromptId => s as PromptId

/**
 * A port reference within one graph definition: a node, a schema port, and -
 * when the port belongs to a dynamic family - the generated member-id path.
 * For family members `port` is the stamped slot path ('<family>.<slotId>'),
 * uniformly even when the family template has a single slot.
 *
 * `members` is ordered outermost-first: one segment per enclosing dynamic
 * construct (nested families need one id per level; a flat family has one).
 * Every segment is a stable generated id, never an ordinal - reordering
 * members never moves values or links. Canonical form: the field is present
 * iff non-empty (validators reject empty arrays).
 */
export interface PortRef {
  readonly node: NodeId
  readonly port: PortId
  readonly members?: readonly DynamicMemberId[]
}

/** Reference to a reroute junction (used only as a link endpoint). */
export interface RerouteRef {
  readonly reroute: RerouteId
}

/**
 * Reference to a value source (used only as a link `from` endpoint - value
 * sources produce, never consume).
 */
export interface ValueSourceRef {
  readonly valueSource: ValueSourceId
}

/**
 * Reference to a selector (compile-time branch chooser). `candidate` present
 * = one candidate input (legal only as a link `to` endpoint); absent = the
 * selector's single output (legal only as a link `from` endpoint). Same
 * structural-junction discipline as reroutes: no fake port ids, no stored
 * reverse lists - a candidate's upstream is the unique link targeting it.
 */
export interface SelectorRef {
  readonly selector: SelectorId
  readonly candidate?: SelectorCandidateId
}

/**
 * Producer reference to the effective value of a node input. Widget taps are
 * deliberately limited to static, memberless inputs.
 */
export interface WidgetTapRef {
  readonly node: NodeId
  readonly tap: PortId
}

/**
 * A link endpoint: a node port, a reroute junction, a value source, or a
 * selector. Discriminated structurally (`'reroute' in e` / `'valueSource'
 * in e` / `'selector' in e`) so plain port-to-port links serialize exactly
 * as PortRef pairs. Direction comes from the link (`from` = output side,
 * `to` = input side), so none of the junction kinds need fake port ids.
 * Value sources are legal only on the `from` side (validator I10).
 */
export type LinkEndpoint = PortRef | RerouteRef | ValueSourceRef | SelectorRef | WidgetTapRef

export const isRerouteRef = (e: LinkEndpoint): e is RerouteRef => 'reroute' in e
export const isValueSourceRef = (e: LinkEndpoint): e is ValueSourceRef => 'valueSource' in e
export const isSelectorRef = (e: LinkEndpoint): e is SelectorRef => 'selector' in e
export const isWidgetTapRef = (e: LinkEndpoint): e is WidgetTapRef => 'tap' in e
/** Exact persisted widget-tap shape; rejects dynamic/member/path lookalikes. */
export const isExactWidgetTapRef = (e: LinkEndpoint): e is WidgetTapRef =>
  isWidgetTapRef(e) &&
  typeof e.node === 'string' && e.node.length > 0 &&
  typeof e.tap === 'string' && e.tap.length > 0 &&
  Object.keys(e).length === 2
export const isPortEndpoint = (e: LinkEndpoint): e is PortRef =>
  !('reroute' in e) && !('valueSource' in e) && !('selector' in e) && !('tap' in e)

// ---------------------------------------------------------------------------
// Canonical endpoint equality and keys (hazard N6)
//
// EVERY comparison or map-keying of port references goes through these -
// never ad hoc field comparisons or hand-packed strings. They are the single
// place that knows what member identity looks like (a member-id path,
// outermost first). Keys are opaque and injective BY CONSTRUCTION
// (JSON-escaped components), for arbitrary id strings - injectivity never
// depends on validators excluding separator characters. Never parse one
// back apart.
// ---------------------------------------------------------------------------

const KEY_SEP = '\u0000'

/** Structural identity of two member paths (undefined == empty == static). */
export const sameMemberPath = (
  a: readonly DynamicMemberId[] | undefined,
  b: readonly DynamicMemberId[] | undefined,
): boolean => {
  const la = a?.length ?? 0
  const lb = b?.length ?? 0
  if (la !== lb) return false
  for (let i = 0; i < la; i++) if (a![i] !== b![i]) return false
  return true
}

/** Structural identity of two port references (node + port + member path). */
export const samePortRef = (a: PortRef, b: PortRef): boolean =>
  a.node === b.node && a.port === b.port && sameMemberPath(a.members, b.members)

/**
 * Canonical injective node-local key for a port address (port + optional
 * member path), for maps scoped to one node. Opaque - never split it.
 * JSON packing keeps it injective for arbitrary component strings: an empty
 * path and an absent one produce the same key (both mean "static port").
 */
export const portAddressKey = (port: string, members?: readonly string[]): string =>
  JSON.stringify(members === undefined || members.length === 0 ? [port] : [port, ...members])

/**
 * Canonical injective map key for a PortRef. Opaque - never split it.
 * (JSON output never contains a raw NUL - control characters are escaped -
 * so the separator cannot be forged by an id.)
 */
export const portRefKey = (p: PortRef): string =>
  `${JSON.stringify(p.node)}${KEY_SEP}${portAddressKey(p.port, p.members)}`

/** Structural identity across the LinkEndpoint union. */
export const sameEndpoint = (a: LinkEndpoint, b: LinkEndpoint): boolean => {
  if (isRerouteRef(a)) return isRerouteRef(b) && a.reroute === b.reroute
  if (isValueSourceRef(a)) return isValueSourceRef(b) && a.valueSource === b.valueSource
  if (isSelectorRef(a))
    return isSelectorRef(b) && a.selector === b.selector && a.candidate === b.candidate
  if (isWidgetTapRef(a)) return isWidgetTapRef(b) && a.node === b.node && a.tap === b.tap
  return isPortEndpoint(b) && samePortRef(a, b)
}

/**
 * Occurrence: a node's identity in the elaborated instance tree.
 * `instancePath` lists the subgraph-instance node IDs walked from the root
 * graph; `node` is the node's id inside its defining graph.
 */
export interface OccurrenceRef {
  readonly instancePath: readonly NodeId[]
  readonly node: NodeId
}

/** Backward-compatible spelling used by compile and execution APIs. */
export type Occurrence = OccurrenceRef

/** Structural identity of two occurrence references. */
export function sameOccurrenceRef(a: OccurrenceRef, b: OccurrenceRef): boolean {
  if (a.node !== b.node || a.instancePath.length !== b.instancePath.length) return false
  return a.instancePath.every((node, index) => node === b.instancePath[index])
}

/** True when `ancestor` is `owner` or one of its structural ancestors. */
export function isOccurrenceAncestorOrSelf(ancestor: OccurrenceRef, owner: OccurrenceRef): boolean {
  const ancestorSegments = [...ancestor.instancePath, ancestor.node]
  const ownerSegments = [...owner.instancePath, owner.node]
  return ancestorSegments.length <= ownerSegments.length &&
    ancestorSegments.every((node, index) => node === ownerSegments[index])
}

/** Execution identity: always (connection, prompt). */
export interface ExecutionRef {
  readonly connection: ConnectionId
  readonly prompt: PromptId
}

// Separator for flattened runtime ids. The Dinkster backend bans '/', '[' and
// ']' in document node ids (its runtime iteration-path grammar owns them:
// `outer[0]/inner[2]/node`), so flattened ids we submit must never contain
// them. '.' is backend-legal; escapeSeg percent-encodes '.' (plus '/', '[',
// ']', '$' via encodeURIComponent) inside segments, so joined keys are
// injective AND contain none of the backend-reserved characters. A document
// node literally named '$region' escapes to '%24region', so it can never
// collide with the backend's reserved body id.
const OCC_SEP = '.'
const escapeSeg = (s: string): string => encodeURIComponent(s).replaceAll('.', '%2E')
const unescapeSeg = (s: string): string => decodeURIComponent(s)

/** Serialize an occurrence to a canonical string key (usable as a map key). */
export function occurrenceKey(o: OccurrenceRef): string {
  const segs = [...o.instancePath, o.node].map(escapeSeg)
  return segs.join(OCC_SEP)
}

/** Parse an occurrence key produced by {@link occurrenceKey}. */
export function parseOccurrenceKey(key: string): OccurrenceRef {
  const segs = key.split(OCC_SEP).map(unescapeSeg)
  if (segs.length === 0 || segs.some((s) => s.length === 0)) {
    throw new Error(`invalid occurrence key: ${JSON.stringify(key)}`)
  }
  const node = asNodeId(segs[segs.length - 1]!)
  const instancePath = segs.slice(0, -1).map(asNodeId)
  return { instancePath, node }
}

/** Canonical string key for an execution. */
export function executionKey(e: ExecutionRef): string {
  return `${escapeSeg(e.connection)}${OCC_SEP}${escapeSeg(e.prompt)}`
}

/**
 * True when `key` addresses an occurrence nested (at any depth) inside the
 * given instance node's subtree. Owns the separator/escaping so callers
 * (e.g. subgraph state aggregation) never string-match keys themselves.
 */
export function isOccurrenceKeyWithin(key: string, instanceNode: NodeId): boolean {
  return key.startsWith(escapeSeg(instanceNode) + OCC_SEP)
}

/**
 * ID allocator. Documents record `nextOrdinal` per graph definition so IDs are
 * never reused even after deletes + undo. Format: `<prefix><ordinal>` -
 * short, diff-friendly, and unambiguous (ordinals never repeat).
 */
export interface IdAllocator {
  readonly nextOrdinal: number
}

// ---------------------------------------------------------------------------
// Actor-scoped allocation (multiplayer prerequisite)
//
// A shared session has concurrent allocators: two actors reading the same
// graph-wide nextOrdinal would mint the SAME id for independently created
// entities, and server ordering cannot undo that (both creations are valid;
// only their ids collide). Shared-mode ids therefore embed the minting
// actor - `<prefix><ordinal>-<actorId>` - allocated from a per-actor cursor
// (`GraphDef.actorCursors[actorId]`), so each actor writes only its own
// cursor key and id spaces cannot intersect. Solo allocation (no actor) is
// byte-for-byte unchanged: `n5`, `l6`, ... from nextOrdinal.
// ---------------------------------------------------------------------------

/**
 * Actor ids embeddable in document ids. The safe-id alphabet from the
 * elaborate/address grammar ([A-Za-z0-9_-]) guarantees no collision with
 * address/selector syntax, no backend-reserved characters ('/', '[', ']'),
 * and no reserved document-id characters. Server actor ids (UUIDs) pass.
 * An actor id outside this set is rejected at dispatch ingress - never
 * silently re-encoded, because the id must round-trip to the same actor.
 * '__proto__' matches the pattern but is rejected explicitly: it cannot be
 * an own key under plain-object assignment, so it could never round-trip
 * through the cursor map (other prototype names like 'constructor' are fine
 * as OWN keys - all cursor reads go through actorCursorOf, never inherited
 * lookup).
 */
export const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export const isValidActorId = (s: unknown): boolean =>
  typeof s === 'string' && s !== '__proto__' && ACTOR_ID_PATTERN.test(s)

/**
 * The one cursor read for `GraphDef.actorCursors`. Own-key lookup only:
 * a plain-record key like 'constructor' must read ITS cursor (or default
 * to 0 before its first allocation), never an inherited Object.prototype
 * member. Every consumer (allocator, clipboard planner, I6) goes through
 * here so the default-to-zero rule cannot drift.
 */
export function actorCursorOf(cursors: Readonly<Record<string, number>> | undefined, actor: string): number {
  return cursors !== undefined && Object.hasOwn(cursors, actor) ? cursors[actor]! : 0
}

/** The prefixes the graph allocator mints (group ids `g` have their own cursor). */
export type AllocatedIdPrefix = 'n' | 'l' | 'net' | 'r' | 'v' | 's' | 'c'

/** Compose one allocated id: solo `<prefix><ordinal>`, actor-scoped `<prefix><ordinal>-<actor>`. */
export function formatAllocatedId(prefix: AllocatedIdPrefix, ordinal: number, actor?: string): string {
  return actor === undefined ? `${prefix}${ordinal}` : `${prefix}${ordinal}-${actor}`
}

/**
 * Parse an id back into its allocation coordinates, CANONICAL forms only
 * (the exact strings formatAllocatedId produces): lowercase prefix, decimal
 * ordinal without leading zeros, safe integer, and - when actor-scoped - a
 * valid actor id after the FIRST '-' following the digits (actor ids may
 * themselves contain '-'; never split on every hyphen). Non-canonical
 * lookalikes ('n007-x', huge ordinals) return undefined: they were not
 * minted by an allocator and cannot collide with minted ids (the canonical
 * decimal form differs), mirroring groupIdFloor's discipline.
 */
export function parseAllocatedId(
  id: string,
): { prefix: string; ordinal: number; actor?: string } | undefined {
  const m = /^([a-z]+)(\d+)(?:-(.+))?$/.exec(id)
  if (!m) return undefined
  const ordinal = Number(m[2])
  if (!Number.isSafeInteger(ordinal) || m[2] !== String(ordinal)) return undefined
  if (m[3] === undefined) return { prefix: m[1]!, ordinal }
  if (!isValidActorId(m[3])) return undefined
  return { prefix: m[1]!, ordinal, actor: m[3] }
}

export function allocateId(
  alloc: IdAllocator,
  prefix: 'n' | 'l' | 'net' | 'r' | 'v' | 'm' | 'cs' | 'g',
): { id: string; alloc: IdAllocator } {
  return {
    id: `${prefix}${guardOrdinal(alloc.nextOrdinal)}`,
    alloc: { nextOrdinal: alloc.nextOrdinal + 1 },
  }
}

/**
 * Group id allocation floor (FR1). Group ids have their own per-graph cursor
 * (`view.graphs[g].groupSeq`) - view-only state must not consume the graph's
 * semantic nextOrdinal - and group ids outlive their groups in surface
 * bindings, so a reminted id would silently retarget a binding that still
 * names a removed group. This is the LOW-LEVEL key scanner: it composes a
 * cursor with canonical `grpN` keys. The document-aware composition point
 * every mutation-time allocator (view.createGroup, clipboard paste) actually
 * calls is `groupAllocationFloor` in group-alloc.ts, which feeds this scanner
 * live keys AND binding-referenced ids - so two allocators can never mint
 * into the same namespace from different authorities: the persisted cursor
 * is the authority, and the key scan is the floor for pre-cursor documents.
 * Only CANONICAL safe suffixes advance the floor: a huge grp<N>
 * key would round Number(m[1])+1 and make later mints collide, and a
 * leading-zero form like 'grp00' (or 'grp0<huge>' near the ceiling) is not
 * an allocator-produced id, so it must neither advance nor EXHAUST the
 * cursor - malformed evidence never blocks allocation. Skipped keys cannot
 * collide with minted ids (their canonical decimal form differs).
 */
export function groupIdFloor(groupSeq: number | undefined, existingKeys: Iterable<string>): number {
  let n = typeof groupSeq === 'number' ? groupSeq : 0
  for (const key of existingKeys) {
    const m = /^grp(\d+)$/.exec(key)
    if (!m) continue
    const v = Number(m[1])
    if (!Number.isSafeInteger(v) || !Number.isSafeInteger(v + 1) || key !== `grp${v}`) continue
    if (v + 1 > n) n = v + 1
  }
  return n
}

/**
 * Guard one ordinal allocation: minting `ordinal` moves the cursor to
 * `ordinal + 1`, which must stay a safe integer or the committed document
 * becomes unloadable (validation requires safe-integer cursors). A loaded
 * document may legally carry any safe cursor, so every allocator checks
 * before minting; the throw becomes an atomic command rejection (dispatch
 * converts command throws).
 */
export function guardOrdinal(ordinal: number): number {
  if (ordinal >= Number.MAX_SAFE_INTEGER)
    throw new Error(`id space exhausted: ordinal cursor is at ${ordinal}`)
  return ordinal
}

/**
 * Largest mintable dynamic-member ordinal. Member suffix parsing (the
 * `^m\d{1,15}$` scans in elaborate/dynamic-commands) sees at most 15
 * digits; a fresh id above this would be invisible to the seq bump and the
 * same id could be offered again (ghost/persisted address collision).
 * A family whose next base exceeds this is exhausted: elaboration stops
 * offering growth and dynamic.materialize rejects it.
 */
export const MAX_MEMBER_ORDINAL = 999_999_999_999_999
