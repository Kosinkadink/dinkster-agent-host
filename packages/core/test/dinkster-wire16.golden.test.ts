import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile, scopeClosure } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import {
  DINKSTER_ACCEPTED_WIRE_VERSIONS,
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchemaWire15,
  parseDinksterSchemaWire16,
  type DinksterNodesPayload,
  type DinksterWireSchema,
} from '../src/schema/dinkster-wire.js'
import { elaborateInterface, elabInputsOf, elabOutputsOf } from '../src/schema/elaborate.js'
import { inputsOf, outputsOf, type InputSpec, type NodeSchema } from '../src/schema/model.js'

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(
  readFileSync(join(here, '../fixtures/dinkster-nodes-wire16.json'), 'utf8'),
) as DinksterNodesPayload

const ordinary = (lazy?: unknown): Record<string, unknown> => ({
  role: 'input',
  id: 'value',
  type: { kind: 'concrete', types: ['core.int'] },
  required: false,
  ...(lazy !== undefined ? { lazy } : {}),
})

const output = (role: 'output' | 'outputFamily', preview?: unknown): Record<string, unknown> => ({
  role,
  id: role === 'output' ? 'result' : 'results',
  type: { kind: 'concrete', types: ['core.int'] },
  ...(role === 'outputFamily' ? { memberPrefix: 'member' } : {}),
  ...(preview !== undefined ? { preview } : {}),
})

const nestedEntries = (lazy?: unknown): readonly Record<string, unknown>[] => [
  {
    role: 'inputFamily', id: 'family', memberPrefix: 'member',
    template: [ordinary(lazy)],
  },
  {
    role: 'dynamicCombo', id: 'combo',
    options: [{ key: 'on', inputs: [ordinary(lazy)] }],
  },
  {
    role: 'dynamicSlot', id: 'variant_slot', required: false,
    inputs: [{ ...ordinary(lazy), id: 'shared' }],
    variants: [{
      key: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] },
      inputs: [{ ...ordinary(lazy), id: 'variant' }],
    }],
  },
  {
    role: 'dynamicSlot', id: 'open_slot', required: false,
    slotType: { kind: 'concrete', types: ['comfy.IMAGE'] },
    inputs: [{ ...ordinary(lazy), id: 'dependent' }],
  },
]

const nestedOrdinaryInputs = (schema: NodeSchema): readonly InputSpec[] => {
  const out: InputSpec[] = []
  const visit = (input: InputSpec): void => {
    if (input.dynamic === undefined) {
      out.push(input)
      return
    }
    switch (input.dynamic.kind) {
      case 'autogrow':
        input.dynamic.template.forEach(visit)
        break
      case 'dynamicCombo':
        input.dynamic.options.forEach((option) => option.inputs.forEach(visit))
        break
      case 'dynamicSlot':
        input.dynamic.inputs.forEach(visit)
        input.dynamic.variants?.forEach((variant) => variant.inputs.forEach(visit))
        break
    }
  }
  inputsOf(schema).forEach(visit)
  return out
}

const decode16 = (interfaceEntries: readonly Record<string, unknown>[]): NodeSchema => {
  const result = parseDinksterSchemaWire16('test.lazy', { schemaVersion: 16, interface: interfaceEntries })
  expect(result.diagnostics).toEqual([])
  expect(result.schema).toBeDefined()
  return result.schema!
}

