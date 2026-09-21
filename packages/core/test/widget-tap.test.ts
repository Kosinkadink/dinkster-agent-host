import { describe, expect, it } from 'vitest'
import { companionSourcesOf } from '../src/companion.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile } from '../src/compile/compile.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { WORKFLOW_SCHEMA } from '../src/format/schema.js'
import { validateDocumentShape } from '../src/format/validate.js'
import { asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asRerouteId, asValueSourceId } from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'
import { buildRerouteIndex, traceEndpoint } from '../src/reroute.js'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'

const port = (node: string, id: string) => ({ node: asNodeId(node), port: asPortId(id) })
const tap = (node: string, id: string) => ({ node: asNodeId(node), tap: asPortId(id) })
const node = (id: string) => ({ id: asNodeId(id), type: 'Test', values: {} })
const graph = (links: GraphDef['links']): GraphDef => ({
  id: asGraphDefId('g0'), name: 'g', nodes: { a: node('a'), b: node('b'), c: node('c') },
  links, nets: {}, reroutes: {}, nextOrdinal: 10,
})
const doc = (g: GraphDef): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage'),
  root: asGraphDefId('g0'), graphs: { g0: g }, view: { graphs: {} },
})

describe('widget tap topology', () => {
  it('traces an undriven tap to its literal value terminal', () => {
    const g = graph({})
    expect(traceEndpoint(g, tap('a', 'value'))).toEqual({ kind: 'tapValue', node: 'a', input: 'value' })
  })

  it('aliases an input driver through reroutes to the real output', () => {
    const g: GraphDef = { ...graph({
      l1: { id: asLinkId('l1'), from: port('c', 'out'), to: { reroute: asRerouteId('r1') } },
      l2: { id: asLinkId('l2'), from: { reroute: asRerouteId('r1') }, to: port('a', 'value') },
    }), reroutes: { r1: { id: asRerouteId('r1') } } }
    expect(traceEndpoint(g, tap('a', 'value'), buildRerouteIndex(g))).toMatchObject({ kind: 'output', ref: port('c', 'out') })
  })

  it('reports persisted tap alias cycles', () => {
    const g = graph({
      l1: { id: asLinkId('l1'), from: tap('a', 'value'), to: port('b', 'value') },
      l2: { id: asLinkId('l2'), from: tap('b', 'value'), to: port('a', 'value') },
    })
    expect(traceEndpoint(g, tap('a', 'value'), buildRerouteIndex(g)).kind).toBe('tapCycle')
    expect(checkDocument(doc(g)).map((d) => d.code)).toContain('doc.tap.cycle')
  })

  it('rejects a persisted tap target', () => {
    const g = graph({ l1: { id: asLinkId('l1'), from: port('a', 'out'), to: tap('b', 'value') } })
    expect(checkDocument(doc(g)).map((d) => d.code)).toContain('doc.link.tapTarget')
  })
})

describe('widget tap commands', () => {
  const store = () => new DocumentStore(doc(graph({})), coreCommandRegistry())

  it('link.connect creates a tap-sourced link', () => {
    const s = store()
    const result = s.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: tap('a', 'value'), to: port('b', 'value') },
    })
    expect(result.ok).toBe(true)
    expect(Object.values(s.doc.graphs.g0!.links)[0]).toMatchObject({
      from: tap('a', 'value'), to: port('b', 'value'),
    })
  })

  it('link.connect rejects a tap target', () => {
    const result = store().dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('a', 'out'), to: tap('b', 'value') },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('link.tapTarget')
  })

  it('link.connect rejects a tap self-loop', () => {
    const result = store().dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: tap('a', 'value'), to: port('a', 'value') },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('link.selfLoop')
  })

  it('link.connect rejects an alias cycle', () => {
    const s = store()
    expect(s.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: tap('a', 'value'), to: port('b', 'value') },
    }).ok).toBe(true)
    const result = s.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: tap('b', 'value'), to: port('a', 'value') },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics[0]!.code).toBe('link.tapCycle')
      expect(result.diagnostics[0]!.message).toBe('link.connect: connection would create a widget tap cycle')
      expect(result.diagnostics[0]!.refs).toEqual([
        { graphId: 'g0', nodeId: 'b', portId: 'value', valueKey: 'value', direction: 'output' },
        { graphId: 'g0', nodeId: 'a', portId: 'value', direction: 'input' },
      ])
    }
  })
})

