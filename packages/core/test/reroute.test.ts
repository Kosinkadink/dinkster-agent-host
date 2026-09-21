/**
 * First-class reroutes: tracing, commands, invariants, and the two
 * load-bearing guarantees:
 *   1. compile lowers reroutes away (same prompt as the direct link), and
 *   2. pure reroute edits are semantic-hash neutral (a frozen execution view
 *      never dirties because someone tidied noodles).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, type CompileInput } from '../src/compile/compile.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { ExecutionScope } from '../src/compile/artifact.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { checkDocument } from '../src/invariants.js'
import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
} from '../src/ids.js'
import {
  buildRerouteIndex,
  rerouteDriverOf,
  rerouteSuccessorsOf,
  rerouteResolvedTypes,
  traceEndpoint,
  wouldCreateRerouteCycle,
} from '../src/reroute.js'
import type { NodeSchema, TypeExpr } from '../src/schema/model.js'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const backendResolve = (type: string) => schemas.get(type)

const loadWorkflow = (name: string): WorkflowDocument =>
  loadDocument(readJson(`fixtures/workflows/${name}.json`)).document!

const compileInput = (doc: WorkflowDocument, scope: ExecutionScope = { kind: 'full' }): CompileInput => ({
  document: doc,
  revision: 1,
  resolve: backendResolve,
  scope,
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})

// -- synthetic graph builders (mirrors store.test.ts) ------------------------

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const tap = (node: string, input: string) => ({ node: asNodeId(node), tap: asPortId(input) })
const rr = (id: string) => ({ reroute: asRerouteId(id) })
const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })

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

/** n1.out0 -> r1 -> r2 -> n2.model, plus a second consumer n3 off r1. */
function chainDoc(): WorkflowDocument {
  return doc({
    g0: graph({
      id: 'g0',
      nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
      reroutes: { r1: reroute('r1'), r2: reroute('r2') },
      links: {
        l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: rr('r1') },
        l5: { id: asLinkId('l5'), from: rr('r1'), to: rr('r2') },
        l6: { id: asLinkId('l6'), from: rr('r2'), to: port('n2', 'model') },
        l7: { id: asLinkId('l7'), from: rr('r1'), to: port('n3', 'model') },
      },
    }),
  })
}

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

// ---------------------------------------------------------------------------
// pure tracing
// ---------------------------------------------------------------------------

