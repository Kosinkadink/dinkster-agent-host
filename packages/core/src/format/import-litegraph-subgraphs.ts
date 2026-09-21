import { diag, type Diagnostic } from '../diagnostics.js'
import { matchBypassInput } from '../compile/bypass.js'
import { checkDocument } from '../invariants.js'
import { deriveBoundarySchema } from '../schema/derive-boundary.js'
import { inputsOf, type NodeSchema } from '../schema/model.js'
import { parseObjectInfoEntry } from '../schema/object-info.js'
import type { BoundaryBinding, BoundaryItem, GraphDef, Json, JsonObject, WorkflowDocument } from './document.js'
import type { ImportLitegraphResult } from './import-litegraph.js'
import { ownJson } from './json.js'
import { validateDocumentShape } from './validate.js'

type Mutable = { [key: string]: any }
type FlatImporter = (
  graph: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
  definitions: WorkflowDocument['graphs'],
) => ImportLitegraphResult

interface Definition {
  raw: Mutable
  inputNode: number
  outputNode: number
  schema?: NodeSchema
  body?: Mutable
  view?: Mutable
  inline: boolean
}

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const integerId = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isSafeInteger(value)) ||
  (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)))
const endpointKey = (end: Mutable): string => JSON.stringify(Object.entries(end).sort(([a], [b]) => a.localeCompare(b)))
const nodeEnd = (end: Mutable, node: string): boolean => end['node'] === node

/** Object links are used by schema-v1 graphs, including definitions in v0.4 files. */
function normalizeLinks(graph: Mutable): void {
  if (!Array.isArray(graph['links'])) return
  graph['links'] = graph['links'].map((link: unknown) => object(link)
    ? [link['id'], link['origin_id'], link['origin_slot'], link['target_id'], link['target_slot'], link['type'] ?? '*']
    : link)
}

