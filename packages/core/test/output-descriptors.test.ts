import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, documentResolver } from '../src/compile/compile.js'
import { upstreamRecipesEqual } from '../src/compile/recipe.js'
import { occurrenceDynamicView } from '../src/compile/occurrence-view.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import { parseDinksterNodes, parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { elaborateInterface, elabOutputsOf } from '../src/schema/elaborate.js'
import type { NodeSchema, OutputDescriptorsSpec } from '../src/schema/model.js'
import { parseOutputDescriptors } from '../src/schema/output-descriptors.js'

const spec: OutputDescriptorsSpec = {
  input: 'entries', minEntries: 0, maxEntries: 32, fixedIds: false,
  choices: [
    { id: 'float', type: { kind: 'concrete', name: 'core.float' }, preview: true },
    { id: 'string', type: { kind: 'concrete', name: 'core.string' }, optional: true },
  ],
}
const entries = [
  { id: 'm0', name: 'Result', type: 'float', expression: 'a+b' },
  { id: 'm1', name: 'Caption', type: 'string', value: 'hello' },
]
const literal = JSON.stringify({ entries, extra: { preserved: true } })
const schema: NodeSchema = {
  type: 'TestDescriptors', displayName: 'Descriptors', category: 'test', source: 'v3', isOutputNode: true,
  items: [
    { kind: 'input', id: 'entries', type: { kind: 'concrete', name: 'core.string' }, optional: false, widget: { widgetType: 'STRING', options: {}, default: literal } },
    { kind: 'output', id: 'entries', type: spec.choices[0]!.type, outputDescriptors: spec },
  ],
}
const sink: NodeSchema = { ...schema, type: 'Sink', items: [{ kind: 'input', id: 'in', type: spec.choices[0]!.type, optional: false }] }
const resolve = (type: string): NodeSchema | undefined => type === schema.type ? schema : type === sink.type ? sink : undefined
const outputRows = (s: NodeSchema, values: Record<string, unknown>) => elabOutputsOf(elaborateInterface(s, { values: values as Record<string, string> })).map((output) => [output.address.port, output.spec.displayName, output.spec.type])
const wire = {
  schemaVersion: 1,
  interface: [
    { role: 'input', id: 'entries', type: { kind: 'concrete', types: ['core.string'] }, required: true },
    { role: 'outputDescriptors', ...spec, choices: spec.choices.map((choice) => ({ ...choice, type: { kind: 'concrete', types: [choice.type.name] } })) },
  ],
}

