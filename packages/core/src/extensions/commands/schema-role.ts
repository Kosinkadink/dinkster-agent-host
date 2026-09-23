import type { WorkflowDocument } from '../../format/document.js'
import type { NodeSchema } from '../../schema/model.js'
import type { SchemaResolver } from '../../schema/derive-boundary.js'
import type { CommandExecutionContext } from '../../commands/contract.js'
import { schemaResolverForCommand } from '../../commands/command-support.js'

export interface CommandSchemaRole {
  readonly role: string
  readonly fallbackNodeId: string
}

export function schemaForCommandRole(
  doc: WorkflowDocument,
  registration: CommandSchemaRole,
  context: CommandExecutionContext,
  resolve?: SchemaResolver,
): NodeSchema | undefined {
  const resolver = schemaResolverForCommand(doc, context, resolve)
  if (resolver === undefined) return undefined
  return resolver.forEditorRole === undefined ? resolver(registration.fallbackNodeId) : resolver.forEditorRole(registration.role)
}

export function nodeHasCommandRole(
  doc: WorkflowDocument,
  nodeType: string,
  registration: CommandSchemaRole,
  context: CommandExecutionContext,
  resolve?: SchemaResolver,
): boolean {
  const resolver = schemaResolverForCommand(doc, context, resolve)
  if (resolver === undefined) return nodeType === registration.fallbackNodeId
  return schemaForCommandRole(doc, registration, context, resolver)?.type === nodeType
}
