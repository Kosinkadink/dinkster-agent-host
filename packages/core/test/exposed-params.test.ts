/**
 * Exposed parameters (platform-plan 2.4): the document-declared public
 * controls that turn a workflow into an app.
 *
 * What must hold:
 * - reading is tolerant: malformed entries and duplicates are skipped,
 *   never document errors; a foreign ext shape cannot brick the accessor
 * - params.* commands are deterministic, undoable, and write the canonical
 *   shape at ext['dinkster.exposed'] (self-healing tolerated-malformed data)
 * - expose validates graph/node existence and refuses duplicates; unexpose
 *   removes STALE entries too (that is the recovery path); move reorders
 *   with bounds checks; setLabel sets and clears
 * - the core.widget.expose menu contribution toggles expose/unexpose with
 *   checked state
 */

import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import {
  EXPOSED_EXT_KEY,
  exposedKey,
  exposedParameters,
  isExposed,
} from '../src/format/exposed.js'
import { coreMenuContributions } from '../src/menus/core-items.js'
import type { MenuActionItem, MenuContext, MenuItem } from '../src/menus/contract.js'
import { createMenuRegistry } from '../src/menus/contract.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'

const node = (id: string, type = 'KSampler') => ({ id: asNodeId(id), type, values: {} })

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

function doc(overrides: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: graph({ id: 'g0', nodes: { n1: node('n1'), n2: node('n2') } }),
    },
    view: { graphs: { g0: { nodes: {} } } },
    ...overrides,
  }
}

const makeStore = (d = doc()) => new DocumentStore(d, coreCommandRegistry())

const expose = (store: DocumentStore, nodeId: string, inputId: string, label?: string) =>
  store.dispatch({
    command: 'params.expose',
    params: { graphId: 'g0', nodeId, inputId, ...(label !== undefined ? { label } : {}) },
  })

describe('exposedParameters (tolerant reader)', () => {
  it('returns [] when ext or the key is absent or not an array', () => {
    expect(exposedParameters(doc())).toEqual([])
    expect(exposedParameters(doc({ ext: {} }))).toEqual([])
    expect(exposedParameters(doc({ ext: { [EXPOSED_EXT_KEY]: 'nope' } }))).toEqual([])
  })

  it('skips malformed entries and duplicate triples (first wins)', () => {
    const raw: Json = [
      { graphId: 'g0', nodeId: 'n1', inputId: 'seed', label: 'Seed' },
      'garbage',
      { graphId: 'g0', nodeId: 'n1' }, // missing inputId
      { graphId: 'g0', nodeId: 'n1', inputId: 'seed', label: 'Duplicate' },
      { graphId: 'g0', nodeId: 'n2', inputId: 'steps', label: 42 }, // bad label dropped, entry kept
    ]
    const entries = exposedParameters(doc({ ext: { [EXPOSED_EXT_KEY]: raw } }))
    expect(entries).toEqual([
      { graphId: 'g0', nodeId: 'n1', inputId: 'seed', label: 'Seed' },
      { graphId: 'g0', nodeId: 'n2', inputId: 'steps' },
    ])
  })

  it('exposedKey is injective: separator-bearing ids never collide (crossing mints \\u0000-prefixed ids)', () => {
    // Any in-band join would conflate these triples; JSON encoding cannot.
    expect(exposedKey({ graphId: 'g0', nodeId: 'a\u0000b', inputId: 'c' }))
      .not.toBe(exposedKey({ graphId: 'g0', nodeId: 'a', inputId: 'b\u0000c' }))
    const raw: Json = [
      { graphId: 'g0', nodeId: 'a\u0000b', inputId: 'c' },
      { graphId: 'g0', nodeId: 'a', inputId: 'b\u0000c' },
    ]
    expect(exposedParameters(doc({ ext: { [EXPOSED_EXT_KEY]: raw } }))).toHaveLength(2)
  })
})

