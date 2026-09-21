import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import { isValidActorId } from '../ids.js'
import {
  IMAGE_BLEND_MODES,
  IMAGE_DOCUMENT_FORMAT,
  IMAGE_DOCUMENT_FORMAT_VERSION,
  IMAGE_MASK_COMBINE_MODES,
  IMAGE_OPACITY_MAX,
  IMAGE_RASTER_MEDIA_TYPES,
  MAX_IMAGE_CANVAS_DIMENSION,
  MAX_IMAGE_LAYERS,
  MAX_IMAGE_LINEAR_COMPONENT,
  MAX_IMAGE_MASKS_PER_LAYER,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_RESOURCES,
  MAX_IMAGE_TRANSLATION,
} from './model.js'

const BLEND_MODES = new Set<string>(IMAGE_BLEND_MODES)
const V1_BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'])
const MASK_COMBINE_MODES = new Set<string>(IMAGE_MASK_COMBINE_MODES)
const RASTER_MEDIA_TYPES = new Set<string>(IMAGE_RASTER_MEDIA_TYPES)
const ALPHA_MODES = new Set(['straight', 'premultiplied', 'opaque'])
const DIGEST_PATTERN = /^blake3:[0-9a-f]{64}$/

class ShapeChecker {
  readonly diagnostics: Diagnostic[] = []

  fail(path: string, message: string): false {
    this.diagnostics.push(diag('error', 'import', 'image.shape.invalid', `${path}: ${message}`))
    return false
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? true
      : this.fail(path, 'expected an object')
  }

  exactKeys(
    value: Record<string, unknown>,
    path: string,
    required: readonly string[],
    optional: readonly string[] = [],
  ): void {
    const allowed = new Set([...required, ...optional])
    for (const key of required) {
      if (!Object.hasOwn(value, key)) this.fail(`${path}.${key}`, 'required property is missing')
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) this.fail(`${path}.${key}`, 'unknown property')
    }
  }

  string(value: unknown, path: string, nonEmpty = false): value is string {
    if (typeof value !== 'string') return this.fail(path, 'expected a string')
    if (nonEmpty && value.length === 0) return this.fail(path, 'expected a non-empty string')
    if (value.includes('\u0000')) return this.fail(path, 'NUL is not allowed')
    return true
  }

  integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      return this.fail(path, `expected a safe integer from ${min} through ${max}`)
    }
    return true
  }

  boolean(value: unknown, path: string): value is boolean {
    return typeof value === 'boolean' ? true : this.fail(path, 'expected a boolean')
  }

  array(value: unknown, path: string): value is readonly unknown[] {
    return Array.isArray(value) ? true : this.fail(path, 'expected an array')
  }

  literal(value: unknown, path: string, expected: string | number): boolean {
    return value === expected ? true : this.fail(path, `expected ${JSON.stringify(expected)}`)
  }

  oneOf(value: unknown, path: string, allowed: ReadonlySet<string>): value is string {
    return typeof value === 'string' && allowed.has(value)
      ? true
      : this.fail(path, `expected one of ${[...allowed].join(', ')}`)
  }
}

function checkTransform(checker: ShapeChecker, value: unknown, path: string, version: number): void {
  if (!checker.object(value, path)) return
  checker.exactKeys(value, path, ['a', 'b', 'c', 'd', 'tx', 'ty'], version >= 2 ? ['components'] : [])
  for (const key of ['a', 'b', 'c', 'd'] as const) {
    checker.integer(value[key], `${path}.${key}`, -MAX_IMAGE_LINEAR_COMPONENT, MAX_IMAGE_LINEAR_COMPONENT)
  }
  for (const key of ['tx', 'ty'] as const) {
    checker.integer(value[key], `${path}.${key}`, -MAX_IMAGE_TRANSLATION, MAX_IMAGE_TRANSLATION)
  }
  const components = value['components']
  if (components !== undefined && checker.object(components, `${path}.components`)) {
    checker.exactKeys(components, `${path}.components`, [
      'x', 'y', 'width', 'height', 'rotation', 'flipHorizontal', 'flipVertical', 'sourceWidth', 'sourceHeight',
    ])
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'sourceWidth', 'sourceHeight']) {
      if (typeof components[key] !== 'number' || !Number.isFinite(components[key])) {
        checker.fail(`${path}.components.${key}`, 'expected a finite number')
      }
    }
    for (const key of ['width', 'height', 'sourceWidth', 'sourceHeight']) {
      const dimension = components[key]
      if (typeof dimension === 'number' && (dimension <= 0 || dimension > MAX_IMAGE_CANVAS_DIMENSION)) {
        checker.fail(`${path}.components.${key}`, 'transform dimension is outside canvas bounds')
      }
    }
    checker.boolean(components['flipHorizontal'], `${path}.components.flipHorizontal`)
    checker.boolean(components['flipVertical'], `${path}.components.flipVertical`)
  }
}