const objectInfo: Record<string, ObjectInfoEntry> = {
  ValueNode: {
    input: { required: { value: ['INT', { default: 17 }] } },
    output: ['INT'], output_name: ['out'], name: 'ValueNode', display_name: 'ValueNode', category: 'test',
  } as ObjectInfoEntry,
  NoDefaultNode: {
    input: { required: { value: ['INT', {}] } },
    output: ['INT'], output_name: ['out'], name: 'NoDefaultNode', display_name: 'NoDefaultNode', category: 'test',
  } as ObjectInfoEntry,
  // An empty COMBO has no intrinsic value (nothing to pick), so its tap is
  // genuinely valueless - unlike INT/STRING/BOOLEAN which always show one.
  NoIntrinsicNode: {
    input: { required: { value: [[], {}] } },
    output: ['COMBO'], output_name: ['out'], name: 'NoIntrinsicNode', display_name: 'NoIntrinsicNode', category: 'test',
  } as ObjectInfoEntry,
  // Optional widget inputs: an absent value is a legal prompt (the backend's
  // own default applies), so compile must NOT invent an intrinsic one.
  OptionalNoDefaultNode: {
    input: { optional: { value: ['INT', {}] } },
    output: ['INT'], output_name: ['out'], name: 'OptionalNoDefaultNode', display_name: 'OptionalNoDefaultNode', category: 'test',
  } as ObjectInfoEntry,
  OptionalWithDefaultNode: {
    input: { optional: { value: ['INT', { default: 7 }] } },
    output: ['INT'], output_name: ['out'], name: 'OptionalWithDefaultNode', display_name: 'OptionalWithDefaultNode', category: 'test',
  } as ObjectInfoEntry,
  // A PreviewAny-shaped sink: its input is wildcard-typed, so a plain baked
  // literal has no runtime type the server could wrap it with.
  WildcardSink: {
    input: { required: { source: ['*', {}] } },
    output: [], output_name: [], name: 'WildcardSink', display_name: 'WildcardSink', category: 'test',
  } as ObjectInfoEntry,
  MultiValueNode: {
    input: { required: { value: [['beta', 'alpha'], {
      multiselect: true, multi_select: {}, default: ['beta', 'alpha', 'beta'],
    }] } },
    output: [], output_name: [], name: 'MultiValueNode', display_name: 'MultiValueNode', category: 'test',
  } as ObjectInfoEntry,
}
const { schemas } = parseObjectInfo(objectInfo)
const compileDoc = (g: GraphDef, graphFeatures?: readonly string[]) => compile({
  document: doc(g), revision: 1, resolve: (type) => schemas.get(type), scope: { kind: 'full' },
  connection: asConnectionId('c0'), schemaHash: 'widget-tap-test',
  ...(graphFeatures ? { graphFeatures } : {}),
})
const compileGraph = (parts: {
  nodes?: GraphDef['nodes']
  links?: GraphDef['links']
  reroutes?: GraphDef['reroutes']
  valueSources?: GraphDef['valueSources']
}): GraphDef => ({
  id: asGraphDefId('g0'), name: 'g',
  nodes: parts.nodes ?? {}, links: parts.links ?? {}, nets: {}, reroutes: parts.reroutes ?? {}, nextOrdinal: 20,
  ...(parts.valueSources ? { valueSources: parts.valueSources } : {}),
})
const typedNode = (id: string, type = 'ValueNode', values: Record<string, Json> = {}, mode?: 'muted') => ({
  id: asNodeId(id), type, values, ...(mode ? { mode } : {}),
})
const link = (id: string, from: object, to: object) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]
/** One INT-widget value source 'vs' (the PrimitiveNode replacement). */
const intValueSources = (value = 7): GraphDef['valueSources'] => ({
  vs: { id: asValueSourceId('vs'), value, spec: { widgetType: 'INT' } },
})

