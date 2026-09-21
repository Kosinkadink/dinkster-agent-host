/**
 * Whole-family forwarding lowering.
 *
 * Contract under test: definition-local prefix members and
 * instance-appended suffix members merge into OCCURRENCE-LOCAL derived state
 * only; member ids (never ordinals) are identity; api names and output
 * indexes are computed over the merged list per occurrence; one instance can
 * never see another's members or mutate the shared definition. Every test
 * asserts EXACT prompt wiring or output indexes, not just `ok`.
 *
 * Mixed integration (reroutes + value sources + primitives + nesting +
 * partial execution over forwarded topology) lives at the bottom - the
 * pieces must compose, not merely work in isolation.
 */
import { describe, expect, it } from 'vitest'
import type { ExecutionScope } from '../src/compile/artifact.js'
import { compile, type CompileInput } from '../src/compile/compile.js'
import { translateThroughCrossing, type FamilyCrossing } from '../src/compile/crossing.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
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
  isOutputNode: true, // keeps every node in full scope without sinks
  items,
})
const floatWidget = (def: number): Pick<InputSpec, 'widget'> => ({
  widget: { widgetType: 'FLOAT', options: {}, default: def },
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  Sink: schemaOf('Sink', [input('in')]),
  IntSource: schemaOf('IntSource', [{ ...output('out'), type: { kind: 'concrete', name: 'INT' } }]),
  IntValue: schemaOf('IntValue', [input('value', {
    type: { kind: 'concrete', name: 'INT' },
    widget: { widgetType: 'INT', options: {}, default: 0 },
  })]),
  IntSink: schemaOf('IntSink', [input('in', { type: { kind: 'concrete', name: 'INT' } })]),
  // Single-slot connectable family: wire names images.image0, image1, ...
  Batch: schemaOf('Batch', [
    {
      ...input('images'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 8 },
      },
    },
    output('out'),
  ]),
  FamilyFallbackRelay: schemaOf('FamilyFallbackRelay', [
    {
      ...input('images'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 8 },
      },
    },
    input('fallback', { optional: true }),
    output('out'),
  ]),
  Wire15Sink: schemaOf('Wire15Sink', [{
    ...input('items', { optional: true }),
    dynamic: {
      kind: 'autogrow', materialization: 'wire15',
      template: [input('value', { optional: true })],
      naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
    },
  }]),
  // Tight cap for over-cap safety tests.
  BatchCap2: schemaOf('BatchCap2', [
    {
      ...input('images'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 2 },
      },
    },
    output('out'),
  ]),
  // Widget-backed family: member values, defaults, promoted suffix values.
  Weigh: schemaOf('Weigh', [
    {
      ...input('weights'),
      dynamic: {
        kind: 'autogrow',
        template: [input('w', { optional: true, ...floatWidget(0.5) })],
        naming: { kind: 'prefix', prefix: 'w', min: 0, max: 8 },
      },
    },
    output('out'),
  ]),
  // Grouped template (two sockets + one widget) for slot-selective
  // forwarding: everything optional so any subset is selectable.
  Duo: schemaOf('Duo', [
    {
      ...input('pairs'),
      dynamic: {
        kind: 'autogrow',
        template: [
          input('image', { optional: true }),
          input('extra', { optional: true }),
          input('gain', { optional: true, ...floatWidget(0.5) }),
        ],
        naming: { kind: 'prefix', prefix: 'pair', min: 0, max: 6 },
      },
    },
    output('out'),
  ]),
  // Grouped OUTPUT family for slot-selective forwarding: output indexes are
  // assigned on the INNER node over the FULL template, selection or not.
  SplitDuo: schemaOf('SplitDuo', [
    input('src', { optional: true }),
    {
      ...output('douts'),
      dynamic: {
        kind: 'autogrow',
        template: [input('main', { optional: true }), input('aux', { optional: true })],
        naming: { kind: 'prefix', prefix: 'd', min: 0, max: 4 },
      },
    } as OutputSpec,
    output('last'),
  ]),
  // Nested family: items[m].sub[k] (Autogrow-in-Autogrow), plus a widget
  // per item so memberState AND values must both rebase through crossings.
  Nest: schemaOf('Nest', [
    {
      ...input('items'),
      dynamic: {
        kind: 'autogrow',
        template: [
          input('name', { optional: true, widget: { widgetType: 'STRING', options: {}, default: '' } }),
          {
            ...input('sub', { optional: true }),
            dynamic: {
              kind: 'autogrow',
              template: [input('s', { optional: true })],
              naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 4 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 5 },
      },
    },
    output('out'),
  ]),
  // Dynamic OUTPUT family followed by a static output (index arithmetic).
  Split: schemaOf('Split', [
    input('src', { optional: true }),
    {
      ...output('outs'),
      dynamic: {
        kind: 'autogrow',
        template: [input('o', { optional: true })],
        naming: { kind: 'prefix', prefix: 'o', min: 0, max: 6 },
      },
    } as OutputSpec,
    output('last'),
  ]),
  CountSplit: schemaOf('CountSplit', [
    input('count', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }),
    {
      ...output('outs'),
      dynamic: {
        kind: 'autogrow',
        template: [input('out', { optional: true })],
        naming: { kind: 'prefix', prefix: 'out', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    } as OutputSpec,
    output('last'),
  ]),
  NestedSplit: schemaOf('NestedSplit', [{
    ...output('outs'),
    dynamic: {
      kind: 'autogrow', naming: { kind: 'prefix', prefix: 'out', min: 0, max: 4 },
      template: [{
        ...input('sub', { optional: true }),
        dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
          template: [input('value', { optional: true })] },
      }],
    },
  }, output('last')]),
  WideCountSplit: schemaOf('WideCountSplit', [
    input('count', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }),
    {
      ...output('outs'),
      dynamic: {
        kind: 'autogrow',
        template: [input('out', { optional: true })],
        naming: { kind: 'prefix', prefix: 'out', min: 0, max: Number.MAX_SAFE_INTEGER },
        count: { input: 'count', suffix: 'index' },
      },
    } as OutputSpec,
    output('last'),
  ]),
  // Triple-nested family: a[mA].b[mB].c - two-hop ancestor routes.
  Deep3: schemaOf('Deep3', [
    {
      ...input('a'),
      dynamic: {
        kind: 'autogrow',
        template: [
          {
            ...input('b', { optional: true }),
            dynamic: {
              kind: 'autogrow',
              template: [
                {
                  ...input('c', { optional: true }),
                  dynamic: {
                    kind: 'autogrow',
                    template: [input('leaf', { optional: true })],
                    naming: { kind: 'prefix', prefix: 'leaf', min: 0, max: 3 },
                  },
                },
              ],
              naming: { kind: 'prefix', prefix: 'b', min: 0, max: 3 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'a', min: 0, max: 3 },
      },
    },
    output('out'),
  ]),
  // Two independent families on one node: cumulative occurrence overlays.
  TwoFam: schemaOf('TwoFam', [
    {
      ...input('imgs'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 8 },
      },
    },
    {
      ...input('ws'),
      dynamic: {
        kind: 'autogrow',
        template: [input('w', { optional: true, ...floatWidget(0.5) })],
        naming: { kind: 'prefix', prefix: 'w', min: 0, max: 8 },
      },
    },
    output('out'),
  ]),
  // Family whose template holds a DynamicCombo: selected-branch state and
  // branch values under a forwarded suffix member must both rebase.
  Modal: schemaOf('Modal', [
    {
      ...input('opts'),
      dynamic: {
        kind: 'autogrow',
        template: [
          {
            kind: 'input',
            id: 'mode',
            type: { kind: 'concrete', name: 'COMBO' },
            optional: true,
            dynamic: {
              kind: 'dynamicCombo',
              options: [
                { key: 'a', inputs: [input('x', { optional: true, ...floatWidget(1) })] },
                { key: 'b', inputs: [input('x', { optional: true, ...floatWidget(9) })] },
              ],
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'opt', min: 0, max: 4 },
      },
    },
    output('out'),
  ]),
  // Family whose template is a DynamicSlot with a widget dependent:
  // dependents elaborate from link EXISTENCE, so forwarding must project
  // connectivity through the boundary - per occurrence.
  SlotFam: schemaOf('SlotFam', [
    {
      ...input('slots'),
      dynamic: {
        kind: 'autogrow',
        template: [
          {
            ...input('s', { optional: true }),
            dynamic: {
              kind: 'dynamicSlot',
              slotType: IMAGE,
              inputs: [input('gain', { optional: true, ...floatWidget(2) })],
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 's', min: 0, max: 4 },
      },
    },
    output('out'),
  ]),
}
const resolve = (type: string) => schemas[type]

// ---------------------------------------------------------------------------
// Document builder (subgraph links, reroutes, value sources, nets)
// ---------------------------------------------------------------------------

type End =
  | [node: string, port: string, members?: string[]]
  | { reroute: string }
  | { valueSource: string }
  | { node: string; tap: string }
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
  nets?: Record<string, { source: End; sinks: End[] }>
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
      nets: Object.fromEntries(
        Object.entries(g.nets ?? {}).map(([name, n]) => [
          name,
          { name, source: end(n.source), sinks: n.sinks.map(end) },
        ]),
      ),
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

const inputOf = (doc: WorkflowDocument, scope: ExecutionScope = { kind: 'full' }): CompileInput => ({
  document: doc,
  revision: 1,
  resolve,
  scope,
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})
const run = (doc: WorkflowDocument, scope?: ExecutionScope) => compile(inputOf(doc, scope))
const okPrompt = (doc: WorkflowDocument) => {
  const result = run(doc)
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.artifact.prompt
}

/** Forwarding subgraph over one inner node: boundary input family + out port. */
const famSub = (innerType: string, opts?: { innerDynamic?: Record<string, unknown>; innerValues?: Record<string, unknown> }): GraphSpec => ({
  nodes: { n: { type: innerType, ...(opts?.innerDynamic ? { dynamic: opts.innerDynamic } : {}), ...(opts?.innerValues ? { values: opts.innerValues } : {}) } },
  boundary: {
    inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: innerFamilyOf(innerType) } }],
    outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
  },
})
const innerFamilyOf = (type: string): string =>
  type === 'Weigh' ? 'weights' : type === 'Nest' ? 'items' : type === 'SlotFam' ? 'slots' : 'images'

// ---------------------------------------------------------------------------
// Focused lowering behavior
// ---------------------------------------------------------------------------

describe('widget output boundary lowering', () => {
  const leaf = (value: number): GraphSpec => ({
    nodes: { n: { type: 'IntValue', values: { value } } },
    boundary: {
      inputs: [{ id: 'value', promoted: true, binds: { kind: 'port', node: 'n', port: 'value' } }],
      outputs: [{ id: 'valueOut', binds: { kind: 'widgetTap', node: 'n', tap: 'value' } }],
    },
  })

  it('bakes the inner widget value through a nested ordinary output boundary', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: { middle: { type: '#middle' }, sink: { type: 'IntSink' } },
        links: [[['middle', 'valueOut'], ['sink', 'in']]],
      },
      middle: {
        nodes: { leaf: { type: '#leaf' } },
        boundary: {
          outputs: [{ id: 'valueOut', binds: { kind: 'port', node: 'leaf', port: 'valueOut' } }],
        },
      },
      leaf: leaf(7),
    }))

    expect(prompt['sink']!.inputs.in).toBe(7)
  })

  it('forwards the real driver of the tapped widget input instead of its stored fallback', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: {
          source: { type: 'IntSource' },
          value: { type: '#leaf', values: { value: 99 } },
          sink: { type: 'IntSink' },
        },
        links: [
          [['source', 'out'], ['value', 'value']],
          [['value', 'valueOut'], ['sink', 'in']],
        ],
      },
      leaf: leaf(3),
    }))

    expect(prompt['sink']!.inputs.in).toEqual(['source', 0])
  })
})

