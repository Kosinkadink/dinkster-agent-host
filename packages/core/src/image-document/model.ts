import type { Json } from '../format/document.js'

export const IMAGE_DOCUMENT_FORMAT = 'dinkster-image' as const
export const IMAGE_DOCUMENT_FORMAT_VERSION = 2

export const MAX_IMAGE_DOCUMENT_BYTES = 16 * 1024 * 1024
export const MAX_IMAGE_LAYERS = 4_096
export const MAX_IMAGE_LAYER_DEPTH = 64
export const MAX_IMAGE_RESOURCES = 8_192
export const MAX_IMAGE_MASKS_PER_LAYER = 32
export const MAX_IMAGE_CANVAS_DIMENSION = 16_384
export const MAX_IMAGE_PIXELS = 100_000_000

/** Durable fractional values use signed integers in millionths. */
export const IMAGE_FIXED_POINT_SCALE = 1_000_000
export const IMAGE_OPACITY_MAX = 65_535
export const MAX_IMAGE_LINEAR_COMPONENT = 1_000 * IMAGE_FIXED_POINT_SCALE
export const MAX_IMAGE_TRANSLATION = MAX_IMAGE_CANVAS_DIMENSION * 64 * IMAGE_FIXED_POINT_SCALE
export const IMAGE_OUTPUT_POLICY_EXTENSION = 'dinkster.outputPolicy'
export const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const
export type ImageOutputFormat = typeof IMAGE_OUTPUT_FORMATS[number]

export interface ImageOutputPolicy {
  readonly format: ImageOutputFormat
  readonly quality: number
}

export const DEFAULT_IMAGE_OUTPUT_POLICY: ImageOutputPolicy = { format: 'png', quality: 90 }

declare const imageDocumentBrand: unique symbol
type ImageDocumentBrand<T extends string> = string & { readonly [imageDocumentBrand]: T }

export type ImageLineageId = ImageDocumentBrand<'ImageLineageId'>
export type ImageLayerId = ImageDocumentBrand<'ImageLayerId'>
export type ImageMaskId = ImageDocumentBrand<'ImageMaskId'>
export type ImageResourceId = ImageDocumentBrand<'ImageResourceId'>

export const asImageLineageId = (value: string): ImageLineageId => value as ImageLineageId
export const asImageLayerId = (value: string): ImageLayerId => value as ImageLayerId
export const asImageMaskId = (value: string): ImageMaskId => value as ImageMaskId
export const asImageResourceId = (value: string): ImageResourceId => value as ImageResourceId

/** Equal z indexes retain the serialized sibling order. */
export function orderedImageLayerIds<T extends string>(document: ImageDocument, ids: readonly T[]): readonly T[] {
  return ids.map((id, index) => ({ id, order: Object.hasOwn(document.layers, id) ? document.layers[id]!.z_index ?? index : index }))
    .sort((left, right) => left.order - right.order).map(({ id }) => id)
}

export interface ImageCanvas {
  readonly width: number
  readonly height: number
  readonly colorSpace: 'srgb'
  readonly channelDepth: 8
  readonly compositing: 'premultiplied-alpha' | 'linear-premultiplied-alpha'
  readonly color?: {
    readonly primaries: number
    readonly transfer: number
    readonly range: number
    readonly matrix?: number
    readonly bit_depth?: number
  }
  readonly background?: readonly [number, number, number, number]
}

export interface ImageAllocation {
  readonly nextOrdinal: number
  readonly actorCursors?: Readonly<Record<string, number>>
}

/** a-d are unitless millionths; tx/ty are pixel millionths. */
export interface ImageAffineTransform {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly tx: number
  readonly ty: number
  readonly components?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    readonly rotation: number
    readonly flipHorizontal: boolean
    readonly flipVertical: boolean
    readonly sourceWidth: number
    readonly sourceHeight: number
  }
}

