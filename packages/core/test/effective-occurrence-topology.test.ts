import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { effectiveOccurrenceTopology, effectiveTopologyDrivesPort } from '../src/compile/effective-topology.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, occurrenceKey } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'

const schema = (type: string, inputs: string[], outputs: string[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: type === 'Sink',
  items: [
    ...inputs.map((id) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' }, optional: false })),
    ...outputs.map((id) => ({ kind: 'output' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' } })),
  ],
})

const schemas: Record<string, NodeSchema> = {
  Src: schema('Src', [], ['out']),
  Sink: schema('Sink', ['in', 'other'], []),
  Batch: {
    type: 'Batch', displayName: 'Batch', category: 'test', source: 'v3', isOutputNode: true,
    items: [{
      kind: 'input', id: 'items', type: { kind: 'concrete', name: 'IMAGE' }, optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
          { kind: 'input', id: 'other', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
        ],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
      },
    }],
  },
  Slot: {
    type: 'Slot', displayName: 'Slot', category: 'test', source: 'v3', isOutputNode: true,
    items: [{
      kind: 'input', id: 's', type: { kind: 'concrete', name: 'IMAGE' }, optional: true,
      dynamic: {
        kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'IMAGE' },
        inputs: [{
          kind: 'input', id: 'gain', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
          widget: { widgetType: 'FLOAT', options: {}, default: 2 },
        }],
      },
    }],
  },
  CountOutput: {
    type: 'CountOutput', displayName: 'CountOutput', category: 'test', source: 'v3', isOutputNode: false,
    items: [
      {
        kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: true,
        widget: { widgetType: 'INT', options: {}, default: 0 },
      },
      {
        kind: 'output', id: 'items', type: { kind: 'concrete', name: 'IMAGE' },
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'item', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
          count: { input: 'count', suffix: 'index' },
        },
      },
    ],
  },
}
const resolve = (type: string) => schemas[type]
const owner = (node: string, instancePath: readonly string[] = []) => ({
  instancePath: instancePath.map(asNodeId),
  node: asNodeId(node),
})

function document(): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('effective-topology'),
    root: asGraphDefId('root'),
    graphs: {
      root: {
        id: asGraphDefId('root'), name: 'root',
        nodes: {
          a: { id: asNodeId('a'), type: '#body', values: {} },
          b: { id: asNodeId('b'), type: '#body', values: {} },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      },
      body: {
        id: asGraphDefId('body'), name: 'body',
        nodes: {
          p1: { id: asNodeId('p1'), type: 'Src', values: {} },
          p2: { id: asNodeId('p2'), type: 'Src', values: {} },
          sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
        },
        links: {
          shared: {
            id: asLinkId('shared'),
            from: { node: asNodeId('p1'), port: asPortId('out') },
            to: { node: asNodeId('sink'), port: asPortId('in') },
          },
        },
        nets: {
          sharedNet: {
            id: 'sharedNet' as never,
            name: 'sharedNet',
            source: { node: asNodeId('p1'), port: asPortId('out') },
            sinks: [{ node: asNodeId('sink'), port: asPortId('other') }],
          },
        },
        reroutes: {},
        boundary: { inputs: [], outputs: [] },
        nextOrdinal: 2,
      },
    },
    view: { graphs: {} },
  }
}

function withOverlay(base = document()): WorkflowDocument {
  const a = owner('a')
  return {
    ...base,
    occurrenceTopologies: {
      [occurrenceKey(a)]: {
        owner: a,
        bodyGraph: asGraphDefId('body'),
        links: {
          local: {
            id: asLinkId('local'),
            from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
            to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
          },
        },
        suppressedDeliveries: [
          { kind: 'link', linkId: asLinkId('shared') },
          { kind: 'netSink', netId: 'sharedNet' as never, to: { node: asNodeId('sink'), port: asPortId('other') } },
        ],
        nextOrdinal: 1,
      },
    },
  }
}

const run = (doc: WorkflowDocument) => compile({
  document: doc,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('c'),
  schemaHash: 'schema',
})

