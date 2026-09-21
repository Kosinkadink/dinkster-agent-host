/** Strict document and execution-state records for the graph-native compositor. */

import type { Json } from './format/document.js'
import { canonicalJson, sha256Hex } from './compile/hash.js'
import { loadImageDocument } from './image-document/migrate.js'
import type { ImageAffineTransform, ImageDocument } from './image-document/model.js'

export const COMPOSITOR_STATE_PREVIEW_CHANNEL = 'application/vnd.dinkster.compositor-state+json'
export const COMPOSITOR_STATE_PREVIEW_STREAM = 'compositor-state'
export const MAX_COMPOSITOR_LAYERS = 50
export const MAX_COMPOSITOR_DIMENSION = 16_384

export const COMPOSITOR_BLEND_MODES = [
  'normal',
  'dissolve',
  'multiply',
  'screen',
  'overlay',
  'soft_light',
  'hard_light',
  'color_dodge',
  'linear_dodge',
  'color_burn',
  'linear_burn',
  'vivid_light',
  'linear_light',
  'pin_light',
  'hard_mix',
  'difference',
  'exclusion',
  'darken',
  'lighten',
  'subtract',
  'divide',
  'grain_extract',
  'grain_merge',
  'hue',
  'saturation',
  'luminosity',
  'color',
] as const

export type CompositorBlendMode = typeof COMPOSITOR_BLEND_MODES[number]

export interface CompositorTransform {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation: number
}

type ImageTransformComponents = NonNullable<ImageAffineTransform['components']>

interface AffineTransform {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly tx: number
  readonly ty: number
}

interface StoredComponentAffine {
  readonly stored: AffineTransform
  readonly reconstructed: AffineTransform
}

export interface CompositorLayer {
  readonly id: string
  readonly source: number
  readonly name: string
  readonly visible: boolean
  readonly opacity: number
  readonly blend: CompositorBlendMode
  readonly transform: CompositorTransform
  readonly flipH: boolean
  readonly flipV: boolean
}

export interface ConfiguredCompositorRecipe {
  readonly version: 1
  readonly inputs: readonly string[]
  readonly canvas: {
    readonly width: number
    readonly height: number
  }
  readonly background: {
    readonly color: string
    readonly opacity: number
    readonly visible: boolean
  }
  readonly layers: readonly CompositorLayer[]
}

export interface CompositorRecipe {
  readonly version: 2
  readonly documentDigest: string | null
  readonly commands: readonly Json[]
}

export interface CompositorState extends ConfiguredCompositorRecipe {
  readonly document: ImageDocument
  readonly documentDigest: string
  readonly stale: boolean
  readonly layerStreams: readonly string[]
}

export const EMPTY_COMPOSITOR_RECIPE: CompositorRecipe = Object.freeze({
  version: 2,
  documentDigest: null,
  commands: Object.freeze([] as const),
})

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const hasExactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const affineOf = (transform: ImageAffineTransform): AffineTransform => ({
  a: transform.a / 1_000_000,
  b: transform.b / 1_000_000,
  c: transform.c / 1_000_000,
  d: transform.d / 1_000_000,
  tx: transform.tx / 1_000_000,
  ty: transform.ty / 1_000_000,
})

const affineFromComponents = (components: ImageTransformComponents): AffineTransform => {
  const cosine = Math.cos(components.rotation)
  const sine = Math.sin(components.rotation)
  const scaleX = components.width / components.sourceWidth * (components.flipHorizontal ? -1 : 1)
  const scaleY = components.height / components.sourceHeight * (components.flipVertical ? -1 : 1)
  const a = cosine * scaleX
  const b = sine * scaleX
  const c = -sine * scaleY
  const d = cosine * scaleY
  return {
    a, b, c, d,
    tx: components.x + components.width / 2 - (a * components.sourceWidth + c * components.sourceHeight) / 2,
    ty: components.y + components.height / 2 - (b * components.sourceWidth + d * components.sourceHeight) / 2,
  }
}

