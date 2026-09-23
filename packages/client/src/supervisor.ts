/**
 * Supervisor status client (protocol 1).
 *
 * A Dinkster deployment may put `dinkster-supervisor` in front of the engine: a
 * layer-0 process that owns the public port, binds in milliseconds, and
 * proxies to the engine once healthy. Its whole wire surface is:
 *
 *   GET  /supervisor/status         -> { protocol, state, detail?, engine?, progress? }
 *   POST /supervisor/engine/restart -> 200 | 409 {"error":"restart-unavailable"}
 *
 * and, before the engine is ready, EVERY other route answers
 * 503 {"error":"engine-not-ready", "state":..., "status":"/supervisor/status"}.
 *
 * Standalone `dinkster-serve` has none of this: /supervisor/status is a plain
 * engine 404, which the probe reports as 'absent' so callers stop asking.
 * All optional fields are omitted-when-unknown, never null. The protocol
 * grows additively, so unknown fields pass through unread.
 */
import type { FetchLike } from './connection-contract.js'

export type SupervisorState = 'starting' | 'ready' | 'failed' | 'stopped'

export interface SupervisorProgress {
  readonly done: number
  readonly total: number
  readonly phase?: string
}

export interface SupervisorStatus {
  readonly protocol: number
  readonly state: SupervisorState
  readonly detail?: string
  readonly engine?: { readonly pid?: number; readonly exitCode?: number }
  /**
   * Composition narration. Present DURING state 'ready' while packs still
   * compose (the supervisor flips ready at the engine's first healthy
   * answer); absent once composed. Never null.
   */
  readonly progress?: SupervisorProgress
}

/**
 * One probe outcome, trichotomous on purpose:
 * - 'status': a supervisor answered; poll it.
 * - 'absent': the server answered CONCLUSIVELY without a supervisor (404/410
 *   from standalone dinkster-serve, or a 200 that is not a supervisor status) -
 *   stop asking, the WS status is truth.
 * - 'unreachable': no conclusive answer - the whole server may be down, a
 *   supervisor has not bound yet, or it answered a transient 5xx/auth error.
 */
export type SupervisorProbe =
  | { readonly kind: 'status'; readonly status: SupervisorStatus }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreachable'; readonly error: string }

const SUPERVISOR_STATES: readonly string[] = ['starting', 'ready', 'failed', 'stopped']

const parseProgress = (raw: unknown): SupervisorProgress | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as { done?: unknown; total?: unknown; phase?: unknown }
  if (typeof p.done !== 'number' || typeof p.total !== 'number') return undefined
  return {
    done: p.done,
    total: p.total,
    ...(typeof p.phase === 'string' ? { phase: p.phase } : {}),
  }
}

/** Strict-enough parse: wrong shapes degrade to undefined, never throw. */
export const parseSupervisorStatus = (raw: unknown): SupervisorStatus | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as {
    protocol?: unknown
    state?: unknown
    detail?: unknown
    engine?: unknown
    progress?: unknown
  }
  if (typeof s.protocol !== 'number') return undefined
  if (typeof s.state !== 'string' || !SUPERVISOR_STATES.includes(s.state)) return undefined
  const engine =
    typeof s.engine === 'object' && s.engine !== null
      ? (() => {
          const e = s.engine as { pid?: unknown; exitCode?: unknown }
          return {
            ...(typeof e.pid === 'number' ? { pid: e.pid } : {}),
            ...(typeof e.exitCode === 'number' ? { exitCode: e.exitCode } : {}),
          }
        })()
      : undefined
  const progress = parseProgress(s.progress)
  return {
    protocol: s.protocol,
    state: s.state as SupervisorState,
    ...(typeof s.detail === 'string' ? { detail: s.detail } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(progress !== undefined ? { progress } : {}),
  }
}

/**
 * GET /supervisor/status. Never throws: every failure mode maps into the
 * probe union so a poll loop is a plain switch.
 */
export async function probeSupervisorStatus(
  baseUrl: string,
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): Promise<SupervisorProbe> {
  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/supervisor/status`)
  } catch (e) {
    return { kind: 'unreachable', error: e instanceof Error ? e.message : String(e) }
  }
  // Only a conclusive miss reads as "no supervisor": 404/410 (standalone
  // dinkster-serve). A 5xx/auth failure is a supervisor that could not answer -
  // treating it as absence would stop the poll loop for good on a transient
  // hiccup and never fire onReady (the CL1 transient-vs-absent rule).
  if (res.status === 404 || res.status === 410) return { kind: 'absent' }
  if (!res.ok) {
    return { kind: 'unreachable', error: `GET /supervisor/status failed: ${res.status}` }
  }
  try {
    const status = parseSupervisorStatus(await res.json())
    // A 200 whose body is not a supervisor status is some OTHER responder
    // (SPA fallback, unrelated service): conclusively not a supervisor.
    return status ? { kind: 'status', status } : { kind: 'absent' }
  } catch {
    return { kind: 'absent' }
  }
}

/**
 * POST /supervisor/engine/restart. `ok: false` covers both the contract's
 * 409 {"error":"restart-unavailable"} and transport failures.
 */
export async function restartSupervisorEngine(
  baseUrl: string,
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(`${baseUrl}/supervisor/engine/restart`, { method: 'POST' })
    if (res.ok) return { ok: true }
    let error = `restart failed: ${res.status}`
    try {
      const body = (await res.json()) as { error?: unknown; detail?: unknown }
      if (typeof body.error === 'string') error = body.error
      if (typeof body.detail === 'string') error += `: ${body.detail}`
    } catch {
      /* non-JSON body: keep the status-code message */
    }
    return { ok: false, error }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The supervisor's pre-ready gate on proxied routes: 503 with this body.
 * DinksterConnection.fetchSchemas throws this instead of a generic error so
 * the app can render "Dinkster is starting" rather than a connection failure.
 */
export class EngineNotReadyError extends Error {
  readonly state: string
  constructor(state: string) {
    super(`engine not ready (supervisor state: ${state})`)
    this.name = 'EngineNotReadyError'
    this.state = state
  }
}

/** Recognize the 503 engine-not-ready body; undefined for anything else. */
export const parseEngineNotReady = (raw: unknown): { state: string } | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const b = raw as { error?: unknown; state?: unknown }
  if (b.error !== 'engine-not-ready') return undefined
  return { state: typeof b.state === 'string' ? b.state : 'starting' }
}
