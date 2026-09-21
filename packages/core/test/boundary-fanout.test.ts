/**
 * Boundary input fan-out (`BoundaryItem.alsoBinds`).
 *
 * Contract under test: ONE promoted/external subgraph boundary input may
 * drive MANY inner input targets. The PRIMARY binding (`binds`) stays
 * authoritative for the derived type/widget/display; `alsoBinds` entries are
 * additional input-side 'port' targets that receive the same outer edge or
 * promoted value. Whole-family input forwarding may likewise fan out to
 * additional family targets. Outputs keep exactly one source.
 *
 * Layers pinned here: format shape validation, boundary schema derivation
 * (type/optionality/diagnostics), compiler lowering (links, value sources,
 * promoted values, nesting, dynamic members, muted targets), and the
 * boundary.addBinding / boundary.removeBinding commands (undo included).
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, type CompileInput } from '../src/compile/compile.js'
import type { BoundaryItem, GraphDef, WorkflowDocument } from '../src/format/document.js'
import { validateDocumentShape } from '../src/format/validate.js'
import { asConnectionId } from '../src/ids.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { inputsOf, type InputSpec, type NodeSchema, type OutputSpec, type TypeExpr } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const FLOAT: TypeExpr = { kind: 'concrete', name: 'FLOAT' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true, // keeps every test node in full scope without sinks
  items,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  // Required socket-only input: not satisfiable without a connection.
  Sink: schemaOf('Sink', [input('in')]),
  // FLOAT-typed input: fan-out type-mismatch target for an IMAGE boundary.
  FloatSink: schemaOf('FloatSink', [input('f', { type: FLOAT })]),
  // Widget-backed input: satisfiable without a connection, promotable.
  Knob: schemaOf('Knob', [
    input('v', { type: FLOAT, widget: { widgetType: 'FLOAT', options: {}, default: 0.5 } }),
  ]),
  // Single-slot autogrow (wire names images.image0, image1, ...): dynamic
  // member routes must fan out like static ports.
  Batcher: schemaOf('Batcher', [
    {
      ...input('images'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image')],
        naming: { kind: 'prefix', prefix: 'image', min: 1, max: 2 },
      },
    },
    output('out'),
  ]),
}
const resolve = (type: string) => schemas[type]

// ---------------------------------------------------------------------------
// Document builder (same shape as compile-forwarding.test.ts)
// ---------------------------------------------------------------------------

type End = [node: string, port: string, members?: string[]] | { reroute: string } | { valueSource: string }
type NodeSpec = {
  type: string
  values?: Record<string, unknown>
  dynamic?: Record<string, unknown>
  mode?: 'active' | 'muted' | 'bypassed'
}
type GraphSpec = {
  nodes: Record<string, NodeSpec>
  links?: [from: End, to: End][]
  reroutes?: string[]
  valueSources?: Record<string, unknown>
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
}

const end = (e: End): unknown =>
  Array.isArray(e) ? { node: e[0], port: e[1], ...(e[2] ? { members: e[2] } : {}) } : e

const docOf = (graphs: Record<string, GraphSpec>): WorkflowDocument => {
  const defs: Record<string, unknown> = {}
  for (const [id, g] of Object.entries(graphs)) {
    defs[id] = {
      id,
      name: id,
      nodes: Object.fromEntries(
        Object.entries(g.nodes).map(([nid, n]) => [
          nid,
          {
            id: nid,
            type: n.type,
            values: n.values ?? {},
            ...(n.dynamic ? { dynamic: n.dynamic } : {}),
            ...(n.mode ? { mode: n.mode } : {}),
          },
        ]),
      ),
      links: Object.fromEntries(
        (g.links ?? []).map((l, i) => [`l${i}`, { id: `l${i}`, from: end(l[0]), to: end(l[1]) }]),
      ),
      nets: {},
      reroutes: Object.fromEntries((g.reroutes ?? []).map((r) => [r, { id: r }])),
      ...(g.valueSources
        ? {
            valueSources: Object.fromEntries(
              Object.entries(g.valueSources).map(([vid, value]) => [vid, { id: vid, value }]),
            ),
          }
        : {}),
      nextOrdinal: 100,
      ...(g.boundary ? { boundary: { inputs: g.boundary.inputs ?? [], outputs: g.boundary.outputs ?? [] } } : {}),
    }
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs: defs,
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}

const inputOf = (doc: WorkflowDocument): CompileInput => ({
  document: doc,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})
const run = (doc: WorkflowDocument) => compile(inputOf(doc))
const okPrompt = (doc: WorkflowDocument) => {
  const result = run(doc)
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.artifact.prompt
}

const asDef = (d: unknown): GraphDef => d as GraphDef

/** Bare subgraph def literal for derivation tests. */
const defOf = (nodes: Record<string, NodeSpec>, boundary: { inputs?: unknown[]; outputs?: unknown[] }): GraphDef =>
  asDef({
    id: 'sub',
    name: 'sub',
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([nid, n]) => [
        nid,
        { id: nid, type: n.type, values: n.values ?? {}, ...(n.dynamic ? { dynamic: n.dynamic } : {}) },
      ]),
    ),
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    boundary: { inputs: boundary.inputs ?? [], outputs: boundary.outputs ?? [] },
  })

