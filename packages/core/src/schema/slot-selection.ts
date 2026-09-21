/**
 * Slot-selection grammar and editing (hazard F10): the shared model for
 * `BoundaryBinding.slots`, used by boundary derivation (filtering a
 * forwarded family's template) and by the boundary exposure editor
 * (computing per-slot state and the next selection after a toggle).
 *
 * Splitting entries on '.' is the `slots` field's OWN grammar, not id
 * parsing - template slot ids never legally contain dots (elaboration warns
 * via elab.id.reserved). A bare id selects a slot - for a nested autogrow
 * construct, its WHOLE subtree, tracking nested schema evolution. A dotted
 * path narrows the construct to the listed descendants; ancestor exposure
 * is implied. Whole-subtree and narrowed selection of the same construct
 * are mutually exclusive.
 *
 * Everything here is pure data-in/data-out so the editor can be tested
 * without a document, a store, or a DOM.
 */

import type { InputSpec } from './model.js'

/**
 * Selection parsed from dotted entries: 'all' marks a whole-subtree entry
 * ('sub'); a nested map narrows the construct to the listed descendants
 * ('sub.s').
 */
export type SelectionTree = Map<string, SelectionTree | 'all'>

/**
 * Parse dotted selection entries into a tree. Whole-subtree and narrowed
 * selection of the same construct are mutually exclusive; exact duplicates
 * are idempotent (set semantics).
 */
export function parseSelection(
  entries: readonly string[],
): { tree: SelectionTree } | { error: string } {
  const tree: SelectionTree = new Map()
  for (const entry of entries) {
    const segs = entry.split('.')
    let cur = tree
    let walked = ''
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!
      walked = walked === '' ? seg : `${walked}.${seg}`
      const existing = cur.get(seg)
      if (i === segs.length - 1) {
        if (existing instanceof Map) {
          return { error: `'${entry}' selects a whole subtree but narrower path(s) beneath it are also listed; list one or the other` }
        }
        cur.set(seg, 'all')
      } else {
        if (existing === 'all') {
          return { error: `'${entry}' narrows '${walked}', which is already selected as a whole subtree; list one or the other` }
        }
        const next = existing ?? new Map<string, SelectionTree | 'all'>()
        if (existing === undefined) cur.set(seg, next)
        cur = next
      }
    }
  }
  return { tree }
}

/** Flatten a tree back to canonical (sorted) dotted entries. */
export function selectionEntriesOf(tree: SelectionTree): string[] {
  const out: string[] = []
  const walk = (node: SelectionTree, prefix: string): void => {
    for (const [seg, sub] of node) {
      const path = prefix === '' ? seg : `${prefix}.${seg}`
      if (sub === 'all') out.push(path)
      else walk(sub, path)
    }
  }
  walk(tree, '')
  return out.sort()
}

/**
 * How a pinned selection exposes the slot at `path`:
 * - 'whole': selected as a whole subtree, either directly or via an
 *   ancestor's whole-subtree entry (nested slots added later stay exposed).
 * - 'narrowed': an autogrow construct exposed only through selected
 *   descendants (ancestor exposure is implied; its own future template
 *   additions stay hidden).
 * - 'excluded': not exposed.
 */
export type SlotExposure = 'whole' | 'narrowed' | 'excluded'

export function exposureAt(tree: SelectionTree, path: string): SlotExposure {
  let cur: SelectionTree | 'all' = tree
  for (const seg of path.split('.')) {
    if (cur === 'all') return 'whole' // ancestor selected the whole subtree
    const next: SelectionTree | 'all' | undefined = cur.get(seg)
    if (next === undefined) return 'excluded'
    cur = next
  }
  return cur === 'all' ? 'whole' : 'narrowed'
}

/** The slot spec chain along a dotted path, or undefined if it does not
 * exist / descends into a non-autogrow construct. */
function specChainAt(template: readonly InputSpec[], segs: readonly string[]): InputSpec[] | undefined {
  const chain: InputSpec[] = []
  let scope: readonly InputSpec[] = template
  for (let i = 0; i < segs.length; i++) {
    const slot = scope.find((s) => s.id === segs[i])
    if (!slot) return undefined
    chain.push(slot)
    if (i < segs.length - 1) {
      if (slot.dynamic?.kind !== 'autogrow') return undefined
      scope = slot.dynamic.template
    }
  }
  return chain
}

export type ToggleResult =
  | { readonly ok: true; readonly entries: string[] }
  /** 'empty': the toggle would deselect everything (a pinned selection must
   *  stay nonempty); 'invalid': path or current entries are malformed. */
  | { readonly ok: false; readonly reason: 'empty' | 'invalid' }

