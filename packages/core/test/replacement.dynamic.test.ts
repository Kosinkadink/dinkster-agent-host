import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
} from '../src/ids.js'
import type { ReplacementRule } from '../src/replace/model.js'
import { planReplacement } from '../src/replace/plan.js'
import { parseDinksterNodes, type DinksterWireSchema, type InputSpec, type NodeSchema } from '../src/index.js'

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/replacements/dynamic-target.json', import.meta.url),
  'utf8',
)) as { schemas: (DinksterWireSchema & { nodeType: string })[] }

const decoded = parseDinksterNodes({
  schemaVersion: 28,
  nodes: Object.fromEntries(fixture.schemas.map((schema) => [schema.nodeType, schema])),
})
expect(decoded.diagnostics).toEqual([])

const resolve = (type: string): NodeSchema | undefined => decoded.schemas.get(type)
const rule = resolve('fixture.dynamic-modern')!.replacements![0]!
const rawRule = (fixture.schemas.find(
  (schema) => schema.nodeType === 'fixture.dynamic-modern',
)!.replacements as readonly ReplacementRule[])[0]!
const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const replacementStore = (document: WorkflowDocument): DocumentStore => new DocumentStore(
  document,
  coreCommandRegistry(),
  200,
  undefined,
  () => ({ kind: 'initial', schemaResolverFor: () => resolve }),
)

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'dynamic replacement',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function sourceDocument(): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('dynamic-replacement'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: graph({
        id: 'g0',
        nodes: {
          old: {
            id: asNodeId('old'),
            type: 'fixture.dynamic-legacy',
            values: {
              color_value: 123,
              tolerance: 0.75,
              metric: 'delta-e',
              'samples.sample0.weight': 2.5,
              'samples.sample0.label': 'red',
            },
            controllers: {
              tolerance: 'increment',
              'samples.sample0.weight': 'decrement',
            },
            dynamic: { samples: { members: ['sample0'] } },
          },
          sink: { id: asNodeId('sink'), type: 'fixture.sink', values: {} },
        },
        links: {
          result: {
            id: asLinkId('result'),
            from: port('old', 'result'),
            to: port('sink', 'image'),
          },
        },
      }),
    },
    view: { graphs: {} },
  }
}

function withChoices(slotVariants: Readonly<Record<string, string>>): ReplacementRule {
  const replacementCase = rule.cases[0]!
  return {
    ...rule,
    cases: [{ ...replacementCase, slotVariants }],
  }
}

