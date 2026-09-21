/**
 * Actor-scoped id allocation (multiplayer prerequisite; commands/alloc.ts).
 *
 * Two collab actors dispatching concurrently from one graph-wide cursor
 * would mint the same id, and server ordering cannot repair that. With an
 * actor on the invocation, ids mint as `<prefix><ordinal>-<actor>` from that
 * actor's own cursor (GraphDef.actorCursors), and each actor writes only
 * its own cursor key.
 *
 * Solo mode (no actor) must remain byte-for-byte unchanged.
 */
import { describe, expect, it } from 'vitest'
import { planClipboardPaste, serializeSelection } from '../src/clipboard.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { validateDocumentShape } from '../src/format/validate.js'
import { actorCursorOf, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asSelectorCandidateId, asSelectorId, formatAllocatedId, isValidActorId, parseAllocatedId } from '../src/ids.js'
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

const makeStore = (d?: WorkflowDocument) =>
  new DocumentStore(d ?? doc({ g0: graph({ id: 'g0' }) }), coreCommandRegistry())

const addNode = (store: DocumentStore, actor?: string) =>
  store.dispatch({
    command: 'node.add',
    params: { graphId: 'g0', type: 'CLIPTextEncode', position: { x: 0, y: 0 } },
    ...(actor !== undefined ? { actor } : {}),
  })

