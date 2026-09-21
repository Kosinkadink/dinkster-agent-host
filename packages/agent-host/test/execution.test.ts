import type {
  DinksterJobRecord,
  DinksterSubmitResult,
  SchemaRegistry,
  ValuePeekResult,
  ValueQuery,
} from '@dinkster/client'
import { ExecutionRequestError } from '@dinkster/client'
import {
  asConnectionId,
  coreCommandRegistry,
  createLocalSession,
  type CompileArtifact,
  type NodeSchema,
  type NormalizedEvent,
} from '@dinkster/core'
import { describe, expect, it, vi } from 'vitest'
import { createAgentDocument } from '../src/api.js'
import {
  createAgentExecutionRuntime,
  type AgentExecutionConnection,
} from '../src/execution.js'

const outputSchema = (requiredInput: boolean): NodeSchema => ({
  type: 'TestOutput',
  displayName: 'Test output',
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items: [
    ...(requiredInput ? [{
      kind: 'input' as const,
      id: 'value',
      type: { kind: 'concrete' as const, name: 'INT' },
      optional: false,
    }] : []),
    { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'INT' } },
  ],
})

function fixture(requiredInput = false) {
  const session = createLocalSession(createAgentDocument('execution-test'), coreCommandRegistry())
  expect(session.dispatch({
    command: 'node.add',
    params: { graphId: 'g0', type: 'TestOutput', position: { x: 0, y: 0 } },
  }).ok).toBe(true)
  const schema = outputSchema(requiredInput)
  const registry: SchemaRegistry = {
    connection: asConnectionId('dinkster'),
    hash: 'schema-test',
    schemas: new Map([['TestOutput', schema]]),
    diagnostics: [],
    resolve: (type) => type === 'TestOutput' ? schema : undefined,
  }
  let listener: ((event: NormalizedEvent) => void) | undefined
  let problemListener: ((problem: import('@dinkster/core').Diagnostic) => void) | undefined
  const submit = vi.fn(async (_artifact: CompileArtifact): Promise<DinksterSubmitResult> => ({
    ok: true,
    execution: { connection: asConnectionId('dinkster'), prompt: 'job-1' as never },
    jobRef: 'run-1',
  }))
  const cancel = vi.fn(async () => {})
  const peek = vi.fn(async (_query: ValueQuery): Promise<ValuePeekResult> => ({
    available: false,
    reason: 'unknown-output',
    status: 404,
    error: 'unknown output',
  }))
  const failedJob: DinksterJobRecord = {
    state: 'failed',
    error: { kind: 'validation', diagnostics: [{ message: 'backend rejected input' }] },
  } as DinksterJobRecord
  const connection: AgentExecutionConnection = {
    fetchSchemas: vi.fn(async () => registry),
    submit,
    cancel,
    fetchJob: vi.fn(async (jobId) => jobId === 'job-failed' ? failedJob : undefined),
    replayJob: vi.fn((jobId, job) => {
      if (job.state === 'failed') listener?.({
        kind: 'error',
        execution: { connection: asConnectionId('dinkster'), prompt: jobId as never },
        timestamp: 10,
        detail: { exceptionType: 'validation', exceptionMessage: 'backend rejected input', traceback: [] },
      })
    }),
    fetchJobOutputs: vi.fn(async () => ({ n1: { result: { typeId: 'INT', value: 7 } } })),
    values: () => ({ peek }),
    onEvent: (next) => { listener = next; return () => { listener = undefined } },
    onProblem: (next) => { problemListener = next; return () => { problemListener = undefined } },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  return {
    session, connection, submit, cancel, peek,
    emit: (event: NormalizedEvent) => listener?.(event),
    emitProblem: (problem: import('@dinkster/core').Diagnostic) => problemListener?.(problem),
  }
}

describe('agent execution runtime', () => {
  it('returns blocking compiler Problems without submitting', async () => {
    const { session, connection, submit } = fixture(true)
    const beforeCompile = vi.fn(async () => {})
    const runtime = createAgentExecutionRuntime(session, 'http://example.test', 'agent-a', {
      beforeCompile,
      connection,
    })

    const compiled = await runtime.compile()
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.artifact.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        origin: 'compile',
        code: 'compile.input.missing',
        blocksExecution: true,
        anchor: expect.objectContaining({ occurrence: { instancePath: [], node: 'n1' } }),
      }),
    ])
    await expect(runtime.submit()).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'compile.input.missing' })],
    })
    expect(submit).not.toHaveBeenCalled()
    expect(beforeCompile).toHaveBeenCalledTimes(2)
    runtime.close()
  })

  it('submits the core artifact and preserves job, value, and cancellation identities', async () => {
    const { session, connection, submit, cancel, peek } = fixture()
    const runtime = createAgentExecutionRuntime(session, 'http://example.test', 'agent-b', { connection })

    await expect(runtime.submit()).resolves.toEqual({
      ok: true,
      execution: { connection: 'dinkster', prompt: 'job-1' },
      jobRef: 'run-1',
    })
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      connection: 'dinkster',
      schemaHash: 'schema-test',
      revision: 1,
    }))
    await expect(runtime.outputs('job-1')).resolves.toEqual({
      n1: { result: { typeId: 'INT', value: 7 } },
    })
    await expect(runtime.value({ jobId: 'job-1', nodeId: 'n1', outputId: 'missing' })).resolves.toMatchObject({
      available: false,
      reason: 'unknown-output',
      status: 404,
    })
    expect(peek).toHaveBeenCalledWith({ jobId: 'job-1', nodeId: 'n1', outputId: 'missing' })
    await runtime.cancel('job-1')
    expect(cancel).toHaveBeenCalledWith({ connection: 'dinkster', prompt: 'job-1' })
    runtime.close()
  })

  it('returns submission permission diagnostics unchanged', async () => {
    const { session, connection, submit } = fixture()
    const denial = {
      severity: 'error' as const,
      origin: 'validation' as const,
      code: 'submit.forbidden',
      message: 'execute permission required',
      data: { status: 403 },
    }
    submit.mockResolvedValueOnce({ ok: false, diagnostics: [denial] })
    const runtime = createAgentExecutionRuntime(session, 'http://example.test', 'agent-denied', { connection })

    const result = await runtime.submit()
    expect(result).toEqual({ ok: false, diagnostics: [denial] })
    expect(!result.ok && result.diagnostics[0]).toBe(denial)
    await expect(runtime.problems()).resolves.toContain(denial)
    runtime.close()
  })

  it('surfaces event authorization denials to long polls and Problems', async () => {
    const { session, connection, emitProblem } = fixture()
    const runtime = createAgentExecutionRuntime(session, 'http://example.test', 'agent-events', { connection })
    const denial = {
      severity: 'error' as const,
      origin: 'runtime' as const,
      code: 'execution.events.delegation-session-required',
      message: 'this delegation is limited to session s1',
      data: { status: 403, code: 'delegation-session-required', operation: 'events' },
    }
    const pending = runtime.events({ waitMs: 1_000 })

    emitProblem(denial)

    await expect(pending).resolves.toEqual({
      events: [], nextCursor: 0, oldestCursor: 0, problems: [denial],
    })
    await expect(runtime.problems()).resolves.toContain(denial)
    runtime.close()
  })

  it('retains thrown operation and value authorization denials as Problems', async () => {
    const { session, connection, cancel, peek } = fixture()
    const runtime = createAgentExecutionRuntime(session, 'http://example.test', 'agent-operations', { connection })
    const cancelDenial = {
      severity: 'error' as const,
      origin: 'runtime' as const,
      code: 'execution.cancel.capability-required',
      message: 'jobs:cancel required',
      data: { status: 403, code: 'capability-required', operation: 'cancel' },
    }
    cancel.mockRejectedValueOnce(new ExecutionRequestError(cancelDenial))
    peek.mockResolvedValueOnce({
      available: false, reason: 'capability-required', status: 403, error: 'jobs:read required',
    })

    await expect(runtime.cancel('job-1')).rejects.toBeInstanceOf(ExecutionRequestError)
    await expect(runtime.value({ jobId: 'job-1', nodeId: 'n1', outputId: 'result' })).resolves.toMatchObject({
      available: false, reason: 'capability-required', status: 403,
    })
    await expect(runtime.problems()).resolves.toEqual(expect.arrayContaining([
      cancelDenial,
      expect.objectContaining({
        code: 'execution.value.capability-required',
        message: 'jobs:read required',
        data: { status: 403, code: 'capability-required', operation: 'value' },
      }),
    ]))
    runtime.close()
  })

  it('long-polls for the next live normalized event', async () => {
    const { session, connection, emit } = fixture()
    const runtime = createAgentExecutionRuntime(session, 'http://example.test', 'agent-follow', { connection })
    const pending = runtime.events({ after: 0, jobId: 'job-live', waitMs: 1_000 })

    emit({
      kind: 'started',
      execution: { connection: asConnectionId('dinkster'), prompt: 'job-live' as never },
      timestamp: 15,
    })

    await expect(pending).resolves.toEqual({
      events: [{
        cursor: 1,
        event: {
          kind: 'started',
          execution: { connection: 'dinkster', prompt: 'job-live' },
          timestamp: 15,
        },
      }],
      nextCursor: 1,
      oldestCursor: 1,
      problems: [],
    })
    runtime.close()
  })

  it('replays a failed job once and exposes its canonical runtime Problem and event cursor', async () => {
    const { session, connection } = fixture()
    const collaborationProblem = {
      severity: 'error' as const,
      origin: 'collab' as const,
      code: 'collab.session',
      message: 'edit denied',
    }
    const runtime = createAgentExecutionRuntime(
      session,
      'http://example.test',
      'agent-c',
      { collaborationProblems: () => [collaborationProblem], connection },
    )

    const inspection = await runtime.inspect('job-failed')
    expect(inspection.job?.state).toBe('failed')
    expect(inspection.problems).toEqual([
      collaborationProblem,
      expect.objectContaining({
        severity: 'error',
        origin: 'runtime',
        code: 'runtime.validation',
        message: 'backend rejected input',
        runtime: expect.objectContaining({ exceptionType: 'validation' }),
      }),
    ])
    const first = await runtime.events({ jobId: 'job-failed' })
    expect(first.events).toEqual([
      expect.objectContaining({ cursor: 1, event: expect.objectContaining({ kind: 'error' }) }),
    ])
    await runtime.inspect('job-failed')
    expect((connection.replayJob as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    await expect(runtime.events({ jobId: 'job-failed', after: first.nextCursor })).resolves.toMatchObject({
      events: [],
      nextCursor: 1,
    })
    runtime.close()
  })
})
