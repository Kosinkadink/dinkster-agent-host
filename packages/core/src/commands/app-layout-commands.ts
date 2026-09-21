import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject, WorkflowDocument } from '../format/document.js'
import {
  APP_LAYOUT_EXT_KEY,
  appLayout,
  appLayoutGrid,
  appLayoutControlKey,
  appLayoutItemToJson,
  appLayoutPreviewKey,
  automaticAppLayoutMobileOrder,
  emptyAppLayoutV1,
  hasAppLayoutGridFields,
  parseAppLayoutItem,
  rawAppLayoutV1,
  resolveAppLayoutMobileOrder,
  resolveAppLayoutGrid,
  type AppLayoutGrid,
  type AppLayoutGroupItem,
  type AppLayoutItem,
} from '../format/app-layout.js'
import type { CommandDefinition, TransactionBuilder } from './contract.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface LocatedItem {
  readonly item: AppLayoutItem
  readonly raw: Json
  readonly index: number
}

const locatedItems = (doc: WorkflowDocument): readonly LocatedItem[] => {
  const raw = rawAppLayoutV1(doc.ext?.[APP_LAYOUT_EXT_KEY])
  if (raw === undefined) return []
  const seen = new Set<string>()
  return raw.items.flatMap((value, index) => {
    const item = parseAppLayoutItem(value)
    if (item === undefined || seen.has(item.id)) return []
    seen.add(item.id)
    return [{ item, raw: value, index }]
  })
}

const locate = (doc: WorkflowDocument, id: string): LocatedItem | undefined =>
  locatedItems(doc).find((entry) => entry.item.id === id)

const normalizeLayout = (tx: TransactionBuilder): void => {
  const raw = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])
  if (raw === undefined) return
  const seen = new Set<string>()
  const removed = raw.items.flatMap((value, index) => {
    const item = parseAppLayoutItem(value)
    if (item === undefined || seen.has(item.id)) return [index]
    seen.add(item.id)
    return []
  })
  for (const index of removed.reverse()) {
    tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', index])
  }

  const byId = new Map(locatedItems(tx.current).map((entry) => [entry.item.id, entry.item]))
  const claimed = new Set<string>()
  for (const group of groupLocations(tx.current)) {
    const current = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])?.items[group.index]
    if (!isObj(current) || !Array.isArray(current.children)) continue
    const invalid: number[] = []
    for (const [index, child] of current.children.entries()) {
      const item = typeof child === 'string' ? byId.get(child) : undefined
      if (item === undefined || item.kind === 'group' || claimed.has(item.id)) invalid.push(index)
      else claimed.add(item.id)
    }
    for (const index of invalid.reverse()) {
      tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', group.index, 'children', index])
    }
  }
}

const ensureLayout = (tx: TransactionBuilder): void => {
  if (tx.current.ext === undefined) tx.set(['ext'], {})
  if (rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY]) === undefined) {
    tx.set(['ext', APP_LAYOUT_EXT_KEY], emptyAppLayoutV1())
  } else normalizeLayout(tx)
}

const idOf = (params: Json, command: string): { id?: string; error?: Diagnostic } => {
  if (!isObj(params) || typeof params.id !== 'string' || params.id.length === 0) {
    return { error: err('params.invalid', `${command}: id must be a non-empty string`) }
  }
  return { id: params.id }
}

const groupLocations = (doc: WorkflowDocument): readonly (LocatedItem & { readonly item: AppLayoutGroupItem })[] =>
  locatedItems(doc).filter((entry): entry is LocatedItem & { readonly item: AppLayoutGroupItem } =>
    entry.item.kind === 'group')

const removeFromGroups = (tx: TransactionBuilder, id: string): void => {
  for (const group of groupLocations(tx.current)) {
    const raw = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])?.items[group.index]
    if (!isObj(raw) || !Array.isArray(raw.children)) continue
    const indices = raw.children.flatMap((child, index) => child === id ? [index] : []).reverse()
    for (const index of indices) {
      tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', group.index, 'children', index])
    }
  }
}

const removeFromMobileOrder = (tx: TransactionBuilder, id: string): void => {
  const mobile = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])?.mobile
  if (!isObj(mobile) || !Array.isArray(mobile.order)) return
  const indices = mobile.order.flatMap((entry, index) => entry === id ? [index] : []).reverse()
  for (const index of indices) {
    tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'mobile', 'order', index])
  }
}

const childIds = (doc: WorkflowDocument): ReadonlySet<string> =>
  new Set(groupLocations(doc).flatMap((group) => group.item.children))

