/**
 * Event normalizer for the current ComfyUI WS protocol ("comfy-v1").
 *
 * Grounded in ComfyUI source (send_sync call sites):
 * - execution.py: execution_start, execution_cached, execution_interrupted,
 *   execution_success, execution_error, executing, executed
 * - comfy_execution/progress.py: progress_state (multi-node state map with
 *   NodeState = pending|running|finished|error), legacy progress
 * - server.py: status (queue info); binary frames (protocol.py):
 *   PREVIEW_IMAGE=1, UNENCODED_PREVIEW_IMAGE=2, TEXT=3,
 *   PREVIEW_IMAGE_WITH_METADATA=4
 *
 * JSON envelope: {type: string, data: object}. All prompt-scoped data carries
 * prompt_id. The normalizer is per-connection (needs connectionId and a
 * little state for the legacy `executing` cursor protocol).
 *
 * Contract guard: output is always the per-node state map delta; the legacy
 * single-cursor protocol is absorbed HERE and nowhere else.
 */

import {
  asPromptId,
  type ConnectionId,
  type ExecutionRef,
  type PromptId,
} from '../ids.js'
import type { RuntimeErrorDetail } from '../diagnostics.js'
import type { EventNormalizer, NodeProgress, NormalizedEvent, OnMalformedEvent } from './contract.js'

/** Raw JSON WS message envelope. */
export interface RawJsonMessage {
  readonly type: string
  readonly data?: Readonly<Record<string, unknown>>
}

/** Raw binary WS frame, pre-split by the transport (4-byte BE event type). */
export interface RawBinaryFrame {
  readonly eventType: number
  readonly payload: ArrayBuffer
}

export type RawMessage = RawJsonMessage | RawBinaryFrame

const BINARY_PREVIEW_IMAGE = 1
const BINARY_UNENCODED_PREVIEW_IMAGE = 2
const BINARY_TEXT = 3
const BINARY_PREVIEW_IMAGE_WITH_METADATA = 4

type Clock = () => number

export class ComfyV1Normalizer implements EventNormalizer {
  /** Nodes reported running by the legacy `executing` cursor, per prompt. */
  private legacyRunning = new Map<string, string>()

  /**
   * Prompts that already emitted a terminal event (success/error/interrupt).
   * The server ALSO sends a trailing `executing: null` after errors and
   * interrupts (observed in recorded streams); that null cursor means "no
   * longer executing", NOT "succeeded", so it must not produce a second
   * terminal event.
   */
  private terminatedPrompts = new Set<string>()

  constructor(
    private readonly connection: ConnectionId,
    private readonly clock: Clock = Date.now,
    private readonly onMalformed?: OnMalformedEvent,
  ) {}

  private exec(promptId: string): ExecutionRef {
    return { connection: this.connection, prompt: asPromptId(promptId) }
  }

  /** A known event failed validation: report, deliver nothing. */
  private malformed(detail: string): NormalizedEvent[] {
    this.onMalformed?.(detail)
    return []
  }

  /**
   * The prompt currently executing on this connection, if known. Used to
   * attribute binary preview frames (which carry no prompt_id - a protocol
   * gap the Dinkster backend should close).
   */
  private currentPrompt: PromptId | undefined

