import { isSubtreeBinding, type NodeData, type WorkflowDocument } from '../format/document.js'
import { subgraphDefIdOf } from '../invariants.js'
import type { GraphDefId } from '../ids.js'
import type { NodeSchema } from '../schema/model.js'
import { buildBoundaryCrossings, inheritSubtreeState, isSubtreeCrossing, mergeDynamicScope, type BoundaryNodeState } from './crossing.js'

/** Shared, non-persisted inheritance for instance rendering and compilation. */
export function boundaryStateResolver(
  document: WorkflowDocument,
  resolveNode: (graph: GraphDefId, node: NodeData) => NodeSchema | undefined,
): (graph: GraphDefId, node: NodeData, authored?: BoundaryNodeState) => BoundaryNodeState {
  const cache = new Map<string, BoundaryNodeState>()
  const visiting = new Set<string>()
  const defaults = (graph: GraphDefId, node: NodeData): BoundaryNodeState => {
    const childId = subgraphDefIdOf(node.type)
    const child = childId === undefined ? undefined : document.graphs[childId]
    if (!child?.boundary?.inputs.some((item) => isSubtreeBinding(item.binds))) return node
    const key = JSON.stringify([graph, node.id])
    const cached = cache.get(key)
    if (cached) return cached
    if (visiting.has(key)) return node
    visiting.add(key)
    let inherited: BoundaryNodeState = { values: {} }
    const { crossings } = buildBoundaryCrossings(child, () => undefined, node.dynamic, (inner) => resolveNode(child.id, inner), node.values)
    for (const crossing of crossings.values()) {
      if (!isSubtreeCrossing(crossing)) continue
      const inner = child.nodes[crossing.targetNode]
      if (!inner) continue
      const projected = inheritSubtreeState(defaults(child.id, inner), crossing)
      inherited = {
        values: { ...inherited.values, ...projected.values },
        controllers: { ...inherited.controllers, ...projected.controllers },
        dynamic: mergeDynamicScope(inherited.dynamic, projected.dynamic),
      }
    }
    const result = mergeState(inherited, node)
    visiting.delete(key)
    cache.set(key, result)
    return result
  }
  return (graph, node, authored = node) => {
    const inherited = defaults(graph, node)
    return inherited === node && authored === node ? node : mergeState(inherited, authored)
  }
}

const mergeState = (inherited: BoundaryNodeState, authored: BoundaryNodeState): BoundaryNodeState => ({
  values: { ...inherited.values, ...authored.values },
  controllers: { ...inherited.controllers, ...authored.controllers },
  dynamic: mergeDynamicScope(inherited.dynamic, authored.dynamic),
})
