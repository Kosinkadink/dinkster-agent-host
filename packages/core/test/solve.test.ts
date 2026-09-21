/**
 * Type solver tests. The contract under test:
 * - '*' imposes no constraint and never captures ("no permanent wildcard capture")
 * - unions check per edge by atom overlap and are never collapsed
 * - MatchType variables freshen per node occurrence; occurrences of one
 *   template within a node are equal for free; var-var links merge classes
 * - allowedTypes seed the domain; edges intersect it; empty domain = conflict
 *   with EVERY contributing edge marked (deterministic blame)
 * - reroute chains constrain through to the real producer; undriven chains
 *   and value sources constrain nothing
 * - solving is advisory: it never changes which ports exist
 */
import { describe, expect, it } from 'vitest'
import type { GraphDef } from '../src/format/document.js'
import { asNodeId, asPortId } from '../src/ids.js'
import { deriveBoundarySchema, type SchemaResolver } from '../src/schema/derive-boundary.js'
import { defaultDynamicHandlers, elabInputsOf, elaborateInterface, type DynamicKindHandler } from '../src/schema/elaborate.js'
import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'
import { netSinkKey, solveGraphTypes } from '../src/schema/solve.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const T = (templateId: string, allowed?: string[]): TypeExpr => ({
  kind: 'variable',
  templateId,
  ...(allowed ? { allowedTypes: allowed.map((name) => ({ kind: 'concrete', name }) as TypeExpr) } : {}),
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

