import { canonicalJson, sha256Hex } from '../../compile/hash.js'
import {
  IMAGE_BLEND_MODES,
  IMAGE_MASK_COMBINE_MODES,
  IMAGE_OPACITY_MAX,
  MAX_IMAGE_CANVAS_DIMENSION,
  MAX_IMAGE_LINEAR_COMPONENT,
  MAX_IMAGE_TRANSLATION,
} from '../../image-document/model.js'
import type { Json, JsonObject } from '../../format/document.js'
import { canonicalTypeIdOf, type NodeSchema } from '../../schema/model.js'
import { normalizedComboOptions } from '../../schema/combo-options.js'
import { graphAllocator } from '../../commands/alloc.js'
import {
  commandError,
  commandSchemaOf,
  ensureCommandViewGraph,
  isCommandObject,
  isCompleteAssetRef,
} from '../../commands/command-support.js'
import type { CommandDefinition } from '../../commands/contract.js'
import type { RegisteredCommandExtension } from './registry.js'
import { schemaForCommandRole, type CommandSchemaRole } from './schema-role.js'

// NodeSchema.editorRole is authoritative; these ids support schemas without that field.
const LAYERS_LOAD_ROLE: CommandSchemaRole = {
  role: 'layers-load',
  fallbackNodeId: 'dinkster.layers.load',
}
const LAYERS_FLATTEN_ROLE: CommandSchemaRole = {
  role: 'layers-flatten',
  fallbackNodeId: 'dinkster.layers.flatten',
}
const LAYERS_EDIT_ROLE: CommandSchemaRole = {
  role: 'layers-edit',
  fallbackNodeId: 'dinkster.layers.edit',
}
const IMAGE_SAVE_ROLE: CommandSchemaRole = {
  role: 'image-save',
  fallbackNodeId: 'dinkster.save_image',
}

const isVec2 = (value: Json | undefined): value is JsonObject & { x: number; y: number } =>
  isCommandObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y)

const hasExactKeys = (value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}

