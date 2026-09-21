/**
 * Control surfaces: typed contracts, lifecycle commands, and
 * surface.mode.apply semantics.
 *
 * What must hold:
 * - decode is total: malformed configs yield diagnostics, unknown binding
 *   kinds are preserved (never silently rewritten or dropped)
 * - lifecycle commands are deterministic, undoable, and structural-only
 * - surface.mode.apply resolves bindings at invocation, writes the same
 *   document state as node.setMode, dedupes overlapping targets, degrades
 *   broken bindings to warnings, and is ONE undo step
 * - surfaces never touch the execution-semantic hash (chrome, not semantics)
 */

import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { GraphDef, JsonObject, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import { createSurfaceRegistry, modePanelSurface, decodeModePanelConfig, resolveModePanelBindings, MODE_PANEL_TYPE } from '../src/index.js'

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
      g0: graph({ id: 'g0', nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') } }),
    },
    view: {
      graphs: {
        g0: {
          nodes: {},
          groups: { grp0: { id: 'grp0', title: 'Group', bounds: { x: 0, y: 0, width: 100, height: 100 } } },
        },
      },
    },
    ...overrides,
  }
}

function makeStore(d = doc()) {
  return new DocumentStore(d, coreCommandRegistry())
}

const panelConfig = (bindings: JsonObject[]): JsonObject => ({ bindings })

// ---------------------------------------------------------------------------
// registry + decode
// ---------------------------------------------------------------------------

describe('surface registry', () => {
  it('registers, resolves, unregisters; duplicate types throw', () => {
    const reg = createSurfaceRegistry([modePanelSurface])
    expect(reg.get(MODE_PANEL_TYPE)?.title).toBe('Mode Panel')
    expect(() => reg.register(modePanelSurface)).toThrow(/already registered/)
    const un = reg.register({ type: 'ext.macro', title: 'Macro', decode: () => ({ ok: true, config: {}, diagnostics: [] }) })
    expect(reg.get('ext.macro')).toBeDefined()
    un()
    expect(reg.get('ext.macro')).toBeUndefined()
    expect(reg.types().map((t) => t.type)).toEqual([MODE_PANEL_TYPE])
  })
})

