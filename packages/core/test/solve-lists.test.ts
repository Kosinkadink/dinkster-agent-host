/**
 * Recursive list types (Dinkster schema wire v2, DESIGN 3.13). The contract:
 * - `list<T>` is ONE value on ONE edge; the canonical runtime identity of a
 *   closed list is the parametric string 'list<...>' (nesting composes)
 * - one schema representation: `{ kind: 'list' }`, never concrete('list<...>')
 * - cardinality is STRUCTURAL: definite list-vs-scalar edges are errors
 *   (solve.listIntoScalar / solve.scalarIntoList), unlike advisory atom
 *   mismatches which stay warnings
 * - closed lists behave as ordinary atoms in solver domains; open lists
 *   (variable below the constructor) peel the constructor and unify elements
 * - deliberate under-constraint: open list vs bare variable records nothing
 */
import { describe, expect, it } from 'vitest'
import { typesCompatible } from '../src/schema/type-compatibility.js'
import { asNodeId, asPortId } from '../src/ids.js'
import type { GraphDef } from '../src/format/document.js'
import type { SchemaResolver } from '../src/schema/derive-boundary.js'
import {
  cardinalityOf,
  canonicalTypeIdOf,
  listTypeId,
  parseListTypeId,
  typeExprFromTypeId,
  type InputSpec,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '../src/schema/model.js'
import { solveGraphTypes } from '../src/schema/solve.js'

// ---------------------------------------------------------------------------
// Builders (house style of solve.test.ts)
// ---------------------------------------------------------------------------

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const list = (element: TypeExpr): TypeExpr => ({ kind: 'list', element })
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

const schemas: Record<string, NodeSchema> = {
  ImageSrc: schemaOf('ImageSrc', [output('out', concrete('IMAGE'))]),
  LatentSrc: schemaOf('LatentSrc', [output('out', concrete('LATENT'))]),
  ImageSink: schemaOf('ImageSink', [input('in', concrete('IMAGE'))]),
  ListImageSrc: schemaOf('ListImageSrc', [output('out', list(concrete('IMAGE')))]),
  ListLatentSrc: schemaOf('ListLatentSrc', [output('out', list(concrete('LATENT')))]),
  ListImageSink: schemaOf('ListImageSink', [input('in', list(concrete('IMAGE')))]),
  ListLatentSink: schemaOf('ListLatentSink', [input('in', list(concrete('LATENT')))]),
  NestedListSrc: schemaOf('NestedListSrc', [output('out', list(list(concrete('IMAGE'))))]),
  NestedListSink: schemaOf('NestedListSink', [input('in', list(list(concrete('IMAGE'))))]),
  // Open list: a Map-style node relating element types across the constructor
  ListMap: schemaOf('ListMap', [input('in', list(T('T'))), output('out', list(T('T')))]),
  // Element extractor: list<T> in, T out
  ListGet: schemaOf('ListGet', [input('in', list(T('T'))), output('out', T('T'))]),
  // Bare variable passthrough
  Switch: schemaOf('Switch', [input('in', T('T')), output('out', T('T'))]),
  // Append to List's list<T> plus one representative member from its T family.
  Append: schemaOf('Append', [input('list', list(T('T'))), input('item', T('T')), output('out', list(T('T')))]),
  AnySrc: schemaOf('AnySrc', [output('out', { kind: 'wildcard' })]),
  AnySink: schemaOf('AnySink', [input('in', { kind: 'wildcard' })]),
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

const n = asNodeId

// ---------------------------------------------------------------------------
// Canonical grammar (single owner: model.ts)
// ---------------------------------------------------------------------------

describe('canonical list type ids', () => {
  it('round-trips through the single parser, nesting included', () => {
    expect(listTypeId('core.int')).toBe('list<core.int>')
    expect(parseListTypeId('list<core.int>')).toBe('core.int')
    expect(parseListTypeId(listTypeId(listTypeId('core.int')))).toBe('list<core.int>')
    expect(parseListTypeId('core.int')).toBeUndefined()
    expect(parseListTypeId('list<>')).toBeUndefined()
  })

  it('canonicalTypeIdOf and typeExprFromTypeId are inverses on closed types', () => {
    const nested = list(list(concrete('core.int')))
    expect(canonicalTypeIdOf(nested)).toBe('list<list<core.int>>')
    expect(typeExprFromTypeId('list<list<core.int>>')).toEqual(nested)
    expect(typeExprFromTypeId('IMAGE')).toEqual(concrete('IMAGE'))
    // Open expressions have no canonical id.
    expect(canonicalTypeIdOf(list(T('T')))).toBeUndefined()
    expect(canonicalTypeIdOf({ kind: 'wildcard' })).toBeUndefined()
  })

  it('cardinality is structural: lists are lists, atoms are scalars, variables unknown', () => {
    expect(cardinalityOf(list(concrete('IMAGE')))).toBe('list')
    expect(cardinalityOf(concrete('IMAGE'))).toBe('scalar')
    expect(cardinalityOf(T('T'))).toBe('unknown')
    expect(cardinalityOf({ kind: 'wildcard' })).toBe('unknown')
    // Defensive: a smuggled canonical id still reports its true shape.
    expect(cardinalityOf(concrete('list<IMAGE>'))).toBe('list')
  })
})

// ---------------------------------------------------------------------------
// Advisory compatibility
// ---------------------------------------------------------------------------

describe('typesCompatible with lists', () => {
  it('same closed lists match; different elements do not; nesting is exact', () => {
    expect(typesCompatible(list(concrete('IMAGE')), list(concrete('IMAGE')))).toBe(true)
    expect(typesCompatible(list(concrete('IMAGE')), list(concrete('LATENT')))).toBe(false)
    expect(typesCompatible(list(list(concrete('IMAGE'))), list(concrete('IMAGE')))).toBe(false)
  })

  it('cardinality never coerces: list vs scalar is incompatible in both directions', () => {
    expect(typesCompatible(list(concrete('IMAGE')), concrete('IMAGE'))).toBe(false)
    expect(typesCompatible(concrete('IMAGE'), list(concrete('IMAGE')))).toBe(false)
  })

  it('open lists match structurally: wildcards/variables inside stay permissive', () => {
    expect(typesCompatible(list(T('T')), list(concrete('IMAGE')))).toBe(true)
    expect(typesCompatible(list({ kind: 'wildcard' }), list(concrete('IMAGE')))).toBe(true)
    expect(typesCompatible(list(T('T', ['IMAGE'])), list(concrete('LATENT')))).toBe(false)
    // Wildcard at the top matches anything, including lists.
    expect(typesCompatible({ kind: 'wildcard' }, list(concrete('IMAGE')))).toBe(true)
    // Unconstrained bare variable stays permissive against an open list.
    expect(typesCompatible(T('U'), list(T('T')))).toBe(true)
  })

  it('list<union> denotes one atom per member', () => {
    expect(typesCompatible(list({ kind: 'union', names: ['IMAGE', 'LATENT'] }), list(concrete('LATENT')))).toBe(true)
    expect(typesCompatible(list({ kind: 'union', names: ['IMAGE', 'LATENT'] }), list(concrete('MASK')))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

describe('solver: closed lists as atoms', () => {
  it('matching closed lists are ok; mismatched elements warn with canonical names', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, ok: { type: 'ListImageSink' }, bad: { type: 'ListLatentSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['ok', 'in'] },
        l1: { from: ['src', 'out'], to: ['bad', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
    const d = s.diagnostics.find((x) => x.code === 'solve.linkMismatch')
    expect(d?.severity).toBe('warning')
    expect(d?.message).toContain('list<IMAGE>')
    expect(d?.message).toContain('list<LATENT>')
  })

  it('nested closed lists compare by exact canonical identity', () => {
    const def = defOf({
      nodes: { src: { type: 'NestedListSrc' }, ok: { type: 'NestedListSink' }, bad: { type: 'ListImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['ok', 'in'] },
        l1: { from: ['src', 'out'], to: ['bad', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
  })
})

describe('solver: structural cardinality errors', () => {
  it('list into scalar is an ERROR (not an advisory warning)', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, sink: { type: 'ImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    const d = s.diagnostics.find((x) => x.code === 'solve.listIntoScalar')
    expect(d?.severity).toBe('error')
    expect(d?.anchor?.link).toBe('l0')
  })

  it('scalar into list is an ERROR', () => {
    const def = defOf({
      nodes: { src: { type: 'ImageSrc' }, sink: { type: 'ListImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.diagnostics.find((x) => x.code === 'solve.scalarIntoList')?.severity).toBe('error')
  })

  it('wildcards still impose nothing across cardinality', () => {
    const def = defOf({
      nodes: { any: { type: 'AnySrc' }, sink: { type: 'ListImageSink' }, src: { type: 'ListImageSrc' }, anySink: { type: 'AnySink' } },
      links: {
        l0: { from: ['any', 'out'], to: ['sink', 'in'] },
        l1: { from: ['src', 'out'], to: ['anySink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })
})

describe('solver: open lists peel the constructor', () => {
  it('projects nested list structure through a shared template without flattening it', () => {
    const def = defOf({ nodes: { map: { type: 'ListMap' } } })
    const solved = solveGraphTypes(def, resolve, {
      projectedInputs: [{
        type: list(concrete('IMAGE')),
        to: { node: n('map'), port: asPortId('in') },
      }],
    })
    expect(solved.resolutionOf(n('map'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('map'), 'input', 'in')).toEqual(list(concrete('IMAGE')))
    expect(solved.portTypeOf(n('map'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
    expect(solved.diagnostics).toEqual([])
  })

  it('list<T> fed by a closed list resolves T to the element', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, map: { type: 'ListMap' } },
      links: { l0: { from: ['src', 'out'], to: ['map', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf(n('map'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    // Substitution rebuilds structure under the constructor.
    expect(s.portTypeOf(n('map'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
  })

  it('Append to List infers its items and output from the list input', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, append: { type: 'Append' } },
      links: { l0: { from: ['src', 'out'], to: ['append', 'list'] } },
    })
    const solved = solveGraphTypes(def, resolve)

    expect(solved.resolutionOf(n('append'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('append'), 'input', 'item')).toEqual(concrete('IMAGE'))
    expect(solved.portTypeOf(n('append'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
  })

  it('Append to List remains valid while its type is unconstrained', () => {
    const solved = solveGraphTypes(defOf({ nodes: { append: { type: 'Append' } } }), resolve)

    expect(solved.resolutionOf(n('append'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(solved.portTypeOf(n('append'), 'input', 'list')).toEqual(list(T('T')))
    expect(solved.portTypeOf(n('append'), 'input', 'item')).toEqual(T('T'))
    expect(solved.portTypeOf(n('append'), 'output', 'out')).toEqual(list(T('T')))
    expect(solved.diagnostics).toEqual([])
  })

  it('Append to List infers its list and output from an item, including nested lists', () => {
    const scalar = solveGraphTypes(defOf({
      nodes: { src: { type: 'ImageSrc' }, append: { type: 'Append' } },
      links: { l0: { from: ['src', 'out'], to: ['append', 'item'] } },
    }), resolve)
    expect(scalar.portTypeOf(n('append'), 'input', 'list')).toEqual(list(concrete('IMAGE')))
    expect(scalar.portTypeOf(n('append'), 'output', 'out')).toEqual(list(concrete('IMAGE')))

    const nested = solveGraphTypes(defOf({
      nodes: { src: { type: 'ListImageSrc' }, append: { type: 'Append' } },
      links: { l0: { from: ['src', 'out'], to: ['append', 'item'] } },
    }), resolve)
    expect(nested.resolutionOf(n('append'), 'T')).toEqual({ kind: 'resolved', name: 'list<IMAGE>' })
    expect(nested.portTypeOf(n('append'), 'input', 'list')).toEqual(list(list(concrete('IMAGE'))))
    expect(nested.portTypeOf(n('append'), 'output', 'out')).toEqual(list(list(concrete('IMAGE'))))
  })

  it('Append to List reports conflicting list and item constraints', () => {
    const solved = solveGraphTypes(defOf({
      nodes: { images: { type: 'ListImageSrc' }, latent: { type: 'LatentSrc' }, append: { type: 'Append' } },
      links: {
        l0: { from: ['images', 'out'], to: ['append', 'list'] },
        l1: { from: ['latent', 'out'], to: ['append', 'item'] },
      },
    }), resolve)
    expect(solved.resolutionOf(n('append'), 'T')).toEqual({ kind: 'conflict' })
    expect(solved.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(solved.linkVerdicts.get('l1' as never)).toBe('mismatch')
    expect(solved.diagnostics.find((diagnostic) => diagnostic.code === 'solve.varConflict')?.message)
      .toContain("type variable 'T'")
  })

  it('list<T> in, T out relates element to downstream scalar consumers', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, get: { type: 'ListGet' }, sink: { type: 'ImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['get', 'in'] },
        l1: { from: ['get', 'out'], to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.resolutionOf(n('get'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
  })

  it('conflicting element constraints mark every contributing edge', () => {
    const def = defOf({
      nodes: { a: { type: 'ListImageSrc' }, b: { type: 'ListLatentSrc' }, map: { type: 'ListMap' }, map2: { type: 'ListMap' } },
      links: {
        l0: { from: ['a', 'out'], to: ['map', 'in'] },
        // map -> map2 merges their element variables; b conflicts with a.
        l1: { from: ['map', 'out'], to: ['map2', 'in'] },
        l2: { from: ['b', 'out'], to: ['map2', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('map'), 'T')).toEqual({ kind: 'conflict' })
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.linkVerdicts.get('l2' as never)).toBe('mismatch')
    expect(s.diagnostics.some((d) => d.code === 'solve.varConflict')).toBe(true)
  })

  it('a bare variable fed by a closed list resolves to the canonical id and renders structurally', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['src', 'out'], to: ['sw', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'list<IMAGE>' })
    // Never concrete('list<...>'): substitution rebuilds the structured form.
    expect(s.portTypeOf(n('sw'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
  })

  it('open list vs bare variable records no constraint (documented under-constraint)', () => {
    const def = defOf({
      nodes: { sw: { type: 'Switch' }, map: { type: 'ListMap' } },
      links: { l0: { from: ['sw', 'out'], to: ['map', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(s.resolutionOf(n('map'), 'T')).toEqual({ kind: 'unconstrained' })
  })

  it('two instances of one open-list schema resolve independently', () => {
    const def = defOf({
      nodes: { a: { type: 'ListImageSrc' }, b: { type: 'ListLatentSrc' }, m1: { type: 'ListMap' }, m2: { type: 'ListMap' } },
      links: {
        l0: { from: ['a', 'out'], to: ['m1', 'in'] },
        l1: { from: ['b', 'out'], to: ['m2', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('m1'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.resolutionOf(n('m2'), 'T')).toEqual({ kind: 'resolved', name: 'LATENT' })
  })
})
