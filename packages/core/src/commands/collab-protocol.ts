import type { Json } from '../format/document.js'
import { isValidActorId } from '../ids.js'
import type { WirePatchOp } from './session.js'

export const COLLAB_PROTOCOL_VERSION = 1

export type CollabDocumentKind = 'workflow' | 'image'

export interface CollabSessionDescriptor {
  readonly protocolVersion: number
  readonly sessionId: string
  readonly scope: string
  readonly documentId: string
  /** Omitted by protocol-v1 workflow-only servers and interpreted as workflow. */
  readonly documentKind?: CollabDocumentKind
  readonly revision: number
  readonly snapshotRevision: number
}

export interface CollabClientOp {
  readonly protocolVersion: number
  readonly opId: string
  readonly actorId: string
  readonly baseRevision: number
  readonly patch: readonly WirePatchOp[]
}

export interface CollabServerOp {
  readonly opId: string
  readonly actorId: string
  readonly baseRevision: number
  readonly revision: number
  readonly patch: readonly WirePatchOp[]
  readonly timestamp: number
  readonly replayed?: boolean
}

export type PostOpOutcome =
  | { readonly kind: 'accepted'; readonly op: CollabServerOp }
  | { readonly kind: 'stale-base'; readonly revision: number }
  | { readonly kind: 'snapshot-required' }
  | { readonly kind: 'protocol-unsupported'; readonly supported: readonly number[] }
  | { readonly kind: 'forbidden' | 'actor-principal-mismatch' | 'rate-limited'; readonly diagnostic: CollabDenial }
  | { readonly kind: 'error'; readonly message: string }

export interface CollabDenial {
  readonly version: 1
  readonly type: 'collab.denial'
  readonly code: string
  readonly status: number
  readonly message: string
  readonly sessionId: string
  readonly actorId: string
  readonly opId?: string
  readonly operation?: string
  readonly retryAfterMs?: number
}

export type FetchOpsOutcome =
  | { readonly kind: 'ops'; readonly ops: readonly CollabServerOp[] }
  | { readonly kind: 'resync-required'; readonly snapshotRevision: number }

export type PutSnapshotOutcome = { readonly kind: 'ok' } | { readonly kind: 'conflict' }

export type CollabConnectionEvent =
  | { readonly kind: 'connected'; readonly descriptor: CollabSessionDescriptor }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'op'; readonly op: CollabServerOp }
  | { readonly kind: 'presence'; readonly actorId: string; readonly payload?: Json }
  | { readonly kind: 'session-closed' }
  | { readonly kind: 'denial'; readonly diagnostic: CollabDenial }

export interface CollabConnection {
  readonly sessionId: string
  readonly denial?: CollabDenial | undefined
  postOp(op: CollabClientOp): Promise<PostOpOutcome>
  fetchSnapshot(): Promise<{ readonly revision: number; readonly document: unknown }>
  fetchOps(after: number): Promise<FetchOpsOutcome>
  putSnapshot(revision: number, document: unknown): Promise<PutSnapshotOutcome>
  sendPresence(payload: Json): void
  onEvent(listener: (event: CollabConnectionEvent) => void): () => void
  close(): void
}

export const isValidCollabRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const WIRE_PATCH_OPS: ReadonlySet<string> = new Set(['add', 'remove', 'replace'])
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function validateCollabWirePatchShape(patch: unknown): string | null {
  if (!Array.isArray(patch)) return 'patch must be an array'
  for (const raw of patch) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'patch op must be an object'
    const op = raw as { op?: unknown; path?: unknown; value?: unknown }
    if (typeof op.op !== 'string' || !WIRE_PATCH_OPS.has(op.op)) {
      return `unknown patch op ${JSON.stringify(op.op)}`
    }
    if (!Array.isArray(op.path) || op.path.length === 0) return 'patch path must be a non-empty array'
    for (const segment of op.path) {
      if (typeof segment === 'string') {
        if (FORBIDDEN_SEGMENTS.has(segment)) return `forbidden path segment '${segment}'`
      } else if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0) {
        return 'patch path segments must be strings or non-negative integers'
      }
    }
    if (op.op !== 'remove' && (!('value' in op) || op.value === undefined)) {
      return `${op.op} requires a value`
    }
  }
  return null
}

export function validateCollabServerOp(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return 'op envelope must be an object'
  const op = raw as Partial<CollabServerOp>
  if (typeof op.opId !== 'string' || op.opId.length === 0) return 'op envelope: invalid opId'
  if (!isValidActorId(op.actorId)) return 'op envelope: invalid actorId'
  if (!isValidCollabRevision(op.baseRevision)) return 'op envelope: invalid baseRevision'
  if (!isValidCollabRevision(op.revision) || op.revision < 1) return 'op envelope: invalid revision'
  if (op.baseRevision !== op.revision - 1) return 'op envelope: revision must be baseRevision + 1'
  if (typeof op.timestamp !== 'number' || !Number.isFinite(op.timestamp)) {
    return 'op envelope: invalid timestamp'
  }
  const patch = validateCollabWirePatchShape(op.patch)
  return patch === null ? null : `op envelope: ${patch}`
}

export function validateCollabDescriptor(
  raw: unknown,
  sessionId: string,
  documentKind: CollabDocumentKind,
): string | null {
  if (raw === null || typeof raw !== 'object') return 'descriptor must be an object'
  const descriptor = raw as Partial<CollabSessionDescriptor>
  if (descriptor.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
    return `descriptor: protocol version ${String(descriptor.protocolVersion)} unsupported (this client speaks ${COLLAB_PROTOCOL_VERSION})`
  }
  if (descriptor.sessionId !== sessionId) return 'descriptor: sessionId mismatch'
  if ((descriptor.documentKind ?? 'workflow') !== documentKind) return 'descriptor: documentKind mismatch'
  if (!isValidCollabRevision(descriptor.revision)) return 'descriptor: invalid revision'
  if (!isValidCollabRevision(descriptor.snapshotRevision) || descriptor.snapshotRevision > descriptor.revision) {
    return 'descriptor: invalid snapshotRevision'
  }
  return null
}
