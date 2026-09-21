/**
 * ExecutionStore: the single owner of execution state, keyed by
 * (connectionId, promptId). Consumers (canvas, queue rail, outputs panel)
 * subscribe to signals; routing is by execution identity, never "the active
 * tab". Multiple concurrent executions are first-class by construction.
 *
 * States are immutable snapshots: every apply() publishes a fresh map, so
 * subscribers can compare by reference. Fine at current scale; if profiling shows
 * churn on huge runs, per-execution signals slot in behind the same API.
 */

import {
  createSignal,
  diag,
  executionKey,
  isControlEvent,
  parseOccurrenceKey,
  type CompileArtifact,
  type ConnectionId,
  type Diagnostic,
  type ExecutionEvent,
  type ExecutionRef,
  type NodeActivity,
  type NodeProgress,
  type NormalizedEvent,
  type RegionProgress,
  type ReadonlySignal,
  type Signal,
  type ValueDiagnostic,
} from '@dinkster/core'

export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'error' | 'interrupted'

export interface ExecutionSubmitter {
  readonly principalId: string
  readonly kind: 'human' | 'agent'
}

export interface PreviewData {
  readonly channel: string
  readonly payload: Blob | ArrayBuffer | Readonly<Record<string, unknown>>
  readonly runtimeNodeId?: string
  readonly timestamp: number
  /** Latent stream a multi-stream family previews (e.g. 'video'). */
  readonly stream?: string
  /** Ring slot of an animated preview frame, in [0, frameCount). */
  readonly frameIndex?: number
  readonly frameCount?: number
  /** Display rate of the frame ring, when the family fixes one. */
  readonly fps?: number
}

/**
 * Fixed ring of animated preview frames for one runtime node: frameCount
 * slots, replaced in place as ring-addressed frames arrive. A frame ring
 * with a different frameCount (a new sampling region) starts fresh.
 */
export interface PreviewRing {
  readonly frameCount: number
  readonly fps?: number
  /** Ring slot -> latest frame delivered for that slot. */
  readonly frames: Readonly<Record<number, PreviewData>>
}

/**
 * One execution log record retained for display. Levels are info|warning
 * only: node execution errors keep their single existing substrate (the
 * job error report in ExecutionState.errors), and log views derive error
 * rows from those diagnostics rather than a parallel error channel.
 */
export interface ExecutionLogEntry {
  readonly level: 'info' | 'warning'
  readonly message: string
  /** Backend emit time when stamped, else client arrival time (epoch ms). */
  readonly timestamp: number
  /** Absent on run-level records not attributed to one node. */
  readonly runtimeNodeId?: string
  readonly origin?: 'stdout' | 'stderr' | 'logging' | 'capture'
  readonly logger?: string
  readonly pythonLevel?: string
  /** Per-job envelope sequence number; strictly increasing within a run. */
  readonly seq: number
}

