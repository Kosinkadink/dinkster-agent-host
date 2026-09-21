import { describe, expect, it } from 'vitest'
import {
  COMPOSITOR_STATE_PREVIEW_CHANNEL,
  COMPOSITOR_STATE_PREVIEW_STREAM,
  compositorDeltaFromDraft,
  compositorRecipeFingerprint,
  compositorStateOf,
  copyConfiguredCompositorRecipe,
  copyCompositorRecipe,
  EMPTY_COMPOSITOR_RECIPE,
  isCompositorRecipe,
  MAX_COMPOSITOR_LAYERS,
} from '../src/compositor.js'

const digest = `blake3:${'a'.repeat(64)}`
const identity = (
  x: number,
  y: number,
  width: number,
  height: number,
  sourceWidth = width,
  sourceHeight = height,
) => ({
  a: Math.round(width / sourceWidth * 1_000_000), b: 0,
  c: 0, d: Math.round(height / sourceHeight * 1_000_000),
  tx: x * 1_000_000, ty: y * 1_000_000,
  components: {
    x, y, width, height, rotation: 0, flipHorizontal: false, flipVertical: false,
    sourceWidth, sourceHeight,
  },
})
const transform = (
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  flipHorizontal: boolean,
  flipVertical: boolean,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  const scaleX = width / sourceWidth * (flipHorizontal ? -1 : 1)
  const scaleY = height / sourceHeight * (flipVertical ? -1 : 1)
  const a = cosine * scaleX
  const b = sine * scaleX
  const c = -sine * scaleY
  const d = cosine * scaleY
  return {
    a: Math.round(a * 1_000_000), b: Math.round(b * 1_000_000),
    c: Math.round(c * 1_000_000), d: Math.round(d * 1_000_000),
    tx: Math.round((x + width / 2 - (a * sourceWidth + c * sourceHeight) / 2) * 1_000_000),
    ty: Math.round((y + height / 2 - (b * sourceWidth + d * sourceHeight) / 2) * 1_000_000),
    components: { x, y, width, height, rotation, flipHorizontal, flipVertical, sourceWidth, sourceHeight },
  }
}
const document = {
  format: 'dinkster-image' as const,
  formatVersion: 2,
  lineage: 'compositor-test',
  canvas: {
    width: 640, height: 480, colorSpace: 'srgb' as const, channelDepth: 8 as const,
    compositing: 'premultiplied-alpha' as const, background: [4112, 8224, 12336, 32768] as const,
  },
  allocation: { nextOrdinal: 6 },
  rootLayerIds: ['l0', 'l2'],
  layers: {
    'l0': {
      id: 'l0', kind: 'raster' as const, name: 'Background', visible: true, opacity: 65_535,
      transform: identity(0, 0, 640, 480), blendMode: 'normal' as const, clipping: 'none' as const,
      maskIds: [], resourceId: 'r1', sourceRect: { x: 0, y: 0, width: 640, height: 480 }, z_index: 0,
    },
    'l2': {
      id: 'l2', kind: 'raster' as const, name: 'Overlay', visible: false, opacity: 32_768,
      transform: identity(10, 20, 200, 100), blendMode: 'screen' as const, clipping: 'none' as const,
      maskIds: ['m4'], resourceId: 'r3', sourceRect: { x: 0, y: 0, width: 200, height: 100 }, z_index: 1,
    },
  },
  masks: {
    'm4': {
      id: 'm4', kind: 'raster' as const, ownerLayerId: 'l2', enabled: true, invert: false, opacity: 65_535,
      transform: identity(60, 45, 50, 25, 25, 10), combineMode: 'multiply' as const,
      channel: 'luminance' as const, resourceId: 'r5', sourceRect: { x: 0, y: 0, width: 25, height: 10 },
    },
  },
  resources: {
    'r1': { id: 'r1', kind: 'raster' as const, digest, byteSize: 1, mediaType: 'image/png' as const, width: 640, height: 480, colorSpace: 'srgb' as const, channelDepth: 8 as const, alphaMode: 'straight' as const },
    'r3': { id: 'r3', kind: 'raster' as const, digest, byteSize: 1, mediaType: 'image/png' as const, width: 200, height: 100, colorSpace: 'srgb' as const, channelDepth: 8 as const, alphaMode: 'straight' as const },
    'r5': { id: 'r5', kind: 'raster' as const, digest, byteSize: 1, mediaType: 'image/png' as const, width: 25, height: 10, colorSpace: 'srgb' as const, channelDepth: 8 as const, alphaMode: 'straight' as const },
  },
}
const wireState = {
  version: 2,
  document,
  documentDigest: digest,
  stale: false,
  layerStreams: ['compositor.layer.0', 'compositor.layer.1'],
}

