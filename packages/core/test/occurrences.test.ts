/**
 * View-occurrence mapping: runtime ids -> scene nodes of the graph on
 * screen, keyed by the instance path the user actually navigated.
 *
 * The invariants under test:
 * - a def instantiated twice never leaks a sibling instance's ids into the
 *   view (the navigated path disambiguates by construction);
 * - own occurrences sort exact-first (undecorated before iteration
 *   variants);
 * - backend region decoration ('r[3]/node', 'x[2]') maps onto the first
 *   segment's document identity as a decorated variant;
 * - compile provenance (toSource) is authoritative over parsing;
 * - unparseable ids are skipped, never guessed at.
 */
import { describe, expect, it } from 'vitest'
import { asNodeId, occurrenceKey, occurrencesForView, runtimeIdsFor } from '../src/index.js'

const key = (path: readonly string[], node: string) =>
  occurrenceKey({ instancePath: path.map(asNodeId), node: asNodeId(node) })

describe('occurrencesForView: root view', () => {
  it('plain runtime ids map to their own scene node', () => {
    const occ = occurrencesForView({ instancePath: [], runtimeIds: ['a', 'b'] })
    expect(occ.own.get('a')).toEqual(['a'])
    expect(occ.own.get('b')).toEqual(['b'])
    expect(occ.inner.size).toBe(0)
  })

  it('nested occurrence keys aggregate under their first instance segment', () => {
    const ids = [key(['sub1'], 'inner'), key(['sub1', 'deep'], 'x'), key(['sub2'], 'inner')]
    const occ = occurrencesForView({ instancePath: [], runtimeIds: ids })
    expect(occ.inner.get('sub1')).toEqual([key(['sub1'], 'inner'), key(['sub1', 'deep'], 'x')])
    expect(occ.inner.get('sub2')).toEqual([key(['sub2'], 'inner')])
    expect(occ.own.size).toBe(0)
  })

  it('escaped segment characters round-trip (a root node named with a dot)', () => {
    const rid = key([], 'a.b')
    expect(rid).not.toBe('a.b') // escaped on the wire
    const occ = occurrencesForView({ instancePath: [], runtimeIds: [rid] })
    expect(occ.own.get('a.b')).toEqual([rid])
  })
})

describe('occurrencesForView: nested views', () => {
  const ids = [
    key(['sub1'], 'inner'),
    key(['sub2'], 'inner'),
    key(['sub1', 'deep'], 'x'),
    key([], 'rootNode'),
  ]

  it('the navigated instance sees ONLY its own occurrences', () => {
    const occ = occurrencesForView({ instancePath: ['sub1'], runtimeIds: ids })
    expect(occ.own.get('inner')).toEqual([key(['sub1'], 'inner')])
    expect(occ.inner.get('deep')).toEqual([key(['sub1', 'deep'], 'x')])
  })

  it('a sibling instance of the same def never leaks in', () => {
    const occ = occurrencesForView({ instancePath: ['sub2'], runtimeIds: ids })
    expect(occ.own.get('inner')).toEqual([key(['sub2'], 'inner')])
    expect(occ.inner.size).toBe(0)
  })

  it('shallower and divergent-branch ids are excluded', () => {
    const occ = occurrencesForView({ instancePath: ['sub1', 'deep'], runtimeIds: ids })
    expect(occ.own.get('x')).toEqual([key(['sub1', 'deep'], 'x')])
    expect(occ.own.size).toBe(1)
    expect(occ.inner.size).toBe(0)
  })
})

describe('occurrencesForView: backend runtime decoration', () => {
  it('an iteration-suffixed id is a decorated variant of its node, after the exact id', () => {
    const occ = occurrencesForView({ instancePath: [], runtimeIds: ['n[3]', 'n'] })
    expect(occ.own.get('n')).toEqual(['n', 'n[3]'])
  })

  it('a region path maps onto its FIRST segment as a decorated variant', () => {
    const occ = occurrencesForView({ instancePath: [], runtimeIds: ['r[0]/body', 'r'] })
    expect(occ.own.get('r')).toEqual(['r', 'r[0]/body'])
  })

  it('decoration composes with nesting: the flattened first segment locates the view', () => {
    const rid = `${key(['sub1'], 'loop')}[2]/step`
    const occ = occurrencesForView({ instancePath: ['sub1'], runtimeIds: [rid] })
    expect(occ.own.get('loop')).toEqual([rid])
  })
})

describe('occurrencesForView: provenance + robustness', () => {
  it('toSource overrides parsing (a lowered node under a different runtime name)', () => {
    const occ = occurrencesForView({
      instancePath: [],
      runtimeIds: ['n$lowered'],
      toSource: { n$lowered: key([], 'n') },
    })
    expect(occ.own.get('n')).toEqual(['n$lowered'])
  })

  it('toSource resolves decorated ids through their stripped first segment', () => {
    const occ = occurrencesForView({
      instancePath: [],
      runtimeIds: ['n$lowered[1]'],
      toSource: { n$lowered: key([], 'n') },
    })
    expect(occ.own.get('n')).toEqual(['n$lowered[1]'])
  })

  it('unparseable ids are skipped, never mapped by guesswork', () => {
    const occ = occurrencesForView({ instancePath: [], runtimeIds: ['bad%zz', '', 'ok'] })
    expect(occ.own.get('ok')).toEqual(['ok'])
    expect(occ.own.size).toBe(1)
  })
})

describe('runtimeIdsFor', () => {
  it('combines own and inner ids, own first', () => {
    const ids = ['n', key(['n'], 'inside')]
    const occ = occurrencesForView({ instancePath: [], runtimeIds: ids })
    expect(runtimeIdsFor(occ, 'n')).toEqual(['n', key(['n'], 'inside')])
    expect(runtimeIdsFor(occ, 'absent')).toEqual([])
  })
})
