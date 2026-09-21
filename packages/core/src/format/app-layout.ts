import type { Json, JsonObject, WorkflowDocument } from './document.js'

/** Root `ext` key for the optional App view layout. */
export const APP_LAYOUT_EXT_KEY = 'dinkster.appLayout'

export type AppLayoutTextRole = 'heading' | 'body' | 'caption'

export interface AppLayoutGrid {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface AppLayoutGridFields {
  readonly x?: number
  readonly y?: number
  readonly w?: number
  readonly h?: number
}

export interface AppLayoutControlItem extends AppLayoutGridFields {
  readonly id: string
  readonly kind: 'control'
  readonly ref: {
    readonly graphId: string
    readonly nodeId: string
    readonly inputId: string
  }
}

export interface AppLayoutPreviewItem extends AppLayoutGridFields {
  readonly id: string
  readonly kind: 'preview'
  readonly ref: {
    readonly graphId: string
    readonly nodeId: string
  }
}

export interface AppLayoutQueueTarget {
  readonly graphId: string
  readonly nodeId: string
}

export interface AppLayoutQueueItem extends AppLayoutGridFields {
  readonly id: string
  readonly kind: 'queue'
  readonly label: string
  readonly targets: readonly AppLayoutQueueTarget[]
}

/** Text uses the restricted Markdown subset documented by App view. */
export interface AppLayoutTextItem extends AppLayoutGridFields {
  readonly id: string
  readonly kind: 'text'
  readonly role: AppLayoutTextRole
  readonly text: string
}

export interface AppLayoutGroupItem extends AppLayoutGridFields {
  readonly id: string
  readonly kind: 'group'
  readonly title: string
  readonly children: readonly string[]
}

export type AppLayoutItem =
  | AppLayoutControlItem
  | AppLayoutPreviewItem
  | AppLayoutQueueItem
  | AppLayoutTextItem
  | AppLayoutGroupItem

export type AppLayoutMobile =
  | { readonly customized: false; readonly items: readonly [] }
  | { readonly customized: true; readonly items: readonly []; readonly order: readonly string[] }

export interface AppLayoutV1 {
  readonly version: 1
  readonly desktop: { readonly items: readonly AppLayoutItem[] }
  readonly mobile: AppLayoutMobile
}

const isObj = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: Json | undefined): value is string =>
  typeof value === 'string' && value.length > 0

const refObject = (value: Json | undefined): JsonObject | undefined =>
  isObj(value) ? value : undefined

export const hasAppLayoutGridFields = (value: JsonObject): boolean =>
  Object.hasOwn(value, 'x') || Object.hasOwn(value, 'y') || Object.hasOwn(value, 'w') || Object.hasOwn(value, 'h')

/** Returns complete, bounded grid coordinates; partial or unsafe coordinates are flow-only. */
export function appLayoutGrid(value: AppLayoutGridFields): AppLayoutGrid | undefined {
  const { x, y, w, h } = value
  if (
    !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
    !Number.isSafeInteger(w) || !Number.isSafeInteger(h) ||
    x === undefined || y === undefined || w === undefined || h === undefined ||
    x < 0 || x >= 12 || y < 0 || w < 1 || w > 12 || h < 1 ||
    x + w > 12 || !Number.isSafeInteger(y + h)
  ) return undefined
  return { x, y, w, h }
}

const withGrid = <T extends { readonly id: string; readonly kind: string }>(
  item: T,
  grid: AppLayoutGrid | undefined,
): T & AppLayoutGridFields => grid === undefined ? item : { ...item, ...grid }

export function withoutAppLayoutGrid(item: AppLayoutItem): AppLayoutItem {
  const { x: _x, y: _y, w: _w, h: _h, ...flow } = item
  return flow as AppLayoutItem
}

export function withAppLayoutGrid(item: AppLayoutItem, grid: AppLayoutGrid): AppLayoutItem {
  return { ...withoutAppLayoutGrid(item), ...grid } as AppLayoutItem
}

