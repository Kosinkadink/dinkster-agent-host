/**
 * Environment stamping + drift diagnostics.
 *
 * ComfyUI workflows record node names and nothing else, so the producing
 * environment is unreproducible without out-of-band knowledge. A Dinkster
 * document carries an optional EnvironmentStamp: which packs (with
 * version/digest/source pins) and which node-type interfaces (signatures)
 * produced it, stamped from live /api/nodes data at save time.
 *
 * Contract (agreed with the backend): the stamp is a RECORD, never
 * identity. Nothing here is load-bearing - loading, compiling, and
 * executing never read it; absence is fully valid; a malformed stamp is
 * sanitized away with a warning, never an error. Its two consumers are
 * load-time drift diagnostics (below) and backend-side environment
 * reproduction (dinkster-pack reproduce).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type { PackInfo } from '../schema/model.js'
import type {
  EnvironmentNodeStamp,
  EnvironmentPackStamp,
  EnvironmentStamp,
  WorkflowDocument,
} from './document.js'

/**
 * What stamping/drift reads from a live backend surface. Deliberately
 * narrower than the client's SchemaRegistry so core stays client-free;
 * adapt a registry with `{ resolve, packs, server }`.
 */
export interface EnvironmentSource {
  readonly resolve: SchemaResolver
  /** /api/nodes packs table (absent on ComfyUI V1 backends). */
  readonly packs?: ReadonlyMap<string, PackInfo>
  /** /api/nodes "dinkster" header (absent on V1 and older Dinkster backends). */
  readonly server?: { readonly version: string; readonly schemaWire: number }
  /** The frontend build performing the stamping. */
  readonly frontendVersion?: string
}

/** Node types instantiated anywhere in the document (root + all subgraph defs), subgraph instances excluded. */
const usedNodeTypes = (doc: WorkflowDocument): readonly string[] => {
  const types = new Set<string>()
  for (const g of Object.values(doc.graphs)) {
    for (const n of Object.values(g.nodes)) {
      if (!n.type.startsWith('#')) types.add(n.type)
    }
  }
  return [...types].sort()
}

/**
 * Compute a fresh stamp for `doc` from a live surface. Used-only on both
 * axes: only instantiated node types, only packs attributing them. Returns
 * undefined when NO used type carries a signature (ComfyUI V1 backend, or
 * schemas not loaded): no stamp rather than an empty lie - callers should
 * then preserve any existing stamp instead of overwriting it.
 */
export function stampEnvironment(
  doc: WorkflowDocument,
  source: EnvironmentSource,
): EnvironmentStamp | undefined {
  const nodes: Record<string, EnvironmentNodeStamp> = {}
  const packIds = new Set<string>()
  for (const type of usedNodeTypes(doc)) {
    const schema = source.resolve(type)
    if (schema?.signature === undefined) continue
    nodes[type] = {
      ...(schema.pack !== undefined ? { pack: schema.pack } : {}),
      signature: schema.signature,
    }
    if (schema.pack !== undefined) packIds.add(schema.pack)
  }
  if (Object.keys(nodes).length === 0) return undefined

  const packs: Record<string, EnvironmentPackStamp> = {}
  for (const id of [...packIds].sort()) {
    const p = source.packs?.get(id)
    packs[id] = {
      ...(p?.version !== undefined ? { version: p.version } : {}),
      ...(p?.artifactDigest !== undefined ? { artifactDigest: p.artifactDigest } : {}),
      ...(p?.source !== undefined ? { source: p.source } : {}),
      ...(p?.publisher !== undefined ? { publisher: p.publisher } : {}),
    }
  }

  return {
    ...(source.server !== undefined ? { dinkster: source.server } : {}),
    ...(source.frontendVersion !== undefined ? { frontend: { version: source.frontendVersion } } : {}),
    packs,
    nodes,
  }
}

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Structurally sanitize a raw `environment` value from parsed JSON.
 * Warn-and-drop, NEVER error: the stamp is advisory, so a malformed one
 * must not block loading (and must not survive to mislead drift checks).
 * Valid parts are kept; each dropped part is named in a single warning.
 */