describe('decodeModePanelConfig', () => {
  it('decodes node and group bindings with an optional title', () => {
    const r = decodeModePanelConfig({
      title: 'Fast Muter',
      bindings: [
        { kind: 'node', graphId: 'g0', nodeId: 'n1' },
        { kind: 'group', graphId: 'g0', groupId: 'grp0' },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.title).toBe('Fast Muter')
    expect(r.config.bindings).toHaveLength(2)
  })

  it('malformed shapes yield error diagnostics, never throw', () => {
    for (const bad of [
      { bindings: 'nope' },
      { bindings: [{ kind: 'node', graphId: 'g0' }] },
      { bindings: [{ kind: 'group', groupId: 'grp0' }] },
      { bindings: [null] },
      { title: 5, bindings: [] },
    ]) {
      const r = decodeModePanelConfig(bad as unknown as JsonObject)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.diagnostics[0]?.code).toBe('surface.config.invalid')
    }
  })

  it('unknown binding kinds are preserved as data (future variants survive round trips)', () => {
    const raw = { kind: 'tagQuery', tag: 'loaders' }
    const r = decodeModePanelConfig(panelConfig([{ kind: 'node', graphId: 'g0', nodeId: 'n1' }, raw]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.bindings[1]).toEqual({ kind: 'unknown', raw })
  })
})

describe('resolveModePanelBindings', () => {
  const decoded = () => {
    const r = decodeModePanelConfig(
      panelConfig([
        { kind: 'node', graphId: 'g0', nodeId: 'n1' },
        { kind: 'node', graphId: 'g0', nodeId: 'gone' },
        { kind: 'node', graphId: 'gX', nodeId: 'n1' },
        { kind: 'group', graphId: 'g0', groupId: 'grp0' },
        { kind: 'group', graphId: 'g0', groupId: 'grpX' },
        { kind: 'somethingNew' },
      ]),
    )
    if (!r.ok) throw new Error('decode failed')
    return r.config
  }

  it('classifies each binding; group members come from the host capture', () => {
    const statuses = resolveModePanelBindings(doc(), decoded(), [
      { graphId: 'g0', groupId: 'grp0', nodeIds: ['n2', 'n3'] },
    ]).map((r) => r.status)
    expect(statuses).toEqual(['ok', 'missingNode', 'missingGraph', 'ok', 'missingGroup', 'unknownKind'])
  })

  it('group bindings without a host capture resolve as unresolvedMembers', () => {
    const r = resolveModePanelBindings(doc(), decoded(), [])
    expect(r[3]?.status).toBe('unresolvedMembers')
  })

  it('captured member ids that left the graph are dropped, never applied', () => {
    const r = resolveModePanelBindings(doc(), decoded(), [
      { graphId: 'g0', groupId: 'grp0', nodeIds: ['n2', 'deleted'] },
    ])
    expect(r[3]).toMatchObject({ status: 'ok', nodeIds: ['n2'] })
  })

  it('FR1 a pre-cursor document with only a broken binding still never remints the referenced id', () => {
    // A pre-cursor save can carry a mode-panel binding to a group that was
    // removed BEFORE cursors existed: no live groups, no groupSeq - the
    // binding itself is the only allocation evidence. The floor must read
    // it, or the very first create/paste remints grp0 and silently repairs
    // the binding onto an unrelated group.
    const store = makeStore(
      doc({
        view: { graphs: { g0: { nodes: {} } } },
        surfaces: {
          s0: {
            id: 's0',
            type: MODE_PANEL_TYPE,
            config: { bindings: [{ kind: 'group', graphId: 'g0', groupId: 'grp0' }] },
          },
        },
      } as unknown as Partial<WorkflowDocument>),
    )
    expect(
      store.dispatch({
        command: 'view.createGroup',
        params: { graphId: 'g0', title: 'unrelated', bounds: { x: 0, y: 0, width: 50, height: 50 } },
      }).ok,
    ).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp1'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(2)
    const decodedPanel = decodeModePanelConfig({
      bindings: [{ kind: 'group', graphId: 'g0', groupId: 'grp0' }],
    })
    if (!decodedPanel.ok) throw new Error('decode failed')
    const r = resolveModePanelBindings(store.doc, decodedPanel.config, [])
    expect(r[0]?.status).toBe('missingGroup')
  })

  it('FR1 a removed group binding stays broken after a new group is created (id never reused)', () => {
    const store = makeStore()
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } }).ok).toBe(true)
    expect(
      store.dispatch({
        command: 'view.createGroup',
        params: { graphId: 'g0', title: 'unrelated', bounds: { x: 0, y: 0, width: 50, height: 50 } },
      }).ok,
    ).toBe(true)
    // The new group minted a FRESH id (grp1, even though the seeded doc
    // carried no groupSeq - the remove persisted the high-water mark)...
    expect(store.doc.view.graphs.g0?.groups?.grp0).toBeUndefined()
    expect(store.doc.view.graphs.g0?.groups?.grp1).toBeDefined()
    // ...so the old binding resolves missingGroup instead of silently
    // retargeting the unrelated group with the removed group's capture.
    const r = resolveModePanelBindings(store.doc, decoded(), [
      { graphId: 'g0', groupId: 'grp0', nodeIds: ['n2', 'n3'] },
    ])
    expect(r[3]?.status).toBe('missingGroup')
  })
})

// ---------------------------------------------------------------------------
// lifecycle commands
// ---------------------------------------------------------------------------

