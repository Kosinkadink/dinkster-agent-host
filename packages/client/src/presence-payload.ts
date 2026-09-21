import type { Json } from '@dinkster/core'

/** Presence payload schema version. Additive optional fields remain on v1. */
export const PRESENCE_VERSION = 1
export const PRESENCE_MAX_SELECTION = 2048
export const PRESENCE_MAX_DRAG = 512
export const PRESENCE_MAX_IDENTITY_STRING = 64
export const PRESENCE_MAX_PROPOSALS = 8
export const PRESENCE_MAX_PROPOSAL_ID = 128
export const PRESENCE_MAX_PROPOSAL_SETTING_ID = 128
export const PRESENCE_MAX_PROPOSAL_NOTE = 280
export const PRESENCE_MAX_PROPOSAL_VALUE = 2048

export interface SettingsProposal {
  readonly id: string
  readonly settingId: string
  readonly value: Json
  readonly note?: string
}

/** The authenticated server stamps kind and owner; other fields are display hints. */
export interface PresenceIdentity {
  readonly kind: 'human' | 'agent'
  readonly displayName?: string
  readonly owner?: string
  readonly harness?: string
}

export interface AgentActivity {
  readonly v: 1
  readonly type: 'agent_tool_call'
  readonly tool: string
  readonly status: 'running' | 'success' | 'error'
  readonly pendingAsks: readonly { readonly id: string; readonly prompt: string }[]
}

function decodeActivity(raw: Json | undefined): AgentActivity | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, Json | undefined>
  if (value['v'] !== 1 || value['type'] !== 'agent_tool_call' ||
      typeof value['tool'] !== 'string' || value['tool'].length > 128 ||
      !['running', 'success', 'error'].includes(String(value['status'])) ||
      !Array.isArray(value['pendingAsks']) || value['pendingAsks'].length > 8) return undefined
  const pendingAsks: { id: string; prompt: string }[] = []
  for (const rawAsk of value['pendingAsks']) {
    if (typeof rawAsk !== 'object' || rawAsk === null || Array.isArray(rawAsk)) return undefined
    const ask = rawAsk as Record<string, Json>
    if (typeof ask['id'] !== 'string' || ask['id'].length > 128 || typeof ask['prompt'] !== 'string' || ask['prompt'].length > 280) return undefined
    pendingAsks.push({ id: ask['id'], prompt: ask['prompt'] })
  }
  return { v: 1, type: 'agent_tool_call', tool: value['tool'], status: value['status'] as AgentActivity['status'], pendingAsks }
}

/** World-space rectangle (an actor's visible viewport). */
export interface PresenceRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Semantic origin of an in-progress link drag (additive v1 wire field). */
export type PresenceLinkOrigin =
  | {
      readonly kind: 'port'
      readonly node: string
      readonly port: string
      readonly side: 'in' | 'out'
    }
  | { readonly kind: 'widgetTap'; readonly node: string; readonly input: string }
  | { readonly kind: 'reroute'; readonly reroute: string; readonly side?: 'in' | 'out' }

export interface PresenceLinkDrag {
  readonly origin: PresenceLinkOrigin
  readonly cursor: { readonly x: number; readonly y: number }
}

/** What a client broadcasts: where it is and what it holds. */
export interface LocalPresence {
  readonly activity?: AgentActivity
  readonly graph: string
  readonly cursor: { readonly x: number; readonly y: number } | undefined
  readonly selection: readonly string[]
  readonly reroutes?: readonly string[]
  readonly view?: PresenceRect
  readonly hover?: string
  readonly drag?: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>
  readonly link?: PresenceLinkDrag
  readonly identity?: PresenceIdentity
  readonly proposals?: readonly SettingsProposal[]
}

/** A decoded remote participant payload before transport metadata is attached. */
export interface DecodedPresence {
  readonly activity?: AgentActivity
  readonly graph: string
  readonly cursor?: { readonly x: number; readonly y: number }
  readonly selection: readonly string[]
  readonly reroutes: readonly string[]
  readonly view?: PresenceRect
  readonly hover?: string
  readonly drag?: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>
  readonly link?: PresenceLinkDrag
  readonly identity?: PresenceIdentity
  readonly proposals?: readonly SettingsProposal[]
}

const isFinitePoint = (v: unknown): v is { x: number; y: number } =>
  typeof v === 'object' && v !== null &&
  Number.isFinite((v as { x?: unknown }).x) && Number.isFinite((v as { y?: unknown }).y)

const isFiniteRect = (v: unknown): v is { x: number; y: number; w: number; h: number } => {
  if (!isFinitePoint(v)) return false
  const r = v as { x: number; y: number; w?: unknown; h?: unknown }
  return (
    typeof r.w === 'number' && Number.isFinite(r.w) && r.w > 0 &&
    typeof r.h === 'number' && Number.isFinite(r.h) && r.h > 0
  )
}

