import { describe, expect, it, vi } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { CommandDefinition } from '../src/commands/contract.js'
import { semanticHashOf } from '../src/compile/hash.js'
import { loadDocument } from '../src/format/migrate.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { netViewPositions } from '../src/format/net-views.js'
import { asDynamicMemberId, asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId, asSelectorCandidateId, asSelectorId, asValueSourceId } from '../src/ids.js'
import { elabInputsOf, elaborateInterface } from '../src/schema/elaborate.js'
import { parseDinksterSchemaWire15 } from '../src/schema/dinkster-wire.js'
import { initialDynamicStateOf } from '../src/schema/model.js'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
/** Port ref addressing one member of a dynamic family. */
const mport = (node: string, portId: string, member: string) => ({
  node: asNodeId(node),
  port: asPortId(portId),
  members: [asDynamicMemberId(member)],
})

describe('trusted dispatch preflight', () => {
  const rejection = { severity: 'error', origin: 'command', code: 'test.rejected', message: 'no' } as const

  it('T1 validateDispatch runs before run and rejection is document-cursor atomic', () => {
    let ran = 0
    const rejecting: CommandDefinition = {
      id: 'test.rejectingPreflight',
      validateDispatch: () => [rejection],
      run(_doc, _params, tx) {
        ran += 1
        tx.set(['lineage'], 'changed')
        tx.set(['graphs', 'g0', 'nextOrdinal'], 999)
        return []
      },
    }
    const initial = doc({ g0: graph({ id: 'g0' }) })
    const store = new DocumentStore(initial, coreCommandRegistry([rejecting]))
    const before = JSON.stringify(store.doc)
    expect(store.dispatch({ command: rejecting.id, params: null }).ok).toBe(false)
    expect(JSON.stringify(store.doc)).toBe(before)
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(100)
    expect(store.revision).toBe(0)
    expect(ran).toBe(0)
  })

  it('T2 public dispatch receives initial context', () => {
    const seen: string[] = []
    const probe: CommandDefinition = {
      id: 'test.probePreflight',
      validateDispatch: (_current, _params, context) => (seen.push(context.kind), []),
      run() { return [] },
    }
    const store = new DocumentStore(doc({ g0: graph({ id: 'g0' }) }), coreCommandRegistry([probe]))
    expect(store.dispatch({ command: probe.id, params: null }).ok).toBe(true)
    expect(seen).toEqual(['initial'])
  })

  it('T3 nested batch subcommand receives the same trusted context', () => {
    const resolverFactory = () => () => undefined
    const context = { kind: 'initial' as const, schemaResolverFor: resolverFactory }
    const seen: unknown[] = []
    const probe: CommandDefinition = {
      id: 'test.probeBatchContext',
      validateDispatch: (_current, _params, received) => (seen.push(received), []),
      run() { return [] },
    }
    const store = new DocumentStore(
      doc({ g0: graph({ id: 'g0' }) }),
      coreCommandRegistry([probe]),
      200,
      undefined,
      () => context,
    )
    expect(store.dispatch({
      command: 'batch',
      params: { invocations: [{ command: probe.id, params: null }] },
    }).ok).toBe(true)
    expect(seen).toEqual([context])
  })

  it('T4 batch cannot bypass a rejecting flatten preflight', () => {
    let ran = 0
    const registry = coreCommandRegistry() as Map<string, CommandDefinition>
    registry.set('subgraph.flatten', {
      id: 'subgraph.flatten',
      validateDispatch: () => [rejection],
      run() {
        ran += 1
        return []
      },
    })
    const store = new DocumentStore(doc({ g0: graph({ id: 'g0' }) }), registry)
    const outcome = store.dispatch({
      command: 'batch',
      params: { invocations: [{ command: 'subgraph.flatten', params: null }] },
    })
    expect(outcome.ok).toBe(false)
    expect(ran).toBe(0)
    expect(store.revision).toBe(0)
  })

  it('T5 later batch resolver factory sees earlier subcommand writes', () => {
    const resolverDocuments: string[] = []
    const probe: CommandDefinition = {
      id: 'test.probeResolverDocument',
      validateDispatch: (current, _params, context) => {
        if (context.kind !== 'initial' || context.schemaResolverFor === undefined) return [rejection]
        context.schemaResolverFor(current)('unused')
        return []
      },
      run() { return [] },
    }
    const write: CommandDefinition = {
      id: 'test.writeFirst',
      run(_doc, _params, tx) {
        tx.set(['lineage'], 'changed')
        return []
      },
    }
    const store = new DocumentStore(
      doc({ g0: graph({ id: 'g0' }) }),
      coreCommandRegistry([write, probe]),
      200,
      undefined,
      () => ({
        kind: 'initial',
        schemaResolverFor: (current) => {
          resolverDocuments.push(current.lineage)
          return () => undefined
        },
      }),
    )
    const outcome = store.dispatch({ command: 'batch', params: { invocations: [
      { command: write.id, params: null }, { command: probe.id, params: null },
    ] } })
    expect(outcome.ok).toBe(true)
    expect(resolverDocuments).toEqual(['changed'])
  })
})

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

function makeStore(d?: WorkflowDocument) {
  return new DocumentStore(
    d ??
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
          links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
        }),
      }),
    coreCommandRegistry(),
  )
}

