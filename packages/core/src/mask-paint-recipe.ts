export const MAX_MASK_PAINT_JSON_BYTES = 4_194_304
export const MAX_MASK_PAINT_COMMANDS = 2_048
export const MAX_MASK_PAINT_STROKE_POINTS = 8_192
export const MAX_MASK_PAINT_TOTAL_POINTS = 32_768

export interface MaskPaintPoint {
  readonly x: number
  readonly y: number
  readonly pressure: number
}

export type MaskPaintCommand =
  | { readonly op: 'clear' }
  | { readonly op: 'invert' }
  | {
      readonly op: 'stroke'
      readonly mode: 'paint' | 'erase'
      readonly size: number
      readonly hardness: number
      readonly points: readonly MaskPaintPoint[]
    }

export interface MaskPaintRecipe {
  readonly version: 1
  readonly sourceDigest: string
  readonly width: number
  readonly height: number
  readonly commands: readonly MaskPaintCommand[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')

const INTEGER_TOKEN_KEYS = new Set(['version', 'width', 'height'])

function parseMaskPaintJson(source: string): unknown {
  let index = 0
  const scalar = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/uy
  const whitespace = (): void => { while (/\s/u.test(source[index] ?? '')) index += 1 }
  const fail = (): never => { throw new SyntaxError('Malformed JSON') }
  const string = (): string => {
    if (source[index] !== '"') fail()
    const start = index++
    while (index < source.length) {
      const character = source[index++]!
      if (character === '\\') {
        if (index >= source.length) fail()
        index += 1
      } else if (character === '"') {
        return JSON.parse(source.slice(start, index)) as string
      }
    }
    return fail()
  }
  const value = (integerToken = false, rootObject = false): void => {
    whitespace()
    const character = source[index]
    if (character === '"') { string(); return }
    if (character === '{') {
      index += 1
      whitespace()
      const keys = new Set<string>()
      if (source[index] === '}') { index += 1; return }
      while (true) {
        whitespace()
        const key = string()
        if (keys.has(key)) fail()
        keys.add(key)
        whitespace()
        if (source[index++] !== ':') fail()
        value(rootObject && INTEGER_TOKEN_KEYS.has(key))
        whitespace()
        const separator = source[index++]
        if (separator === '}') return
        if (separator !== ',') fail()
      }
    }
    if (character === '[') {
      index += 1
      whitespace()
      if (source[index] === ']') { index += 1; return }
      while (true) {
        value()
        whitespace()
        const separator = source[index++]
        if (separator === ']') return
        if (separator !== ',') fail()
      }
    }
    scalar.lastIndex = index
    const token = scalar.exec(source)?.[0]
    if (token === undefined) return fail()
    if (integerToken && !/^-?(?:0|[1-9]\d*)$/u.test(token)) fail()
    index += token.length
  }
  value(false, true)
  whitespace()
  if (index !== source.length) fail()
  return JSON.parse(source) as unknown
}

export function parseMaskPaintRecipe(value: string): MaskPaintRecipe | undefined {
  if (new TextEncoder().encode(value).length > MAX_MASK_PAINT_JSON_BYTES) return undefined
  try {
    const raw = parseMaskPaintJson(value)
    if (!record(raw) || !exactKeys(raw, ['version', 'sourceDigest', 'width', 'height', 'commands']) ||
        raw.version !== 1 || typeof raw.sourceDigest !== 'string' || !/^blake3:[0-9a-f]{64}$/.test(raw.sourceDigest) ||
        typeof raw.width !== 'number' || !Number.isSafeInteger(raw.width) || raw.width <= 0 ||
        typeof raw.height !== 'number' || !Number.isSafeInteger(raw.height) || raw.height <= 0 ||
        !Array.isArray(raw.commands) || raw.commands.length > MAX_MASK_PAINT_COMMANDS) return undefined
    let totalPoints = 0
    for (const command of raw.commands) {
      if (!record(command) || typeof command.op !== 'string') return undefined
      if (command.op === 'clear' || command.op === 'invert') {
        if (!exactKeys(command, ['op'])) return undefined
        continue
      }
      if (command.op !== 'stroke' || !exactKeys(command, ['op', 'mode', 'size', 'hardness', 'points']) ||
          (command.mode !== 'paint' && command.mode !== 'erase') || typeof command.size !== 'number' ||
          !Number.isFinite(command.size) || command.size < 1 || command.size > 256 || typeof command.hardness !== 'number' ||
          !Number.isFinite(command.hardness) || command.hardness < 0 || command.hardness > 1 || !Array.isArray(command.points) ||
          command.points.length < 1 || command.points.length > MAX_MASK_PAINT_STROKE_POINTS) return undefined
      totalPoints += command.points.length
      if (totalPoints > MAX_MASK_PAINT_TOTAL_POINTS) return undefined
      for (const point of command.points) {
        if (!record(point) || !exactKeys(point, ['x', 'y', 'pressure']) ||
            typeof point.x !== 'number' || !Number.isFinite(point.x) || typeof point.y !== 'number' || !Number.isFinite(point.y) ||
            typeof point.pressure !== 'number' || !Number.isFinite(point.pressure) || point.pressure < 0 || point.pressure > 1) return undefined
        const radius = Math.max(0.5, command.size * (0.25 + point.pressure * 0.75) / 2)
        if (point.x + radius < 0.5 || point.x - radius > raw.width - 0.5 ||
            point.y + radius < 0.5 || point.y - radius > raw.height - 0.5) return undefined
      }
    }
    return raw as unknown as MaskPaintRecipe
  } catch {
    return undefined
  }
}
