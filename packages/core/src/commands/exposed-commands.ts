/**
 * Exposed-parameter commands (platform-plan 2.4).
 *
 * The exposed list (format/exposed.ts) is document state, so its lifecycle
 * goes through commands like everything else: deterministic patches, atomic
 * undo, serializable invocations. Every command rewrites the WHOLE list at
 * `['ext', EXPOSED_EXT_KEY]` in canonical shape - the list is small (it is
 * a hand-curated set of public controls), and whole-list writes keep the
 * patches trivially invertible and the canonical form self-healing (a
 * tolerated-malformed entry disappears on the first legitimate write).
 *
 * `inputId` is validated as a non-empty string only: commands are
 * schema-blind (same stance as node.setValue), so whether the id resolves
 * to a live elaborated input is the VIEW's concern - a stale entry renders
 * inert, never blocks document editing.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject } from '../format/document.js'
import {
  EXPOSED_EXT_KEY,
  exposedKey,
  exposedParameters,
  exposedToJson,
  type ExposedParameter,
} from '../format/exposed.js'
import type { CommandDefinition, TransactionBuilder } from './contract.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validated identity triple from params, or undefined (caller reports). */
const tripleOf = (params: Json, command: string): { triple?: ExposedParameter; error?: Diagnostic } => {
  if (!isObj(params))
    return { error: err('params.invalid', `${command}: params must be {graphId, nodeId, inputId, ...}`) }
  const { graphId, nodeId, inputId } = params
  if (typeof graphId !== 'string' || graphId.length === 0)
    return { error: err('params.invalid', `${command}: graphId must be a non-empty string`) }
  if (typeof nodeId !== 'string' || nodeId.length === 0)
    return { error: err('params.invalid', `${command}: nodeId must be a non-empty string`) }
  if (typeof inputId !== 'string' || inputId.length === 0)
    return { error: err('params.invalid', `${command}: inputId must be a non-empty string`) }
  return { triple: { graphId, nodeId, inputId } }
}

const writeExposed = (tx: TransactionBuilder, entries: readonly ExposedParameter[]): void => {
  // The root ext object may not exist yet; patches need the parent present.
  if (tx.current.ext === undefined) tx.set(['ext'], {})
  tx.set(['ext', EXPOSED_EXT_KEY], exposedToJson(entries))
}

// ---------------------------------------------------------------------------
// params.expose {graphId, nodeId, inputId, label?}
// ---------------------------------------------------------------------------

const paramsExpose: CommandDefinition = {
  id: 'params.expose',
  run(doc, params, tx) {
    const { triple, error } = tripleOf(params, 'params.expose')
    if (!triple) return [error!]
    const label = (params as JsonObject).label
    if (label !== undefined && typeof label !== 'string')
      return [err('params.invalid', 'params.expose: label must be a string')]
    const def = doc.graphs[triple.graphId]
    if (!def) return [err('graph.missing', `params.expose: unknown graph '${triple.graphId}'`)]
    if (!def.nodes[triple.nodeId])
      return [err('node.missing', `params.expose: unknown node '${triple.nodeId}'`)]
    const entries = exposedParameters(doc)
    if (entries.some((e) => exposedKey(e) === exposedKey(triple)))
      return [err('params.duplicate', `params.expose: '${triple.inputId}' on node '${triple.nodeId}' is already exposed`)]
    writeExposed(tx, [
      ...entries,
      { ...triple, ...(typeof label === 'string' && label.length > 0 ? { label } : {}) },
    ])
    return []
  },
}

// ---------------------------------------------------------------------------
// params.unexpose {graphId, nodeId, inputId}
// ---------------------------------------------------------------------------

const paramsUnexpose: CommandDefinition = {
  id: 'params.unexpose',
  run(doc, params, tx) {
    const { triple, error } = tripleOf(params, 'params.unexpose')
    if (!triple) return [error!]
    const entries = exposedParameters(doc)
    const key = exposedKey(triple)
    const kept = entries.filter((e) => exposedKey(e) !== key)
    // Unexposing a STALE entry must work (that is the recovery path), so no
    // graph/node existence checks here - only membership.
    if (kept.length === entries.length)
      return [err('params.missing', `params.unexpose: '${triple.inputId}' on node '${triple.nodeId}' is not exposed`)]
    writeExposed(tx, kept)
    return []
  },
}

// ---------------------------------------------------------------------------
// params.setLabel {graphId, nodeId, inputId, label: string | null}
// ---------------------------------------------------------------------------

const paramsSetLabel: CommandDefinition = {
  id: 'params.setLabel',
  run(doc, params, tx) {
    const { triple, error } = tripleOf(params, 'params.setLabel')
    if (!triple) return [error!]
    const label = (params as JsonObject).label
    if (label !== null && (typeof label !== 'string' || label.length === 0))
      return [err('params.invalid', 'params.setLabel: label must be a non-empty string or null')]
    const entries = exposedParameters(doc)
    const key = exposedKey(triple)
    const index = entries.findIndex((e) => exposedKey(e) === key)
    if (index === -1)
      return [err('params.missing', `params.setLabel: '${triple.inputId}' on node '${triple.nodeId}' is not exposed`)]
    const next = [...entries]
    const { label: _dropped, ...bare } = entries[index]!
    next[index] = label === null ? bare : { ...bare, label }
    writeExposed(tx, next)
    return []
  },
}

// ---------------------------------------------------------------------------
// params.move {graphId, nodeId, inputId, index}
// ---------------------------------------------------------------------------

const paramsMove: CommandDefinition = {
  id: 'params.move',
  run(doc, params, tx) {
    const { triple, error } = tripleOf(params, 'params.move')
    if (!triple) return [error!]
    const index = (params as JsonObject).index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
      return [err('params.invalid', 'params.move: index must be a non-negative integer')]
    const entries = exposedParameters(doc)
    const key = exposedKey(triple)
    const from = entries.findIndex((e) => exposedKey(e) === key)
    if (from === -1)
      return [err('params.missing', `params.move: '${triple.inputId}' on node '${triple.nodeId}' is not exposed`)]
    if (index >= entries.length)
      return [err('params.invalid', `params.move: index ${index} out of range (${entries.length} exposed)`)]
    if (index === from) return [] // no-op move records no patch
    const next = [...entries]
    const [entry] = next.splice(from, 1)
    next.splice(index, 0, entry!)
    writeExposed(tx, next)
    return []
  },
}

export const EXPOSED_COMMANDS: readonly CommandDefinition[] = [
  paramsExpose,
  paramsUnexpose,
  paramsSetLabel,
  paramsMove,
]