describe('DocumentStore.dispatch', () => {
  it('rejects unknown commands', () => {
    const store = makeStore()
    const out = store.dispatch({ command: 'nope', params: {} })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('command.unknown')
    expect(store.revision).toBe(0)
  })

  it('preserves wire-15 recursive choice state through unrelated edits and undo', () => {
    const choiceState = {
      mode: { selected: 'batch' },
      'mode.quality': { selected: 'full' },
      'mode.frames': { members: ['stable'] },
    }
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: { ...node('n1'), dynamic: choiceState } },
      }),
    }))
    const changed = store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'mode.quality.steps', value: 12 },
    })
    expect(changed.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.dynamic).toEqual(choiceState)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.dynamic).toEqual(choiceState)
  })

  it('seeds a fresh wire-15 choice and undoes edits back to the explicit first option', () => {
    const parsed = parseDinksterSchemaWire15('Resize', {
      schemaVersion: 15,
      interface: [{
        role: 'dynamicCombo',
        id: 'resize_type',
        options: [
          { key: 'scale dimensions', inputs: [{ role: 'input', id: 'width', type: { kind: 'concrete', types: ['core.int'] }, required: false }] },
          { key: 'scale by multiplier', inputs: [{ role: 'input', id: 'multiplier', type: { kind: 'concrete', types: ['core.float'] }, required: false }] },
        ],
      }],
    })
    expect(parsed.diagnostics).toEqual([])
    const initialDynamic = initialDynamicStateOf(parsed.schema!)
    expect(initialDynamic).toEqual({ resize_type: { selected: 'scale dimensions' } })
    const store = makeStore()
    const added = store.dispatch({
      command: 'node.add',
      params: {
        graphId: 'g0',
        type: 'Resize',
        position: { x: 0, y: 0 },
        dynamic: initialDynamic,
      },
    })
    expect(added.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n100!.dynamic).toEqual(initialDynamic)

    const changed = store.dispatch({
      command: 'dynamic.selectOption',
      params: { graphId: 'g0', nodeId: 'n100', construct: 'resize_type', option: 'scale by multiplier' },
    })
    expect(changed.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n100!.dynamic).toEqual({
      resize_type: { selected: 'scale by multiplier' },
    })
    expect(store.undo()).toBe(true)
    const restored = store.doc.graphs.g0!.nodes.n100!
    expect(restored.dynamic).toEqual(initialDynamic)
    expect(elabInputsOf(elaborateInterface(parsed.schema!, restored)).map((input) => input.address.port)).toEqual([
      'resize_type',
      'resize_type.width',
    ])
  })

  it('commits node.add: allocates id from the cursor, writes node + view position', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.add',
      params: { graphId: 'g0', type: 'CLIPTextEncode', position: { x: 10, y: 20 } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes.n100).toMatchObject({ id: 'n100', type: 'CLIPTextEncode' })
    expect(g.nextOrdinal).toBe(101)
    expect(store.doc.view.graphs.g0!.nodes.n100!.position).toEqual({ x: 10, y: 20 })
    expect(store.revision).toBe(1)
  })

  it('node.add rejects a dangling subgraph type atomically', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.add',
      params: { graphId: 'g0', type: '#missing', position: { x: 0, y: 0 } },
    })
    expect(out.ok).toBe(false)
    expect(store.revision).toBe(0)
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(100)
  })

  it('node.remove cascades links, net sinks, and view state in one transaction', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
        nets: {
          t5: {
            id: asNetId('t5'),
            name: 'ctx',
            source: port('n1', 'out0'),
            sinks: [port('n2', 'ctx'), port('n3', 'ctx')],
          },
        },
      }),
    })
    const store = new DocumentStore(
      {
        ...d,
        view: { graphs: { g0: { nodes: { n2: { position: { x: 1, y: 2 } } } } } },
        ext: { 'dinkster.netViews': [
          { graphId: 'g0', netId: 't5', role: 'source', position: { x: 10, y: 20 } },
          { graphId: 'g0', netId: 't5', role: 'sink', to: { node: 'n2', port: 'ctx' }, position: { x: 30, y: 40 } },
          { graphId: 'g0', netId: 't5', role: 'sink', to: { node: 'n3', port: 'ctx' }, position: { x: 50, y: 60 } },
        ] },
      },
      coreCommandRegistry(),
    )
    const before = store.doc
    const out = store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['n2'] } })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes.n2).toBeUndefined()
    expect(g.links.l4).toBeUndefined()
    expect(g.nets.t5!.sinks).toEqual([port('n3', 'ctx')])
    expect(store.doc.view.graphs.g0!.nodes.n2).toBeUndefined()
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 't5', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
      { graphId: 'g0', netId: 't5', role: 'sink', to: port('n3', 'ctx'), geometry: { kind: 'absolute', x: 50, y: 60 } },
    ])

    // Undo restores everything from the same transaction.
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('node.remove drops a whole net when its source is removed', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        nets: {
          t5: { id: asNetId('t5'), name: 'ctx', source: port('n1', 'out0'), sinks: [port('n2', 'ctx')] },
        },
      }),
    })
    const store = new DocumentStore({
      ...d,
      ext: { 'dinkster.netViews': [
        { graphId: 'g0', netId: 't5', role: 'source', position: { x: 10, y: 20 } },
        { graphId: 'g0', netId: 't5', role: 'sink', to: { node: 'n2', port: 'ctx' }, position: { x: 30, y: 40 } },
      ] },
    }, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['n1'] } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.t5).toBeUndefined()
    expect(netViewPositions(store.doc, 'g0')).toEqual([])
  })

  it('graph.deleteItems removes nodes + links + net sinks in ONE undo step', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') },
          l5: { id: asLinkId('l5'), from: port('n1', 'out0'), to: port('n3', 'model') },
        },
        nets: {
          t6: {
            id: asNetId('t6'),
            name: 'ctx',
            source: port('n1', 'out0'),
            sinks: [port('n2', 'ctx'), port('n3', 'ctx')],
          },
        },
      }),
    })
    const store = new DocumentStore({
      ...d,
      ext: { 'dinkster.netViews': [
        { graphId: 'g0', netId: 't6', role: 'source', position: { x: 10, y: 20 } },
        { graphId: 'g0', netId: 't6', role: 'sink', to: { node: 'n2', port: 'ctx' }, position: { x: 30, y: 40 } },
        { graphId: 'g0', netId: 't6', role: 'sink', to: { node: 'n3', port: 'ctx' }, position: { x: 50, y: 60 } },
      ] },
    }, coreCommandRegistry())
    const out = store.dispatch({
      command: 'graph.deleteItems',
      params: {
        graphId: 'g0',
        nodeIds: ['n2'],
        linkIds: ['l5'],
        netSinks: [{ node: 'n3', port: 'ctx' }],
      },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes.n2).toBeUndefined()
    expect(g.links.l4).toBeUndefined() // cascaded from n2
    expect(g.links.l5).toBeUndefined() // explicit
    expect(g.nets.t6!.sinks).toEqual([]) // n2 sink cascaded, n3 sink explicit
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 't6', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
    ])
    expect(store.revision).toBe(1)

    // ONE undo restores all of it.
    expect(store.undo()).toBe(true)
    const g2 = store.doc.graphs.g0!
    expect(g2.nodes.n2).toBeDefined()
    expect(g2.links.l4).toBeDefined()
    expect(g2.links.l5).toBeDefined()
    expect(g2.nets.t6!.sinks).toHaveLength(2)
  })

  it('graph.deleteItems rejects unknown links atomically', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'graph.deleteItems',
      params: { graphId: 'g0', linkIds: ['nope'] },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('link.missing')
    expect(store.doc.graphs.g0!.links.l4).toBeDefined()
    expect(store.revision).toBe(0)
  })

  it('graph.deleteItems rejects net sinks no net feeds', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'graph.deleteItems',
      params: { graphId: 'g0', netSinks: [{ node: 'n2', port: 'nope' }] },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('net.sinkMissing')
  })

  it('link.connect replaces the existing driver of the target input (I5)', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('n3', 'out0'), to: port('n2', 'model') },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.links.l4).toBeUndefined() // old driver removed
    expect(g.links.l100).toMatchObject({ from: port('n3', 'out0'), to: port('n2', 'model') })
  })

  it('link.connect rejects self-loops and dangling endpoints', () => {
    const store = makeStore()
    const self = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('n1', 'out0'), to: port('n1', 'in') },
    })
    expect(self.ok).toBe(false)
    if (!self.ok) {
      expect(self.diagnostics[0]!.message).toBe('link.connect: cannot connect a node to itself')
      expect(self.diagnostics[0]!.refs).toEqual([
        { graphId: 'g0', nodeId: 'n1', portId: 'out0', direction: 'output' },
        { graphId: 'g0', nodeId: 'n1', portId: 'in', direction: 'input' },
      ])
    }
    const dangling = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('nX', 'out0'), to: port('n2', 'model') },
    })
    expect(dangling.ok).toBe(false)
    if (!dangling.ok) {
      expect(dangling.diagnostics[0]!.message).toBe("link.connect: unknown node 'nX'")
      expect(dangling.diagnostics[0]!.refs).toEqual([
        { graphId: 'g0', nodeId: 'nX', portId: 'out0', direction: 'output' },
      ])
    }
    expect(store.revision).toBe(0)
  })

  it('link.rewire moves the target end in one transaction and displaces the new driver', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') },
          l5: { id: asLinkId('l5'), from: port('n2', 'out0'), to: port('n3', 'model') },
        },
      }),
    })
    const store = makeStore(d)
    // Move l4's target from n2.model onto n3.model, displacing l5.
    const out = store.dispatch({
      command: 'link.rewire',
      params: { graphId: 'g0', linkId: 'l4', to: { node: 'n3', port: 'model' } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.links.l4!.to).toEqual({ node: 'n3', port: 'model' })
    expect(g.links.l5).toBeUndefined()
    expect(store.revision).toBe(1)
    // ONE undo step restores both the old target and the displaced link.
    store.undo()
    expect(store.doc.graphs.g0!.links.l4!.to).toEqual({ node: 'n2', port: 'model' })
    expect(store.doc.graphs.g0!.links.l5).toBeDefined()
  })

  it('link.rewire rejects self-loops and no-ops on the same target', () => {
    const store = makeStore()
    const self = store.dispatch({
      command: 'link.rewire',
      params: { graphId: 'g0', linkId: 'l4', to: { node: 'n1', port: 'x' } },
    })
    expect(self.ok).toBe(false)
    const noop = store.dispatch({
      command: 'link.rewire',
      params: { graphId: 'g0', linkId: 'l4', to: { node: 'n2', port: 'model' } },
    })
    expect(noop.ok).toBe(true)
    expect(store.revision).toBe(0) // no transaction committed
  })

  it('link.rewireSource moves a whole fan-out to a new source in one transaction', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3'), n4: node('n4') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') },
          l5: { id: asLinkId('l5'), from: port('n1', 'out0'), to: port('n3', 'model') },
        },
      }),
    })
    const store = makeStore(d)
    const out = store.dispatch({
      command: 'link.rewireSource',
      params: { graphId: 'g0', linkIds: ['l4', 'l5'], from: { node: 'n4', port: 'out0' } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    // Link identities survive; only the source end changed.
    expect(g.links.l4).toMatchObject({ from: port('n4', 'out0'), to: port('n2', 'model') })
    expect(g.links.l5).toMatchObject({ from: port('n4', 'out0'), to: port('n3', 'model') })
    expect(store.revision).toBe(1)
    // ONE undo step restores every source.
    store.undo()
    expect(store.doc.graphs.g0!.links.l4!.from).toEqual(port('n1', 'out0'))
    expect(store.doc.graphs.g0!.links.l5!.from).toEqual(port('n1', 'out0'))
  })

  it('link.rewireSource is all-or-nothing: one self-loop rejects the whole move', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
        links: {
          l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') },
          l5: { id: asLinkId('l5'), from: port('n1', 'out0'), to: port('n3', 'model') },
        },
      }),
    })
    const store = makeStore(d)
    // n3 sinks l5, so sourcing from n3 self-loops that member.
    const out = store.dispatch({
      command: 'link.rewireSource',
      params: { graphId: 'g0', linkIds: ['l4', 'l5'], from: { node: 'n3', port: 'out0' } },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('link.selfLoop')
    expect(store.revision).toBe(0)
    expect(store.doc.graphs.g0!.links.l4!.from).toEqual(port('n1', 'out0'))
  })

  it('link.rewireSource rejects unknown links and no-ops when nothing changes', () => {
    const store = makeStore()
    const missing = store.dispatch({
      command: 'link.rewireSource',
      params: { graphId: 'g0', linkIds: ['l4', 'nope'], from: { node: 'n3', port: 'out0' } },
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.diagnostics[0]!.code).toBe('link.missing')
    const noop = store.dispatch({
      command: 'link.rewireSource',
      params: { graphId: 'g0', linkIds: ['l4'], from: { node: 'n1', port: 'out0' } },
    })
    expect(noop.ok).toBe(true)
    expect(store.revision).toBe(0) // no transaction committed
  })

  it('node.setValue writes a value keyed by input id', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 42 },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(42)
  })

  it('text.splice validates and replaces a string range with undo support', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', value: 'hello' },
    }).ok).toBe(true)
    store.clearHistory()

    const out = store.dispatch({
      command: 'text.splice',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', offset: 1, deleteCount: 3, insert: 'i' },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('hio')
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.prompt).toBe('hello')
  })

  it.each([
    ['bad params', { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', offset: -1, deleteCount: 0, insert: '' }, 'params.invalid'],
    ['unknown graph', { graphId: 'missing', nodeId: 'n1', inputId: 'prompt', offset: 0, deleteCount: 0, insert: '' }, 'graph.missing'],
    ['unknown node', { graphId: 'g0', nodeId: 'missing', inputId: 'prompt', offset: 0, deleteCount: 0, insert: '' }, 'node.missing'],
    ['non-string value', { graphId: 'g0', nodeId: 'n1', inputId: 'seed', offset: 0, deleteCount: 0, insert: '' }, 'text.notString'],
    ['missing value', { graphId: 'g0', nodeId: 'n1', inputId: 'missing', offset: 0, deleteCount: 0, insert: '' }, 'text.notString'],
    ['offset out of bounds', { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', offset: 6, deleteCount: 0, insert: '' }, 'params.invalid'],
    ['range out of bounds', { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', offset: 4, deleteCount: 2, insert: '' }, 'params.invalid'],
  ])('text.splice rejects %s', (_name, params, code) => {
    const store = makeStore()
    store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'prompt', value: 'hello' },
    })
    const out = store.dispatch({ command: 'text.splice', params })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe(code)
  })

  it('records rapid value writes as distinct commands with predictable undo', () => {
    const store = makeStore()
    const initial = store.doc.graphs.g0!.nodes.n1!.values.seed
    const count = 20
    for (let value = 1; value <= count; value++) {
      expect(store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value },
      }).ok).toBe(true)
    }
    expect(store.revision).toBe(count)
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(count)
    for (let value = count - 1; value >= 0; value--) {
      expect(store.undo()).toBe(true)
      expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(value === 0 ? initial : value)
    }
    expect(store.canUndo).toBe(false)
  })

  it('node.setController sets, clears, validates, and undoes controller modes', () => {
    const store = makeStore()
    const set = store.dispatch({
      command: 'node.setController',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', mode: 'increment' },
    })
    expect(set.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.controllers).toEqual({ seed: 'increment' })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.controllers).toBeUndefined()
    expect(store.redo()).toBe(true)
    const clear = store.dispatch({
      command: 'node.setController',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', mode: null },
    })
    expect(clear.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.controllers?.seed).toBeUndefined()
    expect(store.dispatch({
      command: 'node.setController',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', mode: 'shuffle' },
    }).ok).toBe(false)
  })

  it('node.setValues writes many values atomically as ONE undo step', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n1', values: { seed: 7, steps: 30 } },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(7)
    expect(store.doc.graphs.g0!.nodes.n1!.values.steps).toBe(30)
    expect(store.revision).toBe(1)
    store.undo()
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBeUndefined()
    expect(store.doc.graphs.g0!.nodes.n1!.values.steps).toBeUndefined()
  })

  it('node.setValues skips already-equal entries; a full match is a no-op with no undo entry', () => {
    const store = makeStore()
    store.dispatch({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n1', values: { box: { x: 1, y: 2 } } },
    })
    expect(store.revision).toBe(1)
    // Deep-equal (different key order) - nothing to write, nothing to undo.
    const noop = store.dispatch({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n1', values: { box: { y: 2, x: 1 } } },
    })
    expect(noop.ok).toBe(true)
    expect(store.revision).toBe(1)
    // Mixed: only the differing key commits; undo restores just that write.
    store.dispatch({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n1', values: { box: { x: 1, y: 2 }, seed: 9 } },
    })
    expect(store.revision).toBe(2)
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(9)
  })

  it('node.setValues rejects unknown nodes and non-object values', () => {
    const store = makeStore()
    expect(
      store.dispatch({
        command: 'node.setValues',
        params: { graphId: 'g0', nodeId: 'nope', values: { a: 1 } },
      }).ok,
    ).toBe(false)
    expect(
      store.dispatch({
        command: 'node.setValues',
        params: { graphId: 'g0', nodeId: 'n1', values: 5 },
      }).ok,
    ).toBe(false)
  })

  it('node.setMode flips modes for many nodes at once', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.setMode',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], mode: 'muted' },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.mode).toBe('muted')
    expect(store.doc.graphs.g0!.nodes.n2!.mode).toBe('muted')
  })

  it('node.setTitle clears the override field so serialization omits it', () => {
    const store = makeStore()
    const initialRevision = store.revision
    expect(store.dispatch({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n1', title: null },
    }).ok).toBe(true)
    expect(store.revision).toBe(initialRevision)

    expect(store.dispatch({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n1', title: 'My Sampler' },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.title).toBe('My Sampler')

    expect(store.dispatch({
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'n1', title: null },
    }).ok).toBe(true)
    expect('title' in store.doc.graphs.g0!.nodes.n1!).toBe(false)
    expect(JSON.stringify(store.doc.graphs.g0!.nodes.n1)).not.toContain('"title"')
  })

  it('node.move updates view positions for a multi-node drag as ONE undo step', () => {
    const store = makeStore()
    store.dispatch({
      command: 'node.move',
      params: { graphId: 'g0', positions: { n1: { x: 5, y: 6 }, n2: { x: 7, y: 8 } } },
    })
    expect(store.doc.view.graphs.g0!.nodes.n1!.position).toEqual({ x: 5, y: 6 })
    expect(store.doc.view.graphs.g0!.nodes.n2!.position).toEqual({ x: 7, y: 8 })
    store.undo()
    expect(store.doc.view.graphs.g0?.nodes.n1).toBeUndefined()
    expect(store.doc.view.graphs.g0?.nodes.n2).toBeUndefined()
  })

  it('view.setNodeCollapsed persists view-only state for a selection and restores exact sizes atomically', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: 'g0', nodeId: 'n1', size: { width: 240, height: 180 }, position: { x: 15, y: 25 } },
    }).ok).toBe(true)
    const beforeHash = semanticHashOf(store.doc)
    const before = store.doc
    expect(store.dispatch({
      command: 'view.setNodeCollapsed',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2', 'n1'], collapsed: true },
    }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1).toEqual({
      position: { x: 15, y: 25 },
      size: { width: 240, height: 180 },
      collapsed: true,
    })
    expect(store.doc.view.graphs.g0!.nodes.n2).toEqual({ collapsed: true })
    expect(semanticHashOf(store.doc)).toBe(beforeHash)
    expect(loadDocument(JSON.parse(JSON.stringify(store.doc))).document!.view.graphs.g0!.nodes.n2!.collapsed).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)

    expect(store.dispatch({
      command: 'view.setNodeCollapsed',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], collapsed: false },
    }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1).toEqual({
      position: { x: 15, y: 25 },
      size: { width: 240, height: 180 },
    })
    expect(store.doc.view.graphs.g0!.nodes.n2).toEqual({})
  })

  it('view.setNodeCollapsed rejects a missing member without changing any selected node', () => {
    const store = makeStore()
    const before = store.doc
    expect(store.dispatch({
      command: 'view.setNodeCollapsed',
      params: { graphId: 'g0', nodeIds: ['n1', 'missing'], collapsed: true },
    }).ok).toBe(false)
    expect(store.doc).toBe(before)
  })

  it('view.setNodeSize materializes missing view state when a position is supplied (RG-1)', () => {
    // A semantic node can legally lack view state (the scene paints it at a
    // fallback position). A canvas resize commit always carries the position
    // it painted, so the command materializes the entry like node.move does
    // instead of rejecting a gesture the user just completed.
    const store = makeStore()
    const out = store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: 'g0', nodeId: 'n1', size: { width: 180, height: 90 }, position: { x: 15, y: 25 } },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1).toEqual({
      position: { x: 15, y: 25 },
      size: { width: 180, height: 90 },
    })
    // The materialized entry is one undo step, removed whole.
    store.undo()
    expect(store.doc.view.graphs.g0?.nodes.n1).toBeUndefined()
    // Without a position there is nothing to anchor the entry to: still rejects.
    expect(
      store.dispatch({
        command: 'view.setNodeSize',
        params: { graphId: 'g0', nodeId: 'n2', size: { width: 100, height: 50 } },
      }).ok,
    ).toBe(false)
  })

  it('selection.move updates different movable kinds as ONE undo step', () => {
    const store = makeStore()
    const added = store.dispatch({
      command: 'valueSource.add',
      params: { graphId: 'g0', value: 1, position: { x: 1, y: 2 } },
    })
    expect(added.ok).toBe(true)
    expect(store.dispatch({
      command: 'view.createGroup',
      params: { graphId: 'g0', title: 'mixed', bounds: { x: 0, y: 0, width: 100, height: 100 } },
    }).ok).toBe(true)
    const valueSourceId = Object.keys(store.doc.graphs.g0!.valueSources ?? {})[0]!
    const groupId = Object.keys(store.doc.view.graphs.g0!.groups ?? {})[0]!
    const beforeMove = store.doc
    const out = store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: { n1: { x: 5, y: 6 } },
        valueSources: { [valueSourceId]: { x: 7, y: 8 } },
        groups: { [groupId]: { x: 9, y: 10 } },
      },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.position).toEqual({ x: 5, y: 6 })
    expect(store.doc.view.graphs.g0!.valueSources![valueSourceId]!.position).toEqual({ x: 7, y: 8 })
    expect(store.doc.view.graphs.g0!.groups![groupId]!.bounds).toEqual({ x: 9, y: 10, width: 100, height: 100 })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(beforeMove)
  })

  it('selection.move persists per-definition net view geometry and preserves foreign ext entries', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        nets: {
          net1: { id: asNetId('net1'), name: 'shared', source: port('n1', 'out0'), sinks: [port('n2', 'model')] },
        },
      }),
      g1: graph({
        id: 'g1',
        nodes: { n1: node('n1'), n2: node('n2') },
        nets: {
          net1: { id: asNetId('net1'), name: 'shared', source: port('n1', 'out0'), sinks: [port('n2', 'model')] },
        },
      }),
    })
    const malformed = { future: true, payload: ['keep'] }
    const store = makeStore({ ...d, ext: { 'dinkster.netViews': [malformed] } })
    const before = store.doc
    expect(store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net1', role: 'source', position: { x: 101, y: 202 } },
          { netId: 'net1', role: 'sink', to: { node: 'n2', port: 'model' }, position: { x: 303, y: 404 } },
        ],
      },
    }).ok).toBe(true)
    expect(store.doc.ext?.['dinkster.netViews']).toContainEqual(malformed)
    // n1/n2 have no stored view positions, so nothing can anchor an offset:
    // the geometry persists as absolute.
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'net1', role: 'source', geometry: { kind: 'absolute', x: 101, y: 202 } },
      { graphId: 'g0', netId: 'net1', role: 'sink', to: port('n2', 'model'), geometry: { kind: 'absolute', x: 303, y: 404 } },
    ])
    expect(netViewPositions(store.doc, 'g1')).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(netViewPositions(store.doc, 'g0')).toHaveLength(2)
  })

  it('selection.move stores net tag geometry as an offset from the owning node', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        nets: {
          net1: { id: asNetId('net1'), name: 'shared', source: port('n1', 'out0'), sinks: [port('n2', 'model')] },
        },
      }),
    })
    const store = makeStore({
      ...d,
      view: { graphs: { g0: { nodes: { n1: { position: { x: 100, y: 200 } }, n2: { position: { x: 500, y: 600 } } } } } } as WorkflowDocument['view'],
    })
    expect(store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net1', role: 'source', position: { x: 130, y: 190 } },
          { netId: 'net1', role: 'sink', to: { node: 'n2', port: 'model' }, position: { x: 480, y: 640 } },
        ],
      },
    }).ok).toBe(true)
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'net1', role: 'source', geometry: { kind: 'offset', x: 30, y: -10 } },
      { graphId: 'g0', netId: 'net1', role: 'sink', to: port('n2', 'model'), geometry: { kind: 'offset', x: -20, y: 40 } },
    ])
  })

  it('selection.move anchors tag offsets to the post-move node position when the same command moves the owner', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        nets: {
          net1: { id: asNetId('net1'), name: 'shared', source: port('n1', 'out0'), sinks: [port('n2', 'model')] },
        },
      }),
    })
    const store = makeStore({
      ...d,
      view: { graphs: { g0: { nodes: { n1: { position: { x: 100, y: 200 } }, n2: { position: { x: 500, y: 600 } } } } } } as WorkflowDocument['view'],
    })
    // Multi-select drag: node and tag move together in one dispatch. The
    // offset must come from the node's NEW position or the tag would drift.
    expect(store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: { n1: { x: 1100, y: 1200 } },
        netViews: [
          { netId: 'net1', role: 'source', position: { x: 1130, y: 1190 } },
        ],
      },
    }).ok).toBe(true)
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'net1', role: 'source', geometry: { kind: 'offset', x: 30, y: -10 } },
    ])
  })
})