describe('widget intrinsic defaults at compile (required inputs, not taps)', () => {
  it('lowers one ordered MULTI_COMBO array and preserves duplicates and OOV values', () => {
    const values = ['beta', 'outside-current-options', 'beta']
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'MultiValueNode', { value: values }) },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['a']!.inputs['value']).toEqual(values)
  })

  it('a required INT widget with no stored value and no schema default stages 0, never compile.input.missing', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'NoDefaultNode') },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.prompt['a']!.inputs['value']).toBe(0)
      expect(result.artifact.diagnostics.map((d) => d.code)).not.toContain('compile.input.missing')
    }
  })

  it('an OPTIONAL widget with no stored value and no schema default stays ABSENT from the prompt', () => {
    // Regression: the intrinsic fallback must never widen to optional inputs
    // - they were always omitted (backend default applies) and never warned.
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'OptionalNoDefaultNode') },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect('value' in result.artifact.prompt['a']!.inputs).toBe(false)
      expect(result.artifact.diagnostics.map((d) => d.code)).not.toContain('compile.input.missing')
    }
  })

  it('an OPTIONAL widget with a declared schema default still stages that default', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'OptionalWithDefaultNode') },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['a']!.inputs['value']).toBe(7)
  })

  it('a required widget with NO intrinsic value (empty COMBO) still warns compile.input.missing', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'NoIntrinsicNode') },
    }))
    if (result.ok) {
      expect(result.artifact.prompt['a']!.inputs['value']).toBeUndefined()
      const missing = result.artifact.diagnostics.find((d) => d.code === 'compile.input.missing')
      expect(missing?.severity).toBe('warning')
      expect(missing?.blocksExecution).toBe(true)
    } else {
      const missing = result.diagnostics.find((d) => d.code === 'compile.input.missing')
      expect(missing?.severity).toBe('warning')
      expect(missing?.blocksExecution).toBe(true)
    }
  })
})

describe('widget tap compile', () => {
  it('bakes a tapped stored value into the consumer prompt input', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'ValueNode', { value: 42 }), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['b']!.inputs['value']).toBe(42)
  })

  it('bakes the elaborated widget default when no value is stored', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['b']!.inputs['value']).toBe(17)
  })

  it('bakes the widget kind\'s intrinsic default when the schema declares none', () => {
    // An INT widget always shows a value (0 without a min); tapping it taps
    // that visible value - never a "no value" error.
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'NoDefaultNode'), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['b']!.inputs['value']).toBe(0)
  })

  it('reports compile.tap.novalue only for kinds with no intrinsic value', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'NoIntrinsicNode'), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('compile.tap.novalue')
  })

  // Capability-absent path: without graphFeatures 'typedLiteral', a tap
  // literal into a NON-CONCRETE input would only fail server-side as
  // runtime.validation - compile refuses it loudly instead. (With the
  // capability it lowers to $typed - see the '$typed lowering' suite.)
  it('reports compile.tap.nonConcreteTarget for an undriven tap into a wildcard input', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'ValueNode', { value: 42 }), w: typedNode('w', 'WildcardSink') },
      links: { l1: link('l1', tap('a', 'value'), port('w', 'source')) },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const d = result.diagnostics.find((x) => x.code === 'compile.tap.nonConcreteTarget')
      expect(d).toBeDefined()
      // Anchored to the DESTINATION input so the canvas can outline it.
      expect(d?.anchor?.port?.node).toBe('w')
      expect(d?.anchor?.port?.port).toBe('source')
    }
  })

  it('allows a DRIVEN tap into a wildcard input (lowers to an ordinary link)', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), c: typedNode('c'), w: typedNode('w', 'WildcardSink') },
      links: {
        l1: link('l1', port('c', 'out0'), port('a', 'value')),
        l2: link('l2', tap('a', 'value'), port('w', 'source')),
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['w']!.inputs['source']).toEqual(['c', 0])
  })

  it('reports compile.tap.nonConcreteTarget when a bypass fallback bakes into a wildcard input', () => {
    // a's tap drives bypassed b; the passthrough falls back to the tapped
    // literal, which must refuse into the wildcard sink exactly like the
    // direct tap lowering.
    const result = compileDoc(compileGraph({
      nodes: {
        a: typedNode('a', 'ValueNode', { value: 42 }),
        b: { ...typedNode('b'), mode: 'bypassed' } as GraphDef['nodes'][string],
        w: typedNode('w', 'WildcardSink'),
      },
      links: {
        l1: link('l1', tap('a', 'value'), port('b', 'value')),
        l2: link('l2', port('b', 'out0'), port('w', 'source')),
      },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('compile.tap.nonConcreteTarget')
  })

  it('reports compile.tap.missingInput for an unknown tapped input id', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'missing'), port('b', 'value')) },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('compile.tap.missingInput')
  })

  it('drops a tap from a muted node with compile.link.dropped', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'ValueNode', { value: 42 }, 'muted'), b: typedNode('b', 'NoDefaultNode') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.diagnostics.map((d) => d.code)).toContain('compile.link.dropped')
      // With the tap dropped, the input is unconnected - the consumer's own
      // widget value applies (INT intrinsic default 0), not the tapped 42.
      expect(result.artifact.prompt['b']!.inputs['value']).toBe(0)
    }
  })

  it('aliases a driven tap to the real upstream producer', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), b: typedNode('b'), c: typedNode('c') },
      links: {
        l1: link('l1', port('a', 'out0'), port('b', 'value')),
        l2: link('l2', tap('b', 'value'), port('c', 'value')),
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['c']!.inputs['value']).toEqual(['a', 0])
  })

  it('aliases a driven tap through a reroute to the real upstream producer', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), b: typedNode('b'), c: typedNode('c') },
      reroutes: { r1: { id: asRerouteId('r1') } },
      links: {
        l1: link('l1', port('a', 'out0'), { reroute: asRerouteId('r1') }),
        l2: link('l2', { reroute: asRerouteId('r1') }, port('b', 'value')),
        l3: link('l3', tap('b', 'value'), port('c', 'value')),
      },
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['c']!.inputs['value']).toEqual(['a', 0])
  })
})

