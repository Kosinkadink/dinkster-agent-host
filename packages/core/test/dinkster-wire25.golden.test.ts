/**
 * Schema wire 25: the media/model3d sourceFilename kind. Wire 25 keeps the
 * full wire-24 grammar and widens exactly one closed set: sourceFilename.kind
 * accepts 'media/model3d' so a node can declare an upload-enabled 3D model
 * (GLB) asset input. Older wires stay frozen: the same declaration must fail
 * a wire <= 24 decode so a backend serving it below 25 is a contract bug.
 */
import { describe, expect, it } from 'vitest'
import { inputsOf } from '../src/schema/model.js'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
} from '../src/schema/dinkster-wire.js'

const decodeInterface = (wire: number, entries: Record<string, unknown>[]) => parseDinksterNodes({
  schemaVersion: wire,
  nodes: {
    Load3D: {
      schemaVersion: wire,
      displayName: 'Load 3D',
      idempotent: true,
      interface: entries,
    },
  },
})

const model3dInput = {
  role: 'input',
  id: 'model_file',
  type: { kind: 'asset', element: { kind: 'concrete', types: ['dinkster.model3d'] } },
  required: true,
  widget: { type: 'ASSET', accept: ['model/gltf-binary'], kind: 'media/model3d', allowUpload: true },
  sourceFilename: { kind: 'media/model3d', category: 'input' },
}

describe('schema wire 25 media/model3d source filename kind', () => {
  it('advertises wire 25', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(DINKSTER_ADVERTISED_WIRE_VERSIONS.at(-1)).toBe(44)
  })

  it('decodes a media/model3d upload binding at wire 25', () => {
    const result = decodeInterface(25, [model3dInput])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Load3D')!)[0]!
    expect(input.sourceFilename).toEqual({ kind: 'media/model3d', category: 'input' })
    expect(input.widget).toMatchObject({ widgetType: 'ASSET', kind: 'media/model3d', allowUpload: true })
  })

  it.each([22, 23, 24])('rejects the media/model3d kind at frozen wire %d', (wire) => {
    const result = decodeInterface(wire, [model3dInput])
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', code: 'schema.parse.threw' })
    expect(result.diagnostics[0]!.message).toContain('sourceFilename.kind is invalid')
  })

  it('decodes the binding at the current advertised version', () => {
    // Rides the moving version pin so a future bump cannot leave the new
    // grammar exercised only at a frozen literal.
    const result = decodeInterface(DINKSTER_SCHEMA_WIRE_VERSION, [model3dInput])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Load3D')!)[0]!
    expect(input.sourceFilename).toEqual({ kind: 'media/model3d', category: 'input' })
  })

  it('decodes a media/model3d binding nested in a dynamic slot variant', () => {
    const slot = {
      role: 'dynamicSlot',
      id: 'source',
      required: true,
      variants: [
        {
          key: 'file',
          type: { kind: 'concrete', types: ['dinkster.model3d'] },
          inputs: [model3dInput],
        },
      ],
    }
    const at25 = decodeInterface(25, [slot])
    expect(at25.diagnostics).toEqual([])
    expect(at25.schemas.size).toBe(1)
    const at24 = decodeInterface(24, [slot])
    expect(at24.schemas.size).toBe(0)
    expect(at24.diagnostics[0]!.message).toContain('sourceFilename.kind is invalid')
  })

  it.each([
    ['media/image', 'comfy.IMAGE', 'image/png'],
    ['media/audio', 'comfy.AUDIO', 'audio/wav'],
    ['media/video', 'comfy.VIDEO', 'video/mp4'],
    ['data/latent', 'comfy.LATENT', 'application/x-comfy-latent'],
  ])('keeps the %s kind decoding at wire 25', (kind, atom, mime) => {
    const result = decodeInterface(25, [{
      role: 'input',
      id: 'file',
      type: { kind: 'asset', element: { kind: 'concrete', types: [atom] } },
      required: true,
      widget: { type: 'ASSET', accept: [mime], kind, allowUpload: true },
      sourceFilename: { kind, category: 'input' },
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Load3D')!)[0]!
    expect(input.sourceFilename).toEqual({ kind, category: 'input' })
  })

  it('still requires a matching upload-enabled ASSET widget', () => {
    const result = decodeInterface(25, [{
      ...model3dInput,
      widget: { type: 'ASSET', accept: ['model/gltf-binary'], kind: 'media/image', allowUpload: true },
    }])
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics[0]!.message).toContain('matching upload-enabled ASSET widget')
  })

  it('decodes the emitsPreviews capability hint at wire 25', () => {
    const result = parseDinksterNodes({
      schemaVersion: 25,
      nodes: {
        Sampler: { schemaVersion: 25, displayName: 'Sampler', idempotent: true, interface: [], emitsPreviews: true },
      },
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schemas.get('Sampler')!.emitsPreviews).toBe(true)
  })
})

// Wire 25 must keep the full wire-24 interface grammar: a wire bump once
// fell through the version dispatch to the flat legacy decoder and dropped
// structured combos, the advanced flag, and every dynamic entry, so the
// parity fixture rides the whole grammar.
describe('schema wire 25 keeps the wire-24 interface grammar', () => {
  it('decodes identically to wire 24 apart from media/model3d', () => {
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
      nodes: { Sampler: { schemaVersion: wire, displayName: 'Sampler', idempotent: true, emitsPreviews: true, interface: iface } },
    })
    const r24 = at(24)
    const r25 = at(25)
    expect(r24.diagnostics).toEqual([])
    expect(r25.diagnostics).toEqual([])
    expect(r25.schemas.get('Sampler')).toEqual(r24.schemas.get('Sampler'))
  })

  it.each(['COMBO', 'MULTI_COMBO'])('decodes structured %s choices', (type) => {
    const result = decodeInterface(25, [{
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
    const input = inputsOf(result.schemas.get('Load3D')!)[0]!
    expect(input.widget?.options['options']).toEqual([
      'dinkster.plain',
      { value: 'dinkster.euler', label: 'euler' },
      { value: 'dinkster.uni_pc', label: 'UniPC', info: 'Predictor-corrector sampler', folder: 'Solvers/ODE' },
    ])
  })

  it('decodes the advanced input flag', () => {
    const result = decodeInterface(25, [{
      role: 'input',
      id: 'noise_mode',
      type: { kind: 'concrete', types: ['core.combo'] },
      required: false,
      advanced: true,
      widget: { type: 'COMBO', options: ['off', 'split'] },
    }])
    expect(result.diagnostics).toEqual([])
    const input = inputsOf(result.schemas.get('Load3D')!)[0]!
    expect(input.advanced).toBe(true)
  })
})
