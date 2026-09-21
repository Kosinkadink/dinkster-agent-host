import { describe, expect, it } from 'vitest'
import { planClipboardPaste, serializeSelection, type DinksterClipboardEnvelope } from '../src/clipboard.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { loadDocument, type WorkflowDocument } from '../src/index.js'

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'g0' as never,
  graphs: { g0: {
    id: 'g0' as never, name: 'root', nextOrdinal: 10,
    nodes: {
      a: { id: 'a' as never, type: 'Producer', values: { seed: 7 } },
      b: { id: 'b' as never, type: 'UnknownOnAnotherBackend', values: { text: 'kept' } },
      outside: { id: 'outside' as never, type: 'Sink', values: {} },
    },
    reroutes: { r: { id: 'r' as never } }, nets: {},
    links: {
      into: { id: 'into' as never, from: { node: 'a' as never, port: 'out' as never }, to: { reroute: 'r' as never } },
      out: { id: 'out' as never, from: { reroute: 'r' as never }, to: { node: 'b' as never, port: 'in' as never } },
      partial: { id: 'partial' as never, from: { node: 'b' as never, port: 'out' as never }, to: { node: 'outside' as never, port: 'in' as never } },
    },
  } },
  view: { graphs: { g0: {
    nodes: {
      a: { position: { x: 100, y: 200 } }, b: { position: { x: 300, y: 200 } }, outside: { position: { x: 600, y: 200 } },
    },
    reroutes: { r: { position: { x: 250, y: 240 } } },
  } } },
})

const connectedDocument = (graphId = 'g0'): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: graphId as never,
  graphs: { [graphId]: {
    id: graphId as never, name: graphId, nextOrdinal: 20, reroutes: {}, nets: {},
    nodes: {
      upstream: { id: 'upstream' as never, type: 'Producer', values: {} },
      other: { id: 'other' as never, type: 'Producer', values: {} },
      a: { id: 'a' as never, type: 'Middle', values: {} },
      b: { id: 'b' as never, type: 'Sink', values: {} },
      outside: { id: 'outside' as never, type: 'Sink', values: {} },
    },
    links: {
      incomingA: { id: 'incomingA' as never, from: { node: 'upstream' as never, port: 'out' as never }, to: { node: 'a' as never, port: 'in' as never } },
      incomingB: { id: 'incomingB' as never, from: { node: 'other' as never, port: 'out' as never }, to: { node: 'b' as never, port: 'side' as never } },
      internal: { id: 'internal' as never, from: { node: 'a' as never, port: 'out' as never }, to: { node: 'b' as never, port: 'in' as never } },
      outgoing: { id: 'outgoing' as never, from: { node: 'b' as never, port: 'out' as never }, to: { node: 'outside' as never, port: 'in' as never } },
    },
  } },
  view: { graphs: { [graphId]: { nodes: {
    upstream: { position: { x: 0, y: 0 } }, other: { position: { x: 0, y: 150 } },
    a: { position: { x: 200, y: 0 } }, b: { position: { x: 400, y: 0 } }, outside: { position: { x: 600, y: 0 } },
  } } } },
})

const nestedSubgraphDocument = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'subgraph-source' as never, root: 'g0' as never,
  graphs: {
    g0: {
      id: 'g0' as never, name: 'root', nextOrdinal: 1,
      nodes: { instance: { id: 'instance' as never, type: '#outer', values: {} } },
      links: {}, nets: {}, reroutes: {},
    },
    outer: {
      id: 'outer' as never, name: 'Outer', nextOrdinal: 1,
      nodes: { nested: { id: 'nested' as never, type: '#inner', values: {} } },
      links: {}, nets: {}, reroutes: {},
      boundary: {
        inputs: [{ id: 'value', displayName: 'Source Value', binds: { kind: 'port', node: 'nested' as never, port: 'value' as never } }],
        outputs: [{ id: 'result', displayName: 'Result Value', binds: { kind: 'port', node: 'nested' as never, port: 'result' as never } }],
      },
    },
    inner: {
      id: 'inner' as never, name: 'Inner', nextOrdinal: 1,
      nodes: { pass: { id: 'pass' as never, type: 'Pass', values: {} } },
      links: {}, nets: {}, reroutes: {},
      boundary: {
        inputs: [{ id: 'value', binds: { kind: 'port', node: 'pass' as never, port: 'value' as never } }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'pass' as never, port: 'result' as never } }],
      },
    },
  },
  view: { graphs: {
    g0: { nodes: { instance: { position: { x: 100, y: 100 } } } },
    outer: { nodes: { nested: { position: { x: 200, y: 200 } } }, boundary: { inputs: { position: { x: 0, y: 200 } } } },
    inner: { nodes: { pass: { position: { x: 300, y: 300 } } } },
  } },
})

const connectedPaste = (doc: WorkflowDocument, graphId: string, envelope: DinksterClipboardEnvelope) => {
  const store = new DocumentStore(doc, coreCommandRegistry())
  const plan = planClipboardPaste(doc, graphId, envelope, { x: 20, y: 30 }, undefined, true)!
  const outcome = store.dispatch(plan.invocation)
  expect(outcome).toMatchObject({ ok: true })
  return { store, plan }
}

