import { describe, expect, it } from 'vitest'
import { comfyAliasCatalogFromDinksterWire, type ComfyAliasRecord } from '../src/schema/comfy-alias.js'
import type { DinksterNodesPayload } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const nativeSchema = (type: string, pack = 'core'): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  pack,
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'value',
      type: { kind: 'concrete', name: 'core.float' },
      optional: false,
      widget: { widgetType: 'FLOAT', options: {}, default: 0 },
    },
    { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'core.float' } },
  ],
})

const sourceSchema = (nodeType: string) => ({
  schemaVersion: 15,
  nodeType,
  version: 1,
  displayName: 'Legacy Add',
  category: 'math',
  idempotent: true,
  interface: [
    {
      role: 'input',
      id: 'value',
      type: { kind: 'concrete', types: ['core.float'] },
      required: true,
      widget: { type: 'FLOAT', default: 0 },
    },
    { role: 'output', id: 'value', type: { kind: 'concrete', types: ['core.float'] } },
  ],
})

const record = (
  nodeClass: string,
  sourceType: string,
  carrier: string,
  extra: Partial<ComfyAliasRecord> = {},
) => ({
  id: `comfy_alias:comfy-core/${nodeClass}`,
  mappingKind: 'op',
  carrier,
  source: {
    pack: 'comfy-core',
    nodeClass,
    nodeType: sourceType,
    revision: 'b78cec87',
  },
  replacement: {
    from: sourceType,
    cases: [{ to: carrier, inputs: { value: { kind: 'copy', input: 'value' } }, outputs: { value: 'value' } }],
  },
  confidence: { tier: 'exact', evidence: ['tests/legacy-add.json'] },
  ...extra,
})

const payload = (
  records: readonly unknown[],
  sourceSchemas: readonly unknown[],
  pack = 'core',
): DinksterNodesPayload => ({
  schemaVersion: 25,
  packs: {
    [pack]: {
      displayName: pack,
      comfyAliases: {
        format: 'dinkster-comfy-alias/1',
        sourceSchemas,
        records,
      },
    },
  },
})

