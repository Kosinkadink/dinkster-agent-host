/**
 * Event normalizer for the native Dinkster WS protocol (GET /api/events).
 *
 * Grounded in Dinkster source (commit 230ab1a):
 * - engine events (dinkster_engine/events.py): run_started, node_started,
 *   node_cached, cache_miss, node_finished, node_failed, node_skipped, node_event,
 *   run_finished - wire-shaped by dinkster_server/events.py
 *   engine_event_to_wire as {type, runId, nodeId?, detail?, clientId?,
 *   jobId?}; node_event flattens to {event, data} with any blob shipped as
 *   ONE self-describing binary frame (4-byte BE header length, JSON header,
 *   raw payload - never a JSON/binary frame pair to lose on reconnect)
 * - queue events (dinkster_server/app.py): job_state
 *   {clientId, jobId, state: queued|running|completed|failed|cancelled,
 *   runId, error?}, queue_state {queued, running, paused, ...}
 *
 * Identity: ExecutionRef.prompt = the client-supplied jobId (the stable
 * handle the client owns end-to-end). Events carry jobId whenever the queue
 * can correlate the run; a runId->jobId map covers stragglers, and an event
 * that resolves to NO job is dropped - routing is by execution identity,
 * never "probably the active run".
 *
 * Absence (DESIGN 3.15): node_skipped is a NORMAL state with provenance
 * {input, origin, reason} where origin is the ROOT producer 'node/output'.
 * A fail-policy absence surfaces as job_state failed with error.nodeId (no
 * node_failed event - the engine refuses to invoke, the worker never fails),
 * so the error path here must mark that node too.
 *
 * Region iteration ids ('r[3]/node', nested 'outer[0]/inner[2]/node') are
 * runtime node ids like any other: preserved raw, resolved via provenance.
 */

import { asPromptId, type ConnectionId, type ExecutionRef } from '../ids.js'
import type { RuntimeErrorDetail, RuntimeErrorHint } from '../diagnostics.js'
import { isValueDiagnostic, type EventNormalizer, type NodeActivity, type NodeOutputSummary, type NodeProgress, type NormalizedEvent, type OnMalformedEvent, type ValueDiagnostic } from './contract.js'
import { COMPOSITOR_STATE_PREVIEW_CHANNEL, COMPOSITOR_STATE_PREVIEW_STREAM, compositorStateOf } from '../compositor.js'
import { GLSL_STATE_PREVIEW_CHANNEL, GLSL_STATE_PREVIEW_STREAM, glslShaderStateOf } from '../glsl-shader.js'
import { isPackJsonObject, type EffectiveExtensionSnapshot } from '../extensions/manifest.js'

/** Raw JSON WS message: a flat record keyed by `type`. */
export type DinksterRawJson = Readonly<Record<string, unknown>> & { readonly type: string }

/** Raw messages: parsed JSON envelopes, or whole binary frames as received. */
export type DinksterRawMessage = DinksterRawJson | ArrayBuffer

export const CURVE_HISTOGRAM_PREVIEW_CHANNEL = 'application/vnd.dinkster.curve-histogram+json'

/**
 * Split one self-describing binary frame: 4-byte big-endian JSON-header
 * length, the JSON header (the event minus its blob), then the raw payload.
 */
export function decodeDinksterBinaryFrame(
  frame: ArrayBuffer,
): { readonly header: DinksterRawJson; readonly payload: ArrayBuffer } | undefined {
  if (frame.byteLength < 4) return undefined
  const headerLength = new DataView(frame).getUint32(0, false)
  if (4 + headerLength > frame.byteLength) return undefined
  try {
    const headerText = new TextDecoder().decode(new Uint8Array(frame, 4, headerLength))
    const header = JSON.parse(headerText) as Record<string, unknown>
    if (typeof header['type'] !== 'string') return undefined
    return { header: header as DinksterRawJson, payload: frame.slice(4 + headerLength) }
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const rec = (v: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/**
 * Defensive bound on one log record's message from the wire. The backend
 * already caps captured lines at 2000 chars; this only bounds memory
 * against a misbehaving server, so it stays comfortably above that.
 */
const LOG_MESSAGE_CAP = 4096

/** Activity detail is display-only and deliberately small on untrusted wire input. */
const ACTIVITY_STRING_CAP = 128
const ACTIVITY_LIST_CAP = 16
const ACTIVITY_NODE_ID_CAP = 512
const activityString = (v: unknown): string | undefined => {
  const value = str(v)
  return value === undefined ? undefined : value.slice(0, ACTIVITY_STRING_CAP)
}
const activityNodeId = (v: unknown): string | undefined => {
  const value = str(v)
  return value !== undefined && value.length <= ACTIVITY_NODE_ID_CAP ? value : undefined
}
const activityStrings = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v) || v.some((value) => typeof value !== 'string' || value === '')) return undefined
  return v.slice(0, ACTIVITY_LIST_CAP).map((value) => value.slice(0, ACTIVITY_STRING_CAP))
}

