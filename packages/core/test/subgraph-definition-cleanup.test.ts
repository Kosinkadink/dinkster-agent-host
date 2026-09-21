import { describe, expect, it } from 'vitest'
import type { WorkflowDocument } from '../src/format/document.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { createLocalSession } from '../src/commands/session.js'
import { planSubgraphDefinitionCleanup } from '../src/lifecycle/definition-cleanup.js'
import { checkDocument } from '../src/invariants.js'

const graph = (id: string, name: string, nodes: Record<string, unknown> = {}) => ({
  id,
  name,
  nodes,
  links: {},
  nets: {},
  reroutes: {},
  nextOrdinal: 10,
})

const cleanupDocument = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'cleanup-test' as never,
  root: 'root' as never,
  graphs: {
    root: graph('root', 'Root', {
      used: { id: 'used', type: '#used', values: {} },
    }) as never,
    used: graph('used', 'Used') as never,
    orphanParent: graph('orphanParent', 'Orphan parent', {
      child: { id: 'child', type: '#orphanChild', values: {} },
    }) as never,
    orphanChild: graph('orphanChild', 'Orphan child', {
      leaf: { id: 'leaf', type: 'Leaf', values: {} },
    }) as never,
  },
  view: {
    graphs: {
      root: { nodes: { used: { position: { x: 0, y: 0 } } } },
      used: { nodes: {} },
      orphanParent: { nodes: { child: { position: { x: 0, y: 0 } } } },
      orphanChild: { nodes: { leaf: { position: { x: 0, y: 0 } } } },
    },
    bookmarks: {
      '1': {
        graphStack: ['root', 'orphanParent'],
        instancePath: ['missing'],
        view: { x: 0, y: 0, width: 100, height: 100 },
      },
    },
  },
  surfaces: {
    modes: {
      id: 'modes' as never,
      type: 'core.modePanel',
      config: {
        futureSetting: { preserved: true },
        bindings: [
          { kind: 'node', graphId: 'used', nodeId: 'kept', futureBindingField: 7 },
          { kind: 'node', graphId: 'orphanChild', nodeId: 'leaf' },
        ],
      },
    },
  },
  ext: {
    'dinkster.exposed': [
      { graphId: 'used', nodeId: 'kept', inputId: 'value' },
      { graphId: 'orphanChild', nodeId: 'leaf', inputId: 'value' },
    ],
    'dinkster.appLayout': {
      version: 1,
      desktop: { items: [
        { id: 'used-control', kind: 'control', ref: { graphId: 'used', nodeId: 'kept', inputId: 'value' } },
        { id: 'orphan-control', kind: 'control', ref: { graphId: 'orphanChild', nodeId: 'leaf', inputId: 'value' } },
        { id: 'controls', kind: 'group', title: 'Controls', children: ['used-control', 'orphan-control'] },
      ] },
      mobile: { customized: true, items: [], order: ['controls', 'orphan-control', 'used-control'] },
    },
    'dinkster.netViews': [
      { graphId: 'orphanParent', netId: 'net', role: 'source', position: { x: 1, y: 2 } },
    ],
  },
})

const cleanupInvocation = (doc: WorkflowDocument) => {
  const plan = planSubgraphDefinitionCleanup(doc)
  return {
    command: 'subgraph.removeUnusedDefinitions',
    params: {
      definitionIds: plan.removable.map((entry) => entry.id),
      fingerprint: plan.fingerprint,
    },
  } as const
}

