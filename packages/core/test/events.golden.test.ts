/**
 * Golden fixture tests: replay real recorded ComfyUI WS streams
 * (fixtures/events/*.json, captured by scripts/record-events.mjs against a
 * live server) through ComfyV1Normalizer and hold the normalizer to the
 * contract guards:
 *
 * - every prompt-scoped event resolves to (connectionId, promptId)
 * - success streams terminate with 'completed'
 * - runtime errors preserve exception type/message/traceback/input payloads
 * - progress_state normalizes to per-node state maps (no global cursor)
 * - legacy executing/progress normalize without exposing a cursor
 * - cached and interrupted flows normalize correctly
 * - unknown event types are dropped, not crashes
 * - binary frame metadata is classified by event type
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { asConnectionId, asPromptId, executionKey } from '../src/ids.js'
import { ComfyV1Normalizer, parsePreviewMetadataFrame, type RawJsonMessage } from '../src/events/comfy-v1.js'
import { isExecutionEvent, type NormalizedEvent } from '../src/events/contract.js'

interface RecordedStream {
  readonly scenario: string
  readonly clientId: string
  readonly submits: readonly { status: number; body: Record<string, unknown> }[]
  readonly messages: readonly { t: number; type: string; data?: Record<string, unknown> }[]
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/events')
const load = (name: string): RecordedStream =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as RecordedStream

const CONN = asConnectionId('conn-test')
const keyOf = (promptId: string): string =>
  executionKey({ connection: CONN, prompt: asPromptId(promptId) })

function replay(stream: RecordedStream): NormalizedEvent[] {
  const normalizer = new ComfyV1Normalizer(CONN, () => 0)
  const out: NormalizedEvent[] = []
  for (const m of stream.messages) {
    const raw: RawJsonMessage = { type: m.type, ...(m.data ? { data: m.data } : {}) }
    out.push(...normalizer.normalize(raw))
  }
  return out
}

function promptIds(stream: RecordedStream): string[] {
  const ids = new Set<string>()
  for (const s of stream.submits) {
    const pid = s.body['prompt_id']
    if (typeof pid === 'string') ids.add(pid)
  }
  return [...ids]
}

describe('recorded stream replay: success', () => {
  const stream = load('success')
  const events = replay(stream)
  const [promptId] = promptIds(stream)

  it('resolves every prompt-scoped event to (connection, prompt)', () => {
    const scoped = events.filter(isExecutionEvent)
    expect(scoped.length).toBeGreaterThan(0)
    for (const e of scoped) {
      expect(e.execution).toBeDefined()
      expect(executionKey(e.execution)).toBe(keyOf(promptId!))
    }
  })

  it('starts once and terminates with completed', () => {
    expect(events.filter((e) => e.kind === 'started')).toHaveLength(1)
    const terminal = events.filter(
      (e) => e.kind === 'completed' || e.kind === 'error' || e.kind === 'interrupted',
    )
    expect(terminal.length).toBeGreaterThan(0)
    for (const t of terminal) expect(t.kind).toBe('completed')
    // The last non-status event is a completion.
    const last = [...events].reverse().find((e) => e.kind !== 'status')!
    expect(last.kind).toBe('completed')
  })

  it('reports node progress only via per-node state maps', () => {
    const stateEvents = events.filter((e) => e.kind === 'nodeStates')
    expect(stateEvents.length).toBeGreaterThan(0)
    const seenRunning = new Set<string>()
    for (const e of stateEvents) {
      for (const [nodeId, p] of Object.entries(e.nodes)) {
        if (p.state === 'running') seenRunning.add(nodeId)
        if (p.value !== undefined) {
          expect(p.value).toBeGreaterThanOrEqual(0)
          expect(p.value).toBeLessThanOrEqual(1)
        }
      }
    }
    expect(seenRunning.size).toBeGreaterThan(0)
  })

  it('emits nodeOutput for executed nodes', () => {
    const outputs = events.filter((e) => e.kind === 'nodeOutput')
    expect(outputs.length).toBeGreaterThan(0)
    for (const o of outputs) expect(o.runtimeNodeId).toBeTruthy()
  })
})

describe('recorded stream replay: cached', () => {
  const stream = load('cached')
  const events = replay(stream)

  it('normalizes execution_cached into cached node states', () => {
    const cached = events.filter(
      (e) => e.kind === 'nodeStates' && Object.values(e.nodes).some((p) => p.state === 'cached'),
    )
    expect(cached.length).toBeGreaterThan(0)
    // The recorded second run reports nodes 1 and 2 as cached.
    const cachedNodes = new Set(
      cached.flatMap((e) =>
        e.kind === 'nodeStates'
          ? Object.entries(e.nodes)
              .filter(([, p]) => p.state === 'cached')
              .map(([id]) => id)
          : [],
      ),
    )
    expect(cachedNodes.has('1')).toBe(true)
    expect(cachedNodes.has('2')).toBe(true)
  })

  it('completes both prompts', () => {
    const pids = promptIds(stream)
    expect(pids).toHaveLength(2)
    const completedPrompts = new Set(
      events.filter((e) => e.kind === 'completed').map((e) => e.execution.prompt as string),
    )
    for (const pid of pids) expect(completedPrompts.has(pid)).toBe(true)
  })
})

describe('recorded stream replay: runtime error', () => {
  const stream = load('runtime_error')
  const events = replay(stream)

  it('preserves exception type, message, traceback and failing node', () => {
    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    const err = errors[0]!
    expect(err.runtimeNodeId).toBe('2')
    expect(err.detail.exceptionType).toBe('RuntimeError')
    expect(err.detail.exceptionMessage.length).toBeGreaterThan(0)
    expect(err.detail.traceback.length).toBeGreaterThan(0)
    expect(err.detail.currentInputs).toBeDefined()
  })

  it('does not emit completed for the failed prompt', () => {
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(0)
  })
})

describe('recorded stream replay: interrupted', () => {
  const stream = load('interrupted')
  const events = replay(stream)

  it('terminates with interrupted, not completed', () => {
    expect(events.filter((e) => e.kind === 'interrupted')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(0)
  })
})

describe('normalizer unit behavior beyond recorded streams', () => {
  it('progress_state supports multiple simultaneously running nodes', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    const events = n.normalize({
      type: 'progress_state',
      data: {
        prompt_id: 'p1',
        nodes: {
          a: { state: 'running', value: 1, max: 4 },
          b: { state: 'running', value: 3, max: 4 },
          c: { state: 'pending', value: 0, max: 1 },
          d: { state: 'finished', value: 1, max: 1 },
        },
      },
    })
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.kind).toBe('nodeStates')
    if (e.kind !== 'nodeStates') return
    expect(e.nodes['a']).toEqual({ state: 'running', value: 0.25, max: 4 })
    expect(e.nodes['b']).toEqual({ state: 'running', value: 0.75, max: 4 })
    expect(e.nodes['c']?.state).toBe('pending')
    expect(e.nodes['d']?.state).toBe('done')
  })

  it('legacy executing cursor is absorbed into per-node states', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    const run = (node: string | null) =>
      n.normalize({ type: 'executing', data: { prompt_id: 'p1', node } })

    const first = run('1')
    expect(first).toEqual([
      expect.objectContaining({ kind: 'nodeStates', nodes: { '1': { state: 'running' } } }),
    ])
    // Cursor moves: previous node is marked done, new node running.
    const second = run('2')
    expect(second).toHaveLength(2)
    expect(second[0]).toMatchObject({ kind: 'nodeStates', nodes: { '1': { state: 'done' } } })
    expect(second[1]).toMatchObject({ kind: 'nodeStates', nodes: { '2': { state: 'running' } } })
    // null cursor => completion.
    const done = run(null)
    expect(done.some((e) => e.kind === 'completed')).toBe(true)
  })

  it('legacy executing cursors are independent per prompt (no global cursor)', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    n.normalize({ type: 'executing', data: { prompt_id: 'p1', node: 'a' } })
    // A different prompt starting node 'x' must not mark p1's 'a' done.
    const other = n.normalize({ type: 'executing', data: { prompt_id: 'p2', node: 'x' } })
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({
      kind: 'nodeStates',
      execution: expect.objectContaining({ prompt: 'p2' }),
      nodes: { x: { state: 'running' } },
    })
  })

  it('unknown event types are dropped without throwing', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    expect(n.normalize({ type: 'crystools.monitor', data: { gpu: 1 } })).toEqual([])
    expect(n.normalize({ type: 'totally-unknown' })).toEqual([])
  })

  it('prompt-scoped messages without prompt_id are dropped', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    expect(n.normalize({ type: 'execution_start', data: {} })).toEqual([])
    expect(n.normalize({ type: 'executed', data: { node: '1' } })).toEqual([])
  })

  it('classifies binary frames and attributes them to the started prompt', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    const payload = new ArrayBuffer(4)
    // No started prompt yet: frames cannot be attributed and are dropped.
    expect(n.normalize({ eventType: 1, payload })).toEqual([])

    n.normalize({ type: 'execution_start', data: { prompt_id: 'p1' } })
    const cases: readonly [number, string][] = [
      [1, 'comfy/preview-image'],
      [2, 'comfy/preview-image'],
      [3, 'comfy/progress-text'],
    ]
    for (const [eventType, channel] of cases) {
      const events = n.normalize({ eventType, payload }).filter(isExecutionEvent)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'preview', channel, payload })
      expect(executionKey(events[0]!.execution)).toBe(keyOf('p1'))
    }
    // Unknown binary types are dropped.
    expect(n.normalize({ eventType: 99, payload })).toEqual([])
  })
})

// -- PREVIEW_IMAGE_WITH_METADATA (binary event type 4) ------------------------
// Frame layout after the transport strips the outer event type: 4-byte BE
// metadata length, UTF-8 JSON metadata, then encoded image bytes.

function metadataFrame(meta: unknown, image: readonly number[]): ArrayBuffer {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const buf = new ArrayBuffer(4 + metaBytes.byteLength + image.length)
  new DataView(buf).setUint32(0, metaBytes.byteLength)
  new Uint8Array(buf, 4, metaBytes.byteLength).set(metaBytes)
  new Uint8Array(buf, 4 + metaBytes.byteLength).set(image)
  return buf
}

describe('preview metadata frames', () => {
  it('parses a valid frame into metadata + image bytes', () => {
    const payload = metadataFrame({ prompt_id: 'p9', node_id: '3' }, [1, 2, 3])
    const parsed = parsePreviewMetadataFrame(payload)!
    expect(parsed.meta).toEqual({ prompt_id: 'p9', node_id: '3' })
    expect([...new Uint8Array(parsed.image)]).toEqual([1, 2, 3])
  })

  it('routes by the embedded prompt_id, not the current prompt', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    n.normalize({ type: 'execution_start', data: { prompt_id: 'current' } })
    const events = n.normalize({
      eventType: 4,
      payload: metadataFrame({ prompt_id: 'other', node_id: '5' }, [7]),
    }).filter(isExecutionEvent)
    expect(events).toHaveLength(1)
    expect(executionKey(events[0]!.execution)).toBe(keyOf('other'))
    expect(events[0]).toMatchObject({ kind: 'preview', channel: 'comfy/preview-image', runtimeNodeId: '5' })
    // Payload is ONLY the encoded image, metadata stripped.
    expect((events[0] as { payload: ArrayBuffer }).payload.byteLength).toBe(1)
  })

  it('attributes to display_node_id over node_id', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    const events = n.normalize({
      eventType: 4,
      payload: metadataFrame({ prompt_id: 'p1', node_id: '9', display_node_id: '2' }, []),
    })
    expect(events[0]).toMatchObject({ runtimeNodeId: '2' })
  })

  it('falls back to node_id when display_node_id is absent', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    const events = n.normalize({
      eventType: 4,
      payload: metadataFrame({ prompt_id: 'p1', node_id: '9' }, []),
    })
    expect(events[0]).toMatchObject({ runtimeNodeId: '9' })
  })

  it('drops malformed frames without throwing', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    n.normalize({ type: 'execution_start', data: { prompt_id: 'p1' } })
    // Truncated: declared metadata length exceeds the payload.
    const truncated = new ArrayBuffer(8)
    new DataView(truncated).setUint32(0, 100)
    expect(n.normalize({ eventType: 4, payload: truncated })).toEqual([])
    expect(parsePreviewMetadataFrame(new ArrayBuffer(2))).toBeUndefined()
    // Invalid JSON metadata.
    const bad = new ArrayBuffer(4 + 3)
    new DataView(bad).setUint32(0, 3)
    new Uint8Array(bad, 4).set([0x7b, 0x7b, 0x7b]) // '{{{'
    expect(n.normalize({ eventType: 4, payload: bad })).toEqual([])
    // Non-object metadata.
    expect(n.normalize({ eventType: 4, payload: metadataFrame([1, 2], []) })).toEqual([])
    // Missing prompt_id.
    expect(n.normalize({ eventType: 4, payload: metadataFrame({ node_id: '1' }, []) })).toEqual([])
  })

  it('omits runtimeNodeId when metadata has no usable node id', () => {
    const n = new ComfyV1Normalizer(CONN, () => 0)
    const events = n.normalize({ eventType: 4, payload: metadataFrame({ prompt_id: 'p1' }, [1]) })
    expect(events).toHaveLength(1)
    expect('runtimeNodeId' in events[0]!).toBe(false)
  })
})

describe('malformed known events report through onMalformed (R2-6)', () => {
  const collect = () => {
    const reports: string[] = []
    const n = new ComfyV1Normalizer(CONN, () => 0, (detail) => reports.push(detail))
    return { n, reports }
  }

  it('reports known events with missing required fields instead of vanishing', () => {
    const { n, reports } = collect()
    expect(n.normalize({ type: 'execution_start', data: {} })).toEqual([])
    expect(n.normalize({ type: 'execution_success', data: {} })).toEqual([])
    expect(n.normalize({ type: 'execution_error', data: {} })).toEqual([])
    expect(n.normalize({ type: 'executed', data: { prompt_id: 'p1' } })).toEqual([])
    expect(n.normalize({ type: 'progress', data: { prompt_id: 'p1', node: '1', value: Number.NaN, max: 4 } })).toEqual([])
    expect(n.normalize({ type: 'execution_cached', data: { prompt_id: 'p1', nodes: 'oops' } })).toEqual([])
    expect(reports).toHaveLength(6)
    expect(reports[0]).toContain('execution_start')
  })

  it('reports a malformed progress_state node entry instead of throwing', () => {
    const { n, reports } = collect()
    let events: readonly NormalizedEvent[] = []
    expect(() => {
      events = n.normalize({ type: 'progress_state', data: { prompt_id: 'p1', nodes: { a: null } } })
    }).not.toThrow()
    expect(events).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('progress_state')
  })

  it('never reports unknown event types or benign no-ops', () => {
    const { n, reports } = collect()
    expect(n.normalize({ type: 'crystools.monitor', data: { gpu: 1 } })).toEqual([])
    expect(n.normalize({ type: 'totally-unknown' })).toEqual([])
    // An empty cached-node list is a semantic no-op, not a malformed event.
    expect(n.normalize({ type: 'execution_cached', data: { prompt_id: 'p1', nodes: [] } })).toEqual([])
    // The server sends {node} without prompt_id to a freshly (re)connected
    // executing client: a real message with an attribution gap, not malformed.
    expect(n.normalize({ type: 'executing', data: { node: '5' } })).toEqual([])
    // progress fills prompt_id/node from last_prompt_id/last_node_id, which
    // are legitimately null outside execution; max=0 (ProgressBar with a zero
    // total) is the old contract's explicit no-op. All silent.
    expect(n.normalize({ type: 'progress', data: { prompt_id: null, node: '1', value: 0, max: 4 } })).toEqual([])
    expect(n.normalize({ type: 'progress', data: { prompt_id: 'p1', node: null, value: 0, max: 4 } })).toEqual([])
    expect(n.normalize({ type: 'progress', data: { prompt_id: 'p1', node: '1', value: 0, max: 0 } })).toEqual([])
    // A decodable metadata preview frame without prompt_id: the server-side
    // sender tolerates empty metadata, so this is a routing gap, not corrupt.
    expect(n.normalize({ eventType: 4, payload: metadataFrame({ node_id: '1' }, []) })).toEqual([])
    // A legacy binary frame before any started prompt is an attribution gap
    // (protocol limitation), never a malformed frame.
    expect(n.normalize({ eventType: 1, payload: new ArrayBuffer(4) })).toEqual([])
    // Unknown binary event types are future protocol, dropped silently.
    expect(n.normalize({ eventType: 99, payload: new ArrayBuffer(4) })).toEqual([])
    expect(reports).toEqual([])
  })

  it('reports an undecodable preview metadata frame', () => {
    const { n, reports } = collect()
    const truncated = new ArrayBuffer(8)
    new DataView(truncated).setUint32(0, 100)
    expect(n.normalize({ eventType: 4, payload: truncated })).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('undecodable')
  })
})