describe('suffix members lower per occurrence', () => {
  it('links and widget values on suffix members reach the inner node with merged api names', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0', 'm1'] } }, values: { 'fam.w#m1': 0.9 } },
          },
          links: [[['a', 'out'], ['s', 'fam.w', ['m0']]]],
        },
        sub: famSub('Weigh'),
      }),
    )
    // No definition prefix: suffix members take ordinals 0 and 1.
    expect(prompt['s.n']!.inputs).toEqual({ 'weights.w0': ['a', 0], 'weights.w1': 0.9 })
  })

  it('definition prefix comes first; suffix ordinals continue after it', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s', 'fam.image', ['m0']]]],
        },
        sub: {
          nodes: {
            p: { type: 'Src' },
            n: { type: 'Batch', dynamic: { images: { members: ['d0'] } } },
          },
          links: [[['p', 'out'], ['n', 'images.image', ['d0']]]],
          boundary: {
            inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'images' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    // Prefix member d0 -> image0 (fed inside the definition); suffix -> image1.
    expect(prompt['s.n']!.inputs).toEqual({
      'images.image0': ['s.p', 0],
      'images.image1': ['a', 0],
    })
  })

  it('suffix widget defaults apply from the forwarded template', () => {
    const prompt = okPrompt(
      docOf({
        g0: { nodes: { s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } } } },
        sub: famSub('Weigh'),
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({ 'weights.w0': 0.5 })
  })

  it('two instances of one definition keep independent suffix state', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s1: { type: '#sub', dynamic: { fam: { members: ['m0', 'm1'] } }, values: { 'fam.w#m0': 0.1, 'fam.w#m1': 0.2 } },
            s2: { type: '#sub', dynamic: { fam: { members: ['m5'] } }, values: { 'fam.w#m5': 0.7 } },
            s3: { type: '#sub' },
          },
        },
        sub: famSub('Weigh'),
      }),
    )
    expect(prompt['s1.n']!.inputs).toEqual({ 'weights.w0': 0.1, 'weights.w1': 0.2 })
    expect(prompt['s2.n']!.inputs).toEqual({ 'weights.w0': 0.7 })
    // The suffix-less instance sees NOTHING (occurrence caches must not leak).
    expect(prompt['s3.n']!.inputs).toEqual({})
  })

  it('compilation never mutates the document (definitions, instances, snapshots)', () => {
    const doc = docOf({
      g0: {
        nodes: {
          s1: { type: '#sub', dynamic: { fam: { members: ['m0'] } }, values: { 'fam.w#m0': 0.3 } },
          s2: { type: '#sub' },
        },
      },
      sub: famSub('Weigh', { innerDynamic: { weights: { members: ['d0'] } } }),
    })
    const before = JSON.parse(JSON.stringify(doc)) as unknown
    const result = run(doc)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    expect(JSON.parse(JSON.stringify(doc))).toEqual(before)
  })

  it('member ids are identity: reordering suffix members moves values with them', () => {
    const graphs = (members: string[]): Record<string, GraphSpec> => ({
      g0: {
        nodes: {
          s: { type: '#sub', dynamic: { fam: { members } }, values: { 'fam.w#mA': 0.1, 'fam.w#mB': 0.9 } },
        },
      },
      sub: famSub('Weigh'),
    })
    expect(okPrompt(docOf(graphs(['mA', 'mB'])))['s.n']!.inputs).toEqual({ 'weights.w0': 0.1, 'weights.w1': 0.9 })
    expect(okPrompt(docOf(graphs(['mB', 'mA'])))['s.n']!.inputs).toEqual({ 'weights.w0': 0.9, 'weights.w1': 0.1 })
  })
})

