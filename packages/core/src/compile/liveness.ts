import type { Json } from '../format/document.js'
import { portAddressKey } from '../ids.js'
import type { PortAddress } from '../schema/elaborate.js'

export interface RoutedNode {
  readonly inputs: Readonly<Record<string, Json | readonly [string, number]>>
  readonly selectorProjection?: {
    readonly choice: boolean
    readonly branches: { readonly false: string; readonly true: string }
  }
}

export interface DeliveryLiveness {
  readonly successfulDestinations: ReadonlyMap<string, readonly PortAddress[]>
  readonly included: ReadonlySet<string>
  /** Selector occurrence -> inactive branch occurrences used only by display. */
  readonly inactiveExclusive: ReadonlyMap<string, ReadonlySet<string>>
}

/** Would-run producer occurrences, keyed by consumer occurrence and input id. */
export type WouldRunEdges = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>

export type RouteProjection = 'exact' | 'would-run'

export type RoutedStep<TAt, TTerminal> =
  | { readonly kind: 'recurse'; readonly at: TAt }
  | { readonly kind: 'terminal'; readonly terminal: TTerminal }

export interface RoutedProjectionAdapter<TAt, THop, TTerminal> {
  /** Stable occurrence identity. It is intentionally not a node id. */
  key(at: TAt): string
  /**
   * Resolve one routed vertex. A bypass vertex reports its selected hop;
   * transparent endpoint vertices do not. Projection may only affect which
   * selector successors are returned and how terminals are recorded.
   */
  route(at: TAt, projection: RouteProjection): {
    readonly steps: readonly RoutedStep<TAt, TTerminal>[]
    readonly hop?: THop
  }
  cycle?(at: TAt): readonly TTerminal[]
}

export interface RoutedProjection<TTerminal, THop> {
  readonly terminals: readonly TTerminal[]
  readonly hops: readonly THop[]
}

/**
 * The one recursive routed-edge traversal used by exact and would-run.
 * Selection is projection-independent; only endpoint expansion and terminal
 * policy vary. Each branch owns its occurrence-qualified cycle set.
 */
export function traverseRoutedProjection<TAt, THop, TTerminal>(
  start: TAt,
  projection: RouteProjection,
  adapter: RoutedProjectionAdapter<TAt, THop, TTerminal>,
): RoutedProjection<TTerminal, THop> {
  const terminals: TTerminal[] = []
  const hops: THop[] = []
  const visit = (at: TAt, visited: ReadonlySet<string>): void => {
    const key = adapter.key(at)
    if (visited.has(key)) {
      terminals.push(...(adapter.cycle?.(at) ?? []))
      return
    }
    const routed = adapter.route(at, projection)
    if (routed.hop !== undefined) hops.push(routed.hop)
    const nextVisited = new Set(visited).add(key)
    for (const step of routed.steps) {
      if (step.kind === 'terminal') terminals.push(step.terminal)
      else visit(step.at, nextVisited)
    }
  }
  visit(start, new Set())
  return { terminals, hops }
}

/**
 * Collect exact destination deliveries while the routed topology is lowered,
 * then derive its occurrence-qualified upstream closure once. Interfaces are
 * deliberately absent from this API: liveness can filter delivery and scope,
 * but cannot materialize, reorder, or mutate ports.
 */
export class LivenessDerivation {
  readonly #successful = new Map<string, Map<string, PortAddress>>()

  recordSuccessfulDestination(runtimeId: string, address: PortAddress): void {
    let addresses = this.#successful.get(runtimeId)
    if (!addresses) this.#successful.set(runtimeId, (addresses = new Map()))
    addresses.set(portAddressKey(address.port, address.members), address)
  }

  derive(
    nodes: ReadonlyMap<string, RoutedNode>,
    roots: readonly string[],
    wouldRunEdges?: WouldRunEdges,
  ): DeliveryLiveness {
    const producersOf = (id: string): readonly string[] => {
      const node = nodes.get(id)
      if (!node) return []
      const projected = wouldRunEdges?.get(id)
      const inactiveKey = node.selectorProjection?.choice === undefined
        ? undefined
        : node.selectorProjection.branches[String(!node.selectorProjection.choice) as 'false' | 'true']
      const producers: string[] = []
      for (const [inputKey, value] of Object.entries(node.inputs)) {
        if (inputKey === inactiveKey) continue
        const wouldRun = projected?.get(inputKey)
        if (wouldRun !== undefined) producers.push(...wouldRun)
        else if (Array.isArray(value) && typeof value[0] === 'string') producers.push(value[0])
      }
      return producers
    }

    const closure = (starts: readonly string[]): Set<string> => {
      const result = new Set<string>()
      const stack = starts.filter((root) => nodes.has(root))
      while (stack.length > 0) {
        const id = stack.pop()!
        if (result.has(id)) continue
        result.add(id)
        stack.push(...producersOf(id))
      }
      return result
    }

    const included = closure(roots)
    const inactiveExclusive = new Map<string, ReadonlySet<string>>()
    if (wouldRunEdges !== undefined) {
      for (const [selectorId, node] of nodes) {
        const selector = node.selectorProjection
        if (!selector || !included.has(selectorId)) continue
        const inactiveKey = selector.branches[String(!selector.choice) as 'false' | 'true']
        const projected = wouldRunEdges.get(selectorId)
        const directProducers = (key: string): readonly string[] => {
          const wouldRun = projected?.get(key)
          if (wouldRun !== undefined) return [...wouldRun]
          const value = node.inputs[key]
          return Array.isArray(value) && typeof value[0] === 'string' ? [value[0]] : []
        }
        const inactive = closure(directProducers(inactiveKey))
        if (inactive.size === 0) continue
        // `included` is already the union of every selected branch and every
        // requested root cone. Subtracting it preserves both branch-shared
        // producers and producers live from any other scope root.
        for (const id of included) inactive.delete(id)
        if (inactive.size > 0) inactiveExclusive.set(selectorId, inactive)
      }
    }
    return {
      successfulDestinations: new Map(
        [...this.#successful].map(([runtimeId, addresses]) => [runtimeId, [...addresses.values()]]),
      ),
      included,
      inactiveExclusive,
    }
  }
}
