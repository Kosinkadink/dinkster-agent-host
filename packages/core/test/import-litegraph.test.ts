/**
 * Legacy litegraph importer tests: positional widget values map onto ID-keyed
 * values via the CURRENT schema, every mismatch surfaces as a diagnostic
 * (never a silent shift), Reroute nodes survive as first-class reroutes,
 * Set/Get pairs become named nets, and the output passes the same gates as
 * any natively-loaded document.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { Diagnostic } from '../src/diagnostics.js'
import type { JsonObject } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { exportVirtualNodesToLitegraph } from '../src/format/export-litegraph.js'
import { loadDocument } from '../src/format/migrate.js'
import { asConnectionId } from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'
import { synthesizeAliasRules } from '../src/replace/alias-rules.js'
import { createReplacementRegistry } from '../src/replace/registry.js'
import { scanReplacements } from '../src/replace/scan.js'
import { elabInputsOf, elaborateInterface } from '../src/schema/elaborate.js'
import type { CountBoundOutputAutogrowSpec, InputSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'
import { parseDinksterSchemaWire16, type DinksterWireSchema } from '../src/schema/dinkster-wire.js'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'
import { solveGraphTypes } from '../src/schema/solve.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const objectInfo = readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>
const { schemas } = parseObjectInfo(objectInfo)
const resolve = (type: string) => schemas.get(type)
const resizeImageMaskSchema = parseDinksterSchemaWire16(
  'comfy.ResizeImageMaskNode',
  readJson('fixtures/dinkster-resize-image-mask-wire16.json') as DinksterWireSchema,
).schema!

const errorsOf = (d: readonly Diagnostic[]) => d.filter((x) => x.severity === 'error')
const codesOf = (d: readonly Diagnostic[]) => d.map((x) => x.code)

// -- litegraph JSON builders --------------------------------------------------

interface LgIn {
  name: string
  type?: string
  link?: number | null
  widget?: { name: string }
}
interface LgOut {
  name: string
  type?: string
  links?: number[]
}
const lgNode = (
  id: number,
  type: string,
  o: {
    pos?: [number, number]
    size?: [number, number]
    color?: string
    mode?: number
    flags?: JsonObject
    title?: string
    inputs?: LgIn[]
    outputs?: LgOut[]
    widgets_values?: unknown
    properties?: JsonObject
  } = {},
) => ({
  id,
  type,
  pos: o.pos ?? [id * 100, 0],
  ...(o.size !== undefined ? { size: o.size } : {}),
  ...(o.color !== undefined ? { color: o.color } : {}),
  ...(o.mode !== undefined ? { mode: o.mode } : {}),
  ...(o.flags !== undefined ? { flags: o.flags } : {}),
  ...(o.title !== undefined ? { title: o.title } : {}),
  ...(o.inputs ? { inputs: o.inputs } : {}),
  ...(o.outputs ? { outputs: o.outputs } : {}),
  ...(o.widgets_values !== undefined ? { widgets_values: o.widgets_values } : {}),
  ...(o.properties !== undefined ? { properties: o.properties } : {}),
})

/** link tuple: [id, fromNode, fromSlot, toNode, toSlot, type] */
const lgLink = (id: number, fromNode: number, fromSlot: number, toNode: number, toSlot: number) =>
  [id, fromNode, fromSlot, toNode, toSlot, '*'] as const

const workflow = (nodes: unknown[], links: unknown[] = [], extra: JsonObject = {}): JsonObject =>
  ({ nodes, links, groups: [], version: 0.4, ...extra }) as unknown as JsonObject

/** CheckpointLoaderSimple(1) --CLIP--> CLIPTextEncode(2). */
const basicPair = (): JsonObject =>
  workflow(
    [
      lgNode(1, 'CheckpointLoaderSimple', {
        outputs: [{ name: 'MODEL' }, { name: 'CLIP', links: [1] }, { name: 'VAE' }],
        widgets_values: ['v1-5-pruned-emaonly.safetensors'],
      }),
      lgNode(2, 'CLIPTextEncode', {
        inputs: [{ name: 'clip', link: 1 }],
        outputs: [{ name: 'CONDITIONING' }],
        widgets_values: ['a photo of a cat'],
      }),
    ],
    [lgLink(1, 1, 1, 2, 0)],
  )

const sdInput = (id: string, type: string, widgetType?: string): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: type },
  optional: false,
  ...(widgetType !== undefined ? { widget: { widgetType, options: {} } } : {}),
})
const sdOutput = (id: string, type: string): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: type },
})
const sdSchema = (
  type: string,
  alias: string,
  items: readonly (InputSpec | OutputSpec)[],
  isOutputNode = false,
): NodeSchema => ({
  type,
  displayName: alias,
  category: 'test',
  source: 'v3',
  isOutputNode,
  items,
  aliases: [alias],
})

const sd15Schemas = [
  sdSchema('dinkster.load_checkpoint', 'CheckpointLoaderSimple', [
    sdInput('ckpt_name', 'core.string', 'STRING'),
    sdOutput('model', 'core.model'),
    sdOutput('clip', 'core.clip'),
    sdOutput('vae', 'core.vae'),
  ]),
  sdSchema('dinkster.clip_text_encode', 'CLIPTextEncode', [
    sdInput('clip', 'core.clip'),
    sdInput('text', 'core.string', 'STRING'),
    sdOutput('conditioning', 'core.conditioning'),
  ]),
  sdSchema('dinkster.empty_latent_image', 'EmptyLatentImage', [
    sdInput('width', 'core.integer', 'INT'),
    sdInput('height', 'core.integer', 'INT'),
    sdInput('batch_size', 'core.integer', 'INT'),
    sdOutput('latent', 'core.latent'),
  ]),
  sdSchema('dinkster.ksampler', 'KSampler', [
    sdInput('model', 'core.model'),
    sdInput('positive', 'core.conditioning'),
    sdInput('negative', 'core.conditioning'),
    sdInput('latent_image', 'core.latent'),
    sdInput('seed', 'core.integer', 'INT'),
    sdInput('steps', 'core.integer', 'INT'),
    sdInput('cfg', 'core.float', 'FLOAT'),
    sdInput('sampler_name', 'core.combo', 'COMBO'),
    sdInput('scheduler', 'core.combo', 'COMBO'),
    sdInput('denoise', 'core.float', 'FLOAT'),
    sdOutput('latent', 'core.latent'),
  ]),
  sdSchema('dinkster.vae_decode', 'VAEDecode', [
    sdInput('samples', 'core.latent'),
    sdInput('vae', 'core.vae'),
    sdOutput('image', 'core.image'),
  ]),
  sdSchema('dinkster.save_image', 'SaveImage', [
    sdInput('images', 'core.image'),
    sdInput('filename_prefix', 'core.string', 'STRING'),
  ], true),
  sdSchema('comfy.PreviewImage', 'PreviewImage', [
    sdInput('images', 'core.image'),
    sdOutput('images', 'core.image'),
  ], true),
] as const

const sd15Resolve = (type: string): NodeSchema | undefined =>
  sd15Schemas.find((schema) => schema.type === type || schema.aliases?.includes(type))

const trellis2Aliases = {
  EmptyTrellis2LatentStructure: 'dinkster.empty_trellis2_latent_structure',
  Trellis2Conditioning: 'dinkster.trellis2_conditioning',
  Pixal3DConditioning: 'dinkster.pixal3d_conditioning',
  VaeDecodeStructureTrellis2: 'dinkster.vae_decode_structure_trellis2',
  Trellis2ShapeStage: 'dinkster.trellis2_shape_stage',
  Trellis2UpsampleStage: 'dinkster.trellis2_upsample_stage',
  VaeDecodeShapeTrellis: 'dinkster.vae_decode_shape_trellis',
  Trellis2TextureStage: 'dinkster.trellis2_texture_stage',
  VaeDecodeTextureTrellis: 'dinkster.vae_decode_texture_trellis',
} as const

const schemaFromLitegraphNode = (node: any, type = node.type, aliases?: readonly string[]): NodeSchema => {
  const connectedInputs: InputSpec[] = (node.inputs ?? []).map((input: any) => sdInput(input.name, input.type ?? '*'))
  const connectedNames = new Set(connectedInputs.map((input) => input.id))
  const widgetInputs = Object.keys(node.widgets_values_named ?? {})
    .filter((name) => !connectedNames.has(name))
    .map((name) => sdInput(name, 'core.value', 'UNKNOWN'))
  const outputs = (node.outputs ?? []).map((output: any) => sdOutput(output.name.toLowerCase(), output.type ?? '*'))
  return {
    type,
    displayName: node.type,
    category: 'test fixture',
    source: 'v3',
    isOutputNode: outputs.length === 0,
    items: [...connectedInputs, ...widgetInputs, ...outputs],
    ...(aliases ? { aliases } : {}),
  }
}