const topLevel = (doc: WorkflowDocument): readonly LocatedItem[] => {
  const children = childIds(doc)
  return locatedItems(doc).filter((entry) => !children.has(entry.item.id))
}

const gridPath = (index: number, field: keyof AppLayoutGrid): readonly (string | number)[] =>
  ['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', index, field]

const clearRawGrid = (tx: TransactionBuilder, index: number): void => {
  const raw = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])?.items[index]
  if (!isObj(raw)) return
  for (const field of ['x', 'y', 'w', 'h'] as const) {
    if (Object.hasOwn(raw, field)) tx.remove(gridPath(index, field))
  }
}

const writeGrid = (tx: TransactionBuilder, index: number, grid: AppLayoutGrid): void => {
  for (const field of ['x', 'y', 'w', 'h'] as const) tx.set(gridPath(index, field), grid[field])
}

const sameGrid = (left: AppLayoutGrid | undefined, right: AppLayoutGrid): boolean =>
  left !== undefined && left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h

const resolveLayoutGrid = (tx: TransactionBuilder, priorityId?: string): Diagnostic | undefined => {
  const placements = topLevel(tx.current).flatMap(({ item }) => {
    const grid = appLayoutGrid(item)
    return grid === undefined ? [] : [{ id: item.id, ...grid }]
  })
  const resolved = resolveAppLayoutGrid(placements, priorityId)
  if (resolved === undefined) {
    return err('app.layout.gridOverflow', 'app.layout: grid collision resolution exceeded safe integer rows')
  }
  for (const { id, ...grid } of resolved) {
    const current = locate(tx.current, id)
    if (current !== undefined && !sameGrid(appLayoutGrid(current.item), grid)) writeGrid(tx, current.index, grid)
  }
  return undefined
}

const targetParent = (
  params: JsonObject,
  command: string,
): { parentId?: string; error?: Diagnostic } => {
  if (params.parentId === undefined || params.parentId === null) return {}
  if (typeof params.parentId !== 'string' || params.parentId.length === 0) {
    return { error: err('params.invalid', `${command}: parentId must be a non-empty string or null`) }
  }
  return { parentId: params.parentId }
}

const requestedIndex = (
  params: JsonObject,
  command: string,
): { index?: number; error?: Diagnostic } => {
  if (params.index === undefined) return {}
  if (typeof params.index !== 'number' || !Number.isInteger(params.index) || params.index < 0) {
    return { error: err('params.invalid', `${command}: index must be a non-negative integer`) }
  }
  return { index: params.index }
}

const insertTopLevel = (tx: TransactionBuilder, value: Json, index: number): Diagnostic | undefined => {
  const top = topLevel(tx.current)
  if (index > top.length) {
    return err('params.invalid', `app.layout: index ${index} out of range (${top.length} top-level items)`)
  }
  const items = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])!.items
  const rawIndex = index === top.length ? items.length : top[index]!.index
  tx.insert(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', rawIndex], value)
  return undefined
}

const insertIntoGroup = (
  tx: TransactionBuilder,
  groupId: string,
  childId: string,
  index: number,
): Diagnostic | undefined => {
  const group = locate(tx.current, groupId)
  if (group?.item.kind !== 'group') {
    return err('app.layout.groupMissing', `app.layout: '${groupId}' is not a group`)
  }
  if (index > group.item.children.length) {
    return err('params.invalid', `app.layout: index ${index} out of range (${group.item.children.length} group items)`)
  }
  tx.insert(
    ['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', group.index, 'children', index],
    childId,
  )
  return undefined
}

const duplicateRef = (doc: WorkflowDocument, item: AppLayoutItem): boolean => {
  if (item.kind !== 'control' && item.kind !== 'preview') return false
  const key = item.kind === 'control' ? appLayoutControlKey(item.ref) : appLayoutPreviewKey(item.ref)
  return locatedItems(doc).some((entry) => {
    if (item.kind === 'control' && entry.item.kind === 'control') {
      return appLayoutControlKey(entry.item.ref) === key
    }
    if (item.kind === 'preview' && entry.item.kind === 'preview') {
      return appLayoutPreviewKey(entry.item.ref) === key
    }
    return false
  })
}

