/**
 * Effective submission-time widget defaults: a widget input intrinsically
 * holds a value even without a schema default (INT shows 0/min, STRING '',
 * BOOLEAN false, static COMBO its first option), so compile stages that
 * instead of warning compile.input.missing. Kinds with no intrinsic value
 * (ASSET, SAVE_TARGET, remote/empty COMBO, unknown types) return undefined
 * and keep the warning.
 */
import { describe, expect, it } from 'vitest'
import { effectiveWidgetDefault, type WidgetSpec } from '../src/index.js'

const spec = (widgetType: string, over: Partial<WidgetSpec> = {}): WidgetSpec => ({
  widgetType,
  options: {},
  ...over,
})

describe('effectiveWidgetDefault', () => {
  it('prefers the explicit schema default for every kind', () => {
    expect(effectiveWidgetDefault(spec('INT', { default: 17 }))).toBe(17)
    expect(effectiveWidgetDefault(spec('STRING', { default: 'x' }))).toBe('x')
    expect(effectiveWidgetDefault(spec('BOOLEAN', { default: true }))).toBe(true)
    expect(effectiveWidgetDefault(spec('CURVE', {
      default: { interpolation: 'linear', points: [{ position: 0, value: 2 }] },
    }))).toEqual({ interpolation: 'linear', points: [{ position: 0, value: 2 }] })
    // Falsy explicit defaults are still explicit.
    expect(effectiveWidgetDefault(spec('INT', { default: 0, options: { min: 5 } }))).toBe(0)
    expect(effectiveWidgetDefault(spec('BOOLEAN', { default: false }))).toBe(false)
    expect(effectiveWidgetDefault(spec('STRING', { default: '' }))).toBe('')
  })

  it('INT/FLOAT fall back to min, then 0', () => {
    expect(effectiveWidgetDefault(spec('INT'))).toBe(0)
    expect(effectiveWidgetDefault(spec('INT', { options: { min: 5 } }))).toBe(5)
    expect(effectiveWidgetDefault(spec('FLOAT'))).toBe(0)
    expect(effectiveWidgetDefault(spec('FLOAT', { options: { min: -1.5 } }))).toBe(-1.5)
    // Non-finite/absent min is ignored.
    expect(effectiveWidgetDefault(spec('INT', { options: { min: Number.NaN } }))).toBe(0)
  })

  it('STRING falls back to the empty string, BOOLEAN to false', () => {
    expect(effectiveWidgetDefault(spec('STRING'))).toBe('')
    expect(effectiveWidgetDefault(spec('BOOLEAN'))).toBe(false)
  })

  it('static COMBO falls back to its first valid option (scalar or [value,label])', () => {
    expect(effectiveWidgetDefault(spec('COMBO', { options: { options: ['a', 'b'] } }))).toBe('a')
    expect(effectiveWidgetDefault(spec('COMBO', { options: { options: [['v1', 'Label'], 'v2'] } }))).toBe('v1')
    expect(effectiveWidgetDefault(spec('COMBO', { options: {
      options: [{ value: 'dinkster.euler', label: 'euler', info: 'Euler sampler', folder: 'Basic' }],
    } }))).toBe('dinkster.euler')
    expect(effectiveWidgetDefault(spec('COMBO', { options: { options: [2, 3] } }))).toBe(2)
  })

  it('kinds with no intrinsic value return undefined', () => {
    expect(effectiveWidgetDefault(spec('COMBO'))).toBeUndefined() // no option list
    expect(effectiveWidgetDefault(spec('COMBO', { options: { options: [] } }))).toBeUndefined()
    expect(
      effectiveWidgetDefault(spec('COMBO', { remote: { route: '/api/choices/x' } })),
    ).toBeUndefined() // remote-only: no local truth about options
    expect(effectiveWidgetDefault(spec('ASSET'))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SAVE_TARGET'))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SOME_CUSTOM_KIND'))).toBeUndefined()
  })

  it('a remote COMBO WITH static options uses the first static option (matches display)', () => {
    expect(
      effectiveWidgetDefault(spec('COMBO', { options: { options: ['cached', 'other'] }, remote: { route: '/api/choices/x' } })),
    ).toBe('cached')
  })

  it('malformed explicit defaults are ignored, falling back to the intrinsic default', () => {
    expect(effectiveWidgetDefault(spec('INT', { default: 'nope' as unknown as number, options: { min: 5 } }))).toBe(5)
    expect(effectiveWidgetDefault(spec('FLOAT', { default: Number.NaN }))).toBe(0)
    expect(effectiveWidgetDefault(spec('STRING', { default: 7 as unknown as string }))).toBe('')
    expect(effectiveWidgetDefault(spec('BOOLEAN', { default: 'yes' as unknown as boolean }))).toBe(false)
    expect(effectiveWidgetDefault(spec('COMBO', { default: {} as unknown as string, options: { options: ['a'] } }))).toBe('a')
    expect(effectiveWidgetDefault(spec('COLOR', { default: 42 as unknown as string }))).toBe('#ffffff')
  })

  it('COLOR falls back to white', () => {
    expect(effectiveWidgetDefault(spec('COLOR'))).toBe('#ffffff')
  })

  it('CURVE falls back to the monotone-cubic identity', () => {
    const identity = {
      interpolation: 'monotone_cubic',
      points: [{ position: 0, value: 0 }, { position: 1, value: 1 }],
    }
    expect(effectiveWidgetDefault(spec('CURVE'))).toEqual(identity)
    expect(effectiveWidgetDefault(spec('CURVE', {
      default: { points: [{ position: 1, value: 0 }, { position: 1, value: 2 }] },
    }))).toEqual(identity)
  })

  it('preserves every COLOR string default without parsing or normalization', () => {
    expect(effectiveWidgetDefault(spec('COLOR', { default: '#xyz' }))).toBe('#xyz')
    expect(effectiveWidgetDefault(spec('COLOR', { default: 'red' }))).toBe('red')
    expect(effectiveWidgetDefault(spec('COLOR', { default: '#ff00' }))).toBe('#ff00')
    expect(effectiveWidgetDefault(spec('COLOR', { default: '' }))).toBe('')
    expect(effectiveWidgetDefault(spec('COLOR', { default: '#AbCdEf' }))).toBe('#AbCdEf')
  })

  it('ASSET: only a complete AssetRef default is usable; null/malformed stay undefined', () => {
    const ref = {
      digest: `blake3:${'0'.repeat(64)}`,
      name: 'img.png',
      size: 12,
      mediaType: 'image/png',
      virtualPath: 'inputs/img.png',
    }
    expect(effectiveWidgetDefault(spec('ASSET', { default: ref as never }))).toEqual(ref)
    // null is the DISPLAY placeholder ("explicitly unset"), never executable.
    expect(effectiveWidgetDefault(spec('ASSET', { default: null as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('ASSET', { default: 'img.png' as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('ASSET', { default: { ...ref, digest: 'sha256:oops' } as never }))).toBeUndefined()
    // Multi-select (list-declared) inputs default to ARRAYS of refs: a
    // non-empty all-ref array submits like a single ref; one malformed
    // member (or an empty selection) makes the whole default unusable.
    expect(effectiveWidgetDefault(spec('ASSET', { default: [ref] as never }))).toEqual([ref])
    expect(effectiveWidgetDefault(spec('ASSET', { default: [ref, 'img.png'] as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('ASSET', { default: [] as never }))).toBeUndefined()
  })

  it('SAVE_TARGET: only a grammar-valid {mount, prefix} default is usable', () => {
    const target = { mount: 'outputs', prefix: 'renders/final' }
    expect(effectiveWidgetDefault(spec('SAVE_TARGET', { default: target as never }))).toEqual(target)
    expect(effectiveWidgetDefault(spec('SAVE_TARGET', { default: null as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SAVE_TARGET', { default: '/abs/path' as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SAVE_TARGET', { default: { mount: 'Outputs!', prefix: 'a' } as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SAVE_TARGET', { default: { mount: 'outputs', prefix: '../up' } as never }))).toBeUndefined()
    expect(effectiveWidgetDefault(spec('SAVE_TARGET', { default: { mount: 'outputs', prefix: 'a//b' } as never }))).toBeUndefined()
  })
})
