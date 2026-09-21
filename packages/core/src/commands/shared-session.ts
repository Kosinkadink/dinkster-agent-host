/**
 * SharedDocumentSession: the multiplayer DocumentSession over the
 * dinkster-collab v1 surface (joint contract pinned with the backend,
 * protocolVersion 1).
 *
 * Concurrency model - server-ordered optimistic concurrency and re-execution
 * rebase. The server never transforms patches. Command families may opt into
 * pure client-side parameter transformation when pending intentions rebase;
 * every other command keeps whole-document re-execution semantics:
 *
 * - `confirmed` is the server-authoritative document at `confirmedRevision`:
 *   exactly the server op log applied in server order. The server accepts an
 *   op only at its exact baseRevision (409 stale-base otherwise) and never
 *   transforms, so every accepted op's patch applies cleanly by construction.
 * - `pending` is the FIFO of THIS actor's unacknowledged intentions. The
 *   optimistic document (what the UI sees) is always
 *   confirmed + pending re-executed, maintained in an inner DocumentStore.
 * - Local dispatch executes optimistically (full command validation +
 *   invariants), enqueues the intention, and submits ops one at a time with
 *   baseRevision = confirmedRevision.
 * - A foreign op (another actor) advances `confirmed` and triggers a REBASE:
 *   the inner store is rebuilt from the new confirmed document and every
 *   pending intention re-executes as a command (this is why invocations are
 *   serializable intention data). An intention that no longer applies is
 *   DROPPED and surfaced through onConflict - never silently merged wrong.
 *   Re-execution may remint ids; that is safe because actor-scoped
 *   allocation (alloc.ts) keeps id spaces disjoint per actor, and only
 *   unacknowledged ops ever re-execute.
 * - 409 stale-base pauses submission; the losing race's ops arrive over the
 *   WS, the rebase runs, and submission resumes with the new baseRevision
 *   and a FRESH opId (the patch changed; reusing the opId would collide
 *   with the server's idempotent-resubmission dedup). The SAME opId is
 *   reused only for network-error retries, where dedup is exactly what we
 *   want.
 * - Undo/redo are ordinary forward ops (joint pin, Dinkster b48cc01): undo
 *   dispatches the recorded inverse patch as a `session.patch` command
 *   through the same optimistic pipeline (invariant-gated), so inverse
 *   patches never ride the wire as inverses. History is session-local; a
 *   record whose patch no longer applies after a rebase is dropped on the
 *   undo/redo attempt (conflict-safe, never force-applied).
 * - The onOp feed emits SERVER-ORDERED ops only (contiguous revisions,
 *   own acks and foreign ops alike); optimistic state is visible through
 *   the document signal, not the feed. `revision` reports the optimistic
 *   count plus any predecessor-session offset so same-document handoffs stay
 *   monotonic for dirty tracking.
 * - Presence is ephemeral passthrough (never stored in document state).
 *
 * Trust boundary: foreign patches and snapshots are structurally validated
 * on ingress (applyOps ownership + invariant check; loadDocument for
 * snapshots). Anything that fails validation triggers a RESYNC from the
 * server snapshot rather than a local guess; a failed resync is a session
 * error state.
 *
 * Transport is injected (CollabConnection): this module owns the state
 * machine only - fetch/WebSocket live in @dinkster/client, and tests drive a
 * fake connection deterministically.
 */

import type { Json, WorkflowDocument } from '../format/document.js'
import { ownJson } from '../format/json.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { loadDocument } from '../format/migrate.js'
import { checkDocument } from '../invariants.js'
import { createSignal, type ReadonlySignal, type Signal } from '../reactive/signal.js'
import type {
  CommandDefinition,
  CommandInvocation,
  CommandOutcome,
  SharedReplayPreparation,
} from './contract.js'
import { predictAllocatedId } from './alloc.js'
import { isValidActorId } from '../ids.js'
import { applyOps, type PatchOp } from './patch.js'
import { DocumentStore, jsonSameValue, replayHistoryOps, type HistorySnapshot, type ListenerErrorSink } from './store.js'
import { toWirePatch, type DocumentSession, type SessionOp, type WirePatchOp } from './session.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import {
  COLLAB_PROTOCOL_VERSION,
  isValidCollabRevision,
  validateCollabDescriptor,
  validateCollabServerOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type PostOpOutcome,
} from './collab-protocol.js'
import {
  SnapshotPublicationPolicy,
  type SnapshotPublicationDecision,
} from './snapshot-publication-policy.js'

// ---------------------------------------------------------------------------
// Internal patch-replay command
// ---------------------------------------------------------------------------

/**
 * Replays a wire-shaped forward patch as an ordinary command, so undo/redo
 * (and only undo/redo - the id is reserved, registered privately by the
 * shared session) ride the same validation pipeline as every mutation:
 * ownership boundary, '__proto__' path refusal, and the full invariant
 * check. A patch that no longer fits the current document is an atomic
 * rejection, never a partial apply.
 */
