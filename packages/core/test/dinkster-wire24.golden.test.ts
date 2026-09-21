/**
 * Schema wire 24: the additive "emitsPreviews" capability hint. Like
 * "outputNode" it is a top-level additive field - decoded whenever present
 * (backends only emit it at wire >= 24), true-only, omitted when false.
 */
import { describe, expect, it } from 'vitest'
import { inputsOf } from '../src/schema/model.js'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
} from '../src/schema/dinkster-wire.js'

const decode = (wire: number, node: Record<string, unknown>) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: {
    Sampler: {
      schemaVersion: wire,
      displayName: 'Sampler',
      idempotent: true,
      interface: [],
      ...node,
    },
  },
})

describe('schema wire 24 emitsPreviews capability hint', () => {
  it('advertises wire 24', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
  })

  it('decodes emitsPreviews: true into the schema', () => {
    const result = decode(24, { emitsPreviews: true })
    expect(result.diagnostics).toEqual([])
    expect(result.schemas.get('Sampler')!.emitsPreviews).toBe(true)
  })

  it('omits the flag when absent', () => {
    const result = decode(24, {})
    expect(result.diagnostics).toEqual([])
    const schema = result.schemas.get('Sampler')!
    expect(schema.emitsPreviews).toBeUndefined()
    expect('emitsPreviews' in schema).toBe(false)
  })

  it.each([false, 1, 'yes', null])('ignores non-true value %j', (value) => {
    const result = decode(24, { emitsPreviews: value })
    expect(result.diagnostics).toEqual([])
    expect(result.schemas.get('Sampler')!.emitsPreviews).toBeUndefined()
  })

  it('stays additive: decoded on older wires when a backend sends it', () => {
    const result = decode(22, { emitsPreviews: true })
    expect(result.diagnostics).toEqual([])
    expect(result.schemas.get('Sampler')!.emitsPreviews).toBe(true)
  })
})