describe('schema wire 16 lazy ordinary inputs', () => {
  it('keeps the cross-language golden payload ready before backend publication', () => {
    const result = parseDinksterNodes(golden)
    expect(result.diagnostics).toEqual([])
    expect([...result.schemas]).toHaveLength(1)
    const schema = result.schemas.get('test.lazy_matrix')!
    expect(inputsOf(schema).slice(0, 3).map((input) => input.lazy)).toEqual([undefined, undefined, true])
    expect(nestedOrdinaryInputs(schema).filter((input) => input.id !== 'absent' && input.id !== 'false' && input.id !== 'true'))
      .toHaveLength(5)
    expect(nestedOrdinaryInputs(schema).filter((input) => input.id !== 'absent' && input.id !== 'false' && input.id !== 'true')
      .every((input) => input.lazy === true)).toBe(true)
    expect(outputsOf(schema).map((item) => item.preview)).toEqual([undefined, undefined, true, true])
  })

  it.each(['output', 'outputFamily'] as const)('normalizes wire-16 %s preview absent/false/true', (role) => {
    const decoded = [undefined, false, true].map((preview) => outputsOf(decode16([output(role, preview)]))[0]!)
    expect(decoded.map((item) => item.preview)).toEqual([undefined, undefined, true])
  })

  it.each(['output', 'outputFamily'] as const)('rejects non-Boolean wire-16 %s preview', (role) => {
    const result = parseDinksterSchemaWire16('test.bad_preview', {
      schemaVersion: 16, interface: [output(role, 'yes')],
    })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
    expect(result.diagnostics[0]!.message).toContain('.preview must be a boolean')
  })

  it('freezes wire-15 preview handling as generic unknown metadata', () => {
    for (const role of ['output', 'outputFamily'] as const) {
      const malformed = parseDinksterSchemaWire15('test.wire15_preview', {
        schemaVersion: 15, interface: [{ ...output(role, { malformed: true }), future: 'ok' }],
      })
      const absent = parseDinksterSchemaWire15('test.wire15_preview', {
        schemaVersion: 15, interface: [output(role)], futureSchemaField: true,
      } as DinksterWireSchema)
      expect(malformed.diagnostics).toEqual([])
      expect(malformed.schema).toEqual(absent.schema)
      expect(outputsOf(malformed.schema!)[0]).not.toHaveProperty('preview')
    }
  })

  it('preserves ordinary and family preview through elaboration and both boundary routes', () => {
    const schema = decode16([output('output', true), output('outputFamily', true)])
    const elaborated = elaborateInterface(schema, {
      values: {}, dynamic: { results: { members: ['stable'] } },
    })
    expect(elabOutputsOf(elaborated).map((item) => item.spec.preview)).toEqual([true, true, true])

    const def = {
      id: 'g-preview', name: 'preview boundary',
      nodes: { n0: { id: 'n0', type: schema.type, values: {}, dynamic: { results: { members: ['stable'] } } } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: {
        inputs: [],
        outputs: [
          { id: 'ordinary', binds: { kind: 'port', node: 'n0', port: 'result' } },
          { id: 'member', binds: { kind: 'port', node: 'n0', port: 'results.results', members: ['stable'] } },
          { id: 'family', binds: { kind: 'family', node: 'n0', port: 'results' } },
        ],
      },
    } as never
    const boundary = deriveBoundarySchema(def, (type) => type === schema.type ? schema : undefined)
    expect(boundary.diagnostics).toEqual([])
    expect(outputsOf(boundary.schema!).map((item) => item.preview)).toEqual([true, true, true])
  })

  it.each([
    ['absent', undefined, undefined],
    ['false', false, undefined],
    ['true', true, true],
  ] as const)('normalizes top-level lazy %s to true-or-omission', (_label, wireValue, expected) => {
    expect(inputsOf(decode16([ordinary(wireValue)]))[0]!.lazy).toBe(expected)
  })

  it.each([
    ['absent', undefined, undefined],
    ['false', false, undefined],
    ['true', true, true],
  ] as const)('normalizes lazy %s at every recursive ordinary-input depth', (_label, wireValue, expected) => {
    const leaves = nestedOrdinaryInputs(decode16(nestedEntries(wireValue)))
    expect(leaves).toHaveLength(5)
    expect(leaves.map((input) => input.lazy)).toEqual(Array(5).fill(expected))
  })

  it.each([
    ['top level', [ordinary('yes')]],
    ['family template', [nestedEntries('yes')[0]!]],
    ['combo branch', [nestedEntries('yes')[1]!]],
    ['slot shared dependent', [nestedEntries('yes')[2]!]],
    ['slot variant dependent', [{
      ...nestedEntries()[2]!,
      variants: [{
        key: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] },
        inputs: [{ ...ordinary('yes'), id: 'variant' }],
      }],
    }]],
    ['open-slot dependent', [nestedEntries('yes')[3]!]],
    ['family-combo-slot chain', [{
      role: 'inputFamily', id: 'family', memberPrefix: 'member',
      template: [{
        role: 'dynamicCombo', id: 'combo', options: [{ key: 'on', inputs: [{
          role: 'dynamicSlot', id: 'slot', required: false,
          slotType: { kind: 'concrete', types: ['comfy.IMAGE'] },
          inputs: [{ ...ordinary('yes'), id: 'deep' }],
        }] }],
      }],
    }]],
  ])('refuses the whole wire-16 schema for non-Boolean lazy at %s', (_label, interfaceEntries) => {
    const result = parseDinksterSchemaWire16('test.bad_lazy', {
      schemaVersion: 16,
      interface: interfaceEntries,
    })
    expect(result.schema).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
    expect(result.diagnostics[0]!.message).toContain('.lazy must be a boolean')
  })

  it('freezes wire-15 behavior: lazy and generic unknown fields remain additive and ignored', () => {
    const interfaceEntries = [
      { ...ordinary({ future: 'not a Boolean' }), futureField: ['additive'] },
      ...nestedEntries({ future: 'still ignored' }),
    ]
    const withUnknown = parseDinksterSchemaWire15('test.wire15', {
      schemaVersion: 15,
      interface: interfaceEntries,
      futureSchemaField: { additive: true },
    } as DinksterWireSchema)
    const withoutUnknown = parseDinksterSchemaWire15('test.wire15', {
      schemaVersion: 15,
      interface: [ordinary(), ...nestedEntries()],
    })
    expect(withUnknown.diagnostics).toEqual([])
    expect(withUnknown.schema).toEqual(withoutUnknown.schema)
    expect(nestedOrdinaryInputs(withUnknown.schema!).every((input) => input.lazy === undefined)).toBe(true)
  })

  it('requires envelope and entry versions to match', () => {
    for (const [envelope, entry] of [[16, 15], [15, 16]] as const) {
      const result = parseDinksterNodes({
        schemaVersion: envelope,
        nodes: { mismatch: { schemaVersion: entry, interface: [ordinary(true)] } },
      })
      expect(result.schemas.size).toBe(0)
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'schema.dinkster.wireVersion' }),
      ])
      expect(result.diagnostics[0]!.message).toContain('does not match payload version')
    }
  })

  it('retains both 15 and 16 after preferring wire 19', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(44)
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS.at(-1)).toBe(44)
    expect(parseDinksterNodes({ schemaVersion: 15, nodes: { old: { schemaVersion: 15, interface: [ordinary(true)] } } }).schemas.size).toBe(1)
    expect(parseDinksterNodes({ schemaVersion: 16, nodes: { current: { schemaVersion: 16, interface: [ordinary(true)] } } }).schemas.size).toBe(1)
  })

  it('preserves lazy through recursive elaboration and subgraph boundary derivation without metadata collisions', () => {
    const schema = decode16([
      ordinary(true),
      {
        ...nestedEntries(true)[0]!,
        template: [{
          ...ordinary(true), id: 'leaf', forceInput: true, advanced: true,
          widget: { type: 'NUMBER', min: 1, max: 9 }, onAbsent: 'omit',
        }],
      },
    ])
    const elaborated = elaborateInterface(schema, {
      values: {}, dynamic: { family: { members: ['stable'] } },
    })
    expect(elabInputsOf(elaborated).map((input) => input.spec)).toEqual([
      expect.objectContaining({ id: 'value', lazy: true }),
      expect.objectContaining({
        id: 'family.stable', lazy: true, forceInput: true, advanced: true,
        onAbsent: 'omit', widget: expect.objectContaining({ widgetType: 'INT' }),
      }),
      expect.objectContaining({
        id: 'family.m0', lazy: true, forceInput: true, advanced: true,
        onAbsent: 'omit', optional: true, widget: expect.objectContaining({ widgetType: 'INT' }),
      }),
    ])

    const def = {
      id: 'g-lazy', name: 'lazy boundary',
      nodes: { n0: { id: 'n0', type: schema.type, values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: {
        inputs: [{ id: 'boundary_value', binds: { kind: 'port', node: 'n0', port: 'value' } }],
        outputs: [],
      },
    } as never
    const boundary = deriveBoundarySchema(def, (type) => type === schema.type ? schema : undefined)
    expect(boundary.diagnostics).toEqual([])
    expect(inputsOf(boundary.schema!)[0]).toMatchObject({ id: 'boundary_value', lazy: true })
  })

  it('does not give lazy or preview frontend selector, pruning, topology, index, prompt, or hash semantics', () => {
    const schemas = [undefined, false, true].map((lazy) => decode16([{
      ...ordinary(lazy), required: true,
    }]))
    expect(schemas.every((schema) => schema.selector === undefined)).toBe(true)

    const producers = [undefined, false, true].map((preview) => ({
      ...decode16([output('output', preview)]), type: 'test.producer', isOutputNode: false,
    }))
    expect(producers.map((schema) => elabOutputsOf(elaborateInterface(schema, { values: {} }))
      .map((item, index) => [item.address.port, index]))).toEqual([
      [['result', 0]], [['result', 0]], [['result', 0]],
    ])

    const document = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lazy-proof', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            producer: { id: 'producer', type: 'test.producer', values: {} },
            sink: { id: 'sink', type: 'test.lazy', values: {} },
          },
          links: {
            l0: {
              id: 'l0', from: { node: 'producer', port: 'result' },
              to: { node: 'sink', port: 'value' },
            },
          },
          nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      view: { graphs: { g0: { nodes: {
        producer: { position: { x: 0, y: 0 } }, sink: { position: { x: 240, y: 0 } },
      } } } },
      meta: {},
    } as unknown as WorkflowDocument
    const cases = [
      ...schemas.map((schema) => ({ schema, producer: producers[0]! })),
      ...producers.slice(1).map((producer) => ({ schema: schemas[0]!, producer })),
    ]
    const results = cases.map(({ schema, producer }) => {
      const current = { ...schema, isOutputNode: true }
      const resolve = (type: string) => type === producer.type ? producer : current
      const input = {
        document, revision: 1, resolve, scope: { kind: 'full' as const },
        connection: asConnectionId('c0'), schemaHash: 'lazy-proof',
      }
      const result = compile({
        ...input,
      })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      const closure = scopeClosure(input)
      expect(closure).toBeDefined()
      return result.ok ? {
        prompt: result.artifact.prompt,
        semanticHash: result.artifact.semanticHash,
        included: closure!.included,
        inactiveExclusive: closure!.inactiveExclusive,
        structural: closure!.structural,
      } : undefined
    })
    expect(results).toEqual([results[0], results[0], results[0], results[0], results[0]])
    expect(results[0]?.prompt).toEqual({
      producer: { class_type: 'test.producer', inputs: {}, outputIds: ['result'] },
      sink: { class_type: 'test.lazy', inputs: { value: ['producer', 0] }, outputIds: [] },
    })
    expect([...results[0]!.included].sort()).toEqual(['producer', 'sink'])
    expect(results[0]!.inactiveExclusive.size).toBe(0)
  })
})
