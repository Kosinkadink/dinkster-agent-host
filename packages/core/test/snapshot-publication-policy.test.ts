import { describe, expect, it } from 'vitest'
import {
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MIN_OWN_INTERVAL_MS,
  SnapshotPublicationPolicy,
} from '../src/commands/snapshot-publication-policy.js'

describe('SnapshotPublicationPolicy', () => {
  it('publishes at the 200-op hard threshold', () => {
    const policy = new SnapshotPublicationPolicy(5, 0, () => 0)
    policy.observeConfirmed(204)
    expect(policy.decide(0, true)).toEqual({ kind: 'wait', delayMs: 60_000 })
    policy.observeConfirmed(205)
    expect(policy.decide(0, true)).toEqual({ kind: 'publish' })
  })

  it('publishes at 20 ops only after the snapshot is 60 seconds old', () => {
    const policy = new SnapshotPublicationPolicy(0, 1_000, () => 0)
    policy.observeConfirmed(20)
    expect(policy.decide(60_999, true)).toEqual({ kind: 'wait', delayMs: 1 })
    expect(policy.decide(61_000, true)).toEqual({ kind: 'publish' })
  })

  it('re-checks the threshold after jitter and cancels when a newer snapshot wins', () => {
    const policy = new SnapshotPublicationPolicy(0, 0, () => 1)
    policy.observeConfirmed(200)
    expect(policy.decide(0, true)).toEqual({ kind: 'wait', delayMs: 5_000 })
    policy.observeSnapshot(200, 2_000)
    expect(policy.decide(5_000, true)).toEqual({ kind: 'none' })
  })

  it('allows only one flight and enforces 30 seconds after an own success', () => {
    const policy = new SnapshotPublicationPolicy(0, 0, () => 0)
    policy.observeConfirmed(200)
    expect(policy.markPublishing()).toBe(true)
    expect(policy.markPublishing()).toBe(false)
    expect(policy.decide(0, true)).toEqual({ kind: 'none' })
    policy.publicationSucceeded(200, 1_000)
    policy.observeConfirmed(400)
    expect(policy.decide(1_000, true)).toEqual({
      kind: 'wait',
      delayMs: SNAPSHOT_MIN_OWN_INTERVAL_MS,
    })
    expect(policy.decide(31_000, true)).toEqual({ kind: 'publish' })
  })

  it('does not publish while disconnected and retries a failure only after newer confirmed work', () => {
    const policy = new SnapshotPublicationPolicy(0, 0, () => 1)
    policy.observeConfirmed(200)
    expect(policy.decide(0, true)).toEqual({ kind: 'wait', delayMs: 5_000 })
    expect(policy.decide(0, false)).toEqual({ kind: 'none' })
    expect(policy.decide(5_000, true)).toEqual({ kind: 'wait', delayMs: 5_000 })
    expect(policy.markPublishing()).toBe(true)
    policy.publicationFailed()
    expect(policy.decide(0, true)).toEqual({ kind: 'none' })
    policy.observeConfirmed(201)
    expect(policy.decide(0, true)).toEqual({ kind: 'wait', delayMs: 5_000 })
  })

  it('resets counters when a descriptor or conflict reveals a newer snapshot', () => {
    const policy = new SnapshotPublicationPolicy(10, 0, () => 0)
    policy.observeConfirmed(210)
    expect(policy.opsSinceLastKnownSnapshot).toBe(200)
    expect(policy.markPublishing()).toBe(true)
    policy.publicationConflicted(205, 10_000)
    expect(policy.opsSinceLastKnownSnapshot).toBe(5)
    expect(policy.decide(10_000 + SNAPSHOT_MAX_AGE_MS, true)).toEqual({ kind: 'none' })
  })

  it('close flushes only when the threshold is already met and all storm gates allow it', () => {
    const policy = new SnapshotPublicationPolicy(0, 0, () => 1)
    policy.observeConfirmed(20)
    expect(policy.shouldFlushOnClose(SNAPSHOT_MAX_AGE_MS - 1, true)).toBe(false)
    expect(policy.shouldFlushOnClose(SNAPSHOT_MAX_AGE_MS, false)).toBe(false)
    expect(policy.shouldFlushOnClose(SNAPSHOT_MAX_AGE_MS, true)).toBe(true)
  })
})
