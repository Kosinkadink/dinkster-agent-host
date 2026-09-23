import { diag, type Diagnostic } from '../diagnostics.js'
import type { ReplacementRule } from '../replace/model.js'
import type { DinksterNodesPayload } from './dinkster-wire.js'
import type { NodeSchema } from './model.js'
import {
  array,
  COMFY_CORE_REVISION,
  comfyRevisionDiagnostics,
  fields,
  nonempty,
  parseComfyConfidence,
  parseComfyFamily,
  parseComfyReplacement,
  parseComfySource,
  parseComfySourceSchema,
  string,
  type ComfyConfidence,
  type ComfyConfidenceTier,
  type ComfyFamily,
  type ComfyMappingKind,
  type ComfySource,
  type ComfyTolerance,
} from './comfy-registry-codec.js'

export const COMFY_ALIAS_FORMAT = 'dinkster-comfy-alias/1'
export { COMFY_CORE_REVISION }

export type ComfyAliasMappingKind = ComfyMappingKind
export type ComfyAliasConfidenceTier = ComfyConfidenceTier
export type ComfyAliasSource = ComfySource
export type ComfyAliasFamily = ComfyFamily
export type ComfyAliasTolerance = ComfyTolerance
export type ComfyAliasConfidence = ComfyConfidence

export interface ComfyAliasRecord {
  readonly id: string
  readonly mappingKind: ComfyAliasMappingKind
  readonly carrier: string
  readonly source: ComfyAliasSource
  readonly replacement: ReplacementRule
  readonly confidence: ComfyAliasConfidence
  readonly family?: ComfyAliasFamily
  /** Pack whose registry carries and maintains this record. */
  readonly ownerPack: string
}

export interface ComfyAliasCatalog {
  readonly records: readonly ComfyAliasRecord[]
  readonly sourceSchemas: ReadonlyMap<string, NodeSchema>
  readonly recordsBySourceType: ReadonlyMap<string, ComfyAliasRecord>
  /** Bare ComfyUI class names with exactly one claim across installed packs. */
  readonly recordsByNodeClass: ReadonlyMap<string, ComfyAliasRecord>
}

export interface ComfyAliasCatalogResult {
  readonly catalog: ComfyAliasCatalog
  readonly diagnostics: readonly Diagnostic[]
}

interface ParsedPackRegistry {
  readonly records: readonly ComfyAliasRecord[]
  readonly sourceSchemas: ReadonlyMap<string, NodeSchema>
}

const parsePackRegistry = (
  ownerPack: string,
  value: unknown,
  nativeSchemas: ReadonlyMap<string, NodeSchema>,
): ParsedPackRegistry => {
  const raw = fields(value, `pack '${ownerPack}' comfyAliases`, ['format', 'sourceSchemas', 'records'])
  if (raw['format'] !== COMFY_ALIAS_FORMAT) throw new Error(`unsupported format '${String(raw['format'])}'`)
  const sourceSchemas = new Map<string, NodeSchema>()
  array(raw['sourceSchemas'], `pack '${ownerPack}' comfyAliases.sourceSchemas`).forEach((item, index) => {
    const schema = parseComfySourceSchema(
      item,
      `pack '${ownerPack}' comfyAliases.sourceSchemas[${index}]`,
    )
    if (sourceSchemas.has(schema.type)) throw new Error(`duplicate source schema nodeType '${schema.type}'`)
    sourceSchemas.set(schema.type, schema)
  })

  const records = array(raw['records'], `pack '${ownerPack}' comfyAliases.records`).map((item, index): ComfyAliasRecord => {
    const where = `pack '${ownerPack}' comfyAliases.records[${index}]`
    const record = fields(item, where, ['id', 'mappingKind', 'carrier', 'source', 'replacement', 'confidence'], ['family'])
    const source = parseComfySource(record['source'], `${where}.source`)
    const id = nonempty(record['id'], `${where}.id`)
    const expectedId = `comfy_alias:${source.pack}/${source.nodeClass}`
    if (id !== expectedId) throw new Error(`${where}.id must be '${expectedId}'`)
    const mappingKind = string(record['mappingKind'], `${where}.mappingKind`)
    if (mappingKind !== 'op' && mappingKind !== 'family') throw new Error(`${where}.mappingKind is invalid`)
    const carrier = nonempty(record['carrier'], `${where}.carrier`)
    const carrierSchema = nativeSchemas.get(carrier)
    if (carrierSchema === undefined || carrierSchema.pack !== ownerPack) {
      throw new Error(`${where}.carrier '${carrier}' is not owned by pack '${ownerPack}'`)
    }
    const replacement = parseComfyReplacement(record['replacement'], `${where}.replacement`)
    if (replacement.from !== source.nodeType) throw new Error(`${where}.replacement.from must equal source.nodeType`)
    if (!replacement.cases.some((candidate) => candidate.to === carrier)) {
      throw new Error(`${where}.carrier must be one of replacement.cases[].to`)
    }
    let family: ComfyAliasFamily | undefined
    if (record['family'] !== undefined) {
      family = parseComfyFamily(record['family'], `${where}.family`)
    }
    if ((mappingKind === 'family') !== (family !== undefined)) {
      throw new Error(`${where}: family mappings require family data and op mappings forbid it`)
    }
    return {
      id,
      mappingKind,
      carrier,
      source,
      replacement,
      confidence: parseComfyConfidence(record['confidence'], `${where}.confidence`),
      ...(family !== undefined ? { family } : {}),
      ownerPack,
    }
  })

  const ids = records.map((record) => record.id)
  const sourceKeys = records.map((record) => `${record.source.pack}\0${record.source.nodeClass}`)
  const sourceTypes = records.map((record) => record.source.nodeType)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate record ids')
  if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error('duplicate source pack/nodeClass keys')
  if (new Set(sourceTypes).size !== sourceTypes.length) throw new Error('duplicate source nodeType records')
  if (sourceTypes.some((type) => !sourceSchemas.has(type))) throw new Error('one or more records lack source schemas')
  if ([...sourceSchemas.keys()].some((type) => !sourceTypes.includes(type))) throw new Error('one or more source schemas are unused')
  return { records, sourceSchemas }
}

