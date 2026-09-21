import type { CommandInvocation } from './commands/contract.js'
import { jsonSameValue } from './commands/store.js'
import type { Json, JsonObject, WorkflowDocument } from './format/document.js'

export type AssetRef = JsonObject & {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

/**
 * Frontend planner carrier using the fixture codec's PROVISIONAL envelope
 * field spelling. The planner behavior is frontend-owned; the envelope's
 * atomic/precondition/pointer/token semantics are frozen.
 */
export interface AssetRefRepairSuggestion {
  readonly type: 'asset-ref-repair'
  readonly version: 1
  readonly atomic: true
  readonly documentDigest: string
  readonly preconditions: readonly { readonly pointer: string; readonly equals: AssetRef }[]
  readonly replacements: readonly { readonly pointer: string; readonly value: AssetRef }[]
}

export type AssetRefRepairRejectionCode =
  | 'document-digest-mismatch'
  | 'empty-repair'
  | 'invalid-pointer'
  | 'overlapping-targets'
  | 'precondition-target-mismatch'
  | 'target-missing'
  | 'current-value-invalid'
  | 'stale-precondition'
  | 'no-op-repair'

export type AssetRefRepairPlan =
  | { readonly ok: true; readonly invocation: CommandInvocation }
  | { readonly ok: false; readonly code: AssetRefRepairRejectionCode; readonly pointer?: string }

export function decodeRfc6901Pointer(pointer: string): readonly string[] | undefined {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return undefined
  const segments: string[] = []
  for (const encoded of pointer.slice(1).split('/')) {
    let segment = ''
    for (let index = 0; index < encoded.length; index++) {
      const char = encoded[index]!
      if (char !== '~') {
        segment += char
        continue
      }
      const escaped = encoded[++index]
      if (escaped === '0') segment += '~'
      else if (escaped === '1') segment += '/'
      else return undefined
    }
    segments.push(segment)
  }
  return segments
}

const isAssetRef = (value: unknown): value is AssetRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ref = value as Record<string, unknown>
  return Object.keys(ref).length === 5 &&
    ['digest', 'name', 'size', 'mediaType', 'virtualPath'].every((key) => Object.hasOwn(ref, key)) &&
    typeof ref['digest'] === 'string' && /^blake3:[0-9a-f]{64}$/.test(ref['digest']) &&
    typeof ref['name'] === 'string' &&
    typeof ref['size'] === 'number' && Number.isSafeInteger(ref['size']) && ref['size'] >= 0 &&
    typeof ref['mediaType'] === 'string' &&
    typeof ref['virtualPath'] === 'string'
}

interface WidgetTarget {
  readonly pointer: string
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly index?: number
}

const widgetTarget = (pointer: string): WidgetTarget | undefined => {
  const parts = decodeRfc6901Pointer(pointer)
  if (parts === undefined || (parts.length !== 6 && parts.length !== 7)) return undefined
  if (parts[0] !== 'graphs' || parts[2] !== 'nodes' || parts[4] !== 'values') return undefined
  if (parts[1] === '' || parts[3] === '' || parts[5] === '') return undefined
  if (parts.length === 6) return { pointer, graphId: parts[1]!, nodeId: parts[3]!, inputId: parts[5]! }
  const rawIndex = parts[6]!
  if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)) return undefined
  const index = Number(rawIndex)
  if (!Number.isSafeInteger(index)) return undefined
  return { pointer, graphId: parts[1]!, nodeId: parts[3]!, inputId: parts[5]!, index }
}

const overlaps = (left: readonly string[], right: readonly string[]): boolean => {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index++) if (left[index] !== right[index]) return false
  return true
}

const currentAt = (doc: WorkflowDocument, target: WidgetTarget): Json | undefined => {
  if (!Object.hasOwn(doc.graphs, target.graphId)) return undefined
  const graph = doc.graphs[target.graphId]!
  if (!Object.hasOwn(graph.nodes, target.nodeId)) return undefined
  const node = graph.nodes[target.nodeId]!
  if (!Object.hasOwn(node.values, target.inputId)) return undefined
  const value = node.values[target.inputId]
  if (target.index === undefined) return value
  return Array.isArray(value) && Object.hasOwn(value, target.index) ? value[target.index] : undefined
}

/**
 * Validate an untrusted atomic repair against the current document and plan
 * one flat batch. The planner is pure; callers dispatch only an ok result.
 */
