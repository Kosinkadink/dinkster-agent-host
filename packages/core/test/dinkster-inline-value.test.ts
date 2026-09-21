/**
 * Inline scalar decode on per-output summaries (backend commit a58cdb6):
 * node_finished/node_cached detail.outputs entries may carry "value" for
 * types with a registered inline serializer. Contract: JSON-native scalars
 * pass through; anything else (null, arrays, objects, non-finite numbers)
 * is a smuggled wire and the FIELD is dropped, never the summary. Omission
 * means "not inline", never absence - absence rides node_skipped.
 */
import { describe, expect, it } from 'vitest'
import type { NodeProgress, NormalizedEvent } from '../src/events/contract.js'
import { DinksterNormalizer, type DinksterRawJson } from '../src/events/dinkster.js'
import { asConnectionId } from '../src/ids.js'

const CONN = asConnectionId('conn-test')

function finish(detailOutputs: Record<string, unknown>, type = 'node_finished'): NodeProgress {
  const normalizer = new DinksterNormalizer(CONN, () => 0)
  const events: readonly NormalizedEvent[] = normalizer.normalize({
    type,
    clientId: 'client-a',
    jobId: 'job-1',
    runId: 'run-1',
    nodeId: 'n',
    detail: { outputs: detailOutputs },
  } as DinksterRawJson)
  const states = events.find((e) => e.kind === 'nodeStates')
  expect(states?.kind).toBe('nodeStates')
  return (states as Extract<NormalizedEvent, { kind: 'nodeStates' }>).nodes['n']!
}

describe('inline scalar values on output summaries', () => {
  it('passes through int/float/bool/string scalars on node_finished', () => {
    const p = finish({
      i: { typeId: 'core.int', value: 42 },
      f: { typeId: 'core.float', value: 0.5 },
      b: { typeId: 'core.boolean', value: false },
      s: { typeId: 'core.string', value: 'hello' },
    })
    expect(p.state).toBe('done')
    expect(p.outputs).toEqual({
      i: { typeId: 'core.int', value: 42 },
      f: { typeId: 'core.float', value: 0.5 },
      b: { typeId: 'core.boolean', value: false },
      s: { typeId: 'core.string', value: 'hello' },
    })
  })

  it('passes through on node_cached identically', () => {
    const p = finish({ i: { typeId: 'core.int', value: 7 } }, 'node_cached')
    expect(p.state).toBe('cached')
    expect(p.outputs).toEqual({ i: { typeId: 'core.int', value: 7 } })
  })

  it('drops non-scalar values but keeps the summary (typeId/length untouched)', () => {
    const p = finish({
      nul: { typeId: 'core.int', value: null },
      arr: { typeId: 'list<core.int>', length: 2, value: [1, 2] },
      obj: { typeId: 'core.int', value: { a: 1 } },
      nan: { typeId: 'core.float', value: Number.NaN },
    })
    expect(p.outputs).toEqual({
      nul: { typeId: 'core.int' },
      arr: { typeId: 'list<core.int>', length: 2 },
      obj: { typeId: 'core.int' },
      nan: { typeId: 'core.float' },
    })
  })

  it('omission means not-inline: no value key materializes', () => {
    const p = finish({ out: { typeId: 'core.image' } })
    expect(p.outputs).toEqual({ out: { typeId: 'core.image' } })
    expect(p.outputs!['out']).not.toHaveProperty('value')
  })
})