const affineFromStoredComponents = (transform: ImageAffineTransform): StoredComponentAffine | undefined => {
  const components = transform.components
  if (!components) return undefined
  const stored = affineOf(transform)
  const reconstructed = affineFromComponents(components)
  const halfFixedPointStep = 0.5 / 1_000_000
  for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) {
    const floatingPointAllowance = Number.EPSILON * Math.max(Math.abs(reconstructed[key]), 1) * 8
    if (Math.abs(stored[key] - reconstructed[key]) > halfFixedPointStep + floatingPointAllowance) return undefined
  }
  return { stored, reconstructed }
}

const linearInfinityNorm = (value: AffineTransform): number => Math.max(
  Math.abs(value.a) + Math.abs(value.c),
  Math.abs(value.b) + Math.abs(value.d),
)

const linearInfinityDistance = (left: AffineTransform, right: AffineTransform): number => Math.max(
  Math.abs(left.a - right.a) + Math.abs(left.c - right.c),
  Math.abs(left.b - right.b) + Math.abs(left.d - right.d),
)

const composeAffine = (left: AffineTransform, right: AffineTransform): AffineTransform => ({
  a: left.a * right.a + left.c * right.b,
  b: left.b * right.a + left.d * right.b,
  c: left.a * right.c + left.c * right.d,
  d: left.b * right.c + left.d * right.d,
  tx: left.a * right.tx + left.c * right.ty + left.tx,
  ty: left.b * right.tx + left.d * right.ty + left.ty,
})

const inverseAffine = (value: AffineTransform): AffineTransform | undefined => {
  const determinant = value.a * value.d - value.b * value.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined
  const a = value.d / determinant
  const b = -value.b / determinant
  const c = -value.c / determinant
  const d = value.a / determinant
  return {
    a, b, c, d,
    tx: -(a * value.tx + c * value.ty),
    ty: -(b * value.tx + d * value.ty),
  }
}

const movedMaskComponents = (
  oldLayer: ImageAffineTransform,
  oldMask: ImageAffineTransform,
  nextLayer: ImageTransformComponents,
): ImageTransformComponents | undefined => {
  const layerAffines = affineFromStoredComponents(oldLayer)
  const maskAffines = affineFromStoredComponents(oldMask)
  const inverseLayer = layerAffines && inverseAffine(layerAffines.reconstructed)
  const inverseStoredLayer = layerAffines && inverseAffine(layerAffines.stored)
  const maskComponents = oldMask.components
  if (!inverseLayer || !inverseStoredLayer || !maskAffines || !maskComponents) return undefined
  const nextAffine = affineFromComponents(nextLayer)
  const moved = composeAffine(nextAffine, composeAffine(inverseStoredLayer, maskAffines.stored))
  const reconstructedMoved = composeAffine(nextAffine, composeAffine(inverseLayer, maskAffines.reconstructed))
  // Each stored 2x2 matrix has four coefficients quantized at a half-step of 1e-6,
  // so its infinity-norm error is at most 1e-6 per row. From
  // Ls^-1 - Lc^-1 = Ls^-1 (Lc - Ls) Lc^-1, submultiplicativity bounds the
  // complete N L^-1 M composition below. Source dimensions affect translation
  // after decomposition, not this linear shear bound.
  const layerQuantizationError = linearInfinityDistance(layerAffines.stored, layerAffines.reconstructed)
  const maskQuantizationError = linearInfinityDistance(maskAffines.stored, maskAffines.reconstructed)
  const quantizationBound = linearInfinityNorm(nextAffine) * (
    linearInfinityNorm(inverseStoredLayer) * layerQuantizationError *
      linearInfinityNorm(inverseLayer) * linearInfinityNorm(maskAffines.stored) +
    linearInfinityNorm(inverseLayer) * maskQuantizationError
  )
  const matrixFloatingPointTolerance = Math.max(linearInfinityNorm(reconstructedMoved), 1) * 1e-9
  if (linearInfinityDistance(moved, reconstructedMoved) > quantizationBound + matrixFloatingPointTolerance) return undefined
  const scaleX = Math.hypot(moved.a, moved.b)
  const scaleY = Math.hypot(moved.c, moved.d)
  if (!finite(scaleX) || !finite(scaleY) || scaleX === 0 || scaleY === 0) return undefined
  const determinant = moved.a * moved.d - moved.b * moved.c
  if (!finite(determinant) || determinant === 0) return undefined
  const flipHorizontal = determinant < 0
  const signedScaleX = flipHorizontal ? -scaleX : scaleX
  const rotation = Math.atan2(moved.b / signedScaleX, moved.a / signedScaleX)
  const linearMagnitude = Math.abs(moved.a) + Math.abs(moved.b) + Math.abs(moved.c) + Math.abs(moved.d)
  const floatingPointTolerance = Math.max(scaleX * scaleY, 1) * 1e-9
  // Component-affine columns are orthogonal. Expanding their dot product after
  // an entrywise perturbation bounded by quantizationBound gives one linear
  // term per coefficient and two second-order products.
  const orthogonalityTolerance = quantizationBound * linearMagnitude + 2 * quantizationBound ** 2 + floatingPointTolerance
  if (Math.abs(moved.a * moved.c + moved.b * moved.d) > orthogonalityTolerance) return undefined
  const width = scaleX * maskComponents.sourceWidth
  const height = scaleY * maskComponents.sourceHeight
  return {
    x: moved.tx - width / 2 + (moved.a * maskComponents.sourceWidth + moved.c * maskComponents.sourceHeight) / 2,
    y: moved.ty - height / 2 + (moved.b * maskComponents.sourceWidth + moved.d * maskComponents.sourceHeight) / 2,
    width,
    height,
    rotation,
    flipHorizontal,
    flipVertical: false,
    sourceWidth: maskComponents.sourceWidth,
    sourceHeight: maskComponents.sourceHeight,
  }
}