describe('effectiveOccurrenceTopology', () => {
  it('combines shared links, net sinks, suppressions, and occurrence links', () => {
    const result = effectiveOccurrenceTopology(withOverlay(), resolve, owner('a'))
    expect(result.diagnostics).toEqual([])
    expect(result.links.map((link) => link.identity.kind)).toEqual(['occurrence'])
    expect(result.links[0]!.from.endpoint).toEqual({ node: 'p2', port: 'out' })
    expect(effectiveTopologyDrivesPort(
      result,
      asGraphDefId('body'),
      [asNodeId('a')],
      { node: asNodeId('sink'), port: asPortId('in') },
    )).toBe(true)
    expect(effectiveTopologyDrivesPort(
      result,
      asGraphDefId('body'),
      [asNodeId('b')],
      { node: asNodeId('sink'), port: asPortId('in') },
    )).toBe(false)
  })

  it('keeps the same shared definition and net deliveries in an unsuppressed sibling', () => {
    const result = effectiveOccurrenceTopology(withOverlay(), resolve, owner('b'))
    expect(result.diagnostics).toEqual([])
    expect(result.links.map((link) => link.identity.kind)).toEqual(['definition', 'definitionNetSink'])
  })

  it('lowers a local replacement only in its owning occurrence', () => {
    const result = run(withOverlay())
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.sink']!.inputs).toEqual({ in: ['a.p2', 0] })
    expect(result.artifact.prompt['b.sink']!.inputs).toEqual({ in: ['b.p1', 0], other: ['b.p1', 0] })
  })

  it('keeps no-overlay compilation byte-identical', () => {
    const base = document()
    const absent = run(base)
    const roundTripped = run(JSON.parse(JSON.stringify(base)) as WorkflowDocument)
    expect(roundTripped).toEqual(absent)
    expect(absent).toMatchInlineSnapshot(`
      {
        "artifact": {
          "connection": "c",
          "diagnostics": [],
          "prompt": {
            "a.p1": {
              "class_type": "Src",
              "inputs": {},
              "outputIds": [
                "out",
              ],
            },
            "a.sink": {
              "class_type": "Sink",
              "inputs": {
                "in": [
                  "a.p1",
                  0,
                ],
                "other": [
                  "a.p1",
                  0,
                ],
              },
              "outputIds": [],
            },
            "b.p1": {
              "class_type": "Src",
              "inputs": {},
              "outputIds": [
                "out",
              ],
            },
            "b.sink": {
              "class_type": "Sink",
              "inputs": {
                "in": [
                  "b.p1",
                  0,
                ],
                "other": [
                  "b.p1",
                  0,
                ],
              },
              "outputIds": [],
            },
          },
          "provenance": {
            "fromSource": {
              "a.p1": [
                "a.p1",
              ],
              "a.sink": [
                "a.sink",
              ],
              "b.p1": [
                "b.p1",
              ],
              "b.sink": [
                "b.sink",
              ],
            },
            "inputSources": {
              "a.p1": {},
              "a.sink": {
                "in": {
                  "node": "sink",
                  "port": "in",
                },
                "other": {
                  "node": "sink",
                  "port": "other",
                },
              },
              "b.p1": {},
              "b.sink": {
                "in": {
                  "node": "sink",
                  "port": "in",
                },
                "other": {
                  "node": "sink",
                  "port": "other",
                },
              },
            },
            "toSource": {
              "a.p1": "a.p1",
              "a.sink": "a.sink",
              "b.p1": "b.p1",
              "b.sink": "b.sink",
            },
          },
          "revision": 1,
          "schemaHash": "schema",
          "scope": {
            "kind": "full",
          },
          "semanticHash": "8b9ac10e26558df0",
          "snapshot": {
            "format": "dinkster-workflow",
            "formatVersion": 1,
            "graphs": {
              "body": {
                "boundary": {
                  "inputs": [],
                  "outputs": [],
                },
                "id": "body",
                "links": {
                  "shared": {
                    "from": {
                      "node": "p1",
                      "port": "out",
                    },
                    "id": "shared",
                    "to": {
                      "node": "sink",
                      "port": "in",
                    },
                  },
                },
                "name": "body",
                "nets": {
                  "sharedNet": {
                    "id": "sharedNet",
                    "name": "sharedNet",
                    "sinks": [
                      {
                        "node": "sink",
                        "port": "other",
                      },
                    ],
                    "source": {
                      "node": "p1",
                      "port": "out",
                    },
                  },
                },
                "nextOrdinal": 2,
                "nodes": {
                  "p1": {
                    "id": "p1",
                    "type": "Src",
                    "values": {},
                  },
                  "p2": {
                    "id": "p2",
                    "type": "Src",
                    "values": {},
                  },
                  "sink": {
                    "id": "sink",
                    "type": "Sink",
                    "values": {},
                  },
                },
                "reroutes": {},
              },
              "root": {
                "id": "root",
                "links": {},
                "name": "root",
                "nets": {},
                "nextOrdinal": 1,
                "nodes": {
                  "a": {
                    "id": "a",
                    "type": "#body",
                    "values": {},
                  },
                  "b": {
                    "id": "b",
                    "type": "#body",
                    "values": {},
                  },
                },
                "reroutes": {},
              },
            },
            "lineage": "effective-topology",
            "root": "root",
            "view": {
              "graphs": {},
            },
          },
        },
        "ok": true,
      }
    `)
  })

  it('suppresses exactly one projected parent fan-out leg', () => {
    const base = document()
    const first = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('in') }
    const second = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('other') }
    const root = base.graphs.root!
    const body = base.graphs.body!
    const a = owner('a')
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...root,
          nodes: { ...root.nodes, p: { id: asNodeId('p'), type: 'Src', values: {} } },
          links: {
            parent: { id: asLinkId('parent'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('a'), port: asPortId('in') } },
            sibling: { id: asLinkId('sibling'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('b'), port: asPortId('in') } },
          },
        },
        body: { ...body, links: {}, nets: {}, boundary: { inputs: [{ id: 'in', binds: first, alsoBinds: [second] }], outputs: [] } },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('parent') },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'in', binding: first }],
          }],
        },
      },
    }
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.sink']!.inputs).toEqual({ other: ['p', 0] })
    expect(result.artifact.prompt['b.sink']!.inputs).toEqual({ in: ['p', 0], other: ['p', 0] })
    const effective = effectiveOccurrenceTopology(changed, resolve, a)
    expect(effective.projectedParentLinks).toHaveLength(1)
    expect(effective.projectedParentLinks[0]!.to.endpoint).toEqual(second)
  })

  it('suppresses a projected parent delivery on the output side', () => {
    const base = document()
    const a = owner('a')
    const binding = { kind: 'port' as const, node: asNodeId('p1'), port: asPortId('out') }
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            ...base.graphs.root!.nodes,
            sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
          },
          links: { parent: { id: asLinkId('parent'), from: { node: asNodeId('a'), port: asPortId('out') }, to: { node: asNodeId('sink'), port: asPortId('in') } } },
        },
        body: {
          ...base.graphs.body!,
          boundary: { inputs: [], outputs: [{ id: 'out', binds: binding }] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('parent') },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'out', binding }],
          }],
        },
      },
    }
    expect(effectiveOccurrenceTopology(changed, resolve, a).projectedParentLinks).toEqual([])
    const compiled = run(changed)
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (compiled.ok) expect(compiled.artifact.prompt.sink!.inputs).toEqual({})
  })

  it('scopes a repeated-definition projected-leg suppression to its concrete owner and connectivity', () => {
    const base = document()
    const slotBinding = { kind: 'port' as const, node: asNodeId('slot'), port: asPortId('s') }
    const otherBinding = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('other') }
    const nestedA = owner('i', ['a'])
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            a: { id: asNodeId('a'), type: '#outer', values: {} },
            b: { id: asNodeId('b'), type: '#outer', values: {} },
          },
        },
        outer: {
          id: asGraphDefId('outer'), name: 'outer',
          nodes: {
            p: { id: asNodeId('p'), type: 'Src', values: {} },
            i: { id: asNodeId('i'), type: '#body', values: {} },
          },
          links: { parent: { id: asLinkId('parent'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('i'), port: asPortId('in') } } },
          nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: { inputs: [], outputs: [] },
        },
        body: {
          ...base.graphs.body!,
          nodes: {
            slot: { id: asNodeId('slot'), type: 'Slot', values: {} },
            sink: base.graphs.body!.nodes.sink!,
          },
          links: {}, nets: {},
          boundary: { inputs: [{ id: 'in', binds: slotBinding, alsoBinds: [otherBinding] }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(nestedA)]: {
          owner: nestedA, bodyGraph: asGraphDefId('body'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('outer'), linkId: asLinkId('parent') },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'in', binding: slotBinding }],
          }],
        },
      },
    }
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.i.slot']!.inputs).toEqual({})
    expect(result.artifact.prompt['a.i.sink']!.inputs).toEqual({ other: ['a.p', 0] })
    expect(result.artifact.prompt['b.i.slot']!.inputs).toEqual({ s: ['b.p', 0], 's.gain': 2 })
    expect(result.artifact.prompt['b.i.sink']!.inputs).toEqual({ other: ['b.p', 0] })
  })

  it('projects the parent occurrence effective set and validates it with child-local drivers', () => {
    const base = document()
    const parentOwner = owner('a')
    const nestedOwner = owner('i', ['a'])
    const parentTopology = {
      owner: parentOwner,
      bodyGraph: asGraphDefId('outer'),
      links: {
        local: {
          id: asLinkId('local'),
          from: { kind: 'body' as const, endpoint: { node: asNodeId('p'), port: asPortId('out') } },
          to: { kind: 'body' as const, endpoint: { node: asNodeId('i'), port: asPortId('in') } },
        },
      },
      suppressedDeliveries: [{ kind: 'link' as const, linkId: asLinkId('shared') }],
      nextOrdinal: 1,
    }
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: { a: { id: asNodeId('a'), type: '#outer', values: {} } },
        },
        outer: {
          id: asGraphDefId('outer'), name: 'outer',
          nodes: {
            p: { id: asNodeId('p'), type: 'Src', values: {} },
            i: { id: asNodeId('i'), type: '#body', values: {} },
          },
          links: {
            shared: { id: asLinkId('shared'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('i'), port: asPortId('in') } },
          },
          nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: { inputs: [], outputs: [] },
        },
        body: {
          ...base.graphs.body!, links: {}, nets: {},
          boundary: { inputs: [{ id: 'in', binds: { kind: 'port', node: asNodeId('sink'), port: asPortId('in') } }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(parentOwner)]: parentTopology,
        [occurrenceKey(nestedOwner)]: {
          owner: nestedOwner, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            child: {
              id: asLinkId('child'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
            },
          },
        },
      },
    }
    const result = effectiveOccurrenceTopology(changed, resolve, nestedOwner)
    expect(result.projectedParentLinks.map((link) => link.identity.kind)).toEqual(['occurrence'])
    expect(result.projectedParentLinks[0]!.from.endpoint).toEqual({ node: 'p', port: 'out' })
    expect(result.projectedParentLinks[0]!.from.source.kind).toBe('occurrence')
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('occurrence.topology.multipleDrivers')

    const suppressedOnly: WorkflowDocument = {
      ...changed,
      occurrenceTopologies: {
        [occurrenceKey(parentOwner)]: { ...parentTopology, links: {} },
      },
    }
    expect(effectiveOccurrenceTopology(suppressedOnly, resolve, nestedOwner).projectedParentLinks).toEqual([])
  })

  it('projects and suppresses a root delivery through a chained occurrence route', () => {
    const base = document()
    const nestedOwner = owner('i', ['a'])
    const outerBinding = { kind: 'port' as const, node: asNodeId('i'), port: asPortId('in') }
    const bodyBinding = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('in') }
    const route = [
      { graph: asGraphDefId('outer'), boundaryId: 'in', binding: outerBinding },
      { graph: asGraphDefId('body'), boundaryId: 'in', binding: bodyBinding },
    ]
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            p: { id: asNodeId('p'), type: 'Src', values: {} },
            a: { id: asNodeId('a'), type: '#outer', values: {} },
          },
          links: { rootLink: { id: asLinkId('rootLink'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('a'), port: asPortId('in') } } },
        },
        outer: {
          id: asGraphDefId('outer'), name: 'outer',
          nodes: { i: { id: asNodeId('i'), type: '#body', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: { inputs: [{ id: 'in', binds: outerBinding }], outputs: [] },
        },
        body: {
          ...base.graphs.body!, links: {}, nets: {},
          boundary: { inputs: [{ id: 'in', binds: bodyBinding }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(nestedOwner)]: {
          owner: nestedOwner, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
            },
          },
        },
      },
    }
    const effective = effectiveOccurrenceTopology(changed, resolve, nestedOwner)
    expect(effective.projectedParentLinks).toHaveLength(1)
    expect(effective.projectedParentLinks[0]!.identity).toEqual({
      kind: 'parentLeg',
      delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('rootLink') },
      route,
    })
    expect(effective.diagnostics.map((diagnostic) => diagnostic.code)).toContain('occurrence.topology.multipleDrivers')

    const suppressed: WorkflowDocument = {
      ...changed,
      occurrenceTopologies: {
        [occurrenceKey(nestedOwner)]: {
          ...changed.occurrenceTopologies![occurrenceKey(nestedOwner)]!,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('rootLink') },
            route,
          }],
        },
      },
    }
    const suppressedEffective = effectiveOccurrenceTopology(suppressed, resolve, nestedOwner)
    expect(suppressedEffective.projectedParentLinks).toEqual([])
    expect(suppressedEffective.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('occurrence.topology.multipleDrivers')

    const intermediateSuppressed: WorkflowDocument = {
      ...changed,
      occurrenceTopologies: {
        [occurrenceKey(owner('a'))]: {
          owner: owner('a'), bodyGraph: asGraphDefId('outer'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('rootLink') },
            route: [route[0]!],
          }],
        },
        [occurrenceKey(nestedOwner)]: changed.occurrenceTopologies![occurrenceKey(nestedOwner)]!,
      },
    }
    const compiled = run(intermediateSuppressed)
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (compiled.ok) expect(compiled.artifact.prompt['a.i.sink']!.inputs).toEqual({ in: ['a.i.p2', 0] })
  })

  it('validates local dependent ports with projected parent connectivity', () => {
    const base = document()
    const a = owner('a')
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            ...base.graphs.root!.nodes,
            p: { id: asNodeId('p'), type: 'Src', values: {} },
          },
          links: { parent: { id: asLinkId('parent'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('a'), port: asPortId('in') } } },
        },
        body: {
          ...base.graphs.body!,
          nodes: {
            p2: base.graphs.body!.nodes.p2!,
            slot: { id: asNodeId('slot'), type: 'Slot', values: {} },
          },
          links: {}, nets: {},
          boundary: { inputs: [{ id: 'in', binds: { kind: 'port', node: asNodeId('slot'), port: asPortId('s') } }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            dependent: {
              id: asLinkId('dependent'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'body', endpoint: { node: asNodeId('slot'), port: asPortId('s.gain') } },
            },
          },
        },
      },
    }
    expect(effectiveOccurrenceTopology(changed, resolve, a).diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('occurrence.topology.endpointMissing')
  })

  it('hashes a local reroute driver with its definition-owned consumer closure', () => {
    const base = document()
    const body = base.graphs.body!
    const a = owner('a')
    const rerouted: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        body: {
          ...body,
          links: { consumer: { id: asLinkId('consumer'), from: { reroute: 'r' as never }, to: { node: asNodeId('sink'), port: asPortId('in') } } },
          nets: {},
          reroutes: { r: { id: 'r' as never } },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: { id: asLinkId('local'), from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } }, to: { kind: 'body', endpoint: { reroute: 'r' as never } } },
          },
        },
      },
    }
    const direct: WorkflowDocument = {
      ...rerouted,
      graphs: { ...rerouted.graphs, body: { ...rerouted.graphs.body!, links: {} } },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          ...rerouted.occurrenceTopologies![occurrenceKey(a)]!,
          links: {
            local: { id: asLinkId('local'), from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } }, to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } } },
          },
        },
      },
    }
    expect(semanticHashOf(rerouted)).toBe(semanticHashOf(direct))

    const boundarySource = { kind: 'boundary' as const, occurrence: a, address: { port: asPortId('out') }, route: [{
      graph: asGraphDefId('body'), boundaryId: 'out', binding: { kind: 'port' as const, node: asNodeId('p2'), port: asPortId('out') },
    }] }
    const withOutput = (doc: WorkflowDocument): WorkflowDocument => ({
      ...doc,
      graphs: {
        ...doc.graphs,
        body: {
          ...doc.graphs.body!,
          boundary: { inputs: [], outputs: [{ id: 'out', binds: { kind: 'port', node: asNodeId('p2'), port: asPortId('out') } }] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          ...doc.occurrenceTopologies![occurrenceKey(a)]!,
          links: {
            local: {
              ...doc.occurrenceTopologies![occurrenceKey(a)]!.links.local!,
              from: boundarySource,
            },
          },
        },
      },
    })
    expect(semanticHashOf(withOutput(rerouted))).toBe(semanticHashOf(withOutput(direct)))
  })

  it('lowers a grouped whole-family boundary endpoint through a direct crossing', () => {
    const base = document()
    const root = base.graphs.root!
    const body = base.graphs.body!
    const a = owner('a')
    const binding = { kind: 'family' as const, node: asNodeId('batch'), port: asPortId('items') }
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: { ...root, nodes: { ...root.nodes, a: { ...root.nodes.a!, dynamic: { fam: { members: ['m0'] } } } } },
        body: {
          ...body,
          nodes: { p2: body.nodes.p2!, batch: { id: asNodeId('batch'), type: 'Batch', values: {} } },
          links: {}, nets: {}, boundary: { inputs: [{ id: 'fam', binds: binding }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'boundary', occurrence: a, address: { port: asPortId('fam.value'), members: ['m0' as never] }, route: [{ graph: asGraphDefId('body'), boundaryId: 'fam', binding }] },
            },
          },
        },
      },
    }
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.batch']!.inputs).toEqual({ 'items.item0.value': ['a.p2', 0] })
  })

  it('resolves occurrence links through a promoted count-bound output', () => {
    const base = document()
    const a = owner('a')
    const binding = { kind: 'family' as const, node: asNodeId('count'), port: asPortId('items') }
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: { a: { id: asNodeId('a'), type: '#body', values: { amount: 2 } } },
        },
        body: {
          ...base.graphs.body!,
          nodes: {
            count: { id: asNodeId('count'), type: 'CountOutput', values: { count: 1 } },
            sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
          },
          links: {}, nets: {},
          boundary: {
            inputs: [{ id: 'amount', binds: { kind: 'port', node: asNodeId('count'), port: asPortId('count') }, promoted: true }],
            outputs: [{ id: 'family', binds: binding }],
          },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: {
                kind: 'boundary', occurrence: a, address: { port: asPortId('family'), members: ['1' as never] },
                route: [{ graph: asGraphDefId('body'), boundaryId: 'family', binding }],
              },
              to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
            },
          },
        },
      },
    }
    const effective = effectiveOccurrenceTopology(changed, resolve, a)
    expect(effective.diagnostics).toEqual([])
    expect(effective.links[0]!.from.endpoint).toEqual({ node: 'count', port: 'items', members: ['1'] })
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['a.sink']!.inputs).toEqual({ in: ['a.count', 1] })
  })

  it('lowers an ancestor-owned family endpoint through a chained nested occurrence', () => {
    const base = document()
    const body = base.graphs.body!
    const outerBinding = { kind: 'family' as const, node: asNodeId('i'), port: asPortId('fam1') }
    const bodyBinding = { kind: 'family' as const, node: asNodeId('batch'), port: asPortId('items') }
    const nested = owner('i', ['a'])
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: { a: { id: asNodeId('a'), type: '#outer', values: {}, dynamic: { fam2: { members: ['m0'] } } } },
        },
        outer: {
          id: asGraphDefId('outer'), name: 'outer',
          nodes: { i: { id: asNodeId('i'), type: '#body', values: {}, dynamic: { fam1: { members: ['q0'] } } } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: { inputs: [{ id: 'fam2', binds: outerBinding }], outputs: [] },
        },
        body: {
          ...body,
          nodes: { p2: body.nodes.p2!, batch: { id: asNodeId('batch'), type: 'Batch', values: {} } },
          links: {}, nets: {}, boundary: { inputs: [{ id: 'fam1', binds: bodyBinding }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(nested)]: {
          owner: nested, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: {
                kind: 'boundary', occurrence: owner('a'), address: { port: asPortId('fam2.value'), members: ['m0' as never] },
                route: [
                  { graph: asGraphDefId('outer'), boundaryId: 'fam2', binding: outerBinding },
                  { graph: asGraphDefId('body'), boundaryId: 'fam1', binding: bodyBinding },
                ],
              },
            },
          },
        },
      },
    }
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.i.batch']!.inputs).toEqual({ 'items.item1.value': ['a.i.p2', 0] })
  })

  it('fails closed when a boundary route binding has zero matches', () => {
    const doc = withOverlay()
    const top = doc.occurrenceTopologies![occurrenceKey(owner('a'))]!
    const changed: WorkflowDocument = {
      ...doc,
      occurrenceTopologies: {
        [occurrenceKey(owner('a'))]: {
          ...top,
          links: {
            bad: {
              id: asLinkId('bad'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: {
                kind: 'boundary', occurrence: owner('a'), address: { port: asPortId('missing') },
                route: [{ graph: asGraphDefId('body'), boundaryId: 'missing', binding: { kind: 'port', node: asNodeId('sink'), port: asPortId('in') } }],
              },
            },
          },
        },
      },
    }
    const result = effectiveOccurrenceTopology(changed, resolve, owner('a'))
    expect(result.links).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toContain('occurrence.topology.routeMissing')
  })

  it('fails closed when a recorded binding is structurally ambiguous', () => {
    const doc = document()
    const binding = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('in') }
    const body = doc.graphs.body!
    const changedBody = { ...body, boundary: { inputs: [{ id: 'in', binds: binding, alsoBinds: [binding] }], outputs: [] } }
    const a = owner('a')
    const changed: WorkflowDocument = {
      ...doc,
      graphs: { ...doc.graphs, body: changedBody },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            bad: {
              id: asLinkId('bad'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'boundary', occurrence: a, address: { port: asPortId('in') }, route: [{ graph: asGraphDefId('body'), boundaryId: 'in', binding }] },
            },
          },
        },
      },
    }
    const result = effectiveOccurrenceTopology(changed, resolve, a)
    expect(result.links.some((link) => link.identity.kind === 'occurrence')).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('occurrence.topology.routeAmbiguous')
  })

  it('validates cycles and port direction over the combined effective set', () => {
    const base = document()
    const a = owner('a')
    const body = base.graphs.body!
    const cycled: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        body: {
          ...body, nets: {},
          reroutes: { r1: { id: 'r1' as never }, r2: { id: 'r2' as never } },
          links: { shared: { id: asLinkId('shared'), from: { reroute: 'r2' as never }, to: { reroute: 'r1' as never } } },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: { id: asLinkId('local'), from: { kind: 'body', endpoint: { reroute: 'r1' as never } }, to: { kind: 'body', endpoint: { reroute: 'r2' as never } } },
          },
        },
      },
    }
    expect(effectiveOccurrenceTopology(cycled, resolve, a).diagnostics.map((diagnostic) => diagnostic.code)).toContain('doc.reroute.cycle')

    const wrongDirection: WorkflowDocument = {
      ...base,
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
              to: { kind: 'body', endpoint: { node: asNodeId('p1'), port: asPortId('out') } },
            },
          },
        },
      },
    }
    expect(effectiveOccurrenceTopology(wrongDirection, resolve, a).diagnostics.filter((diagnostic) =>
      diagnostic.code === 'occurrence.topology.endpointDirection')).toHaveLength(2)
  })
})
