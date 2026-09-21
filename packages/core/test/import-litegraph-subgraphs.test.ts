import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { loadDocument } from '../src/format/migrate.js'
import type { Json, JsonObject, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'

const schema: NodeSchema = {
  type: 'Relay', displayName: 'Relay', category: 'test', source: 'v3', isOutputNode: true,
  items: [
    { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: {}, default: 5 } },
    { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'INT' } },
  ],
}
const resolve = (type: string) => type === 'Relay' ? schema : undefined
const link = (id: number, from: number, fromSlot: number, to: number, toSlot: number) =>
  ({ id, origin_id: from, origin_slot: fromSlot, target_id: to, target_slot: toSlot, type: 'INT' })
const relay = (id = 1) => ({ id, type: 'Relay', inputs: [{ name: 'value', widget: { name: 'value' }, link: 1 }],
  outputs: [{ name: 'result' }], widgets_values: [7] as Json[] })
const definition = (id = 'inner') => ({
  id, name: id, version: 1, nodes: [relay()],
  inputs: [{ id: 'in', name: 'value', type: 'INT', linkIds: [1] }],
  outputs: [{ id: 'out', name: 'result', type: 'INT', linkIds: [2] }],
  links: [link(1, -10, 0, 1, 0), link(2, 1, 0, -20, 0)],
})
const instance = (id: number, type = 'inner', value = 19) => ({ id, type,
  inputs: [{ name: 'value', widget: { name: 'value' } }], outputs: [{ name: 'result' }], widgets_values: [value] })
const imported = (raw: unknown, resolver = resolve): WorkflowDocument => {
  const result = importLitegraph(raw as JsonObject, resolver)
  expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
  expect(result.document).toBeDefined()
  expect(loadDocument(result.document).document).toEqual(result.document)
  return result.document!
}
const prompt = (document: WorkflowDocument, resolver = resolve) => {
  const result = compile({ document, revision: 1, resolve: resolver, scope: { kind: 'full' },
    connection: asConnectionId('test'), schemaHash: 'test' })
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('compile failed')
  return result.artifact.prompt
}