describe('ComfyUI alias registry wire', () => {
  it('decodes source schemas, op records, and family records separately', () => {
    const opType = 'comfy_alias:comfy-core/LegacyAdd'
    const familyType = 'comfy_alias:comfy-core/LegacyVariadic'
    const op = record('LegacyAdd', opType, 'dinkster.math.add')
    const family = record('LegacyVariadic', familyType, 'dinkster.math.add', {
      mappingKind: 'family',
      family: { id: 'arithmetic', provider: 'comfy-core' },
      confidence: { tier: 'parametric', evidence: ['tests/legacy-variadic.json'] },
    } as Partial<ComfyAliasRecord>)
    const result = comfyAliasCatalogFromDinksterWire(
      payload([op, family], [sourceSchema(opType), sourceSchema(familyType)]),
      new Map([['dinkster.math.add', nativeSchema('dinkster.math.add')]]),
    )

    expect(result.diagnostics).toEqual([])
    expect(result.catalog.records.map((item) => item.mappingKind)).toEqual(['op', 'family'])
    expect(result.catalog.sourceSchemas.get(opType)?.type).toBe(opType)
    expect(result.catalog.recordsByNodeClass.get('LegacyAdd')?.replacement).toEqual(op.replacement)
    expect(result.catalog.recordsBySourceType.get(familyType)?.family).toEqual({
      id: 'arithmetic',
      provider: 'comfy-core',
    })
  })

  it.each(['8a33128f', 'deadbeef', 'declared-source'])('accepts declared ComfyUI revision %s with a diagnostic', (revision) => {
    const sourceType = 'comfy_alias:comfy-core/LegacyAdd'
    const result = comfyAliasCatalogFromDinksterWire(
      payload([
        {
          ...record('LegacyAdd', sourceType, 'dinkster.math.add'),
          source: {
            pack: 'comfy-core',
            nodeClass: 'LegacyAdd',
            nodeType: sourceType,
            revision,
          },
        },
      ], [sourceSchema(sourceType)]),
      new Map([['dinkster.math.add', nativeSchema('dinkster.math.add')]]),
    )

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'warning', code: 'schema.comfyRegistry.sourceRevision',
    })
    expect(result.diagnostics[0]?.message).toContain(revision)
    expect(result.catalog.records[0]?.source.revision).toBe(revision)
  })

  it('rejects aliases without declared source provenance', () => {
    const sourceType = 'comfy_alias:comfy-core/LegacyAdd'
    const result = comfyAliasCatalogFromDinksterWire(
      payload([
        {
          ...record('LegacyAdd', sourceType, 'dinkster.math.add'),
          source: {
            pack: 'comfy-core',
            nodeClass: 'LegacyAdd',
            nodeType: sourceType,
            revision: '',
          },
        },
      ], [sourceSchema(sourceType)]),
      new Map([['dinkster.math.add', nativeSchema('dinkster.math.add')]]),
    )

    expect(result.catalog.records).toEqual([])
    expect(result.diagnostics[0]?.message).toContain(
      'revision must be non-empty',
    )
  })

  it('rejects a whole pack registry on a malformed record', () => {
    const sourceType = 'comfy_alias:comfy-core/LegacyAdd'
    const malformed = {
      ...record('LegacyAdd', sourceType, 'dinkster.math.add'),
      replacement: {
        from: sourceType,
        cases: [{ to: 'dinkster.math.add', unexpected: true }],
      },
    }
    const result = comfyAliasCatalogFromDinksterWire(
      payload([malformed], [sourceSchema(sourceType)]),
      new Map([['dinkster.math.add', nativeSchema('dinkster.math.add')]]),
    )

    expect(result.catalog.records).toEqual([])
    expect(result.catalog.sourceSchemas.size).toBe(0)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'schema.comfyAlias.invalid',
    })
    expect(result.diagnostics[0]!.message).toContain('unknown fields: unexpected')
  })

  it('rejects source snapshots outside the caller-accepted wire versions', () => {
    const sourceType = 'comfy_alias:comfy-core/LegacyAdd'
    const result = comfyAliasCatalogFromDinksterWire(
      payload([record('LegacyAdd', sourceType, 'dinkster.math.add')], [sourceSchema(sourceType)]),
      new Map([['dinkster.math.add', nativeSchema('dinkster.math.add')]]),
      [25],
    )

    expect(result.catalog.records).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyAlias.invalid' })
    expect(result.diagnostics[0]!.message).toContain('schemaVersion 15 is not accepted')
  })

  it('rejects confidence contracts and source/carrier mismatches', () => {
    const sourceType = 'comfy_alias:comfy-core/LegacyAdd'
    const cases = [
      { ...record('LegacyAdd', sourceType, 'dinkster.math.add'), confidence: { tier: 'exact', evidence: ['x'], tolerances: [] } },
      { ...record('LegacyAdd', sourceType, 'dinkster.math.add'), source: { pack: 'comfy-core', nodeClass: 'LegacyAdd', nodeType: 'wrong', revision: 'b78cec87' } },
      { ...record('LegacyAdd', sourceType, 'dinkster.math.add'), carrier: 'dinkster.other' },
    ]
    for (const candidate of cases) {
      const result = comfyAliasCatalogFromDinksterWire(
        payload([candidate], [sourceSchema(sourceType)]),
        new Map([['dinkster.math.add', nativeSchema('dinkster.math.add')]]),
      )
      expect(result.catalog.records).toEqual([])
      expect(result.diagnostics[0]).toMatchObject({ code: 'schema.comfyAlias.invalid' })
    }
  })

  it('keeps a source snapshot separate when its type is also installed natively', () => {
    const sourceType = 'comfy.LegacyAdd'
    const native = nativeSchema(sourceType, 'compat')
    const result = comfyAliasCatalogFromDinksterWire(
      payload(
        [record('LegacyAdd', sourceType, 'dinkster.math.add')],
        [sourceSchema(sourceType)],
      ),
      new Map([
        [sourceType, native],
        ['dinkster.math.add', nativeSchema('dinkster.math.add')],
      ]),
    )

    expect(result.diagnostics).toEqual([])
    expect(result.catalog.sourceSchemas.get(sourceType)).not.toBe(native)
    expect(result.catalog.recordsBySourceType.get(sourceType)?.source.nodeClass).toBe('LegacyAdd')
  })

  it('keeps every globally colliding record unresolved', () => {
    const sourceType = 'comfy.LegacyAdd'
    const duplicate = record('LegacyAdd', sourceType, 'dinkster.math.add')
    const otherDuplicate = record('LegacyAdd', sourceType, 'dinkster.logic.and')
    const raw: DinksterNodesPayload = {
      schemaVersion: 25,
      packs: {
        core: (payload([duplicate], [sourceSchema(sourceType)], 'core').packs as Record<string, unknown>)['core'],
        other: (payload([otherDuplicate], [sourceSchema(sourceType)], 'other').packs as Record<string, unknown>)['other'],
      },
    }
    const result = comfyAliasCatalogFromDinksterWire(
      raw,
      new Map([
        ['dinkster.math.add', nativeSchema('dinkster.math.add')],
        ['dinkster.logic.and', nativeSchema('dinkster.logic.and', 'other')],
      ]),
    )

    expect(result.catalog.records).toEqual([])
    expect(result.catalog.sourceSchemas.size).toBe(0)
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics.every((item) => item.code === 'schema.comfyAlias.collision')).toBe(true)
  })

  it('keeps ambiguous bare class names unresolved without dropping coverage records', () => {
    const typeA = 'comfy_alias:pack-a/SameName'
    const typeB = 'comfy_alias:pack-b/SameName'
    const recordA = {
      ...record('SameName', typeA, 'dinkster.math.add'),
      id: 'comfy_alias:pack-a/SameName',
      source: { pack: 'pack-a', nodeClass: 'SameName', nodeType: typeA, revision: 'aaa' },
    }
    const recordB = {
      ...record('SameName', typeB, 'dinkster.logic.and'),
      id: 'comfy_alias:pack-b/SameName',
      source: { pack: 'pack-b', nodeClass: 'SameName', nodeType: typeB, revision: 'bbb' },
    }
    const raw: DinksterNodesPayload = {
      schemaVersion: 25,
      packs: {
        math: (payload([recordA], [sourceSchema(typeA)], 'math').packs as Record<string, unknown>)['math'],
        logic: (payload([recordB], [sourceSchema(typeB)], 'logic').packs as Record<string, unknown>)['logic'],
      },
    }
    const result = comfyAliasCatalogFromDinksterWire(raw, new Map([
      ['dinkster.math.add', nativeSchema('dinkster.math.add', 'math')],
      ['dinkster.logic.and', nativeSchema('dinkster.logic.and', 'logic')],
    ]))

    expect(result.catalog.records).toHaveLength(2)
    expect(result.catalog.recordsByNodeClass.has('SameName')).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'warning',
      code: 'schema.comfyAlias.classCollision',
    })
  })
})
