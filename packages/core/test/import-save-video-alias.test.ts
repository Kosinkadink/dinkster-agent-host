import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { Json, JsonObject } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { loadDocument } from '../src/format/migrate.js'
import { planReplacement } from '../src/replace/plan.js'
import { comfyAliasCatalogFromDinksterWire } from '../src/schema/comfy-alias.js'
import { parseDinksterNodes } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const aliases = JSON.parse(readFileSync(
  new URL('../fixtures/replacements/save-video-comfy-alias-candidate.json', import.meta.url), 'utf8',
))
const nativeWire = JSON.parse(readFileSync(
  new URL('../fixtures/replacements/save-video-alias-native.json', import.meta.url), 'utf8',
)) as { readonly nodeType: string }[]
const workflowFixture = JSON.parse(readFileSync(
  new URL('../fixtures/replacements/save-video-comfy-workflow.json', import.meta.url), 'utf8',
)) as { readonly nodes: readonly JsonObject[]; readonly links: readonly Json[] }
const native = parseDinksterNodes({
  schemaVersion: 38, nodes: Object.fromEntries(nativeWire.map((schema) => [schema.nodeType, schema])),
})
expect(native.diagnostics).toEqual([])
const nativeSchemas = new Map(native.schemas)
nativeSchemas.set('dinkster.save_video', { ...nativeSchemas.get('dinkster.save_video')!, pack: 'media-io' })
const decoded = comfyAliasCatalogFromDinksterWire({
  schemaVersion: 38,
  packs: { 'media-io': { comfyAliases: aliases } },
}, nativeSchemas)
expect(decoded.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
const catalog = decoded.catalog
const record = catalog.recordsByNodeClass.get('SaveVideo')!
expect(record.source.revision).toBe('15eb748b')

const schemas = new Map([...nativeSchemas, ...catalog.sourceSchemas])
const resolve = (type: string): NodeSchema | undefined => {
  const alias = catalog.recordsByNodeClass.get(type)
  return alias ? catalog.sourceSchemas.get(alias.source.nodeType) : schemas.get(type)
}

interface SaveCase {
  readonly name: string
  readonly widgets: readonly Json[] | JsonObject
  readonly container: string
  readonly codec: string
  readonly crf?: number
  readonly convertedCrf?: number
  readonly values?: JsonObject
  readonly selectors?: Readonly<Record<string, string>>
}

describe('candidate Comfy SaveVideo alias import', () => {
  // Nested streams include the hidden top-level compatibility codec after the active format branch.
  const cases: SaveCase[] = [
    {
      name: 'nested AV1 re-encode with explicit CRF and trailing compatibility codec',
      widgets: ['video/test', 'auto', 'av1', 're-encode', 29.75, 'auto'],
      container: 'webm', codec: 'av1', convertedCrf: 29.75,
      values: { 'format.codec.encoding.crf': 29.75 },
      selectors: { format: 'auto', 'format.codec': 'av1', 'format.codec.encoding': 're-encode', codec: 'auto' },
    },
    {
      name: 'nested AV1 automatic encoding must not consume compatibility codec as CRF',
      widgets: workflowFixture.nodes[0]!.widgets_values as readonly Json[],
      container: 'webm', codec: 'av1',
      selectors: { format: 'auto', 'format.codec': 'av1', 'format.codec.encoding': 'auto', codec: 'auto' },
    },
    {
      name: 'nested AV1 automatic encoding without a compatibility tail',
      widgets: ['video/test', 'auto', 'av1', 'auto'],
      container: 'webm', codec: 'av1',
      selectors: { format: 'auto', 'format.codec': 'av1', 'format.codec.encoding': 'auto' },
    },
    {
      name: 'nested automatic codec must not consume compatibility codec as encoding',
      widgets: ['video/test', 'mp4', 'auto', 'auto'],
      container: 'mp4', codec: 'auto',
      selectors: { format: 'mp4', 'format.codec': 'auto', codec: 'auto' },
    },
    {
      name: 'historical flat three-widget AV1',
      widgets: ['video/test', 'auto', 'av1'], container: 'webm', codec: 'av1',
      selectors: { format: 'auto', 'format.codec': 'av1' },
    },
    {
      name: 'historical flat encoding uses AV1 default CRF',
      widgets: ['video/test', 'auto', 'av1', 're-encode'], container: 'webm', codec: 'av1', crf: 30,
      selectors: { format: 'auto', 'format.codec': 'av1', 'format.codec.encoding': 're-encode' },
    },
    {
      name: 'historical keyed flat CRF control',
      widgets: { filename_prefix: 'video/test', format: 'auto', codec: 'h264', crf: 31.9 },
      container: 'mp4', codec: 'h264', convertedCrf: 31.9,
      values: { crf: 31.9 }, selectors: { format: 'auto', codec: 'h264' },
    },
    {
      name: 'historical keyed compatibility codec with active encoding CRF',
      widgets: {
        filename_prefix: 'video/test', format: 'auto', codec: 'h264',
        'codec.encoding': 're-encode', 'codec.encoding.crf': 31.9,
      },
      container: 'mp4', codec: 'h264', convertedCrf: 31.9,
      values: { 'codec.encoding.crf': 31.9 },
      selectors: { format: 'auto', codec: 'h264', 'codec.encoding': 're-encode' },
    },
    {
      name: 'historical keyed encoding.crf control',
      widgets: { filename_prefix: 'video/test', format: 'auto', codec: 'h264', 'encoding.crf': 31.9 },
      container: 'mp4', codec: 'h264', convertedCrf: 31.9,
      values: { 'encoding.crf': 31.9 }, selectors: { format: 'auto', codec: 'h264' },
    },
    ...(['h264', 'av1'] as const).flatMap((codec): SaveCase[] => [
      {
        name: `historical keyed ${codec} encoding with omitted CRF`,
        widgets: { filename_prefix: 'video/test', codec, encoding: 're-encode' },
        container: codec === 'av1' ? 'webm' : 'mp4', codec, crf: codec === 'av1' ? 30 : 23,
        values: { encoding: 're-encode' }, selectors: { codec },
      },
      {
        name: `nested ${codec} explicit MKV and CRF`,
        widgets: ['video/test', 'mkv', codec, 're-encode', 22.5],
        container: 'mkv', codec, convertedCrf: 22.5,
        values: { 'format.codec.encoding.crf': 22.5 },
        selectors: { format: 'mkv', 'format.codec': codec, 'format.codec.encoding': 're-encode' },
      },
    ]),
  ]

  it.each(cases)('$name', (testCase) => {
    const workflow: JsonObject = {
      ...workflowFixture,
      nodes: [{ ...workflowFixture.nodes[0]!, widgets_values: testCase.widgets }],
    }
    const imported = importLitegraph(workflow, resolve, (type) => catalog.recordsByNodeClass.has(type))
    expect(imported.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    const document = imported.document!
    const source = document.graphs[document.root]!.nodes.n1!
    expect(source.values).toEqual({ filename_prefix: 'video/test', ...testCase.values })
    expect(source.dynamic).toEqual(Object.fromEntries(
      Object.entries(testCase.selectors ?? {}).map(([key, selected]) => [key, { selected }]),
    ))
    expect(imported.diagnostics.filter((item) => [
      'import.dynamic.unknownSelector', 'import.widgets.excess', 'import.widgets.unknownKeys',
    ].includes(item.code))).toEqual([])
    const planned = planReplacement(document, document.root, 'n1', record.replacement, resolve)
    expect(planned.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(planned.diagnostics.filter((item) => item.code === 'replace.value.dropped')).toEqual([])
    expect(planned.plan).toBeDefined()
    const plan = planned.plan!
    expect(plan.values).toMatchObject({ container: testCase.container, codec: testCase.codec })
    expect(plan.values.crf).toBe(testCase.crf)
    expect(plan.createdNodes?.find((node) => node.localId === 'crf_value')?.values.value).toBe(testCase.convertedCrf)
    expect(plan.createdNodes?.find((node) => node.localId === 'save_target')?.values.prefix).toBe('video/test')
    if (testCase.convertedCrf === undefined) {
      expect(plan.createdNodes?.some((node) => node.localId === 'crf')).toBe(false)
    } else {
      expect(plan.createdNodes?.find((node) => node.localId === 'crf')?.values).toEqual({
        target: 'int', force_lossy: true,
      })
    }
    const store = new DocumentStore(document, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json }).ok).toBe(true)
    const graph = store.doc.graphs[document.root]!
    if (testCase.convertedCrf !== undefined) {
      expect(Object.values(graph.links)).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: { node: 'n1:crf_value', port: 'value' }, to: { node: 'n1:crf', port: 'value' } }),
        expect.objectContaining({ from: { node: 'n1:crf', port: 'int' }, to: { node: 'n1', port: 'crf' } }),
      ]))
    }
    const reloaded = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reloaded.diagnostics).toEqual([])
    expect(reloaded.document).toEqual(store.doc)
    expect(reloaded.document!.graphs[document.root]!.nodes['n1:crf_value']?.values.value).toBe(testCase.convertedCrf)
    expect(store.undo()).toBe(true)
    // Undo restores graph data but retains the monotonic allocation cursor.
    expect(store.doc).toEqual({
      ...document,
      graphs: { ...document.graphs, [document.root]: {
        ...document.graphs[document.root],
        nextOrdinal: reloaded.document!.graphs[document.root]!.nextOrdinal,
      } },
    })
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(reloaded.document)
  })

  it('keeps CRF under an inactive keyed encoding branch raw for review', () => {
    const imported = importLitegraph({
      ...workflowFixture,
      nodes: [{ ...workflowFixture.nodes[0]!, widgets_values: {
        filename_prefix: 'video/test', format: 'auto', codec: 'h264', 'codec.encoding.crf': 31.9,
      } }],
    }, resolve, (type) => catalog.recordsByNodeClass.has(type))
    expect(imported.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(imported.diagnostics).toContainEqual(expect.objectContaining({ code: 'import.widgets.unknownKeys' }))
    const source = imported.document!.graphs[imported.document!.root]!.nodes.n1!
    expect(source.values).toEqual({ filename_prefix: 'video/test' })
    expect(source.ext?.['importer.unknownWidgetValues']).toEqual({ 'codec.encoding.crf': 31.9 })
  })

  it('routes a linked CRF through Float and Convert while preserving VIDEO input and output', () => {
    const imported = importLitegraph({
      nodes: [
        {
          ...workflowFixture.nodes[0]!,
          inputs: [
            { name: 'video', type: 'VIDEO', link: 1 },
            { name: 'format.codec.encoding.crf', type: 'FLOAT', link: 3 },
          ],
          outputs: [{ name: 'video', type: 'VIDEO', links: [2] }],
          widgets_values: {
            filename_prefix: 'video/test', format: 'webm',
            'format.codec': 'av1', 'format.codec.encoding': 're-encode',
          },
        },
        {
          id: 2, type: 'dinkster.save_video', pos: [0, 0],
          outputs: [{ name: 'video', type: 'VIDEO', links: [1] }],
        },
        {
          id: 3, type: 'dinkster.save_video', pos: [0, 0],
          inputs: [{ name: 'video', type: 'VIDEO', link: 2 }],
        },
        {
          id: 4, type: 'dinkster.float', pos: [0, 0], widgets_values: [28.5],
          outputs: [{ name: 'value', type: 'FLOAT', links: [3] }],
        },
      ],
      links: [[1, 2, 0, 1, 0, 'VIDEO'], [2, 1, 0, 3, 0, 'VIDEO'], [3, 4, 0, 1, 1, 'FLOAT']],
    }, resolve, (type) => catalog.recordsByNodeClass.has(type))
    expect(imported.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    const document = imported.document!
    const planned = planReplacement(document, document.root, 'n1', record.replacement, resolve)
    expect(planned.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(planned.plan?.values).toMatchObject({ container: 'webm', codec: 'av1' })
    const store = new DocumentStore(document, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok).toBe(true)
    expect(Object.values(store.doc.graphs[document.root]!.links)).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: { node: 'n2', port: 'video' }, to: { node: 'n1', port: 'video' } }),
      expect.objectContaining({ from: { node: 'n1', port: 'video' }, to: { node: 'n3', port: 'video' } }),
      expect.objectContaining({ from: { node: 'n4', port: 'value' }, to: { node: 'n1:crf_value', port: 'value' } }),
      expect.objectContaining({ from: { node: 'n1:crf_value', port: 'value' }, to: { node: 'n1:crf', port: 'value' } }),
      expect.objectContaining({ from: { node: 'n1:crf', port: 'int' }, to: { node: 'n1', port: 'crf' } }),
    ]))
  })
})