const layoutAdd: CommandDefinition = {
  id: 'app.layout.add',
  run(_doc, params, tx) {
    if (!isObj(params)) return [err('params.invalid', 'app.layout.add: params must be an object')]
    const rawItem = params.item as Json
    const item = parseAppLayoutItem(rawItem)
    if (item === undefined) return [err('params.invalid', 'app.layout.add: item is not a valid placement')]
    if (isObj(rawItem) && hasAppLayoutGridFields(rawItem) && appLayoutGrid(rawItem) === undefined) {
      return [err('params.invalid', 'app.layout.add: grid coordinates must be complete safe integers within 12 columns')]
    }
    if (item.kind === 'group' && item.children.length > 0) {
      return [err('params.invalid', 'app.layout.add: a new group must have no children')]
    }
    const parent = targetParent(params, 'app.layout.add')
    if (parent.error !== undefined) return [parent.error]
    const requested = requestedIndex(params, 'app.layout.add')
    if (requested.error !== undefined) return [requested.error]
    ensureLayout(tx)
    if (locate(tx.current, item.id) !== undefined) {
      return [err('app.layout.duplicate', `app.layout.add: item '${item.id}' already exists`)]
    }
    if (duplicateRef(tx.current, item)) {
      return [err('app.layout.duplicate', 'app.layout.add: that exposed item is already placed')]
    }
    if (parent.parentId !== undefined && item.kind === 'group') {
      return [err('params.invalid', 'app.layout.add: groups cannot be nested')]
    }
    if (parent.parentId !== undefined && appLayoutGrid(item) !== undefined) {
      return [err('params.invalid', 'app.layout.add: group children cannot have grid coordinates')]
    }
    if (parent.parentId === undefined) {
      const index = requested.index ?? topLevel(tx.current).length
      const diagnostic = insertTopLevel(tx, appLayoutItemToJson(item), index)
      if (diagnostic !== undefined) return [diagnostic]
      const gridDiagnostic = appLayoutGrid(item) === undefined ? undefined : resolveLayoutGrid(tx, item.id)
      return gridDiagnostic === undefined ? [] : [gridDiagnostic]
    }
    const group = locate(tx.current, parent.parentId)
    if (group?.item.kind !== 'group') {
      return [err('app.layout.groupMissing', `app.layout.add: '${parent.parentId}' is not a group`)]
    }
    const raw = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])!
    tx.insert(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', raw.items.length], appLayoutItemToJson(item))
    const diagnostic = insertIntoGroup(
      tx,
      parent.parentId,
      item.id,
      requested.index ?? group.item.children.length,
    )
    return diagnostic === undefined ? [] : [diagnostic]
  },
}

const layoutRemove: CommandDefinition = {
  id: 'app.layout.remove',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.remove')
    if (id === undefined) return [error!]
    ensureLayout(tx)
    const item = locate(tx.current, id)
    if (item === undefined) return [err('app.layout.missing', `app.layout.remove: item '${id}' does not exist`)]
    removeFromGroups(tx, id)
    removeFromMobileOrder(tx, id)
    const current = locate(tx.current, id)!
    tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', current.index])
    return []
  },
}

const layoutMove: CommandDefinition = {
  id: 'app.layout.move',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.move')
    if (id === undefined) return [error!]
    if (!isObj(params)) return [err('params.invalid', 'app.layout.move: params must be an object')]
    const parent = targetParent(params, 'app.layout.move')
    if (parent.error !== undefined) return [parent.error]
    const requested = requestedIndex(params, 'app.layout.move')
    if (requested.error !== undefined || requested.index === undefined) {
      return [requested.error ?? err('params.invalid', 'app.layout.move: index is required')]
    }
    ensureLayout(tx)
    const located = locate(tx.current, id)
    if (located === undefined) return [err('app.layout.missing', `app.layout.move: item '${id}' does not exist`)]
    if (parent.parentId !== undefined && located.item.kind === 'group') {
      return [err('params.invalid', 'app.layout.move: groups cannot be nested')]
    }
    if (parent.parentId !== undefined && locate(tx.current, parent.parentId)?.item.kind !== 'group') {
      return [err('app.layout.groupMissing', `app.layout.move: '${parent.parentId}' is not a group`)]
    }
    const currentGroup = groupLocations(tx.current).find((group) => group.item.children.includes(id))
    const currentParentId = currentGroup?.item.id
    const currentIndex = currentGroup === undefined
      ? topLevel(tx.current).findIndex((entry) => entry.item.id === id)
      : currentGroup.item.children.indexOf(id)
    if (currentParentId === parent.parentId && currentIndex === requested.index) return []
    removeFromGroups(tx, id)
    if (parent.parentId !== undefined) {
      const current = locate(tx.current, id)!
      clearRawGrid(tx, current.index)
      const diagnostic = insertIntoGroup(tx, parent.parentId, id, requested.index)
      return diagnostic === undefined ? [] : [diagnostic]
    }
    const current = locate(tx.current, id)!
    const raw = current.raw
    tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', current.index])
    const diagnostic = insertTopLevel(tx, raw, requested.index)
    return diagnostic === undefined ? [] : [diagnostic]
  },
}

