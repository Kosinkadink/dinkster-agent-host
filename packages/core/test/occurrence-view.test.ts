import { describe, expect, it } from 'vitest'
import { compile, documentNodeResolver, documentResolver } from '../src/compile/compile.js'
import { occurrenceDynamicView, occurrenceFamilyEndpoint } from '../src/compile/occurrence-view.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asGraphDefId, asNodeId, asPortId } from '../src/ids.js'
import type { InputSpec, NodeSchema } from '../src/schema/model.js'

const combo: InputSpec = {
  kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
  dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [] }, { key: 'b', inputs: [] }] },
}
const schema: NodeSchema = { type: 'Combo', displayName: 'Combo', category: 'test', source: 'v3', isOutputNode: false, items: [combo] }
const familySchema: NodeSchema = {
  type: 'Family', displayName: 'Family', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'items', type: { kind: 'concrete', name: 'STRING' }, optional: true,
    dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: true }], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 } } }],
}
const nestedFamilySchema: NodeSchema = {
  type: 'NestedFamily', displayName: 'NestedFamily', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'items', type: { kind: 'concrete', name: 'STRING' }, optional: true,
    dynamic: { kind: 'autogrow', template: [
      { kind: 'input', id: 'sub', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: true }], naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 8 } } },
    ], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 } } }],
}
const countOutputSchema: NodeSchema = {
  type: 'CountOutput', displayName: 'CountOutput', category: 'test', source: 'v3', isOutputNode: false,
  items: [
    {
      kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: true,
      widget: { widgetType: 'INT', options: {}, default: 0 },
    },
    {
      kind: 'output', id: 'items', type: { kind: 'concrete', name: 'STRING' },
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'item', type: { kind: 'concrete', name: 'STRING' }, optional: true }],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ],
}
const resolve = (type: string) =>
  type === 'Combo'
    ? schema
    : type === 'Family'
      ? familySchema
      : type === 'NestedFamily'
        ? nestedFamilySchema
        : type === 'CountOutput' ? countOutputSchema : undefined
const graph = (id: string, nodes: Record<string, unknown>, boundary?: unknown) => ({
  id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10, ...(boundary ? { boundary } : {}),
})
const node = (id: string, type: string, selected?: string) => ({
  id, type, values: {}, ...(selected === undefined ? {} : { dynamic: { choice: { selected } } }),
})
const boundary = (target: string, port = 'mode') => ({ inputs: [{ id: 'choice', binds: { kind: 'port', node: target, port } }], outputs: [] })
const docOf = (selected?: string): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'test', root: 'g0',
  graphs: {
    g0: graph('g0', { s: node('s', '#sub', selected) }),
    sub: graph('sub', { n: node('n', 'Combo'), other: node('other', 'Combo') }, boundary('n')),
  },
  view: { graphs: {} },
} as unknown as WorkflowDocument)

