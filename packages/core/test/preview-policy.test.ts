/**
 * Live-preview overrides: document fields, commands, menu contribution, and
 * the submit-time policy resolution (global < workflow < subgraph instance <
 * node), all hash-neutral (preview spend never changes execution identity).
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { semanticHashOf } from '../src/compile/hash.js'
import { resolvePreviewPolicy } from '../src/compile/preview-policy.js'
import type { Provenance } from '../src/compile/artifact.js'
import { validateDocumentShape } from '../src/format/validate.js'
import type { GraphDef, PreviewMode, WorkflowDocument } from '../src/format/document.js'
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

const node = (id: string, type = 'KSampler', previews?: PreviewMode) => ({
  id: asNodeId(id),
  type,
  values: {},
  ...(previews !== undefined ? { previews } : {}),
})

function doc(graphs: Record<string, GraphDef>, overrides?: Partial<WorkflowDocument>): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs,
    view: { graphs: {} },
    ...overrides,
  }
}

/** Root graph: plain node n1, overridden node n2, subgraph instance s1 -> sub1. */
function nestedDoc(opts?: {
  workflow?: PreviewMode
  n2?: PreviewMode
  instance?: PreviewMode
  inner?: PreviewMode
}): WorkflowDocument {
  return doc(
    {
      g0: graph({
        id: 'g0',
        nodes: {
          n1: node('n1'),
          n2: node('n2', 'KSampler', opts?.n2),
          s1: node('s1', '#sub1', opts?.instance),
        },
      }),
      sub1: graph({
        id: 'sub1',
        name: 'Sub',
        nodes: { inner: node('inner', 'KSampler', opts?.inner) },
      }),
    },
    opts?.workflow !== undefined ? { previews: opts.workflow } : {},
  )
}

/** Provenance for nestedDoc's lowering: root nodes keep ids, s1.inner flattens. */
const NESTED_PROVENANCE: Provenance = {
  toSource: { n1: 'n1', n2: 'n2', 's1.inner': 's1.inner' },
  fromSource: { n1: ['n1'], n2: ['n2'], 's1.inner': ['s1.inner'] },
}

describe('resolvePreviewPolicy', () => {
  it('uses the global mode when nothing overrides', () => {
    expect(resolvePreviewPolicy(nestedDoc(), NESTED_PROVENANCE, 'cheap')).toEqual({ mode: 'cheap' })
  })

  it('workflow override replaces the global mode', () => {
    expect(resolvePreviewPolicy(nestedDoc({ workflow: 'off' }), NESTED_PROVENANCE, 'cheap'))
      .toEqual({ mode: 'off' })
  })

  it('node overrides ride as per-runtime-node entries', () => {
    expect(resolvePreviewPolicy(nestedDoc({ n2: 'quality' }), NESTED_PROVENANCE, 'cheap'))
      .toEqual({ mode: 'cheap', nodes: { n2: 'quality' } })
  })

  it('a node override equal to the base mode is omitted', () => {
    expect(resolvePreviewPolicy(nestedDoc({ n2: 'cheap' }), NESTED_PROVENANCE, 'cheap'))
      .toEqual({ mode: 'cheap' })
  })

  it('a subgraph instance override covers the nodes it lowers to', () => {
    expect(resolvePreviewPolicy(nestedDoc({ instance: 'off' }), NESTED_PROVENANCE, 'cheap'))
      .toEqual({ mode: 'cheap', nodes: { 's1.inner': 'off' } })
  })

  it('an inner node override wins over its enclosing instance override', () => {
    expect(resolvePreviewPolicy(nestedDoc({ instance: 'off', inner: 'quality' }), NESTED_PROVENANCE, 'cheap'))
      .toEqual({ mode: 'cheap', nodes: { 's1.inner': 'quality' } })
  })

  it('node overrides compare against the workflow override, not the global', () => {
    expect(resolvePreviewPolicy(nestedDoc({ workflow: 'quality', n2: 'quality' }), NESTED_PROVENANCE, 'cheap'))
      .toEqual({ mode: 'quality' })
  })

  it('unresolvable occurrences are skipped', () => {
    const provenance: Provenance = {
      toSource: { ghost: 'missing.node', n2: 'n2' },
      fromSource: {},
    }
    expect(resolvePreviewPolicy(nestedDoc({ n2: 'off' }), provenance, 'cheap'))
      .toEqual({ mode: 'cheap', nodes: { n2: 'off' } })
  })

  it('a missing leaf is skipped even when its enclosing instance has an override', () => {
    const provenance: Provenance = {
      toSource: { 's1.ghost': 's1.ghost' },
      fromSource: {},
    }
    expect(resolvePreviewPolicy(nestedDoc({ instance: 'off' }), provenance, 'cheap'))
      .toEqual({ mode: 'cheap' })
  })

  it('the encoded animation transport rides the policy', () => {
    expect(resolvePreviewPolicy(nestedDoc(), NESTED_PROVENANCE, 'cheap', 'encoded'))
      .toEqual({ mode: 'cheap', animation: 'encoded' })
  })

  it('the ring animation transport stays implicit', () => {
    expect(resolvePreviewPolicy(nestedDoc(), NESTED_PROVENANCE, 'cheap', 'ring'))
      .toEqual({ mode: 'cheap' })
  })

  it('the encoded transport composes with overrides', () => {
    expect(resolvePreviewPolicy(nestedDoc({ n2: 'quality' }), NESTED_PROVENANCE, 'cheap', 'encoded'))
      .toEqual({ mode: 'cheap', nodes: { n2: 'quality' }, animation: 'encoded' })
  })
})