describe('Dinkster clipboard', () => {
  it('preserves minimized state and expanded size through copy and paste', () => {
    const source = document()
    ;(source.view.graphs.g0!.nodes.a as { collapsed?: boolean; size?: { width: number; height: number } }).collapsed = true
    ;(source.view.graphs.g0!.nodes.a as { collapsed?: boolean; size?: { width: number; height: number } }).size = {
      width: 420,
      height: 280,
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    expect(envelope.nodes[0]!.view).toMatchObject({ collapsed: true, size: { width: 420, height: 280 } })

    const plan = planClipboardPaste(source, 'g0', envelope, { x: 500, y: 400 })!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes[plan.nodeIds[0]!]).toMatchObject({
      collapsed: true,
      size: { width: 420, height: 280 },
      position: { x: 500, y: 400 },
    })
  })

  it('copies a transitive subgraph definition closure across documents and undoes atomically', () => {
    const source = nestedSubgraphDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    expect(envelope.version).toBe(5)
    expect(Object.keys(envelope.definitions!.graphs).sort()).toEqual(['inner', 'outer'])
    expect((envelope.definitions!.graphs.outer as any).nodes.nested.type).toBe('#inner')

    const target = document()
    const plan = planClipboardPaste(target, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.type).toBe('#outer')
    expect(store.doc.graphs.outer!.nodes.nested!.type).toBe('#inner')
    expect(store.doc.view.graphs.outer!.boundary?.inputs?.position).toEqual({ x: 0, y: 200 })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.outer).toBeUndefined()
    expect(store.doc.graphs.inner).toBeUndefined()
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.type).toBe('#outer')
  })

  it('preserves an exact widget-output binding when copying a subgraph occurrence', () => {
    const source = nestedSubgraphDocument()
    ;(source.graphs.inner!.boundary as any).outputs = [{
      id: 'result',
      binds: { kind: 'widgetTap', node: 'pass' as never, tap: 'value' as never },
    }]
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    expect((envelope.definitions!.graphs.inner as any).boundary.outputs).toEqual([{
      id: 'result',
      binds: { kind: 'widgetTap', node: 'pass', tap: 'value' },
    }])

    const target = document()
    const plan = planClipboardPaste(target, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.inner!.boundary!.outputs).toEqual([{
      id: 'result',
      binds: { kind: 'widgetTap', node: 'pass', tap: 'value' },
    }])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.inner).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.inner!.boundary!.outputs[0]!.binds).toEqual({
      kind: 'widgetTap', node: 'pass', tap: 'value',
    })
  })

  it('supplies an empty view when a copied definition has no stored view state', () => {
    const source = nestedSubgraphDocument()
    delete (source.view.graphs as Record<string, unknown>).outer
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    expect(envelope.definitions!.view.outer).toEqual({ nodes: {} })

    const target = document()
    const plan = planClipboardPaste(target, 'g0', envelope)!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.view.graphs.outer).toEqual({ nodes: {} })
  })

  it('omits dangling definition net-view metadata instead of emitting an invalid envelope', () => {
    const source = nestedSubgraphDocument()
    ;(source as any).ext = {
      'dinkster.netViews': [{ graphId: 'outer', netId: 'removed', role: 'source', offset: { x: 20, y: -30 } }],
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    expect(envelope.definitions!.netViews).toBeUndefined()

    const target = document()
    const plan = planClipboardPaste(target, 'g0', envelope)!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.outer).toBeDefined()
  })

  it('keeps same-lineage paste linked to current definitions instead of cloning its snapshot', () => {
    const source = nestedSubgraphDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    ;(source.graphs.outer as { name: string }).name = 'Edited after copy'
    ;(source.view.graphs.outer!.nodes.nested as { position: { x: number; y: number } }).position = { x: 480, y: 320 }
    const plan = planClipboardPaste(source, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.keys(store.doc.graphs).sort()).toEqual(['g0', 'inner', 'outer'])
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.type).toBe('#outer')
    expect(store.doc.graphs.outer!.name).toBe('Edited after copy')
    expect(store.doc.view.graphs.outer!.nodes.nested!.position).toEqual({ x: 480, y: 320 })
  })

  it('drops only stale copied occurrence topology when same-lineage definitions changed after copy', () => {
    const source = nestedSubgraphDocument()
    ;(source.graphs.g0!.nodes as Record<string, any>).innerInstance = { id: 'innerInstance', type: '#inner', values: {} }
    ;(source.view.graphs.g0!.nodes as Record<string, any>).innerInstance = { position: { x: 400, y: 100 } }
    ;(source as any).occurrenceTopologies = {
      instance: {
        owner: { instancePath: [], node: 'instance' },
        bodyGraph: 'outer',
        nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: {
              kind: 'boundary',
              occurrence: { instancePath: [], node: 'instance' },
              address: { port: 'result' },
              route: [{ graph: 'outer', boundaryId: 'result', binding: { kind: 'port', node: 'nested', port: 'result' } }],
            },
            to: { kind: 'body', endpoint: { node: 'nested', port: 'source' } },
          },
        },
      },
      innerInstance: {
        owner: { instancePath: [], node: 'innerInstance' },
        bodyGraph: 'inner',
        nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: {
              kind: 'boundary',
              occurrence: { instancePath: [], node: 'innerInstance' },
              address: { port: 'result' },
              route: [{ graph: 'inner', boundaryId: 'result', binding: { kind: 'port', node: 'pass', port: 'result' } }],
            },
            to: { kind: 'body', endpoint: { node: 'pass', port: 'value' } },
          },
        },
      },
    }
    const envelope = JSON.parse(JSON.stringify(
      serializeSelection(source, 'g0', { nodes: ['instance', 'innerInstance'], reroutes: [] })!,
    )) as DinksterClipboardEnvelope
    expect(envelope.occurrenceTopologies).toHaveLength(2)
    expect(planClipboardPaste(source, 'g0', envelope)).toBeDefined()
    delete (source as any).occurrenceTopologies
    ;(source.graphs.outer!.boundary as any).outputs = []

    const plan = planClipboardPaste(source, 'g0', envelope)!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.keys(store.doc.graphs)).toEqual(['g0', 'outer', 'inner'])
    expect(Object.values(store.doc.occurrenceTopologies ?? {})).toHaveLength(1)
    expect(Object.values(store.doc.occurrenceTopologies ?? {})[0]!.bodyGraph).toBe('inner')
  })

  it('deterministically remaps colliding definition ids and their nested references', () => {
    const source = nestedSubgraphDocument()
    ;(source.graphs.outer!.nodes as Record<string, any>).sink = { id: 'sink', type: 'Pass', values: {} }
    ;(source.graphs.outer!.nets as Record<string, any>).flow = {
      id: 'flow', name: 'flow', source: { node: 'nested', port: 'result' },
      sinks: [{ node: 'sink', port: 'value' }],
    }
    ;(source.view.graphs.outer!.nodes as Record<string, any>).sink = { position: { x: 500, y: 200 } }
    ;(source as any).ext = {
      'dinkster.netViews': [{ graphId: 'outer', netId: 'flow', role: 'source', offset: { x: 20, y: -30 } }],
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    expect(envelope.definitions!.netViews).toEqual([
      { graphId: 'outer', netId: 'flow', role: 'source', offset: { x: 20, y: -30 } },
    ])
    const target = document()
    ;(target.graphs as Record<string, any>).inner = {
      id: 'inner', name: 'Conflicting Inner', nextOrdinal: 0, nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] },
    }
    ;(target.graphs as Record<string, any>).outer = {
      id: 'outer', name: 'Conflicting Outer', nextOrdinal: 0, nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] },
    }
    ;(target.view.graphs as Record<string, any>).inner = { nodes: {} }
    ;(target.view.graphs as Record<string, any>).outer = { nodes: {} }
    const plan = planClipboardPaste(target, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.type).toBe('#g2')
    expect(store.doc.graphs.g2!.nodes.nested!.type).toBe('#g1')
    expect(store.doc.graphs.inner!.name).toBe('Conflicting Inner')
    expect(store.doc.graphs.outer!.name).toBe('Conflicting Outer')
    expect(store.doc.ext?.['dinkster.netViews']).toContainEqual(
      { graphId: 'g2', netId: 'flow', role: 'source', offset: { x: 20, y: -30 } },
    )
  })

  it('remaps definition-owned projected net suppressions with the copied closure', () => {
    const source = nestedSubgraphDocument()
    ;(source.graphs.inner!.nodes as Record<string, any>).secondary = { id: 'secondary', type: 'Pass', values: {} }
    ;(source.graphs.inner!.boundary!.inputs[0] as any).alsoBinds = [
      { kind: 'port', node: 'secondary', port: 'value' },
    ]
    ;(source.graphs.outer!.nodes as Record<string, any>).producer = { id: 'producer', type: 'Pass', values: {} }
    ;(source.graphs.outer!.nodes as Record<string, any>).consumer = { id: 'consumer', type: 'Pass', values: {} }
    ;(source.graphs.outer!.nets as Record<string, any>).delivery = {
      id: 'delivery', name: 'delivery', source: { node: 'producer', port: 'result' },
      sinks: [{ node: 'nested', port: 'value' }],
    }
    ;(source.graphs.outer!.nets as Record<string, any>).sourceDelivery = {
      id: 'sourceDelivery', name: 'sourceDelivery', source: { node: 'nested', port: 'result' },
      sinks: [{ node: 'consumer', port: 'value' }],
    }
    ;(source as any).occurrenceTopologies = {
      'instance.nested': {
        owner: { instancePath: ['instance'], node: 'nested' }, bodyGraph: 'inner', nextOrdinal: 0, links: {},
        suppressedDeliveries: [{
          kind: 'projectedLeg',
          delivery: { kind: 'netSink', graph: 'outer', netId: 'delivery', to: { node: 'nested', port: 'value' } },
          route: [{ graph: 'inner', boundaryId: 'value', binding: { kind: 'port', node: 'secondary', port: 'value' } }],
        }, {
          kind: 'projectedLeg',
          delivery: { kind: 'netSink', graph: 'outer', netId: 'sourceDelivery', to: { node: 'consumer', port: 'value' } },
          route: [{ graph: 'inner', boundaryId: 'result', binding: { kind: 'port', node: 'pass', port: 'result' } }],
        }],
      },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['instance'], reroutes: [] })!
    const target = document()
    ;(target.graphs as Record<string, any>).inner = {
      id: 'inner', name: 'Conflicting Inner', nextOrdinal: 0, nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] },
    }
    ;(target.graphs as Record<string, any>).outer = {
      id: 'outer', name: 'Conflicting Outer', nextOrdinal: 0, nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] },
    }
    ;(target.view.graphs as Record<string, any>).inner = { nodes: {} }
    ;(target.view.graphs as Record<string, any>).outer = { nodes: {} }
    const plan = planClipboardPaste(target, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    const topology = Object.values(store.doc.occurrenceTopologies ?? {})[0]
    expect(topology?.bodyGraph).toBe('g1')
    expect(topology?.suppressedDeliveries?.[0]).toMatchObject({
      delivery: { kind: 'netSink', graph: 'g2', netId: 'delivery' },
      route: [{ graph: 'g1' }],
    })
    expect(topology?.suppressedDeliveries?.[1]).toMatchObject({
      delivery: { kind: 'netSink', graph: 'g2', netId: 'sourceDelivery' },
      route: [{ graph: 'g1' }],
    })
  })

  it('rejects missing, extra, and malformed definition closure records', () => {
    const envelope = serializeSelection(nestedSubgraphDocument(), 'g0', { nodes: ['instance'], reroutes: [] })!
    const missing = structuredClone(envelope) as any
    delete missing.definitions.graphs.inner
    delete missing.definitions.view.inner
    expect(planClipboardPaste(document(), 'g0', missing)).toBeUndefined()

    const extra = structuredClone(envelope) as any
    extra.definitions.graphs.extra = { id: 'extra', name: 'Extra', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 }
    extra.definitions.view.extra = { nodes: {} }
    expect(planClipboardPaste(document(), 'g0', extra)).toBeUndefined()

    const malformed = structuredClone(envelope) as any
    malformed.definitions.view.outer = { nodes: { nested: { position: { x: 'bad', y: 0 } } } }
    expect(planClipboardPaste(document(), 'g0', malformed)).toBeUndefined()

    const recursive = structuredClone(envelope) as any
    recursive.definitions.graphs.inner.nodes.pass.type = '#outer'
    expect(planClipboardPaste(document(), 'g0', recursive)).toBeUndefined()

    const prototypeKey = structuredClone(envelope) as any
    Object.defineProperty(prototypeKey.definitions.view, '__proto__', {
      value: { nodes: {} },
      enumerable: true,
    })
    expect(planClipboardPaste(document(), 'g0', prototypeKey)).toBeUndefined()

    const occurrenceSource = document()
    ;(occurrenceSource.graphs as Record<string, any>).body = {
      id: 'body', name: 'Body', nextOrdinal: 0,
      nodes: {
        source: { id: 'source', type: 'Source', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: {}, nets: {}, reroutes: {},
      boundary: {
        inputs: [{ id: 'in', binds: { kind: 'port', node: 'sink', port: 'in' } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'source', port: 'out' } }],
      },
    }
    ;(occurrenceSource.view.graphs as Record<string, any>).body = {
      nodes: { source: { position: { x: 0, y: 0 } }, sink: { position: { x: 200, y: 0 } } },
    }
    ;(occurrenceSource.graphs.g0!.nodes as Record<string, any>).a.type = '#body'
    ;(occurrenceSource as any).occurrenceTopologies = { a: {
      owner: { instancePath: [], node: 'a' }, bodyGraph: 'body', nextOrdinal: 1,
      links: { l0: {
        id: 'l0',
        from: { kind: 'boundary', occurrence: { instancePath: [], node: 'a' }, address: { port: 'out' }, route: [{ graph: 'body', boundaryId: 'out', binding: { kind: 'port', node: 'source', port: 'out' } }] },
        to: { kind: 'body', endpoint: { node: 'sink', port: 'in' } },
      } },
      suppressedDeliveries: [{ kind: 'projectedLeg', delivery: { kind: 'link', graph: 'g0', linkId: 'l' }, route: [{ graph: 'body', boundaryId: 'in', binding: { kind: 'port', node: 'sink', port: 'in' } }] }],
    } }
    ;(occurrenceSource.graphs.g0!.links as Record<string, any>).l = {
      id: 'l', from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' },
    }
    const occurrenceEnvelope = serializeSelection(occurrenceSource, 'g0', { nodes: ['a', 'b'], reroutes: [] })!
    expect(planClipboardPaste(document(), 'g0', occurrenceEnvelope)).toBeDefined()
    for (const mutate of [
      (changed: any) => { changed.occurrenceTopologies[0].bodyGraph = 'unrelated' },
      (changed: any) => { changed.occurrenceTopologies[0].links.l0.from.route[0].graph = 'unrelated' },
      (changed: any) => { changed.occurrenceTopologies[0].links.l0.from.route = [] },
      (changed: any) => { changed.occurrenceTopologies[0].suppressedDeliveries[0].delivery.graph = 'unrelated' },
      (changed: any) => { changed.occurrenceTopologies[0].suppressedDeliveries[0].route = [] },
    ]) {
      const changed = structuredClone(occurrenceEnvelope) as any
      mutate(changed)
      expect(planClipboardPaste(document(), 'g0', changed)).toBeUndefined()
    }
  })

  it('rejects a deeply recursive definition payload without overflowing the call stack', () => {
    const envelope = serializeSelection(nestedSubgraphDocument(), 'g0', { nodes: ['instance'], reroutes: [] })! as any
    envelope.nodes[0].data.type = '#d0'
    envelope.definitions = { graphs: {}, view: {} }
    const count = 5_000
    for (let index = 0; index < count; index++) {
      const id = `d${index}`
      envelope.definitions.graphs[id] = {
        id,
        name: id,
        nodes: { child: { id: 'child', type: `#d${index + 1 === count ? 0 : index + 1}`, values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      }
      envelope.definitions.view[id] = { nodes: { child: { position: { x: 0, y: 0 } } } }
    }
    expect(() => planClipboardPaste(document(), 'g0', envelope)).not.toThrow()
    expect(planClipboardPaste(document(), 'g0', envelope)).toBeUndefined()
  })

  it('round-trips values and topology with fresh ids, drops partial links, and undoes atomically', () => {
    const source = document()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    expect(envelope.links).toHaveLength(2)
    const plan = planClipboardPaste(source, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(plan.nodeIds).toEqual(['n10', 'n11'])
    expect(plan.rerouteIds).toEqual(['r12'])
    expect(store.doc.graphs.g0!.nodes.n10!.values).toEqual({ seed: 7 })
    expect(store.doc.graphs.g0!.nodes.n11!.type).toBe('UnknownOnAnotherBackend')
    expect(store.doc.view.graphs.g0!.nodes.n10!.position).toEqual({ x: 20, y: 30 })
    expect(Object.keys(store.doc.graphs.g0!.links)).toHaveLength(5)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n10).toBeUndefined()
    expect(store.doc.graphs.g0!.reroutes.r12).toBeUndefined()
  })

  it('round-trips a count value and its exact dynamic output member links through copy, paste, and undo', () => {
    const source = document()
    ;(source.graphs.g0!.nodes.a as { type: string; values: Record<string, unknown> }).type = 'CountedOutput'
    ;(source.graphs.g0!.nodes.a as { type: string; values: Record<string, unknown> }).values = { count: 3 }
    ;(source.graphs.g0!.links.into!.from as unknown as { port: string; members?: string[] }).port = 'results'
    ;(source.graphs.g0!.links.into!.from as unknown as { port: string; members?: string[] }).members = ['2']
    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const plan = planClipboardPaste(source, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(source, coreCommandRegistry())

    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.values).toEqual({ count: 3 })
    const pastedMemberLink = Object.values(store.doc.graphs.g0!.links).find((link) =>
      'node' in link.from && link.from.node === plan.nodeIds[0])
    expect(pastedMemberLink?.from).toEqual({
      node: plan.nodeIds[0],
      port: 'results',
      members: ['2'],
    })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.values).toEqual({ count: 3 })
  })

  it('copies a closed occurrence topology subtree with fresh owner and link ids', () => {
    const source = document()
    ;(source.graphs as Record<string, any>).body = {
      id: 'body', name: 'Body', nextOrdinal: 0,
      nodes: {
        producer: { id: 'producer', type: 'Producer', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: {
        shared: { id: 'shared', from: { node: 'producer', port: 'out' }, to: { node: 'sink', port: 'in' } },
      },
      nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] },
    }
    ;(source.view.graphs as Record<string, any>).body = { nodes: {} }
    ;(source.graphs.g0!.nodes as Record<string, any>).a.type = '#body'
    ;(source as any).occurrenceTopologies = {
      a: {
        owner: { instancePath: [], node: 'a' }, bodyGraph: 'body', nextOrdinal: 8,
        links: {
          l7: {
            id: 'l7',
            from: { kind: 'body', endpoint: { node: 'producer', port: 'out' } },
            to: { kind: 'body', endpoint: { node: 'sink', port: 'in' } },
          },
        },
        suppressedDeliveries: [{ kind: 'link', linkId: 'shared' }],
      },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const plan = planClipboardPaste(source, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    const pasted = plan.nodeIds[0]!
    expect(store.doc.occurrenceTopologies?.[pasted]).toMatchObject({
      owner: { instancePath: [], node: pasted },
      bodyGraph: 'body',
      links: {
        l0: {
          id: 'l0',
          from: { kind: 'body', endpoint: { node: 'producer', port: 'out' } },
          to: { kind: 'body', endpoint: { node: 'sink', port: 'in' } },
        },
      },
      suppressedDeliveries: [{ kind: 'link', linkId: 'shared' }],
      nextOrdinal: 1,
    })
    expect(store.doc.occurrenceTopologies?.a?.links.l7).toBeDefined()
    expect(store.undo()).toBe(true)
    expect(store.doc.occurrenceTopologies?.[pasted]).toBeUndefined()
    expect(store.doc.occurrenceTopologies?.a?.links.l7).toBeDefined()
  })

  it('does not copy occurrence topology when the selected body node is not its owner', () => {
    const source = document()
    ;(source as any).occurrenceTopologies = {
      owner: {
        owner: { instancePath: [], node: 'owner' }, bodyGraph: 'g0', nextOrdinal: 1,
        links: {},
      },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    expect((envelope as any).occurrenceTopologies ?? []).toEqual([])
  })

  it('does not copy a root overlay from a body graph node with the same id', () => {
    const source = document()
    ;(source.graphs as Record<string, any>).body = {
      id: 'body', name: 'Body', nextOrdinal: 0,
      nodes: { a: { id: 'a', type: 'Thing', values: {} } },
      links: {}, nets: {}, reroutes: {},
    }
    ;(source.view.graphs as Record<string, any>).body = { nodes: { a: { x: 0, y: 0 } } }
    ;(source as any).occurrenceTopologies = {
      a: { owner: { instancePath: [], node: 'a' }, bodyGraph: 'g0', links: {}, nextOrdinal: 1 },
    }
    const envelope = serializeSelection(source, 'body', { nodes: ['a'], reroutes: [] })!
    expect(envelope.version).toBe(2)
    expect(envelope.occurrenceTopologies).toBeUndefined()
  })

  it('CO7: the paste planner counts EVERY allocation and fails at the id-space ceiling', () => {
    const source = document()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    // Materialization allocates 5 ids: 2 nodes + 1 reroute + 2 retained
    // links (the partial link's endpoint is outside the copy and is
    // dropped). The planner must agree with materialize, so the last
    // plannable window is MAX-5 and MAX-4 is unplannable.
    const MAX = Number.MAX_SAFE_INTEGER
    const exhausted = document()
    ;(exhausted.graphs.g0 as { nextOrdinal: number }).nextOrdinal = MAX - 4
    expect(planClipboardPaste(exhausted, 'g0', envelope, { x: 0, y: 0 })).toBeUndefined()
    const nearMax = document()
    ;(nearMax.graphs.g0 as { nextOrdinal: number }).nextOrdinal = MAX - 5
    const plan = planClipboardPaste(nearMax, 'g0', envelope, { x: 0, y: 0 })
    expect(plan).toBeDefined()
    expect(plan!.nodeIds).toEqual([`n${MAX - 5}`, `n${MAX - 4}`])
    expect(plan!.rerouteIds).toEqual([`r${MAX - 3}`])
    // A plan that came back defined must actually dispatch (planner and
    // materialize agree at the boundary).
    const store = new DocumentStore(nearMax, coreCommandRegistry())
    expect(store.dispatch(plan!.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(MAX)
  })

  it('excludes boundary pseudonode selection and copies nothing when no real item remains', () => {
    expect(serializeSelection(document(), 'g0', { nodes: ['@boundary:inputs'], reroutes: [] })).toBeUndefined()
  })

  it('drops links whose endpoint is not present in a foreign document paste', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const damaged = { ...envelope, nodes: envelope.nodes.slice(0, 1) }
    const plan = planClipboardPaste(document(), 'g0', damaged)!
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.keys(store.doc.graphs.g0!.links)).toHaveLength(4)
  })

  it('rejects a malformed record anywhere in the envelope atomically', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const malformed = { ...envelope, nodes: [envelope.nodes[0], { data: { id: 'bad' }, view: {} }, envelope.nodes[1]] }
    const store = new DocumentStore(document(), coreCommandRegistry())
    const before = store.doc
    const outcome = store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: malformed, offset: { x: 20, y: 20 } } as never,
    })
    expect(outcome.ok).toBe(false)
    expect(store.doc).toBe(before)
    expect(store.revision).toBe(0)
  })

  it('rejects duplicate source node ids instead of silently rewiring links', () => {
    // Two records sharing an id would both paste, with every link naming
    // that id reattached to the LAST record - topology corruption, so the
    // envelope is rejected outright.
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const dup = { ...envelope, nodes: [envelope.nodes[0]!, envelope.nodes[0]!] }
    expect(planClipboardPaste(document(), 'g0', dup, { x: 0, y: 0 })).toBeUndefined()
    const store = new DocumentStore(document(), coreCommandRegistry())
    const outcome = store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: dup, offset: { x: 0, y: 0 } } as never,
    })
    expect(outcome.ok).toBe(false)
    expect(store.revision).toBe(0)
  })

  it('rejects duplicate source reroute ids', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const dup = { ...envelope, reroutes: [envelope.reroutes[0]!, envelope.reroutes[0]!] }
    expect(planClipboardPaste(document(), 'g0', dup, { x: 0, y: 0 })).toBeUndefined()
  })

  it('rejects duplicate source link ids in a v3 envelope with a projected suppression', () => {
    // Duplicate link ids would make the projectedLeg suppression remap
    // ambiguous (the later record silently wins the linkMap entry), so
    // the envelope is rejected outright.
    const source = document()
    ;(source.graphs as Record<string, any>).body = {
      id: 'body', name: 'Body', nextOrdinal: 0,
      nodes: {
        producer: { id: 'producer', type: 'Producer', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: {}, nets: {}, reroutes: {},
      boundary: {
        inputs: [{ id: 'in', binds: { kind: 'port', node: 'sink', port: 'in' } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'producer', port: 'out' } }],
      },
    }
    ;(source.view.graphs as Record<string, any>).body = { nodes: {} }
    ;(source.graphs.g0!.nodes as Record<string, any>).a.type = '#body'
    ;(source as any).occurrenceTopologies = {
      a: {
        owner: { instancePath: [], node: 'a' }, bodyGraph: 'body', nextOrdinal: 0, links: {},
        suppressedDeliveries: [{
          kind: 'projectedLeg',
          delivery: { kind: 'link', graph: 'g0', linkId: 'into' },
          route: [{ graph: 'body', boundaryId: 'out', binding: { kind: 'port', node: 'producer', port: 'out' } }],
        }],
      },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    expect(envelope.version).toBe(5)
    expect(planClipboardPaste(source, 'g0', envelope, { x: 0, y: 0 })).toBeDefined()
    const dup = { ...envelope, links: [...envelope.links, envelope.links[0]!] }
    expect(planClipboardPaste(source, 'g0', dup, { x: 0, y: 0 })).toBeUndefined()
    const store = new DocumentStore(source, coreCommandRegistry())
    const outcome = store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: dup, offset: { x: 0, y: 0 } } as never,
    })
    expect(outcome.ok).toBe(false)
    expect(store.revision).toBe(0)
  })

  it('rejects duplicate occurrence topology owners in a v3 envelope', () => {
    const source = document()
    ;(source.graphs as Record<string, any>).body = {
      id: 'body', name: 'Body', nextOrdinal: 0,
      nodes: {}, links: {}, nets: {}, reroutes: {},
      boundary: { inputs: [], outputs: [] },
    }
    ;(source.view.graphs as Record<string, any>).body = { nodes: {} }
    ;(source.graphs.g0!.nodes as Record<string, any>).a.type = '#body'
    ;(source as any).occurrenceTopologies = {
      a: {
        owner: { instancePath: [], node: 'a' }, bodyGraph: 'body', nextOrdinal: 0, links: {},
      },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const duplicate = {
      ...envelope,
      occurrenceTopologies: [...envelope.occurrenceTopologies!, envelope.occurrenceTopologies![0]!],
    }
    expect(planClipboardPaste(source, 'g0', duplicate, { x: 0, y: 0 })).toBeUndefined()
    const store = new DocumentStore(source, coreCommandRegistry())
    const before = store.doc
    const outcome = store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: duplicate, offset: { x: 0, y: 0 } } as never,
    })
    expect(outcome.ok).toBe(false)
    expect(store.revision).toBe(0)
    expect(store.doc).toBe(before)
  })

  it('refuses every v3 occurrence topology closure violation by name', () => {
    const source = document()
    ;(source.graphs as Record<string, any>).body = {
      id: 'body', name: 'Body', nextOrdinal: 0,
      nodes: {
        producer: { id: 'producer', type: 'Producer', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: {}, nets: {}, reroutes: {},
      boundary: { inputs: [{ id: 'in', binds: { kind: 'port', node: 'sink', port: 'in' } }], outputs: [] },
    }
    ;(source.view.graphs as Record<string, any>).body = { nodes: { producer: {}, sink: {} } }
    ;(source.graphs.g0!.nodes as Record<string, any>).a.type = '#body'
    ;(source as any).occurrenceTopologies = {
      a: {
        owner: { instancePath: [], node: 'a' }, bodyGraph: 'body', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: { kind: 'body', endpoint: { node: 'producer', port: 'out' } },
            to: { kind: 'body', endpoint: { node: 'sink', port: 'in' } },
          },
        },
      },
    }
    const envelope = structuredClone(serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!) as any
    envelope.version = 3
    delete envelope.definitions

    const dispatch = (graphId: string, changed: DinksterClipboardEnvelope) => {
      const store = new DocumentStore(source, coreCommandRegistry())
      const before = store.doc
      const outcome = store.dispatch({
        command: 'clipboard.paste',
        params: { graphId, envelope: changed, offset: { x: 0, y: 0 } } as never,
      })
      expect(outcome.ok).toBe(false)
      expect(store.doc).toBe(before)
      return outcome.diagnostics[0]!.code
    }

    expect(dispatch('body', envelope)).toBe('clipboard.occurrenceTopology.contextUnsupported')

    const ownerOutside = structuredClone(envelope) as any
    ownerOutside.occurrenceTopologies[0].owner.node = 'outside'
    expect(dispatch('g0', ownerOutside)).toBe('clipboard.occurrenceTopology.ownerOutsideCopy')

    const endpointOutside = structuredClone(envelope) as any
    endpointOutside.occurrenceTopologies[0].links.l0.from = {
      kind: 'boundary',
      occurrence: { instancePath: [], node: 'outside' },
      address: { port: 'in' },
      route: [{ graph: 'body', boundaryId: 'in', binding: { kind: 'port', node: 'sink', port: 'in' } }],
    }
    expect(dispatch('g0', endpointOutside)).toBe('clipboard.occurrenceTopology.endpointOutsideCopy')

    const deliveryOutside = structuredClone(envelope) as any
    deliveryOutside.occurrenceTopologies[0].suppressedDeliveries = [{
      kind: 'projectedLeg',
      delivery: { kind: 'link', graph: 'g0', linkId: 'missing' },
      route: [{ graph: 'body', boundaryId: 'in', binding: { kind: 'port', node: 'sink', port: 'in' } }],
    }]
    expect(dispatch('g0', deliveryOutside)).toBe('clipboard.occurrenceTopology.deliveryOutsideCopy')
  })

  it('rejects records the document loader would reject: a paste can never commit an unloadable document', () => {
    // node.mode outside the loader's vocabulary: passes shallow field
    // checks (id/type/values/view present) but validateDocumentShape
    // rejects it - committing it would save a document that never loads.
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a'], reroutes: [] })!
    const record = envelope.nodes[0]!
    const bad = {
      ...envelope,
      nodes: [{ ...record, data: { ...(record.data as Record<string, unknown>), mode: 'invalid' } }],
    } as never
    expect(planClipboardPaste(document(), 'g0', bad, { x: 0, y: 0 })).toBeUndefined()
    const store = new DocumentStore(document(), coreCommandRegistry())
    const outcome = store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: bad, offset: { x: 0, y: 0 } } as never,
    })
    expect(outcome.ok).toBe(false)
    expect(store.revision).toBe(0)
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(10)
  })

  it('rejects malformed dynamic state in a pasted node', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a'], reroutes: [] })!
    const record = envelope.nodes[0]!
    const bad = {
      ...envelope,
      nodes: [{
        ...record,
        data: { ...(record.data as Record<string, unknown>), dynamic: { port: { seq: -1, members: 'nope' } } },
      }],
    } as never
    expect(planClipboardPaste(document(), 'g0', bad, { x: 0, y: 0 })).toBeUndefined()
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: bad, offset: { x: 0, y: 0 } } as never,
    }).ok).toBe(false)
    expect(store.revision).toBe(0)
  })

  it('a non-finite anchor yields no plan instead of an undispatchable one', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a'], reroutes: [] })!
    expect(planClipboardPaste(document(), 'g0', envelope, { x: Number.NaN, y: 0 })).toBeUndefined()
    expect(planClipboardPaste(document(), 'g0', envelope, { x: 0, y: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  it('finite inputs that overflow the offset or any translated coordinate yield no plan', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a'], reroutes: [] })!
    const record = envelope.nodes[0]!
    // dx = anchor.x - minX = MAX_VALUE - (-MAX_VALUE) = Infinity, from two
    // individually finite numbers.
    const farLeft = {
      ...envelope,
      nodes: [{ ...record, view: { position: { x: -Number.MAX_VALUE, y: 0 } } }],
    } as never
    expect(planClipboardPaste(document(), 'g0', farLeft, { x: Number.MAX_VALUE, y: 0 })).toBeUndefined()

    // Finite dx (MAX_VALUE - 0), but the OTHER record's translated x
    // overflows: MAX_VALUE + MAX_VALUE = Infinity.
    const two = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: [] })!
    const spread = {
      ...two,
      nodes: [
        { ...two.nodes[0]!, view: { position: { x: 0, y: 0 } } },
        { ...two.nodes[1]!, view: { position: { x: Number.MAX_VALUE, y: 0 } } },
      ],
    } as never
    expect(planClipboardPaste(document(), 'g0', spread, { x: Number.MAX_VALUE, y: 0 })).toBeUndefined()
  })

  it('keeps valid paste behavior after record normalization', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const plan = planClipboardPaste(document(), 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(document(), coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(plan.nodeIds).toEqual(['n10', 'n11'])
    expect(plan.rerouteIds).toEqual(['r12'])
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(15)
  })

  it('FR1 pasted groups mint from the group cursor, never onto a live or removed group id', () => {
    // The groups namespace has its OWN cursor (groupSeq): view.createGroup
    // does not consume nextOrdinal, so the two cursors move independently.
    // Here nextOrdinal is 10 and grp10 is a LIVE group (groupSeq 11, e.g.
    // after creates/removes) - a nextOrdinal-minted paste id would be grp10
    // and tx.set would silently overwrite the live group.
    const source = document()
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groups = {
      grp10: { id: 'grp10', title: 'live', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    }
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groupSeq = 11
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [], groups: ['grp10'] })!
    expect(envelope.groups).toHaveLength(1)
    const plan = planClipboardPaste(source, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    const groups = store.doc.view.graphs.g0!.groups!
    expect(groups.grp10!.title).toBe('live') // untouched
    expect(groups.grp11).toBeDefined() // fresh id from the group cursor
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(12)
    // Undo restores the pre-paste groups but never rewinds the cursor
    // (allocation-monotonic replay) - a re-paste cannot remint grp11.
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp11).toBeUndefined()
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(12)
  })

  it('FR1 a pre-cursor document still floors pasted group ids on live keys', () => {
    const source = document()
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groups = {
      grp3: { id: 'grp3', title: 'live', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [], groups: ['grp3'] })!
    const store = new DocumentStore(source, coreCommandRegistry())
    const plan = planClipboardPaste(source, 'g0', envelope, { x: 20, y: 30 })!
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!).sort()).toEqual(['grp3', 'grp4'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(5)
  })

  it('FR1 a broken mode-panel binding floors pasted group ids in a pre-cursor document', () => {
    // The target document has NO live groups and NO cursor - only a durable
    // binding to removed grp5. Pasting a group must not remint grp5 (that
    // would silently repair the binding onto the pasted group).
    const source = document()
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groups = {
      grp0: { id: 'grp0', title: 'copied', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [], groups: ['grp0'] })!
    const target = document()
    ;(target as unknown as Record<string, unknown>).surfaces = {
      s0: {
        id: 's0',
        type: 'core.modePanel',
        config: { bindings: [{ kind: 'group', graphId: 'g0', groupId: 'grp5' }] },
      },
    }
    const plan = planClipboardPaste(target, 'g0', envelope, { x: 20, y: 30 })!
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp6'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(7)
  })

  it('FR1 non-canonical binding evidence never advances or exhausts the paste floor', () => {
    // A malformed binding near the ceiling ('grp0<huge>' has a leading
    // zero, so it is not an allocator-produced id and can never collide
    // with a minted one). It must contribute NOTHING - above all it must
    // not exhaust paste for the whole graph.
    const source = document()
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groups = {
      grp0: { id: 'grp0', title: 'copied', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [], groups: ['grp0'] })!
    const target = document()
    ;(target as unknown as Record<string, unknown>).surfaces = {
      s0: {
        id: 's0',
        type: 'core.modePanel',
        config: {
          bindings: [
            { kind: 'group', graphId: 'g0', groupId: 'grp00' },
            { kind: 'group', graphId: 'g0', groupId: 'grp09007199254740990' },
          ],
        },
      },
    }
    const plan = planClipboardPaste(target, 'g0', envelope, { x: 20, y: 30 })!
    expect(plan).toBeDefined() // not exhausted
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp0'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(1)
  })

  it('CO7/FR1: the planner refuses a group paste past the group-cursor ceiling', () => {
    const source = document()
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groups = {
      grp0: { id: 'grp0', title: 'live', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [], groups: ['grp0'] })!
    const exhausted = document()
    ;(exhausted.view.graphs.g0 as unknown as Record<string, unknown>).groupSeq = Number.MAX_SAFE_INTEGER
    expect(planClipboardPaste(exhausted, 'g0', envelope, { x: 0, y: 0 })).toBeUndefined()
    const nearMax = document()
    ;(nearMax.view.graphs.g0 as unknown as Record<string, unknown>).groupSeq = Number.MAX_SAFE_INTEGER - 1
    const plan = planClipboardPaste(nearMax, 'g0', envelope, { x: 0, y: 0 })
    expect(plan).toBeDefined()
    // A plan that came back defined must actually dispatch (planner and
    // materialize agree at the group boundary too).
    const store = new DocumentStore(nearMax, coreCommandRegistry())
    expect(store.dispatch(plan!.invocation).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.groups![`grp${Number.MAX_SAFE_INTEGER - 1}`]).toBeDefined()
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects malformed records instead of skipping them and shifting ids', () => {
    const envelope = serializeSelection(document(), 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const malformed = { ...envelope, nodes: [{ data: { id: 'bad' }, view: {} }, ...envelope.nodes] }
    expect(planClipboardPaste(document(), 'g0', malformed as never)).toBeUndefined()
    const store = new DocumentStore(document(), coreCommandRegistry())
    const outcome = store.dispatch({
      command: 'clipboard.paste',
      params: { graphId: 'g0', envelope: malformed, offset: { x: 20, y: 20 } } as never,
    })
    expect(outcome.ok).toBe(false)
    expect(store.doc.graphs.g0!.nodes.n10).toBeUndefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(10)
  })

  it('connected paste has incoming-only parity and leaves outgoing-only links detached', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['b'], reroutes: [] })!
    expect(envelope.version).toBe(2)
    expect(envelope.links).toEqual([])
    expect(envelope.externalIncoming).toHaveLength(2)
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    const pasted = plan.nodeIds[0]!
    const attached = Object.values(store.doc.graphs.g0!.links).filter((link) => 'node' in link.to && link.to.node === pasted)
    expect(attached.map((link) => 'node' in link.from ? link.from.node : '').sort()).toEqual(['a', 'other'])
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.from && link.from.node === pasted)).toBe(false)
  })

  it('connected paste preserves an external widget-tap source', () => {
    const source = connectedDocument()
    ;(source.graphs.g0!.nodes.upstream as { type: string; values: Record<string, unknown> }).type = 'TapWidget'
    ;(source.graphs.g0!.nodes.upstream as { type: string; values: Record<string, unknown> }).values = { amount: 2 }
    ;(source.graphs.g0!.links.incomingA as unknown as { from: unknown }).from = { node: 'upstream', tap: 'amount' }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    expect(envelope.externalIncoming).toEqual([{
      source: {
        graph: 'g0', lineage: 'lineage', node: 'upstream', nodeType: 'TapWidget', tap: 'amount',
      },
      target: { node: 'a', nodeType: 'Middle', port: 'in' },
    }])
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    const pasted = plan.nodeIds[0]!
    expect(Object.values(store.doc.graphs.g0!.links).some((link) =>
      'tap' in link.from && link.from.node === 'upstream' && link.from.tap === 'amount' &&
      'node' in link.to && link.to.node === pasted)).toBe(true)
  })

  it('connected paste preserves mixed internal and external links for a multi-node selection', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: [] })!
    expect(envelope.links).toHaveLength(1)
    expect(envelope.externalIncoming).toHaveLength(2)
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    const [a, b] = plan.nodeIds
    const newLinks = Object.values(store.doc.graphs.g0!.links).filter((link) =>
      ('node' in link.from && (link.from.node === a || link.from.node === b)) ||
      ('node' in link.to && (link.to.node === a || link.to.node === b)))
    expect(newLinks).toHaveLength(3)
    expect(newLinks.some((link) => 'node' in link.from && link.from.node === a && 'node' in link.to && link.to.node === b)).toBe(true)
  })

  it('connected paste skips one missing source while another valid incoming source still lands', () => {
    const copiedFrom = connectedDocument()
    const envelope = serializeSelection(copiedFrom, 'g0', { nodes: ['a', 'b'], reroutes: [] })!
    const current = connectedDocument()
    delete (current.graphs.g0!.nodes as Record<string, unknown>).upstream
    delete (current.graphs.g0!.links as Record<string, unknown>).incomingA
    const { store, plan } = connectedPaste(current, 'g0', envelope)
    const [a, b] = plan.nodeIds
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === a && 'node' in link.from && link.from.node === 'upstream')).toBe(false)
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === b && 'node' in link.from && link.from.node === 'other')).toBe(true)
  })

  it('connected repeated paste allocates fresh nodes and links every time', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const store = new DocumentStore(source, coreCommandRegistry())
    const first = planClipboardPaste(store.doc, 'g0', envelope, undefined, undefined, true)!
    expect(store.dispatch(first.invocation).ok).toBe(true)
    const second = planClipboardPaste(store.doc, 'g0', envelope, undefined, undefined, true)!
    expect(store.dispatch(second.invocation).ok).toBe(true)
    expect(second.nodeIds[0]).not.toBe(first.nodeIds[0])
    expect(new Set(Object.keys(store.doc.graphs.g0!.links)).size).toBe(Object.keys(store.doc.graphs.g0!.links).length)
  })

  it('connected paste keeps exact Autogrow member paths through final compaction without recycling ids', () => {
    const source = connectedDocument()
    const family = { items: { members: ['m0', 'm1'], seq: 2 } }
    ;(source.graphs.g0!.nodes.upstream as { dynamic?: unknown }).dynamic = family
    ;(source.graphs.g0!.nodes.a as { dynamic?: unknown }).dynamic = family
    ;(source.graphs.g0!.links.incomingA as unknown as { from: unknown; to: unknown }).from = { node: 'upstream', port: 'items.out', members: ['m1'] }
    ;(source.graphs.g0!.links.incomingA as unknown as { from: unknown; to: unknown }).to = { node: 'a', port: 'items.in', members: ['m1'] }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    const pasted = store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!
    expect(pasted.dynamic?.items?.members).toEqual(['m1'])
    expect(pasted.dynamic?.items?.seq).toBe(2)
    expect(Object.values(store.doc.graphs.g0!.links).some((link) =>
      'node' in link.to && 'port' in link.to && link.to.node === plan.nodeIds[0] && link.to.members?.[0] === 'm1' &&
      'node' in link.from && 'port' in link.from && link.from.members?.[0] === 'm1')).toBe(true)
    const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(reopened.document!.graphs.g0!.nodes[plan.nodeIds[0]!]!.dynamic?.items).toEqual({ members: ['m1'], seq: 2 })
  })

  it('connected paste is scoped to the exact root or drilled current graph', () => {
    const root = connectedDocument('root')
    const child = connectedDocument('child')
    const doc: WorkflowDocument = {
      ...root,
      graphs: { ...root.graphs, child: child.graphs.child! },
      view: { graphs: { ...root.view.graphs, child: child.view.graphs.child! } },
    }
    const rootEnvelope = serializeSelection(doc, 'root', { nodes: ['a'], reroutes: [] })!
    const childEnvelope = serializeSelection(doc, 'child', { nodes: ['b'], reroutes: [] })!
    expect(connectedPaste(doc, 'root', rootEnvelope).store.doc.graphs.root!.nodes.n20).toBeDefined()
    const childResult = connectedPaste(doc, 'child', childEnvelope)
    expect(childResult.store.doc.graphs.child!.nodes.n20).toBeDefined()
    expect(childResult.store.doc.graphs.root!.nodes.n20).toBeUndefined()
  })

  it('connected paste in a subgraph occurrence never resurrects a cross-boundary source', () => {
    const child = connectedDocument('child')
    const envelope = serializeSelection(child, 'child', { nodes: ['a'], reroutes: [] })!
    const crossGraph = {
      ...envelope,
      externalIncoming: envelope.externalIncoming!.map((stub) => ({ ...stub, source: { ...stub.source, graph: 'root' } })),
    }
    const { store, plan } = connectedPaste(child, 'child', crossGraph)
    expect(Object.values(store.doc.graphs.child!.links).some((link) => 'node' in link.to && link.to.node === plan.nodeIds[0])).toBe(false)
  })

  it('connected paste leaves region data, group identity freshness, and placement behavior unchanged', () => {
    const source = connectedDocument()
    ;(source.graphs as Record<string, unknown>).body = {
      id: 'body', name: 'body', nextOrdinal: 0, reroutes: {}, nets: {}, links: {},
      nodes: { inner: { id: 'inner', type: 'Inner', values: {} } },
      boundary: {
        inputs: [{ id: 'in', binds: { kind: 'port', node: 'inner', port: 'in' } }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'inner', port: 'result' } }],
      },
    }
    ;(source.view.graphs as Record<string, unknown>).body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    ;(source.graphs.g0!.nodes.a as unknown as Record<string, unknown>).type = '#body'
    ;(source.graphs.g0!.nodes.a as unknown as Record<string, unknown>).values = { in: [] }
    ;(source.graphs.g0!.nodes.a as unknown as Record<string, unknown>).region = { kind: 'map', elementPorts: ['in'] }
    ;(source.view.graphs.g0 as unknown as Record<string, unknown>).groups = {
      grp0: { id: 'grp0', title: 'Area', bounds: { x: 180, y: -20, width: 240, height: 160 } },
    }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [], groups: ['grp0'] })!
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    expect((store.doc.graphs.g0!.nodes[plan.nodeIds[0]!] as unknown as Record<string, unknown>).region).toEqual({ kind: 'map', elementPorts: ['in'] })
    expect(store.doc.view.graphs.g0!.nodes[plan.nodeIds[0]!]!.position).toEqual({ x: 20, y: 30 })
    expect(Object.keys(store.doc.view.graphs.g0!.groups!).sort()).toEqual(['grp0', 'grp1'])
  })

  it('connected pasted result exports and reopens with restored links', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(Object.values(reopened.document!.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === plan.nodeIds[0])).toBe(true)
  })

  it('connected paste is one-step undo and redo including restored incoming links', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const { store, plan } = connectedPaste(source, 'g0', envelope)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]).toBeDefined()
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === plan.nodeIds[0])).toBe(true)
  })

  it('ordinary paste compacts in one batch and ignores v2 external origins', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const plan = planClipboardPaste(source, 'g0', envelope)!
    expect(plan.invocation.command).toBe('batch')
    const invocations = (plan.invocation.params as {
      invocations: { command: string; params: Record<string, unknown> }[]
    }).invocations
    expect(invocations[0]!.command).toBe('clipboard.paste')
    expect(invocations[0]!.params.connectInputs).toBeUndefined()
    expect(invocations.at(-1)).toEqual({
      command: 'dynamic.compact',
      params: { graphId: 'g0', nodeId: plan.nodeIds[0] },
    })
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === plan.nodeIds[0])).toBe(false)

    const v1 = { ...envelope, version: 1, externalIncoming: undefined } as unknown as DinksterClipboardEnvelope
    expect(planClipboardPaste(source, 'g0', v1)).toBeDefined()
  })

  it('ordinary paste removes unused members without recycling their identity', () => {
    const source = connectedDocument()
    ;(source.graphs.g0!.nodes.a as { dynamic?: unknown }).dynamic = { images: { members: ['m3'], seq: 4 } }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const plan = planClipboardPaste(source, 'g0', envelope)!
    const pastedId = plan.nodeIds[0]!
    const store = new DocumentStore(source, coreCommandRegistry())

    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes[pastedId]!.dynamic).toEqual({ images: { seq: 4 } })
    expect(source.graphs.g0!.nodes.a!.dynamic).toEqual({ images: { members: ['m3'], seq: 4 } })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[pastedId]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[pastedId]!.dynamic).toEqual({ images: { seq: 4 } })
  })

  it('ordinary paste compacts dynamic inputs and outputs against pasted topology', () => {
    const source = document()
    ;(source.graphs.g0!.nodes.a as { dynamic?: unknown }).dynamic = {
      results: { members: ['m1', 'm4'], seq: 5 },
    }
    ;(source.graphs.g0!.nodes.b as { dynamic?: unknown }).dynamic = {
      values: { members: ['m2', 'm5'], seq: 6 },
      results: { members: ['m3', 'm7'], seq: 8 },
    }
    ;(source.graphs.g0!.links.into!.from as unknown as { port: string; members?: string[] }).port = 'results.out'
    ;(source.graphs.g0!.links.into!.from as unknown as { port: string; members?: string[] }).members = ['m4']
    ;(source.graphs.g0!.links.out!.to as unknown as { port: string; members?: string[] }).port = 'values.in'
    ;(source.graphs.g0!.links.out!.to as unknown as { port: string; members?: string[] }).members = ['m5']
    ;(source.graphs.g0!.links.partial!.from as unknown as { port: string; members?: string[] }).port = 'results.out'
    ;(source.graphs.g0!.links.partial!.from as unknown as { port: string; members?: string[] }).members = ['m7']

    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: ['r'] })!
    const plan = planClipboardPaste(source, 'g0', envelope)!
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[0]!]!.dynamic).toEqual({
      results: { members: ['m4'], seq: 5 },
    })
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[1]!]!.dynamic).toEqual({
      values: { members: ['m5'], seq: 6 },
      results: { seq: 8 },
    })
    expect(store.undo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes[plan.nodeIds[1]!]!.dynamic?.results).toEqual({ seq: 8 })
  })

  it('connected paste uses the shared actor cursor for pasted ids and final compaction', () => {
    const source = connectedDocument()
    ;(source.graphs.g0 as unknown as Record<string, unknown>).actorCursors = { alice: 5 }
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const plan = planClipboardPaste(source, 'g0', envelope, undefined, 'alice', true)!
    expect(plan.nodeIds).toEqual(['n5-alice'])
    const store = new DocumentStore(source, coreCommandRegistry())
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes['n5-alice']).toBeDefined()
  })

  it('connected paste skips member-bearing opaque endpoints instead of resurrecting members', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a'], reroutes: [] })!
    const stale = {
      ...envelope,
      externalIncoming: envelope.externalIncoming!.map((stub) => ({
        ...stub,
        source: 'tap' in stub.source ? stub.source : { ...stub.source, members: ['m1'] },
      })),
    }
    const { store, plan } = connectedPaste(source, 'g0', stale)
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === plan.nodeIds[0])).toBe(false)
  })

  it('connected paste skips same-id sources from another document lineage', () => {
    const copiedFrom = connectedDocument()
    const envelope = serializeSelection(copiedFrom, 'g0', { nodes: ['a'], reroutes: [] })!
    const current = connectedDocument()
    ;(current as unknown as Record<string, unknown>).lineage = 'another-lineage'
    const { store, plan } = connectedPaste(current, 'g0', envelope)
    expect(Object.values(store.doc.graphs.g0!.links).some((link) => 'node' in link.to && link.to.node === plan.nodeIds[0])).toBe(false)
  })

  it('connected paste skips an external stub whose target is occupied by an internal link', () => {
    const source = connectedDocument()
    const envelope = serializeSelection(source, 'g0', { nodes: ['a', 'b'], reroutes: [] })!
    const conflicting = {
      ...envelope,
      externalIncoming: envelope.externalIncoming!.map((stub, index) => index === 0 ? stub : {
        ...stub, target: { ...stub.target, port: 'in' },
      }),
    }
    const { store, plan } = connectedPaste(source, 'g0', conflicting)
    const [a, b] = plan.nodeIds
    expect(Object.values(store.doc.graphs.g0!.links).some((link) =>
      'node' in link.from && link.from.node === a && 'node' in link.to && link.to.node === b)).toBe(true)
    expect(Object.values(store.doc.graphs.g0!.links).filter((link) =>
      'node' in link.to && link.to.node === b && 'port' in link.to && link.to.port === 'in')).toHaveLength(1)
  })
})