function document(chained = false): WorkflowDocument {
  const graph = (id: string, nodes: unknown, boundary?: unknown) => ({ id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10, ...(boundary ? { boundary } : {}) })
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'descriptors', root: 'root', view: { graphs: {} },
    graphs: {
      root: graph('root', { a: { id: 'a', type: chained ? '#outer' : '#inner', values: { source: literal } }, b: { id: 'b', type: '#inner', values: {} } }),
      inner: graph('inner', { n: { id: 'n', type: schema.type, values: { entries: literal } } }, {
        inputs: [{ id: 'source', binds: { kind: 'port', node: 'n', port: 'entries' }, promoted: true }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'n', port: 'm0' } }],
      }),
      ...(chained ? { outer: graph('outer', { i: { id: 'i', type: '#inner', values: {} } }, {
        inputs: [{ id: 'source', binds: { kind: 'port', node: 'i', port: 'source' }, promoted: true }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'i', port: 'result' } }],
      }) } : {}),
    },
  } as unknown as WorkflowDocument
}
const run = (doc: WorkflowDocument) => compile({ document: doc, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test' })

describe('stored output descriptors', () => {
  it('requires concrete catalog choices and a required string source', () => {
    expect(parseDinksterSchema(schema.type, wire).schema?.items[1]).toMatchObject({ outputDescriptors: spec })
    for (const mutation of [
      { minEntries: -1 }, { maxEntries: 513 }, { minEntries: 33 }, { fixedIds: 'yes' }, { choices: [] },
      { choices: [{ id: 'bad', type: { kind: 'wildcard' } }] },
      { probe: { input: 'missing', kind: 'model', revision: '1' }, fixedIds: true },
    ]) {
      const altered = { ...wire, interface: [wire.interface[0], { ...wire.interface[1], ...mutation }] }
      expect(parseDinksterSchema(schema.type, altered).schema, JSON.stringify(mutation)).toBeUndefined()
    }
  })

  it('coexists with storage and media declarations', () => {
    const media = {
      role: 'input', id: 'image', required: true, acceptsStorage: true,
      type: { kind: 'concrete', types: ['dinkster.image'] }, alphaPolicy: 'require',
    }
    const catalog = (acceptsStorage: unknown) => ({ schemaVersion: 1, nodes: {
      [schema.type]: { ...wire, interface: [...wire.interface, { ...media, acceptsStorage }] },
    } })
    const parsed = parseDinksterNodes(catalog(true))
    expect(parsed.diagnostics).toEqual([])
    const decoded = parsed.schemas.get(schema.type)!
    expect(decoded.items[2]).toMatchObject({ acceptsStorage: true, alphaPolicy: 'require' })
    expect(outputRows(decoded, { entries: literal })).toEqual(outputRows(schema, { entries: literal }))
    expect(parseDinksterNodes(catalog('true')).schemas.size).toBe(0)
  })

  it('preserves choice policies through elaboration and boundary projection', () => {
    const policy = { alphaPolicy: 'require', maskPolarity: 'transparency', maskSemantic: 'alpha' }
    const catalog = (fields: Record<string, unknown>) => ({ schemaVersion: 1, nodes: {
      [schema.type]: { ...wire, interface: [wire.interface[0], {
        ...wire.interface[1], choices: spec.choices.map((choice) => ({
          ...choice, ...fields, type: { kind: 'concrete', types: [choice.type.name] },
        })),
      }] },
    } })
    const parsed = parseDinksterNodes(catalog(policy))
    expect(parsed.diagnostics).toEqual([])
    const decoded = parsed.schemas.get(schema.type)!
    for (const output of elabOutputsOf(elaborateInterface(decoded, { values: { entries: literal } }))) {
      expect(output.spec).toMatchObject(policy)
    }
    const derived = deriveBoundarySchema(document().graphs.inner!, () => decoded)
    expect(derived.diagnostics).toEqual([])
    expect(elabOutputsOf(elaborateInterface(derived.schema!, { values: {} }))[0]?.spec).toMatchObject(policy)
    for (const fields of [{ alphaPolicy: 'unknown' }, { maskPolarity: true }, { maskSemantic: 'unknown' }, { acceptsStorage: true }]) {
      expect(parseDinksterNodes(catalog(fields)).schemas.size).toBe(0)
    }
  })

  it('preserves raw IDs, ordered names, types, and node-owned data', () => {
    expect(parseOutputDescriptors(spec, literal)).toEqual({ ok: true, document: { entries, extra: { preserved: true } } })
    expect(outputRows(schema, { entries: literal })).toEqual([
      ['m0', 'Result', spec.choices[0]!.type], ['m1', 'Caption', spec.choices[1]!.type],
    ])
    const reordered = JSON.stringify({ entries: [{ ...entries[1], name: 'Title' }, entries[0]] })
    expect(outputRows(schema, { entries: reordered })).toEqual([
      ['m1', 'Title', spec.choices[1]!.type], ['m0', 'Result', spec.choices[0]!.type],
    ])
  })

  it('rejects malformed documents and never invents wildcard outputs', () => {
    for (const value of [null, '{}', '[]', 'bad', JSON.stringify({ entries: [entries[0], entries[0]] }),
      '{"entries":[],"extra":NaN}', '{"entries":[],"extra":Infinity}', '{"entries":[],"extra":-Infinity}',
      ...[{ id: 'a.b' }, { name: '  ' }, { name: 'a\0b' }, { name: 'x'.repeat(257) }, { type: 'unknown' }].map((mutation) => JSON.stringify({ entries: [{ ...entries[0], ...mutation }] })),
      JSON.stringify({ entries: [entries[0], { ...entries[1], name: 'Result' }] }),
      JSON.stringify({ entries: [], padding: '\u00e9'.repeat(524288) }),
      JSON.stringify({ entries: Array.from({ length: 513 }, (_, i) => ({ id: `m${i}`, name: `Name ${i}`, type: 'float' })) }),
    ]) {
      expect(parseOutputDescriptors(spec, value).ok, String(value).slice(0, 100)).toBe(false)
    }
    const connected = elaborateInterface(schema, { values: { entries: literal } }, { isInputConnected: () => true, isOutputConnected: () => false })
    expect(elabOutputsOf(connected)).toEqual([])
    expect(connected.diagnostics.some((d) => d.code === 'elab.outputDescriptors.linkedSource')).toBe(true)
  })

  it('rejects collisions with ordinary outputs and family IDs', () => {
    const collision = { ...schema, items: [...schema.items, { kind: 'output' as const, id: 'm0', type: spec.choices[0]!.type }] }
    expect(elaborateInterface(collision, { values: { entries: literal } }).diagnostics.some((d) => d.code === 'elab.outputDescriptors.collision')).toBe(true)
  })

  it('binds fixed IDs and profiles to asset digest and detector revision', () => {
    const profile: OutputDescriptorsSpec = { ...spec, fixedIds: true, probe: { input: 'checkpoint', kind: 'model', revision: '1' } }
    const digest = `blake3:${'1'.repeat(64)}`
    const value = JSON.stringify({ entries: [{ id: 'float', name: 'Model', type: 'float' }], assetDigest: digest, detectorRevision: '1' })
    expect(parseOutputDescriptors(profile, value, { digest }).ok).toBe(true)
    expect(parseOutputDescriptors(profile, value, { digest: `blake3:${'2'.repeat(64)}` }).ok).toBe(false)
    expect(parseOutputDescriptors({ ...profile, probe: { ...profile.probe!, revision: '2' } }, value, { digest }).ok).toBe(false)
    const invalidDigest = `sha256:${'1'.repeat(64)}`
    expect(parseOutputDescriptors(profile, value.replace(digest, invalidDigest), { digest: invalidDigest }).ok).toBe(false)
    expect(parseOutputDescriptors({ ...spec, fixedIds: true }, literal).ok).toBe(false)
  })

  it('refuses multiple descriptor constructs and counts names by Unicode code points', () => {
    const multiple = { ...wire, interface: [...wire.interface,
      { ...wire.interface[0], id: 'other' }, { ...wire.interface[1], input: 'other' },
    ] }
    expect(parseDinksterSchema(schema.type, multiple).schema).toBeUndefined()
    expect(parseOutputDescriptors(spec, JSON.stringify({ entries: [{ ...entries[0], name: '\u{1f600}'.repeat(256) }] })).ok).toBe(true)
    expect(parseOutputDescriptors(spec, JSON.stringify({ entries: [{ ...entries[0], name: '\u{1f600}'.repeat(257) }] })).ok).toBe(false)
  })

  it('refuses region-delivered descriptor literals', () => {
    const doc = document()
    Object.assign(doc.graphs.inner!.boundary!.inputs[0]!, { promoted: false })
    Object.assign(doc.graphs.root!.nodes.a!, { region: { kind: 'map', elementPorts: ['source'] } })
    const result = compile({ document: doc, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'compile.outputFamily.linkedCount')).toBe(true)
  })

  it('retains region gather list types for definition-local descriptors', () => {
    const doc = document()
    Object.assign(doc.graphs.inner!.boundary!, { inputs: [] })
    const derived = deriveBoundarySchema(doc.graphs.inner!, resolve, { kind: 'map' })
    expect(derived.diagnostics).toEqual([])
    expect(outputRows(derived.schema!, {})).toEqual([['result', 'Result', { kind: 'list', element: spec.choices[0]!.type }]])
  })

  it('includes each name, type and ordering change in the recipe', () => {
    const doc = document()
    const original = run(doc)
    expect(original.ok).toBe(true)
    for (const next of [[...entries].reverse(), [{ ...entries[0], name: 'Renamed' }, entries[1]], [{ ...entries[0], type: 'string' }, entries[1]]]) {
      const changed = JSON.parse(JSON.stringify(doc)) as WorkflowDocument
      Object.assign(changed.graphs.root!.nodes.a!.values, { source: JSON.stringify({ entries: next, extra: { preserved: true } }) })
      const result = run(changed)
      expect(result.ok).toBe(true)
      if (original.ok && result.ok) expect(upstreamRecipesEqual(original.artifact.prompt, result.artifact.prompt, 'a.n')).toBe(false)
    }
  })

  it('projects promoted source literals through chained boundaries with definition fallback', () => {
    const doc = document(true)
    const resolver = documentResolver(doc, resolve)
    const outer = resolver('#outer')!
    expect(outputRows(outer, { source: literal })).toEqual([['out', 'Result', spec.choices[0]!.type]])
    expect(outputRows(outer, {})).toEqual([['out', 'Result', spec.choices[0]!.type]])
    const changed = JSON.stringify({ entries: [{ id: 'm0', name: 'Changed', type: 'string', value: 'text' }] })
    const store = new DocumentStore(doc, coreCommandRegistry([], resolve))
    expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'a', inputId: 'source', value: changed } }).ok).toBe(true)
    expect(occurrenceDynamicView(store.doc, documentResolver(store.doc, resolve), ['a', 'i']).values.get('n')?.entries).toBe(changed)
    expect(occurrenceDynamicView(store.doc, documentResolver(store.doc, resolve), ['b']).values.get('n')?.entries ?? literal).toBe(literal)
    const result = run(store.doc)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['a.i.n']?.inputs.entries).toBe(changed)
    const restored = JSON.parse(JSON.stringify(store.doc)) as WorkflowDocument
    expect(run(restored).ok).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.a!.values.source).toBe(literal)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.root!.nodes.a!.values.source).toBe(changed)
  })

  it('retains source-only probe contracts and occurrence assets through chained boundaries', () => {
    const profile: OutputDescriptorsSpec = { ...spec, fixedIds: true, probe: { input: 'checkpoint', kind: 'model', revision: '1' } }
    const asset = { digest: `blake3:${'1'.repeat(64)}` }
    const profiled: NodeSchema = { ...schema, items: [
      schema.items[0]!,
      { kind: 'input', id: 'checkpoint', type: { kind: 'concrete', name: 'dinkster.asset' }, optional: false, widget: { widgetType: 'ASSET', options: {} } },
      { kind: 'output', id: 'entries', type: spec.choices[0]!.type, outputDescriptors: profile },
    ] }
    const doc = document(true)
    Object.assign(doc.graphs.inner!.nodes.n!.values, { checkpoint: asset })
    Object.assign(doc.graphs.inner!.boundary!, { outputs: [], inputs: [
      ...doc.graphs.inner!.boundary!.inputs,
      { id: 'asset', binds: { kind: 'port', node: 'n', port: 'checkpoint' }, promoted: true },
    ] })
    Object.assign(doc.graphs.outer!.boundary!, { outputs: [], inputs: [
      ...doc.graphs.outer!.boundary!.inputs,
      { id: 'asset', binds: { kind: 'port', node: 'i', port: 'asset' }, promoted: true },
    ] })
    const resolver = documentResolver(doc, (type) => type === schema.type ? profiled : resolve(type))
    for (const type of ['#inner', '#outer']) {
      const derived = resolver(type)!
      expect(derived.items.filter((item) => item.kind === 'output')).toEqual([])
      expect(derived.items.find((item) => item.id === 'source')).toMatchObject({
        kind: 'input', outputDescriptors: {
          input: 'source', probe: { input: 'asset', kind: 'model', revision: '1' },
          boundaryProjection: { fallback: literal, assetFallback: asset },
        },
      })
    }
    const changedAsset = { digest: `blake3:${'2'.repeat(64)}` }
    Object.assign(doc.graphs.root!.nodes.a!.values, { asset: changedAsset })
    expect(occurrenceDynamicView(doc, resolver, ['a', 'i']).values.get('n')?.checkpoint).toEqual(changedAsset)
  })

  it('preserves links across reorder, rename, removal, save and undo', () => {
    const doc = document(true)
    Object.assign(doc.graphs.root!.nodes, { sink: { id: 'sink', type: 'Sink', values: {} } })
    Object.assign(doc.graphs.root!.links, { l0: { id: 'l0', from: { node: 'a', port: 'out' }, to: { node: 'sink', port: 'in' } } })
    const store = new DocumentStore(doc, coreCommandRegistry([], resolve))
    const before = run(store.doc)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const value = JSON.stringify({ entries: [entries[1], { ...entries[0], name: 'Renamed' }], extra: { preserved: true } })
    expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'a', inputId: 'source', value } }).ok).toBe(true)
    const reordered = run(store.doc)
    expect(reordered.ok, JSON.stringify(!reordered.ok && reordered.diagnostics)).toBe(true)
    if (reordered.ok) expect(reordered.artifact.prompt.sink!.inputs.in).toEqual(['a.i.n', 1])
    expect(JSON.parse(JSON.stringify(store.doc)).graphs.root.links).toEqual(doc.graphs.root!.links)
    expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'a', inputId: 'source', value: '{"entries":[]}' } }).ok).toBe(true)
    expect(run(store.doc).ok).toBe(false)
    expect(store.doc.graphs.root!.links).toEqual(doc.graphs.root!.links)
    expect(store.undo()).toBe(true)
    expect(run(store.doc).ok).toBe(true)
  })

  it('projects alsoBinds to each descriptor owner and refuses forwarded linked sources', () => {
    const doc = document()
    Object.assign(doc.graphs.inner!.nodes, { second: { id: 'second', type: schema.type, values: { entries: literal } } })
    Object.assign(doc.graphs.inner!.boundary!.inputs[0]!, { alsoBinds: [{ kind: 'port', node: 'second', port: 'entries' }] })
    const changed = JSON.stringify({ entries: [{ ...entries[0], name: 'Shared' }] })
    const store = new DocumentStore(doc, coreCommandRegistry([], resolve))
    store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'a', inputId: 'source', value: changed } })
    const result = run(store.doc)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.prompt['a.n']!.inputs.entries).toBe(changed)
      expect(result.artifact.prompt['a.second']!.inputs.entries).toBe(changed)
    }
    const linked = JSON.parse(JSON.stringify(store.doc)) as WorkflowDocument
    Object.assign(linked.graphs.root!.links, { bad: { id: 'bad', from: { node: 'b', port: 'result' }, to: { node: 'a', port: 'source' } } })
    expect(run(linked).ok).toBe(false)
  })
})
