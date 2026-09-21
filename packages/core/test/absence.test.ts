/**
 * First-class absence (Dinkster schema wire v3). The contract under test:
 * - InputSpec.onAbsent is a DECLARED policy; the effective policy defaults by
 *   required-ness (required -> 'skip', optional -> 'omit')
 * - OutputSpec.optional means the producer may deliberately emit no value at
 *   runtime; it is a static schema fact, unrelated to list cardinality
 * - an optional output feeding an onAbsent='fail' input is LEGAL: the edge
 *   verdict is untouched, but solve emits ONE advisory warning
 *   (solve.maybeAbsent) so the runtime failure is visible at document time
 * - the warning survives reroute chains and named-net fan-out because the
 *   edge walk traces the REAL producer
 * - skipped is a normal downstream state; nothing here creates errors
 */
import { describe, expect, it } from 'vitest'
import type { GraphDef } from '../src/format/document.js'
import type { SchemaResolver } from '../src/schema/derive-boundary.js'
import {
  effectiveAbsentPolicy,
  type InputSpec,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '../src/schema/model.js'
import { solveGraphTypes } from '../src/schema/solve.js'

// ---------------------------------------------------------------------------
// Builders (house style of solve.test.ts)
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const output = (id: string, extra?: Partial<OutputSpec>): OutputSpec => ({
  kind: 'output',
  id,
  type: IMAGE,
  ...extra,
})
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  // A loader that may legitimately find nothing (optional VAE, no-match detector).
  MaybeSrc: schemaOf('MaybeSrc', [output('out', { optional: true })]),
  Sink: schemaOf('Sink', [input('in')]),
  // A consumer that declares "fail loudly if my input arrives absent".
  FailSink: schemaOf('FailSink', [input('in', { onAbsent: 'fail' })]),
  AcceptSink: schemaOf('AcceptSink', [input('in', { onAbsent: 'accept' })]),
}
const resolve: SchemaResolver = (type) => schemas[type]

type TestEndpoint = [string, string] | { reroute: string }
const defOf = (parts: {
  nodes: Record<string, { type: string }>
  links?: Record<string, { from: TestEndpoint; to: TestEndpoint }>
  nets?: Record<string, { source: [string, string]; sinks: [string, string][] }>
  reroutes?: string[]
}): GraphDef => {
  const end = (e: TestEndpoint): unknown => (Array.isArray(e) ? { node: e[0], port: e[1] } : e)
  return {
    id: 'g0',
    name: 'test',
    nodes: Object.fromEntries(
      Object.entries(parts.nodes).map(([id, n]) => [id, { id, type: n.type, values: {} }]),
    ),
    links: Object.fromEntries(
      Object.entries(parts.links ?? {}).map(([id, l]) => [id, { id, from: end(l.from), to: end(l.to) }]),
    ),
    nets: Object.fromEntries(
      Object.entries(parts.nets ?? {}).map(([id, n]) => [
        id,
        { id, name: id, source: end(n.source), sinks: n.sinks.map(end) },
      ]),
    ),
    reroutes: Object.fromEntries((parts.reroutes ?? []).map((id) => [id, { id }])),
    nextOrdinal: 99,
  } as unknown as GraphDef
}

const maybeAbsentDiags = (def: GraphDef) =>
  solveGraphTypes(def, resolve).diagnostics.filter((d) => d.code === 'solve.maybeAbsent')

// ---------------------------------------------------------------------------
// Effective policy defaults
// ---------------------------------------------------------------------------

describe('effectiveAbsentPolicy', () => {
  it('defaults by required-ness: required -> skip, optional -> omit', () => {
    expect(effectiveAbsentPolicy(input('a'))).toBe('skip')
    expect(effectiveAbsentPolicy(input('a', { optional: true }))).toBe('omit')
  })

  it('an explicit declaration always wins over the default', () => {
    expect(effectiveAbsentPolicy(input('a', { onAbsent: 'fail' }))).toBe('fail')
    expect(effectiveAbsentPolicy(input('a', { onAbsent: 'accept' }))).toBe('accept')
    expect(effectiveAbsentPolicy(input('a', { optional: true, onAbsent: 'skip' }))).toBe('skip')
    expect(effectiveAbsentPolicy(input('a', { onAbsent: 'omit' }))).toBe('omit')
  })
})

// ---------------------------------------------------------------------------
// solve.maybeAbsent advisory
// ---------------------------------------------------------------------------

describe('solve.maybeAbsent warning', () => {
  it('optional output into a fail-policy input warns once, as a WARNING, without touching the verdict', () => {
    const def = defOf({
      nodes: { m: { type: 'MaybeSrc' }, f: { type: 'FailSink' } },
      links: { l0: { from: ['m', 'out'], to: ['f', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    const diags = s.diagnostics.filter((d) => d.code === 'solve.maybeAbsent')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    // Legal edge: no errors, and the link verdict stays ok.
    expect(s.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
  })

  it('ordinary output into a fail-policy input does not warn', () => {
    const def = defOf({
      nodes: { s: { type: 'Src' }, f: { type: 'FailSink' } },
      links: { l0: { from: ['s', 'out'], to: ['f', 'in'] } },
    })
    expect(maybeAbsentDiags(def)).toEqual([])
  })

  it('optional output into skip/accept/default inputs does not warn (absence is handled)', () => {
    const def = defOf({
      nodes: { m: { type: 'MaybeSrc' }, a: { type: 'AcceptSink' }, k: { type: 'Sink' } },
      links: {
        l0: { from: ['m', 'out'], to: ['a', 'in'] },
        l1: { from: ['m', 'out'], to: ['k', 'in'] },
      },
    })
    expect(maybeAbsentDiags(def)).toEqual([])
  })

  it('the warning survives a reroute chain to the real producer', () => {
    const def = defOf({
      nodes: { m: { type: 'MaybeSrc' }, f: { type: 'FailSink' } },
      links: {
        l0: { from: ['m', 'out'], to: { reroute: 'r0' } },
        l1: { from: { reroute: 'r0' }, to: { reroute: 'r1' } },
        l2: { from: { reroute: 'r1' }, to: ['f', 'in'] },
      },
      reroutes: ['r0', 'r1'],
    })
    expect(maybeAbsentDiags(def)).toHaveLength(1)
  })

  it('named-net fan-out warns per fail-policy sink, not for tolerant ones', () => {
    const def = defOf({
      nodes: { m: { type: 'MaybeSrc' }, f: { type: 'FailSink' }, k: { type: 'Sink' } },
      nets: { latents: { source: ['m', 'out'], sinks: [['f', 'in'], ['k', 'in']] } },
    })
    expect(maybeAbsentDiags(def)).toHaveLength(1)
  })
})
