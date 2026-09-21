import { describe, expect, it } from 'vitest'
import { DINKSTER_ACCEPTED_WIRE_VERSIONS, DINKSTER_ADVERTISED_WIRE_VERSIONS, DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes } from '../src/schema/dinkster-wire.js'

const GLSL_MIRROR = {
  kind: 'glsl',
  precision: 'bounded',
  tolerance: { perChannel: 1 / 255 },
  source: 'void main() {}',
} as const

const decode = (wire: number, mirror?: unknown) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: {
    Generic: {
      schemaVersion: wire,
      interface: ['operation', 'a', 'b'].map((id) => ({
        role: 'input',
        id,
        required: true,
        type: { kind: 'concrete', types: ['core.string'] },
        ...(id === 'operation' ? { default: 'basic' } : {}),
      })),
      ...(mirror !== undefined ? { mirror } : {}),
    },
  },
})

describe('schema wire 30 mirror applies scope', () => {
  it('pins the version registry', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(29)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(30)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(29)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(30)
  })

  it('decodes a scoped glsl mirror', () => {
    const mirror = { ...GLSL_MIRROR, applies: { operation: ['gaussian_blur', 'sharpen'] } }
    expect(decode(30, mirror).schemas.get('Generic')?.mirror).toEqual(mirror)
  })

  it('decodes a multi-combo scope', () => {
    const applies = { operation: ['gaussian_blur'], dither: ['none', 'ordered'] }
    expect(decode(30, { ...GLSL_MIRROR, applies }).schemas.get('Generic')?.mirror?.applies).toEqual(applies)
  })

  it('decodes an unscoped mirror at wire 30 with applies absent', () => {
    expect(decode(30, GLSL_MIRROR).schemas.get('Generic')?.mirror).toEqual(GLSL_MIRROR)
    expect(decode(30, GLSL_MIRROR).schemas.get('Generic')?.mirror?.applies).toBeUndefined()
  })

  it('keeps unscoped mirrors decoding at wire 29', () => {
    expect(decode(29, GLSL_MIRROR).schemas.get('Generic')?.mirror).toEqual(GLSL_MIRROR)
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((wire) => wire >= 29 && wire < 30))('rejects an applies scope on wire %i', (wire) => {
    const { schemas, diagnostics } = decode(wire, { ...GLSL_MIRROR, applies: { operation: ['gaussian_blur'] } })
    expect(schemas.size).toBe(0)
    expect(diagnostics.some((d) => d.severity === 'error' && d.message.includes('mirror.applies requires schema wire 30'))).toBe(true)
  })

  it.each([
    null,
    [],
    'operation',
    7,
    {},
    { operation: [] },
    { operation: 'gaussian_blur' },
    { operation: ['gaussian_blur', 7] },
    { operation: ['gaussian_blur', ''] },
    { operation: ['gaussian_blur', 'gaussian_blur'] },
    { operation: [null] },
    { '': ['gaussian_blur'] },
  ])('fails closed for malformed applies %#', (applies) => {
    expect(decode(30, { ...GLSL_MIRROR, applies }).schemas.size).toBe(0)
  })
})
