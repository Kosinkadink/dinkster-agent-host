/**
 * Boundary -> NodeSchema derivation tests. The contract under test is the
 * architecture's core subgraph guarantee: a definition's boundary derives the
 * SAME NodeSchema model backend nodes get, with widget promotion, optionality
 * and type variables (dynamic types) flowing through unchanged.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { deriveBoundarySchema, resolveBoundaryRoute, type SchemaResolver } from '../src/schema/derive-boundary.js'
import { elaborateInterface } from '../src/schema/elaborate.js'
import { inputsOf, outputCountInputsOf, outputsOf, type NodeSchema } from '../src/schema/model.js'

/** Build a GraphDef from a plain literal (branded ids make literals noisy). */
const asDef = (d: unknown): GraphDef => d as GraphDef

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const subgraphDoc = (): WorkflowDocument =>
  JSON.parse(readFileSync(join(fixturesDir, 'subgraph.json'), 'utf8')) as WorkflowDocument

// Minimal hand-built inner schemas for the fixture's node types.
const innerSchemas: Record<string, NodeSchema> = {
  KSampler: {
    type: 'KSampler',
    displayName: 'KSampler',
    category: 'sampling',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'seed',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'core.int', options: { min: 0 }, default: 0, controller: 'after_generate' },
      },
      { kind: 'input', id: 'latent_image', displayName: 'Latent', type: { kind: 'concrete', name: 'LATENT' }, optional: false },
      { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'LATENT' } },
    ],
  },
  VAEDecode: {
    type: 'VAEDecode',
    displayName: 'VAE Decode',
    category: 'latent',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'samples', type: { kind: 'concrete', name: 'LATENT' }, optional: false },
      { kind: 'output', id: 'out0', displayName: 'IMAGE', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  ImpactSwitch: {
    type: 'ImpactSwitch',
    displayName: 'Switch',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'select',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'core.int', options: {} },
      },
      {
        kind: 'input',
        id: 'input',
        type: { kind: 'variable', templateId: 'T' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [
            {
              kind: 'input',
              id: 'input',
              type: { kind: 'variable', templateId: 'T' },
              optional: true,
            },
          ],
          naming: { kind: 'prefix', prefix: 'input' },
        },
      },
      { kind: 'output', id: 'out0', type: { kind: 'variable', templateId: 'T' } },
    ],
  },
  // Nested dynamics: autogrow 'items' whose template groups a widget slot
  // with a NESTED autogrow slot 'sub' (Autogrow-in-Autogrow).
  Stack: {
    type: 'Stack',
    displayName: 'Stack',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'items',
        type: { kind: 'variable', templateId: 'T' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [
            {
              kind: 'input',
              id: 'name',
              type: { kind: 'concrete', name: 'STRING' },
              optional: true,
              widget: { widgetType: 'core.string', options: {} },
            },
            {
              kind: 'input',
              id: 'sub',
              type: { kind: 'variable', templateId: 'T' },
              optional: true,
              dynamic: {
                kind: 'autogrow',
                template: [{ kind: 'input', id: 'w', type: { kind: 'variable', templateId: 'T' }, optional: true }],
                naming: { kind: 'prefix', prefix: 'sub', max: 4 },
              },
            },
          ],
          naming: { kind: 'prefix', prefix: 'item', min: 1, max: 5 },
        },
      },
      { kind: 'output', id: 'out0', type: { kind: 'variable', templateId: 'T' } },
    ],
  },
  NamedGrow: {
    type: 'NamedGrow',
    displayName: 'Named Grow',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'ins',
        type: { kind: 'concrete', name: 'IMAGE' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'ins', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'names', names: ['a', 'b', 'c'], min: 2 },
        },
      },
    ],
  },
  MultiOut: {
    type: 'MultiOut',
    displayName: 'Multi Out',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'src', type: { kind: 'variable', templateId: 'T' }, optional: false },
      {
        kind: 'output',
        id: 'outs',
        type: { kind: 'variable', templateId: 'T' },
        isList: true,
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'outs', type: { kind: 'variable', templateId: 'T' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'out', max: 6 },
        },
      },
    ],
  },
  CountOut: {
    type: 'CountOut',
    displayName: 'Count Out',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'count',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'core.int', options: {}, default: 0 },
      },
      {
        kind: 'output',
        id: 'images',
        type: { kind: 'concrete', name: 'IMAGE' },
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
          count: { input: 'count', suffix: 'index' },
        },
      },
      { kind: 'output', id: 'done', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  WideCountOut: {
    type: 'WideCountOut',
    displayName: 'Wide Count Out',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'count',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'core.int', options: {}, default: 0 },
      },
      {
        kind: 'output',
        id: 'images',
        type: { kind: 'concrete', name: 'IMAGE' },
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'image', min: 0, max: Number.MAX_SAFE_INTEGER },
          count: { input: 'count', suffix: 'index' },
        },
      },
      { kind: 'output', id: 'done', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  ComboNode: {
    type: 'ComboNode',
    displayName: 'Combo',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'mode',
        type: { kind: 'concrete', name: 'COMBO' },
        optional: false,
        dynamic: {
          kind: 'dynamicCombo',
          options: [
            { key: 'a', inputs: [{ kind: 'input', id: 'x', type: { kind: 'concrete', name: 'INT' }, optional: false }] },
          ],
        },
      },
    ],
  },
  PlainSlotNode: {
    type: 'PlainSlotNode', displayName: 'Plain slot', category: 'util', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: true,
      dynamic: { kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'MODEL' }, inputs: [] },
    }],
  },
  SpecializedSlotNode: {
    type: 'SpecializedSlotNode', displayName: 'Specialized slot', category: 'util', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: true,
      dynamic: {
        kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'MODEL' }, inputs: [],
        variants: [{
          key: 'special', type: { kind: 'variable', templateId: 'V' },
          inputs: [{ kind: 'input', id: 'strength', type: { kind: 'variable', templateId: 'V' }, optional: false }],
        }],
      },
    }],
  },
  MatchedSlotNode: {
    type: 'MatchedSlotNode', displayName: 'Matched slot', category: 'util', source: 'v3', isOutputNode: false,
    items: [
      {
        kind: 'input', id: 'source', type: { kind: 'union', names: ['IMAGE', 'MASK'] }, optional: false,
        dynamic: {
          kind: 'dynamicSlot', slotType: { kind: 'union', names: ['IMAGE', 'MASK'] }, inputs: [], typeTemplateId: 'T',
          variants: [
            {
              key: 'image', type: { kind: 'concrete', name: 'IMAGE' },
              inputs: [{ kind: 'input', id: 'copy', type: { kind: 'variable', templateId: 'T' }, optional: false }],
            },
            { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, inputs: [] },
          ],
        },
      },
      { kind: 'output', id: 'out', type: { kind: 'variable', templateId: 'T' } },
      { kind: 'output', id: 'batch', type: { kind: 'list', element: { kind: 'variable', templateId: 'T' } } },
    ],
  },
}

const resolve: SchemaResolver = (type) => innerSchemas[type]

