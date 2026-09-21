import { describe, expect, it } from 'vitest'
import {
  DINKSTER_REGION_PSEUDO_NODE,
  asDinksterLink,
  decimalIntegerWire,
  isDinksterRegionEntry,
  parseDecimalIntegerWire,
  typeExprToDinksterWire,
  validateDinksterGraph,
  type DinksterGraphValidationContext,
  type DinksterGraphWire,
  type DinksterRegionWire,
} from '../src/compile/dinkster-graph.js'
import { asNodeId, asPortId } from '../src/ids.js'
import { typeExprFromDinksterWire } from '../src/schema/dinkster-wire.js'
import type { TypeExpr } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// TypeExpr encoder (inverse of typeExprFromDinksterWire)
// ---------------------------------------------------------------------------

describe('typeExprToDinksterWire', () => {
  it('round-trips every wire-expressible kind through the schema-wire decoder', () => {
    const exprs: TypeExpr[] = [
      { kind: 'concrete', name: 'core.int' },
      { kind: 'union', names: ['core.int', 'core.float'] },
      { kind: 'wildcard' },
      { kind: 'variable', templateId: 'T' },
      { kind: 'variable', templateId: 'T', allowedTypes: [{ kind: 'concrete', name: 'core.int' }] },
      { kind: 'list', element: { kind: 'concrete', name: 'core.int' } },
      { kind: 'list', element: { kind: 'list', element: { kind: 'concrete', name: 'core.string' } } },
      { kind: 'list', element: { kind: 'variable', templateId: 'T' } },
      { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } },
      { kind: 'asset', element: { kind: 'list', element: { kind: 'concrete', name: 'comfy.IMAGE' } } },
      { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } } },
      { kind: 'asset', element: { kind: 'variable', templateId: 'T' } },
    ]
    for (const expr of exprs) {
      const wire = typeExprToDinksterWire(expr)
      expect(wire, JSON.stringify(expr)).toBeDefined()
      expect(typeExprFromDinksterWire(wire)).toEqual(expr)
    }
  })

  it('emits exactly one entry in types for concrete (kind is authoritative)', () => {
    expect(typeExprToDinksterWire({ kind: 'concrete', name: 'core.int' })).toEqual({
      kind: 'concrete',
      types: ['core.int'],
    })
  })

  it('omits the types field for an unconstrained variable', () => {
    expect(typeExprToDinksterWire({ kind: 'variable', templateId: 'T' })).toEqual({
      kind: 'variable',
      templateId: 'T',
    })
  })

  it('refuses shapes the backend bans (constructor smuggling)', () => {
    // A concrete named 'list<...>' violates the one-representation invariant.
    expect(typeExprToDinksterWire({ kind: 'concrete', name: 'list<core.int>' })).toBeUndefined()
    // Union members must be atoms, never list type ids.
    expect(typeExprToDinksterWire({ kind: 'union', names: ['core.int', 'list<core.int>'] })).toBeUndefined()
    // A degenerate one-member union is not wire-expressible either.
    expect(typeExprToDinksterWire({ kind: 'union', names: ['core.int'] })).toBeUndefined()
    // Variable allowlists are atoms only.
    expect(
      typeExprToDinksterWire({
        kind: 'variable',
        templateId: 'T',
        allowedTypes: [{ kind: 'list', element: { kind: 'concrete', name: 'core.int' } }],
      }),
    ).toBeUndefined()
    // Inexpressibility bubbles out of list elements.
    expect(
      typeExprToDinksterWire({ kind: 'list', element: { kind: 'union', names: ['core.int'] } }),
    ).toBeUndefined()
    // Asset smuggling refuses identically (one representation: {kind:'asset'}).
    expect(typeExprToDinksterWire({ kind: 'concrete', name: 'asset<comfy.IMAGE>' })).toBeUndefined()
    expect(
      typeExprToDinksterWire({ kind: 'union', names: ['comfy.IMAGE', 'asset<comfy.IMAGE>'] }),
    ).toBeUndefined()
    expect(
      typeExprToDinksterWire({
        kind: 'variable',
        templateId: 'T',
        allowedTypes: [{ kind: 'asset', element: { kind: 'concrete', name: 'comfy.IMAGE' } }],
      }),
    ).toBeUndefined()
    // Inexpressibility bubbles out of asset elements too.
    expect(
      typeExprToDinksterWire({ kind: 'asset', element: { kind: 'union', names: ['core.int'] } }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Structural validator
// ---------------------------------------------------------------------------

const INT = { kind: 'concrete', types: ['core.int'] }
const BOOL = { kind: 'concrete', types: ['core.bool'] }
const LIST_INT = { kind: 'list', element: INT }
const VARIABLE: TypeExpr = { kind: 'variable', templateId: 'T' }
const LIST_VARIABLE: TypeExpr = { kind: 'list', element: VARIABLE }

/** The backend's canonical map-region example (contract message, 6822752). */
const mapRegion = (overrides?: Partial<DinksterRegionWire>): DinksterRegionWire => ({
  kind: 'map',
  ports: { item: INT, bias: INT },
  elementPorts: ['item'],
  inputs: {
    item: { $link: { node: 'src', output: 'values' } },
    bias: 10,
  },
  body: {
    nodes: {
      add: {
        nodeType: 'test.add_pair',
        inputs: {
          a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'item' } },
          b: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'bias' } },
        },
      },
    },
  },
  outputs: { results: { source: { node: 'add', output: 'out' }, mode: 'gather' } },
  ...overrides,
})

