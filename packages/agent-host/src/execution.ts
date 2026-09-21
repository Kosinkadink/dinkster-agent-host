import {
  DinksterConnection,
  ExecutionRequestError,
  ExecutionStore,
  type DinksterJobRecord,
  type DinksterSubmitResult,
  type ExecutionState,
  type SchemaRegistry,
  type ValuePeekResult,
  type ValueQuery,
} from '@dinkster/client'
import {
  asConnectionId,
  asPromptId,
  canonicalJson,
  compile,
  diagnosticBlocksExecution,
  type CompileResult,
  type Diagnostic,
  type DocumentSession,
  type ExecutionRef,
  type ExecutionScope,
  type NormalizedEvent,
} from '@dinkster/core'

const EVENT_LIMIT = 1_000

export interface ExecutionEventPage {
  readonly events: readonly { readonly cursor: number; readonly event: NormalizedEvent }[]
  readonly nextCursor: number
  readonly oldestCursor: number
  readonly problems: readonly Diagnostic[]
}

export interface ExecutionInspection {
  readonly job?: DinksterJobRecord
  readonly state?: ExecutionState
  readonly problems: readonly Diagnostic[]
}

export interface AgentExecutionRuntime {
  compile(scope?: ExecutionScope): Promise<CompileResult>
  submit(scope?: ExecutionScope): Promise<DinksterSubmitResult>
  cancel(jobId: string): Promise<void>
  inspect(jobId: string): Promise<ExecutionInspection>
  events(input?: { readonly after?: number; readonly jobId?: string; readonly waitMs?: number }): Promise<ExecutionEventPage>
  outputs(jobId: string): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  value(query: ValueQuery): Promise<ValuePeekResult>
  problems(jobId?: string): Promise<readonly Diagnostic[]>
  close(): void
}

export interface AgentExecutionConnection {
  fetchSchemas(): Promise<SchemaRegistry>
  submit(artifact: Parameters<DinksterConnection['submit']>[0]): Promise<DinksterSubmitResult>
  cancel(execution: ExecutionRef): Promise<void>
  fetchJob(jobId: string): Promise<DinksterJobRecord | undefined>
  replayJob(jobId: string, job: DinksterJobRecord): void
  fetchJobOutputs(jobId: string): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  values(): { peek(query: ValueQuery): Promise<ValuePeekResult> }
  onEvent(listener: (event: NormalizedEvent) => void): () => void
  onProblem?(listener: (problem: Diagnostic) => void): () => void
  connect(): void
  disconnect(): void
}

export interface AgentExecutionRuntimeOptions {
  readonly collaborationProblems?: () => readonly Diagnostic[]
  readonly beforeCompile?: () => Promise<void>
  readonly connection?: AgentExecutionConnection
  readonly token?: string
}

export interface ExecutionDenialResult {
  readonly ok: false
  readonly diagnostics: readonly [Diagnostic]
}

export async function captureExecutionDenial<T>(request: () => Promise<T>): Promise<T | ExecutionDenialResult> {
  try {
    return await request()
  } catch (error) {
    if (error instanceof ExecutionRequestError) {
      return { ok: false, diagnostics: [error.diagnostic] }
    }
    throw error
  }
}

const eventJobId = (event: NormalizedEvent): string | undefined =>
  'execution' in event ? event.execution.prompt : undefined