describe('deriveBoundarySchema on the subgraph fixture', () => {
  const def = subgraphDoc().graphs['g1'] as GraphDef
  const { schema, diagnostics } = deriveBoundarySchema(def, resolve)

  it('derives without error diagnostics', () => {
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(schema).toBeDefined()
  })

  it('produces an ordinary NodeSchema for the instance type', () => {
    expect(schema!.type).toBe('#g1')
    expect(schema!.source).toBe('subgraph')
    expect(schema!.displayName).toBe('Sampler block')
  })

  it('derives a socket for connection-backed inner inputs', () => {
    const latent = inputsOf(schema!).find((i) => i.id === 'latent')!
    expect(latent.type).toEqual({ kind: 'concrete', name: 'LATENT' })
    expect(latent.optional).toBe(false)
    expect(latent.widget).toBeUndefined()
    expect(latent.displayName).toBe('Latent') // boundary displayName wins
  })

  it('promotes widgets onto the instance, controller included', () => {
    const seed = inputsOf(schema!).find((i) => i.id === 'seed')!
    expect(seed.widget).toBeDefined()
    expect(seed.widget!.widgetType).toBe('core.int')
    expect(seed.widget!.controller).toBe('after_generate')
    // Widget-backed => satisfiable without a connection.
    expect(seed.optional).toBe(true)
  })

  it('derives outputs with inner types', () => {
    const outs = outputsOf(schema!)
    expect(outs).toHaveLength(1)
    expect(outs[0]!.id).toBe('image')
    expect(outs[0]!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
  })

  it('derives a widget output from one exact static widget-backed input and fails closed otherwise', () => {
    const tapped = asDef({
      ...def,
      boundary: {
        inputs: [],
        outputs: [{ id: 'seedValue', binds: { kind: 'widgetTap', node: 'n0', tap: 'seed' } }],
      },
    })
    const valid = deriveBoundarySchema(tapped, (type) => innerSchemas[type])
    expect(outputsOf(valid.schema!)).toEqual([
      expect.objectContaining({ id: 'seedValue', type: { kind: 'concrete', name: 'INT' } }),
    ])
    expect(valid.diagnostics).toEqual([])

    const missing = asDef({
      ...tapped,
      boundary: {
        inputs: [],
        outputs: [{ id: 'missing', binds: { kind: 'widgetTap', node: 'n0', tap: 'unknown' } }],
      },
    })
    const invalid = deriveBoundarySchema(missing, (type) => innerSchemas[type])
    expect(invalid.schema).toBeUndefined()
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: 'boundary.tapMissing' }))

    const seed = innerSchemas.KSampler!.items[0]!
    const malformed = [
      {
        code: 'boundary.tapAmbiguous',
        tap: 'seed',
        schema: { ...innerSchemas.KSampler!, items: [...innerSchemas.KSampler!.items, seed] },
      },
      {
        code: 'boundary.tapUnsupported',
        tap: 'latent_image',
        schema: innerSchemas.KSampler!,
      },
      {
        code: 'boundary.tapUnsupported',
        tap: 'seed',
        schema: {
          ...innerSchemas.KSampler!,
          items: [{
            ...seed,
            dynamic: {
              kind: 'autogrow',
              template: [seed],
              naming: { kind: 'prefix', prefix: 'seed' },
            },
          }],
        },
      },
    ] as const
    for (const { code, tap, schema: malformedSchema } of malformed) {
      const malformedDef = asDef({
        ...tapped,
        boundary: {
          inputs: [],
          outputs: [{ id: 'invalid', binds: { kind: 'widgetTap', node: 'n0', tap } }],
        },
      })
      const result = deriveBoundarySchema(malformedDef, () => malformedSchema as NodeSchema)
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }))
    }
  })

  it('is not an output node when no inner node is one', () => {
    expect(schema!.isOutputNode).toBe(false)
  })

  it('omits emitsPreviews when no inner node declares it', () => {
    expect(schema!.emitsPreviews).toBeUndefined()
  })

  it('aggregates emitsPreviews from any inner node, nested instances included', () => {
    const flagged: SchemaResolver = (type) =>
      type === 'KSampler' ? { ...innerSchemas['KSampler']!, emitsPreviews: true } : innerSchemas[type]
    const direct = deriveBoundarySchema(def, flagged)
    expect(direct.schema!.emitsPreviews).toBe(true)

    // A nested instance whose derived schema carries the flag propagates it.
    const outer = asDef({
      id: 'g2',
      name: 'outer',
      nodes: { inst: { id: 'inst', type: '#g1', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: { inputs: [], outputs: [] },
    })
    const nested = deriveBoundarySchema(outer, (type) => type === '#g1' ? direct.schema : flagged(type))
    expect(nested.schema!.emitsPreviews).toBe(true)
    expect(deriveBoundarySchema(outer, (type) => type === '#g1' ? schema : resolve(type)).schema!.emitsPreviews)
      .toBeUndefined()
  })
})

describe('widget promotion vs socket-only', () => {
  const def = (promoted: boolean): GraphDef => asDef({
    id: 'gX',
    name: 'x',
    nodes: {
      n0: { id: 'n0', type: 'KSampler', values: { seed: 5 } },
    },
    links: {},
    nets: {},
    boundary: {
      inputs: [{ id: 'seed', binds: { kind: 'port', node: 'n0', port: 'seed' }, ...(promoted ? { promoted: true } : {}) } as never],
      outputs: [],
    },
    nextOrdinal: 1,
  })

  it('non-promoted widget-backed inputs become forced sockets, still optional', () => {
    const { schema } = deriveBoundarySchema(def(false), resolve)
    const seed = inputsOf(schema!)[0]!
    expect(seed.widget).toBeUndefined()
    expect(seed.forceInput).toBe(true)
    expect(seed.optional).toBe(true) // inner stored value applies when unconnected
  })

  it('promoted widget-backed inputs carry the WidgetSpec', () => {
    const { schema } = deriveBoundarySchema(def(true), resolve)
    const seed = inputsOf(schema!)[0]!
    expect(seed.widget).toBeDefined()
    expect(seed.forceInput).toBeUndefined()
  })
})

