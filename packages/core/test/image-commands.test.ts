import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { compositorRecipeFingerprint, EMPTY_COMPOSITOR_RECIPE, type CompositorRecipe } from '../src/compositor.js'
import { createLocalSession, type SessionOp } from '../src/commands/session.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'
import { canonicalJson, sha256Hex } from '../src/compile/hash.js'

const SOURCE = `blake3:${'a'.repeat(64)}`
const REPLACEMENT = `blake3:${'b'.repeat(64)}`
const sourceRef = { digest: SOURCE, name: 'source.png', size: 10, mediaType: 'image/png', virtualPath: '' }
const replacementRef = { digest: REPLACEMENT, name: 'edited.png', size: 20, mediaType: 'image/png', virtualPath: '' }

const schema: NodeSchema = {
  type: 'LoadImage',
  displayName: 'Load Image',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [{
    kind: 'input',
    id: 'image',
    type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } },
    optional: false,
    widget: { widgetType: 'ASSET', options: {} },
  }],
}

function document(graph: GraphDef): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('image-command'),
    root: asGraphDefId('g0'),
    graphs: { g0: graph },
    view: { graphs: {} },
  }
}

function graph(): GraphDef {
  return {
    id: asGraphDefId('g0'),
    name: 'root',
    nodes: {
      image: { id: asNodeId('image'), type: 'LoadImage', values: { image: sourceRef } },
      source: { id: asNodeId('source'), type: 'Source', values: {} },
    },
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 1,
  }
}

const invocation = {
  command: 'image.applyAsset',
  params: {
    graphId: 'g0',
    nodeId: 'image',
    inputId: 'image',
    expectedSourceDigest: SOURCE,
    asset: replacementRef,
  },
}

function store(graphDef = graph(), resolvedSchema = schema): DocumentStore {
  return new DocumentStore(document(graphDef), coreCommandRegistry([], (type) => type === resolvedSchema.type ? resolvedSchema : undefined))
}

describe('image.applyAsset', () => {
  it('admits native image assets through the same guard and refuses hidden inputs', () => {
    for (const hidden of [false, true]) {
      const native: NodeSchema = { ...schema, items: [{
        kind: 'input', id: 'image', optional: false, ...(hidden ? { hidden: true } : {}),
        type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } },
        widget: { widgetType: 'ASSET', options: {} },
      }] }
      const target = new DocumentStore(document(graph()), coreCommandRegistry([], () => native))
      expect(target.dispatch(invocation).ok).toBe(!hidden)
      expect(target.revision).toBe(hidden ? 0 : 1)
      expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(hidden ? sourceRef : replacementRef)
    }
  })

  it('atomically replaces one current writable image AssetRef with undo support', () => {
    const target = store()
    const outcome = target.dispatch(invocation)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.forward).toHaveLength(1)
    expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(replacementRef)
    expect(target.revision).toBe(1)
    expect(target.undo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(sourceRef)
  })

  it('accepts the interchangeable native image asset type', () => {
    const nativeSchema = {
      ...schema,
      items: [{ ...schema.items[0]!, type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } } }],
    } as NodeSchema
    expect(store(graph(), nativeSchema).dispatch(invocation).ok).toBe(true)
  })

  it('rejects stale sources, incomplete refs, wrong media, and unknown extra params', () => {
    const cases = [
      { ...invocation.params, expectedSourceDigest: `blake3:${'c'.repeat(64)}` },
      { ...invocation.params, asset: { digest: REPLACEMENT } },
      { ...invocation.params, asset: { ...replacementRef, mediaType: 'video/mp4' } },
      { ...invocation.params, extra: true },
    ]
    for (const params of cases) {
      const target = store()
      expect(target.dispatch({ command: invocation.command, params }).ok).toBe(false)
      expect(target.revision).toBe(0)
    }
  })

  it('rejects linked and net-driven image inputs', () => {
    const linked: GraphDef = {
      ...graph(),
      links: {
        link: {
          id: asLinkId('link'),
          from: { node: asNodeId('source'), port: asPortId('out') },
          to: { node: asNodeId('image'), port: asPortId('image') },
        },
      },
    }
    expect(store(linked).dispatch(invocation).ok).toBe(false)

    const netDriven: GraphDef = {
      ...graph(),
      nets: {
        net: {
          id: asNetId('net'),
          name: 'Image',
          source: { node: asNodeId('source'), port: asPortId('out') },
          sinks: [{ node: asNodeId('image'), port: asPortId('image') }],
        },
      },
    }
    expect(store(netDriven).dispatch(invocation).ok).toBe(false)
  })

  it('requires the exact typed image Asset input schema', () => {
    const target = new DocumentStore(document(graph()), coreCommandRegistry([], () => ({
      ...schema,
      items: [{ ...schema.items[0]!, type: { kind: 'concrete', name: 'dinkster.asset' } }],
    } as NodeSchema)))
    expect(target.dispatch(invocation).ok).toBe(false)
    expect(target.revision).toBe(0)
  })
})