describe('nested and chained forwarding', () => {
  it('forwards a nested family under a concrete ancestor member', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { subs: { members: ['k0'] } } },
          },
          links: [[['a', 'out'], ['s', 'subs.s', ['k0']]]],
        },
        sub: {
          nodes: { n: { type: 'Nest', dynamic: { items: { members: ['d0'] } } } },
          boundary: {
            inputs: [{ id: 'subs', binds: { kind: 'family', node: 'n', port: 'items.sub', members: ['d0'] } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    // Canonical nested naming: outer member segment, nested port id, then
    // nested prefix+ordinal ('items.item0.sub.sub0' - matches elaborate.ts).
    // The essential assertion: the suffix member of the NESTED family wires
    // under the correct concrete ancestor member.
    expect(prompt['s.n']!.inputs).toMatchObject({ 'items.item0.sub.sub0': ['a', 0] })
  })

  it('nested memberState on the instance rebases through the crossing (autogrow-in-autogrow)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: {
              type: '#sub',
              dynamic: {
                fam: { members: ['x0'], memberState: { x0: { 'fam.sub': { members: ['y0'] } } } },
              },
              values: { 'fam.name#x0': 'hello' },
            },
          },
          links: [[['a', 'out'], ['s', 'fam.sub.s', ['x0', 'y0']]]],
        },
        sub: famSub('Nest'),
      }),
    )
    expect(prompt['s.n']!.inputs).toMatchObject({
      'items.item0.name': 'hello',
      'items.item0.sub.sub0': ['a', 0],
    })
  })

  it('chains forwarding through two subgraph boundaries with additive ordinals', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#outer', dynamic: { fam2: { members: ['m0'] } }, values: { 'fam2.w#m0': 0.9 } },
          },
          links: [[['a', 'out'], ['s', 'fam2.w', ['m0']]]],
        },
        outer: {
          nodes: { i: { type: '#inner', dynamic: { fam1: { members: ['q0'] } }, values: { 'fam1.w#q0': 0.4 } } },
          boundary: {
            inputs: [{ id: 'fam2', binds: { kind: 'family', node: 'i', port: 'fam1' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'i', port: 'out' } }],
          },
        },
        inner: {
          nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['d0'] } }, values: { 'weights.w#d0': 0.1 } } },
          boundary: {
            inputs: [{ id: 'fam1', binds: { kind: 'family', node: 'n', port: 'weights' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    // Ordinals: inner definition prefix d0 -> w0, outer-definition member on
    // the mid instance q0 -> w1, root suffix m0 -> w2. The link (not the
    // stored value) drives w2: connections beat values.
    expect(prompt['s.i.n']!.inputs).toEqual({
      'weights.w0': 0.1,
      'weights.w1': 0.4,
      'weights.w2': ['a', 0],
    })
  })
})

