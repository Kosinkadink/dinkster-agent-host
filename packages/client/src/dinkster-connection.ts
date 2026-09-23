/**
 * DinksterConnection: one native Dinkster server = one connection.
 *
 * Owns the quarantined native protocol surface:
 *   GET    /api/nodes                        schema wire v3 -> SchemaRegistry
 *   GET    /api/workers                      execution-location catalog
 *   POST   /api/jobs                         {clientId, jobId, targets, graph, previews?, placement?}
 *   GET    /api/jobs/{clientId}/{jobId}      job_to_wire (hydration/reconcile)
 *   DELETE /api/jobs/{clientId}/{jobId}      cancel
 *   GET    /api/events?clientId=...          WS, normalized by DinksterNormalizer
 *
 * Everything downstream sees the SAME normalized models and NormalizedEvents
 * as the Comfy-v1 path - protocol choice never leaks past this module.
 *
 * Identity: the client OWNS job ids (server requires a client-supplied
 * jobId); ExecutionRef.prompt = jobId, so submission knows its execution
 * identity before the server responds and WS routing needs no round trip.
 *
 * Prompt lowering: the compiler's artifact carries the flat V1 prompt shape
 * (class_type + [nodeId, outputIndex] link tuples). promptToDinksterGraph
 * converts that to the native graph wire ({nodeType, inputs with $link by
 * OUTPUT ID}) using compiler-owned outputIds, or the schema registry for
 * legacy prompts without them. Region artifacts carry a native graph directly.
 */

import { credentialFetch, mintDelegation, type CollabCredentials, type Delegation, type MintDelegation } from './credentials.js'
import {
  asPromptId,
  canonicalJson,
  comfyAliasCatalogFromDinksterWire,
  comfyGroupCatalogFromDinksterWire,
  decodeEffectiveExtensionSnapshot,
  diag,
  DINKSTER_SCHEMA_WIRE_VERSION,
  DINKSTER_GRAPH_FEATURE_REGIONS,
  DinksterNormalizer,
  decodeDinksterBinaryFrame,
  fnv1a64,
  nodeStatesFromDinksterJob,
  inputsOf,
  outputsOf,
  packsFromDinksterWire,
  parseDinksterNodes,
  sha256Hex,
  graphFeaturesFromDinksterWire,
  mergeableTypesFromDinksterWire,
  serverInfoFromDinksterWire,
  parseOccurrenceKey,
  schemaForEditorRole,
  validateDinksterGraph,
  type CompileArtifact,
  type ConnectionId,
  type Diagnostic,
  type ExecutionArm,
  type DinksterGraphWire,
  type DinksterInputWire,
  type DinksterJobWire,
  type DinksterNodesPayload,
  type DinksterRawJson,
  type DinksterRawMessage,
  type ExecutionRef,
  type EffectiveExtensionSnapshot,
  type InputSpec,
  type Json,
  type JsonObject,
  type NodeSchema,
  type NormalizedEvent,
  type PreviewMode,
  type Prompt,
  type ReadonlySignal,
  type SchemaResolver,
  type WorkflowDocument,
  loadDocument,
} from '@dinkster/core'
import type { FetchLike, SchemaRegistry, SubmitResult } from './connection-contract.js'
import type { ExecutionArtifact, ExecutionSubmitter } from './execution-store.js'
import { EngineNotReadyError, parseEngineNotReady } from './supervisor.js'
import {
  ReconnectingSocket,
  type CancelFn,
  type ConnectionStatus,
  type ScheduleFn,
  type WebSocketFactory,
} from './reconnecting-socket.js'
import { DinksterValuesClient } from './values.js'
import { expandDynamicPrompt } from './dynamic-prompts.js'

/** Existing /api/nodes capability flag for the placement submission sidecar. */
export const DINKSTER_GRAPH_FEATURE_PLACEMENT = 'placement'

// ---------------------------------------------------------------------------
// Prompt -> native graph wire
// ---------------------------------------------------------------------------

export type PromptToGraphResult =
  | { readonly ok: true; readonly graph: DinksterGraphWire }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/** A V1 link is exactly a [producerId, outputIndex] tuple (compiler output). */
const asLinkTuple = (v: unknown): readonly [string, number] | undefined =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
    ? (v as [string, number])
    : undefined

type MaterializedPathKind = 'combo' | 'other' | 'missing'

/** Classify a materialized path through only the stored active branches. */
function materializedPathKind(
  inputs: readonly InputSpec[],
  parts: readonly string[],
  choices: Readonly<Record<string, string>>,
  prefix: readonly string[] = [],
): MaterializedPathKind {
  if (parts.length === 0) return 'missing'
  const input = inputs.find((candidate) => candidate.id === parts[0])
  if (input === undefined) return 'missing'
  const rest = parts.slice(1)
  const path = [...prefix, input.id]
  const construct = path.join('.')
  const dynamic = input.dynamic
  if (dynamic?.kind === 'dynamicCombo') {
    const selected = choices[construct]
    const active = dynamic.materialization === 'wire15'
      ? dynamic.options.find((option) => option.key === selected)
      : undefined
    if (active === undefined) return 'other'
    return rest.length === 0
      ? 'combo'
      : materializedPathKind(active.inputs, rest, choices, path)
  }
  if (dynamic?.kind === 'autogrow') {
    return rest.length >= 2
      ? materializedPathKind(dynamic.template, rest.slice(1), choices, [...path, rest[0]!])
      : 'other'
  }
  if (dynamic?.kind === 'dynamicSlot') {
    if (rest.length === 0) return 'other'
    const shared = materializedPathKind(dynamic.inputs, rest, choices, path)
    if (shared !== 'missing') return shared
    const selected = choices[construct]
    const active = dynamic.variants?.find((variant) => variant.key === selected)
    return active === undefined
      ? 'missing'
      : materializedPathKind(active.inputs, rest, choices, path)
  }
  return rest.length === 0 ? 'other' : 'missing'
}

/**
 * Convert a compiled V1 prompt to the native Dinkster graph wire. Link tuples
 * become {$link: {node, output}} by indexing compiler-owned outputIds; only
 * legacy prompts use the catalog's declared outputs. DynamicCombo selectors stay in the V1
 * prompt but move to slotVariants instead of remaining native inputs.
 */
export function promptToDinksterGraph(prompt: Prompt, resolve: SchemaResolver): PromptToGraphResult {
  const nodes: Record<string, { nodeType: string; inputs: Record<string, DinksterInputWire>; outputMembers?: Readonly<Record<string, readonly string[]>>; slotVariants?: Readonly<Record<string, string>> }> = {}
  const diagnostics: Diagnostic[] = []
  const compilerOutputs = new Map<string, readonly string[]>()
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (node.outputIds === undefined) continue
    const ids: unknown = node.outputIds
    if (!Array.isArray(ids) ||
        Array.from(ids).some((id) => typeof id !== 'string' || id.trim().length === 0) ||
        new Set(ids).size !== ids.length) {
      diagnostics.push(diag('error', 'compile', 'submit.invalidOutputIds',
        `node '${nodeId}' has malformed compiler outputIds; expected unique non-empty strings`))
    } else {
      compilerOutputs.set(nodeId, ids)
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  for (const [nodeId, node] of Object.entries(prompt)) {
    const inputs: Record<string, DinksterInputWire> = {}
    const nodeSchema = resolve(node.class_type)
    for (const [inputId, value] of Object.entries(node.inputs)) {
      if (nodeSchema !== undefined &&
          materializedPathKind(inputsOf(nodeSchema), inputId.split('.'), node.slotVariants ?? {}) === 'combo') continue
      const link = asLinkTuple(value)
      if (link === undefined) {
        inputs[inputId] = value
        continue
      }
      const [producerId, outputIndex] = link
      const producer = prompt[producerId]
      const schema = producer ? resolve(producer.class_type) : undefined
      const outputIds = compilerOutputs.get(producerId) ?? (schema === undefined || producer === undefined
        ? []
        : outputsOf(schema).flatMap((output) => {
            const members = producer.outputMembers?.[output.id]
            return members === undefined ? [output.id] : members.map((suffix) => `${output.id}.${suffix}`)
          }))
      const outputId = Number.isSafeInteger(outputIndex) && outputIndex >= 0 ? outputIds[outputIndex] : undefined
      if (producer === undefined || outputId === undefined) {
        diagnostics.push(
          diag(
            'error',
            'compile',
            'submit.unresolvedLink',
            producer === undefined
              ? `node '${nodeId}' input '${inputId}' links to missing node '${producerId}'`
              : `node '${nodeId}' input '${inputId}' links to '${producer.class_type}' output #${outputIndex}, which its ${compilerOutputs.has(producerId) ? 'compiler outputIds' : 'schema'} does not declare`,
          ),
        )
        continue
      }
      inputs[inputId] = { $link: { node: producerId, output: outputId } }
    }
    // Stored dynamic choices pass through verbatim; the compiler owns their
    // materialized paths and validation.
    nodes[nodeId] = { nodeType: node.class_type, inputs, ...(node.outputMembers ? { outputMembers: node.outputMembers } : {}), ...(node.slotVariants ? { slotVariants: node.slotVariants } : {}) }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, graph: { nodes } }
}

export function expandDynamicPromptsInGraph(
  graph: DinksterGraphWire,
  resolve: SchemaResolver,
  random: () => number = Math.random,
  enabledInputs?: ReadonlySet<string>,
  prefix: readonly string[] = [],
): DinksterGraphWire {
  const nodes = Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, entry]) => {
    const runtimeId = [...prefix, nodeId].join('.')
    const expandInputs = (inputs: Readonly<Record<string, DinksterInputWire>>, dynamicInputs: ReadonlySet<string>): Record<string, DinksterInputWire> =>
      Object.fromEntries(Object.entries(inputs).map(([inputId, value]) => [
        inputId,
        (enabledInputs?.has(`${runtimeId}\u0000${inputId}`) ?? dynamicInputs.has(inputId)) && typeof value === 'string'
          ? expandDynamicPrompt(value, random)
          : value,
      ]))
    if ('region' in entry) return [nodeId, {
      ...entry,
      region: {
        ...entry.region,
        inputs: expandInputs(entry.region.inputs, new Set()),
        body: expandDynamicPromptsInGraph(entry.region.body, resolve, random, enabledInputs, [...prefix, nodeId]),
      },
    }]
    const schema = resolve(entry.nodeType)
    if (schema === undefined) return [nodeId, entry]
    const dynamicInputs = new Set(inputsOf(schema)
      .filter((input) => input.widget?.options['dynamicPrompts'] === true)
      .map((input) => input.id))
    if (dynamicInputs.size === 0 && enabledInputs === undefined) return [nodeId, entry]
    const inputs = expandInputs(entry.inputs, dynamicInputs)
    return [nodeId, { ...entry, inputs }]
  }))
  return { nodes }
}

export function dynamicPromptInputsForArtifact(
  artifact: CompileArtifact,
): ReadonlySet<string> {
  const enabled = new Set<string>()
  for (const [runtimeId, inputs] of Object.entries(artifact.provenance.dynamicPromptInputs ?? {})) {
    for (const input of inputs) enabled.add(`${runtimeId}\u0000${input}`)
  }
  return enabled
}

/**
 * Execution targets for a submit: explicit partial targets when the scope is
 * partial, otherwise every runtime node whose schema is an output node
 * (Dinkster requires explicit, non-empty targets - there is no "run whatever
 * looks terminal" server heuristic).
 */
export function targetsForArtifact(
  artifact: CompileArtifact,
  resolve: SchemaResolver,
): readonly string[] {
  if (artifact.dinksterTargets !== undefined) return artifact.dinksterTargets
  if (artifact.partialTargets !== undefined) return artifact.partialTargets
  return Object.entries(artifact.prompt)
    .filter(([, node]) => resolve(node.class_type)?.isOutputNode === true)
    .map(([id]) => id)
}

// ---------------------------------------------------------------------------
// Diagnostics (GET /api/diagnostics)
// ---------------------------------------------------------------------------

/**
 * Live sampling preview spend for a run (backend PR #407). Defined in
 * @dinkster/core beside the document override fields; re-exported here because
 * this module owns the wire that carries it.
 */
export type { PreviewMode } from '@dinkster/core'

/**
 * One replacement rule the server could not validate against its installed
 * schemas (backend commit 10fd519). Advisory: the rule still ships on the
 * wire and schemas stay loadable; this explains WHY planning against this
 * environment will fail.
 */
export interface ReplacementProblem {
  /** Schema whose wire entry carries the rule. */
  readonly carrier: string
  /** The rule's predecessor type (rule "from"). */
  readonly from: string
  readonly caseIndex: number
  /** The invalid static interface id. */
  readonly ref: string
  /** Which id namespace was checked. */
  readonly refKind: 'input' | 'output'
  /** Schema the ref was checked against (predecessor or the case's "to"). */
  readonly target: string
  /** Full human-readable explanation. */
  readonly message: string
}

/**
 * One ComfyUI compatibility node the server refused to translate into the
 * native catalog. Advisory: the source node is absent from the catalog, and
 * reason is presentation text rather than a client-side parse contract.
 */
export interface CompatSkip {
  readonly packId: string
  readonly nodeId: string
  readonly reason: string
}

export interface DinksterDiagnostics {
  readonly replacementProblems: readonly ReplacementProblem[]
  readonly compatSkips: readonly CompatSkip[]
  readonly packInferenceUnavailable: readonly PackInferenceUnavailable[]
}

/**
 * A pack whose declared inference entries could not bind: its nodes, routes
 * and events composed normally, but no native sampling worker was live at
 * composition, so plan-time use of its sampler/scheduler ids is refused at
 * composition time (the server's inference.worker-required doctor finding).
 * Decoded from /api/diagnostics' packInferenceUnavailable list; each row names
 * its pack in its own ``packId`` field.
 */
export interface PackInferenceUnavailable {
  readonly pack: string
  readonly reason: string
  readonly entry?: string
  readonly worker?: string
  readonly providers: readonly { readonly registry: string; readonly id: string }[]
}

function emptyDiagnostics(): DinksterDiagnostics {
  return { replacementProblems: [], compatSkips: [], packInferenceUnavailable: [] }
}

function readUnavailableInference(value: unknown): Omit<PackInferenceUnavailable, 'pack'> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['reason'] !== 'string') return undefined
  if (record['entry'] !== undefined && typeof record['entry'] !== 'string') return undefined
  if (record['worker'] !== undefined && typeof record['worker'] !== 'string') return undefined
  const providers = record['providers']
  if (!Array.isArray(providers)) return undefined
  const readable = providers.every((provider) => {
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return false
    const row = provider as Record<string, unknown>
    return typeof row['registry'] === 'string' && typeof row['id'] === 'string'
  })
  if (!readable) return undefined
  return {
    reason: record['reason'],
    ...(typeof record['entry'] === 'string' ? { entry: record['entry'] } : {}),
    ...(typeof record['worker'] === 'string' ? { worker: record['worker'] } : {}),
    providers: providers.map((provider) => {
      const row = provider as { registry: string; id: string }
      return { registry: row.registry, id: row.id }
    }),
  }
}

/** One process-lifetime pack failure retained by GET /api/composition. */
export interface DinksterPackFailure {
  readonly pack: string
  readonly error: string
}

export type RuntimeSettingSource = 'cli' | 'persisted' | 'config' | 'default' | 'runtime'
export type RuntimeSettingMutability = 'live' | 'on-worker-restart'

export interface RuntimeSettingSection {
  readonly value: unknown
  readonly source: RuntimeSettingSource
  readonly mutability: RuntimeSettingMutability
  readonly writable: boolean
  readonly persistence: {
    readonly available: boolean
    readonly persisted: boolean
  }
}

export interface RuntimeSettings {
  readonly categories: {
    readonly granted: readonly string[]
    readonly available: readonly string[]
  }
  readonly settings: Readonly<Record<string, RuntimeSettingSection>>
}

export interface PackSettingSchema {
  readonly type: 'string' | 'integer' | 'number' | 'boolean'
  readonly title: string
  readonly description?: string
  readonly default: string | number | boolean
  readonly enum?: readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly multipleOf?: number
}

export interface PackSettings {
  readonly packId: string
  readonly displayName: string
  readonly schema: {
    readonly type: 'object'
    readonly additionalProperties: false
    readonly properties: Readonly<Record<string, PackSettingSchema>>
    readonly required: readonly string[]
  }
  readonly values: Readonly<Record<string, string | number | boolean>>
}

function validPackSettingValue(field: PackSettingSchema, value: unknown): value is string | number | boolean {
  if (field.type === 'string') return typeof value === 'string' && (field.enum === undefined || field.enum.includes(value))
  if (field.type === 'boolean') return typeof value === 'boolean'
  if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value))) return false
  return (field.minimum === undefined || value >= field.minimum)
    && (field.maximum === undefined || value <= field.maximum)
    && (field.multipleOf === undefined || Math.abs(value / field.multipleOf - Math.round(value / field.multipleOf)) <= 1e-12)
}

function decodePackSettings(raw: unknown): PackSettings | undefined {
  if (!record(raw) || !exactKeys(raw, ['packId', 'displayName', 'schema', 'values'])
    || typeof raw['packId'] !== 'string' || raw['packId'] === ''
    || typeof raw['displayName'] !== 'string' || raw['displayName'] === ''
    || !record(raw['schema']) || !record(raw['values'])) return undefined
  const schema = raw['schema']
  if (!exactKeys(schema, ['type', 'additionalProperties', 'properties', 'required'])
    || schema['type'] !== 'object' || schema['additionalProperties'] !== false
    || !record(schema['properties']) || !Array.isArray(schema['required'])) return undefined
  const schemaProperties = schema['properties']
  const required = schema['required']
  if (!required.every((name): name is string => typeof name === 'string')
    || required.length !== Object.keys(schemaProperties).length
    || required.some((name, index) => name !== Object.keys(schemaProperties)[index])) return undefined
  const properties: Record<string, PackSettingSchema> = {}
  for (const [name, candidate] of Object.entries(schemaProperties)) {
    if (!record(candidate)
      || !requiredAndOptionalKeys(candidate, ['type', 'title', 'default'], ['description', 'enum', 'minimum', 'maximum', 'multipleOf'])
      || typeof candidate['title'] !== 'string' || candidate['title'] === ''
      || !['string', 'integer', 'number', 'boolean'].includes(String(candidate['type']))
      || !Object.hasOwn(candidate, 'default')) return undefined
    const type = candidate['type'] as PackSettingSchema['type']
    if ((candidate['description'] !== undefined && typeof candidate['description'] !== 'string')
      || (candidate['enum'] !== undefined && (!Array.isArray(candidate['enum']) || !candidate['enum'].every((value) => typeof value === 'string')))
      || (candidate['enum'] !== undefined && (type !== 'string' || new Set(candidate['enum']).size !== candidate['enum'].length))
      || ['minimum', 'maximum', 'multipleOf'].some((key) => candidate[key] !== undefined && (typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key])))
      || (type === 'string' || type === 'boolean') && ['minimum', 'maximum', 'multipleOf'].some((key) => candidate[key] !== undefined)
      || typeof candidate['multipleOf'] === 'number' && candidate['multipleOf'] <= 0
      || typeof candidate['minimum'] === 'number' && typeof candidate['maximum'] === 'number' && candidate['minimum'] > candidate['maximum']) return undefined
    const field = candidate as unknown as PackSettingSchema
    if (!validPackSettingValue(field, candidate['default'])) return undefined
    properties[name] = field
  }
  const values: Record<string, string | number | boolean> = {}
  if (Object.keys(raw['values']).length !== required.length) return undefined
  for (const name of required) {
    const field = properties[name]
    const value = raw['values'][name]
    if (field === undefined || !validPackSettingValue(field, value)) return undefined
    values[name] = value
  }
  return {
    packId: raw['packId'],
    displayName: raw['displayName'],
    schema: { type: 'object', additionalProperties: false, properties, required },
    values,
  }
}

