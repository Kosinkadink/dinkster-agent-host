import type { Json } from '../format/document.js'
import type {
  ImageDocument,
  ImageLayer,
  ImageMask,
  ImageResource,
} from './model.js'

function semanticResource(resource: ImageResource): Json {
  return {
    kind: resource.kind,
    digest: resource.digest,
    mediaType: resource.mediaType,
    width: resource.width,
    height: resource.height,
    colorSpace: resource.colorSpace,
    channelDepth: resource.channelDepth,
    alphaMode: resource.alphaMode,
  }
}

function semanticMask(document: ImageDocument, mask: ImageMask): Json {
  return {
    kind: mask.kind,
    enabled: mask.enabled,
    invert: mask.invert,
    opacity: mask.opacity,
    transform: mask.transform,
    combineMode: mask.combineMode,
    channel: mask.channel,
    sourceRect: mask.sourceRect,
    resource: semanticResource(document.resources[mask.resourceId]!),
  } as unknown as Json
}

function semanticLayer(document: ImageDocument, layer: ImageLayer): Json {
  const common = {
    kind: layer.kind,
    visible: layer.visible,
    opacity: layer.opacity,
    transform: layer.transform,
    blendMode: layer.blendMode,
    clipping: layer.clipping,
    ...(layer.z_index !== undefined ? { z_index: layer.z_index } : {}),
    masks: layer.maskIds.map((id) => semanticMask(document, document.masks[id]!)),
  }
  if (layer.kind === 'group') {
    return {
      ...common,
      ...(layer.isolation !== undefined ? { isolation: layer.isolation } : {}),
      children: layer.childLayerIds.map((id) => semanticLayer(document, document.layers[id]!)),
    } as unknown as Json
  }
  return {
    ...common,
    sourceRect: layer.sourceRect,
    resource: semanticResource(document.resources[layer.resourceId]!),
  } as unknown as Json
}

/**
 * Pixel-semantic data with allocation, lineage, names, identities, byte sizes,
 * and non-rendering extensions removed. Call only with an invariant-clean document.
 */
export function imageDocumentSemanticProjection(document: ImageDocument): Json {
  return {
    format: document.format,
    formatVersion: document.formatVersion,
    canvas: document.canvas,
    layers: document.rootLayerIds.map((id) => semanticLayer(document, document.layers[id]!)),
  } as unknown as Json
}
