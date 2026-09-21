/**
 * CompileArtifact + provenance contract.
 *
 * Compilation is a pure function: (document, schemaRegistry, scope, services)
 * -> CompileArtifact | diagnostics. The artifact owns everything an Execution
 * needs to stay truthful forever: the exact snapshot, the semantic hash, the
 * lowered prompt, and provenance maps back to qualified occurrences.
 */

import type { Diagnostic } from '../diagnostics.js'
import type { Json, WorkflowDocument } from '../format/document.js'
import type { ConnectionId, GraphDefId, NodeId, Occurrence, PortRef } from '../ids.js'
import type { WidgetSpec } from '../schema/model.js'
import type { DinksterGraphWire } from './dinkster-graph.js'

/**
 * Execution scope: which output nodes were requested. 'full' = all output
 * nodes; 'partial' lists explicit targets (occurrence-qualified). New partial
 * execution modes are new scope *providers*; the artifact shape is fixed.
 */
export type ExecutionScope =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly targets: readonly Occurrence[] }

/** The flat V1 prompt shape the current server accepts (compiler OUTPUT only). */
export interface PromptNode {
  readonly class_type: string
  readonly inputs: Readonly<Record<string, Json | readonly [string, number]>>
  /** Compiler-owned native IDs in wireable output-index order; absent in legacy prompts. */
  readonly outputIds?: readonly string[]
  /** Canonical suffixes of materialized dynamic output families. */
  readonly outputMembers?: Readonly<Record<string, readonly string[]>>
  /**
   * Stored DynamicCombo and DynamicSlot choices, keyed by materialized
   * construct path in the native graph wire's per-node 'slotVariants' object.
   * Omitted when empty. Part of a node's recipe identity: the backend folds
   * each choice into schema_signature, so two byte-identical interfaces under
   * different choices are different computations.
   */
  readonly slotVariants?: Readonly<Record<string, string>>
}
export type Prompt = Readonly<Record<string, PromptNode>>

/**
 * Provenance: bidirectional mapping between runtime (flattened prompt) node
 * ids and qualified occurrences in the source document.
 */
export interface Provenance {
  /** runtime node id -> occurrence key (see occurrenceKey()). */
  readonly toSource: Readonly<Record<string, string>>
  /** occurrence key -> runtime node id(s) (a source node may lower to several). */
  readonly fromSource: Readonly<Record<string, readonly string[]>>
  /** runtime node id -> backend input apiName -> exact source port identity. */
  readonly inputSources?: Readonly<Record<string, Readonly<Record<string, PortRef>>>>
  /** Runtime region id -> visible output id -> backend state-port output id. */
  readonly outputAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Runtime input names whose exact compiled widget representation enables dynamic prompts. */
  readonly dynamicPromptInputs?: Readonly<Record<string, readonly string[]>>
  /** Runtime nodes with an input routed through a random graph selector. */
  readonly randomSelectorInputs?: Readonly<Record<string, readonly string[]>>
  /** Included after-generate controls, resolved from the compiled occurrence view. */
  readonly controllerInputs?: readonly ControllerInputProvenance[]
}

/**
 * A selector choice resolved at compile time, recorded for reproducibility:
 * a frozen view must show exactly what executed, and re-running the artifact
 * must not re-roll random policies. One entry per (graph definition,
 * selector) - all occurrences of a definition share one resolution, exactly
 * like they share values and dynamic state.
 */
export interface SelectorChoice {
  /** Graph definition id the selector lives in. */
  readonly graph: string
  readonly selector: string
  /** The policy that produced this choice. */
  readonly policy: 'fixed' | 'random'
  /** The chosen candidate id. */
  readonly candidate: string
}

/** One document location that can provide an occurrence input's value and controller mode. */
export interface ControllerInputSource {
  readonly graph: GraphDefId
  readonly occurrence: Occurrence
  readonly valueKey: string
}

/**
 * The compiled occurrence view of one after-generate input. Sources are in
 * effective-value order; the first source owns advancement and later sources
 * provide inherited values and modes. `driven` reflects successful compiled
 * delivery through every boundary, not graph-local link presence.
 */
export interface ControllerInputProvenance {
  readonly runtimeId: string
  /** Terminal elaborated input identity for live schema retirement checks. */
  readonly terminal: ControllerInputSource
  readonly sources: readonly ControllerInputSource[]
  /** Primary binding first, then alsoBinds, independent of node storage order. */
  readonly ownerPriority: number
  readonly widget: WidgetSpec
  readonly optional: boolean
  readonly driven: boolean
}

export interface CompileArtifact {
  /** Deep-frozen snapshot of the document exactly as compiled. */
  readonly snapshot: WorkflowDocument
  /** Document revision the snapshot was taken at. */
  readonly revision: number
  /**
   * Execution-semantic hash: covers graphs/nodes/values/modes/nets - NOT view
   * state or control-surface chrome. Equal hash <=> same execution semantics.
   */
  readonly semanticHash: string
  readonly scope: ExecutionScope
  /** Target backend; prompts are only valid against the registry they compiled with. */
  readonly connection: ConnectionId
  /** Schema registry content hash the compile validated against. */
  readonly schemaHash: string
  readonly prompt: Prompt
  /** Compiler-owned native graph, present only when first-class regions require it. */
  readonly dinksterGraph?: DinksterGraphWire
  /** Native graph execution targets, paired with dinksterGraph. */
  readonly dinksterTargets?: readonly string[]
  /** partial_execution_targets sent to the server (runtime ids), if partial. */
  readonly partialTargets?: readonly string[]
  readonly provenance: Provenance
  /** Selector/random choices resolved during compile. */
  readonly choices?: readonly SelectorChoice[]
  /** Warnings produced during a successful compile. */
  readonly diagnostics: readonly Diagnostic[]
}