const sd15Workflow = (): JsonObject => workflow(
  [
    lgNode(1, 'CheckpointLoaderSimple', { outputs: [{ name: 'MODEL' }, { name: 'CLIP' }, { name: 'VAE' }], widgets_values: ['sd15.safetensors'] }),
    lgNode(2, 'CLIPTextEncode', { inputs: [{ name: 'foreign_clip' }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['positive'] }),
    lgNode(3, 'CLIPTextEncode', { inputs: [{ name: 'foreign_clip' }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['negative'] }),
    lgNode(4, 'EmptyLatentImage', { outputs: [{ name: 'LATENT' }], widgets_values: [512, 512, 1] }),
    lgNode(5, 'KSampler', {
      inputs: [{ name: 'm' }, { name: 'p' }, { name: 'n' }, { name: 'latent' }],
      outputs: [{ name: 'LATENT' }],
      widgets_values: [7, 20, 8, 'euler', 'normal', 1],
    }),
    lgNode(6, 'VAEDecode', { inputs: [{ name: 's' }, { name: 'v' }], outputs: [{ name: 'IMAGE' }] }),
    lgNode(7, 'SaveImage', { inputs: [{ name: 'pixels' }], widgets_values: ['Dinkster'] }),
    lgNode(8, 'PreviewImage', { inputs: [{ name: 'preview_pixels' }], outputs: [{ name: 'IMAGE' }] }),
  ],
  [
    lgLink(1, 1, 0, 5, 0),
    lgLink(2, 1, 1, 2, 0),
    lgLink(3, 1, 1, 3, 0),
    lgLink(4, 2, 0, 5, 1),
    lgLink(5, 3, 0, 5, 2),
    lgLink(6, 4, 0, 5, 3),
    lgLink(7, 5, 0, 6, 0),
    lgLink(8, 1, 2, 6, 1),
    lgLink(9, 6, 0, 7, 0),
    lgLink(10, 6, 0, 8, 0),
  ],
)

// -- basics -------------------------------------------------------------------

describe('basic translation', () => {
  it('imports and compiles the official TRELLIS.2 Pixal3D workflow', () => {
    const official = readJson('fixtures/workflows/3d_pixal3d_trellis2_image_to_model.json') as JsonObject
    const nodes = (official as any).nodes as any[]
    expect(nodes).toHaveLength(66)

    const fixtureSchemas = new Map<string, NodeSchema>()
    for (const node of nodes) {
      if (resolve(node.type) || node.type === 'Note' || node.type === 'MarkdownNote') continue
      const canonical = trellis2Aliases[node.type as keyof typeof trellis2Aliases]
      const schema = schemaFromLitegraphNode(node, canonical ?? node.type, canonical ? [node.type] : undefined)
      fixtureSchemas.set(schema.type, schema)
      fixtureSchemas.set(node.type, schema)
    }
    const officialResolve = (type: string) => fixtureSchemas.get(type) ?? resolve(type)
    const maintainedAlias = (type: string) => type in trellis2Aliases
    const imported = importLitegraph(official, officialResolve, maintainedAlias)

    expect(errorsOf(imported.diagnostics)).toEqual([])
    const graph = imported.document!.graphs[imported.document!.root]!
    expect(Object.keys(graph.nodes)).toHaveLength(66)
    for (const [alias, canonical] of Object.entries(trellis2Aliases)) {
      const authoredCount = nodes.filter((node) => node.type === alias).length
      expect(Object.values(graph.nodes).filter((node) => node.type === canonical)).toHaveLength(authoredCount)
    }

    const pathTypes = Object.values(graph.nodes).map((node) => node.type)
    expect(pathTypes.filter((type) => type === 'CFGOverride')).toHaveLength(2)
    expect(pathTypes.filter((type) => type === 'RescaleCFG')).toHaveLength(2)
    expect(pathTypes.filter((type) => type === 'ModelSamplingSD3')).toHaveLength(1)

    const compiled = compile({
      document: imported.document!,
      revision: 1,
      resolve: officialResolve,
      scope: { kind: 'full' },
      connection: asConnectionId('trellis2-official'),
      schemaHash: 'trellis2-official-fixture',
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (compiled.ok)
      expect(Object.keys(compiled.artifact.prompt)).toHaveLength(63)
  })

  it('refuses a legacy workflow carrying an occurrence topology overlay', () => {
    const input = basicPair() as any
    input['occurrenceTopologies'] = { owner: { links: {} } }
    const result = importLitegraph(input, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('import.occurrenceTopologies.unsupported')
  })

  it('imports the legacy fixture without error diagnostics', () => {
    const result = importLitegraph(readJson('fixtures/workflows/legacy-litegraph.json') as JsonObject, resolve)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document).toBeDefined()
  })

  it('translates nodes, positions, links and ID-keyed widget values', () => {
    const { document, diagnostics } = importLitegraph(basicPair(), resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    expect(g.nodes['n1']!.type).toBe('CheckpointLoaderSimple')
    expect(g.nodes['n1']!.values).toEqual({ ckpt_name: 'v1-5-pruned-emaonly.safetensors' })
    expect(g.nodes['n2']!.values).toEqual({ text: 'a photo of a cat' })
    const link = Object.values(g.links)[0]!
    expect(link.from).toEqual({ node: 'n1', port: 'out1' }) // CLIP is output slot 1
    expect(link.to).toEqual({ node: 'n2', port: 'clip' })
    expect(document!.view.graphs[document!.root]!.nodes['n1']!.position).toEqual({ x: 100, y: 0 })
  })

  it('passes checkDocument and reloads as a native document', () => {
    const { document } = importLitegraph(basicPair(), resolve)
    expect(errorsOf(checkDocument(document!))).toEqual([])
    const reloaded = loadDocument(JSON.parse(JSON.stringify(document)))
    expect(errorsOf(reloaded.diagnostics)).toEqual([])
    expect(reloaded.document).toBeDefined()
  })

  it('is deterministic across repeated imports', () => {
    const a = importLitegraph(basicPair(), resolve)
    const b = importLitegraph(basicPair(), resolve)
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document))
    expect(a.document!.lineage).toMatch(/^lg-[0-9a-f]{8}$/)
  })

  it('keeps node title overrides but drops default titles', () => {
    const json = workflow([
      lgNode(1, 'CheckpointLoaderSimple', { title: 'My Loader', widgets_values: ['x.safetensors'] }),
      lgNode(2, 'CLIPTextEncode', { title: 'CLIP Text Encode (Prompt)', widgets_values: ['y'] }),
    ])
    const { document } = importLitegraph(json, resolve)
    const g = document!.graphs[document!.root]!
    expect(g.nodes['n1']!.title).toBe('My Loader')
    expect(g.nodes['n2']!.title).toBeUndefined()
  })

  it('canonicalizes a real SD1.5 alias graph and positional ports at ingress', () => {
    const imported = importLitegraph(sd15Workflow(), sd15Resolve)
    expect(imported.diagnostics).toEqual([])
    const document = imported.document!
    const graph = document.graphs.g0!
    expect(Object.values(graph.nodes).map((node) => node.type)).toEqual([
      'dinkster.load_checkpoint',
      'dinkster.clip_text_encode',
      'dinkster.clip_text_encode',
      'dinkster.empty_latent_image',
      'dinkster.ksampler',
      'dinkster.vae_decode',
      'dinkster.save_image',
      'comfy.PreviewImage',
    ])
    expect(graph.links.l4).toMatchObject({
      from: { node: 'n2', port: 'conditioning' },
      to: { node: 'n5', port: 'positive' },
    })
    expect(graph.links.l5).toMatchObject({
      from: { node: 'n3', port: 'conditioning' },
      to: { node: 'n5', port: 'negative' },
    })
    expect(graph.links.l9).toMatchObject({
      from: { node: 'n6', port: 'image' },
      to: { node: 'n7', port: 'images' },
    })
    expect(graph.links.l10).toMatchObject({
      from: { node: 'n6', port: 'image' },
      to: { node: 'n8', port: 'images' },
    })
    expect(graph.nodes.n8!.type).toBe('comfy.PreviewImage')
    expect(graph.nodes.n1!.values).toEqual({ ckpt_name: 'sd15.safetensors' })
    expect(graph.nodes.n2!.values).toEqual({ text: 'positive' })
    expect(graph.nodes.n3!.values).toEqual({ text: 'negative' })

    const replacements = createReplacementRegistry()
    for (const rule of synthesizeAliasRules(sd15Schemas)) expect(replacements.register('core', rule)).toEqual([])
    expect(scanReplacements(document, replacements, sd15Resolve)).toEqual([])

    const reopened = loadDocument(JSON.parse(JSON.stringify(document)))
    expect(reopened.diagnostics).toEqual([])
    expect(reopened.document).toEqual(document)
    const compiled = compile({
      document: reopened.document!,
      revision: 1,
      resolve: sd15Resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'sd15-test',
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (!compiled.ok) return
    expect(compiled.artifact.diagnostics).toEqual([])
    expect(compiled.artifact.prompt['n2']!.class_type).toBe('dinkster.clip_text_encode')
    expect(compiled.artifact.prompt['n5']!.inputs['positive']).toEqual(['n2', 0])
    expect(compiled.artifact.prompt['n5']!.inputs['negative']).toEqual(['n3', 0])
  })

  it('keeps an unresolved alias raw and diagnosed', () => {
    const alias = sd15Schemas[1]!
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(1, 'CLIPTextEncode', { widgets_values: ['text'] })]),
      (type) => type === alias.type ? alias : undefined,
    )
    expect(document!.graphs.g0!.nodes.n1!.type).toBe('CLIPTextEncode')
    expect(document!.graphs.g0!.nodes.n1!.ext?.['importer.rawWidgetValues']).toEqual(['text'])
    expect(codesOf(diagnostics)).toContain('import.schema.missing')
  })

  it('keeps mixed converted-widget sockets from shifting ordinary positional inputs', () => {
    const mixed = sdSchema('dinkster.mixed', 'Mixed', [
      sdInput('model', 'core.model'),
      sdInput('seed', 'core.integer', 'INT'),
      sdInput('positive', 'core.conditioning'),
      { ...sdInput('forced', 'core.float', 'FLOAT'), forceInput: true },
      sdInput('negative', 'core.conditioning'),
    ])
    const source = sdSchema('dinkster.sources', 'Sources', [
      sdOutput('model', 'core.model'),
      sdOutput('integer', 'core.integer'),
      sdOutput('conditioning', 'core.conditioning'),
      sdOutput('float', 'core.float'),
    ])
    const localResolve = (type: string): NodeSchema | undefined =>
      [mixed, source].find((schema) => schema.type === type || schema.aliases?.includes(type))
    const json = workflow(
      [
        lgNode(1, 'Sources', { outputs: [{ name: 'M' }, { name: 'I' }, { name: 'C' }, { name: 'F' }] }),
        lgNode(2, 'Mixed', {
          inputs: [
            { name: 'foreign_model' },
            // The foreign socket name collides with a different schema input;
            // widget.name is the authoritative converted-widget identity.
            { name: 'model', widget: { name: 'seed' } },
            { name: 'foreign_positive' },
            { name: 'foreign_forced' },
            { name: 'foreign_negative' },
          ],
        }),
      ],
      [
        lgLink(1, 1, 0, 2, 0),
        lgLink(2, 1, 1, 2, 1),
        lgLink(3, 1, 2, 2, 2),
        lgLink(4, 1, 3, 2, 3),
        lgLink(5, 1, 2, 2, 4),
      ],
    )
    const { document, diagnostics } = importLitegraph(json, localResolve)
    expect(diagnostics).toEqual([])
    expect(Object.values(document!.graphs.g0!.links).map((link) => link.to)).toEqual([
      { node: 'n2', port: 'model' },
      { node: 'n2', port: 'seed' },
      { node: 'n2', port: 'positive' },
      { node: 'n2', port: 'forced' },
      { node: 'n2', port: 'negative' },
    ])
  })
})

describe('serialized output slot identity', () => {
  const imageType = { kind: 'concrete', name: 'IMAGE' } as const
  const sink: NodeSchema = {
    type: 'OutputSink',
    displayName: 'Output Sink',
    category: 'test',
    source: 'v3',
    isOutputNode: true,
    items: [{ kind: 'input', id: 'image', type: imageType, optional: false }],
  }
  const counted: NodeSchema = {
    type: 'CountedSource',
    displayName: 'Counted Source',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'count',
        type: { kind: 'concrete', name: 'core.int' },
        optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0 },
      },
      {
        kind: 'output',
        id: 'results',
        type: imageType,
        dynamic: {
          kind: 'autogrow',
          materialization: 'wire15',
          template: [{ kind: 'input', id: 'result', type: imageType, optional: false }],
          naming: { kind: 'prefix', prefix: '', min: 0, max: 4 },
          count: { input: 'count', suffix: 'index' },
        },
      },
    ],
  }
  const countedResolve = (type: string): NodeSchema | undefined =>
    type === counted.type ? counted : type === sink.type ? sink : undefined

  it('uses serialized static output names before schema declaration order', () => {
    const source: NodeSchema = {
      type: 'NamedSource',
      displayName: 'Named Source',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        { ...sdOutput('left', 'IMAGE'), displayName: 'LEFT' },
        { ...sdOutput('right', 'IMAGE'), displayName: 'RIGHT' },
      ],
    }
    const imported = importLitegraph(workflow([
      lgNode(1, source.type, { outputs: [{ name: 'RIGHT', links: [1] }, { name: 'LEFT' }] }),
      lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
    ], [lgLink(1, 1, 0, 2, 0)]), (type) => type === source.type ? source : type === sink.type ? sink : undefined)
    expect(imported.diagnostics).toEqual([])
    expect(imported.document!.graphs.g0!.links.l1!.from).toEqual({ node: 'n1', port: 'right' })
  })

  it('imports actual count-family members through direct links and named nets', () => {
    const imported = importLitegraph(workflow([
      lgNode(1, counted.type, {
        outputs: [
          { name: 'results.0' },
          { name: 'results.1', links: [1, 2] },
          { name: 'results.2' },
        ],
        widgets_values: [3],
      }),
      lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
      lgNode(3, 'SetNode', {
        inputs: [{ name: 'value', link: 2 }], outputs: [{ name: '*' }], widgets_values: ['selected'],
      }),
      lgNode(4, 'GetNode', { outputs: [{ name: '*', links: [3] }], widgets_values: ['selected'] }),
      lgNode(5, sink.type, { inputs: [{ name: 'image', link: 3 }] }),
    ], [
      lgLink(1, 1, 1, 2, 0),
      lgLink(2, 1, 1, 3, 0),
      lgLink(3, 4, 0, 5, 0),
    ]), countedResolve)
    expect(imported.diagnostics).toEqual([
      expect.objectContaining({ code: 'import.net.converted', severity: 'info' }),
    ])
    const graph = imported.document!.graphs.g0!
    expect(graph.links.l1!.from).toEqual({ node: 'n1', port: 'results', members: ['1'] })
    expect(Object.values(graph.nets)[0]!.source).toEqual({ node: 'n1', port: 'results', members: ['1'] })
  })

  it('preserves a count-family member on a reroute driver', () => {
    const imported = importLitegraph(workflow([
      lgNode(1, counted.type, {
        outputs: [{ name: 'results.0', links: [1] }],
        widgets_values: [1],
      }),
      lgNode(2, 'Reroute', {
        inputs: [{ name: '', link: 1 }],
        outputs: [{ name: '*', links: [2] }],
      }),
      lgNode(3, sink.type, { inputs: [{ name: 'image', link: 2 }] }),
    ], [lgLink(1, 1, 0, 2, 0), lgLink(2, 2, 0, 3, 0)]), countedResolve)
    const graph = imported.document!.graphs.g0!
    expect(graph.links.l1!.from).toEqual({ node: 'n1', port: 'results', members: ['0'] })
    expect(graph.links.l1!.to).toEqual({ reroute: 'r2' })
    expect(graph.links.l2!.from).toEqual({ reroute: 'r2' })
  })

  it('does not positionally reinterpret an invalid family member as a later static output', () => {
    const mixed: NodeSchema = {
      ...counted,
      items: [
        sdOutput('before', 'IMAGE'),
        ...counted.items,
        sdOutput('after', 'IMAGE'),
      ],
    }
    const imported = importLitegraph(workflow([
      lgNode(1, mixed.type, {
        outputs: [{ name: 'before' }, { name: 'results.0' }, { name: 'IMAGE', links: [1] }, { name: 'after' }],
        widgets_values: [2],
      }),
      lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
    ], [lgLink(1, 1, 2, 2, 0)]), (type) => type === mixed.type ? mixed : countedResolve(type))
    expect(imported.document).toBeUndefined()
    expect(codesOf(errorsOf(imported.diagnostics))).toContain('import.link.outputSlot')
  })

  it('rejects families whose combined members exceed the shared budget', () => {
    const countedFamily = counted.items[1] as OutputSpec & { dynamic: CountBoundOutputAutogrowSpec }
    const overBudget: NodeSchema = {
      ...counted,
      items: [
        counted.items[0]!,
        {
          ...countedFamily,
          dynamic: {
            ...countedFamily.dynamic,
            naming: { kind: 'prefix', prefix: '', min: 0, max: 512 },
          },
        },
        {
          ...countedFamily,
          id: 'masks',
          dynamic: {
            ...countedFamily.dynamic,
            naming: { kind: 'prefix', prefix: '', min: 0, max: 512 },
          },
        },
      ],
    }
    const imported = importLitegraph(workflow([
      lgNode(1, overBudget.type, { outputs: [{ name: 'results.0', links: [1] }], widgets_values: [300] }),
      lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
    ], [lgLink(1, 1, 0, 2, 0)]), (type) => type === overBudget.type ? overBudget : countedResolve(type))
    expect(imported.document).toBeUndefined()
    expect(codesOf(errorsOf(imported.diagnostics))).toContain('import.link.outputSlot')
  })

  it.each([
    ['missing slot', 'results.0', 1, 1],
    ['empty name', '', 0, 1],
    ['non-canonical suffix', 'results.01', 0, 2],
    ['member beyond count', 'results.1', 0, 1],
    ['unknown family', 'other.0', 0, 1],
  ])('rejects a linked %s', (_case, outputName, sourceSlot, count) => {
    const imported = importLitegraph(workflow([
      lgNode(1, counted.type, { outputs: [{ name: outputName, links: [1] }], widgets_values: [count] }),
      lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
    ], [lgLink(1, 1, sourceSlot, 2, 0)]), countedResolve)
    expect(imported.document).toBeUndefined()
    expect(codesOf(errorsOf(imported.diagnostics))).toContain('import.link.outputSlot')
  })

  it.each([undefined, true, 1.5, -1, 5, '0x2'])(
    'rejects a family member backed by the invalid stored count %s',
    (count) => {
      const imported = importLitegraph(workflow([
        lgNode(1, counted.type, {
          outputs: [{ name: 'results.0', links: [1] }],
          ...(count === undefined ? {} : { widgets_values: [count] }),
        }),
        lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
      ], [lgLink(1, 1, 0, 2, 0)]), countedResolve)
      expect(imported.document).toBeUndefined()
      expect(codesOf(errorsOf(imported.diagnostics))).toContain('import.link.outputSlot')
    },
  )

  it('rejects output-family slots when the count input is linked', () => {
    const countSource: NodeSchema = {
      type: 'CountSource', displayName: 'Count Source', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'count', type: { kind: 'concrete', name: 'core.int' } }],
    }
    const imported = importLitegraph(workflow([
      lgNode(1, countSource.type, { outputs: [{ name: 'count', links: [1] }] }),
      lgNode(2, counted.type, {
        inputs: [{ name: 'count', link: 1, widget: { name: 'count' } }],
        outputs: [{ name: 'results.0', links: [2] }],
        widgets_values: [1],
      }),
      lgNode(3, sink.type, { inputs: [{ name: 'image', link: 2 }] }),
    ], [lgLink(1, 1, 0, 2, 0), lgLink(2, 2, 0, 3, 0)]), (type) =>
      type === countSource.type ? countSource : countedResolve(type))
    expect(imported.document).toBeUndefined()
    expect(codesOf(errorsOf(imported.diagnostics))).toContain('import.link.outputSlot')
  })

  it('rejects an ambiguous serialized name for an unresolved source', () => {
    const imported = importLitegraph(workflow([
      lgNode(1, 'MissingSource', { outputs: [{ name: 'value', links: [1] }, { name: 'value' }] }),
      lgNode(2, sink.type, { inputs: [{ name: 'image', link: 1 }] }),
    ], [lgLink(1, 1, 0, 2, 0)]), countedResolve)
    expect(imported.document).toBeUndefined()
    expect(codesOf(errorsOf(imported.diagnostics))).toContain('import.link.outputSlot')
  })
})

// -- widget value mapping -----------------------------------------------------

