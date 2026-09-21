import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchema,
  parseDinksterSchemaWire27,
  parseDinksterSchemaWire28,
  type DinksterWireSchema,
} from '../src/schema/dinkster-wire.js'

const replacement = [{
  from: 'Legacy',
  cases: [{
    to: 'Modern',
    slotVariants: {
      policy: 'tolerance_color',
      'policy.color_source': 'integer',
      'audit:mode': 'details',
    },
    nodes: { audit: { type: 'Audit' } },
  }],
}]

const migrationReplacement = [{
  from: 'Modern',
  migration: { historicalInputs: ['legacy'] },
  cases: [{
    to: 'Modern',
    when: { kind: 'valuePresent' as const, input: 'legacy' },
    inputs: { current: { kind: 'copy' as const, input: 'legacy' } },
  }, { to: 'Modern' }],
}]

const schema = (wire: 27 | 28, replacements: DinksterWireSchema['replacements'] = replacement): DinksterWireSchema => ({
  schemaVersion: wire,
  interface: [],
  replacements,
})

describe('schema wire 28 dynamic replacement targets', () => {
  it('advertises and preserves slotVariants on wire 28', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBeGreaterThanOrEqual(28)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(28)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(28)

    const decoded = parseDinksterNodes({ schemaVersion: 28, nodes: { Modern: schema(28) } })
    expect(decoded.diagnostics).toEqual([])
    expect(decoded.schemas.get('Modern')?.replacements).toEqual(replacement)
    expect(parseDinksterSchemaWire28('Modern', schema(28)).schema?.replacements).toEqual(replacement)
  })

  it('fails closed when slotVariants appears on an older wire', () => {
    const payload = parseDinksterNodes({ schemaVersion: 27, nodes: { Modern: schema(27) } })
    expect(payload.schemas.size).toBe(0)
    expect(payload.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'schema.parse.threw',
      message: expect.stringContaining('slotVariants requires schema wire 28'),
    }))

    expect(parseDinksterSchemaWire27('Modern', schema(27)).schema).toBeUndefined()
    expect(parseDinksterSchema('Modern', schema(27), 27).schema).toBeUndefined()
  })

  it('rejects stale MappingSource target choices', () => {
    const scaled = schema(28, [{
      from: 'Legacy',
      cases: [{
        to: 'Modern',
        targetChoices: { policy: { kind: 'constant', value: 'exact' } },
      }],
    }])
    const direct = parseDinksterSchemaWire28('Modern', scaled)
    expect(direct.schema?.replacements).toBeUndefined()
    expect(direct.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'schema.dinkster.badReplacements',
    }))
    const payload = parseDinksterNodes({ schemaVersion: 28, nodes: { Modern: scaled } })
    expect(payload.schemas.get('Modern')?.replacements).toBeUndefined()
    expect(payload.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'schema.dinkster.badReplacements',
    }))
  })

  it('preserves migration markers only on wire 28', () => {
    const current = schema(28, migrationReplacement)
    expect(parseDinksterNodes({ schemaVersion: 28, nodes: { Modern: current } }).schemas.get('Modern')?.replacements)
      .toEqual(migrationReplacement)
    expect(parseDinksterSchemaWire28('Modern', current).schema?.replacements).toEqual(migrationReplacement)

    const old = schema(27, migrationReplacement)
    const payload = parseDinksterNodes({ schemaVersion: 27, nodes: { Modern: old } })
    expect(payload.schemas.size).toBe(0)
    expect(payload.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining('replacement migration requires schema wire 28'),
    }))
    expect(parseDinksterSchemaWire27('Modern', old).schema).toBeUndefined()
    expect(parseDinksterSchema('Modern', old, 27).schema).toBeUndefined()
  })
})