export interface P2PSettings {
  readonly downloadsEnabled: boolean
  readonly seedingEnabled: boolean
  readonly scope: 'lan-only' | 'lan-and-internet'
  readonly internetUploadBytesPerSecond: number
  readonly internetDownloadBytesPerSecond: number
  readonly lanUploadBytesPerSecond: number
  readonly lanDownloadBytesPerSecond: number
  readonly pauseOnMetered: boolean
  readonly networkCostOverride: 'auto' | 'metered' | 'unmetered'
  readonly seedMode: 'budgeted' | 'continuous'
  readonly internetSeedRatio: number
  readonly internetSeedTimeSeconds: number
  readonly stagingBudgetBytes: number
}

export type P2PTransferAction = 'pause' | 'resume' | 'stop' | 'remove-partial' | 'reset-budget' | 'continuous-seed'
export interface P2PSeedGrant {
  readonly version: 1
  readonly grantId: string
  readonly digest: string
  readonly sourceType: 'official-provider' | 'declarative-resolver' | 'code-resolver' | 'manual'
  readonly sourceId: string
  readonly sourceRevision: string
  readonly license: string
  readonly descriptor: {
    readonly protocol: 'bittorrent-v2'
    readonly infoHash: string
    readonly fileRoot: string
    readonly pieceLength: 8388608
  }
  readonly expiresAt: number
  readonly evidenceType: 'public-acquisition-receipt' | 'provider-enumeration' | 'consented-set' | 'manual-attestation'
  readonly evidenceId: string
}
export interface P2PSeedAuthorization {
  readonly grantId: string
  readonly state: 'active' | 'inactive' | 'revoked'
  readonly grant: P2PSeedGrant | null
}
export interface P2PTransferActivity {
  readonly digest: string
  readonly state: 'queued' | 'downloading' | 'seeding' | 'paused' | 'stopped' | 'complete' | 'error'
  readonly sizeBytes: number
  readonly peers: number
  readonly downloadRateBytesPerSecond: number
  readonly uploadRateBytesPerSecond: number
  readonly downloadedBytes: number
  readonly uploadedBytes: number
  readonly partialBytes: number
  readonly seedAuthorizations: readonly P2PSeedAuthorization[]
  readonly remainingSeedRatio: number | null
  readonly remainingSeedTimeSeconds: number | null
}
export interface P2PNetworkStatus {
  readonly system: 'metered' | 'unmetered' | 'unknown'
  readonly override: 'auto' | 'metered' | 'unmetered'
  readonly effective: 'metered' | 'unmetered' | 'unknown'
  readonly paused: boolean
}
export interface P2PLeaseStatus {
  readonly leaseId: string
  readonly kind: 'download' | 'seed'
  readonly digest: string
  readonly scope: 'lan-only' | 'lan-and-internet'
  readonly expiresAt: number
  readonly state: 'disabled' | 'expired' | 'paused' | 'inactive' | 'checking' | 'downloading' | 'publishing' | 'complete' | 'failed' | 'ready'
  readonly durableBytes?: number
  readonly verifiedBytes?: number
  readonly error?: string
  readonly path?: string
}
export interface P2PSidecarStatus {
  readonly version: number
  readonly state: 'running' | 'paused'
  readonly pid: number
  readonly capabilities: { readonly downloads: boolean; readonly seeding: boolean }
  readonly libtorrentVersion: string
  readonly listenPort: number | null
  readonly listenInterfaces: readonly string[]
  readonly networkPaused: boolean
  readonly networkFeatures: {
    readonly dht: boolean
    readonly trackers: boolean
    readonly pex: boolean
    readonly lsd: boolean
    readonly upnp: boolean
    readonly natMappings: boolean
    readonly tcp?: boolean
    readonly utp?: boolean
    readonly natPmp?: boolean
    readonly pcp?: boolean
  }
  readonly global?: {
    readonly active: boolean
    readonly listenPort: number | null
    readonly closureReason: string | null
    readonly networkFeatures: Readonly<Record<'dht' | 'pex' | 'tcp' | 'utp' | 'trackers' | 'upnp' | 'natMappings' | 'natPmp' | 'pcp', boolean>>
    readonly transfers: readonly {
      readonly leaseId: string
      readonly digest: string
      readonly kind: 'download' | 'seed'
      readonly state: P2PTransferActivity['state'] | 'publishing' | 'failed'
      readonly peers: number
      readonly downloadRateBytesPerSecond: number
      readonly uploadRateBytesPerSecond: number
      readonly downloadedBytes: number
      readonly uploadedBytes: number
      readonly activeSeedSeconds: number
      readonly path?: string
      readonly error?: string
    }[]
  } | null
  readonly leases: readonly P2PLeaseStatus[]
  readonly totals: { readonly downloadedBytes: number; readonly uploadedBytes: number }
  readonly transfers: readonly P2PTransferActivity[]
  readonly recovery: {
    readonly state: 'corrupt-state-quarantined' | 'global-session-closed'
    readonly files: readonly string[]
    readonly error: string
  } | null
}
export interface P2PStatus {
  readonly state: 'disabled' | 'starting' | 'running' | 'restarting' | 'failed'
  readonly settings: P2PSettings
  readonly restartCount: number
  readonly lastError: string | null
  readonly sidecar: P2PSidecarStatus | null
  readonly network: P2PNetworkStatus
  readonly lan: {
    readonly networkAllowed: boolean
    readonly mappingPort: number | null
    readonly mappedDigests: readonly string[]
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integerNonnegative = (value: unknown): value is number => finiteNonnegative(value) && Number.isInteger(value)
const p2pIntegerSetting = (value: unknown): value is number => integerNonnegative(value) && value <= 2_147_483_647
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && values.includes(value as T)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const requiredAndOptionalKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
const p2pDigest = (value: unknown): value is string => typeof value === 'string' && /^blake3:[0-9a-f]{64}$/.test(value)
const p2pGrantId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const P2P_SETTINGS_KEYS = [
  'downloadsEnabled', 'seedingEnabled', 'scope', 'internetUploadBytesPerSecond',
  'internetDownloadBytesPerSecond', 'lanUploadBytesPerSecond', 'lanDownloadBytesPerSecond',
  'pauseOnMetered', 'networkCostOverride', 'seedMode', 'internetSeedRatio',
  'internetSeedTimeSeconds', 'stagingBudgetBytes',
] as const
export function decodeP2PSettings(value: unknown): value is P2PSettings {
  return record(value) && exactKeys(value, P2P_SETTINGS_KEYS)
    && typeof value['downloadsEnabled'] === 'boolean'
    && typeof value['seedingEnabled'] === 'boolean'
    && oneOf(value['scope'], ['lan-only', 'lan-and-internet'] as const)
    && p2pIntegerSetting(value['internetUploadBytesPerSecond'])
    && p2pIntegerSetting(value['internetDownloadBytesPerSecond'])
    && p2pIntegerSetting(value['lanUploadBytesPerSecond'])
    && p2pIntegerSetting(value['lanDownloadBytesPerSecond'])
    && typeof value['pauseOnMetered'] === 'boolean'
    && oneOf(value['networkCostOverride'], ['auto', 'metered', 'unmetered'] as const)
    && oneOf(value['seedMode'], ['budgeted', 'continuous'] as const)
    && finiteNonnegative(value['internetSeedRatio'])
    && p2pIntegerSetting(value['internetSeedTimeSeconds'])
    && integerNonnegative(value['stagingBudgetBytes']) && Number.isSafeInteger(value['stagingBudgetBytes'])
}
function decodeP2PSeedGrant(value: unknown, digest: string, grantId: string): P2PSeedGrant | undefined {
  if (!record(value) || !exactKeys(value, [
    'version', 'grantId', 'digest', 'sourceType', 'sourceId', 'sourceRevision', 'license', 'descriptor',
    'expiresAt', 'evidenceType', 'evidenceId',
  ]) || value['version'] !== 1 || value['grantId'] !== grantId || value['digest'] !== digest
    || !oneOf(value['sourceType'], ['official-provider', 'declarative-resolver', 'code-resolver', 'manual'] as const)
    || !nonemptyString(value['sourceId']) || !nonemptyString(value['sourceRevision'])
    || typeof value['license'] !== 'string' || !finiteNonnegative(value['expiresAt'])
    || !oneOf(value['evidenceType'], ['public-acquisition-receipt', 'provider-enumeration', 'consented-set', 'manual-attestation'] as const)
    || !nonemptyString(value['evidenceId']) || !record(value['descriptor'])) return undefined
  const evidenceForSource = {
    'official-provider': 'provider-enumeration',
    'declarative-resolver': 'public-acquisition-receipt',
    'code-resolver': 'consented-set',
    manual: 'manual-attestation',
  } as const
  if (value['evidenceType'] !== evidenceForSource[value['sourceType']]) return undefined
  const descriptor = value['descriptor']
  if (!exactKeys(descriptor, ['protocol', 'infoHash', 'fileRoot', 'pieceLength'])
    || descriptor['protocol'] !== 'bittorrent-v2'
    || !p2pGrantId(descriptor['infoHash'])
    || !p2pGrantId(descriptor['fileRoot'])
    || descriptor['pieceLength'] !== 8388608) return undefined
  return value as unknown as P2PSeedGrant
}
function decodeP2PStatus(value: unknown): P2PStatus | undefined {
  if (!record(value) || !exactKeys(value, ['state', 'settings', 'restartCount', 'lastError', 'sidecar', 'network', 'lan'])
    || !oneOf(value['state'], ['disabled', 'starting', 'running', 'restarting', 'failed'] as const)
    || !decodeP2PSettings(value['settings']) || !integerNonnegative(value['restartCount'])
    || (value['lastError'] !== null && typeof value['lastError'] !== 'string')
    || (value['sidecar'] !== null && !record(value['sidecar']))
    || !record(value['network']) || !record(value['lan'])) return undefined
  const network = value['network']
  if (!exactKeys(network, ['system', 'override', 'effective', 'paused'])
    || !oneOf(network['system'], ['metered', 'unmetered', 'unknown'] as const)
    || !oneOf(network['override'], ['auto', 'metered', 'unmetered'] as const)
    || !oneOf(network['effective'], ['metered', 'unmetered', 'unknown'] as const)
    || typeof network['paused'] !== 'boolean') return undefined
  const lan = value['lan']
  if (!exactKeys(lan, ['networkAllowed', 'mappingPort', 'mappedDigests'])
    || typeof lan['networkAllowed'] !== 'boolean'
    || (lan['mappingPort'] !== null && (!integerNonnegative(lan['mappingPort']) || lan['mappingPort'] === 0 || lan['mappingPort'] > 65535))
    || !Array.isArray(lan['mappedDigests']) || !lan['mappedDigests'].every(p2pDigest)
    || new Set(lan['mappedDigests']).size !== lan['mappedDigests'].length) return undefined
  const enabled = value['settings']['downloadsEnabled'] || value['settings']['seedingEnabled']
  const expectedEffective = network['override'] === 'auto' ? network['system'] : network['override']
  if (network['effective'] !== expectedEffective || (!enabled && network['paused'])
    || lan['networkAllowed'] !== !network['paused']
    || (!lan['networkAllowed'] && (lan['mappingPort'] !== null || lan['mappedDigests'].length !== 0))) return undefined
  if (value['sidecar'] === null) {
    if (value['state'] === 'running' || (value['state'] === 'disabled') !== !enabled) return undefined
    return value as unknown as P2PStatus
  }
  const sidecar = value['sidecar']
  if (!requiredAndOptionalKeys(sidecar, [
    'version', 'state', 'pid', 'capabilities', 'libtorrentVersion', 'listenPort', 'listenInterfaces', 'networkPaused',
    'networkFeatures', 'leases', 'totals', 'transfers', 'recovery',
  ], ['global']) || !integerNonnegative(sidecar['version'])
    || !oneOf(sidecar['state'], ['running', 'paused'] as const)
    || !integerNonnegative(sidecar['pid']) || !nonemptyString(sidecar['libtorrentVersion'])
    || (sidecar['listenPort'] !== null && (!integerNonnegative(sidecar['listenPort']) || sidecar['listenPort'] > 65535))
    || !Array.isArray(sidecar['listenInterfaces']) || !sidecar['listenInterfaces'].every(nonemptyString)
    || new Set(sidecar['listenInterfaces']).size !== sidecar['listenInterfaces'].length
    || typeof sidecar['networkPaused'] !== 'boolean'
    || !record(sidecar['capabilities'])
    || !exactKeys(sidecar['capabilities'], ['downloads', 'seeding'])
    || typeof sidecar['capabilities']['downloads'] !== 'boolean'
    || typeof sidecar['capabilities']['seeding'] !== 'boolean'
    || !record(sidecar['networkFeatures'])
    || !(exactKeys(sidecar['networkFeatures'], ['dht', 'trackers', 'pex', 'lsd', 'upnp', 'natMappings'])
      || exactKeys(sidecar['networkFeatures'], ['dht', 'trackers', 'pex', 'lsd', 'upnp', 'natMappings', 'tcp', 'utp', 'natPmp', 'pcp']))
    || !Object.values(sidecar['networkFeatures']).every((item) => typeof item === 'boolean')
    || !Array.isArray(sidecar['leases']) || !record(sidecar['totals'])
    || !Array.isArray(sidecar['transfers'])) return undefined
  if (value['state'] !== 'running' || !enabled
    || sidecar['capabilities']['downloads'] !== value['settings']['downloadsEnabled']
    || sidecar['capabilities']['seeding'] !== value['settings']['seedingEnabled']
    || sidecar['networkPaused'] !== network['paused']
    || (network['paused'] && sidecar['state'] !== 'paused')) return undefined
  const global = sidecar['global']
  if (global !== undefined && global !== null) {
    if (!record(global) || !exactKeys(global, ['active', 'listenPort', 'closureReason', 'networkFeatures', 'transfers'])
      || typeof global['active'] !== 'boolean'
      || (global['listenPort'] !== null && (!integerNonnegative(global['listenPort']) || global['listenPort'] === 0 || global['listenPort'] > 65535))
      || (global['closureReason'] !== null && !nonemptyString(global['closureReason']))
      || (global['active'] && (global['closureReason'] !== null || network['paused'] || value['settings']['scope'] !== 'lan-and-internet'))
      || !record(global['networkFeatures'])
      || !exactKeys(global['networkFeatures'], ['dht', 'pex', 'tcp', 'utp', 'trackers', 'upnp', 'natMappings', 'natPmp', 'pcp'])
      || !Object.values(global['networkFeatures']).every((item) => typeof item === 'boolean')
      || (!global['active'] && (global['listenPort'] !== null || Object.values(global['networkFeatures']).some(Boolean)))
      || !Array.isArray(global['transfers'])) return undefined
    const leaseIds = new Set<string>()
    for (const row of global['transfers']) {
      if (!record(row) || !requiredAndOptionalKeys(row,
        ['leaseId', 'digest', 'kind', 'state', 'peers', 'downloadRateBytesPerSecond', 'uploadRateBytesPerSecond', 'downloadedBytes', 'uploadedBytes', 'activeSeedSeconds'],
        ['path', 'error'])
        || !nonemptyString(row['leaseId']) || leaseIds.has(row['leaseId']) || !p2pDigest(row['digest'])
        || !oneOf(row['kind'], ['download', 'seed'] as const)
        || !oneOf(row['state'], ['queued', 'downloading', 'seeding', 'paused', 'stopped', 'complete', 'error', 'publishing', 'failed'] as const)
        || !['peers', 'downloadRateBytesPerSecond', 'uploadRateBytesPerSecond', 'downloadedBytes', 'uploadedBytes', 'activeSeedSeconds'].every((key) => integerNonnegative(row[key]))
        || (row['path'] !== undefined && !nonemptyString(row['path']))
        || (row['error'] !== undefined && !nonemptyString(row['error']))) return undefined
      leaseIds.add(row['leaseId'])
    }
  }
  for (const lease of sidecar['leases']) {
    if (!record(lease) || !requiredAndOptionalKeys(
      lease,
      ['leaseId', 'kind', 'digest', 'scope', 'expiresAt', 'state'],
      ['durableBytes', 'verifiedBytes', 'error', 'path'],
    )
      || !nonemptyString(lease['leaseId']) || !oneOf(lease['kind'], ['download', 'seed'] as const)
      || !p2pDigest(lease['digest']) || !oneOf(lease['scope'], ['lan-only', 'lan-and-internet'] as const)
      || !finiteNonnegative(lease['expiresAt'])
      || !oneOf(lease['state'], ['disabled', 'expired', 'paused', 'inactive', 'checking', 'downloading', 'publishing', 'complete', 'failed', 'ready'] as const)
      || (lease['durableBytes'] !== undefined && (lease['kind'] !== 'download' || !integerNonnegative(lease['durableBytes'])))
      || (lease['verifiedBytes'] !== undefined && (lease['kind'] !== 'download' || !integerNonnegative(lease['verifiedBytes'])))
      || (lease['error'] !== undefined && !nonemptyString(lease['error']))
      || (lease['path'] !== undefined && !nonemptyString(lease['path']))) return undefined
  }
  const recovery = sidecar['recovery']
  if (recovery !== null && (!record(recovery)
    || !exactKeys(recovery, ['state', 'files', 'error'])
    || !oneOf(recovery['state'], ['corrupt-state-quarantined', 'global-session-closed'] as const)
    || !Array.isArray(recovery['files']) || !recovery['files'].every((item) => typeof item === 'string')
    || typeof recovery['error'] !== 'string')) return undefined
  const totals = sidecar['totals']
  if (!exactKeys(totals, ['downloadedBytes', 'uploadedBytes'])
    || !integerNonnegative(totals['downloadedBytes'])
    || !integerNonnegative(totals['uploadedBytes'])) return undefined
  const digests = new Set<string>()
  for (const item of sidecar['transfers']) {
    if (!record(item) || !exactKeys(item, [
      'digest', 'state', 'sizeBytes', 'peers', 'downloadRateBytesPerSecond', 'uploadRateBytesPerSecond',
      'downloadedBytes', 'uploadedBytes', 'partialBytes', 'seedAuthorizations', 'remainingSeedRatio',
      'remainingSeedTimeSeconds',
    ]) || !p2pDigest(item['digest']) || digests.has(item['digest'])
      || !oneOf(item['state'], ['queued', 'downloading', 'seeding', 'paused', 'stopped', 'complete', 'error'] as const)
      || !['sizeBytes', 'peers', 'downloadRateBytesPerSecond', 'uploadRateBytesPerSecond', 'downloadedBytes', 'uploadedBytes', 'partialBytes'].every((key) => integerNonnegative(item[key]))
      || !Array.isArray(item['seedAuthorizations'])
      || (item['remainingSeedRatio'] !== null && !finiteNonnegative(item['remainingSeedRatio']))
      || (item['remainingSeedTimeSeconds'] !== null && !integerNonnegative(item['remainingSeedTimeSeconds']))) return undefined
    digests.add(item['digest'])
    const grantIds = new Set<string>()
    for (const authorization of item['seedAuthorizations']) {
      if (!record(authorization) || !exactKeys(authorization, ['grantId', 'state', 'grant'])
        || !p2pGrantId(authorization['grantId']) || grantIds.has(authorization['grantId'])
        || !oneOf(authorization['state'], ['active', 'inactive', 'revoked'] as const)) return undefined
      grantIds.add(authorization['grantId'])
      const grant = authorization['grant'] === null
        ? undefined
        : decodeP2PSeedGrant(authorization['grant'], item['digest'], authorization['grantId'])
      if ((authorization['grant'] !== null && grant === undefined)
        || (authorization['state'] === 'revoked') !== (grant === undefined)) return undefined
    }
  }
  return value as unknown as P2PStatus
}

export class P2PRequestError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly code?: string,
    readonly serverMessage?: string,
  ) {
    super(serverMessage ?? `${operation} failed: ${status}`)
  }
}