function checkSourceRect(checker: ShapeChecker, value: unknown, path: string): void {
  if (!checker.object(value, path)) return
  checker.exactKeys(value, path, ['x', 'y', 'width', 'height'])
  checker.integer(value['x'], `${path}.x`, 0, MAX_IMAGE_CANVAS_DIMENSION)
  checker.integer(value['y'], `${path}.y`, 0, MAX_IMAGE_CANVAS_DIMENSION)
  checker.integer(value['width'], `${path}.width`, 1, MAX_IMAGE_CANVAS_DIMENSION)
  checker.integer(value['height'], `${path}.height`, 1, MAX_IMAGE_CANVAS_DIMENSION)
}

function checkIdList(
  checker: ShapeChecker,
  value: unknown,
  path: string,
  maximum: number,
): void {
  if (!checker.array(value, path)) return
  if (value.length > maximum) checker.fail(path, `contains more than ${maximum} entries`)
  value.forEach((id, index) => checker.string(id, `${path}[${index}]`, true))
}

const LAYER_BASE_KEYS = [
  'id', 'kind', 'name', 'visible', 'opacity', 'transform', 'blendMode', 'clipping', 'maskIds',
] as const

function checkLayer(checker: ShapeChecker, value: unknown, path: string, version: number): void {
  if (!checker.object(value, path)) return
  const kind = value['kind']
  if (kind !== 'group' && kind !== 'raster') {
    const message = kind === 'vector' || kind === 'adjustment'
      ? `layer kind '${kind}' is reserved but unsupported in format version 1`
      : "expected layer kind 'group' or 'raster'"
    checker.fail(`${path}.kind`, message)
    return
  }
  const specific = kind === 'group' ? ['childLayerIds'] : ['resourceId', 'sourceRect']
  const optional = version >= 2 ? (kind === 'group' ? ['z_index', 'isolation'] : ['z_index']) : []
  checker.exactKeys(value, path, [...LAYER_BASE_KEYS, ...specific], optional)
  if (value['z_index'] !== undefined) checker.integer(value['z_index'], `${path}.z_index`, Number.MIN_SAFE_INTEGER)
  if (kind === 'group' && value['isolation'] !== undefined) {
    checker.oneOf(value['isolation'], `${path}.isolation`, new Set(['isolated', 'pass-through']))
  }
  checker.string(value['id'], `${path}.id`, true)
  checker.string(value['name'], `${path}.name`)
  checker.boolean(value['visible'], `${path}.visible`)
  checker.integer(value['opacity'], `${path}.opacity`, 0, IMAGE_OPACITY_MAX)
  checkTransform(checker, value['transform'], `${path}.transform`, version)
  checker.oneOf(value['blendMode'], `${path}.blendMode`, version >= 2 ? BLEND_MODES : V1_BLEND_MODES)
  if (value['clipping'] !== 'none' && value['clipping'] !== 'clip-to-previous') {
    checker.fail(`${path}.clipping`, "expected 'none' or 'clip-to-previous'")
  }
  checkIdList(checker, value['maskIds'], `${path}.maskIds`, MAX_IMAGE_MASKS_PER_LAYER)
  if (kind === 'group') {
    checkIdList(checker, value['childLayerIds'], `${path}.childLayerIds`, MAX_IMAGE_LAYERS)
  } else {
    checker.string(value['resourceId'], `${path}.resourceId`, true)
    checkSourceRect(checker, value['sourceRect'], `${path}.sourceRect`)
  }
}