/** Content-addressed file retained by a completed execution. */
export interface ExecutionArtifact {
  readonly nodeId: string
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

export interface ExecutionState {
  readonly ref: ExecutionRef
  readonly key: string
  /** Present when this client compiled + submitted it; foreign runs have none. */
  readonly artifact?: CompileArtifact
  readonly status: ExecutionStatus
  /** runtime node id -> latest progress. */
  readonly nodes: Readonly<Record<string, NodeProgress>>
  /** runtime region id -> lifecycle progress. */
  readonly regions: Readonly<Record<string, RegionProgress>>
  /** runtime node id -> accumulated UI outputs (images, text, ...). */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** Host-validated files retained by output nodes, in backend order. */
  readonly artifacts: readonly ExecutionArtifact[]
  /** A completed job supplied a valid artifacts field, including an empty list. */
  readonly artifactsHydrated: boolean
  /** runtime node id -> stream key -> latest attributed preview frame
   * (metadata protocol). Frames without a stream use the '' key, so a
   * multi-stream family (H3 video + audio) retains one frame per stream. */
  readonly previews: Readonly<Record<string, Readonly<Record<string, PreviewData>>>>
  /** runtime node id -> stream key -> animated preview frame ring. */
  readonly previewRings?: Readonly<Record<string, Readonly<Record<string, PreviewRing>>>>
  /** Non-semantic backend activity, bounded FIFO within this execution only. */
  readonly activities: readonly NodeActivity[]
  /** Bounded, deduplicated media value diagnostics for this execution. */
  readonly valueDiagnostics?: readonly ValueDiagnostic[]
  /** Execution log records, bounded FIFO within this execution only. */
  readonly logs: readonly ExecutionLogEntry[]
  /** Records discarded from the front of `logs` by the buffer cap. */
  readonly logsDropped: number
  /** Latest frame WITHOUT node attribution (legacy binary protocol). */
  readonly lastPreview?: PreviewData
  readonly errors: readonly Diagnostic[]
  readonly submittedBy?: ExecutionSubmitter
  /** Server-global native run identity used to prove a persisted result. */
  readonly jobRef?: string
  /** Content digest of the exact workflow document submitted for this run. */
  readonly sourceDocument?: string
  readonly queuedAt: number
  readonly startedAt?: number
  readonly endedAt?: number
}

/** Retract the provisional "results unknown" warning once disproven. */
const withoutLostDiagnostics = (errors: readonly Diagnostic[]): readonly Diagnostic[] =>
  errors.filter((d) => d.code !== 'execution.lost')

const TERMINAL_NODE_STATES: ReadonlySet<NodeProgress['state']> = new Set([
  'done',
  'error',
  'cached',
  'skipped',
])

const preserveExecutionDetails = (
  progress: NodeProgress,
  previous: NodeProgress | undefined,
): NodeProgress =>
  previous === undefined ||
  (progress.executionArm !== undefined && progress.provider !== undefined &&
    progress.pack !== undefined && progress.worker !== undefined)
    ? progress
    : {
        ...progress,
        ...(progress.executionArm === undefined && previous.executionArm !== undefined
          ? { executionArm: previous.executionArm }
          : {}),
        ...(progress.worker === undefined && previous.worker !== undefined
          ? { worker: previous.worker }
          : {}),
        ...(progress.provider === undefined && previous.provider !== undefined
          ? { provider: previous.provider }
          : {}),
        ...(progress.pack === undefined && previous.pack !== undefined
          ? { pack: previous.pack }
          : {}),
      }

/** Per-execution observability bound: discard oldest entries first. */
const ACTIVITY_LOG_CAP = 200

/** Per-execution media diagnostic bound: discard oldest unique entries first. */
const VALUE_DIAGNOSTIC_CAP = 200

const valueDiagnosticKey = (diagnostic: ValueDiagnostic): string =>
  diagnostic.code === 'alpha_dropped'
    ? JSON.stringify([
        diagnostic.code, diagnostic.nodeId, diagnostic.outputId,
        'inputId' in diagnostic ? diagnostic.inputId : diagnostic.inputIds,
      ])
    : JSON.stringify([
        diagnostic.code,
        diagnostic.nodeId,
        diagnostic.inputId,
        diagnostic.expected,
        diagnostic.actual,
      ])

/** Per-execution log buffer bound: discard oldest entries first, count them. */
const EXECUTION_LOG_CAP = 2000

/**
 * Per-connection bound on evictable execution entries. Eviction runs
 * oldest-first when a new execution appears, when a run reaches an
 * authoritative terminal state, and when the last retain() pin drops.
 * Queued, running, provisionally lost, and pinned executions are never
 * evicted - unless unconfirmed (created by mid-run chatter, no observed run
 * start) - so the map exceeds the cap only by the count of such protected
 * entries.
 */
const EXECUTION_ENTRY_CAP = 200

/**
 * Per-connection byte budget for preview frame payloads retained by
 * TERMINAL and unconfirmed executions. Confirmed in-flight runs are never
 * stripped, and the newest budgeted execution keeps its frames even when it
 * alone exceeds the budget, so worst-case retained bytes are budget + one
 * run. Stripped
 * executions keep everything else (nodes, digests, outputs, artifacts):
 * consumers that carried frames forward fall back to digest outputs.
 */
const TERMINAL_PREVIEW_BYTE_BUDGET = 64 * 1024 * 1024

const previewPayloadBytes = (frame: PreviewData): number =>
  frame.payload instanceof Blob
    ? frame.payload.size
    : frame.payload instanceof ArrayBuffer
      ? frame.payload.byteLength
      : 0

const previewBytesOf = (state: ExecutionState): number => {
  // A ring slot and its stream's retained still can share one frame object,
  // so payloads are counted once by identity.
  const counted = new Set<PreviewData['payload']>()
  let total = 0
  const count = (frame: PreviewData): void => {
    if (counted.has(frame.payload)) return
    counted.add(frame.payload)
    total += previewPayloadBytes(frame)
  }
  if (state.lastPreview !== undefined) count(state.lastPreview)
  for (const streams of Object.values(state.previews)) {
    for (const frame of Object.values(streams)) count(frame)
  }
  for (const streams of Object.values(state.previewRings ?? {})) {
    for (const ring of Object.values(streams)) {
      for (const frame of Object.values(ring.frames)) count(frame)
    }
  }
  return total
}

const isTerminalStatus = (status: ExecutionStatus): boolean =>
  status === 'completed' || status === 'error' || status === 'interrupted'

const stripPreviewFrames = (state: ExecutionState): ExecutionState => {
  const { lastPreview: _lastPreview, previewRings: _previewRings, ...rest } = state
  return { ...rest, previews: {} }
}

/**
 * Binary search a seq-sorted log buffer: the insertion index for `seq`, or
 * -1 when a record with that seq is already retained. Live records arrive in
 * ascending seq order, so the common case resolves on the tail comparison.
 */
const logInsertionIndex = (logs: readonly ExecutionLogEntry[], seq: number): number => {
  if (logs.length === 0 || seq > logs[logs.length - 1]!.seq) return logs.length
  let low = 0
  let high = logs.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const at = logs[mid]!.seq
    if (at === seq) return -1
    if (at < seq) low = mid + 1
    else high = mid - 1
  }
  return low
}

