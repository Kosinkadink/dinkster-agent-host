/**
 * Blueprint materialization + subgraph.import: copy semantics, fresh-id
 * allocation, '#<id>' reference rewriting, root-cone scoping, and the
 * atomic reject paths (malformed defs, id collisions, dangling refs).
 */
import { describe, expect, it } from 'vitest'
import { materializeBlueprint } from '../src/blueprint.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'

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

const boundary = { inputs: [], outputs: [] }

/** A blueprint body: root gA (boundary) instantiates nested gB (boundary). */
function blueprintDoc(): WorkflowDocument {
  const d = doc(
    {
      gA: graph({ id: 'gA', boundary, nodes: { n1: node('n1', '#gB'), n2: node('n2') } }),
      gB: graph({ id: 'gB', boundary, nodes: { n1: node('n1', 'EmptyImage') } }),
      gC: graph({ id: 'gC', boundary, nodes: {} }), // unreferenced: stays behind
    },
    'gA',
  )
  return {
    ...d,
    view: { graphs: { gA: { nodes: { n1: { position: { x: 5, y: 7 } } } } } },
  }
}

describe('materializeBlueprint', () => {
  const target = doc({
    g0: graph({ id: 'g0' }),
    g2: graph({ id: 'g2', boundary }), // hole at g1: allocator must skip g2
  })

  it('imports only the root cone with fresh ids and rewritten refs', () => {
    const m = materializeBlueprint(target, blueprintDoc())
    expect(m.ok).toBe(true)
    if (!m.ok) return
    // Fresh ids: smallest unused (g1, then g3 - g0/g2 are taken), root first.
    expect(m.rootId).toBe('g1')
    expect(Object.keys(m.graphs).sort()).toEqual(['g1', 'g3'])
    // Internal '#gB' rewritten to the fresh id; def.id matches its key.
    expect(m.graphs['g1']!.nodes['n1']!.type).toBe('#g3')
    expect(m.graphs['g1']!.id).toBe('g1')
    expect(m.graphs['g3']!.id).toBe('g3')
    // Unreferenced gC stays behind; view state rides the rename.
    expect(m.view['g1']!.nodes['n1']!.position).toEqual({ x: 5, y: 7 })
    expect(m.view['g3']).toBeUndefined()
  })

  it('non-subgraph node types are untouched (placeholder story)', () => {
    const m = materializeBlueprint(target, blueprintDoc())
    if (!m.ok) throw new Error('expected ok')
    expect(m.graphs['g1']!.nodes['n2']!.type).toBe('KSampler')
    expect(m.graphs['g3']!.nodes['n1']!.type).toBe('EmptyImage')
  })

  it('rejects a blueprint whose root has no boundary', () => {
    const bp = doc({ g0: graph({ id: 'g0' }) })
    const m = materializeBlueprint(target, bp)
    expect(m.ok).toBe(false)
    if (m.ok) return
    expect(m.diagnostics[0]!.code).toBe('blueprint.noBoundary')
  })

  it('rejects a blueprint whose root is missing', () => {
    const bp = doc({ g0: graph({ id: 'g0' }) }, 'nope')
    const m = materializeBlueprint(target, bp)
    expect(m.ok).toBe(false)
    if (m.ok) return
    expect(m.diagnostics[0]!.code).toBe('blueprint.rootMissing')
  })
})

