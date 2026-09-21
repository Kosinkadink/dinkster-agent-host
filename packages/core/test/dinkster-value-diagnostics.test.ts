import { describe, expect, it } from 'vitest'
import { asConnectionId } from '../src/ids.js'
import { DinksterNormalizer } from '../src/events/dinkster.js'

const CONN = asConnectionId('diagnostics-test')

describe('value_diagnostics normalization', () => {
  it('decodes the published alpha and mask payloads exactly', () => {
    const normalizer = new DinksterNormalizer(CONN, () => 42)
    expect(normalizer.normalize({
      type: 'value_diagnostics',
      runId: 'run-1',
      jobId: 'job-1',
      nodeId: 'composite',
      detail: {
        diagnostics: [
          {
            code: 'alpha_dropped',
            nodeId: 'composite',
            outputId: 'image',
            inputIds: ['foreground', 'mask'],
          },
          {
            code: 'mask_polarity_mismatch',
            nodeId: 'composite',
            inputId: 'mask',
            expected: 'coverage',
            actual: 'transparency',
          },
        ],
      },
    })).toEqual([{
      kind: 'valueDiagnostics',
      execution: { connection: CONN, prompt: 'job-1' },
      timestamp: 42,
      diagnostics: [
        {
          code: 'alpha_dropped',
          nodeId: 'composite',
          outputId: 'image',
          inputIds: ['foreground', 'mask'],
        },
        {
          code: 'mask_polarity_mismatch',
          nodeId: 'composite',
          inputId: 'mask',
          expected: 'coverage',
          actual: 'transparency',
        },
      ],
    }])
  })

  it('preserves the singular input identity on asset-coercion alpha loss', () => {
    const diagnostic = { code: 'alpha_dropped', nodeId: 'node', inputId: 'asset', outputId: 'image' }
    const events = new DinksterNormalizer(CONN, () => 1).normalize({
      type: 'value_diagnostics', jobId: 'coercion-job', nodeId: 'node',
      detail: { diagnostics: [diagnostic] },
    })
    expect(events).toEqual([{
      kind: 'valueDiagnostics', execution: { connection: CONN, prompt: 'coercion-job' },
      timestamp: 1, diagnostics: [diagnostic],
    }])
  })

  it.each([
    {}, { inputId: '' }, { inputId: 4 },
    { inputId: 'asset', inputIds: ['asset'] },
    { inputId: undefined, inputIds: ['asset'] },
  ])('rejects malformed or ambiguous alpha input identity %j', (inputs) => {
    const events = new DinksterNormalizer(CONN).normalize({
      type: 'value_diagnostics', jobId: 'coercion-job', nodeId: 'node',
      detail: { diagnostics: [{ code: 'alpha_dropped', nodeId: 'node', outputId: 'image', ...inputs }] },
    })
    expect(events).toEqual([])
  })

  it('preserves nested runtime node identity without parsing or rewriting it', () => {
    const nodeId = 'outer[0]/inner[2]/composite'
    const events = new DinksterNormalizer(CONN, () => 1).normalize({
      type: 'value_diagnostics',
      jobId: 'nested-job',
      nodeId,
      detail: {
        diagnostics: [{ code: 'alpha_dropped', nodeId, outputId: 'image', inputIds: ['layer'] }],
      },
    })
    expect(events[0]).toMatchObject({
      kind: 'valueDiagnostics',
      diagnostics: [{ nodeId }],
    })
  })

  it('ignores unknown codes and rejects malformed or mismatched rows without poisoning valid siblings', () => {
    const malformed: string[] = []
    const events = new DinksterNormalizer(CONN, () => 2, (detail) => malformed.push(detail)).normalize({
      type: 'value_diagnostics',
      jobId: 'job-2',
      nodeId: 'node-a',
      detail: {
        diagnostics: [
          { code: 'future_diagnostic', nodeId: 'node-a', payload: true },
          { code: 'alpha_dropped', nodeId: 'node-a', outputId: 'image', inputIds: ['input'] },
          { code: 'alpha_dropped', nodeId: 'node-a', outputId: 4, inputIds: ['input'] },
          { code: 'mask_polarity_mismatch', nodeId: 'node-b', inputId: 'mask', expected: 'coverage', actual: 'transparency' },
          null,
        ],
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'valueDiagnostics',
      diagnostics: [{ code: 'alpha_dropped', nodeId: 'node-a', outputId: 'image', inputIds: ['input'] }],
    })
    expect(malformed).toEqual([
      'value_diagnostics with malformed alpha_dropped row',
      'value_diagnostics with mismatched diagnostic nodeId',
      'value_diagnostics with malformed diagnostic row',
    ])
  })

  it('reports malformed envelopes but silently drops an all-unknown diagnostic list', () => {
    const malformed: string[] = []
    const normalizer = new DinksterNormalizer(CONN, () => 0, (detail) => malformed.push(detail))
    expect(normalizer.normalize({ type: 'value_diagnostics', jobId: 'job-3', nodeId: 'node-a', detail: {} })).toEqual([])
    expect(normalizer.normalize({
      type: 'value_diagnostics',
      jobId: 'job-3',
      nodeId: 'node-a',
      detail: { diagnostics: [{ code: 'future_diagnostic' }] },
    })).toEqual([])
    expect(malformed).toEqual(['value_diagnostics with malformed detail'])
  })
})
