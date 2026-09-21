/**
 * Shared INT/FLOAT stepping semantics: the canvas edge-zone stepper and
 * queue-time controller advancement both derive from these helpers, so this
 * suite pins the single source - step defaults by widget kind, decimal
 * quantization, min/max clamping, and the randomize grids.
 */
import { describe, expect, it } from 'vitest'
import { numericStepConstraints, randomNumericValue, stepNumericValue } from '../src/index.js'

describe('numericStepConstraints', () => {
  it('defaults step to 1 for INT and 0.1 for FLOAT', () => {
    expect(numericStepConstraints({ widgetType: 'INT', options: {} })).toEqual({ integer: true, step: 1n })
    expect(numericStepConstraints({ widgetType: 'FLOAT', options: {} })).toEqual({ integer: false, step: 0.1, min: -Infinity, max: Infinity })
  })

  it('takes declared min/max/step verbatim', () => {
    expect(numericStepConstraints({ widgetType: 'FLOAT', options: { min: 0.1, max: 0.9, step: 0.25 } }))
      .toEqual({ integer: false, step: 0.25, min: 0.1, max: 0.9 })
  })

  it('falls back on a nonpositive or non-finite declared step', () => {
    expect(numericStepConstraints({ widgetType: 'INT', options: { step: 0 } }).step).toBe(1n)
    expect(numericStepConstraints({ widgetType: 'FLOAT', options: { step: -0.5 } }).step).toBe(0.1)
    expect(numericStepConstraints({ widgetType: 'FLOAT', options: { step: Number.NaN } }).step).toBe(0.1)
  })

  it('normalizes legacy INT constraints to JS-safe integers', () => {
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: Number.MIN_SAFE_INTEGER - 100,
      max: 18_446_744_073_709_551_615,
      step: 0.5,
    } })).toEqual({
      integer: true,
      min: BigInt(Number.MIN_SAFE_INTEGER),
      max: BigInt(Number.MAX_SAFE_INTEGER),
      step: 1n,
    })
  })

  it('saturates either unsafe bound and drops an inverted legacy range', () => {
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: Number.MAX_SAFE_INTEGER + 100,
    } }).min).toBe(BigInt(Number.MAX_SAFE_INTEGER))
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      max: Number.MIN_SAFE_INTEGER - 100,
    } }).max).toBe(BigInt(Number.MIN_SAFE_INTEGER))
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: 20,
      max: 10,
    } })).toEqual({ integer: true, step: 1n })
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: Number.MAX_SAFE_INTEGER + 200,
      max: Number.MAX_SAFE_INTEGER + 100,
    } })).toEqual({ integer: true, step: 1n })
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: 0.2,
      max: 0.8,
    } })).toEqual({ integer: true, step: 1n })
  })

  it('drops non-finite legacy bounds as absent fields', () => {
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    } })).toEqual({ integer: true, step: 1n })
  })

  it('retains exact signed and unsigned decimal integer constraints', () => {
    expect(numericStepConstraints({ widgetType: 'INT', options: {
      min: '-9223372036854775808',
      max: '18446744073709551615',
      step: '9007199254740992',
    } })).toEqual({
      integer: true,
      min: -9223372036854775808n,
      max: 18446744073709551615n,
      step: 9007199254740992n,
    })
  })
})

