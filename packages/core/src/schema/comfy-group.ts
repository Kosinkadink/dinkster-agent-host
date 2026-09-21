import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json } from '../format/document.js'
import { ownJson } from '../format/json.js'
import type { ReplacementRule } from '../replace/model.js'
import { DINKSTER_ACCEPTED_WIRE_VERSIONS, type DinksterNodesPayload } from './dinkster-wire.js'
import { inputsOf, outputsOf, type InputSpec, type NodeSchema, type OutputSpec } from './model.js'
import {
  array,
  comfyRevisionDiagnostics,
  fields,
  isRegistryName,
  nonempty,
  object,
  parseComfyConfidence,
  parseComfyFamily,
  parseComfyReplacement,
  parseComfySource,
  parseComfySourceSchema,
  string,
  type ComfyConfidence,
  type ComfyFamily,
  type ComfyMappingKind,
  type ComfySource,
} from './comfy-registry-codec.js'

export const COMFY_GROUP_FORMAT = 'dinkster-comfy-group/1'
const MAX_GROUP_NODES = 16
const MAX_GROUP_EDGES = 64
const STRUCTURAL_ID = /^[A-Za-z0-9_-]+$/

export type ComfyGroupMode = 'active' | 'muted' | 'bypassed'

export interface ComfyGroupSource {
  readonly pack: string
  readonly name: string
  readonly revision: string
}

export interface ComfyGroupNode {
  readonly source: ComfySource
  readonly mode: ComfyGroupMode
}

export interface ComfyGroupEdge {
  readonly from: string
  readonly to: string
}

export interface ComfyGroupPattern {
  readonly groupType: string
  readonly anchor: string
  readonly nodes: ReadonlyMap<string, ComfyGroupNode>
  readonly edges: readonly ComfyGroupEdge[]
  readonly disconnected: readonly string[]
  readonly inputs: ReadonlyMap<string, string>
  readonly parameters: ReadonlyMap<string, string>
  readonly constants: ReadonlyMap<string, Json>
  readonly outputs: ReadonlyMap<string, string>
}

export interface ComfyGroupRecord {
  readonly id: string
  readonly mappingKind: ComfyMappingKind
  readonly carrier: string
  readonly source: ComfyGroupSource
  readonly pattern: ComfyGroupPattern
  readonly replacement: ReplacementRule
  readonly confidence: ComfyConfidence
  readonly family?: ComfyFamily
  readonly ownerPack: string
}

export interface ComfyGroupCatalog {
  readonly records: readonly ComfyGroupRecord[]
  readonly sourceSchemas: ReadonlyMap<string, NodeSchema>
  readonly groupSchemas: ReadonlyMap<string, NodeSchema>
  readonly recordsByGroupType: ReadonlyMap<string, ComfyGroupRecord>
}

export interface ComfyGroupCatalogResult {
  readonly catalog: ComfyGroupCatalog
  readonly diagnostics: readonly Diagnostic[]
}

interface ParsedPackRegistry {
  readonly records: readonly ComfyGroupRecord[]
  readonly sourceSchemas: ReadonlyMap<string, NodeSchema>
  readonly groupSchemas: ReadonlyMap<string, NodeSchema>
}

const address = (
  value: unknown,
  where: string,
  localIds: ReadonlySet<string>,
): { readonly node: string; readonly port: string; readonly value: string } => {
  const raw = nonempty(value, where)
  const parts = raw.split(':')
  if (
    parts.length !== 2 ||
    !STRUCTURAL_ID.test(parts[0]!) ||
    !STRUCTURAL_ID.test(parts[1]!) ||
    !localIds.has(parts[0]!)
  ) {
    throw new Error(`${where} has invalid pattern address '${raw}'`)
  }
  return { node: parts[0]!, port: parts[1]!, value: raw }
}

const stringMap = (value: unknown, where: string): ReadonlyMap<string, string> =>
  new Map(Object.entries(object(value, where)).map(([key, item]) => [
    key,
    nonempty(item, `${where}.${key}`),
  ]))

const groupSource = (value: unknown, where: string): ComfyGroupSource => {
  const raw = fields(value, where, ['pack', 'name', 'revision'])
  const source = {
    pack: nonempty(raw['pack'], `${where}.pack`),
    name: nonempty(raw['name'], `${where}.name`),
    revision: nonempty(raw['revision'], `${where}.revision`),
  }
  if (!isRegistryName(source.pack)) throw new Error(`${where}.pack is invalid`)
  if (!isRegistryName(source.name)) throw new Error(`${where}.name is invalid`)
  return source
}

