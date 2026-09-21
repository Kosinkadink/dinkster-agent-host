/**
 * Dynamic-state commands and materialization frames.
 *
 * The contract under test: elaboration synthesizes min-fill members and one
 * trailing ghost as view affordances; `dynamic.materialize`
 * persists them append-only and idempotently; `dynamic.selectOption`
 * switches combo branches only beneath persisted ancestors; `batch` makes
 * "materialize + the action that caused it" one atomic transaction and one
 * undo step; `materializeFramesOf` derives the frames param from an
 * elaborated target, including min-fill siblings and nested chains.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asDynamicMemberId, asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId } from '../src/ids.js'
import {
  elabInputsOf,
  elaborateInterface,
  materializeFramesOf,
  type ElaboratedInput,
} from '../src/schema/elaborate.js'
import { parseDinksterSchemaWire15 } from '../src/schema/dinkster-wire.js'
import type { InputSpec, InterfaceItem, NodeSchema } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id: asNodeId(id),
  type: 'Batch',
  values: {},
  ...extra,
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

const port = (n: string, p: string) => ({ node: asNodeId(n), port: asPortId(p) })

const schemaOf = (items: InterfaceItem[]): NodeSchema => ({
  type: 'Batch',
  displayName: 'Batch',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const socketInput = (id: string, type = 'IMAGE', extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: type },
  optional: false,
  ...extra,
})

const autogrowFamily = (
  id: string,
  opts: { min?: number; max?: number; template?: InputSpec[] } = {},
): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'wildcard' },
  optional: false,
  dynamic: {
    kind: 'autogrow',
    template: opts.template ?? [socketInput('item', 'IMAGE')],
    naming: { kind: 'prefix', prefix: 'image', min: opts.min ?? 0, max: opts.max ?? 4 },
  },
})

const dynOf = (store: DocumentStore, nodeId: string, graphId = 'g0') =>
  store.doc.graphs[graphId]!.nodes[nodeId]!.dynamic

// ---------------------------------------------------------------------------
// dynamic.materialize
// ---------------------------------------------------------------------------

describe('dynamic.materialize', () => {
  it('persists a top-level member and maintains seq', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m0'] }] },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m0'], seq: 1 } })
  })

  it('appends after existing members, never reorders, and bumps seq past every suffix', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: ['m5'], seq: 6 } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m6', 'm7'] }] },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m5', 'm6', 'm7'], seq: 8 } })
  })

  it('CO7: an exhausted family (seq beyond the mintable window) refuses to grow', () => {
    // A hostile/corrupted document may carry seq above the 15-digit parse
    // window; growing such a family could collide a persisted member with
    // the next offered ghost, so the command rejects atomically.
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: [], seq: Number.MAX_SAFE_INTEGER } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m0'] }] },
    })
    expect(out.ok).toBe(false)
    expect(out.diagnostics[0]!.message).toContain('id space exhausted')
    expect(dynOf(store, 'n1')).toEqual({ images: { members: [], seq: Number.MAX_SAFE_INTEGER } })
  })

  it('CO7: a minted-shaped member id above the 15-digit parse window is rejected', () => {
    // 'm' + 16 digits would be invisible to the seq bump: the same address
    // could later be offered again as a ghost.
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m9007199254740991'] }] },
    })
    expect(out.ok).toBe(false)
    expect(out.diagnostics[0]!.message).toContain('outside the mintable id space')
    expect(dynOf(store, 'n1')).toBeUndefined()
  })

  it('is idempotent: re-materializing persisted members records no transaction', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: ['m0'], seq: 1 } } }) },
        }),
      }),
    )
    const before = store.revision
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m0'] }] },
    })
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('nested frames descend via the LAST member of each frame, creating containers', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        frames: [
          { construct: 'items', members: ['m0', 'm1'] },
          { construct: 'items.sub', members: ['m0'] },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      items: {
        members: ['m0', 'm1'],
        seq: 2,
        memberState: { m1: { 'items.sub': { members: ['m0'], seq: 1 } } },
      },
    })
  })

  it('preserves sibling family state and existing nested state', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: {
            n1: node('n1', {
              dynamic: {
                other: { selected: 'b' },
                items: {
                  members: ['m0'],
                  seq: 1,
                  memberState: { m0: { 'items.sub': { members: ['m2'], seq: 3 } } },
                },
              },
            }),
          },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        frames: [
          { construct: 'items', members: ['m0'] },
          { construct: 'items.sub', members: ['m3'] },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      other: { selected: 'b' },
      items: {
        members: ['m0'],
        seq: 1,
        memberState: { m0: { 'items.sub': { members: ['m2', 'm3'], seq: 4 } } },
      },
    })
  })

  it('rejects malformed params, unknown targets, and over-deep frames', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const bad = (params: unknown) =>
      store.dispatch({ command: 'dynamic.materialize', params: params as never })
    expect(bad({ graphId: 'g0', nodeId: 'n1', frames: [] }).ok).toBe(false)
    expect(bad({ graphId: 'g0', nodeId: 'n1', frames: [{ construct: '', members: ['m0'] }] }).ok).toBe(false)
    expect(bad({ graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'a', members: [] }] }).ok).toBe(false)
    expect(bad({ graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'a', members: ['m0', 'm0'] }] }).ok).toBe(false)
    expect(bad({ graphId: 'gX', nodeId: 'n1', frames: [{ construct: 'a', members: ['m0'] }] }).ok).toBe(false)
    expect(bad({ graphId: 'g0', nodeId: 'nX', frames: [{ construct: 'a', members: ['m0'] }] }).ok).toBe(false)
    const deep = Array.from({ length: 17 }, (_, i) => ({ construct: `c${i}`, members: ['m0'] }))
    expect(bad({ graphId: 'g0', nodeId: 'n1', frames: deep }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// dynamic.selectOption
// ---------------------------------------------------------------------------

describe('CO3 dynamic member ids never rewind across undo', () => {
  const materialize = (store: DocumentStore, members: string[]) =>
    store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members }] },
    })

  it('undo of materialize removes members but keeps the seq high-water mark', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    expect(materialize(store, ['m0']).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m0'], seq: 1 } })
    store.undo()
    // Members gone, cursor preserved: 'm0' can never mean two nodes' state.
    expect(dynOf(store, 'n1')).toEqual({ images: { seq: 1 } })
    expect(materialize(store, ['m1']).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1'], seq: 2 } })
  })

  it('redo after a clamped undo reapplies the members without erroring', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    expect(materialize(store, ['m0']).ok).toBe(true)
    store.undo()
    expect(store.redo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m0'], seq: 1 } })
  })

  it('nested memberState cursors survive undo too', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        frames: [
          { construct: 'images', members: ['m0'] },
          { construct: 'inner', members: ['m0'] },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      images: { members: ['m0'], seq: 1, memberState: { m0: { inner: { members: ['m0'], seq: 1 } } } },
    })
    store.undo()
    expect(dynOf(store, 'n1')).toEqual({
      images: { seq: 1, memberState: { m0: { inner: { seq: 1 } } } },
    })
  })

  it('cursor-only skeletons left by undo are hash-neutral (seq is bookkeeping, not semantics)', () => {
    // Like nextOrdinal and surfaceSeq, the dynamic seq cursor only affects
    // FUTURE member ids - never what executes now. Materialize-then-undo
    // must restore the semantic hash even though the skeleton stays behind.
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const before = semanticHashOf(store.doc)
    expect(materialize(store, ['m0']).ok).toBe(true)
    expect(semanticHashOf(store.doc)).not.toBe(before) // members ARE semantic
    store.undo()
    expect(dynOf(store, 'n1')).toEqual({ images: { seq: 1 } }) // skeleton remains...
    expect(semanticHashOf(store.doc)).toBe(before) // ...but hashes as if absent
  })

  it('NESTED cursor skeletons are hash-neutral too', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const before = semanticHashOf(store.doc)
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        frames: [
          { construct: 'images', members: ['m0'] },
          { construct: 'inner', members: ['m0'] },
        ],
      },
    })
    expect(out.ok).toBe(true)
    store.undo()
    expect(dynOf(store, 'n1')).toEqual({
      images: { seq: 1, memberState: { m0: { inner: { seq: 1 } } } },
    })
    expect(semanticHashOf(store.doc)).toBe(before)
  })
})

describe('dynamic.selectOption', () => {
  it('sets selected at top level, preserving other construct state', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: ['m0'], seq: 1 } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: { graphId: 'g0', nodeId: 'n1', construct: 'mode', option: 'advanced' },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      images: { members: ['m0'], seq: 1 },
      mode: { selected: 'advanced' },
    })
  })

  it('is idempotent: re-selecting the current option records no transaction', () => {
    const store = makeStore(
      doc({
        g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { mode: { selected: 'a' } } }) } }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: { graphId: 'g0', nodeId: 'n1', construct: 'mode', option: 'a' },
    })
    expect(out.ok).toBe(true)
    expect(store.canUndo).toBe(false)
  })

  it('switches a combo nested under a PERSISTED member, creating containers', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { items: { members: ['m0'], seq: 1 } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        ancestors: [{ construct: 'items', member: 'm0' }],
        construct: 'items.mode',
        option: 'blur',
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      items: {
        members: ['m0'],
        seq: 1,
        memberState: { m0: { 'items.mode': { selected: 'blur' } } },
      },
    })
  })

  it('rejects an unmaterialized ancestor (hazard N3: no state beneath synthetics)', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        ancestors: [{ construct: 'items', member: 'm0' }],
        construct: 'items.mode',
        option: 'blur',
      },
    })
    expect(out.ok).toBe(false)
    expect(out.diagnostics.some((d) => d.code === 'dynamic.unmaterializedAncestor')).toBe(true)
  })
})

describe('dynamic.specializeSlot', () => {
  it('sets selected specialization', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    expect(store.dispatch({ command: 'dynamic.specializeSlot', params: { graphId: 'g0', nodeId: 'n1', construct: 'model', variant: 'lora' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ model: { selected: 'lora' } })
  })

  it('clears selected specialization with null', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { model: { selected: 'lora' } } }) } }) }))
    expect(store.dispatch({ command: 'dynamic.specializeSlot', params: { graphId: 'g0', nodeId: 'n1', construct: 'model', variant: null } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ model: {} })
  })

  it('is idempotent when re-setting the current specialization', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { model: { selected: 'lora' } } }) } }) }))
    const before = store.revision
    expect(store.dispatch({ command: 'dynamic.specializeSlot', params: { graphId: 'g0', nodeId: 'n1', construct: 'model', variant: 'lora' } }).ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('writes specialization in persisted ancestor member scope', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { items: { members: ['m0'], seq: 1 } } }) } }) }))
    const out = store.dispatch({ command: 'dynamic.specializeSlot', params: {
      graphId: 'g0', nodeId: 'n1', ancestors: [{ construct: 'items', member: 'm0' }], construct: 'items.model', variant: 'lora',
    } })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ items: { members: ['m0'], seq: 1, memberState: { m0: { 'items.model': { selected: 'lora' } } } } })
  })
})

describe('dynamic.labelMember', () => {
  it('authors presentation labels without changing execution identity and supports undo', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: { values: { members: ['m7', 'm2'], seq: 8 } } }),
      } }),
    }))
    const before = semanticHashOf(store.doc)
    const result = store.dispatch({ command: 'dynamic.labelMember', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'values', member: 'm7', label: 'Background',
    } })
    expect(result.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      values: { members: ['m7', 'm2'], seq: 8, memberLabels: { m7: 'Background' } },
    })
    expect(semanticHashOf(store.doc)).toBe(before)
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['m7', 'm2'], seq: 8 } })
  })

  it('rejects duplicate effective labels without recording a transaction', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: {
          values: { members: ['m7', 'm2'], memberLabels: { m7: 'Background', m2: 'Subject' } },
        } }),
      } }),
    }))
    const revision = store.revision
    const result = store.dispatch({ command: 'dynamic.labelMember', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'values', member: 'm2', label: 'Background',
    } })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('dynamic.duplicateMemberLabel')
    expect(store.revision).toBe(revision)
  })

  it('updates multiple labels atomically so labels can be swapped', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: {
          values: { members: ['m0', 'm1'], memberLabels: { m0: 'Left', m1: 'Right' } },
        } }),
      } }),
    }))
    expect(store.dispatch({ command: 'dynamic.labelMembers', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'values', labels: { m0: 'Right', m1: 'Left' },
    } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toMatchObject({
      values: { memberLabels: { m0: 'Right', m1: 'Left' } },
    })
  })

  it('writes labels in a persisted ancestor member scope', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: {
          groups: {
            members: ['outer'],
            memberState: { outer: { 'groups.values': { members: ['m0'] } } },
          },
        } }),
      } }),
    }))
    expect(store.dispatch({ command: 'dynamic.labelMember', params: {
      graphId: 'g0', nodeId: 'n1',
      ancestors: [{ construct: 'groups', member: 'outer' }],
      construct: 'groups.values', member: 'm0', label: 'Primary',
    } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toMatchObject({
      groups: { memberState: { outer: {
        'groups.values': { members: ['m0'], memberLabels: { m0: 'Primary' } },
      } } },
    })
  })
})

// ---------------------------------------------------------------------------
// dynamic.compact
// ---------------------------------------------------------------------------

describe('dynamic.compact', () => {
  const state = { images: { members: ['m0', 'm1', 'm2'], seq: 3 } }

  it('removes unreferenced rows while preserving linked member identity and order', () => {
    const g = graph({
      id: 'g0',
      nodes: { src: node('src'), n1: node('n1', { dynamic: state }) },
      links: {
        l1: { id: asLinkId('l1'), from: port('src', 'out'), to: { ...port('n1', 'images.item'), members: [asDynamicMemberId('m1')] } },
      },
    })
    const store = makeStore(doc({ g0: g }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1'], seq: 3 } })
    const revision = store.revision
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })

  it('retains labels only for members retained by semantic references', () => {
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src'), n1: node('n1', { dynamic: {
          images: {
            members: ['m0', 'm1'], seq: 2,
            memberLabels: { m0: 'Removed', m1: 'Retained' },
          },
        } }) },
        links: {
          l1: { id: asLinkId('l1'), from: port('src', 'out'),
            to: { ...port('n1', 'images.item'), members: [asDynamicMemberId('m1')] } },
        },
      }),
    }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      images: { members: ['m1'], seq: 2, memberLabels: { m1: 'Retained' } },
    })
  })

  it('advances a named-family ghost after the retained member on compaction', () => {
    const schema = parseDinksterSchemaWire15('Math Expression', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'values', memberNames: ['a', 'b', 'c'], minMembers: 1,
        template: [{
          role: 'input', id: 'value',
          type: { kind: 'concrete', types: ['core.number'] }, required: false,
        }],
      }],
    }).schema!
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src'),
          n1: node('n1', {
            dynamic: { values: { members: ['a', 'b'] } },
            values: { 'values.b': 2 },
          }),
        },
        links: {
          l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'values.b') },
        },
      }),
    }))

    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['b'], seq: 0 } })
    const inputs = elabInputsOf(elaborateInterface(schema, {
      values: store.doc.graphs.g0!.nodes.n1!.values,
      dynamic: store.doc.graphs.g0!.nodes.n1!.dynamic!,
    })).map((input) => ({
      port: input.address.port,
      ghost: input.origin.kind === 'member' && input.origin.ghost === true,
    }))
    expect(inputs).toEqual([
      { port: 'values.b', ghost: false },
      { port: 'values.c', ghost: true },
    ])

    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['a', 'b'], seq: 0 } })
    expect(store.redo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['b'], seq: 0 } })
    expect(store.doc.graphs.g0!.nodes.n1!.values['values.b']).toBe(2)
    expect(store.doc.graphs.g0!.links.l1!.to).toEqual(port('n1', 'values.b'))
  })

  it('keeps members referenced by stored values', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: state, values: { 'images.item#m2': 4 } }) } }) }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m2'], seq: 3 } })
  })

  it('keeps members referenced by nets', () => {
    const g = graph({
      id: 'g0',
      nodes: { n1: node('n1', { dynamic: state }), dst: node('dst') },
      nets: { net1: { id: asNetId('net1'), name: 'n', source: { ...port('n1', 'images.item'), members: [asDynamicMemberId('m0')] }, sinks: [port('dst', 'in')] } },
    })
    const store = makeStore(doc({ g0: g }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m0'], seq: 3 } })
  })

  it('keeps wire-15 path-encoded members referenced by links and nets', () => {
    const g = graph({
      id: 'g0',
      nodes: { src: node('src'), n1: node('n1', { dynamic: state }), dst: node('dst') },
      links: {
        l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'images.m1') },
      },
      nets: {
        net1: { id: asNetId('net1'), name: 'n', source: port('n1', 'images.m2'), sinks: [port('dst', 'in')] },
      },
    })
    const store = makeStore(doc({ g0: g }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1', 'm2'], seq: 3 } })
  })

  it('keeps every family scope referenced by a flattened nested wire-15 path', () => {
    const dynamic = {
      outer: { members: ['root', 'unused'], seq: 2 },
      'outer.root.inner': { members: ['child', 'unused'], seq: 2 },
    }
    const g = graph({
      id: 'g0',
      nodes: { src: node('src'), n1: node('n1', { dynamic }) },
      links: {
        l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'outer.root.inner.child') },
      },
    })
    const store = makeStore(doc({ g0: g }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      outer: { members: ['root'], seq: 2 },
      'outer.root.inner': { members: ['child'], seq: 2 },
    })
  })

  it('keeps wire-15 members referenced by flat/nested values and flattened choices', () => {
    const dynamic = {
      outer: { members: ['root', 'unused'], seq: 2 },
      'outer.root.inner': { members: ['child', 'unused'], seq: 2 },
      'outer.root.inner.child.mode': { selected: 'on' },
    }
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: {
          n1: node('n1', {
            dynamic,
            values: { 'outer.root.inner.child': 1 },
          }),
        },
      }),
    }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      outer: { members: ['root'], seq: 2 },
      'outer.root.inner': { members: ['child'], seq: 2 },
      'outer.root.inner.child.mode': { selected: 'on' },
    })
  })

  it('repairs a missing legacy high-water mark before removing old imported members', () => {
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1', { dynamic: { images: { members: ['m0', 'm2'] } } }) },
      }),
    }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { seq: 3 } })
  })

  it('repairs legacy high-water from orphaned memberState identities', () => {
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: {
          n1: node('n1', {
            dynamic: {
              images: {
                members: ['m0'],
                memberState: { m7: { nested: { selected: 'a' } } },
              },
            },
          }),
        },
      }),
    }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { seq: 8 } })
  })

  it('keeps members referenced by boundary bindings', () => {
    const g = graph({
      id: 'g0',
      nodes: { n1: node('n1', { dynamic: state }) },
      boundary: { inputs: [{ id: 'in', binds: { kind: 'port', ...port('n1', 'images.item'), members: [asDynamicMemberId('m1')] } }], outputs: [] },
    })
    const store = makeStore(doc({ g0: g }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1'], seq: 3 } })
  })

  it('compacts nested families bottom-up and keeps a referenced child and its parent', () => {
    const dynamic = {
      items: {
        members: ['m0', 'm1'], seq: 2,
        memberState: {
          m0: { 'items.sub': { members: ['m0'], seq: 1 } },
          m1: { 'items.sub': { members: ['m0'], seq: 1 } },
        },
      },
    }
    const g = graph({
      id: 'g0', nodes: { src: node('src'), n1: node('n1', { dynamic }) },
      links: { l1: { id: asLinkId('l1'), from: port('src', 'out'), to: { ...port('n1', 'items.sub.item'), members: [asDynamicMemberId('m1'), asDynamicMemberId('m0')] } } },
    })
    const store = makeStore(doc({ g0: g }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({
      items: { members: ['m1'], seq: 2, memberState: { m1: { 'items.sub': { members: ['m0'], seq: 1 } } } },
    })
  })

  it('is a no-op on nodes without dynamic state', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const revision = store.revision
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })
})

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

describe('batch', () => {
  const twoNodes = () =>
    doc({ g0: graph({ id: 'g0', nodes: { src: node('src'), dst: node('dst') } }) })

  it('materialize + link.connect commits as ONE transaction and ONE undo step', () => {
    const store = makeStore(twoNodes())
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'dynamic.materialize',
            params: { graphId: 'g0', nodeId: 'dst', frames: [{ construct: 'images', members: ['m0'] }] },
          },
          {
            command: 'link.connect',
            params: {
              graphId: 'g0',
              from: port('src', 'out0'),
              to: { node: 'dst', port: 'images.item', members: ['m0'] },
            },
          },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({ images: { members: ['m0'], seq: 1 } })
    const links = Object.values(store.doc.graphs['g0']!.links)
    expect(links).toHaveLength(1)
    expect(links[0]!.to).toEqual({ node: 'dst', port: 'images.item', members: ['m0'] })

    // One undo removes BOTH the member and the link. The seq high-water
    // mark stays behind (CO3): member ids are never reused across undo.
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({ images: { seq: 1 } })
    expect(Object.values(store.doc.graphs['g0']!.links)).toHaveLength(0)
    expect(store.canUndo).toBe(false)

    // Redo restores both.
    expect(store.redo()).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({ images: { members: ['m0'], seq: 1 } })
    expect(Object.values(store.doc.graphs['g0']!.links)).toHaveLength(1)
  })

  it('a failing sub-command aborts the whole batch: no orphaned materialization', () => {
    const store = makeStore(twoNodes())
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'dynamic.materialize',
            params: { graphId: 'g0', nodeId: 'dst', frames: [{ construct: 'images', members: ['m0'] }] },
          },
          {
            // Self-loop: link.connect rejects, so the materialization above
            // must not survive.
            command: 'link.connect',
            params: { graphId: 'g0', from: port('dst', 'out0'), to: port('dst', 'images.item') },
          },
        ],
      },
    })
    expect(out.ok).toBe(false)
    expect(dynOf(store, 'dst')).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('rejects unknown sub-commands and nested batches', () => {
    const store = makeStore(twoNodes())
    expect(
      store.dispatch({ command: 'batch', params: { invocations: [{ command: 'nope', params: {} }] } }).ok,
    ).toBe(false)
    expect(
      store.dispatch({
        command: 'batch',
        params: { invocations: [{ command: 'batch', params: { invocations: [] } }] },
      }).ok,
    ).toBe(false)
    expect(store.dispatch({ command: 'batch', params: { invocations: [] } }).ok).toBe(false)
  })

  it('later sub-commands see earlier writes (sequential working copy)', () => {
    const store = makeStore(twoNodes())
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'dynamic.materialize',
            params: { graphId: 'g0', nodeId: 'dst', frames: [{ construct: 'items', members: ['m0'] }] },
          },
          {
            // Requires the member persisted by the previous sub-command.
            command: 'dynamic.selectOption',
            params: {
              graphId: 'g0',
              nodeId: 'dst',
              ancestors: [{ construct: 'items', member: 'm0' }],
              construct: 'items.mode',
              option: 'x',
            },
          },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({
      items: { members: ['m0'], seq: 1, memberState: { m0: { 'items.mode': { selected: 'x' } } } },
    })
  })
})

// ---------------------------------------------------------------------------
// materializeFramesOf
// ---------------------------------------------------------------------------

describe('materializeFramesOf', () => {
  const ghostOf = (inputs: readonly ElaboratedInput[]): ElaboratedInput => {
    const g = inputs.find((i) => i.origin.kind === 'member' && i.origin.ghost === true)
    expect(g).toBeDefined()
    return g!
  }

  it('returns undefined for a fully persisted target', () => {
    const e = elaborateInterface(schemaOf([autogrowFamily('images')]), {
      values: {},
      dynamic: { images: { members: ['m0'], seq: 1 } },
    })
    const persisted = elabInputsOf(e).find((i) => i.ancestry?.every((a) => !a.synthetic))
    expect(persisted).toBeDefined()
    expect(materializeFramesOf(e.items, persisted!)).toBeUndefined()
  })

  it('ghost on a fresh min-0 family: one frame with just the ghost id', () => {
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 0 })]), { values: {} })
    const frames = materializeFramesOf(e.items, ghostOf(elabInputsOf(e)))
    expect(frames).toEqual([{ construct: 'images', members: ['m0'] }])
  })

  it('min-fill siblings persist WITH the ghost (ids would re-mint otherwise)', () => {
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 2 })]), { values: {} })
    const frames = materializeFramesOf(e.items, ghostOf(elabInputsOf(e)))
    expect(frames).toEqual([{ construct: 'images', members: ['m0', 'm1', 'm2'] }])
  })

  it('a min-fill member target persists only members up to itself', () => {
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 2 })]), { values: {} })
    const second = elabInputsOf(e).find(
      (i) => i.origin.kind === 'member' && i.origin.ordinal === 1 && !i.origin.ghost,
    )
    expect(second).toBeDefined()
    const frames = materializeFramesOf(e.items, second!)
    expect(frames).toEqual([{ construct: 'images', members: ['m0', 'm1'] }])
  })

  it('CO7: an exhausted family elaborates persisted members but offers no ghost or growth', () => {
    // seq beyond the 15-digit mintable window: offering m<seq> could later
    // collide with a persisted member the seq bump cannot see. The family
    // stops growing and elaboration says why.
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 0 })]), {
      values: {},
      dynamic: { images: { members: ['m0'], seq: Number.MAX_SAFE_INTEGER } },
    })
    const inputs = elabInputsOf(e)
    expect(inputs.some((i) => i.origin.kind === 'member' && !i.origin.ghost)).toBe(true)
    expect(inputs.some((i) => i.origin.kind === 'member' && i.origin.ghost === true)).toBe(false)
    expect(e.items.some((i) => i.kind === 'growth')).toBe(false)
    expect(e.diagnostics.some((d) => d.code === 'elab.autogrow.idsExhausted')).toBe(true)
  })

  it('ghost after a persisted prefix continues from seq', () => {
    const e = elaborateInterface(schemaOf([autogrowFamily('images', { min: 0 })]), {
      values: {},
      dynamic: { images: { members: ['m0'], seq: 1 } },
    })
    const frames = materializeFramesOf(e.items, ghostOf(elabInputsOf(e)))
    expect(frames).toEqual([{ construct: 'images', members: ['m1'] }])
  })

  it('nested ghost under a persisted outer member: persisted frame + synthetic frame', () => {
    const nested = autogrowFamily('items', {
      min: 0,
      template: [autogrowFamily('sub', { min: 0 })],
    })
    const e = elaborateInterface(schemaOf([nested]), {
      values: {},
      dynamic: { items: { members: ['m0'], seq: 1 } },
    })
    // Inner ghost lives under the persisted outer member m0 (ghost outer
    // members suppress inner ghosts entirely).
    const innerGhost = elabInputsOf(e).find(
      (i) =>
        i.origin.kind === 'member' &&
        i.origin.ghost === true &&
        i.ancestry?.length === 2 &&
        i.ancestry[0]!.member === 'm0',
    )
    expect(innerGhost).toBeDefined()
    const frames = materializeFramesOf(e.items, innerGhost!)
    expect(frames).toEqual([
      { construct: 'items', members: ['m0'] },
      { construct: 'items.sub', members: ['m0'] },
    ])
  })

  it('keeps nested wire-15 materialization in flattened document paths', () => {
    const schema = parseDinksterSchemaWire15('nested-wire15', {
      schemaVersion: 15,
      interface: [{
        role: 'inputFamily', id: 'outer', memberPrefix: 'row', minMembers: 1, maxMembers: 3,
        template: [{
          role: 'inputFamily', id: 'inner', memberPrefix: 'sub', minMembers: 1, maxMembers: 2,
          template: [{
            role: 'input', id: 'value',
            type: { kind: 'concrete', types: ['core.int'] }, required: false,
          }],
        }],
      }],
    }).schema!
    const elaborated = elaborateInterface(schema, { values: {}, dynamic: {} })
    const target = elabInputsOf(elaborated).find(
      (input) => input.address.port === 'outer.m0.inner.m0',
    )
    expect(target).toBeDefined()
    const frames = materializeFramesOf(elaborated.items, target!)
    expect(frames).toEqual([
      { construct: 'outer', members: ['m0'] },
      { construct: 'outer.m0.inner', members: ['m0'] },
    ])

    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const outcome = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0', nodeId: 'n1',
        frames: frames!.map((frame) => ({ construct: frame.construct, members: [...frame.members] })),
      },
    })
    expect(outcome.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      outer: {
        members: ['m0'],
        seq: 1,
        memberState: {
          m0: { 'outer.m0.inner': { members: ['m0'], seq: 1 } },
        },
      },
    })

    const dynamic = dynOf(store, 'n1')
    const reloaded = elaborateInterface(schema, {
      values: {},
      ...(dynamic !== undefined ? { dynamic } : {}),
    })
    expect(reloaded.diagnostics).toEqual([])
    expect(elabInputsOf(reloaded).map((input) => [input.address.port, input.apiName])).toContainEqual([
      'outer.m0.inner.m0',
      'outer.row0.inner.sub0',
    ])
  })
})
