import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject } from '../format/document.js'
import {
  EXPOSED_PREVIEWS_EXT_KEY,
  exposedPreviewKey,
  exposedPreviews,
  exposedPreviewsToJson,
  type ExposedPreview,
} from '../format/exposed-previews.js'
import type { CommandDefinition, TransactionBuilder } from './contract.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const identityOf = (
  params: Json,
  command: string,
): { identity?: ExposedPreview; error?: Diagnostic } => {
  if (!isObj(params))
    return { error: err('params.invalid', `${command}: params must be {graphId, nodeId, ...}`) }
  const { graphId, nodeId } = params
  if (typeof graphId !== 'string' || graphId.length === 0)
    return { error: err('params.invalid', `${command}: graphId must be a non-empty string`) }
  if (typeof nodeId !== 'string' || nodeId.length === 0)
    return { error: err('params.invalid', `${command}: nodeId must be a non-empty string`) }
  return { identity: { graphId, nodeId } }
}

const writeExposedPreviews = (tx: TransactionBuilder, entries: readonly ExposedPreview[]): void => {
  if (tx.current.ext === undefined) tx.set(['ext'], {})
  tx.set(['ext', EXPOSED_PREVIEWS_EXT_KEY], exposedPreviewsToJson(entries))
}

const previewExpose: CommandDefinition = {
  id: 'previews.expose',
  run(doc, params, tx) {
    const { identity, error } = identityOf(params, 'previews.expose')
    if (identity === undefined) return [error!]
    const label = (params as JsonObject).label
    if (label !== undefined && typeof label !== 'string')
      return [err('params.invalid', 'previews.expose: label must be a string')]
    const graph = doc.graphs[identity.graphId]
    if (graph === undefined)
      return [err('graph.missing', `previews.expose: unknown graph '${identity.graphId}'`)]
    if (graph.nodes[identity.nodeId] === undefined)
      return [err('node.missing', `previews.expose: unknown node '${identity.nodeId}'`)]
    const entries = exposedPreviews(doc)
    if (entries.some((entry) => exposedPreviewKey(entry) === exposedPreviewKey(identity)))
      return [err('previews.duplicate', `previews.expose: node '${identity.nodeId}' is already exposed`)]
    writeExposedPreviews(tx, [
      ...entries,
      { ...identity, ...(typeof label === 'string' && label.length > 0 ? { label } : {}) },
    ])
    return []
  },
}

const previewUnexpose: CommandDefinition = {
  id: 'previews.unexpose',
  run(doc, params, tx) {
    const { identity, error } = identityOf(params, 'previews.unexpose')
    if (identity === undefined) return [error!]
    const entries = exposedPreviews(doc)
    const key = exposedPreviewKey(identity)
    const kept = entries.filter((entry) => exposedPreviewKey(entry) !== key)
    if (kept.length === entries.length)
      return [err('previews.missing', `previews.unexpose: node '${identity.nodeId}' is not exposed`)]
    writeExposedPreviews(tx, kept)
    return []
  },
}

const previewSetLabel: CommandDefinition = {
  id: 'previews.setLabel',
  run(doc, params, tx) {
    const { identity, error } = identityOf(params, 'previews.setLabel')
    if (identity === undefined) return [error!]
    const label = (params as JsonObject).label
    if (label !== null && (typeof label !== 'string' || label.length === 0))
      return [err('params.invalid', 'previews.setLabel: label must be a non-empty string or null')]
    const entries = exposedPreviews(doc)
    const index = entries.findIndex((entry) => exposedPreviewKey(entry) === exposedPreviewKey(identity))
    if (index === -1)
      return [err('previews.missing', `previews.setLabel: node '${identity.nodeId}' is not exposed`)]
    const next = [...entries]
    const { label: _dropped, ...bare } = entries[index]!
    next[index] = label === null ? bare : { ...bare, label }
    writeExposedPreviews(tx, next)
    return []
  },
}

const previewMove: CommandDefinition = {
  id: 'previews.move',
  run(doc, params, tx) {
    const { identity, error } = identityOf(params, 'previews.move')
    if (identity === undefined) return [error!]
    const index = (params as JsonObject).index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
      return [err('params.invalid', 'previews.move: index must be a non-negative integer')]
    const entries = exposedPreviews(doc)
    const from = entries.findIndex((entry) => exposedPreviewKey(entry) === exposedPreviewKey(identity))
    if (from === -1)
      return [err('previews.missing', `previews.move: node '${identity.nodeId}' is not exposed`)]
    if (index >= entries.length)
      return [err('params.invalid', `previews.move: index ${index} out of range (${entries.length} exposed)`)]
    if (index === from) return []
    const next = [...entries]
    const [entry] = next.splice(from, 1)
    next.splice(index, 0, entry!)
    writeExposedPreviews(tx, next)
    return []
  },
}

export const EXPOSED_PREVIEW_COMMANDS: readonly CommandDefinition[] = [
  previewExpose,
  previewUnexpose,
  previewSetLabel,
  previewMove,
]
