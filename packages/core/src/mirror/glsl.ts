/**
 * Display-only image estimates from glsl mirrors: pure binding derivation.
 *
 * A node schema may declare a frontend-renderable mirror (wire v29). For
 * `kind: 'glsl'` mirrors the schema carries one GLSL ES 3.00 fragment shader
 * whose uniforms bind to the node's inputs by id: each image input binds as
 * `sampler2D u_<id>`, and each float/int/boolean/combo input binds as a
 * scalar uniform named by the input id (a combo binds as the index of the
 * stored value in the schema's declared options). This module derives those
 * bindings for every mirrored node in a graph: scalar values must be
 * CLIENT-RESIDENT (stored widget values, widget-tap defaults, and
 * value-source literals - the same discipline expression estimates apply),
 * while each image input must trace to a producer output, returned as a
 * reference for the host to pair with locally available imagery. A mirror
 * scoped by `applies` (wire v30) additionally requires every named combo
 * to resolve to a covered option key, or the node derives no binding.
 *
 * Bindings are presentation state only: they never feed compile, hashing,
 * or submission, and every failure yields "no binding" rather than an error.
 */
import type { GraphDef, Json } from '../format/document.js'
import { asPortId, portRefKey } from '../ids.js'
import { buildRerouteIndex, traceEndpoint } from '../reroute.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elaborateInterface,
  valueKeyOf,
  type ElaboratedInput,
} from '../schema/elaborate.js'
import type { NodeSchema } from '../schema/model.js'
import { effectiveWidgetDefault } from '../schema/widget-defaults.js'

/** Whether this frontend can evaluate `schema`'s declared mirror on a GPU. */
export const supportsGlslMirror = (schema: NodeSchema): boolean =>
  schema.mirror?.kind === 'glsl' &&
  typeof schema.mirror.source === 'string' &&
  schema.mirror.source !== ''

/** One scalar uniform: `uniform <glslType> <name>` set to `value`. */
export interface GlslScalarUniform {
  readonly name: string
  readonly glslType: 'float' | 'int' | 'bool'
  readonly value: number | boolean
}

/** One image uniform: `uniform sampler2D <name>` fed by `driver`'s output. */
export interface GlslImageUniform {
  readonly name: string
  readonly inputId: string
  readonly driver: { readonly node: string; readonly output: string }
}

/** Everything a GPU runner needs to draw one node's estimate. */
export interface GlslMirrorBinding {
  readonly source: string
  readonly images: readonly GlslImageUniform[]
  readonly scalars: readonly GlslScalarUniform[]
}

/** Node id -> its derived glsl binding. Nodes without one are absent. */
export type GlslMirrorBindingMap = ReadonlyMap<string, GlslMirrorBinding>

/** The uniform kind an input's declared type binds as, per the contract. */
const uniformKindOf = (item: ElaboratedInput): 'image' | 'float' | 'int' | 'bool' | 'combo' | undefined => {
  const type = item.spec.type
  if (type.kind !== 'concrete') return undefined
  switch (type.name) {
    case 'dinkster.image': return 'image'
    case 'core.float': return 'float'
    case 'core.int': return 'int'
    case 'core.boolean': return 'bool'
    case 'core.combo': return item.spec.widget?.widgetType === 'COMBO' ? 'combo' : undefined
    default: return undefined
  }
}

/**
 * The DECLARED leaf id the shader binds this input's uniform by. Elaborated
 * ids inside a DynamicCombo branch are construct-prefixed ('operation.radius')
 * while the backend shader declares the plain schema leaf ('radius'), so the
 * construct prefix is stripped. Undefined when the result is still dotted:
 * a nested path has no declared uniform, so the node estimates nothing.
 */
const uniformNameOf = (item: ElaboratedInput): string | undefined => {
  const id = item.spec.id
  const name = item.origin.kind === 'branch' && id.startsWith(`${item.origin.construct}.`)
    ? id.slice(item.origin.construct.length + 1)
    : id
  return name.includes('.') ? undefined : name
}