const reflectedMaskFixture = () => {
  const reflectedDocument = structuredClone(document)
  reflectedDocument.layers.l2!.transform = transform(17, -23, 240, 90, 0.35, false, false, 120, 60)
  reflectedDocument.masks.m4!.transform = transform(53, -11, 45, 28, 0.1, false, false, 30, 14)
  const state = compositorStateOf({ ...wireState, document: reflectedDocument })!
  const original = copyConfiguredCompositorRecipe(state)
  const draft = {
    ...original,
    layers: original.layers.map((layer) => layer.id === 'l2' ? {
      ...layer,
      transform: { x: -41, y: 67, width: 420, height: 157.5, rotation: -0.55 },
      flipH: true,
    } : layer),
  }
  return { state, draft }
}

const anisotropicMaskFixture = (maskRotationOffset = 0) => {
  const scaleX = 27.967879789760378
  const scaleY = 8.91033177084762
  const rotation = -3.02649280751931
  const ratio = 0.35643678554609354
  const anisotropicDocument = structuredClone(document)
  anisotropicDocument.layers.l2!.transform = transform(
    0, 0, scaleX * 200, scaleY * 100, rotation, false, false, 200, 100,
  )
  anisotropicDocument.masks.m4!.transform = transform(
    0, 0, scaleX * ratio * 200, scaleY * ratio * 100,
    rotation + maskRotationOffset, false, false, 200, 100,
  )
  anisotropicDocument.masks.m4!.sourceRect = { x: 0, y: 0, width: 200, height: 100 }
  anisotropicDocument.resources.r5!.width = 200
  anisotropicDocument.resources.r5!.height = 100
  const state = compositorStateOf({ ...wireState, document: anisotropicDocument })!
  const original = copyConfiguredCompositorRecipe(state)
  const draft = {
    ...original,
    layers: original.layers.map((layer) => layer.id === 'l2' ? {
      ...layer,
      transform: { x: 0, y: 0, width: 1, height: 16_000, rotation: -2.901920860812489 },
    } : layer),
  }
  return { state, draft }
}

describe('compositor delta grammar', () => {
  it('accepts and copies the exact v2 document-delta envelope', () => {
    const recipe = { version: 2 as const, documentDigest: digest, commands: [{ op: 'reorder', ids: ['l2', 'l0'] }] }
    expect(isCompositorRecipe(recipe)).toBe(true)
    const copied = copyCompositorRecipe(recipe)
    expect(copied).toEqual(recipe)
    expect(copied).not.toBe(recipe)
    expect(copied.commands).not.toBe(recipe.commands)
  })

  it.each([
    { ...EMPTY_COMPOSITOR_RECIPE, extra: true },
    { ...EMPTY_COMPOSITOR_RECIPE, version: 1 },
    { ...EMPTY_COMPOSITOR_RECIPE, documentDigest: 'a'.repeat(64) },
    { ...EMPTY_COMPOSITOR_RECIPE, commands: undefined },
  ])('rejects malformed deltas', (candidate) => expect(isCompositorRecipe(candidate)).toBe(false))

  it('uses the v2 empty default for absent-value fingerprints', () => {
    expect(isCompositorRecipe(EMPTY_COMPOSITOR_RECIPE)).toBe(true)
    expect(compositorRecipeFingerprint(undefined)).toBe(compositorRecipeFingerprint(EMPTY_COMPOSITOR_RECIPE))
    expect(compositorRecipeFingerprint({ version: 2 })).toBeUndefined()
  })
})