/**
 * The selection after toggling the slot at `path` in a PINNED selection:
 *
 * - excluded -> selected as a whole subtree (ancestors become implied).
 * - whole (own entry) -> excluded.
 * - whole (inherited from an ancestor's whole-subtree entry) -> the
 *   ancestor's entry is EXPANDED: every sibling along the chain becomes an
 *   explicit whole entry and `path` alone drops out. Expansion pins the
 *   ancestor's exposure to today's template - the only faithful way to
 *   exclude one descendant of a whole subtree.
 * - narrowed -> promoted to a whole-subtree entry (descendant entries fold
 *   into it).
 *
 * Never emits both an entry and a strict extension of it, and returns
 * canonical (sorted) entries ready for boundary.setSlots.
 */
export function toggleSlotSelection(
  template: readonly InputSpec[],
  entries: readonly string[],
  path: string,
): ToggleResult {
  const parsed = parseSelection(entries)
  if ('error' in parsed) return { ok: false, reason: 'invalid' }
  const segs = path.split('.')
  if (segs.some((s) => s.length === 0)) return { ok: false, reason: 'invalid' }
  if (specChainAt(template, segs) === undefined) return { ok: false, reason: 'invalid' }

  // Walk to the deepest existing tree node along the path, tracking where
  // (if anywhere) an ancestor whole-subtree entry covers it.
  const nodes: (SelectionTree | 'all')[] = [parsed.tree]
  let coveredAt = -1 // index into segs of the ancestor holding 'all'
  for (let i = 0; i < segs.length; i++) {
    const cur = nodes[i]!
    if (cur === 'all') break
    const next = cur.get(segs[i]!)
    if (next === undefined) break
    if (next === 'all' && i < segs.length - 1) coveredAt = i
    nodes.push(next)
  }

  const state = exposureAt(parsed.tree, path)
  if (state === 'excluded') {
    // Select: add as a whole subtree. Insertion cannot conflict - an
    // excluded path has no selected descendants and no 'all' ancestors.
    let cur = parsed.tree
    for (let i = 0; i < segs.length - 1; i++) {
      const existing = cur.get(segs[i]!)
      const next = existing instanceof Map ? existing : new Map<string, SelectionTree | 'all'>()
      cur.set(segs[i]!, next)
      cur = next
    }
    cur.set(segs[segs.length - 1]!, 'all')
    return { ok: true, entries: selectionEntriesOf(parsed.tree) }
  }

  if (state === 'narrowed') {
    // Promote: descendants fold into one whole-subtree entry.
    const parent = nodes[segs.length - 1]
    if (!(parent instanceof Map)) return { ok: false, reason: 'invalid' }
    parent.set(segs[segs.length - 1]!, 'all')
    return { ok: true, entries: selectionEntriesOf(parsed.tree) }
  }

  // state === 'whole': deselect.
  if (coveredAt === -1) {
    // Own entry: remove it and prune now-empty ancestors (a narrowed
    // construct with nothing selected beneath is not representable).
    const removeAt = (node: SelectionTree, depth: number): void => {
      const seg = segs[depth]!
      if (depth === segs.length - 1) {
        node.delete(seg)
        return
      }
      const next = node.get(seg)
      if (!(next instanceof Map)) return
      removeAt(next, depth + 1)
      if (next.size === 0) node.delete(seg)
    }
    removeAt(parsed.tree, 0)
    const out = selectionEntriesOf(parsed.tree)
    return out.length === 0 ? { ok: false, reason: 'empty' } : { ok: true, entries: out }
  }

  // Inherited: expand the covering ancestor's whole-subtree entry into
  // explicit sibling entries along the chain, leaving `path` out.
  const chain = specChainAt(template, segs)!
  const holder = nodes[coveredAt]
  if (!(holder instanceof Map)) return { ok: false, reason: 'invalid' }
  let scope: readonly InputSpec[] = chain[coveredAt]!.dynamic!.kind === 'autogrow'
    ? (chain[coveredAt]!.dynamic as { template: readonly InputSpec[] }).template
    : []
  let cur: SelectionTree = new Map()
  holder.set(segs[coveredAt]!, cur)
  for (let i = coveredAt + 1; i < segs.length; i++) {
    for (const sibling of scope) {
      if (sibling.id !== segs[i]) cur.set(sibling.id, 'all')
    }
    if (i < segs.length - 1) {
      const next = new Map<string, SelectionTree | 'all'>()
      cur.set(segs[i]!, next)
      cur = next
      scope = (chain[i]!.dynamic as { template: readonly InputSpec[] }).template
    }
  }
  // Prune: the expansion may leave empty narrowed nodes when the toggled
  // slot was the only member of its scope(s).
  const prune = (node: SelectionTree): void => {
    for (const [seg, sub] of node) {
      if (sub instanceof Map) {
        prune(sub)
        if (sub.size === 0) node.delete(seg)
      }
    }
  }
  prune(parsed.tree)
  const out = selectionEntriesOf(parsed.tree)
  return out.length === 0 ? { ok: false, reason: 'empty' } : { ok: true, entries: out }
}
