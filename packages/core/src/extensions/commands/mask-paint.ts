import { parseMaskPaintRecipe } from '../../mask-paint-recipe.js'
import { canonicalTypeIdOf, inputsOf, outputsOf, type NodeSchema } from '../../schema/model.js'
import type { Json } from '../../format/document.js'
import type { NodeData } from '../../format/document.js'
import { asNodeId, asPortId, sameEndpoint, samePortRef } from '../../ids.js'
import { allocateOne } from '../../commands/alloc.js'
import {
  commandError,
  commandSchemaOf,
  ensureCommandViewGraph,
  isCommandObject,
  isCompleteAssetRef,
} from '../../commands/command-support.js'
import type { CommandDefinition } from '../../commands/contract.js'
import type { RegisteredCommandExtension } from './registry.js'
import { nodeHasCommandRole, schemaForCommandRole, type CommandSchemaRole } from './schema-role.js'

// NodeSchema.editorRole is authoritative; these ids support schemas without that field.
const IMAGE_SOURCE_ROLE: CommandSchemaRole = {
  role: 'image-source',
  fallbackNodeId: 'dinkster.load_image',
}
const MASK_PAINT_ROLE: CommandSchemaRole = {
  role: 'mask-paint',
  fallbackNodeId: 'dinkster.mask.paint',
}

export const MASK_PAINT_SOURCE_EXT_KEY = 'dinkster.imageEditor.maskPaintSource'

export function maskPaintSourceNodeId(node: NodeData): string | undefined {
  const marker = node.ext?.[MASK_PAINT_SOURCE_EXT_KEY]
  return isCommandObject(marker) && Object.keys(marker).length === 2 && typeof marker.nodeId === 'string' && marker.outputId === 'mask'
    ? marker.nodeId
    : undefined
}

const sameAssetRef = (left: Json | undefined, right: Json | undefined): boolean =>
  isCompleteAssetRef(left) &&
  isCompleteAssetRef(right) &&
  left.digest === right.digest &&
  left.name === right.name &&
  left.size === right.size &&
  left.mediaType === right.mediaType &&
  left.virtualPath === right.virtualPath

const sortedStringList = (value: Json | undefined): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length) return undefined
  return [...value].sort() as string[]
}

function maskPaintRecipeHeader(value: string): { readonly sourceDigest: string } | undefined {
  const recipe = parseMaskPaintRecipe(value)
  return recipe ? { sourceDigest: recipe.sourceDigest } : undefined
}

function imageApplyMaskPaintOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.applyMaskPaint',
    run(doc, params, tx, context) {
      if (
        !isCommandObject(params) ||
        Object.keys(params).length !== 9 ||
        typeof params.graphId !== 'string' ||
        typeof params.loaderNodeId !== 'string' ||
        params.inputId !== 'image' ||
        !isCompleteAssetRef(params.expectedSource) ||
        typeof params.operations !== 'string' ||
        (params.paintNodeId !== null && typeof params.paintNodeId !== 'string') ||
        (params.expectedPaintOperations !== null && typeof params.expectedPaintOperations !== 'string')
      ) {
        return [commandError('params.invalid', 'image.applyMaskPaint: malformed guarded paint transaction')]
      }
      const expectedLinks = sortedStringList(params.expectedMaskLinkIds)
      const expectedNets = sortedStringList(params.expectedMaskNetIds)
      if (!expectedLinks || !expectedNets) {
        return [commandError('params.invalid', 'image.applyMaskPaint: mask topology ids must be unique string arrays')]
      }
      const graph = doc.graphs[params.graphId]
      const loader = graph?.nodes[params.loaderNodeId]
      if (!graph || !loader) return [commandError('image.maskTargetMissing', 'The mask source node no longer exists')]
      if (Object.values(doc.occurrenceTopologies ?? {}).some((topology) => topology.bodyGraph === params.graphId)) {
        return [commandError('image.maskOccurrenceUnsupported', 'Mask paint does not support occurrence-local topology')]
      }
      if (!nodeHasCommandRole(doc, loader.type, IMAGE_SOURCE_ROLE, context, resolve)) {
        return [commandError('image.maskTargetInvalid', 'Mask paint requires an image-source node')]
      }
      const loaderSchema = commandSchemaOf(doc, loader.type, context, resolve)
      const paintSchema = schemaForCommandRole(doc, MASK_PAINT_ROLE, context, resolve)
      const loaderImage = loaderSchema && inputsOf(loaderSchema).find((input) => input.id === 'image')
      const loaderOutputs = loaderSchema ? outputsOf(loaderSchema) : []
      const paintInputs = paintSchema ? inputsOf(paintSchema) : []
      const paintOutputs = paintSchema ? outputsOf(paintSchema) : []
      if (
        !paintSchema ||
        !loaderImage ||
        canonicalTypeIdOf(loaderImage.type) !== 'asset<dinkster.image>' ||
        canonicalTypeIdOf(
          loaderOutputs.find((output) => output.id === 'image')?.type ?? {
            kind: 'wildcard',
          },
        ) !== 'dinkster.image' ||
        canonicalTypeIdOf(
          loaderOutputs.find((output) => output.id === 'mask')?.type ?? {
            kind: 'wildcard',
          },
        ) !== 'dinkster.mask' ||
        canonicalTypeIdOf(
          paintInputs.find((input) => input.id === 'source')?.type ?? {
            kind: 'wildcard',
          },
        ) !== 'asset<dinkster.image>' ||
        canonicalTypeIdOf(
          paintInputs.find((input) => input.id === 'operations')?.type ?? {
            kind: 'wildcard',
          },
        ) !== 'core.string' ||
        paintInputs.find((input) => input.id === 'operations')?.widget?.widgetType !== 'STRING' ||
        paintInputs.find((input) => input.id === 'operations')?.widget?.options.multiline !== true ||
        canonicalTypeIdOf(
          paintOutputs.find((output) => output.id === 'mask')?.type ?? {
            kind: 'wildcard',
          },
        ) !== 'dinkster.mask'
      ) {
        return [commandError('image.maskSchemaMissing', 'The backend does not expose the required mask paint schemas')]
      }
      if (!sameAssetRef(loader.values.image, params.expectedSource)) {
        return [commandError('image.sourceChanged', 'The loader source changed during editing')]
      }
      const recipe = maskPaintRecipeHeader(params.operations)
      if (!recipe || recipe.sourceDigest !== params.expectedSource.digest) {
        return [commandError('image.maskRecipeInvalid', 'Mask operations do not match the loader source')]
      }
      const source = {
        node: asNodeId(params.loaderNodeId),
        port: asPortId('mask'),
      }
      const currentLinks = Object.values(graph.links)
        .filter((link) => sameEndpoint(link.from, source))
        .map((link) => link.id)
        .sort()
      const currentNets = Object.values(graph.nets)
        .filter((net) => samePortRef(net.source, source))
        .map((net) => net.id)
        .sort()
      if (currentLinks.join('\0') !== expectedLinks.join('\0') || currentNets.join('\0') !== expectedNets.join('\0')) {
        return [commandError('image.maskTopologyChanged', 'The loader mask topology changed during editing')]
      }
      let paintNodeId = params.paintNodeId as string | null
      const associatedPaintIds = Object.values(graph.nodes)
        .filter(
          (node) =>
            nodeHasCommandRole(doc, node.type, MASK_PAINT_ROLE, context, resolve) && maskPaintSourceNodeId(node) === params.loaderNodeId,
        )
        .map((node) => node.id)
      if (
        (paintNodeId === null && associatedPaintIds.length !== 0) ||
        (paintNodeId !== null && (associatedPaintIds.length !== 1 || associatedPaintIds[0] !== paintNodeId))
      ) {
        return [commandError('image.maskPaintChanged', 'The associated mask paint topology changed during editing')]
      }
      if (paintNodeId === null) {
        paintNodeId = allocateOne(tx, params.graphId, graph, 'n')
        tx.set(['graphs', params.graphId, 'nodes', paintNodeId], {
          id: paintNodeId,
          type: paintSchema.type,
          values: {
            source: params.expectedSource,
            operations: params.operations,
          },
          ext: {
            [MASK_PAINT_SOURCE_EXT_KEY]: {
              nodeId: params.loaderNodeId,
              outputId: 'mask',
            },
          },
        })
        const position = doc.view.graphs[params.graphId]?.nodes?.[params.loaderNodeId]?.position ?? { x: 0, y: 0 }
        ensureCommandViewGraph(tx, params.graphId)
        tx.set(['view', 'graphs', params.graphId, 'nodes', paintNodeId], {
          position: { x: position.x + 280, y: position.y + 120 },
        })
      } else {
        const paint = graph.nodes[paintNodeId]
        if (
          !paint ||
          !nodeHasCommandRole(doc, paint.type, MASK_PAINT_ROLE, context, resolve) ||
          maskPaintSourceNodeId(paint) !== params.loaderNodeId ||
          !sameAssetRef(paint.values.source, params.expectedSource) ||
          paint.values.operations !== params.expectedPaintOperations
        ) {
          return [commandError('image.maskPaintChanged', 'The associated mask paint node changed during editing')]
        }
        tx.set(['graphs', params.graphId, 'nodes', paintNodeId, 'values', 'operations'], params.operations)
      }
      const replacement = {
        node: asNodeId(paintNodeId),
        port: asPortId('mask'),
      }
      for (const linkId of expectedLinks) tx.set(['graphs', params.graphId, 'links', linkId, 'from'], replacement)
      for (const netId of expectedNets) tx.set(['graphs', params.graphId, 'nets', netId, 'source'], replacement)
      return []
    },
  }
}

export const MASK_PAINT_COMMAND_EXTENSION: RegisteredCommandExtension = {
  id: 'builtin.mask-paint',
  schemaRoles: [IMAGE_SOURCE_ROLE, MASK_PAINT_ROLE],
  commands: (resolve) => [imageApplyMaskPaintOf(resolve)],
}
