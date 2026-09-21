import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import {
  EXPOSED_PREVIEWS_EXT_KEY,
  exposedPreviews,
  isPreviewExposed,
} from '../src/format/exposed-previews.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import { coreMenuContributions } from '../src/menus/core-items.js'
import type { MenuContext } from '../src/menus/contract.js'
import { createMenuRegistry } from '../src/menus/contract.js'

const node = (id: string) => ({ id: asNodeId(id), type: 'PreviewNode', values: {} })

function graph(id: string): GraphDef {
  return {
    id: asGraphDefId(id),
    name: id,
    nodes: { n1: node('n1'), n2: node('n2') },
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 3,
  }
}

function doc(overrides: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('preview-list'),
    root: asGraphDefId('g0'),
    graphs: { g0: graph('g0') },
    view: { graphs: { g0: { nodes: {} } } },
    ...overrides,
  }
}

const store = (value = doc()) => new DocumentStore(value, coreCommandRegistry())

const expose = (target: DocumentStore, nodeId: string, label?: string) => target.dispatch({
  command: 'previews.expose',
  params: { graphId: 'g0', nodeId, ...(label === undefined ? {} : { label }) },
})

describe('exposed preview storage', () => {
  it('skips malformed and duplicate entries without rejecting the document', () => {
    const raw: Json = [
      { graphId: 'g0', nodeId: 'n1', label: 'Result' },
      'invalid',
      { graphId: 'g0' },
      { graphId: 'g0', nodeId: 'n1', label: 'Duplicate' },
      { graphId: 'g0', nodeId: 'n2', label: 42 },
    ]
    expect(exposedPreviews(doc({ ext: { [EXPOSED_PREVIEWS_EXT_KEY]: raw } }))).toEqual([
      { graphId: 'g0', nodeId: 'n1', label: 'Result' },
      { graphId: 'g0', nodeId: 'n2' },
    ])
    expect(exposedPreviews(doc({ ext: { [EXPOSED_PREVIEWS_EXT_KEY]: 'invalid' } }))).toEqual([])
  })

  it('round-trips ordered entries, labels, moves, stale removal, and undo', () => {
    const target = store(doc({ ext: {
      [EXPOSED_PREVIEWS_EXT_KEY]: ['invalid', { graphId: 'g0', nodeId: 'n1' }],
    } }))
    expect(expose(target, 'n2', 'Final image').ok).toBe(true)
    expect(target.doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]).toEqual([
      { graphId: 'g0', nodeId: 'n1' },
      { graphId: 'g0', nodeId: 'n2', label: 'Final image' },
    ])
    expect(isPreviewExposed(target.doc, 'g0', 'n2')).toBe(true)
    expect(target.dispatch({
      command: 'previews.move', params: { graphId: 'g0', nodeId: 'n2', index: 0 },
    }).ok).toBe(true)
    expect(exposedPreviews(target.doc).map((entry) => entry.nodeId)).toEqual(['n2', 'n1'])
    expect(target.dispatch({
      command: 'previews.setLabel', params: { graphId: 'g0', nodeId: 'n2', label: null },
    }).ok).toBe(true)
    expect(exposedPreviews(target.doc)[0]!.label).toBeUndefined()
    expect(target.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['n2'] } }).ok).toBe(true)
    expect(target.dispatch({
      command: 'previews.unexpose', params: { graphId: 'g0', nodeId: 'n2' },
    }).ok).toBe(true)
    expect(target.undo()).toBe(true)
    expect(isPreviewExposed(target.doc, 'g0', 'n2')).toBe(true)
  })

  it('validates identity, membership, graph and node existence, labels, and move bounds', () => {
    const target = store()
    expect(target.dispatch({ command: 'previews.expose', params: { graphId: 'missing', nodeId: 'n1' } }).ok).toBe(false)
    expect(target.dispatch({ command: 'previews.expose', params: { graphId: 'g0', nodeId: 'missing' } }).ok).toBe(false)
    expect(target.dispatch({ command: 'previews.expose', params: { graphId: 'g0', nodeId: '' } }).ok).toBe(false)
    expect(expose(target, 'n1').ok).toBe(true)
    expect(expose(target, 'n1').ok).toBe(false)
    expect(target.dispatch({
      command: 'previews.setLabel', params: { graphId: 'g0', nodeId: 'n1', label: '' },
    }).ok).toBe(false)
    expect(target.dispatch({
      command: 'previews.move', params: { graphId: 'g0', nodeId: 'n1', index: 1 },
    }).ok).toBe(false)
    expect(target.dispatch({
      command: 'previews.unexpose', params: { graphId: 'g0', nodeId: 'n2' },
    }).ok).toBe(false)
  })
})

describe('preview exposure menu', () => {
  const items = (value: WorkflowDocument, previewSurface?: true) => {
    const registry = createMenuRegistry()
    for (const contribution of coreMenuContributions()) registry.register(contribution)
    const context: MenuContext = {
      doc: value,
      graphId: 'g0',
      target: { kind: 'node', nodeId: 'n1', ...(previewSurface ? { previewSurface } : {}) },
      selection: { nodes: ['n1'], links: [], reroutes: [], valueSources: [], selectors: [] },
      worldX: 0,
      worldY: 0,
    }
    return registry.resolve(context).flatMap((group) => group.items)
      .filter((item) => item.id === 'core.node.preview.expose.toggle')
  }

  it('appears only for a preview surface and toggles the node pair', () => {
    const target = store()
    expect(items(target.doc)).toEqual([])
    const [before] = items(target.doc, true)
    expect(before).toMatchObject({
      label: 'Promote to App View',
      checked: false,
      action: { kind: 'command', invocation: {
        command: 'previews.expose', params: { graphId: 'g0', nodeId: 'n1' },
      } },
    })
    if (before?.action?.kind !== 'command') throw new Error('expected command item')
    expect(target.dispatch(before.action.invocation).ok).toBe(true)
    expect(items(target.doc, true)[0]).toMatchObject({
      label: 'Remove from App View',
      checked: true,
      action: { kind: 'command', invocation: {
        command: 'previews.unexpose', params: { graphId: 'g0', nodeId: 'n1' },
      } },
    })
  })
})
