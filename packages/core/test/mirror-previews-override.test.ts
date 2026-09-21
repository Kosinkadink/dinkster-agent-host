/**
 * Per-node mirror-estimate overrides: the node.mirrorPreviews document
 * field, its command, the capability-gated menu contribution, and hash
 * neutrality (estimate display never changes execution identity).
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { semanticHashOf } from '../src/compile/hash.js'
import { validateDocumentShape } from '../src/format/validate.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import { createMenuRegistry, type MenuContext, type MenuTarget } from '../src/menus/contract.js'
import { coreMenuContributions } from '../src/menus/core-items.js'

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

const node = (id: string, type = 'dinkster.image.adjust', mirrorPreviews?: boolean) => ({
  id: asNodeId(id),
  type,
  values: {},
  ...(mirrorPreviews !== undefined ? { mirrorPreviews } : {}),
})

function doc(opts?: { n2?: boolean }): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: graph({
        id: 'g0',
        nodes: {
          n1: node('n1'),
          n2: node('n2', 'dinkster.image.adjust', opts?.n2),
          plain: node('plain', 'KSampler'),
        },
      }),
    },
    view: { graphs: {} },
  }
}

describe('node.setMirrorPreviews command', () => {
  const makeStore = (d?: WorkflowDocument) => new DocumentStore(d ?? doc(), coreCommandRegistry())

  it('sets and clears the override on many nodes', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], mirrorPreviews: false },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.mirrorPreviews).toBe(false)
    expect(store.doc.graphs.g0!.nodes.n2!.mirrorPreviews).toBe(false)

    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], mirrorPreviews: null },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.mirrorPreviews).toBeUndefined()
    expect('mirrorPreviews' in store.doc.graphs.g0!.nodes.n1!).toBe(false)
  })

  it('clearing an absent override is a no-op transaction', () => {
    const store = makeStore()
    const revision = store.revision
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], mirrorPreviews: null },
    }).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })

  it('setting the value a node already holds is a no-op transaction', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], mirrorPreviews: true },
    }).ok).toBe(true)
    const revision = store.revision
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], mirrorPreviews: true },
    }).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })

  it('rejects non-boolean values and unknown nodes', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], mirrorPreviews: 'on' },
    }).ok).toBe(false)
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['nope'], mirrorPreviews: true },
    }).ok).toBe(false)
  })

  it('leaves the document unchanged when any node is unknown', () => {
    const store = makeStore()
    const revision = store.revision
    expect(store.dispatch({
      command: 'node.setMirrorPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'nope'], mirrorPreviews: true },
    }).ok).toBe(false)
    expect(store.revision).toBe(revision)
    expect(store.doc.graphs.g0!.nodes.n1!.mirrorPreviews).toBeUndefined()
  })
})

describe('mirror overrides and identity', () => {
  it('the mirrorPreviews field never moves the semantic hash', () => {
    const plain = semanticHashOf(doc())
    expect(semanticHashOf(doc({ n2: false }))).toBe(plain)
    expect(semanticHashOf(doc({ n2: true }))).toBe(plain)
  })

  it('document shape accepts booleans and rejects anything else', () => {
    expect(validateDocumentShape(JSON.parse(JSON.stringify(doc({ n2: false }))))).toEqual([])
    const bad = JSON.parse(JSON.stringify(doc())) as {
      graphs: { g0: { nodes: { n1: Record<string, unknown> } } }
    }
    bad.graphs.g0.nodes.n1.mirrorPreviews = 'on'
    expect(validateDocumentShape(bad as unknown).some((d) => d.message.includes('.mirrorPreviews'))).toBe(true)
  })
})

describe('core.node.mirrorPreviews menu contribution', () => {
  function ctx(target: MenuTarget, d = doc({ n2: false })): MenuContext {
    return {
      doc: d,
      graphId: 'g0',
      target,
      selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] },
      worldX: 0,
      worldY: 0,
    }
  }

  function registry() {
    const r = createMenuRegistry()
    for (const c of coreMenuContributions()) r.register(c)
    return r
  }

  function findSubmenu(groups: ReturnType<ReturnType<typeof registry>['resolve']>) {
    return groups.flatMap((g) => g.items).find((i) => i.id === 'core.node.mirrorPreviews')
  }

  const mirrorCapable = (t: string) => t === 'dinkster.image.adjust'

  it('offers inherit/on/off with the current state checked', () => {
    const groups = registry().resolve({ ...ctx({ kind: 'node', nodeId: 'n2' }), mirrorCapable })
    const submenu = findSubmenu(groups)
    expect(submenu).toBeDefined()
    const children = submenu!.children ?? []
    expect(children.map((c) => c.id)).toEqual([
      'core.node.mirrorPreviews.inherit',
      'core.node.mirrorPreviews.on',
      'core.node.mirrorPreviews.off',
    ])
    expect(children.find((c) => c.id === 'core.node.mirrorPreviews.off')!.checked).toBe(true)
    expect(children.find((c) => c.id === 'core.node.mirrorPreviews.inherit')!.checked).toBe(false)
    const on = children.find((c) => c.id === 'core.node.mirrorPreviews.on')!
    expect(on.action).toEqual({
      kind: 'command',
      invocation: { command: 'node.setMirrorPreviews', params: { graphId: 'g0', nodeIds: ['n2'], mirrorPreviews: true } },
    })
    const inherit = children.find((c) => c.id === 'core.node.mirrorPreviews.inherit')!
    expect(inherit.action).toMatchObject({
      invocation: { command: 'node.setMirrorPreviews', params: { mirrorPreviews: null } },
    })
  })

  it('stays hidden when no capability source is provided', () => {
    // Unlike live previews (whose menu predates the capability flag), the
    // mirror override menu only exists where a schema-declared mirror can
    // estimate, so an absent capability source hides it everywhere.
    const groups = registry().resolve(ctx({ kind: 'node', nodeId: 'n2' }))
    expect(findSubmenu(groups)).toBeUndefined()
  })

  it('hides the submenu for node types the capability source rejects', () => {
    const base = ctx({ kind: 'node', nodeId: 'plain' })
    expect(findSubmenu(registry().resolve({ ...base, mirrorCapable }))).toBeUndefined()
    expect(findSubmenu(registry().resolve({ ...base, mirrorCapable: () => true }))).toBeDefined()
  })

  it('acts on the capable subset of a mixed selection', () => {
    const base = ctx({ kind: 'node', nodeId: 'n2' })
    const mixed: MenuContext = {
      ...base,
      selection: { ...base.selection, nodes: ['n1', 'n2', 'plain'] },
      mirrorCapable,
    }
    const submenu = findSubmenu(registry().resolve(mixed))
    expect(submenu).toBeDefined()
    const off = submenu!.children!.find((c) => c.id === 'core.node.mirrorPreviews.off')!
    expect(off.action).toMatchObject({
      invocation: { command: 'node.setMirrorPreviews', params: { nodeIds: ['n1', 'n2'] } },
    })
  })
})
