import { diag, type Diagnostic } from '../diagnostics.js'
import { actorCursorOf, parseAllocatedId } from '../ids.js'
import {
  MAX_IMAGE_LAYER_DEPTH,
  orderedImageLayerIds,
  type ImageDocument,
  type ImageResource,
  type ImageSourceRect,
} from './model.js'

function error(code: string, message: string): Diagnostic {
  return diag('error', 'invariant', code, message)
}

function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function checkMapIdentity(
  record: Readonly<Record<string, { readonly id: string }>>,
  kind: string,
  diagnostics: Diagnostic[],
): void {
  for (const [key, value] of Object.entries(record)) {
    if (value.id !== key) {
      diagnostics.push(error('image.id.keyMismatch', `${kind} '${key}' stores id '${value.id}'`))
    }
  }
}

function checkAllocatedIds(document: ImageDocument, diagnostics: Diagnostic[]): void {
  const coordinates = new Map<string, string>()
  const entries = [
    ...Object.keys(document.layers).map((id) => [id, 'l', 'layer'] as const),
    ...Object.keys(document.masks).map((id) => [id, 'm', 'mask'] as const),
    ...Object.keys(document.resources).map((id) => [id, 'r', 'resource'] as const),
  ]
  for (const [id, expectedPrefix, kind] of entries) {
    const parsed = parseAllocatedId(id)
    if (parsed === undefined || parsed.prefix !== expectedPrefix) {
      diagnostics.push(error(
        'image.id.invalid',
        `${kind} id '${id}' is not a canonical allocated '${expectedPrefix}' id`,
      ))
      continue
    }
    const cursor = parsed.actor === undefined
      ? document.allocation.nextOrdinal
      : actorCursorOf(document.allocation.actorCursors, parsed.actor)
    if (parsed.ordinal >= cursor) {
      diagnostics.push(error(
        'image.id.aboveCursor',
        `${kind} id '${id}' has ordinal ${parsed.ordinal}, not below allocation cursor ${cursor}`,
      ))
    }
    const coordinate = `${parsed.actor ?? ''}\u0000${parsed.ordinal}`
    const existing = coordinates.get(coordinate)
    if (existing !== undefined) {
      diagnostics.push(error(
        'image.id.reusedOrdinal',
        `allocated ids '${existing}' and '${id}' reuse the same actor ordinal`,
      ))
    } else {
      coordinates.set(coordinate, id)
    }
  }
}

function checkLayerTree(document: ImageDocument, diagnostics: Diagnostic[]): void {
  const parentCounts = new Map<string, number>()
  const countParent = (id: string, owner: string): void => {
    if (getOwn(document.layers, id) === undefined) {
      diagnostics.push(error('image.layer.dangling', `${owner} references missing layer '${id}'`))
      return
    }
    parentCounts.set(id, (parentCounts.get(id) ?? 0) + 1)
  }

  const countList = (ids: readonly string[], owner: string): void => {
    const seen = new Set<string>()
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        diagnostics.push(error('image.layer.duplicateChild', `${owner} repeats layer '${id}' at index ${index}`))
      }
      seen.add(id)
      countParent(id, owner)
    })
    const first = orderedImageLayerIds(document, ids)[0]
    if (first !== undefined && getOwn(document.layers, first)?.clipping === 'clip-to-previous') {
      diagnostics.push(error('image.layer.clippingTarget', `first layer '${first}' in ${owner} has no previous sibling to clip to`))
    }
  }

  countList(document.rootLayerIds, 'rootLayerIds')
  for (const layer of Object.values(document.layers)) {
    if (layer.kind === 'group') countList(layer.childLayerIds, `group '${layer.id}'`)
  }
  for (const id of Object.keys(document.layers)) {
    const count = parentCounts.get(id) ?? 0
    if (count !== 1) {
      diagnostics.push(error('image.layer.parentCount', `layer '${id}' appears in ${count} parent lists; expected exactly one`))
    }
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const rooted = new Set<string>()
  const visit = (id: string, depth: number, fromRoot: boolean): void => {
    const layer = getOwn(document.layers, id)
    if (layer === undefined) return
    if (state.get(id) === 'visiting') {
      diagnostics.push(error('image.layer.cycle', `layer tree contains a cycle at '${id}'`))
      return
    }
    if (state.get(id) === 'visited') {
      if (fromRoot) rooted.add(id)
      return
    }
    state.set(id, 'visiting')
    if (fromRoot) rooted.add(id)
    if (depth > MAX_IMAGE_LAYER_DEPTH) {
      diagnostics.push(error(
        'image.layer.depth',
        `layer '${id}' exceeds the maximum tree depth of ${MAX_IMAGE_LAYER_DEPTH}`,
      ))
      state.set(id, 'visited')
      return
    }
    if (layer.kind === 'group') {
      for (const childId of layer.childLayerIds) visit(childId, depth + 1, fromRoot)
    }
    state.set(id, 'visited')
  }
  for (const id of document.rootLayerIds) visit(id, 1, true)
  for (const id of Object.keys(document.layers)) {
    if (!rooted.has(id)) {
      diagnostics.push(error('image.layer.unreachable', `layer '${id}' is not reachable from rootLayerIds`))
    }
    if (state.get(id) === undefined) visit(id, 1, false)
  }
}

