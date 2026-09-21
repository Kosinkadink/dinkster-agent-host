/**
 * BackendConnection unit tests: schema registry from the real object_info
 * fixture, submit accept/reject mapping, WS transport framing.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  asConnectionId,
  asDynamicMemberId,
  asNodeId,
  asPortId,
  asPromptId,
  compile,
  loadDocument,
  type NormalizedEvent,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  BackendConnection,
  buildSchemaRegistry,
  type FetchLike,
  type WebSocketLike,
} from '../src/index.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const objectInfo = readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>
const C0 = asConnectionId('c0')

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function compiledArtifact() {
  const doc = loadDocument(readJson('fixtures/workflows/exec-basic.json')).document as WorkflowDocument
  const registry = buildSchemaRegistry(C0, objectInfo)
  const result = compile({
    document: doc,
    revision: 1,
    resolve: registry.resolve,
    scope: { kind: 'full' },
    connection: C0,
    schemaHash: registry.hash,
  })
  if (!result.ok) throw new Error('fixture compile failed')
  return result.artifact
}

describe('schema registry', () => {
  it('parses the full live object_info fixture with a stable hash', () => {
    const a = buildSchemaRegistry(C0, objectInfo)
    const b = buildSchemaRegistry(C0, objectInfo)
    expect(a.schemas.size).toBeGreaterThan(500)
    expect(a.hash).toBe(b.hash)
    expect(a.resolve('KSampler')).toBeDefined()
    expect(a.resolve('NotANode')).toBeUndefined()
  })

  it('FR-2 fetchSchemas rejects a non-record /object_info body', async () => {
    for (const body of [[], 'not-a-record', 42, null]) {
      const conn = new BackendConnection({
        id: C0,
        baseUrl: 'http://test',
        clientId: 'cid',
        fetchFn: async () => jsonResponse(200, body),
      })
      await expect(conn.fetchSchemas()).rejects.toThrow('malformed schema payload')
    }
  })
})

describe('submit', () => {
  it('posts the prompt and returns the execution ref', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) })
      return jsonResponse(200, { prompt_id: 'p123', number: 0, node_errors: {} })
    }
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const result = await conn.submit(compiledArtifact())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.execution).toEqual({ connection: 'c0', prompt: 'p123' })
    expect(calls[0]!.url).toBe('http://test/prompt')
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>
    expect(body['client_id']).toBe('cid')
    expect(body['prompt']).toEqual(readJson('fixtures/prompts/exec-basic.expected.json'))
    expect(compiledArtifact().prompt.n0?.outputIds).toEqual(['out0'])
    expect(body['partial_execution_targets']).toBeUndefined()
  })

  it('maps a validation reject to anchored diagnostics', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(400, {
        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
        node_errors: {
          n0: {
            class_type: 'EmptyImage',
            errors: [{
              type: 'value_not_in_range', message: 'width too large', details: 'max 16384',
              extra_info: { input_name: 'items.item0.width' },
            }],
          },
        },
      })
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const artifact = compiledArtifact()
    const result = await conn.submit({
      ...artifact,
      provenance: {
        ...artifact.provenance,
        inputSources: {
          ...artifact.provenance.inputSources,
          n0: {
            ...artifact.provenance.inputSources?.['n0'],
            'items.item0.width': {
              node: asNodeId('n0'),
              port: asPortId('items.width'),
              members: [asDynamicMemberId('m0')],
            },
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.length).toBe(2)
    const nodeErr = result.diagnostics.find((d) => d.code === 'validation.value_not_in_range')!
    expect(nodeErr.anchor?.occurrence).toEqual({ instancePath: [], node: 'n0' })
    expect(nodeErr.anchor?.port).toEqual({ node: 'n0', port: 'items.width', members: ['m0'] })
    expect(nodeErr.message).toContain('width too large')
  })

  it('refuses an artifact compiled for another connection', async () => {
    const conn = new BackendConnection({
      id: asConnectionId('other'),
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn: async () => jsonResponse(200, {}),
    })
    const result = await conn.submit(compiledArtifact())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics[0]!.code).toBe('submit.wrongConnection')
  })
})

describe('websocket transport', () => {
  class FakeWs implements WebSocketLike {
    binaryType = 'blob'
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    closed = false
    sent: string[] = []
    send(data: string): void {
      this.sent.push(data)
    }
    close(): void {
      this.closed = true
      this.onclose?.({})
    }
  }

  function connected() {
    let ws: FakeWs | undefined
    const conn = new BackendConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'cid',
      webSocketFactory: (url) => {
        ws = new FakeWs()
        ;(ws as FakeWs & { url: string }).url = url
        return ws
      },
    })
    const events: NormalizedEvent[] = []
    conn.onEvent((e) => events.push(e))
    conn.connect()
    return { conn, ws: ws!, events }
  }

  it('tracks status through open/close and derives the ws url', () => {
    const { conn, ws } = connected()
    expect((ws as FakeWs & { url: string }).url).toBe('ws://test/ws?clientId=cid')
    expect(ws.binaryType).toBe('arraybuffer')
    expect(conn.status.get()).toBe('connecting')
    ws.onopen?.({})
    expect(conn.status.get()).toBe('connected')
    // An UNEXPECTED close is not 'disconnected' - the reconnect policy owns it.
    ws.onclose?.({})
    expect(conn.status.get()).toBe('reconnecting')
    conn.disconnect()
    expect(conn.status.get()).toBe('disconnected')
  })

  it('sends feature negotiation as the first message on open', () => {
    const { ws } = connected()
    expect(ws.sent).toEqual([])
    ws.onopen?.({})
    expect(ws.sent.length).toBe(1)
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'feature_flags',
      data: { supports_preview_metadata: true },
    })
  })

  it('parses JSON envelopes into normalized events', () => {
    const { ws, events } = connected()
    ws.onmessage?.({
      data: JSON.stringify({ type: 'execution_start', data: { prompt_id: 'p1' } }),
    })
    expect(events).toEqual([
      expect.objectContaining({ kind: 'started', execution: { connection: 'c0', prompt: 'p1' } }),
    ])
  })

  it('splits binary frames: 4-byte BE event type + payload', () => {
    const { ws, events } = connected()
    // Need a current prompt for preview attribution.
    ws.onmessage?.({ data: JSON.stringify({ type: 'execution_start', data: { prompt_id: 'p1' } }) })
    const frame = new ArrayBuffer(8)
    const view = new DataView(frame)
    view.setUint32(0, 1) // PREVIEW_IMAGE
    view.setUint32(4, 0xdeadbeef)
    ws.onmessage?.({ data: frame })
    const preview = events.find((e) => e.kind === 'preview')!
    expect(preview).toBeDefined()
    expect(preview.kind === 'preview' && (preview.payload as ArrayBuffer).byteLength).toBe(4)
  })

  it('ignores malformed messages without throwing', () => {
    const { ws, events } = connected()
    ws.onmessage?.({ data: 'not json' })
    ws.onmessage?.({ data: JSON.stringify({ noType: true }) })
    ws.onmessage?.({ data: new ArrayBuffer(2) })
    expect(events).toEqual([])
  })

  it('R2-6 reports a malformed KNOWN event as a protocol error instead of a silent drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ws, events } = connected()
      // Recognized type, required prompt_id missing: meant for us, undeliverable.
      ws.onmessage?.({ data: JSON.stringify({ type: 'execution_success', data: {} }) })
      expect(events).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('execution_success without prompt_id'))
      warn.mockClear()
      // Unknown types stay silent: custom packs emit their own WS messages.
      ws.onmessage?.({ data: JSON.stringify({ type: 'crystools.monitor', data: { gpu: 1 } }) })
      expect(events).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('reconnect policy', () => {
  class FakeWs implements WebSocketLike {
    binaryType = 'blob'
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    send(): void {}
    close(): void {
      this.onclose?.({})
    }
  }

  /** Deterministic scheduler: captures tasks; the test runs them by hand. */
  function harness() {
    const sockets: FakeWs[] = []
    const tasks: { fn: () => void; ms: number; cancelled: boolean }[] = []
    const conn = new BackendConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'cid',
      webSocketFactory: () => {
        const ws = new FakeWs()
        sockets.push(ws)
        return ws
      },
      scheduleFn: (fn, ms) => {
        const task = { fn, ms, cancelled: false }
        tasks.push(task)
        return task
      },
      cancelFn: (handle) => {
        ;(handle as { cancelled: boolean }).cancelled = true
      },
    })
    const runNext = (): void => {
      const task = tasks.shift()!
      expect(task.cancelled).toBe(false)
      task.fn()
    }
    return { conn, sockets, tasks, runNext }
  }

  it('reconnects after an unexpected close with exponential backoff', () => {
    const { conn, sockets, tasks, runNext } = harness()
    conn.connect()
    sockets[0]!.onopen?.({})
    expect(conn.status.get()).toBe('connected')

    // Drop 1: schedule at 500ms, open the replacement successfully.
    sockets[0]!.close()
    expect(conn.status.get()).toBe('reconnecting')
    expect(tasks[0]!.ms).toBe(500)
    runNext()
    expect(sockets.length).toBe(2)
    sockets[1]!.onopen?.({})
    expect(conn.status.get()).toBe('connected')

    // Drop again: a successful open reset the backoff to 500ms.
    sockets[1]!.close()
    expect(tasks[0]!.ms).toBe(500)
    runNext()
    // Consecutive failures (close before open) double the delay, capped at 8s.
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      sockets[sockets.length - 1]!.close()
      delays.push(tasks[0]!.ms)
      runNext()
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })

  it('simulateConnectionLoss() triggers the reconnect path', () => {
    const { conn, sockets, tasks } = harness()
    conn.connect()
    sockets[0]!.onopen?.({})
    conn.simulateConnectionLoss()
    expect(conn.status.get()).toBe('reconnecting')
    expect(tasks.length).toBe(1)
  })

  it('disconnect() cancels a pending reconnect and stays disconnected', () => {
    const { conn, sockets, tasks } = harness()
    conn.connect()
    sockets[0]!.onopen?.({})
    sockets[0]!.close()
    expect(tasks.length).toBe(1)
    conn.disconnect()
    expect(tasks[0]!.cancelled).toBe(true)
    expect(conn.status.get()).toBe('disconnected')
    expect(sockets.length).toBe(1)
  })

  it('a stale socket close cannot clobber a newer connection', () => {
    const { conn, sockets } = harness()
    conn.connect()
    const stale = sockets[0]!
    stale.onopen?.({})
    // Deliberate teardown, then a fresh connect BEFORE the async close lands.
    conn.disconnect()
    conn.connect()
    sockets[1]!.onopen?.({})
    expect(conn.status.get()).toBe('connected')
    stale.onclose?.({}) // late async close from the superseded socket
    expect(conn.status.get()).toBe('connected')
  })
})

