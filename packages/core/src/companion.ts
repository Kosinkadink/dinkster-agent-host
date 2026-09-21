/**
 * Companion values (architecture: "resolved-value display"): a link-driven
 * input's widget renders the value it WOULD execute with, read-only, in a
 * visually distinct propagated style. The stored dormant value underneath is
 * never touched (disconnect-returns-your-value).
 *
 * Two derivation sources, one display contract:
 * - literal: the chain ends at a value source - document-static, resolved
 *   here, ALWAYS exact (this is pure compile-machinery tracing, the same
 *   traceEndpoint the compiler lowers with; no execution involved).
 * - producer: the chain ends at a real node output - the value lives in an
 *   execution, so this module only names the (node, output) pair; the host
 *   resolves it against the tab's bound execution.
 *
 * Companion values are DERIVED state: never serialized, never part of the
 * modified-from-default signal, never consumed by compile/solve/replace.
 * Scope is deliberately limited to static memberless input ports because
 * dynamic member endpoints need an address-keyed row contract. Selector
 * outputs without a resolution constrain nothing, so they yield no companion.
 */

import type { GraphDef, Json } from './format/document.js'
import { asPortId, isPortEndpoint, type LinkEndpoint } from './ids.js'
import { buildRerouteIndex, traceEndpoint, type RerouteIndex } from './reroute.js'
import { outputsOf, type NodeSchema } from './schema/model.js'

export type CompanionSource =
  /** Document-static literal (value source chain) - always exact. */
  | { readonly kind: 'literal'; readonly value: Json }
  /** Runtime producer: resolve against the bound execution. */
  | { readonly kind: 'producer'; readonly node: string; readonly output: string }

/** node id -> input port id (== widget row valueKey for static inputs) -> source. */
export type CompanionSourceMap = ReadonlyMap<string, ReadonlyMap<string, CompanionSource>>

/** Schema-aware fallback for an unstored widget tap's effective value. */
export type CompanionTapValueResolver = (nodeId: string, inputId: string) => Json | undefined

/** Resolve one endpoint through static literals and schema-declared identity outputs. */
export function companionSourceOf(
  def: GraphDef,
  from: LinkEndpoint,
  index?: RerouteIndex,
  resolveTapValue?: CompanionTapValueResolver,
  resolveSchema?: (nodeType: string) => NodeSchema | undefined,
): CompanionSource | undefined {
  const idx = index ?? buildRerouteIndex(def)
  const resolve = (endpoint: LinkEndpoint, visited: Set<string>): CompanionSource | undefined => {
    const trace = traceEndpoint(def, endpoint, idx)
    if (trace.kind === 'tapValue') {
      const stored = def.nodes[trace.node]?.values?.[trace.input]
      const value = stored !== undefined ? stored : resolveTapValue?.(trace.node, trace.input)
      return value === undefined ? undefined : { kind: 'literal', value }
    }
    if (trace.kind === 'valueSource') {
      const source = def.valueSources?.[trace.id]
      return source === undefined ? undefined : { kind: 'literal', value: source.value }
    }
    if (trace.kind !== 'output') return undefined
    if ((trace.ref.members?.length ?? 0) > 0) return undefined
    const node = def.nodes[trace.ref.node]
    const schema = node === undefined ? undefined : resolveSchema?.(node.type)
    const knownInput = schema === undefined
      ? undefined
      : outputsOf(schema).find((output) => output.id === trace.ref.port)?.knownValue?.input
    if (knownInput === undefined) {
      return { kind: 'producer', node: trace.ref.node, output: trace.ref.port }
    }
    const key = `${trace.ref.node}\u0000${trace.ref.port}`
    if (visited.has(key)) return undefined
    visited.add(key)
    return resolve({ node: trace.ref.node, tap: asPortId(knownInput) }, visited)
  }
  return resolve(from, new Set())
}

/**
 * Resolve every link/net-driven static input port of `def` to its companion
 * source. Pure and total: malformed references (missing value source,
 * undriven chains, cycles) simply yield no companion - this is display
 * derivation, diagnostics belong to invariants/compile.
 */
export function companionSourcesOf(
  def: GraphDef,
  index?: RerouteIndex,
  resolveTapValue?: CompanionTapValueResolver,
  resolveSchema?: (nodeType: string) => NodeSchema | undefined,
): CompanionSourceMap {
  const idx = index ?? buildRerouteIndex(def)
  const out = new Map<string, Map<string, CompanionSource>>()
  const put = (nodeId: string, portId: string, source: CompanionSource): void => {
    let ports = out.get(nodeId)
    if (!ports) out.set(nodeId, (ports = new Map()))
    ports.set(portId, source)
  }
  for (const link of Object.values(def.links)) {
    const to = link.to
    if (!isPortEndpoint(to) || (to.members?.length ?? 0) > 0) continue
    if (def.nodes[to.node] === undefined) continue
    const source = companionSourceOf(def, link.from, idx, resolveTapValue, resolveSchema)
    if (source !== undefined) put(to.node, to.port, source)
  }
  // Nets drive inputs exactly like links; their source may itself expose a
  // schema-declared primitive identity value.
  for (const net of Object.values(def.nets ?? {})) {
    if ((net.source.members?.length ?? 0) > 0) continue
    const source = companionSourceOf(def, net.source, idx, resolveTapValue, resolveSchema)
    if (source === undefined) continue
    for (const sink of net.sinks) {
      if ((sink.members?.length ?? 0) > 0) continue
      if (def.nodes[sink.node] === undefined) continue
      put(sink.node, sink.port, source)
    }
  }
  return out
}
