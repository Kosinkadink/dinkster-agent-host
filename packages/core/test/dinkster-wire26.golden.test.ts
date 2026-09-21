import { describe, expect, it } from 'vitest'
import { elabOutputsOf, elaborateInterface } from '../src/schema/elaborate.js'
import { outputsOf } from '../src/schema/model.js'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire25,
} from '../src/schema/dinkster-wire.js'

const intType = { kind: 'concrete', types: ['core.int'] }
const imageType = { kind: 'concrete', types: ['comfy.IMAGE'] }
const entries = (count: unknown = { input: 'count', suffix: 'index' }) => [
  { role: 'input', id: 'count', required: true, type: intType },
  { role: 'outputFamily', id: 'images', type: imageType, minMembers: 0, maxMembers: 4, count },
]
const decode = (interfaceEntries: readonly unknown[]) => parseDinksterNodes({
  schemaVersion: 26,
  nodes: { Split: { schemaVersion: 26, interface: interfaceEntries } },
})

describe('schema wire 26 count-bound output families', () => {
  it('advertises 26 and keeps wire 25 frozen', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(decode(entries()).schemas.size).toBe(1)
    expect(parseDinksterSchemaWire25('Split', { schemaVersion: 25, interface: entries() }).schema).toBeUndefined()
  })

  it.each([
    null,
    { input: 'count' },
    { input: 'count', suffix: 'index', extra: true },
    { input: 'count', suffix: 'ordinal' },
    { input: '', suffix: 'index' },
    { input: 'bad.input', suffix: 'index' },
  ])('rejects malformed count binding %#', (count) => {
    expect(decode(entries(count)).schemas.size).toBe(0)
  })

  it('rejects missing, optional, dynamic, and non-integer count inputs', () => {
    const family = entries()[1]!
    expect(decode([family]).schemas.size).toBe(0)
    expect(decode([{ role: 'input', id: 'count', required: false, type: intType }, family]).schemas.size).toBe(0)
    expect(decode([{ role: 'inputFamily', id: 'count', memberPrefix: 'c', template: [], minMembers: 0 }, family]).schemas.size).toBe(0)
    expect(decode([{ role: 'input', id: 'count', required: true, type: imageType }, family]).schemas.size).toBe(0)
  })

  it('elaborates exact canonical members without dynamic state or a growth ghost', () => {
    const result = decode(entries())
    const schema = result.schemas.get('Split')!
    expect(outputsOf(schema)[0]!.dynamic).toMatchObject({ count: { input: 'count', suffix: 'index' } })
    const elaborated = elaborateInterface(schema, { values: { count: 3 }, dynamic: {} })
    expect(elaborated.diagnostics).toEqual([])
    expect(elaborated.outputMembers).toEqual({ images: ['0', '1', '2'] })
    expect(elabOutputsOf(elaborated).map((output) => ({
      address: output.address,
      id: output.spec.id,
      backendId: output.backendId,
      ghost: output.origin.kind === 'member' ? output.origin.ghost : undefined,
    }))).toEqual([
      { address: { port: 'images', members: ['0'] }, id: 'images#0', backendId: 'images.0', ghost: undefined },
      { address: { port: 'images', members: ['1'] }, id: 'images#1', backendId: 'images.1', ghost: undefined },
      { address: { port: 'images', members: ['2'] }, id: 'images#2', backendId: 'images.2', ghost: undefined },
    ])
    expect(elaborated.items.some((item) => item.kind === 'growth')).toBe(false)
  })

  it('rejects a linked shared count input once even when a stored literal remains', () => {
    const schema = decode([
      ...entries(),
      { role: 'outputFamily', id: 'masks', type: imageType, minMembers: 0, maxMembers: 4, count: { input: 'count', suffix: 'index' } },
    ]).schemas.get('Split')!
    const elaborated = elaborateInterface(schema, { values: { count: 2 } }, {
      isInputConnected: (port) => port === 'count',
      isOutputConnected: () => false,
    })
    expect(elabOutputsOf(elaborated)).toEqual([])
    expect(elaborated.diagnostics.filter((diagnostic) => diagnostic.code === 'elab.outputFamily.linkedCount')).toEqual([expect.objectContaining({
      code: 'elab.outputFamily.linkedCount',
      severity: 'error',
      message: expect.stringContaining("output count input 'count'"),
    })])
  })

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', 5])('fails closed for hostile count value %s', (count) => {
    const schema = decode(entries()).schemas.get('Split')!
    const elaborated = elaborateInterface(schema, { values: count === undefined ? {} : { count }, dynamic: {} })
    expect(elabOutputsOf(elaborated)).toEqual([])
    expect(elaborated.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
  })

  it('uses the shared member budget when maxMembers is omitted', () => {
    const withoutMax = entries().map((entry) => {
      if (entry.role !== 'outputFamily') return entry
      const { maxMembers: _maxMembers, ...rest } = entry
      return rest
    })
    const schema = decode(withoutMax).schemas.get('Split')!
    const elaborated = elaborateInterface(schema, { values: { count: 11 } })
    expect(elaborated.diagnostics).toEqual([])
    expect(elaborated.outputMembers?.images).toHaveLength(11)
  })
})
