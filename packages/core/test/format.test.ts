/**
 * Document loading + migration pipeline tests: golden fixtures load clean,
 * foreign formats are detected and rejected with targeted diagnostics, the
 * migration chain replays stepwise, and corrupted documents fail shape
 * validation with precise paths.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/diagnostics.js'
import type { Json, JsonObject } from '../src/format/document.js'
import { detectFormat, loadDocument, migrateJson, type MigrationStep } from '../src/format/migrate.js'
import { validateDocumentShape } from '../src/format/validate.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'))

const errorsOf = (diags: readonly Diagnostic[]) => diags.filter((d) => d.severity === 'error')

describe('golden workflow fixtures', () => {
  for (const name of ['minimal', 'subgraph']) {
    it(`${name}.json loads without error diagnostics`, () => {
      const result = loadDocument(loadFixture(name))
      expect(errorsOf(result.diagnostics)).toEqual([])
      expect(result.document).toBeDefined()
    })
  }

  it('preserves extension data through load', () => {
    const result = loadDocument(loadFixture('subgraph'))
    const doc = result.document!
    expect(doc.ext).toEqual({ myPack: { custom: true } })
    expect(doc.graphs['g1']!.nodes['n0']!.ext).toEqual({ vhs: { note: 'extension data round-trips' } })
  })

  it('round-trips through JSON serialization unchanged', () => {
    const raw = loadFixture('subgraph')
    const result = loadDocument(raw)
    expect(JSON.parse(JSON.stringify(result.document))).toEqual(raw)
  })

  it('round-trips widget output boundary bindings without legacy port canonicalization', () => {
    const raw = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
    const graph = (raw['graphs'] as Record<string, Record<string, unknown>>)['g1']!
    const boundary = graph['boundary'] as Record<string, Record<string, unknown>[]>
    boundary['outputs']![0]!['binds'] = { kind: 'widgetTap', node: 'n0', tap: 'seed' }
    const result = loadDocument(JSON.parse(JSON.stringify(raw)))
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(JSON.parse(JSON.stringify(result.document))).toEqual(raw)
  })

  it('round-trips rect and legacy viewport bookmarks through load', () => {
    const raw = structuredClone(loadFixture('minimal')) as Record<string, unknown>
    const view = raw['view'] as Record<string, unknown>
    view['bookmarks'] = {
      '1': { graphStack: ['g0'], instancePath: [], view: { x: -20, y: 10, width: 800, height: 600 } },
      '2': { graphStack: ['g0'], instancePath: [], viewport: { x: 5, y: 6, scale: 1.25 } },
    }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(JSON.parse(JSON.stringify(result.document))).toEqual(raw)
  })

  it('CO1 returns a deep-frozen document detached from the caller JSON', () => {
    const raw = loadFixture('subgraph') as Record<string, unknown>
    const result = loadDocument(raw)
    const doc = result.document!
    expect(Object.isFrozen(doc)).toBe(true)
    expect(Object.isFrozen(doc.graphs)).toBe(true)
    expect(Object.isFrozen(Object.values(doc.graphs)[0]!.nodes)).toBe(true)
    // Mutating the input after load must not reach the returned document.
    raw['graphs'] = {}
    expect(Object.keys(doc.graphs).length).toBeGreaterThan(0)
  })
})

describe('foreign format detection', () => {
  it('detects and rejects legacy litegraph workflows', () => {
    const raw = loadFixture('legacy-litegraph')
    expect(detectFormat(raw)).toBe('litegraph-workflow')
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]!.code).toBe('doc.foreign.litegraph')
  })

  it('detects and rejects Comfy API prompts', () => {
    const prompt = {
      '3': { class_type: 'KSampler', inputs: { seed: 5, model: ['4', 0] } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    }
    expect(detectFormat(prompt)).toBe('comfy-api-prompt')
    expect(loadDocument(prompt).diagnostics[0]!.code).toBe('doc.foreign.apiPrompt')
  })

  it('rejects unrecognizable JSON', () => {
    for (const junk of [null, 42, [], { hello: 'world' }]) {
      const result = loadDocument(junk)
      expect(result.document).toBeUndefined()
      expect(result.diagnostics[0]!.code).toBe('doc.foreign.unknown')
    }
  })

  it('owns hostile input BEFORE any traversal: accessors never invoked, cycles rejected', () => {
    let invoked = false
    const hostile = {}
    Object.defineProperty(hostile, 'format', {
      enumerable: true,
      get() {
        invoked = true
        return 'dinkster-workflow'
      },
    })
    const out = loadDocument(hostile)
    expect(out.document).toBeUndefined()
    expect(out.diagnostics[0]!.code).toBe('doc.notJson')
    expect(invoked).toBe(false)

    const cyclic: Record<string, unknown> = { format: 'dinkster-workflow' }
    cyclic['self'] = cyclic
    const cy = loadDocument(cyclic)
    expect(cy.document).toBeUndefined()
    expect(cy.diagnostics[0]!.code).toBe('doc.notJson')
  })

  it('rejects documents nested past the ingress depth budget with a diagnostic', () => {
    let deep: unknown = 1
    for (let i = 0; i < 100_000; i++) deep = [deep]
    const result = loadDocument({ format: 'dinkster-workflow', deep })
    expect(result.document).toBeUndefined()
    expect(result.diagnostics[0]!.code).toBe('doc.notJson')
  })
})

describe('migration pipeline', () => {
  const doc = (version: number): JsonObject => ({
    ...(loadFixture('minimal') as JsonObject),
    formatVersion: version,
  })

  const step = (from: number, mark: string): MigrationStep => ({
    from,
    description: `test step ${from} -> ${from + 1}`,
    migrate: (d) => ({
      doc: { ...d, ext: { ...(d['ext'] as JsonObject | undefined), [mark]: true } },
      diagnostics: [],
    }),
  })

  it('replays the chain stepwise and stamps the target version', () => {
    const result = migrateJson(doc(1), [step(1, 'a'), step(2, 'b')], 3)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.doc!['formatVersion']).toBe(3)
    expect(result.doc!['ext']).toEqual({ a: true, b: true })
  })

  it('fails with a gap diagnostic when a step is missing', () => {
    const result = migrateJson(doc(1), [step(2, 'b')], 3)
    expect(result.doc).toBeUndefined()
    expect(result.diagnostics[0]!.code).toBe('doc.version.gap')
  })

  it('rejects documents from a future format version', () => {
    const result = loadDocument(doc(99))
    expect(result.document).toBeUndefined()
    expect(result.diagnostics[0]!.code).toBe('doc.version.future')
  })

  it('rejects invalid formatVersion values', () => {
    for (const bad of [0, -1, 1.5, '1', undefined]) {
      const result = migrateJson({ ...doc(1), formatVersion: bad as never })
      expect(result.doc).toBeUndefined()
      expect(result.diagnostics[0]!.code).toBe('doc.version.invalid')
    }
  })
})

describe('upgrade path through loadDocument (synthetic steps)', () => {
  // The migration registry is empty pre-release (v1 is unstable and revised
  // in place), so upgradability is actively validated here with SYNTHETIC
  // shape-preserving steps running the FULL production load path:
  // detect -> migrate chain -> version stamp -> shape validation -> invariants.
  const mark = (from: number, key: string): MigrationStep => ({
    from,
    description: `test step ${from} -> ${from + 1}`,
    migrate: (d) => ({
      doc: { ...d, ext: { ...(d['ext'] as JsonObject | undefined), [key]: true } },
      diagnostics: [],
    }),
  })

  it('replays the chain, stamps the target version, and still shape/invariant-checks', () => {
    const result = loadDocument(loadFixture('minimal'), {
      migrations: [mark(1, 'a'), mark(2, 'b')],
      targetVersion: 3,
    })
    expect(errorsOf(result.diagnostics)).toEqual([])
    const doc = result.document!
    expect(doc.formatVersion).toBe(3)
    expect(doc.ext).toEqual({ a: true, b: true })
    // The rest of the document survived the round trip.
    expect(doc.graphs['g0']!.nodes['n0']).toBeDefined()
  })

  it('a step that corrupts the document is caught by post-migration validation', () => {
    const corruptStep: MigrationStep = {
      from: 1,
      description: 'bad step: drops the view',
      migrate: (d) => {
        const { view: _view, ...rest } = d
        return { doc: rest, diagnostics: [] }
      },
    }
    const result = loadDocument(loadFixture('minimal'), {
      migrations: [corruptStep],
      targetVersion: 2,
    })
    expect(result.document).toBeUndefined()
    expect(errorsOf(result.diagnostics).length).toBeGreaterThan(0)
  })
})

describe('shape validation failures', () => {
  const corrupt = (mutate: (d: JsonObject) => JsonObject): unknown =>
    mutate(structuredClone(loadFixture('minimal')) as JsonObject)

  it('rejects positional values arrays with a precise path', () => {
    const bad = corrupt((d) => {
      const graphs = d['graphs'] as JsonObject
      const g0 = graphs['g0'] as JsonObject
      const nodes = g0['nodes'] as JsonObject
      const n0 = nodes['n0'] as JsonObject
      return {
        ...d,
        graphs: { g0: { ...g0, nodes: { ...nodes, n0: { ...n0, values: ['positional'] } } } },
      }
    })
    const result = loadDocument(bad)
    expect(result.document).toBeUndefined()
    const errors = errorsOf(result.diagnostics)
    expect(errors.some((e) => e.message.includes('$.graphs.g0.nodes.n0.values'))).toBe(true)
  })

  it('rejects array-shaped view groups (groups are an id-keyed record)', () => {
    const bad = corrupt((d) => {
      const view = d['view'] as JsonObject
      const graphs = view['graphs'] as JsonObject
      const g0 = graphs['g0'] as JsonObject
      return {
        ...d,
        view: {
          ...view,
          graphs: {
            g0: {
              ...g0,
              groups: [{ id: 'grp0', title: 'Old style', bounds: { x: 0, y: 0, width: 10, height: 10 } }],
            },
          },
        },
      }
    })
    const result = loadDocument(bad)
    expect(result.document).toBeUndefined()
    expect(errorsOf(result.diagnostics).some((e) => e.message.includes('$.view.graphs.g0.groups'))).toBe(true)
  })

  it('accepts boundary pseudo-node view state; rejects unknown sides and bad positions', () => {
    const withBoundary = (boundary: Json): unknown =>
      corrupt((d) => {
        const view = d['view'] as JsonObject
        const graphs = view['graphs'] as JsonObject
        const g0 = graphs['g0'] as JsonObject
        return { ...d, view: { ...view, graphs: { ...graphs, g0: { ...g0, boundary } } } }
      })

    const ok = loadDocument(withBoundary({ inputs: { position: { x: -100, y: 20 } } }))
    expect(errorsOf(ok.diagnostics)).toEqual([])
    expect(ok.document).toBeDefined()

    const badSide = loadDocument(withBoundary({ sideways: { position: { x: 0, y: 0 } } }))
    expect(badSide.document).toBeUndefined()
    expect(errorsOf(badSide.diagnostics).some((e) => e.message.includes('$.view.graphs.g0.boundary.sideways'))).toBe(
      true,
    )

    const badPos = loadDocument(withBoundary({ outputs: { position: { x: 'a' } } }))
    expect(badPos.document).toBeUndefined()
    expect(
      errorsOf(badPos.diagnostics).some((e) => e.message.includes('$.view.graphs.g0.boundary.outputs.position')),
    ).toBe(true)
  })

  it('rejects malformed link endpoints', () => {
    const bad = corrupt((d) => {
      const graphs = d['graphs'] as JsonObject
      const g0 = graphs['g0'] as JsonObject
      return {
        ...d,
        graphs: { g0: { ...g0, links: { l2: { id: 'l2', from: { node: 'n0' }, to: 'n1' } } } },
      }
    })
    const diags = validateDocumentShape(bad)
    expect(diags.some((e) => e.message.includes('$.graphs.g0.links.l2.from.port'))).toBe(true)
    expect(diags.some((e) => e.message.includes('$.graphs.g0.links.l2.to'))).toBe(true)
  })

  const withN0Sections = (d: JsonObject, sections: unknown): JsonObject => {
    const view = d['view'] as JsonObject
    const graphs = view['graphs'] as JsonObject
    const g0 = graphs['g0'] as JsonObject
    const nodes = g0['nodes'] as JsonObject
    const n0 = nodes['n0'] as JsonObject
    return {
      ...d,
      view: {
        ...view,
        graphs: { ...graphs, g0: { ...g0, nodes: { ...nodes, n0: { ...n0, sections } } } },
      },
    } as JsonObject
  }

  it('rejects malformed view section overrides with precise paths', () => {
    const bad = corrupt((d) => withN0Sections(d, { adv: { collapsed: 'yes' }, other: 'nope' }))
    const diags = validateDocumentShape(bad)
    expect(diags.some((e) => e.message.includes('$.view.graphs.g0.nodes.n0.sections.adv.collapsed'))).toBe(true)
    expect(diags.some((e) => e.message.includes('$.view.graphs.g0.nodes.n0.sections.other'))).toBe(true)
  })

  it('accepts well-formed view section overrides', () => {
    const good = corrupt((d) => withN0Sections(d, { adv: { collapsed: true } }))
    expect(validateDocumentShape(good)).toEqual([])
    const result = loadDocument(good)
    expect(result.document?.view.graphs['g0']?.nodes['n0']?.sections).toEqual({ adv: { collapsed: true } })
  })

  const withN0Dynamic = (d: JsonObject, dynamic: unknown): JsonObject => {
    const graphs = d['graphs'] as JsonObject
    const g0 = graphs['g0'] as JsonObject
    const nodes = g0['nodes'] as JsonObject
    const n0 = nodes['n0'] as JsonObject
    return {
      ...d,
      graphs: { ...graphs, g0: { ...g0, nodes: { ...nodes, n0: { ...n0, dynamic } } } },
    } as JsonObject
  }

  it('accepts nested member-scoped dynamic state', () => {
    const good = corrupt((d) =>
      withN0Dynamic(d, {
        items: {
          members: ['m0', 'm1'],
          seq: 2,
          memberState: {
            m0: { 'items.sub': { members: ['m10'], memberState: { m10: { 'items.sub.mode': { selected: 'a' } } } } },
          },
        },
      }),
    )
    expect(validateDocumentShape(good)).toEqual([])
  })

  it('rejects malformed nested dynamic state with precise paths', () => {
    const bad = corrupt((d) =>
      withN0Dynamic(d, {
        items: {
          members: ['m0'],
          seq: -1,
          memberState: { m0: { 'items.sub': { members: [''] } } },
        },
      }),
    )
    const diags = validateDocumentShape(bad)
    const prefix = '$.graphs.g0.nodes.n0.dynamic.items'
    expect(diags.some((e) => e.message.includes(`${prefix}.seq`))).toBe(true)
    expect(diags.some((e) => e.message.includes(`${prefix}.memberState.m0.items.sub.members[0]`))).toBe(true)
  })

  it('rejects dynamic state nested beyond the hard depth budget', () => {
    // Build depth-17 nesting; the validator caps at 16 (the elaborator would
    // never read deeper, so anything past it is malformed by definition).
    let st: JsonObject = { members: ['m0'] }
    for (let i = 0; i < 17; i++) {
      st = { members: ['m0'], memberState: { m0: { c: st } } }
    }
    const bad = corrupt((d) => withN0Dynamic(d, { items: st }))
    const diags = validateDocumentShape(bad)
    expect(diags.some((e) => e.message.includes('nested deeper than 16 levels'))).toBe(true)
  })

  it('rejects conflicting whole-subtree and narrowed slot paths (runtime-only rule)', () => {
    // JSON Schema cannot express the prefix-conflict rule, so this lives
    // ONLY in the runtime validator - not in the schema-agreement matrix.
    const bad = structuredClone(loadFixture('subgraph')) as JsonObject
    const g1 = (bad['graphs'] as Record<string, JsonObject>)['g1']!
    const boundary = g1['boundary'] as Record<string, Record<string, unknown>[]>
    boundary['inputs']![0]!['binds'] = { kind: 'family', node: 'n2', port: 'input', slots: ['sub', 'sub.s'] }
    delete boundary['inputs']![0]!['displayName']
    const diags = validateDocumentShape(bad)
    expect(diags.some((e) => e.message.includes("conflicts with narrower 'sub.s'"))).toBe(true)
  })

  it('still runs invariants after shape validation (dangling link)', () => {
    const bad = corrupt((d) => {
      const graphs = d['graphs'] as JsonObject
      const g0 = graphs['g0'] as JsonObject
      const links = g0['links'] as JsonObject
      const l2 = links['l2'] as JsonObject
      return {
        ...d,
        graphs: { g0: { ...g0, links: { l2: { ...l2, to: { node: 'n99', port: 'clip' } } } } },
      }
    })
    const result = loadDocument(bad)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.some((e) => e.code === 'doc.link.dangling')).toBe(true)
  })
})

describe('pre-release canonicalization: retired scalar member', () => {
  // Pre-release, v1 is revised in place: documents saved while PortRef
  // carried a scalar `member` are translated to the canonical member-id
  // path array `members` on load. There is no ongoing dual representation.
  const legacy = () => structuredClone(loadFixture('retired-scalar-member')) as JsonObject

  it('canonicalizes every PortRef position: link to, net sinks, boundary binds', () => {
    const result = loadDocument(legacy())
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.member.retired')).toBe(true)
    const doc = result.document!
    const g0 = doc.graphs['g0']!
    expect(g0.links['l3']!.to).toEqual({ node: 'n1', port: 'input.input', members: ['m1'] })
    expect(g0.nets['net4']!.sinks).toEqual([{ node: 'n1', port: 'input.input', members: ['m0'] }])
    const g1 = doc.graphs['g1']!
    expect(g1.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n0', port: 'input.input', members: ['m0'] })
    // The retired field is gone everywhere, not merely shadowed.
    expect(JSON.stringify(doc)).not.toContain('"member"')
  })

  it('does not mutate the caller-supplied JSON', () => {
    const raw = legacy()
    loadDocument(raw)
    expect(raw).toEqual(legacy())
  })

  it('canonical load-save-load is stable (no further rewrites)', () => {
    const first = loadDocument(legacy()).document!
    const saved = JSON.parse(JSON.stringify(first))
    const second = loadDocument(saved)
    expect(errorsOf(second.diagnostics)).toEqual([])
    expect(second.diagnostics.some((d) => d.code === 'doc.member.retired')).toBe(false)
    expect(JSON.parse(JSON.stringify(second.document))).toEqual(saved)
  })

  it('rejects nested member paths that do not resolve through persisted dynamic state', () => {
    const raw = JSON.parse(JSON.stringify(loadDocument(legacy()).document)) as JsonObject
    const g0 = (raw['graphs'] as JsonObject)['g0'] as JsonObject
    const l3 = (g0['links'] as JsonObject)['l3'] as Record<string, unknown>
    l3['to'] = { node: 'n1', port: 'input.input', members: ['outer', 'inner'] }
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    expect(errorsOf(result.diagnostics).map((diagnostic) => diagnostic.code)).toContain('doc.dynamic.memberMissing')
  })

  it('rejects a ref carrying both member and members as ambiguous', () => {
    const raw = legacy()
    const g0 = (raw['graphs'] as JsonObject)['g0'] as JsonObject
    const l3 = (g0['links'] as JsonObject)['l3'] as Record<string, unknown>
    l3['to'] = { node: 'n1', port: 'input.input', member: 'm1', members: ['m0'] }
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    const errors = errorsOf(result.diagnostics)
    expect(errors.some((e) => e.code === 'doc.member.ambiguous')).toBe(true)
    expect(errors.some((e) => e.message.includes('$.graphs.g0.links.l3.to'))).toBe(true)
  })

  it('rejects invalid retired scalars instead of guessing', () => {
    for (const bad of ['', 5, null, ['m0']]) {
      const raw = legacy()
      const g0 = (raw['graphs'] as JsonObject)['g0'] as JsonObject
      const net4 = (g0['nets'] as JsonObject)['net4'] as Record<string, unknown>
      net4['sinks'] = [{ node: 'n1', port: 'input.input', member: bad }]
      const result = loadDocument(raw)
      expect(result.document).toBeUndefined()
      expect(errorsOf(result.diagnostics).some((e) => e.code === 'doc.member.invalid')).toBe(true)
    }
  })

  it('shape validation rejects the retired scalar when the pipeline is bypassed', () => {
    const diags = validateDocumentShape(legacy())
    expect(diags.some((d) => d.message.includes('.member') && d.message.includes('retired'))).toBe(true)
  })

  it('shape validation rejects empty members arrays', () => {
    const raw = JSON.parse(JSON.stringify(loadDocument(legacy()).document)) as JsonObject
    const g0 = (raw['graphs'] as JsonObject)['g0'] as JsonObject
    const l3 = (g0['links'] as JsonObject)['l3'] as Record<string, unknown>
    l3['to'] = { node: 'n1', port: 'input.input', members: [] }
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    expect(errorsOf(result.diagnostics).some((e) => e.message.includes('non-empty when present'))).toBe(true)
  })

  it('canonical documents pass through without canonicalization diagnostics', () => {
    const result = loadDocument(loadFixture('subgraph'))
    expect(result.diagnostics.filter((d) => d.code.startsWith('doc.member.'))).toEqual([])
  })

  it('never touches reroute or value-source endpoints, even with stray member-like fields', () => {
    // Non-port endpoints are not PortRefs: an additive/unknown 'member' key
    // on them is foreign extension data, not retired identity to rewrite.
    const raw = legacy()
    const g0 = (raw['graphs'] as JsonObject)['g0'] as Record<string, unknown>
    g0['reroutes'] = { r0: { id: 'r0' } }
    ;(g0['links'] as Record<string, unknown>)['l4'] = {
      id: 'l4',
      from: { node: 'n0', port: 'out0' },
      to: { reroute: 'r0', member: 'not-identity', members: ['also-not'] },
    }
    ;(g0 as Record<string, unknown>)['nextOrdinal'] = 6
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([]) // no doc.member.ambiguous
    const to = result.document!.graphs['g0']!.links['l4']!.to as unknown as Record<string, unknown>
    expect(to['member']).toBe('not-identity') // preserved verbatim
    expect(to['members']).toEqual(['also-not'])
  })
})

describe('pre-release canonicalization: retired untagged boundary binds', () => {
  // Documents saved before BoundaryBinding grew the explicit `kind`
  // discriminant carry plain PortRef binds. Every pre-`kind` binding WAS a
  // concrete port binding (family forwarding did not exist), so load
  // rewrites them to `kind: 'port'` - nothing downstream accepts an
  // untagged binding.
  const legacy = () => structuredClone(loadFixture('retired-scalar-member')) as JsonObject

  it('rewrites untagged binds to kind port with a diagnostic', () => {
    const result = loadDocument(legacy())
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.binds.retired')).toBe(true)
    const g1 = result.document!.graphs['g1']!
    expect(g1.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n0', port: 'input.input', members: ['m0'] })
  })

  it('tagged binds pass through without the diagnostic', () => {
    const result = loadDocument(loadFixture('subgraph'))
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.binds.retired')).toBe(false)
  })

  it('canonical load-save-load is stable (no further rewrites)', () => {
    const saved = JSON.parse(JSON.stringify(loadDocument(legacy()).document))
    const second = loadDocument(saved)
    expect(errorsOf(second.diagnostics)).toEqual([])
    expect(second.diagnostics.some((d) => d.code === 'doc.binds.retired')).toBe(false)
    expect(JSON.parse(JSON.stringify(second.document))).toEqual(saved)
  })

  it('an explicit kind is never rewritten, even alongside a retired member', () => {
    const raw = legacy()
    const g1 = ((raw['graphs'] as JsonObject)['g1'] as JsonObject)
    const item = ((g1['boundary'] as JsonObject)['inputs'] as unknown[])[0] as Record<string, unknown>
    item['binds'] = { kind: 'port', node: 'n0', port: 'input.input', member: 'm0' }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.binds.retired')).toBe(false)
    expect(result.document!.graphs['g1']!.boundary!.inputs[0]!.binds).toEqual({
      kind: 'port',
      node: 'n0',
      port: 'input.input',
      members: ['m0'],
    })
  })

  it('shape validation rejects an untagged bind when the pipeline is bypassed', () => {
    const diags = validateDocumentShape(legacy())
    expect(diags.some((d) => d.message.includes('.binds.kind'))).toBe(true)
  })
})

describe('net view geometry canonicalization', () => {
  const netViewsDoc = (): Record<string, unknown> => {
    const raw = structuredClone(loadFixture('minimal')) as Record<string, unknown>
    const g0 = (raw['graphs'] as JsonObject)['g0'] as Record<string, unknown>
    g0['nets'] = {
      net1: {
        id: 'net1',
        name: 'shared',
        source: { node: 'n0', port: 'out0' },
        sinks: [{ node: 'n1', port: 'cond' }],
      },
    }
    return raw
  }

  it('rewrites retired absolute positions to node-relative offsets without moving the tag', () => {
    const raw = netViewsDoc()
    // Owner positions from the fixture: n0 at (80,120), n1 at (420,120).
    raw['ext'] = {
      'dinkster.netViews': [
        { graphId: 'g0', netId: 'net1', role: 'source', position: { x: 110, y: 110 } },
        { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'n1', port: 'cond' }, position: { x: 395, y: 160 } },
      ],
    }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.netViews.retired')).toBe(true)
    const views = (result.document!.ext!['dinkster.netViews'] as readonly Record<string, unknown>[])
    // node position + offset reproduces the original absolute point exactly.
    expect(views).toEqual([
      { graphId: 'g0', netId: 'net1', role: 'source', offset: { x: 30, y: -10 } },
      { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'n1', port: 'cond' }, offset: { x: -25, y: 40 } },
    ])
  })

  it('keeps absolute geometry when the owning node cannot be resolved or has no stored position', () => {
    const raw = netViewsDoc()
    const view = raw['view'] as Record<string, unknown>
    const viewGraphs = view['graphs'] as Record<string, unknown>
    const g0view = viewGraphs['g0'] as Record<string, unknown>
    const nodes = g0view['nodes'] as Record<string, unknown>
    delete nodes['n1']
    raw['ext'] = {
      'dinkster.netViews': [
        // Sink owner n1 has no stored view position: stays absolute.
        { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'n1', port: 'cond' }, position: { x: 395, y: 160 } },
        // Unknown net: source owner unresolvable, stays absolute.
        { graphId: 'g0', netId: 'ghost', role: 'source', position: { x: 1, y: 2 } },
      ],
    }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.netViews.retired')).toBe(false)
    expect(result.document!.ext!['dinkster.netViews']).toEqual([
      { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'n1', port: 'cond' }, position: { x: 395, y: 160 } },
      { graphId: 'g0', netId: 'ghost', role: 'source', position: { x: 1, y: 2 } },
    ])
  })

  it('keeps absolute geometry when the offset subtraction overflows to a non-finite value', () => {
    const raw = netViewsDoc()
    const view = raw['view'] as Record<string, unknown>
    const viewGraphs = view['graphs'] as Record<string, unknown>
    const g0view = viewGraphs['g0'] as Record<string, unknown>
    const nodes = g0view['nodes'] as Record<string, unknown>
    nodes['n1'] = { position: { x: -1.7e308, y: 120 } }
    const entry = { graphId: 'g0', netId: 'net1', role: 'sink', to: { node: 'n1', port: 'cond' }, position: { x: 1.7e308, y: 160 } }
    raw['ext'] = { 'dinkster.netViews': [entry] }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.netViews.retired')).toBe(false)
    expect(result.document!.ext!['dinkster.netViews']).toEqual([entry])
  })

  it('leaves offset entries and malformed entries untouched', () => {
    const raw = netViewsDoc()
    raw['ext'] = {
      'dinkster.netViews': [
        { graphId: 'g0', netId: 'net1', role: 'source', offset: { x: 5, y: 6 } },
        { future: true, payload: ['keep'] },
      ],
    }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(result.diagnostics.some((d) => d.code === 'doc.netViews.retired')).toBe(false)
    expect(result.document!.ext!['dinkster.netViews']).toEqual([
      { graphId: 'g0', netId: 'net1', role: 'source', offset: { x: 5, y: 6 } },
      { future: true, payload: ['keep'] },
    ])
  })

  it('a canonicalized document reloads with no further rewrites', () => {
    const raw = netViewsDoc()
    raw['ext'] = {
      'dinkster.netViews': [
        { graphId: 'g0', netId: 'net1', role: 'source', position: { x: 110, y: 110 } },
      ],
    }
    const first = loadDocument(raw)
    const saved = JSON.parse(JSON.stringify(first.document)) as Record<string, unknown>
    const second = loadDocument(saved)
    expect(errorsOf(second.diagnostics)).toEqual([])
    expect(second.diagnostics.some((d) => d.code === 'doc.netViews.retired')).toBe(false)
    expect(JSON.parse(JSON.stringify(second.document))).toEqual(saved)
  })
})