describe('preview override commands', () => {
  const makeStore = (d?: WorkflowDocument) => new DocumentStore(d ?? nestedDoc(), coreCommandRegistry())

  it('node.setPreviews sets and clears the override on many nodes', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], previews: 'off' },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.previews).toBe('off')
    expect(store.doc.graphs.g0!.nodes.n2!.previews).toBe('off')

    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], previews: null },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.previews).toBeUndefined()
    expect('previews' in store.doc.graphs.g0!.nodes.n1!).toBe(false)
  })

  it('node.setPreviews clearing an absent override is a no-op transaction', () => {
    const store = makeStore()
    const revision = store.revision
    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], previews: null },
    }).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })

  it('node.setPreviews rejects unknown modes and nodes', () => {
    const store = makeStore()
    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], previews: 'fancy' },
    }).ok).toBe(false)
    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['nope'], previews: 'off' },
    }).ok).toBe(false)
  })

  it('node.setPreviews leaves the document unchanged when any node is unknown', () => {
    const store = makeStore()
    const revision = store.revision
    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'nope'], previews: 'off' },
    }).ok).toBe(false)
    expect(store.revision).toBe(revision)
    expect(store.doc.graphs.g0!.nodes.n1!.previews).toBeUndefined()
  })

  it('node.setPreviews tolerates duplicate node ids when setting and clearing', () => {
    const store = makeStore(nestedDoc({ n2: 'quality' }))
    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n2', 'n2'], previews: null },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n2!.previews).toBeUndefined()

    expect(store.dispatch({
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1', 'n1'], previews: 'off' },
    }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.previews).toBe('off')
  })

  it('workflow.setPreviews sets and clears the document override', () => {
    const store = makeStore()
    expect(store.dispatch({ command: 'workflow.setPreviews', params: { previews: 'quality' } }).ok).toBe(true)
    expect(store.doc.previews).toBe('quality')

    expect(store.dispatch({ command: 'workflow.setPreviews', params: { previews: null } }).ok).toBe(true)
    expect(store.doc.previews).toBeUndefined()
    expect('previews' in store.doc).toBe(false)
  })

  it('workflow.setPreviews rejects unknown modes', () => {
    const store = makeStore()
    expect(store.dispatch({ command: 'workflow.setPreviews', params: { previews: 'fancy' } }).ok).toBe(false)
  })
})

