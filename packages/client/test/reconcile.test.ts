/**
 * reconcileExecutions: heal the execution store after a WS gap from
 * /history (replayed through the live normalizer path) and /queue.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId, asPromptId, type ExecutionRef } from '@dinkster/core'
import { ExecutionStore, type FetchLike } from '../src/index.js'
import { BackendConnection, reconcileExecutions } from '../src/comfy-v1.js'

const C0 = asConnectionId('c0')
const ref = (prompt: string): ExecutionRef => ({ connection: C0, prompt: asPromptId(prompt) })

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** History payload for one completed prompt with recorded envelopes. */
function successHistory(prompt: string, outputs: Record<string, unknown> = {}) {
  return {
    [prompt]: {
      prompt: [],
      outputs,
      status: {
        status_str: 'success',
        completed: true,
        messages: [
          ['execution_start', { prompt_id: prompt, timestamp: 1 }],
          ['execution_success', { prompt_id: prompt, timestamp: 2 }],
        ],
      },
    },
  }
}

function errorHistory(prompt: string) {
  return {
    [prompt]: {
      prompt: [],
      outputs: {},
      status: {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { prompt_id: prompt, timestamp: 1 }],
          [
            'execution_error',
            {
              prompt_id: prompt,
              node_id: '3',
              exception_type: 'RuntimeError',
              exception_message: 'CUDA out of memory',
              traceback: ['Traceback...', 'RuntimeError: CUDA out of memory'],
              timestamp: 2,
            },
          ],
        ],
      },
    },
  }
}

/**
 * Wired harness matching the app: store subscribed to connection events.
 * `routes` maps URL suffixes to payloads; /history misses return {} (as the
 * real server does) and /queue defaults to empty.
 */
function harness(routes: Record<string, unknown>) {
  const requested: string[] = []
  const fetchFn: FetchLike = async (url) => {
    requested.push(url)
    for (const [suffix, payload] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return jsonResponse(200, payload)
    }
    if (url.includes('/history/')) return jsonResponse(200, {})
    if (url.endsWith('/queue')) return jsonResponse(200, { queue_running: [], queue_pending: [] })
    throw new Error(`unexpected fetch: ${url}`)
  }
  const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
  const store = new ExecutionStore()
  conn.onEvent((e) => store.apply(e))
  /** Seed a non-terminal execution as if events stopped mid-run. */
  const seedRunning = (prompt: string): void => {
    store.apply({ kind: 'started', execution: ref(prompt), timestamp: 0 })
  }
  return { conn, store, requested, seedRunning }
}