const decodeIdentity = (raw: Json | undefined): PresenceIdentity | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as { [key: string]: Json | undefined }
  const kind = record['kind']
  if (kind !== 'human' && kind !== 'agent') return undefined
  const stringField = (name: string): string | undefined => {
    const value = record[name]
    return typeof value === 'string' && value.length <= PRESENCE_MAX_IDENTITY_STRING ? value : undefined
  }
  const displayName = stringField('displayName')
  const owner = stringField('owner')
  const harness = stringField('harness')
  return {
    kind,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(harness !== undefined ? { harness } : {}),
  }
}

const encodeIdentity = (identity: PresenceIdentity): Json => {
  const stringField = (value: string | undefined): string | undefined =>
    typeof value === 'string' && value.length <= PRESENCE_MAX_IDENTITY_STRING ? value : undefined
  const displayName = stringField(identity.displayName)
  const owner = stringField(identity.owner)
  const harness = stringField(identity.harness)
  return {
    kind: identity.kind,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(harness !== undefined ? { harness } : {}),
  }
}

const encodedValueLength = (value: Json): number | undefined => {
  try {
    return JSON.stringify(value)?.length
  } catch {
    return undefined
  }
}

const validProposal = (proposal: SettingsProposal): boolean =>
  typeof proposal.id === 'string' && proposal.id.length > 0 && proposal.id.length <= PRESENCE_MAX_PROPOSAL_ID &&
  typeof proposal.settingId === 'string' && proposal.settingId.length > 0 && proposal.settingId.length <= PRESENCE_MAX_PROPOSAL_SETTING_ID &&
  (proposal.note === undefined || (typeof proposal.note === 'string' && proposal.note.length <= PRESENCE_MAX_PROPOSAL_NOTE)) &&
  (encodedValueLength(proposal.value) ?? Infinity) <= PRESENCE_MAX_PROPOSAL_VALUE

const encodeProposals = (proposals: readonly SettingsProposal[]): Json[] => {
  const ids = new Set<string>()
  const encoded: Json[] = []
  for (const proposal of proposals) {
    if (!validProposal(proposal) || ids.has(proposal.id)) continue
    ids.add(proposal.id)
    encoded.push({
      id: proposal.id,
      settingId: proposal.settingId,
      value: proposal.value,
      ...(proposal.note !== undefined ? { note: proposal.note } : {}),
    })
    if (encoded.length === PRESENCE_MAX_PROPOSALS) break
  }
  return encoded
}