describe('dynamic output forwarding', () => {
  it('forwards nested output families through two wrappers with independent sibling member state', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: {
          a: { type: '#outer', dynamic: { outputs: { members: ['m0'], memberState: {
            m0: { 'outputs.sub': { members: ['k0', 'k1'] } },
          } } } },
          b: { type: '#outer', dynamic: { outputs: { members: ['m0'], memberState: {
            m0: { 'outputs.sub': { members: ['k0'] } },
          } } } },
          first: { type: 'Sink' }, second: { type: 'Sink' }, other: { type: 'Sink' },
        },
        links: [
          [['a', 'outputs.sub.value', ['m0', 'k0']], ['first', 'in']],
          [['a', 'outputs.sub.value', ['m0', 'k1']], ['second', 'in']],
          [['b', 'outputs.sub.value', ['m0', 'k0']], ['other', 'in']],
        ],
      },
      outer: {
        nodes: { i: { type: '#inner' } },
        boundary: { outputs: [{ id: 'outputs', binds: { kind: 'family', node: 'i', port: 'outputs' } }] },
      },
      inner: {
        nodes: { n: { type: 'NestedSplit' } },
        boundary: { outputs: [{ id: 'outputs', binds: { kind: 'family', node: 'n', port: 'outs' } }] },
      },
    }))
    expect(prompt.first!.inputs).toEqual({ in: ['a.i.n', 0] })
    expect(prompt.second!.inputs).toEqual({ in: ['a.i.n', 1] })
    expect(prompt.other!.inputs).toEqual({ in: ['b.i.n', 0] })
  })

  const outSub: GraphSpec = {
    nodes: { n: { type: 'Split', dynamic: { outs: { members: ['d0'] } } } },
    boundary: {
      inputs: [{ id: 'src', binds: { kind: 'port', node: 'n', port: 'src' } }],
      outputs: [
        { id: 'fouts', binds: { kind: 'family', node: 'n', port: 'outs' } },
        { id: 'last', binds: { kind: 'port', node: 'n', port: 'last' } },
      ],
    },
  }

  it('suffix output members take merged wire indexes; static outputs shift after them', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            s: { type: '#sub', dynamic: { fouts: { members: ['m0', 'm1'] } } },
            k0: { type: 'Sink' },
            k1: { type: 'Sink' },
            k2: { type: 'Sink' },
          },
          links: [
            [['s', 'fouts.o', ['m0']], ['k0', 'in']],
            [['s', 'fouts.o', ['m1']], ['k1', 'in']],
            [['s', 'last'], ['k2', 'in']],
          ],
        },
        sub: outSub,
      }),
    )
    // Merged outputs on the inner node: d0 (index 0), suffix m0 (1), m1 (2), last (3).
    expect(prompt['k0']!.inputs).toEqual({ in: ['s.n', 1] })
    expect(prompt['k1']!.inputs).toEqual({ in: ['s.n', 2] })
    expect(prompt['k2']!.inputs).toEqual({ in: ['s.n', 3] })
  })

  it('input and output forwarding stay symmetric on one instance', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] }, fouts: { members: ['m0'] } } },
            k: { type: 'Sink' },
          },
          links: [
            [['a', 'out'], ['s', 'fam.image', ['m0']]],
            [['s', 'fouts.o', ['m0']], ['k', 'in']],
          ],
        },
        sub: {
          nodes: { b: { type: 'Batch' }, sp: { type: 'Split' } },
          links: [[['b', 'out'], ['sp', 'src']]],
          boundary: {
            inputs: [{ id: 'fam', binds: { kind: 'family', node: 'b', port: 'images' } }],
            outputs: [{ id: 'fouts', binds: { kind: 'family', node: 'sp', port: 'outs' } }],
          },
        },
      }),
    )
    expect(prompt['s.b']!.inputs).toEqual({ 'images.image0': ['a', 0] })
    expect(prompt['s.sp']!.inputs).toEqual({ src: ['s.b', 0] })
    expect(prompt['k']!.inputs).toEqual({ in: ['s.sp', 0] })
  })

  it('forwards hidden count-bound members and shifts following output indexes', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: { s: { type: '#sub' }, member: { type: 'Sink' }, last: { type: 'Sink' } },
        links: [
          [['s', 'fouts', ['1']], ['member', 'in']],
          [['s', 'last'], ['last', 'in']],
        ],
      },
      sub: {
        nodes: { n: { type: 'CountSplit', values: { count: 2 } } },
        boundary: {
          outputs: [
            { id: 'fouts', binds: { kind: 'family', node: 'n', port: 'outs' } },
            { id: 'last', binds: { kind: 'port', node: 'n', port: 'last' } },
          ],
        },
      },
    }))
    expect(prompt['s.n']!.outputMembers).toEqual({ outs: ['0', '1'] })
    expect(prompt.member!.inputs).toEqual({ in: ['s.n', 1] })
    expect(prompt.last!.inputs).toEqual({ in: ['s.n', 2] })
  })

  it('keeps promoted output counts independent across sibling instances', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: {
          a: { type: '#sub', values: { amount: 1 } },
          b: { type: '#sub', values: { amount: 3 } },
          first: { type: 'Sink' },
          third: { type: 'Sink' },
        },
        links: [
          [['a', 'fouts', ['0']], ['first', 'in']],
          [['b', 'fouts', ['2']], ['third', 'in']],
        ],
      },
      sub: {
        nodes: { n: { type: 'CountSplit', values: { count: 2 } } },
        boundary: {
          inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
          outputs: [{ id: 'fouts', binds: { kind: 'family', node: 'n', port: 'outs' } }],
        },
      },
    }))
    expect(prompt['a.n']!.inputs.count).toBe(1)
    expect(prompt['a.n']!.outputMembers).toEqual({ outs: ['0'] })
    expect(prompt['b.n']!.inputs.count).toBe(3)
    expect(prompt['b.n']!.outputMembers).toEqual({ outs: ['0', '1', '2'] })
    expect(prompt.first!.inputs).toEqual({ in: ['a.n', 0] })
    expect(prompt.third!.inputs).toEqual({ in: ['b.n', 2] })
  })

  it('preserves canonical count member identities through chained boundaries', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: { s: { type: '#outer', values: { rootCount: 2 } }, k: { type: 'Sink' } },
        links: [[['s', 'outerOuts', ['1']], ['k', 'in']]],
      },
      outer: {
        nodes: { i: { type: '#inner', values: { innerCount: 1 } } },
        boundary: {
          inputs: [{ id: 'rootCount', binds: { kind: 'port', node: 'i', port: 'innerCount' }, promoted: true }],
          outputs: [{ id: 'outerOuts', binds: { kind: 'family', node: 'i', port: 'innerOuts' } }],
        },
      },
      inner: {
        nodes: { n: { type: 'CountSplit', values: { count: 1 } } },
        boundary: {
          inputs: [{ id: 'innerCount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
          outputs: [{ id: 'innerOuts', binds: { kind: 'family', node: 'n', port: 'outs' } }],
        },
      },
    }))
    expect(prompt['s.i.n']!.inputs.count).toBe(2)
    expect(prompt['s.i.n']!.outputMembers).toEqual({ outs: ['0', '1'] })
    expect(prompt.k!.inputs).toEqual({ in: ['s.i.n', 1] })
  })

  it('fails closed before allocating a hostile fixed or promoted count', () => {
    const document = docOf({
      g0: {
        nodes: {
          fixed: { type: '#fixed' },
          promoted: { type: '#promoted', values: { amount: Number.MAX_SAFE_INTEGER } },
        },
      },
      fixed: {
        nodes: { n: { type: 'WideCountSplit', values: { count: Number.MAX_SAFE_INTEGER } } },
        boundary: { outputs: [{ id: 'outs', binds: { kind: 'family', node: 'n', port: 'outs' } }] },
      },
      promoted: {
        nodes: { n: { type: 'WideCountSplit', values: { count: 1 } } },
        boundary: {
          inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
          outputs: [{ id: 'outs', binds: { kind: 'family', node: 'n', port: 'outs' } }],
        },
      },
    })
    let result: ReturnType<typeof run> | undefined
    expect(() => { result = run(document) }).not.toThrow()
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) return
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('elab.outputFamily.countOutOfRange')
  })
})

describe('connectivity projection (DynamicSlot dependents through the boundary)', () => {
  it('a parent link into a forwarded slot member elaborates its dependents - per occurrence only', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s1: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
            s2: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s1', 'fam.s', ['m0']]]],
        },
        sub: famSub('SlotFam'),
      }),
    )
    // s1: slot connected -> dependent 'gain' elaborates with its default.
    expect(prompt['s1.n']!.inputs).toMatchObject({ 'slots.s0.s': ['a', 0], 'slots.s0.s.gain': 2 })
    // s2: same definition, same member id, NO link -> no dependent leaks over.
    expect(prompt['s2.n']!.inputs).toEqual({})
  })
})