/** Parses one placement, retaining only a complete valid grid rectangle. */
export function parseAppLayoutItem(value: Json): AppLayoutItem | undefined {
  if (!isObj(value) || !nonEmpty(value.id) || typeof value.kind !== 'string') return undefined
  const grid = appLayoutGrid(value)
  switch (value.kind) {
    case 'control': {
      const ref = refObject(value.ref)
      if (ref === undefined || !nonEmpty(ref.graphId) || !nonEmpty(ref.nodeId) || !nonEmpty(ref.inputId)) {
        return undefined
      }
      return withGrid<AppLayoutControlItem>({
        id: value.id,
        kind: 'control',
        ref: { graphId: ref.graphId, nodeId: ref.nodeId, inputId: ref.inputId },
      }, grid)
    }
    case 'preview': {
      const ref = refObject(value.ref)
      if (ref === undefined || !nonEmpty(ref.graphId) || !nonEmpty(ref.nodeId)) return undefined
      return withGrid<AppLayoutPreviewItem>({ id: value.id, kind: 'preview', ref: { graphId: ref.graphId, nodeId: ref.nodeId } }, grid)
    }
    case 'queue': {
      if (!nonEmpty(value.label) || !Array.isArray(value.targets)) return undefined
      const targets: AppLayoutQueueTarget[] = []
      const seen = new Set<string>()
      for (const candidate of value.targets) {
        const target = refObject(candidate)
        if (target === undefined || !nonEmpty(target.graphId) || !nonEmpty(target.nodeId)) continue
        const key = JSON.stringify([target.graphId, target.nodeId])
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ graphId: target.graphId, nodeId: target.nodeId })
      }
      if (targets.length === 0) return undefined
      return withGrid<AppLayoutQueueItem>({ id: value.id, kind: 'queue', label: value.label, targets }, grid)
    }
    case 'text':
      if (
        (value.role !== 'heading' && value.role !== 'body' && value.role !== 'caption') ||
        typeof value.text !== 'string'
      ) return undefined
      return withGrid<AppLayoutTextItem>({ id: value.id, kind: 'text', role: value.role, text: value.text }, grid)
    case 'group': {
      if (typeof value.title !== 'string' || !Array.isArray(value.children)) return undefined
      const children: string[] = []
      const seen = new Set<string>()
      for (const child of value.children) {
        if (!nonEmpty(child) || seen.has(child)) continue
        seen.add(child)
        children.push(child)
      }
      return withGrid<AppLayoutGroupItem>({ id: value.id, kind: 'group', title: value.title, children }, grid)
    }
    default:
      return undefined
  }
}

interface RawAppLayoutV1 {
  readonly root: JsonObject
  readonly desktop: JsonObject
  readonly items: readonly Json[]
  readonly mobile: JsonObject | undefined
  readonly mobileCustomized: boolean
  readonly mobileOrder: readonly string[]
}

const rawMobile = (value: Json | undefined): Pick<RawAppLayoutV1, 'mobile' | 'mobileCustomized' | 'mobileOrder'> => {
  if (
    !isObj(value) ||
    typeof value.customized !== 'boolean' ||
    !Array.isArray(value.items) ||
    value.items.length !== 0
  ) {
    return { mobile: isObj(value) ? value : undefined, mobileCustomized: false, mobileOrder: [] }
  }
  if (value.customized !== true) return { mobile: value, mobileCustomized: false, mobileOrder: [] }
  if (!Array.isArray(value.order)) return { mobile: value, mobileCustomized: false, mobileOrder: [] }
  return {
    mobile: value,
    mobileCustomized: true,
    mobileOrder: value.order.filter((id): id is string => typeof id === 'string'),
  }
}

/** Returns the raw item array when the version 1 desktop container is usable. */
export function rawAppLayoutV1(value: Json | undefined): RawAppLayoutV1 | undefined {
  if (!isObj(value) || value.version !== 1 || !isObj(value.desktop) || !Array.isArray(value.desktop.items)) {
    return undefined
  }
  return { root: value, desktop: value.desktop, items: value.desktop.items, ...rawMobile(value.mobile) }
}