describe('reroute tracing', () => {
  const def = chainDoc().graphs['g0']!

  it('finds the unique driver and the fan-out of a junction', () => {
    expect(rerouteDriverOf(def, 'r1')?.id).toBe('l4')
    expect(rerouteDriverOf(def, 'r2')?.id).toBe('l5')
    expect(rerouteSuccessorsOf(def, 'r1').map((l) => l.id).sort()).toEqual(['l5', 'l7'])
  })

  it('traces a chain to the real producing output', () => {
    const trace = traceEndpoint(def, rr('r2'))
    expect(trace.kind).toBe('output')
    if (trace.kind === 'output') {
      expect(trace.ref).toEqual({ node: 'n1', port: 'out0' })
      // lastLink is the producer-side link of the chain.
      expect(trace.lastLink?.id).toBe('l4')
    }
  })

  it('a plain port endpoint returns as-is, without lastLink', () => {
    const trace = traceEndpoint(def, port('n1', 'out0'))
    expect(trace).toEqual({ kind: 'output', ref: { node: 'n1', port: 'out0' } })
  })

  it('reports undriven chains', () => {
    const undriven = doc({
      g0: graph({ id: 'g0', reroutes: { r1: reroute('r1') } }),
    }).graphs['g0']!
    expect(traceEndpoint(undriven, rr('r1'))).toEqual({ kind: 'undriven', reroute: 'r1' })
  })

  it('reports cycles instead of looping forever', () => {
    const cyclic = doc({
      g0: graph({
        id: 'g0',
        reroutes: { r1: reroute('r1'), r2: reroute('r2') },
        links: {
          l4: { id: asLinkId('l4'), from: rr('r1'), to: rr('r2') },
          l5: { id: asLinkId('l5'), from: rr('r2'), to: rr('r1') },
        },
      }),
    }).graphs['g0']!
    expect(traceEndpoint(cyclic, rr('r1')).kind).toBe('cycle')
  })

  it('wouldCreateRerouteCycle detects exactly the closing edge', () => {
    // r1 -> r2 exists; feeding r1 FROM r2 would close the loop.
    expect(wouldCreateRerouteCycle(def, rr('r2'), asRerouteId('r1'))).toBe(true)
    // Feeding a fresh reroute from the chain is fine.
    expect(wouldCreateRerouteCycle(def, rr('r2'), asRerouteId('r9'))).toBe(false)
    // A plain port source can never close a reroute cycle.
    expect(wouldCreateRerouteCycle(def, port('n1', 'out0'), asRerouteId('r1'))).toBe(false)
  })

  it('resolves effective display types through the chain, wildcard when undriven', () => {
    const d = loadWorkflow('exec-basic')
    const store = makeStore(d)
    // Split n0.out0 -> n1.images (IMAGE) at a point, then add a free junction.
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l2', position: { x: 0, y: 0 } } }).ok).toBe(true)
    expect(store.dispatch({ command: 'reroute.add', params: { graphId: 'g0', position: { x: 5, y: 5 } } }).ok).toBe(true)
    const def2 = store.doc.graphs['g0']!
    const ids = Object.keys(def2.reroutes)
    expect(ids).toHaveLength(2)
    const types = rerouteResolvedTypes(def2, backendResolve)
    const inserted = ids.find((id) => rerouteDriverOf(def2, id))!
    const free = ids.find((id) => !rerouteDriverOf(def2, id))!
    expect(types.get(inserted)).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(types.get(free)).toEqual({ kind: 'wildcard' })
  })

  it('resolves widget-tap display types through one and two reroutes', () => {
    const widgetSchema: NodeSchema = {
      type: 'Widget', displayName: 'Widget', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'amount', type: concrete('FLOAT'), optional: true,
        widget: { widgetType: 'FLOAT', options: {}, default: 1 },
      }],
    }
    const tapped = graph({
      id: 'g0',
      nodes: { source: node('source', 'Widget') },
      reroutes: { r1: reroute('r1'), r2: reroute('r2') },
      links: {
        l1: { id: asLinkId('l1'), from: tap('source', 'amount'), to: rr('r1') },
        l2: { id: asLinkId('l2'), from: rr('r1'), to: rr('r2') },
      },
    })

    const types = rerouteResolvedTypes(tapped, (type) => type === 'Widget' ? widgetSchema : undefined)
    expect(types.get('r1')).toEqual(concrete('FLOAT'))
    expect(types.get('r2')).toEqual(concrete('FLOAT'))
  })
})

// ---------------------------------------------------------------------------
// ephemeral index (per-operation acceleration; must mirror the direct scans)
// ---------------------------------------------------------------------------

