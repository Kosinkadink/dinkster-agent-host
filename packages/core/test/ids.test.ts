import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  allocateId,
  asDynamicMemberId,
  asNodeId,
  asPortId,
  asRerouteId,
  asValueSourceId,
  occurrenceKey,
  parseOccurrenceKey,
  portAddressKey,
  portRefKey,
  sameEndpoint,
  samePortRef,
  type LinkEndpoint,
  type PortRef,
} from '../src/ids.js'

describe('canonical endpoint identity', () => {
  const p = (node: string, port: string, members?: readonly string[]): PortRef => ({
    node: asNodeId(node),
    port: asPortId(port),
    ...(members !== undefined && members.length > 0 ? { members: members.map(asDynamicMemberId) } : {}),
  })

  it('samePortRef distinguishes node, port, and member path', () => {
    expect(samePortRef(p('n1', 'a'), p('n1', 'a'))).toBe(true)
    expect(samePortRef(p('n1', 'a', ['m0']), p('n1', 'a', ['m0']))).toBe(true)
    expect(samePortRef(p('n1', 'a', ['m0', 'g0']), p('n1', 'a', ['m0', 'g0']))).toBe(true)
    expect(samePortRef(p('n1', 'a'), p('n2', 'a'))).toBe(false)
    expect(samePortRef(p('n1', 'a'), p('n1', 'b'))).toBe(false)
    expect(samePortRef(p('n1', 'a', ['m0']), p('n1', 'a', ['m1']))).toBe(false)
    // Path order matters: outer/inner are not interchangeable.
    expect(samePortRef(p('n1', 'a', ['m0', 'g0']), p('n1', 'a', ['g0', 'm0']))).toBe(false)
    // Prefix paths are different addresses.
    expect(samePortRef(p('n1', 'a', ['m0']), p('n1', 'a', ['m0', 'g0']))).toBe(false)
    // memberless vs member: different addresses
    expect(samePortRef(p('n1', 'a'), p('n1', 'a', ['m0']))).toBe(false)
  })

  it('portRefKey is injective across member paths (property)', () => {
    // Arbitrary strings INCLUDING separator characters (NUL, '#'): keys are
    // injective by construction, never by validators excluding characters.
    const id = fc.string({ minLength: 1 })
    const ref = fc.record({
      node: id,
      port: id,
      members: fc.option(fc.array(id, { minLength: 1, maxLength: 3 }), { nil: undefined }),
    })
    fc.assert(
      fc.property(ref, ref, (a, b) => {
        const ra = p(a.node, a.port, a.members)
        const rb = p(b.node, b.port, b.members)
        expect(portRefKey(ra) === portRefKey(rb)).toBe(samePortRef(ra, rb))
      }),
    )
  })

  it('portRefKey composes portAddressKey (one packing for member identity)', () => {
    const ref = p('n1', 'items.sub', ['m0', 'g0'])
    expect(portRefKey(ref).endsWith(portAddressKey('items.sub', ['m0', 'g0']))).toBe(true)
  })

  it('keys do not collide when ids contain separator characters', () => {
    // Segment-boundary forgeries: a NUL inside a component must not read as
    // a component boundary.
    expect(portAddressKey('p\u0000m', ['x'])).not.toBe(portAddressKey('p', ['m', 'x']))
    expect(portRefKey(p('n\u0000p', 'q'))).not.toBe(portRefKey(p('n', 'p\u0000q')))
    expect(portAddressKey('p')).toBe(portAddressKey('p', [])) // absent == empty == static
  })

  it('sameEndpoint keeps endpoint kinds disjoint', () => {
    const portEnd: LinkEndpoint = p('x', 'x')
    const reroute: LinkEndpoint = { reroute: asRerouteId('x') }
    const valueSource: LinkEndpoint = { valueSource: asValueSourceId('x') }
    expect(sameEndpoint(portEnd, reroute)).toBe(false)
    expect(sameEndpoint(reroute, valueSource)).toBe(false)
    expect(sameEndpoint(valueSource, portEnd)).toBe(false)
    expect(sameEndpoint(reroute, { reroute: asRerouteId('x') })).toBe(true)
    expect(sameEndpoint(valueSource, { valueSource: asValueSourceId('x') })).toBe(true)
    expect(sameEndpoint(reroute, { reroute: asRerouteId('y') })).toBe(false)
  })
})

describe('occurrence keys', () => {
  it('round-trips simple occurrences', () => {
    const occ = { instancePath: [asNodeId('n1'), asNodeId('n4')], node: asNodeId('n9') }
    expect(parseOccurrenceKey(occurrenceKey(occ))).toEqual(occ)
  })

  it('round-trips root-level occurrences (empty path)', () => {
    const occ = { instancePath: [], node: asNodeId('n0') }
    expect(occurrenceKey(occ)).toBe('n0')
    expect(parseOccurrenceKey('n0')).toEqual(occ)
  })

  it('round-trips arbitrary id strings (property)', () => {
    const idArb = fc.string({ minLength: 1 }).map(asNodeId)
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 5 }), idArb, (instancePath, node) => {
        const occ = { instancePath, node }
        expect(parseOccurrenceKey(occurrenceKey(occ))).toEqual(occ)
      }),
    )
  })

  it('rejects empty keys', () => {
    expect(() => parseOccurrenceKey('')).toThrow()
  })

  it('never emits backend-reserved characters, whatever the source ids (property)', () => {
    // The Dinkster backend bans '/', '[' and ']' in document node ids (its
    // runtime iteration-path grammar owns them) and reserves '$region'.
    // Flattened runtime ids must be safe by construction, not by validation.
    const idArb = fc.string({ minLength: 1 }).map(asNodeId)
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 5 }), idArb, (instancePath, node) => {
        const key = occurrenceKey({ instancePath, node })
        expect(key).not.toMatch(/[/[\]]/)
        expect(key).not.toBe('$region')
      }),
    )
    // Pinned adversarial ids: separators, brackets, the reserved body id.
    for (const bad of ['a/b', 'r[3]', '$region', 'x.y', '..']) {
      const key = occurrenceKey({ instancePath: [asNodeId(bad)], node: asNodeId(bad) })
      expect(key).not.toMatch(/[/[\]]/)
      expect(parseOccurrenceKey(key)).toEqual({
        instancePath: [asNodeId(bad)],
        node: asNodeId(bad),
      })
    }
  })
})

describe('id allocation', () => {
  it('never reuses ordinals', () => {
    let alloc = { nextOrdinal: 0 }
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const r = allocateId(alloc, 'n')
      expect(seen.has(r.id)).toBe(false)
      seen.add(r.id)
      alloc = r.alloc
    }
    expect(alloc.nextOrdinal).toBe(100)
  })
})