const safeIntegerBetween = (value: Json | undefined, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max

const validImageTransform = (value: Json | undefined): boolean => {
  if (!isCommandObject(value) || !hasExactKeys(value, ['a', 'b', 'c', 'd', 'tx', 'ty'], ['components'])) return false
  if (
    !['a', 'b', 'c', 'd'].every((key) => safeIntegerBetween(value[key], -MAX_IMAGE_LINEAR_COMPONENT, MAX_IMAGE_LINEAR_COMPONENT)) ||
    !['tx', 'ty'].every((key) => safeIntegerBetween(value[key], -MAX_IMAGE_TRANSLATION, MAX_IMAGE_TRANSLATION))
  )
    return false
  if (value.components === undefined) return true
  const components = value.components
  if (
    !isCommandObject(components) ||
    !hasExactKeys(components, ['x', 'y', 'width', 'height', 'rotation', 'flipHorizontal', 'flipVertical', 'sourceWidth', 'sourceHeight'])
  )
    return false
  if (
    !['x', 'y', 'rotation'].every((key) => typeof components[key] === 'number' && Number.isFinite(components[key])) ||
    !['width', 'height', 'sourceWidth', 'sourceHeight'].every(
      (key) =>
        typeof components[key] === 'number' &&
        Number.isFinite(components[key]) &&
        Number(components[key]) > 0 &&
        Number(components[key]) <= MAX_IMAGE_CANVAS_DIMENSION,
    )
  )
    return false
  return typeof components.flipHorizontal === 'boolean' && typeof components.flipVertical === 'boolean'
}

const validImageRecipeChanges = (operation: 'canvas' | 'layer' | 'mask', changes: Json | undefined): boolean => {
  if (!isCommandObject(changes) || Object.keys(changes).length === 0) return false
  const validators: Record<string, (value: Json | undefined) => boolean> =
    operation === 'canvas'
      ? {
          width: (value) => safeIntegerBetween(value, 1, MAX_IMAGE_CANVAS_DIMENSION),
          height: (value) => safeIntegerBetween(value, 1, MAX_IMAGE_CANVAS_DIMENSION),
          compositing: (value) => value === 'premultiplied-alpha' || value === 'linear-premultiplied-alpha',
        }
      : operation === 'layer'
        ? {
            name: (value) => typeof value === 'string',
            visible: (value) => typeof value === 'boolean',
            opacity: (value) => safeIntegerBetween(value, 0, IMAGE_OPACITY_MAX),
            transform: validImageTransform,
            blendMode: (value) => typeof value === 'string' && (IMAGE_BLEND_MODES as readonly string[]).includes(value),
            clipping: (value) => value === 'none' || value === 'clip-to-previous',
            z_index: (value) => Number.isSafeInteger(value),
            isolation: (value) => value === 'isolated' || value === 'pass-through',
          }
        : {
            enabled: (value) => typeof value === 'boolean',
            invert: (value) => typeof value === 'boolean',
            opacity: (value) => safeIntegerBetween(value, 0, IMAGE_OPACITY_MAX),
            transform: validImageTransform,
            combineMode: (value) => typeof value === 'string' && (IMAGE_MASK_COMBINE_MODES as readonly string[]).includes(value),
            channel: (value) => value === 'alpha' || value === 'luminance',
          }
  return Object.entries(changes).every(([key, value]) => validators[key]?.(value) === true)
}

const validImageRecipeRow = (row: Json): boolean => {
  if (!isCommandObject(row) || typeof row.op !== 'string') return false
  if (row.op === 'canvas') return hasExactKeys(row, ['op', 'changes']) && validImageRecipeChanges('canvas', row.changes)
  if (row.op === 'layer' || row.op === 'mask') {
    return (
      hasExactKeys(row, ['op', 'id', 'changes']) &&
      typeof row.id === 'string' &&
      row.id.length > 0 &&
      validImageRecipeChanges(row.op, row.changes)
    )
  }
  if (row.op === 'reorder') {
    return (
      hasExactKeys(row, ['op', 'ids'], ['parent']) &&
      (row.parent === undefined || (typeof row.parent === 'string' && row.parent.length > 0)) &&
      Array.isArray(row.ids) &&
      row.ids.length > 0 &&
      row.ids.every((id) => typeof id === 'string' && id.length > 0) &&
      new Set(row.ids).size === row.ids.length
    )
  }
  return false
}

function imageDocumentExportOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.documentExport',
    run(doc, params, tx, context) {
      if (
        !isCommandObject(params) ||
        Object.keys(params).length !== 4 ||
        typeof params.graphId !== 'string' ||
        typeof params.expectedGraphFingerprint !== 'string' ||
        !isCompleteAssetRef(params.asset) ||
        params.asset.mediaType !== 'application/vnd.dinkster.image-document+json' ||
        !isVec2(params.position)
      ) {
        return [
          commandError('params.invalid', 'image.documentExport requires graphId, expectedGraphFingerprint, document asset and position'),
        ]
      }
      const graph = doc.graphs[params.graphId]
      if (!graph || sha256Hex(canonicalJson(graph)) !== params.expectedGraphFingerprint) {
        return [commandError('image.graphChanged', 'The export graph changed while the document was being uploaded')]
      }
      const load = schemaForCommandRole(doc, LAYERS_LOAD_ROLE, context, resolve)
      const flatten = schemaForCommandRole(doc, LAYERS_FLATTEN_ROLE, context, resolve)
      const input = load?.items.find((item) => item.kind === 'input' && item.id === 'document')
      const output = load?.items.find((item) => item.kind === 'output' && item.id === 'layers')
      const layers = flatten?.items.find((item) => item.kind === 'input' && item.id === 'layers')
      const selector = flatten?.items.find((item) => item.kind === 'input' && item.id === 'selector')
      if (
        !load ||
        !flatten ||
        input?.kind !== 'input' ||
        input.widget?.widgetType !== 'ASSET' ||
        canonicalTypeIdOf(input.type) !== 'dinkster.asset' ||
        output?.kind !== 'output' ||
        canonicalTypeIdOf(output.type) !== 'dinkster.layers' ||
        layers?.kind !== 'input' ||
        canonicalTypeIdOf(layers.type) !== 'dinkster.layers' ||
        selector?.kind !== 'input' ||
        canonicalTypeIdOf(selector.type) !== 'core.string'
      ) {
        return [commandError('image.exportUnavailable', 'The backend does not advertise compatible layer load and flatten nodes')]
      }
      const allocation = graphAllocator(tx, params.graphId, graph)
      const loaderId = allocation.mint('n')
      const flattenId = allocation.mint('n')
      const linkId = allocation.mint('l')
      allocation.commit()
      tx.set(['graphs', params.graphId, 'nodes', loaderId], {
        id: loaderId,
        type: load.type,
        values: { document: params.asset },
      })
      tx.set(['graphs', params.graphId, 'nodes', flattenId], {
        id: flattenId,
        type: flatten.type,
        values: { selector: 'composite' },
      })
      tx.set(['graphs', params.graphId, 'links', linkId], {
        id: linkId,
        from: { node: loaderId, port: 'layers' },
        to: { node: flattenId, port: 'layers' },
      })
      ensureCommandViewGraph(tx, params.graphId)
      tx.set(['view', 'graphs', params.graphId, 'nodes', loaderId], {
        position: params.position,
      })
      tx.set(['view', 'graphs', params.graphId, 'nodes', flattenId], {
        position: { x: params.position.x + 320, y: params.position.y },
      })
      return []
    },
  }
}