describe('positional widget mapping', () => {
  const ksampler = (widgets: unknown[]) =>
    workflow([
      lgNode(1, 'KSampler', {
        inputs: [
          { name: 'model' },
          { name: 'positive' },
          { name: 'negative' },
          { name: 'latent_image' },
        ],
        outputs: [{ name: 'LATENT' }],
        widgets_values: widgets,
      }),
    ])

  it('does not consume a positional widget value for a forceInput socket', () => {
    const schema = sdSchema('dinkster.force_then_label', 'ForceThenLabel', [
      { ...sdInput('forced', 'core.float', 'FLOAT'), forceInput: true },
      sdInput('label', 'core.string', 'STRING'),
    ])
    const { document, diagnostics } = importLitegraph(
      workflow([
        lgNode(1, 'ForceThenLabel', {
          inputs: [{ name: 'forced' }],
          widgets_values: ['kept'],
        }),
      ]),
      (type) => type === schema.type || schema.aliases?.includes(type) ? schema : undefined,
    )
    expect(diagnostics).toEqual([])
    expect(document!.graphs.g0!.nodes.n1!.values).toEqual({ label: 'kept' })
  })

  it('maps the controller extra after seed into node.controllers', () => {
    // KSampler widgets: seed, control_after_generate, steps, cfg,
    // sampler_name, scheduler, denoise
    const { document, diagnostics } = importLitegraph(
      ksampler([42, 'randomize', 20, 8.0, 'euler', 'normal', 1.0]),
      resolve,
    )
    expect(errorsOf(diagnostics)).toEqual([])
    const n = document!.graphs[document!.root]!.nodes['n1']!
    expect(n.values).toEqual({
      seed: 42,
      steps: 20,
      cfg: 8.0,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1.0,
    })
    expect(n.controllers).toEqual({ seed: 'randomize' })
  })

  it('tolerates a missing controller extra (older serializations)', () => {
    const { document, diagnostics } = importLitegraph(
      ksampler([42, 20, 8.0, 'euler', 'normal', 1.0]),
      resolve,
    )
    // No mode string after seed: 20 must land on steps, not be eaten.
    const n = document!.graphs[document!.root]!.nodes['n1']!
    expect(n.values['seed']).toBe(42)
    expect(n.values['steps']).toBe(20)
    expect(n.controllers).toBeUndefined()
    expect(errorsOf(diagnostics)).toEqual([])
  })

  it('reports missing positional values instead of inventing them', () => {
    const { document, diagnostics } = importLitegraph(ksampler([42, 'fixed']), resolve)
    const n = document!.graphs[document!.root]!.nodes['n1']!
    expect(n.values).toEqual({ seed: 42 })
    expect(n.controllers).toEqual({ seed: 'fixed' })
    expect(codesOf(diagnostics)).toContain('import.widgets.missing')
  })

  it('parks excess positional values for review instead of shifting them', () => {
    const { document, diagnostics } = importLitegraph(
      ksampler([42, 'fixed', 20, 8.0, 'euler', 'normal', 1.0, 'EXTRA1', 'EXTRA2']),
      resolve,
    )
    const n = document!.graphs[document!.root]!.nodes['n1']!
    expect(n.values['denoise']).toBe(1.0)
    expect(n.ext?.['importer.rawWidgetValues']).toBeUndefined()
    expect(n.ext?.['importer.excessWidgetValues']).toEqual(['EXTRA1', 'EXTRA2'])
    expect(codesOf(diagnostics)).toContain('import.widgets.excess')
  })

  it('imports keyed (object-form) widget values directly', () => {
    const json = workflow([
      lgNode(1, 'CLIPTextEncode', {
        widgets_values: { text: 'hello', bogus: 1 },
      }),
    ])
    const { document, diagnostics } = importLitegraph(json, resolve)
    const n = document!.graphs[document!.root]!.nodes['n1']!
    expect(n.values).toEqual({ text: 'hello' })
    expect(n.ext?.['importer.unknownWidgetValues']).toEqual({ bogus: 1 })
    expect(codesOf(diagnostics)).toContain('import.widgets.unknownKeys')
  })

  it('normalizes numeric strings according to legacy widget schemas', () => {
    const schema = sdSchema('dinkster.numeric', 'Numeric', [
      sdInput('count', 'core.int', 'INT'),
      sdInput('strength', 'core.float', 'FLOAT'),
    ])
    const localResolve = (type: string) => type === schema.type ? schema : undefined
    const positional = importLitegraph(workflow([
      lgNode(1, schema.type, { widgets_values: ['1536', '1.25e-1'] }),
    ]), localResolve)
    const keyed = importLitegraph(workflow([
      lgNode(1, schema.type, { widgets_values: { count: '2048', strength: '.5' } }),
    ]), localResolve)
    expect(positional.document!.graphs.g0!.nodes.n1!.values).toEqual({ count: 1536, strength: 0.125 })
    expect(keyed.document!.graphs.g0!.nodes.n1!.values).toEqual({ count: 2048, strength: 0.5 })
  })

  it('migrates a valid legacy SAVE_TARGET prefix from the declared mount', () => {
    const target = {
      ...sdInput('filename_prefix', 'dinkster.save_target', 'SAVE_TARGET'),
      widget: { widgetType: 'SAVE_TARGET', options: {}, default: { mount: 'comfy-output', prefix: 'ComfyUI' } },
    } satisfies InputSpec
    const schema = sdSchema('dinkster.save', 'SaveImage', [target], true)
    const localResolve = (type: string) => type === schema.type || schema.aliases?.includes(type) ? schema : undefined
    const imported = importLitegraph(workflow([
      lgNode(1, 'SaveImage', { widgets_values: ['SD1.5'] }),
    ]), localResolve)
    expect(imported.diagnostics).toEqual([])
    expect(imported.document!.graphs.g0!.nodes.n1!.values.filename_prefix).toEqual({
      mount: 'comfy-output', prefix: 'SD1.5',
    })
    const reopened = loadDocument(JSON.parse(JSON.stringify(imported.document)))
    expect(reopened.diagnostics).toEqual([])
    const compiled = compile({
      document: reopened.document!, revision: 1, resolve: localResolve,
      scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'save-target-test',
    })
    expect(compiled.ok).toBe(true)
    if (compiled.ok) expect(compiled.artifact.prompt.n1!.inputs.filename_prefix).toEqual({
      mount: 'comfy-output', prefix: 'SD1.5',
    })
  })

  it('keeps invalid legacy SAVE_TARGET strings raw and warns specifically', () => {
    const target = {
      ...sdInput('target', 'dinkster.save_target', 'SAVE_TARGET'),
      widget: { widgetType: 'SAVE_TARGET', options: {}, default: { mount: 'comfy-output', prefix: 'ComfyUI' } },
    } satisfies InputSpec
    const schema = sdSchema('dinkster.save', 'Save', [target])
    const imported = importLitegraph(workflow([
      lgNode(1, 'Save', { widgets_values: ['../escape'] }),
    ]), (type) => type === schema.type || schema.aliases?.includes(type) ? schema : undefined)
    expect(imported.document!.graphs.g0!.nodes.n1!.values.target).toBe('../escape')
    expect(codesOf(imported.diagnostics)).toContain('import.saveTarget.invalidLegacy')
  })

  it.each([
    ['empty prefix', '', { mount: 'comfy-output', prefix: 'ComfyUI' }],
    ['missing default', 'safe/name', undefined],
    ['raw default', 'safe/name', 'ComfyUI'],
    ['invalid default mount', 'safe/name', { mount: '../output', prefix: 'ComfyUI' }],
    ['invalid default prefix', 'safe/name', { mount: 'comfy-output', prefix: '../escape' }],
  ] as const)('keeps %s raw when SAVE_TARGET migration lacks a valid result', (_label, raw, declaredDefault) => {
    const widget = declaredDefault === undefined
      ? { widgetType: 'SAVE_TARGET', options: {} }
      : { widgetType: 'SAVE_TARGET', options: {}, default: declaredDefault }
    const target: InputSpec = {
      kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: false, widget,
    }
    const schema = sdSchema('dinkster.save', 'Save', [target])
    const imported = importLitegraph(workflow([
      lgNode(1, 'Save', { widgets_values: [raw] }),
    ]), (type) => type === schema.type || schema.aliases?.includes(type) ? schema : undefined)
    expect(imported.document!.graphs.g0!.nodes.n1!.values.target).toBe(raw)
    expect(codesOf(imported.diagnostics).filter((code) => code === 'import.saveTarget.invalidLegacy')).toHaveLength(1)
  })

  it('normalizes keyed SAVE_TARGET values inside the active DynamicCombo branch', () => {
    const target: InputSpec = {
      kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: false,
      widget: { widgetType: 'SAVE_TARGET', options: {}, default: { mount: 'archive', prefix: 'default' } },
    }
    const schema = sdSchema('dinkster.dynamic-save', 'DynamicSave', [{
      kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'file', inputs: [target] }] },
    }])
    const imported = importLitegraph(workflow([
      lgNode(1, 'DynamicSave', { widgets_values: { mode: 'file', 'mode.target': 'daily/render' } }),
    ]), (type) => type === schema.type || schema.aliases?.includes(type) ? schema : undefined)
    expect(imported.diagnostics).toEqual([])
    expect(imported.document!.graphs.g0!.nodes.n1!.dynamic).toEqual({ mode: { selected: 'file' } })
    expect(imported.document!.graphs.g0!.nodes.n1!.values['mode.target']).toEqual({
      mount: 'archive', prefix: 'daily/render',
    })
  })

  it('normalizes positional SAVE_TARGET values inside a wire-15 DynamicCombo branch', () => {
    const target: InputSpec = {
      kind: 'input', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: false,
      widget: { widgetType: 'SAVE_TARGET', options: {}, default: { mount: 'archive', prefix: 'default' } },
    }
    const schema = sdSchema('dinkster.dynamic-save', 'DynamicSave', [{
      kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'file', inputs: [target] }] },
    }], true)
    const localResolve = (type: string) => type === schema.type || schema.aliases?.includes(type) ? schema : undefined
    const imported = importLitegraph(workflow([
      lgNode(1, 'DynamicSave', { widgets_values: ['file', 'daily/render'] }),
    ]), localResolve)
    expect(imported.diagnostics).toEqual([])
    expect(imported.document!.graphs.g0!.nodes.n1!.values['mode.target']).toEqual({
      mount: 'archive', prefix: 'daily/render',
    })
    const compiled = compile({
      document: imported.document!, revision: 1, resolve: localResolve,
      scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'dynamic-save-target-test',
    })
    expect(compiled.ok).toBe(true)
    if (compiled.ok) expect(compiled.artifact.prompt.n1!.inputs['mode.target']).toEqual({
      mount: 'archive', prefix: 'daily/render',
    })
  })

  it('parks raw values of unknown node types without guessing', () => {
    const json = workflow([lgNode(1, 'TotallyMadeUpNode', { widgets_values: [1, 'two'] })])
    const { document, diagnostics } = importLitegraph(json, resolve)
    const n = document!.graphs[document!.root]!.nodes['n1']!
    expect(n.values).toEqual({})
    expect(n.ext?.['importer.rawWidgetValues']).toEqual([1, 'two'])
    expect(codesOf(diagnostics)).toContain('import.schema.missing')
  })

  it('imports ColorTransfer DynamicCombo selection without shifting strength', () => {
    const floatSource: NodeSchema = {
      type: 'FloatSource',
      displayName: 'Float Source',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'FLOAT' } }],
    }
    const localResolve = (type: string) => type === floatSource.type ? floatSource : resolve(type)
    const json = workflow(
      [
        lgNode(1, 'ColorTransfer', {
          inputs: [{ name: 'image_target' }, { name: 'image_ref' }, { name: 'strength', link: 1 }],
          outputs: [{ name: 'image' }],
          widgets_values: ['reinhard_lab', 'uniform', 0.75],
        }),
        lgNode(2, floatSource.type, { outputs: [{ name: 'FLOAT', links: [1] }] }),
      ],
      [lgLink(1, 2, 0, 1, 2)],
    )
    const { document, diagnostics } = importLitegraph(json, localResolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const imported = document!.graphs[document!.root]!.nodes['n1']!
    expect(imported.values).toEqual({ method: 'reinhard_lab', strength: 0.75 })
    expect(imported.dynamic).toEqual({ source_stats: { selected: 'uniform' } })
    expect(imported.ext?.['importer.excessWidgetValues']).toBeUndefined()

    const reloaded = loadDocument(JSON.parse(JSON.stringify(document)))
    expect(errorsOf(reloaded.diagnostics)).toEqual([])
    const loaded = reloaded.document!.graphs[reloaded.document!.root]!.nodes['n1']!
    const elaborated = elaborateInterface(localResolve('ColorTransfer')!, loaded)
    expect(elabInputsOf(elaborated).find((item) => item.origin.kind === 'selector')?.derivedValue).toBe('uniform')
    expect(elabInputsOf(elaborated).map((item) => item.address.port)).toContain('strength')
    const solved = solveGraphTypes(reloaded.document!.graphs[reloaded.document!.root]!, localResolve)
    expect(solved.diagnostics).toEqual([])
    expect([...solved.linkVerdicts.values()]).toEqual(['ok'])
  })

  it('keeps ResizeImageMaskNode selector, active branch, and trailing combo aligned', () => {
    const localResolve = (type: string) => type === resizeImageMaskSchema.type ? resizeImageMaskSchema : undefined
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(1, resizeImageMaskSchema.type, {
        widgets_values: ['bicubic', 'scale dimensions', 640, 480, 'disabled'],
      })]),
      localResolve,
    )
    expect(errorsOf(diagnostics)).toEqual([])
    const imported = document!.graphs[document!.root]!.nodes.n1!
    expect(imported.dynamic).toEqual({ resize_type: { selected: 'scale dimensions' } })
    expect(imported.values).toEqual({
      scale_method: 'bicubic',
      'resize_type.width': 640,
      'resize_type.height': 480,
      'resize_type.crop': 'disabled',
    })
    expect(imported.ext?.['importer.excessWidgetValues']).toBeUndefined()

    const reloaded = loadDocument(JSON.parse(JSON.stringify(document)))
    expect(errorsOf(reloaded.diagnostics)).toEqual([])
    const inputs = elabInputsOf(elaborateInterface(resizeImageMaskSchema, reloaded.document!.graphs[reloaded.document!.root]!.nodes.n1!))
    expect(inputs.map((input) => input.address.port)).toEqual([
      'input',
      'scale_method',
      'resize_type',
      'resize_type.width',
      'resize_type.height',
      'resize_type.crop',
    ])
    expect(inputs.find((input) => input.address.port === 'scale_method')?.derivedValue).toBeUndefined()
  })

  it('recursively imports nested DynamicCombo values and controller companion state', () => {
    const widget = (id: string, widgetType: string, controller = false): InputSpec => ({
      kind: 'input',
      id,
      type: { kind: 'concrete', name: widgetType },
      optional: false,
      widget: { widgetType, options: {}, ...(controller ? { controller: 'after_generate' } : {}) },
    })
    const nestedSchema: NodeSchema = {
      type: 'NestedCombos',
      displayName: 'Nested Combos',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'model',
          type: { kind: 'concrete', name: 'COMBO' },
          optional: false,
          dynamic: {
            kind: 'dynamicCombo',
            options: [{
              key: 'outer',
              inputs: [
                widget('prompt', 'STRING'),
                {
                  kind: 'input',
                  id: 'mode',
                  type: { kind: 'concrete', name: 'COMBO' },
                  optional: false,
                  dynamic: {
                    kind: 'dynamicCombo',
                    options: [{ key: 'fine', inputs: [widget('quality', 'INT', true)] }],
                  },
                },
              ],
            }],
          },
        },
        widget('seed', 'INT'),
      ],
    }
    const nestedResolve = (type: string) => type === nestedSchema.type ? nestedSchema : undefined
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(1, nestedSchema.type, { widgets_values: ['outer', 'describe scene', 'fine', 9, 'increment', 42] })]),
      nestedResolve,
    )
    expect(errorsOf(diagnostics)).toEqual([])
    const imported = document!.graphs[document!.root]!.nodes['n1']!
    expect(imported.dynamic).toEqual({
      model: { selected: 'outer' },
      'model.[outer].mode': { selected: 'fine' },
    })
    expect(imported.values).toEqual({
      'model.[outer].prompt': 'describe scene',
      'model.[outer].mode.[fine].quality': 9,
      seed: 42,
    })
    expect(imported.controllers).toEqual({ 'model.[outer].mode.[fine].quality': 'increment' })
    expect(imported.ext?.['importer.excessWidgetValues']).toBeUndefined()

    const reloaded = loadDocument(JSON.parse(JSON.stringify(document)))
    expect(errorsOf(reloaded.diagnostics)).toEqual([])
    const loaded = reloaded.document!.graphs[reloaded.document!.root]!.nodes['n1']!
    expect(elabInputsOf(elaborateInterface(nestedSchema, loaded)).map((item) => item.address.port)).toEqual([
      'model',
      'model.[outer].prompt',
      'model.[outer].mode',
      'model.[outer].mode.[fine].quality',
      'seed',
    ])
    expect(solveGraphTypes(reloaded.document!.graphs[reloaded.document!.root]!, nestedResolve).diagnostics).toEqual([])
  })

  it('stops at an unknown DynamicCombo selector and parks the unaligned tail', () => {
    const schema = resolve('ColorTransfer')!
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(1, 'ColorTransfer', { widgets_values: ['mkl_lab', 'not-a-branch', 0.25] })]),
      () => schema,
    )
    const imported = document!.graphs[document!.root]!.nodes['n1']!
    expect(imported.values).toEqual({ method: 'mkl_lab' })
    expect(imported.dynamic).toBeUndefined()
    expect(imported.ext?.['importer.excessWidgetValues']).toEqual([0.25])
    expect(codesOf(diagnostics)).toContain('import.dynamic.unknownSelector')
    expect(elabInputsOf(elaborateInterface(schema, imported)).find((item) => item.origin.kind === 'selector')?.derivedValue).toBe('per_frame')
  })

  it('stops at nested Autogrow and parks all remaining positional values', () => {
    const autogrowSchema: NodeSchema = {
      type: 'ComboGrow',
      displayName: 'Combo Grow',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{
        kind: 'input',
        id: 'model',
        type: { kind: 'concrete', name: 'COMBO' },
        optional: false,
        dynamic: {
          kind: 'dynamicCombo',
          options: [{
            key: 'many',
            inputs: [
              { kind: 'input', id: 'prompt', type: { kind: 'concrete', name: 'STRING' }, optional: false, widget: { widgetType: 'STRING', options: {} } },
              {
                kind: 'input',
                id: 'images',
                type: { kind: 'wildcard' },
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  template: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
                  naming: { kind: 'prefix', prefix: 'image' },
                },
              },
              { kind: 'input', id: 'after', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {} } },
            ],
          }],
        },
      }],
    }
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(1, autogrowSchema.type, { widgets_values: ['many', 'before grow', 7, 8] })]),
      () => autogrowSchema,
    )
    const imported = document!.graphs[document!.root]!.nodes['n1']!
    expect(imported.values).toEqual({ 'model.[many].prompt': 'before grow' })
    expect(imported.ext?.['importer.excessWidgetValues']).toEqual([7, 8])
    expect(codesOf(diagnostics)).toContain('import.dynamic.autogrowUnsupported')
  })
})