describe('wire-28 dynamic replacement targets', () => {
  it('decodes the focused fixture and preserves its authored choices', () => {
    expect(rule).toEqual(rawRule)
    expect(rule.cases[0]!.slotVariants).toEqual({
      policy: 'tolerance_color',
      'policy.color_source': 'integer',
      'audit:mode': 'details',
    })
  })

  it('plans active primary and helper branches with defaults, mappings, families, and links', () => {
    const planned = planReplacement(sourceDocument(), 'g0', 'old', rule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan).toMatchObject({
      dynamic: {
        policy: { selected: 'tolerance_color' },
        'policy.color_source': { selected: 'integer' },
        samples: { members: ['sample0'] },
      },
      values: {
        'policy.color_source.color_value': 123,
        'policy.tolerance': 0.75,
        'policy.metric': 'delta-e',
        'policy.alpha': 0.5,
        'samples.sample0.weight': 2.5,
        'samples.sample0.label': 'red',
      },
      controllers: {
        'policy.tolerance': 'increment',
        'samples.sample0.weight': 'decrement',
      },
      createdNodes: [{
        nodeId: 'old:audit',
        localId: 'audit',
        type: 'fixture.dynamic-helper',
        dynamic: { mode: { selected: 'details' } },
        values: { 'mode.label': 'migration', 'mode.enabled': true },
      }],
      links: [{
        from: port('old', 'result'),
        to: port('old:audit', 'mode.source'),
      }],
    })
  })

  it('applies and restores dynamic state atomically through undo and redo', () => {
    const before = sourceDocument()
    const plan = planReplacement(before, 'g0', 'old', rule, resolve).plan!
    const store = replacementStore(before)
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json }).ok).toBe(true)

    const applied = store.doc.graphs.g0!
    expect(applied.nodes.old).toMatchObject({
      type: 'fixture.dynamic-modern',
      dynamic: {
        policy: { selected: 'tolerance_color' },
        'policy.color_source': { selected: 'integer' },
        samples: { members: ['sample0'] },
      },
      values: {
        'policy.color_source.color_value': 123,
        'policy.tolerance': 0.75,
        'policy.metric': 'delta-e',
        'policy.alpha': 0.5,
        'samples.sample0.weight': 2.5,
        'samples.sample0.label': 'red',
      },
      controllers: {
        'policy.tolerance': 'increment',
        'samples.sample0.weight': 'decrement',
      },
    })
    expect(applied.nodes['old:audit']).toMatchObject({
      type: 'fixture.dynamic-helper',
      dynamic: { mode: { selected: 'details' } },
      values: { 'mode.label': 'migration', 'mode.enabled': true },
    })
    expect(applied.links.result!.from).toEqual(port('old', 'result'))
    expect(applied.links.l100).toMatchObject({
      from: port('old', 'result'),
      to: port('old:audit', 'mode.source'),
    })

    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old).toEqual(before.graphs.g0!.nodes.old)
    expect(store.doc.graphs.g0!.nodes['old:audit']).toBeUndefined()
    expect(store.doc.graphs.g0!.links).toEqual(before.graphs.g0!.links)

    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.dynamic).toEqual(plan.dynamic)
    expect(store.doc.graphs.g0!.nodes['old:audit']!.dynamic).toEqual(plan.createdNodes![0]!.dynamic)
    expect(store.doc.graphs.g0!.links.l100).toMatchObject({
      from: port('old', 'result'),
      to: port('old:audit', 'mode.source'),
    })
  })

  it.each([
    ['unknown option', {
      policy: 'unknown',
      'policy.color_source': 'integer',
      'audit:mode': 'details',
    }],
    ['unknown path', {
      policy: 'tolerance_color',
      'policy.missing': 'integer',
      'audit:mode': 'details',
    }],
    ['inactive nested path', {
      policy: 'exact',
      'policy.color_source': 'integer',
      'audit:mode': 'details',
    }],
  ] as const)('fails closed for an %s', (_label, slotVariants) => {
    const planned = planReplacement(sourceDocument(), 'g0', 'old', withChoices(slotVariants), resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: expect.stringMatching(/^replace\.target\.dynamic/),
    }))
  })

  it('rejects an unselected required primary combo when only a helper has a choice', () => {
    const modern = resolve('fixture.dynamic-modern')!
    const requiredModern: NodeSchema = {
      ...modern,
      items: modern.items.map((item) =>
        item.kind === 'input' && item.id === 'policy'
          ? { ...item, optional: false }
          : item),
    }
    const requiredResolve = (type: string): NodeSchema | undefined =>
      type === requiredModern.type ? requiredModern : resolve(type)
    const helperOnly: ReplacementRule = {
      from: 'fixture.dynamic-legacy',
      cases: [{
        to: requiredModern.type,
        nodes: { audit: { type: 'fixture.dynamic-helper' } },
        slotVariants: { 'audit:mode': 'details' },
      }],
    }

    const planned = planReplacement(sourceDocument(), 'g0', 'old', helperOnly, requiredResolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.target.dynamicInvalid',
      message: expect.stringContaining('no stored choice'),
    }))
  })

  it('allows an optional combo to use its schema default without persisting a choice', () => {
    const modern = resolve('fixture.dynamic-modern')!
    const optionalRule: ReplacementRule = {
      from: 'fixture.dynamic-legacy',
      cases: [{ to: modern.type }],
    }

    const planned = planReplacement(sourceDocument(), 'g0', 'old', optionalRule, resolve)
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(planned.plan?.dynamic).toBeUndefined()
  })

  it('rejects an unselected required variant slot', () => {
    const legacy = resolve('fixture.dynamic-legacy')!
    const template = legacy.items.find((item) => item.kind === 'input' && item.id === 'color_value') as InputSpec
    const target: NodeSchema = {
      ...resolve('fixture.dynamic-modern')!,
      type: 'fixture.required-slot-target',
      items: [{
        ...template,
        id: 'mask',
        optional: false,
        forceInput: true,
        dynamic: {
          kind: 'dynamicSlot',
          materialization: 'wire15',
          slotType: template.type,
          variants: [{ key: 'integer', type: template.type, inputs: [] }],
          inputs: [],
        },
      }],
      replacements: [],
    }
    const requiredResolve = (type: string): NodeSchema | undefined =>
      type === target.type ? target : resolve(type)
    const requiredRule: ReplacementRule = {
      from: legacy.type,
      cases: [{ to: target.type }],
    }

    const planned = planReplacement(sourceDocument(), 'g0', 'old', requiredRule, requiredResolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.target.dynamicInvalid',
      message: expect.stringContaining('required dynamic slot'),
    }))
  })

  it('rejects an invalid persisted wire-15 combo choice before case selection', () => {
    const modern = resolve('fixture.dynamic-modern')!
    const before = sourceDocument()
    const invalid: WorkflowDocument = {
      ...before,
      graphs: {
        ...before.graphs,
        g0: {
          ...before.graphs.g0!,
          nodes: {
            ...before.graphs.g0!.nodes,
            old: {
              ...before.graphs.g0!.nodes.old!,
              type: modern.type,
              values: {},
              controllers: {},
              dynamic: { policy: { selected: 'unknown' } },
            },
          },
        },
      },
    }
    const invalidRule: ReplacementRule = {
      from: modern.type,
      cases: [{ to: 'fixture.dynamic-legacy' }],
    }

    const planned = planReplacement(invalid, 'g0', 'old', invalidRule, resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.source.invalid',
      message: expect.stringContaining("stored dynamic choice 'unknown' is not declared"),
    }))
  })

  it('rejects an invalid persisted variant on a disconnected current slot', () => {
    const legacy = resolve('fixture.dynamic-legacy')!
    const template = legacy.items.find((item) => item.kind === 'input' && item.id === 'color_value') as InputSpec
    const source: NodeSchema = {
      ...legacy,
      type: 'fixture.current-slot-source',
      items: [{
        ...template,
        id: 'mask',
        dynamic: {
          kind: 'dynamicSlot',
          slotType: template.type,
          variants: [{ key: 'integer', type: template.type, inputs: [] }],
          inputs: [],
        },
      }],
      replacements: [],
    }
    const slotResolve = (type: string): NodeSchema | undefined =>
      type === source.type ? source : resolve(type)
    const before = sourceDocument()
    const invalid: WorkflowDocument = {
      ...before,
      graphs: {
        ...before.graphs,
        g0: {
          ...before.graphs.g0!,
          nodes: {
            ...before.graphs.g0!.nodes,
            old: {
              id: asNodeId('old'),
              type: source.type,
              values: {},
              dynamic: { mask: { selected: 'unknown' } },
            },
          },
          links: {},
        },
      },
    }
    const invalidRule: ReplacementRule = {
      from: source.type,
      cases: [{ to: legacy.type }],
    }

    const planned = planReplacement(invalid, 'g0', 'old', invalidRule, slotResolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.source.invalid',
      message: expect.stringContaining("stored dynamic choice 'unknown' is not declared"),
    }))
  })

  it('does not copy a controller onto an ordinary widget without a controller slot', () => {
    const legacy = resolve('fixture.dynamic-legacy')!
    const before = sourceDocument()
    const controlled: WorkflowDocument = {
      ...before,
      graphs: {
        ...before.graphs,
        g0: {
          ...before.graphs.g0!,
          nodes: {
            ...before.graphs.g0!.nodes,
            old: {
              ...before.graphs.g0!.nodes.old!,
              controllers: { color_value: 'increment' },
            },
          },
        },
      },
    }
    const plainRule: ReplacementRule = {
      from: legacy.type,
      cases: [{
        to: legacy.type,
        inputs: { color_value: { kind: 'value', input: 'color_value' } },
      }],
    }

    const planned = planReplacement(controlled, 'g0', 'old', plainRule, resolve)
    expect(planned.plan?.controllers).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'replace.controller.dropped',
      message: expect.stringContaining("controller on 'color_value'"),
    }))
  })

  it('does not copy a family controller onto a template widget without a controller slot', () => {
    const modern = resolve('fixture.dynamic-modern')!
    const plainFamily: NodeSchema = {
      ...modern,
      type: 'fixture.plain-family-target',
      items: modern.items.map((item) => {
        if (item.kind !== 'input' || item.dynamic?.kind !== 'autogrow' || item.id !== 'samples') return item
        return {
          ...item,
          dynamic: {
            ...item.dynamic,
            template: item.dynamic.template.map((slot) => {
              if (slot.id !== 'weight' || slot.widget === undefined) return slot
              const { controller: _controller, controllerInitial: _controllerInitial, ...widget } = slot.widget
              return { ...slot, widget }
            }),
          },
        }
      }),
    }
    const plainResolve = (type: string): NodeSchema | undefined =>
      type === plainFamily.type ? plainFamily : resolve(type)
    const replacementCase = rule.cases[0]!
    const plainRule: ReplacementRule = {
      ...rule,
      cases: [{ ...replacementCase, to: plainFamily.type }],
    }

    const planned = planReplacement(sourceDocument(), 'g0', 'old', plainRule, plainResolve)
    expect(planned.plan?.controllers).toEqual({ 'policy.tolerance': 'increment' })
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'replace.controller.dropped',
      message: expect.stringContaining("controller on 'samples.sample0.weight'"),
    }))
  })

  it('materializes a connection-driven slot before validating its dependent mappings', () => {
    const legacy = resolve('fixture.dynamic-legacy')!
    const template = legacy.items.find((item) => item.kind === 'input' && item.id === 'color_value') as InputSpec
    const modern = resolve('fixture.dynamic-modern')!
    const target: NodeSchema = {
      ...modern,
      type: 'fixture.open-slot-target',
      items: [{
        id: 'mask',
        kind: 'input',
        type: template.type,
        optional: true,
        forceInput: true,
        dynamic: {
          kind: 'dynamicSlot',
          materialization: 'wire15',
          slotType: template.type,
          inputs: [{ ...template, id: 'invert' }],
        },
      }],
      replacements: [],
    }
    const openResolve = (type: string): NodeSchema | undefined =>
      type === target.type ? target : resolve(type)
    const openRule: ReplacementRule = {
      from: legacy.type,
      cases: [{
        to: target.type,
        inputs: {
          mask: { kind: 'copy', input: 'color_value' },
          'mask.invert': { kind: 'constant', value: 1 },
        },
      }],
    }
    const base = sourceDocument()
    const before: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        g0: {
          ...base.graphs.g0!,
          nodes: {
            ...base.graphs.g0!.nodes,
            producer: { id: asNodeId('producer'), type: 'fixture.producer', values: {} },
          },
          links: {
            ...base.graphs.g0!.links,
            mask: {
              id: asLinkId('mask'),
              from: port('producer', 'value'),
              to: port('old', 'color_value'),
            },
          },
        },
      },
    }

    const connected = planReplacement(before, 'g0', 'old', openRule, openResolve)
    expect(connected.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(connected.plan).toMatchObject({ values: { 'mask.invert': 1 } })

    const disconnected = planReplacement(base, 'g0', 'old', openRule, openResolve)
    expect(disconnected.plan).toBeUndefined()
    expect(disconnected.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.target.inputMissing',
      message: expect.stringContaining('mask.invert'),
    }))
  })

  it('keeps materialized family members owned by inputFamilies mappings', () => {
    const replacementCase = rule.cases[0]!
    const invalid: ReplacementRule = {
      ...rule,
      cases: [{
        ...replacementCase,
        inputs: {
          ...replacementCase.inputs,
          'samples.sample0.weight': { kind: 'constant', value: 9 },
        },
      }],
    }
    const planned = planReplacement(sourceDocument(), 'g0', 'old', invalid, resolve)
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'replace.target.inputMissing',
    }))
  })

  it('rewires mapped widget taps and view representations to an active dynamic input', () => {
    const base = sourceDocument()
    const before: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        g0: {
          ...base.graphs.g0!,
          links: {
            ...base.graphs.g0!.links,
            tap: {
              id: asLinkId('tap'),
              from: { node: asNodeId('old'), tap: asPortId('color_value') },
              to: port('sink', 'mask'),
            },
          },
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              old: { views: { color_value: 'compact' } },
            },
          },
        },
      },
    }
    const plan = planReplacement(before, 'g0', 'old', rule, resolve).plan!
    expect(plan.tapRewires).toEqual([{ link: 'tap', tap: 'policy.color_source.color_value' }])
    expect(plan.viewRewires).toEqual([{
      from: 'color_value',
      to: 'policy.color_source.color_value',
    }])
    expect(plan.dropLinks).not.toContain('tap')

    const store = replacementStore(before)
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json }).ok).toBe(true)
    expect(store.doc.graphs.g0!.links.tap!.from).toEqual({
      node: asNodeId('old'),
      tap: asPortId('policy.color_source.color_value'),
    })
    expect(store.doc.view.graphs.g0!.nodes.old!.views).toEqual({
      'policy.color_source.color_value': 'compact',
    })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old).toEqual(before.graphs.g0!.nodes.old)
    expect(store.doc.graphs.g0!.nodes['old:audit']).toBeUndefined()
    expect(store.doc.graphs.g0!.links).toEqual(before.graphs.g0!.links)
    expect(store.doc.view).toEqual(before.view)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.links.tap!.from).toEqual({
      node: asNodeId('old'),
      tap: asPortId('policy.color_source.color_value'),
    })
  })

  it('accepts a promoted boundary widget mapped to an active dynamic input', () => {
    const base = sourceDocument()
    const before: WorkflowDocument = {
      ...base,
      root: asGraphDefId('g0'),
      graphs: {
        g0: graph({
          id: 'g0',
          nodes: {
            instance: { id: asNodeId('instance'), type: '#g1', values: {} },
          },
        }),
        g1: {
          ...base.graphs.g0!,
          id: asGraphDefId('g1'),
          boundary: {
            inputs: [{
              id: 'color',
              promoted: true,
              binds: { kind: 'port', ...port('old', 'color_value') },
            }],
            outputs: [],
          },
        },
      },
    }
    const replacementCase = rule.cases[0]!
    const copyRule: ReplacementRule = {
      ...rule,
      cases: [{
        ...replacementCase,
        inputs: {
          ...replacementCase.inputs,
          'policy.color_source.color_value': { kind: 'copy', input: 'color_value' },
        },
      }],
    }

    const planned = planReplacement(before, 'g1', 'old', copyRule, resolve)
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(planned.plan?.boundaryRewires).toContainEqual({
      item: 'color',
      side: 'input',
      fromPort: 'color_value',
      port: 'policy.color_source.color_value',
    })
  })

  it.each(['primary', 'helper'] as const)('rejects malformed nested %s dynamic state without mutating', (target) => {
    const before = sourceDocument()
    const plan = planReplacement(before, 'g0', 'old', rule, resolve).plan!
    const badState = { selected: 'choice', memberState: { member: { slot: [] } } }
    const malformed = target === 'primary'
      ? { ...plan, dynamic: { policy: badState } }
      : {
          ...plan,
          createdNodes: [{ ...plan.createdNodes![0]!, dynamic: { mode: badState } }],
        }
    const store = replacementStore(before)
    const applied = store.dispatch({ command: 'node.replace', params: { plan: malformed } as unknown as Json })
    expect(applied.ok).toBe(false)
    expect(applied.diagnostics).toContainEqual(expect.objectContaining({ code: 'params.invalid' }))
    expect(store.doc).toEqual(before)
  })
})