describe('params.expose / params.unexpose', () => {
  it('exposes, preserves order, and round-trips through isExposed', () => {
    const store = makeStore()
    expect(expose(store, 'n1', 'seed').ok).toBe(true)
    expect(expose(store, 'n1', 'steps').ok).toBe(true)
    expect(expose(store, 'n2', 'cfg', 'Guidance').ok).toBe(true)
    expect(exposedParameters(store.doc).map((e) => e.inputId)).toEqual(['seed', 'steps', 'cfg'])
    expect(exposedParameters(store.doc)[2]).toEqual({ graphId: 'g0', nodeId: 'n2', inputId: 'cfg', label: 'Guidance' })
    expect(isExposed(store.doc, 'g0', 'n1', 'seed')).toBe(true)
    expect(isExposed(store.doc, 'g0', 'n1', 'cfg')).toBe(false)
  })

  it('refuses duplicates, unknown graphs, unknown nodes, and bad params', () => {
    const store = makeStore()
    expect(expose(store, 'n1', 'seed').ok).toBe(true)
    const dup = expose(store, 'n1', 'seed')
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.diagnostics[0]!.code).toBe('params.duplicate')
    const badGraph = store.dispatch({ command: 'params.expose', params: { graphId: 'gX', nodeId: 'n1', inputId: 'x' } })
    expect(badGraph.ok).toBe(false)
    if (!badGraph.ok) expect(badGraph.diagnostics[0]!.code).toBe('graph.missing')
    const badNode = store.dispatch({ command: 'params.expose', params: { graphId: 'g0', nodeId: 'nX', inputId: 'x' } })
    expect(badNode.ok).toBe(false)
    if (!badNode.ok) expect(badNode.diagnostics[0]!.code).toBe('node.missing')
    const badParams = store.dispatch({ command: 'params.expose', params: { graphId: 'g0', nodeId: 'n1', inputId: '' } })
    expect(badParams.ok).toBe(false)
    if (!badParams.ok) expect(badParams.diagnostics[0]!.code).toBe('params.invalid')
  })

  it('unexposes (including STALE entries whose node is gone) and refuses unknown entries', () => {
    const store = makeStore()
    expose(store, 'n1', 'seed')
    expose(store, 'n2', 'cfg')
    // Delete n2: the entry goes stale but must stay removable.
    expect(store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['n2'] } }).ok).toBe(true)
    expect(store.dispatch({ command: 'params.unexpose', params: { graphId: 'g0', nodeId: 'n2', inputId: 'cfg' } }).ok).toBe(true)
    expect(exposedParameters(store.doc).map((e) => e.inputId)).toEqual(['seed'])
    const missing = store.dispatch({ command: 'params.unexpose', params: { graphId: 'g0', nodeId: 'n2', inputId: 'cfg' } })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.diagnostics[0]!.code).toBe('params.missing')
  })

  it('is undoable and self-heals tolerated-malformed data on the first write', () => {
    const store = makeStore(
      doc({ ext: { [EXPOSED_EXT_KEY]: ['garbage', { graphId: 'g0', nodeId: 'n1', inputId: 'seed' }] } }),
    )
    expect(expose(store, 'n2', 'cfg').ok).toBe(true)
    // Canonical rewrite drops the garbage entry.
    expect(store.doc.ext?.[EXPOSED_EXT_KEY]).toEqual([
      { graphId: 'g0', nodeId: 'n1', inputId: 'seed' },
      { graphId: 'g0', nodeId: 'n2', inputId: 'cfg' },
    ])
    expect(store.undo()).toBe(true)
    // Undo restores the document byte-for-byte, garbage included.
    expect(store.doc.ext?.[EXPOSED_EXT_KEY]).toEqual([
      'garbage',
      { graphId: 'g0', nodeId: 'n1', inputId: 'seed' },
    ])
    expect(store.redo()).toBe(true)
    expect(exposedParameters(store.doc).map((e) => e.inputId)).toEqual(['seed', 'cfg'])
  })

  it('creates the root ext object when the document has none', () => {
    const store = makeStore()
    expect(store.doc.ext).toBeUndefined()
    expect(expose(store, 'n1', 'seed').ok).toBe(true)
    expect(Array.isArray(store.doc.ext?.[EXPOSED_EXT_KEY])).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.ext).toBeUndefined()
  })
})

