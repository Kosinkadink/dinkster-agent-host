/**
 * Document store: the authoritative document, revision counter, undo and
 * redo stacks, and the command registry. Implements DocumentStoreContract.
 *
 * Commit protocol per dispatch:
 *   1. look up the command; run it against a transaction builder
 *   2. command diagnostics with severity 'error' => reject, nothing applied
 *   3. run the structural invariant checker on the result document
 *   4. invariant errors => reject atomically (the working copy is discarded)
 *   5. commit: bump revision, push TransactionRecord, clear the redo stack,
 *      notify subscribers via the doc signal
 *
 * Undo/redo REPLAY recorded patches (never re-run commands), so they are
 * deterministic even if a command implementation changes between versions.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, WorkflowDocument } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { isValidActorId, parseOccurrenceKey } from '../ids.js'
import { checkDocument, subgraphDefIdOf } from '../invariants.js'
import { createSignal, type ReadonlySignal, type Signal } from '../reactive/signal.js'
import {
  createTransactionBuilder,
  executeCommand,
  type CommandDefinition,
  type CommandExecutionContext,
  type CommandInvocation,
  type CommandOutcome,
  type DocumentStoreContract,
  type TransactionRecord,
} from './contract.js'
import { applyOwnedOps, getAtPath, type PatchOp } from './patch.js'

const hasErrors = (diags: readonly Diagnostic[]): boolean =>
  diags.some((d) => d.severity === 'error')

/**
 * Observer failures must never corrupt a committed transaction (CO10): each
 * listener is isolated, the rest keep getting notified, and failures go to
 * this injectable sink (console by default - observers are a UI concern and
 * their bugs are diagnosable there).
 */
export type ListenerErrorSink = (error: unknown, context: string) => void

const defaultSink: ListenerErrorSink = (error, context) => {
  // eslint-disable-next-line no-console
  console.error(`[DocumentStore] listener threw during ${context}:`, error)
}

/**
 * Allocation cursors are monotonic FOREVER, including across undo (the
 * never-reuse contract in ids.ts): replaying an inverse patch must not
 * rewind them, or a later add would remint a previously used id.
 */
function isAllocationCursor(path: readonly (string | number)[]): boolean {
  const last = path[path.length - 1]
  if (last === 'nextOrdinal')
    return path.length === 3 &&
      (path[0] === 'graphs' || path[0] === 'occurrenceTopologies')
  // Per-actor allocation cursor (shared sessions): owner.<id>.actorCursors.<actor>
  if (path.length === 4 &&
      (path[0] === 'graphs' || path[0] === 'occurrenceTopologies') &&
      path[2] === 'actorCursors') return true
  // Dynamic `seq` is a cursor ONLY at a declared DynamicPortState position
  // (shape-directed, like the subtree preservers below): a `seq` inside an
  // unknown extension object is semantic data and must replay verbatim.
  if (last === 'seq') return dynamicShapePosition(path.slice(0, -1)) === 'state'
  if (last === 'surfaceSeq') return path.length === 1
  // Per-graph group id cursor (FR1): group ids outlive their groups in
  // surface bindings, so undo must never rewind this either.
  if (last === 'groupSeq') return path.length === 4 && path[0] === 'view' && path[1] === 'graphs'
  return false
}

/**
 * Shape position of an op target inside a node's dynamic-state subtree.
 * Dynamic state EMBEDS allocation cursors: every DynamicPortState carries a
 * numeric `seq`, including nested memberState scopes. Commands write whole
 * subtrees here (dynamic.materialize replaces the entire `dynamic` object),
 * so cursor monotonicity must be preserved structurally.
 *
 * Preservation is SHAPE-DIRECTED, not name-directed: the document format
 * permits unknown additive properties inside dynamic state, and an unknown
 * extension object that happens to contain a numeric `seq` is semantic
 * data, not a cursor - blindly preserving it would make redo diverge from
 * the recorded forward state. Only the DECLARED positions are cursors:
 *
 *   dynamic                                    -> portMap    (portId -> state)
 *   dynamic.<port>                             -> state      (DynamicPortState)
 *   dynamic.<port>.memberState                 -> memberMap  (memberId -> scope)
 *   dynamic.<port>.memberState.<member>        -> scope      (constructId -> state)
 *   dynamic.<port>.memberState.<m>.<construct> -> state      (recurses)
 *
 * Everything else ('members', 'selected', unknown props) is 'outside' -
 * replayed verbatim. Direct numeric `.seq` ops are handled separately by
 * isAllocationCursor.
 */