describe('compositor ImageDocument state', () => {
  it('normalizes the exact v2 state into an editable view and document delta', () => {
    const state = compositorStateOf(wireState)!
    expect(state.canvas).toEqual({ width: 640, height: 480 })
    expect(state.background).toEqual({ color: '#102030', opacity: 32768 / 65535, visible: true })
    expect(state.layers.map(({ id, name, blend }) => ({ id, name, blend }))).toEqual([
      { id: 'l0', name: 'Background', blend: 'normal' },
      { id: 'l2', name: 'Overlay', blend: 'screen' },
    ])
    const original = copyConfiguredCompositorRecipe(state)
    const draft = {
      ...original,
      layers: [{
        ...original.layers[1]!,
        name: 'Watermark',
        transform: { x: 30, y: 40, width: 400, height: 200, rotation: 0 },
      }, original.layers[0]!],
    }
    const delta = compositorDeltaFromDraft(state, draft)!
    expect(delta.version).toBe(2)
    expect(delta.documentDigest).toBe(digest)
    expect(delta.commands.at(-1)).toEqual({ op: 'reorder', ids: ['l2', 'l0'] })
    expect(delta.commands).toContainEqual({
      op: 'transform', kind: 'mask', id: 'm4',
      components: {
        x: 130, y: 90, width: 100, height: 50, rotation: 0,
        flipHorizontal: false, flipVertical: false, sourceWidth: 25, sourceHeight: 10,
      },
    })
    expect(delta.commands).toContainEqual({
      op: 'layer', id: 'l2',
      changes: { name: 'Watermark', visible: false, opacity: 32_768, blendMode: 'screen' },
    })
    expect(compositorStateOf(state)).toEqual(state)
    expect(COMPOSITOR_STATE_PREVIEW_CHANNEL).toBe('application/vnd.dinkster.compositor-state+json')
    expect(COMPOSITOR_STATE_PREVIEW_STREAM).toBe('compositor-state')
  })

  it('accepts fixed-point noise for a reflected, rotated attached mask', () => {
    const { state, draft } = reflectedMaskFixture()
    const delta = compositorDeltaFromDraft(state, draft)!
    const maskTransform = delta.commands.find((command) => {
      if (typeof command !== 'object' || command === null || Array.isArray(command)) return false
      const commandRecord = command as Readonly<Record<string, unknown>>
      return commandRecord['op'] === 'transform' && commandRecord['kind'] === 'mask'
    }) as { readonly components: Record<string, unknown> }
    expect(maskTransform.components['flipHorizontal']).toBe(true)
    expect(maskTransform.components['flipVertical']).toBe(false)
    expect(maskTransform.components['x']).toBeCloseTo(228.498875, 5)
    expect(maskTransform.components['y']).toBeCloseTo(67.280984, 5)
    expect(maskTransform.components['width']).toBeCloseTo(78.749999, 5)
    expect(maskTransform.components['height']).toBeCloseTo(48.999992, 5)
    expect(maskTransform.components['rotation']).toBeCloseTo(-0.3, 5)
  })

  it('accepts writer-quantized component affines at the anisotropic image limit', () => {
    const { state, draft } = anisotropicMaskFixture()
    const delta = compositorDeltaFromDraft(state, draft)!
    const maskTransform = delta.commands.find((command) => {
      if (typeof command !== 'object' || command === null || Array.isArray(command)) return false
      const commandRecord = command as Readonly<Record<string, unknown>>
      return commandRecord['op'] === 'transform' && commandRecord['kind'] === 'mask'
    }) as { readonly components: Record<string, unknown> }
    expect(maskTransform.components['width']).toBeCloseTo(0.356442157, 8)
    expect(maskTransform.components['height']).toBeCloseTo(5702.989166, 5)
    expect(maskTransform.components['rotation']).toBeCloseTo(-2.907409158, 8)
  })

  it('rejects real shear at high anisotropy', () => {
    const { state, draft } = anisotropicMaskFixture(0.0000003)
    expect(compositorDeltaFromDraft(state, draft)).toBeUndefined()
  })

  it('rejects real shear outside the fixed-point composition bound', () => {
    const { state, draft } = reflectedMaskFixture()
    const shearedDraft = {
      ...draft,
      layers: draft.layers.map((layer) => layer.id === 'l2'
        ? { ...layer, transform: { ...layer.transform, height: 157.51 } }
        : layer),
    }
    expect(compositorDeltaFromDraft(state, shearedDraft)).toBeUndefined()
  })

  it.each([
    [MAX_COMPOSITOR_LAYERS, true],
    [MAX_COMPOSITOR_LAYERS + 1, false],
  ] as const)('enforces the %i-layer v2 state boundary', (count, accepted) => {
    expect(MAX_COMPOSITOR_LAYERS).toBe(50)
    const rootLayerIds = Array.from({ length: count }, (_, index) => `l${index + 10}`)
    const boundedDocument = {
      ...structuredClone(document),
      rootLayerIds,
      layers: Object.fromEntries(rootLayerIds.map((id, index) => [id, {
        ...structuredClone(document.layers.l0), id, name: `Layer ${index}`, z_index: index,
      }])),
      masks: {},
      allocation: { nextOrdinal: count + 10 },
    }
    const candidate = compositorStateOf({
      ...wireState,
      document: boundedDocument,
      layerStreams: Array.from({ length: count }, (_, index) => `compositor.layer.${index}`),
    })
    expect(candidate !== undefined).toBe(accepted)
  })

  it.each([
    { ...wireState, extra: true },
    { ...wireState, version: 1 },
    { ...wireState, documentDigest: 'bad' },
    { ...wireState, stale: 1 },
    { ...wireState, layerStreams: ['compositor.layer.0'] },
    { ...wireState, layerStreams: ['compositor.layer.0', 'compositor.layer.4'] },
    { ...wireState, document: { ...document, rootLayerIds: ['missing'] } },
  ])('rejects malformed state', (candidate) => expect(compositorStateOf(candidate)).toBeUndefined())
})