/** Foreign definitions are decoded with the same positional-port rules as root nodes. */
export function importLitegraphSubgraphs(
  input: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
  importFlat: FlatImporter,
): ImportLitegraphResult {
  const diagnostics: Diagnostic[] = []
  const fail = (code: string, message: string): void => {
    diagnostics.push(diag('error', 'import', code, message))
  }
  // The caller owns ingress; this working copy is never shared with the result.
  const root: Mutable = JSON.parse(JSON.stringify(input))
  const definitions = new Map<string, Definition>()
  const collect = (graph: Mutable, depth: number): void => {
    normalizeLinks(graph)
    const defs = graph['definitions']
    if (defs === undefined) return
    if (!object(defs) || (defs['subgraphs'] !== undefined && !Array.isArray(defs['subgraphs']))) {
      fail('import.subgraphs.invalid', 'definitions.subgraphs must be an array in an object')
      return
    }
    if (depth > 64 || definitions.size > 1024) {
      fail('import.subgraphs.budget', 'subgraph nesting or definition count exceeds the import budget')
      return
    }
    for (const raw of (defs['subgraphs'] ?? []) as Json[]) {
      if (definitions.size >= 1024) {
        fail('import.subgraphs.budget', 'workflow exceeds 1024 definitions')
        break
      }
      if (!object(raw) || typeof raw['id'] !== 'string' || !raw['id'] || ['g0', '__proto__'].includes(raw['id']) || !Array.isArray(raw['nodes'])) {
        fail('import.subgraphs.invalid', 'each subgraph needs a unique non-root string id and nodes array')
        continue
      }
      if (definitions.has(raw['id'])) {
        fail('import.subgraphs.duplicateId', `duplicate subgraph definition '${raw['id']}'`)
        continue
      }
      const mutable = raw as Mutable
      mutable['inputs'] ??= []
      mutable['outputs'] ??= []
      mutable['links'] ??= []
      normalizeLinks(mutable)
      if (!Array.isArray(mutable['links']) || mutable['links'].some((link) => !Array.isArray(link) || link.length < 5)) {
        fail('import.subgraphs.invalid', `subgraph '${raw['id']}' has malformed links`)
        continue
      }
      if (![mutable['inputs'], mutable['outputs']].every((slots) => Array.isArray(slots) && slots.every((slot) =>
        object(slot) && typeof slot['id'] === 'string' && slot['id'].length > 0 && slot['id'] !== '__proto__' &&
        (slot['type'] === undefined || typeof slot['type'] === 'string') &&
        (slot['linkIds'] === undefined || Array.isArray(slot['linkIds']))))) {
        fail('import.subgraphs.invalid', `subgraph '${raw['id']}' has malformed boundary slots`)
        continue
      }
      if ([mutable['inputs'], mutable['outputs']].some((slots) =>
        new Set(slots.map((slot: Mutable) => slot['id'])).size !== slots.length)) {
        fail('import.subgraphs.invalid', `subgraph '${raw['id']}' has duplicate boundary slot IDs`)
        continue
      }
      if ([mutable['inputNode'], mutable['outputNode']].some((node) => node !== undefined &&
        (!object(node) || (node['id'] !== undefined && !integerId(node['id']))))) {
        fail('import.subgraphs.invalid', `subgraph '${raw['id']}' has malformed boundary nodes`)
        continue
      }
      const inputId = Number(mutable['inputNode']?.['id'] ?? -10)
      const outputId = Number(mutable['outputNode']?.['id'] ?? -20)
      if (inputId === outputId || mutable['nodes'].some((node: Mutable) =>
        integerId(node?.['id']) && [inputId, outputId].includes(Number(node['id'])))) {
        fail('import.subgraphs.invalid', `subgraph '${raw['id']}' has colliding boundary node IDs`)
        continue
      }
      const inputNode = mutable['nodes'].reduce((max: number, node: Mutable) =>
        integerId(node?.['id']) ? Math.max(max, Number(node['id'])) : max, 0) + 1
      if (!Number.isSafeInteger(inputNode + 1)) {
        fail('import.subgraphs.invalid', `subgraph '${raw['id']}' exhausts node IDs`)
        continue
      }
      definitions.set(raw['id'], { raw: mutable, inputNode, outputNode: inputNode + 1, inline: false })
      collect(mutable, depth + 1)
    }
    delete graph['definitions']
  }
  collect(root, 0)
  if (diagnostics.length) return { diagnostics }
  if (!definitions.size) return importFlat(root as JsonObject, resolve, {})
  for (const graph of [root, ...[...definitions.values()].map((def) => def.raw)]) {
    if (!Array.isArray(graph['nodes']) || graph['nodes'].some((node: unknown) => !object(node) ||
      !integerId(node['id']) || Number(node['id']) < 0 || typeof node['type'] !== 'string' ||
      [node['inputs'], node['outputs']].some((slots) => slots !== undefined && (!Array.isArray(slots) || slots.some((slot) => !object(slot)))))) {
      fail('import.subgraphs.invalid', 'subgraph workflows require well-formed nodes and slot arrays')
    }
    if (graph['links'] !== undefined && (!Array.isArray(graph['links']) || graph['links'].some((link: unknown) =>
      !Array.isArray(link) || link.length < 5 || link.slice(0, 5).some((id) => !integerId(id))))) {
      fail('import.subgraphs.invalid', 'subgraph workflows require integer link endpoints')
    }
  }
  if (diagnostics.length) return { diagnostics }

  const graphs: Record<string, GraphDef> = Object.create(null)
  const views: Record<string, any> = Object.create(null)
  const schemas = new Map<string, NodeSchema>()
  const localResolve = (type: string): NodeSchema | undefined => schemas.get(type) ?? resolve(type)
  const visiting = new Set<string>()
  const done = new Set<string>()
  const instances = [root, ...[...definitions.values()].map((def) => def.raw)]
    .flatMap((graph) => Array.isArray(graph['nodes']) ? graph['nodes'] as Mutable[] : [])

  // Legacy proxy entries address widgets by node/name rather than by boundary slot.
  const proxySlots = new WeakMap<object, (string | undefined)[]>()
  const proxyControllers = new WeakMap<object, Map<number, string>>()
  const preparedControllers = new WeakMap<object, Mutable>()
  const exposeProxy = (def: Definition, nodeId: string, name: string, seen: Set<string>, disambiguator?: string): string | undefined => {
    const key = `${def.raw['id']}/${nodeId}/${name}/${disambiguator ?? ''}`
    if (seen.has(key)) return undefined
    seen.add(key)
    if (nodeId === '-1') return def.raw['inputs'].find((slot: Mutable) => slot['name'] === name)?.['id']
    const node = def.raw['nodes'].find((candidate: Mutable) => String(candidate['id']) === nodeId)
    if (!node) return undefined
    if (node['type'] === 'PrimitiveNode' && name === 'value') {
      const id = `proxy-primitive-${nodeId}`
      if (!def.raw['inputs'].some((slot: Mutable) => slot['id'] === id)) {
        def.raw['inputs'].push({ id, name: id, label: name, type: node['outputs']?.[0]?.['type'] ?? '*', proxyPrimitive: nodeId })
      }
      return id
    }
    if (!node['inputs']?.some((slot: Mutable) => slot['name'] === name || slot['widget']?.['name'] === name)) {
      let prefix: RegExpExecArray | null
      while ((prefix = /^(\d+):\s*/.exec(name)) !== null) {
        disambiguator = prefix[1]
        name = name.slice(prefix[0].length)
      }
    }
    const child = definitions.get(node['type'])
    let portName = name
    if (child) {
      const matchesTarget = (slot: Mutable, index: number): boolean => {
        const wire = child.raw['links'].find((link: any[]) => Number(link[1]) === -10 && link[2] === index)
        const target = wire && child.raw['nodes'].find((candidate: Mutable) => Number(candidate['id']) === Number(wire[3]))
        const input = target?.['inputs']?.[wire[4]]
        return disambiguator === undefined ? slot['name'] === name || slot['id'] === name
          : String(target?.['id']) === disambiguator && (input?.['name'] === name || input?.['widget']?.['name'] === name)
      }
      const matches = child.raw['inputs'].filter(matchesTarget)
      const exact = matches.length === 1 ? matches[0] : undefined
      if (exact) portName = exact['name']
      else {
        const proxies = node['properties']?.['proxyWidgets']
        const candidates = Array.isArray(proxies) ? proxies.filter((entry) => Array.isArray(entry) && entry[1] === name &&
          (disambiguator === undefined || String(entry[0]) === disambiguator)) : []
        const proxy = candidates.length === 1 ? candidates[0] : undefined
        if (!proxy) return undefined
        const childId = exposeProxy(child, String(proxy[0]), String(proxy[1]), seen)
        const slot = child.raw['inputs'].find((slot: Mutable) => slot['id'] === childId)
        if (!slot) return undefined
        portName = slot['name']
      }
    }
    node['inputs'] ??= []
    let index = node['inputs'].findIndex((slot: Mutable) => slot['name'] === portName || slot['widget']?.['name'] === portName)
    if (index < 0) {
      index = node['inputs'].length
      node['inputs'].push({ name: portName, widget: { name: portName }, link: null })
    }
    const existing = def.raw['links'].find((link: any[]) =>
      Number(link[1]) === -10 && Number(link[3]) === Number(nodeId) && link[4] === index)
    if (existing) return def.raw['inputs'][existing[2]]?.['id']
    // A connected inner widget already has a driver; its stored value stays dormant.
    if (def.raw['links'].some((link: any[]) => Number(link[3]) === Number(nodeId) && link[4] === index)) return undefined
    const boundaryIndex = def.raw['inputs'].length
    const id = `proxy-${nodeId}-${index}`
    const linkId = Math.max(0, ...def.raw['links'].map((link: any[]) => Number(link[0]))) + 1
    def.raw['inputs'].push({ id, name: id, label: name, type: '*', linkIds: [linkId] })
    def.raw['links'].push([linkId, -10, boundaryIndex, Number(nodeId), index, '*'])
    node['inputs'][index]['widget'] ??= { name: portName }
    node['inputs'][index]['link'] = linkId
    return id
  }
  for (const node of instances) {
    const def = definitions.get(node?.['type'])
    const proxies = node?.['properties']?.['proxyWidgets']
    if (!def || !Array.isArray(proxies) || !proxies.length) continue
    const controllers = new Map<number, string>()
    proxyControllers.set(node, controllers)
    proxySlots.set(node, proxies.map((entry, index) => {
      if (!Array.isArray(entry) || !integerId(entry[0]) || typeof entry[1] !== 'string') return undefined
      if (entry[1] === 'control_after_generate') {
        const target = def.raw['nodes'].find((candidate: Mutable) => String(candidate['id']) === String(entry[0]))
        const schema = target && resolve(target['type'])
        const widgets = schema ? inputsOf(schema).filter((item) => item.widget?.controller !== undefined) : []
        if (widgets.length !== 1 && target?.['type'] !== 'PrimitiveNode') return undefined
        const id = exposeProxy(def, String(entry[0]), target?.['type'] === 'PrimitiveNode' ? 'value' : widgets[0]!.id, new Set())
        if (id) controllers.set(index, id)
        return id
      }
      return exposeProxy(def, String(entry[0]), entry[1], new Set(), integerId(entry[2]) ? String(entry[2]) : undefined)
    }))
  }

  const prepareInstances = (raw: Mutable): void => {
    for (const node of raw['nodes'] ?? []) {
      const def = definitions.get(node?.['type'])
      if (!def?.schema) continue
      const values: Mutable = {}
      const controllers: Mutable = {}
      const rawValues = node['widgets_values']
      const proxies = proxySlots.get(node)
      const promoted = inputsOf(def.schema).filter((item) => item.widget !== undefined)
      const valueIds = proxies ?? (node['inputs'] ?? []).flatMap((slot: Mutable, index: number) =>
        slot['widget'] ? [def.raw['inputs'][index]?.['id']] : [])
      const ids = valueIds.length ? valueIds : promoted.map((item) => item.id)
      if (Array.isArray(rawValues)) {
        for (const [index, value] of rawValues.entries()) {
          const id = ids[index]
          const controllerId = proxyControllers.get(node)?.get(index)
          if (controllerId !== undefined && ['fixed', 'increment', 'decrement', 'randomize'].includes(value)) controllers[controllerId] = value
          else if (id !== undefined && controllerId === undefined) values[id] = value
          else diagnostics.push(diag('warning', 'import', 'import.subgraphs.widgetUnresolved', `subgraph instance ${node['id']} has an unresolved promoted widget at index ${index}; raw state is preserved`))
        }
      } else if (object(rawValues)) {
        for (const slot of def.raw['inputs']) {
          const key = Object.hasOwn(rawValues, slot['id']) ? slot['id'] : slot['name']
          if (Object.hasOwn(rawValues, key)) values[slot['id']] = rawValues[key]
        }
      }
      node['type'] = def.schema.type
      preparedControllers.set(node, controllers)
      node['properties'] = { ...node['properties'], 'dinkster.importedSubgraph': def.raw['id'], 'dinkster.rawWidgets': rawValues ?? [] }
      node['widgets_values'] = values
      node['inputs'] = def.raw['inputs'].map((slot: Mutable, index: number) => ({ ...node['inputs']?.[index], name: slot['id'] }))
      node['outputs'] = def.raw['outputs'].map((slot: Mutable, index: number) => ({ ...node['outputs']?.[index], name: slot['id'] }))
    }
  }

  const translate = (raw: Mutable): WorkflowDocument | undefined => {
    prepareInstances(raw)
    const result = importFlat(raw as JsonObject, localResolve, graphs)
    diagnostics.push(...result.diagnostics)
    if (!result.document) return undefined
    const doc: Mutable = JSON.parse(JSON.stringify(result.document))
    for (const [id, node] of Object.entries(doc['graphs']['g0']['nodes']) as [string, Mutable][]) {
      const def = [...definitions.values()].find((candidate) => candidate.schema?.type === node['type'])
      if (!def) continue
      const source = raw['nodes'].find((candidate: Mutable) => `n${candidate?.['id']}` === id)
      node['controllers'] = { ...node['controllers'], ...preparedControllers.get(source) }
      node['ext'] = { ...node['ext'], 'importer.subgraphWidgets': {
        values: source['properties']['dinkster.rawWidgets'], proxies: source['properties']['proxyWidgets'] ?? [],
      } }
      if (def.inline) {
        if (Object.keys(doc['graphs']['g0']['nodes']).length + Object.keys(def.body!['nodes']).length > 100_000) {
          fail('import.subgraphs.budget', 'inlined workflow exceeds 100000 nodes')
          return undefined
        }
        inlineInstance(doc['graphs']['g0'], doc['view']['graphs']['g0'], id, def)
      }
    }
    return doc as WorkflowDocument
  }

  const visit = (id: string, depth: number): void => {
    if (done.has(id)) return
    if (visiting.has(id) || depth > 64) {
      fail('import.subgraphs.cycle', `recursive subgraph definition '${id}' or excessive instance depth`)
      return
    }
    visiting.add(id)
    const def = definitions.get(id)!
    for (const node of def.raw['nodes']) if (definitions.has(node?.['type'])) visit(node['type'], depth + 1)
    if (diagnostics.some((item) => item.severity === 'error')) return
    const probeType = `litegraph-boundary:${id}`
    const probe: NodeSchema = {
      type: probeType, displayName: 'Import boundary', category: '', source: 'subgraph', isOutputNode: false,
      items: [
        ...def.raw['inputs'].map((_: unknown, index: number) => ({ kind: 'output', id: `i${index}`, type: { kind: 'wildcard' } })),
        ...def.raw['outputs'].map((_: unknown, index: number) => ({ kind: 'input', id: `o${index}`, type: { kind: 'wildcard' }, optional: true })),
      ],
    }
    schemas.set(probeType, probe)
    const inputId = def.raw['inputNode']?.['id'] ?? -10
    const outputId = def.raw['outputNode']?.['id'] ?? -20
    def.raw['links'] ??= []
    for (const link of def.raw['links']) {
      if (!Array.isArray(link)) continue
      for (const [nodeIndex, slotIndex, sentinel, replacement, side] of [
        [1, 2, inputId, def.inputNode, 'inputs'],
        [3, 4, outputId, def.outputNode, 'outputs'],
      ] as const) {
        if (Number(link[nodeIndex]) !== Number(sentinel)) continue
        if (link[slotIndex] === -1) {
          const matches = def.raw[side].flatMap((slot: Mutable, index: number) => slot['linkIds']?.includes(link[0]) ? [index] : [])
          if (matches.length === 1) link[slotIndex] = matches[0]
        }
        link[nodeIndex] = replacement
      }
    }
    // LiteGraph normalizeConfiguredTopology prefers input.link, otherwise document order.
    const deliveries = new Map<string, any[]>()
    const remapped = new Map<number, number>()
    for (const link of def.raw['links']) {
      const key = `${link[3]}:${link[4]}`
      const previous = deliveries.get(key)
      if (previous === undefined) deliveries.set(key, link)
      else {
        const target = def.raw['nodes'].find((node: Mutable) => Number(node?.['id']) === Number(link[3]))
        const preferred = target?.['inputs']?.[link[4]]?.['link']
        const winner = preferred === link[0] && preferred !== previous[0] ? link : previous
        const loser = winner === link ? previous : link
        deliveries.set(key, winner)
        remapped.set(loser[0], winner[0])
        diagnostics.push(diag('info', 'import', 'import.subgraphs.duplicateDelivery', `subgraph '${id}' has competing links at ${key}; LiteGraph selects link ${winner[0]}`))
      }
    }
    def.raw['links'] = [...deliveries.values()]
    for (const node of def.raw['nodes']) for (const slot of node?.['inputs'] ?? []) {
      const seen = new Set<number>()
      while (remapped.has(slot['link']) && !seen.has(slot['link'])) {
        seen.add(slot['link'])
        slot['link'] = remapped.get(slot['link'])
      }
    }
    def.raw['nodes'].push(
      { id: def.inputNode, type: probeType, outputs: def.raw['inputs'].map((_: unknown, index: number) => ({ name: `i${index}` })) },
      { id: def.outputNode, type: probeType, inputs: def.raw['outputs'].map((_: unknown, index: number) => ({ name: `o${index}` })) },
    )
    const doc = translate(def.raw)
    if (!doc) return
    const body = JSON.parse(JSON.stringify(doc.graphs['g0'])) as Mutable
    for (const [netId, net] of Object.entries(body['nets']) as [string, Mutable][]) {
      if (!nodeEnd(net['source'], `n${def.inputNode}`) && !net['sinks'].some((sink: Mutable) => nodeEnd(sink, `n${def.outputNode}`))) continue
      for (const sink of net['sinks']) {
        const linkId = `l${body['nextOrdinal']++}`
        body['links'][linkId] = { id: linkId, from: net['source'], to: sink }
      }
      delete body['nets'][netId]
    }
    def.body = JSON.parse(JSON.stringify(body))
    def.view = JSON.parse(JSON.stringify(doc.view.graphs['g0']))
    const nativeBody = body as GraphDef
    const links = Object.values(nativeBody.links)
    const bind = (end: any): BoundaryBinding | undefined =>
      typeof end.node === 'string' && typeof end.port === 'string' && end.node !== `n${def.inputNode}` && end.node !== `n${def.outputNode}`
        ? { kind: 'port', ...end } as BoundaryBinding : undefined
    let unsupported = false
    const boundary = (side: 'inputs' | 'outputs'): BoundaryItem[] => def.raw[side].flatMap((slot: Mutable, index: number) => {
      const ends = side === 'inputs'
        ? links.filter((link) => nodeEnd(link.from, `n${def.inputNode}`) && (link.from as any).port === `i${index}`).map((link) => link.to)
        : links.filter((link) => nodeEnd(link.to, `n${def.outputNode}`) && (link.to as any).port === `o${index}`).map((link) => link.from)
      const bindings = ends.map(bind)
      if (!bindings.length || bindings.some((item) => !item) || (side === 'outputs' && bindings.length !== 1)) {
        unsupported = true
        return []
      }
      const primary = bindings[0]!
      const rawLink = def.raw['links'].find((link: any[]) => link[1] === def.inputNode && link[2] === index)
      const target = rawLink && def.raw['nodes'].find((node: Mutable) => Number(node['id']) === Number(rawLink[3]))
      const promoted = side === 'inputs' && Boolean(target?.['inputs']?.[rawLink[4]]?.['widget'])
      return [{ id: slot['id'], displayName: slot['label'] ?? slot['name'] ?? slot['id'], binds: primary,
        ...(bindings.length > 1 ? { alsoBinds: bindings.slice(1) as BoundaryBinding[] } : {}),
        ...(promoted ? { promoted: true } : {}),
      }]
    })
    const candidate: GraphDef = {
      ...nativeBody, id: id as GraphDef['id'], name: def.raw['name'] ?? id,
      nodes: Object.fromEntries(Object.entries(nativeBody.nodes).filter(([key]) => key !== `n${def.inputNode}` && key !== `n${def.outputNode}`)),
      links: Object.fromEntries(Object.entries(nativeBody.links).filter(([, link]) =>
        !nodeEnd(link.from, `n${def.inputNode}`) && !nodeEnd(link.to, `n${def.outputNode}`))),
      boundary: { inputs: boundary('inputs'), outputs: boundary('outputs') },
    }
    const derived = deriveBoundarySchema(candidate, localResolve)
    def.inline = unsupported || !derived.schema
    if (def.inline) {
      diagnostics.push(diag('warning', 'import', 'import.subgraphs.inlined', `subgraph '${id}' is inlined per instance: ${unsupported ? 'boundary endpoint has no supported binding' : derived.diagnostics.map((item) => item.code).join(', ')}`))
      def.schema = {
        ...probe, type: `litegraph-inline:${id}`, displayName: candidate.name,
        items: [
          ...def.raw['inputs'].map((slot: Mutable) => ({ kind: 'input', id: slot['id'], type: { kind: 'wildcard' }, optional: true,
            widget: { widgetType: 'STRING', options: {} } })),
          ...def.raw['outputs'].map((slot: Mutable) => ({ kind: 'output', id: slot['id'], type: { kind: 'wildcard' } })),
        ],
      }
    } else {
      def.schema = derived.schema!
      graphs[id] = candidate
      const view = { ...def.view, nodes: { ...def.view!['nodes'] } }
      delete view.nodes[`n${def.inputNode}`]
      delete view.nodes[`n${def.outputNode}`]
      views[id] = view
    }
    schemas.set(def.schema.type, def.schema)
    visiting.delete(id)
    done.add(id)
  }
  for (const id of definitions.keys()) {
    visit(id, 0)
    if (diagnostics.some((item) => item.severity === 'error')) break
  }
  if (diagnostics.some((item) => item.severity === 'error')) return { diagnostics }
  const doc = translate(root)
  if (!doc) return { diagnostics }
  const result = { ...doc, view: { ...doc.view, graphs: { ...views, ...doc.view.graphs } },
    ext: { ...doc.ext, 'importer.litegraphDefinitions': input['definitions']! } }
  diagnostics.push(...validateDocumentShape(result as unknown as JsonObject), ...checkDocument(result))
  if (diagnostics.some((item) => item.severity === 'error')) return { diagnostics }
  const owned = ownJson(result)
  if (!owned.ok) return { diagnostics: [...diagnostics, diag('error', 'import', 'import.subgraphs.invalid', owned.reason)] }
  return { document: owned.value as unknown as WorkflowDocument, diagnostics }
}

