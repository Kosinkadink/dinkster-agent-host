import { describe, expect, it } from 'vitest'
import { inputsOf } from '../src/schema/model.js'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
} from '../src/schema/dinkster-wire.js'

const sourceSchema = (schemaVersion: number, overrides: Record<string, unknown> = {}) => ({
  schemaVersion,
  interface: [{
    role: 'input',
    id: 'source',
    type: { kind: 'concrete', types: ['dinkster.asset'] },
    required: true,
    widget: {
      type: 'ASSET',
      accept: ['image/png', 'image/*'],
      kind: 'media/image',
      allowUpload: true,
    },
    sourceFilename: { kind: 'media/image', category: 'input' },
    ...overrides,
  }],
})

const decode = (schemaVersion: number, overrides: Record<string, unknown> = {}) => parseDinksterNodes({
  schemaVersion,
  nodes: { source: sourceSchema(schemaVersion, overrides) },
})

describe('schema wire 22 source filename contract', () => {
  it('keeps wire 22 available in the strict 21/22/23/24 decode window', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
  })

  it('decodes the exact source binding and upload presentation on wire 22', () => {
    const result = decode(22)
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('source')!)[0]!
    expect(input.sourceFilename).toEqual({ kind: 'media/image', category: 'input' })
    expect(input.widget).toEqual({
      widgetType: 'ASSET',
      options: { accept: ['image/png', 'image/*'] },
      kind: 'media/image',
      allowUpload: true,
    })
  })

  it.each([
    ['unknown source field', { sourceFilename: { kind: 'media/image', category: 'input', path: 'x' } }],
    ['invalid source kind', { sourceFilename: { kind: 'media/mesh', category: 'input' } }],
    ['invalid source category', { sourceFilename: { kind: 'media/image', category: 'preview' } }],
    ['non-boolean upload flag', { widget: { type: 'ASSET', accept: [], kind: 'media/image', allowUpload: 1 } }],
    ['mismatched widget kind', { widget: { type: 'ASSET', accept: [], kind: 'media/audio', allowUpload: true } }],
  ])('rejects %s', (_name, overrides) => {
    const result = decode(22, overrides)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((entry) => entry.severity === 'error')).toBe(true)
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((wire) => wire < 22))('keeps wire %s frozen against wire-22 input and widget keys', (wire) => {
    const result = decode(wire)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((entry) => entry.severity === 'error')).toBe(true)
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((wire) => wire < 22))('keeps wire %s frozen against allowUpload false', (wire) => {
    const result = decode(wire, {
      sourceFilename: undefined,
      widget: { type: 'ASSET', accept: [], kind: 'media/image', allowUpload: false },
    })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((entry) => entry.severity === 'error')).toBe(true)
  })

  it.each([
    ['default upload representation with a binding', {
      widget: {
        type: 'REPRESENTATIONS', default: 'upload', userSwitchable: true,
        representations: [{ id: 'upload', widget: {
          type: 'ASSET', accept: ['image/*'], kind: 'media/image', allowUpload: true,
        } }],
      },
    }],
    ['non-default upload representation without a binding', {
      sourceFilename: undefined,
      widget: {
        type: 'REPRESENTATIONS', default: 'plain', userSwitchable: true,
        representations: [
          { id: 'plain', widget: { type: 'ASSET', accept: ['image/*'], kind: 'media/image' } },
          { id: 'upload', widget: { type: 'ASSET', accept: ['image/*'], kind: 'media/image', allowUpload: true } },
        ],
      },
    }],
  ])('rejects representations bypass: %s', (_name, overrides) => {
    const result = decode(22, overrides)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics.some((entry) => entry.severity === 'error')).toBe(true)
  })

  it('preserves structural list<dinkster.asset> source inputs', () => {
    const result = decode(22, {
      type: { kind: 'list', element: { kind: 'concrete', types: ['dinkster.asset'] } },
    })
    const input = inputsOf(result.schemas.get('source')!)[0]!
    expect(input.type).toEqual({ kind: 'list', element: { kind: 'concrete', name: 'dinkster.asset' } })
    expect(input.sourceFilename).toEqual({ kind: 'media/image', category: 'input' })
  })
})