describe('LiteGraph subgraphs', () => {
  it('maps UUID ports, widget values, output indices and fan-out through a reusable definition', () => {
    const def = definition()
    def.nodes.push(relay(2))
    def.links.push(link(3, -10, 0, 2, 0))
    def.inputs[0]!.linkIds.push(3)
    const raw = { nodes: [instance(1), instance(2, 'inner', 31)], links: [], definitions: { subgraphs: [def] } }
    const doc = imported(raw)
    expect(doc.graphs['inner']!.boundary).toEqual({ inputs: [{ id: 'in', displayName: 'value', promoted: true,
      binds: { kind: 'port', node: 'n1', port: 'value' }, alsoBinds: [{ kind: 'port', node: 'n2', port: 'value' }] }],
    outputs: [{ id: 'out', displayName: 'result', binds: { kind: 'port', node: 'n1', port: 'result' } }] })
    expect(doc.graphs.g0!.nodes.n1!.type).toBe('#inner')
    expect(doc.graphs.g0!.nodes.n1!.values).toEqual({ in: 19 })
    expect(doc.graphs.g0!.nodes.n2!.values).toEqual({ in: 31 })
    expect(doc.graphs['inner']!.nodes.n1!.values).toEqual({ value: 7 })
    expect(Object.values(prompt(doc)).map((node) => node.inputs['value']).sort()).toEqual([19, 19, 31, 31])
    expect(imported(raw)).toEqual(doc)
  })

  it('retains recursive definition catalogs and nested instances', () => {
    const outer = { ...definition('outer'), nodes: [instance(1)], definitions: { subgraphs: [definition()] } }
    const doc = imported({ nodes: [instance(1, 'outer')], links: [], definitions: { subgraphs: [outer] } })
    expect(Object.keys(doc.graphs).sort()).toEqual(['g0', 'inner', 'outer'])
    expect(doc.graphs['outer']!.nodes.n1!.type).toBe('#inner')
    expect(doc.graphs.g0!.nodes.n1!.type).toBe('#outer')
    expect(prompt(doc)['n1.n1.n1']!.inputs['value']).toBe(19)
  })

  it('inlines a structural boundary while retaining nested definitions and instances', () => {
    const outer = { ...definition('outer'), nodes: [instance(1), { id: 2, type: 'Reroute',
      inputs: [{ name: '', link: 1 }], outputs: [{ name: '' }] }],
    links: [link(1, -10, 0, 2, 0), link(2, 2, 0, 1, 0), link(3, 1, 0, -20, 0)] }
    const raw = { nodes: [instance(1, 'outer'), instance(2, 'outer', 31)], links: [], definitions: { subgraphs: [outer, definition()] } }
    const result = importLitegraph(raw as unknown as JsonObject, resolve)
    expect(result.diagnostics.map((item) => item.code)).toContain('import.subgraphs.inlined')
    const doc = imported(raw)
    expect(Object.keys(doc.graphs).sort()).toEqual(['g0', 'inner'])
    expect(Object.values(doc.graphs.g0!.nodes).map((node) => node.type)).toEqual(['#inner', '#inner'])
    expect(Object.values(doc.graphs.g0!.valueSources!).map((source) => source.value)).toEqual([19, 31])
    expect(Object.keys(doc.graphs.g0!.reroutes)).toHaveLength(2)
    expect(Object.values(prompt(doc)).map((node) => node.inputs['value']).sort()).toEqual([19, 31])
  })

  it('migrates legacy proxy widgets without interpreting missing host values as overrides', () => {
    const def = { ...definition(), inputs: [], links: [link(2, 1, 0, -20, 0)] }
    const node = { ...instance(1), inputs: [], properties: { proxyWidgets: [['1', 'value']] }, widgets_values: [] }
    const doc = imported({ nodes: [node], links: [], definitions: { subgraphs: [def] } })
    expect(doc.graphs['inner']!.boundary!.inputs[0]!.promoted).toBe(true)
    expect(doc.graphs.g0!.nodes.n1!.values).toEqual({})
    expect(doc.graphs['inner']!.nodes.n1!.values).toEqual({ value: 7 })
  })

  it('keeps modern promoted seed values separate from implicit controller entries', () => {
    const controlled: NodeSchema = { ...schema, items: [
      { ...schema.items[0]!, kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {}, controller: 'after_generate' } }, schema.items[1]!,
    ] }
    const resolver = (type: string) => type === 'Relay' ? controlled : undefined
    const def = definition()
    def.nodes[0]!.widgets_values.push('fixed')
    const doc = imported({ nodes: [instance(1)], links: [], definitions: { subgraphs: [def] } }, resolver)
    expect(doc.graphs.g0!.nodes.n1!.values).toEqual({ in: 19 })
    expect(doc.graphs['inner']!.nodes.n1!.controllers).toEqual({ value: 'fixed' })
    expect(prompt(doc, resolver)['n1.n1']!.inputs['value']).toBe(19)
  })

  it('uses the authored input.link and first virtual-output driver like LiteGraph', () => {
    const def = definition()
    def.nodes.push(relay(2))
    def.nodes[0]!.inputs[0]!.link = 4
    def.links.push(link(3, 2, 0, -20, 0), link(4, 2, 0, 1, 0))
    const doc = imported({ nodes: [instance(1)], definitions: { subgraphs: [def] } })
    const compiled = prompt(doc)
    expect(Object.values(compiled).find((node) => Array.isArray(node.inputs['value']))?.inputs['value']).toEqual(['n1_n2', 0])
  })

  it('maps input members using the existing autogrow decoder', () => {
    const family: NodeSchema = { ...schema, type: 'Family', items: [
      { kind: 'input', id: 'items', type: { kind: 'concrete', name: 'INT' }, optional: false,
        dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false }],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 5 } } }, schema.items[1]!,
    ] }
    const resolver = (type: string) => type === 'Family' ? family : resolve(type)
    const def = { ...definition(), nodes: [{ id: 1, type: 'Family',
      inputs: [{ name: 'items.item2', link: 1 }], outputs: [{ name: 'result' }] }] }
    const doc = imported({ nodes: [instance(1)], definitions: { subgraphs: [def] } }, resolver)
    expect(doc.graphs['inner']!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'items.value', members: ['m0'] })
  })

  it.each([2, 4])('preserves mode %s when inlining a structural producer', (mode) => {
    const def = { ...definition(), nodes: [{ id: 1, type: 'PrimitiveNode', widgets_values: [7], outputs: [{ name: 'INT' }] }],
      inputs: [], links: [link(2, 1, 0, -20, 0)] }
    const target = { ...relay(2), inputs: [{ name: 'value', widget: { name: 'value' }, link: 1 }] }
    const doc = imported({ nodes: [{ ...instance(1), inputs: [], widgets_values: [], mode }, target], links: [[1, 1, 0, 2, 0, 'INT']], definitions: { subgraphs: [def] } })
    expect(prompt(doc)['n2']!.inputs['value']).toBe(7)
    expect(Object.values(doc.graphs.g0!.links)).toEqual([])
  })

  it('preserves per-instance primitive proxy values and controllers through fallback', () => {
    const def = { ...definition(), inputs: [], nodes: [
      { id: 1, type: 'PrimitiveNode', outputs: [{ name: 'INT' }], widgets_values: [7, 'fixed'] },
    ], links: [link(2, 1, 0, -20, 0)] }
    const host = (id: number, value: number) => ({ ...instance(id), inputs: [], widgets_values: [value, 'randomize'],
      properties: { proxyWidgets: [['1', 'value'], ['1', 'control_after_generate']] } })
    const doc = imported({ nodes: [host(1, 11), host(2, 29), relay(3), relay(4)],
      links: [[1, 1, 0, 3, 0, 'INT'], [2, 2, 0, 4, 0, 'INT']], definitions: { subgraphs: [def] } })
    expect(prompt(doc)['n3']!.inputs['value']).toBe(11)
    expect(prompt(doc)['n4']!.inputs['value']).toBe(29)
    expect(Object.values(doc.graphs.g0!.valueSources!).map((source) => source.controller)).toEqual(['randomize', 'randomize'])
  })

  it.each([['value', '2'], ['1: 2: value', undefined]])('resolves nested legacy widget %s without confusing identical names', (name, sourceId) => {
    const inner = definition()
    inner.nodes.push(relay(2))
    inner.inputs.push({ id: 'in2', name: 'value_1', type: 'INT', linkIds: [3] })
    inner.links.push(link(3, -10, 1, 2, 0))
    const nested = { ...instance(1), inputs: [{ name: 'value' }, { name: 'value_1' }], widgets_values: [] }
    const outer = { ...definition('outer'), nodes: [nested], inputs: [], links: [link(2, 1, 0, -20, 0)] }
    const host = { ...instance(1, 'outer', 37), inputs: [], properties: {
      proxyWidgets: [[...['1', name], ...(sourceId ? [sourceId] : [])]],
    } }
    const doc = imported({ nodes: [host], definitions: { subgraphs: [outer, inner] } })
    const compiled = prompt(doc)
    expect(compiled['n1.n1.n1']!.inputs['value']).toBe(7)
    expect(compiled['n1.n1.n2']!.inputs['value']).toBe(37)
  })

  it('includes definition contents in deterministic lineage', () => {
    const def = definition()
    const raw = { nodes: [instance(1)], definitions: { subgraphs: [def] } }
    const first = imported(raw)
    def.nodes[0]!.widgets_values[0] = 88
    expect(imported(raw).lineage).not.toBe(first.lineage)
  })

  it('maps a net delivery across a boundary without leaving a synthetic source', () => {
    const target = relay()
    target.inputs[0]!.link = 3
    const def = { ...definition(), nodes: [target,
      { id: 2, type: 'SetNode', inputs: [{ name: '*', type: 'INT', link: 1 }], outputs: [{ name: 'INT', type: 'INT', links: [] }], widgets_values: ['shared'] },
      { id: 3, type: 'GetNode', outputs: [{ name: 'INT', type: 'INT', links: [3] }], widgets_values: ['shared'] },
    ], links: [link(1, -10, 0, 2, 0), link(2, 1, 0, -20, 0), link(3, 3, 0, 1, 0)] }
    const doc = imported({ nodes: [instance(1), relay(2)], links: [[1, 2, 0, 1, 0, 'INT']], definitions: { subgraphs: [def] } })
    expect(doc.graphs['inner']!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'value' })
    expect(prompt(doc)['n1.n1']!.inputs['value']).toEqual(['n2', 0])
  })

  it.each(['inputs', 'outputs'] as const)('rejects duplicate %s identities before they can collapse instance state', (side) => {
    const def = definition()
    def.nodes.push(relay(2))
    def[side].push({ ...def[side][0]!, linkIds: [3] })
    def.links.push(side === 'inputs' ? link(3, -10, 1, 2, 0) : link(3, 2, 0, -20, 1))
    const host = { ...instance(1), widgets_values: [11, 22], inputs: [
      { name: 'value', widget: { name: 'value' } }, { name: 'value', widget: { name: 'value' } },
    ] }
    const result = importLitegraph({ nodes: [host], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'import.subgraphs.invalid', severity: 'error' })])
  })

  it.each([
    { inputNode: { id: 1 } },
    { outputNode: { id: '1' } },
    { inputNode: { id: 9 }, outputNode: { id: '9' } },
    { inputNode: { id: -20 } },
    { outputNode: { id: '-10' } },
  ])('rejects colliding virtual boundary IDs: %j', (fields) => {
    const result = importLitegraph({ nodes: [instance(1)], definitions: { subgraphs: [{ ...definition(), ...fields }] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'import.subgraphs.invalid', severity: 'error' })])
  })

  it('maps distinct custom virtual boundary IDs without changing real edges', () => {
    const def = { ...definition(), inputNode: { id: 41 }, outputNode: { id: '42' },
      links: [link(1, 41, 0, 1, 0), link(2, 1, 0, 42, 0)] }
    const doc = imported({ nodes: [instance(1)], definitions: { subgraphs: [def] } })
    expect(prompt(doc)['n1.n1']!.inputs['value']).toBe(19)
    expect(doc.graphs['inner']!.boundary!.outputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'result' })
  })

  it.each([
    { nodes: [{ id: { toString: 0, valueOf: 0 }, type: 'Relay' }] },
    { nodes: [null] },
    { nodes: [{ id: 1, type: 'Relay', inputs: 3 }] },
    { inputNode: { id: { toString: 0 } } },
    { links: [[1, null, 0, 1, 0]] },
    { inputs: [{ id: '__proto__' }] },
    { id: '__proto__' },
  ])('rejects malformed subgraph fields without throwing: %j', (fields) => {
    const result = importLitegraph({ nodes: [], definitions: { subgraphs: [{ ...definition(), ...fields }] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it('rejects recursive instance graphs and duplicate definition ids', () => {
    const cycle = { ...definition(), nodes: [instance(1)] }
    for (const defs of [[cycle], [definition(), definition()]]) {
      const result = importLitegraph({ nodes: [], links: [], definitions: { subgraphs: defs } } as unknown as JsonObject, resolve)
      expect(result.document).toBeUndefined()
      expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })
})
