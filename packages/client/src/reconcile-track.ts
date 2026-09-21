/**
 * Generation-tracked, per-connection supersession for reconciliation passes.
 *
 * Every call bumps the connection's generation. One owner loop runs passes
 * until the generation is stable, so overlapping reconnects coalesce into
 * the same promise and a trailing rerun always sees fresh state. Each pass
 * receives isCurrent() and MUST NOT commit loss verdicts once superseded -
 * its snapshots describe a connection that has since reconnected.
 *
 * A superseded pass's failure is swallowed: its obsolete request failing is
 * not an answer about the current connection; the trailing rerun answers
 * instead. Only the current (newest-generation) pass's failure rejects the
 * shared promise.
 */

interface ReconcileTrack {
  generation: number
  promise: Promise<void> | undefined
}

export function supersedable<K extends object, A extends readonly unknown[]>(
  pass: (key: K, isCurrent: () => boolean, ...args: A) => Promise<void>,
): (key: K, ...args: A) => Promise<void> {
  const tracks = new WeakMap<K, ReconcileTrack>()
  return (key: K, ...args: A): Promise<void> => {
    let track = tracks.get(key)
    if (!track) {
      track = { generation: 0, promise: undefined }
      tracks.set(key, track)
    }
    track.generation += 1
    if (track.promise) return track.promise
    const owned = track
    owned.promise = (async () => {
      try {
        let ran = 0
        while (ran !== owned.generation) {
          ran = owned.generation
          try {
            await pass(key, () => owned.generation === ran, ...args)
          } catch (error) {
            if (owned.generation === ran) throw error
            // Superseded pass failed against obsolete state: fall through
            // to the trailing rerun, which answers for the newest request.
          }
        }
      } finally {
        owned.promise = undefined
      }
    })()
    return owned.promise
  }
}
