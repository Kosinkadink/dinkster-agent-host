/**
 * Value sources (architecture 5b, hazards P1-P5): the principled
 * replacement for the legacy PrimitiveNode. Load-bearing guarantees:
 *   1. the effective spec is DERIVED (declared verbatim, rest unified from
 *      consumers); conflicts are diagnostics, never mutations or value resets
 *   2. compile bakes the stored value into every consumer input it reaches
 *      (through reroute chains) and the source itself vanishes from prompts
 *   3. semantic hash tracks delivered value + controller only - geometry,
 *      declared-spec pinning, and unconnected sources are hash-neutral
 *   4. legacy PrimitiveNodes import as value sources; backend Primitive*
 *      compute nodes are untouched
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, type CompileInput } from '../src/compile/compile.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { Diagnostic } from '../src/diagnostics.js'
import type { GraphDef, JsonObject, ValueSourceData, WorkflowDocument } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { checkDocument } from '../src/invariants.js'
import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
  asValueSourceId,
} from '../src/ids.js'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'
import {
  effectiveValueSourceSpec,
  pinnedSpecOf,
  valueSourceConsumersOf,
  valueSourceLinksOf,
} from '../src/value-source.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const resolve = (type: string) => schemas.get(type)

const codesOf = (d: readonly Diagnostic[]) => d.map((x) => x.code)

// -- synthetic builders (mirrors reroute.test.ts) -----------------------------

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const rr = (id: string) => ({ reroute: asRerouteId(id) })
const vsrc = (id: string) => ({ valueSource: asValueSourceId(id) })

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

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, type = 'KSampler') => ({ id: asNodeId(id), type, values: {} })
const reroute = (id: string) => ({ id: asRerouteId(id) })
const source = (id: string, value: unknown, extra: Partial<ValueSourceData> = {}): ValueSourceData =>
  ({ id: asValueSourceId(id), value, ...extra }) as ValueSourceData

/** v1(7) -> r1 -> n1.steps, plus a direct branch v1 -> n2.steps. */
function fanoutDoc(): WorkflowDocument {
  return doc({
    g0: graph({
      id: 'g0',
      nodes: { n1: node('n1'), n2: node('n2') },
      reroutes: { r1: reroute('r1') },
      valueSources: { v1: source('v1', 7) },
      links: {
        l4: { id: asLinkId('l4'), from: vsrc('v1'), to: rr('r1') },
        l5: { id: asLinkId('l5'), from: rr('r1'), to: port('n1', 'steps') },
        l6: { id: asLinkId('l6'), from: vsrc('v1'), to: port('n2', 'steps') },
      },
    }),
  })
}

const compileInput = (document: WorkflowDocument): CompileInput => ({
  document,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

// ---------------------------------------------------------------------------
// consumer discovery + effective spec derivation
// ---------------------------------------------------------------------------

describe('value source consumers', () => {
  it('finds direct and reroute-chained consumers (fan-out)', () => {
    const def = fanoutDoc().graphs['g0']!
    expect(valueSourceLinksOf(def, 'v1').map((l) => l.id).sort()).toEqual(['l4', 'l6'])
    const consumers = valueSourceConsumersOf(def, 'v1')
    expect(consumers.map((c) => `${c.node}.${c.port}`).sort()).toEqual(['n1.steps', 'n2.steps'])
  })

  it('is cycle-safe through malformed reroute loops', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        reroutes: { r1: reroute('r1'), r2: reroute('r2') },
        valueSources: { v1: source('v1', 1) },
        links: {
          l4: { id: asLinkId('l4'), from: vsrc('v1'), to: rr('r1') },
          l5: { id: asLinkId('l5'), from: rr('r1'), to: rr('r2') },
          l6: { id: asLinkId('l6'), from: rr('r2'), to: rr('r1') },
        },
      }),
    }).graphs['g0']!
    expect(valueSourceConsumersOf(def, 'v1')).toEqual([])
  })
})

