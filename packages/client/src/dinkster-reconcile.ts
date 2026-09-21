/**
 * Execution reconciliation after a WS gap - native Dinkster protocol.
 *
 * Events missed while disconnected are gone from the wire, but not from the
 * server: the queue keeps a bounded job history, and GET
 * /api/jobs/{clientId}/{jobId} returns the full job record (state,
 * nodeStates, executed/cached/skipped, error, output descriptors).
 * Reconciliation replays that record through the SAME normalized-event
 * pipeline live events take (DinksterConnection.replayJob) - one pipeline, no
 * parallel state machine.
 *
 * For each non-terminal execution, plus completed executions whose artifact
 * field has not been hydrated:
 *  - job terminal          -> replay (node states + the terminal job_state
 *                             transition with full error detail) and hydrate
 *                             output descriptors
 *  - job queued/running    -> still live; the reconnected socket resumes its
 *                             events and hydrated nodeStates fill the gap
 *  - job missing           -> lost (history eviction or server restart);
 *                             marked interrupted with `execution.lost`
 *
 * PRECONDITION: the store must be subscribed to the connection's events
 * (connection.onEvent(store.apply)) - the standard wiring - because replay
 * flows through that subscription.
 *
 * Terminal races are safe by construction: completed executions are read only
 * until their artifact field becomes authoritative, ExecutionStore.markLost()
 * never downgrades a terminal state, and the normalizer dedupes a terminal
 * replay over an already-completed run.
 */

import type { ExecutionRef } from '@dinkster/core'
import { runJournalIdentity, type DinksterConnection } from './dinkster-connection.js'
import type { ExecutionStore } from './execution-store.js'
import { supersedable } from './reconcile-track.js'

/** Fetch the persisted result after a live completed event and attach its execution artifacts. */
export async function hydrateDinksterCompletedExecution(
  connection: DinksterConnection,
  store: ExecutionStore,
  ref: ExecutionRef,
): Promise<void> {
  if (ref.connection !== connection.id) return
  const job = await connection.fetchJob(ref.prompt)
  if (job?.state === 'completed') {
    if (job.submittedBy !== undefined) store.hydrateSubmittedBy(ref, job.submittedBy)
    if (job.artifacts !== undefined) store.hydrateArtifacts(ref, job.artifacts)
  }
}

// Generation-tracked like the V1 reconciler: overlapping reconnects coalesce,
// a superseded pass never commits loss verdicts from obsolete job reads, and
// the trailing rerun answers against the current connection state.
export const reconcileDinksterExecutions: (
  connection: DinksterConnection,
  store: ExecutionStore,
) => Promise<void> = supersedable(
  (connection: DinksterConnection, isCurrent: () => boolean, store: ExecutionStore) =>
    reconcilePass(connection, store, isCurrent),
)

async function reconcilePass(
  connection: DinksterConnection,
  store: ExecutionStore,
  isCurrent: () => boolean,
): Promise<void> {
  // Only THIS connection's runs: the store is shared across backends, and
  // asking backend A about backend B's jobs would mark B's perfectly live
  // executions lost.
  const open = [...store.executions.get().values()].filter(
    (s) =>
      s.ref.connection === connection.id && (
        s.status === 'queued' ||
        s.status === 'running' ||
        (s.status === 'completed' && !s.artifactsHydrated)
      ),
  )
  for (const state of open) {
    // A newer reconnect supersedes this pass: its job reads are obsolete
    // (a 404 answered to the old request says nothing about the job now).
    if (!isCurrent()) return
    let job
    try {
      job = await connection.fetchJob(state.ref.prompt)
    } catch {
      continue
    }
    if (job === undefined) {
      if (isCurrent()) store.markLost(state.ref)
      continue
    }
    if (job.submittedBy !== undefined) store.hydrateSubmittedBy(state.ref, job.submittedBy)
    // Replay for terminal AND still-live jobs: a queued/running record's
    // nodeStates fill the gap the wire dropped (node_started/node_finished
    // are incremental - a node that finished during the gap is never
    // re-announced); replayJob only ingests a job_state for terminal states.
    connection.replayJob(state.ref.prompt, job)
    // Log records missed during the gap live only in the run journal;
    // replay them too. Optional server capability: fire-and-forget so a
    // slow or hung journal endpoint never stalls job-state reconciliation.
    const journal = runJournalIdentity(job)
    if (journal !== undefined) {
      connection.backfillRunLog(journal.runId, journal.scope).catch(() => {
        // Reconciliation of job state must not fail on a journal error.
      })
    }
    if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
      const outputs = job.outputs
      if (
        typeof outputs === 'object' &&
        outputs !== null &&
        !Array.isArray(outputs) &&
        Object.keys(outputs).length > 0 &&
        // All-or-nothing: one malformed per-node record rejects hydration
        // (the run's terminal state is already correct without it).
        Object.values(outputs).every(
          (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
        )
      ) {
        store.hydrateOutputs(
          state.ref,
          outputs as Readonly<Record<string, Readonly<Record<string, unknown>>>>,
        )
      }
      if (job.state === 'completed' && job.artifacts !== undefined) {
        store.hydrateArtifacts(state.ref, job.artifacts)
      }
    }
  }
}
