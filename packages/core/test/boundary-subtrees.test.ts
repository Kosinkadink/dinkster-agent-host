import { describe, expect, it } from 'vitest'
import { compile, documentResolver } from '../src/compile/compile.js'
import { occurrenceDynamicView, occurrenceFamilyEndpoint, occurrenceSubtreeKey } from '../src/compile/occurrence-view.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import type { InputSpec, NodeSchema } from '../src/schema/model.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { mergeDynamicScope } from '../src/compile/crossing.js'
import { validateDocumentShape } from '../src/format/validate.js'
import { checkDocument } from '../src/invariants.js'
import { lifecycleSelectionFingerprint } from '../src/lifecycle/planner.js'

const value = (id: string): InputSpec => ({ kind: 'input', id, type: { kind: 'concrete', name: 'FLOAT' }, optional: true, widget: { widgetType: 'FLOAT', options: {}, default: 1 } })
const modal: NodeSchema = {
  type: 'Modal', displayName: 'Modal', category: 'test', source: 'v3', isOutputNode: true,
  items: [{ kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: true, dynamic: {
    kind: 'dynamicCombo', options: [
      { key: 'a', inputs: [value('gain'), { ...value('items'), dynamic: { kind: 'autogrow', template: [value('weight')], naming: { kind: 'prefix', prefix: 'item', max: 5 } } }] },
      { key: 'b', inputs: [value('gain')] },
    ],
  } }],
}
const resolve = (type: string) => type === modal.type ? modal : undefined
const document = (kind = 'dynamicCombo'): WorkflowDocument => {
  const graph = (id: string, nodes: unknown, boundary?: unknown) => ({ id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 20, ...(boundary ? { boundary } : {}) })
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'subtrees', root: 'root', view: { graphs: {} },
    graphs: {
      root: graph('root', { left: { id: 'left', type: '#middle', values: {} }, right: { id: 'right', type: '#middle', values: { 'choice.[b].gain': 8 }, dynamic: { choice: { selected: 'b' } } } }),
      middle: graph('middle', { inner: { id: 'inner', type: '#body', values: {} } }, { inputs: [{ id: 'choice', binds: { kind, node: 'inner', port: 'option' } }], outputs: [] }),
      body: graph('body', {
        leaf: {
          id: 'leaf', type: 'Modal',
          values: { 'mode.[a].gain': 3, 'mode.[a].items.weight#m0': 4 },
          dynamic: { mode: { selected: 'a' }, 'mode.[a].items': { members: ['m0'], seq: 1 } },
        },
      }, { inputs: [{ id: 'option', binds: { kind, node: 'leaf', port: 'mode' } }], outputs: [] }),
    },
  } as unknown as WorkflowDocument
}

