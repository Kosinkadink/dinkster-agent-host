import { randomBytes } from 'node:crypto'
import {
  CollabHttpConnection,
  credentialFetch,
  createCollabSession,
  encodePresence,
  listCollabSessions,
  PRESENCE_MAX_PROPOSALS,
  PRESENCE_MAX_PROPOSAL_NOTE,
  PRESENCE_MAX_PROPOSAL_SETTING_ID,
  PRESENCE_MAX_PROPOSAL_VALUE,
  PRESENCE_VERSION,
  type CollabSessionRequestOptions,
  type SettingsProposal,
} from '@dinkster/client'
import {
  diag,
  asGraphDefId,
  asLineageId,
  connectSharedSession,
  coreCommandRegistry,
  type CollabDenial,
  type CollabSessionDescriptor,
  type CommandOutcome,
  type Diagnostic,
  type DocumentSession,
  type Json,
  type SharedDocumentSession,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  createAgentExecutionRuntime,
  type AgentExecutionRuntime,
} from './execution.js'

const SCOPE = 'shared'

export interface CreateSessionOptions extends CollabSessionRequestOptions {
  readonly documentId?: string
  readonly snapshot?: WorkflowDocument
  readonly token?: string | undefined
  readonly scope?: string | undefined
}

export interface AgentConnectOptions {
  readonly token?: string | undefined
  readonly onDiagnostic?: ((diagnostic: CollabDenial) => void) | undefined
  readonly actorId?: string
  readonly displayName?: string
  readonly owner?: string
  readonly harness?: string
}

export interface DispatchResult {
  readonly ok: boolean
  readonly diagnostics: readonly Diagnostic[]
  readonly outcome: CommandOutcome
}

export interface AgentSessionHandle extends AgentExecutionRuntime {
  readonly actorId: string
  getDocument(): WorkflowDocument
  dispatch(command: string, params: Json): DispatchResult
  proposeSetting(input: { readonly settingId: string; readonly value: Json; readonly note?: string }): string
  withdrawProposal(id: string): void
  settle(): Promise<void>
  close(): void
}

export interface PendingAgentConnection {
  readonly handle: Promise<AgentSessionHandle>
  close(): void
}

export function createAgentDocument(documentId = `agent-${Date.now().toString(36)}`): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId(documentId),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'Agent workspace',
        nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      },
    },
    view: { graphs: {} },
  }
}

export const defaultActorId = (): string =>
  `agent-${randomBytes(6).toString('base64url')}`

const waitForLive = async (
  session: SharedDocumentSession,
  targetRevision: number,
  connection: CollabHttpConnection,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await connection.waitForUserSession()
    const status = session.status.get()
    if (status === 'live' && session.revision >= targetRevision) return
    if (status === 'closed' || status === 'error') {
      throw new Error(`session became ${status} before it was live`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`session did not catch up to revision ${targetRevision}`)
}

const settleSharedSession = async (
  session: SharedDocumentSession,
  connection: CollabHttpConnection,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await connection.waitForUserSession()
    await session.settle()
    const status = session.status.get()
    if (status === 'live') return
    if (status === 'closed' || status === 'error') {
      throw new Error(`session became ${status} while acknowledging edits`)
    }
    const descriptor = await connection.fetchSession()
    if (descriptor === undefined) throw new Error('session ended while acknowledging edits')
    await waitForLive(session, descriptor.revision, connection)
  }
  throw new Error('session did not finish acknowledging edits')
}

export async function listSessions(baseUrl: string, token?: string, scope = SCOPE, options: CollabSessionRequestOptions = {}): Promise<readonly CollabSessionDescriptor[]> {
  return listCollabSessions(baseUrl.replace(/\/$/, ''), scope, credentialFetch({ token, actorKind: 'agent' }), options)
}

export async function createSession(
  baseUrl: string,
  options: CreateSessionOptions = {},
): Promise<CollabSessionDescriptor> {
  const snapshot = options.snapshot ?? createAgentDocument(options.documentId)
  return createCollabSession(baseUrl.replace(/\/$/, ''), {
    scope: options.scope ?? SCOPE,
    documentId: options.documentId ?? snapshot.lineage,
    snapshot,
  }, credentialFetch({ token: options.token, actorKind: 'agent' }), options)
}

