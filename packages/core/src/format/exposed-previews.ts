import type { Json, JsonObject, WorkflowDocument } from './document.js'

/** Root `ext` key for the ordered App view preview-surface list. */
export const EXPOSED_PREVIEWS_EXT_KEY = 'dinkster.exposedPreviews'

/** A node preview surface promoted into App view. */
export interface ExposedPreview {
  readonly graphId: string
  readonly nodeId: string
  /** Display label override; absent uses the node title or schema name. */
  readonly label?: string
}

const isObj = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Parses one entry without making malformed extension data a document error. */
export function parseExposedPreviewEntry(value: Json): ExposedPreview | undefined {
  if (!isObj(value)) return undefined
  const { graphId, nodeId, label } = value
  if (typeof graphId !== 'string' || graphId.length === 0) return undefined
  if (typeof nodeId !== 'string' || nodeId.length === 0) return undefined
  return {
    graphId,
    nodeId,
    ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
  }
}

export const exposedPreviewKey = (entry: Pick<ExposedPreview, 'graphId' | 'nodeId'>): string =>
  JSON.stringify([entry.graphId, entry.nodeId])

/** Ordered canonical preview entries; malformed entries and later duplicates are skipped. */
export function exposedPreviews(doc: WorkflowDocument): readonly ExposedPreview[] {
  const raw = doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]
  if (!Array.isArray(raw)) return []
  const entries: ExposedPreview[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const entry = parseExposedPreviewEntry(value)
    if (entry === undefined) continue
    const key = exposedPreviewKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

export function isPreviewExposed(doc: WorkflowDocument, graphId: string, nodeId: string): boolean {
  const key = exposedPreviewKey({ graphId, nodeId })
  return exposedPreviews(doc).some((entry) => exposedPreviewKey(entry) === key)
}

export const exposedPreviewsToJson = (entries: readonly ExposedPreview[]): Json =>
  entries.map((entry) => ({
    graphId: entry.graphId,
    nodeId: entry.nodeId,
    ...(entry.label === undefined ? {} : { label: entry.label }),
  }))
