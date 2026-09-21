import type { ReadonlySignal } from '../reactive/signal.js'
import type { PatchOp } from '../commands/patch.js'
import { isValidActorId } from '../ids.js'
import type { ImageDocumentCommandInvocation } from './commands.js'
import {
  ImageDocumentStore,
  type ImageDocumentDispatchOutcome,
  type ImageDocumentTransaction,
} from './store.js'
import type { ImageDocument } from './model.js'

export type ImageDocumentWirePatch =
  | { readonly op: 'add' | 'replace'; readonly path: PatchOp['path']; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: PatchOp['path'] }

export interface ImageDocumentSessionOp {
  readonly opId: string
  readonly actorId: string
  readonly baseRevision: number
  readonly revision: number
  readonly patch: readonly ImageDocumentWirePatch[]
  readonly timestamp: number
  readonly origin: string
}

export interface ImageDocumentSession {
  readonly doc: ImageDocument
  readonly document: ReadonlySignal<ImageDocument>
  readonly revision: number
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly actorId: string
  dispatch(invocation: ImageDocumentCommandInvocation): ImageDocumentDispatchOutcome
  undo(): boolean
  redo(): boolean
  clearHistory(): void
  retainedResourceDigests(): ReadonlySet<string>
  onOp(listener: (operation: ImageDocumentSessionOp) => void): () => void
}

const wirePatch = (operations: readonly PatchOp[]): readonly ImageDocumentWirePatch[] =>
  Object.freeze(operations.map((operation) => Object.freeze(operation.op === 'remove'
    ? { op: operation.op, path: operation.path }
    : { op: operation.op, path: operation.path, value: operation.value })))

class LocalImageDocumentSession implements ImageDocumentSession {
  private readonly store: ImageDocumentStore
  private readonly listeners = new Set<(operation: ImageDocumentSessionOp) => void>()
  private opCounter = 0
  readonly actorId: string

  constructor(
    initial: ImageDocument,
    options?: { readonly actorId?: string; readonly maxUndo?: number; readonly clock?: () => number },
  ) {
    this.actorId = options?.actorId ?? 'local'
    if (!isValidActorId(this.actorId)) throw new Error('invalid ImageDocument session actor id')
    this.store = new ImageDocumentStore(initial, options?.maxUndo, options?.clock)
    this.store.onTransaction((transaction) => this.publish(transaction))
  }

  get doc(): ImageDocument { return this.store.doc }
  get document(): ReadonlySignal<ImageDocument> { return this.store.document }
  get revision(): number { return this.store.revision }
  get canUndo(): boolean { return this.store.canUndo }
  get canRedo(): boolean { return this.store.canRedo }

  dispatch(invocation: ImageDocumentCommandInvocation): ImageDocumentDispatchOutcome {
    return this.store.dispatch(invocation)
  }

  undo(): boolean { return this.store.undo() }
  redo(): boolean { return this.store.redo() }
  clearHistory(): void { this.store.clearHistory() }
  retainedResourceDigests(): ReadonlySet<string> { return this.store.retainedResourceDigests() }

  onOp(listener: (operation: ImageDocumentSessionOp) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(transaction: ImageDocumentTransaction): void {
    this.opCounter += 1
    const operation: ImageDocumentSessionOp = Object.freeze({
      opId: `${this.actorId}#${this.opCounter}`,
      actorId: this.actorId,
      baseRevision: transaction.revision - 1,
      revision: transaction.revision,
      patch: wirePatch(transaction.forward),
      timestamp: transaction.timestamp,
      origin: transaction.invocation.command,
    })
    for (const listener of this.listeners) {
      try {
        listener(operation)
      } catch (error) {
        console.error('[ImageDocumentSession] listener threw:', error)
      }
    }
  }
}

export function createLocalImageDocumentSession(
  initial: ImageDocument,
  options?: { readonly actorId?: string; readonly maxUndo?: number; readonly clock?: () => number },
): ImageDocumentSession {
  return new LocalImageDocumentSession(initial, options)
}
