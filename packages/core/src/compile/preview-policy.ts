/**
 * Live-preview policy resolution for a compiled artifact.
 *
 * The submit body carries ONE effective policy: a base mode plus per-node
 * overrides keyed by RUNTIME node id (the ids the backend engine resolves
 * against). Layering, outermost first: app global setting < workflow
 * document override < enclosing subgraph instance override < node override.
 * Nested instance overrides win innermost-first, matching how a reader
 * scopes them visually.
 *
 * Nodes inside repetition regions execute under iteration-path labels
 * (`region[3]/node`) that cannot be enumerated at compile time, so per-node
 * overrides do not reach them; they follow the base mode.
 */

import type { PreviewMode, WorkflowDocument } from '../format/document.js'
import { asGraphDefId, parseOccurrenceKey } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import type { Provenance } from './artifact.js'

/**
 * How animated previews travel: `ring` ships per-frame stills cycled in a
 * fixed frame ring; `encoded` ships one self-contained animation container
 * (an animated WebP) per emit. Run-wide, never per node.
 */
export type PreviewAnimation = 'ring' | 'encoded'

/** The submit body's `previews` field (backend PR #407). */
export interface SubmitPreviewPolicy {
  readonly mode: PreviewMode
  readonly nodes?: Readonly<Record<string, PreviewMode>>
  readonly animation?: PreviewAnimation
}

/**
 * Resolve the effective preview policy for a compiled artifact. `snapshot`
 * and `provenance` must come from the SAME artifact: overrides are read from
 * the exact document that compiled, never the live (possibly edited) one.
 */
export function resolvePreviewPolicy(
  snapshot: WorkflowDocument,
  provenance: Provenance,
  globalMode: PreviewMode,
  animation: PreviewAnimation = 'ring',
): SubmitPreviewPolicy {
  const base = snapshot.previews ?? globalMode
  const nodes: Record<string, PreviewMode> = {}
  for (const [runtimeId, occKey] of Object.entries(provenance.toSource)) {
    const override = overrideFor(snapshot, occKey)
    if (override !== undefined && override !== base) nodes[runtimeId] = override
  }
  return {
    mode: base,
    ...(Object.keys(nodes).length > 0 ? { nodes } : {}),
    // The ring default stays implicit so older backends never see the field.
    ...(animation === 'encoded' ? { animation } : {}),
  }
}

/**
 * The nearest `previews` override along one occurrence's instance path
 * (instance overrides apply to everything they contain; deeper wins).
 */
function overrideFor(snapshot: WorkflowDocument, occKey: string): PreviewMode | undefined {
  let occ
  try {
    occ = parseOccurrenceKey(occKey)
  }
  catch {
    return undefined
  }
  let defId = snapshot.root
  let override: PreviewMode | undefined
  for (const instanceId of occ.instancePath) {
    const instance = snapshot.graphs[defId]?.nodes[instanceId]
    if (!instance) return undefined
    if (instance.previews !== undefined) override = instance.previews
    const next = subgraphDefIdOf(instance.type)
    if (next === undefined || !snapshot.graphs[next]) return undefined
    defId = asGraphDefId(next)
  }
  const leaf = snapshot.graphs[defId]?.nodes[occ.node]
  if (!leaf) return undefined
  if (leaf.previews !== undefined) override = leaf.previews
  return override
}
