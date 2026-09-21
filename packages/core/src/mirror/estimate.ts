/**
 * Display-only scalar estimates from expression mirrors.
 *
 * A node schema may declare a frontend-renderable mirror (wire v29). For
 * `kind: 'expression'` mirrors this module evaluates the node's expression
 * locally over CLIENT-RESIDENT inputs - stored widget values, widget-tap
 * defaults, value-source literals, provenance-eligible producer values, and
 * upstream mirror estimates - and produces per-output scalar estimates for
 * canvas display. Estimates are presentation state only: they never feed
 * compile, hashing, submission, or any authoritative path, and every failure
 * degrades to "no estimate" rather than an error surface.
 */
import { companionSourceOf } from '../companion.js'
import type { GraphDef, Json } from '../format/document.js'
import { asPortId, portRefKey } from '../ids.js'
import { buildRerouteIndex } from '../reroute.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elaborateInterface,
  valueKeyOf,
  type ElaboratedInput,
  type PortAddress,
} from '../schema/elaborate.js'
import { outputsOf, type NodeSchema } from '../schema/model.js'
import { effectiveWidgetDefault } from '../schema/widget-defaults.js'
import {
  EXPRESSION_GRAMMAR_VERSION,
  ExpressionMirrorError,
  evaluateExpression,
  expressionMirrorErrorMessage,
  validateExpressionText,
  type ExpressionScalar,
} from './expression.js'

/** Scalar estimates for one node, keyed by schema output id. */
export interface MirrorEstimate {
  readonly outputs: Readonly<Record<string, Json>>
  /** Canonical evaluator failure displayed by the node's preview surface. */
  readonly error?: string
}

/** Node id -> its mirror-computed estimate. Nodes without one are absent. */
export type MirrorEstimateMap = ReadonlyMap<string, MirrorEstimate>

export interface MirrorEstimateOptions {
  /** Per-node global/override gate. Disabled mirrors cannot feed downstream mirrors. */
  readonly enabled?: (nodeId: string) => boolean
  /**
   * Current producer values that may safely participate in a new estimate.
   * The caller owns provenance and must omit stale or otherwise unproven data.
   */
  readonly producerValue?: (nodeId: string, outputId: string) => Json | undefined
}

/** Whether this frontend can evaluate `schema`'s declared mirror. */
export const supportsExpressionMirror = (schema: NodeSchema): boolean =>
  schema.mirror?.kind === 'expression' &&
  schema.mirror.grammarVersion === EXPRESSION_GRAMMAR_VERSION

/** The widget port an expression mirror reads its expression text from. */
const EXPRESSION_MIRROR_INPUT_ID = 'expression'

/** Whether an elaborated input address carries a schema's expression text. */
export const isExpressionMirrorInput = (schema: NodeSchema, address: PortAddress): boolean =>
  supportsExpressionMirror(schema) &&
  address.port === EXPRESSION_MIRROR_INPUT_ID &&
  (address.members?.length ?? 0) === 0

/** Largest bigint magnitude representable exactly as a JSON number. */
const MAX_SAFE_JSON_INT = 9007199254740991n

/**
 * Classify one client-resident JSON value the way the backend receives it:
 * prompt JSON gives integer-valued numbers to Python as int and fractional
 * ones as float, regardless of the widget kind that produced them. Returns
 * undefined for values the expression grammar has no scalar for.
 */
const scalarOfJson = (value: Json | undefined): ExpressionScalar | undefined => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Number.isInteger(value) ? BigInt(value) : value
}

/** Stored value, selector-derived value, or intrinsic widget default. */
const residentValueOf = (
  values: Readonly<Record<string, Json>>,
  item: ElaboratedInput,
): Json | undefined => {
  const stored = values[valueKeyOf(item)]
  if (stored !== undefined) return stored
  if (item.derivedValue !== undefined) return item.derivedValue
  return item.spec.widget === undefined ? undefined : effectiveWidgetDefault(item.spec.widget)
}

/**
 * Derive expression-mirror estimates for every node in `def` whose declared
 * mirror this frontend supports and whose variable inputs all resolve to
 * eligible scalars. Producer-driven inputs use a provenance-approved current
 * value first, then an upstream mirror estimate. Recursive evaluation makes
 * the result independent of document order and makes edits invalidate only
 * the downstream dependency cone represented in the new derivation. Cycles
 * and every other unresolved path fail closed. Pure derivation over the
 * definition; build per overlay pass, never store.
 */