/**
 * Merge a SNAPSHOT node map (fetched job record) into live state. A snapshot
 * may predate live events that raced past its fetch, so it never regresses
 * or impoverishes a known state:
 *  - unknown node               -> take the snapshot state (gap fill)
 *  - live non-terminal, snapshot terminal -> take it (the gap the
 *    incremental wire dropped; never re-announced by live events)
 *  - both terminal, SAME state  -> keep every live field, letting the
 *    snapshot fill only what the live event lacked (a bare snapshot 'done'
 *    must not strip live output summaries or skip provenance; a descriptor-
 *    enriched snapshot may add summaries a bare live event never carried)
 *  - anything else              -> keep the live state (a stale 'running'
 *    never regresses a live terminal; a genuinely rerunning node
 *    self-corrects on its next live event)
 */
const mergeSnapshotNodes = (
  current: Readonly<Record<string, NodeProgress>>,
  incoming: Readonly<Record<string, NodeProgress>>,
): Record<string, NodeProgress> => {
  const out: Record<string, NodeProgress> = { ...current }
  for (const [nodeId, progress] of Object.entries(incoming)) {
    const live = out[nodeId]
    if (live === undefined) {
      out[nodeId] = progress
      continue
    }
    const liveTerminal = TERMINAL_NODE_STATES.has(live.state)
    const snapshotTerminal = TERMINAL_NODE_STATES.has(progress.state)
    if (!liveTerminal && snapshotTerminal) {
      out[nodeId] = preserveExecutionDetails(progress, live)
      continue
    }
    if (liveTerminal && snapshotTerminal && live.state === progress.state) {
      out[nodeId] = {
        ...progress,
        ...live,
        ...(progress.outputs !== undefined || live.outputs !== undefined
          ? { outputs: { ...progress.outputs, ...live.outputs } }
          : {}),
      }
    }
  }
  return out
}

/**
 * Terminal executions keep their stills but release animated frame rings:
 * the encoded ring payloads are only useful while the node still samples.
 */
const dropPreviewRings = ({ previewRings: _rings, ...rest }: ExecutionState): ExecutionState => rest

export class ExecutionStore {
  private readonly map = new Map<string, ExecutionState>()
  private readonly provisionallyLost = new Set<string>()
  /** retain() pin counts by execution key; pinned entries are never evicted. */
  private readonly retained = new Map<string, number>()
  /**
   * Keys of recently evicted executions. Late chatter for them (straggler
   * previews, logs, outputs) is discarded rather than resurrecting the run
   * as a protected queued entry that dodges the entry cap and preview
   * budget. Only a genuine new run reusing the key clears its tombstone.
   * FIFO-bounded: chatter for keys that age out is admitted again, but only
   * as an unconfirmed entry (below), so the caps still hold.
   */
  private readonly recentlyEvicted = new Set<string>()
  /**
   * Keys whose entry was created by a non-started event: a mid-run join of a
   * run another window submitted, or late chatter for a run evicted so long
   * ago its tombstone aged out. The two are indistinguishable - event
   * timestamps are client arrival times, never run ages - so these entries
   * stay evictable under the entry cap and their frames count toward the
   * preview byte budget until a run start or a local submission vouches for
   * the run. Cleared on eviction, so the set never outgrows the map.
   */
  private readonly unconfirmed = new Set<string>()
  private readonly executionsSignal: Signal<ReadonlyMap<string, ExecutionState>> = createSignal<
    ReadonlyMap<string, ExecutionState>
  >(new Map())
  private readonly queueRemainingSignal = createSignal<ReadonlyMap<ConnectionId, number>>(new Map())

