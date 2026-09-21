import type { Json } from '../format/document.js'
import { isValidActorId } from '../ids.js'
import { createSignal, type ReadonlySignal, type Signal } from '../reactive/signal.js'
import {
  COLLAB_PROTOCOL_VERSION,
  isValidCollabRevision,
  validateCollabDescriptor,
  validateCollabServerOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
} from '../commands/collab-protocol.js'
import { applyOps, applyOwnedOps, getAtPath, type PatchOp } from '../commands/patch.js'
import { toWirePatch } from '../commands/session.js'
import { jsonSameValue } from '../commands/store.js'
import {
  planImageDocumentCommand,
  type ImageDocumentCommandInvocation,
  type ImageDocumentCommandPlan,
} from './commands.js'
import { loadImageDocument } from './migrate.js'
import type { ImageDocument } from './model.js'
import type {
  ImageDocumentSession,
  ImageDocumentSessionOp,
} from './session.js'
import type { ImageDocumentDispatchOutcome } from './store.js'

export type SharedImageDocumentStatus = 'live' | 'catching-up' | 'closed' | 'error'

export interface SharedImageDocumentConflict {
  readonly origin: string
  readonly message: string
}

export interface SharedImageDocumentSessionOptions {
  readonly actorId?: string
  readonly maxUndo?: number
  readonly clock?: () => number
  readonly retryDelay?: () => Promise<void>
  readonly onConflict?: (conflict: SharedImageDocumentConflict) => void
  readonly onError?: (message: string) => void
}

interface HistoryRecord {
  forward: readonly PatchOp[]
  inverse: readonly PatchOp[]
}

interface Attempt {
  readonly opId: string
  readonly baseRevision: number
  readonly patch: ReturnType<typeof toWirePatch>
}

type PendingIntention =
  | { readonly kind: 'command'; readonly invocation: ImageDocumentCommandInvocation }
  | { readonly kind: 'patch'; readonly operations: readonly PatchOp[] }

interface PendingEntry {
  opId: string
  readonly intention: PendingIntention
  readonly origin: string
  predicted: ReturnType<typeof toWirePatch>
  readonly attempts: Attempt[]
  record?: HistoryRecord
}

const defaultActorId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `a${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`

function loadedDocument(value: unknown, context: string): ImageDocument {
  const loaded = loadImageDocument(value)
  if (loaded.document !== undefined) return loaded.document
  const problem = loaded.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  throw new Error(`${context}: ${problem?.message ?? 'invalid ImageDocument'}`)
}

function applyWire(document: ImageDocument, patch: CollabServerOp['patch'], context: string): ImageDocument {
  return loadedDocument(applyOps(document as unknown as Json, patch), context)
}

function changedResourceDigests(before: ImageDocument, after: ImageDocument): Set<string> {
  const left = new Set(Object.values(before.resources).map((resource) => resource.digest))
  const right = new Set(Object.values(after.resources).map((resource) => resource.digest))
  return new Set([...left].filter((digest) => !right.has(digest)).concat(
    [...right].filter((digest) => !left.has(digest)),
  ))
}

function replayImageHistory(
  document: ImageDocument,
  operations: readonly PatchOp[],
): { readonly document: ImageDocument; readonly applied: readonly PatchOp[]; readonly stale?: PatchOp } {
  let current = document as unknown as Json
  const applied: PatchOp[] = []
  for (const operation of operations) {
    const value = getAtPath(current, operation.path)
    const matches = operation.op === 'add'
      ? value === undefined
      : value !== undefined && jsonSameValue(value, operation.oldValue)
    if (!matches) return { document: loadedDocument(current, 'image history'), applied, stale: operation }
    current = applyOwnedOps(current, [operation])
    applied.push(operation)
  }
  return { document: loadedDocument(current, 'image history'), applied }
}

export class SharedImageDocumentSession implements ImageDocumentSession {
  readonly actorId: string
  readonly status: ReadonlySignal<SharedImageDocumentStatus>

  private readonly connection: CollabConnection
  private readonly clock: () => number
  private readonly retryDelay: () => Promise<void>
  private readonly onConflict: ((conflict: SharedImageDocumentConflict) => void) | undefined
  private readonly onError: ((message: string) => void) | undefined
  private readonly maxUndo: number
  private readonly documentSignal: Signal<ImageDocument>
  private readonly statusSignal: Signal<SharedImageDocumentStatus>
  private readonly listeners = new Set<(operation: ImageDocumentSessionOp) => void>()
  private readonly presenceListeners = new Set<(actorId: string, payload?: Json) => void>()
  private unsubscribe: (() => void) | undefined