describe('type variables cross the boundary', () => {
  const def: GraphDef = asDef({
    id: 'gT',
    name: 'generic',
    nodes: {
      n0: { id: 'n0', type: 'ImpactSwitch', values: { select: 1 } },
      n1: { id: 'n1', type: 'ImpactSwitch', values: { select: 1 } },
    },
    links: {},
    nets: {},
    boundary: {
      // Family members bind via the stamped slot path ('<family>.<slotId>')
      // plus the member id - the derived port carries the template slot.
      inputs: [
        { id: 'a', binds: { kind: 'port', node: 'n0', port: 'input.input', members: ['m0'] } },
        { id: 'b', binds: { kind: 'port', node: 'n1', port: 'input.input', members: ['m0'] } },
      ],
      outputs: [
        { id: 'outA', binds: { kind: 'port', node: 'n0', port: 'out0' } },
        { id: 'outB', binds: { kind: 'port', node: 'n1', port: 'out0' } },
      ],
    },
    nextOrdinal: 2,
  })
  const { schema, diagnostics } = deriveBoundarySchema(def, resolve)

  it('derives cleanly', () => {
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('keeps one inner node\'s template shared between its boundary ports', () => {
    const a = inputsOf(schema!).find((i) => i.id === 'a')!
    const outA = outputsOf(schema!).find((o) => o.id === 'outA')!
    expect(a.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(outA.type).toEqual(a.type) // solving outA's type solves a's
  })

  it('keeps unrelated inner templates distinct', () => {
    const a = inputsOf(schema!).find((i) => i.id === 'a')!
    const b = inputsOf(schema!).find((i) => i.id === 'b')!
    expect(a.type).not.toEqual(b.type)
    expect(b.type).toEqual({ kind: 'variable', templateId: 'n1:T' })
  })
})

describe('whole-family forwarding derives boundary autogrow families', () => {
  const defWith = (
    nodes: Record<string, unknown>,
    inputs: readonly unknown[],
    outputs: readonly unknown[] = [],
  ): GraphDef =>
    asDef({
      id: 'gW',
      name: 'fwd',
      nodes,
      links: {},
      nets: {},
      boundary: { inputs, outputs },
      nextOrdinal: 1,
    })

  const inputItem = (schema: NodeSchema, id: string) => inputsOf(schema).find((i) => i.id === id)!
  const outputItem = (schema: NodeSchema, id: string) => outputsOf(schema).find((o) => o.id === id)!

  it('forwards a top-level input family with a recursively freshened template', () => {
    const def = defWith({ n0: { id: 'n0', type: 'ImpactSwitch', values: {} } }, [
      { id: 'pics', binds: { kind: 'family', node: 'n0', port: 'input' } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const pics = inputItem(schema!, 'pics')
    // The declaring slot's type variable is namespaced by inner node id, so
    // the boundary family shares dynamic typing with the inner one.
    expect(pics.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(pics.dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'input', max: 10 },
    })
    expect(pics.dynamic).not.toHaveProperty('ordinalOffset')
    const spec = pics.dynamic as Extract<NonNullable<typeof pics.dynamic>, { kind: 'autogrow' }>
    expect(spec.template).toHaveLength(1)
    expect(spec.template[0]!.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
  })

  it('definition prefix members reduce capacity and set the ordinal offset', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'ImpactSwitch', values: {}, dynamic: { input: { members: ['m0', 'm1'] } } } },
      [{ id: 'pics', binds: { kind: 'family', node: 'n0', port: 'input' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'pics').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'input', max: 8 },
      ordinalOffset: 2,
    })
  })

  it('definition prefix satisfies the family minimum for instances', () => {
    // Stack 'items' has min 1: with no prefix the derived family keeps
    // min 1; one definition-local member satisfies it, so instances owe 0.
    const bare = defWith({ n0: { id: 'n0', type: 'Stack', values: {} } }, [
      { id: 'stack', binds: { kind: 'family', node: 'n0', port: 'items' } },
    ])
    const bareSchema = deriveBoundarySchema(bare, resolve).schema!
    expect(inputItem(bareSchema, 'stack').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'item', min: 1, max: 5 },
    })

    const seeded = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'] } } } },
      [{ id: 'stack', binds: { kind: 'family', node: 'n0', port: 'items' } }],
    )
    const seededSchema = deriveBoundarySchema(seeded, resolve).schema!
    const seededSpec = inputItem(seededSchema, 'stack').dynamic
    expect(seededSpec).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', max: 4 }, ordinalOffset: 1 })
    expect((seededSpec as Extract<NonNullable<typeof seededSpec>, { kind: 'autogrow' }>).naming).not.toHaveProperty('min')
  })

  it('names-list forwarding slices the remaining names', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'NamedGrow', values: {}, dynamic: { ins: { members: ['m0'] } } } },
      [{ id: 'more', binds: { kind: 'family', node: 'n0', port: 'ins' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'more').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'names', names: ['b', 'c'], min: 1 },
      ordinalOffset: 1,
    })
  })

  it('a prefix equal to the cap is legal: instances see an empty family', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'NamedGrow', values: {}, dynamic: { ins: { members: ['m0', 'm1', 'm2'] } } } },
      [{ id: 'more', binds: { kind: 'family', node: 'n0', port: 'ins' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const spec = inputItem(schema!, 'more').dynamic
    expect(spec).toMatchObject({ kind: 'autogrow', naming: { kind: 'names', names: [] }, ordinalOffset: 3 })
    expect((spec as Extract<NonNullable<typeof spec>, { kind: 'autogrow' }>).naming).not.toHaveProperty('min')
  })

  it('forwards an output family, carrying isList from the top-level item', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'MultiOut', values: {} } },
      [{ id: 'src', binds: { kind: 'port', node: 'n0', port: 'src' } }],
      [{ id: 'outs', binds: { kind: 'family', node: 'n0', port: 'outs' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const outs = outputItem(schema!, 'outs')
    expect(outs.isList).toBe(true)
    expect(outs.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(outs.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'out', max: 6 } })
    // Both boundary items bind n0, so its 'T' stays shared across them.
    expect(inputItem(schema!, 'src').type).toEqual({ kind: 'variable', templateId: 'n0:T' })
  })

  it('projects a count-bound output family with a fixed definition count', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'CountOut', values: { count: 3 } } },
      [],
      [{ id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const pictures = outputItem(schema!, 'pictures')
    expect(pictures.dynamic).toMatchObject({
      kind: 'autogrow',
      count: {
        input: 'count',
        suffix: 'index',
        boundaryProjection: { fallback: 3, fixed: true },
      },
    })
    expect(outputCountInputsOf(schema!)).toEqual([])
    expect(elaborateInterface(schema!, { values: {} }).outputMembers).toEqual({ pictures: ['0', '1', '2'] })
  })

  it.each(['link', 'net'] as const)('omits a count-bound output whose definition count has an internal %s', (connection) => {
    const base = defWith(
      {
        n0: { id: 'n0', type: 'CountOut', values: { count: 2 } },
        source: { id: 'source', type: 'CountOut', values: { count: 1 } },
      },
      [],
      [
        { id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } },
        { id: 'done', binds: { kind: 'port', node: 'n0', port: 'done' } },
      ],
    )
    const countSink = { node: 'n0', port: 'count' }
    const countSource = { node: 'source', port: 'done' }
    const def = asDef({
      ...base,
      links: connection === 'link'
        ? { count: { id: 'count', from: countSource, to: countSink } }
        : {},
      nets: connection === 'net'
        ? { count: { id: 'count', name: 'count', source: countSource, sinks: [countSink] } }
        : {},
    })

    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(schema).toBeDefined()
    expect(outputsOf(schema!).map((item) => item.id)).toEqual(['done'])
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'boundary.countBoundOutputInvalid',
      severity: 'warning',
      message: expect.stringContaining("count input 'count' is linked"),
    }))
  })

  it('projects a promoted output count as occurrence-local instance state', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'CountOut', values: { count: 3 } } },
      [{ id: 'amount', binds: { kind: 'port', node: 'n0', port: 'count' }, promoted: true }],
      [{ id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(outputItem(schema!, 'pictures').dynamic).toMatchObject({
      count: {
        input: 'amount',
        suffix: 'index',
        boundaryProjection: { fallback: 3 },
      },
    })
    expect(outputCountInputsOf(schema!)).toEqual(['amount'])
    expect(elaborateInterface(schema!, { values: { amount: 2 } }).outputMembers).toEqual({ pictures: ['0', '1'] })
    expect(elaborateInterface(schema!, { values: {} }).outputMembers).toEqual({ pictures: ['0', '1', '2'] })
    const invalid = elaborateInterface(schema!, { values: { amount: null } })
    expect(invalid.outputMembers).toBeUndefined()
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: 'elab.outputFamily.badCount' }))
  })

  it('omits only a count-bound output whose definition count is invalid', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'CountOut', values: {} } },
      [],
      [
        { id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } },
        { id: 'done', binds: { kind: 'port', node: 'n0', port: 'done' } },
      ],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(schema).toBeDefined()
    expect(outputsOf(schema!).map((item) => item.id)).toEqual(['done'])
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'boundary.countBoundOutputInvalid',
      severity: 'warning',
    }))
  })

  it('omits a fixed count above the shared elaboration budget', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'WideCountOut', values: { count: Number.MAX_SAFE_INTEGER } } },
      [],
      [
        { id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } },
        { id: 'done', binds: { kind: 'port', node: 'n0', port: 'done' } },
      ],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(schema).toBeDefined()
    expect(outputsOf(schema!).map((item) => item.id)).toEqual(['done'])
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'boundary.countBoundOutputInvalid',
      severity: 'warning',
      message: expect.stringContaining('0..512'),
    }))
  })

  it('keeps a promoted count family usable when only its definition fallback is invalid', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'CountOut', values: { count: 9 } } },
      [{ id: 'amount', binds: { kind: 'port', node: 'n0', port: 'count' }, promoted: true }],
      [{ id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(schema).toBeDefined()
    expect(outputItem(schema!, 'pictures')).toBeDefined()
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'boundary.countBoundOutputInvalid',
      severity: 'warning',
    }))
    expect(elaborateInterface(schema!, { values: { amount: 2 } }).outputMembers).toEqual({ pictures: ['0', '1'] })
  })

  it('forwards a nested family through an enclosing concrete member path', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'] } } } },
      [{ id: 'subs', binds: { kind: 'family', node: 'n0', port: 'items.sub', members: ['m0'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const subs = inputItem(schema!, 'subs')
    expect(subs.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'sub', max: 4 } })
    expect(subs.dynamic).not.toHaveProperty('ordinalOffset')
    const spec = subs.dynamic as Extract<NonNullable<typeof subs.dynamic>, { kind: 'autogrow' }>
    expect(spec.template[0]!.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
  })

  it('nested definition prefix state scopes to the crossed member (hazard N4)', () => {
    // Member m0 holds one 'sub' member; sibling m1 holds two. Forwarding
    // m0's family must see prefix 1, never m1's state.
    const def = defWith(
      {
        n0: {
          id: 'n0',
          type: 'Stack',
          values: {},
          dynamic: {
            items: {
              members: ['m0', 'm1'],
              memberState: {
                m0: { 'items.sub': { members: ['s0'] } },
                m1: { 'items.sub': { members: ['x0', 'x1'] } },
              },
            },
          },
        },
      },
      [{ id: 'subs', binds: { kind: 'family', node: 'n0', port: 'items.sub', members: ['m0'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'subs').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'sub', max: 3 },
      ordinalOffset: 1,
    })
  })

  it('two sibling members forward their nested families independently', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0', 'm1'] } } } },
      [
        { id: 'subsA', binds: { kind: 'family', node: 'n0', port: 'items.sub', members: ['m0'] } },
        { id: 'subsB', binds: { kind: 'family', node: 'n0', port: 'items.sub', members: ['m1'] } },
      ],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'subsA').dynamic).toMatchObject({ kind: 'autogrow' })
    expect(inputItem(schema!, 'subsB').dynamic).toMatchObject({ kind: 'autogrow' })
  })

  it('concrete nested member binding (depth 2) derives a plain port', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'], memberState: { m0: { 'items.sub': { members: ['s0'] } } } } } } },
      [{ id: 'w', binds: { kind: 'port', node: 'n0', port: 'items.sub.w', members: ['m0', 's0'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const w = inputItem(schema!, 'w')
    expect(w.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(w.dynamic).toBeUndefined()
  })

  it('widget promotion works on a nested member slot', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'] } } } },
      [{ id: 'label', binds: { kind: 'port', node: 'n0', port: 'items.name', members: ['m0'] }, promoted: true }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const label = inputItem(schema!, 'label')
    expect(label.widget).toEqual({ widgetType: 'core.string', options: {} })
    expect(label.optional).toBe(true)
  })

  // Chained forwarding: forwarding an ALREADY-DERIVED '#def' schema whose
  // family carries a sliced names list / ordinalOffset must compose - offset
  // additive, names re-sliced, bounds re-reduced. Load-bearing for nested
  // subgraphs (hazard F4).
  it('chained prefix-naming forwarding accumulates offset and re-reduces capacity', () => {
    const inner = defWith(
      { n0: { id: 'n0', type: 'ImpactSwitch', values: {}, dynamic: { input: { members: ['m0', 'm1'] } } } },
      [{ id: 'more', binds: { kind: 'family', node: 'n0', port: 'input' } }],
    )
    const innerSchema = deriveBoundarySchema(inner, resolve).schema!
    const resolveChained: SchemaResolver = (t) => (t === '#gW' ? innerSchema : innerSchemas[t])
    // The middle instance appends 3 suffix members of its own before
    // forwarding the family a second time.
    const outer = asDef({
      id: 'gO',
      name: 'outer',
      nodes: { s0: { id: 's0', type: '#gW', values: {}, dynamic: { more: { members: ['k0', 'k1', 'k2'] } } } },
      links: {},
      nets: {},
      boundary: { inputs: [{ id: 'rest', binds: { kind: 'family', node: 's0', port: 'more' } }], outputs: [] },
      nextOrdinal: 1,
    })
    const { schema, diagnostics } = deriveBoundarySchema(outer, resolveChained)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'rest').dynamic).toMatchObject({
      kind: 'autogrow',
      // Inner derive: max 10-2=8, offset 2. Outer derive: max 8-3=5, offset 2+3=5.
      naming: { kind: 'prefix', prefix: 'input', max: 5 },
      ordinalOffset: 5,
    })
  })

  it('chained names-list forwarding re-slices names and re-reduces min', () => {
    const inner = defWith(
      { n0: { id: 'n0', type: 'NamedGrow', values: {}, dynamic: { ins: { members: ['m0'] } } } },
      [{ id: 'more', binds: { kind: 'family', node: 'n0', port: 'ins' } }],
    )
    const innerSchema = deriveBoundarySchema(inner, resolve).schema!
    // Inner derive: names ['b','c'], min 1, offset 1.
    const resolveChained: SchemaResolver = (t) => (t === '#gW' ? innerSchema : innerSchemas[t])
    const outer = asDef({
      id: 'gO',
      name: 'outer',
      nodes: { s0: { id: 's0', type: '#gW', values: {}, dynamic: { more: { members: ['k0'] } } } },
      links: {},
      nets: {},
      boundary: { inputs: [{ id: 'rest', binds: { kind: 'family', node: 's0', port: 'more' } }], outputs: [] },
      nextOrdinal: 1,
    })
    const { schema, diagnostics } = deriveBoundarySchema(outer, resolveChained)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const spec = inputItem(schema!, 'rest').dynamic
    // Outer derive: names ['c'] (re-sliced), min max(0,1-1)=0 (omitted), offset 1+1=2.
    expect(spec).toMatchObject({ kind: 'autogrow', naming: { kind: 'names', names: ['c'] }, ordinalOffset: 2 })
    expect((spec as Extract<NonNullable<typeof spec>, { kind: 'autogrow' }>).naming).not.toHaveProperty('min')
  })
})