/** The stored combo string's index among the schema's declared options. */
const comboIndexOf = (item: ElaboratedInput, value: Json | undefined): number | undefined => {
  if (typeof value !== 'string') return undefined
  const options = item.spec.widget?.options['options']
  if (!Array.isArray(options)) return undefined
  const index = options.findIndex((option) =>
    typeof option === 'string'
      ? option === value
      : typeof option === 'object' && option !== null &&
        (option as { value?: unknown }).value === value)
  return index >= 0 ? index : undefined
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
 * Derive glsl-mirror bindings for every node in `def` whose declared mirror
 * this frontend supports, whose image inputs all trace to producer outputs,
 * and whose scalar inputs all resolve to client-resident values. Pure
 * derivation over the definition; build per overlay pass, never store.
 */
export function deriveGlslMirrorBindings(
  def: GraphDef,
  resolveSchema: (type: string) => NodeSchema | undefined,
): GlslMirrorBindingMap {
  const bindings = new Map<string, GlslMirrorBinding>()
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

  for (const [nodeId, node] of Object.entries(def.nodes)) {
    const schema = resolveSchema(node.type)
    if (!schema || !supportsGlslMirror(schema)) continue
    const inputs = inputsOfNode(nodeId)
    if (!inputs) continue

    const images: GlslImageUniform[] = []
    const scalars: GlslScalarUniform[] = []
    // The mirror's applies scope (combo id -> covered option keys) is a
    // soundness boundary, not a hint: outside it the shader computes a
    // DIFFERENT operation than the backend would, so gating must fail
    // closed. Every scoped combo must be seen among the elaborated inputs
    // and resolve to a covered value, or the node estimates nothing.
    const applies = schema.mirror?.applies
    const appliesChecked = new Set<string>()
    const usedNames = new Set<string>()
    let resolvable = true
    for (const item of inputs) {
      // Items without an apiName (ghost members, beyond-cap members) never
      // reach the prompt, so the backend never binds them as uniforms.
      if (item.apiName === undefined) continue
      const kind = uniformKindOf(item)
      const name = uniformNameOf(item)
      // The uniform naming contract is by declared leaf id; a member-bearing
      // address, an unmapped type, a nested id, or two inputs claiming the
      // same uniform have no sound binding, so the node estimates nothing
      // rather than guessing.
      if (kind === undefined || name === undefined || usedNames.has(name) ||
          (item.address.members?.length ?? 0) > 0) {
        resolvable = false
        break
      }
      usedNames.add(name)

      index ??= buildRerouteIndex(def)
      const key = portRefKey({
        node: node.id,
        port: asPortId(item.address.port),
        ...(item.address.members ? { members: item.address.members } : {}),
      })
      const driver = index.inputDriverOf.get(key)

      if (kind === 'image') {
        // Mirrors model only the success path; an image the node would not
        // receive from a producer (via a link or a net) leaves nothing
        // sound to estimate.
        const from = driver?.from ?? index.netSourceOf.get(key)
        if (from === undefined) {
          resolvable = false
          break
        }
        const trace = traceEndpoint(def, from, index)
        if (trace.kind !== 'output') {
          resolvable = false
          break
        }
        images.push({
          name: `u_${name}`,
          inputId: item.spec.id,
          driver: { node: trace.ref.node, output: trace.ref.port },
        })
        continue
      }

      let value: Json | undefined
      if (item.origin.kind === 'selector') {
        // A DynamicCombo selector's value lives in node dynamic state,
        // surfaced by elaboration as derivedValue - NEVER node.values, which
        // can disagree with the branch that was actually materialized. A
        // driven selector is not client-resident: estimate nothing.
        if (driver !== undefined || index.netSourceOf.has(key)) {
          resolvable = false
          break
        }
        value = item.derivedValue
      } else if (driver) {
        const trace = traceEndpoint(def, driver.from, index)
        if (trace.kind === 'valueSource') {
          value = def.valueSources?.[trace.id]?.value
        } else if (trace.kind === 'tapValue') {
          const upstream = inputsOfNode(trace.node)
          const tapped = upstream?.find(
            (i) => (i.address.members?.length ?? 0) === 0 && i.address.port === trace.input,
          )
          const upstreamNode = def.nodes[trace.node]
          if (tapped && upstreamNode) value = residentValueOf(upstreamNode.values, tapped)
        }
        // Producer outputs, nets-to-producers, selectors, cycles, undriven
        // chains: not client-resident, fall through with no value.
      } else if (index.netSourceOf.has(key)) {
        // Net sources are producer outputs; never client-resident.
      } else {
        // Unconnected: usable only if the input itself is widget-backed.
        value = residentValueOf(node.values, item)
      }

      let uniform: GlslScalarUniform | undefined
      if (kind === 'combo') {
        const covered = applies?.[name]
        if (covered !== undefined) {
          appliesChecked.add(name)
          if (typeof value !== 'string' || !covered.includes(value)) {
            resolvable = false
            break
          }
        }
        const selected = comboIndexOf(item, value)
        if (selected !== undefined) uniform = { name, glslType: 'int', value: selected }
      } else if (kind === 'bool') {
        if (typeof value === 'boolean') uniform = { name, glslType: 'bool', value }
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        if (kind === 'float') uniform = { name, glslType: 'float', value }
        else if (Number.isInteger(value)) uniform = { name, glslType: 'int', value }
      }
      if (uniform === undefined) {
        resolvable = false
        break
      }
      scalars.push(uniform)
    }

    // An applies key that never surfaced as an elaborated combo input could
    // not be checked against its covered set, so the scope's soundness
    // guarantee is unverifiable: derive nothing.
    if (applies !== undefined && Object.keys(applies).some((key) => !appliesChecked.has(key))) {
      continue
    }
    if (!resolvable || images.length === 0) continue
    bindings.set(nodeId, { source: schema.mirror!.source!, images, scalars })
  }
  return bindings
}
