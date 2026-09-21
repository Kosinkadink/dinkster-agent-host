import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { planOccurrenceLinkCommand } from '../src/commands/occurrence-link-commands.js'
import { createLocalSession } from '../src/commands/session.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, documentNodeResolver, scopeClosure } from '../src/compile/compile.js'
import type { GraphDef, Json, RegionContract, WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { validateDocumentShape } from '../src/format/validate.js'
import { checkDocument } from '../src/invariants.js'
import { asConnectionId } from '../src/ids.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { inputsOf, outputsOf, type NodeSchema } from '../src/schema/model.js'

const TYPE = { kind: 'concrete', name: 'core.float' } as const
const BOOLEAN = { kind: 'concrete', name: 'core.boolean' } as const
const INTEGER = { kind: 'concrete', name: 'core.int' } as const
const COMBO = { kind: 'concrete', name: 'core.combo' } as const

const bodySchema: NodeSchema = {
  type: 'Body',
  displayName: 'Body',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'in_item', type: TYPE, optional: false },
    { kind: 'input', id: 'in_state', type: TYPE, optional: false },
    { kind: 'input', id: 'in_other', type: TYPE, optional: false },
    { kind: 'output', id: 'out_item', type: TYPE },
    { kind: 'output', id: 'out_state', type: TYPE },
    { kind: 'output', id: 'out_other', type: TYPE },
    { kind: 'output', id: 'out_continue', type: BOOLEAN },
  ],
}

const producerSchema: NodeSchema = {
  type: 'Producer', displayName: 'Producer', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'output', id: 'value', type: TYPE }],
}

const countMultiSplitterSchema: NodeSchema = {
  type: 'CountMultiSplitter', displayName: 'Count multi splitter', category: 'test', source: 'v3', isOutputNode: true,
  items: [
    { kind: 'input', id: 'count', type: { kind: 'concrete', name: 'core.int' }, optional: false },
    { kind: 'output', id: 'before', type: TYPE },
    {
      kind: 'output', id: 'images', type: TYPE,
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'image', type: TYPE, optional: false }],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    },
    { kind: 'output', id: 'after', type: TYPE },
    {
      kind: 'output', id: 'masks', type: TYPE,
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'mask', type: TYPE, optional: false }],
        naming: { kind: 'prefix', prefix: 'mask', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ],
}

const sinkSchema: NodeSchema = {
  type: 'Sink', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: true,
  items: [{ kind: 'input', id: 'in', type: TYPE, optional: false }],
}

const indexSinkSchema: NodeSchema = {
  type: 'IndexSink', displayName: 'Index sink', category: 'test', source: 'v3', isOutputNode: true,
  items: [{ kind: 'input', id: 'index', type: INTEGER, optional: false }],
}

const body = (): GraphDef => ({
  id: 'body' as never,
  name: 'Region body',
  nodes: { n0: { id: 'n0' as never, type: 'Body', values: {} } },
  links: {},
  nets: {},
  reroutes: {},
  boundary: {
    inputs: [
      { id: 'item' as never, binds: { kind: 'port', node: 'n0' as never, port: 'in_item' as never } },
      { id: 'state' as never, binds: { kind: 'port', node: 'n0' as never, port: 'in_state' as never } },
      { id: 'other' as never, binds: { kind: 'port', node: 'n0' as never, port: 'in_other' as never } },
    ],
    outputs: [
      { id: 'items' as never, binds: { kind: 'port', node: 'n0' as never, port: 'out_item' as never } },
      { id: 'result' as never, binds: { kind: 'port', node: 'n0' as never, port: 'out_state' as never } },
      { id: 'others' as never, binds: { kind: 'port', node: 'n0' as never, port: 'out_other' as never } },
      { id: 'continue' as never, binds: { kind: 'port', node: 'n0' as never, port: 'out_continue' as never } },
    ],
  },
  nextOrdinal: 1,
})

const documentWith = (region: RegionContract): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage' as never,
  root: 'root' as never,
  graphs: {
    root: {
      id: 'root' as never,
      name: 'Root',
      nodes: { n0: { id: 'n0' as never, type: '#body', values: { item: [], state: 0, other: 0 }, region } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    },
    body: body(),
  },
  view: { graphs: { root: { nodes: { n0: { position: { x: 0, y: 0 } } } }, body: { nodes: {} } } },
})

const codes = (doc: WorkflowDocument) => checkDocument(doc).map((d) => d.code)
const resolve = (type: string) => type === 'Body' ? bodySchema : type === 'Producer' ? producerSchema : undefined
const compileDocument = (document: WorkflowDocument) => compile({
  document,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('test'),
  schemaHash: 'test',
})

