import { userInfo } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import type { ExecutionScope, Json } from '@dinkster/core'
import {
  beginConnect,
  createSession,
  listSessions,
  type AgentConnectOptions,
  type PendingAgentConnection,
} from './api.js'
import { commandCatalog } from './catalog.js'
import { captureExecutionDenial } from './execution.js'

export interface AgentApi {
  listSessions(baseUrl: string, token?: string, scope?: string): ReturnType<typeof listSessions>
  createSession(baseUrl: string, options?: Parameters<typeof createSession>[1]): ReturnType<typeof createSession>
  beginConnect(baseUrl: string, sessionId: string, options?: AgentConnectOptions): PendingAgentConnection
}

export interface AgentToolHandlers {
  sessions_list(): Promise<unknown>
  session_create(args: { documentId?: string | undefined }): Promise<unknown>
  commands_list(): Promise<unknown>
  document_get(args: { sessionId: string }): Promise<unknown>
  command_dispatch(args: { sessionId: string; command: string; params: Json }): Promise<unknown>
  document_compile(args: { sessionId: string; scope?: ExecutionScope | undefined }): Promise<unknown>
  job_submit(args: { sessionId: string; scope?: ExecutionScope | undefined }): Promise<unknown>
  job_cancel(args: { sessionId: string; jobId: string }): Promise<unknown>
  job_inspect(args: { sessionId: string; jobId: string }): Promise<unknown>
  execution_events(args: { sessionId: string; after?: number | undefined; jobId?: string | undefined; waitMs?: number | undefined }): Promise<unknown>
  job_outputs(args: { sessionId: string; jobId: string }): Promise<unknown>
  value_get(args: { sessionId: string; jobId: string; nodeId: string; outputId: string; element?: readonly number[] | undefined }): Promise<unknown>
  problems_get(args: { sessionId: string; jobId?: string | undefined }): Promise<unknown>
  propose_setting(args: { sessionId: string; settingId: string; value: Json; note?: string | undefined }): Promise<{ proposalId: string }>
  withdraw_proposal(args: { sessionId: string; proposalId: string }): Promise<void>
}

const productionApi: AgentApi = { listSessions, createSession, beginConnect }

export function createToolHandlers(
  baseUrl: string,
  actorId?: string,
  api: AgentApi = productionApi,
  credentials: { token?: string | undefined; scope?: string | undefined } = {},
): { handlers: AgentToolHandlers; close: () => void } {
  const sessions = new Map<string, PendingAgentConnection>()
  let closed = false
  const joined = (sessionId: string) => {
    if (closed) throw new Error('agent host is closed')
    let pending = sessions.get(sessionId)
    if (pending === undefined) {
      pending = api.beginConnect(baseUrl, sessionId, {
        token: credentials.token,
        ...(actorId !== undefined ? { actorId } : {}),
        harness: 'mcp',
        owner: userInfo().username,
      })
      sessions.set(sessionId, pending)
      void pending.handle.catch(() => sessions.delete(sessionId))
    }
    return pending.handle
  }
  const handlers: AgentToolHandlers = {
    sessions_list: () => api.listSessions(baseUrl, credentials.token, credentials.scope),
    session_create: (args) => api.createSession(baseUrl, { ...credentials, ...(args.documentId && { documentId: args.documentId }) }),
    commands_list: async () => commandCatalog,
    document_get: async ({ sessionId }) => (await joined(sessionId)).getDocument(),
    command_dispatch: async ({ sessionId, command, params }) => {
      const handle = await joined(sessionId)
      const result = handle.dispatch(command, params)
      await handle.settle()
      return result
    },
    document_compile: async ({ sessionId, scope }) => (await joined(sessionId)).compile(scope),
    job_submit: async ({ sessionId, scope }) => (await joined(sessionId)).submit(scope),
    job_cancel: async ({ sessionId, jobId }) => captureExecutionDenial(async () => {
      await (await joined(sessionId)).cancel(jobId)
      return { cancelled: jobId }
    }),
    job_inspect: async ({ sessionId, jobId }) => captureExecutionDenial(
      async () => (await joined(sessionId)).inspect(jobId),
    ),
    execution_events: async ({ sessionId, after, jobId, waitMs }) => (await joined(sessionId)).events({
      ...(after === undefined ? {} : { after }),
      ...(jobId === undefined ? {} : { jobId }),
      ...(waitMs === undefined ? {} : { waitMs }),
    }),
    job_outputs: async ({ sessionId, jobId }) => captureExecutionDenial(
      async () => (await joined(sessionId)).outputs(jobId),
    ),
    value_get: async ({ sessionId, jobId, nodeId, outputId, element }) => (await joined(sessionId)).value({
      jobId, nodeId, outputId, ...(element === undefined ? {} : { element }),
    }),
    problems_get: async ({ sessionId, jobId }) => (await joined(sessionId)).problems(jobId),
    propose_setting: async ({ sessionId, settingId, value, note }) => ({
      proposalId: (await joined(sessionId)).proposeSetting({ settingId, value, ...(note !== undefined ? { note } : {}) }),
    }),
    withdraw_proposal: async ({ sessionId, proposalId }) => {
      (await joined(sessionId)).withdrawProposal(proposalId)
    },
  }
  return {
    handlers,
    close: () => {
      closed = true
      for (const pending of sessions.values()) pending.close()
      sessions.clear()
    },
  }
}

