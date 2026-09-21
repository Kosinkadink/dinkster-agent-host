import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  packsFromDinksterWire,
  parseDinksterSchemaWire44,
} from '../src/schema/dinkster-wire.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

describe('schema wire 44 pack locale catalogs', () => {
  it('advertises wire 44 while retaining wire 43 as accepted but not generally advertised', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.slice(-3)).toEqual([42, 43, 44])
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.slice(-3)).toEqual([41, 42, 44])
  })

  it('keeps the wire 43 node grammar unchanged', () => {
    const result = parseDinksterSchemaWire44('demo.node', {
      schemaVersion: 44,
      displayName: 'Demo',
      interface: [],
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.displayName).toBe('Demo')
  })

  it('decodes only canonical locale and digest pairs selected on wire 44', () => {
    const packs = {
      demo: {
        displayName: 'Demo',
        locales: {
          en: digest('a'),
          'pt-br': digest('b'),
          'EN-us': digest('c'),
          'pt_BR': digest('d'),
          fr: 'sha256:ABC',
          de: 42,
        },
      },
    }
    expect(packsFromDinksterWire({ schemaVersion: 44, nodes: {}, packs }).get('demo')?.locales).toEqual({
      en: digest('a'),
      'pt-br': digest('b'),
    })
    expect(packsFromDinksterWire({ schemaVersion: 43, nodes: {}, packs }).get('demo')?.locales).toBeUndefined()
    expect(packsFromDinksterWire({
      schemaVersion: 1,
      dinkster: { version: 'test', schemaWire: 43 },
      nodes: {},
      packs,
    }).get('demo')?.locales).toBeUndefined()
  })
})