type DynShapePos = 'portMap' | 'state' | 'memberMap' | 'scope' | 'outside'

function dynamicShapePosition(path: readonly (string | number)[]): DynShapePos {
  if (path.length < 5 || path[0] !== 'graphs' || path[2] !== 'nodes' || path[4] !== 'dynamic')
    return 'outside'
  let pos: DynShapePos = 'portMap'
  for (let i = 5; i < path.length; i++) {
    switch (pos) {
      case 'portMap':
        pos = 'state'
        break
      case 'state':
        pos = path[i] === 'memberState' ? 'memberMap' : 'outside'
        break
      case 'memberMap':
        pos = 'scope'
        break
      case 'scope':
        pos = 'state'
        break
      case 'outside':
        return 'outside'
    }
  }
  return pos
}

const isJsonObject = (v: Json | undefined): v is { readonly [k: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

type Preserve = (current: Json | undefined, next: Json | undefined) => Json | undefined

/**
 * Record-shaped positions (portMap/memberMap/scope): every entry's value is
 * preserved by `child`; keys are ids and carry no cursors themselves.
 * Returns undefined when nothing needed preserving and `next` was undefined
 * (a remove may proceed as recorded). `skip` opts individual keys out of
 * preservation entirely (their recorded op stands verbatim).
 */
const preserveRecord =
  (child: Preserve, skip?: (key: string) => boolean): Preserve =>
  (current, next) => {
    if (!isJsonObject(current)) return next
    const base: Record<string, Json> = isJsonObject(next) ? { ...next } : {}
    let changed = !isJsonObject(next) // synthesizing a skeleton counts as a change
    for (const [key, cur] of Object.entries(current)) {
      if (skip?.(key)) continue
      const merged = child(cur, base[key])
      if (merged !== undefined && merged !== base[key]) {
        base[key] = merged
        changed = true
      }
    }
    if (!changed) return next
    // A pure skeleton with nothing preserved means the remove stands.
    if (!isJsonObject(next) && Object.keys(base).length === 0) return next
    return Object.freeze(base)
  }

/**
 * DynamicPortState position: clamp the declared numeric `seq` so it never
 * rewinds below what the CURRENT document holds (CO3), creating a {seq}
 * skeleton where `next` lacks the position entirely, and recurse ONLY
 * through the declared memberState scope chain.
 */
const preserveStateCursors: Preserve = (current, next) => {
  if (!isJsonObject(current)) return next
  const base: Record<string, Json> = isJsonObject(next) ? { ...next } : {}
  let changed = !isJsonObject(next)
  const curSeq = current['seq']
  if (typeof curSeq === 'number') {
    const nv = base['seq']
    if (typeof nv !== 'number' || nv < curSeq) {
      base['seq'] = curSeq
      changed = true
    }
  }
  const mergedMs = preserveMemberMap(current['memberState'], base['memberState'])
  if (mergedMs !== undefined && mergedMs !== base['memberState']) {
    base['memberState'] = mergedMs
    changed = true
  }
  if (!changed) return next
  if (!isJsonObject(next) && Object.keys(base).length === 0) return next
  return Object.freeze(base)
}

const preserveScope: Preserve = preserveRecord(preserveStateCursors)
const preserveMemberMap: Preserve = preserveRecord(preserveScope)
const preservePortMap: Preserve = preserveRecord(preserveStateCursors)

const preserverAt: Record<Exclude<DynShapePos, 'outside'>, Preserve> = {
  portMap: preservePortMap,
  state: preserveStateCursors,
  memberMap: preserveMemberMap,
  scope: preserveScope,
}

/**
 * GraphViewState embeds the groupSeq allocation cursor (FR1). Whole
 * view-graph ops are recorded by ensureViewGraph (`add` + inverse `remove`)
 * and by subgraph.import (which also adds/removes the SEMANTIC graph in the
 * same batch). The inverse remove is exactly the op that would erase the
 * cursor: undoing the transaction that materialized view.graphs[g] (e.g.
 * the first view.createGroup on a graph) must not un-allocate every group
 * id it minted. Preserve the cursor structurally, like dynamic seq - but
 * ONLY for graphs whose semantic graph survives the replay batch: a
 * skeleton without its graph would be a dangling view entry
 * (I8 doc.view.danglingGraph), so un-import removes both sides verbatim.
 */
type ViewShapePos = 'graphsMap' | 'graphView' | 'outside'

function viewGraphShapePosition(path: readonly (string | number)[]): ViewShapePos {
  if (path[0] !== 'view' || path[1] !== 'graphs') return 'outside'
  if (path.length === 2) return 'graphsMap'
  if (path.length === 3) return 'graphView'
  return 'outside'
}

/**
 * GraphViewState position: clamp `groupSeq` so it never rewinds below what
 * the CURRENT document holds. A remove leaves the `{nodes: {}, groupSeq}`
 * skeleton - `nodes: {}` is ensureViewGraph's own shape, so every command
 * that writes under view.graphs[g].nodes keeps working after the undo.
 */
const preserveGraphViewCursor: Preserve = (current, next) => {
  if (!isJsonObject(current)) return next
  const curSeq = current['groupSeq']
  if (typeof curSeq !== 'number') return next // nothing to preserve; the op stands
  const base: Record<string, Json> = isJsonObject(next) ? { ...next } : { nodes: {} }
  const nv = base['groupSeq']
  if (typeof nv === 'number' && nv >= curSeq && isJsonObject(next)) return next
  base['groupSeq'] = typeof nv === 'number' && nv > curSeq ? nv : curSeq
  return Object.freeze(base)
}

/**
 * Whole `view.graphs` map preserver, key-aware: entries whose semantic
 * graph is absent from the batch's FINAL graph membership get no skeleton
 * (their recorded op stands), everyone else's cursor is preserved.
 */
const makePreserveViewGraphsMap = (survivingGraphs: ReadonlySet<string>): Preserve =>
  preserveRecord(preserveGraphViewCursor, (key) => !survivingGraphs.has(key))

/**
 * Whole graphs.<g>.actorCursors map ops: the FIRST actor allocation on a
 * graph creates the map in one op (its inverse removes the whole map), so
 * undo must clamp per key like every other cursor - a remove keeps every
 * actor's high-water mark, an add/replace merges each key upward. Direct
 * numeric per-actor ops are handled by isAllocationCursor.
 */
const isActorCursorsMap = (path: readonly (string | number)[]): boolean =>
  path.length === 3 &&
  (path[0] === 'graphs' || path[0] === 'occurrenceTopologies') &&
  path[2] === 'actorCursors'

const preserveNumericCursor: Preserve = (current, next) =>
  typeof current === 'number' && (typeof next !== 'number' || next < current) ? current : next

const preserveActorCursorsMap: Preserve = preserveRecord(preserveNumericCursor)

/**
 * Occurrence topology records embed their own link-allocation cursors. Undo
 * of the first local link keeps a minimal owner/body/empty-links skeleton so
 * neither the solo nor any actor-scoped id can be minted again. Semantic
 * links, suppressions, and extensions still replay exactly.
 */
const preserveOccurrenceTopologyCursors: Preserve = (current, next) => {
  if (!isJsonObject(current)) return next
  const curNext = current['nextOrdinal']
  const curActors = current['actorCursors']
  const hasCursor =
    (typeof curNext === 'number' && curNext > 0) ||
    (isJsonObject(curActors) && Object.values(curActors).some((cursor) =>
      typeof cursor === 'number' && cursor > 0))
  if (!hasCursor && next === undefined) return next

  const base: Record<string, Json> = isJsonObject(next)
    ? { ...next }
    : {
        owner: current['owner']!,
        bodyGraph: current['bodyGraph']!,
        links: {},
        nextOrdinal: 0,
      }
  let changed = !isJsonObject(next)
  if (typeof curNext === 'number') {
    const nextCursor = base['nextOrdinal']
    if (typeof nextCursor !== 'number' || nextCursor < curNext) {
      base['nextOrdinal'] = curNext
      changed = true
    }
  }
  const actors = preserveActorCursorsMap(curActors, base['actorCursors'])
  if (actors !== undefined && actors !== base['actorCursors']) {
    base['actorCursors'] = actors
    changed = true
  }
  return changed ? Object.freeze(base) : next
}

const makePreserveOccurrenceTopologiesMap = (survivingOccurrences: ReadonlySet<string>): Preserve =>
  preserveRecord(preserveOccurrenceTopologyCursors, (key) => !survivingOccurrences.has(key))

type OccurrenceTopologyShapePos = 'map' | 'topology' | 'outside'

function occurrenceTopologyShapePosition(
  path: readonly (string | number)[],
): OccurrenceTopologyShapePos {
  if (path[0] !== 'occurrenceTopologies') return 'outside'
  if (path.length === 1) return 'map'
  if (path.length === 2) return 'topology'
  return 'outside'
}

/**
 * One committed change to the store, however it happened. `patch` is the
 * ops actually APPLIED to the document by this commit: the record's forward
 * ops for dispatch/redo, its inverse ops for undo. `revision` is the
 * counter after the commit. This is the raw feed DocumentSession adapts
 * into envelope-shaped ops.
 */
export interface TransactionEvent {
  readonly kind: 'dispatch' | 'undo' | 'redo'
  readonly record: TransactionRecord
  readonly revision: number
  readonly patch: readonly PatchOp[]
}

export class DocumentStore implements DocumentStoreContract {
  private readonly docSignal: Signal<WorkflowDocument>
  /**
   * Authoritative committed document (FR2). Commits update this field
   * synchronously so a reentrant dispatch from inside a notification builds
   * on the real document, while observer notification is serialized through
   * the queue below.
   */
  private currentDoc: WorkflowDocument
  private revisionCounter = 0
  private readonly undoStack: TransactionRecord[] = []
  private readonly redoStack: TransactionRecord[] = []
  private readonly txListeners = new Set<(event: TransactionEvent) => void>()
  /**
   * Reentrancy-safe notification FIFO (FR2): a document or transaction
   * listener may synchronously dispatch again. Without the queue, the
   * nested commit's notifications would OVERTAKE the outer commit's
   * (listeners see revision 2 before revision 1, and the outer event
   * would read a moved revisionCounter). Every commit enqueues its
   * (doc, event) pair; only the outermost commit drains, so every
   * listener observes documents and events in exact commit order.
   */
  private readonly notifyQueue: { doc: WorkflowDocument; event: TransactionEvent }[] = []
  private notifying = false

  constructor(
    initial: WorkflowDocument,
    private readonly commands: ReadonlyMap<string, CommandDefinition>,
    /** Undo depth bound; oldest transactions fall off. */
    private readonly maxUndo = 200,
    private readonly onListenerError: ListenerErrorSink = defaultSink,
    private readonly executionContext: () => CommandExecutionContext = () => ({ kind: 'initial' }),
  ) {
    // Ownership boundary (CO1): the store never retains or exposes caller-
    // mutable data. The initial document is validated, deep-copied, and
    // deep-frozen once here; every later commit preserves frozenness by
    // construction (frozen op values + frozen path copies in applyOps).
    const owned = ownJson(initial as unknown as Json)
    if (!owned.ok) throw new Error(`DocumentStore: initial document is not JSON: ${owned.reason}`)
    this.currentDoc = owned.value as unknown as WorkflowDocument
    this.docSignal = createSignal<WorkflowDocument>(
      this.currentDoc,
      Object.is,
      (error) => this.onListenerError(error, 'document notify'),
    )
  }

  get doc(): WorkflowDocument {
    return this.currentDoc
  }

  get revision(): number {
    return this.revisionCounter
  }

  /** Reactive view of the document; the UI subscribes here. */
  get document(): ReadonlySignal<WorkflowDocument> {
    return this.docSignal
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Subscribe to every committed change (dispatch, undo, redo). */
  onTransaction(listener: (event: TransactionEvent) => void): () => void {
    this.txListeners.add(listener)
    return () => this.txListeners.delete(listener)
  }

  /**
   * Commit a document and deliver notifications in commit order (FR2).
   * The document becomes authoritative IMMEDIATELY (a reentrant dispatch
   * builds on it); the docSignal update and transaction event are queued,
   * and only the outermost commit drains, so a listener that dispatches
   * synchronously can never make later listeners see revisions out of
   * order or the outer event report a moved revision.
   */
  private commit(doc: WorkflowDocument, event: TransactionEvent): void {
    this.currentDoc = doc
    this.notifyQueue.push({ doc, event })
    if (this.notifying) return
    this.notifying = true
    try {
      for (let next = this.notifyQueue.shift(); next; next = this.notifyQueue.shift()) {
        this.docSignal.set(next.doc)
        this.emit(next.event)
      }
    } finally {
      this.notifying = false
    }
  }

  private emit(event: TransactionEvent): void {
    // CO10: one throwing observer must not starve the rest or unwind into
    // the committed dispatch.
    for (const l of [...this.txListeners]) {
      try {
        l(event)
      } catch (e) {
        // A throwing injected sink must not unwind into the committed
        // dispatch either (CO10 applies to the sink itself).
        try {
          this.onListenerError(e, 'transaction notify')
        } catch (sinkError) {
          // eslint-disable-next-line no-console
          console.error('[DocumentStore] error sink threw:', sinkError)
        }
      }
    }
  }

  dispatch(invocation: CommandInvocation): CommandOutcome {
    const def = this.commands.get(invocation.command)
    if (!def) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'command', 'command.unknown', `unknown command '${invocation.command}'`),
        ],
      }
    }

    // Actor ingress (shared sessions): the actor is embedded verbatim in
    // minted ids, so it must be a valid id fragment BEFORE any command runs.
    // Rejecting here keeps the guarantee document-wide instead of
    // per-allocation-site.
    if (invocation.actor !== undefined && !isValidActorId(invocation.actor)) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'command', 'command.actor.invalid', `${invocation.command}: actor id ${JSON.stringify(invocation.actor)} is not a valid id fragment (safe set: [A-Za-z0-9_-]+)`),
        ],
      }
    }

    // Params ownership (CO1/CO2): the invocation is retained in the undo
    // stack and emitted to observers, so it must be JSON and must not alias
    // caller-mutable data. One normalize+freeze here covers both.
    // 'reject' undefined props: a map entry like {values: {x: undefined}}
    // must be an atomic rejection, not a silently smaller commit.
    const ownedParams = ownJson(invocation.params, { undefinedProps: 'reject' })
    if (!ownedParams.ok) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'command', 'command.params.notJson', `${invocation.command}: params are not JSON: ${ownedParams.reason}`),
        ],
      }
    }
    const ownedInvocation: CommandInvocation = Object.freeze({
      command: invocation.command,
      params: ownedParams.value,
      ...(invocation.actor !== undefined ? { actor: invocation.actor } : {}),
    })

    const tx = createTransactionBuilder(this.doc, ownedInvocation.actor)
    let commandDiags: readonly Diagnostic[]
    try {
      commandDiags = executeCommand(def, this.doc, ownedInvocation.params, tx, this.executionContext())
    } catch (e) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'command', 'command.threw', `${invocation.command}: ${e instanceof Error ? e.message : String(e)}`),
        ],
      }
    }
    if (hasErrors(commandDiags)) return { ok: false, diagnostics: commandDiags }

    const { doc, forward, inverse } = tx.result()
    if (forward.length === 0) {
      // No-op commands succeed without a transaction (nothing to undo).
      return { ok: true, doc: this.doc, forward, inverse, diagnostics: commandDiags }
    }

    const invariantDiags = checkDocument(doc)
    if (hasErrors(invariantDiags)) {
      return { ok: false, diagnostics: [...commandDiags, ...invariantDiags] }
    }

    this.revisionCounter += 1
    // FR2: capture the revision NOW - a reentrant dispatch from inside the
    // commit's notifications moves revisionCounter before this frame ends.
    const revision = this.revisionCounter
    const record: TransactionRecord = Object.freeze({
      revision,
      invocation: ownedInvocation,
      forward,
      inverse,
      timestamp: Date.now(),
    })
    this.undoStack.push(record)
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
    this.redoStack.length = 0
    this.commit(doc, Object.freeze({ kind: 'dispatch' as const, record, revision, patch: forward }))
    return { ok: true, doc, forward, inverse, diagnostics: [...commandDiags, ...invariantDiags] }
  }

  /**
   * Replay recorded ops, skipping any that would REWIND an allocation
   * cursor (CO3): ids are never reused, so undoing an add removes the node
   * but keeps nextOrdinal/seq at their high-water mark. Returns the ops
   * actually applied - events must report reality, not the recording.
   */
  private replay(ops: readonly PatchOp[]): { doc: WorkflowDocument; applied: readonly PatchOp[] } {
    return replayHistoryOps(this.doc, ops)
  }

  undo(): boolean {
    const record = this.undoStack.pop()
    if (!record) return false
    const { doc, applied } = this.replay(record.inverse)
    this.redoStack.push(record)
    this.revisionCounter += 1
    const revision = this.revisionCounter
    this.commit(doc, Object.freeze({ kind: 'undo' as const, record, revision, patch: applied }))
    return true
  }

  redo(): boolean {
    const record = this.redoStack.pop()
    if (!record) return false
    const { doc, applied } = this.replay(record.forward)
    this.undoStack.push(record)
    this.revisionCounter += 1
    const revision = this.revisionCounter
    this.commit(doc, Object.freeze({ kind: 'redo' as const, record, revision, patch: applied }))
    return true
  }

  /**
   * Adopt the CURRENT document as the history baseline: drop every undo and
   * redo record without touching the document or revision. For open-time
   * normalization passes (e.g. silently upgrading stock seed documents to a
   * backend's canonical types) whose result should look born-this-way - a
   * fresh tab must not carry an undo step back to a state the user never
   * authored. No transaction event fires: the document did not change.
   */
  clearHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  /**
   * The undo/redo stacks' patches, oldest first, detached from store
   * internals. History stays session-local by contract (inverses never ride
   * the wire); this exists so a same-document session replacement can carry
   * the user's undo history across the swap.
   */
  historySnapshot(): HistorySnapshot {
    const detach = (records: readonly TransactionRecord[]): HistorySnapshotRecord[] =>
      records.map((record) => ({ forward: record.forward, inverse: record.inverse }))
    return { revision: this.revision, undo: detach(this.undoStack), redo: detach(this.redoStack) }
  }
}