describe('DocumentStore undo/redo', () => {
  it('replays patches: undo/redo round-trips exactly', () => {
    const store = makeStore()
    const before = store.doc
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 2 } })
    const after = store.doc

    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(1)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.undo()).toBe(false)

    expect(store.redo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(after)
    expect(store.redo()).toBe(false)
  })

  it('a new dispatch clears the redo stack', () => {
    const store = makeStore()
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
    store.undo()
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 3 } })
    expect(store.redo()).toBe(false)
    expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(3)
  })

  it('untouched subtrees keep reference identity across commits', () => {
    const store = makeStore()
    const g0Before = store.doc.graphs.g0!
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
    const g0After = store.doc.graphs.g0!
    expect(g0After).not.toBe(g0Before)
    expect(g0After.nodes.n2).toBe(g0Before.nodes.n2) // untouched sibling shares identity
    expect(g0After.links).toBe(g0Before.links)
  })

  it('notifies document subscribers on commit and undo', () => {
    const store = makeStore()
    const seen: number[] = []
    store.document.subscribe(() => seen.push(store.revision))
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
    store.undo()
    expect(seen).toEqual([1, 2])
  })
})

describe('CO1 ownership boundary', () => {
  it('detaches the initial document: caller mutation never reaches the store', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) })
    const store = new DocumentStore(d, coreCommandRegistry())
    ;(d.graphs as Record<string, unknown>).evil = 'mutated'
    expect(store.doc.graphs['evil']).toBeUndefined()
  })

  it('deep-freezes the document: committed state is immutable at every level', () => {
    const store = makeStore()
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'obj', value: { a: [1, 2] } } })
    const values = store.doc.graphs.g0!.nodes.n1!.values
    expect(Object.isFrozen(store.doc)).toBe(true)
    expect(Object.isFrozen(values)).toBe(true)
    expect(Object.isFrozen(values.obj)).toBe(true)
    expect(Object.isFrozen((values.obj as { a: unknown }).a)).toBe(true)
  })

  it('detaches command param values: mutating them after dispatch changes nothing', () => {
    const store = makeStore()
    const value = { nested: { n: 1 } }
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'obj', value } })
    value.nested.n = 999
    expect((store.doc.graphs.g0!.nodes.n1!.values.obj as { nested: { n: number } }).nested.n).toBe(1)
  })
})

describe('CO2 JSON safety at dispatch', () => {
  it('rejects params carrying non-finite numbers with a diagnostic, atomically', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: Infinity },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('command.params.notJson')
    expect(store.revision).toBe(0)
  })

  it('rejects cyclic params instead of recursing forever', () => {
    const store = makeStore()
    const cyclic: Record<string, unknown> = { graphId: 'g0', nodeId: 'n1', inputId: 'seed' }
    cyclic.value = cyclic
    const out = store.dispatch({ command: 'node.setValue', params: cyclic as never })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.message).toContain('cyclic')
  })

  it('rejects NaN node positions', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.add',
      params: { graphId: 'g0', type: 'T', position: { x: NaN, y: 0 } },
    })
    expect(out.ok).toBe(false)
  })

  it('rejects an undefined map entry ATOMICALLY instead of committing a partial update', () => {
    const store = makeStore()
    const out = store.dispatch({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n1', values: { good: 1, bad: undefined } } as never,
    })
    expect(out.ok).toBe(false)
    expect(store.doc.graphs.g0!.nodes.n1!.values.good).toBeUndefined()
    expect(store.revision).toBe(0)
  })

  it("rejects a '__proto__' PATH segment atomically and emits nothing (node.setValue inputId)", () => {
    // A '__proto__' key created through a command path would commit a
    // document ownJson rejects on reload and put the dangerous segment on
    // the session wire. The transaction builder refuses the path.
    const store = makeStore()
    const events: unknown[] = []
    store.onTransaction((e) => events.push(e))
    const out = store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: '__proto__', value: { polluted: true } },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.diagnostics[0]!.code).toBe('command.threw')
      expect(out.diagnostics[0]!.message).toContain('__proto__')
    }
    expect(store.revision).toBe(0)
    expect(events).toEqual([]) // nothing reaches the session feed
    expect(Object.keys(store.doc.graphs.g0!.nodes.n1!.values)).toEqual([])
    expect(({}) as Record<string, unknown>).not.toHaveProperty('polluted')
  })
})

describe('CO3 id allocation is monotonic across undo', () => {
  it('undo of node.add keeps the high-water mark: the next add mints a FRESH id', () => {
    const store = makeStore() // fixture nextOrdinal: 100
    const p = { graphId: 'g0', type: 'T', position: { x: 0, y: 0 } }
    store.dispatch({ command: 'node.add', params: p })
    expect(store.doc.graphs.g0!.nodes.n100).toBeDefined()
    store.undo()
    expect(store.doc.graphs.g0!.nodes.n100).toBeUndefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(101)
    store.dispatch({ command: 'node.add', params: p })
    // Never n100 again: a link/reference recorded elsewhere (or a sync log)
    // must never see one id mean two different nodes.
    expect(store.doc.graphs.g0!.nodes.n100).toBeUndefined()
    expect(store.doc.graphs.g0!.nodes.n101).toBeDefined()
  })

  it('undo/redo cycles never rewind the cursor and redo stays applicable', () => {
    const store = makeStore()
    const p = { graphId: 'g0', type: 'T', position: { x: 0, y: 0 } }
    store.dispatch({ command: 'node.add', params: p })
    store.undo()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n100).toBeDefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(101)
  })

  it('replay preserves ONLY declared seq cursors: unknown extension subtrees are never skeletonized into redo', () => {
    // The dynamic-state format permits unknown additive properties. An
    // extension object that happens to contain a numeric `seq` is semantic
    // data, not an allocation cursor - replay must not "preserve" it into a
    // redo, or redo diverges from the recorded forward state.
    const registry = new Map(coreCommandRegistry())
    registry.set('test.setDynamic', {
      id: 'test.setDynamic',
      run(_doc, params, tx) {
        tx.set(
          ['graphs', 'g0', 'nodes', 'n1', 'dynamic'],
          (params as { value: Json }).value,
        )
        return []
      },
    })
    const initial = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          n1: {
            ...node('n1'),
            dynamic: { images: { members: ['m0'], seq: 1, future: { seq: 9, payload: 'p' } } },
          } as never,
        },
      }),
    })
    const store = new DocumentStore(initial, registry)
    const forward = { images: { members: ['m0', 'm1'], seq: 2 } }
    expect(store.dispatch({ command: 'test.setDynamic', params: { value: forward } }).ok).toBe(true)
    store.undo()
    // Undo restores the extension subtree verbatim; only the DECLARED
    // cursor is clamped to its high-water mark.
    expect(store.doc.graphs.g0!.nodes.n1!.dynamic).toEqual({
      images: { members: ['m0'], seq: 2, future: { seq: 9, payload: 'p' } },
    })
    expect(store.redo()).toBe(true)
    // Redo reproduces the recorded forward state exactly: no {future:{seq:9}}
    // skeleton invented out of the extension data.
    expect(store.doc.graphs.g0!.nodes.n1!.dynamic).toEqual(forward)
  })

  it("a direct op on an extension 'seq' LEAF is semantic data, not a cursor: undo rewinds it", () => {
    // isAllocationCursor is shape-directed too: only `seq` at a declared
    // DynamicPortState position is an allocation cursor. A `seq` inside an
    // unknown extension object must replay verbatim - treating it as a
    // cursor would make its undo a silent no-op.
    const registry = new Map(coreCommandRegistry())
    registry.set('test.setFutureSeq', {
      id: 'test.setFutureSeq',
      run(_doc, params, tx) {
        tx.set(
          ['graphs', 'g0', 'nodes', 'n1', 'dynamic', 'images', 'future', 'seq'],
          (params as { value: Json }).value,
        )
        return []
      },
    })
    const initial = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          n1: {
            ...node('n1'),
            dynamic: { images: { members: ['m0'], seq: 1, future: { seq: 9 } } },
          } as never,
        },
      }),
    })
    const store = new DocumentStore(initial, registry)
    expect(store.dispatch({ command: 'test.setFutureSeq', params: { value: 10 } }).ok).toBe(true)
    const dynImages = () =>
      (store.doc.graphs.g0!.nodes.n1!.dynamic as unknown as { images: { future: { seq: number } } })
        .images
    expect(dynImages().future.seq).toBe(10)
    store.undo()
    expect(dynImages().future.seq).toBe(9) // rewinds: NOT an allocation cursor
    expect(store.redo()).toBe(true)
    expect(dynImages().future.seq).toBe(10)
  })
})