const layoutSetGrid: CommandDefinition = {
  id: 'app.layout.setGrid',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.setGrid')
    if (id === undefined) return [error!]
    if (!isObj(params) || (params.grid !== null && !isObj(params.grid))) {
      return [err('params.invalid', 'app.layout.setGrid: grid must be an object or null')]
    }
    const grid = params.grid === null ? undefined : appLayoutGrid(params.grid)
    if (params.grid !== null && grid === undefined) {
      return [err('params.invalid', 'app.layout.setGrid: grid must use complete safe integer coordinates within 12 columns')]
    }
    ensureLayout(tx)
    const item = locate(tx.current, id)
    if (item === undefined) {
      return [err('app.layout.missing', `app.layout.setGrid: item '${id}' does not exist`)]
    }
    if (grid !== undefined && childIds(tx.current).has(id)) {
      return [err('params.invalid', 'app.layout.setGrid: group children cannot have grid coordinates')]
    }
    if (grid === undefined) clearRawGrid(tx, item.index)
    else writeGrid(tx, item.index, grid)
    const diagnostic = resolveLayoutGrid(tx, grid === undefined ? undefined : id)
    return diagnostic === undefined ? [] : [diagnostic]
  },
}

const layoutSetText: CommandDefinition = {
  id: 'app.layout.setText',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.setText')
    if (id === undefined) return [error!]
    if (!isObj(params)) return [err('params.invalid', 'app.layout.setText: params must be an object')]
    const hasText = Object.hasOwn(params, 'text')
    const hasRole = Object.hasOwn(params, 'role')
    if (!hasText && !hasRole) {
      return [err('params.invalid', 'app.layout.setText: text or role is required')]
    }
    if (hasText && typeof params.text !== 'string') {
      return [err('params.invalid', 'app.layout.setText: text must be a string')]
    }
    if (hasRole && params.role !== 'heading' && params.role !== 'body' && params.role !== 'caption') {
      return [err('params.invalid', 'app.layout.setText: role must be heading, body, or caption')]
    }
    ensureLayout(tx)
    const item = locate(tx.current, id)
    if (item?.item.kind !== 'text') {
      return [err('app.layout.missing', `app.layout.setText: text item '${id}' does not exist`)]
    }
    if (hasText) tx.set(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', item.index, 'text'], params.text!)
    if (hasRole) tx.set(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', item.index, 'role'], params.role!)
    return []
  },
}

const layoutSetGroupTitle: CommandDefinition = {
  id: 'app.layout.setGroupTitle',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.setGroupTitle')
    if (id === undefined) return [error!]
    if (!isObj(params) || typeof params.title !== 'string' || params.title.length === 0) {
      return [err('params.invalid', 'app.layout.setGroupTitle: title must be a non-empty string')]
    }
    ensureLayout(tx)
    const item = locate(tx.current, id)
    if (item?.item.kind !== 'group') {
      return [err('app.layout.missing', `app.layout.setGroupTitle: group '${id}' does not exist`)]
    }
    tx.set(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', item.index, 'title'], params.title)
    return []
  },
}

const layoutSetQueue: CommandDefinition = {
  id: 'app.layout.setQueue',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.setQueue')
    if (id === undefined) return [error!]
    if (!isObj(params)) return [err('params.invalid', 'app.layout.setQueue: params must be an object')]
    const current = locate(tx.current, id)
    if (current?.item.kind !== 'queue') {
      return [err('app.layout.missing', `app.layout.setQueue: queue item '${id}' does not exist`)]
    }
    const hasLabel = Object.hasOwn(params, 'label')
    const hasTargets = Object.hasOwn(params, 'targets')
    if (!hasLabel && !hasTargets) return [err('params.invalid', 'app.layout.setQueue: label or targets is required')]
    const candidate = parseAppLayoutItem({
      ...appLayoutItemToJson(current.item) as JsonObject,
      ...(hasLabel ? { label: params.label } : {}),
      ...(hasTargets ? { targets: params.targets } : {}),
    })
    if (candidate?.kind !== 'queue') {
      return [err('params.invalid', 'app.layout.setQueue: label must be non-empty and targets must contain a valid definition target')]
    }
    ensureLayout(tx)
    const item = locate(tx.current, id)!
    if (hasLabel) tx.set(['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', item.index, 'label'], candidate.label)
    if (hasTargets) tx.set(
      ['ext', APP_LAYOUT_EXT_KEY, 'desktop', 'items', item.index, 'targets'],
      candidate.targets.map((target) => ({ ...target })),
    )
    return []
  },
}