function checkMask(checker: ShapeChecker, value: unknown, path: string, version: number): void {
  if (!checker.object(value, path)) return
  if (value['kind'] !== 'raster') {
    const message = value['kind'] === 'vector'
      ? "mask kind 'vector' is reserved but unsupported in format version 1"
      : "expected mask kind 'raster'"
    checker.fail(`${path}.kind`, message)
    return
  }
  checker.exactKeys(value, path, [
    'id', 'kind', 'ownerLayerId', 'enabled', 'invert', 'opacity', 'transform',
    'combineMode', 'channel', 'resourceId', 'sourceRect',
  ])
  checker.string(value['id'], `${path}.id`, true)
  checker.string(value['ownerLayerId'], `${path}.ownerLayerId`, true)
  checker.boolean(value['enabled'], `${path}.enabled`)
  checker.boolean(value['invert'], `${path}.invert`)
  checker.integer(value['opacity'], `${path}.opacity`, 0, IMAGE_OPACITY_MAX)
  checkTransform(checker, value['transform'], `${path}.transform`, version)
  checker.oneOf(value['combineMode'], `${path}.combineMode`, MASK_COMBINE_MODES)
  if (value['channel'] !== 'alpha' && value['channel'] !== 'luminance') {
    checker.fail(`${path}.channel`, "expected 'alpha' or 'luminance'")
  }
  checker.string(value['resourceId'], `${path}.resourceId`, true)
  checkSourceRect(checker, value['sourceRect'], `${path}.sourceRect`)
}

function checkResource(checker: ShapeChecker, value: unknown, path: string, version: number): void {
  if (!checker.object(value, path)) return
  if (value['kind'] !== 'raster') {
    checker.fail(`${path}.kind`, "expected resource kind 'raster'")
    return
  }
  checker.exactKeys(value, path, [
    'id', 'kind', 'digest', 'byteSize', 'mediaType', 'width', 'height',
    'colorSpace', 'channelDepth', 'alphaMode',
  ], version >= 2 ? ['inline'] : [])
  if (value['inline'] !== undefined && checker.string(value['inline'], `${path}.inline`)) {
    const inline = value['inline']
    if (inline.length > 5464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(inline)) {
      checker.fail(`${path}.inline`, 'expected strict base64 of at most 4096 bytes')
    } else {
      const decoded = atob(inline)
      if (decoded.length > 4096 || decoded.length !== value['byteSize'] || btoa(decoded) !== inline) {
        checker.fail(`${path}.inline`, 'inline bytes must be canonical base64 matching byteSize and the 4096-byte limit')
      } else if (`blake3:${bytesToHex(blake3(Uint8Array.from(decoded, (character) => character.charCodeAt(0))))}` !== value['digest']) {
        checker.fail(`${path}.inline`, 'inline bytes do not match the resource content digest')
      }
    }
  }
  checker.string(value['id'], `${path}.id`, true)
  if (checker.string(value['digest'], `${path}.digest`, true) && !DIGEST_PATTERN.test(value['digest'])) {
    checker.fail(`${path}.digest`, 'expected a lowercase BLAKE3 digest')
  }
  checker.integer(value['byteSize'], `${path}.byteSize`, 1)
  checker.oneOf(value['mediaType'], `${path}.mediaType`, RASTER_MEDIA_TYPES)
  const widthOk = checker.integer(value['width'], `${path}.width`, 1, MAX_IMAGE_CANVAS_DIMENSION)
  const heightOk = checker.integer(value['height'], `${path}.height`, 1, MAX_IMAGE_CANVAS_DIMENSION)
  const width = value['width']
  const height = value['height']
  if (widthOk && heightOk && (width as number) * (height as number) > MAX_IMAGE_PIXELS) {
    checker.fail(path, `decoded raster exceeds ${MAX_IMAGE_PIXELS} pixels`)
  }
  checker.literal(value['colorSpace'], `${path}.colorSpace`, 'srgb')
  checker.literal(value['channelDepth'], `${path}.channelDepth`, 8)
  checker.oneOf(value['alphaMode'], `${path}.alphaMode`, ALPHA_MODES)
}

function checkRecord(
  checker: ShapeChecker,
  value: unknown,
  path: string,
  maximum: number,
  checkEntry: (checker: ShapeChecker, value: unknown, path: string) => void,
): void {
  if (!checker.object(value, path)) return
  const entries = Object.entries(value)
  if (entries.length > maximum) checker.fail(path, `contains more than ${maximum} entries`)
  for (const [key, entry] of entries) {
    if (!checker.string(key, `${path} key`, true)) continue
    checkEntry(checker, entry, `${path}[${JSON.stringify(key)}]`)
  }
}

