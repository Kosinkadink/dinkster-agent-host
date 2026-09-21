import { describe, expect, it } from 'vitest'
import { coreCommandRegistry, planOutputCountSchema } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { WorkflowDocument } from '../src/format/document.js'
import type { InputSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

const countInput: InputSpec = {
  kind: 'input',
  id: 'count',
  type: { kind: 'concrete', name: 'core.int' },
  optional: false,
  widget: { widgetType: 'INT', options: {}, default: 3 },
}

const outputFamily = (id: string, min = 0, max = 4): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: 'comfy.IMAGE' },
  dynamic: {
    kind: 'autogrow',
    template: [{
      kind: 'input',
      id: 'item',
      type: { kind: 'concrete', name: 'comfy.IMAGE' },
      optional: false,
    }],
    materialization: 'wire15',
    naming: { kind: 'prefix', prefix: '', min, max },
    count: { input: 'count', suffix: 'index' },
  },
})

const splitSchema: NodeSchema = {
  type: 'Split',
  displayName: 'Split',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [countInput, outputFamily('images', 1, 4), outputFamily('masks', 0, 3)],
}

const sinkSchema: NodeSchema = {
  type: 'Sink',
  displayName: 'Sink',
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items: [{
    kind: 'input',
    id: 'image',
    type: { kind: 'concrete', name: 'comfy.IMAGE' },
    optional: false,
  }],
}

const resolve = (type: string): NodeSchema | undefined =>
  type === 'Split' ? splitSchema : type === 'Sink' ? sinkSchema : undefined

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage' as never,
  root: 'g0' as never,
  graphs: {
    g0: {
      id: 'g0' as never,
      name: 'root',
      nextOrdinal: 1,
      nodes: {
        split: { id: 'split' as never, type: 'Split', values: { count: 3 } },
        sink: { id: 'sink' as never, type: 'Sink', values: {} },
      },
      links: {
        linkedMember: {
          id: 'linkedMember' as never,
          from: { node: 'split' as never, port: 'images' as never, members: ['2' as never] },
          to: { node: 'sink' as never, port: 'image' as never },
        },
      },
      nets: {
        memberNet: {
          id: 'memberNet' as never,
          name: 'member-net',
          source: { node: 'split' as never, port: 'masks' as never, members: ['2' as never] },
          sinks: [],
        },
      },
      reroutes: {},
    },
  },
  view: { graphs: {} },
})

const invocation = (value: number, extra: Record<string, unknown> = {}) => ({
  command: 'node.setOutputCount',
  params: {
    graphId: 'g0',
    nodeId: 'split',
    inputId: 'count',
    value,
    removedLinks: 'preserve',
    ...extra,
  },
})

