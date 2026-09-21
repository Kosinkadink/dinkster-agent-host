/**
 * Execution reconciliation after a WS gap.
 *
 * Events missed while disconnected are gone from the wire, but not from the
 * server: /history records every run's terminal envelope (the exact WS
 * messages, via add_message) plus its outputs, and /queue lists what is still
 * in flight. Reconciliation replays history envelopes through the SAME
 * normalizer path live events take - one event pipeline, no parallel state
 * machine - so errors keep full tracebacks and provenance anchoring.
 *
 * For each non-terminal execution in the store:
 *  - in /history  -> replay its recorded envelopes (terminal transition with
 *                    full error detail) and hydrate outputs
 *  - in /queue    -> still live; the reconnected socket resumes its events,
 *                    and progress_state carries the full per-node state map,
 *                    so the progress gap self-heals (no single-cursor
 *                    assumption to violate)
 *  - in neither   -> lost (server restart); marked interrupted with an
 *                    `execution.lost` diagnostic
 *
 * PRECONDITION: the store must be subscribed to the connection's events
 * (connection.onEvent(store.apply)) - the standard wiring - because replay
 * flows through that subscription.
 *
 * Terminal races are safe by construction: only non-terminal executions are
 * reconciled, ExecutionStore.markLost() never downgrades a terminal state,
 * and replaying a success envelope over an already-completed run is a no-op
 * transition.
 */

import type { BackendConnection } from './connection.js'
import type { ExecutionStore } from './execution-store.js'
import { supersedable } from './reconcile-track.js'

// Every request bumps the connection's generation: an in-flight pass sees
// the bump, refuses to commit loss verdicts from its now-obsolete snapshot,
// and the trailing rerun answers against the current connection state.
export const reconcileExecutions: (
  connection: BackendConnection,
  store: ExecutionStore,
) => Promise<void> = supersedable(
  (connection: BackendConnection, isCurrent: () => boolean, store: ExecutionStore) =>
    reconcilePass(connection, store, isCurrent),
)

async function reconcilePass(
  connection: BackendConnection,
  store: ExecutionStore,
  isCurrent: () => boolean,
): Promise<void> {
  // Only THIS connection's runs: the store is shared across backends, and
  // asking backend A's /history about backend B's prompts would mark B's
  // perfectly live executions lost.
  const open = [...store.executions.get().values()].filter(
    (s) =>
      s.ref.connection === connection.id && (s.status === 'queued' || s.status === 'running'),
  )
  if (open.length === 0) return

  let queued: ReadonlySet<string> | undefined
  for (const state of open) {
    // A newer reconnect supersedes this pass: its snapshots are obsolete, so
    // it must not commit verdicts. The trailing loop reruns from scratch.
    if (!isCurrent()) return
    let entry
    try {
      entry = await connection.fetchHistoryEntry(state.ref.prompt)
    } catch {
      continue
    }
    if (entry) {
      connection.replayHistory(entry)
      if (Object.keys(entry.outputs).length > 0) store.hydrateOutputs(state.ref, entry.outputs)
      continue
    }
    // One /queue fetch covers every historyless execution in this pass.
    queued ??= await connection.fetchQueuePrompts()
    if (!queued.has(state.ref.prompt)) {
      let finalEntry
      try {
        finalEntry = await connection.fetchHistoryEntry(state.ref.prompt)
      } catch {
        continue
      }
      if (finalEntry) {
        connection.replayHistory(finalEntry)
        if (Object.keys(finalEntry.outputs).length > 0) store.hydrateOutputs(state.ref, finalEntry.outputs)
      } else if (isCurrent()) {
        store.markLost(state.ref)
      }
    }
  }
}
