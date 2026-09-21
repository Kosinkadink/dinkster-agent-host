/**
 * Command/transaction contract.
 *
 * Commands are the ONLY write path to the document (architecture section 4):
 * UI gestures, extension calls, deprecation rules, importers and controller
 * advances all dispatch commands. Contract-level guards:
 *
 * - Invocations are plain data (command id + Json params + optional actor):
 *   serializable across IPC (multi-window) and appendable to a sync log
 *   (multi-user).
 * - Execution is deterministic given the document: same doc + same
 *   invocation => same outcome. No hidden inputs; anything nondeterministic
 *   (new ids via the allocator cursor, timestamps) must come from document
 *   state or the invocation. The actor is explicit invocation data - NOT
 *   ambient session state - precisely so replaying a logged invocation
 *   allocates the same ids.
 * - Every committed transaction yields forward + inverse PatchOps. Undo/redo
 *   REPLAYS patches; it never re-runs commands.
 * - The structural invariant checker runs after every committed transaction;
 *   a command that would violate invariants fails atomically (no partial
 *   application).
 *
 * The transaction builder here is the recording mechanism command
 * implementations use.
 */

import type { Diagnostic } from '../diagnostics.js'
import type { Json, JsonObject, WorkflowDocument } from '../format/document.js'
import { ownJson } from '../format/json.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { applyOwnedOps, invertOps, type PatchOp } from './patch.js'

// ---------------------------------------------------------------------------
// Invocations and outcomes
// ---------------------------------------------------------------------------

/** A request to run a command. Plain data; no closures, no object references. */
export interface CommandInvocation {
  readonly command: string
  readonly params: Json
  /**
   * Allocation scope for shared sessions (must satisfy isValidActorId).
   * Absent = solo/local allocation from nextOrdinal, byte-for-byte the
   * pre-multiplayer behavior. Present = ids mint as `<prefix><ord>-<actor>`
   * from this actor's own cursor, so concurrent actors can never collide.
   * A shared DocumentSession stamps this on every invocation it dispatches
   * (verbatim the collab envelope's `actorId` - one value, two field names,
   * no translation); local sessions never set it.
   */
  readonly actor?: string
}

