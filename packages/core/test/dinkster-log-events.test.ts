/**
 * node_event/log normalization: execution log records are info|warning only.
 * Errors are NOT a log level - they keep the single node_failed / job error
 * substrate - so a wire log claiming level "error" is malformed and dropped.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId, asPromptId } from '../src/ids.js'
import { DinksterNormalizer, type DinksterRawJson } from '../src/events/dinkster.js'
import type { NormalizedEvent } from '../src/events/contract.js'

const CONN = asConnectionId('conn-log')
const EXEC = { connection: CONN, prompt: asPromptId('job-log') }

function normalize(message: DinksterRawJson): {
  events: readonly NormalizedEvent[]
  malformed: string[]
} {
  const malformed: string[] = []
  const normalizer = new DinksterNormalizer(CONN, () => 42, (detail) => malformed.push(detail))
  return { events: normalizer.normalize(message), malformed }
}

const wireLog = (
  data: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
): DinksterRawJson => ({
  type: 'node_event',
  jobId: 'job-log',
  runId: 'run-log',
  event: 'log',
  seq: 1,
  ...envelope,
  data,
})

describe('node_event log normalization', () => {
  it('normalizes a node-attributed info record with full metadata', () => {
    const { events, malformed } = normalize(wireLog(
      {
        level: 'info',
        message: 'loading checkpoint',
        ts: 1755772800.25,
        origin: 'logging',
        logger: 'dinkster.engine',
      },
      { nodeId: 'sampler', seq: 7 },
    ))
    expect(malformed).toEqual([])
    expect(events).toEqual([{
      kind: 'log',
      execution: EXEC,
      timestamp: 42,
      runtimeNodeId: 'sampler',
      level: 'info',
      message: 'loading checkpoint',
      emittedAt: 1755772800250,
      origin: 'logging',
      logger: 'dinkster.engine',
      seq: 7,
    }])
  })

  it('normalizes a run-level warning without nodeId or optional metadata', () => {
    const { events, malformed } = normalize(wireLog({ level: 'warning', message: 'low vram' }))
    expect(malformed).toEqual([])
    expect(events).toEqual([{
      kind: 'log',
      execution: EXEC,
      timestamp: 42,
      level: 'warning',
      message: 'low vram',
      seq: 1,
    }])
  })

  it('keeps pythonLevel for captured ERROR records without inventing an error level', () => {
    const { events } = normalize(wireLog({
      level: 'warning',
      message: 'Traceback (most recent call last)',
      origin: 'capture',
      pythonLevel: 'ERROR',
    }))
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.kind).toBe('log')
    if (event.kind !== 'log') return
    expect(event.level).toBe('warning')
    expect(event.pythonLevel).toBe('ERROR')
  })

  it.each([
    ['level error is not a log level', { level: 'error', message: 'boom' }],
    ['unknown level', { level: 'debug', message: 'x' }],
    ['missing level', { message: 'x' }],
    ['missing message', { level: 'info' }],
    ['non-string message', { level: 'info', message: 7 }],
  ])('rejects malformed log data: %s', (_label, data) => {
    const { events, malformed } = normalize(wireLog(data))
    expect(events).toEqual([])
    expect(malformed).toEqual(['node_event log with malformed data'])
  })

  it.each([
    ['missing seq', undefined],
    ['non-numeric seq', 'first'],
    ['negative seq', -1],
    ['fractional seq', 1.5],
  ])('rejects a log without a usable dedupe seq: %s', (_label, seq) => {
    const { events, malformed } = normalize(wireLog(
      { level: 'info', message: 'x' },
      { seq },
    ))
    expect(events).toEqual([])
    expect(malformed).toEqual(['node_event log with malformed data'])
  })

  it('drops an unrecognized origin but keeps the record', () => {
    const { events } = normalize(wireLog({ level: 'info', message: 'x', origin: 'telepathy' }))
    expect(events).toHaveLength(1)
    const event = events[0]!
    if (event.kind !== 'log') throw new Error('expected log event')
    expect(event.origin).toBeUndefined()
  })

  it('a log without job identity is malformed, not guessed onto a run', () => {
    const { events, malformed } = normalize({
      type: 'node_event',
      event: 'log',
      data: { level: 'info', message: 'orphan' },
    })
    expect(events).toEqual([])
    expect(malformed).toEqual(['node_event without job identity (no jobId or runId)'])
  })

  it('caps oversized messages', () => {
    const { events } = normalize(wireLog({ level: 'info', message: 'y'.repeat(10_000) }))
    const event = events[0]!
    if (event.kind !== 'log') throw new Error('expected log event')
    expect(event.message).toHaveLength(4096)
  })
})