describe('CO7 id-space exhaustion is an atomic rejection', () => {
  const MAX = Number.MAX_SAFE_INTEGER
  const nearMaxDoc = (nextOrdinal: number) =>
    doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
        nextOrdinal,
      }),
    })

  it('node.add at the cursor ceiling rejects atomically instead of committing an unloadable cursor', () => {
    // A loaded document may legally carry any safe cursor; minting here
    // would set nextOrdinal to MAX_SAFE_INTEGER + 1, which loadDocument
    // rejects - the command must refuse instead.
    const store = new DocumentStore(nearMaxDoc(MAX), coreCommandRegistry())
    const out = store.dispatch({
      command: 'node.add',
      params: { graphId: 'g0', type: 'T', position: { x: 0, y: 0 } },
    })
    expect(out.ok).toBe(false)
    expect(out.diagnostics[0]!.message).toContain('id space exhausted')
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(MAX)
    expect(Object.keys(store.doc.graphs.g0!.nodes)).toEqual(['n1', 'n2'])
  })

  it('the LAST safe ordinal still mints; the next allocation rejects', () => {
    const store = new DocumentStore(nearMaxDoc(MAX - 1), coreCommandRegistry())
    const p = { graphId: 'g0', type: 'T', position: { x: 0, y: 0 } }
    expect(store.dispatch({ command: 'node.add', params: p }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes[`n${MAX - 1}`]).toBeDefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(MAX)
    expect(store.dispatch({ command: 'node.add', params: p }).ok).toBe(false)
  })

  it('multi-mint commands reject atomically: reroute.insert leaves the original link intact', () => {
    // reroute.insert needs THREE ordinals (reroute + two links); with only
    // two left the whole gesture must reject, not half-apply.
    const store = new DocumentStore(nearMaxDoc(MAX - 2), coreCommandRegistry())
    const out = store.dispatch({
      command: 'reroute.insert',
      params: { graphId: 'g0', linkId: 'l4', position: { x: 0, y: 0 } },
    })
    expect(out.ok).toBe(false)
    expect(store.doc.graphs.g0!.links.l4).toBeDefined()
    expect(Object.keys(store.doc.graphs.g0!.reroutes)).toEqual([])
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(MAX - 2)
  })

  it('view.createGroup ignores unsafe grp<N> suffixes instead of minting a colliding rounded id', () => {
    // A hostile key like grp<MAX_SAFE_INTEGER> would round Number+1 and make
    // a later scan mint the SAME rounded id, silently overwriting a group.
    // Unsafe suffixes never advance the cursor; canonical small ids stay
    // collision-free because the huge key's decimal form differs.
    const store = makeStore()
    const huge = `grp${MAX}`
    const boundsP = { x: 0, y: 0, width: 10, height: 10 }
    expect(
      store.dispatch({ command: 'view.createGroup', params: { graphId: 'g0', title: 'a', bounds: boundsP } }).ok,
    ).toBe(true)
    // Inject the hostile key the way a loaded document would carry it.
    const docWithHuge = structuredClone(store.doc) as WorkflowDocument
    ;(docWithHuge.view.graphs.g0!.groups as Record<string, unknown>)[huge] = {
      id: huge,
      title: 'hostile',
      bounds: boundsP,
    }
    const store2 = makeStore(docWithHuge)
    expect(
      store2.dispatch({ command: 'view.createGroup', params: { graphId: 'g0', title: 'b', bounds: boundsP } }).ok,
    ).toBe(true)
    expect(
      store2.dispatch({ command: 'view.createGroup', params: { graphId: 'g0', title: 'c', bounds: boundsP } }).ok,
    ).toBe(true)
    const keys = Object.keys(store2.doc.view.graphs.g0!.groups!)
    // grp0 pre-existing, hostile key untouched, two fresh non-colliding ids.
    expect(keys).toContain('grp0')
    expect(keys).toContain(huge)
    expect(keys).toContain('grp1')
    expect(keys).toContain('grp2')
    expect(keys).toHaveLength(4)
    expect(store2.doc.view.graphs.g0!.groups![huge]!.title).toBe('hostile')
  })

  it('view.createGroup rejects at terminal collision instead of overwriting the skipped key', () => {
    // grp<MAX-1> advances the cursor to MAX; grp<MAX> is skipped (unsafe
    // increment) - so the scan lands exactly on the skipped key. Creating
    // must reject, never replace the existing group.
    const boundsP = { x: 0, y: 0, width: 10, height: 10 }
    const seeded = structuredClone(makeStore().doc) as WorkflowDocument
    ;(seeded.view.graphs as Record<string, unknown>).g0 = {
      groups: {
        [`grp${MAX - 1}`]: { id: `grp${MAX - 1}`, title: 'near', bounds: boundsP },
        [`grp${MAX}`]: { id: `grp${MAX}`, title: 'terminal', bounds: boundsP },
      },
    }
    const store = makeStore(seeded)
    const out = store.dispatch({
      command: 'view.createGroup',
      params: { graphId: 'g0', title: 'late', bounds: boundsP },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('group.exhausted')
    expect(store.doc.view.graphs.g0!.groups![`grp${MAX}`]!.title).toBe('terminal')
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toHaveLength(2)
  })
})

describe('CO10 observer isolation', () => {
  it('a throwing transaction listener does not break the commit or later listeners', () => {
    const errors: unknown[] = []
    const store = new DocumentStore(
      doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }),
      coreCommandRegistry(),
      200,
      (error) => errors.push(error),
    )
    const seen: string[] = []
    store.onTransaction(() => {
      throw new Error('observer bug')
    })
    store.onTransaction((e) => seen.push(e.kind))
    const out = store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
    expect(out.ok).toBe(true)
    expect(seen).toEqual(['dispatch'])
    expect(errors).toHaveLength(1)
  })

  it('a throwing error SINK does not unwind into the committed dispatch', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new DocumentStore(
        doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }),
        coreCommandRegistry(),
        200,
        () => {
          throw new Error('sink bug')
        },
      )
      store.onTransaction(() => {
        throw new Error('observer bug')
      })
      store.document.subscribe(() => {
        throw new Error('subscriber bug')
      })
      const out = store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
      expect(out.ok).toBe(true)
      expect(store.doc.graphs.g0!.nodes.n1!.values.seed).toBe(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('a throwing document subscriber does not starve later subscribers', () => {
    const errors: unknown[] = []
    const store = new DocumentStore(
      doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }),
      coreCommandRegistry(),
      200,
      (error) => errors.push(error),
    )
    const seen: number[] = []
    store.document.subscribe(() => {
      throw new Error('subscriber bug')
    })
    store.document.subscribe(() => seen.push(store.revision))
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', value: 1 } })
    expect(seen).toEqual([1])
    expect(errors).toHaveLength(1)
  })
})

describe('view.setSectionCollapsed', () => {
  /** Store whose n1 has view state (position), like every placed node. */
  function makeViewStore(sections?: Record<string, { collapsed: boolean }>) {
    const d = doc({
      g0: graph({ id: 'g0', nodes: { n1: node('n1'), n2: node('n2') } }),
    })
    return new DocumentStore(
      {
        ...d,
        view: {
          graphs: {
            g0: { nodes: { n1: { position: { x: 0, y: 0 }, ...(sections ? { sections } : {}) } } },
          },
        },
      },
      coreCommandRegistry(),
    )
  }
  const invoke = (params: Record<string, unknown>) => ({
    command: 'view.setSectionCollapsed',
    params: { graphId: 'g0', nodeId: 'n1', sectionId: 'adv', collapsed: true, ...params },
  })

  it('sets an override and undo/redo replays it', () => {
    const store = makeViewStore()
    expect(store.dispatch(invoke({})).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toEqual({ adv: { collapsed: true } })
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toEqual({ adv: { collapsed: true } })
  })

  it('can explicitly EXPAND (override false beats a schema collapsedByDefault)', () => {
    const store = makeViewStore()
    expect(store.dispatch(invoke({ collapsed: false })).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toEqual({ adv: { collapsed: false } })
  })

  it('collapsed: null clears the override and removes an empty sections map', () => {
    const store = makeViewStore({ adv: { collapsed: true }, extra: { collapsed: false } })
    expect(store.dispatch(invoke({ collapsed: null })).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toEqual({ extra: { collapsed: false } })
    expect(store.dispatch(invoke({ collapsed: null, sectionId: 'extra' })).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toBeUndefined()
    // Both clears undo cleanly.
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toEqual({ extra: { collapsed: false } })
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.sections).toEqual({
      adv: { collapsed: true },
      extra: { collapsed: false },
    })
  })

  it('clearing an absent override is a committed no-op (no revision bump)', () => {
    const store = makeViewStore()
    const out = store.dispatch(invoke({ collapsed: null }))
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(0)
    expect(store.undo()).toBe(false)
  })

  it('rejects unknown graph/node and malformed params', () => {
    const store = makeViewStore()
    expect(store.dispatch(invoke({ graphId: 'nope' })).ok).toBe(false)
    expect(store.dispatch(invoke({ nodeId: 'nope' })).ok).toBe(false)
    expect(store.dispatch(invoke({ sectionId: '' })).ok).toBe(false)
    expect(store.dispatch(invoke({ collapsed: 'yes' })).ok).toBe(false)
    // n2 exists in the graph but has NO view state; setting an override fails.
    expect(store.dispatch(invoke({ nodeId: 'n2' })).ok).toBe(false)
    expect(store.revision).toBe(0)
  })
})

describe('view.setWidgetRepresentation', () => {
  const invocation = (representation: string | null, inputId = 'text') => ({
    command: 'view.setWidgetRepresentation',
    params: { graphId: 'g0', nodeId: 'n1', inputId, representation },
  })

  it('persists a view-only choice and replays it through undo and redo', () => {
    const initial = doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) })
    const store = new DocumentStore(initial, coreCommandRegistry())
    const beforeHash = semanticHashOf(store.doc)
    expect(store.dispatch(invocation('single-line')).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.views).toEqual({ text: 'single-line' })
    expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual({})
    expect(semanticHashOf(store.doc)).toBe(beforeHash)
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0?.nodes.n1).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.views).toEqual({ text: 'single-line' })
  })

  it('stores independent input choices and clears only the requested choice', () => {
    const store = makeStore({
      ...doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }),
      view: { graphs: { g0: { nodes: { n1: { position: { x: 10, y: 20 } } } } } },
    })
    expect(store.dispatch(invocation('single-line')).ok).toBe(true)
    expect(store.dispatch(invocation('compact', 'other')).ok).toBe(true)
    expect(store.dispatch(invocation(null)).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1).toEqual({
      position: { x: 10, y: 20 },
      views: { other: 'compact' },
    })
    expect(store.dispatch(invocation(null, 'other')).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1).toEqual({ position: { x: 10, y: 20 } })
  })

  it('refuses malformed parameters and unknown graph or node ids', () => {
    const store = makeStore()
    for (const params of [
      { graphId: 'g0', nodeId: 'n1', inputId: '', representation: 'single-line' },
      { graphId: 'g0', nodeId: 'n1', inputId: 'text', representation: '' },
      { graphId: 'missing', nodeId: 'n1', inputId: 'text', representation: 'single-line' },
      { graphId: 'g0', nodeId: 'missing', inputId: 'text', representation: 'single-line' },
    ]) {
      expect(store.dispatch({ command: 'view.setWidgetRepresentation', params }).ok).toBe(false)
    }
  })
})