  /** All known executions, newest state; keyed by executionKey(). */
  readonly executions: ReadonlySignal<ReadonlyMap<string, ExecutionState>> = this.executionsSignal
  /** Server queue depth PER CONNECTION: two backends never fight over one number. */
  readonly queueRemaining: ReadonlySignal<ReadonlyMap<ConnectionId, number>> = this.queueRemainingSignal

  get(ref: ExecutionRef): ExecutionState | undefined {
    return this.map.get(executionKey(ref))
  }

  /**
   * Record a locally submitted execution with its artifact. WS events for
   * this execution may have arrived BEFORE the /prompt response resolved
   * (fast/cached runs), so merge into any existing state - never clobber it.
   */
  register(
    ref: ExecutionRef,
    artifact: CompileArtifact,
    now: number = Date.now(),
    identity?: { readonly jobRef?: string; readonly sourceDocument?: string },
  ): void {
    const key = executionKey(ref)
    // A fresh local submission is a new, confirmed run - never late chatter.
    this.recentlyEvicted.delete(key)
    this.unconfirmed.delete(key)
    const existing = this.map.get(key)
    if (existing) {
      this.put({ ...existing, artifact, ...identity })
      return
    }
    // A fresh entry must not inherit a loss verdict left by an evicted
    // predecessor that reused this key.
    this.provisionallyLost.delete(key)
    this.put({
      ref,
      key,
      artifact,
      status: 'queued',
      nodes: {},
      regions: {},
      outputs: {},
      artifacts: [],
      artifactsHydrated: false,
      previews: {},
      activities: [],
      logs: [],
      logsDropped: 0,
      errors: [],
      ...identity,
      queuedAt: now,
    })
    this.evictExecutionEntries(ref.connection)
  }

  /** Adopt a completed result only after its durable backend proof was revalidated. */
  restoreCompleted(state: {
    readonly ref: ExecutionRef
    readonly artifact: CompileArtifact
    readonly nodes: Readonly<Record<string, NodeProgress>>
    readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    readonly artifacts: readonly ExecutionArtifact[]
    readonly submittedBy?: ExecutionSubmitter
    readonly jobRef: string
    readonly sourceDocument: string
    readonly queuedAt: number
    readonly endedAt: number
  }): void {
    const key = executionKey(state.ref)
    if (this.map.has(key)) return
    this.recentlyEvicted.delete(key)
    this.unconfirmed.delete(key)
    this.provisionallyLost.delete(key)
    this.put({
      ref: state.ref,
      key,
      artifact: state.artifact,
      status: 'completed',
      nodes: state.nodes,
      regions: {},
      outputs: state.outputs,
      artifacts: state.artifacts,
      artifactsHydrated: true,
      previews: {},
      activities: [],
      logs: [],
      logsDropped: 0,
      errors: [],
      ...(state.submittedBy === undefined ? {} : { submittedBy: state.submittedBy }),
      jobRef: state.jobRef,
      sourceDocument: state.sourceDocument,
      queuedAt: state.queuedAt,
      endedAt: state.endedAt,
    })
    this.evictExecutionEntries(state.ref.connection)
  }

  apply(event: NormalizedEvent): void {
    // Connection-level control events (schema epochs, composition narration,
    // pack failures) carry no execution identity by design: the app layer
    // consumes them (registry refresh, activity log). Nothing to record here.
    if (isControlEvent(event)) return
    if (event.kind === 'status') {
      if (event.queueRemaining !== undefined) {
        const remaining = event.queueRemaining
        this.queueRemainingSignal.update((m) => new Map(m).set(event.connection, remaining))
      }
      return
    }
    const eventKey = executionKey(event.execution)
    if (event.kind === 'started') {
      // A genuine new run may reuse an evicted key, and an observed start
      // confirms an entry first seen through mid-run chatter.
      this.recentlyEvicted.delete(eventKey)
      this.unconfirmed.delete(eventKey)
    } else if (!this.map.has(eventKey)) {
      // Late chatter for a recently evicted run is discarded outright.
      // Beyond that bounded window an unknown key is admitted, but only as
      // an unconfirmed entry, so a straggler can never recreate a protected
      // queued entry that dodges the entry cap and preview budget.
      if (this.recentlyEvicted.has(eventKey)) return
      this.unconfirmed.add(eventKey)
    }
    const created = !this.map.has(eventKey)
    const state = this.ensure(event.execution, event.timestamp)
    this.applyToState(event, state)
    // The event applies before cap eviction, so no branch can reinsert an
    // entry eviction already removed; eviction afterward bounds the entry
    // this event created even when every other entry is protected.
    if (created) this.evictExecutionEntries(event.execution.connection)
  }

