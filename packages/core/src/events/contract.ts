/**
 * Execution event normalization contract.
 *
 * Raw server WS messages (execution_start, executing, progress,
 * progress_state, executed, execution_error, execution_cached, ...) are
 * normalized into these events at the connection boundary. Consumers never
 * see raw messages.
 *
 * Contract-level guards:
 * - Every event carries ExecutionRef (connection + prompt). Routing is by
 *   execution identity, never "the active tab".
 * - Node progress is a per-node state map. There is NO "currently executing
 *   node" concept: consumers must tolerate any number of concurrently running
 *   nodes (branch-parallel backends render correctly by construction).
 * - Runtime node ids are preserved raw; display resolution goes through the
 *   artifact's provenance. Unknown ids (backend graph expansion) are kept.
 */

import type { RuntimeErrorDetail } from '../diagnostics.js'
import type { ConnectionId, ExecutionRef } from '../ids.js'
import type { ExecutionArm } from '../schema/model.js'

/** Validated execution-scoped pack JSON, never a raw transport envelope. */
export interface ExtensionEvent {
  readonly kind: 'extensionEvent'
  readonly execution: ExecutionRef
  readonly timestamp: number
  readonly extensionSnapshotDigest: string
  readonly pack: string
  readonly event: string
  readonly schemaVersion: 1
  readonly data: Readonly<Record<string, string | number | boolean>>
  readonly seq: number
  readonly runtimeNodeId?: string
  readonly worker?: string
  readonly executionArm?: ExecutionArm
}

/** Opaque node event not owned by the core execution protocol. */
export interface NodeEvent {
  readonly kind: 'node.event'
  readonly execution: ExecutionRef
  readonly timestamp: number
  readonly name: string
  readonly payload: ArrayBuffer | Readonly<Record<string, unknown>>
  readonly runtimeNodeId?: string
}

/**
 * 'skipped' (Dinkster first-class absence): the node did not run because an
 * absent value reached an on_absent='skip' input. A NORMAL state, never an
 * error - do not emulate ComfyUI ExecutionBlocker cascades: absence carries
 * provenance, so diagnostics point at the one ROOT origin producer
 * (skipOrigin), never at every skipped bystander.
 */
export type NodeRunState = 'pending' | 'running' | 'cached' | 'done' | 'error' | 'skipped'

/**
 * Execution-scoped summary of one produced output value (Dinkster
 * node_finished/node_cached detail.outputs, backend commit ea9ab93). Built
 * from value envelopes, never payloads.
 */
export interface NodeOutputSummary {
  /** Canonical runtime type id, e.g. 'core.int', 'list<core.int>'. */
  readonly typeId: string
  /**
   * Element count, present exactly when the value is a list. Top-level
   * only: for list<list<T>> this is the OUTER length.
   */
  readonly length?: number
  /**
   * Inline small scalar (backend commit a58cdb6): present only for types
   * with a registered inline serializer (core int/float/bool/string; packs
   * can register more). JSON-native scalars only - lists never inline at
   * top level and absence never inlines. Omission means "not inline",
   * NEVER null/absent: absence keeps its own channel (node_skipped).
   */
  readonly value?: string | number | boolean
}

export interface NodeProgress {
  readonly state: NodeRunState
  /** Selected implementation for this attempt, when reported by Dinkster. */
  readonly executionArm?: ExecutionArm
  /** Concrete provider selected for this attempt, when reported by Dinkster. */
  readonly provider?: string
  /** Pack supplying the selected provider, when reported by Dinkster. */
  readonly pack?: string
  /** Execution location selected for this attempt, when reported by Dinkster. */
  readonly worker?: string
  /** 0..1 when determinate. */
  readonly value?: number
  readonly max?: number
  /**
   * For 'skipped': 'node_id/output_id' of the ROOT producer that decided no
   * value exists. Render skip explanations against THAT producer, not this
   * bystander node.
   */
  readonly skipOrigin?: string
  /** For 'skipped': human-readable reason from the engine. */
  readonly skipReason?: string
  /**
   * For terminal 'done'/'cached': per-output value summaries keyed by
   * output id. Powers live type/element-count badges on edges of
   * intermediate nodes mid-run (job results only cover targets).
   */
  readonly outputs?: Readonly<Record<string, NodeOutputSummary>>
}

export interface RegionProgress {
  readonly kind: 'map' | 'fold' | 'while'
  readonly binding: 'zip' | 'cross' | 'broadcast'
  /** Fixed expansion count for map/fold; null for while. */
  readonly iterations: number | null
  /** Actual terminal count from region_finished. */
  readonly finishedIterations?: number
}

/**
 * Execution observability emitted by the backend. These records describe
 * activity that happened during one run; they never imply node state,
 * branch selection, future execution, cache hits, or terminal outcomes.
 */