describe('stepNumericValue', () => {
  const float = numericStepConstraints({ widgetType: 'FLOAT', options: {} })

  it('quantizes decimal steps (no binary float noise)', () => {
    expect(stepNumericValue(0.2, 1, float)).toBe(0.3)
    expect(stepNumericValue(0.3, -1, float)).toBe(0.2)
  })

  it('clamps to min/max after stepping', () => {
    const bounded = numericStepConstraints({ widgetType: 'FLOAT', options: { min: 0.1, max: 0.9, step: 0.1 } })
    expect(stepNumericValue(0.9, 1, bounded)).toBe(0.9)
    expect(stepNumericValue(0.1, -1, bounded)).toBe(0.1)
    expect(stepNumericValue(0.85, 1, bounded)).toBe(0.9)
  })

  it('steps integers by the declared step, clamped', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: { min: 10, max: 20, step: 3 } })
    expect(stepNumericValue(11, 1, int)).toBe(14)
    expect(stepNumericValue(19, 1, int)).toBe(20)
    expect(stepNumericValue(11, -1, int)).toBe(10)
  })

  it('steps unbounded INT values across the JS safe-integer boundary', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: {} })
    expect(stepNumericValue(Number.MAX_SAFE_INTEGER, 1, int)).toBe('9007199254740992')
    expect(stepNumericValue(Number.MIN_SAFE_INTEGER, -1, int)).toBe('-9007199254740992')
    expect(stepNumericValue('18446744073709551614', 1, int)).toBe('18446744073709551615')
    expect(stepNumericValue('18446744073709551615', 1, int)).toBe('18446744073709551615')
  })

  it('normalizes a fractional legacy INT value before stepping', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: { step: 3 } })
    expect(stepNumericValue(10.6, 1, int)).toBe(14)
    expect(Number.isSafeInteger(stepNumericValue(10.6, 1, int))).toBe(true)
  })

  it('steps and clamps unsafe decimal integers exactly', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: {
      min: 0,
      max: '18446744073709551615',
      step: 1,
    } })
    expect(stepNumericValue(Number.MAX_SAFE_INTEGER, 1, int)).toBe('9007199254740992')
    expect(stepNumericValue('18446744073709551614', 1, int)).toBe('18446744073709551615')
    expect(stepNumericValue('18446744073709551615', 1, int)).toBe('18446744073709551615')
    expect(stepNumericValue('9007199254740992', -1, int)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('randomNumericValue', () => {
  it('samples integers uniformly in [ceil(min), floor(max)], step ignored (seed semantics)', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: { min: 10, max: 20, step: 3 } })
    expect(randomNumericValue(int, () => 0.5)).toBe(15)
    expect(randomNumericValue(int, () => 0)).toBe(10)
    expect(randomNumericValue(int, () => 0.999999)).toBe(20)
  })

  it('defaults integer bounds to 0 / MAX_SAFE_INTEGER', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: {} })
    expect(randomNumericValue(int, () => 0)).toBe(0)
    expect(randomNumericValue(int, () => 0.999999999)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    expect(Number.isSafeInteger(randomNumericValue(int, () => 0.5))).toBe(true)
  })

  it('keeps a legacy 2^64-style integer maximum inside the JS-safe range', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: {
      min: 0,
      max: 18_446_744_073_709_551_615,
    } })
    const value = randomNumericValue(int, () => 0.999999999)
    expect(typeof value).toBe('number')
    expect(value as number).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    expect(Number.isSafeInteger(value)).toBe(true)
  })

  it('keeps an unsafe-high legacy minimum randomizable as a safe integer', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: {
      min: Number.MAX_SAFE_INTEGER + 100,
    } })
    expect(randomNumericValue(int, () => 0.5)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('randomizes across the full uint64 range without losing precision', () => {
    const int = numericStepConstraints({ widgetType: 'INT', options: {
      min: 0,
      max: '18446744073709551615',
    } })
    expect(randomNumericValue(int, () => 0)).toBe(0)
    expect(randomNumericValue(int, () => 0.9999999999999999)).toBe('18446744073709551615')
    const midpoint = randomNumericValue(int, () => 0.5)
    expect(typeof midpoint).toBe('string')
    expect(BigInt(midpoint)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('samples floats on the step grid inside [min, max]', () => {
    const float = numericStepConstraints({ widgetType: 'FLOAT', options: { min: 0.1, max: 0.9, step: 0.1 } })
    expect(randomNumericValue(float, () => 0.5)).toBe(0.5)
    expect(randomNumericValue(float, () => 0)).toBe(0.1)
    expect(randomNumericValue(float, () => 0.999999)).toBe(0.9)
    // Every grid point is a clean decimal and in bounds.
    for (let index = 0; index < 9; index++) {
      const value = randomNumericValue(float, () => index / 9)
      expect(value as number).toBeGreaterThanOrEqual(0.1)
      expect(value as number).toBeLessThanOrEqual(0.9)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBe(Math.round((value as number) * 10) / 10)
    }
  })

  it('defaults float bounds to [min, min+1] / [0, 1] when absent', () => {
    const unbounded = numericStepConstraints({ widgetType: 'FLOAT', options: {} })
    expect(randomNumericValue(unbounded, () => 0)).toBe(0)
    expect(randomNumericValue(unbounded, () => 0.999999)).toBe(1)
    const minOnly = numericStepConstraints({ widgetType: 'FLOAT', options: { min: 2 } })
    expect(randomNumericValue(minOnly, () => 0)).toBe(2)
    expect(randomNumericValue(minOnly, () => 0.999999)).toBe(3)
  })

  it('excludes a partial final grid interval: the top draw lands on the last grid point', () => {
    // 0.0..0.25 with step 0.1: grid 0, 0.1, 0.2 (0.3 would exceed max).
    const float = numericStepConstraints({ widgetType: 'FLOAT', options: { min: 0, max: 0.25, step: 0.1 } })
    expect(randomNumericValue(float, () => 0.999999)).toBe(0.2)
  })

  it('never returns an off-grid value for a max sitting just below a grid point', () => {
    // (max - min) / step quantizes UP to 3 here, but 0.3 > max: the last
    // valid grid point is 0.2 - clamping to this max would be off-grid.
    const float = numericStepConstraints({ widgetType: 'FLOAT', options: { min: 0, max: 0.29999999999996, step: 0.1 } })
    expect(randomNumericValue(float, () => 0.999999)).toBe(0.2)
  })
})