describe('named net commands', () => {
  function makeNetStore(ext?: WorkflowDocument['ext']) {
    const initial = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
      }),
    })
    return new DocumentStore(
      ext === undefined ? initial : { ...initial, ext },
      coreCommandRegistry(),
    )
  }

  it('net.create promotes an output: deterministic id, trimmed name, no sinks yet', () => {
    const store = makeNetStore()
    const out = store.dispatch({
      command: 'net.create',
      params: { graphId: 'g0', name: '  ctx  ', source: { node: 'n1', port: 'out0' } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nets.net100).toEqual({
      id: 'net100',
      name: 'ctx',
      source: port('n1', 'out0'),
      sinks: [],
    })
    expect(g.nextOrdinal).toBe(101)

    // CO3: undo removes the net but the ordinal cursor NEVER rewinds -
    // ids are never reused, even across undo.
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100).toBeUndefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(101)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100).toBeDefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(101)
  })

  it('net.create rejects blank and duplicate names, unknown graph/source node', () => {
    const store = makeNetStore()
    const src = { node: 'n1', port: 'out0' }
    expect(store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: '   ', source: src } }).ok).toBe(false)
    expect(store.dispatch({ command: 'net.create', params: { graphId: 'nope', name: 'ctx', source: src } }).ok).toBe(false)
    expect(store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'ghost', port: 'out0' } } }).ok).toBe(false)
    expect(store.revision).toBe(0)

    expect(store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: src } }).ok).toBe(true)
    const dup = store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: src } })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.diagnostics[0]!.code).toBe('net.name')
  })

  it('net.connectInput attaches a sink and replaces the existing direct-link driver', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    // n2.model is currently driven by link l4; connecting the net must displace it.
    const out = store.dispatch({
      command: 'net.connectInput',
      params: { graphId: 'g0', netId: 'net100', to: { node: 'n2', port: 'model' } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.links.l4).toBeUndefined()
    expect(g.nets.net100!.sinks).toEqual([port('n2', 'model')])

    // ONE undo restores both the link and the sink-less net.
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.links.l4).toBeDefined()
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([])
  })

  it('net.connectInput moves a sink between nets and drops the old net view', () => {
    const store = makeNetStore()
    const src = { node: 'n1', port: 'out0' }
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'a', source: src } }) // net100
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'b', source: src } }) // net101
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [{ netId: 'net100', role: 'sink', to: { node: 'n3', port: 'ctx' }, position: { x: 30, y: 40 } }],
      },
    })
    const beforeMove = store.doc
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net101', to: { node: 'n3', port: 'ctx' } } })
    const g = store.doc.graphs.g0!
    expect(g.nets.net100!.sinks).toEqual([])
    expect(g.nets.net101!.sinks).toEqual([port('n3', 'ctx')])
    expect(netViewPositions(store.doc, 'g0')).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(beforeMove)
  })

  it('net.disconnectInput drops only the detached sink view and undo restores it', () => {
    const malformed = { future: true, payload: ['keep'] }
    const store = makeNetStore({ 'dinkster.netViews': [malformed] })
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n2', port: 'model' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net100', role: 'source', position: { x: 10, y: 20 } },
          { netId: 'net100', role: 'sink', to: { node: 'n2', port: 'model' }, position: { x: 30, y: 40 } },
          { netId: 'net100', role: 'sink', to: { node: 'n3', port: 'ctx' }, position: { x: 50, y: 60 } },
        ],
      },
    })
    const before = store.doc

    expect(store.dispatch({
      command: 'net.disconnectInput',
      params: { graphId: 'g0', to: { node: 'n2', port: 'model' } },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([port('n3', 'ctx')])
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'net100', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
      { graphId: 'g0', netId: 'net100', role: 'sink', to: port('n3', 'ctx'), geometry: { kind: 'absolute', x: 50, y: 60 } },
    ])
    expect(store.doc.ext?.['dinkster.netViews']).toContainEqual(malformed)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('a batched sink membership move drops the old view without transferring its offset', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n2', port: 'model' } } })
    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net100', role: 'source', position: { x: 10, y: 20 } },
          { netId: 'net100', role: 'sink', to: { node: 'n2', port: 'model' }, position: { x: 30, y: 40 } },
        ],
      },
    })
    const before = store.doc
    const revision = store.revision

    expect(store.dispatch({
      command: 'batch',
      params: { invocations: [
        { command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } },
        { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'model' } } },
      ] },
    }).ok).toBe(true)
    expect(store.revision).toBe(revision + 1)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([port('n3', 'ctx')])
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'net100', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
    ])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('net.resetView drops one authored tag placement and undo restores it', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n2', port: 'model' } } })
    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net100', role: 'source', position: { x: 10, y: 20 } },
          { netId: 'net100', role: 'sink', to: { node: 'n2', port: 'model' }, position: { x: 30, y: 40 } },
        ],
      },
    })
    const authored = store.doc

    // Resetting the sink tag leaves the source entry untouched.
    expect(store.dispatch({
      command: 'net.resetView',
      params: { graphId: 'g0', netId: 'net100', role: 'sink', to: { node: 'n2', port: 'model' } },
    }).ok).toBe(true)
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'net100', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
    ])

    // Resetting the source tag removes the last authored entry.
    expect(store.dispatch({
      command: 'net.resetView',
      params: { graphId: 'g0', netId: 'net100', role: 'source' },
    }).ok).toBe(true)
    expect(netViewPositions(store.doc, 'g0')).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(authored)
  })

  it('net.resetView rejects unknown targets and tags without an authored placement', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n2', port: 'model' } } })
    const revision = store.revision
    const fail = (params: Json, code: string): void => {
      const out = store.dispatch({ command: 'net.resetView', params })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.diagnostics[0]!.code).toBe(code)
    }
    fail({ graphId: 'g0', netId: 'net100', role: 'diagonal' }, 'params.invalid')
    fail({ graphId: 'nope', netId: 'net100', role: 'source' }, 'graph.missing')
    fail({ graphId: 'g0', netId: 'ghost', role: 'source' }, 'net.missing')
    fail({ graphId: 'g0', netId: 'net100', role: 'sink' }, 'params.invalid')
    fail({ graphId: 'g0', netId: 'net100', role: 'sink', to: { node: 'n3', port: 'ctx' } }, 'net.sinkMissing')
    // Tags that never moved have nothing to reset.
    fail({ graphId: 'g0', netId: 'net100', role: 'source' }, 'netView.missing')
    fail({ graphId: 'g0', netId: 'net100', role: 'sink', to: { node: 'n2', port: 'model' } }, 'netView.missing')
    expect(store.revision).toBe(revision)
  })

  it('net.connectInput: duplicate connection is a committed no-op; self-loop rejected', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    const rev = store.revision
    const again = store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    expect(again.ok).toBe(true)
    expect(store.revision).toBe(rev)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toHaveLength(1)

    const self = store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n1', port: 'in0' } } })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.diagnostics[0]!.code).toBe('link.selfLoop')
  })

  it('net.setSource re-points the source, keeps sinks, and undoes in one step', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    const out = store.dispatch({
      command: 'net.setSource',
      params: { graphId: 'g0', netId: 'net100', source: { node: 'n2', port: 'out0' } },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.source).toEqual(port('n2', 'out0'))
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([port('n3', 'ctx')])

    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.source).toEqual(port('n1', 'out0'))
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([port('n3', 'ctx')])
  })

  it('net.setSource: same source is a committed no-op; self-loop and unknown ids rejected', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    const rev = store.revision
    const same = store.dispatch({
      command: 'net.setSource',
      params: { graphId: 'g0', netId: 'net100', source: { node: 'n1', port: 'out0' } },
    })
    expect(same.ok).toBe(true)
    expect(store.revision).toBe(rev)

    // A net cannot be sourced from a node it feeds.
    const self = store.dispatch({
      command: 'net.setSource',
      params: { graphId: 'g0', netId: 'net100', source: { node: 'n3', port: 'out0' } },
    })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.diagnostics[0]!.code).toBe('link.selfLoop')

    expect(store.dispatch({ command: 'net.setSource', params: { graphId: 'g0', netId: 'ghost', source: { node: 'n2', port: 'out0' } } }).ok).toBe(false)
    expect(store.dispatch({ command: 'net.setSource', params: { graphId: 'g0', netId: 'net100', source: { node: 'ghost', port: 'out0' } } }).ok).toBe(false)
    expect(store.dispatch({ command: 'net.setSource', params: { graphId: 'nope', netId: 'net100', source: { node: 'n2', port: 'out0' } } }).ok).toBe(false)
    expect(store.doc.graphs.g0!.nets.net100!.source).toEqual(port('n1', 'out0'))
  })

  it('net.rename trims and enforces graph-unique names (own name allowed)', () => {
    const store = makeNetStore()
    const src = { node: 'n1', port: 'out0' }
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'a', source: src } }) // net100
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'b', source: src } }) // net101
    expect(store.dispatch({ command: 'net.rename', params: { graphId: 'g0', netId: 'net100', name: ' c ' } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.name).toBe('c')
    expect(store.dispatch({ command: 'net.rename', params: { graphId: 'g0', netId: 'net100', name: 'b' } }).ok).toBe(false)
    expect(store.dispatch({ command: 'net.rename', params: { graphId: 'g0', netId: 'net100', name: 'c' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'net.rename', params: { graphId: 'g0', netId: 'ghost', name: 'x' } }).ok).toBe(false)
  })

  it('net.remove deletes the net and its view state; undo restores all of it', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net100', role: 'source', position: { x: 10, y: 20 } },
          { netId: 'net100', role: 'sink', to: { node: 'n3', port: 'ctx' }, position: { x: 30, y: 40 } },
        ],
      },
    })
    store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'guide' } })
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual(['net100'])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual(['net100'])
    const before = store.doc

    expect(store.dispatch({ command: 'net.remove', params: { graphId: 'g0', netId: 'net100' } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100).toBeUndefined()
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])
    expect(netViewPositions(store.doc, 'g0')).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('node.remove of the net source prunes the display mode; undo and redo round-trip', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: { node: 'n3', port: 'ctx' } } })
    store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'guide' } })
    const before = store.doc

    expect(store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['n1'] } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100).toBeUndefined()
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])
  })

  it('graph.deleteItems and node.replace dropNets prune the display mode of removed nets', () => {
    const deleteStore = makeNetStore()
    deleteStore.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    deleteStore.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'tags' } })
    expect(deleteStore.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', nodeIds: ['n1'] } }).ok).toBe(true)
    expect(deleteStore.doc.graphs.g0!.nets.net100).toBeUndefined()
    expect(deleteStore.doc.view.graphs.g0!.collapsedNets).toEqual([])

    const replaceStore = makeNetStore()
    replaceStore.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    replaceStore.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'guide' } })
    const replaced = replaceStore.dispatch({
      command: 'node.replace',
      params: { plan: {
        graphId: 'g0', nodeId: 'n1', from: 'KSampler', to: 'KSampler', values: {},
        inputRewires: [], outputRewires: [], dropLinks: [], netSourceRewires: [], netSinks: [], dropNets: ['net100'],
      } },
    })
    expect(replaced.ok, JSON.stringify(replaced.diagnostics)).toBe(true)
    expect(replaceStore.doc.graphs.g0!.nets.net100).toBeUndefined()
    expect(replaceStore.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(replaceStore.doc.view.graphs.g0!.guideNets).toEqual([])
  })

  it('view.setNetCollapsed toggles; matching state is a committed no-op', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    const rev = store.revision
    // Already expanded: collapsing=false is a no-op.
    expect(store.dispatch({ command: 'view.setNetCollapsed', params: { graphId: 'g0', netId: 'net100', collapsed: false } }).ok).toBe(true)
    expect(store.revision).toBe(rev)

    expect(store.dispatch({ command: 'view.setNetCollapsed', params: { graphId: 'g0', netId: 'net100', collapsed: true } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual(['net100'])
    expect(store.dispatch({ command: 'view.setNetCollapsed', params: { graphId: 'g0', netId: 'net100', collapsed: false } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])

    expect(store.dispatch({ command: 'view.setNetCollapsed', params: { graphId: 'g0', netId: 'ghost', collapsed: true } }).ok).toBe(false)
  })

  it('view.setNetCollapsed expanding a guide-mode net also leaves guide mode', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'guide' } })
    expect(store.doc.view.graphs.g0!.guideNets).toEqual(['net100'])

    expect(store.dispatch({ command: 'view.setNetCollapsed', params: { graphId: 'g0', netId: 'net100', collapsed: false } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])
  })

  it('view.setNetDisplay picks one exclusive mode; guide implies collapsed', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })

    expect(store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'guide' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual(['net100'])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual(['net100'])

    expect(store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'tags' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual(['net100'])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])

    expect(store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'noodle' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])

    // A matching mode is a committed no-op; unknown targets and modes fail.
    const rev = store.revision
    expect(store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'noodle' } }).ok).toBe(true)
    expect(store.revision).toBe(rev)
    expect(store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'ghost', mode: 'tags' } }).ok).toBe(false)
    expect(store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'sparkle' } }).ok).toBe(false)
  })

  it('view.setAllNetsDisplay switches every net in one undoable step and drops dangling entries', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'aux', source: { node: 'n2', port: 'out0' } } })
    store.dispatch({ command: 'view.setNetDisplay', params: { graphId: 'g0', netId: 'net100', mode: 'guide' } })
    const before = store.doc

    expect(store.dispatch({ command: 'view.setAllNetsDisplay', params: { graphId: 'g0', mode: 'tags' } }).ok).toBe(true)
    expect([...store.doc.view.graphs.g0!.collapsedNets!].sort()).toEqual(['net100', 'net101'])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)

    expect(store.dispatch({ command: 'view.setAllNetsDisplay', params: { graphId: 'g0', mode: 'guide' } }).ok).toBe(true)
    expect([...store.doc.view.graphs.g0!.guideNets!].sort()).toEqual(['net100', 'net101'])

    expect(store.dispatch({ command: 'view.setAllNetsDisplay', params: { graphId: 'g0', mode: 'noodle' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.collapsedNets).toEqual([])
    expect(store.doc.view.graphs.g0!.guideNets).toEqual([])

    // A matching state is a committed no-op; bad params fail.
    const rev = store.revision
    expect(store.dispatch({ command: 'view.setAllNetsDisplay', params: { graphId: 'g0', mode: 'noodle' } }).ok).toBe(true)
    expect(store.revision).toBe(rev)
    expect(store.dispatch({ command: 'view.setAllNetsDisplay', params: { graphId: 'ghost', mode: 'tags' } }).ok).toBe(false)
    expect(store.dispatch({ command: 'view.setAllNetsDisplay', params: { graphId: 'g0', mode: 'sparkle' } }).ok).toBe(false)
  })

  it('nets are scoped to one graph definition: commands cannot reach across', () => {
    const store = new DocumentStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1') },
          nets: { t9: { id: asNetId('t9'), name: 'ctx', source: port('n1', 'out0'), sinks: [] } },
        }),
        g1: graph({ id: 'g1', name: 'sub', boundary: { inputs: [], outputs: [] }, nodes: { m1: node('m1') } }),
      }),
      coreCommandRegistry(),
    )
    // g1 has no net t9: connecting m1 through the parent graph's net must fail.
    const out = store.dispatch({
      command: 'net.connectInput',
      params: { graphId: 'g1', netId: 't9', to: { node: 'm1', port: 'ctx' } },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('net.missing')
  })

  it('net.create and net.connectInput preserve dynamic member ids', () => {
    const store = makeNetStore()
    const out = store.dispatch({
      command: 'net.create',
      params: { graphId: 'g0', name: 'ctx', source: mport('n1', 'items.sub', 'm0') },
    })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.source).toEqual(mport('n1', 'items.sub', 'm0'))

    const sink = store.dispatch({
      command: 'net.connectInput',
      params: { graphId: 'g0', netId: 'net100', to: mport('n3', 'items.sub', 'm7') },
    })
    expect(sink.ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([mport('n3', 'items.sub', 'm7')])
  })

  it('link and net commands preserve NESTED member paths verbatim', () => {
    // Autogrow-in-Autogrow identity: commands must carry the whole path
    // through JSON normalization; truncating to the leaf or head segment
    // would cross-wire sibling scopes.
    const nested = (node: string, portId: string, ...path: string[]) => ({
      node: asNodeId(node),
      port: asPortId(portId),
      members: path.map(asDynamicMemberId),
    })
    const store = makeNetStore()
    const link = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('n2', 'out0'), to: nested('n3', 'items.sub', 'outer', 'inner') },
    })
    expect(link.ok).toBe(true)
    const linkData = Object.values(store.doc.graphs.g0!.links).at(-1)!
    expect(linkData.to).toEqual(nested('n3', 'items.sub', 'outer', 'inner'))

    const net = store.dispatch({
      command: 'net.create',
      params: { graphId: 'g0', name: 'deep', source: nested('n1', 'items.sub', 'o0', 'i0') },
    })
    expect(net.ok).toBe(true)
    const netId = Object.keys(store.doc.graphs.g0!.nets).at(-1)!
    expect(store.doc.graphs.g0!.nets[netId]!.source).toEqual(nested('n1', 'items.sub', 'o0', 'i0'))
    const sink = store.dispatch({
      command: 'net.connectInput',
      params: { graphId: 'g0', netId, to: nested('n3', 'items.sub', 'o1', 'i1') },
    })
    expect(sink.ok).toBe(true)
    expect(store.doc.graphs.g0!.nets[netId]!.sinks).toEqual([nested('n3', 'items.sub', 'o1', 'i1')])

    // Sibling paths sharing the leaf segment are distinct identities: a link
    // into ('outer','other') must not displace the ('outer','inner') link.
    const before = Object.keys(store.doc.graphs.g0!.links).length
    const sibling = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('n2', 'out0'), to: nested('n3', 'items.sub', 'outer', 'other') },
    })
    expect(sibling.ok).toBe(true)
    expect(Object.keys(store.doc.graphs.g0!.links).length).toBe(before + 1)
  })

  it('net sinks on different members of one port are independent', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: mport('n3', 'items.sub', 'm0') } })
    // Same node+port, different member: a second sink, NOT a duplicate no-op.
    const rev = store.revision
    const other = store.dispatch({
      command: 'net.connectInput',
      params: { graphId: 'g0', netId: 'net100', to: mport('n3', 'items.sub', 'm1') },
    })
    expect(other.ok).toBe(true)
    expect(store.revision).not.toBe(rev)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([
      mport('n3', 'items.sub', 'm0'),
      mport('n3', 'items.sub', 'm1'),
    ])
    // Same member again IS the duplicate no-op.
    const rev2 = store.revision
    expect(store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: mport('n3', 'items.sub', 'm1') } }).ok).toBe(true)
    expect(store.revision).toBe(rev2)
    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net100', role: 'sink', to: mport('n3', 'items.sub', 'm0'), position: { x: 10, y: 20 } },
          { netId: 'net100', role: 'sink', to: mport('n3', 'items.sub', 'm1'), position: { x: 30, y: 40 } },
        ],
      },
    })

    // Disconnecting one member leaves the sibling member's sink and view alone.
    expect(store.dispatch({ command: 'net.disconnectInput', params: { graphId: 'g0', to: mport('n3', 'items.sub', 'm0') } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([mport('n3', 'items.sub', 'm1')])
    expect(netViewPositions(store.doc, 'g0')).toEqual([{
      graphId: 'g0',
      netId: 'net100',
      role: 'sink',
      to: mport('n3', 'items.sub', 'm1'),
      geometry: { kind: 'absolute', x: 30, y: 40 },
    }])
  })

  it('connecting a link to one member does not displace a net sink on a sibling member', () => {
    const store = makeNetStore()
    store.dispatch({ command: 'net.create', params: { graphId: 'g0', name: 'ctx', source: { node: 'n1', port: 'out0' } } })
    store.dispatch({ command: 'net.connectInput', params: { graphId: 'g0', netId: 'net100', to: mport('n3', 'items.sub', 'm0') } })

    // Direct link into a DIFFERENT member of the same port: sink m0 survives.
    const other = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('n2', 'out0'), to: mport('n3', 'items.sub', 'm1') },
    })
    expect(other.ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([mport('n3', 'items.sub', 'm0')])

    store.dispatch({
      command: 'selection.move',
      params: {
        graphId: 'g0',
        netViews: [
          { netId: 'net100', role: 'sink', to: mport('n3', 'items.sub', 'm0'), position: { x: 10, y: 20 } },
        ],
      },
    })

    // Direct link into the SAME member: one driver per input, sink displaced.
    const same = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: port('n2', 'out0'), to: mport('n3', 'items.sub', 'm0') },
    })
    expect(same.ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.net100!.sinks).toEqual([])
    expect(netViewPositions(store.doc, 'g0')).toEqual([])
  })
})

