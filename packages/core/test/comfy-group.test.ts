import { describe, expect, it } from 'vitest'
import { comfyGroupCatalogFromDinksterWire } from '../src/schema/comfy-group.js'
import type { DinksterNodesPayload } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const float = { kind: 'concrete', name: 'core.float' } as const

const nativeSchema = (type: string, pack = 'core'): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  pack,
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'value', type: float, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: 0 } },
    { kind: 'input', id: 'amount', type: float, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: 1 } },
    { kind: 'output', id: 'value', type: float },
  ],
})

const wireSchema = (
  nodeType: string,
  inputs: readonly string[],
  outputs: readonly string[],
  inputKinds: Readonly<Record<string, 'optional-socket' | 'required-socket' | 'optional-widget'>> = {},
) => ({
  schemaVersion: 15,
  nodeType,
  version: 1,
  displayName: nodeType,
  category: 'test',
  idempotent: true,
  interface: [
    ...inputs.map((id) => {
      const kind = inputKinds[id]
      return {
        role: 'input',
        id,
        type: {
          kind: 'concrete',
          types: [id === 'sam_model' && kind !== 'optional-widget' ? 'comfy.SAM_MODEL' : 'core.float'],
        },
        required: kind === undefined || kind === 'required-socket',
        ...(kind === 'optional-socket' || kind === 'required-socket'
          ? {}
          : { widget: { type: 'FLOAT', default: id === 'amount' ? 1 : 0 } }),
      }
    }),
    ...outputs.map((id) => ({
      role: 'output',
      id,
      type: { kind: 'concrete', types: ['core.float'] },
    })),
  ],
})

const groupType = 'comfy-group.test-groups.blend-chain'
const sourceA = 'comfy_group_source:test-groups/BlendA'
const sourceB = 'comfy_group_source:test-groups/BlendB'

const validRecord = () => ({
  id: 'comfy_group:test-groups/blend-chain',
  mappingKind: 'op',
  carrier: 'dinkster.blend',
  source: { pack: 'test-groups', name: 'blend-chain', revision: 'abc123' },
  pattern: {
    groupType,
    anchor: 'b',
    nodes: {
      a: {
        source: { pack: 'test-groups', nodeClass: 'BlendA', nodeType: sourceA, revision: 'abc123' },
        mode: 'active',
      },
      b: {
        source: { pack: 'test-groups', nodeClass: 'BlendB', nodeType: sourceB, revision: 'abc123' },
        mode: 'active',
      },
    },
    edges: [{ from: 'a:value', to: 'b:value' }],
    disconnected: ['b:sam_model'],
    boundary: { inputs: { value: 'a:value' }, outputs: { value: 'b:value' } },
    parameters: { amount: 'a:amount' },
    constants: { 'b:amount': 1 },
  },
  replacement: {
    from: groupType,
    cases: [{
      to: 'dinkster.blend',
      inputs: {
        value: { kind: 'copy', input: 'value' },
        amount: { kind: 'copy', input: 'amount' },
      },
      outputs: { value: 'value' },
    }],
  },
  confidence: { tier: 'grouped', evidence: ['tests/blend-chain.json'] },
})

const payload = (record: unknown, sourceSchemas: readonly unknown[] = [
  wireSchema(sourceA, ['value', 'amount'], ['value']),
  wireSchema(sourceB, ['value', 'amount', 'sam_model'], ['value'], { sam_model: 'optional-socket' }),
]): DinksterNodesPayload => ({
  schemaVersion: 25,
  packs: {
    core: {
      displayName: 'core',
      comfyGroups: {
        format: 'dinkster-comfy-group/1',
        sourceSchemas,
        groupSchemas: [wireSchema(groupType, ['value', 'amount'], ['value'])],
        records: [record],
      },
    },
  },
})