  private applyToState(event: ExecutionEvent, state: ExecutionState): void {
    switch (event.kind) {
      case 'node.event':
        return
      case 'started':
        if (this.isAuthoritativeTerminal(state)) return
        if (this.provisionallyLost.delete(state.key)) {
          // A live event disproves the provisional loss verdict: revive the
          // run and retract the "results unknown" warning it carried.
          const { endedAt: _endedAt, ...revived } = state
          this.put({
            ...revived,
            status: 'running',
            startedAt: event.timestamp,
            errors: withoutLostDiagnostics(state.errors),
          })
          return
        }
        this.put({ ...state, status: 'running', startedAt: event.timestamp })
        return
      case 'regionExpanded':
        this.put({
          ...state,
          status: state.status === 'queued' ? 'running' : state.status,
          regions: {
            ...state.regions,
            [event.runtimeNodeId]: {
              kind: event.regionKind,
              binding: event.binding,
              iterations: event.iterations,
            },
          },
        })
        return
      case 'regionFinished': {
        const region = state.regions[event.runtimeNodeId]
        if (region === undefined) return
        this.put({
          ...state,
          regions: {
            ...state.regions,
            [event.runtimeNodeId]: { ...region, finishedIterations: event.iterations },
          },
        })
        return
      }
      case 'nodeStates': {
        // Live events overwrite (a rerun legitimately moves done -> running);
        // SNAPSHOT events (fetched job records) may be older than live events
        // that raced past the fetch, so they merge conservatively: fill
        // unknown nodes, upgrade to terminal, never regress a newer terminal
        // state back to a stale 'running'.
        const liveNodes = Object.fromEntries(Object.entries(event.nodes).map(([nodeId, progress]) => {
          return [nodeId, preserveExecutionDetails(progress, state.nodes[nodeId])]
        }))
        const nodes = event.snapshot
          ? mergeSnapshotNodes(state.nodes, event.nodes)
          : { ...state.nodes, ...liveNodes }
        if (this.provisionallyLost.delete(state.key)) {
          // Live node progress disproves the provisional loss verdict just
          // like 'started' does (a resumed run's first event after a gap can
          // be a node update, never a second run_started).
          const { endedAt: _endedAt, ...revived } = state
          this.put({
            ...revived,
            status: 'running',
            nodes,
            errors: withoutLostDiagnostics(state.errors),
          })
          return
        }
        this.put({ ...state, status: state.status === 'queued' ? 'running' : state.status, nodes })
        return
      }
      case 'nodeOutput': {
        const merged = { ...state.outputs[event.runtimeNodeId], ...event.output }
        this.put({ ...state, outputs: { ...state.outputs, [event.runtimeNodeId]: merged } })
        return
      }
      case 'preview': {
        const frame: PreviewData = {
          channel: event.channel,
          payload: event.payload,
          ...(event.runtimeNodeId ? { runtimeNodeId: event.runtimeNodeId } : {}),
          timestamp: event.timestamp,
          ...(event.stream !== undefined ? { stream: event.stream } : {}),
          ...(event.frameIndex !== undefined ? { frameIndex: event.frameIndex } : {}),
          ...(event.frameCount !== undefined ? { frameCount: event.frameCount } : {}),
          ...(event.fps !== undefined ? { fps: event.fps } : {}),
        }
        // A frame accepted after a terminal verdict, or held by an entry no
        // run start has vouched for, grows this connection's budgeted
        // preview bytes, so the byte budget must run again - terminal
        // transition enforcement alone does not bound this growth.
        const terminal = isTerminalStatus(state.status)
        const budgeted = terminal || this.unconfirmed.has(state.key)
        const putPreview = (next: ExecutionState): void => {
          this.put(next)
          if (budgeted) this.enforcePreviewBudget(state.ref.connection)
        }
        if (!event.runtimeNodeId) {
          putPreview({ ...state, lastPreview: frame })
          return
        }
        const streamKey = frame.stream ?? ''
        const previews = {
          ...state.previews,
          [event.runtimeNodeId]: { ...state.previews[event.runtimeNodeId], [streamKey]: frame },
        }
        const rings = state.previewRings ?? {}
        const nodeRings = rings[event.runtimeNodeId] ?? {}
        // A terminal execution released its rings; a straggler frame may
        // still refresh the retained still but must never rebuild a ring.
        if (!terminal && frame.frameIndex !== undefined && frame.frameCount !== undefined) {
          const prior = nodeRings[streamKey]
          const kept = prior !== undefined && prior.frameCount === frame.frameCount ? prior.frames : {}
          const ring: PreviewRing = {
            frameCount: frame.frameCount,
            ...(frame.fps !== undefined ? { fps: frame.fps } : {}),
            frames: { ...kept, [frame.frameIndex]: frame },
          }
          putPreview({
            ...state,
            previews,
            previewRings: { ...rings, [event.runtimeNodeId]: { ...nodeRings, [streamKey]: ring } },
          })
          return
        }
        if (nodeRings[streamKey] !== undefined) {
          // A frame without ring addressing replaces its own stream's single
          // image, so that stream's stale ring must not keep animating over
          // it. Other streams' rings are untouched.
          const { [streamKey]: _stale, ...remainingStreams } = nodeRings
          const { [event.runtimeNodeId]: _node, ...remainingNodes } = rings
          const previewRings =
            Object.keys(remainingStreams).length > 0
              ? { ...remainingNodes, [event.runtimeNodeId]: remainingStreams }
              : remainingNodes
          putPreview({ ...state, previews, previewRings })
          return
        }
        putPreview({ ...state, previews })
        return
      }
      case 'activity': {
        const activities = [...state.activities, event.activity].slice(-ACTIVITY_LOG_CAP)
        this.put({ ...state, activities })
        return
      }
      case 'valueDiagnostics': {
        const existing = state.valueDiagnostics ?? []
        const diagnostics = [...existing]
        const keys = new Set(diagnostics.map(valueDiagnosticKey))
        for (const diagnostic of event.diagnostics) {
          const key = valueDiagnosticKey(diagnostic)
          if (keys.has(key)) continue
          keys.add(key)
          diagnostics.push(diagnostic)
        }
        if (diagnostics.length === existing.length) return
        this.put({ ...state, valueDiagnostics: diagnostics.slice(-VALUE_DIAGNOSTIC_CAP) })
        return
      }
      case 'log': {
        // The envelope seq identifies a record exactly, so a delivery whose
        // seq is already retained is a duplicate (a second window normalizing
        // the same wire event, a broadcast echo, or a replay of an applied
        // record) and applies once. An UNSEEN seq always applies, even below
        // the current tail: live records are droppable and a replay may fill
        // a gap later. `logs` stays sorted by seq, and once the FIFO cap has
        // trimmed the front, anything older than the retained window stays
        // discarded: re-counting it would double-book replays of records that
        // were already tallied in logsDropped when they were evicted.
        const index = logInsertionIndex(state.logs, event.seq)
        if (index < 0) return
        if (index === 0 && state.logs.length >= EXECUTION_LOG_CAP) return
        const entry: ExecutionLogEntry = {
          level: event.level,
          message: event.message,
          timestamp: event.emittedAt ?? event.timestamp,
          seq: event.seq,
          ...(event.runtimeNodeId !== undefined ? { runtimeNodeId: event.runtimeNodeId } : {}),
          ...(event.origin !== undefined ? { origin: event.origin } : {}),
          ...(event.logger !== undefined ? { logger: event.logger } : {}),
          ...(event.pythonLevel !== undefined ? { pythonLevel: event.pythonLevel } : {}),
        }
        const inserted = [...state.logs.slice(0, index), entry, ...state.logs.slice(index)]
        const dropped = Math.max(0, inserted.length - EXECUTION_LOG_CAP)
        this.put({
          ...state,
          logs: dropped > 0 ? inserted.slice(dropped) : inserted,
          logsDropped: state.logsDropped + dropped,
        })
        return
      }
      case 'error': {
        if (this.isAuthoritativeTerminal(state)) return
        const occKey = event.runtimeNodeId
          ? state.artifact?.provenance.toSource[event.runtimeNodeId]
          : undefined
        const nodes: Record<string, NodeProgress> = event.runtimeNodeId
          ? {
              ...state.nodes,
              [event.runtimeNodeId]: preserveExecutionDetails(
                { state: 'error' },
                state.nodes[event.runtimeNodeId],
              ),
            }
          : { ...state.nodes }
        const diagnostic = diag('error', 'runtime', `runtime.${event.detail.exceptionType}`, event.detail.exceptionMessage, {
          runtime: event.detail,
          anchor: {
            execution: event.execution,
            ...(occKey ? { occurrence: parseOccurrenceKey(occKey) } : {}),
          },
          ...(event.runtimeNodeId ? { data: { runtimeId: event.runtimeNodeId } } : {}),
        })
        const base = this.provisionallyLost.delete(state.key)
          ? withoutLostDiagnostics(state.errors)
          : state.errors
        this.put({
          ...dropPreviewRings(state),
          status: 'error',
          endedAt: event.timestamp,
          nodes,
          errors: base.some((d) => d.code === diagnostic.code && d.message === diagnostic.message)
            ? base : [...base, diagnostic],
        })
        this.enforcePreviewBudget(event.execution.connection)
        this.evictExecutionEntries(event.execution.connection)
        return
      }
      case 'interrupted':
        if (this.isAuthoritativeTerminal(state)) return
        this.put({
          ...dropPreviewRings(state),
          status: 'interrupted',
          endedAt: event.timestamp,
          errors: this.provisionallyLost.delete(state.key) ? withoutLostDiagnostics(state.errors) : state.errors,
        })
        this.enforcePreviewBudget(event.execution.connection)
        this.evictExecutionEntries(event.execution.connection)
        return
      case 'completed':
        if (this.isAuthoritativeTerminal(state)) return
        this.put({
          ...dropPreviewRings(state),
          status: 'completed',
          endedAt: event.timestamp,
          errors: this.provisionallyLost.delete(state.key) ? withoutLostDiagnostics(state.errors) : state.errors,
        })
        this.enforcePreviewBudget(event.execution.connection)
        this.evictExecutionEntries(event.execution.connection)
        return
    }
  }