const canonicalizeMobileOrder = (tx: TransactionBuilder, automatic: readonly string[]): void => {
  let raw = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])!
  if (!Array.isArray(raw.mobile?.items) || raw.mobile.items.length !== 0) {
    tx.set(['ext', APP_LAYOUT_EXT_KEY, 'mobile', 'items'], [])
    raw = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])!
  }
  const order = raw.mobile?.order
  if (!Array.isArray(order)) return
  const available = new Set(automatic)
  const seen = new Set<string>()
  const removed: number[] = []
  for (const [index, entry] of order.entries()) {
    if (typeof entry !== 'string' || !available.has(entry) || seen.has(entry)) removed.push(index)
    else seen.add(entry)
  }
  for (const index of removed.reverse()) {
    tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'mobile', 'order', index])
  }
  const current = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])!.mobile!.order as readonly Json[]
  let index = current.length
  for (const id of automatic) {
    if (seen.has(id)) continue
    tx.insert(['ext', APP_LAYOUT_EXT_KEY, 'mobile', 'order', index++], id)
  }
}

const layoutMoveMobile: CommandDefinition = {
  id: 'app.layout.moveMobile',
  run(_doc, params, tx) {
    const { id, error } = idOf(params, 'app.layout.moveMobile')
    if (id === undefined) return [error!]
    if (!isObj(params)) return [err('params.invalid', 'app.layout.moveMobile: params must be an object')]
    const requested = requestedIndex(params, 'app.layout.moveMobile')
    if (requested.error !== undefined || requested.index === undefined) {
      return [requested.error ?? err('params.invalid', 'app.layout.moveMobile: index is required')]
    }
    ensureLayout(tx)
    const layout = appLayout(tx.current)!
    const automatic = automaticAppLayoutMobileOrder(layout.desktop.items)
    if (!automatic.includes(id)) {
      return [err('app.layout.missing', `app.layout.moveMobile: top-level item '${id}' does not exist`)]
    }
    if (requested.index >= automatic.length) {
      return [err('params.invalid', `app.layout.moveMobile: index ${requested.index} out of range (${automatic.length} mobile items)`)]
    }
    const current = layout.mobile.customized
      ? resolveAppLayoutMobileOrder(layout.desktop.items, layout.mobile.order)
      : automatic
    const currentIndex = current.indexOf(id)
    if (currentIndex === requested.index) return []
    const moved = [...current]
    moved.splice(currentIndex, 1)
    moved.splice(requested.index, 0, id)
    if (!layout.mobile.customized) {
      tx.set(['ext', APP_LAYOUT_EXT_KEY, 'mobile'], { customized: true, items: [], order: moved })
      return []
    }
    canonicalizeMobileOrder(tx, automatic)
    const order = rawAppLayoutV1(tx.current.ext?.[APP_LAYOUT_EXT_KEY])!.mobile!.order as readonly Json[]
    const rawIndex = order.indexOf(id)
    tx.remove(['ext', APP_LAYOUT_EXT_KEY, 'mobile', 'order', rawIndex])
    tx.insert(['ext', APP_LAYOUT_EXT_KEY, 'mobile', 'order', requested.index], id)
    return []
  },
}

const layoutResetMobile: CommandDefinition = {
  id: 'app.layout.resetMobile',
  run(_doc, params, tx) {
    if (!isObj(params) || Object.keys(params).length !== 0) {
      return [err('params.invalid', 'app.layout.resetMobile: params must be an empty object')]
    }
    ensureLayout(tx)
    if (appLayout(tx.current)?.mobile.customized !== true) return []
    tx.set(['ext', APP_LAYOUT_EXT_KEY, 'mobile'], { customized: false, items: [] })
    return []
  },
}

export const APP_LAYOUT_COMMANDS: readonly CommandDefinition[] = [
  layoutAdd,
  layoutRemove,
  layoutMove,
  layoutSetGrid,
  layoutSetText,
  layoutSetGroupTitle,
  layoutSetQueue,
  layoutMoveMobile,
  layoutResetMobile,
]
