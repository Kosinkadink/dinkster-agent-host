/**
 * Conditional constructs crossing subgraph boundaries.
 *
 * These tests intentionally assert exact prompt inputs. Selector state and
 * slot connectivity are occurrence-local compile inputs, not mutations of a
 * shared subgraph definition.
 */
import { describe, expect, it } from 'vitest'
import { compile, type CompileInput } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import { elaborateInterface } from '../src/schema/elaborate.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const FLOAT: TypeExpr = { kind: 'concrete', name: 'FLOAT' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({ kind: 'input', id, type: IMAGE, optional: false, ...extra })
const output = (id: string, type: TypeExpr = IMAGE): OutputSpec => ({ kind: 'output', id, type })
const widget = (id: string, value: number): InputSpec => input(id, {
  type: FLOAT,
  optional: true,
  widget: { widgetType: 'FLOAT', options: {}, default: value },
})
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type, displayName: type, category: 'test', source: 'v3', isOutputNode: true, items,
})
const combo = (id = 'mode', defaultOption?: string): InputSpec => ({
  ...input(id, { optional: true }),
  dynamic: {
    kind: 'dynamicCombo',
    options: [
      { key: 'a', inputs: [widget('amount', 1)] },
      { key: 'b', inputs: [widget('amount', 2), widget('bias', 3)] },
    ],
    ...(defaultOption ? { defaultOption } : {}),
  },
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  FloatSrc: schemaOf('FloatSrc', [output('out', FLOAT)]),
  Combo: schemaOf('Combo', [combo(), output('out')]),
  WireCombo: schemaOf('WireCombo', [{
    ...combo(),
    dynamic: { ...combo().dynamic!, materialization: 'wire15' },
  }, output('out')]),
  ComboFamily: schemaOf('ComboFamily', [
    combo(),
    { ...input('weights'), dynamic: { kind: 'autogrow', template: [widget('w', 0.5)], naming: { kind: 'prefix', prefix: 'w', min: 0, max: 4 } } },
    output('out'),
  ]),
  NestedCombo: schemaOf('NestedCombo', [
    {
      ...input('items'),
      dynamic: {
        kind: 'autogrow',
        template: [combo('sub')],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    },
    output('out'),
  ]),
  Slot: schemaOf('Slot', [
    { ...input('slot', { optional: true }), dynamic: { kind: 'dynamicSlot', slotType: IMAGE, inputs: [widget('gain', 4)] } },
    output('out'),
  ]),
}
const resolve = (type: string) => schemas[type]

type End = [node: string, port: string, members?: string[]]
type NodeSpec = { type: string; values?: Record<string, unknown>; dynamic?: Record<string, unknown> }
type GraphSpec = {
  nodes: Record<string, NodeSpec>
  links?: [from: End, to: End][]
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
}
const end = (e: End) => ({ node: e[0], port: e[1], ...(e[2] ? { members: e[2] } : {}) })
const docOf = (graphs: Record<string, GraphSpec>): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'test-lineage',
  root: 'g0',
  graphs: Object.fromEntries(Object.entries(graphs).map(([id, g]) => [id, {
    id,
    name: id,
    nodes: Object.fromEntries(Object.entries(g.nodes).map(([nid, n]) => [nid, {
      id: nid, type: n.type, values: n.values ?? {}, ...(n.dynamic ? { dynamic: n.dynamic } : {}),
    }])),
    links: Object.fromEntries((g.links ?? []).map((l, i) => [`l${i}`, { id: `l${i}`, from: end(l[0]), to: end(l[1]) }])),
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...(g.boundary ? { boundary: { inputs: g.boundary.inputs ?? [], outputs: g.boundary.outputs ?? [] } } : {}),
  }])),
  view: { graphs: {} },
} as unknown as WorkflowDocument)
const inputOf = (document: WorkflowDocument): CompileInput => ({
  document, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'test-schema-hash',
})
const run = (doc: WorkflowDocument) => compile(inputOf(doc))
const okPrompt = (doc: WorkflowDocument) => {
  const result = run(doc)
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.artifact.prompt
}
const selectorBoundary = (node = 'n', port = 'mode', members?: string[]) => ({
  inputs: [{ id: 'choice', binds: { kind: 'port', node, port, ...(members ? { members } : {}) } }],
  outputs: [],
})