describe('ComfyUI exact-group registry wire', () => {
  it('decodes a strict connected pattern and keeps its schemas import-only', () => {
    const result = comfyGroupCatalogFromDinksterWire(
      payload(validRecord()),
      new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
    )

    expect(result.diagnostics).toEqual([])
    expect(result.catalog.records).toHaveLength(1)
    expect(result.catalog.records[0]?.pattern.nodes.get('a')?.source.nodeClass).toBe('BlendA')
    expect(result.catalog.sourceSchemas.get(sourceA)?.type).toBe(sourceA)
    expect(result.catalog.groupSchemas.get(groupType)?.type).toBe(groupType)

    const family = {
      ...validRecord(),
      mappingKind: 'family',
      family: { id: 'blend', provider: 'test-groups' },
    }
    const familyResult = comfyGroupCatalogFromDinksterWire(
      payload(family),
      new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
    )
    expect(familyResult.diagnostics).toEqual([])
    expect(familyResult.catalog.records[0]).toMatchObject({
      mappingKind: 'family',
      family: { id: 'blend', provider: 'test-groups' },
    })
  })

  it('keeps a source snapshot separate when its type is also installed natively', () => {
    const native = nativeSchema(sourceA, 'compat')
    const result = comfyGroupCatalogFromDinksterWire(
      payload(validRecord()),
      new Map([
        [sourceA, native],
        ['dinkster.blend', nativeSchema('dinkster.blend')],
      ]),
    )

    expect(result.diagnostics).toEqual([])
    expect(result.catalog.sourceSchemas.get(sourceA)).not.toBe(native)
    expect(result.catalog.records[0]?.pattern.nodes.get('a')?.source.nodeClass).toBe('BlendA')
  })

  it('rejects patterns with unclassified inputs or mismatched constants', () => {
    const unclassified = validRecord()
    ;(unclassified.pattern as unknown as { parameters: Record<string, string> }).parameters = {}
    const badConstant = validRecord()
    ;(badConstant.pattern as unknown as { constants: Record<string, number> }).constants = { 'b:missing': 1 }

    for (const candidate of [unclassified, badConstant]) {
      const result = comfyGroupCatalogFromDinksterWire(
        payload(candidate),
        new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
      )
      expect(result.catalog.records).toEqual([])
      expect(result.diagnostics).toHaveLength(1)
      expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyGroup.invalid' })
    }
  })

  it('rejects malformed, non-optional, widget, and overlapping disconnected inputs', () => {
    const malformed = validRecord()
    malformed.pattern.disconnected = ['b:sam_model:extra']
    const required = validRecord()
    const widget = validRecord()
    const duplicate = validRecord()
    duplicate.pattern.disconnected.push('b:sam_model')
    const overlaps = ['b:value', 'a:value', 'a:amount', 'b:amount'].map((address) => {
      const record = validRecord()
      record.pattern.disconnected = [address]
      return record
    })
    const requiredSchemas = [
      wireSchema(sourceA, ['value', 'amount'], ['value']),
      wireSchema(sourceB, ['value', 'amount', 'sam_model'], ['value'], { sam_model: 'required-socket' }),
    ]
    const widgetSchemas = [
      wireSchema(sourceA, ['value', 'amount'], ['value']),
      wireSchema(sourceB, ['value', 'amount', 'sam_model'], ['value'], { sam_model: 'optional-widget' }),
    ]

    for (const [candidate, schemas, message] of [
      [malformed, undefined, 'invalid pattern address'],
      [required, requiredSchemas, 'is not an optional socket input'],
      [widget, widgetSchemas, 'is not an optional socket input'],
      [duplicate, undefined, 'has multiple pattern roles'],
      ...overlaps.map((record) => [record, undefined, 'has multiple pattern roles'] as const),
    ] as const) {
      const result = comfyGroupCatalogFromDinksterWire(
        payload(candidate, schemas),
        new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
      )
      expect(result.catalog.records).toEqual([])
      expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyGroup.invalid' })
      expect(result.diagnostics[0]?.message).toContain(message)
    }
  })

  it('accepts declared group and node revisions with a drift diagnostic', () => {
    const candidate = validRecord()
    candidate.source.revision = 'c67885b1'
    candidate.pattern.nodes.a.source.revision = 'c67885b1'
    candidate.pattern.nodes.b.source.revision = 'c67885b1'
    const result = comfyGroupCatalogFromDinksterWire(
      JSON.parse(JSON.stringify(payload(candidate)).replaceAll('test-groups', 'comfy-core')),
      new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
    )
    expect(result.catalog.records).toHaveLength(1)
    expect(result.catalog.records[0]?.source.revision).toBe('c67885b1')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'warning', code: 'schema.comfyRegistry.sourceRevision',
    })
    expect(result.diagnostics[0]?.message).toContain('c67885b1')
  })

  it('rejects disconnected patterns, missing provenance, and registry collisions', () => {
    const disconnected = validRecord()
    disconnected.pattern.edges = []
    const wrongRevision = validRecord()
    wrongRevision.pattern.nodes.a.source = {
      pack: 'comfy-core',
      nodeClass: 'BlendA',
      nodeType: sourceA,
      revision: '',
    }

    for (const candidate of [disconnected, wrongRevision]) {
      const result = comfyGroupCatalogFromDinksterWire(
        payload(candidate),
        new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
      )
      expect(result.catalog.records).toEqual([])
      expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyGroup.invalid' })
    }

    const corePack = (payload(validRecord()).packs as Record<string, unknown>)['core']
    const otherBase = validRecord()
    const otherRecord = {
      ...otherBase,
      carrier: 'dinkster.other.blend',
      replacement: {
        ...otherBase.replacement,
        cases: otherBase.replacement.cases.map((candidate) => ({
          ...candidate,
          to: 'dinkster.other.blend',
        })),
      },
    }
    const otherPack = (payload(otherRecord).packs as Record<string, unknown>)['core']
    const duplicatePayload: DinksterNodesPayload = {
      schemaVersion: 25,
      packs: { core: corePack, other: otherPack },
    }
    const collision = comfyGroupCatalogFromDinksterWire(
      duplicatePayload,
      new Map([
        ['dinkster.blend', nativeSchema('dinkster.blend')],
        ['dinkster.other.blend', nativeSchema('dinkster.other.blend', 'other')],
      ]),
    )
    expect(collision.catalog.records).toEqual([])
    expect(collision.diagnostics.every((item) => item.code === 'schema.comfyGroup.collision')).toBe(true)
  })

  it('rejects oversized patterns and undeclared wire fields', () => {
    const oversized = validRecord()
    oversized.pattern.nodes = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
      `n${index}`,
      oversized.pattern.nodes.a,
    ])) as typeof oversized.pattern.nodes
    const extra = validRecord() as ReturnType<typeof validRecord> & { executable?: boolean }
    extra.executable = true

    for (const candidate of [oversized, extra]) {
      const result = comfyGroupCatalogFromDinksterWire(
        payload(candidate),
        new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
      )
      expect(result.catalog.records).toEqual([])
      expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyGroup.invalid' })
    }
  })

  it('rejects accessor-backed pack data without invoking it', () => {
    let invoked = false
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'comfyGroups', {
      enumerable: true,
      get: () => {
        invoked = true
        return {}
      },
    })
    const result = comfyGroupCatalogFromDinksterWire(
      { schemaVersion: 25, packs: { core: hostile } },
      new Map([['dinkster.blend', nativeSchema('dinkster.blend')]]),
    )

    expect(invoked).toBe(false)
    expect(result.catalog.records).toEqual([])
    expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyGroup.invalid' })
  })
})
