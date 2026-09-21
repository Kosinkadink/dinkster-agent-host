/**
 * DocumentSession seam (platform-plan 2.3): the local implementation over
 * DocumentStore, its envelope-shaped op feed, and the collab wire patch
 * conversion (Dinkster ca01157: add|remove|replace, segment-array paths,
 * value absent on remove, no oldValue).
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import type { PatchOp } from '../src/commands/patch.js'
import { createLocalSession, toWirePatch, type SessionOp } from '../src/commands/session.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId } from '../src/ids.js'

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

function makeSession(actorId?: string) {
  const ops: SessionOp[] = []
  const session = createLocalSession(
    doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
      }),
    }),
    coreCommandRegistry(),
    { ...(actorId !== undefined ? { actorId } : {}), clock: () => 12345 },
  )
  session.onOp((op) => ops.push(op))
  return { session, ops }
}

const addNode = { command: 'node.add', params: { graphId: 'g0', type: 'X', position: { x: 0, y: 0 } } }

describe('local DocumentSession', () => {
  it('predicts the same solo node id that node.add mints, and reports a missing graph', () => {
    const { session } = makeSession()
    expect(session.predictedNodeId('missing')).toBeUndefined()
    const predicted = session.predictedNodeId('g0')
    expect(predicted).toBe('n100')
    expect(session.dispatch(addNode).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes[predicted!]).toBeDefined()
  })

  it('exposes the store contract: dispatch commits, revision advances, document signal updates', () => {
    const { session } = makeSession()
    expect(session.revision).toBe(0)
    const out = session.dispatch(addNode)
    expect(out.ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.doc).toBe(session.document.get())
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
  })

  it('emits an envelope-shaped op per committed dispatch with contiguous revisions', () => {
    const { session, ops } = makeSession('actor-a')
    session.dispatch(addNode)
    session.dispatch(addNode)
    expect(ops).toHaveLength(2)
    expect(ops[0]).toMatchObject({
      actorId: 'actor-a',
      baseRevision: 0,
      revision: 1,
      timestamp: 12345,
      origin: 'node.add',
    })
    expect(ops[1]!.baseRevision).toBe(1)
    expect(ops[1]!.revision).toBe(2)
    expect(ops[0]!.opId).not.toBe(ops[1]!.opId)
    expect(ops[0]!.patch.length).toBeGreaterThan(0)
  })

  it('has no allocation actor even with a custom actorId: local dispatch never stamps one', () => {
    const { session } = makeSession('actor-a')
    expect(session.allocationActor).toBeUndefined()
  })

  it('emits nothing for a rejected dispatch', () => {
    const { session, ops } = makeSession()
    expect(session.dispatch({ command: 'nope', params: {} }).ok).toBe(false)
    expect(ops).toHaveLength(0)
  })

  it('CO3/CO4 undo/redo are ops too: wire-shaped applied patches, revisions still advancing', () => {
    const { session, ops } = makeSession()
    const out = session.dispatch(addNode)
    if (!out.ok) throw new Error('unreachable')
    session.undo()
    session.redo()
    expect(ops.map((o) => o.origin)).toEqual(['node.add', 'session.undo', 'session.redo'])
    expect(ops.map((o) => [o.baseRevision, o.revision])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
    // CO4: the envelope carries the wire shape - no local oldValue, ever.
    for (const op of ops.flatMap((o) => o.patch)) {
      expect(op).not.toHaveProperty('oldValue')
    }
    // CO3: the undo op reports what actually applied - the allocation
    // cursor (nextOrdinal) is NOT rewound, so its inverse op is absent.
    const undoPaths = ops[1]!.patch.map((p) => p.path.join('/'))
    expect(undoPaths).not.toContain('graphs/g0/nextOrdinal')
    expect(undoPaths.some((p) => p.startsWith('graphs/g0/nodes/'))).toBe(true)
    // Redo replays the forward patch on the wire, minus the cursor no-op.
    expect(ops[2]!.patch).toEqual(
      toWirePatch(out.forward).filter((p) => p.path.join('/') !== 'graphs/g0/nextOrdinal'),
    )
  })

  it('CO4 wire ops are frozen: one listener cannot alter what the next receives', () => {
    const { session, ops } = makeSession()
    session.dispatch(addNode)
    const op = ops[0]!
    expect(Object.isFrozen(op)).toBe(true)
    expect(Object.isFrozen(op.patch)).toBe(true)
    for (const p of op.patch) expect(Object.isFrozen(p)).toBe(true)
  })

  it('clearHistory adopts the current document as baseline: no undo/redo, doc and revision untouched, no op emitted', () => {
    const { session, ops } = makeSession()
    session.dispatch(addNode)
    session.undo()
    expect(session.canRedo).toBe(true)
    const docBefore = session.doc
    const revisionBefore = session.revision
    const opsBefore = ops.length
    session.clearHistory()
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(false)
    expect(session.undo()).toBe(false)
    expect(session.redo()).toBe(false)
    expect(session.doc).toBe(docBefore) // the document did not change...
    expect(session.revision).toBe(revisionBefore) // ...and neither did its revision
    expect(ops.length).toBe(opsBefore) // nothing rode the op feed
  })

  it('unsubscribing stops the feed', () => {
    const ops: SessionOp[] = []
    const session = createLocalSession(doc({ g0: graph({ id: 'g0' }) }), coreCommandRegistry())
    const off = session.onOp((op) => ops.push(op))
    off()
    session.dispatch(addNode)
    expect(ops).toHaveLength(0)
  })

  it('FR2 an op listener that dispatches synchronously still yields contiguous ops in commit order', () => {
    const { session, ops } = makeSession('actor-a')
    let reentered = false
    session.onOp(() => {
      if (!reentered) {
        reentered = true
        expect(session.dispatch(addNode).ok).toBe(true)
      }
    })
    session.dispatch(addNode)
    // Without the store's notification queue, the nested commit's op would
    // OVERTAKE the outer one: both ops would claim baseRevision 1 and the
    // contiguous-session contract would break.
    expect(ops.map((o) => [o.baseRevision, o.revision])).toEqual([
      [0, 1],
      [1, 2],
    ])
    expect(ops.map((o) => o.opId)).toEqual(['actor-a#1', 'actor-a#2'])
  })
})

describe('toWirePatch', () => {
  it('keeps value on add/replace, strips it from remove, and never carries oldValue', () => {
    const forward: PatchOp[] = [
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n9'], value: { id: 'n9' } },
      { op: 'replace', path: ['graphs', 'g0', 'nextOrdinal'], value: 101, oldValue: 100 },
      { op: 'remove', path: ['graphs', 'g0', 'links', 'l4'], oldValue: { id: 'l4' } },
    ]
    expect(toWirePatch(forward)).toEqual([
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n9'], value: { id: 'n9' } },
      { op: 'replace', path: ['graphs', 'g0', 'nextOrdinal'], value: 101 },
      { op: 'remove', path: ['graphs', 'g0', 'links', 'l4'] },
    ])
    for (const wireOp of toWirePatch(forward)) {
      expect('oldValue' in wireOp).toBe(false)
    }
  })
})
