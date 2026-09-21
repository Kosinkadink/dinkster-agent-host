import { describe, expect, it } from 'vitest'
import { DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes, parseDinksterSchemaWire35 } from '../src/schema/dinkster-wire.js'

const curveInput = { role: 'input', id: 'curve', type: { kind: 'concrete', types: ['dinkster.curve'] }, required: true, widget: { type: 'CURVE' }, default: { interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] } }
const schema = (wire: number, input: unknown = curveInput) => ({ schemaVersion: wire, nodes: { Curve: { schemaVersion: wire, displayName: 'Curve', idempotent: true, interface: [input] } } })

describe('schema wire 35 CURVE descriptor', () => {
  it('decodes exactly on concrete dinkster.curve', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    const parsed = parseDinksterSchemaWire35('Curve', schema(35).nodes.Curve)
    expect(parsed.schema?.items[0]).toMatchObject({ kind: 'input', id: 'curve', widget: { widgetType: 'CURVE', options: {} } })
    expect(parsed.diagnostics).toEqual([])
  })

  it('rejects extra descriptor fields, wrong sockets, and older wires', () => {
    const extra = { ...curveInput, widget: { type: 'CURVE', min: 0 } }
    const wrong = { ...curveInput, type: { kind: 'concrete', types: ['core.float'] } }
    expect(parseDinksterNodes(schema(35, extra)).schemas.size).toBe(0)
    expect(parseDinksterNodes(schema(35, wrong)).schemas.size).toBe(0)
    expect(parseDinksterNodes(schema(34)).schemas.size).toBe(0)
  })

  it('retains CURVE when decoded through the additive wire 36 grammar', () => {
    expect(parseDinksterNodes(schema(36)).schemas.get('Curve')?.items[0]).toMatchObject({
      kind: 'input', id: 'curve', widget: { widgetType: 'CURVE', options: {} },
    })
  })
})
