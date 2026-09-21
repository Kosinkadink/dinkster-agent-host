import type { JsonObject } from '../format/document.js'
import type { OutputDescriptorsSpec } from './model.js'

export interface OutputDescriptorEntry extends JsonObject {
  readonly id: string
  readonly name: string
  readonly type: string
}

export interface OutputDescriptorDocument extends JsonObject {
  readonly entries: readonly OutputDescriptorEntry[]
}

export type OutputDescriptorResult =
  | { readonly ok: true; readonly document: OutputDescriptorDocument }
  | { readonly ok: false; readonly error: string }

export function outputDescriptorValueOf(spec: OutputDescriptorsSpec, values: Readonly<Record<string, unknown>>): unknown {
  return spec.boundaryProjection?.fixed ? spec.boundaryProjection.fallback
    : Object.hasOwn(values, spec.input) ? values[spec.input] : spec.boundaryProjection?.fallback
}

export function outputDescriptorAssetOf(spec: OutputDescriptorsSpec, values: Readonly<Record<string, unknown>>): unknown {
  return spec.boundaryProjection?.assetFixed ? spec.boundaryProjection.assetFallback
    : spec.probe && Object.hasOwn(values, spec.probe.input) ? values[spec.probe.input] : spec.boundaryProjection?.assetFallback
}

export function outputDescriptorAssetDigest(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const digest = (value as Record<string, unknown>)['digest']
  return typeof digest === 'string' && /^blake3:[0-9a-f]{64}$/.test(digest) ? digest : undefined
}

/** Validate without rewriting node-owned document or entry fields. */
export function parseOutputDescriptors(
  spec: OutputDescriptorsSpec,
  value: unknown,
  asset?: unknown,
): OutputDescriptorResult {
  const fail = (error: string): OutputDescriptorResult => ({ ok: false, error })
  if (typeof value !== 'string') return fail('Output descriptors must be a stored JSON string.')
  if (new TextEncoder().encode(value).length > 1048576) return fail('Output descriptors exceed 1048576 UTF-8 bytes.')
  let document: unknown
  try { document = JSON.parse(value) } catch { return fail('Output descriptors must contain valid JSON.') }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return fail('Output descriptors must be an object with entries.')
  const raw = document as Record<string, unknown>
  const entries = raw['entries']
  if (!Array.isArray(entries) || entries.length > 512 || entries.length < spec.minEntries || entries.length > spec.maxEntries) {
    return fail(`Output descriptors require ${spec.minEntries}..${spec.maxEntries} entries (at most 512).`)
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return fail('Each output descriptor must be an object.')
    const { id, name, type } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) return fail('Output IDs must be unique and match [A-Za-z0-9_-]+.')
    if (typeof name !== 'string' || name.trim() === '' || [...name].length > 256 || name.includes('\0') || names.has(name)) return fail('Output names must be unique, nonblank, at most 256 characters, and contain no NUL.')
    if (typeof type !== 'string' || !spec.choices.some((choice) => choice.id === type)) return fail(`Output '${id}' must select a declared concrete type.`)
    if (spec.fixedIds && id !== type) return fail('This schema requires output IDs to equal their type choice IDs.')
    ids.add(id)
    names.add(name)
  }
  if (spec.probe) {
    const digest = outputDescriptorAssetDigest(asset)
    if (digest === undefined || raw['assetDigest'] !== digest || raw['detectorRevision'] !== spec.probe.revision) {
      return fail('Output profile is stale. Probe the current asset before connecting or compiling.')
    }
  }
  return { ok: true, document: document as OutputDescriptorDocument }
}
