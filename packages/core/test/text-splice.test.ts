import { describe, expect, it } from 'vitest'
import { spliceDiff, transformSplice, type TextSplice } from '../src/commands/text-splice.js'

const apply = (value: string, splice: TextSplice): string =>
  value.slice(0, splice.offset) + splice.insert + value.slice(splice.offset + splice.deleteCount)

describe('spliceDiff', () => {
  it.each([
    ['equal', 'same', 'same', undefined],
    ['pure insert', 'ac', 'abc', { offset: 1, deleteCount: 0, insert: 'b' }],
    ['pure delete', 'abc', 'ac', { offset: 1, deleteCount: 1, insert: '' }],
    ['replace', 'abc', 'axc', { offset: 1, deleteCount: 1, insert: 'x' }],
    ['prefix-first repeated characters', 'aaaa', 'aaa', { offset: 3, deleteCount: 1, insert: '' }],
    ['empty to text', '', 'abc', { offset: 0, deleteCount: 0, insert: 'abc' }],
    ['text to empty', 'abc', '', { offset: 0, deleteCount: 3, insert: '' }],
  ])('%s', (_name, before, after, expected) => {
    expect(spliceDiff(before, after)).toEqual(expected)
  })
})

describe('transformSplice', () => {
  it('shifts when the foreign splice is entirely before', () => {
    expect(transformSplice(
      { offset: 4, deleteCount: 1, insert: 'x' },
      { offset: 1, deleteCount: 2, insert: 'long' },
    )).toEqual({ offset: 6, deleteCount: 1, insert: 'x' })
  })

  it('does not shift when the foreign splice is entirely after', () => {
    expect(transformSplice(
      { offset: 1, deleteCount: 2, insert: 'x' },
      { offset: 3, deleteCount: 1, insert: 'y' },
    )).toEqual({ offset: 1, deleteCount: 2, insert: 'x' })
  })

  it('puts an own insertion after a foreign insertion at the same offset', () => {
    expect(transformSplice(
      { offset: 2, deleteCount: 0, insert: 'own' },
      { offset: 2, deleteCount: 0, insert: 'foreign' },
    )).toEqual({ offset: 9, deleteCount: 0, insert: 'own' })
  })

  it('removes overlap and clamps a start inside the foreign deletion', () => {
    expect(transformSplice(
      { offset: 3, deleteCount: 4, insert: 'own' },
      { offset: 1, deleteCount: 4, insert: 'F' },
    )).toEqual({ offset: 2, deleteCount: 2, insert: 'own' })
  })

  it('deletes a foreign insertion strictly inside its delete range', () => {
    expect(transformSplice(
      { offset: 1, deleteCount: 4, insert: '' },
      { offset: 3, deleteCount: 0, insert: 'xx' },
    )).toEqual({ offset: 1, deleteCount: 6, insert: '' })
  })

  it('composes non-overlapping edits over the same base', () => {
    const base = 'abcdef'
    const own = { offset: 4, deleteCount: 1, insert: 'E' }
    const foreign = { offset: 1, deleteCount: 1, insert: 'BB' }
    expect(apply(apply(base, foreign), transformSplice(own, foreign))).toBe('aBBcdEf')
  })

  it.each([
    [{ offset: 2, deleteCount: 5, insert: 'x' }, { offset: 0, deleteCount: 4, insert: '' }],
    [{ offset: 0, deleteCount: 5, insert: '' }, { offset: 2, deleteCount: 5, insert: 'z' }],
    [{ offset: -2, deleteCount: -3, insert: '' }, { offset: 0, deleteCount: 1, insert: '' }],
  ])('keeps overlap results non-negative', (own, foreign) => {
    const transformed = transformSplice(own, foreign)
    expect(transformed.offset).toBeGreaterThanOrEqual(0)
    expect(transformed.deleteCount).toBeGreaterThanOrEqual(0)
  })
})