// The typed-literal graph wire form (joint contract pinned 6382cf1, backend
// shipped ea6eca7): with graphFeatures 'typedLiteral', a tap literal into a
// NON-CONCRETE destination lowers to {$typed: {type, value}} stamping the
// TAPPED input's concrete runtime type. EMISSION RULE: only non-concrete
// destinations - concrete ones keep the canonical plain literal, so a
// pre-form server can never silently accept a stamp as a value.
describe('$typed lowering (graphFeatures typedLiteral)', () => {
  const TYPED = ['typedLiteral']

  it('stamps a MULTI_COMBO tap as list<core.combo> only for a non-concrete destination', () => {
    const values = ['beta', 'alpha', 'beta']
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'MultiValueNode', { value: values }), w: typedNode('w', 'WildcardSink') },
      links: { l1: link('l1', tap('a', 'value'), port('w', 'source')) },
    }), TYPED)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['w']!.inputs['source']).toEqual({
      $typed: { type: 'list<core.combo>', value: values },
    })

    const unsupported = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'MultiValueNode', { value: values }), w: typedNode('w', 'WildcardSink') },
      links: { l1: link('l1', tap('a', 'value'), port('w', 'source')) },
    }))
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.tap.nonConcreteTarget')
  })

  it('lowers an undriven tap into a wildcard input to a $typed marker', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'ValueNode', { value: 42 }), w: typedNode('w', 'WildcardSink') },
      links: { l1: link('l1', tap('a', 'value'), port('w', 'source')) },
    }), TYPED)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.prompt['w']!.inputs['source']).toEqual({ $typed: { type: 'INT', value: 42 } })
      expect(result.artifact.diagnostics.map((d) => d.code)).not.toContain('compile.tap.nonConcreteTarget')
    }
  })

  it('keeps the canonical plain literal on a CONCRETE destination (emission rule)', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a', 'ValueNode', { value: 42 }), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    }), TYPED)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['b']!.inputs['value']).toBe(42)
  })

  it('a DRIVEN tap into a wildcard input still lowers to an ordinary link, never $typed', () => {
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), c: typedNode('c'), w: typedNode('w', 'WildcardSink') },
      links: {
        l1: link('l1', port('c', 'out0'), port('a', 'value')),
        l2: link('l2', tap('a', 'value'), port('w', 'source')),
      },
    }), TYPED)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['w']!.inputs['source']).toEqual(['c', 0])
  })

  it('a bypass fallback baking a tap literal into a wildcard input emits $typed', () => {
    // Same topology as the capability-absent bypass test: a's tap drives
    // bypassed b; the passthrough falls back to the tapped literal, which
    // stamps exactly like the direct tap lowering.
    const result = compileDoc(compileGraph({
      nodes: {
        a: typedNode('a', 'ValueNode', { value: 42 }),
        b: { ...typedNode('b'), mode: 'bypassed' } as GraphDef['nodes'][string],
        w: typedNode('w', 'WildcardSink'),
      },
      links: {
        l1: link('l1', tap('a', 'value'), port('b', 'value')),
        l2: link('l2', port('b', 'out0'), port('w', 'source')),
      },
    }), TYPED)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['w']!.inputs['source']).toEqual({ $typed: { type: 'INT', value: 42 } })
  })

  it('a DIRECT value-source link into a wildcard input refuses even with the capability', () => {
    // The direct value-source branch must apply the same non-concrete guard
    // as the bypass path. The diagnostic reuses
    // compile.tap.nonConcreteTarget deliberately - it is
    // the established "literal into non-concrete input" refusal, anchored to
    // the destination, regardless of which literal path reached it.
    const result = compileDoc(compileGraph({
      nodes: { w: typedNode('w', 'WildcardSink') },
      valueSources: intValueSources(),
      links: { l1: link('l1', { valueSource: 'vs' }, port('w', 'source')) },
    }), TYPED)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const d = result.diagnostics.find((x) => x.code === 'compile.tap.nonConcreteTarget')
      expect(d).toBeDefined()
      expect(d?.anchor?.port?.node).toBe('w')
      expect(d?.anchor?.port?.port).toBe('source')
    }
  })

  it('a DIRECT value-source link into a wildcard input refuses without the capability too', () => {
    const result = compileDoc(compileGraph({
      nodes: { w: typedNode('w', 'WildcardSink') },
      valueSources: intValueSources(),
      links: { l1: link('l1', { valueSource: 'vs' }, port('w', 'source')) },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('compile.tap.nonConcreteTarget')
  })

  it('a tap DRIVEN BY a value source into a wildcard input refuses: the trace lands on the value source', () => {
    // tap(a.value) traces through its driver to the value source, so the
    // value-source branch handles it - same guard, no silent plain literal.
    const result = compileDoc(compileGraph({
      nodes: { a: typedNode('a'), w: typedNode('w', 'WildcardSink') },
      valueSources: intValueSources(),
      links: {
        l1: link('l1', { valueSource: 'vs' }, port('a', 'value')),
        l2: link('l2', tap('a', 'value'), port('w', 'source')),
      },
    }), TYPED)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('compile.tap.nonConcreteTarget')
  })

  it('a DIRECT value-source link into a CONCRETE input still bakes the plain literal', () => {
    const result = compileDoc(compileGraph({
      nodes: { b: typedNode('b') },
      valueSources: intValueSources(),
      links: { l1: link('l1', { valueSource: 'vs' }, port('b', 'value')) },
    }), TYPED)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['b']!.inputs['value']).toBe(7)
  })

  it('a value-source bake into a wildcard input still refuses: no runtime type to stamp, no guessing', () => {
    // DeclaredSpec carries a widget kind, not a runtime type - a value
    // source baked through a bypass into a non-concrete input has nothing
    // to stamp, so it keeps the loud compile error even with the capability.
    const result = compileDoc(compileGraph({
      nodes: {
        b: { ...typedNode('b'), mode: 'bypassed' } as GraphDef['nodes'][string],
        w: typedNode('w', 'WildcardSink'),
      },
      valueSources: intValueSources(),
      links: {
        l1: link('l1', { valueSource: 'vs' }, port('b', 'value')),
        l2: link('l2', port('b', 'out0'), port('w', 'source')),
      },
    }), TYPED)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toContain('compile.tap.nonConcreteTarget')
  })
})