describe('subgraph definition cleanup', () => {
  it('finds root-unreachable definition trees rather than only zero-inbound definitions', () => {
    const plan = planSubgraphDefinitionCleanup(cleanupDocument())
    expect(plan.removable.map((entry) => entry.id)).toEqual(['orphanChild', 'orphanParent'])
    expect(plan.removable.find((entry) => entry.id === 'orphanChild')).toMatchObject({
      occurrenceCount: 1,
      relatedItemCount: 3,
      nodeCount: 1,
    })
    expect(plan.retained.map((entry) => entry.id)).toEqual(['used'])
  })

  it('removes the reviewed unreachable closure and its core-owned support state atomically', () => {
    const initial = cleanupDocument()
    const session = createLocalSession(initial, coreCommandRegistry())
    const rootCursor = initial.graphs.root!.nextOrdinal
    const outcome = session.dispatch(cleanupInvocation(initial))

    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(Object.keys(session.doc.graphs).sort()).toEqual(['root', 'used'])
    expect(Object.keys(session.doc.view.graphs).sort()).toEqual(['root', 'used'])
    expect(session.doc.graphs.root!.nextOrdinal).toBe(rootCursor)
    expect(session.doc.view.bookmarks).toEqual({})
    expect(session.doc.ext?.['dinkster.exposed']).toEqual([
      { graphId: 'used', nodeId: 'kept', inputId: 'value' },
    ])
    expect(session.doc.ext?.['dinkster.appLayout']).toEqual({
      version: 1,
      desktop: { items: [
        { id: 'used-control', kind: 'control', ref: { graphId: 'used', nodeId: 'kept', inputId: 'value' } },
        { id: 'controls', kind: 'group', title: 'Controls', children: ['used-control'] },
      ] },
      mobile: { customized: true, items: [], order: ['controls', 'used-control'] },
    })
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([])
    expect(session.doc.surfaces?.modes?.config).toEqual({
      futureSetting: { preserved: true },
      bindings: [{ kind: 'node', graphId: 'used', nodeId: 'kept', futureBindingField: 7 }],
    })

    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(Object.keys(session.doc.graphs).sort()).toEqual(['root', 'used'])
  })

  it('rejects stale cleanup and preserves document bytes and cursors', () => {
    const initial = cleanupDocument()
    const invocation = cleanupInvocation(initial)
    const changed = structuredClone(initial) as any
    changed.graphs.orphanParent.name = 'Changed after preview'
    const session = createLocalSession(changed, coreCommandRegistry())
    const before = JSON.stringify(session.doc)

    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.cleanup.stalePlan')
    expect(JSON.stringify(session.doc)).toBe(before)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(10)
  })

  it('rejects a preview after definition content changes without changing reachability', () => {
    const initial = cleanupDocument()
    const invocation = cleanupInvocation(initial)
    const changed = structuredClone(initial) as any
    changed.graphs.orphanChild.nodes.added = { id: 'added', type: 'Leaf', values: { amount: 2 }, ext: { future: true } }
    const session = createLocalSession(changed, coreCommandRegistry())
    const before = JSON.stringify(session.doc)

    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.cleanup.stalePlan')
    expect(JSON.stringify(session.doc)).toBe(before)
  })

  it('deletes only a leaf definition individually and refuses one with an incoming orphan reference', () => {
    const initial = cleanupDocument()
    const plan = planSubgraphDefinitionCleanup(initial)
    const parentSession = createLocalSession(initial, coreCommandRegistry())
    const parent = parentSession.dispatch({
      command: 'subgraph.deleteDefinition',
      params: { definitionId: 'orphanChild', fingerprint: plan.fingerprint },
    })
    expect(parent.ok).toBe(false)
    if (!parent.ok) expect(parent.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.cleanup.definitionInUse')

    const leafSession = createLocalSession(initial, coreCommandRegistry())
    expect(leafSession.dispatch({
      command: 'subgraph.deleteDefinition',
      params: { definitionId: 'orphanParent', fingerprint: plan.fingerprint },
    }).ok).toBe(true)
    expect(leafSession.doc.graphs.orphanParent).toBeUndefined()
    expect(leafSession.doc.graphs.orphanChild).toBeDefined()
  })

  it('replays the same cleanup invocation to the same document', () => {
    const initial = cleanupDocument()
    const invocation = cleanupInvocation(initial)
    const first = createLocalSession(initial, coreCommandRegistry())
    const second = createLocalSession(initial, coreCommandRegistry())
    expect(first.dispatch(invocation).ok).toBe(true)
    expect(second.dispatch(invocation).ok).toBe(true)
    expect(second.doc).toEqual(first.doc)
  })

  it('terminates on an invalid orphan cycle while document validation rejects the cycle', () => {
    const cyclic = structuredClone(cleanupDocument()) as any
    cyclic.graphs.orphanChild.nodes.back = { id: 'back', type: '#orphanParent', values: {} }
    const problems = checkDocument(cyclic).map((diagnostic) => diagnostic.code)
    expect(problems).toContain('doc.subgraph.recursive')
    expect(planSubgraphDefinitionCleanup(cyclic).removable.map((entry) => entry.id))
      .toEqual(['orphanChild', 'orphanParent'])
  })
})