describe('boundary structural identity and presentation', () => {
  it('resolves same-id input and output ports by the boundary side', () => {
    const schema: NodeSchema = {
      type: 'dinkster.float',
      displayName: 'Float',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'value',
          type: { kind: 'concrete', name: 'core.float' },
          optional: false,
          widget: { widgetType: 'NUMBER', options: { step: 0.1 }, default: 0 },
        },
        { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'core.float' } },
      ],
    }
    const binding = { kind: 'port' as const, node: 'n0' as never, port: 'value' as never }
    const def = asDef({
      id: 'gSameId',
      name: 'same id',
      nodes: { n0: { id: 'n0', type: schema.type, values: {} } },
      links: {},
      nets: {},
      boundary: {
        inputs: [{ id: 'in', binds: binding }],
        outputs: [{ id: 'out', binds: binding }],
      },
      nextOrdinal: 1,
    })

    const result = deriveBoundarySchema(def, (type) => type === schema.type ? schema : undefined)

    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)).toEqual([expect.objectContaining({ id: 'in', kind: 'input' })])
    expect(outputsOf(result.schema!)).toEqual([expect.objectContaining({ id: 'out', kind: 'output' })])
  })

  it('prefers only cross-side matches and preserves within-side ambiguity', () => {
    const schema: NodeSchema = {
      type: 'MixedCollision',
      displayName: 'Mixed Collision',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.float' }, optional: true },
        { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.float' }, optional: true },
        { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'core.float' } },
      ],
    }
    const binding = { kind: 'port' as const, node: 'n0' as never, port: 'value' as never }

    expect(resolveBoundaryRoute(schema, binding)).toEqual(expect.objectContaining({
      ok: false,
      code: 'boundary.ambiguousBind',
      message: expect.stringContaining('matches 3 structural targets'),
    }))
    expect(resolveBoundaryRoute(schema, binding, 'input')).toEqual(expect.objectContaining({
      ok: false,
      code: 'boundary.ambiguousBind',
      message: expect.stringContaining('matches 2 structural targets'),
    }))
    expect(resolveBoundaryRoute(schema, binding, 'output')).toEqual(expect.objectContaining({
      ok: true,
      route: expect.objectContaining({ side: 'output' }),
    }))
  })

  it('keeps the existing side-mismatch diagnostic when only the wrong side matches', () => {
    const outputOnly: NodeSchema = {
      type: 'OutputOnly',
      displayName: 'Output Only',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{ kind: 'output', id: 'value', type: { kind: 'concrete', name: 'FLOAT' } }],
    }
    const def = asDef({
      id: 'gWrongSide',
      name: 'wrong side',
      nodes: { n0: { id: 'n0', type: outputOnly.type, values: {} } },
      links: {},
      nets: {},
      boundary: { inputs: [{ id: 'in', binds: { kind: 'port', node: 'n0', port: 'value' } }], outputs: [] },
      nextOrdinal: 1,
    })

    const result = deriveBoundarySchema(def, (type) => type === outputOnly.type ? outputOnly : undefined)

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'boundary.sideMismatch',
      message: "[gWrongSide] boundary input 'in' binds an OUTPUT port 'value'",
    }))
  })

  it('keeps the named fail-closed diagnostic when a dotted id aliases a stamped path', () => {
    const schema: NodeSchema = {
      type: 'Collision',
      displayName: 'Collision',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'images.[images_m0].value', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
        {
          kind: 'input',
          id: 'images',
          type: { kind: 'concrete', name: 'COMBO' },
          optional: true,
          dynamic: {
            kind: 'dynamicCombo',
            options: [{
              key: 'images_m0',
              inputs: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
            }],
          },
        },
      ],
    }

    const route = resolveBoundaryRoute(schema, {
      kind: 'port',
      node: 'n0' as never,
      port: 'images.[images_m0].value' as never,
    })

    expect(route).toEqual({
      ok: false,
      code: 'boundary.ambiguousBind',
      message: "port 'images.[images_m0].value' matches 2 structural targets on 'Collision' (dotted ids collide with stamped slot paths)",
    })
    expect(resolveBoundaryRoute(schema, {
      kind: 'port',
      node: 'n0' as never,
      port: 'images.[images_m0].value' as never,
    }, 'input')).toEqual(route)
    expect(resolveBoundaryRoute(schema, {
      kind: 'port',
      node: 'n0' as never,
      port: 'images.[images_m0].value' as never,
    }, 'output')).toEqual(route)
  })

  it('prefers the bound schema label without changing a dotted boundary id', () => {
    const def = asDef({
      id: 'gIdentity',
      name: 'identity',
      nodes: { n0: { id: 'n0', type: 'KSampler', values: {} } },
      links: {},
      nets: {},
      boundary: {
        inputs: [{ id: 'images.images_m0', binds: { kind: 'port', node: 'n0', port: 'latent_image' } }],
        outputs: [],
      },
      nextOrdinal: 1,
    })

    const result = deriveBoundarySchema(def, resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]).toMatchObject({
      id: 'images.images_m0',
      displayName: 'Latent',
    })
  })
})