describe('region document format and invariants', () => {
  it('round-trips a strict v1 region block without changing FORMAT_VERSION', () => {
    const original = documentWith({
      kind: 'fold',
      elementPorts: ['item'],
      statePorts: ['state'],
      outputRoles: { items: { kind: 'gather' }, result: { kind: 'state', statePort: 'state' } },
      binding: 'cross',
      maxIterations: 12,
    })
    const raw = JSON.parse(JSON.stringify(original))
    expect(validateDocumentShape(raw)).toEqual([])
    const loaded = loadDocument(raw)
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(JSON.parse(JSON.stringify(loaded.document))).toEqual(raw)
    expect(loaded.document?.formatVersion).toBe(1)
  })

  it('round-trips broadcast binding and rejects unknown binding values', () => {
    const original = documentWith({ kind: 'map', elementPorts: ['item'], binding: 'broadcast' })
    const raw = JSON.parse(JSON.stringify(original))
    expect(validateDocumentShape(raw)).toEqual([])
    expect(loadDocument(raw).document?.graphs.root?.nodes.n0?.region?.binding).toBe('broadcast')

    raw.graphs.root.nodes.n0.region.binding = 'diagonal'
    expect(validateDocumentShape(raw)).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("expected 'zip', 'cross', or 'broadcast'"),
    }))
  })

  it('round-trips compact and flatten output roles and rejects unknown role values', () => {
    const original = documentWith({
      kind: 'map', elementPorts: ['item'],
      outputRoles: { items: { kind: 'compact' }, others: { kind: 'flatten' } },
    })
    const raw = JSON.parse(JSON.stringify(original))
    expect(validateDocumentShape(raw)).toEqual([])
    expect(loadDocument(raw).document?.graphs.root?.nodes.n0?.region?.outputRoles).toEqual({
      items: { kind: 'compact' }, others: { kind: 'flatten' },
    })

    raw.graphs.root.nodes.n0.region.outputRoles.items.kind = 'scatter'
    expect(validateDocumentShape(raw)).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("expected 'gather', 'compact', 'state', or 'flatten'"),
    }))
  })

  it('rejects malformed and unknown region properties through strict shape validation', () => {
    const malformed = documentWith({ kind: 'map', elementPorts: ['item'] }) as unknown as Record<string, unknown>
    const node = (((malformed.graphs as Record<string, unknown>).root as Record<string, unknown>).nodes as Record<string, Record<string, unknown>>).n0!
    node.region = { kind: 'repeat', elementPorts: 'item', maxIterations: 1.5, surprise: true }
    const messages = validateDocumentShape(malformed).map((d) => d.message)
    expect(messages.some((m) => m.includes('.region.kind'))).toBe(true)
    expect(messages.some((m) => m.includes('.region.elementPorts'))).toBe(true)
    expect(messages.some((m) => m.includes('.region.maxIterations'))).toBe(true)
    expect(messages.some((m) => m.includes('.region.surprise'))).toBe(true)
  })

  it('validates map, fold, and while profiles plus boundary role invariants', () => {
    expect(codes(documentWith({ kind: 'map', elementPorts: ['item'] }))).toEqual([])
    expect(codes(documentWith({ kind: 'fold', elementPorts: ['item'], statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } } }))).toEqual([])
    expect(codes(documentWith({ kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } }, continueOutput: 'continue', maxIterations: 3 }))).toEqual([])

    const bad = codes(documentWith({
      kind: 'while',
      elementPorts: ['missing', 'state'],
      statePorts: ['state', 'other'],
      outputRoles: { ghost: { kind: 'state', statePort: 'missing' } },
      continueOutput: 'ghost',
      binding: 'cross',
      maxIterations: 0,
    }))
    expect(bad).toEqual(expect.arrayContaining([
      'doc.region.elementPortUndeclared',
      'doc.region.portRoleOverlap',
      'doc.region.stateOutputMissing',
      'doc.region.statePortMissing',
      'doc.region.outputUndeclared',
      'doc.region.continueUndeclared',
      'doc.region.maxIterations',
      'doc.region.whileElementForbidden',
      'doc.region.whileCross',
    ]))
    expect(codes(documentWith({ kind: 'map' }))).toContain('doc.region.mapElementRequired')
    expect(codes(documentWith({ kind: 'fold' }))).toEqual(expect.arrayContaining([
      'doc.region.foldElementRequired', 'doc.region.foldStateRequired',
    ]))
    expect(codes(documentWith({ kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } } }))).toEqual(expect.arrayContaining([
      'doc.region.whileContinueRequired', 'doc.region.whileMaxIterationsRequired',
    ]))
    expect(codes(documentWith({
      kind: 'while', statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
      continueOutput: 'continue', maxIterations: 3, binding: 'broadcast',
    }))).toContain('doc.region.whileBroadcast')
  })

  it('rejects an unknown outputRoles key', () => {
    expect(codes(documentWith({ kind: 'map', elementPorts: ['item'], outputRoles: { ghost: { kind: 'gather' } } })))
      .toContain('doc.region.outputUndeclared')
  })

  it('reports an undeclared state-role output and the missing declared state output', () => {
    expect(codes(documentWith({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { ghost: { kind: 'state', statePort: 'state' } },
    }))).toEqual(expect.arrayContaining(['doc.region.outputUndeclared', 'doc.region.stateOutputMissing']))
  })

  it('rejects a state role whose target is not a declared state input', () => {
    expect(codes(documentWith({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'other' } },
    }))).toEqual(expect.arrayContaining(['doc.region.statePortMissing', 'doc.region.stateOutputMissing']))
  })

  it('rejects duplicate state-role outputs targeting one state input', () => {
    expect(codes(documentWith({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: {
        result: { kind: 'state', statePort: 'state' },
        others: { kind: 'state', statePort: 'state' },
      },
    }))).toContain('doc.region.stateOutputDuplicate')
  })

  it('rejects outputRoles overlap with continueOutput', () => {
    expect(codes(documentWith({
      kind: 'while', statePorts: ['state'],
      outputRoles: {
        result: { kind: 'state', statePort: 'state' },
        continue: { kind: 'gather' },
      },
      continueOutput: 'continue', maxIterations: 2,
    }))).toContain('doc.region.outputContinueOverlap')
  })

  it('requires an exported output and diagnoses role-required ports on an empty boundary', () => {
    const empty = structuredClone(documentWith({ kind: 'map', elementPorts: ['item'] })) as WorkflowDocument
    ;(empty.graphs.body as { boundary?: unknown }).boundary = { inputs: [], outputs: [] }
    expect(codes(empty)).toEqual(expect.arrayContaining([
      'doc.region.elementPortUndeclared',
      'doc.region.outputRequired',
    ]))

    const continuationOnly = structuredClone(documentWith({
      kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } }, continueOutput: 'continue', maxIterations: 2,
    })) as WorkflowDocument
    const boundary = continuationOnly.graphs.body!.boundary!
    ;(boundary as { outputs: typeof boundary.outputs }).outputs = boundary.outputs.filter((item) => item.id === 'continue')
    expect(codes(continuationOnly)).toContain('doc.region.outputRequired')
  })

  it('rejects promoted scalar widgets on element boundary inputs', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    const changed = structuredClone(doc) as WorkflowDocument
    const def = changed.graphs.body!
    ;(def.boundary!.inputs[0] as { promoted?: boolean }).promoted = true
    expect(codes(changed)).toContain('doc.region.elementPromoted')
  })
})