/** Schema library used across tests. */
const schemas: Record<string, NodeSchema> = {
  // Concrete producers/consumers
  ImageSrc: schemaOf('ImageSrc', [output('out', { kind: 'concrete', name: 'IMAGE' })]),
  ListImageSrc: schemaOf('ListImageSrc', [output('out', { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } })]),
  LatentSrc: schemaOf('LatentSrc', [output('out', { kind: 'concrete', name: 'LATENT' })]),
  ImageSink: schemaOf('ImageSink', [input('in', { kind: 'concrete', name: 'IMAGE' })]),
  LatentSink: schemaOf('LatentSink', [input('in', { kind: 'concrete', name: 'LATENT' })]),
  // Interchangeable comfy-compat pairs (canonicalized inside atomNamesOf)
  DinksterImageSrc: schemaOf('DinksterImageSrc', [output('out', { kind: 'concrete', name: 'dinkster.image' })]),
  ComfyImageSink: schemaOf('ComfyImageSink', [input('in', { kind: 'concrete', name: 'comfy.IMAGE' })]),
  DinksterMaskSrc: schemaOf('DinksterMaskSrc', [output('out', { kind: 'concrete', name: 'dinkster.mask' })]),
  ComfyMaskSink: schemaOf('ComfyMaskSink', [input('in', { kind: 'concrete', name: 'comfy.MASK' })]),
  ComfyImageSwitch: schemaOf('ComfyImageSwitch', [input('in', T('T', ['comfy.IMAGE'])), output('out', T('T', ['comfy.IMAGE']))]),
  // Union producer (MultiType) and wildcard endpoints
  EitherSrc: schemaOf('EitherSrc', [output('out', { kind: 'union', names: ['IMAGE', 'LATENT'] })]),
  AnySrc: schemaOf('AnySrc', [output('out', { kind: 'wildcard' })]),
  AnySink: schemaOf('AnySink', [input('in', { kind: 'wildcard' })]),
  FloatWidget: schemaOf('FloatWidget', [{
    ...input('value', { kind: 'concrete', name: 'FLOAT' }),
    widget: { widgetType: 'FLOAT', options: {}, default: 1 },
  }]),
  SpecializedSlot: schemaOf('SpecializedSlot', [{
    ...input('model', { kind: 'concrete', name: 'MODEL' }),
    dynamic: {
      kind: 'dynamicSlot',
      slotType: { kind: 'concrete', name: 'MODEL' },
      inputs: [],
      variants: [{ key: 'image', type: { kind: 'concrete', name: 'IMAGE' }, inputs: [] }],
    },
  }]),
  MatchedSlot: schemaOf('MatchedSlot', [
    {
      ...input('source', { kind: 'union', names: ['IMAGE', 'MASK'] }),
      dynamic: {
        kind: 'dynamicSlot',
        materialization: 'wire15',
        slotType: { kind: 'union', names: ['IMAGE', 'MASK'] },
        inputs: [],
        variants: [
          { key: 'image', type: { kind: 'concrete', name: 'IMAGE' }, inputs: [input('copy', T('T', ['IMAGE', 'MASK']))] },
          { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, inputs: [input('copy', T('T', ['IMAGE', 'MASK']))] },
        ],
        typeTemplateId: 'T',
      },
    },
    output('out', T('T', ['IMAGE', 'MASK'])),
    output('batch', { kind: 'list', element: T('T', ['IMAGE', 'MASK']) }),
    output('asset', { kind: 'asset', element: T('T', ['IMAGE', 'MASK']) }),
  ]),
  MatchedSlotEmptyFamily: schemaOf('MatchedSlotEmptyFamily', [
    input('count', { kind: 'concrete', name: 'core.int' }),
    {
      ...input('source', { kind: 'union', names: ['IMAGE', 'MASK'] }),
      dynamic: {
        kind: 'dynamicSlot',
        materialization: 'wire15',
        slotType: { kind: 'union', names: ['IMAGE', 'MASK'] },
        inputs: [],
        variants: [
          { key: 'image', type: { kind: 'concrete', name: 'IMAGE' }, inputs: [] },
          { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, inputs: [] },
        ],
        typeTemplateId: 'T',
      },
    },
    {
      ...output('items', T('T', ['IMAGE', 'MASK'])),
      dynamic: {
        kind: 'autogrow',
        materialization: 'wire15',
        template: [input('item', T('T', ['IMAGE', 'MASK']))],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ]),
  // MatchType: input and output share one template
  Switch: schemaOf('Switch', [input('in', T('T')), output('out', T('T'))]),
  // MatchType with an allowed-type domain
  Pickle: schemaOf('Pickle', [input('in', T('T', ['IMAGE', 'LATENT'])), output('out', T('T', ['IMAGE', 'LATENT']))]),
  // Autogrow family whose template slot shares the node's output template
  VarGrower: schemaOf('VarGrower', [
    {
      ...input('inputs', { kind: 'wildcard' }),
      dynamic: {
        kind: 'autogrow',
        template: [input('item', T('T'))],
        naming: { kind: 'prefix', prefix: 'input', min: 1, max: 8 },
      },
    },
    output('out', T('T')),
  ]),
  Wire15VarGrower: schemaOf('Wire15VarGrower', [
    {
      ...input('inputs', { kind: 'wildcard' }),
      dynamic: {
        kind: 'autogrow', materialization: 'wire15',
        template: [input('value', { kind: 'list', element: T('T') })],
        naming: { kind: 'prefix', prefix: 'input', min: 1, max: 8 },
      },
    },
    output('out', { kind: 'list', element: T('T') }),
  ]),
}
const resolve: SchemaResolver = (type) => schemas[type]

/** Assemble a GraphDef literal tersely (branded ids make literals noisy). */
type TestEndpoint =
  | [string, string, string?]
  | { reroute: string }
  | { valueSource: string }
  | { selector: string; candidate?: string }
  | { widgetTap: [string, string] }
const defOf = (parts: {
  nodes: Record<string, { type: string; values?: Record<string, unknown>; dynamic?: Record<string, { members?: string[]; selected?: string; memberState?: Record<string, Record<string, { members: string[] }>> }> }>
  links?: Record<string, { from: TestEndpoint; to: TestEndpoint }>
  nets?: Record<string, { source: [string, string]; sinks: [string, string, string?][] }>
  reroutes?: string[]
  /** Selector id -> candidate ids (policy: fixed on the first). */
  selectors?: Record<string, string[]>
}): GraphDef => {
  const end = (e: TestEndpoint): unknown =>
    Array.isArray(e)
      ? { node: e[0], port: e[1], ...(e[2] !== undefined ? { members: [e[2]] } : {}) }
      : 'widgetTap' in e
        ? { node: e.widgetTap[0], tap: e.widgetTap[1] }
        : e
  return {
    id: 'g0',
    name: 'test',
    nodes: Object.fromEntries(
      Object.entries(parts.nodes).map(([id, n]) => [
        id,
        { id, type: n.type, values: n.values ?? {}, ...(n.dynamic ? { dynamic: n.dynamic } : {}) },
      ]),
    ),
    links: Object.fromEntries(
      Object.entries(parts.links ?? {}).map(([id, l]) => [id, { id, from: end(l.from), to: end(l.to) }]),
    ),
    nets: Object.fromEntries(
      Object.entries(parts.nets ?? {}).map(([id, n]) => [
        id,
        { id, name: id, source: end(n.source), sinks: n.sinks.map(end) },
      ]),
    ),
    reroutes: Object.fromEntries((parts.reroutes ?? []).map((id) => [id, { id }])),
    ...(parts.selectors
      ? {
          selectors: Object.fromEntries(
            Object.entries(parts.selectors).map(([id, candidates]) => [
              id,
              {
                id,
                candidates: candidates.map((c) => ({ id: c })),
                policy: { kind: 'fixed', candidate: candidates[0] },
              },
            ]),
          ),
        }
      : {}),
    nextOrdinal: 99,
  } as unknown as GraphDef
}

const n = asNodeId

// ---------------------------------------------------------------------------
// Atom-vs-atom edges
// ---------------------------------------------------------------------------

describe('concrete and union edges', () => {
  it('overlapping atom sets are ok; disjoint ones are mismatches with a diagnostic', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, okSink: { type: 'ImageSink' }, badSink: { type: 'LatentSink' } },
      links: {
        l0: { from: ['img', 'out'], to: ['okSink', 'in'] },
        l1: { from: ['img', 'out'], to: ['badSink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
    const mismatch = s.diagnostics.find((d) => d.code === 'solve.linkMismatch')
    expect(mismatch?.severity).toBe('warning')
    expect(mismatch?.anchor?.link).toBe('l1')
  })

  it('a dinkster.image output feeds a comfy.IMAGE input with no mismatch', () => {
    const def = defOf({
      nodes: { src: { type: 'DinksterImageSrc' }, sink: { type: 'ComfyImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.diagnostics.filter((d) => d.code === 'solve.linkMismatch')).toEqual([])
  })

  it('a dinkster.mask output feeds a comfy.MASK input but never a comfy.IMAGE one', () => {
    const def = defOf({
      nodes: { src: { type: 'DinksterMaskSrc' }, maskSink: { type: 'ComfyMaskSink' }, imageSink: { type: 'ComfyImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['maskSink', 'in'] },
        l1: { from: ['src', 'out'], to: ['imageSink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
  })

  it('a variable constrained to comfy.IMAGE resolves through a dinkster.image edge', () => {
    const def = defOf({
      nodes: { src: { type: 'DinksterImageSrc' }, sw: { type: 'ComfyImageSwitch' }, sink: { type: 'ComfyImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['sw', 'in'] },
        l1: { from: ['sw', 'out'], to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'comfy.IMAGE' })
    expect(s.diagnostics).toEqual([])
  })

  it('a union producer feeds different atoms simultaneously without collapsing', () => {
    const def = defOf({
      nodes: { src: { type: 'EitherSrc' }, a: { type: 'ImageSink' }, b: { type: 'LatentSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['a', 'in'] },
        l1: { from: ['src', 'out'], to: ['b', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
    // The union is rendered as declared, not narrowed by its consumers.
    expect(s.portTypeOf(n('src'), 'output', 'out')).toEqual({ kind: 'union', names: ['IMAGE', 'LATENT'] })
  })

  it('wildcards impose no constraint in either direction', () => {
    const def = defOf({
      nodes: { any: { type: 'AnySrc' }, sink: { type: 'ImageSink' }, img: { type: 'ImageSrc' }, anySink: { type: 'AnySink' } },
      links: {
        l0: { from: ['any', 'out'], to: ['sink', 'in'] },
        l1: { from: ['img', 'out'], to: ['anySink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// MatchType variables
// ---------------------------------------------------------------------------

describe('MatchType resolution', () => {
  it('projects an occurrence input into every same-template pin and reverts when absent', () => {
    const def = defOf({ nodes: { sw: { type: 'Switch' } } })
    const solveOccurrence = (name?: string) => solveGraphTypes(def, resolve, name === undefined ? {} : {
      projectedInputs: [{
        type: { kind: 'concrete', name },
        to: { node: n('sw'), port: asPortId('in') },
        label: 'parent input',
      }],
    })

    const image = solveOccurrence('IMAGE')
    expect(image.portTypeOf(n('sw'), 'input', 'in')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(image.portTypeOf(n('sw'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(image.diagnostics).toEqual([])

    const latent = solveOccurrence('LATENT')
    expect(latent.portTypeOf(n('sw'), 'input', 'in')).toEqual({ kind: 'concrete', name: 'LATENT' })
    expect(latent.portTypeOf(n('sw'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'LATENT' })

    const disconnected = solveOccurrence()
    expect(disconnected.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(disconnected.portTypeOf(n('sw'), 'input', 'in')).toEqual(T('T'))
    expect(disconnected.portTypeOf(n('sw'), 'output', 'out')).toEqual(T('T'))
  })

  it('keeps an unresolved projected producer variable unconstrained', () => {
    const def = defOf({ nodes: { sw: { type: 'Switch' } } })
    const solved = solveGraphTypes(def, resolve, {
      projectedInputs: [{
        type: T('upstream'),
        to: { node: n('sw'), port: asPortId('in') },
      }],
    })
    expect(solved.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(solved.portTypeOf(n('sw'), 'input', 'in')).toEqual(T('T'))
    expect(solved.portTypeOf(n('sw'), 'output', 'out')).toEqual(T('T'))
    expect(solved.diagnostics).toEqual([])
  })

  it('preserves one projected producer variable across multiple destination classes', () => {
    const def = defOf({
      nodes: {
        first: { type: 'Switch' },
        second: { type: 'Switch' },
        image: { type: 'ImageSink' },
      },
      links: { constrain: { from: ['first', 'out'], to: ['image', 'in'] } },
    })
    const shared = Symbol('upstream node')
    const project = (node: string, variableSource: symbol) => ({
      type: T('upstream'),
      to: { node: n(node), port: asPortId('in') },
      variableSource,
    })

    const solved = solveGraphTypes(def, resolve, {
      projectedInputs: [project('first', shared), project('second', shared)],
    })
    expect(solved.resolutionOf(n('first'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.resolutionOf(n('second'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('second'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(solved.diagnostics).toEqual([])

    const independent = solveGraphTypes(def, resolve, {
      projectedInputs: [project('first', Symbol('first producer')), project('second', Symbol('second producer'))],
    })
    expect(independent.resolutionOf(n('first'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(independent.resolutionOf(n('second'), 'T')).toEqual({ kind: 'unconstrained' })
  })

  it('reports conflicts shared through one projected producer variable', () => {
    const def = defOf({
      nodes: {
        first: { type: 'Switch' },
        second: { type: 'Switch' },
        image: { type: 'ImageSink' },
        latent: { type: 'LatentSink' },
      },
      links: {
        image: { from: ['first', 'out'], to: ['image', 'in'] },
        latent: { from: ['second', 'out'], to: ['latent', 'in'] },
      },
    })
    const shared = Symbol('upstream node')
    const solved = solveGraphTypes(def, resolve, {
      projectedInputs: [
        { type: T('upstream'), to: { node: n('first'), port: asPortId('in') }, label: 'parent first', variableSource: shared },
        { type: T('upstream'), to: { node: n('second'), port: asPortId('in') }, label: 'parent second', variableSource: shared },
      ],
    })

    expect(solved.resolutionOf(n('first'), 'T')).toEqual({ kind: 'conflict' })
    expect(solved.resolutionOf(n('second'), 'T')).toEqual({ kind: 'conflict' })
    expect(solved.linkVerdicts.get('image' as never)).toBe('mismatch')
    expect(solved.linkVerdicts.get('latent' as never)).toBe('mismatch')
    expect(solved.diagnostics).toHaveLength(1)
    expect(solved.diagnostics[0]).toEqual(expect.objectContaining({ code: 'solve.varConflict' }))
    expect(new Set(solved.diagnostics[0]!.data?.edges as string[])).toEqual(new Set([
      "link 'image'",
      "link 'latent'",
      'parent first',
      'parent second',
    ]))
  })

  it('keeps projected variables isolated from every persisted node and template identity', () => {
    const collisionTemplate = 'projected-input:0\u0000upstream'
    const collision = schemaOf('Collision', [input('in', T(collisionTemplate)), output('out', T(collisionTemplate))])
    const def = defOf({
      nodes: {
        '': { type: collision.type },
        image: { type: 'ImageSrc' },
        target: { type: 'Switch' },
      },
      links: { collision: { from: ['image', 'out'], to: ['', 'in'] } },
    })
    const solved = solveGraphTypes(def, (type) => type === collision.type ? collision : resolve(type), {
      projectedInputs: [{
        type: T('upstream'),
        to: { node: n('target'), port: asPortId('in') },
      }],
    })
    expect(solved.portTypeOf(n(''), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(solved.resolutionOf(n('target'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(solved.portTypeOf(n('target'), 'input', 'in')).toEqual(T('T'))
    expect(solved.portTypeOf(n('target'), 'output', 'out')).toEqual(T('T'))
    expect(solved.diagnostics).toEqual([])
  })

  it('anchors projected variable conflicts to the real target without claiming link verdicts', () => {
    const target = schemaOf('LatentVariable', [
      input('in', T('target', ['LATENT'])),
      output('out', T('target', ['LATENT'])),
    ])
    const def = defOf({ nodes: { target: { type: target.type } } })
    const to = { node: n('target'), port: asPortId('in') }
    const solved = solveGraphTypes(def, (type) => type === target.type ? target : resolve(type), {
      projectedInputs: [{ type: T('upstream', ['IMAGE']), to, label: 'parent input' }],
    })
    expect(solved.resolutionOf(n('target'), 'target')).toEqual({ kind: 'conflict' })
    expect(solved.diagnostics).toEqual([
      expect.objectContaining({
        code: 'solve.varConflict',
        message: expect.stringMatching(/type variable 'target'.*input 'in'.*node 'target'.*parent input/),
        anchor: { port: to },
        data: { edges: ['parent input'] },
      }),
    ])
    expect(solved.diagnostics[0]!.message).not.toContain('links are marked')
    expect(solved.linkVerdicts.size).toBe(0)
    expect(solved.netSinkVerdicts.size).toBe(0)
  })

  it('intersects projected input domains and reports conflicts without document link verdicts', () => {
    const def = defOf({ nodes: { p: { type: 'Pickle' } } })
    const projected = (type: TypeExpr) => ({ type, to: { node: n('p'), port: asPortId('in') } })
    const ambiguous = solveGraphTypes(def, resolve, {
      projectedInputs: [projected({ kind: 'union', names: ['IMAGE', 'LATENT', 'MASK'] })],
    })
    expect(ambiguous.resolutionOf(n('p'), 'T')).toEqual({ kind: 'ambiguous', names: ['IMAGE', 'LATENT'] })

    const conflict = solveGraphTypes(def, resolve, {
      projectedInputs: [projected({ kind: 'concrete', name: 'MASK' })],
    })
    expect(conflict.resolutionOf(n('p'), 'T')).toEqual({ kind: 'conflict' })
    expect(conflict.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['solve.varConflict'])
    expect(conflict.linkVerdicts.size).toBe(0)
    expect(conflict.netSinkVerdicts.size).toBe(0)
  })

  it('a concrete edge resolves the variable; ports sharing the template follow', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['img', 'out'], to: ['sw', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    // The OUTPUT display type follows the input's resolution - same variable.
    expect(s.portTypeOf(n('sw'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(s.diagnostics).toEqual([])
  })

  it('a union edge leaves the variable ambiguous, rendered as the remaining union', () => {
    const def = defOf({
      nodes: { src: { type: 'EitherSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['src', 'out'], to: ['sw', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'ambiguous', names: ['IMAGE', 'LATENT'] })
    expect(s.portTypeOf(n('sw'), 'output', 'out')).toEqual({ kind: 'union', names: ['IMAGE', 'LATENT'] })
  })

  it('conflicting edges mark EVERY contributing edge and diagnose once', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, sw: { type: 'Switch' }, lat: { type: 'LatentSink' } },
      links: {
        l0: { from: ['img', 'out'], to: ['sw', 'in'] },
        l1: { from: ['sw', 'out'], to: ['lat', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'conflict' })
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
    expect(s.diagnostics.filter((d) => d.code === 'solve.varConflict')).toHaveLength(1)
    // Conflict never rewrites the declared port type.
    expect(s.portTypeOf(n('sw'), 'input', 'in')).toEqual(T('T'))
  })

  it('allowedTypes seed the domain: out-of-domain edges conflict, narrowing edges resolve', () => {
    const bad = defOf({
      nodes: { mask: { type: 'ImageSrc' }, p: { type: 'Pickle' } },
      links: { l0: { from: ['mask', 'out'], to: ['p', 'in'] } },
    })
    // IMAGE is inside the allowed domain -> resolved.
    expect(solveGraphTypes(bad, resolve).resolutionOf(n('p'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })

    const maskSrc = schemaOf('MaskSrc', [output('out', { kind: 'concrete', name: 'MASK' })])
    const outOfDomain = defOf({
      nodes: { m: { type: 'MaskSrc' }, p: { type: 'Pickle' } },
      links: { l0: { from: ['m', 'out'], to: ['p', 'in'] } },
    })
    const s = solveGraphTypes(outOfDomain, (t) => (t === 'MaskSrc' ? maskSrc : schemas[t]))
    expect(s.resolutionOf(n('p'), 'T')).toEqual({ kind: 'conflict' })
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
  })

  it('an unconnected variable is unconstrained even with allowedTypes declared', () => {
    const def = defOf({ nodes: { p: { type: 'Pickle' } } })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('p'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(s.portTypeOf(n('p'), 'input', 'in')).toEqual(T('T', ['IMAGE', 'LATENT']))
  })

  it('no permanent wildcard capture: a wildcard edge neither resolves nor blocks resolution', () => {
    // Wildcard feeds T's input; a concrete IMAGE consumer hangs off T's
    // output. The wildcard must not capture T (else the IMAGE edge could
    // never resolve it) and must not block the concrete edge from doing so.
    const def = defOf({
      nodes: { any: { type: 'AnySrc' }, sw: { type: 'Switch' }, sink: { type: 'ImageSink' } },
      links: {
        l0: { from: ['any', 'out'], to: ['sw', 'in'] },
        l1: { from: ['sw', 'out'], to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })

  it('var-var edges merge classes: resolution flows through a generic chain', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, a: { type: 'Switch' }, b: { type: 'Switch' } },
      links: {
        l0: { from: ['img', 'out'], to: ['a', 'in'] },
        l1: { from: ['a', 'out'], to: ['b', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('b'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.portTypeOf(n('b'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
  })

  it('variables freshen per node occurrence: two instances of one schema resolve independently', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, lat: { type: 'LatentSrc' }, a: { type: 'Switch' }, b: { type: 'Switch' } },
      links: {
        l0: { from: ['img', 'out'], to: ['a', 'in'] },
        l1: { from: ['lat', 'out'], to: ['b', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('a'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.resolutionOf(n('b'), 'T')).toEqual({ kind: 'resolved', name: 'LATENT' })
    expect(s.diagnostics).toEqual([])
  })

  it('two instances of one SUBGRAPH definition resolve independently (derived boundary schema)', () => {
    // Inner definition: one Switch whose template crosses the boundary. The
    // derived schema carries the namespaced variable 'sw:T'; prefixing the
    // instance node id at solve time compounds to per-occurrence freshness.
    const innerDef = {
      id: 'gsub',
      name: 'wrap',
      nodes: { sw: { id: 'sw', type: 'Switch', values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      boundary: {
        inputs: [{ id: 'in', binds: { kind: 'port', node: 'sw', port: 'in' } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'sw', port: 'out' } }],
      },
      nextOrdinal: 1,
    } as unknown as GraphDef
    const derived = deriveBoundarySchema(innerDef, resolve).schema!
    expect(derived.type).toBe('#gsub')
    const resolveWith: SchemaResolver = (type) => (type === derived.type ? derived : schemas[type])

    const def = defOf({
      nodes: {
        img: { type: 'ImageSrc' },
        lat: { type: 'LatentSrc' },
        i1: { type: derived.type },
        i2: { type: derived.type },
      },
      links: {
        l0: { from: ['img', 'out'], to: ['i1', 'in'] },
        l1: { from: ['lat', 'out'], to: ['i2', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolveWith)
    expect(s.resolutionOf(n('i1'), 'sw:T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.resolutionOf(n('i2'), 'sw:T')).toEqual({ kind: 'resolved', name: 'LATENT' })
    // Each instance's boundary output follows ITS variable, not the sibling's.
    expect(s.portTypeOf(n('i1'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(s.portTypeOf(n('i2'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'LATENT' })
    expect(s.diagnostics).toEqual([])
  })

  it('autogrow members all constrain the family template: mixed feeds conflict', () => {
    const def = defOf({
      nodes: {
        img: { type: 'ImageSrc' },
        lat: { type: 'LatentSrc' },
        g: { type: 'VarGrower', dynamic: { inputs: { members: ['m0', 'm1'] } } },
      },
      links: {
        l0: { from: ['img', 'out'], to: ['g', 'inputs.item', 'm0'] },
        l1: { from: ['lat', 'out'], to: ['g', 'inputs.item', 'm1'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('g'), 'T')).toEqual({ kind: 'conflict' })
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')

    const consistent = defOf({
      nodes: {
        img: { type: 'ImageSrc' },
        img2: { type: 'ImageSrc' },
        g: { type: 'VarGrower', dynamic: { inputs: { members: ['m0', 'm1'] } } },
      },
      links: {
        l0: { from: ['img', 'out'], to: ['g', 'inputs.item', 'm0'] },
        l1: { from: ['img2', 'out'], to: ['g', 'inputs.item', 'm1'] },
      },
    })
    const ok = solveGraphTypes(consistent, resolve)
    expect(ok.resolutionOf(n('g'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(ok.portTypeOf(n('g'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
  })

  it('a widget output constrains a dynamic family member and its shared output', () => {
    const def = defOf({
      nodes: {
        widget: { type: 'FloatWidget' },
        list: { type: 'VarGrower', dynamic: { inputs: { members: ['m0'] } } },
      },
      links: {
        l0: { from: { widgetTap: ['widget', 'value'] }, to: ['list', 'inputs.item', 'm0'] },
      },
    })
    const solved = solveGraphTypes(def, resolve)
    expect(solved.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(solved.resolutionOf(n('list'), 'T')).toEqual({ kind: 'resolved', name: 'FLOAT' })
    expect(solved.portTypeOf(n('list'), 'input', 'inputs.item#m0')).toEqual({ kind: 'concrete', name: 'FLOAT' })
    expect(solved.portTypeOf(n('list'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'FLOAT' })
    expect(solved.diagnostics).toEqual([])
  })

  it('wire-15 materialized list variables join every member with same-template outputs', () => {
    const def = defOf({
      nodes: {
        src: { type: 'ListImageSrc' },
        grow: { type: 'Wire15VarGrower', dynamic: { inputs: { members: ['stable'] } } },
      },
      links: { l0: { from: ['src', 'out'], to: ['grow', 'inputs.stable'] } },
    })
    const solved = solveGraphTypes(def, resolve)
    expect(solved.resolutionOf(n('grow'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('grow'), 'input', 'inputs.stable')).toEqual({
      kind: 'list', element: { kind: 'concrete', name: 'IMAGE' },
    })
    expect(solved.portTypeOf(n('grow'), 'output', 'out')).toEqual({
      kind: 'list', element: { kind: 'concrete', name: 'IMAGE' },
    })
    expect(solved.diagnostics).toEqual([])
  })

  it('a nested member ref is never flattened onto the flat member: unknown + portMissing', () => {
    // Flat elaboration stamps inputs.item#m0; a link addressing the deeper
    // path m0.g0 must NOT bind to it (that would cross-wire sibling scopes
    // once recursive elaboration lands). Until then: unknown verdict + diag.
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, g: { type: 'VarGrower', dynamic: { inputs: { members: ['m0'] } } } },
      links: { l0: { from: ['img', 'out'], to: ['g', 'inputs.item', 'm0'] } },
    })
    const l0 = (def.links as Record<string, { to: { members?: readonly string[] } }>)['l0']!
    ;(l0 as { to: unknown }).to = { ...l0.to, members: ['m0', 'g0'] }
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('unknown')
    expect(s.resolutionOf(n('g'), 'T')).toEqual({ kind: 'unconstrained' }) // no constraint leaked
    const missing = s.diagnostics.find((d) => d.code === 'solve.portMissing')
    expect(missing?.message).toContain("member 'm0.g0'")
  })

  it('solves through a recursively elaborated nested address (autogrow-in-autogrow)', () => {
    // Real recursive elaboration: the outer family's template
    // slot carries an inner family whose slot shares the node's MatchType
    // template. The solver must find the port by FULL member path and
    // constrain the template through it.
    const withNested: SchemaResolver = (t) =>
      t === 'NestedGrower'
        ? schemaOf('NestedGrower', [
            {
              ...input('inputs', { kind: 'wildcard' }),
              dynamic: {
                kind: 'autogrow',
                template: [
                  {
                    ...input('sub', { kind: 'wildcard' }),
                    dynamic: {
                      kind: 'autogrow',
                      template: [input('item', T('T'))],
                      naming: { kind: 'prefix', prefix: 'g', min: 0, max: 4 },
                    },
                  },
                ],
                naming: { kind: 'prefix', prefix: 'item', min: 1, max: 4 },
              },
            },
            output('out', T('T')),
          ])
        : schemas[t]
    const def = defOf({
      nodes: {
        img: { type: 'ImageSrc' },
        g: {
          type: 'NestedGrower',
          dynamic: {
            inputs: { members: ['m0'], memberState: { m0: { 'inputs.sub': { members: ['g0'] } } } },
          },
        },
      },
      links: { l0: { from: ['img', 'out'], to: ['g', 'inputs.sub.item', 'm0'] } },
    })
    const l0 = (def.links as Record<string, { to: { members?: readonly string[] } }>)['l0']!
    ;(l0 as { to: unknown }).to = { ...l0.to, members: ['m0', 'g0'] }
    const s = solveGraphTypes(def, withNested)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf(n('g'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.diagnostics).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reroutes, nets, value sources
// ---------------------------------------------------------------------------

describe('edges through structure', () => {
  it('reroute chains constrain through to the real producer', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, sw: { type: 'Switch' } },
      links: {
        l0: { from: ['img', 'out'], to: { reroute: 'r0' } },
        l1: { from: { reroute: 'r0' }, to: ['sw', 'in'] },
      },
      reroutes: ['r0'],
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    // The consumer-delivering hop carries the verdict; the structural feed has none.
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.linkVerdicts.has('l0' as never)).toBe(false)
  })

  it('undriven reroutes and value sources constrain nothing', () => {
    const def = defOf({
      nodes: { sw: { type: 'Switch' } },
      links: {
        l0: { from: { reroute: 'r0' }, to: ['sw', 'in'] },
      },
      reroutes: ['r0'],
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(s.linkVerdicts.has('l0' as never)).toBe(false)
  })

  it('named-net sinks are constrained and get per-sink verdicts', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, ok: { type: 'ImageSink' }, bad: { type: 'LatentSink' } },
      nets: { net0: { source: ['img', 'out'], sinks: [['ok', 'in'], ['bad', 'in']] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.netSinkVerdicts.get(netSinkKey('net0', 0))).toBe('ok')
    expect(s.netSinkVerdicts.get(netSinkKey('net0', 1))).toBe('mismatch')
  })
})

// ---------------------------------------------------------------------------
// Unknowns and the anti-oscillation invariant
// ---------------------------------------------------------------------------

describe('unknown endpoints', () => {
  it('an unresolvable node type yields unknown verdicts, not mismatches', () => {
    const def = defOf({
      nodes: { ghost: { type: 'NoSuchNode' }, sink: { type: 'ImageSink' } },
      links: { l0: { from: ['ghost', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('unknown')
    expect(s.diagnostics.filter((d) => d.code === 'solve.linkMismatch')).toEqual([])
  })

  it('a link to a not-currently-elaborated port is unknown plus an info diagnostic', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['img', 'out'], to: ['sw', 'nope'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('unknown')
    const info = s.diagnostics.find((d) => d.code === 'solve.portMissing')
    expect(info?.severity).toBe('info')
  })
})

describe('solving is advisory', () => {
  it('never changes which ports exist: elaboration output is identical with and without links', () => {
    const withLink = defOf({
      nodes: { img: { type: 'ImageSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['img', 'out'], to: ['sw', 'in'] } },
    })
    solveGraphTypes(withLink, resolve)
    // The Switch schema has no dynamic constructs: its elaborated interface
    // is a pure function of the schema, untouched by solving.
    const e = elaborateInterface(schemas['Switch']!, { values: {} })
    expect(elabInputsOf(e).map((i) => i.address.port)).toEqual(['in'])
  })

  it('is deterministic: identical inputs give structurally identical resolutions', () => {
    const def = defOf({
      nodes: { src: { type: 'EitherSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['src', 'out'], to: ['sw', 'in'] } },
    })
    const a = solveGraphTypes(def, resolve)
    const b = solveGraphTypes(def, resolve)
    expect(a.resolutionOf(n('sw'), 'T')).toEqual(b.resolutionOf(n('sw'), 'T'))
    expect([...a.linkVerdicts.entries()]).toEqual([...b.linkVerdicts.entries()])
  })
})

// ---------------------------------------------------------------------------
// Selector branches (policy-independent conservative solving)
// ---------------------------------------------------------------------------

describe('selector branches', () => {
  it('a consumer fed by a selector output checks against EVERY branch producer', () => {
    // IMAGE and LATENT branches feeding an ImageSink: the LATENT branch can
    // be picked by a future policy change, so the output link is a mismatch.
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, lat: { type: 'LatentSrc' }, sink: { type: 'ImageSink' } },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l0: { from: ['img', 'out'], to: { selector: 's1', candidate: 'ca' } },
        l1: { from: ['lat', 'out'], to: { selector: 's1', candidate: 'cb' } },
        l2: { from: { selector: 's1' }, to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l2' as never)).toBe('mismatch')
    expect(s.diagnostics.some((d) => d.code === 'solve.linkMismatch')).toBe(true)
    // Candidate feeds are structural: no verdicts of their own.
    expect(s.linkVerdicts.get('l0' as never)).toBeUndefined()
    expect(s.linkVerdicts.get('l1' as never)).toBeUndefined()
  })

  it('homogeneous branches are ok; verdicts are sticky-worst, not last-write-wins', () => {
    const def = defOf({
      nodes: { a: { type: 'ImageSrc' }, b: { type: 'ImageSrc' }, sink: { type: 'ImageSink' } },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l0: { from: ['a', 'out'], to: { selector: 's1', candidate: 'ca' } },
        l1: { from: ['b', 'out'], to: { selector: 's1', candidate: 'cb' } },
        l2: { from: { selector: 's1' }, to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l2' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })

  it('an UNCONSUMED selector never unifies its branches (heterogeneous feeds are fine)', () => {
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, lat: { type: 'LatentSrc' } },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l0: { from: ['img', 'out'], to: { selector: 's1', candidate: 'ca' } },
        l1: { from: ['lat', 'out'], to: { selector: 's1', candidate: 'cb' } },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.diagnostics).toEqual([])
    expect([...s.linkVerdicts.entries()]).toEqual([])
  })

  it('MatchType variables see all branches: heterogeneous feeds conflict the class', () => {
    // Pickle's T (domain IMAGE|LATENT) is intersected by BOTH branches:
    // IMAGE then LATENT -> empty -> conflict, contributing edge marked.
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, lat: { type: 'LatentSrc' }, pk: { type: 'Pickle' } },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l0: { from: ['img', 'out'], to: { selector: 's1', candidate: 'ca' } },
        l1: { from: ['lat', 'out'], to: { selector: 's1', candidate: 'cb' } },
        l2: { from: { selector: 's1' }, to: ['pk', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('pk'), 'T').kind).toBe('conflict')
    expect(s.linkVerdicts.get('l2' as never)).toBe('mismatch')
    expect(s.diagnostics.some((d) => d.code === 'solve.varConflict')).toBe(true)
  })

  it('MatchType variables resolve through homogeneous selector branches', () => {
    const def = defOf({
      nodes: { a: { type: 'ImageSrc' }, b: { type: 'ImageSrc' }, sw: { type: 'Switch' } },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l0: { from: ['a', 'out'], to: { selector: 's1', candidate: 'ca' } },
        l1: { from: ['b', 'out'], to: { selector: 's1', candidate: 'cb' } },
        l2: { from: { selector: 's1' }, to: ['sw', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.linkVerdicts.get('l2' as never)).toBe('ok')
  })

  it('composes: reroutes and selector chains solve end to end', () => {
    // img -> r1 -> s1/ca; s1 -> s2/cx; s2 -> r2 -> sink
    const def = defOf({
      nodes: { img: { type: 'ImageSrc' }, sink: { type: 'ImageSink' } },
      reroutes: ['r1', 'r2'],
      selectors: { s1: ['ca'], s2: ['cx'] },
      links: {
        l0: { from: ['img', 'out'], to: { reroute: 'r1' } },
        l1: { from: { reroute: 'r1' }, to: { selector: 's1', candidate: 'ca' } },
        l2: { from: { selector: 's1' }, to: { selector: 's2', candidate: 'cx' } },
        l3: { from: { selector: 's2' }, to: { reroute: 'r2' } },
        l4: { from: { reroute: 'r2' }, to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l4' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })

  it('an undriven candidate constrains nothing; driven branches still check', () => {
    const def = defOf({
      nodes: { lat: { type: 'LatentSrc' }, sink: { type: 'ImageSink' } },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l1: { from: ['lat', 'out'], to: { selector: 's1', candidate: 'cb' } },
        l2: { from: { selector: 's1' }, to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l2' as never)).toBe('mismatch') // the LATENT branch
  })

  it('autogrow members behind a selector solve like any other branch producer', () => {
    // Two IMAGE branches feed a selector; its output feeds an autogrow
    // member slot whose template shares the node's output variable.
    const def = defOf({
      nodes: {
        a: { type: 'ImageSrc' },
        b: { type: 'ImageSrc' },
        vg: { type: 'VarGrower', dynamic: { inputs: { members: ['input1'] } } },
        sink: { type: 'ImageSink' },
      },
      selectors: { s1: ['ca', 'cb'] },
      links: {
        l0: { from: ['a', 'out'], to: { selector: 's1', candidate: 'ca' } },
        l1: { from: ['b', 'out'], to: { selector: 's1', candidate: 'cb' } },
        l2: { from: { selector: 's1' }, to: ['vg', 'inputs.item', 'input1'] },
        l3: { from: ['vg', 'out'], to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('vg'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.linkVerdicts.get('l2' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l3' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })
})

describe('dynamicSlot MatchType binding', () => {
  const matched = (selected: 'image' | 'mask') => ({
    type: 'MatchedSlot',
    dynamic: { source: { selected } },
  })

  it.each([
    ['image', 'IMAGE'],
    ['mask', 'MASK'],
  ] as const)('binds the selected %s variant through inputs and outputs', (selected, expected) => {
    const solved = solveGraphTypes(defOf({ nodes: { matched: matched(selected) } }), resolve)
    expect(solved.resolutionOf(n('matched'), 'T')).toEqual({ kind: 'resolved', name: expected })
    expect(solved.portTypeOf(n('matched'), 'input', 'source')).toEqual({ kind: 'concrete', name: expected })
    expect(solved.portTypeOf(n('matched'), 'input', 'source.copy')).toEqual({ kind: 'concrete', name: expected })
    expect(solved.portTypeOf(n('matched'), 'output', 'out')).toEqual({ kind: 'concrete', name: expected })
    expect(solved.portTypeOf(n('matched'), 'output', 'batch')).toEqual({
      kind: 'list', element: { kind: 'concrete', name: expected },
    })
    expect(solved.portTypeOf(n('matched'), 'output', 'asset')).toEqual({
      kind: 'asset', element: { kind: 'concrete', name: expected },
    })
  })

  it('binds an interchangeable Dinkster type in the canonical solver domain', () => {
    const image = { kind: 'concrete', name: 'dinkster.image' } as const
    const matchedImage = schemaOf('DinksterMatchedSlot', [
      {
        ...input('source', image),
        dynamic: {
          kind: 'dynamicSlot',
          materialization: 'wire15',
          slotType: image,
          inputs: [],
          variants: [{ key: 'image', type: image, inputs: [] }],
          typeTemplateId: 'T',
        },
      },
      output('out', T('T', ['dinkster.image'])),
    ])
    const solved = solveGraphTypes(defOf({
      nodes: { matched: { type: matchedImage.type, dynamic: { source: { selected: 'image' } } } },
    }), (type) => type === matchedImage.type ? matchedImage : resolve(type))

    expect(solved.diagnostics).toEqual([])
    expect(solved.resolutionOf(n('matched'), 'T')).toEqual({ kind: 'resolved', name: 'comfy.IMAGE' })
    expect(solved.portTypeOf(n('matched'), 'output', 'out')).toEqual(image)
  })

  it('keeps the stored choice authoritative across producer changes and disconnect', () => {
    const disconnected = defOf({ nodes: { matched: matched('mask') } })
    const imageDriven = defOf({
      nodes: { src: { type: 'ImageSrc' }, matched: matched('mask') },
      links: { l0: { from: ['src', 'out'], to: ['matched', 'source'] } },
    })
    const before = JSON.stringify(imageDriven)
    for (const def of [disconnected, imageDriven]) {
      const solved = solveGraphTypes(def, resolve)
      expect(solved.resolutionOf(n('matched'), 'T')).toEqual({ kind: 'resolved', name: 'MASK' })
      expect(solved.portTypeOf(n('matched'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'MASK' })
    }
    expect(solveGraphTypes(imageDriven, resolve).linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(JSON.stringify(imageDriven)).toBe(before)
  })

  it('blames downstream links that conflict with the selected type', () => {
    const def = defOf({
      nodes: { matched: matched('image'), sink: { type: 'LatentSink' } },
      links: { l0: { from: ['matched', 'out'], to: ['sink', 'in'] } },
    })
    const solved = solveGraphTypes(def, resolve)
    expect(solved.resolutionOf(n('matched'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('matched'), 'output', 'out')).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(solved.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(solved.diagnostics.filter((diag) => diag.code === 'solve.linkMismatch')).toHaveLength(1)
  })

  it('binds the selected type when a matched output family has zero members', () => {
    const solved = solveGraphTypes(defOf({
      nodes: {
        matched: {
          type: 'MatchedSlotEmptyFamily',
          values: { count: 0 },
          dynamic: { source: { selected: 'mask' } },
        },
      },
    }), resolve)
    expect(solved.diagnostics).toEqual([])
    expect(solved.resolutionOf(n('matched'), 'T')).toEqual({ kind: 'resolved', name: 'MASK' })
    expect(solved.portTypeOf(n('matched'), 'input', 'source')).toEqual({ kind: 'concrete', name: 'MASK' })
    expect(solved.portTypeOf(n('matched'), 'output', 'items')).toBeUndefined()
  })

  it('diagnoses an active input allowlist that rejects the stored selection', () => {
    const narrowed = schemaOf('NarrowedMatchedSlot', [
      {
        ...input('source', { kind: 'union', names: ['IMAGE', 'MASK'] }),
        dynamic: {
          kind: 'dynamicSlot',
          materialization: 'wire15',
          slotType: { kind: 'union', names: ['IMAGE', 'MASK'] },
          inputs: [],
          variants: [
            { key: 'image', type: { kind: 'concrete', name: 'IMAGE' }, inputs: [] },
            { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, inputs: [input('copy', T('T', ['IMAGE']))] },
          ],
          typeTemplateId: 'T',
        },
      },
      output('out', T('T', ['IMAGE', 'MASK'])),
    ])
    const solved = solveGraphTypes(defOf({
      nodes: { matched: { type: narrowed.type, dynamic: { source: { selected: 'mask' } } } },
    }), (type) => type === narrowed.type ? narrowed : resolve(type))
    expect(solved.resolutionOf(n('matched'), 'T')).toEqual({ kind: 'conflict' })
    expect(solved.portTypeOf(n('matched'), 'input', 'source.copy')).toEqual({ kind: 'concrete', name: 'MASK' })
    expect(solved.diagnostics).toEqual([
      expect.objectContaining({
        code: 'solve.varConflict',
        message: expect.stringContaining("stored DynamicSlot 'source' variant 'mask'"),
        anchor: { port: { node: 'matched', port: 'source' } },
        data: { edges: [], slotSelections: ['matched/source=mask'] },
      }),
    ])
  })
})

describe('dynamicSlot specialization staleness', () => {
  const staleWarnings = (def: GraphDef) => solveGraphTypes(def, resolve).diagnostics.filter((d) => d.code === 'solve.slot.staleSpecialization')
  const slotNode = (selected: boolean) => ({ type: 'SpecializedSlot', dynamic: { model: selected ? { selected: 'image' } : {} } })

  it('warns when a direct producer is incompatible with the selected variant', () => {
    const warnings = staleWarnings(defOf({
      nodes: { src: { type: 'LatentSrc' }, slot: slotNode(true) },
      links: { l0: { from: ['src', 'out'], to: ['slot', 'model'] } },
    }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ severity: 'warning', anchor: { port: { node: 'slot', port: 'model' } } })
  })

  it('traces an incompatible producer through a reroute', () => {
    const warnings = staleWarnings(defOf({
      nodes: { src: { type: 'LatentSrc' }, slot: slotNode(true) },
      reroutes: ['r0'],
      links: {
        l0: { from: ['src', 'out'], to: { reroute: 'r0' } },
        l1: { from: { reroute: 'r0' }, to: ['slot', 'model'] },
      },
    }))
    expect(warnings).toHaveLength(1)
  })

  it('abstains when the producer type is wildcard', () => {
    expect(staleWarnings(defOf({
      nodes: { src: { type: 'AnySrc' }, slot: slotNode(true) },
      links: { l0: { from: ['src', 'out'], to: ['slot', 'model'] } },
    }))).toEqual([])
  })

  it('does not warn when the producer is compatible with the selected variant', () => {
    expect(staleWarnings(defOf({
      nodes: { src: { type: 'ImageSrc' }, slot: slotNode(true) },
      links: { l0: { from: ['src', 'out'], to: ['slot', 'model'] } },
    }))).toEqual([])
  })

  it('does not warn when the connected slot has no selected variant', () => {
    expect(staleWarnings(defOf({
      nodes: { src: { type: 'LatentSrc' }, slot: slotNode(false) },
      links: { l0: { from: ['src', 'out'], to: ['slot', 'model'] } },
    }))).toEqual([])
  })
})
