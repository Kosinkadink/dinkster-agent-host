import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { applyOwnedOps, invertOps, type PatchOp } from '../commands/patch.js'
import { actorCursorOf, isValidActorId } from '../ids.js'
import { loadImageDocument } from './migrate.js'
import {
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_OUTPUT_POLICY_EXTENSION,
  asImageLayerId,
  asImageMaskId,
  asImageResourceId,
  orderedImageLayerIds,
  type ImageDocument,
  type ImageGroupLayer,
  type ImageRasterLayer,
  type ImageRasterMask,
  type ImageRasterResource,
} from './model.js'

export type ImageRasterInput = Omit<ImageRasterResource, 'id'>

type ImageDocumentCommand =
  | {
      readonly command: 'image.canvas.crop'
      readonly params: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    }
  | {
      readonly command: 'image.canvas.resize'
      readonly params: { readonly width: number; readonly height: number }
    }
  | {
      readonly command: 'image.canvas.update'
      readonly params: {
        readonly width: number
        readonly height: number
        readonly compositing?: ImageDocument['canvas']['compositing']
      }
    }
  | {
      readonly command: 'image.output.update'
      readonly params: { readonly format: 'png' | 'jpeg' | 'webp'; readonly quality: number }
    }
  | {
      readonly command: 'image.layer.group'
      readonly params: { readonly layerIds: readonly string[]; readonly name: string }
    }
  | {
      readonly command: 'image.layer.update'
      readonly params: {
        readonly layerId: string
        readonly name?: string
        readonly visible?: boolean
        readonly opacity?: number
        readonly blendMode?: string
        readonly clipping?: 'none' | 'clip-to-previous'
        readonly transform?: Json
        readonly z_index?: number
        readonly isolation?: 'isolated' | 'pass-through'
      }
    }
  | {
      readonly command: 'image.layer.addRaster'
      readonly params: {
        readonly parentId: string | null
        readonly index: number
        readonly name: string
        readonly resource: ImageRasterInput
        readonly sourceRect: Json
      }
    }
  | {
      readonly command: 'image.layer.move'
      readonly params: { readonly layerId: string; readonly parentId: string | null; readonly index: number }
    }
  | {
      readonly command: 'image.layer.remove'
      readonly params: { readonly layerId: string }
    }
  | {
      readonly command: 'image.mask.update'
      readonly params: {
        readonly maskId: string
        readonly enabled?: boolean
        readonly invert?: boolean
        readonly opacity?: number
        readonly transform?: Json
        readonly combineMode?: string
        readonly channel?: string
      }
    }
  | {
      readonly command: 'image.mask.addRaster'
      readonly params: {
        readonly ownerLayerId: string
        readonly index: number
        readonly resource: ImageRasterInput
        readonly sourceRect: Json
      }
    }
  | {
      readonly command: 'image.mask.remove'
      readonly params: { readonly maskId: string }
    }

export type ImageDocumentCommandInvocation = ImageDocumentCommand & {
  readonly actor?: string
}

export interface ImageDocumentCommandPlan {
  readonly invocation: ImageDocumentCommandInvocation
  readonly document: ImageDocument
  readonly forward: readonly PatchOp[]
  readonly redo: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly created?: {
    readonly layerId?: string
    readonly maskId?: string
    readonly resourceId?: string
  }
}

export type ImageDocumentCommandResult =
  | { readonly ok: true; readonly plan: ImageDocumentCommandPlan }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