describe('effective spec derivation (P1/P2/P5)', () => {
  it('unifies numeric constraints across INT consumers (intersection)', () => {
    // KSampler.seed: min 0, huge max; KSampler.steps: min 1, max 10000.
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        valueSources: { v1: source('v1', 5) },
        links: {
          l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('n1', 'seed') },
          l5: { id: asLinkId('l5'), from: vsrc('v1'), to: port('n2', 'steps') },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    expect(eff.spec?.widgetType).toBe('INT')
    expect(eff.spec?.options['min']).toBe(1)
    expect(eff.spec?.options['max']).toBe(10000)
    expect(eff.diagnostics).toEqual([])
    // seed carries a controller slot; the derived spec adopts it.
    expect(eff.spec?.controller).toBe('after_generate')
  })

  it('reports (never adopts) conflicting widget kinds', () => {
    // seed is INT, cfg is FLOAT.
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        valueSources: { v1: source('v1', 5) },
        links: {
          l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('n1', 'seed') },
          l5: { id: asLinkId('l5'), from: vsrc('v1'), to: port('n2', 'cfg') },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    expect(eff.spec?.widgetType).toBe('INT') // first consumer stands
    expect(codesOf(eff.diagnostics)).toContain('valueSource.widgetType.conflict')
  })

  it('takes declared fields verbatim and flags consumer incompatibility without mutating', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        valueSources: {
          v1: source('v1', 5, { spec: { widgetType: 'INT', options: { min: 20000 } } }),
        },
        links: { l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('n1', 'steps') } },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    // Declared min beats derived min even though it conflicts with steps.max.
    expect(eff.spec?.options['min']).toBe(20000)
    expect(codesOf(eff.diagnostics)).toContain('valueSource.declared.incompatible')
    // P2: the stored value is untouched by any spec outcome.
    expect(def.valueSources!['v1']!.value).toBe(5)
  })

  it('an unconnected source with a declared spec is fully declared-driven', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        valueSources: { v1: source('v1', 5, { spec: { widgetType: 'INT', options: { min: 0, max: 10 } } }) },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    expect(eff.spec).toEqual({ widgetType: 'INT', options: { min: 0, max: 10 } })
    expect(eff.consumers).toEqual([])
  })

  it('an unconnected, undeclared source has NO spec but keeps its value (P2)', () => {
    const def = doc({
      g0: graph({ id: 'g0', valueSources: { v1: source('v1', 'hello') } }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    expect(eff.spec).toBeUndefined()
    expect(def.valueSources!['v1']!.value).toBe('hello')
  })

  it('intersects combo option lists from same-kind consumers', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        valueSources: { v1: source('v1', 'euler') },
        links: {
          l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('n1', 'sampler_name') },
          l5: { id: asLinkId('l5'), from: vsrc('v1'), to: port('n2', 'sampler_name') },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    expect(eff.spec?.widgetType).toBe('COMBO')
    expect(Array.isArray(eff.spec?.options['options'])).toBe(true)
    expect((eff.spec!.options['options'] as unknown[]).length).toBeGreaterThan(0)
    expect(eff.diagnostics).toEqual([])
  })

  it('intersects interchangeable comfy-compat spellings to one canonical atom', () => {
    // A source driving dinkster.mask and comfy.MASK inputs drives ONE value
    // type; the advisory type must canonicalize, not collapse to wildcard.
    const maskResolve = (type: string) =>
      type === 'NativeMaskSink' || type === 'ComfyMaskSink'
        ? ({
            type,
            displayName: type,
            category: 'test',
            source: 'v3',
            isOutputNode: false,
            items: [{
              kind: 'input',
              id: 'mask',
              type: { kind: 'concrete', name: type === 'NativeMaskSink' ? 'dinkster.mask' : 'comfy.MASK' },
              optional: false,
            }],
          } as never)
        : undefined
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1', 'NativeMaskSink'), n2: node('n2', 'ComfyMaskSink') },
        valueSources: { v1: source('v1', null) },
        links: {
          l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('n1', 'mask') },
          l5: { id: asLinkId('l5'), from: vsrc('v1'), to: port('n2', 'mask') },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, maskResolve)
    expect(eff.type).toEqual({ kind: 'concrete', name: 'comfy.MASK' })
  })

  it('pinnedSpecOf produces a JSON-safe declared spec from the effective one', () => {
    const def = fanoutDoc().graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, resolve)
    const pinned = pinnedSpecOf(eff)
    expect(pinned?.['widgetType']).toBe('INT')
    expect(() => JSON.stringify(pinned)).not.toThrow()
  })
})

