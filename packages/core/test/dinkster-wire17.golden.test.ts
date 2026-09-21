import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire16,
  type DinksterNodesPayload,
  type DinksterWireSchema,
} from '../src/schema/dinkster-wire.js'
import { inputsOf, resolveWidgetRepresentation } from '../src/schema/model.js'

const here = dirname(fileURLToPath(import.meta.url))
const liveGolden = JSON.parse(
  readFileSync(join(here, '../fixtures/dinkster-widget-representations-wire17.json'), 'utf8'),
) as DinksterNodesPayload

const representationWire = (): Record<string, unknown> => structuredClone(
  ((liveGolden.nodes as Record<string, DinksterWireSchema>)['dinkster.clip_text_encode']!.interface as Record<string, unknown>[])[0]!,
)

const decodeEntryMutated = (mutate: (entry: Record<string, unknown>) => void) => {
  const entry = representationWire()
  mutate(entry)
  return parseDinksterNodes({
    schemaVersion: 17,
    nodes: {
      'test.widget': {
        schemaVersion: 17,
        interface: [entry],
      },
    },
  })
}

const decodeMutated = (mutate: (widget: Record<string, unknown>) => void) =>
  decodeEntryMutated((entry) => mutate(entry['widget'] as Record<string, unknown>))

describe('schema wire 17 widget representations', () => {
  it('decodes the exact deployed CLIP Text Encode row and resolves default, explicit, and stale choices', () => {
    const result = parseDinksterNodes(liveGolden)
    expect(result.diagnostics).toEqual([])
    const schema = result.schemas.get('dinkster.clip_text_encode')!
    const text = inputsOf(schema).find((input) => input.id === 'text')!
    expect(text.widget).toEqual({
      widgetType: 'STRING',
      options: { multiline: true },
      representations: {
        default: 'multiline',
        userSwitchable: true,
        representations: [
          {
            id: 'single-line',
            displayName: 'Single line',
            widget: { widgetType: 'STRING', options: { multiline: false } },
          },
          {
            id: 'multiline',
            displayName: 'Multiline',
            widget: { widgetType: 'STRING', options: { multiline: true } },
          },
        ],
      },
    })
    expect(resolveWidgetRepresentation(text.widget!)).toMatchObject({
      id: 'multiline', spec: { options: { multiline: true } },
    })
    expect(resolveWidgetRepresentation(text.widget!, 'single-line')).toMatchObject({
      id: 'single-line', spec: { options: { multiline: false } },
    })
    expect(resolveWidgetRepresentation(text.widget!, 'temporarily-missing')).toMatchObject({
      id: 'multiline', spec: { options: { multiline: true } },
    })
  })

  it('retains the strict wire 17 decoder after the wire 19 advertisement bump', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    const downlevel = parseDinksterSchemaWire16('test.downlevel', {
      schemaVersion: 16,
      interface: [{
        role: 'input', id: 'text', required: true,
        type: { kind: 'concrete', types: ['core.string'] },
        widget: { type: 'STRING', multiline: true },
      }],
    })
    expect(downlevel.diagnostics).toEqual([])
    expect(inputsOf(downlevel.schema!)[0]!.widget).toEqual({
      widgetType: 'STRING', options: { multiline: true },
    })
  })

  it.each([
    ['unknown wrapper field', (widget: Record<string, unknown>) => { widget['future'] = true }],
    ['empty alternatives', (widget: Record<string, unknown>) => { widget['representations'] = [] }],
    ['non-Boolean switchability', (widget: Record<string, unknown>) => { widget['userSwitchable'] = 1 }],
    ['missing default target', (widget: Record<string, unknown>) => { widget['default'] = 'missing' }],
    ['duplicate ids', (widget: Record<string, unknown>) => {
      const alternatives = widget['representations'] as Record<string, unknown>[]
      alternatives[1]!['id'] = alternatives[0]!['id']
    }],
    ['invalid id', (widget: Record<string, unknown>) => {
      const alternatives = widget['representations'] as Record<string, unknown>[]
      alternatives[0]!['id'] = 'single line'
    }],
    ['unknown descriptor field', (widget: Record<string, unknown>) => {
      const alternatives = widget['representations'] as Record<string, unknown>[]
      ;(alternatives[0]!['widget'] as Record<string, unknown>)['future'] = true
    }],
    ['nested alternatives', (widget: Record<string, unknown>) => {
      const alternatives = widget['representations'] as Record<string, unknown>[]
      alternatives[0]!['widget'] = structuredClone(widget)
    }],
    ['mixed value domains', (widget: Record<string, unknown>) => {
      const alternatives = widget['representations'] as Record<string, unknown>[]
      alternatives[0]!['widget'] = { type: 'NUMBER' }
    }],
  ])('refuses malformed %s wrappers as a whole schema', (_label, mutate) => {
    const result = decodeMutated(mutate)
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })

  it.each([
    ['asset media type', 'dinkster.asset', { type: 'ASSET', accept: [''], kind: 'model/checkpoint' }],
    ['asset kind', 'dinkster.asset', { type: 'ASSET', accept: [], kind: '-model/checkpoint' }],
    ['save suffix', 'dinkster.save_target', { type: 'SAVE_TARGET', suffix: '../png' }],
    ['empty combo', 'core.combo', { type: 'COMBO', options: [] }],
    ['label-less boolean', 'core.boolean', { type: 'BOOLEAN' }],
    ['constraint-less number', 'core.float', { type: 'NUMBER' }],
    ['nonpositive number step', 'core.float', { type: 'NUMBER', step: 0 }],
    ['inverted number bounds', 'core.float', { type: 'NUMBER', min: 2, max: 1 }],
  ])('refuses a malformed %s descriptor inside a representation set', (_label, socket, descriptor) => {
    const result = decodeEntryMutated((entry) => {
      entry['type'] = { kind: 'concrete', types: [socket] }
      const wrapper = entry['widget'] as Record<string, unknown>
      for (const representation of wrapper['representations'] as Record<string, unknown>[]) {
        representation['widget'] = descriptor
      }
    })
    expect(result.schemas.size).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })

  it('accepts a remote-only combo but refuses an asset picker on a list input', () => {
    const combo = decodeEntryMutated((entry) => {
      entry['type'] = { kind: 'concrete', types: ['core.combo'] }
      const wrapper = entry['widget'] as Record<string, unknown>
      for (const representation of wrapper['representations'] as Record<string, unknown>[]) {
        representation['widget'] = { type: 'COMBO', options: [], remote: { route: '/api/choices/test' } }
      }
    })
    expect(combo.diagnostics).toEqual([])
    expect(combo.schemas.size).toBe(1)

    const listAsset = decodeEntryMutated((entry) => {
      entry['type'] = { kind: 'list', element: { kind: 'concrete', types: ['core.string'] } }
      const wrapper = entry['widget'] as Record<string, unknown>
      for (const representation of wrapper['representations'] as Record<string, unknown>[]) {
        representation['widget'] = { type: 'ASSET', accept: [], kind: 'model/checkpoint' }
      }
    })
    expect(listAsset.schemas.size).toBe(0)
    expect(listAsset.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })

  it('keeps representation selection out of values, prompt, and semantic identity', () => {
    const parsed = parseDinksterNodes({
      schemaVersion: 17,
      nodes: {
        'test.output': {
          schemaVersion: 17,
          outputNode: true,
          interface: [representationWire()],
        },
      },
    })
    expect(parsed.diagnostics).toEqual([])
    const base = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire17-proof', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: { n0: { id: 'n0', type: 'test.output', values: { text: 'same value' } } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      meta: {},
    }
    const documents = ['single-line', 'multiline'].map((representation) => ({
      ...base,
      view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 }, views: { text: representation } } } } } },
    })) as unknown as WorkflowDocument[]
    const results = documents.map((document) => compile({
      document,
      revision: 1,
      resolve: (type) => parsed.schemas.get(type),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'wire17-proof',
    }))
    expect(results.every((result) => result.ok)).toBe(true)
    expect(semanticHashOf(documents[0]!)).toBe(semanticHashOf(documents[1]!))
    if (results[0]!.ok && results[1]!.ok) {
      expect(results[0]!.artifact.prompt).toEqual(results[1]!.artifact.prompt)
      expect(results[0]!.artifact.semanticHash).toBe(results[1]!.artifact.semanticHash)
      expect(results[0]!.artifact.prompt).toEqual({
        n0: { class_type: 'test.output', inputs: { text: 'same value' }, outputIds: [] },
      })
    }
  })
})