/** One history record's patches, valid only against the document they were recorded on. */
export interface HistorySnapshotRecord {
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
}

/** Undo/redo history detached from a store or session, oldest record first. */
export interface HistorySnapshot {
  readonly revision: number
  readonly undo: readonly HistorySnapshotRecord[]
  readonly redo: readonly HistorySnapshotRecord[]
}

/** Structural JSON equality: value shape, not serialization order. */
export function jsonSameValue(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => jsonSameValue(v, b[i]))
  }
  if (!isJsonObject(a) || !isJsonObject(b)) return false
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonSameValue(a[k], b[k]))
}

/**
 * Replay recorded ops against `doc`, skipping/clamping any that would
 * REWIND an allocation cursor (CO3): ids are never reused, so undoing an
 * add removes the node but keeps nextOrdinal/seq at their high-water
 * mark. Returns the document after replay and the ops actually applied -
 * events must report reality, not the recording. Shared by DocumentStore
 * undo/redo and the shared session's session-local history replay.
 *
 * With `requireRecordedValues`, every verbatim-replayed op must still find
 * the document value it recorded (remove/replace: current deep-equals its
 * oldValue; add: target absent) or replay stops with `stale` set to the
 * offending op. Cursor-clamped ops are exempt - they are rewritten against
 * the current document, never replayed. The shared session sets this so a
 * history record can never force-apply over a foreign actor's edit; the
 * local store keeps classical replay semantics (single writer - values can
 * only be what the history says they are).
 */