describe('member-aware consumer derivation (dynamic-derived inputs)', () => {
  // Autogrow widget family + a DynamicCombo: consumers that exist only in
  // the ELABORATED interface, never as top-level schema items.
  const dynResolve = (type: string) =>
    type === 'Dyn'
      ? ({
          type: 'Dyn',
          displayName: 'Dyn',
          category: 'test',
          source: 'v3',
          isOutputNode: true,
          items: [
            {
              kind: 'input',
              id: 'weights',
              type: { kind: 'wildcard' },
              optional: false,
              dynamic: {
                kind: 'autogrow',
                template: [
                  {
                    kind: 'input',
                    id: 'w',
                    type: { kind: 'concrete', name: 'FLOAT' },
                    optional: true,
                    widget: { widgetType: 'FLOAT', options: { min: 0, max: 2 }, default: 0.5 },
                  },
                ],
                naming: { kind: 'prefix', prefix: 'w', min: 0, max: 8 },
              },
            },
            {
              kind: 'input',
              id: 'mode',
              type: { kind: 'concrete', name: 'COMBO' },
              optional: true,
              dynamic: {
                kind: 'dynamicCombo',
                options: [
                  {
                    key: 'a',
                    inputs: [
                      {
                        kind: 'input',
                        id: 'x',
                        type: { kind: 'concrete', name: 'INT' },
                        optional: true,
                        widget: { widgetType: 'INT', options: { min: 1, max: 10 }, default: 1 },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        } as never)
      : undefined

  const dynNode = (id: string) =>
    ({
      id: asNodeId(id),
      type: 'Dyn',
      values: {},
      dynamic: { weights: { members: ['m0'], seq: 1 } },
    }) as never

  it('derives the spec from an autogrow MEMBER consumer via the elaborated interface', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: dynNode('n1') },
        valueSources: { v1: source('v1', 0.75) },
        links: {
          l4: {
            id: asLinkId('l4'),
            from: vsrc('v1'),
            to: { ...port('n1', 'weights.w'), members: ['m0'] } as never,
          },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, dynResolve)
    expect(eff.spec?.widgetType).toBe('FLOAT')
    expect(eff.spec?.options['max']).toBe(2)
    expect(eff.type).toEqual({ kind: 'concrete', name: 'FLOAT' })
    expect(eff.diagnostics).toEqual([])
  })

  it('derives the spec from a combo BRANCH consumer (no member path, not top-level)', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: dynNode('n1') },
        valueSources: { v1: source('v1', 3) },
        links: {
          l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('n1', 'mode.[a].x') },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, dynResolve)
    expect(eff.spec?.widgetType).toBe('INT')
    expect(eff.spec?.options['max']).toBe(10)
  })

  it('an UNPERSISTED member consumer derives nothing (promoteGhosts: false, like compile)', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: dynNode('n1') },
        valueSources: { v1: source('v1', 0.75) },
        links: {
          l4: {
            id: asLinkId('l4'),
            from: vsrc('v1'),
            to: { ...port('n1', 'weights.w'), members: ['m9'] } as never,
          },
        },
      }),
    }).graphs['g0']!
    const eff = effectiveValueSourceSpec(def, def.valueSources!['v1']!, dynResolve)
    expect(eff.spec).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('value source commands', () => {
  it('valueSource.add creates def + view state; ONE undo removes both', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0' }) }))
    const out = store.dispatch({
      command: 'valueSource.add',
      params: { graphId: 'g0', position: { x: 10, y: 20 }, value: 42, title: 'seed' },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.valueSources?.v100).toEqual({ id: 'v100', value: 42, title: 'seed' })
    expect(g.nextOrdinal).toBe(101)
    expect(store.doc.view.graphs.g0!.valueSources?.v100?.position).toEqual({ x: 10, y: 20 })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.valueSources?.v100).toBeUndefined()
    expect(store.doc.view.graphs.g0?.valueSources?.v100).toBeUndefined()
  })

  it('link.connect drives an input from a value source and displaces the old driver', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        valueSources: { v1: source('v1', 7) },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'steps') } },
      }),
    })
    const store = makeStore(d)
    const out = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { valueSource: 'v1' }, to: { node: 'n2', port: 'steps' } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.links.l4).toBeUndefined() // one driver per input (I5)
    const added = Object.values(g.links).find((l) => 'valueSource' in l.from)
    expect(added?.from).toEqual({ valueSource: 'v1' })
    expect(added?.to).toEqual({ node: 'n2', port: 'steps' })
    expect(checkDocument(store.doc).filter((x) => x.severity === 'error')).toEqual([])
  })

  it('rejects links TARGETING a value source (they produce, never consume)', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        valueSources: { v1: source('v1', 7) },
      }),
    })
    const store = makeStore(d)
    const out = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'n1', port: 'out0' }, to: { valueSource: 'v1' } },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(codesOf(out.diagnostics)).toContain('link.valueSourceTarget')
  })

  it('setValue / setSpec / setController / setTitle round-trip with null-clears', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', valueSources: { v1: source('v1', 7) } }) }))
    const g = () => store.doc.graphs.g0!.valueSources!.v1!

    expect(store.dispatch({ command: 'valueSource.setValue', params: { graphId: 'g0', valueSourceId: 'v1', value: 9 } }).ok).toBe(true)
    expect(g().value).toBe(9)

    expect(store.dispatch({
      command: 'valueSource.setSpec',
      params: { graphId: 'g0', valueSourceId: 'v1', spec: { widgetType: 'INT', options: { min: 1 } } },
    }).ok).toBe(true)
    expect(g().spec).toEqual({ widgetType: 'INT', options: { min: 1 } })
    expect(store.dispatch({ command: 'valueSource.setSpec', params: { graphId: 'g0', valueSourceId: 'v1', spec: null } }).ok).toBe(true)
    expect(g().spec).toBeUndefined()

    expect(store.dispatch({ command: 'valueSource.setController', params: { graphId: 'g0', valueSourceId: 'v1', mode: 'randomize' } }).ok).toBe(true)
    expect(g().controller).toBe('randomize')
    expect(store.dispatch({ command: 'valueSource.setController', params: { graphId: 'g0', valueSourceId: 'v1', mode: null } }).ok).toBe(true)
    expect(g().controller).toBeUndefined()

    expect(store.dispatch({ command: 'valueSource.setTitle', params: { graphId: 'g0', valueSourceId: 'v1', title: 'shared seed' } }).ok).toBe(true)
    expect(g().title).toBe('shared seed')

    // Spec changes never touched the value (P2).
    expect(g().value).toBe(9)
  })

  it('rejects malformed spec/controller params', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', valueSources: { v1: source('v1', 7) } }) }))
    expect(store.dispatch({
      command: 'valueSource.setSpec',
      params: { graphId: 'g0', valueSourceId: 'v1', spec: { controller: 'sometimes' } },
    }).ok).toBe(false)
    expect(store.dispatch({
      command: 'valueSource.setController',
      params: { graphId: 'g0', valueSourceId: 'v1', mode: 'chaotic' },
    }).ok).toBe(false)
  })

  it('valueSource.remove cascades its links; ONE undo restores everything', () => {
    const d = fanoutDoc()
    const store = makeStore({
      ...d,
      view: { graphs: { g0: { nodes: {}, valueSources: { v1: { position: { x: 3, y: 4 } } } } } },
    })
    const out = store.dispatch({ command: 'valueSource.remove', params: { graphId: 'g0', valueSourceIds: ['v1'] } })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.valueSources?.v1).toBeUndefined()
    expect(g.links.l4).toBeUndefined() // vs -> reroute dropped
    expect(g.links.l6).toBeUndefined() // vs -> input dropped
    expect(g.links.l5).toBeDefined() // reroute -> input survives (undriven chain is legal)
    expect(store.doc.view.graphs.g0!.valueSources?.v1).toBeUndefined()
    expect(checkDocument(store.doc).filter((x) => x.severity === 'error')).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.valueSources?.v1).toBeDefined()
    expect(store.doc.graphs.g0!.links.l4).toBeDefined()
    expect(store.doc.graphs.g0!.links.l6).toBeDefined()
    expect(store.doc.view.graphs.g0!.valueSources?.v1?.position).toEqual({ x: 3, y: 4 })
  })

  it('graph.deleteItems deletes value sources atomically with other items', () => {
    const store = makeStore(fanoutDoc())
    const out = store.dispatch({
      command: 'graph.deleteItems',
      params: { graphId: 'g0', nodeIds: ['n2'], valueSourceIds: ['v1'] },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes.n2).toBeUndefined()
    expect(g.valueSources?.v1).toBeUndefined()
    expect(Object.keys(g.links)).toEqual(['l5'])
  })

  it('valueSource.move writes view geometry only', () => {
    const store = makeStore(fanoutDoc())
    const before = semanticHashOf(store.doc)
    expect(store.dispatch({
      command: 'valueSource.move',
      params: { graphId: 'g0', positions: { v1: { x: 99, y: 1 } } },
    }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.valueSources?.v1?.position).toEqual({ x: 99, y: 1 })
    expect(semanticHashOf(store.doc)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// invariants (I10)
// ---------------------------------------------------------------------------

describe('invariant I10', () => {
  it('accepts a clean fan-out document', () => {
    expect(checkDocument(fanoutDoc()).filter((d) => d.severity === 'error')).toEqual([])
  })

  it('rejects key/id mismatches and links targeting value sources', () => {
    const bad = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        valueSources: { WRONG: source('v1', 1), v2: source('v2', 2) },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: vsrc('v2') } },
      }),
    })
    const codes = codesOf(checkDocument(bad))
    expect(codes).toContain('doc.valueSource.keyMismatch')
    expect(codes).toContain('doc.link.valueSourceTarget')
  })

  it('rejects dangling ValueSourceRefs and warns on dangling view entries', () => {
    const bad: WorkflowDocument = {
      ...doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1') },
          links: { l4: { id: asLinkId('l4'), from: vsrc('ghost'), to: port('n1', 'steps') } },
        }),
      }),
      view: { graphs: { g0: { nodes: {}, valueSources: { ghost2: { position: { x: 0, y: 0 } } } } } },
    }
    const diags = checkDocument(bad)
    expect(codesOf(diags.filter((d) => d.severity === 'error'))).toContain('doc.link.dangling')
    expect(codesOf(diags.filter((d) => d.severity === 'warning'))).toContain('doc.view.danglingValueSource')
  })

  it('enforces the id allocation cursor for value sources', () => {
    const bad = doc({
      g0: graph({ id: 'g0', nextOrdinal: 1, valueSources: { v100: source('v100', 1) } }),
    })
    expect(codesOf(checkDocument(bad))).toContain('doc.id.aboveCursor')
  })
})