async function p2pRequestError(response: Response, operation: string): Promise<P2PRequestError> {
  const value: unknown = await response.json().catch(() => undefined)
  const envelope = record(value) && record(value['error']) ? value['error'] : undefined
  const code = envelope !== undefined && typeof envelope['code'] === 'string' ? envelope['code'] : undefined
  const message = envelope !== undefined && typeof envelope['message'] === 'string' ? envelope['message'] : undefined
  return new P2PRequestError(response.status, operation, code, message)
}

export interface MemoryMeasurement {
  readonly freeBytes: number
  readonly totalBytes: number
}

export interface MemoryGovernorDevice {
  readonly budgetBytes: number | null
  readonly reservedBytes: number
  readonly consumerFootprintBytes: number
  readonly availableBytes: number | null
  readonly measured: MemoryMeasurement | null
  readonly consumers: Readonly<Record<string, number>>
}

export interface MemoryConsumerItem {
  readonly itemId: string
  readonly displayName: string
  readonly bytesByResidency: Readonly<Record<string, number>>
  readonly pages?: { readonly pageBytes: number; readonly pageCount: number; readonly flags: readonly number[] }
}

export interface MemoryStatus {
  readonly devices: Readonly<Record<string, { readonly executionCapacity: number; readonly executionInUse: number }>>
  readonly queue: { readonly queued: number; readonly running: readonly string[]; readonly maxRunningJobs: number; readonly paused: boolean }
  readonly memoryGovernor: Readonly<Record<string, MemoryGovernorDevice>> | null
  readonly leases: readonly { readonly reservationId: string; readonly device: string; readonly bytes: number; readonly expiresInSeconds: number }[] | null
  readonly consumerDetails?: Readonly<Record<string, readonly MemoryConsumerItem[]>>
}

function decodeMemoryStatus(value: unknown): MemoryStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const status = value as Record<string, unknown>
  const queue = status['queue'] as Record<string, unknown> | undefined
  const record = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)
  const finite = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item)
  const numberRecord = (item: unknown): boolean => record(item) && Object.values(item).every(finite)
  if (typeof status['devices'] !== 'object' || status['devices'] === null || Array.isArray(status['devices']) ||
    typeof queue !== 'object' || queue === null || typeof queue['queued'] !== 'number' ||
    !Array.isArray(queue['running']) || !queue['running'].every((item) => typeof item === 'string') ||
    typeof queue['maxRunningJobs'] !== 'number' || typeof queue['paused'] !== 'boolean' ||
    (status['memoryGovernor'] !== null && (typeof status['memoryGovernor'] !== 'object' || Array.isArray(status['memoryGovernor']))) ||
    (status['leases'] !== null && !Array.isArray(status['leases']))) return undefined
  if (!Object.values(status['devices']).every((device) => record(device) && finite(device['executionCapacity']) && finite(device['executionInUse']))) return undefined
  if (record(status['memoryGovernor']) && !Object.values(status['memoryGovernor']).every((device) => {
    if (!record(device) || (device['budgetBytes'] !== null && !finite(device['budgetBytes'])) ||
      !finite(device['reservedBytes']) || !finite(device['consumerFootprintBytes']) ||
      (device['availableBytes'] !== null && !finite(device['availableBytes'])) || !numberRecord(device['consumers'])) return false
    const measured = device['measured']
    return measured === null || (record(measured) && finite(measured['freeBytes']) && finite(measured['totalBytes']))
  })) return undefined
  if (Array.isArray(status['leases']) && !status['leases'].every((lease) => record(lease) &&
    typeof lease['reservationId'] === 'string' && typeof lease['device'] === 'string' && finite(lease['bytes']) && finite(lease['expiresInSeconds']))) return undefined
  if (status['consumerDetails'] !== undefined && (!record(status['consumerDetails']) || !Object.values(status['consumerDetails']).every((items) => Array.isArray(items) && items.every((item) => {
    if (!record(item) || typeof item['itemId'] !== 'string' || typeof item['displayName'] !== 'string' || !numberRecord(item['bytesByResidency'])) return false
    const pages = item['pages']
    return pages === undefined || (record(pages) && finite(pages['pageBytes']) && finite(pages['pageCount']) &&
      Array.isArray(pages['flags']) && pages['flags'].every(finite) && pages['flags'].length === pages['pageCount'])
  })))) return undefined
  return value as MemoryStatus
}

export type RuntimeSettingsErrorBody =
  | { readonly error: 'settings-changes-disabled'; readonly category: string; readonly granted: readonly string[] }
  | {
      readonly error: 'invalid-settings'
      readonly category: string
      readonly message: string
      readonly offendingFlag?: string
      readonly owner?: string
    }

function decodeRuntimeSettingsError(status: number, value: unknown): RuntimeSettingsErrorBody | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  if (
    status === 400 && body['error'] === 'invalid-settings' &&
    typeof body['category'] === 'string' && typeof body['message'] === 'string'
  ) return {
    error: 'invalid-settings',
    category: body['category'],
    message: body['message'],
    ...(typeof body['offendingFlag'] === 'string' ? { offendingFlag: body['offendingFlag'] } : {}),
    ...(typeof body['owner'] === 'string' ? { owner: body['owner'] } : {}),
  }
  if (
    status === 403 && body['error'] === 'settings-changes-disabled' &&
    typeof body['category'] === 'string' && Array.isArray(body['granted']) &&
    body['granted'].every((category) => typeof category === 'string')
  ) return { error: 'settings-changes-disabled', category: body['category'], granted: body['granted'] as string[] }
  return undefined
}

export class RuntimeSettingsError extends Error {
  readonly offendingFlag?: string
  readonly owner?: string

  constructor(
    readonly status: number,
    readonly body: RuntimeSettingsErrorBody | undefined,
  ) {
    super(
      body?.error === 'invalid-settings'
        ? body.message
        : body?.error === 'settings-changes-disabled'
          ? `Changes to ${body.category} are not granted (granted: ${body.granted.join(', ') || 'none'})`
          : `runtime settings request failed: ${status}`,
    )
    if (body?.error === 'invalid-settings') {
      if (body.offendingFlag !== undefined) this.offendingFlag = body.offendingFlag
      if (body.owner !== undefined) this.owner = body.owner
    }
  }
}

export interface PrincipalSummary {
  readonly principalId: string
  readonly kind: string
  readonly local?: boolean
  readonly categories: Readonly<Record<string, boolean>>
  readonly scopes?: readonly string[]
  readonly self?: boolean
}

export class PrincipalsError extends Error {
  constructor(
    readonly status: number,
    readonly serverError?: string,
  ) {
    super(serverError ?? `principals request failed: ${status}`)
  }
}

function decodePermissionCategories(value: unknown): Readonly<Record<string, boolean>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

function decodePrincipalSummary(value: unknown): PrincipalSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const principal = value as Record<string, unknown>
  if (
    typeof principal['principalId'] !== 'string' ||
    typeof principal['kind'] !== 'string' ||
    typeof principal['categories'] !== 'object' ||
    principal['categories'] === null ||
    Array.isArray(principal['categories'])
  ) return undefined
  return {
    principalId: principal['principalId'],
    kind: principal['kind'],
    ...(typeof principal['local'] === 'boolean' ? { local: principal['local'] } : {}),
    categories: decodePermissionCategories(principal['categories']),
    ...(Array.isArray(principal['scopes']) ? { scopes: principal['scopes'].filter((scope): scope is string => typeof scope === 'string') } : {}),
    ...(typeof principal['self'] === 'boolean' ? { self: principal['self'] } : {}),
  }
}

function isReplacementProblem(v: unknown): v is ReplacementProblem {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p['carrier'] === 'string' &&
    typeof p['from'] === 'string' &&
    typeof p['caseIndex'] === 'number' &&
    typeof p['ref'] === 'string' &&
    (p['refKind'] === 'input' || p['refKind'] === 'output') &&
    typeof p['target'] === 'string' &&
    typeof p['message'] === 'string'
  )
}

function isCompatSkip(v: unknown): v is CompatSkip {
  if (typeof v !== 'object' || v === null) return false
  const skip = v as Record<string, unknown>
  return (
    typeof skip['packId'] === 'string' &&
    typeof skip['nodeId'] === 'string' &&
    typeof skip['reason'] === 'string'
  )
}

const JOB_ARTIFACT_CAP = 1024
const JOB_ARTIFACT_NODE_ID_CAP = 512
const JOB_ARTIFACT_NAME_CAP = 1024
const JOB_ARTIFACT_MEDIA_TYPE_CAP = 255
const JOB_ARTIFACT_VIRTUAL_PATH_CAP = 4096
const JOB_ARTIFACT_SIZE_CAP = 1024 * 1024 * 1024
const JOB_ARTIFACT_KEYS = ['nodeId', 'digest', 'name', 'size', 'mediaType', 'virtualPath'] as const
const JOB_ARTIFACT_DIGEST = /^blake3:[0-9a-f]{64}$/
const JOB_ARTIFACT_MEDIA_TYPE = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/
const hasControlCharacter = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value)

/** Optional result metadata is all-or-nothing: malformed rows never poison job state. */
function decodeJobArtifacts(value: unknown): readonly ExecutionArtifact[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > JOB_ARTIFACT_CAP) return undefined
  const decoded: ExecutionArtifact[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
    const row = candidate as Record<string, unknown>
    if (Object.keys(row).length !== JOB_ARTIFACT_KEYS.length ||
      JOB_ARTIFACT_KEYS.some((key) => !Object.hasOwn(row, key))) return undefined
    const nodeId = row['nodeId']
    const digest = row['digest']
    const name = row['name']
    const size = row['size']
    const mediaType = row['mediaType']
    const virtualPath = row['virtualPath']
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > JOB_ARTIFACT_NODE_ID_CAP || hasControlCharacter(nodeId) ||
      typeof digest !== 'string' || !JOB_ARTIFACT_DIGEST.test(digest) ||
      typeof name !== 'string' || name.length === 0 || name.length > JOB_ARTIFACT_NAME_CAP || hasControlCharacter(name) ||
      typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > JOB_ARTIFACT_SIZE_CAP ||
      typeof mediaType !== 'string' || mediaType.length === 0 || mediaType.length > JOB_ARTIFACT_MEDIA_TYPE_CAP || !JOB_ARTIFACT_MEDIA_TYPE.test(mediaType) ||
      typeof virtualPath !== 'string' || virtualPath.length > JOB_ARTIFACT_VIRTUAL_PATH_CAP || hasControlCharacter(virtualPath)) return undefined
    decoded.push({ nodeId, digest, name, size, mediaType, virtualPath })
  }
  return decoded
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface DinksterConnectionConfig extends CollabCredentials {
  readonly id: ConnectionId
  /** HTTP base, no trailing slash. '' = same origin (dev proxy). */
  readonly baseUrl: string
  /** Stable per-session client id; jobs and WS routing are keyed by it. */
  readonly clientId: string
  /** WS endpoint override; defaults to baseUrl with ws(s) scheme + /api/events. */
  readonly wsUrl?: string
  readonly fetchFn?: FetchLike
  readonly webSocketFactory?: WebSocketFactory
  readonly scheduleFn?: ScheduleFn
  readonly cancelFn?: CancelFn
  /** Job id allocator; injectable so tests are deterministic. */
  readonly jobIdFactory?: () => string
}

export class ExecutionRequestError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message)
  }
}

const responseDiagnostic = (
  status: number,
  payload: Record<string, unknown> | undefined,
  operation: string,
): Diagnostic => {
  const serverCode = typeof payload?.['error'] === 'string' && payload['error'].length <= 128
    ? payload['error']
    : `http-${status}`
  const message = typeof payload?.['message'] === 'string'
    ? payload['message']
    : `HTTP ${status}: ${serverCode}`
  return diag('error', 'runtime', `execution.${operation}.${serverCode}`, message, {
    data: {
      status,
      code: serverCode,
      operation,
      ...(typeof payload?.['capability'] === 'string' ? { capability: payload['capability'] } : {}),
      ...(typeof payload?.['scope'] === 'string' ? { scope: payload['scope'] } : {}),
    },
  })
}

const responsePayload = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  const value: unknown = await response.json().catch(() => undefined)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One execution location reported by GET /api/workers. */
export interface WorkerInfo {
  readonly name: string
  readonly status: string
  readonly routedNodeTypes: readonly string[]
  readonly deviceQualifiers: readonly string[]
}

const decodeWorkers = (value: unknown): readonly WorkerInfo[] | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const workers = (value as Record<string, unknown>)['workers']
  if (!Array.isArray(workers)) return undefined
  const decoded: WorkerInfo[] = []
  const names = new Set<string>()
  for (const candidate of workers) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
    const worker = candidate as Record<string, unknown>
    const name = worker['name']
    const status = worker['status']
    const routedNodeTypes = worker['routedNodeTypes']
    const deviceQualifiers = worker['deviceQualifiers']
    if (
      typeof name !== 'string' || name.length === 0 || names.has(name) ||
      typeof status !== 'string' || status.length === 0 ||
      !Array.isArray(routedNodeTypes) || !routedNodeTypes.every((entry) => typeof entry === 'string') ||
      !Array.isArray(deviceQualifiers) || !deviceQualifiers.every((entry) => typeof entry === 'string')
    ) return undefined
    names.add(name)
    decoded.push({
      name,
      status,
      routedNodeTypes: routedNodeTypes as string[],
      deviceQualifiers: deviceQualifiers as string[],
    })
  }
  return decoded
}

/** One job's wire record plus the identity it is keyed by. */
export interface DinksterJobRecord extends DinksterJobWire {
  readonly jobId?: unknown
  readonly outputs?: unknown
  readonly artifacts?: readonly ExecutionArtifact[]
  readonly submittedBy?: ExecutionSubmitter
  readonly sourceDocument?: string
}

const decodeExecutionSubmitter = (value: unknown): ExecutionSubmitter | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['principalId'] !== 'string' ||
    (record['kind'] !== 'human' && record['kind'] !== 'agent')) return undefined
  return { principalId: record['principalId'], kind: record['kind'] }
}

/** One record from GET /api/runs/{runId}/journal: the exact published wire dict. */
export interface RunJournalRecord {
  readonly seq: number
  readonly name: string
  readonly payload?: Readonly<Record<string, unknown>>
}

export interface RunJournalPage {
  readonly records: readonly RunJournalRecord[]
  readonly latestSeq: number
  readonly coalescedBelow: number
}

/**
 * The run identity + scope the journal endpoint is keyed by, read off a
 * fetched job record. Undefined when the server predates the journal
 * contract (no jobRef/runId on the job wire).
 */
export function runJournalIdentity(
  job: DinksterJobRecord,
): { readonly runId: string; readonly scope: string } | undefined {
  const runId =
    typeof job.jobRef === 'string' && job.jobRef !== ''
      ? job.jobRef
      : typeof job.runId === 'string' && job.runId !== ''
        ? job.runId
        : undefined
  if (runId === undefined) return undefined
  return { runId, scope: typeof job.scope === 'string' && job.scope !== '' ? job.scope : 'local' }
}

/** Server caps journal pages at 1000 records; ask for full pages. */
const RUN_JOURNAL_PAGE_LIMIT = 1000
/** Upper bound on pages per backfill pass; the cursor resumes on the next pass. */
const RUN_JOURNAL_MAX_PAGES = 20

export interface MissingAsset {
  readonly digest: string
  readonly name: string
  readonly status: 'missing' | 'failed'
  readonly sources: readonly string[]
  readonly fetchable: boolean
  readonly detail?: string
  readonly kind?: string
  readonly size?: number
  readonly packagedFrom?: readonly string[]
}

export interface MountDescriptor {
  readonly id: string
  /**
   * Server vocabulary (dinkster_assets MOUNT_MODES): 'read' | 'readwrite'.
   * The frontend briefly invented 'readonly' here, which silently hid
   * every read mount the real server returned - the decoder is now the
   * single owner of this vocabulary and tests pin the server's words.
   */
  readonly mode: 'read' | 'readwrite'
  readonly state: string
  readonly path?: string
  /** Optional semantic scope for homogeneous mounts (for example model/checkpoint). */
  readonly kind?: string
  /** Server-reported catalog size when the mount index provides it. */
  readonly entryCount?: number
  readonly scanProgress?: MountScanProgress
}

export interface MountSettings {
  readonly mounts: readonly MountDescriptor[]
  readonly outputMount?: string
  /**
   * Server's gate on mutating mount configuration (add/remove grants,
   * select the output mount). A response that omits it (an older backend)
   * decodes as false so such servers degrade safely to read-only; a
   * present non-boolean is malformed, never a silent default.
   */
  readonly mountChangesAllowed: boolean
}

export interface MountScanProgress {
  readonly filesDone: number
  readonly filesTotal: number
  readonly bytesDone: number
  readonly bytesTotal: number
  readonly elapsedSeconds: number
}

export interface MountEntry {
  readonly virtualPath: string
  readonly name: string
  readonly digest: string
  readonly size: number
  readonly mediaType: string
  readonly kind?: string
}

export interface MountEntryPage {
  readonly entries: readonly MountEntry[]
  /** Immediate subfolder names, present only on a non-recursive first page. */
  readonly folders?: readonly string[]
  readonly cursor?: string
  readonly total?: number
}

export interface MountFolderEntry {
  readonly name: string
  readonly virtualPath: string
  readonly folder: boolean
  readonly childCount?: number
}

export type AssetGuessConfidence = 'digest' | 'path' | 'name' | 'name-insensitive' | 'stem' | 'other'

export interface AssetGuessCandidate {
  readonly digest: string
  readonly name: string
  readonly confidence: AssetGuessConfidence
  readonly held: boolean
  readonly virtualPath?: string
  readonly mountId?: string
  readonly size?: number
  readonly mediaType?: string
  readonly declaredBy?: readonly string[]
  readonly kind?: string
}

export interface AssetGuessMatch {
  readonly query: string
  readonly candidates: readonly AssetGuessCandidate[]
}

