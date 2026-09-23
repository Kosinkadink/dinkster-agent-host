/**
 * CollabHttpConnection: the concrete HTTP + WS transport behind the core's
 * CollabConnection seam (protocolVersion 1 collab surface, Dinkster
 * packages/dinkster-collab/src/dinkster_collab/routes.py).
 *
 * Division of labor, per the seam's contract: this adapter owns transport
 * mechanics ONLY - route shapes, status-code mapping, WS lifecycle/reconnect
 * (via the shared ReconnectingSocket), and frame-to-event shaping. Ordering,
 * catch-up, envelope validation, and every collaboration semantic live in
 * SharedDocumentSession (@dinkster/core); this module never interprets ops.
 *
 * Wire facts this file encodes (backend routes.py is the source of truth):
 * - Mutations are HTTP-only: POST /api/sessions/{id}/ops with the pinned
 *   envelope. 409 {"error":"stale-base","revision"} = rebase and resubmit;
 *   409 {"error":"snapshot-required",...} = checkpoint first; 406
 *   {"error":"protocol-version-unsupported","supported":[...]} = loud stop.
 * - GET .../ops?after=N answers 410 {"error":"resync-required",
 *   "snapshotRevision"} when N predates the retained log.
 * - PUT .../snapshot answers 409 {"error":"snapshot-invalid"} when the
 *   revision does not advance the checkpoint or is ahead of the session.
 * - The WS at .../events is delivery + ephemeral presence, never an op
 *   ingestion path. Frames: {"type":"session"} descriptor-first (the
 *   gap-free replay baseline), then {"type":"op"} replay/live frames,
 *   {"type":"presence"} relays from OTHER subscribers, and
 *   {"type":"session_closed"} on DELETE. Anything else is noise.
 * - A server-side slow-subscriber drop closes the socket; reconnect +
 *   catch-up is lossless (duplicates possible, gaps impossible - the
 *   session dedups by revision).
 * - A DELETED session refuses the WS upgrade before it becomes a socket
 *   (404), which a reconnect-forever policy cannot distinguish from a
 *   restarting server - and while the backend now guarantees
 *   session_closed is queued ahead of the server-initiated close for
 *   every registered subscriber (a delivery race we observed live and
 *   reported 2026-07-26 was fixed in Dinkster ac7f27e), that is an
 *   in-process ordering guarantee only: transport failure can still
 *   lose any WS frame. So while the WS is down, the adapter probes
 *   GET /api/sessions/{id}: a definite 404 resolves to a session-closed
 *   event; transient probe failures (server down) keep polling, symmetric
 *   with the socket's retry-forever backoff.
 */

import type {
  CollabClientOp,
  CollabDenial,
  CollabConnection,
  CollabConnectionEvent,
  CollabServerOp,
  CollabSessionDescriptor,
  FetchOpsOutcome,
  Json,
  PostOpOutcome,
  PutSnapshotOutcome,
  WorkflowDocument,
} from '@dinkster/core'
import type { FetchLike } from './connection-contract.js'
import { credentialFetch, type CollabCredentials } from './credentials.js'
import {
  ReconnectingSocket,
  type CancelFn,
  type ScheduleFn,
  type WebSocketFactory,
} from './reconnecting-socket.js'

// ---------------------------------------------------------------------------
// Session management (HTTP-only helpers; no WS involved)
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (url, init) => fetch(url, init)

