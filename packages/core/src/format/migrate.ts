/**
 * Document loading + migration pipeline (skeleton).
 *
 * Every released formatVersion N ships an N -> N+1 migration; old documents
 * replay the chain on load, one step at a time (architecture section 16).
 * Pre-release, v1 is current and unstable, so the registry is empty - but
 * the pipeline, version gates and diagnostics are in place and tested.
 *
 * Foreign formats are DETECTED and rejected with targeted diagnostics:
 * - legacy litegraph workflows: translated by a dedicated importer (later
 *   milestone), never loaded directly
 * - Comfy API prompts: compiler OUTPUT, not authorable documents
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import {
  FORMAT_VERSION,
  suppressedDeliveryKey,
  type Json,
  type JsonObject,
  type SuppressedDelivery,
  type WorkflowDocument,
} from './document.js'
import { sanitizeEnvironment } from './environment.js'
import { ownJson } from './json.js'
import { NET_VIEWS_EXT_KEY } from './net-views.js'
import { validateDocumentShape } from './validate.js'
import { checkDocument } from '../invariants.js'

export type FormatKind =
  | 'dinkster-workflow'
  | 'litegraph-workflow'
  | 'comfy-api-prompt'
  | 'unknown'

/** Best-effort detection of what kind of JSON the user handed us. */
export function detectFormat(json: unknown): FormatKind {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'unknown'
  const o = json as Record<string, unknown>
  if (o['format'] === 'dinkster-workflow') return 'dinkster-workflow'
  // Litegraph workflow: top-level nodes array + links (+ last_node_id/version).
  if (Array.isArray(o['nodes']) && 'links' in o) return 'litegraph-workflow'
  // API prompt: a map of node-id -> {class_type, inputs}.
  const values = Object.values(o)
  if (
    values.length > 0 &&
    values.every(
      (v) =>
        typeof v === 'object' &&
        v !== null &&
        !Array.isArray(v) &&
        typeof (v as Record<string, unknown>)['class_type'] === 'string' &&
        typeof (v as Record<string, unknown>)['inputs'] === 'object',
    )
  ) {
    return 'comfy-api-prompt'
  }
  return 'unknown'
}

/** One version step. Applied to raw JSON (pre-validation of the NEW version). */
export interface MigrationStep {
  /** Source version; migrates from `from` to `from + 1`. */
  readonly from: number
  readonly description: string
  migrate(doc: JsonObject): {
    readonly doc: JsonObject
    readonly diagnostics: readonly Diagnostic[]
  }
}

/**
 * Registered format migrations: every RELEASED version N ships N -> N+1.
 * Pre-release, v1 is unstable and revised in place, so the registry is empty;
 * the pipeline itself stays validated by synthetic-step tests that run the
 * full loadDocument path (format.test.ts).
 */
export const MIGRATIONS: readonly MigrationStep[] = []

export interface MigrateResult {
  readonly doc?: JsonObject
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Replay the migration chain from `doc`'s formatVersion up to
 * `targetVersion`. Fails with a diagnostic if a step is missing.
 */
export function migrateJson(
  raw: JsonObject,
  migrations: readonly MigrationStep[] = MIGRATIONS,
  targetVersion: number = FORMAT_VERSION,
): MigrateResult {
  const diags: Diagnostic[] = []
  const version = raw['formatVersion']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      diagnostics: [
        diag('error', 'import', 'doc.version.invalid', `formatVersion must be a positive integer, got ${JSON.stringify(version)}`),
      ],
    }
  }
  if (version > targetVersion) {
    return {
      diagnostics: [
        diag('error', 'import', 'doc.version.future', `document formatVersion ${version} is newer than supported version ${targetVersion}; upgrade the application`),
      ],
    }
  }
  const byFrom = new Map(migrations.map((m) => [m.from, m]))
  let doc = raw
  for (let v = version; v < targetVersion; v++) {
    const step = byFrom.get(v)
    if (!step) {
      diags.push(
        diag('error', 'import', 'doc.version.gap', `no migration registered from formatVersion ${v} to ${v + 1}`),
      )
      return { diagnostics: diags }
    }
    const result = step.migrate(doc)
    diags.push(...result.diagnostics)
    if (result.diagnostics.some((d) => d.severity === 'error')) {
      return { diagnostics: diags }
    }
    doc = { ...result.doc, formatVersion: v + 1 }
  }
  return { doc, diagnostics: diags }
}

