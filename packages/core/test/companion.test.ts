/**
 * Companion-value source resolution: link/net-driven inputs resolve to
 * either a document-static literal (value source chains - always exact) or
 * a runtime producer (node output pair the host peeks against the bound
 * execution). Pure derivation over one GraphDef: no schemas, no execution,
 * no diagnostics - malformed chains just yield no companion.
 */
import { describe, expect, it } from 'vitest'
import { companionSourcesOf } from '../src/companion.js'
import type { GraphDef, Json, ValueSourceData } from '../src/format/document.js'
import type { NodeSchema } from '../src/schema/model.js'
import {
  asGraphDefId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
  asRerouteId,
  asValueSourceId,
} from '../src/ids.js'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const tap = (node: string, inputId: string) => ({ node: asNodeId(node), tap: asPortId(inputId) })
const rr = (id: string) => ({ reroute: asRerouteId(id) })
const vsrc = (id: string) => ({ valueSource: asValueSourceId(id) })
const node = (id: string, type = 'T', values: Readonly<Record<string, Json>> = {}) =>
  ({ id: asNodeId(id), type, values })
const reroute = (id: string) => ({ id: asRerouteId(id) })
const source = (id: string, value: Json): ValueSourceData =>
  ({ id: asValueSourceId(id), value }) as ValueSourceData
const link = (id: string, from: object, to: object) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]

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

const sourceOf = (def: GraphDef, nodeId: string, portId: string) =>
  companionSourcesOf(def).get(nodeId)?.get(portId)

const primitiveSchema = (typeName = 'core.int'): NodeSchema => ({
  type: 'Primitive',
  displayName: 'Primitive',
  category: '',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'value', type: { kind: 'concrete', name: typeName }, optional: true },
    {
      kind: 'output',
      id: 'result',
      type: { kind: 'concrete', name: typeName },
      knownValue: { input: 'value' },
    },
  ],
})