  /**
   * Merge outputs recovered from server history (cache-hit executions emit no
   * `executed` events). Live-arrived outputs win over hydrated ones.
   */
  hydrateOutputs(
    ref: ExecutionRef,
    outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ): void {
    const state = this.map.get(executionKey(ref))
    if (!state) return
    const merged: Record<string, Readonly<Record<string, unknown>>> = { ...state.outputs }
    for (const [nodeId, output] of Object.entries(outputs)) {
      merged[nodeId] = { ...output, ...merged[nodeId] }
    }
    this.put({ ...state, outputs: merged })
  }

  /** Install the completed job's authoritative, already-decoded artifact list. */
  hydrateArtifacts(ref: ExecutionRef, artifacts: readonly ExecutionArtifact[]): void {
    const state = this.map.get(executionKey(ref))
    if (!state) return
    this.put({ ...state, artifacts: [...artifacts], artifactsHydrated: true })
  }

  /** Attach the server-authenticated principal that submitted this job. */
  hydrateSubmittedBy(ref: ExecutionRef, submittedBy: ExecutionSubmitter): void {
    const state = this.map.get(executionKey(ref))
    if (!state) return
    this.put({ ...state, submittedBy })
  }

  /**
   * Reconciliation verdict for an execution the server no longer knows: not
   * in /history, not in /queue - typically a server restart while we were
   * disconnected. Terminal states are never touched (a terminal event that
   * raced the reconcile wins).
   */
  markLost(ref: ExecutionRef, now: number = Date.now()): void {
    const state = this.map.get(executionKey(ref))
    if (!state || state.status === 'completed' || state.status === 'error' || state.status === 'interrupted') return
    this.provisionallyLost.add(state.key)
    this.put({
      ...dropPreviewRings(state),
      status: 'interrupted',
      endedAt: now,
      errors: [
        ...state.errors,
        diag('warning', 'runtime', 'execution.lost', 'execution is gone from the server queue and history (server restarted?); its results are unknown', {
          anchor: { execution: ref },
        }),
      ],
    })
    this.enforcePreviewBudget(ref.connection)
  }