/** Validate an untrusted presence frame. Off-shape frames are dropped as noise. */
export function decodePresence(payload: Json | undefined): DecodedPresence | 'gone' | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const p = payload as { [key: string]: Json | undefined }
  if (p['v'] !== PRESENCE_VERSION) return null
  if (p['gone'] === true) return 'gone'
  const graph = p['graph']
  if (typeof graph !== 'string' || graph.length === 0) return null
  const rawCursor = p['cursor']
  let cursor: { x: number; y: number } | undefined
  if (rawCursor !== null && rawCursor !== undefined) {
    if (!isFinitePoint(rawCursor)) return null
    cursor = { x: rawCursor.x, y: rawCursor.y }
  }
  const rawSelection = p['selection']
  if (!Array.isArray(rawSelection) || rawSelection.length > PRESENCE_MAX_SELECTION) return null
  const selection: string[] = []
  for (const id of rawSelection) {
    if (typeof id !== 'string') return null
    selection.push(id)
  }
  const rawReroutes = p['reroutes']
  const reroutes: string[] = []
  if (rawReroutes !== undefined) {
    if (!Array.isArray(rawReroutes) || rawReroutes.length > PRESENCE_MAX_SELECTION) return null
    for (const id of rawReroutes) {
      if (typeof id !== 'string') return null
      reroutes.push(id)
    }
  }
  const rawView = p['view']
  let view: PresenceRect | undefined
  if (rawView !== null && rawView !== undefined) {
    if (!isFiniteRect(rawView)) return null
    view = { x: rawView.x, y: rawView.y, w: rawView.w, h: rawView.h }
  }
  const rawHover = p['hover']
  let hover: string | undefined
  if (rawHover !== null && rawHover !== undefined) {
    if (typeof rawHover !== 'string' || rawHover.length === 0) return null
    hover = rawHover
  }
  const rawDrag = p['drag']
  let drag: Map<string, { dx: number; dy: number }> | undefined
  if (rawDrag !== null && rawDrag !== undefined) {
    if (!Array.isArray(rawDrag) || rawDrag.length > PRESENCE_MAX_DRAG) return null
    drag = new Map()
    for (const entry of rawDrag) {
      if (!Array.isArray(entry) || entry.length !== 3) return null
      const [id, dx, dy] = entry
      if (typeof id !== 'string' || !Number.isFinite(dx) || !Number.isFinite(dy)) return null
      drag.set(id, { dx: dx as number, dy: dy as number })
    }
  }
  const rawLink = p['link']
  let link: PresenceLinkDrag | undefined
  if (rawLink !== null && rawLink !== undefined) {
    if (typeof rawLink !== 'object' || Array.isArray(rawLink)) return null
    const linkRecord = rawLink as { [key: string]: Json | undefined }
    const rawOrigin = linkRecord['origin']
    const rawLinkCursor = linkRecord['cursor']
    if (typeof rawOrigin !== 'object' || rawOrigin === null || Array.isArray(rawOrigin) || !isFinitePoint(rawLinkCursor)) return null
    const originRecord = rawOrigin as { [key: string]: Json | undefined }
    const kind = originRecord['kind']
    let origin: PresenceLinkOrigin
    if (kind === 'port') {
      const node = originRecord['node']
      const port = originRecord['port']
      const side = originRecord['side']
      if (
        typeof node !== 'string' || node.length === 0 ||
        typeof port !== 'string' || port.length === 0 ||
        (side !== 'in' && side !== 'out')
      ) return null
      origin = { kind, node, port, side }
    } else if (kind === 'widgetTap') {
      const node = originRecord['node']
      const input = originRecord['input']
      if (typeof node !== 'string' || node.length === 0 || typeof input !== 'string' || input.length === 0) return null
      origin = { kind, node, input }
    } else if (kind === 'reroute') {
      const reroute = originRecord['reroute']
      const side = originRecord['side']
      if (typeof reroute !== 'string' || reroute.length === 0) return null
      if (side !== undefined && side !== 'in' && side !== 'out') return null
      origin = { kind, reroute, ...(side !== undefined ? { side } : {}) }
    } else return null
    link = { origin, cursor: { x: rawLinkCursor.x, y: rawLinkCursor.y } }
  }
  const identity = decodeIdentity(p['identity'])
  const activity = identity?.kind === 'agent' ? decodeActivity(p['activity']) : undefined
  const rawProposals = p['proposals']
  let proposals: SettingsProposal[] | undefined
  if (rawProposals !== undefined) {
    if (!Array.isArray(rawProposals) || rawProposals.length === 0 || rawProposals.length > PRESENCE_MAX_PROPOSALS) return null
    proposals = []
    const ids = new Set<string>()
    for (const rawProposal of rawProposals) {
      if (typeof rawProposal !== 'object' || rawProposal === null || Array.isArray(rawProposal)) return null
      const proposal = rawProposal as { [key: string]: Json | undefined }
      const id = proposal['id']
      const settingId = proposal['settingId']
      const value = proposal['value']
      const note = proposal['note']
      if (
        typeof id !== 'string' || id.length === 0 || id.length > PRESENCE_MAX_PROPOSAL_ID || ids.has(id) ||
        typeof settingId !== 'string' || settingId.length === 0 || settingId.length > PRESENCE_MAX_PROPOSAL_SETTING_ID ||
        value === undefined || (encodedValueLength(value) ?? Infinity) > PRESENCE_MAX_PROPOSAL_VALUE ||
        (note !== undefined && (typeof note !== 'string' || note.length > PRESENCE_MAX_PROPOSAL_NOTE))
      ) return null
      ids.add(id)
      proposals.push({ id, settingId, value, ...(note !== undefined ? { note } : {}) })
    }
  }
  return {
    graph,
    selection,
    reroutes,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(view !== undefined ? { view } : {}),
    ...(hover !== undefined ? { hover } : {}),
    ...(drag !== undefined ? { drag } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...(proposals !== undefined ? { proposals } : {}),
  }
}

/** Encode local state into the v1 presence wire payload. */
export const encodePresence = (local: LocalPresence): Json => {
  const proposals = local.proposals === undefined ? [] : encodeProposals(local.proposals)
  const activity = decodeActivity(local.activity as unknown as Json)
  return {
    v: PRESENCE_VERSION,
    graph: local.graph,
    cursor: local.cursor === undefined ? null : { x: local.cursor.x, y: local.cursor.y },
    selection: local.selection as string[],
    ...(local.reroutes !== undefined && local.reroutes.length > 0 ? { reroutes: local.reroutes as string[] } : {}),
    ...(local.view !== undefined ? { view: { x: local.view.x, y: local.view.y, w: local.view.w, h: local.view.h } } : {}),
    ...(local.hover !== undefined ? { hover: local.hover } : {}),
    ...(local.drag !== undefined && local.drag.size > 0
      ? { drag: [...local.drag].slice(0, PRESENCE_MAX_DRAG).map(([id, o]) => [id, o.dx, o.dy] as Json[]) }
      : {}),
    ...(local.link !== undefined ? { link: local.link as unknown as Json } : {}),
    ...(local.identity !== undefined ? { identity: encodeIdentity(local.identity) } : {}),
    ...(activity !== undefined ? { activity: activity as unknown as Json } : {}),
    ...(proposals.length > 0 ? { proposals } : {}),
  }
}