describe('preview overrides and identity', () => {
  it('previews fields never move the semantic hash', () => {
    const plain = semanticHashOf(nestedDoc())
    expect(semanticHashOf(nestedDoc({ workflow: 'off' }))).toBe(plain)
    expect(semanticHashOf(nestedDoc({ n2: 'quality', instance: 'off', inner: 'cheap' }))).toBe(plain)
  })

  it('document shape accepts valid preview modes and rejects others', () => {
    expect(validateDocumentShape(JSON.parse(JSON.stringify(nestedDoc({ workflow: 'auto', n2: 'off' }))))).toEqual([])
    const badDoc = JSON.parse(JSON.stringify(nestedDoc())) as Record<string, unknown>
    badDoc.previews = 'fancy'
    expect(validateDocumentShape(badDoc).some((d) => d.message.includes('$.previews'))).toBe(true)
    const badNode = JSON.parse(JSON.stringify(nestedDoc())) as {
      graphs: { g0: { nodes: { n1: Record<string, unknown> } } }
    }
    badNode.graphs.g0.nodes.n1.previews = 42
    expect(validateDocumentShape(badNode as unknown).some((d) => d.message.includes('.previews'))).toBe(true)
  })
})

describe('core.node.previews menu contribution', () => {
  function ctx(target: MenuTarget, d = nestedDoc({ n2: 'off' })): MenuContext {
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

  it('offers inherit plus the four modes with the current state checked', () => {
    const groups = registry().resolve(ctx({ kind: 'node', nodeId: 'n2' }))
    const submenu = groups.flatMap((g) => g.items).find((i) => i.id === 'core.node.previews')
    expect(submenu).toBeDefined()
    const children = submenu!.children ?? []
    expect(children.map((c) => c.id)).toEqual([
      'core.node.previews.inherit',
      'core.node.previews.off',
      'core.node.previews.cheap',
      'core.node.previews.quality',
      'core.node.previews.auto',
    ])
    expect(children.find((c) => c.id === 'core.node.previews.off')!.checked).toBe(true)
    expect(children.find((c) => c.id === 'core.node.previews.inherit')!.checked).toBe(false)
    const off = children.find((c) => c.id === 'core.node.previews.off')!
    expect(off.action).toEqual({
      kind: 'command',
      invocation: { command: 'node.setPreviews', params: { graphId: 'g0', nodeIds: ['n2'], previews: 'off' } },
    })
    const inherit = children.find((c) => c.id === 'core.node.previews.inherit')!
    expect(inherit.action).toMatchObject({
      invocation: { command: 'node.setPreviews', params: { previews: null } },
    })
  })

  function findSubmenu(groups: ReturnType<ReturnType<typeof registry>['resolve']>) {
    return groups.flatMap((g) => g.items).find((i) => i.id === 'core.node.previews')
  }

  it('keeps the submenu on every node when no capability source is provided', () => {
    // ctx() carries no previewCapable: pre-flag backends and headless
    // consumers keep the previous show-everywhere behavior.
    const groups = registry().resolve(ctx({ kind: 'node', nodeId: 'n1' }))
    expect(findSubmenu(groups)).toBeDefined()
  })

  it('hides the submenu for node types the capability source rejects', () => {
    const base = ctx({ kind: 'node', nodeId: 'n1' })
    const flagged = registry().resolve({ ...base, previewCapable: (t) => t === 'KSampler' })
    expect(findSubmenu(flagged)).toBeDefined()
    const unflagged = registry().resolve({ ...base, previewCapable: () => false })
    expect(findSubmenu(unflagged)).toBeUndefined()
  })

  it('gates subgraph instances by their instance type', () => {
    // The app-level callback resolves '#sub1' through the derived boundary
    // schema, which aggregates inner emitsPreviews; the menu item only sees
    // the resulting per-type verdict.
    const base = ctx({ kind: 'node', nodeId: 's1' })
    const capable = registry().resolve({ ...base, previewCapable: (t) => t === '#sub1' })
    expect(findSubmenu(capable)).toBeDefined()
    const incapable = registry().resolve({ ...base, previewCapable: (t) => t === 'KSampler' })
    expect(findSubmenu(incapable)).toBeUndefined()
  })

  it('acts on the capable subset of a mixed selection', () => {
    const base = ctx({ kind: 'node', nodeId: 'n2' })
    const mixed: MenuContext = {
      ...base,
      selection: { ...base.selection, nodes: ['n1', 'n2', 's1'] },
      previewCapable: (t) => t === 'KSampler',
    }
    const submenu = findSubmenu(registry().resolve(mixed))
    expect(submenu).toBeDefined()
    const off = submenu!.children!.find((c) => c.id === 'core.node.previews.off')!
    expect(off.action).toMatchObject({
      invocation: { command: 'node.setPreviews', params: { nodeIds: ['n1', 'n2'] } },
    })
  })
})