describe('boundary address matching (dotted ids, ambiguity)', () => {
  it('a concrete boundary input with a dotted id resolves exactly', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, s: { type: '#sub' }, k: { type: 'Sink' } },
          links: [
            [['a', 'out'], ['s', 'in.image']],
            [['s', 'out.image'], ['k', 'in']],
          ],
        },
        sub: {
          nodes: { b: { type: 'Sink' }, o: { type: 'Src' } },
          boundary: {
            inputs: [{ id: 'in.image', binds: { kind: 'port', node: 'b', port: 'in' } }],
            outputs: [{ id: 'out.image', binds: { kind: 'port', node: 'o', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.b']!.inputs).toEqual({ in: ['a', 0] })
    expect(prompt['k']!.inputs).toEqual({ in: ['s.o', 0] })
  })

  it('a forwarded family with a dotted boundary id lowers', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { 'fam.set': { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s', 'fam.set.image', ['m0']]]],
        },
        sub: {
          nodes: { n: { type: 'Batch' } },
          boundary: {
            inputs: [{ id: 'fam.set', binds: { kind: 'family', node: 'n', port: 'images' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({ 'images.image0': ['a', 0] })
  })

  it('a colliding concrete id inside a family id space is an explicit ambiguity error', () => {
    // Boundary has family 'foo' AND concrete 'foo.bar': the memberless
    // address 'foo.bar' fits both interpretations. Never pick silently.
    const result = run(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, s: { type: '#sub' } },
          links: [[['a', 'out'], ['s', 'foo.bar']]],
        },
        sub: {
          nodes: { n: { type: 'Batch' }, b: { type: 'Sink' } },
          boundary: {
            inputs: [
              { id: 'foo', binds: { kind: 'family', node: 'n', port: 'images' } },
              { id: 'foo.bar', binds: { kind: 'port', node: 'b', port: 'in' } },
            ],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.ambiguousAddress')
  })

  it('a stored VALUE with prefix-colliding family ids fails loudly, never lowers a default', () => {
    // Families 'foo' and 'foo.bar' coexist (only exact duplicate ids are
    // rejected). The value address 'foo.bar.w' fits both namespaces: it must
    // be an explicit error - silently dropping it would compile the inner
    // default in place of a persisted value.
    const result = run(
      docOf({
        g0: {
          nodes: {
            s: {
              type: '#sub',
              dynamic: { 'foo.bar': { members: ['q0'] } },
              values: { 'foo.bar.w#q0': 0.8 },
            },
          },
        },
        sub: {
          nodes: { n: { type: 'Batch' }, w: { type: 'Weigh' } },
          boundary: {
            inputs: [
              { id: 'foo', binds: { kind: 'family', node: 'n', port: 'images' } },
              { id: 'foo.bar', binds: { kind: 'family', node: 'w', port: 'weights' } },
            ],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.ambiguousAddress')
  })
})

describe('ancestor materialization (nested forwarding)', () => {
  const nestSubThrough = (innerDynamic?: Record<string, unknown>): Record<string, GraphSpec> => ({
    g0: {
      // A suffix exists but nothing links: absence must STILL be an error -
      // the route itself is broken, not just one address.
      nodes: { s: { type: '#sub', dynamic: { subs: { members: ['k0'] } } } },
    },
    sub: {
      nodes: { n: { type: 'Nest', ...(innerDynamic ? { dynamic: innerDynamic } : {}) } },
      boundary: {
        inputs: [{ id: 'subs', binds: { kind: 'family', node: 'n', port: 'items.sub', members: ['d0'] } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
      },
    },
  })

  it('an unmaterialized concrete ancestor member is a compile error', () => {
    const result = run(docOf(nestSubThrough(undefined)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.forwardAncestorMissing')
  })

  it('orphan memberState without list membership does not count as materialized', () => {
    // memberState.d0 exists but d0 is NOT in `members` - the sole
    // membership source. Orphan state is dormant, never a route anchor.
    const result = run(
      docOf(nestSubThrough({ items: { members: [], memberState: { d0: { 'items.sub': { members: [] } } } } })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.forwardAncestorMissing')
  })

  it('a materialized ancestor member is accepted', () => {
    const result = run(docOf(nestSubThrough({ items: { members: ['d0'] } })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  })

  it('validates EVERY hop of a two-level ancestor path (Deep3)', () => {
    // Route a.b.c crosses TWO concrete ancestors: member mA of family 'a',
    // then member mB of the nested 'a.b' beneath it. Both must be
    // materialized; a missing SECOND hop must fail exactly like the first.
    const graphs = (state: Record<string, unknown>): Record<string, GraphSpec> => ({
      g0: { nodes: { s: { type: '#sub', dynamic: { leaf: { members: ['k0'] } } } } },
      sub: {
        nodes: { n: { type: 'Deep3', dynamic: state } },
        boundary: {
          inputs: [{ id: 'leaf', binds: { kind: 'family', node: 'n', port: 'a.b.c', members: ['mA', 'mB'] } }],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
        },
      },
    })
    const both = { a: { members: ['mA'], memberState: { mA: { 'a.b': { members: ['mB'] } } } } }
    const firstOnly = { a: { members: ['mA'] } }
    expect(run(docOf(graphs(both))).ok).toBe(true)
    const result = run(docOf(graphs(firstOnly)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.forwardAncestorMissing')
  })
})

describe('cumulative and occurrence-local behavior', () => {
  it('two forwarded families targeting one inner node overlay cumulatively', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: {
              type: '#sub',
              dynamic: { pics: { members: ['p0'] }, weights: { members: ['q0'] } },
              values: { 'weights.w#q0': 0.8 },
            },
          },
          links: [[['a', 'out'], ['s', 'pics.image', ['p0']]]],
        },
        sub: {
          nodes: { n: { type: 'TwoFam' } },
          boundary: {
            inputs: [
              { id: 'pics', binds: { kind: 'family', node: 'n', port: 'imgs' } },
              { id: 'weights', binds: { kind: 'family', node: 'n', port: 'ws' } },
            ],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({ 'imgs.image0': ['a', 0], 'ws.w0': 0.8 })
  })

  it('sibling instances with different output suffix counts keep independent wire indexes', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            s1: { type: '#sub', dynamic: { fouts: { members: ['m0', 'm1'] } } },
            s2: { type: '#sub', dynamic: { fouts: { members: ['z0'] } } },
            k1: { type: 'Sink' },
            k2: { type: 'Sink' },
          },
          links: [
            // s1's static 'last' sits AFTER two suffix outputs; s2's after one.
            [['s1', 'last'], ['k1', 'in']],
            [['s2', 'last'], ['k2', 'in']],
          ],
        },
        sub: {
          nodes: { n: { type: 'Split' } },
          boundary: {
            outputs: [
              { id: 'fouts', binds: { kind: 'family', node: 'n', port: 'outs' } },
              { id: 'last', binds: { kind: 'port', node: 'n', port: 'last' } },
            ],
          },
        },
      }),
    )
    expect(prompt['k1']!.inputs).toEqual({ in: ['s1.n', 2] })
    expect(prompt['k2']!.inputs).toEqual({ in: ['s2.n', 1] })
  })

  it('a DynamicCombo under a forwarded suffix member selects and values per instance', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            s1: {
              type: '#sub',
              dynamic: { fam: { members: ['m0'], memberState: { m0: { 'fam.mode': { selected: 'b' } } } } },
            },
            s2: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
        },
        sub: {
          nodes: { n: { type: 'Modal' } },
          boundary: {
            inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'opts' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    // s1 selected branch 'b' (x defaults 9); s2 defaults to branch 'a' (x 1).
    // Same member id on both instances: state must not bleed across.
    expect(prompt['s1.n']!.inputs).toEqual({ 'opts.opt0.mode': 'b', 'opts.opt0.mode.x': 9 })
    expect(prompt['s2.n']!.inputs).toEqual({ 'opts.opt0.mode': 'a', 'opts.opt0.mode.x': 1 })
  })

  it('chained concrete promotion: the outer instance value wins (first-write outside-in)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { s: { type: '#outer', values: { gain: 3 } } },
        },
        outer: {
          nodes: { i: { type: '#inner', values: { gain: 2 } } },
          boundary: {
            inputs: [{ id: 'gain', binds: { kind: 'port', node: 'i', port: 'gain' }, promoted: true }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'i', port: 'out' } }],
          },
        },
        inner: {
          nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['d0'] } }, values: { 'weights.w#d0': 1 } } },
          boundary: {
            inputs: [{ id: 'gain', binds: { kind: 'port', node: 'n', port: 'weights.w', members: ['d0'] }, promoted: true }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.i.n']!.inputs).toEqual({ 'weights.w0': 3 })
  })
})

describe('failure safety', () => {
  it('I1 obligation 7: active boundary death, bypassed shell, chained boundaries, and sibling overlays stay occurrence-correct', () => {
    const result = run(docOf({
      g0: {
        nodes: {
          familySource: { type: 'Src' },
          activeSource: { type: 'Src' },
          mutedSource: { type: 'Src', mode: 'muted' },
          left: { type: '#middle', dynamic: { fam: { members: ['left0', 'left1'] } } },
          right: { type: '#middle', dynamic: { fam: { members: ['right0'] } } },
          bypassedShell: { type: '#inner', mode: 'bypassed' },
          mutedShell: { type: '#inner', mode: 'muted' },
          leftTarget: { type: 'Wire15Sink' },
          rightTarget: { type: 'Wire15Sink' },
          shellTarget: { type: 'Wire15Sink' },
          mutedTarget: { type: 'Wire15Sink' },
        },
        links: [
          [['familySource', 'out'], ['left', 'fam.image', ['left0']]],
          [['familySource', 'out'], ['left', 'fam.image', ['left1']]],
          [['activeSource', 'out'], ['left', 'fallback']],
          [['left', 'out'], ['leftTarget', 'items.result']],
          [['familySource', 'out'], ['right', 'fam.image', ['right0']]],
          [['mutedSource', 'out'], ['right', 'fallback']],
          [['right', 'out'], ['rightTarget', 'items.result']],
          [['activeSource', 'out'], ['bypassedShell', 'fallback']],
          [['bypassedShell', 'out'], ['shellTarget', 'items.result']],
          [['activeSource', 'out'], ['mutedShell', 'fallback']],
          [['mutedShell', 'out'], ['mutedTarget', 'items.result']],
        ],
      },
      middle: {
        nodes: { inner: { type: '#inner' } },
        boundary: {
          inputs: [
            { id: 'fam', binds: { kind: 'family', node: 'inner', port: 'fam' } },
            { id: 'fallback', binds: { kind: 'port', node: 'inner', port: 'fallback' } },
          ],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'inner', port: 'out' } }],
        },
      },
      inner: {
        nodes: { relay: { type: 'FamilyFallbackRelay', mode: 'bypassed' } },
        boundary: {
          inputs: [
            { id: 'fam', binds: { kind: 'family', node: 'relay', port: 'images' } },
            { id: 'fallback', binds: { kind: 'port', node: 'relay', port: 'fallback' } },
          ],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'relay', port: 'out' } }],
        },
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.leftTarget!.inputs['items.result']).toEqual(['activeSource', 0])
    expect(result.artifact.prompt.rightTarget!.inputs['items.result']).toBeUndefined()
    expect(result.artifact.prompt.shellTarget!.inputs['items.result']).toEqual(['activeSource', 0])
    expect(result.artifact.prompt.mutedTarget!.inputs['items.result']).toBeUndefined()
    const warning = result.artifact.diagnostics.find((diagnostic) =>
      diagnostic.code === 'compile.bypass.structuralRouteDropped')
    expect(warning?.anchor?.occurrence).toEqual({ instancePath: ['right', 'inner'], node: 'relay' })
    expect(warning?.message).toContain("input 'fallback' at index 1")
  })

  it('I1 obligation 8: FamilyCrossing member keeps its index but is skipped as a bypass candidate', () => {
    const document = (withFallback: boolean) => docOf({
      g0: {
        nodes: {
          familySource: { type: 'Src' },
          fallbackSource: { type: 'Src' },
          shell: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          target: { type: 'Wire15Sink' },
        },
        links: [
          [['familySource', 'out'], ['shell', 'fam.image', ['m0']]],
          ...(withFallback ? [[['fallbackSource', 'out'], ['shell', 'fallback']] as [End, End]] : []),
          [['shell', 'out'], ['target', 'items.result']],
        ],
      },
      sub: {
        nodes: { relay: { type: 'FamilyFallbackRelay', mode: 'bypassed' } },
        boundary: {
          inputs: [
            { id: 'fam', binds: { kind: 'family', node: 'relay', port: 'images' } },
            { id: 'fallback', binds: { kind: 'port', node: 'relay', port: 'fallback' } },
          ],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'relay', port: 'out' } }],
        },
      },
    })

    const routed = run(document(true))
    expect(routed.ok, JSON.stringify(!routed.ok && routed.diagnostics)).toBe(true)
    if (routed.ok) {
      expect(routed.artifact.prompt.target!.inputs['items.result']).toEqual(['fallbackSource', 0])
      expect(routed.artifact.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('compile.bypass.unrouted')
    }

    const unrouted = run(document(false))
    expect(unrouted.ok, JSON.stringify(!unrouted.ok && unrouted.diagnostics)).toBe(true)
    if (unrouted.ok) {
      expect(unrouted.artifact.prompt.target!.inputs['items.result']).toBeUndefined()
      expect(unrouted.artifact.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.bypass.unrouted')
    }
  })

  it('an unknown suffix member id is a precise error', () => {
    const result = run(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } } },
          links: [[['a', 'out'], ['s', 'fam.w', ['nope']]]],
        },
        sub: famSub('Weigh'),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.forwardUnknownMember')
  })

  it('a family address without a member id is a precise error', () => {
    const result = run(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } } },
          links: [[['a', 'out'], ['s', 'fam.w']]],
        },
        sub: famSub('Weigh'),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((d) => d.code)).toContain('compile.boundary.forwardMemberMissing')
  })

  it('dead structural members exceed cap while a later live member exists: elab.autogrow.overMax and no trimmed prompt', () => {
    const result = run(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            dead: { type: 'Src', mode: 'muted' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
          links: [
            [['dead', 'out'], ['s', 'fam.image', ['m0']]],
            [['a', 'out'], ['s', 'fam.image', ['m0']]],
          ],
        },
        // Definition already AT cap (2 members): the merged list overflows.
        sub: {
          nodes: { n: { type: 'BatchCap2', dynamic: { images: { members: ['d0', 'd1'] } } } },
          boundary: {
            inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'images' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const codes = result.diagnostics.map((d) => d.code)
    expect(codes).toContain('elab.autogrow.overMax')
  })

  it('a muted forwarding instance stays unaudited; its links drop with warnings', () => {
    const result = run(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', mode: 'muted', dynamic: { fam: { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s', 'fam.w', ['m0']]]],
        },
        sub: famSub('Weigh'),
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['s.n']).toBeUndefined()
    expect(result.artifact.diagnostics.some((d) => d.code === 'compile.link.dropped')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mixed integration: reroutes + value sources + nets + forwarding + partial
// execution composed in single documents.
// ---------------------------------------------------------------------------

describe('slot-selective forwarding lowering (binds.slots, hazard F10)', () => {
  /** Duo forwarded with a selection; static out port for scope. */
  const duoSub = (slots?: string[]): GraphSpec => ({
    nodes: { n: { type: 'Duo' } },
    boundary: {
      inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'pairs', ...(slots ? { slots } : {}) } }],
      outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
    },
  })

  it('a selected slot lowers; omitted slots take template defaults on the inner node', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s', 'fam.image', ['m0']]]],
        },
        sub: duoSub(['image']),
      }),
    )
    // Grouped wire names: family.memberName.slot. 'gain' is unexposed, so
    // the inner elaboration bakes the template default; 'extra' stays absent.
    expect(prompt['s.n']!.inputs).toEqual({
      'pairs.pair0.image': ['a', 0],
      'pairs.pair0.gain': 0.5,
    })
  })

  it('a link addressing an unexposed slot fails loudly: compile.boundary.slotNotExposed', () => {
    const result = run(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s', 'fam.extra', ['m0']]]],
        },
        sub: duoSub(['image', 'gain']),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics.some((d) => d.code === 'compile.boundary.slotNotExposed')).toBe(true)
  })

  it('an explicit full selection lowers identically to no selection (unsplit safety)', () => {
    const graphs = (slots?: string[]): Record<string, GraphSpec> => ({
      g0: {
        nodes: {
          a: { type: 'Src' },
          s: { type: '#sub', dynamic: { fam: { members: ['m0'] } }, values: { 'fam.gain#m0': 0.9 } },
        },
        links: [[['a', 'out'], ['s', 'fam.image', ['m0']]]],
      },
      sub: duoSub(slots),
    })
    const selected = okPrompt(docOf(graphs(['image', 'extra', 'gain'])))
    const whole = okPrompt(docOf(graphs()))
    expect(selected).toEqual(whole)
    expect(selected['s.n']!.inputs).toEqual({
      'pairs.pair0.image': ['a', 0],
      'pairs.pair0.gain': 0.9,
    })
  })

  it('a stale value under an unexposed slot is dormant, never compiled and never an error', () => {
    // As if the boundary was narrowed AFTER the instance stored a gain value:
    // preserved-by-design state, the template default compiles instead.
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] } }, values: { 'fam.gain#m0': 0.9 } },
          },
        },
        sub: duoSub(['image']),
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({ 'pairs.pair0.gain': 0.5 })
  })

  it('chained forwarding narrows the selection and still lowers end to end', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#outer', dynamic: { fam2: { members: ['m0'] } } },
          },
          links: [[['a', 'out'], ['s', 'fam2.image', ['m0']]]],
        },
        outer: {
          nodes: { i: { type: '#sub' } },
          boundary: {
            inputs: [{ id: 'fam2', binds: { kind: 'family', node: 'i', port: 'fam', slots: ['image'] } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'i', port: 'out' } }],
          },
        },
        sub: duoSub(['image', 'gain']),
      }),
    )
    expect(prompt['s.i.n']!.inputs).toEqual({
      'pairs.pair0.image': ['a', 0],
      'pairs.pair0.gain': 0.5,
    })
  })

  it('output selection keeps inner output indexes computed over the FULL template', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            s: { type: '#sub2', dynamic: { fouts: { members: ['m0'] } } },
            k: { type: 'Sink' },
          },
          links: [[['s', 'fouts.aux', ['m0']], ['k', 'in']]],
        },
        sub2: {
          nodes: { n: { type: 'SplitDuo' } },
          boundary: {
            outputs: [{ id: 'fouts', binds: { kind: 'family', node: 'n', port: 'douts', slots: ['aux'] } }],
          },
        },
      }),
    )
    // Member m0 stamps main (idx 0) AND aux (idx 1) on the inner node even
    // though only aux is exposed - selection must not shift indexes.
    expect(prompt['k']!.inputs).toEqual({ in: ['s.n', 1] })
  })

  it('named net and reroute feed selected forwarded slots of two members', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0', 'm1'] } } },
          },
          reroutes: ['r0'],
          links: [
            [['a', 'out'], { reroute: 'r0' }],
            [{ reroute: 'r0' }, ['s', 'fam.image', ['m0']]],
          ],
          nets: { imgs: { source: ['a', 'out'], sinks: [['s', 'fam.image', ['m1']]] } },
        },
        sub: duoSub(['image']),
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({
      'pairs.pair0.image': ['a', 0],
      'pairs.pair0.gain': 0.5,
      'pairs.pair1.image': ['a', 0],
      'pairs.pair1.gain': 0.5,
    })
  })

  /** Nest forwarded with a dotted (nested-narrowing) selection. */
  const nestSelSub = (slots: string[]): GraphSpec => ({
    nodes: { n: { type: 'Nest' } },
    boundary: {
      inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'items', slots } }],
      outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
    },
  })

  it('a dotted selection narrows a nested construct and lowers through nested member state', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: {
              type: '#nsub',
              dynamic: { fam: { members: ['x0'], memberState: { x0: { 'fam.sub': { members: ['y0'] } } } } },
            },
          },
          links: [[['a', 'out'], ['s', 'fam.sub.s', ['x0', 'y0']]]],
        },
        nsub: nestSelSub(['sub.s']),
      }),
    )
    // Hidden 'name' bakes the inner template default; the nested wire lands
    // under the rebased ancestor member. The 'fam.sub'-keyed nested state
    // proves the ancestor CONSTRUCT stays addressable under a dotted entry.
    expect(prompt['s.n']!.inputs).toEqual({
      'items.item0.name': '',
      'items.item0.sub.sub0': ['a', 0],
    })
  })

  it('a stale nested address under a slot hidden by the selection fails: compile.boundary.slotNotExposed', () => {
    const result = run(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: {
              type: '#nsub',
              dynamic: { fam: { members: ['x0'], memberState: { x0: { 'fam.sub': { members: ['y0'] } } } } },
            },
          },
          links: [[['a', 'out'], ['s', 'fam.sub.s', ['x0', 'y0']]]],
        },
        nsub: nestSelSub(['name']),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics.some((d) => d.code === 'compile.boundary.slotNotExposed')).toBe(true)
  })

  it('exposure matching is segment-wise over dotted entries (crossing unit matrix)', () => {
    // Stale nested-sibling addresses ('fam.sub.t') cannot be built from the
    // shared fixtures, so the matrix is pinned directly on the ONE address
    // interpreter (crossing.ts) instead of a bespoke schema.
    const crossing: FamilyCrossing = {
      boundaryId: 'fam',
      side: 'input',
      targetNode: asNodeId('n'),
      hopMembers: [],
      hopPaths: [],
      familyPath: 'items',
      rebase: new Map([['m0', '\u0000m0']]),
      slots: new Set(['sub.s']),
    }
    const t = (port: string) => translateThroughCrossing(crossing, { port, members: ['m0'] })
    expect(t('fam').ok).toBe(true) // the family itself
    expect(t('fam.sub').ok).toBe(true) // ancestor construct of a selected path
    expect(t('fam.sub.s').ok).toBe(true) // the selected path
    expect(t('fam.sub.s.gain').ok).toBe(true) // beneath the selected path
    for (const port of ['fam.name', 'fam.sub.t', 'fam.su']) {
      const r = t(port)
      expect(r.ok, port).toBe(false)
      if (!r.ok) expect(r.code, port).toBe('compile.boundary.slotNotExposed')
    }
  })
})