describe('params.setLabel / params.move', () => {
  it('sets and clears labels', () => {
    const store = makeStore()
    expose(store, 'n1', 'seed')
    expect(store.dispatch({ command: 'params.setLabel', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', label: 'Seed' } }).ok).toBe(true)
    expect(exposedParameters(store.doc)[0]!.label).toBe('Seed')
    expect(store.dispatch({ command: 'params.setLabel', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', label: null } }).ok).toBe(true)
    expect(exposedParameters(store.doc)[0]!.label).toBeUndefined()
    const empty = store.dispatch({ command: 'params.setLabel', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed', label: '' } })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.diagnostics[0]!.code).toBe('params.invalid')
  })

  it('moves entries with bounds checks; an in-place move is a no-op', () => {
    const store = makeStore()
    expose(store, 'n1', 'seed')
    expose(store, 'n1', 'steps')
    expose(store, 'n2', 'cfg')
    expect(store.dispatch({ command: 'params.move', params: { graphId: 'g0', nodeId: 'n2', inputId: 'cfg', index: 0 } }).ok).toBe(true)
    expect(exposedParameters(store.doc).map((e) => e.inputId)).toEqual(['cfg', 'seed', 'steps'])
    const out = store.dispatch({ command: 'params.move', params: { graphId: 'g0', nodeId: 'n2', inputId: 'cfg', index: 3 } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('params.invalid')
    const before = store.revision
    expect(store.dispatch({ command: 'params.move', params: { graphId: 'g0', nodeId: 'n2', inputId: 'cfg', index: 0 } }).ok).toBe(true)
    // No-op move records no patch ops but still commits a revision; the
    // document is unchanged either way.
    expect(exposedParameters(store.doc).map((e) => e.inputId)).toEqual(['cfg', 'seed', 'steps'])
    expect(store.revision).toBeGreaterThanOrEqual(before)
  })
})

describe('core.widget.expose menu contribution', () => {
  type WidgetTarget = Extract<MenuContext['target'], { kind: 'widget' }>
  const ctx = (d: WorkflowDocument, nodeId: string, inputId: string, extra?: Partial<WidgetTarget>): MenuContext => ({
    doc: d,
    graphId: 'g0',
    target: { kind: 'widget', nodeId, inputId, ...extra },
    selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
    worldX: 0,
    worldY: 0,
  })

  const resolveItems = (d: WorkflowDocument, nodeId: string, inputId: string, extra?: Partial<WidgetTarget>) => {
    const registry = createMenuRegistry()
    for (const contribution of coreMenuContributions()) registry.register(contribution)
    return registry
      .resolve(ctx(d, nodeId, inputId, extra))
      .flatMap((g) => g.items)
      .filter((i) => i.id === 'core.widget.expose.toggle')
  }

  const commandInvocation = (item: MenuItem) => {
    const action = (item as MenuActionItem).action
    if (action.kind !== 'command') throw new Error(`expected '${item.id}' to dispatch a command`)
    return action.invocation
  }

  it('offers expose on an unexposed widget and unexpose (checked) on an exposed one', () => {
    const store = makeStore()
    const [before] = resolveItems(store.doc, 'n1', 'seed')
    expect(before).toBeDefined()
    expect(before!.label).toBe('Expose in app view')
    expect(before!.checked).toBe(false)
    expect(before!.action).toEqual({
      kind: 'command',
      invocation: { command: 'params.expose', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
    })
    expect(store.dispatch(commandInvocation(before!)).ok).toBe(true)
    const [after] = resolveItems(store.doc, 'n1', 'seed')
    expect(after!.label).toBe('Remove from app view')
    expect(after!.checked).toBe(true)
    expect(after!.action).toEqual({
      kind: 'command',
      invocation: { command: 'params.unexpose', params: { graphId: 'g0', nodeId: 'n1', inputId: 'seed' } },
    })
  })

  it('hides on unknown nodes', () => {
    expect(resolveItems(doc(), 'nX', 'seed')).toEqual([])
  })

  it('hides on synthetic rows: ghost/materialize affordances have no value to record', () => {
    expect(resolveItems(doc(), 'n1', 'seed', { synthetic: true })).toEqual([])
  })

  it('records the OWNER triple for forwarded-family rows, not the presentation row', () => {
    const store = makeStore(doc({
      graphs: {
        g0: graph({ id: 'g0', nodes: { inst: node('inst', '#sub') } }),
        sub: graph({ id: 'sub', nodes: { owner: node('owner') } }),
      },
    }))
    const owner = { graphId: 'sub', nodeId: 'owner', inputId: 'lora.m1#strength' }
    const [item] = resolveItems(store.doc, 'inst', 'lora.m1#strength', { owner })
    expect(item).toBeDefined()
    expect(item!.action).toEqual({
      kind: 'command',
      invocation: { command: 'params.expose', params: owner },
    })
    expect(store.dispatch(commandInvocation(item!)).ok).toBe(true)
    // The toggle reads the same home: checked now, and unexpose targets it.
    const [after] = resolveItems(store.doc, 'inst', 'lora.m1#strength', { owner })
    expect(after!.checked).toBe(true)
    expect(after!.action).toEqual({
      kind: 'command',
      invocation: { command: 'params.unexpose', params: owner },
    })
    // Owner home missing -> hidden (same rule as unknown displayed nodes).
    expect(resolveItems(store.doc, 'inst', 'x', { owner: { graphId: 'sub', nodeId: 'gone', inputId: 'x' } })).toEqual([])
  })
})
