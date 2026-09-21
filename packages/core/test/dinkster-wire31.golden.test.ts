import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  parseDinksterNodes,
  parseDinksterSchemaWire31,
} from '../src/schema/dinkster-wire.js'
import { outputsOf } from '../src/schema/model.js'

const imageType = { kind: 'concrete', types: ['dinkster.image'] }
const assetType = { kind: 'asset', element: imageType }
const represents = {
  input: 'image',
  rendition: 'decoded-image',
  applies: { mode: ['load'] },
}

const schema = (wire: number, declaration?: unknown) => ({
  schemaVersion: wire,
  interface: [
    {
      role: 'input',
      id: 'image',
      required: true,
      type: assetType,
      widget: { type: 'ASSET', accept: ['image/png'] },
    },
    {
      role: 'dynamicCombo',
      id: 'mode',
      options: [{ key: 'load', inputs: [] }, { key: 'mask', inputs: [] }],
      default: 'load',
    },
    {
      role: 'output',
      id: 'image',
      type: imageType,
      ...(declaration === undefined ? {} : { represents: declaration }),
    },
  ],
})

const decode = (wire: number, declaration: unknown = represents) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: { LoadImage: schema(wire, declaration) },
})

describe('schema wire 31 output representations', () => {
  it('accepts and advertises wire 31', () => {
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(31)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS).toContain(31)
  })

  it.each([31, 32])('decodes the declaration on wire %i', (wire) => {
    const result = decode(wire)
    expect(result.diagnostics).toEqual([])
    expect(outputsOf(result.schemas.get('LoadImage')!)[0]?.represents).toEqual(represents)
  })

  it('exports the direct wire-31 decoder', () => {
    expect(outputsOf(parseDinksterSchemaWire31('LoadImage', schema(31, represents)).schema!)[0]?.represents).toEqual(represents)
  })

  it('retains established widget decoding on wire 31', () => {
    const result = parseDinksterNodes({
      schemaVersion: 31,
      nodes: {
        Widgets: {
          schemaVersion: 31,
          interface: [
            {
              role: 'input', id: 'amount', required: true,
              type: { kind: 'concrete', types: ['core.float'] },
              widget: { type: 'NUMBER', display: 'slider' },
            },
            {
              role: 'input', id: 'choice', required: true,
              type: { kind: 'concrete', types: ['core.combo'] },
              widget: { type: 'COMBO', options: [{ value: 'a', label: 'Choice A' }] },
            },
            {
              role: 'input', id: 'choices', required: true,
              type: { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } },
              widget: { type: 'MULTI_COMBO', options: ['a'] },
            },
          ],
        },
      },
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schemas.get('Widgets')?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'amount', widget: expect.objectContaining({ options: { display: 'slider' } }) }),
      expect.objectContaining({ id: 'choice', widget: expect.objectContaining({ options: { options: [{ value: 'a', label: 'Choice A' }] } }) }),
      expect.objectContaining({ id: 'choices', widget: expect.objectContaining({ widgetType: 'MULTI_COMBO' }) }),
    ]))
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((wire) => wire < 31))(
    'rejects a declaration mislabeled as wire %i',
    (wire) => {
      const result = decode(wire)
      expect(result.schemas.size).toBe(0)
      expect(result.diagnostics.some((diag) => diag.message.includes('output.represents requires schema wire 31'))).toBe(true)
    },
  )

  it.each([
    null,
    [],
    'image',
    7,
    {},
    { input: '', rendition: 'decoded-image' },
    { input: 'image', rendition: '' },
    { input: 'image', rendition: 'decoded-image', surprise: true },
    { input: 'image', rendition: 'decoded-image', applies: {} },
    { input: 'image', rendition: 'decoded-image', applies: { mode: [] } },
    { input: 'image', rendition: 'decoded-image', applies: { mode: ['load', 'load'] } },
  ])('fails closed for malformed declarations %#', (declaration) => {
    expect(decode(31, declaration).schemas.size).toBe(0)
  })

  it('keeps the declaration optional', () => {
    const result = parseDinksterNodes({ schemaVersion: 31, nodes: { LoadImage: schema(31) } })
    expect(outputsOf(result.schemas.get('LoadImage')!)[0]?.represents).toBeUndefined()
  })
})
