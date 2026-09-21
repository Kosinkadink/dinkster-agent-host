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
import type { FetchLike } from './connection.js'
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
): Promise<CollabSessionDescriptor> {
  const res = await fetchFn(`${baseUrl}/api/sessions`, {
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
): Promise<readonly CollabSessionDescriptor[]> {
  const res = await fetchFn(`${baseUrl}/api/sessions?scope=${encodeURIComponent(scope)}`)
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
): Promise<CollabSessionDescriptor | undefined> {
  const res = await fetchFn(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`)
  if (res.status === 404) return undefined
  return (await jsonOrThrow(res, 'get session')) as CollabSessionDescriptor
}

/** DELETE /api/sessions/{id}: session_closed broadcast, sockets closed. */
export async function closeCollabSession(
  baseUrl: string,
  sessionId: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<void> {
  const res = await fetchFn(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
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
}

/** Delay between gone-session probes while the WS is down. */
const PROBE_INTERVAL_MS = 2000

/** Pre-first-subscriber event buffer bound (matches server op retention). */
const PRE_SUBSCRIBE_BUFFER_CAP = 4096

export class CollabHttpConnection implements CollabConnection {
  readonly sessionId: string
  private readonly baseUrl: string
  private readonly actorId: string
  private readonly fetchFn: FetchLike
  private readonly socket: ReconnectingSocket
  private readonly scheduleFn: ScheduleFn
  private readonly cancelFn: CancelFn
  private readonly requests = new AbortController()
  private authorizationError: (Error & { diagnostic: NonNullable<CollabConnection['denial']> }) | undefined
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
    const fetchFn = credentialFetch(config, config.fetchFn ?? defaultFetch)
    this.fetchFn = async (url, init) => {
      if (this.authorizationError !== undefined) throw this.authorizationError
      const response = await fetchFn(url, { ...init, signal: this.requests.signal })
      if (this.authorizationError !== undefined) throw this.authorizationError
      return response
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
      onData: (data) => this.handleFrame(data),
    })
    // Reconnection is the socket's job; the session catches up on 'connected'
    // (the descriptor frame). Surfacing the drop promptly lets the session
    // flip to catching-up instead of trusting a dead pipe. 'reconnecting' is
    // the one unexpected-drop status: deliberate close() never re-emits, and
    // the initial 'connecting' is not a drop.
    this.socket.status.subscribe((status) => {
      if (this.closed || this.authorizationError !== undefined || status !== 'reconnecting') return
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

  private async checkAuthorization(response: Response, operation: string): Promise<void> {
    if (response.status !== 401 && response.status !== 403) return
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    const code = typeof body?.error === 'string' ? body.error : 'forbidden'
    if (this.authorizationError === undefined) {
      const diagnostic: NonNullable<CollabConnection['denial']> = {
        version: 1, type: 'collab.denial', code, status: response.status,
        message: `HTTP ${response.status}: ${code}`, sessionId: this.sessionId,
        actorId: this.actorId, operation,
      }
      this.authorizationError = Object.assign(new Error(JSON.stringify(diagnostic)), { diagnostic })
      this.wsSend = undefined
      this.socket.disconnect()
      this.cancelProbe?.()
      this.requests.abort()
      if (!this.closed) this.emit({ kind: 'denial', diagnostic })
    }
    throw this.authorizationError
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
      while (!this.closed && this.authorizationError === undefined && this.socket.status.get() !== 'connected') {
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