function imageDocumentRecipeExportOf(resolve?: (type: string) => NodeSchema | undefined): CommandDefinition {
  return {
    id: 'image.documentRecipeExport',
    run(doc, params, tx, context) {
      if (
        !isCommandObject(params) ||
        Object.keys(params).length !== 7 ||
        typeof params.graphId !== 'string' ||
        typeof params.expectedGraphFingerprint !== 'string' ||
        typeof params.sourceNodeId !== 'string' ||
        typeof params.sourceOutputId !== 'string' ||
        typeof params.commands !== 'string' ||
        typeof params.format !== 'string' ||
        !Number.isSafeInteger(params.quality)
      ) {
        return [commandError('params.invalid', 'image.documentRecipeExport requires a guarded layer source, commands and output policy')]
      }
      let commands: Json
      try {
        commands = JSON.parse(params.commands) as Json
      } catch {
        return [commandError('params.invalid', 'image.documentRecipeExport commands must be canonical JSON')]
      }
      if (!Array.isArray(commands) || canonicalJson(commands) !== params.commands || !commands.every(validImageRecipeRow)) {
        return [commandError('params.invalid', 'image.documentRecipeExport commands must be a canonical array')]
      }
      const graph = doc.graphs[params.graphId]
      if (!graph || sha256Hex(canonicalJson(graph)) !== params.expectedGraphFingerprint) {
        return [commandError('image.graphChanged', 'The recipe source graph changed after the image document was opened')]
      }
      const sourceNode = graph.nodes[params.sourceNodeId]
      const source =
        sourceNode === undefined
          ? undefined
          : commandSchemaOf(doc, sourceNode.type, context, resolve)?.items.find(
              (item) => item.kind === 'output' && item.id === params.sourceOutputId,
            )
      const edit = schemaForCommandRole(doc, LAYERS_EDIT_ROLE, context, resolve)
      const flatten = schemaForCommandRole(doc, LAYERS_FLATTEN_ROLE, context, resolve)
      const save = schemaForCommandRole(doc, IMAGE_SAVE_ROLE, context, resolve)
      const editLayers = edit?.items.find((item) => item.kind === 'input' && item.id === 'layers')
      const editCommands = edit?.items.find((item) => item.kind === 'input' && item.id === 'commands')
      const editOutput = edit?.items.find((item) => item.kind === 'output' && item.id === 'layers')
      const flattenLayers = flatten?.items.find((item) => item.kind === 'input' && item.id === 'layers')
      const flattenSelector = flatten?.items.find((item) => item.kind === 'input' && item.id === 'selector')
      const flattenImage = flatten?.items.find((item) => item.kind === 'output' && item.id === 'image')
      const saveImages = save?.items.find((item) => item.kind === 'input' && item.id === 'images')
      const saveFormat = save?.items.find((item) => item.kind === 'input' && item.id === 'format')
      const saveQuality = save?.items.find((item) => item.kind === 'input' && item.id === 'quality')
      if (
        !edit ||
        !flatten ||
        !save ||
        source?.kind !== 'output' ||
        canonicalTypeIdOf(source.type) !== 'dinkster.layers' ||
        editLayers?.kind !== 'input' ||
        canonicalTypeIdOf(editLayers.type) !== 'dinkster.layers' ||
        editCommands?.kind !== 'input' ||
        canonicalTypeIdOf(editCommands.type) !== 'core.string' ||
        editOutput?.kind !== 'output' ||
        canonicalTypeIdOf(editOutput.type) !== 'dinkster.layers' ||
        flattenLayers?.kind !== 'input' ||
        canonicalTypeIdOf(flattenLayers.type) !== 'dinkster.layers' ||
        flattenSelector?.kind !== 'input' ||
        canonicalTypeIdOf(flattenSelector.type) !== 'core.string' ||
        flattenImage?.kind !== 'output' ||
        canonicalTypeIdOf(flattenImage.type) !== 'dinkster.image' ||
        saveImages?.kind !== 'input' ||
        canonicalTypeIdOf(saveImages.type) !== 'dinkster.image' ||
        saveFormat?.kind !== 'input' ||
        canonicalTypeIdOf(saveFormat.type) !== 'core.combo' ||
        saveFormat.widget?.widgetType !== 'COMBO' ||
        !normalizedComboOptions(saveFormat.widget).some((option) => option.value === params.format) ||
        saveQuality?.kind !== 'input' ||
        canonicalTypeIdOf(saveQuality.type) !== 'core.int' ||
        saveQuality.widget?.widgetType !== 'INT'
      ) {
        return [
          commandError(
            'image.recipeExportUnavailable',
            'The backend does not advertise compatible layer edit, flatten and image save nodes',
          ),
        ]
      }
      const qualityMin = saveQuality.widget.options['min']
      const qualityMax = saveQuality.widget.options['max']
      const qualityStep = saveQuality.widget.options['step']
      if (
        !Number.isSafeInteger(qualityMin) ||
        !Number.isSafeInteger(qualityMax) ||
        !Number.isSafeInteger(qualityStep) ||
        Number(qualityStep) <= 0 ||
        Number(qualityMin) > Number(qualityMax) ||
        Number(params.quality) < Number(qualityMin) ||
        Number(params.quality) > Number(qualityMax) ||
        (Number(params.quality) - Number(qualityMin)) % Number(qualityStep) !== 0
      ) {
        return [commandError('image.recipeExportUnavailable', 'The backend does not advertise a compatible image quality range')]
      }
      const allocation = graphAllocator(tx, params.graphId, graph)
      const editId = allocation.mint('n')
      const flattenId = allocation.mint('n')
      const saveId = allocation.mint('n')
      const sourceLinkId = allocation.mint('l')
      const flattenLinkId = allocation.mint('l')
      const saveLinkId = allocation.mint('l')
      allocation.commit()
      tx.set(['graphs', params.graphId, 'nodes', editId], {
        id: editId,
        type: edit.type,
        values: { commands: params.commands },
      })
      tx.set(['graphs', params.graphId, 'nodes', flattenId], {
        id: flattenId,
        type: flatten.type,
        values: { selector: 'composite' },
      })
      tx.set(['graphs', params.graphId, 'nodes', saveId], {
        id: saveId,
        type: save.type,
        values: {
          format: params.format as string,
          quality: params.quality as number,
        },
      })
      tx.set(['graphs', params.graphId, 'links', sourceLinkId], {
        id: sourceLinkId,
        from: { node: params.sourceNodeId, port: params.sourceOutputId },
        to: { node: editId, port: 'layers' },
      })
      tx.set(['graphs', params.graphId, 'links', flattenLinkId], {
        id: flattenLinkId,
        from: { node: editId, port: 'layers' },
        to: { node: flattenId, port: 'layers' },
      })
      tx.set(['graphs', params.graphId, 'links', saveLinkId], {
        id: saveLinkId,
        from: { node: flattenId, port: 'image' },
        to: { node: saveId, port: 'images' },
      })
      const sourcePosition = doc.view.graphs[params.graphId]?.nodes?.[params.sourceNodeId]?.position ?? { x: 80, y: 80 }
      ensureCommandViewGraph(tx, params.graphId)
      tx.set(['view', 'graphs', params.graphId, 'nodes', editId], {
        position: { x: sourcePosition.x + 320, y: sourcePosition.y },
      })
      tx.set(['view', 'graphs', params.graphId, 'nodes', flattenId], {
        position: { x: sourcePosition.x + 640, y: sourcePosition.y },
      })
      tx.set(['view', 'graphs', params.graphId, 'nodes', saveId], {
        position: { x: sourcePosition.x + 960, y: sourcePosition.y },
      })
      return []
    },
  }
}

export const IMAGE_DOCUMENT_COMMAND_EXTENSION: RegisteredCommandExtension = {
  id: 'builtin.image-document',
  schemaRoles: [LAYERS_LOAD_ROLE, LAYERS_FLATTEN_ROLE, LAYERS_EDIT_ROLE, IMAGE_SAVE_ROLE],
  commands: (resolve) => [imageDocumentExportOf(resolve), imageDocumentRecipeExportOf(resolve)],
}