// ---------------------------------------------------------------------------
// compile: bake and vanish (P4)
// ---------------------------------------------------------------------------

describe('compile lowering', () => {
  it('bakes the value into direct, reroute-chained, and fan-out consumers', () => {
    const result = compile(compileInput(fanoutDoc()))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n1']!.inputs['steps']).toBe(7)
    expect(result.artifact.prompt['n2']!.inputs['steps']).toBe(7)
    // The source itself never becomes a prompt node.
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['n1', 'n2'])
  })

  it('the baked value beats the consumer stored value (connection precedence)', () => {
    const d = fanoutDoc()
    const g = d.graphs['g0']!
    const withStored = {
      ...d,
      graphs: {
        g0: { ...g, nodes: { ...g.nodes, n1: { ...g.nodes['n1']!, values: { steps: 999 } } } },
      },
    }
    const result = compile(compileInput(withStored))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n1']!.inputs['steps']).toBe(7)
  })

  it('bakes inside subgraph instances (per occurrence)', () => {
    const d = doc(
      {
        g0: graph({ id: 'g0', nodes: { i1: node('i1', '#sub'), i2: node('i2', '#sub') } }),
        sub: graph({
          id: 'sub',
          nodes: { inner: node('inner') },
          valueSources: { v1: source('v1', 12) },
          links: { l4: { id: asLinkId('l4'), from: vsrc('v1'), to: port('inner', 'steps') } },
          boundary: { inputs: [], outputs: [] },
        }),
      },
      'g0',
    )
    const result = compile(compileInput(d))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['i1.inner']!.inputs['steps']).toBe(12)
    expect(result.artifact.prompt['i2.inner']!.inputs['steps']).toBe(12)
  })

  it('errors on missing value sources and links targeting one (malformed docs)', () => {
    const missing = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        links: { l4: { id: asLinkId('l4'), from: vsrc('ghost'), to: port('n1', 'steps') } },
      }),
    })
    const r1 = compile(compileInput(missing))
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(codesOf(r1.diagnostics)).toContain('compile.valueSource.missing')

    const targeted = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        valueSources: { v1: source('v1', 1) },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: vsrc('v1') } },
      }),
    })
    const r2 = compile(compileInput(targeted))
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(codesOf(r2.diagnostics)).toContain('compile.link.invalidTarget')
  })
})

