import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  defaultValuesOf,
  inputsOf,
  parseDinksterNodes,
  parseDinksterSchemaWire38,
} from '../src/index.js'

const providerInput = (hidden: unknown = true) => ({
  role: 'input',
  id: 'provider',
  displayName: 'Provider',
  type: { kind: 'concrete', types: ['core.combo'] },
  required: false,
  default: 'vision.depth.v3',
  widget: { type: 'COMBO', options: ['vision.depth.v3'] },
  hidden,
})

const node = (wire: number, input: unknown = providerInput()) => ({
  schemaVersion: wire,
  displayName: 'Estimate Depth',
  idempotent: true,
  interface: [input],
})

const catalog = (wire: number, input: unknown = providerInput()) => ({
  schemaVersion: wire,
  nodes: { Depth: node(wire, input) },
})

describe('schema wire 38 hidden compatibility inputs', () => {
  it('pins the version registry and retains the hidden input in the schema model', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    const parsed = parseDinksterSchemaWire38('Depth', node(38))
    expect(parsed.diagnostics).toEqual([])
    expect(inputsOf(parsed.schema!)[0]).toMatchObject({
      id: 'provider',
      displayName: 'Provider',
      optional: true,
      hidden: true,
    })
    expect(defaultValuesOf(parsed.schema!)).toEqual({})
  })

  it('normalizes false to omission and rejects malformed markers', () => {
    expect(inputsOf(parseDinksterSchemaWire38('Depth', node(38, providerInput(false))).schema!)[0])
      .not.toHaveProperty('hidden')
    const malformed = parseDinksterNodes(catalog(38, providerInput('yes')))
    expect(malformed.schemas.size).toBe(0)
    expect(malformed.diagnostics[0]?.message).toContain('hidden must be a boolean')
  })

  it('keeps wire 37 frozen against the new marker', () => {
    const downlevel = parseDinksterNodes(catalog(37))
    expect(downlevel.schemas.size).toBe(0)
    expect(downlevel.diagnostics[0]?.message).toContain('hidden requires schema wire 38')
  })

  it('retains the established strict widget grammar', () => {
    const parsed = parseDinksterNodes({
      schemaVersion: 38,
      nodes: {
        Widgets: {
          schemaVersion: 38,
          interface: [
            {
              role: 'input', id: 'choice', required: false,
              type: { kind: 'concrete', types: ['core.combo'] }, default: 'a',
              widget: { type: 'COMBO', options: [{ value: 'a', label: 'Choice A' }] },
            },
            {
              role: 'input', id: 'choices', required: false,
              type: { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } }, default: [],
              widget: { type: 'MULTI_COMBO', options: ['a'] },
            },
            {
              role: 'input', id: 'amount', required: false,
              type: { kind: 'concrete', types: ['core.int'] }, default: '9007199254740992',
              widget: { type: 'NUMBER', min: '9007199254740992', display: 'slider' },
            },
          ],
        },
      },
    })
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.schemas.size).toBe(1)
  })
})
