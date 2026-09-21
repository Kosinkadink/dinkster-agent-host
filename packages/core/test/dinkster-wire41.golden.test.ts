import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes, typeExprFromDinksterWire,
  type DinksterWireSchema,
} from '../src/schema/dinkster-wire.js'
import { typeExprToDinksterWire } from '../src/compile/dinkster-graph.js'
import { canonicalTypeIdOf, cardinalityOf, inputsOf, outputsOf, typeExprFromTypeId } from '../src/schema/model.js'
import { elabInputsOf, elaborateInterface } from '../src/schema/elaborate.js'
import { typesDirectlyCompatible } from '../src/schema/compat.js'
import { typeMatchesToken } from '../src/search-filters.js'
import { solveGraphTypes } from '../src/schema/solve.js'
import { asNodeId } from '../src/ids.js'
import type { GraphDef } from '../src/format/document.js'

const bytes = readFileSync(new URL('../fixtures/dinkster-wire41.json', import.meta.url))
const fixtures: (DinksterWireSchema & { nodeType: string })[] = JSON.parse(bytes.toString('utf8'))
const image = { kind: 'concrete', types: ['dinkster.image'] }
const stream = { kind: 'stream', element: image }
const input = (type: unknown = image, flags: Record<string, unknown> = {}) => ({ role: 'input', id: 'image', type, required: true, ...flags })
const output = (type: unknown = image) => ({ role: 'output', id: 'image', type })
const parse = (entries: unknown[], fields: Record<string, unknown> = {}, version = 41) => parseDinksterNodes({
  schemaVersion: version,
  nodes: { Test: { schemaVersion: version, interface: entries, ...fields } },
})
const wrappers: Record<string, (leaf: unknown) => unknown> = {
  input: (leaf) => leaf,
  family: (leaf) => ({ role: 'inputFamily', id: 'group', template: [leaf] }),
  combo: (leaf) => ({ role: 'dynamicCombo', id: 'mode', options: [{ key: 'a', inputs: [leaf] }] }),
  slot: (leaf) => ({ role: 'dynamicSlot', id: 'slot', required: false, slotType: image, inputs: [leaf] }),
  variant: (leaf) => ({ role: 'dynamicSlot', id: 'slot', required: true, variants: [{ key: 'a', type: image, inputs: [leaf] }] }),
}

