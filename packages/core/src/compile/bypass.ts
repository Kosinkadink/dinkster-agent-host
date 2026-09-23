/**
 * Bypass passthrough matching.
 *
 * A bypassed node lowers to a type-matched passthrough: each of its outputs
 * that a downstream consumer actually uses forwards from ONE of its own
 * driven inputs (architecture section 6). The matcher here is the pure,
 * deterministic core: given the requested output and the node's candidate
 * inputs, pick the input whose incoming connection passes through.
 *
 * Matching rule (deterministic over elaborated interface order):
 *   1. the input at the SAME wire index, when its type is compatible
 *   2. the first input whose type matches exactly
 *   3. the first compatible input
 *
 * "Exact" = the two type expressions denote the same concrete atom set
 * (unions compare as sets; two unrestricted expressions - wildcards or
 * unconstrained variables - are exact together). "Compatible" defers to the
 * one advisory helper (type-compatibility.ts) so bypass can never disagree with drop
 * targets/diagnostics about what connects to what - dynamic types included.
 *
 * Only DRIVEN inputs are candidates: bypass forwards connections, never
 * widget values ("pass my incoming noodle through"). An undriven input that
 * would have matched is simply not a route - if nothing is driven and
 * compatible, the consumer edge drops with a diagnostic and the required-
 * input check downstream reports the gap. Candidate `index` is the input's
 * position over ALL wireable inputs (interface order), so index preference
 * is stable regardless of which inputs happen to be connected.
 */

import { atomNamesOf, typesCompatible } from '../schema/type-compatibility.js'
import type { TypeExpr } from '../schema/model.js'

export interface BypassCandidate<D> {
  /** Position among the node's wireable inputs (interface order). */
  readonly index: number
  readonly type: TypeExpr
  /** Whatever drives this input (opaque to the matcher). */
  readonly driver: D
}

const sameAtomSet = (a: TypeExpr, b: TypeExpr): boolean => {
  const an = atomNamesOf(a)
  const bn = atomNamesOf(b)
  if (an === undefined || bn === undefined) return an === bn // both unrestricted = exact
  if (an.length !== bn.length) {
    // Sets, not lists: dedupe before comparing lengths.
    const as = new Set(an)
    const bs = new Set(bn)
    return as.size === bs.size && [...as].every((n) => bs.has(n))
  }
  const bs = new Set(bn)
  return an.every((n) => bs.has(n))
}

/**
 * Pick the passthrough input for `output` among `candidates` (driven,
 * wireable inputs in interface order). Undefined = no route.
 */
export function matchBypassInput<D>(
  output: { readonly index: number; readonly type: TypeExpr },
  candidates: readonly BypassCandidate<D>[],
): BypassCandidate<D> | undefined {
  const atIndex = candidates.find((c) => c.index === output.index)
  if (atIndex && typesCompatible(atIndex.type, output.type)) return atIndex
  const exact = candidates.find((c) => sameAtomSet(c.type, output.type))
  if (exact) return exact
  return candidates.find((c) => typesCompatible(c.type, output.type))
}