describe('subgraph.import', () => {
  const makeStore = () => new DocumentStore(doc({ g0: graph({ id: 'g0' }) }), coreCommandRegistry())

  const freshDef = (id: string): GraphDef => graph({ id, boundary, nodes: { n1: node('n1') } })

  it('imports defs + view atomically; batch with node.add is one undo step', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'subgraph.import',
            params: {
              graphs: { g1: freshDef('g1') as never },
              view: { g1: { nodes: { n1: { position: { x: 1, y: 2 } } } } },
            },
          },
          { command: 'node.add', params: { graphId: 'g0', type: '#g1', position: { x: 0, y: 0 } } },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs['g1']).toBeDefined()
    expect(store.doc.view.graphs['g1']!.nodes['n1']!.position).toEqual({ x: 1, y: 2 })
    expect(store.doc.graphs['g0']!.nodes['n100']!.type).toBe('#g1')
    // One transaction: a single undo removes the def AND the instance.
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs['g1']).toBeUndefined()
    expect(store.doc.graphs['g0']!.nodes['n100']).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('FR1 undoing an import leaves no cursor skeleton behind (no dangling view graph)', () => {
    // Imported view state may carry a groupSeq (copy semantics keeps it),
    // and undoing the import records a whole view.graphs[g] remove - the
    // exact shape the FR1 skeleton preservation retargets. But here the
    // graph ITSELF leaves in the same batch, so the remove must stand
    // verbatim: a {nodes, groupSeq} skeleton without its graph would be a
    // dangling view entry (I8 doc.view.danglingGraph).
    const store = makeStore()
    const out = store.dispatch({
      command: 'subgraph.import',
      params: {
        graphs: { g1: freshDef('g1') as never },
        view: { g1: { nodes: {}, groupSeq: 3 } },
      },
    })
    expect(out.ok).toBe(true)
    // Allocate on the imported graph: the imported cursor floors the mint.
    expect(
      store.dispatch({
        command: 'view.createGroup',
        params: { graphId: 'g1', title: 't', bounds: { x: 0, y: 0, width: 10, height: 10 } },
      }).ok,
    ).toBe(true)
    expect(Object.keys(store.doc.view.graphs['g1']!.groups!)).toEqual(['grp3'])
    expect(store.undo()).toBe(true) // un-create: graph survives, cursor clamped
    expect(store.doc.view.graphs['g1']!.groupSeq).toBe(4)
    expect(store.undo()).toBe(true) // un-import: BOTH sides must go
    expect(store.doc.graphs['g1']).toBeUndefined()
    expect(store.doc.view.graphs['g1']).toBeUndefined()
    // Redo restores the import verbatim (the namespace's identity history
    // left WITH the graph; this is un-import, not group removal).
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs['g1']).toBeDefined()
    expect(store.doc.view.graphs['g1']).toEqual({ nodes: {}, groupSeq: 3 })
  })

  it('a def without view state gets an empty view entry', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'subgraph.import',
      params: { graphs: { g1: freshDef('g1') as never } },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.view.graphs['g1']).toEqual({ nodes: {} })
  })

  it('rejects an id collision with an existing definition', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'subgraph.import',
      params: { graphs: { g0: freshDef('g0') as never } },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('graph.exists')
    expect(store.revision).toBe(0)
  })

  it('rejects malformed defs, key/id mismatch, and orphan view entries', () => {
    const store = makeStore()
    const bad = store.dispatch({
      command: 'subgraph.import',
      params: { graphs: { g1: { id: 'g1' } as never } },
    })
    expect(bad.ok).toBe(false)

    const mismatch = store.dispatch({
      command: 'subgraph.import',
      params: { graphs: { g1: freshDef('g9') as never } },
    })
    expect(mismatch.ok).toBe(false)

    const orphanView = store.dispatch({
      command: 'subgraph.import',
      params: { graphs: { g1: freshDef('g1') as never }, view: { g2: { nodes: {} } } },
    })
    expect(orphanView.ok).toBe(false)
    expect(store.revision).toBe(0)
  })

  it('a def whose subgraph ref dangles rejects via the invariant checker', () => {
    const store = makeStore()
    const def = graph({ id: 'g1', boundary, nodes: { n1: node('n1', '#nowhere') } })
    const out = store.dispatch({
      command: 'subgraph.import',
      params: { graphs: { g1: def as never } },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics.some((d) => d.code === 'doc.subgraph.dangling')).toBe(true)
  })
})
