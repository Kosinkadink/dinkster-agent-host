/** Directed, policy-independent analysis for selection execution modes. */

import type { GraphDef } from './format/document.js'
import { isPortEndpoint } from './ids.js'
import { buildRerouteIndex, traceEndpointAll } from './reroute.js'

export interface SelectionExecutionAnalysis {
  readonly selected: ReadonlySet<string>
  readonly first: readonly string[]
  readonly last: readonly string[]
  /** Selected nodes with no direct collapsed edge to another selected node. */
  readonly sinks: readonly string[]
  readonly upstream: ReadonlySet<string>
  readonly downstream: ReadonlySet<string>
  readonly between: ReadonlySet<string>
  readonly contiguous: boolean
  readonly cyclicNodes: ReadonlySet<string>
  readonly cyclic: boolean
  /** Upstream closure for app-derived targets such as backend output nodes. */
  readonly upstreamOf: (starts: Iterable<string>) => ReadonlySet<string>
}

interface DirectedGraph {
  readonly forward: ReadonlyMap<string, ReadonlySet<string>>
  readonly reverse: ReadonlyMap<string, ReadonlySet<string>>
  readonly cyclicNodes: ReadonlySet<string>
}

/**
 * Collapse reroutes, selectors, widget taps, and named nets into directed
 * real-node edges. Selectors expand through every defined candidate: this is
 * authored topology, independent of the policy chosen by a later compile.
 */
function directedGraph(def: GraphDef): DirectedGraph {
  const ids = Object.keys(def.nodes).sort()
  const forward = new Map(ids.map((id) => [id, new Set<string>()]))
  const reverse = new Map(ids.map((id) => [id, new Set<string>()]))
  const add = (from: string, to: string): void => {
    if (!forward.has(from) || !forward.has(to)) return
    forward.get(from)!.add(to)
    reverse.get(to)!.add(from)
  }
  const reroutes = buildRerouteIndex(def)
  for (const link of Object.values(def.links)) {
    if (!isPortEndpoint(link.to) || def.nodes[link.to.node] === undefined) continue
    for (const trace of traceEndpointAll(def, link.from, reroutes)) {
      if (trace.kind === 'output') add(trace.ref.node, link.to.node)
    }
  }
  for (const net of Object.values(def.nets)) {
    for (const sink of net.sinks) add(net.source.node, sink.node)
  }

  // Tarjan SCCs scope cyclicity to participating nodes. A whole-graph
  // boolean is too coarse: an unrelated cycle must not hide valid partial
  // execution actions elsewhere in the document.
  let nextIndex = 0
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cyclicNodes = new Set<string>()
  const visit = (id: string): void => {
    const index = nextIndex++
    indices.set(id, index)
    lowlinks.set(id, index)
    stack.push(id)
    onStack.add(id)
    for (const next of forward.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next)
        lowlinks.set(id, Math.min(lowlinks.get(id)!, lowlinks.get(next)!))
      } else if (onStack.has(next)) {
        lowlinks.set(id, Math.min(lowlinks.get(id)!, indices.get(next)!))
      }
    }
    if (lowlinks.get(id) !== indices.get(id)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== id)
    if (component.length > 1 || forward.get(id)?.has(id)) {
      for (const nodeId of component) cyclicNodes.add(nodeId)
    }
  }
  for (const id of ids) if (!indices.has(id)) visit(id)
  return { forward, reverse, cyclicNodes }
}

function reachable(
  starts: Iterable<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const seen = new Set(starts)
  const queue = [...seen]
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i]!) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** Analyze first/last nodes, closures, and directed contiguity of a selection. */
export function analyzeSelectionExecution(
  def: GraphDef,
  selection: Iterable<string>,
): SelectionExecutionAnalysis {
  const graph = directedGraph(def)
  const selected = new Set([...selection].filter((id) => def.nodes[id] !== undefined).sort())
  const upstreamOf = (starts: Iterable<string>): ReadonlySet<string> => reachable(starts, graph.reverse)
  if (selected.size === 0) {
    return {
      selected,
      first: [],
      last: [],
      sinks: [],
      upstream: new Set(),
      downstream: new Set(),
      between: new Set(),
      contiguous: false,
      cyclicNodes: graph.cyclicNodes,
      cyclic: graph.cyclicNodes.size > 0,
      upstreamOf,
    }
  }

  const hasOtherSelected = (id: string, edges: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
    const closure = reachable(edges.get(id) ?? [], edges)
    for (const candidate of selected) if (closure.has(candidate)) return true
    return false
  }
  const first = [...selected].filter((id) => !hasOtherSelected(id, graph.reverse))
  const last = [...selected].filter((id) => !hasOtherSelected(id, graph.forward))
  const sinks = [...selected].filter((id) =>
    [...(graph.forward.get(id) ?? [])].every((next) => !selected.has(next)),
  )
  const upstream = reachable(first, graph.reverse)
  const downstream = reachable(last, graph.forward)
  const fromFirst = reachable(first, graph.forward)
  const toLast = reachable(last, graph.reverse)
  const between = new Set([...fromFirst].filter((id) => toLast.has(id)))

  const exact = between.size === selected.size && [...between].every((id) => selected.has(id))
  const betweenIsAcyclic = [...between].every((id) => !graph.cyclicNodes.has(id))
  let weaklyConnected = false
  if (between.size > 1) {
    const start = between.values().next().value as string
    const seen = new Set([start])
    const queue = [start]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!
      const adjacent = new Set([...(graph.forward.get(id) ?? []), ...(graph.reverse.get(id) ?? [])])
      for (const next of adjacent) {
        if (!between.has(next) || seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    weaklyConnected = seen.size === between.size
  }

  return {
    selected,
    first,
    last,
    sinks,
    upstream,
    downstream,
    between,
    contiguous: selected.size > 1 && exact && weaklyConnected && betweenIsAcyclic,
    cyclicNodes: graph.cyclicNodes,
    cyclic: graph.cyclicNodes.size > 0,
    upstreamOf,
  }
}