describe('occurrenceDynamicView', () => {
  it('overlays a valid occurrence choice and records its instance owner', () => {
    const view = occurrenceDynamicView(docOf('b'), resolve, ['s'])
    expect(view.dynamic.get('n')?.mode?.selected).toBe('b')
    expect(view.selectorOwners.get('n')?.get('mode')).toEqual({ graphId: 'g0', nodeId: 's', boundaryId: 'choice' })
  })

  it.each([undefined, 'removed'])('records the owner without overlay for choice %s', (selected) => {
    const view = occurrenceDynamicView(docOf(selected), resolve, ['s'])
    expect(view.dynamic.size).toBe(0)
    expect(view.selectorOwners.get('n')?.has('mode')).toBe(true)
  })

  it('propagates the outermost choice and owner through chained forwarding', () => {
    const doc = docOf('b') as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', { s: node('s', '#outer', 'b') })
    ;(doc.graphs as unknown as Record<string, unknown>).outer = graph('outer', { i: node('i', '#sub') }, boundary('i', 'choice'))
    const view = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s', 'i'])
    expect(view.dynamic.get('n')?.mode?.selected).toBe('b')
    expect(view.selectorOwners.get('n')?.get('mode')).toEqual({ graphId: 'g0', nodeId: 's', boundaryId: 'choice' })
  })

  it('resolves a selector forwarded through a nested region occurrence', () => {
    const comboIo: NodeSchema = {
      ...schema,
      type: 'ComboIO',
      items: [
        ...schema.items,
        { kind: 'input', id: 'stateIn', type: combo.type, optional: false },
        { kind: 'output', id: 'stateOut', type: combo.type },
      ],
    }
    const resolveIo = (type: string) => type === 'ComboIO' ? comboIo : resolve(type)
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', { s: node('s', '#outer', 'b') })
    ;(doc.graphs as unknown as Record<string, unknown>).outer = graph('outer', {
      i: {
        id: 'i', type: '#body', values: {},
        region: { kind: 'fold', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } } },
      },
    }, boundary('i', 'choice'))
    ;(doc.graphs as unknown as Record<string, unknown>).body = graph('body', { n: node('n', 'ComboIO') }, {
      inputs: [
        { id: 'choice', binds: { kind: 'port', node: 'n', port: 'mode' } },
        { id: 'state', binds: { kind: 'port', node: 'n', port: 'stateIn' } },
      ],
      outputs: [{ id: 'result', binds: { kind: 'port', node: 'n', port: 'stateOut' } }],
    })

    const docResolve = documentResolver(doc, resolveIo)
    const occurrenceSchema = documentNodeResolver(doc, docResolve)('outer', doc.graphs.outer!.nodes.i!)
    expect(occurrenceSchema?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'choice', dynamic: expect.anything() })]))
    const view = occurrenceDynamicView(doc, docResolve, ['s'])
    expect(view.dynamic.get('i')?.choice?.selected).toBe('b')
    expect(view.selectorOwners.get('i')?.get('choice')).toEqual({ graphId: 'g0', nodeId: 's', boundaryId: 'choice' })
  })

  it('returns empty maps for an empty path', () => {
    const view = occurrenceDynamicView(docOf('b'), resolve, [])
    expect(view.dynamic.size).toBe(0)
    expect(view.selectorOwners.size).toBe(0)
  })

  it('does not project a selector that is not forwarded', () => {
    const view = occurrenceDynamicView(docOf('b'), resolve, ['s'])
    expect(view.dynamic.has('other')).toBe(false)
    expect(view.selectorOwners.has('other')).toBe(false)
  })

  it('merges a definition family prefix with an occurrence suffix and records its owner', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      s: { id: 's', type: '#sub', values: {}, dynamic: {
        forwarded: { members: ['s0', 's1'], memberLabels: { s0: 'Background', s1: 'Subject' } },
      } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', {
      n: { id: 'n', type: 'Family', values: {}, dynamic: { items: { members: ['d0'] } } },
    }, { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })
    const view = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s'])
    expect(view.dynamic.get('n')?.items?.members).toEqual(['d0', '\u0000s0', '\u0000s1'])
    expect(view.dynamic.get('n')?.items?.memberLabels).toEqual({
      '\u0000s0': 'Background',
      '\u0000s1': 'Subject',
    })
    expect(view.familyOwners.get('n')?.get('items')).toMatchObject({
      graphId: 'g0', nodeId: 's', boundaryId: 'forwarded',
      occurrence: { instancePath: [], node: 's' },
      route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'items' } }],
    })
    expect([...view.familyOwners.get('n')!.get('items')!.suffixMembers]).toEqual([['\u0000s0', 's0'], ['\u0000s1', 's1']])
    expect(view.familyOwners.get('n')!.get('items')!.suffixOwners.get('\u0000s0')).toMatchObject({
      occurrence: { instancePath: [], node: 's' }, sourceMember: 's0',
    })
  })

  it('reverses a nested suffix coordinate and allocates a ghost from the owner high-water mark', () => {
    const route = [{
      graph: asGraphDefId('sub'), boundaryId: 'forwarded',
      binding: { kind: 'family' as const, node: asNodeId('n'), port: asPortId('items') },
    }]
    const owner = {
      graphId: 'g0', nodeId: 's', boundaryId: 'forwarded',
      occurrence: { instancePath: [], node: asNodeId('s') }, familyPath: 'items', route,
      suffixMembers: new Map([['\u0000s0', 's0']]),
      suffixOwners: new Map([['\u0000s0', {
        graphId: 'g0', nodeId: 's', boundaryId: 'forwarded',
        occurrence: { instancePath: [], node: asNodeId('s') }, sourceMember: 's0', route,
      }]]),
      ghostOwner: {
        graphId: 'g0', nodeId: 's', boundaryId: 'forwarded',
        occurrence: { instancePath: [], node: asNodeId('s') }, sourceMember: 'm7', route,
      },
    }
    expect(occurrenceFamilyEndpoint(owner, 'items.value', ['ancestor', '\u0000s0'])).toMatchObject({
      address: { port: 'forwarded.value', members: ['s0'] },
    })
    expect(occurrenceFamilyEndpoint(owner, 'items.value', ['ancestor', 'derivedGhost'], 'derivedGhost')).toMatchObject({
      address: { port: 'forwarded.value', members: ['m7'] },
    })
  })

  it('keeps sibling occurrence suffixes independent', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      a: { id: 'a', type: '#sub', values: {}, dynamic: { forwarded: { members: ['a0'] } } },
      b: { id: 'b', type: '#sub', values: {}, dynamic: { forwarded: { members: ['b0', 'b1'] } } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', { n: { id: 'n', type: 'Family', values: {} } },
      { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })
    expect(occurrenceDynamicView(doc, documentResolver(doc, resolve), ['a']).dynamic.get('n')?.items?.members).toEqual(['\u0000a0'])
    expect(occurrenceDynamicView(doc, documentResolver(doc, resolve), ['b']).dynamic.get('n')?.items?.members).toEqual(['\u0000b0', '\u0000b1'])
  })

  it('projects promoted output counts and keeps inherited edits occurrence-local', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      explicit: { id: 'explicit', type: '#sub', values: { amount: 3 } },
      inherited: { id: 'inherited', type: '#sub', values: {} },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', {
      n: { id: 'n', type: 'CountOutput', values: { count: 2 } },
    }, {
      inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
      outputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }],
    })

    const explicit = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['explicit'])
    expect(explicit.values.get('n')).toEqual({ count: 3 })
    expect(explicit.valueOwners.get('n')?.get('count')).toEqual({ graphId: 'g0', nodeId: 'explicit', valueKey: 'amount' })

    const inherited = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['inherited'])
    expect(inherited.values.get('n')).toBeUndefined()
    expect(inherited.valueOwners.get('n')?.get('count')).toEqual({ graphId: 'g0', nodeId: 'inherited', valueKey: 'amount' })
    expect(inherited.dynamic.size).toBe(0)
    expect(inherited.familyOwners.size).toBe(0)
  })

  it('rebases nested autogrow memberState through a family crossing', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      s: { id: 's', type: '#sub', values: {}, dynamic: {
        forwarded: { members: ['x0'], memberState: { x0: { 'forwarded.sub': { members: ['y0'] } } } },
      } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', {
      n: { id: 'n', type: 'NestedFamily', values: {} },
    }, { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })

    const state = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s']).dynamic.get('n')?.items
    expect(state?.members).toEqual(['\u0000x0'])
    expect(state?.memberState?.['\u0000x0']?.['items.sub']?.members).toEqual(['y0'])
  })

  it('walks two family forwarding hops and projects the outermost suffix', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      s: { id: 's', type: '#outer', values: {}, dynamic: { outerFam: { members: ['root0'] } } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).outer = graph('outer', {
      i: { id: 'i', type: '#inner', values: {}, dynamic: { innerFam: { members: ['middle0'] } } },
    }, { inputs: [{ id: 'outerFam', binds: { kind: 'family', node: 'i', port: 'innerFam' } }], outputs: [] })
    ;(doc.graphs as unknown as Record<string, unknown>).inner = graph('inner', {
      n: { id: 'n', type: 'Family', values: {}, dynamic: { items: { members: ['definition0'] } } },
    }, { inputs: [{ id: 'innerFam', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })

    const view = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s', 'i'])
    expect(view.dynamic.get('n')?.items?.members).toEqual(['definition0', '\u0000middle0', '\u0000\u0000root0'])
    const familyOwner = view.familyOwners.get('n')!.get('items')!
    expect(familyOwner).toMatchObject({
      graphId: 'outer', nodeId: 'i', boundaryId: 'innerFam',
      occurrence: { instancePath: ['s'], node: 'i' },
      route: [{ graph: 'inner', boundaryId: 'innerFam', binding: { kind: 'family', node: 'n', port: 'items' } }],
    })
    expect(familyOwner.suffixOwners.get('\u0000middle0')).toMatchObject({
      graphId: 'outer', nodeId: 'i', boundaryId: 'innerFam', sourceMember: 'middle0',
      occurrence: { instancePath: ['s'], node: 'i' },
    })
    expect(familyOwner.suffixOwners.get('\u0000\u0000root0')).toMatchObject({
      graphId: 'g0', nodeId: 's', boundaryId: 'outerFam', sourceMember: 'root0',
      occurrence: { instancePath: [], node: 's' },
      route: [
        { graph: 'outer', boundaryId: 'outerFam', binding: { kind: 'family', node: 'i', port: 'innerFam' } },
        { graph: 'inner', boundaryId: 'innerFam', binding: { kind: 'family', node: 'n', port: 'items' } },
      ],
    })
  })

  it('matches the real compiler member order for a definition prefix and instance suffix', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      s: { id: 's', type: '#sub', values: { 'forwarded.value#s0': 'suffix 0', 'forwarded.value#s1': 'suffix 1' }, dynamic: { forwarded: { members: ['s0', 's1'] } } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', {
      n: { id: 'n', type: 'Family', values: { 'items.value#d0': 'prefix' }, dynamic: { items: { members: ['d0'] } } },
    }, { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })

    const members = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s']).dynamic.get('n')?.items?.members
    const result = compile({ document: doc, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'test' })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(members).toEqual(['d0', '\u0000s0', '\u0000s1'])
    expect(Object.keys(result.artifact.prompt['s.n']!.inputs)).toEqual(members!.map((_, ordinal) => `items.item${ordinal}`))
  })

  it('returns empty family state for an unknown path', () => {
    const view = occurrenceDynamicView(docOf(), resolve, ['missing'])
    expect(view.dynamic.size).toBe(0)
    expect(view.familyOwners.size).toBe(0)
  })
})