export interface ImageSourceRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const IMAGE_BLEND_MODES = [
  'normal',
  'dissolve',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color_dodge',
  'color_burn',
  'hard_light',
  'soft_light',
  'difference',
  'exclusion',
  'linear_dodge',
  'linear_burn',
  'vivid_light',
  'pin_light',
  'linear_light',
  'hard_mix',
  'subtract',
  'divide',
  'grain_extract',
  'grain_merge',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const
export type ImageBlendMode = typeof IMAGE_BLEND_MODES[number]

export type ImageClipping = 'none' | 'clip-to-previous'

interface ImageLayerBase {
  readonly id: ImageLayerId
  readonly name: string
  readonly visible: boolean
  readonly opacity: number
  readonly transform: ImageAffineTransform
  readonly blendMode: ImageBlendMode
  readonly clipping: ImageClipping
  readonly maskIds: readonly ImageMaskId[]
  readonly z_index?: number
}

export interface ImageGroupLayer extends ImageLayerBase {
  readonly kind: 'group'
  readonly childLayerIds: readonly ImageLayerId[]
  readonly isolation?: 'isolated' | 'pass-through'
}

export interface ImageRasterLayer extends ImageLayerBase {
  readonly kind: 'raster'
  readonly resourceId: ImageResourceId
  readonly sourceRect: ImageSourceRect
}

/** Vector and adjustment are reserved format discriminants, not v1 records. */
export const IMAGE_LAYER_KINDS = ['group', 'raster', 'vector', 'adjustment'] as const
export type ImageLayer = ImageGroupLayer | ImageRasterLayer

export const IMAGE_MASK_COMBINE_MODES = ['multiply', 'add', 'subtract', 'intersect'] as const
export type ImageMaskCombineMode = typeof IMAGE_MASK_COMBINE_MODES[number]
export type ImageMaskChannel = 'alpha' | 'luminance'

export interface ImageRasterMask {
  readonly id: ImageMaskId
  readonly kind: 'raster'
  readonly ownerLayerId: ImageLayerId
  readonly enabled: boolean
  readonly invert: boolean
  readonly opacity: number
  readonly transform: ImageAffineTransform
  readonly combineMode: ImageMaskCombineMode
  readonly channel: ImageMaskChannel
  readonly resourceId: ImageResourceId
  readonly sourceRect: ImageSourceRect
}

/** Vector is reserved as a future mask discriminant, not a v1 record. */
export const IMAGE_MASK_KINDS = ['raster', 'vector'] as const
export type ImageMask = ImageRasterMask

export const IMAGE_RASTER_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ImageRasterMediaType = typeof IMAGE_RASTER_MEDIA_TYPES[number]
export type ImageAlphaMode = 'straight' | 'premultiplied' | 'opaque'

export interface ImageRasterResource {
  readonly id: ImageResourceId
  readonly kind: 'raster'
  readonly digest: `blake3:${string}`
  readonly byteSize: number
  readonly mediaType: ImageRasterMediaType
  readonly width: number
  readonly height: number
  readonly colorSpace: 'srgb'
  readonly channelDepth: 8
  readonly alphaMode: ImageAlphaMode
  readonly inline?: string
}

export type ImageResource = ImageRasterResource

export interface ImageDocument {
  readonly format: typeof IMAGE_DOCUMENT_FORMAT
  readonly formatVersion: number
  readonly lineage: ImageLineageId
  readonly canvas: ImageCanvas
  readonly allocation: ImageAllocation
  readonly rootLayerIds: readonly ImageLayerId[]
  readonly layers: Readonly<Record<string, ImageLayer>>
  readonly masks: Readonly<Record<string, ImageMask>>
  readonly resources: Readonly<Record<string, ImageResource>>
  /** Explicitly non-rendering extension data. */
  readonly extensions?: Readonly<Record<string, Json>>
}

export function imageOutputPolicyOf(document: ImageDocument): ImageOutputPolicy {
  const value = document.extensions?.[IMAGE_OUTPUT_POLICY_EXTENSION]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_IMAGE_OUTPUT_POLICY
  const policy = value as Readonly<Record<string, Json>>
  const format = policy['format']
  const quality = policy['quality']
  return typeof format === 'string' && IMAGE_OUTPUT_FORMATS.includes(format as ImageOutputFormat) &&
    Number.isSafeInteger(quality) && (quality as number) >= 0 && (quality as number) <= 100
    ? { format: format as ImageOutputFormat, quality: quality as number }
    : DEFAULT_IMAGE_OUTPUT_POLICY
}