describe('group commands (view-only)', () => {
  const bounds = { x: 0, y: 0, width: 400, height: 300 }

  const createGroup = (store: DocumentStore, extra: Record<string, unknown> = {}) =>
    store.dispatch({
      command: 'view.createGroup',
      params: { graphId: 'g0', title: 'Stage 1', bounds, ...extra },
    })

  it('view.createGroup stores a keyed group with matching id', () => {
    const store = makeStore()
    const out = createGroup(store, { color: '#3f789e' })
    expect(out.ok).toBe(true)
    expect(store.doc.view.graphs.g0!.groups).toEqual({
      grp0: { id: 'grp0', title: 'Stage 1', bounds, color: '#3f789e' },
    })
  })

  it('view.createGroup never reuses an id - not even the highest removed one (FR1)', () => {
    const store = makeStore()
    expect(createGroup(store).ok).toBe(true)
    expect(createGroup(store, { title: 'Stage 2' }).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp0', 'grp1'])
    // Group ids outlive their groups in surface bindings, so removing the
    // HIGHEST id must not free it either: a reminted grp1 would silently
    // retarget a binding that still names the removed group.
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp1' } }).ok).toBe(true)
    expect(createGroup(store, { title: 'Stage 3' }).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!).sort()).toEqual(['grp0', 'grp2'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(3)
  })

  it('view.removeGroup persists the high-water mark in a pre-cursor document (FR1)', () => {
    // A loaded document may carry groups but no groupSeq. Removing the only
    // group deletes the only allocation evidence - the remove itself must
    // record the cursor or the next create remints the removed id.
    const seeded = structuredClone(makeStore().doc) as WorkflowDocument
    ;(seeded.view.graphs as Record<string, unknown>).g0 = {
      nodes: {},
      groups: { grp0: { id: 'grp0', title: 'old', bounds: { x: 0, y: 0, width: 10, height: 10 } } },
    }
    const store = makeStore(seeded)
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(1)
    expect(createGroup(store, { title: 'new' }).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp1'])
  })

  it('non-canonical grpN evidence neither advances nor exhausts the cursor (FR1)', () => {
    // 'grp00' and a leading-zero near-ceiling form are not allocator-
    // produced ids (the canonical decimal form differs), so they can never
    // collide with a minted id: they must not advance the floor - and
    // above all a malformed near-ceiling key must not EXHAUST allocation.
    const b = { x: 0, y: 0, width: 10, height: 10 }
    const seeded = structuredClone(makeStore().doc) as WorkflowDocument
    ;(seeded.view.graphs as Record<string, unknown>).g0 = {
      nodes: {},
      groups: {
        grp00: { id: 'grp00', title: 'legacy', bounds: b },
        grp09007199254740990: { id: 'grp09007199254740990', title: 'legacy', bounds: b },
      },
    }
    const store = makeStore(seeded)
    expect(createGroup(store).ok).toBe(true) // mints grp0, not exhausted
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(1)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!).sort()).toEqual([
      'grp0',
      'grp00',
      'grp09007199254740990',
    ])
    // Removing a non-canonical key persists nothing extra either.
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp00' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(1)
  })

  it('view.createGroup rejects non-positive bounds and unknown graphs', () => {
    const store = makeStore()
    const bad = createGroup(store, { bounds: { x: 0, y: 0, width: 0, height: 100 } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.diagnostics[0]!.code).toBe('params.invalid')
    const ghost = store.dispatch({
      command: 'view.createGroup',
      params: { graphId: 'nope', title: 't', bounds },
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.diagnostics[0]!.code).toBe('graph.missing')
    expect(store.revision).toBe(0)
  })

  it('view.moveGroup moves the rectangle and carried nodes in ONE undo step', () => {
    const store = makeStore()
    expect(createGroup(store).ok).toBe(true)
    expect(
      store.dispatch({
        command: 'node.move',
        params: { graphId: 'g0', positions: { n1: { x: 50, y: 50 }, n2: { x: 100, y: 100 } } },
      }).ok,
    ).toBe(true)
    const out = store.dispatch({
      command: 'view.moveGroup',
      params: {
        graphId: 'g0',
        groupId: 'grp0',
        bounds: { x: 200, y: 200 },
        positions: { n1: { x: 250, y: 250 }, n2: { x: 300, y: 300 } },
      },
    })
    expect(out.ok).toBe(true)
    const view = store.doc.view.graphs.g0!
    expect(view.groups!.grp0!.bounds).toEqual({ x: 200, y: 200, width: 400, height: 300 })
    expect(view.nodes.n1!.position).toEqual({ x: 250, y: 250 })
    expect(view.nodes.n2!.position).toEqual({ x: 300, y: 300 })

    expect(store.undo()).toBe(true)
    const undone = store.doc.view.graphs.g0!
    expect(undone.groups!.grp0!.bounds).toEqual(bounds)
    expect(undone.nodes.n1!.position).toEqual({ x: 50, y: 50 })
    expect(undone.nodes.n2!.position).toEqual({ x: 100, y: 100 })
  })

  it('view.moveGroup carries value sources and selectors in the same undo step', () => {
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1') },
        valueSources: { v1: { id: asValueSourceId('v1'), value: 7 } as never },
        selectors: {
          s1: {
            id: asSelectorId('s1'),
            candidates: [{ id: asSelectorCandidateId('ca') }],
            policy: { kind: 'fixed', candidate: asSelectorCandidateId('ca') },
          } as never,
        },
      }),
    }))
    expect(createGroup(store).ok).toBe(true)
    const out = store.dispatch({
      command: 'view.moveGroup',
      params: {
        graphId: 'g0',
        groupId: 'grp0',
        bounds: { x: 200, y: 200 },
        positions: { n1: { x: 250, y: 250 } },
        valueSources: { v1: { x: 260, y: 260 } },
        selectors: { s1: { x: 270, y: 270 } },
      },
    })
    expect(out.ok).toBe(true)
    const view = store.doc.view.graphs.g0!
    expect(view.nodes.n1!.position).toEqual({ x: 250, y: 250 })
    expect(view.valueSources?.v1?.position).toEqual({ x: 260, y: 260 })
    expect(view.selectors?.s1?.position).toEqual({ x: 270, y: 270 })

    // ONE undo step covers the rectangle plus everything it carried.
    expect(store.undo()).toBe(true)
    const undone = store.doc.view.graphs.g0!
    expect(undone.groups!.grp0!.bounds).toEqual(bounds)
    expect(undone.valueSources?.v1?.position).toBeUndefined()
    expect(undone.selectors?.s1?.position).toBeUndefined()
  })

  it('view.moveGroup rejects atomically on unknown value source or selector', () => {
    const store = makeStore()
    expect(createGroup(store).ok).toBe(true)
    const rev = store.revision
    const badSource = store.dispatch({
      command: 'view.moveGroup',
      params: { graphId: 'g0', groupId: 'grp0', bounds: { x: 1, y: 1 }, positions: {}, valueSources: { ghost: { x: 0, y: 0 } } },
    })
    expect(badSource.ok).toBe(false)
    if (!badSource.ok) expect(badSource.diagnostics[0]!.code).toBe('valueSource.missing')
    const badSelector = store.dispatch({
      command: 'view.moveGroup',
      params: { graphId: 'g0', groupId: 'grp0', bounds: { x: 1, y: 1 }, positions: {}, selectors: { ghost: { x: 0, y: 0 } } },
    })
    expect(badSelector.ok).toBe(false)
    if (!badSelector.ok) expect(badSelector.diagnostics[0]!.code).toBe('selector.missing')
    expect(store.revision).toBe(rev)
  })

  it('view.moveGroup rejects atomically on unknown group or node', () => {
    const store = makeStore()
    expect(createGroup(store).ok).toBe(true)
    const rev = store.revision
    const ghost = store.dispatch({
      command: 'view.moveGroup',
      params: { graphId: 'g0', groupId: 'ghost', bounds: { x: 1, y: 1 }, positions: {} },
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.diagnostics[0]!.code).toBe('group.missing')
    const badNode = store.dispatch({
      command: 'view.moveGroup',
      params: { graphId: 'g0', groupId: 'grp0', bounds: { x: 1, y: 1 }, positions: { ghost: { x: 0, y: 0 } } },
    })
    expect(badNode.ok).toBe(false)
    if (!badNode.ok) expect(badNode.diagnostics[0]!.code).toBe('node.missing')
    expect(store.revision).toBe(rev)
    expect(store.doc.view.graphs.g0!.groups!.grp0!.bounds).toEqual(bounds)
  })

  it('view.setGroupBounds resizes; rejects non-positive size', () => {
    const store = makeStore()
    expect(createGroup(store).ok).toBe(true)
    const resized = { x: -10, y: 5, width: 800, height: 600 }
    expect(
      store.dispatch({ command: 'view.setGroupBounds', params: { graphId: 'g0', groupId: 'grp0', bounds: resized } })
        .ok,
    ).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp0!.bounds).toEqual(resized)
    const bad = store.dispatch({
      command: 'view.setGroupBounds',
      params: { graphId: 'g0', groupId: 'grp0', bounds: { x: 0, y: 0, width: 100, height: -1 } },
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.diagnostics[0]!.code).toBe('params.invalid')
  })

  it('view.setGroupTitle and view.setGroupColor update + clear', () => {
    const store = makeStore()
    expect(createGroup(store, { color: '#111111' }).ok).toBe(true)
    expect(
      store.dispatch({ command: 'view.setGroupTitle', params: { graphId: 'g0', groupId: 'grp0', title: 'Renamed' } })
        .ok,
    ).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp0!.title).toBe('Renamed')
    expect(
      store.dispatch({ command: 'view.setGroupColor', params: { graphId: 'g0', groupId: 'grp0', color: '#ff0000' } })
        .ok,
    ).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp0!.color).toBe('#ff0000')
    expect(
      store.dispatch({ command: 'view.setGroupColor', params: { graphId: 'g0', groupId: 'grp0', color: null } }).ok,
    ).toBe(true)
    expect('color' in store.doc.view.graphs.g0!.groups!.grp0!).toBe(false)
  })

  it('view.setNodeVideo persists presentation without changing execution identity and supports undo', () => {
    const store = makeStore()
    const before = store.doc
    const hash = semanticHashOf(before)
    const video = { loop: false, muted: true, autoplay: false }
    expect(store.dispatch({ command: 'view.setNodeVideo', params: { graphId: 'g0', nodeId: 'n1', video } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.video).toEqual(video)
    expect(store.doc.graphs).toEqual(before.graphs)
    expect(semanticHashOf(store.doc)).toBe(hash)
    expect(loadDocument(JSON.parse(JSON.stringify(store.doc))).document?.view.graphs.g0!.nodes.n1!.video).toEqual(video)
    expect(store.dispatch({ command: 'view.setNodeVideo', params: { graphId: 'g0', nodeId: 'n1', video: { ...video, loop: 'true' } } }).ok).toBe(false)
    expect(store.dispatch({ command: 'view.setNodeVideo', params: { graphId: 'g0', nodeId: 'missing', video } }).ok).toBe(false)
    expect(store.revision).toBe(1)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.video).toEqual(video)
  })

  it('view.setNodeColor sets, serializes, and clears the optional view color', () => {
    const store = makeStore()
    expect(
      store.dispatch({ command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n1', color: '#355c7d' } }).ok,
    ).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.color).toBe('#355c7d')
    const serialized = JSON.parse(JSON.stringify(store.doc))
    expect(serialized.view.graphs.g0.nodes.n1.color).toBe('#355c7d')
    expect(loadDocument(serialized).document?.view.graphs.g0!.nodes.n1).toEqual({ color: '#355c7d' })

    expect(
      store.dispatch({ command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n1', color: null } }).ok,
    ).toBe(true)
    expect('color' in store.doc.view.graphs.g0!.nodes.n1!).toBe(false)
    expect(JSON.parse(JSON.stringify(store.doc)).view.graphs.g0.nodes.n1).not.toHaveProperty('color')
  })

  it('view.setNodeColor batches nodes with and without existing view state as one undo step', () => {
    const base = makeStore().doc
    const store = makeStore({
      ...base,
      view: { graphs: { g0: { nodes: { n1: { position: { x: 10, y: 20 } } } } } },
    })
    const result = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          { command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n1', color: '#355c7d' } },
          { command: 'view.setNodeColor', params: { graphId: 'g0', nodeId: 'n2', color: '#355c7d' } },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(store.revision).toBe(1)
    expect(store.doc.view.graphs.g0!.nodes.n1!.color).toBe('#355c7d')
    expect(store.doc.view.graphs.g0!.nodes.n2).toEqual({ color: '#355c7d' })
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0!.nodes.n1!.color).toBeUndefined()
    expect(store.doc.view.graphs.g0!.nodes.n2).toBeUndefined()
  })

  it('view.removeGroup deletes only the rectangle; undo/redo restore it', () => {
    const store = makeStore()
    expect(createGroup(store).ok).toBe(true)
    expect(
      store.dispatch({ command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 10, y: 10 } } } }).ok,
    ).toBe(true)
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp0).toBeUndefined()
    // Nodes are untouched: membership is spatial, not stored.
    expect(store.doc.view.graphs.g0!.nodes.n1!.position).toEqual({ x: 10, y: 10 })

    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp0).toMatchObject({ title: 'Stage 1', bounds })
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.g0!.groups!.grp0).toBeUndefined()
  })

  it('group commands never change the semantic hash', () => {
    const store = makeStore()
    const before = semanticHashOf(store.doc)
    expect(createGroup(store, { color: '#123456' }).ok).toBe(true)
    expect(
      store.dispatch({
        command: 'view.moveGroup',
        params: { graphId: 'g0', groupId: 'grp0', bounds: { x: 9, y: 9 }, positions: {} },
      }).ok,
    ).toBe(true)
    expect(
      store.dispatch({
        command: 'view.setGroupBounds',
        params: { graphId: 'g0', groupId: 'grp0', bounds: { x: 9, y: 9, width: 10, height: 10 } },
      }).ok,
    ).toBe(true)
    expect(
      store.dispatch({ command: 'view.setGroupTitle', params: { graphId: 'g0', groupId: 'grp0', title: 'x' } }).ok,
    ).toBe(true)
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } }).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(before)
  })

  it('groups are scoped to one graph definition', () => {
    const store = new DocumentStore(
      doc({
        g0: graph({ id: 'g0', nodes: { n1: node('n1') } }),
        g1: graph({ id: 'g1', name: 'sub', boundary: { inputs: [], outputs: [] }, nodes: { m1: node('m1') } }),
      }),
      coreCommandRegistry(),
    )
    expect(
      store.dispatch({ command: 'view.createGroup', params: { graphId: 'g1', title: 'inner', bounds } }).ok,
    ).toBe(true)
    expect(store.doc.view.graphs.g1!.groups!.grp0).toBeDefined()
    expect(store.doc.view.graphs.g0?.groups?.grp0).toBeUndefined()
    // g0 has no grp0: commands must not reach across definitions.
    const out = store.dispatch({
      command: 'view.setGroupTitle',
      params: { graphId: 'g0', groupId: 'grp0', title: 'x' },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('group.missing')
  })
})