function rectFits(rect: ImageSourceRect, resource: ImageResource): boolean {
  return rect.x + rect.width <= resource.width && rect.y + rect.height <= resource.height
}

function checkResourceReference(
  document: ImageDocument,
  resourceId: string,
  rect: ImageSourceRect,
  owner: string,
  diagnostics: Diagnostic[],
): void {
  const resource = getOwn(document.resources, resourceId)
  if (resource === undefined) {
    diagnostics.push(error('image.resource.dangling', `${owner} references missing resource '${resourceId}'`))
  } else if (!rectFits(rect, resource)) {
    diagnostics.push(error(
      'image.resource.sourceRect',
      `${owner} source rectangle exceeds resource '${resourceId}' dimensions`,
    ))
  }
}

function checkMasksAndResources(document: ImageDocument, diagnostics: Diagnostic[]): void {
  const maskOwners = new Map<string, number>()
  for (const layer of Object.values(document.layers)) {
    const seen = new Set<string>()
    for (const maskId of layer.maskIds) {
      if (seen.has(maskId)) {
        diagnostics.push(error('image.mask.duplicate', `layer '${layer.id}' repeats mask '${maskId}'`))
      }
      seen.add(maskId)
      const mask = getOwn(document.masks, maskId)
      if (mask === undefined) {
        diagnostics.push(error('image.mask.dangling', `layer '${layer.id}' references missing mask '${maskId}'`))
        continue
      }
      maskOwners.set(maskId, (maskOwners.get(maskId) ?? 0) + 1)
      if (mask.ownerLayerId !== layer.id) {
        diagnostics.push(error(
          'image.mask.ownerMismatch',
          `mask '${maskId}' names owner '${mask.ownerLayerId}' but is listed by layer '${layer.id}'`,
        ))
      }
    }
    if (layer.kind === 'raster') {
      checkResourceReference(document, layer.resourceId, layer.sourceRect, `layer '${layer.id}'`, diagnostics)
    }
  }
  for (const mask of Object.values(document.masks)) {
    const count = maskOwners.get(mask.id) ?? 0
    if (count !== 1) {
      diagnostics.push(error('image.mask.ownerCount', `mask '${mask.id}' appears in ${count} layer mask lists; expected exactly one`))
    }
    if (getOwn(document.layers, mask.ownerLayerId) === undefined) {
      diagnostics.push(error('image.mask.danglingOwner', `mask '${mask.id}' names missing owner layer '${mask.ownerLayerId}'`))
    }
    checkResourceReference(document, mask.resourceId, mask.sourceRect, `mask '${mask.id}'`, diagnostics)
  }
  for (const resource of Object.values(document.resources)) {
    if (resource.mediaType === 'image/jpeg' && resource.alphaMode !== 'opaque') {
      diagnostics.push(error(
        'image.resource.alphaMode',
        `JPEG resource '${resource.id}' must use opaque alpha interpretation`,
      ))
    }
  }
}

export function checkImageDocument(document: ImageDocument): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  checkMapIdentity(document.layers, 'layer', diagnostics)
  checkMapIdentity(document.masks, 'mask', diagnostics)
  checkMapIdentity(document.resources, 'resource', diagnostics)
  checkAllocatedIds(document, diagnostics)
  checkLayerTree(document, diagnostics)
  checkMasksAndResources(document, diagnostics)
  return diagnostics
}
