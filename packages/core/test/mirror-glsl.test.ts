/**
 * Glsl-mirror binding derivation: nodes declaring a glsl mirror get GPU
 * uniform bindings when every image input traces to a producer output and
 * every scalar input resolves to a client-resident value (stored widget
 * value, widget default, value-source literal, or widget tap). Any
 * unresolved input degrades to "no binding" - never an error.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GraphDef, ValueSourceData } from '../src/format/document.js'
import { asGraphDefId, asLinkId, asNodeId, asPortId, asValueSourceId } from '../src/ids.js'
import { deriveGlslMirrorBindings, supportsGlslMirror } from '../src/mirror/glsl.js'
import { parseDinksterNodes } from '../src/schema/dinkster-wire.js'
import { buildGraphConnectivity, elabInputsOf, elaborateInterface } from '../src/schema/elaborate.js'
import type { InputSpec, MirrorSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

/**
 * Vendored byte-for-byte from the backend repository
 * (tests/fixtures/mirror-parity/image_adjust_v1.json); the sha256 pins the
 * copy to the corpus both implementations must satisfy. Regenerate only from
 * the backend generator and update the pin in the same commit. The e2e
 * parity suite runs every case through a real WebGL2 context.
 */
const FIXTURE_SHA256 = 'e4d1352dd6b00bd415e67412dc51ec51083f307a2965a6c5af85ea2cd740b8af'

const fixtureBytes = readFileSync(new URL('./fixtures/image_adjust_v1.json', import.meta.url))

interface CorpusFrame {
  readonly shape: readonly [number, number, number, number]
  readonly values: readonly number[]
}

interface CorpusCase {
  readonly id: string
  readonly frame: string
  readonly inputs: Readonly<Record<string, unknown>>
  readonly expected: CorpusFrame
}

interface Corpus {
  readonly format_version: number
  readonly node_type: string
  readonly mirror_per_channel_tolerance: number
  readonly frames: Readonly<Record<string, CorpusFrame>>
  readonly cases: readonly CorpusCase[]
}

const corpus = JSON.parse(fixtureBytes.toString('utf8')) as Corpus

/**
 * Exact wire-29 serialization of the backend's dinkster.image.adjust schema
 * (dinkster_schema.wire.schema_to_wire at Dinkster main), including its declared
 * glsl mirror. Vendored so binding derivation and the e2e GPU parity suite
 * exercise the real shipped shader; regenerate from the backend serializer.
 */
const adjustWire = JSON.parse(
  readFileSync(new URL('./fixtures/image_adjust_wire29.json', import.meta.url), 'utf8'),
) as { mirror: { source: string; tolerance: { perChannel: number } } }

const adjustSchema = ((): NodeSchema => {
  const parsed = parseDinksterNodes({ schemaVersion: 29, nodes: { 'dinkster.image.adjust': adjustWire } })
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  const schema = parsed.schemas.get('dinkster.image.adjust')
  expect(schema).toBeDefined()
  return schema!
})()

/**
 * Vendored byte-for-byte from the backend repository
 * (tests/fixtures/mirror-parity/image_filter_v1.json), pinned by sha256 like
 * the adjust corpus above. The filter mirror is the first applies-scoped
 * mirror: it covers only gaussian_blur and sharpen out of the node's eleven
 * operations, so its corpus doubles as the gating fixture.
 */
const FILTER_FIXTURE_SHA256 = 'ee611b312fe8650a63301572c90936b1f38c9ddf3d947c47135cfb6bc08fc643'

const filterFixtureBytes = readFileSync(new URL('./fixtures/image_filter_v1.json', import.meta.url))

const filterCorpus = JSON.parse(filterFixtureBytes.toString('utf8')) as Corpus

/**
 * Exact wire-30 serialization of the backend's dinkster.image.filter schema
 * (dinkster_schema.wire.schema_to_wire at Dinkster main), including its scoped
 * glsl mirror. Vendored so binding derivation and the e2e GPU parity suite
 * exercise the real shipped shader; regenerate from the backend serializer.
 */
