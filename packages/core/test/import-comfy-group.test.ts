import { describe, expect, it } from 'vitest'
import type { Json, JsonObject } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import type { ComfyGroupCatalog, ComfyGroupRecord } from '../src/schema/comfy-group.js'
import type { InputSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

const scalar = { kind: 'concrete', name: 'core.float' } as const
const integer = { kind: 'concrete', name: 'core.int' } as const
const text = { kind: 'concrete', name: 'core.string' } as const
const image = { kind: 'concrete', name: 'comfy.IMAGE' } as const
const socket = (id: string, type: InputSpec['type'] = scalar, optional = false): InputSpec => ({
  kind: 'input', id, type, optional,
})
const numberWidget = (
  id: string,
  defaultValue: number,
  type: InputSpec['type'] = scalar,
  controller = false,
): InputSpec => ({
  kind: 'input',
  id,
  type,
  optional: false,
  widget: {
    widgetType: 'FLOAT',
    options: {},
    default: defaultValue,
    ...(controller ? { controller: 'after_generate' as const } : {}),
  },
})
const choiceWidget = (id: string, defaultValue: string): InputSpec => ({
  kind: 'input',
  id,
  type: text,
  optional: false,
  widget: { widgetType: 'COMBO', options: {}, default: defaultValue },
})
const output = (id: string, type: OutputSpec['type'] = scalar): OutputSpec => ({ kind: 'output', id, type })
const schema = (type: string, items: readonly (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const cannyItems = (controller = false): readonly (InputSpec | OutputSpec)[] => [
  socket('image', image),
  numberWidget('low_threshold', 0.1, scalar, controller),
  numberWidget('high_threshold', 0.2),
  numberWidget('resolution', 512, integer),
  output('image', image),
]
const scaleItems = (controller = false): readonly (InputSpec | OutputSpec)[] => [
  socket('image', image),
  choiceWidget('upscale_method', 'nearest-exact'),
  numberWidget('width', 1024, integer, controller),
  numberWidget('height', 1024, integer),
  choiceWidget('crop', 'disabled'),
  output('image', image),
]
const producer = schema('test.image-producer', [output('image', image)])
const sink = schema('test.image-sink', [socket('image', image)])
const sourceA = schema('comfy_group_source:test/CannyEdgePreprocessor', cannyItems())
const sourceAControlled = schema(sourceA.type, cannyItems(true))
const sourceB = schema('comfy_group_source:test/ImageScale', scaleItems())
const sourceBWithSam = schema(sourceB.type, [...scaleItems(), socket('sam_model', image, true)])
const sourceBControlled = schema(sourceB.type, scaleItems(true))
const tileSplit = schema('comfy_group_source:test/ImageTileSplit', [
  socket('image', image),
  numberWidget('tile_size', 512, integer),
  output('tiles', image),
])
const tileMerge = schema('comfy_group_source:test/ImageTileMerge', [
  socket('tiles', image),
  numberWidget('overlap', 32, integer),
  output('image', image),
])
const groupType = 'comfy-group.test.canny-resize'
const tiledGroupType = 'comfy-group.test.tiled-upscale'
const groupSchema = schema(groupType, [
  socket('image', image),
  numberWidget('low_threshold', 0.1),
  output('image', image),
])
const tiledGroupSchema = schema(tiledGroupType, [
  socket('image', image),
  numberWidget('tile_size', 512, integer),
  output('image', image),
])

const groupRecord = (
  outputAddress = 'b:image',
  disconnected: readonly string[] = [],
): ComfyGroupRecord => ({
  id: 'comfy_group:test/canny-resize',
  mappingKind: 'op',
  carrier: 'dinkster.native',
  source: { pack: 'test', name: 'canny-resize', revision: 'abc' },
  pattern: {
    groupType,
    anchor: 'b',
    nodes: new Map([
      ['a', { source: { pack: 'test', nodeClass: 'CannyEdgePreprocessor', nodeType: sourceA.type, revision: 'abc' }, mode: 'active' }],
      ['b', { source: { pack: 'test', nodeClass: 'ImageScale', nodeType: sourceB.type, revision: 'abc' }, mode: 'active' }],
    ]),
    edges: [{ from: 'a:image', to: 'b:image' }],
    disconnected,
    inputs: new Map([['image', 'a:image']]),
    parameters: new Map([['low_threshold', 'a:low_threshold']]),
    constants: new Map<string, Json>([
      ['a:high_threshold', 0.2],
      ['a:resolution', 512],
      ['b:upscale_method', 'nearest-exact'],
      ['b:width', 1024],
      ['b:height', 1024],
      ['b:crop', 'disabled'],
    ]),
    outputs: new Map([['image', outputAddress]]),
  },
  replacement: {
    from: groupType,
    cases: [{
      to: 'dinkster.native',
      inputs: {
        image: { kind: 'copy', input: 'image' },
        low_threshold: { kind: 'copy', input: 'low_threshold' },
      },
      outputs: { image: 'image' },
    }],
  },
  confidence: { tier: 'grouped', evidence: ['test'] },
  ownerPack: 'test',
})

const tiledGroupRecord = (): ComfyGroupRecord => ({
  id: 'comfy_group:test/tiled-upscale',
  mappingKind: 'op',
  carrier: 'dinkster.native',
  source: { pack: 'test', name: 'tiled-upscale', revision: 'abc' },
  pattern: {
    groupType: tiledGroupType,
    anchor: 'merge',
    nodes: new Map([
      ['split', { source: { pack: 'test', nodeClass: 'ImageTileSplit', nodeType: tileSplit.type, revision: 'abc' }, mode: 'active' }],
      ['upscale', { source: { pack: 'test', nodeClass: 'ImageScale', nodeType: sourceB.type, revision: 'abc' }, mode: 'active' }],
      ['merge', { source: { pack: 'test', nodeClass: 'ImageTileMerge', nodeType: tileMerge.type, revision: 'abc' }, mode: 'active' }],
    ]),
    edges: [
      { from: 'split:tiles', to: 'upscale:image' },
      { from: 'upscale:image', to: 'merge:tiles' },
    ],
    disconnected: [],
    inputs: new Map([['image', 'split:image']]),
    parameters: new Map([['tile_size', 'split:tile_size']]),
    constants: new Map<string, Json>([
      ['upscale:upscale_method', 'nearest-exact'],
      ['upscale:width', 1024],
      ['upscale:height', 1024],
      ['upscale:crop', 'disabled'],
      ['merge:overlap', 32],
    ]),
    outputs: new Map([['image', 'merge:image']]),
  },
  replacement: {
    from: tiledGroupType,
    cases: [{
      to: 'dinkster.native',
      inputs: {
        image: { kind: 'copy', input: 'image' },
        tile_size: { kind: 'copy', input: 'tile_size' },
      },
      outputs: { image: 'image' },
    }],
  },
  confidence: { tier: 'grouped', evidence: ['test'] },
  ownerPack: 'test',
})

const catalog = (
  record = groupRecord(),
  cannySchema = sourceA,
  scaleSchema = sourceB,
): ComfyGroupCatalog => ({
  records: [record],
  sourceSchemas: new Map([
    [cannySchema.type, cannySchema],
    [scaleSchema.type, scaleSchema],
    [tileSplit.type, tileSplit],
    [tileMerge.type, tileMerge],
  ]),
  groupSchemas: new Map([[groupType, groupSchema], [tiledGroupType, tiledGroupSchema]]),
  recordsByGroupType: new Map([[record.pattern.groupType, record]]),
})

const lgNode = (
  id: number,
  type: string,
  options: {
    readonly pos?: readonly [number, number]
    readonly mode?: number
    readonly inputs?: readonly { readonly name: string; readonly link?: number }[]
    readonly outputs?: readonly { readonly name: string }[]
    readonly widgets_values?: readonly unknown[]
  } = {},
) => ({
  id,
  type,
  pos: options.pos ?? [id * 100, 0],
  ...(options.mode !== undefined ? { mode: options.mode } : {}),
  ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
  ...(options.outputs !== undefined ? { outputs: options.outputs } : {}),
  ...(options.widgets_values !== undefined ? { widgets_values: options.widgets_values } : {}),
})

const link = (id: number, from: number, fromSlot: number, to: number, toSlot: number) =>
  [id, from, fromSlot, to, toSlot, '*'] as const

const chain = ({
  width = 1024,
  cannyController,
  scaleController,
}: {
  readonly width?: number
  readonly cannyController?: 'fixed' | 'increment'
  readonly scaleController?: 'fixed' | 'increment'
} = {}): JsonObject => ({
  nodes: [
    lgNode(1, producer.type, { outputs: [{ name: 'image' }] }),
    lgNode(2, 'CannyEdgePreprocessor', {
      inputs: [{ name: 'image', link: 1 }],
      outputs: [{ name: 'IMAGE' }],
      widgets_values: [
        0.1,
        ...(cannyController === undefined ? [] : [cannyController]),
        0.2,
        512,
      ],
    }),
    lgNode(3, 'ImageScale', {
      pos: [333, 444],
      inputs: [{ name: 'image', link: 2 }],
      outputs: [{ name: 'IMAGE' }],
      widgets_values: [
        'nearest-exact',
        width,
        ...(scaleController === undefined ? [] : [scaleController]),
        1024,
        'disabled',
      ],
    }),
    lgNode(4, sink.type, { inputs: [{ name: 'image', link: 3 }] }),
  ],
  links: [link(1, 1, 0, 2, 0), link(2, 2, 0, 3, 0), link(3, 3, 0, 4, 0)],
  groups: [],
  version: 0.4,
}) as JsonObject

const tiledChain = (): JsonObject => ({
  nodes: [
    lgNode(1, producer.type, { outputs: [{ name: 'image' }] }),
    lgNode(2, 'ImageTileSplit', {
      inputs: [{ name: 'image', link: 1 }],
      outputs: [{ name: 'TILES' }],
      widgets_values: [512],
    }),
    lgNode(3, 'ImageScale', {
      inputs: [{ name: 'image', link: 2 }],
      outputs: [{ name: 'IMAGE' }],
      widgets_values: ['nearest-exact', 1024, 1024, 'disabled'],
    }),
    lgNode(4, 'ImageTileMerge', {
      pos: [555, 444],
      inputs: [{ name: 'tiles', link: 3 }],
      outputs: [{ name: 'IMAGE' }],
      widgets_values: [32],
    }),
    lgNode(5, sink.type, { inputs: [{ name: 'image', link: 4 }] }),
  ],
  links: [
    link(1, 1, 0, 2, 0),
    link(2, 2, 0, 3, 0),
    link(3, 3, 0, 4, 0),
    link(4, 4, 0, 5, 0),
  ],
  groups: [],
  version: 0.4,
}) as JsonObject

const resolve = (type: string): NodeSchema | undefined =>
  [producer, sink].find((candidate) => candidate.type === type)

describe('ComfyUI exact-group import', () => {
  it('collapses a preprocessor-resize pair at its anchor and preserves its boundary and parameters', () => {
    const imported = importLitegraph(chain(), resolve, () => false, catalog())
    const graph = imported.document!.graphs[imported.document!.root]!

    expect(imported.diagnostics.map((item) => item.code)).toContain('import.comfyGroup.collapsed')
    expect(Object.keys(graph.nodes).sort()).toEqual(['n1', 'n3', 'n4'])
    expect(graph.nodes['n3']).toMatchObject({
      id: 'n3',
      type: groupType,
      values: { low_threshold: 0.1 },
    })
    expect(imported.document!.view.graphs[imported.document!.root]!.nodes['n3']!.position).toEqual({ x: 333, y: 444 })
    expect(Object.values(graph.links)).toEqual([
      { id: 'l1', from: { node: 'n1', port: 'image' }, to: { node: 'n3', port: 'image' } },
      { id: 'l3', from: { node: 'n3', port: 'image' }, to: { node: 'n4', port: 'image' } },
    ])
  })

  it('reports a Use Everywhere target removed by exact-group collapse', () => {
    const input = structuredClone(chain()) as unknown as {
      nodes: Record<string, unknown>[]
      links: unknown[]
      extra?: JsonObject
    }
    input.links.splice(0, 1)
    ;(input.nodes[1]!['inputs'] as Record<string, unknown>[])[0]!['link'] = null
    input.nodes.push(lgNode(5, 'Anything Everywhere', { inputs: [{ name: 'anything', link: 4 }] }))
    input.links.push(link(4, 1, 0, 5, 0))
    input.extra = {
      ue_links: [{
        downstream: 2,
        downstream_slot: 0,
        upstream: 1,
        upstream_slot: 0,
        controller: 5,
        type: 'IMAGE',
      }],
    }

    const imported = importLitegraph(input as unknown as JsonObject, resolve, () => false, catalog())

    expect(imported.document).toBeUndefined()
    expect(imported.diagnostics.map((item) => item.code)).toContain('import.ue.endpointUnavailable')
  })

  it('matches a SAM-like optional socket only while it remains unlinked', () => {
    const unlinked = chain() as unknown as { nodes: Record<string, unknown>[]; links: unknown[] }
    unlinked.nodes[2]!['inputs'] = [{ name: 'image', link: 2 }, { name: 'sam_model' }]
    const record = groupRecord('b:image', ['b:sam_model'])
    const unlinkedImport = importLitegraph(
      unlinked as JsonObject,
      resolve,
      () => false,
      catalog(record, sourceA, sourceBWithSam),
    )

    expect(unlinkedImport.diagnostics.map((item) => item.code)).toContain('import.comfyGroup.collapsed')

    const linked = structuredClone(unlinked)
    linked.nodes.push(lgNode(5, producer.type, { outputs: [{ name: 'image' }] }))
    ;(linked.nodes[2]!['inputs'] as Record<string, unknown>[])[1]!['link'] = 4
    linked.links.push(link(4, 5, 0, 3, 1))
    const linkedImport = importLitegraph(
      linked as JsonObject,
      resolve,
      () => false,
      catalog(record, sourceA, sourceBWithSam),
    )

    expect(linkedImport.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
    expect(Object.values(linkedImport.document!.graphs[linkedImport.document!.root]!.nodes).map((node) => node.type))
      .toContain('ImageScale')

    for (const declaredLink of [999, 'malformed']) {
      const dangling = structuredClone(unlinked)
      ;(dangling.nodes[2]!['inputs'] as Record<string, unknown>[])[1]!['link'] = declaredLink
      const danglingImport = importLitegraph(
        dangling as JsonObject,
        resolve,
        () => false,
        catalog(record, sourceA, sourceBWithSam),
      )
      expect(danglingImport.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
      expect(Object.values(danglingImport.document!.graphs[danglingImport.document!.root]!.nodes).map((node) => node.type))
        .toContain('ImageScale')
    }
  })

  it('collapses a complete tiled-upscale chain without leaving source members', () => {
    const imported = importLitegraph(tiledChain(), resolve, () => false, catalog(tiledGroupRecord()))
    const graph = imported.document!.graphs[imported.document!.root]!

    expect(imported.diagnostics.map((item) => item.code)).toContain('import.comfyGroup.collapsed')
    expect(Object.keys(graph.nodes).sort()).toEqual(['n1', 'n4', 'n5'])
    expect(graph.nodes['n4']).toMatchObject({
      id: 'n4',
      type: tiledGroupType,
      values: { tile_size: 512 },
    })
    expect(imported.document!.view.graphs[imported.document!.root]!.nodes['n4']!.position).toEqual({ x: 555, y: 444 })
    expect(Object.values(graph.links)).toEqual([
      { id: 'l1', from: { node: 'n1', port: 'image' }, to: { node: 'n4', port: 'image' } },
      { id: 'l4', from: { node: 'n4', port: 'image' }, to: { node: 'n5', port: 'image' } },
    ])
  })

  it('refuses constant, topology, and mode mismatches without partial collapse', () => {
    const constantMismatch = importLitegraph(chain({ width: 2048 }), resolve, () => false, catalog())
    const extraTopology = chain() as unknown as { nodes: unknown[]; links: unknown[] }
    extraTopology.nodes.push(lgNode(5, sink.type, { inputs: [{ name: 'image', link: 4 }] }))
    extraTopology.links.push(link(4, 2, 0, 5, 0))
    const missingTopology = chain() as unknown as { links: unknown[] }
    missingTopology.links.splice(1, 1)
    const modeMismatch = chain() as unknown as { nodes: Record<string, unknown>[] }
    modeMismatch.nodes[1]!['mode'] = 2

    for (const imported of [
      constantMismatch,
      importLitegraph(extraTopology as JsonObject, resolve, () => false, catalog()),
      importLitegraph(missingTopology as JsonObject, resolve, () => false, catalog()),
      importLitegraph(modeMismatch as JsonObject, resolve, () => false, catalog()),
    ]) {
      expect(imported.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
      expect(Object.values(imported.document!.graphs[imported.document!.root]!.nodes).map((node) => node.type))
        .toContain('CannyEdgePreprocessor')
    }
  })

  it('requires the complete pinned input surface without positional fallback', () => {
    const renamed = chain() as unknown as { nodes: Record<string, unknown>[] }
    renamed.nodes[1]!['inputs'] = [{ name: 'renamed', link: 1 }]
    const renamedOutput = chain() as unknown as { nodes: Record<string, unknown>[] }
    renamedOutput.nodes[1]!['outputs'] = [{ name: 'renamed' }]
    const extra = chain() as unknown as { nodes: Record<string, unknown>[] }
    extra.nodes[1]!['inputs'] = [{ name: 'image', link: 1 }, { name: 'unexpected' }]

    for (const imported of [renamed, renamedOutput, extra].map((workflow) =>
      importLitegraph(workflow as JsonObject, resolve, () => false, catalog()))) {
      expect(imported.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
      expect(Object.values(imported.document!.graphs[imported.document!.root]!.nodes).map((node) => node.type))
        .toContain('CannyEdgePreprocessor')
    }
  })

  it('retains matched members through their pinned snapshots when collapse is held', () => {
    const imported = importLitegraph(
      chain({ cannyController: 'increment', scaleController: 'fixed' }),
      resolve,
      () => false,
      catalog(groupRecord(), sourceAControlled, sourceBControlled),
      () => false,
    )
    const graph = imported.document!.graphs[imported.document!.root]!

    expect(imported.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
    expect(Object.keys(graph.nodes).sort()).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(graph.nodes['n2']).toMatchObject({
      type: sourceA.type,
      values: { low_threshold: 0.1, high_threshold: 0.2, resolution: 512 },
      controllers: { low_threshold: 'increment' },
    })
    expect(graph.nodes['n3']).toMatchObject({
      type: sourceB.type,
      values: { upscale_method: 'nearest-exact', width: 1024, height: 1024, crop: 'disabled' },
      controllers: { width: 'fixed' },
    })
    expect(Object.values(graph.links)).toContainEqual({
      id: 'l2',
      from: { node: 'n2', port: 'image' },
      to: { node: 'n3', port: 'image' },
    })
  })

  it('refuses a constant whose controller can change its value', () => {
    const imported = importLitegraph(
      chain({ scaleController: 'increment' }),
      resolve,
      () => false,
      catalog(groupRecord(), sourceA, sourceBControlled),
    )

    expect(imported.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
    expect(Object.values(imported.document!.graphs[imported.document!.root]!.nodes).map((node) => node.type))
      .toContain('ImageScale')
  })

  it('refuses overlapping matches and reports the ambiguity', () => {
    const raw = chain() as unknown as { nodes: unknown[]; links: unknown[] }
    raw.links.splice(2, 1)
    raw.nodes.push(lgNode(5, 'ImageScale', {
      inputs: [{ name: 'image', link: 4 }],
      outputs: [{ name: 'IMAGE' }],
      widgets_values: ['nearest-exact', 1024, 1024, 'disabled'],
    }))
    raw.links.push(link(4, 2, 0, 5, 0))
    const imported = importLitegraph(raw as JsonObject, resolve, () => false, catalog(groupRecord('a:image')))

    expect(imported.diagnostics.map((item) => item.code)).toContain('import.comfyGroup.ambiguous')
    expect(imported.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
  })

  it('is deterministic across repeated imports', () => {
    const first = importLitegraph(chain(), resolve, () => false, catalog())
    const second = importLitegraph(chain(), resolve, () => false, catalog())
    expect(second).toEqual(first)
  })

  it('bounds rejected partial assignment searches', () => {
    const nodes = Array.from({ length: 47 }, (_, index) => [
      lgNode(index + 1, 'CannyEdgePreprocessor', {
        inputs: [{ name: 'image' }],
        outputs: [{ name: 'IMAGE' }],
        widgets_values: [0.1, 0.2, 512],
      }),
      lgNode(index + 101, 'ImageScale', {
        inputs: [{ name: 'image' }],
        outputs: [{ name: 'IMAGE' }],
        widgets_values: ['nearest-exact', 1024, 1024, 'disabled'],
      }),
    ]).flat()
    const imported = importLitegraph(
      { nodes, links: [], groups: [], version: 0.4 } as JsonObject,
      resolve,
      () => false,
      catalog(),
    )

    expect(imported.diagnostics.map((item) => item.code)).toContain('import.comfyGroup.searchLimit')
    expect(imported.diagnostics.map((item) => item.code)).not.toContain('import.comfyGroup.collapsed')
  })
})
