/**
 * Cross-check: the published JSON Schema (schema.ts) and the hand-written
 * runtime validator (validate.ts) must agree. Runs both over the golden
 * fixtures and a set of corrupted variants; any drift between the two fails
 * here.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import Ajv2020Import from 'ajv/dist/2020.js'
import { WORKFLOW_SCHEMA } from '../src/format/schema.js'
import { validateDocumentShape } from '../src/format/validate.js'

// CJS/ESM interop: vitest may surface the class under .default.
const Ajv2020 = ((Ajv2020Import as unknown as { default?: unknown }).default ??
  Ajv2020Import) as typeof Ajv2020Import

const ajv = new Ajv2020({ allErrors: true, strictTypes: false })
const validateWithSchema = ajv.compile(WORKFLOW_SCHEMA as unknown as Record<string, unknown>)

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'))

/** Both validators must return the same verdict. */
function agree(json: unknown): { schemaValid: boolean; validatorValid: boolean } {
  const schemaValid = validateWithSchema(json) === true
  const validatorValid = validateDocumentShape(json).every((d) => d.severity !== 'error')
  return { schemaValid, validatorValid }
}

describe('JSON Schema <-> runtime validator agreement', () => {
  it.each(['slot', 'dynamicCombo'])('accepts input-only %s boundaries and rejects incompatible decorations', (kind) => {
    const fixture = loadFixture('subgraph') as { graphs: Record<string, { boundary?: { inputs: unknown[]; outputs: unknown[] } }> }
    const boundary = Object.values(fixture.graphs).find((graph) => graph.boundary)!.boundary!
    const item = { id: 'full', binds: { kind, node: 'n0', port: 'mode' } }
    boundary.inputs = [item]
    boundary.outputs = []
    expect(agree(fixture)).toEqual({ schemaValid: true, validatorValid: true })
    for (const decorated of [{ ...item, promoted: true }, { ...item, alsoBinds: [item.binds] }, { ...item, binds: { ...item.binds, slots: ['child'] } }]) {
      boundary.inputs = [decorated]
      expect(agree(fixture)).toEqual({ schemaValid: false, validatorValid: false })
    }
    boundary.inputs = []
    boundary.outputs = [item]
    expect(agree(fixture)).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('accepts both golden fixtures', () => {
    for (const name of ['minimal', 'subgraph']) {
      const verdict = agree(loadFixture(name))
      expect(verdict, name).toEqual({ schemaValid: true, validatorValid: true })
    }
  })

  it('agrees on occurrence topology endpoint, route, suppression, and cursor shapes', () => {
    const base = () => {
      const d = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
      d['occurrenceTopologies'] = {
        n1: {
          owner: { instancePath: [], node: 'n1' },
          bodyGraph: 'g1',
          links: {
            l0: {
              id: 'l0',
              from: { kind: 'body', endpoint: { node: 'n0', port: 'out0' } },
              to: {
                kind: 'boundary',
                occurrence: { instancePath: [], node: 'n1' },
                address: { port: 'latent' },
                route: [{
                  graph: 'g1',
                  boundaryId: 'latent',
                  binding: { kind: 'port', node: 'n0', port: 'latent_image' },
                }],
              },
            },
          },
          suppressedDeliveries: [
            { kind: 'link', linkId: 'l3' },
            { kind: 'netSink', netId: 'net4', to: { node: 'n2', port: 'input.input', members: ['m0'] } },
            {
              kind: 'projectedLeg',
              delivery: { kind: 'link', graph: 'g0', linkId: 'l3' },
              route: [{
                graph: 'g1',
                boundaryId: 'latent',
                binding: { kind: 'port', node: 'n0', port: 'latent_image' },
              }],
            },
          ],
          nextOrdinal: 1,
          actorCursors: { alice: 2 },
        },
      }
      return d
    }
    expect(agree(base())).toEqual({ schemaValid: true, validatorValid: true })

    const mutations: ((doc: Record<string, unknown>) => void)[] = [
      (doc) => { doc['occurrenceTopologies'] = [] },
      (doc) => {
        const top = (doc['occurrenceTopologies'] as Record<string, Record<string, unknown>>)['n1']!
        delete top['owner']
      },
      (doc) => {
        const top = (doc['occurrenceTopologies'] as Record<string, Record<string, unknown>>)['n1']!
        top['links'] = []
      },
      (doc) => {
        const top = (doc['occurrenceTopologies'] as Record<string, Record<string, unknown>>)['n1']!
        const link = (top['links'] as Record<string, Record<string, unknown>>)['l0']!
        ;(link['to'] as Record<string, unknown>)['route'] = []
      },
      (doc) => {
        const top = (doc['occurrenceTopologies'] as Record<string, Record<string, unknown>>)['n1']!
        top['suppressedDeliveries'] = [{ kind: 'projectedLeg', delivery: { kind: 'unknown' }, route: [] }]
      },
      (doc) => {
        const top = (doc['occurrenceTopologies'] as Record<string, Record<string, unknown>>)['n1']!
        top['nextOrdinal'] = -1
      },
      (doc) => {
        const top = (doc['occurrenceTopologies'] as Record<string, Record<string, unknown>>)['n1']!
        top['actorCursors'] = { 'bad.actor': 1 }
      },
    ]
    for (const mutate of mutations) {
      const d = base()
      mutate(d)
      expect(agree(d)).toEqual({ schemaValid: false, validatorValid: false })
    }
  })

  it('accepts each bookmark camera shape alone and rejects both or neither', () => {
    const withBookmark = (camera: Record<string, unknown>) => {
      const d = structuredClone(loadFixture('minimal')) as Record<string, unknown>
      const view = d['view'] as Record<string, unknown>
      view['bookmarks'] = { '1': { graphStack: ['g0'], instancePath: [], ...camera } }
      return d
    }
    expect(agree(withBookmark({ view: { x: -10, y: 20, width: 800, height: 600 } }))).toEqual({
      schemaValid: true, validatorValid: true,
    })
    expect(agree(withBookmark({ viewport: { x: -10, y: 20, scale: 2 } }))).toEqual({
      schemaValid: true, validatorValid: true,
    })
    expect(agree(withBookmark({}))).toEqual({ schemaValid: false, validatorValid: false })
    expect(agree(withBookmark({
      view: { x: 0, y: 0, width: 10, height: 10 },
      viewport: { x: 0, y: 0, scale: 1 },
    }))).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('rejects the legacy litegraph fixture', () => {
    const verdict = agree(loadFixture('legacy-litegraph'))
    expect(verdict).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('accepts slot-selective family forwarding', () => {
    const d = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
    const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
    const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
    boundary['inputs']![0]!['binds'] = { kind: 'family', node: 'n2', port: 'input', slots: ['image', 'mask.alpha'] }
    delete boundary['inputs']![0]!['displayName']
    expect(agree(d)).toEqual({ schemaValid: true, validatorValid: true })
  })

  it('accepts exact output-side widget tap bindings and rejects every mixed or input-side shape', () => {
    const withTap = (side: 'inputs' | 'outputs', binding: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const d = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
      const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
      const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
      boundary[side]![0] = { id: 'tap', binds: binding, ...extra }
      return d
    }
    expect(agree(withTap('outputs', { kind: 'widgetTap', node: 'n0', tap: 'seed' }))).toEqual({
      schemaValid: true,
      validatorValid: true,
    })
    for (const malformed of [
      withTap('inputs', { kind: 'widgetTap', node: 'n0', tap: 'seed' }),
      withTap('outputs', { kind: 'widgetTap', node: 'n0', tap: 'seed', port: 'seed' }),
      withTap('outputs', { kind: 'widgetTap', node: 'n0', tap: 'seed', members: ['m0'] }),
      withTap('outputs', { kind: 'widgetTap', node: 'n0', tap: 'seed', slots: ['seed'] }),
      withTap('outputs', { kind: 'port', node: 'n0', port: 'seed', tap: 'seed' }),
      withTap('outputs', { kind: 'family', node: 'n0', port: 'seed', tap: 'seed' }),
      withTap('outputs', { kind: 'widgetTap', node: 'n0', tap: 'seed' }, { promoted: true }),
      withTap('outputs', { kind: 'widgetTap', node: 'n0', tap: 'seed' }, {
        alsoBinds: [{ kind: 'widgetTap', node: 'n0', tap: 'seed' }],
      }),
    ]) expect(agree(malformed)).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('agrees on homogeneous family fan-out and rejects mixed binding kinds', () => {
    const familyFanout = () => {
      const d = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
      const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
      const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
      boundary['inputs']![0]!['binds'] = { kind: 'family', node: 'n2', port: 'input' }
      boundary['inputs']![0]!['alsoBinds'] = [{ kind: 'family', node: 'n1', port: 'input' }]
      return d
    }
    expect(agree(familyFanout())).toEqual({ schemaValid: true, validatorValid: true })

    const familyPort = familyFanout()
    const familyPortBoundary = ((familyPort['graphs'] as Record<string, Record<string, unknown>>)['g1']!['boundary'] as Record<string, Record<string, unknown>[]>)
    familyPortBoundary['inputs']![0]!['alsoBinds'] = [{ kind: 'port', node: 'n1', port: 'input' }]
    expect(agree(familyPort)).toEqual({ schemaValid: false, validatorValid: false })

    const portFamily = familyFanout()
    const portFamilyBoundary = ((portFamily['graphs'] as Record<string, Record<string, unknown>>)['g1']!['boundary'] as Record<string, Record<string, unknown>[]>)
    portFamilyBoundary['inputs']![0]!['binds'] = { kind: 'port', node: 'n2', port: 'input' }
    expect(agree(portFamily)).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('agrees on strict region blocks', () => {
    const d = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
    const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
    const nodes = g['nodes'] as Record<string, Record<string, unknown>>
    nodes['n1']!['region'] = {
      kind: 'fold',
      elementPorts: ['items'],
      statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
      binding: 'broadcast',
      maxIterations: 10,
    }
    expect(agree(d)).toEqual({ schemaValid: true, validatorValid: true })
    ;(nodes['n1']!['region'] as Record<string, unknown>)['binding'] = 'diagonal'
    expect(agree(d)).toEqual({ schemaValid: false, validatorValid: false })
    ;(nodes['n1']!['region'] as Record<string, unknown>)['binding'] = 'broadcast'
    ;(nodes['n1']!['region'] as Record<string, unknown>)['outputRoles'] = {
      result: { kind: 'state' },
    }
    expect(agree(d)).toEqual({ schemaValid: false, validatorValid: false })
    ;(nodes['n1']!['region'] as Record<string, unknown>)['outputRoles'] = {
      result: { kind: 'state', statePort: 'state' },
      items: { kind: 'flatten' },
    }
    expect(agree(d)).toEqual({ schemaValid: true, validatorValid: true })
    ;((nodes['n1']!['region'] as Record<string, Record<string, Record<string, unknown>>>)['outputRoles']!['items']!)['statePort'] = 'state'
    expect(agree(d)).toEqual({ schemaValid: false, validatorValid: false })
    ;(nodes['n1']!['region'] as Record<string, unknown>)['outputRoles'] = {
      result: { kind: 'state', statePort: 'state' },
      items: { kind: 'flatten' },
    }
    ;(nodes['n1']!['region'] as Record<string, unknown>)['unknown'] = true
    expect(agree(d)).toEqual({ schemaValid: false, validatorValid: false })
    nodes['n1']!['region'] = { kind: 'map', outputModes: { items: 'gather' } }
    expect(agree(d)).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('agrees on corrupted variants', () => {
    const base = () => structuredClone(loadFixture('subgraph')) as Record<string, unknown>
    const mutate = (fn: (d: Record<string, unknown>) => void): unknown => {
      const d = base()
      fn(d)
      return d
    }

    const corruptions: readonly [string, unknown][] = [
      ['wrong format tag', mutate((d) => (d['format'] = 'litegraph'))],
      ['formatVersion 0', mutate((d) => (d['formatVersion'] = 0))],
      ['missing lineage', mutate((d) => delete d['lineage'])],
      ['missing view', mutate((d) => delete d['view'])],
      ['graphs as array', mutate((d) => (d['graphs'] = []))],
      [
        'node values as array',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          const nodes = g['nodes'] as Record<string, Record<string, unknown>>
          nodes['n0']!['values'] = [1, 2]
        }),
      ],
      [
        'bad controller mode',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          const nodes = g['nodes'] as Record<string, Record<string, unknown>>
          nodes['n1']!['controllers'] = { seed: 'shuffle' }
        }),
      ],
      [
        'bad node mode',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          const nodes = g['nodes'] as Record<string, Record<string, unknown>>
          nodes['n2']!['mode'] = 'disabled'
        }),
      ],
      [
        'negative nextOrdinal',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          g['nextOrdinal'] = -1
        }),
      ],
      [
        'boundary item without binds',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
          const boundary = g['boundary'] as Record<string, unknown[]>
          boundary['inputs'] = [{ id: 'latent' }]
        }),
      ],
      [
        "slots on a 'port' binding",
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
          const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
          const binds = boundary['inputs']![0]!['binds'] as Record<string, unknown>
          binds['slots'] = ['image']
        }),
      ],
      [
        'empty slots array on a family binding',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
          const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
          boundary['inputs']![0]!['binds'] = { kind: 'family', node: 'n2', port: 'input', slots: [] }
        }),
      ],
      [
        'duplicate slot ids on a family binding',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
          const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
          boundary['inputs']![0]!['binds'] = { kind: 'family', node: 'n2', port: 'input', slots: ['a', 'a'] }
        }),
      ],
      [
        'slot path with an empty segment',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
          const boundary = g['boundary'] as Record<string, Record<string, unknown>[]>
          boundary['inputs']![0]!['binds'] = { kind: 'family', node: 'n2', port: 'input', slots: ['sub..s'] }
        }),
      ],
      [
        'net sinks not an array',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g1']!
          const nets = g['nets'] as Record<string, Record<string, unknown>>
          nets['net4']!['sinks'] = { node: 'n2', port: 'input' }
        }),
      ],
      [
        'nested dynamic memberState value not an object',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          const nodes = g['nodes'] as Record<string, Record<string, unknown>>
          nodes['n0']!['dynamic'] = {
            items: { members: ['m0'], memberState: { m0: { 'items.sub': 5 } } },
          }
        }),
      ],
      [
        'nested dynamic member id empty at depth 2',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          const nodes = g['nodes'] as Record<string, Record<string, unknown>>
          nodes['n0']!['dynamic'] = {
            items: { members: ['m0'], memberState: { m0: { 'items.sub': { members: [''] } } } },
          }
        }),
      ],
      [
        'view position missing y',
        mutate((d) => {
          const view = d['view'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
          view['graphs']!['g0']!['nodes']!['n0'] = { position: { x: 1 } }
        }),
      ],
      [
        'actorCursors as array',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          g['actorCursors'] = [1]
        }),
      ],
      [
        'actorCursors non-integer cursor',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          g['actorCursors'] = { alice: 1.5 }
        }),
      ],
      [
        'actorCursors negative cursor',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          g['actorCursors'] = { alice: -1 }
        }),
      ],
      [
        'actorCursors reserved-character actor key',
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          g['actorCursors'] = { 'a.b': 1 }
        }),
      ],
      [
        "actorCursors '__proto__' actor key",
        mutate((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          // JSON.parse creates '__proto__' as an OWN key (literal syntax
          // would set the prototype instead) - exactly the wire shape a
          // hostile document would carry.
          g['actorCursors'] = JSON.parse('{"__proto__": 1}')
        }),
      ],
    ]

    for (const [label, json] of corruptions) {
      const verdict = agree(json)
      expect(verdict.schemaValid, `schema should reject: ${label}`).toBe(false)
      expect(verdict.validatorValid, `validator should reject: ${label}`).toBe(false)
    }
  })

  it('agrees on valid actorCursors (and their absence: pre-multiplayer docs stay valid)', () => {
    const d = structuredClone(loadFixture('minimal')) as Record<string, unknown>
    const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
    expect(g['actorCursors']).toBeUndefined() // golden fixtures predate the field
    expect(agree(d)).toEqual({ schemaValid: true, validatorValid: true })
    g['actorCursors'] = { alice: 3, 'b0b-6f72-4c': 12 }
    expect(agree(d)).toEqual({ schemaValid: true, validatorValid: true })
  })

  it('agrees on valid nested dynamic member state', () => {
    const d = structuredClone(loadFixture('minimal')) as Record<string, unknown>
    const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
    const nodes = g['nodes'] as Record<string, Record<string, unknown>>
    nodes['n0']!['dynamic'] = {
      items: {
        members: ['m0', 'm1'],
        seq: 2,
        memberState: {
          m0: { 'items.sub': { members: ['m10'], memberState: { m10: { 'items.sub.mode': { selected: 'a' } } } } },
        },
      },
    }
    expect(agree(d)).toEqual({ schemaValid: true, validatorValid: true })
  })

  it('agrees on the dynamic-state depth cap (16 accepted, 17 rejected)', () => {
    const withDepth = (levels: number): unknown => {
      let st: Record<string, unknown> = { members: ['m0'] }
      for (let i = 0; i < levels; i++) st = { members: ['m0'], memberState: { m0: { c: st } } }
      const d = structuredClone(loadFixture('minimal')) as Record<string, unknown>
      const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
      const nodes = g['nodes'] as Record<string, Record<string, unknown>>
      nodes['n0']!['dynamic'] = { items: st }
      return d
    }
    expect(agree(withDepth(16))).toEqual({ schemaValid: true, validatorValid: true })
    expect(agree(withDepth(17))).toEqual({ schemaValid: false, validatorValid: false })
  })

  it('agrees on value sources (valid + corrupted variants)', () => {
    const withValueSource = (fn?: (d: Record<string, unknown>) => void): unknown => {
      const d = structuredClone(loadFixture('minimal')) as Record<string, unknown>
      const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
      g['valueSources'] = {
        v50: {
          id: 'v50',
          value: 42,
          spec: { widgetType: 'INT', options: { min: 0 }, controller: 'after_generate' },
          controller: 'randomize',
          title: 'seed',
        },
      }
      const view = d['view'] as Record<string, Record<string, Record<string, unknown>>>
      view['graphs']!['g0']!['valueSources'] = { v50: { position: { x: 5, y: 6 }, view: 'slider' } }
      if (fn) fn(d)
      return d
    }

    expect(agree(withValueSource())).toEqual({ schemaValid: true, validatorValid: true })

    const vsOf = (d: Record<string, unknown>): Record<string, unknown> => {
      const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
      return (g['valueSources'] as Record<string, Record<string, unknown>>)['v50']!
    }
    const corruptions: readonly [string, unknown][] = [
      ['value source missing value', withValueSource((d) => delete vsOf(d)['value'])],
      ['bad value source controller', withValueSource((d) => (vsOf(d)['controller'] = 'shuffle'))],
      ['bad declared spec controller', withValueSource((d) => ((vsOf(d)['spec'] as Record<string, unknown>)['controller'] = 'always'))],
      ['declared spec options as array', withValueSource((d) => ((vsOf(d)['spec'] as Record<string, unknown>)['options'] = [1, 2]))],
      [
        'value source view missing position',
        withValueSource((d) => {
          const view = d['view'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
          view['graphs']!['g0']!['valueSources']!['v50'] = { view: 'slider' }
        }),
      ],
      [
        'empty valueSource ref in a link',
        withValueSource((d) => {
          const g = (d['graphs'] as Record<string, Record<string, unknown>>)['g0']!
          const links = g['links'] as Record<string, unknown>
          links['l99'] = { id: 'l99', from: { valueSource: '' }, to: { node: 'n0', port: 'steps' } }
        }),
      ],
    ]
    for (const [label, json] of corruptions) {
      const verdict = agree(json)
      expect(verdict.schemaValid, `schema should reject: ${label}`).toBe(false)
      expect(verdict.validatorValid, `validator should reject: ${label}`).toBe(false)
    }
  })

  it('both tolerate unknown extra properties (additive-first policy)', () => {
    const doc = structuredClone(loadFixture('minimal')) as Record<string, unknown>
    doc['futureField'] = { anything: true }
    const g = (doc['graphs'] as Record<string, Record<string, unknown>>)['g0']!
    g['futureGraphField'] = 42
    const verdict = agree(doc)
    expect(verdict).toEqual({ schemaValid: true, validatorValid: true })
  })
})