export function sanitizeEnvironment(raw: unknown): {
  readonly stamp?: EnvironmentStamp
  readonly diagnostics: readonly Diagnostic[]
} {
  if (raw === undefined) return { diagnostics: [] }
  const dropped: string[] = []
  const warn = (): readonly Diagnostic[] => [
    diag(
      'warning',
      'environment',
      'env.stamp-malformed',
      `document carries a malformed environment stamp; dropped: ${dropped.join(', ')} (advisory only - the workflow loads normally)`,
    ),
  ]
  if (!isObj(raw)) {
    dropped.push('environment')
    return { diagnostics: warn() }
  }

  let dinkster: EnvironmentStamp['dinkster']
  if (raw['dinkster'] !== undefined) {
    const d = raw['dinkster']
    const version = isObj(d) ? optStr(d['version']) : undefined
    const schemaWire = isObj(d) && typeof d['schemaWire'] === 'number' ? d['schemaWire'] : undefined
    if (version !== undefined && schemaWire !== undefined) dinkster = { version, schemaWire }
    else dropped.push('dinkster')
  }

  let frontend: EnvironmentStamp['frontend']
  if (raw['frontend'] !== undefined) {
    const f = raw['frontend']
    const version = isObj(f) ? optStr(f['version']) : undefined
    if (version !== undefined) frontend = { version }
    else dropped.push('frontend')
  }

  const packs: Record<string, EnvironmentPackStamp> = {}
  if (raw['packs'] !== undefined) {
    if (!isObj(raw['packs'])) dropped.push('packs')
    else {
      for (const [id, p] of Object.entries(raw['packs'])) {
        if (!isObj(p)) {
          dropped.push(`packs.${id}`)
          continue
        }
        const version = optStr(p['version'])
        const artifactDigest = optStr(p['artifactDigest'])
        const source = optStr(p['source'])
        const publisher = optStr(p['publisher'])
        packs[id] = {
          ...(version !== undefined ? { version } : {}),
          ...(artifactDigest !== undefined ? { artifactDigest } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(publisher !== undefined ? { publisher } : {}),
        }
      }
    }
  }

  const nodes: Record<string, EnvironmentNodeStamp> = {}
  if (raw['nodes'] !== undefined) {
    if (!isObj(raw['nodes'])) dropped.push('nodes')
    else {
      for (const [type, n] of Object.entries(raw['nodes'])) {
        const signature = isObj(n) ? optStr(n['signature']) : undefined
        if (signature === undefined) {
          dropped.push(`nodes.${type}`)
          continue
        }
        const pack = optStr((n as Record<string, unknown>)['pack'])
        nodes[type] = { ...(pack !== undefined ? { pack } : {}), signature }
      }
    }
  }

  // A stamp with no comparable node identities carries no information we
  // act on; keep it only if it at least records SOMETHING valid.
  const hasContent =
    dinkster !== undefined || frontend !== undefined || Object.keys(packs).length > 0 || Object.keys(nodes).length > 0
  if (!hasContent) {
    if (dropped.length === 0) dropped.push('environment')
    return { diagnostics: warn() }
  }
  return {
    stamp: {
      ...(dinkster !== undefined ? { dinkster } : {}),
      ...(frontend !== undefined ? { frontend } : {}),
      packs,
      nodes,
    },
    diagnostics: dropped.length > 0 ? warn() : [],
  }
}

/**
 * Compare a document's stamp against the live surface. Advisory, per the
 * agreed philosophy: documents are never rejected, drift is surfaced
 * visibly. Three findings:
 * - env.node-missing (warning): a stamped type is not on this backend;
 * - env.node-drift (warning): a stamped type's interface signature changed
 *   since save - the workflow may behave differently;
 * - env.pack-updated (info): a used pack's pin changed but every used node
 *   interface is identical - noise suppression, not an alarm.
 * Types whose live schema carries no signature (V1 backend) are
 * incomparable and stay silent.
 */
export function environmentDrift(
  stamp: EnvironmentStamp,
  live: Pick<EnvironmentSource, 'resolve' | 'packs'>,
): readonly Diagnostic[] {
  const out: Diagnostic[] = []
  const packsWithNodeFindings = new Set<string>()
  for (const [type, st] of Object.entries(stamp.nodes)) {
    const packSuffix = st.pack !== undefined ? ` (pack '${st.pack}')` : ''
    const schema = live.resolve(type)
    if (schema === undefined) {
      out.push(
        diag(
          'warning',
          'environment',
          'env.node-missing',
          `node type '${type}'${packSuffix} was in the producing environment but is not on the connected backend`,
        ),
      )
      if (st.pack !== undefined) packsWithNodeFindings.add(st.pack)
      continue
    }
    if (schema.signature === undefined) continue // incomparable (V1): stay silent
    if (schema.signature !== st.signature) {
      out.push(
        diag(
          'warning',
          'environment',
          'env.node-drift',
          `node type '${type}'${packSuffix} changed interface since this workflow was saved; review its inputs/outputs`,
        ),
      )
      if (st.pack !== undefined) packsWithNodeFindings.add(st.pack)
    }
  }
  for (const [packId, st] of Object.entries(stamp.packs)) {
    if (packsWithNodeFindings.has(packId)) continue // node findings already tell the story
    const liveInfo = live.packs?.get(packId)
    if (liveInfo === undefined) continue
    // Compare by the strongest pin both sides share: digest, else version.
    const changed =
      st.artifactDigest !== undefined && liveInfo.artifactDigest !== undefined
        ? st.artifactDigest !== liveInfo.artifactDigest
        : st.version !== undefined && liveInfo.version !== undefined
          ? st.version !== liveInfo.version
          : false
    if (changed) {
      const from = st.version ?? st.artifactDigest
      const to = liveInfo.version ?? liveInfo.artifactDigest
      out.push(
        diag(
          'info',
          'environment',
          'env.pack-updated',
          `pack '${packId}' changed (${from} -> ${to}) but every node interface this workflow uses is unchanged`,
        ),
      )
    }
  }
  return out
}