export function createAgentExecutionRuntime(
  session: DocumentSession,
  baseUrl: string,
  actorId: string,
  options: AgentExecutionRuntimeOptions = {},
): AgentExecutionRuntime {
  const connectionId = asConnectionId('dinkster')
  const connection = options.connection ?? new DinksterConnection({
    id: connectionId,
    baseUrl,
    clientId: actorId,
    token: options.token,
    actorKind: 'agent',
  })
  const store = new ExecutionStore()
  const buffered: { cursor: number; event: NormalizedEvent }[] = []
  const replayedJobRecords = new Map<string, string>()
  const operationProblems = new Map<string, Diagnostic>()
  const wake = new Set<() => void>()
  let cursor = 0
  let compileProblems: readonly Diagnostic[] = []
  let closed = false

  const rememberProblem = (problem: Diagnostic): void => {
    operationProblems.set(`${problem.code}\n${problem.message}\n${JSON.stringify(problem.data ?? {})}`, problem)
    for (const resolve of wake) resolve()
    wake.clear()
  }

  const rememberThrownProblem = (error: unknown): void => {
    if (error instanceof ExecutionRequestError) rememberProblem(error.diagnostic)
  }

  const unsubscribe = connection.onEvent((event) => {
    store.apply(event)
    buffered.push({ cursor: ++cursor, event })
    if (buffered.length > EVENT_LIMIT) buffered.shift()
    for (const resolve of wake) resolve()
    wake.clear()
  })
  const unsubscribeProblems = connection.onProblem?.(rememberProblem) ?? (() => {})
  connection.connect()

  const execution = (jobId: string): ExecutionRef => ({
    connection: connectionId,
    prompt: asPromptId(jobId),
  })

  const compileDocument = async (scope: ExecutionScope = { kind: 'full' }): Promise<CompileResult> => {
    await options.beforeCompile?.()
    const registry = await connection.fetchSchemas()
    const result = compile({
      document: session.doc,
      revision: session.revision,
      resolve: registry.resolve,
      scope,
      connection: connectionId,
      schemaHash: registry.hash,
      pickCandidate: ({ count }) => Math.floor(Math.random() * count),
      ...(registry.graphFeatures === undefined ? {} : { graphFeatures: registry.graphFeatures }),
    })
    compileProblems = result.ok ? result.artifact.diagnostics : result.diagnostics
    return result
  }

  const replay = async (jobId: string): Promise<DinksterJobRecord | undefined> => {
    const job = await connection.fetchJob(jobId)
    if (job === undefined) return undefined
    const record = canonicalJson(job)
    if (replayedJobRecords.get(jobId) !== record) {
      replayedJobRecords.set(jobId, record)
      connection.replayJob(jobId, job)
    }
    return job
  }

  const problemList = (jobId?: string): readonly Diagnostic[] => {
    const runtime = jobId === undefined
      ? [...store.executions.get().values()].flatMap((state) => state.errors)
      : store.get(execution(jobId))?.errors ?? []
    return [
      ...compileProblems,
      ...(options.collaborationProblems?.() ?? []),
      ...operationProblems.values(),
      ...runtime,
    ]
  }

  return {
    compile: compileDocument,
    async submit(scope = { kind: 'full' }) {
      const result = await compileDocument(scope)
      if (!result.ok) return result
      if (result.artifact.diagnostics.some(diagnosticBlocksExecution)) {
        return { ok: false, diagnostics: result.artifact.diagnostics }
      }
      const submitted = await connection.submit(result.artifact)
      if (submitted.ok) {
        store.register(submitted.execution, result.artifact, Date.now(), {
          ...(submitted.jobRef === undefined ? {} : { jobRef: submitted.jobRef }),
        })
      } else for (const problem of submitted.diagnostics) rememberProblem(problem)
      return submitted
    },
    async cancel(jobId) {
      try { await connection.cancel(execution(jobId)) }
      catch (error) { rememberThrownProblem(error); throw error }
    },
    async inspect(jobId) {
      let job: DinksterJobRecord | undefined
      try { job = await replay(jobId) }
      catch (error) { rememberThrownProblem(error); throw error }
      const state = store.get(execution(jobId))
      return {
        ...(job === undefined ? {} : { job }),
        ...(state === undefined ? {} : { state }),
        problems: problemList(jobId),
      }
    },
    async events(input = {}) {
      const after = input.after ?? 0
      if (input.jobId !== undefined) await replay(input.jobId)
      const select = () => buffered.filter((entry) =>
        entry.cursor > after && (input.jobId === undefined || eventJobId(entry.event) === input.jobId),
      )
      if (select().length === 0 && (input.waitMs ?? 0) > 0 && !closed) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timeout)
            wake.delete(done)
            resolve()
          }
          const timeout = setTimeout(done, input.waitMs)
          wake.add(done)
        })
      }
      return {
        events: select(),
        nextCursor: cursor,
        oldestCursor: buffered[0]?.cursor ?? cursor,
        problems: [...operationProblems.values()],
      }
    },
    async outputs(jobId) {
      try { return await connection.fetchJobOutputs(jobId) }
      catch (error) { rememberThrownProblem(error); throw error }
    },
    async value(query) {
      const result = await connection.values().peek(query)
      if (!result.available && (result.status === 401 || result.status === 403)) {
        rememberProblem({
          severity: 'error',
          origin: 'runtime',
          code: `execution.value.${result.reason}`,
          message: result.error,
          data: { status: result.status, code: result.reason, operation: 'value' },
        })
      }
      return result
    },
    async problems(jobId) {
      await compileDocument()
      if (jobId !== undefined) await replay(jobId)
      return problemList(jobId)
    },
    close() {
      if (closed) return
      closed = true
      unsubscribe()
      unsubscribeProblems()
      connection.disconnect()
      for (const resolve of wake) resolve()
      wake.clear()
    },
  }
}