describe('view.moveBoundaryNode', () => {
  /** Root g0 + subgraph def 'sub' whose boundary has one input and one output.
   * The input's id contains a DOT on purpose: boundary ids are opaque and the
   * command must never parse them. */
  function makeBoundaryStore() {
    return new DocumentStore(
      doc({
        g0: graph({ id: 'g0', nodes: { n1: node('n1') } }),
        sub: graph({
          id: 'sub',
          name: 'sub',
          nodes: { m1: node('m1') },
          boundary: {
            inputs: [{ id: 'weird.id', binds: { kind: 'port', ...port('m1', 'model') } }],
            outputs: [{ id: 'image', binds: { kind: 'port', ...port('m1', 'out0') } }],
          },
        }),
      }),
      coreCommandRegistry(),
    )
  }
  const move = (side: string, position: Json, graphId = 'sub') => ({
    command: 'view.moveBoundaryNode',
    params: { graphId, side, position },
  })

  it('writes the side entry (creating view state) and undo/redo replays it', () => {
    const store = makeBoundaryStore()
    expect(store.dispatch(move('inputs', { x: -200, y: 40 })).ok).toBe(true)
    expect(store.doc.view.graphs.sub!.boundary).toEqual({ inputs: { position: { x: -200, y: 40 } } })
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.sub?.boundary).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.view.graphs.sub!.boundary).toEqual({ inputs: { position: { x: -200, y: 40 } } })
  })

  it('sides are independent: moving one never disturbs the other', () => {
    const store = makeBoundaryStore()
    expect(store.dispatch(move('inputs', { x: -200, y: 40 })).ok).toBe(true)
    expect(store.dispatch(move('outputs', { x: 700, y: 60 })).ok).toBe(true)
    expect(store.doc.view.graphs.sub!.boundary).toEqual({
      inputs: { position: { x: -200, y: 40 } },
      outputs: { position: { x: 700, y: 60 } },
    })
    // Re-moving inputs updates only inputs.
    expect(store.dispatch(move('inputs', { x: -250, y: 45 })).ok).toBe(true)
    expect(store.doc.view.graphs.sub!.boundary).toEqual({
      inputs: { position: { x: -250, y: 45 } },
      outputs: { position: { x: 700, y: 60 } },
    })
    // Undo peels back one move at a time.
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.sub!.boundary!.inputs).toEqual({ position: { x: -200, y: 40 } })
    expect(store.doc.view.graphs.sub!.boundary!.outputs).toEqual({ position: { x: 700, y: 60 } })
  })

  it('never touches document semantics (pure view state)', () => {
    const store = makeBoundaryStore()
    const before = semanticHashOf(store.doc)
    expect(store.dispatch(move('inputs', { x: 1, y: 2 })).ok).toBe(true)
    expect(store.dispatch(move('outputs', { x: 3, y: 4 })).ok).toBe(true)
    expect(semanticHashOf(store.doc)).toBe(before)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.id).toBe('weird.id')
  })

  it('rejects an unknown graph', () => {
    const store = makeBoundaryStore()
    const out = store.dispatch(move('inputs', { x: 0, y: 0 }, 'nope'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('graph.missing')
  })

  it('rejects a graph without a boundary (not a subgraph definition)', () => {
    const store = makeBoundaryStore()
    const out = store.dispatch(move('inputs', { x: 0, y: 0 }, 'g0'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('boundary.missing')
    expect(store.revision).toBe(0)
  })

  it('rejects malformed side or position', () => {
    const store = makeBoundaryStore()
    for (const bad of [
      move('sideways', { x: 0, y: 0 }),
      move('inputs', { x: 'a', y: 0 }),
      move('inputs', null),
      move('inputs', { x: 0 }),
    ]) {
      const out = store.dispatch(bad)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.diagnostics[0]!.code).toBe('params.invalid')
    }
    expect(store.revision).toBe(0)
  })
})

describe('view bookmarks (numbered camera shortcuts, view-only)', () => {
  /** Root g0 with a subgraph instance s1 of def 'sub' (plus an unrelated node). */
  function makeBookmarkStore() {
    return new DocumentStore(
      doc({
        g0: graph({ id: 'g0', nodes: { n1: node('n1'), s1: node('s1', '#sub') } }),
        sub: graph({
          id: 'sub',
          name: 'sub',
          nodes: { m1: node('m1') },
          boundary: { inputs: [], outputs: [] },
        }),
      }),
      coreCommandRegistry(),
    )
  }
  const view = { x: -120, y: 40, width: 640, height: 480 }
  const set = (params: Record<string, Json | readonly string[]>) => ({
    command: 'view.setBookmark',
    params: { slot: 1, graphStack: ['g0'], instancePath: [], view, ...params },
  })

  it('stores a root-graph bookmark under its slot key; undo/redo replays it', () => {
    const store = makeBookmarkStore()
    const semanticBefore = semanticHashOf(store.doc)
    expect(store.dispatch(set({})).ok).toBe(true)
    expect(store.doc.view.bookmarks).toEqual({
      '1': { graphStack: ['g0'], instancePath: [], view },
    })
    // Pure view state: the semantic hash is untouched.
    expect(semanticHashOf(store.doc)).toBe(semanticBefore)
    expect(store.undo()).toBe(true)
    expect(store.doc.view.bookmarks).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.view.bookmarks?.['1']).toBeDefined()
  })

  it('stores a nested bookmark when the instancePath instantiates each step', () => {
    const store = makeBookmarkStore()
    expect(store.dispatch(set({ slot: 10, graphStack: ['g0', 'sub'], instancePath: ['s1'] })).ok).toBe(true)
    expect(store.doc.view.bookmarks?.['10']).toEqual({
      graphStack: ['g0', 'sub'],
      instancePath: ['s1'],
      view,
    })
  })

  it('overwrites the same slot and keeps other slots independent', () => {
    const store = makeBookmarkStore()
    expect(store.dispatch(set({})).ok).toBe(true)
    expect(store.dispatch(set({ slot: 2, view: { x: 0, y: 0, width: 100, height: 50 } })).ok).toBe(true)
    expect(store.dispatch(set({ view: { x: 9, y: 9, width: 20, height: 30 } })).ok).toBe(true)
    expect(store.doc.view.bookmarks?.['1']!.view).toEqual({ x: 9, y: 9, width: 20, height: 30 })
    expect(store.doc.view.bookmarks?.['2']!.view).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('rejects incoherent navigation context', () => {
    const store = makeBookmarkStore()
    const cases: [Record<string, Json | readonly string[]>, string][] = [
      [{ graphStack: ['sub'], instancePath: [] }, 'bookmark.invalid'], // not rooted
      [{ graphStack: ['g0', 'nope'], instancePath: ['s1'] }, 'bookmark.invalid'], // s1 instantiates sub, not nope
      [{ graphStack: ['g0', 'sub'], instancePath: ['n1'] }, 'bookmark.invalid'], // n1 is not a subgraph instance
      [{ graphStack: ['g0', 'sub'], instancePath: ['ghost'] }, 'bookmark.invalid'], // no such node
      [{ graphStack: ['g0', 'sub'], instancePath: [] }, 'params.invalid'], // path/stack length mismatch
      [{ slot: 0 }, 'params.invalid'],
      [{ slot: 11 }, 'params.invalid'],
      [{ view: { x: 0, y: 0, width: 0, height: 10 } }, 'params.invalid'],
    ]
    for (const [params, code] of cases) {
      const out = store.dispatch(set(params))
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.diagnostics[0]!.code).toBe(code)
    }
    expect(store.revision).toBe(0)
  })

  it('validates rect coordinates and dimensions and requires exactly one camera shape', () => {
    const invalidViews = [
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: -1, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 0, y: 0, width: 10, height: -1 },
    ]
    for (const bad of invalidViews) {
      const store = makeBookmarkStore()
      expect(store.dispatch(set({ view: bad })).ok).toBe(false)
    }
    const neither = makeBookmarkStore()
    expect(neither.dispatch({
      command: 'view.setBookmark',
      params: { slot: 1, graphStack: ['g0'], instancePath: [] },
    }).ok).toBe(false)
    const both = makeBookmarkStore()
    expect(both.dispatch(set({ viewport: { x: 0, y: 0, scale: 1 } })).ok).toBe(false)
  })

  it('accepts and preserves legacy viewport command params for invocation compatibility', () => {
    const store = makeBookmarkStore()
    const legacy = { x: -10, y: 20, scale: 1.5 }
    const invocation = {
      command: 'view.setBookmark',
      params: { slot: 1, graphStack: ['g0'], instancePath: [], viewport: legacy },
    }
    expect(store.dispatch(invocation).ok).toBe(true)
    expect(store.doc.view.bookmarks?.['1']).toEqual({
      graphStack: ['g0'], instancePath: [], viewport: legacy,
    })
  })

  it('view.clearBookmark removes a slot; missing slots reject', () => {
    const store = makeBookmarkStore()
    expect(store.dispatch(set({})).ok).toBe(true)
    expect(store.dispatch({ command: 'view.clearBookmark', params: { slot: 1 } }).ok).toBe(true)
    expect(store.doc.view.bookmarks?.['1']).toBeUndefined()
    const missing = store.dispatch({ command: 'view.clearBookmark', params: { slot: 3 } })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.diagnostics[0]!.code).toBe('bookmark.missing')
  })
})