const failure = (code: string, message: string): ImageDocumentCommandResult => ({
  ok: false,
  diagnostics: [diag('error', 'command', code, message)],
})

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function exactKeys(
  value: Json | undefined,
  required: readonly string[],
  optional: readonly string[] = [],
): value is JsonObject {
  if (!isObject(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}

function decodeInvocation(value: unknown): ImageDocumentCommandInvocation | undefined {
  const owned = ownJson(value as Json, { undefinedProps: 'reject' })
  if (!owned.ok || !exactKeys(owned.value, ['command', 'params'], ['actor'])) return undefined
  const command = owned.value['command']
  const params = owned.value['params']
  const actor = owned.value['actor']
  if (typeof command !== 'string' || (actor !== undefined && !isValidActorId(actor))) return undefined
  const decoded = (paramsValue: ImageDocumentCommand['params']): ImageDocumentCommandInvocation => ({
    command,
    params: paramsValue,
    ...(actor !== undefined ? { actor } : {}),
  } as ImageDocumentCommandInvocation)
  switch (command) {
    case 'image.canvas.crop':
      if (!exactKeys(params, ['x', 'y', 'width', 'height']) ||
        !['x', 'y', 'width', 'height'].every((key) => typeof params[key] === 'number')) return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.canvas.resize':
      if (!exactKeys(params, ['width', 'height']) ||
        typeof params['width'] !== 'number' || typeof params['height'] !== 'number') return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.canvas.update':
      if (!exactKeys(params, ['width', 'height'], ['compositing']) ||
        typeof params['width'] !== 'number' || typeof params['height'] !== 'number') return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.output.update':
      if (!exactKeys(params, ['format', 'quality']) || typeof params['format'] !== 'string' ||
        typeof params['quality'] !== 'number') return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.layer.group':
      if (!exactKeys(params, ['layerIds', 'name']) || typeof params['name'] !== 'string' ||
        !Array.isArray(params['layerIds']) || !params['layerIds'].every((id) => typeof id === 'string')) return undefined
      return decoded({ layerIds: params['layerIds'] as string[], name: params['name'] })
    case 'image.layer.update':
      if (!exactKeys(params, ['layerId'], ['name', 'visible', 'opacity', 'blendMode', 'clipping', 'transform', 'z_index', 'isolation']) ||
        typeof params['layerId'] !== 'string' || Object.keys(params).length === 1) return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.layer.addRaster':
      if (!exactKeys(params, ['parentId', 'index', 'name', 'resource', 'sourceRect']) ||
        !(typeof params['parentId'] === 'string' || params['parentId'] === null) ||
        typeof params['index'] !== 'number' || typeof params['name'] !== 'string' ||
        !isObject(params['resource']) || !isObject(params['sourceRect'])) return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.layer.move':
      if (!exactKeys(params, ['layerId', 'parentId', 'index']) ||
        typeof params['layerId'] !== 'string' ||
        !(typeof params['parentId'] === 'string' || params['parentId'] === null) ||
        typeof params['index'] !== 'number') return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.layer.remove':
      if (!exactKeys(params, ['layerId']) || typeof params['layerId'] !== 'string') return undefined
      return decoded({ layerId: params['layerId'] })
    case 'image.mask.update':
      if (!exactKeys(params, ['maskId'], ['enabled', 'invert', 'opacity', 'transform', 'combineMode', 'channel']) ||
        typeof params['maskId'] !== 'string' || Object.keys(params).length === 1) return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.mask.addRaster':
      if (!exactKeys(params, ['ownerLayerId', 'index', 'resource', 'sourceRect']) ||
        typeof params['ownerLayerId'] !== 'string' || typeof params['index'] !== 'number' ||
        !isObject(params['resource']) || !isObject(params['sourceRect'])) return undefined
      return decoded(params as unknown as Extract<ImageDocumentCommand, { command: typeof command }>['params'])
    case 'image.mask.remove':
      if (!exactKeys(params, ['maskId']) || typeof params['maskId'] !== 'string') return undefined
      return decoded({ maskId: params['maskId'] })
    default:
      return undefined
  }
}

function own(value: unknown): Json {
  const result = ownJson(value as Json, { undefinedProps: 'reject' })
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

const path = (...segments: (string | number)[]): readonly (string | number)[] => Object.freeze(segments)

function replace(at: readonly (string | number)[], previous: unknown, value: unknown): PatchOp {
  return Object.freeze({ op: 'replace', path: at, oldValue: previous as Json, value: own(value) })
}

function add(at: readonly (string | number)[], value: unknown): PatchOp {
  return Object.freeze({ op: 'add', path: at, value: own(value) })
}

function remove(at: readonly (string | number)[], previous: unknown): PatchOp {
  return Object.freeze({ op: 'remove', path: at, oldValue: previous as Json })
}

interface LayerParent {
  readonly id: string | null
  readonly children: readonly string[]
}

function layerParent(document: ImageDocument, layerId: string): LayerParent | undefined {
  if (document.rootLayerIds.includes(asImageLayerId(layerId))) {
    return { id: null, children: orderedImageLayerIds(document, document.rootLayerIds) }
  }
  for (const layer of Object.values(document.layers)) {
    if (layer.kind === 'group' && layer.childLayerIds.includes(asImageLayerId(layerId))) {
      return { id: layer.id, children: orderedImageLayerIds(document, layer.childLayerIds) }
    }
  }
  return undefined
}

function parentChildren(document: ImageDocument, parentId: string | null): readonly string[] | undefined {
  if (parentId === null) return orderedImageLayerIds(document, document.rootLayerIds)
  const parent = getOwn(document.layers, parentId)
  return parent?.kind === 'group' ? orderedImageLayerIds(document, parent.childLayerIds) : undefined
}

function parentListPatches(document: ImageDocument, parentId: string | null, children: readonly string[]): PatchOp[] {
  const parent = parentId === null ? undefined : getOwn(document.layers, parentId)
  const previous = parent?.kind === 'group' ? parent.childLayerIds : document.rootLayerIds
  return [
    replace(parentId === null ? path('rootLayerIds') : path('layers', parentId, 'childLayerIds'), previous, children),
    ...layerOrderPatches(document, children),
  ]
}

function layerOrderPatches(document: ImageDocument, children: readonly string[]): PatchOp[] {
  if (!children.some((id) => getOwn(document.layers, id)?.z_index !== undefined)) return []
  const patches: PatchOp[] = []
  children.forEach((id, index) => {
    const previousZ = getOwn(document.layers, id)?.z_index
    if (previousZ === index) return
    patches.push(previousZ === undefined
      ? add(path('layers', id, 'z_index'), index)
      : replace(path('layers', id, 'z_index'), previousZ, index))
  })
  return patches
}

function resourceInput(value: ImageRasterInput, id: string): ImageRasterResource {
  return { ...value, id: asImageResourceId(id) }
}

function allocateIds(
  document: ImageDocument,
  actor: string | undefined,
  prefixes: readonly ('r' | 'l' | 'm')[],
): { readonly ids: readonly string[]; readonly patch: PatchOp } {
  if (actor === undefined) {
    const ordinal = document.allocation.nextOrdinal
    return {
      ids: prefixes.map((prefix, index) => `${prefix}${ordinal + index}`),
      patch: replace(path('allocation', 'nextOrdinal'), ordinal, ordinal + prefixes.length),
    }
  }
  const cursors = document.allocation.actorCursors ?? {}
  const ordinal = actorCursorOf(cursors, actor)
  const next = { ...cursors, [actor]: ordinal + prefixes.length }
  return {
    ids: prefixes.map((prefix, index) => `${prefix}${ordinal + index}-${actor}`),
    patch: document.allocation.actorCursors === undefined
      ? add(path('allocation', 'actorCursors'), next)
      : replace(path('allocation', 'actorCursors'), cursors, next),
  }
}

function referencedResources(document: ImageDocument, excludedLayers: ReadonlySet<string>, excludedMasks: ReadonlySet<string>): Set<string> {
  const referenced = new Set<string>()
  for (const layer of Object.values(document.layers)) {
    if (!excludedLayers.has(layer.id) && layer.kind === 'raster') referenced.add(layer.resourceId)
  }
  for (const mask of Object.values(document.masks)) {
    if (!excludedMasks.has(mask.id) && !excludedLayers.has(mask.ownerLayerId)) referenced.add(mask.resourceId)
  }
  return referenced
}

function descendantIds(document: ImageDocument, rootId: string): Set<string> {
  const result = new Set<string>()
  const visit = (id: string): void => {
    if (result.has(id)) return
    result.add(id)
    const layer = getOwn(document.layers, id)
    if (layer?.kind === 'group') layer.childLayerIds.forEach(visit)
  }
  visit(rootId)
  return result
}

function divideRoundEven(numerator: bigint, denominator: bigint): number {
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const quotient = absolute / denominator
  const remainder = absolute % denominator
  const doubled = remainder * 2n
  const rounded = doubled > denominator || (doubled === denominator && quotient % 2n === 1n)
    ? quotient + 1n
    : quotient
  return Number(negative ? -rounded : rounded)
}

function rootTransformPatches(
  document: ImageDocument,
  transform: (value: ImageDocument['layers'][string]['transform']) => ImageDocument['layers'][string]['transform'],
): PatchOp[] {
  return document.rootLayerIds.map((id) => {
    const layer = document.layers[id]!
    return replace(path('layers', id, 'transform'), layer.transform, transform(layer.transform))
  })
}

function commandPatches(
  document: ImageDocument,
  invocation: ImageDocumentCommandInvocation,
): { readonly patches: readonly PatchOp[]; readonly created?: ImageDocumentCommandPlan['created'] } | undefined {
  switch (invocation.command) {
    case 'image.canvas.crop': {
      const { x, y, width, height } = invocation.params
      if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1 ||
        x + width > document.canvas.width || y + height > document.canvas.height) return undefined
      return { patches: [
        replace(path('canvas'), document.canvas, { ...document.canvas, width, height }),
        ...rootTransformPatches(document, ({ components: _components, ...value }) => ({
          ...value,
          tx: value.tx - x * IMAGE_FIXED_POINT_SCALE,
          ty: value.ty - y * IMAGE_FIXED_POINT_SCALE,
        })),
      ] }
    }
    case 'image.canvas.resize': {
      const { width, height } = invocation.params
      if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1) return undefined
      const oldWidth = BigInt(document.canvas.width)
      const oldHeight = BigInt(document.canvas.height)
      return { patches: [
        replace(path('canvas'), document.canvas, { ...document.canvas, width, height }),
        ...rootTransformPatches(document, ({ components: _components, ...value }) => ({
          a: divideRoundEven(BigInt(value.a) * BigInt(width), oldWidth),
          b: divideRoundEven(BigInt(value.b) * BigInt(height), oldHeight),
          c: divideRoundEven(BigInt(value.c) * BigInt(width), oldWidth),
          d: divideRoundEven(BigInt(value.d) * BigInt(height), oldHeight),
          tx: divideRoundEven(BigInt(value.tx) * BigInt(width), oldWidth),
          ty: divideRoundEven(BigInt(value.ty) * BigInt(height), oldHeight),
        })),
      ] }
    }
    case 'image.canvas.update':
      return { patches: [replace(path('canvas'), document.canvas, { ...document.canvas, ...invocation.params })] }
    case 'image.output.update': {
      const { format, quality } = invocation.params
      if (!IMAGE_OUTPUT_FORMATS.includes(format) || !Number.isSafeInteger(quality) || quality < 0 || quality > 100) return undefined
      const policy = { format, quality }
      if (document.extensions === undefined) {
        return { patches: [add(path('extensions'), { [IMAGE_OUTPUT_POLICY_EXTENSION]: policy })] }
      }
      const previous = document.extensions[IMAGE_OUTPUT_POLICY_EXTENSION]
      return { patches: [previous === undefined
        ? add(path('extensions', IMAGE_OUTPUT_POLICY_EXTENSION), policy)
        : replace(path('extensions', IMAGE_OUTPUT_POLICY_EXTENSION), previous, policy)] }
    }
    case 'image.layer.group': {
      const { layerIds, name } = invocation.params
      if (layerIds.length === 0 || new Set(layerIds).size !== layerIds.length) return undefined
      const parent = layerParent(document, layerIds[0]!)
      if (parent === undefined || !layerIds.every((id) => layerParent(document, id)?.id === parent.id)) return undefined
      const selected = new Set(layerIds)
      const children = parent.children.filter((id) => selected.has(id))
      const index = parent.children.indexOf(children[0]!)
      if (!children.every((id, offset) => parent.children[index + offset] === id)) return undefined
      const allocated = allocateIds(document, invocation.actor, ['l'])
      const layerId = allocated.ids[0]!
      const group: ImageGroupLayer = {
        id: asImageLayerId(layerId), kind: 'group', name, visible: true, opacity: 65_535,
        transform: { a: 1_000_000, b: 0, c: 0, d: 1_000_000, tx: 0, ty: 0 },
        blendMode: 'normal', clipping: 'none', maskIds: [],
        childLayerIds: children.map(asImageLayerId),
      }
      const siblings = [...parent.children]
      siblings.splice(index, children.length, layerId)
      return {
        patches: [
          allocated.patch, add(path('layers', layerId), group),
          ...parentListPatches(document, parent.id, siblings), ...layerOrderPatches(document, children),
        ],
        created: { layerId },
      }
    }
    case 'image.layer.update': {
      const layer = getOwn(document.layers, invocation.params.layerId)
      if (layer === undefined) return undefined
      const { layerId: _layerId, ...changes } = invocation.params
      return { patches: [replace(path('layers', layer.id), layer, { ...layer, ...changes })] }
    }
    case 'image.layer.addRaster': {
      const children = parentChildren(document, invocation.params.parentId)
      if (children === undefined || !Number.isSafeInteger(invocation.params.index) ||
        invocation.params.index < 0 || invocation.params.index > children.length) return undefined
      const allocated = allocateIds(document, invocation.actor, ['r', 'l'])
      const resourceId = allocated.ids[0]!
      const layerId = allocated.ids[1]!
      const resource = resourceInput(invocation.params.resource, resourceId)
      const layer: ImageRasterLayer = {
        id: asImageLayerId(layerId),
        kind: 'raster',
        name: invocation.params.name,
        visible: true,
        opacity: 65_535,
        transform: { a: 1_000_000, b: 0, c: 0, d: 1_000_000, tx: 0, ty: 0 },
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        resourceId: asImageResourceId(resourceId),
        sourceRect: invocation.params.sourceRect as unknown as ImageRasterLayer['sourceRect'],
      }
      const nextChildren = [...children]
      nextChildren.splice(invocation.params.index, 0, layerId)
      return {
        patches: [
          allocated.patch,
          add(path('resources', resourceId), resource),
          add(path('layers', layerId), layer),
          ...parentListPatches(document, invocation.params.parentId, nextChildren),
        ],
        created: { layerId, resourceId },
      }
    }
    case 'image.layer.move': {
      const source = layerParent(document, invocation.params.layerId)
      const destination = parentChildren(document, invocation.params.parentId)
      if (source === undefined || destination === undefined || !Number.isSafeInteger(invocation.params.index)) return undefined
      const sourceChildren = source.children.filter((id) => id !== invocation.params.layerId)
      const destinationChildren = source.id === invocation.params.parentId
        ? [...sourceChildren]
        : [...destination]
      if (invocation.params.index < 0 || invocation.params.index > destinationChildren.length) return undefined
      destinationChildren.splice(invocation.params.index, 0, invocation.params.layerId)
      if (source.id === invocation.params.parentId) {
        return { patches: parentListPatches(document, source.id, destinationChildren) }
      }
      return {
        patches: [
          ...parentListPatches(document, source.id, sourceChildren),
          ...parentListPatches(document, invocation.params.parentId, destinationChildren),
        ],
      }
    }
    case 'image.layer.remove': {
      const layer = getOwn(document.layers, invocation.params.layerId)
      const parent = layerParent(document, invocation.params.layerId)
      if (layer === undefined || parent === undefined) return undefined
      const removedLayers = descendantIds(document, layer.id)
      const removedMasks = new Set<string>()
      for (const id of removedLayers) getOwn(document.layers, id)!.maskIds.forEach((maskId) => removedMasks.add(maskId))
      const referenced = referencedResources(document, removedLayers, removedMasks)
      const removedResources = new Set<string>()
      for (const id of removedLayers) {
        const removedLayer = getOwn(document.layers, id)!
        if (removedLayer.kind === 'raster') removedResources.add(removedLayer.resourceId)
      }
      for (const id of removedMasks) removedResources.add(getOwn(document.masks, id)!.resourceId)
      const patches: PatchOp[] = [
        ...parentListPatches(document, parent.id, parent.children.filter((id) => id !== layer.id)),
      ]
      for (const id of removedMasks) patches.push(remove(path('masks', id), getOwn(document.masks, id)))
      for (const id of removedLayers) patches.push(remove(path('layers', id), getOwn(document.layers, id)))
      for (const id of removedResources) {
        if (!referenced.has(id)) patches.push(remove(path('resources', id), getOwn(document.resources, id)))
      }
      return { patches }
    }
    case 'image.mask.update': {
      const mask = getOwn(document.masks, invocation.params.maskId)
      if (mask === undefined) return undefined
      const { maskId: _maskId, ...changes } = invocation.params
      return { patches: [replace(path('masks', mask.id), mask, { ...mask, ...changes })] }
    }
    case 'image.mask.addRaster': {
      const owner = getOwn(document.layers, invocation.params.ownerLayerId)
      if (owner === undefined || !Number.isSafeInteger(invocation.params.index) ||
        invocation.params.index < 0 || invocation.params.index > owner.maskIds.length) return undefined
      const allocated = allocateIds(document, invocation.actor, ['r', 'm'])
      const resourceId = allocated.ids[0]!
      const maskId = allocated.ids[1]!
      const resource = resourceInput(invocation.params.resource, resourceId)
      const mask: ImageRasterMask = {
        id: asImageMaskId(maskId),
        kind: 'raster',
        ownerLayerId: owner.id,
        enabled: true,
        invert: false,
        opacity: 65_535,
        transform: { a: 1_000_000, b: 0, c: 0, d: 1_000_000, tx: 0, ty: 0 },
        combineMode: 'multiply',
        channel: 'alpha',
        resourceId: asImageResourceId(resourceId),
        sourceRect: invocation.params.sourceRect as unknown as ImageRasterMask['sourceRect'],
      }
      const maskIds = [...owner.maskIds]
      maskIds.splice(invocation.params.index, 0, asImageMaskId(maskId))
      return {
        patches: [
          allocated.patch,
          add(path('resources', resourceId), resource),
          add(path('masks', maskId), mask),
          replace(path('layers', owner.id), owner, { ...owner, maskIds }),
        ],
        created: { maskId, resourceId },
      }
    }
    case 'image.mask.remove': {
      const mask = getOwn(document.masks, invocation.params.maskId)
      const owner = mask === undefined ? undefined : getOwn(document.layers, mask.ownerLayerId)
      if (mask === undefined || owner === undefined) return undefined
      const excludedMasks = new Set([mask.id])
      const referenced = referencedResources(document, new Set(), excludedMasks)
      const patches: PatchOp[] = [
        replace(path('layers', owner.id), owner, { ...owner, maskIds: owner.maskIds.filter((id) => id !== mask.id) }),
        remove(path('masks', mask.id), mask),
      ]
      if (!referenced.has(mask.resourceId)) {
        patches.push(remove(path('resources', mask.resourceId), getOwn(document.resources, mask.resourceId)))
      }
      return { patches }
    }
  }
}

export function planImageDocumentCommand(
  document: ImageDocument,
  value: unknown,
): ImageDocumentCommandResult {
  const invocation = decodeInvocation(value)
  if (invocation === undefined) return failure('image.command.invalid', 'ImageDocument command is malformed or unknown')
  let planned
  try {
    planned = commandPatches(document, invocation)
  } catch (error) {
    return failure('image.command.invalid', error instanceof Error ? error.message : 'ImageDocument command failed')
  }
  if (planned === undefined) return failure('image.command.refused', 'ImageDocument command target or position is unavailable')
  try {
    const next = applyOwnedOps(document as unknown as Json, planned.patches) as unknown
    const loaded = loadImageDocument(next)
    if (loaded.document === undefined) {
      return { ok: false, diagnostics: loaded.diagnostics }
    }
    const redo = planned.patches.filter((operation) => operation.path[0] !== 'allocation')
    const inverse = invertOps(redo)
    return {
      ok: true,
      plan: {
        invocation,
        document: loaded.document,
        forward: Object.freeze([...planned.patches]),
        redo: Object.freeze([...redo]),
        inverse: Object.freeze(inverse.map((operation) => Object.freeze(operation))),
        ...(planned.created !== undefined ? { created: planned.created } : {}),
      },
    }
  } catch (error) {
    return failure('image.command.refused', error instanceof Error ? error.message : 'ImageDocument command failed')
  }
}
