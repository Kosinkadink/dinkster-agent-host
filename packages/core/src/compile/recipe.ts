/**
 * Upstream recipe comparison: decides whether a runtime node's transitive
 * input closure is IDENTICAL between two lowered prompts.
 *
 * Purpose (architecture: resolved-value display): a producer value recorded
 * by a past run may present itself as exact on a LIVE tab only when it is
 * provably what the next run would compute. The engine's cache keys are
 * content-derived over the lowered recipe, so "same upstream recipe" is
 * precisely "the engine would serve the same value". The comparison runs in
 * PROMPT space, after nets/reroutes/selectors/subgraph boundaries dissolve:
 * cosmetic document edits (moving nodes, re-routing wires, renaming views)
 * compare equal by construction, and only semantic upstream changes differ.
 *
 * Deliberately structural and total:
 * - a node missing from either prompt is a difference (never a guess);
 * - literal inputs compare by deep JSON equality (object key order ignored);
 * - link inputs must reference the same upstream runtime id AND slot, and
 *   the referenced producers must compare equal recursively;
 * - a literal on one side and a link on the other is a difference;
 * - shared upstream nodes are visited once (diamond fan-in stays linear).
 *
 * What this module does NOT decide: whether the two prompts are comparable
 * at all (same schema registry, no random selector re-rolls). Those gates
 * are caller policy - this is the pure structural core.
 */

import type { Json } from '../format/document.js'
import type { Prompt, PromptNode } from './artifact.js'

/** A prompt input is a link exactly when it is a [nodeId, slot] tuple. */
function asLink(v: Json | readonly [string, number]): readonly [string, number] | undefined {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : undefined
}

function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => jsonEqual(v, b[i]!))
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const ao = a as Readonly<Record<string, Json>>
  const bo = b as Readonly<Record<string, Json>>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  return ak.every((k) => k in bo && jsonEqual(ao[k]!, bo[k]!))
}

/** One node's local recipe (type + inputs + slot choices), queueing link targets to visit. */
function nodesEqual(a: PromptNode, b: PromptNode, visit: (id: string) => void): boolean {
  if (a.class_type !== b.class_type) return false
  // Slot choices are recipe identity (the backend folds them into
  // schema_signature): two byte-identical input maps under different stored
  // variants are different computations, never a cache hit.
  if (!jsonEqual({ ...(a.slotVariants ?? {}) }, { ...(b.slotVariants ?? {}) })) return false
  if (!jsonEqual({ ...(a.outputMembers ?? {}) }, { ...(b.outputMembers ?? {}) })) return false
  if (!jsonEqual(a.outputIds ?? null, b.outputIds ?? null)) return false
  const keys = Object.keys(a.inputs)
  if (keys.length !== Object.keys(b.inputs).length) return false
  for (const key of keys) {
    if (!(key in b.inputs)) return false
    const av = a.inputs[key]!
    const bv = b.inputs[key]!
    const al = asLink(av)
    const bl = asLink(bv)
    if (al !== undefined || bl !== undefined) {
      if (al === undefined || bl === undefined) return false
      if (al[0] !== bl[0] || al[1] !== bl[1]) return false
      visit(al[0])
    } else if (!jsonEqual(av as Json, bv as Json)) {
      return false
    }
  }
  return true
}

/**
 * True iff `runtimeId`'s transitive upstream recipe is identical in both
 * prompts. The node itself is part of its recipe (its type and literal
 * inputs decide its output as much as its upstream does).
 */
export function upstreamRecipesEqual(a: Prompt, b: Prompt, runtimeId: string): boolean {
  const pending = [runtimeId]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const an = a[id]
    const bn = b[id]
    if (an === undefined || bn === undefined) return false
    if (!nodesEqual(an, bn, (next) => pending.push(next))) return false
  }
  return true
}
