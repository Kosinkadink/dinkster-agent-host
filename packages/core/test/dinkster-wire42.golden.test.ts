import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire42,
} from '../src/schema/dinkster-wire.js'

const node = (version: number, fields: Record<string, unknown> = {}) => ({
  schemaVersion: version,
  displayName: 'Documented node',
  interface: [],
  ...fields,
})

const parse = (version: number, fields: Record<string, unknown> = {}) => parseDinksterNodes({
  schemaVersion: version,
  nodes: { Documented: node(version, fields) },
})

describe('schema wire 42 help availability marker', () => {
  it('advertises and accepts wire 42 while retaining wires 40 and 41', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.slice(-3)).toEqual([42, 43, 44])
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.slice(-3)).toEqual([41, 42, 44])
  })

  it('preserves the present-only hasDocs marker', () => {
    const documented = parseDinksterSchemaWire42('Documented', node(42, { hasDocs: true }))
    expect(documented.diagnostics).toEqual([])
    expect(documented.schema?.hasDocs).toBe(true)

    const undocumented = parse(42)
    expect(undocumented.diagnostics).toEqual([])
    expect(undocumented.schemas.get('Documented')).not.toHaveProperty('hasDocs')
  })

  it.each([false, null, 0, 'true', [], {}, undefined])('rejects invalid marker value %j', (hasDocs) => {
    const result = parse(42, { hasDocs })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics[0]?.severity).toBe('error')
  })

  it.each([40, 41])('rejects the marker on older wire %s', (version) => {
    const result = parse(version, { hasDocs: true })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics[0]?.severity).toBe('error')
  })
})