describe('reroute index', () => {
  const def = chainDoc().graphs['g0']!

  it('matches the direct scans for drivers and successors', () => {
    const index = buildRerouteIndex(def)
    for (const id of Object.keys(def.reroutes)) {
      expect(rerouteDriverOf(def, id, index)).toEqual(rerouteDriverOf(def, id))
      expect(rerouteSuccessorsOf(def, id, index)).toEqual(rerouteSuccessorsOf(def, id))
    }
    // Unknown junctions: undefined driver, empty fan-out, both paths.
    expect(rerouteDriverOf(def, 'r9', index)).toBeUndefined()
    expect(rerouteSuccessorsOf(def, 'r9', index)).toEqual([])
  })

  it('traceEndpoint and wouldCreateRerouteCycle agree with and without an index', () => {
    const index = buildRerouteIndex(def)
    expect(traceEndpoint(def, rr('r2'), index)).toEqual(traceEndpoint(def, rr('r2')))
    expect(wouldCreateRerouteCycle(def, rr('r2'), asRerouteId('r1'), index)).toBe(true)
    expect(wouldCreateRerouteCycle(def, rr('r2'), asRerouteId('r9'), index)).toBe(false)

    const cyclic = doc({
      g0: graph({
        id: 'g0',
        reroutes: { r1: reroute('r1'), r2: reroute('r2') },
        links: {
          l4: { id: asLinkId('l4'), from: rr('r1'), to: rr('r2') },
          l5: { id: asLinkId('l5'), from: rr('r2'), to: rr('r1') },
        },
      }),
    }).graphs['g0']!
    expect(traceEndpoint(cyclic, rr('r1'), buildRerouteIndex(cyclic)).kind).toBe('cycle')
  })

  it('keeps the first driver on malformed multi-driver documents (scan parity)', () => {
    const malformed = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        reroutes: { r1: reroute('r1') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: rr('r1') },
          l5: { id: asLinkId('l5'), from: port('n2', 'out0'), to: rr('r1') },
        },
      }),
    }).graphs['g0']!
    const index = buildRerouteIndex(malformed)
    expect(rerouteDriverOf(malformed, 'r1', index)?.id).toBe('l4')
    expect(rerouteDriverOf(malformed, 'r1')?.id).toBe('l4')
  })
})

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('reroute commands', () => {
  it('reroute.add allocates from the ordinal cursor and writes view position', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({ command: 'reroute.add', params: { graphId: 'g0', position: { x: 30, y: 40 } } })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(def.reroutes['r100']).toEqual({ id: 'r100' })
    expect(def.nextOrdinal).toBe(101)
    expect(store.doc.view.graphs['g0']!.reroutes!['r100']!.position).toEqual({ x: 30, y: 40 })
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('reroute.insert splits a link in ONE undo step; ext rides the consumer segment', () => {
    const base = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model'), ext: { vhs: { fps: 8 } } },
        },
      }),
    })
    const store = makeStore(base)
    const out = store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l4', position: { x: 1, y: 2 } } })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(def.links['l4']).toBeUndefined()
    expect(def.reroutes['r100']).toEqual({ id: 'r100' })
    const up = Object.values(def.links).find((l) => 'reroute' in l.to)!
    const down = Object.values(def.links).find((l) => 'reroute' in l.from)!
    expect(up.from).toEqual({ node: 'n1', port: 'out0' })
    expect(up.ext).toBeUndefined()
    expect(down.to).toEqual({ node: 'n2', port: 'model' })
    expect(down.ext).toEqual({ vhs: { fps: 8 } })
    expect(store.doc.view.graphs['g0']!.reroutes!['r100']!.position).toEqual({ x: 1, y: 2 })
    expect(checkDocument(store.doc)).toEqual([])
    // ONE undo step restores the original link exactly.
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs['g0']!.links['l4']).toEqual(base.graphs['g0']!.links['l4'])
    expect(store.doc.graphs['g0']!.reroutes).toEqual({})
  })

  it('reroute.insert works on a chain segment (reroute -> reroute)', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l5', position: { x: 0, y: 0 } } })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(Object.keys(def.reroutes)).toHaveLength(3)
    expect(traceEndpoint(def, rr('r2'))).toMatchObject({ kind: 'output', ref: { node: 'n1', port: 'out0' } })
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('reroute.move batches positions into one undo step and rejects unknown ids', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({
      command: 'reroute.move',
      params: { graphId: 'g0', positions: { r1: { x: 10, y: 11 }, r2: { x: 20, y: 21 } } },
    })
    expect(out.ok).toBe(true)
    const views = store.doc.view.graphs['g0']!.reroutes!
    expect(views['r1']!.position).toEqual({ x: 10, y: 11 })
    expect(views['r2']!.position).toEqual({ x: 20, y: 21 })
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs['g0']?.reroutes?.['r1']).toBeUndefined()

    const bad = store.dispatch({ command: 'reroute.move', params: { graphId: 'g0', positions: { nope: { x: 0, y: 0 } } } })
    expect(bad.ok).toBe(false)
  })

  it('reroute.remove with reconnect contracts the span; consumers stay wired', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({ command: 'reroute.remove', params: { graphId: 'g0', rerouteIds: ['r1', 'r2'] } })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(def.reroutes).toEqual({})
    const remaining = Object.values(def.links)
    expect(remaining).toHaveLength(2)
    for (const link of remaining) expect(link.from).toEqual({ node: 'n1', port: 'out0' })
    expect(remaining.map((l) => l.to)).toEqual(
      expect.arrayContaining([
        { node: 'n2', port: 'model' },
        { node: 'n3', port: 'model' },
      ]),
    )
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('reroute.remove keeps a surviving mid-chain junction wired through', () => {
    const store = makeStore(chainDoc())
    // Remove only r1: n1 must now drive r2 directly AND n3 directly.
    const out = store.dispatch({ command: 'reroute.remove', params: { graphId: 'g0', rerouteIds: ['r1'] } })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(Object.keys(def.reroutes)).toEqual(['r2'])
    expect(rerouteDriverOf(def, 'r2')?.from).toEqual({ node: 'n1', port: 'out0' })
    expect(traceEndpoint(def, rr('r2'))).toMatchObject({ kind: 'output', ref: { node: 'n1', port: 'out0' } })
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('reroute.remove with reconnect: false just severs', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({
      command: 'reroute.remove',
      params: { graphId: 'g0', rerouteIds: ['r1'], reconnect: false },
    })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    // r2's driver came from r1, so r2 is now undriven; n3 lost its input.
    expect(Object.values(def.links).map((l) => l.id)).toEqual(['l6'])
    expect(traceEndpoint(def, rr('r2'))).toEqual({ kind: 'undriven', reroute: 'r2' })
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('graph.deleteItems cascades reroute deletion over attached links and view', () => {
    const d: WorkflowDocument = {
      ...chainDoc(),
      view: { graphs: { g0: { nodes: {}, reroutes: { r1: { position: { x: 0, y: 0 } } } } } },
    }
    const store = makeStore(d)
    const out = store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', rerouteIds: ['r1'] } })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(def.reroutes['r1']).toBeUndefined()
    // Every link touching r1 died; the r2 -> n2 segment survives (undriven).
    expect(Object.keys(def.links).sort()).toEqual(['l6'])
    expect(store.doc.view.graphs['g0']!.reroutes?.['r1']).toBeUndefined()
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('link.connect drives a reroute, replacing its previous driver atomically', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'n2', port: 'out0' }, to: { reroute: 'r1' } },
    })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(def.links['l4']).toBeUndefined() // displaced driver removed
    expect(rerouteDriverOf(def, 'r1')?.from).toEqual({ node: 'n2', port: 'out0' })
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('link.connect rejects cycle-closing and self-loop endpoints', () => {
    const store = makeStore(chainDoc())
    const cycle = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { reroute: 'r2' }, to: { reroute: 'r1' } },
    })
    expect(cycle.ok).toBe(false)
    if (!cycle.ok) expect(cycle.diagnostics[0]!.code).toBe('reroute.cycle')
    const self = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { reroute: 'r1' }, to: { reroute: 'r1' } },
    })
    expect(self.ok).toBe(false)
    expect(store.revision).toBe(0)
  })

  it('link.connect rejects endpoints referencing missing reroutes', () => {
    const store = makeStore(chainDoc())
    const out = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'n1', port: 'out0' }, to: { reroute: 'ghost' } },
    })
    expect(out.ok).toBe(false)
  })

  it('link.rewire retargets an existing link onto a reroute', () => {
    const store = makeStore(chainDoc())
    // Take n3's feed (l7, from r1) and point it at input n2.model? No -
    // rewire l7 to drive nothing new; instead rewire l6 (r2 -> n2.model)
    // onto n3.model: reroute source is preserved, only the target moves.
    const out = store.dispatch({
      command: 'link.rewire',
      params: { graphId: 'g0', linkId: 'l6', to: { node: 'n3', port: 'model' } },
    })
    expect(out.ok).toBe(true)
    const def = store.doc.graphs['g0']!
    expect(def.links['l6']!.to).toEqual({ node: 'n3', port: 'model' })
    // The displaced driver of n3.model (l7) was removed atomically.
    expect(def.links['l7']).toBeUndefined()
    expect(checkDocument(store.doc)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

describe('reroute invariants (I9)', () => {
  it('flags endpoints referencing missing reroutes', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: rr('ghost') } },
      }),
    })
    expect(checkDocument(d).some((x) => x.message.includes("missing reroute 'ghost'"))).toBe(true)
  })

  it('flags two links driving one reroute', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        reroutes: { r1: reroute('r1') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: rr('r1') },
          l5: { id: asLinkId('l5'), from: port('n2', 'out0'), to: rr('r1') },
        },
      }),
    })
    expect(checkDocument(d).some((x) => x.code === 'doc.reroute.multiDriver')).toBe(true)
  })

  it('flags cyclic chains', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        reroutes: { r1: reroute('r1'), r2: reroute('r2') },
        links: {
          l4: { id: asLinkId('l4'), from: rr('r1'), to: rr('r2') },
          l5: { id: asLinkId('l5'), from: rr('r2'), to: rr('r1') },
        },
      }),
    })
    expect(checkDocument(d).some((x) => x.code === 'doc.reroute.cycle')).toBe(true)
  })

  it('accepts a disconnected, undriven junction (parking a dot is legal)', () => {
    const d = doc({
      g0: graph({ id: 'g0', reroutes: { r1: reroute('r1') } }),
    })
    expect(checkDocument(d)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// compile lowering + semantic hash neutrality
// ---------------------------------------------------------------------------

describe('reroute compilation', () => {
  it('compiles through a chain to the same prompt as the direct link', () => {
    const direct = loadWorkflow('exec-basic')
    const expected = compile(compileInput(direct))
    expect(expected.ok).toBe(true)

    const store = makeStore(loadWorkflow('exec-basic'))
    // Split twice: n0.out0 -> r -> r' -> n1.images.
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l2', position: { x: 0, y: 0 } } }).ok).toBe(true)
    const seg = Object.values(store.doc.graphs['g0']!.links).find((l) => 'reroute' in l.from)!
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: seg.id, position: { x: 1, y: 1 } } }).ok).toBe(true)

    const rerouted = compile(compileInput(store.doc))
    expect(rerouted.ok).toBe(true)
    if (!expected.ok || !rerouted.ok) return
    expect(rerouted.artifact.prompt).toEqual(expected.artifact.prompt)
  })

  it('warns and omits the input when the chain is undriven', () => {
    const store = makeStore(loadWorkflow('exec-basic'))
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l2', position: { x: 0, y: 0 } } }).ok).toBe(true)
    const feed = Object.values(store.doc.graphs['g0']!.links).find((l) => 'reroute' in l.to)!
    expect(store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: feed.id } }).ok).toBe(true)

    const result = compile(compileInput(store.doc))
    // PreviewImage.images is required, so the compile fails downstream - the
    // reroute-specific diagnostic must still be the undriven warning.
    const diags = result.ok ? result.artifact.diagnostics : result.diagnostics
    expect(diags.some((d) => d.code === 'compile.reroute.undriven')).toBe(true)
  })

  it('pure reroute edits are semantic-hash neutral; real rewires are not', () => {
    const direct = loadWorkflow('exec-basic')
    const baseline = semanticHashOf(direct)

    const store = makeStore(loadWorkflow('exec-basic'))
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l2', position: { x: 0, y: 0 } } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(baseline)
    expect(store.dispatch({ command: 'reroute.move', params: { graphId: 'g0', positions: { r3: { x: 9, y: 9 } } } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(baseline)
    // Dissolving back is neutral too.
    expect(store.dispatch({ command: 'reroute.remove', params: { graphId: 'g0', rerouteIds: ['r3'] } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(baseline)
    // A REAL topology change moves the hash.
    expect(store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: Object.keys(store.doc.graphs['g0']!.links)[0]! } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).not.toBe(baseline)
  })

  it('an undriven chain hashes identically to no link at all (matches compiler omission)', () => {
    // Baseline: the consumer input simply has no link.
    const bare = makeStore(loadWorkflow('exec-basic'))
    expect(bare.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l2' } }).ok).toBe(true)
    const baseline = semanticHashOf(bare.doc)

    // Same input fed by an undriven junction: compiles to nothing, so the
    // hash must not differ (dissolving the dead junction is also neutral).
    const store = makeStore(loadWorkflow('exec-basic'))
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l2', position: { x: 0, y: 0 } } }).ok).toBe(true)
    const feed = Object.values(store.doc.graphs['g0']!.links).find((l) => 'reroute' in l.to)!
    expect(store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: feed.id } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(baseline)

    const rid = Object.keys(store.doc.graphs['g0']!.reroutes)[0]!
    expect(store.dispatch({ command: 'reroute.remove', params: { graphId: 'g0', rerouteIds: [rid] } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(baseline)
  })

  it('link ext is semantic on the consumer segment only, never on structural feeds', () => {
    const build = (feedExt?: Record<string, never> | { a: number }, consumerExt?: { a: number }) =>
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1'), n2: node('n2') },
          reroutes: { r1: reroute('r1') },
          links: {
            l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: rr('r1'), ...(feedExt ? { ext: feedExt } : {}) },
            l5: { id: asLinkId('l5'), from: rr('r1'), to: port('n2', 'model'), ...(consumerExt ? { ext: consumerExt } : {}) },
          },
        }),
      })
    const plain = semanticHashOf(build())
    // ext on the structural feed is view-only: hash-neutral.
    expect(semanticHashOf(build({ a: 1 }))).toBe(plain)
    // ext on the consumer-delivering segment is semantic.
    expect(semanticHashOf(build(undefined, { a: 1 }))).not.toBe(plain)
    // ...and matches the dissolved equivalent carrying the same ext.
    const direct = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model'), ext: { a: 1 } } },
      }),
    })
    expect(semanticHashOf(build(undefined, { a: 1 }))).toBe(semanticHashOf(direct))
  })

  it('reroutes inside a subgraph definition stay scoped and hash-neutral', () => {
    const direct = loadWorkflow('subgraph')
    const store = makeStore(loadWorkflow('subgraph'))
    // Split a link INSIDE the subgraph definition g1 (l3). No reroute-specific
    // subgraph code exists; scoping falls out of links never crossing defs.
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g1', linkId: 'l3', position: { x: 0, y: 0 } } }).ok).toBe(true)
    expect(checkDocument(store.doc)).toEqual([])
    const inner = store.doc.graphs['g1']!
    const rid = Object.keys(inner.reroutes)[0]!
    expect(traceEndpoint(inner, { reroute: asRerouteId(rid) })).toMatchObject({
      kind: 'output',
      ref: { node: 'n0', port: 'out0' },
    })
    expect(semanticHashOf(store.doc)).toBe(semanticHashOf(direct))
  })

  it('a link endpoint cannot reference a reroute from another graph definition', () => {
    // r1 lives in g1; a g0 link pointing at it is a missing-reroute invariant
    // error in g0 - reroutes are definition-scoped by construction.
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1') },
          links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: rr('r1') } },
        }),
        g1: graph({ id: 'g1', reroutes: { r1: reroute('r1') } }),
      },
      'g0',
    )
    expect(checkDocument(d).some((x) => x.message.includes("missing reroute 'r1'"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

describe('reroute persistence', () => {
  it('documents with reroutes round-trip through JSON and reload cleanly', () => {
    const store = makeStore(loadWorkflow('exec-basic'))
    expect(store.dispatch({ command: 'reroute.insert', params: { graphId: 'g0', linkId: 'l2', position: { x: 7, y: 8 } } }).ok).toBe(true)
    const json = JSON.parse(JSON.stringify(store.doc)) as unknown
    const { document, diagnostics } = loadDocument(json)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(document).toEqual(store.doc)
  })

  it('shape validation rejects malformed reroute view state', () => {
    const store = makeStore(loadWorkflow('exec-basic'))
    expect(store.dispatch({ command: 'reroute.add', params: { graphId: 'g0', position: { x: 0, y: 0 } } }).ok).toBe(true)
    const json = JSON.parse(JSON.stringify(store.doc)) as {
      view: { graphs: Record<string, { reroutes: Record<string, unknown> }> }
    }
    json.view.graphs['g0']!.reroutes['r3'] = { position: { x: 'NaN' } }
    const { diagnostics } = loadDocument(json)
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true)
  })
})
