import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire39,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

const ordinaryInput = (acceptsStorage?: unknown) => ({
  role: 'input',
  id: 'value',
  type: { kind: 'concrete', types: ['dinkster.image'] },
  required: true,
  ...(acceptsStorage === undefined ? {} : { acceptsStorage }),
})

const node = (wire: number, entries: readonly unknown[]) => ({
  schemaVersion: wire,
  signature: 'backend-signature',
  interface: entries,
})

const catalog = (wire: number, entries: readonly unknown[]) => ({
  schemaVersion: wire,
  nodes: { Storage: node(wire, entries) },
})

describe('schema wire 39 storage acceptance', () => {
  it('keeps wire 39 supported while the default offer remains wire 42', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(39)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(39)
  })

  it('preserves true and normalizes false and omission to omission', () => {
    const accepted = parseDinksterSchemaWire39('Storage', node(39, [ordinaryInput(true)]))
    expect(accepted.diagnostics).toEqual([])
    expect(accepted.schema?.signature).toBe('backend-signature')
    expect(inputsOf(accepted.schema!)[0]).toMatchObject({ acceptsStorage: true })

    for (const marker of [false, undefined]) {
      const parsed = parseDinksterSchemaWire39('Storage', node(39, [ordinaryInput(marker)]))
      expect(parsed.diagnostics).toEqual([])
      expect(inputsOf(parsed.schema!)[0]).not.toHaveProperty('acceptsStorage')
    }
  })

  it('preserves acceptsStorage recursively on ordinary inputs', () => {
    const parsed = parseDinksterSchemaWire39('Storage', node(39, [{
      role: 'inputFamily',
      id: 'items',
      required: false,
      memberPrefix: 'item',
      template: [ordinaryInput(true)],
    }]))
    expect(parsed.diagnostics).toEqual([])
    const family = inputsOf(parsed.schema!)[0]!
    expect(family.dynamic?.kind).toBe('autogrow')
    if (family.dynamic?.kind !== 'autogrow') throw new Error('expected autogrow input')
    expect(family.dynamic.template[0]).toMatchObject({ acceptsStorage: true })
  })

  it.each([null, 1, 'true'])('rejects malformed acceptsStorage %j', (acceptsStorage) => {
    const parsed = parseDinksterNodes(catalog(39, [ordinaryInput(acceptsStorage)]))
    expect(parsed.schemas.size).toBe(0)
    expect(parsed.diagnostics[0]?.message).toContain('acceptsStorage must be a boolean')
  })

  it.each([false, true])('rejects acceptsStorage %s below wire 39', (acceptsStorage) => {
    const parsed = parseDinksterNodes(catalog(38, [ordinaryInput(acceptsStorage)]))
    expect(parsed.schemas.size).toBe(0)
    expect(parsed.diagnostics[0]?.message).toContain('acceptsStorage requires schema wire 39')
  })

  it('rejects acceptsStorage on structural inputs', () => {
    const parsed = parseDinksterNodes(catalog(39, [{
      role: 'inputFamily', id: 'items', required: false, acceptsStorage: true,
      memberPrefix: 'item', template: [ordinaryInput()],
    }]))
    expect(parsed.schemas.size).toBe(0)
    expect(parsed.diagnostics[0]?.message).toContain('acceptsStorage is only valid on ordinary inputs')
  })

  it('retains widget grammar introduced by earlier wire versions', () => {
    const input = (id: string, type: string, widget: Record<string, unknown>) => ({
      role: 'input', id, type: { kind: 'concrete', types: [type] }, required: true, widget,
    })
    const parsed = parseDinksterSchemaWire39('Widgets', node(39, [
      input('display', 'core.int', { type: 'NUMBER', min: 0, display: 'number' }),
      input('unsafe', 'core.int', { type: 'NUMBER', max: '18446744073709551615' }),
      input('combo', 'core.combo', { type: 'COMBO', options: [{ value: 'auto', label: 'Automatic' }] }),
      {
        role: 'input', id: 'many', required: true,
        type: { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } },
        widget: { type: 'MULTI_COMBO', options: ['one'] },
      },
      input('text', 'core.string', { type: 'STRING', placeholder: 'Prompt' }),
    ]))

    expect(parsed.diagnostics).toEqual([])
    expect(parsed.schema?.items).toHaveLength(5)
  })
})
