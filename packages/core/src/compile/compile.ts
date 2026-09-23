/**
 * The compiler is a pure function from document, schemas, and scope to a CompileArtifact.
 *
 * Pinned by the golden pairs in fixtures/prompts (validated against a real
 * server; see the README there):
 * - Runtime node id = occurrenceKey(): source node id for root nodes ('n1'),
 *   instance-path-qualified inside subgraph instances ('n0.n0').
 * - The compiler reasons over elaborated interfaces: values and links
 *   resolve by document identity ({port, members} / elaborated key), the
 *   prompt is keyed by elaborated apiName (positional wire names for family
 *   members - compiler OUTPUT, never identity). Static nodes are unchanged:
 *   apiName = elaborated key = schema input id.
 * - Links lower to [producerRuntimeId, outputIndex] (index = producer's
 *   position among its non-ghost elaborated outputs; compiler OUTPUT only).
 * - Subgraph instances flatten away. Boundary ports resolve through to the
 *   bound inner port, recursively. A value stored on the instance for a
 *   boundary input overrides the inner node's stored value; an OUTER
 *   instance's override beats an inner instance's (first-write-wins while
 *   walking outside-in).
 * - Whole-family forwarding lowers per occurrence: compilation
 *   is phased - (1) discover every graph occurrence and its family crossings
 *   outside-in, deriving occurrence-local dynamic-state overlays and
 *   projected connectivity for forwarded targets; (2) resolve promoted
 *   values (including suffix-member values held by instances); (3) lower
 *   values/links/nets. All boundary address interpretation goes through the
 *   ONE crossing abstraction (crossing.ts); nothing re-parses paths.
 * - Named nets expand to direct links.
 * - Muted nodes and links touching them are omitted (warning when that leaves
 *   a required input dangling). Bypassed nodes lower to a type-matched
 *   passthrough: a consumer edge whose producer
 *   is bypassed traces through the bypassed node's matching DRIVEN input
 *   (bypass.ts owns the matching rule), through reroute chains and further
 *   bypassed nodes, to the real producer - or a value source, whose value
 *   bakes into the consumer input. Subgraph instances bypass at their
 *   boundary schema: the passthrough matches over the instance's ELABORATED
 *   boundary interface in the parent graph; the definition's contents never
 *   compile (no recursive descendant-poking).
 *
 * Stored controller values compile as-is; advancement happens elsewhere.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import {
  isForwardingBinding,
  suppressedDeliveryKey,
  type BoundaryItem,
  type BoundaryRouteLeg,
  type DynamicPortState,
  type GraphDef,
  type Json,
  type NodeData,
  type ParentDeliveryIdentity,
  type WorkflowDocument,
} from '../format/document.js'
import {
  asGraphDefId,
  isPortEndpoint,
  isRerouteRef,
  isSelectorRef,
  isValueSourceRef,
  isWidgetTapRef,
  occurrenceKey,
  portAddressKey,
  portRefKey,
  type ConnectionId,
  type GraphDefId,
  type LinkEndpoint,
  type LinkId,
  type NodeId,
  type Occurrence,
  type PortRef,
  type SelectorCandidateId,
} from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { buildRerouteIndex, rerouteDriverOf, selectorDriverOf, type RerouteIndex, type SelectorResolution, type TraceVia } from '../reroute.js'
import { matchBypassInput, type BypassCandidate } from './bypass.js'
import { deriveBoundarySchema, resolveBoundaryRoute, type SchemaResolver } from '../schema/derive-boundary.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elabOutputsOf,
  elaborateInterface,
  valueKeyOf,
  EMPTY_CONNECTIVITY,
  type Connectivity,
  type ElaboratedInput,
  type ElaboratedOutput,
  type PortAddress,
} from '../schema/elaborate.js'
import {
  buildBoundaryCrossings,
  crossingTargets,
  isSubtreeCrossing,
  projectCrossingValues,
  matchBoundaryItem,
  overlayNodeDynamic,
  overlaySelectorDynamic,
  projectCountBoundValues,
  translateThroughCrossing,
  type BoundaryCrossing,
} from './crossing.js'
import { boundaryStateResolver } from './boundary-state.js'
import { assetTypeId, canonicalTypeIdOf, isAssetRefDestinationTypeId, isAssetSourceTypeId, listTypeId, outputSchemaInputsOf, parseListTypeId, resolveWidgetRepresentation, type NodeSchema, type NodeSelectorSpec, type TypeExpr, type WidgetSpec } from '../schema/model.js'
import { effectiveWidgetDefault, isAssetRefValue } from '../schema/widget-defaults.js'
import { isCanonicalUnsafeInteger } from '../schema/numeric-step.js'
import {
  decimalIntegerWire,
  DINKSTER_GRAPH_FEATURE_DECIMAL_INT,
  DINKSTER_GRAPH_FEATURE_REGIONS,
  DINKSTER_GRAPH_FEATURE_TYPED_LITERAL,
  DINKSTER_REGION_PSEUDO_NODE,
  parseDecimalIntegerWire,
  parseTypedLiteralWire,
  typeExprToDinksterWire,
  typedLiteralWire,
  validateDinksterGraph,
  type DinksterGraphEntryWire,
  type DinksterGraphValidationNode,
  type DinksterGraphWire,
  type DinksterInputWire,
  type DinksterRegionOutputWire,
} from './dinkster-graph.js'
import { LivenessDerivation, traverseRoutedProjection, type RouteProjection, type RoutedStep } from './liveness.js'
import type {
  CompileArtifact,
  CompileResult,
  ControllerInputProvenance,
  ControllerInputSource,
  ExecutionScope,
  Prompt,
  PromptNode,
  Provenance,
  ScopeClosure,
  ScopeStructuralGraph,
  SelectorChoice,
} from './artifact.js'
import { semanticHashOf } from './hash.js'
import { effectiveOccurrenceTopology, type EffectiveLinkIdentity } from './effective-topology.js'

// ---------------------------------------------------------------------------
// Schema resolution over a document (backend types + '#<defId>' boundaries)
// ---------------------------------------------------------------------------

/**
 * Wrap a backend-schema resolver so subgraph-instance types ('#<defId>')
 * resolve to boundary-derived schemas of this document, recursively. Memoized
 * per document instance; create a fresh resolver when the document changes.
 */
export function documentResolver(doc: WorkflowDocument, base: SchemaResolver): SchemaResolver {
  const cache = new Map<string, NodeSchema | undefined>()
  const resolve: SchemaResolver = Object.assign(
    (nodeType: string) => {
      const defId = subgraphDefIdOf(nodeType)
      if (defId === undefined) return base(nodeType)
      if (cache.has(nodeType)) return cache.get(nodeType)
      const def = doc.graphs[defId]
      if (!def) {
        cache.set(nodeType, undefined)
        return undefined
      }
      const derived = deriveBoundarySchema(def, resolve)
      cache.set(nodeType, derived.schema)
      return derived.schema
    },
    {
      ...(base.forEditorRole === undefined ? {} : { forEditorRole: base.forEditorRole })
    }
  )
  return resolve
}

export type DocumentNodeResolver = (graphId: string, node: NodeData) => NodeSchema | undefined

/**
 * Resolve a concrete document node, including occurrence-local interface
 * contracts such as regions. Definition-only callers should use
 * {@link documentResolver}; concrete graph/node callers must use this form.
 */