describe('id parsing primitives', () => {
  it('parses canonical solo and actor-suffixed ids, including hyphenated actors', () => {
    expect(parseAllocatedId('n5')).toEqual({ prefix: 'n', ordinal: 5 })
    expect(parseAllocatedId('net12')).toEqual({ prefix: 'net', ordinal: 12 })
    expect(parseAllocatedId('n5-alice')).toEqual({ prefix: 'n', ordinal: 5, actor: 'alice' })
    // Actor ids may contain '-' (UUIDs): everything after the FIRST
    // separator following the digits is the actor, never a naive split.
    expect(parseAllocatedId('l3-6f72-4c1d-9e')).toEqual({ prefix: 'l', ordinal: 3, actor: '6f72-4c1d-9e' })
    expect(formatAllocatedId('n', 5, '6f72-4c1d')).toBe('n5-6f72-4c1d')
  })

  it('rejects non-canonical lookalikes (groupIdFloor discipline)', () => {
    expect(parseAllocatedId('n007')).toBeUndefined() // leading zeros
    expect(parseAllocatedId('n9007199254740993')).toBeUndefined() // above safe range
    expect(parseAllocatedId('n5-')).toBeUndefined() // empty actor
    expect(parseAllocatedId('n5-a.b')).toBeUndefined() // reserved char in actor
    expect(parseAllocatedId('myNode')).toBeUndefined() // no ordinal
  })

  it('accepts the safe actor alphabet and nothing else', () => {
    expect(isValidActorId('a1-B2_c')).toBe(true)
    expect(isValidActorId('e1c9a7de-2b4f-4b3f-9a10-000000000001')).toBe(true)
    for (const bad of ['', 'a.b', 'a b', 'a/b', 'a[b', 'a#b', 'a$b', 'a"b']) {
      expect(isValidActorId(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it("rejects '__proto__' and non-string input (wire ingress hardening)", () => {
    // '__proto__' matches the charset but can never be an own plain-object
    // key, so it could never round-trip through actorCursors.
    expect(isValidActorId('__proto__')).toBe(false)
    expect(parseAllocatedId('n5-__proto__')).toBeUndefined()
    for (const bad of [undefined, null, 5, {}, ['alice']]) {
      expect(isValidActorId(bad)).toBe(false)
    }
  })

  it('actorCursorOf reads OWN keys only: prototype names get their own cursor, never the inherited member', () => {
    // Without hasOwn discipline, actor 'constructor' would read
    // Object.prototype.constructor (a function), poisoning allocation and
    // NaN-ing the I6 comparison.
    expect(actorCursorOf(undefined, 'constructor')).toBe(0)
    expect(actorCursorOf({ alice: 3 }, 'constructor')).toBe(0)
    expect(actorCursorOf({ constructor: 7 }, 'constructor')).toBe(7)
    expect(actorCursorOf({ alice: 3 }, 'toString')).toBe(0)
  })
})

describe('solo allocation is byte-for-byte unchanged', () => {
  it('mints plain ids from nextOrdinal and records the same patch shape as before', () => {
    const store = makeStore()
    const out = addNode(store)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(store.doc.graphs.g0!.nodes.n100).toBeDefined()
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(101)
    expect(store.doc.graphs.g0!.actorCursors).toBeUndefined()
    // The cursor op is the plain nextOrdinal write - no actorCursors op.
    expect(out.forward.some((op) => op.path.join('/') === 'graphs/g0/nextOrdinal')).toBe(true)
    expect(out.forward.some((op) => op.path.includes('actorCursors'))).toBe(false)
  })
})

describe('actor-scoped allocation', () => {
  it('two actors from the same document state mint DIFFERENT ids', () => {
    // Same base document for both stores: this is exactly the concurrent
    // collab race (both actors at the same revision). Solo allocation
    // would mint n100 twice.
    const a = makeStore()
    const b = makeStore()
    const outA = addNode(a, 'alice')
    const outB = addNode(b, 'bob')
    expect(outA.ok && outB.ok).toBe(true)
    expect(Object.keys(a.doc.graphs.g0!.nodes)).toEqual(['n0-alice'])
    expect(Object.keys(b.doc.graphs.g0!.nodes)).toEqual(['n0-bob'])
  })

  it('each actor advances ONLY its own cursor key; solo cursor untouched', () => {
    const store = makeStore()
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(addNode(store, 'bob').ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.actorCursors).toEqual({ alice: 2, bob: 1 })
    expect(g.nextOrdinal).toBe(100) // never consumed by actor allocation
    expect(Object.keys(g.nodes).sort()).toEqual(['n0-alice', 'n1-alice', 'n0-bob'].sort())
  })

  it('solo and actor allocation coexist on one graph without interference', () => {
    const store = makeStore()
    expect(addNode(store).ok).toBe(true) // n100 (solo)
    expect(addNode(store, 'alice').ok).toBe(true) // n0-alice
    expect(addNode(store).ok).toBe(true) // n101 (solo)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes).sort()).toEqual(['n100', 'n101', 'n0-alice'].sort())
    expect(g.nextOrdinal).toBe(102)
    expect(g.actorCursors).toEqual({ alice: 1 })
  })

  it('multi-id commands advance one actor cursor across all mints (reroute.insert)', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1'), n2: node('n2') },
          links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'reroute.insert',
      params: { graphId: 'g0', linkId: 'l4', position: { x: 1, y: 2 } },
      actor: 'alice',
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.reroutes['r0-alice']).toBeDefined()
    expect(g.links['l1-alice']).toBeDefined()
    expect(g.links['l2-alice']).toBeDefined()
    expect(g.actorCursors).toEqual({ alice: 3 })
  })

  it('rejects an invalid actor id atomically at dispatch ingress', () => {
    const store = makeStore()
    for (const bad of ['', 'a.b', 'a b', 'a/b', '$region']) {
      const out = addNode(store, bad)
      expect(out.ok, JSON.stringify(bad)).toBe(false)
      if (!out.ok) expect(out.diagnostics[0]!.code).toBe('command.actor.invalid')
    }
    expect(store.revision).toBe(0)
  })
})

describe('undo/redo: actor cursors are never rewound (CO3)', () => {
  it('undoing the FIRST actor allocation keeps the cursor high-water mark', () => {
    const store = makeStore()
    expect(addNode(store, 'alice').ok).toBe(true) // creates actorCursors map
    expect(store.undo()).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes['n0-alice']).toBeUndefined() // the node IS un-added
    expect(g.actorCursors).toEqual({ alice: 1 }) // the cursor is NOT
    // Re-allocating after undo mints a FRESH id - never n0-alice again.
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes['n1-alice']).toBeDefined()
    expect(store.doc.graphs.g0!.nodes['n0-alice']).toBeUndefined()
  })

  it('undo keeps OTHER actors cursors too, and redo replays deterministically', () => {
    const store = makeStore()
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(addNode(store, 'bob').ok).toBe(true)
    expect(store.undo()).toBe(true) // un-adds bob's node
    expect(store.undo()).toBe(true) // un-adds alice's node (whole-map inverse)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes)).toEqual([])
    expect(g.actorCursors).toEqual({ alice: 1, bob: 1 })
    expect(store.redo()).toBe(true)
    expect(store.redo()).toBe(true)
    const g2 = store.doc.graphs.g0!
    expect(Object.keys(g2.nodes).sort()).toEqual(['n0-alice', 'n0-bob'].sort())
    expect(g2.actorCursors).toEqual({ alice: 1, bob: 1 })
  })
})

describe('I6 invariant: actor-suffixed ids check against their actor cursor', () => {
  it('flags an actor id at/above its cursor and accepts one below', () => {
    const bad = doc({
      g0: graph({ id: 'g0', nodes: { 'n5-alice': node('n5-alice') }, actorCursors: { alice: 5 } }),
    })
    expect(checkDocument(bad).some((d) => d.code === 'doc.id.aboveCursor')).toBe(true)
    const missing = doc({ g0: graph({ id: 'g0', nodes: { 'n0-alice': node('n0-alice') } }) })
    expect(checkDocument(missing).some((d) => d.code === 'doc.id.aboveCursor')).toBe(true)
    const good = doc({
      g0: graph({ id: 'g0', nodes: { 'n5-alice': node('n5-alice') }, actorCursors: { alice: 6 } }),
    })
    expect(checkDocument(good).some((d) => d.code === 'doc.id.aboveCursor')).toBe(false)
  })

  it('actor ids never check against nextOrdinal (disjoint id spaces)', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nextOrdinal: 0, // way below the actor ordinal - must not matter
        nodes: { 'n5-alice': node('n5-alice') },
        actorCursors: { alice: 6 },
      }),
    })
    expect(checkDocument(d).some((d2) => d2.code === 'doc.id.aboveCursor')).toBe(false)
  })

  it('selector candidate ids take the same cursor gate (solo and actor)', () => {
    const selWith = (cid: string) => ({
      sel1: {
        id: asSelectorId('sel1'),
        candidates: [{ id: asSelectorCandidateId(cid) }],
        policy: { kind: 'fixed', candidate: asSelectorCandidateId(cid) } as const,
      },
    })
    // Actor candidate at/above its cursor: corrupt.
    const badActor = doc({ g0: graph({ id: 'g0', selectors: selWith('c5-alice'), actorCursors: { alice: 5 } }) })
    expect(checkDocument(badActor).some((d) => d.code === 'doc.id.aboveCursor')).toBe(true)
    // Solo candidate at/above nextOrdinal: corrupt.
    const badSolo = doc({ g0: graph({ id: 'g0', nextOrdinal: 5, selectors: selWith('c5') }) })
    expect(checkDocument(badSolo).some((d) => d.code === 'doc.id.aboveCursor')).toBe(true)
    // Below the cursor: clean.
    const good = doc({ g0: graph({ id: 'g0', selectors: selWith('c5-alice'), actorCursors: { alice: 6 } }) })
    expect(checkDocument(good).some((d) => d.code === 'doc.id.aboveCursor')).toBe(false)
  })

  it('candidate identity stays selector-scoped: cross-selector reuse is legal, same-selector repeats are not', () => {
    // Legitimate producers (format/synthetic.ts among them) reuse candidate
    // ids across selectors - candidates are addressed as (selector,
    // candidate) pairs, so this is NOT a duplicate.
    const sel = (sid: string) => ({
      id: asSelectorId(sid),
      candidates: [{ id: asSelectorCandidateId('ca') }],
      policy: { kind: 'fixed', candidate: asSelectorCandidateId('ca') } as const,
    })
    const shared = doc({ g0: graph({ id: 'g0', selectors: { sel1: sel('sel1'), sel2: sel('sel2') } }) })
    expect(checkDocument(shared).filter((d) => d.severity === 'error')).toEqual([])
    // Same-selector repeats stay flagged.
    const duped = doc({
      g0: graph({
        id: 'g0',
        selectors: {
          sel1: {
            id: asSelectorId('sel1'),
            candidates: [{ id: asSelectorCandidateId('ca') }, { id: asSelectorCandidateId('ca') }],
            policy: { kind: 'fixed', candidate: asSelectorCandidateId('ca') } as const,
          },
        },
      }),
    })
    expect(checkDocument(duped).some((d) => d.code === 'doc.selector.candidateDuplicate')).toBe(true)
  })

  it("an actor named 'constructor' allocates from zero and advances its OWN cursor", () => {
    const store = makeStore()
    expect(addNode(store, 'constructor').ok).toBe(true)
    expect(addNode(store, 'constructor').ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes).sort()).toEqual(['n0-constructor', 'n1-constructor'])
    expect(Object.hasOwn(g.actorCursors!, 'constructor')).toBe(true)
    expect(g.actorCursors!['constructor']).toBe(2)
    expect(checkDocument(store.doc).some((d) => d.code === 'doc.id.aboveCursor')).toBe(false)
  })
})

