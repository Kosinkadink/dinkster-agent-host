/**
 * BackendConnection: one ComfyUI server = one connection.
 *
 * Owns the quarantined current-protocol surface: /object_info fetch (parsed
 * once into normalized NodeSchemas), /prompt submission, and the WS stream
 * (JSON envelopes + binary preview frames) normalized through
 * ComfyV1Normalizer. Everything downstream sees only normalized models and
 * NormalizedEvents carrying (connectionId, promptId).
 *
 * Transports (fetch, WebSocket) are injected so the connection runs in tests
 * and node unchanged.
 */

import {
  asPromptId,
  canonicalJson,
  diag,
  fnv1a64,
  parseOccurrenceKey,
  schemaForEditorRole,
  type CompileArtifact,
  type ConnectionId,
  type Diagnostic,
  type NormalizedEvent,
  type PromptId,
  type ReadonlySignal,
  type SchemaResolver,
} from '@dinkster/core'
import {
  ComfyV1Normalizer,
  parseObjectInfo,
  type ObjectInfoEntry,
  type RawJsonMessage,
  type RawMessage,
} from '@dinkster/core/comfy-v1'
import type { FetchLike, SchemaRegistry, SubmitResult } from './connection-contract.js'
import {
  ReconnectingSocket,
  type CancelFn,
  type ConnectionStatus,
  type ScheduleFn,
  type WebSocketFactory,
} from './reconnecting-socket.js'

export function buildSchemaRegistry(
  connection: ConnectionId,
  raw: Readonly<Record<string, ObjectInfoEntry>>,
): SchemaRegistry {
  const { schemas, diagnostics } = parseObjectInfo(raw)
  const resolve: SchemaResolver = Object.assign((type: string) => schemas.get(type), {
    forEditorRole: (role: string) => schemaForEditorRole(schemas.values(), role),
  })
  return {
    connection,
    hash: fnv1a64(canonicalJson(raw)),
    schemas,
    diagnostics,
    resolve,
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export interface ConnectionConfig {
  readonly id: ConnectionId
  /** HTTP base, no trailing slash. '' = same origin (dev proxy). */
  readonly baseUrl: string
  /** Stable per-session client id; the server routes WS events by it. */
  readonly clientId: string
  /** WS endpoint override; defaults to baseUrl with ws(s) scheme + /ws. */
  readonly wsUrl?: string
  readonly fetchFn?: FetchLike
  readonly webSocketFactory?: WebSocketFactory
  readonly scheduleFn?: ScheduleFn
  readonly cancelFn?: CancelFn
}

/**
 * URL for a V1 server-side output/preview image (the /view endpoint).
 * Standalone so callers that only know a backend's base URL (not its
 * connection object) can still route historical V1 file refs.
 */
export function v1ViewUrl(
  baseUrl: string,
  file: { filename: string; subfolder?: string; type?: string },
): string {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder ?? '',
    type: file.type ?? 'output',
  })
  return `${baseUrl}/view?${params}`
}

