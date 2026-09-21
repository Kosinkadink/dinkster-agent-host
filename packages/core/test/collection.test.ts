/**
 * Collection contract tests. The discipline under test: the query belongs
 * to the source (ranking over the WHOLE corpus, never a loaded page),
 * cursors are query-bound, pagination is exact and exhausts cleanly, and
 * the corpus is re-read per request (live sources).
 */
import { describe, expect, it } from 'vitest'
import {
  defaultEntryFields,
  localCollectionSource,
  type CollectionEntry,
} from '../src/collection.js'

const entry = (id: string, title: string, extra?: Partial<CollectionEntry>): CollectionEntry => ({
  id,
  title,
  ...extra,
})

const corpus: CollectionEntry[] = [
  entry('a', 'Alpha Pack', { subtitle: 'vendor.alpha', badges: ['registry'] }),
  entry('b', 'Beta Pack', { subtitle: 'vendor.beta', badges: ['local'] }),
  entry('c', 'Video Helper', { subtitle: 'vhs.video', badges: ['registry'] }),
  entry('d', 'Video Loader', { subtitle: 'vhs.loader' }),
  entry('e', 'Gamma Tools', { subtitle: 'vendor.gamma' }),
]

const source = localCollectionSource({ id: 's', label: 'S', corpus: () => corpus })

describe('localCollectionSource paging', () => {
  it('empty query browses the corpus order with exact totals', async () => {
    const page = await source.page({ query: '', limit: 2 })
    expect(page.items.map((e) => e.id)).toEqual(['a', 'b'])
    expect(page.total).toBe(5)
    expect(page.cursor).toBeDefined()
  })

  it('pages continue from the cursor and exhaust with no trailing cursor', async () => {
    const p1 = await source.page({ query: '', limit: 2 })
    const p2 = await source.page({ query: '', cursor: p1.cursor!, limit: 2 })
    const p3 = await source.page({ query: '', cursor: p2.cursor!, limit: 2 })
    expect(p2.items.map((e) => e.id)).toEqual(['c', 'd'])
    expect(p3.items.map((e) => e.id)).toEqual(['e'])
    expect(p3.cursor).toBeUndefined()
  })

  it('an exact final page still ends without a cursor', async () => {
    const p1 = await source.page({ query: '', limit: 5 })
    expect(p1.items).toHaveLength(5)
    expect(p1.cursor).toBeUndefined()
  })
})

describe('query ownership', () => {
  it('ranks the whole corpus, never just a page: a later item can top the results', async () => {
    // 'video' matches c and d only; both would be OUTSIDE page 1 of an
    // unranked corpus with limit 2 - proof the source ranks first.
    const page = await source.page({ query: 'video', limit: 2 })
    expect(page.items.map((e) => e.id)).toEqual(['c', 'd'])
    expect(page.total).toBe(2)
  })

  it('search hits subtitles and badges through the default fields', async () => {
    const bySubtitle = await source.page({ query: 'vhs', limit: 10 })
    expect(bySubtitle.items.map((e) => e.id).sort()).toEqual(['c', 'd'])
    const byBadge = await source.page({ query: 'registry', limit: 10 })
    expect(byBadge.items.map((e) => e.id).sort()).toEqual(['a', 'c'])
  })

  it('a cursor from ANOTHER query is treated as absent: paging restarts', async () => {
    const videoPage = await source.page({ query: 'video', limit: 1 })
    expect(videoPage.cursor).toBeDefined()
    const other = await source.page({ query: 'pack', cursor: videoPage.cursor!, limit: 10 })
    // Fresh first page of the 'pack' query, not offset leftovers.
    expect(other.items.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('junk cursors restart at the first page instead of failing', async () => {
    for (const cursor of ['not json', '{"q":"","offset":-3}', '{"offset":"x"}']) {
      const page = await source.page({ query: '', cursor, limit: 2 })
      expect(page.items.map((e) => e.id)).toEqual(['a', 'b'])
    }
  })
})

describe('live corpus', () => {
  it('re-reads the corpus per request', async () => {
    const live: CollectionEntry[] = [entry('x', 'X')]
    const s = localCollectionSource({ id: 'live', label: 'L', corpus: () => live })
    expect((await s.page({ query: '', limit: 10 })).total).toBe(1)
    live.push(entry('y', 'Y'))
    expect((await s.page({ query: '', limit: 10 })).total).toBe(2)
  })
})

describe('defaultEntryFields', () => {
  it('weights title over subtitle over badges and omits absent parts', () => {
    expect(defaultEntryFields(entry('a', 'T', { subtitle: 's', badges: ['b1', 'b2'] }))).toEqual([
      { text: 'T', weight: 3 },
      { text: 's', weight: 2 },
      { text: 'b1', weight: 1 },
      { text: 'b2', weight: 1 },
    ])
    expect(defaultEntryFields(entry('a', 'T'))).toEqual([{ text: 'T', weight: 3 }])
  })
})