describe('slot-selective forwarding (binds.slots, hazard F10)', () => {
  const img = { kind: 'concrete', name: 'IMAGE' } as const
  const mask = { kind: 'concrete', name: 'MASK' } as const
  const localSchemas: Record<string, NodeSchema> = {
    // Grouped template: required socket-only 'image', optional 'mask',
    // required-but-widget-backed 'label'.
    Pair: {
      type: 'Pair',
      displayName: 'Pair',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'pairs',
          type: img,
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'image', type: img, optional: false },
              { kind: 'input', id: 'mask', type: mask, optional: true },
              { kind: 'input', id: 'label', type: { kind: 'concrete', name: 'STRING' }, optional: false, widget: { widgetType: 'core.string', options: {} } },
            ],
            naming: { kind: 'prefix', prefix: 'pair', max: 6 },
          },
        },
        { kind: 'output', id: 'out0', type: img },
      ],
    },
    // Grouped template whose 'req' slot is a min-1 nested autogrow holding a
    // required socket-only slot: omitting 'req' starves min-filled members.
    NestReq: {
      type: 'NestReq',
      displayName: 'Nest Req',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'groups',
          type: img,
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'tag', type: { kind: 'concrete', name: 'STRING' }, optional: true, widget: { widgetType: 'core.string', options: {} } },
              {
                kind: 'input',
                id: 'req',
                type: img,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  template: [{ kind: 'input', id: 'x', type: img, optional: false }],
                  naming: { kind: 'prefix', prefix: 'r', min: 1, max: 3 },
                },
              },
            ],
            naming: { kind: 'prefix', prefix: 'g', max: 4 },
          },
        },
      ],
    },
    // Grouped template with a THREE-slot min-0 nested autogrow for nested
    // (dotted) selection: optional 's'/'t' and required socket-only 'r'.
    NestSel: {
      type: 'NestSel',
      displayName: 'Nest Sel',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'groups',
          type: img,
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'tag', type: { kind: 'concrete', name: 'STRING' }, optional: true, widget: { widgetType: 'core.string', options: {} } },
              {
                kind: 'input',
                id: 'sub',
                type: img,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  template: [
                    { kind: 'input', id: 's', type: img, optional: true },
                    { kind: 'input', id: 't', type: mask, optional: true },
                    { kind: 'input', id: 'r', type: img, optional: false },
                  ],
                  naming: { kind: 'prefix', prefix: 'k', max: 3 },
                },
              },
            ],
            naming: { kind: 'prefix', prefix: 'g', max: 4 },
          },
        },
      ],
    },
    // Grouped OUTPUT family: starvation checks are input-side only.
    OutPair: {
      type: 'OutPair',
      displayName: 'Out Pair',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'src', type: img, optional: false },
        {
          kind: 'output',
          id: 'outs',
          type: img,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'main', type: img, optional: false },
              { kind: 'input', id: 'aux', type: mask, optional: true },
            ],
            naming: { kind: 'prefix', prefix: 'o', max: 4 },
          },
        },
      ],
    },
  }
  const resolveLocal: SchemaResolver = (t) => localSchemas[t] ?? innerSchemas[t]

  const defWith = (nodes: Record<string, unknown>, inputs: readonly unknown[], outputs: readonly unknown[] = []): GraphDef =>
    asDef({ id: 'gS', name: 'sel', nodes, links: {}, nets: {}, boundary: { inputs, outputs }, nextOrdinal: 1 })
  const pairNode = (dynamic?: unknown) => ({ n0: { id: 'n0', type: 'Pair', values: {}, ...(dynamic ? { dynamic } : {}) } })
  const errsOf = (def: GraphDef) => deriveBoundarySchema(def, resolveLocal).diagnostics.filter((d) => d.severity === 'error')
  const specOf = (schema: NodeSchema, id: string) => {
    const item = [...inputsOf(schema), ...outputsOf(schema)].find((i) => i.id === id)!
    return item.dynamic as Extract<NonNullable<typeof item.dynamic>, { kind: 'autogrow' }>
  }

  it('filters the derived template in TEMPLATE order, not listing order', () => {
    const def = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['label', 'image'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'p').template.map((s) => s.id)).toEqual(['image', 'label'])
  })

  it('an explicit full selection is legal and keeps the whole template', () => {
    const def = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['image', 'mask', 'label'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'p').template.map((s) => s.id)).toEqual(['image', 'mask', 'label'])
  })

  it('selection does not touch capacity arithmetic or ordinal offsets', () => {
    const def = defWith(pairNode({ pairs: { members: ['m0', 'm1'] } }), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['image', 'label'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'p')).toMatchObject({
      naming: { kind: 'prefix', prefix: 'pair', max: 4 },
      ordinalOffset: 2,
    })
  })

  it('an unknown slot id fails: boundary.slotUnknown', () => {
    const def = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['image', 'nope'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotUnknown' && d.message.includes("'nope'"))).toBe(true)
  })

  it('omitting a required socket-only slot on a growable input family fails: boundary.slotStarved', () => {
    const def = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['mask', 'label'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotStarved' && d.message.includes("'image'"))).toBe(true)
  })

  it('omitting optional and widget-backed slots is fine', () => {
    const def = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['image'] } },
    ])
    expect(errsOf(def)).toEqual([])
  })

  it('no starvation error when the family cannot grow (prefix == max)', () => {
    const def = defWith(pairNode({ pairs: { members: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'] } }), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['mask', 'label'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'p')).toMatchObject({ naming: { max: 0 } })
  })

  it('omitting a min>0 nested autogrow holding a required socket-only slot starves recursively', () => {
    const def = defWith({ n0: { id: 'n0', type: 'NestReq', values: {} } }, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['tag'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotStarved' && d.message.includes("'req.x'"))).toBe(true)
  })

  it('selecting the nested autogrow slot forwards it whole, widget-backed sibling omitted', () => {
    const def = defWith({ n0: { id: 'n0', type: 'NestReq', values: {} } }, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['req'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const template = specOf(schema!, 'g').template
    expect(template.map((s) => s.id)).toEqual(['req'])
    expect(template[0]!.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'r' } })
  })

  it('output families select symmetrically without starvation checks', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'OutPair', values: {} } },
      [],
      [{ id: 'o', binds: { kind: 'family', node: 'n0', port: 'outs', slots: ['aux'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'o').template.map((s) => s.id)).toEqual(['aux'])
  })

  it('chained forwarding selects against the already-filtered derived template', () => {
    const inner = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['image', 'label'] } },
    ])
    const innerSchema = deriveBoundarySchema(inner, resolveLocal).schema!
    const resolveChained: SchemaResolver = (t) => (t === '#gS' ? innerSchema : resolveLocal(t))
    const outer = asDef({
      id: 'gO',
      name: 'outer',
      nodes: { s0: { id: 's0', type: '#gS', values: {} } },
      links: {},
      nets: {},
      boundary: { inputs: [{ id: 'q', binds: { kind: 'family', node: 's0', port: 'p', slots: ['image'] } }], outputs: [] },
      nextOrdinal: 1,
    })
    const { schema, diagnostics } = deriveBoundarySchema(outer, resolveChained)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'q').template.map((s) => s.id)).toEqual(['image'])

    // A slot the inner boundary filtered OUT no longer exists to select.
    const badOuter = asDef({
      id: 'gO',
      name: 'outer',
      nodes: { s0: { id: 's0', type: '#gS', values: {} } },
      links: {},
      nets: {},
      boundary: { inputs: [{ id: 'q', binds: { kind: 'family', node: 's0', port: 'p', slots: ['mask'] } }], outputs: [] },
      nextOrdinal: 1,
    })
    const errs = deriveBoundarySchema(badOuter, resolveChained).diagnostics.filter((d) => d.severity === 'error')
    expect(errs.some((d) => d.code === 'boundary.slotUnknown')).toBe(true)
  })

  const nestSelNode = { n0: { id: 'n0', type: 'NestSel', values: {} } }

  it('a dotted path narrows a nested autogrow construct, in TEMPLATE order at both levels', () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub.r', 'sub.s', 'tag'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const template = specOf(schema!, 'g').template
    expect(template.map((s) => s.id)).toEqual(['tag', 'sub'])
    const nested = template[1]!.dynamic as Extract<NonNullable<(typeof template)[1]['dynamic']>, { kind: 'autogrow' }>
    expect(nested.template.map((s) => s.id)).toEqual(['s', 'r'])
    // Narrowing filters the nested template ONLY - capacity and naming stay.
    expect(nested.naming).toMatchObject({ kind: 'prefix', prefix: 'k', max: 3 })
  })

  it('a dotted path implies ancestor exposure without listing it', () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub.s', 'sub.r'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'g').template.map((s) => s.id)).toEqual(['sub'])
  })

  it('an unknown nested segment fails: boundary.slotUnknown with the full path', () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub.nope', 'sub.r'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotUnknown' && d.message.includes("'sub.nope'"))).toBe(true)
  })

  it('narrowing a concrete slot fails: boundary.slotNotNestable', () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['tag.x'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotNotNestable' && d.message.includes("'tag'"))).toBe(true)
  })

  it("listing both 'sub' and 'sub.s' fails: boundary.slotConflict", () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub', 'sub.s', 'sub.r'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotConflict')).toBe(true)
  })

  it('hiding a required socket-only slot inside a NARROWED nested construct starves - even at min 0', () => {
    // Hiding min-0 'sub' entirely is fine (it materializes nothing), but a
    // NARROWED 'sub' is exposed and growable from the instance: members can
    // exist regardless of min, so hidden required 'r' starves them.
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub.s', 'sub.t'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotStarved' && d.message.includes("'sub.r'"))).toBe(true)
  })

  it('hiding the whole min-0 nested construct with a required slot inside stays legal', () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['tag'] } },
    ])
    expect(errsOf(def)).toEqual([])
  })

  it('chained forwarding narrows a nested construct of an already-derived template', () => {
    const inner = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub'] } },
    ])
    const innerSchema = deriveBoundarySchema(inner, resolveLocal).schema!
    const resolveChained: SchemaResolver = (t) => (t === '#gS' ? innerSchema : resolveLocal(t))
    const outer = asDef({
      id: 'gO',
      name: 'outer',
      nodes: { s0: { id: 's0', type: '#gS', values: {} } },
      links: {},
      nets: {},
      boundary: { inputs: [{ id: 'q', binds: { kind: 'family', node: 's0', port: 'g', slots: ['sub.s', 'sub.r'] } }], outputs: [] },
      nextOrdinal: 1,
    })
    const { schema, diagnostics } = deriveBoundarySchema(outer, resolveChained)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const template = specOf(schema!, 'q').template
    expect(template.map((s) => s.id)).toEqual(['sub'])
    expect((template[0]!.dynamic as { template: readonly { id: string }[] }).template.map((s) => s.id)).toEqual(['s', 'r'])
  })

  it("'slots' on a 'port' binding fails: boundary.slotsOnPort", () => {
    const def = defWith({ n0: { id: 'n0', type: 'KSampler', values: {} } }, [
      { id: 'x', binds: { kind: 'port', node: 'n0', port: 'latent_image', slots: ['a'] } },
    ])
    const errs = errsOf(def)
    expect(errs.some((d) => d.code === 'boundary.slotsOnPort')).toBe(true)
  })
})