export interface MediaAssetRef extends JsonObject {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

const classifiedAssetRef = (payload: unknown, kind: string, endpoint: string): MediaAssetRef => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${endpoint}: malformed response`)
  }
  const body = payload as Record<string, unknown>
  const asset = body['asset']
  if (body['kind'] !== kind || typeof asset !== 'object' || asset === null || Array.isArray(asset)) {
    throw new Error(`${endpoint}: malformed response`)
  }
  const value = asset as Record<string, unknown>
  if (!/^blake3:[0-9a-f]{64}$/.test(String(value['digest'])) ||
      typeof value['name'] !== 'string' || value['name'] === '' ||
      typeof value['size'] !== 'number' || !Number.isSafeInteger(value['size']) || value['size'] < 0 ||
      typeof value['mediaType'] !== 'string' || value['mediaType'] === '' ||
      typeof value['virtualPath'] !== 'string') {
    throw new Error(`${endpoint}: malformed response`)
  }
  return value as unknown as MediaAssetRef
}

const GUESS_CONFIDENCE = new Set<AssetGuessConfidence>(['digest', 'path', 'name', 'name-insensitive', 'stem'])

function parseAssetGuessMatches(value: unknown): readonly AssetGuessMatch[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>)['matches']))
    throw new Error('POST /api/assets/guess: malformed response')
  return ((value as { matches: unknown[] }).matches).map((raw) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('POST /api/assets/guess: malformed match')
    const match = raw as Record<string, unknown>
    if (typeof match['query'] !== 'string' || !Array.isArray(match['candidates'])) throw new Error('POST /api/assets/guess: malformed match')
    const candidates = match['candidates'].map((entry): AssetGuessCandidate => {
      if (typeof entry !== 'object' || entry === null) throw new Error('POST /api/assets/guess: malformed candidate')
      const c = entry as Record<string, unknown>
      if (typeof c['digest'] !== 'string' || typeof c['name'] !== 'string' || typeof c['confidence'] !== 'string' || typeof c['held'] !== 'boolean')
        throw new Error('POST /api/assets/guess: malformed candidate')
      const optionalString = (key: string) => c[key] === undefined || typeof c[key] === 'string'
      if (!optionalString('virtualPath') || !optionalString('mountId') || !optionalString('mediaType') || !optionalString('kind') ||
        (c['size'] !== undefined && (typeof c['size'] !== 'number' || !Number.isInteger(c['size']) || c['size'] < 0)) ||
        (c['declaredBy'] !== undefined && (!Array.isArray(c['declaredBy']) || !c['declaredBy'].every((id) => typeof id === 'string'))))
        throw new Error('POST /api/assets/guess: malformed candidate')
      return {
        digest: c['digest'], name: c['name'], held: c['held'],
        confidence: GUESS_CONFIDENCE.has(c['confidence'] as AssetGuessConfidence) ? c['confidence'] as AssetGuessConfidence : 'other',
        ...(typeof c['virtualPath'] === 'string' ? { virtualPath: c['virtualPath'] } : {}),
        ...(typeof c['mountId'] === 'string' ? { mountId: c['mountId'] } : {}),
        ...(typeof c['size'] === 'number' ? { size: c['size'] } : {}),
        ...(typeof c['mediaType'] === 'string' ? { mediaType: c['mediaType'] } : {}),
        ...(Array.isArray(c['declaredBy']) ? { declaredBy: c['declaredBy'] as string[] } : {}),
        ...(typeof c['kind'] === 'string' ? { kind: c['kind'] } : {}),
      }
    })
    return { query: match['query'], candidates }
  })
}

export interface AssetsMissingRejection {
  readonly error: 'assets-missing'
  readonly assets: readonly MissingAsset[]
}

export type DinksterSubmitResult = SubmitResult | {
  readonly ok: false
  /** Retained for headless consumers that surface submission diagnostics. */
  readonly diagnostics: readonly Diagnostic[]
  readonly assetsMissing: AssetsMissingRejection
  /** Retry the exact rejected job body with per-digest acquisition consent. */
  readonly retryWithAssets: (digests: readonly string[]) => Promise<DinksterSubmitResult>
}

/** Strictly decode the machine-readable job preflight rejection. */
export function parseAssetsMissingRejection(value: unknown): AssetsMissingRejection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as Record<string, unknown>
  if (body['error'] !== 'assets-missing' || !Array.isArray(body['assets'])) return undefined
  const assets: MissingAsset[] = []
  for (const raw of body['assets']) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const asset = raw as Record<string, unknown>
    if (
      typeof asset['digest'] !== 'string' ||
      typeof asset['name'] !== 'string' ||
      (asset['status'] !== 'missing' && asset['status'] !== 'failed') ||
      !Array.isArray(asset['sources']) ||
      !asset['sources'].every((source) => typeof source === 'string') ||
      typeof asset['fetchable'] !== 'boolean' ||
      (asset['detail'] !== undefined && typeof asset['detail'] !== 'string') ||
      (asset['kind'] !== undefined && typeof asset['kind'] !== 'string') ||
      (asset['size'] !== undefined && (typeof asset['size'] !== 'number' || !Number.isInteger(asset['size']) || asset['size'] < 0)) ||
      (asset['packagedFrom'] !== undefined && (!Array.isArray(asset['packagedFrom']) || !asset['packagedFrom'].every((pack) => typeof pack === 'string')))
    ) return undefined
    assets.push({
      digest: asset['digest'],
      name: asset['name'],
      status: asset['status'],
      sources: asset['sources'] as string[],
      fetchable: asset['fetchable'],
      ...(typeof asset['detail'] === 'string' ? { detail: asset['detail'] } : {}),
      ...(typeof asset['kind'] === 'string' ? { kind: asset['kind'] } : {}),
      ...(typeof asset['size'] === 'number' ? { size: asset['size'] } : {}),
      ...(Array.isArray(asset['packagedFrom']) ? { packagedFrom: asset['packagedFrom'] as string[] } : {}),
    })
  }
  return { error: 'assets-missing', assets }
}

// ---------------------------------------------------------------------------
// Workflow library wire (POST /api/assets + /api/library, additive d41fbd3)
// ---------------------------------------------------------------------------

/**
 * One scoped library record: mutable browse metadata (name/labels/folder)
 * pointing at immutable content bytes by digest. Renames never change
 * content identity; `revision` is the optimistic-concurrency token every
 * PATCH must present.
 */
export interface LibraryRecord {
  readonly id: string
  readonly scope: string
  readonly name: string
  /** blake3:<64 hex> content digest; the bytes live at /api/assets/{digest}. */
  readonly digest: string
  readonly mediaType: string
  readonly labels: readonly string[]
  readonly created: number
  readonly modified: number
  readonly revision: number
  readonly folder?: string
}

export const IMAGE_DOCUMENT_MEDIA_TYPE = 'application/vnd.dinkster.image-document+json'

export interface ImageDocumentDependency {
  readonly resourceId: string
  readonly digest: string
  readonly byteSize: number
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly width: number
  readonly height: number
  readonly colorSpace: 'srgb'
  readonly channelDepth: 8
  readonly alphaMode: 'straight' | 'premultiplied' | 'opaque'
}

export interface AdoptedImageDocument {
  readonly digest: string
  readonly mediaType: typeof IMAGE_DOCUMENT_MEDIA_TYPE
  readonly byteSize: number
  readonly dependencies: readonly ImageDocumentDependency[]
}

export const IMAGE_DOCUMENT_RENDER_PROFILE = 'dinkster-image-document-v2-cpu-reference'
export const IMAGE_DOCUMENT_RENDER_ENCODING = 'image/png;dinkster-canonical=1'

export interface ImageDocumentRenderProvenance {
  readonly documentDigest: string
  readonly selector: string
  readonly profile: typeof IMAGE_DOCUMENT_RENDER_PROFILE
  readonly rendererContract: string
  readonly encoding: typeof IMAGE_DOCUMENT_RENDER_ENCODING
  readonly source: {
    readonly digest: string
    readonly mediaType: typeof IMAGE_DOCUMENT_MEDIA_TYPE
    readonly dependencies: readonly ImageDocumentDependency[]
  }
  readonly output: {
    readonly digest: string
    readonly byteSize: number
    readonly mediaType: 'image/png'
    readonly width: number
    readonly height: number
    readonly encoding: typeof IMAGE_DOCUMENT_RENDER_ENCODING
  }
}

export interface RenderedImageDocument {
  readonly cacheKey: string
  readonly cached: boolean
  readonly asset: MediaAssetRef
  readonly provenance: ImageDocumentRenderProvenance
}

const IMAGE_DOCUMENT_DIGEST = /^blake3:[0-9a-f]{64}$/
const IMAGE_DOCUMENT_RESOURCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const IMAGE_DOCUMENT_ALPHA_MODES = new Set(['straight', 'premultiplied', 'opaque'])

function imageDocumentDependencies(value: unknown): readonly ImageDocumentDependency[] | undefined {
  if (!Array.isArray(value) || value.length > 8_192) return undefined
  const decoded: ImageDocumentDependency[] = []
  const resourceIds = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
    const row = candidate as Record<string, unknown>
    const resourceId = row['resourceId']
    const digest = row['digest']
    const byteSize = row['byteSize']
    const mediaType = row['mediaType']
    const width = row['width']
    const height = row['height']
    const alphaMode = row['alphaMode']
    if (
      typeof resourceId !== 'string' || resourceId === '' || resourceIds.has(resourceId) ||
      typeof digest !== 'string' || !IMAGE_DOCUMENT_DIGEST.test(digest) ||
      typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize < 1 ||
      typeof mediaType !== 'string' || !IMAGE_DOCUMENT_RESOURCE_TYPES.has(mediaType) ||
      typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1 || width > 16_384 ||
      typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1 || height > 16_384 ||
      width * height > 100_000_000 || row['colorSpace'] !== 'srgb' || row['channelDepth'] !== 8 ||
      typeof alphaMode !== 'string' || !IMAGE_DOCUMENT_ALPHA_MODES.has(alphaMode)
    ) return undefined
    resourceIds.add(resourceId)
    decoded.push({
      resourceId,
      digest,
      byteSize,
      mediaType: mediaType as ImageDocumentDependency['mediaType'],
      width,
      height,
      colorSpace: 'srgb',
      channelDepth: 8,
      alphaMode: alphaMode as ImageDocumentDependency['alphaMode'],
    })
  }
  return decoded
}

function adoptedImageDocument(value: unknown): AdoptedImageDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const dependencies = imageDocumentDependencies(row['dependencies'])
  return typeof row['digest'] === 'string' && IMAGE_DOCUMENT_DIGEST.test(row['digest']) &&
      row['mediaType'] === IMAGE_DOCUMENT_MEDIA_TYPE &&
      typeof row['byteSize'] === 'number' && Number.isSafeInteger(row['byteSize']) && row['byteSize'] > 0 &&
      dependencies !== undefined
    ? {
        digest: row['digest'],
        mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
        byteSize: row['byteSize'],
        dependencies,
      }
    : undefined
}

function renderedImageDocument(value: unknown): RenderedImageDocument | undefined {
  if (!record(value) || !exactKeys(value, ['cacheKey', 'cached', 'asset', 'provenance']) ||
    typeof value['cacheKey'] !== 'string' || !IMAGE_DOCUMENT_DIGEST.test(value['cacheKey']) ||
    typeof value['cached'] !== 'boolean' || !record(value['asset']) || !record(value['provenance'])) {
    return undefined
  }
  const asset = value['asset']
  const provenance = value['provenance']
  if (!exactKeys(asset, ['digest', 'name', 'size', 'mediaType', 'virtualPath']) ||
    typeof asset['digest'] !== 'string' || !IMAGE_DOCUMENT_DIGEST.test(asset['digest']) ||
    !nonemptyString(asset['name']) || !integerNonnegative(asset['size']) || asset['size'] < 1 ||
    asset['mediaType'] !== 'image/png' || typeof asset['virtualPath'] !== 'string' ||
    !exactKeys(provenance, [
      'documentDigest', 'selector', 'profile', 'rendererContract', 'encoding', 'source', 'output',
    ]) || typeof provenance['documentDigest'] !== 'string' ||
    !IMAGE_DOCUMENT_DIGEST.test(provenance['documentDigest']) ||
    !nonemptyString(provenance['selector']) ||
    provenance['profile'] !== IMAGE_DOCUMENT_RENDER_PROFILE ||
    !nonemptyString(provenance['rendererContract']) ||
    provenance['encoding'] !== IMAGE_DOCUMENT_RENDER_ENCODING ||
    !record(provenance['source']) || !record(provenance['output'])) return undefined
  const source = provenance['source']
  const output = provenance['output']
  const dependencies = imageDocumentDependencies(source['dependencies'])
  if (!exactKeys(source, ['digest', 'mediaType', 'dependencies']) ||
    source['digest'] !== provenance['documentDigest'] ||
    source['mediaType'] !== IMAGE_DOCUMENT_MEDIA_TYPE || dependencies === undefined ||
    !exactKeys(output, ['digest', 'byteSize', 'mediaType', 'width', 'height', 'encoding']) ||
    output['digest'] !== asset['digest'] || output['byteSize'] !== asset['size'] ||
    output['mediaType'] !== 'image/png' || !integerNonnegative(output['width']) || output['width'] < 1 ||
    !integerNonnegative(output['height']) || output['height'] < 1 ||
    output['width'] * output['height'] > 4_194_304 ||
    output['encoding'] !== IMAGE_DOCUMENT_RENDER_ENCODING) return undefined
  return {
    cacheKey: value['cacheKey'],
    cached: value['cached'],
    asset: {
      digest: asset['digest'],
      name: asset['name'],
      size: asset['size'],
      mediaType: 'image/png',
      virtualPath: asset['virtualPath'],
    },
    provenance: {
      documentDigest: provenance['documentDigest'],
      selector: provenance['selector'],
      profile: IMAGE_DOCUMENT_RENDER_PROFILE,
      rendererContract: provenance['rendererContract'],
      encoding: IMAGE_DOCUMENT_RENDER_ENCODING,
      source: {
        digest: source['digest'],
        mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
        dependencies,
      },
      output: {
        digest: asset['digest'],
        byteSize: asset['size'],
        mediaType: 'image/png',
        width: output['width'],
        height: output['height'],
        encoding: IMAGE_DOCUMENT_RENDER_ENCODING,
      },
    },
  }
}

/** Structural gate for wire records; non-conforming entries are skipped. */
const isLibraryRecord = (v: unknown): v is LibraryRecord => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r['id'] === 'string' &&
    typeof r['scope'] === 'string' &&
    typeof r['name'] === 'string' &&
    typeof r['digest'] === 'string' &&
    typeof r['mediaType'] === 'string' &&
    Array.isArray(r['labels']) &&
    (r['labels'] as unknown[]).every((label) => typeof label === 'string') &&
    typeof r['created'] === 'number' && Number.isFinite(r['created']) &&
    typeof r['modified'] === 'number' &&
    Number.isFinite(r['modified']) &&
    typeof r['revision'] === 'number' && Number.isSafeInteger(r['revision']) && r['revision'] >= 0
  )
}

/** One page of library records; cursor absent = exhausted (query-bound). */
export interface LibraryPage {
  readonly records: readonly LibraryRecord[]
  readonly cursor?: string
}

/** Browse-only pack template descriptor; omitted arrays mean no values. */
export interface TemplateDescriptor {
  readonly pack: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly family?: string
  readonly models?: readonly string[]
  readonly thumbnail?: { readonly digest: string; readonly mediaType: string }
  /** Pack-local asset ids, joined against PackInfo.assets by consumers. */
  readonly assets?: readonly string[]
  readonly digest: string
}

export interface TemplatePage {
  readonly templates: readonly TemplateDescriptor[]
  readonly cursor?: string
}

const templateDescriptor = (value: unknown): TemplateDescriptor | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  if (typeof r['pack'] !== 'string' || typeof r['id'] !== 'string' || typeof r['name'] !== 'string' || typeof r['digest'] !== 'string') return undefined
  const strings = (v: unknown): readonly string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as readonly string[] : undefined
  return {
    pack: r['pack'], id: r['id'], name: r['name'], digest: r['digest'],
    ...(typeof r['description'] === 'string' ? { description: r['description'] } : {}),
    ...(strings(r['tags']) !== undefined ? { tags: strings(r['tags'])! } : {}),
    ...(typeof r['family'] === 'string' ? { family: r['family'] } : {}),
    ...(strings(r['models']) !== undefined ? { models: strings(r['models'])! } : {}),
    ...(typeof r['thumbnail'] === 'object' && r['thumbnail'] !== null &&
      typeof (r['thumbnail'] as Record<string, unknown>)['digest'] === 'string' &&
      typeof (r['thumbnail'] as Record<string, unknown>)['mediaType'] === 'string'
      ? { thumbnail: r['thumbnail'] as { digest: string; mediaType: string } }
      : {}),
    ...(strings(r['assets']) !== undefined ? { assets: strings(r['assets'])! } : {}),
  }
}

export interface DocsAssetDescriptor {
  readonly digest: string
  readonly mediaType: string
}

export interface DocsLocaleDescriptor {
  readonly title: string
  readonly summary: string
  readonly digest: string
  readonly schemaVersion?: number
  /** Keys are exact pack-relative Markdown sources beginning with assets/. */
  readonly assets: Readonly<Record<string, DocsAssetDescriptor>>
}

export interface DocsDescriptor {
  readonly pack: string
  readonly kind: 'node' | 'guide'
  readonly id: string
  readonly defaultLocale: string
  readonly locales: Readonly<Record<string, DocsLocaleDescriptor>>
  readonly guideKind?: 'tour'
  readonly order?: number
  readonly tags?: readonly string[]
}

export interface DocsPage {
  readonly docs: readonly DocsDescriptor[]
  readonly cursor?: string
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const DOCS_PAGE_CACHE_MAX = 64

const docsDescriptor = (value: unknown): DocsDescriptor | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record['pack'] !== 'string' || record['pack'] === '' ||
    (record['kind'] !== 'node' && record['kind'] !== 'guide') ||
    typeof record['id'] !== 'string' || record['id'] === '' ||
    typeof record['defaultLocale'] !== 'string' || record['defaultLocale'] === '' ||
    typeof record['locales'] !== 'object' || record['locales'] === null || Array.isArray(record['locales'])
  ) return undefined
  const locales: Record<string, DocsLocaleDescriptor> = {}
  for (const [locale, rawLocale] of Object.entries(record['locales'])) {
    if (locale === '' || typeof rawLocale !== 'object' || rawLocale === null || Array.isArray(rawLocale)) return undefined
    const entry = rawLocale as Record<string, unknown>
    if (
      typeof entry['title'] !== 'string' || entry['title'] === '' ||
      typeof entry['summary'] !== 'string' ||
      typeof entry['digest'] !== 'string' || !SHA256_DIGEST.test(entry['digest']) ||
      typeof entry['assets'] !== 'object' || entry['assets'] === null || Array.isArray(entry['assets']) ||
      (record['kind'] !== 'node' && entry['schemaVersion'] !== undefined) ||
      (entry['schemaVersion'] !== undefined && (!Number.isSafeInteger(entry['schemaVersion']) || (entry['schemaVersion'] as number) < 1))
    ) return undefined
    const assets: Record<string, DocsAssetDescriptor> = {}
    for (const [source, rawAsset] of Object.entries(entry['assets'])) {
      if (!source.startsWith('assets/') || typeof rawAsset !== 'object' || rawAsset === null || Array.isArray(rawAsset)) return undefined
      const asset = rawAsset as Record<string, unknown>
      if (
        typeof asset['digest'] !== 'string' || !SHA256_DIGEST.test(asset['digest']) ||
        typeof asset['mediaType'] !== 'string' || asset['mediaType'] === ''
      ) return undefined
      assets[source] = { digest: asset['digest'], mediaType: asset['mediaType'] }
    }
    locales[locale] = {
      title: entry['title'],
      summary: entry['summary'],
      digest: entry['digest'],
      ...(entry['schemaVersion'] !== undefined ? { schemaVersion: entry['schemaVersion'] as number } : {}),
      assets,
    }
  }
  if (locales[record['defaultLocale']] === undefined) return undefined
  if (record['guideKind'] !== undefined && (record['kind'] !== 'guide' || record['guideKind'] !== 'tour')) return undefined
  if (record['order'] !== undefined && !Number.isFinite(record['order'])) return undefined
  if (record['tags'] !== undefined && (!Array.isArray(record['tags']) || !record['tags'].every((tag) => typeof tag === 'string'))) return undefined
  return {
    pack: record['pack'],
    kind: record['kind'],
    id: record['id'],
    defaultLocale: record['defaultLocale'],
    locales,
    ...(record['guideKind'] === 'tour' ? { guideKind: 'tour' as const } : {}),
    ...(typeof record['order'] === 'number' ? { order: record['order'] } : {}),
    ...(Array.isArray(record['tags']) ? { tags: record['tags'] as string[] } : {}),
  }
}

// ---------------------------------------------------------------------------
// Persistent execution history wire (/api/history, additive b0484be/4d861cc)
// ---------------------------------------------------------------------------

/**
 * One durable terminal run. Optional fields are omitted-when-absent (never
 * null) by contract. `error` is the job wire's structured payload
 * ({"kind": "validation"|"execution"|"internal", ...}); only `message` is
 * relied on for display, everything else passes through.
 */
export interface HistoryRunRecord {
  readonly runId: string
  /**
   * Server-assigned global job identity (Dinkster 258382e). Carries the same
   * value as runId (jobRef IS the promoted run_id); key off jobRef where
   * present, runId is the legacy alias. Absent on pre-jobRef servers.
   */
  readonly jobRef?: string
  readonly scope: string
  readonly clientId: string
  readonly jobId: string
  readonly state: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly priority: number
  readonly submittedAt: number
  readonly finishedAt: number
  readonly executed: number
  readonly cached: number
  readonly skipped: number
  readonly startedAt?: number
  /** blake3:<64 hex> digest of the producing workflow document asset. */
  readonly sourceDocument?: string
  readonly principalId?: string
  readonly principalKind?: 'human' | 'agent'
  readonly nodeReceipts?: readonly NodeExecutionReceipt[]
  readonly error?: { readonly kind?: string; readonly message?: string } & Record<string, unknown>
}

export interface NodeExecutionReceipt {
  readonly nodeId: string
  readonly disposition: 'executed' | 'cached' | 'failed' | 'skipped' | 'interrupted'
  readonly executionArm?: ExecutionArm
  readonly provider?: string
  readonly pack?: string
  readonly worker?: string
}

/**
 * Terminal states the history surface records (and its state filter
 * accepts). 'interrupted' marks a job the server swept after a restart:
 * it was queued or running when the process died, was NOT re-run, and
 * carries error.phase ('queued' | 'running') telling which.
 */
export const HISTORY_STATES = ['completed', 'failed', 'cancelled', 'interrupted'] as const

/** Structural gate for wire records; non-conforming entries are skipped. */
const decodeHistoryRun = (v: unknown): HistoryRunRecord | undefined => {
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  const receipts = r['nodeReceipts']
  const receiptsValid = receipts === undefined || (
    Array.isArray(receipts) && receipts.every((receipt) => {
      if (typeof receipt !== 'object' || receipt === null) return false
      const item = receipt as Record<string, unknown>
      return (
        typeof item['nodeId'] === 'string' &&
        ['executed', 'cached', 'failed', 'skipped', 'interrupted'].includes(String(item['disposition'])) &&
        (item['executionArm'] === undefined || item['executionArm'] === 'native' || item['executionArm'] === 'comfyui') &&
        (item['provider'] === undefined || (typeof item['provider'] === 'string' && item['provider'] !== '')) &&
        (item['pack'] === undefined || (typeof item['pack'] === 'string' && item['pack'] !== '')) &&
        (item['worker'] === undefined || (typeof item['worker'] === 'string' && item['worker'] !== ''))
      )
    })
  )
  if (!(
    typeof r['runId'] === 'string' &&
    typeof r['scope'] === 'string' &&
    typeof r['clientId'] === 'string' &&
    typeof r['jobId'] === 'string' &&
    (HISTORY_STATES as readonly string[]).includes(r['state'] as string) &&
    typeof r['priority'] === 'number' && Number.isFinite(r['priority']) &&
    typeof r['submittedAt'] === 'number' && Number.isFinite(r['submittedAt']) &&
    typeof r['finishedAt'] === 'number' && Number.isFinite(r['finishedAt']) &&
    typeof r['executed'] === 'number' &&
    typeof r['cached'] === 'number' &&
    typeof r['skipped'] === 'number' &&
    receiptsValid
  )) return undefined
  const {
    principalId: _wirePrincipalId,
    principalKind: _wirePrincipalKind,
    ...record
  } = r
  return {
    ...record,
    ...(typeof r['principalId'] === 'string' ? { principalId: r['principalId'] } : {}),
    ...(r['principalKind'] === 'human' || r['principalKind'] === 'agent'
      ? { principalKind: r['principalKind'] }
      : {}),
  } as unknown as HistoryRunRecord
}

/** One page of history runs; cursor absent = exhausted (query-bound). */
export interface HistoryPage {
  readonly records: readonly HistoryRunRecord[]
  readonly cursor?: string
}

/**
 * RFC 4122 v4 UUID. `crypto.randomUUID` exists only in secure contexts
 * (HTTPS or localhost), and this app is legitimately served over plain HTTP
 * on LAN/tailnet origins - where `getRandomValues` is still available, so
 * derive the UUID from it instead of failing every submit.
 */
export function uuidv4(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256) // last-resort (non-browser shims)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class DinksterConnection {
  readonly id: ConnectionId
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly fetchFn: FetchLike
  private readonly normalizer: DinksterNormalizer
  private readonly extensionSnapshots = new Map<string, EffectiveExtensionSnapshot>()
  private readonly listeners = new Set<(e: NormalizedEvent) => void>()
  private readonly problemListeners = new Set<(problem: Diagnostic) => void>()
  private readonly liveCompletionListeners = new Set<(execution: ExecutionRef) => void>()
  private readonly memoryListeners = new Set<(status: MemoryStatus) => void>()
  private readonly socket: ReconnectingSocket
  private readonly jobIdFactory: () => string
  private protocolErrors = 0
  /**
   * The registry from this connection's last fetchSchemas(): submit resolves
   * link output ids against it, and artifact.schemaHash must match it (the
   * artifact contract: prompts are only valid against the registry they
   * compiled with).
   */
  private registry: SchemaRegistry | undefined
  private schemaRequestGeneration = 0
  private newestSchemaFetch: { generation: number; promise: Promise<SchemaRegistry> } | undefined
  /** Lazy: the peek client shares this connection's identity + fetch, and
   * its immutable rendition cache lives as long as the connection does. */
  private valuesClient: DinksterValuesClient | undefined
  /** Jobs whose live events this connection has seen at least once. */
  private readonly seenLiveJobs = new Set<string>()
  /** In-flight journal backfills, keyed by runId: concurrent triggers coalesce. */
  private readonly runLogBackfills = new Map<string, Promise<void>>()
  /** Highest journal seq already replayed per runId; the next pass resumes past it. */
  private readonly runLogCursors = new Map<string, number>()
  /** Pack-scoped immutable Markdown bodies; promises coalesce concurrent readers. */
  private readonly docsPages = new Map<string, Promise<string | undefined>>()
  /** Pack-scoped immutable locale catalogs; promises coalesce concurrent readers. */
  private readonly packLocaleCatalogs = new Map<string, Promise<unknown | undefined>>()

  readonly status: ReadonlySignal<ConnectionStatus>

  constructor(config: DinksterConnectionConfig) {
    this.id = config.id
    this.baseUrl = config.baseUrl
    this.clientId = config.clientId
    const fetchFn = config.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
    this.fetchFn = config.token !== undefined || config.actorKind !== undefined
      ? credentialFetch(config, fetchFn)
      : fetchFn
    this.jobIdFactory = config.jobIdFactory ?? uuidv4
    // Malformed KNOWN events (recognized type, missing required fields) are
    // protocol errors, never silent drops; unknown kinds and uncorrelated
    // runId-only stragglers stay silent (forward compatibility).
    this.normalizer = new DinksterNormalizer(config.id, undefined, (detail) =>
      this.reportProtocolError(detail),
      (digest) => this.extensionSnapshots.get(digest),
    )
    const wsUrl = config.wsUrl ??
      `${config.baseUrl.replace(/^http/, 'ws')}/api/events?clientId=${encodeURIComponent(config.clientId)}`
    const eventsUrl = `${config.baseUrl}/api/events?clientId=${encodeURIComponent(config.clientId)}`
    this.socket = new ReconnectingSocket({
      url: wsUrl,
      ...((config.token !== undefined || config.actorKind === 'agent') && {
        resolveUrl: async () => {
          const preflight = await this.fetchFn(eventsUrl)
          if (preflight.status === 401 || preflight.status === 403) {
            throw await this.failExecutionRequest(preflight, 'events')
          }
          const response = await this.fetchFn(`${this.baseUrl}/api/auth/ws-ticket`, { method: 'POST' })
          if (response.status === 401 || response.status === 403) {
            throw await this.failExecutionRequest(response, 'ws-ticket')
          }
          if (!response.ok) throw new Error(`WebSocket authentication failed: HTTP ${response.status}`)
          const body = await response.json() as { ticket?: unknown }
          if (typeof body.ticket !== 'string') throw new Error('WebSocket authentication returned no ticket')
          return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(body.ticket)}`
        },
      }),
      ...(config.webSocketFactory ? { webSocketFactory: config.webSocketFactory } : {}),
      ...(config.scheduleFn ? { scheduleFn: config.scheduleFn } : {}),
      ...(config.cancelFn ? { cancelFn: config.cancelFn } : {}),
      onData: (data) => this.handleWsData(data),
    })
    this.status = this.socket.status
  }

  /** Subscribe to normalized events. Returns unsubscribe. */
  onEvent(listener: (e: NormalizedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onProblem(listener: (problem: Diagnostic) => void): () => void {
    this.problemListeners.add(listener)
    return () => {
      this.problemListeners.delete(listener)
    }
  }

  private emitProblem(problem: Diagnostic): void {
    for (const listener of this.problemListeners) listener(problem)
  }

  private async failExecutionRequest(response: Response, operation: string): Promise<ExecutionRequestError> {
    const problem = responseDiagnostic(response.status, await responsePayload(response), operation)
    this.emitProblem(problem)
    if (operation === 'events' || operation === 'ws-ticket') this.socket.disconnect()
    return new ExecutionRequestError(problem)
  }

  /** Subscribe to persisted completed job_state messages, excluding fetched replays. */
  onLiveCompletion(listener: (execution: ExecutionRef) => void): () => void {
    this.liveCompletionListeners.add(listener)
    return () => this.liveCompletionListeners.delete(listener)
  }

  /** Subscribe to the server's droppable memory telemetry stream. */
  onMemoryStatus(listener: (status: MemoryStatus) => void): () => void {
    this.memoryListeners.add(listener)
    return () => this.memoryListeners.delete(listener)
  }

  private emit(events: readonly NormalizedEvent[]): void {
    for (const e of events) for (const l of [...this.listeners]) l(e)
  }

  private emitRaw(raw: DinksterRawMessage, live: boolean): void {
    if (live && !(raw instanceof ArrayBuffer)) this.noteLiveJobEvent(raw)
    const events = this.normalizer.normalize(raw)
    this.emit(events)
    if (!live || raw instanceof ArrayBuffer || raw.type !== 'job_state' || raw['state'] !== 'completed') return
    const jobId = raw['jobId']
    if (typeof jobId !== 'string' || jobId === '') return
    for (const listener of [...this.liveCompletionListeners]) listener(this.executionFor(jobId))
  }

  // -- Schemas ----------------------------------------------------------------

  async fetchSchemas(): Promise<SchemaRegistry> {
    const generation = ++this.schemaRequestGeneration
    const promise = this.fetchSchemasPass(generation)
    this.newestSchemaFetch = { generation, promise }
    // A superseded invocation must hand back the registry the connection
    // actually committed, not its own stale decode: follow the newest fetch
    // until this invocation IS the newest. A stale fetch's failure is
    // likewise answered by the newer fetch.
    let current = { generation, promise }
    for (;;) {
      const newest = (): { generation: number; promise: Promise<SchemaRegistry> } =>
        this.newestSchemaFetch ?? current
      try {
        const registry = await current.promise
        if (newest().generation === current.generation) {
          if (current.generation !== this.schemaRequestGeneration) {
            throw new Error('schema fetch invalidated by server reconnect')
          }
          return registry
        }
      } catch (error) {
        if (newest().generation === current.generation) throw error
      }
      current = newest()
    }
  }

  private async fetchSchemasPass(
    generation: number,
    pairingAttempts = 3,
  ): Promise<SchemaRegistry> {
    const res = await this.fetchFn(`${this.baseUrl}/api/nodes`)
    if (res.status === 503) {
      // A supervisor gates every proxied route with 503 engine-not-ready
      // until the engine answers healthy. Surface that as its own error so
      // the app renders "starting", never a connection failure.
      const gate = parseEngineNotReady(await res.json().catch(() => undefined))
      if (gate) throw new EngineNotReadyError(gate.state)
    }
    if (!res.ok) throw new Error(`GET /api/nodes failed: ${res.status}`)
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('GET /api/nodes: malformed schema payload')
    }
    const payload = raw as DinksterNodesPayload
    // Wire version rides the dinkster header (schemaWire) on current backends;
    // top-level schemaVersion is the API surface version there. Older shapes
    // carry the wire version top-level. Same resolution as parseDinksterNodes.
    const wireVersion = serverInfoFromDinksterWire(payload)?.schemaWire ?? payload.schemaVersion
    if (wireVersion !== DINKSTER_SCHEMA_WIRE_VERSION) {
      throw new Error(
        `schema wire version mismatch: this build decodes ${DINKSTER_SCHEMA_WIRE_VERSION}; the server encodes ${String(wireVersion)}`,
      )
    }
    if (typeof payload.nodes !== 'object' || payload.nodes === null || Array.isArray(payload.nodes)) {
      throw new Error('GET /api/nodes: malformed or unsupported schema payload')
    }
    let extensionSnapshotPair: { readonly digest: string; readonly snapshot: EffectiveExtensionSnapshot } | undefined
    if (payload.extensionSnapshotDigest !== undefined) {
      if (typeof payload.extensionSnapshotDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(payload.extensionSnapshotDigest)) {
        throw new Error('GET /api/nodes: malformed extensionSnapshotDigest')
      }
      const extensionSnapshotDigest = payload.extensionSnapshotDigest
      const snapshotResponse = await this.fetchFn(`${this.baseUrl}/api/extensions/snapshot`)
      if (!snapshotResponse.ok) throw new Error(`GET /api/extensions/snapshot failed: ${snapshotResponse.status}`)
      const snapshotBuffer = await snapshotResponse.arrayBuffer()
      const snapshotBytes = new Uint8Array(snapshotBuffer)
      const actualDigest = await sha256Digest(snapshotBuffer)
      if (actualDigest !== extensionSnapshotDigest) {
        if (pairingAttempts > 1) {
          return this.fetchSchemasPass(generation, pairingAttempts - 1)
        }
        throw new Error(`schema/snapshot pairing failed: schema names '${extensionSnapshotDigest}', snapshot hashes to '${actualDigest}'`)
      }
      let snapshotValue: unknown
      try {
        const snapshotText = new TextDecoder('utf-8', { fatal: true }).decode(snapshotBytes)
        snapshotValue = JSON.parse(snapshotText)
      } catch {
        throw new Error('GET /api/extensions/snapshot: malformed JSON')
      }
      const decoded = decodeEffectiveExtensionSnapshot(snapshotValue)
      if (decoded.snapshot === undefined) throw new Error(`GET /api/extensions/snapshot: ${decoded.diagnostics.map((item) => item.message).join('; ')}`)
      extensionSnapshotPair = { digest: extensionSnapshotDigest, snapshot: decoded.snapshot }
    }
    const registry = buildDinksterRegistry(
      this.id,
      payload,
      extensionSnapshotPair,
    )
    if (registry.diagnostics.some((entry) => entry.code === 'schema.dinkster.wireVersion')) {
      const selected = serverInfoFromDinksterWire(payload)?.schemaWire ?? payload.schemaVersion
      throw new Error(
        `schema wire version mismatch: this build decodes ${DINKSTER_SCHEMA_WIRE_VERSION}; the server encodes ${String(selected)}`,
      )
    }
    if (generation === this.schemaRequestGeneration) {
      this.registry = registry
      if (extensionSnapshotPair) this.extensionSnapshots.set(extensionSnapshotPair.digest, extensionSnapshotPair.snapshot)
    }
    return registry
  }

  /** The registry the connection currently submits against (last committed
   * fetchSchemas result; a superseded fetch never overwrites a fresher one). */
  get currentRegistry(): SchemaRegistry | undefined {
    return this.registry
  }

  /** Fetch the complete current execution-location catalog. */
  async fetchWorkers(): Promise<readonly WorkerInfo[]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/workers`)
    if (!res.ok) throw new Error(`GET /api/workers failed: ${res.status}`)
    const workers = decodeWorkers(await res.json())
    if (workers === undefined) throw new Error('GET /api/workers: malformed response')
    return workers
  }

  /** A connected transition starts a new server lifetime; old extension authority is invalid immediately. */
  invalidateExtensionSnapshotPair(): void {
    // A fetch issued under the previous server lifetime may still resolve.
    // Supersede it even when no pair is currently held so it cannot publish
    // stale authority after this boundary.
    this.schemaRequestGeneration += 1
    this.extensionSnapshots.clear()
    if (this.registry?.extensionSnapshotPair === undefined) return
    const registry = { ...this.registry }
    delete registry.extensionSnapshotPair
    this.registry = registry
  }

  /**
   * GET /api/diagnostics: the server's startup validation of replacement
   * rules against the COMPLETE installed schema mapping (cross-pack refs
   * are only checkable there; a pack's own doctor sees one pack at a time).
   * Strictly advisory - a problem never makes a schema unloadable - so
   * every failure mode (older backend without the endpoint, transport
   * error, malformed entry) degrades to an empty diagnostics snapshot,
   * never an exception. The response grows additively; unknown fields pass
   * through unread and non-conforming entries are skipped.
   */
  async fetchDiagnostics(): Promise<DinksterDiagnostics> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/diagnostics`)
      if (!res.ok) return emptyDiagnostics()
      const raw = (await res.json()) as {
        replacementProblems?: unknown
        compatSkips?: unknown
        packInferenceUnavailable?: unknown
      }
      const packInferenceUnavailable: PackInferenceUnavailable[] = []
      if (Array.isArray(raw.packInferenceUnavailable)) {
        for (const value of raw.packInferenceUnavailable) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            continue
          }
          const pack = (value as Record<string, unknown>)['packId']
          const payload = readUnavailableInference(value)
          if (payload !== undefined && typeof pack === 'string' && pack !== '') {
            packInferenceUnavailable.push({ pack, ...payload })
          }
        }
      }
      return {
        replacementProblems: Array.isArray(raw.replacementProblems)
          ? raw.replacementProblems.filter(isReplacementProblem)
          : [],
        compatSkips: Array.isArray(raw.compatSkips)
          ? raw.compatSkips.filter(isCompatSkip)
          : [],
        packInferenceUnavailable,
      }
    } catch {
      return emptyDiagnostics()
    }
  }

  /**
   * Read current process-lifetime pack failures. Absence, transport failure,
   * and malformed snapshots are not authoritative and must not clear a
   * previously observed failure.
   */
  async fetchCompositionFailures(): Promise<readonly DinksterPackFailure[] | undefined> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/composition`)
      if (!res.ok) return undefined
      const raw: unknown = await res.json()
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
      const packs = (raw as Record<string, unknown>)['packs']
      if (typeof packs !== 'object' || packs === null || Array.isArray(packs)) return undefined
      const failures: DinksterPackFailure[] = []
      for (const [pack, value] of Object.entries(packs)) {
        if (pack === '' || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
        const row = value as Record<string, unknown>
        if (row['state'] === 'failed') {
          if (typeof row['error'] !== 'string' || row['error'] === '') return undefined
          failures.push({ pack, error: row['error'] })
          continue
        }
        if (row['state'] !== 'pending' && row['state'] !== 'announced' && row['state'] !== 'removed') {
          return undefined
        }
      }
      return failures
    } catch {
      return undefined
    }
  }

  /** Read the server-discovered runtime settings surface. */
  async fetchRuntimeSettings(): Promise<RuntimeSettings> {
    const res = await this.fetchFn(`${this.baseUrl}/api/settings`)
    if (!res.ok) throw new RuntimeSettingsError(res.status, undefined)
    return await res.json() as RuntimeSettings
  }

  async fetchPackSettings(packId: string): Promise<PackSettings> {
    const res = await this.fetchFn(`${this.baseUrl}/api/packs/${encodeURIComponent(packId)}/settings`)
    if (!res.ok) throw new Error(`pack settings request failed: ${res.status}`)
    const decoded = decodePackSettings(await res.json())
    if (decoded === undefined) throw new Error('pack settings response is malformed')
    return decoded
  }

  async updatePackSettings(
    packId: string,
    values: Readonly<Record<string, string | number | boolean>>,
  ): Promise<PackSettings> {
    const res = await this.fetchFn(`${this.baseUrl}/api/packs/${encodeURIComponent(packId)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => undefined) as { error?: unknown } | undefined
      throw new Error(typeof body?.error === 'string' ? body.error : `pack settings update failed: ${res.status}`)
    }
    const decoded = decodePackSettings(await res.json())
    if (decoded === undefined) throw new Error('pack settings response is malformed')
    return decoded
  }

  async fetchP2PStatus(): Promise<P2PStatus> {
    const res = await this.fetchFn(`${this.baseUrl}/api/p2p/status`)
    if (!res.ok) throw await p2pRequestError(res, 'GET /api/p2p/status')
    const raw: unknown = await res.json()
    if (record(raw) && exactKeys(raw, ['state', 'message', 'sidecar'])
      && raw['state'] === 'unavailable' && typeof raw['message'] === 'string'
      && raw['sidecar'] === null) throw new Error(raw['message'])
    const status = decodeP2PStatus(raw)
    if (status === undefined) throw new Error('GET /api/p2p/status: malformed response')
    return status
  }

  async performP2PTransferAction(digest: string, action: P2PTransferAction): Promise<void> {
    if (!p2pDigest(digest)) throw new TypeError('P2P transfer digest must be a canonical BLAKE3 digest')
    const res = await this.fetchFn(`${this.baseUrl}/api/p2p/transfers/${encodeURIComponent(digest)}/${action}`, { method: 'POST' })
    if (!res.ok) throw await p2pRequestError(res, `POST P2P transfer ${action}`)
  }

  /** Read memory telemetry. Item-level consumer details are opt-in. */
  async fetchMemoryStatus(details = false): Promise<MemoryStatus> {
    const res = await this.fetchFn(`${this.baseUrl}/memory/status${details ? '?details=1' : ''}`)
    if (!res.ok) throw new Error(`GET /memory/status failed: ${res.status}`)
    const status = decodeMemoryStatus(await res.json())
    if (status === undefined) throw new Error('GET /memory/status: malformed response')
    return status
  }

  /** Update one discovered category; the server owns validation and gating. */
  async updateRuntimeSetting(category: string, value: unknown): Promise<RuntimeSettingSection> {
    const res = await this.fetchFn(`${this.baseUrl}/api/settings/${encodeURIComponent(category)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
    if (!res.ok) {
      const raw: unknown = await res.json().catch(() => undefined)
      throw new RuntimeSettingsError(res.status, decodeRuntimeSettingsError(res.status, raw))
    }
    return await res.json() as RuntimeSettingSection
  }

  async fetchPrincipals(): Promise<readonly PrincipalSummary[]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/principals`)
    if (!res.ok) throw new PrincipalsError(res.status)
    const value: unknown = await res.json()
    return Array.isArray(value)
      ? value.map(decodePrincipalSummary).filter((principal): principal is PrincipalSummary => principal !== undefined)
      : []
  }

  mintDelegation(options: MintDelegation): ReturnType<typeof mintDelegation> {
    return mintDelegation(this.baseUrl, options, this.fetchFn)
  }

  async fetchDelegations(): Promise<readonly Delegation[]> {
    const response = await this.fetchFn(`${this.baseUrl}/api/auth/delegations`)
    if (!response.ok) throw new PrincipalsError(response.status)
    return response.json()
  }

  async revokeDelegation(id: string): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/api/auth/delegations/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) throw new PrincipalsError(response.status)
  }

  async updatePrincipalPermissions(
    principalId: string,
    changes: Readonly<Record<string, boolean>>,
  ): Promise<Readonly<Record<string, boolean>>> {
    const res = await this.fetchFn(`${this.baseUrl}/api/principals/${encodeURIComponent(principalId)}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    })
    if (!res.ok) {
      const value: unknown = await res.json().catch(() => undefined)
      const serverError = typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>)['error'] === 'string'
        ? (value as Record<string, string>)['error']
        : undefined
      throw new PrincipalsError(res.status, serverError)
    }
    return decodePermissionCategories(await res.json())
  }

  // -- Job submission -----------------------------------------------------------

  async submit(
    artifact: CompileArtifact,
    options?: {
      /**
       * blake3:<64 hex> asset digest of the producing workflow document
       * (uploaded via uploadAsset). Advisory reproduction record: echoed on
       * the job wire and history, never part of execution identity.
       */
      readonly sourceDocument?: string
      /**
       * Live sampling preview policy for this run. Sent verbatim as the
       * submit body's `previews` field; servers without preview support
       * ignore it. Omitted, the server applies its own default. `nodes`
       * carries per-node overrides keyed by runtime node id.
       */
      readonly previews?: {
        readonly mode: PreviewMode
        readonly nodes?: Readonly<Record<string, PreviewMode>>
      }
      /** Transient top-level node placement by configured worker name. */
      readonly placement?: Readonly<Record<string, string>>
    },
  ): Promise<DinksterSubmitResult> {
    if (artifact.connection !== this.id) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'compile', 'submit.wrongConnection', `artifact compiled for connection '${artifact.connection}', submitted to '${this.id}'`),
        ],
      }
    }
    const registry = this.registry
    if (registry === undefined || registry.hash !== artifact.schemaHash) {
      return {
        ok: false,
        diagnostics: [
          diag(
            'error',
            'compile',
            'submit.staleSchemas',
            registry === undefined
              ? 'schemas have not been fetched on this connection'
              : `artifact compiled against schema hash '${artifact.schemaHash}', connection has '${registry.hash}' - recompile`,
          ),
        ],
      }
    }
    const placement = options?.placement === undefined ? undefined : { ...options.placement }
    const placementNodeIds = placement === undefined ? [] : Object.keys(placement)
    if (placementNodeIds.length > 0 && !registry.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_PLACEMENT)) {
      return {
        ok: false,
        diagnostics: [diag('error', 'compile', 'submit.placementUnsupported', 'this backend does not advertise manual worker placement support')],
      }
    }
    if (artifact.dinksterGraph !== undefined && !registry.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_REGIONS)) {
      return {
        ok: false,
        diagnostics: [diag('error', 'compile', 'compile.region.backendUnsupported', 'this backend no longer advertises first-class region execution support')],
      }
    }
    const converted = artifact.dinksterGraph === undefined
      ? promptToDinksterGraph(artifact.prompt, registry.resolve)
      : { ok: true as const, graph: artifact.dinksterGraph }
    if (!converted.ok) return { ok: false, diagnostics: converted.diagnostics }
    // Pre-flight structural validation of the lowered wire (same checks the
    // server runs at admission: id grammar, region shape, cycles). Compiled
    // prompts satisfy these by construction, so a hit here is a lowering bug
    // caught before it becomes a confusing server-side job failure.
    const graph = expandDynamicPromptsInGraph(
      converted.graph,
      registry.resolve,
      Math.random,
      dynamicPromptInputsForArtifact(artifact),
    )
    const structural = validateDinksterGraph(graph)
    if (structural.some((d) => d.severity === 'error')) {
      return { ok: false, diagnostics: structural }
    }
    const missingPlacementNodes = placementNodeIds.filter((nodeId) => !Object.hasOwn(graph.nodes, nodeId))
    if (missingPlacementNodes.length > 0) {
      return {
        ok: false,
        diagnostics: [diag(
          'error',
          'compile',
          'submit.placementInvalid',
          `worker placement references non-active top-level node${missingPlacementNodes.length === 1 ? '' : 's'}: ${missingPlacementNodes.map((id) => `'${id}'`).join(', ')}`,
        )],
      }
    }
    const targets = targetsForArtifact(artifact, registry.resolve)
    if (targets.length === 0) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'compile', 'submit.noTargets', 'nothing to execute: the graph has no output nodes and no partial targets'),
        ],
      }
    }
    const jobId = this.jobIdFactory()
    const body = {
      clientId: this.clientId,
      jobId,
      targets,
      graph: graph as unknown as Json,
      ...(options?.sourceDocument !== undefined ? { sourceDocument: options.sourceDocument } : {}),
      ...(options?.previews !== undefined ? { previews: options.previews } : {}),
      ...(placementNodeIds.length > 0 ? { placement } : {}),
    }
    const post = async (acquireAssets?: readonly string[]): Promise<DinksterSubmitResult> => {
      const res = await this.fetchFn(`${this.baseUrl}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...(acquireAssets !== undefined ? { acquireAssets } : {}) }),
      })
      if (!res.ok) {
        const rejection = await rejectionDetails(res, artifact)
        if (res.status === 401 || res.status === 403) {
          for (const problem of rejection.diagnostics) this.emitProblem(problem)
        }
        if (rejection.assetsMissing !== undefined) {
          return {
            ok: false,
            diagnostics: rejection.diagnostics,
            assetsMissing: rejection.assetsMissing,
            retryWithAssets: post,
          }
        }
        return { ok: false, diagnostics: rejection.diagnostics }
      }
      // jobRef (Dinkster 258382e): server-assigned global job identity on the
      // 202 body. Same value as runId (promoted run_id); a rerun of the same
      // (clientId, jobId) key mints a NEW jobRef. Optional: absent on
      // pre-jobRef servers, and a malformed body never fails an accepted job.
      const accepted = (await res.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined
      const jobRef = typeof accepted?.['jobRef'] === 'string' ? accepted['jobRef'] : undefined
      return {
        ok: true,
        execution: this.executionFor(jobId),
        ...(jobRef !== undefined ? { jobRef } : {}),
      }
    }
    return post()
    // Native validation runs when the job is admitted and fails the JOB (a
    // job_state 'failed' event with diagnostics) - acceptance here is only
    // "queued", exactly what an ExecutionRef means.
  }

  private executionFor(jobId: string): ExecutionRef {
    // Same convention as DinksterNormalizer: ExecutionRef.prompt = jobId.
    return { connection: this.id, prompt: asPromptId(jobId) }
  }

  /** Cancel one job (the native protocol has no global interrupt). */
  async cancel(execution: ExecutionRef): Promise<void> {
    if (execution.connection !== this.id) throw new Error(`cannot cancel execution from connection '${execution.connection}' on '${this.id}'`)
    const res = await this.fetchFn(this.jobUrl(execution.prompt), { method: 'DELETE' })
    if (!res.ok) throw await this.failExecutionRequest(res, 'cancel')
  }

  // -- Job hydration --------------------------------------------------------------

  private jobUrl(jobId: string): string {
    return `${this.baseUrl}/api/jobs/${encodeURIComponent(this.clientId)}/${encodeURIComponent(jobId)}`
  }

  /**
   * Fetch one job record, or undefined when the server has none (bounded
   * history eviction or a restart).
   */
  async fetchJob(jobId: string, operation = 'inspect'): Promise<DinksterJobRecord | undefined> {
    const res = await this.fetchFn(this.jobUrl(jobId))
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw await this.failExecutionRequest(res, operation)
    const payload: unknown = await res.json()
    const state = (payload as { state?: unknown } | null)?.state
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload) ||
      typeof state !== 'string' ||
      !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(state)) {
      throw new Error('GET job: malformed response')
    }
    const record = payload as DinksterJobWire & {
      readonly clientId?: unknown
      readonly jobId?: unknown
      readonly artifacts?: unknown
    }
    // Identity check: a record carrying a DIFFERENT identity than the one
    // requested must never reconcile this job (e.g. a proxy or cache slip).
    // Absent identity fields are fine - the URL is the request's identity.
    if (record.jobId !== undefined && record.jobId !== jobId) {
      throw new Error(`GET job: response identity mismatch (expected ${jobId})`)
    }
    if (record.clientId !== undefined && record.clientId !== this.clientId) {
      throw new Error('GET job: response clientId mismatch')
    }
    const artifacts = decodeJobArtifacts(record.artifacts)
    const submittedBy = decodeExecutionSubmitter((record as Record<string, unknown>)['submittedBy'])
    const sourceDocument = typeof record.sourceDocument === 'string' ? record.sourceDocument : undefined
    const {
      artifacts: _wireArtifacts,
      submittedBy: _wireSubmittedBy,
      sourceDocument: _wireSourceDocument,
      ...withoutOptionalFields
    } = record as DinksterJobRecord & { readonly submittedBy?: unknown }
    return {
      ...withoutOptionalFields,
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(submittedBy !== undefined ? { submittedBy } : {}),
      ...(sourceDocument !== undefined ? { sourceDocument } : {}),
    }
  }

  /**
   * Replay a fetched job record into the normalized event stream - the
   * reconnect/hydration path (a frozen view must survive a page reload).
   * Node states go through nodeStatesFromDinksterJob; the terminal transition
   * re-enters through the normalizer as the job_state wire message it IS,
   * so error mapping/dedupe stay in one place.
   */
  replayJob(jobId: string, job: DinksterJobRecord): void {
    const timestamp = Date.now()
    const nodes = nodeStatesFromDinksterJob(job)
    if (Object.keys(nodes).length > 0) {
      // snapshot: the fetched record may be OLDER than live events that
      // raced past the fetch - the store merges it conservatively.
      this.emit([
        { kind: 'nodeStates', execution: this.executionFor(jobId), timestamp, nodes, snapshot: true },
      ])
    }
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
      this.emitRaw({
        type: 'job_state',
        jobId,
        state: job.state,
        ...(job.error !== undefined && job.error !== null ? { error: job.error } : {}),
      }, false)
    }
  }

  // -- Run journal backfill ---------------------------------------------------

  /**
   * One page of the run's persisted event journal, or undefined when the
   * server has none (no journal configured, unknown run, or wrong scope -
   * indistinguishable by design). Malformed pages throw; individual records
   * missing a numeric seq are dropped (forward compatibility).
   */
  async fetchRunJournal(
    runId: string,
    scope: string,
    after = 0,
    limit = RUN_JOURNAL_PAGE_LIMIT,
  ): Promise<RunJournalPage | undefined> {
    const url = `${this.baseUrl}/api/runs/${encodeURIComponent(runId)}/journal?scope=${encodeURIComponent(scope)}&after=${after}&limit=${limit}`
    const res = await this.fetchFn(url)
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`GET run journal failed: ${res.status}`)
    const payload: unknown = await res.json()
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('GET run journal: malformed response')
    }
    const page = payload as { records?: unknown; latestSeq?: unknown; coalescedBelow?: unknown }
    if (!Array.isArray(page.records) || typeof page.latestSeq !== 'number') {
      throw new Error('GET run journal: malformed response')
    }
    const records: RunJournalRecord[] = []
    for (const entry of page.records) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as { seq?: unknown; name?: unknown; payload?: unknown }
      if (typeof record.seq !== 'number') continue
      const wire = record.payload
      records.push({
        seq: record.seq,
        name: typeof record.name === 'string' ? record.name : '',
        ...(typeof wire === 'object' && wire !== null && !Array.isArray(wire)
          ? { payload: wire as Readonly<Record<string, unknown>> }
          : {}),
      })
    }
    return {
      records,
      latestSeq: page.latestSeq,
      coalescedBelow: typeof page.coalescedBelow === 'number' ? page.coalescedBelow : 0,
    }
  }

  /**
   * Replay the run journal's log records into the normalized event stream -
   * the reconnect/reload path for the execution log. Only `log` records are
   * replayed: node states and terminal transitions already reconcile through
   * replayJob, and the store dedupes log rows by per-job seq, so replaying
   * over live-received rows is safe. Concurrent calls for one run coalesce,
   * and a per-run cursor makes repeat calls fetch only newer records.
   */
  backfillRunLog(runId: string, scope: string): Promise<void> {
    const inFlight = this.runLogBackfills.get(runId)
    if (inFlight !== undefined) return inFlight
    const pass = this.backfillRunLogPass(runId, scope).finally(() => {
      this.runLogBackfills.delete(runId)
    })
    this.runLogBackfills.set(runId, pass)
    return pass
  }

  private async backfillRunLogPass(runId: string, scope: string): Promise<void> {
    let after = this.runLogCursors.get(runId) ?? 0
    for (let pages = 0; pages < RUN_JOURNAL_MAX_PAGES; pages++) {
      const page = await this.fetchRunJournal(runId, scope, after)
      if (page === undefined) return
      for (const record of page.records) {
        if (record.name !== 'log') continue
        const wire = record.payload
        if (wire === undefined || typeof wire['type'] !== 'string') continue
        this.emitRaw(wire as DinksterRawJson, false)
      }
      const tail = page.records[page.records.length - 1]
      if (tail !== undefined && tail.seq > after) {
        after = tail.seq
        this.runLogCursors.set(runId, after)
      }
      if (tail === undefined || after >= page.latestSeq) return
    }
  }

  /**
   * First live sight of a job whose wire seq is past 1 means earlier events
   * were never delivered here (page reload mid-run, a WS that connected
   * late). The run journal, when the server keeps one, holds those events -
   * fetch the job record for the run identity and replay the journal's log
   * records. Fire-and-forget: the journal is an optional server capability
   * and a miss never disturbs the live stream.
   */
  private noteLiveJobEvent(raw: DinksterRawJson): void {
    const jobId = raw['jobId']
    if (typeof jobId !== 'string' || jobId === '' || this.seenLiveJobs.has(jobId)) return
    this.seenLiveJobs.add(jobId)
    const seq = raw['seq']
    if (typeof seq !== 'number' || seq <= 1) return
    void this.backfillJobRunLog(jobId)
  }

  private async backfillJobRunLog(jobId: string): Promise<void> {
    try {
      const job = await this.fetchJob(jobId)
      if (job === undefined) return
      const identity = runJournalIdentity(job)
      if (identity === undefined) return
      await this.backfillRunLog(identity.runId, identity.scope)
    } catch {
      // Journal-less or older servers: the live stream stays authoritative.
    }
  }

  /**
   * Job outputs recorded on the server for one job: value DESCRIPTORS
   * (typeId/fingerprint/meta/length), never raw payloads. Keyed
   * outputs[nodeId][outputId]. Returns {} when missing or malformed.
   */
  async fetchJobOutputs(
    jobId: string,
  ): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
    const job = await this.fetchJob(jobId, 'outputs')
    const outputs = job?.outputs
    return typeof outputs === 'object' && outputs !== null && !Array.isArray(outputs)
      ? (outputs as Record<string, Readonly<Record<string, unknown>>>)
      : {}
  }

  // -- Workflow library (POST /api/assets + /api/library) --------------------

  /**
   * Upload opaque bytes to the content-addressed vault. Idempotent (201 new,
   * 200 already-held). Returns the canonical "blake3:<64 hex>" digest.
   * Throws on any failure - including 404 when the server runs without
   * --library-root - so callers decide whether absence is an error.
   * An optional AbortSignal cancels the request: an upload UI that locks
   * dismissal while a POST is pending needs a recovery path when the
   * server never answers (the fetch is otherwise unbounded).
   */
  async uploadAsset(bytes: Blob | ArrayBuffer | Uint8Array | string, signal?: AbortSignal): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Uint8Array is accepted by Fetch at runtime but older DOM typings omit
      // it from BodyInit; preserve the caller's exact view rather than copy.
      body: bytes as BodyInit,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!res.ok) throw new Error(`POST /api/assets failed: ${res.status}`)
    const payload = (await res.json()) as { digest?: unknown }
    if (typeof payload.digest !== 'string') throw new Error('POST /api/assets: malformed response')
    return payload.digest
  }

  /** Validate and adopt canonical ImageDocument bytes plus their scoped dependencies. */
  async adoptImageDocument(
    bytes: Blob | ArrayBuffer | Uint8Array | string,
    options: { readonly scope: string; readonly expectedDigest?: string; readonly signal?: AbortSignal },
  ): Promise<AdoptedImageDocument> {
    const headers = new Headers({ 'Content-Type': IMAGE_DOCUMENT_MEDIA_TYPE })
    if (options.expectedDigest !== undefined) headers.set('X-Dinkster-Digest', options.expectedDigest)
    const query = new URLSearchParams({ scope: options.scope })
    const res = await this.fetchFn(`${this.baseUrl}/api/assets/image-document?${query}`, {
      method: 'POST',
      headers,
      body: bytes as BodyInit,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (!res.ok) throw new Error(`POST /api/assets/image-document failed: ${res.status}`)
    const adopted = adoptedImageDocument(await res.json())
    if (adopted === undefined ||
      (options.expectedDigest !== undefined && adopted.digest !== options.expectedDigest)) {
      throw new Error('POST /api/assets/image-document: malformed response')
    }
    return adopted
  }

  /** Read an adopted asset's immutable dependency manifest. */
  async fetchImageDocumentDependencies(
    digest: string,
    signal?: AbortSignal,
  ): Promise<readonly ImageDocumentDependency[] | undefined> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/assets/${encodeURIComponent(digest)}/dependencies`,
      signal !== undefined ? { signal } : undefined,
    )
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`GET /api/assets/${digest}/dependencies failed: ${res.status}`)
    const payload: unknown = await res.json()
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('GET ImageDocument dependencies: malformed response')
    }
    const row = payload as Record<string, unknown>
    const dependencies = imageDocumentDependencies(row['dependencies'])
    if (row['digest'] !== digest || dependencies === undefined) {
      throw new Error('GET ImageDocument dependencies: malformed response')
    }
    return dependencies
  }

  /** Render one adopted ImageDocument through the backend CPU reference profile. */
  async renderImageDocument(
    digest: string,
    options: {
      readonly scope: string
      readonly selector?: string
      readonly signal?: AbortSignal
    },
  ): Promise<RenderedImageDocument> {
    const query = new URLSearchParams({ scope: options.scope })
    const res = await this.fetchFn(
      `${this.baseUrl}/api/assets/${encodeURIComponent(digest)}/render?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selector: options.selector ?? 'composite',
          profile: IMAGE_DOCUMENT_RENDER_PROFILE,
        }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    )
    if (!res.ok) throw new Error(`POST /api/assets/${digest}/render failed: ${res.status}`)
    const rendered = renderedImageDocument(await res.json())
    if (rendered === undefined || rendered.provenance.documentDigest !== digest ||
      rendered.provenance.selector !== (options.selector ?? 'composite')) {
      throw new Error('POST ImageDocument render: malformed response')
    }
    return rendered
  }

  /** Upload classified source media and return only the server-authored AssetRef. */
  async uploadMediaAsset(
    file: File,
    options: {
      readonly scope: string
      readonly kind: 'media/image' | 'media/audio' | 'media/video'
      readonly name: string
      readonly expectedDigest?: string
      readonly signal?: AbortSignal
    },
  ): Promise<MediaAssetRef> {
    const query = new URLSearchParams({ scope: options.scope, kind: options.kind, name: options.name })
    const headers = new Headers({ 'Content-Type': file.type })
    if (options.expectedDigest !== undefined) headers.set('X-Dinkster-Digest', options.expectedDigest)
    const res = await this.fetchFn(`${this.baseUrl}/api/assets/media?${query}`, {
      method: 'POST',
      headers,
      body: file,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (!res.ok) throw new Error(`POST /api/assets/media failed: ${res.status}`)
    return classifiedAssetRef(await res.json(), options.kind, 'POST /api/assets/media')
  }

  /** Upload a validated safetensors latent and adopt the server-authored AssetRef. */
  async uploadLatentAsset(
    file: File,
    options: { readonly scope: string; readonly name: string; readonly signal?: AbortSignal },
  ): Promise<MediaAssetRef> {
    const query = new URLSearchParams({ scope: options.scope, name: options.name })
    const res = await this.fetchFn(`${this.baseUrl}/api/assets/latent?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-comfy-latent' },
      body: file,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (!res.ok) throw new Error(`POST /api/assets/latent failed: ${res.status}`)
    return classifiedAssetRef(await res.json(), 'data/latent', 'POST /api/assets/latent')
  }

  /** Resolve legacy asset names without acquiring bytes or changing a document. */
  async guessAssets(names: readonly string[], digestHints?: Readonly<Record<string, string>>): Promise<readonly AssetGuessMatch[]> {
    const matches: AssetGuessMatch[] = []
    for (let offset = 0; offset < names.length; offset += 64) {
      const batch = names.slice(offset, offset + 64)
      const batchNames = new Set(batch)
      const batchHints = Object.fromEntries(Object.entries(digestHints ?? {})
        .filter(([name, digest]) => batchNames.has(name) && /^blake3:[0-9a-f]{64}$/i.test(digest))
        .map(([name, digest]) => [name, digest.toLowerCase()]))
      const hinted = Object.keys(batchHints).length > 0
      const request = (includeHints: boolean) => this.fetchFn(`${this.baseUrl}/api/assets/guess`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          names: batch,
          ...(includeHints ? { digestHints: batchHints } : {}),
        }),
      })
      let res = await request(hinted)
      if (hinted && res.status === 400) res = await request(false)
      if (!res.ok) throw new Error(`POST /api/assets/guess failed: ${res.status}`)
      matches.push(...parseAssetGuessMatches(await res.json()))
    }
    return matches
  }

  /** Fetch asset bytes as text; undefined when not held (or no library). */
  async fetchAssetText(digest: string): Promise<string | undefined> {
    const res = await this.fetchFn(`${this.baseUrl}/api/assets/${encodeURIComponent(digest)}`)
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`GET /api/assets/${digest} failed: ${res.status}`)
    return res.text()
  }

  /** Fetch opaque asset bytes without corrupting images through text decoding. */
  async fetchAssetBytes(digest: string): Promise<ArrayBuffer | undefined> {
    const res = await this.fetchFn(`${this.baseUrl}/api/assets/${encodeURIComponent(digest)}`)
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`GET /api/assets/${digest} failed: ${res.status}`)
    return res.arrayBuffer()
  }

  assetUrl(digest: string): string {
    return `${this.baseUrl}/api/assets/${encodeURIComponent(digest)}`
  }

  async fetchMountSettings(): Promise<MountSettings> {
    const res = await this.fetchFn(`${this.baseUrl}/api/mounts`)
    if (!res.ok) throw new Error(`GET /api/mounts failed: ${res.status}`)
    const payload = await res.json() as { mounts?: unknown; outputMount?: unknown; mountChangesAllowed?: unknown }
    // Compatibility: a response without the field (older backend) decodes
    // as false - read-only; a present non-boolean is a protocol error.
    if (payload.mountChangesAllowed !== undefined && typeof payload.mountChangesAllowed !== 'boolean') {
      throw new Error('GET /api/mounts: malformed mountChangesAllowed')
    }
    const rows = payload.mounts
    if (!Array.isArray(rows)) throw new Error('GET /api/mounts: malformed response')
    const mounts = rows.filter((value): value is MountDescriptor => {
      if (typeof value !== 'object' || value === null) return false
      const row = value as Record<string, unknown>
      const scanProgress = row['scanProgress']
      const progress = typeof scanProgress === 'object' && scanProgress !== null
        ? scanProgress as Record<string, unknown>
        : undefined
      const validProgress = scanProgress === undefined || (progress !== undefined &&
        ['filesDone', 'filesTotal', 'bytesDone', 'bytesTotal'].every((field) => {
          const number = progress[field]
          return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
        }) && typeof progress['elapsedSeconds'] === 'number' && Number.isFinite(progress['elapsedSeconds']) &&
        progress['elapsedSeconds'] >= 0 && (progress['filesDone'] as number) <= (progress['filesTotal'] as number) &&
        (progress['bytesDone'] as number) <= (progress['bytesTotal'] as number))
      return typeof row['id'] === 'string' && (row['mode'] === 'read' || row['mode'] === 'readwrite') &&
        typeof row['state'] === 'string' && (row['path'] === undefined || typeof row['path'] === 'string') &&
        (row['kind'] === undefined || typeof row['kind'] === 'string') &&
        (row['entryCount'] === undefined || (typeof row['entryCount'] === 'number' && Number.isSafeInteger(row['entryCount']) && row['entryCount'] >= 0)) && validProgress
    })
    if (payload.outputMount !== undefined && typeof payload.outputMount !== 'string') throw new Error('GET /api/mounts: malformed output mount')
    return {
      mounts,
      mountChangesAllowed: payload.mountChangesAllowed === undefined ? false : payload.mountChangesAllowed,
      ...(typeof payload.outputMount === 'string' ? { outputMount: payload.outputMount } : {}),
    }
  }

  async listMounts(): Promise<readonly MountDescriptor[]> {
    return (await this.fetchMountSettings()).mounts
  }

  async selectOutputMount(id: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/api/mounts/output`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!res.ok) throw new Error(`PUT /api/mounts/output failed: ${res.status}`)
  }

  async addMount(id: string, path: string, mode: 'read' | 'readwrite' = 'read'): Promise<MountDescriptor> {
    const res = await this.fetchFn(`${this.baseUrl}/api/mounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, path, mode }),
    })
    if (!res.ok) throw new Error(`POST /api/mounts failed: ${res.status}`)
    const value = await res.json() as Record<string, unknown>
    if (typeof value['id'] !== 'string' || (value['mode'] !== 'read' && value['mode'] !== 'readwrite') ||
      typeof value['state'] !== 'string') throw new Error('POST /api/mounts: malformed response')
    return value as unknown as MountDescriptor
  }

  async removeMount(id: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/api/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`DELETE /api/mounts/${id} failed: ${res.status}`)
  }

  async listMountEntries(mountId: string, req: { readonly q?: string; readonly path?: string; readonly recursive?: boolean; readonly cursor?: string; readonly limit?: number; readonly kind?: string; readonly signal?: AbortSignal } = {}): Promise<MountEntryPage> {
    const params = new URLSearchParams()
    if (req.q) params.set('q', req.q)
    if (req.path !== undefined) params.set('path', req.path)
    if (req.recursive !== undefined) params.set('recursive', req.recursive ? 'true' : 'false')
    if (req.cursor) params.set('cursor', req.cursor)
    if (req.limit !== undefined) params.set('limit', String(req.limit))
    if (req.kind) params.set('kind', req.kind)
    const res = await this.fetchFn(`${this.baseUrl}/api/mounts/${encodeURIComponent(mountId)}/entries?${params}`, req.signal !== undefined ? { signal: req.signal } : undefined)
    if (!res.ok) throw new Error(`GET mount entries failed: ${res.status}`)
    const payload = await res.json() as { entries?: unknown; folders?: unknown; cursor?: unknown; total?: unknown }
    const entries = Array.isArray(payload.entries) ? payload.entries.filter((value): value is MountEntry => {
      if (typeof value !== 'object' || value === null) return false
      const row = value as Record<string, unknown>
      return typeof row['virtualPath'] === 'string' && typeof row['name'] === 'string' && typeof row['digest'] === 'string' &&
        typeof row['size'] === 'number' && typeof row['mediaType'] === 'string' && (row['kind'] === undefined || typeof row['kind'] === 'string')
    }) : []
    const folders = Array.isArray(payload.folders) ? payload.folders.filter((value): value is string => typeof value === 'string') : undefined
    return {
      entries,
      ...(folders !== undefined ? { folders } : {}),
      ...(typeof payload.cursor === 'string' ? { cursor: payload.cursor } : {}),
      ...(typeof payload.total === 'number' ? { total: payload.total } : {}),
    }
  }

  async listMountFolder(mountId: string, path = ''): Promise<readonly MountFolderEntry[]> {
    const params = new URLSearchParams({ path })
    const res = await this.fetchFn(`${this.baseUrl}/api/mounts/${encodeURIComponent(mountId)}/list?${params}`)
    if (!res.ok) throw new Error(`GET mount folder failed: ${res.status}`)
    const payload = await res.json() as { entries?: unknown }
    return Array.isArray(payload.entries) ? payload.entries.flatMap((value): MountFolderEntry[] => {
      if (typeof value !== 'object' || value === null) return []
      const row = value as Record<string, unknown>
      const name = typeof row['name'] === 'string' ? row['name'] : undefined
      const virtualPath = typeof row['virtualPath'] === 'string' ? row['virtualPath'] : typeof row['path'] === 'string' ? row['path'] : undefined
      const folder = row['folder'] === true || row['type'] === 'folder' || row['kind'] === 'folder'
      return name && virtualPath ? [{ name, virtualPath, folder, ...(typeof row['childCount'] === 'number' ? { childCount: row['childCount'] } : {}) }] : []
    }) : []
  }

  async fetchAssetMetadata(digest: string): Promise<unknown | undefined> {
    const res = await this.fetchFn(`${this.baseUrl}/api/assets/${encodeURIComponent(digest)}/metadata`)
    if (res.status === 404 || res.status === 415 || res.status === 501) return undefined
    if (!res.ok) throw new Error(`GET asset metadata failed: ${res.status}`)
    return res.json()
  }

  /**
   * One page of library records. Query-first: the SERVER owns filtering
   * and ranking; the cursor is bound to (scope, query, label) and a
   * mismatched reuse is a server-side 400 (surfaces as a throw - restart
   * from page one). Malformed entries are skipped, never surfaced.
   */
  async listLibrary(req: {
    readonly scope: string
    readonly query?: string
    readonly label?: string
    readonly limit?: number
    readonly cursor?: string
  }): Promise<LibraryPage> {
    const params = new URLSearchParams({ scope: req.scope })
    if (req.query !== undefined && req.query !== '') params.set('q', req.query)
    if (req.label !== undefined) params.set('label', req.label)
    if (req.limit !== undefined) params.set('limit', String(req.limit))
    if (req.cursor !== undefined) params.set('cursor', req.cursor)
    const res = await this.fetchFn(`${this.baseUrl}/api/library?${params.toString()}`)
    if (!res.ok) throw new Error(`GET /api/library failed: ${res.status}`)
    const payload = (await res.json()) as { records?: unknown; cursor?: unknown }
    const records = Array.isArray(payload.records) ? payload.records.filter(isLibraryRecord) : []
    return {
      records,
      ...(typeof payload.cursor === 'string' ? { cursor: payload.cursor } : {}),
    }
  }

  /** Query-first templates collection; server errors (including cursor mismatch) surface verbatim. */
  async listTemplates(req: {
    readonly q?: string
    readonly tag?: string
    readonly pack?: string
    readonly limit?: number
    readonly cursor?: string
  } = {}): Promise<TemplatePage> {
    const params = new URLSearchParams()
    if (req.q !== undefined && req.q !== '') params.set('q', req.q)
    if (req.tag !== undefined && req.tag !== '') params.set('tag', req.tag)
    if (req.pack !== undefined && req.pack !== '') params.set('pack', req.pack)
    if (req.limit !== undefined) params.set('limit', String(req.limit))
    if (req.cursor !== undefined) params.set('cursor', req.cursor)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    const res = await this.fetchFn(`${this.baseUrl}/api/templates${suffix}`)
    if (!res.ok) throw new Error(`GET /api/templates failed: ${res.status}`)
    const payload = await res.json() as { templates?: unknown; cursor?: unknown }
    return {
      templates: Array.isArray(payload.templates)
        ? payload.templates.map(templateDescriptor).filter((v): v is TemplateDescriptor => v !== undefined)
        : [],
      ...(typeof payload.cursor === 'string' ? { cursor: payload.cursor } : {}),
    }
  }

  /** Fetch and validate one immutable native-format template body. */
  async fetchTemplateBody(packId: string, templateId: string): Promise<WorkflowDocument | undefined> {
    const res = await this.fetchFn(`${this.baseUrl}/api/packs/${encodeURIComponent(packId)}/templates/${encodeURIComponent(templateId)}`)
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`GET template failed: ${res.status}`)
    let loaded
    try {
      loaded = loadDocument(await res.json() as unknown)
    } catch (error) {
      throw new Error(`GET template: malformed response`, { cause: error })
    }
    if (loaded.document === undefined) {
      // loadDocument reports shape failures as diagnostics, not throws: a
      // 200 body that fails to load is a protocol error, never absence.
      const detail = loaded.diagnostics[0]?.message
      throw new Error(`GET template: malformed response${detail !== undefined ? ` (${detail})` : ''}`)
    }
    return loaded.document
  }

  /** Query the grouped-locale docs catalog; an absent cursor means exhausted. */
  async listDocs(req: {
    readonly q?: string
    readonly kind?: 'node' | 'guide'
    readonly pack?: string
    readonly id?: string
    readonly limit?: number
    readonly cursor?: string
  } = {}): Promise<DocsPage> {
    const params = new URLSearchParams()
    if (req.q !== undefined && req.q !== '') params.set('q', req.q)
    if (req.kind !== undefined) params.set('kind', req.kind)
    if (req.pack !== undefined && req.pack !== '') params.set('pack', req.pack)
    if (req.id !== undefined && req.id !== '') params.set('id', req.id)
    if (req.limit !== undefined) params.set('limit', String(req.limit))
    if (req.cursor !== undefined) params.set('cursor', req.cursor)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    const res = await this.fetchFn(`${this.baseUrl}/api/docs${suffix}`)
    if (!res.ok) throw new Error(`GET /api/docs failed: ${res.status}`)
    const payload = await res.json() as { docs?: unknown; cursor?: unknown }
    return {
      docs: Array.isArray(payload.docs)
        ? payload.docs.map(docsDescriptor).filter((descriptor): descriptor is DocsDescriptor => descriptor !== undefined)
        : [],
      ...(typeof payload.cursor === 'string' ? { cursor: payload.cursor } : {}),
    }
  }

  /** Fetch one immutable Markdown page by its pack-scoped digest. */
  async fetchDocsPage(packId: string, digest: string): Promise<string | undefined> {
    const key = `${packId}\u0000${digest}`
    const cached = this.docsPages.get(key)
    if (cached !== undefined) return cached
    const pending = this.fetchFn(
      `${this.baseUrl}/api/packs/${encodeURIComponent(packId)}/docs/pages/${encodeURIComponent(digest)}`,
    ).then(async (res) => {
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`GET docs page failed: ${res.status}`)
      const contentType = res.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/markdown') throw new Error('GET docs page: expected text/markdown')
      return res.text()
    }).catch((error: unknown) => {
      this.docsPages.delete(key)
      throw error
    })
    this.docsPages.set(key, pending)
    while (this.docsPages.size > DOCS_PAGE_CACHE_MAX) {
      const oldest = this.docsPages.keys().next().value
      if (oldest === undefined) break
      this.docsPages.delete(oldest)
    }
    return pending
  }

  /** Fetch one immutable locale catalog by its advertised digest. */
  async fetchPackLocaleCatalog(packId: string, digest: string): Promise<unknown | undefined> {
    const key = `${packId}\u0000${digest}`
    const cached = this.packLocaleCatalogs.get(key)
    if (cached !== undefined) return cached
    const pending = this.fetchFn(
      `${this.baseUrl}/api/packs/${encodeURIComponent(packId)}/locales/${encodeURIComponent(digest)}`,
    ).then(async (res) => {
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`GET pack locale catalog failed: ${res.status}`)
      const contentType = res.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        throw new Error('GET pack locale catalog: expected application/json')
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await res.arrayBuffer())
        return JSON.parse(text) as unknown
      } catch (error) {
        throw new Error('GET pack locale catalog: malformed response', { cause: error })
      }
    }).catch((error: unknown) => {
      this.packLocaleCatalogs.delete(key)
      throw error
    })
    this.packLocaleCatalogs.set(key, pending)
    while (this.packLocaleCatalogs.size > DOCS_PAGE_CACHE_MAX) {
      const oldest = this.packLocaleCatalogs.keys().next().value
      if (oldest === undefined) break
      this.packLocaleCatalogs.delete(oldest)
    }
    return pending
  }

  /** Browser-safe URL for a descriptor-validated immutable docs asset. */
  docsAssetUrl(packId: string, digest: string): string {
    return `${this.baseUrl}/api/packs/${encodeURIComponent(packId)}/docs/assets/${encodeURIComponent(digest)}`
  }

  /** One record by id; undefined on miss/wrong scope (a plain 404 by contract). */
  async getLibraryRecord(id: string, scope: string): Promise<LibraryRecord | undefined> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/library/${encodeURIComponent(id)}?scope=${encodeURIComponent(scope)}`,
    )
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`GET /api/library/${id} failed: ${res.status}`)
    const payload: unknown = await res.json()
    if (!isLibraryRecord(payload)) throw new Error('GET /api/library: malformed response')
    return payload
  }

  /** Create a record over an already-held digest (409 = upload first). */
  async createLibraryRecord(args: {
    readonly scope: string
    readonly name: string
    readonly digest: string
    readonly mediaType: string
    readonly labels?: readonly string[]
    readonly folder?: string
  }): Promise<LibraryRecord> {
    const res = await this.fetchFn(`${this.baseUrl}/api/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`POST /api/library failed: ${res.status}`)
    const payload: unknown = await res.json()
    if (!isLibraryRecord(payload)) throw new Error('POST /api/library: malformed response')
    return payload
  }

  /**
   * Patch a record under optimistic concurrency. `conflict: true` is the
   * 409 outcome (stale revision, or a repointed digest not held) - re-read
   * and retry; every other failure throws.
   */
  async patchLibraryRecord(
    id: string,
    patch: {
      readonly scope: string
      readonly revision: number
      readonly name?: string
      readonly digest?: string
      readonly mediaType?: string
      readonly labels?: readonly string[]
      readonly folder?: string
    },
  ): Promise<{ ok: true; record: LibraryRecord } | { ok: false; conflict: boolean }> {
    const res = await this.fetchFn(`${this.baseUrl}/api/library/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.status === 409) return { ok: false, conflict: true }
    if (!res.ok) throw new Error(`PATCH /api/library/${id} failed: ${res.status}`)
    const payload: unknown = await res.json()
    if (!isLibraryRecord(payload)) throw new Error('PATCH /api/library: malformed response')
    return { ok: true, record: payload }
  }

  // -- Persistent execution history (GET/DELETE /api/history) ---------------

  /**
   * One page of durable terminal runs, newest-finished first. Query-first:
   * filters are the server's exact-match vocabulary (never free text) and
   * the cursor is bound to its query - mismatched reuse is a server-side
   * 400 (surfaces as a throw; restart from page one). Malformed entries
   * are skipped, never surfaced.
   */
  async listHistory(req: {
    readonly scope: string
    readonly clientId?: string
    readonly sourceDocument?: string
    readonly state?: string
    readonly limit?: number
    readonly cursor?: string
  }): Promise<HistoryPage> {
    const params = new URLSearchParams({ scope: req.scope })
    if (req.clientId !== undefined) params.set('clientId', req.clientId)
    if (req.sourceDocument !== undefined) params.set('sourceDocument', req.sourceDocument)
    if (req.state !== undefined) params.set('state', req.state)
    if (req.limit !== undefined) params.set('limit', String(req.limit))
    if (req.cursor !== undefined) params.set('cursor', req.cursor)
    const res = await this.fetchFn(`${this.baseUrl}/api/history?${params.toString()}`)
    if (!res.ok) throw new Error(`GET /api/history failed: ${res.status}`)
    const payload = (await res.json()) as { records?: unknown; cursor?: unknown }
    const records = Array.isArray(payload.records)
      ? payload.records.flatMap((record) => {
          const decoded = decodeHistoryRun(record)
          return decoded === undefined ? [] : [decoded]
        })
      : []
    return {
      records,
      ...(typeof payload.cursor === 'string' ? { cursor: payload.cursor } : {}),
    }
  }

  /** One durable run by id; undefined on miss/wrong scope (plain 404 by contract). */
  async getHistoryRun(runId: string, scope: string): Promise<HistoryRunRecord | undefined> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/history/${encodeURIComponent(runId)}?scope=${encodeURIComponent(scope)}`,
    )
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`GET /api/history/${runId} failed: ${res.status}`)
    const payload: unknown = await res.json()
    const record = decodeHistoryRun(payload)
    if (record === undefined) throw new Error('GET /api/history: malformed response')
    return record
  }

  /**
   * Delete one durable run record. True on 204, false on 404 (already
   * gone/wrong scope - not an error); anything else throws. Never touches
   * asset bytes or library records by contract.
   */
  async deleteHistoryRun(runId: string, scope: string): Promise<boolean> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/history/${encodeURIComponent(runId)}?scope=${encodeURIComponent(scope)}`,
      { method: 'DELETE' },
    )
    if (res.status === 204) return true
    if (res.status === 404) return false
    throw new Error(`DELETE /api/history/${runId} failed: ${res.status}`)
  }

  /**
   * Bulk-clear durable runs matching the exact-filter vocabulary (plus
   * `before`: finished strictly earlier than the epoch instant). No
   * filters clears the ENTIRE scope - callers confirm before invoking.
   * Returns the deleted count.
   */
  async clearHistory(req: {
    readonly scope: string
    readonly clientId?: string
    readonly sourceDocument?: string
    readonly state?: string
    readonly before?: number
  }): Promise<number> {
    const params = new URLSearchParams({ scope: req.scope })
    if (req.clientId !== undefined) params.set('clientId', req.clientId)
    if (req.sourceDocument !== undefined) params.set('sourceDocument', req.sourceDocument)
    if (req.state !== undefined) params.set('state', req.state)
    if (req.before !== undefined) params.set('before', String(req.before))
    const res = await this.fetchFn(`${this.baseUrl}/api/history?${params.toString()}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(`DELETE /api/history failed: ${res.status}`)
    const payload = (await res.json()) as { deleted?: unknown }
    return typeof payload.deleted === 'number' ? payload.deleted : 0
  }

  // -- Value peeks (GET /api/values) -----------------------------------------

  /**
   * Client for retrieving a completed job's output values and renditions
   * (jobId = ExecutionRef.prompt; nodeId is the runtime id from events).
   */
  values(): DinksterValuesClient {
    this.valuesClient ??= new DinksterValuesClient({
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      fetchFn: this.fetchFn,
    })
    return this.valuesClient
  }

  // -- WebSocket -----------------------------------------------------------------

  connect(): void {
    this.socket.connect()
  }

  disconnect(): void {
    this.socket.disconnect()
  }

  /** See ReconnectingSocket.simulateConnectionLoss. */
  simulateConnectionLoss(): void {
    this.socket.simulateConnectionLoss()
  }

  /** Feed one raw WS message through the normalizer (used by tests/replays too). */
  ingest(raw: DinksterRawMessage): void {
    this.emitRaw(raw, true)
  }

  private handleWsData(data: unknown): void {
    if (typeof data === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        this.reportProtocolError('malformed JSON WebSocket frame')
        return
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        if ((parsed as { type: string }).type === 'memory_status') {
          const { type: _type, ...status } = parsed as { type: string } & MemoryStatus
          const decoded = decodeMemoryStatus(status)
          if (decoded === undefined) {
            this.reportProtocolError('malformed memory_status event')
            return
          }
          for (const listener of [...this.memoryListeners]) listener(decoded)
          return
        }
        this.ingest(parsed as DinksterRawMessage)
        return
      }
      this.reportProtocolError('malformed WebSocket envelope')
      return
    }
    // Binary frames are self-describing (length-prefixed header + blob); the
    // normalizer decodes them whole - never pair with a preceding text frame.
    // An undecodable frame is a protocol error, not a silent no-op.
    if (data instanceof ArrayBuffer) {
      if (decodeDinksterBinaryFrame(data) === undefined) {
        this.reportProtocolError('malformed binary WebSocket frame')
        return
      }
      this.ingest(data)
    } else this.reportProtocolError('unsupported WebSocket frame')
  }

  private reportProtocolError(message: string): void {
    if (this.protocolErrors++ < 10) console.warn(`[${this.id}] protocol error: ${message}`)
  }
}

function regionSourceKeys(
  graph: DinksterGraphWire | undefined,
  runtimeId: string,
): { readonly exact?: string; readonly enclosingRegion?: string } {
  if (graph === undefined || !runtimeId.includes('/')) return {}
  const segments = runtimeId.split('/')
  if (segments.some((segment) => segment.length === 0)) return {}
  let scope = graph
  let enclosingRegion: string | undefined
  for (let index = 0; index < segments.length; index += 1) {
    const entry = scope.nodes[segments[index]!]
    if (entry === undefined) return {}
    const exact = segments.slice(0, index + 1).join('.')
    if (index === segments.length - 1) {
      return { exact, ...(enclosingRegion === undefined ? {} : { enclosingRegion }) }
    }
    if (!('region' in entry)) return {}
    enclosingRegion = exact
    scope = entry.region.body
  }
  return {}
}

/** Map a POST /api/jobs rejection body to diagnostics. */
async function rejectionDetails(
  res: Response,
  artifact: CompileArtifact,
): Promise<{ diagnostics: readonly Diagnostic[]; assetsMissing?: AssetsMissingRejection }> {
  let payload: Record<string, unknown> | undefined
  try {
    payload = (await res.json()) as Record<string, unknown>
  } catch {
    payload = undefined
  }
  const assetsMissing = res.status === 409 ? parseAssetsMissingRejection(payload) : undefined
  if (assetsMissing !== undefined) {
    const lines = assetsMissing.assets.map((asset) => {
      const digest = asset.digest.includes(':') ? asset.digest.split(':', 2)[1]! : asset.digest
      const sourceNote = asset.packagedFrom !== undefined && asset.packagedFrom.length > 0
        ? ` - ships with pack ${asset.packagedFrom.join(', ')}`
        : asset.fetchable && asset.sources.length > 0
        ? ` - ${asset.sources.length} known download source${asset.sources.length === 1 ? '' : 's'}`
        : ''
      const details = [digest.slice(0, 12), asset.status, asset.kind].filter(Boolean).join(', ')
      return `${asset.name} (${details})${sourceNote}`
    })
    return { assetsMissing, diagnostics: [diag(
      'error',
      'validation',
      'submit.assetsMissing',
      `job not queued because required assets are unavailable:\n${lines.map((line) => `- ${line}`).join('\n')}`,
      { data: { assets: assetsMissing.assets } },
    )] }
  }
  // Structured diagnostics (validation-shaped errors), anchored via provenance.
  const rawDiags = payload?.['diagnostics']
  if (Array.isArray(rawDiags) && rawDiags.length > 0) {
    return { diagnostics: rawDiags.map((d) => {
      const entry = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>
      const runtimeId = typeof entry['nodeId'] === 'string' ? entry['nodeId'] : undefined
      // Consumer-side input id the diagnostic anchors to (a link is addressed
      // as (nodeId, inputId) - the native wire has no link ids).
      const inputId = typeof entry['inputId'] === 'string' ? entry['inputId'] : undefined
      const sourceKeys = runtimeId === undefined
        ? {}
        : regionSourceKeys(artifact.dinksterGraph, runtimeId)
      const provenanceKey = runtimeId === undefined
        ? undefined
        : artifact.provenance.toSource[runtimeId] !== undefined
          ? runtimeId
          : sourceKeys.exact !== undefined && artifact.provenance.toSource[sourceKeys.exact] !== undefined
            ? sourceKeys.exact
            : sourceKeys.enclosingRegion
      const occKey = provenanceKey === undefined
        ? undefined
        : artifact.provenance.toSource[provenanceKey]
      const occurrence = occKey === undefined ? undefined : parseOccurrenceKey(occKey)
      const port = provenanceKey === undefined || inputId === undefined
        ? undefined
        : artifact.provenance.inputSources?.[provenanceKey]?.[inputId]
      const data = {
        ...(runtimeId !== undefined ? { runtimeId } : {}),
        ...(inputId !== undefined ? { inputId } : {}),
        ...(typeof entry['nodeType'] === 'string' ? { nodeType: entry['nodeType'] } : {}),
        ...(typeof entry['title'] === 'string' ? { title: entry['title'] } : {}),
        ...(typeof entry['capability'] === 'string' ? { capability: entry['capability'] } : {}),
        ...(typeof entry['remedy'] === 'string' ? { remedy: entry['remedy'] } : {}),
      }
      return diag(
        entry['severity'] === 'warning' ? 'warning' : 'error',
        'validation',
        `validation.${typeof entry['code'] === 'string' ? entry['code'] : 'unknown'}`,
        typeof entry['message'] === 'string' ? entry['message'] : 'job rejected',
        {
          ...(occurrence !== undefined ? {
            anchor: {
              occurrence,
              ...(port === undefined ? {} : { port }),
            },
          } : {}),
          ...(Object.keys(data).length > 0 ? { data } : {}),
        },
      )
    }) }
  }
  const message = typeof payload?.['message'] === 'string'
    ? payload['message']
    : typeof payload?.['error'] === 'string'
      ? payload['error']
      : undefined
  const problem = responseDiagnostic(res.status, payload, 'submit')
  return { diagnostics: [
    message === undefined ? problem : { ...problem, message },
  ] }
}

/** Build a SchemaRegistry from a native /api/nodes payload. */
export function buildDinksterRegistry(
  connection: ConnectionId,
  raw: DinksterNodesPayload,
  extensionSnapshotPair?: { readonly digest: string; readonly snapshot: EffectiveExtensionSnapshot },
): SchemaRegistry {
  const parsed = parseDinksterNodes(raw)
  const aliases = comfyAliasCatalogFromDinksterWire(raw, parsed.schemas)
  const groups = comfyGroupCatalogFromDinksterWire(raw, parsed.schemas)
  const schemas = new Map(parsed.schemas)
  for (const record of aliases.catalog.records) {
    const carrier = schemas.get(record.carrier)
    if (carrier === undefined) continue
    schemas.set(record.carrier, {
      ...carrier,
      searchTerms: [...new Set([...(carrier.searchTerms ?? []), record.source.nodeClass])],
    })
  }
  const server = serverInfoFromDinksterWire(raw)
  const graphFeatures = graphFeaturesFromDinksterWire(raw)
  const mergeableTypes = mergeableTypesFromDinksterWire(raw)
  // Legacy-name resolution: schemas declare the historical type names they
  // answer to (bare ComfyUI class_types like 'EmptyImage' for
  // 'comfy.EmptyImage'). Canonical ids always outrank aliases - an alias
  // that collides with a real type id is ignored - and a name two schemas
  // both claim resolves to neither (ambiguity must stay loud in the
  // document, not silently pick a winner) with a warning diagnostic.
  const aliasMap = new Map<string, NodeSchema>()
  const aliasDiags: Diagnostic[] = []
  const ambiguous = new Set<string>()
  for (const schema of schemas.values()) {
    for (const alias of schema.aliases ?? []) {
      if (schemas.has(alias) || ambiguous.has(alias)) continue
      const holder = aliasMap.get(alias)
      if (holder !== undefined && holder !== schema) {
        aliasMap.delete(alias)
        ambiguous.add(alias)
        aliasDiags.push(
          diag('warning', 'schema', 'schema.dinkster.aliasCollision', `legacy name '${alias}' is claimed by both '${holder.type}' and '${schema.type}'; it will not resolve`),
        )
        continue
      }
      aliasMap.set(alias, schema)
    }
  }
  // Additive fields, absent on older backends: epoch is a positive int
  // (surface generation), composing is present-only-when-true.
  const epoch =
    typeof raw.epoch === 'number' && Number.isInteger(raw.epoch) && raw.epoch > 0 ? raw.epoch : undefined
  const resolve: SchemaResolver = Object.assign((type: string) => schemas.get(type) ?? aliasMap.get(type), {
    forEditorRole: (role: string) => schemaForEditorRole(schemas.values(), role),
  })
  return {
    connection,
    hash: fnv1a64(canonicalJson(schemaIdentityWithoutWidgetPresentation(raw) as Json)),
    schemas,
    diagnostics: [...parsed.diagnostics, ...aliasDiags, ...aliases.diagnostics, ...groups.diagnostics],
    resolve,
    packs: packsFromDinksterWire(raw),
    ...(aliases.catalog.records.length > 0 ? { comfyAliases: aliases.catalog } : {}),
    ...(groups.catalog.records.length > 0 ? { comfyGroups: groups.catalog } : {}),
    ...(server !== undefined ? { server } : {}),
    ...(graphFeatures !== undefined ? { graphFeatures } : {}),
    ...(mergeableTypes !== undefined ? { mergeableTypes } : {}),
    ...(extensionSnapshotPair !== undefined ? { extensionSnapshotPair } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
    ...(raw.composing === true ? { composing: true as const } : {}),
  }
}

const REMOTE_POLICY_FIELDS = new Set(['controlAfterRefresh', 'timeoutMs', 'maxRetries', 'refreshMs'])
const COMBO_OPTION_PRESENTATION_FIELDS = new Set(['label', 'info', 'folder'])
const MULTI_COMBO_PRESENTATION_FIELDS = new Set(['placeholder', 'chip'])

/** Widget policy/catalog presentation is never schema cache identity. */
function schemaIdentityWithoutWidgetPresentation(
  value: unknown,
  remote = false,
  comboOption = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => schemaIdentityWithoutWidgetPresentation(entry, false, comboOption))
  }
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const comboWidget = record['type'] === 'COMBO' || record['type'] === 'MULTI_COMBO'
  const multiComboWidget = record['type'] === 'MULTI_COMBO'
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    key === 'hasDocs' ||
    (record['role'] === 'input' && (key === 'acceptsStorage' || key === 'acceptsStream') && entry === false) ||
    (comboOption && COMBO_OPTION_PRESENTATION_FIELDS.has(key)) ||
    (multiComboWidget && MULTI_COMBO_PRESENTATION_FIELDS.has(key)) ||
    (remote && REMOTE_POLICY_FIELDS.has(key))
      ? []
      : [[key, key === 'default' ? entry : schemaIdentityWithoutWidgetPresentation(
          entry,
          key === 'remote',
          comboWidget && key === 'options',
        )]],
  ))
}

/**
 * `crypto.subtle` exists only in secure contexts (HTTPS or localhost), and
 * this app is legitimately served over plain HTTP on LAN/tailnet origins -
 * same deployment reality as uuidv4 above. Fall back to the dependency-free
 * SHA-256 there so schema fetches never die on 'reading digest of undefined'.
 */
async function sha256Digest(bytes: ArrayBuffer): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle
  if (subtle === undefined) return `sha256:${sha256Hex(new Uint8Array(bytes))}`
  const digest = await subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