describe('legacy save prefixes', () => {
  it('keeps V1 SaveImage filename_prefix as string data', () => {
    const saveImage = resolve('SaveImage')!
    const prefix = saveImage.items.find((item) => item.kind === 'input' && item.id === 'filename_prefix') as InputSpec
    expect(prefix.type).toEqual({ kind: 'concrete', name: 'STRING' })

    const result = importLitegraph(
      workflow([lgNode(1, 'SaveImage', { widgets_values: ['legacy/stem'] })]),
      resolve,
    )
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document!.graphs[result.document!.root]!.nodes.n1!.values.filename_prefix).toBe('legacy/stem')
  })
})

// -- Autogrow endpoint reconstruction ----------------------------------------

describe('Autogrow endpoint reconstruction', () => {
  const imageType = { kind: 'concrete', name: 'IMAGE' } as const
  const imageSource: NodeSchema = {
    type: 'ImageSource',
    displayName: 'Image Source',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'output', id: 'image', type: imageType }],
  }
  const input = (id: string): InputSpec => ({ kind: 'input', id, type: imageType, optional: false })

  const importFamily = (
    schema: NodeSchema,
    inputNames: string[],
    authoredType = schema.type,
    maintainedAlias = false,
  ) => {
    const sources = inputNames.map((_, index) => lgNode(index + 1, imageSource.type, {
      outputs: [{ name: 'IMAGE', links: [index + 1] }],
    }))
    const targetId = sources.length + 1
    const target = lgNode(targetId, authoredType, {
      inputs: inputNames.map((name, index) => ({ name, link: index + 1 })),
    })
    const links = inputNames.map((_, index) => lgLink(index + 1, index + 1, 0, targetId, index))
    const localResolve = (type: string) => type === imageSource.type ? imageSource : type === authoredType ? schema : undefined
    return {
      ...importLitegraph(
        workflow([...sources, target], links),
        localResolve,
        maintainedAlias ? (type) => type === authoredType : undefined,
      ),
      localResolve,
      targetId,
    }
  }

  it('preserves flat ComfyUI alias suffixes and authored input order', () => {
    const schema: NodeSchema = {
      type: 'comfy.ComfyAndNode',
      displayName: 'Comfy And',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{
        kind: 'input',
        id: 'values',
        type: { kind: 'wildcard' },
        optional: true,
        dynamic: {
          kind: 'autogrow',
          materialization: 'wire15',
          template: [input('value')],
          naming: { kind: 'prefix', prefix: 'value', min: 1 },
          ordinalOffset: 1,
        },
      }],
    }
    const { document, diagnostics, targetId } = importFamily(
      schema,
      ['value2', 'value1'],
      'ComfyAndNode',
      true,
    )
    expect(errorsOf(diagnostics)).toEqual([])
    const graph = document!.graphs[document!.root]!
    expect(graph.nodes[`n${targetId}`]!.dynamic).toEqual({
      values: { members: ['value2', 'value1'] },
    })
    expect(Object.values(graph.links).map((link) => link.to)).toEqual([
      { node: `n${targetId}`, port: 'values.value2' },
      { node: `n${targetId}`, port: 'values.value1' },
    ])
  })

  it('does not classify maintained alias static inputs as unknown family members', () => {
    const schema: NodeSchema = {
      type: 'comfy.MixedInputs',
      displayName: 'Mixed Inputs',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        input('fixed'),
        {
          kind: 'input',
          id: 'values',
          type: { kind: 'wildcard' },
          optional: true,
          dynamic: {
            kind: 'autogrow',
            materialization: 'wire15',
            template: [input('value')],
            naming: { kind: 'prefix', prefix: 'value', min: 1 },
            ordinalOffset: 1,
          },
        },
      ],
    }
    const { document, diagnostics, targetId } = importFamily(schema, ['fixed'], 'MixedInputs', true)
    expect(codesOf(diagnostics)).not.toContain('import.dynamic.autogrowWireUnknown')
    expect(document!.graphs.g0!.links.l1!.to).toEqual({ node: `n${targetId}`, port: 'fixed' })
  })

  it('decodes positional and keyed widgets for flat named alias members', () => {
    const scalar: InputSpec = {
      kind: 'input',
      id: 'value',
      type: { kind: 'concrete', name: 'core.float' },
      optional: false,
      widget: { widgetType: 'FLOAT', options: {}, default: 0 },
    }
    const schema: NodeSchema = {
      type: 'comfy.ComfyMathExpression',
      displayName: 'Comfy Math Expression',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{
        kind: 'input',
        id: 'values',
        type: { kind: 'wildcard' },
        optional: true,
        dynamic: {
          kind: 'autogrow',
          materialization: 'wire15',
          template: [scalar],
          naming: { kind: 'names', names: ['a', 'b'], min: 1 },
        },
      }],
    }
    const resolveAlias = (type: string) => type === 'ComfyMathExpression' ? schema : undefined
    const maintainedAlias = (type: string) => type === 'ComfyMathExpression'
    const positional = importLitegraph(workflow([
      lgNode(1, 'ComfyMathExpression', {
        inputs: [{ name: 'b' }, { name: 'a' }],
        widgets_values: [2, 1],
      }),
    ]), resolveAlias, maintainedAlias)
    expect(codesOf(positional.diagnostics)).not.toContain('import.dynamic.autogrowUnsupported')
    expect(positional.document!.graphs.g0!.nodes.n1).toMatchObject({
      dynamic: { values: { members: ['b', 'a'] } },
      values: { 'values.b': 2, 'values.a': 1 },
    })

    const keyed = importLitegraph(workflow([
      lgNode(1, 'ComfyMathExpression', {
        inputs: [{ name: 'b' }, { name: 'a' }],
        widgets_values: { b: 3, a: 4 },
      }),
    ]), resolveAlias, maintainedAlias)
    expect(codesOf(keyed.diagnostics)).not.toContain('import.widgets.unknownKeys')
    expect(keyed.document!.graphs.g0!.nodes.n1).toMatchObject({
      dynamic: { values: { members: ['b', 'a'] } },
      values: { 'values.b': 3, 'values.a': 4 },
    })
  })

  it('reconstructs prefix-family image0/image1 links as ordered persisted members', () => {
    const schema: NodeSchema = {
      type: 'ImageBatch', displayName: 'Image Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images', type: { kind: 'wildcard' }, optional: true,
        dynamic: { kind: 'autogrow', template: [input('image')], naming: { kind: 'prefix', prefix: 'image' } },
      }],
    }
    const { document, diagnostics, localResolve, targetId } = importFamily(schema, ['images.image0', 'images.image1'])
    expect(errorsOf(diagnostics)).toEqual([])
    const graph = document!.graphs[document!.root]!
    expect(graph.nodes[`n${targetId}`]!.dynamic).toEqual({ images: { members: ['m0', 'm1'], seq: 2 } })
    expect(Object.values(graph.links).map((link) => link.to)).toEqual([
      { node: `n${targetId}`, port: 'images.image', members: ['m0'] },
      { node: `n${targetId}`, port: 'images.image', members: ['m1'] },
    ])
    const solved = solveGraphTypes(graph, localResolve)
    expect(solved.diagnostics.filter((diagnostic) => diagnostic.code === 'solve.portMissing')).toEqual([])
    expect([...solved.linkVerdicts.values()]).toEqual(['ok', 'ok'])

    // Imported identities remain retired after their links are removed and
    // the user explicitly compacts. The next affordance must not recycle m0.
    const store = new DocumentStore(document!, coreCommandRegistry())
    for (const linkId of Object.keys(graph.links))
      expect(store.dispatch({ command: 'link.disconnect', params: { graphId: graph.id, linkId } }).ok).toBe(true)
    expect(store.dispatch({
      command: 'dynamic.compact',
      params: { graphId: graph.id, nodeId: `n${targetId}` },
    }).ok).toBe(true)
    const elaborated = elaborateInterface(schema, store.doc.graphs[graph.id]!.nodes[`n${targetId}`]!)
    expect(elabInputsOf(elaborated).find((item) => item.origin.kind === 'member' && item.origin.ghost)?.address.members)
      .toEqual(['m2'])
  })

  it('reconstructs grouped prefix and named-family wire variants', () => {
    const grouped: NodeSchema = {
      type: 'GroupedInputs', displayName: 'Grouped Inputs', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: true,
        dynamic: {
          kind: 'autogrow', template: [input('image'), input('mask')],
          naming: { kind: 'prefix', prefix: 'item' },
        },
      }],
    }
    const groupedResult = importFamily(grouped, ['items.item0.image', 'items.mask0'])
    const groupedGraph = groupedResult.document!.graphs[groupedResult.document!.root]!
    expect(groupedGraph.nodes[`n${groupedResult.targetId}`]!.dynamic).toEqual({ items: { members: ['m0'], seq: 1 } })
    expect(Object.values(groupedGraph.links).map((link) => link.to)).toEqual([
      { node: `n${groupedResult.targetId}`, port: 'items.image', members: ['m0'] },
      { node: `n${groupedResult.targetId}`, port: 'items.mask', members: ['m0'] },
    ])
    expect(solveGraphTypes(groupedGraph, groupedResult.localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])

    const named: NodeSchema = {
      type: 'NamedInputs', displayName: 'Named Inputs', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'channels', type: { kind: 'wildcard' }, optional: true,
        dynamic: {
          kind: 'autogrow', materialization: 'wire15', template: [input('image'), input('mask')],
          naming: { kind: 'names', names: ['left', 'right'] },
        },
      }],
    }
    const namedResult = importFamily(named, ['channels.right.image', 'channels.left.mask'])
    const namedGraph = namedResult.document!.graphs[namedResult.document!.root]!
    expect(namedGraph.nodes[`n${namedResult.targetId}`]!.dynamic).toEqual({ channels: { members: ['right', 'left'] } })
    expect(Object.values(namedGraph.links).map((link) => link.to)).toEqual([
      { node: `n${namedResult.targetId}`, port: 'channels.right.image' },
      { node: `n${namedResult.targetId}`, port: 'channels.left.mask' },
    ])
    expect(solveGraphTypes(namedGraph, namedResult.localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])
  })

  it('reconstructs an Autogrow family inside an active wire-15 DynamicCombo', () => {
    const schema: NodeSchema = {
      type: 'ComboBatch', displayName: 'Combo Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
        widget: { widgetType: 'COMBO', options: { options: ['batch'] } },
        dynamic: {
          kind: 'dynamicCombo', materialization: 'wire15', options: [{
            key: 'batch', inputs: [{
              kind: 'input', id: 'images', type: { kind: 'wildcard' }, optional: true,
              dynamic: {
                kind: 'autogrow', materialization: 'wire15', template: [input('image')],
                naming: { kind: 'prefix', prefix: 'image' },
              },
            }],
          }],
        },
      }],
    }
    const source = lgNode(1, imageSource.type, { outputs: [{ name: 'IMAGE', links: [1] }] })
    const target = lgNode(2, schema.type, {
      inputs: [{ name: 'mode.images.image0', link: 1 }],
      widgets_values: ['batch'],
    })
    const localResolve = (type: string) => type === imageSource.type ? imageSource : type === schema.type ? schema : undefined
    const { document, diagnostics } = importLitegraph(workflow([source, target], [lgLink(1, 1, 0, 2, 0)]), localResolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const graph = document!.graphs[document!.root]!
    expect(graph.nodes['n2']!.values).toEqual({})
    expect(graph.nodes['n2']!.dynamic).toEqual({ mode: { selected: 'batch' }, 'mode.images': { members: ['m0'], seq: 1 } })
    expect(graph.links['l1']!.to).toEqual({ node: 'n2', port: 'mode.images.m0' })
    expect(solveGraphTypes(graph, localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])
  })

  it('fills wire-15 minimum members without changing linked-member order', () => {
    const prefix: NodeSchema = {
      type: 'MinimumBatch', displayName: 'Minimum Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images', type: { kind: 'wildcard' }, optional: true,
        dynamic: {
          kind: 'autogrow', materialization: 'wire15', template: [input('image')],
          naming: { kind: 'prefix', prefix: 'image', min: 2 },
        },
      }],
    }
    const prefixResult = importFamily(prefix, ['images.image2'])
    const prefixGraph = prefixResult.document!.graphs[prefixResult.document!.root]!
    expect(prefixGraph.nodes[`n${prefixResult.targetId}`]!.dynamic).toEqual({ images: { members: ['m0', 'm1'], seq: 2 } })
    expect(solveGraphTypes(prefixGraph, prefixResult.localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])

    const names: NodeSchema = {
      type: 'MinimumNames', displayName: 'Minimum Names', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'channels', type: { kind: 'wildcard' }, optional: true,
        dynamic: {
          kind: 'autogrow', materialization: 'wire15', template: [input('image')],
          naming: { kind: 'names', names: ['left', 'right'], min: 2 },
        },
      }],
    }
    const namesResult = importFamily(names, ['channels.right'])
    const namesGraph = namesResult.document!.graphs[namesResult.document!.root]!
    expect(namesGraph.nodes[`n${namesResult.targetId}`]!.dynamic).toEqual({ channels: { members: ['right', 'left'] } })
    expect(solveGraphTypes(namesGraph, namesResult.localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])
  })

  it('preserves legacy names-family API identity when links arrive out of declaration order', () => {
    const schema: NodeSchema = {
      type: 'LegacyNames', displayName: 'Legacy Names', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'channels', type: { kind: 'wildcard' }, optional: true,
        dynamic: {
          kind: 'autogrow', template: [input('image')],
          naming: { kind: 'names', names: ['left', 'right'] },
        },
      }],
    }
    const { document, localResolve, targetId } = importFamily(schema, ['channels.right', 'channels.left'])
    const graph = document!.graphs[document!.root]!
    const node = graph.nodes[`n${targetId}`]!
    expect(node.dynamic).toEqual({ channels: { members: ['left', 'right'] } })
    const persisted = elabInputsOf(elaborateInterface(schema, node)).filter((item) => item.address.members !== undefined)
    expect(persisted.map((item) => [item.address.members, item.apiName])).toEqual([
      [['left'], 'channels.left'],
      [['right'], 'channels.right'],
    ])
    expect(solveGraphTypes(graph, localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])
  })

  it('rewrites value-source and named-net Autogrow sinks', () => {
    const schema: NodeSchema = {
      type: 'RoutedBatch', displayName: 'Routed Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images', type: { kind: 'wildcard' }, optional: true,
        dynamic: { kind: 'autogrow', template: [input('image')], naming: { kind: 'prefix', prefix: 'image' } },
      }],
    }
    const localResolve = (type: string) => type === imageSource.type ? imageSource : type === schema.type ? schema : undefined
    const primitive = importLitegraph(
      workflow([
        lgNode(1, 'PrimitiveNode', { outputs: [{ name: 'IMAGE', links: [1] }], widgets_values: ['asset'] }),
        lgNode(2, schema.type, { inputs: [{ name: 'images.image0', link: 1 }] }),
      ], [lgLink(1, 1, 0, 2, 0)]),
      localResolve,
    )
    expect(primitive.document!.graphs.g0!.links['l1']!.to).toEqual({ node: 'n2', port: 'images.image', members: ['m0'] })

    const net = importLitegraph(
      workflow([
        lgNode(1, imageSource.type, { outputs: [{ name: 'IMAGE', links: [1] }] }),
        lgNode(2, 'SetNode', {
          inputs: [{ name: 'value', link: 1 }], outputs: [{ name: '*' }], widgets_values: ['pictures'],
        }),
        lgNode(3, 'GetNode', { outputs: [{ name: 'value', links: [2] }], widgets_values: ['pictures'] }),
        lgNode(4, schema.type, { inputs: [{ name: 'images.image0', link: 2 }] }),
      ], [lgLink(1, 1, 0, 2, 0), lgLink(2, 3, 0, 4, 0)]),
      localResolve,
    )
    expect(Object.values(net.document!.graphs.g0!.nets)[0]!.sinks).toEqual([
      { node: 'n4', port: 'images.image', members: ['m0'] },
    ])
  })

  it('assigns sparse and out-of-order prefix ordinals by observed input order', () => {
    const schema: NodeSchema = {
      type: 'SparseBatch', displayName: 'Sparse Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images', type: { kind: 'wildcard' }, optional: true,
        dynamic: { kind: 'autogrow', template: [input('image')], naming: { kind: 'prefix', prefix: 'image', max: 4 } },
      }],
    }
    const { document, localResolve, targetId } = importFamily(schema, ['images.image2', 'images.image0'])
    const graph = document!.graphs[document!.root]!
    expect(graph.nodes[`n${targetId}`]!.dynamic).toEqual({ images: { members: ['m0', 'm1'], seq: 2 } })
    expect(Object.values(graph.links).map((link) => link.to)).toEqual([
      { node: `n${targetId}`, port: 'images.image', members: ['m0'] },
      { node: `n${targetId}`, port: 'images.image', members: ['m1'] },
    ])
    expect(solveGraphTypes(graph, localResolve).diagnostics.filter((d) => d.code === 'solve.portMissing')).toEqual([])
  })

  it('reports unmatched family wire names and leaves them unresolved', () => {
    const schema: NodeSchema = {
      type: 'StrictBatch', displayName: 'Strict Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'images', type: { kind: 'wildcard' }, optional: true,
        dynamic: { kind: 'autogrow', template: [input('image')], naming: { kind: 'prefix', prefix: 'image' } },
      }],
    }
    for (const wire of ['images.imagery0', 'images.image00', 'images.image0.image']) {
      const { document, diagnostics, localResolve } = importFamily(schema, [wire])
      expect(codesOf(diagnostics), wire).toContain('import.dynamic.autogrowWireUnknown')
      const graph = document!.graphs[document!.root]!
      expect(solveGraphTypes(graph, localResolve).diagnostics.map((diagnostic) => diagnostic.code), wire).toContain('solve.portMissing')
    }

    const groupedNames: NodeSchema = {
      type: 'AmbiguousNames', displayName: 'Ambiguous Names', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'channels', type: { kind: 'wildcard' }, optional: true,
        dynamic: {
          kind: 'autogrow', template: [input('image'), input('mask')],
          naming: { kind: 'names', names: ['left', 'right'] },
        },
      }],
    }
    const ambiguous = importFamily(groupedNames, ['channels.right.image'])
    expect(codesOf(ambiguous.diagnostics)).toContain('import.dynamic.autogrowWireUnknown')
    expect(solveGraphTypes(
      ambiguous.document!.graphs[ambiguous.document!.root]!,
      ambiguous.localResolve,
    ).diagnostics.map((diagnostic) => diagnostic.code)).toContain('solve.portMissing')
  })

  it('imports and compiles structural bypass drops with exact first-hop attribution and no live-route warning', () => {
    const relay: NodeSchema = {
      type: 'ImportedRelay', displayName: 'Imported Relay', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        ...input('items'), optional: true,
        dynamic: {
          kind: 'autogrow', materialization: 'wire15', template: [input('value')],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
        },
      }, { kind: 'output', id: 'image', type: imageType }],
    }
    const sink: NodeSchema = {
      type: 'ImportedSink', displayName: 'Imported Sink', category: 'test', source: 'v3', isOutputNode: true,
      items: [{
        ...input('items'), optional: true,
        dynamic: {
          kind: 'autogrow', materialization: 'wire15', template: [input('value')],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
        },
      }],
    }
    const localResolve = (type: string) => type === imageSource.type
      ? imageSource
      : type === relay.type
        ? relay
        : type === sink.type
          ? sink
          : undefined
    const imported = (deadMode: 0 | 2) => importLitegraph(workflow([
      lgNode(1, imageSource.type, { mode: deadMode, outputs: [{ name: 'IMAGE', links: [1] }] }),
      lgNode(2, imageSource.type, { outputs: [{ name: 'IMAGE', links: [2] }] }),
      lgNode(3, relay.type, {
        mode: 4,
        inputs: [{ name: 'items.item0', link: 1 }, { name: 'items.item1', link: 2 }],
        outputs: [{ name: 'IMAGE', links: [3] }],
      }),
      lgNode(4, relay.type, {
        mode: 4,
        inputs: [{ name: 'items.item0', link: 3 }],
        outputs: [{ name: 'IMAGE', links: [4] }],
      }),
      lgNode(5, sink.type, { inputs: [{ name: 'items.item0', link: 4 }] }),
    ], [
      lgLink(1, 1, 0, 3, 0), lgLink(2, 2, 0, 3, 1),
      lgLink(3, 3, 0, 4, 0), lgLink(4, 4, 0, 5, 0),
    ]), localResolve)
    const compileImported = (deadMode: 0 | 2) => {
      const result = imported(deadMode)
      expect(errorsOf(result.diagnostics)).toEqual([])
      expect(result.document!.graphs.g0!.nodes.n3!.mode).toBe('bypassed')
      expect(result.document!.graphs.g0!.nodes.n4!.mode).toBe('bypassed')
      expect(result.document!.graphs.g0!.links.l3!.to).toEqual({ node: 'n4', port: 'items.m0' })
      expect(result.document!.graphs.g0!.links.l4!.to).toEqual({ node: 'n5', port: 'items.m0' })
      return compile({
        document: result.document!, revision: 1, resolve: localResolve,
        scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'import-routing',
      })
    }

    const live = compileImported(0)
    expect(live.ok, JSON.stringify(!live.ok && live.diagnostics)).toBe(true)
    if (live.ok) {
      expect(codesOf(live.artifact.diagnostics)).not.toContain('compile.bypass.structuralRouteDropped')
      expect(live.artifact.prompt.n5!.inputs['items.m0']).toEqual(['n1', 0])
    }

    const dead = compileImported(2)
    expect(dead.ok, JSON.stringify(!dead.ok && dead.diagnostics)).toBe(true)
    if (!dead.ok) return
    const warnings = dead.artifact.diagnostics.filter((diagnostic) =>
      diagnostic.code === 'compile.bypass.structuralRouteDropped')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.anchor?.occurrence).toEqual({ instancePath: [], node: 'n4' })
    expect(warnings[0]!.message).toContain("input 'items.m0' at index 0")
    expect(warnings[0]!.message).toContain('through [n4, n3]')
    expect(warnings[0]!.message).toContain("producer 'n1' is muted or in an inactive occurrence")
    expect(dead.artifact.prompt.n5!.inputs).toEqual({})
  })
})

