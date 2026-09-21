/**
 * DocumentSession: the seam between document consumers and document
 * authority. All document access goes through a
 * session; no code outside a session implementation may assume
 * single-writer access to the document.
 *
 * `local` is a thin adapter over DocumentStore. The interface matches the
 * dinkster-collab v1 surface so local and shared implementations do not change
 * consumers:
 *
 * - revisions are contiguous integers (server-assigned in shared mode,
 *   the store counter locally); baseRevision/revision pairs on every op
 * - every committed change (dispatch, undo, redo) is observable as an
 *   envelope-shaped SessionOp whose forward patch is the wire payload
 * - inverse patches stay session-local for undo; they NEVER ride the wire
 * - the wire patch vocabulary is closed: add | remove | replace with
 *   segment-array paths; toWirePatch strips local-only fields (oldValue)
 * - id allocation comes from document state (nextOrdinal solo,
 *   actorCursors[actor] when the invocation carries an actor - alloc.ts);
 *   no session implementation may mint ids outside the command that runs.
 *   A shared session stamps its actorId on every invocation it dispatches
 *   so concurrent actors allocate from disjoint cursors.
 */

import type { WorkflowDocument } from '../format/document.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type { ReadonlySignal } from '../reactive/signal.js'
import type {
  CommandDefinition,
  CommandInvocation,
  CommandOutcome,
  DocumentStoreContract,
} from './contract.js'
import { predictAllocatedId } from './alloc.js'
import type { PatchOp } from './patch.js'
import { DocumentStore, type HistorySnapshot } from './store.js'

/**
 * One committed change, shaped to the collab envelope. Locally minted
 * fields (opId, actorId, timestamp) follow the same contract the server
 * enforces in shared mode: opId unique per session, actorId stable per
 * participant, revision contiguous.
 */
export interface SessionOp {
  readonly opId: string
  readonly actorId: string
  /** Document revision the op was built against (revision - 1 locally). */
  readonly baseRevision: number
  /** Document revision after the op applied. */
  readonly revision: number
  /**
   * The forward wire payload (CO4): already through toWirePatch, so local
   * oldValue can never leak onto the collab wire. Inverses stay inside the
   * store's undo stack.
   */
  readonly patch: readonly WirePatchOp[]
  readonly timestamp: number
  /**
   * Local provenance: the command behind the op ('session.undo' /
   * 'session.redo' for history replays). Never on the wire.
   */
  readonly origin: string
}

/**
 * The only sanctioned document access path. Extends the store contract
 * consumers already use (doc, revision, dispatch, undo, redo) with the
 * reactive document view and the envelope-shaped op feed.
 */
export interface DocumentSession extends DocumentStoreContract {
  /** Reactive view of the document; the UI subscribes here. */
  readonly document: ReadonlySignal<WorkflowDocument>
  readonly canUndo: boolean
  readonly canRedo: boolean
  /** Stable participant identity; 'local' outside shared mode. */
  readonly actorId: string
  /**
   * The actor whose cursor this session allocates ids from: undefined for
   * local sessions (nextOrdinal), the session's actorId in shared mode
   * (actorCursors[actor], stamped on every dispatched invocation). External
   * planners that mint ids (clipboard paste) must plan with this exact
   * value or their predicted ids diverge from what the dispatch allocates.
   */
  readonly allocationActor: string | undefined
  /** The id the next node.add on this graph will mint, if the graph exists. */
  predictedNodeId(graphId: string): string | undefined
  /** The id the next reroute.add on this graph will mint, if the graph exists. */
  predictedRerouteId(graphId: string): string | undefined
  /** Every committed change (dispatch, undo, redo) as an envelope-shaped op. */
  onOp(listener: (op: SessionOp) => void): () => void
  /**
   * Adopt the current document as the history baseline: drop local undo/redo
   * records without changing the document. History is session-LOCAL by
   * contract (inverses never ride the wire), so this stays valid in shared
   * mode - it only forgets this participant's replay records.
   */
  clearHistory(): void
  /**
   * This session's undo/redo records, oldest first, detached from session
   * internals. Like the records themselves this never rides the wire; it
   * exists so a same-document session replacement can carry the user's
   * history across the swap (the records stay valid only while the
   * successor's document is identical to this session's).
   */
  historySnapshot(): HistorySnapshot
}

/**
 * A forward patch op as the collab wire carries it (Dinkster ca01157):
 * op add|remove|replace, segment-array path, value required for
 * add/replace and ABSENT for remove. No oldValue - inverses are local.
 */
export type WirePatchOp =
  | { readonly op: 'add' | 'replace'; readonly path: PatchOp['path']; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: PatchOp['path'] }

