import { diag, type Diagnostic, type DiagnosticRef } from '../diagnostics.js'
import type { Json, JsonObject, WorkflowDocument } from '../format/document.js'
import type { NodeSchema } from '../schema/model.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type { CommandExecutionContext, TransactionBuilder } from './contract.js'

export const commandError = (code: string, message: string, refs?: readonly DiagnosticRef[]): Diagnostic =>
  diag('error', 'command', code, message, refs === undefined ? undefined : { refs })

export const isCommandObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isCompleteAssetRef = (
  value: Json | undefined,
): value is JsonObject & {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
} => {
  if (!isCommandObject(value) || Object.keys(value).length !== 5) return false
  return (
    /^blake3:[0-9a-f]{64}$/.test(typeof value.digest === 'string' ? value.digest : '') &&
    typeof value.name === 'string' &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mediaType === 'string' &&
    typeof value.virtualPath === 'string'
  )
}

export const schemaResolverForCommand = (
  doc: WorkflowDocument,
  context: CommandExecutionContext,
  resolve?: SchemaResolver,
): SchemaResolver | undefined => {
  if (context.kind !== 'initial') return resolve
  const live = context.schemaResolverFor?.(doc)
  if (live === undefined) return resolve
  if (resolve === undefined) return live
  const forEditorRole = live.forEditorRole ?? resolve.forEditorRole
  return Object.assign((nodeType: string) => live(nodeType) ?? resolve(nodeType), forEditorRole === undefined ? {} : { forEditorRole })
}

export const commandSchemaOf = (
  doc: WorkflowDocument,
  nodeType: string,
  context: CommandExecutionContext,
  resolve?: SchemaResolver,
): NodeSchema | undefined => schemaResolverForCommand(doc, context, resolve)?.(nodeType)

export function ensureCommandViewGraph(tx: TransactionBuilder, graphId: string): void {
  if (!tx.current.view.graphs[graphId]) {
    tx.set(['view', 'graphs', graphId], { nodes: {} })
  }
}