const graphWith = (region: DinksterRegionWire): DinksterGraphWire => ({
  nodes: {
    src: { nodeType: 'test.make_list', inputs: {} },
    r: { region },
  },
})

const codesOf = (g: DinksterGraphWire): string[] => validateDinksterGraph(g).map((d) => d.code)

const validationContext = (
  entries: Readonly<Record<string, {
    readonly inputs?: Readonly<Record<string, TypeExpr>>
    readonly outputs?: Readonly<Record<string, TypeExpr>>
    readonly selector?: true
  }>>,
): DinksterGraphValidationContext => new Map(Object.entries(entries).map(([path, entry]) => {
  const segments = path.split('/')
  const node = asNodeId(segments.at(-1)!)
  return [path, {
    anchor: { occurrence: { instancePath: segments.slice(0, -1).map(asNodeId), node } },
    inputTypes: entry.inputs ?? {},
    inputPorts: Object.fromEntries(Object.keys(entry.inputs ?? {}).map((id) => [id, { node, port: asPortId(id) }])),
    outputTypes: entry.outputs ?? {},
    outputPorts: Object.fromEntries(Object.keys(entry.outputs ?? {}).map((id) => [id, { node, port: asPortId(id) }])),
    ...(entry.selector === true ? { selector: true as const } : {}),
  }]
}))

