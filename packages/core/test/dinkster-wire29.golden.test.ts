import { describe, expect, it } from 'vitest'
import { DINKSTER_ACCEPTED_WIRE_VERSIONS, DINKSTER_ADVERTISED_WIRE_VERSIONS, DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes, parseDinksterSchema } from '../src/schema/dinkster-wire.js'

const decode = (wire: number, mirror?: unknown, widgetGroups?: unknown) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: {
    Generic: {
      schemaVersion: wire,
      interface: ['mode', 'a', 'b'].map((id) => ({
        role: 'input',
        id,
        required: true,
        type: { kind: 'concrete', types: ['core.string'] },
        ...(id === 'mode' ? { default: 'basic' } : {}),
      })),
      ...(mirror !== undefined ? { mirror } : {}),
      ...(widgetGroups !== undefined ? { widgetGroups } : {}),
    },
  },
})

describe('schema wire 29 mirror declarations', () => {
  it('pins the version registry', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(28)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(28)
  })

  it('decodes a bounded expression mirror', () => {
    expect(decode(29, {
      kind: 'expression', precision: 'bounded', tolerance: { relative: 1e-12 }, grammarVersion: 1,
    }).schemas.get('Generic')?.mirror).toEqual({
      kind: 'expression', precision: 'bounded', tolerance: { relative: 1e-12 }, grammarVersion: 1,
    })
  })

  it('decodes an exact expression mirror without tolerance', () => {
    expect(decode(29, {
      kind: 'expression', precision: 'exact', grammarVersion: 3,
    }).schemas.get('Generic')?.mirror).toEqual({
      kind: 'expression', precision: 'exact', grammarVersion: 3,
    })
  })

  it('decodes a bounded glsl mirror with both tolerance bounds', () => {
    expect(decode(29, {
      kind: 'glsl', precision: 'bounded', tolerance: { relative: 1e-6, perChannel: 2e-3 }, source: 'void main() {}',
    }).schemas.get('Generic')?.mirror).toEqual({
      kind: 'glsl', precision: 'bounded', tolerance: { relative: 1e-6, perChannel: 2e-3 }, source: 'void main() {}',
    })
  })

  it('leaves mirror absent when the wire omits it and keeps widget groups decoding at 29', () => {
    expect(decode(29).schemas.get('Generic')?.mirror).toBeUndefined()
    expect(decode(29, undefined, [{
      input: 'mode', values: ['x'], members: ['b'],
    }]).schemas.get('Generic')?.widgetGroups).toEqual([{
      input: 'mode', values: ['x'], members: ['b'],
    }])
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((wire) => wire < 29))('rejects mirrors on wire %i', (wire) => {
    const { schemas, diagnostics } = decode(wire, { kind: 'expression', precision: 'exact', grammarVersion: 1 })
    expect(schemas.size).toBe(0)
    expect(diagnostics.some((d) => d.severity === 'error' && d.message.includes('mirror requires schema wire 29'))).toBe(true)
  })

  it('rejects a mirror through the direct legacy schema decoder', () => {
    const { schema, diagnostics } = parseDinksterSchema('Generic', {
      interface: [],
      mirror: { kind: 'expression', precision: 'exact', grammarVersion: 1 },
    })
    expect(schema).toBeUndefined()
    expect(diagnostics.some((d) => d.message.includes('mirror requires schema wire 29'))).toBe(true)
  })

  it.each([
    null,
    [],
    'expression',
    {},
    { kind: 'expression', precision: 'exact', grammarVersion: 1, extra: true },
    { kind: 'quantum', precision: 'exact', grammarVersion: 1 },
    { kind: 1, precision: 'exact', grammarVersion: 1 },
    { precision: 'exact', grammarVersion: 1 },
    { kind: 'expression', precision: 'approximate', grammarVersion: 1 },
    { kind: 'expression', precision: true, grammarVersion: 1 },
    { kind: 'expression', grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', grammarVersion: 1 },
    { kind: 'expression', precision: 'exact', tolerance: { relative: 1e-12 }, grammarVersion: 1 },
    { kind: 'expression', precision: 'exact' },
    { kind: 'expression', precision: 'exact', grammarVersion: 0 },
    { kind: 'expression', precision: 'exact', grammarVersion: -1 },
    { kind: 'expression', precision: 'exact', grammarVersion: 1.5 },
    { kind: 'expression', precision: 'exact', grammarVersion: '1' },
    { kind: 'expression', precision: 'exact', grammarVersion: 1, source: 'x' },
    { kind: 'glsl', precision: 'exact', source: 'x', grammarVersion: 1 },
    { kind: 'glsl', precision: 'exact' },
    { kind: 'glsl', precision: 'exact', source: '' },
    { kind: 'glsl', precision: 'exact', source: 7 },
    { kind: 'glsl', precision: 'exact', source: 'x'.repeat(16385) },
    { kind: 'expression', precision: 'bounded', tolerance: {}, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: [], grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { relative: 1e-12, extra: 1 }, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { relative: 0 }, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { relative: -1e-12 }, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { relative: Number.POSITIVE_INFINITY }, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { relative: Number.NaN }, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { relative: '1e-12' }, grammarVersion: 1 },
    { kind: 'expression', precision: 'bounded', tolerance: { perChannel: 0 }, grammarVersion: 1 },
  ])('fails closed for malformed mirror %#', (mirror) => {
    expect(decode(29, mirror).schemas.size).toBe(0)
  })
})