// ---------------------------------------------------------------------------
// Pre-release canonicalization (in-place format revisions)
// ---------------------------------------------------------------------------

export interface CanonicalizeResult {
  readonly doc: JsonObject
  readonly diagnostics: readonly Diagnostic[]
}

const isJsonObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Rewrite retired pre-release shapes into the current canonical form.
 * Pre-release, v1 is revised in place (no version bump, no parallel native
 * representations); documents saved under a retired shape are translated
 * here, once, on load - nothing downstream ever sees the old shape.
 *
 * Current rewrites:
 * - Port references: scalar `member` (retired) becomes the member-id path
 *   array `members: [member]`. A ref carrying BOTH fields is ambiguous and
 *   rejected ('doc.member.ambiguous'). Covers every PortRef-bearing document
 *   position: link `from`/`to` (port endpoints), net `source`/`sinks`, and
 *   boundary `binds`.
 * - Boundary bindings: a `binds` lacking the explicit `kind` discriminant
 *   (retired - saved before whole-family forwarding existed) becomes
 *   `kind: 'port'`. Every pre-`kind` binding WAS a concrete port binding,
 *   so this is a translation, not a guess. Nothing downstream accepts an
 *   untagged binding.
 *
 * The input is never mutated; rewrites happen on a clone. Malformed JSON is
 * left as-is for shape validation to diagnose with proper paths.
 */
