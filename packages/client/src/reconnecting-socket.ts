/**
 * ReconnectingSocket: transport-level WS lifecycle shared by every protocol
 * connection (Comfy v1 /ws, native Dinkster /api/events). Owns exactly the
 * things that are protocol-free: open/close, the status signal, and the
 * retry-forever exponential backoff. Protocol framing and message meaning
 * stay in the owning connection - this module never parses payloads.
 */

import { createSignal, type ReadonlySignal } from '@dinkster/core'

/** The subset of WebSocket the connection uses; injectable for tests. */
export interface WebSocketLike {
  binaryType: string
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

/** Injectable timer pair so reconnect backoff is deterministic in tests. */
export type ScheduleFn = (fn: () => void, ms: number) => unknown
export type CancelFn = (handle: unknown) => void

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface ReconnectingSocketConfig {
  readonly url: string
  readonly resolveUrl?: () => Promise<string>
  readonly webSocketFactory?: WebSocketFactory
  readonly scheduleFn?: ScheduleFn
  readonly cancelFn?: CancelFn
  /**
   * Runs on every successful open, before status flips to 'connected' - the
   * place for protocol handshakes that MUST be the first client message
   * (e.g. Comfy v1 feature negotiation).
   */
  readonly onOpen?: (send: (data: string) => void) => void
  /** Every inbound message's raw data (string or ArrayBuffer). */
  readonly onData: (data: unknown) => void
}

export class ReconnectingSocket {
  private readonly config: ReconnectingSocketConfig
  private readonly scheduleFn: ScheduleFn
  private readonly cancelFn: CancelFn
  private ws: WebSocketLike | undefined
  /** Consecutive failed (re)connect attempts; resets on a successful open. */
  private reconnectAttempts = 0
  private reconnectHandle: unknown
  /**
   * Invalidates queued reconnect callbacks. cancelFn is best-effort: an
   * injected scheduler may have already queued (or be mid-invoking) the
   * callback when disconnect() cancels the handle, and a stale callback must
   * neither open a socket after a deliberate close nor clear a NEWER
   * reconnect handle scheduled by a later connect cycle.
   */
  private reconnectGeneration = 0
  /** True between disconnect() and the next connect(): closes are on purpose. */
  private deliberateClose = true

  private readonly statusSignal = createSignal<ConnectionStatus>('disconnected')
  readonly status: ReadonlySignal<ConnectionStatus> = this.statusSignal

  constructor(config: ReconnectingSocketConfig) {
    this.config = config
    this.scheduleFn = config.scheduleFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancelFn =
      config.cancelFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  connect(): void {
    this.deliberateClose = false
    this.openSocket()
  }

  private openSocket(): void {
    if (this.ws) return
    if (this.config.resolveUrl !== undefined) {
      const generation = this.reconnectGeneration
      this.statusSignal.set(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
      void this.config.resolveUrl().then((url) => {
        if (generation === this.reconnectGeneration && !this.deliberateClose) this.createSocket(url)
      }).catch(() => {
        if (generation === this.reconnectGeneration && !this.deliberateClose) this.scheduleReconnect()
      })
      return
    }
    this.createSocket(this.config.url)
  }

  private createSocket(url: string): void {
    if (this.ws) return
    const factory =
      this.config.webSocketFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
    this.statusSignal.set(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')
    const ws = factory(url)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      if (this.ws !== ws || this.deliberateClose) return
      this.config.onOpen?.((data) => ws.send(data))
      this.reconnectAttempts = 0
      this.statusSignal.set('connected')
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.deliberateClose) return
      this.config.onData(ev.data)
    }
    ws.onclose = () => {
      // A close from a superseded socket must not touch current state
      // (disconnect() + connect() can race an in-flight async close).
      if (this.ws !== ws) return
      this.ws = undefined
      if (this.deliberateClose) {
        this.statusSignal.set('disconnected')
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      if (this.ws !== ws || this.deliberateClose) return
      // onclose follows; the reconnect policy lives there.
    }
    this.ws = ws
  }

  /**
   * Unexpected close: retry forever with exponential backoff (500ms doubling
   * to an 8s cap - the server may be restarting, which takes a while). The
   * same clientId re-associates the server session on reconnect, so event
   * routing for in-flight executions resumes; the gap itself is healed by
   * reconciliation when status returns to 'connected'.
   */
  private scheduleReconnect(): void {
    if (this.reconnectHandle !== undefined) return
    this.statusSignal.set('reconnecting')
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 8000)
    this.reconnectAttempts += 1
    const generation = this.reconnectGeneration
    this.reconnectHandle = this.scheduleFn(() => {
      // A stale callback (its generation was invalidated by disconnect())
      // must not reopen a deliberately closed socket, and must not clear a
      // newer cycle's reconnect handle.
      if (generation !== this.reconnectGeneration || this.deliberateClose) return
      this.reconnectHandle = undefined
      this.openSocket()
    }, delay)
  }

  disconnect(): void {
    this.deliberateClose = true
    this.reconnectGeneration += 1
    if (this.reconnectHandle !== undefined) {
      this.cancelFn(this.reconnectHandle)
      this.reconnectHandle = undefined
    }
    this.reconnectAttempts = 0
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
    }
    this.statusSignal.set('disconnected')
  }

  /**
   * Force-close the socket WITHOUT marking it deliberate, exactly as if the
   * transport died: the reconnect policy takes over. For diagnostics and
   * tests (the e2e reconnect suite drives this through the test bridge).
   */
  simulateConnectionLoss(): void {
    this.ws?.close()
  }
}