export type CommandOutcome =
  | {
      readonly ok: true
      readonly doc: WorkflowDocument
      readonly forward: readonly PatchOp[]
      readonly inverse: readonly PatchOp[]
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/** Trusted, process-local dispatch authority. Never part of an invocation. */
export type CommandExecutionContext =
  | { readonly kind: 'initial'; readonly schemaResolverFor?: (doc: WorkflowDocument) => SchemaResolver }
  | { readonly kind: 'shared-replay' }

export type SharedReplayPreparation =
  | { readonly ok: true; readonly params: Json }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/**
 * A command implementation. `run` must be pure: read `doc`, record mutations
 * through the builder, return diagnostics. Failures are returned (never
 * thrown) so dispatch stays total.
 */
export interface CommandDefinition {
  readonly id: string
  /**
   * Called once before a shared session accepts a new local intention. The
   * returned params are retained only in that session's pending intention so
   * later replay can avoid mutable process authority. Implementations must be
   * pure; undefined keeps the original params, while an explicit failure
   * rejects the intention. The actor is the allocation scope of the eventual
   * transaction, including sequential batch planning.
   */
  prepareForSharedReplay?(
    doc: WorkflowDocument,
    params: Json,
    context: Extract<CommandExecutionContext, { readonly kind: 'initial' }>,
    actor: string | undefined,
  ): SharedReplayPreparation | undefined
  /**
   * Called by a shared session when the document ground shifts under an
   * unacknowledged intention. oldDoc is the document the current params are
   * expressed against; newDoc is the ground they will re-execute on. Return
   * replacement params expressed against newDoc, or undefined to keep them.
   * Implementations must be pure.
   */
  transformForRebase?(params: Json, oldDoc: WorkflowDocument, newDoc: WorkflowDocument): Json | undefined
  validateDispatch?(
    doc: WorkflowDocument,
    params: Json,
    context: CommandExecutionContext,
  ): readonly Diagnostic[]
  run(
    doc: WorkflowDocument,
    params: Json,
    tx: TransactionBuilder,
    context: CommandExecutionContext,
  ): readonly Diagnostic[]
}

/** The single command execution gate used by direct and nested dispatch. */
export function executeCommand(
  definition: CommandDefinition,
  doc: WorkflowDocument,
  params: Json,
  tx: TransactionBuilder,
  context: CommandExecutionContext,
): readonly Diagnostic[] {
  const preflight = definition.validateDispatch?.(doc, params, context) ?? []
  if (preflight.some((diagnostic) => diagnostic.severity === 'error')) return preflight
  return [...preflight, ...definition.run(doc, params, tx, context)]
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A committed transaction stored in undo/redo history. */
export interface TransactionRecord {
  /** Document revision after this transaction (monotonic per document). */
  readonly revision: number
  readonly invocation: CommandInvocation
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly timestamp: number
}

/**
 * Records mutations against a working copy of the document. Ops apply
 * eagerly, so later reads within the same command see earlier writes.
 */
export interface TransactionBuilder {
  /** Current working state including all recorded ops. */
  readonly current: WorkflowDocument
  /**
   * Allocation scope from the invocation (CommandInvocation.actor), already
   * validated by dispatch. Commands never read it directly - the graph
   * allocator (alloc.ts) does - so every id-minting site scopes the same way.
   */
  readonly actor: string | undefined
  /** Add-or-replace at path (records the correct primitive op). */
  set(path: readonly (string | number)[], value: Json): void
  /** Insert into an array at path (last segment = index). */
  insert(path: readonly (string | number)[], value: Json): void
  /** Remove the value at path (object key or array index). */
  remove(path: readonly (string | number)[]): void
  /** Forward ops recorded so far. */
  readonly forward: readonly PatchOp[]
}

export function createTransactionBuilder(
  doc: WorkflowDocument,
  actor?: string,
): TransactionBuilder & {
  result(): { doc: WorkflowDocument; forward: readonly PatchOp[]; inverse: readonly PatchOp[] }
} {
  let working: Json = doc as unknown as JsonObject
  const ops: PatchOp[] = []

  const record = (op: PatchOp): void => {
    // Trusted fast path: own()/ownPath() below already detached+froze
    // everything this builder records.
    working = applyOwnedOps(working, [op])
    ops.push(Object.freeze(op))
  }

  /**
   * Ownership boundary (CO1/CO2): every value entering the document is
   * validated against JSON semantics and deep-copied+frozen here, so the
   * committed document never aliases caller-mutable data. oldValue is read
   * from the working document, which is frozen by construction, so it is
   * already owned. Throwing is deliberate: dispatch converts a command
   * throw into an atomic rejection.
   */
  const own = (value: Json, what: string): Json => {
    const owned = ownJson(value)
    if (!owned.ok) throw new Error(`${what}: ${owned.reason}`)
    return owned.value
  }

  const ownPath = (path: readonly (string | number)[]): readonly (string | number)[] => {
    // Path segments become object keys via applyOps. A '__proto__' key is
    // exactly what ownJson forbids in values - allowing it through a PATH
    // would let a command (node.setValue with inputId '__proto__', say)
    // commit a document the store's own ingress boundary rejects on reload,
    // and emit the dangerous segment on the session wire. Throwing here is
    // an atomic command rejection, consistent with own().
    for (const seg of path) {
      if (seg === '__proto__') throw new Error(`path segment '__proto__' is forbidden`)
    }
    return Object.freeze([...path])
  }

  const readAt = (path: readonly (string | number)[]): Json | undefined => {
    let cur: Json | undefined = working
    for (const seg of path) {
      if (typeof seg === 'number') {
        // Own elements + safe indices only, mirroring getAtPath: a hole or
        // exotic index must never read Array.prototype.
        cur =
          Array.isArray(cur) && Number.isSafeInteger(seg) && seg >= 0 && Object.hasOwn(cur, seg)
            ? cur[seg]
            : undefined
      } else {
        // Own properties only: a '__proto__'/'constructor' segment must never
        // read the prototype chain (it would record Object.prototype as an
        // oldValue and poison the inverse patch).
        cur =
          typeof cur === 'object' && cur !== null && !Array.isArray(cur) && Object.hasOwn(cur, seg)
            ? (cur as JsonObject)[seg]
            : undefined
      }
      if (cur === undefined) return undefined
    }
    return cur
  }

  return {
    get current() {
      return working as unknown as WorkflowDocument
    },
    actor,
    get forward() {
      return ops
    },
    set(path, value) {
      const existing = readAt(path)
      const owned = own(value, `set ${path.join('/')}`)
      if (existing === undefined) {
        record({ op: 'add', path: ownPath(path), value: owned })
      } else {
        record({ op: 'replace', path: ownPath(path), value: owned, oldValue: existing })
      }
    },
    insert(path, value) {
      record({ op: 'add', path: ownPath(path), value: own(value, `insert ${path.join('/')}`) })
    },
    remove(path) {
      const existing = readAt(path)
      if (existing === undefined) {
        throw new Error(`remove: nothing at path ${path.join('/')}`)
      }
      record({ op: 'remove', path: ownPath(path), oldValue: existing })
    },
    result() {
      return {
        doc: working as unknown as WorkflowDocument,
        forward: Object.freeze([...ops]),
        inverse: Object.freeze(invertOps(ops).map((op) => Object.freeze(op))),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * The document store: owns the authoritative document, the revision counter
 * and the undo/redo stacks. Dispatch is the single entry point; it runs the
 * command, invariant-checks the result, and either commits atomically or
 * rejects with diagnostics.
 */
export interface DocumentStoreContract {
  readonly doc: WorkflowDocument
  readonly revision: number
  dispatch(invocation: CommandInvocation): CommandOutcome
  /** Replay the inverse patches of the newest committed transaction. */
  undo(): boolean
  /** Replay the forward patches of the most recently undone transaction. */
  redo(): boolean
}