describe('dynamicSlot boundary bindings', () => {
  const specializedDef = (options: { selected?: boolean; connected?: boolean; two?: boolean } = {}): GraphDef => {
    const ids = options.two ? ['a', 'b'] : ['a']
    return asDef({
      id: 'gSlot', name: 'slots',
      nodes: Object.fromEntries([
        ['src', { id: 'src', type: 'KSampler', values: {} }],
        ...ids.map((id) => [id, {
          id, type: 'SpecializedSlotNode', values: {},
          dynamic: { model: options.selected === false ? {} : { selected: 'special' } },
        }]),
      ]),
      links: options.connected === false ? {} : Object.fromEntries(ids.map((id) => [`link-${id}`, {
        id: `link-${id}`, from: { node: 'src', port: 'out0' }, to: { node: id, port: 'model' },
      }])),
      nets: {},
      boundary: {
        inputs: ids.map((id) => ({ id, binds: { kind: 'port', node: id, port: 'model.[special].strength' } })),
        outputs: [],
      },
      nextOrdinal: 3,
    })
  }

  it('rejects directly forwarding a slot that has variants', () => {
    const def = specializedDef()
    const node = def.nodes.a!
    const result = deriveBoundarySchema(asDef({
      ...def, nodes: { a: node }, links: {},
      boundary: { inputs: [{ id: 'model', binds: { kind: 'port', node: 'a', port: 'model' } }], outputs: [] },
    }), resolve)
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.some((d) => d.code === 'boundary.specializedSlotUnsupported')).toBe(true)

    const matched = deriveBoundarySchema(asDef({
      id: 'gMatchedDirect', name: 'matched slot',
      nodes: {
        matched: { id: 'matched', type: 'MatchedSlotNode', values: {}, dynamic: { source: { selected: 'image' } } },
      },
      links: {}, nets: {},
      boundary: {
        inputs: [{ id: 'source', binds: { kind: 'port', node: 'matched', port: 'source' } }],
        outputs: [],
      },
      nextOrdinal: 1,
    }), resolve)
    expect(matched.schema).toBeUndefined()
    expect(matched.diagnostics.some((d) => d.code === 'boundary.specializedSlotUnsupported')).toBe(true)
  })

  it('projects a selected slot type through dependent inputs and matched outputs', () => {
    const result = deriveBoundarySchema(asDef({
      id: 'gMatched', name: 'matched slot',
      nodes: {
        src: { id: 'src', type: 'VAEDecode', values: {} },
        matched: { id: 'matched', type: 'MatchedSlotNode', values: {}, dynamic: { source: { selected: 'image' } } },
      },
      links: {
        source: { id: 'source', from: { node: 'src', port: 'out0' }, to: { node: 'matched', port: 'source' } },
      },
      nets: {},
      boundary: {
        inputs: [{ id: 'copy', binds: { kind: 'port', node: 'matched', port: 'source.[image].copy' } }],
        outputs: [
          { id: 'out', binds: { kind: 'port', node: 'matched', port: 'out' } },
          { id: 'batch', binds: { kind: 'port', node: 'matched', port: 'batch' } },
        ],
      },
      nextOrdinal: 2,
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(outputsOf(result.schema!).map((output) => output.type)).toEqual([
      { kind: 'concrete', name: 'IMAGE' },
      { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } },
    ])
  })

  it('still flattens a slot without variants to a forced socket', () => {
    const result = deriveBoundarySchema(asDef({
      id: 'gPlain', name: 'plain', nodes: { a: { id: 'a', type: 'PlainSlotNode', values: {} } }, links: {}, nets: {},
      boundary: { inputs: [{ id: 'model', binds: { kind: 'port', node: 'a', port: 'model' } }], outputs: [] }, nextOrdinal: 1,
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]).toMatchObject({ id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: true, forceInput: true })
  })

  it('binds a selected variant dependent when its slot is connected inside the definition', () => {
    const result = deriveBoundarySchema(specializedDef(), resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]).toMatchObject({ id: 'a', type: { kind: 'variable', templateId: 'a:V' }, optional: false })
  })

  it('rejects a variant dependent when that variant is not selected', () => {
    const result = deriveBoundarySchema(specializedDef({ selected: false }), resolve)
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.some((d) => d.code === 'boundary.branchInactive')).toBe(true)
  })

  it('rejects a variant dependent when its slot is disconnected', () => {
    const result = deriveBoundarySchema(specializedDef({ connected: false }), resolve)
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics.some((d) => d.code === 'boundary.slotDisconnected')).toBe(true)
  })

  it('freshens variant type variables independently for each node instance', () => {
    const result = deriveBoundarySchema(specializedDef({ two: true }), resolve)
    expect(result.diagnostics).toEqual([])
    const [a, b] = inputsOf(result.schema!)
    expect(a!.type).toEqual({ kind: 'variable', templateId: 'a:V' })
    expect(b!.type).toEqual({ kind: 'variable', templateId: 'b:V' })
    expect(a!.type).not.toEqual(b!.type)
  })
})