  normalize(raw: RawMessage): readonly NormalizedEvent[] {
    if ('eventType' in raw) return this.normalizeBinary(raw)
    const t = this.clock()
    const d = raw.data ?? {}
    const promptId = typeof d['prompt_id'] === 'string' ? d['prompt_id'] : undefined

    switch (raw.type) {
      case 'status': {
        const execInfo = (d['status'] as Record<string, unknown> | undefined)?.['exec_info'] as
          | Record<string, unknown>
          | undefined
        const remaining = execInfo?.['queue_remaining']
        return [
          {
            kind: 'status',
            connection: this.connection,
            timestamp: t,
            ...(typeof remaining === 'number' ? { queueRemaining: remaining } : {}),
          },
        ]
      }
      case 'execution_start': {
        if (!promptId) return this.malformed('execution_start without prompt_id')
        this.currentPrompt = asPromptId(promptId)
        this.terminatedPrompts.delete(promptId)
        return [{ kind: 'started', execution: this.exec(promptId), timestamp: t }]
      }
      case 'execution_cached': {
        if (!promptId) return this.malformed('execution_cached without prompt_id')
        const rawNodes = d['nodes']
        if (!Array.isArray(rawNodes) || rawNodes.some((n) => typeof n !== 'string')) {
          return this.malformed('execution_cached with a malformed node list')
        }
        const nodes = rawNodes as string[]
        if (nodes.length === 0) return []
        const map: Record<string, NodeProgress> = {}
        for (const n of nodes) map[n] = { state: 'cached' }
        return [{ kind: 'nodeStates', execution: this.exec(promptId), timestamp: t, nodes: map }]
      }
      case 'progress_state': {
        if (!promptId) return this.malformed('progress_state without prompt_id')
        const rawNodes = d['nodes']
        if (typeof rawNodes !== 'object' || rawNodes === null || Array.isArray(rawNodes)) {
          return this.malformed('progress_state with a malformed node map')
        }
        const map: Record<string, NodeProgress> = {}
        for (const [nodeId, s] of Object.entries(rawNodes as Record<string, unknown>)) {
          // A malformed per-node entry rejects the whole event: partial state
          // deltas would be indistinguishable from real ones downstream.
          if (typeof s !== 'object' || s === null || Array.isArray(s)) {
            return this.malformed(`progress_state with a malformed entry for node '${nodeId.slice(0, 80)}'`)
          }
          const state = (s as Record<string, unknown>)['state']
          const value = (s as Record<string, unknown>)['value']
          const max = (s as Record<string, unknown>)['max']
          map[nodeId] = {
            state:
              state === 'running' ? 'running'
              : state === 'finished' ? 'done'
              : state === 'error' ? 'error'
              : 'pending',
            ...(typeof value === 'number' && typeof max === 'number' && max > 0
              ? { value: value / max, max }
              : {}),
          }
        }
        return [{ kind: 'nodeStates', execution: this.exec(promptId), timestamp: t, nodes: map }]
      }
      case 'progress': {
        // Legacy single-node progress: {value, max, prompt_id, node}. The
        // server fills prompt_id/node from last_prompt_id/last_node_id, both
        // of which are legitimately None outside an executing context: a
        // missing/null identity is an attribution gap, never malformed.
        if (!promptId) return []
        const rawNode = d['node']
        if (rawNode === undefined || rawNode === null) return []
        const node = typeof rawNode === 'string' ? rawNode : undefined
        const value = d['value']
        const max = d['max']
        if (
          !node ||
          typeof value !== 'number' || !Number.isFinite(value) ||
          typeof max !== 'number' || !Number.isFinite(max)
        ) {
          return this.malformed('progress with a malformed node/value/max')
        }
        // max <= 0 is the old contract's explicit benign no-op (ComfyUI's
        // ProgressBar accepts a zero total, e.g. an empty collection): keep
        // it silent, never a malformed report and never a fabricated update.
        if (max <= 0) return []
        return [
          {
            kind: 'nodeStates',
            execution: this.exec(promptId),
            timestamp: t,
            nodes: { [node]: { state: 'running', value: value / max, max } },
          },
        ]
      }
      case 'executing': {
        // Legacy cursor: {node: id | null, prompt_id}. node=null means "no
        // longer executing" - the server sends it after success, error AND
        // interrupt. It only signals completion when no explicit terminal
        // event was seen (very old servers without execution_success).
        // A prompt_id-less cursor is REAL: the server sends {node} alone to a
        // freshly (re)connected executing client - attribution gap, silent.
        if (!promptId) return []
        const node = d['node']
        if (typeof node !== 'string' && node !== null) {
          return this.malformed('executing with a malformed node cursor')
        }
        const events: NormalizedEvent[] = []
        const prev = this.legacyRunning.get(promptId)
        if (prev && prev !== node && typeof node === 'string') {
          events.push({
            kind: 'nodeStates',
            execution: this.exec(promptId),
            timestamp: t,
            nodes: { [prev]: { state: 'done' } },
          })
        }
        if (typeof node === 'string') {
          this.legacyRunning.set(promptId, node)
          events.push({
            kind: 'nodeStates',
            execution: this.exec(promptId),
            timestamp: t,
            nodes: { [node]: { state: 'running' } },
          })
        } else if (node === null) {
          this.legacyRunning.delete(promptId)
          if (this.terminatedPrompts.has(promptId)) {
            this.terminatedPrompts.delete(promptId)
          } else {
            if (prev) {
              events.push({
                kind: 'nodeStates',
                execution: this.exec(promptId),
                timestamp: t,
                nodes: { [prev]: { state: 'done' } },
              })
            }
            events.push({ kind: 'completed', execution: this.exec(promptId), timestamp: t })
          }
        }
        return events
      }
      case 'executed': {
        // {node, display_node, output, prompt_id} - a node emitted UI output.
        if (!promptId) return this.malformed('executed without prompt_id')
        const node = typeof d['node'] === 'string' ? d['node'] : undefined
        if (!node) return this.malformed('executed without a node id')
        const output = d['output']
        if (output !== undefined && output !== null && (typeof output !== 'object' || Array.isArray(output))) {
          return this.malformed('executed with a malformed output record')
        }
        return [
          {
            kind: 'nodeOutput',
            execution: this.exec(promptId),
            timestamp: t,
            runtimeNodeId: node,
            output: (d['output'] as Record<string, unknown> | null) ?? {},
          },
        ]
      }
      case 'execution_success': {
        if (!promptId) return this.malformed('execution_success without prompt_id')
        this.legacyRunning.delete(promptId)
        this.terminatedPrompts.add(promptId)
        if (this.currentPrompt === promptId) this.currentPrompt = undefined
        return [{ kind: 'completed', execution: this.exec(promptId), timestamp: t }]
      }
      case 'execution_interrupted': {
        if (!promptId) return this.malformed('execution_interrupted without prompt_id')
        this.legacyRunning.delete(promptId)
        this.terminatedPrompts.add(promptId)
        if (this.currentPrompt === promptId) this.currentPrompt = undefined
        return [{ kind: 'interrupted', execution: this.exec(promptId), timestamp: t }]
      }
      case 'execution_error': {
        if (!promptId) return this.malformed('execution_error without prompt_id')
        this.legacyRunning.delete(promptId)
        this.terminatedPrompts.add(promptId)
        if (this.currentPrompt === promptId) this.currentPrompt = undefined
        const detail: RuntimeErrorDetail = {
          exceptionType: String(d['exception_type'] ?? 'Unknown'),
          exceptionMessage: String(d['exception_message'] ?? ''),
          traceback: Array.isArray(d['traceback']) ? (d['traceback'] as string[]) : [],
          ...(d['current_inputs'] && typeof d['current_inputs'] === 'object' && !Array.isArray(d['current_inputs'])
            ? { currentInputs: d['current_inputs'] as Record<string, unknown> }
            : {}),
          ...(Array.isArray(d['current_outputs'])
            ? { currentOutputs: d['current_outputs'] as unknown[] }
            : {}),
        }
        const nodeId = typeof d['node_id'] === 'string' ? d['node_id'] : undefined
        return [
          {
            kind: 'error',
            execution: this.exec(promptId),
            timestamp: t,
            ...(nodeId ? { runtimeNodeId: nodeId } : {}),
            detail,
          },
        ]
      }
      default:
        // Unknown message types are dropped, not errors: custom packs emit
        // their own WS messages. (A pack-event channel is extension-API work.)
        return []
    }
  }

