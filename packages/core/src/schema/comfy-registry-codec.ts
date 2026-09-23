import { diag, type Diagnostic } from '../diagnostics.js'
import { isReplacementRule, type ReplacementRule } from '../replace/model.js'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  type DinksterWireSchema,
} from './dinkster-wire.js'
import type { NodeSchema } from './model.js'

export const COMFY_CORE_REVISION = 'b78cec87'

export type ComfyMappingKind = 'op' | 'family'
export type ComfyConfidenceTier = 'exact' | 'parametric' | 'equivalent' | 'grouped'

export interface ComfySource {
  readonly pack: string
  readonly nodeClass: string
  readonly nodeType: string
  readonly revision: string
}

export interface ComfyFamily {
  readonly id: string
  readonly provider?: string
}

export interface ComfyTolerance {
  readonly metric: string
  readonly operator: '<=' | '>='
  readonly value: number
}

export interface ComfyConfidence {
  readonly tier: ComfyConfidenceTier
  readonly evidence: readonly string[]
  readonly tolerances?: readonly ComfyTolerance[]
}

const REGISTRY_NAME = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/

export const isRegistryName = (value: string): boolean =>
  value.length <= 64 && REGISTRY_NAME.test(value)

export const object = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

export const fields = (
  value: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  const out = object(value, where)
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !(key in out))
  const unknown = Object.keys(out).filter((key) => !allowed.has(key))
  if (missing.length > 0) throw new Error(`${where} is missing fields: ${missing.join(', ')}`)
  if (unknown.length > 0) throw new Error(`${where} has unknown fields: ${unknown.join(', ')}`)
  return out
}

export const array = (value: unknown, where: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value
}

export const string = (value: unknown, where: string): string => {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value
}

export const nonempty = (value: unknown, where: string): string => {
  const out = string(value, where)
  if (out === '') throw new Error(`${where} must be non-empty`)
  return out
}

const strictTransform = (value: unknown, where: string): void => {
  const item = object(value, where)
  if (item['kind'] === 'enumRename') {
    fields(item, where, ['kind', 'map'])
    object(item['map'], `${where}.map`)
  } else if (item['kind'] === 'scale') {
    fields(item, where, ['kind', 'factor'], ['offset'])
  } else {
    throw new Error(`${where}.kind is invalid`)
  }
}

const strictMapping = (value: unknown, where: string): void => {
  const item = object(value, where)
  switch (item['kind']) {
    case 'copy':
    case 'link':
      fields(item, where, ['kind', 'input'])
      break
    case 'value':
      fields(item, where, ['kind', 'input'], ['transform'])
      if (item['transform'] !== undefined) strictTransform(item['transform'], `${where}.transform`)
      break
    case 'constant':
      fields(item, where, ['kind', 'value'])
      break
    default:
      throw new Error(`${where}.kind is invalid`)
  }
}

const strictPredicate = (value: unknown, where: string): void => {
  const item = object(value, where)
  switch (item['kind']) {
    case 'always':
      fields(item, where, ['kind'])
      break
    case 'inputConnected':
    case 'valuePresent':
      fields(item, where, ['kind', 'input'])
      break
    case 'valueEquals':
      fields(item, where, ['kind', 'input', 'value'])
      break
    case 'not':
      fields(item, where, ['kind', 'of'])
      strictPredicate(item['of'], `${where}.of`)
      break
    case 'all':
    case 'any':
      fields(item, where, ['kind', 'of'])
      array(item['of'], `${where}.of`).forEach((entry, index) =>
        strictPredicate(entry, `${where}.of[${index}]`))
      break
    default:
      throw new Error(`${where}.kind is invalid`)
  }
}

const strictMappings = (value: unknown, where: string): void => {
  for (const [key, mapping] of Object.entries(object(value, where))) {
    strictMapping(mapping, `${where}.${key}`)
  }
}

const strictSlotVariants = (value: unknown, where: string): void => {
  const variants = object(value, where)
  if (Object.keys(variants).length === 0) throw new Error(`${where} must be non-empty`)
  for (const [key, choice] of Object.entries(variants)) nonempty(choice, `${where}.${key}`)
}