describe('derivation failures produce diagnostics, never partial schemas', () => {
  const base: GraphDef = asDef({
    id: 'gE',
    name: 'bad',
    nodes: { n0: { id: 'n0', type: 'KSampler', values: {} } },
    links: {},
    nets: {},
    boundary: { inputs: [], outputs: [] },
    nextOrdinal: 1,
  })

  const cases: readonly [string, GraphDef, string][] = [
    ['no boundary', { ...base, boundary: undefined } as never, 'boundary.missing'],
    [
      'dangling node',
      { ...base, boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n9', port: 'seed' } }], outputs: [] } } as never,
      'boundary.danglingNode',
    ],
    [
      'unknown port',
      { ...base, boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'nope' } }], outputs: [] } } as never,
      'boundary.unknownPort',
    ],
    [
      'input item binding an output port',
      { ...base, boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'out0' } }], outputs: [] } } as never,
      'boundary.sideMismatch',
    ],
    [
      'output item binding an input port',
      { ...base, boundary: { inputs: [], outputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'seed' } }] } } as never,
      'boundary.sideMismatch',
    ],
    [
      'duplicate boundary ids',
      {
        ...base,
        boundary: {
          inputs: [
            { id: 'x', binds: { kind: 'port', node: 'n0', port: 'seed' } },
            { id: 'x', binds: { kind: 'port', node: 'n0', port: 'latent_image' } },
          ],
          outputs: [],
        },
      } as never,
      'boundary.duplicateId',
    ],
    [
      'unresolvable inner schema',
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'NotARealNode', values: {} } },
        boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'seed' } }], outputs: [] },
      } as never,
      'boundary.unresolvedSchema',
    ],
    // Member-path arity must equal the families crossed - too many or too
    // few member ids is a structural error, NEVER flattened to a nearby
    // port (hazard N5).
    [
      'member path longer than the families crossed',
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'ImpactSwitch', values: {} } },
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'input.input', members: ['m0', 'g0'] } }],
          outputs: [],
        },
      } as never,
      'boundary.memberPath',
    ],
    [
      'member path on a static output',
      {
        ...base,
        boundary: {
          inputs: [],
          outputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'out0', members: ['m0', 'g0'] } }],
        },
      } as never,
      'boundary.memberPath',
    ],
    [
      'family crossing without a member id',
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'ImpactSwitch', values: {} } },
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'input.input' } }],
          outputs: [],
        },
      } as never,
      'boundary.memberPath',
    ],
    // Binding kinds are explicit (hazard N2): a 'port' bind must never
    // silently become forwarding because the inner schema grew a family,
    // and vice versa.
    [
      "kind 'port' binding a dynamic family construct",
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'ImpactSwitch', values: {} } },
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'input' } }],
          outputs: [],
        },
      } as never,
      'boundary.familyBind',
    ],
    [
      "kind 'family' binding a concrete port",
      {
        ...base,
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'family', node: 'n0', port: 'seed' } }],
          outputs: [],
        },
      } as never,
      'boundary.notAFamily',
    ],
    // A family has ONE suffix owner (hazard F1): a second forwarding route
    // to the same target family is ambiguous, never merged.
    [
      'two boundary items forwarding the same family',
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'ImpactSwitch', values: {} } },
        boundary: {
          inputs: [
            { id: 'a', binds: { kind: 'family', node: 'n0', port: 'input' } },
            { id: 'b', binds: { kind: 'family', node: 'n0', port: 'input' } },
          ],
          outputs: [],
        },
      } as never,
      'boundary.duplicateForward',
    ],
    // 'promoted' is meaningless on family forwarding: the forwarded
    // template carries its widgets (instance suffix members have no inner
    // stored value to fall back on).
    [
      'promoted on a family forwarding input',
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'ImpactSwitch', values: {} } },
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'family', node: 'n0', port: 'input' }, promoted: true }],
          outputs: [],
        },
      } as never,
      'boundary.familyPromoted',
    ],
    // Definition prefix beyond the family cap: the derived spec cannot
    // represent negative capacity, so derivation fails loudly.
    [
      'definition prefix exceeding the family cap',
      {
        ...base,
        nodes: {
          n0: { id: 'n0', type: 'NamedGrow', values: {}, dynamic: { ins: { members: ['m0', 'm1', 'm2', 'm3'] } } },
        },
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'family', node: 'n0', port: 'ins' } }],
          outputs: [],
        },
      } as never,
      'boundary.familyOverCap',
    ],
    [
      'binding a port with a non-structural combo branch path',
      {
        ...base,
        nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
        boundary: {
          inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'mode.x' } }],
          outputs: [],
        },
      } as never,
      'boundary.unknownPort',
    ],
  ]

  for (const [label, def, code] of cases) {
    it(label, () => {
      const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
      expect(schema, label).toBeUndefined()
      expect(diagnostics.some((d) => d.code === code), `expected ${code}`).toBe(true)
    })
  }

  it('forwards a dynamicCombo selector with empty branch templates', () => {
    const result = deriveBoundarySchema(asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
      boundary: { inputs: [{ id: 'mode', binds: { kind: 'port', node: 'n0', port: 'mode' } }], outputs: [] },
    }), resolve)
    expect(result.diagnostics).toEqual([{ severity: 'warning', origin: 'schema', code: 'boundary.selectorOnly', message: "[gE] boundary input 'mode' forwards only the selector; branch inputs stay definition-owned. Upgrade to full-branch forwarding to edit them per instance." }])
    const input = result.schema?.items[0]
    expect(input?.kind).toBe('input')
    if (input?.kind !== 'input') return
    expect(input.dynamic).toEqual({ kind: 'dynamicCombo', options: [{ key: 'a', inputs: [] }], defaultOption: 'a' })
  })

  it('binds a concrete input beneath the active combo branch', () => {
    const result = deriveBoundarySchema(asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
      boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'mode.[a].x' } }], outputs: [] },
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.items[0]).toMatchObject({ kind: 'input', id: 'x', optional: false })
  })

  it('nested subgraph instance types resolve through the resolver', () => {
    const nested: GraphDef = asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: '#gInner', values: {} } },
      boundary: { inputs: [], outputs: [] },
    })
    const resolveNested: SchemaResolver = (t) =>
      t === '#gInner'
        ? {
            type: '#gInner',
            displayName: 'inner',
            category: 'subgraph',
            source: 'subgraph',
            isOutputNode: true,
            items: [],
          }
        : innerSchemas[t]
    const { schema } = deriveBoundarySchema(nested, resolveNested)
    // Output-node status propagates through nested instances.
    expect(schema!.isOutputNode).toBe(true)
  })
})
