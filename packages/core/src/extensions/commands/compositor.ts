import { compositorRecipeFingerprint, copyCompositorRecipe, isCompositorRecipe } from '../../compositor.js'
import type { GraphDef, Json, WorkflowDocument } from '../../format/document.js'
import { asNodeId, asPortId, sameEndpoint, samePortRef } from '../../ids.js'
import { subgraphDefIdOf } from '../../invariants.js'
import { canonicalTypeIdOf, type NodeSchema } from '../../schema/model.js'
import { effectiveOccurrenceTopology, effectiveTopologyDrivesPort } from '../../compile/effective-topology.js'
import { commandError, isCommandObject, schemaResolverForCommand } from '../../commands/command-support.js'
import type { CommandDefinition } from '../../commands/contract.js'
import type { RegisteredCommandExtension } from './registry.js'
import { nodeHasCommandRole, type CommandSchemaRole } from './schema-role.js'

// NodeSchema.editorRole is authoritative; this id supports schemas without that field.
const COMPOSITOR_ROLE: CommandSchemaRole = {
  role: 'compositor',
  fallbackNodeId: 'CreateLayeredImage',
}

const contextResolves = (doc: WorkflowDocument, graphId: string, instancePath: readonly string[]): boolean => {
  let graph: GraphDef | undefined = doc.graphs[doc.root]
  for (const nodeId of instancePath) {
    const node = graph?.nodes[nodeId]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    graph = childId === undefined ? undefined : doc.graphs[childId]
    if (graph === undefined) return false
  }
  return graph?.id === graphId
}

function imageCompositorApplyOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.compositorApply',
    run(doc, params, tx, context) {
      if (
        !isCommandObject(params) ||
        Object.keys(params).length !== 6 ||
        typeof params.graphId !== 'string' ||
        typeof params.nodeId !== 'string' ||
        typeof params.inputId !== 'string' ||
        !Array.isArray(params.instancePath) ||
        !params.instancePath.every((nodeId) => typeof nodeId === 'string') ||
        typeof params.expectedRecipeFingerprint !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(params.expectedRecipeFingerprint) ||
        !isCompositorRecipe(params.recipe)
      ) {
        return [
          commandError(
            'params.invalid',
            'image.compositorApply: params must be {graphId,nodeId,inputId,instancePath,expectedRecipeFingerprint,recipe}',
          ),
        ]
      }
      if (!contextResolves(doc, params.graphId, params.instancePath)) {
        return [
          commandError(
            'image.compositorContextInvalid',
            `image.compositorApply: instance path does not resolve to graph '${params.graphId}'`,
          ),
        ]
      }
      const instancePath = params.instancePath as string[]
      const def = doc.graphs[params.graphId]
      const node = def?.nodes[params.nodeId]
      if (!def) return [commandError('graph.missing', `image.compositorApply: unknown graph '${params.graphId}'`)]
      if (!node) return [commandError('node.missing', `image.compositorApply: unknown node '${params.nodeId}'`)]
      if (subgraphDefIdOf(node.type) !== undefined) {
        return [
          commandError(
            'image.compositorInputInvalid',
            'image.compositorApply: promoted subgraph inputs are not writable compositor targets',
          ),
        ]
      }
      const resolver = schemaResolverForCommand(doc, context, resolve)
      if (!resolver) return [commandError('schema.missing', `image.compositorApply: no schema resolver for '${node.type}'`)]
      const schema = resolver(node.type)
      if (!schema) return [commandError('schema.missing', `image.compositorApply: no schema for '${node.type}'`)]
      if (!nodeHasCommandRole(doc, node.type, COMPOSITOR_ROLE, context, resolve)) {
        return [commandError('image.compositorInputInvalid', 'image.compositorApply: target node does not own the compositor role')]
      }
      const input = schema.items.find((item) => item.kind === 'input' && item.id === params.inputId)
      if (input?.kind !== 'input' || input.widget?.widgetType !== 'COMPOSITOR' || canonicalTypeIdOf(input.type) !== 'dinkster.compositor') {
        return [
          commandError(
            'image.compositorInputInvalid',
            `image.compositorApply: '${params.inputId}' is not a writable dinkster.compositor input`,
          ),
        ]
      }
      const endpoint = {
        node: asNodeId(params.nodeId),
        port: asPortId(params.inputId),
      }
      const definitionDriven =
        Object.values(def.links).some((link) => sameEndpoint(link.to, endpoint)) ||
        Object.values(def.nets).some((net) => net.sinks.some((sink) => samePortRef(sink, endpoint)))
      let occurrenceDriven = false
      if (instancePath.length > 0) {
        const owner = {
          instancePath: instancePath.slice(0, -1).map(asNodeId),
          node: asNodeId(instancePath.at(-1)!),
        }
        const effective = effectiveOccurrenceTopology(doc, resolver, owner)
        if (effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          return [commandError('image.compositorContextInvalid', 'image.compositorApply: selected occurrence topology is invalid')]
        }
        occurrenceDriven = effectiveTopologyDrivesPort(effective, def.id, instancePath.map(asNodeId), endpoint)
      }
      if (definitionDriven || occurrenceDriven) {
        return [commandError('image.compositorInputDriven', `image.compositorApply: '${params.inputId}' is driven`)]
      }
      const current = node.values[params.inputId]
      const fingerprint = compositorRecipeFingerprint(current)
      if (fingerprint === undefined) {
        return [commandError('image.compositorRecipeInvalid', `image.compositorApply: '${params.inputId}' contains an invalid recipe`)]
      }
      if (fingerprint !== params.expectedRecipeFingerprint) {
        return [commandError('image.compositorRecipeChanged', `image.compositorApply: recipe '${params.inputId}' changed during editing`)]
      }
      tx.set(
        ['graphs', params.graphId, 'nodes', params.nodeId, 'values', params.inputId],
        copyCompositorRecipe(params.recipe) as unknown as Json,
      )
      return []
    },
  }
}

export const COMPOSITOR_COMMAND_EXTENSION: RegisteredCommandExtension = {
  id: 'builtin.compositor',
  schemaRoles: [COMPOSITOR_ROLE],
  commands: (resolve) => [imageCompositorApplyOf(resolve)],
}