const groupNode = (value: unknown, where: string): ComfyGroupNode => {
  const raw = fields(value, where, ['source', 'mode'])
  const mode = string(raw['mode'], `${where}.mode`)
  if (mode !== 'active' && mode !== 'muted' && mode !== 'bypassed') {
    throw new Error(`${where}.mode is invalid`)
  }
  return { source: parseComfySource(raw['source'], `${where}.source`), mode }
}

const groupPattern = (value: unknown, where: string): ComfyGroupPattern => {
  const raw = fields(
    value,
    where,
    ['groupType', 'anchor', 'nodes', 'edges', 'disconnected', 'boundary', 'parameters', 'constants'],
  )
  const nodeEntries = Object.entries(object(raw['nodes'], `${where}.nodes`))
  if (nodeEntries.length < 2 || nodeEntries.length > MAX_GROUP_NODES) {
    throw new Error(`${where}.nodes must contain 2 to ${MAX_GROUP_NODES} entries`)
  }
  if (nodeEntries.some(([id]) => !STRUCTURAL_ID.test(id))) {
    throw new Error(`${where}.nodes has an invalid local node id`)
  }
  const nodes = new Map(nodeEntries.map(([id, node]) => [id, groupNode(node, `${where}.nodes.${id}`)]))
  const localIds = new Set(nodes.keys())
  const anchor = nonempty(raw['anchor'], `${where}.anchor`)
  if (!localIds.has(anchor)) throw new Error(`${where}.anchor must name a local node`)
  const modes = new Set([...nodes.values()].map((node) => node.mode))
  if (modes.size !== 1) throw new Error(`${where}.nodes must declare one uniform mode`)

  const edgeItems = array(raw['edges'], `${where}.edges`)
  if (edgeItems.length > MAX_GROUP_EDGES) {
    throw new Error(`${where}.edges exceeds the ${MAX_GROUP_EDGES}-edge cap`)
  }
  const edges = edgeItems.map((item, index): ComfyGroupEdge => {
    const edgeWhere = `${where}.edges[${index}]`
    const edge = fields(item, edgeWhere, ['from', 'to'])
    return {
      from: address(edge['from'], `${edgeWhere}.from`, localIds).value,
      to: address(edge['to'], `${edgeWhere}.to`, localIds).value,
    }
  })
  const boundary = fields(raw['boundary'], `${where}.boundary`, ['inputs', 'outputs'])
  return {
    groupType: nonempty(raw['groupType'], `${where}.groupType`),
    anchor,
    nodes,
    edges,
    disconnected: array(raw['disconnected'], `${where}.disconnected`).map((item, index) =>
      address(item, `${where}.disconnected[${index}]`, localIds).value),
    inputs: stringMap(boundary['inputs'], `${where}.boundary.inputs`),
    parameters: stringMap(raw['parameters'], `${where}.parameters`),
    constants: new Map(Object.entries(object(raw['constants'], `${where}.constants`)) as [string, Json][]),
    outputs: stringMap(boundary['outputs'], `${where}.boundary.outputs`),
  }
}

const staticPorts = (
  schema: NodeSchema,
  where: string,
): { readonly inputs: ReadonlyMap<string, InputSpec>; readonly outputs: ReadonlyMap<string, OutputSpec> } => {
  const inputs = inputsOf(schema)
  const outputs = outputsOf(schema)
  if (inputs.some((input) => input.dynamic !== undefined) || outputs.some((output) => output.dynamic !== undefined)) {
    throw new Error(`${where} must have a static interface`)
  }
  return {
    inputs: new Map(inputs.map((input) => [input.id, input])),
    outputs: new Map(outputs.map((output) => [output.id, output])),
  }
}

const sameType = (left: InputSpec | OutputSpec, right: InputSpec | OutputSpec): boolean =>
  JSON.stringify(left.type) === JSON.stringify(right.type)

