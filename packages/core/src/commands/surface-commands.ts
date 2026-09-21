/**
 * Control-surface commands (architecture section 6).
 *
 * Surfaces are document state (they serialize with the workflow), so their
 * lifecycle goes through commands like everything else: deterministic
 * patches, atomic undo, serializable invocations. Structural validation
 * only - a config's TYPED shape is advisory (surfaces/contract.ts), so a
 * document carrying an unknown surface type or a config this build cannot
 * decode stays fully editable.
 *
 * surface.mode.apply is the one semantic command: it resolves a mode
 * panel's bindings at invocation time and applies ONE bulk mode change -
 * the same document writes as node.setMode, in one transaction (one undo
 * step), attributed to the surface in the log. Group membership is captured
 * by the HOST at invocation (geometry needs layout, layout needs schemas -
 * same convention as view.moveGroup) and passed explicitly; the command
 * validates every id against the document before writing. Broken bindings
 * degrade to warnings so one stale binding never blocks the rest.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { NodeMode } from '../format/document.js'
import type { Json, JsonObject } from '../format/document.js'
import { decodeModePanelConfig, MODE_PANEL_TYPE, resolveModePanelBindings, brokenBindingMessage, type GroupMembers } from '../surfaces/mode-panel.js'
import type { CommandDefinition } from './contract.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)
const warn = (code: string, message: string): Diagnostic => diag('warning', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isVec2 = (v: Json | undefined): v is JsonObject & { x: number; y: number } =>
  isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y)

// ---------------------------------------------------------------------------
// surface.add {type, config, position?}
// ---------------------------------------------------------------------------

const surfaceAdd: CommandDefinition = {
  id: 'surface.add',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.type !== 'string' || params.type.length === 0 || !isObj(params.config))
      return [err('params.invalid', 'surface.add: params must be {type, config, position?}')]
    if (params.position !== undefined && !isVec2(params.position))
      return [err('params.invalid', 'surface.add: position must be {x,y}')]
    // Never-reuse ids (CO3): the persisted document-level cursor is the
    // authority; the key scan stays as a floor for pre-cursor documents.
    // The cursor path is allocation-monotonic in DocumentStore.replay, so
    // undoing a surface.add never rewinds it.
    let next = typeof doc.surfaceSeq === 'number' ? doc.surfaceSeq : 0
    for (const key of Object.keys(doc.surfaces ?? {})) {
      const m = /^s(\d+)$/.exec(key)
      if (!m) continue
      // Only safe suffixes advance the cursor: a huge s<N> key would round
      // Number(m[1])+1 and make later allocations collide/overwrite.
      const n = Number(m[1])
      if (Number.isSafeInteger(n) && n + 1 > next) next = n + 1
    }
    // Exhaustion guard: an unsafe cursor would stop incrementing and turn
    // tx.set's add-or-replace into silent surface overwrites.
    if (!Number.isSafeInteger(next) || !Number.isSafeInteger(next + 1))
      return [err('surface.exhausted', 'surface.add: surface id cursor exhausted')]
    const id = `s${next}`
    tx.set(['surfaceSeq'], next + 1)
    if (!tx.current.surfaces) tx.set(['surfaces'], {})
    tx.set(['surfaces', id], { id, type: params.type, config: params.config })
    if (params.position) {
      if (!tx.current.view.surfaces) tx.set(['view', 'surfaces'], {})
      tx.set(['view', 'surfaces', id], { position: { x: params.position.x, y: params.position.y } })
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// surface.update {surfaceId, config}
// ---------------------------------------------------------------------------

const surfaceUpdate: CommandDefinition = {
  id: 'surface.update',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.surfaceId !== 'string' || !isObj(params.config))
      return [err('params.invalid', 'surface.update: params must be {surfaceId, config}')]
    if (!doc.surfaces?.[params.surfaceId])
      return [err('surface.missing', `surface.update: unknown surface '${params.surfaceId}'`)]
    tx.set(['surfaces', params.surfaceId, 'config'], params.config)
    return []
  },
}

// ---------------------------------------------------------------------------
// surface.remove {surfaceId}
// ---------------------------------------------------------------------------

const surfaceRemove: CommandDefinition = {
  id: 'surface.remove',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.surfaceId !== 'string')
      return [err('params.invalid', 'surface.remove: params must be {surfaceId}')]
    if (!doc.surfaces?.[params.surfaceId])
      return [err('surface.missing', `surface.remove: unknown surface '${params.surfaceId}'`)]
    tx.remove(['surfaces', params.surfaceId])
    if (doc.view.surfaces?.[params.surfaceId]) tx.remove(['view', 'surfaces', params.surfaceId])
    return []
  },
}

// ---------------------------------------------------------------------------
// view.moveSurface {surfaceId, position}
// ---------------------------------------------------------------------------

const viewMoveSurface: CommandDefinition = {
  id: 'view.moveSurface',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.surfaceId !== 'string' || !isVec2(params.position))
      return [err('params.invalid', 'view.moveSurface: params must be {surfaceId, position}')]
    if (!doc.surfaces?.[params.surfaceId])
      return [err('surface.missing', `view.moveSurface: unknown surface '${params.surfaceId}'`)]
    if (!tx.current.view.surfaces) tx.set(['view', 'surfaces'], {})
    const pos = { x: params.position.x, y: params.position.y }
    if (tx.current.view.surfaces?.[params.surfaceId]) {
      tx.set(['view', 'surfaces', params.surfaceId, 'position'], pos)
    } else {
      tx.set(['view', 'surfaces', params.surfaceId], { position: pos })
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// surface.mode.apply {surfaceId, mode, groupMembers?}
// ---------------------------------------------------------------------------

const NODE_MODES: readonly NodeMode[] = ['active', 'muted', 'bypassed']

const isGroupMembers = (v: Json): v is JsonObject & GroupMembers =>
  isObj(v) &&
  typeof v.graphId === 'string' &&
  typeof v.groupId === 'string' &&
  Array.isArray(v.nodeIds) &&
  v.nodeIds.every((n) => typeof n === 'string')

const surfaceModeApply: CommandDefinition = {
  id: 'surface.mode.apply',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.surfaceId !== 'string')
      return [err('params.invalid', 'surface.mode.apply: params must be {surfaceId, mode, groupMembers?}')]
    if (!NODE_MODES.includes(params.mode as NodeMode))
      return [err('params.invalid', `surface.mode.apply: mode must be one of ${NODE_MODES.join('/')}`)]
    if (params.groupMembers !== undefined && !(Array.isArray(params.groupMembers) && params.groupMembers.every(isGroupMembers)))
      return [err('params.invalid', 'surface.mode.apply: groupMembers must be [{graphId, groupId, nodeIds[]}]')]
    const surface = doc.surfaces?.[params.surfaceId]
    if (!surface) return [err('surface.missing', `surface.mode.apply: unknown surface '${params.surfaceId}'`)]
    if (surface.type !== MODE_PANEL_TYPE)
      return [err('surface.type', `surface.mode.apply: surface '${params.surfaceId}' is '${surface.type}', not '${MODE_PANEL_TYPE}'`)]
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) return decoded.diagnostics
    const mode = params.mode as NodeMode
    const groupMembers = (params.groupMembers ?? []) as unknown as readonly GroupMembers[]

    // One transaction: dedupe (graphId, nodeId) so overlapping bindings write
    // once; broken bindings warn and the rest still apply.
    const diagnostics: Diagnostic[] = []
    const written = new Set<string>()
    for (const r of resolveModePanelBindings(doc, decoded.config, groupMembers)) {
      const broken = brokenBindingMessage(r)
      if (broken !== undefined) {
        diagnostics.push(warn('surface.binding.broken', `surface.mode.apply: ${broken}; binding skipped`))
        continue
      }
      if (r.status !== 'ok') continue // unreachable; narrows the type
      const graphId = (r.binding as { graphId: string }).graphId
      for (const nodeId of r.nodeIds) {
        const key = `${graphId}\u0000${nodeId}`
        if (written.has(key)) continue
        written.add(key)
        tx.set(['graphs', graphId, 'nodes', nodeId, 'mode'], mode)
      }
    }
    return diagnostics
  },
}

export const SURFACE_COMMANDS: readonly CommandDefinition[] = [
  surfaceAdd,
  surfaceUpdate,
  surfaceRemove,
  viewMoveSurface,
  surfaceModeApply,
]
