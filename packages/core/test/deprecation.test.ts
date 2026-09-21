/**
 * Deprecation pointer-chain resolution. Pointers are name-only display
 * hints that CHAIN (A -> B -> C when B is itself deprecated); the UI must
 * steer to the TERMINAL type, degrade gracefully on dangling pointers
 * (packs load independently), and never loop on cross-pack cycles.
 */
import { describe, expect, it } from 'vitest'
import {
  DEPRECATION_CHAIN_LIMIT,
  resolveDeprecationPointer,
  type DeprecationInfo,
  type NodeSchema,
} from '../src/index.js'

const schema = (type: string, deprecation?: DeprecationInfo): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  items: [],
  isOutputNode: false,
  ...(deprecation !== undefined ? { deprecation } : {}),
})

const registry = (...schemas: NodeSchema[]) => {
  const map = new Map(schemas.map((s) => [s.type, s]))
  return (type: string) => map.get(type)
}

const deprecated = (type: string, replacement: string): NodeSchema =>
  schema(type, { message: `use ${replacement}`, replacement })

describe('resolveDeprecationPointer', () => {
  it('returns undefined when the schema declares no pointer', () => {
    expect(resolveDeprecationPointer(schema('a'), registry())).toBeUndefined()
    // Deprecated without a pointer: still no chain to resolve.
    expect(resolveDeprecationPointer(schema('a', { message: 'gone' }), registry())).toBeUndefined()
  })

  it('resolves a direct terminal A -> B', () => {
    const r = resolveDeprecationPointer(deprecated('a', 'b'), registry(schema('b')))
    expect(r).toEqual({ terminal: 'b', path: ['b'], status: 'ok' })
  })

  it('resolves transitively to the terminal: A -> B -> C', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'c'), schema('c')),
    )
    expect(r).toEqual({ terminal: 'c', path: ['b', 'c'], status: 'ok' })
  })

  it('an intermediate that is deprecated WITHOUT a pointer is terminal', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(schema('b', { message: 'also going away, no successor yet' })),
    )
    expect(r).toEqual({ terminal: 'b', path: ['b'], status: 'ok' })
  })

  it('a dangling target reports the last named type', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'ghost.pack.node')),
    )
    expect(r).toEqual({ terminal: 'ghost.pack.node', path: ['b', 'ghost.pack.node'], status: 'dangling' })
  })

  it('a cycle back to the origin stops without looping', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'a'), deprecated('a', 'b')),
    )
    expect(r).toEqual({ terminal: 'a', path: ['b'], status: 'cycle' })
  })

  it('a cycle not involving the origin stops too: a -> b -> c -> b', () => {
    const r = resolveDeprecationPointer(
      deprecated('a', 'b'),
      registry(deprecated('b', 'c'), deprecated('c', 'b')),
    )
    expect(r).toEqual({ terminal: 'b', path: ['b', 'c'], status: 'cycle' })
  })

  it('a runaway linear chain hits the depth limit', () => {
    const chain: NodeSchema[] = []
    for (let i = 0; i < DEPRECATION_CHAIN_LIMIT + 4; i++) chain.push(deprecated(`n${i}`, `n${i + 1}`))
    const r = resolveDeprecationPointer(chain[0]!, registry(...chain.slice(1)))!
    expect(r.status).toBe('depth')
    expect(r.path).toHaveLength(DEPRECATION_CHAIN_LIMIT)
    expect(r.terminal).toBe(`n${DEPRECATION_CHAIN_LIMIT + 1}`)
  })
})