export type NodeActivity =
  | {
      readonly kind: 'lazy_demand'
      readonly nodeId: string
      readonly round: number
      readonly status: 'waiting' | 'ready'
      readonly requestedInputs: readonly string[]
      readonly newInputs: readonly string[]
      readonly demandedInputs: readonly string[]
      readonly producerNodes: readonly string[]
    }
  | {
      readonly kind: 'cache_miss'
      readonly nodeId: string
      readonly reason: string
      readonly changedInputs?: readonly string[]
      readonly addedInputs?: readonly string[]
      readonly removedInputs?: readonly string[]
    }

export type ValueDiagnostic =
  | ({
      readonly code: 'alpha_dropped'
      readonly nodeId: string
      readonly outputId: string
    } & ({ readonly inputId: string } | { readonly inputIds: readonly string[] }))
  | {
      readonly code: 'mask_polarity_mismatch'
      readonly nodeId: string
      readonly inputId: string
      readonly expected: 'coverage' | 'transparency'
      readonly actual: 'coverage' | 'transparency'
    }

export function isValueDiagnostic(value: unknown): value is ValueDiagnostic {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Readonly<Record<string, unknown>>
  const id = (value: unknown): value is string => typeof value === 'string' && value !== ''
  if (!id(row['nodeId'])) return false
  if (row['code'] === 'alpha_dropped') {
    return id(row['outputId']) && (
      (!('inputIds' in row) && id(row['inputId'])) ||
      (!('inputId' in row) && Array.isArray(row['inputIds']) && row['inputIds'].every(id))
    )
  }
  return row['code'] === 'mask_polarity_mismatch' && id(row['inputId']) &&
    (row['expected'] === 'coverage' || row['expected'] === 'transparency') &&
    (row['actual'] === 'coverage' || row['actual'] === 'transparency')
}