const filterWire = JSON.parse(
  readFileSync(new URL('./fixtures/image_filter_wire30.json', import.meta.url), 'utf8'),
) as { mirror: { source: string; tolerance: { perChannel: number }; applies: Record<string, readonly string[]> } }

const filterSchema = ((): NodeSchema => {
  const parsed = parseDinksterNodes({ schemaVersion: 30, nodes: { 'dinkster.image.filter': filterWire } })
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  const schema = parsed.schemas.get('dinkster.image.filter')
  expect(schema).toBeDefined()
  return schema!
})()

const output = (id: string, type: string): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: type },
})

/** Producer with one image output plus a float widget input (tap source). */
const imageSourceSchema: NodeSchema = {
  type: 'ImageSource',
  displayName: 'Image Source',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'level',
      type: { kind: 'concrete', name: 'core.float' },
      optional: false,
      widget: { widgetType: 'NUMBER', options: {}, default: 0.75 },
    },
    output('out', 'dinkster.image'),
    output('scalar', 'core.float'),
  ],
}

const GLSL_MIRROR: MirrorSpec = {
  kind: 'glsl',
  precision: 'bounded',
  tolerance: { perChannel: 1 / 255 },
  source: 'void main() {}',
}

/** Hand-built mirrored schema exercising int/bool/structured-combo inputs. */
const gateSchema = (mirror: MirrorSpec | null = GLSL_MIRROR): NodeSchema => ({
  type: 'test.gate',
  displayName: 'Gate',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  ...(mirror ? { mirror } : {}),
  items: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'dinkster.image' }, optional: false } as InputSpec,
    {
      kind: 'input',
      id: 'steps',
      type: { kind: 'concrete', name: 'core.int' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 4 },
    },
    {
      kind: 'input',
      id: 'enabled',
      type: { kind: 'concrete', name: 'core.boolean' },
      optional: false,
      widget: { widgetType: 'TOGGLE', options: {}, default: true },
    },
    {
      kind: 'input',
      id: 'mode',
      type: { kind: 'concrete', name: 'core.combo' },
      optional: false,
      widget: {
        widgetType: 'COMBO',
        options: { options: [{ value: 'soft', label: 'Soft' }, { value: 'hard', label: 'Hard' }] },
        default: 'soft',
      },
    },
    output('image', 'dinkster.image'),
  ],
})

const schemas = new Map<string, NodeSchema>([
  ['dinkster.image.adjust', adjustSchema],
  ['dinkster.image.filter', filterSchema],
  ['ImageSource', imageSourceSchema],
  ['test.gate', gateSchema()],
])
const resolve = (type: string): NodeSchema | undefined => schemas.get(type)

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const tap = (node: string, inputId: string) => ({ node: asNodeId(node), tap: asPortId(inputId) })
const vsrc = (id: string) => ({ valueSource: asValueSourceId(id) })
const source = (id: string, value: unknown): ValueSourceData =>
  ({ id: asValueSourceId(id), value }) as ValueSourceData
const link = (id: string, from: object, to: object) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]
const node = (id: string, type: string, values: Record<string, unknown> = {}) =>
  ({ id: asNodeId(id), type, values }) as GraphDef['nodes'][string]

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

const bindingOf = (def: GraphDef, nodeId = 'a1') => deriveGlslMirrorBindings(def, resolve).get(nodeId)

/** Adjust node fed by the producer's image output; values as given. */
const adjustGraph = (values: Record<string, unknown>, extra?: Partial<GraphDef>) =>
  graph({
    id: 'g0',
    nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust', values) },
    ...extra,
    links: {
      l1: link('l1', port('src', 'out'), port('a1', 'image')),
      ...extra?.links,
    },
  })

