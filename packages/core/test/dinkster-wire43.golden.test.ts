import { describe, expect, it } from 'vitest'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire43,
} from '../src/schema/dinkster-wire.js'

const node = (version: number, widget: unknown) => ({
  schemaVersion: version,
  displayName: 'Route Switch by Name',
  interface: [
    {
      role: 'input', id: 'choice', type: { kind: 'concrete', types: ['core.combo'] },
      required: true, widget,
    },
    {
      role: 'inputFamily', id: 'values', memberPrefix: 'value', minMembers: 1,
      template: [{ role: 'input', id: 'value', type: { kind: 'wildcard' }, required: true }],
    },
  ],
})

describe('schema wire 43 input-family combo options', () => {
  it('accepts wire 43 without advertising it for documents that do not need it', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.slice(-3)).toEqual([42, 43, 44])
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).not.toContain(43)
  })

  it('decodes the strict source and elaborates stable values in member order with labels', () => {
    const result = parseDinksterSchemaWire43('dinkster.route.switch_by_name', node(43, {
      type: 'COMBO', optionSource: { inputFamily: 'values' },
    }))
    expect(result.diagnostics).toEqual([])
    const schema = result.schema!
    const choice = elabInputsOf(elaborateInterface(schema, {
      values: { choice: 'm7' },
      dynamic: {
        values: {
          members: ['m7', 'm2', 'm9'],
          memberLabels: { m7: 'Background', m2: 'Subject', m9: 'Subject' },
        },
      },
    })).find((input) => input.address.port === 'choice')!
    expect(choice.spec.widget).toMatchObject({
      optionSource: { inputFamily: 'values' },
      options: { options: [
        { value: 'm7', label: 'Background' },
        { value: 'm2', label: 'Subject (m2)' },
        { value: 'm9', label: 'Subject (m9)' },
      ] },
    })
  })

  it.each([40, 41, 42])('rejects a wire-43 source mislabeled as wire %s', (version) => {
    const parsed = parseDinksterNodes({
      schemaVersion: version,
      nodes: { Route: node(version, { type: 'COMBO', optionSource: { inputFamily: 'values' } }) },
    })
    expect(parsed.schemas.size).toBe(0)
    expect(parsed.diagnostics[0]?.severity).toBe('error')
  })

  it.each([
    null,
    [],
    {},
    { inputFamily: '' },
    { inputFamily: 'values', extra: true },
  ])('rejects malformed optionSource %j', (optionSource) => {
    const parsed = parseDinksterNodes({
      schemaVersion: 43,
      nodes: { Route: node(43, { type: 'COMBO', optionSource }) },
    })
    expect(parsed.schemas.size).toBe(0)
  })
})
