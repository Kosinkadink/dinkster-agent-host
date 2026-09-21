/**
 * Exposed parameters (platform-plan 2.4): a document-declared, ordered
 * subset of widget inputs promoted as the workflow's PUBLIC CONTROLS. This
 * is what turns any workflow into an app: alternative views (the form-style
 * app view first) render exactly this list, over the same document +
 * commands + execution substrate as the graph editor.
 *
 * Storage is document data, not a separate app-manifest format: the list
 * lives under the root namespaced extension escape hatch
 * (`doc.ext['dinkster.exposed']`), so it serializes, undoes, and syncs with the
 * workflow like everything else and requires no format-version bump. The
 * `dinkster.` namespace marks it core-owned.
 *
 * Entry identity is (graphId, nodeId, inputId) where `inputId` is the
 * ELABORATED input id (`ElaboratedInput.spec.id` / LayoutRow.inputId - the
 * same identity widget menu targets carry). Views resolve it back through
 * elaborateInterface at render time and write through valueKeyOf (hazard
 * N6); an entry whose node/graph/input no longer resolves is STALE - views
 * must render it inert (with a remove affordance), never drop it silently.
 *
 * Reading is tolerant by design: a malformed entry (wrong shape, missing
 * ids) is skipped, never a document error - the ext escape hatch is
 * advisory data, and a foreign or future shape must not brick editing.
 * Writing goes exclusively through the params.* commands
 * (commands/exposed-commands.ts), which always write the canonical shape.
 */

import type { Json, JsonObject, WorkflowDocument } from './document.js'

/** Root `ext` key the exposed-parameter list persists under. */
export const EXPOSED_EXT_KEY = 'dinkster.exposed'

export interface ExposedParameter {
  readonly graphId: string
  readonly nodeId: string
  /** Elaborated input id (LayoutRow.inputId / ElaboratedInput.spec.id). */
  readonly inputId: string
  /** Display label override; absent = the input's own display name. */
  readonly label?: string
}

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parses one raw ext-list element; undefined when the shape is invalid. */
export const parseExposedEntry = (v: Json): ExposedParameter | undefined => {
  if (!isObj(v)) return undefined
  const { graphId, nodeId, inputId, label } = v
  if (typeof graphId !== 'string' || graphId.length === 0) return undefined
  if (typeof nodeId !== 'string' || nodeId.length === 0) return undefined
  if (typeof inputId !== 'string' || inputId.length === 0) return undefined
  return {
    graphId,
    nodeId,
    inputId,
    ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
  }
}

/**
 * The document's exposed parameters, in declared order. Malformed entries
 * and duplicates (same triple; first occurrence wins) are skipped.
 */
export function exposedParameters(doc: WorkflowDocument): readonly ExposedParameter[] {
  const raw = doc.ext?.[EXPOSED_EXT_KEY]
  if (!Array.isArray(raw)) return []
  const out: ExposedParameter[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const entry = parseExposedEntry(item)
    if (!entry) continue
    const key = exposedKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * Canonical identity key for an exposed entry. JSON-encoded triple, NOT a
 * separator join: document/schema ids are arbitrary non-empty strings (the
 * subgraph crossing machinery even mints '\u0000'-prefixed ids on purpose),
 * so no in-band separator is injective. Distinct triples MUST map to
 * distinct keys or unexpose/rename/move hit the wrong entry.
 */
export const exposedKey = (e: Pick<ExposedParameter, 'graphId' | 'nodeId' | 'inputId'>): string =>
  JSON.stringify([e.graphId, e.nodeId, e.inputId])

export function isExposed(
  doc: WorkflowDocument,
  graphId: string,
  nodeId: string,
  inputId: string,
): boolean {
  const key = exposedKey({ graphId, nodeId, inputId })
  return exposedParameters(doc).some((e) => exposedKey(e) === key)
}

/** Canonical Json form the params.* commands persist (label present iff set). */
export const exposedToJson = (entries: readonly ExposedParameter[]): Json =>
  entries.map((e) => ({
    graphId: e.graphId,
    nodeId: e.nodeId,
    inputId: e.inputId,
    ...(e.label !== undefined ? { label: e.label } : {}),
  }))
