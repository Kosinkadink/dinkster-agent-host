/**
 * Bypass matcher unit tests: the deterministic tier order
 * (same-index compatible > first exact > first compatible)
 * over driven candidates. Compile integration lives in compile-bypass.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { matchBypassInput, type BypassCandidate } from '../src/compile/bypass.js'
import type { TypeExpr } from '../src/schema/model.js'

const T = (name: string): TypeExpr => ({ kind: 'concrete', name })
const U = (...names: string[]): TypeExpr => ({ kind: 'union', names })
const W: TypeExpr = { kind: 'wildcard' }

const c = (index: number, type: TypeExpr): BypassCandidate<string> => ({ index, type, driver: `d${index}` })

describe('matchBypassInput', () => {
  it('prefers the same-index candidate when its type matches exactly', () => {
    const pick = matchBypassInput({ index: 1, type: T('IMAGE') }, [c(0, T('IMAGE')), c(1, T('IMAGE'))])
    expect(pick?.index).toBe(1)
  })

  it('falls back to the first exact match when the same-index type differs', () => {
    const pick = matchBypassInput({ index: 0, type: T('LATENT') }, [c(0, T('IMAGE')), c(1, T('LATENT'))])
    expect(pick?.index).toBe(1)
  })

  it('same-index compatible beats an exact candidate at another index', () => {
    // Positional passthrough wins when compatible; exactness is the fallback.
    const pick = matchBypassInput({ index: 0, type: T('IMAGE') }, [c(0, U('IMAGE', 'MASK')), c(2, T('IMAGE'))])
    expect(pick?.index).toBe(0)
  })

  it('same-index compatible beats an earlier compatible candidate', () => {
    const pick = matchBypassInput({ index: 1, type: T('IMAGE') }, [c(0, U('IMAGE', 'MASK')), c(1, U('IMAGE', 'LATENT'))])
    expect(pick?.index).toBe(1)
  })

  it('falls back to the first compatible candidate', () => {
    const pick = matchBypassInput({ index: 0, type: T('IMAGE') }, [c(1, T('LATENT')), c(2, W)])
    expect(pick?.index).toBe(2)
  })

  it('returns undefined when nothing is compatible', () => {
    expect(matchBypassInput({ index: 0, type: T('IMAGE') }, [c(0, T('LATENT'))])).toBeUndefined()
  })

  it('returns undefined with no candidates', () => {
    expect(matchBypassInput({ index: 0, type: T('IMAGE') }, [])).toBeUndefined()
  })

  it('union exactness is set equality, order-insensitive', () => {
    const pick = matchBypassInput({ index: 5, type: U('A', 'B') }, [c(0, U('B', 'A', 'A'))])
    expect(pick?.index).toBe(0)
  })

  it('two unrestricted types (wildcards) are exact together', () => {
    const pick = matchBypassInput({ index: 5, type: W }, [c(0, T('IMAGE')), c(1, W)])
    expect(pick?.index).toBe(1)
  })

  it('wildcard vs concrete is compatible, not exact', () => {
    // Exact concrete match at a later index wins over an earlier wildcard.
    const pick = matchBypassInput({ index: 5, type: T('IMAGE') }, [c(0, W), c(1, T('IMAGE'))])
    expect(pick?.index).toBe(1)
  })
})