/**
 * Strip local-only fields from forward ops for the collab wire. Ops and the
 * array are frozen: every onOp listener sees the same payload regardless of
 * what an earlier listener does.
 */
export function toWirePatch(ops: readonly PatchOp[]): readonly WirePatchOp[] {
  return Object.freeze(
    ops.map((o) =>
      Object.freeze(
        o.op === 'remove'
          ? ({ op: 'remove', path: o.path } as const)
          : ({ op: o.op, path: o.path, value: o.value } as const),
      ),
    ),
  )
}

export interface LocalSessionOptions {
  readonly actorId?: string
  /** Undo depth bound; forwarded to DocumentStore. */
  readonly maxUndo?: number
  /** Injectable clock for deterministic tests. */
  readonly clock?: () => number
  /** Observer-failure sink (CO10); forwarded to DocumentStore. */
  readonly onListenerError?: (error: unknown, context: string) => void
  readonly schemaResolverFor?: (doc: WorkflowDocument) => SchemaResolver
}

class LocalDocumentSession implements DocumentSession {
  private readonly store: DocumentStore
  private readonly listeners = new Set<(op: SessionOp) => void>()
  private opCounter = 0

  readonly actorId: string
  /** Local dispatch never stamps an actor; ids come from nextOrdinal. */
  readonly allocationActor = undefined
  private readonly clock: () => number

  constructor(
    initial: WorkflowDocument,
    commands: ReadonlyMap<string, CommandDefinition>,
    options?: LocalSessionOptions,
  ) {
    this.actorId = options?.actorId ?? 'local'
    this.clock = options?.clock ?? Date.now
    const sink = options?.onListenerError
    this.store = new DocumentStore(
      initial,
      commands,
      options?.maxUndo ?? 200,
      sink,
      () => ({ kind: 'initial', ...(options?.schemaResolverFor ? { schemaResolverFor: options.schemaResolverFor } : {}) }),
    )
    this.store.onTransaction((event) => {
      this.opCounter += 1
      const op: SessionOp = Object.freeze({
        opId: `${this.actorId}#${this.opCounter}`,
        actorId: this.actorId,
        baseRevision: event.revision - 1,
        revision: event.revision,
        // CO4: the envelope carries the WIRE shape - never raw PatchOps
        // with their local-only oldValue.
        patch: toWirePatch(event.patch),
        timestamp: this.clock(),
        origin: event.kind === 'dispatch' ? event.record.invocation.command : `session.${event.kind}`,
      })
      // CO10: op observers are isolated like every other listener.
      for (const l of [...this.listeners]) {
        try {
          l(op)
        } catch (e) {
          // The sink is injected and may itself throw; it must never
          // unwind into the already-committed transaction notify.
          try {
            if (sink) sink(e, 'session op notify')
            // eslint-disable-next-line no-console
            else console.error('[DocumentSession] op listener threw:', e)
          } catch (sinkError) {
            // eslint-disable-next-line no-console
            console.error('[DocumentSession] error sink threw:', sinkError)
          }
        }
      }
    })
  }

  get doc(): WorkflowDocument {
    return this.store.doc
  }

  get revision(): number {
    return this.store.revision
  }

  get document(): ReadonlySignal<WorkflowDocument> {
    return this.store.document
  }

  get canUndo(): boolean {
    return this.store.canUndo
  }

  get canRedo(): boolean {
    return this.store.canRedo
  }

  predictedNodeId(graphId: string): string | undefined {
    const def = this.store.doc.graphs[graphId]
    return def === undefined ? undefined : predictAllocatedId(def, undefined, 'n')
  }

  predictedRerouteId(graphId: string): string | undefined {
    const def = this.store.doc.graphs[graphId]
    return def === undefined ? undefined : predictAllocatedId(def, undefined, 'r')
  }

  dispatch(invocation: CommandInvocation): CommandOutcome {
    return this.store.dispatch(invocation)
  }

  undo(): boolean {
    return this.store.undo()
  }

  redo(): boolean {
    return this.store.redo()
  }

  clearHistory(): void {
    this.store.clearHistory()
  }

  historySnapshot(): HistorySnapshot {
    return this.store.historySnapshot()
  }

  onOp(listener: (op: SessionOp) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** The local (single-writer) DocumentSession over a fresh DocumentStore. */
export function createLocalSession(
  initial: WorkflowDocument,
  commands: ReadonlyMap<string, CommandDefinition>,
  options?: LocalSessionOptions,
): DocumentSession {
  return new LocalDocumentSession(initial, commands, options)
}