describe('region occurrence boundary projection', () => {
  it('derives an omitted constructor output role as a gather list', () => {
    const constructorBody = body()
    ;(constructorBody.boundary!.outputs[0] as { id: string }).id = 'constructor'
    const result = deriveBoundarySchema(constructorBody, resolve, { kind: 'map', elementPorts: ['item'] })
    expect(result.diagnostics).toEqual([])
    expect(outputsOf(result.schema!).find((item) => item.id === 'constructor')?.type).toEqual({
      kind: 'list', element: TYPE,
    })
  })

  it('derives compact with the same list type as gather', () => {
    const gathered = deriveBoundarySchema(body(), resolve, { kind: 'map', elementPorts: ['item'] })
    const compacted = deriveBoundarySchema(body(), resolve, {
      kind: 'map', elementPorts: ['item'], outputRoles: { items: { kind: 'compact' } },
    })
    expect(compacted.diagnostics).toEqual([])
    expect(outputsOf(compacted.schema!).find((item) => item.id === 'items')?.type)
      .toEqual(outputsOf(gathered.schema!).find((item) => item.id === 'items')?.type)
  })

  it('derives element/state/broadcast inputs and gather/state/continue outputs', () => {
    const region: RegionContract = {
      kind: 'fold',
      elementPorts: ['item'],
      statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
      continueOutput: 'continue',
    }
    const result = deriveBoundarySchema(body(), resolve, region)
    expect(result.diagnostics).toEqual([])
    const schema = result.schema!
    expect(inputsOf(schema).map(({ id, type }) => [id, type])).toEqual([
      ['item', { kind: 'list', element: TYPE }],
      ['state', TYPE],
      ['other', TYPE],
    ])
    expect(outputsOf(schema).map(({ id, type }) => [id, type])).toEqual([
      ['items', { kind: 'list', element: TYPE }],
      ['result', TYPE],
      ['others', { kind: 'list', element: TYPE }],
    ])
  })

  it('exports a flatten output as the body list type without another list wrapper', () => {
    const listBodySchema: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'out_item' ? { ...item, isList: true } : item),
    }
    const result = deriveBoundarySchema(body(), (type) => type === 'Body' ? listBodySchema : undefined, {
      kind: 'map', elementPorts: ['item'], outputRoles: { items: { kind: 'flatten' } },
    })
    expect(result.diagnostics).toEqual([])
    expect(outputsOf(result.schema!).find((item) => item.id === 'items')).toMatchObject({
      type: { kind: 'list', element: TYPE },
    })
    expect(outputsOf(result.schema!).find((item) => item.id === 'items')?.isList).toBeUndefined()
  })

  it('diagnoses flatten outputs with scalar and non-runtime-resolvable list body types', () => {
    const scalar = deriveBoundarySchema(body(), resolve, {
      kind: 'map', elementPorts: ['item'], outputRoles: { items: { kind: 'flatten' } },
    })
    expect(scalar.schema).toBeUndefined()
    expect(scalar.diagnostics).toContainEqual(expect.objectContaining({ code: 'doc.region.flattenNonList', severity: 'error' }))

    const variableListSchema: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'out_item' ? {
        ...item,
        type: { kind: 'list', element: { kind: 'variable', templateId: 'T' } } as const,
      } : item),
    }
    const variable = deriveBoundarySchema(body(), (type) => type === 'Body' ? variableListSchema : undefined, {
      kind: 'map', elementPorts: ['item'], outputRoles: { items: { kind: 'flatten' } },
    })
    expect(variable.schema).toBeDefined()
    expect(variable.diagnostics).toContainEqual(expect.objectContaining({ code: 'doc.region.flattenNonConcrete', severity: 'warning' }))
  })

  it('derives one definition cleanly for both a region and an ordinary occurrence', () => {
    const twoArg = deriveBoundarySchema(body(), resolve)
    const explicitUndefined = deriveBoundarySchema(body(), resolve, undefined)
    expect(JSON.stringify(explicitUndefined)).toBe(JSON.stringify(twoArg))
    expect(outputsOf(twoArg.schema!).map((item) => item.id)).toContain('continue')
    const region = deriveBoundarySchema(body(), resolve, {
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    expect(region.diagnostics).toEqual([])
    expect(region.schema).toBeDefined()
  })

  it('rejects same-id input and output boundaries for every occurrence kind', () => {
    const sameId = body()
    ;(sameId.boundary!.outputs[1] as { id: string }).id = 'state'
    expect(deriveBoundarySchema(sameId, resolve).diagnostics.map((d) => d.code)).toContain('boundary.duplicateId')
    expect(deriveBoundarySchema(sameId, resolve, {
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { state: { kind: 'state', statePort: 'state' } },
    }).diagnostics.map((d) => d.code)).toContain('boundary.duplicateId')

    const invalid = documentWith({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { state: { kind: 'state', statePort: 'state' } },
    })
    ;(invalid.graphs as Record<string, GraphDef>).body = sameId
    expect(codes(invalid)).toContain('doc.boundary.duplicateId')
    expect(loadDocument(JSON.parse(JSON.stringify(invalid))).diagnostics.map((d) => d.code)).toContain('doc.boundary.duplicateId')

    const rootOnly: WorkflowDocument = {
      ...invalid,
      graphs: { root: { ...invalid.graphs.root!, nodes: {}, nextOrdinal: 0 } },
      view: { graphs: { root: { nodes: {} } } },
    }
    const store = new DocumentStore(rootOnly, coreCommandRegistry())
    expect(store.dispatch({ command: 'subgraph.import', params: { graphs: { body: sameId } } as unknown as Json }).ok).toBe(false)
    expect(store.doc.graphs.body).toBeUndefined()
  })

  it('resolves two occurrences of one definition with distinct region schemas', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    const root = doc.graphs.root!
    ;(root.nodes as Record<string, unknown>).n1 = {
      id: 'n1',
      type: '#body',
      values: { state: 0 },
      region: { kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } }, continueOutput: 'continue', maxIterations: 3 },
    }
    const resolveOccurrence = documentNodeResolver(doc, resolve)
    const mapSchema = resolveOccurrence('root', root.nodes.n0!)!
    const whileSchema = resolveOccurrence('root', root.nodes.n1!)!

    expect(inputsOf(mapSchema).find((item) => item.id === 'item')?.type).toEqual({ kind: 'list', element: TYPE })
    expect(inputsOf(whileSchema).find((item) => item.id === 'item')?.type).toEqual(TYPE)
    expect(outputsOf(mapSchema).find((item) => item.id === 'result')?.type).toEqual({ kind: 'list', element: TYPE })
    expect(outputsOf(whileSchema).find((item) => item.id === 'result')?.type).toEqual(TYPE)
    expect(outputsOf(mapSchema).some((item) => item.id === 'continue')).toBe(true)
    expect(outputsOf(whileSchema).some((item) => item.id === 'continue')).toBe(false)
  })

  it('keeps occurrence schema cache identity injective for arbitrary ids', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    const first = doc.graphs.root!.nodes.n0!
    const second = {
      ...first,
      id: 'c' as never,
      region: { kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } }, continueOutput: 'continue', maxIterations: 2 } as const,
    }
    const resolveOccurrence = documentNodeResolver(doc, resolve)
    const firstSchema = resolveOccurrence('a', { ...first, id: 'b\u0000c' as never })!
    const secondSchema = resolveOccurrence('a\u0000b', second)!
    expect(inputsOf(firstSchema).find((item) => item.id === 'item')?.type).toEqual({ kind: 'list', element: TYPE })
    expect(inputsOf(secondSchema).find((item) => item.id === 'item')?.type).toEqual(TYPE)
  })

  it('exports a distinct state-role output with its referenced state input type and no legacy list flag', () => {
    const carried = { kind: 'list', element: TYPE } as const
    const mismatchedSchema: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => {
        if (item.id === 'in_state') return { ...item, type: carried }
        if (item.id === 'out_state') return { ...item, isList: true }
        return item
      }),
    }
    const result = deriveBoundarySchema(body(), (type) => type === 'Body' ? mismatchedSchema : undefined, {
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    const stateOutput = outputsOf(result.schema!).find((item) => item.id === 'result')!
    expect(stateOutput.type).toEqual(carried)
    expect(stateOutput.isList).toBeUndefined()
  })

  it('diagnoses a state body source incompatible with its referenced state input', () => {
    const mismatchedSchema: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'out_state' ? { ...item, type: COMBO } : item),
    }
    const result = deriveBoundarySchema(body(), (type) => type === 'Body' ? mismatchedSchema : undefined, {
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.map((d) => d.code)).toContain('doc.region.stateTypeMismatch')
  })

  it('mirrors backend region source mismatch severity and direct compatibility', () => {
    const deriveState = (sourceType: typeof TYPE | typeof BOOLEAN | typeof COMBO | { readonly kind: 'asset'; readonly element: typeof TYPE } | { readonly kind: 'variable'; readonly templateId: string }) =>
      deriveBoundarySchema(body(), (type) => type === 'Body' ? {
        ...bodySchema,
        items: bodySchema.items.map((item) => item.id === 'out_state' ? { ...item, type: sourceType } : item),
      } : undefined, {
        kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
        outputRoles: { result: { kind: 'state', statePort: 'state' } },
      })

    const ordinary = deriveState(BOOLEAN)
    expect(ordinary.schema).toBeDefined()
    expect(ordinary.diagnostics).toContainEqual(expect.objectContaining({ code: 'doc.region.stateTypeMismatch', severity: 'warning' }))

    const comboInput: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'in_state' ? { ...item, type: COMBO } : item),
    }
    const expectedCombo = deriveBoundarySchema(body(), (type) => type === 'Body' ? comboInput : undefined, {
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    expect(expectedCombo.schema).toBeUndefined()
    expect(expectedCombo.diagnostics).toContainEqual(expect.objectContaining({ code: 'doc.region.stateTypeMismatch', severity: 'error' }))

    const asset = deriveState({ kind: 'asset', element: TYPE })
    expect(asset.schema).toBeDefined()
    expect(asset.diagnostics).toContainEqual(expect.objectContaining({ code: 'doc.region.stateTypeMismatch', severity: 'warning' }))

    const unresolved = deriveState({ kind: 'variable', templateId: 'T' })
    expect(unresolved.diagnostics.map((d) => d.code)).not.toContain('doc.region.stateTypeMismatch')

    const comboContinuation: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'out_continue' ? { ...item, type: COMBO } : item),
    }
    const continuation = deriveBoundarySchema(body(), (type) => type === 'Body' ? comboContinuation : undefined, {
      kind: 'while', statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
      continueOutput: 'continue', maxIterations: 2,
    })
    expect(continuation.schema).toBeUndefined()
    expect(continuation.diagnostics).toContainEqual(expect.objectContaining({ code: 'doc.region.continueNotBoolean', severity: 'error' }))
  })

  it('advises on non-boolean continuation and non-concrete gathers', () => {
    const variableSchema: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'out_other' ? { ...item, type: { kind: 'variable', templateId: 'T' } } : item),
    }
    const result = deriveBoundarySchema(body(), (type) => type === 'Body' ? variableSchema : undefined, {
      kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } }, continueOutput: 'items', maxIterations: 2,
    })
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining([
      'doc.region.continueNotBoolean',
      'doc.region.gatherNonConcrete',
    ]))

    const listBoolean: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.id === 'out_continue' ? { ...item, isList: true } : item),
    }
    const listResult = deriveBoundarySchema(body(), (type) => type === 'Body' ? listBoolean : undefined, {
      kind: 'while', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } }, continueOutput: 'continue', maxIterations: 2,
    })
    expect(listResult.diagnostics.map((d) => d.code)).toContain('doc.region.continueNotBoolean')
  })
})