describe('node.setOutputCount', () => {
  it('edits a shared family count as one undoable transaction and preserves departing-member wiring', () => {
    const store = new DocumentStore(document(), coreCommandRegistry([], resolve))
    expect(store.dispatch(invocation(1) as never).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.split!.values.count).toBe(1)
    expect(store.doc.graphs.g0!.links.linkedMember).toBeDefined()
    expect(store.doc.graphs.g0!.nets.memberNet).toBeDefined()
    expect(store.revision).toBe(1)

    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.split!.values.count).toBe(3)
    expect(store.doc.graphs.g0!.links.linkedMember).toBeDefined()
    expect(store.doc.graphs.g0!.nets.memberNet).toBeDefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.split!.values.count).toBe(1)
  })

  it('requires the explicit non-destructive link policy', () => {
    const store = new DocumentStore(document(), coreCommandRegistry([], resolve))
    expect(store.dispatch(invocation(2, { removedLinks: 'disconnect' }) as never).ok).toBe(false)
    expect(store.dispatch({
      command: 'node.setOutputCount',
      params: { graphId: 'g0', nodeId: 'split', inputId: 'count', value: 2 },
    }).ok).toBe(false)
    expect(store.doc.graphs.g0!.nodes.split!.values.count).toBe(3)
  })

  it('enforces every family bound sharing the count input', () => {
    const store = new DocumentStore(document(), coreCommandRegistry([], resolve))
    for (const value of [0, 4]) {
      const outcome = store.dispatch(invocation(value) as never)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.diagnostics[0]!.code).toBe('outputCount.outOfRange')
    }
    expect(store.dispatch(invocation(2) as never).ok).toBe(true)
  })

  it('enforces the schema-wide member budget across families sharing the count', () => {
    const wideSchema: NodeSchema = {
      ...splitSchema,
      items: [countInput, outputFamily('images', 0, 512), outputFamily('masks', 0, 512)],
    }
    const wideResolve = (type: string): NodeSchema | undefined =>
      type === 'Split' ? wideSchema : type === 'Sink' ? sinkSchema : undefined
    const store = new DocumentStore(document(), coreCommandRegistry([], wideResolve))
    const overBudget = store.dispatch(invocation(257) as never)
    expect(overBudget.ok).toBe(false)
    if (!overBudget.ok) expect(overBudget.diagnostics[0]!.code).toBe('outputCount.memberBudget')
    expect(store.doc.graphs.g0!.nodes.split!.values.count).toBe(3)
    expect(store.dispatch(invocation(256) as never).ok).toBe(true)
  })

  it('rejects when the item budget halts elaboration before the member budget', () => {
    const denseInput: InputSpec = {
      kind: 'input',
      id: 'dense',
      type: { kind: 'concrete', name: 'core.int' },
      optional: false,
      dynamic: {
        kind: 'autogrow',
        template: Array.from({ length: 4 }, (_, index): InputSpec => ({
          kind: 'input',
          id: `item${index}`,
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
        })),
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 512 },
      },
    }
    const denseSchema: NodeSchema = {
      ...splitSchema,
      items: [countInput, denseInput, outputFamily('images', 0, 512)],
    }
    const denseDocument = document()
    ;(denseDocument.graphs.g0!.nodes.split! as {
      dynamic?: WorkflowDocument['graphs'][string]['nodes'][string]['dynamic']
    }).dynamic = {
      dense: {
        members: Array.from({ length: 256 }, (_, index) => `m${index}` as never),
      },
    }
    const denseResolve = (type: string): NodeSchema | undefined =>
      type === 'Split' ? denseSchema : type === 'Sink' ? sinkSchema : undefined
    const store = new DocumentStore(denseDocument, coreCommandRegistry([], denseResolve))
    const outcome = store.dispatch(invocation(257) as never)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics[0]!.code).toBe('outputCount.elaborationBudget')
    expect(store.doc.graphs.g0!.nodes.split!.values.count).toBe(3)
  })

  it('rejects linked count inputs, ordinary inputs, missing schemas, and hostile values', () => {
    const linked = document()
    ;(linked.graphs.g0!.links as Record<string, WorkflowDocument['graphs'][string]['links'][string]>).countDriver = {
      id: 'countDriver' as never,
      from: { node: 'sink' as never, port: 'image' as never },
      to: { node: 'split' as never, port: 'count' as never },
    }
    const linkedStore = new DocumentStore(linked, coreCommandRegistry([], resolve))
    const linkedResult = linkedStore.dispatch(invocation(2) as never)
    expect(linkedResult.ok).toBe(false)
    if (!linkedResult.ok) expect(linkedResult.diagnostics[0]!.code).toBe('outputCount.linked')

    const ordinary = new DocumentStore(document(), coreCommandRegistry([], resolve))
    const ordinaryResult = ordinary.dispatch({
      command: 'node.setOutputCount',
      params: { graphId: 'g0', nodeId: 'split', inputId: 'ordinary', value: 2, removedLinks: 'preserve' },
    })
    expect(ordinaryResult.ok).toBe(false)
    if (!ordinaryResult.ok) expect(ordinaryResult.diagnostics[0]!.code).toBe('outputCount.inputMissing')

    expect(new DocumentStore(document(), coreCommandRegistry()).dispatch(invocation(2) as never).ok).toBe(false)
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ordinary.dispatch(invocation(value) as never).ok).toBe(false)
    }
  })

  it('uses an integrity-checked schema snapshot during shared replay without live schema authority', () => {
    const schemaPlan = planOutputCountSchema('Split', splitSchema)
    const replay = new DocumentStore(
      document(),
      coreCommandRegistry([], () => {
        throw new Error('mutable registry resolver must not run during shared replay')
      }),
      200,
      undefined,
      () => ({ kind: 'shared-replay' }),
    )
    expect(replay.dispatch(invocation(2, { schemaPlan }) as never).ok).toBe(true)
    expect(replay.doc.graphs.g0!.nodes.split!.values.count).toBe(2)

    const malformed = new DocumentStore(
      document(),
      coreCommandRegistry(),
      200,
      undefined,
      () => ({ kind: 'shared-replay' }),
    ).dispatch(invocation(2, {
      schemaPlan: { ...schemaPlan, schemaPlanDigest: 'tampered' },
    }) as never)
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.diagnostics[0]!.code).toBe('params.invalid')

    const staleAuthoredType = new DocumentStore(
      document(),
      coreCommandRegistry(),
      200,
      undefined,
      () => ({ kind: 'shared-replay' }),
    ).dispatch(invocation(2, {
      schemaPlan: planOutputCountSchema('LegacySplit', splitSchema),
    }) as never)
    expect(staleAuthoredType.ok).toBe(false)
    if (!staleAuthoredType.ok) {
      expect(staleAuthoredType.diagnostics[0]!.code).toBe('outputCount.schemaPlanStale')
    }

    const broaderSchema: NodeSchema = {
      ...splitSchema,
      items: [countInput, outputFamily('images', 0, 8), outputFamily('masks', 0, 8)],
    }
    const stale = new DocumentStore(document(), coreCommandRegistry([], resolve)).dispatch(
      invocation(4, { schemaPlan: planOutputCountSchema('Split', broaderSchema) }) as never,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.diagnostics[0]!.code).toBe('outputCount.schemaPlanStale')
  })

  it('rejects generic value commands that bypass output-count validation', () => {
    const direct = new DocumentStore(document(), coreCommandRegistry([], resolve))
    for (const command of [
      {
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'split', inputId: 'count', value: 0 },
      },
      {
        command: 'node.setValues',
        params: { graphId: 'g0', nodeId: 'split', values: { count: 0, ordinary: 1 } },
      },
    ]) {
      const result = direct.dispatch(command)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.diagnostics[0]!.code).toBe('outputCount.commandRequired')
      expect(direct.doc.graphs.g0!.nodes.split!.values).toEqual({ count: 3 })
    }

    const batched = direct.dispatch({
      command: 'batch',
      params: { invocations: [
        {
          command: 'node.setValue',
          params: { graphId: 'g0', nodeId: 'split', inputId: 'ordinary', value: 1 },
        },
        {
          command: 'node.setValue',
          params: { graphId: 'g0', nodeId: 'split', inputId: 'count', value: 0 },
        },
      ] },
    })
    expect(batched.ok).toBe(false)
    expect(direct.doc.graphs.g0!.nodes.split!.values).toEqual({ count: 3 })
    expect(direct.revision).toBe(0)
  })
})