const validatePattern = (
  record: ComfyGroupRecord,
  sourceSchemas: ReadonlyMap<string, NodeSchema>,
  groupSchema: NodeSchema,
  where: string,
): void => {
  const group = staticPorts(groupSchema, `${where}.groupSchema`)
  const localIds = new Set(record.pattern.nodes.keys())
  const sourceInputs = new Map<string, InputSpec>()
  const sourceOutputs = new Map<string, OutputSpec>()
  for (const [localId, node] of record.pattern.nodes) {
    const schema = sourceSchemas.get(node.source.nodeType)
    if (schema === undefined) {
      throw new Error(`${where}.pattern node '${localId}' names unknown source schema '${node.source.nodeType}'`)
    }
    const ports = staticPorts(schema, `${where}.pattern node '${localId}'`)
    for (const [id, input] of ports.inputs) sourceInputs.set(`${localId}:${id}`, input)
    for (const [id, output] of ports.outputs) sourceOutputs.set(`${localId}:${id}`, output)
  }

  const internalTargets = new Set<string>()
  const edgeKeys = new Set<string>()
  const adjacent = new Map([...localIds].map((id) => [id, new Set<string>()]))
  for (const edge of record.pattern.edges) {
    const from = address(edge.from, `${where}.pattern edge.from`, localIds)
    const to = address(edge.to, `${where}.pattern edge.to`, localIds)
    const output = sourceOutputs.get(from.value)
    const input = sourceInputs.get(to.value)
    if (output === undefined) throw new Error(`${where}.pattern edge source '${from.value}' is not an output`)
    if (input === undefined) throw new Error(`${where}.pattern edge target '${to.value}' is not an input`)
    if (!sameType(output, input)) throw new Error(`${where}.pattern edge '${from.value}' -> '${to.value}' has mismatched types`)
    if (internalTargets.has(to.value)) throw new Error(`${where}.pattern input '${to.value}' has multiple internal feeders`)
    const edgeKey = `${from.value}\0${to.value}`
    if (edgeKeys.has(edgeKey)) throw new Error(`${where}.pattern has duplicate edge '${from.value}' -> '${to.value}'`)
    edgeKeys.add(edgeKey)
    internalTargets.add(to.value)
    adjacent.get(from.node)!.add(to.node)
    adjacent.get(to.node)!.add(from.node)
  }

  const connected = new Set([record.pattern.anchor])
  const pending = [record.pattern.anchor]
  while (pending.length > 0) {
    for (const neighbor of adjacent.get(pending.pop()!)!) {
      if (connected.has(neighbor)) continue
      connected.add(neighbor)
      pending.push(neighbor)
    }
  }
  if (connected.size !== localIds.size) throw new Error(`${where}.pattern nodes must be connected by internal edges`)

  const roleAddresses = new Set<string>()
  const declaredInputRoles = new Set([
    ...record.pattern.inputs.values(),
    ...record.pattern.parameters.values(),
    ...record.pattern.constants.keys(),
  ])
  for (const rawAddress of record.pattern.disconnected) {
    const parsed = address(rawAddress, `${where}.disconnected`, localIds)
    const sourceSpec = sourceInputs.get(parsed.value)
    if (sourceSpec === undefined) {
      throw new Error(`${where}.disconnected address '${parsed.value}' is not a source input`)
    }
    if (
      roleAddresses.has(parsed.value) ||
      internalTargets.has(parsed.value) ||
      declaredInputRoles.has(parsed.value)
    ) {
      throw new Error(`${where}.source input '${parsed.value}' has multiple pattern roles`)
    }
    if (!sourceSpec.optional || (sourceSpec.widget !== undefined && sourceSpec.forceInput !== true)) {
      throw new Error(`${where}.disconnected address '${parsed.value}' is not an optional socket input`)
    }
    roleAddresses.add(parsed.value)
  }
  const groupInputKeys = new Set<string>()
  for (const [role, entries] of [
    ['boundary input', record.pattern.inputs],
    ['parameter', record.pattern.parameters],
  ] as const) {
    for (const [groupInput, rawAddress] of entries) {
      const parsed = address(rawAddress, `${where}.${role}`, localIds)
      const groupSpec = group.inputs.get(groupInput)
      const sourceSpec = sourceInputs.get(parsed.value)
      if (groupSpec === undefined) throw new Error(`${where}.${role} '${groupInput}' is not a group schema input`)
      if (groupInputKeys.has(groupInput)) throw new Error(`${where}.group schema input '${groupInput}' has multiple pattern mappings`)
      if (sourceSpec === undefined) throw new Error(`${where}.${role} address '${parsed.value}' is not a source input`)
      if (roleAddresses.has(parsed.value) || internalTargets.has(parsed.value)) {
        throw new Error(`${where}.source input '${parsed.value}' has multiple pattern roles`)
      }
      if (!sameType(sourceSpec, groupSpec)) throw new Error(`${where}.${role} '${groupInput}' type differs from source input '${parsed.value}'`)
      if (role === 'parameter' && (sourceSpec.widget === undefined || groupSpec.widget === undefined)) {
        throw new Error(`${where}.parameter '${groupInput}' must map widget inputs`)
      }
      if (
        role === 'parameter' &&
        (sourceSpec.widget!.widgetType !== groupSpec.widget!.widgetType ||
          sourceSpec.widget!.controller !== groupSpec.widget!.controller)
      ) {
        throw new Error(`${where}.parameter '${groupInput}' has incompatible widget behavior`)
      }
      if (role === 'parameter' && sourceSpec.forceInput === true) {
        throw new Error(`${where}.parameter '${groupInput}' source must not accept a link`)
      }
      roleAddresses.add(parsed.value)
      groupInputKeys.add(groupInput)
    }
  }
  for (const rawAddress of record.pattern.constants.keys()) {
    const parsed = address(rawAddress, `${where}.constant`, localIds)
    const sourceSpec = sourceInputs.get(parsed.value)
    if (sourceSpec === undefined) throw new Error(`${where}.constant address '${parsed.value}' is not a source input`)
    if (roleAddresses.has(parsed.value) || internalTargets.has(parsed.value)) {
      throw new Error(`${where}.source input '${parsed.value}' has multiple pattern roles`)
    }
    if (sourceSpec.widget === undefined || sourceSpec.forceInput === true) {
      throw new Error(`${where}.constant address '${parsed.value}' is not a static widget input`)
    }
    roleAddresses.add(parsed.value)
  }
  const classified = new Set([...internalTargets, ...roleAddresses])
  if (classified.size !== sourceInputs.size || [...sourceInputs.keys()].some((key) => !classified.has(key))) {
    throw new Error(`${where}.every source input must have exactly one pattern role`)
  }
  if (groupInputKeys.size !== group.inputs.size || [...group.inputs.keys()].some((key) => !groupInputKeys.has(key))) {
    throw new Error(`${where}.group schema inputs lack pattern mappings`)
  }

  const groupOutputKeys = new Set<string>()
  const sourceBoundaryOutputs = new Set<string>()
  for (const [groupOutput, rawAddress] of record.pattern.outputs) {
    const parsed = address(rawAddress, `${where}.boundary output`, localIds)
    const groupSpec = group.outputs.get(groupOutput)
    const sourceSpec = sourceOutputs.get(parsed.value)
    if (groupSpec === undefined) throw new Error(`${where}.boundary output '${groupOutput}' is not a group schema output`)
    if (sourceSpec === undefined) throw new Error(`${where}.boundary output address '${parsed.value}' is not a source output`)
    if (!sameType(sourceSpec, groupSpec)) throw new Error(`${where}.boundary output '${groupOutput}' type differs from source output '${parsed.value}'`)
    if (sourceBoundaryOutputs.has(parsed.value)) throw new Error(`${where}.source output '${parsed.value}' maps more than once`)
    groupOutputKeys.add(groupOutput)
    sourceBoundaryOutputs.add(parsed.value)
  }
  if (groupOutputKeys.size !== group.outputs.size || [...group.outputs.keys()].some((key) => !groupOutputKeys.has(key))) {
    throw new Error(`${where}.group schema outputs lack pattern mappings`)
  }
}