describe('region compile lowering', () => {
  it('authors the implicit immediate iteration index without a boundary port', () => {
    const document = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(document.graphs.body!.nodes as Record<string, unknown>).indexSink = { id: 'indexSink', type: 'IndexSink', values: {} }
    const schema = (type: string) => type === 'IndexSink' ? indexSinkSchema : resolve(type)
    const owner = { instancePath: [], node: 'n0' as never }
    const planned = planOccurrenceLinkCommand(document, schema, {
      command: 'occurrence.link.connect',
      owner,
      bodyGraph: 'body',
      from: { kind: 'body', endpoint: { node: '$region' as never, port: 'index' as never } },
      to: { kind: 'body', endpoint: { node: 'indexSink' as never, port: 'index' as never } },
    })
    expect(planned).toBeDefined()
    if (!planned) return
    const session = createLocalSession(document, coreCommandRegistry(), { schemaResolverFor: () => schema })
    const outcome = session.dispatch(planned.invocation)
    expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.body!.boundary!.inputs.map((item) => item.id)).toEqual(['item', 'state', 'other'])
    expect(session.doc.occurrenceTopologies?.n0?.links.l0).toEqual(expect.objectContaining({
      from: { kind: 'body', endpoint: { node: '$region', port: 'index' } },
      to: { kind: 'body', endpoint: { node: 'indexSink', port: 'index' } },
    }))
    expect(session.undo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.n0?.links.l0).toBeUndefined()
    expect(session.redo()).toBe(true)
    const reopened = loadDocument(JSON.parse(JSON.stringify(session.doc)))
    expect(reopened.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(reopened.document?.occurrenceTopologies?.n0?.links.l0?.from).toEqual({
      kind: 'body', endpoint: { node: '$region', port: 'index' },
    })

    const result = compile({
      document: reopened.document!,
      revision: 1,
      resolve: schema,
      scope: { kind: 'full' },
      connection: asConnectionId('index'),
      schemaHash: 'index',
      graphFeatures: ['regions'],
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const region = result.artifact.dinksterGraph!.nodes.n0 as { region: { body: { nodes: Record<string, { inputs: Record<string, unknown> }> } } }
    expect(region.region.body.nodes.indexSink!.inputs.index).toEqual({ $link: { node: '$region', output: 'index' } })

    const ordinary = structuredClone(document)
    delete (ordinary.graphs.root!.nodes.n0 as { region?: RegionContract }).region
    expect(planOccurrenceLinkCommand(ordinary, schema, {
      command: 'occurrence.link.connect', owner, bodyGraph: 'body',
      from: { kind: 'body', endpoint: { node: '$region' as never, port: 'index' as never } },
      to: { kind: 'body', endpoint: { node: 'indexSink' as never, port: 'index' as never } },
    })).toBeUndefined()
    expect(planOccurrenceLinkCommand(document, schema, {
      command: 'occurrence.link.connect', owner, bodyGraph: 'body',
      from: { kind: 'body', endpoint: { node: '$region' as never, port: 'unknown' as never } },
      to: { kind: 'body', endpoint: { node: 'indexSink' as never, port: 'index' as never } },
    })).toBeUndefined()
  })

  it('moves a body DynamicCombo selector into the native stored-choice map', () => {
    const comboSchema: NodeSchema = {
      type: 'ComboBody', displayName: 'Combo body', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'item', type: TYPE, optional: false },
        {
          kind: 'input', id: 'mode', type: COMBO, optional: false,
          dynamic: {
            kind: 'dynamicCombo', materialization: 'wire15',
            options: [{ key: 'scale', inputs: [{
              kind: 'input', id: 'amount', type: TYPE, optional: true,
              widget: { widgetType: 'NUMBER', default: 1, options: {} },
            }] }],
          },
        },
        { kind: 'output', id: 'out', type: TYPE },
      ],
    }
    const base = documentWith({ kind: 'map', elementPorts: ['item'] })
    const document: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        body: {
          ...base.graphs.body!,
          nodes: { n0: {
            id: 'n0' as never,
            type: 'ComboBody',
            values: { 'mode.amount': 2 },
            dynamic: { mode: { selected: 'scale' } },
          } },
          boundary: {
            inputs: [{ id: 'item' as never, binds: { kind: 'port', node: 'n0' as never, port: 'item' as never } }],
            outputs: [{ id: 'items' as never, binds: { kind: 'port', node: 'n0' as never, port: 'out' as never } }],
          },
        },
        root: {
          ...base.graphs.root!,
          nodes: { n0: { ...base.graphs.root!.nodes.n0!, values: { item: [] } } },
        },
      },
    }
    const result = compile({
      document,
      revision: 1,
      resolve: (type) => type === 'ComboBody' ? comboSchema : undefined,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
      graphFeatures: ['regions'],
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n0.n0']).toEqual({
      class_type: 'ComboBody',
      outputIds: ['out'],
      inputs: {
        item: { $link: { node: '$region', output: 'item' } },
        mode: 'scale',
        'mode.amount': 2,
      },
      slotVariants: { mode: 'scale' },
    })
    expect((result.artifact.dinksterGraph!.nodes.n0 as { region: { body: { nodes: Record<string, unknown> } } })
      .region.body.nodes.n0).toEqual({
      nodeType: 'ComboBody',
      inputs: {
        item: { $link: { node: '$region', output: 'item' } },
        'mode.amount': 2,
      },
      slotVariants: { mode: 'scale' },
    })

    const missing = structuredClone(document) as WorkflowDocument
    delete (missing.graphs.body!.nodes.n0 as { dynamic?: unknown }).dynamic
    const refused = compile({
      document: missing,
      revision: 1,
      resolve: (type) => type === 'ComboBody' ? comboSchema : undefined,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
      graphFeatures: ['regions'],
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.combo.missingChoice')
    }
  })

  it('uses canonical dynamic output ids in native body links across static and shared-count families', () => {
    const document = documentWith({ kind: 'map', elementPorts: ['item'] })
    Object.assign(document.graphs.body!.nodes, {
      source: { id: 'source', type: 'CountMultiSplitter', values: { count: 2 } },
      before: { id: 'before', type: 'Sink', values: {} },
      image: { id: 'image', type: 'Sink', values: {} },
      after: { id: 'after', type: 'Sink', values: {} },
      mask: { id: 'mask', type: 'Sink', values: {} },
    })
    Object.assign(document.graphs.body!.links, {
      before: { id: 'before', from: { node: 'source', port: 'before' }, to: { node: 'before', port: 'in' } },
      image: { id: 'image', from: { node: 'source', port: 'images', members: ['1'] }, to: { node: 'image', port: 'in' } },
      after: { id: 'after', from: { node: 'source', port: 'after' }, to: { node: 'after', port: 'in' } },
      mask: { id: 'mask', from: { node: 'source', port: 'masks', members: ['0'] }, to: { node: 'mask', port: 'in' } },
    })
    const result = compile({
      document,
      revision: 1,
      resolve: (type) => type === 'CountMultiSplitter'
        ? countMultiSplitterSchema
        : type === 'Sink'
          ? sinkSchema
          : resolve(type),
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
      graphFeatures: ['regions'],
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const nodes = (result.artifact.dinksterGraph!.nodes.n0 as { region: { body: { nodes: Record<string, unknown> } } }).region.body.nodes
    expect(nodes.source).toEqual(expect.objectContaining({
      outputMembers: { images: ['0', '1'], masks: ['0', '1'] },
    }))
    expect(nodes.before).toEqual(expect.objectContaining({
      inputs: { in: { $link: { node: 'source', output: 'before' } } },
    }))
    expect(nodes.image).toEqual(expect.objectContaining({
      inputs: { in: { $link: { node: 'source', output: 'images.1' } } },
    }))
    expect(nodes.after).toEqual(expect.objectContaining({
      inputs: { in: { $link: { node: 'source', output: 'after' } } },
    }))
    expect(nodes.mask).toEqual(expect.objectContaining({
      inputs: { in: { $link: { node: 'source', output: 'masks.0' } } },
    }))
  })

  it('rejects a region boundary bound to an output count input', () => {
    const document = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(document.graphs.body!.nodes as Record<string, unknown>).source = { id: 'source', type: 'CountMultiSplitter', values: { count: 2 } }
    ;(document.graphs.body!.boundary!.inputs as unknown[])[0] = {
      id: 'item' as never,
      binds: { kind: 'port', node: 'source' as never, port: 'count' as never },
    }
    const result = compile({
      document,
      revision: 1,
      resolve: (type) => type === 'CountMultiSplitter' ? countMultiSplitterSchema : resolve(type),
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
      graphFeatures: ['regions'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'compile.outputFamily.linkedCount',
        severity: 'error',
      }))
    }
  })

  it('lowers a map occurrence to one native region entry with body-local links', () => {
    const exact = compile({
      document: documentWith({ kind: 'map', elementPorts: ['item'] }),
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
      graphFeatures: ['regions'],
    })
    expect(exact.ok).toBe(true)
    if (!exact.ok) throw new Error('region compile unexpectedly failed')
    expect(exact.artifact.dinksterGraph).toEqual({
      nodes: {
        n0: {
          region: {
            kind: 'map',
            ports: {
              item: { kind: 'concrete', types: ['core.float'] },
              state: { kind: 'concrete', types: ['core.float'] },
              other: { kind: 'concrete', types: ['core.float'] },
            },
            elementPorts: ['item'],
            inputs: { item: [], state: 0, other: 0 },
            body: {
              nodes: {
                n0: {
                  nodeType: 'Body',
                  inputs: {
                    in_item: { $link: { node: '$region', output: 'item' } },
                    in_state: { $link: { node: '$region', output: 'state' } },
                    in_other: { $link: { node: '$region', output: 'other' } },
                  },
                },
              },
            },
            outputs: {
              items: { source: { node: 'n0', output: 'out_item' } },
              result: { source: { node: 'n0', output: 'out_state' } },
              others: { source: { node: 'n0', output: 'out_other' } },
              continue: { source: { node: 'n0', output: 'out_continue' } },
            },
          },
        },
      },
    })
  })

  it('lowers compact explicitly while keeping gather omitted', () => {
    const document = documentWith({
      kind: 'map', elementPorts: ['item'], outputRoles: { items: { kind: 'compact' } },
    })
    const exact = compile({
      document, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(exact.ok).toBe(true)
    if (!exact.ok) throw new Error('compact region compile unexpectedly failed')
    const outputs = (exact.artifact.dinksterGraph!.nodes.n0 as { region: { outputs: Record<string, unknown> } }).region.outputs
    expect(outputs).toMatchObject({
      items: { source: { node: 'n0', output: 'out_item' }, mode: 'compact' },
      others: { source: { node: 'n0', output: 'out_other' } },
    })
  })

  it('refuses backend admission type and selector failures at authored occurrences', () => {
    const compileWithBodySchema = (schema: NodeSchema, document = documentWith({
      kind: 'map',
      elementPorts: ['item'],
    })) => compile({
      document,
      revision: 1,
      resolve: (type) => type === 'Body' ? schema : type === 'Producer' ? producerSchema : undefined,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
      graphFeatures: ['regions', 'typedLiteral'],
    })

    const nonConcreteOutput: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.kind === 'output' && item.id === 'out_item'
        ? { ...item, type: { kind: 'variable' as const, templateId: 'T' } }
        : item),
    }
    const gather = compileWithBodySchema(nonConcreteOutput)
    expect(gather.ok).toBe(false)
    if (!gather.ok) expect(gather.diagnostics).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.gatherNonConcrete',
      data: { nodeId: 'n0', inputId: 'items' },
      anchor: expect.objectContaining({ occurrence: { instancePath: [], node: 'n0' } }),
    }))

    const nonConcreteInput: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.kind === 'input' && item.id === 'in_other'
        ? { ...item, type: { kind: 'wildcard' as const } }
        : item),
    }
    const literal = compileWithBodySchema(nonConcreteInput)
    expect(literal.ok).toBe(false)
    if (!literal.ok) expect(literal.diagnostics).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.literalOnNonConcrete',
      data: { nodeId: 'n0', inputId: 'other' },
      anchor: expect.objectContaining({ occurrence: { instancePath: [], node: 'n0' } }),
    }))

    const typedDocument = structuredClone(documentWith({ kind: 'map', elementPorts: ['item'] }))
    ;(typedDocument.graphs.root!.nodes.n0!.values as Record<string, Json>).other = { $typed: { type: 'core.float', value: 0 } }
    expect(compileWithBodySchema(nonConcreteInput, typedDocument).ok).toBe(true)

    const selectorSchema: NodeSchema = {
      ...bodySchema,
      selector: { input: 'in_state', branches: { false: 'in_item', true: 'in_other' } },
    }
    const selector = compileWithBodySchema(selectorSchema)
    expect(selector.ok).toBe(false)
    if (!selector.ok) expect(selector.diagnostics).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.selectorInRegion',
      data: { nodeId: 'n0/n0' },
      anchor: { occurrence: { instancePath: ['n0'], node: 'n0' } },
    }))

    const lazyInputSchema: NodeSchema = {
      ...bodySchema,
      items: bodySchema.items.map((item) => item.kind === 'input' && item.id === 'in_other'
        ? { ...item, lazy: true as const }
        : item),
    }
    expect(compileWithBodySchema(lazyInputSchema).ok).toBe(true)
  })

  it('skips muted regions and refuses bypassed regions', () => {
    const muted = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(muted.graphs.root!.nodes.n0 as { mode?: string }).mode = 'muted'
    const mutedResult = compile({
      document: muted, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(mutedResult.ok).toBe(true)
    if (mutedResult.ok) expect(mutedResult.artifact.dinksterGraph).toBeUndefined()

    const bypassed = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(bypassed.graphs.root!.nodes.n0 as { mode?: string }).mode = 'bypassed'
    const bypassedResult = compile({
      document: bypassed, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(bypassedResult.ok).toBe(false)
    if (!bypassedResult.ok) expect(bypassedResult.diagnostics).toContainEqual(expect.objectContaining({
      code: 'compile.region.bypassUnsupported',
      anchor: { occurrence: { instancePath: [], node: 'n0' } },
    }))
  })

  it('requires the regions backend capability in exact and would-run compile', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    const exact = compileDocument(doc)
    expect(exact.ok).toBe(false)
    if (!exact.ok) expect(exact.diagnostics).toEqual([expect.objectContaining({
      code: 'compile.region.backendUnsupported',
      anchor: { occurrence: { instancePath: [], node: 'n0' } },
    })])
    expect(scopeClosure({
      document: doc, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test',
    })).toBeUndefined()
  })

  it('does not require region capability for a partial target outside the region', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(doc.graphs.root!.nodes as Record<string, unknown>).outside = {
      id: 'outside', type: 'Body', values: { in_item: 1, in_state: 0, in_other: 0 },
    }
    const result = compile({
      document: doc, revision: 1, resolve,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: 'outside' as never }] },
      connection: asConnectionId('test'), schemaHash: 'test',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.artifact.dinksterGraph).toBeUndefined()
      expect(result.artifact.dinksterTargets).toBeUndefined()
    }
  })

  it('keeps outer producers when a partial target is inside a region body', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(doc.graphs.root!.nodes as Record<string, unknown>).producer = { id: 'producer', type: 'Producer', values: {} }
    ;(doc.graphs.root!.links as Record<string, unknown>).input = {
      id: 'input', from: { node: 'producer', port: 'value' }, to: { node: 'n0', port: 'item' },
    }
    const result = compile({
      document: doc, revision: 1, resolve,
      scope: { kind: 'partial', targets: [{ instancePath: ['n0' as never], node: 'n0' as never }] },
      connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    expect(result.artifact.dinksterTargets).toEqual(['n0'])
    expect(result.artifact.dinksterGraph?.nodes).toEqual(expect.objectContaining({
      producer: expect.objectContaining({ nodeType: 'Producer' }),
      n0: expect.objectContaining({ region: expect.objectContaining({
        inputs: expect.objectContaining({ item: { $link: { node: 'producer', output: 'value' } } }),
      }) }),
    }))
  })

  it('uses one state-output alias for the region entry and parent links', () => {
    const doc = documentWith({
      kind: 'fold',
      elementPorts: ['item'],
      statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    ;(doc.graphs.root!.nodes as Record<string, unknown>).consumer = {
      id: 'consumer', type: 'Body', values: { in_state: 0, in_other: 0 },
    }
    ;(doc.graphs.root!.links as Record<string, unknown>).out = {
      id: 'out', from: { node: 'n0', port: 'result' }, to: { node: 'consumer', port: 'in_item' },
    }
    const result = compile({
      document: doc, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('state region compile unexpectedly failed')
    const graph = result.artifact.dinksterGraph!
    expect(graph.nodes.n0).toEqual(expect.objectContaining({
      region: expect.objectContaining({
        outputs: expect.objectContaining({
          state: { source: { node: 'n0', output: 'out_state' }, mode: 'state' },
        }),
      }),
    }))
    expect(graph.nodes.consumer).toEqual(expect.objectContaining({
      inputs: expect.objectContaining({
        in_item: { $link: { node: 'n0', output: 'state' } },
      }),
    }))
    expect(result.artifact.provenance.outputAliases).toEqual({ n0: { result: 'state' } })
  })

  it('fans a region port out to every alsoBinds target through $region', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    ;(doc.graphs.body!.nodes as Record<string, unknown>).n1 = { id: 'n1', type: 'Body', values: {} }
    const other = doc.graphs.body!.boundary!.inputs.find((item) => item.id === 'other')!
    ;(other as { alsoBinds?: unknown }).alsoBinds = [{ kind: 'port', node: 'n1', port: 'in_other' }]
    const result = compile({
      document: doc, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('fan-out region compile unexpectedly failed')
    expect(result.artifact.dinksterGraph?.nodes.n0).toEqual(expect.objectContaining({
      region: expect.objectContaining({
        body: expect.objectContaining({
          nodes: expect.objectContaining({
            n0: expect.objectContaining({ inputs: expect.objectContaining({ in_other: { $link: { node: '$region', output: 'other' } } }) }),
            n1: expect.objectContaining({ inputs: expect.objectContaining({ in_other: { $link: { node: '$region', output: 'other' } } }) }),
          }),
        }),
      }),
    }))
  })

  it('recursively emits nested regions with ids local to each body scope', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    const inner = body()
    ;(inner as { id: string }).id = 'inner'
    ;(doc.graphs as Record<string, GraphDef>).inner = inner
    ;(inner.nodes as Record<string, unknown>).indexSink = { id: 'indexSink', type: 'IndexSink', values: {} }
    ;(doc.graphs.body!.nodes as Record<string, unknown>).n0 = {
      id: 'n0',
      type: '#inner',
      values: { item: [], state: 0, other: 0 },
      region: { kind: 'map', elementPorts: ['item'], outputRoles: { items: { kind: 'compact' } } },
    }
    for (const item of doc.graphs.body!.boundary!.inputs) {
      ;(item.binds as { port: string }).port = item.id
    }
    const outputPorts: Record<string, string> = { items: 'items', result: 'result', others: 'others', continue: 'continue' }
    for (const item of doc.graphs.body!.boundary!.outputs) {
      ;(item.binds as { port: string }).port = outputPorts[item.id]!
    }
    ;(doc as { occurrenceTopologies?: unknown }).occurrenceTopologies = {
      'n0.n0': {
        owner: { instancePath: ['n0'], node: 'n0' }, bodyGraph: 'inner', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: { kind: 'body', endpoint: { node: '$region', port: 'index' } },
            to: { kind: 'body', endpoint: { node: 'indexSink', port: 'index' } },
          },
        },
      },
    }
    const result = compile({
      document: doc, revision: 1, resolve: (type) => type === 'IndexSink' ? indexSinkSchema : resolve(type), scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`nested region compile failed: ${JSON.stringify(result.diagnostics)}`)
    const outer = result.artifact.dinksterGraph?.nodes.n0
    expect(outer).toEqual(expect.objectContaining({
      region: expect.objectContaining({
        body: { nodes: { n0: expect.objectContaining({ region: expect.objectContaining({
          kind: 'map',
          outputs: expect.objectContaining({ items: { source: { node: 'n0', output: 'out_item' }, mode: 'compact' } }),
        }) }) } },
        outputs: expect.objectContaining({ items: { source: { node: 'n0', output: 'items' } } }),
      }),
    }))
    if (outer && 'region' in outer) {
      const nested = outer.region.body.nodes.n0
      expect(nested && 'region' in nested ? nested.region.body.nodes.n0 : undefined).toEqual(expect.objectContaining({
        nodeType: 'Body',
      }))
      expect(nested && 'region' in nested ? nested.region.body.nodes.indexSink : undefined).toEqual(expect.objectContaining({
        inputs: { index: { $link: { node: '$region', output: 'index' } } },
      }))
    }
  })

  it('keeps ordinary subgraph compilation unchanged when no region block exists', () => {
    const doc = documentWith({ kind: 'map', elementPorts: ['item'] })
    delete (doc.graphs.root!.nodes.n0 as { region?: RegionContract }).region
    const result = compileDocument(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('ordinary subgraph compile unexpectedly failed')
    expect(result.artifact.prompt).toEqual({
      'n0.n0': { class_type: 'Body', inputs: { in_item: [], in_other: 0, in_state: 0 }, outputIds: ['out_item', 'out_state', 'out_other', 'out_continue'] },
    })
    expect(result.artifact.dinksterGraph).toBeUndefined()
  })
})

describe('region commands and atomic composition', () => {
  it('composes subgraph.import plus node.add(region) as one undoable batch', () => {
    const initial = documentWith({ kind: 'map', elementPorts: ['item'] })
    const rootOnly: WorkflowDocument = {
      ...initial,
      graphs: { root: { ...initial.graphs.root!, nodes: {}, nextOrdinal: 0 } },
      view: { graphs: { root: { nodes: {} } } },
    }
    const session = createLocalSession(rootOnly, coreCommandRegistry())
    const out = session.dispatch({ command: 'batch', params: { invocations: [
      { command: 'subgraph.import', params: { graphs: { body: body() } } },
      { command: 'node.add', params: { graphId: 'root', type: '#body', position: { x: 10, y: 20 }, values: { item: [] }, region: { kind: 'map', elementPorts: ['item'] } } },
    ] } as unknown as Json })
    expect(out.ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.doc.graphs.root!.nodes.n0!.region).toEqual({ kind: 'map', elementPorts: ['item'] })
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.body).toBeUndefined()
    expect(session.doc.graphs.root!.nodes).toEqual({})
    expect(session.doc.graphs.root!.nextOrdinal).toBe(1)
  })

  it('edits binding, max iterations, and paired roles with atomic undo', () => {
    const store = new DocumentStore(documentWith({ kind: 'fold', elementPorts: ['item'], statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } } }), coreCommandRegistry())
    expect(store.dispatch({ command: 'region.setBinding', params: { graphId: 'root', nodeId: 'n0', binding: 'broadcast' } }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.binding).toBe('broadcast')
    expect(store.dispatch({ command: 'region.setBinding', params: { graphId: 'root', nodeId: 'n0', binding: 'cross' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'region.setMaxIterations', params: { graphId: 'root', nodeId: 'n0', maxIterations: 9 } }).ok).toBe(true)
    const paired = store.dispatch({ command: 'batch', params: { invocations: [
      { command: 'region.setPortRole', params: { graphId: 'root', nodeId: 'n0', side: 'input', portId: 'other', role: 'state' } },
      { command: 'region.setOutputRole', params: { graphId: 'root', nodeId: 'n0', outputId: 'others', role: 'state', statePort: 'other' } },
    ] } })
    expect(paired.ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region).toMatchObject({
      binding: 'cross', maxIterations: 9, statePorts: ['state', 'other'],
      outputRoles: { result: { kind: 'state', statePort: 'state' }, others: { kind: 'state', statePort: 'other' } },
    })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.statePorts).toEqual(['state'])
    expect(store.dispatch({ command: 'region.setBinding', params: { graphId: 'root', nodeId: 'n0', binding: 'zip' } }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.binding).toBeUndefined()
    expect(store.dispatch({ command: 'region.setMaxIterations', params: { graphId: 'root', nodeId: 'n0', maxIterations: null } }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.maxIterations).toBeUndefined()
  })

  it('sets compact, flatten, and state output roles while keeping gather omission canonical', () => {
    const store = new DocumentStore(documentWith({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    }), coreCommandRegistry())
    expect(store.dispatch({
      command: 'region.setOutputRole',
      params: { graphId: 'root', nodeId: 'n0', outputId: 'others', role: 'state', statePort: 'state' },
    }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.outputRoles).toEqual({
      others: { kind: 'state', statePort: 'state' },
    })
    expect(store.dispatch({
      command: 'region.setOutputRole',
      params: { graphId: 'root', nodeId: 'n0', outputId: 'items', role: 'flatten' },
    }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.outputRoles).toEqual({
      others: { kind: 'state', statePort: 'state' }, items: { kind: 'flatten' },
    })
    expect(store.dispatch({
      command: 'region.setOutputRole',
      params: { graphId: 'root', nodeId: 'n0', outputId: 'items', role: 'compact' },
    }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.outputRoles).toEqual({
      others: { kind: 'state', statePort: 'state' }, items: { kind: 'compact' },
    })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.outputRoles?.items).toEqual({ kind: 'flatten' })
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.outputRoles?.items).toEqual({ kind: 'compact' })
    expect(store.dispatch({
      command: 'region.setOutputRole',
      params: { graphId: 'root', nodeId: 'n0', outputId: 'items', role: 'flatten', statePort: 'state' },
    }).ok).toBe(false)
    expect(store.dispatch({
      command: 'region.setOutputRole',
      params: { graphId: 'root', nodeId: 'n0', outputId: 'items', role: 'gather' },
    }).ok).toBe(true)
    expect(store.doc.graphs.root!.nodes.n0!.region?.outputRoles).toEqual({
      others: { kind: 'state', statePort: 'state' },
    })
    expect(store.dispatch({
      command: 'region.setPortRole',
      params: { graphId: 'root', nodeId: 'n0', side: 'output', portId: 'result', role: 'state' },
    }).ok).toBe(false)

    const whileStore = new DocumentStore(documentWith({
      kind: 'while', statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' }, items: { kind: 'gather' } },
      continueOutput: 'continue', maxIterations: 2,
    }), coreCommandRegistry())
    expect(whileStore.dispatch({
      command: 'region.setContinueOutput', params: { graphId: 'root', nodeId: 'n0', outputId: 'items' },
    }).ok).toBe(true)
    expect(whileStore.doc.graphs.root!.nodes.n0!.region).toMatchObject({
      continueOutput: 'items', outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
  })

  it('swaps state targets and exchanges state with continuation in atomic batches', () => {
    const foldStore = new DocumentStore(documentWith({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state', 'other'],
      outputRoles: {
        result: { kind: 'state', statePort: 'state' },
        others: { kind: 'state', statePort: 'other' },
      },
    }), coreCommandRegistry())
    expect(foldStore.dispatch({ command: 'batch', params: { invocations: [
      { command: 'region.setOutputRole', params: { graphId: 'root', nodeId: 'n0', outputId: 'result', role: 'state', statePort: 'other' } },
      { command: 'region.setOutputRole', params: { graphId: 'root', nodeId: 'n0', outputId: 'others', role: 'state', statePort: 'state' } },
    ] } }).ok).toBe(true)
    expect(foldStore.doc.graphs.root!.nodes.n0!.region?.outputRoles).toEqual({
      result: { kind: 'state', statePort: 'other' },
      others: { kind: 'state', statePort: 'state' },
    })

    const whileStore = new DocumentStore(documentWith({
      kind: 'while', statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
      continueOutput: 'continue', maxIterations: 2,
    }), coreCommandRegistry())
    expect(whileStore.dispatch({ command: 'batch', params: { invocations: [
      { command: 'region.setContinueOutput', params: { graphId: 'root', nodeId: 'n0', outputId: 'result' } },
      { command: 'region.setOutputRole', params: { graphId: 'root', nodeId: 'n0', outputId: 'continue', role: 'state', statePort: 'state' } },
    ] } }).ok).toBe(true)
    expect(whileStore.doc.graphs.root!.nodes.n0!.region).toMatchObject({
      continueOutput: 'result', outputRoles: { continue: { kind: 'state', statePort: 'state' } },
    })
  })

  it.each([
    ['unknown key', { kind: 'map', surprise: true }],
    ['legacy outputModes', { kind: 'map', outputModes: { items: 'gather' } }],
    ['wrong binding type', { kind: 'map', binding: 17 }],
    ['non-numeric maxIterations', { kind: 'map', maxIterations: 'unbounded' }],
    ['malformed output role', { kind: 'fold', statePorts: ['state'], outputRoles: { result: { kind: 'state' } } }],
  ])('rejects malformed region shape after a custom command: %s', (_label, malformed) => {
    const corruptRegion = {
      id: 'test.corruptRegion',
      run(_doc: WorkflowDocument, _params: unknown, tx: { set: (path: (string | number)[], value: Json) => void }) {
        tx.set(['graphs', 'root', 'nodes', 'n0', 'region'], malformed as Json)
        return []
      },
    }
    const initial = documentWith({ kind: 'map', elementPorts: ['item'] })
    const store = new DocumentStore(initial, coreCommandRegistry([corruptRegion as never]))
    const out = store.dispatch({ command: 'test.corruptRegion', params: {} })
    expect(out.ok).toBe(false)
    expect(out.diagnostics.map((d) => d.code)).toContain('doc.region.shapeInvalid')
    expect(store.doc.graphs.root!.nodes.n0!.region).toEqual(initial.graphs.root!.nodes.n0!.region)
  })
})