describe('clipboard named nets (version 4)', () => {
  const netDocument = (): WorkflowDocument => ({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'g0' as never,
    graphs: { g0: {
      id: 'g0' as never, name: 'root', nextOrdinal: 10,
      nodes: {
        p: { id: 'p' as never, type: 'Producer', values: {} },
        c1: { id: 'c1' as never, type: 'Consumer', values: {} },
        c2: { id: 'c2' as never, type: 'Consumer', values: {} },
        q: { id: 'q' as never, type: 'OtherProducer', values: {} },
      },
      reroutes: {}, links: {},
      nets: {
        net1: {
          id: 'net1' as never, name: 'Latents',
          source: { node: 'p' as never, port: 'out' as never },
          sinks: [{ node: 'c1' as never, port: 'in' as never }, { node: 'c2' as never, port: 'in' as never }],
        },
      },
    } },
    view: { graphs: { g0: { nodes: {
      p: { position: { x: 0, y: 0 } }, c1: { position: { x: 200, y: 0 } },
      c2: { position: { x: 200, y: 120 } }, q: { position: { x: 0, y: 120 } },
    } } } },
  })

  const paste = (doc: WorkflowDocument, envelope: DinksterClipboardEnvelope) => {
    const plan = planClipboardPaste(doc, 'g0', envelope, { x: 20, y: 30 })
    expect(plan).toBeDefined()
    const store = new DocumentStore(doc, coreCommandRegistry())
    expect(store.dispatch(plan!.invocation).ok).toBe(true)
    return { store, plan: plan! }
  }

  it('serializes membership at version 4 and merges a compatible sink-only paste into the existing net', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['c1'], reroutes: [] })!
    expect(envelope.version).toBe(4)
    expect(envelope.nets).toEqual([{
      name: 'Latents',
      source: { node: 'p', port: 'out', nodeType: 'Producer' },
      sinks: [{ node: 'c1', port: 'in' }],
    }])
    const { store } = paste(netDocument(), envelope)
    const graph = store.doc.graphs.g0!
    // Merged, not duplicated: still one net, one source, one extra sink.
    expect(Object.keys(graph.nets)).toEqual(['net1'])
    expect(graph.nets.net1!.source).toEqual({ node: 'p', port: 'out' })
    expect(graph.nets.net1!.sinks).toEqual([
      { node: 'c1', port: 'in' }, { node: 'c2', port: 'in' }, { node: 'n10', port: 'in' },
    ])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nets.net1!.sinks).toHaveLength(2)
    expect(store.doc.graphs.g0!.nodes.n10).toBeUndefined()
  })

  it('pastes a copied source as a new net under a deterministic non-conflicting name', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['p', 'c1'], reroutes: [] })!
    expect(envelope.version).toBe(4)
    const { store } = paste(netDocument(), envelope)
    const graph = store.doc.graphs.g0!
    // Planner and materialize agree on allocation: 2 nodes + 1 net.
    expect(graph.nextOrdinal).toBe(13)
    expect(graph.nets.net1!.sinks).toHaveLength(2)
    expect(graph.nets.net12).toMatchObject({
      name: 'Latents_2',
      source: { node: 'n10', port: 'out' },
      sinks: [{ node: 'n11', port: 'in' }],
    })
    // A second paste of the same payload takes the next free suffix.
    const again = planClipboardPaste(store.doc, 'g0', envelope, { x: 40, y: 60 })!
    expect(store.dispatch(again.invocation).ok).toBe(true)
    const names = Object.values(store.doc.graphs.g0!.nets).map((net) => net.name).sort()
    expect(names).toEqual(['Latents', 'Latents_2', 'Latents_3'])
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(Object.keys(store.doc.graphs.g0!.nets)).toEqual(['net1'])
  })

  it('carries manually placed tag offsets through copy and paste', () => {
    const source = {
      ...netDocument(),
      ext: {
        'dinkster.netViews': [
          { graphId: 'g0', netId: 'net1', role: 'source', offset: { x: 30, y: -10 } },
          { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'c1', port: 'in' }, offset: { x: -25, y: 40 } },
          // Retired absolute geometry is source-graph world coordinates and
          // must not transfer.
          { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'c2', port: 'in' }, position: { x: 999, y: 999 } },
        ],
      },
    } as WorkflowDocument
    const envelope = serializeSelection(source, 'g0', { nodes: ['p', 'c1', 'c2'], reroutes: [] })!
    expect(envelope.nets).toEqual([{
      name: 'Latents',
      source: { node: 'p', port: 'out', nodeType: 'Producer', view: { x: 30, y: -10 } },
      sinks: [{ node: 'c1', port: 'in', view: { x: -25, y: 40 } }, { node: 'c2', port: 'in' }],
    }])
    const { store } = paste(netDocument(), envelope)
    const views = store.doc.ext?.['dinkster.netViews'] as readonly Record<string, unknown>[]
    expect(views).toContainEqual({ graphId: 'g0', netId: 'net13', role: 'source', offset: { x: 30, y: -10 } })
    expect(views).toContainEqual({ graphId: 'g0', netId: 'net13', role: 'sink', to: { node: 'n11', port: 'in' }, offset: { x: -25, y: 40 } })
    expect(views.filter((entry) => 'position' in entry)).toHaveLength(0)
  })

  it('carries a sink tag offset into the merged destination net on a sink-only paste', () => {
    const source = {
      ...netDocument(),
      ext: {
        'dinkster.netViews': [
          { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'c1', port: 'in' }, offset: { x: -25, y: 40 } },
        ],
      },
    } as WorkflowDocument
    const envelope = serializeSelection(source, 'g0', { nodes: ['c1'], reroutes: [] })!
    const { store } = paste(netDocument(), envelope)
    // Merged into the existing net: the pasted sink node keeps its tag offset.
    expect(Object.keys(store.doc.graphs.g0!.nets)).toEqual(['net1'])
    expect(store.doc.ext?.['dinkster.netViews']).toContainEqual(
      { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'n10', port: 'in' }, offset: { x: -25, y: 40 } },
    )
  })

  it('treats name collisions case-insensitively when renaming', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['p', 'c1'], reroutes: [] })!
    const shouting = { ...envelope, nets: [{ ...(envelope.nets![0] as Record<string, unknown>), name: 'LATENTS' }] } as never
    const { store } = paste(netDocument(), shouting)
    expect(store.doc.graphs.g0!.nets.net12!.name).toBe('LATENTS_2')
  })

  it('keeps the original name when the destination graph has no collision', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['p', 'c1'], reroutes: [] })!
    const target = netDocument()
    ;(target.graphs.g0 as { nets: Record<string, unknown> }).nets = {}
    const { store } = paste(target, envelope)
    const nets = Object.values(store.doc.graphs.g0!.nets)
    expect(nets).toHaveLength(1)
    expect(nets[0]).toMatchObject({ name: 'Latents', source: { node: 'n10', port: 'out' } })
  })

  it('recreates an incompatible sink-only collision as a renamed net wired to the recorded source', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['c1'], reroutes: [] })!
    const target = netDocument()
    // Same-name net now independently sourced from another producer type.
    ;(target.graphs.g0!.nets as Record<string, { source: unknown }>).net1!.source = { node: 'q', port: 'out' }
    const { store } = paste(target, envelope)
    const graph = store.doc.graphs.g0!
    expect(graph.nets.net1!.sinks).toHaveLength(2)
    expect(graph.nets.net11).toMatchObject({
      name: 'Latents_2',
      source: { node: 'p', port: 'out' },
      sinks: [{ node: 'n10', port: 'in' }],
    })
  })

  it('drops membership when a sink-only paste cannot resolve its source in the destination graph', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['c1'], reroutes: [] })!
    const target = netDocument()
    delete (target.graphs.g0!.nodes as Record<string, unknown>).p
    ;(target.graphs.g0 as { nets: Record<string, unknown> }).nets = {}
    const { store } = paste(target, envelope)
    expect(store.doc.graphs.g0!.nodes.n10).toBeDefined()
    expect(Object.keys(store.doc.graphs.g0!.nets)).toEqual([])
  })

  it('a pasted link driving the same input wins over a net sink', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['p', 'c1'], reroutes: [] })!
    const withLink = {
      ...envelope,
      links: [{ id: 'l1', from: { node: 'p', port: 'out' }, to: { node: 'c1', port: 'in' } }],
    } as never as DinksterClipboardEnvelope
    const { store } = paste(netDocument(), withLink)
    const graph = store.doc.graphs.g0!
    const created = Object.values(graph.nets).find((net) => net.name === 'Latents_2')!
    expect(created.sinks).toEqual([])
    expect(Object.values(graph.links).some((link) =>
      'node' in link.from && link.from.node === 'n10' && 'node' in link.to && link.to.node === 'n11')).toBe(true)
  })

  it('rejects malformed version 4 payloads atomically', () => {
    const envelope = serializeSelection(netDocument(), 'g0', { nodes: ['p', 'c1'], reroutes: [] })!
    const record = envelope.nets![0]!
    // Duplicate net names make collision resolution ambiguous.
    expect(planClipboardPaste(netDocument(), 'g0', { ...envelope, nets: [record, record] } as never)).toBeUndefined()
    // A sink on the source node is a state the net commands never produce.
    const selfLoop = { ...(record as Record<string, unknown>), sinks: [{ node: 'p', port: 'in' }] }
    expect(planClipboardPaste(netDocument(), 'g0', { ...envelope, nets: [selfLoop] } as never)).toBeUndefined()
    // Version 4 requires the nets array outright.
    const { nets: _nets, ...withoutNets } = envelope
    expect(planClipboardPaste(netDocument(), 'g0', withoutNets as never)).toBeUndefined()
  })

  it('leaves version 2 payloads untouched by net planning', () => {
    const doc = netDocument()
    ;(doc.graphs.g0 as { nets: Record<string, unknown> }).nets = {}
    const envelope = serializeSelection(doc, 'g0', { nodes: ['p', 'c1'], reroutes: [] })!
    expect(envelope.version).toBe(2)
    expect(envelope.nets).toBeUndefined()
    const { store } = paste(netDocument(), envelope)
    expect(Object.keys(store.doc.graphs.g0!.nets)).toEqual(['net1'])
    expect(store.doc.graphs.g0!.nets.net1!.sinks).toHaveLength(2)
  })
})