/** Strictly decode every installed pack's maintained ComfyUI alias data. */
export function comfyAliasCatalogFromDinksterWire(
  payload: DinksterNodesPayload,
  nativeSchemas: ReadonlyMap<string, NodeSchema>,
): ComfyAliasCatalogResult {
  const diagnostics: Diagnostic[] = []
  const parsed: ParsedPackRegistry[] = []
  const packs = typeof payload.packs === 'object' && payload.packs !== null && !Array.isArray(payload.packs)
    ? payload.packs as Record<string, unknown>
    : {}
  for (const [packId, packRaw] of Object.entries(packs)) {
    if (typeof packRaw !== 'object' || packRaw === null || Array.isArray(packRaw)) continue
    const aliases = (packRaw as Record<string, unknown>)['comfyAliases']
    if (aliases === undefined) continue
    try {
      const registry = parsePackRegistry(packId, aliases, nativeSchemas)
      parsed.push(registry)
      diagnostics.push(...comfyRevisionDiagnostics(registry.records.map((record) => record.source), packId))
    } catch (error) {
      diagnostics.push(diag(
        'error',
        'schema',
        'schema.comfyAlias.invalid',
        `pack '${packId}' ComfyUI alias registry was rejected: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }

  const records: ComfyAliasRecord[] = []
  const sourceSchemas = new Map<string, NodeSchema>()
  const recordsBySourceType = new Map<string, ComfyAliasRecord>()
  const candidates = parsed.flatMap((registry) => registry.records.map((record) => ({
    record,
    schema: registry.sourceSchemas.get(record.source.nodeType)!,
  })))
  const counts = (key: (record: ComfyAliasRecord) => string): ReadonlyMap<string, number> => {
    const out = new Map<string, number>()
    for (const { record } of candidates) out.set(key(record), (out.get(key(record)) ?? 0) + 1)
    return out
  }
  const idCounts = counts((record) => record.id)
  const sourceCounts = counts((record) => `${record.source.pack}\0${record.source.nodeClass}`)
  const typeCounts = counts((record) => record.source.nodeType)
  for (const { record, schema } of candidates) {
    const sourceKey = `${record.source.pack}\0${record.source.nodeClass}`
    if (idCounts.get(record.id)! > 1 || sourceCounts.get(sourceKey)! > 1 || typeCounts.get(record.source.nodeType)! > 1) {
      diagnostics.push(diag(
        'error',
        'schema',
        'schema.comfyAlias.collision',
        `ComfyUI alias '${record.id}' from pack '${record.ownerPack}' collides with an installed alias registry; it will not resolve`,
      ))
      continue
    }
    recordsBySourceType.set(record.source.nodeType, record)
    sourceSchemas.set(record.source.nodeType, schema)
    records.push(record)
  }

  const classClaims = new Map<string, ComfyAliasRecord[]>()
  for (const record of records) {
    const claims = classClaims.get(record.source.nodeClass)
    if (claims === undefined) classClaims.set(record.source.nodeClass, [record])
    else claims.push(record)
  }
  const recordsByNodeClass = new Map<string, ComfyAliasRecord>()
  for (const [nodeClass, claims] of classClaims) {
    if (claims.length === 1) recordsByNodeClass.set(nodeClass, claims[0]!)
    else diagnostics.push(diag(
      'warning',
      'schema',
      'schema.comfyAlias.classCollision',
      `ComfyUI class '${nodeClass}' is claimed by ${claims.map((record) => `'${record.id}'`).join(' and ')}; it will not resolve`,
    ))
  }
  return {
    catalog: { records, sourceSchemas, recordsBySourceType, recordsByNodeClass },
    diagnostics,
  }
}