describe('history + queue reconciliation surface', () => {
  const historyPayload = {
    p1: {
      prompt: [],
      outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
      status: {
        status_str: 'success',
        completed: true,
        messages: [
          ['execution_start', { prompt_id: 'p1', timestamp: 1000 }],
          ['execution_success', { prompt_id: 'p1', timestamp: 2000 }],
        ],
      },
    },
  }

  it('parses a history entry into outputs + replayable envelopes', async () => {
    const fetchFn: FetchLike = async (url) => {
      expect(url).toBe('http://test/history/p1')
      return jsonResponse(200, historyPayload)
    }
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const entry = await conn.fetchHistoryEntry(asPromptId('p1'))
    expect(entry).toBeDefined()
    expect(entry!.statusStr).toBe('success')
    expect(entry!.completed).toBe(true)
    expect(Object.keys(entry!.outputs)).toEqual(['9'])
    expect(entry!.messages.map((m) => m.type)).toEqual(['execution_start', 'execution_success'])
  })

  it('returns undefined for a prompt the server has no history for', async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, {})
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    expect(await conn.fetchHistoryEntry(asPromptId('nope'))).toBeUndefined()
  })

  it('replayHistory pushes recorded envelopes through the live event path', async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, historyPayload)
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const events: NormalizedEvent[] = []
    conn.onEvent((e) => events.push(e))
    conn.replayHistory((await conn.fetchHistoryEntry(asPromptId('p1')))!)
    expect(events.map((e) => e.kind)).toEqual(['started', 'completed'])
    expect(events[1]).toMatchObject({ execution: { connection: 'c0', prompt: 'p1' } })
  })

  it('collects running + pending prompt ids from /queue', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(200, {
        queue_running: [[0, 'p-run', {}, {}, []]],
        queue_pending: [
          [1, 'p-pend1', {}, {}, []],
          [2, 'p-pend2', {}, {}, []],
        ],
      })
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const prompts = await conn.fetchQueuePrompts()
    expect([...prompts].sort()).toEqual(['p-pend1', 'p-pend2', 'p-run'])
  })

  it('CL1 throws on a present but malformed history entry instead of reading absence', async () => {
    const fetchFn: FetchLike = async () => jsonResponse(200, { p1: null })
    const conn = new BackendConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    await expect(conn.fetchHistoryEntry(asPromptId('p1'))).rejects.toThrow('malformed history entry')
    // An entry missing its required fields is unreplayable: accepting it
    // would read as "authoritatively present" and stall the run forever.
    const empty = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { p1: {} }),
    })
    await expect(empty.fetchHistoryEntry(asPromptId('p1'))).rejects.toThrow('malformed')
  })

  it('CL1 throws on malformed outputs and malformed recorded messages', async () => {
    const withOutputs = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { p1: { prompt: [], outputs: 'nope' } }),
    })
    await expect(withOutputs.fetchHistoryEntry(asPromptId('p1'))).rejects.toThrow('malformed outputs')
    const withMessages = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { p1: { prompt: [], outputs: {}, status: { messages: [42] } } }),
    })
    await expect(withMessages.fetchHistoryEntry(asPromptId('p1'))).rejects.toThrow('malformed recorded message')
    // A tuple whose payload is not an object cannot route in the normalizer
    // (no prompt_id): accepting it would fake a present-but-unreplayable entry.
    const withBadTuple = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { p1: { prompt: [], outputs: {}, status: { messages: [['execution_success', 42]] } } }),
    })
    await expect(withBadTuple.fetchHistoryEntry(asPromptId('p1'))).rejects.toThrow('malformed recorded message')
    const withBadStatus = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { p1: { prompt: [], outputs: {}, status: 'done' } }),
    })
    await expect(withBadStatus.fetchHistoryEntry(asPromptId('p1'))).rejects.toThrow('malformed status')
  })

  it('CL1 throws when /queue sections are missing or entries are malformed', async () => {
    const missing = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { queue_running: [] }), // no queue_pending
    })
    // An absent section must not read as "empty queue" - reconciliation
    // would mark every historyless run lost off a truncated body.
    await expect(missing.fetchQueuePrompts()).rejects.toThrow('malformed queue_pending')
    const badTuple = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, { queue_running: [], queue_pending: [[0, 42]] }),
    })
    await expect(badTuple.fetchQueuePrompts()).rejects.toThrow('malformed queue_pending entry')
    const notObject = new BackendConnection({
      id: C0, baseUrl: 'http://test', clientId: 'cid',
      fetchFn: async () => jsonResponse(200, []),
    })
    await expect(notObject.fetchQueuePrompts()).rejects.toThrow('malformed response')
  })
})