// -- modes ---------------------------------------------------------------------

describe('node modes', () => {
  it.each([
    [0, undefined],
    [1, undefined],
    [2, 'muted'],
    [4, 'bypassed'],
  ] as const)('litegraph mode %i imports as %s', (lgMode, expected) => {
    const json = workflow([lgNode(1, 'CLIPTextEncode', { mode: lgMode, widgets_values: ['x'] })])
    const { document } = importLitegraph(json, resolve)
    expect(document!.graphs[document!.root]!.nodes['n1']!.mode).toBe(expected)
  })

  it('warns on unknown modes and imports as active', () => {
    const json = workflow([lgNode(1, 'CLIPTextEncode', { mode: 3, widgets_values: ['x'] })])
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document!.graphs[document!.root]!.nodes['n1']!.mode).toBeUndefined()
    expect(codesOf(diagnostics)).toContain('import.node.mode')
  })
})

// -- malformed input -----------------------------------------------------------

describe('malformed input', () => {
  it('rejects duplicate node IDs instead of overwriting the first node', () => {
    const json = workflow([
      lgNode(1, 'CheckpointLoaderSimple', { widgets_values: ['first.safetensors'] }),
      lgNode(1, 'CLIPTextEncode', { widgets_values: ['second'] }),
    ])
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.node.duplicateId')
  })

  it('rejects duplicate link IDs instead of overwriting the first link', () => {
    const json = workflow(
      [
        lgNode(1, 'CheckpointLoaderSimple', { outputs: [{ name: 'MODEL' }, { name: 'CLIP' }] }),
        lgNode(2, 'CLIPTextEncode', { inputs: [{ name: 'clip' }], widgets_values: ['x'] }),
      ],
      [lgLink(1, 1, 1, 2, 0), lgLink(1, 1, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.link.duplicateId')
  })

  // Non-finite values (NaN/Infinity) never reach the per-field checks: the
  // ownJson ingress boundary rejects the whole workflow as not-JSON first.
  // The per-field CO9 codes cover FINITE-but-invalid values.
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe node ID %s', (id) => {
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(id, 'CLIPTextEncode', { widgets_values: ['x'] })]),
      resolve,
    )
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.node.invalidId')
  })

  it('rejects a non-finite node ID at the ingress boundary', () => {
    const { document, diagnostics } = importLitegraph(
      workflow([lgNode(Number.POSITIVE_INFINITY, 'CLIPTextEncode', { widgets_values: ['x'] })]),
      resolve,
    )
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.notJson')
  })

  it.each([
    ['link ID', lgLink(-1, 1, 0, 2, 0)],
    ['source node ID', lgLink(1, 1.5, 0, 2, 0)],
    ['source slot', lgLink(1, 1, Number.MAX_SAFE_INTEGER + 1, 2, 0)],
    ['target node ID', lgLink(1, 1, 0, Number.MAX_SAFE_INTEGER + 1, 0)],
    ['target slot', lgLink(1, 1, 0, 2, -1)],
  ])('rejects an unsafe %s in a link', (_field, link) => {
    const { document, diagnostics } = importLitegraph(workflow([], [link]), resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.link.invalidId')
  })

  it.each([
    ['position', { pos: [Number.NaN, 0] }],
    ['size', { size: [100, Number.POSITIVE_INFINITY] }],
  ])('rejects non-finite node %s geometry at the ingress boundary', (_field, geometry) => {
    const node = { ...lgNode(7, 'CLIPTextEncode', { widgets_values: ['x'] }), ...geometry }
    const { document, diagnostics } = importLitegraph(workflow([node]), resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.notJson')
  })

  it('rejects finite-but-fractional node geometry with the per-node code', () => {
    const node = { ...lgNode(7, 'CLIPTextEncode', { widgets_values: ['x'] }), pos: ['a', 0] }
    const { document, diagnostics } = importLitegraph(workflow([node]), resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.node.geometry')
    expect(diagnostics.find((d) => d.code === 'import.node.geometry')?.message).toContain('node 7')
  })

  it('imports a valid workflow unchanged after hostile-value validation', () => {
    const { document, diagnostics } = importLitegraph(basicPair(), resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    expect(Object.keys(document!.graphs.g0!.nodes)).toEqual(['n1', 'n2'])
    expect(Object.keys(document!.graphs.g0!.links)).toEqual(['l1'])
    expect(document!.view.graphs.g0!.nodes['n1']!.position).toEqual({ x: 100, y: 0 })
  })

  it('rejects a workflow whose values are not JSON (Infinity widget value) at ingress', () => {
    const node = lgNode(7, 'CLIPTextEncode', { widgets_values: [Number.POSITIVE_INFINITY] })
    const { document, diagnostics } = importLitegraph(workflow([node]), resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.notJson')
  })

  it('never invokes accessor properties on the foreign workflow JSON', () => {
    let invoked = false
    const hostile = workflow([lgNode(1, 'CLIPTextEncode', { widgets_values: ['x'] })])
    Object.defineProperty(hostile, 'extra', {
      enumerable: true,
      get() {
        invoked = true
        return {}
      },
    })
    const { document, diagnostics } = importLitegraph(hostile, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.notJson')
    expect(invoked).toBe(false)
  })

  it('returns a deep-frozen owned document (same ownership contract as loadDocument)', () => {
    const { document } = importLitegraph(basicPair(), resolve)
    expect(Object.isFrozen(document)).toBe(true)
    expect(Object.isFrozen(document!.graphs.g0!.nodes['n1'])).toBe(true)
    expect(Object.isFrozen(document!.graphs.g0!.nodes['n1']!.values)).toBe(true)
    expect(Object.isFrozen(document!.view.graphs.g0!.nodes['n1'])).toBe(true)
  })

  it('drops malformed link entries and nodes with diagnostics', () => {
    const json = workflow(
      [lgNode(1, 'CLIPTextEncode', { widgets_values: ['x'] }), { type: 'NoId' }],
      [[1, 2], 'garbage'],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeDefined()
    expect(codesOf(diagnostics)).toContain('import.link.malformed')
    expect(codesOf(diagnostics)).toContain('import.node.malformed')
  })

  it('drops links referencing missing nodes', () => {
    const json = workflow(
      [lgNode(2, 'CLIPTextEncode', { inputs: [{ name: 'clip', link: 1 }], widgets_values: ['x'] })],
      [lgLink(1, 99, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(Object.keys(document!.graphs[document!.root]!.links)).toEqual([])
    expect(codesOf(diagnostics)).toContain('import.link.dangling')
  })

  it('drops links to nonexistent input slots', () => {
    const json = workflow(
      [
        lgNode(1, 'CheckpointLoaderSimple', {
          outputs: [{ name: 'MODEL' }, { name: 'CLIP', links: [1] }],
          widgets_values: ['x'],
        }),
        lgNode(2, 'CLIPTextEncode', { inputs: [{ name: 'clip', link: null }], widgets_values: ['x'] }),
      ],
      [lgLink(1, 1, 1, 2, 5)],
    )
    const { diagnostics } = importLitegraph(json, resolve)
    expect(codesOf(diagnostics)).toContain('import.link.slot')
  })

  it('fails loudly on malformed subgraph definitions instead of dropping them', () => {
    const json = workflow([lgNode(1, 'CLIPTextEncode', { widgets_values: ['x'] })], [], {
      definitions: { subgraphs: [{ id: 'abc' }] },
    })
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.subgraphs.invalid')
  })

  it('accepts an empty subgraph-definition envelope', () => {
    const json = workflow([lgNode(1, 'CLIPTextEncode', { widgets_values: ['x'] })], [], {
      definitions: { subgraphs: [] },
    })
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    expect(document!.graphs.g0!.nodes.n1!.type).toBe('CLIPTextEncode')
  })

  it.each([
    ['non-array subgraphs', { subgraphs: { id: 'abc' } }],
    ['null definitions', null],
    ['array definitions', []],
    ['primitive definitions', 'subgraphs'],
  ])('refuses malformed %s', (_label, definitions) => {
    const json = workflow([lgNode(1, 'CLIPTextEncode', { widgets_values: ['x'] })], [], {
      definitions,
    })
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.subgraphs.invalid')
  })
})

// -- reroutes -------------------------------------------------------------------

describe('reroute import (first-class)', () => {
  const reroute = (id: number, inLink: number | null, outLinks: number[]) =>
    lgNode(id, 'Reroute', {
      inputs: [{ name: '', link: inLink }],
      outputs: [{ name: '', links: outLinks }],
    })

  const producer = (id: number, links: number[]) =>
    lgNode(id, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', links }, { name: 'VAE' }],
      widgets_values: ['x'],
    })
  const consumer = (id: number, link: number) =>
    lgNode(id, 'CLIPTextEncode', { inputs: [{ name: 'clip', link }], widgets_values: ['x'] })

  it('preserves a single reroute as a first-class junction with position', () => {
    const json = workflow(
      [producer(1, [10]), reroute(5, 10, [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 5, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    expect(g.nodes['n5']).toBeUndefined()
    expect(Object.keys(g.reroutes)).toEqual(['r5'])
    const links = Object.values(g.links)
    expect(links).toHaveLength(2)
    expect(links.find((l) => l.id === 'l10')!.from).toEqual({ node: 'n1', port: 'out1' })
    expect(links.find((l) => l.id === 'l10')!.to).toEqual({ reroute: 'r5' })
    expect(links.find((l) => l.id === 'l11')!.from).toEqual({ reroute: 'r5' })
    expect(links.find((l) => l.id === 'l11')!.to).toEqual({ node: 'n2', port: 'clip' })
    expect(document!.view.graphs[document!.root]?.reroutes?.['r5']?.position).toEqual({ x: 500, y: 0 })
    expect(codesOf(diagnostics)).toContain('import.reroute.converted')
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('preserves reroute chains and fan-out', () => {
    const json = workflow(
      [
        producer(1, [10]),
        reroute(5, 10, [11]),
        reroute(6, 11, [12, 13]),
        consumer(2, 12),
        consumer(3, 13),
      ],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 5, 0, 6, 0), lgLink(12, 6, 0, 2, 0), lgLink(13, 6, 0, 3, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    expect(Object.keys(g.reroutes).sort()).toEqual(['r5', 'r6'])
    const links = Object.values(g.links)
    expect(links).toHaveLength(4)
    expect(links.find((l) => l.id === 'l11')!.from).toEqual({ reroute: 'r5' })
    expect(links.find((l) => l.id === 'l11')!.to).toEqual({ reroute: 'r6' })
    const fanOut = links.filter((l) => 'reroute' in l.from && l.from.reroute === 'r6')
    expect(fanOut.map((l) => ('node' in l.to ? l.to.node : '')).sort()).toEqual(['n2', 'n3'])
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('keeps dangling reroutes, undriven, and their downstream links', () => {
    const json = workflow([reroute(5, null, [11]), consumer(2, 11)], [lgLink(11, 5, 0, 2, 0)])
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    expect(Object.keys(g.reroutes)).toEqual(['r5'])
    const links = Object.values(g.links)
    expect(links).toHaveLength(1)
    expect(links[0]!.from).toEqual({ reroute: 'r5' })
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('breaks reroute cycles with a diagnostic instead of hanging', () => {
    const json = workflow(
      [reroute(5, 11, [11, 12]), consumer(2, 12)],
      [lgLink(11, 5, 0, 5, 0), lgLink(12, 5, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeDefined()
    expect(codesOf(diagnostics)).toContain('import.reroute.cycle')
    const g = document!.graphs[document!.root]!
    // The self-loop link is dropped; the reroute and its consumer link stay.
    expect(Object.keys(g.reroutes)).toEqual(['r5'])
    expect(Object.keys(g.links)).toEqual(['l12'])
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('warns about untranslated native reroute waypoints (extra.reroutes)', () => {
    const json = workflow(
      [producer(1, [10]), consumer(2, 10)],
      [lgLink(10, 1, 1, 2, 0)],
      { extra: { reroutes: [{ id: 1, pos: [50, 60], linkIds: [10] }] } },
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    expect(codesOf(diagnostics)).toContain('import.reroute.nativeDropped')
    // Topology survives untouched: native waypoints are geometry only.
    expect(Object.keys(document!.graphs[document!.root]!.links)).toEqual(['l10'])
  })
})

// -- Set/Get -> named nets --------------------------------------------------------

describe('Set/Get to named nets', () => {
  const producer = (id: number, links: number[]) =>
    lgNode(id, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', links }, { name: 'VAE' }],
      widgets_values: ['x'],
    })
  const consumer = (id: number, link: number) =>
    lgNode(id, 'CLIPTextEncode', { inputs: [{ name: 'clip', link }], widgets_values: ['x'] })
  const setNode = (id: number, name: string, inLink: number | null, outLinks: number[] = []) =>
    lgNode(id, 'SetNode', {
      inputs: [{ name: '*', link: inLink }],
      outputs: [{ name: '*', links: outLinks }],
      widgets_values: [name],
    })
  const getNode = (id: number, name: string, outLinks: number[]) =>
    lgNode(id, 'GetNode', { outputs: [{ name: '*', links: outLinks }], widgets_values: [name] })

  it('converts a Set/Get pair into a named net', () => {
    const json = workflow(
      [producer(1, [10]), setNode(5, 'clip', 10), getNode(6, 'clip', [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    expect(Object.keys(g.links)).toEqual([])
    const nets = Object.values(g.nets)
    expect(nets).toHaveLength(1)
    expect(nets[0]!.name).toBe('clip')
    expect(nets[0]!.source).toEqual({ node: 'n1', port: 'out1' })
    expect(nets[0]!.sinks).toEqual([{ node: 'n2', port: 'clip' }])
    expect(g.nodes['n5']).toBeUndefined()
    expect(g.nodes['n6']).toBeUndefined()
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it("connects a SetNode's passthrough output directly to the origin", () => {
    const json = workflow(
      [producer(1, [10]), setNode(5, 'clip', 10, [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 5, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    const links = Object.values(g.links)
    expect(links).toHaveLength(1)
    expect(links[0]!.from).toEqual({ node: 'n1', port: 'out1' })
    expect(links[0]!.to).toEqual({ node: 'n2', port: 'clip' })
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('absorbs a reroute chain that feeds only a SetNode instead of leaving a dangling branch', () => {
    // producer -> Reroute(7) -> Reroute(8) -> Set('clip'); Get('clip') -> consumer.
    // The net delivers straight from the producer, so the reroutes are pure
    // net plumbing: they must vanish, not survive as producer->reroute stubs.
    const json = workflow(
      [
        producer(1, [10]),
        lgNode(7, 'Reroute', { inputs: [{ name: '', link: 10 }], outputs: [{ name: '', links: [13] }] }),
        lgNode(8, 'Reroute', { inputs: [{ name: '', link: 13 }], outputs: [{ name: '', links: [14] }] }),
        setNode(5, 'clip', 14),
        getNode(6, 'clip', [11]),
        consumer(2, 11),
      ],
      [lgLink(10, 1, 1, 7, 0), lgLink(13, 7, 0, 8, 0), lgLink(14, 8, 0, 5, 0), lgLink(11, 6, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    expect(codesOf(diagnostics)).toContain('import.reroute.absorbed')
    const g = document!.graphs[document!.root]!
    expect(Object.keys(g.reroutes)).toEqual([])
    expect(Object.keys(g.links)).toEqual([])
    const nets = Object.values(g.nets)
    expect(nets).toHaveLength(1)
    expect(nets[0]!.source).toEqual({ node: 'n1', port: 'out1' })
    expect(nets[0]!.sinks).toEqual([{ node: 'n2', port: 'clip' }])
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('keeps a reroute fanning out to both a SetNode and a real consumer', () => {
    // producer -> Reroute(7) -> { Set('clip'), consumer(2) }; Get('clip') -> consumer(3).
    const json = workflow(
      [
        producer(1, [10]),
        lgNode(7, 'Reroute', { inputs: [{ name: '', link: 10 }], outputs: [{ name: '', links: [13, 14] }] }),
        setNode(5, 'clip', 13),
        consumer(2, 14),
        getNode(6, 'clip', [11]),
        consumer(3, 11),
      ],
      [lgLink(10, 1, 1, 7, 0), lgLink(13, 7, 0, 5, 0), lgLink(14, 7, 0, 2, 0), lgLink(11, 6, 0, 3, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    // The junction survives for its real consumer...
    expect(Object.keys(g.reroutes)).toEqual(['r7'])
    const links = Object.values(g.links)
    expect(links).toHaveLength(2)
    expect(links).toContainEqual(
      expect.objectContaining({ from: { node: 'n1', port: 'out1' }, to: { reroute: 'r7' } }),
    )
    expect(links).toContainEqual(
      expect.objectContaining({ from: { reroute: 'r7' }, to: { node: 'n2', port: 'clip' } }),
    )
    // ...while the net still delivers straight from the producing output.
    const nets = Object.values(g.nets)
    expect(nets).toHaveLength(1)
    expect(nets[0]!.source).toEqual({ node: 'n1', port: 'out1' })
    expect(nets[0]!.sinks).toEqual([{ node: 'n3', port: 'clip' }])
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('routes Get behind a reroute into the net, not a direct link', () => {
    const json = workflow(
      [
        producer(1, [10]),
        setNode(5, 'clip', 10),
        getNode(6, 'clip', [11]),
        lgNode(7, 'Reroute', {
          inputs: [{ name: '', link: 11 }],
          outputs: [{ name: '', links: [12] }],
        }),
        consumer(2, 12),
      ],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 7, 0), lgLink(12, 7, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    expect(Object.keys(g.links)).toEqual([])
    expect(Object.values(g.nets)[0]!.sinks).toEqual([{ node: 'n2', port: 'clip' }])
  })

  it('collapses chained nets (Set fed by a Get) to the real origin', () => {
    const json = workflow(
      [
        producer(1, [10]),
        setNode(5, 'a', 10),
        getNode(6, 'a', [11]),
        setNode(7, 'b', 11),
        getNode(8, 'b', [12]),
        consumer(2, 12),
      ],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 7, 0), lgLink(12, 8, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    const g = document!.graphs[document!.root]!
    const byName = new Map(Object.values(g.nets).map((n) => [n.name, n]))
    expect(byName.get('a')!.source).toEqual({ node: 'n1', port: 'out1' })
    expect(byName.get('b')!.source).toEqual({ node: 'n1', port: 'out1' })
    expect(byName.get('b')!.sinks).toEqual([{ node: 'n2', port: 'clip' }])
    expect(errorsOf(checkDocument(document!))).toEqual([])
  })

  it('refuses a Get with no matching Set', () => {
    const json = workflow(
      [getNode(6, 'ghost', [11]), consumer(2, 11)],
      [lgLink(11, 6, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.net.danglingGet')
  })

  it('refuses Sets without a name or input', () => {
    const json = workflow(
      [producer(1, [10]), setNode(5, '', 10), setNode(9, 'orphan', null)],
      [lgLink(10, 1, 1, 5, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(errorsOf(diagnostics).filter((d) => d.code === 'import.net.danglingSet')).toHaveLength(2)
  })

  it('refuses Set/Get cycles', () => {
    const json = workflow(
      [getNode(6, 'a', [11]), setNode(5, 'a', 11), getNode(8, 'a', [12]), consumer(2, 12)],
      [lgLink(11, 6, 0, 5, 0), lgLink(12, 8, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.net.cycle')
  })

  it('refuses duplicate Set names instead of choosing a source', () => {
    const json = workflow(
      [producer(1, [10, 13]), setNode(5, 'clip', 10), setNode(7, 'clip', 13), getNode(6, 'clip', [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(13, 1, 1, 7, 0), lgLink(11, 6, 0, 2, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeUndefined()
    expect(codesOf(errorsOf(diagnostics))).toContain('import.net.duplicateSet')
  })

  it('preserves exact nonempty Set/Get names', () => {
    const { document, diagnostics } = importLitegraph(workflow(
      [producer(1, [10]), setNode(5, ' clip ', 10), getNode(6, ' clip ', [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 0)],
    ), resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    expect(Object.values(document!.graphs.g0!.nets).map((net) => net.name)).toEqual([' clip '])
  })

  it('refuses malformed node shapes and unsupported slots', () => {
    const malformed = importLitegraph(workflow([
      producer(1, [10]),
      lgNode(5, 'SetNode', { inputs: [{ name: '*', link: 10 }], widgets_values: ['clip'] }),
    ], [lgLink(10, 1, 1, 5, 0)]), resolve)
    expect(malformed.document).toBeUndefined()
    expect(codesOf(errorsOf(malformed.diagnostics))).toContain('import.net.nodeInvalid')

    const unsupportedSlot = importLitegraph(workflow(
      [producer(1, [10]), setNode(5, 'clip', 10), getNode(6, 'clip', [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 1, 2, 0)],
    ), resolve)
    expect(unsupportedSlot.document).toBeUndefined()
    expect(codesOf(errorsOf(unsupportedSlot.diagnostics))).toContain('import.net.wireInvalid')

    const wrongInputLink = importLitegraph(workflow(
      [producer(1, [10]), setNode(5, 'clip', 10), consumer(2, 10)],
      [lgLink(10, 1, 1, 2, 0)],
    ), resolve)
    expect(wrongInputLink.document).toBeUndefined()
    expect(codesOf(errorsOf(wrongInputLink.diagnostics))).toContain('import.net.wireInvalid')

    const ambiguousInput = importLitegraph(workflow(
      [producer(1, [10]), producer(9, [12]), setNode(5, 'clip', 10)],
      [lgLink(10, 1, 1, 5, 0), lgLink(12, 9, 1, 5, 0)],
    ), resolve)
    expect(ambiguousInput.document).toBeUndefined()
    expect(codesOf(errorsOf(ambiguousInput.diagnostics))).toContain('import.net.wireInvalid')

    const staleOutputLinks = importLitegraph(workflow(
      [producer(1, [10]), setNode(5, 'clip', 10), getNode(6, 'clip', [11, 12]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 0)],
    ), resolve)
    expect(staleOutputLinks.document).toBeUndefined()
    expect(codesOf(errorsOf(staleOutputLinks.diagnostics))).toContain('import.net.wireInvalid')

    const missingSourceSlot = importLitegraph(workflow(
      [
        producer(1, [10]), setNode(5, 'clip', 10),
        getNode(6, 'clip', [11]), consumer(2, 11),
      ],
      [lgLink(10, 1, 9, 5, 0), lgLink(11, 6, 0, 2, 0)],
    ), resolve)
    expect(missingSourceSlot.document).toBeUndefined()
    expect(codesOf(errorsOf(missingSourceSlot.diagnostics))).toContain('import.net.endpointUnavailable')

    const missingSinkSlot = importLitegraph(workflow(
      [producer(1, [10]), setNode(5, 'clip', 10), getNode(6, 'clip', [11]), consumer(2, 11)],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 9)],
    ), resolve)
    expect(missingSinkSlot.document).toBeUndefined()
    expect(codesOf(errorsOf(missingSinkSlot.diagnostics))).toContain('import.net.endpointUnavailable')

    const typeMismatch = importLitegraph(workflow(
      [
        lgNode(1, 'CheckpointLoaderSimple', {
          outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP', links: [10] }],
          widgets_values: ['x'],
        }),
        lgNode(5, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 10 }],
          outputs: [{ name: 'MODEL', type: 'MODEL' }],
          widgets_values: ['clip'],
        }),
        lgNode(6, 'GetNode', {
          outputs: [{ name: 'CLIP', type: 'CLIP', links: [11] }], widgets_values: ['clip'],
        }),
        consumer(2, 11),
      ],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 0)],
    ), resolve)
    expect(typeMismatch.document).toBeUndefined()
    expect(codesOf(errorsOf(typeMismatch.diagnostics))).toContain('import.net.typeMismatch')

    const sinkTypeMismatch = importLitegraph(workflow(
      [
        lgNode(1, 'CheckpointLoaderSimple', {
          outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP', links: [10] }],
          widgets_values: ['x'],
        }),
        setNode(5, 'clip', 10),
        getNode(6, 'clip', [11]),
        lgNode(2, 'CLIPTextEncode', {
          inputs: [{ name: 'clip', type: 'MODEL', link: 11 }], widgets_values: ['x'],
        }),
      ],
      [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 0)],
    ), resolve)
    expect(sinkTypeMismatch.document).toBeUndefined()
    expect(codesOf(errorsOf(sinkTypeMismatch.diagnostics))).toContain('import.net.typeMismatch')

    const linkTypeMismatch = importLitegraph(workflow(
      [
        lgNode(1, 'CheckpointLoaderSimple', {
          outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP', links: [10] }],
          widgets_values: ['x'],
        }),
        setNode(5, 'clip', 10),
        getNode(6, 'clip', [11]),
        lgNode(2, 'CLIPTextEncode', {
          inputs: [{ name: 'clip', type: 'CLIP', link: 11 }], widgets_values: ['x'],
        }),
      ],
      [[10, 1, 1, 5, 0, 'CLIP'], [11, 6, 0, 2, 0, 'MODEL']],
    ), resolve)
    expect(linkTypeMismatch.document).toBeUndefined()
    expect(codesOf(errorsOf(linkTypeMismatch.diagnostics))).toContain('import.net.typeMismatch')
  })
})

describe('Use Everywhere to named nets', () => {
  const maxUeLinks = 1024
  const producer = (links: number[] = [10]) => lgNode(1, 'CheckpointLoaderSimple', {
    outputs: [
      { name: 'MODEL', type: 'MODEL' },
      { name: 'CLIP', type: 'CLIP', links },
      { name: 'VAE', type: 'VAE' },
    ],
    widgets_values: ['x'],
  })
  const consumer = (link: number | null) => lgNode(2, 'CLIPTextEncode', {
    inputs: [{ name: 'clip', link }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['prompt'],
  })
  const controller = (inputLink: number | null = null) => lgNode(5, 'Anything Everywhere', {
    inputs: [{ name: 'anything', link: inputLink }],
  })
  const ue = (overrides: JsonObject = {}): JsonObject => ({
    downstream: 2, downstream_slot: 0, upstream: 1, upstream_slot: 1,
    controller: 5, type: 'CLIP', ...overrides,
  })

  it('uses the resolved manifest, excludes temporary links, and retains ordinary ue_convert nodes', () => {
    const ordinary = lgNode(6, 'CLIPTextEncode', {
      widgets_values: ['ordinary'], properties: { ue_convert: true },
    })
    const nodes = [producer(), consumer(10), controller(11), ordinary]
      .map((node) => ({ ...node, id: String(node.id) }))
    const result = importLitegraph(workflow(
      nodes,
      [[10, '1', 1, '2', 0], [11, '1', 1, '5', 0]],
      { extra: { ue_links: [ue({ downstream: '2', upstream: '1', controller: '5' })], links_added_by_ue: ['10'] } },
    ), resolve)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(codesOf(result.diagnostics)).toContain('import.ue.converted')
    const graph = result.document!.graphs.g0!
    expect(Object.keys(graph.links)).toEqual([])
    expect(graph.nodes.n5).toBeUndefined()
    expect(graph.nodes.n6).toBeDefined()
    expect(Object.values(graph.nets)).toEqual([expect.objectContaining({
      name: 'use_everywhere_0',
      source: { node: 'n1', port: 'out1' },
      sinks: [{ node: 'n2', port: 'clip' }],
    })])
  })

  it('accepts an ordinary producer enabled as a Use Everywhere broadcaster', () => {
    const broadcaster = lgNode(1, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE' }],
      widgets_values: ['x'],
      properties: {
        ue_convert: true,
        ue_properties: { output_not_broadcasting: { CLIP: false } },
      },
    })
    const result = importLitegraph(workflow(
      [broadcaster, consumer(null)],
      [],
      { extra: { ue_links: [ue({ controller: 1 })] } },
    ), resolve)

    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document!.graphs.g0!.nodes.n1).toBeDefined()
    expect(Object.values(result.document!.graphs.g0!.nets)).toEqual([expect.objectContaining({
      source: { node: 'n1', port: 'out1' },
      sinks: [{ node: 'n2', port: 'clip' }],
    })])
  })

  it('accepts every linked dynamic Anything Everywhere input', () => {
    const secondProducer = lgNode(9, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP', links: [12] }, { name: 'VAE' }],
      widgets_values: ['y'],
    })
    const secondConsumer = lgNode(3, 'CLIPTextEncode', {
      inputs: [{ name: 'clip', link: null }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['second'],
    })
    const dynamicController = lgNode(5, 'Anything Everywhere', {
      inputs: [
        { name: 'anything', link: 11 },
        { name: 'anything_1', link: 12 },
        { name: 'anything_2', link: null },
      ],
    })
    const result = importLitegraph(workflow(
      [producer([11]), secondProducer, consumer(null), secondConsumer, dynamicController],
      [lgLink(11, 1, 1, 5, 0), lgLink(12, 9, 1, 5, 1)],
      { extra: { ue_links: [ue(), ue({ downstream: 3, upstream: 9 })] } },
    ), resolve)

    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document!.graphs.g0!.nodes.n5).toBeUndefined()
    expect(Object.values(result.document!.graphs.g0!.nets).map((net) => net.source)).toEqual([
      { node: 'n1', port: 'out1' },
      { node: 'n9', port: 'out1' },
    ])
  })

  it('accepts an empty authoritative manifest and retains an enabled producer', () => {
    const broadcaster = lgNode(1, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE' }],
      widgets_values: ['x'],
      properties: { ue_convert: true },
    })
    const result = importLitegraph(workflow(
      [broadcaster],
      [],
      { extra: { ue_links: [] } },
    ), resolve)

    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.document!.graphs.g0!.nodes.n1).toBeDefined()
    expect(Object.values(result.document!.graphs.g0!.nets)).toEqual([])

    const stale = importLitegraph(workflow([
      lgNode(1, 'CheckpointLoaderSimple', {
        outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE' }],
        widgets_values: ['x'],
        properties: {
          ue_convert: true,
          ue_properties: { output_not_broadcasting: { CLPI: false } },
        },
      }),
    ], [], { extra: { ue_links: [] } }), resolve)
    expect(stale.document).toBeUndefined()
    expect(codesOf(errorsOf(stale.diagnostics))).toContain('import.ue.controllerStateInvalid')
  })

  it('refuses stale controller sources and invalid converted broadcasters', () => {
    const otherProducer = lgNode(9, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE' }],
      widgets_values: ['other'],
    })
    const converted = (ueProperties?: JsonObject | string) => lgNode(1, 'CheckpointLoaderSimple', {
      outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE' }],
      widgets_values: ['x'],
      properties: {
        ue_convert: true,
        ...(ueProperties !== undefined ? { ue_properties: ueProperties } : {}),
      },
    })
    const cases: [JsonObject, string][] = [
      [workflow(
        [producer([11]), otherProducer, consumer(null), controller(11)],
        [lgLink(11, 1, 1, 5, 0)],
        { extra: { ue_links: [ue({ upstream: 9 })] } },
      ), 'import.ue.controllerSourceMismatch'],
      [workflow(
        [converted(), otherProducer, consumer(null)],
        [],
        { extra: { ue_links: [ue({ upstream: 9, controller: 1 })] } },
      ), 'import.ue.controllerSourceMismatch'],
      [workflow(
        [converted({ output_not_broadcasting: { CLIP: true } }), consumer(null)],
        [],
        { extra: { ue_links: [ue({ controller: 1 })] } },
      ), 'import.ue.controllerOutputDisabled'],
      [workflow(
        [converted('invalid'), consumer(null)],
        [],
        { extra: { ue_links: [ue({ controller: 1 })] } },
      ), 'import.ue.controllerStateInvalid'],
      [workflow(
        [converted({ output_not_broadcasting: { CLIP: 'false' } }), consumer(null)],
        [],
        { extra: { ue_links: [ue({ controller: 1 })] } },
      ), 'import.ue.controllerStateInvalid'],
      [workflow(
        [converted({ output_not_broadcasting: { CLPI: true } }), consumer(null)],
        [],
        { extra: { ue_links: [ue({ controller: 1 })] } },
      ), 'import.ue.controllerStateInvalid'],
      [workflow([
        lgNode(1, 'CheckpointLoaderSimple', {
          outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }],
          properties: { ue_convert: 'true' }, widgets_values: ['x'],
        }),
        consumer(null),
      ]), 'import.ue.controllerStateInvalid'],
      [workflow(
        [producer([11]), consumer(null), controller(null)],
        [lgLink(11, 1, 1, 5, 0)],
        { extra: { ue_links: [ue()] } },
      ), 'import.ue.controllerStateInvalid'],
      [workflow(
        [producer([11]), consumer(null), controller(11)],
        [lgLink(11, 1, 1, 5, 1)],
        { extra: { ue_links: [ue()] } },
      ), 'import.ue.controllerStateInvalid'],
      [workflow([
        producer([11, 12]),
        consumer(null),
        lgNode(5, 'Anything Everywhere', {
          inputs: [{ name: 'anything', link: 11 }, { name: 'stale', link: 12 }],
        }),
        lgNode(9, 'CLIPTextEncode', { inputs: [{ name: 'clip', link: 12 }] }),
      ], [lgLink(11, 1, 1, 5, 0), lgLink(12, 1, 1, 9, 0)], {
        extra: { ue_links: [ue()] },
      }), 'import.ue.controllerStateInvalid'],
      [workflow(
        [producer([11]), consumer(null), controller(11)],
        [lgLink(11, 1, 1, 5, 0)],
        { extra: { ue_links: [ue({ type: 'MODEL' })] } },
      ), 'import.ue.sourceTypeMismatch'],
      [workflow(
        [producer([11]), consumer(null), controller(11)],
        [[11, 1, 1, 5, 0, 'MODEL']],
        { extra: { ue_links: [ue()] } },
      ), 'import.ue.sourceTypeMismatch'],
      [workflow([
        lgNode(1, 'CheckpointLoaderSimple', {
          outputs: [{ name: 'MODEL' }, { name: 'CLIP', type: 42 as unknown as string, links: [11] }],
          widgets_values: ['x'],
        }),
        consumer(null), controller(11),
      ], [lgLink(11, 1, 1, 5, 0)], {
        extra: { ue_links: [ue()] },
      }), 'import.ue.sourceTypeMismatch'],
      [workflow(
        [producer([11]), consumer(null), controller(11)],
        [[11, 1, 1, 5, 0, 42]],
        { extra: { ue_links: [ue()] } },
      ), 'import.ue.sourceTypeMismatch'],
      [workflow([
        producer([11]),
        lgNode(2, 'CLIPTextEncode', {
          inputs: [{ name: 'clip', type: 'MODEL', link: null }],
          outputs: [{ name: 'CONDITIONING' }],
          widgets_values: ['prompt'],
        }),
        controller(11),
      ], [lgLink(11, 1, 1, 5, 0)], {
        extra: { ue_links: [ue()] },
      }), 'import.ue.targetTypeMismatch'],
      [workflow([
        lgNode(5, 'Seed Everywhere', { outputs: [{ name: 'INT' }], widgets_values: [42, 'fixed'] }),
        consumer(null),
      ], [], {
        extra: { ue_links: [ue({ upstream: 5, upstream_slot: 0, controller: 5, type: 'FLOAT' })] },
      }), 'import.ue.controllerSourceMismatch'],
    ]
    for (const [input, code] of cases) {
      const result = importLitegraph(input, resolve)
      expect(result.document, code).toBeUndefined()
      expect(codesOf(errorsOf(result.diagnostics)), code).toContain(code)
    }
  })

  it('compiles ordinary links, Set/Get, and Use Everywhere to equivalent prompts', () => {
    const cases = [
      workflow([producer(), consumer(10)], [lgLink(10, 1, 1, 2, 0)]),
      workflow([
        producer(), consumer(11),
        lgNode(5, 'SetNode', {
          inputs: [{ name: '*', link: 10 }], outputs: [{ name: '*' }], widgets_values: ['clip'],
        }),
        lgNode(6, 'GetNode', { outputs: [{ name: '*', links: [11] }], widgets_values: ['clip'] }),
      ], [lgLink(10, 1, 1, 5, 0), lgLink(11, 6, 0, 2, 0)]),
      workflow(
        [producer([12]), consumer(null), controller(12)],
        [lgLink(12, 1, 1, 5, 0)],
        { extra: { ue_links: [ue()] } },
      ),
    ]
    const prompts = cases.map((input) => {
      const imported = importLitegraph(input, resolve)
      expect(errorsOf(imported.diagnostics)).toEqual([])
      const compiled = compile({
        document: imported.document!, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('c0'), schemaHash: 'equivalence',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('compile failed')
      return compiled.artifact.prompt
    })
    expect(prompts[1]).toEqual(prompts[0])
    expect(prompts[2]).toEqual(prompts[0])
  })

  it('preserves a mixed translation across repeated import, save/reopen, and compilation', () => {
    const secondConsumer = (link: number | null) => lgNode(3, 'CLIPTextEncode', {
      inputs: [{ name: 'clip', type: 'CLIP', link }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }],
      widgets_values: ['second prompt'],
    })
    const explicit = workflow(
      [producer([20, 21]), consumer(20), secondConsumer(21)],
      [lgLink(20, 1, 1, 2, 0), lgLink(21, 1, 1, 3, 0)],
    )
    const translated = workflow([
      producer([10, 12]),
      consumer(11),
      secondConsumer(null),
      lgNode(5, 'SetNode', {
        inputs: [{ name: '*', link: 10 }], outputs: [{ name: '*' }], widgets_values: ['clip'],
      }),
      lgNode(6, 'GetNode', { outputs: [{ name: '*', links: [11] }], widgets_values: ['clip'] }),
      lgNode(7, 'Anything Everywhere', { inputs: [{ name: 'anything', link: 12 }] }),
    ], [
      lgLink(10, 1, 1, 5, 0),
      lgLink(11, 6, 0, 2, 0),
      lgLink(12, 1, 1, 7, 0),
    ], {
      extra: { ue_links: [ue({ downstream: 3, controller: 7 })] },
    })

    const first = importLitegraph(translated, resolve)
    const repeated = importLitegraph(translated, resolve)
    expect(errorsOf(first.diagnostics)).toEqual([])
    expect(repeated).toEqual(first)
    expect(errorsOf(checkDocument(first.document!))).toEqual([])

    const reopened = loadDocument(JSON.parse(JSON.stringify(first.document)))
    expect(reopened.diagnostics).toEqual([])
    expect(reopened.document).toEqual(first.document)

    const explicitImport = importLitegraph(explicit, resolve)
    expect(errorsOf(explicitImport.diagnostics)).toEqual([])
    const prompts = [explicitImport.document!, first.document!, reopened.document!].map((document) => {
      const compiled = compile({
        document, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('c0'), schemaHash: 'mixed-import-equivalence',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('compile failed')
      return compiled.artifact.prompt
    })
    expect(prompts[1]).toEqual(prompts[0])
    expect(prompts[2]).toEqual(prompts[0])

    const graph = first.document!.graphs.g0!
    expect(Object.keys(graph.nodes).sort()).toEqual(['n1', 'n2', 'n3'])
    const nets = Object.values(graph.nets)
    expect(new Set(nets.map((net) => net.name)).size).toBe(nets.length)
    expect(nets).toEqual([
      expect.objectContaining({
        name: 'clip', source: { node: 'n1', port: 'out1' }, sinks: [{ node: 'n2', port: 'clip' }],
      }),
      expect.objectContaining({
        name: 'use_everywhere_0', source: { node: 'n1', port: 'out1' }, sinks: [{ node: 'n3', port: 'clip' }],
      }),
    ])
  })

  it('converts Seed Everywhere to PrimitiveInt and preserves execution semantics', () => {
    const intNode = (
      id: number,
      type: 'PrimitiveInt' | 'Seed Everywhere',
      link: number | null,
      converted = false,
    ) => lgNode(id, type, {
      ...(type === 'PrimitiveInt' ? { inputs: [{ name: 'value', link }] } : {}),
      outputs: [{ name: 'INT', type: 'INT', links: link === null ? [] : [10] }],
      widgets_values: [42, 'fixed'],
      ...(converted ? { properties: { ue_convert: true } } : {}),
    })
    const explicit = workflow(
      [intNode(5, 'PrimitiveInt', null), intNode(2, 'PrimitiveInt', 10)],
      [lgLink(10, 5, 0, 2, 0)],
    )
    const everywhere = workflow(
      [intNode(5, 'Seed Everywhere', null), intNode(2, 'PrimitiveInt', null)],
      [],
      { extra: { ue_links: [{ downstream: 2, downstream_slot: 0, upstream: 5, upstream_slot: 0, controller: 5, type: 'INT' }] } },
    )
    const convertedEverywhere = workflow(
      [intNode(5, 'PrimitiveInt', null, true), intNode(2, 'PrimitiveInt', null)],
      [],
      { extra: { ue_links: [{ downstream: 2, downstream_slot: 0, upstream: '5', upstream_slot: 0, controller: 5, type: 'INT' }] } },
    )
    const results = [explicit, everywhere, convertedEverywhere].map((input) => {
      const imported = importLitegraph(input, resolve)
      expect(errorsOf(imported.diagnostics)).toEqual([])
      const compiled = compile({
        document: imported.document!, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('c0'), schemaHash: 'seed-equivalence',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('compile failed')
      return { document: imported.document!, prompt: compiled.artifact.prompt }
    })
    expect(results[1]!.document.graphs.g0!.nodes.n5).toMatchObject({
      type: 'PrimitiveInt',
      values: { value: 42 },
      controllers: { value: 'fixed' },
    })
    expect(results[1]!.prompt).toEqual(results[0]!.prompt)
    expect(results[2]!.prompt).toEqual(results[0]!.prompt)
  })

  it('groups fanout by source and avoids existing named-net names', () => {
    const secondConsumer = lgNode(3, 'CLIPTextEncode', {
      inputs: [{ name: 'clip', link: null }], outputs: [{ name: 'CONDITIONING' }], widgets_values: ['second'],
    })
    const result = importLitegraph(workflow([
      producer([10, 11]),
      consumer(null),
      secondConsumer,
      controller(11),
      lgNode(6, 'SetNode', {
        inputs: [{ name: '*', link: 10 }], outputs: [{ name: '*' }], widgets_values: ['use_everywhere_0'],
      }),
    ], [lgLink(10, 1, 1, 6, 0), lgLink(11, 1, 1, 5, 0)], {
      extra: { ue_links: [ue(), ue({ downstream: 3 })] },
    }), resolve)
    expect(errorsOf(result.diagnostics)).toEqual([])
    const nets = new Map(Object.values(result.document!.graphs.g0!.nets).map((net) => [net.name, net]))
    expect(nets.get('use_everywhere_0')).toEqual(expect.objectContaining({ sinks: [] }))
    expect(nets.get('use_everywhere_1')).toEqual(expect.objectContaining({
      source: { node: 'n1', port: 'out1' },
      sinks: [{ node: 'n2', port: 'clip' }, { node: 'n3', port: 'clip' }],
    }))
  })

  it.each([
    ['noncanonical ID', ue({ upstream: '01' })],
    ['sentinel ID', ue({ upstream: -10 })],
    ['unsafe slot', ue({ downstream_slot: Number.MAX_SAFE_INTEGER + 1 })],
    ['empty type', ue({ type: '' })],
    ['extra field', ue({ priority: 1 })],
  ])('rejects a manifest entry with %s', (_label, entry) => {
    const result = importLitegraph(workflow([producer(), consumer(null), controller()], [], {
      extra: { ue_links: [entry] },
    }), resolve)
    expect(result.document).toBeUndefined()
    expect(codesOf(errorsOf(result.diagnostics))).toContain('import.ue.entryInvalid')
  })

  it('fails closed for missing endpoints, target conflicts, duplicate targets, bad controllers, and over-budget manifests', () => {
    const inputs: [JsonObject, string][] = [
      [workflow([producer(), consumer(null), controller()], [], { extra: { ue_links: [ue({ upstream: 99 })] } }), 'import.ue.nodeMissing'],
      [workflow(
        [producer([10, 11]), consumer(10), controller(11)],
        [lgLink(10, 1, 1, 2, 0), lgLink(11, 1, 1, 5, 0)],
        { extra: { ue_links: [ue()] } },
      ), 'import.ue.targetConflict'],
      [workflow(
        [producer([11]), consumer(null), controller(11)],
        [lgLink(11, 1, 1, 5, 0)],
        { extra: { ue_links: [ue(), ue({ upstream: '1' })] } },
      ), 'import.ue.targetDuplicate'],
      [workflow([producer(), consumer(null), lgNode(5, 'CLIPTextEncode')], [], { extra: { ue_links: [ue()] } }), 'import.ue.controllerInvalid'],
      [workflow(
        [producer([11]), consumer(null), controller(11)],
        [lgLink(11, 1, 9, 5, 0)],
        { extra: { ue_links: [ue({ upstream_slot: 9 })] } },
      ), 'import.ue.endpointUnavailable'],
      [workflow([
        producer([11]),
        consumer(10),
        lgNode(5, 'Anything Everywhere', {
          inputs: [{ name: 'anything', link: 11 }], outputs: [{ name: '*', links: [10] }],
        }),
      ], [lgLink(10, 5, 0, 2, 0), lgLink(11, 1, 1, 5, 0)], {
        extra: { ue_links: [ue()] },
      }), 'import.ue.controllerWireUnsupported'],
      [workflow([producer(), consumer(null), controller()], [], { extra: { ue_links: Array.from({ length: maxUeLinks + 1 }, () => ue()) } }), 'import.ue.manifestInvalid'],
    ]
    for (const [input, code] of inputs) {
      const result = importLitegraph(input, resolve)
      expect(result.document, code).toBeUndefined()
      expect(codesOf(errorsOf(result.diagnostics)), code).toContain(code)
    }
  })

  it('rejects malformed or absent temporary-link markers', () => {
    for (const [value, code] of [[['01'], 'import.ue.temporaryLinksInvalid'], [[10], 'import.ue.temporaryLinkMissing']] as const) {
      const result = importLitegraph(workflow([producer(), consumer(null), controller()], [], {
        extra: { ue_links: [ue()], links_added_by_ue: value },
      }), resolve)
      expect(result.document).toBeUndefined()
      expect(codesOf(errorsOf(result.diagnostics))).toContain(code)
    }
    const missingManifest = importLitegraph(workflow([producer(), consumer(10), controller()], [lgLink(10, 1, 1, 2, 0)], {
      extra: { links_added_by_ue: [10] },
    }), resolve)
    expect(missingManifest.document).toBeUndefined()
    expect(codesOf(errorsOf(missingManifest.diagnostics))).toContain('import.ue.manifestMissing')

    const missingControllerManifest = importLitegraph(workflow([
      producer(), consumer(null), controller(),
    ]), resolve)
    expect(missingControllerManifest.document).toBeUndefined()
    expect(codesOf(errorsOf(missingControllerManifest.diagnostics))).toContain('import.ue.manifestMissing')

    const missingConvertedManifest = importLitegraph(workflow([
      lgNode(1, 'CheckpointLoaderSimple', {
        outputs: [{ name: 'MODEL' }, { name: 'CLIP' }, { name: 'VAE' }],
        widgets_values: ['x'], properties: { ue_convert: true },
      }),
      consumer(null),
    ]), resolve)
    expect(missingConvertedManifest.document).toBeUndefined()
    expect(codesOf(errorsOf(missingConvertedManifest.diagnostics))).toContain('import.ue.manifestMissing')

    const unrelated = importLitegraph(workflow([producer(), consumer(10), controller()], [lgLink(10, 1, 0, 2, 0)], {
      extra: { ue_links: [ue()], links_added_by_ue: [10] },
    }), resolve)
    expect(unrelated.document).toBeUndefined()
    expect(codesOf(errorsOf(unrelated.diagnostics))).toContain('import.ue.temporaryLinkUnclaimed')
  })
})

// -- view extras ------------------------------------------------------------------

describe('view extras', () => {
  it('imports only an exact true flags.collapsed value as minimized view state', () => {
    const json = workflow([
      lgNode(1, 'CLIPTextEncode', { widgets_values: ['a'], flags: { collapsed: true } }),
      lgNode(2, 'CLIPTextEncode', { widgets_values: ['b'], flags: { collapsed: false } }),
      lgNode(3, 'CLIPTextEncode', { widgets_values: ['c'], flags: { collapsed: 'yes' } }),
    ])
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(errorsOf(diagnostics)).toEqual([])
    expect(document!.view.graphs.g0!.nodes.n1).toMatchObject({ collapsed: true })
    expect(document!.view.graphs.g0!.nodes.n2).not.toHaveProperty('collapsed')
    expect(document!.view.graphs.g0!.nodes.n3).not.toHaveProperty('collapsed')
  })

  it('imports groups', () => {
    const json = workflow([lgNode(1, 'CLIPTextEncode', { widgets_values: ['x'] })], [], {
      groups: [
        { title: 'Stage 1', bounding: [0, 0, 400, 300], color: '#3f789e' },
        { bounding: 'garbage' },
      ],
    })
    const { document, diagnostics } = importLitegraph(json, resolve)
    const groups = document!.view.graphs[document!.root]!.groups!
    expect(Object.keys(groups)).toEqual(['grp0'])
    expect(groups['grp0']).toMatchObject({
      id: 'grp0',
      title: 'Stage 1',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      color: '#3f789e',
    })
    expect(codesOf(diagnostics)).toContain('import.group.malformed')
  })

  it('imports Note nodes as visible virtual nodes', () => {
    const json = workflow([
      lgNode(1, 'Note', { pos: [50, 60], widgets_values: ['remember this'] }),
      lgNode(2, 'CLIPTextEncode', { widgets_values: ['x'] }),
    ])
    const { document, diagnostics } = importLitegraph(json, resolve)
    const g = document!.graphs[document!.root]!
    expect(g.nodes['n1']).toEqual({
      id: 'n1', type: 'dinkster.note', virtual: true,
      values: { text: 'remember this' },
    })
    expect(document!.view.graphs[document!.root]!.nodes['n1']).toEqual({
      position: { x: 50, y: 60 },
    })
    expect(codesOf(diagnostics)).not.toContain('import.schema.missing')
  })

  it('round-trips MarkdownNote text, geometry, and color', () => {
    const json = workflow([
      lgNode(7, 'MarkdownNote', {
        pos: [12, 34], size: [420, 210], widgets_values: ['# Heading'], color: '#335577',
      }),
    ])
    const { document } = importLitegraph(json, resolve)
    expect(document).toBeDefined()
    expect(exportVirtualNodesToLitegraph(document!)).toEqual([
      expect.objectContaining({
        type: 'MarkdownNote', pos: [12, 34], size: [420, 210],
        widgets_values: ['# Heading'], color: '#335577',
      }),
    ])
    expect(exportVirtualNodesToLitegraph(document!)[0]).not.toHaveProperty('bgcolor')
  })
})
