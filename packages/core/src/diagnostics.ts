/**
 * Unified Diagnostic model.
 *
 * One shape for every error/warning surface in the app:
 * - structural invariant violations (document is malformed)
 * - compile diagnostics (e.g. "muted node starves required input")
 * - server validation rejects (per-input node_errors)
 * - runtime execution errors (exception + traceback + inputs at failure)
 * - import/migration diagnostics (legacy workflow translation)
 *
 * Diagnostics are anchored: compile/validation diagnostics anchor to a document
 * revision; runtime diagnostics anchor to an execution (connection + prompt)
 * and resolve through provenance to a qualified occurrence.
 */

import type { ExecutionRef, LinkId, NetId, Occurrence, PortRef } from './ids.js'

export type Severity = 'error' | 'warning' | 'info'

export type DiagnosticOrigin =
  | 'invariant' // structural invariant checker
  | 'compile' // frontend compiler
  | 'validation' // server-side prompt validation reject
  | 'runtime' // execution_error during a run
  | 'import' // legacy format translation / migration
  | 'schema' // schema registry (unknown widget type, unparseable schema entry)
  | 'command' // command dispatch (unknown command, bad params, rejected transaction)
  | 'extension' // pack manifest/activation (invalid contribution, missing provider)
  | 'environment' // producing-environment stamp (malformed stamp, load-time drift)
  | 'collab' // shared-session transport/rebase (dropped intention, session error)

/** Where a diagnostic points. All fields optional; most anchors set a subset. */
export interface DiagnosticAnchor {
  /** Occurrence of the node the diagnostic is about (qualified through subgraphs). */
  readonly occurrence?: Occurrence
  /** Specific port on that node. */
  readonly port?: PortRef
  readonly link?: LinkId
  readonly net?: NetId
  /** Document revision the diagnostic was computed against. */
  readonly revision?: number
  /** Execution the diagnostic belongs to (runtime/validation). */
  readonly execution?: ExecutionRef
}

/** Processed diagnosis supplied alongside a raw runtime error. */
export interface RuntimeErrorHint {
  readonly code: string
  readonly message: string
  readonly suggestion?: string
}

/** Runtime error payload preserved verbatim from the server. */
export interface RuntimeErrorDetail {
  readonly exceptionType: string
  readonly exceptionMessage: string
  readonly traceback: readonly string[]
  /** Additive processed diagnoses; the raw message and traceback remain authoritative. */
  readonly hints?: readonly RuntimeErrorHint[]
  /** Node input values at time of failure, as reported by the server. */
  readonly currentInputs?: Readonly<Record<string, unknown>>
  readonly currentOutputs?: readonly unknown[]
}

/**
 * A presentation-only document identity mentioned by a diagnostic. The raw
 * ids remain in `message`; app surfaces may use these refs to add current
 * node/port display names without parsing or rewriting that stable text.
 */
export interface DiagnosticRef {
  readonly graphId?: string
  readonly nodeId?: string
  readonly portId?: string
  readonly valueKey?: string
  readonly direction?: 'input' | 'output'
}

export interface Diagnostic {
  readonly severity: Severity
  readonly origin: DiagnosticOrigin
  /** Stable machine-readable code, e.g. 'link.dangling', 'net.cross-boundary'. */
  readonly code: string
  /** Human-readable message. */
  readonly message: string
  /**
   * This condition prevents execution even when its severity is deliberately
   * non-error (for example, a required API input that the backend will
   * reject). Ephemeral like refs: presentation/control metadata only, never
   * persisted in workflow documents or sent on the graph wire.
   */
  readonly blocksExecution?: true
  /** Ephemeral presentation hints; never part of the workflow document. */
  readonly refs?: readonly DiagnosticRef[]
  readonly anchor?: DiagnosticAnchor
  readonly runtime?: RuntimeErrorDetail
  /** Extra structured data for tooling; must be JSON-serializable. */
  readonly data?: Readonly<Record<string, unknown>>
}

export const diag = (
  severity: Severity,
  origin: DiagnosticOrigin,
  code: string,
  message: string,
  rest?: Partial<Pick<Diagnostic, 'blocksExecution' | 'refs' | 'anchor' | 'runtime' | 'data'>>,
): Diagnostic => ({ severity, origin, code, message, ...rest })

/** Error severity always blocks; selected non-errors opt in explicitly. */
export const diagnosticBlocksExecution = (diagnostic: Diagnostic): boolean =>
  diagnostic.severity === 'error' || diagnostic.blocksExecution === true