describe('widget tap companion values', () => {
  it('resolves a literal tap with a stored value', () => {
    const g = compileGraph({
      nodes: { a: typedNode('a', 'ValueNode', { value: 42 }), b: typedNode('b') },
      links: { l1: link('l1', tap('a', 'value'), port('b', 'value')) },
    })
    expect(companionSourcesOf(g).get('b')?.get('value')).toEqual({ kind: 'literal', value: 42 })
  })

  it('resolves a driven tap to the real upstream producer', () => {
    const g = compileGraph({
      nodes: { a: typedNode('a'), b: typedNode('b'), c: typedNode('c') },
      links: {
        l1: link('l1', port('a', 'out0'), port('b', 'value')),
        l2: link('l2', tap('b', 'value'), port('c', 'value')),
      },
    })
    expect(companionSourcesOf(g).get('c')?.get('value')).toEqual({ kind: 'producer', node: 'a', output: 'out0' })
  })
})

describe('widget tap format', () => {
  it('JSON schema and runtime validation accept a tap source', async () => {
    const Ajv2020 = (await import('ajv/dist/2020.js')).default
    const validateSchema = new Ajv2020({ strict: false }).compile(WORKFLOW_SCHEMA)
    const sourceDoc = doc(graph({ l1: link('l1', tap('a', 'value'), port('b', 'value')) }))
    expect(validateSchema(sourceDoc)).toBe(true)
    expect(validateDocumentShape(sourceDoc)).toEqual([])

  })

  // WORKFLOW_SCHEMA splits linkSource/linkTarget so the tap-free target def
  // rejects tap targets exactly like the runtime validator.
  it('JSON schema and runtime validation reject a tap target', async () => {
    const Ajv2020 = (await import('ajv/dist/2020.js')).default
    const validateSchema = new Ajv2020({ strict: false }).compile(WORKFLOW_SCHEMA)
    const targetDoc = doc(graph({ l1: link('l1', port('a', 'out'), tap('b', 'value')) }))
    expect(validateSchema(targetDoc)).toBe(false)
    expect(validateDocumentShape(targetDoc).some((d) => d.message.includes('widget taps cannot be link targets'))).toBe(true)
  })
})