// Wire 24 must keep the full wire-23 interface grammar: a live wire-24
// payload once fell through to the flat legacy decoder, which dropped
// structured combo options and the advanced flag and threw on NUMBER
// display, so sampler combos rendered as bare inputs.
describe('schema wire 24 keeps the wire-23 interface grammar', () => {
  const decodeInterface = (entries: Record<string, unknown>[]) => parseDinksterNodes({
    schemaVersion: 24,
    nodes: {
      Sampler: {
        schemaVersion: 24,
        displayName: 'Sampler',
        idempotent: true,
        emitsPreviews: true,
        interface: entries,
      },
    },
  })

  it.each(['COMBO', 'MULTI_COMBO'])('decodes structured %s choices', (type) => {
    const result = decodeInterface([{
      role: 'input',
      id: 'sampler_name',
      type: type === 'MULTI_COMBO'
        ? { kind: 'list', element: { kind: 'concrete', types: ['core.combo'] } }
        : { kind: 'concrete', types: ['core.combo'] },
      required: true,
      default: type === 'MULTI_COMBO' ? ['dinkster.euler'] : 'dinkster.euler',
      widget: {
        type,
        options: [
          'dinkster.plain',
          { value: 'dinkster.euler', label: 'euler' },
          { value: 'dinkster.uni_pc', label: 'UniPC', info: 'Predictor-corrector sampler', folder: 'Solvers/ODE' },
        ],
      },
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Sampler')!)[0]!
    expect(input.widget?.options['options']).toEqual([
      'dinkster.plain',
      { value: 'dinkster.euler', label: 'euler' },
      { value: 'dinkster.uni_pc', label: 'UniPC', info: 'Predictor-corrector sampler', folder: 'Solvers/ODE' },
    ])
  })

  it('decodes the advanced input flag', () => {
    const result = decodeInterface([{
      role: 'input',
      id: 'dual_cfg_style',
      type: { kind: 'concrete', types: ['core.combo'] },
      required: false,
      advanced: true,
      widget: { type: 'COMBO', options: ['off', 'split'] },
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Sampler')!)[0]!
    expect(input.advanced).toBe(true)
  })

  it('decodes identically to wire 23 apart from emitsPreviews', () => {
    // The full dynamic grammar rides in the parity fixture: a live wire bump
    // must never decode dynamic entries differently from the previous wire.
    const iface = [
      {
        role: 'input',
        id: 'sampler_name',
        type: { kind: 'concrete', types: ['core.combo'] },
        required: true,
        default: 'dinkster.euler',
        widget: { type: 'COMBO', options: ['dinkster.plain', { value: 'dinkster.euler', label: 'euler' }] },
      },
      {
        role: 'input',
        id: 'cfg',
        type: { kind: 'concrete', types: ['core.float'] },
        required: true,
        default: 8,
        widget: { type: 'NUMBER', min: 0, max: 100, step: 0.1, display: 'slider' },
      },
      {
        role: 'input',
        id: 'dual_cfg_style',
        type: { kind: 'concrete', types: ['core.combo'] },
        required: false,
        advanced: true,
        widget: { type: 'COMBO', options: ['off', 'split'] },
      },
      {
        role: 'input',
        id: 'latent_file',
        type: { kind: 'asset', element: { kind: 'concrete', types: ['comfy.LATENT'] } },
        required: true,
        widget: { type: 'ASSET', accept: ['application/x-comfy-latent'], kind: 'data/latent', allowUpload: true },
        sourceFilename: { kind: 'data/latent', category: 'input' },
      },
      {
        role: 'inputFamily',
        id: 'images',
        template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, required: false }],
        memberPrefix: 'image',
        minMembers: 1,
        maxMembers: 8,
        required: false,
      },
      {
        role: 'inputFamily',
        id: 'items',
        template: [{ role: 'input', id: 'value', type: { kind: 'variable', templateId: 'T' }, required: false }],
        minMembers: 1,
        required: false,
      },
      {
        role: 'dynamicCombo',
        id: 'format',
        required: true,
        options: [
          { key: 'png', inputs: [{ role: 'input', id: 'bit_depth', type: { kind: 'concrete', types: ['core.int'] }, required: false, default: 8 }] },
          { key: 'webp', inputs: [] },
        ],
      },
      {
        role: 'dynamicSlot',
        id: 'source',
        required: true,
        variants: [
          { key: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, inputs: [] },
          {
            key: 'video',
            type: { kind: 'concrete', types: ['comfy.VIDEO'] },
            inputs: [{ role: 'input', id: 'frame_rate', type: { kind: 'concrete', types: ['core.float'] }, required: false, default: 24 }],
          },
        ],
      },
      { role: 'output', id: 'latent', type: { kind: 'concrete', types: ['core.latent'] } },
      { role: 'outputFamily', id: 'parts', type: { kind: 'concrete', types: ['core.string'] }, minMembers: 1 },
    ]
    const at = (wire: number) => parseDinksterNodes({
      schemaVersion: wire,
      nodes: { Sampler: { schemaVersion: wire, displayName: 'Sampler', idempotent: true, interface: iface } },
    })
    const r23 = at(23)
    const r24 = at(24)
    expect(r23.diagnostics).toEqual([])
    expect(r24.diagnostics).toEqual([])
    expect(r24.schemas.get('Sampler')).toEqual(r23.schemas.get('Sampler'))
  })

  it('decodes a prefix-less input family into family-id prefix naming', () => {
    const result = decodeInterface([{
      role: 'inputFamily',
      id: 'items',
      template: [{ role: 'input', id: 'value', type: { kind: 'variable', templateId: 'T' }, required: false }],
      minMembers: 1,
      required: false,
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Sampler')!)[0]!
    expect(input.dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'items', min: 1 },
    })
  })

  it('accepts the data/latent sourceFilename kind', () => {
    const result = decodeInterface([{
      role: 'input',
      id: 'latent_file',
      type: { kind: 'asset', element: { kind: 'concrete', types: ['comfy.LATENT'] } },
      required: true,
      widget: { type: 'ASSET', accept: ['application/x-comfy-latent'], kind: 'data/latent', allowUpload: true },
      sourceFilename: { kind: 'data/latent', category: 'input' },
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Sampler')!)[0]!
    expect(input.sourceFilename).toEqual({ kind: 'data/latent', category: 'input' })
  })

  it('decodes NUMBER display presentation', () => {
    const result = decodeInterface([{
      role: 'input',
      id: 'cfg',
      type: { kind: 'concrete', types: ['core.float'] },
      required: true,
      default: 8,
      widget: { type: 'NUMBER', min: 0, max: 100, step: 0.1, display: 'slider' },
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Sampler')!)[0]!
    expect(input.widget?.options['display']).toBe('slider')
  })
})
