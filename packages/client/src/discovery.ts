/**
 * Backend protocol discovery: identify what a bare URL speaks so the app
 * can add backends URL-only, with no manual protocol choice.
 *
 * Probe order (each step is conclusive when it matches, otherwise falls
 * through to the next):
 *
 *   0. A machine-readable ?wire= 406 refusal from /api/nodes is conclusive
 *      INCOMPATIBILITY and beats every other answer, including a valid
 *      supervisor: a supervised engine that refuses our wire must be the
 *      loud 'dinkster-incompatible', never a backend that dies at schema
 *      fetch.
 *   1. GET /supervisor/status  - a valid supervisor answer is a Dinkster
 *      deployment (engine may still be starting; the supervisor poll
 *      narrates that after add).
 *   2. GET /api/nodes?wire=<accepted> - a native engine self-identifies:
 *      200 with a nodes table is 'dinkster'; the machine-readable 406 refusal
 *      is 'dinkster-incompatible' (a real Dinkster whose wire we cannot decode -
 *      loud, NEVER misclassified as v1 or absent); the supervisor's 503
 *      engine-not-ready gate is 'dinkster' (supervised).
 *   3. GET /system_stats - ComfyUI's small stats answer ({system, devices})
 *      is 'v1' (legacy bridge). Chosen over /object_info deliberately: the
 *      node dump is megabytes on a real server and discovery runs on every
 *      page load; /system_stats is a few hundred bytes and just as
 *      conclusive.
 *
 * Anything that answered but matched no protocol is 'unrecognized' - the
 * canonical case being an SPA dev server answering 200 text/html for every
 * path (routing fallthrough), which the shape checks reject. 'unreachable'
 * means no probe got any server answer at all.
 *
 * The three probes run CONCURRENTLY and are judged in priority order, so a
 * dead server costs one timeout, not three (this runs before first render
 * on the same-origin default). All three probe bodies are small.
 *
 * Framework-free; fetch and timeout are injectable. Never throws.
 */
import { DINKSTER_ADVERTISED_WIRE_VERSIONS } from '@dinkster/core'
import type { FetchLike } from './connection.js'
import { parseEngineNotReady, parseSupervisorStatus } from './supervisor.js'

export type BackendDiscovery =
  | { readonly kind: 'dinkster'; readonly supervised: boolean }
  | { readonly kind: 'dinkster-incompatible'; readonly supported: readonly number[] }
  | { readonly kind: 'v1' }
  | { readonly kind: 'unrecognized'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly detail: string }

export interface DiscoveryOptions {
  readonly fetchFn?: FetchLike
  /** Per-probe timeout in ms (default 4000). */
  readonly timeoutMs?: number
  /** Probe legacy ComfyUI after native detection fails (default true). */
  readonly probeV1?: boolean
}

/** One probe answer, or undefined when the request itself failed. */
interface ProbeAnswer {
  readonly status: number
  readonly contentType: string
  readonly body: unknown
}

const probe = async (
  fetchFn: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<ProbeAnswer | { readonly error: string }> => {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    const contentType = res.headers.get('content-type') ?? ''
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined // non-JSON body: the shape checks below reject it
    }
    return { status: res.status, contentType, body }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Native /api/nodes 200 shape: an object carrying a nodes table and/or the
 * dinkster identity header. An SPA's HTML (json-parse failure -> undefined)
 * and arbitrary JSON both fail this. */
const looksLikeNativeNodes = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const b = body as { nodes?: unknown; dinkster?: unknown }
  return (
    (typeof b.nodes === 'object' && b.nodes !== null && !Array.isArray(b.nodes)) ||
    (typeof b.dinkster === 'object' && b.dinkster !== null && !Array.isArray(b.dinkster))
  )
}

/** The ?wire= 406 refusal: {"error":"wire-version-unsupported","supported":[...]}. */
const parseWireRefusal = (body: unknown): readonly number[] | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as { error?: unknown; supported?: unknown }
  if (b.error !== 'wire-version-unsupported') return undefined
  return Array.isArray(b.supported) ? b.supported.filter((v): v is number => typeof v === 'number') : []
}

/** v1 /system_stats shape: an object carrying BOTH of ComfyUI's system and
 * devices sections (the real endpoint always emits both together). An SPA's
 * HTML, arbitrary JSON, and partial shapes from unrelated services all fail
 * this - v1 selection persists a backend, so the check must be conclusive. */
const looksLikeSystemStats = (body: unknown): boolean => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const b = body as { system?: unknown; devices?: unknown }
  return (
    typeof b.system === 'object' && b.system !== null && !Array.isArray(b.system) &&
    Array.isArray(b.devices)
  )
}

/**
 * Identify the protocol a server at `baseUrl` speaks. `baseUrl` is either
 * empty/'' (same origin), a path prefix ('/b2'), or an absolute origin -
 * exactly the strings addBackend accepts.
 */
export async function discoverBackend(
  baseUrl: string,
  options: DiscoveryOptions = {},
): Promise<BackendDiscovery> {
  const fetchFn = options.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? 4000
  const base = baseUrl.replace(/\/+$/, '')
  let sawServer = false
  let lastError = ''
  let htmlFallthrough = false

  const note = (answer: ProbeAnswer | { error: string }): ProbeAnswer | undefined => {
    if ('error' in answer) {
      lastError = answer.error
      return undefined
    }
    sawServer = true
    if (answer.contentType.includes('text/html')) htmlFallthrough = true
    return answer
  }

  // Fire the enabled probes at once; judge them in priority order below.
  const [supAnswer, nodesAnswer, v1Answer] = await Promise.all([
    probe(fetchFn, `${base}/supervisor/status`, timeoutMs),
    probe(fetchFn, `${base}/api/nodes?wire=${DINKSTER_ADVERTISED_WIRE_VERSIONS.join(',')}`, timeoutMs),
    options.probeV1 === false
      ? Promise.resolve(undefined)
      : probe(fetchFn, `${base}/system_stats`, timeoutMs),
  ])

  const sup = note(supAnswer)
  const nodes = note(nodesAnswer)

  // A machine-readable wire refusal is conclusive INCOMPATIBILITY and beats
  // everything - including a valid supervisor answer. A supervised
  // deployment whose engine refuses our wire must be the loud
  // 'dinkster-incompatible', never a compatible-looking backend that dies at
  // schema fetch (and never v1).
  if (nodes && nodes.status === 406) {
    const supported = parseWireRefusal(nodes.body)
    if (supported) return { kind: 'dinkster-incompatible', supported }
  }

  // 1. Supervisor?
  if (sup && sup.status === 200 && parseSupervisorStatus(sup.body)) {
    return { kind: 'dinkster', supervised: true }
  }

  // 2. Native engine?
  if (nodes) {
    if (nodes.status === 200 && looksLikeNativeNodes(nodes.body)) {
      return { kind: 'dinkster', supervised: false }
    }
    if (nodes.status === 503 && parseEngineNotReady(nodes.body)) {
      return { kind: 'dinkster', supervised: true }
    }
  }

  // 3. Legacy ComfyUI?
  const v1 = v1Answer === undefined ? undefined : note(v1Answer)
  if (v1 && v1.status === 200 && looksLikeSystemStats(v1.body)) {
    return { kind: 'v1' }
  }

  if (sawServer) {
    return {
      kind: 'unrecognized',
      detail: htmlFallthrough
        ? 'server answered with HTML, not a backend protocol (is this URL routed to the app instead of a backend?)'
        : 'server answered but spoke neither the Dinkster nor the ComfyUI protocol',
    }
  }
  return { kind: 'unreachable', detail: lastError || 'no response' }
}
