/**
 * ExecutionStore replay tests: the five recorded live streams are the oracle.
 * Each fixture's messages flow through BackendConnection.ingest (the real
 * normalizer) into the store; assertions check terminal state per scenario.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DinksterNormalizer, asConnectionId, asPromptId, type RawMessage } from '@dinkster/core'
import { BackendConnection, ExecutionStore } from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../core/fixtures/events')

interface StreamFixture {
  readonly scenario: string
  readonly submits: readonly { status: number; body: Record<string, unknown> }[]
  readonly messages: readonly ({ t: number } & RawMessage)[]
}

const readStream = (name: string): StreamFixture =>
  JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')) as StreamFixture

function replay(name: string): { store: ExecutionStore; fixture: StreamFixture } {
  const fixture = readStream(name)
  const store = new ExecutionStore()
  const conn = new BackendConnection({
    id: asConnectionId('c0'),
    baseUrl: 'http://test',
    clientId: 'test',
  })
  conn.onEvent((e) => store.apply(e))
  for (const msg of fixture.messages) conn.ingest(msg)
  return { store, fixture }
}

const promptIdOf = (f: StreamFixture, i = 0): string =>
  f.submits[i]!.body['prompt_id'] as string

describe('attributed previews', () => {
  const C0 = asConnectionId('c0')
  const exec = (prompt: string) => ({ connection: C0, prompt: asPromptId(prompt) })

  function storeWith(prompts: readonly string[]): ExecutionStore {
    const store = new ExecutionStore()
    for (const p of prompts) {
      store.apply({ kind: 'started', execution: exec(p), timestamp: 0 })
    }
    return store
  }

  const frame = (prompt: string, node: string | undefined, byte: number, timestamp = 1) => ({
    kind: 'preview' as const,
    execution: exec(prompt),
    timestamp,
    ...(node !== undefined ? { runtimeNodeId: node } : {}),
    channel: 'comfy/preview-image',
    payload: new Uint8Array([byte]).buffer,
  })

  it('stores attributed frames per runtime node; newer replaces same node only', () => {
    const store = storeWith(['p1'])
    store.apply(frame('p1', '3', 1, 1))
    store.apply(frame('p1', '5', 2, 2))
    store.apply(frame('p1', '3', 9, 3))
    const state = store.get(exec('p1'))!
    expect(Object.keys(state.previews).sort()).toEqual(['3', '5'])
    expect(new Uint8Array(state.previews['3']!['']!.payload as ArrayBuffer)[0]).toBe(9)
    expect(new Uint8Array(state.previews['5']!['']!.payload as ArrayBuffer)[0]).toBe(2)
    expect(state.lastPreview).toBeUndefined()
  })

  it('keeps unattributed frames on lastPreview, not in previews', () => {
    const store = storeWith(['p1'])
    store.apply(frame('p1', undefined, 7))
    const state = store.get(exec('p1'))!
    expect(state.previews).toEqual({})
    expect(new Uint8Array(state.lastPreview!.payload as ArrayBuffer)[0]).toBe(7)
  })

  it('concurrent executions cannot cross-contaminate previews', () => {
    const store = storeWith(['p1', 'p2'])
    store.apply(frame('p1', '3', 1))
    store.apply(frame('p2', '3', 2))
    expect(new Uint8Array(store.get(exec('p1'))!.previews['3']!['']!.payload as ArrayBuffer)[0]).toBe(1)
    expect(new Uint8Array(store.get(exec('p2'))!.previews['3']!['']!.payload as ArrayBuffer)[0]).toBe(2)
  })

  it('ignores connection-level control events without creating executions', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'schemaChanged', connection: C0, timestamp: 0, epoch: 2 })
    store.apply({ kind: 'compositionProgress', connection: C0, timestamp: 0, done: 1, total: 2 })
    store.apply({ kind: 'compositionComplete', connection: C0, timestamp: 0, epoch: 2, failed: [] })
    store.apply({ kind: 'packFailed', connection: C0, timestamp: 0, pack: 'p', error: 'e' })
    expect(store.executions.get().size).toBe(0)
  })

  describe('frame rings', () => {
    const ringFrame = (
      node: string,
      byte: number,
      ring: { frameIndex?: number; frameCount?: number; fps?: number },
      timestamp = 1,
    ) => ({ ...frame('p1', node, byte, timestamp), ...ring })

    const slotByte = (store: ExecutionStore, node: string, slot: number): number =>
      new Uint8Array(
        store.get(exec('p1'))!.previewRings![node]!['']!.frames[slot]!.payload as ArrayBuffer,
      )[0]!

    it('assembles a ring keyed by frameIndex and replaces slots in place', () => {
      const store = storeWith(['p1'])
      store.apply(ringFrame('3', 10, { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.apply(ringFrame('3', 11, { frameIndex: 2, frameCount: 4, fps: 16 }, 2))
      store.apply(ringFrame('3', 12, { frameIndex: 0, frameCount: 4, fps: 16 }, 3))
      const ring = store.get(exec('p1'))!.previewRings!['3']!['']!
      expect(ring.frameCount).toBe(4)
      expect(ring.fps).toBe(16)
      expect(Object.keys(ring.frames).sort()).toEqual(['0', '2'])
      expect(slotByte(store, '3', 0)).toBe(12)
      expect(slotByte(store, '3', 2)).toBe(11)
      // The plain single-image preview still tracks the latest frame.
      expect(new Uint8Array(store.get(exec('p1'))!.previews['3']!['']!.payload as ArrayBuffer)[0]).toBe(12)
    })

    it('a changed frameCount resets accumulated slots', () => {
      const store = storeWith(['p1'])
      store.apply(ringFrame('3', 1, { frameIndex: 0, frameCount: 4, fps: 16 }))
      store.apply(ringFrame('3', 2, { frameIndex: 1, frameCount: 8, fps: 16 }))
      const ring = store.get(exec('p1'))!.previewRings!['3']!['']!
      expect(ring.frameCount).toBe(8)
      expect(Object.keys(ring.frames)).toEqual(['1'])
    })

    it('a still frame without ring addressing drops the stale ring', () => {
      const store = storeWith(['p1'])
      store.apply(ringFrame('3', 1, { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.apply(frame('p1', '3', 9, 2))
      const state = store.get(exec('p1'))!
      expect(state.previewRings!['3']).toBeUndefined()
      expect(new Uint8Array(state.previews['3']!['']!.payload as ArrayBuffer)[0]).toBe(9)
    })

    it('rings are independent per node', () => {
      const store = storeWith(['p1'])
      store.apply(ringFrame('3', 1, { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.apply(frame('p1', '5', 9, 2))
      const state = store.get(exec('p1'))!
      expect(state.previewRings!['3']!['']!.frameCount).toBe(4)
      expect(state.previewRings!['5']).toBeUndefined()
    })

    it.each(['completed', 'interrupted', 'error'] as const)(
      'a terminal execution (%s) releases its rings but keeps the stills',
      (kind) => {
        const store = storeWith(['p1'])
        store.apply(ringFrame('3', 1, { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
        store.apply(
          kind === 'error'
            ? {
                kind, execution: exec('p1'), timestamp: 2,
                detail: { exceptionType: 'Boom', exceptionMessage: 'boom', traceback: [] },
              }
            : { kind, execution: exec('p1'), timestamp: 2 },
        )
        const state = store.get(exec('p1'))!
        expect(state.previewRings).toBeUndefined()
        expect(state.previews['3']).toBeDefined()
      },
    )

    it('a lost execution releases its rings', () => {
      const store = storeWith(['p1'])
      store.apply(ringFrame('3', 1, { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.markLost(exec('p1'), 2)
      const state = store.get(exec('p1'))!
      expect(state.status).toBe('interrupted')
      expect(state.previewRings).toBeUndefined()
    })

    it('a straggler ring frame after a terminal verdict never rebuilds a ring', () => {
      const store = storeWith(['p1'])
      store.markLost(exec('p1'), 1)
      store.apply(ringFrame('3', 5, { frameIndex: 0, frameCount: 4, fps: 16 }, 2))
      const state = store.get(exec('p1'))!
      expect(state.previewRings).toBeUndefined()
      // The retained still may refresh anyway.
      expect(new Uint8Array(state.previews['3']!['']!.payload as ArrayBuffer)[0]).toBe(5)
    })
  })

  describe('multi-stream frames', () => {
    const streamFrame = (
      node: string,
      byte: number,
      stream: string,
      ring: { frameIndex?: number; frameCount?: number; fps?: number } = {},
      timestamp = 1,
    ) => ({ ...frame('p1', node, byte, timestamp), stream, ...ring })

    it('retains one still per stream on the same node', () => {
      const store = storeWith(['p1'])
      store.apply(streamFrame('3', 1, 'video', {}, 1))
      store.apply(streamFrame('3', 2, 'audio', {}, 2))
      store.apply(streamFrame('3', 3, 'video', {}, 3))
      const node = store.get(exec('p1'))!.previews['3']!
      expect(Object.keys(node).sort()).toEqual(['audio', 'video'])
      expect(new Uint8Array(node['video']!.payload as ArrayBuffer)[0]).toBe(3)
      expect(new Uint8Array(node['audio']!.payload as ArrayBuffer)[0]).toBe(2)
    })

    it('a still on one stream never drops another stream\'s ring', () => {
      const store = storeWith(['p1'])
      store.apply(streamFrame('3', 1, 'video', { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.apply(streamFrame('3', 2, 'audio', {}, 2))
      const state = store.get(exec('p1'))!
      expect(state.previewRings!['3']!['video']!.frameCount).toBe(4)
      expect(new Uint8Array(state.previews['3']!['audio']!.payload as ArrayBuffer)[0]).toBe(2)
    })

    it('a still on the ring\'s own stream drops exactly that ring', () => {
      const store = storeWith(['p1'])
      store.apply(streamFrame('3', 1, 'video', { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.apply(streamFrame('3', 2, 'audio', { frameIndex: 0, frameCount: 4, fps: 16 }, 2))
      store.apply(streamFrame('3', 3, 'video', {}, 3))
      const rings = store.get(exec('p1'))!.previewRings!['3']!
      expect(rings['video']).toBeUndefined()
      expect(rings['audio']!.frameCount).toBe(4)
    })

    it('dropping a node\'s only ring removes its whole entry', () => {
      const store = storeWith(['p1'])
      store.apply(streamFrame('3', 1, 'video', { frameIndex: 0, frameCount: 4, fps: 16 }, 1))
      store.apply(streamFrame('3', 2, 'video', {}, 2))
      expect(store.get(exec('p1'))!.previewRings!['3']).toBeUndefined()
    })
  })
})

describe('bounded execution activity', () => {
  const C0 = asConnectionId('c0')
  const execution = (prompt: string) => ({ connection: C0, prompt: asPromptId(prompt) })
  const activity = (prompt: string, index: number) => ({
    kind: 'activity' as const,
    execution: execution(prompt),
    timestamp: index,
    activity: {
      kind: 'cache_miss' as const,
      nodeId: `node-${index}`,
      reason: 'first-seen',
    },
  })

  it('retains at most 200 activity entries per run in FIFO order', () => {
    const store = new ExecutionStore()
    for (let index = 0; index < 205; index += 1) store.apply(activity('current', index))
    const entries = store.get(execution('current'))!.activities
    expect(entries).toHaveLength(200)
    expect(entries[0]).toEqual(activity('current', 5).activity)
    expect(entries[199]).toEqual(activity('current', 204).activity)
  })

  it('isolates activity from foreign and previous runs', () => {
    const store = new ExecutionStore()
    store.apply(activity('previous', 1))
    store.apply(activity('foreign', 2))
    store.apply(activity('current', 3))
    expect(store.get(execution('current'))!.activities).toEqual([activity('current', 3).activity])
    expect(store.get(execution('previous'))!.activities).toEqual([activity('previous', 1).activity])
    expect(store.get(execution('foreign'))!.activities).toEqual([activity('foreign', 2).activity])
  })
})

describe('bounded execution value diagnostics', () => {
  const C0 = asConnectionId('c0')
  const execution = { connection: C0, prompt: asPromptId('diagnostics') }
  const alpha = (index: number) => ({
    code: 'alpha_dropped' as const,
    nodeId: 'outer[0]/inner[2]/composite',
    outputId: `output-${index}`,
    inputIds: ['foreground', 'mask'],
  })
  const event = (diagnostics: readonly ReturnType<typeof alpha>[], timestamp = 1) => ({
    kind: 'valueDiagnostics' as const,
    execution,
    timestamp,
    diagnostics,
  })

  it('deduplicates live and replayed diagnostics while preserving nested runtime ids', () => {
    const store = new ExecutionStore()
    store.apply(event([alpha(1), alpha(1)]))
    store.apply(event([alpha(1)], 2))
    expect(store.get(execution)!.valueDiagnostics).toEqual([alpha(1)])
  })

  it('keeps coercion loss distinct from output loss while deduplicating both on replay', () => {
    const store = new ExecutionStore()
    const output = { ...alpha(1), inputIds: ['foreground'] }
    const coercion = { code: output.code, nodeId: output.nodeId, outputId: output.outputId, inputId: 'foreground' }
    for (const timestamp of [1, 2]) {
      store.apply({ kind: 'valueDiagnostics', execution, timestamp, diagnostics: [output, coercion] })
    }
    expect(store.get(execution)!.valueDiagnostics).toEqual([output, coercion])
  })

  it('retains at most 200 unique diagnostics in FIFO order', () => {
    const store = new ExecutionStore()
    for (let index = 0; index < 205; index += 1) store.apply(event([alpha(index)], index))
    const diagnostics = store.get(execution)!.valueDiagnostics!
    expect(diagnostics).toHaveLength(200)
    expect(diagnostics[0]).toEqual(alpha(5))
    expect(diagnostics[199]).toEqual(alpha(204))
  })

  it('does not change terminal status or cached node state', () => {
    const store = new ExecutionStore()
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 1,
      nodes: { 'outer[0]/inner[2]/composite': { state: 'cached' } },
    })
    store.apply({ kind: 'completed', execution, timestamp: 2 })
    store.apply(event([alpha(1)], 3))
    const state = store.get(execution)!
    expect(state.status).toBe('completed')
    expect(state.nodes['outer[0]/inner[2]/composite']!.state).toBe('cached')
    expect(state.endedAt).toBe(2)
    expect(state.errors).toEqual([])
  })
})

describe('bounded execution logs', () => {
  const C0 = asConnectionId('c0')
  const execution = (prompt: string) => ({ connection: C0, prompt: asPromptId(prompt) })
  const log = (prompt: string, index: number, extra: Record<string, unknown> = {}) => ({
    kind: 'log' as const,
    execution: execution(prompt),
    timestamp: index,
    level: 'info' as const,
    message: `line ${index}`,
    seq: index,
    ...extra,
  })

  it('appends log entries in arrival order with metadata preserved', () => {
    const store = new ExecutionStore()
    store.apply(log('run', 1))
    store.apply(log('run', 2, {
      runtimeNodeId: 'sampler',
      origin: 'logging',
      logger: 'dinkster.engine',
      pythonLevel: 'ERROR',
      seq: 9,
    }))
    const state = store.get(execution('run'))!
    expect(state.logs).toEqual([
      { level: 'info', message: 'line 1', timestamp: 1, seq: 1 },
      {
        level: 'info',
        message: 'line 2',
        timestamp: 2,
        runtimeNodeId: 'sampler',
        origin: 'logging',
        logger: 'dinkster.engine',
        pythonLevel: 'ERROR',
        seq: 9,
      },
    ])
    expect(state.logsDropped).toBe(0)
  })

  it('applies a record with a given seq exactly once regardless of arrival clock', () => {
    const store = new ExecutionStore()
    store.apply(log('run', 1, { seq: 4 }))
    // Same record normalized by another window: same seq, later arrival clock.
    store.apply(log('run', 99, { seq: 4 }))
    store.apply(log('run', 2, { seq: 5 }))
    store.apply(log('run', 3, { seq: 5 }))
    const state = store.get(execution('run'))!
    expect(state.logs.map((entry) => entry.seq)).toEqual([4, 5])
    expect(state.logsDropped).toBe(0)
  })

  it('an unseen lower seq arriving late fills its gap in seq order', () => {
    const store = new ExecutionStore()
    store.apply(log('run', 1, { seq: 4 }))
    store.apply(log('run', 2, { seq: 6 }))
    // The live socket dropped seq 5; a replay delivers it after seq 6.
    store.apply(log('run', 100, { seq: 5 }))
    // A second delivery of the gap-fill is still a duplicate.
    store.apply(log('run', 101, { seq: 5 }))
    const state = store.get(execution('run'))!
    expect(state.logs.map((entry) => entry.seq)).toEqual([4, 5, 6])
    expect(state.logsDropped).toBe(0)
  })

  it('an in-window gap-fill at capacity evicts the oldest retained record', () => {
    const store = new ExecutionStore()
    for (let index = 0; index <= 2000; index += 1) {
      if (index === 1000) continue
      store.apply(log('run', index, { seq: index }))
    }
    const before = store.get(execution('run'))!
    expect(before.logs).toHaveLength(2000)
    expect(before.logsDropped).toBe(0)
    store.apply(log('run', 9_000, { seq: 1000 }))
    const state = store.get(execution('run'))!
    expect(state.logs).toHaveLength(2000)
    expect(state.logs[0]!.seq).toBe(1)
    expect(state.logs.some((entry) => entry.seq === 1000)).toBe(true)
    expect(state.logsDropped).toBe(1)
  })

  it('ignores replays older than the retained window after FIFO eviction', () => {
    const store = new ExecutionStore()
    for (let index = 0; index < 2005; index += 1) store.apply(log('run', index, { seq: index }))
    // seqs 0..4 were evicted and counted; replaying one must neither re-enter
    // nor inflate the drop count.
    store.apply(log('run', 9_000, { seq: 3 }))
    const state = store.get(execution('run'))!
    expect(state.logs).toHaveLength(2000)
    expect(state.logs[0]!.seq).toBe(5)
    expect(state.logsDropped).toBe(5)
  })

  it('prefers backend emit time over normalizer arrival time', () => {
    const store = new ExecutionStore()
    store.apply(log('run', 5, { emittedAt: 1755772800250 }))
    expect(store.get(execution('run'))!.logs[0]!.timestamp).toBe(1755772800250)
  })

  it('retains at most 2000 log entries per run in FIFO order and counts drops', () => {
    const store = new ExecutionStore()
    for (let index = 0; index < 2005; index += 1) store.apply(log('run', index))
    const state = store.get(execution('run'))!
    expect(state.logs).toHaveLength(2000)
    expect(state.logs[0]!.message).toBe('line 5')
    expect(state.logs[1999]!.message).toBe('line 2004')
    expect(state.logsDropped).toBe(5)
  })

  it('isolates logs between runs', () => {
    const store = new ExecutionStore()
    store.apply(log('a', 1))
    store.apply(log('b', 2))
    expect(store.get(execution('a'))!.logs).toHaveLength(1)
    expect(store.get(execution('b'))!.logs).toHaveLength(1)
  })
})

describe('CL4 terminal transition hardening', () => {
  const execution = { connection: asConnectionId('c0'), prompt: asPromptId('terminal') }

  it('keeps authoritative terminal states absorbing while hydrating output', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'completed', execution, timestamp: 1 })
    store.apply({ kind: 'started', execution, timestamp: 2 })
    store.apply({ kind: 'nodeOutput', execution, timestamp: 3, runtimeNodeId: '1', output: { value: 7 } })
    expect(store.get(execution)!.status).toBe('completed')
    expect(store.get(execution)!.outputs['1']).toEqual({ value: 7 })
  })

  it('allows an authoritative terminal result to supersede inferred loss', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.markLost(execution, 2)
    store.apply({ kind: 'completed', execution, timestamp: 3 })
    expect(store.get(execution)!.status).toBe('completed')
  })

  it('CL4 a live started event revives a provisionally lost run and retracts the warning', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.markLost(execution, 2)
    expect(store.get(execution)!.errors.some((d) => d.code === 'execution.lost')).toBe(true)
    store.apply({ kind: 'started', execution, timestamp: 3 })
    const state = store.get(execution)!
    expect(state.status).toBe('running')
    expect(state.endedAt).toBeUndefined()
    expect(state.errors.some((d) => d.code === 'execution.lost')).toBe(false)
  })

  it('FR-5 live node progress revives a provisionally lost run like started does', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.markLost(execution, 2)
    // A resumed run's first event after a gap can be a node update - there
    // is never a second run_started to trigger the started revival path.
    store.apply({ kind: 'nodeStates', execution, timestamp: 3, nodes: { n1: { state: 'running' } } })
    const state = store.get(execution)!
    expect(state.status).toBe('running')
    expect(state.endedAt).toBeUndefined()
    expect(state.nodes['n1']).toEqual({ state: 'running' })
    expect(state.errors.some((d) => d.code === 'execution.lost')).toBe(false)
  })

  it('keeps execution attribution through detail-less progress and a runtime failure', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 2,
      nodes: { sample: { state: 'running', executionArm: 'comfyui', provider: 'vision.depth.v3', pack: 'vision-pack', worker: 'render-box' } },
    })
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 3,
      nodes: { sample: { state: 'running', value: 0.5, max: 2 } },
    })
    expect(store.get(execution)!.nodes['sample']).toEqual({
      state: 'running',
      value: 0.5,
      max: 2,
      executionArm: 'comfyui',
      provider: 'vision.depth.v3',
      pack: 'vision-pack',
      worker: 'render-box',
    })
    store.apply({
      kind: 'error',
      execution,
      timestamp: 4,
      runtimeNodeId: 'sample',
      detail: {
        exceptionType: 'RuntimeError',
        exceptionMessage: 'failed',
        traceback: [],
      },
    })
    expect(store.get(execution)!.nodes['sample']).toEqual({
      state: 'error',
      executionArm: 'comfyui',
      provider: 'vision.depth.v3',
      pack: 'vision-pack',
      worker: 'render-box',
    })
  })

  it('FR-6 a snapshot merges conservatively: fills gaps, upgrades to terminal, never regresses', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 2,
      nodes: { done: { state: 'done' }, live: { state: 'running', value: 0.5, max: 10 } },
    })
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 3,
      snapshot: true,
      nodes: {
        done: { state: 'running' }, // stale: fetched before the live terminal
        live: { state: 'running' }, // stale: no progress detail
        gap: { state: 'done' }, // finished during the WS gap: only here
        upgraded: { state: 'running', executionArm: 'native', worker: 'local' },
      },
    })
    const nodes = store.get(execution)!.nodes
    expect(nodes['done']).toEqual({ state: 'done' }) // never regressed
    expect(nodes['live']).toEqual({ state: 'running', value: 0.5, max: 10 }) // progress kept
    expect(nodes['gap']).toEqual({ state: 'done' }) // gap filled
    expect(nodes['upgraded']).toEqual({ state: 'running', executionArm: 'native', worker: 'local' }) // unknown node filled
    // A snapshot terminal upgrades a live running state (the gap-fill case).
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 4,
      snapshot: true,
      nodes: { upgraded: { state: 'done' } },
    })
    expect(store.get(execution)!.nodes['upgraded']).toEqual({
      state: 'done',
      executionArm: 'native',
      worker: 'local',
    })
    // LIVE events keep overwrite semantics: a rerun legitimately moves
    // done -> running, which a snapshot must never do.
    store.apply({ kind: 'nodeStates', execution, timestamp: 5, nodes: { done: { state: 'running' } } })
    expect(store.get(execution)!.nodes['done']).toEqual({ state: 'running' })
  })

  it('FR-6 a bare terminal snapshot never strips live output summaries or skip provenance', () => {
    // The backend updates nodeStates before publishing the engine event, so
    // a fetched record can carry BARE terminal states while the live wire
    // already delivered the enriched ones - and HTTP/WS ordering can invert.
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 2,
      nodes: {
        rich: { state: 'done', outputs: { sum: { typeId: 'core.int', value: 7 } } },
        why: { state: 'skipped', skipOrigin: 'p/out', skipReason: 'no value' },
        bare: { state: 'done' },
      },
    })
    store.apply({
      kind: 'nodeStates',
      execution,
      timestamp: 3,
      snapshot: true,
      nodes: {
        rich: { state: 'done' }, // bare: must not strip the live summary
        why: { state: 'skipped' }, // bare: must not strip provenance
        // descriptor-enriched: fills what the bare live event never carried
        bare: { state: 'done', outputs: { out: { typeId: 'core.string' } } },
      },
    })
    const nodes = store.get(execution)!.nodes
    expect(nodes['rich']).toEqual({ state: 'done', outputs: { sum: { typeId: 'core.int', value: 7 } } })
    expect(nodes['why']).toEqual({ state: 'skipped', skipOrigin: 'p/out', skipReason: 'no value' })
    expect(nodes['bare']).toEqual({ state: 'done', outputs: { out: { typeId: 'core.string' } } })
  })

  it('CL4 an authoritative terminal after inferred loss retracts the lost warning', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution, timestamp: 1 })
    store.markLost(execution, 2)
    store.apply({ kind: 'completed', execution, timestamp: 3 })
    expect(store.get(execution)!.errors.some((d) => d.code === 'execution.lost')).toBe(false)
  })
})

describe('recorded stream replay', () => {
  it('success: completed, all touched nodes terminal, outputs captured', () => {
    const { store, fixture } = replay('success')
    const state = store.get({ connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture)) })!
    expect(state.status).toBe('completed')
    expect(state.errors).toEqual([])
    for (const [id, p] of Object.entries(state.nodes)) {
      expect(['done', 'cached'], `node ${id} ended '${p.state}'`).toContain(p.state)
    }
    expect(Object.keys(state.outputs).length).toBeGreaterThan(0)
  })

  it('cached: both executions tracked independently and completed', () => {
    const { store, fixture } = replay('cached')
    const first = store.get({ connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture, 0)) })!
    const second = store.get({ connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture, 1)) })!
    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(Object.values(second.nodes).some((p) => p.state === 'cached')).toBe(true)
  })

  it('runtime_error: status error, node marked, detail preserved', () => {
    const { store, fixture } = replay('runtime_error')
    const state = store.get({ connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture)) })!
    expect(state.status).toBe('error')
    expect(state.errors).toHaveLength(1)
    const err = state.errors[0]!
    expect(err.origin).toBe('runtime')
    expect(err.runtime?.exceptionType.length).toBeGreaterThan(0)
    expect(err.runtime?.traceback.length).toBeGreaterThan(0)
    expect(err.anchor?.execution?.prompt).toBe(promptIdOf(fixture))
    const failed = (err.data as { runtimeId?: string } | undefined)?.runtimeId
    expect(failed).toBeDefined()
    expect(state.nodes[failed!]?.state).toBe('error')
  })

  it('interrupted: status interrupted, no error diagnostics', () => {
    const { store, fixture } = replay('interrupted')
    const state = store.get({ connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture)) })!
    expect(state.status).toBe('interrupted')
    expect(state.errors).toEqual([])
    expect(state.endedAt).toBeDefined()
  })

  it('validation_error: rejected before execution - store sees no execution', () => {
    const { store } = replay('validation_error')
    expect(store.executions.get().size).toBe(0)
  })

  it('status events feed the queueRemaining entry for their connection', () => {
    const { store } = replay('success')
    expect(store.queueRemaining.get().get(asConnectionId('c0'))).toBeDefined()
  })

  it('register after events (fast/cached run) merges, never clobbers state', () => {
    // WS events can outrun the /prompt HTTP response: replay the whole
    // stream FIRST, then register. Event-derived state must survive.
    const { store, fixture } = replay('success')
    const ref = { connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture)) }
    const before = store.get(ref)!
    expect(before.status).toBe('completed')
    store.register(ref, { prompt: {} } as never)
    const after = store.get(ref)!
    expect(after.status).toBe('completed')
    expect(after.nodes).toEqual(before.nodes)
    expect(after.outputs).toEqual(before.outputs)
    expect(after.artifact).toBeDefined()
  })

  it('restores a revalidated completed result without volatile stream state', () => {
    const store = new ExecutionStore()
    const ref = { connection: asConnectionId('c0'), prompt: asPromptId('restored') }
    const artifact = { prompt: { producer: { class_type: 'Float', inputs: {} } } } as never
    const artifacts = [{
      nodeId: 'producer',
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'value.json',
      size: 3,
      mediaType: 'application/json',
      virtualPath: 'output/value.json',
    }]
    store.restoreCompleted({
      ref,
      artifact,
      nodes: {},
      outputs: { producer: { value: 7.5 } },
      artifacts,
      submittedBy: { principalId: 'user-1', kind: 'human' },
      jobRef: 'job-restored',
      sourceDocument: `blake3:${'b'.repeat(64)}`,
      queuedAt: 10,
      endedAt: 20,
    })

    const restored = store.get(ref)!
    expect(restored).toMatchObject({
      status: 'completed',
      artifact,
      outputs: { producer: { value: 7.5 } },
      submittedBy: { principalId: 'user-1', kind: 'human' },
      jobRef: 'job-restored',
      queuedAt: 10,
      endedAt: 20,
    })
    expect(restored.artifacts).toEqual(artifacts)
    expect(restored.artifactsHydrated).toBe(true)
    expect(restored.previews).toEqual({})
    expect(restored.activities).toEqual([])
    expect(restored.logs).toEqual([])
  })

  it('hydrateOutputs merges history outputs without overwriting live ones', () => {
    const { store, fixture } = replay('success')
    const ref = { connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture)) }
    const liveOutputs = store.get(ref)!.outputs
    const liveNodeId = Object.keys(liveOutputs)[0]!
    store.hydrateOutputs(ref, {
      [liveNodeId]: { images: [{ filename: 'stale-from-history.png' }] },
      extraNode: { text: ['hydrated'] },
    })
    const after = store.get(ref)!
    expect(after.outputs[liveNodeId]).toEqual(liveOutputs[liveNodeId]) // live wins
    expect(after.outputs['extraNode']).toEqual({ text: ['hydrated'] })
  })

  it('hydrates completed execution artifacts without changing output descriptors', () => {
    const { store, fixture } = replay('success')
    const ref = { connection: asConnectionId('c0'), prompt: asPromptId(promptIdOf(fixture)) }
    const outputs = store.get(ref)!.outputs
    expect(store.get(ref)!.artifactsHydrated).toBe(false)
    const artifacts = [{
      nodeId: 'save-video',
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'result.webm',
      size: 4043,
      mediaType: 'video/webm',
      virtualPath: 'output/result.webm',
    }]
    store.hydrateArtifacts(ref, artifacts)
    const after = store.get(ref)!
    expect(after.artifacts).toEqual(artifacts)
    expect(after.artifacts).not.toBe(artifacts)
    expect(after.artifactsHydrated).toBe(true)
    expect(after.outputs).toEqual(outputs)
  })

  it('queue depth is independent per connection', () => {
    const store = new ExecutionStore()
    const a = asConnectionId('a')
    const b = asConnectionId('b')
    store.apply({ kind: 'status', connection: a, timestamp: 0, queueRemaining: 3 })
    store.apply({ kind: 'status', connection: b, timestamp: 1, queueRemaining: 7 })
    expect(store.queueRemaining.get().get(a)).toBe(3)
    expect(store.queueRemaining.get().get(b)).toBe(7)
    // A later status for one backend never touches the other's depth.
    store.apply({ kind: 'status', connection: a, timestamp: 2, queueRemaining: 0 })
    expect(store.queueRemaining.get().get(a)).toBe(0)
    expect(store.queueRemaining.get().get(b)).toBe(7)
  })

  it('identical prompt ids on different connections are distinct executions', () => {
    const store = new ExecutionStore()
    const onA = { connection: asConnectionId('a'), prompt: asPromptId('p1') }
    const onB = { connection: asConnectionId('b'), prompt: asPromptId('p1') }
    store.apply({ kind: 'started', execution: onA, timestamp: 0 })
    store.apply({ kind: 'started', execution: onB, timestamp: 1 })
    store.apply({ kind: 'completed', execution: onB, timestamp: 2 })
    expect(store.executions.get().size).toBe(2)
    expect(store.get(onA)!.status).toBe('running') // b's terminal event never bled over
    expect(store.get(onB)!.status).toBe('completed')
  })

  it('retains region expansion and terminal counts by runtime region id', () => {
    const store = new ExecutionStore()
    const execution = { connection: asConnectionId('a'), prompt: asPromptId('region-run') }
    store.apply({
      kind: 'regionExpanded',
      execution,
      timestamp: 1,
      runtimeNodeId: 'r',
      regionKind: 'map',
      binding: 'zip',
      iterations: 3,
    })
    store.apply({
      kind: 'regionFinished',
      execution,
      timestamp: 2,
      runtimeNodeId: 'r',
      iterations: 3,
    })
    expect(store.get(execution)!.regions).toEqual({
      r: { kind: 'map', binding: 'zip', iterations: 3, finishedIterations: 3 },
    })
  })

  it('executions signal publishes immutable snapshots', () => {
    const fixture = readStream('success')
    const store = new ExecutionStore()
    const conn = new BackendConnection({ id: asConnectionId('c0'), baseUrl: 'http://test', clientId: 't' })
    conn.onEvent((e) => store.apply(e))
    const seen: ReadonlyMap<string, unknown>[] = []
    store.executions.subscribe((m) => seen.push(m))
    for (const msg of fixture.messages) conn.ingest(msg)
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(seen.length) // every publish is a fresh map
  })
})

describe('bounded execution retention', () => {
  const C0 = asConnectionId('c0')
  const C1 = asConnectionId('c1')
  const exec = (prompt: string, connection = C0) => ({ connection, prompt: asPromptId(prompt) })

  const bigFrame = (prompt: string, bytes: number, timestamp = 1) => ({
    kind: 'preview' as const,
    execution: exec(prompt),
    timestamp,
    runtimeNodeId: '1',
    channel: 'comfy/preview-image',
    payload: new ArrayBuffer(bytes),
  })

  const MIB = 1024 * 1024

  it('strips preview frames from older terminal executions beyond the byte budget', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('p1'), timestamp: 1 })
    store.apply(bigFrame('p1', 40 * MIB, 2))
    store.apply({ kind: 'preview', execution: exec('p1'), timestamp: 2, channel: 'comfy/preview-image', payload: new ArrayBuffer(1 * MIB) })
    store.apply({ kind: 'completed', execution: exec('p1'), timestamp: 3 })
    store.apply({ kind: 'started', execution: exec('p2'), timestamp: 4 })
    store.apply(bigFrame('p2', 40 * MIB, 5))
    store.apply({ kind: 'completed', execution: exec('p2'), timestamp: 6 })
    const p1 = store.get(exec('p1'))!
    const p2 = store.get(exec('p2'))!
    expect(p1.previews).toEqual({})
    expect(p1.lastPreview).toBeUndefined()
    expect(p1.status).toBe('completed') // stripped, not evicted
    expect(p2.previews['1']).toBeDefined()
  })

  it('never strips preview frames from in-flight executions', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('running'), timestamp: 1 })
    store.apply(bigFrame('running', 80 * MIB, 2))
    store.apply({ kind: 'started', execution: exec('t1'), timestamp: 3 })
    store.apply(bigFrame('t1', 40 * MIB, 4))
    store.apply({ kind: 'completed', execution: exec('t1'), timestamp: 5 })
    store.apply({ kind: 'started', execution: exec('t2'), timestamp: 6 })
    store.apply(bigFrame('t2', 40 * MIB, 7))
    store.apply({ kind: 'completed', execution: exec('t2'), timestamp: 8 })
    expect(store.get(exec('running'))!.previews['1']).toBeDefined()
    expect(store.get(exec('t1'))!.previews).toEqual({})
    expect(store.get(exec('t2'))!.previews['1']).toBeDefined()
  })

  it('budgets each connection independently', () => {
    const store = new ExecutionStore()
    for (const connection of [C0, C1]) {
      store.apply({ kind: 'started', execution: exec('p1', connection), timestamp: 1 })
      store.apply({ ...bigFrame('p1', 40 * MIB, 2), execution: exec('p1', connection) })
      store.apply({ kind: 'completed', execution: exec('p1', connection), timestamp: 3 })
    }
    expect(store.get(exec('p1', C0))!.previews['1']).toBeDefined()
    expect(store.get(exec('p1', C1))!.previews['1']).toBeDefined()
  })

  it('evicts the oldest terminal executions beyond the entry cap', () => {
    const store = new ExecutionStore()
    for (let i = 0; i < 205; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i })
      store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: i })
    }
    expect(store.executions.get().size).toBe(200)
    expect(store.get(exec('p0'))).toBeUndefined()
    expect(store.get(exec('p4'))).toBeUndefined()
    expect(store.get(exec('p5'))).toBeDefined()
    expect(store.get(exec('p204'))).toBeDefined()
  })

  it('re-enforces the byte budget when a straggler frame lands on a terminal execution', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('p1'), timestamp: 1 })
    store.apply(bigFrame('p1', 40 * MIB, 2))
    store.apply({ kind: 'completed', execution: exec('p1'), timestamp: 3 })
    store.apply({ kind: 'started', execution: exec('p2'), timestamp: 4 })
    store.apply(bigFrame('p2', 40 * MIB, 5))
    store.apply({ kind: 'completed', execution: exec('p2'), timestamp: 6 })
    expect(store.get(exec('p1'))!.previews).toEqual({}) // stripped by p2's terminal transition
    store.apply(bigFrame('p1', 40 * MIB, 7))
    expect(store.get(exec('p1'))!.previews).toEqual({}) // straggler must not regain frames past the budget
    store.apply({ kind: 'preview', execution: exec('p1'), timestamp: 8, channel: 'comfy/preview-image', payload: new ArrayBuffer(40 * MIB) })
    expect(store.get(exec('p1'))!.lastPreview).toBeUndefined()
    expect(store.get(exec('p2'))!.previews['1']).toBeDefined() // newest terminal keeps its frames
  })

  it('never evicts a provisionally lost execution', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('lost'), timestamp: 0 })
    store.markLost(exec('lost'), 1)
    for (let i = 0; i < 205; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i + 2 })
      store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: i + 2 })
    }
    expect(store.get(exec('lost'))).toBeDefined()
    expect(store.isProvisionallyLost(exec('lost'))).toBe(true)
    // A later live event still revives it after eviction churn.
    store.apply({ kind: 'started', execution: exec('lost'), timestamp: 300 })
    expect(store.get(exec('lost'))!.status).toBe('running')
    expect(store.isProvisionallyLost(exec('lost'))).toBe(false)
  })

  it('retained executions survive entry-cap eviction until released', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('pinned'), timestamp: 0 })
    store.apply({ kind: 'completed', execution: exec('pinned'), timestamp: 0 })
    store.retain(exec('pinned'))
    for (let i = 0; i < 210; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i + 1 })
      store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: i + 1 })
    }
    expect(store.get(exec('pinned'))).toBeDefined()
    store.release(exec('pinned'))
    store.apply({ kind: 'started', execution: exec('after'), timestamp: 500 })
    expect(store.get(exec('pinned'))).toBeUndefined() // oldest evictable once unpinned
  })

  it('late chatter never resurrects an evicted terminal execution', () => {
    const store = new ExecutionStore()
    for (let i = 0; i < 205; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i })
      store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: i })
    }
    expect(store.get(exec('p0'))).toBeUndefined() // evicted
    store.apply(bigFrame('p0', 1 * MIB, 300))
    store.apply({ kind: 'preview', execution: exec('p0'), timestamp: 301, channel: 'comfy/preview-image', payload: new ArrayBuffer(1024) })
    store.apply({ kind: 'completed', execution: exec('p0'), timestamp: 302 })
    expect(store.get(exec('p0'))).toBeUndefined() // stragglers must not recreate a protected entry
    // A genuine new run reusing the id is still accepted.
    store.apply({ kind: 'started', execution: exec('p0'), timestamp: 400 })
    expect(store.get(exec('p0'))!.status).toBe('running')
  })

  /** The exact wire frame the server would send for one preview event. */
  const wirePreviewFrame = (
    jobId: string,
    bytes: number,
    nodeId?: string,
    ring?: { readonly stream: string; readonly frameIndex: number; readonly frameCount: number; readonly fps?: number },
  ): ArrayBuffer => {
    const header = new TextEncoder().encode(JSON.stringify({
      type: 'node_event', event: 'preview', jobId,
      ...(nodeId !== undefined ? { nodeId } : {}),
      data: { mime: 'image/jpeg', ...(ring ?? {}) },
    }))
    const frame = new Uint8Array(4 + header.length + bytes)
    new DataView(frame.buffer).setUint32(0, header.length, false)
    frame.set(header, 4)
    return frame.buffer
  }

  it('late wire chatter past the tombstone window stays bounded by the entry cap and preview budget', () => {
    const store = new ExecutionStore()
    // 1000 settled runs evict 800 entries, far past the bounded tombstone
    // set, so stragglers for the oldest runs are admitted as unconfirmed
    // entries instead of being discarded outright.
    for (let i = 0; i < 1000; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i * 10 })
      store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: i * 10 + 5 })
    }
    expect(store.executions.get().size).toBe(200)
    // Stragglers arrive through the real normalizer, which stamps client
    // arrival time - by timestamp they are indistinguishable from a mid-run
    // join, so each recreates its run, but only as an unconfirmed entry.
    const normalizer = new DinksterNormalizer(C0)
    for (let i = 0; i < 600; i += 50) {
      const frame = wirePreviewFrame(`p${i}`, 10 * MIB, i % 100 === 0 ? '1' : undefined)
      for (const event of normalizer.normalize(frame)) store.apply(event)
    }
    // Unconfirmed entries stay under the entry cap...
    expect(store.executions.get().size).toBe(200)
    // ...and their frames stay under the preview byte budget (12 x 10 MiB
    // arrived; anything beyond 64 MiB was stripped, newest kept first).
    const retainedBytes = [...store.executions.get().values()].reduce((sum, state) => {
      let bytes = state.lastPreview?.payload instanceof ArrayBuffer ? state.lastPreview.payload.byteLength : 0
      for (const streams of Object.values(state.previews)) {
        for (const frame of Object.values(streams)) bytes += frame.payload instanceof ArrayBuffer ? frame.payload.byteLength : 0
      }
      return sum + bytes
    }, 0)
    expect(retainedBytes).toBeLessThanOrEqual(64 * MIB)
    // Unconfirmed entries hold no protected status: newer settled work
    // evicts them like any terminal entry.
    const base = Date.now() + 1_000_000
    for (let i = 0; i < 200; i++) {
      store.apply({ kind: 'started', execution: exec(`q${i}`), timestamp: base + i })
      store.apply({ kind: 'completed', execution: exec(`q${i}`), timestamp: base + i })
    }
    expect(store.executions.get().size).toBe(200)
    expect(store.get(exec('p0'))).toBeUndefined()
    expect(store.get(exec('p550'))).toBeUndefined()
  })

  it('a mid-run join is admitted unconfirmed, confirmed by a start, and settles normally', () => {
    const store = new ExecutionStore()
    const normalizer = new DinksterNormalizer(C0)
    // First contact with a run another window submitted can be a preview.
    for (const event of normalizer.normalize(wirePreviewFrame('joined', 1024, '1'))) store.apply(event)
    expect(store.get(exec('joined'))).toBeDefined()
    store.apply({ kind: 'completed', execution: exec('joined'), timestamp: Date.now() })
    expect(store.get(exec('joined'))!.status).toBe('completed')
    // A resumed run's start confirms an entry first seen through chatter:
    // confirmed running entries are protected from cap eviction.
    for (const event of normalizer.normalize(wirePreviewFrame('confirmed', 1024, '1'))) store.apply(event)
    store.apply({ kind: 'started', execution: exec('confirmed'), timestamp: Date.now() })
    const base = Date.now() + 1_000_000
    for (let i = 0; i < 300; i++) {
      store.apply({ kind: 'started', execution: exec(`c${i}`), timestamp: base + i })
      store.apply({ kind: 'completed', execution: exec(`c${i}`), timestamp: base + i })
    }
    expect(store.get(exec('confirmed'))!.status).toBe('running')
  })

  it('chatter cannot grow a store whose cap is filled entirely by protected running work', () => {
    const store = new ExecutionStore()
    for (let i = 0; i < 200; i++) {
      store.apply({ kind: 'started', execution: exec(`run${i}`), timestamp: i })
    }
    const normalizer = new DinksterNormalizer(C0)
    for (let i = 0; i < 70; i++) {
      for (const event of normalizer.normalize(wirePreviewFrame(`ghost${i}`, 1 * MIB, '1'))) store.apply(event)
    }
    // Each phantom is admitted, applied, then evicted by the cap: only the
    // 200 confirmed running entries remain, holding no phantom frames.
    expect(store.executions.get().size).toBe(200)
    for (let i = 0; i < 70; i++) expect(store.get(exec(`ghost${i}`))).toBeUndefined()
    // Repeated chatter for an evicted phantom is discarded outright.
    for (const event of normalizer.normalize(wirePreviewFrame('ghost69', 1 * MIB, '1'))) store.apply(event)
    expect(store.get(exec('ghost69'))).toBeUndefined()
    expect(store.executions.get().size).toBe(200)
  })

  it('ring-addressed wire frames count toward the preview budget and are stripped with it', () => {
    const store = new ExecutionStore()
    let tick = 0
    const normalizer = new DinksterNormalizer(C0, () => ++tick)
    const sendRing = (jobId: string, frames: number): void => {
      for (let f = 0; f < frames; f++) {
        const wire = wirePreviewFrame(jobId, 1 * MIB, '1', { stream: 'anim', frameIndex: f, frameCount: frames, fps: 8 })
        for (const event of normalizer.normalize(wire)) store.apply(event)
      }
    }
    sendRing('ringA', 30)
    sendRing('ringB', 30)
    sendRing('ringC', 10)
    // Newest first: ringC (10 MiB) + ringB (30 MiB) fit the 64 MiB budget;
    // ringA pushes the total to 70 MiB, so its frames and rings are stripped.
    const stripped = store.get(exec('ringA'))!
    expect(stripped.previewRings).toBeUndefined()
    expect(stripped.previews).toEqual({})
    expect(Object.keys(store.get(exec('ringB'))!.previewRings!['1']!['anim']!.frames)).toHaveLength(30)
    expect(Object.keys(store.get(exec('ringC'))!.previewRings!['1']!['anim']!.frames)).toHaveLength(10)
  })

  it('a ring slot shared with its stream still is counted once, not twice', () => {
    const store = new ExecutionStore()
    let tick = 0
    const normalizer = new DinksterNormalizer(C0, () => ++tick)
    const sendRing = (jobId: string, frames: number): void => {
      for (let f = 0; f < frames; f++) {
        const wire = wirePreviewFrame(jobId, 1 * MIB, '1', { stream: 'anim', frameIndex: f, frameCount: frames })
        for (const event of normalizer.normalize(wire)) store.apply(event)
      }
    }
    // Each job's newest ring slot IS its retained still. Counting payloads
    // by identity yields 33 + 30 = 63 MiB, inside the 64 MiB budget; naive
    // still-plus-ring counting would see 65 MiB and strip ringOld.
    sendRing('ringOld', 33)
    sendRing('ringNew', 30)
    expect(Object.keys(store.get(exec('ringOld'))!.previewRings!['1']!['anim']!.frames)).toHaveLength(33)
    expect(Object.keys(store.get(exec('ringNew'))!.previewRings!['1']!['anim']!.frames)).toHaveLength(30)
  })

  it('evicting an unconfirmed entry clears its provisional-loss verdict', () => {
    const store = new ExecutionStore()
    const normalizer = new DinksterNormalizer(C0)
    for (const event of normalizer.normalize(wirePreviewFrame('phantom', 1024, '1'))) store.apply(event)
    store.markLost(exec('phantom'))
    expect(store.isProvisionallyLost(exec('phantom'))).toBe(true)
    const base = Date.now() + 1_000_000
    for (let i = 0; i < 200; i++) {
      store.apply({ kind: 'started', execution: exec(`n${i}`), timestamp: base + i })
    }
    expect(store.get(exec('phantom'))).toBeUndefined()
    expect(store.isProvisionallyLost(exec('phantom'))).toBe(false)
  })

  it('completing an over-cap burst of running executions contracts the store to the cap', () => {
    const store = new ExecutionStore()
    for (let i = 0; i < 205; i++) store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i })
    expect(store.executions.get().size).toBe(205) // in-flight work is never evicted
    for (let i = 0; i < 205; i++) store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: 300 + i })
    expect(store.executions.get().size).toBe(200) // settling re-runs eviction
    expect(store.get(exec('p4'))).toBeUndefined()
    expect(store.get(exec('p5'))).toBeDefined()
    expect(store.get(exec('p204'))).toBeDefined()
  })

  it('releasing the last pin contracts an over-cap store immediately', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('pinned'), timestamp: 0 })
    store.apply({ kind: 'completed', execution: exec('pinned'), timestamp: 0 })
    store.retain(exec('pinned'))
    for (let i = 0; i < 200; i++) store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i + 1 })
    expect(store.executions.get().size).toBe(201) // all running plus the pinned terminal
    store.release(exec('pinned'))
    expect(store.get(exec('pinned'))).toBeUndefined()
    expect(store.executions.get().size).toBe(200)
  })

  it('a retain pin is refcounted', () => {
    const store = new ExecutionStore()
    store.apply({ kind: 'started', execution: exec('pinned'), timestamp: 0 })
    store.apply({ kind: 'completed', execution: exec('pinned'), timestamp: 0 })
    store.retain(exec('pinned'))
    store.retain(exec('pinned'))
    store.release(exec('pinned'))
    for (let i = 0; i < 205; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i + 1 })
      store.apply({ kind: 'completed', execution: exec(`p${i}`), timestamp: i + 1 })
    }
    expect(store.get(exec('pinned'))).toBeDefined() // one pin still held
  })

  it('never evicts queued or running executions even when over the cap', () => {
    const store = new ExecutionStore()
    for (let i = 0; i < 205; i++) {
      store.apply({ kind: 'started', execution: exec(`p${i}`), timestamp: i })
    }
    expect(store.executions.get().size).toBe(205)
    for (let i = 0; i < 205; i++) {
      expect(store.get(exec(`p${i}`))!.status).toBe('running')
    }
  })
})