export function replayHistoryOps(
  doc: WorkflowDocument,
  ops: readonly PatchOp[],
  options?: { readonly requireRecordedValues?: boolean },
): { doc: WorkflowDocument; applied: readonly PatchOp[]; stale?: PatchOp } {
  let cur = doc as unknown as Json
  const applied: PatchOp[] = []
  // FINAL semantic graph membership after this batch: a cursor skeleton
  // must not outlive its graph (I8 doc.view.danglingGraph). subgraph.
  // import records whole graphs[g] + view.graphs[g] adds, so undoing it
  // removes BOTH - when the graph itself leaves, its view-graph remove
  // must stand verbatim, not be converted into a {nodes, groupSeq}
  // skeleton. Membership starts from the current document and applies
  // whole ['graphs'] map ops AND exact ['graphs', g] ops in order, so
  // remove-then-re-add batches keep preservation on and whole-map
  // replacements count too; precomputed over the whole batch because
  // the inverse (reversed) order removes the view graph BEFORE the
  // graph.
  const survivingGraphs = new Set<string>(Object.keys((cur as unknown as WorkflowDocument).graphs ?? {}))
  for (const op of ops) {
    if (op.path.length === 1 && op.path[0] === 'graphs') {
      survivingGraphs.clear()
      if (op.op !== 'remove' && isJsonObject(op.value))
        for (const k of Object.keys(op.value)) survivingGraphs.add(k)
    } else if (op.path.length === 2 && op.path[0] === 'graphs' && typeof op.path[1] === 'string') {
      if (op.op === 'remove') survivingGraphs.delete(op.path[1])
      else survivingGraphs.add(op.path[1])
    }
  }
  const semanticFinal = applyOwnedOps(cur, ops.filter((op) =>
    op.path[0] === 'graphs' && (
      op.path.length <= 2 ||
      op.path[2] === 'nodes' && (op.path.length <= 4 || op.path[4] === 'type')
    ),
  )) as unknown as WorkflowDocument
  const ownerSurvives = (key: string): boolean => {
    const owner = parseOccurrenceKey(key)
    let graph = semanticFinal.graphs[semanticFinal.root]
    for (const id of [...owner.instancePath, owner.node]) {
      const node = graph?.nodes[id]
      const body = node === undefined ? undefined : subgraphDefIdOf(node.type)
      if (body === undefined) return false
      graph = semanticFinal.graphs[body]
    }
    return graph !== undefined
  }
  const occurrenceKeys = new Set([
    ...Object.keys((cur as unknown as WorkflowDocument).occurrenceTopologies ?? {}),
    ...Object.keys(semanticFinal.occurrenceTopologies ?? {}),
  ])
  const survivingOccurrences = new Set([...occurrenceKeys].filter(ownerSurvives))
  for (const op of ops) {
    let effective: PatchOp = op
    // Cursor-shaped path AND number-typed op: a construct literally named
    // 'seq' also matches the path shape, but its value is an object -
    // that case must NOT be skipped here (its remove is a real removal)
    // and falls through to the structural dynamic-subtree handling.
    const isNumericCursorOp =
      isAllocationCursor(op.path) &&
      (op.op === 'remove' ? typeof op.oldValue === 'number' : typeof op.value === 'number')
    const dynPos = isNumericCursorOp ? 'outside' : dynamicShapePosition(op.path)
    let viewPos = isNumericCursorOp || dynPos !== 'outside' ? 'outside' : viewGraphShapePosition(op.path)
    // No preservation for a view graph whose semantic graph is absent
    // from this batch's final membership - the recorded op stands.
    if (viewPos === 'graphView' && !survivingGraphs.has(op.path[2] as string)) viewPos = 'outside'
    let occurrencePos =
      isNumericCursorOp || dynPos !== 'outside' || viewPos !== 'outside'
        ? 'outside'
        : occurrenceTopologyShapePosition(op.path)
    if (occurrencePos === 'topology' && !survivingOccurrences.has(op.path[1] as string)) occurrencePos = 'outside'
    const actorMapPos =
      !isNumericCursorOp &&
      dynPos === 'outside' &&
      viewPos === 'outside' &&
      occurrencePos === 'outside' &&
      isActorCursorsMap(op.path)
    if (isNumericCursorOp) {
      const current = getAtPath(cur, op.path)
      if (op.op === 'remove') continue // a cursor is never un-allocated
      if (typeof current === 'number' && typeof op.value === 'number') {
        if (op.value <= current) continue // rewind or no-op: keep the high-water mark
        // A cursor 'add' whose key already exists (redo after a clamped
        // undo) must re-target as a replace or applyOps would reject it.
        effective = Object.freeze({ op: 'replace', path: op.path, value: op.value, oldValue: current })
      }
    } else if (dynPos !== 'outside' || viewPos !== 'outside' ||
               occurrencePos !== 'outside' || actorMapPos) {
      // Whole-subtree writes embed cursors (dynamic.materialize replaces
      // the entire `dynamic` object; ensureViewGraph's inverse removes a
      // whole view graph, groupSeq included; the first actor allocation
      // adds the whole actorCursors map); clamp them structurally -
      // following the DECLARED shapes only - so undo removes members and
      // groups but never rewinds any cursor.
      const preserveSeqCursors =
        dynPos !== 'outside'
          ? preserverAt[dynPos]
          : occurrencePos === 'topology'
            ? preserveOccurrenceTopologyCursors
            : occurrencePos === 'map'
              ? makePreserveOccurrenceTopologiesMap(survivingOccurrences)
          : actorMapPos
            ? preserveActorCursorsMap
            : viewPos === 'graphView'
              ? preserveGraphViewCursor
              : makePreserveViewGraphsMap(survivingGraphs)
      const current = getAtPath(cur, op.path)
      if (options?.requireRecordedValues) {
        // Semantic precondition, cursor-aware: cursor-bearing subtrees
        // legitimately drift from the record ONLY by cursor advancement
        // (other actors allocate). Normalize the recorded expectation's
        // cursors up to the current document; any remaining difference is
        // foreign semantic data this replay would overwrite.
        const recorded = op.op === 'add' ? undefined : (op.oldValue as Json | undefined)
        const allowed = preserveSeqCursors(current, recorded)
        const holds =
          current === undefined
            ? allowed === undefined
            : allowed !== undefined && jsonSameValue(current, allowed)
        if (!holds) return { doc: cur as unknown as WorkflowDocument, applied: Object.freeze(applied), stale: op }
      }
      if (op.op === 'remove') {
        const kept = preserveSeqCursors(current, undefined)
        if (kept !== undefined && current !== undefined) {
          effective = Object.freeze({ op: 'replace', path: op.path, value: kept, oldValue: current })
        }
      } else {
        const clamped = preserveSeqCursors(current, op.value as Json) as Json
        // Existence re-target: after a clamped undo the key may exist
        // where the recorded op says 'add' (and vice versa).
        if (current === undefined) {
          if (clamped !== op.value || op.op !== 'add') {
            effective = Object.freeze({ op: 'add' as const, path: op.path, value: clamped })
          }
        } else if (clamped !== op.value || op.op !== 'replace') {
          effective = Object.freeze({ op: 'replace' as const, path: op.path, value: clamped, oldValue: current })
        }
      }
    } else if (options?.requireRecordedValues) {
      // Semantic precondition (shared mode): the op replays verbatim, so
      // the document must still hold the value the record captured -
      // otherwise this replay would overwrite another actor's edit.
      const current = getAtPath(cur, op.path)
      const holds =
        op.op === 'add'
          ? current === undefined
          : current !== undefined && jsonSameValue(current, op.oldValue)
      if (!holds) return { doc: cur as unknown as WorkflowDocument, applied: Object.freeze(applied), stale: op }
    }
    // Trusted fast path: recorded/clamped ops are owned by construction.
    cur = applyOwnedOps(cur, [effective])
    applied.push(effective)
  }
  return { doc: cur as unknown as WorkflowDocument, applied: Object.freeze(applied) }
}