const maskLoaderSchema: NodeSchema = {
  ...schema,
  type: 'dinkster.load_image',
  editorRole: 'image-source',
  items: [
    {
      kind: 'input', id: 'image', optional: false,
      type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } },
      widget: { widgetType: 'ASSET', options: {} },
    },
    { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' } },
    { kind: 'output', id: 'mask', type: { kind: 'concrete', name: 'dinkster.mask' } },
  ],
}

const maskPaintSchema: NodeSchema = {
  ...schema,
  type: 'dinkster.mask.paint',
  editorRole: 'mask-paint',
  items: [
    { kind: 'input', id: 'source', type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } }, optional: false, widget: { widgetType: 'ASSET', options: {} } },
    { kind: 'input', id: 'operations', type: { kind: 'concrete', name: 'core.string' }, optional: false, widget: { widgetType: 'STRING', options: { multiline: true } } },
    { kind: 'output', id: 'mask', type: { kind: 'concrete', name: 'dinkster.mask' } },
  ],
}

const maskOperations = JSON.stringify({ version: 1, sourceDigest: SOURCE, width: 2, height: 1, commands: [{ op: 'clear' }] })
const nonIntegerMaskOperations = [
  maskOperations.replace('"version":1', '"version":1.0'),
  maskOperations.replace('"version":1', '"version":1e0'),
  maskOperations.replace('"width":2', '"width":2.0'),
  maskOperations.replace('"height":1', '"height":1e0'),
]
const maskInvocation = {
  command: 'image.applyMaskPaint',
  params: {
    graphId: 'g0', loaderNodeId: 'image', inputId: 'image', expectedSource: sourceRef,
    operations: maskOperations, paintNodeId: null, expectedPaintOperations: null,
    expectedMaskLinkIds: ['mask-link'], expectedMaskNetIds: ['mask-net'],
  },
}

const maskGraph = (): GraphDef => ({
  ...graph(),
  nodes: {
    ...graph().nodes,
    image: { id: asNodeId('image'), type: 'dinkster.load_image', values: { image: sourceRef } },
    direct: { id: asNodeId('direct'), type: 'Consumer', values: {} },
    net: { id: asNodeId('net'), type: 'Consumer', values: {} },
  },
  links: {
    'mask-link': {
      id: asLinkId('mask-link'), from: { node: asNodeId('image'), port: asPortId('mask') },
      to: { node: asNodeId('direct'), port: asPortId('mask') }, ext: { retained: true },
    },
    'image-link': {
      id: asLinkId('image-link'), from: { node: asNodeId('image'), port: asPortId('image') },
      to: { node: asNodeId('direct'), port: asPortId('image') },
    },
  },
  nets: {
    'mask-net': {
      id: asNetId('mask-net'), name: 'mask', source: { node: asNodeId('image'), port: asPortId('mask') },
      sinks: [{ node: asNodeId('net'), port: asPortId('mask') }],
    },
  },
})

const maskResolve = Object.assign((type: string) =>
  type === maskLoaderSchema.type ? maskLoaderSchema : type === maskPaintSchema.type ? maskPaintSchema : undefined, {
  forEditorRole: (role: string) => role === 'mask-paint' ? maskPaintSchema : role === 'image-source' ? maskLoaderSchema : undefined,
})
const maskStore = (graphDef = maskGraph()) => new DocumentStore(document(graphDef), coreCommandRegistry([], maskResolve))