export function createAgentHandle(
  session: DocumentSession & Partial<Pick<SharedDocumentSession, 'sendPresence'>>,
  settle: () => Promise<void> = async () => {},
  close: () => void = () => {},
  presence?: AgentConnectOptions,
  execution?: AgentExecutionRuntime,
): AgentSessionHandle {
  let presenceHeartbeat: ReturnType<typeof setInterval> | undefined
  let presenceFrame: Json | undefined
  let tool = 'connect'
  let activityStatus: 'running' | 'success' | 'error' = 'success'
  const proposals: SettingsProposal[] = []
  const publishPresence = (): void => {
    if (presence === undefined || session.sendPresence === undefined) return
    presenceFrame = encodePresence({
      graph: session.doc.root,
      cursor: undefined,
      selection: [],
      identity: {
        kind: 'agent',
        ...(presence.displayName !== undefined ? { displayName: presence.displayName } : {}),
        ...(presence.owner !== undefined ? { owner: presence.owner } : {}),
        ...(presence.harness !== undefined ? { harness: presence.harness } : {}),
      },
      ...(proposals.length > 0 ? { proposals } : {}),
      activity: {
        v: 1, type: 'agent_tool_call', tool, status: activityStatus,
        pendingAsks: proposals.map((p) => ({ id: p.id, prompt: p.note ?? `Change ${p.settingId}?` })),
      },
    })
    session.sendPresence(presenceFrame)
  }
  if (presence !== undefined) {
    publishPresence()
    presenceHeartbeat = setInterval(() => {
      if (presenceFrame !== undefined) session.sendPresence!(presenceFrame)
    }, 2000)
  }
  return {
    actorId: session.actorId,
    getDocument: () => structuredClone(session.doc),
    dispatch(command, params) {
      tool = command
      activityStatus = 'running'
      publishPresence()
      const outcome = session.dispatch({ command, params })
      if (!outcome.ok) {
        activityStatus = 'error'
        publishPresence()
      }
      return { ok: outcome.ok, diagnostics: outcome.diagnostics, outcome }
    },
    proposeSetting(input) {
      if (presence === undefined || session.sendPresence === undefined) throw new Error('setting proposals require a presence-enabled shared session')
      if (proposals.length >= PRESENCE_MAX_PROPOSALS) throw new Error(`setting proposal limit of ${PRESENCE_MAX_PROPOSALS} reached`)
      if (input.settingId.length === 0 || input.settingId.length > PRESENCE_MAX_PROPOSAL_SETTING_ID) {
        throw new Error(`settingId must be between 1 and ${PRESENCE_MAX_PROPOSAL_SETTING_ID} characters`)
      }
      if (input.note !== undefined && input.note.length > PRESENCE_MAX_PROPOSAL_NOTE) {
        throw new Error(`note must not exceed ${PRESENCE_MAX_PROPOSAL_NOTE} characters`)
      }
      let encodedValue: string | undefined
      try { encodedValue = JSON.stringify(input.value) } catch { /* handled below */ }
      if (encodedValue === undefined || encodedValue.length > PRESENCE_MAX_PROPOSAL_VALUE) {
        throw new Error(`value must be JSON no longer than ${PRESENCE_MAX_PROPOSAL_VALUE} characters`)
      }
      const id = `proposal-${randomBytes(9).toString('base64url')}`
      proposals.push({ id, ...input })
      publishPresence()
      return id
    },
    withdrawProposal(id) {
      const index = proposals.findIndex((proposal) => proposal.id === id)
      if (index === -1) return
      proposals.splice(index, 1)
      publishPresence()
    },
    compile: execution?.compile ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    submit: execution?.submit ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    cancel: execution?.cancel ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    inspect: execution?.inspect ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    events: execution?.events ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    outputs: execution?.outputs ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    value: execution?.value ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    problems: execution?.problems ?? (() => Promise.reject(new Error('execution tools require a Dinkster server connection'))),
    async settle() {
      try {
        await settle()
        if (activityStatus === 'running') activityStatus = 'success'
      } catch (error) {
        activityStatus = 'error'
        throw error
      } finally {
        publishPresence()
      }
    },
    close() {
      if (presenceHeartbeat !== undefined) clearInterval(presenceHeartbeat)
      if (presenceFrame !== undefined) session.sendPresence!({ v: PRESENCE_VERSION, gone: true })
      execution?.close()
      close()
    },
  }
}

export function beginConnect(
  baseUrl: string,
  sessionId: string,
  options: AgentConnectOptions = {},
): PendingAgentConnection {
  const actorId = options.actorId ?? defaultActorId()
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  const connection = new CollabHttpConnection({
    baseUrl: normalizedBaseUrl, sessionId, actorId, token: options.token, actorKind: 'agent',
    onDiagnostic: options.onDiagnostic,
  })
  let session: SharedDocumentSession | undefined
  let connectedHandle: AgentSessionHandle | undefined
  let closed = false
  const collaborationProblems: Diagnostic[] = []
  const handle = (async (): Promise<AgentSessionHandle> => {
    try {
      const connected = await connectSharedSession(connection, coreCommandRegistry(), {
        actorId,
        onError: (message) => collaborationProblems.push(
          diag('error', 'collab', 'collab.session', message),
        ),
      })
      session = connected
      connection.onEvent((event) => {
        if (event.kind === 'denial' && event.diagnostic.reason !== 'user-session-required') void connected.settle().catch(() => {})
      })
      if (connection.denial !== undefined) await connected.settle()
      if (closed) throw new Error('connection closed while joining')
      const descriptor = await connection.fetchSession()
      if (descriptor === undefined) throw new Error('session ended while joining')
      await waitForLive(connected, descriptor.revision, connection)
      if (closed) throw new Error('connection closed while joining')
      const settle = () => settleSharedSession(connected, connection)
      connectedHandle = createAgentHandle(
        connected,
        settle,
        () => connected.close(),
        options,
        createAgentExecutionRuntime(
          connected,
          normalizedBaseUrl,
          actorId,
          {
            collaborationProblems: () => collaborationProblems,
            beforeCompile: settle,
            ...(options.token === undefined ? {} : { token: options.token }),
          },
        ),
      )
      return connectedHandle
    } catch (error) {
      if (session === undefined) connection.close()
      else session.close()
      throw error
    }
  })()
  return {
    handle,
    close() {
      closed = true
      if (connectedHandle !== undefined) connectedHandle.close()
      else if (session === undefined) connection.close()
      else session.close()
    },
  }
}

export async function connect(
  baseUrl: string,
  sessionId: string,
  options: AgentConnectOptions = {},
): Promise<AgentSessionHandle> {
  return beginConnect(baseUrl, sessionId, options).handle
}