  /**
   * True while a run's `interrupted` status is a provisional reconcile
   * verdict (markLost) rather than an observed event - a later live event
   * revives such a run, so consumers must not treat it as final.
   */
  isProvisionallyLost(ref: ExecutionRef): boolean {
    return this.provisionallyLost.has(executionKey(ref))
  }

  /**
   * True while an entry admitted from mid-run chatter has had no observed
   * run start or local submission vouch for it - its claimed status (in
   * particular `queued`) is not backed by anything the store observed.
   */
  isUnconfirmed(ref: ExecutionRef): boolean {
    return this.unconfirmed.has(executionKey(ref))
  }

  /**
   * Pin an execution against entry-cap eviction while a view depends on its
   * exact state (an open frozen execution tab). Refcounted; every retain()
   * must be balanced by one release(). Preview frames remain strippable
   * under the byte budget - only the durable entry itself is pinned.
   */
  retain(ref: ExecutionRef): void {
    const key = executionKey(ref)
    this.retained.set(key, (this.retained.get(key) ?? 0) + 1)
  }

  /** Drop one retain() pin; the entry becomes evictable when none remain. */
  release(ref: ExecutionRef): void {
    const key = executionKey(ref)
    const count = this.retained.get(key)
    if (count === undefined) return
    if (count > 1) {
      this.retained.set(key, count - 1)
      return
    }
    this.retained.delete(key)
    // The pin may have been the only thing holding an over-cap entry.
    this.evictExecutionEntries(ref.connection)
  }