/**
 * Inline scalar: the backend only inlines JSON-native scalars (never lists,
 * objects, or null - omission means "not inline", never absence). Anything
 * else here is a smuggled wire; drop the field, keep the summary.
 */
const scalar = (v: unknown): string | number | boolean | undefined =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
    ? v
    : undefined

/**
 * Parse a Dinkster per-output summary map ({outputId: {typeId, length?,
 * value?}} - node_finished/node_cached detail.outputs, and the same fields
 * inside job result output descriptors). Returns a spreadable {outputs}
 * fragment, or {} when absent/malformed - a bad summary never blocks the
 * state transition.
 */
function outputSummariesOf(v: unknown): { outputs?: Readonly<Record<string, NodeOutputSummary>> } {
  const raw = rec(v)
  if (raw === undefined) return {}
  const out: Record<string, NodeOutputSummary> = {}
  for (const [outputId, entry] of Object.entries(raw)) {
    const e = rec(entry)
    const typeId = str(e?.['typeId'])
    if (typeId === undefined) continue
    const length = num(e?.['length'])
    const value = scalar(e?.['value'])
    out[outputId] = {
      typeId,
      ...(length !== undefined ? { length } : {}),
      ...(value !== undefined ? { value } : {}),
    }
  }
  return Object.keys(out).length > 0 ? { outputs: out } : {}
}

type Clock = () => number

/** Job-scoped event kinds this normalizer understands (engine + queue wire). */
const KNOWN_JOB_EVENTS: ReadonlySet<string> = new Set([
  'run_started',
  'region_expanded',
  'region_finished',
  'node_started',
  'node_cached',
  'cache_miss',
  'node_finished',
  'node_failed',
  'node_skipped',
  'value_diagnostics',
  'node_event',
  'run_finished',
  'job_state',
])

