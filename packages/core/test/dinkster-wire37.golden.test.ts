import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire37,
} from '../src/schema/dinkster-wire.js'

const compositorInput = {
  role: 'input',
  id: 'recipe',
  type: { kind: 'concrete', types: ['dinkster.compositor'] },
  required: false,
  widget: { type: 'COMPOSITOR' },
}

const node = (wire: number, input: unknown = compositorInput) => ({
  schemaVersion: wire,
  displayName: 'Create Layered Image',
  idempotent: true,
  interface: [input],
})

const catalog = (wire: number, input: unknown = compositorInput) => ({
  schemaVersion: wire,
  nodes: { Compositor: node(wire, input) },
})

describe('schema wire 37 COMPOSITOR descriptor', () => {
  it('pins the version registry and decodes exactly on concrete dinkster.compositor', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    const parsed = parseDinksterSchemaWire37('Compositor', node(37))
    expect(parsed.schema?.items[0]).toMatchObject({
      kind: 'input', id: 'recipe', widget: { widgetType: 'COMPOSITOR', options: {} },
    })
    expect(parsed.diagnostics).toEqual([])
  })

  it('rejects extra descriptor fields, wrong sockets, and older wires', () => {
    const extra = { ...compositorInput, widget: { type: 'COMPOSITOR', mode: 'layers' } }
    const wrong = { ...compositorInput, type: { kind: 'concrete', types: ['core.string'] } }
    expect(parseDinksterNodes(catalog(37, extra)).schemas.size).toBe(0)
    expect(parseDinksterNodes(catalog(37, wrong)).schemas.size).toBe(0)
    expect(parseDinksterNodes(catalog(36)).schemas.size).toBe(0)
  })

  it('inherits CURVE and STRING completion vocabulary without weakening their gates', () => {
    const inherited = parseDinksterNodes({
      schemaVersion: 37,
      nodes: {
        Inherited: {
          schemaVersion: 37,
          displayName: 'Inherited',
          idempotent: true,
          interface: [
            {
              role: 'input', id: 'curve', required: true,
              type: { kind: 'concrete', types: ['dinkster.curve'] },
              widget: { type: 'CURVE' },
            },
            {
              role: 'input', id: 'expression', required: true,
              type: { kind: 'concrete', types: ['core.string'] },
              widget: { type: 'STRING', multiline: true, completions: { items: [{ value: 'sin' }] } },
            },
          ],
        },
      },
    })
    expect(inherited.diagnostics).toEqual([])
    expect(inherited.schemas.get('Inherited')?.items).toMatchObject([
      { kind: 'input', id: 'curve', widget: { widgetType: 'CURVE' } },
      { kind: 'input', id: 'expression', widget: { widgetType: 'STRING', textCompletions: { items: [{ value: 'sin' }] } } },
    ])
  })
})