const strictFamilyMapping = (value: unknown, where: string): void => {
  const item = object(value, where)
  if (item['kind'] === 'copy') {
    fields(item, where, ['kind', 'sourceFamily', 'inputs'])
    strictMappings(item['inputs'], `${where}.inputs`)
    return
  }
  if (item['kind'] !== 'members') throw new Error(`${where}.kind is invalid`)
  fields(item, where, ['kind', 'members'])
  array(item['members'], `${where}.members`).forEach((member, index) => {
    const memberWhere = `${where}.members[${index}]`
    const decoded = fields(member, memberWhere, ['suffix', 'inputs'])
    strictMappings(decoded['inputs'], `${memberWhere}.inputs`)
  })
}

const strictOutputFamilyMapping = (value: unknown, where: string): void => {
  const item = object(value, where)
  if (item['kind'] === 'copy') {
    fields(item, where, ['kind', 'sourceFamily'])
    nonempty(item['sourceFamily'], `${where}.sourceFamily`)
    return
  }
  if (item['kind'] !== 'members') throw new Error(`${where}.kind is invalid`)
  fields(item, where, ['kind', 'members'])
  const members = array(item['members'], `${where}.members`)
  if (members.length === 0) throw new Error(`${where}.members must be non-empty`)
  members.forEach((member, index) => {
    const memberWhere = `${where}.members[${index}]`
    const decoded = fields(member, memberWhere, ['suffix', 'output'])
    nonempty(decoded['suffix'], `${memberWhere}.suffix`)
    nonempty(decoded['output'], `${memberWhere}.output`)
  })
}

export const parseComfyReplacement = (value: unknown, where: string): ReplacementRule => {
  const rule = fields(value, where, ['from', 'cases'], ['note', 'migration'])
  if (rule['migration'] !== undefined) {
    const migration = fields(rule['migration'], `${where}.migration`, ['historicalInputs'])
    const historicalInputs = array(migration['historicalInputs'], `${where}.migration.historicalInputs`)
    if (historicalInputs.length === 0) {
      throw new Error(`${where}.migration.historicalInputs must be non-empty`)
    }
    historicalInputs.forEach((input, index) =>
      nonempty(input, `${where}.migration.historicalInputs[${index}]`))
    if (new Set(historicalInputs).size !== historicalInputs.length) {
      throw new Error(`${where}.migration.historicalInputs must be unique`)
    }
  }
  array(rule['cases'], `${where}.cases`).forEach((candidate, index) => {
    const caseWhere = `${where}.cases[${index}]`
    const item = fields(
      candidate,
      caseWhere,
      ['to'],
      ['when', 'nodes', 'slotVariants', 'inputs', 'inputFamilies', 'links', 'outputs', 'outputFamilies'],
    )
    if (item['when'] !== undefined) strictPredicate(item['when'], `${caseWhere}.when`)
    if (item['nodes'] !== undefined) {
      for (const [id, node] of Object.entries(object(item['nodes'], `${caseWhere}.nodes`))) {
        fields(node, `${caseWhere}.nodes.${id}`, ['type'], ['values'])
      }
    }
    if (item['slotVariants'] !== undefined)
      strictSlotVariants(item['slotVariants'], `${caseWhere}.slotVariants`)
    if (item['inputs'] !== undefined) strictMappings(item['inputs'], `${caseWhere}.inputs`)
    if (item['inputFamilies'] !== undefined) {
      for (const [id, mapping] of Object.entries(
        object(item['inputFamilies'], `${caseWhere}.inputFamilies`),
      )) {
        strictFamilyMapping(mapping, `${caseWhere}.inputFamilies.${id}`)
      }
    }
    if (item['links'] !== undefined) {
      array(item['links'], `${caseWhere}.links`).forEach((link, linkIndex) => {
        fields(link, `${caseWhere}.links[${linkIndex}]`, ['from', 'to'])
      })
    }
    if (item['outputs'] !== undefined) object(item['outputs'], `${caseWhere}.outputs`)
    if (item['outputFamilies'] !== undefined) {
      for (const [id, mapping] of Object.entries(
        object(item['outputFamilies'], `${caseWhere}.outputFamilies`),
      )) {
        strictOutputFamilyMapping(mapping, `${caseWhere}.outputFamilies.${id}`)
      }
    }
  })
  if (!isReplacementRule(rule)) throw new Error(`${where} is not a valid ReplacementRule`)
  return rule
}