const parsePackRegistry = (
  ownerPack: string,
  value: unknown,
  nativeSchemas: ReadonlyMap<string, NodeSchema>,
  allowedWireVersions: readonly number[],
): ParsedPackRegistry => {
  const where = `pack '${ownerPack}' comfyGroups`
  const raw = fields(value, where, ['format', 'sourceSchemas', 'groupSchemas', 'records'])
  if (raw['format'] !== COMFY_GROUP_FORMAT) throw new Error(`unsupported format '${String(raw['format'])}'`)
  const schemas = (key: 'sourceSchemas' | 'groupSchemas'): ReadonlyMap<string, NodeSchema> => {
    const out = new Map<string, NodeSchema>()
    array(raw[key], `${where}.${key}`).forEach((item, index) => {
      const schema = parseComfySourceSchema(item, `${where}.${key}[${index}]`, allowedWireVersions)
      if (out.has(schema.type)) throw new Error(`${where}.${key} has duplicate nodeType '${schema.type}'`)
      if (key === 'groupSchemas' && nativeSchemas.has(schema.type)) {
        throw new Error(`${where}.${key} nodeType '${schema.type}' collides with a native schema`)
      }
      out.set(schema.type, schema)
    })
    return out
  }
  const sourceSchemas = schemas('sourceSchemas')
  const groupSchemas = schemas('groupSchemas')
  if ([...sourceSchemas.keys()].some((type) => groupSchemas.has(type))) {
    throw new Error(`${where} source and group schema nodeType values overlap`)
  }

  const records = array(raw['records'], `${where}.records`).map((item, index): ComfyGroupRecord => {
    const recordWhere = `${where}.records[${index}]`
    const record = fields(
      item,
      recordWhere,
      ['id', 'mappingKind', 'carrier', 'source', 'pattern', 'replacement', 'confidence'],
      ['family'],
    )
    const source = groupSource(record['source'], `${recordWhere}.source`)
    const id = nonempty(record['id'], `${recordWhere}.id`)
    const expectedId = `comfy_group:${source.pack}/${source.name}`
    if (id !== expectedId) throw new Error(`${recordWhere}.id must be '${expectedId}'`)
    const mappingKind = string(record['mappingKind'], `${recordWhere}.mappingKind`)
    if (mappingKind !== 'op' && mappingKind !== 'family') throw new Error(`${recordWhere}.mappingKind is invalid`)
    const carrier = nonempty(record['carrier'], `${recordWhere}.carrier`)
    const carrierSchema = nativeSchemas.get(carrier)
    if (carrierSchema === undefined || carrierSchema.pack !== ownerPack) {
      throw new Error(`${recordWhere}.carrier '${carrier}' is not owned by pack '${ownerPack}'`)
    }
    const pattern = groupPattern(record['pattern'], `${recordWhere}.pattern`)
    const expectedType = `comfy-group.${source.pack}.${source.name}`
    if (pattern.groupType !== expectedType) throw new Error(`${recordWhere}.pattern.groupType must be '${expectedType}'`)
    const replacement = parseComfyReplacement(record['replacement'], `${recordWhere}.replacement`)
    if (replacement.from !== pattern.groupType) throw new Error(`${recordWhere}.replacement.from must equal pattern.groupType`)
    if (!replacement.cases.some((candidate) => candidate.to === carrier)) {
      throw new Error(`${recordWhere}.carrier must be one of replacement.cases[].to`)
    }
    const confidence = parseComfyConfidence(record['confidence'], `${recordWhere}.confidence`)
    if (confidence.tier !== 'grouped') throw new Error(`${recordWhere}.confidence.tier must be grouped`)
    const family = record['family'] === undefined
      ? undefined
      : parseComfyFamily(record['family'], `${recordWhere}.family`)
    if ((mappingKind === 'family') !== (family !== undefined)) {
      throw new Error(`${recordWhere}: family mappings require family data and op mappings forbid it`)
    }
    const decoded: ComfyGroupRecord = {
      id,
      mappingKind,
      carrier,
      source,
      pattern,
      replacement,
      confidence,
      ...(family !== undefined ? { family } : {}),
      ownerPack,
    }
    const groupSchema = groupSchemas.get(pattern.groupType)
    if (groupSchema === undefined) throw new Error(`${recordWhere} lacks group schema '${pattern.groupType}'`)
    validatePattern(decoded, sourceSchemas, groupSchema, recordWhere)
    return decoded
  })

  const unique = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) throw new Error(`${where} has duplicate ${label}`)
  }
  unique(records.map((record) => record.id), 'record ids')
  unique(records.map((record) => `${record.source.pack}\0${record.source.name}`), 'source pack/name keys')
  unique(records.map((record) => record.pattern.groupType), 'groupType records')
  const usedSources = new Set(records.flatMap((record) =>
    [...record.pattern.nodes.values()].map((node) => node.source.nodeType)))
  if ([...usedSources].some((type) => !sourceSchemas.has(type))) throw new Error(`${where} records lack source schemas`)
  if ([...sourceSchemas.keys()].some((type) => !usedSources.has(type))) throw new Error(`${where} has unused source schemas`)
  const usedGroups = new Set(records.map((record) => record.pattern.groupType))
  if ([...groupSchemas.keys()].some((type) => !usedGroups.has(type))) throw new Error(`${where} has unused group schemas`)
  return { records, sourceSchemas, groupSchemas }
}