describe('dynamic combo boundary lowering', () => {
  it('inherits a non-first definition selection and derives it as the boundary default', () => {
    const doc = docOf({
      g0: { nodes: { s: { type: '#sub' } } },
      sub: { nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } }, values: { 'mode.[b].amount': 22 } } }, boundary: selectorBoundary() },
    })
    expect(okPrompt(doc)['s.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': 22, 'mode.bias': 3 })
    const derived = deriveBoundarySchema(doc.graphs.sub!, resolve)
    expect(derived.diagnostics).toEqual([{ severity: 'warning', origin: 'schema', code: 'boundary.selectorOnly', message: "[sub] boundary input 'choice' forwards only the selector; branch inputs stay definition-owned. Upgrade to full-branch forwarding to edit them per instance." }])
    expect((derived.schema!.items[0] as InputSpec).dynamic).toMatchObject({ defaultOption: 'b' })
  })

  it('uses an explicit instance branch and its branch-local definition values', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: { s: { type: '#sub', dynamic: { choice: { selected: 'a' } } } } },
      sub: { nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } }, values: { 'mode.[a].amount': 17, 'mode.[b].amount': 29 } } }, boundary: selectorBoundary() },
    }))
    expect(prompt['s.n']!.inputs).toEqual({ mode: 'a', 'mode.amount': 17 })
  })

  it('keeps different selections on sibling occurrences', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: { a: { type: '#sub', dynamic: { choice: { selected: 'a' } } }, b: { type: '#sub', dynamic: { choice: { selected: 'b' } } } } },
      sub: { nodes: { n: { type: 'Combo', values: { 'mode.[a].amount': 10, 'mode.[b].amount': 20 } } }, boundary: selectorBoundary() },
    }))
    expect(prompt['a.n']!.inputs).toEqual({ mode: 'a', 'mode.amount': 10 })
    expect(prompt['b.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': 20, 'mode.bias': 3 })
  })

  it('carries explicit occurrence-local wire choices through selector forwarding', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: {
        a: { type: '#sub', dynamic: { choice: { selected: 'a' } } },
        b: { type: '#sub', dynamic: { choice: { selected: 'b' } } },
      } },
      sub: { nodes: { n: { type: 'WireCombo' } }, boundary: selectorBoundary() },
    }))
    expect(prompt['a.n']).toEqual({
      class_type: 'WireCombo',
      inputs: { mode: 'a', 'mode.amount': 1 },
      outputIds: ['out'],
      slotVariants: { mode: 'a' },
    })
    expect(prompt['b.n']).toEqual({
      class_type: 'WireCombo',
      inputs: { mode: 'b', 'mode.amount': 2, 'mode.bias': 3 },
      outputIds: ['out'],
      slotVariants: { mode: 'b' },
    })
  })

  it('rejects a missing wire choice reached through selector forwarding', () => {
    const result = run(docOf({
      g0: { nodes: { s: { type: '#sub' } } },
      sub: { nodes: { n: { type: 'WireCombo' } }, boundary: selectorBoundary() },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.combo.missingChoice')
  })

  it('ignores an invalid instance selection and inherits definition state', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: { s: { type: '#sub', dynamic: { choice: { selected: 'removed' } } } } },
      sub: { nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } } } }, boundary: selectorBoundary() },
    }))
    expect(prompt['s.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': 2, 'mode.bias': 3 })
  })

  it('chains selection forwarding and inherits the innermost choice when unset', () => {
    const graphs = (dynamic?: Record<string, unknown>): Record<string, GraphSpec> => ({
      g0: { nodes: { s: { type: '#outer', ...(dynamic ? { dynamic } : {}) } } },
      outer: { nodes: { i: { type: '#inner' } }, boundary: selectorBoundary('i', 'choice') },
      inner: { nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } } } }, boundary: selectorBoundary() },
    })
    expect(okPrompt(docOf(graphs({ choice: { selected: 'a' } })))['s.i.n']!.inputs).toEqual({ mode: 'a', 'mode.amount': 1 })
    expect(okPrompt(docOf(graphs()))['s.i.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': 2, 'mode.bias': 3 })
  })

  it('composes selector and family overlays on the same inner node', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: { s: { type: '#sub', dynamic: { choice: { selected: 'b' }, fam: { members: ['m0'] } }, values: { 'fam.w#m0': 0.8 } } } },
      sub: {
        nodes: { n: { type: 'ComboFamily', dynamic: { mode: { selected: 'a' } } } },
        boundary: { inputs: [
          { id: 'fam', binds: { kind: 'family', node: 'n', port: 'weights' } },
          { id: 'choice', binds: { kind: 'port', node: 'n', port: 'mode' } },
        ], outputs: [] },
      },
    }))
    expect(prompt['s.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': 2, 'mode.bias': 3, 'weights.w0': 0.8 })
  })

  it('overlays a selector in one materialized member without touching its sibling', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: { s: { type: '#sub', dynamic: { choice: { selected: 'a' } } } } },
      sub: {
        nodes: { n: { type: 'NestedCombo', dynamic: {
          items: { members: ['m0', 'm1'], memberState: { m0: { 'items.sub': { selected: 'b' } }, m1: { 'items.sub': { selected: 'b' } } } },
        } } },
        boundary: selectorBoundary('n', 'items.sub', ['m0']),
      },
    }))
    expect(prompt['s.n']!.inputs).toEqual({
      'items.item0.sub': 'a', 'items.item0.sub.amount': 1,
      'items.item1.sub': 'b', 'items.item1.sub.amount': 2, 'items.item1.sub.bias': 3,
    })
  })

  it('ignores a stale promoted value stored on a selector boundary item', () => {
    const prompt = okPrompt(docOf({
      g0: { nodes: { s: { type: '#sub', values: { choice: 'stale' } } } },
      sub: { nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } } } }, boundary: selectorBoundary() },
    }))
    expect(prompt['s.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': 2, 'mode.bias': 3 })
  })

  it('promotes a widget beneath an active branch as a value or link', () => {
    const sub: GraphSpec = {
      nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } } } },
      boundary: { inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'mode.[b].amount' } }], outputs: [] },
    }
    expect(okPrompt(docOf({ g0: { nodes: { s: { type: '#sub', values: { amount: 9 } } } }, sub }))['s.n']!.inputs)
      .toEqual({ mode: 'b', 'mode.amount': 9, 'mode.bias': 3 })
    expect(okPrompt(docOf({
      g0: { nodes: { src: { type: 'FloatSrc' }, s: { type: '#sub' } }, links: [[['src', 'out'], ['s', 'amount']]] }, sub,
    }))['s.n']!.inputs).toEqual({ mode: 'b', 'mode.amount': ['src', 0], 'mode.bias': 3 })
  })
})

