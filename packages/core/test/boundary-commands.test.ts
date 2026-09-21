/**
 * Boundary-editing commands: `boundary.setSlots` / `boundary.clearSlots`
 * are the deterministic, undoable write path for slot-selective family
 * forwarding (`binds.slots`, hazard F10).
 *
 * The contract under test: commands are schema-blind (structural validation
 * only - grammar, prefix conflicts, binding kind; template-aware errors are
 * derivation's job), selections canonicalize (dedupe + lexicographic sort)
 * so click order never churns the document, identical selections are
 * no-ops, undo restores the exact previous selection, and selection edits
 * never touch node identity, values, or dynamic state.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { BoundaryItem, GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId, asPortId } from '../src/ids.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

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

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id: asNodeId(id),
  type: 'Batch',
  values: {},
  ...extra,
})

/** Subgraph def 'sub' with one inner node and the given boundary inputs. */
function subDoc(inputs: BoundaryItem[], outputs: BoundaryItem[] = []): WorkflowDocument {
  return doc({
    g0: graph({ id: 'g0', name: 'root' }),
    sub: graph({
      id: 'sub',
      name: 'sub',
      nodes: { n1: node('n1', { dynamic: { items: { members: ['m0'], seq: 1 } } }) },
      boundary: { inputs, outputs },
    }),
  })
}

const familyItem = (id: string, slots?: readonly string[]): BoundaryItem => ({
  id,
  binds: {
    kind: 'family',
    node: asNodeId('n1'),
    port: asPortId('items'),
    ...(slots !== undefined ? { slots } : {}),
  },
})

const portItem = (id: string, slots?: readonly string[]): BoundaryItem => ({
  id,
  binds: {
    kind: 'port',
    node: asNodeId('n1'),
    port: asPortId('items.tag'),
    members: [asNodeId('m0') as unknown as never],
    ...(slots !== undefined ? { slots } : {}),
  },
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

const slotsOf = (store: DocumentStore, itemId: string, side: 'inputs' | 'outputs' = 'inputs') =>
  store.doc.graphs.sub!.boundary![side].find((b) => b.id === itemId)!.binds.slots

const setSlots = (store: DocumentStore, itemId: string, slots: Json, side = 'inputs') =>
  store.dispatch({ command: 'boundary.setSlots', params: { graphId: 'sub', side, itemId, slots } })

const clearSlots = (store: DocumentStore, itemId: string, side = 'inputs') =>
  store.dispatch({ command: 'boundary.clearSlots', params: { graphId: 'sub', side, itemId } })

// ---------------------------------------------------------------------------
// boundary.setSlots
// ---------------------------------------------------------------------------

describe('boundary.setSlots', () => {
  it('writes a canonical (deduped, sorted) selection', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = setSlots(store, 'fwd', ['tag', 'sub.s', 'tag'])
    expect(out.ok).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s', 'tag'])
  })

  it('replaces an existing selection and undo restores it exactly', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['tag'])]))
    expect(setSlots(store, 'fwd', ['sub.s']).ok).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s'])
    expect(store.undo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['tag'])
    expect(store.redo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s'])
  })

  it('undo of a first selection removes the property entirely', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    expect(setSlots(store, 'fwd', ['tag']).ok).toBe(true)
    expect(store.undo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toBeUndefined()
    expect('slots' in store.doc.graphs.sub!.boundary!.inputs[0]!.binds).toBe(false)
  })

  it('is a no-op for a semantically identical selection (no revision, nothing to undo)', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['a', 'b'])]))
    const before = store.revision
    const out = setSlots(store, 'fwd', ['b', 'a', 'b'])
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('works on the outputs side', () => {
    const store = makeStore(subDoc([], [familyItem('out')]))
    expect(setSlots(store, 'out', ['tag'], 'outputs').ok).toBe(true)
    expect(slotsOf(store, 'out', 'outputs')).toEqual(['tag'])
  })

  it('rejects a prefix conflict (whole subtree + narrowed descendant)', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = setSlots(store, 'fwd', ['sub', 'sub.s'])
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.slotConflict')
    expect(slotsOf(store, 'fwd')).toBeUndefined()
  })

  it('rejects malformed entries (empty string, empty segments, non-strings)', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    for (const bad of [[''], ['a..b'], ['.a'], ['a.'], [42], [null]]) {
      const out = setSlots(store, 'fwd', bad)
      expect(out.ok).toBe(false)
      expect(!out.ok && out.diagnostics[0]!.code).toBe('params.invalid')
    }
  })

  it('rejects an empty selection (clearSlots is the canonical spelling)', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['tag'])]))
    const out = setSlots(store, 'fwd', [])
    expect(out.ok).toBe(false)
    expect(slotsOf(store, 'fwd')).toEqual(['tag'])
  })

  it('rejects unknown graph, side, and item', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    expect(
      store.dispatch({
        command: 'boundary.setSlots',
        params: { graphId: 'nope', side: 'inputs', itemId: 'fwd', slots: ['a'] },
      }).ok,
    ).toBe(false)
    expect(setSlots(store, 'fwd', ['a'], 'sideways').ok).toBe(false)
    const missing = setSlots(store, 'nope', ['a'])
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.diagnostics[0]!.code).toBe('boundary.itemMissing')
  })

  it("rejects a 'port' binding (selection applies to family forwarding only)", () => {
    const store = makeStore(subDoc([portItem('p')]))
    const out = setSlots(store, 'p', ['tag'])
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.bindKind')
  })

  it('never touches node identity, values, or dynamic state', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const nodeBefore = store.doc.graphs.sub!.nodes.n1
    expect(setSlots(store, 'fwd', ['tag']).ok).toBe(true)
    expect(store.doc.graphs.sub!.nodes.n1).toEqual(nodeBefore)
  })
})