// ---------------------------------------------------------------------------
// semantic hash (P1: only delivered value + controller are semantic)
// ---------------------------------------------------------------------------

describe('semantic hash', () => {
  it('is neutral to geometry, spec pinning, titles, and unconnected sources', () => {
    const store = makeStore(fanoutDoc())
    const before = semanticHashOf(store.doc)

    store.dispatch({ command: 'valueSource.move', params: { graphId: 'g0', positions: { v1: { x: 5, y: 5 } } } })
    expect(semanticHashOf(store.doc)).toBe(before)

    store.dispatch({
      command: 'valueSource.setSpec',
      params: { graphId: 'g0', valueSourceId: 'v1', spec: { widgetType: 'INT', options: { min: 1, max: 10000 } } },
    })
    expect(semanticHashOf(store.doc)).toBe(before)

    store.dispatch({ command: 'valueSource.setTitle', params: { graphId: 'g0', valueSourceId: 'v1', title: 'renamed' } })
    expect(semanticHashOf(store.doc)).toBe(before)

    store.dispatch({ command: 'valueSource.add', params: { graphId: 'g0', position: { x: 0, y: 0 }, value: 'unused' } })
    expect(semanticHashOf(store.doc)).toBe(before)
  })

  it('changes when the delivered value or controller changes', () => {
    const store = makeStore(fanoutDoc())
    const before = semanticHashOf(store.doc)

    store.dispatch({ command: 'valueSource.setValue', params: { graphId: 'g0', valueSourceId: 'v1', value: 8 } })
    const afterValue = semanticHashOf(store.doc)
    expect(afterValue).not.toBe(before)

    store.dispatch({ command: 'valueSource.setController', params: { graphId: 'g0', valueSourceId: 'v1', mode: 'randomize' } })
    expect(semanticHashOf(store.doc)).not.toBe(afterValue)
  })
})