describe('dynamic slot boundary lowering', () => {
  it('reveals dependents only when the forwarded slot is connected', () => {
    const sub: GraphSpec = {
      nodes: { n: { type: 'Slot', values: { 'slot.gain': 7 } } },
      boundary: { inputs: [{ id: 'slot', binds: { kind: 'port', node: 'n', port: 'slot' } }], outputs: [] },
    }
    expect(okPrompt(docOf({ g0: { nodes: { s: { type: '#sub' } } }, sub }))['s.n']!.inputs).toEqual({})
    expect(okPrompt(docOf({
      g0: { nodes: { src: { type: 'Src' }, s: { type: '#sub' } }, links: [[['src', 'out'], ['s', 'slot']]] }, sub,
    }))['s.n']!.inputs).toEqual({ slot: ['src', 0], 'slot.gain': 7 })
  })

  it('promotes a dependent when the slot is connected inside the definition', () => {
    const sub: GraphSpec = {
      nodes: { src: { type: 'Src' }, n: { type: 'Slot' } },
      links: [[['src', 'out'], ['n', 'slot']]],
      boundary: { inputs: [{ id: 'gain', binds: { kind: 'port', node: 'n', port: 'slot.gain' } }], outputs: [] },
    }
    expect(okPrompt(docOf({ g0: { nodes: { s: { type: '#sub', values: { gain: 8 } } } }, sub }))['s.n']!.inputs)
      .toEqual({ slot: ['s.src', 0], 'slot.gain': 8 })
    expect(okPrompt(docOf({
      g0: { nodes: { f: { type: 'FloatSrc' }, s: { type: '#sub' } }, links: [[['f', 'out'], ['s', 'gain']]] }, sub,
    }))['s.n']!.inputs).toEqual({ slot: ['s.src', 0], 'slot.gain': ['f', 0] })
  })
})

describe('selector elaboration', () => {
  it('keeps the selector widget default state-free while derived value follows state', () => {
    const e = elaborateInterface(schemaOf('Defaulted', [combo('mode', 'a')]), {
      values: {}, dynamic: { mode: { selected: 'b' } },
    })
    const selector = e.items.find((x) => x.kind === 'input' && x.origin.kind === 'selector')!
    if (selector.kind !== 'input') throw new Error('unreachable')
    expect(selector.spec.widget?.default).toBe('a')
    expect(selector.derivedValue).toBe('b')
  })
})
