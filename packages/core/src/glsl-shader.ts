export const GLSL_STATE_PREVIEW_CHANNEL = 'application/vnd.dinkster.glsl-state+json'
export const GLSL_STATE_PREVIEW_STREAM = 'glsl-state'

export interface GlslShaderState {
  readonly width: number
  readonly height: number
  readonly inputs: readonly { readonly name: string; readonly stream: string }[]
  readonly floats: Readonly<Record<string, number>>
  readonly ints: Readonly<Record<string, number>>
  readonly bools: Readonly<Record<string, boolean>>
  readonly curves: Readonly<Record<string, readonly number[]>>
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined

const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')

export function glslShaderStateOf(value: unknown): GlslShaderState | undefined {
  const state = record(value)
  if (!state || !exact(state, ['width', 'height', 'inputs', 'floats', 'ints', 'bools', 'curves'])) return undefined
  const width = state['width'], height = state['height'], inputs = state['inputs']
  const floats = record(state['floats']), ints = record(state['ints']), bools = record(state['bools']), curves = record(state['curves'])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1 ||
      (width as number) > 16384 || (height as number) > 16384 || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 5 ||
      !floats || !ints || !bools || !curves) return undefined
  const parsedInputs = inputs.map(record)
  const inputIndexes = parsedInputs.map((input) => {
    if (!input || !exact(input, ['name', 'stream']) || typeof input['name'] !== 'string' ||
        input['stream'] !== `glsl-input-${input['name']}`) return undefined
    const match = /^u_image([0-4])$/.exec(input['name'])
    return match ? Number(match[1]) : undefined
  })
  if (inputIndexes.some((index) => index === undefined) || inputIndexes.some((index, position) =>
    position > 0 && index! <= inputIndexes[position - 1]!)) return undefined
  const family = (values: Readonly<Record<string, unknown>>, prefix: string, max: number, valid: (v: unknown) => boolean): boolean =>
    Object.entries(values).length <= max && Object.entries(values).every(([key, entry]) =>
      new RegExp(`^${prefix}(?:0|[1-9][0-9]?)$`).test(key) && Number(key.slice(prefix.length)) < max && valid(entry))
  if (!family(floats, 'u_float', 20, (v) => typeof v === 'number' && Number.isFinite(v)) ||
      !family(ints, 'u_int', 20, (v) => Number.isSafeInteger(v)) ||
      !family(bools, 'u_bool', 10, (v) => typeof v === 'boolean') ||
      !family(curves, 'u_curve', 4, (v) => Array.isArray(v) && v.length === 256 && v.every((n) => typeof n === 'number' && Number.isFinite(n)))) return undefined
  return {
    width: width as number,
    height: height as number,
    inputs: parsedInputs.map((input) => ({
      name: input!['name'] as string,
      stream: input!['stream'] as string,
    })),
    floats: { ...floats } as GlslShaderState['floats'],
    ints: { ...ints } as GlslShaderState['ints'],
    bools: { ...bools } as GlslShaderState['bools'],
    curves: Object.fromEntries(Object.entries(curves).map(([name, samples]) =>
      [name, [...samples as readonly number[]]])),
  }
}
