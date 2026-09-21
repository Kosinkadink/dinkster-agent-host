/**
 * Document-aware group id allocation floor (FR1).
 *
 * Group ids outlive their groups in durable surface bindings (a mode panel
 * keeps a removed group's binding as visibly broken), so a reminted id
 * silently retargets that binding onto an unrelated group. The persisted
 * per-graph cursor (`view.graphs[g].groupSeq`) is the authority, but a
 * PRE-CURSOR saved document can carry a broken binding to `grp0` with no
 * live groups and no cursor - the binding itself is then the only
 * allocation evidence. Every mutation-time allocator of `grpN` keys
 * (view.createGroup, clipboard paste) therefore floors on all three:
 *
 *   1. the persisted `groupSeq` cursor,
 *   2. live group keys (legacy floor),
 *   3. group ids referenced by known durable mode-panel bindings.
 *
 * The binding scan is TOLERANT: a malformed surface config never blocks
 * allocation (decode-time validation owns rejection); it just contributes
 * nothing. Unknown binding kinds from newer builds may reference groups we
 * cannot see - documented limitation, not a claimed guarantee. Fresh-
 * document constructors (LiteGraph import, synthetic generation) build new
 * documents with no identity history and mint `grpN` directly.
 */

import type { WorkflowDocument } from './format/document.js'
import { groupIdFloor } from './ids.js'
import { MODE_PANEL_TYPE } from './surfaces/mode-panel.js'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Group ids referenced by known durable bindings for `graphId` (tolerant scan). */
function referencedGroupIds(doc: WorkflowDocument, graphId: string): string[] {
  const out: string[] = []
  for (const surface of Object.values(doc.surfaces ?? {})) {
    if (!isObj(surface) || surface.type !== MODE_PANEL_TYPE || !isObj(surface.config)) continue
    const bindings = surface.config.bindings
    if (!Array.isArray(bindings)) continue
    for (const b of bindings) {
      if (isObj(b) && b.kind === 'group' && b.graphId === graphId && typeof b.groupId === 'string')
        out.push(b.groupId)
    }
  }
  return out
}

/**
 * The one floor every mutation-time `grpN` allocator uses. Composing here
 * (instead of at each call site) is what keeps createGroup and paste from
 * drifting apart again.
 */
export function groupAllocationFloor(doc: WorkflowDocument, graphId: string): number {
  const vg = doc.view.graphs[graphId]
  return groupIdFloor(vg?.groupSeq, [
    ...Object.keys(vg?.groups ?? {}),
    ...referencedGroupIds(doc, graphId),
  ])
}