describe('full conditional boundary forwarding', () => {
  it.each(['dynamicCombo', 'slot'])('preserves %s occurrence values when extracting its bound inner node', (kind) => {
    const original = document(kind)
    const root = original.graphs['root']!
    const body = original.graphs['body']!
    const input = modal.items[0] as InputSpec
    const schema: NodeSchema = kind === 'dynamicCombo' ? modal : { ...modal, items: [{
      ...input, type: { kind: 'concrete', name: 'FLOAT' }, dynamic: {
        kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'FLOAT' }, inputs: [],
        variants: ['a', 'b'].map((key) => ({ key, type: { kind: 'concrete' as const, name: 'FLOAT' }, inputs: [value('gain')] })),
      },
    }] }
    const localResolve = (type: string): NodeSchema | undefined => type === 'Modal' ? schema : type === 'Source' ? {
      ...modal, type, isOutputNode: false, items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'FLOAT' } }],
    } : undefined
    const doc = { ...original, graphs: { ...original.graphs,
      root: { ...root, nodes: { ...root.nodes,
        left: { ...root.nodes['left']!, values: { 'choice.[a].gain': 9 } },
        source: { id: 'source', type: 'Source', values: {} },
      }, links: kind === 'slot' ? {
        leftLink: { id: 'leftLink', from: { node: 'source', port: 'out' }, to: { node: 'left', port: 'choice' } },
        rightLink: { id: 'rightLink', from: { node: 'source', port: 'out' }, to: { node: 'right', port: 'choice' } },
      } : {} },
      body: { ...body, nodes: { leaf: { ...body.nodes['leaf']!, values: { 'mode.[a].gain': 7 } } } },
    } } as unknown as WorkflowDocument
    const compiledInputs = (document: WorkflowDocument) => {
      const result = compile({ document, revision: 1, resolve: localResolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) throw new Error('compile failed')
      return Object.entries(result.artifact.prompt).filter(([, node]) => node.class_type === 'Modal')
        .sort(([a], [b]) => a.localeCompare(b)).map(([, node]) => node.inputs)
    }
    const before = compiledInputs(doc)
    expect(before.map((inputs) => inputs['mode.gain'])).toEqual([9, 8])
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => localResolve }))
    const result = store.dispatch({ command: 'subgraph.extract', params: {
      graphId: 'body', instancePath: ['left', 'inner'], selection: { nodeIds: ['leaf'] },
      selectionFingerprint: lifecycleSelectionFingerprint(doc, 'body', { nodeIds: ['leaf'] })!,
      specializedSlotRoots: [], widgetTapSources: [], placementCenter: { x: 0, y: 0 },
      resolvedGeometry: [{ id: 'leaf', kind: 'node', x: 0, y: 0, width: 200, height: 200 }], name: 'Extracted conditional',
    } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(store.doc.graphs['body']!.boundary!.inputs[0]!.binds.kind).toBe(kind)
    const extracted = Object.values(store.doc.graphs).find((graph) => graph.name === 'Extracted conditional')!
    expect(extracted.boundary!.inputs[0]!.binds.kind).toBe(kind)
    expect(compiledInputs(store.doc)).toEqual(before)
    expect(store.doc.graphs['root']!.nodes).toEqual(doc.graphs['root']!.nodes)
    store.undo()
    expect(compiledInputs(store.doc)).toEqual(before)
    store.redo()
    expect(compiledInputs(store.doc)).toEqual(before)
  })

  it('retains an outer family owner when its members travel through full-branch wrappers', () => {
    const original = document()
    const root = original.graphs['root']!
    const middle = original.graphs['middle']!
    const doc = { ...original, graphs: { ...original.graphs,
      root: { ...root, nodes: { left: { id: 'left', type: '#outer', values: { 'extra.weight#m0': 7 }, dynamic: { extra: { members: ['m0'], seq: 1 } } } } },
      outer: { ...middle, id: 'outer', nodes: { inner: { id: 'inner', type: '#middle', values: {} } }, boundary: {
        inputs: [{ id: 'extra', binds: { kind: 'family', node: 'inner', port: 'choice.[a].items' } }], outputs: [],
      } },
    } } as unknown as WorkflowDocument
    const view = occurrenceDynamicView(doc, resolve, ['left', 'inner', 'inner'])
    const owner = view.familyOwners.get('leaf')?.get('mode.[a].items')
    expect(owner).toBeDefined()
    expect(owner).toMatchObject({ graphId: 'root', nodeId: 'left' })
    expect(view.values.get('leaf')?.['mode.[a].items.weight#\u0000m0']).toBe(7)
    const endpoint = occurrenceFamilyEndpoint(owner!, 'mode.[a].items.weight', ['\u0000m0'])
    expect(endpoint).toMatchObject({ occurrence: { instancePath: [], node: 'left' }, address: { port: 'extra.weight', members: ['m0'] } })
    expect(endpoint?.kind === 'boundary' && endpoint.route).toHaveLength(3)
  })

  it('maps a member-scoped subtree without leaking its fixed ancestor into instance identities', () => {
    const original = document()
    const body = original.graphs['body']!
    const schema: NodeSchema = { ...modal, items: [{ ...value('groups'), dynamic: {
      kind: 'autogrow', template: [modal.items[0] as InputSpec], naming: { kind: 'prefix', prefix: 'group', max: 3 },
    } }] }
    const scopedResolve = (type: string) => type === modal.type ? schema : undefined
    const doc = { ...original, graphs: { ...original.graphs, body: { ...body,
      nodes: { leaf: { ...body.nodes['leaf']!, values: { 'groups.mode.[a].gain#m0': 6 }, dynamic: {
        groups: { members: ['m0'], memberState: { m0: { 'groups.mode': { selected: 'a' } } } },
      } } },
      boundary: { inputs: [{ id: 'option', binds: { kind: 'dynamicCombo', node: 'leaf', port: 'groups.mode', members: ['m0'] } }], outputs: [] },
    } } } as unknown as WorkflowDocument
    const root = occurrenceDynamicView(doc, scopedResolve, [])
    expect(root.values.get('left')).toEqual({ 'choice.[a].gain': 6 })
    expect(root.dynamic.get('left')).toEqual({ choice: { selected: 'a' } })
    const inner = occurrenceDynamicView(doc, scopedResolve, ['left', 'inner'])
    expect(occurrenceSubtreeKey(inner.subtreeOwners.get('leaf')![0]!, 'groups.mode.[a].gain#m0')).toBe('choice.[a].gain')
    expect(occurrenceSubtreeKey(inner.subtreeOwners.get('leaf')![0]!, 'groups.mode.[a].gain#m1')).toBeUndefined()
    const compiled = compile({ document: doc, revision: 1, resolve: scopedResolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true)
    if (!compiled.ok) throw new Error('compile failed')
    expect(Object.values(compiled.artifact.prompt['left.inner.leaf']!.inputs)).toContain(6)
    expect(Object.values(compiled.artifact.prompt['right.inner.leaf']!.inputs)).toContain(8)
  })

  it('preserves inherited controller ownership through three crossings and save/reopen', () => {
    const original = document()
    const root = original.graphs['root']!
    const middle = original.graphs['middle']!
    const body = original.graphs['body']!
    const doc = { ...original, graphs: { ...original.graphs,
      root: { ...root, nodes: Object.fromEntries(Object.entries(root.nodes).map(([id, node]) => [id, { ...node, type: '#outer' }])) },
      outer: { ...middle, id: 'outer', nodes: { outer: { id: 'outer', type: '#middle', values: {} } }, boundary: {
        inputs: [{ id: 'choice', binds: { kind: 'dynamicCombo', node: 'outer', port: 'choice' } }], outputs: [],
      } },
      body: { ...body, nodes: { leaf: { ...body.nodes['leaf']!, controllers: { 'mode.[a].gain': 'increment' } } } },
    } } as unknown as WorkflowDocument
    const controllerSchema = { ...modal, items: modal.items.map((item) => item.kind === 'input' && item.dynamic?.kind === 'dynamicCombo' ? {
      ...item, dynamic: { ...item.dynamic, options: item.dynamic.options.map((option) => ({ ...option, inputs: option.inputs.map((input) => input.id === 'gain'
        ? { ...input, widget: { ...input.widget!, controller: 'after_generate' as const } } : input) })) },
    } : item) }
    const controllerResolve = (type: string) => type === modal.type ? controllerSchema : undefined
    const reopened: WorkflowDocument = JSON.parse(JSON.stringify(doc))
    expect(validateDocumentShape(reopened)).toEqual([])
    const view = occurrenceDynamicView(reopened, controllerResolve, ['left', 'outer', 'inner'])
    expect(view.controllers.get('leaf')).toEqual({ 'mode.[a].gain': 'increment' })
    expect(occurrenceSubtreeKey(view.subtreeOwners.get('leaf')![0]!, 'mode.[a].gain')).toBe('choice.[a].gain')
    const result = compile({ document: reopened, revision: 1, resolve: controllerResolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error('compile failed')
    const controller = result.artifact.provenance.controllerInputs!.find((entry) => entry.runtimeId === 'left.outer.inner.leaf' && entry.terminal.valueKey === 'mode.[a].gain')!
    expect(controller.driven).toBe(false)
    expect(controller.sources[0]).toEqual({ graph: 'root', occurrence: { instancePath: [], node: 'left' }, valueKey: 'choice.[a].gain' })
    expect(doc.graphs['body']).toEqual(reopened.graphs['body'])
  })

  it('keeps descendant addresses intact in persisted nested occurrence link routes', () => {
    const original = document()
    const doc = { ...original, occurrenceTopologies: { 'left.inner': {
      owner: { instancePath: ['left'], node: 'inner' }, bodyGraph: 'body', links: {
        link: { id: 'link', from: { kind: 'body', endpoint: { node: 'leaf', port: 'out' } }, to: {
          kind: 'boundary', occurrence: { instancePath: [], node: 'left' }, address: { port: 'choice.[a].gain' },
          route: [
            { graph: 'middle', boundaryId: 'choice', binding: original.graphs['middle']!.boundary!.inputs[0]!.binds },
            { graph: 'body', boundaryId: 'option', binding: original.graphs['body']!.boundary!.inputs[0]!.binds },
          ],
        } },
      }, nextOrdinal: 10,
    } } } as unknown as WorkflowDocument
    expect(checkDocument(doc)).toEqual([])
  })

  it('protects unconnected inherited family members from definition compaction', () => {
    const original = document()
    const body = original.graphs['body']!
    const doc = { ...original, graphs: { ...original.graphs, body: { ...body, nodes: {
      leaf: { ...body.nodes['leaf']!, values: {} },
    } } } }
    const store = new DocumentStore(doc, coreCommandRegistry())
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'body', nodeId: 'leaf' } }).ok).toBe(true)
    expect(store.doc.graphs['body']!.nodes['leaf']!.dynamic).toEqual(body.nodes['leaf']!.dynamic)
  })

  it('replays inherited growth without schema authority and rejects malformed inherited snapshots', () => {
    const original = document()
    const registry = coreCommandRegistry()
    const command = registry.get('dynamic.materialize')!
    const params = { graphId: 'root', nodeId: 'left', frames: [{ construct: 'choice.[a].items', members: ['m1'] }] }
    const prepared = command.prepareForSharedReplay!(original, params, { kind: 'initial', schemaResolverFor: () => resolve }, undefined)!
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('preparation failed')
    const store = new DocumentStore(original, registry, 200, undefined, () => ({ kind: 'shared-replay' }))
    expect(store.dispatch({ command: command.id, params: prepared.params }).ok).toBe(true)
    expect(store.doc.graphs['root']!.nodes['left']!.dynamic?.['choice.[a].items']?.members).toEqual(['m0', 'm1'])
    const before = store.doc
    expect(store.dispatch({ command: command.id, params: { ...params, inheritedDynamic: { invalid: { members: 'not an array' } } } })).toMatchObject({ ok: false, diagnostics: [{ code: 'dynamic.invalidInheritedState' }] })
    expect(store.doc).toBe(before)
  })

  it('copies inherited members on growth without colliding with their IDs or mutating the definition', () => {
    const original = document()
    const store = new DocumentStore(original, coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => resolve }))
    const result = store.dispatch({ command: 'dynamic.materialize', params: {
      graphId: 'root', nodeId: 'left', frames: [{ construct: 'choice.[a].items', members: ['m1'] }],
    } })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(store.doc.graphs['root']!.nodes['left']!.dynamic).toEqual({ 'choice.[a].items': { members: ['m0', 'm1'], seq: 2 } })
    expect(store.doc.graphs['body']).toEqual(original.graphs['body'])
    expect(occurrenceDynamicView(store.doc, resolve, []).dynamic.get('right')?.['choice.[a].items']?.members).toEqual(['m0'])
    store.undo()
    expect(store.doc.graphs['root']!.nodes['left']!.dynamic).toEqual({ 'choice.[a].items': { seq: 2 } })
    expect(occurrenceDynamicView(store.doc, resolve, []).dynamic.get('left')?.['choice.[a].items']?.members).toEqual(['m0'])
    store.redo()
    expect(occurrenceDynamicView(store.doc, resolve, []).dynamic.get('left')?.['choice.[a].items']?.members).toEqual(['m0', 'm1'])
  })

  it('defaults new combo boundaries to full branches while explicit selector-only authoring stays available', () => {
    const original = document()
    const body = original.graphs['body']!
    const doc = { ...original, graphs: { ...original.graphs, body: { ...body, boundary: { inputs: [], outputs: [] } } } }
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => resolve }))
    expect(store.dispatch({ command: 'boundary.addItem', params: { graphId: 'body', side: 'inputs', node: 'leaf', port: 'mode' } }).ok).toBe(true)
    expect(store.doc.graphs['body']!.boundary!.inputs[0]!.binds.kind).toBe('dynamicCombo')
    store.undo()
    expect(store.dispatch({ command: 'boundary.addItem', params: { graphId: 'body', side: 'inputs', node: 'leaf', port: 'mode', bindingKind: 'port' } }).ok).toBe(true)
    expect(store.doc.graphs['body']!.boundary!.inputs[0]!.binds.kind).toBe('port')
  })

  it('uses field presence for empty, stale, and nested state masks', () => {
    expect(mergeDynamicScope({ mode: { selected: 'a' }, items: { members: ['m0'], memberState: { m0: { nested: { selected: 'valid' } } } } }, {
      mode: {}, items: { members: [], memberState: { m0: { nested: { selected: 'removed' } } } },
    })).toEqual({ mode: {}, items: { members: [], memberState: { m0: { nested: { selected: 'removed' } } } } })
    const doc = document()
    const left = doc.graphs['root']!.nodes['left']!
    const masked = { ...doc, graphs: { ...doc.graphs, root: { ...doc.graphs['root']!, nodes: {
      ...doc.graphs['root']!.nodes, left: { ...left, dynamic: { choice: {}, 'choice.[a].items': { members: [] } } },
    } } } }
    expect(occurrenceDynamicView(masked, resolve, ['left', 'inner']).dynamic.get('leaf')).toEqual({ mode: {}, 'mode.[a].items': { members: [], seq: 1 } })
  })

  it('inherits nested state in the root view and preserves sibling branch isolation through two wrappers', () => {
    const doc = document()
    const before = JSON.stringify(doc)
    const root = occurrenceDynamicView(doc, resolve, [])
    expect(root.dynamic.get('left')).toEqual({ choice: { selected: 'a' }, 'choice.[a].items': { members: ['m0'], seq: 1 } })
    expect(root.values.get('left')).toEqual({ 'choice.[a].gain': 3, 'choice.[a].items.weight#m0': 4 })
    const inner = occurrenceDynamicView(doc, resolve, ['left', 'inner'])
    expect(inner.dynamic.get('leaf')).toEqual(doc.graphs['body']!.nodes['leaf']!.dynamic)
    expect(occurrenceSubtreeKey(inner.subtreeOwners.get('leaf')![0]!, 'mode.[a].items.weight#m0')).toBe('choice.[a].items.weight#m0')
    const result = compile({ document: doc, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error('compile failed')
    expect(result.artifact.prompt['left.inner.leaf']!.inputs).toEqual({ mode: 'a', 'mode.gain': 3, 'mode.items.item0': 4 })
    expect(result.artifact.prompt['right.inner.leaf']!.inputs).toEqual({ mode: 'b', 'mode.gain': 8 })
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('retains selector-only documents and diagnoses their definition-owned dependents', () => {
    const doc = document('port')
    const derived = deriveBoundarySchema(doc.graphs['body']!, documentResolver(doc, resolve))
    expect(derived.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['boundary.selectorOnly'])
    expect(derived.schema?.items[0]).toMatchObject({ dynamic: { options: [{ key: 'a', inputs: [] }, { key: 'b', inputs: [] }] } })
  })

  it('forwards specialized slots through two wrappers with independent values, variants, and type identities', () => {
    const concrete = (name: string) => ({ kind: 'concrete' as const, name })
    const variable = { kind: 'variable' as const, templateId: 'T' }
    const slotSchema: NodeSchema = { ...modal, items: [{
      kind: 'input', id: 'mode', type: variable, optional: true,
      dynamic: { kind: 'dynamicSlot', slotType: variable, typeTemplateId: 'T', inputs: [value('shared')], variants: [
        { key: 'a', type: concrete('INT'), inputs: [value('gain')] },
        { key: 'b', type: concrete('FLOAT'), inputs: [value('gain')] },
      ] },
    }] }
    const slotResolve = (type: string): NodeSchema | undefined => type === 'Modal' ? slotSchema :
      type === 'INT' || type === 'FLOAT' ? { ...modal, type, isOutputNode: false, items: [{ kind: 'output', id: 'out', type: concrete(type) }] } : undefined
    const original = document('slot')
    const root = original.graphs['root']!
    const doc = { ...original, graphs: { ...original.graphs, root: { ...root,
      nodes: { ...root.nodes, int: { id: 'int', type: 'INT', values: {} }, float: { id: 'float', type: 'FLOAT', values: {} } },
      links: {
        li: { id: 'li', from: { node: 'int', port: 'out' }, to: { node: 'left', port: 'choice' } },
        lf: { id: 'lf', from: { node: 'float', port: 'out' }, to: { node: 'right', port: 'choice' } },
      },
    } } } as unknown as WorkflowDocument
    const derived = deriveBoundarySchema(doc.graphs['middle']!, documentResolver(doc, slotResolve))
    expect(derived.diagnostics).toEqual([])
    expect(derived.schema?.items[0]).toMatchObject({ dynamic: { typeTemplateId: 'inner:leaf:T', slotType: { templateId: 'inner:leaf:T' } } })
    const before = JSON.stringify(doc)
    const result = compile({ document: doc, revision: 1, resolve: slotResolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw new Error('compile failed')
    expect(result.artifact.prompt['left.inner.leaf']).toEqual({ class_type: 'Modal', inputs: { mode: ['int', 0], 'mode.shared': 1, 'mode.gain': 3 }, outputIds: [], slotVariants: { mode: 'a' } })
    expect(result.artifact.prompt['right.inner.leaf']).toEqual({ class_type: 'Modal', inputs: { mode: ['float', 0], 'mode.shared': 1, 'mode.gain': 8 }, outputIds: [], slotVariants: { mode: 'b' } })
    expect(JSON.stringify(doc)).toBe(before)
  })
})