describe('document format: actorCursors', () => {
  it('documents without actorCursors stay valid (no format bump)', () => {
    const d = doc({ g0: graph({ id: 'g0' }) })
    expect(validateDocumentShape(d).filter((x) => x.severity === 'error')).toEqual([])
  })

  it('rejects invalid actor keys and non-integer cursors on load', () => {
    const badKey = doc({ g0: graph({ id: 'g0', actorCursors: { 'a.b': 1 } }) })
    expect(validateDocumentShape(badKey).some((x) => x.severity === 'error')).toBe(true)
    const badVal = doc({ g0: graph({ id: 'g0', actorCursors: { alice: 1.5 } }) })
    expect(validateDocumentShape(badVal).some((x) => x.severity === 'error')).toBe(true)
  })
})

describe('clipboard paste under actor allocation', () => {
  const source = (): WorkflowDocument =>
    doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
      }),
    }) as WorkflowDocument & { view: { graphs: Record<string, unknown> } }

  const withView = (): WorkflowDocument => {
    const d = source()
    return {
      ...d,
      view: {
        graphs: {
          g0: { nodes: { n1: { position: { x: 0, y: 0 } }, n2: { position: { x: 50, y: 0 } } } },
        },
      },
    } as WorkflowDocument
  }

  it('predicts actor-suffixed ids that dispatch then mints EXACTLY', () => {
    const d = withView()
    const envelope = serializeSelection(d, 'g0', { nodes: ['n1', 'n2'], reroutes: [] })!
    const plan = planClipboardPaste(d, 'g0', envelope, { x: 10, y: 10 }, 'alice')!
    expect(plan.nodeIds).toEqual(['n0-alice', 'n1-alice'])
    expect(plan.invocation.actor).toBe('alice')
    const store = makeStore(d)
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes['n0-alice']).toBeDefined()
    expect(g.nodes['n1-alice']).toBeDefined()
    expect(g.links['l2-alice']).toBeDefined() // retained link, same allocator
    expect(g.actorCursors).toEqual({ alice: 3 })
    expect(g.nextOrdinal).toBe(100) // untouched
  })

  it('two actors pasting the same envelope from the same base cannot collide', () => {
    const d = withView()
    const envelope = serializeSelection(d, 'g0', { nodes: ['n1', 'n2'], reroutes: [] })!
    const planA = planClipboardPaste(d, 'g0', envelope, { x: 10, y: 10 }, 'alice')!
    const planB = planClipboardPaste(d, 'g0', envelope, { x: 20, y: 20 }, 'bob')!
    const ids = [...planA.nodeIds, ...planB.nodeIds]
    expect(new Set(ids).size).toBe(ids.length)
    // Apply both to ONE store (the server-ordered outcome): no overwrites.
    const store = makeStore(withView())
    expect(store.dispatch(planA.invocation).ok).toBe(true)
    expect(store.dispatch(planB.invocation).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes).sort()).toEqual(
      ['n1', 'n2', 'n0-alice', 'n1-alice', 'n0-bob', 'n1-bob'].sort(),
    )
    expect(g.actorCursors).toEqual({ alice: 3, bob: 3 })
  })

  it('refuses to plan for an invalid actor (plan must be dispatchable)', () => {
    const d = withView()
    const envelope = serializeSelection(d, 'g0', { nodes: ['n1'], reroutes: [] })!
    expect(planClipboardPaste(d, 'g0', envelope, { x: 0, y: 0 }, 'a.b')).toBeUndefined()
  })

  it('counts exhaustion against the ACTOR cursor, not nextOrdinal', () => {
    const d = withView()
    const envelope = serializeSelection(d, 'g0', { nodes: ['n1', 'n2'], reroutes: [] })!
    // 3 allocations (2 nodes + 1 retained link). Actor cursor at MAX-2
    // cannot fit them even though nextOrdinal (100) has plenty of room.
    const MAX = Number.MAX_SAFE_INTEGER
    const exhausted = doc({
      g0: {
        ...d.graphs.g0!,
        actorCursors: { alice: MAX - 2 },
      },
    })
    const withV = { ...exhausted, view: d.view } as WorkflowDocument
    expect(planClipboardPaste(withV, 'g0', envelope, { x: 0, y: 0 }, 'alice')).toBeUndefined()
    expect(planClipboardPaste(withV, 'g0', envelope, { x: 0, y: 0 })).toBeDefined() // solo still fine
  })
})