// ---------------------------------------------------------------------------
// legacy importer: PrimitiveNode -> value source
// ---------------------------------------------------------------------------

interface LgIn {
  name: string
  link?: number | null
}
interface LgOut {
  name: string
  links?: number[]
}
const lgNode = (
  id: number,
  type: string,
  o: { pos?: [number, number]; title?: string; inputs?: LgIn[]; outputs?: LgOut[]; widgets_values?: unknown } = {},
) => ({
  id,
  type,
  pos: o.pos ?? [id * 100, 0],
  ...(o.title !== undefined ? { title: o.title } : {}),
  ...(o.inputs ? { inputs: o.inputs } : {}),
  ...(o.outputs ? { outputs: o.outputs } : {}),
  ...(o.widgets_values !== undefined ? { widgets_values: o.widgets_values } : {}),
})
const lgLink = (id: number, fromNode: number, fromSlot: number, toNode: number, toSlot: number) =>
  [id, fromNode, fromSlot, toNode, toSlot, '*'] as const
const workflow = (nodes: unknown[], links: unknown[] = []): JsonObject =>
  ({ nodes, links, groups: [], version: 0.4 }) as unknown as JsonObject

describe('importer: PrimitiveNode', () => {
  it('converts a connected PrimitiveNode to a value source (value + controller + links)', () => {
    const json = workflow(
      [
        lgNode(1, 'PrimitiveNode', {
          pos: [5, 6],
          title: 'my steps',
          outputs: [{ name: 'INT', links: [1, 2] }],
          widgets_values: [42, 'randomize'],
        }),
        lgNode(2, 'KSampler', { inputs: [{ name: 'steps', link: 1 }] }),
        lgNode(3, 'KSampler', { inputs: [{ name: 'steps', link: 2 }] }),
      ],
      [lgLink(1, 1, 0, 2, 0), lgLink(2, 1, 0, 3, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document, JSON.stringify(diagnostics)).toBeDefined()
    const g = document!.graphs['g0' as never]!
    expect(g.valueSources?.['v1']).toEqual({ id: 'v1', value: 42, controller: 'randomize', title: 'my steps' })
    expect(g.nodes['v1' as never]).toBeUndefined() // never a node
    const froms = Object.values(g.links).map((l) => l.from)
    expect(froms).toEqual([{ valueSource: 'v1' }, { valueSource: 'v1' }])
    expect(document!.view.graphs['g0']!.valueSources?.['v1']?.position).toEqual({ x: 5, y: 6 })
    expect(codesOf(diagnostics)).toContain('import.primitive.converted')
    expect(checkDocument(document!).filter((d) => d.severity === 'error')).toEqual([])
  })

  it('drops a never-connected PrimitiveNode with no value, keeps one WITH a value', () => {
    const json = workflow([
      lgNode(1, 'PrimitiveNode', { outputs: [{ name: '*' }] }),
      lgNode(2, 'PrimitiveNode', { outputs: [{ name: 'INT' }], widgets_values: [7, 'fixed'] }),
    ])
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document).toBeDefined()
    const g = document!.graphs['g0' as never]!
    expect(g.valueSources?.['v1']).toBeUndefined()
    expect(g.valueSources?.['v2']).toEqual({ id: 'v2', value: 7, controller: 'fixed' })
    expect(codesOf(diagnostics)).toContain('import.primitive.dropped')
  })

  it('collapses a Primitive-fed Set/Get net into direct value-source links', () => {
    const json = workflow(
      [
        lgNode(1, 'PrimitiveNode', { outputs: [{ name: 'INT', links: [1] }], widgets_values: [42] }),
        lgNode(2, 'SetNode', {
          inputs: [{ name: '*', link: 1 }], outputs: [{ name: '*' }], widgets_values: ['shared'],
        }),
        lgNode(3, 'GetNode', { outputs: [{ name: '*', links: [2] }], widgets_values: ['shared'] }),
        lgNode(4, 'KSampler', { inputs: [{ name: 'steps', link: 2 }] }),
      ],
      [lgLink(1, 1, 0, 2, 0), lgLink(2, 3, 0, 4, 0)],
    )
    const { document, diagnostics } = importLitegraph(json, resolve)
    expect(document, JSON.stringify(diagnostics)).toBeDefined()
    const g = document!.graphs['g0' as never]!
    expect(Object.keys(g.nets)).toEqual([]) // no net survives
    const link = Object.values(g.links)[0]!
    expect(link.from).toEqual({ valueSource: 'v1' })
    expect(link.to).toEqual({ node: 'n4', port: 'steps' })
    expect(codesOf(diagnostics)).toContain('import.net.primitiveSource')
    expect(checkDocument(document!).filter((d) => d.severity === 'error')).toEqual([])
  })

  it('leaves backend Primitive* compute nodes as ordinary nodes', () => {
    const hasBackendPrimitive = resolve('PrimitiveInt') !== undefined
    if (!hasBackendPrimitive) return // fixture predates backend primitives; nothing to check
    const json = workflow([lgNode(1, 'PrimitiveInt', { outputs: [{ name: 'INT' }], widgets_values: [3, 'fixed'] })])
    const { document } = importLitegraph(json, resolve)
    expect(document!.graphs['g0' as never]!.nodes['n1' as never]).toBeDefined()
    expect(document!.graphs['g0' as never]!.valueSources).toBeUndefined()
  })

  it('imported primitive-driven workflows compile with the value baked in', () => {
    const json = workflow(
      [
        lgNode(1, 'PrimitiveNode', { outputs: [{ name: 'INT', links: [1] }], widgets_values: [23] }),
        lgNode(2, 'KSampler', { inputs: [{ name: 'steps', link: 1 }] }),
      ],
      [lgLink(1, 1, 0, 2, 0)],
    )
    const { document } = importLitegraph(json, resolve)
    const result = compile(compileInput(document!))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n2']!.inputs['steps']).toBe(23)
  })
})
