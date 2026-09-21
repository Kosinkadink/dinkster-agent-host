import { describe, expect, it } from 'vitest'
import {
  analyzeSelectionExecution,
  asGraphDefId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
  asRerouteId,
  asSelectorCandidateId,
  asSelectorId,
  type GraphDef,
  type LinkEndpoint,
} from '../src/index.js'

type Edge = readonly [string | LinkEndpoint, string | LinkEndpoint]

function graph(nodes: readonly string[], edges: readonly Edge[], nets: readonly [string, string[]][] = []): GraphDef {
  const endpoint = (value: string | LinkEndpoint, output: boolean): LinkEndpoint =>
    typeof value === 'string'
      ? { node: asNodeId(value), port: asPortId(output ? 'out' : 'in') }
      : value
  return {
    id: asGraphDefId('g'),
    name: 'test',
    nodes: Object.fromEntries(nodes.map((id) => [id, { id: asNodeId(id), type: 'test.node', values: {} }])),
    links: Object.fromEntries(edges.map(([from, to], i) => [`l${i}`, {
      id: asLinkId(`l${i}`),
      from: endpoint(from, true),
      to: endpoint(to, false),
    }])),
    nets: Object.fromEntries(nets.map(([source, sinks], i) => [`net${i}`, {
      id: asNetId(`net${i}`),
      name: `net${i}`,
      source: { node: asNodeId(source), port: asPortId('out') },
      sinks: sinks.map((sink) => ({ node: asNodeId(sink), port: asPortId('in') })),
    }])),
    reroutes: {},
    nextOrdinal: 1,
  }
}

describe('analyzeSelectionExecution', () => {
  it('finds chain minima, maxima, closures, and a contiguous range', () => {
    const result = analyzeSelectionExecution(graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]), ['b', 'c'])
    expect(result.first).toEqual(['b'])
    expect(result.last).toEqual(['c'])
    expect([...result.upstream]).toEqual(['b', 'a'])
    expect([...result.downstream]).toEqual(['c', 'd'])
    expect(result.contiguous).toBe(true)
  })

  it('requires every branch of a diamond for directed contiguity', () => {
    const def = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']])
    expect(analyzeSelectionExecution(def, ['a', 'b', 'c', 'd']).contiguous).toBe(true)
    const missingBranch = analyzeSelectionExecution(def, ['a', 'b', 'd'])
    expect([...missingBranch.between]).toEqual(['a', 'b', 'c', 'd'])
    expect(missingBranch.contiguous).toBe(false)
  })

  it('uses all minima and maxima for branching selections', () => {
    const def = graph(['a', 'b', 'c', 'd', 'e'], [['a', 'c'], ['b', 'c'], ['c', 'd'], ['c', 'e']])
    const result = analyzeSelectionExecution(def, ['a', 'b', 'c', 'd', 'e'])
    expect(result.first).toEqual(['a', 'b'])
    expect(result.last).toEqual(['d', 'e'])
    expect([...result.upstream]).toEqual(['a', 'b'])
    expect([...result.downstream]).toEqual(['d', 'e'])
    expect(result.contiguous).toBe(true)
  })

  it('uses direct selected edges for in-selection sinks', () => {
    const def = graph(
      ['a', 'b', 'c', 'preview', 'outside', 'd'],
      [['a', 'b'], ['b', 'c'], ['b', 'preview'], ['b', 'outside'], ['outside', 'd']],
    )
    const direct = analyzeSelectionExecution(def, ['a', 'b', 'c', 'preview'])
    expect(direct.sinks).toEqual(['c', 'preview'])
    const throughOutside = analyzeSelectionExecution(def, ['b', 'd'])
    expect(throughOutside.sinks).toEqual(['b', 'd'])
    expect([...throughOutside.upstreamOf(throughOutside.sinks)].sort()).toEqual(['a', 'b', 'd', 'outside'])
    expect([...throughOutside.selected].every((id) => throughOutside.upstreamOf(throughOutside.sinks).has(id))).toBe(true)
  })

  it('rejects disconnected selections and single nodes', () => {
    const def = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']])
    expect(analyzeSelectionExecution(def, ['a', 'b', 'c', 'd']).contiguous).toBe(false)
    expect(analyzeSelectionExecution(def, ['a']).contiguous).toBe(false)
  })

  it('walks through reroutes without treating them as range nodes', () => {
    const r = asRerouteId('r')
    const def = graph(['a', 'b'], [
      ['a', { reroute: r }],
      [{ reroute: r }, 'b'],
    ])
    ;(def as { reroutes: Record<string, { id: ReturnType<typeof asRerouteId> }> }).reroutes = { r: { id: r } }
    const result = analyzeSelectionExecution(def, ['a', 'b'])
    expect([...result.between]).toEqual(['a', 'b'])
    expect(result.contiguous).toBe(true)
  })

  it('treats named nets as directed connectivity', () => {
    const result = analyzeSelectionExecution(graph(['a', 'b', 'c'], [], [['a', ['b', 'c']]]), ['a', 'b', 'c'])
    expect(result.first).toEqual(['a'])
    expect(result.last).toEqual(['b', 'c'])
    expect(result.contiguous).toBe(true)
  })

  it('expands every defined selector candidate for authored connectivity', () => {
    const selector = asSelectorId('s')
    const x = asSelectorCandidateId('x')
    const y = asSelectorCandidateId('y')
    const def = graph(['a', 'b', 'c'], [
      ['a', { selector, candidate: x }],
      ['b', { selector, candidate: y }],
      [{ selector }, 'c'],
    ])
    ;(def as { selectors: Record<string, unknown> }).selectors = {
      s: { id: selector, candidates: [{ id: x }, { id: y }], policy: { kind: 'fixed', candidate: x } },
    }
    const result = analyzeSelectionExecution(def, ['a', 'b', 'c'])
    expect(result.first).toEqual(['a', 'b'])
    expect(result.last).toEqual(['c'])
    expect(result.contiguous).toBe(true)
  })

  it('reports cycle participants without hanging', () => {
    const result = analyzeSelectionExecution(graph(['a', 'b'], [['a', 'b'], ['b', 'a']]), ['a', 'b'])
    expect(result.cyclic).toBe(true)
    expect([...result.cyclicNodes].sort()).toEqual(['a', 'b'])
    expect(result.contiguous).toBe(false)
    expect(result.first).toEqual([])
    expect(result.last).toEqual([])
  })

  it('reports a collapsed real-node self-cycle as a cycle participant', () => {
    const result = analyzeSelectionExecution(graph(['a'], [['a', 'a']]), ['a'])
    expect(result.cyclic).toBe(true)
    expect([...result.cyclicNodes]).toEqual(['a'])
  })

  it('keeps closures meaningful when an unrelated component is cyclic', () => {
    const result = analyzeSelectionExecution(
      graph(['a', 'b', 'x', 'y'], [['a', 'b'], ['x', 'y'], ['y', 'x']]),
      ['b'],
    )
    expect([...result.cyclicNodes].sort()).toEqual(['x', 'y'])
    expect(result.first).toEqual(['b'])
    expect(result.last).toEqual(['b'])
    expect([...result.upstream]).toEqual(['b', 'a'])
    expect([...result.downstream]).toEqual(['b'])
  })

  it('rejects a contiguous range whose between set intersects a cycle', () => {
    const result = analyzeSelectionExecution(
      graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['b', 'c']]),
      ['a', 'b', 'c'],
    )
    expect(result.contiguous).toBe(false)
    expect([...result.between]).toEqual([])
  })
})
