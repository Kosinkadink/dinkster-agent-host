import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire32,
} from '../src/schema/dinkster-wire.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'

const concrete = (name: string) => ({ kind: 'concrete', types: [name] })
const variable = (allowed = ['IMAGE', 'MASK']) => ({ kind: 'variable', templateId: 'T', allowed })
const variants = [
  { key: 'image', type: concrete('IMAGE'), inputs: [] },
  { key: 'mask', type: concrete('MASK'), inputs: [] },
]
const slot = (id = 'source', extra: Record<string, unknown> = {}) => ({
  role: 'dynamicSlot', id, required: true, variants, typeTemplateId: 'T', ...extra,
})
const output = (type: unknown = variable()) => ({ role: 'output', id: 'out', type })
const schema = (interfaceEntries: readonly unknown[], wire = 32) => ({
  schemaVersion: wire,
  interface: interfaceEntries,
})
const decode = (interfaceEntries: readonly unknown[], wire = 32) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: { MatchedSlot: schema(interfaceEntries, wire) },
})

describe('schema wire 32 DynamicSlot type binding', () => {
  it('pins the current, accepted, and advertised versions', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(29)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(30)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(29)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(30)
  })

  it('decodes a required closed slot binding and nested output occurrences', () => {
    const result = decode([
      slot(),
      output(),
      { role: 'output', id: 'batch', type: { kind: 'list', element: variable() } },
    ])
    expect(result.diagnostics).toEqual([])
    const matched = result.schemas.get('MatchedSlot')!
    expect(inputsOf(matched)[0]!.dynamic).toMatchObject({
      kind: 'dynamicSlot', typeTemplateId: 'T', variants: [
        { key: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
        { key: 'mask', type: { kind: 'concrete', name: 'MASK' } },
      ],
    })
    expect(outputsOf(matched).map((item) => item.type)).toEqual([
      {
        kind: 'variable', templateId: 'T',
        allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
      },
      {
        kind: 'list',
        element: {
          kind: 'variable', templateId: 'T',
          allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
        },
      },
    ])
  })

  it('accepts an output family as the matched output occurrence', () => {
    const result = decode([
      { role: 'input', id: 'count', required: true, type: concrete('core.int') },
      slot(),
      {
        role: 'outputFamily', id: 'items', type: variable(), minMembers: 0, maxMembers: 8,
        count: { input: 'count', suffix: 'index' },
      },
    ])
    expect(result.diagnostics).toEqual([])
    expect(outputsOf(result.schemas.get('MatchedSlot')!)[0]).toMatchObject({
      id: 'items',
      type: { kind: 'variable', templateId: 'T' },
      dynamic: { count: { input: 'count', suffix: 'index' } },
    })
  })

  it.each([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])(
    'rejects the field on older recursive wire %i',
    (wire) => {
      const result = decode([slot(), output()], wire)
      expect(result.schemas.size).toBe(0)
      expect(result.diagnostics.some((diag) => diag.message.includes('typeTemplateId requires schema wire 32'))).toBe(true)
    },
  )

  it('rejects a wire-32 type binding on accepted wire 31', () => {
    const wire = 31
    const result = decode([slot(), output()], wire)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diag) => diag.message.includes('typeTemplateId requires schema wire 32'))).toBe(true)
  })

  it.each([
    {
      name: 'open slot',
      entries: [
        { role: 'dynamicSlot', id: 'source', required: false, slotType: concrete('IMAGE'), inputs: [], typeTemplateId: 'T' },
        output(),
      ],
      message: 'only legal on closed dynamicSlot',
    },
    {
      name: 'optional closed slot',
      entries: [slot('source', { required: false }), output()],
      message: 'requires a required dynamicSlot',
    },
    {
      name: 'nested slot',
      entries: [
        {
          role: 'inputFamily', id: 'items', required: false, memberPrefix: 'item',
          template: [slot()],
        },
        output(),
      ],
      message: 'only legal on a top-level dynamicSlot',
    },
    {
      name: 'duplicate binding',
      entries: [slot('source'), slot('other'), output()],
      message: "type variable 'T' is bound by multiple dynamic slots",
    },
    {
      name: 'missing output variable',
      entries: [slot(), output(concrete('IMAGE'))],
      message: 'but no output uses it',
    },
    {
      name: 'output allowlist mismatch',
      entries: [slot(), output(variable(['IMAGE']))],
      message: 'outside output variable',
    },
    {
      name: 'empty template id',
      entries: [slot('source', { typeTemplateId: '' }), output()],
      message: 'must be a non-empty string',
    },
  ])('fails closed for an invalid $name binding', ({ entries, message }) => {
    const result = decode(entries)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((diag) => diag.message.includes(message))).toBe(true)
  })

  it('exports the direct wire-32 decoder', () => {
    expect(parseDinksterSchemaWire32('MatchedSlot', schema([slot(), output()])).schema).toBeDefined()
  })
})