describe('surface lifecycle commands', () => {
  it('surface.add allocates deterministic ids and writes view placement', () => {
    const store = makeStore()
    const r1 = store.dispatch({
      command: 'surface.add',
      params: { type: MODE_PANEL_TYPE, config: panelConfig([]), position: { x: 10, y: 20 } },
    })
    expect(r1.ok).toBe(true)
    const r2 = store.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: panelConfig([]) } })
    expect(r2.ok).toBe(true)
    expect(store.doc.surfaces?.s0).toMatchObject({ id: 's0', type: MODE_PANEL_TYPE })
    expect(store.doc.surfaces?.s1).toMatchObject({ id: 's1' })
    expect(store.doc.view.surfaces?.s0).toEqual({ position: { x: 10, y: 20 } })
    expect(store.doc.view.surfaces?.s1).toBeUndefined()
  })

  it('surface.update replaces config; surface.remove clears document + view; both undo', () => {
    const store = makeStore()
    store.dispatch({
      command: 'surface.add',
      params: { type: MODE_PANEL_TYPE, config: panelConfig([]), position: { x: 0, y: 0 } },
    })
    const cfg = panelConfig([{ kind: 'node', graphId: 'g0', nodeId: 'n1' }])
    expect(store.dispatch({ command: 'surface.update', params: { surfaceId: 's0', config: cfg } }).ok).toBe(true)
    expect(store.doc.surfaces?.s0?.config).toEqual(cfg)
    expect(store.dispatch({ command: 'surface.remove', params: { surfaceId: 's0' } }).ok).toBe(true)
    expect(store.doc.surfaces?.s0).toBeUndefined()
    expect(store.doc.view.surfaces?.s0).toBeUndefined()
    store.undo() // remove undone
    expect(store.doc.surfaces?.s0?.config).toEqual(cfg)
    expect(store.doc.view.surfaces?.s0).toEqual({ position: { x: 0, y: 0 } })
    store.undo() // update undone
    expect(store.doc.surfaces?.s0?.config).toEqual(panelConfig([]))
  })

  it('view.moveSurface writes placement without disturbing other view keys', () => {
    const store = makeStore()
    store.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: panelConfig([]) } })
    expect(store.dispatch({ command: 'view.moveSurface', params: { surfaceId: 's0', position: { x: 5, y: 6 } } }).ok).toBe(true)
    expect(store.doc.view.surfaces?.s0).toEqual({ position: { x: 5, y: 6 } })
  })

  it('CO3 surface ids never rewind across undo: doc-level surfaceSeq is the authority', () => {
    const store = makeStore()
    store.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: panelConfig([]) } })
    expect(store.doc.surfaces?.s0).toBeDefined()
    expect(store.doc.surfaceSeq).toBe(1)
    store.undo()
    // Surface gone, cursor kept: 's0' is never minted twice.
    expect(store.doc.surfaces?.s0).toBeUndefined()
    expect(store.doc.surfaceSeq).toBe(1)
    store.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: panelConfig([]) } })
    expect(store.doc.surfaces?.s0).toBeUndefined()
    expect(store.doc.surfaces?.s1).toBeDefined()
  })

  it('surface.add rejects when the id cursor is exhausted instead of overwriting', () => {
    const store = makeStore(doc({ surfaceSeq: Number.MAX_SAFE_INTEGER }))
    const r = store.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: panelConfig([]) } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.diagnostics[0]?.code).toBe('surface.exhausted')
  })

  it('unknown surface ids reject with surface.missing', () => {
    const store = makeStore()
    for (const command of ['surface.update', 'surface.remove', 'view.moveSurface']) {
      const r = store.dispatch({
        command,
        params: { surfaceId: 'nope', config: panelConfig([]), position: { x: 0, y: 0 } },
      })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.diagnostics[0]?.code).toBe('surface.missing')
    }
  })

  it('surfaces are execution-hash-neutral: add/update/move/remove never dirty semantics', () => {
    const store = makeStore()
    const before = semanticHashOf(store.doc)
    store.dispatch({
      command: 'surface.add',
      params: { type: MODE_PANEL_TYPE, config: panelConfig([]), position: { x: 1, y: 1 } },
    })
    store.dispatch({
      command: 'surface.update',
      params: { surfaceId: 's0', config: panelConfig([{ kind: 'node', graphId: 'g0', nodeId: 'n1' }]) },
    })
    store.dispatch({ command: 'view.moveSurface', params: { surfaceId: 's0', position: { x: 9, y: 9 } } })
    expect(semanticHashOf(store.doc)).toBe(before)
    store.dispatch({ command: 'surface.remove', params: { surfaceId: 's0' } })
    expect(semanticHashOf(store.doc)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// surface.mode.apply
// ---------------------------------------------------------------------------

describe('surface.mode.apply', () => {
  const withPanel = (bindings: JsonObject[]) => {
    const store = makeStore()
    const r = store.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: panelConfig(bindings) } })
    expect(r.ok).toBe(true)
    return store
  }

  it('applies the mode to explicit node bindings in one undo step', () => {
    const store = withPanel([
      { kind: 'node', graphId: 'g0', nodeId: 'n1' },
      { kind: 'node', graphId: 'g0', nodeId: 'n2' },
    ])
    const r = store.dispatch({ command: 'surface.mode.apply', params: { surfaceId: 's0', mode: 'muted' } })
    expect(r.ok).toBe(true)
    expect(store.doc.graphs.g0?.nodes.n1?.mode).toBe('muted')
    expect(store.doc.graphs.g0?.nodes.n2?.mode).toBe('muted')
    expect(store.doc.graphs.g0?.nodes.n3?.mode).toBeUndefined()
    store.undo()
    expect(store.doc.graphs.g0?.nodes.n1?.mode).toBeUndefined()
    expect(store.doc.graphs.g0?.nodes.n2?.mode).toBeUndefined()
  })

  it('group bindings apply to the host-captured membership; stale ids drop', () => {
    const store = withPanel([{ kind: 'group', graphId: 'g0', groupId: 'grp0' }])
    const r = store.dispatch({
      command: 'surface.mode.apply',
      params: {
        surfaceId: 's0',
        mode: 'bypassed',
        groupMembers: [{ graphId: 'g0', groupId: 'grp0', nodeIds: ['n2', 'n3', 'deleted'] }],
      },
    })
    expect(r.ok).toBe(true)
    expect(store.doc.graphs.g0?.nodes.n2?.mode).toBe('bypassed')
    expect(store.doc.graphs.g0?.nodes.n3?.mode).toBe('bypassed')
    expect(store.doc.graphs.g0?.nodes.n1?.mode).toBeUndefined()
  })

  it('broken bindings warn and skip; intact bindings still apply', () => {
    const store = withPanel([
      { kind: 'node', graphId: 'g0', nodeId: 'gone' },
      { kind: 'group', graphId: 'g0', groupId: 'grpX' },
      { kind: 'group', graphId: 'g0', groupId: 'grp0' }, // no members passed
      { kind: 'futureKind', payload: 1 },
      { kind: 'node', graphId: 'g0', nodeId: 'n1' },
    ])
    const r = store.dispatch({ command: 'surface.mode.apply', params: { surfaceId: 's0', mode: 'muted' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(store.doc.graphs.g0?.nodes.n1?.mode).toBe('muted')
    const codes = r.diagnostics.filter((d) => d.code === 'surface.binding.broken')
    expect(codes).toHaveLength(4)
    expect(codes.every((d) => d.severity === 'warning')).toBe(true)
  })

  it('overlapping bindings write each node once (dedupe keeps the patch minimal)', () => {
    const store = withPanel([
      { kind: 'node', graphId: 'g0', nodeId: 'n2' },
      { kind: 'group', graphId: 'g0', groupId: 'grp0' },
    ])
    const r = store.dispatch({
      command: 'surface.mode.apply',
      params: {
        surfaceId: 's0',
        mode: 'muted',
        groupMembers: [{ graphId: 'g0', groupId: 'grp0', nodeIds: ['n2', 'n3'] }],
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.forward.filter((op) => op.path.includes('n2')).length).toBe(1)
  })

  it('rejects wrong surface types, bad modes, and undecodable configs', () => {
    const store = makeStore()
    store.dispatch({ command: 'surface.add', params: { type: 'ext.other', config: {} } })
    const wrongType = store.dispatch({ command: 'surface.mode.apply', params: { surfaceId: 's0', mode: 'muted' } })
    expect(wrongType.ok).toBe(false)
    if (!wrongType.ok) expect(wrongType.diagnostics[0]?.code).toBe('surface.type')

    const store2 = withPanel([])
    const badMode = store2.dispatch({ command: 'surface.mode.apply', params: { surfaceId: 's0', mode: 'sideways' } })
    expect(badMode.ok).toBe(false)

    const store3 = makeStore()
    store3.dispatch({ command: 'surface.add', params: { type: MODE_PANEL_TYPE, config: { bindings: 'nope' } } })
    const badCfg = store3.dispatch({ command: 'surface.mode.apply', params: { surfaceId: 's0', mode: 'muted' } })
    expect(badCfg.ok).toBe(false)
    if (!badCfg.ok) expect(badCfg.diagnostics[0]?.code).toBe('surface.config.invalid')
  })

  it('writes the same document state node.setMode would (no second mode semantics)', () => {
    const storeA = withPanel([{ kind: 'node', graphId: 'g0', nodeId: 'n1' }])
    storeA.dispatch({ command: 'surface.mode.apply', params: { surfaceId: 's0', mode: 'bypassed' } })
    const storeB = makeStore()
    storeB.dispatch({ command: 'node.setMode', params: { graphId: 'g0', nodeIds: ['n1'], mode: 'bypassed' } })
    expect(semanticHashOf(storeA.doc)).toBe(semanticHashOf(storeB.doc))
  })
})