const bind = (node: string, port: string, members?: string[]) =>
  ({ kind: 'port', node, port, ...(members ? { members } : {}) }) as const

// ---------------------------------------------------------------------------
// Format shape validation
// ---------------------------------------------------------------------------

describe('format validation of alsoBinds', () => {
  const docWith = (item: unknown, side: 'inputs' | 'outputs' = 'inputs') =>
    docOf({
      g0: { nodes: {} },
      sub: {
        nodes: { s1: { type: 'Sink' }, s2: { type: 'Sink' }, src: { type: 'Src' } },
        boundary: side === 'inputs' ? { inputs: [item] } : { outputs: [item] },
      },
    }) as unknown

  const errorsOf = (json: unknown) => validateDocumentShape(json).filter((d) => d.severity === 'error')

  it('accepts a valid input-side fan-out', () => {
    expect(errorsOf(docWith({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] }))).toEqual([])
  })

  it('rejects alsoBinds on a boundary output', () => {
    const errs = errorsOf(docWith({ id: 'out', binds: bind('src', 'out'), alsoBinds: [bind('src', 'out2')] }, 'outputs'))
    expect(errs.some((d) => d.message.includes('alsoBinds') && d.message.includes('output'))).toBe(true)
  })

  it('rejects an empty alsoBinds array (canonical form omits it)', () => {
    const errs = errorsOf(docWith({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [] }))
    expect(errs.some((d) => d.message.includes('non-empty'))).toBe(true)
  })

  it('accepts family-kind alsoBinds when the primary forwards a family', () => {
    const errs = errorsOf(docWith({
      id: 'in',
      binds: { kind: 'family', node: 's1', port: 'in' },
      alsoBinds: [{ kind: 'family', node: 's2', port: 'in' }],
    }))
    expect(errs).toEqual([])
  })

  it('rejects an alsoBinds entry whose kind differs from the primary', () => {
    const errs = errorsOf(docWith({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [{ kind: 'family', node: 's2', port: 'in' }] }))
    expect(errs.some((d) => d.message.includes('alsoBinds[0]') && d.message.includes('primary binding kind'))).toBe(true)
  })

  it('rejects duplicating the primary target and duplicate entries', () => {
    const dupPrimary = errorsOf(docWith({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s1', 'in')] }))
    expect(dupPrimary.some((d) => d.message.includes('duplicate'))).toBe(true)
    const dupEntry = errorsOf(docWith({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in'), bind('s2', 'in')] }))
    expect(dupEntry.some((d) => d.message.includes('duplicate'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe('deriveBoundarySchema with fan-out', () => {
  it('derives one input from the primary; compatible fan-out adds no diagnostics', () => {
    const def = defOf(
      { s1: { type: 'Sink' }, s2: { type: 'Sink' } },
      { inputs: [{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] }] },
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics).toEqual([])
    const ins = inputsOf(schema!)
    expect(ins).toHaveLength(1)
    expect(ins[0]!.type).toEqual(IMAGE)
    // Both targets are required socket-only: not satisfiable unconnected.
    expect(ins[0]!.optional).toBe(false)
  })

  it('is satisfiable without a connection only when EVERY target is', () => {
    // Primary widget-backed alone: optional.
    const solo = defOf(
      { k1: { type: 'Knob' } },
      { inputs: [{ id: 'gain', binds: bind('k1', 'v') }] },
    )
    expect(inputsOf(deriveBoundarySchema(solo, resolve).schema!)[0]!.optional).toBe(true)
    // Adding a required socket-only target makes the boundary input required.
    const mixed = defOf(
      { k1: { type: 'Knob' }, f1: { type: 'FloatSink' } },
      { inputs: [{ id: 'gain', binds: bind('k1', 'v'), alsoBinds: [bind('f1', 'f')] }] },
    )
    expect(inputsOf(deriveBoundarySchema(mixed, resolve).schema!)[0]!.optional).toBe(false)
  })

  it('incompatible additional target types warn (boundary.fanoutTypeMismatch) but keep the schema', () => {
    const def = defOf(
      { s1: { type: 'Sink' }, f1: { type: 'FloatSink' } },
      { inputs: [{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('f1', 'f')] }] },
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.map((d) => [d.severity, d.code])).toEqual([['warning', 'boundary.fanoutTypeMismatch']])
    const ins = inputsOf(schema!)
    expect(ins).toHaveLength(1)
    expect(ins[0]!.type).toEqual(IMAGE) // primary stays authoritative
  })

  it('keeps the primary widget promotion regardless of fan-out', () => {
    const def = defOf(
      { k1: { type: 'Knob' }, k2: { type: 'Knob' } },
      { inputs: [{ id: 'gain', binds: bind('k1', 'v'), promoted: true, alsoBinds: [bind('k2', 'v')] }] },
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics).toEqual([])
    const gain = inputsOf(schema!)[0]!
    expect(gain.widget?.widgetType).toBe('FLOAT')
    expect(gain.optional).toBe(true) // both targets widget-backed
  })

  const errorCase = (item: unknown, extraNodes: Record<string, NodeSpec> = {}) => {
    const def = defOf({ s1: { type: 'Sink' }, s2: { type: 'Sink' }, b1: { type: 'Batcher' }, src: { type: 'Src' }, ...extraNodes }, { inputs: [item] })
    return deriveBoundarySchema(def, resolve)
  }

  it('derives whole-family input fan-out from the authoritative primary target', () => {
    const def = defOf(
      { b1: { type: 'Batcher' }, b2: { type: 'Batcher' } },
      { inputs: [{
        id: 'in',
        binds: { kind: 'family', node: 'b1', port: 'images' },
        alsoBinds: [{ kind: 'family', node: 'b2', port: 'images' }],
      }] },
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics).toEqual([])
    expect(inputsOf(schema!)[0]).toMatchObject({ id: 'in', dynamic: { kind: 'autogrow' } })
  })

  it('rejects a plain target in whole-family fan-out (boundary.fanoutKind)', () => {
    const { schema, diagnostics } = errorCase({ id: 'in', binds: { kind: 'family', node: 'b1', port: 'images' }, alsoBinds: [bind('s1', 'in')] })
    expect(diagnostics.some((d) => d.code === 'boundary.fanoutKind' && d.severity === 'error')).toBe(true)
    expect(schema).toBeUndefined()
  })

  it('rejects a family-kind fan-out entry (boundary.fanoutKind)', () => {
    const { diagnostics } = errorCase({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [{ kind: 'family', node: 'b1', port: 'images' }] })
    expect(diagnostics.some((d) => d.code === 'boundary.fanoutKind')).toBe(true)
  })

  it('rejects duplicate fan-out targets (boundary.duplicateBind)', () => {
    const { diagnostics } = errorCase({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s1', 'in')] })
    expect(diagnostics.some((d) => d.code === 'boundary.duplicateBind')).toBe(true)
  })

  it('rejects a fan-out target on a missing node (boundary.danglingNode)', () => {
    const { schema, diagnostics } = errorCase({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('ghost', 'in')] })
    expect(diagnostics.some((d) => d.code === 'boundary.danglingNode')).toBe(true)
    expect(schema).toBeUndefined()
  })

  it('rejects a fan-out target that is an OUTPUT port (boundary.sideMismatch)', () => {
    const { diagnostics } = errorCase({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('src', 'out')] })
    expect(diagnostics.some((d) => d.code === 'boundary.sideMismatch')).toBe(true)
  })

  it('rejects alsoBinds on outputs (boundary.fanoutOnOutput)', () => {
    const def = defOf(
      { src: { type: 'Src' } },
      { outputs: [{ id: 'out', binds: bind('src', 'out'), alsoBinds: [bind('src', 'out')] }] },
    )
    const { diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.some((d) => d.code === 'boundary.fanoutOnOutput' && d.severity === 'error')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Compiler lowering
// ---------------------------------------------------------------------------

describe('compile lowers boundary fan-out', () => {
  it.each([
    ['port', bind('src', 'out'), bind('src', 'out')],
    [
      'family',
      { kind: 'family', node: 'batch', port: 'images' },
      { kind: 'family', node: 'batch2', port: 'images' },
    ],
  ])('refuses an unconnected %s output fan-out before compiling the body', (_kind, primary, additional) => {
    const result = run(docOf({
      g0: { nodes: { i: { type: '#sub' } } },
      sub: {
        nodes: { src: { type: 'Src' }, batch: { type: 'Batcher' }, batch2: { type: 'Batcher' } },
        boundary: { outputs: [{ id: 'out', binds: primary, alsoBinds: [additional] }] },
      },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.boundary.forwardUnresolved')
  })

  it('one outer link drives every bound inner input', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, i: { type: '#sub' } },
          links: [[['a', 'out'], ['i', 'in']]],
        },
        sub: {
          nodes: { s1: { type: 'Sink' }, s2: { type: 'Sink' } },
          boundary: { inputs: [{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] }] },
        },
      }),
    )
    expect(prompt['i.s1']!.inputs).toEqual({ in: ['a', 0] })
    expect(prompt['i.s2']!.inputs).toEqual({ in: ['a', 0] })
  })

  it('a promoted value bakes into every target', () => {
    const prompt = okPrompt(
      docOf({
        g0: { nodes: { i: { type: '#sub', values: { gain: 2 } } } },
        sub: {
          nodes: { k1: { type: 'Knob' }, k2: { type: 'Knob' } },
          boundary: { inputs: [{ id: 'gain', binds: bind('k1', 'v'), promoted: true, alsoBinds: [bind('k2', 'v')] }] },
        },
      }),
    )
    expect(prompt['i.k1']!.inputs).toEqual({ v: 2 })
    expect(prompt['i.k2']!.inputs).toEqual({ v: 2 })
  })

  it('a value source through a reroute chain bakes into every target (mixed components)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { i: { type: '#sub' } },
          reroutes: ['r0', 'r1'],
          valueSources: { v0: 7 },
          links: [
            [{ valueSource: 'v0' }, { reroute: 'r0' }],
            [{ reroute: 'r0' }, { reroute: 'r1' }],
            [{ reroute: 'r1' }, ['i', 'gain']],
          ],
        },
        sub: {
          nodes: { k1: { type: 'Knob' }, k2: { type: 'Knob' } },
          boundary: { inputs: [{ id: 'gain', binds: bind('k1', 'v'), alsoBinds: [bind('k2', 'v')] }] },
        },
      }),
    )
    expect(prompt['i.k1']!.inputs).toEqual({ v: 7 })
    expect(prompt['i.k2']!.inputs).toEqual({ v: 7 })
  })

  it('fan-out recurses through a nested subgraph boundary (three sinks, one edge)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, i: { type: '#subA' } },
          links: [[['a', 'out'], ['i', 'in']]],
        },
        subA: {
          nodes: { s1: { type: 'Sink' }, si: { type: '#subB' } },
          boundary: { inputs: [{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('si', 'in')] }] },
        },
        subB: {
          nodes: { t1: { type: 'Sink' }, t2: { type: 'Sink' } },
          boundary: { inputs: [{ id: 'in', binds: bind('t1', 'in'), alsoBinds: [bind('t2', 'in')] }] },
        },
      }),
    )
    expect(prompt['i.s1']!.inputs).toEqual({ in: ['a', 0] })
    expect(prompt['i.si.t1']!.inputs).toEqual({ in: ['a', 0] })
    expect(prompt['i.si.t2']!.inputs).toEqual({ in: ['a', 0] })
  })

  it('dynamic member routes fan out (autogrow targets on two inner nodes)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, i: { type: '#sub' } },
          links: [[['a', 'out'], ['i', 'first']]],
        },
        sub: {
          nodes: {
            b1: { type: 'Batcher', dynamic: { images: { members: ['m0'] } } },
            b2: { type: 'Batcher', dynamic: { images: { members: ['m0'] } } },
          },
          boundary: {
            inputs: [{
              id: 'first',
              binds: bind('b1', 'images.image', ['m0']),
              alsoBinds: [bind('b2', 'images.image', ['m0'])],
            }],
          },
        },
      }),
    )
    expect(prompt['i.b1']!.inputs).toEqual({ 'images.image0': ['a', 0] })
    expect(prompt['i.b2']!.inputs).toEqual({ 'images.image0': ['a', 0] })
  })

  it('a muted fan-out target drops out without killing the live targets', () => {
    const result = run(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, i: { type: '#sub' } },
          links: [[['a', 'out'], ['i', 'in']]],
        },
        sub: {
          nodes: { s1: { type: 'Sink' }, s2: { type: 'Sink', mode: 'muted' } },
          boundary: { inputs: [{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] }] },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['i.s1']!.inputs).toEqual({ in: ['a', 0] })
    expect(result.artifact.prompt['i.s2']).toBeUndefined()
  })

  it('all targets muted collapses to the singular dead-edge policy (dropped-link warning)', () => {
    const result = run(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, i: { type: '#sub' } },
          links: [[['a', 'out'], ['i', 'in']]],
        },
        sub: {
          nodes: { s1: { type: 'Sink', mode: 'muted' }, s2: { type: 'Sink', mode: 'muted' } },
          boundary: { inputs: [{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] }] },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.diagnostics.some((d) => d.code === 'compile.link.dropped')).toBe(true)
    expect(result.artifact.prompt['i.s1']).toBeUndefined()
    expect(result.artifact.prompt['i.s2']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe('boundary.addBinding / boundary.removeBinding', () => {
  const baseDoc = (item: unknown) =>
    docOf({
      g0: { nodes: {} },
      sub: {
        nodes: { s1: { type: 'Sink' }, s2: { type: 'Sink' }, s3: { type: 'Sink' }, b1: { type: 'Batcher' } },
        boundary: { inputs: [item] },
      },
    })
  const makeStore = (item: unknown) => new DocumentStore(baseDoc(item), coreCommandRegistry())
  const itemOf = (store: DocumentStore): BoundaryItem =>
    (store.doc.graphs['sub'] as GraphDef).boundary!.inputs[0]!

  const params = (node: string, port = 'in', members?: string[]) =>
    ({ graphId: 'sub', itemId: 'in', node, port, ...(members ? { members } : {}) })

  it('addBinding appends a target and undo restores the exact previous state', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in') })
    const out = store.dispatch({ command: 'boundary.addBinding', params: params('s2') })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(itemOf(store).alsoBinds).toEqual([bind('s2', 'in')])
    expect(store.undo()).toBe(true)
    expect(itemOf(store).alsoBinds).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(itemOf(store).alsoBinds).toEqual([bind('s2', 'in')])
  })

  it('addBinding rejects duplicating the primary or an existing target', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] })
    for (const node of ['s1', 's2']) {
      const out = store.dispatch({ command: 'boundary.addBinding', params: params(node) })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.diagnostics.some((e) => e.code === 'boundary.duplicateBind')).toBe(true)
    }
  })

  it('addBinding rejects a family-forwarding item (boundary.bindKind)', () => {
    const store = makeStore({ id: 'in', binds: { kind: 'family', node: 'b1', port: 'images' } })
    const out = store.dispatch({ command: 'boundary.addBinding', params: params('s2') })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics.some((e) => e.code === 'boundary.bindKind')).toBe(true)
  })

  it('addBinding rejects a missing node and a missing item', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in') })
    const missingNode = store.dispatch({ command: 'boundary.addBinding', params: params('ghost') })
    expect(missingNode.ok).toBe(false)
    if (!missingNode.ok) expect(missingNode.diagnostics.some((e) => e.code === 'node.missing')).toBe(true)
    const missingItem = store.dispatch({ command: 'boundary.addBinding', params: { ...params('s2'), itemId: 'nope' } })
    expect(missingItem.ok).toBe(false)
    if (!missingItem.ok) expect(missingItem.diagnostics.some((e) => e.code === 'boundary.itemMissing')).toBe(true)
  })

  it('removeBinding prunes one target; removing the last drops the alsoBinds key entirely', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in'), bind('s3', 'in')] })
    expect(store.dispatch({ command: 'boundary.removeBinding', params: params('s2') }).ok).toBe(true)
    expect(itemOf(store).alsoBinds).toEqual([bind('s3', 'in')])
    expect(store.dispatch({ command: 'boundary.removeBinding', params: params('s3') }).ok).toBe(true)
    expect(itemOf(store).alsoBinds).toBeUndefined()
    expect('alsoBinds' in itemOf(store)).toBe(false) // canonical form: no empty []
    expect(store.undo()).toBe(true)
    expect(itemOf(store).alsoBinds).toEqual([bind('s3', 'in')])
  })

  it('removeBinding refuses the PRIMARY binding (boundary.primaryBind)', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] })
    const out = store.dispatch({ command: 'boundary.removeBinding', params: params('s1') })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics.some((e) => e.code === 'boundary.primaryBind')).toBe(true)
  })

  it('removeBinding on an absent target is a precise error (boundary.bindMissing)', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] })
    const out = store.dispatch({ command: 'boundary.removeBinding', params: params('s3') })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics.some((e) => e.code === 'boundary.bindMissing')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Node removal cascade
