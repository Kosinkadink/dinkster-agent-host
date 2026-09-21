/**
 * Deprecation pointer resolution. `deprecation.replacement` is a name-only
 * display hint (the *how* of migration is replacement rules), and pointers
 * CHAIN: A points at B, B is itself deprecated and points at C. The UI
 * should always surface the TERMINAL type, so users are steered at the
 * current node, not at an intermediate that is also going away.
 *
 * Chains are resolved at USE time, never trusted at registration: packs
 * load independently, so a registry can only reject self-pointers - cross
 * pack cycles (A -> B -> A) and dangling pointers are representable and
 * must degrade gracefully here.
 */

import type { NodeSchema } from './model.js'

/** Pointer hops are author data; a runaway chain is a bug, not a feature. */
export const DEPRECATION_CHAIN_LIMIT = 8

export interface ResolvedDeprecationPointer {
  /**
   * Last type the chain reached. On 'ok' this is a non-deprecated (or
   * pointer-less) type; on 'cycle'/'depth' it is where resolution stopped;
   * on 'dangling' it is the type whose schema could not be resolved.
   */
  readonly terminal: string
  /** Every hop in order, starting with the FIRST pointer target. */
  readonly path: readonly string[]
  readonly status: 'ok' | 'cycle' | 'dangling' | 'depth'
}

/**
 * Follow a schema's deprecation pointer transitively. Returns undefined
 * when the schema declares no pointer at all. A 'dangling' terminal is
 * still useful display data (the author named a type this backend does not
 * ship); 'cycle'/'depth' terminals should render with a caveat.
 */
export function resolveDeprecationPointer(
  schema: NodeSchema,
  resolve: (type: string) => NodeSchema | undefined,
): ResolvedDeprecationPointer | undefined {
  const first = schema.deprecation?.replacement
  if (first === undefined) return undefined
  const seen = new Set<string>([schema.type])
  const path: string[] = []
  let current = first
  for (let hop = 0; ; hop++) {
    if (seen.has(current)) return { terminal: current, path, status: 'cycle' }
    if (hop >= DEPRECATION_CHAIN_LIMIT) return { terminal: current, path, status: 'depth' }
    seen.add(current)
    path.push(current)
    const next = resolve(current)
    if (next === undefined) return { terminal: current, path, status: 'dangling' }
    const pointer = next.deprecation?.replacement
    if (pointer === undefined) return { terminal: current, path, status: 'ok' }
    current = pointer
  }
}
