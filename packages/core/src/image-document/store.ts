import { createSignal, type ReadonlySignal } from '../reactive/signal.js'
import type { Json } from '../format/document.js'
import { applyOwnedOps, type PatchOp } from '../commands/patch.js'
import type { Diagnostic } from '../diagnostics.js'
import { planImageDocumentCommand, type ImageDocumentCommandInvocation, type ImageDocumentCommandPlan } from './commands.js'
import { loadImageDocument } from './migrate.js'
import type { ImageDocument } from './model.js'

export interface ImageDocumentTransaction {
  readonly revision: number
  readonly invocation: ImageDocumentCommandInvocation | { readonly command: 'image.undo' | 'image.redo' }
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly timestamp: number
}

export type ImageDocumentDispatchOutcome =
  | {
      readonly ok: true
      readonly document: ImageDocument
      readonly revision: number
      readonly transaction: ImageDocumentTransaction
      readonly created?: ImageDocumentCommandPlan['created']
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

interface HistoryRecord {
  readonly invocation: ImageDocumentCommandInvocation
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly resources: ReadonlySet<string>
}

const resourceDigests = (document: ImageDocument): Set<string> =>
  new Set(Object.values(document.resources).map((resource) => resource.digest))

function changedResources(before: ImageDocument, after: ImageDocument): ReadonlySet<string> {
  const left = resourceDigests(before)
  const right = resourceDigests(after)
  return new Set([...left].filter((digest) => !right.has(digest)).concat([...right].filter((digest) => !left.has(digest))))
}

export class ImageDocumentStore {
  private current: ImageDocument
  private currentRevision = 0
  private readonly undoStack: HistoryRecord[] = []
  private readonly redoStack: HistoryRecord[] = []
  private readonly listeners = new Set<(transaction: ImageDocumentTransaction) => void>()
  private readonly signal

  constructor(
    initial: ImageDocument,
    private readonly maxUndo = 200,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxUndo) || maxUndo < 0) throw new Error('maxUndo must be a non-negative safe integer')
    const loaded = loadImageDocument(initial)
    if (loaded.document === undefined) throw new Error('initial ImageDocument is invalid')
    this.current = loaded.document
    this.signal = createSignal(this.current)
  }

  get doc(): ImageDocument {
    return this.current
  }

  get revision(): number {
    return this.currentRevision
  }

  get document(): ReadonlySignal<ImageDocument> {
    return this.signal
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  dispatch(invocation: unknown): ImageDocumentDispatchOutcome {
    const result = planImageDocumentCommand(this.current, invocation)
    if (!result.ok) return result
    const before = this.current
    const record: HistoryRecord = {
      invocation: result.plan.invocation,
      forward: result.plan.redo,
      inverse: result.plan.inverse,
      resources: changedResources(before, result.plan.document),
    }
    this.current = result.plan.document
    this.undoStack.push(record)
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
    this.redoStack.length = 0
    const transaction = this.commit(result.plan.invocation, result.plan.forward, result.plan.inverse)
    return {
      ok: true,
      document: result.plan.document,
      revision: transaction.revision,
      transaction,
      ...(result.plan.created !== undefined ? { created: result.plan.created } : {}),
    }
  }

  undo(): boolean {
    const record = this.undoStack.at(-1)
    if (record === undefined) return false
    const document = this.replay(record.inverse)
    this.undoStack.pop()
    this.current = document
    this.redoStack.push(record)
    this.commit({ command: 'image.undo' }, record.inverse, record.forward)
    return true
  }

  redo(): boolean {
    const record = this.redoStack.at(-1)
    if (record === undefined) return false
    const document = this.replay(record.forward)
    this.redoStack.pop()
    this.current = document
    this.undoStack.push(record)
    this.commit({ command: 'image.redo' }, record.forward, record.inverse)
    return true
  }

  clearHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  retainedResourceDigests(): ReadonlySet<string> {
    const retained = resourceDigests(this.current)
    for (const record of [...this.undoStack, ...this.redoStack]) {
      for (const digest of record.resources) retained.add(digest)
    }
    return retained
  }

  onTransaction(listener: (transaction: ImageDocumentTransaction) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private replay(operations: readonly PatchOp[]): ImageDocument {
    const candidate = applyOwnedOps(this.current as unknown as Json, operations)
    const loaded = loadImageDocument(candidate)
    if (loaded.document === undefined) throw new Error('ImageDocument history replay violated invariants')
    return loaded.document
  }

  private commit(
    invocation: ImageDocumentTransaction['invocation'],
    forward: readonly PatchOp[],
    inverse: readonly PatchOp[],
  ): ImageDocumentTransaction {
    this.currentRevision += 1
    this.signal.set(this.current)
    const transaction: ImageDocumentTransaction = Object.freeze({
      revision: this.currentRevision,
      invocation,
      forward,
      inverse,
      timestamp: this.clock(),
    })
    for (const listener of this.listeners) {
      try {
        listener(transaction)
      } catch (error) {
        console.error('[ImageDocumentStore] listener threw:', error)
      }
    }
    return transaction
  }
}