// ---------------------------------------------------------------------------

describe('node.remove prunes fan-out bindings', () => {
  const makeStore = (item: unknown) =>
    new DocumentStore(
      docOf({
        g0: { nodes: {} },
        sub: {
          nodes: { s1: { type: 'Sink' }, s2: { type: 'Sink' }, s3: { type: 'Sink' } },
          boundary: { inputs: [item] },
        },
      }),
      coreCommandRegistry(),
    )
  const inputsOfSub = (store: DocumentStore) => (store.doc.graphs['sub'] as GraphDef).boundary!.inputs

  it('removing a fan-out target prunes only that route; the item survives', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in'), bind('s3', 'in')] })
    expect(store.dispatch({ command: 'node.remove', params: { graphId: 'sub', nodeIds: ['s2'] } }).ok).toBe(true)
    expect(inputsOfSub(store)).toEqual([{ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s3', 'in')] }])
  })

  it('removing the last fan-out target omits alsoBinds entirely (canonical form)', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] })
    expect(store.dispatch({ command: 'node.remove', params: { graphId: 'sub', nodeIds: ['s2'] } }).ok).toBe(true)
    expect(inputsOfSub(store)).toEqual([{ id: 'in', binds: bind('s1', 'in') }])
  })

  it('removing the PRIMARY target drops the whole boundary item', () => {
    const store = makeStore({ id: 'in', binds: bind('s1', 'in'), alsoBinds: [bind('s2', 'in')] })
    expect(store.dispatch({ command: 'node.remove', params: { graphId: 'sub', nodeIds: ['s1'] } }).ok).toBe(true)
    expect(inputsOfSub(store)).toEqual([])
  })
})