const scalarLength = (value: string): number | undefined => {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return undefined
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return undefined
    }
    count += 1
  }
  return count
}

const isCompositorTransform = (value: unknown): value is CompositorTransform => {
  const transform = record(value)
  if (!transform || !hasExactKeys(transform, ['height', 'rotation', 'width', 'x', 'y'])) return false
  return finite(transform['x']) && finite(transform['y']) && finite(transform['rotation']) &&
    finite(transform['width']) && transform['width'] >= 1 && transform['width'] <= MAX_COMPOSITOR_DIMENSION &&
    finite(transform['height']) && transform['height'] >= 1 && transform['height'] <= MAX_COMPOSITOR_DIMENSION
}

const isCompositorLayer = (value: unknown): value is CompositorLayer => {
  const layer = record(value)
  if (!layer || !hasExactKeys(layer, [
    'blend', 'flipH', 'flipV', 'id', 'name', 'opacity', 'source', 'transform', 'visible',
  ])) return false
  const name = typeof layer['name'] === 'string' ? scalarLength(layer['name']) : undefined
  return typeof layer['id'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(layer['id']) &&
    typeof layer['source'] === 'number' && Number.isSafeInteger(layer['source']) && layer['source'] >= 0 &&
    name !== undefined && name >= 1 && name <= 256 &&
    typeof layer['visible'] === 'boolean' &&
    finite(layer['opacity']) && layer['opacity'] >= 0 && layer['opacity'] <= 1 &&
    typeof layer['blend'] === 'string' && (COMPOSITOR_BLEND_MODES as readonly string[]).includes(layer['blend']) &&
    isCompositorTransform(layer['transform']) &&
    typeof layer['flipH'] === 'boolean' && typeof layer['flipV'] === 'boolean'
}

export function isConfiguredCompositorRecipe(value: unknown): value is ConfiguredCompositorRecipe {
  const recipe = record(value)
  if (!recipe || !hasExactKeys(recipe, ['background', 'canvas', 'inputs', 'layers', 'version']) ||
      recipe['version'] !== 1) return false
  const fingerprints = recipe['inputs']
  const layers = recipe['layers']
  const canvas = record(recipe['canvas'])
  const background = record(recipe['background'])
  if (!Array.isArray(fingerprints) || fingerprints.length < 1 || fingerprints.length > MAX_COMPOSITOR_LAYERS ||
      !fingerprints.every((fingerprint) => typeof fingerprint === 'string') ||
      !Array.isArray(layers) || layers.length !== fingerprints.length || !layers.every(isCompositorLayer) ||
      !canvas || !hasExactKeys(canvas, ['height', 'width']) ||
      typeof canvas['width'] !== 'number' || !Number.isSafeInteger(canvas['width']) || canvas['width'] < 1 || canvas['width'] > MAX_COMPOSITOR_DIMENSION ||
      typeof canvas['height'] !== 'number' || !Number.isSafeInteger(canvas['height']) || canvas['height'] < 1 || canvas['height'] > MAX_COMPOSITOR_DIMENSION ||
      !background || !hasExactKeys(background, ['color', 'opacity', 'visible']) ||
      typeof background['color'] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(background['color']) ||
      !finite(background['opacity']) || background['opacity'] < 0 || background['opacity'] > 1 ||
      typeof background['visible'] !== 'boolean') return false
  const ids = layers.map((layer) => layer.id)
  const sourceIndexes = layers.map((layer) => layer.source).sort((left, right) => left - right)
  return new Set(ids).size === ids.length && sourceIndexes.every((sourceIndex, index) => sourceIndex === index)
}

export function isCompositorRecipe(value: unknown): value is CompositorRecipe {
  const recipe = record(value)
  if (!recipe || !hasExactKeys(recipe, ['commands', 'documentDigest', 'version']) || recipe['version'] !== 2 ||
      !(recipe['documentDigest'] === null ||
        (typeof recipe['documentDigest'] === 'string' && /^blake3:[0-9a-f]{64}$/.test(recipe['documentDigest']))) ||
      !Array.isArray(recipe['commands'])) return false
  try {
    canonicalJson(recipe['commands'] as Json)
    return true
  } catch {
    return false
  }
}

export function copyCompositorRecipe(recipe: CompositorRecipe): CompositorRecipe {
  return JSON.parse(canonicalJson(recipe)) as CompositorRecipe
}

export function copyConfiguredCompositorRecipe(recipe: ConfiguredCompositorRecipe): ConfiguredCompositorRecipe {
  return {
    version: 1,
    inputs: [...recipe.inputs],
    canvas: { ...recipe.canvas },
    background: { ...recipe.background },
    layers: recipe.layers.map((layer) => ({ ...layer, transform: { ...layer.transform } })),
  }
}

/** Fingerprint the effective stored recipe; an absent value means the schema-owned empty recipe. */
export function compositorRecipeFingerprint(value: unknown): string | undefined {
  const recipe = value === undefined ? EMPTY_COMPOSITOR_RECIPE : isCompositorRecipe(value) ? value : undefined
  return recipe === undefined ? undefined : `sha256:${sha256Hex(canonicalJson(recipe))}`
}

export function compositorStateOf(value: unknown): CompositorState | undefined {
  const state = record(value)
  if (state && hasExactKeys(state, [
    'background', 'canvas', 'document', 'documentDigest', 'inputs', 'layerStreams', 'layers', 'stale', 'version',
  ])) {
    const { document, documentDigest, layerStreams, stale, ...recipe } = state
    if (!isConfiguredCompositorRecipe(recipe)) return undefined
    const normalized = compositorStateOf({ version: 2, document, documentDigest, layerStreams, stale })
    return normalized && canonicalJson(copyConfiguredCompositorRecipe(normalized) as unknown as Json) ===
      canonicalJson(recipe as unknown as Json) ? normalized : undefined
  }
  if (!state || !hasExactKeys(state, ['document', 'documentDigest', 'layerStreams', 'stale', 'version']) ||
      state['version'] !== 2 || typeof state['documentDigest'] !== 'string' ||
      !/^blake3:[0-9a-f]{64}$/.test(state['documentDigest']) || typeof state['stale'] !== 'boolean' ||
      !Array.isArray(state['layerStreams'])) return undefined
  const loaded = loadImageDocument(state['document'])
  const document = loaded.document
  if (!document || loaded.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
      document.rootLayerIds.length < 1 || document.rootLayerIds.length > MAX_COMPOSITOR_LAYERS ||
      state['layerStreams'].length !== document.rootLayerIds.length || !state['layerStreams'].every((stream, index) =>
        stream === `compositor.layer.${index}`)) return undefined
  const background = document.canvas.background ?? [0, 0, 0, 0]
  const layers = document.rootLayerIds.map((id, source): CompositorLayer | undefined => {
    const layer = document.layers[id]
    const components = layer?.transform.components
    if (!layer || !components || !(COMPOSITOR_BLEND_MODES as readonly string[]).includes(layer.blendMode)) return undefined
    return {
      id, source, name: layer.name, visible: layer.visible,
      opacity: layer.opacity / 65_535,
      blend: layer.blendMode as CompositorBlendMode,
      transform: {
        x: components.x, y: components.y, width: components.width,
        height: components.height, rotation: components.rotation,
      },
      flipH: components.flipHorizontal,
      flipV: components.flipVertical,
    }
  })
  if (layers.some((layer) => layer === undefined)) return undefined
  const recipe = {
    version: 1 as const,
    inputs: document.rootLayerIds.map((id) => id),
    canvas: { width: document.canvas.width, height: document.canvas.height },
    background: {
      color: `#${background.slice(0, 3).map((component) => Math.round(component / 257).toString(16).padStart(2, '0')).join('')}`,
      opacity: background[3] / 65_535,
      visible: background[3] > 0,
    },
    layers: layers as CompositorLayer[],
  }
  if (!isConfiguredCompositorRecipe(recipe)) return undefined
  return {
    ...copyConfiguredCompositorRecipe(recipe),
    document,
    documentDigest: state['documentDigest'],
    stale: state['stale'],
    layerStreams: [...state['layerStreams']] as string[],
  }
}

export function compositorDeltaFromDraft(
  state: CompositorState,
  draft: ConfiguredCompositorRecipe,
): CompositorRecipe | undefined {
  const rootLayerIds = new Set<string>(state.document.rootLayerIds)
  if (!isConfiguredCompositorRecipe(draft) || draft.layers.length !== state.layers.length ||
      draft.layers.some((layer) => !rootLayerIds.has(layer.id)) ||
      new Set(draft.layers.map((layer) => layer.id)).size !== state.layers.length ||
      draft.layers.some((layer) => state.document.layers[layer.id]!.maskIds.some((id) =>
        state.document.masks[id]?.transform.components === undefined))) return undefined
  const commands: Json[] = [{
    op: 'canvas',
    changes: {
      width: draft.canvas.width,
      height: draft.canvas.height,
      background: [
        ...[1, 3, 5].map((index) => Number.parseInt(draft.background.color.slice(index, index + 2), 16) * 257),
        draft.background.visible ? Math.round(draft.background.opacity * 65_535) : 0,
      ],
    },
  }]
  for (const layer of draft.layers) {
    const source = state.document.layers[layer.id]!
    const components = source.transform.components!
    const nextComponents = {
      x: layer.transform.x, y: layer.transform.y, width: layer.transform.width,
      height: layer.transform.height, rotation: layer.transform.rotation,
      flipHorizontal: layer.flipH, flipVertical: layer.flipV,
      sourceWidth: components.sourceWidth, sourceHeight: components.sourceHeight,
    }
    const maskCommands: Json[] = []
    for (const id of source.maskIds) {
      const mask = state.document.masks[id]!
      const maskComponents = movedMaskComponents(source.transform, mask.transform, nextComponents)
      if (!maskComponents) return undefined
      maskCommands.push({ op: 'transform', kind: 'mask', id, components: maskComponents })
    }
    commands.push({
      op: 'transform', id: layer.id,
      components: nextComponents,
    }, ...maskCommands, {
      op: 'layer', id: layer.id,
      changes: {
        name: layer.name, visible: layer.visible,
        opacity: Math.round(layer.opacity * 65_535), blendMode: layer.blend,
      },
    })
  }
  commands.push({ op: 'reorder', ids: draft.layers.map((layer) => layer.id) })
  return { version: 2, documentDigest: state.documentDigest, commands }
}