export type NormalizedEvent =
  | ExtensionEvent
  | NodeEvent
  | { readonly kind: 'started'; readonly execution: ExecutionRef; readonly timestamp: number }
  | {
      readonly kind: 'regionExpanded'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly runtimeNodeId: string
      readonly regionKind: RegionProgress['kind']
      readonly binding: RegionProgress['binding']
      readonly iterations: number | null
    }
  | {
      readonly kind: 'regionFinished'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly runtimeNodeId: string
      readonly iterations: number
    }
  | {
      /**
       * Per-node state delta. Multiple nodes may change in one event
       * (progress_state); single-node legacy events normalize to a one-entry map.
       */
      readonly kind: 'nodeStates'
      readonly execution: ExecutionRef
      readonly timestamp: number
      /** runtime node id -> progress. */
      readonly nodes: Readonly<Record<string, NodeProgress>>
      /**
       * Derived from a FETCHED job record (reconnect replay), not the live
       * wire. A snapshot may be older than live events that raced past its
       * fetch: consumers merge it conservatively (fill gaps, upgrade to
       * terminal) instead of overwriting newer live state.
       */
      readonly snapshot?: true
    }
  | {
      /** Preview frame/media chunk on a preview channel. */
      readonly kind: 'preview'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly runtimeNodeId?: string
      readonly channel: string // e.g. 'image/jpeg' live sampling frames
      readonly payload: Blob | ArrayBuffer | Readonly<Record<string, unknown>>
      /** Latent stream a multi-stream family previews (e.g. 'video'). */
      readonly stream?: string
      /**
       * Ring addressing for animated previews: this frame's slot in
       * [0, frameCount). Consumers keep frameCount slots per node and
       * replace slots as frames arrive; a frame without ring addressing
       * replaces the node's single image.
       */
      readonly frameIndex?: number
      readonly frameCount?: number
      /** Display rate of the frame ring, when the family fixes one. */
      readonly fps?: number
    }
  | {
      /** A node finished and emitted UI outputs (images, text, etc.). */
      readonly kind: 'nodeOutput'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly runtimeNodeId: string
      readonly output: Readonly<Record<string, unknown>>
    }
  | {
      /** Bounded non-semantic execution activity for observability only. */
      readonly kind: 'activity'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly activity: NodeActivity
    }
  | {
      /** Nonblocking diagnostics about media value interpretation. */
      readonly kind: 'valueDiagnostics'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly diagnostics: readonly ValueDiagnostic[]
    }
  | {
      /**
       * One structured execution log record (Dinkster node_event/log): explicit
       * report_log calls plus captured node stdout/stderr and python logging.
       * Levels are info|warning ONLY: node execution errors keep their single
       * existing substrate (node_failed / the job error report) and must
       * never arrive as a log level. Droppable on the live socket like
       * progress; a journal replay is the reliable copy.
       */
      readonly kind: 'log'
      readonly execution: ExecutionRef
      readonly timestamp: number
      /** Absent on run-level records not attributed to one node. */
      readonly runtimeNodeId?: string
      readonly level: 'info' | 'warning'
      readonly message: string
      /** Backend emit time, epoch milliseconds (wire ts is float seconds). */
      readonly emittedAt?: number
      /** How the record was captured; absent for explicit report_log calls. */
      readonly origin?: 'stdout' | 'stderr' | 'logging' | 'capture'
      /** Python logger name, when origin is 'logging'. */
      readonly logger?: string
      /** Original python level for captured ERROR/CRITICAL records. */
      readonly pythonLevel?: string
      /**
       * Per-job envelope sequence number. Required: it is the stable
       * cross-window and replay dedupe identity for a log record (local
       * arrival clocks are not comparable between windows or replays).
       */
      readonly seq: number
    }
  | {
      readonly kind: 'error'
      readonly execution: ExecutionRef
      readonly timestamp: number
      readonly runtimeNodeId?: string
      readonly detail: RuntimeErrorDetail
    }
  | { readonly kind: 'interrupted'; readonly execution: ExecutionRef; readonly timestamp: number }
  | { readonly kind: 'completed'; readonly execution: ExecutionRef; readonly timestamp: number }
  | {
      /** Queue/history bookkeeping not tied to one node. */
      readonly kind: 'status'
      /** Backend this status describes: queue depths are per connection. */
      readonly connection: ConnectionId
      readonly execution?: ExecutionRef
      readonly timestamp: number
      readonly queueRemaining?: number
    }
  | {
      /**
       * The backend's /api/nodes surface changed (progressive announcement,
       * dev pack hot reload). Invalidation ping, never a delta: refetch
       * /api/nodes unless the held table's epoch is already >= this one.
       * Ordering is backend contract: emitted only AFTER /api/nodes serves
       * the new surface, so a fetch issued on receipt always observes >= epoch.
       */
      readonly kind: 'schemaChanged'
      readonly connection: ConnectionId
      readonly timestamp: number
      readonly epoch: number
    }
  | {
      /** Pack composition narration; droppable (each update supersedes). */
      readonly kind: 'compositionProgress'
      readonly connection: ConnectionId
      readonly timestamp: number
      readonly done: number
      readonly total: number
      readonly phase?: string
    }
  | {
      /**
       * Every intended pack reached a terminal state (announced or failed).
       * `epoch` is the FINAL schema epoch: a table at >= epoch is complete.
       */
      readonly kind: 'compositionComplete'
      readonly connection: ConnectionId
      readonly timestamp: number
      readonly epoch: number
      /** Pack labels that failed composition; empty when all loaded. */
      readonly failed: readonly string[]
    }
  | {
      /** A pack failed to compose; survivors keep serving (non-droppable). */
      readonly kind: 'packFailed'
      readonly connection: ConnectionId
      readonly timestamp: number
      readonly pack: string
      readonly error: string
    }

/**
 * Connection-level control events: no execution identity by design - they
 * describe the schema surface / pack composition, not a run. Execution
 * consumers (stores, replays) must ignore them.
 */
export type ControlEvent = Extract<
  NormalizedEvent,
  { kind: 'schemaChanged' | 'compositionProgress' | 'compositionComplete' | 'packFailed' }
>

export function isControlEvent(e: NormalizedEvent): e is ControlEvent {
  return (
    e.kind === 'schemaChanged' ||
    e.kind === 'compositionProgress' ||
    e.kind === 'compositionComplete' ||
    e.kind === 'packFailed'
  )
}

/** Events routed by execution identity (everything except status + control). */
export type ExecutionEvent = Extract<NormalizedEvent, { execution: ExecutionRef }>

export function isExecutionEvent(e: NormalizedEvent): e is ExecutionEvent {
  return e.kind !== 'status' && !isControlEvent(e)
}

/**
 * Normalizer interface: one per protocol version. Stateless where possible;
 * may hold per-connection state (e.g. last-executing node for legacy protocol
 * that signals completion via `executing: null`).
 */
export interface EventNormalizer {
  normalize(raw: unknown): readonly NormalizedEvent[]
}

/**
 * Called when a RECOGNIZED event shape is invalid (missing required routing
 * or payload fields, wrong field types): the message was meant for us and
 * cannot be delivered, which is a protocol error, never a silent drop.
 * Unknown event types and legitimately unroutable messages (a straggler
 * carrying only an uncorrelated runId) stay silent by design - forward
 * compatibility must never read as breakage.
 *
 * Called synchronously from normalize(); like event listeners, it is trusted
 * not to throw (a throw would abort delivery of the offending frame only).
 */
export type OnMalformedEvent = (detail: string) => void