export function documentNodeResolver(doc: WorkflowDocument, base: SchemaResolver): DocumentNodeResolver {
  const definitionResolve = documentResolver(doc, base)
  const cache = new Map<string, NodeSchema | undefined>()
  const resolveNode: DocumentNodeResolver = (graphId, node) => {
    const defId = subgraphDefIdOf(node.type)
    if (defId === undefined) return base(node.type)
    const key = JSON.stringify([graphId, node.id])
    if (cache.has(key)) return cache.get(key)
    const def = doc.graphs[defId]
    if (!def) {
      cache.set(key, undefined)
      return undefined
    }
    const derived = deriveBoundarySchema(
      def,
      definitionResolve,
      node.region,
      (inner) => resolveNode(def.id, inner),
    )
    cache.set(key, derived.schema)
    return derived.schema
  }
  return resolveNode
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompileInput {
  readonly document: WorkflowDocument
  readonly revision: number
  /** Backend node schemas; '#<defId>' resolution is handled internally. */
  readonly resolve: SchemaResolver
  readonly scope: ExecutionScope
  readonly connection: ConnectionId
  readonly schemaHash: string
  /**
   * Exact candidate replay for an existing artifact. The returned id wins
   * over both fixed and random live policies when it is still present.
   */
  readonly candidateOverride?: (ctx: {
    readonly graph: string
    readonly selector: string
    readonly candidates: readonly string[]
  }) => string | undefined
  /**
   * Chooser for 'random' selector policies: returns a candidate index in
   * [0, count). REQUIRED for compile() whenever the document contains a
   * random-policy selector - compile has no ambient randomness; the caller
   * injects the roll and the EXACT outcome is recorded in the artifact's
   * `choices`. scopeClosure() never needs one: its would-run closure covers
   * every candidate of a random selector (superset) instead of rolling.
   */
  readonly pickCandidate?: (ctx: {
    readonly graph: string
    readonly selector: string
    readonly count: number
  }) => number
  /**
   * Graph document wire feature flags of the TARGET backend (the /api/nodes
   * dinkster.graphFeatures field, SchemaRegistry.graphFeatures). Gates
   * capability-negotiated lowering forms: with 'typedLiteral' present, a
   * tap literal into a non-concrete-typed input lowers to a $typed marker
   * instead of refusing with compile.tap.nonConcreteTarget. Absent or empty
   * = oldest wire, emit no negotiated forms.
   */
  readonly graphFeatures?: readonly string[]
}

interface FlatNode {
  readonly runtimeId: string
  readonly occ: Occurrence
  readonly graphId: GraphDefId
  readonly node: NodeData
  readonly elab: NodeElab
  readonly selector?: NodeSelectorSpec
  /** Elaborated identity of selector.input, when this is a selector node. */
  readonly selectorInputKey?: string
  /** Elaborated identities of selector branch inputs. */
  readonly selectorBranchKeys?: { readonly false: string; readonly true: string }
  /** Stored, occurrence-effective boolean used only by would-run liveness. */
  selectorProjection?: {
    readonly choice: boolean
    readonly branches: { readonly false: string; readonly true: string }
  }
  /** Inputs whose final staged value came from a real graph link/net. */
  readonly linkedInputs: Set<string>
  /** Staging record, keyed by ELABORATED input id (remapped to apiName at assembly). */
  readonly inputs: Record<string, Json | readonly [string, number]>
}

/**
 * A node's elaborated interface, indexed for compilation. Computed once per
 * (definition, node) - every occurrence of a definition shares values,
 * dynamic state, and link connectivity, so the elaboration is identical.
 */
interface NodeElab {
  /** All elaborated inputs, in interface order (ghosts included). */
  readonly inputs: readonly ElaboratedInput[]
  /** All elaborated outputs, in interface order (ghosts included). */
  readonly outputs: readonly ElaboratedOutput[]
  /** Top-level inputs that determine output-family arity and cannot be linked. */
  readonly outputCountInputs: ReadonlySet<string>
  readonly outputMembers?: Readonly<Record<string, readonly string[]>>
  /** Explicit wire-15 selector state submitted at construct paths. */
  readonly submissionValues: readonly { readonly path: string; readonly apiPath: string; readonly value: Json }[]
  /**
   * PERSISTED value key -> input: the key under which a document stores this
   * input's value. For top-level static inputs that is the RAW schema id
   * (what migration and static commands write - it may contain '#'/'%' that
   * the elaborated spec.id escapes, 'x#y' -> 'x%23y'); for dynamic-derived
   * inputs (member/branch/selector/slot/dependent) it is the elaborated
   * spec.id. ONE map, so a raw static id colliding with another input's
   * elaborated id is a detectable duplicate, never a silent mis-route.
   */
  readonly inputsByValueKey: ReadonlyMap<string, ElaboratedInput>
  /** portAddressKey(port, members) -> input (for link/bind targets). */
  readonly inputsByAddr: ReadonlyMap<string, ElaboratedInput>
  /** portAddressKey(port, members) -> output, wireable or not. */
  readonly outputsByAddr: ReadonlyMap<string, ElaboratedOutput>
  /** portAddressKey(port, members) -> wire index (wireable outputs only). */
  readonly outputIndexByAddr: ReadonlyMap<string, number>
}

/** A synthesized, unpersisted member anywhere in the path. */
const hasSyntheticAncestor = (ancestry?: readonly { readonly synthetic?: boolean }[]): boolean =>
  ancestry?.some((a) => a.synthetic) ?? false

/**
 * Dynamic-scoped value keys (member `#`, branch `.[`, or any dotted path -
 * static input ids never contain '.') may be DORMANT by design: inactive
 * combo branches, hidden DynamicSlot dependents, and removed members keep
 * their values so switching back restores them. Never warn about those;
 * only a plain top-level key matching no input is junk worth flagging.
 */
const isDynamicScopedValueKey = (key: string): boolean =>
  key.includes('#') || key.includes('.')

interface ResolvedInput {
  readonly runtimeId: string
  /** Elaborated key (= spec.id): the FlatNode.inputs staging key. */
  readonly elabKey: string
  readonly input: ElaboratedInput
}
interface ResolvedOutput {
  readonly runtimeId: string
  readonly outputIndex: number
}
interface ResolvedWidgetTap {
  readonly widgetTap: {
    readonly path: readonly NodeId[]
    readonly defId: string
    readonly endpoint: LinkEndpoint
  }
}
/**
 * An output resolution that landed on a BYPASSED node: where it lives and
 * which of its outputs was asked for, so the passthrough trace can pick the
 * matching driven input and continue upstream from there.
 */
interface BypassAt {
  readonly path: readonly NodeId[]
  readonly defId: string
  readonly ref: PortRef
}

export function compile(input: CompileInput): CompileResult {
  return compileImpl(input, false).result
}

/**
 * Shared implementation behind {@link compile} (real submissions) and
 * {@link scopeClosure} (would-run previews). In would-run mode:
 *
 * - a random-policy selector without a chooser resolves to its FIRST
 *   candidate instead of erroring (the staged branch is arbitrary; the
 *   closure below covers every branch anyway),
 * - every random selector contributes extra closure edges for ALL its
 *   candidates (superset: "may run"), while fixed selectors stay exact,
 * - structural traversal (reroutes, selector branches, value sources) on
 *   in-closure wires is recorded per graph definition for highlighting.
 *
 * A would-run artifact must be DISCARDED - its prompt stages one arbitrary
 * branch per undecided selector and must never be submitted.
 */
function compileImpl(
  input: CompileInput,
  wouldRun: boolean,
): {
  result: CompileResult
  structural?: ReadonlyMap<string, ScopeStructuralGraph>
  inactiveExclusive?: ReadonlyMap<string, ReadonlySet<string>>
} {
  const { document: doc, scope } = input
  const resolve = documentResolver(doc, input.resolve)
  const resolveNode = documentNodeResolver(doc, input.resolve)
  const isVirtualNode = (graphId: string, node: NodeData): boolean =>
    node.virtual === true && resolveNode(graphId, node)?.virtual === true
  /**
   * Capability gate for the $typed graph wire form (joint contract, Dinkster
   * ea6eca7): absent = the target server would pass the marker through as a
   * plain literal dict, so HOLD the lowering and refuse loudly instead.
   */
  const emitTypedLiterals = input.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_TYPED_LITERAL) ?? false
  const emitDecimalInts = input.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_DECIMAL_INT) ?? false
  const emitRegions = input.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_REGIONS) ?? false
  const diags: Diagnostic[] = []
  const elaborationDiagnosticOwners = new Map<Diagnostic, {
    readonly graphId: GraphDefId
    readonly nodeId: NodeId
    readonly runtimeId?: string
  }>()
  const flat = new Map<string, FlatNode>()
  interface RegionLowering {
    readonly runtimeId: string
    readonly occ: Occurrence
    readonly node: NodeData
    readonly parentDefId: GraphDefId
    readonly childId: GraphDefId
    readonly childPath: readonly NodeId[]
    readonly stateOutputAliases: ReadonlyMap<string, string>
  }
  const regions = new Map<string, RegionLowering>()
  /** runtimeId -> inputId -> promoted-value override (first write wins: outer beats inner). */
  const overrides = new Map<string, Map<string, Json>>()
  interface ControllerSource {
    readonly source: ControllerInputSource
    readonly widget: WidgetSpec
    readonly ownerPriority: number
  }
  /** runtimeId -> inputId -> effective controller sources, outside-in. */
  const controllerSources = new Map<string, Map<string, ControllerSource[]>>()
  const recordControllerSource = (
    target: ResolvedInput,
    graph: GraphDefId,
    occurrence: Occurrence,
    input: ElaboratedInput,
    ownerPriority: number,
  ): void => {
    const widget = input.spec.widget
    if (widget?.controller !== 'after_generate') return
    let byInput = controllerSources.get(target.runtimeId)
    if (!byInput) controllerSources.set(target.runtimeId, (byInput = new Map()))
    let sources = byInput.get(target.elabKey)
    if (!sources) byInput.set(target.elabKey, (sources = []))
    const source: ControllerInputSource = { graph, occurrence, valueKey: valueKeyOf(input) }
    if (sources.some((candidate) =>
      candidate.source.graph === source.graph &&
      candidate.source.occurrence.node === source.occurrence.node &&
      candidate.source.valueKey === source.valueKey)) return
    sources.push({ source, widget, ownerPriority })
  }
  /** Every (defId, instancePath) at which a graph definition is instantiated. */
  const graphOccurrences: { defId: GraphDefId; path: readonly NodeId[] }[] = []
  const liveness = new LivenessDerivation()
  const selectorOverrides = new Map<string, SelectorCandidateId>()
  const recordSuccessfulDelivery = (target: ResolvedInput): void => {
    liveness.recordSuccessfulDestination(target.runtimeId, target.input.address)
  }

  const graphOf = (defId: string): GraphDef | undefined => doc.graphs[defId]

  const anchorOf = (path: readonly NodeId[], node: NodeId): { occurrence: Occurrence } => ({
    occurrence: { instancePath: path, node },
  })

  // compile.schema.unknown is scope-sensitive. An unresolved node never
  // enters `flat`, so it can never reach the prompt; it is fatal only when
  // the executed scope needs it - a consumer inside the executed closure
  // draws from it, or a partial-execution target names it. A stray
  // unresolved node elsewhere in the document must not block the run
  // (muted/bypassed unresolved nodes already compile fine, same principle).
  // The executed scope is not known until liveness derives it, so every
  // unresolved-schema diagnostic starts as an error and registers here with
  // the runtime ids of the consumers whose scope membership decides it;
  // settleUnknownSchema() then demotes the ones no included node depends on.
  const pendingUnknownSchema = new Map<Diagnostic, Set<string>>()
  const unknownSchemaDiag = (path: readonly NodeId[], node: NodeData): Diagnostic => {
    const diagnostic = diag('error', 'compile', 'compile.schema.unknown', `unknown node type '${node.type}'`, { anchor: anchorOf(path, node.id), data: { nodeType: node.type } })
    pendingUnknownSchema.set(diagnostic, new Set())
    return diagnostic
  }
  const attachUnknownSchemaDependents = (sink: readonly Diagnostic[], dependents: readonly string[]): void => {
    if (dependents.length === 0) return
    for (const diagnostic of sink) {
      const deciders = pendingUnknownSchema.get(diagnostic)
      if (deciders) for (const dependent of dependents) deciders.add(dependent)
    }
  }
  const settleUnknownSchema = (executedScope: ReadonlySet<string>): void => {
    for (const [diagnostic, deciders] of pendingUnknownSchema) {
      if ([...deciders].some((dependent) => executedScope.has(dependent))) continue
      ;(diagnostic as { severity: Diagnostic['severity'] }).severity = 'warning'
    }
    pendingUnknownSchema.clear()
  }
  /** Unresolved occurrences seen at collection: occurrence key -> node type. */
  const unresolvedCollected = new Map<string, string>()

  const scanRegions = (defId: GraphDefId, path: readonly NodeId[], stack: ReadonlySet<GraphDefId>): void => {
    if (stack.has(defId)) return
    const def = graphOf(defId)
    if (!def) return
    const nextStack = new Set(stack).add(defId)
    for (const node of Object.values(def.nodes)) {
      if (isVirtualNode(defId, node)) continue
      const mode = node.mode ?? 'active'
      if (node.region !== undefined) {
        if (mode === 'muted') continue
        const occurrence = { instancePath: path, node: node.id }
        if (mode === 'bypassed') {
          diags.push(diag('error', 'compile', 'compile.region.bypassUnsupported', 'region occurrences cannot be bypassed because their list contracts have no positional passthrough', { anchor: { occurrence } }))
          continue
        }
      }
      const childId = subgraphDefIdOf(node.type)
      if (childId !== undefined) {
        if (mode === 'active') scanRegions(asGraphDefId(childId), [...path, node.id], nextStack)
        continue
      }
    }
  }
  scanRegions(doc.root, [], new Set())
  if (diags.some((diagnostic) => diagnostic.severity === 'error')) {
    return { result: { ok: false, diagnostics: diags } }
  }
  // -- Occurrence contexts and forwarding state
  //
  // One context per GRAPH OCCURRENCE. Family forwarding makes a node's
  // effective interface occurrence-dependent: an inner node targeted by a
  // forwarded family gains that occurrence's instance-appended suffix
  // members. The merged member list exists only here - derived
  // per compile, never persisted, never shared between occurrences.

  interface OccCtx {
    readonly defId: GraphDefId
    readonly path: readonly NodeId[]
    /** nodeId -> occurrence-local merged dynamic state (forwarded targets only). */
    readonly overlays: Map<NodeId, Readonly<Record<string, DynamicPortState>>>
    /** nodeId -> values that determine an occurrence-local elaborated interface. */
    readonly values: Map<NodeId, Readonly<Record<string, Json>>>
    readonly controllers: Map<NodeId, NonNullable<NodeData['controllers']>>
    /** nodeId -> input/output addresses projected through crossings from outer graphs. */
    readonly extraIn: Map<NodeId, ProjectedAddress[]>
    readonly extraOut: Map<NodeId, ProjectedAddress[]>
  }
  // Node ids may contain every separator character, including NUL. Encode the
  // segment array itself so distinct occurrence paths cannot share a cache
  // entry or routed-vertex identity.
  const pathKey = (path: readonly NodeId[]): string => JSON.stringify(path)
  const topologyKey = (path: readonly NodeId[], defId: string): string => JSON.stringify([defId, path])
  const occCtxByPath = new Map<string, OccCtx>()
  const newOccCtx = (defId: GraphDefId, path: readonly NodeId[]): OccCtx => {
    const ctx: OccCtx = { defId, path, overlays: new Map(), values: new Map(), controllers: new Map(), extraIn: new Map(), extraOut: new Map() }
    occCtxByPath.set(pathKey(path), ctx)
    return ctx
  }
  /** Instance occurrence key -> boundaryId -> crossing. */
  const crossingsByInstance = new Map<string, ReadonlyMap<string, BoundaryCrossing>>()
  const projectedLegSuppressions = new Set(
    Object.values(doc.occurrenceTopologies ?? {}).flatMap((topology) =>
      (topology.suppressedDeliveries ?? [])
        .filter((suppression) => suppression.kind === 'projectedLeg')
        .map((suppression) => JSON.stringify([
          [...topology.owner.instancePath, topology.owner.node],
          suppressedDeliveryKey(suppression),
        ])),
    ),
  )
  const routeIsSuppressed = (
    ownerPath: readonly NodeId[],
    delivery: ParentDeliveryIdentity | undefined,
    route: readonly BoundaryRouteLeg[],
  ): boolean => delivery !== undefined && projectedLegSuppressions.has(JSON.stringify([
    ownerPath,
    suppressedDeliveryKey({ kind: 'projectedLeg', delivery, route }),
  ]))

  interface ProjectedAddress {
    readonly address: PortAddress
    readonly delivery?: ParentDeliveryIdentity
    readonly route: readonly BoundaryRouteLeg[]
  }

  interface TopologyConnection {
    readonly from: LinkEndpoint
    readonly to: LinkEndpoint
    readonly identity: EffectiveLinkIdentity
    readonly what: string
    readonly delivery?: ParentDeliveryIdentity
  }
  const topologyCache = new Map<string, readonly TopologyConnection[]>()
  const topologyFor = (path: readonly NodeId[], defId: GraphDefId): readonly TopologyConnection[] => {
    const key = topologyKey(path, defId)
    const cached = topologyCache.get(key)
    if (cached) return cached
    const connections: TopologyConnection[] = []
    if (path.length === 0) {
      const def = graphOf(defId)
      for (const link of Object.values(def?.links ?? {})) connections.push({
        from: link.from,
        to: link.to,
        identity: { kind: 'definition', graphId: defId, linkId: link.id },
        what: `link '${link.id}'`,
        delivery: { kind: 'link', graph: defId, linkId: link.id },
      })
      for (const net of Object.values(def?.nets ?? {})) for (const to of net.sinks) connections.push({
        from: net.source,
        to,
        identity: { kind: 'definitionNetSink', graphId: defId, netId: net.id, to },
        what: `net '${net.name}'`,
        delivery: { kind: 'netSink', graph: defId, netId: net.id, to },
      })
    } else {
      const owner: Occurrence = { instancePath: path.slice(0, -1), node: path[path.length - 1]! }
      const effective = effectiveOccurrenceTopology(doc, input.resolve, owner)
      diags.push(...effective.diagnostics)
      for (const link of effective.links) {
        const delivery: ParentDeliveryIdentity | undefined = link.identity.kind === 'definition'
          ? { kind: 'link', graph: link.identity.graphId, linkId: link.identity.linkId }
          : link.identity.kind === 'definitionNetSink'
            ? { kind: 'netSink', graph: link.identity.graphId, netId: link.identity.netId, to: link.identity.to }
            : undefined
        connections.push({
          from: link.from.endpoint,
          to: link.to.endpoint,
          identity: link.identity,
          what: link.identity.kind === 'occurrence'
            ? `occurrence link '${link.identity.linkId}'`
            : link.identity.kind === 'definition'
              ? `link '${link.identity.linkId}'`
              : link.identity.kind === 'definitionNetSink'
                ? `net '${effective.bodyGraph.nets[link.identity.netId]?.name ?? link.identity.netId}'`
                : `projected ${link.identity.kind}`,
          ...(delivery ? { delivery } : {}),
        })
      }
    }
    topologyCache.set(key, connections)
    return connections
  }

  const topologyGraphFor = (path: readonly NodeId[], defId: GraphDefId): GraphDef => {
    const def = graphOf(defId)!
    const links = Object.fromEntries(topologyFor(path, defId).map((connection, index) => {
      const id = `__effective_${index}` as LinkId
      return [id, { id, from: connection.from, to: connection.to }]
    }))
    return { ...def, links, nets: {} }
  }

  // -- Elaborated interfaces (occurrence-aware, memoized) --------------------
  //
  // The compiler reasons over ELABORATED interfaces, not raw schema items:
  // dynamic families, combo branches, and slot dependents resolve here
  // through the exact same elaborateInterface the editor and solver use, so
  // compile and view can never disagree about which ports exist. Elaboration
  // is deterministic over (schema, node state, connectivity). For most nodes
  // those live in the definition, so every occurrence shares one cached
  // elaboration; a node with an occurrence overlay or projected connectivity
  // (forwarded-family target) elaborates per occurrence instead - the two
  // caches never mix because one instance must not see another's state.

  const connectivityCache = new Map<string, (node: NodeId) => Connectivity>()
  const connectivityFor = (path: readonly NodeId[], defId: GraphDefId): ((node: NodeId) => Connectivity) => {
    const key = topologyKey(path, defId)
    let c = connectivityCache.get(key)
    if (!c) {
      const def = graphOf(defId)
      connectivityCache.set(key, (c = def ? buildGraphConnectivity(topologyGraphFor(path, defId)) : () => EMPTY_CONNECTIVITY))
    }
    return c
  }

  const withExtraConnectivity = (
    base: Connectivity,
    ins: readonly ProjectedAddress[] | undefined,
    outs: readonly ProjectedAddress[] | undefined,
  ): Connectivity => {
    if (!ins?.length && !outs?.length) return base
    const inKeys = new Set((ins ?? []).map(({ address }) => portAddressKey(address.port, address.members)))
    const outKeys = new Set((outs ?? []).map(({ address }) => portAddressKey(address.port, address.members)))
    return {
      isInputConnected: (p, m) => inKeys.has(portAddressKey(p, m)) || base.isInputConnected(p, m),
      isOutputConnected: (p, m) => outKeys.has(portAddressKey(p, m)) || base.isOutputConnected(p, m),
      inputPorts: () => [
        ...(base.inputPorts?.() ?? []),
        ...(ins ?? []).map(({ address }) => address).filter((address) => address.members === undefined || address.members.length === 0).map((address) => address.port),
      ],
    }
  }

  const elabCache = new Map<string, Map<NodeId, NodeElab>>()
  const occElabCache = new Map<string, NodeElab>()
  const elabAt = (ctx: OccCtx, node: NodeData, schema: NodeSchema): NodeElab => {
    const overlay = ctx.overlays.get(node.id)
    const values = ctx.values.get(node.id)
    const extraIn = ctx.extraIn.get(node.id)
    const extraOut = ctx.extraOut.get(node.id)
    const runtimeId = occurrenceKey({ instancePath: ctx.path, node: node.id })
    if (doc.occurrenceTopologies === undefined && overlay === undefined && values === undefined && extraIn === undefined && extraOut === undefined) {
      return elabOf(ctx.defId, node, schema)
    }
    const hit = occElabCache.get(runtimeId)
    if (hit) return hit
    const state = overlay === undefined && values === undefined
      ? node
      : {
          values: values ?? node.values,
          ...(overlay !== undefined ? { dynamic: overlay } : node.dynamic !== undefined ? { dynamic: node.dynamic } : {}),
        }
    const connectivity = withExtraConnectivity(connectivityFor(ctx.path, ctx.defId)(node.id), extraIn, extraOut)
    const elab = buildElab(
      `${ctx.defId}/${node.id} @ ${runtimeId}`,
      node.id,
      node.type,
      schema,
      state,
      connectivity,
      { graphId: ctx.defId, nodeId: node.id, runtimeId },
    )
    occElabCache.set(runtimeId, elab)
    return elab
  }
  const elabOf = (defId: string, node: NodeData, schema: NodeSchema): NodeElab => {
    let byNode = elabCache.get(defId)
    if (!byNode) elabCache.set(defId, (byNode = new Map()))
    const hit = byNode.get(node.id)
    if (hit) return hit
    const elab = buildElab(
      `${defId}/${node.id}`,
      node.id,
      node.type,
      schema,
      node,
      connectivityFor([], defId as GraphDefId)(node.id),
      { graphId: asGraphDefId(defId), nodeId: node.id },
    )
    byNode.set(node.id, elab)
    return elab
  }

  function buildElab(
    where: string,
    nodeId: NodeId,
    nodeType: string,
    schema: NodeSchema,
    state: Pick<NodeData, 'values' | 'dynamic'>,
    connectivity: Connectivity,
    owner: { readonly graphId: GraphDefId; readonly nodeId: NodeId; readonly runtimeId?: string },
  ): NodeElab {
    // promoteGhosts: false - promotion is a view affordance for the one
    // frame before normalization persists a just-connected ghost. A compile
    // runs against normalized state; honoring promotion here would let a
    // persisted link whose lowering is dropped (muted endpoint, undriven
    // reroute) conjure an api-visible member that leaks values/defaults or
    // shifts output wire indexes.
    const e = elaborateInterface(schema, state, connectivity, { promoteGhosts: false, nodeId })
    // Elaboration diagnostics surface once per cache entry: once per
    // definition node normally, once per occurrence for overlaid nodes
    // (over-cap etc. genuinely depend on the merged occurrence state).
    // Errors (budget exhaustion) fail the compile - a truncated interface
    // must never produce a prompt.
    for (const d of e.diagnostics) {
      const diagnostic = diag(d.severity, 'compile', d.code, `[${where}] ${d.message}`, {
        ...(d.anchor !== undefined ? { anchor: d.anchor } : {}),
        ...(d.refs !== undefined ? { refs: d.refs } : {}),
      })
      diags.push(diagnostic)
      elaborationDiagnosticOwners.set(diagnostic, owner)
    }
    // Duplicate identities/wire names would silently overwrite one another
    // in the staging record or the prompt: reject the interface loudly
    // (schemas own uniqueness; this is the backstop).
    const dup = (code: string, what: string): void => {
      const diagnostic = diag('error', 'compile', code, `[${where}] '${nodeType}' elaborates duplicate ${what}`)
      diags.push(diagnostic)
      elaborationDiagnosticOwners.set(diagnostic, owner)
    }
    const inputs = elabInputsOf(e)
    const inputsByValueKey = new Map<string, ElaboratedInput>()
    const inputsByAddr = new Map<string, ElaboratedInput>()
    const apiNames = new Set<string>()
    for (const i of inputs) {
      const addr = portAddressKey(i.address.port, i.address.members)
      if (inputsByAddr.has(addr)) dup('compile.interface.duplicatePort', `input '${i.spec.id}'`)
      inputsByAddr.set(addr, i)
      // Top-level static inputs persist values under the RAW schema id (which
      // '#'/'%' escaping may differ from spec.id); everything dynamic-derived
      // persists under elaborated identity. A collision across the two (a raw
      // 'a%23b' vs an escaped 'a#b') is a genuinely ambiguous document key.
      const valueKey = valueKeyOf(i)
      if (inputsByValueKey.has(valueKey)) dup('compile.interface.duplicateValueKey', `value key '${valueKey}'`)
      inputsByValueKey.set(valueKey, i)
      if (i.apiName !== undefined) {
        if (apiNames.has(i.apiName)) dup('compile.interface.duplicateApiName', `wire name '${i.apiName}'`)
        apiNames.add(i.apiName)
      }
    }
    // Wire output index: position among WIREABLE elaborated outputs (the
    // interface the backend sees). Ghost/over-cap/unknown outputs stay
    // addressable (for precise link diagnostics) but never take an index.
    const outputs = elabOutputsOf(e)
    const outputsByAddr = new Map<string, ElaboratedOutput>()
    const outputIndexByAddr = new Map<string, number>()
    let outputIndex = 0
    for (const o of outputs) {
      const addr = portAddressKey(o.address.port, o.address.members)
      if (outputsByAddr.has(addr)) dup('compile.interface.duplicatePort', `output '${o.spec.id}'`)
      outputsByAddr.set(addr, o)
      if (o.wireable !== false) outputIndexByAddr.set(addr, outputIndex++)
    }
    return { inputs, outputs, outputCountInputs: new Set(outputSchemaInputsOf(schema)), ...(e.outputMembers ? { outputMembers: e.outputMembers } : {}), submissionValues: e.submissionValues, inputsByValueKey, inputsByAddr, outputsByAddr, outputIndexByAddr }
  }

  // -- Structural port resolution (walks definitions only; no flat state) ----
  //
  // 'muted' short-circuits BEFORE any schema/port validation: a muted
  // endpoint means the connection is dropped (a warning at the call site),
  // and a DEAD EDGE IS NOT AUDITED AT ALL - neither endpoint's structure,
  // schema, or ports fail the compile (callers resolve both ends into a
  // scratch sink and discard it when either end is muted). Muting a node
  // deliberately disables its edges; a disabled edge must not block a run
  // over stale state it no longer delivers.
  //
  // 'bypassed' short-circuits the same way, but with opposite intent: an
  // input-side hit means the edge is CONSUMED by passthrough (dropped here,
  // silently - downstream traces re-read it as a driver); an output-side hit
  // returns a BypassAt marker for the routed projection to continue upstream.
  //
  // `sink` collects this resolution's diagnostics (defaults to the compile's
  // main list). Note elabOf pushes to the main list directly by design:
  // elaboration facts are definition-level, not edge-level.

  function resolveInputPort(
    path: readonly NodeId[],
    defId: string,
    ref: PortRef,
    sink: Diagnostic[] = diags,
    delivery?: ParentDeliveryIdentity,
    boundaryRoute: readonly BoundaryRouteLeg[] = [],
    openRegion?: string,
  ): readonly ResolvedInput[] | 'muted' | 'bypassed' | undefined {
    const def = graphOf(defId)
    const node = def?.nodes[ref.node]
    if (!def || !node) {
      sink.push(diag('error', 'compile', 'compile.link.danglingNode', `input ref names missing node '${ref.node}' in graph '${defId}'`))
      return undefined
    }
    if ((node.mode ?? 'active') === 'muted') return 'muted'
    if (node.mode === 'bypassed') return 'bypassed'
    const childId = subgraphDefIdOf(node.type)
    if (childId !== undefined) {
      const regionRuntimeId = occurrenceKey({ instancePath: path, node: node.id })
      if (node.region !== undefined && openRegion !== regionRuntimeId) {
        const schema = resolveNode(defId, node)
        if (!schema) {
          sink.push(unknownSchemaDiag(path, node))
          return undefined
        }
        const ctx = occCtxByPath.get(pathKey(path))
        const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
        const input = elab.inputsByAddr.get(portAddressKey(ref.port, ref.members))
        if (!input || input.apiName === undefined) {
          sink.push(diag('error', 'compile', 'compile.port.unknownInput', `'${node.type}' has no wireable input '${ref.port}'${ref.members ? ` member '${ref.members.join('.')}'` : ''}`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        if (routeIsSuppressed(path, delivery, boundaryRoute)) return []
        return [{ runtimeId: regionRuntimeId, elabKey: input.spec.id, input }]
      }
      const child = graphOf(childId)
      // Boundary item selection goes through the ONE matcher (crossing.ts):
      // ids may legally contain '.', so a forwarded family's stamped
      // addresses ('pics', 'pics.slot') are matched by enumeration, never by
      // first-segment shortcuts.
      const match = matchBoundaryItem(child?.boundary?.inputs ?? [], ref)
      if (!child || !match.ok) {
        const ambiguous = child && !match.ok && match.code === 'ambiguous'
        sink.push(diag(
          'error',
          'compile',
          ambiguous ? 'compile.boundary.ambiguousAddress' : 'compile.boundary.missingInput',
          ambiguous && !match.ok
            ? `subgraph '${childId}': ${match.message}`
            : `subgraph '${childId}' has no boundary input '${ref.port}'${ref.members ? ` member '${ref.members.join('.')}'` : ''}`,
          { anchor: anchorOf(path, node.id) },
        ))
        return undefined
      }
      const item = match.item
      if (isForwardingBinding(item.binds)) {
        // Whole-family forwarding: translate the instance address to the
        // inner endpoint through the crossing (the one address interpreter
        // in crossing.ts), then resolve recursively
        // (chained forwarding re-enters this branch on the inner instance).
        const crossing = crossingsByInstance.get(occurrenceKey({ instancePath: path, node: node.id }))?.get(item.id)
        if (!crossing) {
          sink.push(diag('error', 'compile', 'compile.boundary.forwardUnresolved', `subgraph '${childId}' boundary input '${item.id}' forwards a family but its crossing did not resolve`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        const targets: ResolvedInput[] = []
        let sawMuted = false
        let sawBypassed = false
        for (const targetCrossing of crossingTargets(crossing)) {
          const t = translateThroughCrossing(targetCrossing, ref)
          if (!t.ok) {
            sink.push(diag('error', 'compile', t.code, `subgraph '${childId}' boundary input '${item.id}': ${t.message}`, { anchor: anchorOf(path, node.id) }))
            return undefined
          }
          const bindingIndex = crossingTargets(crossing).indexOf(targetCrossing)
          const binding = [item.binds, ...(item.alsoBinds ?? [])][bindingIndex]!
          const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding }]
          if (routeIsSuppressed([...path, node.id], delivery, route)) continue
          const resolved = resolveInputPort([...path, node.id], childId, t.ref, sink, delivery, route, openRegion)
          if (resolved === 'muted') sawMuted = true
          else if (resolved === 'bypassed') sawBypassed = true
          else if (resolved !== undefined) targets.push(...resolved)
        }
        if (targets.length > 0) return targets
        if (sawMuted) return 'muted'
        if (sawBypassed) return 'bypassed'
        return undefined
      }
      // Fan-out (alsoBinds): one boundary input drives EVERY bound inner
      // input. Each binding resolves independently; muted/bypassed targets
      // drop out (their local edge is dead) while the edge stays alive for
      // the rest. With zero live targets the singular statuses collapse so
      // callers keep the existing dead-edge policy.
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      const targets: ResolvedInput[] = []
      let sawMuted = false
      let sawBypassed = false
      for (const b of bindings) {
        if (b.kind === 'widgetTap') {
          sink.push(diag('error', 'compile', 'compile.boundary.invalidInputBinding', `subgraph '${childId}' boundary input '${item.id}' cannot bind an output-only widget tap`, { anchor: anchorOf(path, node.id) }))
          continue
        }
        const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: b }]
        if (routeIsSuppressed([...path, node.id], delivery, route)) continue
        const r = resolveInputPort([...path, node.id], childId, b, sink, delivery, route, openRegion)
        if (r === 'muted') sawMuted = true
        else if (r === 'bypassed') sawBypassed = true
        else if (r !== undefined) targets.push(...r)
      }
      if (targets.length > 0) return targets
      if (sawMuted) return 'muted'
      if (sawBypassed) return 'bypassed'
      return undefined
    }
    const schema = resolveNode(defId, node)
    if (!schema) {
      sink.push(unknownSchemaDiag(path, node))
      return undefined
    }
    const ctx = occCtxByPath.get(pathKey(path))
    const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
    const input = elab.inputsByAddr.get(portAddressKey(ref.port, ref.members))
    if (!input) {
      sink.push(diag('error', 'compile', 'compile.port.unknownInput', `'${node.type}' has no input '${ref.port}'${ref.members ? ` member '${ref.members.join('.')}'` : ''}`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (input.apiName === undefined) {
      // Elaborated but never compiled: ghost subtree, beyond the family cap,
      // or an unknown-kind placeholder. A committed document must not wire
      // through such a port - loud error, never a silent drop.
      sink.push(diag('error', 'compile', 'compile.port.unwirable', `'${node.type}' input '${input.spec.id}' exists but never reaches the prompt (ghost/over-cap/unknown dynamic kind)`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (hasSyntheticAncestor(input.ancestry)) {
      // Min-fill members are interface-only until a command materializes
      // them; a committed reference to one is a stale/malformed document
      // never something to silently honor.
      sink.push(diag('error', 'compile', 'compile.port.unmaterialized', `'${node.type}' input '${input.spec.id}' references an unmaterialized dynamic member; connect/assign through a command to materialize it`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (input.origin.kind === 'selector') {
      // A selector's value decides WHICH ports elaborate; a link or promoted
      // value cannot be honored without re-elaborating against it. Reject
      // rather than emit a prompt that contradicts its own interface.
      sink.push(diag('error', 'compile', 'compile.port.selector', `'${node.type}' input '${input.spec.id}' is a dynamic selector; it cannot be driven by links or promoted values`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (routeIsSuppressed(path, delivery, boundaryRoute)) return []
    return [{ runtimeId: occurrenceKey({ instancePath: path, node: node.id }), elabKey: input.spec.id, input }]
  }

  function resolveOutputPort(
    path: readonly NodeId[],
    defId: string,
    ref: PortRef,
    sink: Diagnostic[] = diags,
    delivery?: ParentDeliveryIdentity,
    boundaryRoute: readonly BoundaryRouteLeg[] = [],
    openRegion?: string,
  ): ResolvedOutput | ResolvedWidgetTap | 'muted' | { readonly bypass: BypassAt } | undefined {
    const def = graphOf(defId)
    if (ref.node === DINKSTER_REGION_PSEUDO_NODE) {
      sink.push(diag('error', 'compile', 'compile.region.invalidIndex', `'$region.${ref.port}' is available only as the immediate region index source`))
      return undefined
    }
    const node = def?.nodes[ref.node]
    if (!def || !node) {
      sink.push(diag('error', 'compile', 'compile.link.danglingNode', `output ref names missing node '${ref.node}' in graph '${defId}'`))
      return undefined
    }
    if ((node.mode ?? 'active') === 'muted') return 'muted'
    if (node.mode === 'bypassed') return { bypass: { path, defId, ref } }
    const childId = subgraphDefIdOf(node.type)
    if (childId !== undefined) {
      const regionRuntimeId = occurrenceKey({ instancePath: path, node: node.id })
      if (node.region !== undefined && openRegion !== regionRuntimeId) {
        const schema = resolveNode(defId, node)
        if (!schema) {
          sink.push(unknownSchemaDiag(path, node))
          return undefined
        }
        const ctx = occCtxByPath.get(pathKey(path))
        const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
        const addr = portAddressKey(ref.port, ref.members)
        const outputIndex = elab.outputIndexByAddr.get(addr)
        if (outputIndex === undefined) {
          sink.push(diag('error', 'compile', 'compile.port.unknownOutput', `'${node.type}' has no wireable output '${ref.port}'${ref.members ? ` member '${ref.members.join('.')}'` : ''}`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        return { runtimeId: regionRuntimeId, outputIndex }
      }
      const child = graphOf(childId)
      // Symmetric with the input side: one boundary matcher (crossing.ts).
      const match = matchBoundaryItem(child?.boundary?.outputs ?? [], ref)
      if (!child || !match.ok) {
        const ambiguous = child && !match.ok && match.code === 'ambiguous'
        sink.push(diag(
          'error',
          'compile',
          ambiguous ? 'compile.boundary.ambiguousAddress' : 'compile.boundary.missingOutput',
          ambiguous && !match.ok
            ? `subgraph '${childId}': ${match.message}`
            : `subgraph '${childId}' has no boundary output '${ref.port}'${ref.members ? ` member '${ref.members.join('.')}'` : ''}`,
          { anchor: anchorOf(path, node.id) },
        ))
        return undefined
      }
      const item = match.item
      if (item.binds.kind === 'widgetTap') {
        const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: item.binds }]
        if (routeIsSuppressed([...path, node.id], delivery, route)) return undefined
        const childPath = [...path, node.id]
        const tapped = tappedInputs(childPath, childId, item.binds.node, item.binds.tap, sink)
        if (!tapped) {
          sink.push(diag('error', 'compile', 'compile.tap.missingInput', `widget tap '${item.binds.node}.${item.binds.tap}' in graph '${childId}' names a missing input; boundary output '${item.id}' omitted`))
          return undefined
        }
        if (tapped !== 'muted' && tapped.some((input) => canonicalTypeIdOf(input.input.spec.type) === undefined)) {
          sink.push(diag('error', 'compile', 'compile.tap.nonConcrete', `widget tap '${item.binds.node}.${item.binds.tap}' in graph '${childId}' has a non-concrete input type; boundary output '${item.id}' omitted`))
          return undefined
        }
        return {
          widgetTap: {
            path: childPath,
            defId: childId,
            endpoint: { node: item.binds.node, tap: item.binds.tap },
          },
        }
      }
      if (item.binds.kind === 'family') {
        // Symmetric with the input side: one crossing, one translator.
        const crossing = crossingsByInstance.get(occurrenceKey({ instancePath: path, node: node.id }))?.get(item.id)
        if (!crossing) {
          sink.push(diag('error', 'compile', 'compile.boundary.forwardUnresolved', `subgraph '${childId}' boundary output '${item.id}' forwards a family but its crossing did not resolve`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        const t = translateThroughCrossing(crossing, ref)
        if (!t.ok) {
          sink.push(diag('error', 'compile', t.code, `subgraph '${childId}' boundary output '${item.id}': ${t.message}`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: item.binds }]
        if (routeIsSuppressed([...path, node.id], delivery, route)) return undefined
        return resolveOutputPort([...path, node.id], childId, t.ref, sink, delivery, route, openRegion)
      }
      const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: item.binds }]
      if (routeIsSuppressed([...path, node.id], delivery, route)) return undefined
      return resolveOutputPort([...path, node.id], childId, item.binds, sink, delivery, route, openRegion)
    }
    const schema = resolveNode(defId, node)
    if (!schema) {
      sink.push(unknownSchemaDiag(path, node))
      return undefined
    }
    const ctx = occCtxByPath.get(pathKey(path))
    const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
    const addr = portAddressKey(ref.port, ref.members)
    const output = elab.outputsByAddr.get(addr)
    if (!output) {
      sink.push(diag('error', 'compile', 'compile.port.unknownOutput', `'${node.type}' has no output '${ref.port}'${ref.members ? ` member '${ref.members.join('.')}'` : ''}`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (hasSyntheticAncestor(output.ancestry)) {
      sink.push(diag('error', 'compile', 'compile.port.unmaterialized', `'${node.type}' output '${output.spec.id}' references an unmaterialized dynamic member; connect through a command to materialize it`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    const outputIndex = elab.outputIndexByAddr.get(addr)
    if (outputIndex === undefined) {
      // Elaborated but not wireable (ghost/over-cap/unknown) - mirror of the
      // input-side apiName check.
      sink.push(diag('error', 'compile', 'compile.port.unwirable', `'${node.type}' output '${output.spec.id}' exists but never takes part in wiring (ghost/over-cap/unknown dynamic kind)`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    return { runtimeId: occurrenceKey({ instancePath: path, node: node.id }), outputIndex }
  }

  // -- Bypass passthrough tracing -------------------------------------------
  //
  // A consumer edge whose producer resolves onto a bypassed node re-routes
  // through that node: pick the matching DRIVEN input (bypass.ts owns the
  // rule), follow its driver through reroutes, and continue - the driver may
  // land on another bypassed node (chain), a muted node (dead edge), or a
  // value source (bake). Everything here operates on ELABORATED interfaces,
  // so subgraph instances (boundary schemas), dynamic members, and forwarded
  // families all match by the same machinery as plain static ports.

  const rerouteIndexCache = new Map<string, RerouteIndex>()
  const rerouteIndexFor = (path: readonly NodeId[], defId: GraphDefId): RerouteIndex => {
    const key = topologyKey(path, defId)
    let idx = rerouteIndexCache.get(key)
    if (!idx) {
      const def = graphOf(defId)
      idx = def
        ? buildRerouteIndex(topologyGraphFor(path, defId))
        : { driverOf: new Map(), successorsOf: new Map(), selectorDriverOf: new Map(), selectorSuccessorsOf: new Map(), inputDriverOf: new Map(), netSourceOf: new Map() }
      rerouteIndexCache.set(key, idx)
    }
    return idx
  }

  // -- Selector resolution (per DEFINITION, like values and dynamic state) ---
  //
  // Every occurrence of a definition shares one resolution: two instances of
  // the same subgraph pick the SAME candidate, exactly as they share widget
  // values. Fixed policies validate their named candidate; random policies
  // draw from the injected chooser. Every outcome lands in `selectorChoices`
  // so the artifact reproduces the exact execution (frozen views, re-runs).
  // Policy problems are compile ERRORS even for unconsumed selectors -
  // predictable over permissive.
  const selectorChoices: SelectorChoice[] = []
  const selectorResolutionCache = new Map<string, SelectorResolution>()
  const selectorResolutionFor = (defId: string): SelectorResolution => {
    const cached = selectorResolutionCache.get(defId)
    if (cached) return cached
    const map = new Map<string, SelectorCandidateId>()
    const def = graphOf(defId)
    for (const sel of Object.values(def?.selectors ?? {})) {
      const policy = sel.policy
      const replayed = input.candidateOverride?.({
        graph: defId,
        selector: sel.id,
        candidates: sel.candidates.map((candidate) => candidate.id),
      })
      if (replayed !== undefined) {
        const candidate = sel.candidates.find((entry) => entry.id === replayed)
        if (candidate === undefined) {
          diags.push(diag('error', 'compile', 'compile.selector.overrideDangling', `selector '${sel.id}' in graph '${defId}' cannot replay missing candidate '${replayed}'`))
        } else {
          map.set(sel.id, candidate.id)
          selectorOverrides.set(JSON.stringify([defId, sel.id]), candidate.id)
          selectorChoices.push({ graph: defId, selector: sel.id, policy: policy.kind, candidate: candidate.id })
        }
        continue
      }
      if (policy.kind === 'fixed') {
        if (sel.candidates.some((c) => c.id === policy.candidate)) {
          map.set(sel.id, policy.candidate)
          selectorChoices.push({ graph: defId, selector: sel.id, policy: 'fixed', candidate: policy.candidate })
        } else {
          diags.push(diag('error', 'compile', 'compile.selector.policyDangling', `selector '${sel.id}' in graph '${defId}' has a fixed policy naming missing candidate '${policy.candidate}'`))
        }
        continue
      }
      // random
      if (sel.candidates.length === 0) {
        diags.push(diag('error', 'compile', 'compile.selector.empty', `selector '${sel.id}' in graph '${defId}' has a random policy but no candidates`))
        continue
      }
      const overrideKey = JSON.stringify([defId, sel.id])
      const overridden = selectorOverrides.get(overrideKey)
      if (overridden !== undefined) {
        map.set(sel.id, overridden)
        selectorChoices.push({ graph: defId, selector: sel.id, policy: 'random', candidate: overridden })
        continue
      }
      if (!input.pickCandidate) {
        if (wouldRun) {
          // Would-run mode needs no chooser: the staged branch is arbitrary
          // (first candidate) because the closure adds extra edges for EVERY
          // candidate of a random selector below - the preview is a superset.
          map.set(sel.id, sel.candidates[0]!.id)
          selectorOverrides.set(overrideKey, sel.candidates[0]!.id)
          selectorChoices.push({ graph: defId, selector: sel.id, policy: 'random', candidate: sel.candidates[0]!.id })
          continue
        }
        // No ambient randomness: compile is a pure function of its inputs.
        // A hidden Math.random here would let the would-run preview and the
        // actual submission roll DIFFERENT branches.
        diags.push(diag('error', 'compile', 'compile.selector.noChooser', `selector '${sel.id}' in graph '${defId}' has a random policy but no pickCandidate chooser was provided`))
        continue
      }
      const raw = input.pickCandidate({ graph: defId, selector: sel.id, count: sel.candidates.length })
      const idx = Number.isFinite(raw) ? Math.min(sel.candidates.length - 1, Math.max(0, Math.floor(raw))) : 0
      const chosen = sel.candidates[idx]!
      map.set(sel.id, chosen.id)
      selectorOverrides.set(overrideKey, chosen.id)
      selectorChoices.push({ graph: defId, selector: sel.id, policy: 'random', candidate: chosen.id })
    }
    selectorResolutionCache.set(defId, map)
    return map
  }

  // -- Would-run bookkeeping (scopeClosure only) ------------------------------
  //
  // `wouldRunVia` records the structural elements (reroutes, selector
  // branches, value sources) each consumer's wires traverse - merged at the
  // end for consumers that land in the closure. `wouldRunInputEdges` records
  // every projected producer per destination input. Input identity is kept so
  // backend lazy selectors can choose one branch without changing the exact
  // staged prompt, while graph-level random selectors still union candidates.
  const wouldRunVia = wouldRun
    ? new Map<string, { inputKey: string; entries: { defId: string; via: TraceVia }[] }[]>()
    : undefined
  const wouldRunInputEdges = wouldRun ? new Map<string, Map<string, Set<string>>>() : undefined
  const randomSelectorInputs = new Map<string, Set<string>>()
  const fixedSelectionCache = new Map<string, SelectorResolution>()
  /** Selection narrowed to DECIDED (fixed-policy) selectors: random ones expand. */
  const fixedSelectionFor = (defId: string): SelectorResolution => {
    const cached = fixedSelectionCache.get(defId)
    if (cached) return cached
    const map = new Map<string, SelectorCandidateId>()
    const resolution = selectorResolutionFor(defId)
    const def = graphOf(defId)
    for (const s of Object.values(def?.selectors ?? {})) {
      if (s.policy.kind !== 'fixed') continue
      const c = resolution.get(s.id)
      if (c !== undefined) map.set(s.id, c)
    }
    fixedSelectionCache.set(defId, map)
    return map
  }

  /** Per-definition driver of each node input address (links + net sinks; first wins). */
  const inputDriverCache = new Map<string, Map<NodeId, Map<string, LinkEndpoint>>>()
  const inputDriverIndexFor = (path: readonly NodeId[], defId: GraphDefId): Map<NodeId, Map<string, LinkEndpoint>> => {
    const key = topologyKey(path, defId)
    let idx = inputDriverCache.get(key)
    if (idx) return idx
    const built = new Map<NodeId, Map<string, LinkEndpoint>>()
    const record = (node: NodeId, addrKey: string, from: LinkEndpoint): void => {
      let byAddr = built.get(node)
      if (!byAddr) built.set(node, (byAddr = new Map()))
      if (!byAddr.has(addrKey)) byAddr.set(addrKey, from)
    }
    for (const connection of topologyFor(path, defId)) {
      if (isPortEndpoint(connection.to)) record(connection.to.node, portAddressKey(connection.to.port, connection.to.members), connection.from)
    }
    inputDriverCache.set(key, built)
    return built
  }

  /** A driver endpoint plus the graph occurrence its topology lives in. */
  interface LocatedDriver {
    readonly endpoint: LinkEndpoint
    readonly path: readonly NodeId[]
    readonly defId: string
  }

  /**
   * What drives `(node, address)` as seen from graph occurrence (path,
   * defId)? An intra-definition link/net wins; otherwise, when the input is
   * bound by one of this definition's boundary INPUT items ('port' kind),
   * climb to the parent occurrence and look for a driver of the instance's
   * corresponding port - repeatedly, so chained boundary bindings resolve.
   * Family-bound (forwarded) member inputs do not climb in v1: their parent
   * addresses need crossing translation, and an unrouted WARNING is strictly
   * safer than a misrouted passthrough.
   */
  function driverOfInput(
    path: readonly NodeId[],
    defId: string,
    node: NodeId,
    address: PortAddress,
  ): LocatedDriver | undefined {
    let curPath = path
    let curDefId = defId
    let curNode = node
    let curAddrKey = portAddressKey(address.port, address.members)
    for (;;) {
      const drv = inputDriverIndexFor(curPath, curDefId as GraphDefId).get(curNode)?.get(curAddrKey)
      if (drv) return { endpoint: drv, path: curPath, defId: curDefId }
      if (curPath.length === 0) return undefined
      const def = graphOf(curDefId)
      const item = def?.boundary?.inputs.find(
        (i) => [i.binds, ...(i.alsoBinds ?? [])].some(
          (b) => b.kind === 'port'
            && b.node === curNode
            && portAddressKey(b.port, b.members) === curAddrKey,
        ),
      )
      if (!item) return undefined
      const instanceNode = curPath[curPath.length - 1]!
      const parentPath = curPath.slice(0, -1)
      const parentCtx = occCtxByPath.get(pathKey(parentPath))
      if (!parentCtx) return undefined
      curPath = parentPath
      curDefId = parentCtx.defId
      curNode = instanceNode
      curAddrKey = portAddressKey(item.id, undefined)
    }
  }

  type BypassTrace =
    | { readonly kind: 'output'; readonly src: ResolvedOutput }
    /**
     * A baked literal. `typeId` is the source's canonical runtime type when
     * one is declared (tap fallbacks always carry it; value sources never do
     * - DeclaredSpec has no runtime type), feeding the $typed lowering for
     * non-concrete destinations.
     */
    | { readonly kind: 'value'; readonly value: Json; readonly typeId?: string }
    | { readonly kind: 'muted'; readonly reason: string }
    | { readonly kind: 'dropped'; readonly reason: string }

  type RouteAt =
    | { readonly kind: 'bypass'; readonly bypass: BypassAt }
    | { readonly kind: 'endpoint'; readonly path: readonly NodeId[]; readonly defId: string; readonly endpoint: LinkEndpoint }

  interface SelectedBypassHop {
    readonly at: BypassAt
    readonly occurrenceKey: string
    readonly output: ElaboratedOutput
    readonly input: ElaboratedInput
    readonly inputIndex: number
    readonly driver: LocatedDriver
  }

  /**
   * The single structural bypass selection operation. Both projections use
   * this result; in particular, would-run may vary selector endpoints after
   * the selected input, but it may not rediscover an interface or rematch a
   * bypass input.
   */
  const selectBypassHop = (at: BypassAt, consumerType?: TypeExpr): SelectedBypassHop | undefined => {
    const def = graphOf(at.defId)
    const node = def?.nodes[at.ref.node]
    const schema = node && resolveNode(at.defId, node)
    if (!node || !schema) return undefined
    const ctx = occCtxByPath.get(pathKey(at.path))
    const elab = ctx ? elabAt(ctx, node, schema) : elabOf(at.defId, node, schema)
    const address = portAddressKey(at.ref.port, at.ref.members)
    const output = elab.outputsByAddr.get(address)
    const outputIndex = elab.outputIndexByAddr.get(address)
    if (!output || outputIndex === undefined) return undefined
    const candidates: BypassCandidate<{ readonly driver: LocatedDriver; readonly input: ElaboratedInput }>[] = []
    let wireIndex = 0
    for (const input of elab.inputs) {
      if (input.apiName === undefined || hasSyntheticAncestor(input.ancestry)) continue
      const index = wireIndex++
      const driver = driverOfInput(at.path, at.defId, at.ref.node, input.address)
      if (driver) candidates.push({ index, type: input.spec.type, driver: { driver, input } })
    }
    const selected = matchBypassInput(
      { index: outputIndex, type: consumerType ?? output.spec.type },
      candidates,
    )
    return selected && {
      at,
      occurrenceKey: occurrenceKey({ instancePath: at.path, node: at.ref.node }),
      output,
      input: selected.driver.input,
      inputIndex: selected.index,
      driver: selected.driver.driver,
    }
  }

  function projectRoute(
    start: RouteAt,
    projection: RouteProjection,
    sink: Diagnostic[],
    consumerType?: TypeExpr,
    viaFor?: (defId: string) => TraceVia,
    delivery?: ParentDeliveryIdentity,
  ): readonly BypassTrace[] {
    const result = traverseRoutedProjection<RouteAt, SelectedBypassHop, BypassTrace>(start, projection, {
      key: (at) => at.kind === 'bypass'
        ? JSON.stringify(['bypass', occurrenceKey({ instancePath: at.bypass.path, node: at.bypass.ref.node }), portAddressKey(at.bypass.ref.port, at.bypass.ref.members)])
        : JSON.stringify(['endpoint', at.path, at.defId, at.endpoint]),
      cycle: (at) => {
        if (projection === 'exact') {
          if (at.kind === 'bypass') sink.push(diag('error', 'compile', 'compile.bypass.cycle', `bypass passthrough through '${at.bypass.ref.node}' in graph '${at.bypass.defId}' forms a cycle`, { anchor: anchorOf(at.bypass.path, at.bypass.ref.node) }))
          else if (isRerouteRef(at.endpoint)) sink.push(diag('error', 'compile', 'compile.reroute.cycle', `reroute chain through '${at.endpoint.reroute}' in graph '${at.defId}' forms a cycle; route omitted`))
          else if (isSelectorRef(at.endpoint)) sink.push(diag('error', 'compile', 'compile.selector.cycle', `selector chain through '${at.endpoint.selector}/${at.endpoint.candidate ?? 'output'}' in graph '${at.defId}' forms a cycle; route omitted`))
          else if (isWidgetTapRef(at.endpoint)) sink.push(diag('error', 'compile', 'compile.tap.cycle', `widget tap '${at.endpoint.node}.${at.endpoint.tap}' in graph '${at.defId}' forms a cycle; route omitted`))
        }
        return [{ kind: 'dropped', reason: at.kind === 'bypass'
          ? `bypass cycle at '${at.bypass.ref.node}'`
          : `endpoint cycle at ${JSON.stringify(at.endpoint)}` }]
      },
      route: (at, selectedProjection): { readonly steps: readonly RoutedStep<RouteAt, BypassTrace>[]; readonly hop?: SelectedBypassHop } => {
        if (at.kind === 'endpoint') {
          const def = graphOf(at.defId)
          if (!def) return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `graph definition '${at.defId}' is unavailable` } }] }
          const index = rerouteIndexFor(at.path, at.defId as GraphDefId)
          const endpoint = at.endpoint
          if (isRerouteRef(endpoint)) {
            viaFor?.(at.defId).reroutes.add(endpoint.reroute)
            const driver = rerouteDriverOf(def, endpoint.reroute, index)
            if (driver) return { steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: at.path, defId: at.defId, endpoint: driver.from } }] }
            if (selectedProjection === 'exact') sink.push(diag('warning', 'compile', 'compile.reroute.undriven', `reroute '${endpoint.reroute}' in graph '${at.defId}' has no driver; route omitted`))
            return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `reroute '${endpoint.reroute}' is undriven` } }] }
          }
          if (isSelectorRef(endpoint)) {
            const selector = endpoint.selector
            const choices = endpoint.candidate !== undefined
              ? [endpoint.candidate]
              : selectedProjection === 'exact'
                ? [...(selectorResolutionFor(at.defId).get(selector) ? [selectorResolutionFor(at.defId).get(selector)!] : [])]
                : [...(fixedSelectionFor(at.defId).get(selector) ? [fixedSelectionFor(at.defId).get(selector)!] : (def.selectors?.[selector]?.candidates ?? []).map((candidate) => candidate.id))]
            const via = viaFor?.(at.defId)
            if (via && !via.selectors.has(selector)) via.selectors.set(selector, new Set())
            if (choices.length === 0) return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `selector '${selector}' is unresolved` } }] }
            return { steps: choices.map((candidate): RoutedStep<RouteAt, BypassTrace> => {
              via?.selectors.get(selector)?.add(candidate)
              const driver = selectorDriverOf(def, selector, candidate, index)
              if (!driver) {
                if (selectedProjection === 'exact') sink.push(diag('warning', 'compile', 'compile.selector.undriven', `selector '${selector}' candidate '${candidate}' in graph '${at.defId}' has no driver; route omitted`))
                return { kind: 'terminal', terminal: { kind: 'dropped', reason: `selector '${selector}' candidate '${candidate}' is undriven` } }
              }
              return { kind: 'recurse', at: { kind: 'endpoint', path: at.path, defId: at.defId, endpoint: driver.from } }
            }) }
          }
          if (isWidgetTapRef(endpoint)) {
            const ref: PortRef = { node: endpoint.node, port: endpoint.tap }
            const driver = index.inputDriverOf.get(portRefKey(ref))
            const netSource = index.netSourceOf.get(portRefKey(ref))
            if (driver || netSource) return { steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: at.path, defId: at.defId, endpoint: driver?.from ?? netSource! } }] }
            const tapped = tapValue(at.path, at.defId, endpoint.node, endpoint.tap, sink)
            if (tapped === 'muted') return { steps: [{ kind: 'terminal', terminal: { kind: 'muted', reason: `widget tap '${endpoint.node}.${endpoint.tap}' reaches a muted occurrence` } }] }
            if (tapped === undefined) {
              if (selectedProjection === 'exact') sink.push(diag('error', 'compile', 'compile.tap.novalue', `widget tap '${endpoint.node}.${endpoint.tap}' in graph '${at.defId}' has no value; route omitted`))
              return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `widget tap '${endpoint.node}.${endpoint.tap}' has no value` } }] }
            }
            return { steps: [{ kind: 'terminal', terminal: { kind: 'value', value: tapped.value, typeId: tapped.typeId } }] }
          }
          if (isValueSourceRef(endpoint)) {
            viaFor?.(at.defId).valueSources.add(endpoint.valueSource)
            const source = def.valueSources?.[endpoint.valueSource]
            if (!source) {
              if (selectedProjection === 'exact') sink.push(diag('error', 'compile', 'compile.valueSource.missing', `route in graph '${at.defId}' references missing value source '${endpoint.valueSource}'`))
              return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `value source '${endpoint.valueSource}' is missing` } }] }
            }
            return { steps: [{ kind: 'terminal', terminal: { kind: 'value', value: source.value } }] }
          }
          const resolved = resolveOutputPort(at.path, at.defId, endpoint, sink, delivery)
          if (resolved === 'muted') return { steps: [{ kind: 'terminal', terminal: { kind: 'muted', reason: `producer '${endpoint.node}' is muted or in an inactive occurrence` } }] }
          if (!resolved) return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `producer endpoint ${JSON.stringify(endpoint)} cannot deliver` } }] }
          return 'bypass' in resolved
            ? { steps: [{ kind: 'recurse', at: { kind: 'bypass', bypass: resolved.bypass } }] }
            : 'widgetTap' in resolved
              ? { steps: [{ kind: 'recurse', at: { kind: 'endpoint', ...resolved.widgetTap } }] }
            : { steps: [{ kind: 'terminal', terminal: { kind: 'output', src: resolved } }] }
        }
        const bypass = at.bypass
        const selected = selectBypassHop(bypass, consumerType)
        if (!selected) {
          if (selectedProjection === 'exact') {
          const node = graphOf(bypass.defId)?.nodes[bypass.ref.node]
          const schema = node && resolveNode(bypass.defId, node)
          if (!node) {
            // A dangling bypass occurrence was already diagnosed while its
            // structural endpoint was resolved.
          } else if (!schema) {
            sink.push(unknownSchemaDiag(bypass.path, node))
          } else {
            const ctx = occCtxByPath.get(pathKey(bypass.path))
            const elab = ctx ? elabAt(ctx, node, schema) : elabOf(bypass.defId, node, schema)
            const requested = elab.outputsByAddr.get(portAddressKey(bypass.ref.port, bypass.ref.members))
            if (!requested || !elab.outputIndexByAddr.has(portAddressKey(bypass.ref.port, bypass.ref.members))) {
              sink.push(diag('error', 'compile', 'compile.port.unknownOutput', `'${node.type}' has no wireable output '${bypass.ref.port}'${bypass.ref.members ? ` member '${bypass.ref.members.join('.')}'` : ''} to bypass through`, { anchor: anchorOf(bypass.path, bypass.ref.node) }))
            } else {
              sink.push(diag('warning', 'compile', 'compile.bypass.unrouted', `bypassed '${node.type}' ('${bypass.ref.node}' in graph '${bypass.defId}') has no driven input matching output '${requested.spec.id}'; consumer edge omitted`, { anchor: anchorOf(bypass.path, bypass.ref.node) }))
            }
          }
          }
          return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `bypassed '${bypass.ref.node}' has no matching driven input` } }] }
        }
        return { hop: selected, steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: selected.driver.path, defId: selected.driver.defId, endpoint: selected.driver.endpoint } }] }
      },
    })
    if (projection === 'exact' && result.hops.length > 0 && result.terminals.some((terminal) => terminal.kind === 'muted' || terminal.kind === 'dropped')) {
      const first = result.hops[0]!
      const dead = result.terminals.find((terminal) => terminal.kind === 'muted' || terminal.kind === 'dropped')!
      sink.push(diag('warning', 'compile', 'compile.bypass.structuralRouteDropped', `bypassed '${first.at.ref.node}' selected structural input '${first.input.spec.id}' at index ${first.inputIndex} for output '${first.output.spec.id}', but the selected route through [${result.hops.map((hop) => hop.occurrenceKey).join(', ')}] did not deliver (${dead.reason}); disconnecting or reordering that visible input changes routing`, { anchor: anchorOf(first.at.path, first.at.ref.node) }))
    }
    return result.terminals
  }

  // -- Pass 1: discover occurrences + crossings, derive overlays, collect ----
  //
  // Outside-in, so an instance's OWN occurrence-local state (overlay from
  // ITS parent, for chained forwarding) exists before its crossings are
  // built. Promoted values are NOT resolved here: value resolution needs the
  // complete crossing/occurrence index (a chained value can cross several
  // boundaries), so it runs as a separate pass over `pendingPromotions`.
  // Promoted output counts are the exception: they determine interface
  // shape and must enter the child context before its nodes elaborate.

  /** Per-definition index of link/net endpoint addresses by node (for projection). */
  const addrIndexCache = new Map<string, Map<NodeId, { ins: ProjectedAddress[]; outs: ProjectedAddress[] }>>()
  const addrIndexFor = (path: readonly NodeId[], defId: GraphDefId): Map<NodeId, { ins: ProjectedAddress[]; outs: ProjectedAddress[] }> => {
    const key = topologyKey(path, defId)
    let idx = addrIndexCache.get(key)
    if (idx) return idx
    const built = new Map<NodeId, { ins: ProjectedAddress[]; outs: ProjectedAddress[] }>()
    const at = (node: NodeId): { ins: ProjectedAddress[]; outs: ProjectedAddress[] } => {
      let e = built.get(node)
      if (!e) built.set(node, (e = { ins: [], outs: [] }))
      return e
    }
    const asAddr = (p: PortRef, connection: TopologyConnection): ProjectedAddress => ({
      address: { port: p.port, ...(p.members ? { members: p.members } : {}) },
      ...(connection.delivery ? { delivery: connection.delivery } : {}),
      route: [],
    })
    for (const connection of topologyFor(path, defId)) {
      if (isPortEndpoint(connection.from)) at(connection.from.node).outs.push(asAddr(connection.from, connection))
      if (isPortEndpoint(connection.to)) at(connection.to.node).ins.push(asAddr(connection.to, connection))
    }
    addrIndexCache.set(key, built)
    return built
  }

  const pendingPromotions: { parentCtx: OccCtx; node: NodeData; childId: GraphDefId }[] = []
  const effectiveBoundaryState = boundaryStateResolver(doc, resolveNode)

  function collectNodes(defId: GraphDefId, path: readonly NodeId[], ctx: OccCtx): void {
    const def = graphOf(defId)
    if (!def) {
      diags.push(diag('error', 'compile', 'compile.graph.missing', `graph definition '${defId}' not found`))
      return
    }
    graphOccurrences.push({ defId, path })
    for (const authored of Object.values(def.nodes)) {
      const overlay = ctx.overlays.get(authored.id)
      const values = ctx.values.get(authored.id)
      const controllers = ctx.controllers.get(authored.id)
      const state = effectiveBoundaryState(defId, authored, overlay === undefined && values === undefined && controllers === undefined ? authored : {
        ...authored,
        ...(values !== undefined ? { values } : {}),
        ...(overlay !== undefined ? { dynamic: overlay } : {}),
        ...(controllers !== undefined ? { controllers } : {}),
      })
      const node = state === authored ? authored : { ...authored, ...state }
      if (state !== authored) {
        ctx.values.set(node.id, node.values)
        if (node.dynamic !== undefined) ctx.overlays.set(node.id, node.dynamic)
        if (node.controllers !== undefined) ctx.controllers.set(node.id, node.controllers)
      }
      if (isVirtualNode(defId, node)) continue
      const mode = node.mode ?? 'active'
      // Muted and bypassed nodes never enter the prompt. A bypassed subgraph
      // instance also never recurses: bypass acts at the boundary schema, so
      // the definition's contents are as absent as a bypassed leaf's body.
      if (mode === 'muted' || mode === 'bypassed') continue
      const childId = subgraphDefIdOf(node.type)
      if (childId !== undefined) {
        const child = graphOf(childId)
        if (!child?.boundary) {
          diags.push(diag('error', 'compile', 'compile.subgraph.missing', `node '${node.id}' references missing/boundary-less subgraph '${childId}'`, { anchor: anchorOf(path, node.id) }))
          continue
        }
        const childPath = [...path, node.id]
        if (node.region !== undefined) {
          const schema = resolveNode(defId, node)
          if (!schema) {
            unresolvedCollected.set(occurrenceKey({ instancePath: path, node: node.id }), node.type)
            diags.push(unknownSchemaDiag(path, node))
            continue
          }
          const occ: Occurrence = { instancePath: path, node: node.id }
          const runtimeId = occurrenceKey(occ)
          const elab = elabAt(ctx, node, schema)
          flat.set(runtimeId, {
            runtimeId,
            occ,
            graphId: asGraphDefId(defId),
            node,
            elab,
            linkedInputs: new Set(),
            inputs: {},
          })
          regions.set(runtimeId, {
            runtimeId,
            occ,
            node,
            parentDefId: defId,
            childId: asGraphDefId(childId),
            childPath,
            stateOutputAliases: new Map(Object.entries(node.region.outputRoles ?? {}).flatMap(([outputId, role]) =>
              role.kind === 'state' ? [[outputId, role.statePort] as const] : [])),
          })
        }
        // The instance's OWN occurrence-local state: its parent's overlay
        // when this instance is itself a forwarded target (chained
        // forwarding), otherwise its persisted state. Every member in it is
        // a suffix member relative to the child definition.
        const instanceDynamic = ctx.overlays.get(node.id) ?? node.dynamic
        const instanceValues = ctx.values.get(node.id) ?? node.values
        const resolveChildNode = (inner: NodeData): NodeSchema | undefined => resolveNode(child.id, inner)
        const { crossings, problems } = buildBoundaryCrossings(child, resolve, instanceDynamic, resolveChildNode, instanceValues)
        if (problems.length > 0) {
          for (const p of problems) {
            diags.push(diag('error', 'compile', p.code, `${p.message} (node '${node.id}')`, { anchor: anchorOf(path, node.id) }))
          }
          continue
        }
        const childCtx = newOccCtx(asGraphDefId(childId), childPath)
        for (const [target, values] of projectCountBoundValues(child, instanceValues, resolveChildNode)) {
          childCtx.values.set(target, values)
        }
        // Selector forwarding is an occurrence-local state projection, not a
        // family crossing. It must run even when this boundary forwards no
        // families, and it composes with family overlays on the same node.
        for (const item of child.boundary.inputs) {
          if (item.binds.kind !== 'port') continue
          const target = child.nodes[item.binds.node]
          const targetSchema = target && resolveNode(child.id, target)
          if (!target || !targetSchema) continue
          const rr = resolveBoundaryRoute(targetSchema, item.binds, 'input')
          if (!rr.ok || rr.route.terminal.kind !== 'port') continue
          const dyn = rr.route.terminal.slot.dynamic
          if (dyn?.kind !== 'dynamicCombo') continue
          // Overlay ONLY an explicit valid instance selection. An unset (or
          // invalid) instance selection must inherit the definition's stored
          // choice: the derived item's defaultOption mirrors that choice, so
          // rendering and lowering agree by LEAVING the inner state alone.
          // Falling back to the inner spec here would compile keys[0] while
          // the instance renders the definition's selection (divergence).
          const requested = instanceDynamic?.[item.id]?.selected
          if (requested === undefined || !dyn.options.some((o) => o.key === requested)) continue
          const base = childCtx.overlays.get(target.id) ?? target.dynamic
          childCtx.overlays.set(target.id, overlaySelectorDynamic(base, rr.route, item.binds.port as string, requested))
        }
        if (crossings.size > 0) {
          crossingsByInstance.set(occurrenceKey({ instancePath: path, node: node.id }), crossings)
          // Occurrence-local dynamic-state overlays: definition
          // prefix + instance suffix merge into DERIVED state on the target
          // node, at the exact scope the crossing's route names. Cumulative:
          // two forwarded families on one inner node overlay in sequence.
          for (const crossing of crossings.values()) {
            for (const targetCrossing of crossingTargets(crossing)) {
              if (!isSubtreeCrossing(targetCrossing) && targetCrossing.countBound) continue
              const target = child.nodes[targetCrossing.targetNode]!
              childCtx.values.set(target.id, { ...(childCtx.values.get(target.id) ?? target.values), ...projectCrossingValues(instanceValues, targetCrossing) })
              childCtx.controllers.set(target.id, { ...(childCtx.controllers.get(target.id) ?? target.controllers), ...projectCrossingValues(node.controllers, targetCrossing) })
              const base = childCtx.overlays.get(targetCrossing.targetNode) ?? child.nodes[targetCrossing.targetNode]?.dynamic
              childCtx.overlays.set(
                targetCrossing.targetNode,
                overlayNodeDynamic(base, targetCrossing, instanceDynamic),
              )
            }
          }
          // Connectivity projection: edges attached to the instance's
          // forwarded-family addresses exist, structurally, on the inner
          // target too - DynamicSlot dependents inside a forwarded template
          // elaborate from link EXISTENCE, which must not stop at the
          // boundary. Only family addresses project: concrete bindings
          // cannot target dynamic constructs (derive rejects them), so no
          // compile-relevant elaboration reads their connectivity.
          // Untranslatable addresses are skipped silently here: the link
          // pass diagnoses each endpoint it RESOLVES with full context. An
          // edge whose lowering never resolves this endpoint (orphan/undriven
          // reroute chain, muted far side) stays undiagnosed by design - the
          // dead-edge policy; a skipped projection then cannot alter any
          // compiled elaboration either.
          const idx = addrIndexFor(path, defId).get(node.id)
          const project = (addrs: readonly ProjectedAddress[], side: 'input' | 'output', into: Map<NodeId, ProjectedAddress[]>, boundaryItems: readonly BoundaryItem[]): void => {
            for (const projected of addrs) {
              const m = matchBoundaryItem(boundaryItems, projected.address)
              if (!m.ok || !isForwardingBinding(m.item.binds)) continue
              const crossing = crossings.get(m.item.id)
              if (!crossing || crossing.side !== side) continue
              for (const [index, targetCrossing] of crossingTargets(crossing).entries()) {
                const binding = [m.item.binds, ...(m.item.alsoBinds ?? [])][index]!
                const route = [...projected.route, { graph: child.id, boundaryId: m.item.id, binding }]
                if (routeIsSuppressed(childPath, projected.delivery, route)) continue
                const t = translateThroughCrossing(targetCrossing, projected.address)
                if (!t.ok) continue
                let list = into.get(t.ref.node)
                if (!list) into.set(t.ref.node, (list = []))
                list.push({
                  address: { port: t.ref.port, ...(t.ref.members ? { members: t.ref.members } : {}) },
                  ...(projected.delivery ? { delivery: projected.delivery } : {}),
                  route,
                })
              }
            }
          }
          project([...(idx?.ins ?? []), ...(ctx.extraIn.get(node.id) ?? [])], 'input', childCtx.extraIn, child.boundary.inputs)
          project([...(idx?.outs ?? []), ...(ctx.extraOut.get(node.id) ?? [])], 'output', childCtx.extraOut, child.boundary.outputs)
        }
        // Concrete input connectivity also crosses the boundary. DynamicSlot
        // reads link existence during elaboration, before ordinary endpoint
        // lowering, so project every primary and fan-out target now.
        const connected = [...(addrIndexFor(path, defId).get(node.id)?.ins ?? []), ...(ctx.extraIn.get(node.id) ?? [])]
        for (const projected of connected) {
          const match = matchBoundaryItem(child.boundary.inputs, projected.address)
          if (!match.ok || match.item.binds.kind !== 'port') continue
          for (const binding of [match.item.binds, ...(match.item.alsoBinds ?? [])]) {
            if (binding.kind === 'widgetTap') continue
            const route = [...projected.route, { graph: child.id, boundaryId: match.item.id, binding }]
            if (routeIsSuppressed(childPath, projected.delivery, route)) continue
            let list = childCtx.extraIn.get(binding.node)
            if (!list) childCtx.extraIn.set(binding.node, (list = []))
            list.push({
              address: { port: binding.port, ...(binding.members ? { members: binding.members } : {}) },
              ...(projected.delivery ? { delivery: projected.delivery } : {}),
              route,
            })
          }
        }
        if (node.region === undefined) pendingPromotions.push({ parentCtx: ctx, node, childId: asGraphDefId(childId) })
        collectNodes(asGraphDefId(childId), childPath, childCtx)
        continue
      }
      const schema = resolveNode(defId, node)
      if (!schema) {
        unresolvedCollected.set(occurrenceKey({ instancePath: path, node: node.id }), node.type)
        diags.push(unknownSchemaDiag(path, node))
        continue
      }
      const occ: Occurrence = { instancePath: path, node: node.id }
      const runtimeId = occurrenceKey(occ)
      const elab = elabAt(ctx, node, schema)
      const selectorInputKey = schema.selector === undefined
        ? undefined
        : elab.inputsByValueKey.get(schema.selector.input)?.spec.id
      const selectorBranchKeys = schema.selector === undefined
        ? undefined
        : {
            false: elab.inputsByValueKey.get(schema.selector.branches.false)?.spec.id,
            true: elab.inputsByValueKey.get(schema.selector.branches.true)?.spec.id,
          }
      flat.set(runtimeId, {
        runtimeId,
        occ,
        graphId: asGraphDefId(defId),
        node,
        elab,
        ...(schema.selector !== undefined ? { selector: schema.selector } : {}),
        ...(selectorInputKey !== undefined ? { selectorInputKey } : {}),
        ...(selectorBranchKeys?.false !== undefined && selectorBranchKeys.true !== undefined
          ? { selectorBranchKeys: { false: selectorBranchKeys.false, true: selectorBranchKeys.true } }
          : {}),
        linkedInputs: new Set(),
        inputs: {},
      })
    }
  }

  collectNodes(doc.root, [], newOccCtx(doc.root, []))

  // -- Pass 1.5: promoted-value overrides (outside-in; first write wins) -----
  //
  // Runs only after EVERY occurrence and crossing exists: a value held by an
  // outer instance for a chained-forwarded member resolves through several
  // crossings, all of which must already be indexed. Both binding kinds use
  // the same resolver links use - one address interpreter, no special path.

  for (const { parentCtx, node, childId } of pendingPromotions) {
    const child = graphOf(childId)
    if (!child?.boundary) continue
    const childPath = [...parentCtx.path, node.id]
    const parentSchema = resolveNode(parentCtx.defId, node)
    const parentElab = parentSchema ? elabAt(parentCtx, node, parentSchema) : undefined
    const ownerOccurrence: Occurrence = { instancePath: parentCtx.path, node: node.id }
    const record = (target: ResolvedInput, v: Json): void => {
      let byInput = overrides.get(target.runtimeId)
      if (!byInput) overrides.set(target.runtimeId, (byInput = new Map()))
      if (!byInput.has(target.elabKey)) byInput.set(target.elabKey, v)
    }
    let hasFamilyItem = false
    for (const item of child.boundary.inputs) {
      if (item.binds.kind !== 'port') {
        hasFamilyItem = true
        continue
      }
      const v = node.values[item.id]
      const ownerInput = item.promoted === true ? parentElab?.inputsByValueKey.get(item.id) : undefined
      if (v === undefined && ownerInput?.spec.widget?.controller !== 'after_generate') continue
      const targetNode = child.nodes[item.binds.node]
      const targetSchema = targetNode && resolveNode(childId, targetNode)
      const selectorRoute = targetSchema && resolveBoundaryRoute(targetSchema, item.binds, 'input')
      if (selectorRoute?.ok && selectorRoute.route.terminal.kind === 'port' && selectorRoute.route.terminal.slot.dynamic?.kind === 'dynamicCombo') continue
      // Fan-out: a promoted value bakes into EVERY bound target (primary
      // and alsoBinds alike) - targets must never diverge under one
      // boundary value.
      let ownerPriority = 0
      for (const b of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (b.kind === 'widgetTap') continue
        const targets = resolveInputPort(childPath, childId, b)
        // Muted/bypassed inner targets compile nothing; a promoted value for
        // them is dormant (bypass forwards connections, never widget values).
        if (!targets || targets === 'muted' || targets === 'bypassed') continue
        for (const target of targets) {
          if (ownerInput !== undefined) {
            recordControllerSource(target, parentCtx.defId, ownerOccurrence, ownerInput, ownerPriority)
          }
          if (v !== undefined) record(target, v)
          ownerPriority += 1
        }
      }
    }
    if (!hasFamilyItem) continue
    // Whole-family forwarding: suffix members live on the INSTANCE, so their
    // widget values (and dependent/branch values beneath them) are stored
    // there under the instance's elaborated keys. ONE pass over the stored
    // values, ONE matcher call per address (F7): a value whose address is
    // ambiguous must fail loudly - silently dropping it would compile the
    // inner default in place of a persisted value.
    if (!parentElab) continue // already diagnosed at collection
    const elab = parentElab
    for (const [key, input] of elab.inputsByValueKey) {
      if (input.apiName === undefined || hasSyntheticAncestor(input.ancestry)) continue
      const v = node.values[key]
      if (v === undefined && input.spec.widget?.controller !== 'after_generate') continue
      const m = matchBoundaryItem(child.boundary.inputs, input.address)
      if (!m.ok) {
        if (v !== undefined && m.code === 'ambiguous') {
          diags.push(diag('error', 'compile', 'compile.boundary.ambiguousAddress', `subgraph '${childId}' value '${key}': ${m.message}`, { anchor: anchorOf(parentCtx.path, node.id) }))
        }
        continue
      }
      // Concrete items were handled above (their values live under the item
      // id itself); only family-owned addresses lower through the resolver.
      if (!isForwardingBinding(m.item.binds)) continue
      const ref: PortRef = { node: node.id, port: input.address.port, ...(input.address.members ? { members: input.address.members } : {}) } as PortRef
      const targets = resolveInputPort(parentCtx.path, parentCtx.defId, ref)
      if (!targets || targets === 'muted' || targets === 'bypassed') continue
      for (const [ownerPriority, target] of targets.entries()) {
        recordControllerSource(target, parentCtx.defId, ownerOccurrence, input, ownerPriority)
        if (v !== undefined) record(target, v)
      }
    }
  }

  // -- Pass 2: values -> overrides -> links (connections beat values) --------

  /**
   * The runtime type of a widget-held literal when it DIFFERS from the
   * input's declared type. Asset-source references stored by an ASSET widget
   * on a concrete
   * NON-asset-reference input have runtime type asset<T> (one ref: decode
   * arm, incl. asset<list<T>> onto a list<T> input) or list<asset<T>> (N
   * refs: merge arm onto scalar T, lift arm onto list<T>), never the
   * declared type. Undefined everywhere else: asset-REFERENCE destinations
   * (bare dinkster.asset, asset<...>, lists of either) receive refs AS-IS per
   * the joint pins - stamping there would route a valid plain delivery into
   * the coercion planner, which has no asset-to-asset vocabulary; non-ASSET
   * widgets and non-ref-shaped values pass through untouched. No scalar-T
   * ASSET binding is schema-expressible today (backend AssetWidget binding
   * policy, 72c0719) - this keeps lowering correct for fixtures and for
   * the ledgered relaxation, with the server planner enforcing anyway.
   */
  const assetSourceTypeOf = (input: ElaboratedInput, value: Json): string | undefined => {
    if (input.spec.widget?.widgetType !== 'ASSET') return undefined
    const dstTypeId = canonicalTypeIdOf(input.spec.type)
    if (dstTypeId === undefined || isAssetRefDestinationTypeId(dstTypeId)) return undefined
    if (isAssetRefValue(value)) return assetTypeId(dstTypeId)
    if (!Array.isArray(value) || value.length === 0 || !value.every(isAssetRefValue)) return undefined
    // N refs: merge arm on a scalar destination (list<asset<T>>), lift arm
    // on a list<T> destination (list<asset<T>> with T = the list element).
    const element = parseListTypeId(dstTypeId)
    return listTypeId(assetTypeId(element ?? dstTypeId))
  }

  /**
   * Lower ONE widget-held literal onto its own declared input: stamp $typed
   * when its runtime type is an asset source differing from the declared
   * type (so the backend's coercion planner sees the source type instead of
   * wrapping refs raw as the declared type), else pass through plain.
   * Stamping needs the typedLiteral capability; without it, REFUSE loudly
   * (error diag, input omitted - returns undefined) instead of silently
   * passing raw refs the server would wrap as the declared type - the same
   * loud-refusal contract as the tap/bypass paths. Unobservable against
   * real servers (a pre-typed-literal backend cannot declare the schemas
   * that reach this arm), but fixtures and the ledgered scalar-T binding
   * relaxation must not silently mis-lower.
   */
  const stagedNodeDiagnostics = new Map<string, Diagnostic[]>()
  const stagedDiagnosticsFor = (fn: FlatNode): Diagnostic[] => {
    let sink = stagedNodeDiagnostics.get(fn.runtimeId)
    if (!sink) stagedNodeDiagnostics.set(fn.runtimeId, (sink = []))
    return sink
  }
  const lowerWidgetLiteral = (
    fn: FlatNode,
    input: ElaboratedInput,
    value: Json,
    sink: Diagnostic[] = diags,
  ): Json | undefined => {
    if (canonicalTypeIdOf(input.spec.type) === 'core.int' && isCanonicalUnsafeInteger(value)) {
      if (emitDecimalInts) return decimalIntegerWire(value)
      sink.push(diag('error', 'compile', 'compile.value.decimalIntUnsupported', `'${fn.node.type}' input '${input.spec.id}' holds an integer outside JavaScript's safe range, but this backend does not support lossless decimal integers; omitted`, { anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port, ...(input.address.members ? { members: input.address.members } : {}) } as PortRef } }))
      return undefined
    }
    const sourceType = assetSourceTypeOf(input, value)
    if (sourceType === undefined) return value
    if (emitTypedLiterals) return typedLiteralWire(sourceType, value) as Json
    sink.push(diag('error', 'compile', 'compile.value.assetSourceUnsupported', `'${fn.node.type}' input '${input.spec.id}' holds asset reference(s) needing an asset-source stamp ('${sourceType}' into '${canonicalTypeIdOf(input.spec.type)}'), but this backend does not support typed literals; omitted`, { anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port, ...(input.address.members ? { members: input.address.members } : {}) } as PortRef } }))
    return undefined
  }

  for (const fn of flat.values()) {
    const nodeDiags = stagedDiagnosticsFor(fn)
    for (const [key, value] of Object.entries(fn.node.values)) {
      const input = fn.elab.inputsByValueKey.get(key)
      if (!input) {
        // Dormant dynamic-scoped values (inactive combo branches, hidden
        // dependents, removed members) are preserved-by-design state, not
        // junk - never warn, never compile.
        if (!isDynamicScopedValueKey(key)) {
          nodeDiags.push(diag('warning', 'compile', 'compile.value.unknownInput', `'${fn.node.type}' value '${key}' matches no schema input; dropped`, { anchor: { occurrence: fn.occ } }))
        }
        continue
      }
      if (input.apiName === undefined) continue
      // Stage under the ELABORATED id (identical to the persisted value key
      // except for '#'/'%'-escaped static ids).
      const lowered = lowerWidgetLiteral(fn, input, value, nodeDiags)
      if (lowered !== undefined) fn.inputs[input.spec.id] = lowered
    }
    const byInput = overrides.get(fn.runtimeId)
    if (byInput) {
      // Indexed once per node, not per override (a heavily promoted node
      // would otherwise scan the input list quadratically).
      const inputsById = new Map(fn.elab.inputs.map((i) => [i.spec.id, i]))
      for (const [inputId, v] of byInput) {
        const input = inputsById.get(inputId)
        if (!input) {
          // Promoted overrides resolve through real input ports, so an id
          // outside the elaborated interface is a compiler invariant
          // violation. Refuse loudly and omit - staging the value raw would
          // ship an un-lowered literal past every stamping rule.
          nodeDiags.push(diag('error', 'compile', 'compile.internal.overrideUnresolved', `internal: promoted override targets unknown input '${inputId}' on '${fn.node.type}'`, { anchor: { occurrence: fn.occ } }))
          continue
        }
        const lowered = lowerWidgetLiteral(fn, input, v, nodeDiags)
        if (lowered !== undefined) fn.inputs[inputId] = lowered
      }
    }
    // Derived values (combo selectors) are authoritative and applied LAST:
    // the elaborated interface (which branch inputs exist) was computed FROM
    // this selection, so nothing - not even a promoted override - may
    // contradict it in the prompt. Occurrence-level selector overrides need
    // occurrence-state forwarding to re-elaborate first.
    for (const input of fn.elab.inputs) {
      if (input.derivedValue !== undefined && input.apiName !== undefined) {
        fn.inputs[input.spec.id] = input.derivedValue
      }
    }
  }

  /** Resolve a tap without treating bypass as erasing the node's document value. */
  const tappedInputs = (
    path: readonly NodeId[],
    defId: string,
    nodeId: NodeId,
    inputId: string,
    sink: Diagnostic[] = diags,
  ): readonly ResolvedInput[] | 'muted' | undefined => {
    const ref: PortRef = { node: nodeId, port: inputId as PortRef['port'] }
    const resolved = resolveInputPort(path, defId, ref, sink)
    if (resolved !== 'bypassed') return resolved
    // Bypass changes dataflow only. The bypassed node itself is absent from
    // `flat`, so recover its occurrence-aware elaborated input directly and
    // use the same staged-value precedence below.
    const node = graphOf(defId)?.nodes[nodeId]
    const schema = node && resolveNode(defId, node)
    const ctx = occCtxByPath.get(pathKey(path))
    const input = node && schema
      ? (ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)).inputsByAddr.get(portAddressKey(ref.port, ref.members))
      : undefined
    if (!node || !input) return undefined
    return [{ runtimeId: occurrenceKey({ instancePath: path, node: nodeId }), elabKey: input.spec.id, input }]
  }

  /**
   * The value a tap delivers PLUS the tapped input's canonical type id -
   * the stamp a $typed lowering wraps the literal with when the destination
   * is not concrete-typed (compile.tap.nonConcrete already guarantees the
   * SOURCE type is known, so typeId is never a guess).
   */
  const tapValue = (
    path: readonly NodeId[],
    defId: string,
    nodeId: NodeId,
    inputId: string,
    sink: Diagnostic[] = diags,
  ): { readonly value: Json; readonly typeId: string } | 'muted' | undefined => {
    const inputs = tappedInputs(path, defId, nodeId, inputId, sink)
    if (inputs === 'muted') return 'muted'
    if (!inputs || inputs.length === 0) return undefined
    const input = inputs[0]!
    const typeId = canonicalTypeIdOf(input.input.spec.type)
    if (typeId === undefined) return undefined
    // The value's TRUE runtime type, not blindly the tapped input's declared
    // type: a staged value may already carry an asset-source stamp (the
    // scalar-T decode/merge arms lower through lowerWidgetLiteral before
    // links) - unwrap it instead of double-wrapping; raw stored/override/
    // fallback refs on those inputs re-derive the same source type.
    const staged = flat.get(input.runtimeId)?.inputs[input.elabKey]
      ?? overrides.get(input.runtimeId)?.get(input.elabKey)
    if (staged !== undefined) {
      const decimalInteger = parseDecimalIntegerWire(staged)
      if (decimalInteger !== undefined) return { value: decimalInteger, typeId: 'core.int' }
      const stamped = parseTypedLiteralWire(staged)
      if (stamped !== undefined) return { value: stamped.value, typeId: stamped.type }
      return { value: staged, typeId: assetSourceTypeOf(input.input, staged) ?? typeId }
    }
    const node = graphOf(defId)?.nodes[nodeId]
    const stored = node?.values?.[valueKeyOf(input.input)]
    if (stored !== undefined) return { value: stored, typeId: assetSourceTypeOf(input.input, stored) ?? typeId }
    // Schema default, then the widget kind's intrinsic value - a tapped INT
    // widget showing 0 taps as 0; only kinds with no intrinsic value (ASSET,
    // remote COMBO, ...) leave the tap valueless.
    const widget = input.input.spec.widget
    const fallback = widget ? effectiveWidgetDefault(widget) : undefined
    return fallback === undefined ? undefined : { value: fallback, typeId: assetSourceTypeOf(input.input, fallback) ?? typeId }
  }

  for (const { defId, path } of graphOccurrences) {
    const def = graphOf(defId)
    if (!def) continue
    // Resolve selector policies EAGERLY (not just when a link traces through
    // one): policy problems are compile errors even for unconsumed selectors.
    selectorResolutionFor(defId)
    const rerouteIndex = rerouteIndexFor(path, defId)
    const connections: { from: LinkEndpoint; to: PortRef; what: string; delivery?: ParentDeliveryIdentity }[] = []
    const recordWouldRunConnection = (from: LinkEndpoint, to: PortRef, delivery?: ParentDeliveryIdentity): void => {
      if (!wouldRunVia || !wouldRunInputEdges) return
      const scratch: Diagnostic[] = []
      const dsts = resolveInputPort(path, defId, to, scratch, delivery)
      const live = dsts !== undefined && dsts !== 'muted' && dsts !== 'bypassed'
        ? dsts.filter((d) => flat.has(d.runtimeId))
        : []
      for (const destination of live) {
        let byInput = wouldRunInputEdges.get(destination.runtimeId)
        if (!byInput) wouldRunInputEdges.set(destination.runtimeId, (byInput = new Map()))
        let producers = byInput.get(destination.elabKey)
        if (!producers) byInput.set(destination.elabKey, (producers = new Set()))
        const vias = new Map<string, TraceVia>()
        const viaFor = (routeDefId: string): TraceVia => {
          let via = vias.get(routeDefId)
          if (!via) vias.set(routeDefId, (via = { reroutes: new Set(), selectors: new Map(), valueSources: new Set() }))
          return via
        }
        const all = projectRoute({ kind: 'endpoint', path, defId, endpoint: from }, 'would-run', scratch, destination.input.spec.type, viaFor, delivery)
        const connections = wouldRunVia.get(destination.runtimeId)
        const recorded = [...vias].map(([routeDefId, via]) => ({ defId: routeDefId, via }))
        const record = { inputKey: destination.elabKey, entries: recorded }
        if (connections) connections.push(record)
        else wouldRunVia.set(destination.runtimeId, [record])
        let anyCandidateDelivers = false
        for (const terminal of all) {
          if (terminal.kind === 'value') { anyCandidateDelivers = true; continue }
          if (terminal.kind !== 'output') continue
          anyCandidateDelivers = true
          if (!flat.has(terminal.src.runtimeId)) continue
          producers.add(terminal.src.runtimeId)
        }
        if (anyCandidateDelivers) recordSuccessfulDelivery(destination)
      }
    }
    for (const connection of topologyFor(path, defId)) {
      const link = connection
      if (isWidgetTapRef(link.from)) {
        const tapped = tappedInputs(path, defId, link.from.node, link.from.tap, [])
        if (!tapped) {
          diags.push(diag('error', 'compile', 'compile.tap.missingInput', `widget tap '${link.from.node}.${link.from.tap}' in graph '${defId}' names a missing input; ${link.what} omitted`))
          continue
        }
        if (tapped !== 'muted' && tapped.some((i) => canonicalTypeIdOf(i.input.spec.type) === undefined)) {
          diags.push(diag('error', 'compile', 'compile.tap.nonConcrete', `widget tap '${link.from.node}.${link.from.tap}' in graph '${defId}' has a non-concrete input type; ${link.what} omitted`))
          continue
        }
      }
      // Reroutes lower away: links INTO a reroute are structural feeds
      // (consumed when tracing), links FROM one trace to the real producer.
      if (isRerouteRef(link.to)) continue
      if (isSelectorRef(link.to)) {
        // Candidate feeds are structural like reroute feeds (consumed when
        // tracing through the selector); targeting the OUTPUT is illegal by
        // I11 - surface malformed documents rather than mis-lowering.
        if (link.to.candidate === undefined) {
          diags.push(diag('error', 'compile', 'compile.link.invalidTarget', `${link.what} in graph '${defId}' targets a selector output; selector outputs have no inputs`))
        }
        continue
      }
      if (isValueSourceRef(link.to)) {
        // Illegal by I10 (value sources produce, never consume); malformed
        // documents surface it rather than silently mis-lowering.
        diags.push(diag('error', 'compile', 'compile.link.invalidTarget', `${link.what} in graph '${defId}' targets a value source; value sources have no inputs`))
        continue
      }
      if (isWidgetTapRef(link.to)) {
        diags.push(diag('error', 'compile', 'compile.link.invalidTarget', `${link.what} in graph '${defId}' targets a widget tap; widget taps have no inputs`))
        continue
      }
      // Would-run recording happens before exact lowering and uses the same
      // route engine. Hypothetical branches write no diagnostics.
      if (!isPortEndpoint(link.to)) continue
      recordWouldRunConnection(link.from, link.to, link.delivery)
      connections.push({ from: link.from, to: link.to, what: link.what, ...(link.delivery ? { delivery: link.delivery } : {}) })
    }
    for (const c of connections) {
      // Both endpoints resolve into a SCRATCH sink: if either end is muted
      // the edge is dead and NOTHING about it is audited (symmetric policy -
      // see the resolver comment); otherwise the scratch diagnostics of both
      // ends surface together. A bypassed producer re-routes through the
      // passthrough trace first; a trace that dies at a muted node makes the
      // edge dead exactly like a directly muted producer.
      const scratch: Diagnostic[] = []
      const dsts = resolveInputPort(path, defId, c.to, scratch, c.delivery)
      const regionPseudoRef = isPortEndpoint(c.from) && c.from.node === DINKSTER_REGION_PSEUDO_NODE ? c.from : undefined
      const enclosingRegion = regionPseudoRef !== undefined
        ? [...regions.values()].find((region) => region.childId === defId && pathKey(region.childPath) === pathKey(path))
        : undefined
      const regionIndexRef = regionPseudoRef?.port === 'index' && regionPseudoRef.members === undefined && enclosingRegion !== undefined
        ? regionPseudoRef
        : undefined
      if (regionPseudoRef !== undefined && regionIndexRef === undefined) {
        scratch.push(diag('error', 'compile', 'compile.region.invalidIndex', `'$region.${regionPseudoRef.port}' is available only as the immediate region index source`))
      }
      const structuralSrc = isPortEndpoint(c.from) && regionPseudoRef === undefined
        ? resolveOutputPort(path, defId, c.from, scratch, c.delivery)
        : undefined
      if (structuralSrc === 'muted' || dsts === 'muted') {
        diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}' touches a muted node; omitted`))
        continue
      }
      // Bypassed consumer: consumed by passthrough (or dormant) - silent.
      if (dsts === 'bypassed') continue
      // An unresolved producer is fatal only if one of these consumers
      // executes; record them before the scratch diagnostics surface.
      if (Array.isArray(dsts)) attachUnknownSchemaDependents(scratch, dsts.map((destination) => destination.runtimeId))
      diags.push(...scratch)
      // Ordinary port sources were resolved above so malformed source
      // diagnostics are emitted once per connection, not once per fanout
      // destination. Transparent endpoints still route per final consumer.
      if (!dsts || (isPortEndpoint(c.from) && !structuralSrc && regionIndexRef === undefined)) continue
      for (const dst of dsts) {
        if (regionIndexRef !== undefined) {
          const consumer = flat.get(dst.runtimeId)
          if (!consumer) continue
          consumer.inputs[dst.elabKey] = { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'index' } }
          consumer.linkedInputs.add(dst.elabKey)
          recordSuccessfulDelivery(dst)
          continue
        }
        // A boundary item may fan one outer edge into differently typed final
        // consumers. Route independently for each destination so bypass
        // matching always sees that destination's declared type.
        const routeDiagnostics: Diagnostic[] = []
        let src: ResolvedOutput | undefined
        let baked: { readonly value: Json; readonly typeId?: string } | undefined
        const routedRandomSelectors = new Set<string>()
        if (structuralSrc && !('bypass' in structuralSrc) && !('widgetTap' in structuralSrc)) {
          src = structuralSrc
        } else {
          const routeStart: RouteAt = structuralSrc
            ? 'bypass' in structuralSrc
              ? { kind: 'bypass', bypass: structuralSrc.bypass }
              : { kind: 'endpoint', ...structuralSrc.widgetTap }
            : { kind: 'endpoint', path, defId, endpoint: c.from }
          const viaFor = (routeDefId: string): TraceVia => ({
            reroutes: new Set(),
            selectors: new Map([...Object.values(graphOf(routeDefId)?.selectors ?? {})]
              .filter((selector) => selector.policy.kind === 'random')
              .map((selector) => [selector.id, routedRandomSelectors])),
            valueSources: new Set(),
          })
          const trace = projectRoute(routeStart, 'exact', routeDiagnostics, dst.input.spec.type, viaFor, c.delivery)[0] ?? { kind: 'dropped', reason: 'route produced no terminal' }
          if (routedRandomSelectors.size > 0) {
            let inputs = randomSelectorInputs.get(dst.runtimeId)
            if (!inputs) randomSelectorInputs.set(dst.runtimeId, (inputs = new Set()))
            inputs.add(dst.elabKey)
          }
          attachUnknownSchemaDependents(routeDiagnostics, [dst.runtimeId])
          if (trace.kind === 'muted') {
            diags.push(...routeDiagnostics)
            diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}' touches a muted node; omitted`))
            continue
          }
          if (trace.kind === 'dropped') {
            diags.push(...routeDiagnostics)
            continue
          }
          if (trace.kind === 'value') {
            baked = { value: trace.value, ...(trace.typeId !== undefined ? { typeId: trace.typeId } : {}) }
          } else src = trace.src
        }
        diags.push(...routeDiagnostics)
        if (src && !flat.has(src.runtimeId)) {
          diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}' touches a dropped node; omitted`))
          continue
        }
        const consumer = flat.get(dst.runtimeId)
        if (!consumer) {
          diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}' touches a dropped node; omitted`))
          continue
        }
        if (baked !== undefined) {
          // Passthrough traced to a value source or tap value: bake, same
          // precedence as a connection through one delivery path with no
          // write-through). Same typed-literal lowering as the direct
          // tapValue path - non-concrete destination OR an asset-source
          // runtime type differing from the concrete declared type (the
          // asset-reference destinations exempt, refs
          // deliver AS-IS): stamp when the capability AND a source type are
          // known (tap fallbacks always carry one; value sources declare no
          // runtime type - no guessing, per the joint contract), else
          // refuse loudly instead of failing at the server.
          const dstTypeId = canonicalTypeIdOf(dst.input.spec.type)
          if (isCanonicalUnsafeInteger(baked.value)) {
            if (baked.typeId === 'core.int' && dstTypeId === 'core.int') {
              const lowered = lowerWidgetLiteral(consumer, dst.input, baked.value)
              if (lowered !== undefined) {
                consumer.inputs[dst.elabKey] = lowered
                consumer.linkedInputs.delete(dst.elabKey)
                recordSuccessfulDelivery(dst)
              }
            } else {
              diags.push(diag('error', 'compile', 'compile.tap.decimalIntNonConcreteTarget', `${c.what} in graph '${defId}' bakes an integer outside JavaScript's safe range into '${consumer.node.type}' input '${dst.input.spec.id}', but the lossless integer marker requires a concrete core.int destination; omitted`, { anchor: { occurrence: consumer.occ, port: { node: consumer.occ.node, port: dst.input.address.port, ...(dst.input.address.members ? { members: dst.input.address.members } : {}) } as PortRef } }))
            }
            continue
          }
          if (dstTypeId === undefined ||
            (baked.typeId !== undefined && isAssetSourceTypeId(baked.typeId) &&
              baked.typeId !== dstTypeId && !isAssetRefDestinationTypeId(dstTypeId))) {
            if (emitTypedLiterals && baked.typeId !== undefined) {
              consumer.inputs[dst.elabKey] = typedLiteralWire(baked.typeId, baked.value)
              consumer.linkedInputs.delete(dst.elabKey)
              recordSuccessfulDelivery(dst)
              continue
            }
            diags.push(diag('error', 'compile', 'compile.tap.nonConcreteTarget', `${c.what} in graph '${defId}' bakes a literal into '${consumer.node.type}' input '${dst.input.spec.id}', which ${dstTypeId === undefined ? 'is not concrete-typed; literals need a concrete-typed input' : `needs an asset-source stamp ('${baked.typeId}' into '${dstTypeId}')`} (${baked.typeId === undefined ? 'the literal declares no runtime type to stamp' : 'this backend does not support typed literals'}); omitted`, { anchor: { occurrence: consumer.occ, port: { node: consumer.occ.node, port: dst.input.address.port, ...(dst.input.address.members ? { members: dst.input.address.members } : {}) } as PortRef } }))
            continue
          }
          consumer.inputs[dst.elabKey] = baked.value
          consumer.linkedInputs.delete(dst.elabKey)
          recordSuccessfulDelivery(dst)
          continue
        }
        if (!src) continue // unreachable (guarded above); narrows the type
        consumer.inputs[dst.elabKey] = [src.runtimeId, src.outputIndex] as const
        consumer.linkedInputs.add(dst.elabKey)
        recordSuccessfulDelivery(dst)
      }
    }
  }

  // Region boundary inputs are body-local reads from the reserved pseudo
  // node. Resolve each boundary item through the same crossing and fan-out
  // machinery as ordinary parent deliveries, but open only this region so a
  // nested region remains an opaque entry in its enclosing body.
  for (const region of regions.values()) {
    const child = graphOf(region.childId)
    if (!child?.boundary) continue
    for (const item of child.boundary.inputs) {
      const targets = resolveInputPort(
        region.occ.instancePath,
        region.parentDefId,
        { node: region.node.id, port: item.id as PortRef['port'] },
        diags,
        undefined,
        [],
        region.runtimeId,
      )
      if (!targets || targets === 'muted' || targets === 'bypassed') continue
      for (const target of targets) {
        const bodyNode = flat.get(target.runtimeId)
        if (!bodyNode) continue
        if (bodyNode.elab.outputCountInputs.has(target.input.address.port)) {
          diags.push(diag('error', 'compile', 'compile.outputFamily.linkedCount', `region input '${item.id}' targets output schema input '${bodyNode.node.type}.${target.input.address.port}', which must store a literal`, {
            anchor: { occurrence: bodyNode.occ, port: { node: bodyNode.occ.node, port: target.input.address.port as PortRef['port'] } },
          }))
          continue
        }
        bodyNode.inputs[target.elabKey] = {
          $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: item.id },
        }
        bodyNode.linkedInputs.add(target.elabKey)
        recordSuccessfulDelivery(target)
      }
    }
  }

  // -- Scope: full = closure of output nodes; partial = closure of targets ---

  // A lazy selector's decision may be document state or link-fed. Stored
  // booleans project the inactive branch, with promoted occurrence values
  // outranking definition-local values. Link-fed decisions stay neutral:
  // The backend resolves them at runtime, and stale stored values must not prune
  // either would-run branch. Defaults and non-booleans also remain neutral.
  // This projection never mutates fn.inputs.
  if (wouldRun) {
    for (const fn of flat.values()) {
      if (!fn.selector || !fn.selectorInputKey || !fn.selectorBranchKeys) continue
      if (fn.linkedInputs.has(fn.selectorInputKey)) continue
      const promoted = overrides.get(fn.runtimeId)
      const choice = promoted?.has(fn.selectorInputKey)
        ? promoted.get(fn.selectorInputKey)
        : fn.node.values?.[fn.selector.input]
      if (typeof choice !== 'boolean') continue
      fn.selectorProjection = { choice, branches: fn.selectorBranchKeys }
    }
  }

  let included: ReadonlySet<string>
  let successfulDestinations: ReadonlyMap<string, readonly PortAddress[]>
  let inactiveExclusive: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  let partialTargets: readonly string[] | undefined
  let dinksterTargets: readonly string[] | undefined
  // A full compile of a graph with no resolved output node is degenerate: it
  // cannot execute, `included` is a keep-everything diagnostic surface (see
  // below), and an unresolved node may itself be the missing output. Such
  // graphs keep unresolved-schema errors standing instead of demoting them.
  let demoteOutOfScopeUnknownSchema = true
  const enclosingRegionRuntimeId = (runtimeId: string): string => {
    const fn = flat.get(runtimeId)
    if (!fn) return runtimeId
    const outer = [...regions.values()]
      .filter((region) => fn.occ.instancePath.length >= region.childPath.length &&
        region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment))
      .sort((a, b) => a.childPath.length - b.childPath.length)[0]
    return outer?.runtimeId ?? runtimeId
  }
  if (scope.kind === 'full') {
    // 'full' = all output nodes (artifact contract), i.e. their upstream
    // closure. Anything unreachable from an output node - a disconnected
    // chain, an UNCHOSEN selector branch - must not enter the executed
    // closure: the server would prune it anyway, and controller/seed
    // advancement keys off `included` (out-of-scope seeds stay untouched).
    // Degenerate graphs with NO output nodes keep everything: they cannot
    // execute at all, and pruning to nothing would only hide the real
    // problem from diagnostics.
    const roots = [...flat.values()]
      .filter((fn) => {
        const region = regions.get(fn.runtimeId)
        return (region ? resolveNode(region.parentDefId, fn.node) : resolve(fn.node.type))?.isOutputNode
      })
      .map((fn) => fn.runtimeId)
    const derived = liveness.derive(flat, roots.length > 0 ? roots : [...flat.keys()], wouldRunInputEdges)
    successfulDestinations = derived.successfulDestinations
    included = roots.length > 0 ? derived.included : new Set(flat.keys())
    if (roots.length === 0) demoteOutOfScopeUnknownSchema = false
    inactiveExclusive = derived.inactiveExclusive
    if (regions.size > 0) {
      dinksterTargets = roots.filter((runtimeId) => {
        const fn = flat.get(runtimeId)
        return fn !== undefined && ![...regions.values()].some((region) =>
          fn.occ.instancePath.length >= region.childPath.length &&
          region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment))
      })
    }
  } else {
    const targets = scope.targets.map(occurrenceKey)
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const t = targets[targetIndex]!
      if (!flat.has(t)) {
        const occurrence = scope.targets[targetIndex]!
        const unresolvedType = unresolvedCollected.get(t)
        if (unresolvedType !== undefined) {
          // The target names a real node whose schema does not resolve:
          // report the actual problem, not a missing target. Explicitly
          // targeting the unresolved node keeps it fatal.
          diags.push(diag('error', 'compile', 'compile.schema.unknown', `unknown node type '${unresolvedType}'`, { anchor: { occurrence }, data: { nodeType: unresolvedType } }))
          continue
        }
        let defId: string = doc.root
        let inactive: { node: string; mode: 'muted' | 'bypassed' } | undefined
        for (const instanceId of occurrence.instancePath) {
          const instance = graphOf(defId)?.nodes[instanceId]
          if (!instance) break
          if (instance.mode === 'muted' || instance.mode === 'bypassed') {
            inactive = { node: instance.id, mode: instance.mode }
            break
          }
          const childId = subgraphDefIdOf(instance.type)
          if (!childId) break
          defId = childId
        }
        diags.push(inactive
          ? diag('error', 'compile', 'compile.scope.inactiveAncestor', `partial-execution target '${t}' is inside ${inactive.mode} subgraph instance '${inactive.node}' and cannot execute`)
          : diag('error', 'compile', 'compile.scope.missingTarget', `partial-execution target '${t}' is not in the compiled graph`))
      }
    }
    const nativeTargets = targets.map(enclosingRegionRuntimeId)
    const derived = liveness.derive(flat, nativeTargets, wouldRunInputEdges)
    successfulDestinations = derived.successfulDestinations
    included = derived.included
    inactiveExclusive = derived.inactiveExclusive
    partialTargets = targets
    if (regions.size > 0) {
      dinksterTargets = [...new Set(nativeTargets)]
    }
  }

  if (regions.size > 0) {
    const expanded = new Set(included)
    for (const fn of flat.values()) {
      if (!expanded.has(fn.runtimeId)) continue
      for (const region of regions.values()) {
        if (fn.occ.instancePath.length >= region.childPath.length &&
          region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment)) {
          expanded.add(region.runtimeId)
        }
      }
    }
    for (const region of regions.values()) {
      if (!expanded.has(region.runtimeId)) continue
      for (const fn of flat.values()) {
        if (fn.occ.instancePath.length >= region.childPath.length &&
          region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment)) {
          expanded.add(fn.runtimeId)
        }
      }
    }
    included = expanded
  }

  // The executed scope is final: unresolved-schema diagnostics whose
  // consumers all fall outside it demote to warnings, so a stray unresolved
  // node no longer blocks the runnable rest of the document.
  if (demoteOutOfScopeUnknownSchema) settleUnknownSchema(included)

  // Several passes report the same unresolved occurrence (collection, link
  // lowering, per-destination routing), each with its own copy so severity
  // can settle per consumer. One entry per occurrence is enough for the
  // result; when the settled copies disagree the fatal one wins.
  const unknownByOccurrence = new Map<string, Diagnostic>()
  const dedupedDiags = diags.filter((diagnostic) => {
    if (diagnostic.code !== 'compile.schema.unknown' || !diagnostic.anchor?.occurrence) return true
    const key = occurrenceKey(diagnostic.anchor.occurrence)
    const kept = unknownByOccurrence.get(key)
    if (!kept) {
      unknownByOccurrence.set(key, diagnostic)
      return true
    }
    if (kept.severity !== 'error' && diagnostic.severity === 'error') {
      ;(kept as { severity: Diagnostic['severity'] }).severity = 'error'
    }
    return false
  })
  diags.length = 0
  diags.push(...dedupedDiags)

  const includedRegions = [...regions.values()].filter((region) => included.has(region.runtimeId))
  // dinksterTargets is paired with dinksterGraph: an artifact whose regions are all
  // excluded from scope keeps the ordinary region-free shape.
  if (includedRegions.length === 0) dinksterTargets = undefined
  if (!emitRegions) {
    for (const region of includedRegions) {
      diags.push(diag(
        'error',
        'compile',
        'compile.region.backendUnsupported',
        'this backend does not advertise first-class region execution support',
        { anchor: { occurrence: region.occ } },
      ))
    }
  }
  const validatesNode = (runtimeId: string): boolean =>
    scope.kind === 'full' || included.has(runtimeId)
  if (scope.kind === 'partial') {
    const includedDefinitionNodes = new Set(
      [...flat.values()]
        .filter((fn) => included.has(fn.runtimeId))
        .map((fn) => JSON.stringify([fn.graphId, fn.node.id])),
    )
    const scoped = diags.filter((diagnostic) => {
      const owner = elaborationDiagnosticOwners.get(diagnostic)
      if (owner === undefined) return true
      return owner.runtimeId !== undefined
        ? included.has(owner.runtimeId)
        : includedDefinitionNodes.has(JSON.stringify([owner.graphId, owner.nodeId]))
    })
    diags.length = 0
    diags.push(...scoped)
  }
  if (diags.some((diagnostic) => diagnostic.severity === 'error')) {
    return { result: { ok: false, diagnostics: diags } }
  }

  // Full compile validates every flattened node, including disconnected
  // non-output nodes. Partial compile validates only the nodes
  // that can execute. Staging diagnostics were buffered because staging must
  // precede closure construction (taps and links consume staged literals).
  // The backend accepts link-fed selector decisions as runtime selectors;
  // stored decisions are still lowered and pruned server-side. The frontend
  // deliberately does not pre-refuse either form. An incompatible backend returns a
  // structured lowering problem, so an incompatible submission stays visible.
  for (const [runtimeId, staged] of stagedNodeDiagnostics) {
    if (validatesNode(runtimeId)) diags.push(...staged)
  }

  // -- Pass 3: widget defaults + required-input checks ------------------------
  //
  // Scope is known before node-local validation: a partial compile must not
  // report or block on inputs of nodes that cannot execute. Link lowering
  // remains earlier because its staged producer references are what define
  // the upstream closure (and its structural diagnostics are needed to
  // explain a broken in-scope path).

  for (const fn of flat.values()) {
    if (!validatesNode(fn.runtimeId)) continue
    for (const input of fn.elab.inputs) {
      if (input.apiName === undefined) continue // never reaches the prompt
      const spec = input.spec
      if (fn.inputs[spec.id] !== undefined) continue
      if (spec.hidden === true) continue
      if (spec.widget) {
        // Explicit schema default first, then the widget kind's intrinsic
        // value (an INT shows 0/min, a STRING shows '', ...): what the
        // canvas visibly displays is what executes. Kinds without an
        // intrinsic value (ASSET, remote COMBO, ...) fall through to the
        // missing-input warning - those genuinely need the user. A purely
        // INTRINSIC value is synthesized only when a declared default exists
        // or the input is REQUIRED: an optional widget input with no schema
        // default was always omitted from the prompt and stays omitted (the
        // backend's own default applies - inventing 0/''/false would change
        // valid workflows that never warned).
        const fallback = effectiveWidgetDefault(spec.widget)
        if (fallback !== undefined && (spec.widget.default !== undefined || !spec.optional)) {
          const lowered = lowerWidgetLiteral(fn, input, fallback)
          if (lowered !== undefined) fn.inputs[spec.id] = lowered
          // A refused fallback already errored; the missing-input warning
          // below would only restate it as noise.
          continue
        }
      }
      if (!spec.optional) {
        // Server-side validation is authoritative; surface early as a warning.
        diags.push(diag('warning', 'compile', 'compile.input.missing', `'${fn.node.type}' required input '${spec.id}' has no value or connection`, {
          blocksExecution: true,
          anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port, ...(input.address.members ? { members: input.address.members } : {}) } as PortRef },
        }))
      }
    }
  }

  // Native DynamicCombo choices are document state. Although elaboration
  // displays the first option for a legacy document with no state, compile
  // must not claim that derived fallback as stored schema/cache identity.
  for (const fn of flat.values()) for (const input of fn.elab.inputs) {
    if (!included.has(fn.runtimeId)) continue
    if (input.origin.kind !== 'selector' || !input.wire15Materialization || input.apiName === undefined) continue
    if (input.origin.selected !== undefined) continue
    diags.push(diag(
      'error',
      'compile',
      'compile.combo.missingChoice',
      `'${fn.node.type}' DynamicCombo '${input.origin.construct}' has no stored choice`,
      { anchor: { occurrence: fn.occ } },
    ))
  }
  // Settled DynamicSlot contract (Dinkster c2ac572, schema wire v6): the stored
  // variant choice is authoritative for the backend's elaborated interface,
  // traveling once per node as the graph wire's 'slotVariants' object. A
  // variant-carrying slot that participates in the prompt (linked or valued)
  // without a valid stored choice cannot lower - the backend elaborates the
  // interface FROM the choice, so submitting would bounce off elaboration
  // (missing/unknown-key are deterministic elaboration-failed errors there).
  // Surface that early and anchored instead.
  for (const fn of flat.values()) for (const input of fn.elab.inputs) {
    if (!validatesNode(fn.runtimeId)) continue
    if (input.origin.kind !== 'slot' || !input.origin.variants?.length) continue
    if (fn.inputs[input.spec.id] === undefined) continue
    const selected = input.origin.selected
    if (selected !== undefined && input.origin.variants.some((v) => v.key === selected)) continue
    diags.push(diag('error', 'compile', 'compile.slot.missingVariant',
      selected === undefined
        ? `'${fn.node.type}' DynamicSlot '${input.origin.construct}' is connected but has no stored variant choice; the backend elaborates the interface from the stored choice`
        : `'${fn.node.type}' DynamicSlot '${input.origin.construct}' stores unknown variant '${selected}' (declared: ${input.origin.variants.map((v) => v.key).join(', ')})`,
      { anchor: { occurrence: fn.occ } }))
  }

  const errors = diags.filter((d) => d.severity === 'error')
  if (errors.length > 0) return { result: { ok: false, diagnostics: diags } }

  // -- Assemble artifact -------------------------------------------------------

  const nativeOutputId = (runtimeId: string, output: ElaboratedOutput): string =>
    regions.get(runtimeId)?.stateOutputAliases.get(output.spec.id) ?? output.backendId ?? output.spec.id
  const prompt: Record<string, PromptNode> = {}
  const toSource: Record<string, string> = {}
  const fromSource: Record<string, string[]> = {}
  const inputSources: Record<string, Record<string, PortRef>> = {}
  const outputAliases: Record<string, Record<string, string>> = {}
  const dynamicPromptInputs: Record<string, string[]> = {}
  const controllerInputs: ControllerInputProvenance[] = []
  const dynamicComboInputs = new Map<string, Set<string>>()
  for (const fn of flat.values()) {
    if (!included.has(fn.runtimeId)) continue
    // Staging keys are elaborated ids (document identity); the prompt is
    // keyed by apiName (wire identity). For static inputs they coincide, so
    // golden prompts are unchanged; dynamic members remap to their positional
    // wire names here and ONLY here (api names are compiler output, never
    // identity).
    const inputs: Record<string, Json | readonly [string, number]> = {}
    const sourceInputs: Record<string, PortRef> = {}
    const dynamicInputs: string[] = []
    let viewGraphId: string = doc.root
    for (const instanceId of fn.occ.instancePath) {
      const childId = subgraphDefIdOf(doc.graphs[viewGraphId]?.nodes[instanceId]?.type ?? '')
      if (childId === undefined) break
      viewGraphId = childId
    }
    const selectedViews = doc.view.graphs[viewGraphId]?.nodes[fn.occ.node]?.views
    // Per-node stored dynamic choices (graph wire 'slotVariants'). DynamicCombo
    // selectors remain flat inputs in the compatibility prompt; DynamicSlot
    // choices travel only while their slot participates in the prompt.
    const slotVariants: Record<string, string> = {}
    const successful = new Set(
      (successfulDestinations.get(fn.runtimeId) ?? [])
        .map((address) => portAddressKey(address.port, address.members)),
    )
    for (const input of fn.elab.inputs) {
      if (input.apiName === undefined) continue
      const widget = input.spec.widget
      if (widget?.controller === 'after_generate') {
        const sources = [...(controllerSources.get(fn.runtimeId)?.get(input.spec.id) ?? [])]
        const terminal: ControllerSource = {
          source: { graph: fn.graphId, occurrence: fn.occ, valueKey: valueKeyOf(input) },
          widget,
          ownerPriority: 0,
        }
        if (!sources.some((candidate) =>
          candidate.source.graph === terminal.source.graph &&
          candidate.source.occurrence.node === terminal.source.occurrence.node &&
          candidate.source.valueKey === terminal.source.valueKey)) sources.push(terminal)
        controllerInputs.push({
          runtimeId: fn.runtimeId,
          terminal: terminal.source,
          sources: sources.map((source) => source.source),
          ownerPriority: sources[0]?.ownerPriority ?? 0,
          widget: sources[0]?.widget ?? widget,
          optional: input.spec.optional,
          driven: successful.has(portAddressKey(input.address.port, input.address.members)),
        })
      }
      const submissionName = input.wire15Materialization ? input.address.port : input.apiName
      sourceInputs[submissionName] = {
        node: fn.occ.node,
        port: input.address.port as PortRef['port'],
        ...(input.address.members === undefined ? {} : { members: input.address.members }),
      }
      const v = fn.inputs[input.spec.id]
      if (v !== undefined && input.wire15Materialization && fn.linkedInputs.has(input.spec.id) &&
        !successful.has(portAddressKey(input.address.port, input.address.members))) continue
      if (v !== undefined) {
        inputs[submissionName] = v
        const widget = input.spec.widget
        if (widget !== undefined &&
            resolveWidgetRepresentation(widget, selectedViews?.[valueKeyOf(input)]).spec.options['dynamicPrompts'] === true) {
          dynamicInputs.push(submissionName)
        }
      }
      if (input.origin.kind === 'selector' && input.wire15Materialization && input.origin.selected !== undefined) {
        slotVariants[submissionName] = input.origin.selected
        let selectors = dynamicComboInputs.get(fn.runtimeId)
        if (!selectors) dynamicComboInputs.set(fn.runtimeId, (selectors = new Set()))
        selectors.add(submissionName)
      }
      if (v !== undefined && input.origin.kind === 'slot') {
        const selected = input.origin.selected
        if (selected !== undefined && input.origin.variants?.some((c) => c.key === selected)) {
          slotVariants[submissionName] = selected
        }
      }
    }
    for (const { path, value } of fn.elab.submissionValues) {
      inputs[path] = value
      sourceInputs[path] = { node: fn.occ.node, port: path as PortRef['port'] }
    }
    prompt[fn.runtimeId] = {
      class_type: fn.node.type,
      inputs,
      outputIds: fn.elab.outputs.filter((output) => output.wireable !== false)
        .map((output) => nativeOutputId(fn.runtimeId, output)),
      ...(fn.elab.outputMembers ? { outputMembers: fn.elab.outputMembers } : {}),
      ...(Object.keys(slotVariants).length > 0 ? { slotVariants } : {}),
    }
    const occKey = occurrenceKey(fn.occ)
    toSource[fn.runtimeId] = occKey
    inputSources[fn.runtimeId] = sourceInputs
    if (dynamicInputs.length > 0) dynamicPromptInputs[fn.runtimeId] = dynamicInputs
    ;(fromSource[occKey] ??= []).push(fn.runtimeId)
    const aliases = regions.get(fn.runtimeId)?.stateOutputAliases
    if (aliases !== undefined && aliases.size > 0) outputAliases[fn.runtimeId] = Object.fromEntries(aliases)
  }

  const ownerRegionOf = (fn: FlatNode): RegionLowering | undefined => {
    let owner: RegionLowering | undefined
    for (const region of regions.values()) {
      if (fn.occ.instancePath.length < region.childPath.length) continue
      if (!region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment)) continue
      if (owner === undefined || region.childPath.length > owner.childPath.length) owner = region
    }
    return owner
  }
  const localRuntimeId = (runtimeId: string, scopeRegion?: RegionLowering): string => {
    if (scopeRegion === undefined) return runtimeId
    const fn = flat.get(runtimeId)
    if (!fn) return runtimeId
    return occurrenceKey({
      instancePath: fn.occ.instancePath.slice(scopeRegion.childPath.length),
      node: fn.occ.node,
    })
  }
  const outputIdOf = (source: ResolvedOutput): string | undefined => {
    const producer = flat.get(source.runtimeId)
    const output = producer?.elab.outputs.filter((candidate) => candidate.wireable !== false)[source.outputIndex]
    if (!output) return undefined
    return nativeOutputId(source.runtimeId, output)
  }
  const wireInput = (value: Json | readonly [string, number], scopeRegion?: RegionLowering): DinksterInputWire => {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'number') {
      return value as DinksterInputWire
    }
    const output = outputIdOf({ runtimeId: value[0], outputIndex: value[1] })
    if (output === undefined) {
      diags.push(diag('error', 'compile', 'compile.region.outputUnresolved', `native region lowering cannot resolve output #${value[1]} on producer '${value[0]}'`))
      return value as unknown as DinksterInputWire
    }
    return { $link: { node: localRuntimeId(value[0], scopeRegion), output } }
  }
  const nativeInputs = (runtimeId: string, compiled: PromptNode, scopeRegion?: RegionLowering) =>
    Object.fromEntries(Object.entries(compiled.inputs)
      .filter(([inputId]) => !dynamicComboInputs.get(runtimeId)?.has(inputId))
      .map(([inputId, value]) => [inputId, wireInput(value, scopeRegion)]))
  const sourceForBoundaryOutput = (
    region: RegionLowering,
    outputId: string,
  ): { readonly node: string; readonly output: string } | undefined => {
    const source = resolveOutputPort(
      region.occ.instancePath,
      region.parentDefId,
      { node: region.node.id, port: outputId as PortRef['port'] },
      diags,
      undefined,
      [],
      region.runtimeId,
    )
    const fail = (reason: string): undefined => {
      diags.push(diag('error', 'compile', 'compile.region.outputUnresolved', `region output '${outputId}' ${reason}`, { anchor: { occurrence: region.occ } }))
      return undefined
    }
    if (!source) return fail('cannot be resolved')
    if (source === 'muted') return fail('is driven by a muted occurrence')
    const resolved = 'bypass' in source
      ? projectRoute({ kind: 'bypass', bypass: source.bypass }, 'exact', diags)
      : 'widgetTap' in source
        ? projectRoute({ kind: 'endpoint', ...source.widgetTap }, 'exact', diags)
        : [{ kind: 'output' as const, src: source }]
    const outputs = resolved.filter((terminal): terminal is Extract<BypassTrace, { readonly kind: 'output' }> => terminal.kind === 'output')
    if (outputs.length !== 1 || resolved.length !== 1) return fail('does not resolve to exactly one body output')
    const output = outputIdOf(outputs[0]!.src)
    return output === undefined
      ? fail('resolves to an unknown body output')
      : { node: localRuntimeId(outputs[0]!.src.runtimeId, region), output }
  }
  const validationContext = new Map<string, DinksterGraphValidationNode>()
  const validationNode = (fn: FlatNode): DinksterGraphValidationNode => {
    const inputTypes: Record<string, TypeExpr> = {}
    const inputPorts: Record<string, PortRef> = {}
    for (const input of fn.elab.inputs) {
      if (input.apiName === undefined) continue
      const inputId = input.wire15Materialization ? input.address.port : input.apiName
      inputTypes[inputId] = input.spec.type
      inputPorts[inputId] = {
        node: fn.occ.node,
        port: input.address.port as PortRef['port'],
        ...(input.address.members !== undefined ? { members: input.address.members } : {}),
      }
    }
    const outputTypes: Record<string, TypeExpr> = {}
    const outputPorts: Record<string, PortRef> = {}
    for (const output of fn.elab.outputs) {
      if (output.wireable === false) continue
      const outputId = nativeOutputId(fn.runtimeId, output)
      outputTypes[outputId] = output.spec.type
      outputPorts[outputId] = {
        node: fn.occ.node,
        port: output.address.port as PortRef['port'],
        ...(output.address.members !== undefined ? { members: output.address.members } : {}),
      }
    }
    return {
      anchor: { occurrence: fn.occ },
      inputTypes,
      inputPorts,
      outputTypes,
      outputPorts,
      ...(fn.selector !== undefined ? { selector: true } : {}),
    }
  }
  const buildNativeGraph = (scopeRegion?: RegionLowering, prefix = ''): DinksterGraphWire => {
    const nodes: Record<string, DinksterGraphEntryWire> = {}
    for (const fn of flat.values()) {
      if (!included.has(fn.runtimeId) || ownerRegionOf(fn)?.runtimeId !== scopeRegion?.runtimeId) continue
      const nodeId = localRuntimeId(fn.runtimeId, scopeRegion)
      const path = prefix === '' ? nodeId : `${prefix}/${nodeId}`
      const region = regions.get(fn.runtimeId)
      const compiled = prompt[fn.runtimeId]
      if (!compiled) continue
      validationContext.set(path, validationNode(fn))
      if (!region) {
        nodes[nodeId] = {
          nodeType: compiled.class_type,
          inputs: nativeInputs(fn.runtimeId, compiled, scopeRegion),
          ...(compiled.outputMembers ? { outputMembers: compiled.outputMembers } : {}),
          ...(compiled.slotVariants ? { slotVariants: compiled.slotVariants } : {}),
        }
        continue
      }
      const contract = region.node.region!
      const child = graphOf(region.childId)!
      const boundarySchema = deriveBoundarySchema(child, resolve, undefined, (inner) => resolveNode(child.id, inner)).schema
      const ports: Record<string, Json> = {}
      for (const item of boundarySchema?.items ?? []) {
        if (item.kind !== 'input') continue
        const encoded = typeExprToDinksterWire(item.type)
        if (encoded === undefined) {
          diags.push(diag('error', 'compile', 'compile.region.portTypeUnsupported', `region port '${item.id}' has a type expression that cannot be emitted`, { anchor: { occurrence: region.occ } }))
          continue
        }
        ports[item.id] = encoded
      }
      const outputs: Record<string, DinksterRegionOutputWire> = {}
      for (const item of child.boundary!.outputs) {
        if (item.id === contract.continueOutput) continue
        const source = sourceForBoundaryOutput(region, item.id)
        if (!source) continue
        const role = contract.outputRoles?.[item.id]
        const outputId = region.stateOutputAliases.get(item.id) ?? item.id
        outputs[outputId] = {
          source,
          ...(role?.kind === 'state'
            ? { mode: 'state' as const }
            : role?.kind === 'flatten' || role?.kind === 'compact' ? { mode: role.kind } : {}),
        }
      }
      const continueSource = contract.continueOutput === undefined
        ? undefined
        : sourceForBoundaryOutput(region, contract.continueOutput)
      nodes[nodeId] = {
        region: {
          kind: contract.kind,
          ports,
          ...(contract.elementPorts !== undefined ? { elementPorts: contract.elementPorts } : {}),
          ...(contract.statePorts !== undefined ? { statePorts: contract.statePorts } : {}),
          ...(contract.binding !== undefined ? { binding: contract.binding } : {}),
          inputs: nativeInputs(fn.runtimeId, compiled, scopeRegion),
          body: buildNativeGraph(region, path),
          outputs,
          ...(contract.maxIterations !== undefined ? { maxIterations: contract.maxIterations } : {}),
          ...(continueSource !== undefined ? { continueSource } : {}),
        },
      }
    }
    return { nodes }
  }
  const dinksterGraph = includedRegions.length > 0 ? buildNativeGraph() : undefined
  if (dinksterGraph !== undefined) diags.push(...validateDinksterGraph(dinksterGraph, validationContext))
  if (diags.some((diagnostic) => diagnostic.severity === 'error')) {
    return { result: { ok: false, diagnostics: diags } }
  }

  const snapshot = deepFreeze(structuredClone(doc) as WorkflowDocument)
  const provenance: Provenance = deepFreeze({
    toSource,
    fromSource,
    inputSources,
    ...(Object.keys(outputAliases).length > 0 ? { outputAliases } : {}),
    ...(Object.keys(dynamicPromptInputs).length > 0 ? { dynamicPromptInputs } : {}),
    ...(selectorChoices.some((choice) => choice.policy === 'random') ? {
      randomSelectorInputs: Object.fromEntries(
        [...randomSelectorInputs].map(([runtimeId, inputs]) => [runtimeId, [...inputs].sort()]),
      ),
    } : {}),
    ...(controllerInputs.length > 0 ? { controllerInputs } : {}),
  })
  // The whole artifact is deeply owned and frozen (CO1): consumers cache and
  // share it, and a mutated prompt would silently diverge from the snapshot/
  // hash it claims to describe. Everything that could alias caller data
  // (prompt values alias the input document; scope/targets come from the
  // caller) is CLONED before freezing, so the artifact neither shares
  // mutable state with the caller nor freezes caller-owned objects as a
  // side effect.
  const artifact: CompileArtifact = Object.freeze({
    snapshot,
    revision: input.revision,
    semanticHash: semanticHashOf(doc, (type) => resolve(type)?.virtual === true),
    scope: deepFreeze(structuredClone(scope)),
    connection: input.connection,
    schemaHash: input.schemaHash,
    prompt: deepFreeze(structuredClone(prompt)) as Prompt,
    ...(dinksterGraph !== undefined ? { dinksterGraph: deepFreeze(structuredClone(dinksterGraph)) } : {}),
    ...(dinksterTargets !== undefined ? { dinksterTargets: deepFreeze(structuredClone(dinksterTargets)) } : {}),
    ...(partialTargets ? { partialTargets: deepFreeze(structuredClone(partialTargets)) } : {}),
    provenance,
    ...(selectorChoices.length > 0 ? { choices: deepFreeze(structuredClone(selectorChoices)) } : {}),
    diagnostics: deepFreeze(structuredClone(diags)),
  })

  // Would-run structural output: merge the traversal records of consumers
  // that landed in the closure, per graph definition.
  let structural: Map<string, ScopeStructuralGraph> | undefined
  if (wouldRunVia) {
    const acc = new Map<string, { reroutes: Set<string>; selectors: Map<string, Set<string>>; valueSources: Set<string> }>()
    for (const [consumerId, connections] of wouldRunVia) {
      if (!included.has(consumerId)) continue
      const consumer = flat.get(consumerId)
      const inactiveKey = consumer?.selectorProjection
        ? consumer.selectorProjection.branches[String(!consumer.selectorProjection.choice) as 'false' | 'true']
        : undefined
      for (const connection of connections) {
        if (connection.inputKey === inactiveKey) continue
        for (const { defId, via } of connection.entries) {
          let g = acc.get(defId)
          if (!g) acc.set(defId, (g = { reroutes: new Set(), selectors: new Map(), valueSources: new Set() }))
          for (const r of via.reroutes) g.reroutes.add(r)
          for (const v of via.valueSources) g.valueSources.add(v)
          for (const [sid, cands] of via.selectors) {
            let set = g.selectors.get(sid)
            if (!set) g.selectors.set(sid, (set = new Set()))
            for (const c of cands) set.add(c)
          }
        }
      }
    }
    structural = acc
  }
  return {
    result: { ok: true, artifact },
    ...(structural ? { structural } : {}),
    ...(wouldRun ? { inactiveExclusive } : {}),
  }
}

/**
 * Upstream closure of a scope, for would-run highlighting. Runs the same
 * flattening as {@link compile} so preview and submission cannot disagree on
 * anything DECIDED: fixed selectors, mutes, bypasses, reroutes, subgraph
 * flattening. Random-policy selectors are the one undecidable input - their
 * branch is rolled at queue time - so the closure is a SUPERSET there: every
 * candidate's upstream counts as "may run", and no chooser is required.
 */
export function scopeClosure(input: CompileInput): ScopeClosure | undefined {
  const { result, structural, inactiveExclusive } = compileImpl(input, true)
  if (!result.ok) return undefined
  const included = new Set(Object.values(result.artifact.provenance.toSource))
  return {
    scope: input.scope,
    revision: input.revision,
    included,
    inactiveExclusive: inactiveExclusive ?? new Map(),
    structural: structural ?? new Map(),
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  // Always walk children: Object.isFrozen only proves the ROOT is frozen; a
  // partially-frozen tree short-circuited here would be wrongly treated as
  // deeply immutable. The per-call `seen` set (NOT isFrozen) dedupes so
  // shared subtrees walk once and a cycle (structuredClone preserves them)
  // terminates instead of overflowing the stack.
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v, seen)
    Object.freeze(value)
  }
  return value
}
