/**
 * Performance budgets for the framework-free hot path (architecture section:
 * "benchmark workflows (1k+ nodes, heavy noodles) ... starting at initial implementation").
 *
 * Budgets are deliberately generous - they exist to catch accidental
 * quadratic blowups in CI, not to microbenchmark. Real frame-time budgets
 * live in the Playwright perf spec, which runs a real renderer.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile, documentResolver } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { syntheticWorkflow } from '../src/format/synthetic.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import { elaborateInterface } from '../src/schema/elaborate.js'
import type { InputSpec, NodeSchema } from '../src/schema/model.js'
import { parseObjectInfo, type ObjectInfoEntry } from '../src/schema/object-info.js'
import { solveGraphTypes } from '../src/schema/solve.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const objectInfo = JSON.parse(
  readFileSync(join(root, 'fixtures/object_info.json'), 'utf8'),
) as Record<string, ObjectInfoEntry>
const { schemas } = parseObjectInfo(objectInfo)

// 60 chains x 20 nodes = 1200 nodes, 1140 links.
const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH

describe(`synthetic workload (${NODES} nodes)`, () => {
  const json = syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH })

  it('is a valid document (validators run on load)', () => {
    const loaded = loadDocument(json)
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const doc = loaded.document!
    expect(Object.keys(doc.graphs['g0']!.nodes)).toHaveLength(NODES)
  })

  it(`loads within budget (2s for ${NODES} nodes)`, () => {
    const t0 = performance.now()
    const loaded = loadDocument(json)
    const ms = performance.now() - t0
    expect(loaded.document).toBeDefined()
    expect(ms, `loadDocument took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })

  it(`compiles within budget (2s for ${NODES} nodes)`, () => {
    const doc = loadDocument(json).document!
    const t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(NODES)
    expect(ms, `compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })

  it('partial-scope closure stays fast on deep chains', () => {
    const doc = loadDocument(json).document!
    // Target the last node of the last chain: closure = one full chain.
    // Ordinals interleave nodes and links (node allocated before its incoming
    // link): each chain uses 2*CHAIN_LENGTH-1 ordinals, last node is total-2.
    const lastNodeOrdinal = CHAINS * (2 * CHAIN_LENGTH - 1) - 2
    const t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: {
        kind: 'partial',
        targets: [{ instancePath: [], node: asNodeId(`n${lastNodeOrdinal}`) }],
      },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const ms = performance.now() - t0
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(CHAIN_LENGTH)
    expect(ms, `partial compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })

  it('documentResolver resolves every node type', () => {
    const doc = loadDocument(json).document!
    const resolve = documentResolver(doc, (t) => schemas.get(t))
    for (const node of Object.values(doc.graphs['g0']!.nodes)) {
      expect(resolve(node.type), node.type).toBeDefined()
    }
  })
})

describe('reroute-dense load (O(R x L) regression guard)', () => {
  // 4800 nodes, 4560 reroutes, 9120 links. The budget permits the one-pass
  // driver index but not per-reroute link scans (see RerouteIndex).
  it('loads within 1s at 4x reroute density', () => {
    const json = syntheticWorkflow({ chains: CHAINS * 4, chainLength: CHAIN_LENGTH, reroutes: true })
    const t0 = performance.now()
    const loaded = loadDocument(json)
    const ms = performance.now() - t0
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(ms, `loadDocument took ${ms.toFixed(1)}ms`).toBeLessThan(1000)
  })
})

describe(`feature-heavy synthetic workload (${NODES} nodes + reroutes/valueSources/nets/groups/selectors)`, () => {
  const json = syntheticWorkflow({
    chains: CHAINS,
    chainLength: CHAIN_LENGTH,
    reroutes: true,
    valueSources: true,
    nets: true,
    groups: true,
    selectors: true,
  })

  it('is a valid document', () => {
    const loaded = loadDocument(json)
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const g = loaded.document!.graphs['g0']!
    expect(Object.keys(g.nodes)).toHaveLength(NODES)
    expect(Object.keys(g.valueSources ?? {})).toHaveLength(CHAINS)
    expect(Object.keys(g.nets)).toHaveLength(CHAINS)
    expect(Object.keys(g.selectors ?? {})).toHaveLength(CHAINS)
  })

  it(`loads + compiles within budget (2s each); sources bake, nets link`, () => {
    let t0 = performance.now()
    const doc = loadDocument(json).document!
    const loadMs = performance.now() - t0
    expect(loadMs, `loadDocument took ${loadMs.toFixed(1)}ms`).toBeLessThan(2000)

    t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const compileMs = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    expect(compileMs, `compile took ${compileMs.toFixed(1)}ms`).toBeLessThan(2000)
    if (result.ok) {
      // Value sources compile away: the first chain's EmptyImage carries the
      // baked literal (chain 0 source value is 64), not a link.
      expect(Object.keys(result.artifact.prompt)).toHaveLength(NODES)
      const first = result.artifact.prompt['n0'] as { inputs: Record<string, unknown> }
      expect(first.inputs['width']).toBe(64)
      expect(first.inputs['height']).toBe(64)
    }
  })
})

describe(`type solver on the feature-heavy workload (${NODES} nodes)`, () => {
  // Constraint generation must stay near-linear over nodes + elaborated
  // ports + edges: one elaboration per node, one union-find over edges.
  // Measured ~8ms at introduction; the 100ms budget is a deliberate
  // early-warning line (not CI slack like the 2s budgets above) - if it
  // trips, profile first and only bump the budget once the growth is
  // understood and intentional, never to silence it.
  it('solves within budget (100ms); every link gets a verdict', () => {
    const json = syntheticWorkflow({
      chains: CHAINS,
      chainLength: CHAIN_LENGTH,
      reroutes: true,
      valueSources: true,
      nets: true,
      groups: true,
      selectors: true,
    })
    const doc = loadDocument(json).document!
    const def = doc.graphs['g0']!
    const t0 = performance.now()
    const result = solveGraphTypes(def, (t) => schemas.get(t))
    const ms = performance.now() - t0
    expect(ms, `solveGraphTypes took ${ms.toFixed(1)}ms`).toBeLessThan(100)
    // Sanity: the solver actually visited the topology (structural feeds
    // into reroutes/selector candidates are the only links without verdicts).
    expect(result.linkVerdicts.size).toBeGreaterThan(0)
    for (const verdict of result.linkVerdicts.values()) expect(verdict).toBe('ok')
  })
})

describe('selector-dense load + compile (regression guard)', () => {
  // 4x chain density with a 2-candidate selector on every chain: exercises
  // the I11 all-candidate acyclicity walk at load and eager selector
  // resolution + closure pruning at compile. Budgets sit at the same
  // early-warning line as the reroute-dense guard: linear behavior clears
  // them by an order of magnitude, quadratic candidate/link rescans do not.
  const DENSE_CHAINS = CHAINS * 4
  const json = syntheticWorkflow({ chains: DENSE_CHAINS, chainLength: CHAIN_LENGTH, selectors: true })

  it('loads within 1s at 4x selector density', () => {
    const t0 = performance.now()
    const loaded = loadDocument(json)
    const ms = performance.now() - t0
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(Object.keys(loaded.document!.graphs['g0']!.selectors ?? {})).toHaveLength(DENSE_CHAINS)
    expect(ms, `loadDocument took ${ms.toFixed(1)}ms`).toBeLessThan(1000)
  })

  it('compiles within 1s; unselected decoy branches leave the prompt intact', () => {
    const doc = loadDocument(json).document!
    const t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    // Every chain node stays reachable through its fixed 'ca' branch; the
    // decoy 'cb' feed is pruned as a LINK but its producer (the chain source)
    // is still in closure via the chain itself.
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(DENSE_CHAINS * CHAIN_LENGTH)
    expect(ms, `compile took ${ms.toFixed(1)}ms`).toBeLessThan(1000)
  })
})

describe(`subgraph synthetic workload (${CHAINS} instances, ${NODES} expanded nodes)`, () => {
  const compileFull = (doc: WorkflowDocument) =>
    compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })

  it('is a valid document: shared definition, 2 * chains root nodes', () => {
    const loaded = loadDocument(syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH, subgraphs: true }))
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const doc = loaded.document!
    expect(Object.keys(doc.graphs)).toHaveLength(2)
    expect(Object.keys(doc.graphs['g0']!.nodes)).toHaveLength(CHAINS * 2)
    expect(Object.keys(doc.graphs['g1']!.nodes)).toHaveLength(CHAIN_LENGTH - 1)
  })

  it(`flattens to ${NODES} prompt entries within budget (2s); promoted values apply per instance`, () => {
    const doc = loadDocument(
      syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH, subgraphs: true }),
    ).document!
    const t0 = performance.now()
    const result = compileFull(doc)
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    expect(ms, `compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
    if (result.ok) {
      const prompt = result.artifact.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>
      expect(Object.keys(prompt)).toHaveLength(NODES)
      // Each instance's promoted color overrides the definition's stored 0.
      const colors = Object.values(prompt)
        .filter((n) => n.class_type === 'EmptyImage')
        .map((n) => n.inputs['color'] as number)
        .sort((a, b) => a - b)
      const expected = Array.from({ length: CHAINS }, (_, c) => (c * 7919) % 0xffffff).sort((a, b) => a - b)
      expect(colors).toEqual(expected)
    }
  })

  it('nested pass-through wrappers (depth 8) do not blow up flattening', () => {
    const depth = 8
    const loaded = loadDocument(
      syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH, subgraphs: true, subgraphDepth: depth }),
    )
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const doc = loaded.document!
    expect(Object.keys(doc.graphs)).toHaveLength(depth + 1)
    const t0 = performance.now()
    const result = compileFull(doc)
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    // Wrappers add no executable nodes: same expanded prompt, similar cost.
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(NODES)
    expect(ms, `depth-${depth} compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })
})

describe('recursive dynamic elaboration (Autogrow-in-Autogrow)', () => {
  // A node with an outer autogrow whose template contains an inner autogrow:
  // 10 outer members x 10 inner members + per-member static slot + ghosts
  // ~= 120+ elaborated rows per node. Elaborating 200 such nodes stands in
  // for a worst-case interface-recompute wave (e.g. a bulk paste). The
  // budget is deliberately tight relative to the other suites: elaboration
  // runs per keystroke-adjacent edits, so we want to notice long before the
  // 100ms interactivity line.
  const nestedSchema = (): NodeSchema => {
    const inner: InputSpec = {
      kind: 'input',
      id: 'sub',
      type: { kind: 'wildcard' },
      optional: true,
      dynamic: {
        kind: 'autogrow',
        template: [
          { kind: 'input', id: 'item', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
        ],
        naming: { kind: 'prefix', prefix: 'g', min: 0, max: 32 },
      },
    }
    const outer: InputSpec = {
      kind: 'input',
      id: 'items',
      type: { kind: 'wildcard' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [
          { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
          inner,
        ],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 32 },
      },
    }
    return {
      type: 'PerfNested',
      displayName: 'PerfNested',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [outer],
    }
  }

  const nestedNode = (outer: number, inner: number) => {
    const members = Array.from({ length: outer }, (_, i) => `m${i}`)
    const memberState: Record<string, Record<string, unknown>> = {}
    for (const m of members) {
      memberState[m] = {
        'items.sub': { members: Array.from({ length: inner }, (_, i) => `m${i}`) },
      }
    }
    return { values: {}, dynamic: { items: { members, memberState } } } as Parameters<
      typeof elaborateInterface
    >[1]
  }

  const measure = (schema: NodeSchema, node: ReturnType<typeof nestedNode>, iterations: number): number => {
    const t0 = performance.now()
    for (let i = 0; i < iterations; i++) elaborateInterface(schema, node)
    return performance.now() - t0
  }

  it('keeps normalized elaboration cost stable as nested interfaces grow', () => {
    const schema = nestedSchema()
    const small = nestedNode(5, 5)
    const large = nestedNode(10, 10)
    const smallResult = elaborateInterface(schema, small)
    const largeResult = elaborateInterface(schema, large)
    expect(smallResult.diagnostics).toEqual([])
    expect(largeResult.diagnostics).toEqual([])
    expect(largeResult.items.length).toBeGreaterThan(100)

    const largeIterations = 200
    const targetItems = largeResult.items.length * largeIterations
    const smallIterations = Math.ceil(targetItems / smallResult.items.length)
    const ratios: number[] = []
    for (let run = 0; run < 7; run++) {
      const smallFirst = run % 2 === 0
      const firstMs = measure(schema, smallFirst ? small : large, smallFirst ? smallIterations : largeIterations)
      const secondMs = measure(schema, smallFirst ? large : small, smallFirst ? largeIterations : smallIterations)
      const smallMs = smallFirst ? firstMs : secondMs
      const largeMs = smallFirst ? secondMs : firstMs
      const smallCost = smallMs / (smallIterations * smallResult.items.length)
      const largeCost = largeMs / (largeIterations * largeResult.items.length)
      ratios.push(largeCost / smallCost)
    }
    ratios.sort((a, b) => a - b)
    const ratio = ratios[Math.floor(ratios.length / 2)]!
    // eslint-disable-next-line no-console
    console.log(`[perf] nested elaboration normalized cost ratio: ${ratio.toFixed(2)}x`)
    // Linear work is 1.0x after normalizing by output rows. The 1.25x
    // boundary admits allocator variance while rejecting superlinear growth.
    expect(ratio, `large nested interface cost ${ratio.toFixed(2)}x per row`).toBeLessThan(1.25)
  })
})