export interface WorkspaceProvenance {
  readonly toSource: Readonly<Record<string, string>>
  readonly fromSource: Readonly<Record<string, readonly string[]>>
  readonly inputSources?: Readonly<Record<string, Readonly<Record<string, PortRef>>>>
  readonly outputAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly dynamicPromptInputs?: Readonly<Record<string, readonly string[]>>
  readonly randomSelectorInputs?: Readonly<Record<string, readonly string[]>>
}

/** Compile output retained by other windows for execution projection. */
export interface WorkspaceCompileArtifact {
  readonly snapshot: WorkflowDocument
  readonly revision: number
  readonly semanticHash: string
  readonly scope: ExecutionScope
  readonly connection: ConnectionId
  readonly schemaHash: string
  readonly prompt: Prompt
  readonly dinksterGraph?: DinksterGraphWire
  readonly dinksterTargets?: readonly string[]
  readonly partialTargets?: readonly string[]
  readonly provenance: WorkspaceProvenance
  readonly choices?: readonly SelectorChoice[]
  readonly diagnostics: readonly Diagnostic[]
}

export function projectWorkspaceCompileArtifact(artifact: CompileArtifact): WorkspaceCompileArtifact {
  const provenance: WorkspaceCompileArtifact['provenance'] = {
    toSource: artifact.provenance.toSource,
    fromSource: artifact.provenance.fromSource,
    ...(artifact.provenance.inputSources === undefined ? {} : { inputSources: artifact.provenance.inputSources }),
    ...(artifact.provenance.outputAliases === undefined ? {} : { outputAliases: artifact.provenance.outputAliases }),
    ...(artifact.provenance.dynamicPromptInputs === undefined ? {} : { dynamicPromptInputs: artifact.provenance.dynamicPromptInputs }),
    ...(artifact.provenance.randomSelectorInputs === undefined ? {} : { randomSelectorInputs: artifact.provenance.randomSelectorInputs }),
  }
  const scope: ExecutionScope = artifact.scope.kind === 'full'
    ? { kind: 'full' }
    : {
        kind: 'partial',
        targets: artifact.scope.targets.map((target) => ({
          instancePath: [...target.instancePath],
          node: target.node,
        })),
      }
  return {
    snapshot: artifact.snapshot,
    revision: artifact.revision,
    semanticHash: artifact.semanticHash,
    scope,
    connection: artifact.connection,
    schemaHash: artifact.schemaHash,
    prompt: artifact.prompt,
    ...(artifact.dinksterGraph === undefined ? {} : { dinksterGraph: artifact.dinksterGraph }),
    ...(artifact.dinksterTargets === undefined ? {} : { dinksterTargets: artifact.dinksterTargets }),
    ...(artifact.partialTargets === undefined ? {} : { partialTargets: artifact.partialTargets }),
    provenance,
    ...(artifact.choices === undefined ? {} : {
      choices: artifact.choices.map((choice) => ({
        graph: choice.graph,
        selector: choice.selector,
        policy: choice.policy,
        candidate: choice.candidate,
      })),
    }),
    diagnostics: artifact.diagnostics,
  }
}

/** Result of a compile attempt. */
export type CompileResult =
  | { readonly ok: true; readonly artifact: CompileArtifact }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/**
 * Structural elements sitting on one graph definition's in-closure wires:
 * what a scope preview must light up beyond the nodes themselves.
 */
export interface ScopeStructuralGraph {
  readonly reroutes: ReadonlySet<string>
  /**
   * selector id -> candidate ids on possibly-run branches. A fixed selector
   * contributes exactly its chosen candidate; a random one contributes EVERY
   * candidate (its branch is rolled at queue time - would-run superset).
   */
  readonly selectors: ReadonlyMap<string, ReadonlySet<string>>
  readonly valueSources: ReadonlySet<string>
}

/**
 * The upstream closure of a scope (nodes that would run), for would-run
 * highlighting. Derived from the same object the compiler consumes so the
 * preview and the submission cannot disagree on anything decided at edit
 * time; random selectors widen the closure to every candidate ("may run").
 */
export interface ScopeClosure {
  readonly scope: ExecutionScope
  readonly revision: number
  /** Occurrence keys of all nodes inside the closure. */
  readonly included: ReadonlySet<string>
  /** Lazy-selector occurrence -> inactive branch's exclusive upstream cone. */
  readonly inactiveExclusive: ReadonlyMap<string, ReadonlySet<string>>
  /** Structural traversal on in-closure wires, keyed by graph definition id. */
  readonly structural: ReadonlyMap<string, ScopeStructuralGraph>
}

export type { NodeId }
