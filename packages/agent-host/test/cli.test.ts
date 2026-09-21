import { describe, expect, it, vi } from 'vitest'
import { ExecutionRequestError } from '@dinkster/client'
import { followExecutionEvents, formatCliResult, parseArgs, runCli, usage } from '../src/main.js'

describe('CLI argument parsing', () => {
  it('parses global flags and dispatch JSON', () => {
    expect(parseArgs([
      '--base-url', 'http://localhost:8792/', '--session', 's1', '--actor-id', 'agent_test',
      '--owner', 'alice',
      'dispatch', '--command', 'node.add', '--params', '{"graphId":"g0"}',
    ])).toMatchObject({
      action: 'dispatch', baseUrl: 'http://localhost:8792', sessionId: 's1',
      actorId: 'agent_test', owner: 'alice', command: 'node.add', params: { graphId: 'g0' },
    })
  })

  it('provides help at command levels', () => {
    expect(parseArgs(['sessions', '--help'])).toMatchObject({ action: 'help', helpTopic: 'sessions' })
    expect(usage('document get')).toContain('document get')
    expect(usage('propose-setting')).toContain('disappears when this publisher disconnects')
  })

  it('parses a setting proposal and hold duration', () => {
    expect(parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'propose-setting',
      '--setting', 'canvas.grid.visible', '--value', 'false', '--note', 'Reduce clutter', '--hold', '12.5',
    ])).toMatchObject({
      action: 'propose-setting', sessionId: 's1', settingId: 'canvas.grid.visible', value: false,
      note: 'Reduce clutter', hold: 12.5,
    })
  })

  it('parses execution scopes, event waits, and value paths', () => {
    expect(parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'job', 'submit',
      '--execution-scope', '{"kind":"partial","targets":[{"instancePath":["n0"],"node":"n1"}]}',
    ])).toMatchObject({
      action: 'job-submit',
      executionScope: { kind: 'partial', targets: [{ instancePath: ['n0'], node: 'n1' }] },
    })
    expect(parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'execution', 'events',
      '--job', 'job-1', '--wait', '30000',
    ])).toMatchObject({ action: 'execution-events', jobId: 'job-1', waitMs: 30_000 })
    expect(parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'value', 'get',
      '--job', 'job-1', '--node', 'n1', '--output', 'images', '--element', '[2,0]',
    ])).toMatchObject({
      action: 'value-get', jobId: 'job-1', nodeId: 'n1', outputId: 'images', element: [2, 0],
    })
  })

  it('follows one job until an execution event authorization refusal', async () => {
    expect(() => parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'execution', 'events', '--after', '2',
    ])).toThrow('unknown argument: --after')
    const started = { kind: 'started', execution: { connection: 'dinkster', prompt: 'job-1' }, timestamp: 1 }
    const denial = {
      severity: 'error' as const,
      origin: 'runtime' as const,
      code: 'execution.events.capability-required',
      message: 'jobs:read required',
    }
    const events = vi.fn()
      .mockResolvedValueOnce({ events: [{ cursor: 1, event: started }], nextCursor: 1, oldestCursor: 1, problems: [] })
      .mockResolvedValueOnce({ events: [], nextCursor: 2, oldestCursor: 1, problems: [denial] })

    await expect(followExecutionEvents({ events }, { jobId: 'job-1', waitMs: 1_000 })).resolves.toEqual({
      events: [{ cursor: 1, event: started }],
      problems: [denial],
    })
    expect(events).toHaveBeenNthCalledWith(1, { after: 0, jobId: 'job-1', waitMs: expect.any(Number) })
    expect(events).toHaveBeenNthCalledWith(2, { after: 1, jobId: 'job-1', waitMs: expect.any(Number) })
    expect(events).toHaveBeenCalledTimes(2)
  })

  it('returns immediately when the first event page contains only an authorization refusal', async () => {
    const denial = {
      severity: 'error' as const,
      origin: 'runtime' as const,
      code: 'execution.ws-ticket.authentication-required',
      message: 'delegation expired',
      data: { status: 401, code: 'authentication-required', operation: 'ws-ticket' },
    }
    const events = vi.fn(async () => ({
      events: [], nextCursor: 0, oldestCursor: 0, problems: [denial],
    }))

    await expect(followExecutionEvents({ events }, { waitMs: 30_000 })).resolves.toEqual({
      events: [], problems: [denial],
    })
    expect(events).toHaveBeenCalledOnce()
  })

  it.each([
    ['job-cancel', 'cancel'],
    ['job-inspect', 'inspect'],
    ['job-outputs', 'outputs'],
  ] as const)('formats structured %s denials before closing the CLI handle', async (action, operation) => {
    const diagnostic = {
      severity: 'error' as const,
      origin: 'runtime' as const,
      code: `execution.${operation}.capability-required`,
      message: `${operation} requires permission`,
      data: {
        status: 403,
        code: 'capability-required',
        operation,
        capability: operation === 'cancel' ? 'jobs:cancel' : 'jobs:read',
        scope: 'shared',
      },
    }
    const rejected = vi.fn(async () => { throw new ExecutionRequestError(diagnostic) })
    const close = vi.fn()
    const handle = { cancel: rejected, inspect: rejected, outputs: rejected, close }
    const result = await runCli({
      action,
      baseUrl: 'http://example.test',
      sessionId: 's1',
      actorId: 'agent-test',
      owner: 'alice',
      jobId: 'job-1',
    }, vi.fn(async () => handle) as never)

    expect(JSON.parse(formatCliResult(result))).toEqual({
      ok: false,
      diagnostics: [diagnostic],
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('requires session and valid JSON for dispatch', () => {
    expect(() => parseArgs([
      '--base-url', 'http://localhost', 'dispatch', '--command', 'node.add', '--params', '{}',
    ])).toThrow('--session is required')
    expect(() => parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'dispatch',
      '--command', 'node.add', '--params', '{',
    ])).toThrow('--params must be valid JSON')
    expect(() => parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'document', 'compile',
      '--execution-scope', '{"kind":"partial","targets":[]}',
    ])).toThrow('--execution-scope must be a full or partial execution scope')
    expect(() => parseArgs([
      '--base-url', 'http://localhost', '--session', 's1', 'value', 'get',
      '--job', 'job-1', '--node', 'n1',
    ])).toThrow('--output is required')
  })
})
