/**
 * Shared search scorer: ONE ranking implementation for every search box -
 * the add-node palette, collection views (templates, assets, packs,
 * history), and anything extensions contribute. A single scorer means a
 * query behaves identically everywhere, and ranking quality fixes land
 * once.
 *
 * Design (deliberately NOT broad fzf-style subsequence matching, which
 * floods results with accidental letter-scatter hits):
 * - the query splits into whitespace tokens; EVERY token must match
 *   somewhere (AND semantics), each token scored against its best field;
 * - a token matches a field by exact equality > field prefix >
 *   word-boundary prefix > substring, scaled by the field's weight -
 *   display names outweigh type ids outweigh categories;
 * - typo tolerance (edit distance 1 against whole words) applies only to
 *   tokens of 4+ characters, and only when nothing matches exactly, so
 *   short precise tokens never fuzz;
 * - scoring is pure and deterministic; ties keep the caller's order
 *   (callers pre-sort alphabetically), so results are stable frame to
 *   frame.
 */

/** One searchable text field with its ranking weight (higher = stronger). */
export interface SearchField {
  readonly text: string
  readonly weight: number
}

/** Node-palette fields. Search terms behave like aliases, below display-name hits. */
export function nodeSearchFields(node: {
  readonly displayName: string
  readonly type: string
  readonly category: string
  readonly searchAliases?: readonly string[]
  readonly searchTerms?: readonly string[]
  readonly description?: string
}): SearchField[] {
  return [
    { text: node.displayName, weight: 3 },
    { text: node.type, weight: 2 },
    ...(node.searchAliases ?? []).map((text) => ({ text, weight: 2 })),
    ...(node.searchTerms ?? []).map((text) => ({ text, weight: 2 })),
    { text: node.category, weight: 1 },
    ...(node.description !== undefined ? [{ text: node.description, weight: 0.5 }] : []),
  ]
}

// Base scores per match quality; field weight multiplies these.
const EXACT = 100
const PREFIX = 80
const WORD_PREFIX = 60
const SUBSTRING = 30
const TYPO = 15

/** Minimum token length before typo tolerance applies. */
const TYPO_MIN_TOKEN = 4

const words = (text: string): string[] => text.split(/[^a-z0-9]+/).filter((w) => w.length > 0)

/** True when a and b are within edit distance 1 (bounded, single pass). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  // Ensure a is the shorter (or equal) string.
  if (la > lb) return withinOneEdit(b, a)
  let i = 0
  // Skip the common prefix.
  while (i < la && a[i] === b[i]) i++
  if (la === lb) {
    // One substitution allowed: the rest after the mismatch must be equal.
    return a.slice(i + 1) === b.slice(i + 1)
  }
  // One insertion in b allowed: skip b's extra char, the rest must match.
  return a.slice(i) === b.slice(i + 1)
}

/** Best score for one query token against one field, 0 when unmatched. */
function tokenFieldScore(token: string, field: SearchField): number {
  const text = field.text.toLowerCase()
  if (text.length === 0) return 0
  if (text === token) return EXACT * field.weight
  if (text.startsWith(token)) return PREFIX * field.weight
  const fieldWords = words(text)
  if (fieldWords.some((w) => w.startsWith(token))) return WORD_PREFIX * field.weight
  if (text.includes(token)) return SUBSTRING * field.weight
  if (token.length >= TYPO_MIN_TOKEN && fieldWords.some((w) => withinOneEdit(token, w))) {
    return TYPO * field.weight
  }
  return 0
}

/**
 * Score a candidate against a query. Returns undefined when the candidate
 * does not match (some token matched no field); 0 for an empty query
 * (everything matches neutrally, callers keep their pre-sorted order).
 */
export function scoreMatch(query: string, fields: readonly SearchField[]): number | undefined {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return 0
  let total = 0
  for (const token of tokens) {
    let best = 0
    for (const field of fields) {
      const s = tokenFieldScore(token, field)
      if (s > best) best = s
    }
    if (best === 0) return undefined // AND semantics: every token must land
    total += best
  }
  return total
}

/**
 * Rank items by scoreMatch, descending; non-matches drop. Ties keep the
 * input order (stable sort), so callers control the neutral ordering by
 * pre-sorting. Empty query returns the input order unfiltered.
 */
export function rankSearch<T>(
  query: string,
  items: readonly T[],
  fieldsOf: (item: T) => readonly SearchField[],
  opts?: { readonly limit?: number },
): T[] {
  const limit = opts?.limit ?? Number.POSITIVE_INFINITY
  const tokens = query.trim()
  if (tokens.length === 0) return items.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = scoreMatch(query, fieldsOf(item))
    if (score !== undefined) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score) // stable: ties keep input order
  return scored.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit).map((s) => s.item)
}