describe('validateDinksterGraph', () => {
  it('accepts a plain node graph', () => {
    expect(
      validateDinksterGraph({
        nodes: {
          a: { nodeType: 'test.const', inputs: { v: 1 } },
          b: { nodeType: 'test.sink', inputs: { x: { $link: { node: 'a', output: 'out' } } } },
        },
      }),
    ).toEqual([])
  })

  it('accepts the canonical map region', () => {
    expect(validateDinksterGraph(graphWith(mapRegion()))).toEqual([])
  })

  it('accepts and preserves broadcast binding while zip remains omitted', () => {
    const broadcast = graphWith(mapRegion({ binding: 'broadcast' }))
    expect(validateDinksterGraph(broadcast)).toEqual([])
    expect(JSON.parse(JSON.stringify(broadcast)).nodes.r.region.binding).toBe('broadcast')

    const zip = graphWith(mapRegion())
    expect(JSON.parse(JSON.stringify(zip)).nodes.r.region).not.toHaveProperty('binding')
  })

  it('accepts and preserves a flatten-mode output without joining the state chain', () => {
    const flatten = graphWith(mapRegion({
      ports: { items: LIST_INT },
      elementPorts: ['items'],
      inputs: { items: [] },
      body: { nodes: {} },
      outputs: { items: { source: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'items' }, mode: 'flatten' } },
    }))
    expect(validateDinksterGraph(flatten)).toEqual([])
    expect(JSON.parse(JSON.stringify(flatten)).nodes.r.region.outputs.items.mode).toBe('flatten')
    expect(codesOf(flatten)).not.toContain('dinksterGraph.stateChain')
  })

  it('rejects an unknown output mode with the complete expected set', () => {
    const region = mapRegion() as unknown as { outputs: Record<string, { source: { node: string; output: string }; mode: string }> }
    region.outputs.results!.mode = 'scatter'
    expect(validateDinksterGraph(graphWith(region as unknown as DinksterRegionWire))).toContainEqual(
      expect.objectContaining({
        code: 'dinksterGraph.regionShape',
        message: "region 'r': output 'results' has unknown mode 'scatter'; expected gather, compact, state, or flatten",
        data: { nodeId: 'r', inputId: 'results' },
      }),
    )
  })

  it('mirrors flatten list-cardinality and runtime-type validation when the source type is structural', () => {
    const directPortSource = (sourceType: DinksterRegionWire['ports'][string]) => mapRegion({
      ports: { source: sourceType },
      elementPorts: ['source'],
      inputs: { source: [] },
      body: { nodes: {} },
      outputs: { flattened: { source: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'source' }, mode: 'flatten' } },
    })

    expect(validateDinksterGraph(graphWith(directPortSource(INT)))).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.flattenNonList',
      message: "region 'r': output 'flattened' flattens a scalar body output; flatten requires a list-typed body output",
      data: { nodeId: 'r', inputId: 'flattened' },
    }))
    expect(validateDinksterGraph(graphWith(directPortSource({ kind: 'list', element: { kind: 'variable', templateId: 'T' } })))).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.flattenNonConcrete',
      message: "region 'r': output 'flattened' flattens a non-runtime-resolvable list type",
      data: { nodeId: 'r', inputId: 'flattened' },
    }))
    expect(validateDinksterGraph(graphWith(directPortSource(LIST_INT)))).toEqual([])
  })

  it('uses schema-owned body output types for gather, compact, and flatten admission', () => {
    const regionWithOutput = (mode?: 'gather' | 'compact' | 'flatten') => graphWith(mapRegion({
      outputs: { results: { source: { node: 'add', output: 'out' }, ...(mode !== undefined ? { mode } : {}) } },
    }))
    const contextFor = (type: TypeExpr) => validationContext({
      r: { outputs: { results: type } },
      'r/add': { outputs: { out: type } },
    })

    expect(validateDinksterGraph(regionWithOutput(), contextFor(VARIABLE))).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.gatherNonConcrete',
      data: { nodeId: 'r', inputId: 'results' },
      anchor: { occurrence: { instancePath: [], node: 'r' }, port: { node: 'r', port: 'results' } },
    }))
    expect(validateDinksterGraph(regionWithOutput(), contextFor({ kind: 'concrete', name: 'core.int' }))).toEqual([])
    expect(validateDinksterGraph(regionWithOutput('compact'), contextFor(VARIABLE))).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.gatherNonConcrete',
      data: { nodeId: 'r', inputId: 'results' },
    }))
    expect(validateDinksterGraph(regionWithOutput('compact'), contextFor({ kind: 'concrete', name: 'core.int' }))).toEqual([])

    expect(validateDinksterGraph(regionWithOutput('flatten'), contextFor({ kind: 'concrete', name: 'core.int' })))
      .toContainEqual(expect.objectContaining({ code: 'dinksterGraph.flattenNonList' }))
    expect(validateDinksterGraph(regionWithOutput('flatten'), contextFor(LIST_VARIABLE)))
      .toContainEqual(expect.objectContaining({ code: 'dinksterGraph.flattenNonConcrete' }))
    expect(validateDinksterGraph(regionWithOutput('flatten'), contextFor({ kind: 'list', element: { kind: 'concrete', name: 'core.int' } })))
      .toEqual([])
  })

  it('refuses plain literals on non-concrete authored inputs without trusting the value shape', () => {
    const region = graphWith(mapRegion({
      body: { nodes: { add: { nodeType: 'test.match', inputs: { value: 7 } } } },
      outputs: { results: { source: { node: 'add', output: 'out' } } },
    }))
    const context = validationContext({
      r: { outputs: { results: { kind: 'concrete', name: 'core.int' } } },
      'r/add': { inputs: { value: VARIABLE }, outputs: { out: { kind: 'concrete', name: 'core.int' } } },
    })
    expect(validateDinksterGraph(region, context)).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.literalOnNonConcrete',
      data: { nodeId: 'r/add', inputId: 'value' },
      anchor: {
        occurrence: { instancePath: ['r'], node: 'add' },
        port: { node: 'add', port: 'value' },
      },
    }))

    const typed = structuredClone(region) as DinksterGraphWire
    const body = (typed.nodes.r as { region: DinksterRegionWire }).region.body
    ;(body.nodes.add as { inputs: Record<string, unknown> }).inputs.value = { $typed: { type: 'core.int', value: 7 } }
    expect(validateDinksterGraph(typed, context)).toEqual([])
  })

  it('refuses schema selectors in nested region bodies but does not treat lazy inputs as selectors', () => {
    const graph = graphWith(mapRegion())
    const ordinary = validationContext({
      r: { outputs: { results: { kind: 'concrete', name: 'core.int' } } },
      'r/add': { outputs: { out: { kind: 'concrete', name: 'core.int' } } },
    })
    expect(validateDinksterGraph(graph, ordinary)).toEqual([])

    const selector = validationContext({
      r: { outputs: { results: { kind: 'concrete', name: 'core.int' } } },
      'r/add': { outputs: { out: { kind: 'concrete', name: 'core.int' } }, selector: true },
    })
    expect(validateDinksterGraph(graph, selector)).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.selectorInRegion',
      data: { nodeId: 'r/add' },
      anchor: { occurrence: { instancePath: ['r'], node: 'add' } },
    }))
  })

  it("rejects an unknown binding with the complete expected set", () => {
    const region = mapRegion() as unknown as { binding: string }
    region.binding = 'diagonal'
    expect(validateDinksterGraph(graphWith(region as unknown as DinksterRegionWire))).toContainEqual(
      expect.objectContaining({
        code: 'dinksterGraph.regionShape',
        message: "region 'r': unknown binding 'diagonal'; expected zip, cross, or broadcast",
      }),
    )
  })

  it('accepts a well-formed fold with state chaining', () => {
    const fold = mapRegion({
      kind: 'fold',
      ports: { item: INT, acc: INT },
      elementPorts: ['item'],
      statePorts: ['acc'],
      inputs: {
        item: { $link: { node: 'src', output: 'values' } },
        acc: 0,
      },
      body: {
        nodes: {
          add: {
            nodeType: 'test.add_pair',
            inputs: {
              a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'item' } },
              b: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'acc' } },
            },
          },
        },
      },
      outputs: { acc: { source: { node: 'add', output: 'out' }, mode: 'state' } },
    })
    expect(validateDinksterGraph(graphWith(fold))).toEqual([])
  })

  it('accepts a well-formed while', () => {
    const whileRegion = mapRegion({
      kind: 'while',
      ports: { acc: INT, keepGoing: BOOL },
      elementPorts: [],
      statePorts: ['acc', 'keepGoing'],
      inputs: { acc: 0, keepGoing: true },
      body: {
        nodes: {
          step: {
            nodeType: 'test.step',
            inputs: {
              a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'acc' } },
              k: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'keepGoing' } },
            },
          },
        },
      },
      outputs: {
        acc: { source: { node: 'step', output: 'out' }, mode: 'state' },
        keepGoing: { source: { node: 'step', output: 'more' }, mode: 'state' },
      },
      maxIterations: 8,
      continueSource: { node: 'step', output: 'more' },
    })
    expect(validateDinksterGraph(graphWith(whileRegion))).toEqual([])
  })

  it('flags banned characters and empty node ids at every nesting level', () => {
    const region = mapRegion({
      body: {
        nodes: {
          'bad/name': { nodeType: 't', inputs: {} },
          add: {
            nodeType: 'test.add_pair',
            inputs: { a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'item' } } },
          },
        },
      },
    })
    const diags = validateDinksterGraph({
      nodes: { ...graphWith(region).nodes, 'top[0]': { nodeType: 't', inputs: {} } },
    })
    const invalid = diags.filter((d) => d.code === 'dinksterGraph.invalidNodeId')
    expect(invalid.map((d) => d.data?.['nodeId']).sort()).toEqual(['r/bad/name', 'top[0]'])
  })

  it("flags '$region' used as a real node id, top level and in bodies", () => {
    const region = mapRegion({
      body: {
        nodes: {
          [DINKSTER_REGION_PSEUDO_NODE]: { nodeType: 't', inputs: {} },
          add: {
            nodeType: 'test.add_pair',
            inputs: { a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'item' } } },
          },
        },
      },
    })
    const diags = validateDinksterGraph(graphWith(region))
    const reserved = diags.filter((d) => d.code === 'dinksterGraph.reservedNodeId')
    expect(reserved).toHaveLength(1)
    expect(reserved[0]!.data?.['nodeId']).toBe('r/$region')
  })

  it('enforces the map profile: element ports required, no state, no continue', () => {
    expect(codesOf(graphWith(mapRegion({ elementPorts: [] })))).toContain('dinksterGraph.regionShape')
    expect(
      codesOf(graphWith(mapRegion({ statePorts: ['item'] }))),
    ).toContain('dinksterGraph.regionShape')
    expect(
      codesOf(graphWith(mapRegion({ continueSource: { node: 'add', output: 'out' } }))),
    ).toContain('dinksterGraph.regionShape')
  })

  it('enforces the while profile: continueSource and maxIterations mandatory, cross and broadcast rejected', () => {
    const base = {
      kind: 'while' as const,
      ports: { acc: INT },
      elementPorts: [],
      statePorts: ['acc'],
      inputs: { acc: 0 },
      body: {
        nodes: {
          step: {
            nodeType: 'test.step',
            inputs: { a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'acc' } } },
          },
        },
      },
      outputs: { acc: { source: { node: 'step', output: 'out' }, mode: 'state' as const } },
    }
    // Missing both continueSource and maxIterations: two shape errors.
    expect(
      codesOf(graphWith(mapRegion(base))).filter((c) => c === 'dinksterGraph.regionShape'),
    ).toHaveLength(2)
    for (const binding of ['cross', 'broadcast'] as const) {
      expect(
        validateDinksterGraph(
          graphWith(
            mapRegion({
              ...base,
              binding,
              maxIterations: 4,
              continueSource: { node: 'step', output: 'more' },
            }),
          ),
        ),
      ).toContainEqual(expect.objectContaining({
        code: 'dinksterGraph.regionShape',
        message: `region 'r': while rejects binding '${binding}'`,
      }))
    }
  })

  it('rejects non-positive and non-integer maxIterations', () => {
    expect(codesOf(graphWith(mapRegion({ maxIterations: 0 })))).toContain('dinksterGraph.regionShape')
    expect(codesOf(graphWith(mapRegion({ maxIterations: 2.5 })))).toContain('dinksterGraph.regionShape')
    expect(validateDinksterGraph(graphWith(mapRegion({ maxIterations: 4 })))).toEqual([])
  })

  it('flags undeclared ports referenced by elementPorts, inputs, and body $region reads', () => {
    expect(codesOf(graphWith(mapRegion({ elementPorts: ['item', 'ghost'] })))).toContain(
      'dinksterGraph.undeclaredPort',
    )
    expect(
      codesOf(graphWith(mapRegion({ inputs: { ...mapRegion().inputs, extra: 1 } }))),
    ).toContain('dinksterGraph.undeclaredPort')
    const badRead = mapRegion({
      body: {
        nodes: {
          add: {
            nodeType: 'test.add_pair',
            inputs: { a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'missing' } } },
          },
        },
      },
    })
    const diags = validateDinksterGraph(graphWith(badRead))
    const undeclared = diags.filter((d) => d.code === 'dinksterGraph.undeclaredPort')
    expect(undeclared).toHaveLength(1)
    expect(undeclared[0]!.data).toEqual({ nodeId: 'r/add', inputId: 'a' })

    const indexRead = mapRegion({
      body: {
        nodes: {
          add: {
            nodeType: 'test.add_pair',
            inputs: { a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'index' } } },
          },
        },
      },
    })
    expect(validateDinksterGraph(graphWith(indexRead)).filter((diagnostic) => diagnostic.code === 'dinksterGraph.undeclaredPort')).toEqual([])
  })

  it('flags declared ports with no outer input', () => {
    const diags = validateDinksterGraph(graphWith(mapRegion({ inputs: { item: { $link: { node: 'src', output: 'values' } } } })))
    const missing = diags.filter((d) => d.code === 'dinksterGraph.missingInput')
    expect(missing).toHaveLength(1)
    expect(missing[0]!.data).toEqual({ nodeId: 'r', inputId: 'bias' })
  })

  it('flags broken state chains in both directions', () => {
    // State port without a same-id state-mode output.
    const noOutput = mapRegion({
      kind: 'fold',
      ports: { item: INT, acc: INT },
      statePorts: ['acc'],
      inputs: { ...mapRegion().inputs, acc: 0 },
    })
    const context = validationContext({
      r: { inputs: { acc: { kind: 'concrete', name: 'core.int' } }, outputs: { results: { kind: 'concrete', name: 'core.int' } } },
      'r/add': { outputs: { out: { kind: 'concrete', name: 'core.int' } } },
    })
    expect(validateDinksterGraph(graphWith(noOutput), context)).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.stateChain',
      data: { nodeId: 'r', inputId: 'acc' },
      anchor: {
        occurrence: { instancePath: [], node: 'r' },
        port: { node: 'r', port: 'acc' },
      },
    }))
    // State-mode output without a same-id state port.
    const noPort = mapRegion({
      outputs: { results: { source: { node: 'add', output: 'out' }, mode: 'state' } },
    })
    expect(validateDinksterGraph(graphWith(noPort), context)).toContainEqual(expect.objectContaining({
      code: 'dinksterGraph.stateChain',
      data: { nodeId: 'r', inputId: 'results' },
      anchor: {
        occurrence: { instancePath: [], node: 'r' },
        port: { node: 'r', port: 'results' },
      },
    }))
  })

  it('flags region outputs and continueSource referencing missing body nodes', () => {
    const badOutput = mapRegion({
      outputs: { results: { source: { node: 'ghost', output: 'out' } } },
    })
    expect(codesOf(graphWith(badOutput))).toContain('dinksterGraph.danglingOutput')
    const badContinue = mapRegion({
      kind: 'while',
      ports: { acc: INT },
      elementPorts: [],
      statePorts: ['acc'],
      inputs: { acc: 0 },
      body: {
        nodes: {
          step: {
            nodeType: 'test.step',
            inputs: { a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'acc' } } },
          },
        },
      },
      outputs: { acc: { source: { node: 'step', output: 'out' }, mode: 'state' } },
      maxIterations: 4,
      continueSource: { node: 'ghost', output: 'more' },
    })
    expect(codesOf(graphWith(badContinue))).toContain('dinksterGraph.danglingOutput')
  })

  it('checks declared outputs of a nested-region producer, but not schema-owned node outputs', () => {
    const inner = mapRegion()
    const outer = mapRegion({
      body: {
        nodes: {
          src: { nodeType: 'test.make_list', inputs: {} },
          inner: { region: inner },
        },
      },
      // 'results' IS declared by the inner region; 'ghost' is not.
      outputs: {
        results: { source: { node: 'inner', output: 'results' } },
        bad: { source: { node: 'inner', output: 'ghost' } },
      },
    })
    const diags = validateDinksterGraph(graphWith(outer))
    const dangling = diags.filter((d) => d.code === 'dinksterGraph.danglingOutput')
    expect(dangling).toHaveLength(1)
    expect(dangling[0]!.data).toEqual({ nodeId: 'r', inputId: 'bad' })
  })

  it('flags malformed port type expressions as region-shape', () => {
    const region = mapRegion({ ports: { item: { kind: 'mystery' }, bias: INT } })
    const diags = validateDinksterGraph(graphWith(region))
    expect(diags.map((d) => d.code)).toContain('dinksterGraph.regionShape')
  })

  it('detects cycles at top level and inside bodies with prefixed anchors', () => {
    const top = validateDinksterGraph({
      nodes: {
        a: { nodeType: 't', inputs: { x: { $link: { node: 'b', output: 'out' } } } },
        b: { nodeType: 't', inputs: { x: { $link: { node: 'a', output: 'out' } } } },
      },
    })
    expect(top.filter((d) => d.code === 'dinksterGraph.cycle')).toHaveLength(1)

    const region = mapRegion({
      body: {
        nodes: {
          add: {
            nodeType: 't',
            inputs: {
              a: { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'item' } },
              b: { $link: { node: 'echo', output: 'out' } },
            },
          },
          echo: { nodeType: 't', inputs: { x: { $link: { node: 'add', output: 'out' } } } },
        },
      },
    })
    const body = validateDinksterGraph(graphWith(region))
    const cycles = body.filter((d) => d.code === 'dinksterGraph.cycle')
    expect(cycles).toHaveLength(1)
    expect(String(cycles[0]!.data?.['nodeId'])).toMatch(/^r\//)
  })

  it('does not treat $region reads or links to missing nodes as cycle edges', () => {
    expect(validateDinksterGraph(graphWith(mapRegion()))).toEqual([])
    expect(
      validateDinksterGraph({
        nodes: { a: { nodeType: 't', inputs: { x: { $link: { node: 'ghost', output: 'out' } } } } },
      }),
    ).toEqual([])
  })

  it('validates nested regions recursively with full paths', () => {
    const inner = mapRegion({ elementPorts: [] }) // shape error, nested two deep
    const outer = mapRegion({
      body: {
        nodes: {
          src: { nodeType: 'test.make_list', inputs: {} },
          inner: { region: inner },
        },
      },
      outputs: { results: { source: { node: 'inner', output: 'results' } } },
    })
    const diags = validateDinksterGraph(graphWith(outer))
    const shape = diags.filter((d) => d.code === 'dinksterGraph.regionShape')
    expect(shape).toHaveLength(1)
    expect(shape[0]!.data?.['nodeId']).toBe('r/inner')
  })
})