/** Decode installed exact-group translation registries without exposing their schemas as native nodes. */
export function comfyGroupCatalogFromDinksterWire(
  payload: DinksterNodesPayload,
  nativeSchemas: ReadonlyMap<string, NodeSchema>,
  allowedWireVersions: readonly number[] = DINKSTER_ACCEPTED_WIRE_VERSIONS,
): ComfyGroupCatalogResult {
  const diagnostics: Diagnostic[] = []
  const parsed: ParsedPackRegistry[] = []
  const packs = typeof payload.packs === 'object' && payload.packs !== null && !Array.isArray(payload.packs)
    ? payload.packs as Record<string, unknown>
    : {}
  for (const [packId, packRaw] of Object.entries(packs)) {
    if (typeof packRaw !== 'object' || packRaw === null || Array.isArray(packRaw)) continue
    const ownedPack = ownJson(packRaw)
    if (!ownedPack.ok) {
      diagnostics.push(diag(
        'error',
        'schema',
        'schema.comfyGroup.invalid',
        `pack '${packId}' ComfyUI group registry was rejected: pack metadata is not JSON: ${ownedPack.reason}`,
      ))
      continue
    }
    const groups = (ownedPack.value as Record<string, unknown>)['comfyGroups']
    if (groups === undefined) continue
    try {
      const owned = ownJson(groups)
      if (!owned.ok) throw new Error(`registry is not JSON: ${owned.reason}`)
      const registry = parsePackRegistry(packId, owned.value, nativeSchemas, allowedWireVersions)
      parsed.push(registry)
      diagnostics.push(...comfyRevisionDiagnostics(registry.records.flatMap((record) => [
        record.source,
        ...[...record.pattern.nodes.values()].map((node) => node.source),
      ]), packId))
    } catch (error) {
      diagnostics.push(diag(
        'error',
        'schema',
        'schema.comfyGroup.invalid',
        `pack '${packId}' ComfyUI group registry was rejected: ${error instanceof Error ? error.message : String(error)}`,
      ))
    }
  }

  const candidates = parsed.flatMap((registry) => registry.records.map((record) => ({ record, registry })))
  const counts = (key: (record: ComfyGroupRecord) => string): ReadonlyMap<string, number> => {
    const out = new Map<string, number>()
    for (const { record } of candidates) out.set(key(record), (out.get(key(record)) ?? 0) + 1)
    return out
  }
  const idCounts = counts((record) => record.id)
  const sourceCounts = counts((record) => `${record.source.pack}\0${record.source.name}`)
  const typeCounts = counts((record) => record.pattern.groupType)
  const sourceShapes = new Map<string, Set<string>>()
  for (const registry of parsed) for (const [type, schema] of registry.sourceSchemas) {
    const shapes = sourceShapes.get(type) ?? new Set<string>()
    shapes.add(JSON.stringify(schema))
    sourceShapes.set(type, shapes)
  }

  const records: ComfyGroupRecord[] = []
  const sourceSchemas = new Map<string, NodeSchema>()
  const groupSchemas = new Map<string, NodeSchema>()
  const recordsByGroupType = new Map<string, ComfyGroupRecord>()
  for (const { record, registry } of candidates) {
    const sourceKey = `${record.source.pack}\0${record.source.name}`
    const conflictingSource = [...record.pattern.nodes.values()]
      .some((node) => sourceShapes.get(node.source.nodeType)!.size > 1)
    if (
      idCounts.get(record.id)! > 1 ||
      sourceCounts.get(sourceKey)! > 1 ||
      typeCounts.get(record.pattern.groupType)! > 1 ||
      conflictingSource
    ) {
      diagnostics.push(diag(
        'error',
        'schema',
        'schema.comfyGroup.collision',
        `ComfyUI group '${record.id}' from pack '${record.ownerPack}' collides with an installed group registry; it will not resolve`,
      ))
      continue
    }
    records.push(record)
    recordsByGroupType.set(record.pattern.groupType, record)
    groupSchemas.set(record.pattern.groupType, registry.groupSchemas.get(record.pattern.groupType)!)
    for (const node of record.pattern.nodes.values()) {
      sourceSchemas.set(node.source.nodeType, registry.sourceSchemas.get(node.source.nodeType)!)
    }
  }
  return {
    catalog: { records, sourceSchemas, groupSchemas, recordsByGroupType },
    diagnostics,
  }
}