export function validateImageDocumentShape(
  value: unknown,
  expectedVersion = IMAGE_DOCUMENT_FORMAT_VERSION,
): readonly Diagnostic[] {
  const checker = new ShapeChecker()
  if (!checker.object(value, '$')) return checker.diagnostics
  checker.exactKeys(value, '$', [
    'format', 'formatVersion', 'lineage', 'canvas', 'allocation',
    'rootLayerIds', 'layers', 'masks', 'resources',
  ], ['extensions'])
  checker.literal(value['format'], '$.format', IMAGE_DOCUMENT_FORMAT)
  checker.literal(value['formatVersion'], '$.formatVersion', expectedVersion)
  checker.string(value['lineage'], '$.lineage', true)

  if (checker.object(value['canvas'], '$.canvas')) {
    const canvas = value['canvas']
    checker.exactKeys(canvas, '$.canvas', ['width', 'height', 'colorSpace', 'channelDepth', 'compositing'],
      expectedVersion >= 2 ? ['color', 'background'] : [])
    const color = canvas['color']
    if (color !== undefined && checker.object(color, '$.canvas.color')) {
      checker.exactKeys(color, '$.canvas.color', ['primaries', 'transfer', 'range'], ['matrix', 'bit_depth'])
      for (const [key, enumValue] of Object.entries(color)) checker.integer(enumValue, `$.canvas.color.${key}`, 0)
    }
    const background = canvas['background']
    if (background !== undefined && checker.array(background, '$.canvas.background')) {
      if (background.length !== 4) checker.fail('$.canvas.background', 'expected four RGBA16 components')
      background.forEach((component, index) => checker.integer(component, `$.canvas.background[${index}]`, 0, 65535))
    }
    const widthOk = checker.integer(canvas['width'], '$.canvas.width', 1, MAX_IMAGE_CANVAS_DIMENSION)
    const heightOk = checker.integer(canvas['height'], '$.canvas.height', 1, MAX_IMAGE_CANVAS_DIMENSION)
    const width = canvas['width']
    const height = canvas['height']
    if (widthOk && heightOk && (width as number) * (height as number) > MAX_IMAGE_PIXELS) {
      checker.fail('$.canvas', `canvas exceeds ${MAX_IMAGE_PIXELS} pixels`)
    }
    checker.literal(canvas['colorSpace'], '$.canvas.colorSpace', 'srgb')
    checker.literal(canvas['channelDepth'], '$.canvas.channelDepth', 8)
    if (expectedVersion >= 2) {
      checker.oneOf(canvas['compositing'], '$.canvas.compositing', new Set(['premultiplied-alpha', 'linear-premultiplied-alpha']))
    } else {
      checker.literal(canvas['compositing'], '$.canvas.compositing', 'premultiplied-alpha')
    }
  }

  if (checker.object(value['allocation'], '$.allocation')) {
    const allocation = value['allocation']
    checker.exactKeys(allocation, '$.allocation', ['nextOrdinal'], ['actorCursors'])
    checker.integer(allocation['nextOrdinal'], '$.allocation.nextOrdinal', 0)
    if (allocation['actorCursors'] !== undefined && checker.object(allocation['actorCursors'], '$.allocation.actorCursors')) {
      for (const [actor, cursor] of Object.entries(allocation['actorCursors'])) {
        if (!isValidActorId(actor)) checker.fail(`$.allocation.actorCursors[${JSON.stringify(actor)}]`, 'invalid actor id')
        checker.integer(cursor, `$.allocation.actorCursors[${JSON.stringify(actor)}]`, 0)
      }
    }
  }

  checkIdList(checker, value['rootLayerIds'], '$.rootLayerIds', MAX_IMAGE_LAYERS)
  checkRecord(checker, value['layers'], '$.layers', MAX_IMAGE_LAYERS,
    (entryChecker, entry, path) => checkLayer(entryChecker, entry, path, expectedVersion))
  checkRecord(checker, value['masks'], '$.masks', MAX_IMAGE_LAYERS * MAX_IMAGE_MASKS_PER_LAYER,
    (entryChecker, entry, path) => checkMask(entryChecker, entry, path, expectedVersion))
  checkRecord(checker, value['resources'], '$.resources', MAX_IMAGE_RESOURCES,
    (entryChecker, entry, path) => checkResource(entryChecker, entry, path, expectedVersion))
  if (value['extensions'] !== undefined) checker.object(value['extensions'], '$.extensions')
  return checker.diagnostics
}