const sessionPatchCommand: CommandDefinition = {
  id: 'session.patch',
  run(_doc, params, tx) {
    const ops = (params as { ops?: unknown })?.ops
    if (!Array.isArray(ops)) throw new Error('session.patch: params.ops must be an array')
    for (const raw of ops) {
      const op = raw as WirePatchOp
      if (op === null || typeof op !== 'object' || !Array.isArray(op.path)) {
        throw new Error('session.patch: malformed op')
      }
      if (op.op === 'remove') {
        tx.remove(op.path)
      } else if (op.op === 'add' && typeof op.path[op.path.length - 1] === 'number') {
        tx.insert(op.path, op.value as Json)
      } else if (op.op === 'add' || op.op === 'replace') {
        tx.set(op.path, op.value as Json)
      } else {
        throw new Error(`session.patch: unknown op '${String((op as { op?: unknown }).op)}'`)
      }
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SharedSessionStatus = 'live' | 'catching-up' | 'closed' | 'error'

/** A pending intention dropped because it no longer applies after a rebase. */
export interface SessionConflict {
  readonly invocation: CommandInvocation
  readonly diagnostics: readonly Diagnostic[]
  /** 'rebase' = foreign op invalidated it; 'undo'/'redo' = history replay refused. */
  readonly during: 'rebase' | 'undo' | 'redo'
}

export interface SharedSessionOptions {
  readonly actorId?: string
  /** Session-local history depth (undo/redo records). */
  readonly maxUndo?: number
  readonly clock?: () => number
  /** Await between idempotent retries of a transport-failed POST. */
  readonly retryDelay?: () => Promise<void>
  /** Random sample in [0, 1] for checkpoint publisher jitter. */
  readonly snapshotRandom?: () => number
  readonly onListenerError?: ListenerErrorSink
  readonly onConflict?: (conflict: SessionConflict) => void
  readonly onError?: (message: string) => void
  readonly schemaResolverFor?: (doc: WorkflowDocument) => SchemaResolver
}

/** One POST attempt of a pending intention: what was actually sent to the server. */
interface SubmittedAttempt {
  readonly opId: string
  readonly baseRevision: number
  readonly patch: readonly WirePatchOp[]
}

interface PendingEntry {
  opId: string
  invocation: CommandInvocation
  /** SessionOp.origin for the eventual ack ('session.undo'/'session.redo' for replays). */
  readonly origin: string
  predicted: readonly WirePatchOp[]
  /**
   * Every attempt this intention was POSTed under. A resync rebase remints
   * the live opId while an attempt's fate may be UNKNOWN (the response was
   * mismatched or lost) - if the server committed that attempt, ordered
   * ingress must recognize it as THIS intention's confirmation, not adopt
   * it as unrelated external state and then resubmit a duplicate.
   */
  readonly attempts: SubmittedAttempt[]
  /**
   * The history record this intention authored (dispatch) or moved
   * (undo/redo replay). A rebase that re-executes the intention REWRITES
   * the record in place (the correct inverse may have changed); a rebase
   * that drops or no-ops it REMOVES the record - a stale record could
   * otherwise undo state a foreign actor authored.
   */
  record?: HistoryRecord | undefined
}

/** Mutable on purpose: rebases rewrite records in place (see PendingEntry.record). */
interface HistoryRecord {
  forward: readonly PatchOp[]
  inverse: readonly PatchOp[]
}

const hasErrors = (diags: readonly Diagnostic[]): boolean =>
  diags.some((d) => d.severity === 'error')

const defaultActorId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `a${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`

class SharedDocumentSession implements DocumentSession {
  readonly actorId: string
  /** Shared dispatch stamps actorId; ids come from actorCursors[actorId]. */
  get allocationActor(): string {
    return this.actorId
  }
  readonly status: ReadonlySignal<SharedSessionStatus>

  private readonly commands: ReadonlyMap<string, CommandDefinition>
  private readonly connection: CollabConnection
  private readonly clock: () => number
  private readonly retryDelay: () => Promise<void>
  private readonly sink: ListenerErrorSink
  private readonly onConflict: ((conflict: SessionConflict) => void) | undefined
  private readonly onErrorCb: ((message: string) => void) | undefined
  private readonly maxUndo: number
  private readonly schemaResolverFor: ((doc: WorkflowDocument) => SchemaResolver) | undefined
  private rebasing = false
  private readonly snapshotPolicy: SnapshotPublicationPolicy

  private confirmed: WorkflowDocument
  private confirmedRevision: number
  private revisionOffset = 0
  private store: DocumentStore
  private readonly pending: PendingEntry[] = []
  private readonly undoStack: HistoryRecord[] = []
  private readonly redoStack: HistoryRecord[] = []

  private readonly docSignal: Signal<WorkflowDocument>
  private readonly statusSignal: Signal<SharedSessionStatus>
  private readonly opListeners = new Set<(op: SessionOp) => void>()
  private readonly presenceListeners = new Set<(actorId: string, payload?: Json) => void>()
  /**
   * Undefined only during construction: the connection replays buffered
   * pre-subscription events synchronously inside onEvent, so a replayed
   * session_closed can reach close() before the assignment lands.
   */
  private unsubscribe: (() => void) | undefined

  private opCounter = 0
  /**
   * Per-instance nonce embedded in every opId: the same actorId rejoining
   * the same session in a fresh SharedDocumentSession must never collide
   * with its previous incarnation's opIds in the server's idempotency
   * window.
   */
  private readonly opNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`
  private pumpPromise: Promise<void> | undefined
  /** True while the sync loop (catch-up / resync) is running. */
  private syncing = false
  /**
   * Monotonic server head this session must reach before the sync loop may
   * rest. Raised synchronously by WS gaps, reconnect descriptors, and 409
   * stale-base responses - even while a sync pass is mid-flight - so no
   * announcement of a newer head can ever be lost.
   */
  private syncTarget = 0
  /**
   * A divergence demands a snapshot resync. Consumed at the START of the
   * snapshot fetch: a fresh divergence during the fetch re-raises it and
   * the loop takes another pass.
   */
  private resyncRequested = false
  /** A descriptor has established that the WS is currently usable. */
  private connected = false
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined
  private snapshotTimerDue = 0
  private snapshotPublishPromise: Promise<'ok' | 'conflict' | 'error'> | undefined

  constructor(
    connection: CollabConnection,
    snapshot: WorkflowDocument,
    snapshotRevision: number,
    commands: ReadonlyMap<string, CommandDefinition>,
    options?: SharedSessionOptions,
  ) {
    this.connection = connection
    this.actorId = options?.actorId ?? defaultActorId()
    this.clock = options?.clock ?? Date.now
    this.retryDelay = options?.retryDelay ?? (() => new Promise((r) => setTimeout(r, 1000)))
    this.sink =
      options?.onListenerError ??
      ((error, context) => {
        // eslint-disable-next-line no-console
        console.error(`[SharedDocumentSession] ${context}:`, error)
      })
    this.onConflict = options?.onConflict
    this.onErrorCb = options?.onError
    this.maxUndo = options?.maxUndo ?? 200
    this.schemaResolverFor = options?.schemaResolverFor
    this.snapshotPolicy = new SnapshotPublicationPolicy(
      snapshotRevision,
      this.clock(),
      options?.snapshotRandom,
    )
    // Private registry: session.patch is reserved for the session itself.
    const map = new Map(commands)
    map.set(sessionPatchCommand.id, sessionPatchCommand)
    this.commands = map

    this.confirmed = snapshot
    this.confirmedRevision = snapshotRevision
    // Inner store = optimistic document authority. Its own history is
    // disabled (0): the session keeps history itself so it survives
    // rebases as forward-op intentions, per the undo-as-forward-op pin.
    this.store = this.createStore(this.confirmed)
    this.docSignal = createSignal<WorkflowDocument>(this.store.doc)
    this.statusSignal = createSignal<SharedSessionStatus>('live')
    this.status = this.statusSignal
    this.unsubscribe = connection.onEvent((event) => this.handleEvent(event))
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') {
      // A buffered session_closed (or fatal error) replayed synchronously
      // during subscription: close() already ran, but the unsubscribe was
      // assigned too late for it to see - detach now so no listener leaks.
      const unsubscribe = this.unsubscribe
      this.unsubscribe = undefined
      unsubscribe()
    }
  }

  // -- DocumentSession surface ----------------------------------------------

  get doc(): WorkflowDocument {
    return this.store.doc
  }

  /** Monotonic document revision across local/shared session handoffs. */
  get revision(): number {
    return this.revisionOffset + this.confirmedRevision + this.pending.length
  }

  get document(): ReadonlySignal<WorkflowDocument> {
    return this.docSignal
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  predictedNodeId(graphId: string): string | undefined {
    const def = this.store.doc.graphs[graphId]
    return def === undefined ? undefined : predictAllocatedId(def, this.actorId, 'n')
  }

  predictedRerouteId(graphId: string): string | undefined {
    const def = this.store.doc.graphs[graphId]
    return def === undefined ? undefined : predictAllocatedId(def, this.actorId, 'r')
  }

  dispatch(invocation: CommandInvocation): CommandOutcome {
    if (invocation.command === sessionPatchCommand.id) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'command', 'command.reserved', `'${sessionPatchCommand.id}' is session-internal`),
        ],
      }
    }
    const outcome = this.run(invocation)
    if (outcome.ok && outcome.forward.length > 0) {
      const record: HistoryRecord = { forward: outcome.forward, inverse: outcome.inverse }
      // run() just pushed this intention's pending entry (synchronous,
      // deferred pump - nothing can interleave): tie the record to it so
      // rebases keep history and pending coherent.
      this.pending[this.pending.length - 1]!.record = record
      this.undoStack.push(record)
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
      this.redoStack.length = 0
    }
    return outcome
  }

  undo(): boolean {
    return this.replayHistory(this.undoStack, this.redoStack, 'undo')
  }

  redo(): boolean {
    return this.replayHistory(this.redoStack, this.undoStack, 'redo')
  }

  clearHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  historySnapshot(): HistorySnapshot {
    const detach = (records: readonly HistoryRecord[]): HistorySnapshot['undo'] =>
      records.map((record) => ({ forward: record.forward, inverse: record.inverse }))
    return { revision: this.revision, undo: detach(this.undoStack), redo: detach(this.redoStack) }
  }

  /**
   * Seed history from a predecessor session over the same document. Valid
   * only while this session is pristine (nothing dispatched, no history):
   * the records' patches were computed against the predecessor's document,
   * so the caller must have verified this session's document is identical
   * before adopting. Adopted records behave exactly like acked local ones -
   * replay goes through the recorded-value conflict guards, and a resync
   * still drops them with the rest of the history.
   */
  adoptHistory(history: HistorySnapshot): void {
    if (this.pending.length > 0 || this.undoStack.length > 0 || this.redoStack.length > 0) {
      throw new Error('adoptHistory: session already has local intentions or history')
    }
    this.revisionOffset = Math.max(0, history.revision - this.confirmedRevision)
    for (const record of history.undo) this.undoStack.push({ forward: record.forward, inverse: record.inverse })
    for (const record of history.redo) this.redoStack.push({ forward: record.forward, inverse: record.inverse })
    while (this.undoStack.length > this.maxUndo) this.undoStack.shift()
    while (this.redoStack.length > this.maxUndo) this.redoStack.shift()
  }

  onOp(listener: (op: SessionOp) => void): () => void {
    this.opListeners.add(listener)
    return () => this.opListeners.delete(listener)
  }

  // -- Shared-mode surface ---------------------------------------------------

  onPresence(listener: (actorId: string, payload?: Json) => void): () => void {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }

  sendPresence(payload: Json): void {
    this.connection.sendPresence(payload)
  }

  private submissionDenial: Extract<PostOpOutcome, { diagnostic: unknown }>['diagnostic'] | undefined

  private throwIfDenied(): void {
    const diagnostic = this.submissionDenial ?? this.connection.denial
    if (diagnostic === undefined) return
    this.submissionDenial = diagnostic
    this.fail(JSON.stringify(diagnostic))
    throw Object.assign(new Error(JSON.stringify(diagnostic)), { diagnostic })
  }

  /** Resolves when submission is quiescent; rejects a definitive refusal. */
  async settle(): Promise<void> {
    this.throwIfDenied()
    while (this.pumpPromise) await this.pumpPromise
    this.throwIfDenied()
  }

  close(): void {
    // Take-and-clear so repeated closes are idempotent and a close that runs
    // DURING construction (a synchronously-replayed buffered session_closed,
    // before the constructor assigns the field) leaves the constructor to
    // detach the late-assigned unsubscribe itself.
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
    this.cancelSnapshotTimer()
    if (this.snapshotPolicy.shouldFlushOnClose(this.clock(), this.connected)) {
      // The confirmed document is synchronously available and contains no
      // optimistic pending intentions. Fire once before closing transport;
      // close itself is never delayed by checkpoint I/O.
      void this.publishSnapshot('close')
    }
    this.connection.close()
    this.connected = false
    this.statusSignal.set('closed')
  }

  // -- Local execution -------------------------------------------------------

  /**
   * Execute an intention optimistically and enqueue it for submission.
   * Shared sessions stamp their actorId on EVERY invocation (contract.ts):
   * that is what routes id allocation to this actor's disjoint cursors.
   */
  private run(invocation: CommandInvocation, origin?: string): CommandOutcome {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') {
      return {
        ok: false,
        diagnostics: [diag('error', 'command', 'session.unavailable', `session is ${status}`)],
      }
    }
    const owned = ownJson({ ...invocation, actor: this.actorId } as unknown as Json, { undefinedProps: 'reject' })
    if (!owned.ok) return { ok: false, diagnostics: [diag('error', 'command', 'command.params.notJson', `${invocation.command}: params are not JSON: ${owned.reason}`)] }
    let stamped = owned.value as unknown as CommandInvocation
    const definition = this.commands.get(stamped.command)
    if (definition?.prepareForSharedReplay !== undefined) {
      let prepared: SharedReplayPreparation | undefined
      try {
        prepared = definition.prepareForSharedReplay(
          this.store.doc,
          stamped.params,
          {
            kind: 'initial',
            ...(this.schemaResolverFor !== undefined ? { schemaResolverFor: this.schemaResolverFor } : {}),
          },
          stamped.actor,
        )
      } catch (error) {
        return {
          ok: false,
          diagnostics: [diag(
            'error',
            'command',
            'command.threw',
            `${stamped.command}: ${error instanceof Error ? error.message : String(error)}`,
          )],
        }
      }
      if (prepared !== undefined && !prepared.ok) {
        return { ok: false, diagnostics: prepared.diagnostics }
      }
      if (prepared !== undefined) {
        const ownedPrepared = ownJson(prepared.params, { undefinedProps: 'reject' })
        if (!ownedPrepared.ok) {
          return {
            ok: false,
            diagnostics: [diag(
              'error',
              'command',
              'command.params.notJson',
              `${stamped.command}: prepared params are not JSON: ${ownedPrepared.reason}`,
            )],
          }
        }
        stamped = Object.freeze({ ...stamped, params: ownedPrepared.value })
      }
    }
    const outcome = this.store.dispatch(stamped)
    if (outcome.ok && outcome.forward.length > 0) {
      this.pending.push({
        opId: this.mintOpId(),
        invocation: stamped,
        origin: origin ?? stamped.command,
        predicted: toWirePatch(outcome.forward),
        attempts: [],
      })
      this.docSignal.set(this.store.doc)
      this.pump()
    }
    return outcome
  }

  private replayHistory(from: HistoryRecord[], to: HistoryRecord[], during: 'undo' | 'redo'): boolean {
    const record = from.pop()
    if (!record) return false
    const patch = during === 'undo' ? record.inverse : record.forward
    // CO3: clamp cursor rewinds exactly like DocumentStore history replay -
    // undoing an add removes the node but never rewinds nextOrdinal/seq or
    // actorCursors, so ids are never reused. requireRecordedValues is the
    // shared-mode conflict guard: a record replays only where the document
    // still holds the values it captured, so undo can never overwrite a
    // foreign actor's edit with our stale recording. replayHistoryOps
    // throws when the record's paths no longer fit the (possibly rebased)
    // document; both failure shapes drop the record as a conflict.
    let applied: readonly PatchOp[]
    try {
      const replay = replayHistoryOps(this.store.doc, patch, { requireRecordedValues: true })
      if (replay.stale) {
        this.notifyConflict({
          invocation: { command: sessionPatchCommand.id, params: null, actor: this.actorId },
          diagnostics: [
            diag(
              'error',
              'command',
              'session.history.stale',
              `${during} conflicts with a concurrent edit at ${replay.stale.path.join('/')}`,
            ),
          ],
          during,
        })
        return false
      }
      applied = replay.applied
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.notifyConflict({
        invocation: { command: sessionPatchCommand.id, params: null, actor: this.actorId },
        diagnostics: [diag('error', 'command', 'session.history.stale', `${during} no longer applies: ${message}`)],
        during,
      })
      return false
    }
    if (applied.length === 0) {
      // Everything clamped away (pure cursor record): nothing to commit,
      // but the record still moves so redo/undo stays symmetric.
      to.push(record)
      return true
    }
    const invocation: CommandInvocation = {
      command: sessionPatchCommand.id,
      params: { ops: toWirePatch(applied) as unknown as Json },
      actor: this.actorId,
    }
    const outcome = this.run(invocation, `session.${during}`)
    if (!outcome.ok) {
      // The record's paths no longer fit (a rebase moved the ground). Drop
      // it - forcing a stale patch would corrupt; the conflict is surfaced.
      this.notifyConflict({ invocation, diagnostics: outcome.diagnostics, during })
      return false
    }
    // Tie the moved record to the replay's pending entry: if a rebase
    // re-executes or drops this replay, the record must follow (see rebase).
    if (outcome.forward.length > 0) this.pending[this.pending.length - 1]!.record = record
    to.push(record)
    return true
  }

  private mintOpId(): string {
    this.opCounter += 1
    return `${this.actorId}#${this.opNonce}#${this.opCounter}`
  }

  // -- Submission ------------------------------------------------------------

  private pump(): void {
    if (this.pumpPromise) return
    // Deferred start: pumpLoop's synchronous prefix may reach transport code
    // that synchronously emits WS events, which re-enter pump() - the
    // single-flight promise must be installed before any of that runs.
    this.pumpPromise = Promise.resolve()
      .then(() => this.pumpLoop())
      .finally(() => {
        this.pumpPromise = undefined
        // Lost-wakeup guard: a pump() call that raced this finalizer saw the
        // old promise and returned. Every loop exit path with work left is
        // gated (sync loop running, terminal status), so this cannot spin.
        if (this.pending.length > 0 && this.statusSignal.get() === 'live' && !this.syncing) {
          this.pump()
        }
      })
  }

  private async pumpLoop(): Promise<void> {
    while (this.pending.length > 0 && this.statusSignal.get() === 'live' && !this.syncing) {
      const head = this.pending[0]!
      const submittedOpId = head.opId
      const submittedBase = this.confirmedRevision
      const submittedPatch = head.predicted // a rebase may rewrite the head mid-flight
      // Remember what actually goes on the wire: if a resync remints this
      // intention while the POST's fate is unknown, ordered ingress needs
      // this identity to recognize the commit (see PendingEntry.attempts).
      if (head.attempts.length === 0 || head.attempts[head.attempts.length - 1]!.opId !== submittedOpId) {
        head.attempts.push({ opId: submittedOpId, baseRevision: submittedBase, patch: submittedPatch })
      }
      let outcome: PostOpOutcome
      try {
        outcome = await this.connection.postOp({
          protocolVersion: COLLAB_PROTOCOL_VERSION,
          opId: submittedOpId,
          actorId: this.actorId,
          baseRevision: submittedBase,
          patch: head.predicted,
        })
      } catch (e) {
        outcome = { kind: 'error', message: e instanceof Error ? e.message : String(e) }
      }
      if (this.statusSignal.get() !== 'live') break // closed/failed during the await
      if (outcome.kind === 'accepted') {
        // The response is server input like any other: full envelope
        // validation, then the SAME ordered-ingress path the WS uses -
        // which enforces contiguity, opId/patch equality with the pending
        // head, and the invariant gate.
        const invalid = validateCollabServerOp(outcome.op)
        if (invalid !== null) {
          this.requestResync(`accepted: ${invalid}`)
          break
        }
        if (outcome.op.revision <= this.confirmedRevision) continue // WS ack won the race
        // The response must be EXACTLY the request: same actor, id, base,
        // and patch. A response that differs (a tampered or transforming
        // server) must never be trusted into confirmed state - and never
        // adopted as "historical" foreign state either, which is what a
        // bare opId check would allow after a mid-flight remint.
        if (
          outcome.op.actorId !== this.actorId ||
          outcome.op.opId !== submittedOpId ||
          outcome.op.baseRevision !== submittedBase ||
          !jsonSameValue(outcome.op.patch as unknown as Json, submittedPatch as unknown as Json)
        ) {
          // The server claims a committed revision this client has not
          // confirmed: whatever really occupies it must still be reached.
          if (outcome.op.revision > this.syncTarget) this.syncTarget = outcome.op.revision
          this.requestResync('accepted op is not the submitted op')
          break
        }
        // Server input like any other: the SAME ordered ingress the WS uses
        // (contiguity, pending-head equality, invariant gate; a gap repairs
        // via catch-up rather than a destructive snapshot resync).
        this.handleServerOp(outcome.op)
        if (this.syncing || this.statusSignal.get() !== 'live') break
        continue
      }
      if (outcome.kind === 'stale-base') {
        if (this.confirmedRevision > submittedBase) continue // already caught up
        // The server is ahead: fetch the winning ops NOW rather than trust
        // the WS to deliver them (its copy may have been dropped). The 409's
        // revision is the announced head - the sync loop must reach it.
        this.requestCatchUp(outcome.revision)
        break // sync raises `syncing` synchronously; resumes via its finally
      }
      if (outcome.kind === 'snapshot-required') {
        const put = await this.publishSnapshot('required')
        if (put !== 'ok') await this.retryDelay()
        continue
      }
      if (outcome.kind === 'protocol-unsupported') {
        this.fail(`protocol version ${COLLAB_PROTOCOL_VERSION} unsupported (server supports ${outcome.supported.join(', ')})`)
        break
      }
      if ('diagnostic' in outcome) {
        this.submissionDenial = outcome.diagnostic
        this.fail(JSON.stringify(outcome.diagnostic))
        break
      }
      // Transport error: idempotent retry with the SAME opId.
      await this.retryDelay()
    }
  }

  // -- Server-ordered ingress -------------------------------------------------

  private handleEvent(event: CollabConnectionEvent): void {
    const status = this.statusSignal.get()
    // A terminal session ignores the transport entirely: nothing may revive
    // an errored session, and a closed one owns no state to update.
    if (status === 'closed' || status === 'error') return
    switch (event.kind) {
      case 'op': {
        const invalid = validateCollabServerOp(event.op)
        if (invalid !== null) {
          // The server (or transport parse) sent garbage: never adopt any of
          // it - resynchronize from an authoritative snapshot instead.
          this.requestResync(invalid)
          break
        }
        this.handleServerOp(event.op)
        break
      }
      case 'presence':
        if (!isValidActorId(event.actorId)) {
          this.safeSink(new Error('presence: invalid actorId'), 'presence notify')
          break
        }
        for (const l of [...this.presenceListeners]) {
          try {
            l(event.actorId, event.payload)
          } catch (e) {
            this.safeSink(e, 'presence notify')
          }
        }
        break
      case 'connected': {
        const invalid = validateCollabDescriptor(event.descriptor, this.connection.sessionId, 'workflow')
        if (invalid !== null) {
          // Protocol mismatch is the pinned loud refusal, never negotiation.
          this.fail(invalid)
          break
        }
        this.connected = true
        this.snapshotPolicy.observeSnapshot(event.descriptor.snapshotRevision, this.clock())
        // Descriptor revision is the WS replay baseline: everything after it
        // streams gap-free, everything up to it must be fetched. The target
        // is raised even when a sync pass is mid-flight - its current page
        // may predate this baseline.
        if (event.descriptor.revision > this.confirmedRevision) {
          this.requestCatchUp(event.descriptor.revision)
        }
        this.considerSnapshotPublication()
        break
      }
      case 'disconnected':
        // Reconnection is the transport's job; catch-up happens on 'connected'.
        this.connected = false
        this.cancelSnapshotTimer()
        break
      case 'session-closed':
        // DELETE removes the backend session before broadcasting this frame;
        // suppress the local-disposal flush, which could only PUT to a 404.
        this.connected = false
        this.close()
        break
    }
  }

  private handleServerOp(op: CollabServerOp): void {
    if (op.revision <= this.confirmedRevision) return // duplicate/echo
    if (op.revision > this.confirmedRevision + 1) {
      // Gap (reconnect window / mid-sync append): repair via HTTP. The op's
      // revision announces a server head the sync loop must reach - raising
      // the target mid-pass makes an active loop fetch again.
      this.requestCatchUp(op.revision)
      return
    }
    const failure = this.ingestOrdered(op)
    if (failure !== null) {
      // The op is validated and contiguous: its revision is a real server
      // head the resync must reach even if the checkpoint sits behind it.
      if (op.revision > this.syncTarget) this.syncTarget = op.revision
      this.requestResync(failure)
      return
    }
    this.pump()
  }

  /**
   * The ONE ordered-ingress path: every server op - WS delivery, catch-up
   * page, or HTTP acceptance - commits through here. Enforces contiguity
   * (exactly confirmedRevision + 1), own-op equality with the pending head,
   * and the document invariant gate. Returns null on success, or the
   * divergence reason when the caller must request a resync - never resyncs
   * itself, because the right entry point differs per caller.
   */
  private ingestOrdered(op: CollabServerOp): string | null {
    if (op.revision !== this.confirmedRevision + 1) {
      return `ordered ingress: revision ${op.revision} at confirmed ${this.confirmedRevision}`
    }
    if (op.actorId === this.actorId) {
      // Ack only what is EXACTLY the pending head: same opId, same patch.
      const head = this.pending[0]
      if (head !== undefined && head.opId === op.opId) {
        if (jsonSameValue(op.patch as unknown as Json, head.predicted as unknown as Json)) {
          return this.ack(op)
        }
        // Same opId, different patch: the server committed something we did
        // not submit under our id. Never trust it into confirmed state.
        return 'own op patch mismatch'
      }
      // A previously SUBMITTED attempt of a still-pending intention: a
      // resync rebase reminted its live opId while the POST's fate was
      // unknown, and the server DID commit the original. This is that
      // intention's confirmation - adopting it as external and then
      // resubmitting would duplicate a non-idempotent command.
      const idx = this.pending.findIndex((e) => e.attempts.some((a) => a.opId === op.opId))
      if (idx !== -1) {
        const attempt = this.pending[idx]!.attempts.find((a) => a.opId === op.opId)!
        if (
          op.baseRevision !== attempt.baseRevision ||
          !jsonSameValue(op.patch as unknown as Json, attempt.patch as unknown as Json)
        ) {
          // The server committed something under our id that we never sent.
          return 'own op patch mismatch'
        }
        return this.confirmPending(idx, op)
      }
      // An own op this incarnation no longer claims (previous incarnation's
      // tail after a reconnect, or bookkeeping lost to a resync). The
      // server-ordered log is authoritative and this op is already history:
      // adopt it like any external edit and rebase pending over it. NEVER
      // report it as divergence - a resync cannot remove it from the log,
      // so that would loop forever.
      this.safeSink(new Error(`own op ${op.opId} adopted as external (not the pending head)`), 'own op adopt')
      return this.applyForeign(op)
    }
    return this.applyForeign(op)
  }

  /** Head pending op accepted: confirmed catches up to what optimistic already shows. */
  private ack(op: CollabServerOp): string | null {
    let next: WorkflowDocument
    try {
      // With no later optimistic intentions, exact patch equality above
      // proves the already validated optimistic document is this commit.
      // Reusing it avoids a second full-document invariant scan per local
      // command. Later pending intentions require the confirmed-only apply.
      if (this.pending.length === 1) {
        next = this.store.doc
      } else {
        next = applyOps(this.confirmed as unknown as Json, op.patch) as unknown as WorkflowDocument
        const diags = checkDocument(next)
        if (hasErrors(diags)) throw new Error(diags.find((d) => d.severity === 'error')!.message)
      }
    } catch (e) {
      return `ack rejected: ${e instanceof Error ? e.message : String(e)}`
    }
    this.confirmed = next
    this.confirmedRevision = op.revision
    this.snapshotPolicy.observeConfirmed(op.revision)
    const entry = this.pending.shift()
    this.emitOp(op, entry?.origin ?? op.opId)
    this.considerSnapshotPublication()
    return null
  }

  /**
   * A pending intention confirmed under an OLD attempt's identity (its live
   * opId was reminted by a resync while the POST was ambiguous). The
   * committed form may differ from the latest re-execution, so unlike ack()
   * the optimistic document cannot be assumed current: apply the committed
   * patch to confirmed, retire the intention, and rebuild the rest. Its
   * history record reflects the re-executed - not the committed - patches,
   * so it is conservatively dropped rather than trusted.
   */
  private confirmPending(idx: number, op: CollabServerOp): string | null {
    const oldGround = this.confirmed
    let next: WorkflowDocument
    try {
      next = applyOps(this.confirmed as unknown as Json, op.patch) as unknown as WorkflowDocument
      const diags = checkDocument(next)
      if (hasErrors(diags)) throw new Error(diags.find((d) => d.severity === 'error')!.message)
    } catch (e) {
      return `confirmed attempt rejected: ${e instanceof Error ? e.message : String(e)}`
    }
    this.confirmed = next
    this.confirmedRevision = op.revision
    this.snapshotPolicy.observeConfirmed(op.revision)
    const entry = this.pending[idx]!
    if (entry.record) this.removeRecord(entry.record)
    this.rebase(oldGround, new Set([entry]))
    this.emitOp(op, entry.origin)
    this.considerSnapshotPublication()
    return null
  }

  private applyForeign(op: CollabServerOp): string | null {
    const oldGround = this.confirmed
    let next: WorkflowDocument
    try {
      next = applyOps(this.confirmed as unknown as Json, op.patch) as unknown as WorkflowDocument
      const diags = checkDocument(next)
      if (hasErrors(diags)) throw new Error(diags.find((d) => d.severity === 'error')!.message)
    } catch (e) {
      return `foreign op rejected: ${e instanceof Error ? e.message : String(e)}`
    }
    this.confirmed = next
    this.confirmedRevision = op.revision
    this.snapshotPolicy.observeConfirmed(op.revision)
    // Rebase FIRST, emit after: listeners must never observe a server
    // revision the optimistic document does not contain yet.
    this.rebase(oldGround)
    this.emitOp(op, 'remote')
    this.considerSnapshotPublication()
    return null
  }

  /**
   * Rebuild the optimistic document: fresh store from confirmed, re-execute
   * every pending intention in order. Each survivor gets a fresh opId (its
   * patch may have changed - actor-scoped ids keep re-minting safe) and its
   * history record is REWRITTEN with the re-executed forward/inverse; each
   * casualty is dropped WITH its record (a stale record could undo foreign
   * state) and a conflict notification.
   *
   * Reentrancy: the queue is detached before rebuilding, the new state is
   * published before any callback fires, and conflict notifications are
   * fenced - a dispatching or throwing onConflict sees (and cannot corrupt)
   * a fully consistent session.
   */
  private rebase(oldGround: WorkflowDocument, skipped: ReadonlySet<PendingEntry> = new Set()): void {
    const entries = this.pending.splice(0)
    const survivors: PendingEntry[] = []
    const conflicts: SessionConflict[] = []
    let oldDocCursor: WorkflowDocument | undefined = oldGround
    this.rebasing = true
    try {
      this.store = this.createStore(this.confirmed)
      for (const entry of entries) {
        const oldPredicted = entry.predicted
        if (!skipped.has(entry)) {
          const definition = this.commands.get(entry.invocation.command)
          if (oldDocCursor && definition?.transformForRebase) {
            const params = definition.transformForRebase(
              entry.invocation.params,
              oldDocCursor,
              this.store.doc,
            )
            if (params !== undefined) entry.invocation = { ...entry.invocation, params }
          }
          const outcome = this.store.dispatch(entry.invocation)
          if (outcome.ok && outcome.forward.length > 0) {
            if (entry.record) {
              // The intention re-executed against new ground: its recorded
              // patches are stale. An undo/redo replay entry's record lives
              // MIRRORED (undo applied record.inverse, so the record's forward
              // must revert what re-execution now did, and vice versa).
              if (entry.origin === 'session.undo') {
                entry.record.forward = outcome.inverse
                entry.record.inverse = outcome.forward
              } else {
                entry.record.forward = outcome.forward
                entry.record.inverse = outcome.inverse
              }
            }
            survivors.push({
              opId: this.mintOpId(),
              invocation: entry.invocation,
              origin: entry.origin,
              predicted: toWirePatch(outcome.forward),
              // Submitted history survives the remint, minus conclusively dead
              // attempts: exact-base acceptance means an attempt whose slot
              // (base+1) was observed occupied by something else can never
              // commit. Ordered ingress observed every slot up to
              // confirmedRevision individually here (snapshot-ambiguous
              // entries are skipped rather than retained as survivors).
              attempts: entry.attempts.filter((a) => a.baseRevision >= this.confirmedRevision),
              record: entry.record,
            })
          } else {
            // Dropped (conflict) or dissolved into a no-op: either way the
            // intention will never be confirmed, so its history record must go.
            if (entry.record) this.removeRecord(entry.record)
            if (!outcome.ok) {
              conflicts.push({ invocation: entry.invocation, diagnostics: outcome.diagnostics, during: 'rebase' })
            }
          }
        }
        // Later params include earlier intentions in their old coordinate
        // space, while the rebuilt store includes those intentions transformed.
        if (oldDocCursor) {
          try {
            oldDocCursor = applyOps(
              oldDocCursor as unknown as Json,
              oldPredicted,
            ) as unknown as WorkflowDocument
          } catch {
            oldDocCursor = undefined
          }
        }
      }
    } finally {
      this.rebasing = false
    }
    this.pending.push(...survivors)
    this.docSignal.set(this.store.doc)
    for (const conflict of conflicts) this.notifyConflict(conflict)
  }

  private createStore(doc: WorkflowDocument): DocumentStore {
    return new DocumentStore(doc, this.commands, 0, this.sink, () =>
      this.rebasing
        ? ({ kind: 'shared-replay' })
        : ({ kind: 'initial', ...(this.schemaResolverFor ? { schemaResolverFor: this.schemaResolverFor } : {}) }),
    )
  }

  // -- Sync loop (catch-up / resync) --------------------------------------------

  /**
   * Raise the sync target to a server-announced head and ensure the sync
   * loop is running. Safe to call at ANY time, including mid-pass: the
   * target is monotonic and re-checked every iteration.
   */
  private requestCatchUp(target: number): void {
    if (target > this.syncTarget) this.syncTarget = target
    this.startSync()
  }

  /**
   * Request a snapshot resync (divergence, malformed server data, 410
   * retention floor). Queued via a flag so a request raised mid-pass is
   * honored by the running loop instead of being lost.
   */
  private requestResync(reason: string): void {
    this.safeSink(new Error(reason), 'resync')
    this.resyncRequested = true
    this.startSync()
  }

  private startSync(): void {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') return
    if (this.syncing) return
    this.syncing = true
    this.statusSignal.set('catching-up')
    void this.syncLoop()
      .catch((e) => {
        this.fail(`sync failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        this.syncing = false
        if (this.statusSignal.get() === 'catching-up') this.statusSignal.set('live')
        // Lost-wakeup guard: a request that raced the loop's exit check saw
        // `syncing` still true and returned. Re-enter rather than strand it.
        if (
          this.statusSignal.get() === 'live' &&
          (this.resyncRequested || this.confirmedRevision < this.syncTarget)
        ) {
          this.startSync()
          return
        }
        this.pump()
        this.considerSnapshotPublication()
      })
  }

  /**
   * Run until the session has reached every announced server head and no
   * resync is pending. Status is re-checked after every await: a session
   * closed or failed mid-flight must not mutate state afterwards.
   */
  private async syncLoop(): Promise<void> {
    while (true) {
      if (this.statusSignal.get() !== 'catching-up') return // terminal mid-pass
      if (this.resyncRequested) {
        // Consume BEFORE the fetch: a divergence discovered during it is a
        // NEW request and earns another pass; everything before the fresh
        // snapshot is superseded by it.
        this.resyncRequested = false
        const snap = await this.connection.fetchSnapshot()
        if (this.statusSignal.get() !== 'catching-up') return
        if (!isValidCollabRevision(snap.revision)) {
          this.fail('resync snapshot: invalid revision')
          return
        }
        const loaded = loadDocument(snap.document)
        if (!loaded.document) {
          this.fail('resync snapshot failed to load')
          return
        }
        // A checkpoint snapshot may sit BEHIND state this client already
        // confirmed (ordered commits never raise syncTarget). Preserve the
        // high-water mark BEFORE adopting, or the loop would rest below a
        // head it has provably seen.
        this.syncTarget = Math.max(this.syncTarget, this.confirmedRevision, snap.revision)
        const oldGround = this.confirmed
        this.confirmed = loaded.document
        this.confirmedRevision = snap.revision
        this.snapshotPolicy.observeConfirmed(snap.revision)
        this.snapshotPolicy.observeSnapshot(snap.revision, this.clock())
        // History records were computed against pre-resync documents; they
        // can only misapply now. Pending intentions re-execute (they are
        // intentions, not patches); history is conservatively dropped.
        this.undoStack.length = 0
        this.redoStack.length = 0
        // A submitted attempt whose acceptance slot (base+1) falls AT or
        // BEFORE this snapshot may have committed INSIDE it - compaction
        // erased the op identity, so neither confirmation nor failure can
        // ever be observed. Re-executing would risk duplicating a
        // non-idempotent command: drop the intention and surface the
        // ambiguity as a conflict instead.
        const ambiguous: PendingEntry[] = []
        for (const entry of this.pending) {
          if (entry.attempts.some((a) => a.baseRevision < snap.revision)) {
            if (entry.record) this.removeRecord(entry.record)
            ambiguous.push(entry)
          }
        }
        this.rebase(oldGround, new Set(ambiguous))
        for (const entry of ambiguous) {
          this.notifyConflict({
            invocation: entry.invocation,
            diagnostics: [
              diag(
                'error',
                'command',
                'session.delivery-ambiguous',
                'a resync checkpoint may already contain this submitted change; dropped rather than risk applying it twice',
              ),
            ],
            during: 'rebase',
          })
        }
        continue // a checkpoint snapshot may sit BEHIND the head: fetch the tail
      }
      if (this.confirmedRevision >= this.syncTarget) return
      const page = await this.connection.fetchOps(this.confirmedRevision)
      if (this.statusSignal.get() !== 'catching-up') return
      if (this.resyncRequested) continue // divergence during the fetch wins
      if (page.kind === 'resync-required') {
        this.resyncRequested = true
        continue
      }
      let progressed = false
      for (const op of page.ops) {
        if (this.statusSignal.get() !== 'catching-up') return
        const invalid = validateCollabServerOp(op)
        if (invalid !== null) {
          this.safeSink(new Error(invalid), 'resync')
          this.resyncRequested = true
          break
        }
        if (op.revision <= this.confirmedRevision) continue // WS applied it first
        const failure = this.ingestOrdered(op)
        if (failure !== null) {
          if (op.revision > this.syncTarget) this.syncTarget = op.revision
          this.safeSink(new Error(failure), 'resync')
          this.resyncRequested = true
          break
        }
        progressed = true
      }
      if (!progressed && !this.resyncRequested && this.confirmedRevision < this.syncTarget) {
        // The server announced a head it has not served yet (or the page
        // raced the append). Back off instead of hot-looping.
        await this.retryDelay()
      }
    }
  }

  private fail(message: string): void {
    // Terminal states are final: a rejection from a fetch torn down by
    // close() must not flip a `closed` session to `error`.
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') return
    this.statusSignal.set('error')
    this.connected = false
    this.cancelSnapshotTimer()
    try {
      this.onErrorCb?.(message)
    } catch (e) {
      this.safeSink(e, 'error notify')
    }
    this.safeSink(new Error(message), 'session error')
  }

  // -- Snapshot checkpoint publication --------------------------------------

  private considerSnapshotPublication(): void {
    if (this.statusSignal.get() !== 'live') return
    const decision = this.snapshotPolicy.decide(this.clock(), this.connected)
    if (decision.kind === 'none') {
      this.cancelSnapshotTimer()
      return
    }
    if (decision.kind === 'wait') {
      this.scheduleSnapshotDecision(decision)
      return
    }
    this.cancelSnapshotTimer()
    void this.publishSnapshot('periodic')
  }

  private scheduleSnapshotDecision(
    decision: Extract<SnapshotPublicationDecision, { kind: 'wait' }>,
  ): void {
    const due = this.clock() + decision.delayMs
    if (this.snapshotTimer !== undefined && this.snapshotTimerDue === due) return
    this.cancelSnapshotTimer()
    this.snapshotTimerDue = due
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined
      this.snapshotTimerDue = 0
      this.considerSnapshotPublication()
    }, decision.delayMs)
  }

  private cancelSnapshotTimer(): void {
    if (this.snapshotTimer !== undefined) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = undefined
    this.snapshotTimerDue = 0
  }

  /**
   * Single publication door for periodic, retention-required, and close
   * checkpoints. The captured pair is always confirmedRevision + confirmed,
   * never the optimistic store document.
   */
  private publishSnapshot(reason: 'periodic' | 'required' | 'close'): Promise<'ok' | 'conflict' | 'error'> {
    if (this.snapshotPublishPromise !== undefined) return this.snapshotPublishPromise
    if (!this.snapshotPolicy.markPublishing()) return Promise.resolve('error')
    const revision = this.confirmedRevision
    const document = this.confirmed
    const folded = this.snapshotPolicy.opsSinceLastKnownSnapshot
    const publication = this.performSnapshotPublication(revision, document, folded, reason)
    this.snapshotPublishPromise = publication
    void publication.finally(() => {
      if (this.snapshotPublishPromise === publication) this.snapshotPublishPromise = undefined
      this.considerSnapshotPublication()
    })
    return publication
  }

  private async performSnapshotPublication(
    revision: number,
    document: WorkflowDocument,
    folded: number,
    reason: 'periodic' | 'required' | 'close',
  ): Promise<'ok' | 'conflict' | 'error'> {
    try {
      const put = await this.connection.putSnapshot(revision, document)
      if (put.kind === 'ok') {
        this.snapshotPolicy.publicationSucceeded(revision, this.clock())
        // eslint-disable-next-line no-console
        console.info(
          `[SharedDocumentSession] snapshot published revision=${revision} opsFolded=${folded} reason=${reason}`,
        )
        return 'ok'
      }
      // The backend's 409 snapshot-invalid body intentionally has no
      // machine-readable revision. Resolve the winning publisher through the
      // existing GET snapshot contract, then reset counters to its revision.
      const newer = await this.connection.fetchSnapshot()
      if (!isValidCollabRevision(newer.revision)) throw new Error('snapshot conflict: invalid revision')
      if (newer.revision < revision) {
        throw new Error(
          `snapshot conflict did not advance: attempted ${revision}, server checkpoint ${newer.revision}`,
        )
      }
      this.snapshotPolicy.publicationConflicted(newer.revision, this.clock())
      // eslint-disable-next-line no-console
      console.info(
        `[SharedDocumentSession] snapshot superseded revision=${revision} newerRevision=${newer.revision}`,
      )
      return 'conflict'
    } catch (e) {
      this.snapshotPolicy.publicationFailed()
      this.safeSink(e, 'snapshot publish')
      return 'error'
    }
  }

  // -- Callback isolation ------------------------------------------------------
  // User callbacks must never unwind session state transitions: every
  // notification is fenced so a throwing observer cannot leave the session
  // mid-rebase, mid-sync, or stuck in 'catching-up'.

  private safeSink(error: unknown, context: string): void {
    try {
      this.sink(error, context)
    } catch {
      // The error sink is the last line of reporting; nowhere left to go.
    }
  }

  private notifyConflict(conflict: SessionConflict): void {
    try {
      this.onConflict?.(conflict)
    } catch (e) {
      this.safeSink(e, 'conflict notify')
    }
  }

  /** Remove a history record wherever it currently lives (undo or redo stack). */
  private removeRecord(record: HistoryRecord): void {
    const u = this.undoStack.indexOf(record)
    if (u !== -1) this.undoStack.splice(u, 1)
    const r = this.redoStack.indexOf(record)
    if (r !== -1) this.redoStack.splice(r, 1)
  }

  // -- Op feed ------------------------------------------------------------------

  private emitOp(op: CollabServerOp, origin: string): void {
    const sessionOp: SessionOp = Object.freeze({
      opId: op.opId,
      actorId: op.actorId,
      baseRevision: op.baseRevision,
      revision: op.revision,
      patch: op.patch,
      timestamp: op.timestamp,
      origin,
    })
    for (const l of [...this.opListeners]) {
      try {
        l(sessionOp)
      } catch (e) {
        this.safeSink(e, 'session op notify')
      }
    }
  }
}

export type { SharedDocumentSession }

/**
 * Join a collab session: pull the snapshot over the connection, validate it
 * through the standard document loader, and stand the session up on it. The
 * WS baseline is handled by the 'connected' event (catch-up above the
 * snapshot happens automatically).
 */
export async function connectSharedSession(
  connection: CollabConnection,
  commands: ReadonlyMap<string, CommandDefinition>,
  options?: SharedSessionOptions,
): Promise<SharedDocumentSession> {
  const snap = await connection.fetchSnapshot()
  if (!isValidCollabRevision(snap.revision)) throw new Error('collab snapshot: invalid revision')
  const loaded = loadDocument(snap.document)
  if (!loaded.document) {
    const first = loaded.diagnostics.find((d) => d.severity === 'error')
    throw new Error(`collab snapshot failed to load: ${first?.message ?? 'unknown error'}`)
  }
  return new SharedDocumentSession(connection, loaded.document, snap.revision, commands, options)
}

export {
  COLLAB_PROTOCOL_VERSION,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabDocumentKind,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type FetchOpsOutcome,
  type PostOpOutcome,
  type PutSnapshotOutcome,
} from './collab-protocol.js'