describe('schema wire 41 serializer fixtures', () => {
  it('accepts the exact backend serializer export and preserves declarations', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('dcb5bdace1e7448bb0980230e9ac271518db8e340732ad9d56ea9ba3df3c0c29')
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(41)
    const parsed = parseDinksterNodes({ schemaVersion: 41, nodes: Object.fromEntries(fixtures.map((schema) => [schema.nodeType, schema])) })
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.schemas.size).toBe(4)
    expect(typeExprToDinksterWire(outputsOf(parsed.schemas.get('test.stream_source')!)[0]!.type)).toEqual(stream)
    expect(inputsOf(parsed.schemas.get('test.stream_sink')!)[0]).toMatchObject({ acceptsStorage: true, acceptsStream: true })
    for (const fixture of fixtures.filter((schema) => schema.chunkSafe)) {
      expect(parsed.schemas.get(fixture.nodeType)?.chunkSafe).toEqual(fixture.chunkSafe)
    }
    expect(JSON.parse(JSON.stringify([...parsed.schemas]))).toEqual([...parsed.schemas])
  })

  it('decodes the transferred composed backend example without dropping storage or stream declarations', () => {
    const exampleBytes = readFileSync(new URL('../fixtures/dinkster-wire41-composed.json', import.meta.url))
    expect(createHash('sha256').update(exampleBytes).digest('hex')).toBe('19dfbb9284fa47bbce9684443ae7111b36be6d504f10faacfa5e2eae3e3cab53')
    const example = JSON.parse(exampleBytes.toString('utf8')) as DinksterWireSchema & { nodeType: string }
    const parsed = parseDinksterNodes({ schemaVersion: 41, nodes: { [example.nodeType]: example } })
    expect(parsed.diagnostics).toEqual([])
    const schema = parsed.schemas.get(example.nodeType)!
    expect(inputsOf(schema)[0]).toMatchObject({ acceptsStorage: true, acceptsStream: true })
    expect(schema.chunkSafe).toEqual(example.chunkSafe)
    expect(typeExprToDinksterWire(outputsOf(schema)[0]!.type, 41)).toEqual(stream)
    expect(typeExprToDinksterWire(outputsOf(schema)[0]!.type, 40)).toBeUndefined()
    expect(parseDinksterNodes({ schemaVersion: 40, nodes: { [example.nodeType]: { ...example, schemaVersion: 40 } } }).schemas.size).toBe(0)
  })

  it.each(Object.entries(wrappers))('preserves recursive input flags in %s and rejects downgrades', (_, wrap) => {
    const entries = [wrap(input(image, { acceptsStream: true, acceptsStorage: true, alphaPolicy: 'require' }))]
    const parsed = parse(entries)
    expect(parsed.diagnostics).toEqual([])
    expect(JSON.stringify(parsed.schemas.get('Test'))).toContain('"acceptsStream":true')
    expect(JSON.stringify(parsed.schemas.get('Test'))).toContain('"alphaPolicy":"require"')
    for (const version of [39, 40]) expect(parse(entries, {}, version).schemas.size).toBe(0)
    const omitted = parse([wrap(input())])
    expect(omitted.diagnostics).toEqual([])
    expect(JSON.stringify(omitted.schemas.get('Test'))).not.toContain('acceptsStream')
    const normalized = parse([wrap(input(image, { acceptsStream: false }))])
    expect(normalized.diagnostics).toEqual([])
    expect(normalized.schemas.get('Test')).toEqual(omitted.schemas.get('Test'))
  })

  it.each([null, 0, 1, 'true', [], {}, undefined])('refuses non-Boolean acceptsStream: %j', (acceptsStream) => {
    expect(parse([input(image, { acceptsStream })]).schemas.size).toBe(0)
  })

  it.each(DINKSTER_ACCEPTED_WIRE_VERSIONS.filter((version) => version < 41))('rejects all new field presence below 41 (wire %s)', (version) => {
    for (const acceptsStream of [false, true, null, undefined]) {
      expect(parse([input(image, { acceptsStream })], {}, version).schemas.size).toBe(0)
    }
    for (const chunkSafe of [undefined, null, { inputs: ['image'], outputs: ['image'] }]) {
      expect(parse([input(), output()], { chunkSafe }, version).schemas.size).toBe(0)
    }
    expect(parse([output(stream)], {}, version).schemas.size).toBe(0)
  })

  const locations = {
    ...Object.fromEntries(Object.entries(wrappers).map(([key, wrap]) => [key, (type: unknown) => wrap(input(type))])),
    output,
    outputFamily: (type: unknown) => ({ role: 'outputFamily', id: 'images', type }),
    slotType: (type: unknown) => ({ role: 'dynamicSlot', id: 'slot', required: false, slotType: type, inputs: [] }),
    variantType: (type: unknown) => ({ role: 'dynamicSlot', id: 'slot', required: true, variants: [{ key: 'a', type, inputs: [] }] }),
  }
  it.each(Object.entries(locations))('negotiates every recursive type path: %s', (_, make) => {
    for (const type of [stream, { kind: 'list', element: stream }, { kind: 'asset', element: stream }]) {
      expect(parse([make(type)]).diagnostics).toEqual([])
      for (const version of [39, 40]) {
        const refused = parse([make(type)], {}, version)
        expect(refused.schemas.size).toBe(0)
        expect(refused.diagnostics[0]?.message).toContain('stream type requires schema wire 41')
      }
      const model = typeExprFromDinksterWire(type, 41)
      expect(typeExprToDinksterWire(model, 41)).toEqual(type)
      expect(typeExprToDinksterWire(model, 40)).toBeUndefined()
      expect(() => typeExprFromDinksterWire(type, 40)).toThrow('schema wire 41')
    }
  })

  it('accepts an ASSET widget whose fully-concrete asset type contains a stream', () => {
    const type = { kind: 'asset', element: stream }
    const parsed = parse([input(type, { widget: { type: 'ASSET', accept: ['image/png'] } })])
    expect(parsed.diagnostics).toEqual([])
    expect(canonicalTypeIdOf(inputsOf(parsed.schemas.get('Test')!)[0]!.type)).toBe('asset<stream<dinkster.image>>')
  })

  it('keeps stream identity recursive, scalar, and distinct from values/lists/assets', () => {
    const model = typeExprFromDinksterWire(stream)
    expect(cardinalityOf(model)).toBe('scalar')
    expect(canonicalTypeIdOf(model)).toBe('stream<dinkster.image>')
    expect(typeExprFromTypeId('stream<dinkster.image>')).toEqual(model)
    expect(typesDirectlyCompatible(model, typeExprFromTypeId('stream<comfy.IMAGE>'))).toBe(true)
    for (const name of ['dinkster.image', 'list<dinkster.image>', 'asset<dinkster.image>']) {
      expect(typesDirectlyCompatible(model, typeExprFromTypeId(name))).toBe(false)
      expect(typeMatchesToken(model, name)).toBe(name === 'dinkster.image')
    }
    for (const kind of ['asset', 'list'] as const) {
      expect(typesDirectlyCompatible({ kind: 'stream', element: { kind: 'wildcard' } }, { kind, element: { kind: 'wildcard' } })).toBe(false)
      expect(typesDirectlyCompatible({ kind, element: { kind: 'wildcard' } }, { kind: 'stream', element: { kind: 'wildcard' } })).toBe(false)
    }
    expect(typeMatchesToken(model, 'stream<dinkster.image>')).toBe(true)
  })

  it('refuses canonical stream IDs smuggled through atom/union/variable fields', () => {
    for (const type of [
      { kind: 'concrete', types: ['stream<dinkster.image>'] },
      { kind: 'union', types: ['core.int', 'stream<dinkster.image>'] },
      { kind: 'variable', templateId: 'T', allowed: ['stream<dinkster.image>'] },
    ]) expect(parse([input(type)]).schemas.size).toBe(0)
    expect(typeExprToDinksterWire({ kind: 'concrete', name: 'stream<dinkster.image>' })).toBeUndefined()
    expect(typeExprToDinksterWire({ kind: 'union', names: ['core.int', 'stream<dinkster.image>'] })).toBeUndefined()
    expect(typeExprToDinksterWire({ kind: 'variable', templateId: 'T', allowedTypes: [typeExprFromTypeId('stream<dinkster.image>')] })).toBeUndefined()
  })

  it('binds type variables recursively through stream elements', () => {
    const source = parse([output(stream)]).schemas.get('Test')!
    const generic = { kind: 'stream', element: { kind: 'variable', templateId: 'T' } }
    const sink = parse([input(generic), output(generic)]).schemas.get('Test')!
    const graph = {
      id: 'g', name: 'Streams', nodes: {
        source: { id: 'source', type: 'Source', values: {} },
        sink: { id: 'sink', type: 'Sink', values: {} },
      },
      links: { l: { id: 'l', from: { node: 'source', port: 'image' }, to: { node: 'sink', port: 'image' } } },
      nets: {}, reroutes: {}, nextOrdinal: 1,
    } as unknown as GraphDef
    const solved = solveGraphTypes(graph, (type) => type === 'Source' ? source : sink)
    expect(solved.diagnostics).toEqual([])
    expect(canonicalTypeIdOf(solved.portTypeOf(asNodeId('sink'), 'output', 'image')!)).toBe('stream<comfy.IMAGE>')
  })

  it.each([
    { name: 'storage only', storage: true, descriptors: false, policies: false, streams: false },
    { name: 'descriptors only', storage: false, descriptors: true, policies: false, streams: false },
    { name: 'storage and descriptors', storage: true, descriptors: true, policies: false, streams: false },
    { name: 'storage, descriptors and policies', storage: true, descriptors: true, policies: true, streams: false },
    { name: 'storage, descriptors, policies and streams', storage: true, descriptors: true, policies: true, streams: true },
  ])('preserves coexistence and downgrade boundaries: $name', ({ storage, descriptors, policies, streams }) => {
    const entries = [input(image, {
      ...(storage ? { acceptsStorage: true } : {}),
      ...(policies ? { alphaPolicy: 'require' } : {}),
      ...(streams ? { acceptsStream: true } : {}),
    }), output(streams ? stream : image)]
    const descriptorEntries = descriptors ? [
      { role: 'input', id: 'entries', required: true, type: { kind: 'concrete', types: ['core.string'] } },
      { role: 'outputDescriptors', input: 'entries', choices: [{ id: 'image', type: image, ...(policies ? { alphaPolicy: 'drop' } : {}) }], minEntries: 1, maxEntries: 4, fixedIds: false },
    ] : []
    const fields = streams ? { chunkSafe: { inputs: ['image'], outputs: ['image'] } } : {}
    for (const version of [39, 40, 41]) {
      const parsed = parse([...entries, ...descriptorEntries], fields, version)
      if ((policies && version < 40) || (streams && version < 41)) {
        expect(parsed.schemas.size).toBe(0)
        continue
      }
      expect(parsed.diagnostics).toEqual([])
      const schema = parsed.schemas.get('Test')!
      const value = inputsOf(schema)[0]!
      expect(value.acceptsStorage).toBe(storage ? true : undefined)
      expect(value.acceptsStream).toBe(streams ? true : undefined)
      expect(value.alphaPolicy).toBe(policies ? 'require' : undefined)
      expect(cardinalityOf(value.type)).toBe('scalar')
      expect(typeExprToDinksterWire(outputsOf(schema)[0]!.type, version)).toEqual(streams ? stream : image)
      const choice = outputsOf(schema).find((item) => item.outputDescriptors)?.outputDescriptors?.choices[0]
      expect(choice !== undefined).toBe(descriptors)
      expect(choice?.alphaPolicy).toBe(descriptors && policies ? 'drop' : undefined)
      expect(schema.chunkSafe).toEqual(streams ? fields.chunkSafe : undefined)
    }
  })

  it('composes storage, media policies and concrete output descriptors without admitting stream choices', () => {
    const descriptors = (type: unknown) => ({ role: 'outputDescriptors', input: 'entries', choices: [{ id: 'image', type, alphaPolicy: 'drop' }], minEntries: 1, maxEntries: 4, fixedIds: false })
    const entries = [input(image, { acceptsStream: true, acceptsStorage: true, alphaPolicy: 'require' }),
      { role: 'input', id: 'entries', required: true, type: { kind: 'concrete', types: ['core.string'] } }]
    const parsed = parse([...entries, descriptors(image)])
    expect(parsed.diagnostics).toEqual([])
    expect(outputsOf(parsed.schemas.get('Test')!)[0]?.outputDescriptors?.choices[0]?.alphaPolicy).toBe('drop')
    expect(parse([...entries, descriptors(stream)]).schemas.size).toBe(0)
  })

  it.each([
    null, {}, { inputs: [], outputs: ['image'] }, { inputs: ['image', 'image'], outputs: ['image'] },
    { inputs: [1], outputs: ['image'] }, { inputs: ['missing'], outputs: ['image'] },
    { inputs: ['image'], outputs: ['missing'] }, { inputs: ['operation'], outputs: ['image'] },
    { inputs: ['image'], outputs: ['image'], unknown: true },
    { inputs: ['image'], outputs: ['image'], applies: null },
    { inputs: ['image'], outputs: ['image'], applies: {} },
    { inputs: ['image'], outputs: ['image'], applies: { missing: ['map'] } },
    { inputs: ['image'], outputs: ['image'], applies: { operation: ['missing'] } },
  ])('rejects invalid chunkSafe declarations: %j', (chunkSafe) => {
    const entries = fixtures[3]!.interface as unknown[]
    expect(parse(entries, { chunkSafe }).schemas.size).toBe(0)
  })

  it.each([false, undefined])('rejects chunkSafe scopes on optional selectors (required=%j)', (required) => {
    const raw = fixtures[3]!
    const entries = structuredClone(raw.interface) as Record<string, unknown>[]
    if (required === undefined) delete entries[1]!['required']
    else entries[1]!['required'] = required
    expect(parse(entries, { chunkSafe: raw.chunkSafe }).schemas.size).toBe(0)
  })

  it('preserves prototype-named scope keys and rejects undeclared selectors', () => {
    const raw = fixtures[3]!
    const entries = structuredClone(raw.interface) as Record<string, unknown>[]
    entries[0]!['acceptsStream'] = true
    const applies = JSON.parse('{"__proto__":["map"]}')
    const chunkSafe = { inputs: ['image'], outputs: ['image'], applies }
    expect(parse(entries, { chunkSafe }).schemas.size).toBe(0)
    entries[1]!['id'] = '__proto__'
    const parsed = parse(entries, { chunkSafe })
    expect(parsed.diagnostics).toEqual([])
    const schema = parsed.schemas.get('Test')!
    expect(Object.hasOwn(schema.chunkSafe!.applies!, '__proto__')).toBe(true)
    expect(schema.chunkSafe!.applies).toEqual(applies)
    for (const selected of ['map', 'reverse']) {
      const dynamic = JSON.parse(JSON.stringify({ ['__proto__']: { selected } }))
      const effective = elaborateInterface(schema, { values: {}, dynamic })
      expect(effective.chunkSafe).toEqual(selected === 'map' ? { inputs: ['image'], outputs: ['image'] } : undefined)
      expect(elabInputsOf(effective)[0]?.spec.acceptsStream).toBe(selected === 'map' ? true : undefined)
    }
  })

  it('scopes chunk safety and stream acceptance without changing storage, graph state or source schema', () => {
    const raw = fixtures[3]!
    const schema = parse([input(image, { acceptsStream: true, acceptsStorage: true }), ...(raw.interface as unknown[]).slice(1)], { chunkSafe: raw.chunkSafe }).schemas.get('Test')!
    const before = JSON.stringify(schema)
    const active = elaborateInterface(schema, { values: {}, dynamic: { operation: { selected: 'map' } } })
    expect(active.chunkSafe).toEqual({ inputs: ['image'], outputs: ['image'] })
    expect(elabInputsOf(active)[0]?.spec.acceptsStream).toBe(true)
    const inactive = elaborateInterface(schema, { values: {}, dynamic: { operation: { selected: 'reverse' } } })
    expect(inactive.chunkSafe).toBeUndefined()
    expect(elabInputsOf(inactive)[0]?.spec).not.toHaveProperty('acceptsStream')
    expect(elabInputsOf(inactive)[0]?.spec.acceptsStorage).toBe(true)
    expect(JSON.stringify(schema)).toBe(before)
  })
})