describe('image.applyMaskPaint', () => {
  it('atomically inserts one paint node and retargets only loader mask consumers', () => {
    const target = maskStore()
    expect(target.dispatch(maskInvocation).ok).toBe(true)
    expect(target.revision).toBe(1)
    const paint = Object.values(target.doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.mask.paint')!
    expect(paint.values).toEqual({ source: sourceRef, operations: maskOperations })
    expect(target.doc.graphs.g0!.links['mask-link']!.from).toEqual({ node: paint.id, port: 'mask' })
    expect(target.doc.graphs.g0!.links['mask-link']!.ext).toEqual({ retained: true })
    expect(target.doc.graphs.g0!.nets['mask-net']!.source).toEqual({ node: paint.id, port: 'mask' })
    expect(target.doc.graphs.g0!.links['image-link']!.from).toEqual({ node: 'image', port: 'image' })
    expect(target.undo()).toBe(true)
    expect(Object.values(target.doc.graphs.g0!.nodes).some((node) => node.type === 'dinkster.mask.paint')).toBe(false)
    expect(target.redo()).toBe(true)
  })

  it('updates its associated node without nesting and rejects stale guarded state', () => {
    const target = maskStore()
    expect(target.dispatch(maskInvocation).ok).toBe(true)
    const paint = Object.values(target.doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.mask.paint')!
    const updated = JSON.stringify({ version: 1, sourceDigest: SOURCE, width: 2, height: 1, commands: [{ op: 'invert' }] })
    expect(target.dispatch({ command: maskInvocation.command, params: {
      ...maskInvocation.params, operations: updated, paintNodeId: paint.id,
      expectedPaintOperations: maskOperations, expectedMaskLinkIds: [], expectedMaskNetIds: [],
    } }).ok).toBe(true)
    expect(Object.values(target.doc.graphs.g0!.nodes).filter((node) => node.type === 'dinkster.mask.paint')).toHaveLength(1)
    expect(target.doc.graphs.g0!.nodes[paint.id]!.values.operations).toBe(updated)

    for (const params of [
      { ...maskInvocation.params, expectedSource: { ...sourceRef, name: 'stale.png' } },
      { ...maskInvocation.params, expectedMaskLinkIds: [] },
      { ...maskInvocation.params, operations: JSON.stringify({ version: 1, sourceDigest: SOURCE, width: 2, height: 1, commands: [{ op: 'unknown' }] }) },
      { ...maskInvocation.params, operations: `{"version":1,"version":1,"sourceDigest":"${SOURCE}","width":2,"height":1,"commands":[]}` },
      { ...maskInvocation.params, operations: `${maskOperations}${' '.repeat(4_194_305)}` },
      ...nonIntegerMaskOperations.map((operations) => ({ ...maskInvocation.params, operations })),
    ]) expect(maskStore().dispatch({ command: maskInvocation.command, params }).ok).toBe(false)
  })

  it('reports a missing mask schema when no resolver is available', () => {
    const outcome = new DocumentStore(document(maskGraph()), coreCommandRegistry()).dispatch(maskInvocation)
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('image.maskSchemaMissing')
  })
})

const compositorSchema: NodeSchema = {
  type: 'CreateLayeredImage',
  displayName: 'Create Layered Image',
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items: [{
    kind: 'input',
    id: 'compositor',
    type: { kind: 'concrete', name: 'dinkster.compositor' },
    optional: true,
    widget: { widgetType: 'COMPOSITOR', options: {}, default: EMPTY_COMPOSITOR_RECIPE },
  }],
}

const compositorRecipe: CompositorRecipe = {
  version: 2,
  documentDigest: `blake3:${'a'.repeat(64)}`,
  commands: [{ op: 'layer', id: 'layer-1', changes: { visible: false } }],
}

const compositorGraph = (value?: unknown): GraphDef => ({
  id: asGraphDefId('g0'),
  name: 'root',
  nodes: {
    compositor: {
      id: asNodeId('compositor'),
      type: 'CreateLayeredImage',
      values: value === undefined ? {} : { compositor: value as never },
    },
    source: { id: asNodeId('source'), type: 'Source', values: {} },
  },
  links: {},
  nets: {},
  reroutes: {},
  nextOrdinal: 1,
})

const compositorInvocation = {
  command: 'image.compositorApply',
  params: {
    graphId: 'g0',
    nodeId: 'compositor',
    inputId: 'compositor',
    instancePath: [] as string[],
    expectedRecipeFingerprint: compositorRecipeFingerprint(undefined)!,
    recipe: compositorRecipe as unknown as Json,
  },
}

const compositorRegistry = (resolved: NodeSchema = compositorSchema) =>
  coreCommandRegistry([], (type) => type === resolved.type ? resolved : undefined)

describe('image.compositorApply', () => {
  it('atomically applies one exact recipe with forward patch, undo, and redo', () => {
    const target = new DocumentStore(document(compositorGraph()), compositorRegistry())
    const outcome = target.dispatch(compositorInvocation)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.forward).toEqual([{
      op: 'add',
      path: ['graphs', 'g0', 'nodes', 'compositor', 'values', 'compositor'],
      value: compositorRecipe,
    }])
    expect(target.revision).toBe(1)
    expect(target.doc.graphs.g0!.nodes.compositor!.values.compositor).toEqual(compositorRecipe)
    expect(target.undo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.compositor!.values.compositor).toBeUndefined()
    expect(target.redo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.compositor!.values.compositor).toEqual(compositorRecipe)
  })

  it('publishes the same single replace as a local collaboration wire patch', () => {
    const session = createLocalSession(document(compositorGraph()), compositorRegistry(), { clock: () => 42 })
    const ops: SessionOp[] = []
    session.onOp((op) => ops.push(op))
    expect(session.dispatch(compositorInvocation).ok).toBe(true)
    expect(ops).toEqual([expect.objectContaining({
      baseRevision: 0,
      revision: 1,
      origin: 'image.compositorApply',
      patch: [{
        op: 'add',
        path: ['graphs', 'g0', 'nodes', 'compositor', 'values', 'compositor'],
        value: compositorRecipe,
      }],
      timestamp: 42,
    })])
  })

  it('rejects stale or malformed recipes without writing', () => {
    const current = { ...compositorRecipe, commands: [{ op: 'layer', id: 'layer-1', changes: { visible: true } }] }
    const stale = new DocumentStore(document(compositorGraph(current)), compositorRegistry())
    const staleOutcome = stale.dispatch(compositorInvocation)
    expect(staleOutcome.ok).toBe(false)
    expect(staleOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('image.compositorRecipeChanged')
    expect(stale.revision).toBe(0)
    expect(stale.doc.graphs.g0!.nodes.compositor!.values.compositor).toEqual(current)

    const malformedCurrent = new DocumentStore(document(compositorGraph({ version: 1 })), compositorRegistry())
    const expectedMalformed = {
      ...compositorInvocation,
      params: { ...compositorInvocation.params, expectedRecipeFingerprint: `sha256:${'0'.repeat(64)}` },
    }
    const currentOutcome = malformedCurrent.dispatch(expectedMalformed)
    expect(currentOutcome.ok).toBe(false)
    expect(currentOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('image.compositorRecipeInvalid')
    expect(malformedCurrent.revision).toBe(0)

    const malformedReplacement = new DocumentStore(document(compositorGraph()), compositorRegistry())
    const replacementOutcome = malformedReplacement.dispatch({
      ...compositorInvocation,
      params: { ...compositorInvocation.params, recipe: { version: 2, documentDigest: null, commands: [], extra: true } },
    })
    expect(replacementOutcome.ok).toBe(false)
    expect(malformedReplacement.revision).toBe(0)
  })

  it('requires a direct concrete COMPOSITOR input in the selected graph occurrence', () => {
    const wrongWidget = {
      ...compositorSchema,
      items: [{ ...compositorSchema.items[0]!, widget: { widgetType: 'STRING', options: {} } }],
    } as NodeSchema
    expect(new DocumentStore(document(compositorGraph()), compositorRegistry(wrongWidget))
      .dispatch(compositorInvocation).ok).toBe(false)

    const wrongType = {
      ...compositorSchema,
      items: [{ ...compositorSchema.items[0]!, type: { kind: 'concrete', name: 'core.string' } }],
    } as NodeSchema
    expect(new DocumentStore(document(compositorGraph()), compositorRegistry(wrongType))
      .dispatch(compositorInvocation).ok).toBe(false)

    const invalidOccurrence = {
      ...compositorInvocation,
      params: { ...compositorInvocation.params, instancePath: ['missing'] },
    }
    expect(new DocumentStore(document(compositorGraph()), compositorRegistry())
      .dispatch(invalidOccurrence).ok).toBe(false)

    const base = compositorGraph()
    const promoted: GraphDef = {
      ...base,
      nodes: { ...base.nodes, compositor: { ...base.nodes.compositor!, type: '#body' } },
    }
    expect(new DocumentStore(document(promoted), coreCommandRegistry([], () => compositorSchema))
      .dispatch(compositorInvocation).ok).toBe(false)
  })

  it('rejects definition link and net drivers', () => {
    const base = compositorGraph()
    const linked: GraphDef = {
      ...base,
      links: { link: {
        id: asLinkId('link'),
        from: { node: asNodeId('source'), port: asPortId('out') },
        to: { node: asNodeId('compositor'), port: asPortId('compositor') },
      } },
    }
    const linkedTarget = new DocumentStore(document(linked), compositorRegistry())
    expect(linkedTarget.dispatch(compositorInvocation).ok).toBe(false)
    expect(linkedTarget.revision).toBe(0)

    const netDriven: GraphDef = {
      ...base,
      nets: { net: {
        id: asNetId('net'),
        name: 'Recipe',
        source: { node: asNodeId('source'), port: asPortId('out') },
        sinks: [{ node: asNodeId('compositor'), port: asPortId('compositor') }],
      } },
    }
    const netTarget = new DocumentStore(document(netDriven), compositorRegistry())
    expect(netTarget.dispatch(compositorInvocation).ok).toBe(false)
    expect(netTarget.revision).toBe(0)
  })
})

describe('image.documentExport', () => {
  const loadSchema: NodeSchema = { ...schema, type: 'dinkster.layers.load', editorRole: 'layers-load', items: [
    { kind: 'input', id: 'document', type: { kind: 'concrete', name: 'dinkster.asset' }, optional: false,
      widget: { widgetType: 'ASSET', options: {} } },
    { kind: 'output', id: 'layers', type: { kind: 'concrete', name: 'dinkster.layers' } },
  ] }
  const flattenSchema: NodeSchema = { ...schema, type: 'dinkster.layers.flatten', editorRole: 'layers-flatten', items: [
    { kind: 'input', id: 'layers', type: { kind: 'concrete', name: 'dinkster.layers' }, optional: false },
    { kind: 'input', id: 'selector', type: { kind: 'concrete', name: 'core.string' }, optional: true,
      widget: { widgetType: 'STRING', options: {}, default: 'composite' } },
  ] }
  const resolve = Object.assign((type: string): NodeSchema | undefined =>
    type === loadSchema.type ? loadSchema : type === flattenSchema.type ? flattenSchema : undefined, {
    forEditorRole: (role: string) => role === 'layers-load' ? loadSchema : role === 'layers-flatten' ? flattenSchema : undefined,
  })
  const asset = { ...sourceRef, mediaType: 'application/vnd.dinkster.image-document+json' }
  const params = () => ({ graphId: 'g0', expectedGraphFingerprint: sha256Hex(canonicalJson(graph())), asset, position: { x: 80, y: 80 } })

  it('exports only the document asset and records one atomic undoable node expression', () => {
    const target = new DocumentStore(document(graph()), coreCommandRegistry([], resolve))
    expect(target.dispatch({ command: 'image.documentExport', params: params() }).ok).toBe(true)
    expect(target.doc.graphs.g0!.nodes.n1).toMatchObject({
      type: 'dinkster.layers.load', values: { document: asset },
    })
    expect(target.doc.graphs.g0!.nodes.n2).toMatchObject({ type: 'dinkster.layers.flatten', values: { selector: 'composite' } })
    expect(target.doc.graphs.g0!.links.l3).toMatchObject({
      from: { node: 'n1', port: 'layers' }, to: { node: 'n2', port: 'layers' },
    })
    expect(target.doc.graphs.g0!.nodes.image!.values.image).toEqual(sourceRef)
    expect(target.undo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.n1).toBeUndefined()
    expect(target.doc.graphs.g0!.nodes.n2).toBeUndefined()
    expect(target.doc.graphs.g0!.links.l3).toBeUndefined()
    expect(target.redo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.n1).toBeDefined()
    expect(JSON.stringify(target.doc)).not.toMatch(/data:image|file:\/\/|rgba/)
  })

  it('refuses stale destinations, wrong assets and missing node capabilities without changing history', () => {
    for (const invalid of [
      { ...params(), expectedGraphFingerprint: 'stale' },
      { ...params(), asset: sourceRef },
      { ...params(), graphId: 'missing' },
    ]) {
      const target = new DocumentStore(document(graph()), coreCommandRegistry([], resolve))
      expect(target.dispatch({ command: 'image.documentExport', params: invalid }).ok).toBe(false)
      expect(target.revision).toBe(0)
    }
    const target = store()
    expect(target.dispatch({ command: 'image.documentExport', params: params() }).ok).toBe(false)
    expect(target.revision).toBe(0)
  })

  it('refuses incompatible document and selector ports before allocating nodes', () => {
    const incompatible: NodeSchema[] = [
      { ...loadSchema, items: loadSchema.items.map((item) => item.kind === 'input'
        ? { ...item, type: { kind: 'concrete', name: 'core.string' } } : item) },
      { ...flattenSchema, items: flattenSchema.items.filter((item) => item.kind !== 'input' || item.id !== 'selector') },
      { ...flattenSchema, items: flattenSchema.items.map((item) => item.kind === 'input' && item.id === 'selector'
        ? { ...item, type: { kind: 'concrete', name: 'core.int' } } : item) },
    ]
    for (const candidate of incompatible) {
      const before = document(graph())
      const target = new DocumentStore(before, coreCommandRegistry([], (type) =>
        type === candidate.type ? candidate : resolve(type)))
      expect(target.dispatch({ command: 'image.documentExport', params: params() }).ok).toBe(false)
      expect(target.revision).toBe(0)
      expect(target.doc).toEqual(before)
    }
  })
})

describe('image.documentRecipeExport', () => {
  const schemas: NodeSchema[] = [
    { ...schema, type: 'Source', items: [
      { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'dinkster.layers' } },
    ] },
    { ...schema, type: 'dinkster.layers.edit', editorRole: 'layers-edit', items: [
      { kind: 'input', id: 'layers', type: { kind: 'concrete', name: 'dinkster.layers' }, optional: false },
      { kind: 'input', id: 'commands', type: { kind: 'concrete', name: 'core.string' }, optional: false,
        widget: { widgetType: 'STRING', options: { multiline: true } } },
      { kind: 'output', id: 'layers', type: { kind: 'concrete', name: 'dinkster.layers' } },
    ] },
    { ...schema, type: 'dinkster.layers.flatten', editorRole: 'layers-flatten', items: [
      { kind: 'input', id: 'layers', type: { kind: 'concrete', name: 'dinkster.layers' }, optional: false },
      { kind: 'input', id: 'selector', type: { kind: 'concrete', name: 'core.string' }, optional: true },
      { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' } },
    ] },
    { ...schema, type: 'dinkster.save_image', editorRole: 'image-save', isOutputNode: true, items: [
      { kind: 'input', id: 'images', type: { kind: 'concrete', name: 'dinkster.image' }, optional: false },
      { kind: 'input', id: 'format', type: { kind: 'concrete', name: 'core.combo' }, optional: true,
        widget: { widgetType: 'COMBO', options: { options: ['png', 'jpeg', 'webp'] }, default: 'png' } },
      { kind: 'input', id: 'quality', type: { kind: 'concrete', name: 'core.int' }, optional: true,
        widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, default: 90 } },
      { kind: 'output', id: 'assets', type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.image' } } } },
    ] },
  ]
  const resolve = Object.assign((type: string): NodeSchema | undefined => schemas.find((candidate) => candidate.type === type), {
    forEditorRole: (role: string) => schemas.find((candidate) => candidate.editorRole === role),
  })
  const params = () => ({
    graphId: 'g0',
    expectedGraphFingerprint: sha256Hex(canonicalJson(graph())),
    sourceNodeId: 'source',
    sourceOutputId: 'out',
    commands: canonicalJson([{ op: 'canvas', changes: { width: 4, height: 3 } }]),
    format: 'webp',
    quality: 73,
  })

  it('branches an atomic editable recipe from the original layer output', () => {
    const target = new DocumentStore(document(graph()), coreCommandRegistry([], resolve))
    expect(target.dispatch({ command: 'image.documentRecipeExport', params: params() }).ok).toBe(true)
    expect(target.doc.graphs.g0!.nodes.n1).toMatchObject({
      type: 'dinkster.layers.edit', values: { commands: params().commands },
    })
    expect(target.doc.graphs.g0!.nodes.n2).toMatchObject({
      type: 'dinkster.layers.flatten', values: { selector: 'composite' },
    })
    expect(target.doc.graphs.g0!.nodes.n3).toMatchObject({
      type: 'dinkster.save_image', values: { format: 'webp', quality: 73 },
    })
    expect(Object.values(target.doc.graphs.g0!.links)).toMatchObject([
      { from: { node: 'source', port: 'out' }, to: { node: 'n1', port: 'layers' } },
      { from: { node: 'n1', port: 'layers' }, to: { node: 'n2', port: 'layers' } },
      { from: { node: 'n2', port: 'image' }, to: { node: 'n3', port: 'images' } },
    ])
    expect(target.undo()).toBe(true)
    expect(Object.keys(target.doc.graphs.g0!.nodes)).toEqual(['image', 'source'])
    expect(target.redo()).toBe(true)
    expect(target.doc.graphs.g0!.nodes.n3).toBeDefined()
  })

  it('refuses stale, malformed and unsupported recipes without allocating', () => {
    for (const invalid of [
      { ...params(), expectedGraphFingerprint: 'stale' },
      { ...params(), commands: '[ {"op":"canvas"} ]' },
      { ...params(), commands: '{}' },
      { ...params(), commands: '[1]' },
      { ...params(), commands: canonicalJson([{ op: 'canvas', changes: { width: 4 }, extra: true }]) },
      { ...params(), commands: canonicalJson([{ op: 'reorder', ids: ['l1', 'l1'] }]) },
      { ...params(), format: 'gif' },
      { ...params(), quality: 101 },
      { ...params(), sourceOutputId: 'missing' },
    ]) {
      const target = new DocumentStore(document(graph()), coreCommandRegistry([], resolve))
      expect(target.dispatch({ command: 'image.documentRecipeExport', params: invalid }).ok).toBe(false)
      expect(target.revision).toBe(0)
      expect(target.doc).toEqual(document(graph()))
    }
    const withoutSelector = (type: string): NodeSchema | undefined => {
      const resolved = resolve(type)
      return resolved?.type === 'dinkster.layers.flatten'
        ? { ...resolved, items: resolved.items.filter((item) => item.id !== 'selector') }
        : resolved
    }
    const target = new DocumentStore(document(graph()), coreCommandRegistry([], withoutSelector))
    expect(target.dispatch({ command: 'image.documentRecipeExport', params: params() }).ok).toBe(false)
    expect(target.revision).toBe(0)
    expect(target.doc).toEqual(document(graph()))
  })

  it('refuses output policy values outside the current save schema without allocating', () => {
    const saveResolve = (formatOptions: readonly string[], qualityOptions: Readonly<Record<string, number>>) =>
      (type: string): NodeSchema | undefined => {
        const resolved = resolve(type)
        if (resolved?.type !== 'dinkster.save_image') return resolved
        return { ...resolved, items: resolved.items.map((item) => item.id === 'format' ? {
          ...item, widget: { widgetType: 'COMBO', options: { options: formatOptions }, default: 'png' },
        } : item.id === 'quality' ? {
          ...item, widget: { widgetType: 'INT', options: qualityOptions, default: 90 },
        } : item) }
      }
    for (const resolver of [
      saveResolve(['png'], { min: 0, max: 100, step: 1 }),
      saveResolve(['png', 'jpeg', 'webp'], { min: 0, max: 100, step: 2 }),
      saveResolve(['png', 'jpeg', 'webp'], { min: 0, max: 100 }),
    ]) {
      const target = new DocumentStore(document(graph()), coreCommandRegistry([], resolver))
      expect(target.dispatch({ command: 'image.documentRecipeExport', params: params() }).ok).toBe(false)
      expect(target.revision).toBe(0)
      expect(target.doc).toEqual(document(graph()))
    }
  })
})