const result = (value: unknown) => {
  const structuredContent = { result: value }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  }
}

const occurrenceSchema = z.object({
  instancePath: z.array(z.string()),
  node: z.string(),
})

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full') }),
  z.object({ kind: z.literal('partial'), targets: z.array(occurrenceSchema).min(1) }),
])

export function createAgentMcpServer(
  baseUrl: string,
  actorId?: string,
  api: AgentApi = productionApi,
  credentials: { token?: string | undefined; scope?: string | undefined } = {},
): { server: McpServer; handlers: AgentToolHandlers; close: () => void } {
  const server = new McpServer({ name: '@dinkster/agent-host', version: '0.0.1' })
  const tools = createToolHandlers(baseUrl, actorId, api, credentials)
  server.registerTool('sessions_list', {
    description: 'List active shared Dinkster sessions.',
  }, async () => result(await tools.handlers.sessions_list()))
  server.registerTool('session_create', {
    description: 'Create an empty shared Dinkster session.',
    inputSchema: { documentId: z.string().optional() },
  }, async (args) => result(await tools.handlers.session_create(args)))
  server.registerTool('commands_list', {
    description: 'List the full Dinkster command registry.',
  }, async () => result(await tools.handlers.commands_list()))
  server.registerTool('document_get', {
    description: 'Get the current document for a shared session.',
    inputSchema: { sessionId: z.string() },
  }, async (args) => result(await tools.handlers.document_get(args)))
  server.registerTool('command_dispatch', {
    description: 'Dispatch any Dinkster command; refusals are returned as diagnostics.',
    inputSchema: {
      sessionId: z.string(),
      command: z.string(),
      params: z.json(),
    },
  }, async (args) => result(await tools.handlers.command_dispatch(args as {
    sessionId: string; command: string; params: Json
  })))
  server.registerTool('document_compile', {
    description: 'Compile the current session document and return canonical diagnostics or an artifact.',
    inputSchema: { sessionId: z.string(), scope: scopeSchema.optional() },
  }, async (args) => result(await tools.handlers.document_compile(args as {
    sessionId: string; scope?: ExecutionScope
  })))
  server.registerTool('job_submit', {
    description: 'Compile and submit the current session document as this agent.',
    inputSchema: { sessionId: z.string(), scope: scopeSchema.optional() },
  }, async (args) => result(await tools.handlers.job_submit(args as {
    sessionId: string; scope?: ExecutionScope
  })))
  server.registerTool('job_cancel', {
    description: 'Cancel one job submitted under this agent actor id.',
    inputSchema: { sessionId: z.string(), jobId: z.string() },
  }, async (args) => result(await tools.handlers.job_cancel(args)))
  server.registerTool('job_inspect', {
    description: 'Fetch and replay one retained job, including its structured Problems.',
    inputSchema: { sessionId: z.string(), jobId: z.string() },
  }, async (args) => result(await tools.handlers.job_inspect(args)))
  server.registerTool('execution_events', {
    description: 'Read normalized execution events after a cursor, optionally waiting for a new event.',
    inputSchema: {
      sessionId: z.string(),
      after: z.number().int().nonnegative().optional(),
      jobId: z.string().optional(),
      waitMs: z.number().int().min(0).max(30_000).optional(),
    },
  }, async (args) => result(await tools.handlers.execution_events(args)))
  server.registerTool('job_outputs', {
    description: 'Fetch retained output descriptors for one job.',
    inputSchema: { sessionId: z.string(), jobId: z.string() },
  }, async (args) => result(await tools.handlers.job_outputs(args)))
  server.registerTool('value_get', {
    description: 'Inspect one retained output value; structured refusals are returned as data.',
    inputSchema: {
      sessionId: z.string(), jobId: z.string(), nodeId: z.string(), outputId: z.string(),
      element: z.array(z.number().int().nonnegative()).optional(),
    },
  }, async (args) => result(await tools.handlers.value_get(args)))
  server.registerTool('problems_get', {
    description: 'Compile the current document and return compile, collaboration, and optional job Problems.',
    inputSchema: { sessionId: z.string(), jobId: z.string().optional() },
  }, async (args) => result(await tools.handlers.problems_get(args)))
  server.registerTool('propose_setting', {
    description: 'Propose a browser setting change for a human participant to review and apply.',
    inputSchema: {
      sessionId: z.string(),
      settingId: z.string(),
      value: z.json(),
      note: z.string().optional(),
    },
  }, async (args) => result(await tools.handlers.propose_setting(args as {
    sessionId: string; settingId: string; value: Json; note?: string
  })))
  server.registerTool('withdraw_proposal', {
    description: 'Withdraw a browser setting proposal from a shared session.',
    inputSchema: { sessionId: z.string(), proposalId: z.string() },
  }, async (args) => result(await tools.handlers.withdraw_proposal(args)))
  return { server, handlers: tools.handlers, close: tools.close }
}