describe('companionSourcesOf', () => {
  it('resolves a direct value-source link to a literal companion', () => {
    const def = graph({
      id: 'g0',
      nodes: { n1: node('n1') },
      valueSources: { v1: source('v1', 7) },
      links: { l1: link('l1', vsrc('v1'), port('n1', 'steps')) },
    })
    expect(sourceOf(def, 'n1', 'steps')).toEqual({ kind: 'literal', value: 7 })
  })

  it.each([[0, 7], ['', 'changed']] as const)('uses a schema-aware fallback for unstored tap value %j and stored state still wins', (fallback, stored) => {
    const def = graph({
      id: 'g0',
      nodes: { source: node('source'), sink: node('sink') },
      links: { l1: link('l1', tap('source', 'value'), port('sink', 'in')) },
    })
    expect(companionSourcesOf(def).get('sink')?.get('in')).toBeUndefined()
    expect(companionSourcesOf(def, undefined, (nodeId, inputId) =>
      nodeId === 'source' && inputId === 'value' ? fallback : undefined,
    ).get('sink')?.get('in')).toEqual({ kind: 'literal', value: fallback })
    ;(def.nodes['source']!.values as Record<string, Json>)['value'] = stored
    expect(companionSourcesOf(def, undefined, () => fallback).get('sink')?.get('in'))
      .toEqual({ kind: 'literal', value: stored })
  })

  it('follows reroute chains to the value source (same trace the compiler lowers)', () => {
    const def = graph({
      id: 'g0',
      nodes: { n1: node('n1') },
      reroutes: { r1: reroute('r1'), r2: reroute('r2') },
      valueSources: { v1: source('v1', 'hello') },
      links: {
        l1: link('l1', vsrc('v1'), rr('r1')),
        l2: link('l2', rr('r1'), rr('r2')),
        l3: link('l3', rr('r2'), port('n1', 'text')),
      },
    })
    expect(sourceOf(def, 'n1', 'text')).toEqual({ kind: 'literal', value: 'hello' })
  })

  it('resolves a node-output link to a runtime producer', () => {
    const def = graph({
      id: 'g0',
      nodes: { producer: node('producer'), consumer: node('consumer') },
      links: { l1: link('l1', port('producer', 'out'), port('consumer', 'in')) },
    })
    expect(sourceOf(def, 'consumer', 'in')).toEqual({ kind: 'producer', node: 'producer', output: 'out' })
  })

  it.each([
    ['core.int', 7],
    ['core.float', 1.25],
    ['core.string', 'hello'],
    ['core.boolean', true],
  ] as const)('resolves a declared %s identity output to its typed literal', (typeName, value) => {
    const def = graph({
      id: 'g0',
      nodes: {
        primitive: node('primitive', 'Primitive', { value }),
        consumer: node('consumer'),
      },
      links: { l1: link('l1', port('primitive', 'result'), port('consumer', 'in')) },
    })
    const schema = primitiveSchema(typeName)
    const resolved = companionSourcesOf(
      def,
      undefined,
      undefined,
      (nodeType) => nodeType === 'Primitive' ? schema : undefined,
    ).get('consumer')?.get('in')
    expect(resolved).toEqual({ kind: 'literal', value })
    expect(typeof (resolved as { value: unknown }).value).toBe(typeof value)
  })

  it('follows identity output chains to a value source literal', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        first: node('first', 'Primitive'),
        second: node('second', 'Primitive'),
        consumer: node('consumer'),
      },
      valueSources: { v1: source('v1', 9) },
      links: {
        l1: link('l1', vsrc('v1'), port('first', 'value')),
        l2: link('l2', port('first', 'result'), port('second', 'value')),
        l3: link('l3', port('second', 'result'), port('consumer', 'in')),
      },
    })
    const schema = primitiveSchema()
    expect(companionSourcesOf(def, undefined, undefined, () => schema).get('consumer')?.get('in'))
      .toEqual({ kind: 'literal', value: 9 })
  })

  it('follows a mixed value-source, reroute, net, and identity chain', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        first: node('first', 'Primitive'),
        second: node('second', 'Primitive'),
        consumer: node('consumer'),
      },
      valueSources: { v1: source('v1', 12) },
      reroutes: { r1: reroute('r1'), r2: reroute('r2') },
      links: {
        l1: link('l1', vsrc('v1'), rr('r1')),
        l2: link('l2', rr('r1'), port('first', 'value')),
        l3: link('l3', port('second', 'result'), rr('r2')),
        l4: link('l4', rr('r2'), port('consumer', 'in')),
      },
      nets: {
        net1: {
          id: asNetId('net1'),
          name: 'identity',
          source: port('first', 'result'),
          sinks: [port('second', 'value')],
        } as GraphDef['nets'][string],
      },
    })
    const schema = primitiveSchema()
    expect(companionSourcesOf(def, undefined, undefined, () => schema).get('consumer')?.get('in'))
      .toEqual({ kind: 'literal', value: 12 })
  })

  it('uses the schema default resolver for an unstored identity input', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        primitive: node('primitive', 'Primitive'),
        consumer: node('consumer'),
      },
      links: { l1: link('l1', port('primitive', 'result'), port('consumer', 'in')) },
    })
    const schema = primitiveSchema('core.boolean')
    expect(companionSourcesOf(def, undefined, () => false, () => schema).get('consumer')?.get('in'))
      .toEqual({ kind: 'literal', value: false })
  })

  it('preserves an executed producer source behind a declared identity output', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        producer: node('producer'),
        primitive: node('primitive', 'Primitive'),
        consumer: node('consumer'),
      },
      links: {
        l1: link('l1', port('producer', 'out'), port('primitive', 'value')),
        l2: link('l2', port('primitive', 'result'), port('consumer', 'in')),
      },
    })
    const schema = primitiveSchema()
    expect(companionSourcesOf(def, undefined, undefined, (type) => type === 'Primitive' ? schema : undefined).get('consumer')?.get('in'))
      .toEqual({ kind: 'producer', node: 'producer', output: 'out' })
  })

  it('abstains when declared identity outputs form a graph cycle', () => {
    const def = graph({
      id: 'g0',
      nodes: { a: node('a', 'Primitive'), b: node('b', 'Primitive'), consumer: node('consumer') },
      links: {
        l1: link('l1', port('a', 'result'), port('b', 'value')),
        l2: link('l2', port('b', 'result'), port('a', 'value')),
        l3: link('l3', port('a', 'result'), port('consumer', 'in')),
      },
    })
    const schema = primitiveSchema()
    expect(companionSourcesOf(def, undefined, undefined, () => schema).get('consumer')?.get('in'))
      .toBeUndefined()
  })

  it('resolves net sinks to the net source producer', () => {
    const def = graph({
      id: 'g0',
      nodes: { producer: node('producer'), a: node('a'), b: node('b') },
      nets: {
        net1: {
          id: asNetId('net1'),
          name: 'net1',
          source: port('producer', 'out'),
          sinks: [port('a', 'in'), port('b', 'in')],
        } as GraphDef['nets'][string],
      },
    })
    expect(sourceOf(def, 'a', 'in')).toEqual({ kind: 'producer', node: 'producer', output: 'out' })
    expect(sourceOf(def, 'b', 'in')).toEqual({ kind: 'producer', node: 'producer', output: 'out' })
  })

  it('yields nothing for undriven reroutes, cycles, and missing value sources', () => {
    const def = graph({
      id: 'g0',
      nodes: { n1: node('n1'), n2: node('n2'), n3: node('n3') },
      reroutes: { r1: reroute('r1'), r2: reroute('r2'), r3: reroute('r3') },
      links: {
        // undriven: nothing feeds r1
        l1: link('l1', rr('r1'), port('n1', 'in')),
        // cycle: r2 <-> r3
        l2: link('l2', rr('r2'), rr('r3')),
        l3: link('l3', rr('r3'), rr('r2')),
        l4: link('l4', rr('r2'), port('n2', 'in')),
        // dangling value source reference
        l5: link('l5', vsrc('missing'), port('n3', 'in')),
      },
    })
    expect(companionSourcesOf(def).size).toBe(0)
  })

  it('skips member-addressed endpoints and links to unknown nodes (deliberate scope)', () => {
    const def = graph({
      id: 'g0',
      nodes: { n1: node('n1') },
      valueSources: { v1: source('v1', 1) },
      links: {
        l1: link('l1', vsrc('v1'), { ...port('n1', 'items'), members: ['first'] }),
        l2: link('l2', vsrc('v1'), port('ghost', 'in')),
      },
    })
    expect(companionSourcesOf(def).size).toBe(0)
  })

  it('is derivation only: the consumer node values are never consulted or touched', () => {
    const n1 = { id: asNodeId('n1'), type: 'T', values: { steps: 99 } }
    const def = graph({
      id: 'g0',
      nodes: { n1 },
      valueSources: { v1: source('v1', 7) },
      links: { l1: link('l1', vsrc('v1'), port('n1', 'steps')) },
    })
    expect(sourceOf(def, 'n1', 'steps')).toEqual({ kind: 'literal', value: 7 })
    expect(n1.values).toEqual({ steps: 99 }) // dormant stored value untouched
  })
})