/** Grid placements lead in row-major order, followed by desktop flow placements. */
export function automaticAppLayoutMobileOrder(items: readonly AppLayoutItem[]): readonly string[] {
  const childIds = new Set(items.flatMap((item) => item.kind === 'group' ? item.children : []))
  const topLevel = items.map((item, index) => ({ item, index })).filter(({ item }) => !childIds.has(item.id))
  const grid = topLevel.flatMap(({ item, index }) => {
    const placement = appLayoutGrid(item)
    return placement === undefined ? [] : [{ item, index, placement }]
  }).sort((left, right) => compareAppLayoutGrid(left.placement, right.placement) || left.index - right.index)
  const flow = topLevel.filter(({ item }) => appLayoutGrid(item) === undefined)
  return [...grid, ...flow].map(({ item }) => item.id)
}

/** Resolves a partial or stale customized order against the current placements. */
export function resolveAppLayoutMobileOrder(
  items: readonly AppLayoutItem[],
  storedOrder: readonly string[],
): readonly string[] {
  const automatic = automaticAppLayoutMobileOrder(items)
  const available = new Set(automatic)
  const seen = new Set<string>()
  const ordered = storedOrder.filter((id) => {
    if (!available.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  return [...ordered, ...automatic.filter((id) => !seen.has(id))]
}

/** Reads a version 1 flow layout without making malformed extension data fatal. */
export function appLayout(doc: WorkflowDocument): AppLayoutV1 | undefined {
  const raw = rawAppLayoutV1(doc.ext?.[APP_LAYOUT_EXT_KEY])
  if (raw === undefined) return undefined
  const items: AppLayoutItem[] = []
  const seen = new Set<string>()
  for (const value of raw.items) {
    const item = parseAppLayoutItem(value)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  const childIds = new Set(items.flatMap((item) => item.kind === 'group' ? item.children : []))
  const topLevel = items.map((item) => childIds.has(item.id) ? withoutAppLayoutGrid(item) : item)
  const gridPlacements = topLevel.flatMap((item) => {
    const grid = appLayoutGrid(item)
    return grid === undefined ? [] : [{ id: item.id, ...grid }]
  })
  const resolved = resolveAppLayoutGrid(gridPlacements)
  const resolvedById = resolved === undefined
    ? new Map<string, AppLayoutGrid>()
    : new Map(resolved.map(({ id: _id, ...grid }) => [_id, grid]))
  const normalized = topLevel.map((item) => {
    const grid = resolvedById.get(item.id)
    return grid === undefined ? withoutAppLayoutGrid(item) : withAppLayoutGrid(item, grid)
  })
  return {
    version: 1,
    desktop: { items: normalized },
    mobile: raw.mobileCustomized
      ? { customized: true, items: [], order: resolveAppLayoutMobileOrder(normalized, raw.mobileOrder) }
      : { customized: false, items: [] },
  }
}

/** Canonical JSON for a new or replaced placement. */
export function appLayoutItemToJson(item: AppLayoutItem): Json {
  const grid = appLayoutGrid(item)
  const coordinates = grid === undefined ? {} : grid
  switch (item.kind) {
    case 'control':
      return { id: item.id, kind: item.kind, ref: { ...item.ref }, ...coordinates }
    case 'preview':
      return { id: item.id, kind: item.kind, ref: { ...item.ref }, ...coordinates }
    case 'queue':
      return { id: item.id, kind: item.kind, label: item.label, targets: item.targets.map((target) => ({ ...target })), ...coordinates }
    case 'text':
      return { id: item.id, kind: item.kind, role: item.role, text: item.text, ...coordinates }
    case 'group':
      return { id: item.id, kind: item.kind, title: item.title, children: [...item.children], ...coordinates }
  }
}

export interface AppLayoutGridPlacement extends AppLayoutGrid {
  readonly id: string
}

export const appLayoutGridOverlap = (a: AppLayoutGrid, b: AppLayoutGrid): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** Row-major order is both the visual reading order and the DOM focus order. */
export const compareAppLayoutGrid = (a: AppLayoutGrid, b: AppLayoutGrid): number =>
  a.y - b.y || a.x - b.x

/** Resolves overlaps deterministically, keeping the actively edited placement authoritative. */
export function resolveAppLayoutGrid(
  placements: readonly AppLayoutGridPlacement[],
  priorityId?: string,
): readonly AppLayoutGridPlacement[] | undefined {
  const hasOverlap = placements.some((placement, index) =>
    placements.slice(index + 1).some((other) => appLayoutGridOverlap(placement, other)))
  if (!hasOverlap) return placements

  const states = placements.map((placement) => ({ ...placement }))
  const order = states.map((_placement, index) => index).sort((left, right) => {
    const leftPriority = states[left]!.id === priorityId ? -1 : 0
    const rightPriority = states[right]!.id === priorityId ? -1 : 0
    return leftPriority - rightPriority ||
      compareAppLayoutGrid(states[left]!, states[right]!) ||
      left - right
  })
  const pushed = new Set<number>()
  const settled: number[] = []
  for (const index of order) {
    let current = states[index]!
    while (true) {
      let y = current.y
      for (const otherIndex of settled) {
        const other = states[otherIndex]!
        if (appLayoutGridOverlap(current, other)) y = Math.max(y, other.y + other.h)
      }
      if (y === current.y) break
      if (!Number.isSafeInteger(y) || !Number.isSafeInteger(y + current.h)) return undefined
      current = { ...current, y }
      pushed.add(index)
    }
    states[index] = current
    settled.push(index)
  }

  for (const index of order) {
    if (states[index]!.id === priorityId || pushed.has(index)) continue
    const current = states[index]!
    const candidates = [
      0,
      ...states.flatMap((other, otherIndex) =>
        otherIndex === index || other.x >= current.x + current.w || other.x + other.w <= current.x
          ? []
          : [other.y + other.h]),
    ].filter((y) => y <= current.y).sort((a, b) => a - b)
    for (const y of candidates) {
      const candidate = { ...current, y }
      if (states.every((other, otherIndex) => otherIndex === index || !appLayoutGridOverlap(candidate, other))) {
        states[index] = candidate
        break
      }
    }
  }

  const result = placements.map((placement, index) => {
    const resolved = states[index]!
    return compareAppLayoutGrid(placement, resolved) === 0 && placement.w === resolved.w && placement.h === resolved.h
      ? placement
      : resolved
  })
  return result.every((placement, index) => placement === placements[index]) ? placements : result
}

export const emptyAppLayoutV1 = (): Json => ({
  version: 1,
  desktop: { items: [] },
  mobile: { customized: false, items: [] },
})

export const appLayoutControlKey = (
  ref: Pick<AppLayoutControlItem['ref'], 'graphId' | 'nodeId' | 'inputId'>,
): string => JSON.stringify([ref.graphId, ref.nodeId, ref.inputId])

export const appLayoutPreviewKey = (
  ref: Pick<AppLayoutPreviewItem['ref'], 'graphId' | 'nodeId'>,
): string => JSON.stringify([ref.graphId, ref.nodeId])

/** Graph ids referenced by valid semantic placements. */
export function appLayoutReferencedGraphIds(doc: WorkflowDocument): readonly string[] {
  return (appLayout(doc)?.desktop.items ?? []).flatMap((item) =>
    item.kind === 'control' || item.kind === 'preview'
      ? [item.ref.graphId]
      : item.kind === 'queue'
        ? item.targets.map((target) => target.graphId)
        : [])
}

const freshLocalizedId = (id: string, graphId: string, used: Set<string>): string => {
  const stem = `${id}@${graphId}`
  let candidate = stem
  let suffix = 2
  while (used.has(candidate)) candidate = `${stem}-${suffix++}`
  used.add(candidate)
  return candidate
}

/** Copies placements that target a localized graph definition. */
export function localizeAppLayoutJson(
  value: Json | undefined,
  sourceGraphId: string,
  localizedGraphId: string,
): Json | undefined {
  const raw = rawAppLayoutV1(value)
  if (raw === undefined) return undefined
  const used = new Set(raw.items.flatMap((item) => isObj(item) && nonEmpty(item.id) ? [item.id] : []))
  const seen = new Set<string>()
  const copies = new Map<string, string>()
  const items: Json[] = []
  for (const value of raw.items) {
    items.push(value)
    const item = parseAppLayoutItem(value)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    if (item.kind === 'queue' && isObj(value) && Array.isArray(value.targets)) {
      const localizedTargets = item.targets
        .filter((target) => target.graphId === sourceGraphId)
        .map((target) => ({ ...target, graphId: localizedGraphId }))
      if (localizedTargets.length > 0) {
        items[items.length - 1] = { ...value, targets: [...value.targets, ...localizedTargets] }
      }
      continue
    }
    if (
      (item.kind !== 'control' && item.kind !== 'preview') ||
      item.ref.graphId !== sourceGraphId ||
      !isObj(value) ||
      !isObj(value.ref)
    ) continue
    const id = freshLocalizedId(item.id, localizedGraphId, used)
    copies.set(item.id, id)
    items.push({ ...value, id, ref: { ...value.ref, graphId: localizedGraphId } })
  }
  if (copies.size === 0) return undefined
  const withGroups = items.map((value): Json => {
    const item = parseAppLayoutItem(value)
    if (item?.kind !== 'group' || !isObj(value) || !Array.isArray(value.children)) return value
    return {
      ...value,
      children: value.children.flatMap((child) =>
        typeof child === 'string' && copies.has(child) ? [child, copies.get(child)!] : [child]),
    }
  })
  return { ...raw.root, desktop: { ...raw.desktop, items: withGroups } }
}

/** Removes placements that reference deleted graph definitions. */
export function removeAppLayoutGraphRefs(
  value: Json | undefined,
  removedGraphIds: ReadonlySet<string>,
): Json | undefined {
  const raw = rawAppLayoutV1(value)
  if (raw === undefined) return undefined
  const seen = new Set<string>()
  const removedItems = new Set<string>()
  const queueTargets = new Map<string, readonly AppLayoutQueueTarget[]>()
  for (const value of raw.items) {
    const item = parseAppLayoutItem(value)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    if (item.kind === 'queue') {
      const retained = item.targets.filter((target) => !removedGraphIds.has(target.graphId))
      if (retained.length === 0) removedItems.add(item.id)
      else if (retained.length !== item.targets.length) queueTargets.set(item.id, retained)
      continue
    }
    if (
      (item.kind === 'control' || item.kind === 'preview') &&
      removedGraphIds.has(item.ref.graphId)
    ) removedItems.add(item.id)
  }
  if (removedItems.size === 0 && queueTargets.size === 0) return undefined
  const items = raw.items.flatMap((value): Json[] => {
    const item = parseAppLayoutItem(value)
    if (isObj(value) && nonEmpty(value.id) && removedItems.has(value.id)) return []
    if (item?.kind === 'queue' && isObj(value) && queueTargets.has(item.id)) {
      return [{ ...value, targets: queueTargets.get(item.id)!.map((target) => ({ ...target })) }]
    }
    if (item?.kind !== 'group' || !isObj(value) || !Array.isArray(value.children)) return [value]
    return [{
      ...value,
      children: value.children.filter((child) => typeof child !== 'string' || !removedItems.has(child)),
    }]
  })
  const mobile = raw.mobile === undefined
    ? raw.root.mobile
    : {
        ...raw.mobile,
        ...(Array.isArray(raw.mobile.order)
          ? { order: raw.mobile.order.filter((id) => typeof id !== 'string' || !removedItems.has(id)) }
          : {}),
      }
  return { ...raw.root, desktop: { ...raw.desktop, items }, ...(mobile === undefined ? {} : { mobile }) }
}