describe('image adjust parity corpus fixture', () => {
  it('is pinned byte-for-byte to the backend corpus', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(FIXTURE_SHA256)
  })

  it('matches the declared mirror contract and stays well-formed', () => {
    expect(corpus.format_version).toBe(1)
    expect(corpus.node_type).toBe('dinkster.image.adjust')
    expect(corpus.mirror_per_channel_tolerance).toBe(0.00392156862745098)
    expect(adjustSchema.mirror?.tolerance?.perChannel).toBe(corpus.mirror_per_channel_tolerance)
    expect(corpus.cases).toHaveLength(14)
    const operations = ['invert', 'normalize', 'brightness', 'contrast']
    const scalarIds = ['operation', 'factor', 'mean', 'standard_deviation']
    for (const frame of Object.values(corpus.frames)) {
      expect(frame.shape).toHaveLength(4)
      expect(frame.values).toHaveLength(frame.shape.reduce((a, b) => a * b, 1))
    }
    for (const testCase of corpus.cases) {
      expect(corpus.frames[testCase.frame]).toBeDefined()
      expect(operations).toContain(testCase.inputs['operation'])
      expect(Object.keys(testCase.inputs).every((key) => scalarIds.includes(key))).toBe(true)
      expect(testCase.expected.values).toHaveLength(testCase.expected.shape.reduce((a, b) => a * b, 1))
    }
  })
})

describe('supportsGlslMirror', () => {
  it('accepts only glsl mirrors carrying shader source', () => {
    expect(supportsGlslMirror(adjustSchema)).toBe(true)
    expect(supportsGlslMirror(gateSchema())).toBe(true)
    expect(supportsGlslMirror(gateSchema(null))).toBe(false)
    expect(supportsGlslMirror(gateSchema({ kind: 'glsl', precision: 'exact', source: '' }))).toBe(false)
    expect(supportsGlslMirror(gateSchema({
      kind: 'expression', precision: 'bounded', tolerance: { relative: 1e-12 }, grammarVersion: 1,
    }))).toBe(false)
  })
})

