import { describe, expect, it, vi } from 'vitest'
import { ExecutionRequestError } from '@dinkster/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AgentApi } from '../src/mcp.js'
import { createAgentMcpServer, createToolHandlers } from '../src/mcp.js'

describe('MCP tool handlers', () => {
  it('invokes tools in process and caches joined sessions', async () => {
    const handle = {
      actorId: 'agent-test',
      getDocument: vi.fn(() => ({ format: 'dinkster-workflow' }) as never),
      dispatch: vi.fn(() => ({ ok: false, diagnostics: [{ code: 'command.unknown' }], outcome: { ok: false } }) as never),
      compile: vi.fn(async () => ({ ok: false, diagnostics: [{ code: 'compile.test' }] }) as never),
      submit: vi.fn(async () => ({ ok: true, execution: { connection: 'dinkster', prompt: 'job-1' } }) as never),
      cancel: vi.fn(async () => {}),
      inspect: vi.fn(async () => ({ problems: [] })),
      events: vi.fn(async () => ({ events: [], nextCursor: 4, oldestCursor: 4, problems: [] })),
      outputs: vi.fn(async () => ({ node: { output: { typeId: 'INT' } } })),
      value: vi.fn(async () => ({ available: false, reason: 'unknown-output', status: 404, error: 'unknown output' }) as never),
      problems: vi.fn(async () => [{ code: 'compile.test' }] as never),
      proposeSetting: vi.fn(() => 'proposal-1'),
      withdrawProposal: vi.fn(),
      settle: vi.fn(async () => {}),
      close: vi.fn(),
    }
    const api: AgentApi = {
      listSessions: vi.fn(async () => [{ sessionId: 's1' }] as never),
      createSession: vi.fn(async () => ({ sessionId: 's2' }) as never),
      beginConnect: vi.fn(() => ({ handle: Promise.resolve(handle), close: handle.close })),
    }
    const host = createAgentMcpServer('http://example.test', 'agent-test', api)

    await expect(host.handlers.sessions_list()).resolves.toEqual([{ sessionId: 's1' }])
    await expect(host.handlers.session_create({ documentId: 'doc-1' })).resolves.toEqual({ sessionId: 's2' })
    await expect(host.handlers.commands_list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node.add' }),
    ]))
    await host.handlers.document_get({ sessionId: 's1' })
    const refused = await host.handlers.command_dispatch({
      sessionId: 's1', command: 'not.cataloged', params: {},
    })
    await host.handlers.document_compile({ sessionId: 's1', scope: { kind: 'full' } })
    await host.handlers.job_submit({ sessionId: 's1' })
    await host.handlers.job_cancel({ sessionId: 's1', jobId: 'job-1' })
    await host.handlers.job_inspect({ sessionId: 's1', jobId: 'job-1' })
    await host.handlers.execution_events({ sessionId: 's1', after: 3, jobId: 'job-1', waitMs: 10 })
    await host.handlers.job_outputs({ sessionId: 's1', jobId: 'job-1' })
    await host.handlers.value_get({ sessionId: 's1', jobId: 'job-1', nodeId: 'n1', outputId: 'out', element: [2] })
    await host.handlers.problems_get({ sessionId: 's1', jobId: 'job-1' })
    await expect(host.handlers.propose_setting({
      sessionId: 's1', settingId: 'canvas.grid.visible', value: false, note: 'Try it',
    })).resolves.toEqual({ proposalId: 'proposal-1' })
    await host.handlers.withdraw_proposal({ sessionId: 's1', proposalId: 'proposal-1' })

    expect(refused).toMatchObject({ ok: false, diagnostics: [{ code: 'command.unknown' }] })
    expect(api.beginConnect).toHaveBeenCalledTimes(1)
    expect(api.beginConnect).toHaveBeenCalledWith(
      'http://example.test',
      's1',
      expect.objectContaining({ actorId: 'agent-test', harness: 'mcp', owner: expect.any(String) }),
    )
    expect(handle.settle).toHaveBeenCalledOnce()
    expect(handle.compile).toHaveBeenCalledWith({ kind: 'full' })
    expect(handle.submit).toHaveBeenCalledWith(undefined)
    expect(handle.cancel).toHaveBeenCalledWith('job-1')
    expect(handle.inspect).toHaveBeenCalledWith('job-1')
    expect(handle.events).toHaveBeenCalledWith({ after: 3, jobId: 'job-1', waitMs: 10 })
    expect(handle.outputs).toHaveBeenCalledWith('job-1')
    expect(handle.value).toHaveBeenCalledWith({ jobId: 'job-1', nodeId: 'n1', outputId: 'out', element: [2] })
    expect(handle.problems).toHaveBeenCalledWith('job-1')
    expect(handle.proposeSetting).toHaveBeenCalledWith({ settingId: 'canvas.grid.visible', value: false, note: 'Try it' })
    expect(handle.withdrawProposal).toHaveBeenCalledWith('proposal-1')
    host.close()
    expect(handle.close).toHaveBeenCalledOnce()
    await expect(host.handlers.document_get({ sessionId: 's2' })).rejects.toThrow('agent host is closed')
  })

  it('cancels a pending join during shutdown', () => {
    const close = vi.fn()
    const api: AgentApi = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => ({}) as never),
      beginConnect: vi.fn(() => ({ handle: new Promise<never>(() => {}), close })),
    }
    const host = createToolHandlers('http://example.test', undefined, api)

    void host.handlers.document_get({ sessionId: 'pending' })
    host.close()

    expect(close).toHaveBeenCalledOnce()
  })

  it('returns structured execution denials from registered MCP callbacks', async () => {
    const diagnostic = (operation: string) => ({
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
    })
    const handle = {
      cancel: vi.fn(async () => { throw new ExecutionRequestError(diagnostic('cancel')) }),
      inspect: vi.fn(async () => { throw new ExecutionRequestError(diagnostic('inspect')) }),
      outputs: vi.fn(async () => { throw new ExecutionRequestError(diagnostic('outputs')) }),
      close: vi.fn(),
    }
    const api: AgentApi = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => ({}) as never),
      beginConnect: vi.fn(() => ({ handle: Promise.resolve(handle as never), close: handle.close })),
    }
    const host = createAgentMcpServer('http://example.test', 'agent-test', api)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'agent-host-test', version: '0.0.1' })
    await host.server.connect(serverTransport)
    await client.connect(clientTransport)

    for (const [tool, operation] of [
      ['job_cancel', 'cancel'],
      ['job_inspect', 'inspect'],
      ['job_outputs', 'outputs'],
    ] as const) {
      const response = await client.callTool({
        name: tool,
        arguments: { sessionId: 's1', jobId: 'job-1' },
      })
      expect(response.structuredContent).toEqual({
        result: { ok: false, diagnostics: [diagnostic(operation)] },
      })
    }

    await client.close()
    host.close()
    expect(handle.close).toHaveBeenCalledOnce()
  })
})