  private normalizeBinary(raw: RawBinaryFrame): readonly NormalizedEvent[] {
    const t = this.clock()

    // Metadata frames (negotiated via supports_preview_metadata) carry their
    // own prompt_id + node_id: full attribution, no current-prompt heuristic.
    if (raw.eventType === BINARY_PREVIEW_IMAGE_WITH_METADATA) {
      const parsed = parsePreviewMetadataFrame(raw.payload)
      if (!parsed) return this.malformed('undecodable preview metadata frame')
      // The server-side sender tolerates metadata without prompt_id (it fills
      // an empty record): a decodable frame missing prompt_id is a routing/
      // attribution gap like the legacy frames, never a malformed report.
      if (typeof parsed.meta['prompt_id'] !== 'string') return []
      const nodeId = parsed.meta['display_node_id'] ?? parsed.meta['node_id']
      return [
        {
          kind: 'preview',
          execution: this.exec(parsed.meta['prompt_id']),
          timestamp: t,
          ...(typeof nodeId === 'string' ? { runtimeNodeId: nodeId } : {}),
          channel: 'comfy/preview-image',
          payload: parsed.image,
        },
      ]
    }

    // Legacy frames carry no prompt_id (protocol gap; Dinkster backend to fix).
    // Attribute to the connection's currently-started prompt when known.
    const prompt = this.currentPrompt
    if (!prompt) return []
    const execution: ExecutionRef = { connection: this.connection, prompt }
    switch (raw.eventType) {
      case BINARY_PREVIEW_IMAGE:
      case BINARY_UNENCODED_PREVIEW_IMAGE:
        return [
          { kind: 'preview', execution, timestamp: t, channel: 'comfy/preview-image', payload: raw.payload },
        ]
      case BINARY_TEXT:
        return [{ kind: 'preview', execution, timestamp: t, channel: 'comfy/progress-text', payload: raw.payload }]
      default:
        return []
    }
  }
}

/**
 * PREVIEW_IMAGE_WITH_METADATA payload (after the transport strips the 4-byte
 * event type): 4-byte BE metadata length, UTF-8 JSON metadata
 * ({prompt_id, node_id, display_node_id, image_type, ...}), then raw encoded
 * image bytes. Malformed frames return undefined (dropped, never thrown).
 */
export function parsePreviewMetadataFrame(
  payload: ArrayBuffer,
): { meta: Readonly<Record<string, unknown>>; image: ArrayBuffer } | undefined {
  if (payload.byteLength < 4) return undefined
  const view = new DataView(payload)
  const metaLength = view.getUint32(0)
  if (4 + metaLength > payload.byteLength) return undefined
  try {
    const metaBytes = new Uint8Array(payload, 4, metaLength)
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as unknown
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
    return { meta: meta as Record<string, unknown>, image: payload.slice(4 + metaLength) }
  } catch {
    return undefined
  }
}