// ---------------------------------------------------------------------------
// boundary.clearSlots
// ---------------------------------------------------------------------------

describe('boundary.clearSlots', () => {
  it('removes the selection and undo restores it', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['sub.s', 'tag'])]))
    expect(clearSlots(store, 'fwd').ok).toBe(true)
    expect(slotsOf(store, 'fwd')).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s', 'tag'])
  })

  it('is a no-op when no selection is present', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const before = store.revision
    expect(clearSlots(store, 'fwd').ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it("repairs an invalid selection on a 'port' binding", () => {
    const store = makeStore(subDoc([portItem('p', ['tag'])]))
    expect(clearSlots(store, 'p').ok).toBe(true)
    expect(slotsOf(store, 'p')).toBeUndefined()
  })

  it('rejects unknown item', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = clearSlots(store, 'nope')
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.itemMissing')
  })
})

// ---------------------------------------------------------------------------
// batch atomicity
// ---------------------------------------------------------------------------

describe('boundary commands in a batch', () => {
  it('a failing sub-command rolls back the whole batch', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'boundary.setSlots',
            params: { graphId: 'sub', side: 'inputs', itemId: 'fwd', slots: ['tag'] },
          },
          {
            command: 'boundary.setSlots',
            params: { graphId: 'sub', side: 'inputs', itemId: 'missing', slots: ['tag'] },
          },
        ],
      },
    })
    expect(out.ok).toBe(false)
    expect(slotsOf(store, 'fwd')).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('two boundary edits commit as one transaction and one undo step', () => {
    const store = makeStore(subDoc([familyItem('a')], [familyItem('b')]))
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'boundary.setSlots',
            params: { graphId: 'sub', side: 'inputs', itemId: 'a', slots: ['tag'] },
          },
          {
            command: 'boundary.setSlots',
            params: { graphId: 'sub', side: 'outputs', itemId: 'b', slots: ['tag'] },
          },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(slotsOf(store, 'a')).toEqual(['tag'])
    expect(slotsOf(store, 'b', 'outputs')).toEqual(['tag'])
    expect(store.undo()).toBe(true)
    expect(slotsOf(store, 'a')).toBeUndefined()
    expect(slotsOf(store, 'b', 'outputs')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// boundary item lifecycle
// ---------------------------------------------------------------------------

describe('boundary item lifecycle commands', () => {
  it('adds, re-points, unbinds, and restores an output-side widget tap atomically', () => {
    const store = makeStore(subDoc([], [portItem('out')]))
    const add = store.dispatch({
      command: 'boundary.addItem',
      params: { graphId: 'sub', side: 'outputs', node: 'n1', tap: 'value', itemId: 'widget' },
    })
    expect(add.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[1]).toEqual({
      id: 'widget',
      binds: { kind: 'widgetTap', node: 'n1', tap: 'value' },
    })

    const set = store.dispatch({
      command: 'boundary.setBinding',
      params: { graphId: 'sub', side: 'outputs', itemId: 'out', node: 'n1', tap: 'other' },
    })
    expect(set.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n1', tap: 'other' })

    const unbind = store.dispatch({
      command: 'boundary.unbind',
      params: { graphId: 'sub', side: 'outputs', itemId: 'out', node: 'n1', tap: 'other' },
    })
    expect(unbind.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs.map((item) => item.id)).toEqual(['widget'])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n1', tap: 'other' })
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs.map((item) => item.id)).toEqual(['widget'])
  })

  it('removes and restores a widget-tap boundary item with its node', () => {
    const tapItem = {
      id: 'widget',
      binds: { kind: 'widgetTap', node: asNodeId('n1'), tap: asPortId('value') },
    } as BoundaryItem
    const store = makeStore(subDoc([], [tapItem]))

    const outcome = store.dispatch({
      command: 'graph.deleteItems',
      params: { graphId: 'sub', nodeIds: ['n1'] },
    })
    expect(outcome.ok).toBe(true)
    expect(store.doc.graphs.sub!.nodes.n1).toBeUndefined()
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.nodes.n1).toBeDefined()
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([tapItem])
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([])
  })

  it('rejects widget taps on inputs and mixed tap/port parameter shapes without mutation', () => {
    const store = makeStore(subDoc([]))
    const before = store.doc
    for (const params of [
      { graphId: 'sub', side: 'inputs', node: 'n1', tap: 'value' },
      { graphId: 'sub', side: 'outputs', node: 'n1', tap: 'value', port: 'value' },
      { graphId: 'sub', side: 'outputs', node: 'n1', tap: 'value', members: ['m0'] },
    ]) {
      const outcome = store.dispatch({ command: 'boundary.addItem', params })
      expect(outcome.ok).toBe(false)
      expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe('params.invalid')
    }
    expect(store.doc).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('rejects an explicit item ID used on the other side without changing the document', () => {
    const store = makeStore(subDoc([], [portItem('shared')]))
    const before = structuredClone(store.doc)
    const out = store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'new', itemId: 'shared' } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.duplicateId')
    expect(store.doc).toEqual(before)
    expect(store.canUndo).toBe(false)
  })

  it('adds an explicit item ID when it is unique across both sides', () => {
    const store = makeStore(subDoc([], [portItem('output')]))
    const out = store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'new', itemId: 'input' } })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([
      expect.objectContaining({ id: 'input', binds: expect.objectContaining({ node: 'n1', port: 'new' }) }),
    ])
  })

  it('generated item ids avoid ids on BOTH sides (one global namespace)', () => {
    // An existing OUTPUT id 'new' must push the generated INPUT id for
    // port 'new' to 'new_2': derivation treats boundary item ids as one
    // global namespace, so cross-side collisions corrupt derived boundaries.
    const store = makeStore(subDoc([], [portItem('new')]))
    const out = store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'new' } })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([
      expect.objectContaining({ id: 'new_2' }),
    ])
  })

  it('rejects an added binding already owned by another input without changing the document', () => {
    const binding = (port: string) => ({ kind: 'port' as const, node: asNodeId('n1'), port: asPortId(port) })
    const store = makeStore(subDoc([
      { id: 'first', binds: binding('used') },
      { id: 'second', binds: binding('other') },
    ]))
    const before = structuredClone(store.doc)
    const out = store.dispatch({ command: 'boundary.addBinding', params: { graphId: 'sub', itemId: 'second', node: 'n1', port: 'used' } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.duplicateBind')
    expect(store.doc).toEqual(before)
    expect(store.canUndo).toBe(false)
  })

  it('adds items with deterministic IDs and creates an absent boundary', () => {
    const d = subDoc([])
    const sub = d.graphs.sub!
    const { boundary: _boundary, ...subWithoutBoundary } = sub
    const withoutBoundary = doc({ g0: d.graphs.g0!, sub: graph({ ...subWithoutBoundary, id: 'sub' }) })
    const store = makeStore(withoutBoundary)
    const add = (itemId?: string) => store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'outputs', node: 'n1', port: 'value', ...(itemId ? { itemId } : {}) } })
    expect(add().ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary).toEqual({ inputs: [], outputs: [expect.objectContaining({ id: 'value' })] })
    expect(add().ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[1]!.id).toBe('value_2')
    const duplicate = add('value')
    expect(duplicate.ok).toBe(false)
    expect(!duplicate.ok && duplicate.diagnostics[0]!.code).toBe('boundary.duplicateId')
  })

  it('rejects an input target already used by a primary or fan-out binding', () => {
    const store = makeStore(subDoc([portItem('existing')]))
    const out = store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'items.tag', members: ['m0'] } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.duplicateBind')
  })

  it('keeps port and family spellings of the same input address mutually exclusive', () => {
    const family: BoundaryItem = {
      id: 'family',
      binds: {
        kind: 'family', node: asNodeId('n1'), port: asPortId('items.tag'),
        members: [asNodeId('m0') as unknown as never],
      },
    }
    const addStore = makeStore(subDoc([family]))
    const add = addStore.dispatch({
      command: 'boundary.addItem',
      params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'items.tag', members: ['m0'] },
    })
    expect(add.ok).toBe(false)
    expect(!add.ok && add.diagnostics[0]!.code).toBe('boundary.duplicateBind')

    const setStore = makeStore(subDoc([family, portItem('other')]))
    const set = setStore.dispatch({
      command: 'boundary.setBinding',
      params: { graphId: 'sub', side: 'inputs', itemId: 'other', node: 'n1', port: 'items.tag', members: ['m0'] },
    })
    expect(set.ok).toBe(false)
    expect(!set.ok && set.diagnostics[0]!.code).toBe('boundary.duplicateBind')
  })

  it('renames, clears canonically, and does not churn identical values', () => {
    const store = makeStore(subDoc([portItem('p')]))
    const rename = (displayName: string) => store.dispatch({ command: 'boundary.renameItem', params: { graphId: 'sub', side: 'inputs', itemId: 'p', displayName } })
    expect(rename('Label').ok).toBe(true)
    const revision = store.revision
    expect(rename('Label').ok).toBe(true)
    expect(store.revision).toBe(revision)
    expect(rename('').ok).toBe(true)
    expect('displayName' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
  })

  it('re-points a primary, preserves fan-out, rejects duplicates, and no-ops', () => {
    const item = { ...portItem('p', ['invalid']), alsoBinds: [{ kind: 'port' as const, node: asNodeId('n1'), port: asPortId('other') }] }
    const store = makeStore(subDoc([item]))
    const set = (port: string) => store.dispatch({ command: 'boundary.setBinding', params: { graphId: 'sub', side: 'inputs', itemId: 'p', node: 'n1', port } })
    expect(set('new').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.alsoBinds).toEqual(item.alsoBinds)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'new' })
    const revision = store.revision
    expect(set('new').ok).toBe(true)
    expect(store.revision).toBe(revision)
    const duplicate = set('other')
    expect(duplicate.ok).toBe(false)
    expect(!duplicate.ok && duplicate.diagnostics[0]!.code).toBe('boundary.duplicateBind')
  })

  it('unbinds fan-out, promotes the primary, removes whole items, and reports misses', () => {
    const binding = (port: string) => ({ kind: 'port' as const, node: asNodeId('n1'), port: asPortId(port) })
    const store = makeStore(subDoc([
      { id: 'fan', binds: binding('a'), alsoBinds: [binding('b')] },
      { id: 'remove', binds: binding('c') },
    ], [{ id: 'out', binds: binding('d') }]))
    const unbind = (side: string, itemId: string, port: string) => store.dispatch({ command: 'boundary.unbind', params: { graphId: 'sub', side, itemId, node: 'n1', port } })
    expect(unbind('inputs', 'fan', 'b').ok).toBe(true)
    expect('alsoBinds' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
    expect(store.undo()).toBe(true)
    expect(unbind('inputs', 'fan', 'a').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds.port).toBe('b')
    expect('alsoBinds' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
    expect(unbind('inputs', 'remove', 'c').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs.some((item) => item.id === 'remove')).toBe(false)
    expect(unbind('outputs', 'out', 'd').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([])
    const missing = unbind('inputs', 'fan', 'missing')
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.diagnostics[0]!.code).toBe('boundary.bindMissing')
  })

  it('keeps ordinary family bindings addressable by port-shaped unbind commands', () => {
    const store = makeStore(subDoc([familyItem('family')]))
    const outcome = store.dispatch({
      command: 'boundary.unbind',
      params: { graphId: 'sub', side: 'inputs', itemId: 'family', node: 'n1', port: 'items' },
    })
    expect(outcome.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([familyItem('family')])
  })
})
