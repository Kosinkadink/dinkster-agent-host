import { describe, expect, it } from 'vitest'
import {
  parseDinksterNodes,
  parseDinksterSchemaWire39,
  parseDinksterSchemaWire40,
} from '../src/schema/dinkster-wire.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'

const imageInput = (policies: Record<string, unknown> = {}) => ({
  role: 'input',
  id: 'image',
  type: { kind: 'concrete', types: ['dinkster.image'] },
  required: true,
  ...policies,
})

const maskOutput = (policies: Record<string, unknown> = {}) => ({
  role: 'output',
  id: 'mask',
  type: { kind: 'concrete', types: ['dinkster.mask'] },
  ...policies,
})

const node = (wire: number, entries: readonly unknown[]) => ({
  schemaVersion: wire,
  signature: 'backend-signature',
  interface: entries,
})

const catalog = (wire: number, entries: readonly unknown[]) => ({
  schemaVersion: wire,
  nodes: { Media: node(wire, entries) },
})

describe('schema wire 40 media policies', () => {
  it('preserves declared input/output policies and signature', () => {
    const parsed = parseDinksterSchemaWire40('Media', node(40, [
      imageInput({ alphaPolicy: 'create_if_missing', maskPolarity: 'coverage', maskSemantic: 'selection' }),
      maskOutput({ alphaPolicy: 'drop', maskPolarity: 'transparency', maskSemantic: 'alpha' }),
    ]))
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.schema?.signature).toBe('backend-signature')
    expect(inputsOf(parsed.schema!)[0]).toMatchObject({
      alphaPolicy: 'create_if_missing',
      maskPolarity: 'coverage',
      maskSemantic: 'selection',
    })
    expect(outputsOf(parsed.schema!)[0]).toMatchObject({
      alphaPolicy: 'drop',
      maskPolarity: 'transparency',
      maskSemantic: 'alpha',
    })
  })

  it.each(['preserve', 'require', 'create_if_missing', 'drop'] as const)(
    'accepts alphaPolicy %s',
    (alphaPolicy) => {
      const parsed = parseDinksterSchemaWire40('Media', node(40, [imageInput({ alphaPolicy })]))
      expect(inputsOf(parsed.schema!)[0]?.alphaPolicy).toBe(alphaPolicy)
    },
  )

  it.each(['coverage', 'transparency'] as const)('accepts maskPolarity %s', (maskPolarity) => {
    const parsed = parseDinksterSchemaWire40('Media', node(40, [maskOutput({ maskPolarity })]))
    expect(outputsOf(parsed.schema!)[0]?.maskPolarity).toBe(maskPolarity)
  })

  it.each(['alpha', 'selection', 'other'] as const)('accepts maskSemantic %s', (maskSemantic) => {
    const parsed = parseDinksterSchemaWire40('Media', node(40, [maskOutput({ maskSemantic })]))
    expect(outputsOf(parsed.schema!)[0]?.maskSemantic).toBe(maskSemantic)
  })

  it.each([
    ['input', 'alphaPolicy', 'invent'],
    ['output', 'alphaPolicy', null],
    ['input', 'maskPolarity', 'inverted'],
    ['output', 'maskPolarity', 1],
    ['input', 'maskSemantic', 'matte'],
    ['output', 'maskSemantic', false],
  ] as const)('rejects invalid %s %s values', (role, field, value) => {
    const entry = role === 'input' ? imageInput({ [field]: value }) : maskOutput({ [field]: value })
    const parsed = parseDinksterNodes(catalog(40, [entry]))
    expect(parsed.schemas.size).toBe(0)
    expect(parsed.diagnostics[0]?.message).toContain(`${field} must be one of`)
  })

  it.each(['alphaPolicy', 'maskPolarity', 'maskSemantic'] as const)(
    'rejects %s at the wire 39 boundary',
    (field) => {
      const value = field === 'alphaPolicy' ? 'require' : field === 'maskPolarity' ? 'coverage' : 'alpha'
      const parsed = parseDinksterNodes(catalog(39, [imageInput({ [field]: value })]))
      expect(parsed.schemas.size).toBe(0)
      expect(parsed.diagnostics[0]?.message).toContain('media policies require schema wire 40')
    },
  )

  it('keeps omitted wire-40 defaults absent in the normalized model', () => {
    const parsed = parseDinksterSchemaWire40('Media', node(40, [imageInput(), maskOutput()]))
    expect(parsed.diagnostics).toEqual([])
    expect(inputsOf(parsed.schema!)[0]).not.toHaveProperty('alphaPolicy')
    expect(outputsOf(parsed.schema!)[0]).not.toHaveProperty('maskPolarity')

    const wire39 = parseDinksterSchemaWire39('Media', node(39, [imageInput(), maskOutput()]))
    expect(wire39.diagnostics).toEqual([])
  })
})
