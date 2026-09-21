import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire36,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

const schema = (completions: unknown) => ({
  schemaVersion: 36,
  interface: [{
    role: 'input',
    id: 'expression',
    type: { kind: 'concrete', types: ['core.string'] },
    required: true,
    widget: { type: 'STRING', multiline: true, completions },
  }],
})

const decode = (wire: number, completions: unknown) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: { Expression: { ...schema(completions), schemaVersion: wire } },
})

describe('schema wire 36 text completions', () => {
  it('pins the version registry and decodes static and family candidates', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    const completions = {
      items: [
        { value: 'sin', label: 'sin()', insertText: 'sin()', detail: 'Function' },
        { value: '**', kind: 'operator' },
      ],
      inputFamilies: ['values'],
    }
    const result = decode(36, completions)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('Expression')!)[0]?.widget?.textCompletions).toEqual({
      items: [
        { value: 'sin', label: 'sin()', insertText: 'sin()', detail: 'Function', kind: 'identifier' },
        { value: '**', label: '**', insertText: '**', detail: '', kind: 'operator' },
      ],
      inputFamilies: ['values'],
    })
    expect(parseDinksterSchemaWire36('Expression', schema(completions)).schema).toBeDefined()
  })

  it('keeps wire 35 frozen by rejecting completion metadata', () => {
    const result = decode(35, { items: [{ value: 'sin' }] })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("unknown fields: completions"))).toBe(true)
  })

  it.each([
    [null, 'must be an object'],
    [{}, 'must declare items or inputFamilies'],
    [{ items: [{ value: '' }] }, 'value must be a non-empty string'],
    [{ items: [{ value: 'sin', kind: 'future' }] }, 'kind must be identifier or operator'],
    [{ inputFamilies: ['values', 'values'] }, 'inputFamilies must be unique'],
    [{ inputFamilies: ['not structural'] }, 'array of structural ids'],
    [{ items: [{ value: 'sin', extra: true }] }, "unknown fields: extra"],
  ])('rejects malformed completion declaration %j', (completions, message) => {
    const result = decode(36, completions)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message as string))).toBe(true)
  })
})