export function planAssetRefRepair(
  suggestion: AssetRefRepairSuggestion,
  suppliedDocumentDigest: string,
  document: WorkflowDocument,
): AssetRefRepairPlan {
  if (suggestion.documentDigest !== suppliedDocumentDigest) return { ok: false, code: 'document-digest-mismatch' }
  if (suggestion.preconditions.length === 0 || suggestion.replacements.length === 0) return { ok: false, code: 'empty-repair' }

  const replacementParts = suggestion.replacements.map((entry) => decodeRfc6901Pointer(entry.pointer))
  if (replacementParts.some((parts) => parts === undefined)) return { ok: false, code: 'invalid-pointer' }
  for (let left = 0; left < replacementParts.length; left++) {
    for (let right = left + 1; right < replacementParts.length; right++) {
      if (overlaps(replacementParts[left]!, replacementParts[right]!)) return { ok: false, code: 'overlapping-targets' }
    }
  }

  const preconditionPointers = new Set(suggestion.preconditions.map((entry) => entry.pointer))
  const replacementPointers = new Set(suggestion.replacements.map((entry) => entry.pointer))
  if (preconditionPointers.size !== suggestion.preconditions.length || replacementPointers.size !== suggestion.replacements.length)
    return { ok: false, code: 'overlapping-targets' }
  if (preconditionPointers.size !== replacementPointers.size || [...preconditionPointers].some((pointer) => !replacementPointers.has(pointer)))
    return { ok: false, code: 'precondition-target-mismatch' }

  for (const entry of suggestion.preconditions) {
    const target = widgetTarget(entry.pointer)
    if (target === undefined) return { ok: false, code: 'invalid-pointer', pointer: entry.pointer }
    const graph = Object.hasOwn(document.graphs, target.graphId) ? document.graphs[target.graphId] : undefined
    const node = graph !== undefined && Object.hasOwn(graph.nodes, target.nodeId) ? graph.nodes[target.nodeId] : undefined
    const widgetValue = node?.values[target.inputId]
    if (node === undefined || !Object.hasOwn(node.values, target.inputId) ||
      (target.index !== undefined && (!Array.isArray(widgetValue) || !Object.hasOwn(widgetValue, target.index))))
      return { ok: false, code: 'target-missing', pointer: entry.pointer }
    const current = currentAt(document, target)
    if (!isAssetRef(current)) return { ok: false, code: 'current-value-invalid', pointer: entry.pointer }
    if (!isAssetRef(entry.equals) || !jsonSameValue(current, entry.equals))
      return { ok: false, code: 'stale-precondition', pointer: entry.pointer }
  }

  const writes = new Map<string, { graphId: string; nodeId: string; values: Record<string, Json> }>()
  for (const entry of suggestion.replacements) {
    const target = widgetTarget(entry.pointer)
    if (target === undefined || !isAssetRef(entry.value)) return { ok: false, code: 'invalid-pointer', pointer: entry.pointer }
    const key = JSON.stringify([target.graphId, target.nodeId])
    let write = writes.get(key)
    if (write === undefined) {
      write = { graphId: target.graphId, nodeId: target.nodeId, values: Object.create(null) as Record<string, Json> }
      writes.set(key, write)
    }
    if (target.index === undefined) write.values[target.inputId] = entry.value
    else {
      const previous = Object.hasOwn(write.values, target.inputId)
        ? write.values[target.inputId]
        : document.graphs[target.graphId]!.nodes[target.nodeId]!.values[target.inputId]
      if (!Array.isArray(previous)) return { ok: false, code: 'current-value-invalid', pointer: entry.pointer }
      const next = [...previous]
      next[target.index] = entry.value
      write.values[target.inputId] = next
    }
  }

  const changes = [...writes.values()].some((write) => Object.entries(write.values).some(([inputId, value]) =>
    !jsonSameValue(document.graphs[write.graphId]!.nodes[write.nodeId]!.values[inputId], value)))
  if (!changes) return { ok: false, code: 'no-op-repair' }

  return {
    ok: true,
    invocation: {
      command: 'batch',
      params: {
        invocations: [...writes.values()].map((write) => ({
          command: 'node.setValues',
          params: { graphId: write.graphId, nodeId: write.nodeId, values: write.values },
        })),
      },
    },
  }
}