  private isAuthoritativeTerminal(state: ExecutionState): boolean {
    return (state.status === 'completed' || state.status === 'error' || state.status === 'interrupted') &&
      !this.provisionallyLost.has(state.key)
  }

  /**
   * Strip preview frame payloads from older budgeted executions - terminal
   * runs plus unconfirmed entries - once this connection's budgeted preview
   * bytes exceed the budget, newest kept first. Runs whenever budgeted
   * preview bytes can grow: a terminal transition, and a frame accepted for
   * a terminal or unconfirmed entry.
   */
  private enforcePreviewBudget(connection: ConnectionId): void {
    const budgeted = [...this.map.values()]
      .filter((state) => state.ref.connection === connection &&
        (isTerminalStatus(state.status) || this.unconfirmed.has(state.key)) &&
        (state.lastPreview !== undefined || Object.keys(state.previews).length > 0 ||
          state.previewRings !== undefined))
      .sort((a, b) => (b.endedAt ?? b.queuedAt) - (a.endedAt ?? a.queuedAt))
    let total = 0
    let changed = false
    for (const [index, state] of budgeted.entries()) {
      total += previewBytesOf(state)
      if (index === 0 || total <= TERMINAL_PREVIEW_BYTE_BUDGET) continue
      this.map.set(state.key, stripPreviewFrames(state))
      changed = true
    }
    if (changed) this.executionsSignal.set(new Map(this.map))
  }

  /**
   * Evict this connection's oldest terminal and unconfirmed entries beyond
   * the entry cap. Provisionally lost runs are still revivable (their
   * interrupted status is a reconcile guess, not an observed event) and
   * retained runs back open frozen views, so both stay, like queued and
   * running work - unless the entry is unconfirmed: an entry no run start
   * ever vouched for gets no protection from any status it claims.
   */
  private evictExecutionEntries(connection: ConnectionId): void {
    const entries = [...this.map.values()].filter((state) => state.ref.connection === connection)
    let excess = entries.length - EXECUTION_ENTRY_CAP
    if (excess <= 0) return
    const evictable = entries
      .filter((state) => (this.isAuthoritativeTerminal(state) || this.unconfirmed.has(state.key)) &&
        !this.retained.has(state.key))
      .sort((a, b) => a.queuedAt - b.queuedAt)
    let changed = false
    for (const state of evictable) {
      if (excess <= 0) break
      this.map.delete(state.key)
      this.unconfirmed.delete(state.key)
      this.provisionallyLost.delete(state.key)
      this.tombstone(state.key)
      excess--
      changed = true
    }
    if (changed) this.executionsSignal.set(new Map(this.map))
  }

  private tombstone(key: string): void {
    this.recentlyEvicted.add(key)
    if (this.recentlyEvicted.size <= EXECUTION_ENTRY_CAP * 2) return
    const oldest = this.recentlyEvicted.values().next().value
    if (oldest !== undefined) this.recentlyEvicted.delete(oldest)
  }

  /** Executions can appear that this client never submitted (other windows/users). */
  private ensure(ref: ExecutionRef, now: number): ExecutionState {
    const key = executionKey(ref)
    const existing = this.map.get(key)
    if (existing) return existing
    const created: ExecutionState = {
      ref,
      key,
      status: 'queued',
      nodes: {},
      regions: {},
      outputs: {},
      artifacts: [],
      artifactsHydrated: false,
      previews: {},
      activities: [],
      logs: [],
      logsDropped: 0,
      errors: [],
      queuedAt: now,
    }
    this.map.set(key, created)
    return created
  }

  private put(state: ExecutionState): void {
    this.map.set(state.key, state)
    this.executionsSignal.set(new Map(this.map))
  }
}