async function jsonOrThrow(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await errorText(res)}`)
  return (await res.json()) as unknown
}

/** Best-effort {"error": ...} body extraction for thrown messages. */
async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown }
    if (typeof body?.error === 'string') {
      return typeof body.message === 'string' ? `${body.error}: ${body.message}` : body.error
    }
  } catch {
    // Non-JSON error body; the status alone is the message.
  }
  return ''
}

export interface CollabSessionRequestOptions {
  readonly signal?: AbortSignal
  readonly onDiagnostic?: ((diagnostic: CollabDenial) => void) | undefined
}

async function requiresUserSession(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const body = await response.clone().json().catch(() => null) as { error?: unknown } | null
  return body?.error === 'user-session-required'
}

async function authorizationBody(response: Response): Promise<{ error?: unknown; delegationId?: unknown } | null> {
  if (response.status !== 401 && response.status !== 403) return null
  return await response.clone().json().catch(() => null) as { error?: unknown; delegationId?: unknown } | null
}

function userSessionDiagnostic(context: Pick<CollabDenial, 'sessionId' | 'actorId' | 'operation'>): CollabDenial {
  return {
    version: 1, type: 'collab.denial', code: 'user-session-required', reason: 'user-session-required',
    status: 403, message: 'Agent paused until the user signs in', retryAfterMs: USER_SESSION_RETRY_MS,
    ...context,
  }
}

function authorizationDiagnostic(
  status: number,
  body: { error?: unknown; delegationId?: unknown } | null,
  context: Pick<CollabDenial, 'sessionId' | 'actorId' | 'operation'>,
): CollabDenial {
  const code = typeof body?.error === 'string' ? body.error : 'forbidden'
  const delegationId = typeof body?.delegationId === 'string' ? body.delegationId : undefined
  return {
    version: 1, type: 'collab.denial', code, status,
    message: delegationId === undefined ? `HTTP ${status}: ${code}` : `Delegation ${delegationId}: ${code}`,
    ...context,
    ...(delegationId !== undefined && { delegationId }),
  }
}

function notifyDiagnostic(callback: CollabSessionRequestOptions['onDiagnostic'], diagnostic: CollabDenial): void {
  try { callback?.(diagnostic) } catch { /* Observers cannot affect transport control flow. */ }
}

async function managementRequest(
  url: string, fetchFn: FetchLike, options: CollabSessionRequestOptions,
  context: Pick<CollabDenial, 'sessionId' | 'operation'>, init?: RequestInit,
): Promise<Response> {
  let suspended = false
  while (true) {
    options.signal?.throwIfAborted()
    let response: Response | undefined
    try {
      response = await fetchFn(url, { ...init, ...(options.signal !== undefined && { signal: options.signal }) })
    } catch (error) {
      // A failed create may already have committed; it has no idempotency key.
      if (!suspended || init?.method === 'POST' || options.signal?.aborted) throw error
    }
    const retryServerError = suspended && init?.method !== 'POST' && response !== undefined && response.status >= 500
    if (response !== undefined && !retryServerError) {
      const authorization = await authorizationBody(response)
      if (authorization?.error !== 'user-session-required') {
        if (response.status === 401 || response.status === 403) {
          notifyDiagnostic(options.onDiagnostic, authorizationDiagnostic(response.status, authorization, context))
        }
        return response
      }
    }
    if (!suspended) {
      suspended = true
      notifyDiagnostic(options.onDiagnostic, userSessionDiagnostic(context))
    }
    options.signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(options.signal?.reason) }
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve()
      }, USER_SESSION_RETRY_MS)
      options.signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

/** POST /api/sessions -> 201 descriptor. snapshot = the document at revision 0. */
export async function createCollabSession(
  baseUrl: string,
  args: {
    readonly scope: string
    readonly documentId: string
    readonly snapshot: unknown
    readonly documentKind?: 'workflow' | 'image'
  },
  fetchFn: FetchLike = defaultFetch,
  options: CollabSessionRequestOptions = {},
): Promise<CollabSessionDescriptor> {
  const res = await managementRequest(`${baseUrl}/api/sessions`, fetchFn, options, { operation: 'create-session' }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return (await jsonOrThrow(res, 'create session')) as CollabSessionDescriptor
}

/** GET /api/sessions?scope= -> one scope's descriptors. */
export async function listCollabSessions(
  baseUrl: string,
  scope: string,
  fetchFn: FetchLike = defaultFetch,
  options: CollabSessionRequestOptions = {},
): Promise<readonly CollabSessionDescriptor[]> {
  const res = await managementRequest(`${baseUrl}/api/sessions?scope=${encodeURIComponent(scope)}`, fetchFn, options, { operation: 'list-sessions' })
  const body = (await jsonOrThrow(res, 'list sessions')) as {
    sessions?: readonly CollabSessionDescriptor[]
  }
  return Array.isArray(body.sessions) ? body.sessions : []
}

/** GET /api/sessions/{id} -> descriptor; undefined when the session is gone (404). */
export async function getCollabSession(
  baseUrl: string,
  sessionId: string,
  fetchFn: FetchLike = defaultFetch,
  options: CollabSessionRequestOptions = {},
): Promise<CollabSessionDescriptor | undefined> {
  const res = await managementRequest(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, fetchFn, options, { operation: 'get-session', sessionId })
  if (res.status === 404) return undefined
  return (await jsonOrThrow(res, 'get session')) as CollabSessionDescriptor
}

/** DELETE /api/sessions/{id}: session_closed broadcast, sockets closed. */
export async function closeCollabSession(
  baseUrl: string,
  sessionId: string,
  fetchFn: FetchLike = defaultFetch,
  options: CollabSessionRequestOptions = {},
): Promise<void> {
  const res = await managementRequest(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, fetchFn, options, { operation: 'close-session', sessionId }, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`close session: HTTP ${res.status} ${await errorText(res)}`)
  }
}

// ---------------------------------------------------------------------------
// The transport adapter
// ---------------------------------------------------------------------------

export interface CollabHttpConnectionConfig extends CollabCredentials {
  /** HTTP base, no trailing slash. '' = same origin (dev proxy). */
  readonly baseUrl: string
  readonly sessionId: string
  /** Stamped on outbound presence frames (ops carry their own actorId). */
  readonly actorId: string
  readonly fetchFn?: FetchLike
  /** WS endpoint override; defaults to baseUrl with ws(s) scheme + the events route. */
  readonly wsUrl?: string
  readonly webSocketFactory?: WebSocketFactory
  readonly scheduleFn?: ScheduleFn
  readonly cancelFn?: CancelFn
  readonly onDiagnostic?: ((diagnostic: CollabDenial) => void) | undefined
}

/** Delay between gone-session probes while the WS is down. */
const PROBE_INTERVAL_MS = 2000
const USER_SESSION_RETRY_MS = 30_000

/** Pre-first-subscriber event buffer bound (matches server op retention). */
const PRE_SUBSCRIBE_BUFFER_CAP = 4096

export class CollabHttpConnection implements CollabConnection {
  readonly sessionId: string
  private readonly baseUrl: string
  private readonly actorId: string
  private readonly fetchFn: FetchLike
  private readonly authenticatedFetch: FetchLike
  private readonly onDiagnostic: CollabHttpConnectionConfig['onDiagnostic']
  private readonly socket: ReconnectingSocket
  private readonly scheduleFn: ScheduleFn
  private readonly cancelFn: CancelFn
  private readonly requests = new AbortController()
  private authorizationError: (Error & { diagnostic: NonNullable<CollabConnection['denial']> }) | undefined
  private userSession: { wait: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined
  private userSessionTimer: unknown
  private cancelProbe: (() => void) | undefined
  private readonly listeners = new Set<(event: CollabConnectionEvent) => void>()
  /**
   * Events that arrived before the FIRST subscriber, replayed to it in
   * order; undefined once flushed (or closed). Only the pre-subscription
   * window buffers - after the flush, events with no listeners drop, as
   * they always did.
   */
  private buffered: CollabConnectionEvent[] | undefined = []
  /**
   * The queue being drained by the first subscriber's flush; reentrant
   * events emitted while it drains append here, BEHIND the older buffered
   * events, so arrival order survives reentrancy.
   */
  private draining: CollabConnectionEvent[] | undefined
  private probing = false
  /**
   * Send seam captured from the socket's onOpen; undefined while the WS is
   * down. Presence is ephemeral noise-tolerant fan-out, so frames sent while
   * disconnected are dropped, never queued.
   */
  private wsSend: ((data: string) => void) | undefined
  private closed = false

  constructor(config: CollabHttpConnectionConfig) {
    this.sessionId = config.sessionId
    this.baseUrl = config.baseUrl
    this.actorId = config.actorId
    this.onDiagnostic = config.onDiagnostic
    const fetchFn = credentialFetch(config, config.fetchFn ?? defaultFetch)
    this.authenticatedFetch = fetchFn
    this.fetchFn = async (url, init) => {
      while (true) {
        if (this.userSession !== undefined) await this.waitForUserSession()
        if (this.closed) throw new Error('connection closed')
        if (this.authorizationError !== undefined) throw this.authorizationError
        const response = await fetchFn(url, { ...init, signal: this.requests.signal })
        if (this.authorizationError !== undefined) throw this.authorizationError
        if (!await requiresUserSession(response)) return response
        this.suspendForUserSession(init?.method ?? 'GET')
      }
    }
    this.scheduleFn = config.scheduleFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancelFn = config.cancelFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    const wsUrl =
      config.wsUrl ??
      `${config.baseUrl.replace(/^http/, 'ws')}/api/sessions/${encodeURIComponent(config.sessionId)}/events`
    this.socket = new ReconnectingSocket({
      url: wsUrl,
      ...((config.token !== undefined || config.actorKind === 'agent') && {
        resolveUrl: async () => {
          const response = await this.fetchFn(`${this.baseUrl}/api/auth/ws-ticket`, { method: 'POST' })
          await this.checkAuthorization(response, 'ws-ticket')
          const body = await jsonOrThrow(response, 'WebSocket authentication; supply a delegation with --token or DINKSTER_AGENT_TOKEN') as { ticket: string }
          return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(body.ticket)}`
        },
      }),
      ...(config.webSocketFactory !== undefined && { webSocketFactory: config.webSocketFactory }),
      ...(config.scheduleFn !== undefined && { scheduleFn: config.scheduleFn }),
      ...(config.cancelFn !== undefined && { cancelFn: config.cancelFn }),
      onOpen: (send) => {
        this.wsSend = send
      },
      onClose: (event) => {
        const close = event as { code?: unknown; reason?: unknown } | null
        if (close?.code === 1008 && close.reason === 'user-session-required') this.suspendForUserSession('events')
        if (close?.code === 1008 && typeof close.reason === 'string' && close.reason.startsWith('delegation-revoked:')) {
          const delegationId = close.reason.slice('delegation-revoked:'.length)
          this.denyAuthorization(authorizationDiagnostic(403, {
            error: 'delegation-revoked', delegationId,
          }, { sessionId: this.sessionId, actorId: this.actorId, operation: 'events' }))
        }
      },
      onData: (data) => this.handleFrame(data),
    })
    // Reconnection is the socket's job; the session catches up on 'connected'
    // (the descriptor frame). Surfacing the drop promptly lets the session
    // flip to catching-up instead of trusting a dead pipe. 'reconnecting' is
    // the one unexpected-drop status: deliberate close() never re-emits, and
    // the initial 'connecting' is not a drop.
    this.socket.status.subscribe((status) => {
      if (this.closed || this.authorizationError !== undefined || this.userSession !== undefined || status !== 'reconnecting') return
      if (this.wsSend !== undefined) {
        this.wsSend = undefined
        this.emit({ kind: 'disconnected' })
      }
      void this.probeWhileDisconnected()
    })
    this.socket.connect()
  }

  get denial(): CollabConnection['denial'] {
    return this.authorizationError?.diagnostic
  }

  async waitForUserSession(): Promise<void> {
    while (this.userSession !== undefined) await this.userSession.wait
    if (this.authorizationError !== undefined) throw this.authorizationError
    if (this.closed) throw new Error('connection closed')
  }

  async fetchSession(): Promise<CollabSessionDescriptor | undefined> {
    const response = await this.fetchFn(this.op(''))
    await this.checkAuthorization(response, 'session')
    if (response.status === 404) return undefined
    return await jsonOrThrow(response, 'get session') as CollabSessionDescriptor
  }

  private suspendForUserSession(operation: string): void {
    if (this.closed || this.authorizationError !== undefined || this.userSession !== undefined) return
    let resolve!: () => void
    let reject!: (error: Error) => void
    const wait = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void wait.catch(() => {})
    this.userSession = { wait, resolve, reject }
    this.wsSend = undefined
    this.socket.disconnect()
    this.cancelProbe?.()
    this.scheduleUserSessionRetry()
    this.emit({ kind: 'disconnected' })
    const diagnostic = userSessionDiagnostic({ sessionId: this.sessionId, actorId: this.actorId, operation })
    this.emit({ kind: 'denial', diagnostic })
    notifyDiagnostic(this.onDiagnostic, diagnostic)
  }

  private scheduleUserSessionRetry(): void {
    const suspended = this.userSession
    if (suspended === undefined || this.closed) return
    this.userSessionTimer = this.scheduleFn(() => {
      if (this.userSession === suspended) void this.retryUserSession()
    }, USER_SESSION_RETRY_MS)
  }

  private async retryUserSession(): Promise<void> {
    this.userSessionTimer = undefined
    const suspended = this.userSession
    if (suspended === undefined || this.closed || this.authorizationError !== undefined) return
    try {
      const response = await this.authenticatedFetch(this.op(''), { signal: this.requests.signal })
      if (this.closed || this.userSession !== suspended) return
      if (!await requiresUserSession(response)) {
        await this.checkAuthorization(response, 'session')
        if (this.closed || this.userSession !== suspended) return
        if (response.status === 404) {
          this.emit({ kind: 'session-closed' })
          this.close()
          return
        }
        if (response.ok) {
          this.userSession = undefined
          suspended.resolve()
          this.socket.connect()
          return
        }
      }
    } catch {
      // A transport failure does not establish that the user's session returned.
    }
    if (!this.closed && this.userSession === suspended && this.authorizationError === undefined) {
      this.scheduleUserSessionRetry()
    }
  }

  private stopUserSessionWait(error: Error): void {
    if (this.userSessionTimer !== undefined) this.cancelFn(this.userSessionTimer)
    this.userSessionTimer = undefined
    this.userSession?.reject(error)
    this.userSession = undefined
  }

  private async checkAuthorization(response: Response, operation: string): Promise<void> {
    if (response.status !== 401 && response.status !== 403) return
    const body = await authorizationBody(response)
    this.denyAuthorization(authorizationDiagnostic(response.status, body, {
      sessionId: this.sessionId, actorId: this.actorId, operation,
    }))
    throw this.authorizationError
  }

  private denyAuthorization(diagnostic: NonNullable<CollabConnection['denial']>): void {
    if (this.authorizationError === undefined) {
      this.authorizationError = Object.assign(new Error(JSON.stringify(diagnostic)), { diagnostic })
      this.wsSend = undefined
      this.socket.disconnect()
      this.cancelProbe?.()
      this.requests.abort()
      this.stopUserSessionWait(this.authorizationError)
      if (!this.closed) {
        this.emit({ kind: 'denial', diagnostic })
        notifyDiagnostic(this.onDiagnostic, diagnostic)
      }
    }
  }

  /**
   * While the WS is down, resolve the ambiguity a retry-forever socket
   * cannot: is the server restarting (keep retrying) or is the session GONE
   * (a deleted session refuses the upgrade with 404 forever)? A definite
   * 404 becomes a session-closed event - the owning session then closes
   * this connection. Network failures keep polling.
   */
  private async probeWhileDisconnected(): Promise<void> {
    if (this.probing) return
    this.probing = true
    try {
      while (!this.closed && this.authorizationError === undefined && this.userSession === undefined && this.socket.status.get() !== 'connected') {
        let gone = false
        try {
          const response = await this.fetchFn(this.op(''))
          await this.checkAuthorization(response, 'session')
          gone = response.status === 404
        } catch {
          // Server unreachable: indistinguishable from a restart; keep polling.
        }
        if (this.closed || this.authorizationError !== undefined || this.socket.status.get() === 'connected') return
        if (gone) {
          this.emit({ kind: 'session-closed' })
          return
        }
        await new Promise<void>((resolve) => {
          const handle = this.scheduleFn(resolve, PROBE_INTERVAL_MS)
          this.cancelProbe = () => { this.cancelFn(handle); resolve() }
        })
        this.cancelProbe = undefined
      }
    } finally {
      this.probing = false
    }
  }

  private op(path: string): string {
    return `${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}${path}`
  }

  async postOp(op: CollabClientOp): Promise<PostOpOutcome> {
    if (this.denial !== undefined) return { kind: 'forbidden', diagnostic: this.denial }
    let res: Response
    try {
      res = await this.fetchFn(this.op('/ops'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      })
    } catch (e) {
      if (this.denial !== undefined) return { kind: 'forbidden', diagnostic: this.denial }
      // Transport failure: the outcome is ambiguous; the session retries
      // with the SAME opId (idempotent within the retention window).
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as CollabServerOp | null
      if (body === null) return { kind: 'error', message: 'ops response was not JSON' }
      return { kind: 'accepted', op: body }
    }
    const body = (await res.json().catch(() => null)) as {
      error?: unknown
      revision?: unknown
      supported?: unknown
      retryAfterMs?: unknown
    } | null
    if (res.status === 409 && body?.error === 'stale-base' && typeof body.revision === 'number') {
      return { kind: 'stale-base', revision: body.revision }
    }
    if (res.status === 409 && body?.error === 'snapshot-required') {
      return { kind: 'snapshot-required' }
    }
    if (res.status === 406) {
      const supported = Array.isArray(body?.supported)
        ? body.supported.filter((v): v is number => typeof v === 'number')
        : []
      return { kind: 'protocol-unsupported', supported }
    }
    if (res.status === 401 || res.status === 403 || res.status === 429 || (res.status === 409 && body?.error === 'actor-principal-mismatch')) {
      const kind = res.status === 429 ? 'rate-limited' : res.status === 409 ? 'actor-principal-mismatch' : 'forbidden'
      const code = typeof body?.error === 'string' ? body.error : kind
      return {
        kind,
        diagnostic: {
          version: 1, type: 'collab.denial', code, status: res.status,
          message: `HTTP ${res.status}: ${code}`, sessionId: this.sessionId,
          actorId: op.actorId, opId: op.opId,
          ...(typeof body?.retryAfterMs === 'number' ? { retryAfterMs: body.retryAfterMs } : {}),
        },
      }
    }
    const detail = typeof body?.error === 'string' ? `: ${body.error}` : ''
    return { kind: 'error', message: `HTTP ${res.status}${detail}` }
  }

  async fetchSnapshot(): Promise<{ readonly revision: number; readonly document: unknown }> {
    const res = await this.fetchFn(this.op('/snapshot'))
    await this.checkAuthorization(res, 'fetch-snapshot')
    const body = (await jsonOrThrow(res, 'fetch snapshot')) as {
      revision?: unknown
      document?: unknown
    }
    if (typeof body.revision !== 'number') throw new Error('fetch snapshot: invalid revision')
    return { revision: body.revision, document: body.document }
  }

  async fetchOps(after: number): Promise<FetchOpsOutcome> {
    const res = await this.fetchFn(this.op(`/ops?after=${after}`))
    await this.checkAuthorization(res, 'fetch-ops')
    if (res.status === 410) {
      const body = (await res.json().catch(() => null)) as { snapshotRevision?: unknown } | null
      const snapshotRevision =
        typeof body?.snapshotRevision === 'number' ? body.snapshotRevision : 0
      return { kind: 'resync-required', snapshotRevision }
    }
    const body = (await jsonOrThrow(res, 'fetch ops')) as { ops?: readonly CollabServerOp[] }
    if (!Array.isArray(body.ops)) throw new Error('fetch ops: response missing ops array')
    return { kind: 'ops', ops: body.ops }
  }

  async putSnapshot(revision: number, document: WorkflowDocument): Promise<PutSnapshotOutcome> {
    const res = await this.fetchFn(this.op('/snapshot'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, document }),
    })
    await this.checkAuthorization(res, 'put-snapshot')
    if (res.status === 409) return { kind: 'conflict' }
    if (!res.ok) throw new Error(`put snapshot: HTTP ${res.status} ${await errorText(res)}`)
    return { kind: 'ok' }
  }

  sendPresence(payload: Json): void {
    // Fire-and-forget: presence never queues across a gap (stale presence is
    // worse than none) and is never stored server-side.
    this.wsSend?.(JSON.stringify({ type: 'presence', actorId: this.actorId, payload }))
  }

  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    // First subscriber: replay everything the wire delivered before anyone
    // was listening, in arrival order. The WS connects in the constructor,
    // so the descriptor frame (the catch-up baseline) and any replayed ops
    // can land while the joiner is still awaiting the HTTP snapshot - a
    // session subscribing afterwards must not lose them, or a rejoin never
    // catches up past the snapshot revision (found live, 2026-07-27).
    if (this.buffered !== undefined) {
      const queue = this.buffered
      this.buffered = undefined
      // Drain via a shared queue: a listener that synchronously provokes a
      // new frame (or the WS delivering during the flush) must not let that
      // frame overtake older buffered events - emit() appends to the drain
      // queue while it exists. A listener subscribing mid-flush receives the
      // remaining suffix (same as subscribing after the flush).
      this.draining = queue
      try {
        while (queue.length > 0) {
          if (this.closed) break
          const event = queue.shift()!
          for (const l of [...this.listeners]) l(event)
        }
      } finally {
        this.draining = undefined
      }
    }
    return () => this.listeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.wsSend = undefined
    this.buffered = undefined
    this.draining = undefined
    this.cancelProbe?.()
    this.stopUserSessionWait(new Error('connection closed'))
    this.socket.disconnect()
    this.listeners.clear()
  }

  private emit(event: CollabConnectionEvent): void {
    if (this.draining !== undefined) {
      // The first subscriber's flush is mid-drain: queue behind the older
      // buffered events so arrival order is preserved under reentrancy.
      this.draining.push(event)
      return
    }
    if (this.listeners.size === 0) {
      // Nobody listening yet: buffer until the first subscriber (bounded;
      // a drop is repaired by the session's ordered-ingress gap detection).
      // Presence and disconnected frames are NOT buffered: presence is
      // ephemeral noise that could flood the sole descriptor out of the cap,
      // and both are meaningless to a subscriber that was never connected.
      if (this.buffered !== undefined && event.kind !== 'presence' && event.kind !== 'disconnected') {
        this.buffered.push(event)
        if (this.buffered.length > PRE_SUBSCRIBE_BUFFER_CAP) {
          // Evict the oldest OP, never a descriptor or session_closed: a
          // legal maximum-retention replay is descriptor + 4096 ops - one
          // more event than the cap - and losing the descriptor strands
          // catch-up entirely (gap detection repairs a missing op, not a
          // missing baseline).
          const idx = this.buffered.findIndex((e) => e.kind === 'op')
          this.buffered.splice(idx === -1 ? 0 : idx, 1)
        }
      }
      return
    }
    for (const listener of [...this.listeners]) listener(event)
  }

  /**
   * Shape a WS frame into a CollabConnectionEvent. Structural shaping only -
   * descriptor/op envelope VALIDATION is the session's trust boundary, so a
   * malformed frame of a known type is still forwarded and refused loudly
   * there rather than vanishing here. Unknown frame types are noise (the
   * server may grow new frames; protocol changes announce themselves via
   * protocolVersion, not surprise frames).
   */
  private handleFrame(data: unknown): void {
    if (this.closed || this.authorizationError !== undefined || typeof data !== 'string') return
    let decoded: unknown
    try {
      decoded = JSON.parse(data)
    } catch {
      return
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return
    const frame = decoded as { type?: unknown } & Record<string, unknown>
    switch (frame.type) {
      case 'session': {
        const { type: _type, ...descriptor } = frame
        this.emit({
          kind: 'connected',
          descriptor: descriptor as unknown as CollabSessionDescriptor,
        })
        return
      }
      case 'op': {
        const { type: _type, ...op } = frame
        this.emit({ kind: 'op', op: op as unknown as CollabServerOp })
        return
      }
      case 'presence': {
        if (typeof frame.actorId !== 'string' || frame.actorId.length === 0) return
        this.emit(
          'payload' in frame
            ? { kind: 'presence', actorId: frame.actorId, payload: frame.payload as Json }
            : { kind: 'presence', actorId: frame.actorId },
        )
        return
      }
      case 'session_closed': {
        this.emit({ kind: 'session-closed' })
        return
      }
      default:
        return
    }
  }
}
