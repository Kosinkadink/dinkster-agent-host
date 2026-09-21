/**
 * Canonical JSON + execution-semantic hash.
 *
 * The semantic hash covers exactly what changes execution results: graph
 * structure, node types/values/modes/controllers/dynamic state, links, nets,
 * boundaries, and extension data (extensions may affect compilation). It
 * excludes view state, meta, control-surface chrome, node titles (a retitle
 * never dirties an execution), link IDs, and reroutes (links hash as traced
 * producer->consumer pairs, so pure reroute edits are hash-neutral). Value
 * sources hash by delivered value+controller per consumer pair - never by
 * id or declared spec (P1), so spec pinning and unconnected sources are
 * hash-neutral too. Selectors are NOT canonicalized away: their policy,
 * candidate order, and candidate feeds all change what may execute, so they
 * hash structurally; only the exact random OUTCOME stays out (it lives in
 * the execution artifact, never in document semantics).
 *
 * Hash: FNV-1a 64-bit over canonical (sorted-key) JSON. Dependency-free and
 * synchronous; collision resistance is not a security requirement here -
 * equal hash is treated as "same semantics" for divergence badges, not auth.
 */

import type {
  BoundaryBinding,
  BoundaryRouteLeg,
  GraphDef,
  Json,
  NodeData,
  OccurrenceLinkEndpoint,
  OccurrenceTopology,
  ParentDeliveryIdentity,
  SuppressedDelivery,
  WorkflowDocument,
} from '../format/document.js'
import { isRerouteRef, occurrenceKey } from '../ids.js'
import { buildRerouteIndex, traceEndpoint } from '../reroute.js'

/** Serialize JSON with object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
}

/** FNV-1a 64-bit, returned as 16 hex chars. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    // XOR each UTF-16 code unit byte-wise (low then high byte).
    const code = input.charCodeAt(i)
    hash = ((hash ^ BigInt(code & 0xff)) * prime) & mask
    hash = ((hash ^ BigInt(code >>> 8)) * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Dependency-free synchronous SHA-256, returned as 64 hex chars. WebCrypto's
 * `crypto.subtle` exists only in secure contexts (HTTPS or localhost), and
 * this app is legitimately served over plain HTTP on LAN/tailnet origins, so
 * callers that need SHA-256 in the browser use this (directly, or as the
 * fallback when `subtle` is unavailable). Strings hash as their UTF-8 bytes.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const k = SHA256_CONSTANTS
  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!
      const b = w[i - 2]!
      const s0 = rightRotate(a, 7) ^ rightRotate(a, 18) ^ (a >>> 3)
      const s1 = rightRotate(b, 17) ^ rightRotate(b, 19) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const s1 = rightRotate(e!, 6) ^ rightRotate(e!, 11) ^ rightRotate(e!, 25)
      const choice = (e! & f!) ^ (~e! & g!)
      const t1 = (hh! + s1 + choice + k[i]! + w[i]!) >>> 0
      const s0 = rightRotate(a!, 2) ^ rightRotate(a!, 13) ^ rightRotate(a!, 22)
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (s0 + majority) >>> 0
      hh = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a!) >>> 0
    h[1] = (h[1]! + b!) >>> 0
    h[2] = (h[2]! + c!) >>> 0
    h[3] = (h[3]! + d!) >>> 0
    h[4] = (h[4]! + e!) >>> 0
    h[5] = (h[5]! + f!) >>> 0
    h[6] = (h[6]! + g!) >>> 0
    h[7] = (h[7]! + hh!) >>> 0
  }
  return [...h].map((part) => part.toString(16).padStart(8, '0')).join('')
}

const rightRotate = (value: number, count: number): number => (value >>> count) | (value << (32 - count))

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/**
 * Dynamic state normalized for hashing: the declared `seq` allocation
 * cursor and member labels are presentation bookkeeping: they affect only
 * future member ids and displayed names, never what executes now. Undo
 * intentionally leaves cursor-only
 * skeletons behind (CO3). Hashing it raw would make materialize-then-undo
 * hash differently from never-materialized - violating "equal hash means
 * equal current execution semantics" the same way hashing nextOrdinal or
 * surfaceSeq would. So `seq` is stripped at declared DynamicPortState
 * positions, containers emptied by the stripping are pruned, and everything
 * else (members, selected, unknown extension props) hashes verbatim.
 */