/** job_state values that carry meaning here; queued/running are benign no-ops. */
const JOB_STATE_VALUES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export class DinksterNormalizer implements EventNormalizer {
  /** runId -> jobId, from any event carrying both (covers stragglers). */
  private jobOfRun = new Map<string, string>()

  /**
   * Jobs that already emitted a terminal event. A successful run emits
   * run_finished AND a job_state 'completed'; the second must not produce a
   * second terminal event.
   */
  private terminalJobs = new Set<string>()

  constructor(
    private readonly connection: ConnectionId,
    private readonly clock: Clock = Date.now,
    private readonly onMalformed?: OnMalformedEvent,
    private readonly extensionSnapshot?: (digest: string) => EffectiveExtensionSnapshot | undefined,
  ) {}

  private exec(jobId: string): ExecutionRef {
    return { connection: this.connection, prompt: asPromptId(jobId) }
  }

  /** A known event failed validation: report, deliver nothing. */
  private malformed(detail: string): NormalizedEvent[] {
    this.onMalformed?.(detail)
    return []
  }

  /** Resolve the owning job; record the run correlation as a side effect. */
  private jobIdOf(msg: DinksterRawJson): string | undefined {
    const jobId = str(msg['jobId'])
    const runId = str(msg['runId'])
    if (jobId !== undefined && runId !== undefined) this.jobOfRun.set(runId, jobId)
    return jobId ?? (runId !== undefined ? this.jobOfRun.get(runId) : undefined)
  }

  normalize(raw: DinksterRawMessage): readonly NormalizedEvent[] {
    if (raw instanceof ArrayBuffer) {
      const frame = decodeDinksterBinaryFrame(raw)
      if (!frame) return this.malformed('undecodable binary frame')
      return this.normalizeJson(frame.header, frame.payload)
    }
    return this.normalizeJson(raw, undefined)
  }

  private normalizeJson(msg: DinksterRawJson, blob: ArrayBuffer | undefined): readonly NormalizedEvent[] {
    const timestamp = this.clock()
    const jobId = this.jobIdOf(msg)
    if (msg.type === 'queue_state') {
      return [
        {
          kind: 'status',
          connection: this.connection,
          timestamp,
          ...(num(msg['queued']) !== undefined ? { queueRemaining: num(msg['queued'])! } : {}),
        },
      ]
    }
    // Connection-level composition events (backend 1ee399b/7b529ee/d82a012):
    // no job identity by design - they describe the schema surface, not a run.
    if (msg.type === 'schema_changed') {
      const epoch = num(msg['epoch'])
      // Malformed ping: no epoch, no guessing - but never a silent vanish.
      if (epoch === undefined) return this.malformed('schema_changed without an epoch')
      return [{ kind: 'schemaChanged', connection: this.connection, timestamp, epoch }]
    }
    if (msg.type === 'composition_progress') {
      const done = num(msg['done'])
      const total = num(msg['total'])
      if (done === undefined || total === undefined) {
        return this.malformed('composition_progress without done/total')
      }
      const phase = str(msg['phase'])
      return [
        {
          kind: 'compositionProgress',
          connection: this.connection,
          timestamp,
          done,
          total,
          ...(phase !== undefined ? { phase } : {}),
        },
      ]
    }
    if (msg.type === 'composition_complete') {
      const epoch = num(msg['epoch'])
      if (epoch === undefined) return this.malformed('composition_complete without an epoch')
      const failed = Array.isArray(msg['failed'])
        ? msg['failed'].filter((f): f is string => typeof f === 'string')
        : []
      return [{ kind: 'compositionComplete', connection: this.connection, timestamp, epoch, failed }]
    }
    if (msg.type === 'pack_failed') {
      const pack = str(msg['pack'])
      const error = str(msg['error'])
      if (pack === undefined) return this.malformed('pack_failed without a pack label')
      return [{ kind: 'packFailed', connection: this.connection, timestamp, pack, error: error ?? 'unknown error' }]
    }
    if (jobId === undefined) {
      // Unroutable: no job identity, no guessing. A KNOWN job-scoped event
      // carrying neither jobId nor runId is malformed; one carrying only an
      // uncorrelated runId is a legitimate straggler (e.g. after a reload)
      // and stays silent. Unknown kinds stay silent either way.
      if (
        KNOWN_JOB_EVENTS.has(msg.type) &&
        str(msg['jobId']) === undefined &&
        str(msg['runId']) === undefined
      ) {
        // Pack-defined node_event names are extension traffic and stay
        // silent even without identity; only the recognized core names
        // ('progress'/'preview') and a missing name are held to the
        // identity contract.
        if (msg.type === 'node_event') {
          const name = str(msg['event'])
          if (
            name !== undefined && name !== 'progress' && name !== 'preview' &&
            name !== 'lazy_demand' && name !== 'log' && name !== 'dinkster.curve.histogram' &&
            name !== 'dinkster.compositor.state' && name !== 'dinkster.glsl.state'
          ) return []
        }
        return this.malformed(`${msg.type} without job identity (no jobId or runId)`)
      }
      return []
    }
    const execution = this.exec(jobId)
    const nodeId = str(msg['nodeId'])
    const detail = rec(msg['detail'])
    const executionArm = detail?.['executionArm'] === 'native' || detail?.['executionArm'] === 'comfyui'
      ? detail['executionArm']
      : undefined
    const provider = str(detail?.['provider'])
    const pack = str(detail?.['pack'])
    const worker = str(detail?.['worker'])
    const executionLocation: Pick<NodeProgress, 'executionArm' | 'provider' | 'pack' | 'worker'> = {
      ...(executionArm !== undefined ? { executionArm } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(pack !== undefined ? { pack } : {}),
      ...(worker !== undefined ? { worker } : {}),
    }

    const nodeState = (state: NodeProgress): NormalizedEvent[] =>
      nodeId === undefined
        ? this.malformed(`${msg.type} without a nodeId`)
        : [{ kind: 'nodeStates', execution, timestamp, nodes: { [nodeId]: state } }]

    switch (msg.type) {
      case 'run_started':
        return [{ kind: 'started', execution, timestamp }]
      case 'region_expanded': {
        const regionKind = detail?.['kind']
        const binding = detail?.['binding']
        const rawIterations = detail?.['iterations']
        const iterations = rawIterations === null ? null : num(rawIterations)
        if (
          nodeId === undefined ||
          (regionKind !== 'map' && regionKind !== 'fold' && regionKind !== 'while') ||
          (binding !== 'zip' && binding !== 'cross' && binding !== 'broadcast') ||
          iterations === undefined ||
          ((regionKind === 'while') !== (iterations === null)) ||
          (iterations !== null && (!Number.isInteger(iterations) || iterations < 0))
        ) return this.malformed('region_expanded with malformed detail')
        return [{
          kind: 'regionExpanded',
          execution,
          timestamp,
          runtimeNodeId: nodeId,
          regionKind,
          binding,
          iterations,
        }]
      }
      case 'region_finished': {
        const iterations = num(detail?.['iterations'])
        if (nodeId === undefined || iterations === undefined || !Number.isInteger(iterations) || iterations < 0) {
          return this.malformed('region_finished with malformed detail')
        }
        return [{ kind: 'regionFinished', execution, timestamp, runtimeNodeId: nodeId, iterations }]
      }
      case 'node_started':
        return nodeState({ state: 'running', ...executionLocation })
      case 'node_cached':
        return nodeState({ state: 'cached', ...executionLocation, ...outputSummariesOf(detail?.['outputs']) })
      case 'cache_miss':
        return this.normalizeCacheMiss(execution, timestamp, msg['nodeId'], detail)
      case 'node_finished':
        return nodeState({ state: 'done', ...executionLocation, ...outputSummariesOf(detail?.['outputs']) })
      case 'node_failed':
        return nodeState({ state: 'error', ...executionLocation })
      case 'node_skipped': {
        const origin = str(detail?.['origin'])
        const reason = str(detail?.['reason'])
        return nodeState({
          state: 'skipped',
          ...executionLocation,
          ...(origin !== undefined ? { skipOrigin: origin } : {}),
          ...(reason !== undefined ? { skipReason: reason } : {}),
        })
      }
      case 'value_diagnostics':
        return this.normalizeValueDiagnostics(execution, timestamp, nodeId, detail)
      case 'run_finished': {
        // A job already terminal (failed/cancelled/completed) never gets a
        // SECOND terminal event: a straggling run_finished after job_state
        // 'failed' must not read as a success reversal.
        if (this.terminalJobs.has(jobId)) return []
        this.terminalJobs.add(jobId)
        return [{ kind: 'completed', execution, timestamp }]
      }
      case 'node_event':
        return this.normalizeNodeEvent(msg, execution, timestamp, nodeId, blob)
      case 'job_state':
        return this.normalizeJobState(msg, execution, timestamp, jobId)
      default:
        return [] // unknown kinds are dropped, never crashes
    }
  }

  private normalizeValueDiagnostics(
    execution: ExecutionRef,
    timestamp: number,
    nodeId: string | undefined,
    detail: Readonly<Record<string, unknown>> | undefined,
  ): readonly NormalizedEvent[] {
    if (nodeId === undefined || !Array.isArray(detail?.['diagnostics'])) {
      return this.malformed('value_diagnostics with malformed detail')
    }
    const diagnostics: ValueDiagnostic[] = []
    for (const value of detail['diagnostics']) {
      const row = rec(value)
      if (row === undefined) {
        this.onMalformed?.('value_diagnostics with malformed diagnostic row')
        continue
      }
      const code = row['code']
      if (code !== 'alpha_dropped' && code !== 'mask_polarity_mismatch') continue
      if (str(row['nodeId']) !== nodeId) {
        this.onMalformed?.('value_diagnostics with mismatched diagnostic nodeId')
        continue
      }
      if (!isValueDiagnostic(row)) {
        this.onMalformed?.(`value_diagnostics with malformed ${code} row`)
        continue
      }
      diagnostics.push(row.code === 'alpha_dropped'
        ? {
            code: row.code, nodeId, outputId: row.outputId,
            ...('inputId' in row ? { inputId: row.inputId } : { inputIds: [...row.inputIds] }),
          }
        : { code: row.code, nodeId, inputId: row.inputId, expected: row.expected, actual: row.actual })
    }
    return diagnostics.length > 0
      ? [{ kind: 'valueDiagnostics', execution, timestamp, diagnostics }]
      : []
  }

  private normalizeNodeEvent(
    msg: DinksterRawJson,
    execution: ExecutionRef,
    timestamp: number,
    nodeId: string | undefined,
    blob: ArrayBuffer | undefined,
  ): readonly NormalizedEvent[] {
    const name = str(msg['event'])
    if (name === undefined) return this.malformed('node_event without an event name')
    const data = rec(msg['data']) ?? {}
    if (name === 'progress') {
      if (nodeId === undefined) return this.malformed('node_event progress without a nodeId')
      const step = num(data['step'])
      const total = num(data['total'])
      const executionArm = msg['executionArm'] === 'native' || msg['executionArm'] === 'comfyui'
        ? msg['executionArm']
        : undefined
      const provider = str(msg['provider'])
      const pack = str(msg['pack'])
      const worker = str(msg['worker'])
      const progress: NodeProgress = {
        state: 'running',
        ...(executionArm !== undefined ? { executionArm } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(pack !== undefined ? { pack } : {}),
        ...(worker !== undefined ? { worker } : {}),
        ...(step !== undefined && total !== undefined && total > 0
          ? { value: Math.min(1, Math.max(0, step / total)), max: total }
          : {}),
      }
      return [{ kind: 'nodeStates', execution, timestamp, nodes: { [nodeId]: progress } }]
    }
    if (name === 'preview') {
      const stream = str(data['stream'])
      const frameIndex = num(data['frameIndex'])
      const frameCount = num(data['frameCount'])
      const fps = num(data['fps'])
      // Ring addressing is all-or-nothing: a malformed pair degrades the
      // frame to a plain single-image preview rather than a broken ring.
      const ring =
        frameIndex !== undefined && frameCount !== undefined &&
        Number.isSafeInteger(frameIndex) && Number.isSafeInteger(frameCount) &&
        frameIndex >= 0 && frameIndex < frameCount
          ? {
              frameIndex,
              frameCount,
              ...(fps !== undefined && Number.isFinite(fps) && fps > 0 ? { fps } : {}),
            }
          : {}
      return [
        {
          kind: 'preview',
          execution,
          timestamp,
          ...(nodeId !== undefined ? { runtimeNodeId: nodeId } : {}),
          channel: str(data['mime']) ?? 'application/octet-stream',
          payload: blob ?? data,
          ...(stream !== undefined ? { stream } : {}),
          ...ring,
        },
      ]
    }
    if (name === 'dinkster.curve.histogram') {
      const histogram = data['histogram']
      if (nodeId === undefined || Object.keys(data).length !== 1 || !Array.isArray(histogram) ||
        histogram.length !== 256 || histogram.some((value) =>
          typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
        return this.malformed('node_event dinkster.curve.histogram with malformed data')
      }
      return [{
        kind: 'preview',
        execution,
        timestamp,
        runtimeNodeId: nodeId,
        channel: CURVE_HISTOGRAM_PREVIEW_CHANNEL,
        payload: { histogram: [...histogram] },
        stream: 'curve-histogram',
      }]
    }
    if (name === 'dinkster.compositor.state') {
      const state = compositorStateOf(data)
      if (nodeId === undefined || blob !== undefined || state === undefined) {
        return this.malformed('node_event dinkster.compositor.state with malformed data')
      }
      return [{
        kind: 'preview',
        execution,
        timestamp,
        runtimeNodeId: nodeId,
        channel: COMPOSITOR_STATE_PREVIEW_CHANNEL,
        payload: state as unknown as Readonly<Record<string, unknown>>,
        stream: COMPOSITOR_STATE_PREVIEW_STREAM,
      }]
    }
    if (name === 'dinkster.glsl.state') {
      const state = glslShaderStateOf(data)
      if (nodeId === undefined || blob !== undefined || state === undefined) {
        return this.malformed('node_event dinkster.glsl.state with malformed data')
      }
      return [{
        kind: 'preview',
        execution,
        timestamp,
        runtimeNodeId: nodeId,
        channel: GLSL_STATE_PREVIEW_CHANNEL,
        payload: state as unknown as Readonly<Record<string, unknown>>,
        stream: GLSL_STATE_PREVIEW_STREAM,
      }]
    }
    if (name === 'lazy_demand') {
      return this.normalizeLazyDemand(execution, timestamp, msg['nodeId'], data)
    }
    if (name === 'log') {
      return this.normalizeLog(msg, execution, timestamp, nodeId, data)
    }
    const digest = str(msg['extensionSnapshotDigest'])
    const pack = str(msg['pack'])
    if (digest === undefined && msg['schemaVersion'] === undefined) {
      return [{
        kind: 'node.event',
        execution,
        timestamp,
        name,
        payload: blob ?? data,
        ...(nodeId === undefined ? {} : { runtimeNodeId: nodeId }),
      }]
    }
    const declaration = digest === undefined ? undefined : this.extensionSnapshot?.(digest)?.extensions
      .find((extension) => extension.id === pack)?.events?.find((event) => event.name === name)
    const seq = num(msg['seq'])
    if (!declaration || !digest || !pack || blob !== undefined || msg['schemaVersion'] !== 1 ||
      seq === undefined || !Number.isSafeInteger(seq) || seq < 0 || !isPackJsonObject(msg['data'], declaration.payload)) {
      return this.malformed('node_event has invalid or unauthorized custom JSON data')
    }
    const worker = str(msg['worker'])
    const arm = msg['executionArm']
    return [Object.freeze({
      kind: 'extensionEvent', execution: Object.freeze({ ...execution }), timestamp,
      extensionSnapshotDigest: digest, pack, event: name, schemaVersion: 1, seq,
      data: Object.freeze({ ...data }) as Readonly<Record<string, string | number | boolean>>,
      ...(nodeId === undefined ? {} : { runtimeNodeId: nodeId }),
      ...(worker === undefined ? {} : { worker }),
      ...(arm === 'native' || arm === 'comfyui' ? { executionArm: arm } : {}),
    })]
  }

  private normalizeLog(
    msg: DinksterRawJson,
    execution: ExecutionRef,
    timestamp: number,
    nodeId: string | undefined,
    data: Readonly<Record<string, unknown>>,
  ): readonly NormalizedEvent[] {
    // level info|warning only: errors keep the single node_failed / job
    // error substrate and must never smuggle in as a log level.
    const level = data['level']
    const message = typeof data['message'] === 'string' ? data['message'] : undefined
    // seq is the record's dedupe identity across windows and replays, so a
    // log without a usable one is malformed rather than best-effort.
    const seq = num(msg['seq'])
    if (
      (level !== 'info' && level !== 'warning') || message === undefined ||
      seq === undefined || !Number.isSafeInteger(seq) || seq < 0
    ) {
      return this.malformed('node_event log with malformed data')
    }
    const ts = num(data['ts'])
    const rawOrigin = data['origin']
    const origin = rawOrigin === 'stdout' || rawOrigin === 'stderr' || rawOrigin === 'logging' || rawOrigin === 'capture'
      ? rawOrigin
      : undefined
    const logger = activityString(data['logger'])
    const pythonLevel = activityString(data['pythonLevel'])
    return [{
      kind: 'log',
      execution,
      timestamp,
      level,
      message: message.slice(0, LOG_MESSAGE_CAP),
      seq,
      ...(nodeId !== undefined ? { runtimeNodeId: nodeId } : {}),
      ...(ts !== undefined ? { emittedAt: ts * 1000 } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(logger !== undefined ? { logger } : {}),
      ...(pythonLevel !== undefined ? { pythonLevel } : {}),
    }]
  }

  private normalizeLazyDemand(
    execution: ExecutionRef,
    timestamp: number,
    rawNodeId: unknown,
    data: Readonly<Record<string, unknown>>,
  ): readonly NormalizedEvent[] {
    const nodeId = activityNodeId(rawNodeId)
    const round = num(data['round'])
    const status = data['status']
    const requestedInputs = activityStrings(data['requestedInputs'])
    const newInputs = activityStrings(data['newInputs'])
    const demandedInputs = activityStrings(data['demandedInputs'])
    const producerNodes = activityStrings(data['producerNodes'])
    if (
      nodeId === undefined || round === undefined || !Number.isInteger(round) || round < 1 ||
      (status !== 'waiting' && status !== 'ready') || requestedInputs === undefined ||
      newInputs === undefined || demandedInputs === undefined || producerNodes === undefined
    ) return this.malformed('node_event lazy_demand with malformed data')
    const activity: NodeActivity = {
      kind: 'lazy_demand',
      nodeId,
      round,
      status,
      requestedInputs,
      newInputs,
      demandedInputs,
      producerNodes,
    }
    return [{ kind: 'activity', execution, timestamp, activity }]
  }

  private normalizeCacheMiss(
    execution: ExecutionRef,
    timestamp: number,
    rawNodeId: unknown,
    detail: Readonly<Record<string, unknown>> | undefined,
  ): readonly NormalizedEvent[] {
    const nodeId = activityNodeId(rawNodeId)
    const cacheKey = str(detail?.['cache_key'])
    const reason = activityString(detail?.['reason'])
    const changedInputs = detail?.['changed_inputs'] === undefined
      ? undefined
      : activityStrings(detail['changed_inputs'])
    const addedInputs = detail?.['added_inputs'] === undefined
      ? undefined
      : activityStrings(detail['added_inputs'])
    const removedInputs = detail?.['removed_inputs'] === undefined
      ? undefined
      : activityStrings(detail['removed_inputs'])
    if (
      nodeId === undefined || cacheKey === undefined || reason === undefined ||
      (detail?.['changed_inputs'] !== undefined && changedInputs === undefined) ||
      (detail?.['added_inputs'] !== undefined && addedInputs === undefined) ||
      (detail?.['removed_inputs'] !== undefined && removedInputs === undefined)
    ) return this.malformed('cache_miss with malformed detail')
    const activity: NodeActivity = {
      kind: 'cache_miss',
      nodeId,
      reason,
      ...(changedInputs !== undefined ? { changedInputs } : {}),
      ...(addedInputs !== undefined ? { addedInputs } : {}),
      ...(removedInputs !== undefined ? { removedInputs } : {}),
    }
    return [{ kind: 'activity', execution, timestamp, activity }]
  }

  private normalizeJobState(
    msg: DinksterRawJson,
    execution: ExecutionRef,
    timestamp: number,
    jobId: string,
  ): readonly NormalizedEvent[] {
    switch (msg['state']) {
      case 'completed': {
        if (this.terminalJobs.has(jobId)) return []
        this.terminalJobs.add(jobId)
        return [{ kind: 'completed', execution, timestamp }]
      }
      case 'cancelled': {
        if (this.terminalJobs.has(jobId)) return []
        this.terminalJobs.add(jobId)
        return [{ kind: 'interrupted', execution, timestamp }]
      }
      case 'failed': {
        if (this.terminalJobs.has(jobId)) return []
        this.terminalJobs.add(jobId)
        const error = rec(msg['error'])
        const detail = errorDetail(error)
        const failedNode = str(error?.['nodeId'])
        const events: NormalizedEvent[] = []
        if (failedNode !== undefined) {
          // Fail-policy absences and validation errors carry the node on the
          // JOB error, with no node_failed event - mark the node here.
          events.push({ kind: 'nodeStates', execution, timestamp, nodes: { [failedNode]: { state: 'error' } } })
        }
        events.push({
          kind: 'error',
          execution,
          timestamp,
          ...(failedNode !== undefined ? { runtimeNodeId: failedNode } : {}),
          detail,
        })
        return events
      }
      default:
        // queued/running transitions carry no node/terminal meaning; any
        // OTHER value is outside the state vocabulary and must not vanish
        // (a mistyped terminal state would strand the run as running).
        return typeof msg['state'] === 'string' && JOB_STATE_VALUES.has(msg['state'])
          ? []
          : this.malformed(`job_state with unknown state '${String(msg['state']).slice(0, 80)}'`)
    }
  }
}

/** Map a job error wire record into the runtime error detail contract. */
function errorDetail(error: Readonly<Record<string, unknown>> | undefined): RuntimeErrorDetail {
  if (error === undefined) return { exceptionType: 'unknown', exceptionMessage: 'job failed', traceback: [] }
  const kind = str(error['kind']) ?? 'unknown'
  const hints = errorHints(error['hints'])
  if (kind === 'validation') {
    const diagnostics = Array.isArray(error['diagnostics']) ? (error['diagnostics'] as unknown[]) : []
    const messages = diagnostics
      .map((d) => str(rec(d)?.['message']))
      .filter((m): m is string => m !== undefined)
    return {
      exceptionType: 'validation',
      exceptionMessage: messages.length > 0 ? messages.join('\n') : 'graph validation failed',
      traceback: [],
      ...(hints.length > 0 ? { hints } : {}),
    }
  }
  const traceback = str(error['traceback'])
  return {
    exceptionType: kind,
    exceptionMessage: str(error['message']) ?? 'job failed',
    traceback: traceback !== undefined ? traceback.split('\n') : [],
    ...(hints.length > 0 ? { hints } : {}),
  }
}

/** Decode additive error hints independently so malformed entries never reject a failure. */
function errorHints(value: unknown): readonly RuntimeErrorHint[] {
  if (!Array.isArray(value)) return []
  const hints: RuntimeErrorHint[] = []
  for (const valueHint of value) {
    const hint = rec(valueHint)
    if (hint === undefined) continue
    const code = hint['code']
    const message = hint['message']
    if (typeof code !== 'string' || typeof message !== 'string') continue
    const suggestion = hint['suggestion']
    hints.push({
      code,
      message,
      ...(typeof suggestion === 'string' ? { suggestion } : {}),
    })
  }
  return hints
}

// ---------------------------------------------------------------------------
// Completed-job hydration (GET /api/jobs/{clientId}/{jobId})
// ---------------------------------------------------------------------------

/** The slice of Dinkster's job_to_wire shape that hydration reads. */
export interface DinksterJobWire {
  readonly state?: unknown
  readonly nodeStates?: unknown
  readonly executed?: unknown
  readonly cached?: unknown
  readonly skipped?: unknown
  readonly error?: unknown
  /** Target-node output descriptors: {nodeId: {outputId: {typeId, fingerprint, meta, length?}}}. */
  readonly outputs?: unknown
  /** Run identity for the journal endpoint; jobRef and runId carry the same value. */
  readonly jobRef?: unknown
  readonly runId?: unknown
  /** Library scope the run executed under ('local' for the single-user default). */
  readonly scope?: unknown
  /** Content digest of the workflow document uploaded at submission. */
  readonly sourceDocument?: unknown
}

const JOB_NODE_STATES: Readonly<Record<string, NodeProgress['state']>> = {
  running: 'running',
  cached: 'cached',
  completed: 'done',
  failed: 'error',
  skipped: 'skipped',
}

/**
 * Reconstruct the per-node state map from a fetched job record - the
 * reconnect/hydration path (a frozen view must survive a page reload).
 * Prefers the live nodeStates map; falls back to the completed-result
 * executed/cached/skipped arrays. Skip PROVENANCE (origin/reason) is only on
 * the live event stream today - hydrated skips carry the state alone.
 */
export function nodeStatesFromDinksterJob(job: DinksterJobWire): Record<string, NodeProgress> {
  const out: Record<string, NodeProgress> = {}
  const states = rec(job.nodeStates)
  if (states !== undefined && Object.keys(states).length > 0) {
    for (const [nodeId, state] of Object.entries(states)) {
      const mapped = typeof state === 'string' ? JOB_NODE_STATES[state] : undefined
      if (mapped !== undefined) out[nodeId] = { state: mapped }
    }
  } else {
    const mark = (ids: unknown, state: NodeProgress['state']): void => {
      if (!Array.isArray(ids)) return
      for (const id of ids) if (typeof id === 'string') out[id] = { state }
    }
    mark(job.executed, 'done')
    mark(job.cached, 'cached')
    mark(job.skipped, 'skipped')
  }
  // A failed job's culprit node may never have reached a terminal node
  // state (fail-policy refusal happens before invocation).
  const failedNode = str(rec(job.error)?.['nodeId'])
  if (failedNode !== undefined && job.state === 'failed') out[failedNode] = { state: 'error' }
  // Enrich terminal states with output summaries from result descriptors
  // (targets only - descriptors carry the same typeId/length fields the live
  // node_finished/node_cached details do). Never invents a state: summaries
  // attach only to nodes the record already marked terminal.
  const descriptors = rec(job.outputs)
  if (descriptors !== undefined) {
    for (const [nodeId, perOutput] of Object.entries(descriptors)) {
      const existing = out[nodeId]
      if (existing === undefined || (existing.state !== 'done' && existing.state !== 'cached')) {
        continue
      }
      const summary = outputSummariesOf(perOutput)
      if (summary.outputs !== undefined) out[nodeId] = { ...existing, ...summary }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Runtime node-id path grammar (Dinkster DESIGN 3.13, backend commit 95106fd).
//
// The backend bans '/', '[' and ']' in document node ids at every nesting
// level, which closes the grammar for expanded runtime ids and diagnostic
// paths:
//
//   path    = segment ("/" segment)*
//   segment = nodeId | nodeId "[" decimal-index "]"
//
// No whitespace anywhere; decimal-index is a plain base-10 integer (no sign,
// no leading '+'). Each parsed nodeId maps mechanically to exactly one
// submitted document node id. Note these are BACKEND-expanded, execution-
// scoped identities (region iterations); they are distinct from the stable
// document occurrence keys in ids.ts, whose segments never contain '/[]'.
// ---------------------------------------------------------------------------

/** One segment of a backend runtime node-id path. */
export interface RuntimePathSegment {
  /** The document node id (region body node id at that level). */
  readonly nodeId: string
  /** Iteration index, present only on region-iteration segments like `r[3]`. */
  readonly iteration?: number
}

const SEGMENT_RE = /^([^/[\]]+)(?:\[(0|[1-9][0-9]*)\])?$/

/**
 * Parse a backend runtime node id or diagnostic path (`node`, `r/add`,
 * `outer[0]/inner[2]/node`) into its segments. Returns undefined for
 * anything outside the closed grammar (empty path, empty segment, malformed
 * or signed index, trailing junk, '['/']' in the id portion) - callers must
 * then preserve the raw id rather than guess.
 */
export function parseDinksterRuntimePath(path: string): readonly RuntimePathSegment[] | undefined {
  if (path.length === 0) return undefined
  const out: RuntimePathSegment[] = []
  for (const raw of path.split('/')) {
    const m = SEGMENT_RE.exec(raw)
    if (m === null) return undefined
    const seg: RuntimePathSegment =
      m[2] === undefined ? { nodeId: m[1]! } : { nodeId: m[1]!, iteration: Number(m[2]) }
    out.push(seg)
  }
  return out
}

/**
 * The submitted (top-level) document node id a runtime path anchors to: the
 * first segment's nodeId. For plain ids this is the id itself; for region
 * iterations ('r[3]/add') it is the region node's id. Undefined when the
 * path does not parse.
 */
export function dinksterRuntimePathRoot(path: string): string | undefined {
  return parseDinksterRuntimePath(path)?.[0]?.nodeId
}