  private confirmed: ImageDocument
  private confirmedRevision: number
  private optimistic: ImageDocument
  private readonly pending: PendingEntry[] = []
  private readonly undoStack: HistoryRecord[] = []
  private readonly redoStack: HistoryRecord[] = []
  private readonly retained = new Set<string>()
  private opCounter = 0
  private readonly opNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`
  private pumpPromise: Promise<void> | undefined
  private syncPromise: Promise<void> | undefined
  private syncing = false
  private syncTarget = 0
  private resyncRequested = false
  private connected = false
  private lastSnapshotRevision: number

  constructor(
    connection: CollabConnection,
    snapshot: ImageDocument,
    snapshotRevision: number,
    options?: SharedImageDocumentSessionOptions,
  ) {
    this.connection = connection
    this.actorId = options?.actorId ?? defaultActorId()
    if (!isValidActorId(this.actorId)) throw new Error('invalid ImageDocument collaboration actor id')
    if (!isValidCollabRevision(snapshotRevision)) throw new Error('invalid ImageDocument snapshot revision')
    this.clock = options?.clock ?? Date.now
    this.retryDelay = options?.retryDelay ?? (() => new Promise((resolve) => setTimeout(resolve, 1000)))
    this.onConflict = options?.onConflict
    this.onError = options?.onError
    this.maxUndo = options?.maxUndo ?? 200
    if (!Number.isSafeInteger(this.maxUndo) || this.maxUndo < 0) throw new Error('maxUndo must be a non-negative safe integer')
    this.confirmed = loadedDocument(snapshot, 'collab snapshot')
    this.confirmedRevision = snapshotRevision
    this.optimistic = this.confirmed
    this.lastSnapshotRevision = snapshotRevision
    this.documentSignal = createSignal(this.optimistic)
    this.statusSignal = createSignal<SharedImageDocumentStatus>('live')
    this.status = this.statusSignal
    this.unsubscribe = connection.onEvent((event) => this.handleEvent(event))
    if (this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') {
      const unsubscribe = this.unsubscribe
      this.unsubscribe = undefined
      unsubscribe()
    }
  }

  get doc(): ImageDocument { return this.optimistic }
  get document(): ReadonlySignal<ImageDocument> { return this.documentSignal }
  get revision(): number { return this.confirmedRevision + this.pending.length }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  dispatch(invocation: ImageDocumentCommandInvocation): ImageDocumentDispatchOutcome {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          origin: 'command',
          code: 'image.session.unavailable',
          message: `ImageDocument session is ${status}`,
        }],
      }
    }
    const stamped = { ...invocation, actor: this.actorId } as ImageDocumentCommandInvocation
    const result = planImageDocumentCommand(this.optimistic, stamped)
    if (!result.ok) return result
    const record: HistoryRecord = { forward: result.plan.redo, inverse: result.plan.inverse }
    this.retainedAdd(changedResourceDigests(this.optimistic, result.plan.document))
    this.optimistic = result.plan.document
    this.undoStack.push(record)
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
    this.redoStack.length = 0
    this.enqueue(
      { kind: 'command', invocation: result.plan.invocation },
      result.plan,
      result.plan.invocation.command,
      record,
    )
    const transaction = {
      revision: this.revision,
      invocation: result.plan.invocation,
      forward: result.plan.forward,
      inverse: result.plan.inverse,
      timestamp: this.clock(),
    } as const
    return {
      ok: true,
      document: this.optimistic,
      revision: this.revision,
      transaction,
      ...(result.plan.created !== undefined ? { created: result.plan.created } : {}),
    }
  }

  undo(): boolean { return this.replayHistory(this.undoStack, this.redoStack, 'undo') }
  redo(): boolean { return this.replayHistory(this.redoStack, this.undoStack, 'redo') }

  clearHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.retained.clear()
  }

  retainedResourceDigests(): ReadonlySet<string> {
    return new Set([
      ...Object.values(this.optimistic.resources).map((resource) => resource.digest),
      ...this.retained,
    ])
  }

  onOp(listener: (operation: ImageDocumentSessionOp) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onPresence(listener: (actorId: string, payload?: Json) => void): () => void {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }

  sendPresence(payload: Json): void { this.connection.sendPresence(payload) }

  async settle(): Promise<void> {
    while (this.pumpPromise !== undefined || this.syncPromise !== undefined) {
      await (this.pumpPromise ?? this.syncPromise)
    }
  }

  close(): void {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
    if (this.connected && this.pending.length === 0 && this.confirmedRevision > this.lastSnapshotRevision) {
      void this.connection.putSnapshot(this.confirmedRevision, this.confirmed).catch(() => undefined)
    }
    this.connection.close()
    this.connected = false
    this.statusSignal.set('closed')
  }

  private replayHistory(
    from: HistoryRecord[],
    to: HistoryRecord[],
    direction: 'undo' | 'redo',
  ): boolean {
    const record = from.pop()
    if (record === undefined) return false
    const operations = direction === 'undo' ? record.inverse : record.forward
    try {
      const replay = replayImageHistory(this.optimistic, operations)
      if (replay.stale !== undefined) throw new Error(`conflict at ${replay.stale.path.join('/')}`)
      const next = replay.document
      this.optimistic = next
      const entry: PendingEntry = {
        opId: this.mintOpId(),
        intention: { kind: 'patch', operations },
        origin: `image.${direction}`,
        predicted: toWirePatch(replay.applied),
        attempts: [],
        record,
      }
      this.pending.push(entry)
      to.push(record)
      this.documentSignal.set(this.optimistic)
      this.pump()
      return true
    } catch (error) {
      this.notifyConflict(`image.${direction}`, error)
      return false
    }
  }

  private enqueue(
    intention: PendingIntention,
    plan: ImageDocumentCommandPlan,
    origin: string,
    record?: HistoryRecord,
  ): void {
    this.pending.push({
      opId: this.mintOpId(),
      intention,
      origin,
      predicted: toWirePatch(plan.forward),
      attempts: [],
      ...(record !== undefined ? { record } : {}),
    })
    this.documentSignal.set(this.optimistic)
    this.pump()
  }

  private mintOpId(): string {
    this.opCounter += 1
    return `${this.actorId}#${this.opNonce}#${this.opCounter}`
  }

  private pump(): void {
    if (this.pumpPromise !== undefined || this.syncing || this.statusSignal.get() !== 'live') return
    this.pumpPromise = Promise.resolve()
      .then(() => this.pumpLoop())
      .finally(() => {
        this.pumpPromise = undefined
        if (this.pending.length > 0 && !this.syncing && this.statusSignal.get() === 'live') this.pump()
      })
  }

  private async pumpLoop(): Promise<void> {
    while (this.pending.length > 0 && !this.syncing && this.statusSignal.get() === 'live') {
      const head = this.pending[0]!
      const attempt: Attempt = {
        opId: head.opId,
        baseRevision: this.confirmedRevision,
        patch: head.predicted,
      }
      if (!head.attempts.some((candidate) => candidate.opId === attempt.opId)) head.attempts.push(attempt)
      const outcome = await this.connection.postOp({
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        opId: attempt.opId,
        actorId: this.actorId,
        baseRevision: attempt.baseRevision,
        patch: attempt.patch,
      }).catch((error: unknown) => ({
        kind: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
      if (this.statusSignal.get() !== 'live') return
      if (outcome.kind === 'accepted') {
        const invalid = validateCollabServerOp(outcome.op)
        if (invalid !== null) {
          this.requestResync(`accepted op is invalid: ${invalid}`)
          return
        }
        if (
          outcome.op.actorId !== this.actorId ||
          outcome.op.opId !== attempt.opId ||
          outcome.op.baseRevision !== attempt.baseRevision ||
          !jsonSameValue(outcome.op.patch as unknown as Json, attempt.patch as unknown as Json)
        ) {
          this.requestResync('accepted op differs from the submitted operation')
          return
        }
        this.handleServerOp(outcome.op)
        continue
      }
      if (outcome.kind === 'stale-base') {
        const attemptIndex = head.attempts.indexOf(attempt)
        if (attemptIndex !== -1) head.attempts.splice(attemptIndex, 1)
        this.requestCatchUp(outcome.revision)
        return
      }
      if (outcome.kind === 'snapshot-required') {
        const result = await this.connection.putSnapshot(this.confirmedRevision, this.confirmed)
          .catch(() => undefined)
        if (result === undefined) {
          await this.retryDelay()
          continue
        }
        if (result.kind === 'ok') this.lastSnapshotRevision = this.confirmedRevision
        else {
          const snapshot = await this.connection.fetchSnapshot().catch(() => undefined)
          if (snapshot !== undefined && isValidCollabRevision(snapshot.revision)) {
            this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, snapshot.revision)
          }
          await this.retryDelay()
        }
        continue
      }
      if (outcome.kind === 'protocol-unsupported') {
        this.fail(`protocol version ${COLLAB_PROTOCOL_VERSION} unsupported`)
        return
      }
      await this.retryDelay()
    }
  }

  private handleEvent(event: CollabConnectionEvent): void {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') return
    switch (event.kind) {
      case 'connected': {
        const invalid = validateCollabDescriptor(event.descriptor, this.connection.sessionId, 'image')
        if (invalid !== null) this.fail(invalid)
        else {
          this.connected = true
          this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, event.descriptor.snapshotRevision)
          if (event.descriptor.revision > this.confirmedRevision) {
            this.requestCatchUp(event.descriptor.revision)
          }
        }
        return
      }
      case 'disconnected':
        this.connected = false
        return
      case 'session-closed':
        this.connected = false
        this.close()
        return
      case 'presence':
        if (!isValidActorId(event.actorId)) return
        for (const listener of [...this.presenceListeners]) {
          try { listener(event.actorId, event.payload) } catch { /* observers do not own session state */ }
        }
        return
      case 'op': {
        const invalid = validateCollabServerOp(event.op)
        if (invalid !== null) this.requestResync(invalid)
        else this.handleServerOp(event.op)
      }
    }
  }

  private handleServerOp(operation: CollabServerOp): void {
    if (operation.revision <= this.confirmedRevision) return
    if (operation.revision > this.confirmedRevision + 1) {
      this.requestCatchUp(operation.revision)
      return
    }
    try {
      this.ingestOrdered(operation)
    } catch (error) {
      this.requestResync(error instanceof Error ? error.message : String(error))
      return
    }
    this.pump()
    if (this.confirmedRevision - this.lastSnapshotRevision >= 128 && this.pending.length === 0) {
      const revision = this.confirmedRevision
      void this.connection.putSnapshot(revision, this.confirmed).then((result) => {
        if (result.kind === 'ok') this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, revision)
        else void this.connection.fetchSnapshot().then((snapshot) => {
          if (isValidCollabRevision(snapshot.revision)) {
            this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, snapshot.revision)
          }
        }).catch(() => undefined)
      }).catch(() => undefined)
    }
  }

  private ingestOrdered(operation: CollabServerOp): void {
    if (operation.revision !== this.confirmedRevision + 1) throw new Error('collab operation is not contiguous')
    const oldGround = this.confirmed
    this.confirmed = applyWire(this.confirmed, operation.patch, 'collab operation')
    this.confirmedRevision = operation.revision
    let origin = 'remote'
    const pendingIndex = this.pending.findIndex((entry) =>
      entry.attempts.some((attempt) => attempt.opId === operation.opId &&
        attempt.baseRevision === operation.baseRevision &&
        jsonSameValue(attempt.patch as unknown as Json, operation.patch as unknown as Json)),
    )
    if (pendingIndex !== -1) {
      const [confirmed] = this.pending.splice(pendingIndex, 1)
      origin = confirmed!.origin
      if (pendingIndex !== 0 && confirmed!.record !== undefined) this.removeHistory(confirmed!.record)
    } else if (operation.actorId === this.actorId &&
      this.pending.some((entry) => entry.attempts.some((attempt) => attempt.opId === operation.opId))) {
      throw new Error('own collab operation payload changed')
    }
    this.rebase(oldGround)
    this.emitOperation(operation, origin)
  }

  private rebase(_oldGround: ImageDocument): void {
    const entries = this.pending.splice(0)
    const survivors: PendingEntry[] = []
    let cursor = this.confirmed
    for (const entry of entries) {
      try {
        let patch: readonly PatchOp[]
        let next: ImageDocument
        if (entry.intention.kind === 'command') {
          const result = planImageDocumentCommand(cursor, entry.intention.invocation)
          if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? 'command no longer applies')
          patch = result.plan.forward
          next = result.plan.document
          if (entry.record !== undefined) {
            entry.record.forward = result.plan.redo
            entry.record.inverse = result.plan.inverse
          }
        } else {
          const replay = replayImageHistory(cursor, entry.intention.operations)
          if (replay.stale !== undefined) throw new Error(`conflict at ${replay.stale.path.join('/')}`)
          patch = replay.applied
          next = replay.document
        }
        entry.opId = this.mintOpId()
        entry.predicted = toWirePatch(patch)
        entry.attempts.splice(0, entry.attempts.length,
          ...entry.attempts.filter((attempt) => attempt.baseRevision >= this.confirmedRevision))
        cursor = next
        survivors.push(entry)
      } catch (error) {
        if (entry.record !== undefined) this.removeHistory(entry.record)
        this.notifyConflict(entry.origin, error)
      }
    }
    this.pending.push(...survivors)
    this.optimistic = cursor
    this.documentSignal.set(cursor)
  }

  private requestCatchUp(target: number): void {
    if (target > this.syncTarget) this.syncTarget = target
    this.startSync()
  }

  private requestResync(reason: string): void {
    this.notifyConflict('resync', new Error(reason))
    this.resyncRequested = true
    this.startSync()
  }

  private startSync(): void {
    if (this.syncing || this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
    this.syncing = true
    this.statusSignal.set('catching-up')
    this.syncPromise = this.syncLoop().catch((error: unknown) => this.fail(
      error instanceof Error ? error.message : String(error),
    )).finally(() => {
      this.syncing = false
      this.syncPromise = undefined
      if (this.statusSignal.get() === 'catching-up') this.statusSignal.set('live')
      if (this.statusSignal.get() === 'live' &&
        (this.resyncRequested || this.confirmedRevision < this.syncTarget)) this.startSync()
      else this.pump()
    })
  }

  private async syncLoop(): Promise<void> {
    while (this.statusSignal.get() === 'catching-up') {
      if (this.resyncRequested) {
        this.resyncRequested = false
        const snapshot = await this.connection.fetchSnapshot()
        if (!isValidCollabRevision(snapshot.revision)) throw new Error('invalid ImageDocument snapshot revision')
        const document = loadedDocument(snapshot.document, 'ImageDocument resync')
        this.syncTarget = Math.max(this.syncTarget, this.confirmedRevision, snapshot.revision)
        const ambiguous = new Set(this.pending.filter((entry) =>
          entry.attempts.some((attempt) => attempt.baseRevision < snapshot.revision),
        ))
        for (const entry of ambiguous) {
          if (entry.record !== undefined) this.removeHistory(entry.record)
          this.notifyConflict(entry.origin, new Error('a checkpoint may already contain this submitted edit'))
        }
        const oldGround = this.confirmed
        this.confirmed = document
        this.confirmedRevision = snapshot.revision
        this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, snapshot.revision)
        this.pending.splice(0, this.pending.length, ...this.pending.filter((entry) => !ambiguous.has(entry)))
        this.undoStack.length = 0
        this.redoStack.length = 0
        this.rebase(oldGround)
        continue
      }
      if (this.confirmedRevision >= this.syncTarget) return
      const page = await this.connection.fetchOps(this.confirmedRevision)
      if (page.kind === 'resync-required') {
        this.resyncRequested = true
        continue
      }
      let progressed = false
      for (const operation of page.ops) {
        const invalid = validateCollabServerOp(operation)
        if (invalid !== null) throw new Error(invalid)
        if (operation.revision <= this.confirmedRevision) continue
        if (operation.revision !== this.confirmedRevision + 1) {
          this.resyncRequested = true
          break
        }
        this.ingestOrdered(operation)
        progressed = true
      }
      if (!progressed && !this.resyncRequested && this.confirmedRevision < this.syncTarget) {
        await this.retryDelay()
      }
    }
  }

  private emitOperation(operation: CollabServerOp, origin: string): void {
    const item: ImageDocumentSessionOp = Object.freeze({ ...operation, origin })
    for (const listener of [...this.listeners]) {
      try { listener(item) } catch { /* observers do not own session state */ }
    }
  }

  private retainedAdd(digests: ReadonlySet<string>): void {
    for (const digest of digests) this.retained.add(digest)
  }

  private removeHistory(record: HistoryRecord): void {
    const undo = this.undoStack.indexOf(record)
    if (undo !== -1) this.undoStack.splice(undo, 1)
    const redo = this.redoStack.indexOf(record)
    if (redo !== -1) this.redoStack.splice(redo, 1)
  }

  private notifyConflict(origin: string, error: unknown): void {
    try {
      this.onConflict?.({ origin, message: error instanceof Error ? error.message : String(error) })
    } catch { /* observers do not own session state */ }
  }

  private fail(message: string): void {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') return
    this.statusSignal.set('error')
    this.connected = false
    try { this.onError?.(message) } catch { /* observers do not own session state */ }
  }
}

export async function connectSharedImageDocumentSession(
  connection: CollabConnection,
  descriptor: { readonly documentKind?: string },
  options?: SharedImageDocumentSessionOptions,
): Promise<SharedImageDocumentSession> {
  if ((descriptor.documentKind ?? 'workflow') !== 'image') {
    throw new Error('collaboration session is not an ImageDocument')
  }
  const snapshot = await connection.fetchSnapshot()
  if (!isValidCollabRevision(snapshot.revision)) throw new Error('invalid ImageDocument snapshot revision')
  return new SharedImageDocumentSession(
    connection,
    loadedDocument(snapshot.document, 'collab snapshot'),
    snapshot.revision,
    options,
  )
}