describe('wire helpers', () => {
  it('round-trips canonical unsafe decimal integers', () => {
    expect(decimalIntegerWire('18446744073709551615')).toEqual({ $int: '18446744073709551615' })
    expect(parseDecimalIntegerWire({ $int: '18446744073709551615' })).toBe('18446744073709551615')
    expect(parseDecimalIntegerWire({ $int: '-9223372036854775808' })).toBe('-9223372036854775808')
  })

  it.each([
    [{ $int: '42' }],
    [{ $int: '018446744073709551615' }],
    [{ $int: '18446744073709551616' }],
    [{ $int: '18446744073709551615', extra: true }],
    [{ $int: 18446744073709551615 }],
  ])('rejects a malformed or unnecessary decimal-integer marker', (value) => {
    expect(parseDecimalIntegerWire(value as never)).toBeUndefined()
  })

  it('asDinksterLink narrows links and rejects lookalikes', () => {
    expect(asDinksterLink({ $link: { node: 'a', output: 'out' } })).toEqual({ node: 'a', output: 'out' })
    expect(asDinksterLink({ $link: { node: 'a' } } as never)).toBeUndefined()
    expect(asDinksterLink([1, 2])).toBeUndefined()
    expect(asDinksterLink(42)).toBeUndefined()
    expect(asDinksterLink(null)).toBeUndefined()
  })

  it('isDinksterRegionEntry discriminates entries', () => {
    expect(isDinksterRegionEntry({ nodeType: 't', inputs: {} })).toBe(false)
    expect(isDinksterRegionEntry({ region: mapRegion() })).toBe(true)
  })
})
