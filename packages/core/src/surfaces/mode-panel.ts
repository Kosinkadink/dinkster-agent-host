/**
 * core.modePanel: the built-in mute/bypass control surface.
 *
 * A mode panel holds declarative BINDINGS - stable node ids and group ids -
 * and applies a mode ('active'/'muted'/'bypassed') to whatever they resolve
 * to when the user invokes the action. It never stores mode state itself
 * (the node's `mode` flag is the single source of truth) and never appears
 * in compilation.
 *
 * Binding union is versioned by `kind`: future structural queries (tag,
 * color, type) add new kinds without disturbing stored documents. A kind
 * this build does not recognize decodes as {kind:'unknown'} and is carried
 * verbatim - the panel shows it broken, apply skips it with a warning, and
 * surface.update round-trips it untouched (never a silent rewrite).
 *
 * Group bindings bind the group ID; membership is whatever is geometrically
 * inside the group WHEN THE ACTION IS INVOKED (groups store no membership -
 * see GroupViewState). Geometry needs layout, which needs schemas, so
 * membership resolution is the HOST's job at invocation time: the same
 * convention as view.moveGroup, where the interaction layer passes the
 * captured members explicitly. No polling, no geometry-triggered semantic
 * mutation - node movement after an apply changes nothing.
 */

import type { JsonObject, WorkflowDocument } from '../format/document.js'
import { surfaceConfigError, type SurfaceDecodeResult, type SurfaceTypeDefinition } from './contract.js'

export const MODE_PANEL_TYPE = 'core.modePanel'

export type ModePanelBinding =
  | { readonly kind: 'node'; readonly graphId: string; readonly nodeId: string }
  | { readonly kind: 'group'; readonly graphId: string; readonly groupId: string }
  | {
      /** A binding kind from a newer build/extension: preserved, never applied. */
      readonly kind: 'unknown'
      readonly raw: JsonObject
    }

export interface ModePanelConfig {
  readonly title?: string
  readonly bindings: readonly ModePanelBinding[]
}

const isObj = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function decodeModePanelConfig(config: JsonObject): SurfaceDecodeResult<ModePanelConfig> {
  const bad = (msg: string): SurfaceDecodeResult<ModePanelConfig> => ({
    ok: false,
    diagnostics: [surfaceConfigError(MODE_PANEL_TYPE, msg)],
  })
  if (config.title !== undefined && typeof config.title !== 'string')
    return bad('title must be a string')
  if (!Array.isArray(config.bindings)) return bad('bindings must be an array')
  const bindings: ModePanelBinding[] = []
  for (const [i, b] of config.bindings.entries()) {
    if (!isObj(b) || typeof b.kind !== 'string') return bad(`bindings[${i}] must be {kind, ...}`)
    if (b.kind === 'node') {
      if (typeof b.graphId !== 'string' || typeof b.nodeId !== 'string')
        return bad(`bindings[${i}] (node) must be {kind:'node', graphId, nodeId}`)
      bindings.push({ kind: 'node', graphId: b.graphId, nodeId: b.nodeId })
    } else if (b.kind === 'group') {
      if (typeof b.graphId !== 'string' || typeof b.groupId !== 'string')
        return bad(`bindings[${i}] (group) must be {kind:'group', graphId, groupId}`)
      bindings.push({ kind: 'group', graphId: b.graphId, groupId: b.groupId })
    } else {
      // Future kind: preserved as data, surfaced as a broken binding.
      bindings.push({ kind: 'unknown', raw: b })
    }
  }
  return {
    ok: true,
    config: {
      ...(typeof config.title === 'string' ? { title: config.title } : {}),
      bindings,
    },
    diagnostics: [],
  }
}

/**
 * Encode a typed config back into its stored JSON form. Inverse of decode:
 * unknown bindings re-emit their preserved raw object verbatim, so editing a
 * panel never destroys bindings written by a newer build or an extension.
 */
export function encodeModePanelConfig(config: ModePanelConfig): JsonObject {
  return {
    ...(config.title !== undefined ? { title: config.title } : {}),
    bindings: config.bindings.map((b) => (b.kind === 'unknown' ? b.raw : { ...b })),
  }
}

export const modePanelSurface: SurfaceTypeDefinition<ModePanelConfig> = {
  type: MODE_PANEL_TYPE,
  title: 'Mode Panel',
  decode: decodeModePanelConfig,
}

// ---------------------------------------------------------------------------
// Binding resolution (advisory: panels display it; surface.mode.apply
// re-derives it inside the command so the transaction is self-contained)
// ---------------------------------------------------------------------------

/** Host-resolved group membership, captured at invocation time. */
export interface GroupMembers {
  readonly graphId: string
  readonly groupId: string
  readonly nodeIds: readonly string[]
}

export type ResolvedModeBinding =
  | { readonly binding: ModePanelBinding; readonly status: 'ok'; readonly nodeIds: readonly string[] }
  /** Group exists but the host supplied no membership for it (e.g. its graph is not on screen). */
  | { readonly binding: ModePanelBinding; readonly status: 'unresolvedMembers' }
  | {
      readonly binding: ModePanelBinding
      readonly status: 'missingGraph' | 'missingNode' | 'missingGroup' | 'unknownKind'
    }

/**
 * Resolve each binding against the document. Node bindings resolve entirely
 * from the document; group bindings consume the host-captured `groupMembers`
 * (member ids that no longer exist in the graph are dropped here, so a stale
 * capture can never mode a deleted node).
 */
export function resolveModePanelBindings(
  doc: WorkflowDocument,
  config: ModePanelConfig,
  groupMembers: readonly GroupMembers[] = [],
): readonly ResolvedModeBinding[] {
  return config.bindings.map((binding): ResolvedModeBinding => {
    if (binding.kind === 'unknown') return { binding, status: 'unknownKind' }
    const def = doc.graphs[binding.graphId]
    if (!def) return { binding, status: 'missingGraph' }
    if (binding.kind === 'node') {
      return def.nodes[binding.nodeId]
        ? { binding, status: 'ok', nodeIds: [binding.nodeId] }
        : { binding, status: 'missingNode' }
    }
    const group = doc.view.graphs[binding.graphId]?.groups?.[binding.groupId]
    if (!group) return { binding, status: 'missingGroup' }
    const members = groupMembers.find(
      (m) => m.graphId === binding.graphId && m.groupId === binding.groupId,
    )
    if (!members) return { binding, status: 'unresolvedMembers' }
    return { binding, status: 'ok', nodeIds: members.nodeIds.filter((id) => def.nodes[id]) }
  })
}

/** Human-readable reason for a non-ok resolution (panel rows + apply warnings). */
export function brokenBindingMessage(r: ResolvedModeBinding): string | undefined {
  const b = r.binding
  switch (r.status) {
    case 'ok':
      return undefined
    case 'unknownKind':
      return `binding kind '${String((b as { raw?: JsonObject }).raw?.kind ?? 'unknown')}' is not supported by this build`
    case 'missingGraph':
      return `graph '${(b as { graphId: string }).graphId}' no longer exists`
    case 'missingNode':
      return `node '${(b as { nodeId: string }).nodeId}' no longer exists`
    case 'missingGroup':
      return `group '${(b as { groupId: string }).groupId}' no longer exists`
    case 'unresolvedMembers':
      return `group '${(b as { groupId: string }).groupId}' membership was not resolved`
  }
}
