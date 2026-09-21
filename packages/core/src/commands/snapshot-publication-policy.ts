/** Pure checkpoint publication policy. SharedDocumentSession owns all I/O. */

export const SNAPSHOT_HARD_OP_THRESHOLD = 200
export const SNAPSHOT_TIMED_OP_THRESHOLD = 20
export const SNAPSHOT_MAX_AGE_MS = 60_000
export const SNAPSHOT_MAX_JITTER_MS = 5_000
export const SNAPSHOT_MIN_OWN_INTERVAL_MS = 30_000

export type SnapshotPublicationDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'wait'; readonly delayMs: number }
  | { readonly kind: 'publish' }

const noPublication = { kind: 'none' } as const

/**
 * Tracks only revision/time policy state. It deliberately knows nothing about
 * documents, promises, timers, transports, or session status beyond the
 * connected boolean supplied by its owner.
 */
export class SnapshotPublicationPolicy {
  private confirmedRevision: number
  private knownSnapshotRevision: number
  private knownSnapshotAt: number
  private lastOwnSuccessAt: number | undefined
  private retryAfterRevision: number | undefined
  private jitterDeadline: number | undefined
  private inFlight = false

  constructor(
    snapshotRevision: number,
    now: number,
    private readonly random: () => number = Math.random,
  ) {
    this.confirmedRevision = snapshotRevision
    this.knownSnapshotRevision = snapshotRevision
    this.knownSnapshotAt = now
  }

  get opsSinceLastKnownSnapshot(): number {
    return Math.max(0, this.confirmedRevision - this.knownSnapshotRevision)
  }

  get publicationInFlight(): boolean {
    return this.inFlight
  }

  observeConfirmed(revision: number): void {
    if (revision > this.confirmedRevision) this.confirmedRevision = revision
  }

  /** A descriptor, GET snapshot, or successful PUT exposed a newer checkpoint. */
  observeSnapshot(revision: number, now: number): void {
    if (revision <= this.knownSnapshotRevision) return
    this.knownSnapshotRevision = revision
    this.knownSnapshotAt = now
    this.jitterDeadline = undefined
    if (this.retryAfterRevision !== undefined && revision >= this.retryAfterRevision) {
      this.retryAfterRevision = undefined
    }
  }

  decide(now: number, connected: boolean): SnapshotPublicationDecision {
    if (!connected) {
      // A reconnect gets a fresh jitter window instead of immediately using
      // a deadline that elapsed while this publisher was offline.
      this.jitterDeadline = undefined
      return noPublication
    }
    if (this.inFlight) return noPublication
    if (
      this.retryAfterRevision !== undefined &&
      this.confirmedRevision <= this.retryAfterRevision
    ) {
      return noPublication
    }

    const thresholdDelay = this.thresholdDelay(now)
    if (thresholdDelay === undefined) {
      this.jitterDeadline = undefined
      return noPublication
    }
    const ownIntervalDelay =
      this.lastOwnSuccessAt === undefined
        ? 0
        : Math.max(0, this.lastOwnSuccessAt + SNAPSHOT_MIN_OWN_INTERVAL_MS - now)
    const eligibilityDelay = Math.max(thresholdDelay, ownIntervalDelay)
    if (eligibilityDelay > 0) {
      this.jitterDeadline = undefined
      return { kind: 'wait', delayMs: eligibilityDelay }
    }

    if (this.jitterDeadline === undefined) {
      const sample = Math.min(1, Math.max(0, this.random()))
      this.jitterDeadline = now + Math.floor(sample * SNAPSHOT_MAX_JITTER_MS)
    }
    const jitterDelay = this.jitterDeadline - now
    return jitterDelay > 0 ? { kind: 'wait', delayMs: jitterDelay } : { kind: 'publish' }
  }

  /** Close skips jitter, but keeps all threshold, connectivity, and storm gates. */
  shouldFlushOnClose(now: number, connected: boolean): boolean {
    if (!connected || this.inFlight) return false
    if (
      this.retryAfterRevision !== undefined &&
      this.confirmedRevision <= this.retryAfterRevision
    ) {
      return false
    }
    if (this.thresholdDelay(now) !== 0) return false
    return (
      this.lastOwnSuccessAt === undefined ||
      now - this.lastOwnSuccessAt >= SNAPSHOT_MIN_OWN_INTERVAL_MS
    )
  }

  /** Returns false when another publication already owns the single flight. */
  markPublishing(): boolean {
    if (this.inFlight) return false
    this.inFlight = true
    this.jitterDeadline = undefined
    return true
  }

  publicationSucceeded(revision: number, now: number): void {
    this.inFlight = false
    this.lastOwnSuccessAt = now
    this.retryAfterRevision = undefined
    this.observeSnapshot(revision, now)
  }

  publicationConflicted(snapshotRevision: number, now: number): void {
    this.inFlight = false
    this.observeSnapshot(snapshotRevision, now)
  }

  publicationFailed(): void {
    this.inFlight = false
    this.retryAfterRevision = this.confirmedRevision
    this.jitterDeadline = undefined
  }

  private thresholdDelay(now: number): number | undefined {
    const ops = this.opsSinceLastKnownSnapshot
    if (ops >= SNAPSHOT_HARD_OP_THRESHOLD) return 0
    if (ops < SNAPSHOT_TIMED_OP_THRESHOLD) return undefined
    return Math.max(0, this.knownSnapshotAt + SNAPSHOT_MAX_AGE_MS - now)
  }
}
