import type { WorkflowDocument } from '../format/document.js'
import { EXPOSED_EXT_KEY, parseExposedEntry } from '../format/exposed.js'
import { EXPOSED_PREVIEWS_EXT_KEY, parseExposedPreviewEntry } from '../format/exposed-previews.js'
import { APP_LAYOUT_EXT_KEY, appLayoutReferencedGraphIds } from '../format/app-layout.js'
import { NET_VIEWS_EXT_KEY, parseNetViewPosition } from '../format/net-views.js'
import { subgraphDefIdOf } from '../invariants.js'
import { decodeModePanelConfig, MODE_PANEL_TYPE } from '../surfaces/mode-panel.js'
import { lifecycleCanonicalHash } from './planner.js'

export interface SubgraphDefinitionCleanupEntry {
  readonly id: string
  readonly name: string
  readonly nodeCount: number
  readonly dependencies: readonly string[]
  readonly occurrenceCount: number
  readonly relatedItemCount: number
}

export interface SubgraphDefinitionCleanupPlan {
  readonly version: 'subgraph-definition-cleanup-v1'
  readonly fingerprint: string
  readonly removable: readonly SubgraphDefinitionCleanupEntry[]
  readonly retained: readonly SubgraphDefinitionCleanupEntry[]
}

const compareStrings = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

const definitionDependencies = (doc: WorkflowDocument, graphId: string): readonly string[] => {
  const graph = doc.graphs[graphId]
  if (graph === undefined) return []
  return [...new Set(Object.values(graph.nodes)
    .map((node) => subgraphDefIdOf(node.type))
    .filter((id): id is string => id !== undefined))].sort(compareStrings)
}

const reachableDefinitions = (doc: WorkflowDocument): ReadonlySet<string> => {
  const reachable = new Set<string>()
  const pending = [doc.root as string]
  while (pending.length > 0) {
    const graphId = pending.pop()!
    if (reachable.has(graphId) || doc.graphs[graphId] === undefined) continue
    reachable.add(graphId)
    pending.push(...definitionDependencies(doc, graphId))
  }
  return reachable
}

const relatedItemCounts = (doc: WorkflowDocument): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  const add = (graphId: string): void => {
    counts.set(graphId, (counts.get(graphId) ?? 0) + 1)
  }

  const exposed = doc.ext?.[EXPOSED_EXT_KEY]
  if (Array.isArray(exposed)) {
    for (const raw of exposed) {
      const entry = parseExposedEntry(raw)
      if (entry !== undefined) add(entry.graphId)
    }
  }
  const exposedPreviews = doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]
  if (Array.isArray(exposedPreviews)) {
    for (const raw of exposedPreviews) {
      const entry = parseExposedPreviewEntry(raw)
      if (entry !== undefined) add(entry.graphId)
    }
  }
  for (const graphId of appLayoutReferencedGraphIds(doc)) add(graphId)
  const netViews = doc.ext?.[NET_VIEWS_EXT_KEY]
  if (Array.isArray(netViews)) {
    for (const raw of netViews) {
      const entry = parseNetViewPosition(raw)
      if (entry !== undefined) add(entry.graphId)
    }
  }
  for (const surface of Object.values(doc.surfaces ?? {})) {
    if (surface.type !== MODE_PANEL_TYPE) continue
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) continue
    for (const binding of decoded.config.bindings) {
      if (binding.kind !== 'unknown') add(binding.graphId)
    }
  }
  for (const bookmark of Object.values(doc.view.bookmarks ?? {})) {
    for (const graphId of new Set(bookmark.graphStack)) add(graphId)
  }
  return counts
}

const cleanupFingerprint = (doc: WorkflowDocument): string => lifecycleCanonicalHash({
  root: doc.root,
  graphs: Object.fromEntries(Object.keys(doc.graphs).sort(compareStrings).map((graphId) => [graphId, doc.graphs[graphId]])),
  graphViews: Object.fromEntries(Object.keys(doc.view.graphs).sort(compareStrings).map((graphId) => [graphId, doc.view.graphs[graphId]])),
  occurrenceTopologies: doc.occurrenceTopologies ?? null,
  surfaces: doc.surfaces ?? null,
  bookmarks: doc.view.bookmarks ?? null,
  exposed: doc.ext?.[EXPOSED_EXT_KEY] ?? null,
  exposedPreviews: doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY] ?? null,
  appLayout: doc.ext?.[APP_LAYOUT_EXT_KEY] ?? null,
  netViews: doc.ext?.[NET_VIEWS_EXT_KEY] ?? null,
})

export function planSubgraphDefinitionCleanup(doc: WorkflowDocument): SubgraphDefinitionCleanupPlan {
  const reachable = reachableDefinitions(doc)
  const related = relatedItemCounts(doc)
  const occurrenceCounts = new Map<string, number>()
  for (const graph of Object.values(doc.graphs)) {
    for (const node of Object.values(graph.nodes)) {
      const child = subgraphDefIdOf(node.type)
      if (child !== undefined) occurrenceCounts.set(child, (occurrenceCounts.get(child) ?? 0) + 1)
    }
  }
  const entries = Object.keys(doc.graphs)
    .filter((id) => id !== doc.root)
    .sort(compareStrings)
    .map((id): SubgraphDefinitionCleanupEntry => ({
      id,
      name: doc.graphs[id]!.name,
      nodeCount: Object.keys(doc.graphs[id]!.nodes).length,
      dependencies: definitionDependencies(doc, id),
      occurrenceCount: occurrenceCounts.get(id) ?? 0,
      relatedItemCount: related.get(id) ?? 0,
    }))
  return {
    version: 'subgraph-definition-cleanup-v1',
    fingerprint: cleanupFingerprint(doc),
    removable: entries.filter((entry) => !reachable.has(entry.id)),
    retained: entries.filter((entry) => reachable.has(entry.id)),
  }
}