describe('deriveGlslMirrorBindings', () => {
  it('binds the wire-decoded adjust schema from stored widget values', () => {
    const def = adjustGraph({ operation: 'contrast', factor: 2.5 })
    expect(bindingOf(def)).toEqual({
      source: adjustSchema.mirror!.source,
      images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
      scalars: [
        { name: 'operation', glslType: 'int', value: 3 },
        { name: 'factor', glslType: 'float', value: 2.5 },
        { name: 'mean', glslType: 'float', value: 0.5 },
        { name: 'standard_deviation', glslType: 'float', value: 0.5 },
      ],
    })
  })

  it('falls back to declared widget defaults for unset scalars', () => {
    const binding = bindingOf(adjustGraph({}))
    expect(binding?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 2 },
      { name: 'factor', glslType: 'float', value: 1.0 },
      { name: 'mean', glslType: 'float', value: 0.5 },
      { name: 'standard_deviation', glslType: 'float', value: 0.5 },
    ])
  })

  it('resolves value-source literals driving a scalar input', () => {
    const def = adjustGraph({ operation: 'brightness' }, {
      valueSources: { v1: source('v1', 0.25) },
      links: { l2: link('l2', vsrc('v1'), port('a1', 'factor')) },
    })
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.25 })
  })

  it('resolves widget taps through stored values and widget defaults', () => {
    const def = adjustGraph({ operation: 'brightness' }, {
      links: { l2: link('l2', tap('src', 'level'), port('a1', 'factor')) },
    })
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.75 })
    ;(def.nodes['src']!.values as Record<string, unknown>)['level'] = 0.1
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.1 })
  })

  it('yields no binding when a scalar is driven by a producer output', () => {
    const def = adjustGraph({}, {
      links: { l2: link('l2', port('src', 'scalar'), port('a1', 'factor')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('binds an image input fed through a graph net', () => {
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust', {}) },
      nets: {
        n1: { id: 'n1', name: 'imagery', source: port('src', 'out'), sinks: [port('a1', 'image')] },
      } as unknown as GraphDef['nets'],
    })
    expect(bindingOf(def)?.images).toEqual([
      { name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } },
    ])
  })

  it('binds an image input fed through a reroute chain', () => {
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust', {}) },
      reroutes: { r1: { id: 'r1' } } as unknown as GraphDef['reroutes'],
      links: {
        l1: link('l1', port('src', 'out'), { reroute: 'r1' }),
        l2: link('l2', { reroute: 'r1' }, port('a1', 'image')),
      },
    })
    expect(bindingOf(def)?.images).toEqual([
      { name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } },
    ])
  })

  it('yields no binding when a scalar is fed through a graph net', () => {
    const def = adjustGraph({}, {
      nets: {
        n1: { id: 'n1', name: 'levels', source: port('src', 'scalar'), sinks: [port('a1', 'factor')] },
      } as unknown as GraphDef['nets'],
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding without a producer-driven image input', () => {
    const def = graph({
      id: 'g0',
      nodes: { a1: node('a1', 'dinkster.image.adjust', { operation: 'invert' }) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding when the image input is fed by a value source', () => {
    const def = graph({
      id: 'g0',
      nodes: { a1: node('a1', 'dinkster.image.adjust', {}) },
      valueSources: { v1: source('v1', 'not-an-image') },
      links: { l1: link('l1', vsrc('v1'), port('a1', 'image')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding for a combo value outside the declared options', () => {
    expect(bindingOf(adjustGraph({ operation: 'sharpen' }))).toBeUndefined()
  })

  it('yields no binding for non-finite or non-integer-int scalars', () => {
    for (const values of [{ steps: 1.5 }, { steps: Number.NaN }, { enabled: 'yes' }]) {
      const def = graph({
        id: 'g0',
        nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', values) },
        links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
      })
      expect(bindingOf(def)).toBeUndefined()
    }
  })

  it('binds int, bool, and structured combo options by value', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        src: node('src', 'ImageSource'),
        a1: node('a1', 'test.gate', { steps: 7, enabled: false, mode: 'hard' }),
      },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(bindingOf(def)?.scalars).toEqual([
      { name: 'steps', glslType: 'int', value: 7 },
      { name: 'enabled', glslType: 'bool', value: false },
      { name: 'mode', glslType: 'int', value: 1 },
    ])
  })

  it('binds only mirrored node types', () => {
    const bindings = deriveGlslMirrorBindings(adjustGraph({}), resolve)
    expect(bindings.has('a1')).toBe(true)
    expect(bindings.has('src')).toBe(false)
  })
})

describe('image filter parity corpus fixture', () => {
  it('is pinned byte-for-byte to the backend corpus', () => {
    expect(createHash('sha256').update(filterFixtureBytes).digest('hex')).toBe(FILTER_FIXTURE_SHA256)
  })

  it('matches the declared mirror contract and stays well-formed', () => {
    expect(filterCorpus.format_version).toBe(1)
    expect(filterCorpus.node_type).toBe('dinkster.image.filter')
    expect(filterCorpus.mirror_per_channel_tolerance).toBe(0.00392156862745098)
    expect(filterSchema.mirror?.tolerance?.perChannel).toBe(filterCorpus.mirror_per_channel_tolerance)
    expect(filterSchema.mirror?.applies).toEqual({ operation: ['gaussian_blur', 'sharpen'] })
    expect(filterCorpus.cases).toHaveLength(13)
    const covered = filterSchema.mirror!.applies!['operation']!
    const scalarIds = ['operation', 'radius', 'sigma', 'strength']
    for (const frame of Object.values(filterCorpus.frames)) {
      expect(frame.shape).toHaveLength(4)
      expect(frame.values).toHaveLength(frame.shape.reduce((a, b) => a * b, 1))
    }
    for (const testCase of filterCorpus.cases) {
      expect(filterCorpus.frames[testCase.frame]).toBeDefined()
      // Every corpus case exercises an operation inside the applies scope.
      expect(covered).toContain(testCase.inputs['operation'])
      expect(Object.keys(testCase.inputs).every((key) => scalarIds.includes(key))).toBe(true)
      expect(testCase.expected.values).toHaveLength(testCase.expected.shape.reduce((a, b) => a * b, 1))
    }
  })

  it('pins the applies scope as a prefix of the declared options', () => {
    // The shader's operation branches index the declared option order, so
    // the covered options must occupy the leading indices.
    const def = filterGraph('gaussian_blur')
    const connectivity = buildGraphConnectivity(def)
    const inputs = elabInputsOf(
      elaborateInterface(filterSchema, def.nodes['f1']!, connectivity(asNodeId('f1')), { promoteGhosts: false }),
    )
    const options = inputs.find((item) => item.spec.id === 'operation')?.spec.widget?.options['options']
    expect(Array.isArray(options)).toBe(true)
    const keys = (options as readonly unknown[]).map((option) =>
      typeof option === 'string' ? option : (option as { value?: unknown }).value)
    const covered = filterSchema.mirror!.applies!['operation']!
    expect(keys.slice(0, covered.length)).toEqual([...covered])
  })
})

/**
 * Filter node fed by the producer's image output. `operation` selects the
 * DynamicCombo branch via node dynamic state (the selector's value home);
 * `values` holds branch scalars under their dotted value keys
 * ('operation.radius').
 */
const filterGraph = (operation?: string, values: Record<string, unknown> = {}) =>
  graph({
    id: 'g0',
    nodes: {
      src: node('src', 'ImageSource'),
      f1: {
        ...node('f1', 'dinkster.image.filter', values),
        ...(operation !== undefined ? { dynamic: { operation: { selected: operation } } } : {}),
      } as GraphDef['nodes'][string],
    },
    links: { l1: link('l1', port('src', 'out'), port('f1', 'image')) },
  })

describe('applies-scoped binding derivation', () => {
  it('binds a covered operation from dynamic state and stored branch values', () => {
    const binding = deriveGlslMirrorBindings(
      filterGraph('gaussian_blur', { 'operation.radius': 2, 'operation.sigma': 1.5 }), resolve).get('f1')
    expect(binding).toEqual({
      source: filterSchema.mirror!.source,
      images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
      scalars: [
        { name: 'operation', glslType: 'int', value: 0 },
        { name: 'radius', glslType: 'int', value: 2 },
        { name: 'sigma', glslType: 'float', value: 1.5 },
      ],
    })
  })

  it('binds the second covered operation with its extra input', () => {
    const binding = deriveGlslMirrorBindings(filterGraph('sharpen'), resolve).get('f1')
    expect(binding?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 1 },
      { name: 'radius', glslType: 'int', value: 1 },
      { name: 'sigma', glslType: 'float', value: 1.0 },
      { name: 'strength', glslType: 'float', value: 1.0 },
    ])
  })

  it('binds the default operation when it is covered', () => {
    // Without dynamic state the default branch (gaussian_blur) materializes,
    // inside the scope.
    expect(deriveGlslMirrorBindings(filterGraph(), resolve).get('f1')).toBeDefined()
  })

  it.each(['noise', 'quantize', 'erode', 'dilate'])('yields no binding for uncovered operation %s', (operation) => {
    // Without the applies gate, noise would derive a binding (its strength
    // and seed inputs resolve fine) and the shader would run its sharpen
    // else-branch: a wrong estimate, not a missing one.
    expect(deriveGlslMirrorBindings(filterGraph(operation), resolve).get('f1')).toBeUndefined()
  })

  it('yields no binding when a scoped combo is not covered by a hand-built mirror', () => {
    const scoped = gateSchema({ ...GLSL_MIRROR, applies: { mode: ['soft'] } })
    const local = new Map(schemas)
    local.set('test.gate', scoped)
    const def = (values: Record<string, unknown>) => graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', values) },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(def({ mode: 'soft' }), (t) => local.get(t)).get('a1')).toBeDefined()
    expect(deriveGlslMirrorBindings(def({ mode: 'hard' }), (t) => local.get(t)).get('a1')).toBeUndefined()
  })

  it('yields no binding when an applies key never surfaces as a combo input', () => {
    const scoped = gateSchema({ ...GLSL_MIRROR, applies: { missing: ['soft'] } })
    const local = new Map(schemas)
    local.set('test.gate', scoped)
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', { mode: 'soft' }) },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(def, (t) => local.get(t)).get('a1')).toBeUndefined()
  })

  it('yields no binding when an applies key names a non-combo input', () => {
    const scoped = gateSchema({ ...GLSL_MIRROR, applies: { steps: ['4'] } })
    const local = new Map(schemas)
    local.set('test.gate', scoped)
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', {}) },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(def, (t) => local.get(t)).get('a1')).toBeUndefined()
  })
})