/** One prompt's /history record, normalized to what reconciliation needs. */
export interface HistoryEntry {
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly statusStr?: 'success' | 'error'
  readonly completed: boolean
  /** Recorded WS envelopes, replayable through the normalizer. */
  readonly messages: readonly RawJsonMessage[]
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export class BackendConnection {
  readonly id: ConnectionId
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly fetchFn: FetchLike
  private readonly normalizer: ComfyV1Normalizer
  private readonly listeners = new Set<(e: NormalizedEvent) => void>()
  private readonly socket: ReconnectingSocket
  private protocolErrors = 0

  readonly status: ReadonlySignal<ConnectionStatus>

  constructor(config: ConnectionConfig) {
    this.id = config.id
    this.baseUrl = config.baseUrl
    this.clientId = config.clientId
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init))
    // Malformed KNOWN events (recognized type, missing required fields) are
    // protocol errors, never silent drops; unknown types stay silent (custom
    // packs emit their own WS messages).
    this.normalizer = new ComfyV1Normalizer(config.id, undefined, (detail) =>
      this.reportProtocolError(detail),
    )
    this.socket = new ReconnectingSocket({
      url:
        config.wsUrl ??
        `${config.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(config.clientId)}`,
      ...(config.webSocketFactory ? { webSocketFactory: config.webSocketFactory } : {}),
      ...(config.scheduleFn ? { scheduleFn: config.scheduleFn } : {}),
      ...(config.cancelFn ? { cancelFn: config.cancelFn } : {}),
      // Feature negotiation MUST be the first client message (server.py reads
      // it only there). Metadata preview frames carry prompt_id + node_id, so
      // live previews attribute exactly instead of via the current-prompt
      // heuristic.
      onOpen: (send) =>
        send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })),
      onData: (data) => this.handleWsData(data),
    })
    this.status = this.socket.status
  }

  /** Subscribe to normalized events. Returns unsubscribe. */
  onEvent(listener: (e: NormalizedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(events: readonly NormalizedEvent[]): void {
    for (const e of events) for (const l of [...this.listeners]) l(e)
  }

  /** Feed one raw WS message through the normalizer (used by tests/replays too). */
  ingest(raw: RawMessage): void {
    this.emit(this.normalizer.normalize(raw))
  }

  // -- Schemas ----------------------------------------------------------------

  async fetchSchemas(): Promise<SchemaRegistry> {
    const res = await this.fetchFn(`${this.baseUrl}/object_info`)
    if (!res.ok) throw new Error(`GET /object_info failed: ${res.status}`)
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('GET /object_info: malformed schema payload')
    }
    return buildSchemaRegistry(this.id, raw as Record<string, ObjectInfoEntry>)
  }

  // -- Prompt submission --------------------------------------------------------

  async submit(artifact: CompileArtifact): Promise<SubmitResult> {
    if (artifact.connection !== this.id) {
      return {
        ok: false,
        diagnostics: [
          diag('error', 'compile', 'submit.wrongConnection', `artifact compiled for connection '${artifact.connection}', submitted to '${this.id}'`),
        ],
      }
    }
    const body = {
      prompt: Object.fromEntries(Object.entries(artifact.prompt).map(([id, { outputIds: _outputIds, ...node }]) => [id, node])),
      client_id: this.clientId,
      ...(artifact.partialTargets ? { partial_execution_targets: artifact.partialTargets } : {}),
    }
    const res = await this.fetchFn(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      // Non-JSON body (proxy errors, origin-check 403s, HTML error pages).
      return {
        ok: false,
        diagnostics: [
          diag(
            'error',
            'validation',
            'submit.badResponse',
            `server returned ${res.status} with a non-JSON body${text ? `: ${text.slice(0, 200)}` : ''}`,
          ),
        ],
      }
    }
    if (!res.ok) {
      return { ok: false, diagnostics: rejectionDiagnostics(payload, artifact) }
    }
    const promptId = payload['prompt_id']
    if (typeof promptId !== 'string') {
      return {
        ok: false,
        diagnostics: [diag('error', 'validation', 'submit.badResponse', 'server accepted the prompt but returned no prompt_id')],
      }
    }
    return { ok: true, execution: { connection: this.id, prompt: asPromptId(promptId) } }
  }

  async interrupt(): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/interrupt`, { method: 'POST' })
    if (!res.ok) throw new Error(`POST /interrupt failed: ${res.status}`)
  }

  /**
   * Node outputs recorded in server history for one prompt. Needed because a
   * fully cached execution emits no `executed` events - the outputs only
   * exist in /history. Returns {} when the entry is missing or malformed.
   */
  async fetchHistoryOutputs(
    prompt: PromptId,
  ): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
    return (await this.fetchHistoryEntry(prompt))?.outputs ?? {}
  }

  /**
   * Full history record for one prompt, or undefined when the server has
   * none. `messages` are the exact WS envelopes the run emitted
   * (execution_start/cached/error/interrupted/success - server add_message
   * appends each to history), so replayHistory() can push them through the
   * SAME normalizer path live events take.
   */
  async fetchHistoryEntry(prompt: PromptId): Promise<HistoryEntry | undefined> {
    const res = await this.fetchFn(`${this.baseUrl}/history/${prompt}`)
    if (res.status === 404 || res.status === 410) return undefined
    if (!res.ok) throw new Error(`GET /history/${prompt} failed: ${res.status}`)
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`GET /history/${prompt}: malformed response`)
    const payload = raw as Record<string, Record<string, unknown> | undefined>
    const entry = payload[prompt]
    // Absence is exactly "the key is missing from a valid body"; a present
    // but malformed entry is a protocol error, never authoritative absence.
    if (entry === undefined) return undefined
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`GET /history/${prompt}: malformed history entry`)
    }
    // outputs, status, and status.messages are REQUIRED: the server always
    // records them, and an entry without recorded messages cannot heal
    // anything - accepting it would read as "authoritatively present" and
    // silently skip the queue/loss check, stalling the run forever.
    const outputs = entry['outputs']
    if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
      throw new Error(`GET /history/${prompt}: malformed outputs`)
    }
    for (const nodeOutputs of Object.values(outputs)) {
      if (nodeOutputs === null || typeof nodeOutputs !== 'object' || Array.isArray(nodeOutputs)) {
        throw new Error(`GET /history/${prompt}: malformed outputs`)
      }
    }
    const statusRaw = entry['status']
    if (statusRaw === null || typeof statusRaw !== 'object' || Array.isArray(statusRaw)) {
      throw new Error(`GET /history/${prompt}: malformed status`)
    }
    const status = statusRaw as Record<string, unknown>
    const messagesRaw = status['messages']
    if (!Array.isArray(messagesRaw)) {
      throw new Error(`GET /history/${prompt}: malformed recorded messages`)
    }
    const messages: RawJsonMessage[] = []
    for (const m of messagesRaw) {
      // A malformed recorded envelope means the entry cannot be replayed
      // faithfully; partial replay could fabricate a wrong terminal state.
      // Recorded tuples are [type, data] with an object payload (server
      // add_message); a non-object payload cannot route (no prompt_id) and
      // would silently vanish in the normalizer.
      const data: unknown = Array.isArray(m) ? m[1] : undefined
      if (!Array.isArray(m) || typeof m[0] !== 'string' ||
        data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`GET /history/${prompt}: malformed recorded message`)
      }
      messages.push({ type: m[0], data: data as Record<string, unknown> })
    }
    return {
      outputs: outputs as Record<string, Readonly<Record<string, unknown>>>,
      ...(status['status_str'] === 'success' || status['status_str'] === 'error'
        ? { statusStr: status['status_str'] }
        : {}),
      completed: status['completed'] === true,
      messages,
    }
  }

  /** Replay a history entry's recorded WS envelopes through the normalizer. */
  replayHistory(entry: HistoryEntry): void {
    for (const message of entry.messages) this.ingest(message)
  }

  /**
   * Prompt ids currently running or pending on the server (/queue). Used by
   * reconciliation to distinguish "still in flight" from "vanished" for
   * executions with no history entry.
   */
  async fetchQueuePrompts(): Promise<ReadonlySet<string>> {
    const res = await this.fetchFn(`${this.baseUrl}/queue`)
    if (!res.ok) throw new Error(`GET /queue failed: ${res.status}`)
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('GET /queue: malformed response')
    }
    const payload = raw as Record<string, unknown>
    const prompts = new Set<string>()
    for (const key of ['queue_running', 'queue_pending']) {
      const items = payload[key]
      // A missing/malformed queue section must not read as "empty queue":
      // reconciliation would mark every historyless execution lost.
      if (!Array.isArray(items)) throw new Error(`GET /queue: malformed ${key}`)
      // Queue items are tuples: [number, prompt_id, prompt, extra_data, ...].
      for (const item of items) {
        if (!Array.isArray(item) || typeof item[1] !== 'string') {
          throw new Error(`GET /queue: malformed ${key} entry`)
        }
        prompts.add(item[1])
      }
    }
    return prompts
  }

  /** URL for a server-side output/preview image (the /view endpoint). */
  viewUrl(file: { filename: string; subfolder?: string; type?: string }): string {
    return v1ViewUrl(this.baseUrl, file)
  }

  // -- WebSocket -----------------------------------------------------------------
  // Socket lifecycle (reconnect policy, status) lives in ReconnectingSocket;
  // this connection owns only the protocol framing below.

  connect(): void {
    this.socket.connect()
  }

  disconnect(): void {
    this.socket.disconnect()
  }

  /**
   * Force-close the socket WITHOUT marking it deliberate, exactly as if the
   * transport died: the reconnect policy takes over. For diagnostics and
   * tests (the e2e reconnect suite drives this through the test bridge).
   */
  simulateConnectionLoss(): void {
    this.socket.simulateConnectionLoss()
  }

  private handleWsData(data: unknown): void {
    if (typeof data === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        this.reportProtocolError('malformed JSON WebSocket frame')
        return
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        this.ingest(parsed as RawMessage)
        return
      }
      this.reportProtocolError('malformed WebSocket envelope')
      return
    }
    if (data instanceof ArrayBuffer && data.byteLength >= 4) {
      const view = new DataView(data)
      this.ingest({ eventType: view.getUint32(0), payload: data.slice(4) })
      return
    }
    this.reportProtocolError('unsupported WebSocket frame')
  }

  private reportProtocolError(message: string): void {
    if (this.protocolErrors++ < 10) console.warn(`[${this.id}] protocol error: ${message}`)
  }
}

/** Map a /prompt rejection payload to diagnostics anchored via provenance. */
function rejectionDiagnostics(
  payload: Record<string, unknown>,
  artifact: CompileArtifact,
): readonly Diagnostic[] {
  const out: Diagnostic[] = []
  const err = payload['error'] as Record<string, unknown> | undefined
  if (err) {
    out.push(
      diag('error', 'validation', `validation.${String(err['type'] ?? 'unknown')}`, String(err['message'] ?? 'prompt rejected'), {
        data: { details: err['details'] ?? '' },
      }),
    )
  }
  const nodeErrors = payload['node_errors'] as Record<string, Record<string, unknown>> | undefined
  for (const [runtimeId, detail] of Object.entries(nodeErrors ?? {})) {
    const occKey = artifact.provenance.toSource[runtimeId]
    const errors = Array.isArray(detail['errors']) ? (detail['errors'] as Record<string, unknown>[]) : []
    for (const e of errors) {
      const extra = typeof e['extra_info'] === 'object' && e['extra_info'] !== null
        ? e['extra_info'] as Record<string, unknown>
        : undefined
      const inputId = typeof extra?.['input_name'] === 'string' ? extra['input_name'] : undefined
      const occurrence = occKey === undefined ? undefined : parseOccurrenceKey(occKey)
      const port = inputId === undefined ? undefined : artifact.provenance.inputSources?.[runtimeId]?.[inputId]
      out.push(
        diag('error', 'validation', `validation.${String(e['type'] ?? 'node')}`, `${String(detail['class_type'] ?? runtimeId)}: ${String(e['message'] ?? 'invalid')}${e['details'] ? ` (${String(e['details'])})` : ''}`, {
          ...(occurrence === undefined ? {} : {
            anchor: {
              occurrence,
              ...(port === undefined ? {} : { port }),
            },
          }),
          data: { runtimeId, ...(inputId === undefined ? {} : { inputId }) },
        }),
      )
    }
    if (errors.length === 0) {
      out.push(
        diag('error', 'validation', 'validation.node', `node '${runtimeId}' failed validation`, {
          ...(occKey ? { anchor: { occurrence: parseOccurrenceKey(occKey) } } : {}),
          data: { runtimeId },
        }),
      )
    }
  }
  if (out.length === 0) {
    out.push(diag('error', 'validation', 'validation.unknown', 'prompt rejected with no error payload'))
  }
  return out
}
