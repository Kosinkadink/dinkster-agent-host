import { describe, expect, it } from 'vitest'
import type { DynamicPortState, WorkflowDocument, GraphDef } from '../src/format/document.js'
import { asDynamicMemberId, asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId, type PortRef } from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })

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

describe('checkDocument', () => {
  it('accepts a minimal valid document', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: {
          l3: { id: asLinkId('l3'), from: port('n1', 'out0'), to: port('n2', 'model') },
        },
      }),
    })
    expect(checkDocument(d)).toEqual([])
  })

  it('flags missing root graph', () => {
    const d = doc({}, 'missing')
    expect(checkDocument(d).map((x) => x.code)).toContain('doc.root.missing')
  })

  it('flags dangling link endpoints', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        links: { l2: { id: asLinkId('l2'), from: port('n1', 'out0'), to: port('nX', 'in') } },
      }),
    })
    expect(checkDocument(d).map((x) => x.code)).toContain('doc.link.dangling')
  })

  it('flags an input driven by both a link and a net', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n3', 'model') } },
        nets: {
          net5: { id: asNetId('net5'), name: 'model', source: port('n2', 'out0'), sinks: [port('n3', 'model')] },
        },
      }),
    })
    expect(checkDocument(d).map((x) => x.code)).toContain('doc.input.multiDriver')
  })

  it('rejects stale canonical, nested, and wire-15 member endpoints while preserving opaque paths', () => {
    const diagnostics = (dynamic: Record<string, DynamicPortState>, endpoint: PortRef, asNet = false) => {
      const target = { ...node('n2'), dynamic }
      const g = graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: target },
        links: asNet ? {} : { l1: { id: asLinkId('l1'), from: port('n1', 'out'), to: endpoint } },
        nets: asNet
          ? { net1: { id: asNetId('net1'), name: 'n', source: port('n1', 'out'), sinks: [endpoint] } }
          : {},
      })
      return checkDocument(doc({ g0: g })).map((diagnostic) => diagnostic.code)
    }

    expect(diagnostics({ images: { seq: 1 } }, port('n2', 'images.m0'))).toContain('doc.dynamic.memberMissing')
    expect(diagnostics({ images: { seq: 1 } }, port('n2', 'images.m0'), true)).toContain('doc.dynamic.memberMissing')
    expect(diagnostics(
      { items: { members: ['m0'], seq: 1 } },
      { ...port('n2', 'items.sub.item'), members: [asDynamicMemberId('m0'), asDynamicMemberId('m1')] },
    )).toContain('doc.dynamic.memberMissing')
    const nested = {
      items: {
        members: ['m0'], seq: 1,
        memberState: { m0: { 'items.sub': { members: ['m1'], seq: 2 } } },
      },
    }
    expect(diagnostics(nested, port('n2', 'items.m0.sub.m1.item'))).not.toContain('doc.dynamic.memberMissing')
    expect(diagnostics(nested, port('n2', 'items.m0.sub.m0.item'))).toContain('doc.dynamic.memberMissing')
    const flattened = {
      outer: { members: ['root'], seq: 1 },
      'outer.root.inner': { members: ['child'], seq: 1 },
    }
    expect(diagnostics(flattened, port('n2', 'outer.root.inner.child'))).not.toContain('doc.dynamic.memberMissing')
    expect(diagnostics({ ...flattened, outer: { seq: 1 } }, port('n2', 'outer.root.inner.child')))
      .toContain('doc.dynamic.memberMissing')
    expect(diagnostics({ ...flattened, 'outer.root.inner': { seq: 1 } }, port('n2', 'outer.root.inner.child')))
      .toContain('doc.dynamic.memberMissing')

    expect(diagnostics({ images: { members: ['m0'], seq: 1 } }, port('n2', 'images.m0')))
      .not.toContain('doc.dynamic.memberMissing')
    expect(diagnostics({ mode: { selected: 'a' } }, { ...port('n2', 'mode.value'), members: [asDynamicMemberId('opaque')] }))
      .not.toContain('doc.dynamic.memberMissing')
    expect(diagnostics({}, { ...port('n2', 'extension.path'), members: [asDynamicMemberId('opaque')] }))
      .not.toContain('doc.dynamic.memberMissing')
  })

  it('flags recursive subgraph definitions', () => {
    const d = doc({
      g0: graph({ id: 'g0', nodes: { n1: node('n1', '#gA') } }),
      gA: graph({
        id: 'gA',
        nodes: { n1: node('n1', '#gB') },
        boundary: { inputs: [], outputs: [] },
      }),
      gB: graph({
        id: 'gB',
        nodes: { n1: node('n1', '#gA') },
        boundary: { inputs: [], outputs: [] },
      }),
    })
    expect(checkDocument(d).map((x) => x.code)).toContain('doc.subgraph.recursive')
  })

  it('flags dangling subgraph references', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', '#nope') } }) })
    expect(checkDocument(d).map((x) => x.code)).toContain('doc.subgraph.dangling')
  })

  it('flags id reuse above the allocation cursor', () => {
    const d = doc({
      g0: graph({ id: 'g0', nodes: { n5: node('n5') }, nextOrdinal: 3 }),
    })
    expect(checkDocument(d).map((x) => x.code)).toContain('doc.id.aboveCursor')
  })

  it('warns on view state for missing nodes', () => {
    const d: WorkflowDocument = {
      ...doc({ g0: graph({ id: 'g0' }) }),
      view: { graphs: { g0: { nodes: { nX: { position: { x: 0, y: 0 } } } } } },
    }
    const codes = checkDocument(d).map((x) => x.code)
    expect(codes).toContain('doc.view.danglingNode')
  })

  it('warns on net display state for missing or expanded nets', () => {
    const d: WorkflowDocument = {
      ...doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1') },
          nets: { t9: { id: asNetId('t9'), name: 'ctx', source: port('n1', 'out0'), sinks: [] } },
        }),
      }),
      // 'ghost' and 'phantom' name no net; t9 exists but is not collapsed.
      view: { graphs: { g0: { nodes: {}, collapsedNets: ['ghost'], guideNets: ['phantom', 't9'] } } },
    }
    const codes = checkDocument(d).map((x) => x.code)
    expect(codes.filter((c) => c === 'doc.view.danglingNet')).toHaveLength(2)
    expect(codes).toContain('doc.view.guideNotCollapsed')
  })
})
