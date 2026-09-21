import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  type DinksterNodesPayload,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

function numberCatalog(display: unknown, extraWidget: Record<string, unknown> = {}, wire = 18): DinksterNodesPayload {
  return {
    schemaVersion: wire,
    nodes: {
      'test.number': {
        schemaVersion: wire,
        interface: [{
          role: 'input',
          id: 'value',
          required: true,
          type: { kind: 'concrete', types: ['core.float'] },
          widget: { type: 'NUMBER', display, ...extraWidget },
        }],
      },
    },
  }
}

describe.each([18, 39, 40, 41])('schema wire %s NUMBER display', (wire) => {
  it('retains wire 18 after the wire 19 advertisement bump', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
  })

  it.each(['number', 'slider', 'knob', 'gradientslider'] as const)(
    'preserves explicit display %s through normalization',
    (display) => {
      const result = parseDinksterNodes(numberCatalog(display, { min: 0, max: 10, step: 0.5 }, wire))
      expect(result.diagnostics).toEqual([])
      expect(inputsOf(result.schemas.get('test.number')!)[0]!.widget).toEqual({
        widgetType: 'FLOAT',
        options: { min: 0, max: 10, step: 0.5, display },
      })
    },
  )

  it('accepts display as the only NUMBER descriptor field', () => {
    const result = parseDinksterNodes(numberCatalog('slider', {}, wire))
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('test.number')!)[0]!.widget).toEqual({
      widgetType: 'FLOAT', options: { display: 'slider' },
    })
  })

  it('drops only an invalid display value and keeps a usable numeric widget', () => {
    const result = parseDinksterNodes(numberCatalog('dial', { min: 0, max: 10 }, wire))
    expect(result.schemas.size).toBe(1)
    expect(inputsOf(result.schemas.get('test.number')!)[0]!.widget).toEqual({
      widgetType: 'FLOAT', options: { min: 0, max: 10 },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'schema.dinkster.badNumberDisplay' }),
    ])
  })

  it('still rejects an unknown NUMBER key loudly', () => {
    const result = parseDinksterNodes(numberCatalog('slider', { future: true }, wire))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((version) => version < 18))('keeps wire %s frozen against display', (version) => {
    const result = parseDinksterNodes(numberCatalog('slider', {}, version))
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })

  it('leaves non-NUMBER descriptors unchanged', () => {
    const result = parseDinksterNodes({
      schemaVersion: 18,
      nodes: {
        'test.boolean': {
          schemaVersion: 18,
          interface: [{
            role: 'input', id: 'enabled', required: true,
            type: { kind: 'concrete', types: ['core.boolean'] },
            widget: { type: 'BOOLEAN', labelOn: 'Yes' },
          }],
        },
      },
    })
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schemas.get('test.boolean')!)[0]!.widget).toEqual({
      widgetType: 'BOOLEAN', options: { labelOn: 'Yes' },
    })
  })
})
