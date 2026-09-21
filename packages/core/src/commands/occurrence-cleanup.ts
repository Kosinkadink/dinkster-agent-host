import type { Json } from '../format/document.js'
import { NET_VIEWS_EXT_KEY, removeNetViewPositions, type NetViewPosition } from '../format/net-views.js'
import { samePortRef, type PortRef } from '../ids.js'
import type { TransactionBuilder } from './contract.js'

export function removeAuthoredNetViews(
  tx: TransactionBuilder,
  matches: (position: NetViewPosition) => boolean,
): void {
  const next = removeNetViewPositions(tx.current, matches)
  if (next !== undefined) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
}

/** A removed net must not linger in the graph view's collapsedNets/guideNets. */
export function pruneNetDisplayState(graphId: string, netId: string, tx: TransactionBuilder): void {
  const view = tx.current.view.graphs[graphId]
  const collapsed = view?.collapsedNets
  if (collapsed?.includes(netId)) {
    tx.set(['view', 'graphs', graphId, 'collapsedNets'], collapsed.filter((n) => n !== netId))
  }
  const guides = view?.guideNets
  if (guides?.includes(netId)) {
    tx.set(['view', 'graphs', graphId, 'guideNets'], guides.filter((n) => n !== netId))
  }
}

export function removeNetDeliverySuppressions(
  graphId: string,
  netId: string,
  removedSinks: readonly PortRef[] | undefined,
  tx: TransactionBuilder,
): void {
  for (const [key, topology] of Object.entries(tx.current.occurrenceTopologies ?? {})) {
    const kept = (topology.suppressedDeliveries ?? []).filter((suppression) => {
      if (suppression.kind === 'netSink') {
        return topology.bodyGraph !== graphId || suppression.netId !== netId ||
          (removedSinks !== undefined && !removedSinks.some((sink) => samePortRef(sink, suppression.to)))
      }
      if (suppression.kind !== 'projectedLeg' || suppression.delivery.kind !== 'netSink') return true
      const delivery = suppression.delivery
      return delivery.graph !== graphId || delivery.netId !== netId ||
        (removedSinks !== undefined && !removedSinks.some((sink) => samePortRef(sink, delivery.to)))
    })
    if (kept.length === (topology.suppressedDeliveries?.length ?? 0)) continue
    if (kept.length === 0) tx.remove(['occurrenceTopologies', key, 'suppressedDeliveries'])
    else tx.set(['occurrenceTopologies', key, 'suppressedDeliveries'], kept as unknown as Json)
  }
}

export function removeProjectedLinkSuppressions(graphId: string, linkId: string, tx: TransactionBuilder): void {
  for (const [key, topology] of Object.entries(tx.current.occurrenceTopologies ?? {})) {
    const kept = (topology.suppressedDeliveries ?? []).filter((suppression) =>
      suppression.kind !== 'projectedLeg' || suppression.delivery.kind !== 'link' ||
      suppression.delivery.graph !== graphId || suppression.delivery.linkId !== linkId)
    if (kept.length === (topology.suppressedDeliveries?.length ?? 0)) continue
    if (kept.length === 0) tx.remove(['occurrenceTopologies', key, 'suppressedDeliveries'])
    else tx.set(['occurrenceTopologies', key, 'suppressedDeliveries'], kept as unknown as Json)
  }
}