export const parseComfySourceSchema = (
  value: unknown,
  where: string,
): NodeSchema => {
  const raw = object(value, where)
  const version = raw['schemaVersion']
  const nodeType = nonempty(raw['nodeType'], `${where}.nodeType`)
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error(`${where}.schemaVersion must be an integer`)
  }
  if (version !== DINKSTER_SCHEMA_WIRE_VERSION) {
    throw new Error(`${where}.schemaVersion ${version} is not accepted`)
  }
  if ('replacements' in raw) throw new Error(`${where} must not carry replacements`)
  const decoded = parseDinksterNodes({
    schemaVersion: version,
    nodes: { [nodeType]: raw as DinksterWireSchema },
  })
  if (decoded.diagnostics.length > 0 || decoded.schemas.size !== 1) {
    throw new Error(`${where} is invalid: ${decoded.diagnostics.map((item) => item.message).join('; ')}`)
  }
  return decoded.schemas.get(nodeType)!
}

export const parseComfySource = (value: unknown, where: string): ComfySource => {
  const raw = fields(value, where, ['pack', 'nodeClass', 'nodeType', 'revision'])
  const source: ComfySource = {
    pack: nonempty(raw['pack'], `${where}.pack`),
    nodeClass: nonempty(raw['nodeClass'], `${where}.nodeClass`),
    nodeType: nonempty(raw['nodeType'], `${where}.nodeType`),
    revision: nonempty(raw['revision'], `${where}.revision`),
  }
  if (!isRegistryName(source.pack)) throw new Error(`${where}.pack is invalid`)
  return source
}

export const comfyRevisionDiagnostics = (
  sources: Iterable<Pick<ComfySource, 'pack' | 'revision'>>,
  ownerPack: string,
): Diagnostic[] => {
  const revisions = new Set([...sources]
    .filter((source) => source.pack === 'comfy-core' && source.revision !== COMFY_CORE_REVISION)
    .map((source) => source.revision))
  return [...revisions].map((revision) => diag(
    'warning',
    'schema',
    'schema.comfyRegistry.sourceRevision',
    `pack '${ownerPack}' declares ComfyUI source revision '${revision}', different from frontend reference '${COMFY_CORE_REVISION}'; declared snapshots are accepted`,
  ))
}

export const parseComfyFamily = (value: unknown, where: string): ComfyFamily => {
  const raw = fields(value, where, ['id'], ['provider'])
  const id = nonempty(raw['id'], `${where}.id`)
  if (!isRegistryName(id)) throw new Error(`${where}.id is invalid`)
  const provider = raw['provider'] === undefined
    ? undefined
    : nonempty(raw['provider'], `${where}.provider`)
  if (provider !== undefined && !isRegistryName(provider)) throw new Error(`${where}.provider is invalid`)
  return { id, ...(provider !== undefined ? { provider } : {}) }
}

export const parseComfyConfidence = (value: unknown, where: string): ComfyConfidence => {
  const raw = fields(value, where, ['tier', 'evidence'], ['tolerances'])
  const tier = string(raw['tier'], `${where}.tier`)
  if (!['exact', 'parametric', 'equivalent', 'grouped'].includes(tier)) {
    throw new Error(`${where}.tier is invalid`)
  }
  const evidence = array(raw['evidence'], `${where}.evidence`)
    .map((item, index) => nonempty(item, `${where}.evidence[${index}]`))
  if (evidence.length === 0 || new Set(evidence).size !== evidence.length) {
    throw new Error(`${where}.evidence must be non-empty and unique`)
  }
  const tolerances = raw['tolerances'] === undefined
    ? undefined
    : array(raw['tolerances'], `${where}.tolerances`).map((item, index): ComfyTolerance => {
        const toleranceWhere = `${where}.tolerances[${index}]`
        const tolerance = fields(item, toleranceWhere, ['metric', 'operator', 'value'])
        const operator = string(tolerance['operator'], `${toleranceWhere}.operator`)
        if (operator !== '<=' && operator !== '>=') {
          throw new Error(`${toleranceWhere}.operator is invalid`)
        }
        if (typeof tolerance['value'] !== 'number' || !Number.isFinite(tolerance['value'])) {
          throw new Error(`${toleranceWhere}.value must be finite`)
        }
        return {
          metric: nonempty(tolerance['metric'], `${toleranceWhere}.metric`),
          operator,
          value: tolerance['value'],
        }
      })
  if (tier === 'exact' && tolerances !== undefined) {
    throw new Error(`${where}.tolerances is forbidden for exact confidence`)
  }
  if (tier === 'equivalent' && (tolerances === undefined || tolerances.length === 0)) {
    throw new Error(`${where}.tolerances is required for equivalent confidence`)
  }
  return {
    tier: tier as ComfyConfidenceTier,
    evidence,
    ...(tolerances !== undefined ? { tolerances } : {}),
  }
}