export function canonicalizeJson(raw: JsonObject): CanonicalizeResult {
  const diags: Diagnostic[] = []
  let rewritten = 0
  let bindsRewritten = 0

  // Clone lazily: untouched documents pass through unchanged.
  let doc = raw

  const canonRef = (
    owner: Record<string, unknown> | unknown[],
    key: string | number,
    path: string,
    pos: 'ref' | 'bind',
  ): void => {
    const v = (owner as Record<string | number, unknown>)[key]
    if (!isJsonObj(v)) return
    if (pos === 'bind' && v['kind'] === undefined && typeof v['port'] === 'string') {
      if (doc === raw) doc = structuredClone(raw)
      bindsRewritten++
    }
    const member = v['member']
    if (member === undefined) return
    if (v['members'] !== undefined) {
      diags.push(
        diag('error', 'import', 'doc.member.ambiguous', `${path}: carries both the retired scalar 'member' and canonical 'members'; cannot canonicalize`),
      )
      return
    }
    if (typeof member !== 'string' || member.length === 0) {
      diags.push(
        diag('error', 'import', 'doc.member.invalid', `${path}.member: retired scalar member must be a non-empty string`),
      )
      return
    }
    if (doc === raw) doc = structuredClone(raw)
    rewritten++
  }

  // Two passes over the same walk: first detect (and diagnose) on the raw
  // document, then apply to the clone. One walker, two visitors; the apply
  // visitor re-checks the exact conditions the detect pass counted.
  const walk = (root: JsonObject, visit: typeof canonRef): void => {
    const graphs = root['graphs']
    if (!isJsonObj(graphs)) return
    for (const [gid, g] of Object.entries(graphs)) {
      if (!isJsonObj(g)) continue
      const base = `$.graphs.${gid}`
      const links = g['links']
      if (isJsonObj(links)) {
        for (const [lid, l] of Object.entries(links)) {
          if (!isJsonObj(l)) continue
          // Only PORT endpoints are PortRefs; reroute/value-source endpoints
          // carry no member identity (discriminator precedence matches
          // validation - a stray 'member' key on them is not ours to touch).
          for (const side of ['from', 'to'] as const) {
            const e = l[side]
            if (isJsonObj(e) && e['reroute'] === undefined && e['valueSource'] === undefined) {
              visit(l, side, `${base}.links.${lid}.${side}`, 'ref')
            }
          }
        }
      }
      const nets = g['nets']
      if (isJsonObj(nets)) {
        for (const [nid, n] of Object.entries(nets)) {
          if (!isJsonObj(n)) continue
          visit(n, 'source', `${base}.nets.${nid}.source`, 'ref')
          const sinks = n['sinks']
          if (Array.isArray(sinks)) sinks.forEach((_, i) => visit(sinks, i, `${base}.nets.${nid}.sinks[${i}]`, 'ref'))
        }
      }
      const boundary = g['boundary']
      if (isJsonObj(boundary)) {
        for (const side of ['inputs', 'outputs'] as const) {
          const items = boundary[side]
          if (!Array.isArray(items)) continue
          items.forEach((item, i) => {
            if (isJsonObj(item)) visit(item, 'binds', `${base}.boundary.${side}[${i}].binds`, 'bind')
          })
        }
      }
    }
  }

  walk(raw, canonRef)

  // Occurrence topology is a prerelease v1-in-place addition. Its negative
  // overlay is set-like: suppressions sort/deduplicate by structural identity
  // and disappear when empty. Boundary-binding slot selections are likewise
  // unordered, while member paths and route hops remain ordered. An empty
  // never-allocated record carries no identity or semantics and is omitted;
  // any advanced cursor retains the empty owner skeleton forever.
  const rawTopologies = doc['occurrenceTopologies']
  if (isJsonObj(rawTopologies)) {
    if (doc === raw) doc = structuredClone(raw)
    const topologies = doc['occurrenceTopologies'] as Record<string, unknown>
    let topologyRewrites = 0

    const canonicalizeRoute = (route: unknown): void => {
      if (!Array.isArray(route)) return
      for (const leg of route) {
        if (!isJsonObj(leg) || !isJsonObj(leg['binding'])) continue
        const slots = leg['binding']['slots']
        if (!Array.isArray(slots) || !slots.every((slot) => typeof slot === 'string')) continue
        const sorted = [...slots].sort()
        if (slots.some((slot, index) => slot !== sorted[index])) {
          leg['binding']['slots'] = sorted
          topologyRewrites++
        }
      }
    }

    for (const [key, candidate] of Object.entries(topologies)) {
      if (!isJsonObj(candidate)) continue
      const links = candidate['links']
      if (isJsonObj(links)) {
        for (const link of Object.values(links)) {
          if (!isJsonObj(link)) continue
          for (const side of ['from', 'to'] as const) {
            const endpoint = link[side]
            if (isJsonObj(endpoint) && endpoint['kind'] === 'boundary')
              canonicalizeRoute(endpoint['route'])
          }
        }
      }

      const suppressions = candidate['suppressedDeliveries']
      if (Array.isArray(suppressions)) {
        for (const suppression of suppressions) {
          if (isJsonObj(suppression) && suppression['kind'] === 'projectedLeg')
            canonicalizeRoute(suppression['route'])
        }
        if (suppressions.length === 0) {
          delete candidate['suppressedDeliveries']
          topologyRewrites++
        } else {
          try {
            const keyed = suppressions.map((suppression) => [
              suppressedDeliveryKey(suppression as SuppressedDelivery),
              suppression,
            ] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            const deduped = keyed.filter(([entryKey], index) =>
              index === 0 || keyed[index - 1]![0] !== entryKey).map(([, suppression]) => suppression)
            if (deduped.length !== suppressions.length ||
                deduped.some((suppression, index) => suppression !== suppressions[index])) {
              candidate['suppressedDeliveries'] = deduped
              topologyRewrites++
            }
          } catch {
            // Shape validation below owns malformed suppressions.
          }
        }
      }

      const canonicalFields = new Set([
        'owner',
        'bodyGraph',
        'links',
        'suppressedDeliveries',
        'nextOrdinal',
        'actorCursors',
      ])
      const actorCursors = candidate['actorCursors']
      const hasAdvancedActor = isJsonObj(actorCursors) &&
        Object.values(actorCursors).some((cursor) => typeof cursor === 'number' && cursor > 0)
      const empty =
        isJsonObj(candidate['links']) && Object.keys(candidate['links']).length === 0 &&
        candidate['suppressedDeliveries'] === undefined &&
        candidate['nextOrdinal'] === 0 &&
        !hasAdvancedActor &&
        candidate['ext'] === undefined &&
        Object.keys(candidate).every((field) => canonicalFields.has(field))
      if (empty) {
        delete topologies[key]
        topologyRewrites++
      }
    }

    if (Object.keys(topologies).length === 0) {
      const { occurrenceTopologies: _dropped, ...withoutTopologies } = doc
      doc = withoutTopologies
      topologyRewrites++
    }
    if (topologyRewrites > 0) {
      diags.push(diag(
        'info',
        'import',
        'doc.occurrenceTopology.canonicalized',
        `canonicalized ${topologyRewrites} occurrence topology field(s)`,
      ))
    }
  }

  if (doc !== raw) {
    walk(doc, (owner, key, _path, pos) => {
      const v = (owner as Record<string | number, unknown>)[key]
      if (!isJsonObj(v)) return
      if (pos === 'bind' && v['kind'] === undefined && typeof v['port'] === 'string') v['kind'] = 'port'
      const member = v['member']
      if (typeof member !== 'string' || member.length === 0 || v['members'] !== undefined) return
      v['members'] = [member]
      delete v['member']
    })
    if (rewritten > 0) {
      diags.push(
        diag('info', 'import', 'doc.member.retired', `canonicalized ${rewritten} port reference(s) from the retired scalar 'member' field to member-id paths`),
      )
    }
    if (bindsRewritten > 0) {
      diags.push(
        diag('info', 'import', 'doc.binds.retired', `canonicalized ${bindsRewritten} boundary binding(s) lacking the explicit 'kind' discriminant to kind 'port'`),
      )
    }
  }

  // Net view geometry: an absolute `position` (retired) becomes an `offset`
  // relative to the owning node's stored view position, so a manually placed
  // Set/Get tag follows its node (#176). The rewrite reproduces the same
  // on-screen point (node position + offset == old absolute position), so
  // nothing jumps on load. Entries whose owning node cannot be resolved or
  // has no stored position keep their absolute geometry and render as-is.
  {
    const ext = raw['ext']
    const entries = isJsonObj(ext) ? ext[NET_VIEWS_EXT_KEY] : undefined
    const rewrites: { readonly index: number; readonly offset: { x: number; y: number } }[] = []
    if (Array.isArray(entries)) {
      const vec = (v: unknown): { x: number; y: number } | undefined =>
        isJsonObj(v) && typeof v['x'] === 'number' && Number.isFinite(v['x']) &&
        typeof v['y'] === 'number' && Number.isFinite(v['y'])
          ? { x: v['x'], y: v['y'] }
          : undefined
      entries.forEach((entry, index) => {
        if (!isJsonObj(entry) || entry['offset'] !== undefined) return
        const position = vec(entry['position'])
        const graphId = entry['graphId']
        if (position === undefined || typeof graphId !== 'string') return
        let owner: unknown
        if (entry['role'] === 'sink') {
          owner = isJsonObj(entry['to']) ? entry['to']['node'] : undefined
        } else if (entry['role'] === 'source') {
          const graphs = raw['graphs']
          const graph = isJsonObj(graphs) ? graphs[graphId] : undefined
          const nets = isJsonObj(graph) ? graph['nets'] : undefined
          const net = isJsonObj(nets) && typeof entry['netId'] === 'string' ? nets[entry['netId']] : undefined
          owner = isJsonObj(net) && isJsonObj(net['source']) ? net['source']['node'] : undefined
        } else {
          return
        }
        if (typeof owner !== 'string') return
        const view = raw['view']
        const viewGraphs = isJsonObj(view) ? view['graphs'] : undefined
        const viewGraph = isJsonObj(viewGraphs) ? viewGraphs[graphId] : undefined
        const viewNodes = isJsonObj(viewGraph) ? viewGraph['nodes'] : undefined
        const ownerView = isJsonObj(viewNodes) ? viewNodes[owner] : undefined
        const ownerPos = isJsonObj(ownerView) ? vec(ownerView['position']) : undefined
        if (ownerPos === undefined) return
        const offset = { x: position.x - ownerPos.x, y: position.y - ownerPos.y }
        // Finite inputs can still overflow the subtraction; keep the
        // absolute form rather than writing a non-finite offset.
        if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return
        rewrites.push({ index, offset })
      })
    }
    if (rewrites.length > 0) {
      if (doc === raw) doc = structuredClone(raw)
      const cloned = (doc['ext'] as Record<string, unknown>)[NET_VIEWS_EXT_KEY] as unknown[]
      for (const { index, offset } of rewrites) {
        const entry = cloned[index] as Record<string, unknown>
        delete entry['position']
        entry['offset'] = offset
      }
      diags.push(
        diag('info', 'import', 'doc.netViews.retired', `canonicalized ${rewrites.length} net view(s) from the retired absolute position to node-relative offsets`),
      )
    }
  }
  return { doc, diagnostics: diags }
}

export interface LoadResult {
  /** Present only when there are no error-level diagnostics. */
  readonly document?: WorkflowDocument
  readonly diagnostics: readonly Diagnostic[]
}

export interface LoadOptions {
  /** Override the migration registry (tests). */
  readonly migrations?: readonly MigrationStep[]
  /** Override the target version (tests). */
  readonly targetVersion?: number
}

/**
 * Load a workflow document from parsed JSON: detect format, migrate to the
 * current version, shape-validate, and invariant-check. The single entry
 * point for opening documents; nothing downstream ever sees raw JSON.
 */
export function loadDocument(json: unknown, opts?: LoadOptions): LoadResult {
  // Ownership/hostility boundary FIRST (CO1/CO2/CO8): everything below -
  // format detection, migration, canonicalization, validation - traverses
  // the value, so it must already be owned JSON: no accessor invocation,
  // no proxy traps, no cycles, bounded depth/size (ownJson enforces the
  // same budgets the old jsonWithinBudget pass did, plus JSON semantics).
  const ingress = ownJson(json)
  if (!ingress.ok) {
    return {
      diagnostics: [diag('error', 'import', 'doc.notJson', `document rejected: ${ingress.reason}`)],
    }
  }
  const input = ingress.value
  switch (detectFormat(input)) {
    case 'litegraph-workflow':
      return {
        diagnostics: [
          diag('error', 'import', 'doc.foreign.litegraph', 'this is a legacy litegraph workflow; translate it with importLitegraph (requires the current schema registry)'),
        ],
      }
    case 'comfy-api-prompt':
      return {
        diagnostics: [
          diag('error', 'import', 'doc.foreign.apiPrompt', 'this is a Comfy API prompt (compiler output), not an authorable workflow document'),
        ],
      }
    case 'unknown':
      return {
        diagnostics: [
          diag('error', 'import', 'doc.foreign.unknown', 'not a recognizable workflow document'),
        ],
      }
    case 'dinkster-workflow':
      break
  }

  const migrated = migrateJson(
    input as JsonObject,
    opts?.migrations ?? MIGRATIONS,
    opts?.targetVersion ?? FORMAT_VERSION,
  )
  if (!migrated.doc) return { diagnostics: migrated.diagnostics }

  const canon = canonicalizeJson(migrated.doc)
  if (canon.diagnostics.some((d) => d.severity === 'error')) {
    return { diagnostics: [...migrated.diagnostics, ...canon.diagnostics] }
  }

  // The environment stamp is advisory: sanitize it warn-and-drop BEFORE
  // shape validation so a malformed stamp can never block loading and
  // never survives to mislead drift diagnostics.
  const env = sanitizeEnvironment(canon.doc['environment'])
  let docJson = canon.doc
  if (canon.doc['environment'] !== undefined) {
    const { environment: _dropped, ...rest } = canon.doc
    docJson = env.stamp !== undefined ? { ...rest, environment: env.stamp as unknown as Json } : rest
  }

  const shapeDiags = validateDocumentShape(docJson, opts?.targetVersion ?? FORMAT_VERSION)
  const diagnostics = [...migrated.diagnostics, ...canon.diagnostics, ...env.diagnostics, ...shapeDiags]
  if (shapeDiags.some((d) => d.severity === 'error')) return { diagnostics }

  const document = docJson as unknown as WorkflowDocument
  const invariantDiags = checkDocument(document)
  const all = [...diagnostics, ...invariantDiags]
  if (invariantDiags.some((d) => d.severity === 'error')) return { diagnostics: all }
  // Ownership (CO1): the returned document is a deep-frozen copy detached
  // from the caller's JSON - consumers (blueprint caches, stores) share it
  // freely. canonicalizeJson clones lazily, so without this an unchanged
  // canonical input would be returned by reference.
  const owned = ownJson(docJson)
  if (!owned.ok) {
    // Unreachable after shape validation; keep it a diagnostic, not a throw.
    return { diagnostics: [...all, diag('error', 'import', 'doc.notJson', `document rejected: ${owned.reason}`)] }
  }
  return { document: owned.value as unknown as WorkflowDocument, diagnostics: all }
}