describe('reconcileExecutions', () => {
  it('CL1 leaves running execution untouched on 503', async () => {
    const fetchFn: FetchLike = async (url) => url.includes('/history/')
      ? jsonResponse(503, {}) : jsonResponse(200, { queue_running: [], queue_pending: [] })
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: ref('transient'), timestamp: 0 })
    await reconcileExecutions(conn, store)
    expect(store.get(ref('transient'))!.status).toBe('running')
  })

  it('CL1 a malformed 200 /queue body aborts the pass instead of marking lost', async () => {
    const fetchFn: FetchLike = async (url) => url.includes('/history/')
      ? jsonResponse(200, {})
      : jsonResponse(200, { queue_running: 'nope' })
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    store.apply({ kind: 'started', execution: ref('x'), timestamp: 0 })
    await expect(reconcileExecutions(conn, store)).rejects.toThrow('malformed')
    expect(store.get(ref('x'))!.status).toBe('running')
  })

  it('CL2 a reconnect during an in-flight pass supersedes its loss verdict and reruns', async () => {
    let queueGate: (() => void) | undefined
    let historyCalls = 0
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('/history/')) {
        historyCalls += 1
        // The first pass (both reads) sees no history; the rerun finds success.
        return jsonResponse(200, historyCalls >= 3 ? successHistory('p9') : {})
      }
      if (queueGate === undefined) {
        // Block the first pass at its /queue read until the second reconnect
        // has landed, so the stale pass finishes against a bumped generation.
        await new Promise<void>((resolve) => { queueGate = resolve })
      }
      return jsonResponse(200, { queue_running: [], queue_pending: [] })
    }
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    store.apply({ kind: 'started', execution: ref('p9'), timestamp: 0 })
    const first = reconcileExecutions(conn, store)
    while (queueGate === undefined) await Promise.resolve()
    const second = reconcileExecutions(conn, store) // bumps the generation
    queueGate()
    await Promise.all([first, second])
    // The stale pass saw "no history + not queued" but must not have
    // committed lost; the rerun replayed the terminal history instead.
    expect(store.get(ref('p9'))!.status).toBe('completed')
    expect(historyCalls).toBe(3)
  })

  it('CL2 a superseded pass failing its queue read still yields a trailing rerun', async () => {
    let queueGate: (() => void) | undefined
    let queueCalls = 0
    let historyCalls = 0
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('/history/')) {
        historyCalls += 1
        return jsonResponse(200, historyCalls >= 2 ? successHistory('p8') : {})
      }
      queueCalls += 1
      if (queueCalls === 1) {
        // The stale pass's queue read fails AFTER it has been superseded.
        await new Promise<void>((resolve) => { queueGate = resolve })
        return jsonResponse(503, {})
      }
      return jsonResponse(200, { queue_running: [], queue_pending: [] })
    }
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    store.apply({ kind: 'started', execution: ref('p8'), timestamp: 0 })
    const first = reconcileExecutions(conn, store)
    while (queueGate === undefined) await Promise.resolve()
    const second = reconcileExecutions(conn, store)
    queueGate()
    // The stale failure must not reject the shared promise or starve the
    // rerun: the trailing pass replays the terminal history.
    await Promise.all([first, second])
    expect(store.get(ref('p8'))!.status).toBe('completed')
  })

  it('CL2 rechecks history after a queue miss before marking lost', async () => {
    let histories = 0
    const { conn, store, seedRunning } = harness({})
    const original = conn.fetchHistoryEntry.bind(conn)
    conn.fetchHistoryEntry = async (prompt) => ++histories === 1 ? undefined : original(prompt)
    // Supply the completion only on the second history read.
    conn.fetchHistoryEntry = async () => ++histories === 1 ? undefined : ({ outputs: {}, completed: true, messages: [{ type: 'execution_success', data: { prompt_id: 'race' } }] })
    seedRunning('race')
    await reconcileExecutions(conn, store)
    expect(histories).toBe(2)
    expect(store.get(ref('race'))!.status).toBe('completed')
  })

  it('completes a run whose terminal event was missed, hydrating outputs', async () => {
    const outputs = { '9': { images: [{ filename: 'x.png' }] } }
    const { conn, store, seedRunning } = harness({ '/history/p1': successHistory('p1', outputs) })
    seedRunning('p1')
    await reconcileExecutions(conn, store)
    const state = store.get(ref('p1'))!
    expect(state.status).toBe('completed')
    expect(state.outputs['9']).toEqual(outputs['9'])
  })

  it('replays a missed error with full runtime detail and node anchoring', async () => {
    const { conn, store, seedRunning } = harness({ '/history/p2': errorHistory('p2') })
    seedRunning('p2')
    await reconcileExecutions(conn, store)
    const state = store.get(ref('p2'))!
    expect(state.status).toBe('error')
    expect(state.nodes['3']).toEqual({ state: 'error' })
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]!.code).toBe('runtime.RuntimeError')
    expect(state.errors[0]!.message).toBe('CUDA out of memory')
  })

  it('leaves an execution alone when it is still in the server queue', async () => {
    const { conn, store, seedRunning } = harness({
      '/queue': { queue_running: [[0, 'p3', {}, {}, []]], queue_pending: [] },
    })
    seedRunning('p3')
    await reconcileExecutions(conn, store)
    const state = store.get(ref('p3'))!
    expect(state.status).toBe('running')
    expect(state.errors).toEqual([])
  })

  it('marks an execution lost when history and queue both disown it', async () => {
    const { conn, store, seedRunning } = harness({})
    seedRunning('p4')
    await reconcileExecutions(conn, store)
    const state = store.get(ref('p4'))!
    expect(state.status).toBe('interrupted')
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]!.code).toBe('execution.lost')
    expect(state.errors[0]!.severity).toBe('warning')
  })

  it('never touches terminal executions - or the network for them', async () => {
    const { conn, store, requested, seedRunning } = harness({})
    seedRunning('p5')
    store.apply({ kind: 'completed', execution: ref('p5'), timestamp: 5 })
    await reconcileExecutions(conn, store)
    expect(store.get(ref('p5'))!.status).toBe('completed')
    expect(requested).toEqual([])
  })

  it('only reconciles the reconnecting connection - other backends untouched', async () => {
    // The store is SHARED across backends; a reconnect on c0 must not
    // inspect (or mark lost) runs that belong to another connection.
    const { conn, store, requested, seedRunning } = harness({})
    seedRunning('p8') // c0's own run: history+queue disown it -> lost
    const other: ExecutionRef = { connection: asConnectionId('c1'), prompt: asPromptId('p9') }
    store.apply({ kind: 'started', execution: other, timestamp: 0 })
    await reconcileExecutions(conn, store)
    expect(store.get(ref('p8'))!.status).toBe('interrupted')
    expect(store.get(other)!.status).toBe('running') // never marked lost
    expect(store.get(other)!.errors).toEqual([])
    expect(requested.some((u) => u.includes('p9'))).toBe(false) // never even fetched
  })

  it('fetches /queue once for many historyless executions', async () => {
    const { conn, store, requested, seedRunning } = harness({
      '/queue': { queue_running: [], queue_pending: [[0, 'p7', {}, {}, []]] },
    })
    seedRunning('p6')
    seedRunning('p7')
    await reconcileExecutions(conn, store)
    expect(requested.filter((u) => u.endsWith('/queue'))).toHaveLength(1)
    expect(store.get(ref('p6'))!.status).toBe('interrupted')
    expect(store.get(ref('p7'))!.status).toBe('running')
  })
})
