import { asDynamicMemberId, asNodeId, asPortId, type PortRef } from '../ids.js'
import type { Json, JsonObject, WorkflowDocument } from './document.js'

export const NET_VIEWS_EXT_KEY = 'dinkster.netViews'

/**
 * Authored tag geometry. `offset` is relative to the owning node's stored
 * view position (its top-left), so the tag rides along when the node moves.
 * `absolute` is the retired world-coordinate form: it renders where it was
 * saved but never follows the node. Documents are canonicalized to offsets
 * on load whenever the owning node has a stored position; absolute survives
 * only when the owner cannot be resolved.
 */
export type NetViewGeometry =
  | { readonly kind: 'offset'; readonly x: number; readonly y: number }
  | { readonly kind: 'absolute'; readonly x: number; readonly y: number }

export type NetViewPosition =
  | {
      readonly graphId: string
      readonly netId: string
      readonly role: 'source'
      readonly geometry: NetViewGeometry
    }
  | {
      readonly graphId: string
      readonly netId: string
      readonly role: 'sink'
      readonly to: PortRef
      readonly geometry: NetViewGeometry
    }

const isObj = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsePortRef = (value: Json | undefined): PortRef | undefined => {
  if (!isObj(value) || typeof value.node !== 'string' || value.node.length === 0 ||
      typeof value.port !== 'string' || value.port.length === 0) return undefined
  const members = value.members
  if (members !== undefined && (!Array.isArray(members) || members.length === 0 ||
      !members.every((member): member is string => typeof member === 'string' && member.length > 0))) return undefined
  return {
    node: asNodeId(value.node),
    port: asPortId(value.port),
    ...(members === undefined ? {} : { members: members.map(asDynamicMemberId) }),
  }
}

const parseVec = (value: Json | undefined): { x: number; y: number } | undefined =>
  isObj(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x as number, y: value.y as number }
    : undefined

const parseGeometry = (value: JsonObject): NetViewGeometry | undefined => {
  const offset = parseVec(value.offset)
  const position = parseVec(value.position)
  // Carrying both forms is ambiguous; refuse rather than guess.
  if (offset !== undefined && value.position === undefined) return { kind: 'offset', ...offset }
  if (position !== undefined && value.offset === undefined) return { kind: 'absolute', ...position }
  return undefined
}

export const parseNetViewPosition = (value: Json): NetViewPosition | undefined => {
  if (!isObj(value) || typeof value.graphId !== 'string' || value.graphId.length === 0 ||
      typeof value.netId !== 'string' || value.netId.length === 0) return undefined
  const geometry = parseGeometry(value)
  if (geometry === undefined) return undefined
  if (value.role === 'source') return { graphId: value.graphId, netId: value.netId, role: 'source', geometry }
  if (value.role !== 'sink') return undefined
  const to = parsePortRef(value.to)
  return to === undefined ? undefined : { graphId: value.graphId, netId: value.netId, role: 'sink', to, geometry }
}

export const netViewKey = (view: NetViewPosition): string =>
  view.role === 'source'
    ? JSON.stringify([view.graphId, view.netId, 'source'])
    : JSON.stringify([view.graphId, view.netId, 'sink', view.to.node, view.to.port, view.to.members ?? []])

export function netViewPositions(doc: WorkflowDocument, graphId?: string): readonly NetViewPosition[] {
  const raw = doc.ext?.[NET_VIEWS_EXT_KEY]
  if (!Array.isArray(raw)) return []
  const positions: NetViewPosition[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const parsed = parseNetViewPosition(value)
    if (parsed === undefined || (graphId !== undefined && parsed.graphId !== graphId)) continue
    const key = netViewKey(parsed)
    if (seen.has(key)) continue
    seen.add(key)
    positions.push(parsed)
  }
  return positions
}

export const netViewToJson = (view: NetViewPosition): Json => ({
  graphId: view.graphId,
  netId: view.netId,
  role: view.role,
  ...(view.role === 'sink' ? {
    to: {
      node: view.to.node,
      port: view.to.port,
      ...(view.to.members === undefined ? {} : { members: [...view.to.members] }),
    },
  } : {}),
  ...(view.geometry.kind === 'offset'
    ? { offset: { x: view.geometry.x, y: view.geometry.y } }
    : { position: { x: view.geometry.x, y: view.geometry.y } }),
})

export function updateNetViewPositions(doc: WorkflowDocument, updates: readonly NetViewPosition[]): Json {
  const raw = doc.ext?.[NET_VIEWS_EXT_KEY]
  const next: Json[] = Array.isArray(raw) ? [...raw] : []
  for (const update of updates) {
    const key = netViewKey(update)
    const index = next.findIndex((value) => {
      const parsed = parseNetViewPosition(value)
      return parsed !== undefined && netViewKey(parsed) === key
    })
    if (index === -1) next.push(netViewToJson(update))
    else next[index] = netViewToJson(update)
  }
  return next
}

export function removeNetViewPositions(
  doc: WorkflowDocument,
  matches: (position: NetViewPosition) => boolean,
): Json | undefined {
  const raw = doc.ext?.[NET_VIEWS_EXT_KEY]
  if (!Array.isArray(raw)) return undefined
  const next = raw.filter((value) => {
    const parsed = parseNetViewPosition(value)
    return parsed === undefined || !matches(parsed)
  })
  return next.length === raw.length ? undefined : next
}
