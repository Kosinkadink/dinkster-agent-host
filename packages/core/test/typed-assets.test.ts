/**
 * Typed assets (Dinkster schema wire v12, joint contract). The contract:
 * - asset<T> is the SECOND structured constructor next to list, recursive
 *   element, canonical parametric id 'asset<...>' (nesting composes:
 *   'list<asset<comfy.IMAGE>>'); one schema representation, never
 *   concrete('asset<...>')
 * - an asset<T> value is ONE AssetRef envelope regardless of T, so its
 *   cardinality is SCALAR even for asset<list<T>>
 * - the engine applies exactly ONE coercion step at input resolution:
 *   decode asset<T> -> T, lift list<asset<T>> -> list<T>, registry-gated
 *   merge list<asset<T>> -> T. Directional (outputs never coerced), never
 *   chained (asset<asset<T>> does not pass), merge maybe-legal here (the
 *   provider registry is server-side)
 * - type variables unify through the asset constructor (asset<T> binds T)
 */
import { describe, expect, it } from 'vitest'
import { assetCoercible, coercionTargetsOf, typesCompatible } from '../src/schema/compat.js'
import { compile } from '../src/compile/compile.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asGraphDefId, asLineageId, asNodeId, asPortId } from '../src/ids.js'
import type { SchemaResolver } from '../src/schema/derive-boundary.js'
import {
  assetMultiSelect,
  assetTypeId,
  canonicalTypeIdOf,
  cardinalityOf,
  isAssetRefDestinationTypeId,
  isAssetSourceTypeId,
  parseAssetTypeId,
  typeExprFromTypeId,
  type InputSpec,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '../src/schema/model.js'
import { DINKSTER_ACCEPTED_WIRE_VERSIONS, typeExprFromDinksterWire } from '../src/schema/dinkster-wire.js'
import { solveGraphTypes } from '../src/schema/solve.js'
import { typeMatchesToken } from '../src/search-filters.js'

// ---------------------------------------------------------------------------
// Builders (house style of solve-lists.test.ts)
// ---------------------------------------------------------------------------

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const list = (element: TypeExpr): TypeExpr => ({ kind: 'list', element })
const asset = (element: TypeExpr): TypeExpr => ({ kind: 'asset', element })
const T = (templateId: string, allowed?: string[]): TypeExpr => ({
  kind: 'variable',
  templateId,
  ...(allowed ? { allowedTypes: allowed.map(concrete) } : {}),
})

const input = (id: string, type: TypeExpr): InputSpec => ({ kind: 'input', id, type, optional: false })
const output = (id: string, type: TypeExpr): OutputSpec => ({ kind: 'output', id, type })

const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const IMG = 'comfy.IMAGE'
const schemas: Record<string, NodeSchema> = {
  AssetSrc: schemaOf('AssetSrc', [output('out', asset(concrete(IMG)))]),
  AssetListSrc: schemaOf('AssetListSrc', [output('out', list(asset(concrete(IMG))))]),
  ImageSrc: schemaOf('ImageSrc', [output('out', concrete(IMG))]),
  ImageListSrc: schemaOf('ImageListSrc', [output('out', list(concrete(IMG)))]),
  ImageSink: schemaOf('ImageSink', [input('in', concrete(IMG))]),
  LatentSink: schemaOf('LatentSink', [input('in', concrete('comfy.LATENT'))]),
  ImageListSink: schemaOf('ImageListSink', [input('in', list(concrete(IMG)))]),
  AssetSink: schemaOf('AssetSink', [input('in', asset(concrete(IMG)))]),
  // Generic decode-style node: asset<T> in, T out (asset<T> binds T)
  AssetGet: schemaOf('AssetGet', [input('in', asset(T('T'))), output('out', T('T'))]),
  // Bare variable passthrough
  Switch: schemaOf('Switch', [input('in', T('T')), output('out', T('T'))]),
  // Allowlisted variable passthrough: T may only be IMAGE
  SwitchImg: schemaOf('SwitchImg', [input('in', T('T', [IMG])), output('out', T('T'))]),
  // Open generic producers (variables under the constructors)
  GenAssetSrc: schemaOf('GenAssetSrc', [output('out', asset(T('T')))]),
  GenAssetListSrc: schemaOf('GenAssetListSrc', [output('out', asset(list(T('T'))))]),
  GenListAssetSrc: schemaOf('GenListAssetSrc', [output('out', list(asset(T('T'))))]),
  GenChainSrc: schemaOf('GenChainSrc', [output('out', asset(asset(T('T'))))]),
  ClosedChainSrc: schemaOf('ClosedChainSrc', [output('out', asset(asset(concrete(IMG))))]),
}
const resolve: SchemaResolver = (type) => schemas[type]

const defOf = (parts: {
  nodes: Record<string, { type: string }>
  links?: Record<string, { from: [string, string]; to: [string, string] }>
}): GraphDef =>
  ({
    id: 'g0',
    name: 'test',
    nodes: Object.fromEntries(
      Object.entries(parts.nodes).map(([id, node]) => [id, { id, type: node.type, values: {} }]),
    ),
    links: Object.fromEntries(
      Object.entries(parts.links ?? {}).map(([id, l]) => [
        id,
        { id, from: { node: l.from[0], port: l.from[1] }, to: { node: l.to[0], port: l.to[1] } },
      ]),
    ),
    nets: {},
    reroutes: {},
    nextOrdinal: 99,
  }) as unknown as GraphDef

// ---------------------------------------------------------------------------
// Canonical grammar (single owner: model.ts)
// ---------------------------------------------------------------------------

describe('canonical asset type ids', () => {
  it('round-trips through the single parser, composing with list', () => {
    expect(assetTypeId(IMG)).toBe('asset<comfy.IMAGE>')
    expect(parseAssetTypeId('asset<comfy.IMAGE>')).toBe(IMG)
    expect(parseAssetTypeId('asset<list<comfy.IMAGE>>')).toBe('list<comfy.IMAGE>')
    expect(parseAssetTypeId('list<asset<comfy.IMAGE>>')).toBeUndefined()
    expect(parseAssetTypeId(IMG)).toBeUndefined()
    expect(parseAssetTypeId('asset<>')).toBeUndefined()
  })

  it('canonicalTypeIdOf and typeExprFromTypeId are inverses on closed types', () => {
    expect(canonicalTypeIdOf(asset(concrete(IMG)))).toBe('asset<comfy.IMAGE>')
    expect(canonicalTypeIdOf(asset(list(concrete(IMG))))).toBe('asset<list<comfy.IMAGE>>')
    expect(canonicalTypeIdOf(list(asset(concrete(IMG))))).toBe('list<asset<comfy.IMAGE>>')
    expect(typeExprFromTypeId('asset<comfy.IMAGE>')).toEqual(asset(concrete(IMG)))
    expect(typeExprFromTypeId('asset<list<comfy.IMAGE>>')).toEqual(asset(list(concrete(IMG))))
    expect(typeExprFromTypeId('list<asset<comfy.IMAGE>>')).toEqual(list(asset(concrete(IMG))))
    // Open assets have no canonical id.
    expect(canonicalTypeIdOf(asset(T('T')))).toBeUndefined()
  })

  it('an asset is SCALAR regardless of decode target (one AssetRef envelope)', () => {
    expect(cardinalityOf(asset(concrete(IMG)))).toBe('scalar')
    expect(cardinalityOf(asset(list(concrete(IMG))))).toBe('scalar')
    expect(cardinalityOf(list(asset(concrete(IMG))))).toBe('list')
  })
})

// ---------------------------------------------------------------------------
// Coercion vocabulary and advisory compatibility
// ---------------------------------------------------------------------------

describe('asset coercion vocabulary', () => {
  it('coercionTargetsOf pins decode, lift, and merge - nothing else', () => {
    expect(coercionTargetsOf('asset<comfy.IMAGE>')).toEqual([IMG])
    expect(coercionTargetsOf('asset<list<comfy.IMAGE>>')).toEqual(['list<comfy.IMAGE>'])
    expect(coercionTargetsOf('list<asset<comfy.IMAGE>>')).toEqual(['list<comfy.IMAGE>', IMG])
    expect(coercionTargetsOf(IMG)).toEqual([])
    expect(coercionTargetsOf('list<comfy.IMAGE>')).toEqual([])
  })

  it('decode: asset<T> feeds T, never the reverse', () => {
    expect(typesCompatible(asset(concrete(IMG)), concrete(IMG))).toBe(true)
    expect(typesCompatible(concrete(IMG), asset(concrete(IMG)))).toBe(false)
    expect(typesCompatible(asset(concrete(IMG)), concrete('comfy.LATENT'))).toBe(false)
    // decode crosses cardinality when the target is a list
    expect(typesCompatible(asset(list(concrete(IMG))), list(concrete(IMG)))).toBe(true)
  })

  it('lift and merge: list<asset<T>> feeds list<T> and (maybe-legal) scalar T', () => {
    expect(typesCompatible(list(asset(concrete(IMG))), list(concrete(IMG)))).toBe(true)
    expect(typesCompatible(list(asset(concrete(IMG))), concrete(IMG))).toBe(true)
    expect(typesCompatible(list(asset(concrete(IMG))), concrete('comfy.LATENT'))).toBe(false)
  })

  it('is strictly single-step: asset<asset<T>> never reaches T', () => {
    expect(typesCompatible(asset(asset(concrete(IMG))), concrete(IMG))).toBe(false)
    expect(typesCompatible(asset(asset(concrete(IMG))), asset(concrete(IMG)))).toBe(true)
  })

  it('asset-vs-asset is exact on the element; wildcard stays permissive', () => {
    expect(typesCompatible(asset(concrete(IMG)), asset(concrete(IMG)))).toBe(true)
    expect(typesCompatible(asset(concrete(IMG)), asset(concrete('comfy.LATENT')))).toBe(false)
    expect(typesCompatible(asset(concrete(IMG)), { kind: 'wildcard' })).toBe(true)
    expect(typesCompatible(asset(T('T')), asset(concrete(IMG)))).toBe(true)
  })

  it('assetCoercible is directional and handles OPEN generics without chaining', () => {
    expect(assetCoercible(asset(concrete(IMG)), concrete(IMG))).toBe(true)
    expect(assetCoercible(concrete(IMG), asset(concrete(IMG)))).toBe(false)
    // Open forms peel structurally: asset<T> can feed IMAGE by binding T.
    expect(assetCoercible(asset(T('T')), concrete(IMG))).toBe(true)
    expect(assetCoercible(asset(list(T('T'))), list(concrete(IMG)))).toBe(true) // decode to list dest
    expect(assetCoercible(list(asset(T('T'))), list(concrete(IMG)))).toBe(true) // lift
    expect(assetCoercible(list(asset(T('T'))), concrete(IMG))).toBe(true) // merge (maybe-legal)
    // Still one step: nested assets never chain, open or closed.
    expect(assetCoercible(asset(asset(T('T'))), concrete(IMG))).toBe(false)
    expect(assetCoercible(asset(asset(concrete(IMG))), concrete(IMG))).toBe(false)
    expect(assetCoercible(list(asset(asset(T('T')))), list(concrete(IMG)))).toBe(false)
    // Reverse of the open form stays illegal too.
    expect(assetCoercible(concrete(IMG), asset(T('T')))).toBe(false)
  })

  it('typesCompatible admits open generic coercions, still directionally', () => {
    expect(typesCompatible(asset(T('T')), concrete(IMG))).toBe(true) // decode binds T
    expect(typesCompatible(asset(list(T('T'))), list(concrete(IMG)))).toBe(true)
    expect(typesCompatible(list(asset(T('T'))), concrete(IMG))).toBe(true) // merge maybe-legal
    // A plain value never becomes a ref: no reverse coercion into asset<T>.
    expect(typesCompatible(concrete(IMG), asset(T('T')))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

describe('solver: asset coercion on edges', () => {
  it('asset<IMAGE> into an IMAGE input is ok (decode); into LATENT warns', () => {
    const def = defOf({
      nodes: { src: { type: 'AssetSrc' }, ok: { type: 'ImageSink' }, bad: { type: 'LatentSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['ok', 'in'] },
        l1: { from: ['src', 'out'], to: ['bad', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
    expect(s.diagnostics.find((x) => x.code === 'solve.linkMismatch')?.severity).toBe('warning')
  })

  it('IMAGE into an asset<IMAGE> input warns: no reverse coercion', () => {
    const def = defOf({
      nodes: { src: { type: 'ImageSrc' }, sink: { type: 'AssetSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
  })

  it('list<asset<IMAGE>> crosses cardinality legally: lift into list<IMAGE>, merge into scalar IMAGE', () => {
    const def = defOf({
      nodes: { src: { type: 'AssetListSrc' }, lifted: { type: 'ImageListSink' }, merged: { type: 'ImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['lifted', 'in'] },
        l1: { from: ['src', 'out'], to: ['merged', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok') // merge maybe-legal; server validates the provider
    expect(s.diagnostics).toEqual([])
  })

  it('a plain list<IMAGE> into scalar IMAGE stays a structural ERROR (merge is asset-only)', () => {
    const def = defOf({
      nodes: { src: { type: 'ImageListSrc' }, sink: { type: 'ImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    const d = s.diagnostics.find((x) => x.code === 'solve.listIntoScalar')
    expect(d?.severity).toBe('error')
  })

  it('asset<T> binds T through the constructor (unification, backend parity)', () => {
    const def = defOf({
      nodes: { src: { type: 'AssetSrc' }, get: { type: 'AssetGet' }, sink: { type: 'ImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['get', 'in'] },
        l1: { from: ['get', 'out'], to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })

  it('a bound asset<T> conflicts like any variable: LATENT against the bound IMAGE marks the class', () => {
    const def = defOf({
      nodes: { src: { type: 'AssetSrc' }, get: { type: 'AssetGet' }, bad: { type: 'LatentSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['get', 'in'] },
        l1: { from: ['get', 'out'], to: ['bad', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    // Conflicted classes mark EVERY contributing edge (house rule).
    expect(s.diagnostics.some((x) => x.code === 'solve.varConflict')).toBe(true)
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
  })

  it('a bare variable fed by asset<IMAGE> binds the REF type unchanged (exact-first)', () => {
    // Backend pin: a matching variable destination receives the AssetRef
    // as-is, never a silently decoded value.
    const def = defOf({
      nodes: { a: { type: 'AssetSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['a', 'out'], to: ['sw', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf('sw' as never, 'T')).toEqual({ kind: 'resolved', name: 'asset<comfy.IMAGE>' })
  })

  it('an asset edge next to a plain edge into one bare variable IS a conflict', () => {
    // Exact-first binding: edge one demands T = asset<IMAGE> (the ref binds
    // unchanged), edge two demands T = IMAGE - a genuine conflict, mirroring
    // backend unification. No silent decode reconciles them.
    const def = defOf({
      nodes: { a: { type: 'AssetSrc' }, b: { type: 'ImageSrc' }, sw: { type: 'Switch' } },
      links: {
        l0: { from: ['a', 'out'], to: ['sw', 'in'] },
        l1: { from: ['b', 'out'], to: ['sw', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.diagnostics.some((x) => x.code === 'solve.varConflict')).toBe(true)
  })

  it("an allowlisted variable that CANNOT hold the ref falls back to the coercion target", () => {
    // T restricted to IMAGE fed by asset<IMAGE>: the ref cannot bind, so the
    // input resolves to the decode target and the engine coerces at input
    // resolution - legal, no conflict.
    const def = defOf({
      nodes: { a: { type: 'AssetSrc' }, sw: { type: 'SwitchImg' } },
      links: { l0: { from: ['a', 'out'], to: ['sw', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf('sw' as never, 'T')).toEqual({ kind: 'resolved', name: IMG })
    expect(s.diagnostics.filter((x) => x.code === 'solve.varConflict')).toEqual([])
  })
})

describe('solver: open generic coercions and the single-step limit', () => {
  it('projects typed assets through one coercion step without permitting a chain', () => {
    const generic = defOf({ nodes: { get: { type: 'AssetGet' } } })
    const decoded = solveGraphTypes(generic, resolve, {
      projectedInputs: [{
        type: asset(concrete(IMG)),
        to: { node: asNodeId('get'), port: asPortId('in') },
      }],
    })
    expect(decoded.resolutionOf(asNodeId('get'), 'T')).toEqual({ kind: 'resolved', name: IMG })
    expect(decoded.portTypeOf(asNodeId('get'), 'output', 'out')).toEqual(concrete(IMG))
    expect(decoded.diagnostics).toEqual([])

    const concreteSink = defOf({ nodes: { sink: { type: 'ImageSink' } } })
    const chained = solveGraphTypes(concreteSink, resolve, {
      projectedInputs: [{
        type: asset(asset(concrete(IMG))),
        to: { node: asNodeId('sink'), port: asPortId('in') },
      }],
    })
    expect(chained.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['solve.linkMismatch'])
    expect(chained.linkVerdicts.size).toBe(0)
  })

  it('asset<T> feeds a concrete input by binding T (decode)', () => {
    const def = defOf({
      nodes: { src: { type: 'GenAssetSrc' }, sink: { type: 'ImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf('src' as never, 'T')).toEqual({ kind: 'resolved', name: IMG })
  })

  it('asset<list<T>> decodes into a list destination, binding T', () => {
    const def = defOf({
      nodes: { src: { type: 'GenAssetListSrc' }, sink: { type: 'ImageListSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf('src' as never, 'T')).toEqual({ kind: 'resolved', name: IMG })
    expect(s.diagnostics).toEqual([])
  })

  it('list<asset<T>> lifts into list<IMAGE> and (maybe-legally) merges into IMAGE, binding T', () => {
    const def = defOf({
      nodes: { src: { type: 'GenListAssetSrc' }, lifted: { type: 'ImageListSink' }, merged: { type: 'ImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['lifted', 'in'] },
        l1: { from: ['src', 'out'], to: ['merged', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok') // provider registry is server-side
    expect(s.resolutionOf('src' as never, 'T')).toEqual({ kind: 'resolved', name: IMG })
  })

  it('nested assets never chain, open or closed: one step only', () => {
    const def = defOf({
      nodes: { gen: { type: 'GenChainSrc' }, closed: { type: 'ClosedChainSrc' }, a: { type: 'ImageSink' }, b: { type: 'ImageSink' } },
      links: {
        l0: { from: ['gen', 'out'], to: ['a', 'in'] },
        l1: { from: ['closed', 'out'], to: ['b', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
  })
})

// ---------------------------------------------------------------------------
// Wire decode (v12) and search filters
// ---------------------------------------------------------------------------

describe('schema wire v12', () => {
  it('is in the advertised accept set', () => {
    expect(DINKSTER_ACCEPTED_WIRE_VERSIONS).toContain(12)
  })

  it('decodes the recursive asset TypeExpr kind exactly like list', () => {
    expect(typeExprFromDinksterWire({ kind: 'asset', element: { kind: 'concrete', types: [IMG] } }))
      .toEqual(asset(concrete(IMG)))
    expect(typeExprFromDinksterWire({
      kind: 'list',
      element: { kind: 'asset', element: { kind: 'list', element: { kind: 'concrete', types: [IMG] } } },
    })).toEqual(list(asset(list(concrete(IMG)))))
    expect(typeExprFromDinksterWire({ kind: 'asset', element: { kind: 'variable', templateId: 'T' } }))
      .toEqual(asset({ kind: 'variable', templateId: 'T' }))
    expect(() => typeExprFromDinksterWire({ kind: 'asset' })).toThrow()
  })
})

describe('search type tokens', () => {
  it("matches asset ports only against 'asset<...>' tokens, recursing on the element", () => {
    expect(typeMatchesToken(asset(concrete(IMG)), 'asset<image>')).toBe(true)
    expect(typeMatchesToken(asset(concrete(IMG)), 'image')).toBe(true)
    expect(typeMatchesToken(concrete(IMG), 'asset<image>')).toBe(false)
    expect(typeMatchesToken(list(asset(concrete(IMG))), 'list<asset<image>>')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Multi-select gating (joint pin (5) + caf1070 amendment)
// ---------------------------------------------------------------------------

describe('assetMultiSelect gating', () => {
  it('permits multi-select only on list-of-asset declarations', () => {
    // N selections lower to N descriptors in a list literal.
    expect(assetMultiSelect(list(asset(concrete(IMG))))).toBe(true)
    expect(assetMultiSelect(list(concrete('dinkster.asset')))).toBe(true)
    // Outer structure decides; an open element does not change how many
    // descriptors a selection produces.
    expect(assetMultiSelect(list(asset(T('T'))))).toBe(true)
  })

  it('keeps asset<list<T>> single-select: its multi-ness is the DECODER (one file, many batches)', () => {
    expect(assetMultiSelect(asset(list(concrete(IMG))))).toBe(false)
  })

  it('rejects every non-list-of-asset shape', () => {
    expect(assetMultiSelect(asset(concrete(IMG)))).toBe(false)
    expect(assetMultiSelect(concrete('dinkster.asset'))).toBe(false)
    expect(assetMultiSelect(list(concrete(IMG)))).toBe(false)
    expect(assetMultiSelect(concrete(IMG))).toBe(false)
    expect(assetMultiSelect({ kind: 'wildcard' })).toBe(false)
    expect(assetMultiSelect(T('T'))).toBe(false)
    expect(assetMultiSelect(list(T('T')))).toBe(false)
  })

  // The third pinned arm (scalar T with a registered batch-merge provider,
  // backend 6dbbddd): membership in the wire-advertised mergeableTypes list
  // gates it - the frontend never guesses mergeability.
  describe('scalar merge arm (mergeableTypes membership)', () => {
    it('a member scalar atom multi-selects; a non-member stays single', () => {
      expect(assetMultiSelect(concrete(IMG), [IMG])).toBe(true)
      expect(assetMultiSelect(concrete('comfy.LATENT'), [IMG])).toBe(false)
    })

    it('absent or empty provider list keeps every scalar single-select (older backend / no providers)', () => {
      expect(assetMultiSelect(concrete(IMG))).toBe(false)
      expect(assetMultiSelect(concrete(IMG), [])).toBe(false)
    })

    it('only scalar concrete atoms take the merge arm: asset/list/variable shapes never do', () => {
      // asset<T> receives ONE ref as-is (never coerced) - membership of T
      // changes nothing.
      expect(assetMultiSelect(asset(concrete(IMG)), [IMG])).toBe(false)
      expect(assetMultiSelect(asset(list(concrete(IMG))), [IMG])).toBe(false)
      // bare dinkster.asset is the untyped atom: no decode target to merge
      // through, even if a bogus list claimed it.
      expect(assetMultiSelect(concrete('dinkster.asset'), ['dinkster.asset'])).toBe(false)
      // parametric ids smuggled into concrete never take the arm.
      expect(assetMultiSelect(concrete(`list<${IMG}>`), [`list<${IMG}>`])).toBe(false)
      expect(assetMultiSelect(concrete(`asset<${IMG}>`), [`asset<${IMG}>`])).toBe(false)
      expect(assetMultiSelect(T('T'), [IMG])).toBe(false)
      expect(assetMultiSelect({ kind: 'wildcard' }, [IMG])).toBe(false)
      // plain list<T> stays structural: links/values there are the lift
      // arm's business, not multi-select merge.
      expect(assetMultiSelect(list(concrete(IMG)), [IMG])).toBe(false)
    })

    it('the list-outer arms are unaffected by the provider list', () => {
      expect(assetMultiSelect(list(asset(concrete(IMG))), [])).toBe(true)
      expect(assetMultiSelect(list(concrete('dinkster.asset')), [])).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// $typed stamping for asset-typed widget taps (typed-literal contract:
// asset<...> ids are legal stamps; taps stamp the TAPPED input's canonical
// type id, and the emission rule keeps concrete destinations plain)
// ---------------------------------------------------------------------------

describe('asset-typed tap $typed lowering', () => {
  const ref = {
    digest: 'blake3:abc', name: 'cat.png', size: 3, mediaType: 'image/png', virtualPath: '',
  }
  const ref2 = { ...ref, digest: 'blake3:def', name: 'dog.png' }
  const assetWidget = { widgetType: 'ASSET', options: {} }
  const tapSchemas: Record<string, NodeSchema> = {
    AssetValue: schemaOf('AssetValue', [
      { kind: 'input', id: 'in', type: asset(concrete(IMG)), optional: false, widget: assetWidget } as InputSpec,
    ]),
    AssetListValue: schemaOf('AssetListValue', [
      { kind: 'input', id: 'in', type: list(asset(concrete(IMG))), optional: false, widget: assetWidget } as InputSpec,
    ]),
    WildSink: schemaOf('WildSink', [input('source', { kind: 'wildcard' })]),
    RefSink: schemaOf('RefSink', [input('in', asset(concrete(IMG)))]),
  }
  const compileTap = (nodeType: string, sinkType: string, sinkPort: string, value: Json) => {
    const g = {
      id: 'g0', name: 'g',
      nodes: {
        a: { id: 'a', type: nodeType, values: { in: value } },
        s: { id: 's', type: sinkType, values: {} },
      },
      links: { l1: { id: 'l1', from: { node: 'a', tap: 'in' }, to: { node: 's', port: sinkPort } } },
      nets: {}, reroutes: {}, nextOrdinal: 9,
    } as unknown as GraphDef
    return compile({
      document: {
        format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage'),
        root: asGraphDefId('g0'), graphs: { g0: g }, view: { graphs: {} },
      },
      revision: 1, resolve: (type) => tapSchemas[type], scope: { kind: 'full' },
      connection: asConnectionId('c0'), schemaHash: 'typed-assets-test',
      graphFeatures: ['typedLiteral'],
    })
  }

  it('stamps an asset<T> tap into a wildcard input with the asset id', () => {
    const result = compileTap('AssetValue', 'WildSink', 'source', ref)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.prompt['s']!.inputs['source'])
        .toEqual({ $typed: { type: 'asset<comfy.IMAGE>', value: ref } })
    }
  })

  it('stamps a list<asset<T>> tap (multi-select value) with the list id', () => {
    const result = compileTap('AssetListValue', 'WildSink', 'source', [ref, ref2])
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) {
      expect(result.artifact.prompt['s']!.inputs['source'])
        .toEqual({ $typed: { type: 'list<asset<comfy.IMAGE>>', value: [ref, ref2] } })
    }
  })

  it('keeps the canonical plain literal on a concrete asset<T> destination (emission rule)', () => {
    const result = compileTap('AssetValue', 'RefSink', 'in', ref)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['s']!.inputs['in']).toEqual(ref)
  })
})

// ---------------------------------------------------------------------------
// 2026-07-26 emission-rule amendment: asset-source literals stamp $typed
// even into CONCRETE destinations when the runtime type differs from the
// declared type - the stamp routes the literal through the backend coercion
// planner (decode asset<T> -> T, lift list<asset<T>> -> list<T>, registry-
// gated merge list<asset<T>> -> T) instead of wrapping refs raw.
// ---------------------------------------------------------------------------

describe('asset-source stamping on concrete destinations (2026-07-26 amendment)', () => {
  // isAssetRefValue-complete refs: the scalar-T arms only stamp values that
  // are genuinely refs (junk stays plain and fails server-side as before).
  const ref = {
    digest: `blake3:${'a'.repeat(64)}`, name: 'cat.png', size: 3,
    mediaType: 'image/png', virtualPath: 'inputs/cat.png',
  }
  const ref2 = { ...ref, digest: `blake3:${'b'.repeat(64)}`, name: 'dog.png' }
  const assetWidget = { widgetType: 'ASSET', options: {} }
  const schemasByType: Record<string, NodeSchema> = {
    AssetValue: schemaOf('AssetValue', [
      { kind: 'input', id: 'in', type: asset(concrete(IMG)), optional: false, widget: assetWidget } as InputSpec,
    ]),
    AssetListValue: schemaOf('AssetListValue', [
      { kind: 'input', id: 'in', type: list(asset(concrete(IMG))), optional: false, widget: assetWidget } as InputSpec,
    ]),
    // The registry-gated scalar-T decode/merge arms: an ASSET widget on a
    // concrete NON-asset input (fixture-only today - backend AssetWidget
    // binding policy 72c0719 - but the lowering must already be correct).
    ScalarValue: schemaOf('ScalarValue', [
      { kind: 'input', id: 'in', type: concrete(IMG), optional: false, widget: assetWidget } as InputSpec,
    ]),
    ScalarListValue: schemaOf('ScalarListValue', [
      { kind: 'input', id: 'in', type: list(concrete(IMG)), optional: false, widget: assetWidget } as InputSpec,
    ]),
    ScalarDefault: schemaOf('ScalarDefault', [
      { kind: 'input', id: 'in', type: concrete(IMG), optional: false, widget: { widgetType: 'ASSET', options: {}, default: ref } } as InputSpec,
    ]),
    IntValue: schemaOf('IntValue', [
      { kind: 'input', id: 'in', type: concrete('core.int'), optional: false, widget: { widgetType: 'INT', options: {} } } as InputSpec,
    ]),
    ImageSink: schemaOf('ImageSink', [input('in', concrete(IMG))]),
    ImageListSink: schemaOf('ImageListSink', [input('in', list(concrete(IMG)))]),
    IntSink: schemaOf('IntSink', [input('in', concrete('core.int'))]),
    WildSink: schemaOf('WildSink', [input('source', { kind: 'wildcard' })]),
    // Asset-REFERENCE destinations: refs deliver AS-IS, never stamped -
    // incl. a DIFFERING asset form (no asset-to-asset coercion exists).
    BareAssetSink: schemaOf('BareAssetSink', [input('in', concrete('dinkster.asset'))]),
    AssetListImgSink: schemaOf('AssetListImgSink', [input('in', asset(list(concrete(IMG))))]),
  }
  const compileWith = (
    nodes: Record<string, { type: string; values: Record<string, Json> }>,
    links: Record<string, { from: unknown; to: unknown }>,
    graphFeatures: string[] = ['typedLiteral'],
  ) => {
    const g = {
      id: 'g0', name: 'g',
      nodes: Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, { id, ...n }])),
      links: Object.fromEntries(Object.entries(links).map(([id, l]) => [id, { id, ...l }])),
      nets: {}, reroutes: {}, nextOrdinal: 9,
    } as unknown as GraphDef
    return compile({
      document: {
        format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage'),
        root: asGraphDefId('g0'), graphs: { g0: g }, view: { graphs: {} },
      },
      revision: 1, resolve: (type) => schemasByType[type], scope: { kind: 'full' },
      connection: asConnectionId('c0'), schemaHash: 'typed-assets-test',
      graphFeatures,
    })
  }
  const tapInto = (nodeType: string, value: Json, sinkType: string, sinkPort: string, graphFeatures?: string[]) =>
    compileWith(
      { a: { type: nodeType, values: { in: value } }, s: { type: sinkType, values: {} } },
      { l1: { from: { node: 'a', tap: 'in' }, to: { node: 's', port: sinkPort } } },
      graphFeatures,
    )

  describe('isAssetSourceTypeId', () => {
    it('accepts exactly asset<T> and list<asset<T>>', () => {
      expect(isAssetSourceTypeId('asset<comfy.IMAGE>')).toBe(true)
      expect(isAssetSourceTypeId('asset<list<comfy.IMAGE>>')).toBe(true)
      expect(isAssetSourceTypeId('list<asset<comfy.IMAGE>>')).toBe(true)
    })
    it('rejects bare atoms, plain lists, and the untyped dinkster.asset forms', () => {
      expect(isAssetSourceTypeId('comfy.IMAGE')).toBe(false)
      expect(isAssetSourceTypeId('list<comfy.IMAGE>')).toBe(false)
      expect(isAssetSourceTypeId('dinkster.asset')).toBe(false)
      expect(isAssetSourceTypeId('list<dinkster.asset>')).toBe(false)
      expect(isAssetSourceTypeId('list<list<asset<comfy.IMAGE>>>')).toBe(false)
    })
  })

  describe('isAssetRefDestinationTypeId', () => {
    it('accepts every declared asset-reference destination form', () => {
      expect(isAssetRefDestinationTypeId('dinkster.asset')).toBe(true)
      expect(isAssetRefDestinationTypeId('asset<comfy.IMAGE>')).toBe(true)
      expect(isAssetRefDestinationTypeId('asset<list<comfy.IMAGE>>')).toBe(true)
      expect(isAssetRefDestinationTypeId('list<dinkster.asset>')).toBe(true)
      expect(isAssetRefDestinationTypeId('list<asset<comfy.IMAGE>>')).toBe(true)
    })
    it('rejects plain atoms and plain lists (those are coercion DESTINATIONS)', () => {
      expect(isAssetRefDestinationTypeId('comfy.IMAGE')).toBe(false)
      expect(isAssetRefDestinationTypeId('list<comfy.IMAGE>')).toBe(false)
      expect(isAssetRefDestinationTypeId('list<list<dinkster.asset>>')).toBe(false)
    })
  })

  describe('tap arms (live: asset-declared widgets into concrete destinations)', () => {
    it('decode arm: an asset<T> tap into concrete T stamps asset<T> (previously a latent plain-literal bug)', () => {
      const result = tapInto('AssetValue', ref, 'ImageSink', 'in')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['s']!.inputs['in'])
          .toEqual({ $typed: { type: 'asset<comfy.IMAGE>', value: ref } })
      }
    })

    it('lift arm: a list<asset<T>> tap into concrete list<T> stamps the list id', () => {
      const result = tapInto('AssetListValue', [ref, ref2], 'ImageListSink', 'in')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['s']!.inputs['in'])
          .toEqual({ $typed: { type: 'list<asset<comfy.IMAGE>>', value: [ref, ref2] } })
      }
    })

    it('merge arm: a list<asset<T>> tap into concrete scalar T stamps the list id (planner merges)', () => {
      const result = tapInto('AssetListValue', [ref, ref2], 'ImageSink', 'in')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['s']!.inputs['in'])
          .toEqual({ $typed: { type: 'list<asset<comfy.IMAGE>>', value: [ref, ref2] } })
      }
    })

    it('does NOT weaken the concrete plain-literal rule for non-asset sources', () => {
      const result = tapInto('IntValue', 7, 'IntSink', 'in')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) expect(result.artifact.prompt['s']!.inputs['in']).toEqual(7)
    })

    it('refuses loudly without the typedLiteral capability instead of shipping raw refs', () => {
      const result = tapInto('AssetValue', ref, 'ImageSink', 'in', [])
      const codes = (result.ok ? result.artifact.diagnostics : result.diagnostics).map((d) => d.code)
      expect(codes).toContain('compile.tap.nonConcreteTarget')
      if (result.ok) expect(result.artifact.prompt['s']!.inputs['in']).toBeUndefined()
    })

    it('asset-REFERENCE destinations are exempt: an asset<T> tap into bare dinkster.asset stays a plain ref', () => {
      const result = tapInto('AssetValue', ref, 'BareAssetSink', 'in')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) expect(result.artifact.prompt['s']!.inputs['in']).toEqual(ref)
    })

    it('a DIFFERING declared asset form stays plain too (no asset-to-asset stamping)', () => {
      const result = tapInto('AssetValue', ref, 'AssetListImgSink', 'in')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) expect(result.artifact.prompt['s']!.inputs['in']).toEqual(ref)
    })

    it('the exempt plain delivery is NOT refused capability-absent (it never needed a stamp)', () => {
      const result = tapInto('AssetValue', ref, 'BareAssetSink', 'in', [])
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.diagnostics.map((d) => d.code)).not.toContain('compile.tap.nonConcreteTarget')
        expect(result.artifact.prompt['s']!.inputs['in']).toEqual(ref)
      }
    })
  })

  describe('stored-value arms (fixture-only today: scalar-T ASSET widgets)', () => {
    it('one ref on a scalar concrete T input stamps asset<T> (decode arm)', () => {
      const result = compileWith({ a: { type: 'ScalarValue', values: { in: ref } } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['a']!.inputs['in'])
          .toEqual({ $typed: { type: 'asset<comfy.IMAGE>', value: ref } })
      }
    })

    it('N refs on a scalar concrete T input stamp list<asset<T>> (merge arm)', () => {
      const result = compileWith({ a: { type: 'ScalarValue', values: { in: [ref, ref2] } } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['a']!.inputs['in'])
          .toEqual({ $typed: { type: 'list<asset<comfy.IMAGE>>', value: [ref, ref2] } })
      }
    })

    it('a matching declared asset form stays a canonical plain literal (no redundant stamp)', () => {
      const result = compileWith({ a: { type: 'AssetValue', values: { in: ref } } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) expect(result.artifact.prompt['a']!.inputs['in']).toEqual(ref)
    })

    it('non-ref-shaped junk stays plain (server-side validation owns it, as before)', () => {
      const result = compileWith({ a: { type: 'ScalarValue', values: { in: { digest: 'nope' } } } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) expect(result.artifact.prompt['a']!.inputs['in']).toEqual({ digest: 'nope' })
    })

    it('a tap reading an already-stamped staged value never double-wraps and carries the SOURCE type', () => {
      const result = tapInto('ScalarValue', [ref, ref2], 'WildSink', 'source')
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['s']!.inputs['source'])
          .toEqual({ $typed: { type: 'list<asset<comfy.IMAGE>>', value: [ref, ref2] } })
      }
    })

    it('N refs on a plain list<T> input stamp list<asset<T>> (lift arm)', () => {
      const result = compileWith({ a: { type: 'ScalarListValue', values: { in: [ref, ref2] } } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['a']!.inputs['in'])
          .toEqual({ $typed: { type: 'list<asset<comfy.IMAGE>>', value: [ref, ref2] } })
      }
    })

    it('one ref on a plain list<T> input stamps asset<list<T>> (decode arm targeting the list)', () => {
      const result = compileWith({ a: { type: 'ScalarListValue', values: { in: ref } } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['a']!.inputs['in'])
          .toEqual({ $typed: { type: 'asset<list<comfy.IMAGE>>', value: ref } })
      }
    })

    it('a schema-default asset-source fallback stamps like a stored value', () => {
      const result = compileWith({ a: { type: 'ScalarDefault', values: {} } }, {})
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['a']!.inputs['in'])
          .toEqual({ $typed: { type: 'asset<comfy.IMAGE>', value: ref } })
      }
    })

    it('capability-absent: a stored asset-source value refuses loudly and is omitted (never raw refs)', () => {
      const result = compileWith({ a: { type: 'ScalarValue', values: { in: ref } } }, {}, [])
      const codes = (result.ok ? result.artifact.diagnostics : result.diagnostics).map((d) => d.code)
      expect(codes).toContain('compile.value.assetSourceUnsupported')
      if (result.ok) expect(result.artifact.prompt['a']!.inputs['in']).toBeUndefined()
    })

    it('capability-absent: a schema-default asset-source fallback refuses the same way', () => {
      const result = compileWith({ a: { type: 'ScalarDefault', values: {} } }, {}, [])
      const codes = (result.ok ? result.artifact.diagnostics : result.diagnostics).map((d) => d.code)
      expect(codes).toContain('compile.value.assetSourceUnsupported')
      if (result.ok) expect(result.artifact.prompt['a']!.inputs['in']).toBeUndefined()
    })
  })

  describe('promoted-override arms (boundary value onto an inner asset-source input)', () => {
    // A subgraph instance holds the ref; the boundary promotes it onto the
    // inner ScalarValue's ASSET-widgeted concrete input. Overrides flow
    // through the SAME lowering as stored values - stamp with the
    // capability, refuse loudly (never raw refs) without it.
    const compilePromoted = (value: Json, graphFeatures: string[] = ['typedLiteral']) => {
      const g0 = {
        id: 'g0', name: 'root',
        nodes: { i: { id: 'i', type: '#sub', values: { img: value } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 9,
      }
      const sub = {
        id: 'sub', name: 'sub',
        nodes: { a: { id: 'a', type: 'ScalarValue', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 9,
        boundary: { inputs: [{ id: 'img', binds: { kind: 'port', node: 'a', port: 'in' }, promoted: true }], outputs: [] },
      }
      return compile({
        document: {
          format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('lineage'),
          root: asGraphDefId('g0'), graphs: { g0, sub }, view: { graphs: {} },
        } as unknown as WorkflowDocument,
        revision: 1, resolve: (type) => schemasByType[type], scope: { kind: 'full' },
        connection: asConnectionId('c0'), schemaHash: 'typed-assets-test',
        graphFeatures,
      })
    }

    it('a promoted asset-source ref stamps asset<T> like a stored value (decode arm)', () => {
      const result = compilePromoted(ref)
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (result.ok) {
        expect(result.artifact.prompt['i.a']!.inputs['in'])
          .toEqual({ $typed: { type: 'asset<comfy.IMAGE>', value: ref } })
      }
    })

    it('capability-absent: a promoted asset-source ref refuses loudly and is omitted (never raw refs)', () => {
      const result = compilePromoted(ref, [])
      const codes = (result.ok ? result.artifact.diagnostics : result.diagnostics).map((d) => d.code)
      expect(codes).toContain('compile.value.assetSourceUnsupported')
      if (result.ok) expect(result.artifact.prompt['i.a']!.inputs['in']).toBeUndefined()
    })
  })
})
