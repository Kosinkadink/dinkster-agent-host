/**
 * Bypass lowering integration (architecture section 6): bypassed nodes
 * compile to a type-matched passthrough over ELABORATED interfaces - through
 * reroute chains, chained bypassed nodes, value sources, nets, subgraph
 * instances (boundary schemas), boundary-fed inner nodes, and dynamic
 * members. Matching-rule unit coverage lives in bypass.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { compile, scopeClosure, type CompileInput } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

const T = (name: string): TypeExpr => ({ kind: 'concrete', name })
const IMAGE = T('IMAGE')
const LATENT = T('LATENT')
const INT = T('INT')
const FLOAT = T('FLOAT')

const inp = (id: string, type: TypeExpr, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type,
  optional: false,
  ...extra,
})
const out = (id: string, type: TypeExpr): OutputSpec => ({ kind: 'output', id, type })
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true, // keeps every node in full scope without sinks
  items,
})

const schemas: Record<string, NodeSchema> = {
  NSrc: schemaOf('NSrc', [out('out', INT)]),
  ISrc: schemaOf('ISrc', [out('out', IMAGE)]),
  LSrc: schemaOf('LSrc', [out('out', LATENT)]),
  ISink: schemaOf('ISink', [inp('in', IMAGE)]),
  LSink: schemaOf('LSink', [inp('in', LATENT)]),
  NSink: schemaOf('NSink', [inp('in', INT)]),
  IProc: schemaOf('IProc', [inp('in', IMAGE), out('out', IMAGE)]),
  NProc: schemaOf('NProc', [inp('in', INT), out('out', INT)]),
  // Two inputs/outputs of the same type: pins same-index preference.
  Pair: schemaOf('Pair', [inp('a', IMAGE), inp('b', IMAGE), out('out1', IMAGE), out('out2', IMAGE)]),
  // Same-index type differs; exact match lives at another index.
  Cross: schemaOf('Cross', [inp('img', IMAGE), inp('lat', LATENT), out('outL', LATENT), out('outI', IMAGE)]),
  WildPass: schemaOf('WildPass', [inp('img', IMAGE), inp('lat', LATENT), out('out', { kind: 'wildcard' })]),
  // Widget-backed FLOAT plus an IMAGE socket: pins "no widget forwarding".
  FProc: schemaOf('FProc', [
    inp('in', IMAGE),
    inp('val', FLOAT, { widget: { widgetType: 'FLOAT', options: {}, default: 1.5 } }),
    out('out', FLOAT),
  ]),
  FSink: schemaOf('FSink', [inp('in', FLOAT, { widget: { widgetType: 'FLOAT', options: {}, default: 9 } })]),
  NWidget: schemaOf('NWidget', [inp('value', INT, { widget: { widgetType: 'INT', options: {}, default: 17 } })]),
  // Autogrow IMAGE family: dynamic members as passthrough candidates.
  Batcher: schemaOf('Batcher', [
    {
      ...inp('images', IMAGE),
      dynamic: {
        kind: 'autogrow',
        template: [inp('image', IMAGE)],
        naming: { kind: 'prefix', prefix: 'image', min: 1, max: 4 },
      },
    },
    out('out', IMAGE),
  ]),
  SlotSink: schemaOf('SlotSink', [{
    ...inp('slot', IMAGE, { optional: true }),
    dynamic: {
      kind: 'dynamicSlot', slotType: IMAGE,
      inputs: [inp('gain', FLOAT, { optional: true, widget: { widgetType: 'FLOAT', options: {}, default: 0.5 } })],
    },
  }]),
  Wire15Relay: schemaOf('Wire15Relay', [
    {
      ...inp('items', IMAGE, { optional: true }),
      dynamic: {
        kind: 'autogrow', materialization: 'wire15',
        template: [inp('value', IMAGE, { optional: true })],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    },
    out('out', IMAGE),
  ]),
  Wire15Sink: schemaOf('Wire15Sink', [{
    ...inp('items', IMAGE, { optional: true }),
    dynamic: {
      kind: 'autogrow', materialization: 'wire15',
      template: [inp('value', IMAGE, { optional: true })],
      naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
    },
  }]),
  Wire15LatentSink: schemaOf('Wire15LatentSink', [{
    ...inp('items', LATENT, { optional: true }),
    dynamic: {
      kind: 'autogrow', materialization: 'wire15',
      template: [inp('value', LATENT, { optional: true })],
      naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
    },
  }]),
  Wire15NRelay: schemaOf('Wire15NRelay', [{
    ...inp('items', INT, { optional: true }),
    dynamic: { kind: 'autogrow', materialization: 'wire15', template: [inp('value', INT, { optional: true })], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 } },
  }, out('out', INT)]),
  Wire15NSink: schemaOf('Wire15NSink', [{
    ...inp('items', INT, { optional: true }),
    dynamic: { kind: 'autogrow', materialization: 'wire15', template: [inp('value', INT, { optional: true })], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 } },
  }]),
}
const resolve = (type: string): NodeSchema | undefined => schemas[type]

// -- Document builder (links may reference reroutes/value sources) -----------

type End =
  | { node: string; port: string; members?: string[] }
  | { reroute: string }
  | { valueSource: string }
  | { selector: string; candidate?: string }
  | { node: string; tap: string }
const P = (node: string, port: string, members?: string[]): End => ({ node, port, ...(members ? { members } : {}) })

interface BNode {
  type: string
  values?: Record<string, unknown>
  dynamic?: Record<string, unknown>
  mode?: 'active' | 'muted' | 'bypassed'
}
interface BGraph {
  nodes: Record<string, BNode>
  links?: [from: End, to: End][]
  nets?: { name: string; source: End; sinks: End[] }[]
  reroutes?: string[]
  valueSources?: Record<string, unknown>
  selectors?: Record<string, unknown>
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
}
const docOf = (root: BGraph, subgraphs?: Record<string, BGraph>): WorkflowDocument => {
  const defOf = (id: string, g: BGraph): unknown => ({
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
    links: Object.fromEntries((g.links ?? []).map((l, i) => [`l${i}`, { id: `l${i}`, from: l[0], to: l[1] }])),
    nets: Object.fromEntries((g.nets ?? []).map((n, i) => [`net${i}`, { id: `net${i}`, ...n }])),
    reroutes: Object.fromEntries((g.reroutes ?? []).map((r) => [r, { id: r }])),
    ...(g.valueSources ? { valueSources: g.valueSources } : {}),
    ...(g.selectors ? { selectors: g.selectors } : {}),
    nextOrdinal: 100,
    ...(g.boundary ? { boundary: { inputs: g.boundary.inputs ?? [], outputs: g.boundary.outputs ?? [] } } : {}),
  })
  const graphs: Record<string, unknown> = { g0: defOf('g0', root) }
  for (const [id, sub] of Object.entries(subgraphs ?? {})) graphs[id] = defOf(id, sub)
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs,
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}

const input = (doc: WorkflowDocument, scope: CompileInput['scope'] = { kind: 'full' }): CompileInput => ({
  document: doc,
  revision: 1,
  resolve,
  scope,
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})

const codesOf = (diags: readonly { code: string }[]): string[] => diags.map((d) => d.code)

describe('bypass passthrough basics', () => {
  it('expands every random selector branch reached behind a wire-15 bypass hop', () => {
    const doc = docOf({
      nodes: {
        first: { type: 'ISrc' },
        second: { type: 'ISrc' },
        relay: { type: 'Wire15Relay', mode: 'bypassed' },
        sink: { type: 'Wire15Sink' },
      },
      selectors: {
        choose: {
          id: 'choose',
          candidates: [{ id: 'first' }, { id: 'second' }],
          policy: { kind: 'random' },
        },
      },
      links: [
        [P('first', 'out'), { selector: 'choose', candidate: 'first' }],
        [P('second', 'out'), { selector: 'choose', candidate: 'second' }],
        [{ selector: 'choose' }, P('relay', 'items.selected')],
        [P('relay', 'out'), P('sink', 'items.result')],
      ],
    })
    const scope: CompileInput['scope'] = {
      kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }],
    }
    const exact = compile({ ...input(doc, scope), pickCandidate: () => 0 })
    expect(exact.ok, JSON.stringify(!exact.ok && exact.diagnostics)).toBe(true)
    if (exact.ok) expect(exact.artifact.prompt['sink']!.inputs['items.result']).toEqual(['first', 0])
    const closure = scopeClosure(input(doc, scope))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['first', 'second', 'sink'])
    expect([...closure!.structural.get('g0')!.selectors.get('choose')!].sort()).toEqual(['first', 'second'])
    expect(closure).not.toHaveProperty('diagnostics')
  })

  it('keeps a dead first structural wire-15 route selected without fallback and warns', () => {
    const make = (deadMode: 'active' | 'muted') => docOf({
      nodes: {
        dead: { type: 'ISrc', mode: deadMode },
        live: { type: 'ISrc' },
        relay: { type: 'Wire15Relay', mode: 'bypassed' },
        sink: { type: 'Wire15Sink' },
      },
      links: [
        [P('dead', 'out'), P('relay', 'items.dead')],
        [P('live', 'out'), P('relay', 'items.live')],
        [P('relay', 'out'), P('sink', 'items.result')],
      ],
    })
    const active = compile(input(make('active')))
    expect(active.ok, JSON.stringify(!active.ok && active.diagnostics)).toBe(true)
    if (active.ok) expect(active.artifact.prompt['sink']!.inputs['items.result']).toEqual(['dead', 0])

    const muted = compile(input(make('muted')))
    expect(muted.ok, JSON.stringify(!muted.ok && muted.diagnostics)).toBe(true)
    if (!muted.ok) return
    expect(muted.artifact.prompt['sink']!.inputs['items.result']).toBeUndefined()
    expect(muted.artifact.prompt['sink']!.inputs['items.live']).toBeUndefined()
    const warning = muted.artifact.diagnostics.find((diagnostic) =>
      diagnostic.code === 'compile.bypass.structuralRouteDropped')
    expect(warning?.message).toContain("input 'items.dead' at index 0")
    expect(warning?.message).toContain("producer 'dead' is muted or in an inactive occurrence")
    expect(warning?.anchor?.occurrence).toEqual({ instancePath: [], node: 'relay' })
  })

  it('attributes one multi-hop structural route death to the first bypass occurrence', () => {
    const result = compile(input(docOf({
      nodes: {
        dead: { type: 'ISrc', mode: 'muted' },
        upstream: { type: 'Wire15Relay', mode: 'bypassed' },
        downstream: { type: 'Wire15Relay', mode: 'bypassed' },
        sink: { type: 'Wire15Sink' },
      },
      links: [
        [P('dead', 'out'), P('upstream', 'items.dead')],
        [P('upstream', 'out'), P('downstream', 'items.forwarded')],
        [P('downstream', 'out'), P('sink', 'items.result')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const warnings = result.artifact.diagnostics.filter((diagnostic) =>
      diagnostic.code === 'compile.bypass.structuralRouteDropped')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.anchor?.occurrence).toEqual({ instancePath: [], node: 'downstream' })
    expect(warnings[0]!.message).toContain('through [downstream, upstream]')
    expect(warnings[0]!.message).toContain("producer 'dead' is muted or in an inactive occurrence")
    expect(result.artifact.prompt['sink']!.inputs['items.result']).toBeUndefined()
  })

  it('preserves wire-14 DynamicSlot dependents through reroutes and bypassed producers', () => {
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc' },
        p: { type: 'IProc', mode: 'bypassed' },
        rerouted: { type: 'SlotSink' },
        bypassed: { type: 'SlotSink' },
      },
      reroutes: ['r0'],
      links: [
        [P('a', 'out'), { reroute: 'r0' }],
        [{ reroute: 'r0' }, P('rerouted', 'slot')],
        [P('a', 'out'), P('p', 'in')],
        [P('p', 'out'), P('bypassed', 'slot')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['rerouted']!.inputs).toMatchObject({ slot: ['a', 0], 'slot.gain': 0.5 })
    expect(result.artifact.prompt['bypassed']!.inputs).toMatchObject({ slot: ['a', 0], 'slot.gain': 0.5 })
  })

  it('a bypassed node forwards its driven input; the node leaves the prompt', () => {
    const result = compile(input(docOf({
      nodes: { a: { type: 'ISrc' }, p: { type: 'IProc', mode: 'bypassed' }, k: { type: 'ISink' } },
      links: [[P('a', 'out'), P('p', 'in')], [P('p', 'out'), P('k', 'in')]],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'k'])
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
  })

  it('same-index preference routes each output to its own input', () => {
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc' }, b: { type: 'ISrc' },
        p: { type: 'Pair', mode: 'bypassed' },
        k1: { type: 'ISink' }, k2: { type: 'ISink' },
      },
      links: [
        [P('a', 'out'), P('p', 'a')], [P('b', 'out'), P('p', 'b')],
        [P('p', 'out1'), P('k1', 'in')], [P('p', 'out2'), P('k2', 'in')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k1']!.inputs['in']).toEqual(['a', 0])
    expect(result.artifact.prompt['k2']!.inputs['in']).toEqual(['b', 0])
  })

  it('exact type match wins when the same-index input has a different type', () => {
    // outL is output index 0; input index 0 is IMAGE - the LATENT input at
    // index 1 must be picked, and vice versa for outI.
    const result = compile(input(docOf({
      nodes: {
        i: { type: 'ISrc' }, l: { type: 'LSrc' },
        p: { type: 'Cross', mode: 'bypassed' },
        kl: { type: 'LSink' }, ki: { type: 'ISink' },
      },
      links: [
        [P('i', 'out'), P('p', 'img')], [P('l', 'out'), P('p', 'lat')],
        [P('p', 'outL'), P('kl', 'in')], [P('p', 'outI'), P('ki', 'in')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['kl']!.inputs['in']).toEqual(['l', 0])
    expect(result.artifact.prompt['ki']!.inputs['in']).toEqual(['i', 0])
  })

  it('undriven inputs are not candidates (bypass forwards connections)', () => {
    // Only Pair.b is driven; out1 (index 0) must still route through b.
    const result = compile(input(docOf({
      nodes: { b: { type: 'ISrc' }, p: { type: 'Pair', mode: 'bypassed' }, k: { type: 'ISink' } },
      links: [[P('b', 'out'), P('p', 'b')], [P('p', 'out1'), P('k', 'in')]],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['b', 0])
  })

  it('widget values never forward: no compatible driven input warns and drops the edge', () => {
    // FProc.out is FLOAT; the only driven input is IMAGE. The stored widget
    // value (val) must NOT leak through; the consumer keeps its own default.
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc' },
        p: { type: 'FProc', values: { val: 3.25 }, mode: 'bypassed' },
        k: { type: 'FSink' },
      },
      links: [[P('a', 'out'), P('p', 'in')], [P('p', 'out'), P('k', 'in')]],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(codesOf(result.artifact.diagnostics)).toContain('compile.bypass.unrouted')
    expect(result.artifact.prompt['k']!.inputs['in']).toBe(9) // own widget default
  })

  it('chained bypassed nodes trace to the real producer', () => {
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc' },
        p1: { type: 'IProc', mode: 'bypassed' },
        p2: { type: 'IProc', mode: 'bypassed' },
        k: { type: 'ISink' },
      },
      links: [
        [P('a', 'out'), P('p1', 'in')],
        [P('p1', 'out'), P('p2', 'in')],
        [P('p2', 'out'), P('k', 'in')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'k'])
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
  })

  it('a bypass cycle is a loud compile error', () => {
    const result = compile(input(docOf({
      nodes: {
        p1: { type: 'IProc', mode: 'bypassed' },
        p2: { type: 'IProc', mode: 'bypassed' },
        k: { type: 'ISink' },
      },
      links: [
        [P('p1', 'out'), P('p2', 'in')],
        [P('p2', 'out'), P('p1', 'in')],
        [P('p1', 'out'), P('k', 'in')],
      ],
    })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(codesOf(result.diagnostics)).toContain('compile.bypass.cycle')
  })

  it('a muted producer behind the passthrough makes the edge dead (dropped, unaudited)', () => {
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc', mode: 'muted' },
        p: { type: 'IProc', mode: 'bypassed' },
        k: { type: 'ISink' },
      },
      links: [[P('a', 'out'), P('p', 'in')], [P('p', 'out'), P('k', 'in')]],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const codes = codesOf(result.artifact.diagnostics)
    expect(codes).toContain('compile.link.dropped')
    expect(result.artifact.prompt['k']!.inputs['in']).toBeUndefined()
  })
})

describe('bypass with structural constructs', () => {
  it('passthrough traces through reroutes on both sides', () => {
    const result = compile(input(docOf({
      nodes: { a: { type: 'ISrc' }, p: { type: 'IProc', mode: 'bypassed' }, k: { type: 'ISink' } },
      reroutes: ['r0', 'r1'],
      links: [
        [P('a', 'out'), { reroute: 'r0' }], [{ reroute: 'r0' }, P('p', 'in')],
        [P('p', 'out'), { reroute: 'r1' }], [{ reroute: 'r1' }, P('k', 'in')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
  })

  it('a value source behind the passthrough bakes into the consumer', () => {
    const result = compile(input(docOf({
      nodes: { p: { type: 'NProc', mode: 'bypassed' }, k: { type: 'NSink' } },
      valueSources: { v0: { id: 'v0', value: 42 } },
      links: [[{ valueSource: 'v0' }, P('p', 'in')], [P('p', 'out'), P('k', 'in')]],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toBe(42)
  })

  it('a net sourced at a bypassed output delivers the passthrough to every sink', () => {
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc' }, p: { type: 'IProc', mode: 'bypassed' },
        k1: { type: 'ISink' }, k2: { type: 'ISink' },
      },
      links: [[P('a', 'out'), P('p', 'in')]],
      nets: [{ name: 'img', source: P('p', 'out'), sinks: [P('k1', 'in'), P('k2', 'in')] }],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k1']!.inputs['in']).toEqual(['a', 0])
    expect(result.artifact.prompt['k2']!.inputs['in']).toEqual(['a', 0])
  })

  it('a net can also DRIVE the bypassed node (net sink as passthrough source)', () => {
    const result = compile(input(docOf({
      nodes: { a: { type: 'ISrc' }, p: { type: 'IProc', mode: 'bypassed' }, k: { type: 'ISink' } },
      nets: [{ name: 'feed', source: P('a', 'out'), sinks: [P('p', 'in')] }],
      links: [[P('p', 'out'), P('k', 'in')]],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
  })

  it('dynamic autogrow member connections are passthrough candidates', () => {
    const result = compile(input(docOf({
      nodes: {
        a: { type: 'ISrc' },
        g: { type: 'Batcher', mode: 'bypassed', dynamic: { images: { members: ['m0'] } } },
        k: { type: 'ISink' },
      },
      links: [
        [P('a', 'out'), P('g', 'images.image', ['m0'])],
        [P('g', 'out'), P('k', 'in')],
      ],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
    expect(result.artifact.prompt['g']).toBeUndefined()
  })
})

describe('bypass and subgraphs', () => {
  const sub = {
    nodes: { p: { type: 'IProc' } as BNode },
    boundary: {
      inputs: [{ id: 'img', binds: { kind: 'port', node: 'p', port: 'in' } }],
      outputs: [{ id: 'out', binds: { kind: 'port', node: 'p', port: 'out' } }],
    },
  }

  it('a bypassed instance passes through at its boundary; contents never compile', () => {
    const result = compile(input(docOf(
      {
        nodes: { a: { type: 'ISrc' }, s: { type: '#sub', mode: 'bypassed' }, k: { type: 'ISink' } },
        links: [[P('a', 'out'), P('s', 'img')], [P('s', 'out'), P('k', 'in')]],
      },
      { sub },
    )))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'k'])
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
  })

  it('keeps the final consumer type through a reroute into a bypassed instance', () => {
    const typedSub = {
      nodes: { p: { type: 'WildPass' } as BNode },
      boundary: {
        inputs: [
          { id: 'image', binds: { kind: 'port', node: 'p', port: 'img' } },
          { id: 'latent', binds: { kind: 'port', node: 'p', port: 'lat' } },
        ],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'p', port: 'out' } }],
      },
    }
    const result = compile(input(docOf(
      {
        nodes: {
          image: { type: 'ISrc' },
          latent: { type: 'LSrc' },
          s: { type: '#sub', mode: 'bypassed' },
          k: { type: 'LSink' },
        },
        reroutes: ['r'],
        links: [
          [P('image', 'out'), P('s', 'image')],
          [P('latent', 'out'), P('s', 'latent')],
          [P('s', 'out'), { reroute: 'r' }],
          [{ reroute: 'r' }, P('k', 'in')],
        ],
      },
      { sub: typedSub },
    )))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['latent', 0])
  })

  it('a muted instance output resolves as disconnected without descending', () => {
    const result = compile(input(docOf(
      {
        nodes: { s: { type: '#sub', mode: 'muted' }, k: { type: 'ISink' } },
        links: [[P('s', 'out'), P('k', 'in')]],
      },
      { sub },
    )))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt)).toEqual(['k'])
    expect(result.artifact.prompt['k']!.inputs['in']).toBeUndefined()
    expect(result.artifact.diagnostics.map((d) => d.code)).toContain('compile.link.dropped')
    expect(result.artifact.diagnostics.map((d) => d.code)).toContain('compile.input.missing')
  })

  it('an incompatible bypass boundary warns clearly and leaves the consumer disconnected', () => {
    const incompatibleSub = {
      nodes: { p: { type: 'Cross' } as BNode },
      boundary: {
        inputs: [{ id: 'latent', binds: { kind: 'port', node: 'p', port: 'lat' } }],
        outputs: [{ id: 'image', binds: { kind: 'port', node: 'p', port: 'outI' } }],
      },
    }
    const result = compile(input(docOf(
      {
        nodes: { a: { type: 'LSrc' }, s: { type: '#sub', mode: 'bypassed' }, k: { type: 'ISink' } },
        links: [[P('a', 'out'), P('s', 'latent')], [P('s', 'image'), P('k', 'in')]],
      },
      { sub: incompatibleSub },
    )))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const unrouted = result.artifact.diagnostics.find((d) => d.code === 'compile.bypass.unrouted')
    expect(unrouted?.message).toContain("'s'")
    expect(unrouted?.message).toContain("'image'")
    expect(result.artifact.prompt['k']!.inputs['in']).toBeUndefined()
  })

  it('a nested inactive instance stops only its own expansion', () => {
    const outer = {
      nodes: { inner: { type: '#sub', mode: 'muted' } as BNode },
      boundary: { inputs: [], outputs: [] },
    }
    const result = compile(input(docOf({ nodes: { outer: { type: '#outer' }, a: { type: 'ISrc' } } }, { sub, outer })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt)).toEqual(['a'])
  })

  it.each(['muted', 'bypassed'] as const)('refuses a partial target under a %s instance', (mode) => {
    const result = compile(input(
      docOf({ nodes: { s: { type: '#sub', mode } } }, { sub }),
      { kind: 'partial', targets: [{ instancePath: [asNodeId('s')], node: asNodeId('p') }] },
    ))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.some((d) => d.code === 'compile.scope.inactiveAncestor' && d.message.includes(mode))).toBe(true)
  })

  it('a bypassed INNER node fed through the boundary climbs to the parent driver', () => {
    const bypassedInner = {
      ...sub,
      nodes: { p: { type: 'IProc', mode: 'bypassed' } as BNode },
    }
    const result = compile(input(docOf(
      {
        nodes: { a: { type: 'ISrc' }, s: { type: '#sub' }, k: { type: 'ISink' } },
        links: [[P('a', 'out'), P('s', 'img')], [P('s', 'out'), P('k', 'in')]],
      },
      { sub: bypassedInner },
    )))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'k'])
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['a', 0])
  })

  it('an inner consumer of a bypassed inner node resolves within the definition', () => {
    const subWithSink = {
      nodes: {
        p: { type: 'IProc', mode: 'bypassed' } as BNode,
        ik: { type: 'ISink' } as BNode,
      },
      links: [[P('p', 'out'), P('ik', 'in')]] as [End, End][],
      boundary: {
        inputs: [{ id: 'img', binds: { kind: 'port', node: 'p', port: 'in' } }],
        outputs: [],
      },
    }
    const result = compile(input(docOf(
      {
        nodes: { a: { type: 'ISrc' }, s: { type: '#sub' } },
        links: [[P('a', 'out'), P('s', 'img')]],
      },
      { sub: subWithSink },
    )))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['s.ik']!.inputs['in']).toEqual(['a', 0])
  })

  it('keeps NUL-containing occurrence paths distinct during structural routing', () => {
    const inner: BGraph = {
      nodes: { relay: { type: 'Batcher' } },
      boundary: { inputs: [{ id: 'feed', binds: { kind: 'family', node: 'relay', port: 'images' } }] },
    }
    const leftOuter: BGraph = {
      nodes: { leftSource: { type: 'ISrc' }, c: { type: '#inner', dynamic: { feed: { members: ['left'] } } } },
      links: [[P('leftSource', 'out'), P('c', 'feed.image', ['left'])]],
      boundary: { inputs: [], outputs: [] },
    }
    const rightOuter: BGraph = {
      nodes: { rightSource: { type: 'ISrc' }, 'b\u0000c': { type: '#inner', dynamic: { feed: { members: ['right'] } } } },
      links: [[P('rightSource', 'out'), P('b\u0000c', 'feed.image', ['right'])]],
      boundary: { inputs: [], outputs: [] },
    }
    const result = compile(input(docOf({
      nodes: {
        'a\u0000b': { type: '#leftOuter' },
        a: { type: '#rightOuter' },
      },
    }, { inner, leftOuter, rightOuter })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a%00b.c.relay']!.inputs['images.image0']).toEqual(['a%00b.leftSource', 0])
    expect(result.artifact.prompt['a.b%00c.relay']!.inputs['images.image0']).toEqual(['a.rightSource', 0])
    expect(codesOf(result.artifact.diagnostics)).not.toContain('compile.bypass.cycle')
  })

  it('keeps colliding NUL-containing definition and selector pairs distinct', () => {
    const nested: BGraph = {
      nodes: {
        first: { type: 'ISrc' }, second: { type: 'ISrc' },
        relay: { type: 'Wire15Relay', mode: 'bypassed' }, sink: { type: 'Wire15Sink' },
      },
      selectors: { y: { id: 'y', candidates: [{ id: 'first' }, { id: 'second' }], policy: { kind: 'random' } } },
      links: [
        [P('first', 'out'), { selector: 'y', candidate: 'first' }],
        [P('second', 'out'), { selector: 'y', candidate: 'second' }],
        [{ selector: 'y' }, P('relay', 'items.route')],
        [P('relay', 'out'), P('sink', 'items.result')],
      ],
      boundary: { inputs: [], outputs: [] },
    }
    const result = compile({
      ...input(docOf({
        nodes: { shell: { type: '#g0\u0000x' } },
        selectors: {
          'x\u0000y': {
            id: 'x\u0000y',
            candidates: [{ id: 'rootFirst' }, { id: 'rootSecond' }],
            policy: { kind: 'random' },
          },
        },
      }, { 'g0\u0000x': nested })),
      pickCandidate: () => 1,
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['shell.sink']!.inputs['items.result']).toEqual(['shell.second', 0])
    expect(result.artifact.choices).toEqual(expect.arrayContaining([
      expect.objectContaining({ graph: 'g0', selector: 'x\u0000y', candidate: 'rootSecond' }),
      expect.objectContaining({ graph: 'g0\u0000x', selector: 'y', candidate: 'second' }),
    ]))
  })
})

describe('bypass and execution scope', () => {
  it('partial scope closure follows the rewired passthrough edges', () => {
    const result = compile(input(
      docOf({
        nodes: {
          a: { type: 'ISrc' },
          p: { type: 'IProc', mode: 'bypassed' },
          k: { type: 'ISink' },
          unrelated: { type: 'ISrc' },
        },
        links: [[P('a', 'out'), P('p', 'in')], [P('p', 'out'), P('k', 'in')]],
      }),
      { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('k') }] },
    ))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'k'])
    expect(result.artifact.partialTargets).toEqual(['k'])
  })

  it('would-run closure traces bypass with the FINAL consumer type, matching real lowering', () => {
    // Cross's outL is LATENT at index 0, but the consumer wants IMAGE. Real
    // lowering and preview closure must both pick the img driver.
    const doc = docOf({
      nodes: {
        i: { type: 'ISrc' },
        l: { type: 'LSrc' },
        x: { type: 'Cross', mode: 'bypassed' },
        k: { type: 'ISink' },
      },
      links: [
        [P('i', 'out'), P('x', 'img')],
        [P('l', 'out'), P('x', 'lat')],
        [P('x', 'outL'), P('k', 'in')],
      ],
    })
    const scope: CompileInput['scope'] = { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('k') }] }
    const result = compile(input(doc, scope))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['k']!.inputs['in']).toEqual(['i', 0])
    const closure = scopeClosure(input(doc, scope))
    expect(closure).toBeDefined()
    expect(closure!.included.has('i')).toBe(true)
    // The immediate-output-type bug matched LATENT and pulled in the lat
    // driver, highlighting a producer the submission never runs.
    expect(closure!.included.has('l')).toBe(false)
  })
})

describe('wire-15 I1 dedicated proof matrix', () => {
  const recursiveTerminalDoc = (from: End, extra: Partial<BGraph> = {}) => docOf({
    ...extra,
    nodes: { relay: { type: 'Wire15NRelay', mode: 'bypassed' }, sink: { type: 'Wire15NSink' }, ...(extra.nodes ?? {}) },
    links: [...(extra.links ?? []), [from, P('relay', 'items.route')], [P('relay', 'out'), P('sink', 'items.result')]],
  })
  const recursiveTerminal = (from: End, extra: Partial<BGraph> = {}) =>
    compile(input(recursiveTerminalDoc(from, extra)))

  it('records child-owned selector reroute and value source under the child definition', () => {
    const child: BGraph = {
      nodes: { relay: { type: 'Wire15NRelay', mode: 'bypassed' } },
      reroutes: ['child-route'],
      valueSources: { literal: { id: 'literal', value: 41, spec: { widgetType: 'INT' } } },
      selectors: { pick: { id: 'pick', candidates: [{ id: 'chosen' }], policy: { kind: 'fixed', candidate: 'chosen' } } },
      links: [
        [{ valueSource: 'literal' }, { reroute: 'child-route' }],
        [{ reroute: 'child-route' }, { selector: 'pick', candidate: 'chosen' }],
        [{ selector: 'pick' }, P('relay', 'items.route')],
      ],
      boundary: { outputs: [{ id: 'out', binds: { kind: 'port', node: 'relay', port: 'out' } }] },
    }
    const doc = docOf({
      nodes: { shell: { type: '#child' }, sink: { type: 'Wire15NSink' } },
      links: [[P('shell', 'out'), P('sink', 'items.result')]],
    }, { child })
    const scope: CompileInput['scope'] = { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }] }
    const closure = scopeClosure(input(doc, scope))!
    expect([...closure.structural.keys()]).toEqual(['child'])
    expect([...closure.structural.get('child')!.reroutes]).toEqual(['child-route'])
    expect([...closure.structural.get('child')!.selectors.get('pick')!]).toEqual(['chosen'])
    expect([...closure.structural.get('child')!.valueSources]).toEqual(['literal'])
  })

  it('Real two-occurrence compile fixture: structurally identical sibling subgraph occurrences preserve materialized input order/index semantics and differ only in delivery membership', () => {
    const sub: BGraph = {
      nodes: { relay: { type: 'Wire15Relay', mode: 'bypassed' }, sink: { type: 'Wire15Sink' } },
      links: [[P('relay', 'out'), P('sink', 'items.result')]],
      boundary: { inputs: [
        { id: 'first', binds: { kind: 'port', node: 'relay', port: 'items.first' } },
        { id: 'second', binds: { kind: 'port', node: 'relay', port: 'items.second' } },
      ] },
    }
    const result = compile(input(docOf({
      nodes: {
        leftFirst: { type: 'ISrc' }, leftSecond: { type: 'ISrc' },
        rightFirst: { type: 'ISrc', mode: 'muted' }, rightSecond: { type: 'ISrc' },
        left: { type: '#sub' }, right: { type: '#sub' },
      },
      links: [
        [P('leftFirst', 'out'), P('left', 'first')], [P('leftSecond', 'out'), P('left', 'second')],
        [P('rightFirst', 'out'), P('right', 'first')], [P('rightSecond', 'out'), P('right', 'second')],
      ],
    }, { sub })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['left.sink']!.inputs['items.result']).toEqual(['leftFirst', 0])
    expect(result.artifact.prompt['right.sink']!.inputs['items.result']).toBeUndefined()
    const warning = result.artifact.diagnostics.find((d) => d.code === 'compile.bypass.structuralRouteDropped')
    expect(warning?.message).toContain("input 'items.first' at index 0")
    expect(warning?.message).not.toContain('items.second')
    expect(result.artifact.prompt['right.sink']!.inputs['items.second']).toBeUndefined()
  })

  it('Recursive wire15 successful multi-hop route preserves reroute, net fanout, relay, and destination semantics', () => {
    const result = compile(input(docOf({
      nodes: {
        source: { type: 'ISrc' },
        upstream: { type: 'Wire15Relay', mode: 'bypassed' },
        downstream: { type: 'Wire15Relay', mode: 'bypassed' },
        first: { type: 'Wire15Sink' }, second: { type: 'Wire15Sink' },
      },
      reroutes: ['route'],
      links: [
        [P('source', 'out'), { reroute: 'route' }],
        [{ reroute: 'route' }, P('upstream', 'items.route')],
        [P('upstream', 'out'), P('downstream', 'items.forwarded')],
      ],
      nets: [{ name: 'fanout', source: P('downstream', 'out'), sinks: [P('first', 'items.result'), P('second', 'items.result')] }],
    })))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.first!.inputs['items.result']).toEqual(['source', 0])
    expect(result.artifact.prompt.second!.inputs['items.result']).toEqual(['source', 0])
  })

  it('Recursive wire15 named-net fanout keeps every random selector branch in would-run closure', () => {
    const doc = docOf({
      nodes: {
        firstSource: { type: 'ISrc' }, secondSource: { type: 'ISrc' },
        relay: { type: 'Wire15Relay', mode: 'bypassed' },
        firstSink: { type: 'Wire15Sink' }, secondSink: { type: 'Wire15Sink' },
      },
      selectors: { choose: { id: 'choose', candidates: [{ id: 'first' }, { id: 'second' }], policy: { kind: 'random' } } },
      links: [
        [P('firstSource', 'out'), { selector: 'choose', candidate: 'first' }],
        [P('secondSource', 'out'), { selector: 'choose', candidate: 'second' }],
        [{ selector: 'choose' }, P('relay', 'items.route')],
      ],
      nets: [{ name: 'fanout', source: P('relay', 'out'), sinks: [P('firstSink', 'items.result'), P('secondSink', 'items.result')] }],
    })
    const scope: CompileInput['scope'] = { kind: 'partial', targets: [
      { instancePath: [], node: asNodeId('firstSink') },
      { instancePath: [], node: asNodeId('secondSink') },
    ] }
    const closure = scopeClosure(input(doc, scope))!
    expect([...closure.included].sort()).toEqual(['firstSink', 'firstSource', 'secondSink', 'secondSource'])
    expect([...closure.structural.get('g0')!.selectors.get('choose')!].sort()).toEqual(['first', 'second'])
  })

  it('Over-cap bypassed wire15 relay refuses before routing to its destination interface', () => {
    const result = compile(input(docOf({
      nodes: {
        dead0: { type: 'ISrc', mode: 'muted' }, dead1: { type: 'ISrc', mode: 'muted' },
        dead2: { type: 'ISrc', mode: 'muted' }, dead3: { type: 'ISrc', mode: 'muted' },
        live4: { type: 'ISrc' }, relay: { type: 'Wire15Relay', mode: 'bypassed' },
        sink: { type: 'Wire15Sink' },
      },
      links: [
        [P('dead0', 'out'), P('relay', 'items.m0')], [P('dead1', 'out'), P('relay', 'items.m1')],
        [P('dead2', 'out'), P('relay', 'items.m2')], [P('dead3', 'out'), P('relay', 'items.m3')],
        [P('live4', 'out'), P('relay', 'items.m4')], [P('relay', 'out'), P('sink', 'items.result')],
      ],
    })))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(codesOf(result.diagnostics)).toContain('elab.autogrow.overMax')
    expect(codesOf(result.diagnostics)).not.toContain('compile.bypass.structuralRouteDropped')
  })

  it('One dedicated recursive-wire15 route test for driven widget tap terminal', () => {
    const extra: Partial<BGraph> = {
      nodes: { source: { type: 'NSrc' }, widget: { type: 'NWidget' } },
      links: [[P('source', 'out'), P('widget', 'value')]],
    }
    const result = recursiveTerminal({ node: 'widget', tap: 'value' }, extra)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['sink']!.inputs['items.result']).toEqual(['source', 0])
    expect(scopeClosure(input(recursiveTerminalDoc({ node: 'widget', tap: 'value' }, extra)))?.included.has('source')).toBe(true)
  })

  it('One dedicated recursive-wire15 route test for undriven widget tap stored/default literal terminal', () => {
    const extra: Partial<BGraph> = { nodes: { widget: { type: 'NWidget', values: { value: 23 } } } }
    const result = recursiveTerminal({ node: 'widget', tap: 'value' }, extra)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['sink']!.inputs['items.result']).toBe(23)
    expect(scopeClosure(input(recursiveTerminalDoc({ node: 'widget', tap: 'value' }, extra)))).toBeDefined()
  })

  it('One dedicated recursive-wire15 route test for value source terminal', () => {
    const extra: Partial<BGraph> = { valueSources: { literal: { id: 'literal', value: 31, spec: { widgetType: 'INT' } } } }
    const result = recursiveTerminal({ valueSource: 'literal' }, extra)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['sink']!.inputs['items.result']).toBe(31)
    expect([...scopeClosure(input(recursiveTerminalDoc({ valueSource: 'literal' }, extra)))!.structural.get('g0')!.valueSources]).toEqual(['literal'])
  })

  it('One dedicated recursive-wire15 route test for fixed graph selector', () => {
    const result = recursiveTerminal({ selector: 'pick' }, {
      nodes: { source: { type: 'NSrc' } },
      selectors: { pick: { id: 'pick', candidates: [{ id: 'chosen' }], policy: { kind: 'fixed', candidate: 'chosen' } } },
      links: [[P('source', 'out'), { selector: 'pick', candidate: 'chosen' }]],
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['sink']!.inputs['items.result']).toEqual(['source', 0])
  })

  it('One dedicated recursive-wire15 route test for bypass cycle', () => {
    const result = compile(input(docOf({
      nodes: { a: { type: 'Wire15Relay', mode: 'bypassed' }, b: { type: 'Wire15Relay', mode: 'bypassed' }, sink: { type: 'Wire15Sink' } },
      links: [[P('a', 'out'), P('b', 'items.b')], [P('b', 'out'), P('a', 'items.a')], [P('a', 'out'), P('sink', 'items.result')]],
    })))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(codesOf(result.diagnostics)).toContain('compile.bypass.cycle')
  })

  it('Mixed IMAGE/LATENT boundary alsoBinds fanout through bypass routes each final destination by its own consumer type and would-run closure', () => {
    const sub: BGraph = {
      nodes: { imageSink: { type: 'ISink' }, latentSink: { type: 'LSink' } },
      boundary: { inputs: [{ id: 'feed', binds: { kind: 'port', node: 'imageSink', port: 'in' }, alsoBinds: [{ kind: 'port', node: 'latentSink', port: 'in' }] }], outputs: [] },
    }
    const doc = docOf({
      nodes: { image: { type: 'ISrc' }, latent: { type: 'LSrc' }, pass: { type: 'Cross', mode: 'bypassed' }, shell: { type: '#sub' } },
      links: [
        [P('image', 'out'), P('pass', 'img')],
        [P('latent', 'out'), P('pass', 'lat')],
        [P('pass', 'outL'), P('shell', 'feed')],
      ],
    }, { sub })
    const result = compile(input(doc))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.prompt['shell.imageSink']!.inputs.in).toEqual(['image', 0])
      expect(result.artifact.prompt['shell.latentSink']!.inputs.in).toEqual(['latent', 0])
    }
    const imageScope: CompileInput['scope'] = { kind: 'partial', targets: [{ instancePath: [asNodeId('shell')], node: asNodeId('imageSink') }] }
    const latentScope: CompileInput['scope'] = { kind: 'partial', targets: [{ instancePath: [asNodeId('shell')], node: asNodeId('latentSink') }] }
    expect([...scopeClosure(input(doc, imageScope))!.included].sort()).toEqual(['image', 'shell.imageSink'])
    expect([...scopeClosure(input(doc, latentScope))!.included].sort()).toEqual(['latent', 'shell.latentSink'])
  })

  it('Final consumer type survives every hop of a type-ambiguous bypass chain in exact and would-run', () => {
    const doc = docOf({
      nodes: {
        imageA: { type: 'ISrc' }, latentA: { type: 'LSrc' },
        imageB: { type: 'ISrc' }, first: { type: 'Cross', mode: 'bypassed' },
        second: { type: 'Cross', mode: 'bypassed' }, sink: { type: 'Wire15LatentSink' },
      },
      links: [
        [P('imageA', 'out'), P('first', 'img')], [P('latentA', 'out'), P('first', 'lat')],
        [P('imageB', 'out'), P('second', 'img')], [P('first', 'outL'), P('second', 'lat')],
        [P('second', 'outL'), P('sink', 'items.result')],
      ],
    })
    const exact = compile(input(doc))
    expect(exact.ok, JSON.stringify(!exact.ok && exact.diagnostics)).toBe(true)
    if (exact.ok) expect(exact.artifact.prompt.sink!.inputs['items.result']).toEqual(['latentA', 0])
    const scope: CompileInput['scope'] = { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }] }
    expect([...scopeClosure(input(doc, scope))!.included].sort()).toEqual(['latentA', 'sink'])
  })

  it('Explicit representative wire14 closure golden pins pre-I1 bypass/mute reroute selector and value-source behavior', () => {
    const doc = docOf({
      nodes: { live: { type: 'ISrc' }, muted: { type: 'ISrc', mode: 'muted' }, pass: { type: 'IProc', mode: 'bypassed' }, sink: { type: 'ISink' }, numberSink: { type: 'NSink' } },
      reroutes: ['r'],
      valueSources: { literal: { id: 'literal', value: 7, spec: { widgetType: 'INT' } } },
      selectors: { choose: { id: 'choose', candidates: [{ id: 'literal' }], policy: { kind: 'fixed', candidate: 'literal' } } },
      links: [
        [P('live', 'out'), { reroute: 'r' }],
        [{ reroute: 'r' }, P('pass', 'in')],
        [P('pass', 'out'), P('sink', 'in')],
        [{ valueSource: 'literal' }, { selector: 'choose', candidate: 'literal' }],
        [{ selector: 'choose' }, P('numberSink', 'in')],
      ],
    })
    const scope: CompileInput['scope'] = { kind: 'partial', targets: [
      { instancePath: [], node: asNodeId('sink') },
      { instancePath: [], node: asNodeId('numberSink') },
    ] }
    const closure = scopeClosure(input(doc, scope))!
    const exact = compile(input(doc))
    expect(exact.ok, JSON.stringify(!exact.ok && exact.diagnostics)).toBe(true)
    if (!exact.ok) return
    expect(JSON.stringify(exact.artifact.prompt)).toBe(JSON.stringify({
      live: { class_type: 'ISrc', inputs: {}, outputIds: ['out'] },
      sink: { class_type: 'ISink', inputs: { in: ['live', 0] }, outputIds: [] },
      numberSink: { class_type: 'NSink', inputs: { in: 7 }, outputIds: [] },
    }))
    expect([...closure.included].sort()).toEqual(['live', 'numberSink', 'sink'])
    expect([...closure.structural.get('g0')!.reroutes].sort()).toEqual(['r'])
    expect([...closure.structural.get('g0')!.selectors.entries()].map(([id, candidates]) =>
      [id, [...candidates].sort()])).toEqual([['choose', ['literal']]])
    expect([...closure.structural.get('g0')!.valueSources].sort()).toEqual(['literal'])
  })
})