function semanticDynamicState(st: Json): Json | undefined {
  if (typeof st !== 'object' || st === null || Array.isArray(st)) return st
  const out: Record<string, Json> = {}
  for (const [key, v] of Object.entries(st)) {
    if (key === 'seq' || key === 'memberLabels') continue
    if (key === 'memberState' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const ms: Record<string, Json> = {}
      for (const [member, constructs] of Object.entries(v)) {
        if (typeof constructs !== 'object' || constructs === null || Array.isArray(constructs)) {
          ms[member] = constructs
          continue
        }
        const cs: Record<string, Json> = {}
        for (const [construct, nested] of Object.entries(constructs)) {
          const ns = semanticDynamicState(nested)
          if (ns !== undefined) cs[construct] = ns
        }
        if (Object.keys(cs).length > 0) ms[member] = cs
      }
      if (Object.keys(ms).length > 0) out['memberState'] = ms
      continue
    }
    out[key] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function semanticDynamic(dyn: NonNullable<NodeData['dynamic']>): Json | undefined {
  const out: Record<string, Json> = {}
  for (const [port, st] of Object.entries(dyn)) {
    const s = semanticDynamicState(st as unknown as Json)
    if (s !== undefined) out[port] = s
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The execution-semantic subset of one node (title excluded). */
function semanticNode(n: NodeData): Json {
  const dynamic = n.dynamic ? semanticDynamic(n.dynamic) : undefined
  return {
    id: n.id,
    type: n.type,
    values: n.values,
    ...(n.controllers ? { controllers: n.controllers } : {}),
    ...(n.mode && n.mode !== 'active' ? { mode: n.mode } : {}),
    ...(dynamic !== undefined ? { dynamic } : {}),
    ...(n.ext ? { ext: n.ext } : {}),
  } as unknown as Json
}

/**
 * The execution-semantic connection set of one graph: each link that delivers
 * to a consumer input, with its `from` traced upstream through reroute chains
 * to the real producing output (the same traceEndpoint the compiler lowers
 * with). Link IDs and reroutes are canonicalized away (they never change what
 * executes), so inserting/moving/dissolving a pure reroute is hash-neutral.
 * Undriven/cyclic chains are omitted exactly like the compiler omits them: a
 * consumer fed by a dead chain hashes the same as one with no link at all.
 * Only the consumer-delivering link's `ext` is semantic (extensions may
 * affect compilation); ext on structural feeds into reroutes is view-only,
 * matching dissolve which preserves just the consumer segment's ext.
 */
function semanticConnections(g: GraphDef): Json {
  const pairs: Json[] = []
  const rerouteIndex = buildRerouteIndex(g)
  for (const link of Object.values(g.links)) {
    if (isRerouteRef(link.to)) continue // structural feed into a reroute
    const trace = traceEndpoint(g, link.from, rerouteIndex)
    if (trace.kind === 'valueSource') {
      // A value-source-driven consumer hashes by the VALUE it receives (plus
      // controller mode, which changes the value at queue time) - not by the
      // source's id or declared spec. Ids are canonicalized away like link
      // ids; the declared spec never affects compilation, so a spec edit or
      // pin must not dirty frozen views (P1). Unconnected value sources are
      // hash-neutral by construction (they produce no pairs).
      const vs = g.valueSources?.[trace.id]
      if (!vs) continue // dangling ref: compiles to nothing
      pairs.push({
        fromValue: { value: vs.value, ...(vs.controller ? { controller: vs.controller } : {}) },
        to: link.to as unknown as Json,
        ...(link.ext ? { ext: link.ext } : {}),
      })
      continue
    }
    if (trace.kind === 'selector') {
      // A consumer fed by a selector OUTPUT hashes by the selector's
      // identity: which branch actually flows is the policy's business
      // (hashed with the selector config below), and the exact random
      // outcome lives in the execution artifact - never in doc semantics.
      pairs.push({
        fromSelector: trace.id,
        to: link.to as unknown as Json,
        ...(link.ext ? { ext: link.ext } : {}),
      })
      continue
    }
    if (trace.kind === 'tapValue') {
      // Literal taps are topology too: node values are hashed separately,
      // while this pair records which consumer receives that effective value.
      pairs.push({
        fromTap: { node: trace.node, tap: trace.input },
        to: link.to as unknown as Json,
        ...(link.ext ? { ext: link.ext } : {}),
      })
      continue
    }
    if (trace.kind !== 'output') continue // undriven/cycle: compiles to nothing
    pairs.push({
      from: trace.ref as unknown as Json,
      to: link.to as unknown as Json,
      ...(link.ext ? { ext: link.ext } : {}),
    })
  }
  return pairs
    .map((p) => [canonicalJson(p), p] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, p]) => p)
}

/**
 * The execution-semantic subset of one selector: policy, candidate ids in
 * order (order is the random-resolution domain), and ext. Titles are
 * diagnostics/display chrome, excluded like node titles. Candidate DRIVERS
 * are covered by {@link semanticConnections} (pairs targeting candidate
 * endpoints), so a reroute inserted on a branch stays hash-neutral.
 */
function semanticSelector(s: NonNullable<GraphDef['selectors']>[string]): Json {
  return {
    id: s.id,
    policy: s.policy,
    candidates: s.candidates.map((c) => c.id),
    ...(s.ext ? { ext: s.ext } : {}),
  } as unknown as Json
}

function semanticGraph(g: GraphDef, isVirtualType: (type: string) => boolean): Json {
  const selectors = Object.entries(g.selectors ?? {})
  return {
    nodes: Object.fromEntries(
      Object.entries(g.nodes)
        .filter(([, node]) => node.virtual !== true || !isVirtualType(node.type))
        .map(([k, n]) => [k, semanticNode(n)]),
    ),
    links: semanticConnections(g),
    nets: g.nets,
    ...(g.boundary ? { boundary: g.boundary } : {}),
    // Guarded on non-empty so `selectors: {}` and absent hash identically.
    ...(selectors.length > 0
      ? { selectors: Object.fromEntries(selectors.map(([k, s]) => [k, semanticSelector(s)])) }
      : {}),
  } as unknown as Json
}

const semanticBoundaryBinding = (binding: BoundaryBinding): Json => binding.kind === 'widgetTap'
  ? { kind: binding.kind, node: binding.node, tap: binding.tap } as unknown as Json
  : {
      kind: binding.kind,
      node: binding.node,
      port: binding.port,
      ...(binding.members ? { members: binding.members } : {}),
      ...(binding.slots ? { slots: [...binding.slots].sort() } : {}),
    } as unknown as Json

const semanticBoundaryRoute = (route: readonly BoundaryRouteLeg[]): Json =>
  route.map((leg) => ({
    graph: leg.graph,
    boundaryId: leg.boundaryId,
    binding: semanticBoundaryBinding(leg.binding),
  })) as unknown as Json

const semanticOccurrenceEndpoint = (endpoint: OccurrenceLinkEndpoint): Json =>
  endpoint.kind === 'body'
    ? { kind: 'body', endpoint: endpoint.endpoint } as unknown as Json
    : {
        kind: 'boundary',
        occurrence: endpoint.occurrence,
        address: endpoint.address,
        route: semanticBoundaryRoute(endpoint.route),
      } as unknown as Json

const semanticOccurrenceSource = (
  body: GraphDef,
  endpoint: OccurrenceLinkEndpoint,
  rerouteIndex: ReturnType<typeof buildRerouteIndex>,
): Json => {
  if (endpoint.kind === 'boundary') return semanticOccurrenceEndpoint(endpoint)
  const trace = traceEndpoint(body, endpoint.endpoint, rerouteIndex)
  if (trace.kind === 'valueSource') {
    const source = body.valueSources?.[trace.id]
    return source === undefined
      ? semanticOccurrenceEndpoint(endpoint)
      : {
          kind: 'body',
          value: source.value,
          ...(source.controller ? { controller: source.controller } : {}),
        } as unknown as Json
  }
  if (trace.kind === 'selector')
    return { kind: 'body', selector: trace.id } as unknown as Json
  if (trace.kind === 'tapValue')
    return { kind: 'body', tap: { node: trace.node, input: trace.input } } as unknown as Json
  if (trace.kind === 'output')
    return { kind: 'body', endpoint: trace.ref } as unknown as Json
  // An undriven/cyclic reroute may be driven by another occurrence-local
  // link, which is not part of the definition-only reroute index. Preserve
  // its structural endpoint; the id-free local connection set below still
  // captures that topology without pretending the route is definition-owned.
  return semanticOccurrenceEndpoint(endpoint)
}

const semanticParentDelivery = (delivery: ParentDeliveryIdentity): Json =>
  delivery as unknown as Json

const semanticSuppression = (suppression: SuppressedDelivery): Json => {
  if (suppression.kind !== 'projectedLeg') return suppression as unknown as Json
  return {
    kind: 'projectedLeg',
    delivery: semanticParentDelivery(suppression.delivery),
    route: semanticBoundaryRoute(suppression.route),
  } as unknown as Json
}

function semanticOccurrenceTopology(
  doc: WorkflowDocument,
  topology: OccurrenceTopology,
): Json | undefined {
  const body = doc.graphs[topology.bodyGraph]!
  const links = Object.entries(topology.links)
  const suppressions = (topology.suppressedDeliveries ?? []).filter((suppression) =>
    suppression.kind !== 'link' || body.links[suppression.linkId] !== undefined)
  if (links.length === 0 && suppressions.length === 0 && topology.ext === undefined)
    return undefined
  const rerouteIndex = buildRerouteIndex(body)
  const boundaryLinks = links.filter(([, link]) => link.to.kind === 'boundary')
  const semanticBoundaryLinks = boundaryLinks.map(([, link]) => {
    const value = {
      from: semanticOccurrenceSource(body, link.from, rerouteIndex),
      to: semanticOccurrenceEndpoint(link.to),
      ...((link.to.kind === 'boundary' || !isRerouteRef(link.to.endpoint)) && link.ext
        ? { ext: link.ext }
        : {}),
    } as unknown as Json
    return [canonicalJson(value), value] as const
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, link]) => link)
  // Body-local links execute in one occurrence-aware reroute/selector/tap
  // index together with definition links. Hash the connection delta produced
  // by adding those local links, rather than their persisted structural
  // segments, so a local driver into a body reroute composes with every
  // definition-owned consumer exactly as compile does.
  const activeDefinitionLinks = Object.fromEntries(Object.entries(body.links).filter(([, link]) =>
    !suppressions.some((suppression) => suppression.kind === 'link' && suppression.linkId === link.id),
  )) as GraphDef['links']
  const activeDefinitionNets = Object.fromEntries(Object.entries(body.nets).map(([id, net]) => [id, {
    ...net,
    sinks: net.sinks.filter((to) => !suppressions.some((suppression) =>
      suppression.kind === 'netSink' && suppression.netId === net.id && canonicalJson(suppression.to) === canonicalJson(to))),
  }])) as GraphDef['nets']
  const baselineBody = { ...body, links: activeDefinitionLinks, nets: activeDefinitionNets }
  const boundarySources = new Map<string, Json>()
  const occupiedLinks = new Set(Object.keys(activeDefinitionLinks))
  const occupiedNodes = new Set(Object.keys(body.nodes))
  const fresh = (prefix: string, occupied: Set<string>): string => {
    let candidate = prefix
    let suffix = 0
    while (occupied.has(candidate)) candidate = `${prefix}_${++suffix}`
    occupied.add(candidate)
    return candidate
  }
  const effectiveBodyLinks = Object.fromEntries([
    ...Object.entries(activeDefinitionLinks),
    ...links.flatMap(([, link], index) => {
      if (link.to.kind !== 'body') return []
      const from = link.from.kind === 'body'
        ? link.from.endpoint
        : (() => {
            const node = fresh(`__occurrence_boundary_${index}`, occupiedNodes)
            const port = '__source'
            boundarySources.set(JSON.stringify([node, port]), semanticOccurrenceEndpoint(link.from))
            return { node, port }
          })()
      const id = fresh(`__occurrence_${index}`, occupiedLinks)
      return [[id, { id, from, to: link.to.endpoint, ...(link.ext ? { ext: link.ext } : {}) }]]
    }),
  ]) as GraphDef['links']
  const baselineKeys = new Set((semanticConnections(baselineBody) as Json[]).map(canonicalJson))
  const semanticBodyLinks = (semanticConnections({ ...body, links: effectiveBodyLinks, nets: activeDefinitionNets }) as Json[])
    .filter((connection) => !baselineKeys.has(canonicalJson(connection)))
    .map((connection) => {
      const record = connection as unknown as Record<string, Json>
      const from = record['from'] as unknown as { readonly node?: string; readonly port?: string } | undefined
      const boundary = from?.node === undefined || from.port === undefined
        ? undefined
        : boundarySources.get(JSON.stringify([from.node, from.port]))
      if (boundary === undefined) return connection
      const { from: _from, ...rest } = record
      return { fromBoundary: boundary, ...rest } as unknown as Json
    })
  const semanticLinks = [...semanticBoundaryLinks, ...semanticBodyLinks]
    .map((link) => [canonicalJson(link), link] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, link]) => link)
  return {
    owner: topology.owner,
    bodyGraph: topology.bodyGraph,
    links: semanticLinks,
    ...(suppressions.length > 0
      ? { suppressedDeliveries: suppressions.map(semanticSuppression) }
      : {}),
    ...(topology.ext ? { ext: topology.ext } : {}),
  } as unknown as Json
}

/** Execution-semantic hash of a document. Equal hash <=> same execution semantics. */
export function semanticHashOf(
  doc: WorkflowDocument,
  isVirtualType: (type: string) => boolean = () => false,
): string {
  const occurrenceTopologies = Object.entries(doc.occurrenceTopologies ?? {})
    .map(([, topology]) => [occurrenceKey(topology.owner), semanticOccurrenceTopology(doc, topology)] as const)
    .filter((entry): entry is readonly [string, Json] => entry[1] !== undefined)
  const semantic = {
    root: doc.root,
    graphs: Object.fromEntries(Object.entries(doc.graphs).map(([k, g]) => [k, semanticGraph(g, isVirtualType)])),
    ...(occurrenceTopologies.length > 0
      ? { occurrenceTopologies: Object.fromEntries(occurrenceTopologies) }
      : {}),
  }
  return fnv1a64(canonicalJson(semantic))
}