export function deriveMirrorEstimates(
  def: GraphDef,
  resolveSchema: (type: string) => NodeSchema | undefined,
  options: MirrorEstimateOptions = {},
): MirrorEstimateMap {
  const estimates = new Map<string, MirrorEstimate>()
  const resolved = new Set<string>()
  const evaluating = new Set<string>()
  let index: ReturnType<typeof buildRerouteIndex> | undefined
  let connectivity: ReturnType<typeof buildGraphConnectivity> | undefined
  const elaborated = new Map<string, readonly ElaboratedInput[]>()
  const inputsOfNode = (nodeId: string): readonly ElaboratedInput[] | undefined => {
    const cached = elaborated.get(nodeId)
    if (cached) return cached
    const node = def.nodes[nodeId]
    const schema = node ? resolveSchema(node.type) : undefined
    if (!node || !schema) return undefined
    connectivity ??= buildGraphConnectivity(def)
    const inputs = elabInputsOf(
      elaborateInterface(schema, node, connectivity(node.id), { promoteGhosts: false }),
    )
    elaborated.set(nodeId, inputs)
    return inputs
  }
  const tapValueOf = (nodeId: string, inputId: string): Json | undefined => {
    const input = inputsOfNode(nodeId)?.find(
      (item) => (item.address.members?.length ?? 0) === 0 && item.address.port === inputId,
    )
    const node = def.nodes[nodeId]
    return input === undefined || node === undefined ? undefined : residentValueOf(node.values, input)
  }

  const estimateNode = (nodeId: string): MirrorEstimate | undefined => {
    if (resolved.has(nodeId)) return estimates.get(nodeId)
    if (evaluating.has(nodeId)) return undefined
    evaluating.add(nodeId)
    const finish = (estimate?: MirrorEstimate): MirrorEstimate | undefined => {
      evaluating.delete(nodeId)
      resolved.add(nodeId)
      if (estimate !== undefined) estimates.set(nodeId, estimate)
      return estimate
    }

    const node = def.nodes[nodeId]
    if (!node || options.enabled?.(nodeId) === false) return finish()
    const schema = resolveSchema(node.type)
    if (!schema || !supportsExpressionMirror(schema)) return finish()
    const inputs = inputsOfNode(nodeId)
    if (!inputs) return finish()

    let expression: string | undefined
    const variables = new Map<string, ExpressionScalar>()
    const inputNames: string[] = []
    let supportedInputShape = true
    let resolvable = true
    for (const item of inputs) {
      if (isExpressionMirrorInput(schema, item.address)) {
        const text = residentValueOf(node.values, item)
        if (typeof text !== 'string') resolvable = false
        else expression = text
        continue
      }
      // Items without an apiName (ghost members, beyond-cap members) never
      // reach the prompt, so the backend never binds them as variables.
      if (item.apiName === undefined) continue
      // Variable name: the wire name's last dotted segment ('values.a' -> 'a').
      const segments = item.apiName.split('.')
      const name = segments[segments.length - 1] ?? ''
      if (!/^[a-z]$/.test(name)) {
        supportedInputShape = false
        continue
      }
      inputNames.push(name)
      index ??= buildRerouteIndex(def)
      const key = portRefKey({
        node: node.id,
        port: asPortId(item.address.port),
        ...(item.address.members ? { members: item.address.members } : {}),
      })
      const driver = index.inputDriverOf.get(key)
      let value: Json | undefined
      const from = driver?.from ?? index.netSourceOf.get(key)
      if (from) {
        const source = companionSourceOf(def, from, index, tapValueOf, resolveSchema)
        if (source?.kind === 'literal') {
          value = source.value
        } else if (source?.kind === 'producer') {
          value = options.producerValue?.(source.node, source.output)
            ?? estimateNode(source.node)?.outputs[source.output]
        }
        // Selectors, cycles, and undriven chains fall through with no value.
      } else {
        // Unconnected: usable only if the input itself is widget-backed.
        value = residentValueOf(node.values, item)
      }
      const scalar = scalarOfJson(value)
      if (scalar === undefined) {
        resolvable = false
        continue
      }
      variables.set(name, scalar)
    }
    if (!supportedInputShape || expression === undefined) return finish()
    if (!resolvable) {
      const validation = validateExpressionText(expression, inputNames)
      return finish(validation.kind === 'valid'
        ? undefined
        : { outputs: {}, error: validation.message })
    }

    try {
      const result = evaluateExpression(expression, variables)
      if (result.kind !== 'scalar') return finish()
      const declared = new Set(outputsOf(schema).map((o) => o.id))
      const outputs: Record<string, Json> = {}
      if (declared.has('boolean')) outputs['boolean'] = result.boolean
      if (declared.has('float') && Number.isFinite(result.float)) outputs['float'] = result.float
      if (
        declared.has('int') &&
        result.int >= -MAX_SAFE_JSON_INT &&
        result.int <= MAX_SAFE_JSON_INT
      ) {
        outputs['int'] = Number(result.int)
      }
      return finish(Object.keys(outputs).length > 0 ? { outputs } : undefined)
    } catch (error) {
      if (!(error instanceof ExpressionMirrorError)) throw error
      return finish({ outputs: {}, error: expressionMirrorErrorMessage(error) })
    }
  }

  for (const nodeId of Object.keys(def.nodes)) {
    estimateNode(nodeId)
  }
  return estimates
}