describe('mixed integration', () => {
  it('value source -> reroute chain -> forwarded suffix member (baked, beats template default)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } } },
          reroutes: ['r0', 'r1'],
          valueSources: { v0: 0.75 },
          links: [
            [{ valueSource: 'v0' }, { reroute: 'r0' }],
            [{ reroute: 'r0' }, { reroute: 'r1' }],
            [{ reroute: 'r1' }, ['s', 'fam.w', ['m0']]],
          ],
        },
        sub: famSub('Weigh'),
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({ 'weights.w0': 0.75 })
  })

  it('forwarded dynamic output -> reroute -> consumer', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            s: { type: '#sub', dynamic: { fouts: { members: ['m0'] } } },
            k: { type: 'Sink' },
          },
          reroutes: ['r0'],
          links: [
            [['s', 'fouts.o', ['m0']], { reroute: 'r0' }],
            [{ reroute: 'r0' }, ['k', 'in']],
          ],
        },
        sub: {
          nodes: { n: { type: 'Split' } },
          boundary: {
            outputs: [{ id: 'fouts', binds: { kind: 'family', node: 'n', port: 'outs' } }],
          },
        },
      }),
    )
    expect(prompt['k']!.inputs).toEqual({ in: ['s.n', 0] })
  })

  it('prefix + suffix fed through reroutes inside AND outside the definition', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          },
          reroutes: ['r0'],
          links: [
            [['a', 'out'], { reroute: 'r0' }],
            [{ reroute: 'r0' }, ['s', 'fam.image', ['m0']]],
          ],
        },
        sub: {
          nodes: {
            p: { type: 'Src' },
            n: { type: 'Batch', dynamic: { images: { members: ['d0'] } } },
          },
          reroutes: ['ri'],
          links: [
            [['p', 'out'], { reroute: 'ri' }],
            [{ reroute: 'ri' }, ['n', 'images.image', ['d0']]],
          ],
          boundary: {
            inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'images' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({
      'images.image0': ['s.p', 0],
      'images.image1': ['a', 0],
    })
  })

  it('reroute chain crossing a CHAINED forwarded boundary, mixed with a named net', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#outer', dynamic: { fam2: { members: ['m0', 'm1'] } } },
          },
          reroutes: ['r0'],
          links: [
            [['a', 'out'], { reroute: 'r0' }],
            [{ reroute: 'r0' }, ['s', 'fam2.image', ['m0']]],
          ],
          nets: { imgs: { source: ['a', 'out'], sinks: [['s', 'fam2.image', ['m1']]] } },
        },
        outer: {
          nodes: { i: { type: '#inner' } },
          boundary: {
            inputs: [{ id: 'fam2', binds: { kind: 'family', node: 'i', port: 'fam1' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'i', port: 'out' } }],
          },
        },
        inner: {
          nodes: { n: { type: 'Batch' } },
          boundary: {
            inputs: [{ id: 'fam1', binds: { kind: 'family', node: 'n', port: 'images' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.i.n']!.inputs).toEqual({
      'images.image0': ['a', 0],
      'images.image1': ['a', 0],
    })
  })

  it('partial execution scopes through forwarded members and reroutes', () => {
    const doc = docOf({
      g0: {
        nodes: {
          a: { type: 'Src' },
          b: { type: 'Src' },
          s: { type: '#sub', dynamic: { fam: { members: ['m0'] } } },
          other: { type: 'Sink' },
        },
        reroutes: ['r0'],
        links: [
          [['a', 'out'], { reroute: 'r0' }],
          [{ reroute: 'r0' }, ['s', 'fam.image', ['m0']]],
          [['b', 'out'], ['other', 'in']],
        ],
      },
      sub: famSub('Batch'),
    })
    const result = run(doc, { kind: 'partial', targets: [{ instancePath: [asNodeId('s')], node: asNodeId('n') }] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    // Upstream closure of the inner node: itself + the Src feeding the
    // forwarded member (through the reroute). The unrelated branch is out.
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 's.n'])
  })

  it('one document composing prefix, suffix, chained forwarding, outputs, reroutes and a value source', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: {
              type: '#outer',
              dynamic: { fam2: { members: ['m0'] }, fouts: { members: ['z0'] } },
              values: { 'fam2.w#m0': 0.25 },
            },
            k: { type: 'Sink' },
          },
          reroutes: ['r0'],
          valueSources: { v0: 0.99 },
          links: [
            [{ valueSource: 'v0' }, { reroute: 'r0' }],
            // Value source beats the stored 0.25 (connections beat values).
            [{ reroute: 'r0' }, ['s', 'fam2.w', ['m0']]],
            [['s', 'fouts.o', ['z0']], ['k', 'in']],
          ],
        },
        outer: {
          nodes: {
            i: { type: '#inner', dynamic: { fam1: { members: ['q0'] } }, values: { 'fam1.w#q0': 0.5 } },
            sp: { type: 'Split' },
          },
          links: [[['i', 'out'], ['sp', 'src']]],
          boundary: {
            inputs: [{ id: 'fam2', binds: { kind: 'family', node: 'i', port: 'fam1' } }],
            outputs: [{ id: 'fouts', binds: { kind: 'family', node: 'sp', port: 'outs' } }],
          },
        },
        inner: {
          nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['d0'] } } } },
          boundary: {
            inputs: [{ id: 'fam1', binds: { kind: 'family', node: 'n', port: 'weights' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.i.n']!.inputs).toEqual({
      'weights.w0': 0.5, // definition default for prefix d0
      'weights.w1': 0.5, // mid-level member q0's stored value
      'weights.w2': 0.99, // root suffix m0: value source through reroute
    })
    expect(prompt['s.sp']!.inputs).toEqual({ src: ['s.i.n', 0] })
    expect(prompt['k']!.inputs).toEqual({ in: ['s.sp', 0] })
  })
})
