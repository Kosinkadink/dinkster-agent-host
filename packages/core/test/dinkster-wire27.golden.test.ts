import { describe, expect, it } from 'vitest'
import { DINKSTER_ACCEPTED_WIRE_VERSIONS, DINKSTER_ADVERTISED_WIRE_VERSIONS, DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes } from '../src/schema/dinkster-wire.js'

const decode = (wire: number, widgetGroups?: unknown) => parseDinksterNodes({
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
      widgetGroups,
    },
  },
})

describe('schema wire 27 conditional widget groups', () => {
  it('advertises and normalizes groups while retaining wire 26 without them', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBeGreaterThanOrEqual(27)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(27)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(27)
    expect(decode(27, [{
      input: 'mode', values: [null, 'x', true, 1], members: ['b'],
      requires: [{ input: 'a', values: [null, false, 1] }],
    }]).schemas.get('Generic')?.widgetGroups).toEqual([{
      input: 'mode', values: [null, 'x', true, 1], members: ['b'],
      requires: [{ input: 'a', values: [null, false, 1] }],
    }])
    expect(decode(26).schemas.get('Generic')?.widgetGroups).toBeUndefined()
  })

  it.each([
    {}, [], [{ input: '', values: ['x'], members: ['a'] }],
    [{ input: 'mode', values: [], members: ['a'] }],
    [{ input: 'mode', values: [Number.POSITIVE_INFINITY], members: ['a'] }],
    [{ input: 'mode', values: [2 ** 53], members: ['a'] }],
    [{ input: 'mode', values: ['x', 'x'], members: ['a'] }],
    [{ input: 'mode', values: ['x'], members: [] }],
    [{ input: 'mode', values: ['x'], members: ['a', 'a'] }],
    [{ input: 'missing', values: ['x'], members: ['a'] }],
    [{ input: 'mode', values: ['x'], members: ['missing'] }],
    [{ input: 'mode', values: ['x'], members: ['mode'] }],
    [{ input: 'mode', values: ['x'], members: ['a'], extra: true }],
    [{ input: 'mode', values: [1, 1.0], members: ['a'] }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: [] }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: {} }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: [{ input: 'a', values: [] }] }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: [{ input: 'a', values: [1, 1.0] }] }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: [{ input: 'missing', values: [1] }] }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: [{ input: 'mode', values: [1] }] }],
    [{ input: 'mode', values: ['x'], members: ['a'], requires: [{ input: 'a', values: [1] }] }],
    [{ input: 'mode', values: ['x'], members: ['b'], requires: [{ input: 'a', values: [1], extra: true }] }],
  ])('fails closed for malformed declaration %#', (groups) => {
    expect(decode(27, groups).schemas.size).toBe(0)
  })

  it('rejects declarations on older wire versions', () => {
    expect(decode(26, [{ input: 'mode', values: ['x'], members: ['a'] }]).schemas.size).toBe(0)
  })
})