describe('FR1 group id allocation is monotonic across undo', () => {
  const boundsP = { x: 0, y: 0, width: 10, height: 10 }
  const create = (store: DocumentStore, title: string) =>
    store.dispatch({ command: 'view.createGroup', params: { graphId: 'g0', title, bounds: boundsP } })

  it('undoing a create keeps the cursor at its high-water mark', () => {
    const store = makeStore()
    // Materialize the view graph FIRST so this test exercises the direct
    // numeric-cursor replay path; the whole-object path (undo removes
    // view.graphs.g0 itself) has its own skeleton test below.
    expect(
      store.dispatch({ command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 1, y: 2 } } } }).ok,
    ).toBe(true)
    expect(create(store, 'a').ok).toBe(true)
    expect(create(store, 'b').ok).toBe(true)
    expect(store.undo()).toBe(true) // removes grp1, cursor keeps 2
    expect(store.doc.view.graphs.g0!.groups!.grp1).toBeUndefined()
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(2)
    expect(create(store, 'c').ok).toBe(true)
    // The recreated group gets a FRESH id, never the undone grp1 again.
    expect(Object.keys(store.doc.view.graphs.g0!.groups!).sort()).toEqual(['grp0', 'grp2'])
  })

  it('undoing the create that materialized the view graph keeps a cursor skeleton', () => {
    const store = makeStore()
    expect(store.doc.view.graphs.g0).toBeUndefined()
    expect(create(store, 'a').ok).toBe(true) // materializes view.graphs.g0 AND mints grp0
    expect(store.undo()).toBe(true)
    // The inverse whole-object remove is retargeted structurally: the
    // groups are gone, the allocation evidence is not (and nodes:{} keeps
    // ensureViewGraph's shape so later view writes still work).
    expect(store.doc.view.graphs.g0).toEqual({ nodes: {}, groupSeq: 1 })
    expect(create(store, 'b').ok).toBe(true)
    // The recreated group gets a FRESH id, never the undone grp0 again.
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp1'])
    // Undo/redo stay applicable across the clamp (existence re-targets).
    expect(store.undo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp1'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(2)
  })

  it('undoing a remove never rewinds a cursor the remove advanced', () => {
    const store = makeStore()
    expect(
      store.dispatch({ command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 1, y: 2 } } } }).ok,
    ).toBe(true)
    expect(create(store, 'a').ok).toBe(true)
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } }).ok).toBe(true)
    expect(store.undo()).toBe(true) // group is back...
    expect(store.doc.view.graphs.g0!.groups!.grp0).toBeDefined()
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(1) // ...cursor did not rewind
  })

  // Preservation is scoped to graphs whose SEMANTIC graph survives the
  // batch (FR1e): the TERMINAL exact ['graphs', g] op decides. Built-in
  // commands only record such shapes via subgraph.import, but extension
  // commands (coreCommandRegistry extra) can record any transaction.
  const boundary = { inputs: [], outputs: [] }
  const twoGraphDoc = () => {
    const d = doc({
      g0: graph({ id: 'g0', nodes: { n1: node('n1') } }),
      g1: graph({ id: 'g1', boundary, nodes: {} } as never),
    })
    ;(d.view.graphs as Record<string, unknown>).g0 = { nodes: {} }
    ;(d.view.graphs as Record<string, unknown>).g1 = { nodes: {}, groupSeq: 5 }
    return d
  }

  it('a whole view.graphs replacement never resurrects a skeleton for a graph that leaves', () => {
    const removeGraphAndResetViews = {
      id: 'test.removeGraphAndResetViews',
      run(_doc: WorkflowDocument, _params: unknown, tx: { set: (p: (string | number)[], v: Json) => void; remove: (p: (string | number)[]) => void }) {
        tx.remove(['graphs', 'g1'])
        tx.set(['view', 'graphs'], { g0: { nodes: {} } })
        return []
      },
    }
    const store = new DocumentStore(twoGraphDoc(), coreCommandRegistry([removeGraphAndResetViews as never]))
    expect(store.dispatch({ command: 'test.removeGraphAndResetViews', params: {} }).ok).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g1).toBeDefined()
    expect(store.doc.view.graphs.g1).toEqual({ nodes: {}, groupSeq: 5 })
    // Redo replays the whole-map replace: the map preserver must NOT
    // reinsert a {nodes, groupSeq} skeleton for g1 - its semantic graph
    // terminally leaves this batch (I8 doc.view.danglingGraph otherwise).
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g1).toBeUndefined()
    expect(store.doc.view.graphs.g1).toBeUndefined()
  })

  it('a whole graphs-map replacement counts as the graph leaving (no skeleton)', () => {
    // The batch never touches ['graphs', 'g1'] exactly - it replaces the
    // WHOLE semantic graphs map. Final membership must be derived from
    // that op too, or redo would resurrect g1's view skeleton next to a
    // graphs map that no longer contains it.
    const resetBothMaps = {
      id: 'test.resetBothMaps',
      run(d: WorkflowDocument, _params: unknown, tx: { set: (p: (string | number)[], v: Json) => void }) {
        tx.set(['graphs'], { g0: d.graphs.g0 } as unknown as Json)
        tx.set(['view', 'graphs'], { g0: { nodes: {} } })
        return []
      },
    }
    const store = new DocumentStore(twoGraphDoc(), coreCommandRegistry([resetBothMaps as never]))
    expect(store.dispatch({ command: 'test.resetBothMaps', params: {} }).ok).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g1).toBeDefined()
    expect(store.doc.view.graphs.g1).toEqual({ nodes: {}, groupSeq: 5 })
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g1).toBeUndefined()
    expect(store.doc.view.graphs.g1).toBeUndefined()
  })

  it('remove-then-re-add of a graph in one batch keeps cursor preservation ON', () => {
    const churnGraph = {
      id: 'test.churnGraph',
      run(d: WorkflowDocument, _params: unknown, tx: { set: (p: (string | number)[], v: Json) => void; remove: (p: (string | number)[]) => void }) {
        const def = d.graphs.g1 as unknown as Json
        tx.remove(['graphs', 'g1'])
        tx.set(['graphs', 'g1'], def)
        tx.remove(['view', 'graphs', 'g1'])
        return []
      },
    }
    const store = new DocumentStore(twoGraphDoc(), coreCommandRegistry([churnGraph as never]))
    expect(store.dispatch({ command: 'test.churnGraph', params: {} }).ok).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g1).toEqual({ nodes: {}, groupSeq: 5 })
    // Redo replays remove + re-add of graphs.g1 (terminal op: add - the
    // graph SURVIVES), so the view-graph remove must still be retargeted
    // into a cursor skeleton, never applied verbatim.
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g1).toBeDefined()
    expect(store.doc.view.graphs.g1).toEqual({ nodes: {}, groupSeq: 5 })
  })
})

describe('FR2 reentrant observers see commits in order', () => {
  const boundsP = { x: 0, y: 0, width: 10, height: 10 }
  const create = (store: DocumentStore, title: string) =>
    store.dispatch({ command: 'view.createGroup', params: { graphId: 'g0', title, bounds: boundsP } })
  const titles = (d: WorkflowDocument) =>
    Object.values(d.view.graphs.g0?.groups ?? {}).map((g) => g.title)

  it('a document listener that dispatches cannot reorder later document listeners', () => {
    const store = makeStore()
    let reentered = false
    const seen: string[][] = []
    store.document.subscribe(() => {
      if (!reentered) {
        reentered = true
        expect(create(store, 'nested').ok).toBe(true)
        // The nested commit is authoritative IMMEDIATELY for readers...
        expect(titles(store.doc)).toEqual(['outer', 'nested'])
      }
    })
    store.document.subscribe((d) => seen.push(titles(d)))
    expect(create(store, 'outer').ok).toBe(true)
    // ...but its NOTIFICATIONS queue behind the outer commit's, so every
    // listener observes documents in exact commit order.
    expect(seen).toEqual([['outer'], ['outer', 'nested']])
  })

  it('a transaction listener that dispatches gets events in revision order with matching records', () => {
    const store = makeStore()
    let reentered = false
    const events: { revision: number; recordRevision: number; title: unknown }[] = []
    store.onTransaction(() => {
      if (!reentered) {
        reentered = true
        expect(create(store, 'nested').ok).toBe(true)
      }
    })
    store.onTransaction((e) =>
      events.push({
        revision: e.revision,
        recordRevision: e.record.revision,
        title: (e.record.invocation.params as { title?: string }).title,
      }),
    )
    expect(create(store, 'outer').ok).toBe(true)
    // Without the queue, the nested event would OVERTAKE the outer one and
    // the outer event would report the moved counter (revision 2 with a
    // revision-1 record).
    expect(events).toEqual([
      { revision: 1, recordRevision: 1, title: 'outer' },
      { revision: 2, recordRevision: 2, title: 'nested' },
    ])
  })

  it('an undo dispatched from a transaction listener queues behind the outer commit too', () => {
    const store = makeStore()
    let reentered = false
    const kinds: string[] = []
    store.onTransaction(() => {
      if (!reentered) {
        reentered = true
        expect(store.undo()).toBe(true) // undoes the just-committed create
      }
    })
    store.onTransaction((e) => kinds.push(`${e.kind}@${e.revision}`))
    expect(create(store, 'outer').ok).toBe(true)
    expect(kinds).toEqual(['dispatch@1', 'undo@2'])
    expect(titles(store.doc)).toEqual([])
  })
})
