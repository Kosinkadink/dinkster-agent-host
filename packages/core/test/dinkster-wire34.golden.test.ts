import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire34,
} from '../src/schema/dinkster-wire.js'
import { outputsOf } from '../src/schema/model.js'

const concrete = (name: string) => ({ kind: 'concrete', types: [name] })

const schema = (
  type = 'core.int',
  knownValue: unknown = { input: 'value' },
  inputType = type,
) => ({
  schemaVersion: 34,
  interface: [
    { role: 'input', id: 'value', type: concrete(inputType), required: false, default: 0 },
    { role: 'output', id: 'result', type: concrete(type), knownValue },
  ],
})

const decode = (wire: number, value: ReturnType<typeof schema>) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: { Primitive: { ...value, schemaVersion: wire } },
})

describe('schema wire 34 primitive identity outputs', () => {
  it('pins the current, accepted, and advertised versions', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(33)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(33)
  })

  it.each(['core.int', 'core.float', 'core.string', 'core.boolean'])(
    'decodes an exact %s identity declaration',
    (type) => {
      const result = decode(34, schema(type))
      expect(result.diagnostics).toEqual([])
      expect(outputsOf(result.schemas.get('Primitive')!)[0]?.knownValue).toEqual({ input: 'value' })
    },
  )

  it('exports the direct wire-34 decoder', () => {
    const result = parseDinksterSchemaWire34('Primitive', schema())
    expect(result.diagnostics).toEqual([])
    expect(outputsOf(result.schema!)[0]?.knownValue).toEqual({ input: 'value' })
  })

  it('keeps wire 33 frozen by rejecting the declaration', () => {
    const result = decode(33, schema())
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('output.knownValue requires schema wire 34'))).toBe(true)
  })

  it.each([
    [null, 'must be an object'],
    [[], 'must be an object'],
    [{ input: '' }, 'input must be a non-empty string'],
    [{ input: 1 }, 'input must be a non-empty string'],
    [{ input: 'value', extra: true }, "unknown field 'extra'"],
  ])('rejects malformed declaration %j', (knownValue, message) => {
    const result = decode(34, schema('core.int', knownValue))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message as string))).toBe(true)
  })

  it.each([
    ['missing input', { input: 'missing' }, 'core.int', 'core.int'],
    ['mismatched type', { input: 'value' }, 'core.float', 'core.int'],
    ['non-primitive type', { input: 'value' }, 'dinkster.image', 'dinkster.image'],
  ])('rejects a %s relation', (_name, knownValue, outputType, inputType) => {
    const result = decode(34, schema(outputType, knownValue, inputType))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes('same concrete primitive type'))).toBe(true)
  })
})