/** Splice boundary probes, retaining child instances and occurrence-local state. */
function inlineInstance(graph: Mutable, view: Mutable, instanceId: string, def: Definition): void {
  const instance = graph['nodes'][instanceId]
  graph['ext'] ??= {}
  graph['ext']['importer.inlinedInstances'] = { ...graph['ext']['importer.inlinedInstances'],
    [instanceId]: { ...instance, definition: def.raw['id'] } }
  const body: Mutable = JSON.parse(JSON.stringify(def.body))
  const prefix = `${instanceId}_`
  const remapEnd = (end: Mutable): Mutable => Object.fromEntries(Object.entries(end).map(([key, value]) =>
    [key, ['node', 'reroute', 'valueSource', 'selector'].includes(key) ? `${prefix}${value}` : value]))
  const edges: Mutable[] = Object.values(graph['links'])
  // Nets become scoped explicit deliveries so a probe never remains a net source.
  for (const net of Object.values(graph['nets']) as Mutable[]) for (const sink of net['sinks']) edges.push({ from: net['source'], to: sink })
  graph['nets'] = {}
  for (const link of Object.values(body['links']) as Mutable[]) edges.push({ from: remapEnd(link['from']), to: remapEnd(link['to']) })
  for (const net of Object.values(body['nets']) as Mutable[]) for (const sink of net['sinks']) edges.push({ from: remapEnd(net['source']), to: remapEnd(sink) })
  const aliases = new Map<string, Mutable | undefined>()
  const inputProbe = `${prefix}n${def.inputNode}`
  const outputProbe = `${prefix}n${def.outputNode}`
  const drivers = new Map(edges.map((edge) => [endpointKey(edge['to']), edge['from'] as Mutable]))
  for (const [index, slot] of def.raw['inputs'].entries()) {
    if (slot['proxyPrimitive'] !== undefined) {
      const source = body['valueSources']?.[`v${slot['proxyPrimitive']}`]
      if (source && Object.hasOwn(instance['values'], slot['id'])) source['value'] = instance['values'][slot['id']]
      if (source && instance['controllers']?.[slot['id']]) source['controller'] = instance['controllers'][slot['id']]
      continue
    }
    let source = drivers.get(endpointKey({ node: instanceId, port: slot['id'] }))
    if (!source && Object.hasOwn(instance['values'], slot['id'])) {
      const id = `${prefix}value${index}`
      graph['valueSources'] ??= {}
      graph['valueSources'][id] = { id, value: instance['values'][slot['id']],
        ...(instance['controllers']?.[slot['id']] ? { controller: instance['controllers'][slot['id']] } : {}) }
      source = { valueSource: id }
    }
    aliases.set(endpointKey({ node: inputProbe, port: `i${index}` }), source)
  }
  const bypassSchema = parseObjectInfoEntry('boundary', {
    input: { required: Object.fromEntries(def.raw['inputs'].map((slot: Mutable) => [slot['id'], [slot['type'] ?? '*', { forceInput: true }]])) },
    output: def.raw['outputs'].map((slot: Mutable) => slot['type'] ?? '*'),
  }).schema
  const bypassInputs = bypassSchema ? inputsOf(bypassSchema).flatMap((item, index) => {
    const driver = drivers.get(endpointKey({ node: instanceId, port: item.id }))
    return driver ? [{ index, type: item.type, driver }] : []
  }) : []
  for (const [index, slot] of def.raw['outputs'].entries()) {
    let driver = drivers.get(endpointKey({ node: outputProbe, port: `o${index}` }))
    if (instance['mode'] === 'muted') driver = undefined
    if (instance['mode'] === 'bypassed') {
      const output = bypassSchema?.items.filter((item) => item.kind === 'output')[index]
      driver = output?.kind === 'output' ? matchBypassInput({ index, type: output.type }, bypassInputs)?.driver : undefined
    }
    aliases.set(endpointKey({ node: instanceId, port: slot['id'] }), driver)
  }
  const follow = (end: Mutable, seen = new Set<string>()): Mutable | undefined => {
    const key = endpointKey(end)
    if (!aliases.has(key)) return end
    if (seen.has(key)) return undefined
    seen.add(key)
    const next = aliases.get(key)
    return next && follow(next, seen)
  }
  graph['links'] = {}
  for (const edge of edges) {
    if (nodeEnd(edge['to'], instanceId) || nodeEnd(edge['to'], outputProbe)) continue
    const from = follow(edge['from'])
    if (!from) continue
    const id = `l${graph['nextOrdinal']++}`
    graph['links'][id] = { id, from, to: edge['to'] }
  }
  for (const collection of ['nodes', 'reroutes', 'valueSources', 'selectors']) {
    for (const [id, item] of Object.entries(body[collection] ?? {}) as [string, Mutable][]) {
      if (collection === 'nodes' && (id === `n${def.inputNode}` || id === `n${def.outputNode}`)) continue
      graph[collection] ??= {}
      graph[collection][`${prefix}${id}`] = { ...item, id: `${prefix}${id}`,
        ...(collection === 'nodes' && ['muted', 'bypassed'].includes(instance['mode']) ? { mode: 'muted' } : {}) }
    }
  }
  const position = view['nodes'][instanceId]?.['position'] ?? { x: 0, y: 0 }
  const positions = ['nodes', 'reroutes', 'valueSources'].flatMap((collection) =>
    Object.entries(def.view?.[collection] ?? {}).flatMap(([id, item]) =>
      id === `n${def.inputNode}` || id === `n${def.outputNode}` ? [] : [(item as Mutable)['position']]))
    .filter((point) => point !== undefined)
  const minX = positions.reduce((min, point) => Math.min(min, point.x), Infinity)
  const minY = positions.reduce((min, point) => Math.min(min, point.y), Infinity)
  const offset = { x: position.x - (Number.isFinite(minX) ? minX : 0), y: position.y - (Number.isFinite(minY) ? minY : 0) }
  for (const collection of ['nodes', 'reroutes', 'valueSources', 'groups']) {
    for (const [id, item] of Object.entries(def.view?.[collection] ?? {}) as [string, Mutable][]) {
      if (collection === 'nodes' && (id === `n${def.inputNode}` || id === `n${def.outputNode}`)) continue
      view[collection] ??= {}
      view[collection][`${prefix}${id}`] = { ...item,
        ...(item['position'] ? { position: { x: item['position'].x + offset.x, y: item['position'].y + offset.y } } : {}),
        ...(item['bounds'] ? { bounds: { ...item['bounds'], x: item['bounds'].x + offset.x, y: item['bounds'].y + offset.y } } : {}),
        ...(item['id'] ? { id: `${prefix}${id}` } : {}),
      }
    }
  }
  const notes = def.view?.['ext']?.['importer.notes']
  if (Array.isArray(notes)) {
    view['ext'] ??= {}
    view['ext']['importer.notes'] = [...view['ext']['importer.notes'] ?? [], ...notes.map((note: Mutable) =>
      ({ ...note, position: { x: note['position'].x + offset.x, y: note['position'].y + offset.y } }))]
  }
  delete graph['nodes'][instanceId]
  delete view['nodes'][instanceId]
}
