/**
 * Slot-selection grammar + editing (hazard F10): the pure model behind the
 * boundary exposure editor.
 *
 * The contract under test: exposureAt reports whole/narrowed/excluded
 * (whole propagates down from an ancestor's whole-subtree entry);
 * toggleSlotSelection produces canonical entries that never pair a prefix
 * with its extension - selecting adds a whole subtree, deselecting an own
 * entry removes it (pruning empty narrowed ancestors), deselecting an
 * INHERITED slot expands the covering ancestor into explicit siblings, and
 * toggling a narrowed construct promotes it to whole; a selection that
 * would become empty is refused.
 */
import { describe, expect, it } from 'vitest'
import type { InputSpec } from '../src/schema/model.js'
import {
  exposureAt,
  parseSelection,
  selectionEntriesOf,
  toggleSlotSelection,
} from '../src/schema/slot-selection.js'

const socket = (id: string): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'IMAGE' },
  optional: false,
})

const grow = (id: string, template: InputSpec[]): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'wildcard' },
  optional: false,
  dynamic: {
    kind: 'autogrow',
    template,
    naming: { kind: 'prefix', prefix: id, min: 0, max: 4 },
  },
})

/** tag, sub{a, b, deep{x, y}}, other */
const TEMPLATE: InputSpec[] = [
  socket('tag'),
  grow('sub', [socket('a'), socket('b'), grow('deep', [socket('x'), socket('y')])]),
  socket('other'),
]

const treeOf = (entries: string[]) => {
  const parsed = parseSelection(entries)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.tree
}

const toggle = (entries: string[], path: string) => toggleSlotSelection(TEMPLATE, entries, path)

// ---------------------------------------------------------------------------
// parseSelection / selectionEntriesOf
// ---------------------------------------------------------------------------

describe('parseSelection', () => {
  it('round-trips through selectionEntriesOf canonically', () => {
    expect(selectionEntriesOf(treeOf(['tag', 'sub.deep.x', 'sub.a']))).toEqual([
      'sub.a',
      'sub.deep.x',
      'tag',
    ])
  })

  it('rejects a whole-subtree entry alongside a narrower path', () => {
    expect(parseSelection(['sub', 'sub.a'])).toHaveProperty('error')
    expect(parseSelection(['sub.a', 'sub'])).toHaveProperty('error')
  })

  it('treats exact duplicates as set semantics', () => {
    expect(selectionEntriesOf(treeOf(['tag', 'tag']))).toEqual(['tag'])
  })
})

// ---------------------------------------------------------------------------
// exposureAt
// ---------------------------------------------------------------------------

describe('exposureAt', () => {
  it('reports whole for own and ancestor-inherited entries', () => {
    const tree = treeOf(['sub', 'tag'])
    expect(exposureAt(tree, 'tag')).toBe('whole')
    expect(exposureAt(tree, 'sub')).toBe('whole')
    expect(exposureAt(tree, 'sub.a')).toBe('whole') // inherited
    expect(exposureAt(tree, 'sub.deep.x')).toBe('whole') // inherited deep
  })

  it('reports narrowed for constructs exposed via descendants only', () => {
    const tree = treeOf(['sub.deep.x'])
    expect(exposureAt(tree, 'sub')).toBe('narrowed')
    expect(exposureAt(tree, 'sub.deep')).toBe('narrowed')
    expect(exposureAt(tree, 'sub.deep.x')).toBe('whole')
  })

  it('reports excluded for unselected paths', () => {
    const tree = treeOf(['tag'])
    expect(exposureAt(tree, 'sub')).toBe('excluded')
    expect(exposureAt(tree, 'sub.deep.y')).toBe('excluded')
  })
})

// ---------------------------------------------------------------------------
// toggleSlotSelection
// ---------------------------------------------------------------------------

describe('toggleSlotSelection', () => {
  it('selects an excluded slot as a whole subtree', () => {
    expect(toggle(['tag'], 'sub')).toEqual({ ok: true, entries: ['sub', 'tag'] })
    expect(toggle(['tag'], 'sub.deep.y')).toEqual({ ok: true, entries: ['sub.deep.y', 'tag'] })
  })

  it('deselects an own whole entry, pruning empty narrowed ancestors', () => {
    expect(toggle(['sub', 'tag'], 'sub')).toEqual({ ok: true, entries: ['tag'] })
    // 'sub.deep.x' was the only selection beneath sub/deep: both prune away.
    expect(toggle(['sub.deep.x', 'tag'], 'sub.deep.x')).toEqual({ ok: true, entries: ['tag'] })
  })

  it('expands the covering ancestor when deselecting an inherited slot', () => {
    // sub is whole; unchecking sub.a pins sub to its other current children.
    expect(toggle(['sub', 'tag'], 'sub.a')).toEqual({
      ok: true,
      entries: ['sub.b', 'sub.deep', 'tag'],
    })
    // Deep inherited uncheck expands every level along the chain.
    expect(toggle(['sub'], 'sub.deep.x')).toEqual({
      ok: true,
      entries: ['sub.a', 'sub.b', 'sub.deep.y'],
    })
  })

  it('promotes a narrowed construct to a whole subtree', () => {
    expect(toggle(['sub.a', 'tag'], 'sub')).toEqual({ ok: true, entries: ['sub', 'tag'] })
    expect(toggle(['sub.deep.x'], 'sub.deep')).toEqual({ ok: true, entries: ['sub.deep'] })
  })

  it('refuses a toggle that would empty the selection', () => {
    expect(toggle(['tag'], 'tag')).toEqual({ ok: false, reason: 'empty' })
    expect(toggle(['sub.deep.x'], 'sub.deep.x')).toEqual({ ok: false, reason: 'empty' })
  })

  it('handles a single-child scope expansion emptying to refusal', () => {
    // deep's only sibling-free child: unchecking x from whole 'deep' leaves y.
    expect(toggle(['sub.deep'], 'sub.deep.x')).toEqual({ ok: true, entries: ['sub.deep.y'] })
    // ...and unchecking that too would empty everything.
    expect(toggle(['sub.deep.y'], 'sub.deep.y')).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects unknown paths, non-nestable descents, and malformed input', () => {
    expect(toggle(['tag'], 'nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(toggle(['tag'], 'tag.x')).toEqual({ ok: false, reason: 'invalid' }) // concrete slot
    expect(toggle(['tag'], 'sub..a')).toEqual({ ok: false, reason: 'invalid' })
    expect(toggleSlotSelection(TEMPLATE, ['sub', 'sub.a'], 'tag')).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('never emits a prefix alongside its extension', () => {
    // Sequence of toggles across the tree stays canonical throughout.
    let entries = ['sub']
    const step = (path: string) => {
      const res = toggleSlotSelection(TEMPLATE, entries, path)
      expect(res.ok).toBe(true)
      entries = (res as { ok: true; entries: string[] }).entries
      for (const e of entries) {
        for (const other of entries) {
          if (e !== other) expect(other.startsWith(`${e}.`)).toBe(false)
        }
      }
    }
    step('sub.deep.x') // narrow sub
    step('tag') // add tag
    step('sub.deep') // promote deep back to whole
    step('sub') // promote sub to whole
  })
})
