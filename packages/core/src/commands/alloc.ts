/**
 * Graph id allocation seam (multiplayer prerequisite).
 *
 * Every command that mints graph-scoped ids allocates through here - never
 * by reading nextOrdinal directly - so solo and shared allocation stay in
 * one place:
 *
 * - Solo (tx.actor undefined): ids come from the graph-wide `nextOrdinal`
 *   cursor, format `<prefix><ordinal>`, byte-for-byte the pre-multiplayer
 *   behavior (documents, patches and predicted ids are unchanged).
 * - Shared (tx.actor set): ids come from THIS actor's cursor in
 *   `GraphDef.actorCursors`, format `<prefix><ordinal>-<actor>`. Each actor
 *   reads and writes only its own cursor key, so concurrent commands from
 *   different actors can never mint the same id - the collision the shared
 *   nextOrdinal could not prevent (both creations are valid under server
 *   ordering; only their ids would have collided).
 *
 * Cursor writes ride the same never-rewind replay machinery as nextOrdinal
 * (store.ts isAllocationCursor + the actorCursors map preserver): undo
 * never un-allocates an id.
 */

import { actorCursorOf, formatAllocatedId, guardOrdinal, type AllocatedIdPrefix } from '../ids.js'
import type { Json } from '../format/document.js'
import type { TransactionBuilder } from './contract.js'

/** The slice of GraphDef the allocator reads. */
export interface GraphOrdinalSource {
  readonly nextOrdinal: number
  readonly actorCursors?: Readonly<Record<string, number>>
}

export interface GraphAllocator {
  /** Mint one fresh id. Throws (atomic command rejection) on exhaustion. */
  mint(prefix: AllocatedIdPrefix): string
  /**
   * Record the advanced cursor on the transaction. No-op when nothing was
   * minted. Call exactly once, after all mints for this graph.
   */
  commit(): void
}

const allocationOrdinalOf = (def: GraphOrdinalSource, actor: string | undefined): number =>
  actor === undefined ? def.nextOrdinal : actorCursorOf(def.actorCursors, actor)

/** Predict the next id from the exact cursor read used by graphAllocator. */
export function predictAllocatedId(
  def: GraphOrdinalSource,
  actor: string | undefined,
  prefix: AllocatedIdPrefix,
): string {
  return formatAllocatedId(prefix, guardOrdinal(allocationOrdinalOf(def, actor)), actor)
}

/**
 * One allocator per (command, graph). Reads the cursor once at creation -
 * commands allocate against the def they validated - and writes it back
 * once at commit, exactly like the previous inline `ordinal++` blocks.
 */
export function graphAllocator(
  tx: TransactionBuilder,
  graphId: string,
  def: GraphOrdinalSource,
): GraphAllocator {
  const actor = tx.actor
  const start = allocationOrdinalOf(def, actor)
  let ordinal = start
  return {
    mint(prefix: AllocatedIdPrefix): string {
      return formatAllocatedId(prefix, guardOrdinal(ordinal++), actor)
    },
    commit(): void {
      if (ordinal === start) return
      if (actor === undefined) {
        tx.set(['graphs', graphId, 'nextOrdinal'], ordinal)
      } else if (def.actorCursors === undefined) {
        // First actor allocation on this graph: create the map in one op.
        // Replay preserves it per-key (store.ts), so an undo of this op
        // keeps every cursor at its high-water mark.
        tx.set(['graphs', graphId, 'actorCursors'], { [actor]: ordinal } as Json)
      } else {
        tx.set(['graphs', graphId, 'actorCursors', actor], ordinal)
      }
    },
  }
}

/** Convenience for the common single-id case: mint one id and commit. */
export function allocateOne(
  tx: TransactionBuilder,
  graphId: string,
  def: GraphOrdinalSource,
  prefix: AllocatedIdPrefix,
): string {
  const alloc = graphAllocator(tx, graphId, def)
  const id = alloc.mint(prefix)
  alloc.commit()
  return id
}
